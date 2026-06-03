import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRestartResolver,
  deploymentSelector,
  type RestartResolverDeps,
} from "../restart.js";

const TENANT = "bold-duck-04-4732e4c0";

function envDbStub(envOwner: string | null) {
  return {
    selectFrom: () => ({
      select: () => ({
        where: () => ({
          executeTakeFirst: async () =>
            envOwner === null ? undefined : { tenantId: TENANT, owner: envOwner },
        }),
      }),
    }),
  };
}

let listDeploymentNames: ReturnType<typeof vi.fn>;
let restartDeployment: ReturnType<typeof vi.fn>;
let deps: RestartResolverDeps;

beforeEach(() => {
  listDeploymentNames = vi.fn(async () => [
    `powerhouse-${TENANT}-connect`,
  ]);
  restartDeployment = vi.fn(async () => undefined);
  deps = {
    envDb: envDbStub("0xAbC") as never,
    k8s: { listDeploymentNames, restartDeployment },
  };
});

const owner = { user: { address: "0xabc" } };

describe("deploymentSelector", () => {
  it("selects services by component label", () => {
    expect(deploymentSelector("CONNECT", null)).toBe(
      "app.kubernetes.io/component=connect",
    );
    expect(deploymentSelector("SWITCHBOARD", null)).toBe(
      "app.kubernetes.io/component=switchboard",
    );
  });

  it("selects agents by the clint.vetra.io/agent label", () => {
    expect(deploymentSelector("CLINT", "ph-pirate-cli-agent")).toBe(
      "clint.vetra.io/agent=ph-pirate-cli-agent",
    );
  });

  it("throws AMBIGUOUS_SERVICE for CLINT without a prefix", () => {
    expect(() => deploymentSelector("CLINT", null)).toThrow("AMBIGUOUS_SERVICE");
  });
});

describe("restartEnvironmentService", () => {
  it("restarts the matched service deployment as the owner", async () => {
    const r = createRestartResolver(deps);
    const res = await r.Mutation.restartEnvironmentService(
      null,
      { tenantId: TENANT, service: "CONNECT", agentPrefix: null },
      owner,
    );
    expect(listDeploymentNames).toHaveBeenCalledWith(
      TENANT,
      "app.kubernetes.io/component=connect",
    );
    expect(restartDeployment).toHaveBeenCalledOnce();
    expect(restartDeployment.mock.calls[0][0]).toBe(TENANT);
    expect(restartDeployment.mock.calls[0][1]).toBe(`powerhouse-${TENANT}-connect`);
    expect(res).toEqual({
      ok: true,
      deploymentName: `powerhouse-${TENANT}-connect`,
      message: null,
    });
  });

  it("restarts an agent deployment by prefix", async () => {
    listDeploymentNames.mockResolvedValueOnce([
      `powerhouse-${TENANT}-clint-ph-pirate-cli-agent`,
    ]);
    const r = createRestartResolver(deps);
    await r.Mutation.restartEnvironmentService(
      null,
      { tenantId: TENANT, service: "CLINT", agentPrefix: "ph-pirate-cli-agent" },
      owner,
    );
    expect(listDeploymentNames).toHaveBeenCalledWith(
      TENANT,
      "clint.vetra.io/agent=ph-pirate-cli-agent",
    );
    expect(restartDeployment).toHaveBeenCalledOnce();
  });

  it("allows an admin who is not the owner", async () => {
    deps = { ...deps, envDb: envDbStub("0xother") as never };
    const r = createRestartResolver(deps);
    await r.Mutation.restartEnvironmentService(
      null,
      { tenantId: TENANT, service: "CONNECT", agentPrefix: null },
      { user: { address: "0xadmin" }, isAdmin: () => true },
    );
    expect(restartDeployment).toHaveBeenCalledOnce();
  });

  it("throws RESTART_NOT_CONFIGURED when deps are absent", async () => {
    const r = createRestartResolver(undefined);
    await expect(
      r.Mutation.restartEnvironmentService(
        null,
        { tenantId: TENANT, service: "CONNECT", agentPrefix: null },
        owner,
      ),
    ).rejects.toThrow("RESTART_NOT_CONFIGURED");
  });

  it("throws UNAUTHENTICATED when there is no caller", async () => {
    const r = createRestartResolver(deps);
    await expect(
      r.Mutation.restartEnvironmentService(
        null,
        { tenantId: TENANT, service: "CONNECT", agentPrefix: null },
        {},
      ),
    ).rejects.toThrow("UNAUTHENTICATED");
    expect(restartDeployment).not.toHaveBeenCalled();
  });

  it("throws ENV_NOT_FOUND when the tenant has no env", async () => {
    deps = { ...deps, envDb: envDbStub(null) as never };
    const r = createRestartResolver(deps);
    await expect(
      r.Mutation.restartEnvironmentService(
        null,
        { tenantId: TENANT, service: "CONNECT", agentPrefix: null },
        owner,
      ),
    ).rejects.toThrow("ENV_NOT_FOUND");
  });

  it("throws FORBIDDEN for a non-owner non-admin", async () => {
    const r = createRestartResolver(deps);
    await expect(
      r.Mutation.restartEnvironmentService(
        null,
        { tenantId: TENANT, service: "CONNECT", agentPrefix: null },
        { user: { address: "0xstranger" } },
      ),
    ).rejects.toThrow("FORBIDDEN");
    expect(restartDeployment).not.toHaveBeenCalled();
  });

  it("throws AMBIGUOUS_SERVICE for CLINT without an agentPrefix", async () => {
    const r = createRestartResolver(deps);
    await expect(
      r.Mutation.restartEnvironmentService(
        null,
        { tenantId: TENANT, service: "CLINT", agentPrefix: null },
        owner,
      ),
    ).rejects.toThrow("AMBIGUOUS_SERVICE");
    expect(listDeploymentNames).not.toHaveBeenCalled();
  });

  it("throws DEPLOYMENT_NOT_FOUND when no deployment matches", async () => {
    listDeploymentNames.mockResolvedValueOnce([]);
    const r = createRestartResolver(deps);
    await expect(
      r.Mutation.restartEnvironmentService(
        null,
        { tenantId: TENANT, service: "CONNECT", agentPrefix: null },
        owner,
      ),
    ).rejects.toThrow("DEPLOYMENT_NOT_FOUND");
    expect(restartDeployment).not.toHaveBeenCalled();
  });

  it("throws AMBIGUOUS_SERVICE when more than one deployment matches", async () => {
    listDeploymentNames.mockResolvedValueOnce(["dep-a", "dep-b"]);
    const r = createRestartResolver(deps);
    await expect(
      r.Mutation.restartEnvironmentService(
        null,
        { tenantId: TENANT, service: "CLINT", agentPrefix: "dup" },
        owner,
      ),
    ).rejects.toThrow("AMBIGUOUS_SERVICE");
    expect(restartDeployment).not.toHaveBeenCalled();
  });
});
