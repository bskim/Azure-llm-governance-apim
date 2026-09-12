import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ENTRA_ROLE_MAPPING,
  GOVERNANCE_ROLES,
  GovernanceAccessDeniedError,
  assertGovernanceCapability,
  assertRoleMapping,
  authorizeGovernanceAccess,
  readRoleMapping,
} from '../../app/governance-domain/authorization/admin-role-authorization.mjs';

const TEAMS = ['platform-engineering', 'developer-experience'];

test('an administrator may read everything and change budgets', () => {
  const authorization = authorizeGovernanceAccess({
    roles: ['Governance.Administer'],
    knownTeamKeys: TEAMS,
  });

  assert.deepEqual(authorization.permittedReadScopes, ['self', 'team', 'global']);
  assert.deepEqual(authorization.permittedTeamKeys, ['developer-experience', 'platform-engineering']);
  assert.deepEqual(authorization.governanceRoles, ['administer']);
  assertGovernanceCapability(authorization, 'write-budgets');
});

test('an auditor reads everything and changes nothing', () => {
  const authorization = authorizeGovernanceAccess({ roles: ['Governance.Read'], knownTeamKeys: TEAMS });

  assert.deepEqual(authorization.capabilities, ['read-governance']);
  for (const capability of ['write-budgets', 'write-entitlements', 'publish-configuration']) {
    assert.throws(() => assertGovernanceCapability(authorization, capability), {
      code: 'governance-capability-denied',
    });
  }
});

test('a gateway caller holds no governance role and is refused outright', () => {
  for (const roles of [undefined, [], ['Gateway.Access'], ['governance.administer']]) {
    assert.throws(() => authorizeGovernanceAccess({ roles, knownTeamKeys: TEAMS }), GovernanceAccessDeniedError);
  }
});

test('the refusal says whether a role was absent or merely unrecognized', () => {
  for (const [roles, reasonCode] of [
    [[], 'no-governance-role'],
    [['Something.Else'], 'governance-role-not-recognized'],
  ]) {
    try {
      authorizeGovernanceAccess({ roles });
      assert.fail('expected a denial');
    } catch (error) {
      assert.equal(error.reasonCode, reasonCode);
    }
  }
});

test('another provider names its roles differently and is configured, not coded', () => {
  const keycloak = { administer: ['llm-gov-admin'], read: ['llm-gov-auditor'] };

  const administrator = authorizeGovernanceAccess({
    roles: ['llm-gov-admin', 'unrelated-realm-role'],
    knownTeamKeys: TEAMS,
    roleMapping: keycloak,
  });
  assert.deepEqual(administrator.governanceRoles, ['administer']);
  assert.deepEqual(administrator.grantedRoles, ['llm-gov-admin']);
  assertGovernanceCapability(administrator, 'publish-configuration');

  // The Entra names carry no privilege once a deployment names its own.
  assert.throws(
    () => authorizeGovernanceAccess({ roles: ['Governance.Administer'], roleMapping: keycloak }),
    GovernanceAccessDeniedError,
  );
});

test('several claim values may mean the same governance role', () => {
  const mapping = { administer: ['admin', 'platform-admin'], read: ['auditor'] };

  for (const role of ['admin', 'platform-admin']) {
    assert.deepEqual(
      authorizeGovernanceAccess({ roles: [role], roleMapping: mapping }).governanceRoles,
      ['administer'],
    );
  }
});

test('a mapping that grants nothing is refused rather than deployed', () => {
  for (const mapping of [
    {},
    { administer: [], read: ['auditor'] },
    { administer: ['admin'] },
    { administer: ['admin'], read: [''] },
    { administer: ['admin'], read: 'auditor' },
    null,
  ]) {
    assert.throws(() => assertRoleMapping(mapping), TypeError);
  }
});

test('one claim value cannot mean two governance roles', () => {
  assert.throws(() => assertRoleMapping({ administer: ['staff'], read: ['staff'] }), /claimed by more than one/);
});

test('holding both roles grants the union rather than the lesser', () => {
  const authorization = authorizeGovernanceAccess({
    roles: ['Governance.Read', 'Governance.Administer'],
    knownTeamKeys: TEAMS,
  });

  assert.deepEqual(authorization.governanceRoles, ['administer', 'read']);
  assert.ok(authorization.capabilities.includes('write-budgets'));
});

test('the result is frozen so a handler cannot widen its own authorization', () => {
  const authorization = authorizeGovernanceAccess({ roles: ['Governance.Read'], knownTeamKeys: TEAMS });

  assert.equal(Object.isFrozen(authorization), true);
  assert.throws(() => authorization.capabilities.push('write-budgets'), TypeError);
});

test('team keys come from the server and are deduplicated and ordered', () => {
  const authorization = authorizeGovernanceAccess({
    roles: ['Governance.Read'],
    knownTeamKeys: ['b-team', 'a-team', 'b-team'],
  });

  assert.deepEqual(authorization.permittedTeamKeys, ['a-team', 'b-team']);
});

test('a malformed roles claim is refused rather than coerced', () => {
  assert.throws(() => authorizeGovernanceAccess({ roles: 'Governance.Administer' }), TypeError);
  assert.throws(() => authorizeGovernanceAccess({ roles: ['Governance.Read'], knownTeamKeys: 'x' }), TypeError);
});

test('an unconfigured deployment keeps the roles this repository provisions', () => {
  assert.deepEqual(readRoleMapping({}), ENTRA_ROLE_MAPPING);
});

test('a configured mapping is validated before it can grant anything', () => {
  const configured = readRoleMapping({
    GOVERNANCE_ROLE_MAPPING: JSON.stringify({ administer: ['ops-admin'], read: ['ops-read'] }),
  });
  assert.deepEqual(configured.administer, ['ops-admin']);

  assert.throws(() => readRoleMapping({ GOVERNANCE_ROLE_MAPPING: 'not json' }), /must be JSON/);
  assert.throws(
    () => readRoleMapping({ GOVERNANCE_ROLE_MAPPING: JSON.stringify({ administer: ['x'] }) }),
    TypeError,
  );
});

test('three governance roles exist, and only two of them can change anything', () => {
  assert.deepEqual(Object.keys(GOVERNANCE_ROLES), ['own', 'administer', 'read']);
  const writers = Object.entries(GOVERNANCE_ROLES).filter(([, role]) =>
    role.capabilities.some((capability) => capability.startsWith('write-') || capability.startsWith('publish-')),
  );
  assert.deepEqual(writers.map(([name]) => name), ['own', 'administer']);
});

test('administrators and owners can self-approve, but legacy abandonment is owner-only', () => {
  const holders = Object.entries(GOVERNANCE_ROLES)
    .filter(([, role]) => role.capabilities.includes('approve-own-configuration'))
    .map(([name]) => name);
  assert.deepEqual(holders, ['own', 'administer']);
  assert.deepEqual(Object.entries(GOVERNANCE_ROLES)
    .filter(([, role]) => role.capabilities.includes('abandon-legacy-configuration'))
    .map(([name]) => name), ['own']);
  const admin = authorizeGovernanceAccess({ roles: ['Governance.Administer'] });
  assertGovernanceCapability(admin, 'approve-own-configuration');
  assert.throws(() => assertGovernanceCapability(admin, 'abandon-legacy-configuration'),
    { code: 'governance-capability-denied' });
  assert.deepEqual(
    GOVERNANCE_ROLES.administer.capabilities.filter(
      (capability) => !GOVERNANCE_ROLES.own.capabilities.includes(capability),
    ),
    [],
  );
});
