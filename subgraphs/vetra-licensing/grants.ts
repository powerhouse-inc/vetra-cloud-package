import type { Kysely } from "kysely";
import type { VetraLicensingDB } from "./db/schema.js";
import { addressOfDid, didForAddress } from "./did.js";

export type GrantStore = ReturnType<typeof createGrantStore>;

/** What one app_license_grants row authorised. */
export interface GrantProvenance {
  appId: string;
  /** Lowercased 0x address of the holder. */
  userAddress: string;
  /** The term kind; null on rows written before kinds existed. */
  kind: string | null;
}

/** One app_license_grants row, the holder as a DID (derived on legacy rows). */
export interface GrantRow {
  licenseId: string;
  appId: string;
  userDid: string;
  /** Null on rows written before kinds existed. */
  kind: string | null;
}

function toGrantRow(r: {
  license_id: string;
  app_id: string;
  user_address: string;
  user_did: string | null;
  kind: string | null;
}): GrantRow {
  return {
    licenseId: r.license_id,
    appId: r.app_id,
    userDid: r.user_did ?? didForAddress(r.user_address),
    kind: r.kind,
  };
}

/**
 * Provenance (`app_license_grants`), licence chains (`license_chain`) and the
 * per-app allow list (`app_allow_list`). Every write is idempotent: a retried
 * issue never fails on the row its first attempt already wrote.
 */
export function createGrantStore(db: Kysely<VetraLicensingDB>) {
  return {
    /**
     * The provenance row the keeper requires. license_type_id is a legacy
     * NOT NULL column: new rows carry "" and the kind in `kind`.
     */
    async recordGrant(r: {
      licenseId: string;
      appId: string;
      kind: string;
      userDid: string;
      issuedBy: string;
      now: string;
    }): Promise<void> {
      await db
        .insertInto("app_license_grants")
        .values({
          license_id: r.licenseId,
          app_id: r.appId,
          license_type_id: "",
          user_address: addressOfDid(r.userDid),
          issued_by: r.issuedBy.toLowerCase(),
          created_at: r.now,
          kind: r.kind,
          user_did: r.userDid,
        })
        .onConflict((oc) => oc.column("license_id").doNothing())
        .execute();
    },

    async linkChain(r: {
      licenseId: string;
      rootLicenseId: string;
      appId: string;
      label: string | null;
      now: string;
    }): Promise<void> {
      await db
        .insertInto("license_chain")
        .values({
          license_id: r.licenseId,
          root_license_id: r.rootLicenseId,
          app_id: r.appId,
          label: r.label,
          created_at: r.now,
        })
        .onConflict((oc) => oc.column("license_id").doNothing())
        .execute();
    },

    /** The chain a licence belongs to; an unchained licence is its own root. */
    async chainRootOf(licenseId: string): Promise<string> {
      const row = await db
        .selectFrom("license_chain")
        .select("root_license_id")
        .where("license_id", "=", licenseId)
        .executeTakeFirst();
      return row?.root_license_id ?? licenseId;
    },

    /**
     * The newest authorised licence linked into a chain: the one an upgrade
     * must start from. A chain row without provenance (an issue that failed
     * half-way) is inert and skipped. With no such row the root is the head
     * (a root from before chains existed has no row of its own).
     */
    async chainHead(rootLicenseId: string): Promise<string> {
      const row = await db
        .selectFrom("license_chain as c")
        .innerJoin("app_license_grants as g", "g.license_id", "c.license_id")
        .select("c.license_id")
        .where("c.root_license_id", "=", rootLicenseId)
        .orderBy("c.created_at", "desc")
        .orderBy("c.license_id", "desc")
        .executeTakeFirst();
      return row?.license_id ?? rootLicenseId;
    },

    async chainRoots(): Promise<Map<string, string>> {
      const rows = await db
        .selectFrom("license_chain")
        .select(["license_id", "root_license_id"])
        .execute();
      return new Map(rows.map((r) => [r.license_id, r.root_license_id]));
    },

    /** The chain roots of these licences; an unchained licence is its own root. */
    async chainRootsFor(ids: string[]): Promise<Map<string, string>> {
      if (ids.length === 0) return new Map();
      const rows = await db
        .selectFrom("license_chain")
        .select(["license_id", "root_license_id"])
        .where("license_id", "in", ids)
        .execute();
      const found = new Map(rows.map((r) => [r.license_id, r.root_license_id]));
      return new Map(ids.map((id) => [id, found.get(id) ?? id]));
    },

    /**
     * Every licence linked into a chain, with or without provenance, plus the
     * root itself (a root from before chains existed has no row of its own).
     */
    async chainMembers(rootLicenseId: string): Promise<string[]> {
      const rows = await db
        .selectFrom("license_chain")
        .select("license_id")
        .where("root_license_id", "=", rootLicenseId)
        .execute();
      return [...new Set([rootLicenseId, ...rows.map((r) => r.license_id)])];
    },

    async chainLabel(rootLicenseId: string): Promise<string | null> {
      const row = await db
        .selectFrom("license_chain")
        .select("label")
        .where("license_id", "=", rootLicenseId)
        .executeTakeFirst();
      return row?.label ?? null;
    },

    /**
     * What each grant authorised: the app, the holder's (lowercased) address
     * and the kind (null on rows from before kinds). The keeper checks a
     * licence document against this, never the other way round: licence
     * documents are not system-write-only, the grant rows are.
     */
    async provenance(): Promise<Map<string, GrantProvenance>> {
      const rows = await db
        .selectFrom("app_license_grants")
        .select(["license_id", "app_id", "user_address", "kind"])
        .execute();
      return new Map(
        rows.map((r) => [
          r.license_id,
          { appId: r.app_id, userAddress: r.user_address.toLowerCase(), kind: r.kind },
        ]),
      );
    },

    /**
     * The grant row of one licence: which app it belongs to, for whom, on
     * which kind. The publisher surface authorises a licence id against THIS
     * app, never against the licence document's own `app` field.
     */
    async grantFor(licenseId: string): Promise<GrantRow | null> {
      const row = await db
        .selectFrom("app_license_grants")
        .select(["license_id", "app_id", "user_address", "user_did", "kind"])
        .where("license_id", "=", licenseId)
        .executeTakeFirst();
      return row ? toGrantRow(row) : null;
    },

    /** Every licence granted for one app, oldest first: the app's licences. */
    async grantsForApp(appId: string): Promise<GrantRow[]> {
      const rows = await db
        .selectFrom("app_license_grants")
        .select(["license_id", "app_id", "user_address", "user_did", "kind"])
        .where("app_id", "=", appId)
        .orderBy("created_at", "asc")
        .orderBy("license_id", "asc")
        .execute();
      return rows.map(toGrantRow);
    },

    /**
     * Every grant row of one holder, across apps, oldest first: what the
     * holder owns. Rows from before DIDs were stored match on the address.
     */
    async grantsForHolder(userDid: string): Promise<GrantRow[]> {
      const rows = await db
        .selectFrom("app_license_grants")
        .select(["license_id", "app_id", "user_address", "user_did", "kind"])
        .where((eb) =>
          eb.or([eb("user_did", "=", userDid), eb("user_address", "=", addressOfDid(userDid))]),
        )
        .orderBy("created_at", "asc")
        .orderBy("license_id", "asc")
        .execute();
      return rows.map(toGrantRow);
    },

    /** Licence ids with provenance: the only licences the keeper provisions. */
    async authorisedIds(): Promise<Set<string>> {
      const rows = await db.selectFrom("app_license_grants").select("license_id").execute();
      return new Set(rows.map((r) => r.license_id));
    },

    /**
     * A holder's licence ids, oldest first, across all apps when `appId` is
     * null. Rows from before DIDs were stored match on the address.
     */
    async licenceIdsFor(appId: string | null, userDid: string): Promise<string[]> {
      let q = db
        .selectFrom("app_license_grants")
        .select("license_id")
        .where((eb) =>
          eb.or([eb("user_did", "=", userDid), eb("user_address", "=", addressOfDid(userDid))]),
        );
      if (appId) q = q.where("app_id", "=", appId);
      return (await q.orderBy("created_at", "asc").orderBy("license_id", "asc").execute()).map(
        (r) => r.license_id,
      );
    },

    async isOnAllowList(appId: string, userDid: string): Promise<boolean> {
      const row = await db
        .selectFrom("app_allow_list")
        .select("user_did")
        .where("app_id", "=", appId)
        .where("user_did", "=", userDid)
        .executeTakeFirst();
      return row !== undefined;
    },

    async addToAllowList(appId: string, userDid: string, now: string): Promise<void> {
      await db
        .insertInto("app_allow_list")
        .values({ app_id: appId, user_did: userDid, added_at: now })
        .onConflict((oc) => oc.columns(["app_id", "user_did"]).doNothing())
        .execute();
    },

    /** True when an entry was removed. */
    async removeFromAllowList(appId: string, userDid: string): Promise<boolean> {
      const res = await db
        .deleteFrom("app_allow_list")
        .where("app_id", "=", appId)
        .where("user_did", "=", userDid)
        .executeTakeFirst();
      return Number(res.numDeletedRows) > 0;
    },

    async allowList(appId: string): Promise<{ user: string; addedAt: string }[]> {
      const rows = await db
        .selectFrom("app_allow_list")
        .select(["user_did", "added_at"])
        .where("app_id", "=", appId)
        .orderBy("added_at", "asc")
        .orderBy("user_did", "asc")
        .execute();
      return rows.map((r) => ({ user: r.user_did, addedAt: r.added_at }));
    },
  };
}
