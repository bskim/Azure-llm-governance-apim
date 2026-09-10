import {
  createHash,
  timingSafeEqual,
} from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { isPublicSnapshotPath } from '../distribution/public-boundary-scan.mjs';
import {
  assertUniquePackagePaths,
  versionInventory as createVersionInventory,
} from './lockfile.mjs';

export const CONTRACT_VERSION = '1.3.0';
export const EXIT_FAILED = 1;
export const EXIT_UNRESOLVED = 2;

const STATUS_VALUES = Object.freeze(['passed', 'failed', 'unresolved']);
const REQUIRED_CHECK_IDS = Object.freeze([
  'artifact-digest',
  'candidate-freshness',
  'container-pins',
  'dependency-advisories',
  'dependency-pins',
  'external-signing',
  'github-action-pins',
  'license-notice',
  'organizational-approval',
  'provenance',
  'registry-policy',
  'sbom',
  'source-inventory',
  'tracked-source',
]);
const PROHIBITED_ENV_FILE = /^\.env(?:\.|$)/i;
const ALLOWED_ENV_FILE = /^\.env\.(?:example|sample|template)$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const ACTION_COMMIT = /^[a-f0-9]{40}$/;
const CONTAINER_DIGEST = /@sha256:[a-f0-9]{64}$/i;
const MAX_ADVISORY_AGE_HOURS = 24;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const SUPPORTED_INTEGRITY_ALGORITHMS = Object.freeze(['sha1', 'sha256', 'sha384', 'sha512']);
const CANONICAL_AUDIT_COMMANDS = Object.freeze({
  complete: 'npm audit --json --ignore-scripts --cache <repository-local-cache>',
  production: 'npm audit --json --omit=dev --ignore-scripts --cache <repository-local-cache>',
});
const IGNORED_DIRECTORY_NAMES = new Set([
  '.git',
  '.supply-chain-work',
  'node_modules',
]);

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, sortObject(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return `${JSON.stringify(sortObject(value), null, 2)}\n`;
}

export function sha256Buffer(value) {
  return createHash('sha256').update(value).digest('hex');
}

function readJson(filePath, description) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${description} is not valid JSON: ${error.message}`);
  }
}

function normalizePath(value) {
  return value.split(path.sep).join('/');
}

export function validRegistryOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.username === ''
      && url.password === ''
      && url.pathname === '/'
      && url.search === ''
      && url.hash === '';
  } catch {
    return false;
  }
}

function listFiles(root, { publicOnly = false } = {}) {
  const files = [];
  const rejectedSecretPaths = [];
  const rejectedNonRegularPaths = [];

  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = normalizePath(path.relative(root, absolute));
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORY_NAMES.has(entry.name) || relative === 'provenance') continue;
        if (publicOnly && !isPublicSnapshotPath(`${relative}/placeholder`)) continue;
        walk(absolute);
        continue;
      }
      if (!entry.isFile()) {
        rejectedNonRegularPaths.push(relative);
        continue;
      }
      if (PROHIBITED_ENV_FILE.test(entry.name) && !ALLOWED_ENV_FILE.test(entry.name)) {
        rejectedSecretPaths.push(relative);
        continue;
      }
      if (!publicOnly || isPublicSnapshotPath(relative)) files.push(relative);
    }
  }

  walk(root);
  return {
    files: files.sort(),
    rejectedNonRegularPaths: rejectedNonRegularPaths.sort(),
    rejectedSecretPaths: rejectedSecretPaths.sort(),
  };
}

export function createSourceInventory(candidateRoot) {
  const root = path.resolve(candidateRoot);
  const listed = listFiles(root, { publicOnly: true });
  const files = listed.files.map((relativePath) => {
    const content = readFileSync(path.join(root, ...relativePath.split('/')));
    return {
      path: relativePath,
      sha256: sha256Buffer(content),
      size: content.byteLength,
    };
  });
  const inventory = {
    algorithm: 'sha256',
    candidateLabel: '.',
    files,
    rejectedNonRegularPaths: listed.rejectedNonRegularPaths,
    rejectedSecretPaths: listed.rejectedSecretPaths,
  };
  return {
    ...inventory,
    inventoryKind: 'public-candidate',
    inventorySha256: sha256Buffer(canonicalJson(inventory)),
  };
}

function inventoryFromPaths(root, paths, {
  inventoryKind,
  missingPaths = [],
  rejectedNonRegularPaths = [],
  rejectedSecretPaths = [],
} = {}) {
  const files = paths.map((relativePath) => {
    const content = readFileSync(path.join(root, ...relativePath.split('/')));
    return {
      path: relativePath,
      sha256: sha256Buffer(content),
      size: content.byteLength,
    };
  });
  const inventory = {
    algorithm: 'sha256',
    candidateLabel: '.',
    files,
    inventoryKind,
    missingPaths: [...missingPaths].sort(),
    rejectedNonRegularPaths: [...rejectedNonRegularPaths].sort(),
    rejectedSecretPaths: [...rejectedSecretPaths].sort(),
  };
  return {
    ...inventory,
    inventorySha256: sha256Buffer(canonicalJson(inventory)),
  };
}

function trackedPaths(root) {
  let output;
  try {
    output = execFileSync('git', ['ls-files', '-z'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new Error(`tracked source inventory requires git ls-files: ${error.message}`);
  }
  return output.split('\0').filter(Boolean).map(normalizePath).sort();
}

export function createRepositoryInventories(candidateRoot) {
  const root = path.resolve(candidateRoot);
  const sourceListed = listFiles(root, { publicOnly: true });
  const source = inventoryFromPaths(root, sourceListed.files, {
    inventoryKind: 'working-source',
    rejectedNonRegularPaths: sourceListed.rejectedNonRegularPaths,
    rejectedSecretPaths: sourceListed.rejectedSecretPaths,
  });

  const missingPaths = [];
  const rejectedNonRegularPaths = [];
  const rejectedSecretPaths = [];
  const presentTrackedPaths = [];
  for (const relativePath of trackedPaths(root).filter((candidate) => isPublicSnapshotPath(candidate))) {
    const absolute = path.join(root, ...relativePath.split('/'));
    if (!existsSync(absolute)) {
      missingPaths.push(relativePath);
      continue;
    }
    if (!lstatSync(absolute).isFile()) {
      rejectedNonRegularPaths.push(relativePath);
      continue;
    }
    if (PROHIBITED_ENV_FILE.test(path.posix.basename(relativePath))
      && !ALLOWED_ENV_FILE.test(path.posix.basename(relativePath))) {
      rejectedSecretPaths.push(relativePath);
      continue;
    }
    presentTrackedPaths.push(relativePath);
  }
  const tracked = inventoryFromPaths(root, presentTrackedPaths, {
    inventoryKind: 'tracked-working-source',
    missingPaths,
    rejectedNonRegularPaths,
    rejectedSecretPaths,
  });
  const publicCandidate = createSourceInventory(root);
  const lockfileSha256 = sha256Buffer(readFileSync(path.join(root, 'package-lock.json')));
  const packageLock = readJson(path.join(root, 'package-lock.json'), 'package-lock.json');
  const versionInventory = createVersionInventory(packageLock);
  return {
    algorithm: 'sha256',
    lockfile: {
      path: 'package-lock.json',
      sha256: lockfileSha256,
    },
    versionInventory,
    publicCandidate,
    source,
    tracked,
  };
}

function packageNameFromLockPath(packagePath, packageEntry) {
  if (typeof packageEntry.name === 'string' && packageEntry.name.length > 0) {
    return packageEntry.name;
  }
  const marker = 'node_modules/';
  const markerIndex = packagePath.lastIndexOf(marker);
  if (markerIndex < 0) throw new Error(`cannot derive package name from lock path: ${packagePath}`);
  const remainder = packagePath.slice(markerIndex + marker.length);
  const segments = remainder.split('/');
  return segments[0].startsWith('@') ? `${segments[0]}/${segments[1]}` : segments[0];
}

function packageRef(packagePath) {
  return `urn:package-lock:${encodeURIComponent(packagePath)}`;
}

function packagePurl(name, version) {
  return `pkg:npm/${encodeURIComponent(name).replace('%2F', '/')}@${encodeURIComponent(version)}`;
}

function sriHash(integrity) {
  if (typeof integrity !== 'string') return [];
  const match = /^(sha1|sha256|sha384|sha512)-([A-Za-z0-9+/=]+)$/.exec(integrity);
  if (!match) return [];
  const algorithms = {
    sha1: 'SHA-1',
    sha256: 'SHA-256',
    sha384: 'SHA-384',
    sha512: 'SHA-512',
  };
  return [{
    alg: algorithms[match[1]],
    content: Buffer.from(match[2], 'base64').toString('hex'),
  }];
}

function cycloneDxLicense(license) {
  if (typeof license !== 'string' || license.length === 0) return [];
  if (/[ ()]/.test(license)) return [{ expression: license }];
  return [{ license: { id: license } }];
}

function dependencyLicenseEvidence(packageEntry) {
  return {
    license: packageEntry.license ?? null,
    proof: null,
    source: 'package-lock.json',
  };
}

function resolveDependencyPath(packagePath, dependencyName, packages) {
  const suffix = `node_modules/${dependencyName}`;
  if (packagePath.length > 0) {
    const nested = `${packagePath}/${suffix}`;
    if (packages[nested]) return nested;
    let marker = packagePath.lastIndexOf('/node_modules/');
    while (marker >= 0) {
      const candidate = `${packagePath.slice(0, marker + 1)}${suffix}`;
      if (packages[candidate]) return candidate;
      marker = packagePath.lastIndexOf('/node_modules/', marker - 1);
    }
  }
  return packages[suffix] ? suffix : undefined;
}

function dependencyNames(packageEntry) {
  return [...new Set([
    ...Object.keys(packageEntry.dependencies ?? {}),
    ...Object.keys(packageEntry.optionalDependencies ?? {}),
  ])].sort();
}

function resolveDependencyRefs(packagePath, names, packages) {
  return names.map((name) => {
    const resolved = resolveDependencyPath(packagePath, name, packages);
    if (!resolved) {
      throw new Error(`SBOM dependency cannot be resolved from package-lock.json: ${packagePath || '<root>'} -> ${name}`);
    }
    return packageRef(resolved);
  }).sort();
}

export function createSbom(packageJson, packageLock) {
  if (packageLock.lockfileVersion !== 3 || !packageLock.packages?.['']) {
    throw new Error('SBOM generation requires an npm lockfileVersion 3 packages inventory.');
  }
  const rootRef = `pkg:npm/${encodeURIComponent(packageJson.name)}@${encodeURIComponent(packageJson.version)}`;
  const packageEntries = Object.entries(packageLock.packages)
    .filter(([packagePath]) => packagePath.length > 0)
    .sort(([left], [right]) => left.localeCompare(right));

  const components = packageEntries.map(([packagePath, packageEntry]) => {
    const name = packageNameFromLockPath(packagePath, packageEntry);
    const component = {
      'bom-ref': packageRef(packagePath),
      type: 'library',
      name,
      version: packageEntry.version,
      purl: packagePurl(name, packageEntry.version),
      licenses: cycloneDxLicense(
        dependencyLicenseEvidence(packageEntry).license,
      ),
      hashes: sriHash(packageEntry.integrity),
      properties: [
        { name: 'npm:install-path', value: packagePath },
        { name: 'npm:development', value: String(packageEntry.dev === true) },
        { name: 'npm:optional', value: String(packageEntry.optional === true) },
      ],
    };
    if (typeof packageEntry.resolved === 'string') {
      component.externalReferences = [{ type: 'distribution', url: packageEntry.resolved }];
    }
    return component;
  });

  const rootDependencies = {
    ...(packageJson.dependencies ?? {}),
    ...(packageJson.devDependencies ?? {}),
  };
  const dependencies = [{
    ref: rootRef,
    dependsOn: resolveDependencyRefs('', Object.keys(rootDependencies), packageLock.packages),
  }];
  for (const [packagePath, packageEntry] of packageEntries) {
    const dependsOn = resolveDependencyRefs(
      packagePath,
      dependencyNames(packageEntry),
      packageLock.packages,
    );
    dependencies.push({ ref: packageRef(packagePath), dependsOn });
  }
  dependencies.sort((left, right) => left.ref.localeCompare(right.ref));

  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: {
      component: {
        'bom-ref': rootRef,
        type: 'application',
        name: packageJson.name,
        version: packageJson.version,
        licenses: cycloneDxLicense(packageJson.license),
      },
      properties: [
        {
          name: 'evidence:determinism',
          value: 'No serial number or timestamp is emitted; components derive from package-lock.json.',
        },
        {
          name: 'evidence:validation-scope',
          value: 'Repository structural validation, not third-party CycloneDX certification.',
        },
      ],
    },
    components,
    dependencies,
  };
}

export function validateSbom(sbom) {
  const errors = [];
  if (sbom?.bomFormat !== 'CycloneDX') errors.push('bomFormat must be CycloneDX.');
  if (sbom?.specVersion !== '1.5') errors.push('specVersion must be 1.5.');
  if (sbom?.version !== 1) errors.push('version must be 1.');
  if (!Array.isArray(sbom?.components)) errors.push('components must be an array.');
  if (!Array.isArray(sbom?.dependencies)) errors.push('dependencies must be an array.');
  if (errors.length > 0) return errors;

  const rootRef = sbom.metadata?.component?.['bom-ref'];
  if (typeof rootRef !== 'string' || rootRef.length === 0) {
    errors.push('metadata.component.bom-ref is required.');
  }
  const refs = new Set(typeof rootRef === 'string' ? [rootRef] : []);
  for (const component of sbom.components) {
    const ref = component?.['bom-ref'];
    if (typeof ref !== 'string' || ref.length === 0) errors.push('every component requires a bom-ref.');
    else if (refs.has(ref)) errors.push(`duplicate bom-ref: ${ref}`);
    else refs.add(ref);
    if (typeof component?.name !== 'string' || typeof component?.version !== 'string') {
      errors.push(`component ${ref ?? '<unknown>'} requires name and version.`);
    }
  }
  const sortedComponents = [...sbom.components].sort((left, right) => (
    String(left?.['bom-ref'] ?? '').localeCompare(String(right?.['bom-ref'] ?? ''))
  ));
  if (canonicalJson(sortedComponents) !== canonicalJson(sbom.components)) {
    errors.push('components must be sorted by bom-ref.');
  }
  const sortedDependencies = [...sbom.dependencies].sort((left, right) => (
    String(left?.ref ?? '').localeCompare(String(right?.ref ?? ''))
  ));
  if (canonicalJson(sortedDependencies) !== canonicalJson(sbom.dependencies)) {
    errors.push('dependencies must be sorted by ref.');
  }
  const dependencyRefs = sbom.dependencies.map((entry) => entry?.ref);
  if (new Set(dependencyRefs).size !== dependencyRefs.length) {
    errors.push('dependency refs must be unique.');
  }
  for (const dependency of sbom.dependencies) {
    const dependencyRef = dependency?.ref;
    if (typeof dependencyRef !== 'string' || dependencyRef.length === 0) {
      errors.push('every dependency requires a ref.');
    } else if (!refs.has(dependencyRef)) {
      errors.push(`dependency ref is unknown: ${dependencyRef}`);
    }
    if (!Array.isArray(dependency?.dependsOn)) {
      errors.push(`dependsOn must be an array: ${dependencyRef ?? '<unknown>'}`);
      continue;
    }
    if (canonicalJson([...dependency.dependsOn].sort()) !== canonicalJson(dependency.dependsOn)) {
      errors.push(`dependsOn must be sorted: ${dependencyRef}`);
    }
    if (new Set(dependency.dependsOn).size !== dependency.dependsOn.length) {
      errors.push(`dependsOn refs must be unique: ${dependencyRef}`);
    }
    for (const ref of dependency.dependsOn) {
      if (!refs.has(ref)) errors.push(`dependsOn ref is unknown: ${ref}`);
    }
  }
  for (const ref of refs) {
    if (!dependencyRefs.includes(ref)) errors.push(`dependency graph entry is missing: ${ref}`);
  }
  return errors.sort();
}

function dependencyClass(packagePath, name, packageJson) {
  if (packagePath !== `node_modules/${name}`) return 'transitive';
  if (Object.hasOwn(packageJson.dependencies ?? {}, name)) return 'direct-runtime';
  if (Object.hasOwn(packageJson.devDependencies ?? {}, name)) return 'direct-development';
  return 'transitive';
}

export function createLicenseInventory(
  root,
  packageJson,
  packageLock,
) {
  const licensePath = path.join(root, 'LICENSE');
  const noticeNames = ['NOTICE', 'NOTICE.txt', 'NOTICE.md'];
  const noticeFiles = noticeNames.filter((name) => {
    const noticePath = path.join(root, name);
    return existsSync(noticePath) && lstatSync(noticePath).isFile();
  });
  const rootLicense = existsSync(licensePath) && lstatSync(licensePath).isFile()
    ? {
        declared: packageJson.license ?? null,
        file: 'LICENSE',
        sha256: sha256Buffer(readFileSync(licensePath)),
      }
    : {
        declared: packageJson.license ?? null,
        file: null,
        sha256: null,
      };
  const packages = Object.entries(packageLock.packages ?? {})
    .filter(([packagePath]) => packagePath.length > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([packagePath, packageEntry]) => {
      const name = packageNameFromLockPath(packagePath, packageEntry);
      const licenseEvidence = dependencyLicenseEvidence(packageEntry);
      return {
        dependencyClass: dependencyClass(packagePath, name, packageJson),
        installPath: packagePath,
        license: licenseEvidence.license,
        licenseProof: licenseEvidence.proof,
        licenseSource: licenseEvidence.source,
        name,
        version: packageEntry.version ?? null,
      };
    });
  const licenseCounts = {};
  for (const entry of packages) {
    const key = entry.license ?? 'UNKNOWN';
    licenseCounts[key] = (licenseCounts[key] ?? 0) + 1;
  }
  return {
    evidenceScope: 'Factual package-lock.json metadata only; customers own license and notice review.',
    licenseCounts: sortObject(licenseCounts),
    noticeFiles,
    packages,
    root: rootLicense,
    unknownLicensePackages: packages
      .filter((entry) => entry.license === null)
      .map((entry) => `${entry.name}@${entry.version}`)
      .sort(),
  };
}

function exactVersion(value) {
  return typeof value === 'string'
    && /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(value);
}

function validSha512Integrity(value) {
  return typeof value === 'string' && /^sha512-[A-Za-z0-9+/]{86}==$/.test(value);
}

function validSupportedIntegrity(value) {
  if (typeof value !== 'string') return false;
  const match = /^(sha1|sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return false;
  const expectedBytes = { sha1: 20, sha256: 32, sha384: 48, sha512: 64 };
  try {
    return Buffer.from(match[2], 'base64').length === expectedBytes[match[1]];
  } catch {
    return false;
  }
}

export function summarizeLockIntegrity(packageLock) {
  const algorithms = {};
  let invalidCount = 0;
  let missingCount = 0;
  let resolvedCount = 0;
  let strongCount = 0;
  let weakCount = 0;
  for (const [packagePath, packageEntry] of Object.entries(packageLock.packages ?? {})) {
    if (packagePath.length === 0 || packageEntry.link === true) continue;
    resolvedCount += 1;
    if (typeof packageEntry.integrity !== 'string') {
      missingCount += 1;
      continue;
    }
    const algorithm = packageEntry.integrity.split('-', 1)[0];
    algorithms[algorithm] = (algorithms[algorithm] ?? 0) + 1;
    if (validSha512Integrity(packageEntry.integrity)) strongCount += 1;
    else if (validSupportedIntegrity(packageEntry.integrity)) weakCount += 1;
    else invalidCount += 1;
  }
  return {
    algorithms: sortObject(algorithms),
    invalidCount,
    missingCount,
    resolvedCount,
    status: missingCount > 0 || invalidCount > 0 ? 'failed' : 'passed',
    strongCount,
    weakCount,
  };
}

export function checkDependencyPins(packageJson, packageLock, { registryPolicyEvidence } = {}) {
  const findings = [];
  const allowedIntegrityAlgorithms = new Set(
    registryPolicyEvidence?.allowedIntegrityAlgorithms ?? [],
  );
  if (!registryPolicyEvidence) {
    findings.push({
      code: 'REGISTRY_POLICY_REQUIRED',
      path: 'package-lock.json',
      subject: 'registry-policy',
    });
  }
  const direct = {
    ...(packageJson.dependencies ?? {}),
    ...(packageJson.devDependencies ?? {}),
  };
  for (const [name, version] of Object.entries(direct).sort(([left], [right]) => left.localeCompare(right))) {
    if (!exactVersion(version)) {
      findings.push({
        code: 'DIRECT_DEPENDENCY_NOT_EXACT',
        path: 'package.json',
        subject: name,
        value: version,
      });
    }
    const locked = packageLock.packages?.['']?.dependencies?.[name]
      ?? packageLock.packages?.['']?.devDependencies?.[name];
    if (locked !== version) {
      findings.push({
        code: 'LOCK_ROOT_MISMATCH',
        path: 'package-lock.json',
        subject: name,
        value: locked ?? null,
      });
    }
    const lockedPackage = packageLock.packages?.[`node_modules/${name}`];
    if (!lockedPackage) {
      findings.push({
        code: 'LOCKED_PACKAGE_MISSING',
        path: 'package-lock.json',
        subject: name,
      });
    } else if (lockedPackage.version !== version) {
      findings.push({
        code: 'LOCKED_VERSION_MISMATCH',
        path: 'package-lock.json',
        subject: name,
        value: lockedPackage.version ?? null,
      });
    }
  }
  for (const [packagePath, packageEntry] of Object.entries(packageLock.packages ?? {})
    .sort(([left], [right]) => left.localeCompare(right))) {
    if (packagePath.length === 0 || packageEntry.link === true) continue;
    if (!exactVersion(packageEntry.version)) {
      findings.push({ code: 'LOCK_VERSION_NOT_EXACT', path: 'package-lock.json', subject: packagePath });
    }
    if (typeof packageEntry.resolved !== 'string') {
      findings.push({ code: 'LOCK_RESOLVED_MISSING', path: 'package-lock.json', subject: packagePath });
    }
    if (typeof packageEntry.integrity !== 'string') {
      findings.push({ code: 'LOCK_INTEGRITY_MISSING', path: 'package-lock.json', subject: packagePath });
    } else if (!validSupportedIntegrity(packageEntry.integrity)) {
      findings.push({
        code: 'LOCK_INTEGRITY_INVALID',
        path: 'package-lock.json',
        subject: packagePath,
        value: packageEntry.integrity.split('-', 1)[0],
      });
    } else if (registryPolicyEvidence
      && !allowedIntegrityAlgorithms.has(packageEntry.integrity.split('-', 1)[0])) {
      findings.push({
        code: 'LOCK_INTEGRITY_ALGORITHM_NOT_ALLOWED',
        path: 'package-lock.json',
        subject: packagePath,
        value: packageEntry.integrity.split('-', 1)[0],
      });
    }
  }
  return findings;
}

export function readRegistryPolicyEvidence(inputPath, { lockfileBytes } = {}) {
  if (!inputPath) return null;
  if (!Buffer.isBuffer(lockfileBytes) && typeof lockfileBytes !== 'string') {
    throw new Error('current package-lock.json bytes are required for registry policy validation.');
  }
  const policy = readJson(inputPath, 'registry policy');
  const requiredKeys = [
    'allowedIntegrityAlgorithms',
    'approvedRegistryOrigins',
    'effectiveRegistryOrigin',
    'exactVersionsRequired',
    'integrityRequired',
    'lockfileSha256',
    'packageManagerIntegrityEnforced',
    'schemaVersion',
    'versionInventorySha256',
  ];
  if (canonicalJson(Object.keys(policy ?? {}).sort()) !== canonicalJson(requiredKeys)) {
    throw new Error('registry policy must use the complete environment-neutral schema without extra fields.');
  }
  const currentBytes = Buffer.isBuffer(lockfileBytes)
    ? lockfileBytes
    : Buffer.from(lockfileBytes);
  const currentText = currentBytes.toString('utf8');
  const currentLock = JSON.parse(currentText);
  assertUniquePackagePaths(currentText, currentLock);
  const currentInventory = createVersionInventory(currentLock);
  const approvedOrigins = policy.approvedRegistryOrigins;
  const allowedAlgorithms = policy.allowedIntegrityAlgorithms;
  if (policy.schemaVersion !== 1
    || !Array.isArray(approvedOrigins)
    || approvedOrigins.length === 0
    || new Set(approvedOrigins).size !== approvedOrigins.length
    || !approvedOrigins.every(validRegistryOrigin)
    || !validRegistryOrigin(policy.effectiveRegistryOrigin)
    || !approvedOrigins.includes(policy.effectiveRegistryOrigin)
    || !Array.isArray(allowedAlgorithms)
    || allowedAlgorithms.length === 0
    || new Set(allowedAlgorithms).size !== allowedAlgorithms.length
    || !allowedAlgorithms.every((algorithm) => SUPPORTED_INTEGRITY_ALGORITHMS.includes(algorithm))
    || policy.exactVersionsRequired !== true
    || policy.integrityRequired !== true
    || policy.packageManagerIntegrityEnforced !== true
    || policy.lockfileSha256 !== sha256Buffer(currentBytes)
    || policy.versionInventorySha256 !== currentInventory.sha256) {
    throw new Error('registry policy is incomplete, unsafe, or not bound to the current lockfile.');
  }
  return sortObject(policy);
}

function workflowFiles(root) {
  const directory = path.join(root, '.github', 'workflows');
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => /\.(?:ya?ml)$/i.test(name))
    .sort()
    .map((name) => path.join(directory, name))
    .filter((filePath) => isPublicSnapshotPath(normalizePath(path.relative(root, filePath))));
}

function lineNumberAt(content, offset) {
  return content.slice(0, offset).split(/\r?\n/).length;
}

function stripYamlComment(line) {
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote === "'") {
      if (character === "'" && line[index + 1] === "'") index += 1;
      else if (character === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (character === '\\') index += 1;
      else if (character === '"') quote = null;
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === '#') return line.slice(0, index);
  }
  return line;
}

function workflowUsesOnLine(line) {
  const content = stripYamlComment(line);
  const entries = [];
  let quote = null;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (quote === "'") {
      if (character === "'" && content[index + 1] === "'") index += 1;
      else if (character === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (character === '\\') index += 1;
      else if (character === '"') quote = null;
      continue;
    }
    const prefix = content.slice(0, index);
    const keyPosition = prefix.trim().length === 0
      || /^\s*-\s*$/.test(prefix)
      || /[,{]\s*$/.test(prefix);
    const keyMatch = keyPosition
      ? /^(?:"uses"|'uses'|uses)\s*:/.exec(content.slice(index))
      : null;
    if (!keyMatch) {
      if (character === "'" || character === '"') quote = character;
      continue;
    }

    let valueIndex = index + keyMatch[0].length;
    while (/[ \t]/.test(content[valueIndex] ?? '')) valueIndex += 1;
    if (valueIndex >= content.length) {
      entries.push({ unparsed: true });
      break;
    }

    const valueQuote = content[valueIndex];
    let reference = '';
    if (valueQuote === "'" || valueQuote === '"') {
      valueIndex += 1;
      let closed = false;
      for (; valueIndex < content.length; valueIndex += 1) {
        const valueCharacter = content[valueIndex];
        if (valueQuote === "'" && valueCharacter === "'" && content[valueIndex + 1] === "'") {
          reference += "'";
          valueIndex += 1;
        } else if (valueQuote === '"' && valueCharacter === '\\') {
          reference += content[valueIndex + 1] ?? '';
          valueIndex += 1;
        } else if (valueCharacter === valueQuote) {
          closed = true;
          break;
        } else {
          reference += valueCharacter;
        }
      }
      if (!closed) entries.push({ unparsed: true });
      else entries.push({ reference });
    } else {
      const valueMatch = /^[^\s,}]+/.exec(content.slice(valueIndex));
      if (!valueMatch || ['|', '>', '&', '*'].includes(valueMatch[0][0])) {
        entries.push({ unparsed: true });
      } else {
        entries.push({ reference: valueMatch[0] });
      }
    }
    index = valueIndex;
  }
  return entries;
}

function actionPinFindings(root, files) {
  const findings = [];
  for (const filePath of files) {
    const content = readFileSync(filePath, 'utf8');
    const relativePath = normalizePath(path.relative(root, filePath));
    for (const [lineIndex, line] of content.split(/\r?\n/).entries()) {
      for (const parsed of workflowUsesOnLine(line)) {
        if (parsed.unparsed || !parsed.reference) {
          findings.push({
            code: 'WORKFLOW_USES_UNPARSED',
            line: lineIndex + 1,
            path: relativePath,
            reference: null,
          });
          continue;
        }
        const { reference } = parsed;
        if (reference.startsWith('./')) continue;
        if (reference.startsWith('docker://')) {
          const image = reference.slice('docker://'.length);
          if (!CONTAINER_DIGEST.test(image)) {
            findings.push({
              code: 'WORKFLOW_CONTAINER_NOT_DIGEST_PINNED',
              line: lineIndex + 1,
              path: relativePath,
              reference,
            });
          }
          continue;
        }
        const at = reference.lastIndexOf('@');
        const revision = at >= 0 ? reference.slice(at + 1) : '';
        if (!ACTION_COMMIT.test(revision)) {
          findings.push({
            code: 'GITHUB_ACTION_NOT_COMMIT_PINNED',
            line: lineIndex + 1,
            path: relativePath,
            reference,
          });
        }
      }
    }
  }
  return findings;
}

export function createActionPinInventory(root) {
  const productOwnedFiles = workflowFiles(root);
  const summarize = (filePath) => normalizePath(path.relative(root, filePath));
  return {
    productOwned: {
      findings: actionPinFindings(root, productOwnedFiles),
      workflows: productOwnedFiles.map(summarize),
    },
  };
}

export function checkActionPins(root) {
  return createActionPinInventory(root).productOwned.findings;
}

export function checkContainerPins(root) {
  const findings = [];
  const listed = listFiles(root, { publicOnly: true });
  for (const relativePath of listed.files) {
    const fileName = path.posix.basename(relativePath);
    const extension = path.posix.extname(relativePath).toLowerCase();
    const isDockerfile = /^Dockerfile(?:\.|$)/i.test(fileName);
    if (!isDockerfile && !['.yaml', '.yml', '.json'].includes(extension)) continue;
    const content = readFileSync(path.join(root, ...relativePath.split('/')), 'utf8');
    const patterns = [];
    if (isDockerfile) {
      patterns.push(/^[ \t]*FROM(?:[ \t]+--platform=\S+)?[ \t]+([^\s#]+)/gim);
    }
    if (extension === '.yaml' || extension === '.yml') {
      patterns.push(/^[ \t]*(?:-[ \t]*)?image:[ \t]*["']?([^"'#\s]+)["']?/gim);
    }
    if (extension === '.json') patterns.push(/"image"\s*:\s*"([^"]+)"/gim);
    for (const expression of patterns) {
      for (const match of content.matchAll(expression)) {
        const reference = match[1];
        if (reference.toLowerCase() === 'scratch') continue;
        if (!CONTAINER_DIGEST.test(reference)) {
          findings.push({
            code: 'CONTAINER_NOT_DIGEST_PINNED',
            line: lineNumberAt(content, match.index),
            path: relativePath,
            reference,
          });
        }
      }
    }
  }
  return findings;
}

function safeAdvisoryUrl(value) {
  if (typeof value !== 'string'
    || /^[A-Za-z]:[\\/]|^\\\\|^file:/i.test(value)
    || /(?:bearer|token|secret|password|credential|api[-_]?key)/i.test(value)) {
    return null;
  }
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (!['http:', 'https:'].includes(url.protocol)
      || url.username !== ''
      || url.password !== ''
      || url.search !== ''
      || url.hash !== ''
      || hostname === 'localhost'
      || hostname === '::1'
      || /^127\.|^10\.|^192\.168\.|^169\.254\.|^172\.(?:1[6-9]|2\d|3[01])\./.test(hostname)) {
      return null;
    }
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

function normalizeAdvisoryVia(via) {
  if (typeof via === 'string') return via;
  if (!via || typeof via !== 'object') return String(via);
  return {
    name: via.name ?? null,
    severity: via.severity ?? null,
    source: via.source ?? null,
    title: via.title ?? null,
    url: safeAdvisoryUrl(via.url),
  };
}

function normalizeAuditReport(report, scope) {
  if (report.error) {
    return {
      status: 'unresolved',
      scope,
      summary: null,
      vulnerabilities: [],
      message: `The supplied advisory report contains an npm error: ${report.error.summary ?? report.error.code ?? 'unknown error'}.`,
    };
  }
  const summary = report.metadata?.vulnerabilities;
  if (report.auditReportVersion !== 2
    || !summary
    || typeof summary !== 'object'
    || Array.isArray(summary)
    || !Object.values(summary).every((value) => Number.isInteger(value) && value >= 0)
  ) {
    return {
      status: 'unresolved',
      scope,
      summary: null,
      vulnerabilities: [],
      message: 'The supplied advisory report is not a complete npm audit reportVersion 2 summary.',
    };
  }
  const severityTotal = Object.entries(summary)
    .filter(([key]) => key !== 'total')
    .reduce((sum, [, value]) => sum + value, 0);
  if (summary.total !== undefined && summary.total !== severityTotal) {
    return {
      status: 'unresolved',
      scope,
      summary: null,
      vulnerabilities: [],
      message: 'The supplied npm audit report total does not match its severity counts.',
    };
  }
  const vulnerabilityEntries = report.vulnerabilities
    && typeof report.vulnerabilities === 'object'
    && !Array.isArray(report.vulnerabilities)
    ? Object.entries(report.vulnerabilities)
    : [];
  const total = summary.total ?? severityTotal;
  if (vulnerabilityEntries.some(([, vulnerability]) => (
    !vulnerability || typeof vulnerability !== 'object' || Array.isArray(vulnerability)
  )) || (total === 0 && vulnerabilityEntries.length > 0)
    || (total > 0 && vulnerabilityEntries.length === 0)) {
    return {
      status: 'unresolved',
      scope,
      summary: null,
      vulnerabilities: [],
      message: 'The supplied npm audit report has inconsistent summary and vulnerability records.',
    };
  }
  const vulnerabilities = vulnerabilityEntries
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, vulnerability]) => ({
      fixAvailable: vulnerability.fixAvailable ?? null,
      isDirect: vulnerability.isDirect === true,
      name,
      range: vulnerability.range ?? null,
      severity: vulnerability.severity ?? null,
      via: (Array.isArray(vulnerability.via) ? vulnerability.via : []).map(normalizeAdvisoryVia),
    }));
  return {
    status: total === 0 ? 'passed' : 'failed',
    scope,
    summary: sortObject(summary),
    vulnerabilities,
    message: total === 0
      ? 'The supplied npm audit report contains zero vulnerabilities.'
      : `The supplied npm audit report contains ${total} vulnerability record(s).`,
  };
}

function normalizedAuditMetadata(envelope, registryPolicyEvidence) {
  let registry;
  try {
    registry = new URL(envelope?.metadata?.registryOrigin);
  } catch {
    return null;
  }
  const nodeVersion = envelope?.metadata?.nodeVersion;
  const npmVersion = envelope?.metadata?.npmVersion;
  if (typeof envelope?.executedAt !== 'string'
    || Number.isNaN(Date.parse(envelope.executedAt))
    || typeof nodeVersion !== 'string'
    || !/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(nodeVersion)
    || typeof npmVersion !== 'string'
    || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(npmVersion)
    || !registryPolicyEvidence
    || !validRegistryOrigin(envelope?.metadata?.registryOrigin)
    || registry.origin !== registryPolicyEvidence.effectiveRegistryOrigin) {
    return null;
  }
  return {
    nodeVersion,
    npmVersion,
    registryOrigin: registry.origin,
  };
}

function canonicalAuditCommand(scope) {
  return {
    arguments: scope === 'production'
      ? ['audit', '--json', '--omit=dev', '--ignore-scripts', '--cache', '<repository-local-cache>']
      : ['audit', '--json', '--ignore-scripts', '--cache', '<repository-local-cache>'],
    executable: 'npm',
  };
}

export function readAdvisoryEvidence(advisoryInput, {
  expectedLockfileSha256,
  expectedVersionInventorySha256,
  registryPolicyEvidence,
} = {}) {
  if (!advisoryInput) {
    return {
      status: 'unresolved',
      source: null,
      scans: null,
      message: 'No dual-scope npm audit envelope was supplied; advisory availability was not assumed.',
    };
  }
  const envelope = readJson(advisoryInput, 'advisory input');
  const metadata = normalizedAuditMetadata(envelope, registryPolicyEvidence);
  if (envelope?.schemaVersion !== 1 || !metadata) {
    return {
      status: 'unresolved',
      source: 'npm-audit-envelope',
      scans: null,
      message: 'The supplied advisory envelope lacks sanitized timestamp, Node/npm, or registry-origin metadata.',
    };
  }
  const requiredScopes = ['production', 'complete'];
  const scans = {};
  for (const scope of requiredScopes) {
    const supplied = envelope.scans?.[scope];
    const directBinding = supplied?.lockfileSha256 === expectedLockfileSha256
      && supplied?.versionInventorySha256 === expectedVersionInventorySha256;
    if (!supplied
      || supplied.exitCode !== 0
      || typeof supplied.command !== 'string'
      || supplied.command !== CANONICAL_AUDIT_COMMANDS[scope]
      || !SHA256.test(supplied.lockfileSha256 ?? '')
      || !SHA256.test(supplied.versionInventorySha256 ?? '')
      || !directBinding
    ) {
      return {
        status: 'unresolved',
        source: 'npm-audit-envelope',
        scans: null,
        message: `The ${scope} npm audit scan is missing, unsafe, unsuccessful, or not bound to the current exact-version inventory.`,
      };
    }
    scans[scope] = {
      bindingMode: 'exact-lockfile',
      command: canonicalAuditCommand(scope),
      exitCode: supplied.exitCode,
      lockfileSha256: supplied.lockfileSha256,
      versionInventorySha256: supplied.versionInventorySha256,
      ...normalizeAuditReport(supplied.report, scope),
    };
  }
  const status = requiredScopes.some((scope) => scans[scope].status === 'failed')
    ? 'failed'
    : requiredScopes.some((scope) => scans[scope].status === 'unresolved')
      ? 'unresolved'
      : 'passed';
  return {
    executedAt: envelope.executedAt,
    message: status === 'passed'
      ? 'Production and complete npm audit scans both contain zero vulnerabilities.'
      : 'Production and complete npm audit scans did not both pass.',
    metadata,
    scans: sortObject(scans),
    source: 'npm-audit-envelope',
    status,
  };
}

export function verifyArtifactDigest(artifactPath, expectedSha256) {
  if (!artifactPath || !expectedSha256) {
    return {
      status: 'unresolved',
      actualSha256: null,
      artifactName: artifactPath ? path.basename(artifactPath) : null,
      digestMatched: false,
      expectedSha256: expectedSha256 ?? null,
      message: 'Both an artifact path and an expected SHA-256 digest are required.',
    };
  }
  const expected = expectedSha256.toLowerCase();
  if (!SHA256.test(expected)) {
    throw new TypeError('expected SHA-256 must be exactly 64 hexadecimal characters.');
  }
  const actual = sha256Buffer(readFileSync(artifactPath));
  const matches = timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
  return {
    status: matches ? 'passed' : 'failed',
    actualSha256: actual,
    artifactName: path.basename(artifactPath),
    artifactSize: lstatSync(artifactPath).size,
    expectedSha256: expected,
    digestMatched: matches,
    message: matches ? 'Artifact SHA-256 matches the expected digest.' : 'Artifact SHA-256 does not match.',
  };
}

function check(id, status, summary, details = {}) {
  return { ...details, id, status, summary };
}

function blocker(id, checkId, message) {
  return { id, checkId, message };
}

export function createReleaseEvidence({
  root,
  generatedAt,
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
}) {
  const checks = [];
  const blockers = [];
  const inventories = repositoryInventories ?? {
    lockfile: { sha256: sha256Buffer(readFileSync(path.join(root, 'package-lock.json'))) },
    publicCandidate: sourceInventory,
    source: sourceInventory,
    tracked: {
      ...sourceInventory,
      missingPaths: [],
    },
  };
  const publicInventory = inventories.publicCandidate;

  const sourceStatus = publicInventory.rejectedSecretPaths.length === 0
    && publicInventory.rejectedNonRegularPaths.length === 0 ? 'passed' : 'failed';
  checks.push(check('source-inventory', sourceStatus, `${publicInventory.files.length} public candidate file(s) inventoried.`, {
    inventorySha256: publicInventory.inventorySha256,
    rejectedNonRegularPaths: publicInventory.rejectedNonRegularPaths,
    rejectedSecretPaths: publicInventory.rejectedSecretPaths,
  }));
  if (sourceStatus === 'failed') {
    blockers.push(blocker(
      'SOURCE_INVENTORY_REJECTED_PATHS',
      'source-inventory',
      'Candidate contains prohibited environment files or non-regular filesystem entries.',
    ));
  }

  const trackedStatus = inventories.tracked.missingPaths.length === 0
    && inventories.tracked.rejectedSecretPaths.length === 0
    && inventories.tracked.rejectedNonRegularPaths.length === 0 ? 'passed' : 'failed';
  checks.push(check('tracked-source', trackedStatus, `${inventories.tracked.files.length} tracked working-source file(s) inventoried.`, {
    inventorySha256: inventories.tracked.inventorySha256,
    missingPaths: inventories.tracked.missingPaths,
    rejectedNonRegularPaths: inventories.tracked.rejectedNonRegularPaths,
    rejectedSecretPaths: inventories.tracked.rejectedSecretPaths,
  }));
  if (trackedStatus === 'failed') {
    blockers.push(blocker(
      'TRACKED_SOURCE_INCOMPLETE',
      'tracked-source',
      'One or more tracked source paths are missing, non-regular, or prohibited secret paths.',
    ));
  }

  const generatedTime = Date.parse(generatedAt);
  const freshnessStatus = typeof generatedAt === 'string' && !Number.isNaN(generatedTime)
    ? 'passed'
    : 'failed';
  checks.push(check(
    'candidate-freshness',
    freshnessStatus,
    freshnessStatus === 'passed'
      ? `Evidence was generated at ${generatedAt}; readiness validation must rebind it to the current candidate.`
      : 'Evidence generation timestamp is missing or invalid.',
    {
      generatedAt: freshnessStatus === 'passed' ? generatedAt : null,
      maximumAgeHours: 24,
    },
  ));
  if (freshnessStatus === 'failed') {
    blockers.push(blocker(
      'EVIDENCE_TIMESTAMP_INVALID',
      'candidate-freshness',
      'A valid explicit generation timestamp is required.',
    ));
  }

  const sbomStatus = sbomValidationErrors.length === 0 ? 'passed' : 'failed';
  const sbomSha256 = sha256Buffer(canonicalJson(sbom));
  checks.push(check('sbom', sbomStatus, `${sbom.components.length} locked component(s) emitted.`, {
    format: 'CycloneDX 1.5',
    sha256: sbomSha256,
    validation: 'repository-structural',
    validationErrors: sbomValidationErrors,
  }));
  if (sbomStatus === 'failed') {
    blockers.push(blocker('SBOM_VALIDATION_FAILED', 'sbom', 'Generated SBOM failed repository structural validation.'));
  }

  const lockIntegrity = integritySummary ?? {
    status: dependencyPinFindings.length === 0 ? 'passed' : 'failed',
    weakCount: dependencyPinFindings
      .filter((entry) => entry.code === 'LOCK_INTEGRITY_ALGORITHM_NOT_ALLOWED').length,
  };
  const dependencyStatus = dependencyPinFindings.length === 0 && lockIntegrity.status === 'passed'
    ? 'passed'
    : 'failed';
  checks.push(check('dependency-pins', dependencyStatus, `${dependencyPinFindings.length} dependency pin finding(s).`, {
    findings: dependencyPinFindings,
    integritySummary: lockIntegrity,
    registryPolicyEvidence,
    warnings: lockIntegrity.weakCount > 0
      ? [`${lockIntegrity.weakCount} package(s) use an integrity algorithm below SHA-512; review this advisory against customer policy.`]
      : [],
  }));
  if (dependencyStatus === 'failed') {
    blockers.push(blocker(
      'DEPENDENCY_PIN_FINDINGS',
      'dependency-pins',
      'Lockfile entries are missing exact versions, valid integrity, or explicit registry-policy binding.',
    ));
  }

  const registryPolicyStatus = registryPolicyEvidence ? 'passed' : 'failed';
  checks.push(check(
    'registry-policy',
    registryPolicyStatus,
    registryPolicyEvidence
      ? 'The effective package origin and integrity algorithms match the explicit customer registry policy.'
      : 'No current-lock-bound customer registry policy was supplied.',
    {
      allowedIntegrityAlgorithms: registryPolicyEvidence?.allowedIntegrityAlgorithms ?? [],
      approvedRegistryOrigins: registryPolicyEvidence?.approvedRegistryOrigins ?? [],
      effectiveRegistryOrigin: registryPolicyEvidence?.effectiveRegistryOrigin ?? null,
      exactVersionsRequired: registryPolicyEvidence?.exactVersionsRequired ?? false,
      integrityRequired: registryPolicyEvidence?.integrityRequired ?? false,
      packageManagerIntegrityEnforced:
        registryPolicyEvidence?.packageManagerIntegrityEnforced ?? false,
    },
  ));
  if (registryPolicyStatus === 'failed') {
    blockers.push(blocker(
      'REGISTRY_POLICY_INVALID',
      'registry-policy',
      'Configure an approved registry origin and integrity policy explicitly; arbitrary registries are never trusted implicitly.',
    ));
  }

  const actionInventory = actionPinInventory ?? {
    productOwned: { findings: actionPinFindings, workflows: [] },
  };
  const productActionFindings = actionInventory.productOwned.findings;
  const actionStatus = productActionFindings.length === 0 ? 'passed' : 'failed';
  checks.push(check('github-action-pins', actionStatus, `${productActionFindings.length} product-owned action pin finding(s).`, {
    findings: productActionFindings,
    workflows: actionInventory.productOwned.workflows,
  }));
  if (actionStatus === 'failed') {
    blockers.push(blocker(
      'GITHUB_ACTION_PIN_FINDINGS',
      'github-action-pins',
      'Every remote GitHub Action must use a full 40-character commit SHA.',
    ));
  }

  const containerStatus = containerPinFindings.length === 0 ? 'passed' : 'failed';
  checks.push(check('container-pins', containerStatus, `${containerPinFindings.length} container pin finding(s).`, {
    findings: containerPinFindings,
  }));
  if (containerStatus === 'failed') {
    blockers.push(blocker(
      'CONTAINER_PIN_FINDINGS',
      'container-pins',
      'Every container image must use an immutable sha256 digest.',
    ));
  }

  checks.push(check(
    'dependency-advisories',
    advisoryEvidence.status,
    advisoryEvidence.message,
    {
      executedAt: advisoryEvidence.executedAt ?? null,
      metadata: advisoryEvidence.metadata ?? null,
      scans: advisoryEvidence.scans,
      source: advisoryEvidence.source,
    },
  ));
  if (advisoryEvidence.status === 'failed') {
    blockers.push(blocker(
      'DEPENDENCY_ADVISORIES_FOUND',
      'dependency-advisories',
      'The supplied advisory report contains dependency vulnerabilities.',
    ));
  } else if (advisoryEvidence.status === 'unresolved') {
    blockers.push(blocker(
      'ADVISORY_SOURCE_UNAVAILABLE',
      'dependency-advisories',
      'Supply a successful npm audit --json result; offline generation does not silently claim advisory coverage.',
    ));
  }

  const ownershipUnverified = licenseInventory.root.file === null;
  const noticeUnresolved = licenseInventory.noticeFiles.length === 0;
  const unknownLicenses = licenseInventory.unknownLicensePackages.length > 0;
  const legalStatus = ownershipUnverified || noticeUnresolved || unknownLicenses
    ? 'unresolved'
    : 'passed';
  checks.push(check('license-notice', legalStatus, `${licenseInventory.packages.length} dependency license record(s) inventoried.`, {
    noticeFiles: licenseInventory.noticeFiles,
    ownershipUnverified,
    scope: licenseInventory.evidenceScope,
  }));
  if (ownershipUnverified) {
    blockers.push(blocker(
      'LEGAL_OWNERSHIP_UNVERIFIED',
      'license-notice',
      'A repository license file is required; the customer remains responsible for legal review.',
    ));
  }
  if (noticeUnresolved) {
    blockers.push(blocker(
      'NOTICE_DETERMINATION_REQUIRED',
      'license-notice',
      'No NOTICE file exists; a legal owner must determine third-party notice obligations from the factual inventory.',
    ));
  }
  if (unknownLicenses) {
    blockers.push(blocker(
      'DEPENDENCY_LICENSES_UNKNOWN',
      'license-notice',
      'One or more dependency records have no factual license evidence and require legal review.',
    ));
  }

  checks.push(check('artifact-digest', artifactDigest.status, artifactDigest.message, {
    actualSha256: artifactDigest.actualSha256,
    artifactName: artifactDigest.artifactName,
    artifactSize: artifactDigest.artifactSize ?? null,
    digestMatched: artifactDigest.digestMatched,
    expectedSha256: artifactDigest.expectedSha256,
  }));
  if (artifactDigest.status !== 'passed') {
    blockers.push(blocker(
      artifactDigest.status === 'failed' ? 'ARTIFACT_DIGEST_MISMATCH' : 'ARTIFACT_DIGEST_REQUIRED',
      'artifact-digest',
      artifactDigest.message,
    ));
  }

  checks.push(check(
    'external-signing',
    'unresolved',
    'No external signing service was called and no signature or provenance claim is emitted.',
  ));
  blockers.push(blocker(
    'EXTERNAL_SIGNING_REQUIRED',
    'external-signing',
    'External signing and provenance, if required, must be produced and verified by an authorized release process.',
  ));

  checks.push(check(
    'provenance',
    'unresolved',
    'No externally verifiable provenance attestation is present.',
  ));
  blockers.push(blocker(
    'PROVENANCE_ATTESTATION_REQUIRED',
    'provenance',
    'An authorized external process must attest the candidate, builder, invocation, SBOM, and artifact digest.',
  ));

  checks.push(check(
    'organizational-approval',
    'unresolved',
    'Generated repository evidence is not organizational approval.',
  ));
  blockers.push(blocker(
    'ORGANIZATIONAL_APPROVAL_REQUIRED',
    'organizational-approval',
    'An authorized organizational approver must make a separate decision outside this generated evidence.',
  ));

  checks.sort((left, right) => left.id.localeCompare(right.id));
  blockers.sort((left, right) => (
    left.id.localeCompare(right.id) || left.checkId.localeCompare(right.checkId)
  ));
  return {
    contractVersion: CONTRACT_VERSION,
    evidenceKind: 'repository-supply-chain-release-evidence',
    generatedEvidence: {
      isGeneratedEvidence: true,
      organizationalApproval: false,
      provenanceVerified: false,
      provenanceClaims: [],
      signatureVerified: false,
      signatureClaims: [],
    },
    generatedAt: freshnessStatus === 'passed' ? generatedAt : null,
    subject: {
      candidateLabel: publicInventory.candidateLabel,
      lockfileSha256: inventories.lockfile.sha256,
      versionInventorySha256: inventories.versionInventory.sha256,
      publicCandidateInventorySha256: publicInventory.inventorySha256,
      sbomSha256,
      sourceInventorySha256: inventories.source.inventorySha256,
      trackedSourceInventorySha256: inventories.tracked.inventorySha256,
    },
    artifacts: {
      dependencyAdvisories: 'dependency-advisories.json',
      licenseInventory: 'license-inventory.json',
      registryPolicyEvidence: 'registry-policy-evidence.json',
      repositoryInventories: 'repository-inventories.json',
      sbom: 'sbom.cdx.json',
      sourceInventory: 'source-inventory.json',
    },
    checks,
    blockers,
    releaseStatus: blockers.length === 0 ? 'eligible-for-human-review' : 'blocked',
  };
}

export function evidenceContractSchema() {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'urn:llm-governance-apim:supply-chain-release-evidence:v1',
    type: 'object',
    additionalProperties: false,
    required: [
      'contractVersion',
      'evidenceKind',
      'generatedEvidence',
      'generatedAt',
      'subject',
      'artifacts',
      'checks',
      'blockers',
      'releaseStatus',
    ],
    properties: {
      contractVersion: { const: CONTRACT_VERSION },
      evidenceKind: { const: 'repository-supply-chain-release-evidence' },
      generatedEvidence: {
        type: 'object',
        additionalProperties: false,
        required: [
          'isGeneratedEvidence',
          'organizationalApproval',
          'provenanceVerified',
          'provenanceClaims',
          'signatureVerified',
          'signatureClaims',
        ],
        properties: {
          isGeneratedEvidence: { const: true },
          organizationalApproval: { const: false },
          provenanceVerified: { const: false },
          provenanceClaims: { type: 'array', maxItems: 0 },
          signatureVerified: { const: false },
          signatureClaims: { type: 'array', maxItems: 0 },
        },
      },
      generatedAt: { type: 'string', format: 'date-time' },
      subject: {
        type: 'object',
        additionalProperties: false,
        required: [
          'candidateLabel',
          'lockfileSha256',
          'versionInventorySha256',
          'publicCandidateInventorySha256',
          'sbomSha256',
          'sourceInventorySha256',
          'trackedSourceInventorySha256',
        ],
        properties: {
          candidateLabel: { type: 'string', minLength: 1 },
          lockfileSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
          versionInventorySha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
          publicCandidateInventorySha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
          sbomSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
          sourceInventorySha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
          trackedSourceInventorySha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        },
      },
      artifacts: {
        type: 'object',
        additionalProperties: false,
        required: [
          'dependencyAdvisories',
          'licenseInventory',
          'registryPolicyEvidence',
          'repositoryInventories',
          'sbom',
          'sourceInventory',
        ],
        properties: {
          dependencyAdvisories: { const: 'dependency-advisories.json' },
          licenseInventory: { const: 'license-inventory.json' },
          registryPolicyEvidence: { const: 'registry-policy-evidence.json' },
          repositoryInventories: { const: 'repository-inventories.json' },
          sbom: { const: 'sbom.cdx.json' },
          sourceInventory: { const: 'source-inventory.json' },
        },
      },
      checks: {
        type: 'array',
        minItems: REQUIRED_CHECK_IDS.length,
        maxItems: REQUIRED_CHECK_IDS.length,
        items: {
          type: 'object',
          required: ['id', 'status', 'summary'],
          properties: {
            id: { enum: REQUIRED_CHECK_IDS },
            status: { enum: STATUS_VALUES },
            summary: { type: 'string', minLength: 1 },
          },
        },
      },
      blockers: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'checkId', 'message'],
          properties: {
            id: { type: 'string', pattern: '^[A-Z][A-Z0-9_]+$' },
            checkId: { enum: REQUIRED_CHECK_IDS },
            message: { type: 'string', minLength: 1 },
          },
        },
      },
      releaseStatus: { enum: ['blocked', 'eligible-for-human-review'] },
    },
  };
}

export function releaseEvidenceTemplate() {
  return {
    contractVersion: CONTRACT_VERSION,
    evidenceKind: 'repository-supply-chain-release-evidence',
    generatedEvidence: {
      isGeneratedEvidence: true,
      organizationalApproval: false,
      provenanceVerified: false,
      provenanceClaims: [],
      signatureVerified: false,
      signatureClaims: [],
    },
    generatedAt: '<RFC3339-timestamp>',
    subject: {
      candidateLabel: '<candidate-label>',
      lockfileSha256: '<sha256>',
      versionInventorySha256: '<sha256>',
      publicCandidateInventorySha256: '<sha256>',
      sbomSha256: '<sha256>',
      sourceInventorySha256: '<sha256>',
      trackedSourceInventorySha256: '<sha256>',
    },
    artifacts: {
      dependencyAdvisories: 'dependency-advisories.json',
      licenseInventory: 'license-inventory.json',
      registryPolicyEvidence: 'registry-policy-evidence.json',
      repositoryInventories: 'repository-inventories.json',
      sbom: 'sbom.cdx.json',
      sourceInventory: 'source-inventory.json',
    },
    checks: [],
    blockers: [
      {
        id: 'EXTERNAL_SIGNING_REQUIRED',
        checkId: 'external-signing',
        message: 'Generated evidence contains no external signature or provenance claim.',
      },
      {
        id: 'ORGANIZATIONAL_APPROVAL_REQUIRED',
        checkId: 'organizational-approval',
        message: 'Generated evidence is not organizational approval.',
      },
      {
        id: 'PROVENANCE_ATTESTATION_REQUIRED',
        checkId: 'provenance',
        message: 'Generated evidence contains no externally verifiable provenance attestation.',
      },
    ],
    releaseStatus: 'blocked',
  };
}

export function validateReleaseEvidence(evidence) {
  const errors = [];
  if (evidence?.contractVersion !== CONTRACT_VERSION) errors.push('contractVersion is unsupported.');
  if (evidence?.evidenceKind !== 'repository-supply-chain-release-evidence') {
    errors.push('evidenceKind is unsupported.');
  }
  if (evidence?.generatedEvidence?.isGeneratedEvidence !== true) {
    errors.push('generated evidence must identify itself as generated.');
  }
  if (evidence?.generatedEvidence?.organizationalApproval !== false) {
    errors.push('generated evidence cannot claim organizational approval.');
  }
  if (evidence?.generatedEvidence?.signatureVerified !== false) {
    errors.push('generated evidence cannot claim signature verification.');
  }
  if (evidence?.generatedEvidence?.provenanceVerified !== false) {
    errors.push('generated evidence cannot claim provenance verification.');
  }
  if (!Array.isArray(evidence?.generatedEvidence?.signatureClaims)
    || evidence.generatedEvidence.signatureClaims.length !== 0) {
    errors.push('generated evidence cannot contain signature claims.');
  }
  if (!Array.isArray(evidence?.generatedEvidence?.provenanceClaims)
    || evidence.generatedEvidence.provenanceClaims.length !== 0) {
    errors.push('generated evidence cannot contain provenance claims.');
  }
  if (typeof evidence?.generatedAt !== 'string' || Number.isNaN(Date.parse(evidence.generatedAt))) {
    errors.push('generatedAt must be an RFC3339 timestamp.');
  }
  for (const field of [
    'lockfileSha256',
    'versionInventorySha256',
    'publicCandidateInventorySha256',
    'sbomSha256',
    'sourceInventorySha256',
    'trackedSourceInventorySha256',
  ]) {
    if (!SHA256.test(evidence?.subject?.[field] ?? '')) {
      errors.push(`subject.${field} must be a SHA-256 digest.`);
    }
  }
  if (typeof evidence?.subject?.candidateLabel !== 'string'
    || evidence.subject.candidateLabel.length === 0) {
    errors.push('subject.candidateLabel must be a non-empty string.');
  }
  const expectedArtifacts = {
    dependencyAdvisories: 'dependency-advisories.json',
    licenseInventory: 'license-inventory.json',
    registryPolicyEvidence: 'registry-policy-evidence.json',
    repositoryInventories: 'repository-inventories.json',
    sbom: 'sbom.cdx.json',
    sourceInventory: 'source-inventory.json',
  };
  if (canonicalJson(evidence?.artifacts) !== canonicalJson(expectedArtifacts)) {
    errors.push('artifacts must use the canonical local evidence filenames.');
  }
  let checkIds = [];
  if (!Array.isArray(evidence?.checks)) errors.push('checks must be an array.');
  else {
    checkIds = evidence.checks.map((entry) => entry?.id);
    if (new Set(checkIds).size !== checkIds.length) errors.push('check IDs must be unique.');
    if (canonicalJson(checkIds) !== canonicalJson(REQUIRED_CHECK_IDS)) {
      errors.push('checks must contain the complete canonical check set in sorted order.');
    }
    for (const entry of evidence.checks) {
      if (!STATUS_VALUES.includes(entry?.status)) errors.push(`invalid check status: ${entry?.id}`);
      if (typeof entry?.summary !== 'string' || entry.summary.length === 0) {
        errors.push(`check summary must be a non-empty string: ${entry?.id}`);
      }
    }
    const byId = new Map(evidence.checks.map((entry) => [entry?.id, entry]));
    const sbomCheck = byId.get('sbom');
    if (sbomCheck?.sha256 !== evidence?.subject?.sbomSha256) {
      errors.push('sbom check digest must match subject.sbomSha256.');
    }
    const advisoryCheck = byId.get('dependency-advisories');
    if (advisoryCheck?.status !== 'unresolved') {
      if (typeof advisoryCheck?.executedAt !== 'string'
        || Number.isNaN(Date.parse(advisoryCheck.executedAt))) {
        errors.push('dependency-advisories executedAt must be an RFC3339 timestamp.');
      }
      for (const scope of ['production', 'complete']) {
        const scan = advisoryCheck?.scans?.[scope];
        if (scan?.versionInventorySha256 !== evidence?.subject?.versionInventorySha256) {
          errors.push(`dependency-advisories ${scope} scan must match subject.versionInventorySha256.`);
        }
        if (scan?.bindingMode === 'exact-lockfile'
          && scan?.lockfileSha256 !== evidence?.subject?.lockfileSha256) {
          errors.push(`dependency-advisories ${scope} exact lock binding must match subject.lockfileSha256.`);
        }
        if (scan?.bindingMode !== 'exact-lockfile') {
          errors.push(`dependency-advisories ${scope} binding mode is unsupported.`);
        }
        if (canonicalJson(scan?.command) !== canonicalJson(canonicalAuditCommand(scope))) {
          errors.push(`dependency-advisories ${scope} command metadata is not canonical.`);
        }
      }
    }
    const artifactCheck = byId.get('artifact-digest');
    if (Object.hasOwn(artifactCheck ?? {}, 'independentlyVerified')) {
      errors.push('artifact-digest cannot claim independent verification.');
    }
    if (artifactCheck?.digestMatched !== (artifactCheck?.status === 'passed')) {
      errors.push('artifact-digest digestMatched must reflect the comparison status.');
    }
    if (byId.get('external-signing')?.status !== 'unresolved') {
      errors.push('generated evidence must leave external-signing unresolved.');
    }
    if (byId.get('organizational-approval')?.status !== 'unresolved') {
      errors.push('generated evidence must leave organizational-approval unresolved.');
    }
    if (byId.get('provenance')?.status !== 'unresolved') {
      errors.push('generated evidence must leave provenance unresolved.');
    }
  }
  let blockerIds = [];
  if (!Array.isArray(evidence?.blockers)) errors.push('blockers must be an array.');
  else {
    blockerIds = evidence.blockers.map((entry) => entry?.id);
    const sortKeys = evidence.blockers.map((entry) => `${entry?.id}:${entry?.checkId}`);
    if (new Set(blockerIds).size !== blockerIds.length) errors.push('blocker IDs must be unique.');
    if (canonicalJson([...sortKeys].sort()) !== canonicalJson(sortKeys)) {
      errors.push('blockers must be sorted.');
    }
    for (const entry of evidence.blockers) {
      if (typeof entry?.id !== 'string' || !/^[A-Z][A-Z0-9_]+$/.test(entry.id)) {
        errors.push('blocker IDs must be uppercase identifiers.');
      }
      if (!checkIds.includes(entry?.checkId)) errors.push(`blocker references unknown check: ${entry?.id}`);
      if (typeof entry?.message !== 'string' || entry.message.length === 0) {
        errors.push(`blocker message must be a non-empty string: ${entry?.id}`);
      }
    }
    if (!blockerIds.includes('EXTERNAL_SIGNING_REQUIRED')) {
      errors.push('generated evidence must retain the external signing blocker.');
    }
    if (!blockerIds.includes('ORGANIZATIONAL_APPROVAL_REQUIRED')) {
      errors.push('generated evidence must retain the organizational approval blocker.');
    }
    if (!blockerIds.includes('PROVENANCE_ATTESTATION_REQUIRED')) {
      errors.push('generated evidence must retain the provenance blocker.');
    }
    if (Array.isArray(evidence?.checks)) {
      for (const entry of evidence.checks) {
        if (entry?.status !== 'passed'
          && !evidence.blockers.some((candidate) => candidate?.checkId === entry.id)) {
          errors.push(`non-passing check must retain a blocker: ${entry?.id}`);
        }
      }
    }
  }
  const checksPassed = Array.isArray(evidence?.checks)
    && evidence.checks.every((entry) => entry?.status === 'passed');
  const expectedReleaseStatus = evidence?.blockers?.length === 0 && checksPassed
    ? 'eligible-for-human-review'
    : 'blocked';
  if (evidence?.releaseStatus !== expectedReleaseStatus) {
    errors.push('releaseStatus does not match blocker state.');
  }
  return errors.sort();
}

export function validateReleaseReadiness(evidence, {
  artifactPath,
  candidateRoot,
  registryPolicyEvidence,
  sbom,
  maxAdvisoryAgeHours = MAX_ADVISORY_AGE_HOURS,
  maxAgeHours = 24,
  now = new Date(),
} = {}) {
  const errors = [...validateReleaseEvidence(evidence)];
  if (!candidateRoot) {
    errors.push('release readiness requires the current candidate root.');
    return [...new Set(errors)].sort();
  }
  const generatedTime = Date.parse(evidence?.generatedAt);
  const nowTime = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isNaN(generatedTime) && !Number.isNaN(nowTime)) {
    const age = nowTime - generatedTime;
    if (age < -MAX_FUTURE_SKEW_MS || age > maxAgeHours * 60 * 60 * 1000) {
      errors.push(`evidence is stale or future-dated beyond policy (${maxAgeHours} hour maximum age).`);
    }
  }
  const inventories = createRepositoryInventories(candidateRoot);
  const expectedDigests = {
    lockfileSha256: inventories.lockfile.sha256,
    versionInventorySha256: inventories.versionInventory.sha256,
    publicCandidateInventorySha256: inventories.publicCandidate.inventorySha256,
    sourceInventorySha256: inventories.source.inventorySha256,
    trackedSourceInventorySha256: inventories.tracked.inventorySha256,
  };
  for (const [field, expected] of Object.entries(expectedDigests)) {
    if (evidence?.subject?.[field] !== expected) {
      errors.push(`current candidate does not match subject.${field}.`);
    }
    const advisoryCheck = evidence?.checks?.find((entry) => entry?.id === 'dependency-advisories');
    const advisoryTime = Date.parse(advisoryCheck?.executedAt);
    if (advisoryCheck?.status === 'passed') {
      if (Number.isNaN(advisoryTime) || Number.isNaN(nowTime)) {
        errors.push('passed advisory evidence requires a valid executedAt timestamp.');
      } else {
        const advisoryAge = nowTime - advisoryTime;
        if (advisoryAge < -MAX_FUTURE_SKEW_MS
          || advisoryAge > maxAdvisoryAgeHours * 60 * 60 * 1000) {
          errors.push(
            `advisory evidence is stale or future-dated beyond policy (${maxAdvisoryAgeHours} hour maximum age).`,
          );
        }
      }
      for (const scope of ['production', 'complete']) {
        const scan = advisoryCheck?.scans?.[scope];
        if (scan?.versionInventorySha256 !== inventories.versionInventory.sha256) {
          errors.push(`the ${scope} advisory scan is not bound to the current exact-version inventory.`);
        }
        if (scan?.bindingMode === 'exact-lockfile'
          && scan?.lockfileSha256 !== inventories.lockfile.sha256) {
          errors.push(`the ${scope} advisory scan exact binding does not match the current package-lock digest.`);
        }
      }
    }
    if (!sbom) {
      errors.push('release readiness requires the supplied SBOM.');
    } else {
      const suppliedSbomSha256 = sha256Buffer(canonicalJson(sbom));
      if (evidence?.subject?.sbomSha256 !== suppliedSbomSha256) {
        errors.push('supplied SBOM does not match subject.sbomSha256.');
      }
      const { packageJson, packageLock } = loadRepositoryInputs(candidateRoot);
      if (canonicalJson(sbom) !== canonicalJson(createSbom(packageJson, packageLock))) {
        errors.push('supplied SBOM was not deterministically generated from the current package lock.');
      }
    }
  }
  const artifactCheck = evidence?.checks?.find((entry) => entry?.id === 'artifact-digest');
  if (artifactCheck?.status === 'passed') {
    if (!artifactPath) errors.push('release readiness requires the verified artifact path.');
    else {
      const verified = verifyArtifactDigest(artifactPath, artifactCheck.expectedSha256);
      if (verified.status !== 'passed' || verified.actualSha256 !== artifactCheck.actualSha256) {
        errors.push('current artifact does not match the recorded digest.');
      }
    }
  }
  if (evidence?.releaseStatus !== 'eligible-for-human-review') {
    errors.push('releaseStatus is not eligible-for-human-review.');
  }
  for (const entry of evidence?.checks ?? []) {
    if (entry?.status !== 'passed') errors.push(`release check is not passed: ${entry?.id}.`);
  }
  if ((evidence?.blockers ?? []).length > 0) errors.push('release blockers remain.');
  return [...new Set(errors)].sort();
}

export function writeCanonicalJson(filePath, value) {
  const absolute = path.resolve(filePath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.tmp-${process.pid}`;
  writeFileSync(temporary, canonicalJson(value), { encoding: 'utf8', flag: 'wx' });
  renameSync(temporary, absolute);
}

export function loadRepositoryInputs(root) {
  const packageJson = readJson(path.join(root, 'package.json'), 'package.json');
  const packageLock = readJson(path.join(root, 'package-lock.json'), 'package-lock.json');
  return { packageJson, packageLock };
}

export function assertRegularFile(filePath, description) {
  if (!existsSync(filePath)) throw new Error(`${description} does not exist: ${filePath}`);
  if (!lstatSync(filePath).isFile()) throw new Error(`${description} is not a regular file: ${filePath}`);
}
