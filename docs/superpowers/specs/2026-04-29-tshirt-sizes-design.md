# T-shirt sizes for Vetra Cloud services

**Date**: 2026-04-29

## Problem

Switchboard pods on customer environments OOM-kill because their resources are pinned to the `powerhouse-chart` defaults (`requests: 250m / 512Mi`, `limits: 1 cpu / 1Gi`). The doc model has `VetraCloudRessourceSize` (S/M/L/XL/XXL) and the processor has a resource map, but **both are wired only for CLINT agents** — there is no way for a tenant owner to scale Switchboard, Connect, or Fusion.

## Solution

Promote `selectedRessource` from CLINT-only into a first-class per-service field on `VetraCloudEnvironmentService`, give it an op (`SET_SERVICE_SIZE`), and have the processor emit a `resources:` block per service in the values YAML using a per-service-type map. Surface the picker on every service card in vetra.to.

Default everywhere = `VETRA_AGENT_S`. The S row of each map is calibrated to today's chart default so existing environments do **not** regress on next sync.

## Decisions (locked in brainstorming)

- **Scope**: Switchboard + Connect + Fusion (chart-side; Fusion is wired in the doc model but the chart does not render Fusion today, so processor change is a no-op for Fusion) + CLINT (already exists, normalized).
- **Schema shape**: top-level `selectedRessource` on `VetraCloudEnvironmentService`. CLINT's legacy `config.selectedRessource` stays in the schema for read-fallback for one release, then is removed.
- **Enum**: same `VetraCloudRessourceSize` (S/M/L/XL/XXL) for every service.
- **Resource numbers**: per-service-type maps — one for Switchboard/Connect/Fusion (the "app" map), one for CLINT (the existing map, unchanged).
- **UI placement**: inline popover on `service-card.tsx` (Switchboard/Connect/Fusion) and `agent-card.tsx` (CLINT); reuses existing `ResourceSizePicker`.

## Changes

### 1. `vetra-cloud-package` — document model (`v1`)

**Schema (`document-models/vetra-cloud-environment/v1/schema.graphql`)**:

- Add top-level `selectedRessource: VetraCloudRessourceSize` on `VetraCloudEnvironmentService` (optional, nullable).
- Add `selectedRessource: VetraCloudRessourceSize` to `EnableServiceInput` (optional; reducer defaults to `VETRA_AGENT_S` when absent).
- Add `SetServiceSizeInput { prefix: String!, size: VetraCloudRessourceSize! }`.
- Leave `VetraCloudServiceClint.selectedRessource` in place (read-fallback), with a `# DEPRECATED — read-only fallback, write via SET_SERVICE_SIZE` comment.

**Operation (`services` module)**:

- New op `SET_SERVICE_SIZE` with input `SetServiceSizeInput`.
- Reducer:
  - `assertOwner(state, action)`
  - find service by `prefix` (one prefix is unique across types per the existing `PrefixInUseError`)
  - throw `ServiceNotFoundError` if absent
  - set `service.selectedRessource = action.input.size`
  - if the service is CLINT and has a `config`, also write `service.config.selectedRessource = action.input.size` for one release so old readers stay consistent
  - `markPendingIfDeployed(state)`

**Existing op updates**:

- `enableServiceOperation`: when creating a new service entry, set `selectedRessource = action.input.selectedRessource ?? "VETRA_AGENT_S"` at the top level. For CLINT, keep mirroring into `config.selectedRessource` for one release.
- `setServiceConfigOperation` (CLINT-only today): keep its existing behavior of writing `config.selectedRessource`, but also write the top-level `service.selectedRessource` so the two stay in sync. Once vetra.to drops `setServiceConfig` size writes, this mirror can be removed.

**Errors**: no new error types — `ServiceNotFoundError` covers the prefix-miss case.

**No version bump.** The new field is optional and absent on old documents; readers fall through to S. The upgrade-manifest's `upgrades: {}` map stays empty.

### 2. `vetra-cloud-package` — processor (`processors/vetra-cloud-environment/gitops.ts`)

Replace the single `CLINT_RESOURCE_MAP` with two per-service-type maps:

```ts
const APP_RESOURCE_MAP: Record<VetraCloudRessourceSize, ResourceSpec> = {
  VETRA_AGENT_S:   { requests: { cpu: "250m",  memory: "512Mi" }, limits: { cpu: "1",   memory: "1Gi"  } },
  VETRA_AGENT_M:   { requests: { cpu: "500m",  memory: "1Gi"   }, limits: { cpu: "2",   memory: "2Gi"  } },
  VETRA_AGENT_L:   { requests: { cpu: "1",     memory: "2Gi"   }, limits: { cpu: "4",   memory: "4Gi"  } },
  VETRA_AGENT_XL:  { requests: { cpu: "2",     memory: "4Gi"   }, limits: { cpu: "6",   memory: "8Gi"  } },
  VETRA_AGENT_XXL: { requests: { cpu: "4",     memory: "8Gi"   }, limits: { cpu: "8",   memory: "16Gi" } },
};

// Existing CLINT map, unchanged.
const CLINT_RESOURCE_MAP: Record<VetraCloudRessourceSize, ResourceSpec> = { /* as today */ };
```

Helper:

```ts
function readServiceSize(svc: VetraCloudEnvironmentService): VetraCloudRessourceSize {
  return svc.selectedRessource
    ?? svc.config?.selectedRessource   // legacy CLINT path
    ?? "VETRA_AGENT_S";
}
```

Switchboard/Connect emission (`generateValuesYaml`): in the existing `switchboard:` and `connect:` blocks (always emitted today, just with `enabled: ${...}`), inject an explicit `resources:` sub-block sourced from `APP_RESOURCE_MAP[readServiceSize(switchboardService)]` and `APP_RESOURCE_MAP[readServiceSize(connectService)]`. When a service is missing from `state.services` (legacy or pre-enable), pass `undefined` to `readServiceSize` and let it fall through to S — same behavior as today's chart default.

CLINT emission (`generateClintBlock`): swap the local `size = cfg?.selectedRessource ?? "VETRA_AGENT_S"` line for `readServiceSize(svc)` and use `CLINT_RESOURCE_MAP`.

Fusion: not rendered by the chart today (`generateValuesYaml` has no fusion block). The doc model still accepts `selectedRessource` on Fusion services so the wiring is forward-compatible — when a Fusion chart lands, it reads the same field.

### 3. `vetra.to` — UI

**New component**: `modules/cloud/components/service-size-popover.tsx`

- Wraps the existing `ResourceSizePicker` in a `Popover` (Radix; the project already uses it).
- Trigger: a compact `<Button variant="ghost" size="sm">Size: <SizeLabel> ▾</Button>`.
- Body: the picker + a small table showing `requests / limits` per size for the relevant service-type, sourced from a constant in `modules/cloud/lib/resource-maps.ts` (mirror of the processor's tables, kept in sync manually — small, low-churn).
- Calls `controller.setServiceSize(prefix, size)` (new method on `controller.ts`).
- Owner-only — uses the existing `useCanSign` hook; non-owners see the current size as a static badge with no popover.

**`controller.ts`** — new method:

```ts
async function setServiceSize(prefix: string, size: CloudResourceSize): Promise<void> {
  await reactor.dispatch(envDocId, "main", [actions.setServiceSize({ prefix, size })]);
}
```

**`service-card.tsx`** (Switchboard/Connect/Fusion): add the popover next to the existing "Visit" button. Read the current size from `service.selectedRessource ?? "VETRA_AGENT_S"`.

**`agent-card.tsx`** (CLINT): replace the existing inline size editor inside the configure form with the same popover, reading from `service.selectedRessource ?? service.config?.selectedRessource ?? "VETRA_AGENT_S"`. Continue dispatching `SET_SERVICE_SIZE` (not `SET_SERVICE_CONFIG`) for size-only edits — keeps CLINT/non-CLINT edit paths uniform.

**Types** (`modules/cloud/types.ts`): add `selectedRessource: CloudResourceSize | null` to `CloudEnvironmentService`. Re-run `npm run codegen` so the GraphQL types regenerate.

**`new-project-form.tsx`**: no change — new envs default to S server-side.

### 4. Test plan

`vetra-cloud-package`:
- Reducer unit tests for `SET_SERVICE_SIZE`: happy path (CLINT and non-CLINT), `ServiceNotFoundError` on bad prefix, owner-gate, marks `CHANGES_PENDING`.
- Reducer unit test: `enableServiceOperation` defaults to S when input omitted; honors input when provided.
- Processor unit test on `generateValuesYaml`: every size produces the expected `resources:` lines for Switchboard and Connect; absent field falls through to S; CLINT legacy `config.selectedRessource` still drives sizing on the agent block.
- Update `e2e.test.ts` to flip a Switchboard size, approve, sync, and assert the values YAML contains the expected limits.

`vetra.to`:
- Component test for `service-size-popover.tsx`: trigger, picker selection, save dispatches, owner-only rendering.
- Existing tests for `service-card.tsx` / `agent-card.tsx` updated for the new affordance.

### 5. Migration & rollout

- **Doc-model docs in the wild**: no migration needed. Top-level field is optional; readers fall back to `config.selectedRessource` (CLINT) or S (everyone else). Existing CLINT docs that already store size in `config` keep working.
- **Existing tenants on next sync**: Switchboard/Connect get an explicit `resources:` block in their values YAML. Because S is calibrated to today's chart default, ArgoCD sees no diff in the rendered manifest for any env that was already at the default — no rolling restart. Envs that need more memory can move themselves to M+ via the new UI.
- **Deprecation**: keep `VetraCloudServiceClint.selectedRessource` in the schema for one release window, then remove in a follow-up bump (separate spec).

## Why this works

The doc model already had the right enum and the processor already had the right map idea — it was just locked inside CLINT. Lifting it to a per-service field aligns CLINT and app services on one mental model, the per-type processor map keeps each service's S row sane, and the UI pattern (`ResourceSizePicker` + popover on the service row) is the same shape `agent-card.tsx` already uses for CLINT today. The change is additive and backwards-compatible — old documents and old chart deployments keep working unchanged.
