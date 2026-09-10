import assert from 'node:assert/strict';
import test from 'node:test';

import { projectAdminOverview } from '../../app/control-api/admin-read-model-projector.mjs';
import { getOverviewFixture } from '../../app/local-adapters/overview-fixtures.mjs';

const evaluationTime = '2026-07-24T10:00:00.000Z';

// Read authority and the entitlement decision are independent: a caller can be known
// and permitted while their model entitlement is unavailable.
function authorization(scopes = ['self', 'team', 'global'], decision = 'allow', readAuthority = scopes.length > 0 ? 'authoritative' : 'unavailable') {
  return {
    contractVersion: 'v1',
    decision,
    readAuthority,
    reasonCode: decision === 'unavailable' ? 'membership-evidence-stale' : 'most-restrictive-policy',
    permittedReadScopes: scopes,
    permittedTeamKeys: ['developer-experience', 'platform-engineering'],
  };
}

function context(status = 'complete', expiresAt = '2026-07-24T10:30:00.000Z') {
  return {
    memberships: {
      status,
      expiresAt,
      groups: [
        {
          groupId: 'group-governance-admin',
          membership: 'direct',
          authorizationRelevant: true,
        },
      ],
    },
  };
}

test('complete membership permits the global projection without exposing authority fields', () => {
  const readModel = projectAdminOverview({
    authorization: authorization(),
    fixture: getOverviewFixture('complete', { scope: 'global' }),
    selection: { scope: 'global', range: '24h', teamKey: null },
  });

  assert.equal(readModel.readModelVersion, 'overview.v2');
  assert.equal(readModel.selection.scope, 'global');
  assert.equal('viewer' in readModel, false);
  assert.equal('permissions' in readModel, false);
});

test('stale or expired membership cannot derive any projection', () => {
  for (const candidate of [
    context('stale', '2026-07-24T10:30:00.000Z'),
    context('complete', '2026-07-24T09:59:59.000Z'),
  ]) {
    for (const scope of ['self', 'global']) {
      assert.throws(
        () =>
          projectAdminOverview({
            authorization: authorization([], 'unavailable'),
            fixture: getOverviewFixture('complete', {
              scope,
              teamKey: scope === 'team' ? 'platform-engineering' : null,
            }),
            selection: {
              scope,
              range: '24h',
              teamKey: scope === 'team' ? 'platform-engineering' : null,
            },
          }),
        /membership-not-authoritative/,
      );
    }
  }
});

test('authoritative read scopes remain usable when model entitlement is unavailable', () => {
  const readModel = projectAdminOverview({
    authorization: authorization(['self', 'team', 'global'], 'unavailable'),
    fixture: getOverviewFixture('partial', { scope: 'global' }),
    selection: { scope: 'global', range: '24h', teamKey: null },
  });

  assert.equal(readModel.selection.scope, 'global');
  assert.equal(readModel.freshness.aggregation, 'partial');
});

test('team overview requires a canonical authorized team key', () => {
  const authority = {
    ...authorization(['self', 'team']),
    permittedTeamKeys: ['team-alpha'],
  };
  assert.throws(
    () => projectAdminOverview({
      authorization: authority,
      fixture: getOverviewFixture('complete', {
        scope: 'team',
        teamKey: 'platform-engineering',
      }),
      selection: {
        scope: 'team',
        range: '24h',
        teamKey: 'platform-engineering',
      },
    }),
    /team-scope-denied/,
  );
});