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

## Approach (chosen: A — entrypoint gate + readiness probe)

### 1. Entrypoint key-gate (vetra-cli)

In `vetra-cli/vetra-cli/Dockerfile`'s `vetra-run.sh`, before `exec`-ing
`SERVICE_COMMAND`, add a **bounded wait** for a usable key env var:

- Check for any of `ANTHROPIC_API_KEY` / `VETRA_ANTHROPIC_API_KEY` /
  `VETRA_CLI_ANTHROPIC_API_KEY` (the three names `claim.ts:3-7` writes).
- **Only gate when the env requires a key** — gate iff `VETRA_REQUIRE_API_KEY`
  is truthy (warm studio pods). Key-less envs that legitimately run the demo
  agent must boot unchanged. (Confirm the flag name against
  `vetra-cli/src/framework.ts:21` / create-env wiring during planning.)
- Poll up to a bounded timeout (e.g. 120s, env-overridable
  `VETRA_KEY_WAIT_SECONDS`). On success → `exec`. On timeout → exit non-zero so
  k8s restarts the container; Reloader will have rolled the pod once the secret
  lands, so the replacement boots with the key.
- Env vars only populate at container creation, so the wait mainly converts a
  keyless start into "not started yet" — the demo agent is never baked in.

### 2. Readiness probe (chart)

Add a `readinessProbe` to the clint container in `clint-deployment.yaml`
(currently none, `:171-177`). Probe the agent's serving endpoint (the same
port the ingress targets) so the pod is **NotReady → not routed** until the
agent process is actually serving. Keep it tolerant (initialDelay +
failureThreshold) so a slow boot isn't flapped. Liveness optional/deferred to
avoid killing a legitimately slow first boot.

### 3. Processor emit (gitops)

`generateClintBlock` emits whatever probe config the chart needs (path/port)
and ensures `VETRA_REQUIRE_API_KEY` reaches studio agents (it already routes
per-agent env; confirm it's set for studios). Mirror existing emit patterns.

## Follow-up (NOT in this spec): B — lazy per-invocation key

The robust end-state is the "Task 4" data-plane lever: vetra-cli re-resolves the
key when it changes and rebuilds the agent **without any restart**, eliminating
the keyless window entirely. It touches the mastra agent lifecycle (the agent is
currently cached once at bootstrap). Documented here as a separate fast-follow
spec; not blocked on it.

## Error handling / edge cases

- **Gate must not deadlock claimed envs:** the bounded timeout + non-zero exit
  guarantees k8s keeps cycling until the secret lands; Reloader's rollout
  replaces the pod with a key-bearing one. No infinite silent sleep.
- **Demo-agent envs:** gating only when `VETRA_REQUIRE_API_KEY` is set keeps
  intentional key-less demo agents booting normally.
- **Persistence interaction (Spec 1):** with a PVC, never persist a demo-agent
  state to disk on a keyless boot — the gate prevents a keyless serving boot, so
  reactor-storage is only written once the real agent is up.

## Testing

- **Entrypoint (TDD, shell):** unit-test `vetra-run.sh` gate logic with a small
  harness — key set → starts immediately; `VETRA_REQUIRE_API_KEY=1` + no key →
  exits non-zero after the (shortened) timeout; flag unset + no key → starts
  (demo path unchanged).
- **Chart render (TDD):** `helm template` → assert the clint container has the
  readinessProbe with expected path/port.
- **Live (staging):** claim a fresh env, watch the pod — it should go
  Ready only after the key lands and it serves the real agent (not demo);
  confirm it's never routed while keyless.

## Out of scope

- Lazy per-invocation key (follow-up B).
- Fixing the unrelated `ph-apeiron` full-env CrashLoop (separate packaging bug).
- Liveness probe (deferred; readiness is the routing-safety lever).
