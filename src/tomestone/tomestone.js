function parseDurationMs(value, fallbackMs) {
  if (!value) {
    return fallbackMs;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 0 ? value : fallbackMs;
  }

  const trimmed = String(value).trim();
  if (!trimmed) {
    return fallbackMs;
  }

  const regex = /(\d+)([smhd])/g;
  let match;
  let totalMs = 0;
  while ((match = regex.exec(trimmed)) !== null) {
    const amount = parseInt(match[1], 10);
    const unit = match[2];
    switch (unit) {
      case 's':
        totalMs += amount * 1000;
        break;
      case 'm':
        totalMs += amount * 60 * 1000;
        break;
      case 'h':
        totalMs += amount * 60 * 60 * 1000;
        break;
      case 'd':
        totalMs += amount * 24 * 60 * 60 * 1000;
        break;
      default:
        break;
    }
  }

  return totalMs > 0 ? totalMs : fallbackMs;
}

class TomestoneClient {
  constructor(config = {}) {
    const rawToken = String(config.apiToken || '').trim();
    const token = rawToken || TomestoneClient.decodeBase64(config.apiTokenBase64);

    this.baseURL = String(config.baseURL || 'https://tomestone.gg').trim();
    this.token = token;
    this.enabled = !!token;

    this.timeoutMs = parseDurationMs(config.timeoutMs, 30000);
    this.refreshIntervalMs = parseDurationMs(config.refreshInterval || config.refreshIntervalMs, 30 * 60 * 1000);
    this.refreshAheadMs = parseDurationMs(config.refreshAhead || config.refreshAheadMs, 15 * 60 * 1000);
    const batchSize = Number.parseInt(config.refreshBatchSize, 10);
    this.refreshBatchSize = Number.isFinite(batchSize) && batchSize > 0 ? batchSize : 25;
    this.refreshTimer = null;
    this.refreshInProgress = false;

    // Rate limiting: default 36000 requests per hour
    const rateLimit = Number.parseInt(config.rateLimit, 10);
    this.rateLimit = Number.isFinite(rateLimit) && rateLimit > 0 ? rateLimit : 36000;

    const rateLimitWindowMs = Number.parseInt(config.rateLimitWindowMs, 10);
    this.rateLimitWindowMs = Number.isFinite(rateLimitWindowMs) && rateLimitWindowMs > 0 ? rateLimitWindowMs : 3600000; // 1 hour

    this.requestTimestamps = [];
    this.store = null;

    this.profileCacheTTLms = parseDurationMs(config.profileCacheTTL || config.cacheTTL, 6 * 60 * 60 * 1000);
    this.activityCacheTTLms = parseDurationMs(config.activityCacheTTL || config.cacheTTL, 30 * 60 * 1000);
    const maxPages = Number.parseInt(config.maxActivityPages, 10);
    this.maxActivityPages = Number.isFinite(maxPages) && maxPages > 0 ? maxPages : 10;

    this.requestSpacingMs = parseDurationMs(config.requestSpacingMs, 500);
    this.requestJitterMs = parseDurationMs(config.requestJitterMs, 250);
    const maxConcurrent = Number.parseInt(config.maxConcurrentRequests, 10);
    this.maxConcurrentRequests = Number.isFinite(maxConcurrent) && maxConcurrent > 0 ? maxConcurrent : 1;
    this.requestQueue = [];
    this.activeRequests = 0;
    this.lastRequestAt = 0;
    this.debug = !!config.debug;
    this.cooldownUntil = 0;
    this.cooldownReason = '';
    this.cooldown429Ms = parseDurationMs(config.cooldown429Ms || config.cooldownMs, 5 * 60 * 1000);
    this.cooldown403Ms = parseDurationMs(config.cooldown403Ms || config.cooldownMs, 10 * 60 * 1000);
  }

  static decodeBase64(value) {
    if (!value) {
      return '';
    }
    try {
      return Buffer.from(String(value), 'base64').toString('utf8').trim();
    } catch (_err) {
      return '';
    }
  }

  isEnabled() {
    return this.enabled;
  }

  setStore(store) {
    this.store = store;
  }

  getPreferredAvatar(profile) {
    if (!profile) {
      return '';
    }
    const customAvatar = profile?.customImages?.avatar?.image || '';
    const avatar = customAvatar || profile?.avatar || '';
    return String(avatar || '').trim();
  }

  getAvatarFromActivity(payload) {
    if (!payload) {
      return '';
    }
    return this.getPreferredAvatar(payload);
  }

  normalizeImageUrl(value) {
    if (!value) {
      return '';
    }
    return String(value).trim();
  }

  buildCustomImages(payload) {
    const avatar = this.normalizeImageUrl(payload?.customImages?.avatar?.image);
    const banner = this.normalizeImageUrl(payload?.customImages?.banner?.image);
    const portrait = this.normalizeImageUrl(payload?.customImages?.portrait?.image);
    const customImages = {};
    if (avatar) {
      customImages.avatar = { image: avatar };
    }
    if (banner) {
      customImages.banner = { image: banner };
    }
    if (portrait) {
      customImages.portrait = { image: portrait };
    }
    return Object.keys(customImages).length > 0 ? customImages : null;
  }

  summarizeEncounter(encounter) {
    if (!encounter) {
      return null;
    }
    const summary = {};
    const name = String(encounter?.name || '').trim();
    const zoneName = String(encounter?.zoneName || '').trim();
    const compactName = String(encounter?.compactName || '').trim();
    const link = String(encounter?.activity?.link || '').trim();
    const completedAt = String(encounter?.achievement?.completedAt || '').trim();
    if (name) {
      summary.name = name;
    }
    if (zoneName) {
      summary.zoneName = zoneName;
    }
    if (compactName) {
      summary.compactName = compactName;
    }
    if (link) {
      summary.activity = { link };
    }
    if (completedAt) {
      summary.achievement = { completedAt };
    }
    return Object.keys(summary).length > 0 ? summary : null;
  }

  summarizeEncounters(list) {
    if (!Array.isArray(list)) {
      return null;
    }
    return list
      .map((encounter) => this.summarizeEncounter(encounter))
      .filter(Boolean);
  }

  summarizeProgressionTarget(target) {
    if (!target) {
      return null;
    }
    const summary = {};
    const name = String(target?.name || '').trim();
    const link = String(target?.link || '').trim();
    const percent = String(target?.percent || '').trim();
    if (name) {
      summary.name = name;
    }
    if (link) {
      summary.link = link;
    }
    if (percent) {
      summary.percent = percent;
    }
    return Object.keys(summary).length > 0 ? summary : null;
  }

  buildProfileSummary(payload, fallbackName, fallbackWorld) {
    if (!payload) {
      return null;
    }
    const name = String(payload?.name || fallbackName || '').trim();
    const server = String(payload?.server || fallbackWorld || '').trim();
    const customImages = this.buildCustomImages(payload);
    const summary = {
      id: Number(payload?.id || 0) || 0,
      name,
      server,
      avatar: this.normalizeImageUrl(payload?.avatar),
      banner: this.normalizeImageUrl(payload?.banner),
      portrait: this.normalizeImageUrl(payload?.portrait),
    };
    if (customImages) {
      summary.customImages = customImages;
    }
    // Include encounters if present in the payload (from profile API)
    if (payload?.encounters) {
      summary.encounters = {
        savage: this.summarizeEncounters(payload?.encounters?.savage),
        ultimate: this.summarizeEncounters(payload?.encounters?.ultimate),
        savageProgressionTarget: this.summarizeProgressionTarget(payload?.encounters?.savageProgressionTarget),
        ultimateProgressionTarget: this.summarizeProgressionTarget(payload?.encounters?.ultimateProgressionTarget),
        extremes: null,
        criterion: null,
        chaotic: null,
        quantum: null,
        extremesProgressionTarget: null,
        chaoticProgressionTarget: null,
        quantumProgressionTarget: null,
      };
    }
    return summary;
  }

  buildActivitySummary(payload, fallbackName, fallbackWorld) {
    if (!payload) {
      return null;
    }
    const summary = this.buildProfileSummary(payload, fallbackName, fallbackWorld);
    if (!summary) {
      return null;
    }
    summary.encounters = {
      savage: this.summarizeEncounters(payload?.encounters?.savage),
      ultimate: this.summarizeEncounters(payload?.encounters?.ultimate),
      savageProgressionTarget: this.summarizeProgressionTarget(payload?.encounters?.savageProgressionTarget),
      ultimateProgressionTarget: this.summarizeProgressionTarget(payload?.encounters?.ultimateProgressionTarget),
      extremes: null,
      criterion: null,
      chaotic: null,
      quantum: null,
      extremesProgressionTarget: null,
      chaoticProgressionTarget: null,
      quantumProgressionTarget: null,
    };
    return summary;
  }

  cleanupOldRequests() {
    const now = Date.now();
    const cutoff = now - this.rateLimitWindowMs;
    this.requestTimestamps = this.requestTimestamps.filter(timestamp => timestamp > cutoff);
  }

  canMakeRequest() {
    this.cleanupOldRequests();
    return this.requestTimestamps.length < this.rateLimit;
  }

  trackRequest() {
    this.requestTimestamps.push(Date.now());
  }

  logDebug(message) {
    if (!this.debug) {
      return;
    }
    console.log(`[Tomestone Client] ${message}`);
  }

  isCooldownActive() {
    return this.cooldownUntil && Date.now() < this.cooldownUntil;
  }

  setCooldown(durationMs, reason) {
    const until = Date.now() + durationMs;
    if (until > this.cooldownUntil) {
      this.cooldownUntil = until;
      this.cooldownReason = reason || '';
      this.logDebug(`Cooldown set for ${durationMs}ms (${reason || 'unknown'})`);
    }
  }

  scheduleRequest(fn) {
    return new Promise((resolve, reject) => {
      this.requestQueue.push({ fn, resolve, reject });
      this.logDebug(`Queued request (pending: ${this.requestQueue.length}, active: ${this.activeRequests})`);
      this.processQueue();
    });
  }

  processQueue() {
    if (this.activeRequests >= this.maxConcurrentRequests) {
      return;
    }
    const next = this.requestQueue.shift();
    if (!next) {
      return;
    }

    const now = Date.now();
    const jitter = this.requestJitterMs > 0 ? Math.floor(Math.random() * this.requestJitterMs) : 0;
    const waitMs = Math.max(0, this.requestSpacingMs - (now - this.lastRequestAt)) + jitter;

    const run = async () => {
      this.activeRequests += 1;
      this.lastRequestAt = Date.now();
      this.logDebug(`Dispatching request (active: ${this.activeRequests})`);
      try {
        const result = await next.fn();
        next.resolve(result);
      } catch (err) {
        next.reject(err);
      } finally {
        this.activeRequests -= 1;
        this.logDebug(`Request complete (active: ${this.activeRequests})`);
        this.processQueue();
      }
    };

    if (waitMs > 0) {
      setTimeout(run, waitMs);
    } else {
      run();
    }
  }

  async getProfileById(id) {
    if (!this.enabled) {
      return null;
    }

    if (this.isCooldownActive()) {
      this.logDebug(`Skipping profile fetch for ${id} due to cooldown (${this.cooldownReason})`);
      if (this.store && typeof this.store.getTomestoneProfileRaw === 'function') {
        const cached = await this.store.getTomestoneProfileRaw(id);
        if (cached?.found) {
          this.logDebug(`Using stale profile cache for ${id}`);
          return cached.data;
        }
      }
      return null;
    }

    if (this.store && typeof this.store.getTomestoneProfile === 'function') {
      const cached = await this.store.getTomestoneProfile(id);
      if (cached?.found) {
        this.logDebug(`Profile cache hit for ${id}`);
        return cached.data;
      }
    }

    this.logDebug(`Profile cache miss for ${id}`);
    const profile = await this.fetchProfileById(id);
    const summary = this.buildProfileSummary(profile);
    if (summary && this.store && typeof this.store.setTomestoneProfile === 'function') {
      const expiresAt = new Date(Date.now() + this.profileCacheTTLms);
      await this.store.setTomestoneProfile(
        id,
        summary?.name || '',
        summary?.server || '',
        summary,
        new Date(),
        expiresAt,
      );
      this.logDebug(`Profile cached for ${id} (expires: ${expiresAt.toISOString()})`);
    }

    return summary;
  }

  async fetchProfileById(id) {
    return this.scheduleRequest(async () => {
      if (!this.canMakeRequest()) {
        console.log(`[Tomestone Client] Rate limit exceeded (${this.rateLimit} requests per ${this.rateLimitWindowMs}ms)`);
        return null;
      }

      this.trackRequest();

      const url = `${this.baseURL}/api/character/profile/${id}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      let res;
      try {
        res = await fetch(url, {
          signal: controller.signal,
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${this.token}`,
          },
        });
      } catch (err) {
        console.log(`[Tomestone Client] Profile fetch failed for ${id}: ${err.message}`);
        return null;
      } finally {
        clearTimeout(timeout);
      }

      if (!res.ok) {
        let body = '';
        try {
          body = await res.text();
        } catch (_) {
          // ignore
        }
        if (res.status === 429) {
          const retryAfter = Number.parseInt(res.headers.get('retry-after') || '', 10);
          const backoffMs = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : this.cooldown429Ms;
          this.setCooldown(backoffMs, 'rate_limit');
        } else if (res.status === 403) {
          this.setCooldown(this.cooldown403Ms, 'forbidden');
        }
        console.log(`[Tomestone Client] Profile fetch failed (${res.status}) for ${id}: ${body}`);
        return null;
      }

      try {
        return await res.json();
      } catch (err) {
        console.log(`[Tomestone Client] Profile JSON parse failed for ${id}: ${err.message}`);
        return null;
      }
    });
  }

  async getCharacterAvatarById(id, fallbackName, fallbackWorld) {
    const activityPayload = await this.getActivityById(id);
    if (!activityPayload) {
      return null;
    }

    const avatar = this.getPreferredAvatar(activityPayload);
    if (!avatar) {
      return null;
    }

    return {
      id,
      name: String(activityPayload?.name || fallbackName || '').trim(),
      world: String(activityPayload?.server || fallbackWorld || '').trim(),
      portrait: String(activityPayload?.portrait || '').trim(),
      avatar,
      fetchedAt: new Date(),
    };
  }

  async getActivityById(id) {
    if (!this.enabled) {
      return null;
    }

    if (this.isCooldownActive()) {
      this.logDebug(`Skipping activity fetch for ${id} due to cooldown (${this.cooldownReason})`);
      if (this.store && typeof this.store.getTomestoneActivityRaw === 'function') {
        const cached = await this.store.getTomestoneActivityRaw(id);
        if (cached?.found) {
          this.logDebug(`Using stale activity cache for ${id}`);
          return cached.data;
        }
      }
      return null;
    }

    if (this.store && typeof this.store.getTomestoneActivity === 'function') {
      const cached = await this.store.getTomestoneActivity(id);
      if (cached?.found) {
        this.logDebug(`Activity cache hit for ${id}`);
        return cached.data;
      }
    }

    this.logDebug(`Activity cache miss for ${id}`);
    const activityPayload = await this.fetchActivityAllById(id);
    const summary = this.buildActivitySummary(activityPayload);
    if (summary && this.store && typeof this.store.setTomestoneActivity === 'function') {
      const expiresAt = new Date(Date.now() + this.activityCacheTTLms);
      await this.store.setTomestoneActivity(
        id,
        summary?.name || '',
        summary?.server || '',
        summary,
        new Date(),
        expiresAt,
      );
      this.logDebug(`Activity cached for ${id} (expires: ${expiresAt.toISOString()})`);
    }

    return summary;
  }

  async getActivityByName(name, world) {
    if (!this.enabled) {
      return null;
    }

    const safeName = String(name || '').trim();
    const safeWorld = String(world || '').trim();
    if (!safeName || !safeWorld) {
      return null;
    }

    if (this.isCooldownActive()) {
      this.logDebug(`Skipping activity fetch for ${safeName}@${safeWorld} due to cooldown (${this.cooldownReason})`);
      if (this.store && typeof this.store.getTomestoneActivityRawByName === 'function') {
        const cached = await this.store.getTomestoneActivityRawByName(safeName, safeWorld);
        if (cached?.found) {
          this.logDebug(`Using stale activity cache for ${safeName}@${safeWorld}`);
          return cached.data;
        }
      }
      return null;
    }

    if (this.store && typeof this.store.getTomestoneActivityByName === 'function') {
      const cached = await this.store.getTomestoneActivityByName(safeName, safeWorld);
      if (cached?.found) {
        this.logDebug(`Activity cache hit for ${safeName}@${safeWorld}`);
        return cached.data;
      }
    }

    this.logDebug(`Activity cache miss for ${safeName}@${safeWorld}`);
    const activityPayload = await this.fetchActivityAllByName(safeName, safeWorld);
    const summary = this.buildActivitySummary(activityPayload, safeName, safeWorld);
    if (!summary) {
      return null;
    }

    const id = Number(summary?.id || 0);
    if (id && this.store && typeof this.store.setTomestoneActivity === 'function') {
      const expiresAt = new Date(Date.now() + this.activityCacheTTLms);
      await this.store.setTomestoneActivity(
        id,
        summary?.name || safeName,
        summary?.server || safeWorld,
        summary,
        new Date(),
        expiresAt,
      );
      this.logDebug(`Activity cached for ${id} (${safeName}@${safeWorld}) (expires: ${expiresAt.toISOString()})`);
    }

    return summary;
  }

  async getCachedActivityById(id) {
    if (!this.store || typeof this.store.getTomestoneActivity !== 'function') {
      return null;
    }
    const cached = await this.store.getTomestoneActivity(id);
    if (cached?.found) {
      this.logDebug(`Activity cache read for ${id}`);
      return cached.data;
    }
    return null;
  }

  async fetchActivityPageById(id, pageOrUrl) {
    return this.scheduleRequest(async () => {
      if (!this.canMakeRequest()) {
        console.log(`[Tomestone Client] Rate limit exceeded (${this.rateLimit} requests per ${this.rateLimitWindowMs}ms)`);
        return null;
      }

      this.trackRequest();

      const url = pageOrUrl
        ? String(pageOrUrl)
        : `${this.baseURL}/api/character/activity/${id}?page=1`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      let res;
      try {
        res = await fetch(url, {
          signal: controller.signal,
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${this.token}`,
          },
        });
      } catch (err) {
        console.log(`[Tomestone Client] Activity fetch failed for ${id}: ${err.message}`);
        return null;
      } finally {
        clearTimeout(timeout);
      }

      if (!res.ok) {
        let body = '';
        try {
          body = await res.text();
        } catch (_) {
          // ignore
        }
        if (res.status === 429) {
          const retryAfter = Number.parseInt(res.headers.get('retry-after') || '', 10);
          const backoffMs = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : this.cooldown429Ms;
          this.setCooldown(backoffMs, 'rate_limit');
        } else if (res.status === 403) {
          this.setCooldown(this.cooldown403Ms, 'forbidden');
        }
        console.log(`[Tomestone Client] Activity fetch failed (${res.status}) for ${id}: ${body}`);
        return null;
      }

      try {
        return await res.json();
      } catch (err) {
        console.log(`[Tomestone Client] Activity JSON parse failed for ${id}: ${err.message}`);
        return null;
      }
    });
  }

  async fetchActivityAllById(id) {
    const firstPage = await this.fetchActivityPageById(id, null);
    if (!firstPage) {
      return null;
    }

    const aggregated = this.extractActivities(firstPage);
    let nextUrl = this.getNextPageUrl(firstPage);
    let pageCount = 1;
    this.logDebug(`Activity fetch page 1 for ${id} (items: ${aggregated.length})`);

    while (nextUrl && pageCount < this.maxActivityPages) {
      const page = await this.fetchActivityPageById(id, nextUrl);
      if (!page) {
        break;
      }
      const pageActivities = this.extractActivities(page);
      aggregated.push(...pageActivities);
      this.logDebug(`Activity fetch page ${pageCount + 1} for ${id} (items: ${pageActivities.length})`);
      nextUrl = this.getNextPageUrl(page);
      pageCount += 1;
    }

    this.replaceActivities(firstPage, aggregated);
    return firstPage;
  }

  async fetchActivityAllByName(name, world) {
    const encodedName = encodeURIComponent(String(name || '').trim());
    const encodedWorld = encodeURIComponent(String(world || '').trim());
    const url = `${this.baseURL}/api/character/activity/${encodedWorld}/${encodedName}?page=1`;
    const firstPage = await this.fetchActivityPageById(0, url);
    if (!firstPage) {
      return null;
    }

    const aggregated = this.extractActivities(firstPage);
    let nextUrl = this.getNextPageUrl(firstPage);
    let pageCount = 1;
    this.logDebug(`Activity fetch page 1 for ${name}@${world} (items: ${aggregated.length})`);

    while (nextUrl && pageCount < this.maxActivityPages) {
      const page = await this.fetchActivityPageById(0, nextUrl);
      if (!page) {
        break;
      }
      const pageActivities = this.extractActivities(page);
      aggregated.push(...pageActivities);
      this.logDebug(`Activity fetch page ${pageCount + 1} for ${name}@${world} (items: ${pageActivities.length})`);
      nextUrl = this.getNextPageUrl(page);
      pageCount += 1;
    }

    this.replaceActivities(firstPage, aggregated);
    return firstPage;
  }

  extractActivities(payload) {
    const data = payload?.activity?.activities?.activities?.paginator?.data;
    if (!Array.isArray(data)) {
      return [];
    }
    return data.slice();
  }

  replaceActivities(payload, aggregated) {
    if (!payload?.activity?.activities?.activities?.paginator) {
      return;
    }
    payload.activity.activities.activities.paginator.data = aggregated;
    payload.activity.activities.activities.paginator.next_page_url = null;
  }

  getNextPageUrl(payload) {
    return payload?.activity?.activities?.activities?.paginator?.next_page_url || null;
  }

  startRefresh() {
    if (this.refreshTimer) {
      return;
    }
    if (!this.enabled) {
      return;
    }
    if (!this.store || typeof this.store.listTomestoneActivityExpiring !== 'function') {
      return;
    }

    this.refreshTimer = setInterval(() => this.refreshActivityCache(), this.refreshIntervalMs);
    this.logDebug(`Refresh scheduled every ${this.refreshIntervalMs}ms`);
    this.refreshActivityCache();
  }

  async refreshActivityCache() {
    if (this.refreshInProgress) {
      return;
    }
    if (!this.enabled) {
      return;
    }
    if (!this.store || typeof this.store.listTomestoneActivityExpiring !== 'function') {
      return;
    }

    this.refreshInProgress = true;
    try {
      const expiring = await this.store.listTomestoneActivityExpiring(this.refreshAheadMs, this.refreshBatchSize);
      if (!Array.isArray(expiring) || expiring.length === 0) {
        this.logDebug('No expiring activity cache entries found');
        return;
      }

      this.logDebug(`Refreshing ${expiring.length} activity cache entries`);
      for (const entry of expiring) {
        if (!entry?.id) {
          continue;
        }
        const payload = await this.fetchActivityAllById(entry.id);
        const summary = this.buildActivitySummary(payload, entry.name, entry.world);
        if (!summary) {
          continue;
        }
        const expiresAt = new Date(Date.now() + this.activityCacheTTLms);
        await this.store.setTomestoneActivity(
          entry.id,
          summary?.name || entry.name || '',
          summary?.server || entry.world || '',
          summary,
          new Date(),
          expiresAt,
        );
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    } catch (err) {
      console.log(`[Tomestone Client] Refresh error: ${err.message}`);
    } finally {
      this.refreshInProgress = false;
    }
  }

  getDutyProgress(activityPayload, dutyName) {
    if (!activityPayload || !dutyName) {
      return null;
    }

    const duty = this.normalizeLabel(dutyName);
    if (!duty) {
      return null;
    }

    const encounterMatch = this.findEncounterMatch(activityPayload?.encounters, duty);

    // If they have a cleared achievement for this specific duty, show cleared
    if (encounterMatch?.encounter?.achievement?.completedAt) {
      return '✅ Cleared';
    }

    // Check if this duty is in their progression path
    if (encounterMatch) {
      const categoryTarget = this.getProgressionTargetForCategory(activityPayload?.encounters, encounterMatch.category);
      if (categoryTarget?.index !== undefined && categoryTarget.index >= 0) {
        // If they're progressing a later fight in the series, they've cleared this one
        if (categoryTarget.index > encounterMatch.index) {
          return '✅ Cleared';
        }
        // Only show progress if they're CURRENTLY progressing this specific duty
        if (categoryTarget.index === encounterMatch.index) {
          return this.formatProgress(categoryTarget.target);
        }
        // If progression target is before this fight, they haven't reached it yet
        if (categoryTarget.index < encounterMatch.index) {
          return 'No Information';
        }
      }
      // Encounter exists but no progression data available
      return 'No Information';
    }

    // Encounter not found in their data
    return null;
  }

  formatProgress(target) {
    if (!target) {
      return 'No Information';
    }
    const percent = String(target.percent || '').trim();
    const name = String(target.name || '').trim();
    if (name && percent) {
      return `${name} ${percent}`;
    }
    if (percent) {
      return percent;
    }
    if (name) {
      return name;
    }
    return 'No Information';
  }

  parsePercent(value) {
    if (!value) {
      return 0;
    }
    const cleaned = String(value).replace('%', '').trim();
    const num = Number.parseFloat(cleaned);
    return Number.isFinite(num) ? num : 0;
  }

  formatDate(value) {
    if (!value) {
      return '';
    }
    const raw = String(value).trim();
    if (raw.length >= 10) {
      return raw.slice(0, 10);
    }
    return raw;
  }

  normalizeLabel(value) {
    if (!value) {
      return '';
    }
    return String(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  slugToLabel(value) {
    if (!value) {
      return '';
    }
    return this.normalizeLabel(String(value).replace(/[-_]+/g, ' '));
  }

  matchesDuty(dutyLabel, candidates) {
    // Extract M1/M2/M3/M4 number from duty if present
    const dutyNumberMatch = dutyLabel.match(/\bm(\d+)\b/);
    const dutyNumber = dutyNumberMatch ? dutyNumberMatch[1] : null;

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }
      const normalized = this.normalizeLabel(candidate);
      if (!normalized) {
        continue;
      }

      // Extract M1/M2/M3/M4 number from candidate if present
      const candidateNumberMatch = normalized.match(/\bm(\d+)\b/);
      const candidateNumber = candidateNumberMatch ? candidateNumberMatch[1] : null;

      // If both have numbers, they must match
      if (dutyNumber && candidateNumber && dutyNumber !== candidateNumber) {
        continue;
      }

      if (normalized === dutyLabel || normalized.includes(dutyLabel) || dutyLabel.includes(normalized)) {
        return true;
      }
    }
    return false;
  }

  findEncounterMatch(encounters, dutyLabel) {
    if (!encounters || !dutyLabel) {
      return null;
    }

    const groups = [
      { key: 'ultimate', list: encounters.ultimate },
      { key: 'savage', list: encounters.savage },
      { key: 'extremes', list: encounters.extremes },
      { key: 'criterion', list: encounters.criterion },
      { key: 'chaotic', list: encounters.chaotic },
      { key: 'quantum', list: encounters.quantum },
    ];

    for (const group of groups) {
      if (!Array.isArray(group.list)) {
        continue;
      }
      for (let index = 0; index < group.list.length; index += 1) {
        const encounter = group.list[index];
        if (!encounter) {
          continue;
        }
        const candidates = [
          encounter.name,
          encounter.zoneName,
          encounter.compactName,
          encounter?.activity?.link,
        ];
        if (this.matchesDuty(dutyLabel, candidates)) {
          return { category: group.key, encounter, index };
        }
      }
    }

    return null;
  }

  findProgressionTarget(encounters, dutyLabel, preferredCategory) {
    if (!encounters || !dutyLabel) {
      return null;
    }

    const targets = [];
    const addTarget = (key, target) => {
      if (target) {
        targets.push({ key, target });
      }
    };

    if (preferredCategory) {
      addTarget(preferredCategory, encounters[`${preferredCategory}ProgressionTarget`]);
    }

    addTarget('savage', encounters.savageProgressionTarget);
    addTarget('ultimate', encounters.ultimateProgressionTarget);
    addTarget('extremes', encounters.extremesProgressionTarget);
    addTarget('chaotic', encounters.chaoticProgressionTarget);
    addTarget('quantum', encounters.quantumProgressionTarget);

    for (const entry of targets) {
      const target = entry.target;
      if (!target) {
        continue;
      }

      const link = String(target.link || '');
      const query = link.includes('?') ? link.split('?')[1] : '';
      const params = new URLSearchParams(query);
      const encounterSlug = params.get('encounter');
      const zoneSlug = params.get('zone');

      const candidates = [
        target.name,
        this.slugToLabel(encounterSlug),
        this.slugToLabel(zoneSlug),
      ];

      if (this.matchesDuty(dutyLabel, candidates)) {
        const list = this.getEncounterList(encounters, entry.key);
        const index = this.findEncounterIndex(list, candidates);
        return { category: entry.key, target, index };
      }
    }

    return null;
  }

  getProgressionTargetForCategory(encounters, categoryKey) {
    if (!encounters || !categoryKey) {
      return null;
    }
    const target = encounters[`${categoryKey}ProgressionTarget`];
    if (!target) {
      return null;
    }
    const list = this.getEncounterList(encounters, categoryKey);
    const link = String(target.link || '');
    const query = link.includes('?') ? link.split('?')[1] : '';
    const params = new URLSearchParams(query);
    const encounterSlug = params.get('encounter');
    const zoneSlug = params.get('zone');
    const candidates = [
      target.name,
      this.slugToLabel(encounterSlug),
      this.slugToLabel(zoneSlug),
    ];
    const index = this.findEncounterIndex(list, candidates);
    return { category: categoryKey, target, index };
  }

  getEncounterList(encounters, categoryKey) {
    if (!encounters || !categoryKey) {
      return [];
    }
    const list = encounters[categoryKey];
    return Array.isArray(list) ? list : [];
  }

  findEncounterIndex(list, candidates) {
    if (!Array.isArray(list) || list.length === 0) {
      return -1;
    }
    const candidateLabels = (candidates || [])
      .filter(Boolean)
      .map((value) => this.normalizeLabel(value))
      .filter(Boolean);
    if (candidateLabels.length === 0) {
      return -1;
    }

    for (let index = 0; index < list.length; index += 1) {
      const encounter = list[index];
      if (!encounter) {
        continue;
      }
      const encounterCandidates = [
        encounter.name,
        encounter.zoneName,
        encounter.compactName,
        encounter?.activity?.link,
      ];
      for (const label of candidateLabels) {
        if (this.matchesDuty(label, encounterCandidates)) {
          return index;
        }
      }
    }
    return -1;
  }
}

module.exports = {
  TomestoneClient,
};
