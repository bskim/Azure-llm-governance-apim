import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AUTHORED_POLICY_RETENTION_SECONDS } from '../../app/governance-domain/lifecycle/authored-policy-retention.mjs';
import { REGISTRY_CAPTURE_RETENTION_SECONDS } from '../../app/governance-domain/registry/registry-capture-retention.mjs';

const DOMAIN = fileURLToPath(new URL('../../app/governance-domain/', import.meta.url));

// Any default written as a number rather than the shared constant. Stated as a scan of
// the whole domain rather than a list of the modules that exist today, so a sixth edit
// module written next month is covered without anyone remembering to add it here.
const NUMERIC_DEFAULT = /retentionSeconds\s*=\s*[0-9]/;
const SHARED_DEFAULT = /retentionSeconds\s*=\s*AUTHORED_POLICY_RETENTION_SECONDS\b(?!\w)/;

function domainModules(prefix = '') {
  return readdirSync(join(DOMAIN, prefix), { withFileTypes: true }).flatMap((entry) =>
    (entry.isDirectory()
      ? domainModules(`${prefix}${entry.name}/`)
      : entry.name.endsWith('.mjs')
        ? [`${prefix}${entry.name}`]
        : []));
}

const withRetention = domainModules()
  .map((path) => ({ path, source: readFileSync(join(DOMAIN, path), 'utf8') }))
  .filter(({ source }) => source.includes('retentionSeconds ='));

test('the scan reaches the modules it is meant to guard', () => {
  // A regex sweep that matched nothing would report clean, so the subjects are named
  // once here — as a floor on what was read, not as the list the guard iterates.
  for (const expected of [
    'policy/budget-edit.mjs',
    'policy/fallback-plan-edit.mjs',
    'authorization/assignment-edit.mjs',
    'authorization/entitlement-edit.mjs',
    'authorization/team-catalog-edit.mjs',
  ]) {
    assert.ok(withRetention.some(({ path }) => path === expected), `${expected} was not scanned`);
  }
});

test('every authored-policy edit takes its window from the one shared constant', () => {
  const drifted = withRetention
    .filter(({ path }) => path !== 'registry/model-capture.mjs')
    .filter(({ source }) => NUMERIC_DEFAULT.test(source) || !SHARED_DEFAULT.test(source))
    .map(({ path }) => path);

  assert.deepEqual(drifted, [], 'these modules default a retention window of their own');
});

test('model capture takes its window from a declared registry constant', () => {
  const capture = withRetention.find(({ path }) => path === 'registry/model-capture.mjs');
  assert.ok(capture, 'registry/model-capture.mjs was not scanned');
  assert.doesNotMatch(capture.source, NUMERIC_DEFAULT);
  assert.match(capture.source, /retentionSeconds\s*=\s*REGISTRY_CAPTURE_RETENTION_SECONDS\b/);
  assert.equal(REGISTRY_CAPTURE_RETENTION_SECONDS, AUTHORED_POLICY_RETENTION_SECONDS);
});

test('the shared window is thirty days rather than an hour', () => {
  assert.equal(AUTHORED_POLICY_RETENTION_SECONDS, 30 * 24 * 3600);
});
