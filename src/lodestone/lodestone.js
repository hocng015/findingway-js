const { Cache, NEGATIVE_TTL_MS } = require('./cache');

const XIVAPI_BASE_URL = 'https://xivapi.com';

const STORE_TIMEOUT_MS = 2000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeWorld(world) {
  if (!world) {
    return '';
  }
  let result = String(world).trim();
  if (result.includes(' @ ')) {
    result = result.split(' @ ')[0].trim();
  }
  const idx = result.indexOf(' (');
  if (idx > 0) {
    result = result.slice(0, idx).trim();
  }
  return result;
}

function normalizeLanguage(language) {
  const lang = String(language || '').toLowerCase();
  switch (lang) {
    case 'jp':
    case 'ja':
      return 'ja';
    case 'fr':
      return 'fr';
    case 'de':
      return 'de';
    default:
      return 'en';
  }
}

class LodestoneClient {
  constructor(enabled, language, cacheTTL, maxCacheSize, perKeyCooldownMs, globalCooldownMs) {
    this.enabled = !!enabled;
    this.language = normalizeLanguage(language);
    this.cache = new Cache(cacheTTL, maxCacheSize);
    this.store = null;
    this.rateLimitMs = 3000; // XIVAPI rate limit - be conservative
    this.requestQueue = [];
    this.workerRunning = false;
    this.inFlight = new Set();
    this.keyCooldown = new Map();
    this.globalUntil = null;
    this.perKeyCooldownMs = perKeyCooldownMs;
    this.globalCooldownMs = globalCooldownMs;

    if (this.enabled) {
      this.startWorker();
    }
  }

  isEnabled() {
    return this.enabled;
  }

  setStore(store) {
    this.store = store;
  }

  cacheKey(name, world) {
    return `${String(name).trim().toLowerCase()}@${String(world).trim().toLowerCase()}`;
  }

  markInFlight(key) {
    if (this.inFlight.has(key)) {
      return false;
    }
    this.inFlight.add(key);
    return true;
  }

  clearInFlight(key) {
    this.inFlight.delete(key);
  }

  isGlobalCooldownActive() {
    if (!this.globalUntil) {
      return false;
    }
    if (Date.now() > this.globalUntil.getTime()) {
      console.log('[Lodestone Client] Global cooldown ended');
      this.globalUntil = null;
      return false;
    }
    return true;
  }

  setGlobalCooldown(durationMs) {
    const until = new Date(Date.now() + durationMs);
    if (!this.globalUntil || until > this.globalUntil) {
      this.globalUntil = until;
    }
  }

  isKeyCooldownActive(cacheKey) {
    const until = this.keyCooldown.get(cacheKey);
    if (!until) {
      return false;
    }
    if (Date.now() > until.getTime()) {
      console.log(`[Lodestone Client] Cooldown ended for ${cacheKey}`);
      this.keyCooldown.delete(cacheKey);
      return false;
    }
    return true;
  }

  setKeyCooldown(cacheKey, durationMs) {
    this.keyCooldown.set(cacheKey, new Date(Date.now() + durationMs));
  }

  clearKeyCooldown(cacheKey) {
    this.keyCooldown.delete(cacheKey);
  }

  async getStoredID(cacheKey) {
    if (!this.store) {
      return { id: 0, found: false };
    }
    const timeout = setTimeout(() => {}, STORE_TIMEOUT_MS);
    try {
      return await this.store.getId(cacheKey);
    } catch (err) {
      console.log(`[Lodestone Client] Store get ID error for ${cacheKey}: ${err.message}`);
      return { id: 0, found: false };
    } finally {
      clearTimeout(timeout);
    }
  }

  async getStoreEntry(cacheKey) {
    if (!this.store) {
      return { data: null, isNegative: false, found: false };
    }
    const timeout = setTimeout(() => {}, STORE_TIMEOUT_MS);
    try {
      const result = await this.store.get(cacheKey);
      if (!result.found) {
        return { data: null, isNegative: false, found: false };
      }
      if (result.isNegative) {
        this.cache.setNegative(cacheKey);
        return { data: null, isNegative: true, found: true };
      }
      if (result.data) {
        this.cache.set(cacheKey, result.data);
        return { data: result.data, isNegative: false, found: true };
      }
      return { data: null, isNegative: false, found: false };
    } catch (err) {
      console.log(`[Lodestone Client] Store get error for ${cacheKey}: ${err.message}`);
      return { data: null, isNegative: false, found: false };
    } finally {
      clearTimeout(timeout);
    }
  }

  async persistPositive(cacheKey, data) {
    if (!this.store || !data) {
      return;
    }

    const expiresAt = new Date(Date.now() + this.cache.ttlMs);
    try {
      await this.store.set(cacheKey, data, expiresAt, false);
    } catch (err) {
      console.log(`[Lodestone Client] Store set error for ${cacheKey}: ${err.message}`);
    }
  }

  async persistNegative(cacheKey, name, world) {
    if (!this.store) {
      return;
    }

    const data = {
      id: 0,
      name,
      world,
      portrait: '',
      avatar: '',
      fetchedAt: new Date(),
    };
    const expiresAt = new Date(Date.now() + NEGATIVE_TTL_MS);
    try {
      await this.store.set(cacheKey, data, expiresAt, true);
    } catch (err) {
      console.log(`[Lodestone Client] Store negative set error for ${cacheKey}: ${err.message}`);
    }
  }

  async getCharacterPortraitCached(name, world) {
    if (!this.isEnabled()) {
      return { url: '', found: false };
    }

    const cacheKey = this.cacheKey(name, world);
    const cached = this.cache.get(cacheKey);
    if (cached.found) {
      const url = cached.value.avatar || cached.value.portrait || '';
      return { url, found: true };
    }

    const storeEntry = await this.getStoreEntry(cacheKey);
    if (storeEntry.found) {
      if (storeEntry.isNegative) {
        return { url: '', found: false };
      }
      const url = storeEntry.data.avatar || storeEntry.data.portrait || '';
      return { url, found: true };
    }

    return { url: '', found: false };
  }

  async isNegativeCached(name, world) {
    if (!this.isEnabled()) {
      return false;
    }

    const cacheKey = this.cacheKey(name, world);
    const entry = this.cache.peek(cacheKey);
    if (entry.found && entry.value.isNegative) {
      return true;
    }

    const storeEntry = await this.getStoreEntry(cacheKey);
    if (storeEntry.found) {
      return storeEntry.isNegative;
    }

    return false;
  }

  async queueCharacterPortraitFetch(name, world) {
    if (!this.isEnabled()) {
      return;
    }

    const cacheKey = this.cacheKey(name, world);
    if (this.cache.peek(cacheKey).found) {
      return;
    }

    const storeEntry = await this.getStoreEntry(cacheKey);
    if (storeEntry.found) {
      return;
    }

    if (this.isGlobalCooldownActive() || this.isKeyCooldownActive(cacheKey)) {
      return;
    }

    if (!this.markInFlight(cacheKey)) {
      return;
    }

    this.requestQueue.push({ key: cacheKey, name, world, response: null });
    console.log(`[Lodestone Client] Queued background fetch for ${name}@${world}`);
  }

  async getCharacterPortrait(name, world) {
    if (!this.isEnabled()) {
      throw new Error('lodestone client is disabled');
    }

    const cacheKey = this.cacheKey(name, world);
    const cached = this.cache.get(cacheKey);
    if (cached.found) {
      const url = cached.value.avatar || cached.value.portrait || '';
      console.log(`[Lodestone Client] Cache HIT for ${cacheKey} (avatar: ${url})`);
      return url;
    }

    const cachedPeek = this.cache.peek(cacheKey);
    if (cachedPeek.found && cachedPeek.value.isNegative) {
      throw new Error(`character not found: ${name} @ ${world}`);
    }

    const storeEntry = await this.getStoreEntry(cacheKey);
    if (storeEntry.found) {
      if (storeEntry.isNegative) {
        throw new Error(`character not found: ${name} @ ${world}`);
      }
      const url = storeEntry.data.avatar || storeEntry.data.portrait || '';
      return url;
    }

    if (this.isGlobalCooldownActive() || this.isKeyCooldownActive(cacheKey)) {
      throw new Error('lodestone search cooldown active');
    }

    if (!this.markInFlight(cacheKey)) {
      console.log(`[Lodestone Client] Request already in flight for ${cacheKey}, waiting...`);
      return this.waitForCache(cacheKey, name, world, 60000);
    }

    console.log(`[Lodestone Client] Cache MISS for ${cacheKey}, queuing request...`);

    let resolveResponse;
    let rejectResponse;
    const responsePromise = new Promise((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });

    this.requestQueue.push({
      key: cacheKey,
      name,
      world,
      response: { resolve: resolveResponse, reject: rejectResponse },
    });

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('response timeout')), 60000);
    });

    return Promise.race([responsePromise, timeoutPromise]);
  }

  async waitForCache(cacheKey, name, world, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const cached = this.cache.get(cacheKey);
      if (cached.found) {
        const url = cached.value.avatar || cached.value.portrait || '';
        if (!url) {
          throw new Error(`portrait not available: ${name} @ ${world}`);
        }
        return url;
      }
      const peek = this.cache.peek(cacheKey);
      if (peek.found && peek.value.isNegative) {
        throw new Error(`character not found: ${name} @ ${world}`);
      }
      await sleep(200);
    }
    throw new Error('response timeout');
  }

  startWorker() {
    if (this.workerRunning) {
      return;
    }
    this.workerRunning = true;

    const loop = async () => {
      while (this.workerRunning) {
        const req = this.requestQueue.shift();
        if (!req) {
          await sleep(250);
          continue;
        }
        await sleep(this.rateLimitMs);
        await this.handleRequest(req);
      }
    };

    loop();
  }

  async handleRequest(req) {
    try {
      const url = await this.fetchPortraitDirect(req.name, req.world);
      if (req.response) {
        req.response.resolve(url);
      }
    } catch (err) {
      if (req.response) {
        req.response.reject(err);
      }
    } finally {
      this.clearInFlight(req.key);
    }
  }

  async fetchPortraitDirect(name, world) {
    const cacheKey = this.cacheKey(name, world);
    console.log(`[Lodestone Client] Processing request for ${cacheKey} (name='${name}', world='${world}')...`);

    const stored = await this.getStoredID(cacheKey);
    if (stored.found && stored.id > 0) {
      console.log(`[Lodestone Client] Using stored character ID ${stored.id} for ${cacheKey}`);
      const character = await this.fetchCharacterById(stored.id);
      if (character) {
        const portraitURL = character.avatar || character.portrait || '';
        console.log(`[Lodestone Client] Retrieved avatar URL: ${portraitURL}`);
        this.cache.set(cacheKey, character);
        await this.persistPositive(cacheKey, character);
        console.log(`[Lodestone Client] Cached character data for ${cacheKey}`);
        this.clearKeyCooldown(cacheKey);
        return portraitURL;
      }
    }

    const searchResult = await this.searchCharacter(name, world, cacheKey);
    if (!searchResult) {
      this.cache.setNegative(cacheKey);
      await this.persistNegative(cacheKey, name, world);
      throw new Error(`character not found: ${name} @ ${world}`);
    }

    const character = await this.fetchCharacterById(searchResult.id);
    if (!character) {
      throw new Error('failed to fetch character');
    }

    const portraitURL = character.avatar || character.portrait || '';
    console.log(`[Lodestone Client] Retrieved avatar URL: ${portraitURL}`);
    this.cache.set(cacheKey, character);
    await this.persistPositive(cacheKey, character);
    console.log(`[Lodestone Client] Cached character data for ${cacheKey}`);
    this.clearKeyCooldown(cacheKey);

    return portraitURL;
  }

  async searchCharacter(name, world, cacheKey) {
    const searchUrl = `${XIVAPI_BASE_URL}/character/search?name=${encodeURIComponent(name)}&server=${encodeURIComponent(world)}`;
    console.log(`[Lodestone Client] Searching XIVAPI for ${cacheKey}...`);

    let response;
    try {
      response = await this.fetchJSON(searchUrl, 60000);
    } catch (err) {
      console.log(`[Lodestone Client] Search error for ${cacheKey}: ${err.message}`);
      if (String(err.message || '').includes('429')) {
        this.setGlobalCooldown(this.globalCooldownMs);
        this.setKeyCooldown(cacheKey, this.perKeyCooldownMs);
      } else {
        this.cache.setNegative(cacheKey);
        await this.persistNegative(cacheKey, name, world);
      }
      throw err;
    }

    if (!response.Results || response.Results.length === 0) {
      console.log(`[Lodestone Client] No results found for ${cacheKey}`);
      return null;
    }

    // Find exact match (case-insensitive)
    const exactMatch = response.Results.find(
      (char) => char.Name.toLowerCase() === name.toLowerCase()
    );

    if (!exactMatch) {
      console.log(`[Lodestone Client] No exact match found for ${cacheKey}`);
      return null;
    }

    console.log(`[Lodestone Client] Found character ID ${exactMatch.ID} for ${cacheKey}`);
    return {
      id: exactMatch.ID,
      name: exactMatch.Name,
      world: exactMatch.Server,
      avatar: exactMatch.Avatar || '',
    };
  }


  async fetchCharacterById(id) {
    const url = `${XIVAPI_BASE_URL}/character/${id}`;
    let data;
    try {
      data = await this.fetchJSON(url, 60000);
    } catch (err) {
      console.log(`[Lodestone Client] Failed to fetch character ${id}: ${err.message}`);
      return null;
    }

    if (!data.Character) {
      console.log(`[Lodestone Client] No character data returned for ID ${id}`);
      return null;
    }

    const char = data.Character;
    const name = char.Name || '';
    const world = char.Server || '';
    const avatar = char.Avatar || '';
    const portrait = char.Portrait || '';

    return {
      id,
      name,
      world,
      portrait,
      avatar,
      fetchedAt: new Date(),
    };
  }

  async fetchJSON(url, timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      return await res.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  startCacheCleanup() {
    if (!this.isEnabled()) {
      return;
    }
    this.cache.startCleanup();
    this.logCacheStats();

    if (this.store && typeof this.store.cleanupExpired === 'function') {
      setInterval(async () => {
        if (!this.isEnabled()) {
          return;
        }
        try {
          await this.store.cleanupExpired();
        } catch (err) {
          console.log(`[Lodestone Store] Cleanup expired rows error: ${err.message}`);
        }
      }, 30 * 60 * 1000);
    }
  }

  logCacheStats() {
    setInterval(() => {
      if (!this.isEnabled()) {
        return;
      }
      const size = this.cache.size();
      let totalHits = 0;
      let positiveEntries = 0;
      let negativeEntries = 0;
      for (const entry of this.cache.data.values()) {
        totalHits += entry.hits;
        if (entry.isNegative) {
          negativeEntries += 1;
        } else {
          positiveEntries += 1;
        }
      }
      console.log(
        `[Lodestone Cache Stats] Size: ${size}/${this.cache.maxSize} | Positive: ${positiveEntries} | Negative: ${negativeEntries} | Total Hits: ${totalHits}`,
      );
    }, 5 * 60 * 1000);
  }
}

module.exports = {
  LodestoneClient,
  normalizeWorld,
};
