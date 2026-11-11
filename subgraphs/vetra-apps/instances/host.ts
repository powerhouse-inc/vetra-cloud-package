import { createHash } from "node:crypto";

const MAX_LABEL = 63;
const HASH = 6;

export class InstanceHostError extends Error {
  override name = "InstanceHostError";
}

const hex = (s: string, n: number) =>
  createHash("sha1").update(s).digest("hex").slice(0, n);

/** 4 hex of the app id: the fallback that tells two apps' equal labels apart. */
export function appTag(appId: string): string {
  return hex(appId, 4);
}

/**
 * The DNS label of an instance: `<slug>-<name><suffix>` (spec section 5,
 * overview gap 4). A name that is not already lowercase alphanumerics and
 * single dashes is sanitized and gets `-<6 hex of sha1(name)>`, so
 * `release/1.x` and `release-1-x` stay apart; a name too long for one label
 * is truncated and hashed the same way.
 */
export function instanceLabel(slug: string, name: string, suffix = ""): string {
  // Room for "<part>" after "<slug>-" and before the suffix.
  const room = MAX_LABEL - slug.length - 1 - suffix.length;
  if (room < HASH + 2)
    throw new InstanceHostError(
      `No host for ${slug}/${name}: the app slug leaves no room in a DNS label`,
    );
  let part = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  let hashed = part !== name || part.length === 0;
  if (part.length + (hashed ? HASH + 1 : 0) > room) {
    hashed = true;
    part = part.slice(0, room - HASH - 1).replace(/-+$/, "");
  }
  // slug + "-" + part + "-" + hash + suffix is at most 63 characters by construction.
  return (
    [slug, part, hashed ? hex(name, HASH) : ""].filter(Boolean).join("-") +
    suffix
  );
}
