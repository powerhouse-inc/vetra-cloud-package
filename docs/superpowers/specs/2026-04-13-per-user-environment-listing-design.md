# Per-User Environment Listing — Design Spec

## Summary

Scope the cloud environment list so each user only sees environments they created. Admins (configured via `ADMINS` env var on switchboard) can toggle to see all environments. Identity comes from the verified Renown bearer token via reactor-api's existing `AuthService`.

## Approach

- **Auth**: enable `AUTH_ENABLED=true` + `ADMINS=<addresses>` on the staging switchboard. reactor-api already verifies bearer tokens via `@renown/sdk` and exposes `context.user` (`{address, chainId, networkId}`) and `context.isAdmin(address)` to GraphQL resolvers. No new auth code.
- **Creator capture**: extend the existing `vetra-cloud-environment` processor — add `createdBy` column to its `environments` table. Set it on first insert from the operation's `action.context.signer.user.address`. Don't touch it on updates.
- **Subgraph queries**: add to existing `vetra-cloud-observability` subgraph — `myEnvironments` (filters by createdBy, admins get all) and `viewer` (returns `{address, isAdmin}`).
- **vetra.to UI**: replace `findDocuments` with `myEnvironments`. Add a "Mine | All" toggle visible only for admins.

## Changes

### `vetra-cloud-package` (commits to `dev` branch)

**Schema** — `processors/vetra-cloud-environment/schema.ts`:
- Add `createdBy: string | null` to `Environments` interface

**Migration** — `processors/vetra-cloud-environment/migrations.ts`:
- ALTER TABLE add `createdBy` column (varchar 255, nullable)

**Processor** — `processors/vetra-cloud-environment/index.ts`:
- Find first user-signed op per document in each batch (skip system signers like `app.name === 'switchboard'`)
- On upsert: include `createdBy` in INSERT values, but EXCLUDE it from `onConflict.doUpdateSet`
- Lowercase the address for consistency with `ADMINS` config

**Subgraph schema** — `subgraphs/vetra-cloud-observability/schema.ts`:

```graphql
type Query {
  # ...existing queries...
  myEnvironments(scope: ListScope = MINE): [VetraCloudEnvironmentSummary!]!
  viewer: Viewer!
}

enum ListScope { MINE, ALL }

type Viewer {
  address: String
  isAdmin: Boolean!
}

type VetraCloudEnvironmentSummary {
  id: String!
  name: String
  subdomain: String
  status: String
  createdBy: String
}
```

**Subgraph resolvers** — `subgraphs/vetra-cloud-observability/resolvers.ts`:
- Need access to the `vetra-cloud-environments` namespace (processor's table)
- `myEnvironments(scope)`: 
  - If no `context.user`: return `[]`
  - If `scope === ALL` and `context.isAdmin(user.address)`: return all envs
  - Otherwise: filter `WHERE createdBy = LOWER(user.address)`
- `viewer`: return `{ address: user?.address ?? null, isAdmin: user ? isAdmin(user.address) : false }`

**Subgraph wiring** — `subgraphs/vetra-cloud-observability/index.ts`:
- Pass envDb namespace to `createResolvers`

**Tests** — update relevant tests for new column + new resolvers

**Version bump + publish**: bump to `0.0.3-dev.17`, publish to `registry.dev.vetra.io`

### `vetra.to` (commits to `staging` branch)

**Dep bump** — `package.json`:
- `@powerhousedao/vetra-cloud-package` → tarball URL for `0.0.3-dev.17`

**GraphQL queries** — `modules/cloud/graphql.ts`:
- Add `fetchMyEnvironments(scope, token)` and `fetchViewer(token)`

**Hook** — `modules/cloud/hooks/use-environment.ts`:
- Replace existing `useEnvironments()` to use `fetchMyEnvironments` with current scope
- Add `useViewer()` to return admin status

**UI** — `app/cloud/cloud-projects.tsx` and/or `app/cloud/page.tsx`:
- Show "Mine | All" toggle when `viewer.isAdmin`
- Default scope = MINE

### `powerhouse-k8s-cluster` (commits to `main` branch)

**Switchboard env vars** — `tenants/staging/powerhouse-values.yaml`:
- Add `AUTH_ENABLED=true`
- Add `ADMINS=0x1AD3d72e54Fb0eB46e87F82f77B284FC8a66b16C` (Frank's address; can be expanded)

## Backward compatibility

- **Pre-signing-era environments**: have `createdBy = null`. Non-admins won't see them (acceptable — they predate signed actions). Admins see them via the "All" view.
- **Anonymous (unauthenticated) users**: `context.user` is undefined. `myEnvironments` returns `[]`. They can still view individual envs by direct URL.
- **Mutations**: not touched. Auth gating for mutations is already via signed-action requirement.

## Out of scope

- Per-environment ACL (other users granted access to specific envs)
- Backfilling `createdBy` for historical envs by inspecting their first operation
- Admin management UI (admins remain configured via env var)
