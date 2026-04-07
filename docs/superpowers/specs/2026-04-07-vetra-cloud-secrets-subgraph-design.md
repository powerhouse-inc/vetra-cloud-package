# Vetra Cloud Secrets Subgraph — Design Spec

## Summary

New subgraph `vetra-cloud-secrets` that provides a GraphQL API for managing tenant-scoped environment variables and secrets. Env vars are stored plaintext in Postgres; secrets are stored in OpenBao KV v2 with metadata in Postgres. Both are synced to the GitOps repo as Kubernetes manifests (ConfigMap for env vars, ExternalSecret for secrets) so ArgoCD deploys them into tenant namespaces.

## Goals

- Tenants can manage their own env vars and secrets via GraphQL mutations
- Secret values never appear in git or in GraphQL query responses
- Leverage existing infrastructure: OpenBao KV v2, External Secrets Operator, ArgoCD
- Postgres provides fast read path for UI queries independent of OpenBao availability

## Non-Goals

- Encryption at rest in Postgres (OpenBao KV is the authoritative store for secret values)
- Per-key access control (all keys are tenant-scoped; tenant-level auth is handled upstream)
- Secret rotation or expiry policies

## Architecture

```
User → GraphQL Mutation
  ├─ Env var: upsert Postgres → write ConfigMap to GitOps repo
  └─ Secret: write OpenBao KV → upsert metadata Postgres → write ExternalSecret to GitOps repo
       ↓
  ArgoCD syncs
       ↓
  ConfigMap + K8s Secret (via ESO) in tenant namespace
       ↓
  Tenant pods consume as environment variables
```

## GraphQL Schema

```graphql
type Query {
  envVars(tenantId: String!): [EnvVar!]!
  secrets(tenantId: String!): [SecretEntry!]!
}

type Mutation {
  setEnvVar(tenantId: String!, key: String!, value: String!): EnvVar!
  deleteEnvVar(tenantId: String!, key: String!): Boolean!
  setSecret(tenantId: String!, key: String!, value: String!): SecretEntry!
  deleteSecret(tenantId: String!, key: String!): Boolean!
}

type EnvVar {
  key: String!
  value: String!
}

type SecretEntry {
  key: String!
}
```

### Semantics

- `setEnvVar` / `setSecret` are upserts — create if new, update if exists
- `deleteEnvVar` / `deleteSecret` return `true` if the key existed, `false` otherwise
- Secret values are **write-only** — `secrets` query returns keys only, never values
- All operations scoped by `tenantId`

## Database Schema

Namespace: `vetra-cloud-secrets` (Kysely, same pattern as observability subgraph)

### `tenant_env_vars`

| Column    | Type         | Notes                    |
|-----------|--------------|--------------------------|
| tenantId  | varchar(255) | Composite PK with `key`  |
| key       | varchar(255) | Composite PK with `tenantId` |
| value     | text         | Plaintext value          |
| updatedAt | varchar(255) | ISO timestamp            |

Primary key: `(tenantId, key)`

### `tenant_secrets`

| Column    | Type         | Notes                    |
|-----------|--------------|--------------------------|
| tenantId  | varchar(255) | Composite PK with `key`  |
| key       | varchar(255) | Composite PK with `tenantId` |
| updatedAt | varchar(255) | ISO timestamp            |

Primary key: `(tenantId, key)`

No `value` column — actual values live in OpenBao KV v2.

## OpenBao KV v2 Integration

### Path Convention

```
kv/data/tenants/{tenantId}/secrets
```

All secret key-value pairs for a tenant are stored as a single KV v2 entry (JSON object). This matches how ESO retrieves them via `remoteRef.property`.

### Operations

- **Write**: `PUT kv/data/tenants/{tenantId}/secrets` with `{ data: { ...existingKeys, newKey: newValue } }`
  - Read-then-merge pattern: read current data, merge new key, write back
- **Delete**: Same read-merge-write, removing the key from the data object
- **Read** (for merge): `GET kv/data/tenants/{tenantId}/secrets`

### Authentication

Reuses the same pattern as the observability subgraph:
- K8s service account token → OpenBao Kubernetes auth → vault client token
- New role `vetra-secrets` (separate from `vetra-observability`) with a policy granting read/write on `kv/data/tenants/*`
- The subgraph pod's service account must be bound to this role in OpenBao's Kubernetes auth config

### OpenBao KV Client (`openbao-kv.ts`)

```typescript
class OpenBaoKVClient {
  constructor(addr: string, tokenReader?: TokenReader)
  authenticate(): Promise<string>
  readSecrets(tenantId: string): Promise<Record<string, string>>
  writeSecrets(tenantId: string, data: Record<string, string>): Promise<void>
  deleteSecret(tenantId: string, key: string): Promise<Record<string, string>>
}
```

Extends the auth pattern from `openbao.ts` but targets the KV v2 engine instead of the Kubernetes secrets engine.

## GitOps Sync

### Files Written

Per tenant in `tenants/{tenantId}/`:

**`tenant-configmap.yaml`** — all env vars:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: {tenantId}-env
data:
  KEY_ONE: "value-one"
  KEY_TWO: "value-two"
```

**`tenant-external-secret.yaml`** — references OpenBao KV for all secrets:

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: {tenantId}-secrets
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: openbao
    kind: ClusterSecretStore
  target:
    name: {tenantId}-secrets
  data:
    - secretKey: MY_SECRET
      remoteRef:
        key: tenants/{tenantId}/secrets
        property: MY_SECRET
    - secretKey: ANOTHER_SECRET
      remoteRef:
        key: tenants/{tenantId}/secrets
        property: ANOTHER_SECRET
```

### Sync Logic

Reuses the ephemeral clone + mutex + push-with-retry pattern from `processors/vetra-cloud-environment/gitops.ts`. Extracted into a shared `gitops-sync.ts` module within the subgraph, importing the git helpers.

On every mutation:
1. Read all keys for tenant from Postgres (env vars or secret metadata)
2. Generate the appropriate YAML manifest
3. Ephemeral clone → write file → commit → push

Commit messages: `chore({tenantId}): update env vars` / `chore({tenantId}): update secrets`

### Helm Values Integration

The tenant's `powerhouse-values.yaml` (generated by the processor) needs to reference the ConfigMap and Secret so pods mount them as env vars. The processor's `generateValuesYaml()` will be updated to include:

```yaml
switchboard:
  envFrom:
    - configMapRef:
        name: {tenantId}-env
        optional: true
    - secretRef:
        name: {tenantId}-secrets
        optional: true
connect:
  envFrom:
    - configMapRef:
        name: {tenantId}-env
        optional: true
    - secretRef:
        name: {tenantId}-secrets
        optional: true
```

The `optional: true` ensures pods start even if no env vars/secrets have been configured yet.

## Subgraph File Structure

```
subgraphs/
  vetra-cloud-secrets/
    index.ts              # VetraCloudSecretsSubgraph class
    schema.ts             # GraphQL type definitions
    resolvers.ts          # Query + Mutation resolvers
    openbao-kv.ts         # OpenBao KV v2 client
    gitops-sync.ts        # ConfigMap + ExternalSecret generation + git push
    db/
      schema.ts           # Kysely table interfaces
      migrations.ts       # Table creation
    __tests__/
      resolvers.test.ts
      openbao-kv.test.ts
      gitops-sync.test.ts
      db-migrations.test.ts
```

## Mutation Flows (Detailed)

### `setEnvVar(tenantId, key, value)`

1. Upsert `(tenantId, key, value, updatedAt)` into `tenant_env_vars`
2. Select all env vars for `tenantId` from Postgres
3. Generate `tenant-configmap.yaml` with all key-value pairs
4. Ephemeral clone → write file → commit → push
5. Return `{ key, value }`

### `deleteEnvVar(tenantId, key)`

1. Delete from `tenant_env_vars` where `(tenantId, key)` — note row count
2. Select remaining env vars for `tenantId`
3. Regenerate `tenant-configmap.yaml` (empty ConfigMap if no keys left)
4. Ephemeral clone → write file → commit → push
5. Return `true` if row was deleted, `false` if key didn't exist

### `setSecret(tenantId, key, value)`

1. Read current secrets from OpenBao KV: `GET kv/data/tenants/{tenantId}/secrets`
2. Merge new key: `{ ...existing, [key]: value }`
3. Write back to OpenBao KV: `PUT kv/data/tenants/{tenantId}/secrets`
4. Upsert `(tenantId, key, updatedAt)` into `tenant_secrets`
5. Select all secret keys for `tenantId` from Postgres
6. Generate `tenant-external-secret.yaml` referencing all keys
7. Ephemeral clone → write file → commit → push
8. Return `{ key }`

### `deleteSecret(tenantId, key)`

1. Read current secrets from OpenBao KV
2. Remove key from data object, write back
3. Delete from `tenant_secrets` where `(tenantId, key)` — note row count
4. Select remaining secret keys for `tenantId`
5. Regenerate `tenant-external-secret.yaml`
6. Ephemeral clone → write file → commit → push
7. Return `true` if key existed, `false` otherwise

## OpenBao Configuration Required

A new policy granting the subgraph's role read/write access to the tenant secrets KV path:

```hcl
path "kv/data/tenants/*" {
  capabilities = ["create", "read", "update", "delete"]
}

path "kv/metadata/tenants/*" {
  capabilities = ["list", "read", "delete"]
}
```

This policy needs to be attached to a Kubernetes auth role (e.g., `vetra-secrets`) that the subgraph's service account can authenticate with.

## Processor Changes

Minimal change to `processors/vetra-cloud-environment/gitops.ts`:

- Update `generateValuesYaml()` to include `envFrom` references to `{tenantId}-env` ConfigMap and `{tenantId}-secrets` Secret for both switchboard and connect services
- Both references use `optional: true` so existing tenants without env vars/secrets are unaffected

## Error Handling

- **OpenBao unavailable**: mutation fails with descriptive error — no partial writes (Postgres upsert is skipped if OpenBao write fails for secrets)
- **GitOps push fails**: mutation returns error after retries — Postgres/OpenBao state is committed but git is stale. Next successful mutation will regenerate the full manifest, self-healing.
- **Key validation**: keys must match `^[A-Z][A-Z0-9_]*$` (standard env var naming). Reject at resolver level.

## Testing Strategy

- **Unit tests**: resolver logic with mocked DB, OpenBao client, and gitops sync
- **OpenBao KV client tests**: mock HTTP responses (same pattern as `openbao.test.ts`)
- **GitOps sync tests**: verify generated YAML content, mock git operations
- **DB migration tests**: verify table creation with pglite (same pattern as observability)
