/**
 * Reads the governed groups and who is in them, from Microsoft Entra.
 *
 * This is the roster behind the users-and-groups screen, and it is a different question
 * from the one `entra-group-membership-query.mjs` answers: that asks which groups one
 * principal belongs to, this asks who belongs to a group. Neither is derivable from the
 * other, which is why both exist.
 *
 * Only the groups the published governance set names are read. The permission this
 * needs is tenant-wide because Microsoft Graph has no narrower one, so the narrowing
 * that is available is done here: nothing asks about a group governance does not.
 *
 * Every request selects identifiers only. A directory display name, a principal name
 * and a mail address are all personal data, and the product's records are pseudonymous
 * throughout, so the safest place to refuse them is where they would otherwise arrive.
 */

const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

// A governed group with more members than this is not one the screen can show usefully,
// and reading further would trade a slower page for a number nobody reads. The reading
// says it was truncated rather than presenting the first page as the whole group.
const MAX_MEMBERS_PER_GROUP = 500;

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
    error.code = response.status === 404 ? 'directory-group-absent' : 'directory-read-failed';
    error.status = response.status;
    throw error;
  }
  return response.json();
}

/**
 * What went wrong, in terms safe to log.
 *
 * The status and the error's own name, never its message: a Graph message quotes the
 * identifier it rejected, and a thrown TypeError quotes whatever value it was given.
 * Without this a refusal by the directory and a fault in this code produced the same
 * one-word reason, which is what made the first deployed run unexplainable.
 */
function describeFailure(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'directory-read-failed',
    name: typeof error?.name === 'string' ? error.name : 'Error',
    status: Number.isInteger(error?.status) ? error.status : null,
  };
}

async function readMemberIds(url, { transport, getToken }) {
  const ids = [];
  let next = url;
  while (next !== undefined && next !== null) {
    const page = await transport(next, { getToken });
    for (const entry of Array.isArray(page?.value) ? page.value : []) {
      if (typeof entry?.id === 'string' && entry.id.length > 0) ids.push(entry.id);
    }
    if (ids.length > MAX_MEMBERS_PER_GROUP) return { ids: ids.slice(0, MAX_MEMBERS_PER_GROUP), truncated: true };
    next = page?.['@odata.nextLink'];
  }
  return { ids, truncated: false };
}

/**
 * @param createCredential - makes a credential, rather than being given one. A managed
 *   identity token is minted once and reused for hours, so a process that obtained one
 *   before a permission was granted holds a token that will be refused for a long time.
 *   Being able to make another removes the copy this process is keeping. It does not
 *   shorten the wait: Azure caches managed identity tokens in its own back end for about
 *   24 hours and documents that a refresh cannot be forced before expiry. What this buys
 *   is that once that cache does turn over, the next run picks the new token up instead
 *   of holding the old one until the process ends.
 *
 * @param deriveDirectoryCode - turns a directory object identifier into a pseudonym.
 *   Required, because a raw object identifier reaching a read model would name a person
 *   in a store the product otherwise keeps pseudonymous.
 *
 *   Deliberately NOT the caller's subject key. The gateway forwards the token's `sub`,
 *   which is pairwise per application, while Graph returns the directory object id, so
 *   the two pseudonyms cannot be equal and must not be presented as joinable.
 */
export function createEntraDirectoryQuery({ createCredential, deriveDirectoryCode, transport = graphGet }) {
  if (typeof createCredential !== 'function') fail('createCredential must be callable.');
  if (typeof deriveDirectoryCode !== 'function') fail('deriveDirectoryCode is required.');
  if (typeof transport !== 'function') fail('transport must be callable.');

  let credential = null;

  const getToken = async () => {
    if (credential === null) credential = createCredential();
    const token = await credential.getToken(GRAPH_SCOPE);
    if (token?.token === undefined) fail('The credential returned no directory token.');
    return token.token;
  };

  /**
   * @param teams - the published team catalogue: which group stands for which team.
   * @returns groups shaped for `projectDirectorySnapshot`, and how complete the reading is.
   */
  async function attempt({ tenantId, teams }) {
    if (typeof tenantId !== 'string' || tenantId.length === 0) fail('tenantId is required.');
    if (!Array.isArray(teams) || teams.length === 0) fail('teams must name at least one governed group.');

    const groups = [];
    const refusals = [];
    let truncated = false;

    for (const { teamKey, membershipGroupId } of teams) {
      let direct;
      let transitive;
      try {
        // Direct and transitive are read separately because their difference is the
        // only thing that says whether a person is in the group or in one below it.
        direct = await readMemberIds(
          `${GRAPH_BASE}/groups/${membershipGroupId}/members/microsoft.graph.user?$select=id&$top=999`,
          { transport, getToken },
        );
        transitive = await readMemberIds(
          `${GRAPH_BASE}/groups/${membershipGroupId}/transitiveMembers/microsoft.graph.user?$select=id&$top=999`,
          { transport, getToken },
        );
      } catch (error) {
        // One unreadable group makes the reading partial. Dropping it would present a
        // smaller organization as the whole one.
        if (error?.code === 'directory-group-absent' || error?.code === 'directory-read-failed') {
          refusals.push(describeFailure(error));
          continue;
        }
        throw error;
      }

      truncated = truncated || direct.truncated || transitive.truncated;
      const directIds = new Set(direct.ids);
      const members = transitive.ids.map((objectId) => ({
        subjectId: deriveDirectoryCode({ tenantId, subjectId: objectId }),
        membership: directIds.has(objectId) ? 'direct' : 'inherited',
      }));

      groups.push({
        groupId: membershipGroupId,
        teamCode: teamKey,
        // The team is what the organization calls this group, and it is already in the
        // published set. Reading the directory's own name would put an organizational
        // label in the store to no end.
        displayCode: teamKey,
        members,
      });
    }

    if (groups.length === 0) {
      const error = new Error('directory-read-failed');
      error.code = 'directory-read-failed';
      error.refusals = refusals;
      throw error;
    }

    return {
      groups,
      refusals,
      source: {
        state: truncated || refusals.length > 0 ? 'truncated' : 'complete',
        revision: `graph-v1.0-${groups.length}`,
      },
    };
  }

  return async function readGovernedDirectory(request) {
    try {
      return await attempt(request);
    } catch (error) {
      // Not a retry for entitlement: a refusal is never argued with, and the second
      // attempt asks the same question with a credential made after the first was
      // refused. Only when every group was refused this way, and only once, so an
      // identity that simply lacks the permission costs one extra call and not a loop.
      const everyGroupForbidden = Array.isArray(error?.refusals)
        && error.refusals.length > 0
        && error.refusals.every((refusal) => refusal.status === 403);
      if (!everyGroupForbidden) throw error;
      credential = null;
      return attempt(request);
    }
  };
}
