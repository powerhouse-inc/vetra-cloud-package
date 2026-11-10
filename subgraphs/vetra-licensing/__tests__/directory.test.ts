import { describe, expect, it } from "vitest";
import { appDirectory, cachedFor, type DirectoryDeps } from "../directory.js";

type Term = { status: string };
type App = { id: string; name: string | null; status: string; tampered: boolean; terms: Term[] };

const app = (id: string, over: Partial<App> = {}): App => ({
  id,
  name: id,
  status: "ACTIVE",
  tampered: false,
  terms: [{ status: "ACTIVE" }],
  ...over,
});

function deps(input: {
  apps: App[];
  rows?: Record<string, { identityDid: string | null; status: string } | null>;
  licences?: Record<string, { userDid: string; status: string }[]>;
}): DirectoryDeps {
  return {
    appIds: async () => new Set(input.apps.map((a) => a.id)),
    app: async (id) => (input.apps.find((a) => a.id === id) as never) ?? null,
    identity: async (id) =>
      input.rows && id in input.rows ? input.rows[id]! : { identityDid: `did:key:${id}`, status: "ACTIVE" },
    licencesOf: async (id) => input.licences?.[id] ?? [],
  };
}

describe("appDirectory", () => {
  it("ranks apps by distinct users holding an ACTIVE licence, then by name", async () => {
    const list = await appDirectory(
      deps({
        apps: [app("beta"), app("alpha"), app("sektar")],
        licences: {
          sektar: [
            { userDid: "did:a", status: "ACTIVE" },
            { userDid: "did:a", status: "ACTIVE" },
            { userDid: "did:b", status: "ACTIVE" },
            { userDid: "did:c", status: "EXPIRED" },
            { userDid: "did:d", status: "ISSUED" },
          ],
          beta: [{ userDid: "did:a", status: "ACTIVE" }],
        },
      }),
    );
    expect(list.map((a) => [a.appId, a.holders])).toStrictEqual([
      ["sektar", 2],
      ["beta", 1],
      ["alpha", 0],
    ]);
  });

  it("lists only apps you can get: published plans, not deleted, not tampered", async () => {
    const list = await appDirectory(
      deps({
        apps: [
          app("live", { terms: [{ status: "DRAFT" }, { status: "ACTIVE" }, { status: "ACTIVE" }] }),
          app("drafts-only", { terms: [{ status: "DRAFT" }, { status: "RETIRED" }] }),
          app("deleted"),
          app("tampered", { tampered: true }),
          app("doc-deleted", { status: "DELETED" }),
        ],
        rows: { deleted: { identityDid: "did:key:deleted", status: "DELETED" } },
      }),
    );
    expect(list.map((a) => a.appId)).toStrictEqual(["live"]);
    expect(list[0]).toMatchObject({ plans: 2, appDid: "did:key:live" });
  });

  it("carries counts only, never who holds them", async () => {
    const [entry] = await appDirectory(
      deps({ apps: [app("sektar")], licences: { sektar: [{ userDid: "did:secret", status: "ACTIVE" }] } }),
    );
    expect(Object.keys(entry!).sort()).toStrictEqual(["appDid", "appId", "holders", "name", "plans"]);
    expect(JSON.stringify(entry)).not.toContain("did:secret");
  });

  it("falls back to the app id for a nameless app and to null for an app without identity", async () => {
    const [entry] = await appDirectory(
      deps({ apps: [app("studio", { name: null })], rows: { studio: null } }),
    );
    expect(entry).toMatchObject({ appId: "studio", name: "studio", appDid: null });
  });
});

describe("cachedFor", () => {
  it("answers from the last result until it is older than the window, then reads again", async () => {
    let clock = 0;
    let reads = 0;
    const get = cachedFor(60_000, () => clock, async () => ++reads);
    expect(await get()).toBe(1);
    clock = 59_999;
    expect(await get()).toBe(1);
    clock = 60_000;
    expect(await get()).toBe(2);
  });

  it("does not keep a failed read", async () => {
    let fail = true;
    const get = cachedFor(60_000, () => 0, async () => {
      if (fail) throw new Error("reactor down");
      return "ok";
    });
    await expect(get()).rejects.toThrow("reactor down");
    fail = false;
    expect(await get()).toBe("ok");
  });
});
