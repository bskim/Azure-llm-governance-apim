/**
 * Reads a principal's group membership from Microsoft Entra.
 *
 * Microsoft Learn is explicit that group claims are emitted for user principals only:
 * "Service principals aren't included in group optional claims emitted in the JWT." A
 * workload's membership is real in the directory and simply absent from its credential,
 * so it has to be asked for rather than read off the token.
 *
 * Nothing here mutates, and the transport is injected so a test never reaches Entra.
 */

const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

/** Entra caps a page at 999; more memberships than this is not a governed principal. */
const MAX_GROUPS = 200;

function fail(message) {
  throw new TypeError(message);
}

async function graphGet(url, { getToken }) {
  const token = await getToken();
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!response.ok) {
    const error = new Error('directory-read-failed');
    error.code = response.status === 404 ? 'directory-principal-absent' : 'directory-read-failed';
    error.status = response.status;
    throw error;
  }
  return response.json();
}

/**
 * @param principalType - decides the collection, because a directory object id is only
 *   unambiguous within one. Reading a workload as a user would answer about whichever
 *   object happened to share the identifier, or about none.
 */
export function createEntraGroupMembershipQuery({ credential, transport = graphGet }) {
  if (typeof credential?.getToken !== 'function') fail('credential must be able to get a token.');
  if (typeof transport !== 'function') fail('transport must be callable.');

  const getToken = async () => {
    const token = await credential.getToken(GRAPH_SCOPE);
    if (token?.token === undefined) fail('The credential returned no directory token.');
    return token.token;
  };

  return Object.freeze({
    async readGroupIds({ principalType, subjectId }) {
      if (principalType !== 'user' && principalType !== 'workload') {
        fail('principalType must be user or workload.');
      }
      if (typeof subjectId !== 'string' || subjectId.length === 0) fail('subjectId is required.');

      const collection = principalType === 'workload' ? 'servicePrincipals' : 'users';
      // Transitive: a principal placed in a nested group belongs to the parent too, and
      // the group claim this stands in for would have carried both.
      const url = `${GRAPH_BASE}/${collection}/${subjectId}/transitiveMemberOf/microsoft.graph.group`
        + `?$select=id&$top=${MAX_GROUPS}`;

      const page = await transport(url, { getToken });
      const value = Array.isArray(page?.value) ? page.value : [];
      // A truncated answer is not this principal's membership. Reporting it would drop
      // whichever groups fell off the page, which is a narrower grant nobody decided on.
      if (page['@odata.nextLink'] !== undefined) {
        const error = new Error('directory-membership-oversized');
        error.code = 'directory-membership-oversized';
        throw error;
      }
      return value
        .map((group) => group?.id)
        .filter((id) => typeof id === 'string' && id.length > 0);
    },
  });
}
