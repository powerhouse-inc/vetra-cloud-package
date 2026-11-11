import { appsError } from "../errors.js";

/**
 * Release branches (Renown spec 2026-11-11-workload-release-branches-design,
 * section 4): the branches other than the production branch that may publish
 * releases. An entry is an exact branch name or a pattern in which each `*`
 * matches one or more characters other than `/`. Renown applies the same
 * rules to the copy Vetra writes to the workload identity.
 */
export const MAX_RELEASE_BRANCHES = 20;

// Renown's branch rule (renown-workload isValidBranchName): ASCII letters,
// digits, `.`, `_`, `-`, `/`; no `..` or `//`; no leading `-`/`/`; no
// trailing `/`, `.`, `.lock`; not `refs/…`; at most 255 characters.
const BRANCH_ALLOWED = /^[A-Za-z0-9._/-]+$/;
const BRANCH_FORBIDDEN = /\.\.|\/\//;

function isValidBranchName(branch: string): boolean {
  return !(
    branch.length === 0 ||
    branch.length > 255 ||
    !BRANCH_ALLOWED.test(branch) ||
    BRANCH_FORBIDDEN.test(branch) ||
    branch.startsWith("-") ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.endsWith(".lock") ||
    branch.startsWith("refs/")
  );
}

function matchesSegment(segment: string, pattern: string): boolean {
  let s = 0;
  let p = 0;
  let star = -1; // index of the last `*` seen in `pattern`
  let mark = 0; // `segment` index right after what that `*` has consumed
  while (s < segment.length) {
    if (p < pattern.length && pattern[p] === "*") {
      // `*` takes at least one character.
      star = p++;
      mark = ++s;
    } else if (p < pattern.length && pattern[p] === segment[s]) {
      p++;
      s++;
    } else if (star !== -1) {
      // Let the last `*` take one more character and retry after it.
      p = star + 1;
      s = ++mark;
    } else {
      return false;
    }
  }
  // Anything left in the pattern (even a `*`, which needs a character) fails.
  return p === pattern.length;
}

/**
 * Whether `branch` matches a release branch `pattern` (exact, or `*` within
 * one path segment). Linear per segment (Renown's matcher, verbatim): no
 * regex, so no catastrophic backtracking on patterns with many stars.
 */
export function matchesBranchPattern(branch: string, pattern: string): boolean {
  if (!pattern.includes("*")) return branch === pattern;
  const branchSegments = branch.split("/");
  const patternSegments = pattern.split("/");
  return (
    branchSegments.length === patternSegments.length &&
    patternSegments.every((segment, i) =>
      matchesSegment(branchSegments[i], segment),
    )
  );
}

/** Whether `branch` may publish releases: the production branch, or one matching `releaseBranches`. */
export function isReleaseBranch(
  branch: string,
  productionBranch: string,
  releaseBranches: readonly string[],
): boolean {
  return (
    branch === productionBranch ||
    releaseBranches.some((pattern) => matchesBranchPattern(branch, pattern))
  );
}

/**
 * The setting as stored: entries trimmed, duplicates removed (first kept),
 * at most 20. A `*` stands for a non-empty name part, so the entry with
 * each `*` replaced by a letter must be a valid branch name; `**` is refused.
 * Throws BAD_USER_INPUT naming the offending entry.
 */
export function validateReleaseBranches(entries: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of entries) {
    const entry = raw.trim();
    if (
      entry.length > 255 ||
      entry.includes("**") ||
      !isValidBranchName(entry.replaceAll("*", "x"))
    ) {
      throw appsError(
        "BAD_USER_INPUT",
        `Invalid release branch '${entry}': use a branch name, or * for part of one path segment (e.g. *.x, release/*)`,
      );
    }
    if (entry === "*")
      throw appsError(
        "BAD_USER_INPUT",
        "Invalid release branch '*': it would make every top-level branch a release branch",
      );
    if (!out.includes(entry)) out.push(entry);
  }
  if (out.length > MAX_RELEASE_BRANCHES)
    throw appsError(
      "BAD_USER_INPUT",
      `At most ${MAX_RELEASE_BRANCHES} release branches (got ${out.length}); '${out[MAX_RELEASE_BRANCHES]}' is one too many`,
    );
  return out;
}

/** The apps.release_branches column (JSON text) as a list; [] when missing or malformed. */
export function parseReleaseBranches(
  stored: string | null | undefined,
): string[] {
  if (!stored) return [];
  try {
    const value: unknown = JSON.parse(stored);
    return Array.isArray(value)
      ? value.filter((v): v is string => typeof v === "string")
      : [];
  } catch {
    return [];
  }
}
