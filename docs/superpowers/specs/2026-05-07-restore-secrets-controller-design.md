# Restore Standalone `secrets-controller` Deployment

**Status:** spec, in progress
**Drives:** secrets configured via vetra.to's Configuration tab actually reach pods (switchboard, connect, agents) in every env, including agent-only envs.

## Problem

Today, env-vars and secrets configured via vetra.to's Configuration tab are encrypted and persisted to Postgres correctly, but never reach pods. The reconcile loop that materializes them as `<tenant>-env` ConfigMap and `<tenant>-secrets` Secret in each tenant namespace runs inside the management switchboard's `vetra-cloud-secrets` subgraph (PR #4, Apr 20). The management switchboard's ServiceAccount has no cross-namespace RBAC, so every reconcile attempt fails:

```
[k8s] cannot create Secret <tenant>/<tenant>-secrets
      (namespace missing or RBAC not applied); skipping
```

All `envFrom` references in the chart are `optional: true`, so pods boot without the values — silent failure. Agents are doubly affected: even if the secret existed, the chart's `clint-deployment.yaml` doesn't reference it (only `connect-deployment.yaml` and `switchboard-deployment.yaml` do).

## Decision

Restore the standalone `secrets-controller` Deployment that was removed by PR #4 ("embed controller into subgraph, drop separate service"). Keep the GraphQL side of the `vetra-cloud-secrets` subgraph in switchboard, but move the reconcile loop back into a dedicated pod with its own ServiceAccount and ClusterRole.

This was the original architecture (PR #2, Apr 2). The embed-into-subgraph refactor traded operational simplicity for runtime locality, but missed that the runtime locality was load-bearing — the standalone controller had a ClusterRole the switchboard SA does not. We're un-trading.

## Architecture

```
┌────────────────────────┐
│ vetra.to Configuration │   user edits env-var or secret
│ tab                    │
└───────────┬────────────┘
            ▼
┌────────────────────────┐
│ vetra-cloud-secrets    │   GraphQL resolvers in management
│ subgraph (switchboard) │   switchboard. Encrypts via OpenBao
│                        │   Transit per-tenant key, writes
│                        │   row, calls pg_notify.
└───────────┬────────────┘
            ▼
        ┌───────┐
        │  PG   │   `secrets` + `env_vars` tables
        └───┬───┘
            │ NOTIFY vetra_secrets_changed
            ▼
┌────────────────────────┐
│ secrets-controller     │   Listens for NOTIFY, reconciles per-tenant
│ (new Deployment in     │   on demand. 5-min safety-net sweep covers
│  vetra-cloud-          │   missed notifications. Startup full sweep
│  environments ns)      │   converges on boot.
│                        │
│   Decrypts via         │
│   OpenBao Transit      │
│   (per-tenant key).    │
│                        │
│   Upserts:             │
│     <ns>/<ns>-env CM   │
│     <ns>/<ns>-secrets  │
└───────────┬────────────┘
            ▼ envFrom (optional: true)
┌────────────────────────┐
│ tenant pods            │   switchboard, connect, AND agents
│ (any namespace)        │
└────────────────────────┘
```

## Components

### vetra-cloud-package

- **New:** `secrets-controller/main.ts` thin entry point that wires up the existing reusable pieces from `subgraphs/vetra-cloud-secrets/`:
  - `repository.ts` — Kysely-backed reads of env-vars + secrets rows
  - `k8s-client.ts` — `upsertConfigMap` / `upsertSecret` with idempotent diff-and-patch
  - `openbao-transit.ts` — per-tenant decrypt
  - `reconciler.ts` — combines the three above; `reconcileTenant` and `reconcileAll`
  - `postgres-listener.ts` — wraps `pg` with reconnect + backoff, fires per-tenant reconcile on `NOTIFY`, full sweep after reconnect
- **New:** `secrets-controller/health.ts` — `/healthz` (listener connected) and `/readyz` (startup full sweep done) for k8s probes.
- **Removed from subgraph:** the reconcile-loop bootstrap inside `subgraphs/vetra-cloud-secrets/index.ts` (`onSetup` calls `safeReconcileAll` and binds the listener). The subgraph keeps its GraphQL `resolvers.ts` + `schema.ts`. With the loop gone, the subgraph is back to a pure GraphQL service.
- **New:** Dockerfile target `secrets-controller` (multi-stage build, ts → js → node alpine runtime, ~150MB).
- **CI:** `.github/workflows/sync-and-publish.yml` build matrix gains `secrets-controller`. Image pushed to `cr.vetra.io/powerhouse-inc-vetra-cloud-package/secrets-controller:<tag>` on each release.

### powerhouse-k8s-hosting

- **New:** `argocd-apps/infrastructure/secrets-controller.yaml` — ArgoCD Application targeting an in-repo Helm chart at `infrastructure/secrets-controller/`. Sync wave 2 (after CRDs / cert-manager).
- **New:** `infrastructure/secrets-controller/Chart.yaml` + `values.yaml` + `templates/`:
  - `serviceaccount.yaml` — `secrets-controller` SA in `vetra-cloud-environments` ns
  - `clusterrole.yaml` — verbs `get/list/create/update/patch` on `secrets` and `configmaps` cluster-wide. **Trust-the-controller-code** model: same pattern external-secrets and cert-manager use; Kubernetes doesn't allow `resourceNames` globs, so we can't tighten further at the RBAC layer.
  - `clusterrolebinding.yaml`
  - `deployment.yaml` — single replica, `image: cr.vetra.io/.../secrets-controller:<tag>`, env: `DATABASE_URL` (from secret), `OPENBAO_ADDR`, `OPENBAO_TOKEN_FILE`, `FULL_RECONCILE_INTERVAL_MS=300000`, liveness `/healthz`, readiness `/readyz`.
- **Modified:** `powerhouse-chart/templates/clint-deployment.yaml` adds `envFrom` to each agent container, mirroring switchboard:
  ```yaml
  envFrom:
    - configMapRef:
        name: {{ printf "%s-env" $.Release.Namespace | quote }}
        optional: true
    - secretRef:
        name: {{ printf "%s-secrets" $.Release.Namespace | quote }}
        optional: true
  ```
  `optional: true` so an agent still boots if the controller hasn't reconciled yet (cold-start / first-deploy ordering).

## Data flow & ordering

1. User saves a secret/env-var in vetra.to → switchboard's `setSecret`/`setEnvVar` mutation encrypts via OpenBao Transit and INSERTs into Postgres → emits `NOTIFY vetra_secrets_changed` with the tenant id.
2. `secrets-controller` receives the notification → reads the tenant's full row set → decrypts → upserts the ConfigMap and Secret in the tenant ns.
3. Existing pods don't auto-restart on Secret change — switchboard's chart already has Reloader annotations; clint-deployment will get the same annotations to pick up updates without manual restart. *(Verify: Reloader is installed cluster-wide. If not, mark as a follow-up.)*
4. New pods (agent provision, env recreation) get the values via `envFrom` on first start because `optional: true` accepts a missing target — once the controller writes the Secret, subsequent pod restarts pick up the values.

## RBAC scope

The ClusterRole grants:

```yaml
- apiGroups: [""]
  resources: ["secrets", "configmaps"]
  verbs: ["get", "list", "create", "update", "patch"]
```

Not delete (controller never deletes; tenants are torn down via namespace deletion). Cluster-wide because tenants live in their own namespaces; we trust the controller to only touch the documented two name patterns.

## Migration

- After the controller deploys: startup full sweep runs through every tenant in the DB and writes their `<tenant>-env` / `<tenant>-secrets` for the first time. No backfill script needed; the existing reconcile logic IS the backfill.
- Existing switchboard / connect pods receive their values on next restart (or immediately via Reloader).
- Existing agent pods need a one-time restart to pick up the chart's new `envFrom`. ArgoCD sync of the chart change creates a new ReplicaSet → rolling restart.
- The embedded reconciler (currently in switchboard) needs to be removed in the same release that ships the standalone controller — otherwise both would race. PR ordering: vetra-cloud-package change first (image published, embedded loop removed), then k8s-hosting (deploys controller, updates clint chart).

## Out of scope for v1

- **Per-agent secret scoping.** Spec keeps env-level shared secrets (same as switchboard / connect). If a future agent needs an isolated secret another agent shouldn't see, that's a follow-up that adds per-agent secret references to the doc model.
- **vetra.to UI changes.** Configuration tab is the editing surface and stays as-is.
- **Package serialization bug** (`null/contributor-billingnull` in gitops yaml) — separate issue noticed during investigation, fix in a different PR.
- **OpenBao token rotation.** The controller reads its OpenBao token from the same source the management switchboard does today; no change.

## Risks

- **Cluster-wide write on Secrets/ConfigMaps.** Single-purpose pod, controlled cluster, narrow image surface. Equivalent risk profile to external-secrets which already has this. Mitigation: keep the controller image lean and audit-able; don't expose any external network surface.
- **Race between embedded reconciler and standalone controller during migration.** Mitigated by ordering the PRs: ship vetra-cloud-package's PR (which removes the embedded loop) and the controller image build first, then the k8s-hosting PR that deploys the controller. Worst case during the few minutes of overlap: idempotent upserts may write twice — both end up at the same final state.
- **`pg_notify` dropped during controller restart.** Safety-net 5-min sweep covers gap. Worst-case data freshness: 5 minutes after a notification was missed.
- **Cold start ordering on a fresh tenant.** New tenant ns created → first agent / switchboard pod starts before the controller has written the Secret. `optional: true` lets the pod boot with no values, and a Reloader annotation (already on switchboard, to be added on clint) restarts the pod once the Secret lands. Without Reloader, pod needs a manual restart on first cold start; flag for follow-up if Reloader isn't in the cluster.

## Implementation order

1. **vetra-cloud-package PR** — restore `secrets-controller/main.ts` entry point reusing the existing subgraph code, remove the embedded reconcile loop from the subgraph, add Dockerfile target, add CI matrix. Merge → publishes image.
2. **k8s-hosting PR (1 of 2)** — add the ArgoCD app + Helm chart for `secrets-controller`. ArgoCD syncs → controller starts → startup sweep populates every tenant.
3. **k8s-hosting PR (2 of 2)** — `clint-deployment.yaml` `envFrom` + Reloader annotation. ArgoCD syncs → existing agents get rolling-restarted with envFrom. New agents pick up the values on first start.
