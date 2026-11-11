import type { Kysely } from "kysely";
import type { VetraAppsDB } from "../db/schema.js";
import type { AppRow } from "../repo.js";
import type { ReleaseRow } from "../releases/repo.js";
import { isReleaseBranch, parseReleaseBranches } from "../releases/branches.js";
import type { InstanceRow } from "./repo.js";

export type InstanceTarget = Pick<
  InstanceRow,
  | "target_version"
  | "target_digest"
  | "target_repository"
  | "target_ph_host"
  | "target_run"
>;

/**
 * The newest build or release (highest verified run id, spec 14.17; on an
 * equal run, the newest record) of each
 * release branch that has one: the production branch and the branches
 * matching releaseBranches (overview gap 3). PR builds are not branch targets.
 */
export async function branchTargets(
  db: Kysely<VetraAppsDB>,
  app: Pick<AppRow, "id" | "production_branch" | "release_branches">,
): Promise<Map<string, ReleaseRow>> {
  const rows = await db
    .selectFrom("releases")
    .selectAll()
    .distinctOn("branch")
    .where("app_id", "=", app.id)
    .where("pr", "is", null)
    .where("branch", "is not", null)
    .orderBy("branch")
    .orderBy("run", "desc")
    // GitHub re-runs keep the run id: the newest record of the run wins.
    .orderBy("created_at", "desc")
    .execute();
  const patterns = parseReleaseBranches(app.release_branches);
  const out = new Map<string, ReleaseRow>();
  for (const r of rows) {
    const branch = r.branch!;
    if (!isReleaseBranch(branch, app.production_branch, patterns)) continue;
    out.set(branch, { ...r, run: Number(r.run) });
  }
  return out;
}

/** What an instance runs for this release: pinned by digest (spec: POST ci/registry-token). */
export function targetOf(r: ReleaseRow): InstanceTarget {
  const suffix = `:${r.version}`;
  if (!r.image_ref.endsWith(suffix))
    throw new Error(
      `release ${r.version}: image ref ${r.image_ref} is not tagged ${r.version}`,
    );
  return {
    target_version: r.version,
    target_digest: r.image_digest,
    target_repository: r.image_ref.slice(0, -suffix.length),
    target_ph_host: r.host,
    target_run: Number(r.run),
  };
}

/**
 * The newest build of every PR that has a build recorded since `sinceIso`
 * (spec 14.13: a preview goes after its TTL without a new build), newest
 * first. Newest = highest verified run id, on an equal run the newest record
 * (spec 14.17); ties between PRs go to the higher PR number.
 */
export async function previewCandidates(
  db: Kysely<VetraAppsDB>,
  appId: string,
  sinceIso: string,
): Promise<ReleaseRow[]> {
  const recent = db
    .selectFrom("releases")
    .select("pr")
    .where("app_id", "=", appId)
    .where("kind", "=", "build")
    .where("pr", "is not", null)
    .where("created_at", ">=", sinceIso);
  const rows = await db
    .selectFrom("releases")
    .selectAll()
    .distinctOn("pr")
    .where("app_id", "=", appId)
    .where("kind", "=", "build")
    .where("pr", "in", recent)
    .orderBy("pr")
    .orderBy("run", "desc")
    .orderBy("created_at", "desc")
    .execute();
  return rows
    .map((r) => ({ ...r, run: Number(r.run) }))
    .sort(
      (a, b) =>
        b.run - a.run ||
        b.created_at.localeCompare(a.created_at) ||
        b.pr! - a.pr!,
    );
}

/**
 * The PRs that get a preview: the newest `limit` candidates (spec 14.13: the
 * oldest-updated goes first beyond the cap), never an excluded one (closed,
 * or from a fork). `candidates` is newest first (previewCandidates).
 */
export function pickPreviews(
  candidates: ReleaseRow[],
  excluded: ReadonlySet<number>,
  limit: number,
): Map<number, ReleaseRow> {
  const out = new Map<number, ReleaseRow>();
  for (const r of candidates) {
    if (out.size >= limit) break;
    if (r.pr == null || excluded.has(r.pr)) continue;
    out.set(r.pr, r);
  }
  return out;
}
