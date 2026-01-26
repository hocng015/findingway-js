const JOB_EMOJIS = {
  GNB: '<:GNB:1411014750535553024>',
  PLD: '<:PLD:1410947608796594216>',
  GLD: '<:GLD:1411074262931869828>',
  DRK: '<:DRK:1410972931298820269>',
  WAR: '<:WAR:1411014674094227649>',
  MRD: '<:MRD:1411074307664117821>',
  SCH: '<:SCH:1410972677698486363>',
  ACN: '<:ACN:1411070594631467200>',
  SGE: '<:SGE:1410972302744752218>',
  AST: '<:AST:1410972495930069004>',
  WHM: '<:WHM:1410947840233963525>',
  CNJ: '<:CNJ:1411074378527014983>',
  SAM: '<:SAM:1411015447926673468>',
  DRG: '<:DRG:1411015869772992623>',
  NIN: '<:NIN:1411015531837919323>',
  MNK: '<:MNK:1411015094954889362>',
  RPR: '<:RPR:1411015977042186301>',
  VPR: '<:VPR:1411014999853367316>',
  BRD: '<:BRD:1411016172421255198>',
  MCH: '<:MCH:1411016234870374470>',
  DNC: '<:DNC:1411016288871907338>',
  BLM: '<:BLM:1411016665159696394>',
  BLU: '<:BLU:1411017674586329108>',
  SMN: '<:SMN:1411017128332497011>',
  PCT: '<:PCT:1411016930579710073>',
  RDM: '<:RDM:1411017043083264010>',
  LNC: '<:LNC:1411069704390316034>',
  PUG: '<:PUG:1411069818819575969>',
  ROG: '<:ROG:1411070493674438696>',
  THM: '<:THM:1411070548414300170>',
  ARC: '<:ARC:1411075009278906470>',
  Unknown: '<:DOH:1411073434422612160>',
};

class Job {
  constructor(code) {
    this.code = code || 'Unknown';
  }

  static fromAbbreviation(abbrev) {
    if (!abbrev) {
      return new Job('Unknown');
    }
    const upper = String(abbrev).trim().toUpperCase();
    if (JOB_EMOJIS[upper]) {
      return new Job(upper);
    }
    return new Job('Unknown');
  }

  emoji() {
    return JOB_EMOJIS[this.code] || JOB_EMOJIS.Unknown;
  }

  abbreviation() {
    return this.code || 'Unknown';
  }

  roleCategory() {
    switch (this.code) {
      case 'GNB':
      case 'PLD':
      case 'GLD':
      case 'DRK':
      case 'WAR':
      case 'MRD':
        return 'Tank';
      case 'SCH':
      case 'ACN':
      case 'SGE':
      case 'AST':
      case 'WHM':
      case 'CNJ':
        return 'Healer';
      case 'SAM':
      case 'DRG':
      case 'NIN':
      case 'MNK':
      case 'RPR':
      case 'VPR':
      case 'LNC':
      case 'PUG':
      case 'ROG':
      case 'BRD':
      case 'MCH':
      case 'DNC':
      case 'ARC':
      case 'BLM':
      case 'BLU':
      case 'SMN':
      case 'PCT':
      case 'RDM':
      case 'THM':
        return 'DPS';
      default:
        return 'Unknown';
    }
  }

  healerType() {
    switch (this.code) {
      case 'WHM':
      case 'AST':
        return 'pure';
      case 'SCH':
      case 'SGE':
        return 'shield';
      default:
        return '';
    }
  }

  dpsSubcategory() {
    switch (this.code) {
      case 'SAM':
      case 'DRG':
      case 'NIN':
      case 'MNK':
      case 'RPR':
      case 'VPR':
        return 'melee';
      case 'BRD':
      case 'MCH':
      case 'DNC':
        return 'pranged';
      case 'BLM':
      case 'BLU':
      case 'SMN':
      case 'PCT':
      case 'RDM':
        return 'caster';
      default:
        return '';
    }
  }

  static getAllJobs() {
    return {
      Tank: ['GNB', 'PLD', 'DRK', 'WAR'].map((j) => new Job(j)),
      Healer: ['WHM', 'SCH', 'AST', 'SGE'].map((j) => new Job(j)),
      'Melee DPS': ['SAM', 'DRG', 'NIN', 'MNK', 'RPR', 'VPR'].map((j) => new Job(j)),
      'Ranged DPS': ['BRD', 'MCH', 'DNC'].map((j) => new Job(j)),
      'Caster DPS': ['BLM', 'SMN', 'RDM', 'PCT'].map((j) => new Job(j)),
    };
  }
}

module.exports = {
  Job,
};


