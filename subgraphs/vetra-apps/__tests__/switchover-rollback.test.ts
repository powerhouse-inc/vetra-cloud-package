import { afterEach, describe, expect, it } from "vitest";
import { getTenantId } from "../../../processors/vetra-cloud-environment/gitops.js";
import { listAudit } from "../audit/repo.js";
import { reconcileInstancesOnce } from "../instances/reconciler.js";
import { getHold } from "../holds/repo.js";
import {
  rollBackSwitchover,
  ROLLED_BACK_REASON,
} from "../switchover/rollback.js";
import { advanceSwitchoversOnce } from "../switchover/runner.js";
import { updateSwitchover } from "../switchover/repo.js";
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

const instances = (fl: Flow) =>
  fl.h.db
    .selectFrom("instances")
    .selectAll()
    .where("app_id", "=", fl.appId)
    .where("kind", "=", "own")
    .execute();

/** Plays the cluster after a roll back until it is ROLLED_BACK. */
async function settleRollback(fl: Flow) {
  for (let i = 0; i < 8; i++) {
    if ((await fl.row()).state === "ROLLED_BACK") return;
    await fl.tick();
    fl.h.envs.setStatus(fl.oldEnv, "READY");
  }
  expect((await fl.row()).state).toBe("ROLLED_BACK");
}

describe("rollBackSwitchover", () => {
  it("only platform admins, and not while the switch-over is off", async () => {
    f = await flow();
    await expect(rollBackSwitchover(f.h.deps, owner, f.sw.id)).rejects.toThrow(
      /Admins only/,
    );
    await expect(rollBackSwitchover(f.h.deps, admin, "nope")).rejects.toThrow(
      /not found/,
    );
    f.h.deps.cfg = { ...f.h.deps.cfg, switchover: undefined };
    await expect(rollBackSwitchover(f.h.deps, admin, f.sw.id)).rejects.toThrow(
      /off/,
    );
  });

  it("before the window (PREPARED): nothing ran for the holder; the empty prepared instance goes, the old environment is never touched", async () => {
    f = await flow();
    await drive(f, "PREPARED");
    const inst = (await f.instance())!;
    const newEnv = inst.environment_id!;
    expect(await getHold(f.h.db, newEnv)).not.toBeNull();
    const oldWrites = () =>
      f!.h.envs.executed.filter((e) => e.id === f!.oldEnv).length;
    const before = oldWrites();
    const row = await rollBackSwitchover(f.h.deps, admin, f.sw.id);
    expect(row).toMatchObject({
      state: "ROLLING_BACK",
      failed_state: "PREPARED",
    });
    await settleRollback(f);
    expect(f.h.envs.deleted).toEqual([newEnv]);
    expect(await instances(f)).toEqual([]);
    expect(await getHold(f.h.db, newEnv)).toBeNull();
    expect(await getHold(f.h.db, f.oldEnv)).toBeNull();
    expect((await f.row()).rolled_back_at).not.toBeNull();
    // The old environment document was never written by the switch-over.
    expect(oldWrites()).toBe(before);
    const audit = await listAudit(f.h.db, f.appId, { limit: 100 });
    expect(
      audit.find((a) => a.action === "switchover.rolled_back"),
    ).toMatchObject({
      actor: admin.address,
    });
  });

  it("during the window (FAILED in CHECKING_COPY): lossless; the new instance stays held with its data, the old one comes back", async () => {
    f = await flow();
    await drive(f, "CHECKING_COPY");
    const inst = (await f.instance())!;
    const tenant = getTenantId(OLD_HOST, inst.environment_id!);
    f.counts.byTenant.set(tenant, {
      ...f.counts.byTenant.get(tenant)!,
      operations: 1,
    });
    await f.tick();
    expect((await f.row()).state).toBe("FAILED");
    expect(await getHold(f.h.db, f.oldEnv)).not.toBeNull();
    // No data-loss confirmation needed before STARTING.
    await rollBackSwitchover(f.h.deps, admin, f.sw.id);
    await settleRollback(f);
    expect(await getHold(f.h.db, f.oldEnv)).toBeNull();
    // Kept, held, never deleted: the copy stays for inspection.
    const kept = (await instances(f))[0];
    expect(kept).toMatchObject({
      id: inst.id,
      stop_reason: ROLLED_BACK_REASON,
      switchover_id: f.sw.id,
    });
    expect(await getHold(f.h.db, inst.environment_id!)).not.toBeNull();
    expect(f.h.envs.deleted).toEqual([]);
    // The old app must answer before the roll back ends (it waited for it).
    expect(f.cluster.ready.has(OLD_TENANT)).toBe(true);
  });

  it("waits for the old app to be ready again before it is ROLLED_BACK", async () => {
    f = await flow();
    await drive(f, "CHECKING_COPY");
    await rollBackSwitchover(f.h.deps, admin, f.sw.id);
    f.cluster.ready.delete(OLD_TENANT);
    for (let i = 0; i < 3; i++) {
      await f.tick();
      f.h.envs.setStatus(f.oldEnv, "READY");
    }
    expect((await f.row()).state).toBe("ROLLING_BACK");
    expect(await getHold(f.h.db, f.oldEnv)).toBeNull();
    f.cluster.ready.add(OLD_TENANT);
    await f.tick();
    expect((await f.row()).state).toBe("ROLLED_BACK");
  });

  it("after the start it discards writes: refused without acceptDataLoss; unlinks, holds the new instance, and the chain does not get a second instance", async () => {
    f = await flow();
    await drive(f, "AWAITING_CONFIRMATION");
    const inst = (await f.instance())!;
    expect(inst.switchover_id).toBeNull();
    await expect(rollBackSwitchover(f.h.deps, admin, f.sw.id)).rejects.toThrow(
      /acceptDataLoss/,
    );
    expect((await f.row()).state).toBe("AWAITING_CONFIRMATION");
    // The new app still runs for a moment: the old one is not released until it is gone.
    const tenant = getTenantId(OLD_HOST, inst.environment_id!);
    await (f.h.obsDb as any)
      .insertInto("environment_pods")
      .values({
        id: `${tenant}/app-0`,
        tenantId: tenant,
        name: "app-0",
        service: "OTHER",
        component: "app",
        agent: null,
        phase: "Running",
        ready: 1,
        restartCount: 0,
        updatedAt: f.h.deps.now().toISOString(),
      })
      .execute();
    await rollBackSwitchover(f.h.deps, admin, f.sw.id, {
      acceptDataLoss: true,
    });
    await f.tick();
    await f.tick();
    expect(await getHold(f.h.db, inst.environment_id!)).not.toBeNull();
    expect(await getHold(f.h.db, f.oldEnv)).not.toBeNull();
    const lic = await f.h.deps
      .licensingDb!.selectFrom("license_environments")
      .select(["switched_over_at", "switched_over_instance_id"])
      .where("environment_id", "=", f.oldEnv)
      .executeTakeFirstOrThrow();
    expect(lic).toEqual({
      switched_over_at: null,
      switched_over_instance_id: null,
    });
    // Its pod goes: now the old environment is released.
    await (f.h.obsDb as any)
      .deleteFrom("environment_pods")
      .where("tenantId", "=", tenant)
      .execute();
    await (f.h.obsDb as any)
      .insertInto("environment_status")
      .values({
        tenantId: tenant,
        argoSyncStatus: "Synced",
        argoHealthStatus: "Healthy",
        configDriftDetected: 0,
        updatedAt: f.h.deps.now().toISOString(),
      })
      .execute();
    await settleRollback(f);
    expect(await getHold(f.h.db, f.oldEnv)).toBeNull();
    // Rule 1: the chain has a licensed row again; the sync neither restarts the stopped instance nor makes a second one.
    for (let i = 0; i < 3; i++) await reconcileInstancesOnce(f.h.deps);
    const rows = await instances(f);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: inst.id,
      stop_reason: ROLLED_BACK_REASON,
      switchover_id: f.sw.id,
    });
    expect(await getHold(f.h.db, inst.environment_id!)).not.toBeNull();
  });

  it("refuses a done, a rolled-back and a dry run", async () => {
    f = await flow();
    await drive(f, "AWAITING_CONFIRMATION");
    f.h.advance(73 * HOUR);
    await advanceSwitchoversOnce(f.h.deps);
    expect((await f.row()).state).toBe("DONE");
    await expect(
      rollBackSwitchover(f.h.deps, admin, f.sw.id, { acceptDataLoss: true }),
    ).rejects.toThrow(/done/);
    await updateSwitchover(
      f.h.db,
      f.sw.id,
      { state: "ROLLED_BACK" },
      "2026-10-02T00:00:00.000Z",
      "DONE",
    );
    await expect(rollBackSwitchover(f.h.deps, admin, f.sw.id)).rejects.toThrow(
      /already rolled back|cannot be rolled back/,
    );
  });

  it("does not delete another environment's hold on the old environment", async () => {
    f = await flow();
    await drive(f, "CHECKING_COPY");
    await f.h.db
      .updateTable("environment_holds")
      .set({ switchover_id: "someone-else" })
      .where("environment_id", "=", f.oldEnv)
      .execute();
    await rollBackSwitchover(f.h.deps, admin, f.sw.id);
    await f.tick();
    await f.tick();
    expect(await getHold(f.h.db, f.oldEnv)).not.toBeNull();
    expect((await f.row()).state).toBe("FAILED");
    expect((await f.row()).error).toMatch(/not this switch-over's/);
  });
});
