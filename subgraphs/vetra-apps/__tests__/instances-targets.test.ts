import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHarness, seedActiveApp, type Harness } from "./harness.js";
import { digest, seedRelease } from "./instances-fixtures.js";
import { getApp } from "../repo.js";
import { branchTargets, targetOf } from "../instances/targets.js";

let h: Harness;
let appId: string;
beforeEach(async () => {
  h = await makeHarness();
  appId = (await seedActiveApp(h)).id;
  await h.db
    .updateTable("apps")
    .set({ release_branches: JSON.stringify(["next", "*.x"]) })
    .where("id", "=", appId)
    .execute();
});
afterEach(async () => {
  await h.close();
});
const app = async () => (await getApp(h.db, appId))!;

describe("branchTargets", () => {
  it("picks the highest run per release branch, builds and releases alike", async () => {
    await seedRelease(h, appId, { version: "1.5.0-main.1", run: 100 });
    await seedRelease(h, appId, {
      version: "1.5.0",
      run: 300,
      kind: "release",
      digest: digest("b"),
    });
    // Arrived last but ran earlier: not the newest (spec 14.17).
    await seedRelease(h, appId, { version: "1.5.0-main.2", run: 200 });
    await seedRelease(h, appId, {
      version: "2.0.0-beta.0-next.1",
      run: 150,
      branch: "next",
    });
    await seedRelease(h, appId, {
      version: "1.4.1",
      run: 120,
      branch: "1.x",
      kind: "release",
    });
    const t = await branchTargets(h.db, await app());
    expect([...t.keys()].sort()).toEqual(["1.x", "main", "next"]);
    expect(t.get("main")!.version).toBe("1.5.0");
    expect(t.get("next")!.version).toBe("2.0.0-beta.0-next.1");
  });

  it("ignores PR builds and branches that are not release branches", async () => {
    await seedRelease(h, appId, { version: "1.5.0-pr.4.1", run: 500, pr: 4 });
    await seedRelease(h, appId, {
      version: "1.5.0-feat-x.1",
      run: 501,
      branch: "feat/x",
    });
    expect((await branchTargets(h.db, await app())).size).toBe(0);
  });

  it("follows a changed production branch", async () => {
    await seedRelease(h, appId, {
      version: "1.0.0-trunk.1",
      run: 10,
      branch: "trunk",
    });
    await h.db
      .updateTable("apps")
      .set({ production_branch: "trunk" })
      .where("id", "=", appId)
      .execute();
    expect([...(await branchTargets(h.db, await app())).keys()]).toEqual([
      "trunk",
    ]);
  });
});

describe("targetOf", () => {
  it("pins the digest and strips the tag from the image ref", async () => {
    const r = await seedRelease(h, appId, {
      version: "1.5.0-main.1",
      run: 100,
    });
    expect(targetOf(r)).toEqual({
      target_version: "1.5.0-main.1",
      target_digest: digest("a"),
      target_repository: `cr.vetra.io/acme/${(await app()).slug}`,
      target_ph_host: "cli",
      target_run: 100,
    });
  });
});
