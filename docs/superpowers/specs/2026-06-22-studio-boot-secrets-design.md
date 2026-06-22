# Studio Boot Without Secrets — Design

**Date:** 2026-06-22
**Status:** Approved (brainstorming) — pending spec review
**Repos touched:** `vetra-cli` (run script), `powerhouse-k8s-hosting` (chart probe),
`vetra-cloud-package` (gitops processor — probe/gate config emit)

## Goal

A studio pod never serves a **demo/keyless** agent to a user. "No usable key
yet" is a non-serving state (pod not Ready, not routed) that resolves itself
once the key arrives, rather than a baked-in broken agent.

## Problem / Root cause

- vetra-cli reads the Anthropic key **once at `cli.bootstrap()`** and caches the
  agent in `rt.mastraAgent` (`vetra-cli/src/mastra/index.ts:20`,
  `src/agents/agent.ts:36-48`). If the key is absent at boot, it bakes in the
  **demo agent** (`src/agents/demo-agent.ts`) or, with `requireApiKey=true`,
  throws.
- A warm pod boots against an **empty `<tenant>-secrets` stub**
  (`powerhouse-chart/templates/tenant-config-bootstrap.yaml:32-49`). On **claim**,
  `claim.ts:100-104` writes the key → Reloader (`clint-deployment.yaml:54`)
  rolls the deployment → the **new** pod boots *with* the key → real agent.
- **No readiness/liveness probe** on clint (`clint-deployment.yaml:171-177`), so
  a half-broken/demo pod is routed as if healthy.
- The running image's entrypoint (`/usr/local/bin/vetra-run.sh`, dated Jun 15)
  has **no key gate** — it just `exec`s `SERVICE_COMMAND` (`vetra`). The user's
  "wait on the API key" Dockerfile step is newer/undeployed.

### Debug evidence (staging, 2026-06-22)

- Claimed studio `brave-cod-4592c2c3-5b235e71`: all three key env vars SET
  (len 108), `✓ vetra-studio is ready`, serving. **Key-present boots work.**
- `warm-eel-25` CrashLoopBackOff (650) is **unrelated** — a `ph-apeiron` full
  env failing `sh: ph-apeiron: not found` (exit 127, missing binary), not a
  studio secret-timing issue.
- A persistent "broken after restart" could **not** be reproduced on live pods;
  all current pods are 2d old / 0 restarts. The genuine risk is the transient
  keyless first boot baking a demo agent and a pod being routed before ready.

## Approach (chosen, REVISED to readiness-probe-only)

### The entrypoint gate was dropped — it is a verified regression

The original plan added an entrypoint key-gate that exits when
`VETRA_REQUIRE_API_KEY` is set and no key is present. **Live verification killed
it.** A warm (unclaimed) pool pod `amber-ant` runs with
`VETRA_REQUIRE_API_KEY=SET`, **all three key vars UNSET**, yet `ready=true`,
**0 restarts**, for 2 days. `requireApiKey=true` + no key is the *normal,
healthy* warm-pool state: `createAgent` is lazy and `assertCredentialIfRequired`
(`vetra-cli/src/agents/require-key.ts:13-25`, called from `agent.ts:42`) only
throws **at agent-run time**, never at boot. A boot gate would crashloop every
warm pod for its entire unclaimed life — a regression of the warm-pool-healthy
invariant. The existing lazy guard already prevents silent demo-serving on a
claimed-but-keyless pod (it throws "not provisioned, retry" rather than serving
demo), so no boot gate is needed for that protection.

### Readiness probe (chart) — the shipped change

Add a `readinessProbe` (tcpSocket on the `http`/8080 port) to the clint
container in `clint-deployment.yaml`. The pod is **NotReady → not routed** until
the in-pod proxy is listening, closing the brief Recreate-restart gap. Tolerant
thresholds (initialDelay 10s, period 10s, failureThreshold 6) so a ~16s boot
never flaps; warm key-less pods stay Ready (they listen). Liveness deferred.

**Gated on `$agent.storage`** (same condition as the persistence volume in
Spec 1). This is deliberate: the probe is a pod-template change, and applying it
unconditionally would force ArgoCD (selfHeal on) to roll **every** existing
clint pod — including claimed studios that do not yet have a PVC, wiping their
ephemeral data (the very thing persistence fixes). Gating couples the probe to
the persistence rollout: only envs being (re)rendered with `storage` get both,
so existing un-persisted pods are untouched until they naturally re-render.
Once all envs carry `storage`, the gate is effectively universal.

### Processor emit (gitops)

`generateClintBlock` emits `storage` per clint agent (Spec 1); that single field
drives both the PVC/mount and the readiness probe in the chart. No probe-config
emit is needed — the probe is fixed (tcpSocket :8080) in the template.

## Follow-up (NOT in this spec): B — lazy per-invocation key

The robust end-state is the "Task 4" data-plane lever: vetra-cli re-resolves the
key when it changes and rebuilds the agent **without any restart**, eliminating
the keyless window entirely. It touches the mastra agent lifecycle (the agent is
currently cached once at bootstrap). Documented here as a separate fast-follow
spec; not blocked on it.

## Error handling / edge cases

- **Warm-pool health preserved:** no boot gate, so `requireApiKey=true` warm
  pods keep booting healthy (lazy guard throws only at agent-run).
- **No fleet restart:** the probe is gated on `$agent.storage`, so applying the
  chart change does not roll existing un-persisted pods.
- **Persistence interaction (Spec 1):** a claimed pod that briefly lacks a key
  errors clearly at agent-run (existing guard) rather than serving demo; once
  the key lands it serves the real agent and writes to the persistent volume.

## Testing

- **Chart render (TDD):** `helm template` → the storage-enabled clint container
  has the readinessProbe (tcpSocket :8080); a no-storage agent has none (and is
  unchanged, so it won't roll). Validated via `kubectl apply --dry-run=client`.
- **Live (staging):** a newly-rendered (persistent) studio pod goes Ready only
  once the proxy listens; existing un-persisted pods do not restart on the
  chart sync.

## Out of scope

- Entrypoint key-gate (dropped — verified warm-pool regression).
- Lazy per-invocation key (follow-up B — the real fix for the keyless window).
- Fixing the unrelated `ph-apeiron` full-env CrashLoop (separate packaging bug).
- Liveness probe (deferred; readiness is the routing-safety lever).
