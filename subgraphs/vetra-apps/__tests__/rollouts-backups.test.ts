import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { owner, type Harness } from "./harness.js";
import { digest } from "./instances-fixtures.js";
import { becomeReady, failUpdate, HOLDER_A, instance, readyInstance, rolloutHarness, seedPlan } from "./rollouts-fixtures.js";
import { fakeBackupK8s, finishBackupJobs, type FakeBackupK8s } from "./backups-fixtures.js";
import { activeRestoresOfApp, listBackupsOfInstance } from "../backups/repo.js";
import { advanceRestores } from "../backups/restore.js";
import { advanceBackups } from "../backups/service.js";
import { getApp } from "../repo.js";
import { pauseRollout, rollBackRollout } from "../rollouts/controls.js";
import { getRollout, stepsOf } from "../rollouts/repo.js";
import { advanceRollouts } from "../rollouts/runner.js";
import { startRollout } from "../rollouts/service.js";

let h: Harness;
let appId: string;
let fake: FakeBackupK8s;

/** A namespace, a data PVC, a running app and its image for a fixture instance (its row has none). */
async function inCluster(id: string) {
  const i = await instance(h, id);
  const env = i.environment_id ?? `env-${id}`;
  await h.db.updateTable("instances").set({ environment_id: env }).where("id", "=", id).execute();
  h.tenants.set(env, `t-${id}`);
  fake.pvcs.set(`t-${id}`, `powerhouse-t-${id}-app-data`);
  fake.deployments.set(`t-${id}`, { [`powerhouse-t-${id}-app`]: 1 });
  fake.images.set(`t-${id}`, [`${i.target_repository}:${i.target_version}@${i.target_digest}`]);
}
const runsTarget = async (id: string) => {
  const i = await instance(h, id);
  fake.images.set(`t-${id}`, [`${i.target_repository}:${i.target_version}@${i.target_digest}`]);
};

beforeEach(async () => {
  ({ h, appId } = await rolloutHarness());
  fake = fakeBackupK8s();
  h.deps.cfg = { ...h.deps.cfg, backups: { enabled: true, dailyKeepDays: 14, maxInFlight: 3 } };
  h.deps.backups = {
    k8s: fake.k8s,
    dumpJob: { image: "cr.vetra.io/x/d:1", bucket: "dumps", s3Endpoint: "https://s3.test", s3AccessKey: "AK", s3SecretKey: "SK" },
    archiveImage: "cr.vetra.io/x/d:1.1",
    deleteObject: async () => {},
  };
  await seedPlan(h, appId, { id: "p-pro", slug: "pro", access: "own" });
  await readyInstance(h, appId, { id: "o1", planId: "p-pro", kind: "own", holder: HOLDER_A });
  await inCluster("o1");
});
afterEach(async () => {
  await h.close();
});

/** One reconciler pass of the App: backups, restores, then the rollouts (as reconcileApp orders them). */
const pass = async () => {
  const app = (await getApp(h.db, appId))!;
  await advanceBackups(h.deps, appId);
  await advanceRestores(h.deps, app);
  await advanceRollouts(h.deps, app);
};
const statuses = async (id: string) => (await stepsOf(h.db, id)).map((s) => `${s.instance_id}:${s.status}`);
const start = () => startRollout(h.deps, owner, { appId, version: "1.4.1", planIds: ["p-pro"], noticeHours: 0 });
const migrates = () => h.db.updateTable("releases").set({ migrates: true }).where("version", "=", "1.4.1").execute();
/** Restore Jobs finish; a handed-back instance runs its target. */
async function settleRestores() {
  for (let n = 0; n < 20 && (await activeRestoresOfApp(h.db, appId)).length > 0; n++) {
    await finishBackupJobs(h, fake);
    fake.finish("pgrestore-");
    fake.finish("datarestore-");
    for (const r of await activeRestoresOfApp(h.db, appId)) if (r.target_set) await runsTarget(r.instance_id);
    await pass();
  }
}

describe("rollouts with backups (spec 7 step 4)", () => {
  it("backs up before it moves the instance; the target moves once the backup is ready", async () => {
    const r = await start();
    await pass();
    expect(await statuses(r.id)).toEqual(["o1:backing_up"]);
    expect((await instance(h, "o1")).target_version).toBe("1.4.0");
    const [step] = await stepsOf(h.db, r.id);
    const [b] = await listBackupsOfInstance(h.db, "o1", 5);
    expect(b).toMatchObject({ reason: "pre_update", status: "pending", rollout_step_id: step.id });
    expect(step.backup_id).toBe(b.id);
    await pass();
    expect(await statuses(r.id)).toEqual(["o1:backing_up"]);
    await finishBackupJobs(h, fake);
    await pass();
    expect(await statuses(r.id)).toEqual(["o1:applying"]);
    expect(await instance(h, "o1")).toMatchObject({ target_version: "1.4.1", target_digest: digest("c") });
    await becomeReady(h, "o1");
    await pass();
    expect(await statuses(r.id)).toEqual(["o1:succeeded"]);
  });

  it("a failed backup pauses the rollout before anything moves", async () => {
    const r = await start();
    await pass();
    await finishBackupJobs(h, fake, "dump_failed");
    await pass();
    expect(await statuses(r.id)).toEqual(["o1:failed"]);
    expect(await getRollout(h.db, r.id)).toMatchObject({
      status: "paused",
      paused_reason: expect.stringMatching(/backup failed: database dump: pg_dump: boom/),
    });
    expect((await instance(h, "o1")).target_version).toBe("1.4.0");
  });

  it("a failed update of a release that migrates restores its backup, then the step is failed and the rollout paused", async () => {
    await migrates();
    const r = await start();
    await pass();
    await finishBackupJobs(h, fake);
    await pass();
    await runsTarget("o1");
    await failUpdate(h, "o1");
    await pass();
    expect(await statuses(r.id)).toEqual(["o1:restoring"]);
    expect((await getRollout(h.db, r.id))!.status).toBe("paused");
    expect((await activeRestoresOfApp(h.db, appId))[0]).toMatchObject({
      purpose: "failed_update",
      then_version: "1.4.0",
      instance_id: "o1",
    });
    await settleRestores();
    await pass();
    expect((await stepsOf(h.db, r.id))[0]).toMatchObject({
      status: "failed",
      note: "restored the backup from before the update",
    });
    expect(await instance(h, "o1")).toMatchObject({ target_version: "1.4.0", maintenance: null });
  });

  it("rolling back a release that migrates needs acceptDataLoss and restores the backup from before the update", async () => {
    await migrates();
    const r = await start();
    await pass();
    await finishBackupJobs(h, fake);
    await pass();
    await becomeReady(h, "o1");
    await pass();
    expect(await statuses(r.id)).toEqual(["o1:succeeded"]);
    await expect(rollBackRollout(h.deps, owner, r.id)).rejects.toThrow(/acceptDataLoss/);
    await rollBackRollout(h.deps, owner, r.id, { acceptDataLoss: true });
    await pass();
    expect(await statuses(r.id)).toEqual(["o1:restoring"]);
    expect((await activeRestoresOfApp(h.db, appId))[0]).toMatchObject({ purpose: "rollback", then_version: "1.4.0" });
    await settleRestores();
    expect(await statuses(r.id)).toEqual(["o1:reverting"]);
    await becomeReady(h, "o1");
    await pass();
    expect(await statuses(r.id)).toEqual(["o1:rolled_back"]);
    expect((await getRollout(h.db, r.id))!.status).toBe("rolled_back");
  });

  it("with backups off, rollouts are slice 3's: straight to applying, and a migrates rollback is refused", async () => {
    h.deps.cfg = { ...h.deps.cfg, backups: { enabled: false, dailyKeepDays: 14, maxInFlight: 3 } };
    const r = await start();
    await pass();
    expect(await statuses(r.id)).toEqual(["o1:applying"]);
    expect(await listBackupsOfInstance(h.db, "o1", 5)).toEqual([]);
    await migrates();
    await expect(rollBackRollout(h.deps, owner, r.id, { acceptDataLoss: true })).rejects.toThrow(/VETRA_APPS_BACKUPS/);
  });
});

describe("rollouts with backups: pausing, rolling back mid-update, ordering", () => {
  it("a rollout paused while its backup runs starts the step again later, with a fresh backup", async () => {
    const r = await start();
    await pass();
    const [first] = await stepsOf(h.db, r.id);
    await pauseRollout(h.deps, owner, r.id);
    await finishBackupJobs(h, fake);
    await pass();
    const [s] = await stepsOf(h.db, r.id);
    expect(s).toMatchObject({ status: "pending", backup_id: null });
    expect((await instance(h, "o1")).target_version).toBe("1.4.0");
    expect(first.backup_id).not.toBeNull();
  });

  it("rolling back while a release that migrates is applying waits for it, then restores (never an image swap)", async () => {
    await migrates();
    const r = await start();
    await pass();
    await finishBackupJobs(h, fake);
    await pass();
    expect(await statuses(r.id)).toEqual(["o1:applying"]);
    await rollBackRollout(h.deps, owner, r.id, { acceptDataLoss: true });
    expect(await statuses(r.id)).toEqual(["o1:revert_pending"]);
    await becomeReady(h, "o1");
    await pass();
    expect(await statuses(r.id)).toEqual(["o1:restoring"]);
    await settleRestores();
    expect(await statuses(r.id)).toEqual(["o1:reverting"]);
  });

  /** A rollout of 1.4.1 whose o1 applies (updating), rolled back; returns it. */
  async function rolledBackWhileUpdating() {
    await migrates();
    const r = await start();
    await pass();
    await finishBackupJobs(h, fake);
    await pass();
    expect(await statuses(r.id)).toEqual(["o1:applying"]);
    // The reconciler applies the target: the instance is updating.
    await h.db.updateTable("instances").set({ status: "updating" }).where("id", "=", "o1").execute();
    return r;
  }

  it("a rollback while applying: a joined instance does not move before the applying one settled", async () => {
    const r = await rolledBackWhileUpdating();
    await readyInstance(h, appId, { id: "o3", planId: "p-pro", kind: "own", holder: HOLDER_A, version: "1.4.1" });
    await inCluster("o3");
    await rollBackRollout(h.deps, owner, r.id, { acceptDataLoss: true });
    expect(await statuses(r.id)).toEqual(["o1:revert_pending", "o3:revert_pending"]);
    await pass();
    expect(await statuses(r.id)).toEqual(["o1:revert_pending", "o3:revert_pending"]);
    expect((await instance(h, "o3")).target_version).toBe("1.4.1");
    expect(await activeRestoresOfApp(h.db, appId)).toHaveLength(0);
    await becomeReady(h, "o1");
    await pass();
    // The joined instance (higher position) goes back first, image only; then o1 restores.
    expect(await statuses(r.id)).toEqual(["o1:revert_pending", "o3:reverting"]);
    await becomeReady(h, "o3");
    await pass();
    expect(await statuses(r.id)).toEqual(["o1:restoring", "o3:rolled_back"]);
    expect(await activeRestoresOfApp(h.db, appId)).toHaveLength(1);
  });

  it("a rollback while applying: an older forward rollout of another plan does not start meanwhile", async () => {
    await seedPlan(h, appId, { id: "p-b", slug: "b", access: "own" });
    await readyInstance(h, appId, { id: "o2", planId: "p-b", kind: "own", holder: HOLDER_A });
    await inCluster("o2");
    // Older, waiting on its notice.
    const older = await startRollout(h.deps, owner, { appId, version: "1.5.0", planIds: ["p-b"], noticeHours: 48 });
    const r = await rolledBackWhileUpdating();
    await rollBackRollout(h.deps, owner, r.id, { acceptDataLoss: true });
    h.clock.now = new Date(h.clock.now.getTime() + 72 * 3600_000);
    await pass();
    expect(await statuses(older.id)).toEqual(["o2:pending"]);
    expect(await statuses(r.id)).toEqual(["o1:revert_pending"]);
    expect(await activeRestoresOfApp(h.db, appId)).toHaveLength(0);
    await becomeReady(h, "o1");
    await pass();
    // The older rollout is due and goes first; once it is done the restore starts.
    expect(await statuses(older.id)).toEqual(["o2:backing_up"]);
  });

  it("a held instance (failed restore) fails the step instead of updating it", async () => {
    await h.db
      .updateTable("instances")
      .set({ maintenance: "held:r-0" })
      .where("id", "=", "o1")
      .execute();
    const r = await start();
    await pass();
    expect((await stepsOf(h.db, r.id))[0].status).toBe("failed");
    expect((await instance(h, "o1")).target_version).toBe("1.4.0");
  });
});
