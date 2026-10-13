import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import type { ObservabilityDB } from "../db/schema.js";
import { protectEnvironment } from "../env-protection.js";
import {
  grantViewer,
  restrictSystemOperations,
  RESTRICTION_GRANTEE,
  runOrgSyncOnce,
  SYSTEM_ONLY_OPERATIONS,
  syncEnvironmentOrgOnce,
  type OrgSyncDeps,
  type OrgEnvRow,
} from "../org-sync.js";
import { createReactorPermissions } from "./reactor-permissions.js";
import { RenownOrgsUnavailableError, type OrgMembership } from "../../../shared/renown-orgs.js";

const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CAROL = "0xcccccccccccccccccccccccccccccccccccccccc";

let db: Kysely<ObservabilityDB>;
let envDb: Kysely<any>;
let members: Map<string, OrgMembership>;
let down: boolean;
let deps: OrgSyncDeps;
let reactor: Awaited<ReturnType<typeof createReactorPermissions>>;
let perm: Awaited<ReturnType<typeof createReactorPermissions>>["perm"];
const setPerm = (d: string, a: string, level: "READ" | "WRITE" | "ADMIN") => reactor.real.grantPermission(d, a, level, "someone-else");
const getPerm = (d: string, a: string) => reactor.real.getUserPermission(d, a);
const restrictedBy = async (d: string, op: string) =>
  (await reactor.real.getOperationUserPermissions(d, op)).map((r) => r.userAddress);
let dispatch: ReturnType<typeof vi.fn>;

const publisher: OrgMembership = { role: "PUBLISHER", effectiveScope: { all: true, appDids: [] } };
const plain: OrgMembership = { role: "MEMBER", effectiveScope: { all: false, appDids: [] } };

async function seed(env: Partial<OrgEnvRow> & { id: string }) {
  await envDb.insertInto("environments").values({
    id: env.id,
    owner: env.owner ?? OWNER,
    ownerOrgId: env.ownerOrgId ?? null,
    orgOperators: env.orgOperators ?? "[]",
    appId: env.appId ?? null,
  }).execute();
}
const row = async (id: string) =>
  (await envDb.selectFrom("environments").selectAll().where("id", "=", id).executeTakeFirstOrThrow()) as OrgEnvRow;
const grants = async () => db.selectFrom("org_document_grants").select(["documentId", "address", "level"]).orderBy("address").execute();

beforeEach(async () => {
  db = new Kysely<ObservabilityDB>({ dialect: new PGliteDialect(new PGlite()) });
  await up(db);
  envDb = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
  await envDb.schema.createTable("environments")
    .addColumn("id", "varchar(255)", (c) => c.primaryKey())
    .addColumn("owner", "varchar(255)").addColumn("ownerOrgId", "varchar(255)")
    .addColumn("orgOperators", "text").addColumn("appId", "varchar(255)").execute();
  members = new Map();
  down = false;
  reactor = await createReactorPermissions();
  perm = reactor.perm;
  dispatch = vi.fn(async (id: string, _type: string, input: { operators: string[] }) => {
    await envDb.updateTable("environments").set({ orgOperators: JSON.stringify(input.operators) }).where("id", "=", id).execute();
  });
  deps = {
    envDb,
    db,
    orgs: {
      membership: async (orgId: string, address: string) => {
        if (down) throw new RenownOrgsUnavailableError("down");
        return members.get(`${orgId}|${address}`) ?? null;
      },
    },
    appDidOf: async () => null,
    dispatch,
    perm,
    logger: { info: vi.fn(), warn: vi.fn() },
  };
});
afterEach(async () => {
  await reactor.db.destroy();
  await db.destroy();
  await envDb.destroy();
});

describe("operator sync", () => {
  it("adds a publisher candidate and grants WRITE; the creator is an ordinary member", async () => {
    members.set(`o1|${BOB}`, publisher);
    members.set(`o1|${OWNER}`, publisher);
    await seed({ id: "e1", ownerOrgId: "o1" });
    const out = await syncEnvironmentOrgOnce(deps, await row("e1"), [BOB.toUpperCase().replace("0X", "0x")]);
    expect(out).toStrictEqual({ result: "UPDATED", operators: [OWNER, BOB] });
    expect(dispatch).toHaveBeenCalledWith("e1", "SYNC_ORG_OPERATORS", { operators: [OWNER, BOB] });
    expect(perm.grantPermission.mock.calls).toStrictEqual([
      ["e1", OWNER, "WRITE", "vetra-org-sync"],
      ["e1", BOB, "WRITE", "vetra-org-sync"],
    ]);
    expect(await grants()).toStrictEqual([
      { documentId: "e1", address: OWNER, level: "WRITE" },
      { documentId: "e1", address: BOB, level: "WRITE" },
    ]);
  });

  it("drops a removed operator and revokes only grants it made", async () => {
    members.set(`o1|${BOB}`, publisher);
    await seed({ id: "e1", ownerOrgId: "o1", orgOperators: JSON.stringify([BOB, CAROL]) });
    await syncEnvironmentOrgOnce(deps, await row("e1"));
    members.delete(`o1|${BOB}`);
    perm.revokePermission.mockClear();
    const out = await syncEnvironmentOrgOnce(deps, await row("e1"));
    expect(out).toStrictEqual({ result: "UPDATED", operators: [] });
    // CAROL was never granted by Vetra: nothing to revoke for her.
    expect(perm.revokePermission.mock.calls).toStrictEqual([["e1", BOB]]);
    expect(await grants()).toStrictEqual([]);
  });

  it("respects the app scope of app-linked envs", async () => {
    members.set(`o1|${BOB}`, { role: "PUBLISHER", effectiveScope: { all: false, appDids: ["did:key:other"] } });
    await seed({ id: "e1", ownerOrgId: "o1", appId: "app-1" });
    const out = await syncEnvironmentOrgOnce({ ...deps, appDidOf: async () => "did:key:shop" }, await row("e1"), [BOB]);
    expect(out.operators).toStrictEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("leaves everything as it is when Renown is down", async () => {
    await seed({ id: "e1", ownerOrgId: "o1", orgOperators: JSON.stringify([BOB]) });
    down = true;
    const out = await syncEnvironmentOrgOnce(deps, await row("e1"), [CAROL]);
    expect(out).toStrictEqual({ result: "SKIPPED", operators: [BOB] });
    expect(dispatch).not.toHaveBeenCalled();
    expect(perm.grantPermission).not.toHaveBeenCalled();
    expect(perm.revokePermission).not.toHaveBeenCalled();
  });

  it("grants READ to a viewer and the job revokes it once they leave", async () => {
    members.set(`o1|${CAROL}`, plain);
    await seed({ id: "e1", ownerOrgId: "o1" });
    await grantViewer(deps, await row("e1"), CAROL);
    expect(perm.grantPermission).toHaveBeenCalledWith("e1", CAROL, "READ", "vetra-org-sync");
    members.delete(`o1|${CAROL}`);
    expect(await runOrgSyncOnce(deps)).toBe(1);
    expect(perm.revokePermission).toHaveBeenCalledWith("e1", CAROL);
    expect(await grants()).toStrictEqual([]);
  });

  it("skips personal envs and reports how many org envs it visited", async () => {
    await seed({ id: "p1" });
    await seed({ id: "e1", ownerOrgId: "o1" });
    await seed({ id: "e2", ownerOrgId: "o2" });
    expect(await runOrgSyncOnce(deps)).toBe(2);
  });

  it("job: a Renown outage never shrinks operators or touches grants (WRITE and READ)", async () => {
    members.set(`o1|${BOB}`, publisher);
    members.set(`o1|${CAROL}`, plain);
    await seed({ id: "e1", ownerOrgId: "o1" });
    await syncEnvironmentOrgOnce(deps, await row("e1"), [BOB]);
    await grantViewer(deps, await row("e1"), CAROL);
    dispatch.mockClear();
    perm.grantPermission.mockClear();
    down = true;
    expect(await runOrgSyncOnce(deps)).toBe(1);
    expect(dispatch).not.toHaveBeenCalled();
    expect(perm.grantPermission).not.toHaveBeenCalled();
    expect(perm.revokePermission).not.toHaveBeenCalled();
    expect((await row("e1")).orgOperators).toBe(JSON.stringify([BOB]));
    expect(await grants()).toStrictEqual([
      { documentId: "e1", address: BOB, level: "WRITE" },
      { documentId: "e1", address: CAROL, level: "READ" },
    ]);
  });

  it("a failed app DID lookup is an outage too: SKIPPED, nothing changes", async () => {
    members.set(`o1|${BOB}`, { role: "PUBLISHER", effectiveScope: { all: false, appDids: ["did:key:shop"] } });
    await seed({ id: "e1", ownerOrgId: "o1", appId: "app-1", orgOperators: JSON.stringify([BOB]) });
    const failing = {
      ...deps,
      appDidOf: async (): Promise<string | null> => {
        throw new Error("apps db down");
      },
    };
    expect(await syncEnvironmentOrgOnce(failing, await row("e1"))).toStrictEqual({ result: "SKIPPED", operators: [BOB] });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("an unresolved app link keeps OWNER/ADMIN and all-scope publishers, drops scoped ones", async () => {
    members.set(`o1|${BOB}`, { role: "PUBLISHER", effectiveScope: { all: false, appDids: ["did:key:shop"] } });
    members.set(`o1|${CAROL}`, { role: "ADMIN", effectiveScope: { all: true, appDids: [] } });
    await seed({ id: "e1", ownerOrgId: "o1", appId: "app-1", orgOperators: JSON.stringify([BOB, CAROL]) });
    const out = await syncEnvironmentOrgOnce(deps, await row("e1"));
    expect(out).toStrictEqual({ result: "UPDATED", operators: [CAROL] });
  });

  it("an operator demoted to MEMBER keeps READ instead of WRITE", async () => {
    members.set(`o1|${BOB}`, publisher);
    await seed({ id: "e1", ownerOrgId: "o1" });
    await syncEnvironmentOrgOnce(deps, await row("e1"), [BOB]);
    members.set(`o1|${BOB}`, plain);
    perm.grantPermission.mockClear();
    const out = await syncEnvironmentOrgOnce(deps, await row("e1"));
    expect(out).toStrictEqual({ result: "UPDATED", operators: [] });
    expect(perm.grantPermission.mock.calls).toStrictEqual([["e1", BOB, "READ", "vetra-org-sync"]]);
    expect(perm.revokePermission).not.toHaveBeenCalled();
    expect(await grants()).toStrictEqual([{ documentId: "e1", address: BOB, level: "READ" }]);
  });

  it("is unchanged when nothing moved, and works without a permission service", async () => {
    members.set(`o1|${BOB}`, publisher);
    await seed({ id: "e1", ownerOrgId: "o1", orgOperators: JSON.stringify([BOB]) });
    const noPerm = { ...deps, perm: null };
    expect(await syncEnvironmentOrgOnce(noPerm, await row("e1"))).toStrictEqual({ result: "UNCHANGED", operators: [BOB] });
    await grantViewer(noPerm, await row("e1"), CAROL);
    expect(dispatch).not.toHaveBeenCalled();
    expect(await grants()).toStrictEqual([]);
  });

  it("re-checks holders of a Vetra WRITE grant instead of revoking blindly", async () => {
    members.set(`o1|${BOB}`, publisher);
    await seed({ id: "e1", ownerOrgId: "o1" });
    await db.insertInto("org_document_grants").values({ documentId: "e1", address: BOB, level: "WRITE", grantedAt: "t" }).execute();
    await setPerm("e1", BOB, "WRITE");
    expect(await syncEnvironmentOrgOnce(deps, await row("e1"))).toStrictEqual({ result: "UPDATED", operators: [BOB] });
    expect(perm.revokePermission).not.toHaveBeenCalled();
    expect(perm.grantPermission).not.toHaveBeenCalled();
  });

  it("personal envs are SKIPPED by the per-env sync", async () => {
    await seed({ id: "p1", orgOperators: JSON.stringify([BOB]) });
    expect(await syncEnvironmentOrgOnce(deps, await row("p1"), [BOB])).toStrictEqual({ result: "SKIPPED", operators: [BOB] });
  });

  it("job: one failing env does not stop the others", async () => {
    // Both envs list CAROL, who left: both dispatch, the first dispatch fails.
    await seed({ id: "e1", ownerOrgId: "o1", orgOperators: JSON.stringify([CAROL]) });
    await seed({ id: "e2", ownerOrgId: "o1", orgOperators: JSON.stringify([CAROL]) });
    dispatch.mockImplementationOnce(async () => {
      throw new Error("reactor busy");
    });
    expect(await runOrgSyncOnce(deps)).toBe(2);
    expect(deps.logger?.warn).toHaveBeenCalledTimes(1);
    expect((await row("e1")).orgOperators).toBe(JSON.stringify([CAROL]));
    expect((await row("e2")).orgOperators).toBe("[]");
  });

  it("overlapping syncs of one env keep both operators (per-env lock, fresh state)", async () => {
    members.set(`o1|${BOB}`, publisher);
    members.set(`o1|${CAROL}`, publisher);
    await seed({ id: "e1", ownerOrgId: "o1" });
    // The read model lags: dispatch takes a while before the row changes.
    dispatch.mockImplementation(async (id: string, _type: string, input: { operators: string[] }) => {
      await new Promise((r) => setTimeout(r, 20));
      await envDb.updateTable("environments").set({ orgOperators: JSON.stringify(input.operators) }).where("id", "=", id).execute();
    });
    const snapshot = await row("e1");
    await Promise.all([
      syncEnvironmentOrgOnce(deps, snapshot, [BOB]),
      syncEnvironmentOrgOnce(deps, snapshot, [CAROL]),
      runOrgSyncOnce(deps),
    ]);
    expect(JSON.parse((await row("e1")).orgOperators ?? "[]")).toStrictEqual([BOB, CAROL]);
  });

  it("bases the next list on the document state, not the lagging read model", async () => {
    members.set(`o1|${BOB}`, publisher);
    members.set(`o1|${CAROL}`, publisher);
    await seed({ id: "e1", ownerOrgId: "o1" });
    const doc = { owner: OWNER, ownerOrgId: "o1" as string | null, orgOperators: [] as string[] };
    dispatch.mockImplementation(async (_id: string, _type: string, input: { operators: string[] }) => {
      doc.orgOperators = input.operators; // the read-model row is never updated here
    });
    const withDoc = { ...deps, readOrgState: async () => ({ ...doc }) };
    await syncEnvironmentOrgOnce(withDoc, await row("e1"), [BOB]);
    await syncEnvironmentOrgOnce(withDoc, await row("e1"), [CAROL]);
    expect(doc.orgOperators).toStrictEqual([BOB, CAROL]);
    // A document that cannot be read is an outage: nothing changes.
    dispatch.mockClear();
    const unreadable = { ...deps, readOrgState: async (): Promise<null> => { throw new Error("reactor down"); } };
    expect((await syncEnvironmentOrgOnce(unreadable, await row("e1"))).result).toBe("SKIPPED");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("never touches a READ/WRITE grant Vetra did not create", async () => {
    members.set(`o1|${BOB}`, publisher);
    members.set(`o1|${CAROL}`, plain);
    await seed({ id: "e1", ownerOrgId: "o1" });
    await setPerm("e1", BOB, "READ"); // granted by hand
    await setPerm("e1", CAROL, "WRITE"); // granted by hand
    await syncEnvironmentOrgOnce(deps, await row("e1"), [BOB]);
    await grantViewer(deps, await row("e1"), CAROL);
    expect(perm.grantPermission).not.toHaveBeenCalled();
    expect(await grants()).toStrictEqual([]);
    members.delete(`o1|${BOB}`);
    members.delete(`o1|${CAROL}`);
    await runOrgSyncOnce(deps);
    expect(perm.revokePermission).not.toHaveBeenCalled();
    expect(await getPerm("e1", BOB)).toBe("READ");
    expect(await getPerm("e1", CAROL)).toBe("WRITE");
  });

  it("forgets a Vetra grant someone else changed, and never revokes it", async () => {
    members.set(`o1|${CAROL}`, plain);
    await seed({ id: "e1", ownerOrgId: "o1" });
    await grantViewer(deps, await row("e1"), CAROL);
    await setPerm("e1", CAROL, "ADMIN");
    members.delete(`o1|${CAROL}`);
    await runOrgSyncOnce(deps);
    expect(perm.revokePermission).not.toHaveBeenCalled();
    expect(await getPerm("e1", CAROL)).toBe("ADMIN");
    expect(await grants()).toStrictEqual([]);
  });

  it("leaves no record when the grant itself fails", async () => {
    members.set(`o1|${BOB}`, publisher);
    await seed({ id: "e1", ownerOrgId: "o1" });
    perm.grantPermission.mockImplementationOnce(async () => {
      throw new Error("db down");
    });
    await expect(syncEnvironmentOrgOnce(deps, await row("e1"), [BOB])).rejects.toThrow("db down");
    expect(await grants()).toStrictEqual([]);
  });

  it("restricts the system-only operations before granting anyone WRITE", async () => {
    members.set(`o1|${BOB}`, publisher);
    await seed({ id: "e1", ownerOrgId: "o1" });
    await syncEnvironmentOrgOnce(deps, await row("e1"), [BOB]);
    for (const op of SYSTEM_ONLY_OPERATIONS) expect(await restrictedBy("e1", op)).toStrictEqual([RESTRICTION_GRANTEE]);
    const lastRestrict = Math.max(...perm.grantOperationPermission.mock.invocationCallOrder);
    expect(lastRestrict).toBeLessThan(perm.grantPermission.mock.invocationCallOrder[0]);
    // Idempotent, and an operation someone else restricted is left as it is.
    await reactor.real.grantOperationPermission("e2", "SET_OWNER", "0xsomeone", "someone-else");
    await restrictSystemOperations(perm, "e1");
    await restrictSystemOperations(perm, "e2");
    expect(await restrictedBy("e1", "SET_OWNER")).toStrictEqual([RESTRICTION_GRANTEE]);
    expect(await restrictedBy("e2", "SET_OWNER")).toStrictEqual(["0xsomeone"]);
    expect(await restrictedBy("e2", "SYNC_ORG_OPERATORS")).toStrictEqual([RESTRICTION_GRANTEE]);
  });

  it("hand-over: the document moves to the service identity; a creator who leaves keeps nothing", async () => {
    const SERVICE = "0x5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e";
    const doc = { owner: BOB, ownerOrgId: null as string | null, orgOperators: [] as string[] };
    dispatch.mockImplementation(async (_id: string, _type: string, input: { operators: string[] }) => {
      doc.orgOperators = input.operators;
    });
    const d = { ...deps, serviceOwner: SERVICE, readOrgState: async () => ({ ...doc }) };
    await seed({ id: "e1", owner: BOB });
    // Personal and protected for BOB (as the protection reconciler leaves it).
    await protectEnvironment(perm, { id: "e1", owner: BOB, ownerOrgId: null }, { serviceOwner: SERVICE, db });
    expect(await reactor.auth.canMutate("e1", "SET_OWNER_ORG", BOB)).toBe(true);
    expect(await reactor.auth.canMutate("e1", "SET_LABEL", CAROL)).toBe(false);

    // BOB hands it to o1 where he publishes; the next sync takes the document over.
    members.set(`o1|${BOB}`, publisher);
    doc.ownerOrgId = "o1";
    doc.orgOperators = [BOB];
    await syncEnvironmentOrgOnce(d, await row("e1"));
    expect(await reactor.real.getDocumentOwner("e1")).toBe(SERVICE);
    expect(await getPerm("e1", BOB)).toBe("WRITE");
    expect(await db.selectFrom("org_document_protection").select(["documentId", "previousOwner"]).execute())
      .toStrictEqual([{ documentId: "e1", previousOwner: BOB }]);
    // As an operator he writes, but cannot submit the system-only operations unsigned.
    expect(await reactor.auth.canMutate("e1", "SET_LABEL", BOB)).toBe(true);
    for (const op of ["SET_OWNER_ORG", "SYNC_ORG_OPERATORS", "SET_OWNER", "SET_APP_LINK"]) {
      expect(await reactor.auth.canMutate("e1", op, BOB)).toBe(false);
    }

    // BOB leaves o1: no access at all, and nothing he could submit.
    members.delete(`o1|${BOB}`);
    await envDb.updateTable("environments").set({ ownerOrgId: "o1" }).where("id", "=", "e1").execute(); // read model caught up
    await runOrgSyncOnce(d);
    expect(doc.orgOperators).toStrictEqual([]);
    expect(await getPerm("e1", BOB)).toBeNull();
    expect(await reactor.auth.canRead("e1", BOB)).toBe(false);
    for (const op of ["SET_OWNER_ORG", "SYNC_ORG_OPERATORS", "SET_LABEL"]) {
      expect(await reactor.auth.canMutate("e1", op, BOB)).toBe(false);
    }

    // Idempotent: a recorded hand-over is not redone.
    perm.setDocumentOwner.mockClear();
    await syncEnvironmentOrgOnce(d, await row("e1"));
    expect(perm.setDocumentOwner).not.toHaveBeenCalled();
  });
});
