import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import type { DatabaseRestores, ObservabilityDB } from "../db/schema.js";
import { DumpsRepo } from "../dumps/repo.js";
import { RestoresRepo } from "../dumps/restore-repo.js";
import {
  advanceRestore,
  STEP_TIMEOUT_MS,
  SWITCHBOARD_SELECTOR,
  type AdvanceDeps,
  type RestoreK8s,
} from "../dumps/restore.js";

const T0 = new Date("2026-10-27T10:00:00Z");
const later = (ms: number) => new Date(T0.getTime() + ms);

let db: Kysely<ObservabilityDB>;
let dumps: DumpsRepo;
let restores: RestoresRepo;
let k8s: { [K in keyof RestoreK8s]: ReturnType<typeof vi.fn> };
let deps: AdvanceDeps;
let onFinished: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  db = new Kysely<ObservabilityDB>({ dialect: new PGliteDialect(new PGlite()) });
  await up(db);
  dumps = new DumpsRepo(db);
  restores = new RestoresRepo(db);
  k8s = {
    createJob: vi.fn(async () => "pgrestore-x"),
    readJobStatus: vi.fn(async () => ({ active: 1 })),
    readPodLogsForJob: vi.fn(async () => "pg_restore: error: boom\n"),
    readDeploymentReplicas: vi.fn(async () => ({ "t1-switchboard": 1 })),
    scaleDeployment: vi.fn(async () => undefined),
    countPods: vi.fn(async () => 0),
    deploymentsReady: vi.fn(async () => true),
  };
  onFinished = vi.fn(async () => undefined);
  deps = {
    restores,
    dumps,
    k8s: k8s as unknown as RestoreK8s,
    buildJob: (row) => ({ metadata: { name: `pgrestore-${row.id}` } }),
    onFinished,
  };
});
afterEach(async () => db.destroy());

async function setup(safety: "PENDING" | "READY" | "FAILED" = "READY") {
  const target = await dumps.create({ documentId: "doc", tenantId: "t1", requestedBy: "0xabc", now: T0 });
  await dumps.markReady(target.id, `t1/${target.id}.dump`, 1, T0);
  const s = await dumps.create({ documentId: "doc", tenantId: "t1", requestedBy: "0xabc", now: T0, source: "PRE_RESTORE" });
  if (safety === "READY") await dumps.markReady(s.id, `t1/${s.id}.dump`, 1, T0);
  if (safety === "FAILED") await dumps.markFailed(s.id, "pg_dump: connection refused", T0);
  return restores.create({
    documentId: "doc", tenantId: "t1", dumpId: target.id, safetyDumpId: s.id, requestedBy: "0xabc", now: T0,
  });
}

const reload = async (r: DatabaseRestores) => (await restores.getById(r.id))!;
const step = async (r: DatabaseRestores, at: Date) => {
  await advanceRestore(await reload(r), deps, at);
  return reload(r);
};

describe("advanceRestore", () => {
  it("waits while the safety dump is still running", async () => {
    const r = await setup("PENDING");
    expect((await step(r, later(1000))).status).toBe("SAFETY_DUMP");
    expect(k8s.scaleDeployment).not.toHaveBeenCalled();
  });

  it("fails without touching anything when the safety dump fails", async () => {
    const r = await setup("FAILED");
    const after = await step(r, later(1000));
    expect(after.status).toBe("FAILED");
    expect(after.errorMessage).toMatch(/safety backup failed.*connection refused/i);
    expect(after.completedAt).not.toBeNull();
    expect(k8s.scaleDeployment).not.toHaveBeenCalled();
    expect(onFinished).toHaveBeenCalledTimes(1);
  });

  it("records replicas before stopping the Switchboard", async () => {
    const r = await setup();
    const after = await step(r, later(1000));
    expect(after.status).toBe("STOPPING");
    expect(JSON.parse(after.replicas!)).toEqual({ "t1-switchboard": 1 });
    expect(k8s.readDeploymentReplicas).toHaveBeenCalledWith("t1", SWITCHBOARD_SELECTOR);
    expect(k8s.scaleDeployment).toHaveBeenCalledWith("t1", "t1-switchboard", 0);
  });

  it("fails cleanly when the env has no Switchboard deployment", async () => {
    k8s.readDeploymentReplicas.mockResolvedValueOnce({});
    const r = await setup();
    const after = await step(r, later(1000));
    expect(after.status).toBe("FAILED");
    expect(k8s.scaleDeployment).not.toHaveBeenCalled();
  });

  it("starts the restore Job only once no Switchboard pods remain", async () => {
    const r = await setup();
    await step(r, later(1000));
    k8s.countPods.mockResolvedValueOnce(1);
    expect((await step(r, later(2000))).status).toBe("STOPPING");
    expect(k8s.createJob).not.toHaveBeenCalled();
    const after = await step(r, later(3000));
    expect(after.status).toBe("RESTORING");
    expect(after.jobName).toBe("pgrestore-x");
    expect(k8s.createJob.mock.calls[0][0]).toBe("t1");
  });

  it("gives up stopping after the step timeout and brings the Switchboard back", async () => {
    const r = await setup();
    await step(r, later(0));
    k8s.countPods.mockResolvedValue(1);
    const after = await step(r, later(STEP_TIMEOUT_MS + 1));
    expect(after.status).toBe("STARTING");
    expect(after.errorMessage).toMatch(/did not stop/i);
    expect(k8s.scaleDeployment).toHaveBeenLastCalledWith("t1", "t1-switchboard", 1);
    expect(k8s.createJob).not.toHaveBeenCalled();
  });

  it("succeeds: Job complete → scale back → ready", async () => {
    const r = await setup();
    await step(r, later(1000));
    await step(r, later(2000));
    k8s.readJobStatus.mockResolvedValueOnce({ succeeded: 1, conditions: [{ type: "Complete", status: "True" }] });
    const starting = await step(r, later(3000));
    expect(starting.status).toBe("STARTING");
    expect(k8s.scaleDeployment).toHaveBeenLastCalledWith("t1", "t1-switchboard", 1);
    k8s.deploymentsReady.mockResolvedValueOnce(false);
    expect((await step(r, later(4000))).status).toBe("STARTING");
    const done = await step(r, later(5000));
    expect(done.status).toBe("SUCCEEDED");
    expect(done.errorMessage).toBeNull();
    expect(done.completedAt).not.toBeNull();
    expect(onFinished).toHaveBeenCalledTimes(1);
  });

  it("fails with the Job's last log line and still brings the Switchboard back", async () => {
    const r = await setup();
    await step(r, later(1000));
    await step(r, later(2000));
    k8s.readJobStatus.mockResolvedValueOnce({ failed: 1, conditions: [{ type: "Failed", status: "True" }] });
    const starting = await step(r, later(3000));
    expect(starting.status).toBe("STARTING");
    expect(starting.errorMessage).toBe("pg_restore: error: boom");
    expect(k8s.scaleDeployment).toHaveBeenLastCalledWith("t1", "t1-switchboard", 1);
    expect((await step(r, later(4000))).status).toBe("FAILED");
  });

  it("treats a vanished Job as a failure", async () => {
    const r = await setup();
    await step(r, later(1000));
    await step(r, later(2000));
    k8s.readJobStatus.mockResolvedValueOnce(null);
    const after = await step(r, later(3000));
    expect(after.status).toBe("STARTING");
    expect(after.errorMessage).toMatch(/no longer exists/i);
  });

  it("resumes from persisted state after a subgraph restart", async () => {
    const r = await setup();
    await step(r, later(1000)); // STOPPING, replicas persisted
    // A fresh advancer (new process) only has the row.
    const after = await step(r, later(2000));
    expect(after.status).toBe("RESTORING");
  });
});
