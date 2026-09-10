import { createHash } from 'node:crypto';

import { assertNoCredentialShapedValue } from '../privacy/record-safety.mjs';

/**
 * Captures the state a rollback has to restore for one endpoint governance mode,
 * and compares two captures into a delta an operator can read.
 *
 * Five dimensions are recorded separately and each one is either read or unreadable.
 * There is no third representation: a dimension that could not be read carries a
 * reason code and no reading at all, so a capture that failed halfway cannot be
 * mistaken for one that found nothing to report. A digest authenticates a capture;
 * it never stands in for the sentence that says what moved.
 */

// The four modes named by the operating guide. `ExclusiveApim` appears in the
// requirements matrix for `PrivateNoBypass` and is not accepted under that name.
export const GOVERNANCE_MODES = Object.freeze([
  'FoundryIntegrated',
  'ExplicitApim',
  'PrivateNoBypass',
  'DirectResourceAllowed',
]);

export const FINGERPRINT_DIMENSIONS = Object.freeze([
  'endpoint',
  'auth',
  'topology',
  'metric',
  'compatibility',
]);

/**
 * Every field a reading must carry, per dimension. Exact rather than minimum: a
 * reading missing one field is not a smaller reading, it is an unfinished one, and
 * the dimension must say so instead of publishing the part that succeeded.
 */
export const DIMENSION_FIELDS = Object.freeze({
  endpoint: Object.freeze(['baseUrlClass', 'hostDigest', 'routes']),
  auth: Object.freeze(['audience', 'acceptedClientIds', 'requiredScope', 'requiredAppRole']),
  topology: Object.freeze(['apis', 'backends', 'policyScopes', 'namedValueNames', 'projectRoutingState']),
  metric: Object.freeze(['counters', 'counterSources']),
  compatibility: Object.freeze(['callerClasses', 'declarationSource']),
});

export const UNREADABLE_REASON_CODES = Object.freeze([
  'dimension-not-attempted',
  'gateway-unreadable',
  'api-definition-unreadable',
  'named-values-unreadable',
  'backends-unreadable',
  'policy-unreadable',
  'project-routing-unreadable',
  'metric-definitions-unreadable',
  'compatibility-not-declared',
  'reading-incomplete',
]);

export const DIFFERENCE_VERDICTS = Object.freeze(['restored', 'unrestored', 'unexpected']);

export const COMPARISON_VERDICTS = Object.freeze([
  'rollback-verified',
  'rollback-incomplete',
  'rollback-unverifiable',
  'rollback-unexpected-change',
]);

const CONTRACT_VERSION = 'endpoint-fingerprint.v1';
const COMPARISON_CONTRACT_VERSION = 'endpoint-fingerprint-comparison.v1';
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const SAFE_VALUE = /^[A-Za-z0-9._:|/-]{1,256}$/;
const CODE = /^[a-z][a-z0-9-]{2,63}$/;

// Split so this guard's own source does not contain the literals it forbids, which
// is the only way the guard can be run over the file that defines it.
const MUTATING_HTTP_METHODS = Object.freeze(['PO' + 'ST', 'PU' + 'T', 'PAT' + 'CH', 'DELE' + 'TE']);
const MUTATING_CLI_VERBS = Object.freeze(['cre' + 'ate', 'upd' + 'ate', 'de' + 'lete', 's' + 'et']);

function fail(message) {
  throw new TypeError(message);
}

function refuse(code, detail = {}) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, detail);
  throw error;
}

function assertExactKeys(value, expected, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${path} must be an object.`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${path} must carry exactly [${wanted.join(', ')}] but carries [${actual.join(', ')}].`);
  }
}

export function digestOf(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

/**
 * A dimension the capture could not read. It carries no reading, so nothing about it
 * can be compared, and the shape is checked exactly so a reading cannot be smuggled
 * alongside the reason code and then match a genuine one.
 */
export function unreadableDimension(reasonCode) {
  if (!UNREADABLE_REASON_CODES.includes(reasonCode)) {
    fail(`${reasonCode} is not a declared unreadable reason.`);
  }
  return Object.freeze({ state: 'unreadable', reasonCode });
}

export function readDimension(reading) {
  return Object.freeze({ state: 'read', reading });
}

function assertReadingValue(value, path) {
  if (typeof value === 'string') {
    if (!SAFE_VALUE.test(value)) fail(`${path} must be a bounded identifier.`);
    return;
  }
  if (!Array.isArray(value)) fail(`${path} must be a string or an array of strings.`);
  for (const [index, member] of value.entries()) assertReadingValue(member, `${path}[${index}]`);
}

function assertDimension(dimension, value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${path} must be an object.`);
  if (value.state === 'unreadable') {
    assertExactKeys(value, ['state', 'reasonCode'], path);
    if (!UNREADABLE_REASON_CODES.includes(value.reasonCode)) {
      fail(`${path}.reasonCode is not a declared unreadable reason.`);
    }
    return;
  }
  if (value.state !== 'read') fail(`${path}.state must be read or unreadable.`);
  assertExactKeys(value, ['state', 'reading'], path);
  assertExactKeys(value.reading, DIMENSION_FIELDS[dimension], `${path}.reading`);
  for (const field of DIMENSION_FIELDS[dimension]) {
    assertReadingValue(value.reading[field], `${path}.reading.${field}`);
  }
}

function completenessOf(dimensions) {
  return FINGERPRINT_DIMENSIONS.every((name) => dimensions[name].state === 'read') ? 'complete' : 'partial';
}

export function assertEndpointFingerprint(fingerprint) {
  assertExactKeys(
    fingerprint,
    ['contractVersion', 'mode', 'capturedAt', 'sourceRevision', 'completeness', 'unreadableDimensions', 'dimensions'],
    'fingerprint',
  );
  if (fingerprint.contractVersion !== CONTRACT_VERSION) fail('contractVersion is not recognised.');
  if (!GOVERNANCE_MODES.includes(fingerprint.mode)) fail(`${fingerprint.mode} is not a governance mode.`);
  if (typeof fingerprint.capturedAt !== 'string' || !INSTANT.test(fingerprint.capturedAt)) {
    fail('capturedAt must be an ISO-8601 instant.');
  }
  if (typeof fingerprint.sourceRevision !== 'string' || !SAFE_VALUE.test(fingerprint.sourceRevision)) {
    fail('sourceRevision must be a bounded identifier.');
  }
  assertExactKeys(fingerprint.dimensions, FINGERPRINT_DIMENSIONS, 'fingerprint.dimensions');
  for (const name of FINGERPRINT_DIMENSIONS) {
    assertDimension(name, fingerprint.dimensions[name], `fingerprint.dimensions.${name}`);
  }

  const unreadable = FINGERPRINT_DIMENSIONS.filter((name) => fingerprint.dimensions[name].state === 'unreadable');
  const declared = fingerprint.unreadableDimensions;
  if (!Array.isArray(declared) || declared.length !== unreadable.length
    || declared.some((name, index) => name !== unreadable[index])) {
    fail('unreadableDimensions must list exactly the dimensions that were not read, in dimension order.');
  }
  if (fingerprint.completeness !== completenessOf(fingerprint.dimensions)) {
    // A capture that names itself complete while a dimension is missing is the one
    // shape this document exists to make impossible.
    refuse('fingerprint-completeness-misdeclared', { declared: fingerprint.completeness });
  }

  assertNoCredentialShapedValue(fingerprint, 'fingerprint');
  return fingerprint;
}

export function buildEndpointFingerprint({ mode, capturedAt, sourceRevision, dimensions }) {
  if (dimensions === null || typeof dimensions !== 'object') fail('dimensions must be an object.');
  const missing = FINGERPRINT_DIMENSIONS.filter((name) => dimensions[name] === undefined);
  if (missing.length > 0) {
    // Never defaulted to unreadable: an omitted dimension means the caller did not
    // decide, and guessing on their behalf is how a hole becomes a clean report.
    fail(`dimensions must name every dimension; [${missing.join(', ')}] were omitted.`);
  }
  const collected = Object.fromEntries(FINGERPRINT_DIMENSIONS.map((name) => [name, dimensions[name]]));
  return assertEndpointFingerprint({
    contractVersion: CONTRACT_VERSION,
    mode,
    capturedAt,
    sourceRevision,
    completeness: completenessOf(collected),
    unreadableDimensions: FINGERPRINT_DIMENSIONS.filter((name) => collected[name].state === 'unreadable'),
    dimensions: collected,
  });
}

function quote(value) {
  if (value === null) return 'nothing recorded';
  if (Array.isArray(value)) return value.length === 0 ? 'an empty list' : value.map((item) => `"${item}"`).join(', ');
  return `"${value}"`;
}

function listDifference(path, baseline, observed) {
  const gained = observed.filter((member) => !baseline.includes(member));
  const lost = baseline.filter((member) => !observed.includes(member));
  if (gained.length === 0 && lost.length === 0) return null;
  const clauses = [];
  if (gained.length > 0) clauses.push(`gained ${quote(gained)}`);
  if (lost.length > 0) clauses.push(`lost ${quote(lost)}`);
  return `${path} ${clauses.join(' and ')}.`;
}

function differenceFor(path, baseline, observed) {
  if (Array.isArray(baseline) && Array.isArray(observed)) {
    const statement = listDifference(path, baseline, observed);
    return statement === null ? null : { statement };
  }
  if (baseline === observed) return null;
  return { statement: `${path} changed from ${quote(baseline)} to ${quote(observed)}.` };
}

function classify(path, restores, documentedResiduals) {
  if (documentedResiduals.includes(path)) {
    return { verdict: 'unrestored', documented: true, reasonCode: 'documented-residual' };
  }
  if (restores.includes(path)) {
    return { verdict: 'unrestored', documented: false, reasonCode: 'restore-did-not-take-effect' };
  }
  // Nobody asked the rollback to touch this. That is the finding.
  return { verdict: 'unexpected', documented: false, reasonCode: 'change-outside-rollback-plan' };
}

function assertPlanPaths(paths, name) {
  if (!Array.isArray(paths)) fail(`${name} must be an array; omitting it is not a declaration.`);
  const known = FINGERPRINT_DIMENSIONS.flatMap((dimension) =>
    DIMENSION_FIELDS[dimension].map((field) => `${dimension}.${field}`));
  for (const path of paths) {
    if (!known.includes(path)) fail(`${name} names ${path}, which is not a fingerprint field.`);
  }
  return paths;
}

function compareDimension(dimension, baseline, observed, restores, documentedResiduals) {
  if (baseline.state !== 'read' || observed.state !== 'read') {
    // An unreadable dimension is never equal to a read one, and two unreadable ones
    // are not equal either: agreement about what was not looked at is not evidence.
    return {
      dimension,
      state: 'not-compared',
      verdict: 'unrestored',
      documented: false,
      reasonCode: 'dimension-unreadable',
      baselineState: baseline.state,
      observedState: observed.state,
      statement:
        `${dimension} could not be compared because the baseline was ${baseline.state}`
        + ` and the observation was ${observed.state}.`,
      differences: [],
    };
  }

  const differences = [];
  for (const field of DIMENSION_FIELDS[dimension]) {
    const path = `${dimension}.${field}`;
    const found = differenceFor(path, baseline.reading[field], observed.reading[field]);
    if (found === null) continue;
    const { verdict, documented, reasonCode } = classify(path, restores, documentedResiduals);
    differences.push({
      field: path,
      baselineValue: baseline.reading[field],
      observedValue: observed.reading[field],
      verdict,
      documented,
      reasonCode,
      statement: found.statement,
    });
  }

  const worst = differences.some((difference) => difference.verdict === 'unexpected')
    ? 'unexpected'
    : differences.length > 0
      ? 'unrestored'
      : 'restored';

  return {
    dimension,
    state: 'compared',
    verdict: worst,
    documented: differences.length > 0 && differences.every((difference) => difference.documented),
    reasonCode: differences.length === 0 ? 'dimension-restored' : null,
    baselineState: 'read',
    observedState: 'read',
    statement: differences.length === 0
      ? `${dimension} matches the baseline in every field.`
      : differences.map((difference) => difference.statement).join(' '),
    differences,
  };
}

/**
 * Compares a post-rollback capture with the capture the rollback had to restore.
 *
 * `restores` and `documentedResiduals` are required. An optional plan that no-ops
 * when omitted would silently reclassify every genuine failure, and a typo in a
 * field path would do the same, so both are validated against the field set.
 */
export function compareEndpointFingerprints({ baseline, observed, restores, documentedResiduals }) {
  assertEndpointFingerprint(baseline);
  assertEndpointFingerprint(observed);
  assertPlanPaths(restores, 'restores');
  assertPlanPaths(documentedResiduals, 'documentedResiduals');

  if (baseline.mode !== observed.mode) refuse('fingerprint-mode-mismatch');
  if (baseline.contractVersion !== observed.contractVersion) refuse('fingerprint-contract-version-mismatch');

  const dimensions = FINGERPRINT_DIMENSIONS.map((name) =>
    compareDimension(name, baseline.dimensions[name], observed.dimensions[name], restores, documentedResiduals));

  const differences = dimensions.flatMap((entry) => entry.differences);
  const notCompared = dimensions.filter((entry) => entry.state === 'not-compared').length;
  const summary = {
    restored: dimensions.filter((entry) => entry.state === 'compared' && entry.differences.length === 0).length,
    unrestored: differences.filter((difference) => difference.verdict === 'unrestored').length,
    unexpected: differences.filter((difference) => difference.verdict === 'unexpected').length,
    notCompared,
  };

  // An unexpected change is a definite finding and names the verdict even when a
  // dimension went unread; `comparable` carries the missing evidence separately, so
  // neither fact can hide the other.
  const verdict = summary.unexpected > 0
    ? 'rollback-unexpected-change'
    : notCompared > 0
      ? 'rollback-unverifiable'
      : differences.some((difference) => !difference.documented)
        ? 'rollback-incomplete'
        : 'rollback-verified';

  const comparison = {
    contractVersion: COMPARISON_CONTRACT_VERSION,
    mode: baseline.mode,
    baselineCapturedAt: baseline.capturedAt,
    observedCapturedAt: observed.capturedAt,
    comparable: notCompared === 0,
    verdict,
    summary,
    dimensions,
  };
  assertNoCredentialShapedValue(comparison, 'comparison');
  return comparison;
}

export function renderComparison(comparison) {
  const lines = [
    `Mode ${comparison.mode}: ${comparison.verdict}`
    + ` (baseline ${comparison.baselineCapturedAt}, observation ${comparison.observedCapturedAt}).`,
    comparison.comparable
      ? 'Every dimension was compared.'
      : `${comparison.summary.notCompared} of ${FINGERPRINT_DIMENSIONS.length} dimensions could not be compared.`,
  ];
  for (const dimension of comparison.dimensions) {
    lines.push(`- ${dimension.dimension} [${dimension.verdict}] ${dimension.statement}`);
    for (const difference of dimension.differences) {
      lines.push(`    * ${difference.verdict}${difference.documented ? ' (documented)' : ''}: ${difference.statement}`);
    }
  }
  return lines.join('\n');
}

/**
 * Refuses a source file that could mutate anything. Intent is not a property, so the
 * claim that this tool is read-only is checked against the text that runs.
 */
export function assertReadOnlySource(source, { path }) {
  if (typeof source !== 'string' || source.length === 0) fail('source must be a non-empty string.');
  const findings = [];
  for (const method of MUTATING_HTTP_METHODS) {
    if (new RegExp(`['"\`]${method}['"\`]`).test(source)) findings.push(`http-method:${method}`);
    if (new RegExp(`method\\s*[:=]\\s*['"\`]${method}`, 'i').test(source)) findings.push(`request-method:${method}`);
  }
  for (const verb of MUTATING_CLI_VERBS) {
    if (new RegExp(`\\baz\\b[^\\n'"\`]{0,60}\\b${verb}\\b`, 'i').test(source)) findings.push(`cli-verb:${verb}`);
  }
  if (/\bbody\s*:/.test(source)) findings.push('request-body');
  if (findings.length > 0) refuse('source-is-not-read-only', { path, findings });
  return true;
}
