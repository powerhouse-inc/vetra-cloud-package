import type { VetraClaim } from "../auth.js";
import { appsError } from "../errors.js";
import { versionKind } from "./version.js";

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
 * A CI token may report only what its own run built: the app's repository,
 * the run's commit, its branch (push) or PR (pull_request). Uses the
 * verified claim fields only; Renown's refClass is not consulted, so any
 * pushed branch can publish. Returns the run id that orders the record.
 */
export function assertReportAllowed(
  app: { repository_id: string | null },
  verified: VetraClaim | null,
  r: ReportFacts,
): { run: number } {
  const claim = assertClaimForApp(app, verified);
  const run = Number(claim.runId);
  if (!claim.runId || !Number.isSafeInteger(run))
    throw appsError("FORBIDDEN", "Token carries no run id");
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
  return { run };
}
