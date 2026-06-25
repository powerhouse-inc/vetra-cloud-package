# Nightly per-env app-image bump — design

**Date:** 2026-06-25
**Status:** approved

## Problem

New studio/cloud environments render switchboard/connect from
`DEFAULT_IMAGE_TAG` in `processors/vetra-cloud-environment/gitops.ts`. It was a
hard-pinned version (`v6.0.0-dev.152`) that nobody bumped, so it drifted far
behind the live builds (management was on `v6.0.0-dev.258`) — envs created weeks
apart ran wildly different images (same family as the stale-vetra-cli problem).

Setting the default to the floating `dev` tag fixes drift for *fresh* nodes but
not for long-lived ones: kubelet image GC here is purely disk-pressure-driven
(`imageGCHighThresholdPercent: 85`, `imageMaximumGCAge: 0` = disabled) and nodes
sit at 8–11% image-fs usage, so an unused `dev` is never evicted. With
`pullPolicy: IfNotPresent` (kept — we do not want a pull on every pod start), a
node keeps its first-pulled `dev` until it is replaced.

## Goal

New environments always render switchboard/connect at a **recent concrete**
`vX.Y.Z-dev.N` tag, refreshed nightly. Concrete-and-changing means every bump is
a new pod spec → forced re-pull even on long-lived nodes. Scope is **new
environments only**; already-rendered envs keep their tag until they next
re-render.

## Design

Three pieces:

### 1. Processor reads the default tag from env

`gitops.ts`: replace the hard constant with a per-call read so it is testable
and overridable at runtime without a republish each bump.

```ts
function defaultAppImageTag(): string {
  return process.env.DEFAULT_APP_IMAGE_TAG ?? "dev";
}
// switchboardTag = switchboardService?.version ?? defaultAppImageTag()
// connectTag     = connectService?.version    ?? defaultAppImageTag()
```

Fallback stays `dev` (today's safe behavior) when the env is unset. Requires one
republish of `vetra-cloud-package` + staging pin bump.

### 2. Staging values carry the concrete tag

`tenants/staging/powerhouse-values.yaml` (powerhouse-k8s-hosting): add
`DEFAULT_APP_IMAGE_TAG: vX.Y.Z-dev.N` to the management switchboard `env:` block
(that pod runs the studio pool + the `vetra-cloud-environment` processor). This
is the single line the nightly job rewrites.

### 3. Nightly GitHub Action

`.github/workflows/nightly-app-image-bump.yml` (powerhouse-k8s-hosting):

- `schedule: cron` nightly + `workflow_dispatch`.
- No repo secrets: anonymous Harbor pull token reads tags; `GITHUB_TOKEN`
  (`contents: write`) commits.
- Resolve the concrete tag that `:dev` currently points to — fetch the manifest
  digest of `:dev`, then find the `vX.Y.Z-dev.N` tag whose digest matches it —
  for **switchboard**, and confirm the **same tag string** exists for
  **connect**. If resolution fails or the two disagree, log and exit 0 (no bump).
- If the resolved tag differs from the value in `powerhouse-values.yaml`, rewrite
  `DEFAULT_APP_IMAGE_TAG`, commit straight to `main`. ArgoCD syncs.

## Tradeoffs (accepted)

- The env change rolls the **management switchboard pod** (env change → new pod
  template → rollout), so staging's management switchboard gets a brief nightly
  restart on days `dev` actually moved. Acceptable for staging.
- Only **newly-rendered** envs pick up the new tag — exactly the stated scope.

## Out of scope

- Management-plane (staging.vetra.io switchboard/connect) tag bumps.
- Updating already-existing tenant environments.
