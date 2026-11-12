import { sql, type Kysely } from "kysely";
import type { VetraLicensingDB } from "../../vetra-licensing/db/schema.js";
import { isLiveEntry } from "../../vetra-licensing/lifecycle.js";

export interface ChainHead {
  root: string;
  licenseId: string;
  kind: string | null;
  /** Lowercased 0x address of the holder. */
  address: string;
  endAt: string | null;
}

/**
 * Every licence chain of the App that has a live licence (license_lifecycle,
 * the record the system wrote: ACTIVE and not past its end), keyed by root.
 * A chain with several live licences (a moment during an upgrade) is
 * represented by the newest grant.
 */
export async function liveChains(
  db: Kysely<VetraLicensingDB>,
  appId: string,
  nowIso: string,
): Promise<Map<string, ChainHead>> {
  const rows = await db
    .selectFrom("app_license_grants as g")
    .leftJoin("license_chain as c", "c.license_id", "g.license_id")
    .innerJoin("license_lifecycle as l", "l.license_id", "g.license_id")
    .select([
      "g.license_id as licenseId",
      "g.kind as kind",
      "g.user_address as address",
      "g.created_at as createdAt",
      "c.root_license_id as root",
      "l.status as status",
      "l.end_at as endAt",
    ])
    .where("g.app_id", "=", appId)
    // isLiveEntry decides; this only spares reading every ended licence.
    .where("l.status", "=", "ACTIVE")
    .orderBy("g.created_at", "asc")
    .orderBy("g.license_id", "asc")
    .execute();
  const out = new Map<string, ChainHead>();
  for (const r of rows) {
    if (!isLiveEntry({ status: r.status, endAt: r.endAt }, nowIso)) continue;
    const root = r.root ?? r.licenseId;
    // Ordered oldest first: a newer live grant of the same chain wins.
    out.set(root, {
      root,
      licenseId: r.licenseId,
      kind: r.kind,
      address: r.address.toLowerCase(),
      endAt: r.endAt,
    });
  }
  return out;
}

export interface ChainEntry {
  licenseId: string;
  kind: string | null;
}

/**
 * The licences of each of `roots` (live or not), oldest first (the order
 * liveChains picks heads by), keyed by root. Unknown kinds are null.
 */
export async function chainKinds(
  db: Kysely<VetraLicensingDB>,
  appId: string,
  roots: Iterable<string>,
): Promise<Map<string, ChainEntry[]>> {
  const wanted = [...new Set(roots)];
  const out = new Map<string, ChainEntry[]>();
  if (wanted.length === 0) return out;
  const rows = await db
    .selectFrom("app_license_grants as g")
    .leftJoin("license_chain as c", "c.license_id", "g.license_id")
    .select([
      "g.license_id as licenseId",
      "g.kind as kind",
      "c.root_license_id as root",
    ])
    .where("g.app_id", "=", appId)
    .where(
      sql<string>`coalesce(${sql.ref("c.root_license_id")}, ${sql.ref("g.license_id")})`,
      "in",
      wanted,
    )
    .orderBy("g.created_at", "asc")
    .orderBy("g.license_id", "asc")
    .execute();
  for (const r of rows) {
    const root = r.root ?? r.licenseId;
    const entries = out.get(root) ?? [];
    entries.push({ licenseId: r.licenseId, kind: r.kind });
    out.set(root, entries);
  }
  return out;
}

/**
 * When each of `roots` ended, as the licences recorded it: the latest end_at
 * already past of a licence that was live (ACTIVE, EXPIRED or REPLACED).
 * Chains that ended without a recorded end (revoked, open-ended) are absent.
 */
export async function chainEnds(
  db: Kysely<VetraLicensingDB>,
  appId: string,
  roots: Iterable<string>,
  nowIso: string,
): Promise<Map<string, string>> {
  const wanted = [...new Set(roots)];
  const out = new Map<string, string>();
  if (wanted.length === 0) return out;
  const rows = await db
    .selectFrom("app_license_grants as g")
    .leftJoin("license_chain as c", "c.license_id", "g.license_id")
    .innerJoin("license_lifecycle as l", "l.license_id", "g.license_id")
    .select([
      "g.license_id as licenseId",
      "c.root_license_id as root",
      "l.end_at as endAt",
    ])
    .where("g.app_id", "=", appId)
    .where(
      sql<string>`coalesce(${sql.ref("c.root_license_id")}, ${sql.ref("g.license_id")})`,
      "in",
      wanted,
    )
    .where("l.status", "in", ["ACTIVE", "EXPIRED", "REPLACED"])
    .where("l.end_at", "is not", null)
    .execute();
  const now = Date.parse(nowIso);
  for (const r of rows) {
    const end = Date.parse(r.endAt ?? "");
    if (Number.isNaN(end) || end > now) continue;
    const root = r.root ?? r.licenseId;
    const prev = out.get(root);
    if (!prev || Date.parse(prev) < end)
      out.set(root, new Date(end).toISOString());
  }
  return out;
}

/** The kinds any licence of the App was issued with, whatever became of it; null = unknown kind. */
export async function grantKinds(
  db: Kysely<VetraLicensingDB>,
  appId: string,
): Promise<Array<string | null>> {
  const rows = await db
    .selectFrom("app_license_grants")
    .select("kind")
    .distinct()
    .where("app_id", "=", appId)
    .execute();
  return rows.map((r) => r.kind);
}

/** Chains the old model runs a licensed environment for (overview rule 1). */
export async function licensedRoots(
  db: Kysely<VetraLicensingDB>,
  appId: string,
): Promise<Set<string>> {
  const rows = await db
    .selectFrom("license_environments")
    .select("root_license_id")
    .where("app_id", "=", appId)
    .execute();
  return new Set(rows.map((r) => r.root_license_id));
}

export async function hasLicensedEnvironments(
  db: Kysely<VetraLicensingDB>,
  appId: string,
): Promise<boolean> {
  return !!(await db
    .selectFrom("license_environments")
    .select("environment_id")
    .where("app_id", "=", appId)
    .executeTakeFirst());
}

/** The (App, kind) pairs the address holds a live licence of; kinds unknown (null) are left out. */
export async function liveKindsOfHolder(
  db: Kysely<VetraLicensingDB>,
  address: string,
  nowIso: string,
): Promise<Array<{ appId: string; kind: string }>> {
  const rows = await db
    .selectFrom("app_license_grants as g")
    .innerJoin("license_lifecycle as l", "l.license_id", "g.license_id")
    .select([
      "g.app_id as appId",
      "g.kind as kind",
      "l.status as status",
      "l.end_at as endAt",
    ])
    .where("g.user_address", "=", address.toLowerCase())
    .where("l.status", "=", "ACTIVE")
    .where("g.kind", "is not", null)
    .orderBy("g.created_at", "asc")
    .orderBy("g.license_id", "asc")
    .execute();
  const seen = new Set<string>();
  const out: Array<{ appId: string; kind: string }> = [];
  for (const r of rows) {
    if (!r.kind || !isLiveEntry({ status: r.status, endAt: r.endAt }, nowIso))
      continue;
    const key = `${r.appId}\0${r.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ appId: r.appId, kind: r.kind });
  }
  return out;
}
