# T-shirt Sizes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let tenant owners scale Switchboard / Connect / Fusion / CLINT services per environment via a t-shirt size (S/M/L/XL/XXL) selectable on the service card in vetra.to.

**Architecture:** Add a top-level `selectedRessource` field to `VetraCloudEnvironmentService`, a new `SET_SERVICE_SIZE` operation, and per-service-type resource maps in the gitops processor. UI extension is a `Popover` wrapping the existing `ResourceSizePicker` on `service-card.tsx` and `agent-card.tsx`.

**Tech Stack:** GraphQL doc model (Powerhouse `ph-cli generate`), TypeScript, Vitest, Next.js + React + Radix Popover.

**Spec:** `docs/superpowers/specs/2026-04-29-tshirt-sizes-design.md`

---

## Repos touched

1. `/home/froid/projects/powerhouse/vetra-cloud-package` — doc model, processor, version bump
2. `/home/froid/projects/powerhouse/vetra.to` — UI consumer (after vetra-cloud-package is published / linked)

Run all `vetra-cloud-package` tasks first (Phase A → C), then `vetra.to` (Phase D).

---

## Phase A — Doc model: schema, op, reducer

### Task A1: Update doc-model JSON — state schema and `EnableServiceInput`

**Files:**
- Modify: `document-models/vetra-cloud-environment/vetra-cloud-environment.json`
- Modify: `document-models/vetra-cloud-environment/v1/schema.graphql`

The doc-model JSON embeds the global state schema as a string and is the source of truth for codegen. Both files must be updated together.

- [ ] **Step 1: In `schema.graphql`, add `selectedRessource` to `VetraCloudEnvironmentService`:**

```graphql
type VetraCloudEnvironmentService {
  type: VetraCloudEnvironmentServiceType!
  prefix: String!
  enabled: Boolean!
  url: String
  status: ServiceStatus!
  version: String
  config: VetraCloudServiceClint
  selectedRessource: VetraCloudRessourceSize
}
```

- [ ] **Step 2: In `schema.graphql`, add `selectedRessource` to `EnableServiceInput`:**

```graphql
input EnableServiceInput {
  type: VetraCloudEnvironmentServiceType!
  prefix: String!
  clintConfig: VetraCloudServiceClintInput
  selectedRessource: VetraCloudRessourceSize
}
```

- [ ] **Step 3: In `schema.graphql`, add the new input type:**

```graphql
input SetServiceSizeInput {
  prefix: String!
  size: VetraCloudRessourceSize!
}
```

- [ ] **Step 4: Mirror these three changes inside the `vetra-cloud-environment.json` global state schema string and the relevant operation `schema` strings (`enableServiceOperation` input, plus add a brand-new `SET_SERVICE_SIZE` operation entry — see Task A2).**

- [ ] **Step 5: Commit (don't run codegen yet — Task A2 adds the op).**

```bash
git add document-models/vetra-cloud-environment/vetra-cloud-environment.json document-models/vetra-cloud-environment/v1/schema.graphql
git commit -m "doc-model: add selectedRessource field and SetServiceSizeInput"
```

### Task A2: Doc-model JSON — add `SET_SERVICE_SIZE` operation

**Files:**
- Modify: `document-models/vetra-cloud-environment/vetra-cloud-environment.json`

- [ ] **Step 1: Inside the `services` module's `operations` array, append a new operation entry. Use a fresh `id` (e.g. `op-set-service-size`) and place after `setServiceConfigOperation`:**

```json
{
  "id": "op-set-service-size",
  "name": "SET_SERVICE_SIZE",
  "description": "Set the t-shirt resource size of an existing service (any type) by prefix.",
  "schema": "input SetServiceSizeInput {\n  prefix: String!\n  size: VetraCloudRessourceSize!\n}",
  "template": "",
  "reducer": "assertOwner(state, action);\nconst service = state.services.find((s) => s.prefix === action.input.prefix);\nif (!service) {\n  throw new ServiceNotFoundError(`No service with prefix '${action.input.prefix}'`);\n}\nservice.selectedRessource = action.input.size;\nif (service.type === \"CLINT\" && service.config) {\n  service.config.selectedRessource = action.input.size;\n}\nmarkPendingIfDeployed(state);",
  "errors": [
    {
      "id": "err-service-not-found-set-size",
      "name": "ServiceNotFoundError",
      "code": "SERVICE_NOT_FOUND",
      "description": "No service with the given prefix exists in this environment",
      "template": ""
    },
    {
      "id": "err-not-owner-set-size",
      "name": "NotOwnerError",
      "code": "NOT_OWNER",
      "description": "The action signer is not the owner of this environment",
      "template": ""
    }
  ],
  "examples": [],
  "scope": "global"
}
```

Note: `assertOwner` and `markPendingIfDeployed` are existing helpers in `src/reducers/utils.ts`. The reducer string above mirrors what we'll write in `services.ts` in Task A4; codegen wires these into `gen/services/operations.ts`.

- [ ] **Step 2: Run codegen.**

```bash
cd /home/froid/projects/powerhouse/vetra-cloud-package
npm run generate
```

Expected: `gen/services/actions.ts`, `gen/services/operations.ts`, `gen/services/error.ts`, `gen/types.ts`, `gen/schema/*` all updated. New `setServiceSize` action creator appears in `gen/services/actions.ts`.

- [ ] **Step 3: Run typecheck — expect failure on `services.ts` because the new operation isn't implemented yet.**

```bash
npm run tsc
```

Expected: TS error about `vetraCloudEnvironmentServicesOperations` missing `setServiceSizeOperation`.

- [ ] **Step 4: Commit the JSON + regenerated files.**

```bash
git add document-models/
git commit -m "doc-model: add SET_SERVICE_SIZE operation"
```

### Task A3: Reducer — write the failing test for `SET_SERVICE_SIZE`

**Files:**
- Modify: `document-models/vetra-cloud-environment/v1/tests/services.test.ts`

- [ ] **Step 1: Inside the existing `describe("ServicesOperations")` block, add a new section after the `SET_SERVICE_CONFIG` block:**

```typescript
describe("SET_SERVICE_SIZE", () => {
  const owner = "0x000000000000000000000000000000000000beef";
  const ownerCtx = { signer: { user: { address: owner } } } as any;

  function withOwner(doc: ReturnType<typeof utils.createDocument>) {
    return reducer(doc, setOwner({ address: owner }, ownerCtx));
  }

  it("sets selectedRessource on a non-CLINT service by prefix", () => {
    let doc = withOwner(utils.createDocument());
    doc = reducer(
      doc,
      enableService({ type: "SWITCHBOARD", prefix: "switchboard" }, ownerCtx),
    );
    doc = reducer(
      doc,
      setServiceSize(
        { prefix: "switchboard", size: "VETRA_AGENT_L" },
        ownerCtx,
      ),
    );
    const svc = doc.state.global.services.find((s) => s.prefix === "switchboard");
    expect(svc?.selectedRessource).toBe("VETRA_AGENT_L");
  });

  it("mirrors the size into config.selectedRessource for CLINT services", () => {
    let doc = withOwner(utils.createDocument());
    doc = reducer(
      doc,
      enableService(
        {
          type: "CLINT",
          prefix: "agent",
          clintConfig: {
            package: { registry: "https://r.example", name: "p", version: null },
            env: [],
            serviceCommand: null,
            selectedRessource: "VETRA_AGENT_S",
          },
        },
        ownerCtx,
      ),
    );
    doc = reducer(
      doc,
      setServiceSize({ prefix: "agent", size: "VETRA_AGENT_M" }, ownerCtx),
    );
    const svc = doc.state.global.services.find((s) => s.prefix === "agent");
    expect(svc?.selectedRessource).toBe("VETRA_AGENT_M");
    expect(svc?.config?.selectedRessource).toBe("VETRA_AGENT_M");
  });

  it("throws ServiceNotFoundError when prefix does not exist", () => {
    const doc = withOwner(utils.createDocument());
    expect(() =>
      reducer(
        doc,
        setServiceSize({ prefix: "nope", size: "VETRA_AGENT_M" }, ownerCtx),
      ),
    ).toThrow(/No service with prefix/);
  });
});
```

- [ ] **Step 2: Update the imports at the top of the test file to add `setServiceSize` and `setOwner`:**

```typescript
import {
  reducer,
  utils,
  enableService,
  // ... existing imports
  setServiceSize,
  setOwner,
} from "document-models/vetra-cloud-environment/v1";
```

- [ ] **Step 3: Run the new tests — expect failure (operation not implemented).**

```bash
npm test -- v1/tests/services.test.ts
```

Expected: 3 new test failures.

### Task A4: Reducer — implement `SET_SERVICE_SIZE` and update `enableServiceOperation`

**Files:**
- Modify: `document-models/vetra-cloud-environment/v1/src/reducers/services.ts`

- [ ] **Step 1: In `enableServiceOperation`, when constructing a new service entry, populate `selectedRessource` at the top level. Replace the new-service branch:**

```typescript
} else {
  state.services.push({
    type,
    prefix,
    enabled: true,
    url: null,
    status: "PROVISIONING",
    version: null,
    config,
    selectedRessource: action.input.selectedRessource ?? "VETRA_AGENT_S",
  });
}
```

Also when updating an `existing` service, if `action.input.selectedRessource` is provided, set `existing.selectedRessource = action.input.selectedRessource` (otherwise leave it alone — re-enabling shouldn't reset a previously-chosen size).

- [ ] **Step 2: In `setServiceConfigOperation` (CLINT-only), after writing `service.config = {...}`, mirror the size to the top level:**

```typescript
service.config = {
  package: { /* ... */ },
  env: config.env ?? [],
  serviceCommand: config.serviceCommand ?? null,
  selectedRessource: config.selectedRessource ?? null,
};
if (config.selectedRessource) {
  service.selectedRessource = config.selectedRessource;
}
state.status = "CHANGES_PENDING";
```

- [ ] **Step 3: Append `setServiceSizeOperation` to the exported object:**

```typescript
setServiceSizeOperation(state, action) {
  assertOwner(state, action);
  if (!state.services) {
    state.services = [];
  }
  const service = state.services.find(
    (s) => s.prefix === action.input.prefix,
  );
  if (!service) {
    throw new ServiceNotFoundError(
      `No service with prefix '${action.input.prefix}'`,
    );
  }
  service.selectedRessource = action.input.size;
  if (service.type === "CLINT" && service.config) {
    service.config.selectedRessource = action.input.size;
  }
  markPendingIfDeployed(state);
},
```

`ServiceNotFoundError` is already imported at the top of the file from `gen/services/error.js`.

- [ ] **Step 4: Run the tests.**

```bash
npm test -- v1/tests/services.test.ts
```

Expected: all tests pass (existing + 3 new).

- [ ] **Step 5: Run typecheck and lint.**

```bash
npm run tsc && npm run lint:fix
```

Expected: clean.

- [ ] **Step 6: Commit.**

```bash
git add document-models/
git commit -m "doc-model: implement SET_SERVICE_SIZE reducer + selectedRessource on enable"
```

---

## Phase B — Processor: per-service-type resource maps + emission

### Task B1: Write the failing unit test for `generateValuesYaml`

**Files:**
- Create: `processors/vetra-cloud-environment/gitops.test.ts`

The existing `e2e.test.ts` requires a live reactor + kubectl and is unsuitable for fast loops. Add a focused unit test for the YAML generator.

- [ ] **Step 1: Create the test file:**

```typescript
import { describe, it, expect, vi } from "vitest";
import type { Kysely } from "kysely";
import { generateValuesYaml } from "./gitops.js";
import type { VetraCloudEnvironmentState } from "../../document-models/vetra-cloud-environment/index.js";
import type { DB } from "./schema.js";

// Minimal stub: ensureClintAnnounceTokens reads/inserts. Returning empty
// results gives every CLINT service an empty token (acceptable for YAML
// shape assertions; we don't test CLINT here).
const dbStub = {
  selectFrom: () => ({
    select: () => ({
      where: () => ({ executeTakeFirst: async () => undefined }),
    }),
  }),
  insertInto: () => ({
    values: () => ({ execute: async () => undefined }),
  }),
} as unknown as Kysely<DB>;

function envState(
  overrides: Partial<VetraCloudEnvironmentState> = {},
): VetraCloudEnvironmentState {
  return {
    owner: null,
    label: "test",
    genericSubdomain: "test",
    genericBaseDomain: "vetra.io",
    customDomain: { enabled: false, domain: null, dnsRecords: [] },
    defaultPackageRegistry: "https://registry.dev.vetra.io",
    services: [],
    packages: [],
    status: "READY",
    apexService: null,
    autoUpdateChannel: null,
    ...overrides,
  };
}

describe("generateValuesYaml — switchboard resources", () => {
  it("emits S resources by default when service has no selectedRessource", async () => {
    const yaml = await generateValuesYaml(
      dbStub,
      envState({
        services: [
          {
            type: "SWITCHBOARD",
            prefix: "switchboard",
            enabled: true,
            url: null,
            status: "ACTIVE",
            version: null,
            config: null,
            selectedRessource: null,
          },
        ],
      }),
      "doc-1",
    );
    // Locate the switchboard.resources block in the rendered YAML.
    expect(yaml).toMatch(
      /switchboard:[\s\S]*resources:[\s\S]*requests:[\s\S]*cpu:\s*"250m"[\s\S]*memory:\s*"512Mi"[\s\S]*limits:[\s\S]*cpu:\s*"1"[\s\S]*memory:\s*"1Gi"/,
    );
  });

  it("emits L resources when selectedRessource = VETRA_AGENT_L", async () => {
    const yaml = await generateValuesYaml(
      dbStub,
      envState({
        services: [
          {
            type: "SWITCHBOARD",
            prefix: "switchboard",
            enabled: true,
            url: null,
            status: "ACTIVE",
            version: null,
            config: null,
            selectedRessource: "VETRA_AGENT_L",
          },
        ],
      }),
      "doc-2",
    );
    expect(yaml).toMatch(
      /switchboard:[\s\S]*resources:[\s\S]*requests:[\s\S]*cpu:\s*"1"[\s\S]*memory:\s*"2Gi"[\s\S]*limits:[\s\S]*cpu:\s*"4"[\s\S]*memory:\s*"4Gi"/,
    );
  });

  it("emits same resource numbers for connect on size XL", async () => {
    const yaml = await generateValuesYaml(
      dbStub,
      envState({
        services: [
          {
            type: "CONNECT",
            prefix: "connect",
            enabled: true,
            url: null,
            status: "ACTIVE",
            version: null,
            config: null,
            selectedRessource: "VETRA_AGENT_XL",
          },
        ],
      }),
      "doc-3",
    );
    expect(yaml).toMatch(
      /connect:[\s\S]*resources:[\s\S]*requests:[\s\S]*cpu:\s*"2"[\s\S]*memory:\s*"4Gi"[\s\S]*limits:[\s\S]*cpu:\s*"6"[\s\S]*memory:\s*"8Gi"/,
    );
  });

  it("falls back to legacy CLINT config.selectedRessource when top-level absent", async () => {
    const yaml = await generateValuesYaml(
      dbStub,
      envState({
        services: [
          {
            type: "CLINT",
            prefix: "agent",
            enabled: true,
            url: null,
            status: "ACTIVE",
            version: null,
            selectedRessource: null,
            config: {
              package: {
                registry: "https://r",
                name: "p",
                version: "1.0.0",
              },
              env: [],
              serviceCommand: null,
              selectedRessource: "VETRA_AGENT_M",
            },
          },
        ],
      }),
      "doc-4",
    );
    // CLINT M from existing CLINT_RESOURCE_MAP: 250m/512Mi req, 1/1Gi lim
    expect(yaml).toMatch(
      /clint:[\s\S]*requests:\s*\{\s*cpu:\s*"250m",\s*memory:\s*"512Mi"\s*\}/,
    );
  });
});
```

- [ ] **Step 2: Run the tests.**

```bash
npm test -- processors/vetra-cloud-environment/gitops.test.ts
```

Expected: all four tests fail (the YAML doesn't currently include explicit `resources:` for switchboard/connect).

### Task B2: Processor — refactor resource maps and emit per-service `resources:`

**Files:**
- Modify: `processors/vetra-cloud-environment/gitops.ts`

- [ ] **Step 1: Replace the existing `CLINT_RESOURCE_MAP` block with two maps and a helper. Find the section starting `/** k8s resource requests/limits per t-shirt size from the doc model. */` and replace through the end of the `CLINT_RESOURCE_MAP` literal with:**

```typescript
type ResourceSpec = {
  requests: { cpu: string; memory: string };
  limits: { cpu: string; memory: string };
};

/** App-services map (Switchboard/Connect/Fusion). Calibrated so that
 *  S = today's chart default, preventing regression on next sync. */
const APP_RESOURCE_MAP: Record<VetraCloudRessourceSize, ResourceSpec> = {
  VETRA_AGENT_S:   { requests: { cpu: "250m", memory: "512Mi" }, limits: { cpu: "1", memory: "1Gi"  } },
  VETRA_AGENT_M:   { requests: { cpu: "500m", memory: "1Gi"   }, limits: { cpu: "2", memory: "2Gi"  } },
  VETRA_AGENT_L:   { requests: { cpu: "1",    memory: "2Gi"   }, limits: { cpu: "4", memory: "4Gi"  } },
  VETRA_AGENT_XL:  { requests: { cpu: "2",    memory: "4Gi"   }, limits: { cpu: "6", memory: "8Gi"  } },
  VETRA_AGENT_XXL: { requests: { cpu: "4",    memory: "8Gi"   }, limits: { cpu: "8", memory: "16Gi" } },
};

/** CLINT agents — small-footprint per-pod runtime, unchanged. */
const CLINT_RESOURCE_MAP: Record<VetraCloudRessourceSize, ResourceSpec> = {
  VETRA_AGENT_S:   { requests: { cpu: "100m", memory: "256Mi" }, limits: { cpu: "500m", memory: "512Mi" } },
  VETRA_AGENT_M:   { requests: { cpu: "250m", memory: "512Mi" }, limits: { cpu: "1",    memory: "1Gi"   } },
  VETRA_AGENT_L:   { requests: { cpu: "500m", memory: "1Gi"   }, limits: { cpu: "2",    memory: "2Gi"   } },
  VETRA_AGENT_XL:  { requests: { cpu: "1",    memory: "2Gi"   }, limits: { cpu: "4",    memory: "4Gi"   } },
  VETRA_AGENT_XXL: { requests: { cpu: "2",    memory: "4Gi"   }, limits: { cpu: "8",    memory: "8Gi"   } },
};

/** Resolve the effective t-shirt size for a service.
 *  Falls back to legacy CLINT `config.selectedRessource`, then to S. */
function readServiceSize(
  svc: VetraCloudEnvironmentService | undefined,
): VetraCloudRessourceSize {
  if (!svc) return "VETRA_AGENT_S";
  return (
    svc.selectedRessource ??
    svc.config?.selectedRessource ??
    "VETRA_AGENT_S"
  );
}
```

- [ ] **Step 2: In `generateClintBlock`, replace the `size`/`resources` lines with the helper:**

```typescript
const size = readServiceSize(svc);
const resources = CLINT_RESOURCE_MAP[size];
```

(removes the inline `?? "VETRA_AGENT_S"` and `?? CLINT_RESOURCE_MAP.VETRA_AGENT_S` fallbacks — the helper already handles them.)

- [ ] **Step 3: In `generateValuesYaml`, after the `connectService` lookup, compute resources for both apps:**

```typescript
const switchboardResources = APP_RESOURCE_MAP[readServiceSize(switchboardService)];
const connectResources = APP_RESOURCE_MAP[readServiceSize(connectService)];
```

- [ ] **Step 4: In the `switchboard:` block of the returned YAML template, replace the existing `autoscaling:` final line area with an explicit `resources:` injection. Find this section:**

```yaml
  securityContext:
    runAsNonRoot: false
    runAsUser: 0
    fsGroup: 0
  autoscaling:
    enabled: false
```

Insert (above `autoscaling:`) — this lives under `switchboard:`:

```typescript
  resources:
    requests:
      cpu: ${yamlQuote(switchboardResources.requests.cpu)}
      memory: ${yamlQuote(switchboardResources.requests.memory)}
    limits:
      cpu: ${yamlQuote(switchboardResources.limits.cpu)}
      memory: ${yamlQuote(switchboardResources.limits.memory)}
```

- [ ] **Step 5: Do the same in the `connect:` block — insert a `resources:` sub-block above `autoscaling:` using `connectResources`.**

- [ ] **Step 6: Run the unit tests.**

```bash
npm test -- processors/vetra-cloud-environment/gitops.test.ts
```

Expected: all four tests pass.

- [ ] **Step 7: Run full typecheck and the doc-model test suite to make sure we didn't break anything.**

```bash
npm run tsc && npm test
```

Expected: green.

- [ ] **Step 8: Commit.**

```bash
git add processors/
git commit -m "processor: per-service-type resource maps + resources block for switchboard/connect"
```

---

## Phase C — Publish vetra-cloud-package dev build

### Task C1: Bump version and publish a dev tag

**Files:**
- Modify: `package.json` (version bump)

- [ ] **Step 1: Bump the dev tag.** The current version is `0.0.3-dev.49`. Bump to `0.0.3-dev.50` (or whatever the next number is):

```bash
cd /home/froid/projects/powerhouse/vetra-cloud-package
npm version 0.0.3-dev.50 --no-git-tag-version
```

- [ ] **Step 2: Build to make sure the published artifact compiles.**

```bash
npm run build
```

- [ ] **Step 3: Commit and push.** The repo's CI publishes dev tags on merge — confirm with `git log --oneline -5` whether the standard pattern is auto-publish on push to `dev` or manual `npm publish`. If manual, `npm publish --tag dev` after build.

```bash
git add package.json
git commit -m "chore: bump version to 0.0.3-dev.50"
```

(Do NOT push without the user's confirmation — pushing triggers the package publish CI.)

---

## Phase D — vetra.to UI

### Task D1: Bump `@powerhousedao/vetra-cloud-package` and regenerate types

**Files:**
- Modify: `/home/froid/projects/powerhouse/vetra.to/package.json`

- [ ] **Step 1: Bump the dependency to the new dev tag (matching whatever Task C1 published).**

```bash
cd /home/froid/projects/powerhouse/vetra.to
pnpm add @powerhousedao/vetra-cloud-package@0.0.3-dev.50
```

- [ ] **Step 2: Re-run GraphQL codegen.**

```bash
npm run codegen
```

Expected: `modules/__generated__/` updates to include the new `selectedRessource` field on `VetraCloudEnvironmentService` and the new `setServiceSize` mutation/action.

- [ ] **Step 3: Run typecheck — expect no errors yet (the new field is optional, existing reads still work).**

```bash
npm run tsc
```

- [ ] **Step 4: Commit.**

```bash
git add package.json pnpm-lock.yaml modules/__generated__/
git commit -m "chore(cloud): bump vetra-cloud-package to 0.0.3-dev.50"
```

### Task D2: Extend `CloudEnvironmentService` type

**Files:**
- Modify: `modules/cloud/types.ts`

- [ ] **Step 1: Add `selectedRessource` to the type:**

```typescript
export type CloudEnvironmentService = {
  type: CloudEnvironmentServiceType
  prefix: string
  enabled: boolean
  url: string | null
  status: ServiceStatus
  version: string | null
  config?: CloudServiceClintConfig | null
  selectedRessource: CloudResourceSize | null
}
```

- [ ] **Step 2: Run typecheck.**

```bash
npm run tsc
```

Expected: clean (or at most a couple of fixture/mock files needing the field — patch them with `selectedRessource: null`).

- [ ] **Step 3: Commit.**

```bash
git add modules/cloud/types.ts
git commit -m "feat(cloud): add selectedRessource to CloudEnvironmentService"
```

### Task D3: Add the resource-map mirror

**Files:**
- Create: `modules/cloud/lib/resource-maps.ts`

- [ ] **Step 1: Create the file:**

```typescript
import type { CloudResourceSize } from '@/modules/cloud/types'

export type ResourceSpec = {
  requests: { cpu: string; memory: string }
  limits: { cpu: string; memory: string }
}

/**
 * Mirror of the processor's APP_RESOURCE_MAP (Switchboard/Connect/Fusion).
 * Kept in sync manually with vetra-cloud-package/processors/vetra-cloud-environment/gitops.ts.
 */
export const APP_RESOURCE_MAP: Record<CloudResourceSize, ResourceSpec> = {
  VETRA_AGENT_S:   { requests: { cpu: '250m', memory: '512Mi' }, limits: { cpu: '1', memory: '1Gi'  } },
  VETRA_AGENT_M:   { requests: { cpu: '500m', memory: '1Gi'   }, limits: { cpu: '2', memory: '2Gi'  } },
  VETRA_AGENT_L:   { requests: { cpu: '1',    memory: '2Gi'   }, limits: { cpu: '4', memory: '4Gi'  } },
  VETRA_AGENT_XL:  { requests: { cpu: '2',    memory: '4Gi'   }, limits: { cpu: '6', memory: '8Gi'  } },
  VETRA_AGENT_XXL: { requests: { cpu: '4',    memory: '8Gi'   }, limits: { cpu: '8', memory: '16Gi' } },
}

/** CLINT agents — small-footprint runtime. */
export const CLINT_RESOURCE_MAP: Record<CloudResourceSize, ResourceSpec> = {
  VETRA_AGENT_S:   { requests: { cpu: '100m', memory: '256Mi' }, limits: { cpu: '500m', memory: '512Mi' } },
  VETRA_AGENT_M:   { requests: { cpu: '250m', memory: '512Mi' }, limits: { cpu: '1',    memory: '1Gi'   } },
  VETRA_AGENT_L:   { requests: { cpu: '500m', memory: '1Gi'   }, limits: { cpu: '2',    memory: '2Gi'   } },
  VETRA_AGENT_XL:  { requests: { cpu: '1',    memory: '2Gi'   }, limits: { cpu: '4',    memory: '4Gi'   } },
  VETRA_AGENT_XXL: { requests: { cpu: '2',    memory: '4Gi'   }, limits: { cpu: '8',    memory: '8Gi'   } },
}

export const SIZE_LABELS: Record<CloudResourceSize, string> = {
  VETRA_AGENT_S: 'S',
  VETRA_AGENT_M: 'M',
  VETRA_AGENT_L: 'L',
  VETRA_AGENT_XL: 'XL',
  VETRA_AGENT_XXL: 'XXL',
}
```

- [ ] **Step 2: Commit.**

```bash
git add modules/cloud/lib/resource-maps.ts
git commit -m "feat(cloud): add client-side resource-maps mirror"
```

### Task D4: Add `setServiceSize` to controller

**Files:**
- Modify: `modules/cloud/controller.ts`

- [ ] **Step 1: Locate the existing service-mutation methods (e.g. `enableService`, `setServiceConfig`) and add a sibling:**

```typescript
async function setServiceSize(prefix: string, size: CloudResourceSize): Promise<void> {
  await dispatch(actions.setServiceSize({ prefix, size }))
}
```

(adjust to whatever the controller's actual dispatch wrapper / module shape is — match the style of `setServiceConfig` in this file.)

- [ ] **Step 2: Export it from the controller's public surface (whatever the existing pattern is — `loadEnvironmentController` likely returns an object that includes it).**

- [ ] **Step 3: Typecheck.**

```bash
npm run tsc
```

- [ ] **Step 4: Commit.**

```bash
git add modules/cloud/controller.ts
git commit -m "feat(cloud): add setServiceSize controller method"
```

### Task D5: Build the `ServiceSizePopover` component

**Files:**
- Create: `modules/cloud/components/service-size-popover.tsx`

- [ ] **Step 1: Create the component:**

```tsx
'use client'

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { toast } from 'sonner'

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/modules/shared/components/ui/popover'
import { Button } from '@/modules/shared/components/ui/button'
import { ResourceSizePicker } from '@/modules/cloud/components/resource-size-picker'
import {
  APP_RESOURCE_MAP,
  CLINT_RESOURCE_MAP,
  SIZE_LABELS,
  type ResourceSpec,
} from '@/modules/cloud/lib/resource-maps'
import type { CloudEnvironmentServiceType, CloudResourceSize } from '@/modules/cloud/types'

const ALL_SIZES: CloudResourceSize[] = [
  'VETRA_AGENT_S',
  'VETRA_AGENT_M',
  'VETRA_AGENT_L',
  'VETRA_AGENT_XL',
  'VETRA_AGENT_XXL',
]

type Props = {
  serviceType: CloudEnvironmentServiceType
  prefix: string
  currentSize: CloudResourceSize | null
  canEdit: boolean
  onSave: (size: CloudResourceSize) => Promise<void>
}

export function ServiceSizePopover({ serviceType, prefix, currentSize, canEdit, onSave }: Props) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState<CloudResourceSize | null>(null)
  const map = serviceType === 'CLINT' ? CLINT_RESOURCE_MAP : APP_RESOURCE_MAP
  const effective: CloudResourceSize = currentSize ?? 'VETRA_AGENT_S'
  const display = pending ?? effective

  const handleChange = async (size: CloudResourceSize) => {
    setPending(size)
    try {
      await onSave(size)
      toast.success(`Resized ${prefix} to ${SIZE_LABELS[size]}`)
      setOpen(false)
    } catch (err) {
      setPending(null)
      toast.error(err instanceof Error ? err.message : 'Failed to resize')
    }
  }

  if (!canEdit) {
    return (
      <span className="text-muted-foreground text-xs font-medium">
        Size: {SIZE_LABELS[effective]}
      </span>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs">
          Size: {SIZE_LABELS[display]}
          <ChevronDown className="h-3 w-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-3">
        <ResourceSizePicker
          supported={ALL_SIZES}
          value={display}
          onChange={handleChange}
        />
        <ResourceTable map={map} highlight={display} />
        <p className="text-muted-foreground text-[11px]">
          Saving moves the environment to <code>CHANGES_PENDING</code>. Approve from the Overview tab to deploy.
        </p>
      </PopoverContent>
    </Popover>
  )
}

function ResourceTable({
  map,
  highlight,
}: {
  map: Record<CloudResourceSize, ResourceSpec>
  highlight: CloudResourceSize
}) {
  return (
    <div className="rounded border">
      <table className="w-full text-[11px]">
        <thead className="bg-muted/50">
          <tr>
            <th className="px-2 py-1 text-left font-medium">Size</th>
            <th className="px-2 py-1 text-left font-medium">Requests</th>
            <th className="px-2 py-1 text-left font-medium">Limits</th>
          </tr>
        </thead>
        <tbody>
          {ALL_SIZES.map((s) => {
            const r = map[s]
            const isCurrent = s === highlight
            return (
              <tr
                key={s}
                className={isCurrent ? 'bg-accent font-mono' : 'font-mono'}
              >
                <td className="px-2 py-1">{SIZE_LABELS[s]}</td>
                <td className="px-2 py-1">
                  {r.requests.cpu} / {r.requests.memory}
                </td>
                <td className="px-2 py-1">
                  {r.limits.cpu} / {r.limits.memory}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
```

- [ ] **Step 2: Verify `Popover` is available at `@/modules/shared/components/ui/popover` (Radix wrapper).** If it's not yet exported, the existing project should already wrap it (Radix is in the dependency tree per `vetra.to/CLAUDE.md`); add it from shadcn if missing.

```bash
ls /home/froid/projects/powerhouse/vetra.to/modules/shared/components/ui/popover.tsx 2>/dev/null || echo "MISSING — add via shadcn"
```

If missing, add it:

```bash
pnpm dlx shadcn@latest add popover
```

- [ ] **Step 3: Run typecheck.**

```bash
npm run tsc
```

- [ ] **Step 4: Commit.**

```bash
git add modules/cloud/components/service-size-popover.tsx modules/shared/components/ui/popover.tsx
git commit -m "feat(cloud): ServiceSizePopover component"
```

### Task D6: Wire the popover into `service-card.tsx` (Switchboard/Connect/Fusion)

**Files:**
- Modify: `modules/cloud/components/service-card.tsx`

- [ ] **Step 1: Pass the new props through. Update `ServiceCardProps`:**

```typescript
type ServiceCardProps = {
  serviceName: CloudEnvironmentServiceType
  label: string
  subdomain: string | null
  prefix: string
  pods: Pod[]
  isEnabled: boolean
  selectedRessource: CloudResourceSize | null
  canEdit: boolean
  onResize: (size: CloudResourceSize) => Promise<void>
}
```

- [ ] **Step 2: Inside the card, immediately before the `<Button … Visit …>`, insert:**

```tsx
<ServiceSizePopover
  serviceType={serviceName}
  prefix={prefix}
  currentSize={selectedRessource}
  canEdit={canEdit && isEnabled}
  onSave={onResize}
/>
```

- [ ] **Step 3: Update the call sites (Overview tab) to thread the new props through. In `app/cloud/[project]/tabs/overview.tsx`, find each `<ServiceCard …>` invocation and add:**

```tsx
selectedRessource={service.selectedRessource}
canEdit={canSign /* or whatever the existing owner-check is */}
onResize={(size) => controller.setServiceSize(service.prefix, size)}
```

- [ ] **Step 4: Run typecheck and start the dev server.**

```bash
npm run tsc
npm run dev
```

- [ ] **Step 5: Manual smoke test.** Open `http://localhost:3000/cloud/<some-env>`, find a Switchboard service, click the Size affordance. Confirm popover opens, size table is visible, choosing M dispatches and the environment goes to `CHANGES_PENDING`.

- [ ] **Step 6: Commit.**

```bash
git add modules/cloud/components/service-card.tsx app/cloud/\[project\]/tabs/overview.tsx
git commit -m "feat(cloud): inline size popover on service card"
```

### Task D7: Wire the popover into `agent-card.tsx` (CLINT)

**Files:**
- Modify: `modules/cloud/components/agent-card.tsx`

- [ ] **Step 1: Replace the existing inline size editor in the configure form with the popover.** Find the place where `ResourceSizePicker` is currently used inline; replace with:

```tsx
<ServiceSizePopover
  serviceType="CLINT"
  prefix={service.prefix}
  currentSize={service.selectedRessource ?? service.config?.selectedRessource ?? null}
  canEdit={canSign}
  onSave={(size) => controller.setServiceSize(service.prefix, size)}
/>
```

- [ ] **Step 2: Remove the now-unused `selectedRessource` write inside `setServiceConfig` calls — size is now mutated through `setServiceSize`.** (Other CLINT config fields — package, env, command — still flow through `setServiceConfig`.)

- [ ] **Step 3: Run typecheck and dev server.** Manually test resizing a CLINT agent.

```bash
npm run tsc
npm run dev
```

- [ ] **Step 4: Commit.**

```bash
git add modules/cloud/components/agent-card.tsx
git commit -m "feat(cloud): use ServiceSizePopover on agent card"
```

### Task D8: Manual end-to-end smoke

- [ ] **Step 1: With dev server running, repro the original bug shape.** Take a Switchboard env that's at S; bump it to L via the popover; approve changes.

- [ ] **Step 2: Watch the gitops repo (`powerhouse-k8s-hosting`)** for the resulting commit. Confirm the `tenants/<id>/powerhouse-values.yaml` diff shows `switchboard.resources.requests.memory` going from `512Mi` → `2Gi`, and `limits.memory` from `1Gi` → `4Gi`.

- [ ] **Step 3: Watch ArgoCD** sync the change and verify the new pod spec has the bumped resources.

- [ ] **Step 4: Mark the plan complete.**

---

## Self-review notes

Spec coverage:
- Spec §1 (doc model schema, op, reducer): Tasks A1–A4 ✓
- Spec §2 (processor): Tasks B1–B2 ✓
- Spec §3 (vetra.to UI): Tasks D1–D7 ✓
- Spec §4 (test plan): unit tests in A3 + B1; component-level coverage is manual smoke (D6/D7/D8) — formal RTL tests deferred unless code-review insists
- Spec §5 (migration & rollout): no schema migration needed (additive optional field); rollout = publish vetra-cloud-package dev tag (Task C1) → bump in vetra.to (Task D1) → manual e2e (Task D8)
