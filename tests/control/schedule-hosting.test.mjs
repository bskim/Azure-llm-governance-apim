import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDeployedDriftSchedule,
  createDeployedNotificationDispatcher,
  createDeployedNotificationSweeps,
  createDeployedRollupSchedule,
  MAXIMUM_BACKFILL_WINDOWS,
  ROLLUP_CONFIG,
  SCHEDULE_LEASE_SECONDS,
} from '../../app/functions/composition-root.mjs';
import { resolveOwnerCode, resolveStartedFrom } from '../../app/functions/schedule-configuration.mjs';
import { createNotificationLedger } from '../../app/control-api/notification-ledger.mjs';
import { createNotificationChannelRecord } from '../../app/governance-domain/notification/notification-channel.mjs';
import { createInMemoryGovernanceStore } from '../../app/persistence/in-memory-governance-store.mjs';

const WINDOW_MS = ROLLUP_CONFIG.windowSeconds * 1000;
const ALIGNED = new Date(Math.floor(Date.parse('2026-07-24T10:00:00.000Z') / WINDOW_MS) * WINDOW_MS).toISOString();

test('without a durable store there is no recovering schedule, and the deployment says so', () => {
  // A checkpoint in memory records what an instance owes to itself. Presenting that as
  // recovery would be a claim about restarts that nothing survives.
  for (const environment of [{}, { GOVERNANCE_STORE_ENDPOINT: 'https://example.invalid' }]) {
    assert.equal(createDeployedRollupSchedule(environment, { nowIso: () => ALIGNED }), null);
    assert.equal(createDeployedNotificationSweeps(environment, { nowIso: () => ALIGNED }), null);
    assert.equal(createDeployedDriftSchedule(environment, { nowIso: () => ALIGNED }), null);
  }
});

test('a deployment that names no provider compares against nothing rather than against zero', () => {
  // Drift is a disagreement between two sides. Treating an absent second side as a
  // window in which the provider served nothing would dispute every window there is,
  // and bury the real disagreements under them.
  const stored = {
    GOVERNANCE_STORE_ENDPOINT: 'https://example.invalid',
    GOVERNANCE_DATABASE_NAME: 'governance',
  };
  // The store has to be real enough to get past, or this asserts nothing about the
  // provider at all.
  assert.notEqual(createDeployedRollupSchedule(stored, { nowIso: () => ALIGNED }), null);

  assert.equal(createDeployedDriftSchedule(stored, { nowIso: () => ALIGNED }), null);
  assert.equal(
    createDeployedDriftSchedule({ ...stored, PROVIDER_ACCOUNT_RESOURCE_ID: '' }, { nowIso: () => ALIGNED }),
    null,
  );
});

test('a provider identifier that is not an account is refused rather than requested', () => {
  assert.throws(
    () =>
      createDeployedDriftSchedule(
        {
          GOVERNANCE_STORE_ENDPOINT: 'https://example.invalid',
          GOVERNANCE_DATABASE_NAME: 'governance',
          PROVIDER_ACCOUNT_RESOURCE_ID: 'an-account-name',
        },
        { nowIso: () => ALIGNED },
      ),
    TypeError,
  );
});

test('the start of the schedule is configuration, and must sit on a window boundary', () => {
  const clock = { nowIso: () => '2026-07-24T10:37:11.000Z' };

  const derived = resolveStartedFrom({}, clock, ROLLUP_CONFIG.windowSeconds);
  assert.equal(Date.parse(derived) % WINDOW_MS, 0, 'a derived start is aligned');

  assert.equal(
    resolveStartedFrom({ ROLLUP_STARTED_FROM: ALIGNED }, clock, ROLLUP_CONFIG.windowSeconds),
    ALIGNED,
  );
  for (const configured of ['2026-07-24T10:37:11.000Z', 'whenever']) {
    assert.throws(
      () => resolveStartedFrom({ ROLLUP_STARTED_FROM: configured }, clock, ROLLUP_CONFIG.windowSeconds),
      TypeError,
      configured,
    );
  }
});

test('two runners produce different owners, or the lease distinguishes nothing', () => {
  assert.notEqual(resolveOwnerCode({}), resolveOwnerCode({}));
  assert.equal(resolveOwnerCode({ WEBSITE_INSTANCE_ID: 'abc123' }), 'worker-abc123');
  assert.equal(
    resolveOwnerCode({ WEBSITE_INSTANCE_ID: 'has spaces and punctuation!' }).startsWith('worker-'),
    true,
    'an unusable platform value falls back rather than producing an invalid owner',
  );
});

test('the lease and the backfill cap are bounded rather than open', () => {
  // A lease longer than the window would stop the schedule for a whole period when a
  // runner dies; an uncapped backfill would let one outage produce an unbounded run.
  assert.ok(SCHEDULE_LEASE_SECONDS > 0 && SCHEDULE_LEASE_SECONDS <= ROLLUP_CONFIG.windowSeconds);
  assert.ok(Number.isSafeInteger(MAXIMUM_BACKFILL_WINDOWS) && MAXIMUM_BACKFILL_WINDOWS > 0);
});

test('a fixed webhook is validated at startup and is used only when no stored channel exists', async () => {
  const store = createInMemoryGovernanceStore();
  const environment = {
    NOTIFICATION_WEBHOOK_ENDPOINT: 'https://fixed.example.invalid/hooks/notification',
  };
  const created = [];
  const delivered = [];
  const createWebhookChannel = (options) => {
    created.push(options);
    return {
      channelCode: options.channelCode ?? 'operations-webhook',
      async send() {
        delivered.push(options.endpoint);
      },
    };
  };
  const dispatcher = createDeployedNotificationDispatcher(environment, { nowIso: () => ALIGNED }, {
    store,
    createWebhookChannel,
  });
  const ledger = createNotificationLedger({ store, scopeGroupId: ROLLUP_CONFIG.scopeGroupId });
  await ledger.raise([{
    key: 'notification|platform-engineering|budget-threshold-reached|budget-1|1|2026-07-01T00:00:00.000Z|organization||8000',
    kind: 'budget-threshold-reached',
    severity: 'warning',
    scope: 'organization',
    scopeKey: null,
    periodStart: '2026-07-01T00:00:00.000Z',
    raisedAt: '2026-07-24T09:00:00.000Z',
  }]);

  await dispatcher.dispatch({ now: ALIGNED });
  assert.deepEqual(created, [{ endpoint: environment.NOTIFICATION_WEBHOOK_ENDPOINT }]);
  assert.deepEqual(delivered, [environment.NOTIFICATION_WEBHOOK_ENDPOINT]);

  const storedEndpoint = 'https://stored.example.invalid/hooks/notification';
  await store.putNotificationChannel(
    createNotificationChannelRecord({
      scopeGroupId: ROLLUP_CONFIG.scopeGroupId,
      channelKind: 'slack',
      endpoint: storedEndpoint,
      updatedByCode: 'operator-1',
      at: ALIGNED,
    }),
    { ifMatch: null },
  );
  await ledger.raise([{
    key: 'notification|platform-engineering|budget-threshold-reached|budget-2|1|2026-07-01T00:00:00.000Z|organization||9000',
    kind: 'budget-threshold-reached',
    severity: 'warning',
    scope: 'organization',
    scopeKey: null,
    periodStart: '2026-07-01T00:00:00.000Z',
    raisedAt: '2026-07-24T09:01:00.000Z',
  }]);

  await dispatcher.dispatch({ now: '2026-07-24T10:00:00.000Z' });
  assert.deepEqual(delivered, [environment.NOTIFICATION_WEBHOOK_ENDPOINT, storedEndpoint]);
  assert.deepEqual(created.at(-1), {
    endpoint: storedEndpoint,
    channelKind: 'slack',
    channelCode: 'operations-slack',
  });

  assert.throws(
    () => createDeployedNotificationDispatcher(
      { NOTIFICATION_WEBHOOK_ENDPOINT: 'https://localhost/hooks/notification' },
      { nowIso: () => ALIGNED },
      { store },
    ),
    /inside the deployment/,
  );
});
