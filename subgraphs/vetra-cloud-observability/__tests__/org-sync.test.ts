import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import type { ObservabilityDB } from "../db/schema.js";
import { grantViewer, runOrgSyncOnce, syncEnvironmentOrgOnce, type OrgSyncDeps, type OrgEnvRow } from "../org-sync.js";
import { RenownOrgsUnavailableError, type OrgMembership } from "../../../shared/renown-orgs.js";

const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CAROL = "0xcccccccccccccccccccccccccccccccccccccccc";

let db: Kysely<ObservabilityDB>;
let envDb: Kysely<any>;
let members: Map<string, OrgMembership>;
let down: boolean;
let deps: OrgSyncDeps;
let perm: { grantPermission: ReturnType<typeof vi.fn>; revokePermission: ReturnType<typeof vi.fn> };
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
  perm = { grantPermission: vi.fn(async () => undefined), revokePermission: vi.fn(async () => undefined) };
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
  await db.destroy();
  await envDb.destroy();
});

describe("operator sync", () => {
  it("adds a publisher candidate, grants WRITE, never touches the owner's grant", async () => {
    members.set(`o1|${BOB}`, publisher);
    members.set(`o1|${OWNER}`, publisher);
    await seed({ id: "e1", ownerOrgId: "o1" });
    const out = await syncEnvironmentOrgOnce(deps, await row("e1"), [BOB.toUpperCase().replace("0X", "0x")]);
    expect(out).toStrictEqual({ result: "UPDATED", operators: [OWNER, BOB] });
    expect(dispatch).toHaveBeenCalledWith("e1", "SYNC_ORG_OPERATORS", { operators: [OWNER, BOB] });
    expect(perm.grantPermission).toHaveBeenCalledTimes(1);
    expect(perm.grantPermission).toHaveBeenCalledWith("e1", BOB, "WRITE", "vetra-org-sync");
    expect(await grants()).toStrictEqual([{ documentId: "e1", address: BOB, level: "WRITE" }]);
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
});
