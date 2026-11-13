import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely, sql } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { ensureSwitchoverSchema, up } from "../db/migrations.js";
import type { VetraAppsDB } from "../db/schema.js";
import {
  getSwitchover,
  hasOpenSwitchover,
  insertSwitchover,
  listSwitchovers,
  openSwitchoverOfEnvironment,
  SwitchoverRaceError,
  updateSwitchover,
} from "../switchover/repo.js";
import { AUDIT_ACTIONS } from "../audit/repo.js";

const T = "2026-11-12T00:00:00.000Z";
import { switchoverRow } from "./switchover-fixtures.js";

async function appsDb() {
  const root = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
  await sql`CREATE SCHEMA "vetra-apps"`.execute(root);
  const any = root.withSchema("vetra-apps");
  await up(any);
  return { db: any as unknown as Kysely<VetraAppsDB>, any, root };
}

describe("switchovers schema", () => {
  it("is created idempotently and concurrently, with instances.switchover_id", async () => {
    const { db, any, root } = await appsDb();
    try {
      await Promise.all([1, 2, 3].map(() => ensureSwitchoverSchema(any)));
      await up(any);
      const { rows } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_schema = 'vetra-apps'
          AND ((table_name = 'switchovers' AND column_name = 'state')
            OR (table_name = 'instances' AND column_name = 'switchover_id'))`.execute(
        root,
      );
      expect(rows[0].n).toBe(2);
      expect(await listSwitchovers(db, "a1")).toEqual([]);
    } finally {
      await root.destroy();
    }
  });

  it("knows the audit actions", () => {
    for (const a of [
      "switchover.planned",
      "switchover.state",
      "switchover.failed",
      "switchover.linked",
      "switchover.confirmed",
      "switchover.rolled_back",
      "switchover.kind_adopted",
      "releases.frozen",
      "releases.unfrozen",
    ])
      expect(AUDIT_ACTIONS).toContain(a);
  });
});

describe("switchover repo", () => {
  it("stores, reads and lists newest first", async () => {
    const { db, root } = await appsDb();
    try {
      const stored = await insertSwitchover(db, switchoverRow());
      expect(stored).toStrictEqual(switchoverRow());
      await insertSwitchover(
        db,
        switchoverRow({
          id: "s2",
          environment_id: "env-2",
          created_at: "2026-11-13T00:00:00.000Z",
        }),
      );
      expect((await listSwitchovers(db, "a1")).map((r) => r.id)).toEqual([
        "s2",
        "s1",
      ]);
      expect(await listSwitchovers(db, "other")).toEqual([]);
      expect(await getSwitchover(db, "nope")).toBeNull();
    } finally {
      await root.destroy();
    }
  });

  it("compare-and-sets on the state: a second runner loses", async () => {
    const { db, root } = await appsDb();
    try {
      await insertSwitchover(db, switchoverRow());
      const next = await updateSwitchover(
        db,
        "s1",
        { state: "PREPARING", step_started_at: T },
        "t2",
        "PLANNED",
      );
      expect(next).toMatchObject({
        state: "PREPARING",
        step_started_at: T,
        updated_at: "t2",
      });
      await expect(
        updateSwitchover(db, "s1", { state: "PREPARING" }, "t3", "PLANNED"),
      ).rejects.toBeInstanceOf(SwitchoverRaceError);
      expect((await getSwitchover(db, "s1"))?.updated_at).toBe("t2");
    } finally {
      await root.destroy();
    }
  });

  it("allows one real switch-over per environment unless the first was rolled back; dry runs are free", async () => {
    const { db, root } = await appsDb();
    try {
      await insertSwitchover(db, switchoverRow());
      await expect(
        insertSwitchover(db, switchoverRow({ id: "s2" })),
      ).rejects.toThrow();
      await insertSwitchover(db, switchoverRow({ id: "d1", mode: "dry_run" }));
      await insertSwitchover(db, switchoverRow({ id: "d2", mode: "dry_run" }));
      expect((await openSwitchoverOfEnvironment(db, "env-1"))?.id).toBe("s1");
      await updateSwitchover(db, "s1", { state: "ROLLED_BACK" }, T, "PLANNED");
      expect(await openSwitchoverOfEnvironment(db, "env-1")).toBeNull();
      await insertSwitchover(db, switchoverRow({ id: "s2" }));
      expect((await openSwitchoverOfEnvironment(db, "env-1"))?.id).toBe("s2");
    } finally {
      await root.destroy();
    }
  });

  it("hasOpenSwitchover: open until DONE, CLEANED or ROLLED_BACK; a failed one stays open", async () => {
    const { db, root } = await appsDb();
    try {
      expect(await hasOpenSwitchover(db, "p1")).toBe(false);
      await insertSwitchover(db, switchoverRow());
      expect(await hasOpenSwitchover(db, "p1")).toBe(true);
      expect(await hasOpenSwitchover(db, "p2")).toBe(false);
      await updateSwitchover(
        db,
        "s1",
        { state: "FAILED", failed_state: "RESTORING" },
        T,
        "PLANNED",
      );
      expect(await hasOpenSwitchover(db, "p1")).toBe(true);
      await updateSwitchover(db, "s1", { state: "DONE" }, T, "FAILED");
      expect(await hasOpenSwitchover(db, "p1")).toBe(false);
    } finally {
      await root.destroy();
    }
  });

  it("cuts an error to 500 characters", async () => {
    const { db, root } = await appsDb();
    try {
      await insertSwitchover(db, switchoverRow());
      const r = await updateSwitchover(
        db,
        "s1",
        { state: "FAILED", error: "x".repeat(900) },
        T,
        "PLANNED",
      );
      expect(r.error).toHaveLength(500);
    } finally {
      await root.destroy();
    }
  });
});
