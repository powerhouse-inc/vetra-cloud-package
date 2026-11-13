import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { owner, OWNER, type Harness } from "./harness.js";
import { digest, seedRelease } from "./instances-fixtures.js";
import { seedTeamPlan, teamHarness } from "./team-fixtures.js";
import { checkRolloutFor } from "../rollouts/service.js";
import { advanceRollouts } from "../rollouts/runner.js";
import { listRollouts } from "../rollouts/repo.js";
import { isPatchOf } from "../rollouts/check.js";
import { getApp } from "../repo.js";
import { getPlan, insertPlan, updatePlan } from "../plans/repo.js";

let h: Harness;
let appId: string;
const customer = (id: string, slug: string, target: string) =>
  insertPlan(h.db, {
    id,
    app_id: appId,
    slug,
    name: slug,
    kind: slug,
    access: "own",
    size: "VETRA_AGENT_S",
    target_version: target,
    policy: "manual",
    notice_hours: 72,
    status: "active",
    created_by: OWNER,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
  });
const problems = async (version: string, planIds: string[]) =>
  (await checkRolloutFor(h.deps, owner, appId, version, planIds)).problems;
const ran = (version: string) =>
  h.db
    .insertInto("team_release_runs")
    .values({
      app_id: appId,
      version,
      digest: "d",
      instance_id: "i",
      healthy_since: "t",
      recorded_at: "t",
    })
    .execute();

beforeEach(async () => {
  ({ h, appId } = await teamHarness());
  await seedRelease(h, appId, {
    version: "1.0.1",
    run: 102,
    kind: "release",
    digest: digest("c"),
  });
  await seedRelease(h, appId, {
    version: "2.0.0",
    run: 103,
    kind: "release",
    digest: digest("e"),
  });
  await customer("p-pro", "pro", "1.0.0");
});
afterEach(async () => {
  await h.close();
});

describe("the Team gate on customer rollouts", () => {
  it("no Team plan, or a disabled one: no gate", async () => {
    expect((await problems("1.1.0", ["p-pro"])).join()).not.toMatch(/Team/);
    await seedTeamPlan(h, appId, { status: "retired" });
    expect((await problems("1.1.0", ["p-pro"])).join()).not.toMatch(/Team/);
  });

  it("refuses a release Team never ran, with the reason; passes once it ran", async () => {
    await seedTeamPlan(h, appId);
    expect((await problems("1.1.0", ["p-pro"])).join()).toMatch(
      /1\.1\.0 has not run healthy on Team yet/,
    );
    await ran("1.1.0");
    expect((await problems("1.1.0", ["p-pro"])).join()).not.toMatch(/Team/);
  });

  it("Team itself is exempt; Team with customers is refused; stable patches pass (T5)", async () => {
    await seedTeamPlan(h, appId);
    expect((await problems("2.0.0", ["p-team"])).join()).not.toMatch(/Team/);
    expect((await problems("2.0.0", ["p-team", "p-pro"])).join()).toMatch(
      /Team on its own first/,
    );
    expect((await problems("1.0.1", ["p-pro"])).join()).not.toMatch(/Team/);
    await updatePlan(
      h.db,
      "p-pro",
      { target_version: "1.1.0" },
      "2026-10-02T00:00:00.000Z",
    );
    expect((await problems("2.0.0", ["p-pro"])).join()).toMatch(
      /has not run healthy on Team/,
    );
  });

  it("isPatchOf", () => {
    expect(isPatchOf("1.4.1", "1.4.0")).toBe(true);
    expect(isPatchOf("1.5.0", "1.4.0")).toBe(false);
    expect(isPatchOf("1.4.1-rc.1", "1.4.0")).toBe(false);
    expect(isPatchOf("1.4.0", "1.4.0")).toBe(false);
    expect(isPatchOf("1.4.1", null)).toBe(false);
  });

  it("a minor customer policy is refused (noted once) until Team ran the release, then starts by itself", async () => {
    await seedTeamPlan(h, appId);
    await updatePlan(
      h.db,
      "p-pro",
      { policy: "minor" },
      "2026-10-02T00:00:00.000Z",
    );
    await advanceRollouts(h.deps, (await getApp(h.db, appId))!);
    expect((await getPlan(h.db, "p-pro"))?.policy_note).toMatch(
      /has not run healthy on Team/,
    );
    await ran("1.1.0");
    await advanceRollouts(h.deps, (await getApp(h.db, appId))!);
    expect(
      (await listRollouts(h.db, appId, 10)).map((r) => r.version),
    ).toContain("1.1.0");
  });
});
