import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createPackageRegistryResolver } from "../package-registry.js";

/*
  setDefaultPackageRegistry moves an environment between the two Vetra
  registries (production must use registry.vetra.io; the dev registry is for
  testing). The document op alone never redeploys a live environment, so for a
  deployed one the resolver also re-sets the current label (the op that marks
  it CHANGES_PENDING) and approves; gitops then re-renders the tenant.
*/

const TENANT = "cool-seal-134ff0d8-8b96161b";
const DOC = "doc-cool-seal";
const PROD = "https://registry.vetra.io";
const DEV = "https://registry.dev.vetra.io";

type Row = { id: string; name: string | null; status: string | null; owner: string | null };

function envDbStub(row: Row | undefined) {
  return {
    selectFrom: () => ({
      select: () => ({
        where: () => ({ executeTakeFirst: async () => row }),
      }),
    }),
  };
}

let dispatch: Mock<(documentId: string, type: string, input: Record<string, unknown>) => Promise<void>>;
beforeEach(() => {
  dispatch = vi.fn(async () => undefined);
});

const ready: Row = { id: DOC, name: "minesweeper", status: "READY", owner: "0xabc" };
const owner = { user: { address: "0xABC" } };
const admin = { user: { address: "0xadmin" }, isAdmin: (a: string) => a === "0xadmin" };
const stranger = { user: { address: "0xdef" }, isAdmin: () => false };

// `null` = no environment row for the tenant.
function resolver(row: Row | null = ready) {
  return createPackageRegistryResolver({ envDb: envDbStub(row ?? undefined) as never, dispatch })
    .Mutation.setDefaultPackageRegistry;
}

const types = () => dispatch.mock.calls.map((c) => c[1]);

describe("setDefaultPackageRegistry", () => {
  it("sets the registry on a deployed env and redeploys it (owner)", async () => {
    const res = await resolver()(null, { tenantId: TENANT, registryUrl: PROD }, owner);

    expect(dispatch.mock.calls).toEqual([
      [DOC, "SET_DEFAULT_PACKAGE_REGISTRY", { defaultPackageRegistry: PROD }],
      [DOC, "SET_LABEL", { label: "minesweeper" }],
      [DOC, "APPROVE_CHANGES", {}],
    ]);
    expect(res).toEqual({ tenantId: TENANT, defaultPackageRegistry: PROD, redeployed: true });
  });

  it("lets an admin change another owner's env", async () => {
    const res = await resolver()(null, { tenantId: TENANT, registryUrl: PROD }, admin);
    expect(res.redeployed).toBe(true);
  });

  it("drops a trailing slash", async () => {
    await resolver()(null, { tenantId: TENANT, registryUrl: `${PROD}/` }, owner);
    expect(dispatch.mock.calls[0][2]).toEqual({ defaultPackageRegistry: PROD });
  });

  it.each(["STOPPED", "DRAFT", "CHANGES_PENDING"])(
    "only sets the registry for a %s env (never ships the owner's pending edits)",
    async (status) => {
      const res = await resolver({ ...ready, status })(null, { tenantId: TENANT, registryUrl: DEV }, owner);
      expect(types()).toEqual(["SET_DEFAULT_PACKAGE_REGISTRY"]);
      expect(res.redeployed).toBe(false);
    },
  );

  it("does not redeploy when the env has no label to re-set", async () => {
    const res = await resolver({ ...ready, name: null })(null, { tenantId: TENANT, registryUrl: PROD }, owner);
    expect(types()).toEqual(["SET_DEFAULT_PACKAGE_REGISTRY"]);
    expect(res.redeployed).toBe(false);
  });

  it("rejects a registry other than the two Vetra registries", async () => {
    await expect(
      resolver()(null, { tenantId: TENANT, registryUrl: "https://evil.example" }, owner),
    ).rejects.toThrow("INVALID_REGISTRY");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("requires a caller", async () => {
    await expect(resolver()(null, { tenantId: TENANT, registryUrl: PROD }, {})).rejects.toThrow(
      "UNAUTHENTICATED",
    );
  });

  it("refuses a caller who is neither owner nor admin", async () => {
    await expect(
      resolver()(null, { tenantId: TENANT, registryUrl: PROD }, stranger),
    ).rejects.toThrow("FORBIDDEN");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("reports an unknown tenant", async () => {
    await expect(
      resolver(null)(null, { tenantId: "nope", registryUrl: PROD }, owner),
    ).rejects.toThrow("ENV_NOT_FOUND");
  });
});
