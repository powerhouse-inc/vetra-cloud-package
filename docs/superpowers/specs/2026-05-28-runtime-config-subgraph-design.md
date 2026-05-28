# Runtime Config Subgraph — Design Spec

## Summary

New subgraph `runtime-config` that exposes a typed GraphQL surface for editing the deployed Connect SPA's `powerhouse.config.json` per tenant. Storage is one row per tenant in a dedicated namespace (`vetra-cloud-runtime-config`); every write emits `pg_notify('vetra_runtime_config_changed', tenantId)`. The existing `secrets-controller` pod is extended to listen on that second channel and fan the runtime-config row into the same `<tenantId>-env` ConfigMap that already projects the secrets subgraph's env vars — surfaced as a single `PH_CONNECT_CONFIG_JSON` entry that Connect's entrypoint deep-merges into `/dist/powerhouse.config.json` on pod start.

## Goals

- Tenant operators can read and write Connect's runtime config from vetra.to via a symmetric typed GraphQL API.
- Server-side validation against the runtime-config JSON Schema rejects malformed input before it can poison the ConfigMap (and crash Connect's `jq -e .` entrypoint check).
- Reads return defaults-merged `effective` so clients never have to recompute it.
- Encapsulation: the new subgraph owns its own Postgres namespace and migration. No cross-subgraph table access.
- End-to-end propagation reuses the existing pipeline: secrets-controller → ConfigMap → Stakater Reloader → Connect pod restart → entrypoint reseed.
- The two writers (`setEnvVar` from `vetra-cloud-secrets` and `setRuntimeConfig` from this subgraph) cannot race for the same ConfigMap key. The reserved-key denylist on `setEnvVar` makes `PH_CONNECT_CONFIG_JSON` writable only via this subgraph.

## Non-Goals

- No new k8s infrastructure. The chart, the `<tenantId>-env` ConfigMap, the Reloader trigger, and the Connect entrypoint are all unchanged.
- No drift detection. Reads return the desired state from Postgres immediately on save; the UI does not poll the deployed file. (Plan §3.2 v2 follow-up.)
- No zero-restart updates. Each write triggers a Connect pod rolling restart. (Variant 2 / ConfigMap-as-volume is a separate follow-up.)
- No resolver-level tenant-ownership check. Auth is at the Switchboard middleware layer, same posture as `setEnvVar` (tracked as a known cross-subgraph gap).
- No CLI parity. `ph connect config` continues to operate on the local file; integrating it with the subgraph is out of scope.
- No encryption. Runtime config is plaintext (log levels, URLs, drive lists). OpenBao Transit is not touched.

## Architecture

```
vetra.to (browser)
   │ GraphQL · Renown bearer
   ▼
Switchboard pod
   ├── vetra-cloud-secrets subgraph
   │     tables: tenant_env_vars, tenant_secrets    (in hash("vetra-cloud-secrets"))
   │     NOTIFY 'vetra_secrets_changed'
   │
   └── runtime-config subgraph                       NEW
         table: tenant_runtime_config               (in hash("vetra-cloud-runtime-config"))
         NOTIFY 'vetra_runtime_config_changed'
                   │
                   ▼ both LISTEN'd by
secrets-controller pod
   reconcileTenant(tenantId):
     envRows ← secrets schema
     secrets ← secrets schema (decrypted via OpenBao Transit)
     runtime ← runtime-config schema                 NEW
     write <tenantId>-env ConfigMap = envRows ∪ { PH_CONNECT_CONFIG_JSON: wrap(runtime) }
     write <tenantId>-secrets Secret = decrypted
                   │
                   ▼
Stakater Reloader → rolling-restart Connect → entrypoint reseed → /dist/powerhouse.config.json
```

## GraphQL Schema

```graphql
scalar JSON

type RuntimeConfigPayload {
  effective: JSON!         # BUNDLED_DEFAULT_CONNECT_CONFIG deep-merged with overrides
  overrides: JSON!         # Only the keys the user has explicitly set
  schemaVersion: String!   # "2"
  updatedAt: String        # ISO-8601, null when no overrides exist
}

extend type Query {
  runtimeConfig(tenantId: String!): RuntimeConfigPayload!
}

extend type Mutation {
  setRuntimeConfig(tenantId: String!, json: JSON!): RuntimeConfigPayload!
}
```

### Semantics

- The `json` argument is the **`connect.*` subtree** of `powerhouse.config.json`, not the full envelope. The surrounding fields (`schemaVersion`, `packages`, `localPackage`, `packageRegistryUrl`) are emitter-stamped by the build pipeline and not editable through this subgraph.
- Empty object (`{}`) deletes the tenant's row — explicit "clear all overrides, fall back to bundled defaults".
- Validation runs against `BUNDLED_CONNECT_SCHEMA` (extracted from `runtime-config.schema.json:properties.connect`). Invalid input throws `InvalidRuntimeConfigError` with `extensions.code = "INVALID_RUNTIME_CONFIG"` and a list of `{path, message}` issues.
- Reads always populate `effective` by deep-merging stored overrides on top of `BUNDLED_DEFAULT_CONNECT_CONFIG`. Corrupt stored JSON is treated as no overrides (no throw on every read).

## Storage

### Postgres

- Namespace: `vetra-cloud-runtime-config` (the reactor-api `createNamespace` argument; the actual schema name is `hashNamespace("vetra-cloud-runtime-config")`).
- Table: `tenant_runtime_config(tenantId varchar(255), value text, updatedAt varchar(255))`, PK `(tenantId)`.
- `value` is the JSON-encoded `connect.*` subtree.
- Migration is idempotent (`ifNotExists`). The secrets-controller's runtime-config reader assumes the migration has already run via the subgraph's `onSetup` (controller does not run migrations).

### NOTIFY

- Channel: `vetra_runtime_config_changed`.
- Payload: `tenantId` string. Same convention as `vetra_secrets_changed`.
- Fired in the same transaction as the upsert/delete so the controller never sees a "stale" notification.

### ConfigMap projection

When the controller's reconcileTenant runs, it reads the runtime-config row (if present) and adds one entry to the `<tenantId>-env` ConfigMap:

```
PH_CONNECT_CONFIG_JSON  = JSON.stringify({ connect: <stored value> })
```

The wrap step matters: the stored value is just the `connect.*` subtree; the entrypoint deep-merges the **full envelope** shape into `/dist/powerhouse.config.json`. Without the wrap, the merged file would lose the `connect` nesting.

Corrupt stored JSON or non-object values are skipped with a `console.error` — a single broken row does not poison the tenant's other env vars.

## Reserved-key denylist

`vetra-cloud-secrets.setEnvVar` now rejects `PH_CONNECT_CONFIG_JSON` with a clear error pointing operators at `setRuntimeConfig`. This prevents a race during rollout where a user could `setEnvVar(tenantId, "PH_CONNECT_CONFIG_JSON", "foo")` and confuse both writers.

The denylist is intentionally tiny — only keys with a dedicated owning subgraph. Adding more keys is a future concern.

## Tradeoffs

- **Why a separate subgraph (vs. folding `runtimeConfig` resolvers into `vetra-cloud-secrets`)?**
  Domain separation. Runtime config is a typed single-document-per-tenant abstraction; env vars are an open-ended key/value map. Mixing them grows `vetra-cloud-secrets` past its abstraction and complicates future evolution (per-field validation, schema versioning, role-based reads).
- **Why a separate Postgres namespace (vs. writing to `tenant_env_vars` in the secrets schema from a different subgraph)?**
  Cross-subgraph table access breaks reactor-api's encapsulation model. Each subgraph owns its `createNamespace` output. Sharing would couple the runtime-config code to the secrets schema layout and make schema-evolution dangerous.
- **Why extend the existing controller (vs. ship a second controller pod)?**
  The controller's domain is "tenant Postgres state → tenant k8s state". Adding a second source is a natural evolution. A second pod would need its own RBAC, deployment, ArgoCD app, and image — disproportionate to the work.
- **Why hardcode the second listener (vs. expose via env vars)?**
  Both the new namespace and channel are 1:1 with subgraph identity (which is code, not config). Externalising them as env vars adds the appearance of flexibility without real value, and risks misconfiguration drift between the subgraph code and the controller env.
- **Why ship the new subgraph + controller delta + denylist in one PR?**
  All three move together. Shipping the subgraph alone leaves an orphaned table; shipping the controller delta first has nothing to read; shipping the denylist first breaks no one but adds friction without payoff. Bundling makes the package version bump atomic from the cluster's perspective.

## Open Questions

- **Storage shape (full envelope vs. `connect.*` subtree).** Decided: store only `connect.*`. Future-proof if vetra.to ever wants to edit `packages` etc. would require a schema bump + migration; cheap when needed.
- **Resolver-level auth.** Same posture as `setEnvVar` (none in resolver; trust middleware). Tracked as a separate cross-subgraph hardening pass.
- **`schemaVersion` field.** Inherits `"2"` from the upstream runtime-config.schema.json. Bump in lockstep when the schema changes.

## References

- v1 plan + design (architecturally stale): `docs/superpowers/plans/2026-05-26-runtime-config-subgraph.md`, `docs/superpowers/specs/2026-05-26-runtime-config-subgraph-design.md`
- Upstream Connect runtime-config refactor: `ph-monorepo` commit `2c64c01cd` (entrypoint collapsed to single `PH_CONNECT_CONFIG_JSON` env var)
- Reference subgraph: `subgraphs/vetra-cloud-secrets/` (same `BaseSubgraph` shape, transaction + NOTIFY pattern, pglite-backed tests)
- Reference controller: `secrets-controller/` (same `hashNamespace`-recompute + LISTEN/NOTIFY loop)
- Plan v2: `RUNTIME-CONFIG-SUBGRAPH-PLAN-V2.md` in `ph-monorepo` (cross-repo coordination document)
