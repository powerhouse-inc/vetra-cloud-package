# Runtime Config Subgraph — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Tick each box and commit per task as you go.

**Goal:** Add a new subgraph `runtime-config` that lets vetra.to edit the deployed Connect SPA's `powerhouse.config.json` per tenant. Storage is one row per tenant in a dedicated namespace; every write fires a NOTIFY on a new channel that the existing `secrets-controller` pod LISTENs on as a second source, fanning the value into the same `<tenantId>-env` ConfigMap as a single `PH_CONNECT_CONFIG_JSON` entry that Connect's entrypoint deep-merges into the dist file.

**Architecture:** New `RuntimeConfigSubgraph extends BaseSubgraph`. Writes go through a single-tenant-PK Postgres table `tenant_runtime_config(tenantId PK, value, updatedAt)` in `hashNamespace("vetra-cloud-runtime-config")`. The resolver validates against `BUNDLED_CONNECT_SCHEMA` via Ajv and emits `pg_notify('vetra_runtime_config_changed', tenantId)` in the same transaction as the upsert/delete. The existing `secrets-controller` is extended to LISTEN on the second channel and to read the new namespace via a second owned Kysely pool; its reconciler wraps the stored connect-subtree as `{ connect: <stored> }` and projects it into the same `<tenantId>-env` ConfigMap alongside the secrets subgraph's existing env vars. A reserved-keys denylist on `vetra-cloud-secrets.setEnvVar` rejects the runtime-config key so the two writers cannot race.

**Tech Stack:** TypeScript, Kysely (Postgres), Ajv (JSON Schema validation), graphql-tag, vitest, pglite (test DB).

**Spec:** `docs/superpowers/specs/2026-05-28-runtime-config-subgraph-design.md`

**Branches off:** `origin/dev` (NOT `main` — main is empty `export {};` for subgraphs; only `dev` has the other two subgraphs + secrets-controller source).

**Reference code:** Treat `subgraphs/vetra-cloud-secrets/` as the canonical pattern for the new subgraph (class shape, transaction + NOTIFY mutation, pglite-backed tests). Treat `secrets-controller/` as the canonical pattern for the controller extension (owned Kysely pool, `hashNamespace` schema recompute, `PostgresListener`, reconciler factory).

---

## File Structure

### New files (subgraph)

| File | Responsibility |
|------|---------------|
| `subgraphs/runtime-config/db/schema.ts` | Kysely table interface `TenantRuntimeConfig` |
| `subgraphs/runtime-config/db/migrations.ts` | `up()` / `down()` — creates `tenant_runtime_config` table |
| `subgraphs/runtime-config/types.ts` | `PHConnectRuntimeConfig`, `RuntimeConfigPayload`, constants (`RUNTIME_CONFIG_ENV_KEY`, `RUNTIME_CONFIG_NOTIFY_CHANNEL`, `RUNTIME_CONFIG_DB_NAMESPACE`) |
| `subgraphs/runtime-config/errors.ts` | `InvalidRuntimeConfigError` (GraphQLError with `extensions.code = "INVALID_RUNTIME_CONFIG"`) |
| `subgraphs/runtime-config/bundled-defaults.ts` | Frozen snapshot of `DEFAULT_CONNECT_CONFIG.connect` |
| `subgraphs/runtime-config/bundled-schema.ts` | Frozen snapshot of `runtime-config.schema.json:properties.connect` |
| `subgraphs/runtime-config/validation.ts` | Ajv compile + `validateRuntimeConfig` |
| `subgraphs/runtime-config/defaults.ts` | `mergeWithDefaults` (deep-merge: objects merge, arrays replace, primitives replace) |
| `subgraphs/runtime-config/repository.ts` | `RuntimeConfigRepository` interface + `createRepository` factory (shared between subgraph + controller) |
| `subgraphs/runtime-config/schema.ts` | GraphQL SDL — `RuntimeConfigPayload`, `runtimeConfig` query, `setRuntimeConfig` mutation |
| `subgraphs/runtime-config/resolvers.ts` | Query + Mutation resolvers; mutation runs transaction + NOTIFY atomically |
| `subgraphs/runtime-config/index.ts` | `RuntimeConfigSubgraph` class — `extends BaseSubgraph`; `onSetup` creates namespace + runs migration |

### New files (tests)

| File | Responsibility |
|------|---------------|
| `subgraphs/runtime-config/__tests__/db-migrations.test.ts` | Migration + CRUD invariants (PK, idempotency, down) |
| `subgraphs/runtime-config/__tests__/defaults.test.ts` | `mergeWithDefaults` semantics (empty, primitive, nested, array, null, undefined, custom defaults, non-mutating) |
| `subgraphs/runtime-config/__tests__/validation.test.ts` | Ajv against valid + invalid payloads (unknown keys, type/enum mismatch, missing required) |
| `subgraphs/runtime-config/__tests__/repository.test.ts` | pglite-backed repository (none for unknown tenant; isolation; allTenantIds sorted) |
| `subgraphs/runtime-config/__tests__/resolvers.test.ts` | pglite-backed end-to-end (defaults for unknown tenant; merged for known; corrupt-value safety; upsert; clear-on-empty; INVALID_RUNTIME_CONFIG; tenant isolation) |

### New files (controller)

| File | Responsibility |
|------|---------------|
| `subgraphs/vetra-cloud-secrets/__tests__/reconciler-with-runtime-config.test.ts` | Reconciler fan-in tests (wrap envelope; no-runtime; no-env; invalid JSON; array guard; backward-compat without runtimeConfigRepo; reconcileAll unions tenant ids) |

### Modified files

| File | Change |
|------|--------|
| `subgraphs/index.ts` | Add `export * as RuntimeConfigSubgraph from "./runtime-config/index.js"` |
| `powerhouse.manifest.json` | Add `{ id: "runtime-config", name: "Runtime Config", documentTypes: ["powerhouse/vetra-cloud-environment"] }` |
| `subgraphs/vetra-cloud-secrets/resolvers.ts` | Reserved-keys denylist rejects `PH_CONNECT_CONFIG_JSON` in `setEnvVar` |
| `subgraphs/vetra-cloud-secrets/reconciler.ts` | Optional `runtimeConfigRepo` dep; `reconcileTenant` reads + wraps + injects into env ConfigMap; `reconcileAll` walks union of tenant ids |
| `secrets-controller/config.ts` | Add `RUNTIME_CONFIG_DB_NAMESPACE` + `RUNTIME_CONFIG_NOTIFY_CHANNEL` constants (Option A — hardcoded) |
| `secrets-controller/db.ts` | Add `createOwnedRuntimeConfigRepository` factory mirroring `createOwnedRepository` |
| `secrets-controller/main.ts` | Instantiate second repo + `PostgresListener`; shared `onTenantNotify`/`onReconnect` factories; health-check requires both listeners; shutdown closes both |
| `package.json` | Add `ajv` to `dependencies` |

---

## Task 1: Database schema & migrations

**Files:**
- Create: `subgraphs/runtime-config/db/schema.ts`
- Create: `subgraphs/runtime-config/db/migrations.ts`
- Create: `subgraphs/runtime-config/__tests__/db-migrations.test.ts`

**Reference:** `subgraphs/vetra-cloud-secrets/db/schema.ts`, `migrations.ts`, `__tests__/db-migrations.test.ts`.

- [x] Define `TenantRuntimeConfig` interface — `tenantId`, `value` (JSON-encoded connect subtree), `updatedAt`. Export `RuntimeConfigDB`.
- [x] Write `up(db)` migration: `createTable("tenant_runtime_config")` with primary key on `tenantId` alone (single-row-per-tenant). Use `ifNotExists()` for idempotency. Write `down(db)` to drop the table.
- [x] Write pglite-backed test covering: empty table; insert + select; tenantId PK rejects duplicate; distinct tenant rows allowed; `up` is idempotent; `down` drops the table.

**Verification:** `pnpm test subgraphs/runtime-config/__tests__/db-migrations.test.ts` passes.

---

## Task 2: Validation, defaults, types, errors

**Files:**
- Create: `subgraphs/runtime-config/types.ts`
- Create: `subgraphs/runtime-config/errors.ts`
- Create: `subgraphs/runtime-config/bundled-defaults.ts`
- Create: `subgraphs/runtime-config/bundled-schema.ts`
- Create: `subgraphs/runtime-config/validation.ts`
- Create: `subgraphs/runtime-config/defaults.ts`
- Create: `subgraphs/runtime-config/__tests__/defaults.test.ts`
- Create: `subgraphs/runtime-config/__tests__/validation.test.ts`
- Modify: `package.json` (add `ajv` to dependencies)

**Reference:** PR #23's same-named files for portable code (just the validation/defaults/types/errors — the storage-shaped code there is wrong).

- [x] Add `ajv` to `package.json` dependencies. `pnpm install`.
- [x] Write `types.ts`: `PHConnectRuntimeConfig` mirrors the connect subtree (branding, app, packages, drives, renown, sentry); `RuntimeConfigPayload = { effective, overrides, schemaVersion, updatedAt }`; constants `RUNTIME_CONFIG_ENV_KEY = "PH_CONNECT_CONFIG_JSON"`, `RUNTIME_CONFIG_SCHEMA_VERSION = "2"`, `RUNTIME_CONFIG_NOTIFY_CHANNEL = "vetra_runtime_config_changed"`, `RUNTIME_CONFIG_DB_NAMESPACE = "vetra-cloud-runtime-config"`.
- [x] Write `errors.ts`: `InvalidRuntimeConfigError extends GraphQLError`, `extensions.code = "INVALID_RUNTIME_CONFIG"`, payload `{ path, message }` issues array.
- [x] Write `bundled-defaults.ts`: frozen snapshot of `DEFAULT_CONNECT_CONFIG.connect` (branding.appName "Powerhouse Connect", app.logLevel "info", drives.defaultDrives [], etc.).
- [x] Write `bundled-schema.ts`: frozen snapshot of `runtime-config.schema.json.properties.connect` (the subtree only — not the full envelope). `additionalProperties: false` at every level.
- [x] Write `validation.ts`: Ajv `new Ajv({ allErrors: true, strict: false })`, compile `BUNDLED_CONNECT_SCHEMA`, expose `validateRuntimeConfig(json) → { ok: true } | { ok: false, issues }`.
- [x] Write `defaults.ts`: `mergeWithDefaults(overrides, defaults?)` does deep-merge with these rules — plain objects merge per-key (override wins), arrays/primitives/null replace, undefined leaves base in place. Don't mutate inputs.
- [x] Write `defaults.test.ts`: empty → clone of defaults; primitive replace; nested merge; array wholesale replace; null replaces non-null; undefined no-op; custom defaults param honoured; non-mutating.
- [x] Write `validation.test.ts`: empty `{}` ok; partial override ok; full connect-shape ok; unknown top-level rejected (additionalProperties); unknown nested rejected; type/enum mismatch rejected; `defaultDrives` item missing `url` rejected; `homeBackground: null` ok; `homeBackground: { avif, png }` ok.

**Verification:** `pnpm test subgraphs/runtime-config/__tests__/{defaults,validation}.test.ts` passes; `pnpm tsc` clean.

---

## Task 3: Repository

**Files:**
- Create: `subgraphs/runtime-config/repository.ts`
- Create: `subgraphs/runtime-config/__tests__/repository.test.ts`

**Reference:** `subgraphs/vetra-cloud-secrets/repository.ts` for the shape (interface + factory function shared between subgraph and controller).

- [x] Define `RuntimeConfigRepository` interface with two methods: `runtimeConfigForTenant(tenantId)` returns `{ value, updatedAt } | null`; `allTenantIds()` returns sorted distinct tenantIds.
- [x] Write `createRepository(db)` factory — Kysely queries against `tenant_runtime_config`.
- [x] Test: returns null for unknown tenant; returns the row when set; isolates tenants; `allTenantIds` returns [] when empty and sorted distinct otherwise.

**Verification:** `pnpm test subgraphs/runtime-config/__tests__/repository.test.ts` passes.

---

## Task 4: Resolvers + GraphQL SDL

**Files:**
- Create: `subgraphs/runtime-config/schema.ts`
- Create: `subgraphs/runtime-config/resolvers.ts`
- Create: `subgraphs/runtime-config/__tests__/resolvers.test.ts`

**Reference:** `subgraphs/vetra-cloud-secrets/{schema,resolvers}.ts` for the SDL + transaction+NOTIFY pattern.

- [ ] Write `schema.ts`: `scalar JSON`; `type RuntimeConfigPayload { effective: JSON! overrides: JSON! schemaVersion: String! updatedAt: String }`; `extend type Query { runtimeConfig(tenantId: String!): RuntimeConfigPayload! }`; `extend type Mutation { setRuntimeConfig(tenantId: String!, json: JSON!): RuntimeConfigPayload! }`.
- [ ] Write `resolvers.ts`:
  - `Query.runtimeConfig` — read row, `safeParse` value (defends against corrupt JSON + arrays), `mergeWithDefaults`, return `{ effective, overrides, schemaVersion: "2", updatedAt }`.
  - `Mutation.setRuntimeConfig` — `validateRuntimeConfig`, throw `InvalidRuntimeConfigError` on failure. In a single transaction: if `json === {}` delete the row; else upsert (`onConflict... doUpdateSet`); then `pg_notify('vetra_runtime_config_changed', tenantId)`. Return same payload shape.
- [ ] Write `resolvers.test.ts`: defaults + empty overrides for unknown tenant; merged for known; corrupt value treated as empty (no throw); array stored value treated as empty (object guard); upsert; clear-on-empty (delete + null updatedAt); INVALID_RUNTIME_CONFIG on bad enum / unknown key; tenant isolation.

**Verification:** `pnpm test subgraphs/runtime-config/__tests__/resolvers.test.ts` passes; `pnpm tsc` clean.

---

## Task 5: Subgraph class, barrel, manifest

**Files:**
- Create: `subgraphs/runtime-config/index.ts`
- Modify: `subgraphs/index.ts`
- Modify: `powerhouse.manifest.json`

**Reference:** `subgraphs/vetra-cloud-secrets/index.ts` for the `BaseSubgraph` subclass pattern. `subgraphs/index.ts` already uses `export * as` namespace re-exports for the other two subgraphs — mirror that.

- [ ] Write `subgraphs/runtime-config/index.ts`: `class RuntimeConfigSubgraph extends BaseSubgraph` with `name = "runtime-config"`, `typeDefs = schema`, `additionalContextFields = {}`. In `onSetup()`, `await this.relationalDb.createNamespace(RUNTIME_CONFIG_DB_NAMESPACE)`, run migration `up(db)`, wire `this.resolvers = createResolvers(db)`.
- [ ] Update `subgraphs/index.ts`: append `export * as RuntimeConfigSubgraph from "./runtime-config/index.js";` after the existing two.
- [ ] Update `powerhouse.manifest.json`: append `{ "id": "runtime-config", "name": "Runtime Config", "documentTypes": ["powerhouse/vetra-cloud-environment"] }` to the `subgraphs` array.

**Verification:** `pnpm tsc` clean; `pnpm build` produces `dist/node/subgraphs/runtime-config/index.mjs` and `dist/node/subgraphs/index.mjs` re-exports `RuntimeConfigSubgraph`.

---

## Task 6: Controller extension (second listener + reconciler fan-in)

**Files:**
- Modify: `secrets-controller/config.ts`
- Modify: `secrets-controller/db.ts`
- Modify: `secrets-controller/main.ts`
- Modify: `subgraphs/vetra-cloud-secrets/reconciler.ts`
- Create: `subgraphs/vetra-cloud-secrets/__tests__/reconciler-with-runtime-config.test.ts`

**Reference:** `secrets-controller/main.ts` (existing single-listener wiring) — extend symmetrically. `secrets-controller/db.ts` (`createOwnedRepository`) — duplicate the pattern for the new namespace.

- [ ] Add to `secrets-controller/config.ts`: export `RUNTIME_CONFIG_DB_NAMESPACE = "vetra-cloud-runtime-config"` and `RUNTIME_CONFIG_NOTIFY_CHANNEL = "vetra_runtime_config_changed"` as hardcoded constants (Option A — both are 1:1 with subgraph identity, no env-var override).
- [ ] Add to `secrets-controller/db.ts`: `createOwnedRuntimeConfigRepository({ databaseUrl, namespace })` — opens its own pg Pool + Kysely + `withSchema(hashNamespace(namespace))` and delegates to `subgraphs/runtime-config/repository.ts`. Returns `OwnedRuntimeConfigRepository` (schema, runtimeConfigForTenant, allTenantIds, close).
- [ ] Update `subgraphs/vetra-cloud-secrets/reconciler.ts`:
  - Add optional `runtimeConfigRepo?: RuntimeConfigRepository` to `ReconcilerDeps`.
  - In `reconcileTenant`: when the dep is provided, parallel-fetch the runtime-config row alongside env vars + secrets. If present and parses to an object (not array, not corrupt), set `envData[RUNTIME_CONFIG_ENV_KEY] = JSON.stringify({ connect: <parsed> })`. Corrupt or non-object rows are logged and skipped (a single broken row should not poison the rest of the tenant's env).
  - In `reconcileAll`: read tenant ids from both repos and walk the deduped union.
- [ ] Update `secrets-controller/main.ts`:
  - Instantiate `runtimeConfigRepo` via the new factory, log its resolved schema.
  - Pass `runtimeConfigRepo` to `createReconciler({ ... })`.
  - Factor `onTenantNotify(source)` and `onReconnect(source)` so two listeners share the same dispatch logic (with `source` in the log line).
  - Construct a second `PostgresListener` bound to `RUNTIME_CONFIG_NOTIFY_CHANNEL`. `await Promise.all([listener.start(), runtimeConfigListener.start()])`.
  - Health check: `listenerConnected` is `listener.isConnected() && runtimeConfigListener.isConnected()`.
  - Shutdown: `await Promise.all([listener.stop(), runtimeConfigListener.stop()])` and `await Promise.all([repo.close(), runtimeConfigRepo.close()])`.
- [ ] Write `reconciler-with-runtime-config.test.ts`: 7 cases — projects wrapped envelope; omits key when no runtime row; works with runtime row only (no env rows); skips on invalid JSON; skips on array value; backward-compatible when `runtimeConfigRepo` undefined; `reconcileAll` unions tenant ids.

**Verification:** `pnpm test subgraphs/vetra-cloud-secrets` — both existing reconciler tests + the new fan-in tests green; `pnpm tsc` clean.

---

## Task 7: Reserved-keys denylist in `vetra-cloud-secrets`

**Files:**
- Modify: `subgraphs/vetra-cloud-secrets/resolvers.ts`

**Reference:** the existing `KEY_PATTERN` validator in the same file — extend it with a denylist check.

- [ ] Define `RESERVED_KEYS = new Set(["PH_CONNECT_CONFIG_JSON"])`.
- [ ] In `validateKey`, after the regex check, throw a clear error if the key is reserved (point operators at `setRuntimeConfig`).
- [ ] Existing `resolvers.test.ts` should still pass (no test currently sets `PH_CONNECT_CONFIG_JSON` via `setEnvVar`).

**Verification:** `pnpm test subgraphs/vetra-cloud-secrets/__tests__/resolvers.test.ts` passes unchanged.

---

## Final verification

After all 7 tasks committed:

- [ ] `pnpm tsc` clean
- [ ] `pnpm lint` — no new errors introduced (pre-existing lint failures in `subgraphs/vetra-cloud-observability/clint-pull-worker.ts` predate this PR and are unrelated)
- [ ] `pnpm test subgraphs/runtime-config subgraphs/vetra-cloud-secrets` — all green
- [ ] `pnpm build` — `dist/node/subgraphs/runtime-config/index.mjs` exists; barrel re-exports `RuntimeConfigSubgraph`

---

## Out of scope (separate plans)

- vetra.to client integration — drop `.connect` envelope unwrap (small follow-up commit on PR #47).
- `powerhouse-k8s-hosting` `PH_REGISTRY_PACKAGES` bump — one-line per tenant after the new package version publishes.
- Drift detection / live deployed-file comparison.
- Zero-restart updates (ConfigMap-as-volume mount, Variant 2 in the original plan).
- Resolver-level tenant-ownership auth (cross-subgraph hardening, applies to `setEnvVar` too).
