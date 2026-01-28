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
        lodestone_avatar_url text,
        lodestone_banner_url text,
        lodestone_portrait_url text,
        custom_avatar_url text,
        custom_banner_url text,
        custom_portrait_url text,
        savage_encounters jsonb,
        ultimate_encounters jsonb,
        savage_progression jsonb,
        ultimate_progression jsonb,
        profile_fetched_at timestamptz,
        activity_fetched_at timestamptz,
        profile_expires_at timestamptz,
        activity_expires_at timestamptz
      );
      alter table tomestone_character_cache
        add column if not exists lodestone_avatar_url text;
      alter table tomestone_character_cache
        add column if not exists lodestone_banner_url text;
      alter table tomestone_character_cache
        add column if not exists lodestone_portrait_url text;
      alter table tomestone_character_cache
        add column if not exists custom_avatar_url text;
      alter table tomestone_character_cache
        add column if not exists custom_banner_url text;
      alter table tomestone_character_cache
        add column if not exists custom_portrait_url text;
      alter table tomestone_character_cache
        add column if not exists savage_encounters jsonb;
      alter table tomestone_character_cache
        add column if not exists ultimate_encounters jsonb;
      alter table tomestone_character_cache
        add column if not exists savage_progression jsonb;
      alter table tomestone_character_cache
        add column if not exists ultimate_progression jsonb;
      alter table tomestone_character_cache
        add column if not exists profile_fetched_at timestamptz;
      alter table tomestone_character_cache
        add column if not exists activity_fetched_at timestamptz;
      alter table tomestone_character_cache
        add column if not exists profile_expires_at timestamptz;
      alter table tomestone_character_cache
        add column if not exists activity_expires_at timestamptz;
      create index if not exists tomestone_character_cache_profile_expires_idx
        on tomestone_character_cache (profile_expires_at);
      create index if not exists tomestone_character_cache_activity_expires_idx
        on tomestone_character_cache (activity_expires_at);
      create index if not exists tomestone_character_cache_name_world_idx
        on tomestone_character_cache (lower(name), lower(world));
    `;
    await this.pool.query(query);
  }

  normalizeImageUrl(value) {
    if (!value) {
      return null;
    }
    const trimmed = String(value).trim();
    return trimmed || null;
  }

  buildCustomImagesFromRow(row) {
    const customImages = {};
    if (row.custom_avatar_url) {
      customImages.avatar = { image: row.custom_avatar_url };
    }
    if (row.custom_banner_url) {
      customImages.banner = { image: row.custom_banner_url };
    }
    if (row.custom_portrait_url) {
      customImages.portrait = { image: row.custom_portrait_url };
    }
    return Object.keys(customImages).length > 0 ? customImages : null;
  }

  buildTomestoneProfilePayload(row) {
    const data = {
      id: row.character_id ? Number(row.character_id) : 0,
      name: row.name || '',
      server: row.world || '',
      avatar: row.lodestone_avatar_url || '',
      banner: row.lodestone_banner_url || '',
      portrait: row.lodestone_portrait_url || '',
    };
    const customImages = this.buildCustomImagesFromRow(row);
    if (customImages) {
      data.customImages = customImages;
    }
    return data;
  }

  buildTomestoneActivityPayload(row) {
    const data = this.buildTomestoneProfilePayload(row);
    data.encounters = {
      savage: row.savage_encounters || null,
      ultimate: row.ultimate_encounters || null,
      savageProgressionTarget: row.savage_progression || null,
      ultimateProgressionTarget: row.ultimate_progression || null,
      extremes: null,
      criterion: null,
      chaotic: null,
      quantum: null,
      extremesProgressionTarget: null,
      chaoticProgressionTarget: null,
      quantumProgressionTarget: null,
    };
    return data;
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
        select character_id, name, world,
          lodestone_avatar_url, lodestone_banner_url, lodestone_portrait_url,
          custom_avatar_url, custom_banner_url, custom_portrait_url,
          profile_expires_at, profile_fetched_at
        from tomestone_character_cache
        where character_id = $1
      `,
      [characterId],
    );

    if (rows.length === 0) {
      return { data: null, found: false };
    }

    const row = rows[0];
    if (!row.profile_fetched_at && !row.profile_expires_at) {
      return { data: null, found: false };
    }

    const expiresAt = row.profile_expires_at ? new Date(row.profile_expires_at) : null;
    if (expiresAt && Date.now() > expiresAt.getTime()) {
      return { data: null, found: false };
    }

    return {
      data: this.buildTomestoneProfilePayload(row),
      found: true,
      name: row.name,
      world: row.world,
      fetchedAt: row.profile_fetched_at ? new Date(row.profile_fetched_at) : null,
    };
  }

  async getTomestoneProfileRaw(characterId) {
    if (!this.pool) {
      return { data: null, found: false };
    }

    const { rows } = await this.pool.query(
      `
        select character_id, name, world,
          lodestone_avatar_url, lodestone_banner_url, lodestone_portrait_url,
          custom_avatar_url, custom_banner_url, custom_portrait_url,
          profile_expires_at, profile_fetched_at
        from tomestone_character_cache
        where character_id = $1
      `,
      [characterId],
    );

    if (rows.length === 0) {
      return { data: null, found: false };
    }

    const row = rows[0];
    if (!row.profile_fetched_at && !row.profile_expires_at) {
      return { data: null, found: false };
    }

    return {
      data: this.buildTomestoneProfilePayload(row),
      found: true,
      name: row.name,
      world: row.world,
      fetchedAt: row.profile_fetched_at ? new Date(row.profile_fetched_at) : null,
      expiresAt: row.profile_expires_at ? new Date(row.profile_expires_at) : null,
    };
  }

  async setTomestoneProfile(characterId, name, world, profileJson, fetchedAt, expiresAt) {
    if (!this.pool) {
      return;
    }

    const lodestoneAvatar = this.normalizeImageUrl(profileJson?.avatar);
    const lodestoneBanner = this.normalizeImageUrl(profileJson?.banner);
    const lodestonePortrait = this.normalizeImageUrl(profileJson?.portrait);
    const customAvatar = this.normalizeImageUrl(profileJson?.customImages?.avatar?.image);
    const customBanner = this.normalizeImageUrl(profileJson?.customImages?.banner?.image);
    const customPortrait = this.normalizeImageUrl(profileJson?.customImages?.portrait?.image);

    await this.pool.query(
      `
        insert into tomestone_character_cache (
          character_id, name, world,
          lodestone_avatar_url, lodestone_banner_url, lodestone_portrait_url,
          custom_avatar_url, custom_banner_url, custom_portrait_url,
          profile_fetched_at, profile_expires_at
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        on conflict (character_id) do update set
          name = excluded.name,
          world = excluded.world,
          lodestone_avatar_url = excluded.lodestone_avatar_url,
          lodestone_banner_url = excluded.lodestone_banner_url,
          lodestone_portrait_url = excluded.lodestone_portrait_url,
          custom_avatar_url = excluded.custom_avatar_url,
          custom_banner_url = excluded.custom_banner_url,
          custom_portrait_url = excluded.custom_portrait_url,
          profile_fetched_at = excluded.profile_fetched_at,
          profile_expires_at = excluded.profile_expires_at
      `,
      [
        characterId,
        name || '',
        world || '',
        lodestoneAvatar,
        lodestoneBanner,
        lodestonePortrait,
        customAvatar,
        customBanner,
        customPortrait,
        fetchedAt,
        expiresAt,
      ],
    );
  }

  async getTomestoneActivity(characterId) {
    if (!this.pool) {
      return { data: null, found: false };
    }

    const { rows } = await this.pool.query(
      `
        select character_id, name, world,
          lodestone_avatar_url, lodestone_banner_url, lodestone_portrait_url,
          custom_avatar_url, custom_banner_url, custom_portrait_url,
          savage_encounters, ultimate_encounters,
          savage_progression, ultimate_progression,
          activity_expires_at, activity_fetched_at
        from tomestone_character_cache
        where character_id = $1
      `,
      [characterId],
    );

    if (rows.length === 0) {
      return { data: null, found: false };
    }

    const row = rows[0];
    if (!row.activity_fetched_at && !row.activity_expires_at) {
      return { data: null, found: false };
    }

    const expiresAt = row.activity_expires_at ? new Date(row.activity_expires_at) : null;
    if (expiresAt && Date.now() > expiresAt.getTime()) {
      return { data: null, found: false };
    }

    return {
      data: this.buildTomestoneActivityPayload(row),
      found: true,
      name: row.name,
      world: row.world,
      fetchedAt: row.activity_fetched_at ? new Date(row.activity_fetched_at) : null,
    };
  }

  async getTomestoneActivityByName(name, world) {
    if (!this.pool) {
      return { data: null, found: false };
    }

    const nameValue = String(name || '').trim().toLowerCase();
    const worldValue = String(world || '').trim().toLowerCase();
    if (!nameValue || !worldValue) {
      return { data: null, found: false };
    }

    const { rows } = await this.pool.query(
      `
        select character_id, name, world,
          lodestone_avatar_url, lodestone_banner_url, lodestone_portrait_url,
          custom_avatar_url, custom_banner_url, custom_portrait_url,
          savage_encounters, ultimate_encounters,
          savage_progression, ultimate_progression,
          activity_expires_at, activity_fetched_at
        from tomestone_character_cache
        where lower(name) = $1
          and lower(world) = $2
        limit 1
      `,
      [nameValue, worldValue],
    );

    if (rows.length === 0) {
      return { data: null, found: false };
    }

    const row = rows[0];
    if (!row.activity_fetched_at && !row.activity_expires_at) {
      return { data: null, found: false };
    }

    const expiresAt = row.activity_expires_at ? new Date(row.activity_expires_at) : null;
    if (expiresAt && Date.now() > expiresAt.getTime()) {
      return { data: null, found: false };
    }

    return {
      data: this.buildTomestoneActivityPayload(row),
      found: true,
      name: row.name,
      world: row.world,
      fetchedAt: row.activity_fetched_at ? new Date(row.activity_fetched_at) : null,
    };
  }

  async getTomestoneActivityRaw(characterId) {
    if (!this.pool) {
      return { data: null, found: false };
    }

    const { rows } = await this.pool.query(
      `
        select character_id, name, world,
          lodestone_avatar_url, lodestone_banner_url, lodestone_portrait_url,
          custom_avatar_url, custom_banner_url, custom_portrait_url,
          savage_encounters, ultimate_encounters,
          savage_progression, ultimate_progression,
          activity_expires_at, activity_fetched_at
        from tomestone_character_cache
        where character_id = $1
      `,
      [characterId],
    );

    if (rows.length === 0) {
      return { data: null, found: false };
    }

    const row = rows[0];
    if (!row.activity_fetched_at && !row.activity_expires_at) {
      return { data: null, found: false };
    }

    return {
      data: this.buildTomestoneActivityPayload(row),
      found: true,
      name: row.name,
      world: row.world,
      fetchedAt: row.activity_fetched_at ? new Date(row.activity_fetched_at) : null,
      expiresAt: row.activity_expires_at ? new Date(row.activity_expires_at) : null,
    };
  }

  async getTomestoneActivityRawByName(name, world) {
    if (!this.pool) {
      return { data: null, found: false };
    }

    const nameValue = String(name || '').trim().toLowerCase();
    const worldValue = String(world || '').trim().toLowerCase();
    if (!nameValue || !worldValue) {
      return { data: null, found: false };
    }

    const { rows } = await this.pool.query(
      `
        select character_id, name, world,
          lodestone_avatar_url, lodestone_banner_url, lodestone_portrait_url,
          custom_avatar_url, custom_banner_url, custom_portrait_url,
          savage_encounters, ultimate_encounters,
          savage_progression, ultimate_progression,
          activity_expires_at, activity_fetched_at
        from tomestone_character_cache
        where lower(name) = $1
          and lower(world) = $2
        limit 1
      `,
      [nameValue, worldValue],
    );

    if (rows.length === 0) {
      return { data: null, found: false };
    }

    const row = rows[0];
    if (!row.activity_fetched_at && !row.activity_expires_at) {
      return { data: null, found: false };
    }

    return {
      data: this.buildTomestoneActivityPayload(row),
      found: true,
      name: row.name,
      world: row.world,
      fetchedAt: row.activity_fetched_at ? new Date(row.activity_fetched_at) : null,
      expiresAt: row.activity_expires_at ? new Date(row.activity_expires_at) : null,
    };
  }

  async setTomestoneActivity(characterId, name, world, activityJson, fetchedAt, expiresAt) {
    if (!this.pool) {
      return;
    }

    const lodestoneAvatar = this.normalizeImageUrl(activityJson?.avatar);
    const lodestoneBanner = this.normalizeImageUrl(activityJson?.banner);
    const lodestonePortrait = this.normalizeImageUrl(activityJson?.portrait);
    const customAvatar = this.normalizeImageUrl(activityJson?.customImages?.avatar?.image);
    const customBanner = this.normalizeImageUrl(activityJson?.customImages?.banner?.image);
    const customPortrait = this.normalizeImageUrl(activityJson?.customImages?.portrait?.image);
    const savageEncounters = activityJson?.encounters?.savage ?? null;
    const ultimateEncounters = activityJson?.encounters?.ultimate ?? null;
    const savageProgression = activityJson?.encounters?.savageProgressionTarget ?? null;
    const ultimateProgression = activityJson?.encounters?.ultimateProgressionTarget ?? null;

    await this.pool.query(
      `
        insert into tomestone_character_cache (
          character_id, name, world,
          lodestone_avatar_url, lodestone_banner_url, lodestone_portrait_url,
          custom_avatar_url, custom_banner_url, custom_portrait_url,
          savage_encounters, ultimate_encounters,
          savage_progression, ultimate_progression,
          activity_fetched_at, activity_expires_at
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        on conflict (character_id) do update set
          name = excluded.name,
          world = excluded.world,
          lodestone_avatar_url = excluded.lodestone_avatar_url,
          lodestone_banner_url = excluded.lodestone_banner_url,
          lodestone_portrait_url = excluded.lodestone_portrait_url,
          custom_avatar_url = excluded.custom_avatar_url,
          custom_banner_url = excluded.custom_banner_url,
          custom_portrait_url = excluded.custom_portrait_url,
          savage_encounters = excluded.savage_encounters,
          ultimate_encounters = excluded.ultimate_encounters,
          savage_progression = excluded.savage_progression,
          ultimate_progression = excluded.ultimate_progression,
          activity_fetched_at = excluded.activity_fetched_at,
          activity_expires_at = excluded.activity_expires_at
      `,
      [
        characterId,
        name || '',
        world || '',
        lodestoneAvatar,
        lodestoneBanner,
        lodestonePortrait,
        customAvatar,
        customBanner,
        customPortrait,
        savageEncounters,
        ultimateEncounters,
        savageProgression,
        ultimateProgression,
        fetchedAt,
        expiresAt,
      ],
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
        where activity_expires_at is not null
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


