import { describe, it, expect } from "vitest";
import { actions } from "document-models/app-license-type";
import type { LicenseGatewayClientLike } from "../license-gateway.js";
import { createReactorLicenseTypeGateway } from "../license-type-gateway.js";

interface Op {
  index: number;
  action: { id: string; type: string };
  error?: string;
}

/**
 * Fake reactor with a real revision counter: execute() appends operations at
 * increasing indexes and getOperations() honours sinceRevision, so a gateway
 * that drops the revision filter sees stale operations and is caught.
 */
function fakeClient(opts: {
  exists?: boolean;
  error?: string;
  dropOp?: boolean;
  revision?: number;
}) {
  let revision = opts.revision ?? 4;
  const executed: { id: string; branch: string; actions: any[] }[] = [];
  const opQueries: { filter?: { sinceRevision?: number } }[] = [];
  const created: string[] = [];
  const ops: Op[] = [];
  // A stale operation from before this call, carrying an error, with a
  // colliding type but a different action id.
  ops.push({
    index: revision - 1,
    action: { id: "old", type: "PUBLISH_LICENSE_TYPE" },
    error: "stale failure",
  });
  const client: LicenseGatewayClientLike = {
    async createEmpty(type) {
      created.push(type);
      return { header: { id: "lt-new" } };
    },
    async get(id) {
      if (opts.exists === false) throw new Error(`Document not found: ${id}`);
      return { header: { revision: { global: revision } } };
    },
    async execute(id, branch, acts) {
      executed.push({ id, branch, actions: acts as any[] });
      if (!opts.dropOp) {
        for (const a of acts as any[]) {
          ops.push({
            index: revision++,
            action: { id: a.id, type: a.type },
            error: opts.error,
          });
        }
      }
      return { header: {} };
    },
    async getOperations(_id, _view, filter) {
      opQueries.push({ filter });
      const since = filter?.sinceRevision ?? 0;
      return { results: ops.filter((o) => o.index >= since) };
    },
  };
  return { client, executed, opQueries, created };
}

describe("createReactorLicenseTypeGateway", () => {
  it("create makes an empty licence-type document and returns its id", async () => {
    const f = fakeClient({});
    await expect(
      createReactorLicenseTypeGateway(f.client).create(),
    ).resolves.toBe("lt-new");
    expect(f.created).toEqual(["powerhouse/app-license-type"]);
  });

  it("execute dispatches system-signed actions on main from the captured revision", async () => {
    const f = fakeClient({ revision: 7 });
    await createReactorLicenseTypeGateway(f.client).execute("lt-1", [
      actions.publishLicenseType({}),
    ]);
    expect(f.executed).toHaveLength(1);
    expect(f.executed[0].id).toBe("lt-1");
    expect(f.executed[0].branch).toBe("main");
    expect(f.executed[0].actions[0].type).toBe("PUBLISH_LICENSE_TYPE");
    expect(f.executed[0].actions[0].signer).toBeUndefined();
    expect(f.opQueries[0].filter).toEqual({ sinceRevision: 7 });
  });

  it("throws with the reducer message when the operation was rejected", async () => {
    const f = fakeClient({ error: "template is incomplete" });
    await expect(
      createReactorLicenseTypeGateway(f.client).execute("lt-1", [
        actions.publishLicenseType({}),
      ]),
    ).rejects.toThrow("PUBLISH_LICENSE_TYPE rejected: template is incomplete");
  });

  it("does not mistake an earlier failed operation for this call's result", async () => {
    // The stale "old" op carries an error; a healthy publish must still pass.
    const f = fakeClient({});
    await expect(
      createReactorLicenseTypeGateway(f.client).execute("lt-1", [
        actions.publishLicenseType({}),
      ]),
    ).resolves.toBeUndefined();
  });

  it("throws when no operation for the action was appended", async () => {
    const f = fakeClient({ dropOp: true });
    await expect(
      createReactorLicenseTypeGateway(f.client).execute("lt-1", [
        actions.publishLicenseType({}),
      ]),
    ).rejects.toThrow("PUBLISH_LICENSE_TYPE was not applied to license type lt-1");
  });

  it("checks every action, not just the first", async () => {
    const f = fakeClient({});
    const orig = f.client.getOperations.bind(f.client);
    f.client.getOperations = async (...args) => {
      const res = await orig(...args);
      const last = res.results[res.results.length - 1] as Op;
      last.error = "second failed";
      return res;
    };
    await expect(
      createReactorLicenseTypeGateway(f.client).execute("lt-1", [
        actions.setLicenseTypeDetails({ label: "Pro" }),
        actions.publishLicenseType({}),
      ]),
    ).rejects.toThrow("PUBLISH_LICENSE_TYPE rejected: second failed");
  });

  it("throws for a missing document without executing anything", async () => {
    const f = fakeClient({ exists: false });
    await expect(
      createReactorLicenseTypeGateway(f.client).execute("nope", [
        actions.publishLicenseType({}),
      ]),
    ).rejects.toThrow("license type nope not found");
    expect(f.executed).toHaveLength(0);
  });
});
