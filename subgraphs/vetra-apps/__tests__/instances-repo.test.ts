// subgraphs/vetra-apps/__tests__/instances-repo.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHarness, seedActiveApp, type Harness } from "./harness.js";
import { up } from "../db/migrations.js";
import { getApp } from "../repo.js";
import {
  deleteInstance,
  insertInstance,
  isHostUsed,
  listInstances,
  updateInstance,
  type NewInstance,
} from "../instances/repo.js";

let h: Harness;
let appId: string;
beforeEach(async () => {
  h = await makeHarness();
  appId = (await seedActiveApp(h)).id;
});
afterEach(async () => {
  await h.close();
});

const row = (over: Partial<NewInstance> = {}): NewInstance => ({
  id: "i-1",
  app_id: appId,
  kind: "branch",
  name: "main",
  branch: "main",
  pr: null,
  host: "shop-main",
  environment_id: null,
  target_version: "1.5.0-main.3",
  target_digest: `sha256:${"a".repeat(64)}`,
  target_repository: "cr.vetra.io/acme/shop",
  target_ph_host: "cli",
  target_run: 9_000_000_001,
  running_version: null,
  running_digest: null,
  running_repository: null,
  status: "pending",
  reason: null,
  failed_digest: null,
  update_started_at: null,
  removed_at: null,
  removed_reason: null,
  created_at: "2026-11-11T00:00:00.000Z",
  updated_at: "2026-11-11T00:00:00.000Z",
  ...over,
});

describe("instances table", () => {
  it("is created idempotently, with instances_enabled off on existing apps", async () => {
    await up(h.db as never);
    await up(h.db as never);
    expect((await getApp(h.db, appId))!.instances_enabled).toBe(false);
  });

  it("stores, lists, updates and deletes instances; run ids come back as numbers", async () => {
    await insertInstance(h.db, row());
    await insertInstance(
      h.db,
      row({
        id: "i-2",
        kind: "preview",
        name: "pr-4",
        branch: null,
        pr: 4,
        host: "shop-pr-4",
      }),
    );
    expect((await listInstances(h.db, appId)).map((r) => r.id)).toEqual([
      "i-1",
      "i-2",
    ]);
    const [main] = await listInstances(h.db, appId, "branch");
    expect(main.target_run).toBe(9_000_000_001);
    const moved = await updateInstance(
      h.db,
      "i-1",
      { status: "ready" },
      "2026-11-11T01:00:00.000Z",
    );
    expect(moved).toMatchObject({
      status: "ready",
      updated_at: "2026-11-11T01:00:00.000Z",
    });
    await deleteInstance(h.db, "i-2");
    expect(await listInstances(h.db, appId)).toHaveLength(1);
  });

  it("refuses a second instance with the same app, kind and name, or the same host", async () => {
    await insertInstance(h.db, row());
    await expect(
      insertInstance(h.db, row({ id: "i-2", host: "other" })),
    ).rejects.toThrow();
    await expect(
      insertInstance(h.db, row({ id: "i-3", name: "next", branch: "next" })),
    ).rejects.toThrow();
    // Several rows may have no host yet.
    await insertInstance(
      h.db,
      row({ id: "i-4", name: "a", branch: "a", host: null }),
    );
    await insertInstance(
      h.db,
      row({ id: "i-5", name: "b", branch: "b", host: null }),
    );
    expect(await isHostUsed(h.db, "shop-main")).toBe(true);
    expect(await isHostUsed(h.db, "shop-next")).toBe(false);
  });
});
