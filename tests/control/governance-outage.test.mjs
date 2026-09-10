import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { projectUsageRollups } from '../../app/governance-domain/usage/usage-rollup-projector.mjs';
import { observePeriodConsumption } from '../../app/governance-domain/usage/period-consumption.mjs';
import { projectNotifications } from '../../app/control-api/notifications-read-model-projector.mjs';

test('the supported gateway fails closed when no effective policy can be resolved', () => {
  const gateway = readFileSync(new URL('../../infra/modules/gateway.bicep', import.meta.url), 'utf8');
  const policy = readFileSync(new URL('../../apim/policies/inference.xml', import.meta.url), 'utf8');

  assert.match(gateway, /name: 'allow-ungoverned-evaluation-mode'[\s\S]*?value: 'false'/);
  assert.match(gateway, /name: 'default-effective-policy'[\s\S]*?value: '\{\}'/);
  assert.doesNotMatch(gateway, /documentType: 'effective-policy'/);
  assert.match(
    policy,
    /allow-ungoverned-evaluation-mode}}", "true"[\s\S]*?default-effective-policy/,
  );
});

test('a window the ingestion could not read is published as degraded, not as no traffic', () => {
  const [document] = projectUsageRollups({
    rows: [],
    scopeGroupId: 'platform-engineering',
    windowStart: '2026-08-10T00:00:00.000Z',
    windowEnd: '2026-08-10T01:00:00.000Z',
    asOf: '2026-08-10T01:05:00.000Z',
    source: {
      state: 'unavailable',
      rowCount: 0,
      rowLimit: 500_000,
      revision: 'outage-1',
      ingestionLagSeconds: 300,
    },
  });

  assert.equal(document.completeness.state, 'degraded');
  assert.notEqual(document.completeness.reason, 'window-closed');
});

test('a budget period covering an outage reports the gap rather than a low total', () => {
  const [observation] = observePeriodConsumption({
    rollups: [
      {
        grain: 'organization',
        windowStart: '2026-08-10T00:00:00.000Z',
        windowEnd: '2026-08-10T01:00:00.000Z',
        completeness: { state: 'complete', reason: 'window-closed' },
        totals: { totalTokens: 100 },
      },
    ],
    periodStart: '2026-08-10T00:00:00.000Z',
    periodEnd: '2026-08-10T04:00:00.000Z',
    windowSeconds: 3600,
    scopes: [{ scope: 'organization', scopeKey: null }],
  });

  assert.equal(observation.completeness, 'partial');
  assert.equal(observation.windowsMissing, 3);
});

test('a notification store nobody could read publishes no counts at all', () => {
  const model = projectNotifications({
    authorization: {
      contractVersion: 'v1',
      readAuthority: 'authoritative',
      permittedReadScopes: ['global'],
      permittedTeamKeys: [],
      effectiveRoles: ['governance-admin'],
      reasonCode: 'authorized',
    },
    records: null,
    selection: { scope: 'global', teamKey: null, generatedAt: '2026-08-10T01:00:00.000Z' },
  });

  assert.equal(model.quality.state, 'unavailable');
  assert.equal(model.summary, null, 'a zero here would read as nothing outstanding');
});
