import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { isPublicSnapshotPath } from '../distribution/public-boundary-scan.mjs';
import {
  EXIT_FAILED,
  EXIT_UNRESOLVED,
  assertRegularFile,
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
  evidenceContractSchema,
  loadRepositoryInputs,
  readAdvisoryEvidence,
  readRegistryPolicyEvidence,
  releaseEvidenceTemplate,
  sha256Buffer,
  validateReleaseEvidence,
  validateReleaseReadiness,
  validateSbom,
  verifyArtifactDigest,
  summarizeLockIntegrity,
  writeCanonicalJson,
} from './evidence.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function parseArguments(argv) {
  const command = argv[0];
  if (!['evidence', 'ready', 'validate', 'verify'].includes(command)) {
    throw new TypeError(
      'usage: cli.mjs evidence --output-dir <directory> --generated-at <iso-8601-timestamp> '
      + '[--candidate <directory>] '
      + '[--advisory-input <file>] [--registry-policy <file>] '
      + '[--artifact <file> --expected-sha256 <digest>] | '
      + 'ready --candidate <directory> --evidence <file> --sbom <file> [--artifact <file>] | '
      + 'validate --evidence <file> --sbom <file> | '
      + 'verify [--artifact <file> --expected-sha256 <digest>]. '
      + 'Configure the customer-owned policy from tools/supply-chain/registry-policy.template.json; '
      + 'no registry or integrity algorithm is trusted by default.',
    );
  }
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!option?.startsWith('--') || value === undefined) {
      throw new TypeError(`option requires a value: ${option ?? '<missing>'}`);
    }
    if (Object.hasOwn(values, option)) throw new TypeError(`duplicate option: ${option}`);
    values[option] = value;
  }
  const allowedByCommand = {
    evidence: new Set([
      '--candidate',
      '--output-dir',
      '--advisory-input',
      '--artifact',
      '--expected-sha256',
      '--generated-at',
      '--registry-policy',
    ]),
    ready: new Set(['--artifact', '--candidate', '--evidence', '--sbom']),
    validate: new Set(['--evidence', '--sbom']),
    verify: new Set(['--artifact', '--expected-sha256']),
  };
  for (const option of Object.keys(values)) {
    if (!allowedByCommand[command].has(option)) {
      throw new TypeError(`option ${option} is not valid for command ${command}`);
    }
  }
  return { command, values };
}

function resolveInput(value, fallback) {
  return path.resolve(repositoryRoot, value ?? fallback);
}

function requireOption(values, option, command) {
  const value = values[option];
  if (value === undefined) {
    throw new TypeError(`option ${option} is required for command ${command}`);
  }
  return value;
}

function assertDeterministicOutputLocation(root, outputDirectory) {
  const relative = path.relative(root, outputDirectory);
  const insideCandidate = relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  if (!insideCandidate) return;
  if (relative === '') throw new Error('evidence output directory cannot be the candidate root.');
  const candidatePath = relative.split(path.sep).join('/');
  if (isPublicSnapshotPath(`${candidatePath}/release-evidence.json`)) {
    throw new Error(
      'evidence output inside the candidate must use a path excluded from the public source inventory.',
    );
  }
}

function runEvidence(values) {
  const root = resolveInput(values['--candidate'], '.');
  const outputDirectory = resolveInput(requireOption(values, '--output-dir', 'evidence'));
  const advisoryInput = values['--advisory-input']
    ? resolveInput(values['--advisory-input'])
    : undefined;
  const artifact = values['--artifact'] ? resolveInput(values['--artifact']) : undefined;
  const registryPolicyInput = values['--registry-policy']
    ? resolveInput(values['--registry-policy'])
    : undefined;
  assertDeterministicOutputLocation(root, outputDirectory);
  if (advisoryInput) assertRegularFile(advisoryInput, 'advisory input');
  if (artifact) assertRegularFile(artifact, 'artifact');
  if (registryPolicyInput) assertRegularFile(registryPolicyInput, 'registry policy input');

  const { packageJson, packageLock } = loadRepositoryInputs(root);
  const lockfileBytes = readFileSync(path.join(root, 'package-lock.json'));
  const registryPolicyEvidence = readRegistryPolicyEvidence(registryPolicyInput, {
    lockfileBytes,
  });
  const sourceInventory = createSourceInventory(root);
  const repositoryInventories = createRepositoryInventories(root);
  const sbom = createSbom(packageJson, packageLock);
  const sbomValidationErrors = validateSbom(sbom);
  const licenseInventory = createLicenseInventory(root, packageJson, packageLock);
  const dependencyPinFindings = checkDependencyPins(packageJson, packageLock, {
    registryPolicyEvidence,
  });
  const integritySummary = summarizeLockIntegrity(packageLock);
  const actionPinInventory = createActionPinInventory(root);
  const actionPinFindings = checkActionPins(root);
  const containerPinFindings = checkContainerPins(root);
  const advisoryEvidence = readAdvisoryEvidence(advisoryInput, {
    expectedLockfileSha256: repositoryInventories.lockfile.sha256,
    expectedVersionInventorySha256: repositoryInventories.versionInventory.sha256,
    registryPolicyEvidence,
  });
  const artifactDigest = verifyArtifactDigest(artifact, values['--expected-sha256']);
  const evidence = createReleaseEvidence({
    root,
    generatedAt: requireOption(values, '--generated-at', 'evidence'),
    sourceInventory,
    repositoryInventories,
    sbom,
    sbomValidationErrors,
    licenseInventory,
    dependencyPinFindings,
    integritySummary,
    registryPolicyEvidence,
    actionPinFindings,
    actionPinInventory,
    containerPinFindings,
    advisoryEvidence,
    artifactDigest,
  });
  const evidenceValidationErrors = validateReleaseEvidence(evidence);
  if (evidenceValidationErrors.length > 0) {
    throw new Error(`generated evidence validation failed: ${evidenceValidationErrors.join(' ')}`);
  }

  writeCanonicalJson(path.join(outputDirectory, 'evidence-contract.schema.json'), evidenceContractSchema());
  writeCanonicalJson(path.join(outputDirectory, 'release-evidence.template.json'), releaseEvidenceTemplate());
  writeCanonicalJson(path.join(outputDirectory, 'source-inventory.json'), sourceInventory);
  writeCanonicalJson(path.join(outputDirectory, 'repository-inventories.json'), repositoryInventories);
  writeCanonicalJson(path.join(outputDirectory, 'sbom.cdx.json'), sbom);
  writeCanonicalJson(path.join(outputDirectory, 'license-inventory.json'), licenseInventory);
  writeCanonicalJson(path.join(outputDirectory, 'dependency-advisories.json'), advisoryEvidence);
  writeCanonicalJson(
    path.join(outputDirectory, 'registry-policy-evidence.json'),
    registryPolicyEvidence ?? {
      status: 'unresolved',
      message: 'No registry policy evidence was supplied.',
    },
  );
  writeCanonicalJson(path.join(outputDirectory, 'release-evidence.json'), evidence);

  process.stdout.write(
    `Supply-chain evidence: ${evidence.releaseStatus}; ${evidence.blockers.length} blocker(s).\n`,
  );
  if (evidence.checks.some((entry) => entry.status === 'failed')) return EXIT_FAILED;
  if (evidence.checks.some((entry) => entry.status === 'unresolved')) return EXIT_UNRESOLVED;
  return 0;
}

function runReady(values) {
  const root = resolveInput(requireOption(values, '--candidate', 'ready'));
  const evidencePath = resolveInput(requireOption(values, '--evidence', 'ready'));
  const sbomPath = resolveInput(requireOption(values, '--sbom', 'ready'));
  const artifact = values['--artifact'] ? resolveInput(values['--artifact']) : undefined;
  assertRegularFile(evidencePath, 'release evidence');
  assertRegularFile(sbomPath, 'SBOM');
  if (artifact) assertRegularFile(artifact, 'artifact');
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
  const sbom = JSON.parse(readFileSync(sbomPath, 'utf8'));
  let registryPolicyEvidence = null;
  const recordedRegistryPolicy = evidence?.checks
    ?.find((entry) => entry?.id === 'dependency-pins')
    ?.registryPolicyEvidence;
  if (recordedRegistryPolicy) {
    const registryPolicyPath = path.join(
      path.dirname(evidencePath),
      evidence?.artifacts?.registryPolicyEvidence ?? '',
    );
    assertRegularFile(registryPolicyPath, 'registry policy evidence');
    registryPolicyEvidence = readRegistryPolicyEvidence(registryPolicyPath, {
      lockfileBytes: readFileSync(path.join(root, 'package-lock.json')),
    });
    if (canonicalJson(registryPolicyEvidence) !== canonicalJson(recordedRegistryPolicy)) {
      throw new Error('registry policy artifact does not match release evidence.');
    }
  }
  const errors = [
    ...validateSbom(sbom).map((message) => `sbom: ${message}`),
    ...validateReleaseReadiness(evidence, {
      artifactPath: artifact,
      candidateRoot: root,
      registryPolicyEvidence,
      sbom,
    }).map((message) => `readiness: ${message}`),
  ];
  if (errors.length > 0) {
    process.stderr.write(`${errors.join('\n')}\n`);
    return evidence.checks?.some((entry) => entry.status === 'failed')
      ? EXIT_FAILED
      : EXIT_UNRESOLVED;
  }
  process.stdout.write('Supply-chain evidence is current and release-ready for human review.\n');
  return 0;
}

function runValidate(values) {
  const evidencePath = resolveInput(requireOption(values, '--evidence', 'validate'));
  const sbomPath = resolveInput(requireOption(values, '--sbom', 'validate'));
  assertRegularFile(evidencePath, 'release evidence');
  assertRegularFile(sbomPath, 'SBOM');
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
  const sbom = JSON.parse(readFileSync(sbomPath, 'utf8'));
  const errors = [
    ...validateReleaseEvidence(evidence).map((message) => `evidence: ${message}`),
    ...validateSbom(sbom).map((message) => `sbom: ${message}`),
  ];
  if (evidence?.subject?.sbomSha256 !== sha256Buffer(canonicalJson(sbom))) {
    errors.push('sbom: content does not match evidence subject.sbomSha256.');
  }
  if (errors.length > 0) throw new Error(errors.join('\n'));
  process.stdout.write('Supply-chain evidence and SBOM are structurally valid.\n');
  return 0;
}

function runVerify(values) {
  const artifact = values['--artifact'] ? resolveInput(values['--artifact']) : undefined;
  if (artifact) assertRegularFile(artifact, 'artifact');
  const result = verifyArtifactDigest(artifact, values['--expected-sha256']);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'failed') return EXIT_FAILED;
  if (result.status === 'unresolved') return EXIT_UNRESOLVED;
  return 0;
}

try {
  const { command, values } = parseArguments(process.argv.slice(2));
  if (command === 'evidence') process.exitCode = runEvidence(values);
  else if (command === 'ready') process.exitCode = runReady(values);
  else if (command === 'validate') process.exitCode = runValidate(values);
  else process.exitCode = runVerify(values);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = EXIT_FAILED;
}
