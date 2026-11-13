import { afterEach, describe, expect, it } from "vitest";
import { getTenantId } from "../../../processors/vetra-cloud-environment/gitops.js";
import { listAudit } from "../audit/repo.js";
import { getHold } from "../holds/repo.js";
import { reconcileInstancesOnce } from "../instances/reconciler.js";
import { resumeMove } from "../switchover/machine.js";
import { updateSwitchover, type SwitchoverState } from "../switchover/repo.js";
import {
  advanceSwitchover,
  advanceSwitchoversOnce,
} from "../switchover/runner.js";
import { instanceReady, STEPS } from "../switchover/steps.js";
import { COUNTS } from "./fakes/backups.js";
import {
  ATTACH,
  flow,
  HOLDER,
  MASTER,
  OLD_HOST,
  OLD_TENANT,
  sha,
  type Flow,
} from "./switchover-flow-fixtures.js";

let f: Flow | null = null;
afterEach(async () => {
  await f?.h.close();
  f = null;
});

const HOUR = 3_600_000;
const fusionVersion = (fl: Flow, envId: string) =>
  fl.h.envs.docs
    .get(envId)
    ?.state.global.services.find((s) => s.type === "FUSION")?.version ?? null;

/** Ticks until the switch-over reaches `state` (a bounded number of passes). */
async function until(fl: Flow, state: SwitchoverState, max = 12) {
  for (let i = 0; i < max; i++) {
    if ((await fl.row()).state === state) return;
    await fl.tick();
  }
  const r = await fl.row();
  expect([r.state, r.error]).toEqual([state, null]);
}

async function newTenantOf(fl: Flow) {
  const inst = (await fl.instance())!;
  return getTenantId(OLD_HOST, inst.environment_id!);
}

/** Drives a real switch-over to PREPARED (instance created, held, keys in place, storage ready). */
async function toPrepared(fl: Flow) {
  await fl.tick(); // waits for the lead time
  expect((await fl.row()).state).toBe("PLANNED");
  fl.h.advance(2 * HOUR);
  await until(fl, "PREPARING");
  // keys read, instance row inserted; the reconciler creates the document, never started
  for (let i = 0; i < 4 && !(await fl.instance())?.environment_id; i++)
    await fl.tick();
  const inst = (await fl.instance())!;
  expect(inst.environment_id).toBeTruthy();
  await fl.tick();
  fl.cluster.dbReady.add(await newTenantOf(fl));
  fl.cluster.volumeBound.add(await newTenantOf(fl));
  await until(fl, "PREPARED");
}

describe("the first steps: prepare under a hold, keys by fingerprint", () => {
  it("waits for the lead time, then creates the instance, holds it, brings the old keys, and only then starts it", async () => {
    f = await flow();
    await f.tick();
    expect((await f.row()).state).toBe("PLANNED");
    f.h.advance(2 * HOUR);
    await f.tick();
    expect((await f.row()).state).toBe("PREPARING");
    await f.tick(); // keys read, instance row inserted
    const row = await f.row();
    expect(JSON.parse(row.key_fingerprints!)).toEqual({
      master: sha(MASTER),
      attachment: sha(ATTACH),
    });
    // The row never holds a key itself.
    expect(JSON.stringify(row)).not.toContain(MASTER);
    // The reconciler creates the document alone: created, never started (no hold, no keys yet).
    await reconcileInstancesOnce(f.h.deps);
    const inst = (await f.instance())!;
    expect(inst).toMatchObject({
      kind: "own",
      host: OLD_HOST,
      holder_address: HOLDER,
      licence_root_id: "l1",
      plan_id: "p1",
      switchover_id: row.id,
      target_version: "1.4.0",
    });
    expect(inst.environment_id).toBeTruthy();
    await reconcileInstancesOnce(f.h.deps);
    expect(fusionVersion(f, inst.environment_id!)).toBeNull();
    expect(await getHold(f.h.db, inst.environment_id!)).toBeNull();
    // The runner holds it and brings the keys; only then may the reconciler set the version.
    await advanceSwitchoversOnce(f.h.deps);
    expect(fusionVersion(f, inst.environment_id!)).toBeNull();
    await reconcileInstancesOnce(f.h.deps);
    expect(fusionVersion(f, inst.environment_id!)).toMatch(/1\.4\.0/);
    // Held, and the old keys are in the new tenant (fingerprint checked), before any start.
    expect(await getHold(f.h.db, inst.environment_id!)).toMatchObject({
      switchover_id: row.id,
    });
    const tenant = getTenantId(OLD_HOST, inst.environment_id!);
    expect(
      f.h.secrets.store.get(tenant)?.get("PH_WORKFLOWS_SECRETS_MASTER_KEY"),
    ).toBe(MASTER);
    expect(
      f.h.secrets.store.get(tenant)?.get("PH_ATTACHMENT_URL_SIGNING_SECRET"),
    ).toBe(ATTACH);
    // The old keys were read from a same-node archive of the running old environment.
    expect(f.backups.calls).toContain(
      `startArchive ${OLD_TENANT} switchover/${row.id}/keys-data.tar.zst sameNode`,
    );
    // Storage ready: the reconciler may set the version under the hold, and PREPARING ends.
    f.cluster.dbReady.add(tenant);
    f.cluster.volumeBound.add(tenant);
    await until(f, "PREPARED");
    expect(await getHold(f.h.db, inst.environment_id!)).not.toBeNull();
    // The old environment keeps running meanwhile.
    expect(await getHold(f.h.db, f.oldEnv)).toBeNull();
  });

  it("the new instance is not started while its tenant holds other keys (never replaces a master key)", async () => {
    f = await flow();
    f.h.advance(2 * HOUR);
    await until(f, "PREPARING");
    for (let i = 0; i < 4 && !(await f.instance())?.environment_id; i++)
      await f.tick();
    const inst = (await f.instance())!;
    const tenant = getTenantId(OLD_HOST, inst.environment_id!);
    // A generated key got there first (not the old one).
    f.h.secrets.store.set(
      tenant,
      new Map([["PH_WORKFLOWS_SECRETS_MASTER_KEY", "c".repeat(64)]]),
    );
    f.cluster.dbReady.add(tenant);
    f.cluster.volumeBound.add(tenant);
    await f.tick();
    await f.tick();
    const row = await f.row();
    expect(row.state).toBe("FAILED");
    expect(row.error).toMatch(/different master key; it was not replaced/);
    expect(row.error).not.toContain("c".repeat(64));
    expect(
      f.h.secrets.store.get(tenant)?.get("PH_WORKFLOWS_SECRETS_MASTER_KEY"),
    ).toBe("c".repeat(64));
    expect(fusionVersion(f, inst.environment_id!)).toBeNull();
  });

  it("an old environment without kept keys fails closed", async () => {
    f = await flow();
    f.backups.files.set(OLD_TENANT, new Map());
    f.h.advance(2 * HOUR);
    await until(f, "PREPARING");
    await f.tick();
    const row = await f.row();
    expect(row).toMatchObject({ state: "FAILED", failed_state: "PREPARING" });
    expect(row.error).toMatch(/no kept keys/);
    expect(await f.instance()).toBeNull();
  });

  it("garbage in a key file is no key", async () => {
    f = await flow();
    f.backups.files.set(
      OLD_TENANT,
      new Map([
        ["workflows-master-key", Buffer.from("not-hex")],
        ["attachment-url-signing-secret", Buffer.from(ATTACH)],
      ]),
    );
    f.h.advance(2 * HOUR);
    await until(f, "PREPARING");
    await f.tick();
    expect((await f.row()).state).toBe("FAILED");
  });

  it("eligibility is checked again at PREPARING: anything new refuses", async () => {
    f = await flow();
    f.h.advance(2 * HOUR);
    await until(f, "PREPARING");
    await f.h.db.updateTable("plans").set({ status: "retired" }).execute();
    await f.tick();
    expect(await f.row()).toMatchObject({ state: "FAILED" });
    expect((await f.row()).error).toMatch(/no longer eligible: .*retired/);
  });
});

describe("the window: hold the old environment, copy, check, start", () => {
  it("runs to AWAITING_CONFIRMATION and DONE, with every side effect once, in order", async () => {
    f = await flow();
    await toPrepared(f);
    const inst0 = (await f.instance())!;
    const tenant = getTenantId(OLD_HOST, inst0.environment_id!);
    // Before the window: waits.
    await f.tick();
    expect((await f.row()).state).toBe("PREPARED");
    f.h.advance(24 * HOUR);
    await until(f, "HOLDING_OLD");
    // The old environment is held and the runner waits until its app pod is gone.
    await f.tick();
    expect(await getHold(f.h.db, f.oldEnv)).toMatchObject({
      switchover_id: f.sw.id,
    });
    expect((await f.row()).state).toBe("HOLDING_OLD");
    expect((await f.row()).downtime_started_at).toBeNull();
    await f.setOldPod(false);
    await until(f, "BACKING_UP");
    expect((await f.row()).downtime_started_at).not.toBeNull();
    // The copy is checked against counts taken on the held, stopped old database.
    f.counts.byTenant.set(tenant, COUNTS);
    await until(f, "STARTING");
    const copied = await f.row();
    expect(JSON.parse(copied.source_counts!)).toEqual(COUNTS);
    expect(JSON.parse(copied.copy_counts!)).toEqual(COUNTS);
    // Still held, never started, until the copy was checked.
    expect(await getHold(f.h.db, inst0.environment_id!)).not.toBeNull();
    await until(f, "VERIFYING");
    expect(await getHold(f.h.db, inst0.environment_id!)).toBeNull();
    // Not ready yet: waits. Ready on the pinned digest, counts equal, Connect answers: LINKING.
    await f.tick();
    expect((await f.row()).state).toBe("VERIFYING");
    const inst = (await f.instance())!;
    await f.updateInstance(inst.id, {
      status: "ready",
      running_version: inst.target_version,
      running_digest: inst.target_digest,
      running_degraded: false,
    });
    await f.h.deps.licensingDb;
    await advanceSwitchover(f.h.deps, f.sw.id);
    expect((await f.row()).state).toBe("LINKING");
    expect((await f.row()).started_at).not.toBeNull();
    // The new instance's ingress is closed until verified: the probe goes to its Service in the cluster.
    expect(f.h.probed).toContain(
      `http://powerhouse-${tenant}-app.${tenant}.svc.cluster.local:80/`,
    );
    expect(f.h.probed).not.toContain(`https://${OLD_HOST}.vetra.io/`);
    await advanceSwitchover(f.h.deps, f.sw.id);
    const linked = await f.row();
    expect(linked.state).toBe("AWAITING_CONFIRMATION");
    const lic = await f.h.deps
      .licensingDb!.selectFrom("license_environments")
      .select(["switched_over_at", "switched_over_instance_id"])
      .where("environment_id", "=", f.oldEnv)
      .executeTakeFirstOrThrow();
    expect(lic.switched_over_instance_id).toBe(inst.id);
    expect(lic.switched_over_at).not.toBeNull();
    expect((await f.instance())!.switchover_id).toBeNull();
    // Unanswered for confirmHours: confirmed by silence; the old environment stays held for holdDays.
    await advanceSwitchover(f.h.deps, f.sw.id);
    expect((await f.row()).state).toBe("AWAITING_CONFIRMATION");
    f.h.advance(73 * HOUR);
    await advanceSwitchover(f.h.deps, f.sw.id);
    const done = await f.row();
    expect(done.state).toBe("DONE");
    expect(
      Date.parse(done.hold_until!) - Date.parse(done.done_at!),
    ).toBeGreaterThan(29 * 24 * HOUR);
    expect(await getHold(f.h.db, f.oldEnv)).not.toBeNull();
    // Each side effect happened exactly once.
    expect(f.backups.count("startDump")).toBe(1);
    expect(f.backups.count("startArchive")).toBe(2); // the keys archive and the backup archive
    expect(f.backups.count("restoreDump")).toBe(1);
    expect(f.backups.count("restoreArchive")).toBe(1);
    expect(f.counts.calls).toHaveLength(3);
    // The backup archive ran with the old pod gone (no same-node).
    expect(
      f.backups.calls.filter(
        (c) => c.includes("data.tar.zst") && !c.includes("keys-"),
      )[0],
    ).not.toContain("sameNode");
    // Every state change is audited; timings per step are kept.
    const audit = { rows: await listAudit(f.h.db, f.appId, { limit: 100 }) };
    expect(
      audit.rows.filter((a) => a.action === "switchover.state").length,
    ).toBeGreaterThanOrEqual(11);
    expect(audit.rows.some((a) => a.action === "switchover.linked")).toBe(true);
    expect(Object.keys(JSON.parse(done.timings!))).toEqual(
      expect.arrayContaining(["backing_up", "restoring", "checking_copy"]),
    );
    // No key or fingerprint-sized secret anywhere in the audit.
    expect(JSON.stringify(audit.rows)).not.toContain(MASTER);
  });

  it("a count mismatch fails CHECKING_COPY and the new instance stays held, never started on half a copy", async () => {
    f = await flow();
    await toPrepared(f);
    const inst = (await f.instance())!;
    const tenant = getTenantId(OLD_HOST, inst.environment_id!);
    f.counts.byTenant.set(tenant, {
      ...COUNTS,
      documentsByType: { ...COUNTS.documentsByType, "x/workflow": 4 },
    });
    f.h.advance(24 * HOUR);
    await until(f, "HOLDING_OLD");
    await f.setOldPod(false);
    await until(f, "CHECKING_COPY");
    await f.tick();
    const row = await f.row();
    expect(row).toMatchObject({
      state: "FAILED",
      failed_state: "CHECKING_COPY",
    });
    expect(row.error).toBe(
      "the copy differs from the source in documents of type x/workflow",
    );
    expect(await getHold(f.h.db, inst.environment_id!)).not.toBeNull();
    // Even a tick of the reconciler cannot start it: copy_counts is not set.
    await f.tick();
    expect((await f.instance())!.running_digest).toBeNull();
    // The old environment was never written: still held, its data untouched (nothing was deleted).
    expect(await getHold(f.h.db, f.oldEnv)).not.toBeNull();
    expect(f.h.envs.deleted).toEqual([]);
  });

  it("a restore failure fails RESTORING; resume re-runs it as a new attempt that resets the never-started target", async () => {
    f = await flow();
    await toPrepared(f);
    f.h.advance(24 * HOUR);
    await until(f, "HOLDING_OLD");
    await f.setOldPod(false);
    f.backups.setAuto(false);
    await until(f, "BACKING_UP");
    await f.tick(); // dump, archive started
    f.backups.settle("dump");
    f.backups.settle("archive");
    await f.tick();
    expect((await f.row()).state).toBe("RESTORING");
    await f.tick(); // restores started
    f.backups.settle("restore", "pg_restore: error: out of disk");
    await f.tick();
    const failed = await f.row();
    expect(failed).toMatchObject({
      state: "FAILED",
      failed_state: "RESTORING",
    });
    expect(failed.error).toContain("out of disk");
    const move = resumeMove(failed, f.h.deps.now().toISOString())!;
    await updateSwitchover(
      f.h.db,
      failed.id,
      { ...move.patch, state: move.state },
      f.h.deps.now().toISOString(),
      "FAILED",
    );
    f.backups.setAuto(true);
    f.counts.byTenant.set(await newTenantOf(f), COUNTS);
    await until(f, "CHECKING_COPY");
    expect(f.backups.calls.filter((c) => c.startsWith("restoreDump"))).toEqual([
      expect.stringMatching(/^restoreDump \S+ jobs=4$/),
      expect.stringMatching(/^restoreDump \S+ reset jobs=4$/),
    ]);
  });

  it("an App never has two real switch-overs past PREPARED: the second waits in PREPARED", async () => {
    f = await flow();
    await toPrepared(f);
    f.h.advance(24 * HOUR);
    await until(f, "HOLDING_OLD");
    const { insertSwitchover } = await import("../switchover/repo.js");
    const { switchoverRow } = await import("./switchover-fixtures.js");
    const other = await insertSwitchover(
      f.h.db,
      switchoverRow({
        id: "other",
        app_id: f.appId,
        environment_id: "env-other",
        state: "PREPARED",
        window_start: new Date(f.h.deps.now().getTime() - HOUR).toISOString(),
      }),
    );
    const ctx = {
      deps: f.h.deps,
      ports: f.h.deps.switchover!,
      cfg: {
        enabled: true,
        leadHours: 24,
        holdDays: 30,
        confirmHours: 72,
        restoreJobs: 4,
      },
      nowIso: f.h.deps.now().toISOString(),
    };
    expect(await STEPS.PREPARED(ctx, other)).toEqual({ kind: "wait" });
    // Once the first is past its window (closed), the second may go.
    await f.h.db
      .updateTable("switchovers")
      .set({ state: "ROLLED_BACK" })
      .where("id", "=", f.sw.id)
      .execute();
    expect((await STEPS.PREPARED(ctx, other)).kind).toBe("advance");
  });
});

describe("idempotence and crashes", () => {
  it("a dump started before a crash is found again, not started twice", async () => {
    f = await flow();
    await toPrepared(f);
    f.h.advance(24 * HOUR);
    await until(f, "HOLDING_OLD");
    await f.setOldPod(false);
    // A previous pass started the dump but died before saving its id.
    const keys = `switchover/${f.sw.id}/db.dump`;
    const { dumpId } = await f.backups.api.startDump({
      tenant: OLD_TENANT,
      environmentId: f.oldEnv,
      key: keys,
    });
    await until(f, "BACKING_UP");
    await f.tick();
    expect((await f.row()).dump_id).toBe(dumpId);
    expect(f.backups.count("startDump")).toBe(1);
  });

  it("a start that throws fails the step with a clean message; resume continues with the same jobs", async () => {
    f = await flow();
    await toPrepared(f);
    f.h.advance(24 * HOUR);
    await until(f, "HOLDING_OLD");
    await f.setOldPod(false);
    f.backups.failStart.add("archive");
    await until(f, "BACKING_UP");
    await f.tick();
    const failed = await f.row();
    expect(failed).toMatchObject({
      state: "FAILED",
      failed_state: "BACKING_UP",
    });
    expect(failed.error).toContain("archive could not start");
    expect(failed.dump_id).not.toBeNull();
    f.backups.failStart.clear();
    const move = resumeMove(failed, f.h.deps.now().toISOString())!;
    await updateSwitchover(
      f.h.db,
      failed.id,
      { ...move.patch, state: move.state },
      f.h.deps.now().toISOString(),
      "FAILED",
    );
    f.counts.byTenant.set(await newTenantOf(f), COUNTS);
    await until(f, "RESTORING");
    expect(f.backups.count("startDump")).toBe(1);
  });

  it("a busy tenant is waited for, not failed", async () => {
    f = await flow();
    await toPrepared(f);
    f.h.advance(24 * HOUR);
    await until(f, "HOLDING_OLD");
    await f.setOldPod(false);
    await until(f, "BACKING_UP");
    f.backups.busy.add(OLD_TENANT);
    await f.tick();
    await f.tick();
    expect((await f.row()).state).toBe("BACKING_UP");
    f.backups.busy.clear();
    await f.tick();
    expect(f.backups.count("startDump")).toBe(1);
  });
});

describe("instanceReady", () => {
  const base = {
    status: "ready",
    running_digest: "d",
    running_degraded: false,
    reason: null,
  } as never;
  it("ready only on the pinned digest, healthy", () => {
    expect(instanceReady(base, "d")).toEqual({ ready: true, reason: null });
    expect(instanceReady(base, "other").ready).toBe(false);
    expect(
      instanceReady(
        { ...(base as object), running_degraded: true } as never,
        "d",
      ).ready,
    ).toBe(false);
    expect(
      instanceReady(
        { ...(base as object), status: "failed", reason: "boom" } as never,
        "d",
      ),
    ).toEqual({ ready: false, reason: "boom" });
  });
});
