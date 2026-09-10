import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/**
 * A suite nobody runs is not a suite.
 *
 * The entry point lists its suites by name so a failure can say which one failed, and
 * that list is maintained by hand — so a new test file joins the repository already
 * passing and already unread. This check exists because that happened: the store
 * contract and its in-memory half sat outside the gate while the gate reported green.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const QUOTED_PATH = /'\.\\(tests\\[^']+)'/g;

function declaredIn(relativeFile) {
  const source = readFileSync(path.join(ROOT, relativeFile), 'utf8');
  return [...source.matchAll(QUOTED_PATH)].map((match) => match[1].replaceAll('\\', '/'));
}

async function testFiles(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await testFiles(full)));
    else if (entry.name.endsWith('.test.mjs')) found.push(path.relative(ROOT, full).replaceAll('\\', '/'));
  }
  return found;
}

function matches(file, pattern) {
  if (!pattern.includes('*')) return file === pattern;
  const expression = new RegExp(`^${pattern.split('*').map((part) => part.replaceAll(/[.+?^${}()|[\]\\]/g, String.raw`\$&`)).join('[^/]*')}$`);
  return expression.test(file);
}

test('every test file is run by some suite', async () => {
  const patterns = [
    ...declaredIn('tests/Test-Local.ps1'),
    // Emulator-backed suites are run by their own entry point, which the local gate
    // invokes only when a container runtime is available.
    ...declaredIn('tests/persistence/Test-CosmosIntegration.ps1'),
  ];

  const orphans = (await testFiles(path.join(ROOT, 'tests'))).filter(
    (file) => !patterns.some((pattern) => matches(file, pattern)),
  );

  assert.ok(patterns.length > 0, 'no declared suites were parsed, so an empty orphan list would prove nothing');
  assert.deepEqual(
    orphans,
    [],
    `these test files are not run by any suite: ${orphans.join(', ')}. Add each to tests/Test-Local.ps1.`,
  );
});

test('the pattern match is neither too narrow nor too wide', () => {
  assert.equal(matches('tests/ui/overview.test.mjs', 'tests/ui/*.test.mjs'), true);
  // A glob covering one directory must not absorb a file a level deeper.
  assert.equal(matches('tests/ui/nested/overview.test.mjs', 'tests/ui/*.test.mjs'), false);
  assert.equal(matches('tests/control/a.test.mjs', 'tests/control/b.test.mjs'), false);
  assert.equal(matches('tests/control/b.test.mjs', 'tests/control/b.test.mjs'), true);
});
