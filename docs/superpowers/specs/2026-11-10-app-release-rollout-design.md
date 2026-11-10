# App release rollout: canary, promotion, notice and recoverable updates

- **Status:** Flow approved in brainstorm (2026-11-10); backend, runtime and console sections drafted from it
- **Date:** 2026-11-10
- **Author:** Frank Pfeift (with Claude)
- **Repos:** `vetra-cloud-package` (backend), `vetra.to` (console), `powerhouse-k8s-hosting` (chart, only if phase 2 needs it)
- **Related:** `2026-10-07-app-artifacts-and-template-builder-design.md` (this revises its decision 2), `2026-10-08-app-document-licensing-redesign-design.md` ("staged template rollout" follow-up), `2026-11-02-app-warm-pool-design.md`

## 1. Intent

A publisher who ships a new version of a licensed app (Sektar first) should be able to try it on their own environment, then roll it out to customers with notice, and have a failed update put the customer back where they were. A holder should see their environment as "my Sektar, version X", not as a Fusion service with infra controls.

### Current state (verified 2026-11-10)

- CI records the `host` image and moves the LATEST channel. The licensing keeper sees the template hash change and re-templates every holder environment, at most 5 per tick. Decision 2 of the artifacts design accepted "a bad release reaches all holders at once".
- It works: two of three checked Sektar holder environments ran the latest release. One (`fair-bull`) is stuck four builds behind although its version is in the app's record. Cause unknown; needs the keeper logs.
- A release the floor update cannot apply (`isFusionStranded`, or any hold) still gets its `template_hash` written, so it is never retried (`environments.ts`, end of `provisionChain`).
- Only the template hash is stored per environment. Nothing records what an environment runs, what an update did, or whether it failed.
- A holder has document ADMIN and can toggle services, change the Fusion image and version, and so drift off the template. Licensed environments carry no app link in their state, so the console lists them as "not linked to an app".
- The publisher's Production environment runs the package on platform Connect and Switchboard. Holders run the `host` image. So the first holder to update is the first real test of that image.
- Upgrades are forward-only. The reactor migrates its database at start (kysely, one transaction on Postgres, so a failed migration changes nothing). After a successful migration the previous image refuses to boot. Document upgrades cannot be downgraded.
- The chart already uses `Recreate` for apps with a data volume (`powerhouse-chart/templates/app-deployment.yaml`), so two containers never overlap on a holder environment.
- Probes hit Connect's `/`. There is no startup probe. Scheduled dumps and restore only work for environments with the SWITCHBOARD service, so not for host environments. Nothing snapshots `/data`.
- `fusion-auto-update.ts:16` spells a status `DEPLOYMENt_FAILED`.

## 2. Decisions

| # | Decision | Alternative rejected |
|---|---|---|
| 1 | Desktop and cloud Sektar do not sync. This design covers cloud only. | |
| 2 | The canary is a publisher-owned holder environment, built from the same template as customers', flagged to take releases first. | Making Production run the host image; using a warm environment (empty, proves little). |
| 3 | A release stops at the canary. The publisher promotes it to customers. | Automatic promotion after a soak time. |
| 4 | Promotion carries a notice period (default 3 days, or none for an urgent fix). Holders see "update available", can update now, and are updated automatically at the deadline. | Updating everyone at promotion; nightly windows. |
| 5 | The holder chooses when, within the deadline. Never which version. No pinning, no undo window in this version. | Holder-controlled versions. |
| 6 | Updates apply one environment at a time per app. A failure pauses the rollout for everyone until the publisher resumes or ships a new release. | Percentage waves (meaningless at 15 environments). |
| 7 | A failed update puts the previous image back. If the previous image cannot start (the database was already migrated), the pre-update dump is restored. A release that runs but has a bug is fixed by a new release. | Always restoring; rolling back by image alone. |
| 8 | Holders get an app view. The infra view stays reachable under "Advanced", where the template owns the image, the version and which services run; these are shown but locked. Holders keep env vars and secrets, size above the plan's minimum, and extra packages. | Read-only page; editable-and-overwritten; editable-and-excluded. |
| 9 | A newer release during a notice period replaces the pending one and keeps the earlier deadline. | Resetting the deadline. |
| 10 | Gating is per app and off by default. An app that has not opted in behaves exactly as today. | Changing every app. |

## 3. Lifecycle

1. **Published.** CI records the image. For a gated app, a record aimed at LATEST moves STAGING instead.
2. **Canary.** The canary environment follows STAGING and updates at once. A release that does not come up healthy there goes no further.
3. **Promoted.** The publisher promotes the version with a notice period. This creates a rollout and moves LATEST.
4. **Available.** Every customer environment gets a pending update with a due time.
5. **Applied.** The update runs when the holder asks or when it is due, one environment at a time.
6. **Done.** The rollout completes when no environment is pending.

One update: dump the database (phase 2), set the version, wait for the environment to be READY on the new version, record the outcome.

## 4. Backend model (`vetra-cloud-package`)

All new relational state lives in the licensing database (`subgraphs/vetra-licensing/db`), with a migration.

### 4.1 Release policy

`app_release_settings (app_id PK, policy 'AUTO'|'GATED' default 'AUTO', default_notice_hours int default 72, updated_at)`.

`ciRecordArtifact`: when the app's policy is GATED, the artifact kind is FUSION_IMAGE and the requested channel is LATEST, the pointer moved is STAGING. Any other combination is unchanged. The deploy action needs no change.

Turning GATED on requires at least one canary environment (4.2) and sets STAGING to LATEST's current version when STAGING has no pointer, so the canary does not lose its image.

### 4.2 Canary

`license_environments.channel_override text null`. `'STAGING'` marks a canary. When the keeper resolves the template for that chain, every artifact reference resolves on the override channel instead of the template's. The hash is taken over the resolved set as today, so the canary re-templates when STAGING moves.

A canary is never gated: it takes a new version on the next tick. An app may have more than one.

### 4.3 Rollouts and updates

```
app_rollouts
  id, app_id, artifact_name, version,
  status 'ACTIVE' | 'PAUSED' | 'SUPERSEDED' | 'COMPLETE',
  apply_after, promoted_by, promoted_at, paused_at, paused_reason

environment_updates
  id, rollout_id null, environment_id, app_id,
  from_version, to_version,
  status 'PENDING' | 'APPLYING' | 'SUCCEEDED' | 'REVERTED' | 'RESTORED' | 'FAILED' | 'SUPERSEDED',
  due_at, requested_at null, started_at null, finished_at null,
  pre_update_dump_id null, error null, created_at
  unique (rollout_id, environment_id)
```

- **Promote** (`promoteRelease(appId, artifactName, version, noticeHours)`): refuses unless a canary of the app is READY on `version`; marks any ACTIVE or PAUSED rollout of the artifact SUPERSEDED; inserts the rollout with `apply_after = now + noticeHours`; moves LATEST to `version` (`SET_ARTIFACT_CHANNEL`).
- **Pending updates** are created by the keeper, not at promotion: when a live, non-canary environment of a gated app would have its FUSION version moved by the floor update and has no open update for that version, the keeper inserts one, PENDING, with `due_at = min(rollout.apply_after, due_at of the update it supersedes)`. The superseded update is marked SUPERSEDED.
- **Canary updates** get an `environment_updates` row too (`rollout_id` null, due at once), so history and failure handling are the same.
- **Update now** (`updateEnvironmentNow(environmentId)`, holder or publisher): sets `requested_at`. Refused while the rollout is PAUSED.
- **Gate.** The keeper moves the FUSION version of a gated app's environment only when the environment's update is PENDING, due (`requested_at` set or `due_at` passed), its rollout is ACTIVE (or it is a canary), and no other update of the same app is APPLYING. It then marks the update APPLYING with `started_at`.
- **Held environments** apply everything else in the floor update (packages, size, env) but not the version. They do not use the re-template budget, and `template_hash` advances only when the environment fully meets the template. This also fixes today's "held but marked applied".
- **Outcome.** An APPLYING update becomes SUCCEEDED when the environment is READY and its FUSION version is `to_version`. It fails when the environment is DEPLOYMENT_FAILED, or after `LICENSING_UPDATE_TIMEOUT_MS` (default 20 minutes). In phase 1 a failure sets the update FAILED and pauses the rollout (`paused_reason` names the environment and the error). Phase 2 adds the automatic recovery of section 5.
- **Resume** (`resumeRollout`) sets a PAUSED rollout ACTIVE and returns FAILED updates to PENDING. **Complete**: an ACTIVE rollout with no PENDING or APPLYING update is COMPLETE.
- **Stranded versions** (the floor cannot prove the current version older): the update stays PENDING with `error` set, is logged once per version, and shows as "needs attention". The publisher's `forceEnvironmentUpdate` applies the version regardless.
- **AUTO apps** keep today's behaviour, and still get `environment_updates` rows (created APPLYING), so history and outcome exist for every app.

### 4.4 Managed marker and locks

Environment document state gains `managedBy { appId, templateId, rootLicenseId } | null`, set by a new system-only operation `SET_MANAGED_BY` (added to `SYSTEM_ONLY_OPERATIONS`). The keeper sets it on create and on warm claim, and backfills it for existing `license_environments` rows.

When `managedBy` is set, a user-signed action is rejected by the reducer for: `SET_SERVICE_VERSION`, enabling or disabling a service the template declares, and a `SET_FUSION_CONFIG` that changes `image`, `autoUpdate` or `autoUpdateTagPattern`. Unsigned (system) actions pass, so the keeper is unaffected. Env vars, secrets, size and packages stay with the holder.

`myEnvironments` and the environment read model expose `managedBy`, so the console can classify without matching subscriptions client-side.

### 4.5 Read and write API

Publisher (`vetraPublisher`, owner-authenticated):
- `releaseSettings(appId)`, `setReleasePolicy(appId, policy, defaultNoticeHours)`
- `setCanaryEnvironment(appId, environmentId, canary: Boolean)`
- `releaseCandidates(appId)`: per FUSION artifact, the STAGING and LATEST versions and each canary's version and status
- `promoteRelease`, `resumeRollout`, `forceEnvironmentUpdate`
- `rollouts(appId)`: rollouts with counts by update status
- `PublisherEnvironment` gains `runningVersion`, `isCanary`, `update { status, toVersion, dueAt, error }`

Holder (owner of the environment):
- `environmentUpdate(environmentId)`: the open update (`toVersion`, `dueAt`, `status`, `canUpdateNow`), and `history` (the last 20 updates)
- `updateEnvironmentNow(environmentId)`

### 4.6 Small fixes that ride along

- `DEPLOYMENt_FAILED` typo in `fusion-auto-update.ts`.

## 5. Safe apply (phase 2, `vetra-cloud-package`, chart if needed)

- **Probes.** A host environment gets a startup probe and a readiness probe on the switchboard's `/ready`, so a long migration is not killed and READY means the switchboard is up. Requires `/ready` to be reachable in the pod (the switchboard member's port, or added to Connect's proxy paths). Must be validated on staging before it reaches production: a wrong probe takes every holder environment down.
- **Dumps for host environments.** Scheduled dumps, manual dumps and restore work when the database belongs to a host (FUSION with `PH_HOST`): eligibility no longer requires SWITCHBOARD, and restore scales the app deployment instead of the switchboard's.
- **Pre-update dump.** Before the version is set, the keeper takes a dump and stores its id on the update. An update does not start if the dump fails.
- **Recovery.** On failure: set the previous version and wait. READY again: the update is REVERTED. Not READY within the timeout: restore the pre-update dump, set the previous version, wait; READY: RESTORED. Still not READY: FAILED, and the environment needs a person. Every outcome but SUCCEEDED pauses the rollout.
- `/data` snapshots are out of scope: an update does not rewrite the volume.

## 6. Console (phase 3, `vetra.to`)

Publisher, on the app page:
- **Releases**: the candidate on the canary ("v on your environment, healthy since"), a Promote dialog with the notice period and "affects N environments", the active rollout with progress (updated, waiting, failed) and Resume.
- **Holders**: version, canary badge and update status columns; Retry and Force update; mark as canary.
- **Settings**: release policy and default notice.

Holder:
- The environment page gets a mode. A managed environment opens on an **App view**: app, running version, status, update banner ("Update available, applies automatically on <date>" with Update now), update history, licence, domain, restart, backups. **Advanced** shows today's infra view with the template-owned controls locked.
- A standalone environment keeps today's view.
- Lists classify by `managedBy`: holder environments leave "Environments you manage by hand" and appear with their app. A pending update shows in "Needs attention". A Fusion-only environment gets its Visit button.

## 7. Phasing

Each phase has its own implementation plan.

1. **Gate and records** (backend): 4.1 to 4.6. Useful alone: canary, promotion, notice, serial apply, pause on failure, history, locks.
2. **Safe apply** (backend, chart): section 5.
3. **Console** (vetra.to): section 6. Depends on phase 1's API; the recovery states of phase 2 are displayed when present.

## 8. Out of scope

Percentage waves; holder pinning and undo; email or in-app notices (the console is the only channel, so most holders are updated by the deadline); `/data` snapshots; rendering the infra view from a host manifest; ordering versions by semver tag instead of recording order; changing how Production deploys.

## 9. Testing

- Unit: policy redirect in `ciRecordArtifact`; channel override in template resolution; gate decisions (due, requested, paused, another update applying, canary); supersede keeps the earlier deadline; held environment does not advance the hash or use the budget; outcome transitions; reducer locks for signed and unsigned actions.
- Integration (existing reactor-backed keeper tests): publish, canary updates, promote, notice elapses, environments update one per tick-sequence, a failure pauses, resume continues. An AUTO app's behaviour is unchanged (existing tests stay green).
- Console: classification helper, App view rendering per update state, Promote dialog, e2e on the holder banner.

## 10. Open items

- Why `fair-bull` is behind. Check the keeper logs for the "stays on FUSION" warning and the environment's status history.
- The outage per update is unmeasured for Sektar's image.
- The probe change needs a staging run before production.
