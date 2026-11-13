# Releases phase 3, plan 9: Sektar switch-over — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** every Sektar holder moves from their licensed environment to an **own instance** of the plan that adopted their licence kind, with their database, their `/data` and their keys, on the same address, one environment at a time, with a way back. Licensing stops acting on an environment once it is switched over; the old environment is kept, held, for 30 days.

**Architecture:**
- A **switch-over** is a row in a new table `switchovers` (vetra-apps), driven by a resumable state machine. A periodic runner (`advanceSwitchoversOnce`, every 15 s) moves each open switch-over at most one step per pass. Each step first reads what is already true (a job that already exists, an instance that is already created) and only then acts, so a crash, a restart or a retry repeats nothing. At most one switch-over per App is past `PREPARED` at any time (D11).
- A new primitive, the **hold**: a row in `environment_holds` makes the processor render the environment with `app.replicaCount: 0` and no app ingress, while its CNPG database, its pooler, its backups and its `/data` volume stay. The hold replaces "sleep" wherever data must survive, because **sleeping (`STOPPED`) a database-backed environment deletes its database** (the chart removes the CNPG `Cluster` on `global.disabled`, and CNPG deletes its volumes; see "What production holds", finding F1).
- The new instance is **prepared ahead of the window**: created on the plan's release, under a hold from its first render, on the old environment's host label, with the old workflows master key and attachment signing secret written into its tenant secrets **before its first start**. The window then only covers: hold the old environment, dump and archive, restore, start, verify.
- Database copies use the observability dumps subsystem and `/data` copies use slice 4's archive jobs, both through one adapter (`SwitchoverBackups`) so this plan does not depend on their internals. Verification runs a count job in each tenant (counts only, never data) and compares.
- Licensing learns one new fact per row: `license_environments.switched_over_at`. A switched-over row stays (it keeps vouching the old environment's image project, so the held environment keeps rendering), but licensing no longer provisions, updates, offboards or sleeps it, and the vetra-apps plan sync treats the chain as the instances model's.
- Gated rollouts of the App are **frozen** for the campaign (`app_release_settings.frozen_reason`): `promoteRelease`, `resumeRollout`, `forceEnvironmentUpdate`, `requestUpdateNow` refuse, the release tracker skips the App, and the bridge `recordLicensedHost` stops moving channels.
- Admin-only GraphQL (platform admins, `caller.isAdmin`): plan, prepare, run, roll back, dry-run, adopt a kind, freeze. Every change is audited (slice 2's `app_audit`, new `switchover.*` actions, source `console`/`api`/`system`).

**Tech Stack:** TypeScript, Kysely (Postgres; PGlite in tests), vitest, Kubernetes Jobs (`@kubernetes/client-node`), GraphQL (vetra-apps subgraph), Helm values rendered by `processors/vetra-cloud-environment/gitops.ts`.

**Spec:** `docs/superpowers/specs/2026-11-11-app-releases-and-instances-design.md` section 13 (switch-over), 5 (own instances, what every instance runs), 7 (one at a time, backups), 14.5 (holder data stays the holder's), 14.7 (healthy), 14.12 (rehearsal clones never expose holder data, destroyed right after). Slice scope, D10-D12 and gap 9 (keys on `/data`): `docs/superpowers/plans/2026-11-12-releases-phase-3-overview.md` slice 9. Conventions: plan 1 and plan 2 in this directory.

---

## What production holds (read-only checks, 2026-11-12)

Checked with `kubectl` (context k3s) and `SELECT`s on `vetra_db` and the tenant databases. Holders are counted, never named.

**The App and its terms.** Sektar (`43622402-be06-435a-bbfa-bb649b0d6244`, slug `sektar`) has **one** template, `838be04f-1ec7-49d5-b034-3f778ed37e81` "Sektar cloud": mode **DEDICATED**, size `VETRA_AGENT_M`, one FUSION service (`artifactName: host`, channel LATEST), `warmPoolSize: 1`. Two terms point at it, both issued by `INVITE_CODE`:

| Term kind | Label | Validity | Licences issued | Live licences |
|---|---|---|---|---|
| `sektar-cloud` | Sektar cloud | none | 14 | 10 ACTIVE (4 REVOKED) |
| `sektar-cloud-1y` | Sektar cloud (1 year) | 365 days | 1 | 1 ACTIVE |

There is **no SHARED term**. The App's production environment (`calm-bat-b4qzzqbb`, role PRODUCTION) runs the platform switchboard and Connect v6.2.3, not Sektar's host; its database is 9 MB with 5 empty drives and 2 operations. **Nothing to move for shared access (D12).**

**Licensed environments** (`hwdbocujzo.license_environments`, app Sektar): 15 rows.
- **11 live** (not ended), held by **9 distinct holders** (one holder has 3, labelled as test environments; one more is labelled as a test). Each environment's `ADMINS` is exactly its holder (one address = the document owner), `PH_HOST=cli`, and its FUSION env has **only** `ADMINS` and `PH_HOST`: no holder-set entries, no `OPENROUTER_API_KEY`.
- 4 ended (REVOKED, `ended_at` set, `delete_after` set): their documents are gone and their namespaces hold only the 10 Gi `/data` PVC. Not switched over.
- `channel_override` is null on every row: **there is no canary today** (finding F3).
- No custom domain on any of them (`customDomain` empty, `customDomainEnabled` false). Hosts are `<label>-<8>.vetra.io` on the wildcard certificate.

| | Live environments | Size of `/data` (used / PVC) | Database (CNPG, 50 Gi PVC, PG 18.1) | Documents | Workflow secrets | Attachments |
|---|---|---|---|---|---|---|
| Large | 4 | 0.2-3.3 MB / 10 Gi | **5.8, 6.6, 6.8, 7.6 GB** (≈95 % `reactor.Operation` + `operation_index_operations`, 1.5-1.9 M operations each) | 14-176 | 2-5 each | 0-32 |
| Small with data | 3 | 0.2-3.7 MB | 12-15 MB | 11-16 | 1-2 each | 0-1 |
| Fresh (default drives only) | 4 | 0.2 MB | 11-14 MB | 8 | none (no secret table yet) | 0 |
| **Total** | **11** | **< 12 MB** | **≈ 27 GB** | | **17** in 7 environments | **76** |

- Every live environment keeps `workflows-master-key` and `attachment-url-signing-secret` (64 bytes each) on `/data`, next to `.ph/` (`ap-bundles`, `registry-packages`, `run`). Their tenant secrets hold only `VETRA_LICENSING_URL` and `VETRA_REPORTING_TOKEN`, and the app container does not even receive those (no `secretEnv`, no `envFrom`). The 7 environments with workflow secrets have a `secret_key_check` row, so a different master key refuses them (`MasterKeyMismatchError`). Sektar's entrypoint (`hosts/cli/docker-entrypoint.sh` `kept_secret`) uses an env value when one is set and the `/data` file only otherwise: an own instance gets `PH_WORKFLOWS_SECRETS_MASTER_KEY` from its tenant secrets, so the **old value must be in the tenant before the first start** (overview gap 9, confirmed).
- Images: 10 environments on `cr.vetra.io/app-sektar/host:sha-d5a6f74abbf3`, 1 (created 2026-11-11 from the warm pool) on `sha-cac9276bc10b` (v1.0.9). The gated rollout `144e284e-…` (v1.0.9) has 10 PENDING updates due **2026-11-13 18:41 UTC**.
- CNPG: one instance per tenant, continuous WAL archiving and daily base backups to `s3://powerhouse-cnpg-backups/<tenant>/` (180 d), healthy. The observability dumps of these tenants so far: SCHEDULED only, the largest dump in the whole bucket is 252 MB in 60 s.
- The licensing warm pool has 1 AVAILABLE and 4 CLAIMED environments for the template.
- **fast-lion** (`viEZX6-M6JqPIRLK3FyqHHLeADFFGCslnoZj963kPFA`), the canary chosen on 2026-11-10, **no longer exists**: its workload and database were torn down on 2026-11-10 20:07-20:08 UTC, its `license_environments` row and document are gone, and only its 10 Gi `/data` PVC is left in `fast-lion-viezx6m6-viezx6m6`.

**The new model in production:** `plans` 0 rows, `instances` 0 rows, `VETRA_APPS_INSTANCES` off. Sektar's `releases`: 15 builds and 2 releases, `1.1.0-beta.0` (branch `vetra-next`, Powerhouse `6.2.3-dev.96`, `cr.vetra.io/sektar/sektar:1.1.0-beta.0`) and a test `0.0.0-alpha.1`. **No stable release through vetra-publish yet** (finding F4).

**Staging:** 0 licensed environments, 39 grants, 2 plans; the vetra-publish canary app has instances on.

## Findings that change the overview

- **F1 Sleep destroys databases.** `powerhouse-chart/templates/postgres-cluster.yaml` renders the CNPG `Cluster` only when `not .Values.global.disabled`; `STOPPED` renders `global.disabled: true`; CNPG prunes its PVCs (reclaim Delete). The chart comment says so ("Manual sleepEnvironment on a DB studio is destructive"). Every `STOPPED` switchboard environment in production has no CNPG cluster left. Consequences:
  - Overview slice 9 step 2 ("Stop the licensed environment (sleep)") and "keep the old environment stopped 30 days" would delete the holder's database. This plan **holds** instead.
  - Slice 1 (built, `VETRA_APPS_PLANS` off in production) stops an own instance whose licence ended, and a retired shared plan's instance, with `sleepEnvironment` (`instances/reconciler.ts` line ~319). With role `PLAN` (database on) that **deletes the holder's database**. Task 5 makes Vetra stop plan instances by hold (S2: ship it first as its own fix).
  - Licensing's offboarding sleeps a licensed environment 14 days after its licence ends (`offboarding.ts` `tickOffboarding`, `STOP_AFTER_DAYS`). For Sektar that deletes the holder's database 14 days after an end, not 90. Not changed by this plan beyond switched-over rows (Task 8); reported to the user (S14).
  - Unsetting the FUSION version does not help either: the `Cluster` template also needs `app.enabled`, so an instance created with `start: false` has **no database and no `/data` volume** until its version is set. The hold is what lets a database exist without the app running.
- **F2 No shared holders.** No SHARED term exists, and the production environment holds nothing. D12 needs no shared instance. A SHARED term appearing before the switch-over makes `checkSwitchover` refuse until slice 5 is on production.
- **F3 No canary.** fast-lion was deleted; GATED `promoteRelease` currently refuses for lack of a READY canary. D11's "fast-lion first" becomes "a team-held environment first" (S5).
- **F4 No target release.** Sektar has published only a prerelease and a test release through vetra-publish. The switch-over needs a stable release recorded by `ci/releases` (S6).
- **F5 Downtime is dominated by four databases.** 5.8-7.6 GB each of operation log. A logical dump and restore of that size takes far longer than "a few minutes". This plan measures each environment with a production dry run (no downtime) and announces each window with its measured length; the fresh-target restore runs `pg_restore -j` (S8).
- **F6 Nothing to carry beyond `/data` and the database.** No custom domains, no holder FUSION entries, no AI key, and the reporting token never reaches the app. The parity set is: the two key files (inside `/data`), `ADMINS` (= the holder, also the own instance's admin), and the **host label**, which this plan keeps (S4).
- **F7 The switched-over row must stay.** The processor vouches a licensed environment's image project through `license_environments` (`app-image-project.ts`). A held old environment whose row is deleted renders `app.enabled: false` and loses its database (F1). Rows are marked, never removed.
- **F8 The restore path today restores into the same tenant.** `buildRestoreJob` reads `${tenantNs}/${dumpId}.dump` and runs one `psql --single-transaction` after `DROP OWNED`. The switch-over needs a cross-tenant, fresh-target restore (slice 4 interface, below).

## Decisions to confirm (recommended default first; the plan is written with the default)

- **S1 Hold, not sleep, everywhere data must survive.** New `environment_holds` table read by the processor (like the warm-pool lookup), rendering `replicaCount: 0` and no app ingress; database, pooler, backups and `/data` stay. No document-model change. *Alternative:* a `SET_HOLD` operation in the environment model (visible in documents, but needs a model change and a vetra.to regen).
- **S2 Fix slice 1's stop first.** Task 5 (plan instances stop by hold) ships as its own PR (`fix(instances): …`) before anything else of this plan, and before `VETRA_APPS_PLANS` is turned on anywhere with a holder's data. *Alternative:* ship it with this plan.
- **S3 Copy, don't adopt in place.** A new own instance with copied data, the old environment held untouched as the way back. *Alternative:* turn the licensed environment document itself into the own instance (no copy, no downtime beyond an image update), at the cost of no untouched copy, a holder-owned document in the instances model (against D2) and `managedBy` rules to undo.
- **S4 Keep the address.** The own instance takes the old environment's host label (`fair-ibis-huk51fts` → same `https://<label>.vetra.io`), so bookmarks, `PUBLIC_URL`-based OAuth callbacks and the holder's browser sign-in keep working. The old environment's ingress goes when it is held. *Alternative:* a generated `own-…` label and a "your new address" notice.
- **S5 Order.** (1) a team-held licensed environment as canary (fast-lion's replacement: the user redeems a `sektar-cloud` code before the kinds are adopted, fills it with documents, an attachment and a workflow connection); (2) the 4 fresh environments; (3) the 3 small environments with data; (4) the 4 large ones, the test-labelled one first. One at a time, 72 h notice each (windows may be announced together), at most one per day for the large ones.
- **S6 Target.** The first **stable** Sektar release recorded by `ci/releases` (e.g. `1.1.0`), after it has run on the staging rehearsal and on the production canary. Both own plans target it.
- **S7 Plans.** Two own plans, one per kind (D1, 1:1): `cloud` ← `sektar-cloud`, `cloud-1y` ← `sektar-cloud-1y`, size `VETRA_AGENT_M` (the template's), policy `manual`. Both adopted (`adoptLicensedKind`) **before** the canary, so no new licensed environment appears during the campaign: new holders get own instances at once (slice 8's pool makes that fast; without it they wait one reconcile). The overview's "adopt only while every environment is switched over or in progress" is replaced by this, which overview rule 1 already makes safe (a chain with a `license_environments` row is never given an instance until its switch-over links it).
- **S8 Database copy.** `pg_dump -Fc` of the held old database, `pg_restore -j 4 --no-owner --no-acl` into the new, empty database (fresh-target mode, no `DROP OWNED`, no single transaction; the target is new and never started, so a failure is redone from an empty database). *Alternative for the 4 large ones later:* a CNPG physical copy (replica cluster or recovery from the existing barman backups), which needs chart support.
- **S9 Production dry runs.** Before each environment's window: a dry run that copies it, while it keeps running, into a throwaway clone (no admins, ingress closed, spec 14.12), restores, starts the target release on it, verifies, records durations, and destroys the clone. It proves the migration on real data and sizes the window. *Alternative:* staging rehearsal only.
- **S10 Freeze for the whole campaign.** From the first window to the last: no gated promotions or updates for Sektar's remaining licensed environments; switched-over holders get releases through slice 3 rollouts. *Alternative:* freeze only while a switch-over is past `PREPARED`.
- **S11 Rollback window.** Lossless until the new instance starts. From the start until the holder confirms or 72 h pass, `rollBackSwitchover` brings the old environment back and discards what was written on the new one (the console says so). After that, only fixes forward.
- **S12 Holder confirmation.** Vetra checks health, counts and keys itself and never signs in as the holder (spec 14.5). The holder is asked to sign in and press "Looks right" (`confirmSwitchover`); 72 h without an answer counts as confirmed.
- **S13 Retention.** The switch-over dump and `/data` archive are kept 180 days (key prefix `switchover/`, not slice 4's 30-day `PRE_UPDATE` rule). The old environment stays held for 30 days after `DONE`; then the user decides (overview rule 5); this plan deletes nothing.
- **S14 Licensing offboarding sleeps** (F1) — report to the user now; a separate fix (offboarding holds instead of sleeping) is recommended before any Sektar licence ends again. Not in this plan.

## Dependencies (what this plan consumes)

| Slice | Needed | Interface this plan uses |
|---|---|---|
| 1 Plans (built) | yes | `plans`, own `instances` rows (`plan_id`, `holder_address`, `licence_root_id`), `syncPlanInstances`, `licensedRoots`, `planInstanceLabel`, `instanceCreateActions` (`role: "PLAN"`, `start`), `claimHost` (keeps a preset `row.host`), `deliverSettings` (`ensureSecret`: never replaces a key that is already there). Fixed by Task 5. |
| 2 Audit (built) | yes | `recordAudit(db, entry)`, `AUDIT_SYSTEM_ACTOR`, `auditCaller(caller)`; new actions added here. |
| 3 Rollouts | yes (production: `VETRA_APPS_ROLLOUTS` on, health `enforce`) | `instanceReady(deps, instanceId): Promise<{ ready: boolean; reason: string \| null; runningVersion: string \| null }>` (spec 14.7 under `enforce`); rollouts **skip** an instance whose `switchover_id` is set (`rollout_steps.status = SKIPPED`, reason `"switch-over in progress"`) and a plan with an open switch-over refuses `setPlanTarget`/new rollouts touching it (`hasOpenSwitchover(db, planId)`, provided here). |
| 4 Backups | yes | `SwitchoverBackups` (below): `startDump`, `dumpStatus`, `startArchive`, `archiveStatus`, `startRestoreDump` (cross-tenant, `mode: "fresh"`, `jobs`), `restoreStatus`, `startRestoreArchive` (cross-tenant), `readArchiveFiles` (two small files, in memory), plus `source = "SWITCHOVER"` and the `switchover/` key prefix with 180-day retention. An archive job may run on the node of a running pod with the volume mounted read-only (`sameNodeAs`), for dry runs. |
| 5 Licence gate | **no** (no SHARED term, F2) | `checkSwitchover` refuses an App with a SHARED term until `gateActive(appId)` exists and answers true. |
| 7 Holders | **no** for today's data (F6) | `checkSwitchover` refuses an environment with a custom domain or holder FUSION entries beyond `ADMINS`/`PH_HOST`. When slice 7 lands: `moveCustomDomain(fromEnvironmentId, toInstanceId)` and `copyHolderSettings(fromEnvironmentId, toInstanceId)`, called in `PREPARING`. |
| 8 Warm pool | optional | Not used for the switch-over itself (the instance is prepared ahead). Makes new holders' instances fast after S7's adoption. After the last switch-over, set the template's `warmPoolSize` to 0 (licensing's pool then drains; slice 10 removes it). |

```ts
// subgraphs/vetra-apps/switchover/backups.ts — implemented over slice 4 (Task 12)
export interface JobState { status: "PENDING" | "RUNNING" | "READY" | "FAILED"; error: string | null; startedAt: string | null; finishedAt: string | null }
export interface SwitchoverBackups {
  /** pg_dump of a tenant's database through its pooler; source SWITCHOVER, requested by "vetra". */
  startDump(i: { tenant: string; environmentId: string; key: string }): Promise<{ dumpId: string }>;
  dumpStatus(dumpId: string): Promise<JobState & { sizeBytes: number | null }>;
  /** tar.zst of a /data PVC; `sameNodeAs`: run beside that pod, volume mounted read-only (dry runs). */
  startArchive(i: { tenant: string; pvc: string; key: string; sameNodeAs?: { namespace: string; pod: string } }): Promise<{ archiveId: string }>;
  archiveStatus(archiveId: string): Promise<JobState & { sha256: string | null; files: number | null; bytes: number | null }>;
  /** Restore a dump made in another tenant into an empty, never-started database. */
  startRestoreDump(i: { dumpId: string; targetTenant: string; mode: "fresh"; jobs: number }): Promise<{ restoreId: string }>;
  startRestoreArchive(i: { archiveId: string; targetTenant: string; pvc: string }): Promise<{ restoreId: string }>;
  restoreStatus(restoreId: string): Promise<JobState>;
  /** The named files of an archive, read in memory (never written to disk or logs). */
  readArchiveFiles(archiveId: string, names: string[]): Promise<Map<string, Buffer>>;
}
```

## Model (as built here)

**`switchovers`** (vetra-apps namespace)

| Column | Meaning |
|---|---|
| `id` | UUID |
| `app_id`, `environment_id` | the App and the old licensed environment |
| `old_tenant`, `old_host` | e.g. `fair-ibis-huk51fts-huk51fts`, `fair-ibis-huk51fts` (label only) |
| `licence_root_id`, `holder_address` (lowercased), `kind` | from `license_environments` + `app_license_grants` |
| `plan_id`, `instance_id` | the own plan of `kind`; the new instance (set in `PREPARING`) |
| `release_version`, `release_digest` | the plan's target when planned (pinned for this switch-over) |
| `mode` | `real` \| `dry_run` |
| `state` | below |
| `failed_state`, `error` | the state a failure happened in, its reason (≤ 500 chars, no secrets) |
| `window_start`, `window_end` | the announced window (ISO); `real` only |
| `step_started_at`, `attempts` | timeout and retry bookkeeping of the current step |
| `prepare_archive_id`, `dump_id`, `archive_id`, `restore_db_id`, `restore_data_id` | job references |
| `key_fingerprints` | JSON `{ master: sha256-hex, attachment: sha256-hex }` of the two keys (never the keys) |
| `source_counts`, `copy_counts`, `started_counts` | JSON counts (below) |
| `timings` | JSON seconds per step (dry runs size the window) |
| `downtime_started_at`, `started_at`, `confirmed_at`, `done_at`, `hold_until`, `rolled_back_at` | |
| `created_by`, `created_at`, `updated_at` | |

Indexes: unique `(environment_id) WHERE mode = 'real' AND state NOT IN ('ROLLED_BACK')`; `(app_id, state)`.

**Other schema changes:** `environment_holds (environment_id PK, reason, switchover_id null, created_by, created_at)`; `instances.switchover_id` (nullable); licensing `license_environments.switched_over_at`, `switched_over_instance_id` (nullable); licensing `app_release_settings.frozen_reason`, `frozen_at` (nullable).

**Counts** (one job per tenant, `psql` in the dump image, prints one JSON line, counts only): `documentsByType` (non-deleted global `DocumentSnapshot` per `documentType`), `operations` (`count(*)` of `reactor."Operation"`), `workflowSecrets` (the workflow secret table's rows, 0 when absent), `keyCheck` (the `secret_key_check` fingerprint, or null), `attachments` (`attachments.attachment` rows). The schema of the workflow secret table is found by table name (`secret`, `secret_key_check`), never hard-coded (it is a hashed namespace).

**States** (`real`; a dry run uses the rows marked ◇ and ends in `CLEANED`)

| State | Entered when | Step run in this state (idempotent) | Next | Step timeout |
|---|---|---|---|---|
| `PLANNED` ◇ | `planSwitchover` | none; waits for `window_start - prepareLeadHours` (dry run: at once) | `PREPARING` | — |
| `PREPARING` ◇ | lead time reached | read keys: same-node read-only `/data` archive of the running old env → `readArchiveFiles` → fingerprints; create the instance row (`kind own`, `plan_id`, `holder_address`, `licence_root_id`, `host = old_host` (dry run: `rehearsal-<8>`), `switchover_id`); hold its future environment id as soon as the reconciler created the document (no version yet); `setSecrets` both old keys into the new tenant (replacing generated ones: nothing has used them); then let the reconciler set the version (the hold makes it render database + `/data`, no pod) | `PREPARED` when instance `environment_id` set, keys in tenant match fingerprints, CNPG `Ready`, PVC `Bound` | 30 min |
| `PREPARED` ◇ | | none; waits for `window_start` (dry run: at once) and for no other switch-over of the App past `PREPARED` | `HOLDING_OLD` (dry run: `BACKING_UP`) | — |
| `HOLDING_OLD` | window open | freeze set (Task 6) and checked; insert hold on the old environment; re-render; wait until its app pod is gone | `BACKING_UP` | 10 min |
| `BACKING_UP` ◇ | old app pod gone (dry run: still running) | start dump + `/data` archive (dry run: same-node archive) of the old tenant; count job on the old tenant → `source_counts`; wait both READY | `RESTORING` | 90 min |
| `RESTORING` ◇ | | start fresh-target DB restore + `/data` restore into the new tenant; wait both READY | `CHECKING_COPY` | 120 min |
| `CHECKING_COPY` ◇ | | count job on the new tenant → `copy_counts`; must equal `source_counts` exactly; archive manifest sha256 equal; keys in the new tenant still match `key_fingerprints` | `STARTING` | 15 min |
| `STARTING` ◇ | | delete the new instance's hold; re-render; the app starts and migrates | `VERIFYING` | — |
| `VERIFYING` ◇ | | `instanceReady` (slice 3, `enforce`) on the pinned digest; count job → `started_counts`: same `documentsByType`, `workflowSecrets`, `attachments`, `keyCheck`; Connect page answers on `https://<host>` | `LINKING` (dry run: `CLEANING`) | 30 min |
| `LINKING` | | one transaction: `license_environments.switched_over_at`, `switched_over_instance_id`; `instances.switchover_id = null`; audit `switchover.linked` | `AWAITING_CONFIRMATION` | — |
| `AWAITING_CONFIRMATION` | | holder banner "moved, please check"; waits for `confirmSwitchover` or 72 h | `DONE` | — |
| `DONE` | | `hold_until = done_at + 30 d`; the old environment stays held | — | — |
| `CLEANING` ◇ | dry run verified | delete the clone's environment document and instance row (spec 14.12); keep timings and counts | `CLEANED` | 15 min |
| `FAILED` | any step failed or timed out | none; `failed_state` and `error` kept | `resumeSwitchover` → `failed_state`; `rollBackSwitchover` → `ROLLING_BACK` | — |
| `ROLLING_BACK` | `rollBackSwitchover` | hold the new instance (if any); unlink (clear `switched_over_at`, instance `stop_reason = "switch-over rolled back"`, `switchover_id` kept for history); delete the old environment's hold; wait for the old app ready | `ROLLED_BACK` | 15 min |

Rollback by state: `PLANNED`-`PREPARED`: nothing ran for the holder, the prepared instance is held and removed. `HOLDING_OLD`-`CHECKING_COPY`: lossless (the old database was never written by the switch-over). `STARTING`-`AWAITING_CONFIRMATION`: allowed, writes made on the new instance are lost (S11). `DONE`: refused.

**Downtime** = `downtime_started_at` (old app pod gone) to the first `instanceReady` = dump + archive + restore + checks + start. The dry run measures exactly these steps.

## Global Constraints

- Only Sektar-shaped licensed environments are switched over: DEDICATED template, FUSION host, `license_environments` row live, document READY. `checkSwitchover` (Task 10) refuses everything else with a reason, before anything is written.
- Nothing is deleted except a dry run's clone (spec 14.12). Old environments, their rows, dumps and archives stay; overview rule 5 holds.
- No secret value reaches a table, a log line, an audit row or a GraphQL answer: keys are read in memory, written to the tenant store, and only their sha256 is stored. Counts are counts.
- Kill switch `VETRA_APPS_SWITCHOVER` (default **off**): the runner does nothing and the mutations refuse. Production turns it on only for the campaign. It needs `VETRA_APPS_INSTANCES`, `VETRA_APPS_PLANS` and (production) `VETRA_APPS_ROLLOUTS` on.
- Mutations: platform admins only (`caller.isAdmin`), except `confirmSwitchover` (the holder of that switch-over).
- Every step is idempotent: it reads the current external state first (job by label, instance by `switchover_id`, hold row, tenant secret fingerprint) and acts only on what is missing.
- Additive schema only, through idempotent `ensure…` migrations (vetra-apps and licensing patterns).
- Commits: one per task, conventional (`fix(instances): …`, `feat(model): …`, `feat(switchover): …`, `feat(licensing): …`, `feat(processor): …`), trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Branch `feat/releases-phase-3-switch-over` from `main` (Task 5 on `fix/plan-instances-stop-by-hold` first, S2).
- Checks after every task: `npx vitest run <the task's test files> 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. At the end: `npm run tsc`, `npm run lint`, and `npx vitest run subgraphs/vetra-apps subgraphs/vetra-licensing subgraphs/vetra-cloud-observability processors/vetra-cloud-environment 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`.
- No production pin while a Sektar gated rollout is APPLYING (overview rule 4): check `vetraReleases.rollouts(appId: "43622402-be06-435a-bbfa-bb649b0d6244")`. The v1.0.9 rollout is due 2026-11-13 18:41 UTC.

## File structure

| File | Change |
|---|---|
| `subgraphs/vetra-apps/config.ts` | `SwitchoverConfig`, `switchoverConfigOf` (`VETRA_APPS_SWITCHOVER`, `VETRA_APPS_SWITCHOVER_LEAD_HOURS`, `…_HOLD_DAYS`, `…_CONFIRM_HOURS`, `…_RESTORE_JOBS`) |
| `subgraphs/vetra-apps/db/schema.ts`, `db/migrations.ts` | `environment_holds`, `switchovers`, `instances.switchover_id` |
| `subgraphs/vetra-apps/holds/repo.ts`, `holds/service.ts` (new) | hold rows; `holdEnvironment`, `releaseHold`, `isHeld`, re-render trigger |
| `processors/vetra-cloud-environment/app-image-project.ts`, `gitops.ts`, `processor.ts`, `factory.ts` | `HoldLookup`; held render (`replicaCount: 0`, ingress off) |
| `subgraphs/vetra-apps/instances/reconciler.ts` | stop/wake of plan instances by hold (Task 5); `switchover_id` rows left to the switch-over |
| `subgraphs/vetra-licensing/db/schema.ts`, `db/migrations.ts` | `switched_over_at`, `switched_over_instance_id`, `frozen_reason`, `frozen_at` |
| `subgraphs/vetra-licensing/release-service.ts`, `release-tracker.ts`, `rollout-db.ts` | freeze |
| `subgraphs/vetra-apps/releases/licensed-host.ts` | bridge skips a frozen App |
| `subgraphs/vetra-licensing/environments.ts`, `handler.ts`, `offboarding.ts`, `managed-by.ts`, `plan-kinds.ts`, `publisher-resolvers.ts`, `subscriptions-resolvers.ts` | switched-over rows |
| `subgraphs/vetra-apps/plans/holders.ts`, `plans/sync.ts`, `plans/service.ts` | switched-over chains; `adoptLicensedKind` |
| `subgraphs/vetra-apps/audit/repo.ts` | `switchover.*` actions |
| `subgraphs/vetra-apps/switchover/` (new): `repo.ts`, `checks.ts`, `machine.ts`, `backups.ts`, `counts-job.ts`, `steps.ts`, `runner.ts`, `rollback.ts`, `service.ts` | the switch-over |
| `subgraphs/vetra-licensing/offboarding.ts` | `SWITCHOVER_SCHEDULED`, `SWITCHED_OVER` warnings |
| `subgraphs/vetra-apps/schema.ts`, `resolvers.ts`, `index.ts` | API and runner wiring |
| Tests (`subgraphs/vetra-apps/__tests__/` unless noted) | `config.test.ts`, `migrations.test.ts`, `holds.test.ts`, `instances-plan-stop-hold.test.ts`, `switchover-checks.test.ts`, `switchover-machine.test.ts`, `switchover-steps.test.ts`, `switchover-runner.test.ts`, `switchover-rollback.test.ts`, `switchover-api.test.ts`, `plans-adopt.test.ts`; `processors/vetra-cloud-environment/held.test.ts`; `subgraphs/vetra-licensing/__tests__/freeze.test.ts`, `switched-over.test.ts`; `subgraphs/vetra-apps/__tests__/fakes/backups.ts` |

---

### Task 0: Pre-flight (no code)

- [ ] **Step 1: Slices on `main`.** Confirm slices 3 and 4 are merged and expose the interfaces in "Dependencies" (`grep -rn "instanceReady\|startRestoreDump\|readArchiveFiles" subgraphs/`). Where a name differs, adapt `switchover/backups.ts` and the `instanceReady` call, not the slice. If slice 4 is not merged, stop: Tasks 12-15 cannot run.
- [ ] **Step 2: Branch.** `git fetch && git checkout -b fix/plan-instances-stop-by-hold origin/main` for Tasks 1-5 (S2), then `feat/releases-phase-3-switch-over` from `main` after that PR merged. Never stash; never touch the other worktrees (`git worktree list`).
- [ ] **Step 3: Baseline.** Run the end-of-plan vitest command and record failures that exist before any change in the PR description.
- [ ] **Step 4: Re-check production (read-only)** with the queries of "What production holds" (counts may have moved): live rows, sizes, keys on `/data`, custom domains, SHARED terms, `channel_override`. Update the table in this file if they changed.

---

### Task 1: Switch-over config

**Files:** Modify `subgraphs/vetra-apps/config.ts`. Test `subgraphs/vetra-apps/__tests__/config.test.ts`.

**Interfaces:** Produces `SwitchoverConfig { enabled: boolean; leadHours: number; holdDays: number; confirmHours: number; restoreJobs: number }`, `switchoverConfigOf(cfg)`, `AppsConfig.switchover`.

- [ ] **Step 1: Failing tests.**

```ts
describe("switch-over config", () => {
  it("is off by default, with the plan's defaults", () => {
    expect(loadConfig({}).switchover).toStrictEqual({
      enabled: false, leadHours: 24, holdDays: 30, confirmHours: 72, restoreJobs: 4,
    });
  });
  it("reads the switch and the numbers", () => {
    const c = loadConfig({
      VETRA_APPS_SWITCHOVER: "on", VETRA_APPS_SWITCHOVER_LEAD_HOURS: "6",
      VETRA_APPS_SWITCHOVER_HOLD_DAYS: "45", VETRA_APPS_SWITCHOVER_CONFIRM_HOURS: "48",
      VETRA_APPS_SWITCHOVER_RESTORE_JOBS: "2",
    }).switchover;
    expect(c).toStrictEqual({ enabled: true, leadHours: 6, holdDays: 45, confirmHours: 48, restoreJobs: 2 });
  });
  it("refuses a bad switch value and non-positive numbers", () => {
    expect(() => loadConfig({ VETRA_APPS_SWITCHOVER: "maybe" })).toThrow(/VETRA_APPS_SWITCHOVER/);
    expect(() => loadConfig({ VETRA_APPS_SWITCHOVER_HOLD_DAYS: "0" })).toThrow(/HOLD_DAYS/);
  });
  it("is off whenever plans are off", () => {
    expect(switchoverConfigOf(loadConfig({ VETRA_APPS_SWITCHOVER: "on" })).enabled).toBe(false);
  });
});
```

Use the file's existing `loadConfig` helper name (the one plan 1's plans tests use).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** next to `PlansConfig`, reusing its on/off parser and a positive-integer parser; `switchoverConfigOf(cfg)` returns `enabled: cfg.switchover.enabled && planInstancesEnabled(cfg)`. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(switchover): VETRA_APPS_SWITCHOVER config (default off)`.

---

### Task 2: Holds table and repo

**Files:** Modify `subgraphs/vetra-apps/db/schema.ts`, `db/migrations.ts`. Create `subgraphs/vetra-apps/holds/repo.ts`. Test `__tests__/holds.test.ts`, `__tests__/migrations.test.ts`.

**Interfaces:** Produces `EnvironmentHoldsTable { environment_id; reason; switchover_id: string | null; created_by; created_at }`; `insertHold(db, row)` (on conflict do nothing, returns the stored row), `deleteHold(db, environmentId): Promise<boolean>`, `getHold(db, environmentId)`.

- [ ] **Step 1: Failing tests:** insert twice keeps the first row; delete returns true then false; `migrations.test.ts` asserts the table exists after `up` twice (idempotent).
- [ ] **Step 2-4:** `ensureEnvironmentHoldsTable` in the schema builder (`withSchema`, `ifNotExists`, `isConcurrentIndexError` guard), appended to `up`. Run → PASS.
- [ ] **Step 5: Commit** `feat(model): environment_holds (an environment kept with its data, its app not running)`.

---

### Task 3: The processor renders a held environment

**Files:** Modify `processors/vetra-cloud-environment/app-image-project.ts` (type), `gitops.ts`, `processor.ts`, `factory.ts`. Test `processors/vetra-cloud-environment/held.test.ts` (new; reuse the helpers of `fusion.test.ts`: `render`, `hostState`, `appBlock`).

**Interfaces:** Produces `HoldLookup = (documentId: string) => Promise<boolean>`; `generateFusionBlock(…, { …, held?: boolean })`; `syncEnvironment(…, isWarm, isHeld)`.

- [ ] **Step 1: Failing tests.**

```ts
describe("a held environment", () => {
  it("keeps its database, backups and /data, and runs no app", async () => {
    const yaml = await render(hostState([]), { held: true });
    expect(appBlock(yaml)).toContain("  enabled: true");
    expect(appBlock(yaml)).toContain("  replicaCount: 0");
    expect(appBlock(yaml)).toMatch(/  ingress:\n    enabled: false/);
    expect(appBlock(yaml)).toContain("  persistence:\n    enabled: true");
    expect(yaml).toContain("  disabled: false");
    expect(yaml).toMatch(/database:\n  cnpg:\n    enabled: true/);
    expect(yaml).toMatch(/    backup:\n      enabled: true/);
  });
  it("is the normal render without a hold", async () => {
    const yaml = await render(hostState([]), { held: false });
    expect(appBlock(yaml)).toContain("  replicaCount: 1");
    expect(appBlock(yaml)).toMatch(/  ingress:\n    enabled: true/);
  });
  it("a held STOPPED environment is still disabled (a hold never wakes)", async () => {
    const yaml = await render(hostState([], { status: "STOPPED" }), { held: true });
    expect(yaml).toContain("  disabled: true");
  });
});
```

Extend the test helper `render(state, opts)` to pass an `isHeld` lookup that answers `opts.held`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
  - In `generateFusionBlock`: `replicaCount: ${opts.held ? 0 : 1}`; `ingress.enabled: ${!opts.held}` (closed-warm stays as is when not held).
  - In the tenant render (around the warm lookup, line ~1520): `const held = isHeld ? await lookupHeld(isHeld, documentId) : false;` where `lookupHeld` treats an undefined table (`42P01`) as false, like `lookupWarm`.
  - `processor.ts`: a held render must follow every hold change. Holds change only through `holds/service.ts` (Task 4), which writes a re-render operation pair; nothing else is needed here.
  - `factory.ts`: `const isHeld = (id: string) => appsDb.selectFrom("environment_holds").select("environment_id").where("environment_id", "=", id).executeTakeFirst().then(Boolean);` with the vetra-apps database the factory already reads for `resolveAppImageProject`.
- [ ] **Step 4: Run** the new file and `fusion.test.ts`, `gitops.test.ts` (golden files unchanged without a hold) → PASS.
- [ ] **Step 5: Commit** `feat(processor): render a held environment (no app pod, no ingress; database and /data kept)`.

---

### Task 4: Hold service

**Files:** Create `subgraphs/vetra-apps/holds/service.ts`. Test `__tests__/holds.test.ts`.

**Interfaces:**
- Consumes: `insertHold`, `deleteHold` (Task 2); `deps.envs.execute(id, actions)` (system-signed, as the reconciler and licensing use it); `setLabel`, `approveChanges` creators.
- Produces: `holdEnvironment(deps, { environmentId, reason, switchoverId, by })`, `releaseHold(deps, environmentId)`, `isHeld(deps, environmentId)`, `appPodGone(deps, tenant): Promise<boolean>` (no pod with `app.kubernetes.io/component=app` in the namespace; reads through the existing cluster client used by `instances/cluster.ts`).

- [ ] **Step 1: Failing tests** (harness `h.envs` fake records executed actions):
  - `holdEnvironment` inserts the row, then executes `[setLabel({ label: <unchanged> }), approveChanges({})]` once; a second call executes nothing.
  - `releaseHold` deletes the row and executes the same pair once; without a row it executes nothing.
  - the re-render pair is sent for a licensed environment too (managedBy set): these are system-signed and change no field.
- [ ] **Step 2-4:** implement; the label is read from the current state (`deps.envs.getState`). Run → PASS.
- [ ] **Step 5: Commit** `feat(switchover): hold and release an environment (re-rendered at once)`.

---

### Task 5: Plan instances stop by hold, not sleep (fix of slice 1; S2)

**Files:** Modify `subgraphs/vetra-apps/instances/reconciler.ts` (the stop branch at line ~300-320 and the wake at line ~792). Test `__tests__/instances-plan-stop-hold.test.ts` (new); adjust the stop/wake expectations in `__tests__/instances-plans.test.ts`.

**Interfaces:** Produces: an own or shared instance with `stop_reason` set gets a hold (`reason = stop_reason`) and status `stopped`; clearing `stop_reason` releases the hold. Branch and preview instances keep sleeping (slim profile, no kept data by design).

- [ ] **Step 1: Failing tests.**
  - An own instance whose licence ended past `stopAfterDays`: the reconciler inserts a hold, executes no `SLEEP_ENVIRONMENT`, and the row is `stopped` once `appPodGone` answers true.
  - Renewed: the hold is released, no `WAKE_ENVIRONMENT`, status goes back through `updating` to `ready`.
  - A branch instance still sleeps (`SLEEP_ENVIRONMENT` executed).
  - An instance whose document is already `STOPPED` (stopped by an earlier version of this code) is woken as before (its database is gone either way; the wake re-creates an empty one and the reason says `"stopped by sleep before holds existed: the database was re-created empty"` in the audit).
- [ ] **Step 2-4:** implement with `holdEnvironment`/`releaseHold` for `isPlanKind(row.kind)`. Run → PASS, then the whole `instances-*` suite.
- [ ] **Step 5: Commit** `fix(instances): stop plan instances by hold; sleeping a database-backed environment deletes its database`. Open this PR first (Tasks 1-5), staging pin, then continue.

---

### Task 6: Freeze Sektar's gated releases

**Files:** Modify `subgraphs/vetra-licensing/db/schema.ts`, `db/migrations.ts`, `rollout-db.ts` (`settings()` returns `frozenReason`), `release-service.ts`, `release-tracker.ts`, `subgraphs/vetra-apps/releases/licensed-host.ts`. Test `subgraphs/vetra-licensing/__tests__/freeze.test.ts` (new), `subgraphs/vetra-apps/__tests__/licensed-host.test.ts`.

**Interfaces:** Produces `freezeAppReleases(deps, appId, reason, by)`, `unfreezeAppReleases(deps, appId, by)`; `ReleaseSettings.frozenReason: string | null`; error text `releases of this app are frozen: <reason>`.

- [ ] **Step 1: Failing tests:** with a frozen App, `promoteRelease`, `resumeRollout`, `forceEnvironmentUpdate`, `requestUpdateNow` throw `OperationRejectedError` naming the reason; `trackReleases` starts no PENDING update of that App (another App's still applies); `recordLicensedHost` writes no artifact op for that App; unfreeze restores all of them. Freezing twice keeps the first `frozen_at`.
- [ ] **Step 2-4:** add the two nullable columns (`ensure…`); check `settings.frozenReason` at the top of each mutation inside `withAppRelease`; filter frozen apps in the tracker's app loop; `recordLicensedHost` reads the licensing settings through `deps.licensingDb` (`app_release_settings.frozen_reason`). Run → PASS.
- [ ] **Step 5: Commit** `feat(licensing): freeze an App's gated releases (switch-over)`.

---

### Task 7: Switch-over tables, instance and licensing columns, audit actions

**Files:** Modify `subgraphs/vetra-apps/db/schema.ts`, `db/migrations.ts`, `audit/repo.ts`, licensing `db/schema.ts`, `db/migrations.ts`. Create `subgraphs/vetra-apps/switchover/repo.ts`. Test `__tests__/migrations.test.ts`, `__tests__/switchover-machine.test.ts` (repo part).

**Interfaces:** Produces `SwitchoversTable` (columns in "Model"), `SwitchoverState`, `SwitchoverMode`; `insertSwitchover`, `getSwitchover`, `listSwitchovers(db, appId)`, `openSwitchoverOfEnvironment`, `updateSwitchover(db, id, patch, nowIso, expectState)` — a compare-and-set on `state` (0 rows updated → `SwitchoverRaceError`), so two runners never both advance one row; `hasOpenSwitchover(db, planId)` (for slice 3). `instances.switchover_id`; licensing `license_environments.switched_over_at`, `switched_over_instance_id`. Audit actions `switchover.planned`, `switchover.state`, `switchover.failed`, `switchover.linked`, `switchover.confirmed`, `switchover.rolled_back`, `switchover.kind_adopted`, `releases.frozen`, `releases.unfrozen`.

- [ ] **Steps 1-4:** tests for the compare-and-set, the partial unique index (a second `real` switch-over of one environment fails unless the first is `ROLLED_BACK`), the migrations being idempotent. Implement.
- [ ] **Step 5: Commit** `feat(switchover): switchovers table, switched_over_at, audit actions`.

---

### Task 8: Licensing and plan sync honour switched-over rows

**Files:** Modify `subgraphs/vetra-licensing/environments.ts` (`createChainEnvironmentRows`: `live*` variants), `handler.ts`, `offboarding.ts`, `managed-by.ts`, `release-tracker.ts`, `update-gate.ts`, `reporting.ts`, `plan-kinds.ts`, `publisher-resolvers.ts`, `subscriptions-resolvers.ts`; `subgraphs/vetra-apps/plans/holders.ts`, `plans/sync.ts`, `instances/reconciler.ts`. Test `subgraphs/vetra-licensing/__tests__/switched-over.test.ts` (new), `subgraphs/vetra-apps/__tests__/plans-holders.test.ts`, `instances-plans.test.ts`.

**Interfaces:** A row with `switched_over_at` set is **not** live for licensing: the handler neither provisions nor stages its chain (the chain goes to `leaveToInstances`), offboarding never marks, stops or destroys it, the tracker and update gate never update it, `managedBy` sync leaves the document, the reporting token is kept (harmless) and not re-issued. It **stays visible** to: `app-image-project.ts` (vouching, F7), the publisher Holders view (shown as "moved to own instance", with the instance id), and the holder's subscription (Task 16). vetra-apps: `licensedRoots` excludes switched-over rows; the reconciler leaves a row with `switchover_id` set to the switch-over (no create/start/stop decisions of its own except creating the document with `start: false` when asked, see Task 13).

- [ ] **Step 1: Failing tests** (one per bullet above), including: an ended licence of a switched-over chain makes the **own instance** stop after `stopAfterDays` (by hold, Task 5), and offboarding does **nothing** to the old environment; the processor's resolver still vouches the old environment's project.
- [ ] **Step 2-4:** add `switched_over_at IS NULL` to every licensing read that decides an action (list the call sites with `grep -n "license_environments\|chainRows\.\|rows\.for" subgraphs/vetra-licensing/*.ts | grep -v test`), keeping `byEnvironment` unfiltered for display and vouching. Run → PASS; then the full licensing suite.
- [ ] **Step 5: Commit** `feat(licensing): a switched-over environment is the instances model's`.

---

### Task 9: `adoptLicensedKind`

**Files:** Modify `subgraphs/vetra-apps/plans/service.ts`. Test `__tests__/plans-adopt.test.ts` (new).

**Interfaces:** Produces `adoptLicensedKind(deps, caller, { appId, kind, slug, name, size, targetVersion })` → `PlanRow` (`access: "own"`). Admin only. Refuses: a non-admin; a kind whose term is not DEDICATED; a kind already adopted; `targetVersion` not a stable release of the App. Unlike `createPlan`, it accepts an App with licensed environments and a kind with live licences. Audit `switchover.kind_adopted` + `plan.created`.

- [ ] **Steps 1-4:** tests for each refusal; after adoption, `syncPlanInstances` creates an own instance for a live chain **without** a licensed environment and none for chains with one (rule 1). Implement by sharing `createPlan`'s insert path behind a `{ allowLicensed: true }` flag that only this function passes.
- [ ] **Step 5: Commit** `feat(plans): adoptLicensedKind (admin; plans for kinds with licensed environments)`.

---

### Task 10: Eligibility checks (pure)

**Files:** Create `subgraphs/vetra-apps/switchover/checks.ts`. Test `__tests__/switchover-checks.test.ts`.

**Interfaces:** Produces `checkSwitchover(input: SwitchoverFacts): string[]` (empty = eligible; each entry a reason shown in the console) and `gatherSwitchoverFacts(deps, environmentId)`.

```ts
export interface SwitchoverFacts {
  row: { appId: string; endedAt: string | null; switchedOverAt: string | null; rootLicenseId: string; templateId: string } | null;
  env: { status: string; owner: string | null; customDomain: string | null; fusionEnvNames: string[]; admins: string[]; fusionHost: boolean } | null;
  template: { mode: "SHARED" | "DEDICATED" } | null;
  appHasSharedTerm: boolean;
  gateActive: boolean;               // slice 5; false until it exists
  chainLive: boolean; holder: string | null; kind: string | null;
  plan: { id: string; access: "own" | "shared"; status: string; targetVersion: string | null } | null;
  release: { version: string; digest: string | null; kind: string } | null;
  openSwitchoverOnApp: boolean;      // another real one past PREPARED
  frozen: boolean;
  switches: { instances: boolean; plans: boolean; rollouts: boolean; healthEnforce: boolean };
}
```

Reasons (one test each): no licensed row; already switched over; licence ended; environment not READY; not a FUSION host; template not DEDICATED; holder not the only admin or not the owner; custom domain set (slice 7 needed); FUSION env beyond `ADMINS`/`PH_HOST` (slice 7 needed); App has a SHARED term and the gate is not active (slice 5 needed); no own plan for the kind; plan retired; target is not a stable release or has no digest; another switch-over of the App is running; releases not frozen (real runs only); a switch it needs is off.

- [ ] **Steps 1-5:** tests first, implement, commit `feat(switchover): eligibility checks`.

---

### Task 11: The state machine (pure)

**Files:** Create `subgraphs/vetra-apps/switchover/machine.ts`. Test `__tests__/switchover-machine.test.ts`.

**Interfaces:** Produces `SWITCHOVER_STATES`, `STEP_TIMEOUT_MS: Record<SwitchoverState, number | null>`, and

```ts
export type Observation =
  | { kind: "wait" }                        // nothing to do yet
  | { kind: "advance"; patch?: Partial<SwitchoverRow> }
  | { kind: "fail"; error: string };
export function nextState(row: SwitchoverRow, obs: Observation, nowIso: string): { state: SwitchoverState; patch: Partial<SwitchoverRow> } | null;
export function timedOut(row: SwitchoverRow, nowMs: number): boolean;
export function canRollBack(row: SwitchoverRow, nowMs: number, confirmHours: number): { ok: boolean; losesWrites: boolean; reason: string | null };
```

- [ ] **Step 1: Failing tests:** the table in "Model" row by row (real and dry-run successors); `fail` moves to `FAILED` with `failed_state`; a timeout is a `fail` with `"<state> timed out after <n> min"`; `resume` returns to `failed_state` with `attempts + 1`, `step_started_at` reset; `canRollBack` per the "Rollback by state" rule (lossless before `STARTING`, `losesWrites` from `STARTING` until confirmed or `confirmHours` after `started_at`, refused in `DONE`, `CLEANED`, `ROLLED_BACK`).
- [ ] **Steps 2-5:** implement as a transition map; commit `feat(switchover): state machine`.

---

### Task 12: Backups adapter and the count job

**Files:** Create `subgraphs/vetra-apps/switchover/backups.ts`, `switchover/counts-job.ts`; `__tests__/fakes/backups.ts`. Test `__tests__/switchover-steps.test.ts` (counts part).

**Interfaces:**
- Produces `createSwitchoverBackups(deps): SwitchoverBackups` over slice 4 (Task 0 Step 1), keys `switchover/<switchoverId>/db.dump` and `switchover/<switchoverId>/data.tar.zst`; a fake with controllable job states for tests.
- Produces `buildCountsJob({ tenantNs, image, runId }): V1Job` (same image, pod settings and DB credentials as `buildDumpJob`, connects to `<ns>-pg-rw`, `backoffLimit: 0`, `activeDeadlineSeconds: 900`, labels `vetra.io/kind=switchover-counts`, `vetra.io/run-id`) and `parseCounts(log: string): Counts` (the last line, JSON; anything else is a failure).

```sql
-- the job's script (psql -X -At); prints one JSON line
with t as (select table_schema from information_schema.tables where table_name = 'secret_key_check' limit 1)
select json_build_object(
  'documentsByType', (select coalesce(json_object_agg(t, n), '{}') from (select "documentType" t, count(*) n from reactor."DocumentSnapshot" where scope = 'global' and not "isDeleted" group by 1) d),
  'operations', (select count(*) from reactor."Operation"),
  'attachments', (select count(*) from attachments.attachment),
  'workflowSecrets', <count of <schema>.secret via a DO block or \gexec, 0 when t is empty>,
  'keyCheck', <fingerprint of <schema>.secret_key_check, null when t is empty>
);
```

Write the script with `\gexec` (or a small `DO` block writing to a temp table) so the hashed schema is resolved at run time; test it against PGlite with and without the workflow tables.
- [ ] **Steps 1-5:** tests for `parseCounts` (good line, garbage, empty), the job manifest (namespace, labels, no secrets in plain env other than what `buildDumpJob` already passes), and the script on PGlite. Commit `feat(switchover): backups adapter and count job`.

---

### Task 13: Steps and the runner

**Files:** Create `subgraphs/vetra-apps/switchover/steps.ts`, `switchover/runner.ts`. Modify `subgraphs/vetra-apps/index.ts` (`every(15_000, "switch-over runner", …)` when `switchoverConfigOf(cfg).enabled`). Test `__tests__/switchover-steps.test.ts`, `__tests__/switchover-runner.test.ts`.

**Interfaces:**
- Produces `STEPS: Record<SwitchoverState, (deps, row) => Promise<Observation>>` and `advanceSwitchoversOnce(deps)`: for each open row (state not terminal), at most one step; `timedOut` first; then the step; then `nextState` + `updateSwitchover(…, expectState)`; audit `switchover.state` on each change and `switchover.failed` on failure. Errors thrown by a step become `fail` with the message cut at 500 characters and passed through the existing secret redaction.
- Consumes: Tasks 2-4 (holds), 7 (repo), 8 (row flags), 10 (checks, re-run at `PREPARING` and `HOLDING_OLD`: anything new refuses), 12 (backups, counts), slice 1 (instances, reconciler), slice 3 (`instanceReady`), `deps.instanceSecrets` (`setSecrets`, `listSecretKeys`), a new read `secretFingerprint(tenant, key)` on the secrets service (sha256 of the stored value, computed server-side, value never returned).

Step details (each starts by reading what already exists):
- `PREPARING`: (a) keys — if `key_fingerprints` is null: `startArchive({ tenant: old, pvc: "powerhouse-<old>-app-data", key, sameNodeAs: <the old app pod> })` once (`prepare_archive_id`), wait READY, `readArchiveFiles(id, ["workflows-master-key", "attachment-url-signing-secret"])`, both 64 hex chars or `fail("the old environment has no kept keys")`, store fingerprints; values stay in memory. (b) instance — if no `instances` row with this `switchover_id`: insert `{ kind: "own", plan_id, holder_address, licence_root_id, host: old_host (dry run: "rehearsal-" + id.slice(0, 8)), switchover_id, target_* = pinned release, status: "pending" }`. The reconciler creates the document with `start: false` (existing path; preset `host` is kept by `claimHost`). (c) hold — once `environment_id` is set: `holdEnvironment(new env)` before anything sets the version. (d) keys into the tenant — `setSecrets(newTenant, [{ PH_WORKFLOWS_SECRETS_MASTER_KEY }, { PH_ATTACHMENT_URL_SIGNING_SECRET }])` (re-read the archive if the process restarted and the values are no longer in memory), then `secretFingerprint` must equal `key_fingerprints`. (e) start under hold — the reconciler's start (setting the FUSION version) is allowed for a `switchover_id` row only when the hold exists and the keys match (a guard in the reconciler); it then renders database + `/data`. Advance when CNPG `Ready` and the PVC `Bound` (read through `instances/cluster.ts`).
- `HOLDING_OLD`: re-run `checkSwitchover` (real); `holdEnvironment(old)`; advance when `appPodGone(old)`; set `downtime_started_at`.
- `BACKING_UP`: `startDump` and `startArchive` once each (real: no `sameNodeAs`, the old pod is gone), a count job on the old tenant; advance when all three are READY; `timings.backup`.
- `RESTORING`: `startRestoreDump({ mode: "fresh", jobs: cfg.restoreJobs })` and `startRestoreArchive` once each; advance when both READY.
- `CHECKING_COPY`: count job on the new tenant; `copy_counts` must deep-equal `source_counts`; archive manifest sha256 of the restore equals the archive's; key fingerprints unchanged; else `fail` naming the first difference (by field, no values).
- `STARTING`: `releaseHold(new)`; advance at once.
- `VERIFYING`: `instanceReady(new)` with the pinned digest; then a count job → `started_counts`: `documentsByType`, `workflowSecrets`, `attachments`, `keyCheck` equal to `source_counts` (operations may grow through migrations); `GET https://<host>/` answers 200 with Connect's page; set `started_at` at the first ready.
- `LINKING`: one licensing transaction + one vetra-apps transaction (in this order; the step is idempotent: both set "if null").
- `AWAITING_CONFIRMATION`: advance when `confirmed_at` is set or `now - started_at ≥ confirmHours`.
- `DONE`: sets `done_at`, `hold_until`; audit.

- [ ] **Step 1: Failing tests** with the fake backups and the harness's fake cluster: a full real run reaches `DONE` in passes, with the expected order of side effects (assert the recorded calls); every step run twice in a row produces the same calls once (idempotence); a crash between "job started" and "row updated" (simulate by throwing after `startDump`) re-uses the existing job on the next pass; the reconciler never sets the version of a `switchover_id` instance without a hold and matching keys; one App never has two real switch-overs past `PREPARED` (the second waits in `PREPARED`); a count mismatch fails in `CHECKING_COPY` and the new instance is still held (never started on half a copy).
- [ ] **Steps 2-4:** implement; run → PASS.
- [ ] **Step 5: Commit** `feat(switchover): steps and a resumable runner`.

---

### Task 14: Roll back

**Files:** Create `subgraphs/vetra-apps/switchover/rollback.ts`. Test `__tests__/switchover-rollback.test.ts`.

**Interfaces:** Produces `rollBackSwitchover(deps, caller, id, { acceptDataLoss })` → row. Uses `canRollBack`; refuses `losesWrites` without `acceptDataLoss: true`. Then `ROLLING_BACK` steps: hold the new instance (if any); clear `license_environments.switched_over_at`/`switched_over_instance_id`; set the instance's `stop_reason = "switch-over rolled back"` (it stays held, data kept, never deleted here); release the old environment's hold; advance when the old app is ready (document READY and the app pod Running and Ready); unfreeze is **not** automatic (the campaign decides).

- [ ] **Steps 1-5:** tests from each state class (before `HOLDING_OLD`, during the window, after `STARTING` with and without `acceptDataLoss`, `DONE` refused); the plan sync does not re-create an instance for the chain while its licensed row is live again (rule 1). Commit `feat(switchover): roll back to the old environment`.

---

### Task 15: Dry run (production rehearsal clone)

**Files:** Modify `switchover/steps.ts`, `switchover/service.ts`. Test `__tests__/switchover-steps.test.ts`.

**Interfaces:** Produces `dryRunSwitchover(deps, caller, environmentId)` → row (`mode: "dry_run"`). Differences from a real run: no freeze needed and none set; the old environment is never held (the `/data` archive runs beside its pod, read-only; the dump is a consistent snapshot of the running database); the clone's instance has `holder_address = null`, `ADMINS` = nobody (the reconciler renders an empty admin list for `rehearsal-` rows), its ingress stays closed (`warm`-style closed render: it is held until `STARTING`, then the hold is replaced by a closed-ingress flag so health can run in-cluster); `VERIFYING` uses the in-cluster service URL; `CLEANING` deletes the clone's document and instance row and its data PVC (spec 14.12); the dump and archive stay under `switchover/<id>/` like a real run's (180 days, S13). `timings` hold each step's seconds; the console shows the expected downtime = backup + restore + checks + start.

- [ ] **Steps 1-5:** tests: a dry run never writes a hold on the old environment and never sets `switched_over_at`; the clone is removed in `CLEANING`; a failure leaves the clone held for inspection until `cleanUpDryRun(id)`. Commit `feat(switchover): dry runs on a throwaway clone`.

---

### Task 16: Holder notices and confirmation

**Files:** Modify `subgraphs/vetra-licensing/offboarding.ts` (`SubscriptionWarning.kind` gains `SWITCHOVER_SCHEDULED`, `SWITCHED_OVER`), `subscriptions-resolvers.ts`; `subgraphs/vetra-apps/plans/holder-view.ts` (`myInstances` gains `switchover { id, state, confirmBy }`). Test `subgraphs/vetra-licensing/__tests__/offboarding.test.ts`, `__tests__/plans-holder-view.test.ts`, `__tests__/switchover-api.test.ts`.

**Interfaces:**
- `SWITCHOVER_SCHEDULED` (from `PLANNED` until `HOLDING_OLD`): "Your Sektar moves to its own instance on <date> between <start> and <end> (UTC). It will be unavailable for up to <minutes> minutes. Its address stays the same."
- `SWITCHED_OVER` (from `LINKING` until `DONE` + 7 days): "Your Sektar now runs as its own instance. Please sign in and check it." with `confirmSwitchover`.
- `confirmSwitchover(id)`: only the switch-over's `holder_address`; sets `confirmed_at`; audit `switchover.confirmed`.
- Email: none (D5); the user announces windows to holders through Sektar's own channel as well (runbook).

- [ ] **Steps 1-5:** tests; commit `feat(switchover): holder notices and confirmation`.

---

### Task 17: GraphQL, wiring, full checks, PR

**Files:** Modify `subgraphs/vetra-apps/schema.ts`, `resolvers.ts`, `index.ts`; create `switchover/service.ts`. Test `__tests__/switchover-api.test.ts`, `resolvers.test.ts` (SDL coverage).

```graphql
type Switchover {
  id: ID!  appId: ID!  environmentId: ID!  oldHost: String!  kind: String!  planId: ID!  instanceId: ID
  mode: String!  state: String!  failedState: String  error: String
  windowStart: String  windowEnd: String  releaseVersion: String!
  sourceCounts: String  copyCounts: String  startedCounts: String  timings: String
  downtimeStartedAt: String  startedAt: String  confirmedAt: String  doneAt: String  holdUntil: String
  canRollBack: Boolean!  rollBackLosesWrites: Boolean!
}
extend type Query {
  "Platform admins."
  switchovers(appId: ID!): [Switchover!]!
  "Platform admins: why an environment cannot be switched over (empty: it can)."
  switchoverChecks(environmentId: ID!): [String!]!
}
extend type Mutation {
  adoptLicensedKind(appId: ID!, kind: String!, slug: String!, name: String!, size: String!, targetVersion: String!): AppPlan!
  freezeAppReleases(appId: ID!, reason: String!): Boolean!
  unfreezeAppReleases(appId: ID!): Boolean!
  planSwitchover(environmentId: ID!, windowStart: String!, windowEnd: String!): Switchover!
  dryRunSwitchover(environmentId: ID!): Switchover!
  resumeSwitchover(id: ID!): Switchover!
  rollBackSwitchover(id: ID!, acceptDataLoss: Boolean): Switchover!
  cleanUpDryRun(id: ID!): Switchover!
  "The holder of that switch-over."
  confirmSwitchover(id: ID!): Switchover!
}
```

Counts are shown to platform admins only (they are counts per document type, no content). `planSwitchover` refuses a window that starts less than 72 h from now (D11), overlapping windows of one App, and anything `checkSwitchover` refuses (except "not frozen", which is checked at `HOLDING_OLD`).
- [ ] **Steps 1-4:** API tests (admin vs owner vs holder vs stranger; each refusal), SDL coverage, wiring of the runner behind the switch. Full checks (Global Constraints).
- [ ] **Step 5: Commit** `feat(switchover): admin API`. Push, open the PR (`feat(apps): Sektar switch-over (releases phase 3, slice 9)`), body: what it does, F1-F8, the decisions, the test plan, `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

---

### Task 18: Staging rehearsal (needs the user; no code)

Staging has no licensed environment, so the rehearsal builds the old model first, with Sektar's real code, then moves it.

- [ ] **Step 1: The rehearsal App.** Fork `powerhouse-inc/sektar` to `powerhouse-inc/sektar-rehearsal` (private) and connect it on **staging first** (Renown binds a repository to the first platform it is connected to). Workflow `vetra-publish@v1` with `vetra-url: https://switchboard.staging.vetra.io`. Set its release policy GATED (no canary: nothing moves by itself).
- [ ] **Step 2: Two releases.** Release `1.0.9` from the commit of production's `sha-d5a6f74abbf3` (the old Powerhouse; the bridge records it as the `host` FUSION artifact), and later `1.1.0` from current `main` (the target, like S6). Check `releases.powerhouse_version` differs as in production.
- [ ] **Step 3: The old model.** On the App document: one DEDICATED template (FUSION `host`, LATEST, `VETRA_AGENT_M`, warm pool 0), terms `sektar-cloud` and `sektar-cloud-1y` (365 days), issuer `PUBLISHER_GRANT`. Issue 5 grants to staging test addresses: **canary**, **fresh**, **small** (a few documents + 1 workflow connection with a secret), **large** (synthetic: ≥ 1 M operations, ≥ 2 GB database, written by a script through the environment's GraphQL as its holder; measures scaling) and **custom-domain** (a custom domain set, to see the refusal). Check each gets a licensed environment READY on `1.0.9`, with both key files on `/data` and a `secret_key_check` row where a secret exists.
- [ ] **Step 4: Switches.** Staging values: `VETRA_APPS_PLANS`, `VETRA_APPS_ROLLOUTS`, `VETRA_APPS_SWITCHOVER` on, `VETRA_APPS_INSTANCE_HEALTH: enforce`; the pin PR of this package.
- [ ] **Step 5: Adopt and freeze.** `adoptLicensedKind` × 2 on `1.1.0`; `freezeAppReleases`. A sixth grant now gets an own instance, not a licensed environment.
- [ ] **Step 6: Dry runs** of all four eligible environments; `switchoverChecks` of the custom-domain one names "custom domain set". Record `timings`; the large one's restore time per GB is the factor for production's estimate.
- [ ] **Step 7: Real runs**, canary first: plan with a window 72 h+ ahead (staging may use a lowered `planSwitchover` minimum only through an admin override flag that defaults off: decide in review), run, verify, check: same `https://<label>.vetra.io`; the holder signs in without a new login prompt being needed beyond Renown's; documents, attachments and the workflow connection work (the connection's secret decrypts); the old environment is held (no pod, database Ready, PVC Bound); licensing offboarding ignores it after the licence is revoked.
- [ ] **Step 8: Failure drill (second pass).** For each step: inject a failure (delete the job, wrong S3 key, kill the switchboard pod mid-step, make `instanceReady` fail with a bad digest, make counts differ by deleting a document in the copy before `CHECKING_COPY`), see `FAILED` with a clear error, `resumeSwitchover` finishes it, and `rollBackSwitchover` from `CHECKING_COPY` and from `VERIFYING` brings the old environment back with its data. Check the runner survives a switchboard restart in every state.
- [ ] **Step 9: Report** the timings and anything unexpected in the PR; adjust step timeouts.

---

### Task 19: Production runbook (needs the user; no code)

- [ ] **Step 1: Preconditions.** The v1.0.9 rollout `144e284e-…` is COMPLETE (due 2026-11-13 18:41 UTC); slices 3 and 4 and this plan are pinned in production; Task 5's fix is live; `VETRA_APPS_INSTANCES`, `VETRA_APPS_PLANS`, `VETRA_APPS_ROLLOUTS` on and health `enforce` (D10); Sektar's stable release (S6) is recorded and ran on the staging rehearsal; S14 told to the user.
- [ ] **Step 2: Canary environment.** The user (or the team) redeems a `sektar-cloud` invite code **before** adoption and fills the environment like staging's "small" holder. This replaces fast-lion (F3).
- [ ] **Step 3: Adopt and freeze.** `adoptLicensedKind` for `sektar-cloud` (`cloud`) and `sektar-cloud-1y` (`cloud-1y`) on the stable release; `freezeAppReleases(appId, "switch-over")`.
- [ ] **Step 4: Dry runs** of all 12 environments (no downtime). Expected order of magnitude: fresh and small ones minutes; the four large ones dominated by the restore of 5.8-7.6 GB. Each window = measured downtime × 1.5, rounded up to 15 minutes. A dry run that fails stops the campaign for that environment until understood.
- [ ] **Step 5: Announce.** `planSwitchover` per environment with a window ≥ 72 h ahead (the banner appears); the user also tells holders through Sektar's own channel (no email in Vetra, D5).
- [ ] **Step 6: Canary.** Run, verify, confirm as its holder; let it run 24 h with real use (a workflow run, an attachment download).
- [ ] **Step 7: The rest, one at a time** (S5 order). After each: `switchovers(appId)` shows `AWAITING_CONFIRMATION`; the old environment is held. Large ones at most one per day.
- [ ] **Step 8: After the last.** `unfreezeAppReleases` is not needed for the old model any more (no live licensed environment remains); leave it frozen until slice 10. Set the template's `warmPoolSize` to 0. Record `hold_until` dates; after 30 days the user decides on deleting the old environments (overview rule 5; slice 10).

---

### Task 20: Console follow-up (vetra.to; separate PR after staging works; no code here)

- Publisher, App page → **Switch-over** tab (platform admins only): environments with `switchoverChecks` reasons, "Dry run", "Plan window", live state per row (state, timings, counts, error), "Resume", "Roll back" (with the data-loss warning when `rollBackLosesWrites`), freeze banner.
- Publisher Holders tab (`modules/publisher/components/holders/*`): a switched-over environment shows "moved to own instance" and links the instance.
- Holder (`modules/subscriptions`): the two new banners; "Looks right" calls `confirmSwitchover`; after `LINKING` the subscription links to "My instances".
- Generated types regen for the new queries.

---

## Self-review

- **Spec 13 coverage:** freeze (Task 6), dump + `/data` stored with holder and licence (Tasks 12-13, `switchovers` row), first vetra-publish release (S6, runbook), own instance created and restored, holder told, custom domain moved (none exist; refused until slice 7, F6), old environment kept 30 days (held, not stopped: F1), shared access (none: F2).
- **Overview slice 9 deltas:** "stop (sleep)" → hold (F1); "fast-lion first" → a new team canary (F3); D12 → nothing to create (F2); "adopt only when all are in progress" → adopt first (S7); keys before first start kept and verified by fingerprint (gap 9); counts and checksums (step 5 of the overview) → count job + archive manifest; `switched_over_at` and the instance link (step 6) → Task 8 and `LINKING`.
- **Risk notes:** the four large databases make the windows long (dry runs size them; S8's physical copy is the later fix); a reactor migration on old data is proven by each environment's dry run before its window; a crash at any point resumes from the stored state; nothing deletes holder data; the old environment's image-project vouching stays (F7).
- **Open items for review:** the closed-ingress health of dry-run clones (Task 15) depends on whether `instanceReady` can probe in-cluster (slice 3); the reconciler guard for `switchover_id` rows (Task 13 (e)) must be the only path that sets their version.
