# Update Notifications for Cloud Environments

**Date**: 2026-03-31

## Problem

Users managing cloud environments need to know when newer versions of services (Connect, Switchboard) or packages (reactor modules) are available. Currently there is no mechanism to discover or apply updates — the user must know the version externally and manually reconfigure.

## Solution

`vetra.to` checks container and package registries on page load, compares against the deployed versions stored in the document model, and displays an "Available Updates" card when newer versions exist. Users click "Update" per item or "Update All", which dispatches document model operations. The existing approve → deploy flow handles the rest.

## Architecture

### Data Flow

```
Page load
  → useServiceUpdates()  → GET cr.vetra.io/v2/<image>/tags/list
  → usePackageUpdates()  → GET <registryUrl>/<package>
  → Compare against document state (service.version, package.version)
  → Render AvailableUpdatesCard if any differ

User clicks "Update"
  → dispatch SET_SERVICE_VERSION / SET_PACKAGE_VERSION
  → status → CHANGES_PENDING
  → User clicks "Approve Changes"
  → Processor syncs to gitops (uses service.version for image tags)
```

### No backend involvement for discovery

Registry lookups happen entirely in `vetra.to` (client-side or Next.js API routes). The document model and processor are only involved when the user chooses to apply an update. If a registry lookup fails, that item silently shows no update available.

## Changes

### 1. Document Model (`vetra-cloud-package`)

#### State Schema

Add `version` field to `VetraCloudEnvironmentService`:

```graphql
type VetraCloudEnvironmentService {
  type: VetraCloudEnvironmentServiceType!
  prefix: String!
  enabled: Boolean!
  url: String
  status: ServiceStatus!
  version: String          # NEW — image tag, e.g. "dev", "staging", "v1.2.0"
}
```

#### New Operations

**`SET_SERVICE_VERSION`** (services module)

```graphql
input SetServiceVersionInput {
  type: VetraCloudEnvironmentServiceType!
  version: String!
}
```

Reducer:
- Find service by `type`, throw `ServiceNotFoundError` if missing
- Set `service.version = action.input.version`
- Call `markPendingIfDeployed(state)`

**`SET_PACKAGE_VERSION`** (packages module)

```graphql
input SetPackageVersionInput {
  packageName: String!
  version: String!
}
```

Reducer:
- Find package by `name`, throw `PackageNotFoundError` if missing
- Set `package.version = action.input.version`
- Call `markPendingIfDeployed(state)`

#### Initial State

Services should initialize with `version: null`. The `ENABLE_SERVICE` reducer should accept an optional `version` parameter, defaulting to `null`.

### 2. Processor (`vetra-cloud-package`)

Update `generateValuesYaml()` in `processors/vetra-cloud-environment/gitops.ts`:

- For each service (switchboard, connect), use `service.version ?? "dev"` as the image tag instead of the hardcoded `"dev"`.

```yaml
switchboard:
  image:
    tag: <service.version ?? "dev">
connect:
  image:
    tag: <service.version ?? "dev">
```

### 3. Registry Hooks (`vetra.to`)

#### `useServiceUpdates(services, registryBase?)`

- Default registry: `cr.vetra.io`
- For each enabled service, fetch tags from `cr.vetra.io/v2/powerhouse-inc-powerhouse/<image>/tags/list`
  - Image mapping: `CONNECT → connect`, `SWITCHBOARD → switchboard`
- Compare the service's `version` field against the latest tag in the registry
- Return array of `{ serviceType, currentVersion, latestVersion }` where versions differ
- Cache results for 5 minutes (client-side, e.g. `useSWR` with `refreshInterval`)
- On fetch error: silently return no update for that service

#### `usePackageUpdates(packages, registryUrl)`

- Registry URL comes from `state.defaultPackageRegistry` (e.g. `https://registry.dev.vetra.io`)
- For each package, fetch version info from the registry
- Compare against `package.version`
- Return array of `{ packageName, currentVersion, latestVersion }` where versions differ
- Same caching and error handling as service updates

#### Registry API details

**Container registry** (`cr.vetra.io`): Standard Docker Registry HTTP API V2
- `GET /v2/<name>/tags/list` → `{ "tags": ["dev", "staging", "v1.0.0", ...] }`
- Determining "latest": use the most recent semver tag, or fall back to ordering by tag list position

**Package registry** (`registry.dev.vetra.io`): npm-compatible registry
- `GET /<package>` → standard npm package metadata with `dist-tags.latest` and `versions`
- Compare `dist-tags.latest` against installed version

### 4. UI (`vetra.to`)

#### `AvailableUpdatesCard` Component

- Only renders when there is at least one service or package update available
- Positioned above the Services / Reactor Modules row on the overview tab
- Card header: "Available Updates" with count badge and "Update All" button
- Each update row shows:
  - Item name (service label or package name)
  - Version transition: `current → latest` (monospace, with green highlight on the new version)
  - Individual "Update" button
- "Update All" dispatches all updates in sequence

#### Actions

- "Update" on a service row → dispatch `SET_SERVICE_VERSION` mutation with `{ type, version: latestVersion }`
- "Update" on a package row → dispatch `SET_PACKAGE_VERSION` mutation with `{ packageName, version: latestVersion }`
- "Update All" → dispatch all pending updates sequentially
- After any update, the environment transitions to `CHANGES_PENDING` and the existing "Approve Changes" button appears

#### GraphQL Mutations (new)

```graphql
mutation ($docId: PHID!, $input: VetraCloudEnvironment_SetServiceVersionInput!) {
  VetraCloudEnvironment {
    setServiceVersion(docId: $docId, input: $input) { ...DocumentFields }
  }
}

mutation ($docId: PHID!, $input: VetraCloudEnvironment_SetPackageVersionInput!) {
  VetraCloudEnvironment {
    setPackageVersion(docId: $docId, input: $input) { ...DocumentFields }
  }
}
```

#### Types

Add to `modules/cloud/types.ts`:

```typescript
// Add to CloudEnvironmentService
version: string | null

// New types
type ServiceUpdate = {
  serviceType: CloudEnvironmentServiceType
  currentVersion: string | null
  latestVersion: string
}

type PackageUpdate = {
  packageName: string
  currentVersion: string | null
  latestVersion: string
}
```

## Files to Create/Modify

### `vetra-cloud-package`

| File | Action | Description |
|------|--------|-------------|
| `v1/schema.graphql` | Modify | Add `version` to service type, add new input types |
| `v1/src/reducers/services.ts` | Modify | Add `SET_SERVICE_VERSION` reducer, set `version: null` on enable |
| `v1/src/reducers/packages.ts` | Modify | Add `SET_PACKAGE_VERSION` reducer |
| `processors/vetra-cloud-environment/gitops.ts` | Modify | Use `service.version` for image tags |

### `vetra.to`

| File | Action | Description |
|------|--------|-------------|
| `modules/cloud/types.ts` | Modify | Add `version` to service type, add update types |
| `modules/cloud/graphql.ts` | Modify | Add `version` to service query fields, add mutation functions |
| `modules/cloud/hooks/use-service-updates.ts` | Create | Hook to check container registry for service updates |
| `modules/cloud/hooks/use-package-updates.ts` | Create | Hook to check package registry for package updates |
| `modules/cloud/hooks/use-environment-detail.ts` | Modify | Add `setServiceVersion` and `setPackageVersion` callbacks |
| `modules/cloud/components/available-updates-card.tsx` | Create | The updates card component |
| `app/cloud/[project]/tabs/overview.tsx` | Modify | Wire in updates card and new props |
| `app/cloud/[project]/page.tsx` | Modify | Pass new callbacks to OverviewTab |

## Edge Cases

- **No version set on service**: Treat `null` version as "unknown" — still show the latest available from registry, display as "not set → v1.2.0"
- **Registry unreachable**: Silently skip — no update shown for that item. No error toast.
- **Package not found in registry**: Same as unreachable — no update shown.
- **Version already matches**: Don't show in the updates card.
- **CORS on registry APIs**: May need a Next.js API route to proxy registry requests if the container/package registry doesn't support CORS. Implement as `/api/registry/services` and `/api/registry/packages` if needed.
