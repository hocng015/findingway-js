const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { Job } = require('../ffxiv/job');
const { ColorHeader, ColorFresh, ColorNormal } = require('./colors');

class RecruitmentManager {
  constructor(discord) {
    this.discord = discord;
    this.scraper = null;
    this.listings = null;

    this.activeRecruitments = new Map();
    this.pendingRequests = new Map();
    this.selectedRolesCache = new Map();
    this.customMessageCache = new Map();
    this.listingCache = new Map();
  }

  setScraper(scraper) {
    this.scraper = scraper;
  }

  updateListings(listings) {
    console.log(`UpdateListings called, activeRecruitments has ${this.activeRecruitments.size} entries before check`);
    this.listings = listings;

    setTimeout(() => this.checkExpiredRecruitments(), 0);
    setTimeout(() => this.refreshRecruitmentPosts(), 0);
  }

  async checkExpiredRecruitments() {
    const expiredPosts = [];
    console.log(`checkExpiredRecruitments: Checking ${this.activeRecruitments.size} active recruitments`);

    for (const [messageId, post] of this.activeRecruitments.entries()) {
      const ageMs = Date.now() - post.createdAt.getTime();
      if (ageMs < 2 * 60 * 1000) {
        console.log(`checkExpiredRecruitments: Skipping recruitment ${messageId} (age: ${ageMs}ms, within grace period)`);
        continue;
      }

      let listingExists = false;
      if (this.listings) {
        for (const listing of this.listings.listings) {
          if (listing.id === post.listing.id) {
            listingExists = true;
            post.listing = listing;
            break;
          }
        }
      }

      if (!listingExists) {
        console.log(`checkExpiredRecruitments: PF listing ${post.listing.id} for recruitment ${messageId} has expired`);
        expiredPosts.push(post);
      }
    }

    console.log(`checkExpiredRecruitments: Found ${expiredPosts.length} expired posts to remove`);

    for (const post of expiredPosts) {
      await this.markRecruitmentExpired(post);
    }
  }
  async refreshRecruitmentPosts() {
    const posts = Array.from(this.activeRecruitments.values());

    for (const post of posts) {
      if (!post.listing) {
        continue;
      }

      const missingRoles = this.getMissingRoles(post.listing);
      const filled = Object.keys(missingRoles).length === 0;

      const [, embed] = await this.buildRecruitmentEmbed(
        post.guildId,
        post.listing,
        post.customMessage,
        post.selectedRoles,
        post.members,
        post.hostAvatar,
        filled,
      );
      if (!embed) {
        continue;
      }

      try {
        const channel = await this.discord.client.channels.fetch(post.channelId);
        const message = await channel.messages.fetch(post.messageId);
        await message.edit({ embeds: [embed] });
        console.log(`Refreshed recruitment embed for message ${post.messageId}`);
      } catch (err) {
        console.log(`Error refreshing recruitment ${post.messageId}: ${err.message}`);
      }

      if (filled && !post.filled) {
        post.filled = true;
        setTimeout(async () => {
          this.activeRecruitments.delete(post.messageId);
          try {
            const channel = await this.discord.client.channels.fetch(post.channelId);
            await channel.messages.delete(post.messageId);
            console.log(`Auto-deleted filled recruitment ${post.messageId}`);
          } catch (err) {
            console.log(`Error auto-deleting filled recruitment ${post.messageId}: ${err.message}`);
          }
        }, 30 * 1000);
      }
    }
  }

  async markRecruitmentExpired(post) {
    try {
      const channel = await this.discord.client.channels.fetch(post.channelId);
      await channel.messages.delete(post.messageId);
    } catch (err) {
      console.log(`Error deleting expired recruitment: ${err.message}`);
    }

    await this.sendHostNotification(
      post.hostUserId,
      `? **Your recruitment post has been automatically removed.**\n\n**Party:** ${post.listing.duty}\n\nThe Party Finder listing is no longer active in the game, so your recruitment post has been deleted.`,
    );

    for (const member of post.members) {
      await this.sendUserNotification(
        member.userId,
        `? **A party you joined has been removed.**\n\n**Party:** ${post.listing.duty}\n**Host:** <@${post.hostUserId}>\n\nThe Party Finder listing is no longer active.`,
      );
    }

    this.activeRecruitments.delete(post.messageId);
    console.log(`Removed recruitment ${post.messageId} from activeRecruitments, ${this.activeRecruitments.size} entries remaining`);
  }

  async handleInteraction(interaction) {
    if (interaction.isButton()) {
      return this.handleComponentInteraction(interaction);
    }
    if (interaction.isStringSelectMenu()) {
      return this.handleComponentInteraction(interaction);
    }
    if (interaction.isModalSubmit()) {
      return this.handleModalSubmit(interaction);
    }
    return null;
  }

  async handleComponentInteraction(interaction) {
    const customId = interaction.customId;
    console.log(`handleComponentInteraction called with customID: ${customId}`);

    if (customId === 'recruitment_create') {
      return this.handleCreateRecruitment(interaction);
    }
    if (customId === 'recruitment_delete') {
      return this.handleDeleteRecruitment(interaction);
    }
    if (customId === 'cancel_recruitment') {
      return this.handleCancelRecruitment(interaction);
    }

    if (customId.startsWith('role_select_')) {
      return this.handleRoleSelection(interaction);
    }
    if (customId.startsWith('confirm_recruitment_')) {
      return this.handleConfirmRecruitment(interaction);
    }
    if (customId.startsWith('continue_recruitment_')) {
      return this.handleContinueRecruitment(interaction);
    }
    if (customId.startsWith('join_pf_')) {
      return this.handleJoinRequest(interaction);
    }
    if (customId.startsWith('job_select_')) {
      return this.handleJobSelection(interaction);
    }
    if (customId.startsWith('leave_pf_')) {
      return this.handleLeaveRequest(interaction);
    }
    if (customId.startsWith('kick_member_')) {
      return this.handleKickMember(interaction);
    }
    if (customId.startsWith('approve_join_')) {
      return this.handleApproveJoin(interaction);
    }
    if (customId.startsWith('deny_join_')) {
      return this.handleDenyJoin(interaction);
    }

    console.log(`WARNING: Unhandled component interaction with customID: ${customId}`);
    return null;
  }
  async handleCreateRecruitment(interaction) {
    const member = interaction.member;
    const user = interaction.user;
    const userId = member?.user?.id || user?.id || '';
    const displayName = member?.nickname || member?.user?.username || user?.username || '';

    for (const post of this.activeRecruitments.values()) {
      if (post.hostUserId === userId) {
        await interaction.reply({
          content:
            '? **You already have an active recruitment post!**\n\nPlease delete your current recruitment post before creating a new one.\n\nUse the **Delete My Post** button to remove your active recruitment.',
          ephemeral: true,
        });
        return;
      }
    }

    await interaction.deferReply({ ephemeral: true });

    const initialMsg = `?? **Searching for your party listing...**\n\nLooking for active PF listings for **${displayName}**\n\nThis may take up to 1 minute...`;
    await interaction.editReply({ content: initialMsg, components: [] });

    this.searchAndCreateRecruitment(interaction, displayName).catch((err) => {
      console.log(`Error searching for recruitment: ${err.message}`);
    });
  }

  async searchAndCreateRecruitment(interaction, displayName) {
    const progress = `?? **Searching for your party listing...**\n\nPerforming a fresh search for **${displayName}**\n\n?? Please wait...`;
    await interaction.editReply({ content: progress });

    let userListing = null;
    if (this.scraper) {
      try {
        const freshListings = await this.scraper.scrape();
        this.listings = freshListings;
        userListing = this.findUserListingInListings(displayName, freshListings);
      } catch (err) {
        console.log(`Error performing fresh scrape: ${err.message}`);
        userListing = this.findUserListing(displayName);
      }
    } else {
      userListing = this.findUserListing(displayName);
    }

    if (!userListing) {
      const maxAttempts = 3;
      const searchInterval = 10 * 1000;

      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const dots = '.'.repeat((attempt % 3) + 1);
        const update = `?? **Searching for your party listing${dots}**\n\nLooking for active PF listings for **${displayName}**\n\n?? Attempt ${attempt + 1}/${maxAttempts}\n\n?? Tip: Make sure your Discord name matches your in-game character name!`;
        await interaction.editReply({ content: update });

        userListing = this.findUserListing(displayName);
        if (userListing) {
          break;
        }

        if (attempt < maxAttempts - 1) {
          await new Promise((resolve) => setTimeout(resolve, searchInterval));
        }
      }
    }

    if (!userListing) {
      const failMsg = `? **Could not find a party listing for ${displayName}**\n\nPlease make sure:\n You have an active party in the Party Finder\n Your Discord name matches your in-game character name\n Wait a few minutes for the bot to refresh its listings`;
      await interaction.editReply({ content: failMsg, components: [] });
      return;
    }

    this.listingCache.set(userListing.id, userListing);

    const successMsg = `? **Found your party!**\n\n**${userListing.duty}** - ${userListing.dataCentre}\n\nClick the button below to continue creating your recruitment post.`;

    const components = [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel('Continue to Customize')
          .setStyle(ButtonStyle.Success)
          .setCustomId(`continue_recruitment_${userListing.id}`),
        new ButtonBuilder().setLabel('Cancel').setStyle(ButtonStyle.Secondary).setCustomId('cancel_recruitment'),
      ),
    ];

    await interaction.editReply({ content: successMsg, components });
  }

  findUserListing(displayName) {
    return this.findUserListingInListings(displayName, this.listings);
  }

  findUserListingInListings(displayName, listings) {
    if (!listings) {
      return null;
    }
    const displayLower = displayName.toLowerCase();
    for (const listing of listings.listings) {
      const creatorLower = (listing.creator || '').toLowerCase();
      if (creatorLower.includes(displayLower) || displayLower.includes(creatorLower)) {
        return listing;
      }
    }
    return null;
  }

  async handleContinueRecruitment(interaction) {
    const listingId = interaction.customId.replace('continue_recruitment_', '');

    let listing = this.listingCache.get(listingId);
    if (!listing) {
      if (this.listings) {
        listing = this.listings.listings.find((l) => l.id === listingId);
      }
    }

    if (!listing) {
      await interaction.reply({
        content: '? Listing not found. It may have expired. Please try creating a new recruitment.',
        ephemeral: true,
      });
      return;
    }

    await this.showCustomMessageModal(interaction, listing);
  }

  async showCustomMessageModal(interaction, listing) {
    const modal = new ModalBuilder()
      .setCustomId(`recruitment_modal_${listing.id}`)
      .setTitle('Customize Your Recruitment Message');

    const input = new TextInputBuilder()
      .setCustomId('custom_message')
      .setLabel('Your Personal Message')
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('e.g., Looking for chill prog! Voice chat optional. LGBTQ+ friendly!')
      .setRequired(false)
      .setMaxLength(500);

    const row = new ActionRowBuilder().addComponents(input);
    modal.addComponents(row);

    await interaction.showModal(modal);
  }

  async handleModalSubmit(interaction) {
    const customId = interaction.customId;
    if (!customId.startsWith('recruitment_modal_')) {
      return;
    }

    const listingId = customId.replace('recruitment_modal_', '');
    const customMessage = interaction.fields.getTextInputValue('custom_message') || '';

    let listing = this.listingCache.get(listingId);
    if (!listing && this.listings) {
      listing = this.listings.listings.find((l) => l.id === listingId) || null;
    }

    if (!listing) {
      await interaction.reply({
        content: '? Listing not found. It may have expired. Please try creating a new recruitment.',
        ephemeral: true,
      });
      return;
    }

    await this.showRoleSelectionMessage(interaction, listing, customMessage);
  }
  async showRoleSelectionMessage(interaction, listing, customMessage) {
    const progressionRoles = this.getProgressionRoles(listing.duty, listing.tags);
    const missingRoles = this.getMissingRoles(listing);

    const options = [];
    const selectedValues = [];
    for (const roleName of Object.keys(missingRoles)) {
      options.push({
        label: roleName,
        value: roleName,
        description: `Ping players for ${roleName} role`,
        default: true,
      });
      selectedValues.push(roleName);
    }

    for (const role of progressionRoles) {
      options.push({
        label: role,
        value: role,
        description: `Ping players with the ${role} role`,
      });
    }

    options.push({
      label: 'Mercenary',
      value: 'Mercenary',
      description: 'Ping mercenaries willing to fill any role',
    });

    this.selectedRolesCache.set(listing.id, selectedValues);
    this.customMessageCache.set(listing.id, customMessage);

    const components = this.buildRoleSelectionComponents(listing, selectedValues);

    const previewEmbed = this.createPreviewEmbed(listing, customMessage, interaction);

    await interaction.reply({
      content: '**Preview of your recruitment post:**\n\n*Select roles to ping (optional), then click Create to post.*',
      embeds: [previewEmbed],
      components,
      ephemeral: true,
    });
  }

  createPreviewEmbed(listing, customMessage, interaction) {
    let avatarURL = '';
    if (interaction.member?.user) {
      avatarURL = interaction.member.user.displayAvatarURL({ size: 256 });
    } else if (interaction.user) {
      avatarURL = interaction.user.displayAvatarURL({ size: 256 });
    }

    const missingRoles = this.getMissingRoles(listing);

    let description = '**Party Finder Listing**\n';
    description += `?? **Data Center:** ${listing.dataCentre}  **World:** ${listing.world}\n\n`;

    if (customMessage) {
      description += `?? ${customMessage}\n\n`;
    }

    description += `**Party Composition:**\n${listing.partyDisplay()}\n\n`;

    if (Object.keys(missingRoles).length > 0) {
      description += '**Looking For:**\n';
      for (const [role, emoji] of Object.entries(missingRoles)) {
        description += `${emoji} ${role} needed!\n`;
      }
      description += '\n';
    }

    description += `**Tags:** ${this.formatTags(listing.getTags())}\n`;
    if (listing.description) {
      description += `**Description:** ${listing.description}\n`;
    }
    description += `\n? **Expires:** ${listing.expires}`;

    return new EmbedBuilder()
      .setTitle(`?? ${listing.duty} Recruitment`)
      .setDescription(description)
      .setColor(ColorNormal)
      .setThumbnail(avatarURL)
      .setFooter({ text: `Hosted by ${listing.creator}` });
  }

  getMissingRoles(listing) {
    let filledTanks = 0;
    let filledPureHealers = 0;
    let filledShieldHealers = 0;
    let filledMelee = 0;
    let filledCaster = 0;
    let filledPranged = 0;

    for (const slot of listing.party) {
      if (slot.filled) {
        const job = slot.job;
        switch (job.roleCategory()) {
          case 'Tank':
            filledTanks += 1;
            break;
          case 'Healer':
            if (job.healerType() === 'pure') {
              filledPureHealers += 1;
            } else if (job.healerType() === 'shield') {
              filledShieldHealers += 1;
            }
            break;
          case 'DPS':
            switch (job.dpsSubcategory()) {
              case 'melee':
                filledMelee += 1;
                break;
              case 'caster':
                filledCaster += 1;
                break;
              case 'pranged':
                filledPranged += 1;
                break;
              default:
                break;
            }
            break;
          default:
            break;
        }
      }
    }

    const neededTanks = 2 - filledTanks;
    const neededPureHealers = 1 - filledPureHealers;
    const neededShieldHealers = 1 - filledShieldHealers;
    const neededMelee = 2 - filledMelee;
    const neededCaster = 1 - filledCaster;
    const neededPranged = 1 - filledPranged;

    const missing = {};

    if (neededTanks > 0) {
      if (filledTanks === 0) {
        missing['Main Tank'] = '<:tank:1411017963741380689>';
        if (neededTanks === 2) {
          missing['Off Tank'] = '<:tank:1411017963741380689>';
        }
      } else if (filledTanks === 1) {
        missing['Off Tank'] = '<:tank:1411017963741380689>';
      }
    }

    if (neededPureHealers > 0) {
      missing['Pure Healer'] = '<:healer:1411018085401497733>';
    }
    if (neededShieldHealers > 0) {
      missing['Shield Healer'] = '<:healer:1411018085401497733>';
    }

    if (neededMelee > 0) {
      missing.Melee = '<:dps:1411018214812680375>';
    }
    if (neededCaster > 0) {
      missing.Caster = '<:dps:1411018214812680375>';
    }
    if (neededPranged > 0) {
      missing.Pranged = '<:dps:1411018214812680375>';
    }

    return missing;
  }
  determineRecruitmentChannel(duty) {
    const dutyLower = duty.toLowerCase();
    const isUltimate = dutyLower.includes('ultimate');

    for (const channel of this.discord.recruitmentChannels) {
      if (channel.type === 'ultimate' && isUltimate) {
        return channel.id;
      }
      if (channel.type === 'savage' && !isUltimate) {
        return channel.id;
      }
    }

    for (const channel of this.discord.recruitmentChannels) {
      if (channel.type !== 'menu') {
        return channel.id;
      }
    }

    return '';
  }

  getProgressionRoles(duty, tags) {
    const dutyLower = duty.toLowerCase();
    const tagsLower = (tags || '').toLowerCase();
    let roles = [];

    if (dutyLower.includes('dragonsong')) {
      roles = tagsLower.includes('duty completion') || tagsLower.includes('loot')
        ? ['DSR Cleared', 'DSR Reclear', 'DSR C4X']
        : [
            'DSR P7 Prog (Dragon King)',
            'DSR P6 Prog (Double Dragons)',
            'DSR P5 Prog (Thordan II)',
            'DSR P4 Prog (Eyes)',
            'DSR P3 Prog (Nidhogg)',
            'DSR P2 Prog (Thordan)',
            'DSR P1 Prog (Vault Knights)',
          ];
    } else if (dutyLower.includes('omega protocol')) {
      roles = tagsLower.includes('duty completion') || tagsLower.includes('loot')
        ? ['TOP Cleared', 'TOP Reclear', 'TOP C4X']
        : [
            'TOP P6 Prog (Alpha Omega)',
            'TOP P5 Prog (Run Dynamis)',
            'TOP P4 Prog (Blue Screen)',
            'TOP P3 Prog (Reconfigured)',
            'TOP P2 Prog (Omega-M/F)',
            'TOP P1 Prog (Omega)',
          ];
    } else if (dutyLower.includes('futures rewritten')) {
      roles = tagsLower.includes('duty completion') || tagsLower.includes('loot')
        ? ['FRU Cleared', 'FRU Reclear', 'FRU C4X']
        : [
            'FRU P5 Prog (Pandora)',
            'FRU P4 Prog (Shiva + Gaia)',
            'FRU P3 Prog (Oracle of Darkness)',
            'FRU P2 Prog (Usurper of Frost)',
            'FRU P1 Prog (Fatebreaker)',
          ];
    } else if (dutyLower.includes('epic of alexander')) {
      roles = tagsLower.includes('duty completion') || tagsLower.includes('loot')
        ? ['TEA Cleared', 'TEA Reclear', 'TEA C4X']
        : ['TEA P4 Prog (Perfect Alexander)', 'TEA P3 Prog (Alexander Prime)', 'TEA P2 Prog (BJ/CC)', 'TEA P1 Prog (Living Liquid)'];
    } else if (dutyLower.includes("weapon's refrain")) {
      roles = tagsLower.includes('duty completion') || tagsLower.includes('loot')
        ? ['UWU Cleared', 'UWU Reclear', 'UWU C4X']
        : ['UWU P4 Prog (Ultima)', 'UWU P3 Prog (Titan)', 'UWU P2 Prog (Ifrit)', 'UWU P1 Prog (Garuda)'];
    } else if (dutyLower.includes('unending coil')) {
      roles = tagsLower.includes('duty completion') || tagsLower.includes('loot')
        ? ['UCoB Cleared', 'UCoB Reclear', 'UCoB C4X']
        : [
            'UCoB P5 Prog (Golden Bahamut)',
            'UCoB P4 Prog (Adds)',
            'UCoB P3 Prog (Bahamut Prime)',
            'UCoB P2 Prog (Nael)',
            'UCoB P1 Prog (Twintania)',
          ];
    } else if (dutyLower.includes('heavyweight m4') || (dutyLower.includes('m4') && dutyLower.includes('savage'))) {
      roles = tagsLower.includes('duty completion') || tagsLower.includes('loot')
        ? ['M12S Cleared', 'M12S Reclear', 'M12S C4X']
        : ['M12S Prog'];
    } else if (dutyLower.includes('heavyweight m3') || (dutyLower.includes('m3') && dutyLower.includes('savage'))) {
      roles = tagsLower.includes('duty completion') || tagsLower.includes('loot')
        ? ['M11S Cleared', 'M11S Reclear', 'M11S C4X']
        : ['M11S Prog'];
    } else if (dutyLower.includes('heavyweight m2') || (dutyLower.includes('m2') && dutyLower.includes('savage'))) {
      roles = tagsLower.includes('duty completion') || tagsLower.includes('loot')
        ? ['M10S Cleared', 'M10S Reclear', 'M10S C4X']
        : ['M10S Prog'];
    } else if (dutyLower.includes('heavyweight m1') || (dutyLower.includes('m1') && dutyLower.includes('savage'))) {
      roles = tagsLower.includes('duty completion') || tagsLower.includes('loot')
        ? ['M9S Cleared', 'M9S Reclear', 'M9S C4X']
        : ['M9S Prog'];
    }

    return roles;
  }

  async handleRoleSelection(interaction) {
    const listingId = interaction.customId.replace('role_select_', '');
    const selectedValues = interaction.values;

    this.selectedRolesCache.set(listingId, selectedValues);
    let listing = this.listingCache.get(listingId);

    if (!listing && this.listings) {
      listing = this.listings.listings.find((l) => l.id === listingId) || null;
    }

    let components = [];
    if (listing) {
      components = this.buildRoleSelectionComponents(listing, selectedValues);
    }

    const content = interaction.message?.content || '';
    const embeds = interaction.message?.embeds || [];

    await interaction.update({ content, embeds, components });
  }

  async handleCancelRecruitment(interaction) {
    await interaction.update({
      content: '? Recruitment creation cancelled.',
      embeds: [],
      components: [],
    });
  }

  async handleConfirmRecruitment(interaction) {
    await interaction.deferUpdate();
    this.processRecruitmentCreation(interaction).catch((err) => {
      console.log(`Error creating recruitment: ${err.message}`);
    });
  }

  async processRecruitmentCreation(interaction) {
    const customId = interaction.customId;
    const parts = customId.split('_');
    if (parts.length < 3) {
      await interaction.editReply({
        content: '? Invalid recruitment data.',
        embeds: [],
        components: [],
      });
      return;
    }

    const listingId = parts[2];
    let listing = null;
    if (this.listings) {
      listing = this.listings.listings.find((l) => l.id === listingId) || null;
    }

    if (!listing) {
      await interaction.editReply({
        content: '? Listing not found. It may have expired.',
        embeds: [],
        components: [],
      });
      return;
    }

    const customMessage = this.customMessageCache.get(listingId) || '';
    const selectedRoles = this.selectedRolesCache.get(listingId) || [];

    this.selectedRolesCache.delete(listingId);
    this.customMessageCache.delete(listingId);
    this.listingCache.delete(listingId);

    try {
      await this.createRecruitmentPost(interaction, listing, customMessage, selectedRoles);
    } catch (err) {
      await interaction.editReply({
        content: `? Failed to create recruitment post: ${err.message}`,
        embeds: [],
        components: [],
      });
      return;
    }

    await interaction.editReply({
      content: '? Your recruitment post has been created!',
      embeds: [],
      components: [],
    });
  }

  async buildRecruitmentEmbed(guildId, listing, customMessage, selectedRoles, members, avatarURL, filled) {
    if (!listing) {
      return ['', null];
    }

    const missingRoles = this.getMissingRoles(listing);
    const roleMentions = [];
    let mentionContent = '';
    const displayRoles = [];

    const missingNames = Object.keys(missingRoles).sort();
    for (const roleName of missingNames) {
      const emoji = missingRoles[roleName];
      if (emoji) {
        displayRoles.push(`${emoji} ${roleName}`);
      } else {
        displayRoles.push(roleName);
      }
    }

    for (const roleName of selectedRoles) {
      let roleId = '';
      if (guildId) {
        try {
          roleId = await this.findOrCreateRole(guildId, roleName);
        } catch (err) {
          console.log(`Error finding/creating role ${roleName}: ${err.message}`);
        }
      }

      if (missingRoles[roleName] && roleId) {
        const mention = `${missingRoles[roleName]} <@&${roleId}>`;
        roleMentions.push(mention);
        mentionContent += `<@&${roleId}> `;
      } else if (roleId) {
        roleMentions.push(`<@&${roleId}>`);
        mentionContent += `<@&${roleId}> `;
      } else {
        roleMentions.push(roleName);
      }

      if (!missingRoles[roleName]) {
        displayRoles.push(roleMentions[roleMentions.length - 1]);
      }
    }

    let description = `?? **Data Center:** ${listing.dataCentre} ?? **World:** ${listing.world}\n\n`;

    if (customMessage) {
      description += `?? ${customMessage}\n\n`;
    }

    description += `**Party Composition:**\n${listing.partyDisplay()}\n\n`;

    if (members.length > 0) {
      description += '**Joined Members:**\n';
      for (const member of members) {
        description += ` **${member.username}** - ${member.job.emoji()} ${member.job.abbreviation()} (joined ${member.approvedAt})\n`;
      }
      description += '\n';
    }

    if (displayRoles.length > 0) {
      description += '**Looking For:**\n';
      description += displayRoles.join('  ');
      description += '\n\n';
    }

    description += `**Tags:** ${this.formatTags(listing.getTags())}\n`;

    if (listing.description) {
      description += `**Description:** ${listing.description}\n`;
    }

    description += `\n? **Expires:** ${listing.expires}`;

    let title = `?? ${listing.duty} Recruitment`;
    let color = ColorFresh;
    if (filled) {
      title = `? ${listing.duty} Recruitment (Filled)`;
      color = ColorNormal;
    }

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(description)
      .setColor(color)
      .setFooter({ text: `Hosted by ${listing.creator}` });

    if (avatarURL) {
      embed.setThumbnail(avatarURL);
    }

    return [mentionContent.trim(), embed];
  }
  async createRecruitmentPost(interaction, listing, customMessage, selectedRoles) {
    const guildId = interaction.guildId;

    let avatarURL = '';
    let userId = '';
    if (interaction.member?.user) {
      avatarURL = interaction.member.user.displayAvatarURL({ size: 256 });
      userId = interaction.member.user.id;
    } else if (interaction.user) {
      avatarURL = interaction.user.displayAvatarURL({ size: 256 });
      userId = interaction.user.id;
    }

    if (this.discord.lodestoneClient && this.discord.lodestoneClient.isEnabled() && listing) {
      const parsed = this.discord.parseListingCharacter(listing);
      const name = parsed.name;
      const world = parsed.world;
      console.log(`[Recruitment] Attempting to fetch Lodestone portrait for ${name} @ ${world}`);
      if (name && world) {
        try {
          const portraitUrl = await this.discord.lodestoneClient.getCharacterPortrait(name, world);
          if (portraitUrl) {
            console.log(`[Recruitment] Using Lodestone portrait for recruitment post: ${portraitUrl}`);
            avatarURL = portraitUrl;
          } else {
            console.log('[Recruitment] Using Discord avatar (Lodestone lookup failed or empty)');
          }
        } catch (_err) {
          console.log('[Recruitment] Using Discord avatar (Lodestone lookup failed)');
        }
      }
    } else {
      console.log('[Recruitment] Lodestone client unavailable, using Discord avatar');
    }

    const targetChannelId = this.determineRecruitmentChannel(listing.duty);
    if (!targetChannelId) {
      throw new Error('no appropriate recruitment channel configured for this duty type');
    }

    const [mentionContent, embed] = await this.buildRecruitmentEmbed(
      guildId,
      listing,
      customMessage,
      selectedRoles,
      [],
      avatarURL,
      false,
    );

    if (!embed) {
      throw new Error('failed to build recruitment embed');
    }

    const joinLeaveComponents = [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel('Join Party')
          .setStyle(ButtonStyle.Success)
          .setCustomId('join_pf_placeholder')
          .setEmoji('??'),
        new ButtonBuilder()
          .setLabel('Leave Party')
          .setStyle(ButtonStyle.Danger)
          .setCustomId('leave_pf_placeholder')
          .setEmoji('??'),
      ),
    ];

    const channel = await this.discord.client.channels.fetch(targetChannelId);
    const msg = await channel.send({
      content: mentionContent || undefined,
      embeds: [embed],
      components: joinLeaveComponents,
      allowedMentions: { parse: ['roles'] },
    });

    const recruitmentPost = {
      messageId: msg.id,
      channelId: targetChannelId,
      guildId,
      hostUserId: userId,
      hostAvatar: avatarURL,
      listing,
      members: [],
      customMessage,
      selectedRoles,
      createdAt: new Date(),
      filled: Object.keys(this.getMissingRoles(listing)).length === 0,
    };

    console.log(`Storing recruitment post with message ID: ${msg.id}, host: ${userId}`);

    this.activeRecruitments.set(msg.id, recruitmentPost);

    const updatedComponents = [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel('Join Party')
          .setStyle(ButtonStyle.Success)
          .setCustomId(`join_pf_${msg.id}`)
          .setEmoji('??'),
        new ButtonBuilder()
          .setLabel('Leave Party')
          .setStyle(ButtonStyle.Danger)
          .setCustomId(`leave_pf_${msg.id}`)
          .setEmoji('??'),
      ),
    ];

    await msg.edit({ components: updatedComponents });
  }

  async findOrCreateRole(guildId, roleName) {
    const guild = await this.discord.client.guilds.fetch(guildId);
    await guild.roles.fetch();
    const existing = guild.roles.cache.find((role) => role.name === roleName);
    if (existing) {
      return existing.id;
    }

    const newRole = await guild.roles.create({
      name: roleName,
      mentionable: true,
      color: 0x3498db,
    });
    return newRole.id;
  }

  async handleDeleteRecruitment(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const userId = interaction.member?.user?.id || interaction.user?.id || '';

    let foundPost = null;
    let foundMessageId = '';
    for (const [messageId, post] of this.activeRecruitments.entries()) {
      if (post.hostUserId === userId) {
        foundPost = post;
        foundMessageId = messageId;
        break;
      }
    }

    if (!foundPost) {
      await interaction.editReply({ content: "? You don't have an active recruitment post to delete." });
      return;
    }

    try {
      const channel = await this.discord.client.channels.fetch(foundPost.channelId);
      await channel.messages.delete(foundMessageId);
    } catch (err) {
      await interaction.editReply({
        content: '? Failed to delete recruitment post. It may have already been deleted.',
      });
      this.activeRecruitments.delete(foundMessageId);
      return;
    }

    this.activeRecruitments.delete(foundMessageId);
    await interaction.editReply({ content: '? Your recruitment post has been deleted.' });
  }

  formatTags(tags) {
    if (!tags) {
      return '*No tags*';
    }
    let result = tags;
    result = result.replaceAll('Duty Completion', 'Duty Completion ??');
    result = result.replaceAll('Duty Complete', 'Duty Complete ??');
    result = result.replaceAll('Loot', 'Loot ??');
    result = result.replaceAll('Practice', 'Practice ??');
    result = result.replaceAll('One Player per Job', 'One Player per Job ??');
    return result;
  }

  buildRoleSelectionComponents(listing, selectedValues) {
    const selectedSet = new Set(selectedValues || []);
    const options = [];

    for (const roleName of Object.keys(this.getMissingRoles(listing))) {
      options.push({
        label: roleName,
        value: roleName,
        description: `Ping players for ${roleName} role`,
        default: selectedSet.has(roleName),
      });
    }

    for (const role of this.getProgressionRoles(listing.duty, listing.tags)) {
      options.push({
        label: role,
        value: role,
        description: `Ping players with the ${role} role`,
        default: selectedSet.has(role),
      });
    }

    options.push({
      label: 'Mercenary',
      value: 'Mercenary',
      description: 'Ping mercenaries willing to fill any role',
      default: selectedSet.has('Mercenary'),
    });

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`role_select_${listing.id}`)
      .setPlaceholder('Select roles to ping (modify as needed)')
      .setMinValues(0)
      .setMaxValues(options.length)
      .addOptions(options);

    const row = new ActionRowBuilder().addComponents(selectMenu);
    const actionRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('? Create Recruitment Post')
        .setStyle(ButtonStyle.Success)
        .setCustomId(`confirm_recruitment_${listing.id}`),
      new ButtonBuilder().setLabel('? Cancel').setStyle(ButtonStyle.Danger).setCustomId('cancel_recruitment'),
    );

    return [row, actionRow];
  }

  parseCustomEmoji(emojiStr) {
    if (!emojiStr) {
      return { name: '', id: '' };
    }
    if (!emojiStr.startsWith('<')) {
      return { name: emojiStr, id: '' };
    }

    let trimmed = emojiStr.replace(/^</, '').replace(/>$/, '');
    trimmed = trimmed.replace(/^:/, '').replace(/^a:/, '');
    const parts = trimmed.split(':');
    if (parts.length < 2) {
      return { name: '', id: '' };
    }
    return { name: parts[0], id: parts[1] };
  }

  buildJobComponentEmoji(job) {
    const parsed = this.parseCustomEmoji(job.emoji());
    if (!parsed.name || !parsed.id) {
      return null;
    }
    return { name: parsed.name, id: parsed.id };
  }
  async handleJoinRequest(interaction) {
    console.log('handleJoinRequest called');
    const messageId = interaction.customId.replace('join_pf_', '');

    const post = this.activeRecruitments.get(messageId);
    if (!post) {
      await interaction.reply({ content: '? This recruitment post is no longer active.', ephemeral: true });
      return;
    }

    const userId = interaction.member?.user?.id || interaction.user?.id || '';
    let isOwner = false;
    if (interaction.guildId) {
      try {
        const guild = await this.discord.client.guilds.fetch(interaction.guildId);
        if (guild.ownerId === userId) {
          isOwner = true;
        }
      } catch (_err) {
        // ignore
      }
    }

    if (userId === post.hostUserId && !isOwner) {
      await interaction.reply({ content: "? You can't join your own party!", ephemeral: true });
      return;
    }

    if (post.members.some((member) => member.userId === userId)) {
      await interaction.reply({
        content: "? You've already joined this party! Use the Leave button if you want to leave.",
        ephemeral: true,
      });
      return;
    }

    const jobsByRole = Job.getAllJobs();
    const options = [];
    const roleOrder = ['Tank', 'Healer', 'Melee DPS', 'Ranged DPS', 'Caster DPS'];

    for (const role of roleOrder) {
      const jobs = jobsByRole[role] || [];
      for (const job of jobs) {
        options.push({
          label: job.abbreviation(),
          value: job.abbreviation(),
          description: role,
          emoji: this.buildJobComponentEmoji(job) || undefined,
        });
      }
    }

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`job_select_${messageId}`)
      .setPlaceholder('Select your job')
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(options);

    const row = new ActionRowBuilder().addComponents(selectMenu);

    await interaction.reply({
      content: '?? **Select the job you want to join with:**',
      components: [row],
      ephemeral: true,
    });
  }

  async handleJobSelection(interaction) {
    const messageId = interaction.customId.replace('job_select_', '');
    const values = interaction.values;
    if (!values || values.length === 0) {
      await interaction.reply({ content: '? No job selected.', ephemeral: true });
      return;
    }

    const jobAbbrev = values[0];
    const job = Job.fromAbbreviation(jobAbbrev);
    if (job.code === 'Unknown') {
      await interaction.reply({ content: '? Invalid job selected.', ephemeral: true });
      return;
    }

    const userId = interaction.member?.user?.id || interaction.user?.id || '';
    const username = interaction.member?.user?.username || interaction.user?.username || '';

    const post = this.activeRecruitments.get(messageId);
    if (!post) {
      await interaction.update({ content: '? This recruitment post is no longer active.', components: [] });
      return;
    }

    const dutyLower = post.listing.duty.toLowerCase();
    const isUltimateOrSavage = dutyLower.includes('ultimate') || dutyLower.includes('savage');

    let canJoin = false;
    let reason = '';

    if (isUltimateOrSavage) {
      [canJoin, reason] = this.validateUltimateSavageComposition(post, job);
    } else {
      [canJoin, reason] = this.validateStandardComposition(post, job);
    }

    if (!canJoin) {
      await interaction.update({
        content: `? Cannot join as ${job.emoji()} ${job.abbreviation()}\n\n${reason}`,
        components: [],
      });
      return;
    }

    const requestId = `${messageId}_${userId}_${Math.floor(Date.now() / 1000)}`;
    const request = {
      requestId,
      postMessageId: messageId,
      userId,
      username,
      job,
      hostUserId: post.hostUserId,
    };

    this.pendingRequests.set(requestId, request);
    await this.sendJoinRequestToHost(request, post);

    await interaction.update({
      content: `? Join request sent to the host as **${job.emoji()} ${job.abbreviation()}**!`,
      components: [],
    });
  }

  validateStandardComposition(post, job) {
    const roleCategory = job.roleCategory();
    let tankCount = 0;
    let healerCount = 0;
    let dpsCount = 0;

    for (const member of post.members) {
      switch (member.job.roleCategory()) {
        case 'Tank':
          tankCount += 1;
          break;
        case 'Healer':
          healerCount += 1;
          break;
        case 'DPS':
          dpsCount += 1;
          break;
        default:
          break;
      }
    }

    if (roleCategory === 'Tank' && tankCount >= 2) {
      const reason = `This party already has 2 tanks (max for standard party).\n\n**Current Party:**\n Tanks: ${tankCount}/2\n Healers: ${healerCount}/2\n DPS: ${dpsCount}/4`;
      return [false, reason];
    }
    if (roleCategory === 'Healer' && healerCount >= 2) {
      const reason = `This party already has 2 healers (max for standard party).\n\n**Current Party:**\n Tanks: ${tankCount}/2\n Healers: ${healerCount}/2\n DPS: ${dpsCount}/4`;
      return [false, reason];
    }
    if (roleCategory === 'DPS' && dpsCount >= 4) {
      const reason = `This party already has 4 DPS (max for standard party).\n\n**Current Party:**\n Tanks: ${tankCount}/2\n Healers: ${healerCount}/2\n DPS: ${dpsCount}/4`;
      return [false, reason];
    }

    if (roleCategory === 'Unknown') {
      return [false, 'Unknown job role.'];
    }

    return [true, ''];
  }

  validateUltimateSavageComposition(post, job) {
    let tankCount = 0;
    let pureHealerCount = 0;
    let shieldHealerCount = 0;
    let meleeCount = 0;
    let casterCount = 0;
    let prangedCount = 0;

    for (const member of post.members) {
      switch (member.job.roleCategory()) {
        case 'Tank':
          tankCount += 1;
          break;
        case 'Healer':
          if (member.job.healerType() === 'pure') {
            pureHealerCount += 1;
          } else if (member.job.healerType() === 'shield') {
            shieldHealerCount += 1;
          }
          break;
        case 'DPS':
          switch (member.job.dpsSubcategory()) {
            case 'melee':
              meleeCount += 1;
              break;
            case 'caster':
              casterCount += 1;
              break;
            case 'pranged':
              prangedCount += 1;
              break;
            default:
              break;
          }
          break;
        default:
          break;
      }
    }

    const showComposition = () =>
      `\n\n**Current Party:**\n Tanks: ${tankCount}/2\n Pure Healers: ${pureHealerCount}/1\n Shield Healers: ${shieldHealerCount}/1\n Melee DPS: ${meleeCount}/2\n Caster DPS: ${casterCount}/1\n Pranged DPS: ${prangedCount}/1\n\n*Note: 1 melee can be swapped for a caster ("fake melee")*`;

    switch (job.roleCategory()) {
      case 'Tank':
        if (tankCount >= 2) {
          return [false, `This party already has 2 tanks (max for Ultimate/Savage).${showComposition()}`];
        }
        return [true, ''];

      case 'Healer': {
        const healerType = job.healerType();
        if (healerType === 'pure' && pureHealerCount >= 1) {
          return [false, `This party already has 1 pure healer (max for Ultimate/Savage).${showComposition()}`];
        }
        if (healerType === 'shield' && shieldHealerCount >= 1) {
          return [false, `This party already has 1 shield healer (max for Ultimate/Savage).${showComposition()}`];
        }
        return [true, ''];
      }

      case 'DPS': {
        const dpsSubcat = job.dpsSubcategory();
        if (dpsSubcat === 'melee') {
          if (meleeCount >= 2) {
            return [false, `This party already has 2 melee DPS (max for Ultimate/Savage).${showComposition()}`];
          }
          if (meleeCount === 1 && casterCount === 2) {
            return [false, `This party already has 1 melee + 2 casters ("fake melee" composition). Cannot add another melee.${showComposition()}`];
          }
          return [true, ''];
        }

        if (dpsSubcat === 'caster') {
          if (casterCount >= 2) {
            return [false, `This party already has 2 casters (max for Ultimate/Savage, even with "fake melee").${showComposition()}`];
          }
          if (casterCount === 1 && meleeCount === 2) {
            return [false, `This party already has 2 melee + 1 caster. Cannot add another caster.${showComposition()}`];
          }
          return [true, ''];
        }

        if (dpsSubcat === 'pranged') {
          if (prangedCount >= 1) {
            return [false, `This party already has 1 pranged DPS (max for Ultimate/Savage).${showComposition()}`];
          }
          return [true, ''];
        }
        break;
      }

      default:
        break;
    }

    return [false, 'Unknown job role.'];
  }

  async handleLeaveRequest(interaction) {
    const messageId = interaction.customId.replace('leave_pf_', '');
    const post = this.activeRecruitments.get(messageId);
    if (!post) {
      await interaction.reply({ content: '? This recruitment post is no longer active.', ephemeral: true });
      return;
    }

    const userId = interaction.member?.user?.id || interaction.user?.id || '';
    let username = interaction.member?.user?.username || interaction.user?.username || '';
    if (interaction.member?.nickname) {
      username = interaction.member.nickname;
    }

    const memberIndex = post.members.findIndex((member) => member.userId === userId);
    if (memberIndex === -1) {
      await interaction.reply({ content: "? You haven't joined this party yet.", ephemeral: true });
      return;
    }

    const removedMember = post.members[memberIndex];
    post.members.splice(memberIndex, 1);

    await this.updateRecruitmentEmbed(post);

    await interaction.reply({ content: "? You've left the party.", ephemeral: true });

    await this.sendHostNotification(
      post.hostUserId,
      `?? **${username}** has left your **${post.listing.duty}** party.\n\n**Job:** ${removedMember.job.emoji()} ${removedMember.job.abbreviation()}`,
    );
  }

  async handleKickMember(interaction) {
    const messageId = interaction.customId.replace('kick_member_', '');
    const values = interaction.values;
    if (!values || values.length === 0) {
      await interaction.reply({ content: '? No member selected.', ephemeral: true });
      return;
    }

    const kickUserId = values[0];
    const post = this.activeRecruitments.get(messageId);
    if (!post) {
      await interaction.reply({ content: '? This recruitment post is no longer active.', ephemeral: true });
      return;
    }

    const requesterId = interaction.member?.user?.id || interaction.user?.id || '';
    if (requesterId !== post.hostUserId) {
      await interaction.reply({ content: '? Only the host can kick members from the party.', ephemeral: true });
      return;
    }

    const memberIndex = post.members.findIndex((member) => member.userId === kickUserId);
    if (memberIndex === -1) {
      await interaction.reply({ content: '? Member not found in party.', ephemeral: true });
      return;
    }

    const kickedMember = post.members[memberIndex];
    post.members.splice(memberIndex, 1);

    await this.updateRecruitmentEmbed(post);

    await interaction.reply({ content: `? **${kickedMember.username}** has been kicked from the party.`, ephemeral: true });

    await this.sendUserNotification(
      kickedMember.userId,
      `? **You have been removed from the party.**\n\n**Party:** ${post.listing.duty}\n**Your Job:** ${kickedMember.job.emoji()} ${kickedMember.job.abbreviation()}\n**Host:** <@${post.hostUserId}>\n\nYou were removed from this party by the host.`,
    );
  }

  async handleApproveJoin(interaction) {
    const requestId = interaction.customId.replace('approve_join_', '');

    const request = this.pendingRequests.get(requestId);
    if (!request) {
      await interaction.reply({ content: '? This request has expired or already been processed.', ephemeral: true });
      return;
    }

    const post = this.activeRecruitments.get(request.postMessageId);
    if (!post) {
      this.pendingRequests.delete(requestId);
      await interaction.reply({ content: '? The recruitment post is no longer active.', ephemeral: true });
      return;
    }

    const member = {
      userId: request.userId,
      username: request.username,
      job: request.job,
      approvedAt: `<t:${Math.floor(Date.now() / 1000)}:R>`,
    };

    post.members.push(member);

    await this.updateRecruitmentEmbed(post);

    await interaction.update({
      content: `? **Approved!** ${request.username} has been added to your party as ${request.job.emoji()} ${request.job.abbreviation()}.`,
      components: [],
    });

    await this.sendUserNotification(
      request.userId,
      `? **Your join request was approved!**\n\n**Party:** ${post.listing.duty}\n**Your Job:** ${request.job.emoji()} ${request.job.abbreviation()}\n**Host:** <@${post.hostUserId}>\n\nA spot has been saved for you in the party!`,
    );

    this.pendingRequests.delete(requestId);
  }

  async handleDenyJoin(interaction) {
    const requestId = interaction.customId.replace('deny_join_', '');

    const request = this.pendingRequests.get(requestId);
    if (!request) {
      await interaction.reply({ content: '? This request has expired or already been processed.', ephemeral: true });
      return;
    }

    const post = this.activeRecruitments.get(request.postMessageId);
    if (!post) {
      this.pendingRequests.delete(requestId);
      await interaction.reply({ content: '? The recruitment post is no longer active.', ephemeral: true });
      return;
    }

    await interaction.update({
      content: `? **Denied.** ${request.username}'s request to join as ${request.job.emoji()} ${request.job.abbreviation()} has been declined.`,
      components: [],
    });

    await this.sendUserNotification(
      request.userId,
      `? **Your join request was declined.**\n\n**Party:** ${post.listing.duty}\n**Requested Job:** ${request.job.emoji()} ${request.job.abbreviation()}\n**Host:** <@${post.hostUserId}>\n\nThe host has declined your request to join this party.`,
    );

    this.pendingRequests.delete(requestId);
  }
  async sendJoinRequestToHost(request, post) {
    try {
      const channel = await this.discord.client.users.createDM(request.hostUserId);
      const embed = new EmbedBuilder()
        .setTitle('?? New Join Request')
        .setDescription(`**${request.username}** wants to join your **${post.listing.duty}** party!\n\n**Job:** ${request.job.emoji()} ${request.job.abbreviation()}`)
        .setColor(0xffa500)
        .setFooter({ text: 'Click a button below to approve or deny this request' });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('Approve').setStyle(ButtonStyle.Success).setCustomId(`approve_join_${request.requestId}`),
        new ButtonBuilder().setLabel('Deny').setStyle(ButtonStyle.Danger).setCustomId(`deny_join_${request.requestId}`),
      );

      await channel.send({ embeds: [embed], components: [row] });
    } catch (err) {
      console.log(`Error sending join request to host: ${err.message}`);
    }
  }

  async sendHostNotification(hostUserId, message) {
    try {
      const channel = await this.discord.client.users.createDM(hostUserId);
      await channel.send(message);
    } catch (err) {
      console.log(`Error sending DM to host: ${err.message}`);
    }
  }

  async sendUserNotification(userId, message) {
    try {
      const channel = await this.discord.client.users.createDM(userId);
      await channel.send(message);
    } catch (err) {
      console.log(`Error sending DM to user: ${err.message}`);
    }
  }

  async updateRecruitmentEmbed(post) {
    let hostUser;
    try {
      hostUser = await this.discord.client.users.fetch(post.hostUserId);
    } catch (err) {
      throw err;
    }

    const avatarURL = hostUser.displayAvatarURL({ size: 256 });
    const missingRoles = this.getMissingRoles(post.listing);
    const roleMentions = [];

    for (const [roleName, emoji] of Object.entries(missingRoles)) {
      roleMentions.push(`${emoji} ${roleName}`);
    }

    let description = `?? **Data Center:** ${post.listing.dataCentre} ?? **World:** ${post.listing.world}\n\n`;

    if (post.customMessage) {
      description += `?? ${post.customMessage}\n\n`;
    }

    description += `**Party Composition:**\n${post.listing.partyDisplay()}\n\n`;

    if (post.members.length > 0) {
      description += '**Joined Members:**\n';
      for (const member of post.members) {
        description += ` **${member.username}** - ${member.job.emoji()} ${member.job.abbreviation()} (joined ${member.approvedAt})\n`;
      }
      description += '\n';
    }

    if (roleMentions.length > 0) {
      description += '**Looking For:**\n';
      description += roleMentions.join('  ');
      description += '\n\n';
    }

    description += `**Tags:** ${this.formatTags(post.listing.getTags())}\n`;

    if (post.listing.description) {
      description += `**Description:** ${post.listing.description}\n`;
    }

    description += `\n? **Expires:** ${post.listing.expires}`;

    const embed = new EmbedBuilder()
      .setTitle(`?? ${post.listing.duty} Recruitment`)
      .setDescription(description)
      .setColor(ColorFresh)
      .setThumbnail(avatarURL)
      .setFooter({ text: `Hosted by ${post.listing.creator}` });

    const components = [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel('Join Party')
          .setStyle(ButtonStyle.Success)
          .setCustomId(`join_pf_${post.messageId}`)
          .setEmoji('??'),
        new ButtonBuilder()
          .setLabel('Leave Party')
          .setStyle(ButtonStyle.Danger)
          .setCustomId(`leave_pf_${post.messageId}`)
          .setEmoji('??'),
      ),
    ];

    if (post.members.length > 0) {
      const kickOptions = post.members.map((member) => ({
        label: `${member.username} (${member.job.abbreviation()})`,
        value: member.userId,
        description: `Kick ${member.username} from the party`,
        emoji: this.buildJobComponentEmoji(member.job) || undefined,
      }));

      const kickMenu = new StringSelectMenuBuilder()
        .setCustomId(`kick_member_${post.messageId}`)
        .setPlaceholder('?? Host: Select member to kick')
        .addOptions(kickOptions)
        .setMinValues(1)
        .setMaxValues(1);

      components.push(new ActionRowBuilder().addComponents(kickMenu));
    }

    const channel = await this.discord.client.channels.fetch(post.channelId);
    const message = await channel.messages.fetch(post.messageId);
    await message.edit({ embeds: [embed], components });
  }

  async sendRecruitmentMenu(channelId) {
    const embed = new EmbedBuilder()
      .setTitle('?? PF Recruitment System (BETA)')
      .setDescription(
        'Create a personalized recruitment post for your Party Finder listing!\n\n' +
          '**?? NOTICE:**\n' +
          'This bot scrapes Party Finder data periodically and may not have the latest listings. ' +
          'If your PF listing is not found, please **retry creating your recruitment** until the correct listing appears.\n\n' +
          '**How it works:**\n' +
          '1?? Click **Create** to search for your active PF\n' +
          '2?? Customize your message and select roles to ping\n' +
          '3?? Your recruitment post will be created with your party details\n\n' +
          '**Features:**\n' +
          '? Automatically finds your in-game party listing\n' +
          '?? Add a personal message to your recruitment\n' +
          '?? Ping specific progression roles (DSR P7, TOP Reclear, etc.)\n' +
          '?? Shows your Discord profile picture\n' +
          '?? Pings missing roles (Tank, Healer, DPS)\n\n' +
          '**Note:** Make sure your Discord name matches your in-game character name!',
      )
      .setColor(ColorHeader)
      .setFooter({ text: 'FindingWay FFXIV Party Finder Bot' });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel('Create Recruitment Post').setStyle(ButtonStyle.Success).setCustomId('recruitment_create'),
      new ButtonBuilder().setLabel('Delete My Post').setStyle(ButtonStyle.Danger).setCustomId('recruitment_delete'),
    );

    const channel = await this.discord.client.channels.fetch(channelId);
    await channel.send({ embeds: [embed], components: [row] });
  }
}

module.exports = {
  RecruitmentManager,
};


