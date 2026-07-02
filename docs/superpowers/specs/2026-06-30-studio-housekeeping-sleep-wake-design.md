# Studio Housekeeping: Sleep Idle Studios & Wake on Demand

**Date:** 2026-06-30
**Status:** Design approved, pending spec review

## Problem

~54 studio environments run continuously, most idle. Each CLINT `vetra-agent`
studio reserves **2 CPU + 4 Gi** (plus a 25 Gi PVC) even while using ~2m CPU /
~1 Gi at rest. Worker nodes are at **88–98 % CPU requests** and **70–86 %
memory requests** (limits oversubscribed to 180–285 %). Idle studios therefore
pin ~100+ CPU and ~200+ Gi of schedulable capacity for nothing.

Goal: a **housekeeping service** that puts idle studios to sleep (reclaiming
their compute) and transparently wakes them when a user returns, showing a
loading spinner and dropping them into the studio once it is ready.

## Current architecture (as explored)

- **A studio = a tenant namespace.** The bulk are CLINT `vetra-agent`
  deployments serving the apex host `https://<subdomain>.vetra.io`. Older ones
  also run `connect` + `switchboard` + a per-tenant CNPG Postgres.
- **Provisioning is declarative.** The `vetra-cloud-environment` processor
  (`processors/vetra-cloud-environment/gitops.ts`) emits
  `tenants/<tenantId>/powerhouse-values.yaml` to the gitops repo
  (`powerhouse-k8s-hosting`). The ArgoCD ApplicationSet `powerhouse-tenants`
  (git directory generator over `tenants/*`, excluding `renown`, `vetra`,
  `staging`, `rfp-hub`, `defiunited`, `defiunited-staging`) renders one
  `powerhouse-<tenant>` Application per tenant, each with
  `automated.selfHeal: true` + `prune: true`. **A raw `kubectl scale` is
  reverted** — sleep state must live in git.
- **`global.disabled: true` already exists** in `powerhouse-chart`. Every
  Deployment, Service, HPA, ServiceMonitor **and Ingress** template is gated by
  `(not .Values.global.disabled)`, so setting it removes the whole workload
  including the studio's exact-host Ingress. PVCs, namespace, secrets and the
  wildcard TLS cert remain.
- **The env document model** (`document-models/vetra-cloud-environment/`) has a
  status lifecycle (`DRAFT → … → READY → TERMINATING → DESTROYED`) and already
  contains an unused `STOPPED` status. `TERMINATE_ENVIRONMENT` already emits
  `global.disabled: true`.
- **The warm pool** (`subgraphs/vetra-studio-pool/`, `keeper.ts`) keeps a few
  `WARMING`/`AVAILABLE` envs for instant claim; the read model
  (`processors/vetra-cloud-environment/schema.ts` `Environments`) carries
  `poolState`, `owner`, `subdomain`, `tenantId`, `status`.
- **Frontend** (`vetra.io`, `modules/cloud/studio/`) lists `myStudioProducts`
  (status `ready | booting`) via the observability subgraph, polls every 3 s
  while booting (`FAST_STUDIO_POLL_MS`), and opens the studio at its **apex
  host in a new tab**. Users therefore reach studios **directly by host**
  (bookmarks, shared links), not only via the dashboard. A `STOPPED`
  `CloudEnvironmentStatus` already exists in the frontend type union.
- **Routing:** plain Traefik host-based Ingress; all studio hosts resolve to a
  single LB IP under the `*.vetra.io` wildcard cert.
- **Observability:** `kube-prometheus-stack` (Prometheus in `monitoring`) is
  available and scrapes Traefik, so per-host request metrics exist.

## Decisions

| Decision | Choice |
| --- | --- |
| Wake model | **Hybrid**: host-level activator intercepts; sleep/wake **state lives in git** (via the document model + processor). |
| Sleep status | **Reuse the existing `STOPPED` env status** for the slept state — no new status added. Ops `SLEEP_ENVIRONMENT` / `WAKE_ENVIRONMENT`. Frontend displays it as 💤 "sleeping". |
| Idle signal | **Proper requests only** — Traefik **JSON access logs in Loki**, excluding an automation denylist (`/_proxy/routes`, health/metrics/favicon/ACME paths, monitor user-agents). The bare Prometheus counter is insufficient (no path label). No agent changes. |
| Idle threshold | **~24 h** with no proper request (configurable). Conservative window keeps the signal safe. |
| Sleep scope | **Claimed studios only**: `poolState ∈ {null, CLAIMED}` ∧ `owner != null` ∧ tenant ∉ core set ∧ id ∉ never-sleep allowlist. Warm-pool (`WARMING`/`AVAILABLE`) envs stay hot. |
| Dashboard UX | Show `sleeping` state; click opens the host so the dashboard and direct-link paths converge on the activator spinner. Optional "sleep now". |
| Sleep flag | **Reuse `global.disabled`** (already wired through the chart); emitted whenever status is `STOPPED`. |
| Initial scope | **CLINT-agent studios first** (no Postgres); expand to full studios once CNPG data-retention is verified. |
| Detector cadence | ~15 min, **dry-run first**. |

## Architecture

Four areas of change:

### A. Reactor side — `vetra-cloud-package`

1. **Document model `vetra-cloud-environment`** — reuse the existing `STOPPED`
   status; add two operations in the `status_transitions` module:
   - `SLEEP_ENVIRONMENT`: `READY` (or `CHANGES_*`) → `STOPPED`.
   - `WAKE_ENVIRONMENT`: `STOPPED` → `DEPLOYING` (→ `READY` on success, via the
     existing deployment-report transitions).
   Reducers are pure: any timestamps (`sleptAt`, `wokeAt`) come from action
   input. Errors: `EnvironmentNotStoppableError`, `EnvironmentNotSleepingError`.
2. **Processor `gitops.ts`** — emit `global.disabled: true` when status is
   `STOPPED` (same code path as `TERMINATING`), and normal values when the
   env leaves `STOPPED`. The read model distinguishes `STOPPED`
   (wakeable) from `DESTROYED`/`ARCHIVED` (gone).
3. **New housekeeping subgraph** (`subgraphs/vetra-housekeeping/`) exposing:
   - `studioPowerState(host: String!): StudioPowerState` →
     `{ envId, subdomain, status: AWAKE|SLEEPING|WAKING|UNKNOWN, owner }`,
     resolved from the `Environments` read model by subdomain. Status mapping:
     env `STOPPED` → `SLEEPING`; env `DEPLOYING` with a `sleptAt` set
     (i.e. woken from sleep, not a first deploy) → `WAKING`; env `READY` →
     `AWAKE`; anything else / not found → `UNKNOWN`.
   - `sleepStudio(host: String!): StudioPowerState` — applies the eligibility
     predicate, dispatches `SLEEP_ENVIRONMENT`. Idempotent.
   - `wakeStudio(host: String!): StudioPowerState` — dispatches
     `WAKE_ENVIRONMENT` if `STOPPED`; no-op if already awake/waking.
     Idempotent.
   Eligibility + transition logic lives here (server-side, authorized) so both
   the detector and the frontend share one implementation.

### B. Housekeeping service — new standalone pod (mirrors `secrets-controller`)

A single long-running Node service with two responsibilities:

1. **Idle detector loop** (~15 min): queries **Loki** for Traefik access logs
   per host over the window, counting only **proper requests** (see *Idle
   signal* below) — those not matching the shared `isAutomationRequest`
   denylist. Eligible studios with **zero proper requests for ≥ threshold** get
   `sleepStudio(host)`. Dry-run mode logs intended sleeps without acting.
2. **Wake activator HTTP server** behind a wildcard `*.vetra.io` Ingress
   (catch-all, lower precedence than studios' exact-host ingresses):
   - On request, resolve host → env via `studioPowerState`.
   - **If the request is automation** (`isAutomationRequest` — e.g. the
     `/_proxy/routes` poller): return a cheap stub (`204`/empty) and **do not
     wake**. This is essential — otherwise the 15 s observability poller would
     re-wake every sleeping studio instantly.
   - Else if `SLEEPING`/`WAKING`: **content-negotiate** — a browser
     (`Accept: text/html`) gets a branded spinner page; anything else gets
     `503 + Retry-After`. Both trigger `wakeStudio(host)` (idempotent).
   - Tag activator responses with header `x-vetra-activator: 1`.

Config via env: `LOKI_URL`, `HOUSEKEEPING_IDLE_THRESHOLD` (default 24h),
`HOUSEKEEPING_SCAN_INTERVAL` (default 15m), `HOUSEKEEPING_DRY_RUN`,
`HOUSEKEEPING_ALLOWLIST`, `SWITCHBOARD_GRAPHQL_URL` (for the mutations).

### Idle signal: proper requests, not pings

The bare Prometheus counter `traefik_service_requests_total` only carries
`service`/`code`/`method` labels — **no path** — so it can't tell a page load
from a health ping. And studios get a lot of automated traffic: the
observability `clint-pull-worker` polls `https://<subdomain>.vetra.io/_proxy/routes`
**every 15 s** (~5,760 req/day/studio), so a naive "any HTTP" signal would mark
every studio active forever.

So we define a single shared predicate **`isAutomationRequest(path, userAgent)`**
(a denylist) and treat everything else as a *proper request*:

- **Paths**: `/_proxy/routes`, `/health`, `/healthz`, `/ready`, `/metrics`,
  `/favicon.ico`, `/.well-known/acme-challenge/*`.
- **User-agents**: known uptime/monitor agents, and the observability poller
  (tagged with a distinct UA — see area E).

**Signal source — Traefik JSON access logs in Loki.** Traefik access logging is
currently **off**; enable `--accesslog=true --accesslog.format=json` (keeping the
`User-Agent` header) on the Traefik deployment via gitops. Alloy already ships
Traefik's stdout to Loki, so no new shipper is needed. The detector then queries
Loki per host over 24 h, filtering out `isAutomationRequest`. Idle = no proper
requests in the window (a small non-zero floor is configurable to absorb
sporadic bots/scanners).

The **same predicate** runs at the activator (which sees each request's path
natively), so automation never triggers a wake.

### E. Observability worker — `subgraphs/vetra-cloud-observability`

- Tag the `clint-pull-worker` requests with a distinct `User-Agent`
  (e.g. `vetra-observability-pull`) so they're trivially filterable in Loki and
  at the activator.
- **Skip `STOPPED` studios** — a sleeping studio has nothing to report, and
  polling it would otherwise hit the activator every 15 s. This keeps the signal
  clean and prevents accidental wakes at the source.

### C. GitOps / infra — `powerhouse-k8s-hosting`

- **Enable Traefik JSON access logs** (`--accesslog=true --accesslog.format=json`,
  keep the `User-Agent` header) so per-request path/UA reach Loki via the
  existing alloy shipper — the data the idle signal depends on.
- Deployment + Service + RBAC for the housekeeping service (Loki read, and
  credentials/permission to call the switchboard mutations).
- Wildcard `*.vetra.io` Ingress on the activator as a catch-all, under the
  existing wildcard TLS cert.
- ArgoCD Application for the service (under `argocd-apps/infrastructure/`).

### D. Frontend — `vetra.io`

- Extend the studio status model with `sleeping` (maps to env `STOPPED`);
  render 💤 on the product card; clicking opens the host (activator handles the
  spinner). Optional "sleep now" calling `sleepStudio`.
- Reuse the existing boot-screen / "Provisioning…" spinner styling for the
  activator page so the experience is consistent.

## Flows

### Sleep

1. Detector finds eligible host with no proper request ≥ 24 h → `sleepStudio(host)`.
2. `SLEEP_ENVIRONMENT` → status `STOPPED` → processor commits
   `global.disabled: true` to `tenants/<tenantId>/powerhouse-values.yaml`.
3. ArgoCD removes Deployment/Service/Ingress. PVC, namespace, secrets, cert
   remain.
4. `<subdomain>.vetra.io` is now unrouted → falls through to the wildcard
   activator.

### Wake

1. User hits `https://<subdomain>.vetra.io` (asleep) → Traefik → activator.
2. Activator confirms the request is a proper request (not automation), resolves
   host → env (`SLEEPING`), serves the spinner page, calls `wakeStudio(host)`.
3. `WAKE_ENVIRONMENT` → `DEPLOYING` → processor commits normal values → ArgoCD
   restores workload + exact-host ingress; agent boots from its warm PVC.
4. Spinner polls every 3 s; readiness = the host root no longer returns the
   `x-vetra-activator` header (the exact ingress has reclaimed routing and the
   agent is healthy). Then it reloads → user lands in the studio.
5. Concurrent hits during wake all get the spinner; `wakeStudio` is idempotent.

## Edge cases & error handling

- **Automated traffic** (observability poller, monitors, ACME, bots): excluded
  by the shared `isAutomationRequest` denylist, so it neither blocks sleep nor
  triggers a wake. The poller is additionally tagged and skips `STOPPED`
  studios at the source.
- **Non-browser clients** to a sleeping host (genuine API/CLI): `503 +
  Retry-After` + JSON body; wake still triggered.
- **Wake failure / ArgoCD stuck**: spinner shows a timeout + retry after N
  minutes; env stays `STOPPED`. Detector never re-sleeps a
  `DEPLOYING`/`WAKING` env.
- **Race (traffic arrives as we sleep)**: rare given the 24 h floor; `wakeStudio`
  simply re-enables.
- **Full (switchboard + Postgres) studios**: `global.disabled` also drops CNPG —
  keep the data PVC via CNPG retain policy. Verified per-tenant before enabling
  sleep beyond CLINT studios. **Initial scope: CLINT-agent studios only.**
- **Wildcard precedence**: depends on Traefik preferring an exact host rule over
  `*.vetra.io`. Validated with a canary before rollout; fallback is a
  per-studio ingress repoint emitted by the processor when `STOPPED`.
- **Idempotency / concurrency**: `sleepStudio`/`wakeStudio` are safe to call
  repeatedly and concurrently; they reconcile to the target status.

## Testing

- **Unit:** `isAutomationRequest` denylist; eligibility predicate; Loki-result →
  idle decision (proper requests only); processor values emission for
  `STOPPED`/wake; reducers for `SLEEP_ENVIRONMENT` / `WAKE_ENVIRONMENT`;
  activator host→env resolution, automation short-circuit + content negotiation;
  readiness (sentinel header) check.
- **Integration:** sleep → wake round-trip against a test env (status
  transitions + emitted values); activator spinner → ready → reload; verify the
  observability poller's UA is excluded and does not wake a `STOPPED` studio.
- **Manual / canary:** confirm Traefik access logs land in Loki with path + UA;
  validate wildcard-vs-exact Traefik precedence on a canary host; verify a real
  studio sleeps and wakes end-to-end.

## Rollout

1. **Enable Traefik JSON access logs**; confirm they reach Loki with path + UA.
2. Ship document-model ops (`SLEEP_ENVIRONMENT`/`WAKE_ENVIRONMENT`) + processor
   + subgraph + observability
   poller changes; deploy the activator and validate the catch-all + canary
   precedence (no detector yet).
3. Run the detector in **dry-run** — log what it would sleep (proper-request
   counts per host), and sanity-check the denylist against real logs.
4. Enable for a 1–2 studio allowlist; verify sleep + wake.
5. Flip to the full eligible set (CLINT studios).
6. Later: verify CNPG retain and extend to full switchboard + Postgres studios.

## Out of scope (YAGNI)

- Agent-activity-aware idle detection (autonomous background work) — revisit if
  the 24 h proper-request signal proves too aggressive.
- Scaling Postgres to zero for full studios — deferred to phase 5.
- Predictive pre-warming / scheduled wake.
