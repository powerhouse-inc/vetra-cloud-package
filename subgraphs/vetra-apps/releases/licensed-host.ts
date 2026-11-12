import { HOST_ARTIFACT } from "../../vetra-licensing/template.js";
import type { AppRow } from "../repo.js";
import { recordAppArtifact, type AppsDeps } from "../service.js";
import type { ReleaseRow } from "./repo.js";
import { compareReleases, parseVersion, versionKind } from "./version.js";

/**
 * BRIDGE until releases phase 3 replaces the licensing environment model.
 *
 * Licensed environments (vetra-licensing) run the App's `host` FUSION_IMAGE
 * artifact at the version its LATEST channel points at (STAGING for a gated
 * App's canaries; the publisher promotes to LATEST). The old CI path
 * (vetra-deploy-action, POST ci/artifacts) recorded that artifact on every
 * `v*` tag; an App that only uses vetra-publish (POST ci/releases) would never
 * reach its licensed environments again. So a stable release recorded here is
 * also recorded as the `host` image, exactly as ci/artifacts would with
 * channel LATEST (gated: STAGING).
 *
 * - Only stable releases: a build is never a release, and a prerelease
 *   (alpha|beta|rc) must not reach paying customers' LATEST.
 * - The version is the release's semver (licensing renders it as the image
 *   tag and orders two semver versions exactly; an old commit tag such as
 *   `sha-cac9276bc10b` is ordered by the record, where the release comes
 *   later). The reference carries the digest CI attested.
 * - The channel only moves forward (movesForward): a maintenance release
 *   older than the channel's version, or a retried report of an older
 *   release, records the version but leaves the channel. A commit-tag
 *   pointer (the old path) is superseded only when recorded before it.
 */
export function feedsLicensedHost(
  row: Pick<ReleaseRow, "kind" | "version">,
): boolean {
  return (
    row.kind === "release" && parseVersion(row.version)?.prerelease.length === 0
  );
}

/**
 * Whether the channel moves from `current` to the release `version`: from a
 * release only when this one is not older (semver); from anything else (a
 * commit tag of the old path) only when the record cannot prove it newer:
 * it is unrecorded, or recorded before this release (`recorded`: the
 * artifact's versions, newest last; this release may not be in it yet).
 */
export function movesForward(
  version: string,
  current: string | null,
  recorded: readonly string[],
): boolean {
  if (current === null) return true;
  if (versionKind(current) === "release")
    return compareReleases(version, current) >= 0;
  const from = recorded.indexOf(current);
  const at = recorded.indexOf(version);
  return from === -1 || at === -1 || from < at;
}

/** Records a stable release's image as the App's `host` FUSION image; throws when the document write fails. */
export async function recordLicensedHost(
  deps: AppsDeps,
  app: AppRow,
  row: ReleaseRow,
): Promise<void> {
  if (!feedsLicensedHost(row)) return;
  await recordAppArtifact(
    deps,
    app,
    {
      kind: "FUSION_IMAGE",
      name: HOST_ARTIFACT,
      version: row.version,
      reference: `${row.image_ref}@${row.image_digest}`,
      commitSha: row.commit,
      runId: String(row.run),
      channel: "LATEST",
    },
    (current, recorded) => movesForward(row.version, current, recorded),
  );
}
