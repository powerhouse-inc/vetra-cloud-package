# Releases phase 3 ("Plans and rollouts"): overview and slices

Date: 2026-11-12. Spec: `docs/superpowers/specs/2026-11-11-app-releases-and-instances-design.md`
(sections 5, 6, 7, 10, 11, 12, 13, 14, 16, 18 phase 3). Builds on phase 2 as built on `main`
(vetra-cloud-package 0.0.114: `subgraphs/vetra-apps/instances/*`, `settings/*`, `releases/*`).

Phase 3 is split into ten slices. Each ships alone and is usable alone. Slices 1-8 only act on
**plan-owned kinds** (below), so Sektar's licensed environments keep running, and keep getting
gated rollouts, exactly as today until slice 9 moves them. Slice 1 is written out in full
(`2026-11-12-releases-phase-3-plan-1-plans-and-plan-instances.md`). The other slices get their
own plan when their turn comes, written against the code as it stands then.

## What exists today (checked 2026-11-12 on `main` = 0.0.114)

- **Instances (phase 2).** The `instances` table (`kind` already allows `shared` and `own`), the
  reconciler (`instances/reconciler.ts`: `reconcileInstancesOnce`, `syncBranchInstances`,
  `syncPreviewInstances`, `reconcileInstance`, revert on failure), health (`health.ts`,
  `monitor.ts`, spec 14.7, `VETRA_APPS_INSTANCE_HEALTH`), settings (`settings/*`: publisher
  settings per App, generated master key and attachment secret per instance in the tenant's
  secrets). Every instance environment is linked with `app.role = PREVIEW`. The processor
  (`processors/vetra-cloud-environment/gitops.ts` `isPreviewEnv`) renders it slim: size S,
  5 Gi database without S3 backups, `persistence.enabled: false` for `/data`, under
  `previews/`. Kill switch `VETRA_APPS_INSTANCES` (production: `off`), staging host suffix `-stg`.
- **The licensing model phase 3 replaces** (`subgraphs/vetra-licensing/`):
  - A licence is an `app-owner-license` document issued by `issue.ts` `issueLicense` for a
    **term** `kind` on the vetra-app document (`VetraAppLicenseTerm {id, kind, label,
    templateId, validityDays, issuers, status}`). Provenance is recorded in
    `app_license_grants (license_id, app_id, kind, user_did, user_address, …)`, chains in
    `license_chain`, and status in `license_lifecycle` (`isLiveEntry`: ACTIVE and not past `end_at`).
    Issuers: `issuers/invite-code.ts` and `issuers/publisher-grant.ts`.
  - A term points at a template (`mode` SHARED | DEDICATED). `handler.ts` `AppLicenseHandler`
    with `chain-plan.ts` gives each DEDICATED chain one environment (`license_environments`,
    `managedBy` marker, warm pool `app_warm_pool`). A SHARED holder gets **no environment**: the
    licence's `stage` points at the app's production environment, and the app asks
    `vetraLicensing.hasLicense(user)` (App-key auth, per App, Boolean).
  - Gated rollouts: `release-service.ts` (`vetraReleases` API: `promoteRelease`,
    `resumeRollout`, `forceEnvironmentUpdate`, `updateEnvironmentNow`), `release-gate.ts`,
    `release-tracker.ts`, tables `app_release_settings`, `app_rollouts`, `environment_updates`.
    A failure only pauses the rollout: `pre_update_dump_id` is never written, and nothing ever
    sets REVERTED/RESTORED.
  - Offboarding (`offboarding.ts`): warning 7 days before the end, stopped 14 days after it, final
    warning at 83 days, destroyed at 90 days only with `LICENSING_DESTROY_ENABLED`. Banners only:
    nothing emails holders.
- **The bridge** `releases/licensed-host.ts` (`recordLicensedHost`, called by `ciReportRelease`):
  a stable release recorded by `POST ci/releases` is also recorded as the App's `host`
  FUSION_IMAGE artifact on LATEST (GATED: STAGING), so licensed environments keep following
  releases now that Sektar runs `vetra-publish@v1` only.
- **Backups that exist:** CNPG scheduled backups to `s3://powerhouse-cnpg-backups/<tenant>/`
  (daily, 180 d) for every non-preview database, and the observability dumps subsystem
  (`subgraphs/vetra-cloud-observability/dumps/`: `pg_dump` jobs to `VETRA_DUMPS_BUCKET`, restore
  with a safety dump, `requestEnvironmentDump`/`restoreEnvironmentDump`, owner-authorised).
  There is **no** `/data` backup, no CNPG on-demand `Backup`, and no `VolumeSnapshot` anywhere.
- **Not existing at all:** audit log, release-manager role, email to holders, a licence check a
  host can call per instance.
- **Production facts.** Sektar (`43622402-be06-435a-bbfa-bb649b0d6244`) is GATED, canary
  `fast-lion`, with about 10-15 licensed environments holding real customer data on
  `cr.vetra.io/<old project>/host:sha-cac9276bc10b` (v1.0.9). Sektar's host keeps its workflows
  master key and attachment signing secret **on `/data`** (`/data/workflows-master-key`,
  `/data/attachment-url-signing-secret`), because licensed environments get only `PH_HOST`,
  `ADMINS` and `OPENROUTER_API_KEY` from Vetra. Staging has no licensed environments.

## Rules every slice follows

1. **Plan-owned kinds.** A licence kind belongs to the instances model once a `plans` row names
   it (slice 1). Licensing's handler leaves chains of plan-owned kinds alone, unless the chain
   already has a `license_environments` row. The reconciler never gives a chain with a
   `license_environments` row an instance. Until slice 9, a kind with licensed environments
   cannot become a plan (`createPlan` refuses an App with any licensed environment, and a kind that
   already has live licences). So no holder ever has two environments, and no licensed environment
   changes owner silently.
2. The phase 2 rules still hold: only environments whose id is in `instances` are touched; images
   are pulled by digest; nothing with `managedBy` set is written by the reconciler.
3. **Staging first, then production by pinned release** (`PH_REGISTRY_PACKAGES` in
   `powerhouse-k8s-hosting`, `tenants/staging/…` then `tenants/vetra/…`, two places each). Every
   new switch defaults to off (`VETRA_APPS_PLANS`, later `VETRA_APPS_ROLLOUTS`, …). Production
   turns a switch on only after the slice was verified on staging.
4. No production pin while a Sektar gated rollout is APPLYING. Check
   `vetraReleases.rollouts(appId: "43622402-be06-435a-bbfa-bb649b0d6244")` first.
5. No Sektar data is deleted by any slice before slice 9's 30-day hold is over and the user says so.
6. Console work goes to vetra.to per slice, in its own PR after the backend is on staging, under
   `modules/apps` (publisher) and `modules/subscriptions` / `app/user` (holder). The old
   publisher Holders tab (`modules/publisher/components/holders/*`, `rollouts.ts`) keeps serving
   licensed environments until slice 10.

## The slices

### Slice 1: Plans and plan instances (plan written)

- **Goal:** a publisher turns one of the App's licensing terms into a **plan**, with access
  `shared` or `own`, a size and a target release. Vetra then runs the plan's instances: one
  shared instance per shared plan, and one own instance per live licence chain of an own plan.
  Each runs the target release by digest, with a kept `/data`, a backed-up database and the
  plan's size.
- **What changes:**
  - New table `plans` (vetra-apps; a plan adopts a term by its `kind`, and issuers, validity and
    codes stay on the term). New `instances` columns `plan_id`, `holder_address`,
    `licence_root_id`, `licence_ended_at`, `stop_reason`, `stopped_by_vetra`.
  - New environment role `PLAN` in the `vetra-cloud-environment` model, so the processor renders
    plan instances with the full profile (no processor code change).
  - The reconciler syncs `shared` and `own` rows. Holders come from `app_license_grants` +
    `license_chain` + `license_lifecycle`. An own instance is stopped `stopAfterDays` after its
    licence ends and woken when the chain is live again. A retired shared plan with no live
    licences is stopped. Nothing of a plan instance is ever deleted in this slice.
  - Owner of a plan instance's environment document: the Vetra service identity. `ADMINS`: the
    holder (own) or the App owner (shared).
  - GraphQL: `appPlans`, `createPlan`, `updatePlan`, `setPlanTarget` (moves the plan's instances
    **directly**: the stand-in until slice 3), `retirePlan`, `myInstances` (holder view);
    `AppInstance.planId/holder`.
  - Licensing: the handler drops chains of plan-owned kinds that have no licensed environment.
  - Switch `VETRA_APPS_PLANS` (default off) and `VETRA_APPS_PLAN_STOP_AFTER_DAYS`.
- **Migration/compat:** additive tables, columns and enum value. With the switch off, nothing
  runs. `createPlan` refuses an App with licensed environments and a kind with live licences, so
  neither Sektar's terms nor any term with holders can be adopted by accident.
- **Risks:**
  - A shared instance has no licence gate yet (slice 5), so it admits whoever the host admits
    today (signed-in users). That is the same as Sektar's SHARED plans on its production
    environment, but no customer may be put on a shared plan before slice 5.
  - `setPlanTarget` moves customers without notice. Production keeps `VETRA_APPS_PLANS` off until
    slice 3 replaces it.
  - The new enum value must reach every reader of environment documents before a `PLAN` document
    exists. This is the same package and the same pin, but vetra.to's generated types need a
    regen.
- **Staging test:** on the staging canary app, adopt a term as an own plan, issue a publisher
  grant, and check that an own instance appears READY on the target digest with
  `persistence.enabled: true` and backups in `tenants/<tenant>/powerhouse-values.yaml`. Expire
  the grant, advance past the stop window, and check it is STOPPED. Renew it, and check it wakes.
  Check that a shared plan gets one instance, and that `setPlanTarget` moves both.
- **Needs the user:**
  - staging values `VETRA_APPS_PLANS: "on"`, the pin PRs, and a term on the staging canary app;
  - decisions D1-D4 (below);
  - vetra.to PR: a Plans tab on the App page (list, create from a term, target, retire) and
    "My instances" for holders.

### Slice 2: Audit log and release-manager role (spec 10)

- **Goal:** every plan, rollout, settings and instance-status change is recorded (who, what,
  when, from where: console, API, policy), and an org can name **release managers** per App.
- **What changes:** `app_audit (id, app_id, at, actor, source, action, subject, detail JSON)`,
  kept 1 year (a sweep); `app_roles (app_id, address, role='release_manager')`. A
  `canRelease(app, caller)` check = `canOperate` (owner, org OWNER/ADMIN, PUBLISHER in scope) **or**
  release manager. The plan, settings and (later) rollout mutations call it and write audit rows.
  `appAudit(appId, limit, before)` query; `setAppRole`/`removeAppRole` (owner and org admins only).
  Release and instance status events from the reconciler are audited with `source = system`.
- **Migration/compat:** additive. Existing callers keep their rights.
- **Risks:** audit writes in the reconciler's hot path. Write only on status *changes* (the
  reconciler already patches only on change).
- **Staging:** create, retarget and retire a plan as a release manager who is not an org admin,
  and see the audit rows. Check that a plain member is refused.
- **Needs the user:** D7 (the role lives in Vetra, not Renown); vetra.to: an Audit tab and a
  role picker on the App's Access settings.

### Slice 3: Rollouts (spec 7 except backups; 14.3, 14.8)

- **Goal:** targets of shared and own plans move only through rollouts: check, notice, one
  instance at a time, health-gated, pause/retry/skip, pinning, image rollback, policies and
  update windows. Withdrawn releases can't be targeted.
- **What changes:**
  - Tables `rollouts (id, app_id, version, status ACTIVE|PAUSED|COMPLETE|CANCELLED, started_by,
    source console|policy, apply_after, paused_reason, …)`, `rollout_plans`,
    `rollout_steps (rollout_id, instance_id, from_version, to_version, status
    PENDING|APPLYING|SUCCEEDED|FAILED|SKIPPED|ROLLED_BACK, due_at, …)`.
  - `instances.pinned_version`; `releases.withdrawn_at`, `withdrawn_by`; plan `policy`
    (`manual`, `patches`, `minor`, `follow:<branch>`), `notice_hours`, `update_window`
    (cron-like days/hours + time zone, e.g. `Europe/Berlin`).
  - **Check:** the release exists, is a release, not withdrawn; `requires.services` ⊆ the plan's
    template; `requires.size` ≤ the plan's size; `requires.powerhouse` and, for shared plans
    after slice 5, the licence-gate Powerhouse version; refused before anything moves.
  - **Announce:** a holder notice (`myInstances.update { version, dueAt, notes, canUpdateNow }`)
    and `updateInstanceNow` for holders (which ignores the window).
  - **Apply:** the shared instances of the rollout first, then own instances; one APPLYING per
    App; reuse of the reconciler's update path. A step is SUCCEEDED when the instance is `ready`
    on the target under `VETRA_APPS_INSTANCE_HEALTH=enforce`. A failure or timeout reverts that
    instance (phase 2 revert) and pauses the rollout with an alert row in the audit.
  - `retryRolloutStep`, `skipRolloutStep`, `rollBackRollout` (image swap: sets the plans' targets
    back, steps ROLLED_BACK one at a time), `pinInstance(version)`/`unpinInstance`.
  - The policy runner starts a rollout for a plan by itself when a new release matches
    (`patches`/`minor` never majors; `follow:<branch>` every release from that branch).
  - `setPlanTarget` from slice 1 becomes "start a rollout of one plan". `withdrawRelease`.
  - Switch `VETRA_APPS_ROLLOUTS`.
- **Migration/compat:** plan instances that exist keep their target. Rollouts never touch
  `license_environments` (gated rollouts of `vetra-licensing` stay for Sektar until slice 10).
- **Risks:**
  - Health `enforce` is required for meaningful steps. It runs in `report` today, so it is turned
    to `enforce` on staging first.
  - A rollout stuck on a sleeping instance: steps on a STOPPED instance are skipped and recorded
    "stopped: updated when it wakes" (the target still moves).
  - Time zones in windows: one library (`Intl`), tested at DST changes.
- **Staging:** two plans (shared + own, two holders); release `x.y.1`; roll out with 1 h notice
  and a window; break the second instance (canary `CANARY_CRASH`); check pause, revert, retry,
  skip, roll back, pin; a `patches` policy picks up `x.y.2` by itself; a withdrawn release is
  refused.
- **Needs the user:** D5 (notice channel: in-app only in phase 3) and staging
  `VETRA_APPS_INSTANCE_HEALTH: enforce`. vetra.to: the Plans tab gets "Roll out", and there is a
  Rollout view (steps live, pause/retry/skip/roll back), pin controls on instances, and the
  holder's update notice with "Update now".

### Slice 4: Backups and restore-based rollback (spec 7 step 4, rollback for `migrates`, 14.16)

- **Goal:** before each rollout step, Vetra backs up the instance's database **and `/data`**.
  Rolling back a release that `migrates` restores that backup.
- **What changes:**
  - Database: the observability dumps subsystem (`createDumpAndJob`, `buildRestoreJob`), called
    by the rollout with a new `source = PRE_UPDATE` and a system requester, never the
    owner-authorised GraphQL path.
  - `/data`: new archive and restore jobs (same job pattern: a pod mounting the instance's PVC,
    `tar` to the dumps bucket under `<tenant>/data/<id>.tar.zst`), table `data_archives`.
  - The step waits for both. `rollout_steps.backup_dump_id`, `backup_archive_id`.
  - Rollback of a `migrates` step: stop, restore the dump (safety dump first, as today), restore
    `/data`, set the old digest, start. The console warns that data written since is lost.
- **Migration/compat:** additive. The CNPG scheduled backups stay as the daily backup.
- **Risks:** the size and duration of `/data` archives (attachments). Measure on staging with a
  large `/data`, and use a step timeout that is separate from the update timeout. A restore job
  that fails leaves the instance stopped: the reason says so, and it never starts on half a
  restore.
- **Staging:** a release with `migrates: true` whose migration adds a table; roll out; write a
  document; roll back; the table and the document are gone, and `/data` matches the archive's
  checksum.
- **Needs the user:** D6 (dumps + `/data` archives now, CNPG PITR and VolumeSnapshots later);
  bucket lifecycle rule for `PRE_UPDATE` dumps (e.g. 30 days) on the dumps bucket.

### Slice 5: Licence gate (spec 5 "Licence gate", 14.14) — external dependency

- **Goal:** a shared instance admits only admins and the plan's live licence holders. A lapsed
  licence loses access within 60 s.
- **Vetra side (this repo):**
  - Each shared instance gets a gate token, generated once and kept in its tenant's secrets as
    `VETRA_GATE_TOKEN`; only its sha256 is stored in `instance_gate_tokens`.
  - Plain env: `ACCESS=licensed`, `VETRA_APP_ID=<appId>`, `VETRA_GATE_URL=<switchboard>/api/@powerhousedao/vetra-cloud-package/apps/gate/check`.
  - **Contract:** `POST apps/gate/check` with headers `Authorization: Bearer <VETRA_GATE_TOKEN>`
    and body `{ "address": "0x…" }`. The answer is `200 { "allowed": boolean, "reason":
    "admin" | "licence" | "member" | "none", "until": ISO | null, "ttlSeconds": 60 }`. A bad or
    unknown token gets 401. A Vetra failure gets 503 (the caller applies its 24 h grace). The
    answer is for **the instance's plan** (D8): admins = the instance's `ADMINS`, licence = a live
    licence of the plan's kind. The Team instance (slice 6) answers org membership through the
    same route (`reason: "member"`).
  - Rate limit per token. Audit of nothing (too hot); counters in logs only.
- **Powerhouse monorepo (switchboard / reactor-api auth), not planned here beyond the contract:**
  - With `ACCESS=licensed`, every authenticated request whose caller is not in `ADMINS` is
    allowed only when `POST $VETRA_GATE_URL` says `allowed`.
  - The answer is cached per address for `ttlSeconds` (60 s). The last positive answer is kept
    for 24 h when Vetra is unreachable (non-2xx other than 401, or a network error). An address
    never seen is refused while Vetra is down. Anonymous callers are refused.
  - The policy sits next to `AuthorizationPolicy` (`packages/reactor-api/src/services/authorization.service.ts`:
    OPEN, ADMIN_ONLY, DOCUMENT_PERMISSIONS) and needs `AUTH_ENABLED=true`.
  - Ships in a Powerhouse release `X`. An App gets it only by rebuilding on `X`, because the host
    image carries Powerhouse. So Vetra's rollout check refuses a shared plan's release built with
    `powerhouse < X` (`releases.powerhouse_version`), and slice 3's check gets that rule (D9).
- **Migration/compat:** an old host ignores `ACCESS`, and the console shows "gate not active
  (built with Powerhouse < X)" on such shared instances.
- **Risks:** the monorepo change's timing and its review. Load on Vetra from 60 s caches × users;
  the answer is two indexed queries.
- **Staging:** the canary app is rebuilt on `X`. A licence holder gets in; a stranger gets 403;
  after the licence is revoked, access goes within 60 s; with the gate URL pointing at a dead
  host, the holder stays in and a newcomer is refused.
- **Needs the user:** the monorepo PR and its release (owner, review, version `X`); D8, D9.

### Slice 6: Team plan (spec 5 "Team plan", 7 step 1)

- **Goal:** one click on an org App's page makes a shared plan `team` for the org's own people
  (no codes or grants), following a branch (`follow:<branch>` policy). A customer rollout of a
  release needs that release to have run healthy on Team.
- **What changes:**
  - `plans.team boolean` (one per App, org apps only, slug `team`, reserved); a kind-less plan
    (no term); `enableTeamPlan(appId, followBranch)` / `disableTeamPlan`.
  - The gate answers org membership (Renown `orgMembership`, cached 60 s) for the Team instance.
  - `ADMINS` = the org's admins when Renown can list them, else the owner (phase 2 gap 9).
  - Rollout check: when a Team plan exists, `instances(kind=shared, plan=team)` must have been
    `ready` on the release (health history `running_version` + an audit row "ran healthy") before
    a customer rollout starts.
- **Migration/compat:** additive; apps without Team are unaffected.
- **Risks:** an org with many members makes the gate check member lists. It checks per address
  only, never lists.
- **Staging:** an org-owned canary app; turn Team on; a member gets in, a non-member does not;
  a customer rollout of a release Team never ran is refused with the reason.
- **Needs the user:** an org-owned staging app; whether `ADMINS` may stay owner-only.

### Slice 7: Holders (14.2 holder settings, 14.4, 14.5, end of licence, AI)

- **Goal:** holders run their own instance like their own: custom domain, own OAuth client and
  settings, backup download, support access. End of licence and app deletion follow the spec,
  with notices.
- **What changes:**
  - Holder settings per own instance (`instance_settings`, same validation as publisher settings,
    applied on every update and rollback). Custom domain on the own instance's document
    (`setCustomDomain` by Vetra on the holder's request, with DNS check). File settings
    (e.g. `/client_secret_sektar-web-app.json`), which need the `powerhouse-chart` secret-file
    mount (phase 2 slice 4 left this out).
  - `downloadInstanceBackup` for holders (a fresh dump + `/data` archive, signed URL, 1 h).
  - Support access: `grantSupportAccess(instanceId, hours)` adds the publisher to `ADMINS`
    for that time, audited.
  - End of licence: banners like `offboarding.ts` `subscriptionWarnings` on `myInstances`; stop
    after `VETRA_APPS_PLAN_STOP_AFTER_DAYS`; deletion of the environment after 90 days only with
    `VETRA_APPS_PLANS_DESTROY=on`, after a final backup kept 180 days.
  - `deleteApp` with live licences: holders are told, notice period 30 days, then the
    end-of-licence path (14.4).
  - Plans with AI: `OPENROUTER_API_KEY` from the LLM broker with the plan's budget (as
    licensing's `INCLUDED_KEY_ENV`), and the reporting token (`VETRA_REPORTING_TOKEN`,
    `VETRA_LICENSING_URL`) for `reportUserStat` parity.
- **Risks:** a custom-domain move breaks a holder's DNS if done wrong; deletion is irreversible
  (switch off by default).
- **Staging:** a holder sets a custom domain and an OAuth file; check it survives a rollout and
  a rollback; download a backup; expire, then delete with the switch on (staging only).
- **Needs the user:** the chart PR (secret file mounts); D4; whether email is needed before
  deletion is ever switched on in production.

### Slice 8: Own instances from a warm pool (spec 6, phase 2 gap 13)

- **Goal:** a new holder of an own plan gets a running instance in seconds, as Sektar's holders
  do today with licensing's warm pool.
- **What changes:** `plans.warm_pool_size`; a pool keeper for plan instances (pre-created
  `PLAN` environments on the plan's target, ownerless, closed ingress like
  `warm-env.ts`), claimed by the reconciler when it makes an own row; re-created when the target
  moves (rolling, one at a time); `app-image-project.ts` vouches for pool environments through
  the instances table (a pool row is an `instances` row with `kind = own`, no holder yet).
- **Risks:** idle cost (bounded by `warm_pool_size`); a claimed warm instance must get the
  holder's `ADMINS` and secrets before its ingress opens.
- **Staging:** pool size 1; issue a grant; the instance is ready within one pass; the pool
  refills.
- **Needs the user:** pool sizes for Sektar's own plans.

### Slice 9: Sektar switch-over (spec 13), rehearsed on staging

- **Goal:** every Sektar holder moves from their licensed environment to an own instance with
  their data. SHARED access moves to a shared instance. No holder loses data or more than a few
  minutes of service.
- **Tooling (admin-only, per environment, resumable, audited):**
  `switchOverLicensedEnvironment(environmentId)` runs these steps one environment at a time:
  1. **Freeze:** Sektar's gated rollouts and `promoteRelease` are refused during the switch-over
     (`app_release_settings` flag), and the bridge stops moving channels for the App.
  2. **Stop** the licensed environment (sleep).
  3. Take a `pg_dump` (dumps subsystem) and a `/data` archive (slice 4 jobs), plus the parity
     set, all stored with holder and licence: `/data/workflows-master-key`,
     `/data/attachment-url-signing-secret`, the tenant secrets (`OPENROUTER_API_KEY`, reporting
     token), holder-set FUSION env entries, and the custom domain.
  4. **Create the own instance** of the plan that adopted the holder's kind, on Sektar's first
     vetra-publish release. Restore the dump and `/data`, write the **old** master key and
     attachment secret into the new tenant's secrets **before the first start** (otherwise the
     database's key fingerprint refuses Vetra's generated key: `MasterKeyMismatchError`), copy
     the parity set, move the custom domain, and start it.
  5. **Verify** with health `enforce`, plus a document count and a `/data` checksum compared with
     the old environment.
  6. Link the licence chain to the instance (`instances.licence_root_id`) and mark the
     `license_environments` row `switched_over_at` (new column). From then on licensing ignores
     the chain (rule 1 changes to "switched-over rows are the instances model's"). Keep the old
     environment stopped for 30 days, then the user decides on deletion.
  7. Tell the holder the new URL (in-app notice; email per D5).
  - `adoptLicensedKind(appId, kind)` lets a plan adopt a kind with licensed environments only
    while every one of them is switched over or in progress.
- **Order:** rehearse on staging, then production canary `fast-lion` alone, then the other
  holders one at a time, with a window announced 72 h ahead. SHARED: make the shared plan
  instance first. Holders' licences keep working because the gate (slice 5) admits them there,
  then the SHARED term becomes a plan.
- **Staging rehearsal:** staging has no licensed environments.
  1. Connect a rehearsal copy of Sektar to staging (a fork, `powerhouse-inc/sektar-rehearsal`;
     Renown binds a repo to the first platform it was connected to).
  2. Give it a DEDICATED template on the host image and a SHARED term, and issue 3 grants.
  3. Fill the environments with documents, attachments, a workflow secret and a custom domain.
  4. Run the full switch-over and compare.
  5. Do it twice, the second time with an injected failure at each step.
- **Risks:** this is the one irreversible-feeling step. Mitigations: the old environment is kept
  stopped 30 days, every step is resumable and idempotent, and per-holder rollback goes back to
  the old environment (wake it, unlink the instance).
- **Needs the user:**
  - the rehearsal repo and its staging app;
  - production decisions D10-D12;
  - a maintenance window and the holder announcement;
  - `VETRA_APPS_INSTANCES`, `VETRA_APPS_PLANS`, `VETRA_APPS_ROLLOUTS` on and health `enforce` in
    production;
  - Sektar repo changes (spec 15: the root `Dockerfile` and `fusion-dockerfile` removed).

### Slice 10: Removal (spec 16, phase 3 part)

- **Goal:** one model. After every licensed environment is switched over and the 30-day hold
  has passed:
  - licensing's environment model goes: `handler.ts` provisioning, `environments.ts`,
    `chain-plan.ts` provision steps, `keeper` provisioning, the licensing warm pool,
    `channel-override.ts`, `artifact-resolution.ts`, the gated rollout code and the
    `vetraReleases` API (`release-service.ts`, `release-gate.ts`, `release-tracker.ts`,
    `update-gate.ts`, `update-outcome.ts`);
  - the bridge `releases/licensed-host.ts`;
  - `ci/artifacts`, the artifact versions and channels on the app document, and template modes;
  - the App's production environment for GitHub apps: `ci/deploy` PRODUCTION,
    `deployApp`/`rollbackApp`, and `production_environment_id` reads in licensing;
  - `vetra-deploy-action@v1` fails fully, pointing at vetra-publish.
- **Kept:** tables (code is deleted, tables are never dropped, as licensing's Task 17 did), licence
  documents, terms (the issuing part of a plan; merged into `plans` here: `issuers`,
  `validityDays`, `label` move to the plan row, and the app document's terms become read-only
  history), `hasLicense` (now answered from plans), Studio products' path (spec 9).
- **Risks:** any App still on a SHARED term pointing at its production environment. The slice
  starts with a check query that lists every App with live licences of non-plan kinds, and
  refuses to run while that list is not empty.
- **Staging:** the full suite; an App on the old workflow gets the deprecation failure.
- **Needs the user:** a release of `vetra-deploy-action@v1`; the go after the 30-day hold;
  removal of the publisher Holders tab in vetra.to.

**Order and dependencies:** 1 → 2 → 3 → 4. Slice 5's Vetra side can go any time after 1, and its
monorepo part runs in parallel from day one. 6 needs 3 and 5. 7 needs 4. 8 needs 1. 9 needs 3, 4,
5, 7 and 8 on production. 10 needs 9 plus 30 days. Sektar's customers are on the old model until
9 moves them one at a time, with the old environment kept as the way back.

## Spec gaps and contradictions (proposed fixes; the spec is not changed by these plans)

1. **Plans vs terms.** Spec 7 gives a plan its issuers and validity. Today those live on the
   app document's terms, and every issuer (codes, grants, Achra) issues by term `kind`. Fix:
   a plan adopts a term (1:1 by `kind`) in phase 3, and the two merge in slice 10 (D1).
2. **Plan instances can't be "previews".** Phase 2 renders every instance with `role = PREVIEW`
   (slim, no kept `/data`, no backups), which spec 5 forbids for customers. Fix: a third role
   `PLAN` in the environment model (D3).
3. **Who owns an own instance's document.** Spec 14.5 says the publisher controls updates but
   cannot see data, and the holder can download backups. Making the holder the document owner
   lets them sign FUSION changes (only `managedBy` locks that, and it marks licensed
   environments). Making the publisher the owner gives them `requestEnvironmentDump` on holder
   data. Fix: the Vetra service identity owns it. Holder and publisher act through Vetra's API (D2).
4. **Stop after 7 days** (spec 5) vs **14 days** (what `offboarding.ts` does and what Sektar's
   holders are told by the EXPIRING banners). Fix: configurable, `VETRA_APPS_PLAN_STOP_AFTER_DAYS`
   (D4).
5. **Spec 14.16 (CNPG on-demand backups + volume snapshots) vs what exists.** Only `pg_dump`
   jobs and CNPG schedules exist, and nothing backs up `/data`. Fix: dumps + `/data` archives in
   phase 3, which the switch-over needs anyway (D6).
6. **"An in-app notice and an email"** (spec 7) without any email path in Vetra. Fix: in-app in
   phase 3, email with phase 4 notifications (D5).
7. **The licence gate and the host image.** The gate lives in the switchboard, which the App's
   image carries, so it reaches a shared instance only through a release built on a new enough
   Powerhouse. Fix: a rollout check (D9) and a console hint.
8. **`ACCESS=members` with a member list** (Team) needs a second monorepo mode and env updates on
   every membership change, which restarts the pod. Fix: the same gate route answers membership
   for the Team instance (D8).
9. **Section 13 step 4 misses the secrets that live on `/data`.** Restoring a Sektar database
   into an instance with a fresh Vetra master key breaks every workflow secret
   (`MasterKeyMismatchError`). Fix: the old keys go into the new tenant before the first start
   (slice 9).
10. **Release-manager role** (spec 10) has no home. Renown org roles are OWNER, ADMIN, PUBLISHER.
    Fix: a Vetra-side per-App role (D7).
11. **Plan slug vs branch names in hosts.** Branch and shared instances would share
    `instanceHash(appId, name)`. Fix: shared instances hash `plan:<slug>` (slice 1).

## Decisions for the user (recommended default in brackets)

- **D1** Plans adopt existing licensing terms by `kind`; issuers stay on the term until slice 10. [yes]
- **D2** Plan-instance environment documents are owned by the Vetra service identity; holders and
  publishers act through Vetra. [yes]
- **D3** New environment role `PLAN` (full profile) in the `vetra-cloud-environment` model. [yes]
- **D4** Days after a licence ends before its own instance stops. [14 for now, as holders are told today; 7 once notices exist]
- **D5** Update notices: in-app only in phase 3; email arrives with phase 4. [yes]
- **D6** Backups: `pg_dump` + `/data` archive jobs now; CNPG PITR and snapshots later. [yes]
- **D7** Release manager: a Vetra-side per-App role assigned by owner/org admins. [yes]
- **D8** Licence gate answers per plan (instance token), and also org membership for Team (no
  `ACCESS=members`). [yes]
- **D9** Shared plans refuse releases built on a Powerhouse without the gate. [yes]
- **D10** Production enabling order: instances + health `enforce` on after slice 3 is verified on
  staging; `VETRA_APPS_PLANS`/`ROLLOUTS` on right before Sektar's canary switch-over. [yes]
- **D11** Switch-over per holder, one at a time, canary `fast-lion` first, 72 h announced window. [yes]
- **D12** Sektar's SHARED holders: new, empty shared instance (their old shared data lived on
  Sektar's production environment, kept stopped 30 days). [yes, after checking what that environment holds]
