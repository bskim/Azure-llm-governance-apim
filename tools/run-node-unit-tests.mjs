import { readdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testsRoot = path.join(repositoryRoot, 'tests');

// These suites require the Cosmos emulator and credentials prepared by
// tests/persistence/Test-CosmosIntegration.ps1. `npm test` is the unit-test entry
// point; the integration entry point owns setup, readiness, cleanup, and evidence.
export const INTEGRATION_TESTS = Object.freeze([
  'tests/persistence/cosmos-governance-store.integration.test.mjs',
  'tests/persistence/durability-recovery.test.mjs',
  'tests/persistence/stored-source-durability.test.mjs',
]);

function collectTests(directory, collected = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) collectTests(absolute, collected);
    else if (entry.isFile() && entry.name.endsWith('.test.mjs')) {
      collected.push(path.relative(repositoryRoot, absolute).split(path.sep).join('/'));
    }
  }
  return collected;
}

export function nodeUnitTestPaths() {
  const all = collectTests(testsRoot).sort();
  for (const integration of INTEGRATION_TESTS) {
    if (!all.includes(integration)) {
      throw new Error(`declared integration test is missing: ${integration}`);
    }
  }
  return all.filter((testPath) => !INTEGRATION_TESTS.includes(testPath));
}

export function runNodeUnitTests({ run = spawnSync } = {}) {
  const tests = nodeUnitTestPaths();
  if (tests.length === 0) throw new Error('no Node unit tests were discovered.');
  const result = run(process.execPath, ['--test', ...tests], {
    cwd: repositoryRoot,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) process.exitCode = runNodeUnitTests();
