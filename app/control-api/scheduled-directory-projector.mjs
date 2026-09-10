import { projectDirectorySnapshot } from '../governance-domain/directory/directory-snapshot-projector.mjs';

/**
 * Keeps the stored directory reading current.
 *
 * The users-and-groups screen reads a stored snapshot, and until this existed nothing
 * wrote one, so a deployment could only ever answer `directory-snapshot-absent`. It is
 * a plain timer rather than a recovering schedule because a roster is a reading of the
 * present, not a series of windows: a run that did not happen has nothing to backfill,
 * it simply leaves the previous reading in place, ageing, which the projection already
 * reports as stale.
 */

function fail(message) {
  throw new TypeError(message);
}

export function createScheduledDirectoryProjector({
  store,
  readPublishedSnapshots,
  readGovernedDirectory,
  clock,
  scopeGroupId,
}) {
  if (typeof store?.putDirectorySnapshot !== 'function') fail('store is required.');
  if (typeof readPublishedSnapshots !== 'function') fail('readPublishedSnapshots is required.');
  if (typeof readGovernedDirectory !== 'function') fail('readGovernedDirectory is required.');
  if (typeof clock?.nowIso !== 'function') fail('clock is required.');
  if (typeof scopeGroupId !== 'string' || scopeGroupId.length === 0) fail('scopeGroupId is required.');

  return async function run() {
    const at = clock.nowIso();

    let snapshots;
    try {
      snapshots = await readPublishedSnapshots();
    } catch (error) {
      // Which groups are governed is stated by the published set. Without it there is
      // no roster to read, and reading every group in the tenant instead would be a
      // wider question than governance ever asked.
      return { outcome: 'skipped', reasonCode: error?.reasonCode ?? 'published-set-unavailable', at };
    }

    const teams = snapshots.entitlementSnapshot.teamCatalog ?? [];
    if (teams.length === 0) {
      return { outcome: 'skipped', reasonCode: 'no-governed-team', at };
    }

    let reading;
    try {
      // The tenant comes from the set that named the groups, not from a setting: a
      // deployment configured with one tenant and governing another would read the
      // wrong directory and say nothing about it.
      reading = await readGovernedDirectory({
        tenantId: snapshots.entitlementSnapshot.tenantId,
        teams,
      });
    } catch (error) {
      // An unreadable directory leaves the previous reading in place to age, which the
      // projection reports as stale. Writing a degraded snapshot over a good one would
      // replace an answer with the absence of one.
      return {
        outcome: 'unavailable',
        reasonCode: error?.code ?? 'directory-read-failed',
        // Which branch, and what the directory answered. A refusal by Graph and a fault
        // in this code otherwise produce the same word and neither can be acted on.
        failure: error?.name ?? 'Error',
        refusals: Array.isArray(error?.refusals) ? error.refusals : [],
        at,
      };
    }

    const document = projectDirectorySnapshot({
      groups: reading.groups,
      scopeGroupId,
      // The entitlement version is what decided which groups were read, so the reading
      // is stamped with it rather than with a version of its own.
      configurationVersion: `entitlement-${snapshots.entitlementSnapshot.version}`,
      observedAt: at,
      asOf: at,
      source: reading.source,
    });
    await store.putDirectorySnapshot(document);

    return {
      outcome: 'projected',
      reasonCode: document.completeness.reason ?? 'directory-read',
      completeness: document.completeness.state,
      groups: document.groups.length,
      users: document.users.length,
      refusals: reading.refusals ?? [],
      at,
    };
  };
}
