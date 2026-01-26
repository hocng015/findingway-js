const NEGATIVE_TTL_MS = 10 * 60 * 1000;

class CacheEntry {
  constructor(character, expiresAt, isNegative) {
    this.character = character;
    this.expiresAt = expiresAt;
    this.hits = 0;
    this.lastAccess = new Date();
    this.isNegative = isNegative;
  }
}

class Cache {
  constructor(ttlMs, maxSize) {
    this.ttlMs = ttlMs;
    this.maxSize = maxSize;
    this.data = new Map();
    this.cleanupTimer = null;
  }

  get(key) {
    const entry = this.data.get(key);
    if (!entry) {
      return { value: null, found: false };
    }

    if (Date.now() > entry.expiresAt.getTime()) {
      this.data.delete(key);
      return { value: null, found: false };
    }

    if (entry.isNegative) {
      return { value: null, found: false };
    }

    entry.lastAccess = new Date();
    entry.hits += 1;
    this.data.delete(key);
    this.data.set(key, entry);

    return { value: entry.character, found: true };
  }

  peek(key) {
    const entry = this.data.get(key);
    if (!entry) {
      return { value: null, found: false };
    }

    if (Date.now() > entry.expiresAt.getTime()) {
      this.data.delete(key);
      return { value: null, found: false };
    }

    return { value: entry, found: true };
  }

  set(key, character) {
    if (this.data.has(key)) {
      this.data.delete(key);
    }

    if (this.data.size >= this.maxSize) {
      this.evictLRU();
    }

    const entry = new CacheEntry(character, new Date(Date.now() + this.ttlMs), false);
    this.data.set(key, entry);
  }

  setNegative(key) {
    if (this.data.has(key)) {
      this.data.delete(key);
    }

    if (this.data.size >= this.maxSize) {
      this.evictLRU();
    }

    const entry = new CacheEntry(null, new Date(Date.now() + NEGATIVE_TTL_MS), true);
    this.data.set(key, entry);
  }

  evictLRU() {
    const oldestKey = this.data.keys().next().value;
    if (oldestKey !== undefined) {
      this.data.delete(oldestKey);
    }
  }

  startCleanup(intervalMs = 30 * 60 * 1000) {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    this.cleanupTimer = setInterval(() => this.cleanup(), intervalMs);
  }

  stopCleanup() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.data.entries()) {
      if (now > entry.expiresAt.getTime()) {
        this.data.delete(key);
      }
    }
  }

  size() {
    return this.data.size;
  }

  clear() {
    this.data.clear();
  }
}

module.exports = {
  Cache,
  CacheEntry,
  NEGATIVE_TTL_MS,
};


