import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ORG, owner, stranger, STRANGER, type Harness } from "./harness.js";
import { seedTeamPlan, teamHarness } from "./team-fixtures.js";
import { createPlan } from "../plans/service.js";
import { setAppRole } from "../roles/service.js";

let h: Harness;
let appId: string;
beforeEach(async () => {
  ({ h, appId } = await teamHarness());
  h.orgs.join(ORG, STRANGER, "MEMBER");
  await setAppRole(h.deps, owner, appId, STRANGER, null);
});
afterEach(async () => {
  await h.close();
});
const create = (targetVersion: string) =>
  createPlan(h.deps, stranger, {
    appId,
    kind: "pro",
    access: "own",
    targetVersion,
  });
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

describe("createPlan with a target on an App with a Team plan", () => {
  it("a release manager cannot create a customer plan on a release that never ran on Team", async () => {
    await seedTeamPlan(h, appId);
    await expect(create("1.1.0")).rejects.toThrow(
      /1\.1\.0 has not run healthy on Team yet/,
    );
  });

  it("creates it once Team ran the release", async () => {
    await seedTeamPlan(h, appId);
    await ran("1.1.0");
    expect((await create("1.1.0")).targetVersion).toBe("1.1.0");
  });

  it("no Team plan: no gate", async () => {
    expect((await create("1.1.0")).targetVersion).toBe("1.1.0");
  });
});
