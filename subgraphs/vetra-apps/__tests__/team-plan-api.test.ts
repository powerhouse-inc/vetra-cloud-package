import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  APP_DID,
  member,
  owner,
  OWNER,
  stranger,
  type Harness,
} from "./harness.js";
import type { Caller } from "../auth.js";
import { ORG_ADMIN_A, teamHarness } from "./team-fixtures.js";
import { disableTeamPlan, enableTeamPlan } from "../plans/team.js";
import { createPlan, retirePlan, updatePlanFor } from "../plans/service.js";
import { digest, seedRelease } from "./instances-fixtures.js";
import { listAudit } from "../audit/repo.js";
import { setAppRole } from "../roles/service.js";

let h: Harness;
let appId: string;
beforeEach(async () => {
  ({ h, appId } = await teamHarness());
});
afterEach(async () => {
  await h.close();
});
const orgAdmin: Caller = { ...member, address: ORG_ADMIN_A };

describe("enableTeamPlan / disableTeamPlan", () => {
  it("one click makes a kind-less shared plan following the production branch; idempotent; audited", async () => {
    const p = await enableTeamPlan(h.deps, orgAdmin, appId);
    expect(p).toMatchObject({
      slug: "team",
      name: "Team",
      kind: null,
      team: true,
      access: "shared",
      policy: "follow:main",
      noticeHours: 0,
      targetVersion: null,
      status: "active",
    });
    expect((await enableTeamPlan(h.deps, owner, appId)).id).toBe(p.id);
    const rows = (await listAudit(h.db, appId, { limit: 10 })).filter(
      (a) => a.action === "plan.team_enabled",
    );
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].detail)).toMatchObject({ branch: "main" });
  });

  it("refuses members, release managers, strangers, personal Apps and non-release branches", async () => {
    await expect(enableTeamPlan(h.deps, member, appId)).rejects.toThrow(
      /Not allowed/,
    );
    await expect(enableTeamPlan(h.deps, stranger, appId)).rejects.toThrow();
    await setAppRole(h.deps, owner, appId, member.address);
    await expect(enableTeamPlan(h.deps, member, appId)).rejects.toThrow(
      /Not allowed/,
    );
    await expect(
      enableTeamPlan(h.deps, owner, appId, "feature-x"),
    ).rejects.toThrow(/release branch/);
    h.orgs.publishers.set(APP_DID, { orgId: null, address: OWNER });
    await h.db
      .updateTable("apps")
      .set({ owner_org_id: null })
      .where("id", "=", appId)
      .execute();
    await expect(enableTeamPlan(h.deps, owner, appId)).rejects.toThrow(
      /organisation Apps/,
    );
  });

  it("disable retires it (audited); enable revives the same row on a new branch; retirePlan and policy edits refuse Team", async () => {
    await h.db
      .updateTable("apps")
      .set({ release_branches: '["next"]' })
      .where("id", "=", appId)
      .execute();
    await seedRelease(h, appId, {
      version: "1.2.0",
      run: 110,
      kind: "release",
      branch: "next",
      digest: digest("f"),
    });
    const p = await enableTeamPlan(h.deps, owner, appId);
    await expect(retirePlan(h.deps, owner, p.id)).rejects.toThrow(
      /Disable the Team plan/,
    );
    await expect(
      updatePlanFor(h.deps, owner, { planId: p.id, policy: "manual" }),
    ).rejects.toThrow(/follows its branch/);
    expect((await disableTeamPlan(h.deps, orgAdmin, appId)).status).toBe(
      "retired",
    );
    const back = await enableTeamPlan(h.deps, owner, appId, "next");
    expect(back).toMatchObject({
      id: p.id,
      status: "active",
      policy: "follow:next",
    });
    const actions = (await listAudit(h.db, appId, { limit: 10 })).map(
      (a) => a.action,
    );
    expect(actions.filter((a) => a === "plan.team_disabled")).toHaveLength(1);
    expect(actions.filter((a) => a === "plan.team_enabled")).toHaveLength(2);
  });

  it("refuses a follow branch with no release yet", async () => {
    await h.db
      .updateTable("apps")
      .set({ release_branches: '["next"]' })
      .where("id", "=", appId)
      .execute();
    await expect(enableTeamPlan(h.deps, owner, appId, "next")).rejects.toThrow(
      /next has no release yet/,
    );
    expect(await h.db.selectFrom("plans").selectAll().execute()).toHaveLength(
      0,
    );
  });

  it("createPlan still refuses the slug team", async () => {
    await expect(
      createPlan(h.deps, owner, {
        appId,
        kind: "team",
        access: "shared",
      } as never),
    ).rejects.toThrow(/reserved/);
  });
});
