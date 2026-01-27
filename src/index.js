require('dotenv').config();
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { Discord } = require('./discord/discord');
const { Logger } = require('./logger/logger');
const { Scraper } = require('./scraper/scraper');
const { MarketboardClient } = require('./marketboard/marketboard');
const { LodestoneClient } = require('./lodestone/lodestone');
const { TomestoneClient } = require('./tomestone/tomestone');
const { PostgresStore } = require('./lodestone/store_postgres');
const { HealthServer } = require('./web/server');

function getEnvOrDefault(key, defaultValue) {
  const value = process.env[key];
  if (value && value.trim() !== '') {
    return value;
  }
  return defaultValue;
}

function parseDurationMs(value, fallbackMs) {
  if (!value || typeof value !== 'string') {
    return fallbackMs;
  }

  const trimmed = value.trim();
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

async function main() {
  const log = Logger.newDefault();
  log.info('Starting Findingway...');

  const discordToken = process.env.DISCORD_TOKEN?.trim();
  if (!discordToken) {
    throw new Error('You must supply a DISCORD_TOKEN to start!');
  }

  const once = (process.env.ONCE || 'false').trim();

  const discord = new Discord(discordToken);

  let configPath = path.join(process.cwd(), 'config.yaml');
  if (!fs.existsSync(configPath)) {
    configPath = path.join(__dirname, '..', 'config.yaml');
  }
  if (!fs.existsSync(configPath)) {
    configPath = path.join(__dirname, 'config.yaml');
  }

  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found! Tried: ${configPath}`);
  }

  const configData = fs.readFileSync(configPath, 'utf8');
  const config = yaml.load(configData) || {};

  discord.channels = config.channels || [];
  discord.marketboardChannels = config.marketboardChannels || [];
  discord.recruitmentChannels = config.recruitmentChannels || [];
  if (config.lodestone) {
    discord.lodestone = config.lodestone;
  }
  if (config.tomestone) {
    discord.tomestone = config.tomestone;
  }

  if (discord.lodestone?.enabled) {
    console.log(
      `Initializing Lodestone client (language: ${discord.lodestone.language}, cacheTTL: ${discord.lodestone.cacheTTL})...`,
    );

    const cacheTTLms = parseDurationMs(discord.lodestone.cacheTTL, 6 * 60 * 60 * 1000);
    const maxCacheSize = discord.lodestone.maxCacheSize || 1000;

    let searchCooldownMs = parseDurationMs(discord.lodestone.searchCooldown, 10 * 60 * 1000);
    let globalCooldownMs = parseDurationMs(discord.lodestone.globalCooldown, 5 * 60 * 1000);

    const tomestoneClient = new TomestoneClient(discord.tomestone || {});
    discord.tomestoneClient = tomestoneClient;
    const lodestoneClient = new LodestoneClient(
      true,
      discord.lodestone.language,
      cacheTTLms,
      maxCacheSize,
      searchCooldownMs,
      globalCooldownMs,
      tomestoneClient,
    );

    const dbType = getEnvOrDefault('DATABASE_TYPE', '').trim().toLowerCase();
    const dbURL = getEnvOrDefault('DATABASE_URL', '').trim();
    if (dbType === 'postgres' && dbURL) {
      const store = new PostgresStore(dbURL);
      try {
        await store.init();
        lodestoneClient.setStore(store);
        tomestoneClient.setStore(store);
        tomestoneClient.startRefresh();
        console.log('Lodestone persistent store enabled.');
      } catch (err) {
        console.log(`Lodestone store disabled (DB init failed): ${err.message}`);
      }
    }

    lodestoneClient.startCacheCleanup();
    discord.lodestoneClient = lodestoneClient;

    console.log('Lodestone client initialized successfully.');
  } else {
    console.log('Lodestone integration is disabled in config.');
  }

  const client = await discord.start();

  client.on('interactionCreate', async (interaction) => {
    if (!discord.recruitmentManager) {
      return;
    }
    try {
      await discord.recruitmentManager.handleInteraction(interaction);
    } catch (err) {
      console.log(`Error handling interaction: ${err.message}`);
    }
  });

  await client.login(discordToken);
  await new Promise((resolve) => client.once('ready', resolve));

  const port = getEnvOrDefault('PORT', '8080');
  const healthServer = new HealthServer(port);
  healthServer.start().catch((err) => console.log(`Warning: Health server failed to start: ${err.message}`));

  const scraper = new Scraper('https://xivpf.com');
  if (discord.recruitmentChannels.length > 0 && discord.recruitmentManager) {
    discord.recruitmentManager.setScraper(scraper);
  }

  const marketboardClient = new MarketboardClient();

  if (discord.marketboardChannels.length > 0) {
    (async () => {
      console.log('Starting marketboard price tracker...');
      while (true) {
        const marketboardWait = 10 * 60 * 1000;
        console.log('Fetching marketboard prices...');

        let marketboardData;
        try {
          marketboardData = await marketboardClient.getLowestPrices();
        } catch (err) {
          console.log(`Marketboard error: ${err.message}`);
          await new Promise((resolve) => setTimeout(resolve, marketboardWait));
          continue;
        }

        console.log(`Got marketboard data for ${marketboardData.items.length} items.`);

        for (const channel of discord.marketboardChannels) {
          console.log(`Updating marketboard data for ${channel.name}...`);
          try {
            await discord.postMarketboardData(channel.id, marketboardData);
          } catch (err) {
            console.log(`Discord error updating marketboard channel ${channel.name}: ${err.message}`);
          }
        }

        console.log(`Marketboard update complete. Sleeping for ${marketboardWait}ms...`);
        await new Promise((resolve) => setTimeout(resolve, marketboardWait));
      }
    })();
  }

  if (discord.recruitmentChannels.length > 0 && discord.recruitmentManager) {
    console.log('Setting up recruitment channels...');
    for (const channel of discord.recruitmentChannels) {
      if (channel.type === 'menu') {
        console.log(`Sending recruitment menu to ${channel.name}...`);
        try {
          await discord.recruitmentManager.sendRecruitmentMenu(channel.id);
        } catch (err) {
          console.log(`Error sending recruitment menu to ${channel.name}: ${err.message}`);
        }
      }
    }
  }

  const runMainLoop = async () => {
    console.log('Starting findingway scraper for marketboard and PF listings...');
    while (true) {
      let totalWaitMs = 60 * 1000;
      console.log('Scraping source...');

      let listings;
      try {
        listings = await scraper.scrape();
      } catch (err) {
        console.log(`Scraper error: ${err.message}`);
        await new Promise((resolve) => setTimeout(resolve, totalWaitMs));
        continue;
      }

      console.log(`Got ${listings.listings.length} listings.`);

      if (discord.recruitmentManager) {
        discord.recruitmentManager.updateListings(listings);
      }

      console.log(`Sending to ${discord.channels.length} channels...`);

      for (const channel of discord.channels) {
        const startTime = Date.now();
        console.log(`Cleaning Discord for ${channel.name} (${channel.duty})...`);
        try {
          await discord.cleanChannel(channel.id);
        } catch (err) {
          console.log(`Discord error cleaning channel: ${err.message}`);
        }

        console.log(`Updating Discord for ${channel.name} (${channel.duty})...`);
        try {
          for (const dataCentre of channel.dataCentres || []) {
            await discord.postListings(channel.id, listings, channel.duty, dataCentre);
          }
        } catch (err) {
          console.log(`Discord error updating messages: ${err.message}`);
        }

        const duration = Date.now() - startTime;
        totalWaitMs -= duration;
      }

      if (once !== 'false') {
        process.exit(0);
      }

      if (totalWaitMs < 0) {
        totalWaitMs = 0;
      }
      console.log(`Sleeping for ${totalWaitMs}ms...`);
      await new Promise((resolve) => setTimeout(resolve, totalWaitMs));
    }
  };

  runMainLoop().catch((err) => console.error(err));

  const shutdown = async () => {
    console.log('\nShutting down gracefully...');
    try {
      await healthServer.stop();
    } catch (_) {
      // ignore
    }
    try {
      await client.destroy();
    } catch (_) {
      // ignore
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


