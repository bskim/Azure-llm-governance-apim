import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  EXIT_FAILED,
  EXIT_UNRESOLVED,
  canonicalJson,
  checkActionPins,
  checkContainerPins,
  checkDependencyPins,
  createActionPinInventory,
  createLicenseInventory,
  createRepositoryInventories,
  createReleaseEvidence,
  createSbom,
  createSourceInventory,
  readAdvisoryEvidence,
  readRegistryPolicyEvidence,
  sha256Buffer,
  summarizeLockIntegrity,
  validateReleaseEvidence,
  validateReleaseReadiness,
  validateSbom,
  verifyArtifactDigest,
} from '../../tools/supply-chain/evidence.mjs';
import {
  versionInventory,
} from '../../tools/supply-chain/lockfile.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliPath = fileURLToPath(new URL('../../tools/supply-chain/cli.mjs', import.meta.url));
const actionSha = '0123456789abcdef0123456789abcdef01234567';
const imageDigest = 'a'.repeat(64);
const integrity = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;
const generatedAt = new Date().toISOString();
const registryOrigin = ['https:', '', ['registry', 'customer', 'example'].join('.')].join('/');

function makeTestDirectory(prefix) {
  const parent = path.join(repositoryRoot, 'tests', 'distribution', '.test-work');
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(path.join(parent, prefix));
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createCandidate() {
  const root = makeTestDirectory('candidate-');
  mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
  const packageJson = {
    name: 'fixture-app',
    version: '1.0.0',
    private: true,
    type: 'module',
    license: 'MIT',
    dependencies: { example: '1.0.0' },
  };
  const packageLock = {
    name: 'fixture-app',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: 'fixture-app',
        version: '1.0.0',
        license: 'MIT',
        dependencies: { example: '1.0.0' },
      },
      'node_modules/example': {
        version: '1.0.0',
        resolved: 'https://packages.example/example-1.0.0.tgz',
        integrity,
        license: 'MIT',
      },
    },
  };
  writeJson(path.join(root, 'package.json'), packageJson);
  writeJson(path.join(root, 'package-lock.json'), packageLock);
  writeFileSync(path.join(root, 'LICENSE'), 'Copyright Fixture Owner\nMIT License\n');
  writeFileSync(path.join(root, 'NOTICE'), 'Fixture dependency notices reviewed.\n');
  writeFileSync(path.join(root, '.env'), 'placeholder-only\n');
  writeFileSync(
    path.join(root, '.github', 'workflows', 'ci.yml'),
    `steps:\n  - uses: actions/checkout@${actionSha}\n`,
  );
  writeFileSync(path.join(root, 'Dockerfile'), `FROM example.invalid/runtime@sha256:${imageDigest}\n`);
  const initialized = spawnSync('git', ['init', '--quiet'], { cwd: root, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.stderr);
  const added = spawnSync('git', [
    'add',
    'package.json',
    'package-lock.json',
    'LICENSE',
    'NOTICE',
    'Dockerfile',
    '.github/workflows/ci.yml',
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(added.status, 0, added.stderr);
  return { root, packageJson, packageLock };
}

function auditEnvelope(report, lockfileSha256, versionInventorySha256, {
  executedAt = generatedAt,
  completeCommand = 'npm audit --json --ignore-scripts --cache <repository-local-cache>',
  productionCommand = 'npm audit --json --omit=dev --ignore-scripts --cache <repository-local-cache>',
} = {}) {
  return {
    schemaVersion: 1,
    executedAt,
    metadata: {
      nodeVersion: process.version,
      npmVersion: '11.0.0',
      registryOrigin,
    },
    scans: {
      complete: {
        command: completeCommand,
        exitCode: 0,
        lockfileSha256,
        versionInventorySha256,
        report,
      },
      production: {
        command: productionCommand,
        exitCode: 0,
        lockfileSha256,
        versionInventorySha256,
        report,
      },
    },
  };
}

function registryPolicy(packageLock, lockfileBytes, overrides = {}) {
  return {
    allowedIntegrityAlgorithms: ['sha1', 'sha256', 'sha384', 'sha512'],
    approvedRegistryOrigins: [registryOrigin],
    effectiveRegistryOrigin: registryOrigin,
    exactVersionsRequired: true,
    integrityRequired: true,
    lockfileSha256: sha256Buffer(lockfileBytes),
    packageManagerIntegrityEnforced: true,
    schemaVersion: 1,
    versionInventorySha256: versionInventory(packageLock).sha256,
    ...overrides,
  };
}

function writeRegistryPolicy(fixture, overrides = {}) {
  const lockfileBytes = readFileSync(path.join(fixture.root, 'package-lock.json'));
  const policy = registryPolicy(fixture.packageLock, lockfileBytes, overrides);
  const policyPath = path.join(fixture.root, 'registry-policy.json');
  writeJson(policyPath, policy);
  return {
    path: policyPath,
    policy: readRegistryPolicyEvidence(policyPath, { lockfileBytes }),
  };
}

function emptyAuditReport() {
  return {
    auditReportVersion: 2,
    vulnerabilities: {},
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: 0,
        high: 0,
        critical: 0,
        total: 0,
      },
    },
  };
}

function createBoundEvidence(fixture) {
  rmSync(path.join(fixture.root, '.env'), { force: true });
  const artifactPath = path.join(fixture.root, 'artifact.bin');
  const advisoryPath = path.join(fixture.root, 'npm-audit.json');
  writeFileSync(artifactPath, 'fixture artifact');
  const lockfileBytes = readFileSync(path.join(fixture.root, 'package-lock.json'));
  const lockfileSha256 = sha256Buffer(lockfileBytes);
  const versionInventorySha256 = versionInventory(fixture.packageLock).sha256;
  const policy = registryPolicy(fixture.packageLock, lockfileBytes);
  writeJson(
    advisoryPath,
    auditEnvelope(emptyAuditReport(), lockfileSha256, versionInventorySha256),
  );
  const sourceInventory = createSourceInventory(fixture.root);
  const repositoryInventories = createRepositoryInventories(fixture.root);
  const sbom = createSbom(fixture.packageJson, fixture.packageLock);
  const evidence = createReleaseEvidence({
    root: fixture.root,
    generatedAt,
    sourceInventory,
    repositoryInventories,
    sbom,
    sbomValidationErrors: validateSbom(sbom),
    licenseInventory: createLicenseInventory(fixture.root, fixture.packageJson, fixture.packageLock),
    dependencyPinFindings: checkDependencyPins(fixture.packageJson, fixture.packageLock, {
      registryPolicyEvidence: policy,
    }),
    integritySummary: summarizeLockIntegrity(fixture.packageLock),
    registryPolicyEvidence: policy,
    actionPinFindings: checkActionPins(fixture.root),
    actionPinInventory: createActionPinInventory(fixture.root),
    containerPinFindings: checkContainerPins(fixture.root),
    advisoryEvidence: readAdvisoryEvidence(advisoryPath, {
      expectedLockfileSha256: lockfileSha256,
      expectedVersionInventorySha256: versionInventorySha256,
      registryPolicyEvidence: policy,
    }),
    artifactDigest: verifyArtifactDigest(
      artifactPath,
      sha256Buffer(readFileSync(artifactPath)),
    ),
  });
  return {
    artifactPath,
    evidence,
    lockfileSha256,
    policy,
    sbom,
    versionInventorySha256,
  };
}

test('source inventory, SBOM, licenses, pins, and release evidence remain deterministic and fail closed', () => {
  const fixture = createCandidate();
  try {
    const lockfileBytes = readFileSync(path.join(fixture.root, 'package-lock.json'));
    const policy = registryPolicy(fixture.packageLock, lockfileBytes);
    const sourceInventory = createSourceInventory(fixture.root);
    const repositoryInventories = createRepositoryInventories(fixture.root);
    assert.deepEqual(sourceInventory.rejectedSecretPaths, ['.env']);
    assert.equal(sourceInventory.files.some((entry) => entry.path === '.env'), false);
    assert.equal(canonicalJson(sourceInventory), canonicalJson(createSourceInventory(fixture.root)));

    const sbom = createSbom(fixture.packageJson, fixture.packageLock);
    assert.deepEqual(validateSbom(sbom), []);
    const unsorted = structuredClone(sbom);
    unsorted.dependencies.reverse();
    assert.match(validateSbom(unsorted).join('\n'), /dependencies must be sorted/);

    const licenses = createLicenseInventory(fixture.root, fixture.packageJson, fixture.packageLock);
    assert.deepEqual(licenses.noticeFiles, ['NOTICE']);
    assert.deepEqual(licenses.unknownLicensePackages, []);
    assert.equal(
      checkDependencyPins(fixture.packageJson, fixture.packageLock)[0].code,
      'REGISTRY_POLICY_REQUIRED',
    );
    assert.deepEqual(checkDependencyPins(fixture.packageJson, fixture.packageLock, {
      registryPolicyEvidence: policy,
    }), []);
    assert.deepEqual(checkActionPins(fixture.root), []);
    assert.deepEqual(checkContainerPins(fixture.root), []);

    const weakLock = structuredClone(fixture.packageLock);
    weakLock.packages['node_modules/example'].integrity = `sha1-${Buffer.alloc(20, 3).toString('base64')}`;
    assert.deepEqual(
      checkDependencyPins(fixture.packageJson, weakLock, {
        registryPolicyEvidence: policy,
      }),
      [],
    );
    assert.equal(
      checkDependencyPins(fixture.packageJson, weakLock, {
        registryPolicyEvidence: { ...policy, allowedIntegrityAlgorithms: ['sha512'] },
      })[0].code,
      'LOCK_INTEGRITY_ALGORITHM_NOT_ALLOWED',
    );
    assert.deepEqual(summarizeLockIntegrity(weakLock), {
      algorithms: { sha1: 1 },
      invalidCount: 0,
      missingCount: 0,
      resolvedCount: 1,
      status: 'passed',
      strongCount: 0,
      weakCount: 1,
    });

    writeFileSync(path.join(fixture.root, '.github', 'workflows', 'ci.yml'), 'steps:\n  - uses: actions/checkout@v4\n');
    assert.equal(checkActionPins(fixture.root)[0].code, 'GITHUB_ACTION_NOT_COMMIT_PINNED');
    writeFileSync(path.join(fixture.root, 'Dockerfile'), 'FROM example.invalid/runtime:latest\n');
    assert.equal(checkContainerPins(fixture.root)[0].code, 'CONTAINER_NOT_DIGEST_PINNED');

    const artifactPath = path.join(fixture.root, 'artifact.bin');
    writeFileSync(artifactPath, 'fixture artifact');
    const artifactSha256 = sha256Buffer(readFileSync(artifactPath));
    const artifactDigest = verifyArtifactDigest(artifactPath, artifactSha256);
    assert.equal(artifactDigest.status, 'passed');
    assert.equal(artifactDigest.digestMatched, true);
    assert.equal(Object.hasOwn(artifactDigest, 'independentlyVerified'), false);
    assert.equal(verifyArtifactDigest(artifactPath, '0'.repeat(64)).status, 'failed');
    assert.equal(verifyArtifactDigest().status, 'unresolved');

    const advisoryPath = path.join(fixture.root, 'npm-audit.json');
    const auditReport = {
      auditReportVersion: 2,
      vulnerabilities: {},
      metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } },
    };
    const lockfileSha256 = sha256Buffer(readFileSync(path.join(fixture.root, 'package-lock.json')));
    const versionInventorySha256 = versionInventory(fixture.packageLock).sha256;
    writeJson(
      advisoryPath,
      auditEnvelope(auditReport, lockfileSha256, versionInventorySha256),
    );
    const advisoryEvidence = readAdvisoryEvidence(advisoryPath, {
      expectedLockfileSha256: lockfileSha256,
      expectedVersionInventorySha256: versionInventorySha256,
      registryPolicyEvidence: policy,
    });
    assert.equal(advisoryEvidence.status, 'passed');

    const evidence = createReleaseEvidence({
      root: fixture.root,
      generatedAt,
      sourceInventory,
      repositoryInventories,
      sbom,
      sbomValidationErrors: [],
      licenseInventory: licenses,
      dependencyPinFindings: [],
      integritySummary: summarizeLockIntegrity(fixture.packageLock),
      registryPolicyEvidence: policy,
      actionPinFindings: [],
      containerPinFindings: [],
      advisoryEvidence,
      artifactDigest,
    });
    assert.equal(evidence.releaseStatus, 'blocked');
    assert.equal(evidence.generatedEvidence.organizationalApproval, false);
    assert.deepEqual(evidence.generatedEvidence.signatureClaims, []);
    assert.deepEqual(evidence.generatedEvidence.provenanceClaims, []);
    assert.deepEqual(validateReleaseEvidence(evidence), []);
    assert.deepEqual(
      evidence.blockers.map((entry) => entry.id),
      [
        'EXTERNAL_SIGNING_REQUIRED',
        'ORGANIZATIONAL_APPROVAL_REQUIRED',
        'PROVENANCE_ATTESTATION_REQUIRED',
        'SOURCE_INVENTORY_REJECTED_PATHS',
      ],
    );
    assert.match(
      validateReleaseReadiness(evidence, {
        artifactPath,
        candidateRoot: fixture.root,
        now: new Date(generatedAt),
        sbom,
      }).join('\n'),
      /release blockers remain/,
    );

    mkdirSync(path.join(fixture.root, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      path.join(fixture.root, '.github', 'workflows', 'squad-insider-release.yml'),
      'steps:\n  - uses: actions/checkout@v4\n',
    );
    const actionInventory = createActionPinInventory(fixture.root);
    assert.deepEqual(actionInventory.productOwned.findings, [{
      code: 'GITHUB_ACTION_NOT_COMMIT_PINNED',
      line: 2,
      path: '.github/workflows/ci.yml',
      reference: 'actions/checkout@v4',
    }]);
    assert.equal(
      actionInventory.productOwned.workflows.includes(
        '.github/workflows/squad-insider-release.yml',
      ),
      false,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('registry policy is explicit, environment-neutral, and bound to the current lock', () => {
  const fixture = createCandidate();
  try {
    const accepted = writeRegistryPolicy(fixture);
    assert.equal(accepted.policy.effectiveRegistryOrigin, registryOrigin);
    assert.deepEqual(
      accepted.policy.allowedIntegrityAlgorithms,
      ['sha1', 'sha256', 'sha384', 'sha512'],
    );

    for (const overrides of [
      { approvedRegistryOrigins: [] },
      {
        effectiveRegistryOrigin:
          ['https:', '', ['unapproved', 'customer', 'example'].join('.')].join('/'),
      },
      { allowedIntegrityAlgorithms: [] },
      { allowedIntegrityAlgorithms: ['md5'] },
      { packageManagerIntegrityEnforced: false },
      { lockfileSha256: 'f'.repeat(64) },
      { unexpectedStatus: 'passed' },
    ]) {
      const invalidPath = path.join(fixture.root, 'invalid-policy.json');
      writeJson(
        invalidPath,
        registryPolicy(
          fixture.packageLock,
          readFileSync(path.join(fixture.root, 'package-lock.json')),
          overrides,
        ),
      );
      assert.throws(
        () => readRegistryPolicyEvidence(invalidPath, {
          lockfileBytes: readFileSync(path.join(fixture.root, 'package-lock.json')),
        }),
        /registry policy/,
      );
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
test('release readiness retains every weak-integrity, legal, automation, digest, and approval blocker', () => {
  const fixture = createCandidate();
  try {
    rmSync(path.join(fixture.root, 'NOTICE'));
    rmSync(path.join(fixture.root, 'LICENSE'));
    writeFileSync(path.join(fixture.root, '.github', 'workflows', 'ci.yml'), 'steps:\n  - uses: actions/checkout@v4\n');
    const blockedLock = structuredClone(fixture.packageLock);
    blockedLock.packages['node_modules/example'].integrity = `sha1-${Buffer.alloc(20, 3).toString('base64')}`;
    delete blockedLock.packages['node_modules/example'].license;
    const policy = registryPolicy(
      fixture.packageLock,
      readFileSync(path.join(fixture.root, 'package-lock.json')),
      { allowedIntegrityAlgorithms: ['sha512'] },
    );
    const sourceInventory = createSourceInventory(fixture.root);
    const repositoryInventories = createRepositoryInventories(fixture.root);
    const sbom = createSbom(fixture.packageJson, blockedLock);
    const evidence = createReleaseEvidence({
      root: fixture.root,
      generatedAt,
      sourceInventory,
      repositoryInventories,
      sbom,
      sbomValidationErrors: validateSbom(sbom),
      licenseInventory: createLicenseInventory(fixture.root, fixture.packageJson, blockedLock),
      dependencyPinFindings: checkDependencyPins(fixture.packageJson, blockedLock, {
        registryPolicyEvidence: policy,
      }),
      integritySummary: summarizeLockIntegrity(blockedLock),
      registryPolicyEvidence: policy,
      actionPinFindings: checkActionPins(fixture.root),
      actionPinInventory: createActionPinInventory(fixture.root),
      containerPinFindings: checkContainerPins(fixture.root),
      advisoryEvidence: readAdvisoryEvidence(),
      artifactDigest: verifyArtifactDigest(),
    });
    assert.deepEqual(validateReleaseEvidence(evidence), []);
    const blockerIds = new Set(evidence.blockers.map((entry) => entry.id));
    for (const expected of [
      'ADVISORY_SOURCE_UNAVAILABLE',
      'ARTIFACT_DIGEST_REQUIRED',
      'DEPENDENCY_LICENSES_UNKNOWN',
      'DEPENDENCY_PIN_FINDINGS',
      'EXTERNAL_SIGNING_REQUIRED',
      'GITHUB_ACTION_PIN_FINDINGS',
      'LEGAL_OWNERSHIP_UNVERIFIED',
      'NOTICE_DETERMINATION_REQUIRED',
      'ORGANIZATIONAL_APPROVAL_REQUIRED',
      'PROVENANCE_ATTESTATION_REQUIRED',
    ]) {
      assert.equal(blockerIds.has(expected), true, expected);
    }
    assert.equal(evidence.releaseStatus, 'blocked');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('supply-chain CLI writes canonical evidence and fails when registry policy is absent', () => {
  const fixture = createCandidate();
  const output = makeTestDirectory('evidence-output-');
  try {
    const help = spawnSync(process.execPath, [cliPath], { encoding: 'utf8' });
    assert.equal(help.status, EXIT_FAILED);
    assert.match(help.stderr, /registry-policy\.template\.json/);
    assert.match(help.stderr, /no registry or integrity algorithm is trusted by default/);

    const missingOutput = spawnSync(process.execPath, [
      cliPath,
      'evidence',
      '--candidate',
      fixture.root,
    ], { encoding: 'utf8' });
    assert.equal(missingOutput.status, 1);
    assert.match(missingOutput.stderr, /option --output-dir is required for command evidence/);

    const missingValidationInputs = spawnSync(process.execPath, [
      cliPath,
      'validate',
    ], { encoding: 'utf8' });
    assert.equal(missingValidationInputs.status, 1);
    assert.match(missingValidationInputs.stderr, /option --evidence is required for command validate/);

    const missingSbomInput = spawnSync(process.execPath, [
      cliPath,
      'validate',
      '--evidence',
      path.join(output, 'release-evidence.json'),
    ], { encoding: 'utf8' });
    assert.equal(missingSbomInput.status, 1);
    assert.match(missingSbomInput.stderr, /option --sbom is required for command validate/);

    rmSync(path.join(fixture.root, '.env'));
    const artifactPath = path.join(fixture.root, 'artifact.bin');
    writeFileSync(artifactPath, 'fixture artifact');
    const artifactSha256 = sha256Buffer(readFileSync(artifactPath));
    const advisoryPath = path.join(fixture.root, 'npm-audit.json');
    const lockfileSha256 = sha256Buffer(readFileSync(path.join(fixture.root, 'package-lock.json')));
    const versionInventorySha256 = versionInventory(fixture.packageLock).sha256;
    const policy = writeRegistryPolicy(fixture);
    writeJson(advisoryPath, auditEnvelope({
      auditReportVersion: 2,
      vulnerabilities: {},
      metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } },
    }, lockfileSha256, versionInventorySha256));

    const generated = spawnSync(process.execPath, [
      cliPath,
      'evidence',
      '--candidate',
      fixture.root,
      '--output-dir',
      output,
      '--advisory-input',
      advisoryPath,
      '--artifact',
      artifactPath,
      '--expected-sha256',
      artifactSha256,
      '--generated-at',
      generatedAt,
    ], { encoding: 'utf8' });
    assert.equal(generated.status, EXIT_FAILED, generated.stderr);
    assert.match(generated.stdout, /blocked; 6 blocker\(s\)/);

    rmSync(output, { recursive: true, force: true });
    mkdirSync(output, { recursive: true });
    const configured = spawnSync(process.execPath, [
      cliPath,
      'evidence',
      '--candidate',
      fixture.root,
      '--output-dir',
      output,
      '--advisory-input',
      advisoryPath,
      '--artifact',
      artifactPath,
      '--expected-sha256',
      artifactSha256,
      '--generated-at',
      generatedAt,
      '--registry-policy',
      policy.path,
    ], { encoding: 'utf8' });
    assert.equal(configured.status, EXIT_UNRESOLVED, configured.stderr);
    assert.match(configured.stdout, /blocked; 3 blocker\(s\)\./);
    assert.doesNotMatch(configured.stdout, /[A-Za-z]:[\\/]|\.test-work/);

    const validated = spawnSync(process.execPath, [
      cliPath,
      'validate',
      '--evidence',
      path.join(output, 'release-evidence.json'),
      '--sbom',
      path.join(output, 'sbom.cdx.json'),
    ], { encoding: 'utf8' });
    assert.equal(validated.status, 0, validated.stderr);
    assert.match(validated.stdout, /structurally valid/);

    const readiness = spawnSync(process.execPath, [
      cliPath,
      'ready',
      '--candidate',
      fixture.root,
      '--evidence',
      path.join(output, 'release-evidence.json'),
      '--sbom',
      path.join(output, 'sbom.cdx.json'),
      '--artifact',
      artifactPath,
    ], { encoding: 'utf8' });
    assert.equal(readiness.status, EXIT_UNRESOLVED, readiness.stderr);
    assert.match(readiness.stderr, /release blockers remain/);

    const staleEvidence = JSON.parse(readFileSync(path.join(output, 'release-evidence.json'), 'utf8'));
    staleEvidence.generatedAt = '2020-01-01T00:00:00.000Z';
    const generatedSbom = JSON.parse(readFileSync(path.join(output, 'sbom.cdx.json'), 'utf8'));
    assert.match(
      validateReleaseReadiness(staleEvidence, {
        artifactPath,
        candidateRoot: fixture.root,
        now: new Date(generatedAt),
        sbom: generatedSbom,
      }).join('\n'),
      /evidence is stale/,
    );

    const verified = spawnSync(process.execPath, [
      cliPath,
      'verify',
      '--artifact',
      artifactPath,
      '--expected-sha256',
      artifactSha256,
    ], { encoding: 'utf8' });
    assert.equal(verified.status, 0, verified.stderr);
    assert.equal(JSON.parse(verified.stdout).status, 'passed');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  }
});

test('advisory readiness rejects stale scans and a different package-lock digest', () => {
  const fixture = createCandidate();
  try {
    const bundle = createBoundEvidence(fixture);
    const stale = structuredClone(bundle.evidence);
    stale.checks.find((entry) => entry.id === 'dependency-advisories').executedAt =
      '2020-01-01T00:00:00.000Z';
    assert.match(
      validateReleaseReadiness(stale, {
        artifactPath: bundle.artifactPath,
        candidateRoot: fixture.root,
        now: new Date(generatedAt),
        sbom: bundle.sbom,
      }).join('\n'),
      /advisory evidence is stale/,
    );

    const advisoryPath = path.join(fixture.root, 'different-lock-audit.json');
    writeJson(
      advisoryPath,
      auditEnvelope(emptyAuditReport(), 'f'.repeat(64), bundle.versionInventorySha256),
    );
    const mismatched = readAdvisoryEvidence(advisoryPath, {
      expectedLockfileSha256: bundle.lockfileSha256,
      expectedVersionInventorySha256: bundle.versionInventorySha256,
      registryPolicyEvidence: bundle.policy,
    });
    assert.equal(mismatched.status, 'unresolved');
    assert.match(mismatched.message, /not bound to the current exact-version inventory/);

    const unapprovedOrigin = auditEnvelope(
      emptyAuditReport(),
      bundle.lockfileSha256,
      bundle.versionInventorySha256,
    );
    unapprovedOrigin.metadata.registryOrigin =
      ['https:', '', ['packages', 'example'].join('.')].join('/');
    writeJson(advisoryPath, unapprovedOrigin);
    const unapproved = readAdvisoryEvidence(advisoryPath, {
      expectedLockfileSha256: bundle.lockfileSha256,
      expectedVersionInventorySha256: bundle.versionInventorySha256,
      registryPolicyEvidence: bundle.policy,
    });
    assert.equal(unapproved.status, 'unresolved');
    assert.match(unapproved.message, /registry-origin metadata/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('readiness rejects a structurally valid replacement-root SBOM', () => {
  const fixture = createCandidate();
  try {
    const bundle = createBoundEvidence(fixture);
    const replacement = structuredClone(bundle.sbom);
    replacement.metadata.component.name = 'replacement-root';
    assert.deepEqual(validateSbom(replacement), []);
    const errors = validateReleaseReadiness(bundle.evidence, {
      artifactPath: bundle.artifactPath,
      candidateRoot: fixture.root,
      now: new Date(generatedAt),
      sbom: replacement,
    }).join('\n');
    assert.match(errors, /does not match subject\.sbomSha256/);
    assert.match(errors, /not deterministically generated from the current package lock/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('advisory evidence canonicalizes commands and removes unsafe URL metadata', () => {
  const fixture = createCandidate();
  try {
    const lockfileSha256 = sha256Buffer(readFileSync(path.join(fixture.root, 'package-lock.json')));
    const versionInventorySha256 = versionInventory(fixture.packageLock).sha256;
    const policy = registryPolicy(
      fixture.packageLock,
      readFileSync(path.join(fixture.root, 'package-lock.json')),
    );
    const report = {
      auditReportVersion: 2,
      vulnerabilities: {
        example: {
          fixAvailable: false,
          isDirect: true,
          range: '<1.0.1',
          severity: 'high',
          via: [
            {
              name: 'example',
              severity: 'high',
              source: 1,
              title: 'placeholder advisory',
              url: 'https://placeholder.invalid/advisory?access_token=example-placeholder',
            },
            {
              name: 'example',
              severity: 'high',
              source: 2,
              title: 'local placeholder',
              url: 'file:///C:/Users/Example/advisory.json',
            },
          ],
        },
      },
      metadata: {
        vulnerabilities: {
          info: 0,
          low: 0,
          moderate: 0,
          high: 1,
          critical: 0,
          total: 1,
        },
      },
    };
    const advisoryPath = path.join(fixture.root, 'npm-audit.json');
    writeJson(advisoryPath, auditEnvelope(report, lockfileSha256, versionInventorySha256));
    const evidence = readAdvisoryEvidence(advisoryPath, {
      expectedLockfileSha256: lockfileSha256,
      expectedVersionInventorySha256: versionInventorySha256,
      registryPolicyEvidence: policy,
    });
    assert.equal(evidence.status, 'failed');
    assert.deepEqual(evidence.scans.production.command, {
      arguments: ['audit', '--json', '--omit=dev', '--ignore-scripts', '--cache', '<repository-local-cache>'],
      executable: 'npm',
    });
    assert.deepEqual(
      evidence.scans.complete.vulnerabilities[0].via.map((entry) => entry.url),
      [null, null],
    );
    const serialized = canonicalJson(evidence);
    assert.doesNotMatch(serialized, /access_token|example-placeholder|C:|Users[\\/]/i);

    const localCachePlaceholder = ['C:', 'Users', 'Example', 'cache'].join('\\');
    writeJson(advisoryPath, auditEnvelope(emptyAuditReport(), lockfileSha256, versionInventorySha256, {
      productionCommand: `npm audit --json --omit=dev --cache ${localCachePlaceholder}`,
    }));
    const rejected = readAdvisoryEvidence(advisoryPath, {
      expectedLockfileSha256: lockfileSha256,
      expectedVersionInventorySha256: versionInventorySha256,
      registryPolicyEvidence: policy,
    });
    assert.equal(rejected.status, 'unresolved');
    assert.doesNotMatch(canonicalJson(rejected), /C:|Users[\\/]/i);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('action pin checks cover flow-style YAML and fail closed on ambiguous uses', () => {
  const fixture = createCandidate();
  try {
    const workflowPath = path.join(fixture.root, '.github', 'workflows', 'ci.yml');
    writeFileSync(workflowPath, 'steps:\n  - { name: checkout, uses: actions/checkout@v4 }\n');
    assert.deepEqual(checkActionPins(fixture.root), [{
      code: 'GITHUB_ACTION_NOT_COMMIT_PINNED',
      line: 2,
      path: '.github/workflows/ci.yml',
      reference: 'actions/checkout@v4',
    }]);

    writeFileSync(workflowPath, `steps:\n  - { uses: "actions/checkout@${actionSha}" }\n`);
    assert.deepEqual(checkActionPins(fixture.root), []);

    writeFileSync(workflowPath, 'steps:\n  - { uses: >\n      actions/checkout@v4 }\n');
    assert.equal(checkActionPins(fixture.root)[0].code, 'WORKFLOW_USES_UNPARSED');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('artifact digest evidence reports a caller-provided comparison without an independence claim', () => {
  const fixture = createCandidate();
  try {
    const artifactPath = path.join(fixture.root, 'artifact.bin');
    writeFileSync(artifactPath, 'fixture artifact');
    const result = verifyArtifactDigest(artifactPath, sha256Buffer(readFileSync(artifactPath)));
    assert.equal(result.digestMatched, true);
    assert.equal(Object.hasOwn(result, 'independentlyVerified'), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('public scripts and policy template contain no built-in trust or evidence location', () => {
  const manifest = JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.scripts['supply-chain:check'], 'node tools/supply-chain/cli.mjs evidence');
  assert.equal(manifest.scripts['supply-chain:validate'], 'node tools/supply-chain/cli.mjs validate');
  const template = readFileSync(
    path.join(repositoryRoot, 'tools', 'supply-chain', 'registry-policy.template.json'),
    'utf8',
  );
  assert.match(template, /<approved-registry-origin>/);
  assert.match(template, /<customer-approved-sri-algorithm>/);
  assert.doesNotMatch(template, /https?:\/\/|status|attestation|approval/i);
});
