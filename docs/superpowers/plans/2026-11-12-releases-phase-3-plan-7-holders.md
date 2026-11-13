# Releases phase 3, plan 7: holder features — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A holder runs their own instance as their own, and the end of a licence or of an App follows the spec:
- **Holder settings** on their own instance: plain values, write-only secrets and files, readable and writable by the holder alone, applied on every update and rollback (spec 14.2).
- **Custom domain** for their own instance: DNS check, certificate, host move (spec 5 "Instance hosts", 14.2).
- **File mounts** for publisher and holder settings (Sektar's `/client_secret_sektar-web-app.json`), on the `powerhouse-chart` `secretFiles` change (external task E1).
- **AI key** per plan budget from the LLM broker, and the **reporting token** (`VETRA_REPORTING_TOKEN`, `VETRA_LICENSING_URL`) for `reportUserStat` parity with licensed environments.
- **End of licence** notices on `myInstances`, the existing stop, and (switch-gated) **deletion after 90 days** after a final backup.
- **Holder backup download** (spec 14.5) and **support access** (publisher as temporary admin with the holder's consent, audited).
- **Deleting an App that has holders** (spec 14.4): notice, backup, then the end-of-licence path.
- The three slice 1 follow-ups: publisher secrets no longer reach plan instances through scope `ALL`; Vetra wakes only what Vetra slept; the delete-App path and the directory know about plan instances.

**Prioritisation.** Every task is marked **[essential]** (needed before slice 9, Sektar's switch-over, can run on production) or **[later]** (spec requirements that the switch-over does not depend on). The essential tasks ship as **PR A**, the later ones as **PR B**. PR B's backup tasks also wait for slice 4.

**Architecture:**
- Settings get a fourth scope `plan` (publisher settings for shared and own instances) and a second layer, `instance_settings` (holder settings per own instance). Resolution per instance: `all` (plain only) < `plan` < holder. The settings revision covers all layers, so the reconciler's existing update/revert path applies holder changes like publisher changes.
- Secrets Vetra writes per instance by other paths (AI key, reporting token) are named in `InstanceSettings.vetraSecrets`, so `deliverSettings` never deletes them and `fusionEnv` declares them.
- Holder APIs go through one access helper, `loadOwnInstanceForHolder` (the caller is the row's `holder_address`). Plan-instance documents stay owned by the Vetra service identity (D2): every change to them is made by Vetra on the holder's request.
- Custom domains live on the instance row (`custom_domain*` columns). A checker moves them through `dns → issuing → active`; the reconciler writes `SET_CUSTOM_DOMAIN`/`SET_APEX_SERVICE` on the document and repairs drift; the monitor probes the public host.
- Files travel as tenant secrets keyed `FILE_<16 hex>` and are declared to the processor by one Vetra-set plain env entry `VETRA_FILES` (JSON `[{key, mountPath}]`), which `generateFusionBlock` turns into `app.secretFiles`. No document-model change.
- Backups (PR B) use a port, `InstanceBackups`, that slice 4 implements. This plan defines it and ships an "unavailable" stub until slice 4 is on `main`.

**Tech Stack:** TypeScript, Kysely (Postgres; PGlite in tests), vitest, GraphQL (vetra-apps subgraph), the vetra-cloud-environment processor, Helm (`powerhouse-chart`, external).

**Spec:** `docs/superpowers/specs/2026-11-11-app-releases-and-instances-design.md`:
- section 5 (instance hosts, `OPENROUTER_API_KEY` "from the LLM broker, capped at the plan's budget");
- 14.2 (holder settings, "kept per instance and applied on every update and rollback");
- 14.4 (deleting an App with holders);
- 14.5 (holder data stays the holder's; support access; backup download);
- section 17 (no custom domains for shared instances).

Slice scope: `docs/superpowers/plans/2026-11-12-releases-phase-3-overview.md` (slice 7; D2, D4, D5, D6). File mounts: `docs/superpowers/plans/2026-11-11-releases-phase-2-plan-4-settings.md` ("Deferred: files"). Conventions: plans 1 and 2 of phase 3 in this directory. Follow-ups: the slice 1 ledger (`vetra-cloud-package-phase3a/.superpowers/sdd/2026-11-12-releases-phase-3-plan-1/progress.md`, "Final review").

## Decisions to confirm (recommended default first; the plan is written with the default)

- **H1 Settings scopes for plan instances.** A new publisher scope `PLAN`. Shared and own instances get `ALL` **plain** settings plus every `PLAN` setting (plain, secret, file). `ALL` secrets no longer reach plan instances (they are the branch/preview instances' secrets). Existing staging plan instances roll once when this ships. Production has no plan instances.
- **H2 Holder settings override publisher settings** of the same name (or the same mount path for files). The holder's own OAuth client must be able to replace the publisher's. The publisher sees only how many holder settings an instance has, never their names.
- **H3 Holder settings are holder-only.** Only the instance's holder may list, set or delete them. Platform admins and publishers may not. Slice 9's switch-over tooling writes them through an internal function, not through GraphQL. Holder secret values are write-only for the holder too. Audit rows for holder settings carry no names (`instance.setting.changed` with `secret`, `file`, `deleted` flags).
- **H4 Custom domain, apex move.** Own instances only (spec 17). Vetra applies the domain only after DNS points at the cluster (an `A` record to the load balancer IP, or a `CNAME` to the instance's generated host). Applying it moves the host: the generated host stops serving, `PUBLIC_URL` becomes the domain (one restart), and HTTPS on the domain works once cert-manager has issued (minutes). The console says so before the click. A dual-host variant (both hosts served during issuance) needs `app.additionalIngresses` in the chart and is left for later.
- **H5 Domains refused for holders:** anything under `vetra.io` (and the staging base domain), IP literals, single labels, and domains another environment or instance holds.
- **H6 Files via `VETRA_FILES`.** One Vetra-set plain env entry lists `[{key, mountPath}]`. The processor maps it to `app.secretFiles`. No document-model change. Limits: 10 files per scope layer, 64 KiB each, absolute mount paths, not under `/data`, `/app`, `/proc`, `/sys`, `/etc`, `/var`, `/dev`, `/run`, `/tmp`.
- **H7 AI per plan.** `plans.ai_budget_usd` (null: no AI). Each shared and own instance of the plan gets its own broker key with that monthly limit (key name `instance:<instanceId>`). Licensing's invite-code budgets are not consulted for plan instances. `OPENROUTER_API_KEY` is refused as a `PLAN` publisher setting and as a holder setting while the plan has a budget (Vetra sets it); without a budget the publisher may bring their own in `PLAN` scope.
- **H8 Reporting token for own instances only.** `reportUserStat` relays only the environment's holder's stats, which a shared instance does not have.
- **H9 Notices are in-app only** (D5). Before `VETRA_APPS_PLANS_DESTROY` is ever turned on in production, the user decides whether email is required.
- **H10 Vetra wakes only what Vetra slept.** An instance found STOPPED by someone else is shown `stopped` and never marked `stopped_by_vetra`.
- **H11 Interim delete guard (PR A).** `deleteApp` refuses an App that has plan instances not removed, or live licences of a plan's kind, with a message pointing at plans. PR B replaces the refusal with the 14.4 flow.
- **H12 14.4 flow (PR B).** 30-day notice (`VETRA_APPS_APP_DELETION_NOTICE_DAYS`, 1-180). During the notice: no new licences of the App's plan kinds, no new plans, rollouts still allowed (security fixes). At the due date every chain of the App counts as ended then, and own instances take the end-of-licence path (stop after D4's days, deleted after 90 with the switch). Shared instances with no live holders are stopped at the due date and deleted with the App's last own instance (after a final backup, with the switch). The App row becomes DELETED once no plan instance is left un-removed. `cancelAppDeletion` works until the due date.
- **H13 Backups for holders (PR B).** When Vetra stops an own instance it takes a **stop backup** first. A download request takes a fresh backup when the instance runs, and serves the newest stop backup when it is stopped. Links are valid 1 hour. At most 3 requests per instance per 24 h, one in flight.
- **H14 Final backups are kept 180 days** under a bucket prefix with its own lifecycle rule (external task E2). The dumps bucket's 30-day rule must not apply to it.
- **H15 Support access (PR B).** A publisher operator or release manager requests it (hours 1-72, a reason); the holder approves or denies; the holder can revoke; one active grant per instance. It adds the requester to `ADMINS` (one restart on grant, one on expiry). Every step is audited, and the holder sees their instance's audit rows.
- **H16 Deletion after 90 days (PR B).** Behind `VETRA_APPS_PLANS_DESTROY` (default off) and `VETRA_APPS_PLAN_DESTROY_AFTER_DAYS` (default 90, 30-365). Only with a successful final (or stop) backup newer than the instance's last start. Without the switch, Vetra logs "would delete" once per instance.

## What exists today (checked 2026-11-12 on `main` = 0.0.117)

- **Settings** (`subgraphs/vetra-apps/settings/*`):
  - `app_settings (app_id, scope 'all'|'branch'|'preview', name, secret, value, ciphertext, write_id, updated_at, updated_by)`, PK `(app_id, scope, name)`, `scope varchar(16)` without a check constraint. SDL `enum AppSettingScope { ALL BRANCH PREVIEW }`; `settings/service.ts` maps it with `TO_SCOPE`/`FROM_SCOPE`/`SCOPE_ORDER`.
  - `settings/resolve.ts` `settingsForKind(rows, kind)`: `all` then the kind's own scope; for `shared`/`own` only `all` applies, **secrets included** (slice 1 follow-up). `settingsRevision(plain, secrets)` = 16 hex.
  - `settings/deliver.ts` `deliverSettings(deps, tenantId, settings, declared)`: generated keys (`VETRA_GENERATED_SECRETS`), the publisher's secrets, then **deletes every declared secret not wanted**, then `notifyTenant`.
  - `settings/names.ts`: `RESERVED_SETTING_NAMES`, `RESERVED_PREFIXES` (`VETRA_`, `NODE_`, `PG`), `checkSettingName`, `checkSettingValue`, `MAX_SETTINGS_PER_APP = 100`. `OPENROUTER_API_KEY` is allowed (phase 2 ruling: reserved for plan instances in phase 3).
  - `settings/vault.ts`: OpenBao transit pseudo-tenant `app-settings`.
  - `setAppSetting`/`deleteAppSetting` use `need: "release"` and write `setting.set`/`setting.deleted` audit rows without values.
- **Reconciler** (`instances/reconciler.ts`):
  - `reconcileApp` reads `listAppSettings` once and calls `reconcileInstance(deps, app, row, settingsForKind(settingRows, row.kind))`.
  - `adminsOf(app, row)`: the holder for own rows, else `app.owner_address`.
  - `stopPlanInstance` (line ~290): when it finds the environment STOPPED and the row not yet `stopped`, it sets `stopped_by_vetra: true` even when someone else slept it (follow-up).
  - `reconcileEnvironment` wakes a STOPPED PLAN environment with `stopped_by_vetra`; delivers settings when `settings_delivered !== settings.revision`; applies `instanceUpdateActions(state, image, admins, envSettings(settings), start, size)`; reverts the image on failure.
  - `removeInstance` throws for plan kinds ("never removed by the reconciler").
  - `INSTANCE_BASE_DOMAIN = "vetra.io"`.
- **Render** (`instances/render.ts`): `fusionEnv(image, admins, settings)` = `PH_HOST`, `ADMINS`, publisher plain, `VETRA_SETTINGS_REVISION`, then secret names (`VETRA_GENERATED_SECRETS` + publisher secrets). `instanceUpdateActions` never touches `customDomain` or `apexService`; `instanceCreateActions` sets `setApexService({type: "FUSION"})`.
- **Monitor** (`instances/monitor.ts` line ~227) probes `https://${row.host}.${INSTANCE_BASE_DOMAIN}`. A custom apex domain removes that host from routing, so the probe would fail.
- **Plans** (`plans/*`): `plans` table (no AI column), `syncPlanInstances` (stop after `VETRA_APPS_PLAN_STOP_AFTER_DAYS`, `licence_ended_at`, `stop_reason`), `plans/holder-view.ts` `myInstancesFor` (own rows by `holder_address`, shared rows by `liveKindsOfHolder`), `plans/holders.ts` (`liveChains` → `ChainHead {root, licenseId, kind, address, endAt}`, `chainEnds`).
- **Roles and audit** (slice 2): `roles/access.ts` `AppNeed = "view" | "operate" | "release" | "administer"`, `allows`; `audit/repo.ts` `AUDIT_ACTIONS` (plans, settings, roles, `instance.status`, releases), `recordAudit`, `audit/service.ts` `auditCaller(trx, caller, entry)`; `app_audit` is readable by every viewer of the App.
- **Environment document custom domains:** `SET_CUSTOM_DOMAIN {enabled, domain}` and `SET_APEX_SERVICE {type}` (`document-models/vetra-cloud-environment/v1/src/reducers/data-management.ts`, `assertOwner`; the Vetra service identity owns plan-instance documents, so the reconciler may send them). `regenerateDnsRecords` gives `A` records to `LB_IP = "138.199.129.93"` (`reducers/utils.ts`, not exported).
- **Processor** (`processors/vetra-cloud-environment/gitops.ts`): with `customDomain.enabled` and apex `FUSION`, `generateFusionBlock` serves the FUSION app at the domain only (`routedGenericHosts` drops the generated host), TLS secret `fusion-<domain-dashed>-tls`, `PUBLIC_URL = https://<domain>`, and `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` = that one host. Issuer `TENANT_CLUSTER_ISSUER` (HTTP-01 for external domains). The app block renders `secretEnv` from `<tenant>-secrets` and `additionalHosts: []`; it renders no `secretFiles`.
- **Domain checks today:** observability `setCustomDomain` (`subgraphs/vetra-cloud-observability/resolvers.ts` ~798) checks uniqueness against `environments.customDomain` (live rows) but not DNS. `domain-check.ts` has `defaultHostProbe` (`resolves`, `tls` with chain verification).
- **Directory** (`directory.ts`): `runsApp` counts linked environments other than PREVIEW, so PLAN environments count; `isCallers` keeps only environments the caller owns or whose org they belong to. Plan-instance documents are owned by the service identity, so **a holder never sees their own instance** in "Open your Sektar" (`apps/directory/v1/environments`).
- **deleteApp** (`service.ts` ~3023): deletes previews, optionally the production environment, the Harbor robot and the Renown identity, **all App settings**, and marks the App DELETED. It does not look at plan instances: their settings revision would change and they would roll without the publisher's secrets.
- **LLM broker** (`subgraphs/vetra-llm/broker.ts`): `provisionVetraKey({environmentId, ownerDid, rootLicenseId?, tenantId})`, `releaseVetraKey(environmentId)`, `keyBudget` (Studio budget, or `appBudget(rootLicenseId, did)` from the redeemed invite code), key names `studio:<env>`/`app:<env>`. `studio_llm_keys` is keyed by `environment_id`, with `root_license_id`. The sweeper (`sweeper.ts` `sweepRow`) judges a row without `root_license_id` by the **Studio** licence and would disable a plan instance's key. Licensing wires the broker in `vetra-licensing/index.ts` (~720) with `createProcessBroker`.
- **Reporting** (`subgraphs/vetra-licensing/reporting.ts`): `ensureReportingTokens(ReportingDeps, environmentIds, budget?)` writes `VETRA_REPORTING_TOKEN` and `VETRA_LICENSING_URL` to the tenant and records `environment_reporting_tokens (environment_id, token_hash)`. `relayUserStat` resolves token → environment → `envRows.byEnvironment` (`license_environments`) → chain head checks. Plan instances have no `license_environments` row.
- **Offboarding** (`vetra-licensing/offboarding.ts`): `EXPIRY_WARNING_DAYS = 7`, `STOP_AFTER_DAYS = 14`, `FINAL_WARNING_AFTER_DAYS = 83`, `DESTROY_AFTER_DAYS = 90`; `subscriptionWarnings` kinds `EXPIRING`, `ENDED_STOP_PENDING`, `STOPPED_DELETE_PENDING`, `DELETE_IMMINENT`.
- **Dumps** (`subgraphs/vetra-cloud-observability/dumps/*`): `createDumpAndJob`, `S3Helper.presignDownload` (15 min), sources `MANUAL | SCHEDULED | PRE_RESTORE`, bucket lifecycle 30 days. No `/data` archive exists until slice 4.
- **Licensing issue** (`vetra-licensing/issue.ts` `issueUnlocked`): refuses unknown/tampered Apps and inactive terms; no notion of an App being discontinued.
- **Housekeeping** sleeps only CLINT studios (`subgraphs/vetra-housekeeping/policy.ts` `isEligibleForSleep`), so a PLAN environment is slept by Vetra or by a platform admin only.
- **Test harness:** as described in plan 2 ("What exists today"): `makeHarness`, `seedActiveApp`, `testConfig({ plans: { enabled: true, stopAfterDays: 14 } })`, `instances-fixtures.ts` `seedRelease`, fake envs (`h.envs.setStatus`), licensing tables in PGlite; plan-instance tests in `__tests__/instances-plans.test.ts`, `plans-holders.test.ts`, `plans-holder-view.test.ts`.

## Model (as built here)

**`app_settings.scope`** gains `plan` (SDL `PLAN`).

**`instance_settings`** (new; holder settings of own instances)

| Column | Meaning |
|---|---|
| `instance_id` | the own instance (PK part) |
| `name` | env name, or for files `FILE_<16 hex of sha256(mountPath)>` (PK part) |
| `kind` | `plain` \| `secret` \| `file` |
| `mount_path` | files only |
| `value` | plain only |
| `ciphertext` | secrets and files (transit pseudo-tenant `instance-settings`) |
| `write_id` | new id per write (the revision uses it for secrets and files) |
| `updated_at`, `updated_by` | ISO, lowercased address |

At most 50 rows per instance.

**`app_settings`** gains `mount_path varchar(512) null` and its `secret` stays true for files; a file row is `secret = true, mount_path not null` (publisher files, H6). Name `FILE_<16 hex>` is derived, never typed.

**`instances`** gains:

| Column | Meaning |
|---|---|
| `custom_domain` | lowercased domain, unique where not null (`instances_custom_domain_uq`) |
| `custom_domain_status` | `dns` \| `issuing` \| `active` \| `failed` \| null |
| `custom_domain_reason` | why `failed` or what `dns` waits for |
| `custom_domain_since` | when the status last changed |
| `stopped_at` | when Vetra last stopped it (stop backups and destroy) — PR B |

**`plans`** gains `ai_budget_usd double precision null`.

**`studio_llm_keys`** (vetra-llm) gains `instance_id varchar(64) null`: set for a plan instance's key.

**PR B tables:** `instance_backup_requests`, `instance_support_grants`, and `apps` columns `deletion_requested_at`, `deletion_requested_by`, `deletion_due_at` (Tasks 15-18).

**Audit actions added** (`AUDIT_ACTIONS`): `instance.setting.changed`, `instance.domain` (requested/applied/active/failed/removed in `detail.step`), `support.requested`, `support.granted`, `support.denied`, `support.revoked`, `support.expired`, `instance.backup.requested`, `instance.destroyed`, `app.deletion_scheduled`, `app.deletion_cancelled`. Holder actions are recorded with the holder as actor and subject `instance:<id>`.

## Global Constraints

- Additive schema only, through idempotent, race-tolerant `ensure…` migrations (schema builder, `ifNotExists`, `isConcurrentIndexError` tolerated). No column is dropped or retyped.
- Branch and preview instances render exactly as today except where a task says so (Task 1 changes nothing for them; tested by the existing `instances-settings.test.ts` and `instances-render.test.ts` staying green).
- Licensed environments are never touched: every document write goes through `instanceUpdateActions` (which throws for `managedBy`) or a helper with the same guard (`domainActions`, Task 8).
- No setting value, secret, ciphertext, token, file content or key reaches a log line or `app_audit`. Holder setting names do not reach `app_audit` either (H3).
- Holder APIs refuse while `VETRA_APPS_PLANS` is off (`SERVICE_NOT_CONFIGURED`, as `createPlan`).
- No new behaviour that deletes data runs without its switch: destroy needs `VETRA_APPS_PLANS_DESTROY=on` (default off).
- Commits: one per task (a task with several commits says so), conventional (`feat(settings): …`, `feat(instances): …`, `feat(holders): …`, `feat(domains): …`, `feat(llm): …`, `feat(apps): …`, `fix(instances): …`), trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. PR A branch `feat/releases-phase-3-holders` from `main`; PR B branch `feat/releases-phase-3-holders-b` from `main` after PR A merged.
- Checks after every task: `npx vitest run <the task's test files> 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. At the end of each PR: `npm run tsc 2>&1 | tail -20`, `npm run lint 2>&1 | grep -E "error|✖" | head -20`, `npx vitest run subgraphs/vetra-apps subgraphs/vetra-llm subgraphs/vetra-licensing processors shared 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`.
- No production pin while a Sektar gated rollout is APPLYING (overview rule 4): `vetraReleases.rollouts(appId: "43622402-be06-435a-bbfa-bb649b0d6244")` first.
- Never `git stash`; never touch other worktrees (`git worktree list`).

## File structure

| File | Change | Task |
|---|---|---|
| `subgraphs/vetra-apps/db/schema.ts` | `AppSettingScope` + `plan`; `AppSettingsTable.mount_path`; `InstanceSettingsTable`; `InstancesTable.custom_domain*`, `stopped_at`; `PlansTable.ai_budget_usd`; PR B tables | 1, 2, 7, 9, 10, 15-18 |
| `subgraphs/vetra-apps/db/migrations.ts` | `ensureSettingsMountPath`, `ensureInstanceSettingsTable`, `ensureInstanceDomainColumns`, `ensurePlanAiBudget`, PR B `ensure…` | same |
| `subgraphs/vetra-apps/settings/resolve.ts` | `settingsForInstance(appRows, holderRows, row, vetra)`; `InstanceSettings.files`, `.vetraSecrets` | 1, 2, 4, 9 |
| `subgraphs/vetra-apps/settings/names.ts` | `PLAN` reservations, file checks (`checkMountPath`, `fileKey`), `VETRA_FILES_ENV`, `VETRA_INSTANCE_SECRETS` | 1, 9, 10, 11 |
| `subgraphs/vetra-apps/settings/service.ts` | scope `PLAN`, `mountPath` input | 1, 9 |
| `subgraphs/vetra-apps/settings/holder-repo.ts` (new) | `instance_settings` reads and writes | 2 |
| `subgraphs/vetra-apps/settings/holder-service.ts` (new) | `myInstanceSettingsFor`, `setMyInstanceSetting`, `deleteMyInstanceSetting`, `importHolderSettings` (internal, slice 9) | 3 |
| `subgraphs/vetra-apps/settings/deliver.ts` | wanted = generated + Vetra per-instance + settings secrets + files | 4, 9 |
| `subgraphs/vetra-apps/holders/access.ts` (new) | `loadOwnInstanceForHolder` | 3 |
| `subgraphs/vetra-apps/instances/render.ts` | `fusionEnv` with `vetraSecrets` and `VETRA_FILES`; `domainActions` | 4, 8, 9 |
| `subgraphs/vetra-apps/instances/reconciler.ts` | per-instance settings; `stopped_by_vetra` fix; domain apply and drift repair; AI key and reporting token; `adminsOf` + support | 4, 5, 8, 10, 11, 16 |
| `subgraphs/vetra-apps/instances/public-host.ts` (new) | `publicHostOf(row)`, `publicUrlOf(row)` | 6 |
| `subgraphs/vetra-apps/instances/monitor.ts` | probe `publicHostOf` | 8 |
| `subgraphs/vetra-apps/instances/service.ts`, `plans/holder-view.ts` | URLs via `publicUrlOf`; holder fields and notices | 6, 12 |
| `subgraphs/vetra-apps/directory.ts`, `index.ts` | holders' plan instances in the directory | 6 |
| `subgraphs/vetra-apps/domains/*.ts` (new) | `validateDomain`, `dnsReady`, `domainService`, `checkDomainsOnce` | 7, 8 |
| `subgraphs/vetra-cloud-observability/resolvers.ts` | `setCustomDomain` also refuses a domain an instance holds | 7 |
| `processors/vetra-cloud-environment/gitops.ts` | `VETRA_FILES` → `app.secretFiles` | 9 |
| `subgraphs/vetra-apps/plans/*` | `aiBudgetUsd` on create/update/JSON | 10 |
| `subgraphs/vetra-llm/{broker,sweeper,store,db/*}.ts` | instance keys (`instance:<id>`, fixed budget) | 10 |
| `subgraphs/vetra-apps/instances/vetra-secrets.ts` (new) | AI key and reporting token per instance | 10, 11 |
| `subgraphs/vetra-licensing/reporting.ts` | relay through plan instances | 11 |
| `subgraphs/vetra-apps/holders/notices.ts` (new) | `holderNotices` (pure) | 12 |
| `subgraphs/vetra-apps/service.ts` | interim delete guard; PR B scheduled deletion | 13, 18 |
| `subgraphs/vetra-apps/backups/*.ts` (new, PR B) | `InstanceBackups` port, stub, requests | 15 |
| `subgraphs/vetra-apps/support/*.ts` (new, PR B) | support grants | 16 |
| `subgraphs/vetra-apps/plans/sync.ts`, `instances/reconciler.ts` (PR B) | destroy after 90 days | 17 |
| `subgraphs/vetra-apps/schema.ts`, `resolvers.ts` | GraphQL per task | each |
| `subgraphs/vetra-apps/audit/repo.ts` | new actions | 3, 8, 15-18 |

---

## PR A — essential for slice 9

### Task 0: Pre-flight (no code) [essential]

- [ ] **Step 1: Branch.** `git fetch && git checkout -b feat/releases-phase-3-holders origin/main`. Never stash, never touch other worktrees.
- [ ] **Step 2: Baseline.** `npx vitest run subgraphs/vetra-apps subgraphs/vetra-llm subgraphs/vetra-licensing processors shared 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Record pre-existing failures (known: `studio-access-factory`) for the PR description.
- [ ] **Step 3: Check what landed since this plan.** If slices 3-6 merged first, re-read `instances/reconciler.ts` `reconcileEnvironment`, `adminsOf` and `settings/resolve.ts` and adapt line references. If slice 3 added `rollout_steps`, holder settings must also be part of what a rollout step's revert keeps (Task 4 Step 6).

---

### Task 1: Publisher scope `PLAN`; `ALL` secrets off plan instances [essential]

Folds in the slice 1 follow-up "plan instances get scope ALL settings incl. publisher secrets".

**Files:**
- Modify: `subgraphs/vetra-apps/db/schema.ts`, `settings/resolve.ts`, `settings/service.ts`, `settings/names.ts`, `schema.ts` (SDL)
- Test: `subgraphs/vetra-apps/__tests__/settings-resolve.test.ts`, `settings-api.test.ts`

**Interfaces:**
- `AppSettingScope = "all" | "branch" | "preview" | "plan"`; `AppSettingScopeName` + `"PLAN"`; `SCOPE_ORDER.plan = 3`. No migration (`scope varchar(16)`, no constraint).
- `settingsForKind(rows, kind)` keeps its signature (Task 2 wraps it). New rule:

```ts
/**
 * branch/preview: "all", then the kind's own scope (unchanged).
 * shared/own (plan instances, H1): "all" plain settings only, then "plan".
 * Publisher secrets meant for customers' instances must be scoped PLAN.
 */
export function settingsForKind(rows: AppSettingRow[], kind: InstanceKind): InstanceSettings {
  const plan = kind === "shared" || kind === "own";
  const own: AppSettingScope = plan ? "plan" : kind;
  const chosen = new Map<string, AppSettingRow>();
  for (const r of rows)
    if (r.scope === "all" && !(plan && r.secret)) chosen.set(r.name, r);
  for (const r of rows) if (r.scope === own) chosen.set(r.name, r);
  // …rest unchanged
}
```

- `checkSettingName(name, scope)`: in scope `plan`, `OPENROUTER_API_KEY` is refused when any active plan of the App has `ai_budget_usd` (the service checks it, Task 10 adds the column; until then the check is a no-op function `planReservedNames(app)` returning `[]`).

- [ ] **Step 1: Failing tests** in `settings-resolve.test.ts`:
  - `own` with an `all` secret `TOKEN` and an `all` plain `MODE`: plain has `MODE`, secrets are empty;
  - `own` with `plan` secret `TOKEN`: delivered; `plan` plain `MODE=b` wins over `all` `MODE=a`;
  - `shared` behaves as `own`;
  - `branch` still gets the `all` secret and ignores `plan` rows; `preview` likewise;
  - the revision of a branch instance is unchanged by adding a `plan` row.
- [ ] **Step 2: Run** (FAIL), **implement**, **run** (PASS).
- [ ] **Step 3: API test** in `settings-api.test.ts`: `setAppSetting({…, scope: "PLAN"})` stores scope `plan`, lists as `PLAN`, `deleteAppSetting(appId, name, "PLAN")` deletes only that row; audit subject `setting:PLAN/<name>`.
- [ ] **Step 4: SDL.** `enum AppSettingScope { ALL BRANCH PREVIEW PLAN }`, with the doc string "PLAN: shared and own instances (customers). ALL secrets do not reach them." Run `resolvers.test.ts` (SDL check).
- [ ] **Step 5: Commit.** `feat(settings): PLAN scope; publisher secrets reach plan instances only when scoped PLAN`.

---

### Task 2: `instance_settings` and per-instance resolution [essential]

**Files:**
- Modify: `db/schema.ts`, `db/migrations.ts`, `settings/resolve.ts`
- Create: `settings/holder-repo.ts`
- Test: `__tests__/migrations.test.ts`, `settings-resolve.test.ts`

**Interfaces:**
- Schema: `InstanceSettingKind = "plain" | "secret" | "file"`; `InstanceSettingsTable` (Model); `VetraAppsDB.instance_settings`.
- Migration `ensureInstanceSettingsTable(db)`: PK `(instance_id, name)`, index `instance_settings_instance_idx (instance_id)`. Called at the end of `up`.
- `holder-repo.ts`: `listInstanceSettings(db, instanceIds: string[]): Promise<Map<string, InstanceSettingRow[]>>` (one query per pass), `upsertInstanceSetting(db, row)`, `deleteInstanceSetting(db, instanceId, name): Promise<boolean>`, `deleteInstanceSettings(db, instanceId): Promise<number>`, `countInstanceSettings(db, instanceId)`.
- `resolve.ts`:

```ts
export interface ResolvedFile { key: string; mountPath: string; ciphertext: string; writeId: string }

export interface InstanceSettings {
  revision: string;
  plain: Array<{ name: string; value: string }>;
  secrets: ResolvedSecret[];
  /** Files (Task 9): tenant secret key + mount path. */
  files: ResolvedFile[];
  /** Secret names Vetra writes by other paths (AI key, reporting token: Tasks 10, 11). Declared, never deleted. */
  vetraSecrets: string[];
  /** Holder settings in effect (count only, for the publisher view, H2). */
  holderCount: number;
}

/** App layers (settingsForKind) then the holder's (own instances, H2: the holder wins by name). */
export function settingsForInstance(
  appRows: AppSettingRow[],
  holderRows: InstanceSettingRow[],
  kind: InstanceKind,
  vetraSecrets: string[] = [],
): InstanceSettings;
```

  The revision document becomes `["v2", plain, secrets(name, writeId), files(key, mountPath, writeId), vetraSecrets(sorted names)]`. **Compatibility:** with no files, no holder rows and no Vetra secrets the function emits the `v1` document, so every running branch and preview instance keeps its revision (no mass roll). Test it.

- [ ] **Step 1: Migration test** (`migrations.test.ts`): `up` twice is idempotent; the table and index exist.
- [ ] **Step 2: Resolution tests:**
  - holder plain `MODE=h` over `plan` `MODE=p`;
  - holder secret replaces a publisher plain of the same name (one entry, a secret);
  - holder rows are ignored for `shared`, `branch`, `preview` (only own instances have holders);
  - `v1` revision unchanged without the new layers (compare with `settingsRevision(plain, secrets)`);
  - the revision changes when a holder secret's `write_id` changes.
- [ ] **Step 3: Implement**, run, **commit** `feat(settings): holder settings table and per-instance resolution`.

---

### Task 3: Holder access and the holder settings API [essential]

**Files:**
- Create: `holders/access.ts`, `settings/holder-service.ts`
- Modify: `settings/vault.ts` (second pseudo-tenant), `audit/repo.ts`, `schema.ts`, `resolvers.ts`, `service.ts` (`AppsDeps.holderVault`), `index.ts`
- Test: `__tests__/holders-settings.test.ts` (new)

**Interfaces:**
- `holders/access.ts`:

```ts
/**
 * The caller's own instance (spec 14.5): kind own, holder_address = caller,
 * not removed, its App not DELETED. Holder-only (H3): no platform-admin or
 * publisher bypass. NOT_FOUND for anything else (never "exists but not yours").
 * SERVICE_NOT_CONFIGURED while plans are off.
 */
export async function loadOwnInstanceForHolder(
  deps: AppsDeps, caller: Caller, instanceId: string,
): Promise<{ row: InstanceRow; app: AppRow; plan: PlanRow }>;
```

  A CI bearer or App key is refused like `requireCaller` does (`assertNotWorkload`).
- `settings/vault.ts`: `INSTANCE_SETTINGS_TRANSIT_TENANT = "instance-settings"`; `createSettingsVault(transit, tenant = APP_SETTINGS_TRANSIT_TENANT)`. `AppsDeps.holderVault?: SettingsVault | null`, wired in `index.ts` next to `settingsVault`.
- `holder-service.ts`:
  - `myInstanceSettingsFor(deps, caller, instanceId) → { settings: HolderSettingJson[]; vetra: VetraSetting[]; publisherNames: string[]; reservedNames; reservedPrefixes }`. `HolderSettingJson { name, kind: PLAIN|SECRET|FILE, value (plain only), mountPath (files), updatedAt }`. `publisherNames` = names the publisher sets for this instance (so the console can warn "you override the App's setting"; the values are not shown, H2).
  - `setMyInstanceSetting(deps, caller, { instanceId, name?, value, kind, mountPath? })`: `checkSettingName` (+ `OPENROUTER_API_KEY` refused when the plan has an AI budget, Task 10), `checkSettingValue`; files: Task 9 adds `checkMountPath` and derives `name`. Encrypt secrets/files with `holderVault`. Under a `FOR UPDATE` lock of the instance row: cap 50, upsert, audit `instance.setting.changed` `{secret, file, deleted: false, replaced}` (no name, H3).
  - `deleteMyInstanceSetting(deps, caller, instanceId, name) → Boolean`, audited `{deleted: true}` only when a row went.
  - `importHolderSettings(deps, instanceId, rows: Array<{name, kind, value, mountPath?}>, actor)` (internal, no GraphQL): slice 9 copies a licensed environment's holder-set FUSION env entries with it. Same checks; names that fail them are returned as `skipped` with the reason, never thrown, so one odd entry does not block a switch-over.
- SDL:

```graphql
enum HolderSettingKind { PLAIN SECRET FILE }
type HolderSetting { name: String! kind: HolderSettingKind! value: String mountPath: String updatedAt: String! }
type HolderSettings {
  settings: [HolderSetting!]!
  vetra: [VetraSetting!]!
  "Names the App's publisher sets on this instance; a holder setting of the same name replaces it."
  publisherNames: [String!]!
  reservedNames: [String!]!
  reservedPrefixes: [String!]!
}
input SetHolderSettingInput { instanceId: ID! name: String kind: HolderSettingKind! value: String! mountPath: String }
extend type Query { myInstanceSettings(instanceId: ID!): HolderSettings! }
extend type Mutation {
  setMyInstanceSetting(input: SetHolderSettingInput!): HolderSetting!
  deleteMyInstanceSetting(instanceId: ID!, name: String!): Boolean!
}
```

- [ ] **Step 1: Failing tests** (`holders-settings.test.ts`, harness with plans on, an own plan, a grant to `HOLDER`, one sync so the own row exists):
  - the holder sets `GOOGLE_CLIENT_ID` (plain) and `GOOGLE_CLIENT_SECRET` (secret): listed, the secret's value is null, the stored ciphertext is not the value;
  - the App owner, a release manager, a platform admin and a stranger each get NOT_FOUND for list, set and delete;
  - a shared instance id → NOT_FOUND; a removed own row → NOT_FOUND; plans off → SERVICE_NOT_CONFIGURED;
  - reserved names (`ADMINS`, `VETRA_X`, `PH_HOST`) → BAD_USER_INPUT;
  - the 51st setting → BAD_USER_INPUT;
  - audit: one `instance.setting.changed` row per write, actor = holder, subject `instance:<id>`, and `JSON.stringify(row)` contains neither the name nor the value;
  - `appSettings(appId)` for the publisher is unchanged (holder rows never appear);
  - `importHolderSettings` skips `ADMINS` with a reason and stores the rest.
- [ ] **Step 2: Implement**, add the actions to `AUDIT_ACTIONS`, wire GraphQL with `guard(deps, name, …)` and `requireCaller(ctx)`.
- [ ] **Step 3: Run** the new test and `resolvers.test.ts`. **Commit** `feat(holders): holder settings on own instances (holder-only, write-only secrets)`.

---

### Task 4: The reconciler applies holder settings on every update and rollback [essential]

**Files:**
- Modify: `instances/reconciler.ts`, `instances/render.ts`, `settings/deliver.ts`, `instances/service.ts`
- Test: `__tests__/instances-settings.test.ts`, `instances-plans.test.ts`, `instances-render.test.ts`

**Interfaces:**
- `reconcileApp`: after `listInstances`, `const holder = await listInstanceSettings(deps.db, rows.filter(r => r.kind === "own").map(r => r.id))`, and per row `settingsForInstance(settingRows, holder.get(row.id) ?? [], row.kind, vetraSecretsOf(app, row, plan))` (`vetraSecretsOf` returns `[]` until Tasks 10 and 11).
- `deliverSettings(deps, tenantId, settings, declared)`: holder secrets are decrypted with `deps.holderVault`, publisher secrets with `deps.settingsVault`. `ResolvedSecret` gains `vault: "app" | "holder"`. `wanted` = generated + `settings.vetraSecrets` + secrets + file keys. **Vetra secrets are never written or deleted here.**
- `fusionEnv(image, admins, settings)`: secret names = generated + `vetraSecrets` + secrets (fixed order: generated, Vetra, settings, each sorted), so `sameEnv` is stable.
- `instanceJson`: `holderSettingsCount` (from `settings.holderCount` is not available there; use a `count` from `instance_settings` in `appInstancesFor`, one grouped query).

- [ ] **Step 1: Failing tests** (`instances-settings.test.ts` style, fake secrets store):
  - an own instance with a holder secret: the tenant gets it, the document declares its name, `VETRA_SETTINGS_REVISION` changes, the instance goes `updating` → `ready`;
  - the publisher changes a `PLAN` plain setting: the holder's override of the same name stays in effect (document value is the holder's);
  - the holder deletes their secret: the tenant secret is deleted on the next delivery and the document no longer declares it;
  - **rollback keeps holder settings:** a target digest that fails health reverts the image (`revertImage`) and the document keeps the holder's env (assert the reverted `SET_FUSION_CONFIG` env contains the holder entries);
  - a declared Vetra secret (pass `vetraSecrets: ["OPENROUTER_API_KEY"]`) is neither deleted nor rewritten by `deliverSettings`;
  - a branch instance's revision and document are byte-identical to before (golden from the existing test).
- [ ] **Step 2: Implement**, run the three test files, **commit** `feat(instances): apply holder settings on every update and rollback`.
- [ ] **Step 3 (only if slice 3 is merged):** a rollout step's revert uses the same `settings` object; add one test in the rollout tests that a rolled-back step keeps holder settings.

---

### Task 5: Vetra wakes only what it slept [essential]

Folds in "a holder-slept PLAN env may be marked `stopped_by_vetra`" (`reconciler.ts` ~323-330).

**Files:** Modify `instances/reconciler.ts`. Test `__tests__/instances-plans.test.ts`.

- [ ] **Step 1: Failing tests:**
  - an own instance whose licence ends: Vetra sleeps it → `stopped_by_vetra = true` (unchanged);
  - an own instance with `stop_reason` set whose environment is **already** STOPPED (someone else slept it): the row becomes `stopped` with the reason, `stopped_by_vetra` stays **false**; after renewal the reconciler does **not** wake it, and the row shows `stopped` with reason `stopped outside Vetra; start it from the console` (constant `STOPPED_OUTSIDE_VETRA`);
  - an instance without `stop_reason` found STOPPED: no flag change (unchanged).
- [ ] **Step 2: Implement.** In `stopPlanInstance`'s `STOPPED` branch drop the `stopped_by_vetra: true` spread. In `reconcileEnvironment`, a STOPPED PLAN environment without `stopped_by_vetra` and with no pending changes patches `status: "stopped", reason: STOPPED_OUTSIDE_VETRA` once. (`instanceUpdateActions` still wakes it when a target or settings change requires an update: a rollout is Vetra's decision.)
- [ ] **Step 3: Commit** `fix(instances): only wake plan instances Vetra stopped`.

---

### Task 6: Public URL and the directory for holders [essential]

Folds in "`directory.ts` `runsApp` counts PLAN envs". Holders must find their instance from the App's own site ("Open your Sektar") after the switch-over.

**Files:**
- Create: `instances/public-host.ts`
- Modify: `instances/service.ts`, `plans/holder-view.ts`, `directory.ts`, `index.ts`
- Test: `__tests__/directory.test.ts`, `plans-holder-view.test.ts`

**Interfaces:**

```ts
/** The host a person opens: the custom domain once active (Task 8), else the generated host. */
export const publicHostOf = (r: Pick<InstanceRow, "host" | "custom_domain" | "custom_domain_status">) =>
  r.custom_domain && r.custom_domain_status === "active"
    ? r.custom_domain
    : r.host ? `${r.host}.${INSTANCE_BASE_DOMAIN}` : null;
export const publicUrlOf = (r) => { const h = publicHostOf(r); return h ? `https://${h}` : null; };
```

- `DirectoryDeps.holderInstances?(appId, address): Promise<Array<{ environmentId, name, url, status }>>` — own rows with `holder_address = address`, plus shared rows of plans whose kind the address holds live (reuse `liveKindsOfHolder`), not removed, with an environment. `listDirectory` appends them (de-duplicated by environment id) after the existing owner/org rows. `runsApp` gains `&& row.appRole !== "PLAN"` for the owner path, so a PLAN environment is listed **only** through `holderInstances` (never to its service owner or an org member by accident).
- `myInstancesFor` and `instanceJson` use `publicUrlOf`.

- [ ] **Step 1: Failing tests:**
  - `directory.test.ts`: a PLAN environment linked to the App is not listed for the App's owner; it is listed for its holder with the instance URL and status; a shared instance is listed for a live holder of the plan's kind and not for a lapsed one;
  - `plans-holder-view.test.ts`: with `custom_domain_status = "active"` the URL is `https://<domain>`; with `dns`/`issuing` it is the generated host.
- [ ] **Step 2: Implement** (in `index.ts`, `holderInstances` is built from `deps` when `licensingDb` exists).
- [ ] **Step 3: Commit** `feat(holders): holders find their plan instances in the App directory`.

---

### Task 7: Custom domains — columns, validation, uniqueness [essential]

**Files:**
- Create: `domains/validate.ts`
- Modify: `db/schema.ts`, `db/migrations.ts`, `document-models/vetra-cloud-environment/v1/src/reducers/utils.ts` (export `LB_IP` as `INGRESS_IP`), `subgraphs/vetra-cloud-observability/resolvers.ts`, `index.ts` (dep `customDomainUsed`)
- Test: `__tests__/domains-validate.test.ts` (new), `migrations.test.ts`, observability `__tests__/schema.test.ts` or the existing `setCustomDomain` test file

**Interfaces:**
- Migration `ensureInstanceDomainColumns`: the four columns, unique partial index `instances_custom_domain_uq ON instances (custom_domain) WHERE custom_domain IS NOT NULL`.
- `validateDomain(input: string, cfg): { domain: string } | { error: string }`: trims, lowercases, strips one trailing dot; IDNA via `domainToASCII` (`node:url`); refuses: empty, > 253, labels > 63 or not `[a-z0-9-]` (no leading/trailing `-`), fewer than two labels, IP literals, `localhost`, anything equal to or under `vetra.io`, `cfg.instances.labelSuffix` base domains, and `staging.vetra.io` (H5).
- `AppsDeps.customDomainUsed?(domain, exceptEnvironmentId: string | null): Promise<boolean>` — `environments.customDomain = domain` and status not TERMINATING/DESTROYED/ARCHIVED (same rule as observability), from `envReadModel`.
- Observability `setCustomDomain` gains a check against `instances.custom_domain` (a new optional dep `instanceDomainUsed(domain)` built from the vetra-apps namespace in `vetra-cloud-observability/index.ts`; absent → skip) → `DOMAIN_TAKEN`.

- [ ] **Step 1: Failing tests** for `validateDomain` (table-driven: `Example.COM.` → `example.com`; `app.sektar.io` ok; `xn--` IDN ok; `foo.vetra.io`, `vetra.io`, `1.2.3.4`, `localhost`, `a`, `-a.com`, 254 chars → errors).
- [ ] **Step 2: Migration test**, observability test (an instance holding `a.example.com` → `DOMAIN_TAKEN` on an environment).
- [ ] **Step 3: Implement**, **commit** `feat(domains): custom domain columns, validation and cross-model uniqueness`.

---

### Task 8: Custom domains — request, DNS check, apply, certificate, move [essential]

**Files:**
- Create: `domains/dns.ts`, `domains/service.ts`
- Modify: `instances/render.ts` (`domainActions`), `instances/reconciler.ts`, `instances/monitor.ts`, `audit/repo.ts`, `schema.ts`, `resolvers.ts`, `index.ts`
- Test: `__tests__/domains-flow.test.ts` (new), `instances-health.test.ts`

**Interfaces:**
- `domains/dns.ts`:

```ts
export interface DomainProbe {
  /** A records of the name (CNAMEs followed by the resolver). */
  a(host: string): Promise<string[]>;
  /** Chain-verified TLS at the host (domain-check.ts defaultHostProbe.tls). */
  tls(host: string): Promise<{ valid: boolean; expiresAt: Date | null }>;
}
/** DNS is ready when every A record of the domain is the ingress IP (a stray record would break HTTP-01). */
export function dnsReady(records: string[], ingressIp: string): { ready: boolean; reason: string | null };
```

  `AppsDeps.domainProbe?: DomainProbe | null` (production: `resolve4` + `defaultHostProbe.tls`).
- `domains/service.ts`:
  - `setMyInstanceCustomDomain(deps, caller, instanceId, domain)` — holder-only (`loadOwnInstanceForHolder`); `validateDomain`; free in `instances` (unique index; 23505 → BAD_USER_INPUT "taken") and `customDomainUsed(domain, row.environment_id)`; sets `custom_domain`, status `dns`, reason "point an A record at <ip> (or a CNAME at <host>.vetra.io)"; audit `instance.domain {step: "requested"}` (the domain is the holder's public name, so it is recorded). Replacing an active domain is "remove, then set" in one call (status back to `dns`).
  - `removeMyInstanceCustomDomain(deps, caller, instanceId)` — clears the columns; the reconciler removes it from the document (drift repair below); audit `{step: "removed"}`.
  - `customDomainInstructions(row)` → `{ records: [{type: "A", host, value}], alternative: {type: "CNAME", host, value: "<host>.vetra.io"} }` (apex domains cannot use the CNAME; the console says so).
  - `moveCustomDomainToInstance(deps, caller, { fromEnvironmentId, instanceId })` — **platform admins only**, for slice 9: clears `SET_CUSTOM_DOMAIN` on the old (licensed, stopped) environment through the observability dispatch path, then sets the domain on the instance with status `issuing` directly (its DNS already points at the cluster). Audited `{step: "moved", from}`.
  - `checkDomainsOnce(deps)` (every 60 s, `every(60_000, "custom domains", …)`, only with plans on): for rows with status `dns`: `dnsReady(await probe.a(domain))` → status `issuing` (the reconciler applies it) or keep `dns` with the reason; give up after 7 days → `failed` "DNS never pointed at Vetra". For `issuing`: `probe.tls(domain).valid` → `active` (audit `{step: "active"}`); after 60 minutes → `failed` with "no certificate yet: check that nothing else (a CDN proxy, CAA records) answers for the domain"; a `failed` row whose TLS later turns valid becomes `active`. For `active`: once a day, a TLS check failing three times in a row records `custom_domain_reason` (stays `active`; health reports it).
- `instances/render.ts`:

```ts
/** SET_CUSTOM_DOMAIN/SET_APEX_SERVICE to bring a PLAN document to `domain` (null: none). Same guard as instanceUpdateActions. */
export function domainActions(state: VetraCloudEnvironmentState, domain: string | null): Action[];
```

  Throws for `managedBy` and for anything that is not `state.app?.role === "PLAN"`. Returns `[]` when `state.customDomain` already matches (`enabled` and `domain`), and keeps `apexService = FUSION`.
- Reconciler (in `reconcileEnvironment`, after the settings delivery, before `instanceUpdateActions`): `want = row.custom_domain_status === "issuing" || row.custom_domain_status === "active" || row.custom_domain_status === "failed" ? row.custom_domain : null`; apply `domainActions(state, want)` when non-empty (with a wake first when STOPPED is **not** done: a stopped instance gets the domain on its next start, as other changes). This is also the drift repair for a re-created environment.
- Monitor: probe `https://${publicHostOf(row)}`; while `custom_domain_status === "issuing"` skip the HTTP probes and use the cluster verdict with reason "certificate being issued for <domain>" (no false "failed").

- [ ] **Step 1: Failing tests** (`domains-flow.test.ts`, fake probe, fake envs):
  - holder requests `app.acme.io` → `dns`; probe returns `["9.9.9.9"]` → stays `dns` with a reason naming the wrong IP; returns `[INGRESS_IP]` → `issuing`; the next reconcile sends `SET_CUSTOM_DOMAIN {enabled: true, domain}` and no `SET_APEX_SERVICE` change (already FUSION); TLS valid → `active`; `myInstances` URL is the domain;
  - another holder requesting the same domain → BAD_USER_INPUT; an environment already holding it → BAD_USER_INPUT;
  - remove → the next reconcile sends `SET_CUSTOM_DOMAIN {enabled: false, domain: null}`;
  - the environment is re-created (fake: document without `customDomain`) → the domain is re-applied;
  - `domainActions` throws on a `managedBy` document and on a PREVIEW document;
  - `moveCustomDomainToInstance` as a non-admin → FORBIDDEN; as admin → old environment cleared first, instance `issuing`;
  - a shared instance → NOT_FOUND (H4, spec 17);
  - the 60-minute issuing timeout → `failed`, and a later valid TLS → `active`.
- [ ] **Step 2: Monitor test** (`instances-health.test.ts`): `issuing` skips probes with the reason; `active` probes the domain.
- [ ] **Step 3: SDL.**

```graphql
enum CustomDomainStatus { DNS ISSUING ACTIVE FAILED }
type DnsRecordHint { type: String! host: String! value: String! }
type InstanceCustomDomain { domain: String! status: CustomDomainStatus! reason: String since: String records: [DnsRecordHint!]! alternative: DnsRecordHint }
extend type HolderInstance { customDomain: InstanceCustomDomain }
extend type AppInstance { customDomain: InstanceCustomDomain }
extend type Mutation {
  setMyInstanceCustomDomain(instanceId: ID!, domain: String!): InstanceCustomDomain!
  removeMyInstanceCustomDomain(instanceId: ID!): Boolean!
  "Platform admins: slice 9 moves a licensed environment's domain to the holder's instance."
  moveCustomDomainToInstance(fromEnvironmentId: ID!, instanceId: ID!): InstanceCustomDomain!
}
```

- [ ] **Step 4: Implement, run, commit** (two commits: `feat(domains): holder custom domains with DNS and certificate checks`, `feat(instances): apply custom domains and probe the public host`).

---

### Task 9: File settings (Vetra side) [essential; renders only once E1 is deployed]

Sektar's Google OAuth client JSON at `/client_secret_sektar-web-app.json` is a publisher file (scope `PLAN`); a holder's own OAuth client is a holder file at the same path (H2).

**Files:**
- Modify: `settings/names.ts`, `settings/service.ts`, `settings/holder-service.ts`, `settings/resolve.ts`, `settings/deliver.ts`, `instances/render.ts`, `db/schema.ts`, `db/migrations.ts`, `schema.ts`, `processors/vetra-cloud-environment/gitops.ts`
- Test: `settings-api.test.ts`, `holders-settings.test.ts`, `instances-settings.test.ts`, `processors/vetra-cloud-environment/fusion.test.ts`

**Interfaces:**
- `names.ts`:

```ts
export const VETRA_FILES_ENV = "VETRA_FILES";
export const MAX_FILES = 10;
export const MAX_FILE_BYTES = 65536;
const FORBIDDEN_ROOTS = ["/data", "/app", "/proc", "/sys", "/etc", "/var", "/dev", "/run", "/tmp"];
/** Tenant secret key of a file: FILE_<16 hex of sha256(mountPath)>. */
export const fileKey = (mountPath: string) =>
  `FILE_${createHash("sha256").update(mountPath).digest("hex").slice(0, 16).toUpperCase()}`;
/** Absolute, normalised (no //, ., ..), ≤ 512 chars, [A-Za-z0-9._/-], not under FORBIDDEN_ROOTS, not "/". */
export function checkMountPath(p: string): void;
```

  `VETRA_FILES` is covered by the `VETRA_` prefix already. `FILE_` becomes a reserved prefix for typed names.
- `app_settings.mount_path` (migration `ensureSettingsMountPath`). `SetAppSettingInput.mountPath?`: when set, `secret` is forced true, `name = fileKey(mountPath)`, value limit 64 KiB, at most `MAX_FILES` file rows per scope. Files are allowed in every scope (branch/preview instances get them too once E1 is live).
- `InstanceSettings.files` (Task 2) filled from both layers, the holder's winning by `mountPath`.
- `fusionEnv`: when `files.length > 0`, a plain entry `VETRA_FILES = JSON.stringify(files.map(f => ({key: f.key, mountPath: f.mountPath})).sort(by mountPath))` before `VETRA_SETTINGS_REVISION`. File keys are **not** declared as secret env entries (they must not become env vars).
- `deliverSettings`: writes file contents as tenant secrets under their keys; `wanted` includes them; the declared list for deletions = `declaredSecretNames(state)` + keys in the document's current `VETRA_FILES`.
- Processor `generateFusionBlock`: when the env has a parseable `VETRA_FILES` (array of `{key, mountPath}` with `key` matching `^FILE_[0-9A-F]{16}$` and an absolute `mountPath`; anything else is logged and ignored), render

```yaml
  secretFiles:
    - name: "<key>"
      secretName: <tenant>-secrets
      key: "<key>"
      mountPath: "<mountPath>"
```

  and drop `VETRA_FILES` from the rendered `env`. Without it: `secretFiles: []` (always rendered, so the golden files change once; update `__golden__`).

- [ ] **Step 1: Failing tests:**
  - `checkMountPath` table (`/client_secret_sektar-web-app.json` ok; `/data/x`, `relative`, `/a/../etc/passwd`, `/` refused);
  - publisher file in `PLAN` → tenant secret `FILE_…` with the content, document `VETRA_FILES` lists it, no env entry named `FILE_…`;
  - holder file at the same path replaces the publisher's (one entry, holder's content);
  - deleting the file deletes the tenant secret and the `VETRA_FILES` entry;
  - processor: `VETRA_FILES` → `secretFiles` block, not in `env`; malformed JSON → `secretFiles: []` and a warning; golden files updated.
- [ ] **Step 2: Implement, run** (`npx vitest run processors/vetra-cloud-environment subgraphs/vetra-apps/__tests__/{settings-api,holders-settings,instances-settings}.test.ts …`). **Commit** `feat(settings): file settings mounted from tenant secrets (VETRA_FILES)`.
- [ ] **Step 3: Deploy order note in the PR:** E1 (chart) must be released and pinned before files are used. Until then the chart ignores `secretFiles` and the console shows "file mounts need powerhouse-chart ≥ <E1 version>" (vetra.to). Do not set a file on Sektar's plans before E1 is verified on staging.

---

### Task 10: AI key per plan budget [essential]

**Files:**
- Modify: `subgraphs/vetra-apps/db/{schema,migrations}.ts`, `plans/{repo,service,rules}.ts`, `schema.ts`, `instances/reconciler.ts`, `service.ts` (`AppsDeps.llm`), `index.ts`
- Create: `instances/vetra-secrets.ts`
- Modify (vetra-llm): `db/schema.ts`, `migrate.ts`, `store.ts`, `broker.ts`, `sweeper.ts`, `factory.ts`
- Test: `subgraphs/vetra-llm/__tests__/broker.test.ts`, `sweeper.test.ts`; `subgraphs/vetra-apps/__tests__/instances-ai.test.ts` (new), `plans-api.test.ts`

**Interfaces:**
- `plans.ai_budget_usd` (`ensurePlanAiBudget`); `createPlan`/`updatePlan` input `aiBudgetUsd: Float` (null clears; 0 < x ≤ 1000, cents precision); `AppPlan.aiBudgetUsd`; audit `plan.updated` changes include it.
- vetra-llm:
  - `studio_llm_keys.instance_id` (nullable, migration in `migrate.ts`);
  - `VetraKeyInput.fixedBudgetUsd?: number` and `instanceId?: string`; `keyName` → `instance:<instanceId>` when `instanceId` is set (`INSTANCE_KEY_NAME_PREFIX = "instance:"`);
  - `keyBudget`: a row/input with `instanceId` answers `planBudget(instanceId)` (a `BrokerDeps`/`SweepDeps` callback; null → not allowed); never the Studio licence;
  - like `app:` keys, an `instance:` key's missing grant never deletes the tenant secret the FUSION service mounts by key (the key is disabled instead), and only `OPENROUTER_API_KEY` is written (no model vars);
  - the orphan rule also covers `instance:` names.
- `instances/vetra-secrets.ts`:

```ts
/** Secret names Vetra writes for this instance outside settings (declared in its document). */
export function vetraSecretsOf(row: InstanceRow, plan: PlanRow | null, cfg): string[];
/** Ensures the instance's AI key (and Task 11's reporting token) in its tenant; idempotent; called by the reconciler after deliverSettings. */
export async function ensureInstanceVetraSecrets(deps, app, row, plan, tenantId): Promise<void>;
/** Disables/releases what ensureInstanceVetraSecrets made (instance stopped for good or destroyed). */
export async function releaseInstanceVetraSecrets(deps, row): Promise<void>;
```

  `vetraSecretsOf` returns `["OPENROUTER_API_KEY"]` for a plan instance whose plan has `ai_budget_usd` and when `deps.llm` is configured. Owner DID: own → the holder's `user_did` from `app_license_grants` of the chain root; shared → `did:pkh:eip155:1:<app owner>` (as `normaliseUserDid` produces).
- `AppsDeps.llm?: Pick<LlmBroker, "provisionVetraKey" | "releaseVetraKey"> | null`, built in `index.ts` with `createProcessBroker` and `planBudget = (instanceId) => select plans.ai_budget_usd join instances where instances.stop_reason is null`. Absent (no `OPENROUTER_MANAGEMENT_KEY`): plan instances run keyless and the instance reason says "AI key unavailable" only when the plan has a budget.
- `settings/service.ts` + `holder-service.ts`: `OPENROUTER_API_KEY` refused in `PLAN` scope and for holders while any active plan of the App has a budget (H7).

- [ ] **Step 1: Failing tests (vetra-llm):** an instance key is minted with `limitUsd = 25`; the sweeper keeps it ACTIVE while `planBudget` returns 25, sets the new limit when it returns 40, disables it (secret kept) when it returns null, re-enables it later; a Studio-licence lookup is never made for it.
- [ ] **Step 2: Failing tests (vetra-apps):** an own instance of a plan with `aiBudgetUsd: 25` → `provisionVetraKey` called once with `instanceId`, `fixedBudgetUsd: 25`, the holder's DID and the tenant; the document declares `OPENROUTER_API_KEY`; `deliverSettings` never deletes it; a plan without budget → nothing provisioned and nothing declared; the licence ends and the instance stops → `releaseVetraKey` is **not** called (key disabled by the sweeper through `planBudget` = null; released on destroy, Task 17).
- [ ] **Step 3: Implement, run, commit** (two commits: `feat(llm): instance keys with a plan budget`, `feat(instances): AI key per plan budget`).

---

### Task 11: Reporting token for own instances [essential]

**Files:**
- Modify: `instances/vetra-secrets.ts`, `instances/reconciler.ts`, `subgraphs/vetra-licensing/reporting.ts`, `subgraphs/vetra-licensing/index.ts`, `subgraphs/vetra-apps/config.ts` (`licensingUrl` from `VETRA_LICENSING_URL`, as licensing reads it)
- Test: `subgraphs/vetra-licensing/__tests__/reporting.test.ts`, `subgraphs/vetra-apps/__tests__/instances-ai.test.ts`

**Interfaces:**
- `vetraSecretsOf` adds `VETRA_REPORTING_TOKEN` and `VETRA_LICENSING_URL` for **own** instances (H8) when `cfg.licensingUrl` and `deps.licensingDb` exist.
- `ensureInstanceVetraSecrets` calls licensing's `ensureReportingTokens` with `ReportingDeps` built from vetra-apps deps: `db: deps.licensingDb`, `secrets: deps.instanceSecrets` (`setSecrets`), `tenantIdOf: () => tenantId`, `envStatus: (id) => envs.getState(id)?.status`, `licensingUrl: cfg.licensingUrl`, `newToken: newReportingToken`. No budget object: an instance's first token is written before its first start (asleep → free).
- `relayUserStat`: `RelayDeps.envRows.byEnvironment` gets a fallback in `vetra-licensing/index.ts`: when `license_environments` has no row, read the vetra-apps `instances` row with that `environment_id`, kind `own`, not removed, and answer `{ root_license_id: licence_root_id, app_id, user_did }` with `user_did` from `app_license_grants` of the chain root. The rest of the relay (chain head ACTIVE and live, granted for the same app and holder, App identity) is unchanged. A shared instance has no answer → refused "it has no licence chain".

- [ ] **Step 1: Failing tests:** an own instance gets both secrets once (a second pass writes nothing); the hash row exists; a `reportUserStat` with that token for the holder's DID is relayed; for another DID refused; after the licence ends refused; a shared instance declares neither secret.
- [ ] **Step 2: Implement, run, commit** `feat(instances): reporting token for own instances; relay through plan instances`.

---

### Task 12: End-of-licence notices for holders [essential]

Holders are told today by licensing's banners (`subscriptionWarnings`); own instances must say the same before Sektar's holders move.

**Files:**
- Create: `holders/notices.ts`
- Modify: `plans/holder-view.ts`, `schema.ts`
- Test: `__tests__/holders-notices.test.ts` (new), `plans-holder-view.test.ts`

**Interfaces:**

```ts
export type HolderNoticeKind =
  | "EXPIRING"              // licence ends within 7 days
  | "ENDED_STOP_PENDING"    // ended; stops at endedAt + stopAfterDays
  | "STOPPED"               // stopped; data kept (destroy off)
  | "STOPPED_DELETE_PENDING"// stopped; deleted at endedAt + destroyAfterDays (destroy on)
  | "DELETE_IMMINENT"       // the last 7 days before deletion
  | "APP_DISCONTINUED";     // PR B, 14.4: the App is being deleted on dueAt
export interface HolderNotice { kind: HolderNoticeKind; at: string | null; message: string }
export function holderNotices(input: {
  now: string; endAt: string | null; endedAt: string | null; stopped: boolean;
  stopAfterDays: number; destroy: { enabled: boolean; afterDays: number };
  appDeletionDueAt?: string | null;
}): HolderNotice[];
```

  Pure, mirroring `subscriptionWarnings`' wording. `endAt` = the live head's `endAt` (`liveChains`), `endedAt` = `licence_ended_at`. Shared instances get `EXPIRING` from the holder's own live licence only.
- `HolderInstance.notices: [HolderNotice!]!`, `HolderInstance.licenceEndsAt: String`, `HolderInstance.stopsAt: String`, `HolderInstance.deletesAt: String`.

- [ ] **Step 1: Failing table test** (`holders-notices.test.ts`): 8 days before end → none; 6 days → `EXPIRING`; ended 3 days ago, `stopAfterDays` 14 → `ENDED_STOP_PENDING` at end+14; stopped, destroy off → `STOPPED` (no deletion date); destroy on at day 85 of 90 → `DELETE_IMMINENT` at end+90.
- [ ] **Step 2: View test:** `myInstances` carries the notices.
- [ ] **Step 3: Implement, commit** `feat(holders): end-of-licence notices on myInstances`.

---

### Task 13: Interim delete-App guard [essential]

Folds in "check delete-App guards" (14.4 safety until PR B). Without it, `deleteApp` deletes the settings that plan instances run on.

**Files:** Modify `service.ts` (`deleteApp`). Test `__tests__/apps.test.ts` (or `instances-plans.test.ts`).

- [ ] **Step 1: Failing tests:** an App with a non-removed shared or own instance → `deleteApp` → BAD_USER_INPUT "This App runs N customer instances (plans). Retire its plans and wait until its holders' instances have ended, or contact Vetra" and nothing changes (settings, robot, identity, status); an App with a live licence of a plan's kind but no instance yet → same; an App with only branch/preview instances → deleted as today.
- [ ] **Step 2: Implement** a check at the top of `deleteApp`, after `loadAppForOwner`: count `instances` where `kind in (shared, own)` and `status != removed`, and `liveChains(licensingDb, app.id, now)` filtered to plan kinds.
- [ ] **Step 3: Commit** `fix(apps): refuse deleting an App whose plans have customer instances`.

---

### Task 14: PR A checks and PR [essential]

- [ ] **Step 1:** Wire jobs in `index.ts`: `every(60_000, "custom domains", () => checkDomainsOnce(deps))` when plans are on.
- [ ] **Step 2: Full checks** (Global Constraints). Fix what this branch broke; leave pre-existing failures.
- [ ] **Step 3: PR.** `git push -u origin feat/releases-phase-3-holders`, `gh pr create --title "feat(apps): holder settings, custom domains, files, AI key and reporting token (releases phase 3, slice 7a)"`. Body: what ships per task, H1-H11 as built, the deploy order (E1 before using files), the staging steps (Task 20 part A), that `ALL` secrets leave plan instances (staging plan instances roll once), and `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. The user merges.

---

## PR B — later (spec requirements slice 9 does not depend on)

### Task 15: Backups for holders (port, stop backups, download) [later; needs slice 4]

**Files:**
- Create: `backups/port.ts`, `backups/stub.ts`, `backups/service.ts`
- Modify: `db/{schema,migrations}.ts` (`instance_backup_requests`, `instances.stopped_at`), `instances/reconciler.ts` (stop backup before sleep), `schema.ts`, `resolvers.ts`, `service.ts` (`AppsDeps.backups`), `index.ts`
- Test: `__tests__/holders-backups.test.ts` (new)

**Interfaces (the contract slice 4 implements; this task ships the stub):**

```ts
export type BackupPurpose = "PRE_UPDATE" | "HOLDER_DOWNLOAD" | "STOP" | "FINAL";
export type BackupState = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";
export interface InstanceBackup {
  id: string;
  instanceId: string;
  purpose: BackupPurpose;
  state: BackupState;
  /** pg_dump of the instance's database (dumps subsystem). */
  databaseDumpId: string | null;
  /** /data archive (slice 4 data_archives). */
  dataArchiveId: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** Kept at least until then (FINAL: +180 days, H14). */
  retainUntil: string | null;
}
export interface InstanceBackups {
  /** Starts a database dump and a /data archive of a running instance. Throws BACKUP_IN_PROGRESS when one runs. */
  start(input: { instanceId: string; environmentId: string; tenantId: string; purpose: BackupPurpose; requestedBy: string }): Promise<InstanceBackup>;
  get(id: string): Promise<InstanceBackup | null>;
  /** Newest SUCCEEDED backup of the instance, optionally of these purposes. */
  latest(instanceId: string, purposes?: BackupPurpose[]): Promise<InstanceBackup | null>;
  /** Signed GET links for both parts, valid ttlSeconds (≤ 3600). */
  presign(id: string, ttlSeconds: number): Promise<{ databaseUrl: string; dataUrl: string; expiresAt: string }>;
  /** Moves both objects under the retention prefix and sets retainUntil (FINAL, H14). */
  retain(id: string, until: string): Promise<void>;
}
```

  `backups/stub.ts` `unavailableBackups` throws `SERVICE_NOT_CONFIGURED "Backups arrive with releases phase 3 slice 4"`. If slice 4's API differs, write an adapter in `backups/port.ts`; do not change slice 4.
- `instance_backup_requests (id, instance_id, backup_id, requested_by, requested_at)`: rate limit 3 per 24 h (H13).
- `requestMyInstanceBackup(instanceId)` (holder-only): running → `backups.start(purpose HOLDER_DOWNLOAD)`; stopped → the newest `STOP`/`FINAL` backup (NOT_FOUND "no backup yet" when none); audit `instance.backup.requested`. `myInstanceBackup(id)` → state, and when SUCCEEDED the two links (1 h).
- Stop backup: `stopPlanInstance` for an own instance with `stop_reason = LICENCE_ENDED` starts a `STOP` backup first and sleeps only when it SUCCEEDED (a FAILED backup is retried 3 times, then the instance is slept anyway with reason "stopped without a backup: <error>", alerting through the audit row). `stopped_at` is set when it sleeps.

- [ ] **Steps:** failing tests (holder-only; rate limit; stopped instance serves the stop backup; links only for SUCCEEDED; stop waits for the backup; stub → SERVICE_NOT_CONFIGURED), implement, commit `feat(holders): backup download and stop backups (on slice 4's backups)`.

---

### Task 16: Support access [later]

**Files:**
- Create: `support/{repo,service}.ts`
- Modify: `db/{schema,migrations}.ts` (`instance_support_grants`), `instances/reconciler.ts` (`adminsOf`), `audit/repo.ts`, `schema.ts`, `resolvers.ts`
- Test: `__tests__/support-access.test.ts` (new)

**Interfaces:**
- `instance_support_grants (id, instance_id, app_id, grantee, reason, hours, status REQUESTED|ACTIVE|DENIED|REVOKED|EXPIRED, requested_at, decided_at, decided_by, expires_at, ended_at)`; at most one REQUESTED or ACTIVE per instance (partial unique index).
- Publisher side (`need: "release"`): `requestSupportAccess(instanceId, hours: 1-72, reason ≤ 500)` → REQUESTED, grantee = caller; `supportAccess(appId)` lists the App's grants (no holder data).
- Holder side (holder-only): `mySupportRequests(instanceId)`, `grantSupportAccess(grantId)` → ACTIVE, `expires_at = now + hours`; `denySupportAccess(grantId)`; `revokeSupportAccess(grantId)`.
- `adminsOf(app, row, grants, now)`: holder + grantee of an ACTIVE, unexpired grant (comma-separated, lowercased, the holder first). The reconciler loads ACTIVE grants once per pass. Expiry: `sweepSupportOnce` (every 60 s) marks expired grants EXPIRED with an audit row; the next reconcile drops the grantee from `ADMINS`.
- `myInstanceAudit(instanceId, limit, before)` (holder-only): `app_audit` rows with subject `instance:<id>` (the holder sees who acted on their instance).
- Audit: `support.requested|granted|denied|revoked|expired` with `{grantee, hours, reason}`.

- [ ] **Steps:** failing tests (only an operator/release manager can request; only the holder decides; grant → `ADMINS` gains the grantee on the next reconcile; expiry removes it; revoke removes it; a second request while one is open → BAD_USER_INPUT; the holder reads the audit rows), implement, commit `feat(holders): support access with the holder's consent, audited`.

---

### Task 17: Deletion after 90 days behind `VETRA_APPS_PLANS_DESTROY` [later; needs Task 15]

**Files:**
- Modify: `config.ts` (`plans.destroy: { enabled, afterDays }` from `VETRA_APPS_PLANS_DESTROY` on/off default off and `VETRA_APPS_PLAN_DESTROY_AFTER_DAYS` 30-365 default 90), `plans/sync.ts`, `instances/reconciler.ts` (`removeInstance` for plan kinds), `holders/notices.ts` (destroy dates), `audit/repo.ts`
- Test: `__tests__/instances-plans-destroy.test.ts` (new), `config.test.ts`

**Rules:**
- `syncPlanInstances`: an own row with `stop_reason = LICENCE_ENDED`, status `stopped`, and `licence_ended_at + afterDays ≤ now` → with the switch on: `removed_at = now`, `removed_reason = "licence ended <afterDays> days ago"`; off: log once per row `would delete … (VETRA_APPS_PLANS_DESTROY is off)`.
- `removeInstance` for plan kinds (replacing the throw): only with the switch on, `removed_at` set, and a SUCCEEDED `STOP`/`FINAL` backup newer than the last start (`backups.latest`), which is then `retain(id, now + 180 d)`; else take a `FINAL` backup first (waking is not needed: the stop backup normally exists). Then, under the environment lock: the document must be PLAN and ours → `deps.envs.delete`; `forgetTenant`; `releaseInstanceVetraSecrets` (AI key, reporting token row); `deleteInstanceSettings`; clear `custom_domain`; status `removed`; audit `instance.destroyed {backupId, retainUntil}`.
- A renewal between `removed_at` and the deletion (licence live again) clears `removed_at` (sync) when the environment still exists.
- Shared instances are never destroyed here (Task 18 only).

- [ ] **Steps:** failing tests (off → nothing deleted, one log line; on → deleted only after a backup, which is retained 180 d; renewal before deletion cancels it; a licensed `managedBy` document is never deleted; notices show the deletion date), implement, commit `feat(instances): delete ended own instances after 90 days (switch, final backup)`.

---

### Task 18: Deleting an App that has holders (spec 14.4) [later; needs Tasks 15 and 17]

**Files:**
- Modify: `db/{schema,migrations}.ts` (`apps.deletion_requested_at`, `deletion_requested_by`, `deletion_due_at`), `service.ts` (`deleteApp`, `scheduleAppDeletion`, `cancelAppDeletion`, `finishScheduledDeletions`), `plans/service.ts` (no new plans during the notice), `plans/sync.ts` (chains end at the due date), `holders/notices.ts` (`APP_DISCONTINUED`), `subgraphs/vetra-licensing/issue.ts` (refuse plan kinds of a discontinued App), `config.ts` (`VETRA_APPS_APP_DELETION_NOTICE_DAYS`, default 30), `schema.ts`, `resolvers.ts`
- Test: `__tests__/apps-deletion-holders.test.ts` (new), licensing `__tests__/issue.test.ts`

**Rules (H12):**
- `deleteApp` on an App with plan instances or live plan-kind licences no longer refuses (Task 13's guard becomes this): it calls `scheduleAppDeletion` and returns true; `App.deletionDueAt` tells the console. Without them it deletes at once (today's path).
- During the notice: `createPlan` refused; licensing `issueUnlocked` refuses a kind adopted by a plan of the App (`notIssuable("the App is being discontinued")`); rollouts and settings still work; holders see `APP_DISCONTINUED` with the date and the backup download.
- At `deletion_due_at`: `syncPlanInstances` treats every chain of the App as ended at the due date (`licence_ended_at = min(recorded end, due)`), so own instances stop `stopAfterDays` later and are deleted by Task 17 when the switch is on. Shared instances get `stop_reason = "the App is discontinued"` at the due date.
- `finishScheduledDeletions` (15-minute sweep): an App past its due date with no plan instance un-removed (own instances deleted by Task 17, shared instances deleted after a `FINAL` backup when the switch is on) runs today's `deleteApp` tail (robot, identity, settings, DELETED). With the switch off it waits (logged once).
- `cancelAppDeletion(appId)` (`need: "operate"`) until the due date clears the columns; audit `app.deletion_cancelled`.

- [ ] **Steps:** failing tests (schedule instead of refuse; issue refused during the notice; notice visible; at the due date licences count as ended; cancel restores; App becomes DELETED only after the last plan instance is removed; switch off → App waits), implement, commit `feat(apps): deleting an App with holders: notice, then end of licence (spec 14.4)`.

---

### Task 19: PR B checks and PR [later]

- [ ] Wire `sweepSupportOnce` (60 s) and `finishScheduledDeletions` (15 min) in `index.ts`. Full checks. `gh pr create --title "feat(apps): holder backups, support access, deletion (releases phase 3, slice 7b)"` with H12-H16 as built, the staging steps (Task 20 part B), and `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

---

## Verification and outside work

### Task 20: Staging verification (needs the user; no code)

**Part A (after PR A is pinned on staging; `VETRA_APPS_PLANS: "on"` already):**
- [ ] **Step 1:** On the staging canary app, an own plan with `aiBudgetUsd: 5` and a publisher grant to test holder **H**. The own instance becomes READY.
- [ ] **Step 2: Scopes.** Publisher sets `ALL` secret `DEV_ONLY` and `PLAN` secret `CUSTOMER_TOKEN`. The own instance's document declares `CUSTOMER_TOKEN` and not `DEV_ONLY`; the `main` branch instance declares `DEV_ONLY` and not `CUSTOMER_TOKEN`.
- [ ] **Step 3: Holder settings.** As H: `setMyInstanceSetting` plain `HOLDER_MODE=x` and secret `HOLDER_SECRET`; the instance rolls and becomes READY with a new `settingsRevision`; as the publisher, `myInstanceSettings` → NOT_FOUND and `appAudit` shows `instance.setting.changed` rows without names.
- [ ] **Step 4: Survives updates and rollbacks.** Retarget the plan (slice 3 rollout if merged, else `setPlanTarget`) to a new release and back; `HOLDER_MODE` is in the document both times; with `CANARY_CRASH` on the new release the revert keeps it.
- [ ] **Step 5: Custom domain.** The user creates `holder-test.<a test domain>` `A 138.199.129.93`. As H: `setMyInstanceCustomDomain` → `DNS` until the record resolves, then `ISSUING`, then `ACTIVE` (record the minutes of TLS gap); `myInstances.url` is the domain; health stays ready; the generated host no longer answers. Remove it → the generated host serves again.
- [ ] **Step 6: Files (only after E1 is pinned):** publisher `PLAN` file at `/client_secret_test.json`; `kubectl exec` shows the file with the content, mode 0440; the holder's file at the same path replaces it.
- [ ] **Step 7: AI and reporting.** The tenant has `OPENROUTER_API_KEY` (OpenRouter shows key `instance:<id>` with limit 5) and `VETRA_REPORTING_TOKEN`; a `reportUserStat` from the instance for H's DID is relayed (licensing log).
- [ ] **Step 8: Directory.** As H, `GET apps/directory/v1/environments?app=<id>` lists the instance with its URL.
- [ ] **Step 9: End of licence.** Expire the grant: `myInstances.notices` shows `ENDED_STOP_PENDING`; after the stop window (staging `VETRA_APPS_PLAN_STOP_AFTER_DAYS: "1"` for the test) the instance is stopped with `stopped_by_vetra`; sleep a second instance by hand as an admin and renew its licence: it is **not** woken.
- [ ] **Step 10: Delete guard.** `deleteApp` on the canary app → refused with the message; nothing changed.

**Part B (after PR B and slice 4 are on staging):** backup download as H (both links download, the dump restores locally); support access request → grant → `ADMINS` contains the publisher → expiry removes it; with `VETRA_APPS_PLANS_DESTROY: "on"` and `VETRA_APPS_PLAN_DESTROY_AFTER_DAYS: "30"` plus a manipulated `licence_ended_at` on a test row, the instance is deleted after a FINAL backup that is retained; schedule the canary app's deletion with a 1-day notice, see `APP_DISCONTINUED`, a refused grant issue, and cancel it.

Production: PR A's pin follows the Sektar rollout check (Global Constraints). `VETRA_APPS_PLANS_DESTROY` stays off in production until H9 is decided.

### Task 21: External tasks (not in this repository)

- **E1 `powerhouse-chart` (essential for Task 9's files):** the `app.secretFiles` change exactly as in `2026-11-11-releases-phase-2-plan-4-settings.md` "Deferred: files" (values default `[]`; `volumeMounts` per file with `subPath`, `readOnly`; `volumes` from the Secret with `items` and `defaultMode: 0440`; the Reloader annotation condition gains `.Values.app.secretFiles`), plus the recommended `optional` flag per `secretEnv` entry. Owner: the user (chart maintainers review). Then a chart release, and `powerhouse-k8s-hosting` pins it for staging, then production. Verification: render `helm template` with one file and check the pod spec; Task 20 Step 6.
- **E2 Dumps bucket lifecycle (PR B, H14):** a rule that keeps objects under the retained-backups prefix (slice 4 names it; proposed `retained/`) for 180 days, separate from the 30-day rule. Owner: the user (S3 console or Terraform).
- **E3 Sektar (essential only if E1 is late):** read the Google OAuth client JSON from a secret env var (e.g. `SEKTAR_GOOGLE_WEB_CLIENT_JSON`) when `/client_secret_sektar-web-app.json` is absent, so the switch-over does not wait for E1. Decide with the user.
- **Later (H4):** dual-host custom domain moves need `app.additionalIngresses` in the chart and a processor change; not planned here.

### Task 22: Console follow-up (vetra.to; separate PRs after each backend PR is on staging; no code here)

On `feat/holder-instance-settings` (PR A) and `feat/holder-backups-support` (PR B) in vetra.to:
- **Codegen** against the staging vetra-apps schema; widen the environment role type with `PLAN` (slice 1 follow-up) if not done yet.
- **Holder instance page** (`app/user/...` / `modules/subscriptions`): per own instance (from `myInstances`): status, URL, notices as banners (the wording of today's EXPIRING/STOP banners), and tabs:
  - **Settings**: plain/secret/file rows (secrets write-only: "Replace" only), the App's names it would override (warning), reserved names;
  - **Domain**: the DNS record to create (copy buttons), live status `DNS → ISSUING → ACTIVE`, the warning that the generated address stops working and HTTPS takes a few minutes;
  - (PR B) **Backups**: "Download backup" with progress and two links; **Support**: open requests with Approve/Deny, active grant with Revoke and the expiry; **Activity**: `myInstanceAudit`.
- **Publisher side** (`modules/apps`): the Settings tab's scope picker gains "Customer instances (PLAN)" with the explanation that "All" secrets no longer reach customers; file settings (path + upload, "needs chart ≥ E1"); the plan form gains "AI budget per instance (USD / month)"; instance rows show "N holder settings" and the custom domain; (PR B) "Request support access" on own instances, and the delete dialog explains the 30-day notice.
- **People are Renown names** everywhere (grantees, requesters, actors): `usePersonName`, never a raw `0x…` label.

---

## Self-review

- **Spec coverage:**
  - 14.2 holder settings, kept per instance and applied on every update and rollback → Tasks 2-4 (rollback test in Task 4), files → Task 9 + E1.
  - Section 5 hosts and custom domains for own instances only (17) → Tasks 7-8; `OPENROUTER_API_KEY` capped at the plan's budget → Task 10.
  - 14.4 → Task 13 (interim) and Task 18; 14.5 → holder-only settings (Task 3), backups (Task 15), support access (Task 16).
  - End of licence (overview slice 7) → Task 12 (notices), existing stop, Task 17 (deletion behind the switch, final backup 180 d).
  - Reporting parity → Task 11.
- **Slice 1 follow-ups:** ALL secrets → Task 1; holder-slept `stopped_by_vetra` → Task 5; `runsApp` and delete guards → Tasks 6 and 13.
- **Essential for slice 9:** Tasks 1-13 (PR A). Slice 9 uses `importHolderSettings` (Task 3), `moveCustomDomainToInstance` (Task 8), files (Task 9 + E1 or E3), the AI key and reporting token (Tasks 10-11), the directory (Task 6) and the notices (Task 12). It needs nothing from PR B.
- **Safety:** every document write is guarded against `managedBy` and non-PLAN documents (`instanceUpdateActions`, `domainActions`); nothing is deleted without `VETRA_APPS_PLANS_DESTROY` and a retained backup; holder secrets are encrypted under their own transit pseudo-tenant and never logged or audited by name.
- **Type consistency:** `InstanceSettings` (`files`, `vetraSecrets`, `holderCount`) is produced by `settingsForInstance` and consumed by `deliverSettings`, `fusionEnv`, `envSettings`; `publicHostOf` is used by the views, the directory and the monitor; `InstanceBackups` is used by Tasks 15, 17 and 18 only.
- **Revision stability:** without holder rows, files or Vetra secrets the revision document is `v1`, so shipping PR A rolls only plan instances whose settings change (H1) and none of the branch or preview instances.
