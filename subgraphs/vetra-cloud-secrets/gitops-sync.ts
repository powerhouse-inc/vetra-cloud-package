import { execFile, execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function yamlQuote(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
  return `"${escaped}"`;
}

export function generateConfigMapYaml(
  tenantId: string,
  envVars: Array<{ key: string; value: string }>,
): string {
  if (envVars.length === 0) {
    return `apiVersion: v1
kind: ConfigMap
metadata:
  name: ${tenantId}-env
data: {}
`;
  }

  const entries = envVars
    .map((e) => `  ${e.key}: ${yamlQuote(e.value)}`)
    .join("\n");

  return `apiVersion: v1
kind: ConfigMap
metadata:
  name: ${tenantId}-env
data:
${entries}
`;
}

export function generateExternalSecretYaml(
  tenantId: string,
  secretKeys: string[],
): string {
  if (secretKeys.length === 0) {
    return `apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: ${tenantId}-secrets
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: openbao
    kind: ClusterSecretStore
  target:
    name: ${tenantId}-secrets
  data: []
`;
  }

  const entries = secretKeys
    .map(
      (k) => `    - secretKey: ${k}
      remoteRef:
        key: tenants/${tenantId}/secrets
        property: ${k}`,
    )
    .join("\n");

  return `apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: ${tenantId}-secrets
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: openbao
    kind: ClusterSecretStore
  target:
    name: ${tenantId}-secrets
  data:
${entries}
`;
}

class GitMutex {
  private queue: (() => void)[] = [];
  private locked = false;

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
}

const gitMutex = new GitMutex();
const MAX_PUSH_RETRIES = 3;

const GIT_AUTHOR_NAME =
  process.env.GITOPS_AUTHOR_NAME ?? "vetra-cloud-secrets";
const GIT_AUTHOR_EMAIL =
  process.env.GITOPS_AUTHOR_EMAIL ?? "noreply@vetra.io";

interface GitOpsConfig {
  repoUrl: string;
  remote: string;
  branch: string;
}

function getConfig(): GitOpsConfig {
  const repoUrl = getRepoUrl();
  return {
    repoUrl,
    remote: process.env.GITOPS_REMOTE ?? "origin",
    branch: process.env.GITOPS_BRANCH ?? "main",
  };
}

function getRepoUrl(): string {
  let url = process.env.GITOPS_REPO_URL;
  if (!url) {
    const repoPath = process.env.GITOPS_REPO_PATH;
    if (!repoPath) {
      throw new Error(
        "Either GITOPS_REPO_URL or GITOPS_REPO_PATH environment variable is required",
      );
    }
    const remote = process.env.GITOPS_REMOTE ?? "origin";
    url = execFileSync("git", ["-C", repoPath, "remote", "get-url", remote], {
      encoding: "utf-8",
      timeout: 10_000,
    }).trim();
  }
  const pat = process.env.GITOPS_GITHUB_PAT;
  if (pat && url.startsWith("https://")) {
    const parsed = new URL(url);
    parsed.username = pat;
    parsed.password = "x-oauth-basic";
    url = parsed.toString();
  }
  return url;
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout: 60_000,
  });
  return stdout.trim();
}

async function withEphemeralClone(
  fn: (cloneDir: string, config: GitOpsConfig) => Promise<void>,
): Promise<void> {
  const config = getConfig();
  const cloneDir = mkdtempSync(join(tmpdir(), "gitops-secrets-"));
  try {
    await git(
      [
        "clone",
        "--depth",
        "1",
        "--branch",
        config.branch,
        config.repoUrl,
        ".",
      ],
      cloneDir,
    );
    await git(["config", "user.name", GIT_AUTHOR_NAME], cloneDir);
    await git(["config", "user.email", GIT_AUTHOR_EMAIL], cloneDir);
    await fn(cloneDir, config);
  } finally {
    try {
      rmSync(cloneDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

async function pushWithRetry(
  cloneDir: string,
  config: GitOpsConfig,
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_PUSH_RETRIES; attempt++) {
    try {
      await git(["push", config.remote, config.branch], cloneDir);
      return;
    } catch (error) {
      if (attempt === MAX_PUSH_RETRIES) throw error;
      await git(["fetch", config.remote, config.branch], cloneDir);
      try {
        await git(
          ["rebase", `${config.remote}/${config.branch}`],
          cloneDir,
        );
      } catch (rebaseError) {
        await git(["rebase", "--abort"], cloneDir);
        throw rebaseError;
      }
    }
  }
}

export async function syncEnvVarsToGitops(
  tenantId: string,
  envVars: Array<{ key: string; value: string }>,
): Promise<void> {
  await gitMutex.acquire();
  try {
    await withEphemeralClone(async (cloneDir, config) => {
      const tenantDir = join(cloneDir, "tenants", tenantId);
      mkdirSync(tenantDir, { recursive: true });
      const filePath = join(tenantDir, "tenant-configmap.yaml");
      const yaml = generateConfigMapYaml(tenantId, envVars);
      writeFileSync(filePath, yaml, "utf-8");
      await git(
        ["add", `tenants/${tenantId}/tenant-configmap.yaml`],
        cloneDir,
      );
      const hasChanges = await git(
        ["diff", "--cached", "--name-only"],
        cloneDir,
      );
      if (!hasChanges) return;
      await git(
        ["commit", "-m", `chore(${tenantId}): update env vars`],
        cloneDir,
      );
      await pushWithRetry(cloneDir, config);
    });
  } finally {
    gitMutex.release();
  }
}

export async function syncSecretsToGitops(
  tenantId: string,
  secretKeys: string[],
): Promise<void> {
  await gitMutex.acquire();
  try {
    await withEphemeralClone(async (cloneDir, config) => {
      const tenantDir = join(cloneDir, "tenants", tenantId);
      mkdirSync(tenantDir, { recursive: true });
      const filePath = join(tenantDir, "tenant-external-secret.yaml");
      const yaml = generateExternalSecretYaml(tenantId, secretKeys);
      writeFileSync(filePath, yaml, "utf-8");
      await git(
        ["add", `tenants/${tenantId}/tenant-external-secret.yaml`],
        cloneDir,
      );
      const hasChanges = await git(
        ["diff", "--cached", "--name-only"],
        cloneDir,
      );
      if (!hasChanges) return;
      await git(
        ["commit", "-m", `chore(${tenantId}): update secrets`],
        cloneDir,
      );
      await pushWithRetry(cloneDir, config);
    });
  } finally {
    gitMutex.release();
  }
}
