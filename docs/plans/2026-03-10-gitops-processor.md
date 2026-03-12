# GitOps Processor Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Pulumi-based processor with a Git-based processor that updates powerhouse-k8s-cluster, turning each vetra-cloud-environment document into a K8s tenant managed by ArgoCD.

**Architecture:** The processor watches document state changes and writes tenant configuration (powerhouse-values.yaml) to a local clone of the powerhouse-k8s-cluster repo, then commits and pushes. ArgoCD auto-deploys. A new `global.disabled` helm flag controls tenant lifecycle.

**Tech Stack:** TypeScript, Node.js child_process execFileSync (git CLI), Helm/YAML templates

---

## File Structure

### vetra-cloud-package (create/modify)

| File | Action | Responsibility |
|------|--------|---------------|
| `processors/vetra-cloud-environment/gitops.ts` | Create | Git operations (pull, commit, push) and values YAML generation |
| `processors/vetra-cloud-environment/index.ts` | Modify | Replace pulumi imports/calls with gitops |
| `processors/vetra-cloud-environment/pulumi.ts` | Delete | No longer needed |
| `package.json` | Modify | Remove @pulumi/* dependencies |

### powerhouse-k8s-cluster (modify)

| File | Action | Responsibility |
|------|--------|---------------|
| `powerhouse-chart/values.yaml` | Modify | Add `global.disabled: false` default |
| `powerhouse-chart/templates/*.yaml` (31 files) | Modify | Add `(not .Values.global.disabled)` to each template's top-level conditional |

---

## Chunk 1: Helm Chart — global.disabled Support

### Task 1: Add global.disabled to powerhouse-chart

**Repo:** `/home/froid/projects/powerhouse/powerhouse-k8s-cluster`

**Files:**
- Modify: `powerhouse-chart/values.yaml:1-5`
- Modify: All 31 template files in `powerhouse-chart/templates/` (excluding `_helpers.tpl`)

- [ ] **Step 1: Add `global.disabled` default to values.yaml**

Add `disabled: false` under the existing `global:` section in `powerhouse-chart/values.yaml`:

```yaml
global:
  disabled: false
  namespace: ""
  # ... rest unchanged
```

- [ ] **Step 2: Update all 31 templates to respect global.disabled**

For each template file in `powerhouse-chart/templates/` (except `_helpers.tpl`), add `(not .Values.global.disabled)` to the existing top-level conditional.

**Pattern A — templates with simple conditional:**
```yaml
# Before:
{{- if .Values.switchboard.enabled }}
# After:
{{- if and .Values.switchboard.enabled (not .Values.global.disabled) }}
```

**Pattern B — templates with compound conditional:**
```yaml
# Before:
{{- if and .Values.database.cnpg.enabled .Values.database.cnpg.backup.enabled }}
# After:
{{- if and .Values.database.cnpg.enabled .Values.database.cnpg.backup.enabled (not .Values.global.disabled) }}
```

**Full list of templates and their conditionals to modify:**

| Template | Current Conditional |
|----------|-------------------|
| `academy-deployment.yaml` | `{{- if .Values.academy.enabled }}` |
| `academy-ingress.yaml` | `{{- if and .Values.academy.enabled .Values.academy.ingress.enabled }}` |
| `academy-service.yaml` | `{{- if .Values.academy.enabled }}` |
| `app-deployment.yaml` | `{{- if .Values.app.enabled }}` |
| `app-ingress.yaml` | `{{- if and .Values.app.enabled .Values.app.ingress.enabled }}` |
| `app-service.yaml` | `{{- if .Values.app.enabled }}` |
| `cnpg-pooler.yaml` | `{{- if and .Values.database.cnpg.enabled .Values.database.cnpg.pooler.enabled }}` |
| `cnpg-scheduled-backup.yaml` | `{{- if and .Values.database.cnpg.enabled .Values.database.cnpg.backup.enabled .Values.database.cnpg.backup.scheduledBackup.enabled }}` |
| `connect-deployment.yaml` | `{{- if .Values.connect.enabled }}` |
| `connect-hpa.yaml` | `{{- if and .Values.connect.enabled .Values.connect.autoscaling.enabled }}` |
| `connect-ingress.yaml` | `{{- if and .Values.connect.enabled .Values.connect.ingress.enabled }}` |
| `connect-service.yaml` | `{{- if .Values.connect.enabled }}` |
| `database-provision-job.yaml` | `{{- if and .Values.database.useExisting (not .Values.database.cnpg.enabled) }}` |
| `database-secret.yaml` | `{{- if and .Values.database.useExisting (not .Values.database.cnpg.enabled) }}` |
| `glitchtip-dsn-secret.yaml` | `{{- if .Values.glitchtip.enabled }}` |
| `image-pull-secret.yaml` | `{{- if and .Values.global.imagePullSecrets.enabled (not .Values.global.imagePullSecrets.useExisting) }}` |
| `poddisruptionbudget.yaml` | `{{- if .Values.podDisruptionBudget.enabled }}` |
| `postgres-cluster.yaml` | `{{- if .Values.database.cnpg.enabled }}` |
| `registry-deployment.yaml` | `{{- if .Values.registry.enabled }}` |
| `registry-ingress.yaml` | `{{- if and .Values.registry.enabled .Values.registry.ingress.enabled }}` |
| `registry-pvc.yaml` | `{{- if and .Values.registry.enabled .Values.registry.persistence.enabled }}` |
| `registry-service.yaml` | `{{- if .Values.registry.enabled }}` |
| `renown-deployment.yaml` | `{{- if .Values.renown.enabled }}` |
| `renown-ingress.yaml` | `{{- if and .Values.renown.enabled .Values.renown.ingress.enabled }}` |
| `renown-service.yaml` | `{{- if .Values.renown.enabled }}` |
| `s3-credentials-secret.yaml` | `{{- if and .Values.database.cnpg.enabled .Values.database.cnpg.backup.enabled (not .Values.database.cnpg.backup.useExistingSecret) }}` |
| `servicemonitor.yaml` | `{{- if .Values.serviceMonitor.enabled }}` |
| `switchboard-deployment.yaml` | `{{- if .Values.switchboard.enabled }}` |
| `switchboard-hpa.yaml` | `{{- if and .Values.switchboard.enabled .Values.switchboard.autoscaling.enabled }}` |
| `switchboard-ingress.yaml` | `{{- if and .Values.switchboard.enabled .Values.switchboard.ingress.enabled }}` |
| `switchboard-service.yaml` | `{{- if .Values.switchboard.enabled }}` |

- [ ] **Step 3: Verify with helm template**

```bash
cd /home/froid/projects/powerhouse/powerhouse-k8s-cluster
# Should render all resources (disabled=false is default)
helm template test powerhouse-chart/ -f tenants/vetra/powerhouse-values.yaml | head -20

# Should render nothing (disabled=true)
helm template test powerhouse-chart/ -f tenants/vetra/powerhouse-values.yaml --set global.disabled=true | wc -l
```

Expected: first command renders resources normally, second command outputs 0 or near-0 lines.

- [ ] **Step 4: Commit**

```bash
cd /home/froid/projects/powerhouse/powerhouse-k8s-cluster
git add powerhouse-chart/values.yaml powerhouse-chart/templates/
git commit -m "feat(chart): add global.disabled flag to disable entire tenant"
```

---

## Chunk 2: GitOps Module

### Task 2: Create the gitops module

**Repo:** `/home/froid/projects/powerhouse/vetra-cloud-package`

**Files:**
- Create: `processors/vetra-cloud-environment/gitops.ts`

- [ ] **Step 1: Create gitops.ts**

```typescript
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { childLogger } from "document-drive";
import type {
  VetraCloudEnvironmentState,
  VetraCloudEnvironmentService,
} from "../../document-models/vetra-cloud-environment/index.js";

const logger = childLogger(["gitops"]);

interface GitOpsConfig {
  repoPath: string;
  remote: string;
  branch: string;
  githubPat?: string;
}

function getConfig(): GitOpsConfig {
  const repoPath = process.env.GITOPS_REPO_PATH;
  if (!repoPath) {
    throw new Error("GITOPS_REPO_PATH environment variable is required");
  }
  return {
    repoPath,
    remote: process.env.GITOPS_REMOTE ?? "origin",
    branch: process.env.GITOPS_BRANCH ?? "main",
    githubPat: process.env.GITOPS_GITHUB_PAT,
  };
}

function git(args: string[], config: GitOpsConfig): string {
  const fullArgs = ["-C", config.repoPath, ...args];
  logger.info(`Running: git ${fullArgs.join(" ")}`);
  return execFileSync("git", fullArgs, {
    encoding: "utf-8",
    timeout: 30_000,
  }).trim();
}

function toKebabCase(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
}

function generateValuesYaml(state: VetraCloudEnvironmentState): string {
  const name = toKebabCase(state.name ?? "unnamed");
  const switchboardEnabled = state.services.includes(
    "SWITCHBOARD" as VetraCloudEnvironmentService,
  );
  const connectEnabled = state.services.includes(
    "CONNECT" as VetraCloudEnvironmentService,
  );
  const disabled = state.status !== "STARTED";

  const phPackages =
    state.packages
      ?.map((p) => `${p.name}@${p.version ?? "latest"}`)
      .join(",") ?? "";

  return `global:
  disabled: ${disabled}
  imagePullSecrets:
    enabled: true
    name: harbor-credentials
    useExisting: true
database:
  cnpg:
    enabled: true
    name: ${name}-pg
    instances: 1
    storageClass: hcloud-volumes
    storageSize: 50Gi
    postgresql:
      maxConnections: "600"
      sharedBuffers: 512MB
      effectiveCacheSize: 2GB
      workMem: 32MB
    pooler:
      enabled: true
      instances: 1
      poolMode: transaction
      defaultPoolSize: 50
      maxClientConnections: 400
    backup:
      enabled: true
      destinationPath: s3://powerhouse-cnpg-backups/${name}/
      endpointURL: https://hel1.your-objectstorage.com
      credentialsSecret: s3-credentials
      retentionPolicy: 180d
      useExistingSecret: true
      scheduledBackup:
        enabled: true
        schedule: 0 2 * * *
        immediate: true
    resources:
      requests:
        memory: 2Gi
        cpu: "2"
      limits:
        memory: 8Gi
        cpu: "8"
    bootstrap:
      database: ${name.replace(/-/g, "_")}_db
      owner: ${name.replace(/-/g, "_")}_user
switchboard:
  enabled: ${switchboardEnabled}
  name: switchboard
  replicaCount: 1
  image:
    repository: cr.vetra.io/vetra/switchboard
    tag: v0.0.4-staging.3
    pullPolicy: IfNotPresent
  service:
    type: ClusterIP
    port: 80
    targetPort: 3000
  ingress:
    enabled: true
    className: traefik
    host: switchboard.${name}.vetra.io
    tls:
      enabled: true
      secretName: switchboard-${name}-vetra-io-tls
    annotations:
      cert-manager.io/cluster-issuer: letsencrypt-prod
  env:
    PORT: "3000"
    NODE_ENV: production
    PH_PACKAGES: "${phPackages}"
  envConfigMap:
    TENANT_ID: ${name}
    TENANT_NAME: "${state.name ?? name}"
  resources:
    requests:
      cpu: 1
      memory: 2Gi
    limits:
      cpu: 2
      memory: 4Gi
  livenessProbe:
    enabled: true
    exec:
      command:
        - /bin/sh
        - -c
        - |
          wget --post-data='{"query":"{__typename}"}' --header='Content-Type: application/json' -qO- http://localhost:3000/graphql
    initialDelaySeconds: 120
    periodSeconds: 10
    timeoutSeconds: 5
    failureThreshold: 6
  readinessProbe:
    enabled: true
    exec:
      command:
        - /bin/sh
        - -c
        - |
          wget --post-data='{"query":"{__typename}"}' --header='Content-Type: application/json' -qO- http://localhost:3000/graphql
    initialDelaySeconds: 60
    periodSeconds: 10
    timeoutSeconds: 5
    failureThreshold: 6
  securityContext:
    runAsNonRoot: false
    runAsUser: 0
    fsGroup: 0
  autoscaling:
    enabled: false
connect:
  enabled: ${connectEnabled}
  name: connect
  replicaCount: 1
  image:
    repository: cr.vetra.io/vetra/connect
    tag: v0.0.4-staging.3
    pullPolicy: IfNotPresent
  service:
    type: ClusterIP
    port: 80
    targetPort: 3001
  ingress:
    enabled: true
    className: traefik
    host: connect.${name}.vetra.io
    tls:
      enabled: true
      secretName: connect-${name}-vetra-io-tls
    annotations:
      cert-manager.io/cluster-issuer: letsencrypt-prod
  env:
    PORT: "3001"
    NODE_ENV: production
    PH_PACKAGES: "${phPackages}"
  envConfigMap:
    TENANT_ID: ${name}
    TENANT_NAME: "${state.name ?? name}"
  resources:
    requests:
      cpu: 1
      memory: 2Gi
    limits:
      cpu: 2
      memory: 4Gi
  livenessProbe:
    enabled: true
    httpGet:
      path: /health
      port: 3001
    initialDelaySeconds: 120
    periodSeconds: 10
    timeoutSeconds: 5
    failureThreshold: 6
  readinessProbe:
    enabled: true
    httpGet:
      path: /health
      port: 3001
    initialDelaySeconds: 60
    periodSeconds: 10
    timeoutSeconds: 5
    failureThreshold: 6
  securityContext:
    runAsNonRoot: false
    runAsUser: 0
    fsGroup: 0
  autoscaling:
    enabled: false
podDisruptionBudget:
  enabled: true
  minAvailable: 1
serviceMonitor:
  enabled: true
  interval: 30s
  path: /metrics
glitchtip:
  enabled: true
  dsn: ""
  environment: ${name}
networkPolicy:
  enabled: false
`;
}

export async function syncEnvironment(
  state: VetraCloudEnvironmentState,
): Promise<void> {
  if (!state.name) {
    logger.warn("Environment has no name, skipping gitops sync");
    return;
  }

  const config = getConfig();
  const name = toKebabCase(state.name);
  const tenantDir = join(config.repoPath, "tenants", name);

  logger.info(`Syncing environment "${name}" to gitops repo`);

  // Pull latest
  git(["pull", config.remote, config.branch, "--rebase"], config);

  // Create tenant directory if needed
  if (!existsSync(tenantDir)) {
    mkdirSync(tenantDir, { recursive: true });
  }

  // Write values file
  const valuesPath = join(tenantDir, "powerhouse-values.yaml");
  const yaml = generateValuesYaml(state);
  writeFileSync(valuesPath, yaml, "utf-8");

  // Stage, commit, push
  git(["add", `tenants/${name}/powerhouse-values.yaml`], config);

  const hasChanges = git(["diff", "--cached", "--name-only"], config);
  if (!hasChanges) {
    logger.info("No changes to commit");
    return;
  }

  const statusLabel = state.status === "STARTED" ? "enable" : "disable";
  git(
    [
      "commit",
      "-m",
      `chore(${name}): ${statusLabel} tenant — synced from vetra-cloud-environment`,
    ],
    config,
  );
  git(["push", config.remote, config.branch], config);

  logger.info(`Successfully synced environment "${name}"`);
}

export { toKebabCase, generateValuesYaml };
```

- [ ] **Step 2: Verify it compiles**

```bash
cd /home/froid/projects/powerhouse/vetra-cloud-package
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add processors/vetra-cloud-environment/gitops.ts
git commit -m "feat: add gitops module for tenant sync via git"
```

---

### Task 3: Update processor to use gitops

**Files:**
- Modify: `processors/vetra-cloud-environment/index.ts:1-79`

- [ ] **Step 1: Replace pulumi import with gitops import**

In `processors/vetra-cloud-environment/index.ts`, change line 5:

```typescript
// Before:
import { start, stop } from "./pulumi.js";
// After:
import { syncEnvironment } from "./gitops.js";
```

- [ ] **Step 2: Replace start/stop calls with syncEnvironment**

In `processors/vetra-cloud-environment/index.ts`, replace lines 70-74:

```typescript
// Before:
      if (status === "STARTED") {
        await start(name!);
      } else if (status === "STOPPED") {
        await stop(name!);
      }

// After:
      await syncEnvironment(uncastState);
```

This syncs on every state change (not just start/stop), so service and package changes also propagate.

- [ ] **Step 3: Verify it compiles**

```bash
cd /home/froid/projects/powerhouse/vetra-cloud-package
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add processors/vetra-cloud-environment/index.ts
git commit -m "feat: switch processor from pulumi to gitops sync"
```

---

### Task 4: Clean up Pulumi

**Files:**
- Delete: `processors/vetra-cloud-environment/pulumi.ts`
- Modify: `package.json:73-74`

- [ ] **Step 1: Delete pulumi.ts**

```bash
rm processors/vetra-cloud-environment/pulumi.ts
```

- [ ] **Step 2: Remove @pulumi dependencies from package.json**

Remove these two lines from `dependencies`:
```json
    "@pulumi/aws": "^7.7.0",
    "@pulumi/pulumi": "^3.193.0",
```

- [ ] **Step 3: Reinstall dependencies**

```bash
pnpm install
```

- [ ] **Step 4: Verify it compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add -A processors/vetra-cloud-environment/pulumi.ts package.json pnpm-lock.yaml
git commit -m "chore: remove pulumi dependencies"
```

---

## Chunk 3: Push Both Repos

### Task 5: Push changes

- [ ] **Step 1: Push powerhouse-k8s-cluster**

```bash
cd /home/froid/projects/powerhouse/powerhouse-k8s-cluster
git push origin main
```

- [ ] **Step 2: Push vetra-cloud-package**

```bash
cd /home/froid/projects/powerhouse/vetra-cloud-package
git push origin dev
```
