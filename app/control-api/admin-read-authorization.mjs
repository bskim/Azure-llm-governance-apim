export function assertAuthorizedReadScope({ authorization, scope, teamKey = null }) {
  // Not knowing who the caller is and knowing they are not permitted are different
  // answers, so authority decides this rather than the emptiness of the scope list.
  if (
    authorization?.contractVersion !== 'v1' ||
    !Array.isArray(authorization.permittedReadScopes) ||
    authorization.readAuthority !== 'authoritative'
  ) {
    const error = new Error('membership-not-authoritative');
    error.code = 'membership-not-authoritative';
    error.reasonCode = authorization?.reasonCode ?? 'authorization-evidence-unavailable';
    throw error;
  }
  if (!authorization.permittedReadScopes.includes(scope)) {
    const error = new Error('scope-denied');
    error.code = 'scope-denied';
    throw error;
  }
  if (
    scope === 'team' &&
    (
      typeof teamKey !== 'string' ||
      !Array.isArray(authorization.permittedTeamKeys) ||
      !authorization.permittedTeamKeys.includes(teamKey)
    )
  ) {
    const error = new Error('team-scope-denied');
    error.code = 'team-scope-denied';
    throw error;
  }
}