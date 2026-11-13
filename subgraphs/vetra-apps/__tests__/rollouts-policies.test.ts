import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { owner, type Harness } from "./harness.js";
import { digest, seedRelease } from "./instances-fixtures.js";
import {
  HOLDER_A,
  readyInstance,
  rolloutHarness,
  seedPlan,
} from "./rollouts-fixtures.js";
import { listAudit } from "../audit/repo.js";
import { getPlan } from "../plans/repo.js";
import { getApp } from "../repo.js";
import { listRollouts, stepsOf } from "../rollouts/repo.js";
import { advanceRollouts } from "../rollouts/runner.js";
import { startRollout } from "../rollouts/service.js";

let h: Harness;
let appId: string;
beforeEach(async () => {
  ({ h, appId } = await rolloutHarness());
});
afterEach(async () => {
  await h.close();
});
const advance = async () =>
  advanceRollouts(h.deps, (await getApp(h.db, appId))!);

describe("policies (spec section 7)", () => {
  it("patches rolls out 1.4.1 by itself, as Vetra, and its step starts in the same pass", async () => {
    await seedPlan(h, appId, {
      id: "p-pro",
      slug: "pro",
      access: "own",
      policy: "patches",
    });
    await readyInstance(h, appId, {
      id: "o1",
      planId: "p-pro",
      kind: "own",
      holder: HOLDER_A,
    });
    await advance();
    const [r] = await listRollouts(h.db, appId, 5);
    expect(r).toMatchObject({
      version: "1.4.1",
      source: "policy",
      started_by: "vetra",
    });
    expect((await stepsOf(h.db, r.id))[0].status).toBe("applying");
  });

  it("minor takes 1.5.0 and never the major; follow:main takes the branch's newest, 2.0.0; then nothing more", async () => {
    await seedPlan(h, appId, {
      id: "p-minor",
      slug: "minor",
      access: "own",
      policy: "minor",
    });
    await seedPlan(h, appId, {
      id: "p-follow",
      slug: "team-ish",
      access: "shared",
      policy: "follow:main",
    });
    await advance();
    expect((await getPlan(h.db, "p-minor"))?.target_version).toBe("1.5.0");
    expect((await getPlan(h.db, "p-follow"))?.target_version).toBe("2.0.0");
    await advance();
    expect(await listRollouts(h.db, appId, 10)).toHaveLength(2);
  });

  it("waits while the plan is in an open rollout, then takes the next patch", async () => {
    await seedPlan(h, appId, { id: "p-pro", slug: "pro", access: "own" });
    await readyInstance(h, appId, {
      id: "o1",
      planId: "p-pro",
      kind: "own",
      holder: HOLDER_A,
    });
    const manual = await startRollout(h.deps, owner, {
      appId,
      version: "1.4.1",
      planIds: ["p-pro"],
      noticeHours: 5,
    });
    await h.db
      .updateTable("plans")
      .set({ policy: "patches" })
      .where("id", "=", "p-pro")
      .execute();
    await seedRelease(h, appId, {
      version: "1.4.2",
      run: 115,
      kind: "release",
      digest: digest("f"),
    });
    await advance();
    expect(await listRollouts(h.db, appId, 10)).toHaveLength(1);
    await h.db
      .updateTable("rollouts")
      .set({ status: "complete" })
      .where("id", "=", manual.id)
      .execute();
    await advance();
    expect((await listRollouts(h.db, appId, 10))[0]).toMatchObject({
      version: "1.4.2",
      source: "policy",
    });
  });

  it("records a refusal once per plan and version, and starts nothing", async () => {
    await seedPlan(h, appId, {
      id: "p-pro",
      slug: "pro",
      access: "own",
      policy: "patches",
    });
    await h.db
      .updateTable("releases")
      .set({ requires: '{"size":"XL"}' })
      .where("version", "=", "1.4.1")
      .execute();
    await advance();
    await advance();
    expect(await listRollouts(h.db, appId, 10)).toEqual([]);
    expect((await getPlan(h.db, "p-pro"))?.policy_note).toMatch(
      /^1\.4\.1: Cannot roll out 1\.4\.1: 1\.4\.1 needs size XL/,
    );
    const refused = (await listAudit(h.db, appId, { limit: 20 })).filter(
      (a) => a.action === "rollout.policy_refused",
    );
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ actor: "vetra", source: "policy" });
  });

  it("starts nothing while held", async () => {
    await seedPlan(h, appId, {
      id: "p-pro",
      slug: "pro",
      access: "own",
      policy: "patches",
    });
    h.deps.cfg.plans = { enabled: true, stopAfterDays: 14, rolloutsHold: true };
    await advance();
    expect(await listRollouts(h.db, appId, 10)).toEqual([]);
  });
});
