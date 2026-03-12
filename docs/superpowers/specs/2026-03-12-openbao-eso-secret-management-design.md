# OpenBao + External Secrets Operator Integration

## Problem

When the vetra-cloud-environment processor provisions a new tenant namespace via GitOps, the Helm chart expects pre-existing Kubernetes secrets (`harbor-credentials`, `s3-credentials`, `glitchtip-dsn`) that don't exist in fresh namespaces. This causes `CreateContainerConfigError` on service pods.

Previously these secrets were created manually. This design automates secret provisioning using OpenBao (at `openbao.vetra.io`) and the External Secrets Operator (ESO).

## Decision: Shared Secrets via ClusterSecretStore

All tenants share the same infrastructure credentials (harbor registry, S3 backup, glitchtip). Secrets are stored once in OpenBao at `secret/powerhouse/shared/*` and replicated into each tenant namespace by ESO via `ExternalSecret` resources in the Helm chart.

## Architecture

```
OpenBao (openbao.vetra.io)
  └── secret/powerhouse/shared/
        ├── harbor-credentials   {registry, username, password}
        └── s3-credentials       {ACCESS_KEY_ID, SECRET_ACCESS_KEY}

ESO (external-secrets namespace)
  └── ClusterSecretStore "openbao" → K8s auth → OpenBao

Helm Chart (powerhouse-chart/templates/)
  ├── external-secret-harbor.yaml      → creates K8s secret "harbor-credentials"
  ├── external-secret-s3.yaml          → creates K8s secret "s3-credentials"
  └── (existing templates reference these secrets as before)

ArgoCD sync order:
  wave -2: ExternalSecrets created → ESO provisions K8s secrets
  wave  0: Deployments start → secrets already exist
```

## Components

### 1. ESO Installation (ArgoCD app)

- Install ESO via Helm chart as an ArgoCD Application in `argocd-apps/infrastructure/`
- Namespace: `external-secrets`
- Chart: `external-secrets/external-secrets` from `https://charts.external-secrets.io`

### 2. ClusterSecretStore

- Name: `openbao`
- Provider: `vault` (ESO uses the Vault provider for OpenBao)
- Server: `https://openbao.vetra.io`
- Auth: Kubernetes method
  - Mount path: `kubernetes`
  - Role: `external-secrets`
  - ServiceAccount: `external-secrets` in `external-secrets` namespace

### 3. OpenBao Configuration

One-time setup:

1. Enable KV v2 at `secret/` (if not already active)
2. Write shared secrets:
   - `secret/powerhouse/shared/harbor-credentials` → `{registry, username, password}`
   - `secret/powerhouse/shared/s3-credentials` → `{ACCESS_KEY_ID, SECRET_ACCESS_KEY}`
3. Enable Kubernetes auth method
4. Configure K8s auth with cluster API server URL and CA cert
5. Create policy `powerhouse-shared-read`:
   ```hcl
   path "secret/data/powerhouse/shared/*" {
     capabilities = ["read"]
   }
   ```
6. Create role `external-secrets`:
   - Bound ServiceAccount: `external-secrets`
   - Bound namespace: `external-secrets`
   - Policy: `powerhouse-shared-read`
   - TTL: 1h

### 4. Helm Chart ExternalSecret Templates

**`external-secret-harbor.yaml`**
- Condition: `global.imagePullSecrets.enabled` AND `global.imagePullSecrets.useExisting`
- Sync-wave: `-2`
- Creates `kubernetes.io/dockerconfigjson` secret named `harbor-credentials`
- Source: `secret/data/powerhouse/shared/harbor-credentials`
- Template transforms `{registry, username, password}` into `.dockerconfigjson` format

**`external-secret-s3.yaml`**
- Condition: `database.cnpg.backup.enabled` AND `database.cnpg.backup.useExistingSecret`
- Sync-wave: `-2`
- Creates `Opaque` secret named `s3-credentials`
- Source: `secret/data/powerhouse/shared/s3-credentials`
- Direct key mapping: `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`

### 5. Processor / Values YAML

No changes needed. The generated `powerhouse-values.yaml` already sets:
- `global.imagePullSecrets.useExisting: true`
- `database.cnpg.backup.useExistingSecret: true`
- `glitchtip.enabled: false` (until a DSN is stored in OpenBao)

These flags now correctly indicate "ESO will create the secrets" rather than "someone created them manually."

## Files Changed

| Repository | File | Action |
|-----------|------|--------|
| powerhouse-k8s-hosting | `argocd-apps/infrastructure/external-secrets.yaml` | Create |
| powerhouse-k8s-hosting | `infrastructure/external-secrets/cluster-secret-store.yaml` | Create |
| powerhouse-k8s-hosting | `powerhouse-chart/templates/external-secret-harbor.yaml` | Create |
| powerhouse-k8s-hosting | `powerhouse-chart/templates/external-secret-s3.yaml` | Create |
| powerhouse-k8s-hosting | `scripts/setup-openbao.sh` | Create |
| vetra-cloud-package | `processors/vetra-cloud-environment/gitops.ts` | Already updated (glitchtip disabled) |

## Rollout Order

1. Install ESO via ArgoCD
2. Run OpenBao setup script (enable auth, create policy/role, seed secrets)
3. Apply ClusterSecretStore
4. Add ExternalSecret templates to Helm chart and push
5. ArgoCD auto-syncs all tenants — secrets get provisioned, failing pods recover
