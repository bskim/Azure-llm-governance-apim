const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * The caller, as the gateway reports it.
 *
 * The gateway validates the caller's token before it asks, and this endpoint
 * separately validates the gateway's own managed identity and its resolution role, so
 * the three fields it forwards are the output of two completed validations rather than
 * anything the caller supplied. That is what `entra-validated` records.
 *
 * Nothing here re-derives trust from the body: a body reaching this function that did
 * not come from the gateway would already have been refused at the handler.
 */

const CREDENTIAL_LIFETIME_SECONDS = 300;
// Beyond this the identity provider stops listing groups and sends a lookup instead,
// so a list at the limit may be truncated and would silently govern the wrong caller.
const MAX_DIRECTORY_GROUPS = 200;

/**
 * The groups the caller's own credential asserted, as the gateway read them.
 *
 * Absent is not empty: a gateway that forwards no groups has said nothing, while a
 * caller admitted to the application directly belongs to none. Only the second is an
 * answer, so an absent list stays absent here and the resolver decides what it means.
 */
function readDirectoryGroups(body) {
  if (!Object.hasOwn(body ?? {}, 'groups')) return undefined;
  const groups = body.groups;
  if (!Array.isArray(groups)) {
    const failure = new TypeError('groups must be an array when present.');
    failure.reasonCode = 'gateway-groups-unusable';
    throw failure;
  }
  if (groups.length > MAX_DIRECTORY_GROUPS) {
    const failure = new RangeError('groups exceeds the size a credential can carry.');
    failure.reasonCode = 'gateway-groups-overflow';
    throw failure;
  }
  for (const groupId of groups) {
    if (typeof groupId !== 'string' || !SAFE_ID.test(groupId)) {
      const failure = new TypeError('groups carries an unusable identifier.');
      failure.reasonCode = 'gateway-groups-unusable';
      throw failure;
    }
  }
  return Object.freeze([...groups]);
}

/**
 * Which token shape the gateway validated, and therefore who is calling.
 *
 * A gateway that says nothing is one that only ever validated delegated tokens, so an
 * absent value reads as a person rather than a workload. That is the conservative of
 * the two readings: a person still has to belong to a governed group, while a workload
 * is admitted by an application role, so guessing wrong in this direction refuses a
 * caller rather than admitting one.
 */
function readAuthenticationFlow(body) {
  if (!Object.hasOwn(body ?? {}, 'authenticationFlow')) return 'delegated';
  const flow = body.authenticationFlow;
  if (flow !== 'delegated' && flow !== 'application') {
    const failure = new TypeError('authenticationFlow is unsupported.');
    failure.reasonCode = 'gateway-authentication-flow-unusable';
    throw failure;
  }
  return flow;
}

export function createGatewayIdentityResolver({ clock }) {
  if (typeof clock?.nowIso !== 'function') throw new TypeError('clock is required.');

  return function resolveIdentity(body) {
    const tenantId = body?.tenantId;
    const subjectId = body?.subjectId;
    const applicationId = body?.applicationId;
    for (const [name, value] of [
      ['tenantId', tenantId],
      ['subjectId', subjectId],
      ['applicationId', applicationId],
    ]) {
      if (typeof value !== 'string' || !SAFE_ID.test(value)) {
        const failure = new TypeError(`${name} is required.`);
        failure.reasonCode = 'gateway-principal-incomplete';
        throw failure;
      }
    }

    const authenticationFlow = readAuthenticationFlow(body);
    const validatedAt = clock.nowIso();
    return Object.freeze({
      source: 'entra-validated',
      validationId: `gateway-${subjectId}`,
      validatedAt,
      credentialExpiresAt: new Date(
        Date.parse(validatedAt) + CREDENTIAL_LIFETIME_SECONDS * 1000,
      ).toISOString(),
      validationState: 'validated',
      subject: Object.freeze({
        tenantId,
        subjectId,
        principalType: authenticationFlow === 'application' ? 'workload' : 'user',
      }),
      application: Object.freeze({ applicationId, authenticationFlow }),
      directoryGroups: readDirectoryGroups(body),
    });
  };
}
