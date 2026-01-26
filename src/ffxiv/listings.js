const { Job } = require('./job');
const { Role, Roles } = require('./role');

class Slot {
  constructor() {
    this.roles = new Roles([]);
    this.job = new Job('Unknown');
    this.filled = false;
  }
}

class Listing {
  constructor() {
    this.dataCentre = '';
    this.id = '';
    this.pfCategory = '';
    this.duty = '';
    this.tags = '';
    this.tagsColor = '';
    this.description = '';
    this.minIL = '';
    this.creator = '';
    this.world = '';
    this.expires = '';
    this.updated = '';
    this.party = [];
  }

  partyDisplay() {
    return this.party
      .map((slot) => (slot.filled ? slot.job.emoji() : slot.roles.emoji()))
      .join(' ');
  }

  getExpires() {
    return this.expires;
  }

  getUpdated() {
    return this.updated;
  }

  getTags() {
    if (!this.tags || this.tags.length === 0) {
      return '_ _';
    }
    return this.tags;
  }

  getDescription() {
    return this.description;
  }

  expiresAt() {
    const now = Date.now();
    const expires = (this.expires || '').trim();

    if (!expires || expires === 'now') {
      return new Date(now);
    }
    if (expires === 'in a second') {
      return new Date(now + 1000);
    }
    if (expires === 'in a minute') {
      return new Date(now + 60 * 1000);
    }
    if (expires === 'in an hour') {
      return new Date(now + 60 * 60 * 1000);
    }

    const secondsMatch = expires.match(/in (\d+) seconds/);
    if (secondsMatch) {
      return new Date(now + parseInt(secondsMatch[1], 10) * 1000);
    }
    const minutesMatch = expires.match(/in (\d+) minutes/);
    if (minutesMatch) {
      return new Date(now + parseInt(minutesMatch[1], 10) * 60 * 1000);
    }
    const hoursMatch = expires.match(/in (\d+) hours/);
    if (hoursMatch) {
      return new Date(now + parseInt(hoursMatch[1], 10) * 60 * 60 * 1000);
    }

    throw new Error(`Failed to parse time ${this.expires}`);
  }

  updatedAt() {
    const now = Date.now();
    const updated = (this.updated || '').trim();

    if (!updated || updated === 'now') {
      return new Date(now);
    }
    if (updated === 'a second ago') {
      return new Date(now - 1000);
    }
    if (updated === 'a minute ago') {
      return new Date(now - 60 * 1000);
    }
    if (updated === 'an hour ago') {
      return new Date(now - 60 * 60 * 1000);
    }

    const secondsMatch = updated.match(/(\d+) seconds ago/);
    if (secondsMatch) {
      return new Date(now - parseInt(secondsMatch[1], 10) * 1000);
    }
    const minutesMatch = updated.match(/(\d+) minutes ago/);
    if (minutesMatch) {
      return new Date(now - parseInt(minutesMatch[1], 10) * 60 * 1000);
    }
    const hoursMatch = updated.match(/(\d+) hours ago/);
    if (hoursMatch) {
      return new Date(now - parseInt(hoursMatch[1], 10) * 60 * 60 * 1000);
    }

    throw new Error(`Failed to parse time ${this.updated}`);
  }

  getMemberCount() {
    return this.party.filter((slot) => slot.filled).length;
  }

  isFull() {
    return this.getMemberCount() >= 8;
  }

  getOpenRoles() {
    return this.party
      .filter((slot) => !slot.filled)
      .map((slot) => slot.roles.toString());
  }

  hasRole(role) {
    return this.party.some((slot) => !slot.filled && slot.roles.roles.includes(role));
  }

  getTimeUntilExpiry() {
    const expiresAt = this.expiresAt();
    return expiresAt.getTime() - Date.now();
  }

  isExpiringSoon(thresholdMs) {
    const remaining = this.getTimeUntilExpiry();
    return remaining > 0 && remaining <= thresholdMs;
  }

  getFormattedMemberCount() {
    return `${this.getMemberCount()}/8`;
  }

  matchesDuty(duties = []) {
    const listingDutyLower = (this.duty || '').toLowerCase();
    return duties.some((duty) => listingDutyLower.includes(String(duty).toLowerCase()));
  }

  getTagsList() {
    if (!this.tags) {
      return [];
    }
    return this.tags.split(', ');
  }

  hasTag(tag) {
    const tagLower = String(tag).toLowerCase();
    return this.getTagsList().some((t) => String(t).toLowerCase() === tagLower);
  }

  isPracticeParty() {
    return this.hasTag('Practice') || (this.description || '').toLowerCase().includes('practice');
  }

  isReclearParty() {
    const desc = (this.description || '').toLowerCase();
    return (
      this.hasTag('Duty Completion') ||
      this.hasTag('Loot') ||
      desc.includes('reclear') ||
      desc.includes('farm')
    );
  }

  getUniqueID() {
    return `${this.dataCentre}_${this.id}_${this.creator}`;
  }
}

class Listings {
  constructor() {
    this.listings = [];
  }

  forDutyAndDataCentre(duty, dataCentre) {
    const filtered = new Listings();
    filtered.listings = this.listings.filter((l) => l.duty === duty && l.dataCentre === dataCentre);
    return filtered;
  }

  mostRecentUpdated() {
    let mostRecent = null;
    let mostRecentUpdated = new Date(0);

    for (const listing of this.listings) {
      const updatedAt = listing.updatedAt();
      if (updatedAt > mostRecentUpdated) {
        mostRecentUpdated = updatedAt;
        mostRecent = listing;
      }
    }

    return mostRecent;
  }

  updatedWithinLast(durationMs) {
    const now = Date.now();
    const filtered = new Listings();
    filtered.listings = this.listings.filter((listing) => {
      const updatedAt = listing.updatedAt();
      return now - durationMs <= updatedAt.getTime();
    });
    return filtered;
  }

  add(listing) {
    if (this.listings.some((existing) => existing.id === listing.id)) {
      return;
    }
    this.listings.push(listing);
  }
}

module.exports = {
  Role,
  Roles,
  Job,
  Slot,
  Listing,
  Listings,
};


