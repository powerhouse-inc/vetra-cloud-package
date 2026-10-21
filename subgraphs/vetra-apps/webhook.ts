import { createHmac, timingSafeEqual } from "node:crypto";
import {
  normalizeApp,
  getPreview,
  isStudioProduct,
  type AppRow,
} from "./repo.js";
import {
  deletePreview,
  deletePreviewsOfApp,
  type AppsDeps,
} from "./service.js";
import { mirrorAppById } from "./app-document.js";

/** `X-Hub-Signature-256: sha256=<hex HMAC-SHA256(secret, raw body)>`. */
export function verifyGithubSignature(
  secret: string,
  rawBody: Buffer,
  header: string | null | undefined,
): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const given = Buffer.from(header.slice("sha256=".length), "hex");
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export interface WebhookResult {
  status: number;
  body?: Record<string, unknown>;
}

type Payload = Record<string, unknown>;

/** Read `a.b.c` from an untrusted JSON payload. */
function pick(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

const idOf = (v: unknown): string =>
  typeof v === "number" || typeof v === "string" ? String(v) : "";

async function appsByRepository(
  deps: AppsDeps,
  repositoryId: string,
): Promise<AppRow[]> {
  return (
    await deps.db
      .selectFrom("apps")
      .selectAll()
      .where("repository_id", "=", repositoryId)
      .where("status", "!=", "DELETED")
      .execute()
  ).map(normalizeApp);
}

async function disconnect(
  deps: AppsDeps,
  apps: AppRow[],
  reason: string,
): Promise<void> {
  for (const app of apps) {
    // A Studio product's repository is only its mirror: losing it never stops
    // the product (spec §8). The Studio sees it and may connect again.
    if (isStudioProduct(app)) {
      await deps.db
        .updateTable("apps")
        .set({
          repository_disconnected_at: deps.now().toISOString(),
          updated_at: deps.now().toISOString(),
        })
        .where("id", "=", app.id)
        .execute();
      await mirrorAppById(deps, app.id);
      deps.logger.info(
        `[vetra-apps] Studio product ${app.slug} lost its GitHub repository (${reason}); it stays live`,
      );
      continue;
    }
    await deps.db
      .updateTable("apps")
      .set({ status: "DISCONNECTED", updated_at: deps.now().toISOString() })
      .where("id", "=", app.id)
      .execute();
    await mirrorAppById(deps, app.id);
    await deletePreviewsOfApp(deps, { ...app, status: "DISCONNECTED" }, reason);
    deps.logger.info(`[vetra-apps] App ${app.slug} disconnected (${reason})`);
  }
}

/**
 * Handle one GitHub App webhook delivery. Signature first: a missing or wrong
 * signature is answered 401 before anything is parsed or touched.
 */
export async function handleGithubWebhook(
  deps: AppsDeps,
  input: {
    rawBody: Buffer | undefined;
    signature: string | null;
    event: string | null;
  },
): Promise<WebhookResult> {
  const secret = deps.cfg.webhookSecret;
  if (!secret)
    return { status: 503, body: { error: "SERVICE_NOT_CONFIGURED" } };
  if (
    !input.rawBody ||
    !verifyGithubSignature(secret, input.rawBody, input.signature)
  ) {
    return { status: 401, body: { error: "invalid signature" } };
  }
  let payload: Payload;
  try {
    payload = JSON.parse(input.rawBody.toString("utf8")) as Payload;
  } catch {
    return { status: 400, body: { error: "invalid JSON" } };
  }
  const action = typeof payload.action === "string" ? payload.action : null;

  if (input.event === "pull_request" && action === "closed") {
    const repositoryId = idOf(pick(payload, "repository.id"));
    const prNumber = Number(
      pick(payload, "pull_request.number") ?? payload.number,
    );
    if (!repositoryId || !Number.isInteger(prNumber)) return { status: 204 };
    let removed = 0;
    for (const app of await appsByRepository(deps, repositoryId)) {
      const preview = await getPreview(deps.db, app.id, prNumber);
      if (!preview) continue;
      await deletePreview(
        deps,
        app,
        preview,
        `pull request #${prNumber} closed`,
      );
      removed++;
    }
    return { status: 200, body: { removedPreviews: removed } };
  }

  if (input.event === "installation" && action === "deleted") {
    const installationId = idOf(pick(payload, "installation.id"));
    if (!installationId) return { status: 204 };
    const apps = (
      await deps.db
        .selectFrom("apps")
        .selectAll()
        .where("installation_id", "=", installationId)
        .where("status", "!=", "DELETED")
        .execute()
    ).map(normalizeApp);
    await disconnect(deps, apps, "GitHub App uninstalled");
    await deps.db
      .deleteFrom("github_deploy_connections")
      .where("installation_id", "=", installationId)
      .execute();
    return { status: 200, body: { disconnectedApps: apps.length } };
  }

  if (input.event === "installation_repositories" && action === "removed") {
    const installationId = idOf(pick(payload, "installation.id"));
    const removedRepos: unknown[] = Array.isArray(payload.repositories_removed)
      ? (payload.repositories_removed as unknown[])
      : [];
    let count = 0;
    for (const r of removedRepos) {
      const repoId = idOf(pick(r, "id"));
      if (!repoId) continue;
      const apps = (await appsByRepository(deps, repoId)).filter(
        (a) => a.installation_id === installationId,
      );
      await disconnect(deps, apps, "repository removed from the GitHub App");
      count += apps.length;
    }
    return { status: 200, body: { disconnectedApps: count } };
  }

  if (input.event === "push") {
    return { status: 200, body: { flaggedApps: await flagOutsidePush(deps, payload) } };
  }

  return { status: 204 };
}

const NULL_SHA = /^0+$/;

/**
 * A push to a Studio product's production branch made outside the Studio
 * (D15): its head sha goes to `apps.external_changes_sha`, and the Studio
 * offers to bring it in; nothing is launched. Ignored: other branches and
 * tags, a deleted branch, Apps deployed by their own CI, a repository GitHub
 * took away, a delivery without (or from another) installation, and the
 * Studio's own mirror pushes. Matching rule: a push is
 * the Studio's own when its head (`after`) equals a sha the agent recorded
 * with recordStudioMirror — the App's `mirror_sha` or the `mirror_sha` of
 * any of its deployments. Only the head counts: a push that carries the
 * Studio's commits under someone else's head is flagged. Returns how many
 * Apps were flagged.
 */
async function flagOutsidePush(deps: AppsDeps, payload: Payload): Promise<number> {
  const repositoryId = idOf(pick(payload, "repository.id"));
  const installationId = idOf(pick(payload, "installation.id"));
  const ref = typeof payload.ref === "string" ? payload.ref : "";
  const after =
    typeof payload.after === "string" ? payload.after.toLowerCase() : "";
  if (!repositoryId || !after || NULL_SHA.test(after) || payload.deleted === true)
    return 0;
  let flagged = 0;
  for (const app of await appsByRepository(deps, repositoryId)) {
    if (!isStudioProduct(app) || app.repository_disconnected_at) continue;
    if (app.installation_id !== installationId) continue;
    if (ref !== `refs/heads/${app.production_branch}`) continue;
    if (app.mirror_sha === after) continue;
    const own = await deps.db
      .selectFrom("app_deployments")
      .select("id")
      .where("app_id", "=", app.id)
      .where("mirror_sha", "=", after)
      .executeTakeFirst();
    if (own) continue;
    await deps.db
      .updateTable("apps")
      .set({
        external_changes_sha: after,
        updated_at: deps.now().toISOString(),
      })
      .where("id", "=", app.id)
      .execute();
    deps.logger.info(
      `[vetra-apps] ${app.slug}: ${app.production_branch} changed on GitHub (${after.slice(0, 12)}); the Studio can bring it in`,
    );
    flagged++;
  }
  return flagged;
}
