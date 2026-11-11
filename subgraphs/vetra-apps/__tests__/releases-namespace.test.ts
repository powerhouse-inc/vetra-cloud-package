import { describe, expect, it } from "vitest";
import { ensureAppNamespace, resolveNamespace } from "../releases/namespace.js";
import type { AppRow } from "../repo.js";
import {
  makeHarness,
  ORG,
  seedActiveApp,
  STRANGER,
  type Harness,
} from "./harness.js";

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
    expect(await resolveNamespace(personal, orgs(null, null))).toBe("u-2bbea0145d6fb9c6");
    expect(await resolveNamespace(personal, orgs(null, "Frank Ü"))).toBe("u-2bbea0145d6fb9c6");
    expect(await resolveNamespace(org, orgs(null, "frank"))).toBe("o-org7f3a9c1b2d");
    expect(await resolveNamespace(personal, null)).toBe("u-2bbea0145d6fb9c6");
  });
  it("falls back for handles that name infrastructure or fallback projects", async () => {
    for (const h of [
      "library",
      "Library",
      "app-x",
      "app-shop",
      "vetra",
      "vetra-cloud-package",
      "powerhouse-inc",
      "powerhouse-inc-powerhouse",
      "u-2bbea0145d6fb9c6",
      "o-org7f3a9c1b2d",
    ]) {
      expect(await resolveNamespace(personal, orgs(null, h)), h).toBe("u-2bbea0145d6fb9c6");
      expect(await resolveNamespace(org, orgs(h, null)), h).toBe("o-org7f3a9c1b2d");
    }
    expect(await resolveNamespace(personal, orgs(null, "apple"))).toBe("apple");
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
      expect(ns).toBe(`u-${app.owner_address.toLowerCase().replace(/^0x/, "").slice(0, 16)}`);
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

  /** A second app of the same repo, owned as `over` says (only the slug is unique). */
  const cloneApp = async (h: Harness, a: AppRow, id: string, over: Partial<AppRow> = {}) => {
    await h.db
      .insertInto("apps")
      .values({ ...a, id, slug: `${a.slug}-${id}`, registry_namespace: null, ...over })
      .execute();
    return h.db.selectFrom("apps").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
  };
  const claimRow = (h: Harness, ns: string) =>
    h.db.selectFrom("registry_namespaces").selectAll().where("namespace", "=", ns).executeTakeFirst();

  it("claims the namespace for its owner; the same owner's other apps share it", async () => {
    const h = await makeHarness();
    try {
      const a = await seedActiveApp(h);
      const b = await cloneApp(h, a, "vault");
      h.orgs.personHandles.set(a.owner_address.toLowerCase(), "acme");
      expect(await ensureAppNamespace(h.deps, a)).toBe("acme");
      expect(await ensureAppNamespace(h.deps, b)).toBe("acme");
      expect(await claimRow(h, "acme")).toMatchObject({
        owner_kind: "person",
        owner_id: a.owner_address.toLowerCase(),
      });
      expect(await stored(h, b.id)).toBe("acme");
    } finally {
      await h.close();
    }
  });

  it("refuses a handle another person already holds and stores nothing", async () => {
    const h = await makeHarness();
    try {
      const a = await seedActiveApp(h);
      h.orgs.personHandles.set(a.owner_address.toLowerCase(), "acme");
      await ensureAppNamespace(h.deps, a);
      const b = await cloneApp(h, a, "vault", { owner_address: STRANGER });
      h.orgs.personHandles.set(STRANGER, "acme"); // handle released and re-taken
      await expect(ensureAppNamespace(h.deps, b)).rejects.toMatchObject({
        extensions: { code: "FORBIDDEN" },
      });
      expect(await stored(h, b.id)).toBeNull();
      expect(await claimRow(h, "acme")).toMatchObject({ owner_kind: "person" });
    } finally {
      await h.close();
    }
  });

  it("refuses an org whose handle a person already holds", async () => {
    const h = await makeHarness();
    try {
      const a = await seedActiveApp(h);
      h.orgs.personHandles.set(a.owner_address.toLowerCase(), "acme");
      await ensureAppNamespace(h.deps, a);
      const b = await cloneApp(h, a, "vault", { owner_org_id: ORG });
      h.orgs.orgHandles.set(ORG, "acme");
      await expect(ensureAppNamespace(h.deps, b)).rejects.toMatchObject({
        extensions: { code: "FORBIDDEN" },
      });
      expect(await stored(h, b.id)).toBeNull();
    } finally {
      await h.close();
    }
  });
});
