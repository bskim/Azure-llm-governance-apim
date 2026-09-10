import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FINDING_CLASSES,
  formatFindings,
  isBinary,
  listReleaseBundle,
  readEntry,
  resolveSupplement,
  scanEntries,
  selectPublicSnapshotPaths,
} from '../../tools/distribution/public-boundary-scan.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const testWorkspaceRoot = path.join(repositoryRoot, 'tests', 'distribution', '.test-work');

// Every offending fixture is assembled at run time. Written as a literal it would sit
// in this tracked file and the repository scan below would report the test itself.
const notApplicable = { state: 'not-applicable', terms: null };
const entry = (text, filePath = 'docs/sample.md') => [{ path: filePath, text }];

function makeTestDirectory(prefix) {
  mkdirSync(testWorkspaceRoot, { recursive: true });
  return mkdtempSync(path.join(testWorkspaceRoot, prefix));
}

test('a forgotten supplement argument throws instead of skipping the class', () => {
  assert.throws(() => scanEntries(entry('clean text')), /supplement is required/);
});

test('an applied supplement with no terms is refused rather than treated as clean', () => {
  assert.throws(() => scanEntries(entry('clean text'), { state: 'applied', terms: [] }), /at least one term/);
});

test('a report names which classes ran, so nothing-found is distinguishable from never-looked', () => {
  const withoutTerms = scanEntries(entry('clean text'), notApplicable);
  assert.deepEqual(withoutTerms.findings, []);
  assert.equal(withoutTerms.supplementState, 'not-applicable');
  assert.ok(!withoutTerms.classesVerified.includes('supplement-term'));

  const withTerms = scanEntries(entry('clean text'), { state: 'applied', terms: ['unused-term'] });
  assert.deepEqual(withTerms.classesVerified, FINDING_CLASSES);
});

test('a reference to an ignored planning artefact is caught', () => {
  const reference = `see ${'.inter'}${'nal'}/notes.md for context`;
  const report = scanEntries(entry(reference), notApplicable);
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].class, 'confidential-path');
  assert.equal(report.findings[0].code, 'ignored-artifact-reference');
});

test('an ignored artefact that became tracked is caught by path alone', () => {
  const report = scanEntries([{ path: `${'.inter'}${'nal'}/notes.md`, text: null }], notApplicable);
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].code, 'ignored-artifact-tracked');
});

test('a source outside the allowlist fails without this repository ever naming one', () => {
  const unlistedHost = ['research', 'vendor-baseline', 'io'].join('.');
  const report = scanEntries(entry(`derived from https://${unlistedHost}/repo`), notApplicable);
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].class, 'unpermitted-host');
  assert.equal(report.findings[0].code, 'source-not-allowlisted');
});

test('historical package-lock URLs are metadata-only, while public source claims remain scanned', () => {
  const externalHost = ['packages', 'vendor-baseline', 'io'].join('.');
  const historical = scanEntries(
    entry(`{"resolved":"https://${externalHost}/example.tgz"}`, 'package-lock.json'),
    notApplicable,
  );
  assert.deepEqual(historical.findings, []);

  const claimedOrigin = scanEntries(
    entry(`the effective registry is https://${externalHost}`),
    notApplicable,
  );
  assert.equal(claimedOrigin.findings[0].code, 'source-not-allowlisted');
});

test('the optional OpenCodex source allowance is exact rather than GitHub-wide', () => {
  const github = ['https:', '', 'github.com'].join('/');
  const project = [github, 'lidge-jun', 'opencodex'].join('/');
  const official = [
    'https://opencodex.me/',
    project,
    `${project}/tree/main/docs-site`,
  ].join('\n');
  assert.deepEqual(scanEntries(entry(official), notApplicable).findings, []);

  const unrelated = scanEntries(entry([github, 'example', 'another-proxy'].join('/')), notApplicable);
  assert.equal(unrelated.findings.length, 1);
  assert.equal(unrelated.findings[0].code, 'source-not-allowlisted');

  const lookalike = scanEntries(entry(`${project}-unsafe`), notApplicable);
  assert.equal(lookalike.findings.length, 1);
});

test('license declaration references allow only the reviewed version-specific files', () => {
  const github = ['https:', '', 'github.com'].join('/');
  const declarations = [
    ['janogonzalez', 'priorityqueuejs', '5fc8ac2ea0482277ee8110182e1d743e31cef1aa', 'Readme.md'],
    ['abrkn', 'semaphore.js', '88a33875b168cc7b5943d7fe987c36d08321d252', 'README.md'],
  ];
  for (const [owner, repository, revision, file] of declarations) {
    const project = [github, owner, repository].join('/');
    const url = [project, 'blob', revision, file].join('/');
    for (const permitted of [url, `${url}#L68-L71`]) {
      assert.deepEqual(scanEntries(entry(permitted), notApplicable).findings, []);
    }
    for (const denied of [
      project,
      url.replace(revision, 'main'),
      `${url}-unreviewed`,
      `${url}/../package.json`,
    ]) {
      const report = scanEntries(entry(denied), notApplicable);
      assert.equal(report.findings.length, 1, denied);
      assert.equal(report.findings[0].code, 'source-not-allowlisted', denied);
    }
  }
});

test('an address reserved for documentation passes, and its routable neighbour does not', () => {
  const reserved = scanEntries(entry('probe https://192.0.2.1/effective-policy'), notApplicable);
  assert.deepStrictEqual(reserved.findings, []);

  // Assembled so this file does not itself contain the address it declares unacceptable.
  const routableNeighbour = ['192', '0', '3', '1'].join('.');
  const routable = scanEntries(entry(`probe https://${routableNeighbour}/effective-policy`), notApplicable);
  assert.equal(routable.findings.length, 1);
  assert.equal(routable.findings[0].class, 'unpermitted-host');
});

test('reserved domain exemptions require a complete DNS label boundary', () => {
  const field = ['client', 'Secret'].join('');
  const opaque = Array.from({ length: 16 }, (_, index) => index.toString(16)).join('');
  for (const tld of ['com', 'net', 'org']) {
    const domain = ['example', tld].join('.');
    for (const host of [domain, `api.${domain}`]) {
      const text = `${field} = "${opaque}" https://${host}/`;
      assert.deepEqual(scanEntries(entry(text), notApplicable).findings, [], host);
    }
    for (const host of [`not${domain}`, `api.not${domain}`, `${domain}.${['outside', 'com'].join('.')}`]) {
      const text = `${field} = "${opaque}" https://${host}/`;
      const report = scanEntries(entry(text), notApplicable);
      assert.ok(report.findings.some((item) => item.class === 'unpermitted-host'), host);
      assert.ok(report.findings.some((item) => item.class === 'credential-shape'), host);
    }
  }
});

test('Microsoft, standards, and reserved documentation hosts pass', () => {
  const permitted = [
    `https://${'learn.microsoft.com'}/azure/api-management`,
    `https://${'management.azure.com'}/subscriptions`,
    `https://${'json-schema.org'}/draft/2020-12/schema`,
    `https://${'gateway.example.net'}/v1/responses`,
    `https://${'127.0.0.1'}:8787/v1`,
  ].join('\n');
  const report = scanEntries(entry(permitted), notApplicable);
  assert.deepEqual(report.findings, []);
});

test('credential value shapes are caught while a field name alone is not', () => {
  const signedToken = `eyJ${'a'.repeat(14)}.eyJ${'b'.repeat(14)}.${'c'.repeat(20)}`;
  const providerKey = `sk-${'D'.repeat(28)}`;
  const assigned = `client_secret: "${'Z'.repeat(30)}"`;
  const caught = scanEntries(entry([signedToken, providerKey, assigned].join('\n')), notApplicable);
  assert.equal(caught.findings.length, 3);
  assert.deepEqual(
    caught.findings.map((item) => item.code).sort(),
    ['assigned-secret', 'provider-key', 'signed-token'],
  );

  const prose = 'The gateway validates the bearer token and refuses a provider api-key header.';
  assert.deepEqual(scanEntries(entry(prose), notApplicable).findings, []);
});

test('a placeholder credential against a reserved host is not reported', () => {
  const fixture = `https://${'user'}:${'password'}@${'example.test'}/openai/v1`;
  assert.deepEqual(scanEntries(entry(fixture), notApplicable).findings, []);
});

test('userinfo is not mistaken for the host it precedes', () => {
  const unlistedHost = ['research', 'vendor-baseline', 'io'].join('.');
  const report = scanEntries(entry(`https://${'operator'}@${unlistedHost}/repo`), notApplicable);
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].class, 'unpermitted-host');
  assert.doesNotMatch(report.findings[0].excerpt, /research/i);
});

test('IPv6 and non-ASCII hosts cannot bypass the source allowlist', () => {
  const ipv6 = scanEntries(entry(['https:/', '[2001:db8::1]', 'repo'].join('/')), notApplicable);
  assert.equal(ipv6.findings.length, 1);
  assert.equal(ipv6.findings[0].class, 'unpermitted-host');

  const unicodeHost = ['https://', '\u0433\u0438\u0442\u0445\u0430\u0431', '.com/repo'].join('');
  const unicode = scanEntries(entry(unicodeHost), notApplicable);
  assert.ok(unicode.findings.some((item) => item.class === 'unpermitted-host'));

  const loopback = scanEntries(entry('http://[::1]:8788/v1'), notApplicable);
  assert.deepEqual(loopback.findings, []);
});

test('a self-describing phrase is a fixture name, while an opaque value of the same length is not', () => {
  const phrase = 'client_secret: "must-not-reach-the-backend-service"';
  assert.deepEqual(scanEntries(entry(phrase), notApplicable).findings, []);

  const opaque = `client_secret: "${'aF9'.repeat(10)}"`;
  assert.equal(scanEntries(entry(opaque), notApplicable).findings[0].code, 'assigned-secret');
});

test('a nil identifier is a defined placeholder, while a populated one is reported', () => {
  const nil = `/subscriptions/${'0'.repeat(8)}-${'0'.repeat(4)}-${'0'.repeat(4)}-${'0'.repeat(4)}-${'0'.repeat(12)}`;
  assert.deepEqual(scanEntries(entry(nil), notApplicable).findings, []);

  const populated = `/subscriptions/${'1a2b3c4d'}-${'5e6f'}-${'7a8b'}-${'9c0d'}-${'1e2f3a4b5c6d'}`;
  assert.equal(scanEntries(entry(populated), notApplicable).findings[0].code, 'subscription-id');
});

test('release material may cite the internal evidence it was drawn from; a tracked file may not', () => {
  const bundlePath = `${'.inter'}${'nal'}/release-assets/index.md`;
  const citation = `captured from ${'.inter'}${'nal'}/release-assets/overview.png`;
  const bundle = scanEntries([{ path: bundlePath, text: citation, origin: 'bundle' }], notApplicable);
  assert.deepEqual(bundle.findings, []);

  const tracked = scanEntries([{ path: 'docs/overview.md', text: citation, origin: 'tracked' }], notApplicable);
  assert.equal(tracked.findings[0].class, 'confidential-path');
});

test('a subscription identifier in a path is caught', () => {
  const identifier = `/subscriptions/${'1'.repeat(8)}-${'2'.repeat(4)}-${'3'.repeat(4)}-${'4'.repeat(4)}-${'5'.repeat(12)}`;
  const report = scanEntries(entry(identifier), notApplicable);
  assert.equal(report.findings[0].code, 'subscription-id');
});

test('a bare tenant or subscription GUID assigned outside a resource path is caught', () => {
  const highEntropyGuid = '1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d';
  for (const text of [
    `tenantId: '${highEntropyGuid}'`,
    `subscriptionId: "${highEntropyGuid}"`,
    `AZURE_TENANT_ID="${highEntropyGuid}"`,
    `AZURE_SUBSCRIPTION_ID='${highEntropyGuid}'`,
  ]) {
    const report = scanEntries(entry(text), notApplicable);
    assert.equal(report.findings.length, 1, text);
    assert.equal(report.findings[0].code, 'tenant-or-subscription-id', text);
  }

  // Low-entropy fixture GUIDs, as used throughout the test suite, remain unreported.
  for (const fixtureGuid of [
    '11111111-2222-3333-4444-555555555555',
    '00000000-0000-4000-8000-000000000005',
    '00000000-0000-0000-0000-0000000000aa',
  ]) {
    const report = scanEntries(entry(`tenantId: '${fixtureGuid}'`), notApplicable);
    assert.deepEqual(report.findings, [], fixtureGuid);
  }
});

test('a local machine path is caught on both platforms', () => {
  const windowsPath = ['C:', 'Users', 'someone', 'workspace'].join('\\');
  const posixPath = ['', 'home', 'someone', 'workspace'].join('/');
  const report = scanEntries(entry(`${windowsPath}\n${posixPath}`), notApplicable);
  assert.equal(report.findings.length, 2);
  assert.deepEqual(report.findings.map((item) => item.class), ['local-machine-path', 'local-machine-path']);
});

test('customer registry policy must be configured rather than embedded in public source', () => {
  const field = ['effective', 'Registry', 'Origin'].join('');
  const host = ['registry', 'customer', 'example'].join('.');
  const report = scanEntries(entry(`${field}: "https://${host}"`), notApplicable);
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].class, 'registry-identity');
  assert.equal(report.findings[0].code, 'hardcoded-registry-origin');
  assert.doesNotMatch(formatFindings(report), /customer|example/i);

  const placeholder = `${field}: "<approved-registry-origin>"`;
  assert.deepEqual(scanEntries(entry(placeholder), notApplicable).findings, []);
});

test('email and local validation environment identities are rejected with synthetic fixtures', () => {
  const address = [['release', 'owner'].join('.'), ['customer-fixture', 'testdata'].join('.')].join('@');
  const environmentKey = ['AZURE', 'ENV', 'NAME'].join('_');
  const environmentName = ['team', 'validation', 'a'].join('-');
  const report = scanEntries(
    entry(`${address}\n${environmentKey}="${environmentName}"`),
    notApplicable,
  );
  assert.deepEqual(
    report.findings.map((item) => item.class).sort(),
    ['local-environment', 'user-identity'],
  );
  assert.doesNotMatch(formatFindings(report), /release|customer|team-/i);
});

test('a supplement term is matched case-insensitively and never echoed, not even a prefix', () => {
  const term = 'acme-baseline';
  const report = scanEntries(entry('Compared against Acme-Baseline during review.'), {
    state: 'applied',
    terms: [term],
  });
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].class, 'supplement-term');
  const rendered = formatFindings(report);
  // Any leading fragment would put the confidential term itself into the log.
  for (let length = 2; length <= term.length; length += 1) {
    assert.ok(!rendered.toLowerCase().includes(term.slice(0, length)), `leaked a ${length}-character prefix`);
  }
});

test('a finding never reproduces the value it found', () => {
  const providerKey = `sk-${'E'.repeat(28)}`;
  const report = scanEntries(entry(providerKey), notApplicable);
  const rendered = formatFindings(report);
  assert.ok(!rendered.includes(providerKey));
  assert.ok(rendered.includes('31 chars'));
});

test('an exemption is scoped to one class, so the ignore file is still credential checked', () => {
  const providerKey = `sk-${'F'.repeat(28)}`;
  const ignoreFile = scanEntries([{ path: '.gitignore', text: `${'.inter'}${'nal'}/\n${providerKey}` }], notApplicable);
  assert.equal(ignoreFile.findings.length, 1);
  assert.equal(ignoreFile.findings[0].class, 'credential-shape');

  // The scanner is exempt from the class it defines, and from nothing else.
  const scanner = scanEntries(
    [{ path: 'tools/distribution/public-boundary-scan.mjs', text: `${'.azu'}${'re'}/\n${providerKey}` }],
    notApplicable,
  );
  assert.equal(scanner.findings.length, 1);
  assert.equal(scanner.findings[0].class, 'credential-shape');
});

test('a binary file is not decoded as text but its path is still checked', () => {
  assert.ok(isBinary('PNG\u0000\u0000'));
  const report = scanEntries([{ path: 'app/admin-ui/public/logo.png', text: null }], notApplicable);
  assert.deepEqual(report.findings, []);
});

test('an internal workspace without the supplement file fails rather than passing quietly', () => {
  const root = makeTestDirectory('boundary-');
  try {
    assert.equal(resolveSupplement(root).state, 'not-applicable');

    mkdirSync(path.join(root, '.internal'));
    assert.equal(resolveSupplement(root).state, 'missing');

    writeFileSync(path.join(root, '.internal', 'public-boundary-terms.json'), JSON.stringify({ terms: [] }));
    assert.equal(resolveSupplement(root).state, 'missing');

    writeFileSync(path.join(root, '.internal', 'public-boundary-terms.json'), JSON.stringify({ terms: ['acme-baseline'] }));
    const loaded = resolveSupplement(root);
    assert.equal(loaded.state, 'applied');
    assert.deepEqual(loaded.terms, ['acme-baseline']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('this repository publishes nothing it must not, across tracked files and the release bundle', () => {
  const listed = spawnSync('git', ['ls-files'], { cwd: repositoryRoot, encoding: 'utf8' });
  assert.equal(listed.status, 0, 'git ls-files must succeed');
  const tracked = listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  assert.ok(tracked.length > 100, 'the tracked file list looks truncated');
  const publishableTracked = selectPublicSnapshotPaths(tracked);

  // A file that is not yet tracked is a file about to be, and scanning only what is already
  // committed means the run before every first commit is the one run that cannot see it. That
  // is how a fixture naming a real gateway host reached this repository and was found only
  // after the commit that published it.
  const pending = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  assert.equal(pending.status, 0, 'git ls-files --others must succeed');
  const uncommitted = pending.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  const publishableUncommitted = selectPublicSnapshotPaths(uncommitted);

  const supplement = resolveSupplement(repositoryRoot);
  assert.notEqual(
    supplement.state,
    'missing',
    `the internal term supplement is unreadable (${supplement.reason}); the named-term class cannot be skipped`,
  );

  const entries = [
    ...publishableTracked.map((relativePath) => readEntry(repositoryRoot, relativePath, 'tracked')),
    ...publishableUncommitted.map((relativePath) => readEntry(repositoryRoot, relativePath, 'tracked')),
    ...listReleaseBundle(repositoryRoot).map((relativePath) => readEntry(repositoryRoot, relativePath, 'bundle')),
  ];
  const report = scanEntries(entries, supplement);
  assert.deepEqual(report.findings, [], formatFindings(report));
});
