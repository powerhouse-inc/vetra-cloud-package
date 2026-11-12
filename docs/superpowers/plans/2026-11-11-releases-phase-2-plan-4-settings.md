# Releases phase 2, plan 4: settings Vetra owns, publisher settings and secrets — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every branch and preview instance gets the settings Vetra owns (spec section 5), including a secrets master key and an attachment signing secret generated once per instance, present before the host's first start. Publishers set their own plain settings and secrets once per App (optionally only for branch or only for preview instances). Every instance of the App gets them, and a change rolls the instances through the reconciler, with health and revert rules still applied.

**Architecture:** Publisher settings live in a new `app_settings` table in the vetra-apps namespace. Plain values are stored as they are. Secret values are stored as OpenBao transit ciphertext under the pseudo-tenant `app-settings`, the same way licensing keeps invite-code keys (`key-vault.ts`). The API never returns a secret's value. On each pass the reconciler resolves the settings for each instance kind into a **revision** (a 16-hex hash). Plain settings and the revision (`VETRA_SETTINGS_REVISION`) go into the environment document's FUSION env, which the processor already renders inline. Secrets are declared in that env by name only (`isSecret: true`, no value). The processor already turns those names into `app.secretEnv` refs to `<tenant>-secrets`. Their values are written by the reconciler into the instance tenant's encrypted `tenant_secrets` rows through the internal `SecretsService`, and the standalone secrets-controller materializes them. A first start waits until the tenant's namespace exists and its secrets were delivered and had time to land, so the host never starts with a self-generated master key. Health follows the revision as it follows the digest: observability records each pod's `VETRA_SETTINGS_REVISION`, and `ready` requires a healthy pod on the target digest **and** the target revision.

**Tech Stack:** TypeScript, Kysely (Postgres; PGlite in tests), vitest, GraphQL (vetra-apps subgraph), OpenBao transit (`OpenBaoTransitClient`), the `powerhouse/vetra-cloud-environment` document model (existing actions only), the standalone `vetra-secrets-controller` (unchanged).

**Spec:** `docs/superpowers/specs/2026-11-11-app-releases-and-instances-design.md`: section 5 ("What every instance runs": `PH_HOST`, `PH_SWITCHBOARD_DATABASE_URL`, `/data`, `PH_WORKFLOWS_SECRETS_MASTER_KEY` "generated once per instance, kept in OpenBao", `PUBLIC_URL`, `ADMINS`, access gate, `OPENROUTER_API_KEY`), 14.2 (publisher secrets, settings and files, stored in OpenBao, the same on every instance; names Vetra sets are refused; holder settings), 6 (desired state includes the settings; a failed update leaves the previous state), 14.7 (health). Slice scope and gaps 5, 7 and 9: `docs/superpowers/plans/2026-11-11-releases-phase-2-overview.md` (slice 4). Conventions and the code this builds on: `…-plan-1-branch-instances.md`, `…-plan-2-previews.md`, `…-plan-3-health.md`, `subgraphs/vetra-apps/instances/*`.

## What exists today (checked 2026-11-12 on `main` = 0.0.111)

- **How settings reach a FUSION host today** (`processors/vetra-cloud-environment/gitops.ts` `generateFusionBlock`):
  - Vetra sets `NODE_ENV`, `PUBLIC_URL=https://<host>`, `NODE_OPTIONS` (heap follows the size) and `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` inline. Then every **plain** entry of the document's `fusion.env` is set inline as well, so a document entry overrides Vetra's.
  - Every **secret** entry (`isSecret: true`; the reducer drops its value) becomes an `app.secretEnv` ref `{name, secretName: <tenant>-secrets, key: name}`.
  - Any secret entry turns on `tenantSecretsController`, which gives the standalone secrets-controller RBAC in the tenant namespace.
  - Values are never written by the processor for FUSION. The console writes them through `vetra-cloud-secrets setSecret`. Licensing writes `OPENROUTER_API_KEY` through the LLM broker.
- **The chart** (`powerhouse-k8s-hosting/powerhouse-chart/templates/app-deployment.yaml`):
  - With `app.database.enabled` (host mode), the chart itself sets `PH_SWITCHBOARD_DATABASE_URL`, `PH_REACTOR_DATABASE_URL`, `DATABASE_URL`, `LISTEN_DATABASE_URL` and `PG*`.
  - `secretEnv` refs are `optional: true`. Any `secretEnv` adds `reloader.stakater.com/auto: "true"`, so a change to `<tenant>-secrets` restarts the pod.
  - **No file mounts.** The only volume is `persistence` (`/data`).
- **Tenant secrets** (`subgraphs/vetra-cloud-secrets/services/secrets-service.ts`):
  - Rows are per tenant (`tenant_secrets`, transit key `<prefix><tenantId>`), and every write sends `pg_notify('vetra_secrets_changed', tenantId)`.
  - The controller (`secrets-controller/`) decrypts and upserts `<tenant>-env`/`<tenant>-secrets`. It skips a tenant whose namespace does not exist yet, and its safety sweep runs every 5 min.
  - `ensureSecret` writes a generated managed key only if it is absent. `WORKFLOWS_MASTER_KEY` is managed: never set by a user path, and kept by a tenant purge.
  - vetra-apps already builds an internal service (`index.ts` `studioSecrets`, OpenBao transit) when `OPENBAO_ADDR` is set.
- **The master key today:** the processor runs `ensureSecret(PH_WORKFLOWS_SECRETS_MASTER_KEY)` only for platform switchboards (`switchboardEnabled`), never for a FUSION host. Instances (slices 1-3) therefore have **no master key**. Sektar's entrypoint (`sektar/hosts/cli/README.md`) then generates one on `/data`, which for instances is ephemeral (rendered as previews, gap 5). The switchboard stores the key's fingerprint in the database on first use and refuses any other key later (`powerhouse/packages/reactor-workflow/src/reactor/secret-store.ts` `verifyKey`, `MasterKeyMismatchError`). So every restart of an instance whose database survived breaks its workflows. The same holds for `PH_ATTACHMENT_URL_SIGNING_SECRET`, which only breaks old download links. This slice fixes both. Existing instances (staging only, since production runs `VETRA_APPS_INSTANCES=off`) are recreated once (Task 9).
- **Instances render** (`subgraphs/vetra-apps/instances/render.ts`): `fusionEnv` = `PH_HOST` + `ADMINS` (= `app.owner_address`). `instanceCreateActions` sets the FUSION version at once. `instanceUpdateActions` compares env, image and version and wakes a STOPPED environment before changes.
- **Licensed environments** (`subgraphs/vetra-licensing/template.ts` `hostEnv`): `PH_HOST` + `ADMINS` (holder) + `OPENROUTER_API_KEY` (secret, LLM broker). Nothing in this plan touches them.
- **ADMINS for org apps (gap 9):** Renown answers membership per address only (`shared/renown-orgs.ts` `orgMembership`). `renown-read-model` has only *public* memberships (`memberOf`). There is no "admins of org X" query, so `ADMINS` stays the App owner in this slice.
- **Observability** (`subgraphs/vetra-cloud-observability/pod-sync.ts` `podToRow`) reads `spec.containers[0].image` and status. It does not read the container's env.
- **OpenBao from the switchboard:** licensing's `createKeyVault` (pseudo-tenant `access-codes`) already creates a transit key and encrypts and decrypts with the switchboard's role in production. The same role and prefix (`OPENBAO_TRANSIT_KEY_PREFIX`, `vetra-vetra-` in production, `vetra-staging-` on staging) cover the new `app-settings` pseudo-tenant.

## Settings model (as built here)

**Vetra owns (non-editable, shown read-only by `appSettings`):**

| Name | Value | Set by |
|---|---|---|
| `PH_HOST` | the release's host (e.g. `cli`) | document env (this repo) |
| `ADMINS` | the App owner's address (gap 9: org admins need a Renown query) | document env |
| `PUBLIC_URL` | `https://<instance host>` | processor |
| `PH_SWITCHBOARD_DATABASE_URL`, `PH_REACTOR_DATABASE_URL`, `DATABASE_URL`, `LISTEN_DATABASE_URL` | the instance's own Postgres | chart |
| `PH_WORKFLOWS_SECRETS_MASTER_KEY` | 64 hex, generated once per instance, OpenBao | tenant secrets (this plan) |
| `PH_ATTACHMENT_URL_SIGNING_SECRET` | 64 hex, generated once per instance, OpenBao | tenant secrets (this plan) |
| `NODE_OPTIONS`, `NODE_ENV` | heap sized to the instance; `production` | processor |
| `VETRA_SETTINGS_REVISION` | the revision of the App's settings the instance runs | document env (this plan) |

Also reserved (refused, never shown as set): `PH_HOST_PORT`, `PH_USER_DATA_DIR`, `PORT`, `HOSTNAME`, `PH_CONNECT_CONFIG_JSON`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `PGHOST`, `PGPORT`, `SENTRY_DSN`, `SENTRY_ENV`, `OPENPANEL_CLIENT_ID`, `OPENPANEL_API_URL`, `OPENPANEL_ENV`, `ACCESS`, and every name starting with `VETRA_`.

**Publisher settings:** `name` matches `^[A-Z][A-Z0-9_]*$` (the tenant store's `KEY_PATTERN`), is at most 128 characters and is not reserved. A secret cannot be named `NEXT_PUBLIC_*` (the reducer refuses it, because those values are inlined into browser JS). Plain values are at most 4096 bytes and may be empty. Secret values are 1 to 65536 bytes. At most 100 settings per App. `scope`: `ALL` (every instance), `BRANCH` or `PREVIEW` (only that kind; wins over `ALL` for the same name). Plain values are visible to whoever can read the gitops repository (`powerhouse-k8s-hosting`). Anything sensitive must be a secret. The console says so (follow-up plan).

**Revision:** `sha256(JSON.stringify(["v1", plain [[name, value]…], secrets [[name, write_id]…]]))`, first 16 hex, entries sorted by name after scope resolution. `write_id` is a random id per secret write, so re-setting a secret (even to the same value) rolls the instances. Re-setting a plain value to the same value does not.

**Rolling a change:** a new revision leads to these steps, under `withEnvLock(envId)` in the reconciler:
1. The instance's secrets go to its tenant: generated keys ensured, publisher secrets written in one batch, removed secrets deleted, and the controller notified.
2. The document's FUSION env gets the new plain values and `VETRA_SETTINGS_REVISION`, which leads to processor, Argo and a new pod.
3. Status goes to `updating`.

The secret change also makes Reloader restart the pod once on its own, so a change can roll the pod twice. That is harmless for dev instances.

`ready` requires a healthy pod running the target digest **and** the target revision. A failed update records `failed_digest` + `failed_settings`, and neither is retried until the digest or the revision changes. If the digest changed, the instance reverts to the last healthy digest, keeping the new settings. A settings-only failure is **not** reverted: old secret values are not kept, because they are write-only. Its reason starts with `after a settings change:`, and the publisher fixes the setting, which makes a new revision.

## Global Constraints

- Only rows of the `instances` table are touched. Licensed environments (`license_environments`, `app_warm_pool`, any document with `managedBy`), old-path previews, production environments and Studio environments are never read for settings, never given settings and never recreated (overview rule 1). The existing guards (`ours`, `instanceUpdateActions` throwing on `managedBy`/non-PREVIEW) stay in front of every write.
- Secret values never enter an environment document, a values file, a log line, a GraphQL response or an error message. The only plaintext copies are in transit between OpenBao and the tenant store, and in the tenant's k8s Secret.
- The generated keys are written only with `ensureSecret` (never overwritten). `PH_WORKFLOWS_SECRETS_MASTER_KEY` is kept by a tenant purge (`PURGE_KEPT_KEYS`), as today.
- A host's first start (FUSION version set) waits until its tenant's namespace exists (a pod row in observability's `environment_pods`), its secrets were delivered and `SECRETS_SETTLE_MS` (30 s) passed. Without `deps.tenantLive` (tests, no observability) the version is set in the same pass as the delivery.
- Mutations and the query are for whoever may operate the App (`loadAppForOwner` default: the owner, or org members with publisher capability). Admins are not special-cased.
- Additive schema only: new table `app_settings`, new nullable columns on `instances` and `environment_pods`, with `ensure…` migrations that are idempotent and race-tolerant like the existing ones.
- Kill switch: everything here runs inside the reconciler and the monitor, so `VETRA_APPS_INSTANCES=off` stops it. The API still accepts settings, because they are only stored.
- Commits: one per task, conventional (`feat(settings): …`, `feat(instances): …`, `feat(observability): …`, `feat(secrets): …`), trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Branch `feat/releases-phase-2-settings` from `main`.
- Checks after every task: `npx vitest run <the task's test files> 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. At the end: `npm run tsc`, `npm run lint`, `npx vitest run subgraphs/vetra-apps subgraphs/vetra-cloud-observability subgraphs/vetra-cloud-secrets processors/vetra-cloud-environment subgraphs/vetra-licensing`.
- No production pin of vetra-cloud-package between 2026-11-13 17:30 UTC and `vetraReleases.rollouts(appId: "43622402-be06-435a-bbfa-bb649b0d6244")` showing the Sektar v1.0.9 rollout COMPLETE.

## File structure

| File | Change |
|---|---|
| `subgraphs/vetra-cloud-secrets/services/secrets-service.ts` | `notifyTenant` |
| `subgraphs/vetra-apps/db/schema.ts`, `db/migrations.ts` | `app_settings` table; settings columns on `instances` |
| `subgraphs/vetra-apps/settings/names.ts` (new) | Vetra-owned and reserved names, input checks |
| `subgraphs/vetra-apps/settings/resolve.ts` (new) | per-kind resolution and revision (pure) |
| `subgraphs/vetra-apps/settings/repo.ts` (new) | `app_settings` reads and writes |
| `subgraphs/vetra-apps/settings/vault.ts` (new) | OpenBao transit for secrets at rest |
| `subgraphs/vetra-apps/settings/service.ts` (new) | `appSettingsFor`, `setAppSetting`, `deleteAppSetting` |
| `subgraphs/vetra-apps/settings/deliver.ts` (new) | writes an instance's secrets to its tenant |
| `subgraphs/vetra-apps/service.ts` | deps `settingsVault`, `instanceSecrets`, `tenantLive`; `deleteApp` drops settings |
| `subgraphs/vetra-apps/index.ts` | wiring (one transit client, vault, tenant secrets, `tenantLive`) |
| `subgraphs/vetra-apps/schema.ts`, `resolvers.ts` | settings types, query, mutations; `AppInstance` revisions |
| `subgraphs/vetra-apps/instances/render.ts` | `fusionEnv` with settings; create without start; helpers |
| `subgraphs/vetra-cloud-observability/db/schema.ts`, `db/migrations.ts`, `pod-sync.ts` | `environment_pods.settingsRevision` |
| `subgraphs/vetra-apps/instances/health.ts`, `cluster.ts`, `monitor.ts`, `status.ts`, `repo.ts` | settings-aware health |
| `subgraphs/vetra-apps/instances/reconciler.ts`, `service.ts` | delivery, start gate, failed key, revert rules, legacy recreate, tenant purge |
| Tests (`subgraphs/vetra-apps/__tests__/` unless noted) | `harness.ts`, `migrations.test.ts`, `settings-resolve.test.ts` (new), `settings-api.test.ts` (new), `instances-render.test.ts`, `instances-health-verdict.test.ts`, `instances-status.test.ts`, `instances-health.test.ts`, `instances-settings.test.ts` (new), `instances-reconciler.test.ts`; `subgraphs/vetra-cloud-secrets/__tests__/secrets-service.test.ts`; `subgraphs/vetra-cloud-observability/__tests__/watchers.test.ts` |
| `vetra-publish-canary/index.js` (other repo) | `GET /settings`, `CANARY_CRASH` |

---

### Task 0: Pre-flight (no code)

- [ ] **Step 1: Branch.** `git fetch && git checkout -b feat/releases-phase-2-settings origin/main`. Respect the Sektar window (Global Constraints).
- [ ] **Step 2: Confirm the master-key hazard on staging** (needs the user for kubectl; skip if not available): on the staging canary's branch instance, `kubectl -n <tenant> get deploy -o jsonpath='{..env[*].name}'` shows no `PH_WORKFLOWS_SECRETS_MASTER_KEY`, and `kubectl -n <tenant> get secret <tenant>-secrets` is absent or lacks the key. This shows the gap the plan closes. Nothing to change if it differs; record it in the PR description.
- [ ] **Step 3: Confirm the canary repo is reachable**: `git -C /home/froid/projects/vetra-publish-canary status -sb` is clean on `main` (Task 11 changes it).

---

### Task 1: `SecretsService.notifyTenant`

**Files:**
- Modify: `subgraphs/vetra-cloud-secrets/services/secrets-service.ts` (interface `SecretsService`, `createSecretsService`)
- Test: `subgraphs/vetra-cloud-secrets/__tests__/secrets-service.test.ts`

**Interfaces:**
- Produces: `SecretsService.notifyTenant(tenantId: string): Promise<void>`. It sends `pg_notify(NOTIFY_CHANNEL, tenantId)` and writes nothing. Used when a tenant's namespace has just appeared, so the controller materializes rows written earlier at once instead of on its 5-minute sweep.

- [ ] **Step 1: Write the failing test** (in the `describe` that already listens with `pglite.listen(NOTIFY_CHANNEL, …)`, mirroring its setup):

```ts
it("notifyTenant notifies the controller without writing anything", async () => {
  const pglite = new PGlite();
  const notifyDb = new Kysely<SecretsDB>({ dialect: new PGliteDialect(pglite) });
  await up(notifyDb as Kysely<any>);
  const notified: string[] = [];
  await pglite.listen(NOTIFY_CHANNEL, (payload) => notified.push(payload));
  const s = createSecretsService({ db: notifyDb, transit: mockTransit });
  await s.notifyTenant("tenant-a");
  await new Promise((r) => setTimeout(r, 20));
  expect(notified).toEqual(["tenant-a"]);
  expect(await s.listSecretKeys("tenant-a")).toEqual([]);
  expect(await s.listEnvVars("tenant-a")).toEqual([]);
  await notifyDb.destroy();
});
```

(Use the migration import the file already uses for the other notify tests; if it is named differently than `up`, use that name.)

- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-cloud-secrets/__tests__/secrets-service.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL, `s.notifyTenant is not a function`.
- [ ] **Step 3: Implement.** In the interface, after `purgeTenant`:

```ts
  /**
   * Ask the controller to (re)materialize a tenant's ConfigMap/Secret without
   * writing anything: its namespace may only now exist (rows written before
   * it did were skipped until the 5-minute sweep).
   */
  notifyTenant(tenantId: string): Promise<void>;
```

In `createSecretsService`, after `purgeTenant`:

```ts
    async notifyTenant(tenantId) {
      await sql`SELECT pg_notify(${NOTIFY_CHANNEL}, ${tenantId})`.execute(db);
    },
```

- [ ] **Step 4: Run it.** Same command. Expected: PASS. Run `npx tsc --noEmit -p . 2>&1 | grep -E "notifyTenant|SecretsService" | head` and fix any other `SecretsService` implementation the compiler names (test fakes typed as the full interface).
- [ ] **Step 5: Commit.** `git add subgraphs/vetra-cloud-secrets && git commit -m "feat(secrets): notifyTenant asks the controller to materialize a tenant" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 2: `app_settings` table and the instances' settings columns

**Files:**
- Modify: `subgraphs/vetra-apps/db/schema.ts` (new `AppSettingsTable`, `VetraAppsDB.app_settings`, `InstancesTable` columns)
- Modify: `subgraphs/vetra-apps/db/migrations.ts` (`ensureAppSettingsTable`, `ensureInstancesSettingsColumns`, both called at the end of `up`)
- Create: `subgraphs/vetra-apps/settings/repo.ts`
- Test: `subgraphs/vetra-apps/__tests__/migrations.test.ts`

**Interfaces:**
- Produces (schema): `AppSettingScope = "all" | "branch" | "preview"`. `AppSettingsTable { app_id; scope; name; secret: boolean; value: string | null; ciphertext: string | null; write_id; updated_at; updated_by }`, primary key `(app_id, scope, name)`. `InstancesTable` gets `target_settings`, `running_settings`, `failed_settings`, `settings_delivered`, `settings_delivered_at`, `health_settings`, `observed_settings` (all `string | null`).
- Produces (repo): `AppSettingRow = Selectable<AppSettingsTable>`; `listAppSettings(db, appId): Promise<AppSettingRow[]>` (by name, then scope); `upsertAppSetting(db, row: AppSettingRow): Promise<void>`; `deleteAppSetting(db, appId, scope, name): Promise<boolean>`; `deleteAppSettings(db, appId): Promise<number>`.

- [ ] **Step 1: Write the failing test** (append to `migrations.test.ts`; it already builds a PGlite Kysely and runs `up`. Reuse its setup helper, called `db` below):

```ts
import {
  deleteAppSetting,
  deleteAppSettings,
  listAppSettings,
  upsertAppSetting,
} from "../settings/repo.js";

describe("app_settings and instance settings columns", () => {
  it("are created idempotently and hold a setting per app, scope and name", async () => {
    await up(db as Kysely<any>); // second run: no error
    const row = {
      app_id: "app-1",
      scope: "all" as const,
      name: "FOO",
      secret: false,
      value: "1",
      ciphertext: null,
      write_id: "w1",
      updated_at: "2026-11-12T00:00:00.000Z",
      updated_by: "0xaa",
    };
    await upsertAppSetting(db, row);
    await upsertAppSetting(db, { ...row, value: "2", write_id: "w2" });
    await upsertAppSetting(db, { ...row, scope: "preview", value: "p" });
    expect(
      (await listAppSettings(db, "app-1")).map((r) => [r.scope, r.name, r.value]),
    ).toEqual([
      ["all", "FOO", "2"],
      ["preview", "FOO", "p"],
    ]);
    expect(await deleteAppSetting(db, "app-1", "preview", "FOO")).toBe(true);
    expect(await deleteAppSetting(db, "app-1", "preview", "FOO")).toBe(false);
    expect(await deleteAppSettings(db, "app-1")).toBe(1);
    const cols = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'instances'`.execute(db);
    const names = cols.rows.map((c) => c.column_name);
    for (const c of [
      "target_settings",
      "running_settings",
      "failed_settings",
      "settings_delivered",
      "settings_delivered_at",
      "health_settings",
      "observed_settings",
    ])
      expect(names).toContain(c);
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/migrations.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL (module `../settings/repo.js` not found).
- [ ] **Step 3: Schema.** In `db/schema.ts`, before `InstancesTable`:

```ts
/** Where a publisher setting applies (releases phase 2 slice 4): every instance, or one kind (wins over "all"). */
export type AppSettingScope = "all" | "branch" | "preview";

/** A publisher setting of an App (spec 14.2). Secrets: value null, ciphertext set. */
export interface AppSettingsTable {
  app_id: string;
  scope: AppSettingScope;
  name: string;
  secret: boolean;
  /** Plain settings only. */
  value: string | null;
  /** Secrets only: OpenBao transit ciphertext under the `app-settings` pseudo-tenant (settings/vault.ts). */
  ciphertext: string | null;
  /** Random per write: re-setting a secret (same value or not) makes a new revision. */
  write_id: string;
  updated_at: string;
  updated_by: string;
}
```

Add `app_settings: AppSettingsTable;` to `VetraAppsDB` next to `instances`. In `InstancesTable`, after `observed_digest_source`:

```ts
  /** The App's settings revision for this kind (settings/resolve.ts): what the instance should run. */
  target_settings: string | null;
  /** The revision last seen ready together with running_digest. */
  running_settings: string | null;
  /** The revision of a failed update (with failed_digest): not retried until either changes. */
  failed_settings: string | null;
  /** The revision whose secrets were written to the instance's tenant, and when. */
  settings_delivered: string | null;
  settings_delivered_at: string | null;
  /** The revision the last health check judged (the environment's VETRA_SETTINGS_REVISION). Monitor only. */
  health_settings: string | null;
  /** The revision a ready host pod runs (its VETRA_SETTINGS_REVISION env). Monitor only. */
  observed_settings: string | null;
```

- [ ] **Step 4: Migrations.** In `db/migrations.ts`, after `ensureInstancesHealthColumns`:

```ts
/** Publisher settings per App (releases phase 2 slice 4, spec 14.2). Schema builder only (namespaced). */
export async function ensureAppSettingsTable(db: Kysely<any>): Promise<void> {
  try {
    await db.schema
      .createTable("app_settings")
      .ifNotExists()
      .addColumn("app_id", "varchar(255)", (c) => c.notNull())
      .addColumn("scope", "varchar(16)", (c) => c.notNull())
      .addColumn("name", "varchar(128)", (c) => c.notNull())
      .addColumn("secret", "boolean", (c) => c.notNull())
      .addColumn("value", "text")
      .addColumn("ciphertext", "text")
      .addColumn("write_id", "varchar(64)", (c) => c.notNull())
      .addColumn("updated_at", "varchar(64)", (c) => c.notNull())
      .addColumn("updated_by", "varchar(255)", (c) => c.notNull())
      .addPrimaryKeyConstraint("app_settings_pk", ["app_id", "scope", "name"])
      .execute();
  } catch (err) {
    if (!isConcurrentIndexError(err)) throw err;
  }
}

/** Settings revisions on instances (slice 4). Nullable. */
export async function ensureInstancesSettingsColumns(
  db: Kysely<any>,
): Promise<void> {
  for (const [name, type] of [
    ["target_settings", "varchar(32)"],
    ["running_settings", "varchar(32)"],
    ["failed_settings", "varchar(32)"],
    ["settings_delivered", "varchar(32)"],
    ["settings_delivered_at", "varchar(64)"],
    ["health_settings", "varchar(32)"],
    ["observed_settings", "varchar(32)"],
  ] as const) {
    try {
      await db.schema
        .alterTable("instances")
        .addColumn(name, type, (c) => c.ifNotExists())
        .execute();
    } catch (err) {
      if (!isConcurrentIndexError(err) && !isDuplicateColumnError(err))
        throw err;
    }
  }
}
```

Append to `up`, after `await ensureInstancesHealthColumns(db);`:

```ts
  await ensureAppSettingsTable(db);
  await ensureInstancesSettingsColumns(db);
```

- [ ] **Step 5: Repo.** Create `subgraphs/vetra-apps/settings/repo.ts`:

```ts
import type { Kysely, Selectable } from "kysely";
import type {
  AppSettingScope,
  AppSettingsTable,
  VetraAppsDB,
} from "../db/schema.js";

export type AppSettingRow = Selectable<AppSettingsTable>;

export async function listAppSettings(
  db: Kysely<VetraAppsDB>,
  appId: string,
): Promise<AppSettingRow[]> {
  return db
    .selectFrom("app_settings")
    .selectAll()
    .where("app_id", "=", appId)
    .orderBy("name")
    .orderBy("scope")
    .execute();
}

export async function upsertAppSetting(
  db: Kysely<VetraAppsDB>,
  row: AppSettingRow,
): Promise<void> {
  await db
    .insertInto("app_settings")
    .values(row)
    .onConflict((oc) =>
      oc.columns(["app_id", "scope", "name"]).doUpdateSet({
        secret: row.secret,
        value: row.value,
        ciphertext: row.ciphertext,
        write_id: row.write_id,
        updated_at: row.updated_at,
        updated_by: row.updated_by,
      }),
    )
    .execute();
}

export async function deleteAppSetting(
  db: Kysely<VetraAppsDB>,
  appId: string,
  scope: AppSettingScope,
  name: string,
): Promise<boolean> {
  const r = await db
    .deleteFrom("app_settings")
    .where("app_id", "=", appId)
    .where("scope", "=", scope)
    .where("name", "=", name)
    .executeTakeFirst();
  return Number(r.numDeletedRows) > 0;
}

/** Every setting of an App (the App was deleted). */
export async function deleteAppSettings(
  db: Kysely<VetraAppsDB>,
  appId: string,
): Promise<number> {
  const r = await db
    .deleteFrom("app_settings")
    .where("app_id", "=", appId)
    .executeTakeFirst();
  return Number(r.numDeletedRows);
}
```

- [ ] **Step 6: Run it.** Same command. Expected: PASS. Then `npx tsc --noEmit -p . 2>&1 | head -20`: any `Insertable<InstancesTable>` literal the compiler flags (e.g. `syncBranchInstances`, `previewRow`, test seeds) needs no change because the new columns are nullable. Fix only real errors.
- [ ] **Step 7: Commit.** `git add subgraphs/vetra-apps && git commit -m "feat(settings): app_settings table and instance settings columns" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 3: Names Vetra owns, input checks, resolution and revision (pure)

**Files:**
- Create: `subgraphs/vetra-apps/settings/names.ts`
- Create: `subgraphs/vetra-apps/settings/resolve.ts`
- Test: `subgraphs/vetra-apps/__tests__/settings-resolve.test.ts` (new)

**Interfaces:**
- Consumes: `AppSettingRow` (Task 2), `KEY_PATTERN`, `WORKFLOWS_MASTER_KEY` from `../../vetra-cloud-secrets/services/secrets-service.js`, `InstanceKind` from `../db/schema.js`.
- Produces (`names.ts`): `SETTINGS_REVISION_ENV = "VETRA_SETTINGS_REVISION"`, `ATTACHMENT_SIGNING_KEY = "PH_ATTACHMENT_URL_SIGNING_SECRET"`, `VETRA_GENERATED_SECRETS: readonly string[]` (`[WORKFLOWS_MASTER_KEY, ATTACHMENT_SIGNING_KEY]`), `VetraSetting { name; secret; value }`, `VETRA_SETTINGS: VetraSetting[]`, `RESERVED_SETTING_NAMES: ReadonlySet<string>`, `RESERVED_PREFIXES: readonly string[]`, `MAX_SETTINGS_PER_APP = 100`, `SettingInputError`, `checkSettingName(name): void`, `checkSettingValue(name, value, secret): void`.
- Produces (`resolve.ts`): `ResolvedSecret { name; ciphertext; writeId }`, `InstanceSettings { revision; plain: {name; value}[]; secrets: ResolvedSecret[] }`, `settingsForKind(rows: AppSettingRow[], kind: InstanceKind): InstanceSettings`, `settingsRevision(plain, secrets): string`.

- [ ] **Step 1: Write the failing test** `subgraphs/vetra-apps/__tests__/settings-resolve.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  checkSettingName,
  checkSettingValue,
  RESERVED_SETTING_NAMES,
  SettingInputError,
  VETRA_SETTINGS,
} from "../settings/names.js";
import { settingsForKind, settingsRevision } from "../settings/resolve.js";
import type { AppSettingRow } from "../settings/repo.js";

const row = (o: Partial<AppSettingRow>): AppSettingRow => ({
  app_id: "app-1",
  scope: "all",
  name: "FOO",
  secret: false,
  value: "1",
  ciphertext: null,
  write_id: "w1",
  updated_at: "2026-11-12T00:00:00.000Z",
  updated_by: "0xaa",
  ...o,
});

describe("setting names", () => {
  it.each([
    "PH_HOST",
    "ADMINS",
    "PUBLIC_URL",
    "PH_SWITCHBOARD_DATABASE_URL",
    "PH_WORKFLOWS_SECRETS_MASTER_KEY",
    "PH_ATTACHMENT_URL_SIGNING_SECRET",
    "PH_HOST_PORT",
    "PGPASSWORD",
    "VETRA_SETTINGS_REVISION",
    "VETRA_ANYTHING",
  ])("refuses %s (Vetra sets it)", (name) => {
    expect(() => checkSettingName(name)).toThrow(SettingInputError);
  });

  it.each(["lower", "1ABC", "A-B", "", "A".repeat(129)])(
    "refuses the malformed name %j",
    (name) => {
      expect(() => checkSettingName(name)).toThrow(SettingInputError);
    },
  );

  it("accepts a publisher name, including OPENROUTER_API_KEY on dev instances", () => {
    expect(() => checkSettingName("SEKTAR_OAUTH_RELAY_BASE")).not.toThrow();
    expect(() => checkSettingName("OPENROUTER_API_KEY")).not.toThrow();
  });

  it("lists every Vetra setting as reserved", () => {
    for (const s of VETRA_SETTINGS) expect(RESERVED_SETTING_NAMES.has(s.name)).toBe(true);
  });

  it("checks values: secrets non-empty and not NEXT_PUBLIC_, sizes bounded", () => {
    expect(() => checkSettingValue("FOO", "", false)).not.toThrow();
    expect(() => checkSettingValue("FOO", "", true)).toThrow(SettingInputError);
    expect(() => checkSettingValue("NEXT_PUBLIC_X", "v", true)).toThrow(SettingInputError);
    expect(() => checkSettingValue("FOO", "x".repeat(4097), false)).toThrow(SettingInputError);
    expect(() => checkSettingValue("FOO", "x".repeat(65537), true)).toThrow(SettingInputError);
    expect(() => checkSettingValue("FOO", "x".repeat(65536), true)).not.toThrow();
  });
});

describe("settingsForKind", () => {
  it("lets a kind's own setting win over ALL and keeps the others", () => {
    const rows = [
      row({ name: "A", value: "all" }),
      row({ name: "A", scope: "preview", value: "preview" }),
      row({ name: "B", value: "b" }),
      row({ name: "C", scope: "branch", value: "branch only" }),
    ];
    expect(settingsForKind(rows, "preview").plain).toEqual([
      { name: "A", value: "preview" },
      { name: "B", value: "b" },
    ]);
    expect(settingsForKind(rows, "branch").plain).toEqual([
      { name: "A", value: "all" },
      { name: "B", value: "b" },
      { name: "C", value: "branch only" },
    ]);
  });

  it("separates secrets (ciphertext and write id only)", () => {
    const s = settingsForKind(
      [row({ name: "S", secret: true, value: null, ciphertext: "ct", write_id: "w9" })],
      "branch",
    );
    expect(s.plain).toEqual([]);
    expect(s.secrets).toEqual([{ name: "S", ciphertext: "ct", writeId: "w9" }]);
  });

  it("a kind-scoped plain setting replaces an ALL secret of the same name", () => {
    const s = settingsForKind(
      [
        row({ name: "S", secret: true, value: null, ciphertext: "ct" }),
        row({ name: "S", scope: "preview", value: "plain" }),
      ],
      "preview",
    );
    expect(s.secrets).toEqual([]);
    expect(s.plain).toEqual([{ name: "S", value: "plain" }]);
  });

  it("shared and own kinds get ALL only (phase 3 adds per-template settings)", () => {
    const rows = [row({ name: "A" }), row({ name: "B", scope: "branch" })];
    expect(settingsForKind(rows, "shared").plain.map((p) => p.name)).toEqual(["A"]);
  });

  it("has a stable 16-hex revision that follows values and secret writes", () => {
    const base = settingsForKind([row({})], "branch").revision;
    expect(base).toMatch(/^[0-9a-f]{16}$/);
    expect(settingsForKind([row({})], "branch").revision).toBe(base);
    expect(settingsForKind([row({ value: "2" })], "branch").revision).not.toBe(base);
    const sec = (w: string) =>
      settingsForKind([row({ secret: true, value: null, ciphertext: "x", write_id: w })], "branch").revision;
    expect(sec("w1")).not.toBe(sec("w2"));
    expect(settingsRevision([], [])).toBe(settingsForKind([], "preview").revision);
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/settings-resolve.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL (modules missing).
- [ ] **Step 3: `names.ts`.**

```ts
import {
  KEY_PATTERN,
  WORKFLOWS_MASTER_KEY,
} from "../../vetra-cloud-secrets/services/secrets-service.js";

/** Plain env on every instance: the App settings revision it runs (health compares it). */
export const SETTINGS_REVISION_ENV = "VETRA_SETTINGS_REVISION";
/** Signs attachment download links; generated once per instance like the master key. */
export const ATTACHMENT_SIGNING_KEY = "PH_ATTACHMENT_URL_SIGNING_SECRET";
/**
 * Secrets Vetra generates once per instance (tenant secrets store, ensureSecret:
 * never overwritten). A host with an ephemeral /data would otherwise generate
 * its own on every start, and the switchboard refuses a master key other than
 * the one its database first used.
 */
export const VETRA_GENERATED_SECRETS: readonly string[] = [
  WORKFLOWS_MASTER_KEY,
  ATTACHMENT_SIGNING_KEY,
];

export interface VetraSetting {
  name: string;
  secret: boolean;
  /** What Vetra sets: the value, or a description of a per-instance value. */
  value: string;
}

/** What Vetra sets on every branch and preview instance (spec section 5). Shown read-only. */
export const VETRA_SETTINGS: VetraSetting[] = [
  { name: "PH_HOST", secret: false, value: "the release's host (e.g. cli)" },
  { name: "ADMINS", secret: false, value: "the App's owner" },
  { name: "PUBLIC_URL", secret: false, value: "https://<instance host>" },
  { name: "PH_SWITCHBOARD_DATABASE_URL", secret: true, value: "the instance's own Postgres database" },
  { name: "PH_REACTOR_DATABASE_URL", secret: true, value: "the instance's own Postgres database" },
  { name: "DATABASE_URL", secret: true, value: "the instance's own Postgres database" },
  { name: "LISTEN_DATABASE_URL", secret: true, value: "the instance's own Postgres database (direct, for LISTEN)" },
  { name: WORKFLOWS_MASTER_KEY, secret: true, value: "generated once per instance, kept in OpenBao" },
  { name: ATTACHMENT_SIGNING_KEY, secret: true, value: "generated once per instance, kept in OpenBao" },
  { name: "NODE_ENV", secret: false, value: "production" },
  { name: "NODE_OPTIONS", secret: false, value: "a heap sized to the instance" },
  { name: SETTINGS_REVISION_ENV, secret: false, value: "the revision of this App's settings the instance runs" },
];

/** Set by the processor or the chart, or planned (ACCESS, phase 3): refused, not listed as set. */
const ALSO_RESERVED = [
  "PH_HOST_PORT",
  "PH_USER_DATA_DIR",
  "PORT",
  "HOSTNAME",
  "PH_CONNECT_CONFIG_JSON",
  "PGUSER",
  "PGPASSWORD",
  "PGDATABASE",
  "PGHOST",
  "PGPORT",
  "SENTRY_DSN",
  "SENTRY_ENV",
  "OPENPANEL_CLIENT_ID",
  "OPENPANEL_API_URL",
  "OPENPANEL_ENV",
  "ACCESS",
];

export const RESERVED_SETTING_NAMES: ReadonlySet<string> = new Set([
  ...VETRA_SETTINGS.map((s) => s.name),
  ...ALSO_RESERVED,
]);
export const RESERVED_PREFIXES: readonly string[] = ["VETRA_"];

export const MAX_SETTINGS_PER_APP = 100;
const MAX_NAME_LENGTH = 128;
const MAX_PLAIN_BYTES = 4096;
const MAX_SECRET_BYTES = 65536;

export class SettingInputError extends Error {
  override name = "SettingInputError";
}

export function checkSettingName(name: string): void {
  if (!KEY_PATTERN.test(name) || name.length > MAX_NAME_LENGTH)
    throw new SettingInputError(
      `"${name.slice(0, 40)}" is not a setting name: use capitals, digits and _ (starting with a capital, at most ${MAX_NAME_LENGTH} characters)`,
    );
  if (
    RESERVED_SETTING_NAMES.has(name) ||
    RESERVED_PREFIXES.some((p) => name.startsWith(p))
  )
    throw new SettingInputError(`"${name}" is set by Vetra; it cannot be set`);
}

/** Never echoes the value. */
export function checkSettingValue(
  name: string,
  value: string,
  secret: boolean,
): void {
  const bytes = Buffer.byteLength(value, "utf8");
  if (secret) {
    if (name.startsWith("NEXT_PUBLIC_"))
      throw new SettingInputError(
        `"${name}" cannot be a secret: NEXT_PUBLIC_ values are inlined into browser JavaScript`,
      );
    if (bytes === 0) throw new SettingInputError(`The secret "${name}" is empty`);
    if (bytes > MAX_SECRET_BYTES)
      throw new SettingInputError(`The secret "${name}" is larger than 64 KiB`);
  } else if (bytes > MAX_PLAIN_BYTES)
    throw new SettingInputError(
      `"${name}" is larger than 4 KiB; store large values as a secret`,
    );
}
```

- [ ] **Step 4: `resolve.ts`.**

```ts
import { createHash } from "node:crypto";
import type { InstanceKind } from "../db/schema.js";
import type { AppSettingRow } from "./repo.js";

export interface ResolvedSecret {
  name: string;
  ciphertext: string;
  writeId: string;
}

/** An instance kind's settings: what its environment and its tenant get. */
export interface InstanceSettings {
  /** 16 hex; VETRA_SETTINGS_REVISION. */
  revision: string;
  plain: Array<{ name: string; value: string }>;
  secrets: ResolvedSecret[];
}

const byName = <T extends { name: string }>(a: T, b: T) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

export function settingsRevision(
  plain: InstanceSettings["plain"],
  secrets: ResolvedSecret[],
): string {
  const doc = JSON.stringify([
    "v1",
    [...plain].sort(byName).map((p) => [p.name, p.value]),
    [...secrets].sort(byName).map((s) => [s.name, s.writeId]),
  ]);
  return createHash("sha256").update(doc).digest("hex").slice(0, 16);
}

/**
 * The settings of one instance kind: its own scope wins over "all" by name.
 * shared and own instances (phase 3) get "all" only until templates carry
 * their own (overview gap 7).
 */
export function settingsForKind(
  rows: AppSettingRow[],
  kind: InstanceKind,
): InstanceSettings {
  const chosen = new Map<string, AppSettingRow>();
  for (const r of rows) if (r.scope === "all") chosen.set(r.name, r);
  for (const r of rows) if (r.scope === kind) chosen.set(r.name, r);
  const plain: InstanceSettings["plain"] = [];
  const secrets: ResolvedSecret[] = [];
  for (const r of chosen.values()) {
    if (r.secret) {
      if (r.ciphertext)
        secrets.push({ name: r.name, ciphertext: r.ciphertext, writeId: r.write_id });
    } else plain.push({ name: r.name, value: r.value ?? "" });
  }
  plain.sort(byName);
  secrets.sort(byName);
  return { revision: settingsRevision(plain, secrets), plain, secrets };
}
```

- [ ] **Step 5: Run it.** Same command. Expected: PASS.
- [ ] **Step 6: Commit.** `git add subgraphs/vetra-apps/settings subgraphs/vetra-apps/__tests__/settings-resolve.test.ts && git commit -m "feat(settings): names Vetra owns, input checks and per-kind revision" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 4: Secrets at rest, the tenant store and their wiring

**Files:**
- Create: `subgraphs/vetra-apps/settings/vault.ts`
- Modify: `subgraphs/vetra-apps/service.ts` (`AppsDeps`)
- Modify: `subgraphs/vetra-apps/index.ts` (one transit client, `settingsVault`, `instanceSecrets`, `tenantLive`)
- Modify: `subgraphs/vetra-apps/__tests__/harness.ts` (`fakeTenantSecrets`, `fakeVault`, `Harness.secrets`)
- Test: `subgraphs/vetra-apps/__tests__/settings-resolve.test.ts` (vault round trip)

**Interfaces:**
- Produces: `APP_SETTINGS_TRANSIT_TENANT = "app-settings"`; `SettingsVault { encrypt(plaintext): Promise<string>; decrypt(ciphertext): Promise<string> }`; `createSettingsVault(transit | null): SettingsVault | null`.
- Produces (`AppsDeps`): `settingsVault?: SettingsVault | null`; `instanceSecrets?: Pick<SecretsService, "ensureSecret" | "setSecrets" | "deleteSecret" | "notifyTenant" | "purgeTenant"> | null`; `tenantLive?: ((tenantId: string) => Promise<boolean>) | null`.
- Produces (harness): `fakeTenantSecrets()` returning the `instanceSecrets` shape plus `store: Map<string, Map<string, string>>`, `notified: string[]`, `purged: string[]`; `fakeVault(): SettingsVault`; `Harness.secrets`.

- [ ] **Step 1: Write the failing test** (append to `settings-resolve.test.ts`):

```ts
import { createSettingsVault, APP_SETTINGS_TRANSIT_TENANT } from "../settings/vault.js";

describe("createSettingsVault", () => {
  it("is null without OpenBao and uses the app-settings transit key otherwise", async () => {
    expect(createSettingsVault(null)).toBeNull();
    const calls: string[] = [];
    const vault = createSettingsVault({
      ensureTenantKey: async (t) => void calls.push(`key:${t}`),
      encrypt: async (t, p) => (calls.push(`enc:${t}`), `ct(${p})`),
      decrypt: async (t, c) => (calls.push(`dec:${t}`), c.slice(3, -1)),
    })!;
    expect(await vault.decrypt(await vault.encrypt("s3cret"))).toBe("s3cret");
    expect(calls).toEqual([
      `key:${APP_SETTINGS_TRANSIT_TENANT}`,
      `enc:${APP_SETTINGS_TRANSIT_TENANT}`,
      `dec:${APP_SETTINGS_TRANSIT_TENANT}`,
    ]);
  });
});
```

- [ ] **Step 2: Run it.** Expected: FAIL (module missing).
- [ ] **Step 3: `vault.ts`.**

```ts
import type { OpenBaoTransitClient } from "../../vetra-cloud-secrets/openbao-transit.js";

/**
 * The OpenBao transit pseudo-tenant publisher secrets are encrypted under
 * (transit key `<OPENBAO_TRANSIT_KEY_PREFIX>app-settings`), as licensing keeps
 * invite-code keys under `access-codes` (vetra-licensing/key-vault.ts).
 */
export const APP_SETTINGS_TRANSIT_TENANT = "app-settings";

export interface SettingsVault {
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
}

/** Null without a transit client (OPENBAO_ADDR unset): secret settings are refused. */
export function createSettingsVault(
  transit: Pick<OpenBaoTransitClient, "ensureTenantKey" | "encrypt" | "decrypt"> | null,
): SettingsVault | null {
  if (!transit) return null;
  return {
    async encrypt(plaintext) {
      await transit.ensureTenantKey(APP_SETTINGS_TRANSIT_TENANT);
      return transit.encrypt(APP_SETTINGS_TRANSIT_TENANT, plaintext);
    },
    decrypt: (ciphertext) => transit.decrypt(APP_SETTINGS_TRANSIT_TENANT, ciphertext),
  };
}
```

- [ ] **Step 4: Deps.** In `service.ts` `AppsDeps`, after `studioSecrets`:

```ts
  /** Publisher secrets at rest (settings/vault.ts). Null/absent: secret settings are refused (SERVICE_NOT_CONFIGURED). */
  settingsVault?: SettingsVault | null;
  /**
   * Vetra's own writer of tenant secrets, for instances (generated keys and
   * publisher secrets). Null/absent: instances cannot be created or given
   * settings (SERVICE_NOT_CONFIGURED on the instance).
   */
  instanceSecrets?: Pick<
    SecretsService,
    "ensureSecret" | "setSecrets" | "deleteSecret" | "notifyTenant" | "purgeTenant"
  > | null;
  /**
   * Whether a tenant's namespace exists (observability has a pod of it). Absent:
   * an instance's first start does not wait for it (tests).
   */
  tenantLive?: ((tenantId: string) => Promise<boolean>) | null;
```

Import `type SettingsVault` from `./settings/vault.js`.

- [ ] **Step 5: Wiring.** In `index.ts`, replace the `studioSecrets` block with one transit client shared by both:

```ts
    const openbaoAddr = process.env.OPENBAO_ADDR;
    const transit = openbaoAddr
      ? new OpenBaoTransitClient({
          addr: openbaoAddr,
          role: process.env.OPENBAO_TRANSIT_ROLE ?? "vetra-secrets",
          keyNamePrefix: process.env.OPENBAO_TRANSIT_KEY_PREFIX,
        })
      : null;
    const tenantSecrets = transit
      ? createSecretsService({
          db: (await this.relationalDb.createNamespace(
            "vetra-cloud-secrets",
          )) as unknown as Kysely<SecretsDB>,
          transit,
        })
      : null;
    const studioSecrets = tenantSecrets;
```

In the `deps` literal, after `studioSecrets,`:

```ts
      instanceSecrets: tenantSecrets,
      settingsVault: createSettingsVault(transit),
      // A namespace exists once observability has seen one of its pods (the database comes first).
      tenantLive: async (tenantId) =>
        !!(await orgHandoverDb
          .selectFrom("environment_pods")
          .select("id")
          .where("tenantId", "=", tenantId)
          .limit(1)
          .executeTakeFirst()),
```

- [ ] **Step 6: Harness.** In `harness.ts` add:

```ts
/** The tenant secrets store as instances use it: values in memory, notifications recorded. */
export function fakeTenantSecrets() {
  const store = new Map<string, Map<string, string>>();
  const notified: string[] = [];
  const purged: string[] = [];
  const of = (t: string) => {
    if (!store.has(t)) store.set(t, new Map());
    return store.get(t)!;
  };
  return {
    store,
    notified,
    purged,
    async ensureSecret(tenantId: string, key: string, generate: () => string) {
      const m = of(tenantId);
      if (m.has(key)) return false;
      m.set(key, generate());
      return true;
    },
    async setSecrets(tenantId: string, entries: Array<{ key: string; value: string }>) {
      for (const e of entries) of(tenantId).set(e.key, e.value);
      if (entries.length > 0) notified.push(tenantId);
    },
    async deleteSecret(tenantId: string, key: string) {
      return of(tenantId).delete(key);
    },
    async notifyTenant(tenantId: string) {
      notified.push(tenantId);
    },
    async purgeTenant(tenantId: string) {
      purged.push(tenantId);
      const m = of(tenantId);
      let secrets = 0;
      for (const k of [...m.keys()])
        if (k !== "PH_WORKFLOWS_SECRETS_MASTER_KEY") {
          m.delete(k);
          secrets++;
        }
      return { envVars: 0, secrets };
    },
  };
}

/** Reversible stand-in for OpenBao transit. */
export const fakeVault = (): SettingsVault => ({
  encrypt: async (p) => `vault:${Buffer.from(p).toString("base64")}`,
  decrypt: async (c) => Buffer.from(c.slice("vault:".length), "base64").toString(),
});
```

Add `secrets: ReturnType<typeof fakeTenantSecrets>;` to `Harness`. In `makeHarness`, create `const secrets = fakeTenantSecrets();`, add `instanceSecrets: secrets, settingsVault: fakeVault(),` to `deps` (no `tenantLive`: no start gate in tests unless a test sets it), and `secrets,` to the returned object.

- [ ] **Step 7: Run.** `npx vitest run subgraphs/vetra-apps/__tests__/settings-resolve.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20` → PASS. `npx tsc --noEmit -p . 2>&1 | head -20` → clean.
- [ ] **Step 8: Commit.** `git add subgraphs/vetra-apps && git commit -m "feat(settings): OpenBao vault for publisher secrets; tenant secrets for instances" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 5: Settings API (owner-only query and mutations)

**Files:**
- Create: `subgraphs/vetra-apps/settings/service.ts`
- Modify: `subgraphs/vetra-apps/schema.ts`, `subgraphs/vetra-apps/resolvers.ts`
- Modify: `subgraphs/vetra-apps/service.ts` (`deleteApp` drops the App's settings)
- Test: `subgraphs/vetra-apps/__tests__/settings-api.test.ts` (new)

**Interfaces:**
- Consumes: Task 2 repo, Task 3 names, Task 4 `deps.settingsVault`, `loadAppForOwner` (default `need`: operate).
- Produces: `appSettingsFor(deps, caller, appId): Promise<AppSettingsJson>`; `setAppSetting(deps, caller, input: SetAppSettingInput): Promise<AppSettingJson>`; `deleteAppSetting(deps, caller, appId, name, scope?): Promise<boolean>`. `AppSettingJson { name; scope: "ALL" | "BRANCH" | "PREVIEW"; secret; value: string | null; updatedAt; updatedBy }`. GraphQL `appSettings(appId)`, `setAppSetting(input)`, `deleteAppSetting(appId, name, scope)`.

- [ ] **Step 1: Write the failing test** `subgraphs/vetra-apps/__tests__/settings-api.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHarness, owner, seedActiveApp, stranger, type Harness } from "./harness.js";
import {
  appSettingsFor,
  deleteAppSetting,
  setAppSetting,
} from "../settings/service.js";
import { listAppSettings } from "../settings/repo.js";
import { deleteApp } from "../service.js";

let h: Harness;
let appId: string;
beforeEach(async () => {
  h = await makeHarness();
  appId = (await seedActiveApp(h)).id;
});
afterEach(async () => {
  await h.close();
});

const set = (o: Partial<Parameters<typeof setAppSetting>[2]> = {}) =>
  setAppSetting(h.deps, owner, {
    appId,
    name: "FOO",
    value: "bar",
    secret: false,
    ...o,
  });

describe("publisher settings", () => {
  it("stores a plain setting and shows its value", async () => {
    expect(await set()).toMatchObject({ name: "FOO", scope: "ALL", secret: false, value: "bar" });
    const all = await appSettingsFor(h.deps, owner, appId);
    expect(all.settings).toEqual([expect.objectContaining({ name: "FOO", value: "bar" })]);
    expect(all.vetra.map((v) => v.name)).toContain("PH_WORKFLOWS_SECRETS_MASTER_KEY");
    expect(all.reservedPrefixes).toEqual(["VETRA_"]);
  });

  it("keeps a secret write-only: encrypted at rest, never returned", async () => {
    const out = await set({ name: "API_TOKEN", value: "s3cret", secret: true });
    expect(out.value).toBeNull();
    const [row] = await listAppSettings(h.db, appId);
    expect(row.value).toBeNull();
    expect(row.ciphertext).not.toContain("s3cret");
    expect(JSON.stringify(await appSettingsFor(h.deps, owner, appId))).not.toContain("s3cret");
  });

  it("replacing a secret gives it a new write id; a plain one may become secret", async () => {
    await set({ name: "K", value: "a", secret: true });
    const w1 = (await listAppSettings(h.db, appId))[0].write_id;
    await set({ name: "K", value: "a", secret: true });
    expect((await listAppSettings(h.db, appId))[0].write_id).not.toBe(w1);
    await set({ name: "P", value: "x" });
    await set({ name: "P", value: "y", secret: true });
    const p = (await listAppSettings(h.db, appId)).find((r) => r.name === "P")!;
    expect(p).toMatchObject({ secret: true, value: null });
  });

  it("scopes a setting to one kind and deletes it by scope", async () => {
    await set({ scope: "PREVIEW", value: "p" });
    await set({ value: "all" });
    expect((await appSettingsFor(h.deps, owner, appId)).settings.map((s) => s.scope)).toEqual([
      "ALL",
      "PREVIEW",
    ]);
    expect(await deleteAppSetting(h.deps, owner, appId, "FOO", "PREVIEW")).toBe(true);
    expect(await deleteAppSetting(h.deps, owner, appId, "FOO", "PREVIEW")).toBe(false);
    expect((await appSettingsFor(h.deps, owner, appId)).settings).toHaveLength(1);
  });

  it("refuses names Vetra sets, malformed names and bad values (BAD_USER_INPUT)", async () => {
    for (const o of [
      { name: "ADMINS" },
      { name: "VETRA_X" },
      { name: "lower" },
      { name: "S", value: "", secret: true },
    ])
      await expect(set(o)).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
  });

  it("caps an App at 100 settings, replacing one is still allowed", async () => {
    for (let i = 0; i < 100; i++) await set({ name: `S${i}`, value: "v" });
    await expect(set({ name: "ONE_MORE" })).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT" },
    });
    await expect(set({ name: "S0", value: "w" })).resolves.toBeTruthy();
  });

  it("refuses secrets without OpenBao, and strangers entirely", async () => {
    h.deps.settingsVault = null;
    await expect(set({ secret: true })).rejects.toMatchObject({
      extensions: { code: "SERVICE_NOT_CONFIGURED" },
    });
    await expect(
      setAppSetting(h.deps, stranger, { appId, name: "FOO", value: "x", secret: false }),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    await expect(appSettingsFor(h.deps, stranger, appId)).rejects.toMatchObject({
      extensions: { code: "FORBIDDEN" },
    });
  });

  it("goes with the App", async () => {
    await set();
    await deleteApp(h.deps, owner, appId, false);
    expect(await listAppSettings(h.db, appId)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/settings-api.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL (module missing).
- [ ] **Step 3: `settings/service.ts`.**

```ts
import type { Caller } from "../auth.js";
import type { AppSettingScope } from "../db/schema.js";
import { appsError, notConfigured } from "../errors.js";
import { loadAppForOwner, type AppsDeps } from "../service.js";
import {
  checkSettingName,
  checkSettingValue,
  MAX_SETTINGS_PER_APP,
  RESERVED_PREFIXES,
  RESERVED_SETTING_NAMES,
  SettingInputError,
  VETRA_SETTINGS,
  type VetraSetting,
} from "./names.js";
import {
  deleteAppSetting as deleteRow,
  listAppSettings,
  upsertAppSetting,
  type AppSettingRow,
} from "./repo.js";

export type AppSettingScopeName = "ALL" | "BRANCH" | "PREVIEW";
const TO_SCOPE: Record<AppSettingScopeName, AppSettingScope> = {
  ALL: "all",
  BRANCH: "branch",
  PREVIEW: "preview",
};
const FROM_SCOPE: Record<AppSettingScope, AppSettingScopeName> = {
  all: "ALL",
  branch: "BRANCH",
  preview: "PREVIEW",
};

export interface AppSettingJson {
  name: string;
  scope: AppSettingScopeName;
  secret: boolean;
  /** Plain settings only; null for secrets (write-only). */
  value: string | null;
  updatedAt: string;
  updatedBy: string;
}

export interface AppSettingsJson {
  settings: AppSettingJson[];
  vetra: VetraSetting[];
  reservedNames: string[];
  reservedPrefixes: string[];
}

export interface SetAppSettingInput {
  appId: string;
  name: string;
  value: string;
  secret: boolean;
  scope?: AppSettingScopeName | null;
}

const json = (r: AppSettingRow): AppSettingJson => ({
  name: r.name,
  scope: FROM_SCOPE[r.scope],
  secret: r.secret,
  value: r.secret ? null : r.value,
  updatedAt: r.updated_at,
  updatedBy: r.updated_by,
});

function scopeOf(s: AppSettingScopeName | null | undefined): AppSettingScope {
  const scope = TO_SCOPE[s ?? "ALL"];
  if (!scope) throw appsError("BAD_USER_INPUT", `Unknown scope ${String(s)}`);
  return scope;
}

const scopeOrder: Record<AppSettingScope, number> = { all: 0, branch: 1, preview: 2 };

/** The App's settings (spec 14.2) and the ones Vetra sets itself. Operators only: plain values may be private. */
export async function appSettingsFor(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
): Promise<AppSettingsJson> {
  const app = await loadAppForOwner(deps, caller, appId);
  const rows = await listAppSettings(deps.db, app.id);
  rows.sort(
    (a, b) => a.name.localeCompare(b.name) || scopeOrder[a.scope] - scopeOrder[b.scope],
  );
  return {
    settings: rows.map(json),
    vetra: VETRA_SETTINGS,
    reservedNames: [...RESERVED_SETTING_NAMES].sort(),
    reservedPrefixes: [...RESERVED_PREFIXES],
  };
}

/** Sets or replaces one setting; instances get it on the reconciler's next pass. */
export async function setAppSetting(
  deps: AppsDeps,
  caller: Caller,
  input: SetAppSettingInput,
): Promise<AppSettingJson> {
  const app = await loadAppForOwner(deps, caller, input.appId);
  const scope = scopeOf(input.scope);
  try {
    checkSettingName(input.name);
    checkSettingValue(input.name, input.value, input.secret);
  } catch (err) {
    if (err instanceof SettingInputError) throw appsError("BAD_USER_INPUT", err.message);
    throw err;
  }
  const existing = await listAppSettings(deps.db, app.id);
  const replaces = existing.some((r) => r.scope === scope && r.name === input.name);
  if (!replaces && existing.length >= MAX_SETTINGS_PER_APP)
    throw appsError(
      "BAD_USER_INPUT",
      `An App has at most ${MAX_SETTINGS_PER_APP} settings; delete one first`,
    );
  let ciphertext: string | null = null;
  if (input.secret) {
    if (!deps.settingsVault) throw notConfigured("Secret settings (OPENBAO_ADDR)");
    ciphertext = await deps.settingsVault.encrypt(input.value);
  }
  const row: AppSettingRow = {
    app_id: app.id,
    scope,
    name: input.name,
    secret: input.secret,
    value: input.secret ? null : input.value,
    ciphertext,
    write_id: deps.newId(),
    updated_at: deps.now().toISOString(),
    updated_by: caller.address,
  };
  await upsertAppSetting(deps.db, row);
  // Names only: values never reach a log.
  deps.logger.info(
    `[vetra-apps] setting ${row.name} (${scope}${row.secret ? ", secret" : ""}) of ${app.slug} set by ${caller.address}`,
  );
  return json(row);
}

export async function deleteAppSetting(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
  name: string,
  scope?: AppSettingScopeName | null,
): Promise<boolean> {
  const app = await loadAppForOwner(deps, caller, appId);
  const deleted = await deleteRow(deps.db, app.id, scopeOf(scope), name);
  if (deleted)
    deps.logger.info(
      `[vetra-apps] setting ${name} (${scopeOf(scope)}) of ${app.slug} deleted by ${caller.address}`,
    );
  return deleted;
}
```

- [ ] **Step 4: `deleteApp`.** In `service.ts` `deleteApp`, right after the `app_deployments` SUPERSEDED update, add `await deleteAppSettings(deps.db, app.id);` (import from `./settings/repo.js`). Instances already go through the reconciler once the App is DELETED (`wantsInstances` false), and their tenant secrets are purged on removal (Task 9).
- [ ] **Step 5: GraphQL schema.** In `schema.ts`, after `type AppInstance`:

```graphql
  "Where a publisher setting applies: every instance of the App, or only its branch or preview instances (wins over ALL for the same name)."
  enum AppSettingScope {
    ALL
    BRANCH
    PREVIEW
  }

  "A publisher setting (spec 14.2). Secrets are write-only: value is null for them."
  type AppSetting {
    name: String!
    scope: AppSettingScope!
    secret: Boolean!
    value: String
    updatedAt: String!
    updatedBy: String!
  }

  "A setting Vetra sets on every instance; publishers cannot set or override it."
  type VetraInstanceSetting {
    name: String!
    secret: Boolean!
    "What Vetra sets (a description where the value differs per instance)"
    value: String!
  }

  type AppSettings {
    settings: [AppSetting!]!
    vetra: [VetraInstanceSetting!]!
    "Names no setting may have"
    reservedNames: [String!]!
    "Prefixes no setting name may start with"
    reservedPrefixes: [String!]!
  }

  input SetAppSettingInput {
    appId: ID!
    "Capitals, digits and _ (e.g. SEKTAR_OAUTH_RELAY_BASE)"
    name: String!
    value: String!
    "Secret: stored encrypted, never shown again"
    secret: Boolean!
    "Default ALL"
    scope: AppSettingScope
  }
```

In `type Query`, after `appInstances`: `"The App's settings and the ones Vetra sets (operators)" appSettings(appId: ID!): AppSettings!`. In `type Mutation`, after `updateApp`:

```graphql
    "Set or replace a publisher setting; every instance of the App (or of the scope) rolls on the next pass"
    setAppSetting(input: SetAppSettingInput!): AppSetting!
    "Delete a publisher setting (default scope ALL); instances roll without it"
    deleteAppSetting(appId: ID!, name: String!, scope: AppSettingScope): Boolean!
```

- [ ] **Step 6: Resolvers.** In `resolvers.ts`, next to `appInstances` (Query) and `updateApp` (Mutation):

```ts
      appSettings: (_: unknown, { appId }: { appId: string }, ctx: AppsContext) =>
        guard(deps, "appSettings", () => appSettingsFor(deps, requireCaller(ctx), appId)),
```

```ts
      setAppSetting: (
        _: unknown,
        { input }: { input: SetAppSettingInput },
        ctx: AppsContext,
      ) => guard(deps, "setAppSetting", () => setAppSetting(deps, requireCaller(ctx), input)),
      deleteAppSetting: (
        _: unknown,
        { appId, name, scope }: { appId: string; name: string; scope?: AppSettingScopeName | null },
        ctx: AppsContext,
      ) =>
        guard(deps, "deleteAppSetting", () =>
          deleteAppSetting(deps, requireCaller(ctx), appId, name, scope),
        ),
```

(imports from `./settings/service.js`). Check that `guard` passes `GraphQLError`s through unchanged (it does for `appsError`; see `resolvers.ts` around line 98) and that it never logs the arguments. If it logs `args`, exclude `value` there.
- [ ] **Step 7: Run.** Same test command → PASS. `npx vitest run subgraphs/vetra-apps/__tests__/resolvers*.test.ts subgraphs/vetra-apps/__tests__/schema*.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail` (whichever exist) → PASS.
- [ ] **Step 8: Commit.** `git add subgraphs/vetra-apps && git commit -m "feat(settings): appSettings query, setAppSetting and deleteAppSetting" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 6: Instance render carries the settings and can create without starting

**Files:**
- Modify: `subgraphs/vetra-apps/instances/render.ts`
- Test: `subgraphs/vetra-apps/__tests__/instances-render.test.ts`

**Interfaces:**
- Consumes: `SETTINGS_REVISION_ENV`, `VETRA_GENERATED_SECRETS` (Task 3), `WORKFLOWS_MASTER_KEY`.
- Produces:
  - `InstanceSettingsEnv { revision: string; plain: {name; value}[]; secretNames: string[] }`.
  - `envSettings(s: InstanceSettings): InstanceSettingsEnv`.
  - `fusionEnv(image, admins, settings: InstanceSettingsEnv): FusionEnvEntry[]`.
  - `CreateInstanceInput` gains `settings: InstanceSettingsEnv` and `start: boolean`.
  - `instanceUpdateActions(state, image, admins, settings: InstanceSettingsEnv, start = true)`.
  - `declaresVetraSecrets(state): boolean`, `declaredSecretNames(state): string[]`, `settingsRevisionOf(state): string | null`.

- [ ] **Step 1: Write the failing tests** (in `instances-render.test.ts`). Add `settings: S, start: true` to both existing `instanceCreateActions` inputs, and pass `S` as the 4th argument of every existing `instanceUpdateActions` call:

```ts
import type { InstanceSettingsEnv } from "../instances/render.js";
import { declaredSecretNames, declaresVetraSecrets, settingsRevisionOf } from "../instances/render.js";

const S: InstanceSettingsEnv = {
  revision: "0123456789abcdef",
  plain: [{ name: "RELAY", value: "https://relay" }],
  secretNames: ["API_TOKEN"],
};

describe("settings in the FUSION env", () => {
  it("declares Vetra's generated secrets and the publisher's, plain settings and the revision", async () => {
    const envs = new FakeEnvs();
    const id = await created(envs);
    const env = (await envs.getState(id))!.fusion!.env;
    expect(env).toEqual([
      { name: "PH_HOST", value: "cli", isSecret: false },
      { name: "ADMINS", value: OWNER, isSecret: false },
      { name: "RELAY", value: "https://relay", isSecret: false },
      { name: "VETRA_SETTINGS_REVISION", value: S.revision, isSecret: false },
      { name: "PH_WORKFLOWS_SECRETS_MASTER_KEY", value: null, isSecret: true },
      { name: "PH_ATTACHMENT_URL_SIGNING_SECRET", value: null, isSecret: true },
      { name: "API_TOKEN", value: null, isSecret: true },
    ]);
    const state = (await envs.getState(id))!;
    expect(declaresVetraSecrets(state)).toBe(true);
    expect(declaredSecretNames(state)).toEqual([
      "PH_WORKFLOWS_SECRETS_MASTER_KEY",
      "PH_ATTACHMENT_URL_SIGNING_SECRET",
      "API_TOKEN",
    ]);
    expect(settingsRevisionOf(state)).toBe(S.revision);
  });

  it("a new revision changes only the env, not the version", async () => {
    const envs = new FakeEnvs();
    const id = await created(envs);
    const state = (await envs.getState(id))!;
    const next = { ...S, revision: "fedcba9876543210", secretNames: [] };
    const types = instanceUpdateActions(state, image(), OWNER, next).map((a) => a.type);
    expect(types).toEqual(["SET_FUSION_CONFIG"]);
  });

  it("creates without a version when not started, and starts later", async () => {
    const envs = new FakeEnvs();
    const id = await envs.create();
    await envs.execute(id, [
      ...instanceCreateActions({
        label: "Shop · main",
        host: "shop-main",
        baseDomain: "vetra.io",
        registry: "https://registry.dev.vetra.io",
        owner: OWNER,
        ownerOrgId: null,
        appId: "app-1",
        gitRef: "refs/heads/main",
        imageProject: "acme",
        image: image(),
        admins: OWNER,
        settings: S,
        start: false,
      }),
      approveChanges({}),
    ]);
    const state = (await envs.getState(id))!;
    expect(state.services.find((s) => s.type === "FUSION")!.version ?? null).toBeNull();
    expect(instanceUpdateActions(state, image(), OWNER, S, false)).toEqual([]);
    expect(
      instanceUpdateActions(state, image(), OWNER, S, true).map((a) => a.type),
    ).toEqual(["SET_SERVICE_VERSION"]);
  });

  it("an instance from before slice 4 declares no Vetra secrets", () => {
    const legacy = {
      fusion: { env: [{ name: "PH_HOST", value: "cli", isSecret: false }] },
    } as never;
    expect(declaresVetraSecrets(legacy)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/instances-render.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL (type errors / missing exports).
- [ ] **Step 3: Implement** in `render.ts`:

```ts
import { WORKFLOWS_MASTER_KEY } from "../../vetra-cloud-secrets/services/secrets-service.js";
import { SETTINGS_REVISION_ENV, VETRA_GENERATED_SECRETS } from "../settings/names.js";
import type { InstanceSettings } from "../settings/resolve.js";

/** What an instance's environment document carries of its settings (secret values never). */
export interface InstanceSettingsEnv {
  revision: string;
  plain: Array<{ name: string; value: string }>;
  secretNames: string[];
}

export const envSettings = (s: InstanceSettings): InstanceSettingsEnv => ({
  revision: s.revision,
  plain: s.plain,
  secretNames: s.secrets.map((x) => x.name),
});

/**
 * The FUSION env of an instance (spec section 5 + 14.2). Plain entries render
 * inline; secret entries are names the processor turns into secretEnv refs to
 * <tenant>-secrets, whose values the reconciler delivered (settings/deliver.ts).
 * Order is fixed: sameEnv compares it.
 */
export function fusionEnv(
  image: InstanceImage,
  admins: string,
  settings: InstanceSettingsEnv,
): FusionEnvEntry[] {
  return [
    { name: "PH_HOST", value: image.phHost, isSecret: false },
    { name: "ADMINS", value: admins, isSecret: false },
    ...settings.plain.map((p) => ({ name: p.name, value: p.value, isSecret: false })),
    { name: SETTINGS_REVISION_ENV, value: settings.revision, isSecret: false },
    ...[...VETRA_GENERATED_SECRETS, ...settings.secretNames].map((name) => ({
      name,
      value: null,
      isSecret: true,
    })),
  ];
}

/** Created by this slice or later: its database never saw a self-generated master key. */
export const declaresVetraSecrets = (state: VetraCloudEnvironmentState) =>
  (state.fusion?.env ?? []).some(
    (e) => e.name === WORKFLOWS_MASTER_KEY && e.isSecret === true,
  );

/** Secret names the environment declares (Vetra's and the publisher's). */
export const declaredSecretNames = (state: VetraCloudEnvironmentState) =>
  (state.fusion?.env ?? []).filter((e) => e.isSecret === true).map((e) => e.name);

/** The settings revision the environment asks for (what its pods should run). */
export const settingsRevisionOf = (state: VetraCloudEnvironmentState) =>
  (state.fusion?.env ?? []).find((e) => e.name === SETTINGS_REVISION_ENV && !e.isSecret)
    ?.value ?? null;
```

`CreateInstanceInput`: add

```ts
  settings: InstanceSettingsEnv;
  /** Set the FUSION version (the host starts). False: the reconciler starts it once the tenant's secrets are in place. */
  start: boolean;
```

In `instanceCreateActions`, use `env: fusionEnv(i.image, i.admins, i.settings)` and replace the last action with `...(i.start ? [setServiceVersion({ type: "FUSION", version: i.image.tag })] : [])`.

`instanceUpdateActions`: new signature `(state, image, admins: string, settings: InstanceSettingsEnv, start = true)`. Use `const env = fusionEnv(image, admins, settings);` and replace the version push with:

```ts
  // Not started yet (no version) and not allowed to start: env and image only.
  if (fusion?.version !== image.tag && (start || !!fusion?.version))
    changes.push(setServiceVersion({ type: "FUSION", version: image.tag }));
```

- [ ] **Step 4: Run it.** Same command → PASS. `npx tsc --noEmit -p . 2>&1 | grep reconciler.ts | head`. The reconciler's calls now fail to compile. Leave them for Task 9, but make the suite compile meanwhile: in `reconciler.ts` pass `EMPTY_SETTINGS_ENV` (temporary, removed in Task 9: `const EMPTY_SETTINGS_ENV = envSettings(settingsForKind([], "branch"));`) and `start: true` to every call. Run `npx vitest run subgraphs/vetra-apps/__tests__/instances-*.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Tests that assert the exact `fusion.env` (e.g. `[PH_HOST, ADMINS]`) now see the new entries. Update those expectations to `fusionEnv(…)` output with `EMPTY_SETTINGS_ENV`-equivalent values (import `envSettings`/`settingsForKind` in the test).
- [ ] **Step 5: Commit.** `git add subgraphs/vetra-apps && git commit -m "feat(instances): the FUSION env carries settings, Vetra secrets and the revision" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 7: Observability records each pod's settings revision

**Files:**
- Modify: `subgraphs/vetra-cloud-observability/db/schema.ts` (`EnvironmentPods.settingsRevision`)
- Modify: `subgraphs/vetra-cloud-observability/db/migrations.ts` (add to the slice 3 column loop, ~line 101)
- Modify: `subgraphs/vetra-cloud-observability/pod-sync.ts` (`PodLike.spec.containers[].env`, `podToRow`, `upsertPod`)
- Test: `subgraphs/vetra-cloud-observability/__tests__/watchers.test.ts`

**Interfaces:**
- Produces: `environment_pods.settingsRevision` (varchar(32), nullable) = the value of the env var `VETRA_SETTINGS_REVISION` on the pod's first container spec. Null when absent or not a literal value.

- [ ] **Step 1: Write the failing test** (append to the `podToRow — image and waiting reason` describe, reusing its `pod()` helper):

```ts
  it("records the settings revision the first container is started with", () => {
    const p = pod();
    p.spec!.containers![0].env = [
      { name: "PH_HOST", value: "cli" },
      { name: "VETRA_SETTINGS_REVISION", value: "0123456789abcdef" },
    ];
    expect(podToRow(p, "2026-11-12T00:00:00.000Z")).toMatchObject({
      settingsRevision: "0123456789abcdef",
    });
    expect(podToRow(pod(), "2026-11-12T00:00:00.000Z")).toMatchObject({
      settingsRevision: null,
    });
  });
```

- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-cloud-observability/__tests__/watchers.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `schema.ts` `EnvironmentPods`, after `waitingReason`: `/** VETRA_SETTINGS_REVISION of the first container's env (vetra-apps instances, slice 4); null when absent. */ settingsRevision?: string | null;`
  - `migrations.ts`: add `["settingsRevision", "varchar(32)"],` to the `image`/`imageId`/`waitingReason` loop.
  - `pod-sync.ts`: `spec?: { containers?: Array<{ name?: string; image?: string; env?: Array<{ name?: string; value?: string }> }> };`. In `podToRow`, before `return`:

```ts
  // The instance settings revision (vetra-apps settings/names.ts SETTINGS_REVISION_ENV; a literal here to keep observability standalone).
  const settingsRevision =
    main?.env?.find((e) => e.name === "VETRA_SETTINGS_REVISION")?.value ?? null;
```

  Add `settingsRevision,` to the returned row, and `settingsRevision: row.settingsRevision ?? null,` to `upsertPod`'s `doUpdateSet`.
- [ ] **Step 4: Run it.** Same command → PASS. Also `npx vitest run subgraphs/vetra-cloud-observability 2>&1 | grep -E "FAIL|Tests|failed" | tail`.
- [ ] **Step 5: Commit.** `git add subgraphs/vetra-cloud-observability && git commit -m "feat(observability): record each pod's settings revision" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 8: Health follows the settings revision

**Files:**
- Modify: `subgraphs/vetra-apps/instances/health.ts` (`PodSnapshot`, `judgedPods`, new `observedSettings`)
- Modify: `subgraphs/vetra-apps/instances/cluster.ts` (select `settingsRevision`)
- Modify: `subgraphs/vetra-apps/instances/repo.ts` (`HealthRecord`)
- Modify: `subgraphs/vetra-apps/instances/monitor.ts` (`checkInstance`, `sinceOf`)
- Modify: `subgraphs/vetra-apps/instances/status.ts` (`HealthView`, `healthView`, `observeHealth`)
- Test: `instances-health-verdict.test.ts`, `instances-status.test.ts`, `instances-health.test.ts`

**Interfaces:**
- Produces:
  - `PodSnapshot.settingsRevision?: string | null`.
  - `judgedPods(pods, wanted, wantedSettings: string | null = null)`.
  - `observedSettings(hostPods, wantedSettings): string | null`.
  - `HealthRecord.health_settings`, `.observed_settings`.
  - `HealthView.settings`, `.observedSettings`.
  - `observeHealth(state, target: { tag; digest; settings?: string | null }, row: { update_started_at; running_digest; running_settings?: string | null; status? }, …)`.
- Rule: with a target revision, an update is **in flight** while `running_digest ≠ target digest` **or** `running_settings ≠ target revision`. Checks count only when they judged the target revision. `ready` needs `observed_settings` = target revision as well as the digest.

- [ ] **Step 1: Failing verdict tests** (`instances-health-verdict.test.ts`; use the file's pod helper, adding `settingsRevision`):

```ts
describe("settings revision", () => {
  const p = (rev: string | null, ready = true) => ({
    phase: "RUNNING",
    ready,
    restartCount: 0,
    image: `cr.vetra.io/acme/shop:1.0.0@${D1}`,
    imageId: `cr.vetra.io/acme/shop@${D1}`,
    waitingReason: null,
    settingsRevision: rev,
  });

  it("judges only pods on the wanted digest and revision", () => {
    expect(judgedPods([p("r1"), p("r2")], D1, "r2")).toEqual([p("r2")]);
    expect(judgedPods([p("r1")], D1, null)).toEqual([p("r1")]);
  });

  it("observes the wanted revision when a ready pod runs it, else what a ready pod runs", () => {
    expect(observedSettings([p("r1"), p("r2")], "r2")).toBe("r2");
    expect(observedSettings([p("r1"), p("r2", false)], "r2")).toBe("r1");
    expect(observedSettings([p("r1", false)], "r1")).toBeNull();
  });
});
```

(`D1` as defined in that file; import `observedSettings`.)

- [ ] **Step 2: Failing status tests** (`instances-status.test.ts`; reuse its `state(…)`, `view(…)` and time helpers, and add `settings`/`observedSettings` to the view helper's defaults as `null`):

```ts
describe("observeHealth — settings revision", () => {
  const target = { tag: TAG, digest: D1, settings: "r2" };

  it("a new revision on the running digest is an update in flight, not ready on the old pod's health", () => {
    const row = { update_started_at: T0, running_digest: D1, running_settings: "r1", status: "updating" };
    const oldPodHealthy = view({
      health: "healthy",
      digest: D1,
      observedDigest: D1,
      settings: "r1",
      observedSettings: "r1",
      since: T0,
      checkedAt: plus(T0, HEALTH_STABLE_MS + 1000),
    });
    expect(observeHealth(stateOn(TAG), target, row, oldPodHealthy, at(plus(T0, HEALTH_STABLE_MS + 2000)), WINDOW).kind).toBe("updating");
  });

  it("is ready once the target revision runs healthy", () => {
    const row = { update_started_at: T0, running_digest: D1, running_settings: "r1", status: "updating" };
    const h = view({
      health: "healthy",
      digest: D1,
      observedDigest: D1,
      settings: "r2",
      observedSettings: "r2",
      since: plus(T0, 1000),
      checkedAt: plus(T0, HEALTH_STABLE_MS + 2000),
    });
    expect(observeHealth(stateOn(TAG), target, row, h, at(plus(T0, HEALTH_STABLE_MS + 3000)), WINDOW).kind).toBe("ready");
  });

  it("fails a settings update that stays unhealthy past the window", () => {
    const row = { update_started_at: T0, running_digest: D1, running_settings: "r1", status: "updating" };
    const h = view({
      health: "unhealthy",
      check: "crash",
      reason: "the container does not start (CrashLoopBackOff)",
      digest: D1,
      settings: "r2",
      since: plus(T0, 1000),
      checkedAt: plus(T0, WINDOW + CONFIRM_MS + 2000),
    });
    expect(observeHealth(stateOn(TAG), target, row, h, at(plus(T0, WINDOW + CONFIRM_MS + 3000)), WINDOW)).toMatchObject({ kind: "failed" });
  });
});
```

(`TAG`, `D1`, `T0`, `plus`, `at`, `stateOn`, `view`, `WINDOW` are the helpers the slice 3 tests in this file use. If any is named differently, use that name; the assertions are what matters.)

- [ ] **Step 3: Run both.** `npx vitest run subgraphs/vetra-apps/__tests__/instances-health-verdict.test.ts subgraphs/vetra-apps/__tests__/instances-status.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL.
- [ ] **Step 4: Implement `health.ts`.**
  - `PodSnapshot`: `/** VETRA_SETTINGS_REVISION the pod was started with (null: none or not recorded). */ settingsRevision?: string | null;`
  - `judgedPods`:

```ts
export function judgedPods(
  pods: PodSnapshot[],
  wanted: string | null,
  wantedSettings: string | null = null,
): PodSnapshot[] {
  if (!wanted) return [];
  return pods.filter(
    (p) =>
      !DEAD_PHASES.has(p.phase) &&
      digestOf(p.image) === wanted &&
      (wantedSettings === null || (p.settingsRevision ?? null) === wantedSettings),
  );
}
```

  - New:

```ts
/** The settings revision a ready host pod runs: the wanted one when a ready pod has it. */
export function observedSettings(
  hostPods: PodSnapshot[],
  wantedSettings: string | null,
): string | null {
  const revs = hostPods
    .filter((p) => p.ready && p.phase === "RUNNING")
    .map((p) => p.settingsRevision ?? null)
    .filter((r): r is string => !!r);
  if (revs.length === 0) return null;
  return wantedSettings && revs.includes(wantedSettings) ? wantedSettings : revs[0];
}
```

- [ ] **Step 5: `cluster.ts`.** Add `"settingsRevision"` to the pod `select`, and `settingsRevision: p.settingsRevision ?? null,` to the mapped snapshot.
- [ ] **Step 6: `repo.ts`.** `HealthRecord` gets `health_settings: string | null;` and `observed_settings: string | null;`.
- [ ] **Step 7: `monitor.ts` `checkInstance`.** After `const wanted = digestOf(version);` add `const wantedSettings = settingsRevisionOf(state);` (import from `./render.js`). Declare `let seenSettings: string | null = null;` next to `observed`. In the cluster branch:

```ts
      const judged = judgedPods(cluster.hostPods, wanted, wantedSettings);
      restarts = judged.reduce((n, p) => n + p.restartCount, 0);
      observed = observedDigest(cluster.hostPods, wanted, version);
      seenSettings = observedSettings(cluster.hostPods, wantedSettings);
      const previous =
        row.health_digest === wanted && (row.health_settings ?? null) === wantedSettings
          ? row.health_restarts
          : null;
```

`recordHealth` gets `health_settings: wantedSettings, observed_settings: seenSettings`. `sinceOf(row, verdict, digest, settings, at)` treats `(row.health_settings ?? null) !== settings` as a change, like the digest; pass `wantedSettings` at the `recordHealth` call and `row.health_settings` in `stamp`.
- [ ] **Step 8: `status.ts`.**
  - `HealthView` gets `settings: string | null; observedSettings: string | null;`. `healthView` maps `r.health_settings ?? null` and `r.observed_settings ?? null` (add both to its parameter type).
  - In `observeHealth`: `target: { tag: string; digest: string; settings?: string | null }`, `row` gets `running_settings?: string | null`. Replace the in-flight and freshness lines:

```ts
  const wantSettings = target.settings ?? null;
  const settingsMoved =
    wantSettings !== null && (row.running_settings ?? null) !== wantSettings;
  const inFlight = row.running_digest !== target.digest || settingsMoved;
  …
  const fresh =
    h.health !== null &&
    onTarget &&
    h.digest === target.digest &&
    (wantSettings === null || h.settings === wantSettings) &&
    t - checked <= HEALTH_STALE_MS &&
    (!inFlight || !Number.isFinite(started) || checked > started);
```

  and the ready rule:

```ts
    if (
      h.health === "healthy" &&
      h.observedDigest === target.digest &&
      (wantSettings === null || h.observedSettings === wantSettings) &&
      forMs >= HEALTH_STABLE_MS
    )
      return { kind: "ready" };
```

- [ ] **Step 9: Monitor test** (`instances-health.test.ts`; reuse its setup that seeds an instance, a tenant and pod rows). Add one test: seed the instance environment's FUSION env with `VETRA_SETTINGS_REVISION = "r2"` (via `instanceUpdateActions` with `{ revision: "r2", plain: [], secretNames: [] }`), insert one ready pod row with `settingsRevision: "r1"` and one with `"r2"`. After `monitorInstancesOnce`, the row has `health_settings: "r2"` and `observed_settings: "r2"`. With only the `"r1"` pod, the verdict is `unknown` / check `pod` ("no pod runs the target image yet") and `observed_settings: "r1"`.
- [ ] **Step 10: Run.** `npx vitest run subgraphs/vetra-apps/__tests__/instances-health-verdict.test.ts subgraphs/vetra-apps/__tests__/instances-status.test.ts subgraphs/vetra-apps/__tests__/instances-health.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20` → PASS.
- [ ] **Step 11: Commit.** `git add subgraphs/vetra-apps && git commit -m "feat(instances): health judges the settings revision with the digest" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 9: The reconciler delivers settings, gates the first start and rolls changes

**Files:**
- Create: `subgraphs/vetra-apps/settings/deliver.ts`
- Modify: `subgraphs/vetra-apps/instances/reconciler.ts`
- Modify: `subgraphs/vetra-apps/instances/repo.ts` (`getInstance`)
- Modify: `subgraphs/vetra-apps/instances/service.ts`, `subgraphs/vetra-apps/schema.ts` (`AppInstance.settingsRevision`, `runningSettingsRevision`)
- Test: `subgraphs/vetra-apps/__tests__/instances-settings.test.ts` (new); adjust `instances-reconciler.test.ts`, `instances-previews.test.ts` if they count executed batches

**Interfaces:**
- Consumes: Tasks 1-8 (`settingsForKind`, `envSettings`, `fusionEnv` family, `declaresVetraSecrets`, `declaredSecretNames`, `deps.instanceSecrets`, `deps.settingsVault`, `deps.tenantLive`, settings columns, health settings).
- Produces:
  - `deliverSettings(deps, tenantId, settings: InstanceSettings, declared: string[]): Promise<void>`.
  - `reconcileInstance(deps, app, row, settings: InstanceSettings)`.
  - Constants `SECRETS_SETTLE_MS = 30_000`, `RECREATING_FOR_SETTINGS`, `WAITING_FOR_NAMESPACE`, `WAITING_FOR_SECRETS`, `AFTER_SETTINGS_CHANGE = "after a settings change"`.
  - `getInstance(db, id): Promise<InstanceRow | null>`.
  - `AppInstance.settingsRevision`, `AppInstance.runningSettingsRevision`.

- [ ] **Step 1: Write the failing tests** `subgraphs/vetra-apps/__tests__/instances-settings.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHarness, owner, seedActiveApp, testConfig, type Harness } from "./harness.js";
import { digest, seedRelease } from "./instances-fixtures.js";
import { getTenantId } from "../../../processors/vetra-cloud-environment/gitops.js";
import { listInstances } from "../instances/repo.js";
import {
  reconcileInstancesOnce,
  RECREATING_FOR_SETTINGS,
  SECRETS_SETTLE_MS,
  WAITING_FOR_NAMESPACE,
  WAITING_FOR_SECRETS,
} from "../instances/reconciler.js";
import { setAppSetting, deleteAppSetting } from "../settings/service.js";
import {
  approveChanges,
  setFusionConfig,
} from "../../../document-models/vetra-cloud-environment/v1/gen/creators.js";

let h: Harness;
let appId: string;

beforeEach(async () => {
  h = await makeHarness();
  appId = (await seedActiveApp(h)).id;
  await h.db
    .updateTable("apps")
    .set({ instances_enabled: true, registry_namespace: "acme" })
    .where("id", "=", appId)
    .execute();
  await seedRelease(h, appId, { version: "1.5.0-main.1", run: 100 });
});
afterEach(async () => {
  await h.close();
});

const one = async () => (await listInstances(h.db, appId))[0];
const env = async () => (await h.envs.getState((await one()).environment_id!))!;
const version = async () =>
  (await env()).services.find((s) => s.type === "FUSION")!.version ?? null;
const tenant = async () => {
  const r = await one();
  return getTenantId(r.host!, r.environment_id!);
};
const envValue = async (name: string) =>
  (await env()).fusion!.env.find((e) => e.name === name);
const set = (name: string, value: string, secret = false, scope?: "ALL" | "BRANCH" | "PREVIEW") =>
  setAppSetting(h.deps, owner, { appId, name, value, secret, scope });

describe("instance settings", () => {
  it("gives a new instance Vetra's generated secrets and the publisher's before it starts", async () => {
    await set("RELAY", "https://relay");
    await set("API_TOKEN", "s3cret", true);
    await reconcileInstancesOnce(h.deps);
    const t = await tenant();
    const store = h.secrets.store.get(t)!;
    expect(store.get("PH_WORKFLOWS_SECRETS_MASTER_KEY")).toMatch(/^[0-9a-f]{64}$/);
    expect(store.get("PH_ATTACHMENT_URL_SIGNING_SECRET")).toMatch(/^[0-9a-f]{64}$/);
    expect(store.get("API_TOKEN")).toBe("s3cret");
    expect(h.secrets.notified).toContain(t);
    expect(await envValue("RELAY")).toMatchObject({ value: "https://relay", isSecret: false });
    expect(await envValue("API_TOKEN")).toMatchObject({ value: null, isSecret: true });
    expect(JSON.stringify(await env())).not.toContain("s3cret");
    expect(await version()).toBe(`1.5.0-main.1@${digest("a")}`);
    const row = await one();
    expect(row.settings_delivered).toBe(row.target_settings);
  });

  it("never replaces the generated master key", async () => {
    await reconcileInstancesOnce(h.deps);
    const t = await tenant();
    const key = h.secrets.store.get(t)!.get("PH_WORKFLOWS_SECRETS_MASTER_KEY");
    await set("FOO", "1");
    await reconcileInstancesOnce(h.deps);
    expect(h.secrets.store.get(t)!.get("PH_WORKFLOWS_SECRETS_MASTER_KEY")).toBe(key);
  });

  it("waits for the namespace, delivers, waits for the secrets to land, then starts", async () => {
    let live = false;
    h.deps.tenantLive = async () => live;
    await reconcileInstancesOnce(h.deps);
    expect(await version()).toBeNull();
    await reconcileInstancesOnce(h.deps);
    expect(await one()).toMatchObject({ status: "updating", reason: WAITING_FOR_NAMESPACE });
    expect(h.secrets.store.get(await tenant())).toBeUndefined();

    live = true;
    await reconcileInstancesOnce(h.deps);
    expect(h.secrets.store.get(await tenant())!.has("PH_WORKFLOWS_SECRETS_MASTER_KEY")).toBe(true);
    expect(await version()).toBeNull();
    expect((await one()).reason).toBe(WAITING_FOR_SECRETS);

    h.advance(SECRETS_SETTLE_MS);
    await reconcileInstancesOnce(h.deps);
    expect(await version()).toBe(`1.5.0-main.1@${digest("a")}`);
  });

  it("rolls a settings change: new revision, secrets delivered, status updating; ready on the new revision", async () => {
    await reconcileInstancesOnce(h.deps);
    const envId = (await one()).environment_id!;
    h.envs.setStatus(envId, "READY");
    await reconcileInstancesOnce(h.deps);
    const before = await one();
    expect(before).toMatchObject({ status: "ready", running_settings: before.target_settings });

    await set("API_TOKEN", "v2", true);
    await reconcileInstancesOnce(h.deps);
    const after = await one();
    expect(after.target_settings).not.toBe(before.target_settings);
    expect(after.status).toBe("updating");
    expect(h.secrets.store.get(await tenant())!.get("API_TOKEN")).toBe("v2");
    expect((await envValue("VETRA_SETTINGS_REVISION"))!.value).toBe(after.target_settings);

    h.envs.setStatus(envId, "READY");
    await reconcileInstancesOnce(h.deps);
    expect(await one()).toMatchObject({ status: "ready", running_settings: after.target_settings });
  });

  it("removes a deleted secret from the tenant and the environment", async () => {
    await set("API_TOKEN", "x", true);
    await reconcileInstancesOnce(h.deps);
    await deleteAppSetting(h.deps, owner, appId, "API_TOKEN");
    await reconcileInstancesOnce(h.deps);
    expect(h.secrets.store.get(await tenant())!.has("API_TOKEN")).toBe(false);
    expect(await envValue("API_TOKEN")).toBeUndefined();
    expect(h.secrets.store.get(await tenant())!.has("PH_WORKFLOWS_SECRETS_MASTER_KEY")).toBe(true);
  });

  it("applies a scope to its kind only", async () => {
    await set("ONLY_PREVIEWS", "1", false, "PREVIEW");
    await reconcileInstancesOnce(h.deps);
    expect(await envValue("ONLY_PREVIEWS")).toBeUndefined();
  });

  it("recreates an instance made before Vetra's secrets (once)", async () => {
    await reconcileInstancesOnce(h.deps);
    const old = (await one()).environment_id!;
    // Strip the generated secrets, as an environment from slices 1-3 has them.
    const state = (await h.envs.getState(old))!;
    await h.envs.execute(old, [
      setFusionConfig({
        image: state.fusion!.image,
        env: [
          { name: "PH_HOST", value: "cli", isSecret: false },
          { name: "ADMINS", value: state.owner!, isSecret: false },
        ],
        autoUpdate: false,
        autoUpdateTagPattern: null,
      }),
      approveChanges({}),
    ]);
    await reconcileInstancesOnce(h.deps);
    expect(h.envs.deleted).toContain(old);
    expect((await one()).reason).toBe(RECREATING_FOR_SETTINGS);
    await reconcileInstancesOnce(h.deps); // gone → start over
    await reconcileInstancesOnce(h.deps); // created again
    const row = await one();
    expect(row.environment_id).not.toBe(old);
    expect(h.secrets.purged).toContain(getTenantId(row.host!, old));
    expect((await envValue("PH_WORKFLOWS_SECRETS_MASTER_KEY"))!.isSecret).toBe(true);
  });

  it("a failed settings-only update is not reverted or retried until the settings change", async () => {
    h.deps.cfg = testConfig({
      instances: {
        enabled: true,
        labelSuffix: "",
        health: { mode: "report", unhealthyWindowMs: 300_000, probesPerPass: 10, probesPerApp: 3 },
      },
    });
    await reconcileInstancesOnce(h.deps);
    const envId = (await one()).environment_id!;
    h.envs.setStatus(envId, "READY");
    await reconcileInstancesOnce(h.deps);
    await set("BROKEN", "1");
    await reconcileInstancesOnce(h.deps);
    // The rolled pod never comes back: report mode fails it on the document after the 20-minute timeout.
    h.envs.setStatus(envId, "DEPLOYMENt_FAILED");
    h.advance(21 * 60_000);
    await reconcileInstancesOnce(h.deps);
    const failed = await one();
    expect(failed.status).toBe("failed");
    expect(failed.failed_digest).toBe(failed.target_digest);
    expect(failed.failed_settings).toBe(failed.target_settings);
    expect(await version()).toBe(`1.5.0-main.1@${digest("a")}`); // nothing to revert to
    const ops = h.envs.executed.length;
    await reconcileInstancesOnce(h.deps);
    expect(h.envs.executed.length).toBe(ops); // not retried
    await deleteAppSetting(h.deps, owner, appId, "BROKEN");
    await reconcileInstancesOnce(h.deps);
    expect((await one()).status).toBe("updating"); // a new revision is tried
  });

  it("purges the tenant's secrets when the instance goes", async () => {
    await reconcileInstancesOnce(h.deps);
    const t = await tenant();
    await h.db.updateTable("apps").set({ instances_enabled: false }).where("id", "=", appId).execute();
    await reconcileInstancesOnce(h.deps);
    await reconcileInstancesOnce(h.deps);
    expect(h.secrets.purged).toContain(t);
  });

  it("fails the instance (not the pass) without a tenant secrets store", async () => {
    h.deps.instanceSecrets = null;
    await reconcileInstancesOnce(h.deps);
    expect(await one()).toMatchObject({ status: "failed" });
    expect((await one()).reason).toMatch(/not configured/);
  });
});
```

(The report-mode failure test relies on `observeEnvironment` failing a rollout whose document is `DEPLOYMENt_FAILED` on the target tag; `runsTarget` is false because `running_settings` ≠ target. If `testConfig` already defaults to report mode, drop the `h.deps.cfg = …` line.)

- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/instances-settings.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL.
- [ ] **Step 3: `settings/deliver.ts`.**

```ts
import { randomBytes } from "node:crypto";
import { notConfigured } from "../errors.js";
import type { AppsDeps } from "../service.js";
import { VETRA_GENERATED_SECRETS } from "./names.js";
import type { InstanceSettings } from "./resolve.js";

/**
 * Writes an instance's secrets to its tenant (spec 5 and 14.2): Vetra's
 * generated keys once (never replaced), the publisher's secrets in one batch,
 * secrets the environment declared but no longer wants deleted, then a notify
 * so the controller materializes <tenant>-secrets now (its namespace may only
 * now exist). Values exist in plaintext only in this call.
 */
export async function deliverSettings(
  deps: AppsDeps,
  tenantId: string,
  settings: InstanceSettings,
  declared: string[],
): Promise<void> {
  const secrets = deps.instanceSecrets;
  if (!secrets) throw notConfigured("The tenant secrets store (OPENBAO_ADDR)");
  for (const key of VETRA_GENERATED_SECRETS)
    await secrets.ensureSecret(tenantId, key, () => randomBytes(32).toString("hex"));
  if (settings.secrets.length > 0) {
    const vault = deps.settingsVault;
    if (!vault) throw notConfigured("Secret settings (OPENBAO_ADDR)");
    const entries = await Promise.all(
      settings.secrets.map(async (s) => ({
        key: s.name,
        value: await vault.decrypt(s.ciphertext),
      })),
    );
    await secrets.setSecrets(tenantId, entries);
  }
  const wanted = new Set([
    ...VETRA_GENERATED_SECRETS,
    ...settings.secrets.map((s) => s.name),
  ]);
  for (const name of declared)
    if (!wanted.has(name)) await secrets.deleteSecret(tenantId, name);
  await secrets.notifyTenant(tenantId);
}
```

- [ ] **Step 4: `repo.ts`.**

```ts
export async function getInstance(
  db: Kysely<VetraAppsDB>,
  id: string,
): Promise<InstanceRow | null> {
  const r = await db.selectFrom("instances").selectAll().where("id", "=", id).executeTakeFirst();
  return r ? normalize(r) : null;
}
```

- [ ] **Step 5: Reconciler.** In `reconciler.ts` (remove Task 6's temporary `EMPTY_SETTINGS_ENV`):

  a. Imports: `getTenantId` from `../../../processors/vetra-cloud-environment/gitops.js`; `listAppSettings` from `../settings/repo.js`; `settingsForKind, type InstanceSettings` from `../settings/resolve.js`; `deliverSettings` from `../settings/deliver.js`; `envSettings, declaresVetraSecrets, declaredSecretNames` from `./render.js`; `getInstance` from `./repo.js`.

  b. Constants:

```ts
/** After the secrets were delivered to a fresh tenant, how long its first start waits (controller: ~1 s on notify). */
export const SECRETS_SETTLE_MS = 30_000;
export const RECREATING_FOR_SETTINGS =
  "recreating the environment with Vetra's settings (it predates the secrets master key)";
export const WAITING_FOR_NAMESPACE =
  "waiting for the environment's namespace to give it its secrets";
export const WAITING_FOR_SECRETS = "waiting for the environment's secrets to arrive";
export const AFTER_SETTINGS_CHANGE = "after a settings change";
```

  c. `CLEAN` gets `running_settings: null, failed_settings: null, settings_delivered: null, settings_delivered_at: null, health_settings: null, observed_settings: null`.

  d. Helpers:

```ts
/** A failed target is not retried until its digest or its settings revision changes. */
const failedOn = (row: InstanceRow, settings: InstanceSettings) =>
  row.failed_digest === row.target_digest &&
  (row.failed_settings ?? null) === settings.revision;

const failure = (row: InstanceRow, settings: InstanceSettings): InstancePatch => ({
  failed_digest: row.target_digest,
  failed_settings: settings.revision,
});

async function waitFor(deps: AppsDeps, row: InstanceRow, reason: string): Promise<void> {
  if (row.status !== "updating" || row.reason !== reason)
    await patch(deps, row, { status: "updating", reason });
}

/** The environment is gone or going for good: its tenant's secrets go too (the master key is kept by the purge). */
async function forgetTenant(deps: AppsDeps, row: InstanceRow): Promise<void> {
  if (!row.host || !row.environment_id || !deps.instanceSecrets) return;
  await deps.instanceSecrets.purgeTenant(getTenantId(row.host, row.environment_id));
}
```

  e. `reconcileApp`: read the settings once per pass:

```ts
  const settingRows = await listAppSettings(deps.db, app.id);
  …
      await reconcileInstance(deps, app, row, settingsForKind(settingRows, row.kind));
```

  f. `reconcileInstance(deps, app, row, settings: InstanceSettings)`:

```ts
  if (row.removed_at) … (unchanged)
  if (!row.target_digest) return;
  if (row.target_settings !== settings.revision) {
    await patch(deps, row, { target_settings: settings.revision });
    row = { ...row, target_settings: settings.revision };
  }
  if (!row.environment_id) {
    if (row.status === "failed" && failedOn(row, settings)) return;
    return createEnvironment(deps, app, row, settings);
  }
  const envId = row.environment_id;
  return withEnvLock(envId, () => reconcileEnvironment(deps, app, row, envId, settings));
```

  g. `createEnvironment(deps, app, row, settings)`: first line `if (!deps.instanceSecrets) throw notConfigured("The tenant secrets store (OPENBAO_ADDR)");`. In `claimHost`, the `fail` patch spreads `failure(row, settings)` instead of `failed_digest` (pass `settings` through). `initEnvironment(deps, app, row, host, image, envId, settings)`. In its `instanceCreateActions` input add `settings: envSettings(settings), start: false`. In its catch, the patch spreads `failure(row, settings)`. After the `try/catch` (create succeeded), still under the env lock:

```ts
  // Without namespace knowledge (no tenantLive) nothing to wait for: deliver and start in this pass.
  if (!deps.tenantLive) {
    const fresh = await getInstance(deps.db, row.id);
    if (fresh?.environment_id === envId)
      await reconcileEnvironment(deps, app, fresh, envId, settings);
  }
```

  (Return early from the catch so this only runs after a successful create.)

  h. `reconcileEnvironment(deps, app, row, envId, settings)`. In the "start over" branch (`!state || DRAFT || DESTROYED`), call `await forgetTenant(deps, row);` before the `CLEAN` patch. After the `CHANGES_PENDING` block, insert:

```ts
  if (!declaresVetraSecrets(state)) {
    // Made before slice 4: its host generated its own master key on an
    // ephemeral /data and its database keeps that key's fingerprint, so
    // Vetra's key would be refused. Branch and preview data are disposable:
    // start over (production has no instances yet).
    await deps.envs.delete(envId);
    await patch(deps, row, { status: "pending", reason: RECREATING_FOR_SETTINGS });
    return;
  }

  const tenantId = getTenantId(state.genericSubdomain ?? row.host!, envId);
  let deliveredAt = row.settings_delivered_at;
  if (row.settings_delivered !== settings.revision) {
    if (deps.tenantLive && !(await deps.tenantLive(tenantId)))
      return waitFor(deps, row, WAITING_FOR_NAMESPACE);
    await deliverSettings(deps, tenantId, settings, declaredSecretNames(state));
    deliveredAt = deps.now().toISOString();
    await patch(deps, row, {
      settings_delivered: settings.revision,
      settings_delivered_at: deliveredAt,
    });
  }
  const started = fusionVersion(state) !== null;
  const start =
    started ||
    !deps.tenantLive ||
    deps.now().getTime() - Date.parse(deliveredAt ?? "") >= SECRETS_SETTLE_MS;
  if (!start) return waitFor(deps, row, WAITING_FOR_SECRETS);
  const want = envSettings(settings);
```

  Then, in the rest of the function:
  - `if (row.failed_digest === row.target_digest)` → `if (failedOn(row, settings))`, and both revert calls → `instanceUpdateActions(state, back, app.owner_address, want)`.
  - `instanceUpdateActions(state, image, app.owner_address)` → `instanceUpdateActions(state, image, app.owner_address, want, start)`.
  - `observeHealth(state, { tag: image.tag, digest: row.target_digest!, settings: settings.revision }, row, …)`.
  - `observeEnvironment(…, !!row.running_digest && row.running_digest === row.target_digest && row.running_settings === settings.revision)`.
  - The `ready` condition adds `|| row.running_settings !== settings.revision`, and its patch adds `running_settings: settings.revision`.
  - The failure branch:

```ts
  const settingsOnly = row.running_digest === row.target_digest;
  await patch(deps, row, {
    status: "failed",
    reason: settingsOnly ? `${AFTER_SETTINGS_CHANGE}: ${seen.reason}` : seen.reason,
    ...failure(row, settings),
  });
  const back = revertImage(row); // null when only the settings changed: nothing to go back to
```

  i. `removeInstance`: when the environment is gone (the code path that patches the tombstone or deletes the row), call `await forgetTenant(deps, row);` first.

- [ ] **Step 6: API fields.** `instances/service.ts` `InstanceJson` + `instanceJson`: `settingsRevision: r.target_settings`, `runningSettingsRevision: r.running_settings`. `schema.ts` `AppInstance`: `"The App settings revision the instance should run (VETRA_SETTINGS_REVISION)" settingsRevision: String` and `"The settings revision it last ran healthy" runningSettingsRevision: String`.
- [ ] **Step 7: Run.** `npx vitest run subgraphs/vetra-apps/__tests__/instances-settings.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20` → PASS. Then `npx vitest run subgraphs/vetra-apps/__tests__/instances-*.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -30`. Expected differences in older tests, each to adjust deliberately rather than silence:
  - assertions on `h.envs.executed` counts (creation is now create-batch + approve, then a version batch + approve in the same pass);
  - `failed_digest` assertions that now also need `failed_settings`;
  - `appInstances` snapshots that need the two new fields.
  Licensed and old-path tests (`managedBy`, `ours`) must pass unchanged. If one fails, stop: that is a rule-1 regression.
- [ ] **Step 8: Commit.** `git add subgraphs/vetra-apps && git commit -m "feat(instances): deliver settings, gate the first start on secrets, roll setting changes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 10: Whole-suite check

- [ ] **Step 1:** `npm run tsc 2>&1 | tail -20` → no errors.
- [ ] **Step 2:** `npm run lint 2>&1 | tail -20` → no errors.
- [ ] **Step 3:** `npx vitest run subgraphs/vetra-apps subgraphs/vetra-cloud-observability subgraphs/vetra-cloud-secrets processors/vetra-cloud-environment subgraphs/vetra-licensing 2>&1 | grep -E "FAIL|Tests|failed" | tail -30` → all pass. Licensing and processor suites must pass **without changes** (licensed environments untouched). The golden values (`processors/vetra-cloud-environment/__golden__/*.yaml`) must be unchanged: this plan changes no processor code.
- [ ] **Step 4:** `git grep -n "s3cret\|console.log" subgraphs/vetra-apps/settings` → only test files. Review `setAppSetting`/`deliverSettings` once more for any value reaching a log or an error message.
- [ ] **Step 5: Commit** any fixes (`fix(settings): …`).

---

### Task 11: The canary shows its settings (vetra-publish-canary; needs the user to push)

**Files:**
- Modify: `/home/froid/projects/vetra-publish-canary/index.js`

- [ ] **Step 1: Branch.** `git -C /home/froid/projects/vetra-publish-canary checkout -b feat/settings-endpoint`.
- [ ] **Step 2: Implement** (replace the server part of `index.js`):

```js
const crypto = require("node:crypto");
// First 12 hex of sha256: shows a secret arrived and which value, never the value.
const hash = (v) =>
  v === undefined ? null : crypto.createHash("sha256").update(v).digest("hex").slice(0, 12);

if (require.main === module) {
  // A setting that breaks the host: tests a failed settings-only update.
  if (process.env.CANARY_CRASH === "1") {
    console.error("CANARY_CRASH=1: exiting");
    process.exit(1);
  }
  http
    .createServer((req, res) => {
      if (req.url === "/settings") {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            plain: {
              PH_HOST: process.env.PH_HOST ?? null,
              ADMINS: process.env.ADMINS ?? null,
              PUBLIC_URL: process.env.PUBLIC_URL ?? null,
              VETRA_SETTINGS_REVISION: process.env.VETRA_SETTINGS_REVISION ?? null,
              CANARY_PLAIN: process.env.CANARY_PLAIN ?? null,
            },
            secretHashes: {
              CANARY_SECRET: hash(process.env.CANARY_SECRET),
              PH_WORKFLOWS_SECRETS_MASTER_KEY: hash(process.env.PH_WORKFLOWS_SECRETS_MASTER_KEY),
              PH_ATTACHMENT_URL_SIGNING_SECRET: hash(process.env.PH_ATTACHMENT_URL_SIGNING_SECRET),
            },
            database: Boolean(process.env.PH_SWITCHBOARD_DATABASE_URL),
          }),
        );
        return;
      }
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end("<!doctype html><title>canary</title><p>vetra-publish canary</p>\n");
    })
    .listen(port, () => console.log(`canary listening on ${port}`));
}
```

- [ ] **Step 3: Check locally.** `cd /home/froid/projects/vetra-publish-canary && (CANARY_SECRET=abc node index.js &) && sleep 1 && curl -s localhost:6540/settings; kill %1 2>/dev/null; pkill -f "node index.js"`. Expected JSON with `"CANARY_SECRET":"ba7816bf8f01"` (sha256("abc") starts `ba7816bf8f01`). `CANARY_CRASH=1 node index.js; echo $?` prints `1`.
- [ ] **Step 4: Commit** (`feat: /settings shows the instance's settings (secret hashes only)` with the trailer). The user pushes and merges, and vetra-publish builds a new canary build on `main`.

---

### Task 12: Staging, then production (needs the user for every push and pin)

Staging switchboard GraphQL: `$STG` = the staging vetra-apps endpoint used in plan 3's staging steps. Calls are made as the canary App's owner (Renown bearer `$TOKEN`). `$APP` = the canary App id.

- [ ] **Step 1: PR and merge** (vetra-cloud-package; description: this plan's settings model and the legacy recreate). The user merges, and `main` publishes `0.0.<n>`.
- [ ] **Step 2: Staging pin** (user PR in `powerhouse-k8s-hosting`: `tenants/staging/powerhouse-values.yaml`, `PH_REGISTRY_PACKAGES` in both places). Wait for the roll (1-1.5 min).
- [ ] **Step 3: Legacy instances are recreated.** Within a few passes, `appInstances(appId: $APP)` shows each existing canary instance `pending: recreating the environment with Vetra's settings…`, then `updating: waiting for the environment's namespace…`, then `updating: waiting for the environment's secrets…`, then `ready` with `settingsRevision` = `runningSettingsRevision`. `curl -s https://<instance host>/settings` shows `secretHashes.PH_WORKFLOWS_SECRETS_MASTER_KEY` and `PH_ATTACHMENT_URL_SIGNING_SECRET` non-null and `database: true`, and `plain.VETRA_SETTINGS_REVISION` = `settingsRevision`. The host's first pod must have started with the key: `kubectl -n <tenant> get pod` shows restarts 0 and one pod since creation (no Reloader bounce right after the start), and its logs show no `MasterKeyMismatchError`. If the first pod started without the key, the gate is not holding: stop and investigate `tenantLive`.
- [ ] **Step 4: Plain and secret settings.**
  - `setAppSetting(input: {appId: $APP, name: "CANARY_PLAIN", value: "hello", secret: false})` and `setAppSetting(input: {appId: $APP, name: "CANARY_SECRET", value: "abc", secret: true})`.
  - Within ~1 min: instances `updating`, then `ready` on a new `settingsRevision`. `/settings` shows `CANARY_PLAIN: "hello"` and `CANARY_SECRET: "ba7816bf8f01"`.
  - `appSettings(appId: $APP)` shows `CANARY_SECRET` with `value: null`.
  - `git -C powerhouse-k8s-hosting log -p -3 -- previews/ tenants/ | grep -c abc` → 0: the value is not in git.
- [ ] **Step 5: Replace and delete.** `setAppSetting` `CANARY_SECRET` = `abcd`: the hash changes to `88d4266fd4e6`. `deleteAppSetting(appId: $APP, name: "CANARY_SECRET")`: the hash becomes null, and `kubectl -n <tenant> get secret <tenant>-secrets -o jsonpath='{.data}' | grep -c CANARY_SECRET` → 0. The master key hash is unchanged throughout.
- [ ] **Step 6: Scopes.** `setAppSetting` `CANARY_PLAIN` = `preview-only`, `scope: PREVIEW`. Open a PR on the canary: its preview shows `preview-only` and the branch instance still shows `hello`.
- [ ] **Step 7: Refusals.** `setAppSetting` with `name: "ADMINS"`, `"VETRA_X"` or `"PUBLIC_URL"` → `BAD_USER_INPUT`. As a stranger → `FORBIDDEN`.
- [ ] **Step 8: Settings-only failure.** `setAppSetting` `CANARY_CRASH` = `1`. The branch instance goes `updating`, health `unhealthy (crash …)`, then about 3-4 min later `failed: after a settings change: unhealthy (crash: …)`. The FUSION version is unchanged (no revert). The old pod keeps serving while the new one crash-loops (RollingUpdate), so the host stays up. `deleteAppSetting` `CANARY_CRASH`: a new revision is tried and the instance comes back `ready`.
- [ ] **Step 9: Digest failure with settings still reverts.** Push a canary commit that exits at start (as in plan 3's staging steps): `failed: unhealthy (crash …)`, back on the previous digest, with `settingsRevision` unchanged and `/settings` still showing the current settings. Revert the commit.
- [ ] **Step 10: Nothing else moved.** Sektar's licensed environments and their tenants: no new `tenant_secrets` keys (`kubectl -n <sektar tenant> get secret <tenant>-secrets -o jsonpath='{.data}' | tr ',' '\n' | cut -d: -f1` unchanged), no document operations. Golden values unchanged (Task 10).
- [ ] **Step 11: Production pin** (not inside the Sektar window): `tenants/vetra/powerhouse-values.yaml`, `PH_REGISTRY_PACKAGES` (two places). Production runs `VETRA_APPS_INSTANCES=off`, so only the API (settings stored) and the observability column are live there. Before production instances are switched on (slice 7 or earlier, user decision), check `appInstances` is empty for every App, or accept the one-time recreate.
- [ ] **Step 12: Console.** The follow-up plan below.

---

## Follow-up plan item: console (vetra.to), a separate plan

Not in this plan's code. Write it against this plan's GraphQL once Task 12 Step 2 is on staging. Scope:
- App page, **Settings** tab (operators only):
  - "Set by Vetra" list from `appSettings.vetra` (read-only, with the value descriptions);
  - publisher settings table (name, scope, plain value or "secret, set <date> by <name>", where names come from Renown profiles, never 0x addresses);
  - add/replace dialog (name validated against `reservedNames`/`reservedPrefixes` client-side; secret toggle with a write-only input; scope ALL/BRANCH/PREVIEW);
  - delete with confirm;
  - a note that plain values are visible in Vetra's deployment repository.
- Instances tab: "settings pending" when `settingsRevision ≠ runningSettingsRevision`, and the `after a settings change:` reason shown as such.
- Types in `modules/apps/types.ts`, queries/mutations in `modules/apps/graphql.ts`, hooks in `modules/apps/hooks/use-apps.ts`, tests beside them.

## Deferred: files (needs a chart change, the user's call)

The chart's `app` component mounts no files (only `persistence` at `/data`), so file settings (e.g. Sektar's `/client_secret_sektar-web-app.json`) are **not** in this slice. The `powerhouse-chart` change that would allow them, in `templates/app-deployment.yaml` and `values.yaml`:

```yaml
# values.yaml, under app:
  # Files from Secrets, one subPath mount each: [{name, secretName, key, mountPath}]
  secretFiles: []
```

```yaml
# app-deployment.yaml: replace the two persistence-only blocks with
        {{- if or .Values.app.persistence.enabled .Values.app.secretFiles }}
        volumeMounts:
        {{- if .Values.app.persistence.enabled }}
        - name: app-data
          mountPath: {{ .Values.app.persistence.mountPath }}
        {{- end }}
        {{- range $i, $f := .Values.app.secretFiles }}
        - name: secret-file-{{ $i }}
          mountPath: {{ $f.mountPath | quote }}
          subPath: {{ $f.key | quote }}
          readOnly: true
        {{- end }}
        {{- end }}
      {{- if or .Values.app.persistence.enabled .Values.app.secretFiles }}
      volumes:
      {{- if .Values.app.persistence.enabled }}
      - name: app-data
        persistentVolumeClaim:
          claimName: {{ include "powerhouse.fullname" . }}-app-data
      {{- end }}
      {{- range $i, $f := .Values.app.secretFiles }}
      - name: secret-file-{{ $i }}
        secret:
          secretName: {{ $f.secretName | quote }}
          items:
            - key: {{ $f.key | quote }}
              path: {{ $f.key | quote }}
          defaultMode: 0440
          optional: false
      {{- end }}
      {{- end }}
```

Also add `{{- if or .Values.app.secretEnv .Values.app.envFrom .Values.app.secretFiles }}` to the Reloader annotation condition (subPath mounts do not refresh, so Reloader must restart the pod). With `fsGroup: 1000` the file is readable by the app user. Once that ships, Vetra's side is small:
- a `kind: file` setting with a `mountPath` (absolute, not under `/data`, `/app`, `/proc`, `/sys`, `/etc`, `/var`, at most 10 per App, at most 64 KiB);
- stored and delivered like a secret under the key `FILE_<16 hex of sha256(mountPath)>`;
- declared to the processor (a document env entry cannot carry a path, so it needs either a FUSION config field (document model change) or a naming convention the processor maps to `app.secretFiles`; to be decided in that slice);
- `generateFusionBlock` emitting `secretFiles`.

Interim alternative without a chart change: Sektar reads the OAuth client JSON from a secret env var (e.g. `SEKTAR_GOOGLE_WEB_CLIENT_JSON`) when the file is absent. That is a Sektar change, and it works with this slice as it is.

Same chart PR, recommended: an `optional` flag per `secretEnv` entry (`optional: {{ ne .optional false }}`), so the processor can mark `PH_WORKFLOWS_SECRETS_MASTER_KEY` `optional: false`. A pod would then wait for the key instead of starting without it, making Task 9's start gate a guarantee rather than a timing rule.

---

## Decisions and spec gaps (rulings)

| Topic | Ruling | Why |
|---|---|---|
| Gap 7: 14.2 "per template" and holder settings | Publisher settings are **per App**, with an optional kind scope (`ALL`/`BRANCH`/`PREVIEW`). They become per template in phase 3. Holder settings (custom domain, own OAuth client) stay in phase 3 with own instances. | Templates and own instances arrive in phase 3 (overview gap 7). |
| Gap 9: `ADMINS` = org admins | Owner only (`app.owner_address`), as slices 1-3. One place to change (`fusionEnv`'s `admins` argument) when Renown answers "admins of org X". | Renown answers membership per address only. `memberOf` lists public memberships only. |
| Where secrets live at rest | App level: `app_settings.ciphertext`, OpenBao transit, pseudo-tenant `app-settings`. Per instance: the tenant store (`tenant_secrets`, per-tenant transit key) the controller materializes. | Spec 14.2 "stored in OpenBao". Same mechanism as invite-code keys and the existing FUSION secret path. No new infrastructure. |
| Delivery path | The reconciler writes tenant secrets and the document env. The processor is **not changed**. | The processor already renders `secretEnv` refs and turns on the controller for FUSION secrets. Licensed environments keep exactly today's render. |
| First start | Create without a version. Namespace live, then deliver, then 30 s, then start. | The switchboard pins its first master key's fingerprint, and `secretEnv` refs are optional, so a host must never see its first start without Vetra's key. |
| Settings revision | 16 hex over resolved settings (plain values; secret write ids). Rendered as `VETRA_SETTINGS_REVISION`, recorded per pod by observability, and required for `ready`. | A secret change does not change the document otherwise, and health must not call the old pod's health "ready". |
| Revert | Digest failures revert the image and keep the current settings. Settings-only failures are not reverted (`failed: after a settings change: …`), and neither is retried until the digest or revision changes. | Secret values are write-only; the old value is not kept. |
| Existing instances | Recreated once (fresh database) when their environment declares no master key. | Their database already holds a self-generated key's fingerprint. Only staging has instances. |
| `PH_ATTACHMENT_URL_SIGNING_SECRET` | Vetra-owned, generated per instance (not in spec section 5). | Same ephemeral-`/data` problem as the master key; links break on every restart otherwise. |
| `OPENROUTER_API_KEY` | **Allowed** as a publisher secret on branch/preview instances in phase 2. Reserved for shared/own instances in phase 3, where the LLM broker sets it. | Spec section 5 sets it only "when the plan includes AI". Dev instances have no plan, and Sektar's dev instances need a key. Confirm with the user. |
| Files | Deferred (chart change above). | No chart support today. |
| Per-kind overrides | Included (`scope`). | Cheap: one column and one resolution rule. |
| Double restart on a secret change | Accepted: Reloader restarts on the Secret, then Argo rolls for the revision. | Avoiding it needs a chart change (the Reloader annotation is unconditional with `secretEnv`). |
| Plain values in git | Accepted and stated in the console. Anything sensitive must be a secret. | Same as today's FUSION plain env. |

## Self-review

**Spec coverage:**
- Section 5 Vetra settings: `PH_HOST`, `ADMINS` (Task 6), `PUBLIC_URL` and database URLs (existing, listed in Task 3), master key (Tasks 3, 9), `/data` (gap 5, unchanged), access gate and `OPENROUTER_API_KEY` (phase 3, decision above).
- 14.2 publisher settings and secrets in OpenBao, the same on every instance, Vetra names refused: Tasks 3-5, 9. Files: deferred with the chart change. Holder settings: phase 3.
- Section 6 (settings in the desired state; a failed update keeps the previous state): Task 9 (digest revert; settings-only rule stated).
- 14.7 health applied to setting changes: Task 8.
- Owner-only API: Task 5. Console: follow-up item. Licensed environments untouched: Global Constraints, Tasks 9 Step 7, 10 Step 3, 12 Step 10. Staging with the canary: Tasks 11, 12.

**Placeholder scan:** code steps carry their code. Two test steps name helpers from existing test files (`instances-status.test.ts`, `instances-health.test.ts`) by their slice 3 names, with an instruction to use the actual names if they differ. The assertions are given.

**Type consistency:**
- `AppSettingRow` (Task 2) is used by `settingsForKind` (Task 3) and the service (Task 5).
- `InstanceSettings`/`ResolvedSecret` (Task 3) are used by `envSettings` (Task 6), `deliverSettings` and `reconcileInstance` (Task 9).
- `InstanceSettingsEnv` (Task 6) is used by `fusionEnv`, `instanceCreateActions`, `instanceUpdateActions` and the reconciler.
- `SETTINGS_REVISION_ENV`/`VETRA_GENERATED_SECRETS` (Task 3) are used in Tasks 6 and 9. Observability uses the literal `VETRA_SETTINGS_REVISION` (Task 7).
- `SettingsVault` and the `AppsDeps.instanceSecrets` Pick including `notifyTenant` (Task 1) and `purgeTenant` (Task 4) are used in Tasks 5 and 9.
- `health_settings`/`observed_settings` (Task 2 columns, Task 8 `HealthRecord`/`HealthView`) are used by `observeHealth` and `CLEAN` (Task 9).
- `failed_settings`/`running_settings`/`target_settings`/`settings_delivered*` (Task 2) are used in Task 9.

## Not in this plan

- Files (chart change above).
- Holder settings and per-template settings (phase 3).
- Org-admin `ADMINS` (Renown query).
- The access gate (`ACCESS`, `VETRA_APP_ID`) and Vetra's `OPENROUTER_API_KEY` for plans (phase 3).
- A per-instance setting override (phase 3, own instances).
- Settings history and audit beyond `updated_by`/`updated_at` and the log line (phase 3 audit log).
- The console (follow-up plan).
