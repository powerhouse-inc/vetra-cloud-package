import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { owner, stranger, type Harness } from "./harness.js";
import {
  code,
  readyInstance,
  rolloutHarness,
  seedPlan,
} from "./rollouts-fixtures.js";
import { seedRelease } from "./instances-fixtures.js";
import { listAudit } from "../audit/repo.js";
import { withdrawRelease } from "../releases/withdraw.js";
import { checkRolloutFor } from "../rollouts/service.js";

let h: Harness;
let appId: string;
beforeEach(async () => {
  ({ h, appId } = await rolloutHarness());
  await seedPlan(h, appId, {
    id: "p-pro",
    slug: "pro",
    access: "own",
    target_version: "1.4.1",
  });
  await readyInstance(h, appId, {
    id: "o1",
    planId: "p-pro",
    kind: "own",
    version: "1.4.1",
  });
});
afterEach(async () => {
  await h.close();
});

describe("withdrawing a release (spec 14.3)", () => {
  it("withdraws once, audited; a withdrawn release cannot be rolled out", async () => {
    const w = await withdrawRelease(
      h.deps,
      owner,
      appId,
      "1.5.0",
      "breaks exports",
    );
    expect(w.withdrawn).toMatchObject({
      by: owner.address,
      reason: "breaks exports",
    });
    expect(
      (await withdrawRelease(h.deps, owner, appId, "1.5.0", null)).withdrawn
        ?.at,
    ).toBe(w.withdrawn?.at);
    expect(
      (await listAudit(h.db, appId, { limit: 10 })).filter(
        (a) => a.action === "release.withdrawn",
      ),
    ).toHaveLength(1);
    expect(
      (await checkRolloutFor(h.deps, owner, appId, "1.5.0", ["p-pro"]))
        .problems,
    ).toEqual(["1.5.0 was withdrawn"]);
  });

  it("refuses a release a plan targets or an instance is pinned to, builds, and strangers", async () => {
    await expect(
      withdrawRelease(h.deps, owner, appId, "1.4.1", null),
    ).rejects.toThrow(/pro targets 1.4.1/);
    await h.db
      .updateTable("instances")
      .set({ pinned_version: "2.0.0" })
      .where("id", "=", "o1")
      .execute();
    await expect(
      withdrawRelease(h.deps, owner, appId, "2.0.0", null),
    ).rejects.toThrow(/own-o1 is pinned/);
    await seedRelease(h, appId, { version: "1.6.0-main.4", run: 140 });
    await expect(
      withdrawRelease(h.deps, owner, appId, "1.6.0-main.4", null),
    ).rejects.toThrow(/build/);
    await expect(
      withdrawRelease(h.deps, stranger, appId, "1.5.0", null),
    ).rejects.toMatchObject(code("FORBIDDEN"));
    await expect(
      withdrawRelease(h.deps, owner, appId, "9.9.9", null),
    ).rejects.toMatchObject(code("NOT_FOUND"));
  });
});
