import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  admin,
  APP_DID,
  makeHarness,
  member,
  MEMBER,
  ORG,
  owner,
  seedActiveApp,
  stranger,
  STRANGER,
  testConfig,
  type Harness,
} from "./harness.js";
import { seedRelease } from "./instances-fixtures.js";
import { appForOwner } from "../service.js";
import { listAudit } from "../audit/repo.js";
import { setAppRole } from "../roles/service.js";
import {
  appPlansFor,
  createPlan,
  retirePlan,
  setPlanTarget,
  updatePlanFor,
} from "../plans/service.js";

let h: Harness;
let appId: string;
beforeEach(async () => {
  h = await makeHarness(
    testConfig({ plans: { enabled: true, stopAfterDays: 14 } }),
  );
  appId = (await seedActiveApp(h)).id;
  await seedRelease(h, appId, { version: "1.4.0", run: 100, kind: "release" });
  await seedRelease(h, appId, { version: "1.5.0", run: 101, kind: "release" });
});
afterEach(async () => {
  await h.close();
});

const code = (c: string) => ({
  extensions: expect.objectContaining({ code: c }),
});
const planRows = async (planId: string) =>
  (await listAudit(h.db, appId, { limit: 50 }))
    .filter((r) => r.subject === `plan:${planId}`)
    .reverse();

describe("plans: release managers and the audit log", () => {
  it("a release manager creates, retargets, renames and retires a plan; each change is audited once", async () => {
    await setAppRole(h.deps, owner, appId, STRANGER, null);
    const p = await createPlan(h.deps, stranger, {
      appId,
      kind: "pro",
      access: "own",
      targetVersion: "1.4.0",
    });
    await setPlanTarget(h.deps, stranger, p.id, "1.5.0");
    await setPlanTarget(h.deps, stranger, p.id, "1.5.0");
    await updatePlanFor(h.deps, stranger, { planId: p.id, name: "Pro+" });
    await updatePlanFor(h.deps, stranger, { planId: p.id, name: "Pro+" });
    await retirePlan(h.deps, stranger, p.id);
    await retirePlan(h.deps, stranger, p.id);
    expect(
      (await appPlansFor(h.deps, stranger, appId)).map((x) => x.status),
    ).toEqual(["retired"]);
    const rows = await planRows(p.id);
    expect(rows.map((r) => [r.action, r.actor, r.source])).toEqual([
      ["plan.created", STRANGER, "api"],
      ["plan.target_set", STRANGER, "api"],
      ["plan.updated", STRANGER, "api"],
      ["plan.retired", STRANGER, "api"],
    ]);
    expect(JSON.parse(rows[0].detail)).toEqual({
      slug: "pro",
      name: "pro",
      kind: "pro",
      access: "own",
      size: "VETRA_AGENT_S",
      targetVersion: "1.4.0",
    });
    expect(JSON.parse(rows[1].detail)).toEqual({
      slug: "pro",
      from: "1.4.0",
      to: "1.5.0",
    });
    expect(JSON.parse(rows[2].detail)).toEqual({
      slug: "pro",
      changes: { name: { from: "pro", to: "Pro+" } },
    });
    expect(JSON.parse(rows[3].detail)).toEqual({ slug: "pro" });
  });

  it("records the console as the source when the caller came from it", async () => {
    const p = await createPlan(
      h.deps,
      { ...owner, source: "console" },
      {
        appId,
        kind: "pro",
        access: "shared",
      },
    );
    expect((await planRows(p.id)).map((r) => r.source)).toEqual(["console"]);
  });

  it("refuses a signed-in address without the role, and audits nothing", async () => {
    await expect(
      createPlan(h.deps, stranger, { appId, kind: "pro", access: "own" }),
    ).rejects.toMatchObject(code("FORBIDDEN"));
    const p = await createPlan(h.deps, owner, {
      appId,
      kind: "pro",
      access: "own",
    });
    await expect(
      setPlanTarget(h.deps, stranger, p.id, "1.4.0"),
    ).rejects.toMatchObject(code("FORBIDDEN"));
    await expect(retirePlan(h.deps, stranger, p.id)).rejects.toMatchObject(
      code("FORBIDDEN"),
    );
    expect((await planRows(p.id)).map((r) => r.action)).toEqual([
      "plan.created",
    ]);
  });

  it("an org App: a plain member is refused until an org admin names them", async () => {
    h.orgs.publishers.set(APP_DID, { orgId: ORG, address: null });
    await appForOwner(h.deps, admin, appId);
    h.orgs.join(ORG, MEMBER, "MEMBER");
    await expect(
      createPlan(h.deps, member, { appId, kind: "pro", access: "own" }),
    ).rejects.toMatchObject(code("FORBIDDEN"));
    await setAppRole(h.deps, admin, appId, MEMBER, null);
    expect(
      (await createPlan(h.deps, member, { appId, kind: "pro", access: "own" }))
        .kind,
    ).toBe("pro");
  });
});
