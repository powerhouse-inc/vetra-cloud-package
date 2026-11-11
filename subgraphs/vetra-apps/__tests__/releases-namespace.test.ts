import { describe, expect, it } from "vitest";
import { ensureAppNamespace, resolveNamespace } from "../releases/namespace.js";
import { makeHarness, seedActiveApp, type Harness } from "./harness.js";

const orgs = (o: string | null, p: string | null) => ({
  orgHandle: async () => o,
  personHandle: async () => p,
});
const personal = { owner_org_id: null, owner_address: "0x2BbEa0145d6fb9C6709a74C1179Ca0be71bb3aC6" };
const org = { owner_org_id: "org-7f3a9c1b2d", owner_address: personal.owner_address };

describe("resolveNamespace", () => {
  it("uses the org's handle for an org app", async () => {
    expect(await resolveNamespace(org, orgs("Sektar", "frank"))).toBe("sektar");
  });
  it("uses the owner's handle for a personal app", async () => {
    expect(await resolveNamespace(personal, orgs(null, "frank"))).toBe("frank");
  });
  it("falls back when there is no usable handle", async () => {
    expect(await resolveNamespace(personal, orgs(null, null))).toBe("u-2bbea014");
    expect(await resolveNamespace(personal, orgs(null, "Frank Ü"))).toBe("u-2bbea014");
    expect(await resolveNamespace(org, orgs(null, "frank"))).toBe("o-org7f3a9");
    expect(await resolveNamespace(personal, null)).toBe("u-2bbea014");
  });
});

describe("ensureAppNamespace", () => {
  const stored = async (h: Harness, id: string) =>
    (
      await h.db
        .selectFrom("apps")
        .select("registry_namespace")
        .where("id", "=", id)
        .executeTakeFirstOrThrow()
    ).registry_namespace;

  it("persists nothing when Renown fails, and succeeds on retry", async () => {
    const h = await makeHarness();
    try {
      const app = await seedActiveApp(h);
      h.orgs.down = true;
      await expect(ensureAppNamespace(h.deps, app)).rejects.toThrow();
      expect(await stored(h, app.id)).toBeNull();
      h.orgs.down = false;
      h.orgs.personHandles.set(app.owner_address.toLowerCase(), "frank");
      expect(await ensureAppNamespace(h.deps, app)).toBe("frank");
    } finally {
      await h.close();
    }
  });

  it("persists the fallback on a definitive null, then reuses the stored value", async () => {
    const h = await makeHarness();
    try {
      const app = await seedActiveApp(h);
      const ns = await ensureAppNamespace(h.deps, app);
      expect(ns).toBe(`u-${app.owner_address.toLowerCase().replace(/^0x/, "").slice(0, 8)}`);
      expect(await stored(h, app.id)).toBe(ns);
      h.orgs.down = true; // a second call must not ask Renown
      const again = await h.db.selectFrom("apps").selectAll().where("id", "=", app.id).executeTakeFirstOrThrow();
      expect(await ensureAppNamespace(h.deps, again)).toBe(ns);
    } finally {
      await h.close();
    }
  });

  it("refuses without a Renown client", async () => {
    const h = await makeHarness();
    try {
      const app = await seedActiveApp(h);
      await expect(ensureAppNamespace({ ...h.deps, orgs: null }, app)).rejects.toThrow(/Renown/);
      expect(await stored(h, app.id)).toBeNull();
    } finally {
      await h.close();
    }
  });
});
