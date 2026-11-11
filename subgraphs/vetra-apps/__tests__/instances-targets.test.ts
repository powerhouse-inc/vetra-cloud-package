import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHarness, seedActiveApp, type Harness } from "./harness.js";
import { digest, seedRelease } from "./instances-fixtures.js";
import { getApp } from "../repo.js";
import {
  branchTargets,
  pickPreviews,
  previewCandidates,
  targetOf,
} from "../instances/targets.js";

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
  it("picks the newest record of a re-run (equal run ids)", async () => {
    // Inserted newest first, so storage order alone would pick the older one.
    for (const [version, created, c] of [
      ["1.5.0-main.3", "2026-11-11T03:00:00.000Z", "c"],
      ["1.5.0-main.1", "2026-11-11T01:00:00.000Z", "a"],
      ["1.5.0-main.2", "2026-11-11T02:00:00.000Z", "b"],
    ] as const) {
      await seedRelease(h, appId, { version, run: 100, digest: digest(c) });
      await h.db
        .updateTable("releases")
        .set({ created_at: created })
        .where("version", "=", version)
        .execute();
    }
    const t = await branchTargets(h.db, await app());
    expect(t.get("main")!.version).toBe("1.5.0-main.3");
  });

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

describe("previewCandidates", () => {
  const SINCE = "2026-11-04T00:00:00.000Z";

  it("takes each PR's newest build by run, never a branch build, newest PR first", async () => {
    await seedRelease(h, appId, { version: "1.5.0-pr.12.1", run: 100, pr: 12 });
    await seedRelease(h, appId, {
      version: "1.5.0-pr.12.3",
      run: 300,
      pr: 12,
      digest: digest("c"),
    });
    // Arrives last, but an older run: not the target (spec 14.17).
    await seedRelease(h, appId, {
      version: "1.5.0-pr.12.2",
      run: 200,
      pr: 12,
      digest: digest("b"),
    });
    await seedRelease(h, appId, { version: "1.5.0-pr.13.1", run: 250, pr: 13 });
    await seedRelease(h, appId, { version: "1.5.0-main.9", run: 999 });
    const c = await previewCandidates(h.db, appId, SINCE);
    expect(c.map((r) => [r.pr, r.version])).toEqual([
      [12, "1.5.0-pr.12.3"],
      [13, "1.5.0-pr.13.1"],
    ]);
    expect(typeof c[0].run).toBe("number");
  });

  it("leaves out a PR whose last build is older than the TTL", async () => {
    await seedRelease(h, appId, {
      version: "1.5.0-pr.12.1",
      run: 100,
      pr: 12,
      createdAt: "2026-11-01T00:00:00.000Z",
    });
    await seedRelease(h, appId, {
      version: "1.5.0-pr.13.1",
      run: 90,
      pr: 13,
      createdAt: "2026-11-01T00:00:00.000Z",
    });
    await seedRelease(h, appId, {
      version: "1.5.0-pr.13.2",
      run: 95,
      pr: 13,
      createdAt: "2026-11-05T00:00:00.000Z",
    });
    const c = await previewCandidates(h.db, appId, SINCE);
    expect(c.map((r) => r.version)).toEqual(["1.5.0-pr.13.2"]);
  });
});

describe("pickPreviews", () => {
  const r = (pr: number, run: number) =>
    ({ pr, run, version: `1.0.0-pr.${pr}.1` }) as never;

  it("keeps the newest PRs up to the limit, skipping excluded ones", () => {
    const picked = pickPreviews(
      [r(5, 500), r(4, 400), r(3, 300), r(2, 200)],
      new Set([4]),
      2,
    );
    expect([...picked.keys()]).toEqual([5, 3]);
  });

  it("keeps none at limit 0", () => {
    expect(pickPreviews([r(5, 500)], new Set(), 0).size).toBe(0);
  });
});
