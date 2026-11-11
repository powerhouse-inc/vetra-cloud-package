import { createHash } from "node:crypto";

/**
 * The label is the environment subdomain; the processor's getTenantId
 * (processors/vetra-cloud-environment/gitops.ts) makes `<label>-<8 doc chars>`
 * and Helm's release is `powerhouse-<tenantId>` (<= 53). The tightest derived
 * name is the `<release>-switchboard` k8s resource (<= 63), so:
 * 63 - len("powerhouse-") - len("-xxxxxxxx") - len("-switchboard") = 31.
 * (Release <= 53 allows 33; hosts `<label>-switchboard` allow 51.)
 */
const RELEASE_PREFIX = "powerhouse-".length;
const DOC_PART = 1 + 8;
const LONGEST_SERVICE = "-switchboard".length;
export const MAX_INSTANCE_LABEL = Math.min(
  53 - RELEASE_PREFIX - DOC_PART,
  63 - RELEASE_PREFIX - DOC_PART - LONGEST_SERVICE,
);
const MAX_LABEL = MAX_INSTANCE_LABEL;
const HASH = 6;

export class InstanceHostError extends Error {
  override name = "InstanceHostError";
}

/** First 6 hex of sha256(`${appId}\0${branch}`): the identity of an instance. */
export function instanceHash(appId: string, branch: string): string {
  return createHash("sha256")
    .update(`${appId}\0${branch}`)
    .digest("hex")
    .slice(0, HASH);
}

const clean = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const cut = (s: string, n: number) =>
  s.slice(0, Math.max(0, n)).replace(/-+$/, "");

/**
 * The DNS label of an instance: `<slug-part>-<branch-part>-<h><suffix>`, where
 * `h` = instanceHash(appId, branch). The label always ends in a 6-hex segment
 * (before the optional staging suffix), which no old-path host does
 * (`<subdomain>-connect`, `<subdomain>-switchboard`), and `h` covers the app id,
 * so two apps, two branches, or a branch named like another's staging form
 * (`main-stg`) never share a label. Only the slug and branch parts are
 * truncated, never the hash or suffix. The unique index stays the last guard
 * (24-bit hash).
 */
export function instanceLabel(
  appId: string,
  slug: string,
  branch: string,
  suffix = "",
): string {
  // Room for "<slug-part>-<branch-part>" before "-<h><suffix>".
  const budget = MAX_LABEL - HASH - 1 - suffix.length;
  if (budget < 3)
    throw new InstanceHostError(
      `No host for ${slug}/${branch}: the suffix leaves no room in a DNS label`,
    );
  let s = clean(slug);
  let b = clean(branch);
  if (s && b && s.length + 1 + b.length > budget) {
    const sMax = Math.min(
      s.length,
      Math.max(budget - 1 - b.length, Math.floor((budget - 1) / 2)),
    );
    s = cut(s, sMax);
    b = cut(b, budget - 1 - s.length);
  } else if (s.length + b.length > budget) {
    s = cut(s, budget);
    b = cut(b, budget);
  }
  return [s, b, instanceHash(appId, branch)].filter(Boolean).join("-") + suffix;
}
