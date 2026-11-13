import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MEMBER, OWNER, type Harness } from "./harness.js";
import { ORG_ADMIN_A, teamHarness } from "./team-fixtures.js";
import { createResolvers } from "../resolvers.js";
import { listAudit } from "../audit/repo.js";

let h: Harness;
let appId: string;
beforeEach(async () => {
  ({ h, appId } = await teamHarness());
});
afterEach(async () => {
  await h.close();
});
const ctx = (address: string, headers: Record<string, string> = {}) => ({
  user: { address, chainId: 1, networkId: "eip155" },
  headers,
});

describe("the Team plan over GraphQL", () => {
  it("an org admin enables it; plans and releases show it", async () => {
    const r = createResolvers(h.deps);
    const plan = await r.Mutation.enableTeamPlan(
      null,
      { appId, followBranch: null },
      ctx(ORG_ADMIN_A, { origin: "https://vetra.io" }),
    );
    expect(plan).toMatchObject({
      team: true,
      kind: null,
      policy: "follow:main",
    });
    const plans = await r.Query.appPlans(null, { appId }, ctx(OWNER));
    expect(plans.map((p: { team: boolean }) => p.team)).toEqual([true]);
    await h.db
      .insertInto("team_release_runs")
      .values({
        app_id: appId,
        version: "1.0.0",
        digest: "d",
        instance_id: "i",
        healthy_since: "t",
        recorded_at: "2026-11-12T00:00:00.000Z",
      })
      .execute();
    const rels = await r.Query.appReleases(
      null,
      { appId, kind: "release", limit: 10 },
      ctx(OWNER),
    );
    expect(
      Object.fromEntries(
        rels.map((x: { version: string; teamHealthyAt: string | null }) => [
          x.version,
          x.teamHealthyAt,
        ]),
      ),
    ).toEqual({ "1.0.0": "2026-11-12T00:00:00.000Z", "1.1.0": null });
    const audit = (await listAudit(h.db, appId, { limit: 5 })).find(
      (a) => a.action === "plan.team_enabled",
    );
    expect(audit?.source).toBe("console");
  });

  it("a plain member cannot disable it", async () => {
    const r = createResolvers(h.deps);
    await r.Mutation.enableTeamPlan(null, { appId }, ctx(OWNER));
    await expect(
      r.Mutation.disableTeamPlan(null, { appId }, ctx(MEMBER)),
    ).rejects.toMatchObject({
      extensions: expect.objectContaining({ code: "FORBIDDEN" }),
    });
    const off = await r.Mutation.disableTeamPlan(null, { appId }, ctx(OWNER));
    expect(off.status).toBe("retired");
  });
});
