import assert from 'node:assert/strict';
import { existsSync, globSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

import {
  isPublicSnapshotPath,
  selectPublicSnapshotPaths,
} from '../../tools/distribution/public-boundary-scan.mjs';
import {
  materializePublicSnapshot,
  readSnapshotCandidatePaths,
  assertReleaseBoundaryClean,
  createPublicSnapshot,
  scanMaterializedPublicSnapshot,
} from '../../tools/distribution/create-public-snapshot.mjs';
import {
  INTEGRATION_TESTS,
  nodeUnitTestPaths,
} from '../../tools/run-node-unit-tests.mjs';

const LOCAL_INSTRUCTION = ['.github', 'copilot-instructions.md'].join('/');
const DECISION_ROOT = ['docs', 'decisions', ''].join('/');
const TEST_WORKSPACE_ROOT = path.resolve('tests', 'distribution', '.test-work');
const TEST_WORKSPACE = path.join(TEST_WORKSPACE_ROOT, 'public-snapshot');

function resetFixture() {
  rmSync(TEST_WORKSPACE, { recursive: true, force: true });
  mkdirSync(TEST_WORKSPACE, { recursive: true });
}

function cleanupFixture() {
  rmSync(TEST_WORKSPACE, { recursive: true, force: true });
}

function fixtureRoot(...parts) {
  return path.join(TEST_WORKSPACE, ...parts);
}

// Working directories that no checkout publishes and that the boundary rules never need to see.
const UNWALKED_DIRECTORIES = new Set(['.git', 'node_modules', '.test-work', '.public-distribution']);

// The release inventory reads the git index, which is correct for production because a
// publisher only ships committed files. A test must also hold inside a materialized snapshot
// that carries no history, so it walks the working tree and lets the boundary rules select.
function readWorkspaceCandidatePaths(root) {
  const paths = [];
  const walk = (relative) => {
    const absolute = relative === '' ? root : path.join(root, relative);
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!UNWALKED_DIRECTORIES.has(entry.name)) walk(child);
      } else if (entry.isFile()) {
        paths.push(child);
      }
    }
  };
  walk('');
  return paths;
}

test('the public snapshot applies exact, directory, and filename-prefix exclusions', () => {
  const squadHeartbeat = ['.github', 'workflows', 'squad-heartbeat.yml'].join('/');
  const syncSquadLabels = ['.github', 'workflows', 'sync-squad-labels.yml'].join('/');
  const referenceSample = ['docs', 'reference-sample-diagram.md'].join('/');
  const reviewNotes = ['docs', 'review-notes.md'].join('/');
  const excluded = [
    LOCAL_INSTRUCTION,
    '.gitattributes',
    `${DECISION_ROOT}0001-routing-family.md`,
    '.github/./agents/squad.agent.md',
    './././.mcp.json',
    '.SQUAD/team.md',
    '.azure/deployment-plan.md',
    '.supply-chain-work/evidence/release-evidence.json',
    '.MCP.json',
    'Infra/C0.bicep',
    '.squad/agents/tester/history.md',
    '.squad-workstream',
    '.copilot/mcp-config.json',
    '.github/agents/squad.agent.md',
    squadHeartbeat,
    syncSquadLabels,
    referenceSample,
    reviewNotes,
    'docs/postmortems/release.md',
    'docs/release.evidence.json',
    'docs/release.postmortem.md',
    'docs/release.session.json',
    'provenance/supply-chain/release-evidence.json',
    'app/admin-ui/public/vendor/bundle.js',
    'local.code-workspace',
  ];
  const included = [
    '.github/workflows/test.yml',
    ['.github', 'workflows', 'squads-heartbeat.yml'].join('/'),
    ['.github', 'workflows', 'sync-squads-labels.yml'].join('/'),
    ['docs', 'reference-samples.md'].join('/'),
    ['docs', 'reviewer-guide.md'].join('/'),
    'docs/customer-guide.md',
    'docs/evidence-based-release-guide.md',
    'docs/session-management.md',
  ];

  for (const file of excluded) assert.equal(isPublicSnapshotPath(file), false, file);
  for (const file of included) assert.equal(isPublicSnapshotPath(file), true, file);
  assert.deepEqual(selectPublicSnapshotPaths([...excluded, ...included]), included.sort());
  assert.deepEqual(
    selectPublicSnapshotPaths(['./docs/./customer-guide.md', 'docs//customer-guide.md']),
    ['docs/customer-guide.md'],
  );
  assert.equal(isPublicSnapshotPath.length, 1, 'matching must not vary by host platform');
  for (const file of ['.SQUAD/team.md', '.MCP.json', 'Infra/C0.bicep']) {
    assert.equal(isPublicSnapshotPath(file), false, file);
  }

  assert.equal(isPublicSnapshotPath(LOCAL_INSTRUCTION), false);
  assert.equal(isPublicSnapshotPath('docs/decisions-notes.md'), true);

  assert.deepEqual(
    selectPublicSnapshotPaths([
      'README.md',
      'docs\\decisions\\0001-routing-family.md',
      LOCAL_INSTRUCTION,
      'README.md',
      'app/index.mjs',
    ]),
    ['README.md', 'app/index.mjs'],
  );
  assert.throws(() => isPublicSnapshotPath('../outside.txt'), /cannot leave/);
  assert.throws(() => isPublicSnapshotPath('C:\\outside.txt'), /must be relative/);
});

test('the public snapshot does not materialize internal gateway-adoption harnesses', () => {
  const internalHarnesses = [
    'infra/c0.bicep',
    'infra/modules/c0-adopted-gateway.bicep',
    'tests/c0/Test-C0AdoptionIac.ps1',
    'tools/c0/Invoke-C0RoutingCanary.ps1',
  ];
  assert.deepEqual(selectPublicSnapshotPaths(internalHarnesses), []);
});

test('official existing-APIM adoption artifacts are absent and excluded from public snapshots', () => {
  const removedArtifacts = [
    'infra/existing-adopt.bicep',
    'infra/modules/adopted-gateway.bicep',
    'infra/modules/adopted-gateway-composition.bicep',
    'infra/modules/adopted-gateway-observability.bicep',
    'tests/infra/Test-D2AdoptedGatewayWiring.ps1',
    'tests/infra/Test-D2AzurePreflight.ps1',
    'tests/infra/Test-D2OperationalSafety.ps1',
    'tests/infra/Test-D2PostAdoption.ps1',
    'tools/d2/Invoke-D2Adoption.ps1',
  ];

  for (const artifact of removedArtifacts) {
    assert.equal(existsSync(path.resolve(artifact)), false, `${artifact} must remain deleted`);
  }
  assert.deepEqual(selectPublicSnapshotPaths(removedArtifacts), []);
});

test('the materialized public snapshot lists only runner suites it contains', () => {
  resetFixture();
  const output = fixtureRoot('public-runner-output');
  try {
    const listedAtSource = spawnSync(
      'pwsh',
      ['-NoProfile', '-File', 'tests/Test-Local.ps1', '-PublicOnly', '-ListSuites'],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    assert.equal(listedAtSource.status, 0, listedAtSource.stderr);
    const sourceSuites = JSON.parse(listedAtSource.stdout);
    for (const c0DependentSuite of [
      'tests\\routing\\Test-ExistingToolCompatibility.ps1',
      'tests\\routing\\Test-RoutingCanaryRunner.ps1',
    ]) {
      assert.equal(sourceSuites.powerShell.includes(c0DependentSuite), false);
    }
    const suitePaths = [...sourceSuites.powerShell, ...sourceSuites.node].flatMap((suite) => (
      suite.includes('*')
        ? globSync(suite.replaceAll('\\', '/'), { cwd: process.cwd(), nodir: true })
        : [suite.replaceAll('\\', '/')]
    ));
    for (const suite of suitePaths) {
      assert.equal(isPublicSnapshotPath(suite), true, `public runner listed excluded suite ${suite}`);
    }

    const snapshot = materializePublicSnapshot({
      root: process.cwd(),
      output,
      paths: ['tests/Test-Local.ps1', ...suitePaths],
    });
    assert.ok(snapshot.files.includes('tests/Test-Local.ps1'));
    assert.equal(snapshot.files.some((file) => file.startsWith('tests/c0/')), false);

    const listed = spawnSync(
      'pwsh',
      ['-NoProfile', '-File', 'tests/Test-Local.ps1', '-PublicOnly', '-ListSuites'],
      { cwd: output, encoding: 'utf8' },
    );
    assert.equal(listed.status, 0, listed.stderr);
    const suites = JSON.parse(listed.stdout);
    for (const suite of [...suites.powerShell, ...suites.node]) {
      assert.equal(suite.includes('tests\\c0\\'), false, `public runner listed internal suite ${suite}`);
      assert.equal(existsSync(path.join(output, suite.replaceAll('\\', path.sep))), true, `missing ${suite}`);
    }
  } finally {
    cleanupFixture();
  }
});

test('a public suite passes at the source and inside the materialized snapshot', () => {
  resetFixture();
  const output = fixtureRoot('public-contract-output');
  try {
    // A suite that reads an excluded internal template passes wherever that template exists and
    // fails for every public consumer. Only running the same suite inside a materialized snapshot
    // tells the two apart, so the inventory is walked from the working tree rather than the git
    // index: it stays valid in a public clone that carries no history and it includes candidates
    // that are not committed yet.
    const snapshot = materializePublicSnapshot({
      root: process.cwd(),
      output,
      paths: readWorkspaceCandidatePaths(process.cwd()),
    });
    for (const excluded of ['infra/modules/c0-adopted-gateway.bicep', 'infra/c0-policy-upgrade.bicep']) {
      assert.equal(snapshot.files.includes(excluded), false, `${excluded} must stay out of the snapshot`);
      assert.equal(
        existsSync(path.join(output, ...excluded.split('/'))),
        false,
        `${excluded} must be absent from the materialized snapshot`,
      );
    }

    const runContract = (cwd) => spawnSync(
      'pwsh',
      ['-NoProfile', '-File', 'tests/infra/Test-IacContract.ps1', '-PublicOnly'],
      { cwd, encoding: 'utf8' },
    );
    const atSource = runContract(process.cwd());
    assert.equal(
      atSource.status,
      0,
      `the published infrastructure contract suite must pass at the source: ${atSource.stderr}`,
    );
    const inSnapshot = runContract(output);
    assert.equal(
      inSnapshot.status,
      0,
      `the published infrastructure contract suite must pass inside the snapshot: ${inSnapshot.stderr}`,
    );
  } finally {
    cleanupFixture();
  }
});

test('materialization copies only selected regular files into a new empty location', () => {
  resetFixture();
  const root = fixtureRoot('source');
  const output = fixtureRoot('output');
  try {
    mkdirSync(path.join(root, '.github'), { recursive: true });
    mkdirSync(path.join(root, 'docs', 'decisions'), { recursive: true });
    writeFileSync(path.join(root, 'README.md'), 'public\n');
    writeFileSync(path.join(root, '.squad-workstream'), 'local\n');
    writeFileSync(path.join(root, ...LOCAL_INSTRUCTION.split('/')), 'local\n');
    writeFileSync(path.join(root, 'docs', 'decisions', '0001.md'), 'internal\n');

    const result = materializePublicSnapshot({
      root,
      output,
      paths: [
        './README.md',
        './.squad-workstream',
        LOCAL_INSTRUCTION,
        `${DECISION_ROOT}0001.md`,
      ],
    });

    assert.deepEqual(result.files, ['README.md']);
    assert.equal(readFileSync(path.join(output, 'README.md'), 'utf8'), 'public\n');
    assert.equal(existsSync(path.join(output, '.squad-workstream')), false);
    assert.equal(existsSync(path.join(output, ...LOCAL_INSTRUCTION.split('/'))), false);
    assert.equal(existsSync(path.join(output, ...DECISION_ROOT.split('/'), '0001.md')), false);
    assert.throws(
      () => materializePublicSnapshot({ root, output, paths: ['README.md'] }),
      /output already exists/,
    );
  } finally {
    cleanupFixture();
  }
});

test('a failed candidate inventory cannot become an empty successful snapshot', () => {
  assert.throws(
    () => readSnapshotCandidatePaths('C:\\repo', () => ({ status: 1, stdout: '', stderr: 'not a repository' })),
    /git snapshot inventory failed: not a repository/,
  );
});

test('the snapshot inventory uses tracked files only', () => {
  let argumentsSeen;
  const paths = readSnapshotCandidatePaths('C:\\repo', (_command, args) => {
    argumentsSeen = args;
    return { status: 0, stdout: 'tracked.txt\0', stderr: '' };
  });
  assert.deepEqual(argumentsSeen, ['ls-files', '-z', '--cached']);
  assert.deepEqual(paths, ['tracked.txt']);
});

test('a precise release-boundary check ignores local Squad state but rejects publishable changes', () => {
  const calls = [];
  const squadHeartbeat = ['.github', 'workflows', 'squad-heartbeat.yml'].join('/');
  const syncSquadLabels = ['.github', 'workflows', 'sync-squad-labels.yml'].join('/');
  const publicWorkflow = ['.github', 'workflows', 'test.yml'].join('/');
  const run = (_command, args) => {
    calls.push(args);
    if (args[0] === 'diff') return { status: 0, stdout: '', stderr: '' };
    if (args.includes('--others')) {
      return {
        status: 0,
        stdout: `././.SQUAD/team.md\0.squad-workstream\0${squadHeartbeat}\0${syncSquadLabels}\0${publicWorkflow}\0`,
        stderr: '',
      };
    }
    return { status: 0, stdout: '', stderr: '' };
  };

  assert.throws(
    () => assertReleaseBoundaryClean('C:\\repo', run),
    /untracked publishable candidate: .github\/workflows\/test\.yml/,
  );
  assert.deepEqual(calls, [
    ['diff', '--name-only', '-z'],
    ['diff', '--cached', '--name-only', '-z'],
    ['ls-files', '--others', '--exclude-standard', '-z'],
  ]);
});

test('a modified public tracked file prevents snapshot creation without requiring global cleanliness', () => {
  const run = (_command, args) => {
    if (args[0] === 'diff' && !args.includes('--cached')) {
      return { status: 0, stdout: 'README.md\0.squad/identity/now.md\0', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };

  assert.throws(
    () => assertReleaseBoundaryClean('C:\\repo', run),
    /modified publishable path: README\.md/,
  );
});

test('a clean tracked fixture creates and scans a public snapshot', () => {
  resetFixture();
  const root = fixtureRoot('clean-source');
  const output = fixtureRoot('clean-output');
  try {
    mkdirSync(path.join(root, '.github'), { recursive: true });
    writeFileSync(path.join(root, 'README.md'), 'public release material\n');
    writeFileSync(path.join(root, ...LOCAL_INSTRUCTION.split('/')), 'local\n');
    const run = (_command, args) => {
      if (args[0] === 'ls-files' && args.includes('--cached')) {
        return { status: 0, stdout: `README.md\0${LOCAL_INSTRUCTION}\0`, stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };

    const result = createPublicSnapshot({ root, output, run });
    assert.deepEqual(result.files, ['README.md']);
    assert.equal(readFileSync(path.join(output, 'README.md'), 'utf8'), 'public release material\n');
    assert.equal(existsSync(path.join(output, ...LOCAL_INSTRUCTION.split('/'))), false);
    assert.equal(result.scan.findings.length, 0);
  } finally {
    cleanupFixture();
  }
});

test('a post-copy sensitive artifact scan removes the rejected fixture snapshot', () => {
  resetFixture();
  const root = fixtureRoot('sensitive-source');
  const output = fixtureRoot('sensitive-output');
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'README.md'), `sk-${'A'.repeat(28)}\n`);
    const run = (_command, args) => {
      if (args[0] === 'ls-files' && args.includes('--cached')) {
        return { status: 0, stdout: 'README.md\0', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };

    assert.throws(
      () => createPublicSnapshot({ root, output, run }),
      /Public boundary violations: 1/,
    );
    assert.equal(existsSync(output), false);
  } finally {
    cleanupFixture();
  }
});

test('the materialized-snapshot scan rejects excluded paths even if they appear after selection', () => {
  resetFixture();
  const root = fixtureRoot('excluded-source');
  const output = fixtureRoot('excluded-output');
  try {
    mkdirSync(path.join(output, '.SQUAD'), { recursive: true });
    writeFileSync(path.join(output, '.SQUAD', 'state.json'), '{}\n');

    assert.throws(
      () => scanMaterializedPublicSnapshot({ root, output, paths: [] }),
      /materialized snapshot contains an excluded path/,
    );
  } finally {
    cleanupFixture();
  }
});

test('the materialized-snapshot scan keeps a near-miss public review document', () => {
  resetFixture();
  const root = fixtureRoot('near-miss-source');
  const output = fixtureRoot('near-miss-output');
  const publicDocument = ['docs', 'reviewer-guide.md'].join('/');
  try {
    mkdirSync(path.join(output, 'docs'), { recursive: true });
    writeFileSync(path.join(output, ...publicDocument.split('/')), 'public review guidance\n');

    const report = scanMaterializedPublicSnapshot({ root, output, paths: [publicDocument] });
    assert.deepEqual(report.findings, []);
  } finally {
    cleanupFixture();
  }
});

test('npm unit-test discovery excludes only the integration suites with their own harness', () => {
  const unitTests = nodeUnitTestPaths();
  assert.ok(unitTests.length > 90, 'the unit-test inventory looks truncated');
  assert.ok(unitTests.includes('tests/distribution/public-snapshot.test.mjs'));
  for (const integration of INTEGRATION_TESTS) {
    assert.ok(!unitTests.includes(integration), `${integration} escaped its integration harness`);
  }
});
