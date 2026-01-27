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

  async getProfileById(id) {
    if (!this.enabled) {
      return null;
    }

    if (this.store && typeof this.store.getTomestoneProfile === 'function') {
      const cached = await this.store.getTomestoneProfile(id);
      if (cached?.found) {
        return cached.data;
      }
    }

    const profile = await this.fetchProfileById(id);
    if (profile && this.store && typeof this.store.setTomestoneProfile === 'function') {
      const expiresAt = new Date(Date.now() + this.profileCacheTTLms);
      await this.store.setTomestoneProfile(
        id,
        profile?.name || '',
        profile?.server || '',
        profile,
        new Date(),
        expiresAt,
      );
    }

    return profile;
  }

  async fetchProfileById(id) {
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
      console.log(`[Tomestone Client] Profile fetch failed (${res.status}) for ${id}: ${body}`);
      return null;
    }

    try {
      return await res.json();
    } catch (err) {
      console.log(`[Tomestone Client] Profile JSON parse failed for ${id}: ${err.message}`);
      return null;
    }
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

    if (this.store && typeof this.store.getTomestoneActivity === 'function') {
      const cached = await this.store.getTomestoneActivity(id);
      if (cached?.found) {
        return cached.data;
      }
    }

    const activityPayload = await this.fetchActivityAllById(id);
    if (activityPayload && this.store && typeof this.store.setTomestoneActivity === 'function') {
      const expiresAt = new Date(Date.now() + this.activityCacheTTLms);
      await this.store.setTomestoneActivity(
        id,
        activityPayload?.name || '',
        activityPayload?.server || '',
        activityPayload,
        new Date(),
        expiresAt,
      );
    }

    return activityPayload;
  }

  async fetchActivityPageById(id, pageOrUrl) {
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
      console.log(`[Tomestone Client] Activity fetch failed (${res.status}) for ${id}: ${body}`);
      return null;
    }

    try {
      return await res.json();
    } catch (err) {
      console.log(`[Tomestone Client] Activity JSON parse failed for ${id}: ${err.message}`);
      return null;
    }
  }

  async fetchActivityAllById(id) {
    const firstPage = await this.fetchActivityPageById(id, null);
    if (!firstPage) {
      return null;
    }

    const aggregated = this.extractActivities(firstPage);
    let nextUrl = this.getNextPageUrl(firstPage);
    let pageCount = 1;

    while (nextUrl && pageCount < this.maxActivityPages) {
      const page = await this.fetchActivityPageById(id, nextUrl);
      if (!page) {
        break;
      }
      const pageActivities = this.extractActivities(page);
      aggregated.push(...pageActivities);
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
        return;
      }

      for (const entry of expiring) {
        if (!entry?.id) {
          continue;
        }
        const payload = await this.fetchActivityAllById(entry.id);
        if (!payload) {
          continue;
        }
        const expiresAt = new Date(Date.now() + this.activityCacheTTLms);
        await this.store.setTomestoneActivity(
          entry.id,
          payload?.name || entry.name || '',
          payload?.server || entry.world || '',
          payload,
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

    const duty = String(dutyName).trim().toLowerCase();
    if (!duty) {
      return null;
    }

    const activities = this.extractActivities(activityPayload);
    if (activities.length === 0) {
      return null;
    }

    let bestPercent = 0;
    let clearedAt = '';
    let matchedAny = false;

    for (const entry of activities) {
      const activity = entry?.activity || entry;
      if (!activity) {
        continue;
      }

      const names = [
        activity.contentLocalizedName,
        activity?.encounter?.instanceContentLocalizedName,
        activity?.encounter?.localizedName,
        activity?.encounter?.canonicalName,
      ]
        .filter(Boolean)
        .map((value) => String(value).trim().toLowerCase());

      const matches = names.some((name) => name === duty || name.includes(duty) || duty.includes(name));
      if (!matches) {
        continue;
      }
      matchedAny = true;

      const kills = Number(activity.killsCount || 0);
      if (kills > 0) {
        const clearedDate = this.formatDate(activity.endTime || activity.startTime);
        if (clearedDate) {
          clearedAt = clearedDate;
        }
      }

      const percentValue = this.parsePercent(activity.bestPercent);
      if (percentValue > bestPercent) {
        bestPercent = percentValue;
      }
    }

    if (clearedAt) {
      return `✅ Cleared on ${clearedAt}`;
    }

    if (matchedAny) {
      return `Progress: ${bestPercent.toFixed(1)}%`;
    }

    return 'Progress: Unknown';
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
}

module.exports = {
  TomestoneClient,
};
