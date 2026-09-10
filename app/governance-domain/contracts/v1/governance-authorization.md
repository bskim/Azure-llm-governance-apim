# Governance Authorization V1

This contract separates verified identity and membership evidence from server-owned governance authority.

`PrincipalContextV1` remains the only identity input. It contains no role, permission, entitlement, policy, routing, credential, or message-body authority. The evaluator consumes two additional trusted snapshots:

- `GovernanceAssignmentSnapshotV1` assigns stable role codes to normalized subjects, groups, or applications within explicit global or team scopes.
- `EntitlementPolicySnapshotV1` maps trusted membership groups to canonical teams and supplies global, team, subject, and application model/limit bindings.

Neither snapshot is a public request contract. The local deterministic adapter stands in for a future versioned control-plane store; query parameters, headers, and UI state never construct assignments or bindings.

## Evaluation

`evaluateGovernanceAuthorization` validates all three inputs and returns `EffectiveGovernanceAuthorizationV1`.

1. Identity and membership must pass `PrincipalContextV1` semantic validation.
2. Membership that is stale, incomplete, ambiguous, unmapped, unavailable, or expired cannot produce an allow decision.
3. Roles are resolved only from active server-owned assignments matching normalized subject, application, or authorization-relevant group evidence.
4. Group-to-team mapping comes only from the entitlement snapshot team catalog. A display name or raw group label never defines a team.
5. The active organization binding is a ceiling, not an admission grant. A caller needs an active subject, application, or governed-team binding.
6. Subject, application, and all matching governed-team model grants combine by union, then the organization ceiling removes models the organization does not allow. A direct grant remains effective when a mapped team has no binding. Zero or multiple matching teams are both valid inputs.
7. Each configured numeric limit uses the minimum applicable value. Missing fields mean no additional bound; zero is an explicit bound.
8. A caller with no specific grant returns `deny`. An authoritative empty result after applying the organization ceiling also returns `deny`. Unavailable evidence returns `unavailable`; each of these outcomes carries null effective limits.
9. The result records assignment, binding, membership, and snapshot revisions so a later audit can reproduce the decision without message bodies.

Read-scope authority and model entitlement availability are distinct. An authoritative global administrator assignment may retain read-only access to inspect a degraded entitlement state. A team-scoped assignment cannot grant team access when the team catalog itself is unavailable.

## Role Boundaries

- `end-user`: self read access only; this is the default when authoritative assignment evidence contains no matching elevated assignment.
- `team-viewer`: read access within an explicitly assigned team.
- `team-admin`: team-scoped read authority in this evaluator.
- `auditor`: read-only team or global governance access according to assignment scope.
- `governance-admin`: global read authority in this evaluator.
- `configuration-approver`: global read authority associated with configuration approval.
- `configuration-publisher`: global read authority associated with publishing and rollback.
- `platform-operator`: operational/readback authority; application assignees may receive only this role.

An assignment issued by a subject cannot grant that same subject a role. Team roles require team scope. Global governance, approval, publishing, and platform roles require global scope. These snapshot roles determine read scope; the deployed administration API separately maps validated Entra roles to write and publish capabilities.

## Versioning And Future Persistence

Snapshots and effective decisions are immutable inputs and evidence. Each snapshot has a positive aggregate `version`; each assignment or binding has a stable ID and positive item revision. Revocation and expiration retain the old record. Configuration publication creates a new revision and records its actor and target outcomes rather than rewriting earlier evidence.

The deployed change handlers read the published snapshots, apply one bounded domain edit, and publish the resulting set through the same publication path. They derive the actor from the validated administration token. A second publish is refused while another revision is in flight, and a revision becomes active only after every declared target is read back as verified.

## Forbidden Data

The schemas are closed and exclude access tokens, authorization headers, credentials, provider keys, prompts, completions, request/response bodies, backend endpoints, deployment routes, resource IDs, and caller-supplied role/permission fields.