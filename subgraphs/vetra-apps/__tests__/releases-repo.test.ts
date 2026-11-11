import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHarness, seedActiveApp, type Harness } from "./harness.js";
import { insertRelease, listReleases } from "../releases/repo.js";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.close();
});

const row = (appId: string, over: Record<string, unknown> = {}) => ({
  app_id: appId,
  version: "1.4.0",
  kind: "release" as const,
  branch: "main",
  pr: null,
  run: 100,
  commit: "abc123",
  notes: "## Fixes",
  customer_notes: "## Fixes",
  image_ref: "cr.vetra.io/acme/shop:1.4.0",
  image_digest: "sha256:aa",
  host: "cli",
  packages: JSON.stringify([]),
  requires: JSON.stringify({}),
  migrates: false,
  powerhouse_version: "6.2.3",
  base_image: "node:24-bookworm-slim@sha256:00",
  created_at: "2026-11-11T10:00:00.000Z",
  ...over,
});

describe("releases table", () => {
  it("stores a release once and returns the stored row on a repeat", async () => {
    const app = await seedActiveApp(h);
    const first = await insertRelease(h.deps.db, row(app.id));
    const again = await insertRelease(
      h.deps.db,
      row(app.id, { image_digest: "sha256:bb" }),
    );
    expect(first.created).toBe(true);
    expect(again).toMatchObject({
      created: false,
      row: { image_digest: "sha256:aa" },
    });
  });

  it("lists newest first by run, filtered by kind", async () => {
    const app = await seedActiveApp(h);
    await insertRelease(
      h.deps.db,
      row(app.id, { version: "1.5.0-main.1", kind: "build", run: 101 }),
    );
    await insertRelease(h.deps.db, row(app.id, { version: "1.4.1", run: 103 }));
    await insertRelease(
      h.deps.db,
      row(app.id, { version: "1.5.0-main.2", kind: "build", run: 102 }),
    );
    const all = await listReleases(h.deps.db, app.id, { limit: 10 });
    expect(all.map((r) => r.version)).toStrictEqual([
      "1.4.1",
      "1.5.0-main.2",
      "1.5.0-main.1",
    ]);
    const releases = await listReleases(h.deps.db, app.id, {
      kind: "release",
      limit: 10,
    });
    expect(releases.map((r) => r.version)).toStrictEqual(["1.4.1"]);
  });

  it("keeps GitHub run ids above 32 bits as numbers", async () => {
    const app = await seedActiveApp(h);
    const { row: stored } = await insertRelease(
      h.deps.db,
      row(app.id, { run: 40_000_000_000 }),
    );
    expect(stored.run).toBe(40_000_000_000);
    const [listed] = await listReleases(h.deps.db, app.id, { limit: 1 });
    expect(listed.run).toBe(40_000_000_000);
  });
});
