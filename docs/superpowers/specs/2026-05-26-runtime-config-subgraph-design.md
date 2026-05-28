# Runtime Config Subgraph — Vetra Cloud Package Design Spec

> **Status:** approved 2026-05-26
> **Scope:** vetra-cloud-package only — the new `vetra-cloud-runtime-config` subgraph
> **Companion plan:** `docs/superpowers/plans/2026-05-26-runtime-config-subgraph.md`
> **Cross-repo master plan:** `powerhouse-inc/powerhouse:RUNTIME-CONFIG-SUBGRAPH-PLAN.md`
> **Monorepo contract spec:** `powerhouse-inc/powerhouse:docs/superpowers/specs/2026-05-26-runtime-config-subgraph-design.md`

## 1. Goal

Add a GraphQL subgraph (`vetra-cloud-runtime-config`) that lets `vetra.to` read and write the runtime configuration of a deployed Connect instance for a given tenant. The subgraph is the single source of truth for the UI; persistence is in the tenant Postgres `env_vars` table (reused, not new); the deployed `powerhouse.config.json` is an eventual output of the existing secrets-controller → ConfigMap → Reloader → Connect-entrypoint pipeline.

## 2. Contract this subgraph relies on (from monorepo)

Imported from published `@powerhousedao/*` packages — see the monorepo contract spec for the canonical definitions.

- `DEFAULT_CONNECT_CONFIG` from `@powerhousedao/shared/connect` — defaults the read resolver merges over.
- `runtimeConfigSchema` from `@powerhousedao/builder-tools` — JSON Schema (draft-07) the write resolver validates against.
- `PH_CONNECT_CONFIG_JSON` env var name — fixed; the entrypoint reads exactly this key and deep-merges its JSON value into `/dist/powerhouse.config.json` with set-if-absent semantics.
- `BaseSubgraph` and `SubgraphArgs` from `@powerhousedao/reactor-api` — base class providing `relationalDb`, `reactorClient`, and the registration shape Switchboard expects.

## 3. GraphQL surface

```graphql
scalar JSON

type RuntimeConfigPayload {
  effective: JSON!
  overrides: JSON!
  schemaVersion: String!
  updatedAt: String
}

extend type Query {
  runtimeConfig(tenantId: String!): RuntimeConfigPayload!
}

extend type Mutation {
  setRuntimeConfig(tenantId: String!, json: JSON!): RuntimeConfigPayload!
}
```

- `effective` — `DEFAULT_CONNECT_CONFIG` deep-merged with `overrides`. Always fully populated.
- `overrides` — only the JSON the user has explicitly stored; `{}` when nothing has been set.
- `schemaVersion` — `"2"` (tracks the runtime-config schema's required `schemaVersion: 2`).
- `updatedAt` — ISO-8601 of the most recent override write, or `null` when no override row exists.

## 4. Internal layout

```
subgraphs/
  index.ts                                          # codegen-managed; re-exports
  vetra-cloud-runtime-config/
    index.ts                                        # re-exports the subgraph class
    subgraph.ts                                     # VetraCloudRuntimeConfigSubgraph extends BaseSubgraph
    schema.ts                                       # typeDefs (gql template literal)
    resolvers.ts                                    # query + mutation resolver functions
    store.ts                                        # EnvVarsStore port + Kysely adapter
    defaults.ts                                     # mergeWithDefaults() over DEFAULT_CONNECT_CONFIG
    validation.ts                                   # Ajv compile + validateRuntimeConfig()
    errors.ts                                       # InvalidRuntimeConfigError
    auth.ts                                         # requireAuthenticatedUser(ctx)
    types.ts                                        # shared TS types
    __tests__/
      defaults.test.ts
      validation.test.ts
      store.test.ts                                 # pglite-backed integration
      resolvers.test.ts                             # in-memory store, unit
```

## 5. Storage model

A single row in the tenant Postgres `env_vars` table per tenant:

```
tenant_id  | key                       | value (JSON string)              | updated_at
-----------|---------------------------|----------------------------------|-----------
"<tenant>" | "PH_CONNECT_CONFIG_JSON"  | '{"connect":{"branding":{...}}}' | <timestamp>
```

The value is the raw JSON the user submits via `setRuntimeConfig`; the entrypoint will deep-merge this onto `/dist/powerhouse.config.json` at pod start.

**`EnvVarsStore` port** — a small interface the subgraph depends on, with two implementations:

- `KyselyEnvVarsStore` — wraps `IRelationalDb` from `BaseSubgraph`. Production path. Triggers the same NOTIFY channel that `vetra-cloud-secrets` writes use (so `secrets-controller` reacts identically).
- `InMemoryEnvVarsStore` — for resolver unit tests. Map-backed, synchronous, no NOTIFY.

The port intentionally keeps schema specifics behind one method pair so a deployment-specific implementation can swap in if the production `env_vars` table differs in column names. The shape `getRuntimeConfigOverrides → { value, updatedAt } | null` and `setRuntimeConfigOverrides(value | null) → { updatedAt }` is the only contract the resolvers see.

## 6. Resolver logic

### 6.1 Query `runtimeConfig`

1. Authenticated check: `ctx.user?.address` must be present (deployment-side adds the tenant-owner DID check).
2. `row = store.getRuntimeConfigOverrides(tenantId)`.
3. `overrides = row ? JSON.parse(row.value) : {}`. If parse fails, treat as `{}` (a stale row should never make the query throw).
4. `effective = mergeWithDefaults(overrides)`.
5. Return `{ effective, overrides, schemaVersion: '2', updatedAt: row?.updatedAt?.toISOString() ?? null }`.

### 6.2 Mutation `setRuntimeConfig`

1. Authenticated check (same as query).
2. Validate `json` against `runtimeConfigSchema` via Ajv. On failure, throw `InvalidRuntimeConfigError` carrying the list of `{ path, message }` issues, exposed via GraphQL `extensions: { code: 'INVALID_RUNTIME_CONFIG', issues: [...] }`.
3. If `json` is the empty object, call `store.setRuntimeConfigOverrides(tenantId, null)` (deletes the row → revert to defaults).
4. Otherwise call `store.setRuntimeConfigOverrides(tenantId, JSON.stringify(json))`.
5. Re-derive the payload: `effective = mergeWithDefaults(json)`, `overrides = json`, `updatedAt = result.updatedAt?.toISOString() ?? null`.

## 7. Defaults merge

`mergeWithDefaults(overrides: unknown): RuntimeConfigEffective` deep-merges `DEFAULT_CONNECT_CONFIG` with `overrides`:

- Plain objects merge key-by-key; override wins per key.
- Arrays are replaced wholesale by the override (no element-wise merge). Justification: arrays in runtime config (e.g., `drives.defaultDrives`, `packages`) are user-meaningful lists, not collections to extend.
- Primitive overrides replace defaults.
- `undefined` or missing keys in overrides leave the default in place.
- `null` in overrides replaces the default with `null` (used by `sentry.dsn` to explicitly disable Sentry, for example).

The implementation uses a hand-rolled recursive merge rather than `lodash.merge` to keep the dependency surface small and the array semantics explicit.

## 8. Validation

`validateRuntimeConfig(json: unknown)` compiles `runtimeConfigSchema` with Ajv (`strict: false`, `allErrors: true`) at module load and returns either `{ ok: true }` or `{ ok: false, issues: Array<{ path, message }> }`. Compilation happens once per process.

Note on schema scope: `runtimeConfigSchema` describes the top-level `RuntimePowerhouseConfig` (with `schemaVersion`, `packages`, `localPackage`, `connect`, etc). For the v1 subgraph, the UI submits a `connect.*`-only override — the validator must accept partial JSON. Implementation choice: validate the JSON as if it were a `RuntimePowerhouseConfig` with only the optional fields the user actually filled in. The schema's `additionalProperties: false` constraint already enforces shape.

## 9. Auth

`requireAuthenticatedUser(ctx)` throws `GraphQLError('Unauthenticated')` if `ctx.user?.address` is missing. The package-level subgraph stops there — it is the deployment's responsibility to wrap or extend the subgraph to add the tenant-owner DID check (so a signed-in user can only set their own tenant's config).

A future enhancement may push the tenant-owner check into the package once the package can locate the owner DID without a deployment-specific service.

## 10. Errors

- `InvalidRuntimeConfigError extends GraphQLError` with `extensions = { code: 'INVALID_RUNTIME_CONFIG', issues: Array<{ path: string; message: string }> }`. Path is the Ajv `instancePath` (or `'/'` when absent); message is `${ajvError.message}` plus a stringified `params` block when present.
- All other unexpected errors (DB connection failure, NOTIFY emit failure) bubble as standard `GraphQLError`s with the upstream message.

## 11. Test coverage

| File | What it covers |
| --- | --- |
| `defaults.test.ts` | Empty override returns clone of defaults; partial override replaces only touched keys; nested merge; array replacement; null override beats default. |
| `validation.test.ts` | Valid `connect.*` JSON passes; type mismatches fail with structured issues; missing required `schemaVersion` does NOT block (validator runs in subgraph-permissive mode if needed — see §8). |
| `store.test.ts` | pglite-backed: creates an `env_vars` table; `get → null` initially; after `set`, `get` returns value with `updatedAt`; second `set` overwrites; `set(null)` deletes the row. |
| `resolvers.test.ts` | Query with empty store returns defaults + `{}` overrides; mutation with invalid JSON throws `InvalidRuntimeConfigError`; mutation with valid JSON writes via store and returns new effective; mutation with `{}` deletes the row. |

## 12. Non-goals

- **No UI work.** Separate plan, separate package (`vetra.to`).
- **No new ConfigMap projection logic** — the existing pipeline already projects `env_vars` rows as ConfigMap entries.
- **No production wiring of the auth tenant-owner check** — the package ships the authenticated-user guard; deployment composes the rest.
- **No CLI parity** with `ph connect config` — that operates on a local file; this operates on a tenant Postgres row.

## 13. Open at integration time

- The precise `env_vars` table schema (column names + indices) is set by the production `vetra-cloud-secrets` / `secrets-controller` source, which lives outside this repo. The `KyselyEnvVarsStore` ships with the schema described in §5 (`tenant_id`, `key`, `value`, `updated_at`) and `IF EXISTS` migration guarding. If the production schema diverges, swap the implementation or override the table name; the resolvers don't care.
- NOTIFY channel name — the package emits on `env_vars_changed` by default; deployment can override via constructor option if the production channel differs.
