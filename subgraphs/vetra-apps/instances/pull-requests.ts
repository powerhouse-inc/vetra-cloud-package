import { GithubHttpError } from "../github.js";
import { appRepository, type AppRow } from "../repo.js";
import type { AppsDeps } from "../service.js";

export type PullRequestGate = "open" | "closed" | "fork" | "unknown";

/**
 * Whether a PR may have a preview: open, and from the app's own repository
 * (a fork's head lives elsewhere). "unknown" when GitHub is not configured or
 * not reachable: the caller asks again on its next pass. A 404 is "closed"
 * (the PR is gone), so a vanished PR is not asked about every pass.
 */
export async function pullRequestGate(
  deps: AppsDeps,
  app: AppRow,
  pr: number,
): Promise<PullRequestGate> {
  const repo = appRepository(app);
  if (!deps.github || !repo) return "unknown";
  try {
    const p = await deps.github.getPullRequest(
      repo.installationId,
      repo.fullName,
      pr,
    );
    if (p.state !== "open") return "closed";
    return p.headRepositoryId === repo.repositoryId ? "open" : "fork";
  } catch (err) {
    if (err instanceof GithubHttpError && err.status === 404) return "closed";
    deps.logger.warn(
      `[vetra-apps] PR #${pr} of ${repo.fullName}: state unavailable: ${String(err)}`,
    );
    return "unknown";
  }
}
