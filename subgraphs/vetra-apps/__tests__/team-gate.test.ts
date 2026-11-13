import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeVault, type Harness } from "./harness.js";
import { seedLicence } from "./instances-fixtures.js";
import {
  ORG_ADMIN_A,
  ORG_MEMBER,
  seedTeamPlan,
  teamHarness,
  teamRow,
} from "./team-fixtures.js";
import { plan } from "./gate-fixtures.js";
import { checkGate } from "../gate/check.js";
import { createGateRoutes } from "../gate/routes.js";
import { ensureGateToken } from "../gate/service.js";
import { teamGateAnswer } from "../plans/team-gate.js";
import { syncPlanInstances } from "../plans/sync.js";
import { getApp } from "../repo.js";

const STRANGER_ADDR = "0x3333333333333333333333333333333333333333";
let h: Harness;
let appId: string;
let token: string;

beforeEach(async () => {
  ({ h, appId } = await teamHarness({ gate: true }));
  await seedTeamPlan(h, appId);
  await plan(h, appId, { id: "plan-other", slug: "starter", kind: "starter" });
  await syncPlanInstances(h.deps, (await getApp(h.db, appId))!);
  const row = (await teamRow(h, appId))!;
  await h.db
    .updateTable("instances")
    .set({ admins_override: ORG_ADMIN_A })
    .where("id", "=", row.id)
    .execute();
  token = await fakeVault().decrypt(
    (await ensureGateToken(h.deps, row)).token_ciphertext,
  );
});
afterEach(async () => {
  await h.close();
});
const check = async (address: string) =>
  (await checkGate(h.deps, token, address))?.answer;

describe("the gate on the Team instance", () => {
  it("admits the organisation's members, ADMINS first, and nobody else", async () => {
    expect(await check(ORG_MEMBER)).toEqual({
      allowed: true,
      reason: "member",
      until: null,
      ttlSeconds: 60,
    });
    expect((await check(ORG_ADMIN_A))?.reason).toBe("admin");
    expect(await check(STRANGER_ADDR)).toEqual({
      allowed: false,
      reason: "none",
      until: null,
      ttlSeconds: 15,
    });
  });

  it("a licence of another plan's kind does not open Team", async () => {
    await seedLicence(h, {
      appId,
      kind: "starter",
      holder: STRANGER_ADDR,
      licenseId: "l1",
    });
    expect((await check(STRANGER_ADDR))?.reason).toBe("none");
  });

  it("a Renown outage throws, and the route answers 503", async () => {
    h.orgs.down = true;
    await expect(check(ORG_MEMBER)).rejects.toThrow();
    const res = await createGateRoutes(h.deps).check(
      new Request("https://x/apps/gate/check", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ address: ORG_MEMBER }),
      }),
    );
    expect(res.status).toBe(503);
  });

  it("an App that left its organisation admits nobody but ADMINS", async () => {
    await h.db
      .updateTable("apps")
      .set({ owner_org_id: null })
      .where("id", "=", appId)
      .execute();
    expect((await check(ORG_MEMBER))?.reason).toBe("none");
    expect((await check(ORG_ADMIN_A))?.reason).toBe("admin");
  });

  it("teamGateAnswer alone", async () => {
    const app = (await getApp(h.db, appId))!;
    expect(
      await teamGateAnswer(
        h.deps,
        app,
        ORG_MEMBER.toUpperCase().replace("0X", "0x"),
      ),
    ).toEqual({
      allowed: true,
      reason: "member",
    });
    expect(await teamGateAnswer(h.deps, app, STRANGER_ADDR)).toEqual({
      allowed: false,
      reason: "none",
    });
    expect(
      await teamGateAnswer(h.deps, { ...app, org_disputed: true }, ORG_MEMBER),
    ).toEqual({ allowed: false, reason: "none" });
    h.orgs.down = true;
    await expect(teamGateAnswer(h.deps, app, STRANGER_ADDR)).rejects.toThrow();
  });
});
