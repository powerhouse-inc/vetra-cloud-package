import { describe, it, expect, vi } from "vitest";
import { createWarmEnvironment } from "../warm-env.js";

function setup(executeFails = false) {
  const calls: string[] = [];
  const envs = {
    create: vi.fn(async () => (calls.push("create"), "env1")),
    execute: vi.fn(async (_id: string, _a: unknown[]) => {
      calls.push("execute");
      if (executeFails) throw new Error("rejected");
      return {} as never;
    }),
    getState: vi.fn(),
    delete: vi.fn(async () => void calls.push("delete")),
  };
  const protect = vi.fn(async () => void calls.push("protect"));
  const store = { insertWarming: vi.fn(async () => void calls.push("insert")) };
  const deps = {
    envs,
    protect,
    generateSubdomain: (id: string) => `sub-${id}`,
    store,
  } as never;
  return { calls, envs, store, deps };
}

const input = {
  appId: "app1",
  appName: "Sektar",
  template: {
    id: "tpl1",
    services: [{ id: "s1", type: "CONNECT" as const, prefix: "connect" }],
    packages: [],
    size: "VETRA_AGENT_S",
    baseDomain: null,
    packageRegistry: null,
  },
  templateHash: "hash1",
  nowIso: "2026-11-02T00:00:00.000Z",
};

describe("createWarmEnvironment", () => {
  it("protects before executing, labels (warm), records WARMING", async () => {
    const { calls, envs, store, deps } = setup();
    const id = await createWarmEnvironment(deps, input);
    expect(id).toBe("env1");
    expect(calls).toEqual(["create", "protect", "execute", "insert"]);
    const actions = envs.execute.mock.calls[0][1] as { type: string; input: any }[];
    expect(actions.find((a) => a.type === "SET_LABEL")!.input.label).toBe("Sektar (warm)");
    expect(actions.some((a) => a.type === "SET_OWNER")).toBe(false);
    expect(store.insertWarming).toHaveBeenCalledWith({
      environmentId: "env1",
      appId: "app1",
      templateId: "tpl1",
      templateHash: "hash1",
      nowIso: input.nowIso,
    });
  });

  it("deletes the document and inserts nothing when execute fails", async () => {
    const { envs, store, deps } = setup(true);
    await expect(createWarmEnvironment(deps, input)).rejects.toThrow("rejected");
    expect(envs.delete).toHaveBeenCalledWith("env1");
    expect(store.insertWarming).not.toHaveBeenCalled();
  });
});
