const { Pool } = require('pg');

class PostgresStore {
  constructor(connectionString) {
    this.connectionString = connectionString;
    this.pool = null;
  }

  async init() {
    this.pool = new Pool({
      connectionString: this.connectionString,
      max: 5,
      idleTimeoutMillis: 60 * 1000,
      connectionTimeoutMillis: 10 * 1000,
    });

    await this.pool.query('SELECT 1');
    await this.ensureSchema();
  }

  async close() {
    if (!this.pool) {
      return;
    }
    await this.pool.end();
  }

  async ensureSchema() {
    const query = `
      create table if not exists lodestone_portraits (
        cache_key text primary key,
        character_id bigint,
        name text not null,
        world text not null,
        portrait_url text,
        avatar_url text,
        is_negative boolean not null default false,
        fetched_at timestamptz not null,
        expires_at timestamptz not null
      );
      alter table lodestone_portraits
        add column if not exists character_id bigint;
      create index if not exists lodestone_portraits_expires_idx
        on lodestone_portraits (expires_at);

      create table if not exists tomestone_character_cache (
        character_id bigint primary key,
        name text not null,
        world text not null,
        profile_json jsonb,
        activity_json jsonb,
        profile_fetched_at timestamptz,
        activity_fetched_at timestamptz,
        profile_expires_at timestamptz,
        activity_expires_at timestamptz
      );
      create index if not exists tomestone_character_cache_profile_expires_idx
        on tomestone_character_cache (profile_expires_at);
      create index if not exists tomestone_character_cache_activity_expires_idx
        on tomestone_character_cache (activity_expires_at);
    `;
    await this.pool.query(query);
  }

  async get(cacheKey) {
    if (!this.pool) {
      return { data: null, isNegative: false, found: false };
    }

    const { rows } = await this.pool.query(
      `
        select character_id, name, world, portrait_url, avatar_url, is_negative, fetched_at, expires_at
        from lodestone_portraits
        where cache_key = $1
      `,
      [cacheKey],
    );

    if (rows.length === 0) {
      return { data: null, isNegative: false, found: false };
    }

    const row = rows[0];
    const expiresAt = new Date(row.expires_at);
    if (Date.now() > expiresAt.getTime()) {
      return { data: null, isNegative: false, found: false };
    }

    if (row.is_negative) {
      return { data: null, isNegative: true, found: true };
    }

    const data = {
      id: row.character_id ? Number(row.character_id) : 0,
      name: row.name,
      world: row.world,
      portrait: row.portrait_url || '',
      avatar: row.avatar_url || '',
      fetchedAt: new Date(row.fetched_at),
    };

    return { data, isNegative: false, found: true };
  }

  async getId(cacheKey) {
    if (!this.pool) {
      return { id: 0, found: false };
    }

    const { rows } = await this.pool.query(
      `
        select character_id
        from lodestone_portraits
        where cache_key = $1
      `,
      [cacheKey],
    );

    if (rows.length === 0 || !rows[0].character_id) {
      return { id: 0, found: false };
    }

    const id = Number(rows[0].character_id);
    if (!id || id <= 0) {
      return { id: 0, found: false };
    }

    return { id, found: true };
  }

  async set(cacheKey, data, expiresAt, isNegative) {
    if (!this.pool) {
      return;
    }

    let characterId = null;
    let name = '';
    let world = '';
    let portrait = '';
    let avatar = '';
    let fetchedAt = new Date();

    if (data) {
      if (data.id && data.id > 0) {
        characterId = data.id;
      }
      name = data.name || '';
      world = data.world || '';
      portrait = data.portrait || '';
      avatar = data.avatar || '';
      if (data.fetchedAt) {
        fetchedAt = new Date(data.fetchedAt);
      }
    }

    await this.pool.query(
      `
        insert into lodestone_portraits (
          cache_key, character_id, name, world, portrait_url, avatar_url, is_negative, fetched_at, expires_at
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        on conflict (cache_key) do update set
          character_id = excluded.character_id,
          name = excluded.name,
          world = excluded.world,
          portrait_url = excluded.portrait_url,
          avatar_url = excluded.avatar_url,
          is_negative = excluded.is_negative,
          fetched_at = excluded.fetched_at,
          expires_at = excluded.expires_at
      `,
      [cacheKey, characterId, name, world, portrait, avatar, isNegative, fetchedAt, expiresAt],
    );
  }

  async cleanupExpired() {
    if (!this.pool) {
      return;
    }

    await this.pool.query('delete from lodestone_portraits where expires_at < now()');
  }

  async getTomestoneProfile(characterId) {
    if (!this.pool) {
      return { data: null, found: false };
    }

    const { rows } = await this.pool.query(
      `
        select profile_json, profile_expires_at, name, world, profile_fetched_at
        from tomestone_character_cache
        where character_id = $1
      `,
      [characterId],
    );

    if (rows.length === 0 || !rows[0].profile_json) {
      return { data: null, found: false };
    }

    const expiresAt = rows[0].profile_expires_at ? new Date(rows[0].profile_expires_at) : null;
    if (expiresAt && Date.now() > expiresAt.getTime()) {
      return { data: null, found: false };
    }

    return {
      data: rows[0].profile_json,
      found: true,
      name: rows[0].name,
      world: rows[0].world,
      fetchedAt: rows[0].profile_fetched_at ? new Date(rows[0].profile_fetched_at) : null,
    };
  }

  async setTomestoneProfile(characterId, name, world, profileJson, fetchedAt, expiresAt) {
    if (!this.pool) {
      return;
    }

    await this.pool.query(
      `
        insert into tomestone_character_cache (
          character_id, name, world, profile_json, profile_fetched_at, profile_expires_at
        ) values ($1,$2,$3,$4,$5,$6)
        on conflict (character_id) do update set
          name = excluded.name,
          world = excluded.world,
          profile_json = excluded.profile_json,
          profile_fetched_at = excluded.profile_fetched_at,
          profile_expires_at = excluded.profile_expires_at
      `,
      [characterId, name || '', world || '', profileJson, fetchedAt, expiresAt],
    );
  }

  async getTomestoneActivity(characterId) {
    if (!this.pool) {
      return { data: null, found: false };
    }

    const { rows } = await this.pool.query(
      `
        select activity_json, activity_expires_at, name, world, activity_fetched_at
        from tomestone_character_cache
        where character_id = $1
      `,
      [characterId],
    );

    if (rows.length === 0 || !rows[0].activity_json) {
      return { data: null, found: false };
    }

    const expiresAt = rows[0].activity_expires_at ? new Date(rows[0].activity_expires_at) : null;
    if (expiresAt && Date.now() > expiresAt.getTime()) {
      return { data: null, found: false };
    }

    return {
      data: rows[0].activity_json,
      found: true,
      name: rows[0].name,
      world: rows[0].world,
      fetchedAt: rows[0].activity_fetched_at ? new Date(rows[0].activity_fetched_at) : null,
    };
  }

  async setTomestoneActivity(characterId, name, world, activityJson, fetchedAt, expiresAt) {
    if (!this.pool) {
      return;
    }

    await this.pool.query(
      `
        insert into tomestone_character_cache (
          character_id, name, world, activity_json, activity_fetched_at, activity_expires_at
        ) values ($1,$2,$3,$4,$5,$6)
        on conflict (character_id) do update set
          name = excluded.name,
          world = excluded.world,
          activity_json = excluded.activity_json,
          activity_fetched_at = excluded.activity_fetched_at,
          activity_expires_at = excluded.activity_expires_at
      `,
      [characterId, name || '', world || '', activityJson, fetchedAt, expiresAt],
    );
  }

  async listTomestoneActivityExpiring(withinMs, limit = 25) {
    if (!this.pool) {
      return [];
    }

    const windowMs = Number.isFinite(withinMs) && withinMs > 0 ? withinMs : 0;
    const maxRows = Number.isFinite(limit) && limit > 0 ? limit : 25;

    const { rows } = await this.pool.query(
      `
        select character_id, name, world, activity_expires_at
        from tomestone_character_cache
        where activity_json is not null
          and activity_expires_at is not null
          and activity_expires_at < now() + ($1 * interval '1 millisecond')
        order by activity_expires_at asc
        limit $2
      `,
      [windowMs, maxRows],
    );

    return rows.map((row) => ({
      id: row.character_id ? Number(row.character_id) : 0,
      name: row.name,
      world: row.world,
      expiresAt: row.activity_expires_at ? new Date(row.activity_expires_at) : null,
    }));
  }

  async listExpiring(withinMs, limit = 25) {
    if (!this.pool) {
      return [];
    }

    const windowMs = Number.isFinite(withinMs) && withinMs > 0 ? withinMs : 0;
    const maxRows = Number.isFinite(limit) && limit > 0 ? limit : 25;

    const { rows } = await this.pool.query(
      `
        select cache_key, character_id, name, world, is_negative, fetched_at, expires_at
        from lodestone_portraits
        where is_negative = false
          and expires_at < now() + ($1 * interval '1 millisecond')
        order by expires_at asc
        limit $2
      `,
      [windowMs, maxRows],
    );

    return rows.map((row) => ({
      cacheKey: row.cache_key,
      id: row.character_id ? Number(row.character_id) : 0,
      name: row.name,
      world: row.world,
      isNegative: row.is_negative,
      fetchedAt: row.fetched_at ? new Date(row.fetched_at) : null,
      expiresAt: row.expires_at ? new Date(row.expires_at) : null,
    }));
  }
}

module.exports = {
  PostgresStore,
};


