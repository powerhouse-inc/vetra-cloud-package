import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeHarness,
  OWNER,
  seedActiveApp,
  stranger,
  testConfig,
  type Harness,
} from "./harness.js";
import { digest, seedLicence, seedRelease } from "./instances-fixtures.js";
import { reconcileInstancesOnce } from "../instances/reconciler.js";
import { insertPlan } from "../plans/repo.js";
import { holderInstancesFor, myInstancesFor } from "../plans/holder-view.js";
import { publicHostOf, publicUrlOf } from "../instances/public-host.js";
import type { Caller } from "../auth.js";
import { instanceJson } from "../instances/service.js";
import { listInstances } from "../instances/repo.js";

const HOLDER = "0x1111111111111111111111111111111111111111";
const holder: Caller = {
  address: HOLDER,
  chainId: 1,
  appKey: null,
  isAdmin: false,
};
let h: Harness;
let appId: string;

const base = {
  policy: "manual",
  notice_hours: 72,
  status: "active" as const,
  size: "VETRA_AGENT_S",
  target_version: "1.4.0",
  created_by: OWNER,
  created_at: "2026-10-01T00:00:00.000Z",
  updated_at: "2026-10-01T00:00:00.000Z",
};

beforeEach(async () => {
  h = await makeHarness(
    testConfig({ plans: { enabled: true, stopAfterDays: 14 } }),
  );
  appId = (await seedActiveApp(h)).id;
  await h.db
    .updateTable("apps")
    .set({ instances_enabled: true, registry_namespace: "acme" })
    .where("id", "=", appId)
    .execute();
  await seedRelease(h, appId, {
    version: "1.4.0",
    run: 100,
    kind: "release",
    digest: digest("b"),
  });
  await insertPlan(h.db, {
    ...base,
    id: "p-own",
    app_id: appId,
    slug: "pro",
    name: "Pro",
    kind: "pro",
    access: "own",
  });
  await insertPlan(h.db, {
    ...base,
    id: "p-sh",
    app_id: appId,
    slug: "starter",
    name: "Starter",
    kind: "starter",
    access: "shared",
  });
  await seedLicence(h, { appId, kind: "pro", holder: HOLDER, licenseId: "l1" });
  await seedLicence(h, {
    appId,
    kind: "starter",
    holder: HOLDER,
    licenseId: "l2",
  });
  await reconcileInstancesOnce(h.deps);
});
afterEach(async () => {
  await h.close();
});

describe("myInstances", () => {
  it("lists the holder's own instance and the shared instances of their plans", async () => {
    const mine = await myInstancesFor(h.deps, holder);
    expect(mine.map((m) => [m.planName, m.access])).toEqual([
      ["Pro", "own"],
      ["Starter", "shared"],
    ]);
    expect(mine[0].url).toMatch(/^https:\/\/.+\.vetra\.io$/);
  });
  it("shows the custom domain once active, the generated host while dns or issuing", async () => {
    const own = (await listInstances(h.db, appId, "own"))[0];
    for (const [status, url] of [
      ["dns", `https://${own.host}.vetra.io`],
      ["issuing", `https://${own.host}.vetra.io`],
      ["active", "https://app.acme.io"],
    ] as const) {
      await h.db
        .updateTable("instances")
        .set({ custom_domain: "app.acme.io", custom_domain_status: status })
        .where("id", "=", own.id)
        .execute();
      const mine = await myInstancesFor(h.deps, holder);
      expect(mine[0].url).toBe(url);
    }
  });
  it("lists nothing of a deleted App", async () => {
    await h.db
      .updateTable("apps")
      .set({ status: "DELETED" })
      .where("id", "=", appId)
      .execute();
    expect(await myInstancesFor(h.deps, holder)).toEqual([]);
  });
  it("lists nothing for someone without licences", async () => {
    expect(await myInstancesFor(h.deps, stranger)).toEqual([]);
  });
});

describe("AppInstance", () => {
  it("carries the plan and, for an own instance, the holder", async () => {
    const json = (await listInstances(h.db, appId)).map(instanceJson);
    expect(json.find((j) => j.kind === "own")).toMatchObject({
      planId: "p-own",
      holder: HOLDER,
    });
    expect(json.find((j) => j.kind === "shared")).toMatchObject({
      planId: "p-sh",
      holder: null,
    });
    expect(json.find((j) => j.kind === "branch")).toMatchObject({
      planId: null,
      holder: null,
    });
  });
});

describe("holderInstancesFor (the App directory)", () => {
  it("lists the holder's own instance and the shared instances of their live kinds, with environments", async () => {
    const out = await holderInstancesFor(h.deps, appId, HOLDER.toUpperCase());
    const rows = await listInstances(h.db, appId);
    const ownRow = rows.find((r) => r.kind === "own")!;
    const sharedRow = rows.find((r) => r.kind === "shared")!;
    expect(out).toEqual([
      {
        environmentId: ownRow.environment_id,
        name: "Shop (Pro)",
        url: publicUrlOf(ownRow),
        status: ownRow.status,
      },
      {
        environmentId: sharedRow.environment_id,
        name: "Shop (Starter)",
        url: publicUrlOf(sharedRow),
        status: sharedRow.status,
      },
    ]);
    expect(out[0].url).toMatch(/^https:\/\/.+\.vetra\.io$/);
  });

  it("lists nothing while plans are off (production)", async () => {
    h.deps.cfg = {
      ...h.deps.cfg,
      plans: { enabled: false, stopAfterDays: 14 },
    };
    expect(await holderInstancesFor(h.deps, appId, HOLDER)).toEqual([]);
  });

  it("lists nothing for a stranger, another App, or a lapsed holder's shared plan", async () => {
    expect(await holderInstancesFor(h.deps, appId, stranger.address)).toEqual(
      [],
    );
    expect(await holderInstancesFor(h.deps, "other-app", HOLDER)).toEqual([]);
    await h.deps
      .licensingDb!.updateTable("license_lifecycle")
      .set({ status: "EXPIRED" })
      .where("license_id", "=", "l2")
      .execute();
    expect(
      (await holderInstancesFor(h.deps, appId, HOLDER)).map((i) => i.name),
    ).toEqual(["Shop (Pro)"]);
  });

  it("lists nothing of a deleted App or a removed instance", async () => {
    await h.db
      .updateTable("instances")
      .set({ status: "removed" })
      .where("kind", "=", "own")
      .execute();
    expect(
      (await holderInstancesFor(h.deps, appId, HOLDER)).map((i) => i.name),
    ).toEqual(["Shop (Starter)"]);
    await h.db
      .updateTable("apps")
      .set({ status: "DELETED" })
      .where("id", "=", appId)
      .execute();
    expect(await holderInstancesFor(h.deps, appId, HOLDER)).toEqual([]);
  });
});

describe("publicHostOf", () => {
  const r = { host: "frank-pro", custom_domain: "frank.sektar.app" };
  it("is the custom domain once active, else the generated host", () => {
    expect(publicHostOf({ ...r, custom_domain_status: "active" })).toBe(
      "frank.sektar.app",
    );
    for (const st of ["dns", "issuing", "failed", null])
      expect(publicHostOf({ ...r, custom_domain_status: st })).toBe(
        "frank-pro.vetra.io",
      );
    expect(publicHostOf({ host: "frank-pro" })).toBe("frank-pro.vetra.io");
    expect(publicHostOf({ host: null })).toBeNull();
    expect(publicUrlOf({ ...r, custom_domain_status: "active" })).toBe(
      "https://frank.sektar.app",
    );
    expect(publicUrlOf({ host: null })).toBeNull();
  });
});
