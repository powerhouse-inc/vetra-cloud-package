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
import { listInstances, recordHealth } from "../instances/repo.js";

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
  it("shows the instance's health and what the cluster runs", async () => {
    await updateApp(h.deps, owner, appId, { instancesEnabled: true });
    await seedRelease(h, appId, { version: "1.5.0-main.1", run: 100 });
    await reconcileInstancesOnce(h.deps);
    const [row] = await listInstances(h.db, appId);
    await recordHealth(h.db, row.id, {
      health: "unhealthy",
      health_check: "crash",
      health_reason: "the container does not start (CrashLoopBackOff)",
      health_checked_at: "2026-11-12T00:00:00.000Z",
      health_since: "2026-11-12T00:00:00.000Z",
      health_digest: digest("a"),
      health_restarts: 3,
      observed_digest: digest("a"),
      observed_digest_source: "pod",
    });
    const [json] = await appInstancesFor(h.deps, owner, appId);
    expect(json).toMatchObject({
      health: "unhealthy",
      healthCheck: "crash",
      healthReason: "the container does not start (CrashLoopBackOff)",
      healthCheckedAt: "2026-11-12T00:00:00.000Z",
      observedDigest: digest("a"),
      observedDigestSource: "pod",
    });
  });
  it("is refused to strangers", async () => {
    await expect(appInstancesFor(h.deps, stranger, appId)).rejects.toThrow();
  });
});
