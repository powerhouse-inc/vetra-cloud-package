import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely, sql } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { ensureEnvironmentHoldsTable, up } from "../db/migrations.js";
import { deleteHold, getHold, insertHold } from "../holds/repo.js";
import type { VetraAppsDB } from "../db/schema.js";
import {
  appPodGone,
  holdEnvironment,
  isHeld,
  releaseHold,
} from "../holds/service.js";
import { makeHarness, type Harness } from "./harness.js";

async function holdsDb(): Promise<{ db: Kysely<VetraAppsDB>; root: Kysely<any> }> {
  const root = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
  await sql`CREATE SCHEMA "vetra-apps"`.execute(root);
  const any = root.withSchema("vetra-apps");
  await up(any);
  return { db: any as unknown as Kysely<VetraAppsDB>, root };
}

const row = (over: Partial<{ reason: string; created_by: string }> = {}) => ({
  environment_id: "env-1",
  reason: over.reason ?? "licence ended",
  switchover_id: null,
  created_by: over.created_by ?? "vetra",
  created_at: "2026-11-12T00:00:00.000Z",
});

describe("environment holds repo", () => {
  it("keeps the first hold when an environment is held twice", async () => {
    const { db, root } = await holdsDb();
    try {
      const first = await insertHold(db, row());
      expect(first).toMatchObject({ environment_id: "env-1", reason: "licence ended" });
      const second = await insertHold(db, row({ reason: "switch-over", created_by: "0xaa" }));
      expect(second).toStrictEqual(first);
      expect(await getHold(db, "env-1")).toStrictEqual(first);
      expect(await getHold(db, "env-2")).toBeNull();
    } finally {
      await root.destroy();
    }
  });

  it("deletes a hold once", async () => {
    const { db, root } = await holdsDb();
    try {
      await insertHold(db, row());
      expect(await deleteHold(db, "env-1")).toBe(true);
      expect(await deleteHold(db, "env-1")).toBe(false);
      expect(await getHold(db, "env-1")).toBeNull();
    } finally {
      await root.destroy();
    }
  });

  it("creates the table idempotently and concurrently in the namespace schema", async () => {
    const { db, root } = await holdsDb();
    try {
      const any = db as unknown as Kysely<any>;
      await up(any);
      await Promise.all([1, 2, 3].map(() => ensureEnvironmentHoldsTable(any)));
      const { rows } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM information_schema.tables
        WHERE table_schema = 'vetra-apps' AND table_name = 'environment_holds'`.execute(root);
      expect(rows[0].n).toBe(1);
    } finally {
      await root.destroy();
    }
  });
});

describe("hold service", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(() => h.close());

  const deployedEnv = async (status: "READY" | "STOPPED" | "DRAFT" = "READY") => {
    const id = await h.envs.seedStandalone();
    h.envs.setStatus(id, status);
    h.envs.executed.length = 0;
    return id;
  };

  it("holds once and re-renders once (label unchanged, changes approved)", async () => {
    const id = await deployedEnv();
    const first = await holdEnvironment(h.deps, {
      environmentId: id,
      reason: "licence ended",
      switchoverId: null,
      by: "vetra",
    });
    expect(first.created).toBe(true);
    expect(await isHeld(h.deps, id)).toBe(true);
    expect(h.envs.executed).toEqual([
      { id, types: ["SET_LABEL", "APPROVE_CHANGES"] },
    ]);
    const state = await h.envs.getState(id);
    expect(state?.label).toBe("standalone");
    expect(state?.status).toBe("CHANGES_APPROVED");

    h.envs.executed.length = 0;
    const second = await holdEnvironment(h.deps, {
      environmentId: id,
      reason: "another",
      switchoverId: null,
      by: "vetra",
    });
    expect(second.created).toBe(false);
    expect(second.hold.reason).toBe("licence ended");
    expect(h.envs.executed).toEqual([]);
  });

  it("releases once and re-renders once; without a hold it does nothing", async () => {
    const id = await deployedEnv();
    await holdEnvironment(h.deps, { environmentId: id, reason: "r", switchoverId: null, by: "vetra" });
    h.envs.setStatus(id, "READY");
    h.envs.executed.length = 0;
    expect(await releaseHold(h.deps, id)).toBe(true);
    expect(await isHeld(h.deps, id)).toBe(false);
    expect(h.envs.executed).toEqual([{ id, types: ["SET_LABEL", "APPROVE_CHANGES"] }]);
    h.envs.executed.length = 0;
    expect(await releaseHold(h.deps, id)).toBe(false);
    expect(h.envs.executed).toEqual([]);
  });

  it("re-renders a licensed environment too (system-signed, no field changes)", async () => {
    const id = await deployedEnv();
    await h.envs.manage(id);
    h.envs.setStatus(id, "READY");
    h.envs.executed.length = 0;
    await holdEnvironment(h.deps, { environmentId: id, reason: "r", switchoverId: "sw-1", by: "vetra" });
    expect(h.envs.executed).toEqual([{ id, types: ["SET_LABEL", "APPROVE_CHANGES"] }]);
    expect((await h.envs.getState(id))?.managedBy?.rootLicenseId).toBe("license-1");
  });

  it("does not re-render a STOPPED or DRAFT environment (the hold applies at its next render)", async () => {
    for (const status of ["STOPPED", "DRAFT"] as const) {
      const id = await deployedEnv(status);
      await holdEnvironment(h.deps, { environmentId: id, reason: "r", switchoverId: null, by: "vetra" });
      expect(await isHeld(h.deps, id)).toBe(true);
      expect(h.envs.executed).toEqual([]);
      expect((await h.envs.getState(id))?.status).toBe(status);
    }
  });

  it("approves pending changes instead of adding a label change", async () => {
    const id = await deployedEnv();
    h.envs.setStatus(id, "CHANGES_PENDING");
    await holdEnvironment(h.deps, { environmentId: id, reason: "r", switchoverId: null, by: "vetra" });
    expect(h.envs.executed).toEqual([{ id, types: ["APPROVE_CHANGES"] }]);
  });

  it("logs a hold, a release and an approval of pending changes", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const id = await deployedEnv();
      h.envs.setStatus(id, "CHANGES_PENDING");
      await holdEnvironment(h.deps, { environmentId: id, reason: "licence ended", switchoverId: null, by: "vetra" });
      h.envs.setStatus(id, "READY");
      await releaseHold(h.deps, id);
      const lines = info.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes(`hold on ${id}: licence ended`))).toBe(true);
      expect(lines.some((l) => l.includes(`re-render of ${id} approves its pending changes`))).toBe(true);
      expect(lines.some((l) => l.includes(`hold on ${id} released`))).toBe(true);
    } finally {
      info.mockRestore();
    }
  });

  describe("appPodGone", () => {
    const at = () => h.clock.now.toISOString();
    const status = (tenantId: string, updatedAt = at()) =>
      h.obsDb
        .insertInto("environment_status")
        .values({
          tenantId,
          argoSyncStatus: "SYNCED",
          argoHealthStatus: "HEALTHY",
          argoLastSyncedAt: updatedAt,
          argoMessage: null,
          configDriftDetected: 0,
          tlsCertValid: null,
          tlsCertExpiresAt: null,
          domainResolves: null,
          updatedAt,
        })
        .execute();
    const pod = (tenantId: string, name: string, component: string | null) =>
      h.obsDb
        .insertInto("environment_pods")
        .values({
          id: `${tenantId}/${name}`,
          tenantId,
          name,
          service: "OTHER",
          component,
          agent: null,
          phase: "Running",
          ready: 1,
          restartCount: 0,
          updatedAt: at(),
        })
        .execute();

    it("is true when only database pods are left", async () => {
      await status("t1");
      await pod("t1", "t1-pg-1", "database");
      await pod("t1", "t1-pg-pooler-x", "pooler");
      expect(await appPodGone(h.deps, "t1")).toBe(true);
    });
    it("is false while an app, switchboard or connect pod is there", async () => {
      for (const [t, c] of [["ta", "app"], ["ts", "switchboard"], ["tc", "connect"]] as const) {
        await status(t);
        await pod(t, `${t}-x`, c);
        expect(await appPodGone(h.deps, t)).toBe(false);
      }
    });
    it("is false on stale cluster data, and without observability", async () => {
      await status("t1", new Date(h.clock.now.getTime() - 10 * 60_000).toISOString());
      expect(await appPodGone(h.deps, "t1")).toBe(false);
      expect(await appPodGone({ ...h.deps, observabilityDb: null }, "t1")).toBe(false);
    });
  });
});
