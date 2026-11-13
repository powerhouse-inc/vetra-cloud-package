import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ORG, type Harness } from "./harness.js";
import { digest } from "./instances-fixtures.js";
import {
  ORG_ADMIN_A,
  ORG_ADMIN_B,
  seedTeamPlan,
  teamHarness,
  teamRow,
} from "./team-fixtures.js";
import { syncPlanInstances } from "../plans/sync.js";
import { syncTeamPlan } from "../plans/team.js";
import { qualifiesAsRun, teamRunOf } from "../plans/team-runs.js";
import { getPlan } from "../plans/repo.js";
import { updateInstance } from "../instances/repo.js";
import { listAudit } from "../audit/repo.js";
import { getApp } from "../repo.js";

let h: Harness;
let appId: string;
beforeEach(async () => {
  ({ h, appId } = await teamHarness());
});
afterEach(async () => {
  await h.close();
});
const pass = async () => {
  const app = (await getApp(h.db, appId))!;
  await syncPlanInstances(h.deps, app);
  await syncTeamPlan(h.deps, app);
};
const MIN = 60_000;

describe("syncTeamPlan", () => {
  it("gives a new Team plan the newest release of its branch, as Vetra", async () => {
    await seedTeamPlan(h, appId, { target_version: null });
    await pass();
    expect((await getPlan(h.db, "p-team"))?.target_version).toBe("1.1.0");
    const started = (await listAudit(h.db, appId, { limit: 20 })).find(
      (a) => a.action === "rollout.started",
    );
    expect(started).toMatchObject({ actor: "vetra", source: "policy" });
  });

  it("sets ADMINS to the org's public admins, at most every 15 minutes, only on change; falls back to the owner", async () => {
    await seedTeamPlan(h, appId);
    h.orgs.admins.set(ORG, [ORG_ADMIN_B, ORG_ADMIN_A].sort());
    await pass();
    expect((await teamRow(h, appId))?.admins_override).toBe(
      [ORG_ADMIN_A, ORG_ADMIN_B].sort().join(","),
    );
    h.orgs.admins.set(ORG, [ORG_ADMIN_A]);
    await pass(); // within 15 minutes: not asked
    expect((await teamRow(h, appId))?.admins_override).toContain(ORG_ADMIN_B);
    h.advance(16 * MIN);
    await pass();
    expect((await teamRow(h, appId))?.admins_override).toBe(ORG_ADMIN_A);
    h.orgs.down = true;
    h.advance(16 * MIN);
    await pass(); // Renown down: kept
    expect((await teamRow(h, appId))?.admins_override).toBe(ORG_ADMIN_A);
    h.orgs.down = false;
    h.orgs.admins.set(ORG, null); // members private
    h.advance(16 * MIN);
    await pass();
    expect((await teamRow(h, appId))?.admins_override ?? null).toBeNull();
    const set = (await listAudit(h.db, appId, { limit: 50 })).filter(
      (a) => a.action === "instance.admins_set",
    );
    expect(set).toHaveLength(3);
  });

  it("records a release as ran healthy after the soak, once, audited", async () => {
    await seedTeamPlan(h, appId);
    await pass();
    const row = (await teamRow(h, appId))!;
    const nowIso = h.deps.now().toISOString();
    await updateInstance(
      h.db,
      row.id,
      {
        status: "ready",
        running_version: "1.0.0",
        running_digest: digest("a"),
        health: "healthy",
        health_digest: digest("a"),
        health_since: nowIso,
      },
      nowIso,
    );
    h.advance(29 * MIN);
    await pass();
    expect(await teamRunOf(h.db, appId, "1.0.0")).toBeNull();
    h.advance(2 * MIN);
    await pass();
    await pass();
    expect(await teamRunOf(h.db, appId, "1.0.0")).toMatchObject({
      digest: digest("a"),
      instance_id: row.id,
    });
    const ran = (await listAudit(h.db, appId, { limit: 50 })).filter(
      (a) => a.action === "team.ran_healthy",
    );
    expect(ran).toHaveLength(1);
    expect(ran[0]).toMatchObject({
      subject: "release:1.0.0",
      actor: "vetra",
      source: "system",
    });
  });

  it("qualifiesAsRun: healthy on the running digest for the soak; never on a bad date", () => {
    const now = new Date("2026-11-12T12:00:00.000Z");
    const base = {
      status: "ready",
      health: "healthy",
      running_version: "1.0.0",
      running_digest: "d",
      health_digest: "d",
      health_since: "2026-11-12T11:00:00.000Z",
    } as never;
    expect(qualifiesAsRun(base, 30 * MIN, now)).toBe(true);
    expect(
      qualifiesAsRun(
        { ...(base as object), health_digest: "e" } as never,
        30 * MIN,
        now,
      ),
    ).toBe(false);
    expect(
      qualifiesAsRun(
        { ...(base as object), health: "unknown" } as never,
        30 * MIN,
        now,
      ),
    ).toBe(false);
    expect(
      qualifiesAsRun(
        { ...(base as object), health_since: "soon" } as never,
        0,
        now,
      ),
    ).toBe(false);
    expect(qualifiesAsRun(base, 90 * MIN, now)).toBe(false);
  });
});
