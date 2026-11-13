# Releases phase 3, plan 4: backups and restore-based rollback — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- Before a rollout step moves a shared or own instance, Vetra backs up the instance's database **and `/data`**, and moves it only once both are stored.
- Rolling back a release that `migrates` restores, per instance, the backup taken before its update. Data written since is lost, so the API asks for `acceptDataLoss: true`. A failed update of such a release restores its backup by itself before the rollout pauses.
- Shared and own instances get a daily backup, kept 14 days. A publisher (or release manager) can back up an instance now and restore one of its backups.
- Stopping a plan instance no longer deletes its database (a gap found while planning this slice, decision B9).

**Architecture:**
- **Jobs stay in observability.** The database part is the existing dumps subsystem (`database_dumps`, `createDumpAndJob`, `buildRestoreJob`, the Job watcher), with two new sources `PRE_UPDATE` and `INSTANCE`. `/data` gets the same pattern: a table `data_archives`, an archive Job (`tar | zstd` of the app's data PVC to `s3://<dumps bucket>/<tenant>/data/<id>.tar.zst`) and a data-restore Job. Observability's Job watcher reconciles archive Jobs next to dump Jobs.
- **Orchestration lives in vetra-apps** (`subgraphs/vetra-apps/backups/`):
  - `instance_backups`: one dump plus one archive per backup, with a reason, the version the instance ran, and an expiry.
  - `instance_restores`: a step machine (safety backup → stop the app → restore the database → restore `/data` → hand the instance back → start), advanced inside the reconciler's per-App pass under `instances:<appId>`.
  - While a restore owns an instance, `instances.maintenance` is set and the reconciler leaves the instance alone.
- **Slice 3 calls a small contract** (`backups/rollout.ts`): `backupBeforeUpdate`, `backupProgress`, `restoreBackup`, `restoreProgress`, `backupsOn`. The runner gets two step statuses, `backing_up` and `restoring`.
- **Daily backups:** a 5-minute job (`backups/schedule.ts`), at most 3 running at once, with an age-based sweep that deletes S3 objects and rows.
- **Outside this repo** (needs the user):
  - the admission policy and RBAC in `powerhouse-k8s-hosting`, so the switchboard may run a Job that mounts an `*-app-data` PVC;
  - `pgdump-uploader:1.1.0` with GNU tar and zstd;
  - the chart flag `database.cnpg.keepWhenDisabled` (CNPG hibernation for stopped plan instances);
  - staging values;
  - a `migrates` feature in the staging canary app.

**Tech Stack:** TypeScript, Kysely (Postgres; PGlite in tests), vitest, `@kubernetes/client-node`, GraphQL (vetra-apps subgraph), Helm/Argo CD (hosting repo), POSIX sh in Job pods.

**Spec:** `docs/superpowers/specs/2026-11-11-app-releases-and-instances-design.md`:
- section 7, "A rollout" step 4: "Before each: a **backup** (database + `/data`)";
- section 7, "Rollback": "For a release that `migrates`, rolling back an instance restores the backup taken before its update (data written since is lost; the console says so before the click)";
- section 7, last paragraph: "Backups are also taken daily for shared and own instances (kept 14 days) and can be restored from the console";
- 14.5: holder data stays the holder's, and holders can download a backup (that download is slice 7; this slice gives it the backup machinery);
- 14.16: CNPG on-demand backups and volume snapshots. Replaced for now by decision D6, see below.

Slice scope: `docs/superpowers/plans/2026-11-12-releases-phase-3-overview.md`:
- slice 4;
- spec gap 5;
- **D6**: `pg_dump` plus `/data` archive jobs now, CNPG PITR and VolumeSnapshots later.

Conventions: `2026-11-12-releases-phase-3-plan-1-plans-and-plan-instances.md` and `…-plan-2-audit-and-release-managers.md`. Slice 3 as planned: `/home/froid/projects/vetra-cloud-package-phase3c/docs/superpowers/plans/2026-11-12-releases-phase-3-plan-3-rollouts.md` (commit `12f6eab`). This plan names its functions; see "Contract with slice 3".

## Decisions to confirm (recommended default first; the plan is written with the default)

- **B1 Where it lives.**
  - Jobs and their rows stay in observability: `database_dumps`, the new `data_archives`, and the one Job watcher.
  - vetra-apps owns `instance_backups`, `instance_restores` and the orchestration, which runs inside the reconciler's per-App pass.
  - Observability's owner-facing restore (`restoreEnvironmentDump`, which scales `component=switchboard`) is not used for instances. A host-image instance's Deployment is `app.kubernetes.io/component=app`, and plan-instance documents are owned by the Vetra service identity (overview D2), so that path refuses everyone on them anyway.
- **B2 Switch** `VETRA_APPS_BACKUPS` (default `off`).
  - `off`: exactly slice 3. Steps go straight to `applying`, a `migrates` rollback is refused, and there are no daily or pre-stop backups.
  - `on`: a step never moves an instance without a ready backup. When dumps are not configured (`VETRA_DUMPS_S3_*` missing) or the kube client fails, steps fail closed ("cannot back up the instance: backups are not configured") and pause the rollout.
- **B3 Backups are taken while the instance runs.** No downtime.
  - `pg_dump` is a consistent snapshot.
  - `/data` is read live from a read-only mount, on the app pod's node (required pod affinity, because the PVC is RWO Longhorn). GNU tar's "file changed as we read it" (exit 1) is accepted.
  - The dump and the archive start in the same second but are not one atomic snapshot.
  - *Alternative:* stop the app during the backup (consistent, but downtime on every step and every night).
- **B4 `/data` archive format.**
  - `tar --exclude=./lost+found -C /data -cf - . | zstd -3`, streamed to S3.
  - The sha256 of the stored object goes into `data_archives.sha256` (printed by the Job, read from its log by the watcher).
  - The restore Job checks the checksum **before** it deletes anything in `/data`.
  - Both Jobs run as uid/gid 1000 (the chart's `fsGroup` for the app) with `fsGroupChangePolicy: OnRootMismatch`.
  - Image: `pgdump-uploader:1.1.0` (1.0.0 plus GNU `tar` and `zstd`), set with `VETRA_DATA_ARCHIVE_IMAGE`. Dump Jobs keep `VETRA_DUMPS_IMAGE` (1.0.0), so existing dumps never depend on the new image.
- **B5 Security boundary (hosting PR, needs review).**
  - The admission policy `switchboard-tier-scoped-writes` today forbids any volume on switchboard Jobs.
  - It is relaxed to: at most one volume, a `persistentVolumeClaim` whose `claimName` ends with `-app-data`, mounted only at `/data` (no `subPath`). Every other rule stays.
  - RBAC gains `persistentvolumeclaims: get, list` (to find the PVC by label).
- **B6 Retention by age.**
  - `pre_update` 30 days, `daily` 14 days (`VETRA_APPS_BACKUP_DAILY_KEEP_DAYS`, 1-30), `manual` 30 days, `pre_restore` 7 days, `pre_stop` 30 days.
  - The dumps bucket's lifecycle (30 days, the existing `TTL_HOURS` ceiling) is the hard limit. A rollback or restore whose backup has expired is refused ("backup expired").
  - Slice 7's 180-day final backup needs another prefix or bucket (noted for slice 7).
- **B7 Daily backups.**
  - Every `ready`, not stopped, not in maintenance shared or own instance gets one every 24 h.
  - At most `VETRA_APPS_BACKUP_MAX_IN_FLIGHT` (3) backups of any reason run at once, cluster-wide. A failed daily backup is retried after 1 h.
  - CNPG's nightly backups to `powerhouse-cnpg-backups` (180 d) stay as they are.
- **B8 A failed update of a release that `migrates` restores its pre-update backup by itself.** The step becomes `restoring` and the rollout pauses with an alert. When the restore is done the step is `failed`, with the note "restored the backup from before the update", and the instance is back on `from_version` with its old data.
  - Reason: after the phase 2 revert, the old image runs on a migrated database, which is unknown ground.
  - *Alternative:* pause only, and let the publisher roll back.
- **B9 Stopping a plan instance must not delete its database.**
  - Found while planning: the chart's `postgres-cluster.yaml` is gated on `not global.disabled`, so `sleepEnvironment` (which slice 1's `stopPlanInstance` uses when a licence ends or a plan is retired) deletes the CNPG Cluster and, with it, its volumes. See the chart's own CAVEAT comment.
  - Fix [default]:
    - a chart flag `database.cnpg.keepWhenDisabled`, which keeps the Cluster with `cnpg.io/hibernation: "on"` while disabled;
    - the processor sets it for `app.role = PLAN` only (the ~57 stopped studios are unchanged);
    - before Vetra stops a plan instance, it takes a `pre_stop` backup.
  - This should reach staging before slice 1's stop/wake test is judged. The canary does not use its database, so that test cannot see the loss. It must be in production before `VETRA_APPS_PLANS` is ever on there.
  - *Alternative:* only the pre-stop backup, plus a restore on wake.
- **B10 Manual restore.**
  - Who: the publisher or a release manager (`need: "release"`).
  - Which backup: only one taken on the release the instance targets now. On a held instance (B12), any of its backups, and the target follows it.
  - Confirmation: `acceptDataLoss: true`.
  - Holders cannot restore in phase 3. Holder download is slice 7.
  - A backup is restored only into the instance it was taken from (`beginRestore` checks `instance_id`).
- **B11 Safety backup first.** Every restore first takes a `pre_restore` backup (database and `/data`) of what it replaces, as observability's restore does today.
- **B12 Restore failures.**
  - The database restore is one `psql --single-transaction`. When it fails, the database is as it was, and the app is started again on what it ran.
  - When the `/data` restore fails, or when the release the restore hands back to does not reach the cluster within 20 minutes, the instance is **held**: `maintenance = held:<restoreId>`, status `failed` with the reason, the app scaled to 0. It never starts on half a restore. A new restore (from the console) is the way out.
- **B13 Timeouts.**
  - Backup: 75 min (the Jobs' own deadline is 60 min, plus watcher slack). This is separate from slice 3's `STEP_TIMEOUT_MS`, which now counts from `applying`.
  - Restore: stopping 10 min, each restore Job 70 min, starting 20 min.
- **B14 Rolling back a release that migrates.**
  - It needs `rollBackRollout(…, acceptDataLoss: true)`.
  - Steps whose forward step has a ready backup are restored, in reverse order, one at a time, then set back to `from_version`.
  - Instances without a pre-update backup (joined during the rollout, or never updated) go back by image only, and the step's note says so.
  - Stopped instances are `skipped` with "stopped: restore its backup from before the update when it wakes".
- **B15 Paused or cancelled while backing up.** When the backup finishes and the rollout is no longer `active`, the step goes back to `pending` (paused; a fresh backup is taken when it starts again) or to `skipped` (cancelled). Its target never moved.
- **B16 Statuses are lowercase** (slice 3 R16): step statuses `backing_up` and `restoring`.

## What exists today (checked 2026-11-12 on `main` = 0.0.117; slice 3 as planned at `12f6eab`)

- **Database dumps** (`subgraphs/vetra-cloud-observability/dumps/`):
  - `database_dumps` (`id` 12 random chars, `tenantId`, `status` PENDING|RUNNING|READY|FAILED, `jobName`, `s3Key`, `sizeBytes` bigint, `expiresAt` = now + 30 d (`TTL_HOURS`), `source` MANUAL|SCHEDULED|PRE_RESTORE).
  - `DumpsRepo.create` refuses a second in-flight dump per tenant (`DUMP_IN_PROGRESS`) and stamps `requestedAt` from `input.now`.
  - `service.ts` `createDumpAndJob(deps: DumpJobDeps, input: CreateDumpInput)` calls `repo.create({ ...input, now: new Date() })`, builds `buildDumpJob` and calls `createJob`; a Job error marks the row FAILED and rethrows.
  - `job-spec.ts`:
    - `buildDumpJob`: Job `pgdump-<id>`, labels `app.kubernetes.io/managed-by=vetra-cloud-observability`, `vetra.io/dump-id`. Default SA, `harbor-credentials`, no volumes, `backoffLimit 0`, `activeDeadlineSeconds 3600`, `ttlSecondsAfterFinished 600`. PGHOST `<ns>-pg-pooler`, DB secret `<ns>-pg-app`, `S3_KEY` `<ns>/<id>.dump`, S3 credentials inline.
    - `buildRestoreJob({ restoreId, dumpId, … })`: Job `pgrestore-<restoreId>`, PGHOST `<ns>-pg-rw`, `RESTORE_SCRIPT` (s5cmd download, `DROP OWNED BY CURRENT_USER CASCADE`, `pg_restore` minus extensions, `psql --single-transaction`).
  - `watcher.ts` `reconcileJob` (Complete → READY with `headSize`, Failed → FAILED with the log's last line). The 10 s tick in `index.ts` `startDumpJobWatcher` lists in-flight rows, matches `k8s.listManagedJobs()` by the `vetra.io/dump-id` label (rows whose Job vanished are marked FAILED), and calls `reconcileJob`. `startDumpRowPruner` hourly `pruneExpired`.
  - `restore.ts` `advanceRestore` (SAFETY_DUMP → STOPPING → RESTORING → STARTING, `SWITCHBOARD_SELECTOR = app.kubernetes.io/component=switchboard`, `STEP_TIMEOUT_MS` 10 min), with `RestoreK8s` (`createJob`, `readJobStatus`, `readPodLogsForJob`, `readDeploymentReplicas`, `scaleDeployment`, `countPods`, `deploymentsReady`).
  - `k8s-client.ts`: `createDefaultDumpsK8sClient()`, `createDefaultRestoreK8s(dumps)` (in-cluster config).
  - `s3.ts` `S3Helper` (`presignDownload` 15 min, `headSize`, `deleteObject`).
  - `retention.ts` `RETENTION: Record<DumpSource, number>` (MANUAL 5, SCHEDULED 7, PRE_RESTORE 3).
  - The GraphQL `enum DumpSource { MANUAL, SCHEDULED, PRE_RESTORE }` (observability `schema.ts` line ~302). Its resolvers are owner-authorised (`authorizeDump`, no admin bypass).
  - Config: `VETRA_DUMPS_S3_ACCESS_KEY`/`_SECRET_KEY` (without them dumps are off), `VETRA_DUMPS_S3_ENDPOINT` (default `https://fsn1.your-objectstorage.com`), `VETRA_DUMPS_S3_REGION` (`fsn1`), `VETRA_DUMPS_BUCKET` (`powerhouse-env-dumps`), `VETRA_DUMPS_IMAGE` (`cr.vetra.io/powerhouse-inc-powerhouse/pgdump-uploader:1.0.0`), `VETRA_DUMPS_WATCHER_ENABLED`. Staging sets the S3 keys through the chart's `envDumps`.
- **Backup scheduler** (`dumps/backup-schedule-runner.ts`, 60 s tick):
  - `toBackupEnvSnapshot` keeps only READY, non-PREVIEW environments **with an enabled `SWITCHBOARD` service**. Instances run the FUSION host image and have no SWITCHBOARD service, so **no instance gets scheduled dumps today**.
  - `DEFAULT_SCHEDULE` is daily, keep 7.
- **CNPG:** `processors/vetra-cloud-environment/gitops.ts` renders, for every non-preview environment (`PLAN` included):
  - `backup.enabled: true` to `s3://powerhouse-cnpg-backups/<tenant>/`, `retentionPolicy: 180d`, `scheduledBackup` `0 2 * * *`;
  - `storageClass: longhorn-studio`, 50 Gi.
  - There is no on-demand `Backup`, no `VolumeSnapshot`, and no `/data` backup anywhere.
- **The chart** (`powerhouse-k8s-hosting/powerhouse-chart`):
  - Host-image instances: Deployment `<fullname>-app`, labels `app.kubernetes.io/component=app`, `strategy: Recreate` when `app.persistence.enabled`.
  - PVC `<fullname>-app-data` (`app-pvc.yaml`, labels `powerhouse.app.labels`, Prune=false, `resource-policy: keep`), mounted at `/data`, pod `fsGroup: 1000`, `runAsUser: 1000`.
  - The tenant Application is `powerhouse-<tenant>`, so fullname = `powerhouse-<tenant>`.
  - Argo `ignoreDifferences` on Deployment `/spec/replicas`, without `RespectIgnoreDifferences`, so a sync may set replicas back to the chart's 1.
  - **`postgres-cluster.yaml` is gated on `not .Values.global.disabled`**: a STOPPED environment loses its CNPG Cluster and its volumes (the CAVEAT comment at the top of that file).
- **Cluster guard rails** (`infrastructure/vetra-observability-rbac/`):
  - The ClusterRole grants jobs get/list/watch/create/delete, deployments get/list/patch, and pods/events read. No PVCs.
  - The ValidatingAdmissionPolicy lets the switchboard SAs (`vetra:default`, `staging:default`) create Jobs only in their own tier's namespaces, with default SA, `cr.vetra.io/` images, **no volumes and no volumeMounts**, no host namespaces, no nodeName or tolerations, no init or ephemeral containers, and no privilege. Deployments may only be scaled to 0 and back from 0 to at most 3.
- **Instances** (`subgraphs/vetra-apps/instances/`):
  - `reconciler.ts`: `reconcileInstancesOnce` → `withKeyLock("instances:<appId>")` → `reconcileApp` (`syncBranchInstances`, `syncPreviewInstances`, then with plans on `syncPlanInstances` in its own try/catch, then `reconcileInstance` per row).
  - `reconcileInstance`: removed → `removeInstance`, `stop_reason` → `stopPlanInstance` (READY → `stopped_by_vetra`, `sleepEnvironment`), else the update path.
  - The update path decides from the environment document (`instanceUpdateActions(state, targetImage(row), …)`). On failure it writes `failed_digest` and applies `revertImage(row)`, which goes back to `running_digest` unless that equals `target_digest`. A healthy-then-unhealthy target becomes `degraded`, never reverted.
  - `render.ts` `imageTag(version, digest)` = `<version>@<digest>`. `targets.ts` `targetOf(release)`.
  - `repo.ts` `updateInstance(db, id, patch, nowIso)` (audits status changes, works in a transaction), `getInstance`, `listInstances`, `insertInstance`.
  - `deps.envTenant(environmentId)` gives the namespace.
- **vetra-apps** wiring:
  - `index.ts` `every(ms, name, run)`, `WATCH_INTERVAL_MS` 15 s, `SWEEP_INTERVAL_MS` 15 min.
  - `deps.observabilityDb` is the observability namespace (`Kysely<ObservabilityDB>`; in tests the same PGlite).
  - Config groups in `config.ts` (`plansConfig`, `intIn`, `INSTANCES_ON/OFF`, `trimmed`), `loadAppsConfig(env)`.
  - Audit: `audit/repo.ts` `AUDIT_ACTIONS` (closed tuple), `recordAudit`, `AUDIT_SYSTEM_ACTOR`; `audit/service.ts` `auditCaller`.
  - Errors: `errors.ts` `appsError(code, msg)`, `notConfigured(what)`. Locks: `shared/key-lock.ts` `withKeyLock`.
- **Test harness** (`__tests__/harness.ts`, `instances-fixtures.ts`):
  - `makeHarness(cfg)` runs PGlite with vetra-apps, observability and licensing tables in one database. `h.obsDb`, `h.tenants` (environment → tenant).
  - `deps.now()` advances 1 ms per call from `2026-10-02T12:00:00.000Z`; `h.advance(ms)`.
  - `FakeEnvs` (`docs`, `executed`); `testConfig(over)`; `seedActiveApp(h)` (App "Shop", slug `shop`); `seedRelease(h, appId, { version, run, kind, digest })` (image `cr.vetra.io/acme/shop:<version>`, `migrates: false`); `digest(c)`.
- **Slice 3 (planned, not merged):**
  - `rollouts/repo.ts`: `MOVING = ["applying", "reverting"]` and the partial unique index `rollout_steps_moving_uq` (one moving step per App); `transitionStep`, `movingStep`, `getRollout`, `lockRollout`, `updateRollout`, `stepsOf`.
  - `rollouts/runner.ts`: `advanceRollouts(deps, app)` (`settle` the moving step, `startNext` → `startStep` / `startRevert`, `finishDone`), `pointInstanceAt`, `failStep` (transition, optional send-back, pause with an alert row), `endStep`, `stepEntry`, `STEP_TIMEOUT_MS`.
  - `rollouts/controls.ts` `rollBackRollout(deps, caller, rolloutId)`, which refuses `migrates: true` (R5).
  - `reconcileApp` calls `advanceRollouts` after `syncPlanInstances`.
  - Fixtures `__tests__/rollouts-fixtures.ts`: `rolloutHarness`, `seedPlan`, `readyInstance`, `becomeReady`, `failUpdate`, `instance`, `HOLDER_A`.
- **The staging canary** (`powerhouse-inc/vetra-publish-canary`, App `96e56853-…`) is a plain Node HTTP server. It never touches its database or `/data`. vetra-publish sets `migrates` when the release's diff touches `vetra.migrations` paths (`src/migrates.js` `computeMigrates`), or when `vetra.migrates` is true.

## Contract with slice 3

Slice 4 lands after slice 3 is merged (overview order 1 → 2 → 3 → 4). Everything in Tasks 1-12 stands alone and touches no rollout table. Task 13 is the only place that edits slice 3's code, and it does that through this contract (`subgraphs/vetra-apps/backups/rollout.ts`):

| Call | Meaning |
|---|---|
| `backupsOn(deps): boolean` | `VETRA_APPS_BACKUPS=on` and `deps.backups` wired. False: slice 3 behaves exactly as it does without slice 4. |
| `backupBeforeUpdate(deps, instance, stepId): Promise<string>` | Starts a `pre_update` backup (dump + `/data` archive) and returns its id. Throws `BackupBusyError` (a dump or archive of the tenant is running; try on a later pass) or `BackupUnavailableError` (no environment, namespace, `/data` volume, or configuration; fail the step). |
| `backupProgress(deps, backupId): Promise<BackupProgress>` | `{ state: "pending" }`, `{ state: "ready", takenAt, version }`, or `{ state: "failed", error }` (failed, timed out after `BACKUP_TIMEOUT_MS`, gone, or expired). Advanced by `advanceBackups`, which runs in the same per-App pass **before** `advanceRollouts`. |
| `restoreBackup(deps, instance, backupId, { purpose: "rollback" \| "failed_update", thenVersion, stepId }): Promise<string>` | Starts a restore and returns its id. The instance goes into maintenance (the reconciler leaves it alone). At the end the restore sets the instance's target **and** running release to `thenVersion` and hands it back. Throws `RestoreBusyError`, or `Error` for a backup of another instance, or one not ready or expired. |
| `restoreProgress(deps, restoreId): Promise<RestoreProgress>` | `{ state: "running", phase }`, `{ state: "succeeded" }`, or `{ state: "failed", error, held }`. Advanced by `advanceRestores` in the same pass. |
| `isHeld(instance.maintenance)` | The instance stays stopped after a failed restore (B12). |

What slice 3's code must change (Task 13 does it):
- The step statuses `backing_up` and `restoring`, and the columns `rollout_steps.backup_id` and `restore_id`.
- `MOVING` gains both statuses, and the one-moving-step index is replaced (`rollout_steps_moving_v2_uq`).
- `startStep`: back up first, and move the target only from `settle` once the backup is ready.
- `settle`: handle `backing_up` and `restoring`. Forward failures of a `migrates` release go to `recover`.
- `startRevert`: restore for a `migrates` release.
- `rollBackRollout`: `acceptDataLoss`.
- `finishDone`: the new statuses count as open.

If slice 3 lands with other names, Task 13 keeps these semantics and maps them onto the names it finds. Task 0 checks this.

## Model (as built here)

**`instance_backups`** (vetra-apps)

| Column | Meaning |
|---|---|
| `id`, `app_id`, `instance_id`, `environment_id`, `tenant_id` | the backup belongs to one instance and its namespace |
| `reason` | `pre_update` · `daily` · `manual` · `pre_restore` · `pre_stop` |
| `version`, `digest` | what the instance ran when the backup started (`running_version`, `running_digest`) |
| `dump_id`, `archive_id` | the observability rows (`database_dumps.id`, `data_archives.id`) |
| `status` | `pending` → `ready` \| `failed` |
| `error`, `size_bytes` | the failure, or dump + archive bytes |
| `requested_by` | an address, or `vetra` |
| `rollout_step_id` | the step it was taken for (`pre_update`) |
| `created_at`, `finished_at`, `expires_at`, `updated_at` | `expires_at` per B6 |

**`instance_restores`** (vetra-apps). A partial unique index on `instance_id` while active: one restore per instance at a time.

| Column | Meaning |
|---|---|
| `id`, `app_id`, `instance_id`, `environment_id`, `tenant_id` | |
| `backup_id`, `safety_backup_id` | what is restored, and the `pre_restore` backup of what it replaces |
| `purpose` | `rollback` · `failed_update` · `manual` |
| `then_version` | the release the instance targets and runs afterwards (null: unchanged) |
| `data` | restore `/data` too (always true in this slice) |
| `status` | `safety_backup` → `stopping` → `restoring_db` → `restoring_data` → `starting` → `succeeded` \| `failed` |
| `phase_started_at` | the phase's timeout clock |
| `db_job`, `data_job` | Job names |
| `replicas` | JSON `{deployment: replicas}` recorded before scaling to 0 (at least 1 each) |
| `target_set` | the instance was handed back with `then_version` |
| `was_held` | the instance was held when this restore began: an early failure keeps it held |
| `error`, `held` | |
| `requested_by`, `rollout_step_id`, `created_at`, `updated_at`, `finished_at` | |

**`instances.maintenance`**: `restore:<id>` while a restore owns the instance (the reconciler, daily backups, rollouts and API leave it alone), and `held:<id>` after a failed restore (B12). Null otherwise.

**`data_archives`** (observability): `id`, `documentId`, `tenantId`, `requestedBy`, `status` PENDING|RUNNING|READY|FAILED, `pvcName`, `jobName`, `s3Key` (`<tenant>/data/<id>.tar.zst`), `sizeBytes`, `sha256`, `errorMessage`, `requestedAt`, `startedAt`, `completedAt`, `expiresAt` (+30 d).

**New dump sources:** `PRE_UPDATE` (rollout steps) and `INSTANCE` (daily, manual, pre-restore and pre-stop backups of instances). Observability's own retention never runs on them; vetra-apps sweeps them.

**New audit actions:** `backup.requested` (a person, `manual`), `backup.failed` (system), `restore.started` (a person or system), `restore.finished` (system, `outcome`, `held`). Subjects are `instance:<id>`. Successful automatic backups are not audited (one row per instance per day would drown the log).

## Global Constraints

- Additive schema only: idempotent, race-tolerant migrations, namespaced schema builder in vetra-apps, plain `ifNotExists` in observability `up`. New optional columns are declared with `?`.
- A backup is only ever restored into the instance it was taken from, in the same namespace (checked in `beginRestore`). Nothing reads or writes another tenant.
- An instance never starts on a half-done restore (B12). Nothing scales an app Deployment up while the restored release is not the Deployment's image (`starting` checks `deploymentImages`).
- No backup content, S3 key, signed URL or credential reaches the GraphQL API, the audit log or a log line. The API shows times, sizes, versions, reasons, statuses and errors. Presigned URLs are slice 7.
- `VETRA_APPS_BACKUPS=off` (default) keeps every existing behaviour (tested in Tasks 10 and 13). The observability changes are inert until vetra-apps creates `PRE_UPDATE`/`INSTANCE` dumps or archives.
- Every write to an instance (`maintenance`, targets) runs under `instances:<appId>`: in the reconciler pass (`advanceRestores`, `preStopGate`), in the daily job (`withKeyLock`), and in API mutations (`withKeyLock`). Code under that lock never takes it again.
- Jobs only take the shapes the (relaxed) admission policy allows: default SA, `cr.vetra.io/` image, one `*-app-data` PVC at `/data`, no privilege, no host namespaces, no init containers. Task 3 asserts this.
- Production order: hosting PR (policy, RBAC, chart flag) and the 1.1.0 image first, then the package pin, then `VETRA_APPS_BACKUPS: on` on staging, verified (Task 19), and only then production.
- Commits: one per task, conventional (`feat(dumps): …`, `feat(backups): …`, `feat(rollouts): …`, `feat(instances): …`, `feat(processor): …`, `feat(apps): …`), trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Branch `feat/releases-phase-3-backups` from `main`. Never stash. Never touch other worktrees.
- Checks after every task: `npx vitest run <the task's test files> 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. At the end: `npm run tsc`, `npm run lint`, `npx vitest run subgraphs/vetra-apps subgraphs/vetra-cloud-observability processors shared 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`.
- No production pin of vetra-cloud-package while a Sektar gated rollout is APPLYING (overview rule 4). Check `vetraReleases.rollouts(appId: "43622402-be06-435a-bbfa-bb649b0d6244")` first.

## File structure

| File | Change |
|---|---|
| `subgraphs/vetra-cloud-observability/db/schema.ts` | `DumpSource` + `PRE_UPDATE`, `INSTANCE`; `DataArchives`; `ObservabilityDB.data_archives` |
| `subgraphs/vetra-cloud-observability/db/migrations.ts` | `data_archives` in `up`/`down` |
| `subgraphs/vetra-cloud-observability/schema.ts` | GraphQL `DumpSource` values |
| `subgraphs/vetra-cloud-observability/dumps/retention.ts` | `RETENTION` typed on observability's own sources |
| `subgraphs/vetra-cloud-observability/dumps/service.ts` | `CreateDumpInput.now?` |
| `subgraphs/vetra-cloud-observability/dumps/backup-schedule-runner.ts` | PLAN environments are left to vetra-apps |
| `subgraphs/vetra-cloud-observability/dumps/archive-repo.ts` (new) | `ArchivesRepo`, `archiveKey` |
| `subgraphs/vetra-cloud-observability/dumps/archive-job-spec.ts` (new) | `buildArchiveJob`, `buildDataRestoreJob`, `ARCHIVE_SCRIPT`, `DATA_RESTORE_SCRIPT`, `parseArchiveSha256`, `APP_UID` |
| `subgraphs/vetra-cloud-observability/dumps/archive-service.ts` (new) | `createArchiveAndJob` |
| `subgraphs/vetra-cloud-observability/dumps/archive-watcher.ts` (new) | `reconcileArchiveJob` |
| `subgraphs/vetra-cloud-observability/dumps/job-watch.ts` (new) | `watchJobsOnce` (the watcher tick, dumps and archives) |
| `subgraphs/vetra-cloud-observability/dumps/k8s-client.ts` | `listManagedJobs` returns `archiveId` |
| `subgraphs/vetra-cloud-observability/index.ts` | `ArchivesRepo`, tick via `watchJobsOnce`, archive pruning |
| `subgraphs/vetra-apps/config.ts` | `BackupsConfig`, `VETRA_APPS_BACKUPS*`, `backupsConfigOf` |
| `subgraphs/vetra-apps/db/schema.ts` | backup and restore tables, `InstancesTable.maintenance?` |
| `subgraphs/vetra-apps/db/migrations.ts` | `ensureInstanceBackupTables` |
| `subgraphs/vetra-apps/audit/repo.ts` | four actions |
| `subgraphs/vetra-apps/backups/repo.ts` (new) | rows and queries |
| `subgraphs/vetra-apps/backups/k8s.ts` (new) | `BackupK8s`, `InstanceBackupDeps`, `APP_SELECTOR`, `createDefaultBackupK8s`, `instanceBackupDepsFromEnv` |
| `subgraphs/vetra-apps/backups/service.ts` (new) | `startInstanceBackup`, `advanceBackups`, `preStopGate`, errors, `BACKUP_TIMEOUT_MS` |
| `subgraphs/vetra-apps/backups/restore.ts` (new) | `beginRestore`, `advanceRestores`, marks |
| `subgraphs/vetra-apps/backups/schedule.ts` (new) | `runDailyBackupsOnce`, `sweepBackupsOnce` |
| `subgraphs/vetra-apps/backups/rollout.ts` (new) | the slice 3 contract |
| `subgraphs/vetra-apps/backups/api.ts` (new) | `instanceBackupsFor`, `instanceRestoresFor`, `backUpInstanceFor`, `restoreInstanceBackupFor` |
| `subgraphs/vetra-apps/service.ts` | `AppsDeps.backups?` |
| `subgraphs/vetra-apps/instances/reconciler.ts` | maintenance hands-off; `advanceBackups`/`advanceRestores` per App; `preStopGate` in `stopPlanInstance` |
| `subgraphs/vetra-apps/instances/service.ts` | `InstanceJson.maintenance` |
| `subgraphs/vetra-apps/index.ts` | `deps.backups`; daily backups job |
| `subgraphs/vetra-apps/rollouts/*` (slice 3) | Task 13 |
| `subgraphs/vetra-apps/schema.ts`, `resolvers.ts` | backup types, queries, mutations; `rollBackRollout(acceptDataLoss)`; step fields |
| `processors/vetra-cloud-environment/gitops.ts` | `keepWhenDisabled: true` for PLAN |
| Tests (new) | observability: `dumps-service.test.ts`, `archives-repo.test.ts`, `archive-job-spec.test.ts`, `archive-watcher.test.ts`, `dumps-job-watch.test.ts`; vetra-apps: `backups-fixtures.ts`, `backups-repo.test.ts`, `backups-k8s.test.ts`, `backups-service.test.ts`, `backups-restore.test.ts`, `backups-reconciler.test.ts`, `backups-schedule.test.ts`, `backups-contract.test.ts`, `rollouts-backups.test.ts`, `backups-api.test.ts` |
| Tests (changed) | `backup-schedule-runner.test.ts`, `config.test.ts`, `migrations.test.ts`, `fusion.test.ts` |
| Elsewhere (Task 16, 17) | `powerhouse-k8s-hosting`: admission policy, RBAC, `pgdump-uploader` 1.1.0, chart `keepWhenDisabled`, staging values; `vetra-publish-canary`: migrations and `/db`, `/notes`, `/data` |

---

### Task 0: Pre-flight (no code)

- [ ] **Step 1: Slice 3 is merged.** `git fetch && git log origin/main --oneline | grep -i "rollouts" | head`. Check that its names are there:
  `grep -n "export const MOVING\|rollout_steps_moving_uq\|async function startStep\|async function settle\|async function startRevert\|async function failStep\|export async function rollBackRollout\|async function finishDone" -r subgraphs/vetra-apps/rollouts subgraphs/vetra-apps/db/migrations.ts`.
  If slice 3 is not on `main`, do Tasks 1-12 and 14-17 (without the rollout parts of Task 14) and leave Task 13 for when it lands. If it landed with other names, write down the mapping in the PR description and apply Task 13's semantics to them.
- [ ] **Step 2: Branch.** `git checkout -b feat/releases-phase-3-backups origin/main`. Never stash, and never touch the other worktrees (`git worktree list`).
- [ ] **Step 3: Baseline.** `npx vitest run subgraphs/vetra-apps subgraphs/vetra-cloud-observability processors shared 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Record pre-existing failures in the PR description; do not fix them here.

---

### Task 1: Dump sources for instances; scheduler leaves plan instances alone

**Files:**
- Modify: `subgraphs/vetra-cloud-observability/db/schema.ts`, `subgraphs/vetra-cloud-observability/schema.ts`, `subgraphs/vetra-cloud-observability/dumps/retention.ts`, `subgraphs/vetra-cloud-observability/dumps/service.ts`, `subgraphs/vetra-cloud-observability/dumps/backup-schedule-runner.ts`
- Test: `subgraphs/vetra-cloud-observability/__tests__/dumps-service.test.ts` (new), `subgraphs/vetra-cloud-observability/__tests__/backup-schedule-runner.test.ts`

**Interfaces:**
- Produces:
  - `DumpSource = "MANUAL" | "SCHEDULED" | "PRE_RESTORE" | "PRE_UPDATE" | "INSTANCE"`;
  - `ObservabilityDumpSource = "MANUAL" | "SCHEDULED" | "PRE_RESTORE"` (`RETENTION` is keyed on it);
  - `CreateDumpInput.now?: Date`;
  - `toBackupEnvSnapshot` returns null for `appRole === "PLAN"`.

- [ ] **Step 1: Write the failing tests.** Create `__tests__/dumps-service.test.ts`:

```ts
import { PGlite } from "@electric-sql/pglite";
import type { V1Job } from "@kubernetes/client-node";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { up } from "../db/migrations.js";
import type { ObservabilityDB } from "../db/schema.js";
import { DumpsRepo } from "../dumps/repo.js";
import { createDumpAndJob } from "../dumps/service.js";

let db: Kysely<ObservabilityDB>;
let repo: DumpsRepo;
beforeEach(async () => {
  db = new Kysely<ObservabilityDB>({ dialect: new PGliteDialect(new PGlite()) });
  await up(db);
  repo = new DumpsRepo(db);
});
afterEach(async () => db.destroy());

const deps = (created: string[]) => ({
  repo,
  createJob: async (ns: string, j: V1Job) => {
    created.push(`${ns}/${j.metadata!.name}`);
    return j.metadata!.name!;
  },
  image: "cr.vetra.io/x/pgdump-uploader:1.0.0",
  bucket: "dumps",
  s3Endpoint: "https://s3.test",
  s3AccessKey: "AK",
  s3SecretKey: "SK",
});

describe("createDumpAndJob for instances (releases phase 3 slice 4)", () => {
  it("records the source and the caller's clock, one dump per tenant at a time", async () => {
    const created: string[] = [];
    const at = new Date("2026-10-02T12:00:00.000Z");
    const d = await createDumpAndJob(deps(created), {
      documentId: "env-1",
      tenantId: "t-1",
      requestedBy: "vetra",
      source: "PRE_UPDATE",
      now: at,
    });
    expect(d).toMatchObject({
      source: "PRE_UPDATE",
      requestedAt: at.toISOString(),
      expiresAt: "2026-11-01T12:00:00.000Z",
    });
    expect(created).toEqual([`t-1/pgdump-${d.id}`]);
    await expect(
      createDumpAndJob(deps(created), {
        documentId: "env-1",
        tenantId: "t-1",
        requestedBy: "vetra",
        source: "INSTANCE",
        now: at,
      }),
    ).rejects.toThrow("DUMP_IN_PROGRESS");
  });
});
```

In `__tests__/backup-schedule-runner.test.ts` add `toBackupEnvSnapshot` to the import from `../dumps/backup-schedule-runner.js` if it is not there, and append:

```ts
describe("toBackupEnvSnapshot and plan instances", () => {
  it("leaves PLAN environments to vetra-apps' instance backups", () => {
    const row = {
      id: "env-1",
      tenantId: "t-1",
      status: "READY",
      appRole: "PLAN",
      services: JSON.stringify([{ type: "SWITCHBOARD", enabled: true }]),
      backupSchedule: null,
    };
    expect(toBackupEnvSnapshot(row)).toBeNull();
    expect(toBackupEnvSnapshot({ ...row, appRole: null })).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run them.** `npx vitest run subgraphs/vetra-cloud-observability/__tests__/dumps-service.test.ts subgraphs/vetra-cloud-observability/__tests__/backup-schedule-runner.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL (`PRE_UPDATE` is not a `DumpSource`, `now` is ignored, PLAN gets a snapshot).
- [ ] **Step 3: Implement.**
  - `db/schema.ts`: replace the `DumpSource` line and its comment with:

```ts
/**
 * Why a dump exists: owner click, the backup scheduler, a restore's safety
 * copy, or a vetra-apps instance backup (PRE_UPDATE before a rollout step;
 * INSTANCE for daily, manual, pre-restore and pre-stop backups, whose reason
 * vetra-apps keeps in instance_backups). Observability's retention only ever
 * runs on its own three sources; vetra-apps sweeps the other two.
 */
export type DumpSource = "MANUAL" | "SCHEDULED" | "PRE_RESTORE" | "PRE_UPDATE" | "INSTANCE";
export type ObservabilityDumpSource = Exclude<DumpSource, "PRE_UPDATE" | "INSTANCE">;
```

  - `dumps/retention.ts`: import `ObservabilityDumpSource` and type the record as `Record<ObservabilityDumpSource, number>`. Leave `applyRetention`'s `source: DumpSource` parameter as it is.
  - `schema.ts` (observability GraphQL): `enum DumpSource { MANUAL, SCHEDULED, PRE_RESTORE, PRE_UPDATE, INSTANCE }`.
  - `dumps/service.ts`: add to `CreateDumpInput`:

```ts
  /** Defaults to the wall clock; vetra-apps passes its own (tests use a fake clock). */
  now?: Date;
```

    and in `createDumpAndJob` replace `const dump = await deps.repo.create({ ...input, now: new Date() });` with `const dump = await deps.repo.create({ ...input, now: input.now ?? new Date() });`.
  - `dumps/backup-schedule-runner.ts` `toBackupEnvSnapshot`: change the first condition to

```ts
  // PLAN: shared and own instances of vetra-apps; their backups (database and
  // /data) are vetra-apps' (releases phase 3 slice 4), never the scheduler's.
  if (
    row.status !== "READY" ||
    !row.tenantId ||
    row.appRole === "PREVIEW" ||
    row.appRole === "PLAN"
  )
    return null;
```

    and update the function's comment ("a PREVIEW or PLAN app env").
- [ ] **Step 4: Run them again.** Same command. Expected: PASS. Then `npx vitest run subgraphs/vetra-cloud-observability 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add subgraphs/vetra-cloud-observability && git commit -m "feat(dumps): PRE_UPDATE and INSTANCE dump sources; plan instances are not scheduled" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 2: `data_archives` and `ArchivesRepo`

**Files:**
- Modify: `subgraphs/vetra-cloud-observability/db/schema.ts`, `subgraphs/vetra-cloud-observability/db/migrations.ts`
- Create: `subgraphs/vetra-cloud-observability/dumps/archive-repo.ts`
- Test: `subgraphs/vetra-cloud-observability/__tests__/archives-repo.test.ts`

**Interfaces:**
- Produces:
  - `DataArchives` (Model);
  - `ObservabilityDB.data_archives`;
  - `archiveKey(tenantId, id) = "<tenant>/data/<id>.tar.zst"`;
  - `CreateArchiveInput { documentId; tenantId; requestedBy; pvcName; now: Date }`;
  - `class ArchivesRepo`:
    - `inFlightForTenant(tenantId): Promise<boolean>`;
    - `create(input)` (throws `ARCHIVE_IN_PROGRESS`);
    - `setJobName(id, name)`, `markRunning(id, jobName, at)`;
    - `markReady(id, s3Key, sizeBytes, sha256, at)`, `markFailed(id, message, at)`;
    - `getById(id)`, `listInFlight()`, `deleteById(id)`, `pruneExpired(now)`.

- [ ] **Step 1: Write the failing test.** Create `__tests__/archives-repo.test.ts`:

```ts
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { up } from "../db/migrations.js";
import type { ObservabilityDB } from "../db/schema.js";
import { archiveKey, ArchivesRepo } from "../dumps/archive-repo.js";

let db: Kysely<ObservabilityDB>;
let repo: ArchivesRepo;
beforeEach(async () => {
  db = new Kysely<ObservabilityDB>({ dialect: new PGliteDialect(new PGlite()) });
  await up(db);
  await up(db); // idempotent
  repo = new ArchivesRepo(db);
});
afterEach(async () => db.destroy());

describe("ArchivesRepo", () => {
  it("keeps one in-flight archive per tenant, records its checksum, prunes a day after expiry", async () => {
    const now = new Date("2026-11-12T10:00:00.000Z");
    const input = {
      documentId: "env-1",
      tenantId: "t-1",
      requestedBy: "VETRA",
      pvcName: "powerhouse-t-1-app-data",
      now,
    };
    const a = await repo.create(input);
    expect(a).toMatchObject({
      status: "PENDING",
      requestedBy: "vetra",
      pvcName: "powerhouse-t-1-app-data",
      requestedAt: now.toISOString(),
      expiresAt: "2026-12-12T10:00:00.000Z",
    });
    expect(await repo.inFlightForTenant("t-1")).toBe(true);
    expect(await repo.inFlightForTenant("t-2")).toBe(false);
    await expect(repo.create(input)).rejects.toThrow("ARCHIVE_IN_PROGRESS");
    await repo.markRunning(a.id, `dataarchive-${a.id}`, now);
    expect((await repo.listInFlight()).map((r) => r.status)).toEqual(["RUNNING"]);
    await repo.markReady(a.id, archiveKey("t-1", a.id), 1234, "f".repeat(64), now);
    const ready = await repo.getById(a.id);
    expect(ready).toMatchObject({
      status: "READY",
      s3Key: `t-1/data/${a.id}.tar.zst`,
      sha256: "f".repeat(64),
      completedAt: now.toISOString(),
    });
    expect(Number(ready!.sizeBytes)).toBe(1234);
    expect(await repo.inFlightForTenant("t-1")).toBe(false);
    const b = await repo.create(input);
    await repo.markFailed(b.id, "x".repeat(600), now);
    expect((await repo.getById(b.id))!.errorMessage).toHaveLength(500);
    expect(await repo.pruneExpired(new Date("2026-12-13T09:00:00.000Z"))).toBe(0);
    expect(await repo.pruneExpired(new Date("2026-12-13T10:00:01.000Z"))).toBe(2);
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-cloud-observability/__tests__/archives-repo.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement.**
  - `db/schema.ts`, after `DatabaseRestores`:

```ts
/**
 * /data archives of host-image instances (vetra-apps releases phase 3 slice
 * 4): `tar | zstd` of the app's data PVC, stored next to the database dumps
 * under `<tenant>/data/<id>.tar.zst`. `sha256` is the stored object's
 * checksum; a data restore checks it before it touches /data.
 */
export interface DataArchives {
  id: string;
  documentId: string;
  tenantId: string;
  requestedBy: string;
  status: string; // PENDING | RUNNING | READY | FAILED
  pvcName: string;
  jobName: string | null;
  s3Key: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  errorMessage: string | null;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  expiresAt: string;
}
```

    and add `data_archives: DataArchives;` to `ObservabilityDB` after `database_restores`.
  - `db/migrations.ts`: at the end of `up`:

```ts
  // /data archives of vetra-apps instances (releases phase 3 slice 4).
  await db.schema
    .createTable("data_archives")
    .addColumn("id", "varchar(64)", (col) => col.primaryKey())
    .addColumn("documentId", "varchar(255)", (col) => col.notNull())
    .addColumn("tenantId", "varchar(255)", (col) => col.notNull())
    .addColumn("requestedBy", "varchar(255)", (col) => col.notNull())
    .addColumn("status", "varchar(32)", (col) => col.notNull())
    .addColumn("pvcName", "varchar(255)", (col) => col.notNull())
    .addColumn("jobName", "varchar(255)")
    .addColumn("s3Key", "varchar(512)")
    .addColumn("sizeBytes", "bigint")
    .addColumn("sha256", "varchar(64)")
    .addColumn("errorMessage", "text")
    .addColumn("requestedAt", "varchar(64)", (col) => col.notNull())
    .addColumn("startedAt", "varchar(64)")
    .addColumn("completedAt", "varchar(64)")
    .addColumn("expiresAt", "varchar(64)", (col) => col.notNull())
    .ifNotExists()
    .execute();
  await db.schema
    .createIndex("data_archives_tenant_idx")
    .ifNotExists()
    .on("data_archives")
    .columns(["tenantId", "requestedAt"])
    .execute();
```

    and at the top of `down`: `await db.schema.dropTable("data_archives").ifExists().execute();`.
  - Create `dumps/archive-repo.ts`:

```ts
import type { Kysely } from "kysely";
import type { DataArchives, ObservabilityDB } from "../db/schema.js";

const IN_FLIGHT = ["PENDING", "RUNNING"] as const;
/** The dumps bucket's lifecycle ceiling (same as database dumps). */
const TTL_MS = 30 * 24 * 3600 * 1000;
const ERROR_MESSAGE_LIMIT = 500;
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function archiveId(): string {
  let s = "";
  for (let i = 0; i < 12; i++) s += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  return s;
}

/** Where an archive is stored in the dumps bucket. */
export const archiveKey = (tenantId: string, id: string): string =>
  `${tenantId}/data/${id}.tar.zst`;

export type CreateArchiveInput = {
  documentId: string;
  tenantId: string;
  requestedBy: string;
  /** The tenant's app data PVC (`<fullname>-app-data`). */
  pvcName: string;
  now: Date;
};

export class ArchivesRepo {
  constructor(private readonly db: Kysely<ObservabilityDB>) {}

  async inFlightForTenant(tenantId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("data_archives")
      .select("id")
      .where("tenantId", "=", tenantId)
      .where("status", "in", [...IN_FLIGHT])
      .executeTakeFirst();
    return !!row;
  }

  /** Throws ARCHIVE_IN_PROGRESS when the tenant already has one in flight. */
  async create(input: CreateArchiveInput): Promise<DataArchives> {
    if (await this.inFlightForTenant(input.tenantId)) throw new Error("ARCHIVE_IN_PROGRESS");
    const row: DataArchives = {
      id: archiveId(),
      documentId: input.documentId,
      tenantId: input.tenantId,
      requestedBy: input.requestedBy.toLowerCase(),
      status: "PENDING",
      pvcName: input.pvcName,
      jobName: null,
      s3Key: null,
      sizeBytes: null,
      sha256: null,
      errorMessage: null,
      requestedAt: input.now.toISOString(),
      startedAt: null,
      completedAt: null,
      expiresAt: new Date(input.now.getTime() + TTL_MS).toISOString(),
    };
    await this.db.insertInto("data_archives").values(row).execute();
    return row;
  }

  async setJobName(id: string, jobName: string): Promise<void> {
    await this.db.updateTable("data_archives").set({ jobName }).where("id", "=", id).execute();
  }

  async markRunning(id: string, jobName: string, at: Date): Promise<void> {
    await this.db
      .updateTable("data_archives")
      .set({ status: "RUNNING", jobName, startedAt: at.toISOString() })
      .where("id", "=", id)
      .where("status", "=", "PENDING")
      .execute();
  }

  async markReady(id: string, s3Key: string, sizeBytes: number, sha256: string, at: Date): Promise<void> {
    await this.db
      .updateTable("data_archives")
      .set({ status: "READY", s3Key, sizeBytes, sha256, completedAt: at.toISOString() })
      .where("id", "=", id)
      .execute();
  }

  async markFailed(id: string, errorMessage: string, at: Date): Promise<void> {
    await this.db
      .updateTable("data_archives")
      .set({
        status: "FAILED",
        errorMessage: errorMessage.slice(0, ERROR_MESSAGE_LIMIT),
        completedAt: at.toISOString(),
      })
      .where("id", "=", id)
      .execute();
  }

  async getById(id: string): Promise<DataArchives | null> {
    const row = await this.db
      .selectFrom("data_archives")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return (row as DataArchives | undefined) ?? null;
  }

  async listInFlight(): Promise<DataArchives[]> {
    return (await this.db
      .selectFrom("data_archives")
      .selectAll()
      .where("status", "in", [...IN_FLIGHT])
      .execute()) as DataArchives[];
  }

  async deleteById(id: string): Promise<void> {
    await this.db.deleteFrom("data_archives").where("id", "=", id).execute();
  }

  /** Rows a day past their expiry (the bucket lifecycle removed the files by then). */
  async pruneExpired(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
    const r = await this.db
      .deleteFrom("data_archives")
      .where("expiresAt", "<", cutoff)
      .executeTakeFirst();
    return Number(r.numDeletedRows ?? 0);
  }
}
```

- [ ] **Step 4: Run it again.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** `git add subgraphs/vetra-cloud-observability && git commit -m "feat(dumps): data_archives table and repo for /data archives" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 3: Archive and data-restore Jobs

**Files:**
- Create: `subgraphs/vetra-cloud-observability/dumps/archive-job-spec.ts`, `subgraphs/vetra-cloud-observability/dumps/archive-service.ts`
- Test: `subgraphs/vetra-cloud-observability/__tests__/archive-job-spec.test.ts`

**Interfaces:**
- Produces:
  - `APP_UID = 1000`;
  - `APP_LABELS = { "app.kubernetes.io/component": "app" }`;
  - `DataJobInput { tenantNs; pvcName; image; bucket; s3Endpoint; s3AccessKey; s3SecretKey }`;
  - `buildArchiveJob(input & { archiveId; colocate })`: Job `dataarchive-<id>`, labels managed-by and `vetra.io/archive-id`, read-only mount, pod affinity to the app pod only when `colocate`;
  - `buildDataRestoreJob(input & { restoreId; archiveId; sha256 })`: Job `datarestore-<restoreId>`, labels managed-by, `vetra.io/kind=data-restore`, `vetra.io/restore-id` (never picked up by the watcher), read-write mount, no affinity;
  - `ARCHIVE_SCRIPT`, `DATA_RESTORE_SCRIPT`, `parseArchiveSha256(logs): string | null`;
  - `ArchiveJobDeps`, `createArchiveAndJob(deps, input: CreateArchiveInput & { colocate: boolean })`.

- [ ] **Step 1: Write the failing test.** Create `__tests__/archive-job-spec.test.ts`:

```ts
import type { V1Job } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import {
  ARCHIVE_SCRIPT,
  buildArchiveJob,
  buildDataRestoreJob,
  DATA_RESTORE_SCRIPT,
  parseArchiveSha256,
} from "../dumps/archive-job-spec.js";

const base = {
  tenantNs: "calm-bat-t1",
  pvcName: "powerhouse-calm-bat-t1-app-data",
  image: "cr.vetra.io/powerhouse-inc-powerhouse/pgdump-uploader:1.1.0",
  bucket: "powerhouse-env-dumps",
  s3Endpoint: "https://fsn1.your-objectstorage.com",
  s3AccessKey: "AK",
  s3SecretKey: "SK",
};

const env = (job: V1Job) =>
  Object.fromEntries(
    (job.spec!.template.spec!.containers[0].env ?? []).map((e) => [e.name, e.value]),
  );

/** The admission policy's rules (powerhouse-k8s-hosting, switchboard-tier-scoped-writes), relaxed by Task 16. */
function admitted(job: V1Job): boolean {
  const pod = job.spec!.template.spec!;
  const volumes = pod.volumes ?? [];
  return (
    [undefined, "", "default"].includes(pod.serviceAccountName) &&
    volumes.length <= 1 &&
    volumes.every((v) => !!v.persistentVolumeClaim?.claimName.endsWith("-app-data")) &&
    !pod.hostPID &&
    !pod.hostNetwork &&
    !pod.hostIPC &&
    !pod.nodeName &&
    !(pod.tolerations ?? []).length &&
    !(pod.initContainers ?? []).length &&
    pod.containers.every(
      (c) =>
        c.image!.startsWith("cr.vetra.io/") &&
        (c.volumeMounts ?? []).every((m) => m.mountPath === "/data" && !m.subPath) &&
        !c.securityContext?.privileged &&
        !c.securityContext?.allowPrivilegeEscalation &&
        !c.securityContext?.capabilities?.add,
    )
  );
}

describe("the /data archive Job", () => {
  it("mounts the app data PVC read-only as the app's user, next to the app pod, and streams to <tenant>/data/<id>.tar.zst", () => {
    const job = buildArchiveJob({ ...base, archiveId: "abc123", colocate: true });
    expect(job.metadata).toMatchObject({
      name: "dataarchive-abc123",
      namespace: "calm-bat-t1",
      labels: {
        "app.kubernetes.io/managed-by": "vetra-cloud-observability",
        "vetra.io/archive-id": "abc123",
      },
    });
    expect(job.spec).toMatchObject({ backoffLimit: 0, activeDeadlineSeconds: 3600, ttlSecondsAfterFinished: 600 });
    const pod = job.spec!.template.spec!;
    expect(pod.securityContext).toMatchObject({ runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, runAsNonRoot: true });
    expect(pod.volumes).toEqual([
      { name: "app-data", persistentVolumeClaim: { claimName: "powerhouse-calm-bat-t1-app-data", readOnly: true } },
    ]);
    expect(pod.containers[0].volumeMounts).toEqual([{ name: "app-data", mountPath: "/data", readOnly: true }]);
    expect(pod.affinity?.podAffinity?.requiredDuringSchedulingIgnoredDuringExecution?.[0]).toEqual({
      labelSelector: { matchLabels: { "app.kubernetes.io/component": "app" } },
      topologyKey: "kubernetes.io/hostname",
    });
    expect(env(job)).toMatchObject({ S3_BUCKET: "powerhouse-env-dumps", S3_KEY: "calm-bat-t1/data/abc123.tar.zst" });
    expect(pod.containers[0].args).toEqual([ARCHIVE_SCRIPT]);
    expect(ARCHIVE_SCRIPT).toContain("--exclude=./lost+found");
    expect(ARCHIVE_SCRIPT).toContain("ARCHIVE_SHA256=");
    expect(admitted(job)).toBe(true);
    // Nothing to be next to when the app is stopped.
    expect(buildArchiveJob({ ...base, archiveId: "abc123", colocate: false }).spec!.template.spec!.affinity).toBeUndefined();
  });
});

describe("the /data restore Job", () => {
  it("checks the checksum before it empties /data, mounts it read-write, and is not a dump or archive Job", () => {
    const job = buildDataRestoreJob({ ...base, restoreId: "r-1", archiveId: "abc123", sha256: "d".repeat(64) });
    expect(job.metadata!.name).toBe("datarestore-r-1");
    expect(job.metadata!.labels).toEqual({
      "app.kubernetes.io/managed-by": "vetra-cloud-observability",
      "vetra.io/kind": "data-restore",
      "vetra.io/restore-id": "r-1",
    });
    const pod = job.spec!.template.spec!;
    expect(pod.volumes![0].persistentVolumeClaim!.readOnly).toBe(false);
    expect(pod.containers[0].volumeMounts![0].readOnly).toBe(false);
    expect(pod.affinity).toBeUndefined();
    expect(env(job)).toMatchObject({ S3_KEY: "calm-bat-t1/data/abc123.tar.zst", ARCHIVE_SHA256: "d".repeat(64) });
    expect(DATA_RESTORE_SCRIPT.indexOf("checksum mismatch")).toBeLessThan(DATA_RESTORE_SCRIPT.indexOf("rm -rf"));
    expect(admitted(job)).toBe(true);
  });

  it("reads the checksum from the archive Job's log", () => {
    expect(parseArchiveSha256(`tar: ./x: file changed as we read it\nARCHIVE_SHA256=${"a".repeat(64)}\n`)).toBe("a".repeat(64));
    expect(parseArchiveSha256("ARCHIVE_SHA256=\n")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-cloud-observability/__tests__/archive-job-spec.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement.** Create `dumps/archive-job-spec.ts`:

```ts
import type { V1EnvVar, V1Job } from "@kubernetes/client-node";
import { archiveKey } from "./archive-repo.js";

const MANAGED_BY = "vetra-cloud-observability";
/** The host image's user and the chart's app fsGroup: /data's files are its own. */
export const APP_UID = 1000;
/** The chart's label on the host-image Deployment, its pods and its data PVC. */
export const APP_LABELS = { "app.kubernetes.io/component": "app" } as const;

export type DataJobInput = {
  tenantNs: string;
  pvcName: string;
  /** pgdump-uploader >= 1.1.0 (GNU tar, zstd, s5cmd). */
  image: string;
  bucket: string;
  s3Endpoint: string;
  /** Inline, as for the dump Job (see buildDumpJob's note on the threat model). */
  s3AccessKey: string;
  s3SecretKey: string;
};
export type BuildArchiveJobInput = DataJobInput & {
  archiveId: string;
  /** The app pod runs: the RWO volume is attached to its node, so the Job must run there. */
  colocate: boolean;
};
export type BuildDataRestoreJobInput = DataJobInput & {
  restoreId: string;
  archiveId: string;
  /** data_archives.sha256: checked before /data is touched. */
  sha256: string;
};

/**
 * Streams /data to S3 as tar+zstd and prints the stored object's sha256.
 * GNU tar exits 1 when a file changed while it was read (the app keeps
 * running, decision B3); that is accepted, anything else fails the Job.
 */
export const ARCHIVE_SCRIPT = [
  "set -eu -o pipefail",
  "mkfifo /tmp/sum.fifo",
  "sha256sum < /tmp/sum.fifo > /tmp/sum &",
  "SUM_PID=$!",
  "{ tar --exclude=./lost+found -C /data -cf - . || [ $? -eq 1 ]; }" +
    " | zstd -q -3 -T0" +
    " | tee /tmp/sum.fifo" +
    ' | s5cmd --endpoint-url "$S3_ENDPOINT" pipe "s3://$S3_BUCKET/$S3_KEY"',
  'wait "$SUM_PID"',
  'echo "ARCHIVE_SHA256=$(cut -d" " -f1 /tmp/sum)"',
].join("\n");

/**
 * Replaces /data with an archive. The checksum is checked on a first
 * download, before anything is deleted; a mismatch leaves /data as it was.
 * The app is stopped while this runs (backups/restore.ts).
 */
export const DATA_RESTORE_SCRIPT = [
  "set -eu -o pipefail",
  'SRC="s3://$S3_BUCKET/$S3_KEY"',
  'GOT=$(s5cmd --endpoint-url "$S3_ENDPOINT" cat "$SRC" | sha256sum | cut -d" " -f1)',
  'if [ "$GOT" != "$ARCHIVE_SHA256" ]; then echo "archive checksum mismatch: $GOT"; exit 1; fi',
  "find /data -mindepth 1 -maxdepth 1 ! -name lost+found -exec rm -rf {} +",
  's5cmd --endpoint-url "$S3_ENDPOINT" cat "$SRC" | zstd -q -d | tar --no-same-owner -x -C /data -f -',
  'echo "data restore complete"',
].join("\n");

export function parseArchiveSha256(logs: string): string | null {
  return /^ARCHIVE_SHA256=([0-9a-f]{64})\s*$/m.exec(logs)?.[1] ?? null;
}

function s3Env(i: DataJobInput, key: string): V1EnvVar[] {
  return [
    { name: "S3_BUCKET", value: i.bucket },
    { name: "S3_KEY", value: key },
    { name: "S3_ENDPOINT", value: i.s3Endpoint },
    { name: "AWS_ACCESS_KEY_ID", value: i.s3AccessKey },
    { name: "AWS_SECRET_ACCESS_KEY", value: i.s3SecretKey },
  ];
}

/** One Job shape for both directions; it stays inside the admission policy (Task 16). */
function dataJob(o: {
  name: string;
  input: DataJobInput;
  labels: Record<string, string>;
  script: string;
  env: V1EnvVar[];
  readOnly: boolean;
  colocate: boolean;
}): V1Job {
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name: o.name, namespace: o.input.tenantNs, labels: o.labels },
    spec: {
      ttlSecondsAfterFinished: 600,
      backoffLimit: 0,
      activeDeadlineSeconds: 3600,
      template: {
        metadata: { labels: o.labels },
        spec: {
          restartPolicy: "Never",
          serviceAccountName: "default",
          imagePullSecrets: [{ name: "harbor-credentials" }],
          securityContext: {
            runAsNonRoot: true,
            runAsUser: APP_UID,
            runAsGroup: APP_UID,
            fsGroup: APP_UID,
            // A large /data is not re-chowned on every mount.
            fsGroupChangePolicy: "OnRootMismatch",
          },
          ...(o.colocate
            ? {
                affinity: {
                  podAffinity: {
                    requiredDuringSchedulingIgnoredDuringExecution: [
                      {
                        labelSelector: { matchLabels: { ...APP_LABELS } },
                        topologyKey: "kubernetes.io/hostname",
                      },
                    ],
                  },
                },
              }
            : {}),
          volumes: [
            {
              name: "app-data",
              persistentVolumeClaim: { claimName: o.input.pvcName, readOnly: o.readOnly },
            },
          ],
          containers: [
            {
              name: "data",
              image: o.input.image,
              command: ["/bin/sh", "-c"],
              args: [o.script],
              env: o.env,
              volumeMounts: [{ name: "app-data", mountPath: "/data", readOnly: o.readOnly }],
              securityContext: { allowPrivilegeEscalation: false },
              resources: {
                requests: { cpu: "200m", memory: "256Mi" },
                limits: { cpu: "1", memory: "1Gi" },
              },
            },
          ],
        },
      },
    },
  };
}

export function buildArchiveJob(input: BuildArchiveJobInput): V1Job {
  return dataJob({
    name: `dataarchive-${input.archiveId}`,
    input,
    labels: { "app.kubernetes.io/managed-by": MANAGED_BY, "vetra.io/archive-id": input.archiveId },
    script: ARCHIVE_SCRIPT,
    env: s3Env(input, archiveKey(input.tenantNs, input.archiveId)),
    readOnly: true,
    colocate: input.colocate,
  });
}

/**
 * Labelled vetra.io/kind=data-restore and never with a dump or archive id,
 * so the Job watcher ignores it; vetra-apps polls it by name.
 */
export function buildDataRestoreJob(input: BuildDataRestoreJobInput): V1Job {
  return dataJob({
    name: `datarestore-${input.restoreId}`,
    input,
    labels: {
      "app.kubernetes.io/managed-by": MANAGED_BY,
      "vetra.io/kind": "data-restore",
      "vetra.io/restore-id": input.restoreId,
    },
    script: DATA_RESTORE_SCRIPT,
    env: [
      ...s3Env(input, archiveKey(input.tenantNs, input.archiveId)),
      { name: "ARCHIVE_SHA256", value: input.sha256 },
    ],
    readOnly: false,
    colocate: false,
  });
}
```

  Create `dumps/archive-service.ts`:

```ts
import type { V1Job } from "@kubernetes/client-node";
import type { DataArchives } from "../db/schema.js";
import { buildArchiveJob } from "./archive-job-spec.js";
import type { ArchivesRepo, CreateArchiveInput } from "./archive-repo.js";

export type ArchiveJobDeps = {
  repo: ArchivesRepo;
  createJob: (namespace: string, body: V1Job) => Promise<string>;
  image: string;
  bucket: string;
  s3Endpoint: string;
  s3AccessKey: string;
  s3SecretKey: string;
};

/**
 * Inserts a PENDING archive row and creates its Job. Throws
 * ARCHIVE_IN_PROGRESS when the tenant already has one in flight; a Job
 * creation failure marks the row FAILED and rethrows (as createDumpAndJob).
 */
export async function createArchiveAndJob(
  deps: ArchiveJobDeps,
  input: CreateArchiveInput & { colocate: boolean },
): Promise<DataArchives> {
  const archive = await deps.repo.create(input);
  const job = buildArchiveJob({
    archiveId: archive.id,
    tenantNs: input.tenantId,
    pvcName: input.pvcName,
    colocate: input.colocate,
    image: deps.image,
    bucket: deps.bucket,
    s3Endpoint: deps.s3Endpoint,
    s3AccessKey: deps.s3AccessKey,
    s3SecretKey: deps.s3SecretKey,
  });
  try {
    const name = await deps.createJob(input.tenantId, job);
    await deps.repo.setJobName(archive.id, name || `dataarchive-${archive.id}`);
  } catch (err) {
    await deps.repo.markFailed(
      archive.id,
      err instanceof Error ? err.message : "createJob failed",
      input.now,
    );
    throw err;
  }
  return archive;
}
```

- [ ] **Step 4: Run it again.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** `git add subgraphs/vetra-cloud-observability && git commit -m "feat(dumps): /data archive and restore Jobs" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 4: The Job watcher reconciles archives

**Files:**
- Create: `subgraphs/vetra-cloud-observability/dumps/archive-watcher.ts`, `subgraphs/vetra-cloud-observability/dumps/job-watch.ts`
- Modify: `subgraphs/vetra-cloud-observability/dumps/k8s-client.ts`, `subgraphs/vetra-cloud-observability/index.ts`
- Test: `subgraphs/vetra-cloud-observability/__tests__/archive-watcher.test.ts`, `subgraphs/vetra-cloud-observability/__tests__/dumps-job-watch.test.ts`

**Interfaces:**
- Produces:
  - `reconcileArchiveJob(input)`:
    - Complete with an `ARCHIVE_SHA256=` line and the object in the bucket → READY with its size and checksum;
    - Complete without either → FAILED (a restore could not trust it);
    - Failed → FAILED with the log's last line;
    - Running → RUNNING.
  - `DumpsK8sClient.listManagedJobs(): Promise<Array<{ namespace; name; dumpId: string | null; archiveId: string | null }>>`.
  - `watchJobsOnce(deps: WatchDeps)`: in-flight dumps and archives against their Jobs; rows whose Job vanished after it was named are FAILED.
- Changes: `startDumpJobWatcher` calls `watchJobsOnce`; `startDumpRowPruner` also prunes archives.

- [ ] **Step 1: Write the failing tests.** Create `__tests__/archive-watcher.test.ts`:

```ts
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { up } from "../db/migrations.js";
import type { ObservabilityDB } from "../db/schema.js";
import { ArchivesRepo } from "../dumps/archive-repo.js";
import { reconcileArchiveJob } from "../dumps/archive-watcher.js";

let db: Kysely<ObservabilityDB>;
let repo: ArchivesRepo;
beforeEach(async () => {
  db = new Kysely<ObservabilityDB>({ dialect: new PGliteDialect(new PGlite()) });
  await up(db);
  repo = new ArchivesRepo(db);
});
afterEach(async () => db.destroy());

const now = new Date("2026-11-12T10:00:00.000Z");
const make = () =>
  repo.create({ documentId: "env-1", tenantId: "t-1", requestedBy: "vetra", pvcName: "p-app-data", now });
const run = (id: string, o: { status: object; phase?: string | null; logs?: string; size?: number | null }) =>
  reconcileArchiveJob({
    repo,
    archiveId: id,
    jobName: `dataarchive-${id}`,
    jobStatus: o.status,
    podPhase: o.phase ?? null,
    now,
    headSize: async () => (o.size === undefined ? 42 : o.size),
    readPodLogs: async () => o.logs ?? "",
  });

describe("reconcileArchiveJob", () => {
  it("RUNNING, then READY with the checksum from the log and the object's size", async () => {
    const a = await make();
    await run(a.id, { status: { active: 1 }, phase: "Running" });
    expect((await repo.getById(a.id))!.status).toBe("RUNNING");
    await run(a.id, {
      status: { succeeded: 1, conditions: [{ type: "Complete", status: "True" }] },
      logs: `ARCHIVE_SHA256=${"c".repeat(64)}\n`,
    });
    const r = await repo.getById(a.id);
    expect(r).toMatchObject({ status: "READY", sha256: "c".repeat(64), s3Key: `t-1/data/${a.id}.tar.zst` });
    expect(Number(r!.sizeBytes)).toBe(42);
  });

  it("FAILED when the Job failed, finished without a checksum, or left no object", async () => {
    const a = await make();
    await run(a.id, { status: { failed: 1 }, logs: "s5cmd: access denied\n" });
    expect(await repo.getById(a.id)).toMatchObject({ status: "FAILED", errorMessage: "s5cmd: access denied" });
    const b = await make();
    await run(b.id, { status: { succeeded: 1 }, logs: "done\n" });
    expect((await repo.getById(b.id))!.errorMessage).toMatch(/without a checksum/);
    const c = await make();
    await run(c.id, { status: { succeeded: 1 }, logs: `ARCHIVE_SHA256=${"c".repeat(64)}`, size: null });
    expect((await repo.getById(c.id))!.errorMessage).toMatch(/not in the bucket/);
  });
});
```

Create `__tests__/dumps-job-watch.test.ts`:

```ts
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { up } from "../db/migrations.js";
import type { ObservabilityDB } from "../db/schema.js";
import { ArchivesRepo } from "../dumps/archive-repo.js";
import { watchJobsOnce } from "../dumps/job-watch.js";
import { DumpsRepo } from "../dumps/repo.js";

let db: Kysely<ObservabilityDB>;
beforeEach(async () => {
  db = new Kysely<ObservabilityDB>({ dialect: new PGliteDialect(new PGlite()) });
  await up(db);
});
afterEach(async () => db.destroy());

describe("watchJobsOnce", () => {
  it("reconciles dumps and archives by their labels, and fails rows whose Job vanished", async () => {
    const now = new Date("2026-11-12T10:00:00.000Z");
    const dumps = new DumpsRepo(db);
    const archives = new ArchivesRepo(db);
    const d = await dumps.create({ documentId: "e", tenantId: "t-1", requestedBy: "vetra", now, source: "INSTANCE" });
    const a = await archives.create({ documentId: "e", tenantId: "t-1", requestedBy: "vetra", pvcName: "p-app-data", now });
    const gone = await archives.create({ documentId: "e", tenantId: "t-2", requestedBy: "vetra", pvcName: "p-app-data", now });
    await archives.setJobName(gone.id, `dataarchive-${gone.id}`);
    const done = { succeeded: 1, conditions: [{ type: "Complete", status: "True" }] };
    await watchJobsOnce({
      dumps,
      archives,
      now: () => now,
      headSize: async () => 7,
      k8s: {
        listManagedJobs: async () => [
          { namespace: "t-1", name: `pgdump-${d.id}`, dumpId: d.id, archiveId: null },
          { namespace: "t-1", name: `dataarchive-${a.id}`, dumpId: null, archiveId: a.id },
        ],
        readJobStatus: async () => done,
        readPodPhaseForJob: async () => "Succeeded",
        readPodLogsForJob: async () => `ARCHIVE_SHA256=${"b".repeat(64)}`,
      },
    });
    expect((await dumps.getById(d.id))!.status).toBe("READY");
    expect((await archives.getById(a.id))!.status).toBe("READY");
    expect(await archives.getById(gone.id)).toMatchObject({ status: "FAILED", errorMessage: expect.stringMatching(/no longer exists/) });
  });
});
```

- [ ] **Step 2: Run them.** `npx vitest run subgraphs/vetra-cloud-observability/__tests__/archive-watcher.test.ts subgraphs/vetra-cloud-observability/__tests__/dumps-job-watch.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL (modules not found).
- [ ] **Step 3: Implement.** Create `dumps/archive-watcher.ts`:

```ts
import { archiveKey, type ArchivesRepo } from "./archive-repo.js";
import { parseArchiveSha256 } from "./archive-job-spec.js";

type JobCondition = { type?: string; status?: string; reason?: string };
export type ArchiveJobStatus = {
  active?: number;
  succeeded?: number;
  failed?: number;
  conditions?: JobCondition[];
};

export type ReconcileArchiveInput = {
  repo: ArchivesRepo;
  archiveId: string;
  jobName: string;
  jobStatus: ArchiveJobStatus;
  podPhase: string | null;
  now: Date;
  headSize: (s3Key: string) => Promise<number | null>;
  readPodLogs: (jobName: string) => Promise<string>;
};

const lastLine = (text: string) =>
  text.split(/\r?\n/).filter((l) => l.trim()).at(-1) ?? "";

/**
 * reconcileJob's twin for /data archives, stricter on success: a restore
 * trusts an archive only with its checksum and its object, so a Job that
 * finished without either is FAILED, never READY with size 0.
 */
export async function reconcileArchiveJob(i: ReconcileArchiveInput): Promise<void> {
  const a = await i.repo.getById(i.archiveId);
  if (!a || a.status === "READY" || a.status === "FAILED") return;
  const cond = (type: string) =>
    i.jobStatus.conditions?.some((c) => c.type === type && c.status === "True") ?? false;
  const failed = cond("Failed") || (i.jobStatus.failed ?? 0) > 0;
  const complete = !failed && (cond("Complete") || (i.jobStatus.succeeded ?? 0) > 0);
  if (failed) {
    const logs = await i.readPodLogs(i.jobName).catch(() => "");
    const reason = i.jobStatus.conditions?.find((c) => c.type === "Failed")?.reason;
    await i.repo.markFailed(a.id, lastLine(logs) || reason || "Job failed", i.now);
    return;
  }
  if (complete) {
    const sha = parseArchiveSha256(await i.readPodLogs(i.jobName).catch(() => ""));
    if (!sha) {
      await i.repo.markFailed(a.id, "the archive Job finished without a checksum", i.now);
      return;
    }
    const key = archiveKey(a.tenantId, a.id);
    const size = await i.headSize(key).catch(() => null);
    if (size === null) {
      await i.repo.markFailed(a.id, "the archive is not in the bucket", i.now);
      return;
    }
    await i.repo.markReady(a.id, key, size, sha, i.now);
    return;
  }
  if (i.podPhase === "Running" && a.status === "PENDING") await i.repo.markRunning(a.id, i.jobName, i.now);
}
```

  Create `dumps/job-watch.ts`:

```ts
import type { ArchivesRepo } from "./archive-repo.js";
import { reconcileArchiveJob } from "./archive-watcher.js";
import type { DumpsK8sClient } from "./k8s-client.js";
import type { DumpsRepo } from "./repo.js";
import { reconcileJob } from "./watcher.js";

export type WatchDeps = {
  dumps: DumpsRepo;
  archives: ArchivesRepo;
  k8s: Pick<DumpsK8sClient, "listManagedJobs" | "readJobStatus" | "readPodPhaseForJob" | "readPodLogsForJob">;
  headSize: (s3Key: string) => Promise<number | null>;
  now: () => Date;
};

const gone = (name: string, ns: string, what: string) =>
  `Job "${name}" no longer exists in namespace ${ns}; orphaned ${what} marked failed.`;

/**
 * One tick of the dumps Job watcher: every in-flight database dump and /data
 * archive against its Job (matched by label, so a restart resumes). A row
 * whose Job was named but is gone is FAILED; a row without a Job name yet is
 * left for the next tick (its creator is between insert and createJob).
 */
export async function watchJobsOnce(deps: WatchDeps): Promise<void> {
  const dumps = await deps.dumps.listInFlight();
  const archives = await deps.archives.listInFlight();
  if (dumps.length === 0 && archives.length === 0) return;
  const managed = await deps.k8s.listManagedJobs();
  const byDump = new Map(managed.filter((j) => j.dumpId).map((j) => [j.dumpId!, j]));
  const byArchive = new Map(managed.filter((j) => j.archiveId).map((j) => [j.archiveId!, j]));

  for (const dump of dumps) {
    const ref = byDump.get(dump.id);
    if (!ref) {
      if (dump.jobName) await deps.dumps.markFailed(dump.id, gone(dump.jobName, dump.tenantId, "dump"), deps.now());
      continue;
    }
    const status = await deps.k8s.readJobStatus(ref.namespace, ref.name);
    if (!status) continue;
    await reconcileJob({
      repo: deps.dumps,
      dumpId: dump.id,
      jobName: ref.name,
      jobStatus: status,
      podPhase: await deps.k8s.readPodPhaseForJob(ref.namespace, ref.name),
      now: deps.now(),
      headSize: deps.headSize,
      readPodLogs: () => deps.k8s.readPodLogsForJob(ref.namespace, ref.name),
    });
  }

  for (const archive of archives) {
    const ref = byArchive.get(archive.id);
    if (!ref) {
      if (archive.jobName)
        await deps.archives.markFailed(archive.id, gone(archive.jobName, archive.tenantId, "archive"), deps.now());
      continue;
    }
    const status = await deps.k8s.readJobStatus(ref.namespace, ref.name);
    if (!status) continue;
    await reconcileArchiveJob({
      repo: deps.archives,
      archiveId: archive.id,
      jobName: ref.name,
      jobStatus: status,
      podPhase: await deps.k8s.readPodPhaseForJob(ref.namespace, ref.name),
      now: deps.now(),
      headSize: deps.headSize,
      readPodLogs: () => deps.k8s.readPodLogsForJob(ref.namespace, ref.name),
    });
  }
}
```

  In `dumps/k8s-client.ts` change `listManagedJobs`'s declared return type to `Promise<Array<{ namespace: string; name: string; dumpId: string | null; archiveId: string | null }>>` and its implementation's mapping to:

```ts
      return res.items
        .map((j) => ({
          namespace: j.metadata?.namespace ?? "",
          name: j.metadata?.name ?? "",
          dumpId: j.metadata?.labels?.["vetra.io/dump-id"] ?? null,
          archiveId: j.metadata?.labels?.["vetra.io/archive-id"] ?? null,
        }))
        .filter((j) => j.name && (j.dumpId || j.archiveId));
```

  In `index.ts`:
  - import `ArchivesRepo` from `./dumps/archive-repo.js` and `watchJobsOnce` from `./dumps/job-watch.js`;
  - add a field `private archivesRepo: ArchivesRepo | null = null;`;
  - in `buildDumpDeps` set `this.archivesRepo = new ArchivesRepo(db);` next to `this.dumpsRepo = repo;`;
  - in `startDumpJobWatcher` replace everything inside the tick's `try { … }` with:

```ts
        const archives = this.archivesRepo;
        if (!archives) return;
        await watchJobsOnce({
          dumps: repo,
          archives,
          k8s,
          headSize: (key) => s3.headSize(key),
          now: () => new Date(),
        });
```

  - in `startDumpRowPruner` after `const removed = await repo.pruneExpired(new Date());` add `const archived = (await this.archivesRepo?.pruneExpired(new Date())) ?? 0;` and log `removed + archived`.
  - `reconcileJob` is no longer imported by `index.ts`; drop that import.
- [ ] **Step 4: Run them again.** Same command, then `npx vitest run subgraphs/vetra-cloud-observability 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add subgraphs/vetra-cloud-observability && git commit -m "feat(dumps): the Job watcher reconciles /data archives" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 5: Config (`VETRA_APPS_BACKUPS`)

**Files:**
- Modify: `subgraphs/vetra-apps/config.ts`
- Test: `subgraphs/vetra-apps/__tests__/config.test.ts`

**Interfaces:**
- Produces:
  - `BackupsConfig { enabled; dailyKeepDays; maxInFlight }`;
  - `DEFAULT_BACKUPS = { enabled: false, dailyKeepDays: 14, maxInFlight: 3 }`;
  - `backupsConfigOf(cfg)`;
  - `VetraAppsConfig.backups?: BackupsConfig`;
  - `loadAppsConfig(env).backups`.

- [ ] **Step 1: Write the failing test.** Append to `config.test.ts`:

```ts
describe("backups config (releases phase 3 slice 4)", () => {
  it("is off by default and validated", () => {
    expect(loadAppsConfig({}).backups).toEqual({ enabled: false, dailyKeepDays: 14, maxInFlight: 3 });
    expect(
      loadAppsConfig({
        VETRA_APPS_BACKUPS: "on",
        VETRA_APPS_BACKUP_DAILY_KEEP_DAYS: "7",
        VETRA_APPS_BACKUP_MAX_IN_FLIGHT: "5",
      }).backups,
    ).toEqual({ enabled: true, dailyKeepDays: 7, maxInFlight: 5 });
    expect(() => loadAppsConfig({ VETRA_APPS_BACKUPS: "maybe" })).toThrow(/VETRA_APPS_BACKUPS/);
    // The dumps bucket deletes everything after 30 days.
    expect(() => loadAppsConfig({ VETRA_APPS_BACKUP_DAILY_KEEP_DAYS: "31" })).toThrow(/KEEP_DAYS/);
    expect(() => loadAppsConfig({ VETRA_APPS_BACKUP_MAX_IN_FLIGHT: "0" })).toThrow(/MAX_IN_FLIGHT/);
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/config.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL.
- [ ] **Step 3: Implement.** In `config.ts`:
  - add to `VetraAppsConfig` after `plans?`:

```ts
  /**
   * Releases phase 3 slice 4: instance backups. Absent = off.
   * VETRA_APPS_BACKUPS=on backs up before every rollout step, runs daily
   * backups and lets a rollback of a release that migrates restore.
   */
  backups?: BackupsConfig;
```

  - after `plansConfigOf`:

```ts
export interface BackupsConfig {
  enabled: boolean;
  /** VETRA_APPS_BACKUP_DAILY_KEEP_DAYS (1-30, default 14): the dumps bucket deletes everything after 30. */
  dailyKeepDays: number;
  /** VETRA_APPS_BACKUP_MAX_IN_FLIGHT (1-10, default 3): instance backups running at once, cluster-wide. */
  maxInFlight: number;
}
export const DEFAULT_BACKUPS: BackupsConfig = { enabled: false, dailyKeepDays: 14, maxInFlight: 3 };
export const backupsConfigOf = (cfg: VetraAppsConfig): BackupsConfig =>
  cfg.backups ?? DEFAULT_BACKUPS;
```

  - after `plansConfig`:

```ts
function backupsConfig(env: Env): BackupsConfig {
  const raw = (trimmed(env.VETRA_APPS_BACKUPS) ?? "").toLowerCase();
  if (!INSTANCES_OFF.has(raw) && !INSTANCES_ON.has(raw)) {
    throw new Error(
      `VETRA_APPS_BACKUPS "${env.VETRA_APPS_BACKUPS}" is invalid: use on/off (also true/false, 1/0, yes/no)`,
    );
  }
  return {
    // Unset means off, as for plans.
    enabled: raw !== "" && INSTANCES_ON.has(raw),
    dailyKeepDays: intIn(env, "VETRA_APPS_BACKUP_DAILY_KEEP_DAYS", 14, 1, 30),
    maxInFlight: intIn(env, "VETRA_APPS_BACKUP_MAX_IN_FLIGHT", 3, 1, 10),
  };
}
```

  - in `loadAppsConfig` after `plans: plansConfig(env),` add `backups: backupsConfig(env),`.
- [ ] **Step 4: Run it again.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** `git add subgraphs/vetra-apps/config.ts subgraphs/vetra-apps/__tests__/config.test.ts && git commit -m "feat(backups): VETRA_APPS_BACKUPS config" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 6: Backup and restore tables, `instances.maintenance`, the repo, audit actions

**Files:**
- Modify: `subgraphs/vetra-apps/db/schema.ts`, `subgraphs/vetra-apps/db/migrations.ts`, `subgraphs/vetra-apps/audit/repo.ts`
- Create: `subgraphs/vetra-apps/backups/repo.ts`
- Test: `subgraphs/vetra-apps/__tests__/migrations.test.ts`, `subgraphs/vetra-apps/__tests__/backups-repo.test.ts`

**Interfaces:**
- Produces (schema):
  - `BackupReason`, `InstanceBackupStatus`, `InstanceBackupsTable`;
  - `RestorePurpose`, `InstanceRestoreStatus`, `InstanceRestoresTable`;
  - `VetraAppsDB.instance_backups`, `.instance_restores`;
  - `InstancesTable.maintenance?: string | null`.
- Produces (migrations): `ensureInstanceBackupTables(db)` at the end of `up`.
- Produces (audit): `backup.requested`, `backup.failed`, `restore.started`, `restore.finished`.
- Produces (`backups/repo.ts`):
  - `InstanceBackupRow`, `InstanceRestoreRow`, `ACTIVE_RESTORE`;
  - backups: `insertBackup`, `getBackup`, `updateBackup`, `listBackupsOfInstance`, `pendingBackupsOfApp`, `countPendingBackups`, `lastBackupOf`, `sweepableBackups`, `deleteBackup`;
  - restores: `insertRestore`, `getRestore`, `updateRestore`, `activeRestoresOfApp`, `listRestoresOfInstance`.

- [ ] **Step 1: Write the failing tests.** In `migrations.test.ts` add `ensureInstanceBackupTables` to the import from `../db/migrations.js`, and append:

```ts
describe("instance backup tables", () => {
  it("are created idempotently and concurrently, with instances.maintenance and one active restore per instance", async () => {
    const root = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
    try {
      await sql`CREATE SCHEMA "vetra-apps"`.execute(root);
      const any = root.withSchema("vetra-apps");
      await up(any);
      await Promise.all([1, 2, 3].map(() => ensureInstanceBackupTables(any)));
      const cols = (
        await sql<{ column_name: string }>`select column_name from information_schema.columns where table_schema = 'vetra-apps' and table_name = 'instances'`.execute(root)
      ).rows.map((r) => r.column_name);
      expect(cols).toContain("maintenance");
      const at = "2026-11-12T00:00:00.000Z";
      const restore = (id: string, status: string) => ({
        id,
        app_id: "app-1",
        instance_id: "i-1",
        environment_id: "env-1",
        tenant_id: "t-1",
        backup_id: "b-1",
        safety_backup_id: null,
        purpose: "manual",
        then_version: null,
        data: true,
        status,
        phase_started_at: at,
        db_job: null,
        data_job: null,
        replicas: null,
        target_set: false,
        was_held: false,
        error: null,
        held: false,
        requested_by: "vetra",
        rollout_step_id: null,
        created_at: at,
        updated_at: at,
        finished_at: null,
      });
      await any.insertInto("instance_restores").values(restore("r0", "failed")).execute();
      await any.insertInto("instance_restores").values(restore("r1", "stopping")).execute();
      await expect(
        any.insertInto("instance_restores").values(restore("r2", "safety_backup")).execute(),
      ).rejects.toMatchObject({ code: "23505" });
    } finally {
      await root.destroy();
    }
  });
});
```

Create `__tests__/backups-repo.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHarness, type Harness } from "./harness.js";
import {
  insertBackup,
  insertRestore,
  lastBackupOf,
  sweepableBackups,
  type InstanceBackupRow,
} from "../backups/repo.js";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.close();
});

const backup = (id: string, over: Partial<InstanceBackupRow> = {}): InstanceBackupRow => ({
  id,
  app_id: "app-1",
  instance_id: "i-1",
  environment_id: "env-1",
  tenant_id: "t-1",
  reason: "daily",
  version: "1.4.0",
  digest: null,
  dump_id: `d-${id}`,
  archive_id: `a-${id}`,
  status: "ready",
  error: null,
  size_bytes: 10,
  requested_by: "vetra",
  rollout_step_id: null,
  created_at: "2026-11-01T00:00:00.000Z",
  updated_at: "2026-11-01T00:00:00.000Z",
  finished_at: null,
  expires_at: "2026-11-15T00:00:00.000Z",
  ...over,
});

describe("backups repo", () => {
  it("finds the newest backup of a reason, and sweeps expired and old failed backups but never one a restore uses", async () => {
    await insertBackup(h.db, backup("old", { created_at: "2026-10-01T00:00:00.000Z", expires_at: "2026-10-15T00:00:00.000Z" }));
    await insertBackup(h.db, backup("used", { created_at: "2026-10-02T00:00:00.000Z", expires_at: "2026-10-16T00:00:00.000Z" }));
    await insertBackup(h.db, backup("failed", { status: "failed", created_at: "2026-11-10T00:00:00.000Z" }));
    await insertBackup(h.db, backup("pending", { status: "pending", expires_at: "2026-10-01T00:00:00.000Z" }));
    await insertBackup(h.db, backup("fresh", { created_at: "2026-11-12T00:00:00.000Z", reason: "manual" }));
    await insertRestore(h.db, {
      id: "r-1",
      app_id: "app-1",
      instance_id: "i-1",
      environment_id: "env-1",
      tenant_id: "t-1",
      backup_id: "used",
      safety_backup_id: null,
      purpose: "manual",
      then_version: null,
      data: true,
      status: "restoring_db",
      phase_started_at: "2026-11-12T00:00:00.000Z",
      db_job: null,
      data_job: null,
      replicas: null,
      target_set: false,
      was_held: false,
      error: null,
      held: false,
      requested_by: "vetra",
      rollout_step_id: null,
      created_at: "2026-11-12T00:00:00.000Z",
      updated_at: "2026-11-12T00:00:00.000Z",
      finished_at: null,
    });
    expect((await lastBackupOf(h.db, "i-1", "daily"))?.id).toBe("failed"); // newest daily, whatever its status
    expect((await lastBackupOf(h.db, "i-1", "manual"))?.id).toBe("fresh");
    const sweep = await sweepableBackups(h.db, "2026-11-12T12:00:00.000Z", "2026-11-11T12:00:00.000Z", 10);
    expect(sweep.map((b) => b.id)).toEqual(["old", "failed"]);
    expect(sweep[0].size_bytes).toBe(10);
  });
});
```

- [ ] **Step 2: Run them.** `npx vitest run subgraphs/vetra-apps/__tests__/migrations.test.ts subgraphs/vetra-apps/__tests__/backups-repo.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `db/schema.ts`, after `InstancesTable`:

```ts
/** Why an instance backup was taken (releases phase 3 slice 4). */
export type BackupReason = "pre_update" | "daily" | "manual" | "pre_restore" | "pre_stop";
export type InstanceBackupStatus = "pending" | "ready" | "failed";

/**
 * One backup of a shared or own instance: a database dump and a /data
 * archive (observability's database_dumps and data_archives), taken
 * together, restored only into the instance it was taken from.
 */
export interface InstanceBackupsTable {
  id: string;
  app_id: string;
  instance_id: string;
  environment_id: string;
  tenant_id: string;
  reason: BackupReason;
  /** What the instance ran when the backup started (running_version, running_digest). */
  version: string | null;
  digest: string | null;
  dump_id: string | null;
  archive_id: string | null;
  status: InstanceBackupStatus;
  error: string | null;
  /** Dump + archive bytes (bigint). */
  size_bytes: number | null;
  /** An address, or "vetra". */
  requested_by: string;
  /** pre_update: the rollout step it was taken for. */
  rollout_step_id: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  expires_at: string;
}

export type RestorePurpose = "rollback" | "failed_update" | "manual";
export type InstanceRestoreStatus =
  | "safety_backup"
  | "stopping"
  | "restoring_db"
  | "restoring_data"
  | "starting"
  | "succeeded"
  | "failed";

/** A restore of an instance backup, advanced one phase per reconciler pass (backups/restore.ts). */
export interface InstanceRestoresTable {
  id: string;
  app_id: string;
  instance_id: string;
  environment_id: string;
  tenant_id: string;
  backup_id: string;
  /** The pre_restore backup of what is replaced; null until it could start. */
  safety_backup_id: string | null;
  purpose: RestorePurpose;
  /** The release the instance targets and runs afterwards; null: unchanged. */
  then_version: string | null;
  /** Restore /data too. */
  data: boolean;
  status: InstanceRestoreStatus;
  /** When the current phase began (its timeout clock). */
  phase_started_at: string;
  db_job: string | null;
  data_job: string | null;
  /** JSON { [deployment]: replicas } recorded before scaling to 0 (at least 1 each). */
  replicas: string | null;
  /** The instance was handed back with then_version. */
  target_set: boolean;
  /** The instance was held (a failed restore) when this one began: an early failure keeps it held. */
  was_held: boolean;
  error: string | null;
  /** Failed with /data possibly half restored: the instance stays stopped. */
  held: boolean;
  requested_by: string;
  rollout_step_id: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}
```

    and in `InstancesTable`, before `created_at`:

```ts
  /** `restore:<id>` while a restore owns the instance; `held:<id>` after a failed one (stays stopped). The reconciler leaves it alone. */
  maintenance?: string | null;
```

    and add `instance_backups: InstanceBackupsTable; instance_restores: InstanceRestoresTable;` to `VetraAppsDB`.
  - `db/migrations.ts`: at the end of `up` add `await ensureInstanceBackupTables(db);`, and:

```ts
/** Instance backups and restores, instances.maintenance (releases phase 3 slice 4). Schema builder only (namespaced). */
export async function ensureInstanceBackupTables(db: Kysely<any>): Promise<void> {
  try {
    await db.schema
      .createTable("instance_backups")
      .ifNotExists()
      .addColumn("id", "varchar(64)", (c) => c.primaryKey())
      .addColumn("app_id", "varchar(255)", (c) => c.notNull())
      .addColumn("instance_id", "varchar(64)", (c) => c.notNull())
      .addColumn("environment_id", "varchar(255)", (c) => c.notNull())
      .addColumn("tenant_id", "varchar(255)", (c) => c.notNull())
      .addColumn("reason", "varchar(16)", (c) => c.notNull())
      .addColumn("version", "varchar(255)")
      .addColumn("digest", "varchar(255)")
      .addColumn("dump_id", "varchar(64)")
      .addColumn("archive_id", "varchar(64)")
      .addColumn("status", "varchar(16)", (c) => c.notNull())
      .addColumn("error", "text")
      .addColumn("size_bytes", "bigint")
      .addColumn("requested_by", "varchar(255)", (c) => c.notNull())
      .addColumn("rollout_step_id", "varchar(64)")
      .addColumn("created_at", "varchar(64)", (c) => c.notNull())
      .addColumn("updated_at", "varchar(64)", (c) => c.notNull())
      .addColumn("finished_at", "varchar(64)")
      .addColumn("expires_at", "varchar(64)", (c) => c.notNull())
      .execute();
  } catch (err) {
    if (!isConcurrentIndexError(err)) throw err;
  }
  try {
    await db.schema
      .createTable("instance_restores")
      .ifNotExists()
      .addColumn("id", "varchar(64)", (c) => c.primaryKey())
      .addColumn("app_id", "varchar(255)", (c) => c.notNull())
      .addColumn("instance_id", "varchar(64)", (c) => c.notNull())
      .addColumn("environment_id", "varchar(255)", (c) => c.notNull())
      .addColumn("tenant_id", "varchar(255)", (c) => c.notNull())
      .addColumn("backup_id", "varchar(64)", (c) => c.notNull())
      .addColumn("safety_backup_id", "varchar(64)")
      .addColumn("purpose", "varchar(16)", (c) => c.notNull())
      .addColumn("then_version", "varchar(255)")
      .addColumn("data", "boolean", (c) => c.notNull())
      .addColumn("status", "varchar(16)", (c) => c.notNull())
      .addColumn("phase_started_at", "varchar(64)", (c) => c.notNull())
      .addColumn("db_job", "varchar(255)")
      .addColumn("data_job", "varchar(255)")
      .addColumn("replicas", "text")
      .addColumn("target_set", "boolean", (c) => c.notNull())
      .addColumn("was_held", "boolean", (c) => c.notNull())
      .addColumn("error", "text")
      .addColumn("held", "boolean", (c) => c.notNull())
      .addColumn("requested_by", "varchar(255)", (c) => c.notNull())
      .addColumn("rollout_step_id", "varchar(64)")
      .addColumn("created_at", "varchar(64)", (c) => c.notNull())
      .addColumn("updated_at", "varchar(64)", (c) => c.notNull())
      .addColumn("finished_at", "varchar(64)")
      .execute();
  } catch (err) {
    if (!isConcurrentIndexError(err)) throw err;
  }
  for (const [name, table, columns] of [
    ["instance_backups_instance_idx", "instance_backups", ["instance_id", "created_at"]],
    ["instance_backups_status_idx", "instance_backups", ["status", "expires_at"]],
    ["instance_restores_instance_idx", "instance_restores", ["instance_id", "created_at"]],
  ] as const) {
    try {
      await db.schema.createIndex(name).ifNotExists().on(table).columns([...columns]).execute();
    } catch (err) {
      if (!isConcurrentIndexError(err)) throw err;
    }
  }
  try {
    // One active restore per instance.
    await db.schema
      .createIndex("instance_restores_active_uq")
      .ifNotExists()
      .unique()
      .on("instance_restores")
      .column("instance_id")
      .where((eb) => eb.and([eb("status", "!=", "succeeded"), eb("status", "!=", "failed")]))
      .execute();
  } catch (err) {
    if (!isConcurrentIndexError(err)) throw err;
  }
  try {
    await db.schema
      .alterTable("instances")
      .addColumn("maintenance", "varchar(255)", (c) => c.ifNotExists())
      .execute();
  } catch (err) {
    if (!isConcurrentIndexError(err) && !isDuplicateColumnError(err)) throw err;
  }
}
```

  - `audit/repo.ts`: append to `AUDIT_ACTIONS` (after slice 3's): `"backup.requested", "backup.failed", "restore.started", "restore.finished",`.
  - Create `backups/repo.ts`:

```ts
import type { Insertable, Kysely, Selectable, Updateable } from "kysely";
import type {
  BackupReason,
  InstanceBackupsTable,
  InstanceRestoresTable,
  InstanceRestoreStatus,
  VetraAppsDB,
} from "../db/schema.js";

export type InstanceBackupRow = Selectable<InstanceBackupsTable>;
export type InstanceRestoreRow = Selectable<InstanceRestoresTable>;
export type BackupPatch = Omit<Updateable<InstanceBackupsTable>, "id" | "updated_at">;
export type RestorePatch = Omit<Updateable<InstanceRestoresTable>, "id" | "updated_at">;

/** Restores that still own their instance (instance_restores_active_uq). */
export const ACTIVE_RESTORE: InstanceRestoreStatus[] = [
  "safety_backup",
  "stopping",
  "restoring_db",
  "restoring_data",
  "starting",
];

/** size_bytes is bigint: drivers may return a string. */
const nb = (r: InstanceBackupRow): InstanceBackupRow => ({
  ...r,
  size_bytes: r.size_bytes == null ? null : Number(r.size_bytes),
});

export async function insertBackup(
  db: Kysely<VetraAppsDB>,
  row: Insertable<InstanceBackupsTable>,
): Promise<InstanceBackupRow> {
  return nb(await db.insertInto("instance_backups").values(row).returningAll().executeTakeFirstOrThrow());
}

export async function getBackup(db: Kysely<VetraAppsDB>, id: string): Promise<InstanceBackupRow | null> {
  const r = await db.selectFrom("instance_backups").selectAll().where("id", "=", id).executeTakeFirst();
  return r ? nb(r) : null;
}

export async function updateBackup(
  db: Kysely<VetraAppsDB>,
  id: string,
  patch: BackupPatch,
  nowIso: string,
): Promise<InstanceBackupRow> {
  return nb(
    await db
      .updateTable("instance_backups")
      .set({ ...patch, updated_at: nowIso })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow(),
  );
}

export async function listBackupsOfInstance(
  db: Kysely<VetraAppsDB>,
  instanceId: string,
  limit: number,
): Promise<InstanceBackupRow[]> {
  return (
    await db
      .selectFrom("instance_backups")
      .selectAll()
      .where("instance_id", "=", instanceId)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(limit)
      .execute()
  ).map(nb);
}

export async function pendingBackupsOfApp(db: Kysely<VetraAppsDB>, appId: string): Promise<InstanceBackupRow[]> {
  return (
    await db
      .selectFrom("instance_backups")
      .selectAll()
      .where("app_id", "=", appId)
      .where("status", "=", "pending")
      .orderBy("created_at")
      .execute()
  ).map(nb);
}

export async function countPendingBackups(db: Kysely<VetraAppsDB>): Promise<number> {
  const r = await db
    .selectFrom("instance_backups")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("status", "=", "pending")
    .executeTakeFirstOrThrow();
  return Number(r.n);
}

/** The newest backup of a reason, whatever its status. */
export async function lastBackupOf(
  db: Kysely<VetraAppsDB>,
  instanceId: string,
  reason: BackupReason,
): Promise<InstanceBackupRow | null> {
  const r = await db
    .selectFrom("instance_backups")
    .selectAll()
    .where("instance_id", "=", instanceId)
    .where("reason", "=", reason)
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .executeTakeFirst();
  return r ? nb(r) : null;
}

/**
 * Backups the sweep deletes: expired, or failed before `failedBeforeIso`;
 * never a pending one, and never one an active restore restores or keeps
 * as its safety copy.
 */
export async function sweepableBackups(
  db: Kysely<VetraAppsDB>,
  nowIso: string,
  failedBeforeIso: string,
  limit: number,
): Promise<InstanceBackupRow[]> {
  return (
    await db
      .selectFrom("instance_backups")
      .selectAll()
      .where("status", "!=", "pending")
      .where((eb) =>
        eb.or([
          eb("expires_at", "<", nowIso),
          eb.and([eb("status", "=", "failed"), eb("created_at", "<", failedBeforeIso)]),
        ]),
      )
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("instance_restores as r")
              .select("r.id")
              .where("r.status", "in", ACTIVE_RESTORE)
              .where((x) =>
                x.or([
                  x("r.backup_id", "=", x.ref("instance_backups.id")),
                  x("r.safety_backup_id", "=", x.ref("instance_backups.id")),
                ]),
              ),
          ),
        ),
      )
      .orderBy("created_at")
      .orderBy("id")
      .limit(limit)
      .execute()
  ).map(nb);
}

export async function deleteBackup(db: Kysely<VetraAppsDB>, id: string): Promise<void> {
  await db.deleteFrom("instance_backups").where("id", "=", id).execute();
}

export async function insertRestore(
  db: Kysely<VetraAppsDB>,
  row: Insertable<InstanceRestoresTable>,
): Promise<InstanceRestoreRow> {
  return db.insertInto("instance_restores").values(row).returningAll().executeTakeFirstOrThrow();
}

export async function getRestore(db: Kysely<VetraAppsDB>, id: string): Promise<InstanceRestoreRow | null> {
  return (await db.selectFrom("instance_restores").selectAll().where("id", "=", id).executeTakeFirst()) ?? null;
}

export async function updateRestore(
  db: Kysely<VetraAppsDB>,
  id: string,
  patch: RestorePatch,
  nowIso: string,
): Promise<InstanceRestoreRow> {
  return db
    .updateTable("instance_restores")
    .set({ ...patch, updated_at: nowIso })
    .where("id", "=", id)
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function activeRestoresOfApp(db: Kysely<VetraAppsDB>, appId: string): Promise<InstanceRestoreRow[]> {
  return db
    .selectFrom("instance_restores")
    .selectAll()
    .where("app_id", "=", appId)
    .where("status", "in", ACTIVE_RESTORE)
    .orderBy("created_at")
    .execute();
}

export async function listRestoresOfInstance(
  db: Kysely<VetraAppsDB>,
  instanceId: string,
  limit: number,
): Promise<InstanceRestoreRow[]> {
  return db
    .selectFrom("instance_restores")
    .selectAll()
    .where("instance_id", "=", instanceId)
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .limit(limit)
    .execute();
}
```

- [ ] **Step 4: Run them again.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** `git add subgraphs/vetra-apps/db subgraphs/vetra-apps/audit/repo.ts subgraphs/vetra-apps/backups/repo.ts subgraphs/vetra-apps/__tests__/migrations.test.ts subgraphs/vetra-apps/__tests__/backups-repo.test.ts && git commit -m "feat(backups): instance_backups, instance_restores, instances.maintenance" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 7: The cluster surface (`BackupK8s`), `deps.backups`, test fixtures

**Files:**
- Create: `subgraphs/vetra-apps/backups/k8s.ts`, `subgraphs/vetra-apps/__tests__/backups-fixtures.ts`
- Modify: `subgraphs/vetra-apps/service.ts` (`AppsDeps`), `subgraphs/vetra-apps/index.ts`
- Test: `subgraphs/vetra-apps/__tests__/backups-k8s.test.ts`

**Interfaces:**
- Produces (`backups/k8s.ts`):
  - `APP_SELECTOR = "app.kubernetes.io/component=app"`;
  - `BackupK8s extends RestoreK8s` (observability's) with `deleteJob(ns, name)`, `findDataPvc(ns): Promise<string | null>` (the `-app-data` PVC labelled `component=app`), and `deploymentImages(ns, selector): Promise<string[]>`;
  - `DumpJobConfig { image; bucket; s3Endpoint; s3AccessKey; s3SecretKey }`;
  - `InstanceBackupDeps { k8s; dumpJob; archiveImage; deleteObject(key) }`;
  - `createDefaultBackupK8s()`;
  - `instanceBackupDepsFromEnv(env?, makeK8s?)`: null without `VETRA_DUMPS_S3_ACCESS_KEY`/`_SECRET_KEY`.
- Produces: `AppsDeps.backups?: InstanceBackupDeps | null`.
- Produces (fixtures): `fakeBackupK8s()`, `FakeBackupK8s`, `ARCHIVE_SHA`, `backupHarness(over?)` → `{ h, appId, app(), fake, deletedKeys }` (releases `1.4.0` = `digest("a")` and `1.5.0` = `digest("b")`), `planInstance(h, fake, appId, o)`, `finishBackupJobs(h, fake, outcome?)`, `deployTarget(h, fake, instanceId)`.

- [ ] **Step 1: Write the failing test.** Create `__tests__/backups-k8s.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { instanceBackupDepsFromEnv } from "../backups/k8s.js";
import { fakeBackupK8s } from "./backups-fixtures.js";

describe("instanceBackupDepsFromEnv", () => {
  it("needs the dumps S3 credentials, and takes the dumps settings and the archive image from the environment", async () => {
    const fake = fakeBackupK8s();
    let made = 0;
    const make = async () => {
      made++;
      return fake.k8s;
    };
    expect(await instanceBackupDepsFromEnv({}, make)).toBeNull();
    expect(made).toBe(0);
    const deps = await instanceBackupDepsFromEnv(
      { VETRA_DUMPS_S3_ACCESS_KEY: "AK", VETRA_DUMPS_S3_SECRET_KEY: "SK", VETRA_DUMPS_BUCKET: "b" },
      make,
    );
    expect(deps).toMatchObject({
      k8s: fake.k8s,
      dumpJob: {
        image: "cr.vetra.io/powerhouse-inc-powerhouse/pgdump-uploader:1.0.0",
        bucket: "b",
        s3Endpoint: "https://fsn1.your-objectstorage.com",
        s3AccessKey: "AK",
        s3SecretKey: "SK",
      },
      archiveImage: "cr.vetra.io/powerhouse-inc-powerhouse/pgdump-uploader:1.1.0",
    });
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/backups-k8s.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL.
- [ ] **Step 3: Implement.** Create `backups/k8s.ts`:

```ts
import { S3Helper } from "../../vetra-cloud-observability/dumps/s3.js";
import {
  createDefaultDumpsK8sClient,
  createDefaultRestoreK8s,
} from "../../vetra-cloud-observability/dumps/k8s-client.js";
import type { RestoreK8s } from "../../vetra-cloud-observability/dumps/restore.js";

/** The chart's host-image Deployment, its pods and its data PVC. */
export const APP_SELECTOR = "app.kubernetes.io/component=app";

const DEFAULT_DUMP_IMAGE = "cr.vetra.io/powerhouse-inc-powerhouse/pgdump-uploader:1.0.0";
/** 1.0.0 plus GNU tar and zstd (powerhouse-k8s-hosting infrastructure/pgdump-uploader). */
const DEFAULT_ARCHIVE_IMAGE = "cr.vetra.io/powerhouse-inc-powerhouse/pgdump-uploader:1.1.0";

/** What instance backups and restores need from the cluster (RBAC: jobs, deployments, pods, PVCs). */
export interface BackupK8s extends RestoreK8s {
  deleteJob(namespace: string, name: string): Promise<void>;
  /** The tenant's app data PVC (`<fullname>-app-data`, labelled component=app), or null. */
  findDataPvc(namespace: string): Promise<string | null>;
  /** The container images of the Deployments matching the selector. */
  deploymentImages(namespace: string, labelSelector: string): Promise<string[]>;
}

export interface DumpJobConfig {
  image: string;
  bucket: string;
  s3Endpoint: string;
  s3AccessKey: string;
  s3SecretKey: string;
}

export interface InstanceBackupDeps {
  k8s: BackupK8s;
  /** VETRA_DUMPS_*: the dump Jobs' image, bucket and credentials (the archive Jobs share bucket and credentials). */
  dumpJob: DumpJobConfig;
  /** VETRA_DATA_ARCHIVE_IMAGE: the /data Jobs' image. */
  archiveImage: string;
  deleteObject(key: string): Promise<void>;
}

/** In-cluster: observability's dump and restore clients plus PVC and Deployment reads. */
export async function createDefaultBackupK8s(): Promise<BackupK8s> {
  const dumps = await createDefaultDumpsK8sClient();
  const restore = await createDefaultRestoreK8s(dumps);
  const { KubeConfig, AppsV1Api, CoreV1Api } = await import("@kubernetes/client-node");
  const kc = new KubeConfig();
  kc.loadFromCluster();
  const apps = kc.makeApiClient(AppsV1Api);
  const core = kc.makeApiClient(CoreV1Api);
  return {
    ...restore,
    deleteJob: (ns, name) => dumps.deleteJob(ns, name),
    async findDataPvc(namespace) {
      const res = await core.listNamespacedPersistentVolumeClaim({ namespace, labelSelector: APP_SELECTOR });
      return res.items.map((p) => p.metadata?.name ?? "").find((n) => n.endsWith("-app-data")) ?? null;
    },
    async deploymentImages(namespace, labelSelector) {
      const res = await apps.listNamespacedDeployment({ namespace, labelSelector });
      return res.items.flatMap((d) => (d.spec?.template.spec?.containers ?? []).map((c) => c.image ?? ""));
    },
  };
}

/**
 * The same settings observability's dumps read (one process, one
 * environment). Null without the S3 credentials: backups are then not
 * configured, and VETRA_APPS_BACKUPS=on fails steps closed.
 */
export async function instanceBackupDepsFromEnv(
  env: Record<string, string | undefined> = process.env,
  makeK8s: () => Promise<BackupK8s> = createDefaultBackupK8s,
): Promise<InstanceBackupDeps | null> {
  const accessKey = env.VETRA_DUMPS_S3_ACCESS_KEY;
  const secretKey = env.VETRA_DUMPS_S3_SECRET_KEY;
  if (!accessKey || !secretKey) return null;
  const endpoint = env.VETRA_DUMPS_S3_ENDPOINT ?? "https://fsn1.your-objectstorage.com";
  const bucket = env.VETRA_DUMPS_BUCKET ?? "powerhouse-env-dumps";
  const s3 = new S3Helper({
    endpoint,
    region: env.VETRA_DUMPS_S3_REGION ?? "fsn1",
    accessKeyId: accessKey,
    secretAccessKey: secretKey,
    bucket,
  });
  return {
    k8s: await makeK8s(),
    dumpJob: {
      image: env.VETRA_DUMPS_IMAGE ?? DEFAULT_DUMP_IMAGE,
      bucket,
      s3Endpoint: endpoint,
      s3AccessKey: accessKey,
      s3SecretKey: secretKey,
    },
    archiveImage: env.VETRA_DATA_ARCHIVE_IMAGE ?? DEFAULT_ARCHIVE_IMAGE,
    deleteObject: (key) => s3.deleteObject(key),
  };
}
```

  In `service.ts` `AppsDeps`, after `instanceSecrets`:

```ts
  /**
   * Instance backups (releases phase 3 slice 4): the cluster, dump/archive
   * Job settings and S3 deletes. Null/absent: backups are not configured.
   */
  backups?: InstanceBackupDeps | null;
```

  (import `type InstanceBackupDeps` from `./backups/k8s.js`).

  In `index.ts`, after `deps` is built (next to `deps.attestations`):

```ts
    if (backupsConfigOf(cfg).enabled) {
      deps.backups = await instanceBackupDepsFromEnv().catch((err: unknown) => {
        console.warn(`[vetra-apps] instance backups: kubernetes client failed: ${String(err)}`);
        return null;
      });
      if (!deps.backups)
        console.warn(
          "[vetra-apps] VETRA_APPS_BACKUPS is on but dumps are not configured (VETRA_DUMPS_S3_*): rollout steps fail with 'backups are not configured'",
        );
    }
```

  (imports: `backupsConfigOf` from `./config.js`, `instanceBackupDepsFromEnv` from `./backups/k8s.js`).

  Create `__tests__/backups-fixtures.ts`:

```ts
import type { V1Job } from "@kubernetes/client-node";
import type { InstanceStatus } from "../db/schema.js";
import type { VetraAppsConfig } from "../config.js";
import type { BackupK8s } from "../backups/k8s.js";
import { getInstance, insertInstance, type InstanceRow } from "../instances/repo.js";
import { getApp } from "../repo.js";
import { archiveKey } from "../../vetra-cloud-observability/dumps/archive-repo.js";
import { makeHarness, seedActiveApp, testConfig, type Harness } from "./harness.js";
import { digest, seedRelease } from "./instances-fixtures.js";

export const ARCHIVE_SHA = "e".repeat(64);
export const HOLDER = "0x1111111111111111111111111111111111111111";

type JobStatus = {
  active?: number;
  succeeded?: number;
  failed?: number;
  conditions?: Array<{ type?: string; status?: string }>;
};

/** A cluster in memory: Jobs run until finish(); scaling is instant (pods = replicas). */
export function fakeBackupK8s() {
  const jobs = new Map<string, { ns: string; job: V1Job; status: JobStatus; logs: string }>();
  const deployments = new Map<string, Record<string, number>>();
  const images = new Map<string, string[]>();
  const pvcs = new Map<string, string>();
  const scaled: string[] = [];
  const k8s: BackupK8s = {
    async createJob(ns, job) {
      const name = job.metadata!.name!;
      if (jobs.has(name)) throw new Error(`Job ${name} exists`);
      jobs.set(name, { ns, job, status: { active: 1 }, logs: "" });
      return name;
    },
    async deleteJob(_ns, name) {
      jobs.delete(name);
    },
    async readJobStatus(_ns, name) {
      return jobs.get(name)?.status ?? null;
    },
    async readPodLogsForJob(_ns, name) {
      return jobs.get(name)?.logs ?? "";
    },
    async readDeploymentReplicas(ns) {
      return { ...(deployments.get(ns) ?? {}) };
    },
    async scaleDeployment(ns, name, replicas) {
      scaled.push(`${ns}/${name}=${replicas}`);
      deployments.set(ns, { ...(deployments.get(ns) ?? {}), [name]: replicas });
    },
    async countPods(ns) {
      return Object.values(deployments.get(ns) ?? {}).reduce((a, b) => a + b, 0);
    },
    async deploymentsReady(ns, want) {
      return Object.entries(want).every(([n, r]) => (deployments.get(ns)?.[n] ?? 0) >= r);
    },
    async findDataPvc(ns) {
      return pvcs.get(ns) ?? null;
    },
    async deploymentImages(ns) {
      return images.get(ns) ?? [];
    },
  };
  return {
    k8s,
    jobs,
    deployments,
    images,
    pvcs,
    scaled,
    /** Ends every running Job whose name starts with `prefix`. */
    finish(prefix: string, ok = true, logs = "") {
      for (const [name, j] of jobs)
        if (name.startsWith(prefix) && j.status.active) {
          j.status = ok
            ? { succeeded: 1, conditions: [{ type: "Complete", status: "True" }] }
            : { failed: 1, conditions: [{ type: "Failed", status: "True" }] };
          j.logs = logs;
        }
    },
  };
}
export type FakeBackupK8s = ReturnType<typeof fakeBackupK8s>;

export async function backupHarness(over: Partial<VetraAppsConfig> = {}) {
  const h = await makeHarness(
    testConfig({
      plans: { enabled: true, stopAfterDays: 14 },
      backups: { enabled: true, dailyKeepDays: 14, maxInFlight: 3 },
      ...over,
    }),
  );
  const fake = fakeBackupK8s();
  const deletedKeys: string[] = [];
  h.deps.backups = {
    k8s: fake.k8s,
    dumpJob: {
      image: "cr.vetra.io/x/pgdump-uploader:1.0.0",
      bucket: "dumps",
      s3Endpoint: "https://s3.test",
      s3AccessKey: "AK",
      s3SecretKey: "SK",
    },
    archiveImage: "cr.vetra.io/x/pgdump-uploader:1.1.0",
    deleteObject: async (key) => {
      deletedKeys.push(key);
    },
  };
  const appId = (await seedActiveApp(h)).id;
  await h.db
    .updateTable("apps")
    .set({ instances_enabled: true, registry_namespace: "acme" })
    .where("id", "=", appId)
    .execute();
  await seedRelease(h, appId, { version: "1.4.0", run: 1, kind: "release", digest: digest("a") });
  await seedRelease(h, appId, { version: "1.5.0", run: 2, kind: "release", digest: digest("b") });
  return { h, appId, app: async () => (await getApp(h.db, appId))!, fake, deletedKeys };
}
export type BackupCtx = Awaited<ReturnType<typeof backupHarness>>;

const DIGEST = { "1.4.0": digest("a"), "1.5.0": digest("b") } as const;

/** A plan instance ready on `version`, in namespace t-<id>, with its app running and a data PVC. */
export async function planInstance(
  h: Harness,
  fake: FakeBackupK8s,
  appId: string,
  o: { id: string; kind?: "shared" | "own"; version?: "1.4.0" | "1.5.0"; status?: InstanceStatus },
): Promise<InstanceRow> {
  const version = o.version ?? "1.4.0";
  const kind = o.kind ?? "own";
  const tenant = `t-${o.id}`;
  const env = `env-${o.id}`;
  h.tenants.set(env, tenant);
  fake.pvcs.set(tenant, `powerhouse-${tenant}-app-data`);
  fake.deployments.set(tenant, { [`powerhouse-${tenant}-app`]: 1 });
  fake.images.set(tenant, [`cr.vetra.io/acme/shop:${version}@${DIGEST[version]}`]);
  const at = "2026-10-01T00:00:00.000Z";
  return insertInstance(h.db, {
    id: o.id,
    app_id: appId,
    kind,
    name: o.id,
    branch: null,
    pr: null,
    host: `shop-${o.id}`,
    environment_id: env,
    target_version: version,
    target_digest: DIGEST[version],
    target_repository: "cr.vetra.io/acme/shop",
    target_ph_host: "cli",
    target_run: version === "1.4.0" ? 1 : 2,
    running_version: version,
    running_digest: DIGEST[version],
    running_repository: "cr.vetra.io/acme/shop",
    status: o.status ?? "ready",
    reason: null,
    failed_digest: null,
    update_started_at: null,
    removed_at: null,
    removed_reason: null,
    plan_id: "p-1",
    holder_address: kind === "own" ? HOLDER : null,
    created_at: at,
    updated_at: at,
  });
}

/**
 * What observability's Job watcher records once the pending dumps and
 * archives finished (it does not run in tests), and the Jobs end.
 */
export async function finishBackupJobs(
  h: Harness,
  fake: FakeBackupK8s,
  outcome: "ok" | "dump_failed" | "archive_failed" = "ok",
): Promise<void> {
  const at = new Date().toISOString();
  for (const d of await h.obsDb
    .selectFrom("database_dumps")
    .selectAll()
    .where("status", "in", ["PENDING", "RUNNING"])
    .execute())
    await h.obsDb
      .updateTable("database_dumps")
      .set(
        outcome === "dump_failed"
          ? { status: "FAILED", errorMessage: "pg_dump: boom", completedAt: at }
          : { status: "READY", s3Key: `${d.tenantId}/${d.id}.dump`, sizeBytes: 100, completedAt: at },
      )
      .where("id", "=", d.id)
      .execute();
  for (const a of await h.obsDb
    .selectFrom("data_archives")
    .selectAll()
    .where("status", "in", ["PENDING", "RUNNING"])
    .execute())
    await h.obsDb
      .updateTable("data_archives")
      .set(
        outcome === "archive_failed"
          ? { status: "FAILED", errorMessage: "tar: boom", completedAt: at }
          : { status: "READY", s3Key: archiveKey(a.tenantId, a.id), sizeBytes: 50, sha256: ARCHIVE_SHA, completedAt: at },
      )
      .where("id", "=", a.id)
      .execute();
  fake.finish("pgdump-", outcome !== "dump_failed");
  fake.finish("dataarchive-", outcome !== "archive_failed");
}

/** Argo runs the instance's target image (the reconciler applied it). */
export async function deployTarget(h: Harness, fake: FakeBackupK8s, instanceId: string): Promise<void> {
  const i = (await getInstance(h.db, instanceId))!;
  fake.images.set(`t-${instanceId}`, [`${i.target_repository}:${i.target_version}@${i.target_digest}`]);
}
```

- [ ] **Step 4: Run it again.** Same command. Expected: PASS. Also `npm run tsc 2>&1 | tail -20` (the `AppsDeps` field and `index.ts`).
- [ ] **Step 5: Commit.** `git add subgraphs/vetra-apps/backups/k8s.ts subgraphs/vetra-apps/service.ts subgraphs/vetra-apps/index.ts subgraphs/vetra-apps/__tests__/backups-k8s.test.ts subgraphs/vetra-apps/__tests__/backups-fixtures.ts && git commit -m "feat(backups): cluster surface and deps for instance backups" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 8: Taking a backup (`startInstanceBackup`, `advanceBackups`)

**Files:**
- Create: `subgraphs/vetra-apps/backups/service.ts`
- Test: `subgraphs/vetra-apps/__tests__/backups-service.test.ts`

**Interfaces:**
- Consumes: Tasks 1-7; `createDumpAndJob`, `DumpsRepo`, `createArchiveAndJob`, `ArchivesRepo`.
- Produces:
  - `BACKUP_TIMEOUT_MS = 75 min`; `KEEP_DAYS` (B6);
  - `class BackupBusyError`, `class BackupUnavailableError`;
  - `startInstanceBackup(deps, inst, { reason, requestedBy, rolloutStepId? }): Promise<InstanceBackupRow>`:
    - dump first, then the archive; when the archive cannot start, the dump is failed and its Job deleted;
    - `INSTANCE` source except `pre_update` → `PRE_UPDATE`;
    - the archive is colocated when the app has pods;
  - `advanceBackups(deps, appId)`: pending backups of the App become `ready` (both rows READY; size summed) or `failed` (a row FAILED or gone, or timed out), with an audit row `backup.failed`.

- [ ] **Step 1: Write the failing test.** Create `__tests__/backups-service.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OWNER } from "./harness.js";
import { backupHarness, finishBackupJobs, planInstance, type BackupCtx } from "./backups-fixtures.js";
import { listAudit } from "../audit/repo.js";
import { getBackup } from "../backups/repo.js";
import {
  advanceBackups,
  BACKUP_TIMEOUT_MS,
  BackupBusyError,
  BackupUnavailableError,
  startInstanceBackup,
} from "../backups/service.js";

let ctx: BackupCtx;
beforeEach(async () => {
  ctx = await backupHarness();
});
afterEach(async () => {
  await ctx.h.close();
});

describe("startInstanceBackup", () => {
  it("starts a dump and a colocated /data archive in the instance's namespace and records a pending backup", async () => {
    const { h, appId, fake } = ctx;
    const inst = await planInstance(h, fake, appId, { id: "o1" });
    const b = await startInstanceBackup(h.deps, inst, { reason: "manual", requestedBy: OWNER });
    expect(b).toMatchObject({
      instance_id: "o1",
      tenant_id: "t-o1",
      environment_id: "env-o1",
      reason: "manual",
      status: "pending",
      version: "1.4.0",
      requested_by: OWNER,
    });
    expect(Date.parse(b.expires_at) - Date.parse(b.created_at)).toBe(30 * 86_400_000);
    const dump = await h.obsDb.selectFrom("database_dumps").selectAll().where("id", "=", b.dump_id!).executeTakeFirstOrThrow();
    expect(dump).toMatchObject({ tenantId: "t-o1", documentId: "env-o1", source: "INSTANCE" });
    expect(fake.jobs.get(`pgdump-${b.dump_id}`)?.ns).toBe("t-o1");
    const archive = fake.jobs.get(`dataarchive-${b.archive_id}`)!;
    expect(archive.ns).toBe("t-o1");
    expect(archive.job.spec!.template.spec!.affinity).toBeDefined();
    expect(archive.job.spec!.template.spec!.containers[0].image).toBe("cr.vetra.io/x/pgdump-uploader:1.1.0");
    await expect(
      startInstanceBackup(h.deps, inst, { reason: "daily", requestedBy: "vetra" }),
    ).rejects.toBeInstanceOf(BackupBusyError);
    const pre = await startInstanceBackup(h.deps, await planInstance(h, fake, appId, { id: "o2" }), {
      reason: "pre_update",
      requestedBy: "vetra",
      rolloutStepId: "step-1",
    });
    expect(pre.rollout_step_id).toBe("step-1");
    expect(
      (await h.obsDb.selectFrom("database_dumps").select("source").where("id", "=", pre.dump_id!).executeTakeFirstOrThrow()).source,
    ).toBe("PRE_UPDATE");
  });

  it("says why it cannot back up, and starts nothing then", async () => {
    const { h, appId, fake } = ctx;
    const inst = await planInstance(h, fake, appId, { id: "o1" });
    const go = (i = inst) => startInstanceBackup(h.deps, i, { reason: "manual", requestedBy: OWNER });
    await expect(go({ ...inst, kind: "branch" })).rejects.toBeInstanceOf(BackupUnavailableError);
    await expect(go({ ...inst, environment_id: null })).rejects.toThrow(/no environment/);
    fake.pvcs.delete("t-o1");
    await expect(go()).rejects.toThrow(/no \/data volume/);
    h.deps.backups = null;
    await expect(go()).rejects.toThrow(/not configured/);
    expect(await h.obsDb.selectFrom("database_dumps").selectAll().execute()).toEqual([]);
  });
});

describe("advanceBackups", () => {
  it("ready when both Jobs are; failed and audited when one fails or it takes too long", async () => {
    const { h, appId, fake } = ctx;
    const a = await startInstanceBackup(h.deps, await planInstance(h, fake, appId, { id: "o1" }), { reason: "daily", requestedBy: "vetra" });
    await advanceBackups(h.deps, appId);
    expect((await getBackup(h.db, a.id))!.status).toBe("pending");
    await finishBackupJobs(h, fake);
    await advanceBackups(h.deps, appId);
    expect(await getBackup(h.db, a.id)).toMatchObject({ status: "ready", size_bytes: 150 });

    const b = await startInstanceBackup(h.deps, await planInstance(h, fake, appId, { id: "o2" }), { reason: "daily", requestedBy: "vetra" });
    await finishBackupJobs(h, fake, "archive_failed");
    await advanceBackups(h.deps, appId);
    expect(await getBackup(h.db, b.id)).toMatchObject({ status: "failed", error: "/data archive: tar: boom" });

    const c = await startInstanceBackup(h.deps, await planInstance(h, fake, appId, { id: "o3" }), { reason: "daily", requestedBy: "vetra" });
    h.advance(BACKUP_TIMEOUT_MS + 1);
    await advanceBackups(h.deps, appId);
    expect((await getBackup(h.db, c.id))!.error).toMatch(/not finished after 75 minutes/);

    const failed = (await listAudit(h.db, appId, { limit: 50 })).filter((x) => x.action === "backup.failed");
    expect(failed.map((x) => x.subject)).toEqual(["instance:o3", "instance:o2"]);
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/backups-service.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement.** Create `backups/service.ts`:

```ts
import type { V1Job } from "@kubernetes/client-node";
import type { DataArchives, DatabaseDumps } from "../../vetra-cloud-observability/db/schema.js";
import { ArchivesRepo } from "../../vetra-cloud-observability/dumps/archive-repo.js";
import { createArchiveAndJob } from "../../vetra-cloud-observability/dumps/archive-service.js";
import { DumpsRepo } from "../../vetra-cloud-observability/dumps/repo.js";
import { createDumpAndJob } from "../../vetra-cloud-observability/dumps/service.js";
import { AUDIT_SYSTEM_ACTOR, recordAudit } from "../audit/repo.js";
import { backupsConfigOf } from "../config.js";
import type { BackupReason } from "../db/schema.js";
import type { InstanceRow } from "../instances/repo.js";
import type { AppsDeps } from "../service.js";
import { APP_SELECTOR } from "./k8s.js";
import {
  insertBackup,
  pendingBackupsOfApp,
  updateBackup,
  type InstanceBackupRow,
} from "./repo.js";

const DAY_MS = 86_400_000;
/** The Jobs' own deadline is 60 minutes; the watcher records them within seconds. */
export const BACKUP_TIMEOUT_MS = 75 * 60_000;
/** Days a backup is kept, per reason (B6); daily backups: VETRA_APPS_BACKUP_DAILY_KEEP_DAYS. */
export const KEEP_DAYS: Record<Exclude<BackupReason, "daily">, number> = {
  pre_update: 30,
  manual: 30,
  pre_restore: 7,
  pre_stop: 30,
};

/** A dump or archive of the instance's namespace is running: try again on a later pass. */
export class BackupBusyError extends Error {}
/** The instance cannot be backed up (no environment, namespace, /data volume, or configuration). */
export class BackupUnavailableError extends Error {}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 500);

/**
 * Starts a backup of a shared or own instance: a pg_dump Job and a /data
 * archive Job in its namespace, recorded as one pending backup. The dump
 * goes first; when the archive cannot start, the dump is failed and its Job
 * deleted, so a backup is always both or neither.
 */
export async function startInstanceBackup(
  deps: AppsDeps,
  inst: InstanceRow,
  o: { reason: BackupReason; requestedBy: string; rolloutStepId?: string | null },
): Promise<InstanceBackupRow> {
  const b = deps.backups;
  const obs = deps.observabilityDb;
  if (!b || !obs) throw new BackupUnavailableError("backups are not configured");
  if (inst.kind !== "shared" && inst.kind !== "own")
    throw new BackupUnavailableError(`a ${inst.kind} instance has no backups`);
  const envId = inst.environment_id;
  if (!envId) throw new BackupUnavailableError("the instance has no environment yet");
  const tenant = deps.envTenant ? await deps.envTenant(envId) : null;
  if (!tenant) throw new BackupUnavailableError("the instance's namespace is not known yet");
  const pvc = await b.k8s.findDataPvc(tenant);
  if (!pvc) throw new BackupUnavailableError("the instance has no /data volume");
  const dumps = new DumpsRepo(obs);
  const archives = new ArchivesRepo(obs);
  if (await archives.inFlightForTenant(tenant))
    throw new BackupBusyError("a /data archive of the instance is running");
  const now = deps.now();
  const createJob = (ns: string, job: V1Job) => b.k8s.createJob(ns, job);
  let dump: DatabaseDumps;
  try {
    dump = await createDumpAndJob(
      { repo: dumps, createJob, ...b.dumpJob },
      {
        documentId: envId,
        tenantId: tenant,
        requestedBy: o.requestedBy,
        source: o.reason === "pre_update" ? "PRE_UPDATE" : "INSTANCE",
        now,
      },
    );
  } catch (err) {
    if (message(err) === "DUMP_IN_PROGRESS")
      throw new BackupBusyError("a database dump of the instance is running");
    throw err;
  }
  let archive: DataArchives;
  try {
    archive = await createArchiveAndJob(
      { repo: archives, createJob, ...b.dumpJob, image: b.archiveImage },
      {
        documentId: envId,
        tenantId: tenant,
        requestedBy: o.requestedBy,
        pvcName: pvc,
        colocate: (await b.k8s.countPods(tenant, APP_SELECTOR)) > 0,
        now,
      },
    );
  } catch (err) {
    await dumps.markFailed(dump.id, "its /data archive could not start", now);
    await b.k8s.deleteJob(tenant, `pgdump-${dump.id}`).catch(() => {});
    if (message(err) === "ARCHIVE_IN_PROGRESS")
      throw new BackupBusyError("a /data archive of the instance is running");
    throw err;
  }
  const nowIso = now.toISOString();
  const days = o.reason === "daily" ? backupsConfigOf(deps.cfg).dailyKeepDays : KEEP_DAYS[o.reason];
  return insertBackup(deps.db, {
    id: deps.newId(),
    app_id: inst.app_id,
    instance_id: inst.id,
    environment_id: envId,
    tenant_id: tenant,
    reason: o.reason,
    version: inst.running_version,
    digest: inst.running_digest,
    dump_id: dump.id,
    archive_id: archive.id,
    status: "pending",
    error: null,
    size_bytes: null,
    requested_by: o.requestedBy,
    rollout_step_id: o.rolloutStepId ?? null,
    created_at: nowIso,
    updated_at: nowIso,
    finished_at: null,
    expires_at: new Date(now.getTime() + days * DAY_MS).toISOString(),
  });
}

/**
 * Settles the App's pending backups from observability's rows (its Job
 * watcher records them): ready when the dump and the archive are READY,
 * failed when either failed or vanished, or after BACKUP_TIMEOUT_MS.
 */
export async function advanceBackups(deps: AppsDeps, appId: string): Promise<void> {
  const obs = deps.observabilityDb;
  if (!obs) return;
  const dumps = new DumpsRepo(obs);
  const archives = new ArchivesRepo(obs);
  for (const b of await pendingBackupsOfApp(deps.db, appId)) {
    const dump = b.dump_id ? await dumps.getById(b.dump_id) : null;
    const archive = b.archive_id ? await archives.getById(b.archive_id) : null;
    const now = deps.now();
    const nowIso = now.toISOString();
    const age = now.getTime() - Date.parse(b.created_at);
    const failure = !dump
      ? "its database dump is gone"
      : dump.status === "FAILED"
        ? `database dump: ${dump.errorMessage ?? "failed"}`
        : !archive
          ? "its /data archive is gone"
          : archive.status === "FAILED"
            ? `/data archive: ${archive.errorMessage ?? "failed"}`
            : // Fails closed: a created_at that does not parse is timed out.
              !(age <= BACKUP_TIMEOUT_MS)
              ? `not finished after ${BACKUP_TIMEOUT_MS / 60_000} minutes`
              : null;
    if (failure) {
      await deps.db.transaction().execute(async (trx) => {
        await updateBackup(trx, b.id, { status: "failed", error: failure.slice(0, 500), finished_at: nowIso }, nowIso);
        await recordAudit(trx, {
          appId,
          at: nowIso,
          actor: AUDIT_SYSTEM_ACTOR,
          source: "system",
          action: "backup.failed",
          subject: `instance:${b.instance_id}`,
          detail: { backupId: b.id, reason: b.reason, error: failure },
        });
      });
      deps.logger.warn(`[vetra-apps] backup ${b.id} of instance ${b.instance_id} failed: ${failure}`);
      continue;
    }
    if (dump!.status === "READY" && archive!.status === "READY")
      await updateBackup(
        deps.db,
        b.id,
        {
          status: "ready",
          size_bytes: Number(dump!.sizeBytes ?? 0) + Number(archive!.sizeBytes ?? 0),
          finished_at: nowIso,
        },
        nowIso,
      );
  }
}
```

- [ ] **Step 4: Run it again.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** `git add subgraphs/vetra-apps/backups/service.ts subgraphs/vetra-apps/__tests__/backups-service.test.ts && git commit -m "feat(backups): take an instance backup (database dump and /data archive)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 9: Restoring a backup (`beginRestore`, `advanceRestores`)

**Files:**
- Create: `subgraphs/vetra-apps/backups/restore.ts`
- Modify: `subgraphs/vetra-apps/__tests__/backups-fixtures.ts` (`pass`, `driveRestores`)
- Test: `subgraphs/vetra-apps/__tests__/backups-restore.test.ts`

**Interfaces:**
- Produces:
  - `RESTORE_STOP_TIMEOUT_MS` (10 min), `RESTORE_JOB_TIMEOUT_MS` (70 min), `RESTORE_START_TIMEOUT_MS` (20 min), `SAFETY_START_TIMEOUT_MS` (30 min);
  - `activeMark(id)`, `heldMark(id)`, `isHeld(maintenance)`;
  - `class RestoreBusyError`; `Who { actor; source }`, `SYSTEM_WHO`;
  - `beginRestore(deps, inst, backup, { purpose, thenVersion, who, rolloutStepId? }): Promise<InstanceRestoreRow>`. One transaction: the restore row (`safety_backup`), `instances.maintenance = restore:<id>`, and an audit row `restore.started`. It refuses a backup of another instance, one not ready, an expired one, and an instance another restore owns (`RestoreBusyError`).
  - `advanceRestores(deps, app)`: one phase step per active restore of the App (see the Model), each restore isolated in its own try/catch.

- [ ] **Step 1: Write the failing test.** Add to `__tests__/backups-fixtures.ts` (the three imports go to the top of the file):

```ts
import { advanceBackups } from "../backups/service.js";
import { advanceRestores } from "../backups/restore.js";
import { activeRestoresOfApp } from "../backups/repo.js";

/** What reconcileApp runs before the rollouts: backups, then restores. */
export async function pass(ctx: BackupCtx): Promise<void> {
  await advanceBackups(ctx.h.deps, ctx.appId);
  await advanceRestores(ctx.h.deps, await ctx.app());
}

/**
 * Plays the cluster until no restore of the App is active: Jobs finish (the
 * one named by `fail` fails), and once a restore handed its instance back,
 * Argo runs the target image (unless deploy is false). At most 20 passes.
 */
export async function driveRestores(
  ctx: BackupCtx,
  o: { fail?: "pgdump-" | "pgrestore-" | "datarestore-"; deploy?: boolean } = {},
): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await finishBackupJobs(ctx.h, ctx.fake, o.fail === "pgdump-" ? "dump_failed" : "ok");
    ctx.fake.finish("pgrestore-", o.fail !== "pgrestore-", o.fail === "pgrestore-" ? "psql: ERROR: boom" : "restore complete");
    ctx.fake.finish(
      "datarestore-",
      o.fail !== "datarestore-",
      o.fail === "datarestore-" ? "archive checksum mismatch: 00" : "data restore complete",
    );
    if (o.deploy !== false)
      for (const r of await activeRestoresOfApp(ctx.h.db, ctx.appId))
        if (r.target_set) await deployTarget(ctx.h, ctx.fake, r.instance_id);
    await pass(ctx);
    if ((await activeRestoresOfApp(ctx.h.db, ctx.appId)).length === 0) return;
  }
  throw new Error("restores did not finish in 20 passes");
}
```

Create `__tests__/backups-restore.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ARCHIVE_SHA,
  backupHarness,
  deployTarget,
  driveRestores,
  finishBackupJobs,
  pass,
  planInstance,
  type BackupCtx,
} from "./backups-fixtures.js";
import { digest } from "./instances-fixtures.js";
import { listAudit } from "../audit/repo.js";
import { getBackup, getRestore, type InstanceBackupRow } from "../backups/repo.js";
import { beginRestore, RestoreBusyError, SYSTEM_WHO } from "../backups/restore.js";
import { startInstanceBackup } from "../backups/service.js";
import { getInstance, updateInstance } from "../instances/repo.js";

let ctx: BackupCtx;
beforeEach(async () => {
  ctx = await backupHarness();
});
afterEach(async () => {
  await ctx.h.close();
});

/** o1 backed up on 1.4.0, then updated to 1.5.0 (the release that migrated it). */
async function updatedAfterBackup(): Promise<InstanceBackupRow> {
  const { h, appId, fake } = ctx;
  const inst = await planInstance(h, fake, appId, { id: "o1" });
  const b = await startInstanceBackup(h.deps, inst, { reason: "pre_update", requestedBy: "vetra" });
  await finishBackupJobs(h, fake);
  await pass(ctx);
  await updateInstance(
    h.db,
    "o1",
    { target_version: "1.5.0", target_digest: digest("b"), target_run: 2, running_version: "1.5.0", running_digest: digest("b") },
    "2026-10-02T13:00:00.000Z",
  );
  fake.images.set("t-o1", [`cr.vetra.io/acme/shop:1.5.0@${digest("b")}`]);
  return (await getBackup(h.db, b.id))!;
}
const inst = async () => (await getInstance(ctx.h.db, "o1"))!;
const app0 = { "powerhouse-t-o1-app": 0 };
const app1 = { "powerhouse-t-o1-app": 1 };

describe("restoring a backup", () => {
  it("safety backup, app stopped, database then /data restored, handed back on the old release, started only on its image", async () => {
    const { h, appId, fake } = ctx;
    const b = await updatedAfterBackup();
    const r = await beginRestore(h.deps, await inst(), b, { purpose: "rollback", thenVersion: "1.4.0", who: SYSTEM_WHO });
    expect((await inst()).maintenance).toBe(`restore:${r.id}`);
    await pass(ctx);
    const safety = (await getRestore(h.db, r.id))!.safety_backup_id!;
    expect((await getBackup(h.db, safety))!.reason).toBe("pre_restore");
    expect(fake.scaled).toEqual([]);
    await finishBackupJobs(h, fake);
    await pass(ctx);
    expect((await getRestore(h.db, r.id))!.status).toBe("stopping");
    expect(fake.deployments.get("t-o1")).toEqual(app0);
    await pass(ctx);
    expect((await getRestore(h.db, r.id))!.status).toBe("restoring_db");
    const pg = fake.jobs.get(`pgrestore-${r.id}`)!.job.spec!.template.spec!.containers[0].env!;
    expect(pg.find((e) => e.name === "S3_KEY")!.value).toBe(`t-o1/${b.dump_id}.dump`);
    fake.finish("pgrestore-");
    await pass(ctx);
    expect((await getRestore(h.db, r.id))!.status).toBe("restoring_data");
    const data = fake.jobs.get(`datarestore-${r.id}`)!.job.spec!.template.spec!;
    expect(data.containers[0].env!.find((e) => e.name === "ARCHIVE_SHA256")!.value).toBe(ARCHIVE_SHA);
    expect(data.volumes![0].persistentVolumeClaim!.claimName).toBe("powerhouse-t-o1-app-data");
    fake.finish("datarestore-");
    await pass(ctx);
    expect((await getRestore(h.db, r.id))!.status).toBe("starting");
    await pass(ctx);
    expect(await inst()).toMatchObject({
      maintenance: null,
      status: "updating",
      target_version: "1.4.0",
      target_digest: digest("a"),
      running_version: "1.4.0",
      running_digest: digest("a"),
    });
    await pass(ctx);
    // The cluster still runs the image that migrated: never started on the restored data.
    expect(fake.deployments.get("t-o1")).toEqual(app0);
    await deployTarget(h, fake, "o1");
    await pass(ctx);
    expect(fake.deployments.get("t-o1")).toEqual(app1);
    await pass(ctx);
    expect(await getRestore(h.db, r.id)).toMatchObject({ status: "succeeded", error: null, held: false });
    const actions = (await listAudit(h.db, appId, { limit: 50 })).map((a) => a.action);
    expect(actions.filter((a) => a.startsWith("restore."))).toEqual(["restore.finished", "restore.started"]);
  });

  it("a failed database restore changes nothing: the app runs again on what it ran", async () => {
    const { h, fake } = ctx;
    const b = await updatedAfterBackup();
    const r = await beginRestore(h.deps, await inst(), b, { purpose: "rollback", thenVersion: "1.4.0", who: SYSTEM_WHO });
    await driveRestores(ctx, { fail: "pgrestore-" });
    expect(await getRestore(h.db, r.id)).toMatchObject({
      status: "failed",
      held: false,
      error: "database restore failed: psql: ERROR: boom; nothing was changed",
    });
    expect(await inst()).toMatchObject({ maintenance: null, target_version: "1.5.0" });
    expect(fake.deployments.get("t-o1")).toEqual(app1);
  });

  it("a failed /data restore holds the instance stopped; a new restore may start, and its early failure keeps it held", async () => {
    const { h, fake } = ctx;
    const b = await updatedAfterBackup();
    const r = await beginRestore(h.deps, await inst(), b, { purpose: "rollback", thenVersion: "1.4.0", who: SYSTEM_WHO });
    await driveRestores(ctx, { fail: "datarestore-" });
    expect(await getRestore(h.db, r.id)).toMatchObject({ status: "failed", held: true });
    expect(await inst()).toMatchObject({
      maintenance: `held:${r.id}`,
      status: "failed",
      reason: expect.stringMatching(/^restore failed: \/data restore failed: archive checksum mismatch/),
    });
    expect(fake.deployments.get("t-o1")).toEqual(app0);
    const again = await beginRestore(h.deps, await inst(), b, { purpose: "manual", thenVersion: "1.4.0", who: SYSTEM_WHO });
    expect(again.was_held).toBe(true);
    await driveRestores(ctx, { fail: "pgdump-" });
    expect(await getRestore(h.db, again.id)).toMatchObject({
      status: "failed",
      held: true,
      error: expect.stringMatching(/safety backup failed/),
    });
    expect((await inst()).maintenance).toBe(`held:${again.id}`);
    expect(fake.deployments.get("t-o1")).toEqual(app0);
  });

  it("refuses another instance's backup, a backup that is not ready, and a second restore", async () => {
    const { h, appId, fake } = ctx;
    const b = await updatedAfterBackup();
    const other = await planInstance(h, fake, appId, { id: "o2" });
    await expect(
      beginRestore(h.deps, other, b, { purpose: "manual", thenVersion: null, who: SYSTEM_WHO }),
    ).rejects.toThrow(/not a backup of o2/);
    await expect(
      beginRestore(h.deps, await inst(), { ...b, status: "pending" }, { purpose: "manual", thenVersion: null, who: SYSTEM_WHO }),
    ).rejects.toThrow(/is pending/);
    await beginRestore(h.deps, await inst(), b, { purpose: "manual", thenVersion: null, who: SYSTEM_WHO });
    await expect(
      beginRestore(h.deps, await inst(), b, { purpose: "manual", thenVersion: null, who: SYSTEM_WHO }),
    ).rejects.toBeInstanceOf(RestoreBusyError);
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/backups-restore.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement.** Create `backups/restore.ts`:

```ts
import { ArchivesRepo } from "../../vetra-cloud-observability/dumps/archive-repo.js";
import { buildDataRestoreJob } from "../../vetra-cloud-observability/dumps/archive-job-spec.js";
import { buildRestoreJob } from "../../vetra-cloud-observability/dumps/job-spec.js";
import { AUDIT_SYSTEM_ACTOR, recordAudit } from "../audit/repo.js";
import type { AuditSource, RestorePurpose } from "../db/schema.js";
import { getInstance, updateInstance, type InstanceRow } from "../instances/repo.js";
import { targetOf } from "../instances/targets.js";
import { releaseByVersion } from "../releases/repo.js";
import type { AppRow } from "../repo.js";
import type { AppsDeps } from "../service.js";
import { APP_SELECTOR, type BackupK8s } from "./k8s.js";
import {
  activeRestoresOfApp,
  getBackup,
  insertRestore,
  updateRestore,
  type InstanceBackupRow,
  type InstanceRestoreRow,
  type RestorePatch,
} from "./repo.js";
import { BackupBusyError, startInstanceBackup } from "./service.js";

export const RESTORE_STOP_TIMEOUT_MS = 10 * 60_000;
/** The restore Jobs' own deadline is 60 minutes. */
export const RESTORE_JOB_TIMEOUT_MS = 70 * 60_000;
/** Handing back: the restored release's image must reach the Deployment (gitops, Argo) and be ready. */
export const RESTORE_START_TIMEOUT_MS = 20 * 60_000;
/** How long a restore waits for a running backup of the instance before its safety backup can start. */
export const SAFETY_START_TIMEOUT_MS = 30 * 60_000;

export const activeMark = (restoreId: string) => `restore:${restoreId}`;
export const heldMark = (restoreId: string) => `held:${restoreId}`;
/** Held: a restore failed with /data possibly half restored; the instance stays stopped. */
export const isHeld = (m: string | null | undefined): boolean => !!m && m.startsWith("held:");

export class RestoreBusyError extends Error {}

export interface Who {
  actor: string;
  source: AuditSource;
}
export const SYSTEM_WHO: Who = { actor: AUDIT_SYSTEM_ACTOR, source: "system" };

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 500);

/**
 * Starts restoring `backup` into the instance it was taken from (and no
 * other). The instance goes into maintenance in the same transaction, so
 * the reconciler, daily backups and rollouts leave it alone. Callers hold
 * instances:<appId>.
 */
export async function beginRestore(
  deps: AppsDeps,
  inst: InstanceRow,
  backup: InstanceBackupRow,
  o: { purpose: RestorePurpose; thenVersion: string | null; who: Who; rolloutStepId?: string | null },
): Promise<InstanceRestoreRow> {
  if (backup.instance_id !== inst.id) throw new Error(`backup ${backup.id} is not a backup of ${inst.name}`);
  if (backup.status !== "ready") throw new Error(`backup ${backup.id} is ${backup.status}`);
  const now = deps.now();
  if (!(Date.parse(backup.expires_at) > now.getTime())) throw new Error(`backup ${backup.id} expired`);
  if (inst.maintenance && !isHeld(inst.maintenance)) throw new RestoreBusyError(`${inst.name} is being restored`);
  const nowIso = now.toISOString();
  try {
    return await deps.db.transaction().execute(async (trx) => {
      const row = await insertRestore(trx, {
        id: deps.newId(),
        app_id: inst.app_id,
        instance_id: inst.id,
        environment_id: backup.environment_id,
        tenant_id: backup.tenant_id,
        backup_id: backup.id,
        safety_backup_id: null,
        purpose: o.purpose,
        then_version: o.thenVersion,
        data: true,
        status: "safety_backup",
        phase_started_at: nowIso,
        db_job: null,
        data_job: null,
        replicas: null,
        target_set: false,
        was_held: isHeld(inst.maintenance),
        error: null,
        held: false,
        requested_by: o.who.actor,
        rollout_step_id: o.rolloutStepId ?? null,
        created_at: nowIso,
        updated_at: nowIso,
        finished_at: null,
      });
      await updateInstance(trx, inst.id, { maintenance: activeMark(row.id) }, nowIso);
      await recordAudit(trx, {
        appId: inst.app_id,
        at: nowIso,
        ...o.who,
        action: "restore.started",
        subject: `instance:${inst.id}`,
        detail: {
          restoreId: row.id,
          backupId: backup.id,
          takenAt: backup.created_at,
          backupVersion: backup.version,
          purpose: o.purpose,
          thenVersion: o.thenVersion,
        },
      });
      return row;
    });
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw new RestoreBusyError(`${inst.name} is being restored`);
    throw err;
  }
}

/** One phase step for each active restore of the App (runs in the reconciler's pass, under its lock). */
export async function advanceRestores(deps: AppsDeps, app: AppRow): Promise<void> {
  const b = deps.backups;
  if (!b) return;
  for (const r of await activeRestoresOfApp(deps.db, app.id)) {
    try {
      await advanceRestore(deps, b.k8s, app, r);
    } catch (err) {
      deps.logger.warn(`[vetra-apps] restore ${r.id} of ${app.slug}/${r.instance_id}: ${message(err)}`);
    }
  }
}

const parseReplicas = (raw: string | null): Record<string, number> =>
  raw ? (JSON.parse(raw) as Record<string, number>) : {};

const lastLine = (text: string) => text.trim().split("\n").filter(Boolean).at(-1) ?? "";

async function scaleAll(k8s: BackupK8s, ns: string, replicas: Record<string, number>, to?: number) {
  for (const [name, n] of Object.entries(replicas)) await k8s.scaleDeployment(ns, name, to ?? n);
}

/** "running", or the Job's end: error null on success. */
async function jobOutcome(
  k8s: BackupK8s,
  ns: string,
  name: string,
  timedOut: boolean,
): Promise<"running" | { error: string | null }> {
  const s = await k8s.readJobStatus(ns, name);
  if (!s) return { error: `Job ${name} no longer exists` };
  const isTrue = (t: string) => s.conditions?.some((c) => c.type === t && c.status === "True") ?? false;
  if (isTrue("Failed") || (s.failed ?? 0) > 0)
    return { error: lastLine(await k8s.readPodLogsForJob(ns, name)) || "the Job failed" };
  if (isTrue("Complete") || (s.succeeded ?? 0) > 0) return { error: null };
  if (timedOut) return { error: `Job ${name} did not finish in time` };
  return "running";
}

async function finish(
  deps: AppsDeps,
  r: InstanceRestoreRow,
  inst: InstanceRow | null,
  error: string | null,
  held: boolean,
): Promise<void> {
  const nowIso = deps.now().toISOString();
  await deps.db.transaction().execute(async (trx) => {
    await updateRestore(trx, r.id, { status: error ? "failed" : "succeeded", error, held, finished_at: nowIso }, nowIso);
    if (inst)
      await updateInstance(
        trx,
        inst.id,
        held
          ? { maintenance: heldMark(r.id), status: "failed", reason: `restore failed: ${error}`.slice(0, 500) }
          : { maintenance: null },
        nowIso,
      );
    await recordAudit(trx, {
      appId: r.app_id,
      at: nowIso,
      ...SYSTEM_WHO,
      action: "restore.finished",
      subject: `instance:${r.instance_id}`,
      detail: { restoreId: r.id, backupId: r.backup_id, purpose: r.purpose, outcome: error ? "failed" : "succeeded", error, held },
    });
  });
  if (error) deps.logger.warn(`[vetra-apps] restore ${r.id} of instance ${r.instance_id} failed: ${error}${held ? " (held)" : ""}`);
}

async function advanceRestore(deps: AppsDeps, k8s: BackupK8s, app: AppRow, r: InstanceRestoreRow): Promise<void> {
  const b = deps.backups!;
  const ns = r.tenant_id;
  const now = deps.now();
  const nowIso = now.toISOString();
  const age = now.getTime() - Date.parse(r.phase_started_at);
  // Fails closed: a phase start that does not parse is timed out.
  const over = (ms: number) => !(age <= ms);
  const move = (patch: RestorePatch) => updateRestore(deps.db, r.id, { ...patch, phase_started_at: nowIso }, nowIso);
  const inst = await getInstance(deps.db, r.instance_id);
  if (!inst) return finish(deps, r, null, "the instance is gone", false);
  const replicas = parseReplicas(r.replicas);
  // Nothing touched yet: a held instance stays held and stopped, anything else runs again.
  const scaleBack = () => scaleAll(k8s, ns, replicas, r.was_held ? 0 : undefined);
  const untouched = (error: string) => finish(deps, r, inst, error, r.was_held);

  switch (r.status) {
    case "safety_backup": {
      if (!r.safety_backup_id) {
        try {
          const s = await startInstanceBackup(deps, inst, { reason: "pre_restore", requestedBy: r.requested_by });
          await updateRestore(deps.db, r.id, { safety_backup_id: s.id }, nowIso);
        } catch (err) {
          if (err instanceof BackupBusyError && !over(SAFETY_START_TIMEOUT_MS)) return;
          return untouched(`the safety backup could not start: ${message(err)}; nothing was changed`);
        }
        return;
      }
      const s = await getBackup(deps.db, r.safety_backup_id);
      if (!s || s.status === "failed")
        return untouched(`the safety backup failed: ${s?.error ?? "it is gone"}; nothing was changed`);
      if (s.status !== "ready") return;
      const found = await k8s.readDeploymentReplicas(ns, APP_SELECTOR);
      if (Object.keys(found).length === 0) return untouched("no app Deployment in the namespace; nothing was changed");
      // A held instance is at 0 already: after a good restore it runs one replica.
      const keep = Object.fromEntries(Object.entries(found).map(([n, c]) => [n, Math.max(c, 1)]));
      // Recorded before scaling: a crash in between can always scale back.
      await move({ status: "stopping", replicas: JSON.stringify(keep) });
      await scaleAll(k8s, ns, keep, 0);
      return;
    }

    case "stopping": {
      if ((await k8s.countPods(ns, APP_SELECTOR)) === 0) {
        const backup = await getBackup(deps.db, r.backup_id);
        if (!backup?.dump_id) {
          await move({ status: "starting", error: "the backup is gone; nothing was changed" });
          await scaleBack();
          return;
        }
        const name = await k8s.createJob(
          ns,
          buildRestoreJob({ restoreId: r.id, dumpId: backup.dump_id, tenantNs: ns, ...b.dumpJob }),
        );
        await move({ status: "restoring_db", db_job: name || `pgrestore-${r.id}` });
        return;
      }
      if (over(RESTORE_STOP_TIMEOUT_MS)) {
        await move({ status: "starting", error: "the app did not stop in time; nothing was changed" });
        await scaleBack();
        return;
      }
      await scaleAll(k8s, ns, replicas, 0); // idempotent; re-asserts it
      return;
    }

    case "restoring_db": {
      const out = await jobOutcome(k8s, ns, r.db_job!, over(RESTORE_JOB_TIMEOUT_MS));
      if (out === "running") return;
      if (out.error) {
        // One transaction (RESTORE_SCRIPT): the database is as it was.
        await move({ status: "starting", error: `database restore failed: ${out.error}; nothing was changed` });
        await scaleBack();
        return;
      }
      if (!r.data) {
        await move({ status: "starting" });
        return;
      }
      const backup = await getBackup(deps.db, r.backup_id);
      const archive =
        backup?.archive_id && deps.observabilityDb
          ? await new ArchivesRepo(deps.observabilityDb).getById(backup.archive_id)
          : null;
      if (!archive?.sha256)
        return finish(deps, r, inst, "the database is restored but the /data archive is gone", true);
      const name = await k8s.createJob(
        ns,
        buildDataRestoreJob({
          restoreId: r.id,
          archiveId: archive.id,
          sha256: archive.sha256,
          tenantNs: ns,
          pvcName: archive.pvcName,
          image: b.archiveImage,
          bucket: b.dumpJob.bucket,
          s3Endpoint: b.dumpJob.s3Endpoint,
          s3AccessKey: b.dumpJob.s3AccessKey,
          s3SecretKey: b.dumpJob.s3SecretKey,
        }),
      );
      await move({ status: "restoring_data", data_job: name || `datarestore-${r.id}` });
      return;
    }

    case "restoring_data": {
      const out = await jobOutcome(k8s, ns, r.data_job!, over(RESTORE_JOB_TIMEOUT_MS));
      if (out === "running") return;
      if (out.error)
        return finish(deps, r, inst, `/data restore failed: ${out.error}; the database is restored, /data may be half restored`, true);
      await move({ status: "starting" });
      return;
    }

    case "starting": {
      if (r.error) {
        // Nothing was changed: back to what ran (a held instance stays at 0).
        if (!r.was_held && !(await k8s.deploymentsReady(ns, replicas)) && !over(RESTORE_STOP_TIMEOUT_MS)) {
          await scaleBack();
          return;
        }
        return finish(deps, r, inst, r.error, r.was_held);
      }
      if (r.then_version && !r.target_set) {
        const release = await releaseByVersion(deps.db, app.id, r.then_version);
        if (!release)
          return finish(deps, r, inst, `the data is restored but the App has no release ${r.then_version}`, true);
        const t = targetOf(release);
        await deps.db.transaction().execute(async (trx) => {
          // The restored data belongs to this release: a failed start goes
          // nowhere else (revertImage needs running_digest != target_digest),
          // never back to the image that migrated it. The reconciler applies
          // it and calls it ready only once it is healthy there ("updating"
          // until then, so a rollout never settles on the restore alone).
          await updateInstance(
            trx,
            inst.id,
            {
              ...t,
              status: "updating",
              reason: `restored the backup; starting ${t.target_version}`,
              update_started_at: nowIso,
              running_version: t.target_version,
              running_digest: t.target_digest,
              running_repository: t.target_repository,
              running_degraded: null,
              failed_digest: null,
              failed_settings: null,
              maintenance: null,
            },
            nowIso,
          );
          await updateRestore(trx, r.id, { target_set: true, phase_started_at: nowIso }, nowIso);
        });
        return;
      }
      if (r.target_set) {
        const images = await k8s.deploymentImages(ns, APP_SELECTOR);
        const onTarget = images.length > 0 && images.every((i) => i.endsWith(`@${inst.target_digest}`));
        if (!onTarget) {
          if (over(RESTORE_START_TIMEOUT_MS))
            return finish(deps, r, inst, `the data is restored but ${r.then_version} did not reach the cluster in time`, true);
          return;
        }
      }
      if (!(await k8s.deploymentsReady(ns, replicas)) && !over(RESTORE_START_TIMEOUT_MS)) {
        await scaleAll(k8s, ns, replicas);
        return;
      }
      // Ready, or the reconciler's health takes it from here.
      return finish(deps, r, inst, null, false);
    }

    default:
      return;
  }
}
```

- [ ] **Step 4: Run it again.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** `git add subgraphs/vetra-apps/backups/restore.ts subgraphs/vetra-apps/__tests__/backups-fixtures.ts subgraphs/vetra-apps/__tests__/backups-restore.test.ts && git commit -m "feat(backups): restore an instance backup (safety backup, stop, database, /data, hand back)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 10: The reconciler: maintenance, per-App advance, a final backup before a stop

**Files:**
- Modify: `subgraphs/vetra-apps/instances/reconciler.ts`, `subgraphs/vetra-apps/backups/service.ts` (`preStopGate`)
- Test: `subgraphs/vetra-apps/__tests__/backups-reconciler.test.ts`

**Interfaces:**
- Produces: `preStopGate(deps, row): Promise<"go" | "wait">`.
  - A `pre_stop` backup within the last day decides: pending → wait, ready or failed → go.
  - With none, it starts one and waits (busy → wait; unavailable → go, logged).
  - Backups off → go.
- Changes:
  - `reconcileInstance` returns at once for an instance with `maintenance` (after the removal branch).
  - `reconcileApp` runs `advanceBackups` and `advanceRestores` after `syncPlanInstances`, before slice 3's `advanceRollouts`, in their own try/catch.
  - `stopPlanInstance` sleeps a READY environment only after `preStopGate` says go (reason `<stop reason>: stopping after a final backup` meanwhile).

- [ ] **Step 1: Write the failing test.** Create `__tests__/backups-reconciler.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backupHarness, finishBackupJobs, planInstance, type BackupCtx } from "./backups-fixtures.js";
import { listBackupsOfInstance } from "../backups/repo.js";
import { advanceBackups, preStopGate } from "../backups/service.js";
import { getInstance, updateInstance } from "../instances/repo.js";
import { reconcileInstance } from "../instances/reconciler.js";
import { settingsForKind } from "../settings/resolve.js";

let ctx: BackupCtx;
beforeEach(async () => {
  ctx = await backupHarness();
});
afterEach(async () => {
  await ctx.h.close();
});

describe("instances in maintenance", () => {
  it("are left alone by the reconciler (a restore owns them)", async () => {
    const { h, appId, fake, app } = ctx;
    await planInstance(h, fake, appId, { id: "o1" });
    // Without maintenance this row would get a new environment.
    await updateInstance(h.db, "o1", { environment_id: null, status: "pending", maintenance: "held:r-1" }, "2026-10-02T12:00:00.000Z");
    await reconcileInstance(h.deps, await app(), (await getInstance(h.db, "o1"))!, settingsForKind([], "own"));
    expect(h.envs.docs.size).toBe(0);
    expect((await getInstance(h.db, "o1"))!.status).toBe("pending");
  });
});

describe("preStopGate (decision B9)", () => {
  it("takes a final backup before Vetra stops a plan instance, and never holds the stop on a failure", async () => {
    const { h, appId, fake } = ctx;
    const row = { ...(await planInstance(h, fake, appId, { id: "o1" })), stop_reason: "licence ended" };
    expect(await preStopGate(h.deps, row)).toBe("wait");
    expect((await listBackupsOfInstance(h.db, "o1", 5))[0]).toMatchObject({ reason: "pre_stop", status: "pending" });
    expect(await preStopGate(h.deps, row)).toBe("wait");
    await finishBackupJobs(h, fake);
    await advanceBackups(h.deps, appId);
    expect(await preStopGate(h.deps, row)).toBe("go");
    h.advance(86_400_000 + 1);
    expect(await preStopGate(h.deps, row)).toBe("wait"); // a day later: a new one
    await finishBackupJobs(h, fake, "dump_failed");
    await advanceBackups(h.deps, appId);
    expect(await preStopGate(h.deps, row)).toBe("go"); // failed: stop anyway (the database is kept)
    h.advance(86_400_000 + 1);
    fake.pvcs.clear();
    expect(await preStopGate(h.deps, row)).toBe("go"); // cannot back up: stop anyway
    h.deps.cfg = { ...h.deps.cfg, backups: { enabled: false, dailyKeepDays: 14, maxInFlight: 3 } };
    expect(await preStopGate(h.deps, row)).toBe("go");
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/backups-reconciler.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `backups/service.ts`: add `lastBackupOf` to the repo import, and:

```ts
/**
 * Before Vetra stops a plan instance (licence ended, plan retired): a
 * pre_stop backup within the last day (decision B9). A failed one, or one
 * that cannot be taken, never holds the stop: the chart keeps a stopped
 * plan instance's database (keepWhenDisabled).
 */
export async function preStopGate(deps: AppsDeps, row: InstanceRow): Promise<"go" | "wait"> {
  if (!backupsConfigOf(deps.cfg).enabled || !deps.backups) return "go";
  const last = await lastBackupOf(deps.db, row.id, "pre_stop");
  if (last && deps.now().getTime() - Date.parse(last.created_at) < DAY_MS)
    return last.status === "pending" ? "wait" : "go";
  try {
    await startInstanceBackup(deps, row, { reason: "pre_stop", requestedBy: AUDIT_SYSTEM_ACTOR });
    return "wait";
  } catch (err) {
    if (err instanceof BackupBusyError) return "wait";
    deps.logger.warn(`[vetra-apps] final backup of ${row.name} before its stop: ${message(err)}`);
    return "go";
  }
}
```

  - `instances/reconciler.ts`:
    - imports: `advanceBackups, preStopGate` from `../backups/service.js`, `advanceRestores` from `../backups/restore.js`;
    - in `reconcileInstance`, after the `if (row.removed_at) …` statement:

```ts
  // A restore owns it (backups/restore.ts): it hands the instance back itself.
  if (row.maintenance) return;
```

    - in `reconcileApp`, inside `if (plans.enabled && wantsInstances(app)) { … }`, after the `syncPlanInstances` try/catch and **before** slice 3's `advanceRollouts` try/catch:

```ts
    try {
      // Before the rollouts and the rows: a backup that became ready, or a
      // restore that hands an instance back, is seen in this pass.
      await advanceBackups(deps, app.id);
      await advanceRestores(deps, app);
    } catch (err) {
      deps.logger.warn(`[vetra-apps] backups of ${app.slug}: ${message(err)}`);
    }
```

    - in `stopPlanInstance`, at the start of the `if (state.status === "READY" || state.status === "DEPLOYMENt_FAILED") {` block:

```ts
      if (state.status === "READY" && (await preStopGate(deps, row)) === "wait") {
        const waiting = `${reason}: stopping after a final backup`;
        if (row.reason !== waiting) await patch(deps, row, { reason: waiting });
        return;
      }
```

- [ ] **Step 4: Run it again.** Same command, then `npx vitest run subgraphs/vetra-apps/__tests__/instances-plans.test.ts subgraphs/vetra-apps/__tests__/instances-reconciler.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20` (backups are off in `testConfig()`: the stop tests are unchanged). Expected: PASS.
- [ ] **Step 5: Commit.** `git add subgraphs/vetra-apps/instances/reconciler.ts subgraphs/vetra-apps/backups/service.ts subgraphs/vetra-apps/__tests__/backups-reconciler.test.ts && git commit -m "feat(instances): restores own their instance; a final backup before Vetra stops one" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 11: Daily backups and the retention sweep

**Files:**
- Create: `subgraphs/vetra-apps/backups/schedule.ts`
- Modify: `subgraphs/vetra-apps/index.ts`
- Test: `subgraphs/vetra-apps/__tests__/backups-schedule.test.ts`

**Interfaces:**
- Produces:
  - `DAILY_RETRY_MS` (1 h), `SWEEP_BATCH` (200);
  - `runDailyBackupsOnce(deps): Promise<{ started: string[]; deleted: number }>`:
    - which instances: shared and own, `ready`, not removed, not stopped, not in maintenance, with an environment;
    - when: once per 24 h each (a failed one again after 1 h), oldest instance first, at most `maxInFlight` pending backups cluster-wide;
    - how: each start under `instances:<appId>`, with the row re-read; then `sweepBackupsOnce`.
  - `sweepBackupsOnce(deps): Promise<number>`: expired backups, and failed ones older than a day, lose their S3 objects (dump and archive), their observability rows and their row. Backups an active restore uses are kept.
- Changes: `index.ts` runs it every 5 minutes when instances and backups are on.

- [ ] **Step 1: Write the failing test.** Create `__tests__/backups-schedule.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backupHarness, finishBackupJobs, planInstance, type BackupCtx } from "./backups-fixtures.js";
import { getBackup } from "../backups/repo.js";
import { beginRestore, SYSTEM_WHO } from "../backups/restore.js";
import { runDailyBackupsOnce } from "../backups/schedule.js";
import { advanceBackups, startInstanceBackup } from "../backups/service.js";
import { getInstance, updateInstance } from "../instances/repo.js";

let ctx: BackupCtx;
beforeEach(async () => {
  ctx = await backupHarness({ backups: { enabled: true, dailyKeepDays: 14, maxInFlight: 1 } });
});
afterEach(async () => {
  await ctx.h.close();
});
const settle = async () => {
  await finishBackupJobs(ctx.h, ctx.fake);
  await advanceBackups(ctx.h.deps, ctx.appId);
};

describe("daily backups (spec 7: daily, kept 14 days)", () => {
  it("backs up each ready shared and own instance once a day, at most maxInFlight at a time", async () => {
    const { h, appId, fake } = ctx;
    await planInstance(h, fake, appId, { id: "o1" });
    await planInstance(h, fake, appId, { id: "s1", kind: "shared" });
    await planInstance(h, fake, appId, { id: "o3", status: "updating" });
    await planInstance(h, fake, appId, { id: "o4" });
    await updateInstance(h.db, "o4", { maintenance: "restore:r-9" }, "2026-10-02T12:00:00.000Z");
    expect((await runDailyBackupsOnce(h.deps)).started).toHaveLength(1);
    expect((await runDailyBackupsOnce(h.deps)).started).toEqual([]); // one in flight
    await settle();
    expect((await runDailyBackupsOnce(h.deps)).started).toHaveLength(1);
    await settle();
    expect((await runDailyBackupsOnce(h.deps)).started).toEqual([]); // both have today's
    const rows = await h.db.selectFrom("instance_backups").select(["instance_id", "reason"]).orderBy("instance_id").execute();
    expect(rows).toEqual([
      { instance_id: "o1", reason: "daily" },
      { instance_id: "s1", reason: "daily" },
    ]);
    h.advance(86_400_000);
    expect((await runDailyBackupsOnce(h.deps)).started).toHaveLength(1);
  });

  it("retries a failed daily backup after an hour", async () => {
    const { h, appId, fake } = ctx;
    await planInstance(h, fake, appId, { id: "o1" });
    await runDailyBackupsOnce(h.deps);
    await finishBackupJobs(h, fake, "dump_failed");
    await advanceBackups(h.deps, appId);
    expect((await runDailyBackupsOnce(h.deps)).started).toEqual([]);
    h.advance(3_600_000);
    expect((await runDailyBackupsOnce(h.deps)).started).toHaveLength(1);
  });

  it("sweeps expired backups (S3 objects and rows) but keeps one a restore uses", async () => {
    const { h, appId, fake, deletedKeys } = ctx;
    const b = await startInstanceBackup(h.deps, await planInstance(h, fake, appId, { id: "o1" }), { reason: "daily", requestedBy: "vetra" });
    await settle();
    const c = await startInstanceBackup(h.deps, await planInstance(h, fake, appId, { id: "o2" }), { reason: "daily", requestedBy: "vetra" });
    await settle();
    await beginRestore(h.deps, (await getInstance(h.db, "o2"))!, (await getBackup(h.db, c.id))!, {
      purpose: "manual",
      thenVersion: null,
      who: SYSTEM_WHO,
    });
    h.advance(15 * 86_400_000);
    expect((await runDailyBackupsOnce(h.deps)).deleted).toBe(1);
    expect(await getBackup(h.db, b.id)).toBeNull();
    expect(await getBackup(h.db, c.id)).not.toBeNull();
    expect(deletedKeys).toEqual([`t-o1/${b.dump_id}.dump`, `t-o1/data/${b.archive_id}.tar.zst`]);
    expect(await h.obsDb.selectFrom("database_dumps").select("id").where("id", "=", b.dump_id!).execute()).toEqual([]);
    expect(await h.obsDb.selectFrom("data_archives").select("id").where("id", "=", b.archive_id!).execute()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/backups-schedule.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL.
- [ ] **Step 3: Implement.** Create `backups/schedule.ts`:

```ts
import { withKeyLock } from "../../../shared/key-lock.js";
import { ArchivesRepo } from "../../vetra-cloud-observability/dumps/archive-repo.js";
import { DumpsRepo } from "../../vetra-cloud-observability/dumps/repo.js";
import { AUDIT_SYSTEM_ACTOR } from "../audit/repo.js";
import { backupsConfigOf } from "../config.js";
import { getInstance } from "../instances/repo.js";
import type { AppsDeps } from "../service.js";
import { countPendingBackups, deleteBackup, lastBackupOf, sweepableBackups } from "./repo.js";
import { BackupBusyError, startInstanceBackup } from "./service.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
export const DAILY_RETRY_MS = HOUR_MS;
export const SWEEP_BATCH = 200;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 500);

/**
 * The daily backup of every running shared and own instance (spec section
 * 7, decision B7), then the retention sweep. Runs every few minutes; the
 * in-flight cap spreads the first wave.
 */
export async function runDailyBackupsOnce(deps: AppsDeps): Promise<{ started: string[]; deleted: number }> {
  const cfg = backupsConfigOf(deps.cfg);
  if (!cfg.enabled || !deps.backups || !deps.cfg.instances.enabled) return { started: [], deleted: 0 };
  const rows = await deps.db
    .selectFrom("instances")
    .selectAll()
    .where("kind", "in", ["shared", "own"])
    .where("removed_at", "is", null)
    .where("environment_id", "is not", null)
    .where("status", "=", "ready")
    .where("stop_reason", "is", null)
    .where("maintenance", "is", null)
    .orderBy("created_at")
    .orderBy("id")
    .execute();
  let budget = cfg.maxInFlight - (await countPendingBackups(deps.db));
  const started: string[] = [];
  for (const row of rows) {
    if (budget <= 0) break;
    const last = await lastBackupOf(deps.db, row.id, "daily");
    if (last) {
      const age = deps.now().getTime() - Date.parse(last.created_at);
      if (last.status === "pending") continue;
      if (last.status === "ready" && age < DAY_MS) continue;
      if (last.status === "failed" && age < DAILY_RETRY_MS) continue;
    }
    try {
      const b = await withKeyLock(`instances:${row.app_id}`, async () => {
        // Re-read under the lock: a restore may have taken it meanwhile.
        const cur = await getInstance(deps.db, row.id);
        if (!cur || cur.maintenance || cur.stop_reason || cur.status !== "ready") return null;
        return startInstanceBackup(deps, cur, { reason: "daily", requestedBy: AUDIT_SYSTEM_ACTOR });
      });
      if (b) {
        started.push(b.id);
        budget--;
      }
    } catch (err) {
      if (!(err instanceof BackupBusyError))
        deps.logger.warn(`[vetra-apps] daily backup of instance ${row.name}: ${message(err)}`);
    }
  }
  return { started, deleted: await sweepBackupsOnce(deps) };
}

/**
 * Deletes expired backups, and failed ones older than a day: their S3
 * objects (a failed delete is logged; the bucket lifecycle removes the file
 * within 30 days), their observability rows, then their row.
 */
export async function sweepBackupsOnce(deps: AppsDeps): Promise<number> {
  const b = deps.backups;
  const obs = deps.observabilityDb;
  if (!b || !obs) return 0;
  const now = deps.now();
  const rows = await sweepableBackups(
    deps.db,
    now.toISOString(),
    new Date(now.getTime() - DAY_MS).toISOString(),
    SWEEP_BATCH,
  );
  const dumps = new DumpsRepo(obs);
  const archives = new ArchivesRepo(obs);
  for (const r of rows) {
    const dump = r.dump_id ? await dumps.getById(r.dump_id) : null;
    const archive = r.archive_id ? await archives.getById(r.archive_id) : null;
    for (const key of [dump?.s3Key, archive?.s3Key])
      if (key)
        await b.deleteObject(key).catch((err: unknown) =>
          deps.logger.warn(`[vetra-apps] backup sweep: deleting ${key} failed: ${message(err)}`),
        );
    if (dump) await dumps.deleteById(dump.id);
    if (archive) await archives.deleteById(archive.id);
    await deleteBackup(deps.db, r.id);
  }
  return rows.length;
}
```

  In `index.ts`, inside `if (cfg.instances.enabled) { … }`:

```ts
      if (backupsConfigOf(cfg).enabled)
        every(5 * 60_000, "instance backups", () => runDailyBackupsOnce(deps));
```

  (import `runDailyBackupsOnce` from `./backups/schedule.js`).
- [ ] **Step 4: Run it again.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** `git add subgraphs/vetra-apps/backups/schedule.ts subgraphs/vetra-apps/index.ts subgraphs/vetra-apps/__tests__/backups-schedule.test.ts && git commit -m "feat(backups): daily instance backups, kept 14 days" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 12: The slice 3 contract (`backups/rollout.ts`)

**Files:**
- Create: `subgraphs/vetra-apps/backups/rollout.ts`
- Test: `subgraphs/vetra-apps/__tests__/backups-contract.test.ts`

**Interfaces:**
- Produces: `backupsOn`, `backupBeforeUpdate`, `backupProgress`, `restoreBackup`, `restoreProgress`, `BackupProgress`, `RestoreProgress`, and the re-exports `BACKUP_TIMEOUT_MS`, `BackupBusyError`, `BackupUnavailableError`, `RestoreBusyError`, `isHeld`. See "Contract with slice 3". This file never reads a rollout table.

- [ ] **Step 1: Write the failing test.** Create `__tests__/backups-contract.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backupHarness, driveRestores, finishBackupJobs, pass, planInstance, type BackupCtx } from "./backups-fixtures.js";
import {
  backupBeforeUpdate,
  backupProgress,
  backupsOn,
  restoreBackup,
  restoreProgress,
} from "../backups/rollout.js";
import { getInstance } from "../instances/repo.js";

let ctx: BackupCtx;
beforeEach(async () => {
  ctx = await backupHarness();
});
afterEach(async () => {
  await ctx.h.close();
});

describe("the rollout contract", () => {
  it("backupBeforeUpdate and restoreBackup, through their progress", async () => {
    const { h, appId, fake } = ctx;
    const inst = await planInstance(h, fake, appId, { id: "o1" });
    expect(backupsOn(h.deps)).toBe(true);
    const id = await backupBeforeUpdate(h.deps, inst, "step-1");
    expect(await backupProgress(h.deps, id)).toEqual({ state: "pending" });
    await finishBackupJobs(h, fake);
    await pass(ctx);
    expect(await backupProgress(h.deps, id)).toMatchObject({ state: "ready", version: "1.4.0" });
    const rid = await restoreBackup(h.deps, (await getInstance(h.db, "o1"))!, id, {
      purpose: "rollback",
      thenVersion: "1.4.0",
      stepId: "step-1",
    });
    expect(await restoreProgress(h.deps, rid)).toEqual({ state: "running", phase: "safety_backup" });
    await driveRestores(ctx);
    expect(await restoreProgress(h.deps, rid)).toEqual({ state: "succeeded" });
    expect(await backupProgress(h.deps, "nope")).toEqual({ state: "failed", error: "the backup is gone" });
    h.advance(31 * 86_400_000);
    expect(await backupProgress(h.deps, id)).toEqual({ state: "failed", error: "the backup expired" });
    h.deps.backups = null;
    expect(backupsOn(h.deps)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/backups-contract.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL.
- [ ] **Step 3: Implement.** Create `backups/rollout.ts`:

```ts
/**
 * What rollouts (releases phase 3 slice 3) call: the whole contract between
 * the rollout runner and instance backups. Nothing here reads a rollout
 * table; the runner keeps the ids on its steps.
 */
import { AUDIT_SYSTEM_ACTOR } from "../audit/repo.js";
import { backupsConfigOf } from "../config.js";
import type { InstanceRestoreStatus } from "../db/schema.js";
import type { InstanceRow } from "../instances/repo.js";
import type { AppsDeps } from "../service.js";
import { getBackup, getRestore } from "./repo.js";
import { beginRestore, SYSTEM_WHO } from "./restore.js";
import { startInstanceBackup } from "./service.js";

export { BACKUP_TIMEOUT_MS, BackupBusyError, BackupUnavailableError } from "./service.js";
export { isHeld, RestoreBusyError } from "./restore.js";

export type BackupProgress =
  | { state: "pending" }
  | { state: "ready"; takenAt: string; version: string | null }
  | { state: "failed"; error: string };

export type RestoreProgress =
  | { state: "running"; phase: InstanceRestoreStatus }
  | { state: "succeeded" }
  | { state: "failed"; error: string; held: boolean };

/** VETRA_APPS_BACKUPS=on and wired; false: rollouts behave as without slice 4. */
export const backupsOn = (deps: AppsDeps): boolean =>
  backupsConfigOf(deps.cfg).enabled && !!deps.backups;

/**
 * Starts the backup before a rollout step moves `instance`. Throws
 * BackupBusyError (try on a later pass) or BackupUnavailableError (fail the step).
 */
export async function backupBeforeUpdate(deps: AppsDeps, instance: InstanceRow, stepId: string): Promise<string> {
  const b = await startInstanceBackup(deps, instance, {
    reason: "pre_update",
    requestedBy: AUDIT_SYSTEM_ACTOR,
    rolloutStepId: stepId,
  });
  return b.id;
}

/** Advanced by advanceBackups, which runs in the same per-App pass before advanceRollouts. */
export async function backupProgress(deps: AppsDeps, backupId: string): Promise<BackupProgress> {
  const b = await getBackup(deps.db, backupId);
  if (!b) return { state: "failed", error: "the backup is gone" };
  if (b.status === "pending") return { state: "pending" };
  if (b.status === "failed") return { state: "failed", error: b.error ?? "the backup failed" };
  if (!(Date.parse(b.expires_at) > deps.now().getTime())) return { state: "failed", error: "the backup expired" };
  return { state: "ready", takenAt: b.created_at, version: b.version };
}

/**
 * Restores `backupId` into `instance` (its own backup only), then sets the
 * instance's target and running release to `thenVersion` (null: unchanged)
 * and hands it back to the reconciler. Callers hold instances:<appId>.
 */
export async function restoreBackup(
  deps: AppsDeps,
  instance: InstanceRow,
  backupId: string,
  o: { purpose: "rollback" | "failed_update"; thenVersion: string | null; stepId: string },
): Promise<string> {
  const backup = await getBackup(deps.db, backupId);
  if (!backup) throw new Error(`backup ${backupId} is gone`);
  const r = await beginRestore(deps, instance, backup, {
    purpose: o.purpose,
    thenVersion: o.thenVersion,
    who: SYSTEM_WHO,
    rolloutStepId: o.stepId,
  });
  return r.id;
}

/** Advanced by advanceRestores, in the same per-App pass before advanceRollouts. */
export async function restoreProgress(deps: AppsDeps, restoreId: string): Promise<RestoreProgress> {
  const r = await getRestore(deps.db, restoreId);
  if (!r) return { state: "failed", error: "the restore is gone", held: false };
  if (r.status === "succeeded") return { state: "succeeded" };
  if (r.status === "failed") return { state: "failed", error: r.error ?? "the restore failed", held: r.held };
  return { state: "running", phase: r.status };
}
```

- [ ] **Step 4: Run it again.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** `git add subgraphs/vetra-apps/backups/rollout.ts subgraphs/vetra-apps/__tests__/backups-contract.test.ts && git commit -m "feat(backups): the contract rollouts call (backupBeforeUpdate, restoreBackup)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 13: Rollouts back up first and roll `migrates` releases back by restore (edits slice 3)

**Files:**
- Modify (slice 3's code):
  - `subgraphs/vetra-apps/db/schema.ts` (`RolloutStepStatus`, `RolloutStepsTable`);
  - `subgraphs/vetra-apps/db/migrations.ts` (`ensureRolloutBackupColumns`);
  - `subgraphs/vetra-apps/rollouts/repo.ts` (`MOVING`);
  - `subgraphs/vetra-apps/rollouts/runner.ts`;
  - `subgraphs/vetra-apps/rollouts/controls.ts` (`rollBackRollout`);
  - `subgraphs/vetra-apps/rollouts/service.ts` (`RolloutStepJson`);
  - `subgraphs/vetra-apps/schema.ts`, `subgraphs/vetra-apps/resolvers.ts`.
- Test: `subgraphs/vetra-apps/__tests__/rollouts-backups.test.ts` (new), `subgraphs/vetra-apps/__tests__/migrations.test.ts`

**Interfaces:**
- Consumes: `backups/rollout.ts` (Task 12); slice 3's runner internals by name (`startStep`, `settle`, `startRevert`, `failStep`, `endStep`, `stepEntry`, `pointInstanceAt`, `finishDone`, `transitionStep`, `getRollout`, `lockRollout`, `updateRollout`, `SYSTEM`, `REMOVED_NOTE`).
- Produces:
  - step statuses `backing_up` and `restoring`; `rollout_steps.backup_id`, `restore_id`;
  - `MOVING = ["backing_up", "applying", "restoring", "reverting"]`; index `rollout_steps_moving_v2_uq` (the old `rollout_steps_moving_uq` is dropped);
  - `ensureRolloutBackupColumns(db)`;
  - `rollBackRollout(deps, caller, rolloutId, opts?: { acceptDataLoss?: boolean })`;
  - `RolloutStepJson.backupId`, `.restoreId`; SDL `AppRolloutStep.backupId: ID`, `.restoreId: ID`; `rollBackRollout(rolloutId: ID!, acceptDataLoss: Boolean): AppRollout!`.
- Behaviour:
  - Forward step: `pending` → `backing_up` → `applying` (the target moves) → as slice 3.
    - The backup fails or times out: `failed`, target unmoved, rollout paused.
    - The rollout was paused meanwhile: back to `pending` without the backup. Cancelled: `skipped`.
    - The backup is busy: the step waits. The instance is in maintenance: the step waits; if it is held, the step fails.
  - A forward failure of a release that `migrates`, with a ready backup (B8): `applying` → `restoring` (rollout paused with an alert) → `failed` with the note "restored the backup from before the update", or with the restore's error.
  - Rollback of a release that `migrates` (B14): `revert_pending` → `restoring` → `reverting` → `rolled_back`.
    - No backup: image only, with a note.
    - Stopped: `skipped` with a note.
  - Backups off: everything as slice 3 (R5's refusal stays).

- [ ] **Step 1: Write the failing tests.** In `migrations.test.ts` add `ensureRolloutBackupColumns` to the import and append:

```ts
describe("rollout steps that back up", () => {
  it("get backup_id and restore_id, and one moving step per App counts backing_up and restoring", async () => {
    const root = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
    try {
      await sql`CREATE SCHEMA "vetra-apps"`.execute(root);
      const any = root.withSchema("vetra-apps");
      await up(any);
      await Promise.all([1, 2, 3].map(() => ensureRolloutBackupColumns(any)));
      const step = (id: string, instance: string, status: string) => ({
        id,
        rollout_id: "r1",
        app_id: "app-1",
        plan_id: "p1",
        instance_id: instance,
        instance_kind: "own",
        instance_name: instance,
        position: 0,
        from_version: "1.0.0",
        to_version: "1.1.0",
        status,
        due_at: "2026-11-12T00:00:00.000Z",
        requested_at: null,
        started_at: null,
        finished_at: null,
        target_moved: false,
        attempts: 0,
        error: null,
        note: null,
        backup_id: "b-1",
        restore_id: null,
        created_at: "2026-11-12T00:00:00.000Z",
        updated_at: "2026-11-12T00:00:00.000Z",
      });
      await any.insertInto("rollout_steps").values(step("s1", "i1", "backing_up")).execute();
      await expect(
        any.insertInto("rollout_steps").values(step("s2", "i2", "restoring")).execute(),
      ).rejects.toMatchObject({ code: "23505" });
    } finally {
      await root.destroy();
    }
  });
});
```

Create `__tests__/rollouts-backups.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { owner, type Harness } from "./harness.js";
import { digest } from "./instances-fixtures.js";
import { becomeReady, failUpdate, HOLDER_A, instance, readyInstance, rolloutHarness, seedPlan } from "./rollouts-fixtures.js";
import { fakeBackupK8s, finishBackupJobs, type FakeBackupK8s } from "./backups-fixtures.js";
import { activeRestoresOfApp, listBackupsOfInstance } from "../backups/repo.js";
import { advanceRestores } from "../backups/restore.js";
import { advanceBackups } from "../backups/service.js";
import { getApp } from "../repo.js";
import { rollBackRollout } from "../rollouts/controls.js";
import { getRollout, stepsOf } from "../rollouts/repo.js";
import { advanceRollouts } from "../rollouts/runner.js";
import { startRollout } from "../rollouts/service.js";

let h: Harness;
let appId: string;
let fake: FakeBackupK8s;

/** A namespace, a data PVC, a running app and its image for a fixture instance (its row has none). */
async function inCluster(id: string) {
  const i = await instance(h, id);
  const env = i.environment_id ?? `env-${id}`;
  await h.db.updateTable("instances").set({ environment_id: env }).where("id", "=", id).execute();
  h.tenants.set(env, `t-${id}`);
  fake.pvcs.set(`t-${id}`, `powerhouse-t-${id}-app-data`);
  fake.deployments.set(`t-${id}`, { [`powerhouse-t-${id}-app`]: 1 });
  fake.images.set(`t-${id}`, [`${i.target_repository}:${i.target_version}@${i.target_digest}`]);
}
const runsTarget = async (id: string) => {
  const i = await instance(h, id);
  fake.images.set(`t-${id}`, [`${i.target_repository}:${i.target_version}@${i.target_digest}`]);
};

beforeEach(async () => {
  ({ h, appId } = await rolloutHarness());
  fake = fakeBackupK8s();
  h.deps.cfg = { ...h.deps.cfg, backups: { enabled: true, dailyKeepDays: 14, maxInFlight: 3 } };
  h.deps.backups = {
    k8s: fake.k8s,
    dumpJob: { image: "cr.vetra.io/x/d:1", bucket: "dumps", s3Endpoint: "https://s3.test", s3AccessKey: "AK", s3SecretKey: "SK" },
    archiveImage: "cr.vetra.io/x/d:1.1",
    deleteObject: async () => {},
  };
  await seedPlan(h, appId, { id: "p-pro", slug: "pro", access: "own" });
  await readyInstance(h, appId, { id: "o1", planId: "p-pro", kind: "own", holder: HOLDER_A });
  await inCluster("o1");
});
afterEach(async () => {
  await h.close();
});

/** One reconciler pass of the App: backups, restores, then the rollouts (as reconcileApp orders them). */
const pass = async () => {
  const app = (await getApp(h.db, appId))!;
  await advanceBackups(h.deps, appId);
  await advanceRestores(h.deps, app);
  await advanceRollouts(h.deps, app);
};
const statuses = async (id: string) => (await stepsOf(h.db, id)).map((s) => `${s.instance_id}:${s.status}`);
const start = () => startRollout(h.deps, owner, { appId, version: "1.4.1", planIds: ["p-pro"], noticeHours: 0 });
const migrates = () => h.db.updateTable("releases").set({ migrates: true }).where("version", "=", "1.4.1").execute();
/** Restore Jobs finish; a handed-back instance runs its target. */
async function settleRestores() {
  for (let n = 0; n < 20 && (await activeRestoresOfApp(h.db, appId)).length > 0; n++) {
    await finishBackupJobs(h, fake);
    fake.finish("pgrestore-");
    fake.finish("datarestore-");
    for (const r of await activeRestoresOfApp(h.db, appId)) if (r.target_set) await runsTarget(r.instance_id);
    await pass();
  }
}

describe("rollouts with backups (spec 7 step 4)", () => {
  it("backs up before it moves the instance; the target moves once the backup is ready", async () => {
    const r = await start();
    await pass();
    expect(await statuses(r.id)).toEqual(["o1:backing_up"]);
    expect((await instance(h, "o1")).target_version).toBe("1.4.0");
    const [step] = await stepsOf(h.db, r.id);
    const [b] = await listBackupsOfInstance(h.db, "o1", 5);
    expect(b).toMatchObject({ reason: "pre_update", status: "pending", rollout_step_id: step.id });
    expect(step.backup_id).toBe(b.id);
    await pass();
    expect(await statuses(r.id)).toEqual(["o1:backing_up"]);
    await finishBackupJobs(h, fake);
    await pass();
    expect(await statuses(r.id)).toEqual(["o1:applying"]);
    expect(await instance(h, "o1")).toMatchObject({ target_version: "1.4.1", target_digest: digest("c") });
    await becomeReady(h, "o1");
    await pass();
    expect(await statuses(r.id)).toEqual(["o1:succeeded"]);
  });

  it("a failed backup pauses the rollout before anything moves", async () => {
    const r = await start();
    await pass();
    await finishBackupJobs(h, fake, "dump_failed");
    await pass();
    expect(await statuses(r.id)).toEqual(["o1:failed"]);
    expect(await getRollout(h.db, r.id)).toMatchObject({
      status: "paused",
      paused_reason: expect.stringMatching(/backup failed: database dump: pg_dump: boom/),
    });
    expect((await instance(h, "o1")).target_version).toBe("1.4.0");
  });

  it("a failed update of a release that migrates restores its backup, then the step is failed and the rollout paused", async () => {
    await migrates();
    const r = await start();
    await pass();
    await finishBackupJobs(h, fake);
    await pass();
    await runsTarget("o1");
    await failUpdate(h, "o1");
    await pass();
    expect(await statuses(r.id)).toEqual(["o1:restoring"]);
    expect((await getRollout(h.db, r.id))!.status).toBe("paused");
    expect((await activeRestoresOfApp(h.db, appId))[0]).toMatchObject({
      purpose: "failed_update",
      then_version: "1.4.0",
      instance_id: "o1",
    });
    await settleRestores();
    await pass();
    expect((await stepsOf(h.db, r.id))[0]).toMatchObject({
      status: "failed",
      note: "restored the backup from before the update",
    });
    expect(await instance(h, "o1")).toMatchObject({ target_version: "1.4.0", maintenance: null });
  });

  it("rolling back a release that migrates needs acceptDataLoss and restores the backup from before the update", async () => {
    await migrates();
    const r = await start();
    await pass();
    await finishBackupJobs(h, fake);
    await pass();
    await becomeReady(h, "o1");
    await pass();
    expect(await statuses(r.id)).toEqual(["o1:succeeded"]);
    await expect(rollBackRollout(h.deps, owner, r.id)).rejects.toThrow(/acceptDataLoss/);
    await rollBackRollout(h.deps, owner, r.id, { acceptDataLoss: true });
    await pass();
    expect(await statuses(r.id)).toEqual(["o1:restoring"]);
    expect((await activeRestoresOfApp(h.db, appId))[0]).toMatchObject({ purpose: "rollback", then_version: "1.4.0" });
    await settleRestores();
    expect(await statuses(r.id)).toEqual(["o1:reverting"]);
    await becomeReady(h, "o1");
    await pass();
    expect(await statuses(r.id)).toEqual(["o1:rolled_back"]);
    expect((await getRollout(h.db, r.id))!.status).toBe("rolled_back");
  });

  it("with backups off, rollouts are slice 3's: straight to applying, and a migrates rollback is refused", async () => {
    h.deps.cfg = { ...h.deps.cfg, backups: { enabled: false, dailyKeepDays: 14, maxInFlight: 3 } };
    const r = await start();
    await pass();
    expect(await statuses(r.id)).toEqual(["o1:applying"]);
    expect(await listBackupsOfInstance(h.db, "o1", 5)).toEqual([]);
    await migrates();
    await expect(rollBackRollout(h.deps, owner, r.id, { acceptDataLoss: true })).rejects.toThrow(/VETRA_APPS_BACKUPS/);
  });
});
```

  If slice 3's fixtures landed under other names (`rolloutHarness`, `seedPlan`, `readyInstance`, `becomeReady`, `failUpdate`, `instance`), adapt only the setup lines. Keep the assertions.
- [ ] **Step 2: Run them.** `npx vitest run subgraphs/vetra-apps/__tests__/migrations.test.ts subgraphs/vetra-apps/__tests__/rollouts-backups.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL.
- [ ] **Step 3: Schema, migration, repo.**
  - `db/schema.ts`: add `| "backing_up" | "restoring"` to `RolloutStepStatus`, and to `RolloutStepsTable`:

```ts
  /** The pre_update backup taken before this step moved its instance (slice 4). */
  backup_id?: string | null;
  /** The restore this step runs: a rollback, or a failed update of a release that migrates (slice 4). */
  restore_id?: string | null;
```

  - `db/migrations.ts`: at the end of `up` add `await ensureRolloutBackupColumns(db);`, and:

```ts
/** Rollout steps that back up first and restore (releases phase 3 slice 4). */
export async function ensureRolloutBackupColumns(db: Kysely<any>): Promise<void> {
  for (const name of ["backup_id", "restore_id"]) {
    try {
      await db.schema
        .alterTable("rollout_steps")
        .addColumn(name, "varchar(64)", (c) => c.ifNotExists())
        .execute();
    } catch (err) {
      if (!isConcurrentIndexError(err) && !isDuplicateColumnError(err)) throw err;
    }
  }
  try {
    // One moving instance per App, now counting backups and restores.
    await db.schema
      .createIndex("rollout_steps_moving_v2_uq")
      .ifNotExists()
      .unique()
      .on("rollout_steps")
      .column("app_id")
      .where((eb) =>
        eb.or([
          eb("status", "=", "backing_up"),
          eb("status", "=", "applying"),
          eb("status", "=", "restoring"),
          eb("status", "=", "reverting"),
        ]),
      )
      .execute();
  } catch (err) {
    if (!isConcurrentIndexError(err)) throw err;
  }
  try {
    await db.schema.dropIndex("rollout_steps_moving_uq").ifExists().execute();
  } catch (err) {
    if (!isConcurrentIndexError(err)) throw err;
  }
}
```

  - `rollouts/repo.ts`: `export const MOVING = ["backing_up", "applying", "restoring", "reverting"] as const;` (comment: "rollout_steps_moving_v2_uq").
- [ ] **Step 4: The runner.** In `rollouts/runner.ts`:
  - Imports:
    - `backupBeforeUpdate`, `backupProgress`, `backupsOn`, `restoreBackup`, `restoreProgress`, `isHeld`, `BackupBusyError`, `BACKUP_TIMEOUT_MS` from `../backups/rollout.js`;
    - `type InstanceRow` from `../instances/repo.js`;
    - `getRollout` from `./repo.js`.
    - If the runner has no `message(err)` helper, add `const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 500);`.
  - Extract the pause out of `failStep`. Replace, in `failStep`, everything from `const r = await lockRollout(trx, step.rollout_id);` to the end of the transaction callback with `await pauseWithAlert(trx, app, step, error, nowIso);`, and add:

```ts
/** Pauses the step's rollout with an alert row (spec 7 step 4). Pass the transaction. */
async function pauseWithAlert(
  trx: Kysely<VetraAppsDB>,
  app: AppRow,
  step: RolloutStepRow,
  error: string,
  nowIso: string,
): Promise<void> {
  const r = await lockRollout(trx, step.rollout_id);
  if (r.status !== "active") return;
  await updateRollout(
    trx,
    r.id,
    { status: "paused", paused_at: nowIso, paused_reason: `${step.instance_name}: ${error}`.slice(0, 500) },
    nowIso,
  );
  await recordAudit(trx, {
    appId: app.id,
    at: nowIso,
    ...SYSTEM,
    action: "rollout.paused",
    subject: `rollout:${r.id}`,
    detail: { alert: true, version: r.version, instance: step.instance_name, reason: error },
  });
}
```

  - `startStep`: replace its tail, from `const stopped = !!inst.stop_reason || inst.status === "stopped";` to its end, with:

```ts
  const stopped = !!inst.stop_reason || inst.status === "stopped";
  if (inst.maintenance) {
    // A restore owns it: wait (one instance at a time), unless a failed restore holds it.
    if (!isHeld(inst.maintenance)) return true;
    await failStep(deps, app, s, "failed", "the instance is stopped after a failed restore; restore it first", null);
    return false;
  }
  // Spec 7 step 4: a backup before each update. The target moves in settleBackup.
  if (!stopped && backupsOn(deps)) return startBackup(deps, app, inst, s);
  const nowIso = deps.now().toISOString();
  await deps.db.transaction().execute(async (trx) => {
    const moved = await transitionStep(
      trx,
      s.id,
      ["pending"],
      stopped
        ? { status: "skipped", note: STOPPED_NOTE, target_moved: true, started_at: nowIso, finished_at: nowIso, attempts: s.attempts + 1 }
        : { status: "applying", target_moved: true, started_at: nowIso, error: null, attempts: s.attempts + 1 },
      nowIso,
    );
    if (!moved) return;
    await pointInstanceAt(trx, app.id, inst.id, s.to_version, nowIso);
    await recordAudit(trx, stepEntry(s, moved.status, nowIso, { note: moved.note }));
  });
  return !stopped;
}

/** Starts the backup before a step moves its instance; true while the queue waits on it. */
async function startBackup(deps: AppsDeps, app: AppRow, inst: InstanceRow, s: RolloutStepRow): Promise<boolean> {
  let backupId: string;
  try {
    backupId = await backupBeforeUpdate(deps, inst, s.id);
  } catch (err) {
    // A daily or manual backup of it is running: this step waits its turn.
    if (err instanceof BackupBusyError) return true;
    await failStep(deps, app, s, "failed", `cannot back up the instance: ${message(err)}`, null);
    return false;
  }
  const nowIso = deps.now().toISOString();
  await deps.db.transaction().execute(async (trx) => {
    const moved = await transitionStep(
      trx,
      s.id,
      ["pending"],
      { status: "backing_up", backup_id: backupId, started_at: nowIso, error: null, attempts: s.attempts + 1 },
      nowIso,
    );
    if (moved) await recordAudit(trx, stepEntry(s, "backing_up", nowIso, { note: "backing up before the update" }));
  });
  return true;
}

/** The backup is ready: the target moves (applying); failed or late: the step fails, nothing moved. */
async function settleBackup(deps: AppsDeps, app: AppRow, step: RolloutStepRow): Promise<boolean> {
  const inst = await getInstance(deps.db, step.instance_id);
  if (!inst || inst.removed_at || inst.status === "removed") {
    await endStep(deps, step, "skipped", { note: REMOVED_NOTE });
    return false;
  }
  const p = await backupProgress(deps, step.backup_id!);
  if (p.state === "pending") {
    const started = Date.parse(step.started_at ?? "");
    if (Number.isFinite(started) && deps.now().getTime() - started <= BACKUP_TIMEOUT_MS) return true;
    await failStep(deps, app, step, "failed", `the backup did not finish in ${BACKUP_TIMEOUT_MS / 60_000} minutes`, null);
    return false;
  }
  if (p.state === "failed") {
    await failStep(deps, app, step, "failed", `backup failed: ${p.error}`, null);
    return false;
  }
  const nowIso = deps.now().toISOString();
  const r = await getRollout(deps.db, step.rollout_id);
  if (r?.status !== "active") {
    // Paused or cancelled meanwhile (B15): nothing moved. A paused step takes a
    // fresh backup when it starts again (this one would miss what is written until then).
    const paused = r?.status === "paused";
    await deps.db.transaction().execute(async (trx) => {
      const moved = await transitionStep(
        trx,
        step.id,
        ["backing_up"],
        paused
          ? { status: "pending", backup_id: null, started_at: null }
          : { status: "skipped", note: "cancelled before its update", finished_at: nowIso },
        nowIso,
      );
      if (moved) await recordAudit(trx, stepEntry(step, moved.status, nowIso, { note: moved.note }));
    });
    return false;
  }
  await deps.db.transaction().execute(async (trx) => {
    // STEP_TIMEOUT_MS counts from here.
    const moved = await transitionStep(
      trx,
      step.id,
      ["backing_up"],
      { status: "applying", target_moved: true, started_at: nowIso },
      nowIso,
    );
    if (!moved) return;
    await pointInstanceAt(trx, app.id, step.instance_id, step.to_version, nowIso);
    await recordAudit(trx, stepEntry(step, "applying", nowIso, { note: "backed up" }));
  });
  return true;
}

/** B8: a failed update of a release that migrates, with a ready backup from before it. */
async function wantsRecovery(deps: AppsDeps, app: AppRow, step: RolloutStepRow): Promise<boolean> {
  if (step.status !== "applying" || !step.backup_id || !step.from_version || !backupsOn(deps)) return false;
  const release = await releaseByVersion(deps.db, app.id, step.to_version);
  if (!release?.migrates) return false;
  return (await backupProgress(deps, step.backup_id)).state === "ready";
}

/**
 * Restores the step's pre-update backup and sends the instance back to
 * from_version (B8); the rollout pauses now with an alert. settleRestore
 * ends the step failed once the restore is done.
 */
async function recover(deps: AppsDeps, app: AppRow, step: RolloutStepRow, error: string): Promise<void> {
  const inst = await getInstance(deps.db, step.instance_id);
  let restoreId: string;
  try {
    restoreId = await restoreBackup(deps, inst!, step.backup_id!, {
      purpose: "failed_update",
      thenVersion: step.from_version,
      stepId: step.id,
    });
  } catch (err) {
    await failStep(deps, app, step, "failed", `${error}; its backup could not be restored: ${message(err)}`, step.from_version);
    return;
  }
  const nowIso = deps.now().toISOString();
  await deps.db.transaction().execute(async (trx) => {
    const moved = await transitionStep(
      trx,
      step.id,
      ["applying"],
      { status: "restoring", restore_id: restoreId, error, target_moved: false },
      nowIso,
    );
    if (!moved) return;
    await recordAudit(trx, stepEntry(step, "restoring", nowIso, { error, note: "restoring the backup from before the update" }));
    await pauseWithAlert(trx, app, step, error, nowIso);
  });
}

/** A restoring step: back (rollback) → reverting; forward (B8) → failed, with the outcome. */
async function settleRestore(deps: AppsDeps, app: AppRow, step: RolloutStepRow): Promise<boolean> {
  const p = await restoreProgress(deps, step.restore_id!);
  if (p.state === "running") return true;
  const r = await getRollout(deps.db, step.rollout_id);
  if (r?.direction === "back") {
    if (p.state === "failed") {
      await failStep(deps, app, step, "revert_failed", `restore failed: ${p.error}`, null);
      return false;
    }
    // Restored and set back to from_version by the restore: settle() ends it once ready there.
    const nowIso = deps.now().toISOString();
    await deps.db.transaction().execute(async (trx) => {
      const moved = await transitionStep(trx, step.id, ["restoring"], { status: "reverting", started_at: nowIso }, nowIso);
      if (moved) await recordAudit(trx, stepEntry(step, "reverting", nowIso, { note: "restored the backup from before the update" }));
    });
    return true;
  }
  await endStep(
    deps,
    step,
    "failed",
    p.state === "succeeded"
      ? { note: "restored the backup from before the update", error: step.error }
      : { error: `${step.error ?? "the update failed"}; restore failed: ${p.error}${p.held ? " (the instance stays stopped)" : ""}` },
  );
  return false;
}
```

  - `settle`:
    - At its top add `if (step.status === "backing_up") return settleBackup(deps, app, step);` and `if (step.status === "restoring") return settleRestore(deps, app, step);`.
    - After `const to: RolloutStepStatus = back ? "revert_failed" : "failed";` add:

```ts
  // B8: a forward failure of a release that migrates restores its backup instead.
  const fail = async (error: string, sendBackTo: string | null) =>
    !back && (await wantsRecovery(deps, app, step))
      ? recover(deps, app, step, error)
      : failStep(deps, app, step, to, error, sendBackTo);
```

    - Replace its three `await failStep(deps, app, step, to, X, Y);` calls (failed update, degraded after the update, timeout) with `await fail(X, Y);`.
  - `startRevert`: between `const stopped = !!inst.stop_reason || inst.status === "stopped";` and the final `const nowIso = deps.now().toISOString();` insert:

```ts
  // B14: a release that migrates goes back by restoring the backup from before the update.
  let note: string | null = null;
  const forward = await releaseByVersion(deps.db, app.id, s.to_version);
  if (forward?.migrates && backupsOn(deps)) {
    if (stopped) {
      await endStep(deps, s, "skipped", {
        note: `stopped: its database is from ${s.to_version}; restore its backup from before the update when it wakes`,
      });
      return false;
    }
    if (inst.maintenance) {
      if (!isHeld(inst.maintenance)) return true;
      await failStep(deps, app, s, "revert_failed", "the instance is stopped after a failed restore; restore it first", null);
      return false;
    }
    if (s.backup_id && (await backupProgress(deps, s.backup_id)).state === "ready") {
      const restoreId = await restoreBackup(deps, inst, s.backup_id, { purpose: "rollback", thenVersion: back, stepId: s.id });
      const at = deps.now().toISOString();
      await deps.db.transaction().execute(async (trx) => {
        const moved = await transitionStep(
          trx,
          s.id,
          ["revert_pending"],
          { status: "restoring", restore_id: restoreId, target_moved: false, started_at: at, finished_at: null, error: null },
          at,
        );
        if (moved) await recordAudit(trx, stepEntry(s, "restoring", at, { note: "restoring the backup from before the update" }));
      });
      return true;
    }
    note = "no backup from before the update (it joined on the new release, or its update never ran): image only";
  }
```

    and in its final transaction change the `reverting` patch to `{ status: "reverting", target_moved: false, started_at: nowIso, finished_at: null, error: null, ...(note ? { note } : {}) }`.
  - `finishDone`: the open lists become `["pending", "backing_up", "applying", "restoring", "failed"]` (forward) and `["revert_pending", "restoring", "reverting", "revert_failed"]` (back).
- [ ] **Step 5: `rollBackRollout`, step JSON, SDL.**
  - `rollouts/controls.ts`: the signature becomes `rollBackRollout(deps, caller, rolloutId, opts: { acceptDataLoss?: boolean } = {})`. Import `backupsOn` from `../backups/rollout.js`, and replace the `if (release?.migrates) throw …` block with:

```ts
  if (release?.migrates) {
    if (!backupsOn(deps))
      throw appsError(
        "BAD_USER_INPUT",
        `${r.version} migrates its database; rolling it back needs instance backups (VETRA_APPS_BACKUPS)`,
      );
    if (opts.acceptDataLoss !== true)
      throw appsError(
        "BAD_USER_INPUT",
        `${r.version} migrates its database: rolling back restores each instance's backup from before its update, and data written since is lost. Confirm with acceptDataLoss: true`,
      );
  }
```

    and add `acceptDataLoss: opts.acceptDataLoss === true` to the `rollout.rolling_back` audit detail.
  - `rollouts/service.ts`: add `backupId: string | null; restoreId: string | null;` to `RolloutStepJson`, filled with `s.backup_id ?? null` and `s.restore_id ?? null` where the step JSON is built.
  - `schema.ts`: in `type AppRolloutStep` add

```graphql
    "The backup taken before this step moved its instance (releases phase 3 slice 4)"
    backupId: ID
    "The restore this step runs (rollback of a release that migrates, or a failed update of one)"
    restoreId: ID
```

    and change the mutation to `rollBackRollout(rolloutId: ID!, acceptDataLoss: Boolean): AppRollout!` (its doc string: "Required true when the release migrates: each instance's backup from before its update is restored, data written since is lost").
  - `resolvers.ts`: `rollBackRollout: (_: unknown, { rolloutId, acceptDataLoss }: { rolloutId: string; acceptDataLoss?: boolean | null }, ctx: AppsContext) => guard(deps, "rollBackRollout", () => rollBackRollout(deps, person(ctx), rolloutId, { acceptDataLoss: acceptDataLoss === true }))`.
- [ ] **Step 6: Run them again.** `npx vitest run subgraphs/vetra-apps/__tests__/migrations.test.ts subgraphs/vetra-apps/__tests__/rollouts-backups.test.ts subgraphs/vetra-apps/__tests__/rollouts-runner.test.ts subgraphs/vetra-apps/__tests__/rollouts-rollback.test.ts subgraphs/vetra-apps/__tests__/rollouts-controls.test.ts subgraphs/vetra-apps/__tests__/rollouts-graphql.test.ts subgraphs/vetra-apps/__tests__/resolvers.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: PASS. Slice 3's own tests run with backups off and stay unchanged. The one exception is slice 3's `rollouts-rollback.test.ts` "refuses a release that migrates": it still passes, because its message (`/migrates/`) matches the new refusal.
- [ ] **Step 7: Commit.** `git add subgraphs/vetra-apps && git commit -m "feat(rollouts): back up before each step; roll back releases that migrate by restore" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 14: GraphQL: an instance's backups, "back up now", "restore"

**Files:**
- Create: `subgraphs/vetra-apps/backups/api.ts`
- Modify: `subgraphs/vetra-apps/instances/service.ts` (`InstanceJson.maintenance`), `subgraphs/vetra-apps/schema.ts`, `subgraphs/vetra-apps/resolvers.ts`
- Test: `subgraphs/vetra-apps/__tests__/backups-api.test.ts`

**Interfaces:**
- Produces:
  - JSON: `InstanceBackupJson { id, instanceId, reason, status, version, sizeBytes, error, requestedBy, createdAt, finishedAt, expiresAt, rolloutStepId }` and `InstanceRestoreJson { id, instanceId, backupId, purpose, status, thenVersion, error, held, requestedBy, createdAt, finishedAt }`. No ids of dumps or archives, no keys, no URLs.
  - Queries (`need: "view"`): `instanceBackupsFor(deps, caller, instanceId, limit?)` (default 50, max 200) and `instanceRestoresFor(deps, caller, instanceId)` (newest first, 20).
  - Mutations (`need: "release"`, under `instances:<appId>`, audited):
    - `backUpInstanceFor(deps, caller, instanceId)`;
    - `restoreInstanceBackupFor(deps, caller, { instanceId, backupId, acceptDataLoss })` (B10).
  - SDL: `InstanceBackup`, `InstanceRestore`, `AppInstance.maintenance`; queries `instanceBackups(instanceId: ID!, limit: Int)`, `instanceRestores(instanceId: ID!)`; mutations `backUpInstance(instanceId: ID!)`, `restoreInstanceBackup(instanceId: ID!, backupId: ID!, acceptDataLoss: Boolean!)`.
- Refusals:
  - backups off or not configured: `SERVICE_NOT_CONFIGURED`;
  - a branch or preview instance: `BAD_USER_INPUT`;
  - `acceptDataLoss` not true;
  - a backup of another instance: `NOT_FOUND`;
  - not ready, or expiring within a day;
  - taken on another version than the instance's target (unless the instance is held);
  - the instance is being restored;
  - a rollout step moves the instance.

- [ ] **Step 1: Write the failing test.** Create `__tests__/backups-api.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { owner, stranger } from "./harness.js";
import { backupHarness, finishBackupJobs, planInstance, type BackupCtx } from "./backups-fixtures.js";
import { listAudit } from "../audit/repo.js";
import {
  backUpInstanceFor,
  instanceBackupsFor,
  instanceRestoresFor,
  restoreInstanceBackupFor,
} from "../backups/api.js";
import { advanceBackups } from "../backups/service.js";
import { updateInstance } from "../instances/repo.js";

let ctx: BackupCtx;
beforeEach(async () => {
  ctx = await backupHarness();
});
afterEach(async () => {
  await ctx.h.close();
});

describe("instance backups API (spec 7: restored from the console)", () => {
  it("backs up now and restores, for operators only, with acceptDataLoss, a backup of the version it targets", async () => {
    const { h, appId, fake } = ctx;
    await planInstance(h, fake, appId, { id: "o1" });
    await expect(backUpInstanceFor(h.deps, stranger, "o1")).rejects.toThrow();
    const b = await backUpInstanceFor(h.deps, owner, "o1");
    expect(b).toMatchObject({ instanceId: "o1", reason: "manual", status: "pending", version: "1.4.0" });
    for (const k of ["dumpId", "archiveId", "s3Key", "downloadUrl"]) expect(b).not.toHaveProperty(k);
    await expect(backUpInstanceFor(h.deps, owner, "o1")).rejects.toThrow(/already running/);
    await finishBackupJobs(h, fake);
    await advanceBackups(h.deps, appId);
    expect((await listAudit(h.db, appId, { limit: 10 })).map((a) => a.action)).toContain("backup.requested");

    const restore = (accept: boolean) =>
      restoreInstanceBackupFor(h.deps, owner, { instanceId: "o1", backupId: b.id, acceptDataLoss: accept });
    await expect(restore(false)).rejects.toThrow(/acceptDataLoss/);
    await expect(
      restoreInstanceBackupFor(h.deps, stranger, { instanceId: "o1", backupId: b.id, acceptDataLoss: true }),
    ).rejects.toThrow();
    await updateInstance(h.db, "o1", { target_version: "1.5.0" }, "2026-10-02T13:00:00.000Z");
    await expect(restore(true)).rejects.toThrow(/taken on 1.4.0/);
    await updateInstance(h.db, "o1", { target_version: "1.4.0" }, "2026-10-02T13:00:01.000Z");
    const r = await restore(true);
    expect(r).toMatchObject({ instanceId: "o1", backupId: b.id, purpose: "manual", status: "safety_backup", thenVersion: null });
    await expect(restore(true)).rejects.toThrow(/being restored/);
    expect((await instanceRestoresFor(h.deps, owner, "o1")).map((x) => x.id)).toEqual([r.id]);
    expect((await instanceBackupsFor(h.deps, owner, "o1")).map((x) => x.reason)).toEqual(["manual"]);
    await expect(instanceBackupsFor(h.deps, stranger, "o1")).rejects.toThrow();
  });

  it("is not configured with backups off; branch instances have none", async () => {
    const { h, appId, fake } = ctx;
    await planInstance(h, fake, appId, { id: "o1" });
    await h.db.updateTable("instances").set({ kind: "branch" }).where("id", "=", "o1").execute();
    await expect(backUpInstanceFor(h.deps, owner, "o1")).rejects.toThrow(/shared and own/);
    await h.db.updateTable("instances").set({ kind: "own" }).where("id", "=", "o1").execute();
    h.deps.cfg = { ...h.deps.cfg, backups: { enabled: false, dailyKeepDays: 14, maxInFlight: 3 } };
    await expect(backUpInstanceFor(h.deps, owner, "o1")).rejects.toMatchObject({
      extensions: { code: "SERVICE_NOT_CONFIGURED" },
    });
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/backups-api.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL.
- [ ] **Step 3: Implement.** Create `backups/api.ts`:

```ts
import { withKeyLock } from "../../../shared/key-lock.js";
import { auditCaller } from "../audit/service.js";
import type { Caller } from "../auth.js";
import { backupsConfigOf } from "../config.js";
import { appsError, notConfigured } from "../errors.js";
import { getInstance, type InstanceRow } from "../instances/repo.js";
import { MOVING } from "../rollouts/repo.js";
import { loadAppForOwner, type AppsDeps } from "../service.js";
import {
  getBackup,
  listBackupsOfInstance,
  listRestoresOfInstance,
  type InstanceBackupRow,
  type InstanceRestoreRow,
} from "./repo.js";
import { beginRestore, isHeld, RestoreBusyError } from "./restore.js";
import { BackupBusyError, BackupUnavailableError, startInstanceBackup } from "./service.js";

const DAY_MS = 86_400_000;

export interface InstanceBackupJson {
  id: string;
  instanceId: string;
  reason: string;
  status: string;
  version: string | null;
  sizeBytes: number | null;
  error: string | null;
  requestedBy: string;
  createdAt: string;
  finishedAt: string | null;
  expiresAt: string;
  rolloutStepId: string | null;
}

export interface InstanceRestoreJson {
  id: string;
  instanceId: string;
  backupId: string;
  purpose: string;
  status: string;
  thenVersion: string | null;
  error: string | null;
  held: boolean;
  requestedBy: string;
  createdAt: string;
  finishedAt: string | null;
}

/** Metadata only (spec 14.5): no dump or archive ids, keys or URLs. */
export const backupJson = (b: InstanceBackupRow): InstanceBackupJson => ({
  id: b.id,
  instanceId: b.instance_id,
  reason: b.reason,
  status: b.status,
  version: b.version,
  sizeBytes: b.size_bytes,
  error: b.error,
  requestedBy: b.requested_by,
  createdAt: b.created_at,
  finishedAt: b.finished_at,
  expiresAt: b.expires_at,
  rolloutStepId: b.rollout_step_id,
});

export const restoreJson = (r: InstanceRestoreRow): InstanceRestoreJson => ({
  id: r.id,
  instanceId: r.instance_id,
  backupId: r.backup_id,
  purpose: r.purpose,
  status: r.status,
  thenVersion: r.then_version,
  error: r.error,
  held: r.held,
  requestedBy: r.requested_by,
  createdAt: r.created_at,
  finishedAt: r.finished_at,
});

async function loadPlanInstance(deps: AppsDeps, caller: Caller, instanceId: string, need: "view" | "release") {
  const inst = await getInstance(deps.db, instanceId);
  if (!inst || inst.removed_at || inst.status === "removed") throw appsError("NOT_FOUND", "No such instance");
  const app = await loadAppForOwner(deps, caller, inst.app_id, { need });
  if (inst.kind !== "shared" && inst.kind !== "own")
    throw appsError("BAD_USER_INPUT", "Only shared and own instances have backups");
  return { inst, app };
}

function requireBackups(deps: AppsDeps): void {
  if (!backupsConfigOf(deps.cfg).enabled || !deps.backups) throw notConfigured("Instance backups");
}

async function stepMoves(deps: AppsDeps, inst: InstanceRow): Promise<boolean> {
  const row = await deps.db
    .selectFrom("rollout_steps")
    .select("id")
    .where("instance_id", "=", inst.id)
    .where("status", "in", [...MOVING])
    .executeTakeFirst();
  return !!row;
}

export async function instanceBackupsFor(
  deps: AppsDeps,
  caller: Caller,
  instanceId: string,
  limit = 50,
): Promise<InstanceBackupJson[]> {
  const { inst } = await loadPlanInstance(deps, caller, instanceId, "view");
  return (await listBackupsOfInstance(deps.db, inst.id, Math.min(Math.max(limit, 1), 200))).map(backupJson);
}

export async function instanceRestoresFor(
  deps: AppsDeps,
  caller: Caller,
  instanceId: string,
): Promise<InstanceRestoreJson[]> {
  const { inst } = await loadPlanInstance(deps, caller, instanceId, "view");
  return (await listRestoresOfInstance(deps.db, inst.id, 20)).map(restoreJson);
}

/** "Back up now" (reason manual, kept 30 days). */
export async function backUpInstanceFor(deps: AppsDeps, caller: Caller, instanceId: string): Promise<InstanceBackupJson> {
  const { inst, app } = await loadPlanInstance(deps, caller, instanceId, "release");
  requireBackups(deps);
  return withKeyLock(`instances:${app.id}`, async () => {
    const cur = (await getInstance(deps.db, inst.id))!;
    if (cur.maintenance) throw appsError("BAD_USER_INPUT", `${cur.name} is being restored`);
    try {
      const b = await startInstanceBackup(deps, cur, { reason: "manual", requestedBy: caller.address });
      await auditCaller(deps.db, caller, {
        appId: app.id,
        at: b.created_at,
        action: "backup.requested",
        subject: `instance:${cur.id}`,
        detail: { backupId: b.id, reason: "manual" },
      });
      return backupJson(b);
    } catch (err) {
      if (err instanceof BackupBusyError)
        throw appsError("BAD_USER_INPUT", `A backup of ${cur.name} is already running; try again when it is done`);
      if (err instanceof BackupUnavailableError)
        throw appsError("BAD_USER_INPUT", `${cur.name} cannot be backed up: ${err.message}`);
      throw err;
    }
  });
}

/** Restores one of the instance's backups into it (decision B10). */
export async function restoreInstanceBackupFor(
  deps: AppsDeps,
  caller: Caller,
  input: { instanceId: string; backupId: string; acceptDataLoss: boolean },
): Promise<InstanceRestoreJson> {
  const { inst, app } = await loadPlanInstance(deps, caller, input.instanceId, "release");
  requireBackups(deps);
  if (input.acceptDataLoss !== true)
    throw appsError(
      "BAD_USER_INPUT",
      "Restoring replaces the instance's database and /data with the backup: everything written since it was taken is lost. Confirm with acceptDataLoss: true",
    );
  return withKeyLock(`instances:${app.id}`, async () => {
    const cur = (await getInstance(deps.db, inst.id))!;
    const backup = await getBackup(deps.db, input.backupId);
    if (!backup || backup.instance_id !== cur.id) throw appsError("NOT_FOUND", "No such backup of this instance");
    if (backup.status !== "ready") throw appsError("BAD_USER_INPUT", `The backup is ${backup.status}`);
    if (!(Date.parse(backup.expires_at) - deps.now().getTime() > DAY_MS))
      throw appsError("BAD_USER_INPUT", "The backup expires within a day; back up now and restore that one");
    if (cur.maintenance && !isHeld(cur.maintenance)) throw appsError("BAD_USER_INPUT", `${cur.name} is being restored`);
    const held = isHeld(cur.maintenance);
    if (!held && backup.version !== cur.target_version)
      throw appsError(
        "BAD_USER_INPUT",
        `The backup was taken on ${backup.version ?? "an unknown release"} and ${cur.name} runs ${cur.target_version}: roll back to ${backup.version} first`,
      );
    if (await stepMoves(deps, cur))
      throw appsError("BAD_USER_INPUT", `A rollout is updating ${cur.name}; wait for its step`);
    try {
      const r = await beginRestore(deps, cur, backup, {
        purpose: "manual",
        // A held instance takes the backup's release (its data is from it).
        thenVersion: held ? backup.version : null,
        who: { actor: caller.address, source: caller.source ?? "api" },
      });
      return restoreJson(r);
    } catch (err) {
      if (err instanceof RestoreBusyError) throw appsError("BAD_USER_INPUT", err.message);
      throw err;
    }
  });
}
```

  `instances/service.ts`: add `maintenance: string | null;` to `InstanceJson` and `maintenance: r.maintenance ?? null,` to `instanceJson`.

  `schema.ts` (SDL): in `type AppInstance` add

```graphql
    "restore:<id> while a backup is restored into it; held:<id> after a failed restore (stays stopped until a restore succeeds)"
    maintenance: String
```

  and add:

```graphql
  "A backup of a shared or own instance: its database and /data, taken together (releases phase 3 slice 4)"
  type InstanceBackup {
    id: ID!
    instanceId: ID!
    "pre_update | daily | manual | pre_restore | pre_stop"
    reason: String!
    "pending | ready | failed"
    status: String!
    "The release the instance ran when it was taken"
    version: String
    sizeBytes: Float
    error: String
    requestedBy: String!
    createdAt: String!
    finishedAt: String
    expiresAt: String!
    rolloutStepId: ID
  }

  type InstanceRestore {
    id: ID!
    instanceId: ID!
    backupId: ID!
    "rollback | failed_update | manual"
    purpose: String!
    "safety_backup | stopping | restoring_db | restoring_data | starting | succeeded | failed"
    status: String!
    "The release the instance runs afterwards (null: unchanged)"
    thenVersion: String
    error: String
    "Failed with /data possibly half restored: the instance stays stopped"
    held: Boolean!
    requestedBy: String!
    createdAt: String!
    finishedAt: String
  }
```

  In `type Query`: `instanceBackups(instanceId: ID!, limit: Int): [InstanceBackup!]!` and `instanceRestores(instanceId: ID!): [InstanceRestore!]!`. In `type Mutation`: `"Back up a shared or own instance now (database and /data)" backUpInstance(instanceId: ID!): InstanceBackup!` and `"Restore one of the instance's backups into it; acceptDataLoss must be true (data written since is lost)" restoreInstanceBackup(instanceId: ID!, backupId: ID!, acceptDataLoss: Boolean!): InstanceRestore!`.

  `resolvers.ts`: import the four functions from `./backups/api.js`, and:

```ts
      instanceBackups: (_: unknown, { instanceId, limit }: { instanceId: string; limit?: number | null }, ctx: AppsContext) =>
        guard(deps, "instanceBackups", () => instanceBackupsFor(deps, requireCaller(ctx), instanceId, limit ?? 50)),
      instanceRestores: (_: unknown, { instanceId }: { instanceId: string }, ctx: AppsContext) =>
        guard(deps, "instanceRestores", () => instanceRestoresFor(deps, requireCaller(ctx), instanceId)),
```

  (Query) and

```ts
      backUpInstance: (_: unknown, { instanceId }: { instanceId: string }, ctx: AppsContext) =>
        guard(deps, "backUpInstance", () => backUpInstanceFor(deps, person(ctx), instanceId)),
      restoreInstanceBackup: (
        _: unknown,
        args: { instanceId: string; backupId: string; acceptDataLoss: boolean },
        ctx: AppsContext,
      ) => guard(deps, "restoreInstanceBackup", () => restoreInstanceBackupFor(deps, person(ctx), args)),
```

  (Mutation).
- [ ] **Step 4: Run it again.** `npx vitest run subgraphs/vetra-apps/__tests__/backups-api.test.ts subgraphs/vetra-apps/__tests__/resolvers.test.ts subgraphs/vetra-apps/__tests__/instances-api.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: PASS (`instances-api.test.ts` may compare whole `AppInstance` objects; add `maintenance: null` where it does).
- [ ] **Step 5: Commit.** `git add subgraphs/vetra-apps && git commit -m "feat(apps): instance backups in the API: list, back up now, restore" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 15: A stopped plan instance keeps its database (processor side of B9)

**Files:**
- Modify: `processors/vetra-cloud-environment/gitops.ts`
- Test: `processors/vetra-cloud-environment/fusion.test.ts`

**Interfaces:**
- Changes: the values of an environment with `app.role = PLAN` get `database.cnpg.keepWhenDisabled: true` (the line is left out for every other role, so golden files and every other tenant's values are unchanged). With the chart flag from Task 16, a STOPPED plan instance keeps its CNPG Cluster, hibernated, instead of losing it.

- [ ] **Step 1: Write the failing test.** In `fusion.test.ts`, inside the `describe` that holds "gives a plan instance the full profile…", append:

```ts
  it("keeps a stopped plan instance's database (hibernated), and changes nothing for other environments", async () => {
    const plan = (status: VetraCloudEnvironmentState["status"]) =>
      hostState([], {
        status,
        app: { appId: "app-1", role: "PLAN", prNumber: null, gitRef: null, imageProject: null },
      });
    const stopped = await render(plan("STOPPED"));
    expect(stopped).toContain("  disabled: true");
    expect(stopped).toMatch(/\n    name: [^\n]+-pg\n    keepWhenDisabled: true\n/);
    expect(await render(plan("READY"))).toContain("    keepWhenDisabled: true");
    expect(await render(hostState([], { status: "STOPPED" }))).not.toContain("keepWhenDisabled");
  });
```

- [ ] **Step 2: Run it.** `npx vitest run processors/vetra-cloud-environment/fusion.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL.
- [ ] **Step 3: Implement.** In `gitops.ts` `generateValuesYaml` (the function with `const preview = isPreviewEnv(state);`), after that line add:

```ts
  // Plan instances hold customer data: stopping one (licence ended, plan
  // retired) keeps its CNPG Cluster hibernated instead of deleting it (chart
  // database.cnpg.keepWhenDisabled; releases phase 3 decision B9). Only for
  // PLAN: the other stopped environments render exactly as before.
  const keepDbLine = state.app?.role === "PLAN" ? "\n    keepWhenDisabled: true" : "";
```

  and in the values template change the `database.cnpg` name line, `    name: ${tenantId}-pg` (directly under `    enabled: ${databaseEnabled}`), to `    name: ${tenantId}-pg${keepDbLine}`.
- [ ] **Step 4: Run it again.** `npx vitest run processors 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: PASS, goldens unchanged.
- [ ] **Step 5: Commit.** `git add processors/vetra-cloud-environment && git commit -m "feat(processor): a stopped plan instance keeps its database (keepWhenDisabled)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 16: Hosting and image changes (`powerhouse-k8s-hosting`; needs the user)

These land **before** the package is pinned with `VETRA_APPS_BACKUPS: "on"`. The package is safe without them: backups are off by default, and the processor line is ignored by an older chart.

**Repository:** `/home/froid/projects/powerhouse-k8s-hosting`, branch `feat/instance-backups` from `main`. Two PRs: one for the security boundary, one for the chart and the values, so each gets its own review.

- [ ] **Step 1: Image `pgdump-uploader:1.1.0`.**
  - In `infrastructure/pgdump-uploader/Dockerfile`:
    - `RUN apk add --no-cache ca-certificates curl tar \` becomes `RUN apk add --no-cache ca-certificates curl tar zstd \`;
    - `&& apk del curl tar \` becomes `&& apk del curl \` (GNU tar stays: the archive script needs `--exclude` and `--no-same-owner`).
  - In the README: document 1.1.0 ("1.0.0 plus GNU tar and zstd for the /data archive and restore Jobs, `VETRA_DATA_ARCHIVE_IMAGE`").
  - Build and push `cr.vetra.io/powerhouse-inc-powerhouse/pgdump-uploader:1.1.0` (needs Harbor push rights).
  - Smoke test: `docker run --rm --entrypoint sh <image> -c 'tar --version | head -1; zstd --version; s5cmd version; command -v sha256sum mkfifo find'`.
- [ ] **Step 2: Admission policy** (`infrastructure/vetra-observability-rbac/admission-policy.yaml`, B5).
  - In the Job rule, replace `(!has(variables.podSpec.volumes) || size(variables.podSpec.volumes) == 0) &&` with:

```yaml
        (!has(variables.podSpec.volumes) || (
          size(variables.podSpec.volumes) <= 1 &&
          variables.podSpec.volumes.all(v,
            has(v.persistentVolumeClaim) &&
            v.persistentVolumeClaim.claimName.endsWith('-app-data')))) &&
```

  - Replace `(!has(c.volumeMounts) || size(c.volumeMounts) == 0) &&` with:

```yaml
          (!has(c.volumeMounts) || c.volumeMounts.all(m,
            m.mountPath == '/data' && !has(m.subPath) && !has(m.subPathExpr))) &&
```

  - Update the comment above it ("The switchboard only creates pg-dump Jobs … and /data archive/restore Jobs that mount the tenant's `<release>-app-data` PVC at /data (vetra-cloud-package dumps/archive-job-spec.ts)").
  - Update the message ("default SA, cr.vetra.io images, no volumes except the app data PVC at /data, …").
- [ ] **Step 3: RBAC** (`rbac.yaml`), after the jobs rule:

```yaml
  # Instance backups (vetra-cloud-package releases phase 3 slice 4): find a
  # tenant's app data PVC (<release>-app-data, component=app) to archive and
  # restore /data. Read only; the Job that mounts it is confined by the
  # admission policy.
  - apiGroups:
      - ""
    resources:
      - persistentvolumeclaims
    verbs:
      - get
      - list
```

- [ ] **Step 4: Verify the policy on staging** before merging the chart PR: apply the policy PR, then as the staging switchboard SA:
  - `kubectl auth can-i list persistentvolumeclaims --as=system:serviceaccount:staging:default -n <a staging tenant>` → yes.
  - A dry-run Job built from `buildArchiveJob` (print it with a one-off `npx tsx -e` script that writes its JSON, then `kubectl create --dry-run=server -f job.json --as=system:serviceaccount:staging:default`) → admitted.
  - The same Job with `claimName: other` or a `hostPath` volume → denied.
- [ ] **Step 5: Chart flag** (`powerhouse-chart`, B9).
  - `values.yaml`, under `database.cnpg`:

```yaml
    # Keep the Cluster, hibernated, while global.disabled, instead of deleting it
    # and its volumes. vetra-cloud-package sets it for plan instances (role PLAN):
    # a holder's data must survive a stop. Other tenants keep the old behaviour.
    keepWhenDisabled: false
```

  - `templates/postgres-cluster.yaml`: the gate becomes `{{- if and .Values.database.cnpg.enabled (or (not .Values.global.disabled) .Values.database.cnpg.keepWhenDisabled) (or .Values.switchboard.enabled (and .Values.app.enabled .Values.app.database.enabled) (and .Values.registry.enabled .Values.registry.database.enabled)) }}`. Under `metadata.annotations` add:

```yaml
    {{- if .Values.database.cnpg.keepWhenDisabled }}
    # Declarative hibernation: pods go, PVCs stay; off again on wake.
    cnpg.io/hibernation: {{ ternary "on" "off" .Values.global.disabled | quote }}
    {{- end }}
```

  - Extend the CAVEAT comment at the top: "Except with database.cnpg.keepWhenDisabled (plan instances): the Cluster stays, hibernated."
  - `helm template` checks:
    - `--set database.cnpg.enabled=true,app.enabled=true,app.database.enabled=true,global.disabled=true,database.cnpg.keepWhenDisabled=true` renders the Cluster with `cnpg.io/hibernation: "on"`;
    - without the flag, no Cluster;
    - with `global.disabled=false` and the flag, the annotation is `"off"`.
- [ ] **Step 6: Staging values** (`tenants/staging/powerhouse-values.yaml`, both switchboard env blocks, next to `VETRA_APPS_PLANS`):

```yaml
    VETRA_APPS_BACKUPS: "on"
    VETRA_DATA_ARCHIVE_IMAGE: "cr.vetra.io/powerhouse-inc-powerhouse/pgdump-uploader:1.1.0"
```

  plus the `PH_REGISTRY_PACKAGES` pin of the version that contains this slice. Production values are not changed in this slice.
- [ ] **Step 7: Bucket lifecycle.** Confirm the dumps bucket (`powerhouse-env-dumps`) deletes objects after 30 days (the `TTL_HOURS` comment says it is mirrored there): `s5cmd --endpoint-url https://fsn1.your-objectstorage.com ls s3://powerhouse-env-dumps/` with the dumps credentials, and the lifecycle in the Hetzner console. If it has no rule, B6 needs one (30 days, whole bucket) before production.

---

### Task 17: The canary learns to migrate (`vetra-publish-canary`; staging test data)

**Repository:** `/home/froid/projects/vetra-publish-canary` (`powerhouse-inc/vetra-publish-canary`), branch `feat/migrations`. Its releases are what Task 19 rolls out and back.

- [ ] **Step 1: Migrations and `vetra.migrations`.**
  - `powerhouse.config.json` becomes `{ "vetra": { "migrations": ["migrations/**"] } }`. vetra-publish then reports `migrates: true` for a release whose diff touches `migrations/`.
  - Add `pg` (`pnpm add pg`).
  - `migrations/001_notes.sql`: `create table if not exists canary_notes (id serial primary key, text text not null, at timestamptz not null default now());`
- [ ] **Step 2: Endpoints** in `index.js`, before the final HTML handler:

```js
const { Client } = require("pg");
const fs = require("node:fs");
const path = require("node:path");
const DATA = "/data/canary";

async function db(fn) {
  const c = new Client({ connectionString: process.env.PH_SWITCHBOARD_DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Applies migrations/*.sql once each, in name order (what a real app's reactor does). */
async function migrate() {
  if (!process.env.PH_SWITCHBOARD_DATABASE_URL) return;
  await db(async (c) => {
    await c.query("create table if not exists canary_migrations (name text primary key)");
    for (const f of fs.readdirSync(path.join(__dirname, "migrations")).sort()) {
      if ((await c.query("select 1 from canary_migrations where name = $1", [f])).rowCount) continue;
      await c.query(fs.readFileSync(path.join(__dirname, "migrations", f), "utf8"));
      await c.query("insert into canary_migrations (name) values ($1)", [f]);
    }
  });
}

/** sha256 over every file under /data (path and content hash), lost+found left out. */
function treeSha() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (dir === "/data" && e.name === "lost+found") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(`${path.relative("/data", p)}\0${crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex")}`);
    }
  };
  if (fs.existsSync("/data")) walk("/data");
  return { files: out.length, sha256: crypto.createHash("sha256").update(out.sort().join("\n")).digest("hex") };
}
```

  - Handlers:
    - `GET /db` → `{ migrations: [...names], tables: [...public tables], notes: count }`;
    - `POST /notes?text=…` → inserts a note and writes `${DATA}/<id>.txt` with the text (mkdir -p), answers `{ id }`;
    - `GET /data` → `treeSha()`.
  - Call `await migrate()` before `listen`, and exit 1 when it throws.
  - Add a crash switch for B8: when `process.env.CANARY_CRASH_AFTER_MIGRATE` equals the package version, exit 1 **after** `migrate()`.
- [ ] **Step 3: Releases.**
  1. Merge the above as `feat: migrations, /db, /notes and /data`. Its release (1.2.0) migrates (it adds `migrations/001`).
  2. Release `feat: canary_tags` with `migrations/002_tags.sql` (`create table canary_tags (id serial primary key, name text not null);`) → 1.3.0, migrates.
  3. Release `feat: canary_flags` with `migrations/003_flags.sql` → 1.4.0, migrates (the B8 test).

  Keep each release PR waiting until Task 19 asks for it, so the staging plans move in order.

---

### Task 18: Full checks, PR

- [ ] **Step 1:** `npm run tsc 2>&1 | tail -20`, `npm run lint 2>&1 | tail -20`, `npx vitest run subgraphs/vetra-apps subgraphs/vetra-cloud-observability processors shared 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: no new failures against Task 0's baseline.
- [ ] **Step 2:** Push `feat/releases-phase-3-backups` and open the PR (`gh pr create`). The description holds:
  - the summary;
  - decisions B1-B16 as confirmed by the user;
  - the B9 finding, in bold: without the chart flag a stopped plan instance loses its database. The slice 1 stop/wake test on staging cannot show it, because the canary does not use its database;
  - the hosting PR links (Task 16) and the order;
  - the slice 3 name mapping (Task 0) if any;
  - the staging plan (Task 19);
  - and ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- [ ] **Step 3:** After merge, the package version is the one Task 16 Step 6 pins on staging. Production is not pinned with `VETRA_APPS_BACKUPS` on in this slice. Check the Sektar gated rollout state first anyway (overview rule 4) before any production pin of the package.

---

### Task 19: Staging verification (needs the user)

The staging canary App is `96e56853-…` (`powerhouse-inc/vetra-publish-canary`). It has plans Starter (shared) and Pro (own; holder test address `0x1111…1111`, own instance `wild-bear-c69c1c62-stg`), and `VETRA_APPS_PLANS: on`, health `enforce`. Record every observation in a PR comment. Use GraphQL against the staging switchboard as the canary's owner. Use `kubectl` on the staging cluster.

- [ ] **Step 1: Preconditions.**
  - Task 16 is merged (policy, RBAC, chart, values) and the image is pushed.
  - The package is pinned on staging with `VETRA_APPS_BACKUPS: on`.
  - Canary 1.2.0 (migrations) is rolled out to Starter and Pro by slice 3 (its first `migrates` rollout: steps show `backing_up` first).
  - `GET https://<instance>/db` shows `001_notes.sql`.
- [ ] **Step 2: Daily backups.**
  - Within 5 minutes, `instanceBackups` of both instances shows a `daily` backup `ready` with a size.
  - `kubectl -n <tenant> get jobs` shows `pgdump-*` and `dataarchive-*` (gone 10 minutes after they finish).
  - The archive pod ran on the app pod's node (`kubectl get pod -o wide` while it runs).
- [ ] **Step 3: Size and time.**
  - Write a large `/data`: `kubectl -n <own tenant> exec deploy/powerhouse-<own tenant>-app -- sh -c 'mkdir -p /data/canary && dd if=/dev/urandom of=/data/canary/big bs=1M count=2048'`.
  - Then `backUpInstance`. Record the archive duration (Job start to completion) and size.
  - It must finish well inside 60 minutes. If it takes more than 30, raise `activeDeadlineSeconds` and the timeouts in a follow-up before production.
  - Delete `big` afterwards.
- [ ] **Step 4: Data before the update.**
  - `POST /notes?text=before` on both instances.
  - Record `GET /data` (`files`, `sha256`) and `GET /db`.
- [ ] **Step 5: Roll out 1.3.0** (Task 17 release 2, migrates) to Starter and Pro with no notice.
  - Each step goes `backing_up` → `applying` → `succeeded`, shared first.
  - `instanceBackups` shows a `pre_update` backup per instance, with `rolloutStepId`.
  - `GET /db` shows `canary_tags`.
- [ ] **Step 6: Data after the update.** `POST /notes?text=after` on both instances, and write one more file (the note's file is written already). `GET /data` now differs.
- [ ] **Step 7: Roll back.**
  - `rollBackRollout(rolloutId)` without `acceptDataLoss` is refused with the data-loss message.
  - With `acceptDataLoss: true`:
    - the own instance goes first (reverse order), `revert_pending` → `restoring` → `reverting` → `rolled_back`, then the shared one;
    - `kubectl -n <tenant> get jobs` shows `pgdump-*`/`dataarchive-*` (the safety backup), then `pgrestore-<id>`, then `datarestore-<id>`;
    - the app is scaled to 0 during the restore and comes back on `1.2.0`.
  - Afterwards on both instances:
    - `GET /version` = `1.2.0`;
    - `GET /db` has no `canary_tags`, no `002_tags.sql`, and the note "before" without "after";
    - `GET /data` equals Step 4's `sha256`.
  - `instanceRestores` shows `rollback` restores `succeeded`, and the audit log shows `restore.started`/`restore.finished` per instance.
- [ ] **Step 8: A failed update of a release that migrates (B8).**
  - Set the publisher setting `CANARY_CRASH_AFTER_MIGRATE=1.4.0`. It rolls every instance, which stay on 1.2.0 and ignore it.
  - Roll out 1.4.0 (release 3) to Starter.
  - The step fails health. The rollout pauses with an alert, and the step shows `restoring`, then `failed` with the note "restored the backup from before the update".
  - `GET /db` on the shared instance has no table from 002 or 003, and `/version` is `1.2.0`.
  - Cancel the rollout. Delete the setting.
- [ ] **Step 9: Manual restore and the held path (optional, staging only).**
  - `restoreInstanceBackup` of today's daily backup of the own instance with `acceptDataLoss: true` succeeds, and a note written after that backup is gone.
  - Then delete the archive object of another backup (`s5cmd rm s3://powerhouse-env-dumps/<tenant>/data/<id>.tar.zst`) and restore that backup. The data restore fails on the checksum before `/data` is touched. The instance is held (`maintenance: held:…`, status failed, app at 0).
  - Restoring a good backup brings it back.
- [ ] **Step 10: Stop and wake (B9).**
  - Let the Pro grant end (the stop window is 1 day on staging).
  - The own instance's reason reads "…: stopping after a final backup", a `pre_stop` backup is `ready`, then it is `stopped`.
  - `kubectl -n <tenant> get cluster -o jsonpath='{.metadata.annotations.cnpg\.io/hibernation}'` → `on`, and its PVC is still there.
  - Renew the grant. The instance wakes, the annotation is `off`, and `GET /db` still has the notes.
- [ ] **Step 11: The switch.**
  - Set `VETRA_APPS_BACKUPS: off` on staging and roll out a no-op release: steps go straight to `applying`, and a `migrates` rollback is refused.
  - Turn it back on.

---

### Task 20: Console follow-up (vetra.to; separate PR after staging works; no code here)

The vetra.to work for this slice goes in `modules/apps` (publisher) after `npm run codegen` against the staging switchboard.
- **Instance detail (publisher):** a "Backups" section.
  - The list from `instanceBackups`: reason as words (Before update 1.3.0, Daily, Manual, Before restore, Before stop), time in the viewer's zone, release, size, status, error, expiry.
  - "Back up now" (`backUpInstance`).
  - "Restore" on each ready backup of the release the instance runs. The confirmation dialog:
    - names the backup's time;
    - says that everything written since is lost and that a safety backup is taken first;
    - asks for the instance name to be typed;
    - then sends `acceptDataLoss: true`.
  - While `maintenance` starts with `restore:`, a progress line polls `instanceRestores` every 10 s and shows the phase (Safety backup, Stopping, Restoring database, Restoring files, Starting).
  - When it starts with `held:`, an alert reads "Stopped after a failed restore: <error>. Restore a backup to bring it back." and every action except Restore is disabled.
- **Rollout view (slice 3's):**
  - Step statuses `backing_up` ("Backing up") and `restoring` ("Restoring backup").
  - Each step links to its backup.
  - Roll back, for a release that `migrates`:
    - the dialog lists each instance with the time of the backup it restores (and "image only" for those without one) and the sentence "Data written since each backup is lost";
    - a required checkbox;
    - the call sends `acceptDataLoss: true`;
    - for any other release, the dialog is unchanged.
- **Holder views:** nothing in this slice. Holder download is slice 7 (`downloadInstanceBackup`), which also adds "last backup" to `myInstances`.
- **Names:** requesters are shown as their Renown name and picture ("Vetra" for `vetra`), never a 0x address.

---

## Self-review

- **Spec coverage:**
  - Section 7, step 4 ("before each: a backup (database + `/data`)"): Tasks 8, 12 and 13 (`backing_up`).
  - Section 7, "Rollback" for `migrates` (restore, data loss stated before the click): Tasks 9 and 13 (`acceptDataLoss`), and Task 20 (the console text). The other rollbacks stay image swaps (slice 3).
  - Section 7, "daily for shared and own instances (kept 14 days) and can be restored from the console": Tasks 11 and 14, and Task 20 for the console.
  - 14.5: holders' data is never exposed. The API returns metadata only, restores go only into the instance a backup came from, and holder download is slice 7 (it reuses `startInstanceBackup` and `S3Helper.presignDownload`; it needs a 1-hour presign, while today's is 15 minutes).
  - 14.16 (CNPG on-demand backups and volume snapshots): replaced by D6 for now. CNPG's own scheduled backups stay. PITR and VolumeSnapshots remain a later option, and `backups/rollout.ts` is the seam they would plug into.
  - Overview slice 4:
    - "`source = PRE_UPDATE` and a system requester, never the owner-authorised GraphQL path": Tasks 1 and 8;
    - "`data_archives`, `<tenant>/data/<id>.tar.zst`": Tasks 2 and 3;
    - "step waits for both, `backup_dump_id`, `backup_archive_id`": here one `backup_id` points at both, through `instance_backups`;
    - "stop, restore the dump (safety dump first), restore `/data`, set the old digest, start": Task 9;
    - "never starts on half a restore": B12, Task 9;
    - "separate step timeout": B13.
- **Found while planning, outside the overview:**
  - B9: sleeping a plan instance deletes its database. Fixed in Tasks 10, 15 and 16, and flagged for the slice 1 staging test.
  - B5: the admission policy forbids volumes on switchboard Jobs, so no `/data` Job could run without Task 16.
  - B1: observability's restore scales `component=switchboard`, which host-image instances do not have.
- **Placeholder scan:** every task has its files, interfaces, test code and implementation. Task 13 edits slice 3's code by the names slice 3's plan gives, and Task 0 checks they exist. Tasks 16, 17 and 19 are outside this repository and need the user; their diffs and commands are given.
- **Type consistency:**
  - `InstanceBackupRow`/`InstanceRestoreRow` (Task 6) are used by Tasks 8-14.
  - `BackupK8s` (Task 7) extends observability's `RestoreK8s`.
  - `DumpSource` gains two values (Task 1), and `RETENTION` is narrowed to observability's own three sources so no `Record` needs an entry for them.
  - The step statuses `backing_up`/`restoring` are lowercase like slice 3's (R16).
- **Order risks:**
  - Task 16's policy must be live before `VETRA_APPS_BACKUPS: on`. Otherwise every archive Job is denied: steps fail "cannot back up" and pause (fail closed), and daily backups log warnings.
  - The chart flag (Task 16 Step 5) should go to staging at once, ahead of this slice if possible, because of B9.
- **Later slices:**
  - Slice 7: `downloadInstanceBackup` (a fresh backup and a signed URL), the final backup before deletion kept 180 days (needs a prefix or bucket outside the 30-day lifecycle), and holder settings re-applied after a restore (the restore keeps the instance's settings revision, so they survive it).
  - Slice 9: the switch-over uses `startInstanceBackup` on the licensed environment's tenant. That tenant is not an instance, so slice 9 calls `createDumpAndJob` and `createArchiveAndJob` directly, with the same Jobs. It restores into the new own instance through a variant of `beginRestore` that allows a backup of another environment, audited, admin-only.
