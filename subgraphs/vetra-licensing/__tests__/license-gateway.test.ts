import { describe, it, expect } from "vitest";
import {
  createReactorLicenseGateway,
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
  const client: LicenseGatewayClientLike = {
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
      const a = executed[0].actions[0];
      return {
        results: opts.dropOp
          ? []
          : [{ action: { id: a.id, type: a.type }, error: opts.error }],
      };
    },
  };
  return { client, executed, opQueries };
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
});
