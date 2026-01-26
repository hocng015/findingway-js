const Role = {
  DPS: 'DPS',
  Healer: 'Healer',
  Tank: 'Tank',
  Empty: 'Empty',
};

function rolesEqual(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((value, index) => value === b[index]);
}

class Roles {
  constructor(roles = []) {
    this.roles = roles;
  }

  emoji() {
    if (rolesEqual(this.roles, [Role.DPS])) {
      return '<:dps:1411018214812680375>';
    }
    if (rolesEqual(this.roles, [Role.Healer])) {
      return '<:healer:1411018085401497733>';
    }
    if (rolesEqual(this.roles, [Role.Tank])) {
      return '<:tank:1411017963741380689>';
    }
    if (rolesEqual(this.roles, [Role.DPS, Role.Healer])) {
      return '<:healerdps:1411061433218629662>';
    }
    if (rolesEqual(this.roles, [Role.DPS, Role.Tank])) {
      return '<:tankdps:1411061132738826280>';
    }
    if (rolesEqual(this.roles, [Role.Healer, Role.Tank])) {
      return '<:tankhealer:1411061702916575343>';
    }
    if (rolesEqual(this.roles, [Role.Healer, Role.Tank, Role.DPS])) {
      return '<:tankhealerdps:1411062576338698304>';
    }

    return '<:AnyRole:1411066540526276619>';
  }

  toString() {
    if (this.roles.length === 0) {
      return 'Any';
    }

    const roleNames = this.roles.map((role) => {
      switch (role) {
        case Role.Tank:
          return 'Tank';
        case Role.Healer:
          return 'Healer';
        case Role.DPS:
          return 'DPS';
        case Role.Empty:
          return 'Empty';
        default:
          return 'Unknown';
      }
    });

    return roleNames.join('/');
  }
}

module.exports = {
  Role,
  Roles,
};


