import { describe, expect, it, vi } from "vitest";
import { dropDeletedEnvironment, type DropDeps } from "../deleted-environment.js";

type Row = { environment_id: string; root_license_id: string; user_did: string; app_id: string };

function deps(input: { row: Row | null; docExists: boolean }) {
  const removed: string[] = [];
  const forgotten: string[] = [];
  const locked: string[] = [];
  const d: DropDeps = {
    rows: {
      byRoot: async () => input.row as never,
      remove: async (id) => {
        removed.push(id);
      },
    },
    envState: async () => (input.docExists ? ({ status: "READY" } as never) : null),
    forgetEnvironment: async (id) => {
      forgotten.push(id);
    },
    lock: async (root, fn) => {
      locked.push(root);
      return fn();
    },
  };
  return { d, removed, forgotten, locked };
}

const ROW: Row = { environment_id: "env-1", root_license_id: "root", user_did: "did:me", app_id: "app" };
const CHAIN = { root: "root", userDid: "did:me", appId: "app" };

describe("dropDeletedEnvironment", () => {
  it("forgets and removes the row of an environment whose document is gone, under the chain lock", async () => {
    const { d, removed, forgotten, locked } = deps({ row: ROW, docExists: false });
    expect(await dropDeletedEnvironment(d, CHAIN)).toBe("env-1");
    expect(locked).toStrictEqual(["root"]);
    expect(forgotten).toStrictEqual(["env-1"]);
    expect(removed).toStrictEqual(["env-1"]);
  });

  it("leaves an environment that still exists alone", async () => {
    const { d, removed } = deps({ row: ROW, docExists: true });
    expect(await dropDeletedEnvironment(d, CHAIN)).toBeNull();
    expect(removed).toStrictEqual([]);
  });

  it("does nothing for a chain without a row, or another holder's or app's row", async () => {
    for (const row of [null, { ...ROW, user_did: "did:other" }, { ...ROW, app_id: "other" }]) {
      const { d, removed } = deps({ row, docExists: false });
      expect(await dropDeletedEnvironment(d, CHAIN)).toBeNull();
      expect(removed).toStrictEqual([]);
    }
  });

  it("keeps the row when forgetting the old environment fails", async () => {
    const { d, removed } = deps({ row: ROW, docExists: false });
    d.forgetEnvironment = vi.fn(async () => {
      throw new Error("db down");
    });
    await expect(dropDeletedEnvironment(d, CHAIN)).rejects.toThrow("db down");
    expect(removed).toStrictEqual([]);
  });
});
