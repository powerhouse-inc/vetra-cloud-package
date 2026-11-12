import { appsError } from "../errors.js";
import type { ReleaseRow } from "../releases/repo.js";
import {
  compareReleases,
  parseVersion,
  versionKind,
} from "../releases/version.js";

/** Whether new releases roll out to a plan by themselves (spec section 7). */
export type Policy =
  | { kind: "manual" }
  | { kind: "patches" }
  | { kind: "minor" }
  | { kind: "follow"; branch: string };

export function parsePolicy(v: string): Policy {
  const s = v.trim();
  if (s === "manual" || s === "patches" || s === "minor") return { kind: s };
  const m = /^follow:(.+)$/.exec(s);
  if (m && m[1].trim()) return { kind: "follow", branch: m[1].trim() };
  throw appsError(
    "BAD_USER_INPUT",
    `Policy "${v}" is not manual, patches, minor or follow:<branch>`,
  );
}

export const policyText = (p: Policy): string =>
  p.kind === "follow" ? `follow:${p.branch}` : p.kind;

export type PolicyRelease = Pick<
  ReleaseRow,
  "version" | "kind" | "branch" | "run" | "withdrawn_at"
>;

const stable = (v: string) => parseVersion(v)?.prerelease.length === 0;

/**
 * The release a plan's policy rolls out by itself from `current`, or null
 * (decision R13). patches: the highest stable x.y.* above current; minor: the
 * highest stable x.*.* above it (a major never; in 0.x a minor is a major, as
 * semver says, so minor takes 0.y.* only); follow: the newest release
 * (highest run) of the branch when its version is above current. Never a
 * build or a withdrawn release, and nothing when current is not a release.
 */
export function policyCandidate(
  p: Policy,
  current: string,
  releases: PolicyRelease[],
): PolicyRelease | null {
  if (p.kind === "manual") return null;
  if (versionKind(current) !== "release") return null;
  const usable = releases.filter(
    (r) =>
      r.kind === "release" &&
      !r.withdrawn_at &&
      versionKind(r.version) === "release",
  );
  if (p.kind === "follow") {
    const newest = usable
      .filter((r) => r.branch === p.branch)
      .sort((a, b) => Number(b.run) - Number(a.run))[0];
    // Forward only (decision R8): a newer run with a lower version is not taken.
    if (!newest || compareReleases(newest.version, current) <= 0) return null;
    return newest;
  }
  const c = parseVersion(current)!;
  const sameMinor = p.kind === "patches" || c.major === 0;
  const fits = usable.filter((r) => {
    const v = parseVersion(r.version)!;
    if (!stable(r.version) || v.major !== c.major) return false;
    if (sameMinor && v.minor !== c.minor) return false;
    return compareReleases(r.version, current) > 0;
  });
  fits.sort((a, b) => compareReleases(b.version, a.version));
  return fits[0] ?? null;
}
