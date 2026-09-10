# Principal Context V1

`PrincipalContextV1` is an internal, server-constructed output contract. It is not a public HTTP request body and must never be accepted from caller-controlled headers, cookies, query parameters, or serialized JSON.

The contract has two validation layers:

1. JSON Schema validates the closed transport shape, types, enums, and expressible conditionals.
2. A shared semantic validator enforces identity and membership binding, timestamp ordering, expiry at evaluation time, group uniqueness and ordering, and strict-membership eligibility.

Only a trusted factory may produce the context:

- Local development uses a deterministic adapter and marks the context `local-deterministic` / `local-trusted`.
- Production uses a validated Entra adapter and marks the context `entra-validated` / `validated`.
- The production adapter derives subject and application identity from a cryptographically validated identity result. It does not accept a caller-provided context or raw, unvalidated JWT claims.
- Membership evidence is bound to the same tenant and subject, has a bounded lifetime, and is immutable for the resulting decision/audit record.
- Correlation `requestId` is server-generated. Caller correlation, if supported later, must remain separate untrusted metadata.

Governance roles, entitlements, model selection, backend routing, credentials, tokens, and message bodies are intentionally absent. Roles and effective permissions are derived later from trusted control-plane assignments keyed by the normalized subject, application, and group evidence.

This contract is not sufficient by itself for live authorization. It is constructed only by the server-owned `PrincipalContextFactory` and checked by a shared semantic validator; no API may deserialize this schema directly from caller input.