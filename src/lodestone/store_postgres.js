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
}

module.exports = {
  PostgresStore,
};


