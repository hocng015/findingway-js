const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
} = require('discord.js');
const { RecruitmentManager } = require('./recruitment');
const { formatPrice } = require('../marketboard/marketboard');
const {
  ColorHeader,
  ColorUrgent,
  ColorFresh,
  ColorNormal,
  ColorPractice,
  FallbackThumbnailURL,
} = require('./colors');

class Discord {
  constructor(token) {
    this.token = token;
    this.client = null;
    this.channels = [];
    this.marketboardChannels = [];
    this.recruitmentChannels = [];
    this.lodestone = {
      enabled: false,
      language: 'en',
      cacheTTL: '6h',
      maxCacheSize: 1000,
      searchCooldown: '10m',
      globalCooldown: '5m',
    };
    this.recruitmentManager = null;
    this.lodestoneClient = null;
    this.tomestoneClient = null;

    this.pendingPortraits = new Map();
    this.portraitUpdaterStarted = false;
  }

  async start() {
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message],
    });

    this.client = client;

    if (this.lodestoneClient && this.lodestoneClient.isEnabled()) {
      this.startPortraitUpdater();
    }

    if (Array.isArray(this.recruitmentChannels) && this.recruitmentChannels.length > 0) {
      this.recruitmentManager = new RecruitmentManager(this);
    }

    return client;
  }

  async cleanChannel(channelId) {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !channel.messages) {
      throw new Error('Channel not found or does not support messages');
    }

    const messages = await channel.messages.fetch({ limit: 100 });
    if (messages.size > 0) {
      await channel.bulkDelete(messages, true).catch((err) => {
        console.log(`Could not bulk delete messages: ${err.message}`);
      });
    }

    for (const [id, pending] of this.pendingPortraits.entries()) {
      if (pending.channelId === channelId) {
        this.pendingPortraits.delete(id);
      }
    }
  }

  async postListings(channelId, listings, duty, dataCentre) {
    let scopedListings = listings.forDutyAndDataCentre(duty, dataCentre);

    const mostRecent = scopedListings.mostRecentUpdated();
    if (mostRecent) {
      const updatedAt = mostRecent.updatedAt();
      if (updatedAt.getTime() > Date.now() - 4 * 60 * 1000) {
        scopedListings = scopedListings.updatedWithinLast(4 * 60 * 1000);
      }
    }

    await this.sendHeader(channelId, duty, dataCentre, scopedListings.listings.length);

    for (const listing of scopedListings.listings) {
      const { thumbURL, name, world, cached } = await this.getListingThumbnailInfo(listing);
      const progressInfo = await this.getListingProgressInfo(listing);
      const embed = this.createListingEmbed(listing, thumbURL, progressInfo);
      const msg = await this.sendListingEmbed(channelId, embed);
      if (!cached && name && world) {
        this.queuePortraitUpdate(channelId, msg.id, embed, name, world);
      }
    }

    if (scopedListings.listings.length > 0) {
      await this.sendFooter(channelId);
    }
  }

  async sendHeader(channelId, duty, dataCentre, count) {
    const statusText = count === 0 ? 'No active listings' : `${count} active listings`;

    const embed = new EmbedBuilder()
      .setTitle(`${duty} Party Finder - ${dataCentre}`)
      .setColor(ColorHeader)
      .setDescription(statusText)
      .setFooter({ text: 'FindingWay FFXIV Party Finder Bot' });

    const channel = await this.client.channels.fetch(channelId);
    await channel.send({ embeds: [embed] });
  }

  createListingEmbed(listing, thumbURL, progressInfo) {
    const fields = [
      { name: 'Party', value: listing.partyDisplay(), inline: true },
      { name: 'Min IL', value: this.formatMinIL(listing.minIL), inline: true },
      { name: 'Tags', value: this.boxed(this.formatTags(listing.getTags())), inline: false },
    ];

    if (progressInfo) {
      fields.push({ name: 'Lead Progress', value: this.boxed(progressInfo), inline: false });
    }

    const description = this.truncateDescription(listing.description);
    if (description) {
      fields.push({
        name: 'Description',
        value: this.boxed(description),
        inline: false,
      });
    }

    const embed = new EmbedBuilder()
      .setTitle(this.buildListingTitle(listing))
      .setColor(this.getListingColor(listing))
      .addFields(fields)
      .setFooter({ text: `Duty: ${listing.duty} | Data Centre: ${listing.dataCentre}` });

    if (thumbURL) {
      embed.setThumbnail(thumbURL);
    }

    return embed;
  }

  buildListingTitle(listing) {
    let creator = (listing.creator || '').trim();
    const world = (listing.world || '').trim();
    if (!creator) {
      creator = 'Unknown';
    }
    if (!world || creator.includes('@')) {
      return creator;
    }
    return `${creator} @ ${world}`;
  }

  formatTags(tags) {
    if (!tags || tags.trim() === '_ _') {
      return 'No tags';
    }
    return tags;
  }

  formatMinIL(minIL) {
    if (!minIL || minIL.trim() === '') {
      return 'N/A';
    }
    const keycaps = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];
    return minIL
      .split('')
      .map((char) => {
        const digit = parseInt(char, 10);
        if (!isNaN(digit)) {
          return keycaps[digit];
        }
        return char;
      })
      .join('');
  }

  getListingColor(listing) {
    if (listing.isExpiringSoon(10 * 60 * 1000)) {
      return ColorUrgent;
    }

    const tags = listing.getTags().toLowerCase();
    if (tags.includes('practice')) {
      return ColorPractice;
    }

    try {
      const updatedAt = listing.updatedAt();
      if (Date.now() - updatedAt.getTime() <= 5 * 60 * 1000) {
        return ColorFresh;
      }
    } catch (_) {
      return ColorNormal;
    }

    return ColorNormal;
  }

  boxed(value) {
    const cleaned = this.sanitizeForBox(value || '');
    return `\`\`\`\n${cleaned}\n\`\`\``;
  }

  sanitizeForBox(value) {
    if (!value) {
      return '';
    }
    return value.replace(/```/g, "'''");
  }

  truncateDescription(description) {
    if (!description) {
      return 'No description';
    }

    let cleaned = description.replace(/[\n\r\t]/g, ' ');
    cleaned = cleaned.trim();
    return cleaned;
  }

  async sendFooter(_channelId) {
    return null;
  }

  async sendListingEmbed(channelId, embed) {
    const channel = await this.client.channels.fetch(channelId);
    return channel.send({ embeds: [embed] });
  }

  async getListingThumbnailInfo(listing) {
    if (!this.lodestoneClient || !this.lodestoneClient.isEnabled()) {
      console.log('[Lodestone] Client is nil or disabled, using fallback thumbnail');
      return { thumbURL: FallbackThumbnailURL, name: '', world: '', cached: true };
    }

    const { name, world } = this.parseListingCharacter(listing);
    if (!name || !world) {
      console.log(`[Lodestone] Missing character info (name: '${name}', world: '${world}'), using fallback`);
      return { thumbURL: FallbackThumbnailURL, name: '', world: '', cached: true };
    }

    if (this.tomestoneClient && this.tomestoneClient.isEnabled()) {
      // Try to get profile data (includes avatar and custom images)
      const id = await this.lodestoneClient.getCharacterId(name, world);
      if (id) {
        const profilePayload = await this.tomestoneClient.getProfileById(id);
        const tomestoneAvatar = this.tomestoneClient.getPreferredAvatar(profilePayload);
        if (tomestoneAvatar) {
          return { thumbURL: tomestoneAvatar, name, world, cached: true };
        }
      }
    }

    const cached = await this.lodestoneClient.getCharacterPortraitCached(name, world);
    if (cached.found) {
      if (cached.url) {
        return { thumbURL: cached.url, name, world, cached: true };
      }
      return { thumbURL: FallbackThumbnailURL, name, world, cached: true };
    }

    const negative = await this.lodestoneClient.isNegativeCached(name, world);
    if (negative) {
      return { thumbURL: FallbackThumbnailURL, name, world, cached: true };
    }

    console.log(`[Lodestone] Cache miss for ${name} @ ${world}, queuing background fetch...`);
    this.lodestoneClient.queueCharacterPortraitFetch(name, world);

    return { thumbURL: FallbackThumbnailURL, name, world, cached: false };
  }

  async getListingProgressInfo(listing) {
    if (!this.lodestoneClient || !this.lodestoneClient.isEnabled()) {
      return '';
    }
    if (!this.tomestoneClient || !this.tomestoneClient.isEnabled()) {
      return '';
    }

    const { name, world } = this.parseListingCharacter(listing);
    if (!name || !world) {
      return '';
    }

    // Use profile endpoint instead of activity endpoint (activity endpoint is unreliable)
    const id = await this.lodestoneClient.getCharacterId(name, world);
    if (!id) {
      return '';
    }

    const profilePayload = await this.tomestoneClient.getProfileById(id);
    if (!profilePayload) {
      return '';
    }

    return this.tomestoneClient.getDutyProgress(profilePayload, listing.duty) || '';
  }

  parseListingCharacter(listing) {
    if (!listing) {
      return { name: '', world: '' };
    }

    let creator = (listing.creator || '').trim();
    let creatorWorld = '';
    if (creator.includes(' @ ')) {
      const parts = creator.split(' @ ');
      creator = parts[0].trim();
      creatorWorld = parts[1]?.trim() || '';
      console.log(`[Lodestone] Parsed creator from '${listing.creator}' to just name '${creator}'`);
    }

    let world = this.normalizeWorld(listing.world);
    if (world && listing.world.includes(' @ ')) {
      console.log(`[Lodestone] Parsed world from '${listing.world}' to '${world}' (removed data center)`);
    }

    if (creatorWorld) {
      if (!world) {
        world = creatorWorld;
      } else if (world.toLowerCase() !== creatorWorld.toLowerCase()) {
        console.log(
          `[Lodestone] Creator/world mismatch for '${listing.creator}' (creator world '${creatorWorld}', listing world '${world}'); using creator world`,
        );
        world = creatorWorld;
      }
    }

    return { name: creator, world };
  }

  normalizeWorld(world) {
    if (!world) {
      return '';
    }
    let result = world.trim();
    if (result.includes(' @ ')) {
      result = result.split(' @ ')[0].trim();
    }
    const idx = result.indexOf(' (');
    if (idx > 0) {
      result = result.slice(0, idx).trim();
    }
    return result;
  }

  queuePortraitUpdate(channelId, messageId, embed, name, world) {
    if (!this.lodestoneClient || !this.lodestoneClient.isEnabled()) {
      return;
    }
    if (!name || !world || !embed) {
      return;
    }

    this.pendingPortraits.set(messageId, {
      channelId,
      messageId,
      embed,
      name,
      world,
      expiresAt: Date.now() + 4 * 60 * 1000,
    });
  }

  startPortraitUpdater() {
    if (this.portraitUpdaterStarted) {
      return;
    }
    this.portraitUpdaterStarted = true;
    setInterval(() => this.processPendingPortraits(), 5000);
  }

  async processPendingPortraits() {
    if (!this.lodestoneClient || !this.lodestoneClient.isEnabled()) {
      return;
    }

    const now = Date.now();
    const pending = [];
    for (const [id, entry] of this.pendingPortraits.entries()) {
      if (now > entry.expiresAt) {
        this.pendingPortraits.delete(id);
      } else {
        pending.push(entry);
      }
    }

    for (const p of pending) {
      const cached = await this.lodestoneClient.getCharacterPortraitCached(p.name, p.world);
      if (!cached.found || !cached.url) {
        continue;
      }

      const embed = EmbedBuilder.from(p.embed);
      embed.setThumbnail(cached.url);

      try {
        const channel = await this.client.channels.fetch(p.channelId);
        const message = await channel.messages.fetch(p.messageId);
        await message.edit({ embeds: [embed] });
        this.pendingPortraits.delete(p.messageId);
      } catch (err) {
        console.log(`[Lodestone] Error updating thumbnail for ${p.messageId}: ${err.message}`);
      }
    }
  }

  async postMarketboardData(channelId, data) {
    await this.cleanChannel(channelId);
    await this.sendMarketboardHeader(channelId, data.items.length);

    const sectionEmbed = new EmbedBuilder()
      .setTitle('🏆 Best HQ Deals Across All NA Servers')
      .setColor(0x00ff00)
      .setDescription('The cheapest HQ listing for each tracked item:');

    const channel = await this.client.channels.fetch(channelId);
    await channel.send({ embeds: [sectionEmbed] });

    for (const item of data.items) {
      if (item.listings.length > 0) {
        console.log(`[DEBUG] Sending cheapest embed for ${item.itemName} with icon: ${item.iconURL}`);
        await this.sendCheapestItemEmbed(channelId, item);
      }
    }

    for (const item of data.items) {
      if (item.listings.length > 0) {
        console.log(`[DEBUG] Sending detailed listings for ${item.itemName} with icon: ${item.iconURL}`);
        await this.sendItemListings(channelId, item);
      }
    }

    await this.sendMarketboardFooter(channelId);
  }

  async sendMarketboardHeader(channelId, itemCount) {
    const statusEmoji = itemCount === 0 ? '❌' : '✅';
    const statusText = itemCount === 0 ? 'No HQ marketboard data available' : `Tracking ${itemCount} items (HQ only)`;

    const embed = new EmbedBuilder()
      .setTitle('💰 FFXIV Marketboard HQ Prices • NA Regions')
      .setColor(0xffd700)
      .setDescription(`${statusEmoji} **${statusText}**`)
      .setFooter({ text: 'Showing HQ prices only' });

    const channel = await this.client.channels.fetch(channelId);
    await channel.send({ embeds: [embed] });
  }

  async sendCheapestItemEmbed(channelId, item) {
    if (item.listings.length === 0) {
      return;
    }

    const listing = item.listings[0];

    let embedColor = 0x00ff00;
    if (item.itemName.includes('Popcorn')) {
      embedColor = 0xffa500;
    } else if (item.itemName.includes('Strength')) {
      embedColor = 0xff0000;
    } else if (item.itemName.includes('Dexterity')) {
      embedColor = 0xc586c0;
    } else if (item.itemName.includes('Mind')) {
      embedColor = 0x0080ff;
    } else if (item.itemName.includes('Intelligence')) {
      embedColor = 0x6a5acd;
    }

    let titleEmoji = '📦';
    if (item.itemName.includes('Popcorn')) {
      titleEmoji = '🍿';
    } else if (item.itemName.includes('Gemdraught')) {
      titleEmoji = '🍯';
    }

    const description = `\`\`\`\n` +
      `💰 Price:    ${formatPrice(listing.price)} Gil ${listing.getQualityString()}\n` +
      `📦 Stack:    ${listing.getStackInfo()}\n` +
      `🌐 Location: ${listing.getLocationString()}\n` +
      `👤 Seller:   ${listing.sellerName}\n` +
      `\`\`\`\n` +
      `🕐 **Updated** ${listing.getUpdateTime()}`;

    const embed = new EmbedBuilder()
      .setTitle(`${titleEmoji} ${item.itemName}`)
      .setColor(embedColor)
      .setDescription(description);

    if (item.iconURL) {
      console.log(`[DEBUG] Adding thumbnail to embed: ${item.iconURL}`);
      embed.setThumbnail(item.iconURL);
    } else {
      console.log(`[WARNING] No icon URL for ${item.itemName}, skipping thumbnail`);
    }

    const channel = await this.client.channels.fetch(channelId);
    await channel.send({ embeds: [embed] });
  }

  async sendItemListings(channelId, item) {
    let displayListings = item.listings;
    if (displayListings.length > 5) {
      displayListings = displayListings.slice(0, 5);
    }

    let embedColor = 0x0066ff;
    if (item.itemName.includes('Popcorn')) {
      embedColor = 0xffa500;
    } else if (item.itemName.includes('Strength')) {
      embedColor = 0xff0000;
    } else if (item.itemName.includes('Dexterity')) {
      embedColor = 0xc586c0;
    } else if (item.itemName.includes('Mind')) {
      embedColor = 0x0080ff;
    } else if (item.itemName.includes('Intelligence')) {
      embedColor = 0x6a5acd;
    }

    let titleEmoji = '📦';
    if (item.itemName.includes('Popcorn')) {
      titleEmoji = '🍿';
    } else if (item.itemName.includes('Gemdraught')) {
      titleEmoji = '🍯';
    }

    const fields = [];
    displayListings.forEach((listing, index) => {
      let rankEmoji = `#${index + 1}`;
      if (index === 0) rankEmoji = '🥇';
      if (index === 1) rankEmoji = '🥈';
      if (index === 2) rankEmoji = '🥉';

      const fieldValue = `\`\`\`\n` +
        `💰 Price:    ${formatPrice(listing.price)} Gil ${listing.getQualityString()}\n` +
        `📦 Stack:    ${listing.getStackInfo()}\n` +
        `🌐 Location: ${listing.getLocationString()}\n` +
        `👤 Seller:   ${listing.sellerName}\n` +
        `\`\`\`\n` +
        `🕐 **Updated** ${listing.getUpdateTime()}`;

      fields.push({ name: `${rankEmoji} Rank ${index + 1}`, value: fieldValue, inline: false });
    });

    const embed = new EmbedBuilder()
      .setTitle(`${titleEmoji} ${item.itemName} - Top ${displayListings.length} HQ Listings`)
      .setColor(embedColor)
      .addFields(fields);

    if (item.iconURL) {
      console.log(`[DEBUG] Adding thumbnail to detailed listing: ${item.iconURL}`);
      embed.setThumbnail(item.iconURL);
    } else {
      console.log(`[WARNING] No icon URL for detailed listing of ${item.itemName}`);
    }

    const channel = await this.client.channels.fetch(channelId);
    await channel.send({ embeds: [embed] });
  }

  async sendMarketboardFooter(channelId) {
    const divider = '-'.repeat(50);
    const embed = new EmbedBuilder()
      .setColor(0xffd700)
      .setDescription(
        `${divider}\n` +
          '📝 **Note:** Only showing High Quality (HQ) items\n' +
          '📊 **Data:** Cross-server HQ pricing across all NA data centers\n' +
          '⚠️ **Warning:** Prices may have changed since last update\n' +
          '✨ **Quality:** All prices shown are for HQ items only\n' +
          `${divider}`,
      )
      .setFooter({ text: `Powered by Universalis API • HQ-only scan completed at ${new Date().toLocaleTimeString()}` });

    const channel = await this.client.channels.fetch(channelId);
    await channel.send({ embeds: [embed] });
  }
}

module.exports = {
  Discord,
};


