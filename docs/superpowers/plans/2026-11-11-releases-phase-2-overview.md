# Releases phase 2 ("Instances"): overview and slices

Date: 2026-11-11. Spec: `docs/superpowers/specs/2026-11-11-app-releases-and-instances-design.md`
(sections 5, 6, 14.2, 14.6, 14.7, 14.13, 14.18, 16, 18 phase 2). Builds on phase 1 as built
(`subgraphs/vetra-apps/releases/*`, `powerhouse-inc/vetra-publish@v1`).

Phase 2 is split into seven plans. Each one ships alone, is usable alone, and leaves every
licensed environment (`license_environments`, `app_warm_pool`, `managedBy` documents) alone.
Plan 1 is written out in full (`2026-11-11-releases-phase-2-plan-1-branch-instances.md`); the
others get their own plan when their turn comes, against the code as it stands then.

## What exists today (the ground phase 2 stands on)

- **Environments are documents** (`powerhouse/vetra-cloud-environment`). Anything that wants an
  environment dispatches system-signed actions through `EnvGateway`
  (`subgraphs/vetra-apps/envs.ts`): `create`, `execute`, `getState`, `delete`.
- **The processor** (`processors/vetra-cloud-environment/processor.ts`) renders a document to
  `tenants/<tenantId>/powerhouse-values.yaml` (or `previews/` when `app.role = PREVIEW`) in
  `powerhouse-k8s-hosting` whenever its status is `CHANGES_APPROVED` or `STOPPED`, then marks
  it pushed. The observability subgraph moves `CHANGES_PUSHED → DEPLOYING → READY |
  DEPLOYMENt_FAILED` from Argo health and pod readiness.
- **A host image** is FUSION enabled + `fusion.image` (repository, no tag; the reducer refuses
  `:` and `@`) + FUSION `version` (the tag) + a plain `PH_HOST` entry in `fusion.env`. Host mode
  gets the tenant database, `/data` (not for previews), `PUBLIC_URL`. The chart pulls
  `"<repository>:<tag>"` with the shared `powerhouse/shared/harbor-credentials` robot.
  Digest pinning therefore needs no document-model change: tag = `<version>@<digest>`.
- **Image allowlist**: the processor renders a FUSION image only from `FUSION_IMAGE_PROJECTS` or
  the project `createAppImageProjectResolver` (`app-image-project.ts`) vouches for, from the
  vetra-apps tables (production env, `app_previews`) or licensing (`license_environments`,
  warm pool). Never from the document.
- **Previews** are made only by `ci/deploy` (old action) into `app_previews`; removed on PR close
  (webhook), TTL sweep, eviction. Rendered small (size S, 5 Gi DB, no S3 backups, no `/data`).
- **Licensed environments** are owned by licensing's `AppLicenseHandler`
  (`license_environments`), versioned through artifact channels on the app document
  (`ci/artifacts`, written by the old action), gated by `vetraReleases` rollouts. Nothing in
  licensing reads `app_deployments`; it reads `apps.production_environment_id` and
  `app_previews.environment_id` only to validate a template's `sharedEnvironment`.
- **Single replica**: the switchboard runs one replica; loops use in-process locks
  (`shared/key-lock.ts`); pgbouncer in transaction mode rules out session advisory locks.

## Rules every slice follows

1. Only touch environment documents whose id is in the `instances` table. Never touch a
   document in `license_environments` or `app_warm_pool`, or one with `managedBy` set (checked
   before every write, not only at creation).
2. Instances pull by digest: FUSION `version` = `<version>@<image_digest>`, `fusion.image` =
   the release's `image_ref` without its tag.
3. Each slice is opt-in per app until slice 7 turns it on for every app.
4. Production pins of vetra-cloud-package restart the switchboard (1-1.5 min) and with it the
   licensing handler. **No production pin between 2026-11-13 17:30 UTC and the moment
   `vetraReleases.rollouts(Sektar)` shows the v1.0.9 rollout COMPLETE** (11 environments, one at a
   time, about 3 min of 503 each).
5. Staging first: merge to `main`, pin staging (`tenants/staging/powerhouse-values.yaml`,
   `PH_REGISTRY_PACKAGES`, two places), verify, then pin production.

## The slices

### Slice 1: Branch instances (plan written: `2026-11-11-releases-phase-2-plan-1-branch-instances.md`)

- **Goal:** an app on vetra-publish gets one running instance per release branch
  (`shop-main`, `shop-next`), following that branch's newest build or release by digest.
- **Scope:** `instances` table; `apps.instances_enabled` (opt-in, default off); a reconciler loop
  (create, update, revert on failure, remove) over `branch` instances only; host naming; status
  (`pending`, `updating`, `ready`, `failed (reason)`, `stopped`) with the interim health rule
  "environment READY and running the target digest"; branch deletion (push webhook) and
  release-branch removal remove the instance; the processor's image resolver vouches for
  instance environments; `appInstances` query, `App.instancesEnabled`,
  `UpdateAppInput.instancesEnabled`; kill switch `VETRA_APPS_INSTANCES=off`; host suffix
  `VETRA_APPS_INSTANCE_LABEL_SUFFIX` for staging.
- **Removes:** nothing. The old production environment and previews keep running beside it.
- **Risks to running apps/environments:** none to licensed environments (rule 1; licensed
  documents have no `app` link, so the resolver change never runs for them). A new environment
  per release branch costs cluster resources (size S, one Postgres). Host collisions with
  existing environments are detected and fall back (see gap 4). Pull failures if the shared
  Harbor robot cannot read namespace projects (user check below).
- **Staging verification:** a test app created on staging (never on production first: Renown
  binds a repo's CI identity to the first platform), workflow on vetra-publish, `instancesEnabled`
  on; push to `main` → `shop-main-stg.vetra.io` READY on the build's digest
  (`kubectl get pod -o jsonpath='{..imageID}'` equals the digest); push again → updated; break the
  image (failing healthcheck) → `failed`, environment back on the previous digest; delete a
  release branch → instance gone, gitops dir gone.
- **Needs the user:** confirm the shared robot `powerhouse/shared/harbor-credentials` pulls from
  every project (system robot) or extend it; staging values PR adding
  `VETRA_APPS_INSTANCE_LABEL_SUFFIX: "-stg"`; a staging test app (GitHub repo, App install,
  Renown binding on staging); the two pin PRs; turning `instancesEnabled` on for production apps.

### Slice 2: Preview instances

- **Goal:** each open PR of an instances-enabled app gets a `preview` instance on its newest
  build (`shop-pr-12`), at most `apps.preview_limit` (default 5, oldest PR removed first),
  removed on PR close.
- **Scope:** `preview` kind in the reconciler (target = newest build with `pr = n` by run); PR
  close webhook and the TTL sweep remove preview instances; build pruning (newest 20 builds per
  branch, a PR's builds when it closes), never pruning a build an instance targets or runs;
  for instances-enabled apps the old `ci/deploy` PREVIEW is answered with a no-op
  ("previews come from vetra-publish") so the two do not both run a preview per PR.
- **Removes:** for instances-enabled apps only, old previews (`app_previews` rows and their
  environments) at enable time.
- **Risks:** a burst of PR pushes creates environments; the limit bounds it. Pruning deletes
  release records of builds: covered by tests that it never touches `kind = release`.
- **Staging:** open two PRs on the test app, check two previews, close one, check removal and
  pruning; set `previewLimit 1` and check eviction.
- **Needs the user:** nothing beyond slice 1.

### Slice 3: Health (14.7)

- **Goal:** `ready` means the spec's health: switchboard health endpoint, Connect page, reactor
  migrations finished, and the version the host reports equals the target.
- **Scope:** an in-cluster probe from the switchboard (`https://<host>/health`, `/`, the host's
  version endpoint); until the host reports its version, the running digest comes from the pod's
  `imageID` (observability `environment_pods`, extended to record it). Probe results stored on
  the instance; `failed: unhealthy (<which check>)` after the timeout.
- **Removes:** the interim "environment READY" rule of slice 1.
- **Risks:** probes that are stricter than today's Argo health mark working instances failed;
  ship the probe in report-only mode first (status unchanged, result shown), then enforce.
- **Staging:** an image whose Connect returns 500 stays `updating` then `failed (connect)`.
- **Needs the user:** the Powerhouse monorepo change "host reports its running version"
  (spec section 15, phase 2); a decision on the endpoint (`/health` JSON `version`).

### Slice 4: Settings Vetra owns, and publisher settings (14.2)

- **Goal:** every instance gets the settings of spec section 5, and publishers can set their own
  secrets, settings and files once for all of an app's instances.
- **Scope:** `PH_WORKFLOWS_SECRETS_MASTER_KEY` per instance in OpenBao (today only created for
  switchboard-enabled envs, never for host mode); `ADMINS` = owner, or the org's admins (needs a
  Renown org-admins read); publisher settings per app (plain, secret, file) stored through
  `vetra-cloud-secrets`, applied on every create and update, names Vetra sets refused; file
  mounts (e.g. `/client_secret_sektar-web-app.json`).
- **Removes:** nothing.
- **Risks:** a wrong secret breaks instances of that app only. File mounts need a chart change.
- **Staging:** set a secret and a file on the test app; check them in the pod; check a reserved
  name is refused.
- **Needs the user:** `powerhouse-chart` change for secret-backed file mounts on the `app`
  component; a Renown query listing an org's admins (or accept owner-only ADMINS until then).
  Holder settings (custom domain, own OAuth client) belong to own instances: phase 3 (gap 7).

### Slice 5: GitHub feedback (PR comment, check, PR-title check)

- **Goal:** each PR shows its preview URL (one comment, updated) and a Vetra check with the
  instance status; a PR whose title is not a conventional commit gets a failing check (14.18).
- **Scope:** check runs (or commit statuses) per PR head; reuse `upsertPrComment`.
- **Risks:** a failing title check blocks merges where branch protection requires it; ship it
  neutral first.
- **Staging:** PR with title `wip` → failing check; renamed → passing; preview URL comment.
- **Needs the user:** the Vetra Deploy GitHub App needs `checks: write` (not in spec section 15);
  every installation approves; staging and production share the App, so the permission change
  lands on both at once.

### Slice 6: Cost and retention (14.13, 14.6)

- **Goal:** idle branch and preview instances sleep; build images leave Harbor with their records.
- **Scope:** housekeeping policy accepts FUSION host instances (today it sleeps only CLINT envs)
  for `branch`/`preview` kinds; the activator wakes them; Harbor artifact deletion for pruned
  builds (release images kept while a record or instance needs them).
- **Risks:** a sleeping instance answers through the activator; Sektar's licensed hosts must stay
  excluded (they are not instances, so the policy keys on the instances table).
- **Staging:** leave the test app's preview idle past the threshold; check STOPPED and wake.
  Prune a build; check the Harbor tag is gone and a release image is kept.
- **Needs the user:** `HOUSEKEEPING_*` values on staging and production; confirm Harbor's tag
  immutability rules allow deleting artifacts by digest from Vetra's admin robot.

### Slice 7: Removal and deprecation (spec 16, phase 2 part)

- **Goal:** instances become the only dev path for GitHub apps.
- **Scope:** instances on for every GitHub app; `ci/deploy` PREVIEW, `deployApp`/`rollbackApp`
  for previews and `app_previews` for GitHub apps removed (resolver and licensing's
  `appEnvironments` updated); the generated workflow loses the `deploy` job for PRs; setup PRs for
  existing repos; `vetra-deploy-action` refuses PR runs with a message pointing at vetra-publish.
- **Kept until phase 3** (gaps 1 and 2): the production deploy (`ci/deploy` PRODUCTION and its
  rollback), `ci/artifacts`, artifact channels and the old action's tag and production runs.
  Sektar's licensed environments and shared plans keep updating exactly as today.
- **Risks:** existing PR previews disappear at the switch; announce it. Repos that never moved to
  vetra-publish lose previews.
- **Staging:** an app on the old workflow only gets the deprecation failure on a PR and keeps its
  production deploy; Sektar-like flow: a `v*` tag still records the artifact.
- **Needs the user:** a release of `vetra-deploy-action@v1` with the PR refusal; announcement to
  publishers.

Order: 1, 2, then 3, 4, 5, 6 in any order (independent), then 7.

## Spec gaps and contradictions (proposed fixes; the spec is not changed by these plans)

1. **Removing `ci/deploy` in phase 2 freezes the production environment.** Phase 2 removes
   `ci/deploy` and `deployApp`/`rollbackApp`, yet keeps the app's production environment
   because shared plans point at it. `ci/deploy` is the only thing that updates it, so every
   shared-plan holder would be frozen on the last deploy until phase 3. Fix: phase 2 removes only
   the PREVIEW half (`ci/deploy` with `kind: PREVIEW`, preview rollback); the production deploy
   and rollback go with the production environment in phase 3.
2. **Deprecating the old action in phase 2 cuts licensed environments off.** "From phase 2 the
   old action is deprecated: it fails", but `ci/artifacts` and the channels are kept until phase 3
   "because licensed environments follow them", and the old action is what calls `ci/artifacts`
   (Sektar's `v*` runs record LATEST for its 15 environments and feed the gated rollout). Fix:
   in phase 2 the old action refuses PR runs only and warns otherwise; it fails fully in phase 3.
3. **Which branches get branch instances.** Section 5's table says one per release branch;
   section 3 says any other branch "makes builds only (for branch instances)". Fix: release
   branches only (production branch + `releaseBranches`); say so in section 3.
4. **Instance hosts are not collision-free.** `<app>-<name>` is ambiguous across apps (`a` +
   `b-c` and `a-b` + `c`), app slugs are unique only within one platform (staging and production
   share `vetra.io` and the cluster), branch names carry `/`, `.`, capitals and can exceed a
   63-char label, and existing environments' subdomains share the namespace. Fix: sanitize
   (lowercase, non-alphanumerics to `-`, `-<6 hex of sha1(branch)>` when sanitizing changed or
   truncated the name), check against the environment read model, fall back to
   `-<4 hex of the app id>`, store the chosen host on the instance for good; staging appends
   `-stg`. Reserve the production branch name and release-branch names as plan slugs as well as
   `main`, `team`, `pr-<n>` (a production branch called `master` gives `<app>-master`).
5. **`/data` persistence vs cheap dev instances.** Section 5 gives every instance a persistent
   `/data`; today previews get none because a kept PVC outlives the preview's cascade delete.
   Fix: branch and preview instances run with an ephemeral `/data` in phase 2 (they are rendered
   as previews); persistent `/data` for shared and own instances (phase 3).
6. **Templates arrive in phase 3 but instances are "built from a template" in phase 2.** Fix: one
   built-in dev template for branch and preview instances (host from the release, size S,
   `vetra.io`, no extra services). A release whose `requires.services` is not empty shows
   `failed: plan can't be provisioned (<service>)` on its branch instances until phase 3.
7. **14.2 is "per template" and covers holder settings, but templates and own instances are
   phase 3.** Fix: phase 2 delivers publisher settings per app (applied to all of the app's
   instances); they become per template in phase 3; holder settings move to phase 3.
8. **14.7 needs a host-reported version that does not exist yet.** Section 15 lists it for
   phase 2 without an owner or date. Fix: until it lands, the running digest is the pod's
   `imageID`; slice 3 switches to the host's report when available.
9. **`ADMINS` = "the org's admins"** needs a list Vetra cannot read today (Renown answers
   membership per address only). Fix: a Renown org-admins query (external dependency, add to
   section 15) or owner-only ADMINS until then.
10. **GitHub permissions for 14.18 and the instance check** (`checks: write`, or
    `statuses: write`) are missing from section 15. Fix: add them, phase 2, with the same
    approval caveat as 14.15.
11. **Section 5 says `instances` replaces `app_deployments`**, but Studio products keep
    `app_deployments` (section 9). Fix: "replaces `app_deployments` for GitHub apps".
12. **Build pruning vs running instances (14.6, section 4).** "The newest 20 per branch" can
    prune a build a branch instance still runs (after a failed update it stays on the older
    digest). Fix: never prune a build an instance targets or runs.
13. **Section 6 "create from the warm pool when one fits".** The only app warm pools are
    licensing's, filled from licensed templates; they never fit a branch or preview instance.
    Fix: no warm pool for instances until phase 3 moves warm pools onto templates.
