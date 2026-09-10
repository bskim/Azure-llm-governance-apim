/**
 * The executable check `DOC-001` names as its verification method.
 *
 * This file is published, so it never lists a forbidden source, host, or resource
 * name: a denylist of internal baselines would itself be the disclosure the scan
 * exists to prevent. Every class here is a shape or an allowlist. The literal terms
 * only this project knows live in an ignored supplement that is loaded separately.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export const FINDING_CLASSES = Object.freeze([
  'confidential-path',
  'unpermitted-host',
  'credential-shape',
  'local-machine-path',
  'local-environment',
  'registry-identity',
  'user-identity',
  'supplement-term',
]);

const exclusion = (kind, value) => Object.freeze({ kind, value });

// The local repository keeps these tracked as working context and private history.
// A public repository starts from a fresh snapshot, so selection removes them before
// scanning or copying. Every rule declares its matching semantics to prevent a
// filename prefix from accidentally becoming an exact-path rule (or vice versa).
export const PUBLIC_SNAPSHOT_EXCLUSIONS = Object.freeze([
  ...[
    '.azure',
    '.internal',
    '.c0',
    '.copilot',
    '.squad',
    '.supply-chain-work',
    '.vscode',
    '.github/skills',
    '.github/agents',
    'tests/c0',
    'tools/c0',
    'tools/d2',
    'docs/decisions',
    'docs/internal',
    'docs/reviews',
    'docs/blockers',
    'docs/evidence',
    'docs/postmortems',
    'docs/sessions',
    'provenance',
    'app/admin-ui/public/vendor',
  ].map((value) => exclusion('directory', value)),
  ...[
    '.github/workflows/squad-',
    '.github/workflows/sync-squad-',
    'docs/reference-sample-',
    'docs/source-analysis',
    'docs/requirements',
    'docs/implementation-plan',
    'docs/review-',
    'docs/blocker-',
    'docs/postmortem-',
  ].map((value) => exclusion('prefix', value)),
  ...[
    '.github/copilot-instructions.md',
    '.gitattributes',
    '.mcp.json',
    '.npmrc',
    '.d2-device-canary.json',
    '.squad-workstream',
    'infra/c0-allowances.bicep',
    'infra/c0-diagnostic-upgrade.bicep',
    'infra/c0-policy-resolution.bicep',
    'infra/c0-policy-upgrade.bicep',
    'infra/c0.bicep',
    'infra/c0.parameters.json',
    'infra/modules/c0-adopted-gateway.bicep',
    'infra/modules/c0-observability.bicep',
    'infra/existing-adopt.bicep',
    'infra/modules/adopted-gateway.bicep',
    'infra/modules/adopted-gateway-composition.bicep',
    'infra/modules/adopted-gateway-observability.bicep',
    'tests/infra/Test-D2AdoptedGatewayWiring.ps1',
    'tests/infra/Test-D2AzurePreflight.ps1',
    'tests/infra/Test-D2OperationalSafety.ps1',
    'tests/infra/Test-D2PostAdoption.ps1',
    'tests/routing/Test-ExistingToolCompatibility.ps1',
    'tests/routing/Test-RoutingCanaryRunner.ps1',
    'AGENTS.md',
    'docs/review.md',
    'local.settings.json',
    'app/admin-ui/public/admin-config.json',
  ].map((value) => exclusion('exact', value)),
  exclusion('suffix', '.code-workspace'),
  exclusion('suffix', '.blockers.md'),
  exclusion('suffix', '.evidence.json'),
  exclusion('suffix', '.postmortem.md'),
  exclusion('suffix', '.session.json'),
]);

function normalizeRepositoryPath(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('repository path must be a non-empty string.');
  }
  const slashSeparated = value.replaceAll('\\', '/');
  if (slashSeparated.startsWith('/') || /^[A-Za-z]:\//.test(slashSeparated)) {
    throw new TypeError('repository path must be relative.');
  }
  const segments = slashSeparated.split('/');
  if (segments.includes('..')) {
    throw new TypeError('repository path cannot leave the repository.');
  }
  const normalized = segments.filter((segment) => segment.length > 0 && segment !== '.').join('/');
  if (normalized.length === 0 || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    throw new TypeError('repository path must be relative.');
  }
  return normalized;
}

export function isPublicSnapshotPath(value) {
  const normalized = normalizeRepositoryPath(value);
  // The release boundary fails closed across filesystems: a case variation must
  // never change whether machine-local material is eligible for publication.
  const comparable = normalized.toLowerCase();
  return !PUBLIC_SNAPSHOT_EXCLUSIONS.some(({ kind, value: excluded }) => {
    const candidate = excluded.toLowerCase();
    switch (kind) {
      case 'exact':
        return comparable === candidate;
      case 'directory':
        return comparable === candidate || comparable.startsWith(`${candidate}/`);
      case 'prefix':
        return comparable.startsWith(candidate);
      case 'suffix':
        return comparable.endsWith(candidate);
      default:
        throw new TypeError(`unknown public snapshot exclusion kind: ${kind}`);
    }
  });
}

export function selectPublicSnapshotPaths(paths) {
  if (!Array.isArray(paths)) throw new TypeError('paths must be an array.');
  return [...new Set(paths.map(normalizeRepositoryPath).filter((value) => isPublicSnapshotPath(value)))].sort();
}

/**
 * The ignored paths that carry planning, research, or credentials. The build
 * artefacts `.gitignore` also excludes are deliberately absent: referring to
 * `node_modules` or the generated browser bundle is ordinary and flagging it would
 * only teach a reader to add exemptions.
 *
 * Naming these discloses nothing. They are already published in `.gitignore`.
 */
export const CONFIDENTIAL_PATHS = Object.freeze([
  '.azure/',
  '.internal/',
  '.squad/',
  '.supply-chain-work/',
  '.github/copilot-instructions.md',
  'AGENTS.md',
  'docs/decisions/',
  'docs/internal/',
  'docs/reference-sample-',
  'docs/requirements',
  'docs/source-analysis',
  'docs/implementation-plan',
  'docs/review.md',
  'docs/review-',
  'docs/reviews/',
  'docs/blockers/',
  'docs/evidence/',
  'docs/postmortems/',
  'docs/sessions/',
  'provenance/',
  '.c0/',
]);

// `.npmrc` is deliberately absent. The filename is standard and already published in
// `.gitignore`, and `Test-SupplyChain.ps1` has to name it to assert it stays excluded.
// What is confidential is the registry host inside it, which the term supplement covers.

/**
 * Microsoft, Azure, and standards-body hosts a public document is allowed to cite,
 * plus the Azure service endpoints the product calls at runtime. Anything else fails
 * and is reviewed by a person, which is what keeps a new third-party citation from
 * arriving unnoticed without this file ever naming one.
 */
const PERMITTED_HOST_SUFFIXES = Object.freeze([
  'microsoft.com',
  'microsoftonline.com',
  'azure.com',
  'azure.net',
  'windows.net',
  'loganalytics.io',
  // A channel this product sends notifications to, so its documented host is cited
  // the way the Azure ones are. The secret is the path of a webhook, never its host.
  'slack.com',
  'json-schema.org',
  'spec.openapis.org',
  'opensource.org',
  'iana.org',
  'rfc-editor.org',
  'ietf.org',
  // A claim-type namespace rather than a place anything is fetched from, like the
  // schema namespaces above it.
  'xmlsoap.org',
  'w3.org',
]);

const PERMITTED_EXACT_HOSTS = Object.freeze([
  'opencodex.me',
]);

const PERMITTED_PROJECT_URLS = Object.freeze([
  [['https:', '', 'github.com'].join('/'), 'lidge-jun', 'opencodex'].join('/'),
]);

const PERMITTED_LICENSE_DECLARATION_URLS = Object.freeze([
  ['https:', '', 'github.com', 'janogonzalez', 'priorityqueuejs', 'blob', '5fc8ac2ea0482277ee8110182e1d743e31cef1aa', 'Readme.md'].join('/'),
  ['https:', '', 'github.com', 'abrkn', 'semaphore.js', 'blob', '88a33875b168cc7b5943d7fe987c36d08321d252', 'README.md'].join('/'),
]);

/**
 * Reserved by RFC 2606 and RFC 6761, plus loopback. A reserved name cannot resolve to
 * a real endpoint, which is why fixtures use it and why a credential written inside
 * one is a placeholder rather than a credential.
 */
const RESERVED_HOST_SUFFIXES = Object.freeze([
  '.example',
  '.invalid',
  '.test',
  '.local',
  '.localhost',
  'example.com',
  'example.net',
  'example.org',
]);

const LOOPBACK_HOST = /^(?:localhost|0\.0\.0\.0|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[?::1\]?)$/i;

// The address equivalent of the reserved names above. RFC 5737 sets these blocks aside so
// documentation and tests can name an address that is guaranteed never to route anywhere.
const RESERVED_ADDRESS = /^(?:192\.0\.2|198\.51\.100|203\.0\.113)\.\d{1,3}$/;

// Userinfo is stepped over rather than captured, so `user:password@host` reports the
// host it actually reaches instead of the login name.
const URL_REFERENCE = /https?:\/\/(?:[^/@\s"'`]*@)?([A-Za-z0-9._-]+(?::\d+)?)/g;
const IPV6_URL_REFERENCE = /https?:\/\/(?:[^/@\s"'`]*@)?(\[[0-9A-Fa-f:.%]+\](?::\d+)?)/g;
const NON_ASCII_HOST_REFERENCE = /https?:\/\/(?:[^/@\s"'`]*@)?([^/\s"'`<>()\[\]]*[^\x00-\x7F][^/\s"'`<>()\[\]]*)/gu;

/**
 * A generated credential is opaque. A hyphenated run of word-like segments is a name
 * that describes itself, which is what a fixture is for and what a real secret never
 * looks like. Recognising the shape keeps the check strict without a list of blessed
 * fixture strings that a real value could later be added to.
 */
const SELF_DESCRIBING_PHRASE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+){2,}$/;

// The nil UUID and any single-character fill are defined placeholders, not identifiers.
function isPlaceholderIdentifier(value) {
  const guid = value.slice(value.lastIndexOf('/') + 1).replace(/-/g, '');
  return guid.length === 32 && [...guid].every((character) => character === guid[0]);
}

// A bare tenant/subscription identifier is judged by entropy rather than by an exact
// denylist, because this file may never name the real value it exists to catch. A
// generated GUID draws from the full hex alphabet almost at random; a fixture value is
// deliberately low-entropy so a reader can tell at a glance that it is synthetic (a
// repeating digit, a short suffix like `...00aa`, one digit per group). Counting the
// distinct hex characters used separates the two without listing today's fixture strings.
function isLowEntropyIdentifier(value) {
  const guid = value.replace(/-/g, '');
  if (guid.length !== 32) return false;
  return new Set(guid.toLowerCase()).size <= 6;
}

/**
 * Value shapes, not field names. The runtime guard in `audit-event-chain.mjs` refuses
 * any string merely containing `secret` or a URL, which is correct for a value
 * crossing into an audit record and useless here: every source file in the repository
 * would match, and a check that always fires gets switched off.
 */
const CREDENTIAL_PATTERNS = Object.freeze([
  { code: 'signed-token', pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g },
  { code: 'provider-key', pattern: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { code: 'storage-key', pattern: /\b(?:AccountKey|SharedAccessSignature)=[A-Za-z0-9+/=]{20,}/gi },
  {
    code: 'assigned-secret',
    // A quoted literal long enough to be real, assigned to a credential-shaped name.
    // Template references, APIM expressions, and angle-bracket placeholders are
    // excluded because they name a value rather than carry one.
    pattern:
      /(?:password|secret|api[-_]?key|client[-_]?secret|access[-_]?token|subscription[-_]?key|connection[-_]?string)["']?\s*[:=]\s*(["'])((?![^"']*[$@{<%])[^"'\s]{16,})\1/gi,
    isPlaceholder: (match) => SELF_DESCRIBING_PHRASE.test(match[2]),
  },
  {
    code: 'subscription-id',
    pattern: /\/subscriptions\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi,
    isPlaceholder: (match) => isPlaceholderIdentifier(match[0]),
  },
  {
    // A bare tenant or subscription GUID, not embedded in a `/subscriptions/...` path,
    // assigned to a field or environment variable named for one. This is the shape an
    // approved tenant/subscription identifier takes when it leaks as a hardcoded
    // constant (for example `tenantId: '<real-guid>'`) rather than as a resource path.
    code: 'tenant-or-subscription-id',
    pattern:
      /(?:tenantId|subscriptionId|AZURE_TENANT_ID|AZURE_SUBSCRIPTION_ID)["'`]?\s*[:=]\s*(["'`])([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\1/gi,
    isPlaceholder: (match) => isLowEntropyIdentifier(match[2]),
  },
]);

const LOCAL_PATH_PATTERNS = Object.freeze([
  { code: 'windows-user-path', pattern: /[A-Za-z]:\\{1,2}Users\\{1,2}[A-Za-z0-9._-]+/g },
  { code: 'windows-absolute-path', pattern: /[A-Za-z]:\\{1,2}(?:workspace|work|repos|projects|dev|temp|tmp)\b/gi },
  { code: 'posix-home-path', pattern: /\/(?:home|Users)\/[a-z][A-Za-z0-9._-]*/g },
]);

const REGISTRY_IDENTITY_PATTERNS = Object.freeze([
  /(?:approvedRegistryOrigins|configuredRegistryOrigin|effectiveRegistryOrigin|registryOrigin|registryUrl)["'`]?\s*[:=]\s*(?:\[\s*)?(["'`])(https?:\/\/[^"'`\s\]]+)\1/gi,
  /\bnpm\s+config\s+set\s+registry\s+(https?:\/\/[^\s"'`]+)/gi,
]);

const USER_IDENTITY_PATTERNS = Object.freeze([
  /\b[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}\b/g,
]);

const LOCAL_ENVIRONMENT_PATTERNS = Object.freeze([
  /(?:AZURE_ENV_NAME|AZURE_ENVIRONMENT_NAME)["'`]?\s*[:=]\s*(["'`])((?![<$%{])[A-Za-z0-9][A-Za-z0-9._-]{2,})\1/g,
  /\bazd\s+env\s+(?:new|select)\s+((?![<$%{])[A-Za-z0-9][A-Za-z0-9._-]{2,})\b/gi,
]);

/**
 * Every exemption is scoped to one class and one file, and each is covered by another
 * check. A blanket skip list would become the place a leak hides.
 */
const CLASS_EXEMPTIONS = Object.freeze({
  // Both files have to enumerate the boundary vocabulary in order to check for it, and
  // the prefixes are not secret: they are already published in `.gitignore`. Exempting
  // the check from its own subject matter adds no reach, because anyone who can edit
  // the scanner can disable the scan outright. Every other class still applies to them.
  'confidential-path': Object.freeze([
    '.gitignore',
    'tests/distribution/public-snapshot.test.mjs',
    'tools/distribution/public-boundary-scan.mjs',
    // Has to name the excluded local-state directory it loads the real environment
    // identity from at runtime; the directory name itself is already published in
    // `.gitignore` and carries no secret. Every value actually read from it is
    // digest-bound rather than ever written back into a publishable file.
    'tools/deployment/ownership-contract.mjs',
  ]),
  // Generated by the package manager. Historical `resolved` URLs are dependency
  // metadata, not proof of the effective fetch origin. Release validation binds that
  // origin to separate configured-registry policy evidence.
  // The channel test names the addresses and internal names an endpoint may not use,
  // because a test that could not write them could not prove they are refused. They
  // are the opposite of a citation: the file exists to keep them unreachable.
  'unpermitted-host': Object.freeze([
    'package-lock.json',
    'tests/usage/notification-channel.test.mjs',
  ]),
});

function isExempt(className, filePath) {
  const exemptions = CLASS_EXEMPTIONS[className];
  return Boolean(exemptions && exemptions.includes(filePath));
}

function hostIsPermitted(hostWithPort) {
  const host = hostWithPort.replace(/:\d+$/, '').toLowerCase();
  if (hostIsReserved(host)) return true;
  if (PERMITTED_EXACT_HOSTS.includes(host)) return true;
  return PERMITTED_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function sourceUrlIsPermitted(text, index) {
  if (PERMITTED_LICENSE_DECLARATION_URLS.some((url) => {
    if (!text.startsWith(url, index)) return false;
    const next = text[index + url.length] ?? '';
    return next === '' || /[?#)\]\s]/.test(next);
  })) return true;
  return PERMITTED_PROJECT_URLS.some((prefix) => {
    if (!text.startsWith(prefix, index)) return false;
    const next = text[index + prefix.length] ?? '';
    return next === '' || /[/?#)\]\s]/.test(next);
  });
}

function hostIsReserved(hostWithPort) {
  const host = hostWithPort.replace(/:\d+$/, '').toLowerCase();
  if (LOOPBACK_HOST.test(host)) return true;
  if (RESERVED_ADDRESS.test(host)) return true;
  return RESERVED_HOST_SUFFIXES.some((suffix) => {
    const domain = suffix.replace(/^\./, '');
    return host === domain || host.endsWith(`.${domain}`);
  });
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

/**
 * A finding is evidence for a person, and the log it lands in is not a secret store.
 * The matched text is reduced to its shape so the report cannot become a second copy
 * of whatever it found.
 */
function mask(value) {
  const text = String(value);
  if (text.length <= 4) return `${'*'.repeat(text.length)} (${text.length} chars)`;
  return `${text.slice(0, 4)}${'*'.repeat(Math.min(text.length - 4, 12))} (${text.length} chars)`;
}

// For the supplement class the matched text is itself the confidential term, so even a
// leading fragment would put it in the log. The path and line are enough to find it.
function maskEntirely(value) {
  const length = String(value).length;
  return `${'*'.repeat(Math.min(length, 12))} (${length} chars)`;
}

function finding(className, filePath, text, index, code, matched) {
  return {
    class: className,
    path: filePath,
    line: lineNumberAt(text, index),
    code,
    excerpt: maskEntirely(matched),
  };
}

function scanConfidentialPaths(filePath, text, findings) {
  if (isExempt('confidential-path', filePath)) return;
  for (const confidential of CONFIDENTIAL_PATHS) {
    let index = text.indexOf(confidential);
    while (index !== -1) {
      findings.push(finding('confidential-path', filePath, text, index, 'ignored-artifact-reference', confidential));
      index = text.indexOf(confidential, index + confidential.length);
    }
  }
}

function scanHosts(filePath, text, findings) {
  if (isExempt('unpermitted-host', filePath)) return;
  URL_REFERENCE.lastIndex = 0;
  let match = URL_REFERENCE.exec(text);
  while (match !== null) {
    if (!hostIsPermitted(match[1]) && !sourceUrlIsPermitted(text, match.index)) {
      findings.push(finding('unpermitted-host', filePath, text, match.index, 'source-not-allowlisted', match[1]));
    }
    match = URL_REFERENCE.exec(text);
  }
  for (const pattern of [IPV6_URL_REFERENCE, NON_ASCII_HOST_REFERENCE]) {
    pattern.lastIndex = 0;
    let special = pattern.exec(text);
    while (special !== null) {
      if (!hostIsPermitted(special[1])) {
        findings.push(finding('unpermitted-host', filePath, text, special.index, 'source-not-allowlisted', special[1]));
      }
      special = pattern.exec(text);
    }
  }
}

function scanCredentials(filePath, text, findings) {
  for (const { code, pattern, isPlaceholder } of CREDENTIAL_PATTERNS) {
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match !== null) {
      // A reserved host cannot be a real endpoint, so a credential written against one
      // is a fixture. Checked here rather than as a file exemption so a real endpoint
      // on the same line is still caught.
      const lineStart = text.lastIndexOf('\n', match.index) + 1;
      const lineEnd = text.indexOf('\n', match.index);
      const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
      const hosts = [...line.matchAll(URL_REFERENCE)].map((hostMatch) => hostMatch[1]);
      const reservedHostOnly = hosts.length > 0 && hosts.every(hostIsReserved);
      if (!reservedHostOnly && !(isPlaceholder && isPlaceholder(match))) {
        findings.push(finding('credential-shape', filePath, text, match.index, code, match[0]));
      }
      match = pattern.exec(text);
    }
  }
}

function scanLocalPaths(filePath, text, findings) {
  for (const { code, pattern } of LOCAL_PATH_PATTERNS) {
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match !== null) {
      findings.push(finding('local-machine-path', filePath, text, match.index, code, match[0]));
      match = pattern.exec(text);
    }
  }
}

function scanPatterns(filePath, text, findings, className, code, patterns) {
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match !== null) {
      const matched = match.at(-1);
      findings.push(finding(className, filePath, text, match.index, code, matched));
      match = pattern.exec(text);
    }
  }
}

function scanUserIdentities(filePath, text, findings) {
  for (const pattern of USER_IDENTITY_PATTERNS) {
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match !== null) {
      const lineStart = text.lastIndexOf('\n', match.index) + 1;
      const before = text.slice(lineStart, match.index);
      const insideUrlUserInfo = /https?:\/\/[^\s]*$/i.test(before);
      const host = match[0].slice(match[0].lastIndexOf('@') + 1);
      if (!insideUrlUserInfo && !hostIsReserved(host)) {
        findings.push(finding(
          'user-identity',
          filePath,
          text,
          match.index,
          'email-address',
          match[0],
        ));
      }
      match = pattern.exec(text);
    }
  }
}

function scanSupplementTerms(filePath, text, terms, findings) {
  const haystack = text.toLowerCase();
  for (const term of terms) {
    const needle = term.toLowerCase();
    let index = haystack.indexOf(needle);
    while (index !== -1) {
      findings.push({
        class: 'supplement-term',
        path: filePath,
        line: lineNumberAt(text, index),
        code: 'internal-term-reference',
        excerpt: maskEntirely(term),
      });
      index = haystack.indexOf(needle, index + needle.length);
    }
  }
}

export function isBinary(text) {
  return text.includes('\u0000');
}

/**
 * @param {{path: string, text: string|null}[]} entries `text` is null for a binary,
 *   whose path is still checked.
 * @param {{state: 'applied'|'not-applicable', terms: string[]|null}} supplement
 *   Required. Omitting it throws rather than skipping the class, because a check that
 *   silently no-ops when an argument is forgotten is not a check.
 */
export function scanEntries(entries, supplement) {
  if (supplement === undefined) {
    throw new TypeError('supplement is required; pass a resolved supplement or an explicit not-applicable state.');
  }
  if (supplement === null || typeof supplement !== 'object') {
    throw new TypeError('supplement must be an object describing whether internal terms were available.');
  }
  if (supplement.state !== 'applied' && supplement.state !== 'not-applicable') {
    throw new TypeError(`supplement.state must be applied or not-applicable, not ${String(supplement.state)}.`);
  }
  if (supplement.state === 'applied' && (!Array.isArray(supplement.terms) || supplement.terms.length === 0)) {
    throw new TypeError('an applied supplement must carry at least one term.');
  }

  const findings = [];
  for (const entry of entries) {
    // The bundle is source material that is expected to cite the internal evidence it
    // was drawn from; a tracked file citing the same location is the leak. So the
    // confidential-path class is about where a file sits, not about every file scanned.
    const isTracked = (entry.origin ?? 'tracked') === 'tracked';
    if (isTracked && !isPublicSnapshotPath(entry.path)) {
      findings.push({
        class: 'confidential-path',
        path: entry.path,
        line: 0,
        code: 'ignored-artifact-tracked',
        excerpt: mask(entry.path),
      });
    }
    if (entry.text === null) continue;
    if (isTracked) scanConfidentialPaths(entry.path, entry.text, findings);
    scanHosts(entry.path, entry.text, findings);
    scanCredentials(entry.path, entry.text, findings);
    scanLocalPaths(entry.path, entry.text, findings);
    scanPatterns(
      entry.path,
      entry.text,
      findings,
      'local-environment',
      'hardcoded-validation-environment',
      LOCAL_ENVIRONMENT_PATTERNS,
    );
    scanPatterns(
      entry.path,
      entry.text,
      findings,
      'registry-identity',
      'hardcoded-registry-origin',
      REGISTRY_IDENTITY_PATTERNS,
    );
    scanUserIdentities(entry.path, entry.text, findings);
    if (supplement.state === 'applied') {
      scanSupplementTerms(entry.path, entry.text, supplement.terms, findings);
    }
  }

  return {
    findings,
    filesScanned: entries.length,
    // Kept distinct from an empty finding list so a reader can tell a class that found
    // nothing from a class that never ran.
    supplementState: supplement.state,
    classesVerified: supplement.state === 'applied' ? FINDING_CLASSES : FINDING_CLASSES.filter((name) => name !== 'supplement-term'),
  };
}

export const SUPPLEMENT_FILE = path.join('.internal', 'public-boundary-terms.json');

/**
 * The internal workspace decides whether the named-term class is mandatory. Its
 * presence is a fact about the checkout rather than an argument a caller can pass, so
 * a maintainer cannot turn the class off by forgetting a flag, and a contributor who
 * has no internal names is not asked to supply them.
 */
export function resolveSupplement(root) {
  if (!existsSync(path.join(root, '.internal'))) {
    return { state: 'not-applicable', terms: null, reason: 'no-internal-workspace' };
  }
  const file = path.join(root, SUPPLEMENT_FILE);
  if (!existsSync(file)) {
    return { state: 'missing', terms: null, reason: 'supplement-file-absent' };
  }
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  const terms = Array.isArray(parsed?.terms) ? parsed.terms.filter((term) => typeof term === 'string' && term.length >= 3) : [];
  if (terms.length === 0) {
    return { state: 'missing', terms: null, reason: 'supplement-file-empty' };
  }
  return { state: 'applied', terms, reason: 'supplement-loaded' };
}

// Omitting the origin treats a file as tracked, which is the stricter of the two. A
// forgotten argument therefore costs a false positive rather than a missed leak.
//
// A tracked path with nothing behind it is an ordinary state between deleting a file
// and staging that deletion. Throwing there would abandon the scan and hide every
// other finding, so it is reported as an entry with no content to check.
export function readEntry(root, relativePath, origin = 'tracked') {
  const absolute = path.join(root, relativePath);
  const normalised = relativePath.split(path.sep).join('/');
  if (!existsSync(absolute)) return { path: normalised, text: null, origin, state: 'absent' };
  const raw = readFileSync(absolute);
  const text = raw.toString('utf8');
  return { path: normalised, text: isBinary(text) ? null : text, origin };
}

export function listReleaseBundle(root) {
  const bundleRoot = path.join(root, '.internal', 'release-assets');
  if (!existsSync(bundleRoot)) return [];
  const collected = [];
  const walk = (directory) => {
    for (const name of readdirSync(directory)) {
      const absolute = path.join(directory, name);
      if (statSync(absolute).isDirectory()) walk(absolute);
      else collected.push(path.relative(root, absolute).split(path.sep).join('/'));
    }
  };
  walk(bundleRoot);
  return collected;
}

export function formatFindings(report) {
  if (report.findings.length === 0) {
    return `Public boundary clean across ${report.filesScanned} files (${report.classesVerified.join(', ')}).`;
  }
  const lines = report.findings.map(
    (item) => `  ${item.class}/${item.code}  ${item.path}:${item.line}  ${item.excerpt}`,
  );
  return [`Public boundary violations: ${report.findings.length}`, ...lines].join('\n');
}
