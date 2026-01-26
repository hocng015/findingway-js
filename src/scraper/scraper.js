const cheerio = require('cheerio');
const { Listings, Listing, Slot, Role, Roles, Job } = require('../ffxiv/listings');

class Scraper {
  constructor(url) {
    this.url = url;
  }

  async scrape() {
    const listings = new Listings();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    let html;
    try {
      const res = await fetch(`${this.url}/listings`, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${this.url}/listings`);
      }
      html = await res.text();
    } finally {
      clearTimeout(timeout);
    }

    const $ = cheerio.load(html);

    $('#listings.list .listing').each((_, element) => {
      const listing = new Listing();

      listing.dataCentre = $(element).attr('data-centre') || '';
      listing.pfCategory = $(element).attr('data-pf-category') || '';
      listing.id = $(element).attr('data-id') || '';

      listing.duty = $(element).find('.left .duty').text().trim();
      listing.tags = $(element).find('.left .description span').text().trim();
      listing.tagsColor = $(element).find('.left .description span').attr('class') || '';
      listing.minIL = $(element).find('.middle .stat .value').text().trim();
      listing.creator = $(element).find('.right .creator .text').text().trim();
      listing.world = $(element).find('.right .world .text').text().trim();
      listing.expires = $(element).find('.right .expires .text').text().trim();
      listing.updated = $(element).find('.right .updated .text').text().trim();

      let description = $(element).find('.left .description').text().trim();
      if (listing.tags) {
        description = description.replace(listing.tags, '').trim();
      }
      listing.description = description;

      listing.party = [];
      $(element)
        .find('.party .slot')
        .each((__, slotElem) => {
          const slot = new Slot();
          const className = $(slotElem).attr('class') || '';

          if (className.includes('dps')) {
            slot.roles.roles.push(Role.DPS);
          }
          if (className.includes('healer')) {
            slot.roles.roles.push(Role.Healer);
          }
          if (className.includes('tank')) {
            slot.roles.roles.push(Role.Tank);
          }
          if (className.includes('empty')) {
            slot.roles.roles.push(Role.Empty);
          }

          if (className.includes('filled')) {
            slot.filled = true;
            const title = $(slotElem).attr('title') || '';
            slot.job = Job.fromAbbreviation(title);
          }

          listing.party.push(slot);
        });

      listings.add(listing);
    });

    return listings;
  }
}

module.exports = {
  Scraper,
};


