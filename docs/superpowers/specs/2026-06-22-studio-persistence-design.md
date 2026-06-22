# Studio Persistence Across Restarts — Design

**Date:** 2026-06-22
**Status:** Approved (brainstorming) — pending spec review
**Repos touched:** `powerhouse-k8s-hosting` (chart), `vetra-cloud-package` (gitops processor)

## Goal

A claimed Vetra Studio's documents, projects, and agent state survive **every**
pod restart — version bump, OOM, node drain, and the claim-time Reloader bounce.

## Problem / Root cause

Clint agent pods are a plain `Deployment` with `strategy.type: Recreate` and
**no persistent storage**:

- `powerhouse-k8s-hosting/powerhouse-chart/templates/clint-deployment.yaml:18,31` —
  `kind: Deployment`, `strategy: Recreate`, **no `volumes:` / `volumeMounts:`**.
- The reactor stores all documents as PGlite (embedded Postgres-on-filesystem)
  at `.ph/<cli-name>/reactor-storage/` inside the **ephemeral container
  filesystem** (ph-clint `src/core/store.ts:48-56`, `integrations/powerhouse/reactor.ts:101`).
- `processors/vetra-cloud-environment/gitops.ts:430-567` (`generateClintBlock`)
  emits no storage directive.

Switchboard/registry/rupert all persist (CNPG or PVC); clint persists nothing.
Any pod replacement discards `.ph/.../reactor-storage/` and the user's work is gone.

## Approach (chosen: A — Deployment + RWO PVC)

Give each clint agent its **own `ReadWriteOnce` PVC**, mounted at the reactor
storage path. `strategy: Recreate` (already set) is exactly the constraint a
single RWO volume needs — the old pod releases the volume before the new pod
attaches. No claim-time pod-spec change, so the single-restart claim work is
preserved; the PVC exists from provision time and is simply re-attached on
every restart.

Rejected alternatives:
- **B (reactor → per-tenant CNPG Postgres):** truly durable + backup-friendly,
  but studios use PGlite and don't all have CNPG; provisioning Postgres per pool
  env is heavy and needs a ph-clint storage-driver change. Revisit if/when we
  want backups or multi-replica. Out of scope.
- **C (PVC only on claim):** adding a volume mount is a pod-spec change →
  gitops re-render → an extra restart on claim (regresses single-restart). And
  at claim time the user has no data yet, so nothing is saved by waiting. Rejected.

## Storage class decision (OPEN — confirm in review)

The cluster (k3s/Hetzner) has:
- `hcloud-volumes` (default): Hetzner CSI block storage, RWO, **10Gi minimum per
  volume**, and Hetzner caps volumes-per-node (~16). At studio scale (dozens of
  pods across a few nodes) the per-node attach cap becomes a hard ceiling, and
  every studio costs a 10Gi block device.
- `longhorn`: software-defined replicated storage, **no size floor**, no per-node
  attach cap (uses node disk + replication).

**Recommendation: `longhorn` for studio PVCs**, sized ~2Gi. Avoids the 10Gi
floor and the Hetzner per-node attach ceiling, which is the real scaling risk.
Trade-off: longhorn consumes node disk and replicates. If the user prefers
hardware isolation over density, fall back to `hcloud-volumes` at 10Gi.

## Components & data flow

1. **Chart: new `clint-pvc.yaml` template** (`powerhouse-chart/templates/`)
   - One PVC per agent, named off the existing `powerhouse.clintResourceName`
     helper (same name the deployment/ingress already use).
   - `accessModes: [ReadWriteOnce]`, `storageClassName` from
     `$.Values.clint.storageClass` (default per decision above),
     `resources.requests.storage` from `$agent.storage | default "2Gi"`.
   - Gated on the same `$agent.ingress`-style enable check used in
     `clint-deployment.yaml` (only real studio agents get a PVC).
   - Use `$.Values` (not `.Values`) inside the `range $agent` — the cert-issuer
     nil-pointer regression (`clint-ingress.yaml:29`) is the cautionary precedent.

2. **Chart: mount in `clint-deployment.yaml`**
   - Add a `volumes:` entry referencing the PVC and a `volumeMounts:` entry.
   - **Mount path:** persist `.ph/<cli-name>/reactor-storage/` *without masking
     image files*. The workdir is `process.cwd()` (`/home/clint/workspace` per
     live pod logs). Mounting the whole `.ph` risks masking image-baked config;
     mounting exactly `<workdir>/.ph/<cli>/reactor-storage` requires the cli name
     at template time. **Resolve the exact subpath during planning** by reading
     ph-clint's `getStoreFolder('reactor-storage')` resolution; prefer a
     `subPath` mount scoped to reactor-storage only.

3. **Processor: `generateClintBlock` emits storage size**
   (`vetra-cloud-package/processors/vetra-cloud-environment/gitops.ts`)
   - Emit `clint.agents[].storage` (e.g. `"2Gi"`) and, if not cluster-wide,
     `clint.storageClass`, so the chart renders the PVC. Mirror the existing
     `certClusterIssuer` emit pattern.

## Error handling / edge cases

- **Recycle / delete:** the namespace-reaper deletes orphaned tenant namespaces;
  namespace deletion cascades the PVC (StorageClass reclaim `Delete`). No new
  cleanup path needed. Verify a reaped namespace also releases its PVC/PV.
- **WaitForFirstConsumer (hcloud):** binding waits for pod scheduling — fine for
  Recreate. longhorn binds Immediate.
- **Stuck volume on node failure:** RWO re-attaches on reschedule (brief
  downtime) — accepted posture per the storage-posture decision.
- **Pool churn:** unclaimed warm envs each hold an (empty) PVC. Cost is one small
  empty volume per idle env — negligible under longhorn.

## Testing

- **Chart render (TDD):** `helm template` a tenant values fixture with a clint
  agent → assert a PVC is rendered with the right name/size/class and the
  deployment has the matching volume + volumeMount subPath. Add to the existing
  chart test harness.
- **Processor (TDD):** extend `gitops.test.ts` — given an env with a CLINT
  service, `generateClintBlock` emits the `storage` field.
- **Live verification (staging):** provision/claim a studio, create a document,
  delete the pod (`kubectl delete pod`), confirm the document survives the new
  pod. Then bump `STUDIO_POOL_VERSION` (forces recycle) on a *claimed* env and
  confirm persistence across the version restart.

## Out of scope

- Backups / snapshots of studio volumes.
- Multi-replica agents (RWO precludes it; would need B or RWX).
- Migrating reactor storage off PGlite.
