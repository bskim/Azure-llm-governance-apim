import assert from 'node:assert/strict';
import test from 'node:test';

import { createInMemoryGovernanceStore } from '../../app/persistence/in-memory-governance-store.mjs';
import {
  governanceSnapshotDocument,
} from '../../app/governance-domain/policy/governance-snapshot-document.mjs';
import { getDeterministicGovernanceSnapshots } from '../../app/local-adapters/deterministic-governance-snapshots.mjs';
import { runGovernanceStoreContract } from './governance-store-contract.mjs';

let sequence = 0;

runGovernanceStoreContract({
  label: 'in memory',
  store: createInMemoryGovernanceStore(),
  uniqueKey: () => {
    sequence += 1;
    return `pk1-mem-${String(sequence).padStart(28, '0')}`;
  },
});

test('an in-memory snapshot write rejects a legacy budget without an accounting basis', async () => {
  const snapshot = structuredClone(getDeterministicGovernanceSnapshots().budgetSnapshot);
  delete snapshot.budgets[0].accountingBasis;
  const document = governanceSnapshotDocument({
    scopeGroupId: 'platform-engineering',
    kind: 'budget',
    snapshot,
  });

  test('the in-memory store classifies every formerly valid legacy budget shape without activating it', async () => {
    const legacyCases = [
      ['supported-token-budget', () => {}, null],
      ['throttle-plus-quota', (budget, snapshot) => {
        snapshot.budgets.push({
          ...budget,
          budgetId: 'budget-organization-throttle',
          action: 'THROTTLE',
          thresholds: { tiers: [{ atBasisPoints: 8000, tierCode: 'tier-reduced' }] },
        });
      }, null],
      ['duplicate-quota-counter', (budget, snapshot) => {
        snapshot.budgets.push({
          ...budget,
          budgetId: 'budget-organization-daily',
          period: 'Daily',
        });
      }],
      ['zero-token-limit', (budget) => { budget.limit.amount = 0; }],
      ['subject-per-model', (budget) => {
        budget.scope = 'subject';
        budget.modelScope = 'per-model';
        budget.modelKey = 'coding-fast';
      }],
      ['application-per-model', (budget) => {
        budget.scope = 'application';
        budget.modelScope = 'per-model';
        budget.modelKey = 'coding-fast';
      }],
      ['all-models-with-model-key', (budget) => { budget.modelKey = 'coding-fast'; }],
      ['per-model-without-model-key', (budget) => { budget.modelScope = 'per-model'; }],
    ];

    for (const [name, mutate, expectedState = 'migration-required'] of legacyCases) {
      const snapshot = structuredClone(getDeterministicGovernanceSnapshots().budgetSnapshot);
      delete snapshot.budgets[0].accountingBasis;
      mutate(snapshot.budgets[0], snapshot);
      const document = governanceSnapshotDocument({
        scopeGroupId: 'platform-engineering',
        kind: 'budget',
        snapshot,
      });

      const store = createInMemoryGovernanceStore({
        initialPersistedGovernanceSnapshots: [document],
      });
      if (expectedState === null) {
        const hydrated = await store.readGovernanceSnapshot({
          scopeGroupId: 'platform-engineering',
          kind: 'budget',
          evaluationTime: '2026-07-24T10:00:00.000Z',
        });
        assert.ok(hydrated.document.snapshot.budgets.every(
          (budget) => budget.accountingBasis === 'apim-estimated-total-tokens',
        ));
      } else {
        await assert.rejects(
          () => store.readGovernanceSnapshot({
            scopeGroupId: 'platform-engineering',
            kind: 'budget',
            evaluationTime: '2026-07-24T10:00:00.000Z',
          }),
          (error) => error.code === 'legacy-budget-migration-required' &&
            error.migrationRequirements[0].legacyShape === name &&
            error.persistedSnapshot.budgets[0].budgetId === snapshot.budgets[0].budgetId,
          name,
        );
      }
    }
  });

  await assert.rejects(
    () => createInMemoryGovernanceStore().putGovernanceSnapshot(document, {
      ifMatch: null,
      evaluationTime: '2026-07-24T10:00:00.000Z',
    }),
    /accountingBasis/,
  );
});
