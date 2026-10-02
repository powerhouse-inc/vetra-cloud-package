import type { VetraCloudEnvironmentState } from "../../document-models/vetra-cloud-environment/index.js";
import { envUrls } from "./envs.js";
import {
  getApp,
  getDeployment,
  parsePackages,
  updateDeployment,
  type AppRow,
  type DeploymentRow,
} from "./repo.js";
import {
  deletePreview,
  PREVIEW_COMMENT_MARKER,
  type AppsDeps,
} from "./service.js";
import type { GithubDeploymentState } from "./github.js";

export const WATCH_INTERVAL_MS = 15_000;
export const SWEEP_INTERVAL_MS = 15 * 60_000;
export const DEPLOY_TIMEOUT_MS = 15 * 60_000;

/** Does the env state carry exactly what the deployment asked for? */
export function deploymentApplied(
  state: VetraCloudEnvironmentState,
  d: Pick<DeploymentRow, "packages" | "image_tag">,
): boolean {
  for (const p of parsePackages(d.packages)) {
    if (
      !state.packages.some((s) => s.name === p.name && s.version === p.version)
    )
      return false;
  }
  if (d.image_tag) {
    const i = d.image_tag.lastIndexOf(":");
    const repository = d.image_tag.slice(0, i);
    const tag = d.image_tag.slice(i + 1);
    const fusion = state.services.find((s) => s.type === "FUSION" && s.enabled);
    if (!fusion || fusion.version !== tag || state.fusion?.image !== repository)
      return false;
  }
  return true;
}

/**
 * One watcher pass: DEPLOYING → READY once the env is READY with the
 * deployment's versions, → FAILED on DEPLOYMENt_FAILED, a vanished env or the
 * 15 min timeout. Returns the ids that changed.
 */
export async function runDeploymentWatcherOnce(
  deps: AppsDeps,
  timeoutMs = DEPLOY_TIMEOUT_MS,
): Promise<string[]> {
  const rows = await deps.db
    .selectFrom("app_deployments")
    .selectAll()
    .where("status", "in", ["PENDING", "DEPLOYING"])
    .execute();
  const changed: string[] = [];
  for (const d of rows) {
    try {
      const next = await nextStatus(deps, d, timeoutMs);
      if (!next) continue;
      await updateDeployment(deps.db, d.id, next, deps.now().toISOString());
      changed.push(d.id);
      await deps
        .onDeploymentChanged?.(d.id)
        .catch((err: unknown) =>
          deps.logger.warn(
            `[vetra-apps] feedback for ${d.id} failed: ${String(err)}`,
          ),
        );
    } catch (err) {
      deps.logger.warn(`[vetra-apps] watcher: ${d.id}: ${String(err)}`);
    }
  }
  return changed;
}

async function nextStatus(
  deps: AppsDeps,
  d: DeploymentRow,
  timeoutMs: number,
): Promise<Pick<DeploymentRow, "status" | "error"> | null> {
  const age = deps.now().getTime() - Date.parse(d.created_at);
  const timedOut = age > timeoutMs;
  if (d.status === "PENDING") {
    return timedOut
      ? { status: "FAILED", error: "deployment never started" }
      : null;
  }
  const state = d.environment_id
    ? await deps.envs.getState(d.environment_id)
    : null;
  if (!state)
    return { status: "FAILED", error: "environment no longer exists" };
  if (state.status === "DEPLOYMENt_FAILED") {
    return { status: "FAILED", error: "environment deployment failed" };
  }
  if (state.status === "READY" && deploymentApplied(state, d)) {
    return { status: "READY", error: null };
  }
  if (timedOut)
    return { status: "FAILED", error: "timed out after 15 minutes" };
  return null;
}

/** Delete previews whose last deployment is older than the App's TTL. */
export async function runPreviewSweepOnce(deps: AppsDeps): Promise<number> {
  const apps = await deps.db
    .selectFrom("apps")
    .selectAll()
    .where("status", "!=", "DELETED")
    .execute();
  let removed = 0;
  for (const raw of apps) {
    const app = { ...raw, previews_enabled: Boolean(raw.previews_enabled) };
    const cutoff = new Date(
      deps.now().getTime() - app.preview_ttl_days * 86_400_000,
    ).toISOString();
    const stale = await deps.db
      .selectFrom("app_previews")
      .selectAll()
      .where("app_id", "=", app.id)
      .where("last_deployed_at", "<", cutoff)
      .execute();
    for (const p of stale) {
      try {
        await deletePreview(
          deps,
          app,
          p,
          `no deploy for ${app.preview_ttl_days} days`,
        );
        removed++;
      } catch (err) {
        deps.logger.warn(
          `[vetra-apps] sweeper: ${p.environment_id}: ${String(err)}`,
        );
      }
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// GitHub feedback
// ---------------------------------------------------------------------------

const GITHUB_STATE: Partial<
  Record<DeploymentRow["status"], GithubDeploymentState>
> = {
  DEPLOYING: "in_progress",
  READY: "success",
  FAILED: "failure",
  SUPERSEDED: "inactive",
};

const LABEL: Record<DeploymentRow["status"], string> = {
  PENDING: "Pending",
  DEPLOYING: "Deploying",
  READY: "Ready",
  FAILED: "Failed",
  SUPERSEDED: "Superseded",
};

export function githubEnvironmentName(
  d: Pick<DeploymentRow, "kind" | "pr_number">,
): string {
  return d.kind === "PRODUCTION" ? "production" : `preview-pr-${d.pr_number}`;
}

export function previewCommentBody(
  app: AppRow,
  d: DeploymentRow,
  urls: {
    app: string | null;
    connect: string | null;
    switchboard: string | null;
  },
  vetraAppUrl: string,
): string {
  const rows = [
    ["App", urls.app],
    ["Connect", urls.connect],
    ["Switchboard", urls.switchboard],
  ].filter((r): r is [string, string] => !!r[1]);
  const lines = [
    PREVIEW_COMMENT_MARKER,
    `### Vetra preview: ${LABEL[d.status]}`,
    "",
  ];
  if (rows.length > 0) {
    lines.push(
      "| | |",
      "|---|---|",
      ...rows.map(([k, v]) => `| ${k} | ${v} |`),
      "",
    );
  }
  const pkgs = parsePackages(d.packages);
  if (pkgs.length > 0) {
    lines.push(
      `Packages: ${pkgs.map((p) => `\`${p.name}@${p.version}\``).join(", ")}`,
      "",
    );
  }
  const meta = [`Commit \`${d.sha.slice(0, 7)}\``];
  if (d.run_url) meta.push(`[CI run](${d.run_url})`);
  meta.push(`[${app.name} on Vetra](${vetraAppUrl}/user/apps/${app.id})`);
  lines.push(meta.join(" · "));
  if (d.status === "FAILED" && d.error) lines.push("", `Error: ${d.error}`);
  return lines.join("\n");
}

/**
 * Mirror a deployment's status to GitHub: a Deployment (+ status) per
 * deployment row and, for previews, the sticky PR comment. Best effort — the
 * caller logs failures.
 */
export async function reportDeploymentToGithub(
  deps: AppsDeps,
  deploymentId: string,
) {
  const github = deps.github;
  if (!github) return;
  const d = await getDeployment(deps.db, deploymentId);
  if (!d) return;
  const state = GITHUB_STATE[d.status];
  if (!state) return;
  const app = await getApp(deps.db, d.app_id);
  if (!app || app.status === "DISCONNECTED" || app.status === "DELETED") return;
  if (d.status === "SUPERSEDED" && !d.github_deployment_id) return;

  const envState = d.environment_id
    ? await deps.envs.getState(d.environment_id)
    : null;
  const urls = envUrls(envState);
  const environment = githubEnvironmentName(d);
  let ghId = d.github_deployment_id;
  if (!ghId) {
    ghId = await github.createDeployment(
      app.installation_id,
      app.repository_full_name,
      {
        ref: d.sha,
        environment,
        transient: d.kind === "PREVIEW",
        description: `Vetra ${d.kind.toLowerCase()} deployment`,
      },
    );
    await deps.db
      .updateTable("app_deployments")
      .set({ github_deployment_id: ghId })
      .where("id", "=", d.id)
      .execute();
  }
  await github.createDeploymentStatus(
    app.installation_id,
    app.repository_full_name,
    ghId,
    {
      state,
      environment,
      environmentUrl: urls.app ?? urls.connect ?? urls.switchboard,
      logUrl: d.run_url,
      description: d.error ?? `${LABEL[d.status]}`,
    },
  );
  if (d.kind === "PREVIEW" && d.pr_number && d.status !== "SUPERSEDED") {
    await github.upsertPrComment(
      app.installation_id,
      app.repository_full_name,
      d.pr_number,
      PREVIEW_COMMENT_MARKER,
      previewCommentBody(app, d, urls, deps.cfg.vetraAppUrl),
    );
  }
}
