# Update Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users discover and apply available updates for services and packages through the cloud detail UI, with version checks against `cr.vetra.io` and the configurable package registry.

**Architecture:** The document model gains a `version` field on services plus two new operations (`SET_SERVICE_VERSION`, `UPDATE_PACKAGE_VERSION`). The processor uses service versions for image tags. `vetra.to` adds registry-checking hooks and an "Available Updates" card that dispatches these operations, feeding into the existing approve → deploy flow.

**Tech Stack:** Powerhouse document model (GraphQL schema, reducers, MCP), Next.js API routes, React hooks, TypeScript

**Spec:** `docs/superpowers/specs/2026-03-31-update-notifications-design.md`

---

### Task 1: Add `version` field to service state schema via MCP

**Files:**
- Modify (via MCP): `document-models/vetra-cloud-environment/vetra-cloud-environment.json`
- Auto-generated: `document-models/vetra-cloud-environment/v1/schema.graphql`, `gen/schema/types.ts`, `gen/schema/zod.ts`

- [ ] **Step 1: Check the document model schema**

Run MCP tool `getDocumentModelSchema` with `type: "powerhouse/document-model"` to confirm the available operations and input schemas.

- [ ] **Step 2: Update the state schema via MCP**

Use `addActions` on the vetra-cloud-environment document model document (find it on the "vetra" drive) with `SET_STATE_SCHEMA` to add `version: String` to `VetraCloudEnvironmentService`:

```graphql
type VetraCloudEnvironmentService {
  type: VetraCloudEnvironmentServiceType!
  prefix: String!
  enabled: Boolean!
  url: String
  status: ServiceStatus!
  version: String
}
```

The full state schema must be provided (not just the diff). Copy the existing schema from `v1/schema.graphql` and add the `version` field.

- [ ] **Step 3: Verify generated files**

Check that `v1/schema.graphql` now includes `version: String` on `VetraCloudEnvironmentService` and that the generated types in `gen/schema/types.ts` include the field.

- [ ] **Step 4: Update ENABLE_SERVICE reducer to set version: null**

The `enableServiceOperation` in `v1/src/reducers/services.ts` pushes new services without a `version` field. Update it to include `version: null`:

```typescript
state.services.push({
  type,
  prefix,
  enabled: true,
  url: null,
  status: "PROVISIONING",
  version: null,
});
```

Also update the MCP document model's ENABLE_SERVICE reducer with the same change via `SET_OPERATION_REDUCER` on operation `op-enable-svc` in module `svc-mod-001`.

- [ ] **Step 5: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 6: Update existing tests**

In `v1/tests/services.test.ts`, update all `toStrictEqual` expectations to include `version: null` on service objects. For example:

```typescript
expect(updatedDocument.state.global.services).toStrictEqual([
  {
    type: "CONNECT",
    prefix: "connect",
    enabled: true,
    url: null,
    status: "PROVISIONING",
    version: null,
  },
]);
```

Update all service object expectations in the file similarly.

- [ ] **Step 7: Run tests**

Run: `npx vitest run document-models/vetra-cloud-environment/v1/tests/services.test.ts`
Expected: All tests pass.

- [ ] **Step 8: Commit**

```bash
git add document-models/
git commit -m "feat(model): add version field to service state schema"
```

---

### Task 2: Add `SET_SERVICE_VERSION` operation via MCP

**Files:**
- Modify (via MCP): `document-models/vetra-cloud-environment/vetra-cloud-environment.json`
- Modify: `document-models/vetra-cloud-environment/v1/src/reducers/services.ts`
- Modify: `document-models/vetra-cloud-environment/v1/tests/services.test.ts`

- [ ] **Step 1: Add the operation to the document model via MCP**

Use `addActions` on the document model document with `ADD_OPERATION`:

```json
{
  "moduleId": "svc-mod-001",
  "name": "SET_SERVICE_VERSION",
  "id": "op-set-svc-version",
  "description": "Set the version/image tag for a service",
  "scope": "global"
}
```

- [ ] **Step 2: Set the operation schema via MCP**

Use `SET_OPERATION_SCHEMA` on `op-set-svc-version`:

```graphql
input SetServiceVersionInput {
  type: VetraCloudEnvironmentServiceType!
  version: String!
}
```

- [ ] **Step 3: Add the operation error via MCP**

Use `ADD_OPERATION_ERROR` on `op-set-svc-version`:

```json
{
  "operationId": "op-set-svc-version",
  "id": "err-svc-not-found-4",
  "code": "SERVICE_NOT_FOUND",
  "name": "ServiceNotFoundError",
  "description": "The specified service type was not found in the environment"
}
```

- [ ] **Step 4: Set the operation reducer via MCP**

Use `SET_OPERATION_REDUCER` on `op-set-svc-version`:

```javascript
const service = state.services.find((s) => s.type === action.input.type);
if (!service) {
  throw new ServiceNotFoundError("Service " + action.input.type + " not found");
}
service.version = action.input.version;
markPendingIfDeployed(state);
```

Note: `markPendingIfDeployed` is defined in `utils.ts` and is already imported in the services reducer file.

- [ ] **Step 5: Implement the reducer in src**

Add `setServiceVersionOperation` to `v1/src/reducers/services.ts`:

```typescript
setServiceVersionOperation(state, action) {
  const service = state.services.find((s) => s.type === action.input.type);
  if (!service) {
    throw new ServiceNotFoundError(
      "Service " + action.input.type + " not found",
    );
  }
  service.version = action.input.version;
  markPendingIfDeployed(state);
},
```

Add it inside the `vetraCloudEnvironmentServicesOperations` object, after `setServiceStatusOperation`.

- [ ] **Step 6: Write tests**

Add to `v1/tests/services.test.ts`. Import `setServiceVersion` and `SetServiceVersionInputSchema` from the document model:

```typescript
import {
  // ... existing imports ...
  setServiceVersion,
  SetServiceVersionInputSchema,
} from "document-models/vetra-cloud-environment/v1";
```

Add test block:

```typescript
describe("SET_SERVICE_VERSION", () => {
  it("should set version on an existing service", () => {
    let document = utils.createDocument();
    document = reducer(
      document,
      enableService({ type: "CONNECT", prefix: "connect" }),
    );
    document = reducer(
      document,
      setServiceVersion({ type: "CONNECT", version: "v1.2.0" }),
    );

    expect(document.state.global.services[0].version).toBe("v1.2.0");
  });

  it("should throw ServiceNotFoundError for unknown service", () => {
    const document = utils.createDocument();
    expect(() =>
      reducer(
        document,
        setServiceVersion({ type: "FUSION", version: "v1.0.0" }),
      ),
    ).toThrow();
  });

  it("should set status to CHANGES_PENDING when deployed", () => {
    let document = utils.createDocument();
    document = reducer(
      document,
      initialize({
        genericSubdomain: "test",
        genericBaseDomain: "test.example.com",
        defaultPackageRegistry: null,
      }),
    );
    document = reducer(
      document,
      enableService({ type: "CONNECT", prefix: "connect" }),
    );
    // Reset to READY to test markPendingIfDeployed
    document = reducer(
      document,
      setServiceVersion({ type: "CONNECT", version: "v1.0.0" }),
    );
    expect(document.state.global.status).toBe("CHANGES_PENDING");
  });
});

it("should handle setServiceVersion operation", () => {
  let document = utils.createDocument();
  document = reducer(
    document,
    enableService({ type: "CONNECT", prefix: "connect" }),
  );
  const input = { type: "CONNECT" as const, version: "v2.0.0" };
  const updatedDocument = reducer(document, setServiceVersion(input));

  expect(isVetraCloudEnvironmentDocument(updatedDocument)).toBe(true);
  expect(updatedDocument.operations.global).toHaveLength(2);
  expect(updatedDocument.operations.global[1].action.type).toBe(
    "SET_SERVICE_VERSION",
  );
  expect(updatedDocument.operations.global[1].action.input).toStrictEqual(
    input,
  );
});
```

- [ ] **Step 7: Run tests**

Run: `npx vitest run document-models/vetra-cloud-environment/v1/tests/services.test.ts`
Expected: All tests pass.

- [ ] **Step 8: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 9: Commit**

```bash
git add document-models/
git commit -m "feat(model): add SET_SERVICE_VERSION operation"
```

---

### Task 3: Add `UPDATE_PACKAGE_VERSION` operation via MCP

**Files:**
- Modify (via MCP): `document-models/vetra-cloud-environment/vetra-cloud-environment.json`
- Modify: `document-models/vetra-cloud-environment/v1/src/reducers/packages.ts`
- Modify: `document-models/vetra-cloud-environment/v1/tests/packages.test.ts`

- [ ] **Step 1: Add the operation to the document model via MCP**

Use `addActions` with `ADD_OPERATION`:

```json
{
  "moduleId": "pkg-mod-001",
  "name": "UPDATE_PACKAGE_VERSION",
  "id": "op-update-pkg-version",
  "description": "Update the version of an installed package",
  "scope": "global"
}
```

- [ ] **Step 2: Set the operation schema via MCP**

Use `SET_OPERATION_SCHEMA` on `op-update-pkg-version`:

```graphql
input UpdatePackageVersionInput {
  packageName: String!
  version: String!
}
```

- [ ] **Step 3: Add the operation error via MCP**

Use `ADD_OPERATION_ERROR` on `op-update-pkg-version`:

```json
{
  "operationId": "op-update-pkg-version",
  "id": "err-pkg-not-found",
  "code": "PACKAGE_NOT_FOUND",
  "name": "PackageNotFoundError",
  "description": "The specified package was not found in the environment"
}
```

- [ ] **Step 4: Set the operation reducer via MCP**

Use `SET_OPERATION_REDUCER` on `op-update-pkg-version`:

```javascript
const pkg = state.packages.find((p) => p.name === action.input.packageName);
if (!pkg) {
  throw new PackageNotFoundError("Package " + action.input.packageName + " not found");
}
pkg.version = action.input.version;
markPendingIfDeployed(state);
```

- [ ] **Step 5: Implement the reducer in src**

Add `updatePackageVersionOperation` to `v1/src/reducers/packages.ts`. Add the error import:

```typescript
import { PackageNotFoundError } from "../../gen/packages/error.js";
```

Add the operation inside the `vetraCloudEnvironmentPackagesOperations` object:

```typescript
updatePackageVersionOperation(state, action) {
  const pkg = state.packages.find(
    (p) => p.name === action.input.packageName,
  );
  if (!pkg) {
    throw new PackageNotFoundError(
      "Package " + action.input.packageName + " not found",
    );
  }
  pkg.version = action.input.version;
  markPendingIfDeployed(state);
},
```

- [ ] **Step 6: Write tests**

Add to `v1/tests/packages.test.ts`. Import `updatePackageVersion`:

```typescript
import {
  // ... existing imports ...
  updatePackageVersion,
} from "document-models/vetra-cloud-environment/v1";
```

Add test block:

```typescript
describe("UPDATE_PACKAGE_VERSION", () => {
  it("should update version of an existing package", () => {
    let document = utils.createDocument();
    document = reducer(
      document,
      addPackage({ packageName: "my-package", version: "1.0.0" }),
    );
    document = reducer(
      document,
      updatePackageVersion({ packageName: "my-package", version: "2.0.0" }),
    );

    expect(document.state.global.packages[0].version).toBe("2.0.0");
  });

  it("should throw PackageNotFoundError for unknown package", () => {
    const document = utils.createDocument();
    expect(() =>
      reducer(
        document,
        updatePackageVersion({ packageName: "nonexistent", version: "1.0.0" }),
      ),
    ).toThrow();
  });

  it("should set status to CHANGES_PENDING when deployed", () => {
    let document = utils.createDocument();
    document = reducer(
      document,
      initialize({
        genericSubdomain: "test",
        genericBaseDomain: "test.example.com",
        defaultPackageRegistry: null,
      }),
    );
    document = reducer(
      document,
      addPackage({ packageName: "my-package", version: "1.0.0" }),
    );
    document = reducer(
      document,
      updatePackageVersion({ packageName: "my-package", version: "2.0.0" }),
    );
    expect(document.state.global.status).toBe("CHANGES_PENDING");
  });
});

it("should handle updatePackageVersion operation", () => {
  let document = utils.createDocument();
  document = reducer(
    document,
    addPackage({ packageName: "my-package", version: "1.0.0" }),
  );
  const input = { packageName: "my-package", version: "2.0.0" };
  const updatedDocument = reducer(document, updatePackageVersion(input));

  expect(isVetraCloudEnvironmentDocument(updatedDocument)).toBe(true);
  expect(updatedDocument.operations.global).toHaveLength(2);
  expect(updatedDocument.operations.global[1].action.type).toBe(
    "UPDATE_PACKAGE_VERSION",
  );
  expect(updatedDocument.operations.global[1].action.input).toStrictEqual(
    input,
  );
});
```

- [ ] **Step 7: Run tests**

Run: `npx vitest run document-models/vetra-cloud-environment/v1/tests/packages.test.ts`
Expected: All tests pass.

- [ ] **Step 8: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 9: Commit**

```bash
git add document-models/
git commit -m "feat(model): add UPDATE_PACKAGE_VERSION operation"
```

---

### Task 4: Update processor to use service version for image tags

**Files:**
- Modify: `processors/vetra-cloud-environment/gitops.ts:303-305,365-367`

- [ ] **Step 1: Update switchboard image tag**

In `processors/vetra-cloud-environment/gitops.ts`, in `generateValuesYaml()`, find the switchboard section and replace the hardcoded tag. First extract the service version:

After the existing `switchboardEnabled` and `connectEnabled` lines (around line 225-230), add:

```typescript
const switchboardService = state.services.find(
  (s) => s.type === "SWITCHBOARD",
);
const connectService = state.services.find(
  (s) => s.type === "CONNECT",
);
```

Then replace line 304 (`tag: dev` under switchboard image):

```yaml
    tag: ${switchboardService?.version ?? "dev"}
```

And replace line 366 (`tag: dev` under connect image):

```yaml
    tag: ${connectService?.version ?? "dev"}
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add processors/
git commit -m "feat(processor): use service version field for image tags in gitops"
```

---

### Task 5: Add container registry API route in `vetra.to`

**Files:**
- Create: `/home/froid/projects/powerhouse/vetra.to/app/api/registry/tags/route.ts`

- [ ] **Step 1: Create the API route**

This route proxies Docker Registry V2 tag list requests to avoid CORS issues. Create `/home/froid/projects/powerhouse/vetra.to/app/api/registry/tags/route.ts`:

```typescript
import { type NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const IMAGE_MAP: Record<string, string> = {
  CONNECT: 'powerhouse-inc-powerhouse/connect',
  SWITCHBOARD: 'powerhouse-inc-powerhouse/switchboard',
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const serviceType = searchParams.get('service')
    const registry = searchParams.get('registry') ?? 'https://cr.vetra.io'

    if (!serviceType) {
      return NextResponse.json(
        { error: 'service parameter is required' },
        { status: 400 },
      )
    }

    const imagePath = IMAGE_MAP[serviceType.toUpperCase()]
    if (!imagePath) {
      return NextResponse.json(
        { error: `Unknown service type: ${serviceType}` },
        { status: 400 },
      )
    }

    const url = new URL(`/v2/${imagePath}/tags/list`, registry)
    const res = await fetch(url.toString(), { next: { revalidate: 300 } })

    if (!res.ok) {
      return NextResponse.json(
        { error: 'Failed to fetch tags from registry' },
        { status: 502 },
      )
    }

    const data = (await res.json()) as { name?: string; tags?: string[] }

    return NextResponse.json({ tags: data.tags ?? [] })
  } catch (error) {
    console.error('Registry tags API error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch tags' },
      { status: 500 },
    )
  }
}
```

- [ ] **Step 2: Commit**

```bash
cd /home/froid/projects/powerhouse/vetra.to
git add app/api/registry/tags/route.ts
git commit -m "feat: add container registry tags API route"
```

---

### Task 6: Add `useServiceUpdates` hook in `vetra.to`

**Files:**
- Create: `/home/froid/projects/powerhouse/vetra.to/modules/cloud/hooks/use-service-updates.ts`

- [ ] **Step 1: Create the hook**

Create `/home/froid/projects/powerhouse/vetra.to/modules/cloud/hooks/use-service-updates.ts`:

```typescript
'use client'

import { useState, useEffect, useRef } from 'react'
import type { CloudEnvironmentService } from '../types'

export type ServiceUpdate = {
  serviceType: CloudEnvironmentService['type']
  currentVersion: string | null
  latestVersion: string
}

export function useServiceUpdates(services: CloudEnvironmentService[]) {
  const [updates, setUpdates] = useState<ServiceUpdate[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const enabledServices = services.filter((s) => s.enabled)
    if (enabledServices.length === 0) {
      setUpdates([])
      return
    }

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setIsLoading(true)

    Promise.all(
      enabledServices.map(async (service) => {
        try {
          const params = new URLSearchParams({ service: service.type })
          const res = await fetch(`/api/registry/tags?${params}`, {
            signal: controller.signal,
          })
          if (!res.ok) return null

          const data = (await res.json()) as { tags: string[] }
          const tags = data.tags ?? []
          if (tags.length === 0) return null

          // Use the last tag in the list as "latest"
          const latestTag = tags[tags.length - 1]
          if (!latestTag || latestTag === service.version) return null

          return {
            serviceType: service.type,
            currentVersion: service.version,
            latestVersion: latestTag,
          } satisfies ServiceUpdate
        } catch {
          return null
        }
      }),
    )
      .then((results) => {
        if (!controller.signal.aborted) {
          setUpdates(results.filter((r): r is ServiceUpdate => r !== null))
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setIsLoading(false)
        }
      })

    return () => controller.abort()
  }, [services])

  return { updates, isLoading }
}
```

- [ ] **Step 2: Commit**

```bash
cd /home/froid/projects/powerhouse/vetra.to
git add modules/cloud/hooks/use-service-updates.ts
git commit -m "feat: add useServiceUpdates hook for container registry checks"
```

---

### Task 7: Add `usePackageUpdates` hook in `vetra.to`

**Files:**
- Create: `/home/froid/projects/powerhouse/vetra.to/modules/cloud/hooks/use-package-updates.ts`

- [ ] **Step 1: Create the hook**

Create `/home/froid/projects/powerhouse/vetra.to/modules/cloud/hooks/use-package-updates.ts`:

```typescript
'use client'

import { useState, useEffect, useRef } from 'react'
import type { CloudPackage } from '../types'

export type PackageUpdate = {
  packageName: string
  currentVersion: string | null
  latestVersion: string
}

export function usePackageUpdates(
  packages: CloudPackage[],
  registryUrl: string | null,
) {
  const [updates, setUpdates] = useState<PackageUpdate[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!registryUrl || packages.length === 0) {
      setUpdates([])
      return
    }

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setIsLoading(true)

    Promise.all(
      packages.map(async (pkg) => {
        try {
          const params = new URLSearchParams({
            registry: pkg.registry || registryUrl,
            package: pkg.name,
          })
          const res = await fetch(`/api/registry/versions?${params}`, {
            signal: controller.signal,
          })
          if (!res.ok) return null

          const data = (await res.json()) as {
            distTags: Record<string, string>
            versions: string[]
          }
          const latestVersion = data.distTags?.latest
          if (!latestVersion || latestVersion === pkg.version) return null

          return {
            packageName: pkg.name,
            currentVersion: pkg.version,
            latestVersion,
          } satisfies PackageUpdate
        } catch {
          return null
        }
      }),
    )
      .then((results) => {
        if (!controller.signal.aborted) {
          setUpdates(results.filter((r): r is PackageUpdate => r !== null))
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setIsLoading(false)
        }
      })

    return () => controller.abort()
  }, [packages, registryUrl])

  return { updates, isLoading }
}
```

- [ ] **Step 2: Commit**

```bash
cd /home/froid/projects/powerhouse/vetra.to
git add modules/cloud/hooks/use-package-updates.ts
git commit -m "feat: add usePackageUpdates hook for package registry checks"
```

---

### Task 8: Add GraphQL mutations and types in `vetra.to`

**Files:**
- Modify: `/home/froid/projects/powerhouse/vetra.to/modules/cloud/types.ts`
- Modify: `/home/froid/projects/powerhouse/vetra.to/modules/cloud/graphql.ts`
- Modify: `/home/froid/projects/powerhouse/vetra.to/modules/cloud/hooks/use-environment-detail.ts`

- [ ] **Step 1: Add `version` to service type**

In `/home/froid/projects/powerhouse/vetra.to/modules/cloud/types.ts`, add `version` to `CloudEnvironmentService`:

```typescript
export type CloudEnvironmentService = {
  type: CloudEnvironmentServiceType
  prefix: string
  enabled: boolean
  url: string | null
  status: ServiceStatus
  version: string | null
}
```

- [ ] **Step 2: Add `version` to GraphQL service fields**

In `/home/froid/projects/powerhouse/vetra.to/modules/cloud/graphql.ts`, update the `SERVICE_FIELDS` constant:

```typescript
const SERVICE_FIELDS = `type prefix enabled url status version`
```

- [ ] **Step 3: Add mutation functions**

In `/home/froid/projects/powerhouse/vetra.to/modules/cloud/graphql.ts`, add before the `// Observability queries` section:

```typescript
// ---------------------------------------------------------------------------
// Update mutations
// ---------------------------------------------------------------------------

export async function setServiceVersion(
  docId: string,
  type: string,
  version: string,
  token?: string | null,
): Promise<CloudEnvironment> {
  const data = await gql<
    Namespaced<{
      setServiceVersion: RawDocument
    }>
  >(
    `mutation ($docId: PHID!, $input: VetraCloudEnvironment_SetServiceVersionInput!) {
      VetraCloudEnvironment {
        setServiceVersion(docId: $docId, input: $input) {
          ${DOCUMENT_FIELDS}
        }
      }
    }`,
    { docId, input: { type, version } },
    token,
  )

  return mapDocument(data.VetraCloudEnvironment.setServiceVersion)
}

export async function updatePackageVersion(
  docId: string,
  packageName: string,
  version: string,
  token?: string | null,
): Promise<CloudEnvironment> {
  const data = await gql<
    Namespaced<{
      updatePackageVersion: RawDocument
    }>
  >(
    `mutation ($docId: PHID!, $input: VetraCloudEnvironment_UpdatePackageVersionInput!) {
      VetraCloudEnvironment {
        updatePackageVersion(docId: $docId, input: $input) {
          ${DOCUMENT_FIELDS}
        }
      }
    }`,
    { docId, input: { packageName, version } },
    token,
  )

  return mapDocument(data.VetraCloudEnvironment.updatePackageVersion)
}
```

- [ ] **Step 4: Add callbacks to the hook**

In `/home/froid/projects/powerhouse/vetra.to/modules/cloud/hooks/use-environment-detail.ts`, add imports:

```typescript
import {
  // ... existing imports ...
  setServiceVersion as gqlSetServiceVersion,
  updatePackageVersion as gqlUpdatePackageVersion,
} from '../graphql'
```

Add callbacks before the `return` block:

```typescript
const setServiceVersion = useCallback(
  (type: CloudEnvironmentServiceType, version: string) =>
    mutate((t) => gqlSetServiceVersion(documentId, type, version, t)),
  [documentId, mutate],
)
const updatePackageVersion = useCallback(
  (packageName: string, version: string) =>
    mutate((t) => gqlUpdatePackageVersion(documentId, packageName, version, t)),
  [documentId, mutate],
)
```

Add `CloudEnvironmentServiceType` to the import from `../types` if not already imported.

Add to the return object:

```typescript
return {
  // ... existing ...
  setServiceVersion,
  updatePackageVersion,
}
```

- [ ] **Step 5: Run typecheck**

Run: `cd /home/froid/projects/powerhouse/vetra.to && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
cd /home/froid/projects/powerhouse/vetra.to
git add modules/cloud/
git commit -m "feat: add setServiceVersion and updatePackageVersion mutations and types"
```

---

### Task 9: Create `AvailableUpdatesCard` component in `vetra.to`

**Files:**
- Create: `/home/froid/projects/powerhouse/vetra.to/modules/cloud/components/available-updates-card.tsx`

- [ ] **Step 1: Create the component**

Create `/home/froid/projects/powerhouse/vetra.to/modules/cloud/components/available-updates-card.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { ArrowRight, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/modules/shared/components/ui/badge'
import { Button } from '@/modules/shared/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/modules/shared/components/ui/card'
import type { ServiceUpdate } from '../hooks/use-service-updates'
import type { PackageUpdate } from '../hooks/use-package-updates'

type Props = {
  serviceUpdates: ServiceUpdate[]
  packageUpdates: PackageUpdate[]
  onUpdateService: (serviceType: string, version: string) => Promise<void>
  onUpdatePackage: (packageName: string, version: string) => Promise<void>
}

export function AvailableUpdatesCard({
  serviceUpdates,
  packageUpdates,
  onUpdateService,
  onUpdatePackage,
}: Props) {
  const [updating, setUpdating] = useState<Set<string>>(new Set())
  const [updatingAll, setUpdatingAll] = useState(false)

  const totalUpdates = serviceUpdates.length + packageUpdates.length
  if (totalUpdates === 0) return null

  const markUpdating = (key: string) =>
    setUpdating((prev) => new Set(prev).add(key))
  const clearUpdating = (key: string) =>
    setUpdating((prev) => {
      const next = new Set(prev)
      next.delete(key)
      return next
    })

  const handleUpdateService = async (serviceType: string, version: string) => {
    const key = `service:${serviceType}`
    markUpdating(key)
    try {
      await onUpdateService(serviceType, version)
      toast.success(`${serviceType} updated to ${version}`)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : `Failed to update ${serviceType}`,
      )
    } finally {
      clearUpdating(key)
    }
  }

  const handleUpdatePackage = async (packageName: string, version: string) => {
    const key = `package:${packageName}`
    markUpdating(key)
    try {
      await onUpdatePackage(packageName, version)
      toast.success(`${packageName} updated to ${version}`)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : `Failed to update ${packageName}`,
      )
    } finally {
      clearUpdating(key)
    }
  }

  const handleUpdateAll = async () => {
    setUpdatingAll(true)
    try {
      for (const update of serviceUpdates) {
        await handleUpdateService(update.serviceType, update.latestVersion)
      }
      for (const update of packageUpdates) {
        await handleUpdatePackage(update.packageName, update.latestVersion)
      }
    } finally {
      setUpdatingAll(false)
    }
  }

  return (
    <Card className="border-blue-500/30 bg-blue-500/5 dark:border-blue-500/20 dark:bg-blue-500/5">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <RefreshCw className="h-4 w-4" />
              Available Updates
            </CardTitle>
            <Badge
              variant="outline"
              className="border-blue-500/30 bg-blue-500/10 text-blue-500 text-xs"
            >
              {totalUpdates}
            </Badge>
          </div>
          <Button
            size="sm"
            onClick={handleUpdateAll}
            disabled={updatingAll}
          >
            {updatingAll ? 'Updating...' : 'Update All'}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {serviceUpdates.map((update) => {
          const key = `service:${update.serviceType}`
          return (
            <div
              key={key}
              className="flex items-center justify-between rounded-lg border p-3"
            >
              <div>
                <p className="text-sm font-medium">{update.serviceType}</p>
                <div className="text-muted-foreground flex items-center gap-1.5 font-mono text-xs">
                  <span>{update.currentVersion ?? 'not set'}</span>
                  <ArrowRight className="h-3 w-3" />
                  <span className="text-emerald-500">{update.latestVersion}</span>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  handleUpdateService(update.serviceType, update.latestVersion)
                }
                disabled={updating.has(key) || updatingAll}
              >
                {updating.has(key) ? 'Updating...' : 'Update'}
              </Button>
            </div>
          )
        })}
        {packageUpdates.map((update) => {
          const key = `package:${update.packageName}`
          return (
            <div
              key={key}
              className="flex items-center justify-between rounded-lg border p-3"
            >
              <div>
                <p className="text-sm font-medium">{update.packageName}</p>
                <div className="text-muted-foreground flex items-center gap-1.5 font-mono text-xs">
                  <span>{update.currentVersion ?? 'not set'}</span>
                  <ArrowRight className="h-3 w-3" />
                  <span className="text-emerald-500">{update.latestVersion}</span>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  handleUpdatePackage(update.packageName, update.latestVersion)
                }
                disabled={updating.has(key) || updatingAll}
              >
                {updating.has(key) ? 'Updating...' : 'Update'}
              </Button>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 2: Commit**

```bash
cd /home/froid/projects/powerhouse/vetra.to
git add modules/cloud/components/available-updates-card.tsx
git commit -m "feat: add AvailableUpdatesCard component"
```

---

### Task 10: Wire everything together in the overview tab

**Files:**
- Modify: `/home/froid/projects/powerhouse/vetra.to/app/cloud/[project]/page.tsx`
- Modify: `/home/froid/projects/powerhouse/vetra.to/app/cloud/[project]/tabs/overview.tsx`

- [ ] **Step 1: Add props to OverviewTab**

In `/home/froid/projects/powerhouse/vetra.to/app/cloud/[project]/tabs/overview.tsx`, add to the `OverviewTabProps` interface:

```typescript
setServiceVersion?: (type: CloudEnvironmentServiceType, version: string) => Promise<void>
updatePackageVersion?: (packageName: string, version: string) => Promise<void>
```

Destructure them in the `OverviewTab` function parameters.

- [ ] **Step 2: Add the hooks and card to OverviewTab**

Add imports at the top of overview.tsx:

```typescript
import { AvailableUpdatesCard } from '@/modules/cloud/components/available-updates-card'
import { useServiceUpdates } from '@/modules/cloud/hooks/use-service-updates'
import { usePackageUpdates } from '@/modules/cloud/hooks/use-package-updates'
```

Inside the `OverviewTab` component body, after the existing hooks (like `useEnvironmentStatus`), add:

```typescript
const { updates: serviceUpdates } = useServiceUpdates(state.services)
const { updates: packageUpdates } = usePackageUpdates(
  state.packages,
  state.defaultPackageRegistry ?? null,
)
```

- [ ] **Step 3: Render the card above services/packages**

In the JSX, add the `AvailableUpdatesCard` just before the services/packages grid (the `<div className="grid gap-6 md:grid-cols-2">` that contains the Services card and Packages card):

```tsx
{setServiceVersion && updatePackageVersion && (
  <AvailableUpdatesCard
    serviceUpdates={serviceUpdates}
    packageUpdates={packageUpdates}
    onUpdateService={(type, version) =>
      setServiceVersion(type as CloudEnvironmentServiceType, version)
    }
    onUpdatePackage={updatePackageVersion}
  />
)}
```

- [ ] **Step 4: Pass props from page.tsx**

In `/home/froid/projects/powerhouse/vetra.to/app/cloud/[project]/page.tsx`, add the new props to the `<OverviewTab>` component:

```tsx
<OverviewTab
  // ... existing props ...
  setServiceVersion={detail.setServiceVersion}
  updatePackageVersion={detail.updatePackageVersion}
/>
```

- [ ] **Step 5: Run typecheck**

Run: `cd /home/froid/projects/powerhouse/vetra.to && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
cd /home/froid/projects/powerhouse/vetra.to
git add app/cloud/
git commit -m "feat: wire AvailableUpdatesCard into cloud detail page"
```

---

### Task 11: Final verification

- [ ] **Step 1: Run typecheck on vetra-cloud-package**

Run: `cd /home/froid/projects/powerhouse/vetra-cloud-package && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 2: Run tests on vetra-cloud-package**

Run: `cd /home/froid/projects/powerhouse/vetra-cloud-package && npx vitest run`
Expected: All tests pass.

- [ ] **Step 3: Run typecheck on vetra.to**

Run: `cd /home/froid/projects/powerhouse/vetra.to && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Run lint on vetra-cloud-package**

Run: `cd /home/froid/projects/powerhouse/vetra-cloud-package && npm run lint:fix`
Expected: No errors.
