import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import type { ObservabilityDB } from "../db/schema.js";
import {
  envChangeProtector,
  expectOrgHandover,
  recordComputedOperators,
  ORG_SYSTEM_OPERATIONS,
  protectEnvironment,
  RESTRICTION_GRANTEE,
  SYSTEM_ONLY_OPERATIONS,
  vetraServiceAddress,
} from "../env-protection.js";
import { createReactorPermissions } from "./reactor-permissions.js";

const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CAROL = "0xcccccccccccccccccccccccccccccccccccccccc";
const SERVICE = "0x5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e";

let db: Kysely<ObservabilityDB>;
let reactor: Awaited<ReturnType<typeof createReactorPermissions>>;
const opts = () => ({ serviceOwner: SERVICE, db });

beforeEach(async () => {
  db = new Kysely<ObservabilityDB>({ dialect: new PGliteDialect(new PGlite()) });
  await up(db);
  reactor = await createReactorPermissions([SERVICE]);
});
afterEach(async () => {
  await reactor.db.destroy();
  await db.destroy();
});

describe("protectEnvironment", () => {
  it("unowned envs: only the organisation operations are restricted; claiming stays open", async () => {
    expect(await protectEnvironment(reactor.perm, { id: "u1", owner: null, ownerOrgId: null }, opts())).toBe("UNOWNED");
    for (const op of ORG_SYSTEM_OPERATIONS) expect(await reactor.auth.canMutate("u1", op, CAROL)).toBe(false);
    expect(await reactor.auth.canMutate("u1", "SET_OWNER", CAROL)).toBe(true);
    expect(await reactor.auth.canMutate("u1", "SET_LABEL", CAROL)).toBe(true);
    expect(await reactor.real.getDocumentOwner("u1")).toBeNull();
  });

  it("personal envs: protected for the owner and restricted at once (no reconciler window)", async () => {
    expect(await protectEnvironment(reactor.perm, { id: "p1", owner: OWNER, ownerOrgId: null }, opts())).toBe("PERSONAL");
    expect(await reactor.real.getDocumentProtection("p1")).toMatchObject({ protected: true, ownerAddress: OWNER });
    expect(await reactor.real.getUserPermission("p1", OWNER)).toBe("ADMIN");
    // A WRITE grantee cannot submit unsigned system operations; the owner (document admin) can.
    await reactor.real.grantPermission("p1", BOB, "WRITE", OWNER);
    for (const op of SYSTEM_ONLY_OPERATIONS) {
      expect(await reactor.auth.canMutate("p1", op, BOB)).toBe(false);
      expect(await reactor.auth.canMutate("p1", op, OWNER)).toBe(true);
    }
    expect(await reactor.auth.canMutate("p1", "SET_LABEL", BOB)).toBe(true);
  });

  it("organisation envs (announced): service-owned, every ADMIN grant removed, recorded once", async () => {
    await protectEnvironment(reactor.perm, { id: "o-env", owner: OWNER, ownerOrgId: null }, opts());
    await reactor.real.grantPermission("o-env", BOB, "ADMIN", OWNER); // e.g. a previous owner
    await reactor.real.grantPermission("o-env", CAROL, "READ", OWNER);
    await expectOrgHandover(db, "o-env", "o1");
    expect(await protectEnvironment(reactor.perm, { id: "o-env", owner: OWNER, ownerOrgId: "o1" }, opts())).toBe("ORG");
    expect(await reactor.real.getDocumentProtection("o-env")).toMatchObject({ protected: true, ownerAddress: SERVICE });
    expect(await reactor.real.getUserPermission("o-env", OWNER)).toBeNull();
    expect(await reactor.real.getUserPermission("o-env", BOB)).toBeNull();
    expect(await reactor.real.getUserPermission("o-env", CAROL)).toBe("READ");
    for (const who of [OWNER, BOB]) {
      expect(await reactor.auth.canRead("o-env", who)).toBe(false);
      expect(await reactor.auth.canMutate("o-env", "SET_OWNER_ORG", who)).toBe(false);
    }
    expect(await reactor.auth.canMutate("o-env", "SYNC_ORG_OPERATORS", SERVICE)).toBe(true);
    expect(await db.selectFrom("org_document_protection").select(["documentId", "orgId", "previousOwner"]).execute())
      .toStrictEqual([{ documentId: "o-env", orgId: "o1", previousOwner: OWNER }]);
    expect(await db.selectFrom("org_expected_handovers").selectAll().execute()).toStrictEqual([]);

    reactor.perm.setDocumentOwner.mockClear();
    reactor.perm.getDocumentPermissions.mockClear();
    await protectEnvironment(reactor.perm, { id: "o-env", owner: OWNER, ownerOrgId: "o1" }, opts());
    expect(reactor.perm.setDocumentOwner).not.toHaveBeenCalled();
    expect(reactor.perm.getDocumentPermissions).not.toHaveBeenCalled();
  });

  it("an announced org env created without an owner is protected for the service too", async () => {
    await expectOrgHandover(db, "o2", "o1");
    await protectEnvironment(reactor.perm, { id: "o2", owner: null, ownerOrgId: "o1" }, opts());
    expect(await reactor.real.getDocumentProtection("o2")).toMatchObject({ protected: true, ownerAddress: SERVICE });
    for (const op of SYSTEM_ONLY_OPERATIONS) expect(await reactor.auth.canMutate("o2", op, CAROL)).toBe(false);
  });

  it("back to a person (announced): owner protection again, Vetra's org grants withdrawn, foreign ones kept", async () => {
    await expectOrgHandover(db, "e", "o1");
    await protectEnvironment(reactor.perm, { id: "e", owner: OWNER, ownerOrgId: "o1" }, opts());
    await reactor.real.grantPermission("e", BOB, "WRITE", "vetra-org-sync");
    await reactor.real.grantPermission("e", CAROL, "READ", "vetra-org-sync");
    await db.insertInto("org_document_grants").values([
      { documentId: "e", address: BOB, level: "WRITE", grantedAt: "t" },
      { documentId: "e", address: CAROL, level: "WRITE", grantedAt: "t" }, // since changed by someone else
    ]).execute();
    await expectOrgHandover(db, "e", null);
    const doc = { id: "e", owner: BOB, ownerOrgId: null };
    const withDoc = { ...opts(), readTarget: async () => doc };
    expect(await protectEnvironment(reactor.perm, doc, withDoc)).toBe("PERSONAL");
    expect(await reactor.real.getDocumentProtection("e")).toMatchObject({ protected: true, ownerAddress: BOB });
    expect(await reactor.real.getUserPermission("e", BOB)).toBe("ADMIN");
    expect(await reactor.real.getUserPermission("e", CAROL)).toBe("READ");
    expect(await db.selectFrom("org_document_grants").selectAll().execute()).toStrictEqual([]);
    expect(await db.selectFrom("org_document_protection").selectAll().execute()).toStrictEqual([]);
  });
});

describe("unannounced organisation moves are reverted", () => {
  it("a personal owner's unsigned SET_OWNER_ORG: reverted, protection stays, no grants", async () => {
    await protectEnvironment(reactor.perm, { id: "p", owner: BOB, ownerOrgId: null }, opts());
    // BOB, the protection owner, pushes an unsigned SET_OWNER_ORG {evil, [BOB, CAROL]} through reactor-api.
    expect(await reactor.auth.canMutate("p", "SET_OWNER_ORG", BOB)).toBe(true);
    const doc = { id: "p", owner: BOB, ownerOrgId: "evil", orgOperators: [BOB, CAROL] };
    const dispatch = vi.fn(async () => undefined);
    const warn = vi.fn();
    const out = await protectEnvironment(reactor.perm, doc, { ...opts(), readTarget: async () => doc, dispatch, logger: { warn } });
    expect(out).toBe("REVERTED");
    expect(dispatch.mock.calls).toStrictEqual([["p", "SET_OWNER_ORG", { ownerOrgId: "", operators: [] }]]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await reactor.real.getDocumentProtection("p")).toMatchObject({ protected: true, ownerAddress: BOB });
    expect(await reactor.real.getUserPermission("p", BOB)).toBe("ADMIN");
    expect(await reactor.real.getUserPermission("p", CAROL)).toBeNull();
    expect(await db.selectFrom("org_document_protection").selectAll().execute()).toStrictEqual([]);
  });

  it("org → another org, org → person, and an expired announcement are reverted to the recorded org", async () => {
    await expectOrgHandover(db, "o", "o1");
    await protectEnvironment(reactor.perm, { id: "o", owner: OWNER, ownerOrgId: "o1" }, opts());
    await recordComputedOperators(db, "o", [BOB]);
    const dispatch = vi.fn(async () => undefined);
    const run = (doc: { id: string; owner: string | null; ownerOrgId: string | null }, now?: Date) =>
      protectEnvironment(reactor.perm, doc, { ...opts(), readTarget: async () => doc, dispatch, now: now ? () => now : undefined });
    expect(await run({ id: "o", owner: OWNER, ownerOrgId: "o2" })).toBe("REVERTED");
    expect(await run({ id: "o", owner: OWNER, ownerOrgId: null })).toBe("REVERTED");
    await expectOrgHandover(db, "o", "o3", new Date("2026-01-01T00:00:00Z"));
    expect(await run({ id: "o", owner: OWNER, ownerOrgId: "o3" }, new Date("2026-01-01T00:11:00Z"))).toBe("REVERTED");
    expect(dispatch.mock.calls).toStrictEqual([
      ["o", "SET_OWNER_ORG", { ownerOrgId: "o1", operators: [BOB] }],
      ["o", "SET_OWNER_ORG", { ownerOrgId: "o1", operators: [BOB] }],
      ["o", "SET_OWNER_ORG", { ownerOrgId: "o1", operators: [BOB] }],
    ]);
    expect(await reactor.real.getDocumentOwner("o")).toBe(SERVICE);
    expect(await db.selectFrom("org_document_protection").select("orgId").execute()).toStrictEqual([{ orgId: "o1" }]);
  });
});

describe("stale snapshots never undo a hand-over (N1)", () => {
  it("a stale personal target is decided from the document; an unreadable document is skipped", async () => {
    await protectEnvironment(reactor.perm, { id: "h", owner: BOB, ownerOrgId: null }, opts());
    await expectOrgHandover(db, "h", "o1");
    await protectEnvironment(reactor.perm, { id: "h", owner: BOB, ownerOrgId: "o1" }, opts());
    const stale = { id: "h", owner: BOB, ownerOrgId: null };
    // The document says org: stays service-owned, BOB gets no ADMIN back.
    const live = { id: "h", owner: BOB, ownerOrgId: "o1" };
    expect(await protectEnvironment(reactor.perm, stale, { ...opts(), readTarget: async () => live })).toBe("ORG");
    // Unreadable, or no reader at all: skipped, never acted on the snapshot.
    const failing = { ...opts(), readTarget: async (): Promise<null> => { throw new Error("reactor down"); } };
    expect(await protectEnvironment(reactor.perm, stale, failing)).toBe("SKIPPED");
    expect(await protectEnvironment(reactor.perm, stale, opts())).toBe("SKIPPED");
    expect(await reactor.real.getDocumentOwner("h")).toBe(SERVICE);
    expect(await reactor.real.getUserPermission("h", BOB)).toBeNull();
    expect(await db.selectFrom("org_document_protection").select("orgId").execute()).toStrictEqual([{ orgId: "o1" }]);
  });
});

describe("envChangeProtector", () => {
  it("protects created and updated env documents at once, ignores other events, never throws", async () => {
    const protect = vi.fn(async (env: { id: string }) => {
      if (env.id === "bad") throw new Error("db down");
    });
    const warn = vi.fn();
    const handler = envChangeProtector(protect, { warn });
    const doc = (id: string, global: Record<string, unknown>) => ({ header: { id }, state: { global } });
    handler({ type: "created", documents: [doc("a", { owner: null })] });
    handler({ type: "updated", documents: [doc("b", { owner: OWNER, ownerOrgId: "o1" }), doc("bad", {}), {}] });
    handler({ type: "deleted", documents: [doc("c", {})] });
    await new Promise((r) => setTimeout(r, 0));
    expect(protect.mock.calls.map(([e]) => e)).toStrictEqual([
      { id: "a", owner: null, ownerOrgId: null, orgOperators: [] },
      { id: "b", owner: OWNER, ownerOrgId: "o1", orgOperators: [] },
      { id: "bad", owner: null, ownerOrgId: null, orgOperators: [] },
    ]);
    expect(warn).toHaveBeenCalledWith("[env-protection] bad: Error: db down");
  });
});

describe("vetraServiceAddress", () => {
  it("is VETRA_SERVICE_ADDRESS, else an address nobody can sign as (never an admin's key)", () => {
    expect(vetraServiceAddress({ VETRA_SERVICE_ADDRESS: " 0xABC ", ADMINS: "0xdef" })).toBe("0xabc");
    expect(vetraServiceAddress({ VETRA_STUDIO_PUBLISHER_ADDRESS: "0xF00", ADMINS: "0xdef" })).toBe(RESTRICTION_GRANTEE);
    expect(vetraServiceAddress({})).toBe(RESTRICTION_GRANTEE);
  });
});
