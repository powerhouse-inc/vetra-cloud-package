import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Harness } from "./harness.js";
import { seedLicence } from "./instances-fixtures.js";
import { seedTeamPlan, teamHarness, teamRow } from "./team-fixtures.js";
import { syncPlanInstances, PLAN_RETIRED } from "../plans/sync.js";
import { TEAM_NOT_ORG } from "../plans/team-base.js";
import { adminsOf } from "../instances/reconciler.js";
import { getApp } from "../repo.js";
import { updatePlan } from "../plans/repo.js";

let h: Harness;
let appId: string;
beforeEach(async () => {
  ({ h, appId } = await teamHarness());
});
afterEach(async () => {
  await h.close();
});
const sync = async () =>
  syncPlanInstances(h.deps, (await getApp(h.db, appId))!);

describe("Team plan instances", () => {
  it("one shared row named team; an untyped live licence never keeps a retired Team plan held", async () => {
    await seedTeamPlan(h, appId);
    await seedLicence(h, {
      appId,
      kind: null,
      holder: "0x1111111111111111111111111111111111111111",
      licenseId: "l1",
    });
    await sync();
    const row = await teamRow(h, appId);
    expect(row).toMatchObject({
      kind: "shared",
      name: "team",
      target_version: "1.0.0",
      stop_reason: null,
    });
    await updatePlan(
      h.db,
      "p-team",
      { status: "retired" },
      "2026-10-02T00:00:00.000Z",
    );
    await sync();
    expect((await teamRow(h, appId))?.stop_reason).toBe(PLAN_RETIRED);
  });

  it("is stopped while the App is no organisation's, and wanted again once it is", async () => {
    await seedTeamPlan(h, appId);
    await sync();
    const orgId = (await getApp(h.db, appId))!.owner_org_id;
    await h.db
      .updateTable("apps")
      .set({ owner_org_id: null })
      .where("id", "=", appId)
      .execute();
    await sync();
    expect((await teamRow(h, appId))?.stop_reason).toBe(TEAM_NOT_ORG);
    await h.db
      .updateTable("apps")
      .set({ org_disputed: true, owner_org_id: orgId })
      .where("id", "=", appId)
      .execute();
    await sync();
    expect((await teamRow(h, appId))?.stop_reason).toBe(TEAM_NOT_ORG);
    await h.db
      .updateTable("apps")
      .set({ org_disputed: false })
      .where("id", "=", appId)
      .execute();
    await sync();
    expect((await teamRow(h, appId))?.stop_reason).toBeNull();
  });

  it("adminsOf: a Team row has the valid override or no admins, never the owner", async () => {
    await seedTeamPlan(h, appId);
    await sync();
    const app = (await getApp(h.db, appId))!;
    const row = (await teamRow(h, appId))!;
    const now = h.deps.now();
    const iso = (ms: number) => new Date(now.getTime() - ms).toISOString();
    const own = adminsOf(app, row);
    expect(own).toBe(app.owner_address);
    const t = { team: true, now };
    expect(adminsOf(app, row, t)).toBe("");
    const set = {
      ...row,
      admins_override: "0xa1,0xb2",
      admins_override_org: app.owner_org_id,
      admins_checked_at: iso(0),
    };
    expect(adminsOf(app, set, t)).toBe("0xa1,0xb2");
    // Read for another organisation: ignored.
    expect(adminsOf(app, { ...set, admins_override_org: "org-x" }, t)).toBe("");
    expect(adminsOf(app, { ...set, admins_override_org: null }, t)).toBe("");
    // Renown down: trusted for an hour past the last check, then none.
    expect(
      adminsOf(app, { ...set, admins_checked_at: iso(59 * 60_000) }, t),
    ).toBe("0xa1,0xb2");
    expect(
      adminsOf(app, { ...set, admins_checked_at: iso(61 * 60_000) }, t),
    ).toBe("");
    expect(adminsOf(app, { ...set, admins_checked_at: null }, t)).toBe("");
    // Not an org App: none.
    expect(adminsOf({ ...app, owner_org_id: null }, set, t)).toBe("");
  });
});
