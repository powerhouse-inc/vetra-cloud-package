# GitOps Processor for Vetra Cloud Environments

## Overview

Replace the Pulumi-based processor with a Git-based processor that updates the `powerhouse-k8s-cluster` repo. Each `vetra-cloud-environment` document becomes a tenant in the K8s cluster. ArgoCD handles the actual deployment.

## Configuration

- **Git repo**: persistent local clone of `powerhouse-k8s-cluster`
- **Remote**: `origin` (`git@github.com:powerhouse-inc/powerhouse-k8s-hosting.git`) — authenticated via GitHub PAT
- **Branch**: `main`

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `GITOPS_REPO_PATH` | Path to the local clone of powerhouse-k8s-cluster | — |
| `GITOPS_GITHUB_PAT` | GitHub PAT for pushing | — |
| `GITOPS_REMOTE` | Git remote name | `origin` |
| `GITOPS_BRANCH` | Git branch name | `main` |

## Document State to Tenant Mapping

| Document Field | Tenant Config |
|---|---|
| `name` | Tenant directory: `tenants/{kebab-case-name}/` |
| `services: [CONNECT]` | `connect.enabled: true` |
| `services: [SWITCHBOARD]` | `switchboard.enabled: true` |
| `packages` | `switchboard.env.PH_PACKAGES: "pkg1,pkg2"` (comma-separated) |
| `status: STARTED` | `global.disabled: false` |
| `status: STOPPED` | `global.disabled: true` |

Services not present in the `services` array are set to `enabled: false`.

## Processor Flow

1. On any strand received, `git pull` the local clone
2. Read current document state (`name`, `services`, `packages`, `status`)
3. Generate/update `tenants/{kebab-case-name}/powerhouse-values.yaml` from a template
4. `git add`, `commit`, `push` to the configured remote
5. ArgoCD detects the change and deploys automatically

## Values Template

Based on the existing vetra tenant, each new tenant gets:

- **Database**: CNPG cluster with backups and PgBouncer pooler
- **Images**: `cr.vetra.io/vetra/switchboard` and `cr.vetra.io/vetra/connect` with a configurable default tag
- **Ingress**: `switchboard.{name}.vetra.io` / `connect.{name}.vetra.io`
- **TLS**: via cert-manager with Let's Encrypt
- **Services**: enabled/disabled per document state
- **Packages**: `PH_PACKAGES` env var with comma-separated package list
- **Status**: `global.disabled` flag controlled by environment status

## Helm Chart Change

Add `global.disabled` support to the powerhouse-chart. Wrap all tenant resources in a condition so that when `global.disabled: true`, ArgoCD prunes all resources for that tenant.

```yaml
# In values.yaml
global:
  disabled: false
```

Each template wraps its content:
```yaml
{{- if not .Values.global.disabled }}
# ... existing template content ...
{{- end }}
```

## Files Changed

### vetra-cloud-package

1. **`processors/vetra-cloud-environment/index.ts`** — replace Pulumi calls with Git operations
2. **`processors/vetra-cloud-environment/gitops.ts`** — new file: Git operations (pull, commit, push) and values template generation
3. **`processors/vetra-cloud-environment/pulumi.ts`** — delete

### powerhouse-k8s-cluster

4. **`powerhouse-chart/templates/*`** — add `global.disabled` condition to all resource templates
5. **`powerhouse-chart/values.yaml`** — add `global.disabled: false` default

## Future Considerations

- Custom domain support in the document model (user sets A record to load balancer)
- Per-tenant image tag management
- Conflict resolution if multiple environments are updated simultaneously
