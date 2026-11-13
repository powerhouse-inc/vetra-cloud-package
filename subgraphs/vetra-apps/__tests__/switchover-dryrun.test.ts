import { afterEach, describe, expect, it } from "vitest";
import { getTenantId } from "../../../processors/vetra-cloud-environment/gitops.js";
import { getHold } from "../holds/repo.js";
import { advanceSwitchoversOnce } from "../switchover/runner.js";
import { updateSwitchover } from "../switchover/repo.js";
import {
  cleanUpDryRun,
  dryRunSwitchover,
  planSwitchover,
  resumeSwitchover,
} from "../switchover/service.js";
import { COUNTS } from "./fakes/backups.js";
import { admin, owner } from "./harness.js";
import {
  drive,
  flow,
  OLD_HOST,
  OLD_TENANT,
  type Flow,
} from "./switchover-flow-fixtures.js";

let f: Flow | null = null;
afterEach(async () => {
  await f?.h.close();
  f = null;
});
const HOUR = 3_600_000;

const ownInstances = (fl: Flow) =>
  fl.h.db
    .selectFrom("instances")
    .selectAll()
    .where("app_id", "=", fl.appId)
    .where("kind", "=", "own")
    .execute();

describe("dryRunSwitchover", () => {
  it("admins only; creates a PLANNED dry run of an eligible environment, one at a time", async () => {
    f = await flow();
    await f.h.db.deleteFrom("switchovers").execute();
    await expect(dryRunSwitchover(f.h.deps, owner, f.oldEnv)).rejects.toThrow(
      /Admins only/,
    );
    const row = await dryRunSwitchover(f.h.deps, admin, f.oldEnv);
    expect(row).toMatchObject({
      mode: "dry_run",
      state: "PLANNED",
      environment_id: f.oldEnv,
      old_tenant: OLD_TENANT,
      old_host: OLD_HOST,
      kind: "sektar-cloud",
      plan_id: "p1",
      release_version: "1.4.0",
      window_start: null,
    });
    await expect(dryRunSwitchover(f.h.deps, admin, f.oldEnv)).rejects.toThrow(
      /dry run of this environment is running/,
    );
  });

  it("refuses an environment that fails the checks, naming why", async () => {
    f = await flow();
    await f.h.db.deleteFrom("switchovers").execute();
    await f.h.db.updateTable("plans").set({ status: "retired" }).execute();
    await expect(dryRunSwitchover(f.h.deps, admin, f.oldEnv)).rejects.toThrow(
      /plan is retired/,
    );
  });
});

describe("a dry run end to end", () => {
  it("copies the running environment into a clone, verifies it, and removes the clone; the old environment is never held, stopped or linked", async () => {
    f = await flow({ mode: "dry_run", frozen: false });
    const before = f.h.envs.executed.filter((e) => e.id === f!.oldEnv).length;
    await drive(f, "CLEANING");
    const inst = (await f.instance())!;
    const newEnv = inst.environment_id!;
    expect(inst).toMatchObject({
      holder_address: null,
      licence_root_id: null,
      host: expect.stringMatching(/^rehearsal-/),
      switchover_id: f.sw.id,
    });
    // The clone serves nobody: ADMINS empty, whatever the App's owner is.
    const admins = f.h.envs.docs
      .get(newEnv)!
      .state.global.fusion?.env?.find((e) => e.name === "ADMINS")?.value;
    expect(admins).toBe("");
    await f.tick();
    expect((await f.row()).state).toBe("CLEANED");
    // The clone is gone: document, hold, instance row. Nothing else was deleted.
    expect(f.h.envs.deleted).toEqual([newEnv]);
    expect(await getHold(f.h.db, newEnv)).toBeNull();
    expect(await ownInstances(f)).toEqual([]);
    // The old environment: running the whole time.
    expect(await getHold(f.h.db, f.oldEnv)).toBeNull();
    expect(f.h.envs.executed.filter((e) => e.id === f!.oldEnv).length).toBe(
      before,
    );
    const lic = await f.h.deps
      .licensingDb!.selectFrom("license_environments")
      .select("switched_over_at")
      .where("environment_id", "=", f.oldEnv)
      .executeTakeFirstOrThrow();
    expect(lic.switched_over_at).toBeNull();
    const row = await f.row();
    // Sized: every step has its seconds, the counts of the copy are kept.
    expect(Object.keys(JSON.parse(row.timings!))).toEqual(
      expect.arrayContaining([
        "preparing",
        "backing_up",
        "restoring",
        "checking_copy",
        "verifying",
      ]),
    );
    expect(JSON.parse(row.started_counts!)).toEqual(COUNTS);
    // The archives ran beside the running old pod, read-only; the dump and archive stay (180 days).
    expect(f.backups.calls.filter((c) => c.startsWith("startArchive"))).toEqual(
      [
        expect.stringMatching(/keys-data.tar.zst sameNode$/),
        expect.stringMatching(/\/data.tar.zst sameNode$/),
      ],
    );
    expect(
      f.backups.calls.some((c) => c.includes(`switchover/${f!.sw.id}/db.dump`)),
    ).toBe(true);
  });

  it("needs no freeze (a dry run holds nothing)", async () => {
    f = await flow({ mode: "dry_run", frozen: false });
    await drive(f, "CHECKING_COPY");
    expect((await f.row()).state).toBe("CHECKING_COPY");
  });

  it("a failure leaves the clone held until cleanUpDryRun removes it; resume works too", async () => {
    f = await flow({ mode: "dry_run", frozen: false });
    await drive(f, "CHECKING_COPY");
    const inst = (await f.instance())!;
    const tenant = getTenantId(inst.host!, inst.environment_id!);
    f.counts.byTenant.set(tenant, { ...COUNTS, attachments: 99 });
    await f.tick();
    const failed = await f.row();
    expect(failed).toMatchObject({
      state: "FAILED",
      failed_state: "CHECKING_COPY",
    });
    expect(failed.error).toBe(
      "the copy differs from the source in attachments",
    );
    expect(await getHold(f.h.db, inst.environment_id!)).not.toBeNull();
    expect(f.h.envs.deleted).toEqual([]);
    await expect(cleanUpDryRun(f.h.deps, owner, failed.id)).rejects.toThrow(
      /Admins only/,
    );
    // Resume re-checks (the counts are right now): it goes on to the end.
    f.counts.byTenant.set(tenant, COUNTS);
    const resumed = await resumeSwitchover(f.h.deps, admin, failed.id);
    expect(resumed).toMatchObject({
      state: "CHECKING_COPY",
      attempts: 1,
      error: null,
    });
    // Fail it again, then clean it up instead.
    f.counts.byTenant.set(tenant, { ...COUNTS, attachments: 98 });
    await f.tick();
    await f.tick();
    expect((await f.row()).state).toBe("FAILED");
    const cleaning = await cleanUpDryRun(f.h.deps, admin, failed.id);
    expect(cleaning.state).toBe("CLEANING");
    await f.tick();
    expect((await f.row()).state).toBe("CLEANED");
    expect(f.h.envs.deleted).toEqual([inst.environment_id]);
    expect(await ownInstances(f)).toEqual([]);
    // Cleaning up a running dry run, or a real switch-over, is refused.
    await expect(cleanUpDryRun(f.h.deps, admin, failed.id)).rejects.toThrow(
      /failed dry run/,
    );
  });

  it("cleaning never deletes an instance that is not the dry run's clone", async () => {
    f = await flow({ mode: "dry_run", frozen: false });
    await drive(f, "CLEANING");
    const inst = (await f.instance())!;
    await f.h.db
      .updateTable("instances")
      .set({ holder_address: "0x1" })
      .where("id", "=", inst.id)
      .execute();
    await f.tick();
    const row = await f.row();
    expect(row.state).toBe("FAILED");
    expect(row.error).toMatch(/not this dry run's clone/);
    expect(f.h.envs.deleted).toEqual([]);
  });
});

describe("planSwitchover", () => {
  it("a window at least 72 h ahead, ending after it, not overlapping another; admins only", async () => {
    f = await flow({ frozen: false });
    await f.h.db.deleteFrom("switchovers").execute();
    const at = (h: number) =>
      new Date(f!.h.deps.now().getTime() + h * HOUR).toISOString();
    await expect(
      planSwitchover(f.h.deps, owner, f.oldEnv, {
        windowStart: at(80),
        windowEnd: at(82),
      }),
    ).rejects.toThrow(/Admins only/);
    await expect(
      planSwitchover(f.h.deps, admin, f.oldEnv, {
        windowStart: at(48),
        windowEnd: at(50),
      }),
    ).rejects.toThrow(/at least 72 hours/);
    await expect(
      planSwitchover(f.h.deps, admin, f.oldEnv, {
        windowStart: at(80),
        windowEnd: at(79),
      }),
    ).rejects.toThrow(/end after/);
    await expect(
      planSwitchover(f.h.deps, admin, f.oldEnv, {
        windowStart: "x",
        windowEnd: "y",
      }),
    ).rejects.toThrow(/ISO/);
    const row = await planSwitchover(f.h.deps, admin, f.oldEnv, {
      windowStart: at(80),
      windowEnd: at(82),
    });
    // The freeze is not needed yet (checked when the old environment is held).
    expect(row).toMatchObject({
      mode: "real",
      state: "PLANNED",
      holder_address: "0x1111111111111111111111111111111111111111",
    });
    await expect(
      planSwitchover(f.h.deps, admin, f.oldEnv, {
        windowStart: at(90),
        windowEnd: at(92),
      }),
    ).rejects.toThrow(/already has a switch-over/);
  });

  it("a window overlapping another switch-over's of the App is refused", async () => {
    f = await flow({ frozen: false });
    const at = (h: number) =>
      new Date(f!.h.deps.now().getTime() + h * HOUR).toISOString();
    await f.h.db.deleteFrom("switchovers").execute();
    await planSwitchover(f.h.deps, admin, f.oldEnv, {
      windowStart: at(80),
      windowEnd: at(82),
    });
    // A second row for another environment of the App, planned directly.
    const { insertSwitchover } = await import("../switchover/repo.js");
    const { switchoverRow } = await import("./switchover-fixtures.js");
    await insertSwitchover(
      f.h.db,
      switchoverRow({
        id: "o2",
        app_id: f.appId,
        environment_id: "env-o2",
        window_start: at(90),
        window_end: at(92),
      }),
    );
    // The same environment cannot be planned again anyway; the overlap rule is checked on the App's windows.
    await f.h.db
      .updateTable("switchovers")
      .set({ state: "ROLLED_BACK" })
      .where("environment_id", "=", f.oldEnv)
      .execute();
    await expect(
      planSwitchover(f.h.deps, admin, f.oldEnv, {
        windowStart: at(91),
        windowEnd: at(93),
      }),
    ).rejects.toThrow(/overlaps/);
  });
});

describe("resume", () => {
  it("only a failed switch-over", async () => {
    f = await flow();
    await expect(resumeSwitchover(f.h.deps, admin, f.sw.id)).rejects.toThrow(
      /Only a failed/,
    );
    await expect(resumeSwitchover(f.h.deps, owner, f.sw.id)).rejects.toThrow(
      /Admins only/,
    );
    await updateSwitchover(
      f.h.db,
      f.sw.id,
      { state: "FAILED", failed_state: "PLANNED" },
      "2026-10-02T00:00:00.000Z",
      "PLANNED",
    );
    f.h.advance(2 * HOUR);
    expect(await resumeSwitchover(f.h.deps, admin, f.sw.id)).toMatchObject({
      state: "PLANNED",
      attempts: 1,
    });
    expect(await advanceSwitchoversOnce(f.h.deps)).toBe(1);
  });
});
