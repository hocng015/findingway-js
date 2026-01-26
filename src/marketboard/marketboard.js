const NA_DATA_CENTERS = ['Aether', 'Primal', 'Crystal', 'Dynamis'];

const TRACKED_ITEMS = [
  { id: 49234, name: 'Grade 4 Gemdraught of Strength' },
  { id: 49235, name: 'Grade 4 Gemdraught of Dexterity' },
  { id: 49238, name: 'Grade 4 Gemdraught of Mind' },
  { id: 49237, name: 'Grade 4 Gemdraught of Intelligence' },
  { id: 49240, name: 'Caramel Popcorn' },
];

class Listing {
  constructor() {
    this.itemID = 0;
    this.worldID = 0;
    this.worldName = '';
    this.dataCenter = '';
    this.quantity = 0;
    this.price = 0;
    this.isHQ = false;
    this.listingID = '';
    this.sellerName = '';
    this.updateTime = 0;
  }

  getQualityString() {
    return this.isHQ ? 'HQ' : 'NQ';
  }

  getStackInfo() {
    return this.quantity === 1 ? '1 item' : `${this.quantity} items`;
  }

  getLocationString() {
    return `${this.worldName} (${this.dataCenter} DC)`;
  }

  getUpdateTime() {
    return `<t:${this.updateTime}:R>`;
  }
}

class ItemData {
  constructor() {
    this.itemID = 0;
    this.itemName = '';
    this.iconURL = '';
    this.listings = [];
  }
}

class MarketboardData {
  constructor() {
    this.items = [];
    this.lastSync = new Date();
  }

  getCheapestListings() {
    const cheapest = {};
    for (const item of this.items) {
      if (item.listings.length > 0) {
        cheapest[item.itemName] = item.listings[0];
      }
    }
    return cheapest;
  }
}

class MarketboardClient {
  constructor() {
    this.baseURL = 'https://universalis.app/api/v2';
  }

  async getLowestPrices() {
    const result = new MarketboardData();
    result.lastSync = new Date();

    for (const item of TRACKED_ITEMS) {
      console.log(`Fetching HQ marketboard data for ${item.name} (ID: ${item.id})...`);
      try {
        const itemData = await this.getItemData(item);
        console.log(`[DEBUG] Icon URL for ${item.name}: ${itemData.iconURL}`);
        result.items.push(itemData);
        console.log(`Successfully fetched ${itemData.listings.length} HQ listings for ${item.name}`);
      } catch (err) {
        console.log(`Error fetching data for ${item.name}: ${err.message}`);
      }
    }

    console.log(`Got HQ marketboard data for ${result.items.length} items.`);
    return result;
  }

  async getItemData(item) {
    let allListings = [];

    for (const dc of NA_DATA_CENTERS) {
      try {
        const listings = await this.fetchListingsForDC(item.id, dc);
        listings.forEach((listing) => {
          listing.dataCenter = dc;
        });
        allListings = allListings.concat(listings);
      } catch (err) {
        console.log(`Error fetching listings for ${item.name} from ${dc}: ${err.message}`);
      }
    }

    allListings.sort((a, b) => a.price - b.price);

    if (allListings.length > 10) {
      allListings = allListings.slice(0, 10);
    }

    const iconURL = await this.getIconURL(item);

    const itemData = new ItemData();
    itemData.itemID = item.id;
    itemData.itemName = item.name;
    itemData.iconURL = iconURL;
    itemData.listings = allListings;

    return itemData;
  }

  async fetchListingsForDC(itemID, dataCenter) {
    const url = `${this.baseURL}/${dataCenter}/${itemID}`;
    console.log(`[DEBUG] Fetching from Universalis API: ${url}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    let res;
    try {
      res = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      const body = await res.text();
      console.log(`[DEBUG] API error response: ${body}`);
      throw new Error(`API returned status ${res.status}`);
    }

    const apiResponse = await res.json();
    console.log(`[DEBUG] Got ${apiResponse.listings.length} listings from ${dataCenter} for item ${itemID}`);

    const listings = [];
    let hqCount = 0;

    for (const l of apiResponse.listings) {
      if (!l.hq) {
        continue;
      }
      hqCount += 1;

      const listing = new Listing();
      listing.itemID = apiResponse.itemID;
      listing.worldName = l.worldName;
      listing.quantity = l.quantity;
      listing.price = l.pricePerUnit;
      listing.isHQ = l.hq;
      listing.listingID = l.listingID;
      listing.sellerName = l.retainerName;
      listing.updateTime = l.lastReviewTime;

      listings.push(listing);
    }

    console.log(`[DEBUG] Filtered to ${hqCount} HQ listings from ${dataCenter}`);
    return listings;
  }

  async verifyIconURL(url) {
    console.log(`[DEBUG] Verifying icon URL: ${url}`);
    try {
      const res = await fetch(url, { method: 'HEAD' });
      const isValid = res.ok;
      console.log(`[DEBUG] Icon URL ${url} status: ${res.status} (valid: ${isValid})`);
      if (!isValid && res.status === 404) {
        console.log(`[DEBUG] Icon not found at ${url}, trying alternative URLs...`);
      }
      return isValid;
    } catch (err) {
      console.log(`[DEBUG] Error checking icon URL ${url}: ${err.message}`);
      return false;
    }
  }

  async getIconURL(item) {
    const garlandURL = await this.getGarlandIconURL(item);
    if (garlandURL) {
      const ok = await this.verifyIconURL(garlandURL);
      if (ok) {
        console.log(`[DEBUG] Using Garland icon URL for ${item.name}: ${garlandURL}`);
        return garlandURL;
      }
      console.log(`[WARNING] Garland icon URL not accessible for ${item.name}: ${garlandURL}`);
    }

    const possibleURLs = [
      `https://universalis-ffxiv.github.io/universalis-assets/icon2x/${String(item.id).padStart(6, '0')}.png`,
      `https://universalis-ffxiv.github.io/universalis-assets/icon2x/${item.id}.png`,
      `https://xivapi.com/i/${Math.floor(item.id / 1000)}000/${String(item.id).padStart(6, '0')}.png`,
      `https://raw.githubusercontent.com/xivapi/classjob-icons/master/icons/${item.id}.png`,
    ];

    console.log(`[DEBUG] Trying fallback icon URLs for ${item.name} (ID: ${item.id}):`);
    for (const url of possibleURLs) {
      if (await this.verifyIconURL(url)) {
        console.log(`[DEBUG] Found working fallback icon URL: ${url}`);
        return url;
      }
    }

    const fallback = getFallbackIconURL(item);
    if (fallback) {
      console.log(`[WARNING] No working icon URL found for ${item.name} (ID: ${item.id}), using emoji fallback: ${fallback}`);
      return fallback;
    }

    console.log(`[WARNING] No working icon URL or fallback found for ${item.name} (ID: ${item.id})`);
    return '';
  }

  async getGarlandIconURL(item) {
    const garlandURL = `https://www.garlandtools.org/db/doc/item/en/3/${item.id}.json`;
    console.log(`[DEBUG] Fetching Garland icon data for ${item.name}: ${garlandURL}`);

    let res;
    try {
      res = await fetch(garlandURL);
    } catch (err) {
      console.log(`[WARNING] Failed to fetch Garland data for ${item.name}: ${err.message}`);
      return '';
    }

    if (!res.ok) {
      console.log(`[WARNING] Garland returned status ${res.status} for ${item.name}`);
      return '';
    }

    let body;
    try {
      body = await res.json();
    } catch (err) {
      console.log(`[WARNING] Failed to decode Garland response for ${item.name}: ${err.message}`);
      return '';
    }

    const iconURL = buildGarlandIconURL(body?.item?.icon);
    if (!iconURL) {
      console.log(`[WARNING] Garland icon not found or unrecognized for ${item.name}`);
    }

    return iconURL;
  }
}

function buildGarlandIconURL(iconRaw) {
  if (iconRaw === undefined || iconRaw === null) {
    return '';
  }

  if (typeof iconRaw === 'number') {
    return `https://www.garlandtools.org/files/icons/item/${iconRaw}.png`;
  }

  if (typeof iconRaw === 'string' && iconRaw.length > 0) {
    const trimmed = iconRaw.replace(/^\//, '');
    return `https://www.garlandtools.org/files/icons/item/${trimmed}.png`;
  }

  return '';
}

function getFallbackIconURL(item) {
  const lowerName = item.name.toLowerCase();
  const twemojiBase = 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72';

  if (lowerName.includes('gemdraught')) {
    return `${twemojiBase}/1f36f.png`;
  }
  if (lowerName.includes('popcorn')) {
    return `${twemojiBase}/1f37f.png`;
  }
  return '';
}

function formatPrice(price) {
  if (price >= 1000000) {
    return `${(price / 1000000).toFixed(1)}M`;
  }
  if (price >= 1000) {
    return `${(price / 1000).toFixed(1)}K`;
  }
  return `${price}`;
}

module.exports = {
  MarketboardClient,
  MarketboardData,
  ItemData,
  Listing,
  TRACKED_ITEMS,
  NA_DATA_CENTERS,
  formatPrice,
};


