import { afterEach, describe, expect, it } from "vitest";
import { listAudit } from "../audit/repo.js";
import { plannedSteps } from "../rollouts/service.js";
import { listPlans } from "../plans/repo.js";
import { setPlanTarget } from "../plans/service.js";
import {
  advanceSwitchover,
  advanceSwitchoversOnce,
  scrub,
} from "../switchover/runner.js";
import { updateSwitchover } from "../switchover/repo.js";
import { admin } from "./harness.js";
import { flow, MASTER, type Flow } from "./switchover-flow-fixtures.js";

let f: Flow | null = null;
afterEach(async () => {
  await f?.h.close();
  f = null;
});
const HOUR = 3_600_000;

describe("the runner is off unless switched on", () => {
  it("does nothing without VETRA_APPS_SWITCHOVER, without ports, or while a row is closed or FAILED", async () => {
    f = await flow();
    f.h.advance(2 * HOUR);
    f.h.deps.cfg = { ...f.h.deps.cfg, switchover: undefined };
    expect(await advanceSwitchoversOnce(f.h.deps)).toBe(0);
    expect((await f.row()).state).toBe("PLANNED");
    f.h.deps.cfg = {
      ...f.h.deps.cfg,
      switchover: {
        enabled: true,
        leadHours: 24,
        holdDays: 30,
        confirmHours: 72,
        restoreJobs: 4,
      },
    };
    const ports = f.h.deps.switchover;
    f.h.deps.switchover = null;
    expect(await advanceSwitchoversOnce(f.h.deps)).toBe(0);
    f.h.deps.switchover = ports;
    expect(await advanceSwitchoversOnce(f.h.deps)).toBe(1);
    expect((await f.row()).state).toBe("PREPARING");
    // enabled needs plans and instances too.
    f.h.deps.cfg = { ...f.h.deps.cfg, plans: undefined };
    expect(await advanceSwitchoversOnce(f.h.deps)).toBe(0);
  });
});

describe("timeouts, failures and the audit", () => {
  it("a step past its time fails with the machine's message; FAILED is left alone by the runner", async () => {
    f = await flow();
    f.h.advance(2 * HOUR);
    await f.tick();
    expect((await f.row()).state).toBe("PREPARING");
    // PREPARING never finishes here (no storage): 31 minutes later it times out.
    f.h.advance(31 * 60_000);
    await advanceSwitchover(f.h.deps, f.sw.id);
    const row = await f.row();
    expect(row).toMatchObject({
      state: "FAILED",
      failed_state: "PREPARING",
      error: "PREPARING timed out after 30 min",
    });
    const audit = await listAudit(f.h.db, f.appId, { limit: 50 });
    expect(audit.find((a) => a.action === "switchover.failed")).toMatchObject({
      source: "system",
      subject: `switchover:${f.sw.id}`,
    });
    expect(await advanceSwitchoversOnce(f.h.deps)).toBe(0);
    expect((await f.row()).state).toBe("FAILED");
  });

  it("a thrown error becomes a failure with long hex (keys) scrubbed out", async () => {
    f = await flow();
    f.h.advance(2 * HOUR);
    f.backups.api.readArchiveFiles = async () => {
      throw new Error(`boom ${MASTER} and\nmore`);
    };
    await f.tick();
    await f.tick();
    const row = await f.row();
    expect(row.state).toBe("FAILED");
    expect(row.error).toBe("boom [redacted] and more");
    expect(scrub(`k=${MASTER}`)).toBe("k=[redacted]");
  });

  it("a lost compare-and-set (another runner moved the row) changes nothing", async () => {
    f = await flow();
    f.h.advance(2 * HOUR);
    const fresh = await f.row();
    // Another runner moves it between the read and the write.
    const real = f.h.db.transaction.bind(f.h.db);
    let raced = false;
    (f.h.db as any).transaction = () => {
      if (!raced) {
        raced = true;
        return {
          execute: async () => {
            await updateSwitchover(
              f!.h.db,
              fresh.id,
              { state: "PREPARING" },
              "2026-10-02T14:00:00.000Z",
              "PLANNED",
            );
            const { SwitchoverRaceError } =
              await import("../switchover/repo.js");
            throw new SwitchoverRaceError(fresh.id, "PLANNED");
          },
        };
      }
      return real();
    };
    const after = await advanceSwitchover(f.h.deps, fresh.id);
    expect(after?.state).toBe("PLANNED");
    (f.h.db as any).transaction = real;
    expect((await f.row()).state).toBe("PREPARING");
  });
});

describe("what a switch-over owns, others leave alone", () => {
  it("rollouts plan its instance as skipped, and its plan's target cannot move meanwhile", async () => {
    f = await flow();
    f.h.advance(2 * HOUR);
    await f.tick();
    for (let i = 0; i < 3 && !(await f.instance()); i++) await f.tick();
    const inst = (await f.instance())!;
    expect(inst.switchover_id).toBe(f.sw.id);
    const plans = await listPlans(f.h.db, f.appId);
    // An older target than the plan's: the instance would normally move.
    await f.h.db
      .updateTable("instances")
      .set({ target_version: "1.3.0" })
      .where("id", "=", inst.id)
      .execute();
    const steps = await plannedSteps(f.h.deps, f.appId, plans, "1.4.0");
    expect(steps).toEqual([
      expect.objectContaining({
        status: "skipped",
        note: "switch-over in progress",
      }),
    ]);
    await expect(setPlanTarget(f.h.deps, admin, "p1", "1.4.0")).rejects.toThrow(
      /switch-over of this plan is in progress/,
    );
  });
});
