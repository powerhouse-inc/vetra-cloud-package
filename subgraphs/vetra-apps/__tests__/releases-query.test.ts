import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeHarness,
  owner,
  seedActiveApp,
  stranger,
  type Harness,
} from "./harness.js";
import { appReleasesFor } from "../releases/service.js";
import { insertRelease } from "../releases/repo.js";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.close();
});

const rec = (
  appId: string,
  version: string,
  kind: "release" | "build",
  run: number,
) => ({
  app_id: appId,
  version,
  kind,
  branch: "main",
  pr: null,
  run,
  commit: "c",
  notes: null,
  customer_notes: null,
  image_ref: `cr.vetra.io/acme/shop:${version}`,
  image_digest: `sha256:${"a".repeat(64)}`,
  host: "cli",
  packages: "[]",
  requires: "{}",
  migrates: false,
  powerhouse_version: "6.2.3",
  base_image: "node:24-bookworm-slim@sha256:00",
  created_at: "2026-11-11T10:00:00.000Z",
});

describe("appReleasesFor", () => {
  it("lists an owner's releases newest first, filtered by kind and limited", async () => {
    const app = await seedActiveApp(h);
    await insertRelease(h.deps.db, rec(app.id, "1.4.0", "release", 1));
    await insertRelease(h.deps.db, rec(app.id, "1.5.0-main.1", "build", 2));
    await insertRelease(h.deps.db, rec(app.id, "1.4.1", "release", 3));
    const all = await appReleasesFor(h.deps, owner, app.id, null, null);
    expect(all.map((r) => r.version)).toStrictEqual([
      "1.4.1",
      "1.5.0-main.1",
      "1.4.0",
    ]);
    const releases = await appReleasesFor(h.deps, owner, app.id, "release", 1);
    expect(releases.map((r) => r.version)).toStrictEqual(["1.4.1"]);
  });

  it("hides another owner's app", async () => {
    const app = await seedActiveApp(h);
    await expect(
      appReleasesFor(h.deps, stranger, app.id, null, null),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });
});
