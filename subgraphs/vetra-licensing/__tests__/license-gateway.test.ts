import { describe, it, expect, vi } from "vitest";
import { actions } from "document-models/app-owner-license";
import {
  createReactorLicenseGateway,
  LifecycleNotRecordedError,
  listLicenceDocumentIds,
  type LicenseGatewayClientLike,
} from "../license-gateway.js";

interface Executed {
  id: string;
  branch: string;
  actions: { id: string; type: string; input: unknown; signer?: unknown }[];
}

/** error: set to make the appended operation carry a reducer rejection. */
function fakeClient(opts: {
  exists?: boolean;
  error?: string;
  dropOp?: boolean;
  revision?: number;
}) {
  const executed: Executed[] = [];
  const opQueries: { filter?: { sinceRevision?: number } }[] = [];
  const created: { type: string }[] = [];
  const client: LicenseGatewayClientLike = {
    async createEmpty(type) {
      created.push({ type });
      return { header: { id: "lic-new" } };
    },
    async get(id) {
      if (opts.exists === false) throw new Error(`Document not found: ${id}`);
      return { header: { revision: { global: opts.revision ?? 4 } } };
    },
    async execute(id, branch, actions) {
      executed.push({ id, branch, actions: actions as Executed["actions"] });
      return { header: {} };
    },
    async getOperations(_id, _view, filter) {
      opQueries.push({ filter });
      return {
        results: opts.dropOp
          ? []
          : executed[0].actions.map((a) => ({
              action: { id: a.id, type: a.type },
              error: opts.error,
            })),
      };
    },
  };
  return { client, executed, opQueries, created };
}

describe("createReactorLicenseGateway", () => {
  it("activate dispatches a system-signed ACTIVATE_LICENSE on main", async () => {
    const f = fakeClient({ revision: 7 });
    await createReactorLicenseGateway(f.client).activate("lic-1");
    expect(f.executed).toHaveLength(1);
    expect(f.executed[0].id).toBe("lic-1");
    expect(f.executed[0].branch).toBe("main");
    expect(f.executed[0].actions[0].type).toBe("ACTIVATE_LICENSE");
    expect(f.executed[0].actions[0].signer).toBeUndefined();
    expect(f.opQueries[0].filter).toEqual({ sinceRevision: 7 });
  });

  it("expire dispatches EXPIRE_LICENSE", async () => {
    const f = fakeClient({});
    await createReactorLicenseGateway(f.client).expire("lic-2");
    expect(f.executed[0].id).toBe("lic-2");
    expect(f.executed[0].actions[0].type).toBe("EXPIRE_LICENSE");
  });

  it("throws with the reducer error text when the operation was rejected", async () => {
    const f = fakeClient({
      error: "cannot activate a license with status EXPIRED",
    });
    await expect(
      createReactorLicenseGateway(f.client).activate("lic-1"),
    ).rejects.toThrow(
      "ACTIVATE_LICENSE rejected: cannot activate a license with status EXPIRED",
    );
  });

  it("throws when no operation for the action was appended", async () => {
    const f = fakeClient({ dropOp: true });
    await expect(
      createReactorLicenseGateway(f.client).expire("lic-1"),
    ).rejects.toThrow("EXPIRE_LICENSE was not applied to license lic-1");
  });

  it("throws for a missing document without executing anything", async () => {
    const f = fakeClient({ exists: false });
    await expect(
      createReactorLicenseGateway(f.client).activate("nope"),
    ).rejects.toThrow("license nope not found");
    expect(f.executed).toHaveLength(0);
  });

  it("create makes an empty licence document and returns its id", async () => {
    const f = fakeClient({});
    await expect(createReactorLicenseGateway(f.client).create()).resolves.toBe(
      "lic-new",
    );
    expect(f.created).toEqual([{ type: "powerhouse/app-owner-license" }]);
  });

  it("execute dispatches every action and surfaces a rejection", async () => {
    const f = fakeClient({});
    const gw = createReactorLicenseGateway(f.client);
    const acts = [actions.activateLicense({}), actions.expireLicense({})];
    await gw.execute("lic-1", acts);
    expect(f.executed[0].actions.map((a) => a.type)).toEqual([
      "ACTIVATE_LICENSE",
      "EXPIRE_LICENSE",
    ]);

    const bad = fakeClient({ error: "nope" });
    await expect(
      createReactorLicenseGateway(bad.client).execute("lic-1", acts),
    ).rejects.toThrow("ACTIVATE_LICENSE rejected: nope");
  });

  describe("protection and the lifecycle record", () => {
    it("protects a new licence document before handing out its id", async () => {
      const f = fakeClient({});
      const protectedIds: string[] = [];
      const id = await createReactorLicenseGateway(f.client, { protect: async (i) => { protectedIds.push(i); } }).create();
      expect(id).toBe("lic-new");
      expect(protectedIds).toStrictEqual(["lic-new"]);
    });

    it("records the lifecycle after a write applied, and not after a rejection", async () => {
      const recorded: [string, string[]][] = [];
      const lifecycle = { record: async (id: string, acts: { type: string }[]) => { recorded.push([id, acts.map((a) => a.type)]); } };
      await createReactorLicenseGateway(fakeClient({}).client, { lifecycle }).expire("lic-1");
      await createReactorLicenseGateway(fakeClient({}).client, { lifecycle }).execute("lic-2", [actions.revokeLicense({ reason: null })]);
      await expect(createReactorLicenseGateway(fakeClient({ error: "no" }).client, { lifecycle }).activate("lic-3")).rejects.toThrow();
      expect(recorded).toStrictEqual([["lic-1", ["EXPIRE_LICENSE"]], ["lic-2", ["REVOKE_LICENSE"]]]);
    });

    it("retries a failed record once, then fails loudly", async () => {
      let calls = 0;
      const flaky = { record: async () => { if (++calls === 1) throw new Error("blip"); } };
      await createReactorLicenseGateway(fakeClient({}).client, { lifecycle: flaky }).expire("lic-1");
      expect(calls).toBe(2);
      const error = vi.fn();
      const down = { record: async () => { throw new Error("db down"); } };
      await expect(createReactorLicenseGateway(fakeClient({}).client, { lifecycle: down, logger: { error } }).expire("lic-1"))
        .rejects.toBeInstanceOf(LifecycleNotRecordedError);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("EXPIRE_LICENSE applied but its lifecycle status was not recorded"));
    });
  });

  it("lists every licence document id across pages", async () => {
    const pages: Record<string, { results: unknown[]; nextCursor?: string }> = {
      "0": { results: [{ header: { id: "a" } }, { header: {} }], nextCursor: "1" },
      "1": { results: [{ header: { id: "b" } }], nextCursor: "1" },
    };
    const seen: string[] = [];
    const ids = await listLicenceDocumentIds({
      find: async (search, _v, paging) => { seen.push(search.type!); return pages[paging!.cursor]!; },
      get: async () => null,
    });
    expect(ids).toStrictEqual(["a", "b"]);
    expect(seen).toStrictEqual(["powerhouse/app-owner-license", "powerhouse/app-owner-license"]);
  });
});
