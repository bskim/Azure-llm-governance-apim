/**
 * What a record may carry once it leaves the product.
 *
 * These two rules are not about any one screen. A value reaches a person on a screen,
 * in an export, and in a probe report, and each of those is a separate consumer that
 * would otherwise have to remember to check. They live apart from any single record
 * shape so that adding a consumer does not mean copying a rule.
 */

// A raw directory object identifier is not a pseudonymous actor code.
const RAW_PRINCIPAL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Checked against every string that leaves the product, because a value can carry a
// credential through a field whose name looks harmless.
const CREDENTIAL_SHAPED =
  /(bearer\s|api[-_]?key|secret|password|connectionstring|sk-[A-Za-z0-9]{8}|eyJ[A-Za-z0-9_-]{10,}\.|https?:\/\/)/i;

export function assertPseudonymousActor(value, name = 'actorCode') {
  if (typeof value !== 'string' || RAW_PRINCIPAL.test(value)) {
    const error = new Error('actor-not-pseudonymous');
    error.code = 'actor-not-pseudonymous';
    error.field = name;
    throw error;
  }
}

export function assertNoCredentialShapedValue(value, path) {
  if (typeof value === 'string') {
    if (CREDENTIAL_SHAPED.test(value)) {
      const error = new Error('record-value-refused');
      error.code = 'record-value-refused';
      error.path = path;
      throw error;
    }
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) assertNoCredentialShapedValue(child, `${path}.${key}`);
}
