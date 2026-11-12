import type { PlanAccess } from "../db/schema.js";
import { appsError } from "../errors.js";
import type { AppRow } from "../repo.js";
import { isReleaseBranch, parseReleaseBranches } from "../releases/branches.js";
import { MAX_INSTANCE_LABEL } from "../instances/host.js";

export const PLAN_SIZES = [
  "VETRA_AGENT_S",
  "VETRA_AGENT_M",
  "VETRA_AGENT_L",
  "VETRA_AGENT_XL",
  "VETRA_AGENT_XXL",
] as const;
export type PlanSize = (typeof PLAN_SIZES)[number];

export function parseAccess(v: string): PlanAccess {
  const a = v.trim().toLowerCase();
  if (a === "shared" || a === "own") return a;
  throw appsError("BAD_USER_INPUT", `Access "${v}" is not shared or own`);
}

export function parseSize(v?: string | null): PlanSize {
  const want = v?.trim().toUpperCase();
  if (!want) return "VETRA_AGENT_S";
  const found = PLAN_SIZES.find((s) => s === want);
  if (!found)
    throw appsError(
      "BAD_USER_INPUT",
      `Size "${v}" is not one of ${PLAN_SIZES.join(", ")}`,
    );
  return found;
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
/**
 * The longest plan slug. It names the shared instance, whose host label
 * (`<app slug>-<plan slug>-<hash>`, see instanceLabel) is shortened to fit
 * anyway, so this cap is not what keeps hosts valid; it only keeps a slug no
 * longer than one instance label. A constant of its own, borrowing that
 * number: change it here without touching host labels.
 */
const SLUG_MAX = MAX_INSTANCE_LABEL;

export function slugFromKind(kind: string): string {
  return kind
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");
}

/**
 * Throws BAD_USER_INPUT when the slug is malformed or names something reserved
 * (overview gap 11, spec section 5). `derivedFrom`: the kind the slug was
 * derived from (no slug given), so the error says to pass one.
 */
export function checkPlanSlug(
  slug: string,
  app: Pick<AppRow, "production_branch" | "release_branches">,
  opts: { derivedFrom?: string } = {},
): void {
  const refuse = (why: string) =>
    appsError(
      "BAD_USER_INPUT",
      opts.derivedFrom === undefined
        ? `The plan slug "${slug}" ${why}`
        : `The plan slug "${slug}" derived from the kind "${opts.derivedFrom}" ${why}; pass a slug`,
    );
  if (!slug || slug.length > SLUG_MAX || !SLUG.test(slug))
    throw refuse(
      `must be 1-${SLUG_MAX} lowercase letters, digits and inner dashes`,
    );
  if (
    slug === "main" ||
    slug === "team" ||
    slug === "own" ||
    slug.startsWith("own-")
  )
    throw refuse("is reserved");
  if (/^pr-\d+$/.test(slug)) throw refuse("is reserved for previews");
  if (
    isReleaseBranch(
      slug,
      app.production_branch,
      parseReleaseBranches(app.release_branches),
    )
  )
    throw refuse("names a release branch of the App");
}
