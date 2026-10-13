import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import type { ObservabilityDB } from "../db/schema.js";
import {
  envChangeProtector,
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

  it("organisation envs: service-owned, every ADMIN grant removed, recorded once", async () => {
    await protectEnvironment(reactor.perm, { id: "o-env", owner: OWNER, ownerOrgId: null }, opts());
    await reactor.real.grantPermission("o-env", BOB, "ADMIN", OWNER); // e.g. a previous owner
    await reactor.real.grantPermission("o-env", CAROL, "READ", OWNER);
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
    expect(await db.selectFrom("org_document_protection").select(["documentId", "previousOwner"]).execute())
      .toStrictEqual([{ documentId: "o-env", previousOwner: OWNER }]);

    reactor.perm.setDocumentOwner.mockClear();
    reactor.perm.getDocumentPermissions.mockClear();
    await protectEnvironment(reactor.perm, { id: "o-env", owner: OWNER, ownerOrgId: "o1" }, opts());
    expect(reactor.perm.setDocumentOwner).not.toHaveBeenCalled();
    expect(reactor.perm.getDocumentPermissions).not.toHaveBeenCalled();
  });

  it("an org env created without an owner is protected for the service too", async () => {
    await protectEnvironment(reactor.perm, { id: "o2", owner: null, ownerOrgId: "o1" }, opts());
    expect(await reactor.real.getDocumentProtection("o2")).toMatchObject({ protected: true, ownerAddress: SERVICE });
    for (const op of SYSTEM_ONLY_OPERATIONS) expect(await reactor.auth.canMutate("o2", op, CAROL)).toBe(false);
  });

  it("back to a person: owner protection again, Vetra's org grants withdrawn, foreign ones kept", async () => {
    await protectEnvironment(reactor.perm, { id: "e", owner: OWNER, ownerOrgId: "o1" }, opts());
    await reactor.real.grantPermission("e", BOB, "WRITE", "vetra-org-sync");
    await reactor.real.grantPermission("e", CAROL, "READ", "vetra-org-sync");
    await db.insertInto("org_document_grants").values([
      { documentId: "e", address: BOB, level: "WRITE", grantedAt: "t" },
      { documentId: "e", address: CAROL, level: "WRITE", grantedAt: "t" }, // since changed by someone else
    ]).execute();
    expect(await protectEnvironment(reactor.perm, { id: "e", owner: BOB, ownerOrgId: null }, opts())).toBe("PERSONAL");
    expect(await reactor.real.getDocumentProtection("e")).toMatchObject({ protected: true, ownerAddress: BOB });
    expect(await reactor.real.getUserPermission("e", BOB)).toBe("ADMIN");
    expect(await reactor.real.getUserPermission("e", CAROL)).toBe("READ");
    expect(await db.selectFrom("org_document_grants").selectAll().execute()).toStrictEqual([]);
    expect(await db.selectFrom("org_document_protection").selectAll().execute()).toStrictEqual([]);
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
      { id: "a", owner: null, ownerOrgId: null },
      { id: "b", owner: OWNER, ownerOrgId: "o1" },
      { id: "bad", owner: null, ownerOrgId: null },
    ]);
    expect(warn).toHaveBeenCalledWith("[env-protection] bad: Error: db down");
  });
});

describe("vetraServiceAddress", () => {
  it("prefers VETRA_SERVICE_ADDRESS, then the platform publisher, then the first admin, else nobody", () => {
    expect(vetraServiceAddress({ VETRA_SERVICE_ADDRESS: " 0xABC ", ADMINS: "0xdef" })).toBe("0xabc");
    expect(vetraServiceAddress({ VETRA_STUDIO_PUBLISHER_ADDRESS: "0xF00", ADMINS: "0xdef" })).toBe("0xf00");
    expect(vetraServiceAddress({ ADMINS: " , 0xDEF,0x1" })).toBe("0xdef");
    expect(vetraServiceAddress({})).toBe(RESTRICTION_GRANTEE);
  });
});
