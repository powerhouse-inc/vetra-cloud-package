import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeHarness,
  owner,
  seedActiveApp,
  stranger,
  type Harness,
} from "./harness.js";
import { seedRelease, digest } from "./instances-fixtures.js";
import { appInstancesFor } from "../instances/service.js";
import { reconcileInstancesOnce } from "../instances/reconciler.js";
import { updateApp } from "../service.js";
import { instanceLabel } from "../instances/host.js";

let h: Harness;
let appId: string;
let slug: string;
beforeEach(async () => {
  h = await makeHarness();
  const app = await seedActiveApp(h);
  appId = app.id;
  slug = app.slug;
  await h.db
    .updateTable("apps")
    .set({ registry_namespace: "acme" })
    .where("id", "=", appId)
    .execute();
});
afterEach(async () => {
  await h.close();
});

describe("instancesEnabled", () => {
  it("is off by default and the owner turns it on", async () => {
    const on = await updateApp(h.deps, owner, appId, {
      instancesEnabled: true,
    });
    expect(on.instances_enabled).toBe(true);
  });
  it("is refused to strangers", async () => {
    await expect(
      updateApp(h.deps, stranger, appId, { instancesEnabled: true }),
    ).rejects.toThrow();
  });
});

describe("appInstancesFor", () => {
  it("lists the app's instances with URL, status and versions", async () => {
    await updateApp(h.deps, owner, appId, { instancesEnabled: true });
    await seedRelease(h, appId, { version: "1.5.0-main.1", run: 100 });
    await reconcileInstancesOnce(h.deps);
    const [i] = await appInstancesFor(h.deps, owner, appId);
    expect(i).toMatchObject({
      kind: "branch",
      name: "main",
      branch: "main",
      pr: null,
      url: `https://${instanceLabel(appId, slug, "main", h.deps.cfg.instances.labelSuffix)}.vetra.io`,
      status: "updating",
      reason: null,
      targetVersion: "1.5.0-main.1",
      targetDigest: digest("a"),
      runningVersion: null,
    });
    expect(i.environmentId).toBeTruthy();
  });
  it("is refused to strangers", async () => {
    await expect(appInstancesFor(h.deps, stranger, appId)).rejects.toThrow();
  });
});
