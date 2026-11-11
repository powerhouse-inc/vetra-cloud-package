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
