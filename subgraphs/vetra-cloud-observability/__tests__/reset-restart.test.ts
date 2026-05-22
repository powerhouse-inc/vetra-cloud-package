import { describe, expect, it, vi } from "vitest";
import {
  restartAppDeployments,
  restartSingleService,
  type ResetK8sClient,
} from "../reset/service.js";

type Deployment = {
  name: string;
  component: string;
  labels: Record<string, string>;
};

/**
 * Stub for the minimal k8s surface — records every patch call so tests
 * can assert which deployments were targeted and in what order.
 */
function makeK8s(
  deployments: Deployment[],
  opts: { failPatch?: (name: string) => boolean } = {},
): {
  k8s: ResetK8sClient;
  patches: string[];
} {
  const patches: string[] = [];
  const k8s: ResetK8sClient = {
    listAppDeployments: vi.fn(async () => deployments),
    patchDeploymentRestart: vi.fn(async (_ns, name) => {
      if (opts.failPatch?.(name)) {
        throw new Error(`patch failed: ${name}`);
      }
      patches.push(name);
    }),
  };
  return { k8s, patches };
}

describe("restartAppDeployments", () => {
  it("patches every connect/switchboard/clint/fusion deployment", async () => {
    const { k8s, patches } = makeK8s([
      { name: "connect", component: "connect", labels: {} },
      { name: "switchboard", component: "switchboard", labels: {} },
      {
        name: "clint-agent-a",
        component: "clint",
        labels: { "clint.vetra.io/agent": "a" },
      },
      { name: "fusion-x", component: "fusion", labels: {} },
    ]);

    const res = await restartAppDeployments(k8s, "tenant-1");

    expect(res.restarted).toBe(4);
    expect(res.failed).toEqual([]);
    expect(patches.sort()).toEqual(
      ["clint-agent-a", "connect", "fusion-x", "switchboard"].sort(),
    );
  });

  it("ignores deployments whose component label isn't a tenant-app component", async () => {
    const { k8s, patches } = makeK8s([
      { name: "connect", component: "connect", labels: {} },
      // helper / unrelated deployments shipped in the same namespace
      { name: "registry", component: "registry", labels: {} },
      { name: "pg-pooler", component: "pgbouncer", labels: {} },
      { name: "no-label", component: "", labels: {} },
    ]);

    const res = await restartAppDeployments(k8s, "tenant-1");

    expect(res.restarted).toBe(1);
    expect(patches).toEqual(["connect"]);
  });

  it("collects per-deployment patch failures without aborting the rest", async () => {
    const { k8s, patches } = makeK8s(
      [
        { name: "connect", component: "connect", labels: {} },
        { name: "switchboard", component: "switchboard", labels: {} },
        { name: "fusion-x", component: "fusion", labels: {} },
      ],
      { failPatch: (name) => name === "switchboard" },
    );

    const res = await restartAppDeployments(k8s, "tenant-1");

    expect(res.restarted).toBe(2);
    expect(res.failed).toEqual([
      { name: "switchboard", error: "patch failed: switchboard" },
    ]);
    expect(patches).toEqual(["connect", "fusion-x"]);
  });

  it("returns {0,[]} when the env has no app deployments yet", async () => {
    const { k8s } = makeK8s([]);
    const res = await restartAppDeployments(k8s, "tenant-1");
    expect(res).toEqual({ restarted: 0, failed: [] });
  });
});

describe("restartSingleService", () => {
  it("patches the single connect deployment", async () => {
    const { k8s, patches } = makeK8s([
      { name: "connect", component: "connect", labels: {} },
      { name: "switchboard", component: "switchboard", labels: {} },
    ]);
    const name = await restartSingleService(k8s, "tenant-1", "CONNECT");
    expect(name).toBe("connect");
    expect(patches).toEqual(["connect"]);
  });

  it("patches the single switchboard deployment", async () => {
    const { k8s, patches } = makeK8s([
      { name: "connect", component: "connect", labels: {} },
      { name: "switchboard", component: "switchboard", labels: {} },
    ]);
    const name = await restartSingleService(k8s, "tenant-1", "SWITCHBOARD");
    expect(name).toBe("switchboard");
    expect(patches).toEqual(["switchboard"]);
  });

  it("patches the single fusion deployment", async () => {
    const { k8s, patches } = makeK8s([
      { name: "fusion-x", component: "fusion", labels: {} },
    ]);
    const name = await restartSingleService(k8s, "tenant-1", "FUSION");
    expect(name).toBe("fusion-x");
    expect(patches).toEqual(["fusion-x"]);
  });

  it("filters clint deployments by agent prefix", async () => {
    const { k8s, patches } = makeK8s([
      {
        name: "clint-agent-a",
        component: "clint",
        labels: { "clint.vetra.io/agent": "a" },
      },
      {
        name: "clint-agent-b",
        component: "clint",
        labels: { "clint.vetra.io/agent": "b" },
      },
    ]);
    const name = await restartSingleService(k8s, "tenant-1", "CLINT", "b");
    expect(name).toBe("clint-agent-b");
    expect(patches).toEqual(["clint-agent-b"]);
  });

  it("throws AMBIGUOUS_SERVICE for CLINT without an agent prefix", async () => {
    const { k8s, patches } = makeK8s([
      {
        name: "clint-agent-a",
        component: "clint",
        labels: { "clint.vetra.io/agent": "a" },
      },
    ]);
    await expect(restartSingleService(k8s, "tenant-1", "CLINT")).rejects.toThrow(
      "AMBIGUOUS_SERVICE",
    );
    expect(patches).toEqual([]);
  });

  it("throws DEPLOYMENT_NOT_FOUND when no match is present", async () => {
    const { k8s } = makeK8s([
      { name: "connect", component: "connect", labels: {} },
    ]);
    await expect(
      restartSingleService(k8s, "tenant-1", "SWITCHBOARD"),
    ).rejects.toThrow("DEPLOYMENT_NOT_FOUND");
  });

  it("throws DEPLOYMENT_NOT_FOUND when the agent prefix matches nothing", async () => {
    const { k8s } = makeK8s([
      {
        name: "clint-agent-a",
        component: "clint",
        labels: { "clint.vetra.io/agent": "a" },
      },
    ]);
    await expect(
      restartSingleService(k8s, "tenant-1", "CLINT", "missing"),
    ).rejects.toThrow("DEPLOYMENT_NOT_FOUND");
  });

  it("throws AMBIGUOUS_SERVICE if more than one deployment matches the component", async () => {
    const { k8s } = makeK8s([
      { name: "connect-a", component: "connect", labels: {} },
      { name: "connect-b", component: "connect", labels: {} },
    ]);
    await expect(
      restartSingleService(k8s, "tenant-1", "CONNECT"),
    ).rejects.toThrow("AMBIGUOUS_SERVICE");
  });
});
