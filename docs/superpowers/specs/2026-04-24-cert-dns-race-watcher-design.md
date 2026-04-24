# Fast, smooth environment provisioning: DNS-01 certs, watcher correctness, perf polish

**Date:** 2026-04-24
**Status:** Approved for implementation

## Problem

Two correctness bugs plus a pile of latency in the create-env → healthy
HTTPS path.

1. **First-provision cert race.** cert-manager starts HTTP-01 as soon as
   an Ingress is applied. external-dns publishes the A record on its own
   ~1min cadence, Hetzner authoritative DNS takes a few seconds more, and
   Let's Encrypt's validator won't wait — NXDOMAIN → `Challenge=invalid`.
   cert-manager's own retry policy doesn't auto-recover stuck invalid
   Challenges quickly; users see "TLS invalid" for tens of minutes or
   hours. Observed live today on `prime-robin-94-8b6aa6ef`.
2. **Watcher heuristic is wrong for apex mode.** The Domain card's
   status comes from `checkCustomDomain` in
   `subgraphs/vetra-cloud-observability/watchers.ts`, which picks an
   Ingress by `name.includes("-custom-")`. Under apex routing the
   user's custom host lives on a *primary* ingress with no `-custom-`
   in its name, so the card reports status of a secondary host (or
   none at all). Also breaks non-apex mode when the user thinks of
   "their custom domain" as `admin.vetra.io` but no single ingress
   serves that exact host.
3. **Apex env provisioning is ~5min worst case.** Broken down:
   argo polls git every 180s (up to 3min waiting), CNPG bootstrap
   takes 60-90s (even when the env has no switchboard and doesn't
   need Postgres), HTTP-01 cert takes 1-5min under the race above.
   For admin-style Connect-only envs this stacks to a multi-minute
   wait on every create or edit.

## Goals

- New environments reach "valid HTTPS on the user's custom domain"
  in well under a minute under normal conditions.
- Domain card in the UI accurately reflects the configured custom
  domain in both apex and non-apex modes.
- Operational escape hatch for cert-manager races on external customer
  domains (where HTTP-01 is still the only option).
- No regression for any existing tenant.

## Non-goals

- Wildcard certs per tenant (would compress cert count / rate-limit
  headroom, but orthogonal to the above and worth its own design).
- Rate-limit tracking or proactive pre-issuance.
- Custom-domain DNS for non-`vetra.io` zones automated end-to-end.
  External customers keep managing their own DNS.

## Design

### Component 1 — DNS-01 via Hetzner webhook (`vetra.io`)

The first-provision race is structural with HTTP-01: it requires the
host to be reachable via public DNS before the challenge can pass.
DNS-01 writes a TXT record via API instead — no dependency on
external-dns, no ingress reachability required. cert-manager supports
multi-solver `ClusterIssuer`s with a `selector`, so we can use DNS-01
inside our own zone and keep HTTP-01 as a fallback for external
domains.

**What ships:**

- **New Argo app** `argocd-apps/infrastructure/cert-manager-webhook-hetzner.yaml`
  installing the `vadimkim/cert-manager-webhook-hetzner` Helm chart
  (community-maintained, targets the same Hetzner DNS Console API v1
  that the existing external-dns webhook uses — compatibility
  confirmed before merge). Namespace: `cert-manager`.
- **New ExternalSecret** `infrastructure/cert-manager/hetzner-dns-token.yaml`
  pulling the Hetzner DNS API token from OpenBao
  (`powerhouse/shared/hcloud/token` — same KV path external-dns
  already consumes) into Secret `hetzner-dns-token` in the
  `cert-manager` namespace. Sync-wave `-5` so it lands before the
  ClusterIssuer referencing it.
- **ClusterIssuer update** in `infrastructure/cert-manager/letsencrypt-issuer.yaml`
  for both `letsencrypt-prod` and `letsencrypt-staging`:
  ```yaml
  solvers:
    - selector:
        dnsZones: ["vetra.io"]
      dns01:
        webhook:
          groupName: acme.vetra.io
          solverName: hetzner
          config:
            secretName: hetzner-dns-token
            secretKey: token
    - http01:
        ingress:
          class: traefik
  ```
  Certificate resources for any name inside `vetra.io` (including
  `admin.vetra.io`, `switchboard.prime-robin-94.vetra.io`, etc.) pick
  DNS-01. Everything outside falls through to HTTP-01, unchanged.

**Rollout order:** deploy the webhook chart first, verify its pod is
Ready and webhook registration succeeds in `cert-manager` logs, *then*
update the ClusterIssuers. Argo sync waves enforce this.

### Component 2 — Stuck-challenge reconciler

With DNS-01, the race disappears for `vetra.io`. But the moment we onboard
an external customer domain the HTTP-01 race returns, and operators
shouldn't have to manually `kubectl delete certificate` every time.

A small periodic job added to `VetraCloudObservabilitySubgraph` (same
pattern as `startDeploymentReconciler`), running every 2 minutes:

1. List all `Challenge` resources cluster-wide whose
   `status.state == "invalid"`.
2. For each, check three predicates, ALL required:
   - `status.reason` contains the substring `NXDOMAIN` — narrows to the
     specific race we're solving, not e.g. webhook failures.
   - `resolve4(spec.dnsName)` (via `node:dns/promises`) returns at least
     one of the cluster's known LoadBalancer IPs (`138.199.129.93` /
     the IPv6 `2a01:4f8:c01e:796::1`). Prevents looping when the
     user's DNS points somewhere unrelated.
   - Last deletion of this Certificate (tracked via
     `vetra.io/last-retry` annotation the reconciler writes) is older
     than 15 minutes.
3. When all three hold, delete the owning `Certificate`. cert-manager
   recreates it from the Ingress shim and issues a fresh Order. Write
   the `vetra.io/last-retry` annotation on the new Certificate so we
   don't delete it again immediately.

Bounded blast radius: only invalid+NXDOMAIN+points-at-us+cooldown.
Adds no load to the happy path.

**RBAC:** the observability subgraph ServiceAccount in the `staging`
namespace needs cluster-wide permissions on
`cert-manager.io/v1:Certificate` (get, list, delete, patch — patch for
the annotation) and `acme.cert-manager.io/v1:Challenge` (get, list).
Add to `infrastructure/vetra-observability-rbac/rbac.yaml`.

### Component 3 — Watcher: match by configured custom domain

Replace the `-custom-` name heuristic in `checkCustomDomain` with an
authoritative lookup against what the env actually configured.

**Signature change:**

```ts
async function checkCustomDomain(
  kc, coreApi, networkingApi,
  tenantId: string,
  customDomain: string | null,
): Promise<DomainCheck>
```

The outer reconcile loop (around line 389 of `watchers.ts`) fetches
`customDomain` from the processor's `environments` table — already
exposed as a column, already reachable via the subgraph's
`envDb` namespace — and passes it in.

**Matching logic:** find every Ingress in the tenant namespace whose
`spec.rules[].host` is either `customDomain` OR ends with
`.<customDomain>`. This unifies both modes:

- Apex mode: the single apex ingress has host = customDomain — matches
  the first branch. Additional ingresses for non-apex services (e.g.
  `switchboard.admin.vetra.io` when connect is at apex) match the
  suffix branch.
- Non-apex mode: all services live at `<svc>.<customDomain>` — the
  suffix branch matches them all.

**Aggregate reporting:** run the existing DNS + TLS-secret check
against every matched ingress. Report:

- `domainResolves`: `true` only if all matched hosts resolve; `false`
  if any don't; `null` if there are no matches.
- `tlsCertValid`: same aggregation.
- `tlsCertExpiresAt`: earliest expiry among valid certs (so the UI
  can show the closest renewal date).

If the env has `customDomain == null` the reconcile loop skips the
check entirely — `domainResolves: null`, `tlsCertValid: null`. The
UI's Domain card is already gated on `hasCustomDomain`, so this
renders cleanly.

### Component 4 — Conditional CNPG (processor, perf)

`processors/vetra-cloud-environment/gitops.ts::generateValuesYaml`
currently hardcodes `database.cnpg.enabled: true`. Connect-only envs
don't need Postgres — CNPG bootstrap dominates the ~60-90s provisioning
cost with no benefit. Switchboard *does* need it.

Change:

```ts
const needsDatabase = switchboardEnabled;
// …
database:
  cnpg:
    enabled: ${needsDatabase}
```

Disabled CNPG still renders the block in the chart (so toggling on
later picks it up without schema changes). Existing tenants with
switchboard enabled are unaffected.

Also drops the `envFrom.secretRef` to the tenant-secrets Secret on
connect when CNPG is off, since that secret is switchboard-owned and
meaningless without the database.

### Component 5 — Reconciler tick 30s → 10s (perf)

`startDeploymentReconciler` runs every 30s. With the webhook-driven
argo refresh (already in place as of 2026-04-24, just corrected the
HMAC mismatch), argo reacts to a push within ~1s; the reconciler is
now the dominant wait on the UI's "did it become READY yet?" loop.

Dropping the interval to 10s trims up to 20s off the perceived
latency of every edit. Query cost is negligible (two indexed selects
and a join per tenant, current count <40).

### Component 6 — Tune readiness probe delays (perf)

The processor's chart values in `generateValuesYaml` set:

```yaml
switchboard:
  livenessProbe.initialDelaySeconds: 120
  readinessProbe.initialDelaySeconds: 60
connect:
  livenessProbe.initialDelaySeconds: 120
  readinessProbe.initialDelaySeconds: 60
```

`readinessProbe.initialDelaySeconds: 60` means traefik won't route
traffic to the pod for 60s minimum — even when the service process is
listening in <15s. That's the single biggest remaining contributor to
perceived wait on a fresh env.

Change readiness initial delay to `15` on both connect and switchboard
(observed cold-start is ~10s for connect, ~15s for switchboard). The
probe itself (periodSeconds: 10/5, failureThreshold: 6) still guards
against routing to an unready pod — it just doesn't idle uselessly
first. Liveness stays at 120s: its job is to catch runaway processes,
not speed up rollout.

Net effect: ~45s shaved off Connect-only env provisioning.

## Combined impact

End-to-end "click Approve → valid HTTPS" for an admin-style
Connect-only apex env:

| Phase | Before | After |
|---|---:|---:|
| git push → argo sees it | up to 180s | ~1s (webhook, corrected) |
| CNPG bootstrap (Connect-only env) | 60-90s | 0s (skipped, Component 4) |
| Cert issuance | 1-5min | ~10s (DNS-01, Component 1) |
| Pod start + readiness | 30-60s | ~15s (Component 6) |
| Reconciler → READY | up to 30s | up to 10s (Component 5) |
| **Total** | **~5 min** | **~20-30 sec** |

For envs that need Switchboard + Postgres the total stays gated on
CNPG (~60-90s) but everything else collapses to seconds.

## Error handling

- **Hetzner webhook pod down**: cert-manager reports "webhook: no
  available endpoints" on DNS-01 attempts for vetra.io. Monitoring
  alert (existing kube-prometheus-stack pod-down rule covers it).
  No silent data loss.
- **Hetzner DNS API rate-limited / down**: cert-manager retries with
  its own backoff. Component 2 does not trigger (reason doesn't match
  NXDOMAIN).
- **DNS points at wrong IP**: Component 2's LB-IP predicate blocks
  deletion. User sees "TLS invalid" and has to fix their DNS. Correct
  outcome.
- **Let's Encrypt rate limit** (50 certs/week per registered domain):
  unchanged risk. Mitigation (wildcard cert per tenant) is future work.
- **Watcher can't find matching ingress**: returns `{ null, null, null }`
  → UI shows "—" rather than wrong status.
- **Token rotation**: external-dns and cert-manager both consume
  `powerhouse/shared/hcloud/token`; rotating there updates both via
  ESO's refresh interval (~1h).

## Testing

- **Component 1**: deploy webhook chart to staging cluster first;
  switch `letsencrypt-staging` to multi-solver; issue a cert for a
  throwaway `*.vetra.io` host; verify TXT record lifecycle (created,
  validated, deleted) via Hetzner DNS Console. Only after that
  succeeds, flip `letsencrypt-prod`.
- **Component 2**: unit-test the three predicates in isolation
  (NXDOMAIN, LB-IP resolution, cooldown). Integration: park a stuck
  invalid Challenge, publish DNS, wait 2min, confirm cert re-issued.
- **Component 3**: unit-test `checkCustomDomain` with three fixtures
  — apex (connect ingress host matches), non-apex (multiple
  `<svc>.<customDomain>` ingresses match, aggregate reports all green),
  no-custom-domain (returns null triple). Plus a fourth fixture
  for mid-rollout (one ingress has valid cert, one doesn't → aggregate
  reports false).
- **Component 4**: provision a new Connect-only env; verify no
  `Cluster` / `Pooler` CRs exist in its namespace and the values.yaml
  has `database.cnpg.enabled: false`.
- **Component 5**: visually verify in staging — edit an env, watch
  the status badge flip within ~15s of argo completing the sync.
- **End-to-end**: create a fresh env with a new `admin-dev.vetra.io`
  custom domain, apex=Connect, time from Approve to
  `curl https://admin-dev.vetra.io` returning 200 with valid TLS.
  Target: <60s.

## Rollout order

Each component is independently deployable.

1. Component 1 (webhook chart + staging ClusterIssuer → prod
   ClusterIssuer). Pure gitops in `powerhouse-k8s-hosting`; no
   package release needed.
2. Components 3 + 4 + 5 together in one `vetra-cloud-package` release
   (they all touch the observability subgraph / processor). Publish
   `0.0.3-dev.*`, bump staging's tenant values, argo rolls.
3. Component 2 last, same package release cadence, gated on the RBAC
   change landing first.

## Deferred / out of scope

- **Wildcard cert per tenant.** Would cover all service hostnames
  under a single certificate and ease rate-limit pressure.
  Independent design.
- **End-to-end DNS for external customer domains.** Would require
  a per-customer DNS provider integration or a delegated zone. Out of
  scope.
- **Dropping `-custom-` ingress naming.** The name pattern still
  leaks into templates; could be tidied, but the watcher change
  no longer depends on it and there's no correctness reason to rename.
