import type { VetraClaim } from "../auth.js";
import { appsError } from "../errors.js";
import { isReleaseBranch, parseReleaseBranches } from "./branches.js";
import { versionKind } from "./version.js";

const RUN_ID = /^[1-9]\d*$/;

export interface ReportFacts {
  kind: "release" | "build";
  version: string;
  branch: string | null;
  pr: number | null;
  commit: string;
}

/** The token's verified claim, which must be for the app's own repository. */
export function assertClaimForApp(
  app: { repository_id: string | null },
  claim: VetraClaim | null,
): VetraClaim {
  if (!claim) throw appsError("FORBIDDEN", "Token carries no vetra claim");
  if (!app.repository_id || claim.repositoryId !== app.repository_id)
    throw appsError("FORBIDDEN", "Token was minted for another repository");
  return claim;
}

/**
 * Renown vouches that the run's branch may publish releases. A Renown from
 * before release branches sets no flag, but mints push tokens only for the
 * production branch (refClass PRODUCTION): those count, so releases from the
 * production branch keep working until Renown sets the flag.
 */
function renownSaysReleaseBranch(
  claim: VetraClaim,
  branch: string,
  productionBranch: string,
): boolean {
  if (claim.releaseBranch !== undefined) return claim.releaseBranch;
  return claim.refClass === "PRODUCTION" && branch === productionBranch;
}

/**
 * A CI token may report only what its own run built: the app's repository,
 * the run's commit, its branch (push) or PR (pull_request). Builds come from
 * any branch or PR. A release comes only from the production branch or one
 * of the app's release branches (releases/branches.ts), and only with
 * Renown's releaseBranch on the claim: Vetra and Renown both have to agree.
 * Returns the run id that orders the record.
 */
export function assertReportAllowed(
  app: {
    repository_id: string | null;
    production_branch: string;
    /** JSON list (apps.release_branches); missing = none. */
    release_branches?: string | null;
  },
  verified: VetraClaim | null,
  r: ReportFacts,
): { run: number } {
  const claim = assertClaimForApp(app, verified);
  // Digits only: Number() would also take "1e3", "0x10" or " 12 ".
  const run = RUN_ID.test(claim.runId ?? "") ? Number(claim.runId) : NaN;
  if (!Number.isSafeInteger(run))
    throw appsError("FORBIDDEN", "Token carries no valid run id");
  if (claim.sha !== r.commit)
    throw appsError(
      "FORBIDDEN",
      `Token was minted for commit ${claim.sha ?? "?"}, not ${r.commit}`,
    );
  const kind = versionKind(r.version);
  if (!kind)
    throw appsError("BAD_USER_INPUT", `${r.version} is not a valid version`);
  if (kind !== r.kind)
    throw appsError(
      "BAD_USER_INPUT",
      `${r.version} is a ${kind}, reported as a ${r.kind}`,
    );

  const fromBranch =
    r.pr === null &&
    !!r.branch &&
    claim.eventName === "push" &&
    claim.ref === `refs/heads/${r.branch}`;
  const fromPr =
    r.branch === null &&
    r.pr !== null &&
    claim.eventName === "pull_request" &&
    claim.ref === `refs/pull/${r.pr}/merge`;
  if (r.kind === "release" ? !fromBranch : !(fromBranch || fromPr))
    throw appsError(
      "FORBIDDEN",
      `Token for ${claim.ref} (${claim.eventName ?? "?"}) cannot report a ${r.kind} for ${r.branch ?? `PR #${r.pr}`}`,
    );
  if (r.kind === "release") {
    const branch = r.branch!;
    if (
      !isReleaseBranch(
        branch,
        app.production_branch,
        parseReleaseBranches(app.release_branches),
      )
    )
      throw appsError(
        "FORBIDDEN",
        `${branch} is not a release branch of this app: releases come from ${app.production_branch} or a branch listed in the app's release branches; other branches publish builds`,
      );
    if (!renownSaysReleaseBranch(claim, branch, app.production_branch))
      throw appsError(
        "FORBIDDEN",
        `Renown did not mark ${branch} as a release branch for this token (its release branches must list ${branch} too)`,
      );
  }
  return { run };
}
