# Postgres-Backed Secrets & Env Vars + In-Cluster Controller

**Date:** 2026-04-20
**Status:** Draft — ready for implementation
**Supersedes portions of:** `docs/secrets-envvars-concept.md` (specifically the "GitOps sync" architecture; the API surface is retained)

## Goal

Replace the GitOps-based delivery of per-tenant environment variables and secrets with a push-based model sourced from the Switchboard Postgres. Secrets are encrypted at rest via the OpenBao transit engine; environment variables remain plaintext in Postgres. A new in-cluster controller materialises both into Kubernetes `Secret` / `ConfigMap` resources in each tenant namespace, and [Stakater Reloader](https://github.com/stakater/Reloader) drives rolling pod restarts when contents change.

## Non-goals

- App-side hot reload of env vars without pod restart. We explicitly choose the "rolling restart on content change" model.
- Migrating platform-level env vars (e.g. `TEMPO_ENDPOINT`, `NODE_ENV`, `LOG_LEVEL`). These stay inline in `tenants/<tenant>/powerhouse-values.yaml` and are rendered into the deployment's `env:` block by the Helm chart. Only user-configurable env vars/secrets move to Postgres.
- Replacing ExternalSecrets Operator for infra-level secrets (gitops credentials, Harbor, registry S3). ESO remains for those; only the *tenant user-config* path changes.

## Architecture

```
  ┌─────────────────┐   write       ┌──────────────────────┐
  │ User (UI/CLI)   │──────────────▶│ Switchboard          │
  └─────────────────┘   GraphQL     │  (vetra-cloud-       │
                                    │   secrets subgraph)  │
                                    └──────────┬───────────┘
                                               │
                         encrypt secrets via   │  UPSERT/DELETE + pg_notify
                         OpenBao transit       │
                                               ▼
                                    ┌──────────────────────┐
                                    │ Postgres             │
                                    │  tenant_env_vars     │
                                    │  tenant_secrets      │
                                    │    (+ ciphertext col)│
                                    └──────────┬───────────┘
                                               │ LISTEN vetra_secrets_changed
                                               ▼
                                    ┌──────────────────────┐   decrypt
                                    │ vetra-secrets-       │──────────▶ OpenBao
                                    │   controller         │◀────────── transit
                                    │  (TS, in-cluster)    │
                                    └──────────┬───────────┘
                                               │ K8s API: upsert
                                               ▼
                         ┌─────────────────────────────────────────┐
                         │ Tenant namespace (e.g. `dev`)           │
                         │  Secret:    {tenant}-secrets            │
                         │  ConfigMap: {tenant}-env                │
                         └─────────────────────┬───────────────────┘
                                               │ envFrom (optional: true)
                                               ▼
                         ┌─────────────────────────────────────────┐
                         │ Switchboard / Connect / Fusion pods     │
                         │  + reloader.stakater.com/auto: "true"   │
                         │  → rolling restart on Secret/CM change  │
                         └─────────────────────────────────────────┘
```

## Components

### 1. Secrets subgraph — modifications (existing)

Path: `subgraphs/vetra-cloud-secrets/`

**What changes:**

- **Schema migration** — add `ciphertext TEXT` column to `tenant_secrets` table. Existing rows keep a `NULL` ciphertext (they're legacy, keys-only). New writes populate ciphertext.
- **OpenBao client** — extend `openbao-kv.ts` into `openbao-client.ts` with transit-engine methods: `encrypt(plaintext)` → `vault:v1:…` ciphertext string, `decrypt(ciphertext)` → plaintext. Keep KV v2 methods for one release cycle so running tenants aren't broken; mark them `@deprecated`.
- **Resolvers** — `setSecret` now calls `transit.encrypt(value)` and writes ciphertext directly to `tenant_secrets.ciphertext`. It no longer calls OpenBao KV v2 or `syncSecretsToGitops`.
- **`setEnvVar` / `deleteEnvVar` / `deleteSecret`** — all drop the `syncEnvVarsToGitops` / `syncSecretsToGitops` calls.
- **New: `pg_notify` after every mutation.** All four mutations, inside the same transaction, execute:
  ```sql
  SELECT pg_notify('vetra_secrets_changed', $1);
  -- $1 = tenantId
  ```
  This fires after commit. The payload is just the tenantId; the controller does the full read.
- **GitOps sync module** (`gitops-sync.ts`) is deleted. `index.ts` stops wiring `gitopsFns`.

**Transit key:** single key `vetra-secrets` at path `transit/keys/vetra-secrets`, created idempotently during controller bootstrap (see §Bootstrap).

**Why transit over envelope encryption in app code:** key rotation without re-encryption, OpenBao-managed key lifecycle, audit trail of every encrypt/decrypt call, alignment with existing OpenBao deployment.

### 2. `vetra-secrets-controller` — new package

Path: `packages/vetra-secrets-controller/` (new package inside `vetra-cloud-package` monorepo).

**Stack:** TypeScript, Node 20, `@kubernetes/client-node`, `pg` (direct driver for LISTEN), `kysely` (for reads, shared types with subgraph).

**Responsibilities (single process):**
1. Connect to Postgres, `LISTEN vetra_secrets_changed`.
2. Authenticate to OpenBao via K8s service account (reuse `OpenBaoClient` pattern).
3. On startup: run **full reconciliation** — list all distinct tenantIds in `tenant_env_vars` ∪ `tenant_secrets`, reconcile each.
4. On NOTIFY: **reconcile that one tenant**.
5. Every **5 minutes**: safety-net full reconciliation (catches missed notifications, pod restarts, out-of-band changes).
6. Expose `/healthz` (liveness — listener connected?) and `/readyz` (ready — startup reconcile complete?) on port `:8080`.

**Reconcile(tenantId) logic:**
```ts
// Pseudocode
const envVars = await db.envVarsFor(tenantId);           // [{key, value}]
const secretRows = await db.secretsFor(tenantId);         // [{key, ciphertext}]
const decrypted = await Promise.all(                      // batch decrypt in parallel
  secretRows.map(r => transit.decrypt(r.ciphertext).then(v => [r.key, v])),
);

// ConfigMap
await k8s.upsertConfigMap({
  namespace: tenantId,
  name: `${tenantId}-env`,
  data: Object.fromEntries(envVars.map(e => [e.key, e.value])),
  labels: { 'app.kubernetes.io/managed-by': 'vetra-secrets-controller' },
});

// Secret
await k8s.upsertSecret({
  namespace: tenantId,
  name: `${tenantId}-secrets`,
  stringData: Object.fromEntries(decrypted),
  labels: { 'app.kubernetes.io/managed-by': 'vetra-secrets-controller' },
});
```

**Idempotency:** `upsertConfigMap` / `upsertSecret` use `read → patch-if-different → create-if-missing`. No-op if data matches. This avoids spurious Reloader restarts.

**Empty state:** if a tenant has zero env vars, the ConfigMap is still created with `data: {}` (so `envFrom` with `optional: true` resolves cleanly). Same for secrets. Deleting the *last* env var does not delete the ConfigMap — it just empties it.

**Missing namespace handling:** if the tenant namespace does not yet exist, the reconciler logs a warning and skips. The next safety-net tick retries. (We don't want the controller creating namespaces — that's ArgoCD's job.)

**Error handling:**
- OpenBao decrypt fails → log the key that failed, write the Secret **without** that key, continue. (Don't fail-closed; a rotated/revoked key should not break unrelated keys.)
- K8s API failure → log, don't update in-memory "last synced" state, rely on next NOTIFY or safety-net tick.
- Postgres listener disconnect → reconnect with exponential backoff (1s → 30s), then full reconcile on reconnect.

**RBAC:** controller SA lives in a new `vetra-platform` namespace. Per-tenant `Role` + `RoleBinding` (created by the *tenant* Helm chart — see §3) grant `get, list, watch, create, update, patch` on `secrets` and `configmaps`, resource names restricted to `{tenant}-secrets` and `{tenant}-env`. No cluster-wide Secret permissions.

**Deployment:** packaged as a Helm chart `vetra-secrets-controller` under `powerhouse-k8s-hosting/vetra-secrets-controller-chart/`, installed via an ArgoCD `Application` in `argocd-apps/infrastructure/`. Single replica (deployment), not HA — the controller is stateless and tolerates brief downtime (safety-net tick covers it).

### 3. `powerhouse-chart` — tenant chart modifications

Path: `../powerhouse-k8s-hosting/powerhouse-chart/`

**Additive changes, no breaking changes to existing tenants:**

1. **New template: `tenant-secrets-controller-rbac.yaml`** — gated on `.Values.tenantSecretsController.enabled`. Creates:
   - `Role` granting the controller access to named resources only.
   - `RoleBinding` binding the controller SA (`system:serviceaccount:vetra-platform:vetra-secrets-controller`) to that role.

2. **Deployment templates** (`switchboard-deployment.yaml`, `connect-deployment.yaml`, any other long-running pods that consume tenant config) — two changes:
   - **`envFrom`** additive entries:
     ```yaml
     envFrom:
       - configMapRef:
           name: {{ .Values.global.tenant }}-env
           optional: true
       - secretRef:
           name: {{ .Values.global.tenant }}-secrets
           optional: true
     ```
     `optional: true` is critical — tenants with no user-config still start.
   - **Reloader annotation** on pod metadata:
     ```yaml
     metadata:
       annotations:
         reloader.stakater.com/auto: "true"
     ```

3. **New `values.yaml` section:**
   ```yaml
   tenantSecretsController:
     enabled: true   # per-tenant opt-in/out; defaults true once rolled out
     controllerServiceAccount:
       namespace: vetra-platform
       name: vetra-secrets-controller
   ```

**Key precedence note:** `env:` entries in the deployment spec take precedence over `envFrom`. So a platform-set `NODE_ENV=production` in `powerhouse-values.yaml` wins over a tenant-set `NODE_ENV` in the ConfigMap. Document this in the chart README.

### 4. Reloader — new infrastructure install

Path: `../powerhouse-k8s-hosting/argocd-apps/infrastructure/reloader.yaml` (new file).

Stakater Reloader installed cluster-wide via its upstream Helm chart, deployed in namespace `reloader`. Watches all namespaces for Deployments annotated `reloader.stakater.com/auto: "true"` and restarts them when any referenced `ConfigMap` or `Secret` changes content. Single replica is fine.

### 5. OpenBao transit engine — bootstrap

The transit engine and key need to exist before the controller and subgraph can function.

**Bootstrap path:** a small idempotent Terraform module (or a one-shot `Job` in `powerhouse-k8s-hosting/argocd-apps/infrastructure/openbao-transit-bootstrap.yaml`) that, on sync:
- Enables the `transit` secrets engine at path `transit/` (if not already enabled).
- Creates key `vetra-secrets` with `type: aes256-gcm96`, `deletion_allowed: false` (if not already exists).
- Writes policy `vetra-secrets-encrypt` granting `update` on `transit/encrypt/vetra-secrets`, bound to the existing `vetra-secrets` K8s auth role (used by Switchboard).
- Writes policy `vetra-secrets-decrypt` granting `update` on `transit/decrypt/vetra-secrets`, bound to a new K8s auth role `vetra-secrets-controller` (new SA in `vetra-platform`).

Prefer the Terraform module if the existing OpenBao config is already Terraform-managed; otherwise ship a one-shot bootstrap Job.

## Data model

### Postgres schema changes

Migration `002_add_secret_ciphertext`:
```sql
ALTER TABLE tenant_secrets
  ADD COLUMN ciphertext TEXT;
-- NULL allowed; legacy rows have NULL and will be re-encrypted on next setSecret.
```

No changes to `tenant_env_vars`.

### K8s resources (per tenant)

```yaml
# {tenant}-env ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: dev-env
  namespace: dev
  labels:
    app.kubernetes.io/managed-by: vetra-secrets-controller
data:
  MY_FEATURE_FLAG: "true"
  CUSTOM_API_URL: "https://example.com"
---
# {tenant}-secrets Secret
apiVersion: v1
kind: Secret
metadata:
  name: dev-secrets
  namespace: dev
  labels:
    app.kubernetes.io/managed-by: vetra-secrets-controller
type: Opaque
stringData:
  EXTERNAL_API_KEY: "sk-…"
  DATABASE_PASSWORD: "…"
```

## Data flow

**Write path:**
1. User mutation `setSecret(tenantId, key, value)`.
2. Switchboard resolver validates key format, calls `transit.encrypt(value)` → `ciphertext`.
3. In a single Postgres transaction:
   - `INSERT … ON CONFLICT DO UPDATE` into `tenant_secrets` with `ciphertext`.
   - `SELECT pg_notify('vetra_secrets_changed', $tenantId)`.
4. Transaction commits; notification fires after commit.
5. Controller receives `NOTIFY`, runs `reconcile(tenantId)` (~50–200 ms inc. decrypt + K8s upsert).
6. Kubernetes Secret data changes; Reloader detects via its cache sync (a few seconds).
7. Reloader triggers rolling restart of annotated Deployments in `dev` namespace.
8. New pod starts, reads `envFrom: secretRef` at startup — picks up fresh value.

**End-to-end latency:** ~5–15 seconds from mutation to fully-rolled pod (dominated by Reloader cache sync + K8s rolling update).

**Read path (UI):**
- `envVars(tenantId)` — returns `[{key, value}]` directly from `tenant_env_vars`.
- `secrets(tenantId)` — returns `[{key}]` only. Values never leave the controller path; the API is write-only for secret values. (Unchanged from concept doc.)

## Error handling

| Failure | Detection | Response |
|---|---|---|
| Transit encrypt fails on mutation | Synchronous error from OpenBao | Mutation returns GraphQL error, no DB write |
| DB write fails | Kysely throws | Mutation returns GraphQL error |
| `pg_notify` fails | Inside same tx — rollback | Mutation fails; client can retry (idempotent) |
| Controller misses NOTIFY (crash, restart, network) | Safety-net 5-min tick | Full reconcile on next tick; bounded lag |
| Transit decrypt fails for one key | Per-key try/catch in controller | Write Secret without that key, log ERROR with tenantId + key |
| K8s Secret/ConfigMap upsert fails | `@kubernetes/client-node` error | Log, retry on next NOTIFY or tick |
| Tenant namespace doesn't exist | K8s 404 on namespace | Log WARN, skip; next tick retries |
| Reloader missing / not annotated | — | Content updates but pods don't restart. Detected by: user reports stale value. Mitigation: include Reloader install in same rollout. |
| OpenBao unreachable from controller | Connection error | Controller marks unready (`/readyz` fails), K8s holds ingress. Reconciles retry with backoff. |

## Security model

| Concern | Control |
|---|---|
| Secret plaintext at rest | Never written to Postgres or Git. Plaintext exists only in: OpenBao transit key, controller process memory during reconcile, K8s Secret (etcd — see below). |
| etcd encryption | Assumed to be encryption-at-rest enabled on the cluster (verify in rollout prereqs). Out-of-scope for this design but called out. |
| Controller RBAC | Can only touch `Secrets` and `ConfigMaps` named `{tenant}-secrets` / `{tenant}-env` in namespaces that opted in via their Helm chart. No cluster-wide Secret read. |
| Switchboard → OpenBao | Existing K8s SA auth, policy extended to include `transit/encrypt/vetra-secrets`. |
| Controller → OpenBao | New K8s SA auth, policy `transit/decrypt/vetra-secrets` only (no encrypt). |
| Key rotation | `vault write -f transit/keys/vetra-secrets/rotate` — new writes use new key version; old ciphertexts remain decryptable. |
| Audit | OpenBao audit log captures every encrypt/decrypt call with caller identity. |

## Testing strategy

### Unit tests
- `transit.encrypt` / `transit.decrypt` — mock fetch, assert request shape and roundtrip.
- Reconcile diff logic — given (DB state, current K8s state) → expected K8s ops.
- NOTIFY handler — given raw payload → dispatched tenant reconcile.
- Error-per-key handling — one bad ciphertext doesn't break the Secret.

### Integration tests
- Spin up Postgres (testcontainers), OpenBao (docker), and a fake K8s API (use `kubernetes-mock-server` or a real kind cluster).
- End-to-end: mutation via subgraph → observe ConfigMap/Secret upserted.
- LISTEN reconnection after forced DB restart.
- Safety-net reconcile after simulated missed notification.

### Manual / staging validation
- In `dev` namespace: set an env var via GraphQL, verify pod restarts within ~15s and env var visible via `kubectl exec … -- env | grep MY_FLAG`.
- Set a secret: verify ciphertext in Postgres, decrypted value in Secret, pod restart.
- Key rotation: `rotate` the transit key, trigger a write, verify still works.

## Rollout plan

1. **Prereqs**
   - Verify etcd encryption-at-rest.
   - Decide Terraform vs Job for OpenBao bootstrap. Land the bootstrap.
   - Install Reloader via new ArgoCD app.
2. **Ship subgraph changes + controller to staging (`dev` tenant only)**
   - Schema migration for `ciphertext` column.
   - Subgraph uses transit for new writes.
   - Controller deployed in `vetra-platform` namespace.
   - `dev` tenant's `powerhouse-values.yaml` sets `tenantSecretsController.enabled: true`.
3. **Smoke test** `dev` tenant end-to-end (see Testing §Manual).
4. **Roll out to remaining tenants** — enable the flag in each tenant's values file. Chart changes are additive and backward compatible, so tenants without the flag are unaffected.
5. **Deprecate OpenBao KV v2 path** — once all tenants are migrated, delete `OpenBaoKVClient.readSecrets/writeSecrets` and the `kv/data/tenants/*` ACL. Keep the transit path. (Separate PR, separate week.)
6. **Delete `gitops-sync.ts`** and its tests in the subgraph.

## Open items to confirm during implementation

- Whether OpenBao is managed by Terraform in your setup (affects bootstrap approach). If not, we ship a Job.
- Exact name of the platform namespace (`vetra-platform` is a proposal — may already exist under a different name).
- Whether any existing tenant *already* has user-configured secrets in OpenBao KV v2 that must be migrated. Preliminary grep suggests no, but confirm before deprecating KV v2 path.

## Files touched (summary)

**`vetra-cloud-package/`:**
- `subgraphs/vetra-cloud-secrets/db/migrations.ts` — add ciphertext column migration.
- `subgraphs/vetra-cloud-secrets/db/schema.ts` — add ciphertext field to type.
- `subgraphs/vetra-cloud-secrets/openbao-kv.ts` → rename to `openbao-client.ts`, add transit methods.
- `subgraphs/vetra-cloud-secrets/resolvers.ts` — encrypt on setSecret, drop gitops calls, emit NOTIFY.
- `subgraphs/vetra-cloud-secrets/index.ts` — unwire gitops, remove `OPENBAO_ADDR` fallback (fail on missing).
- `subgraphs/vetra-cloud-secrets/gitops-sync.ts` — delete.
- `subgraphs/vetra-cloud-secrets/__tests__/*` — update.
- `packages/vetra-secrets-controller/` (new) — full controller package.
- `pnpm-workspace.yaml` / root `package.json` — register new workspace package if needed.

**`powerhouse-k8s-hosting/`:**
- `powerhouse-chart/values.yaml` — new `tenantSecretsController` section.
- `powerhouse-chart/templates/tenant-secrets-controller-rbac.yaml` — new.
- `powerhouse-chart/templates/switchboard-deployment.yaml` — envFrom + Reloader annotation.
- `powerhouse-chart/templates/connect-deployment.yaml` — envFrom + Reloader annotation.
- `vetra-secrets-controller-chart/` (new) — Helm chart for the controller.
- `argocd-apps/infrastructure/reloader.yaml` — new.
- `argocd-apps/infrastructure/vetra-secrets-controller.yaml` — new.
- `argocd-apps/infrastructure/openbao-transit-bootstrap.yaml` — new (or Terraform equivalent).
- `tenants/dev/powerhouse-values.yaml` — enable `tenantSecretsController.enabled: true` (pilot).
