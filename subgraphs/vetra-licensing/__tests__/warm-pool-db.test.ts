import { describe, it, expect, afterEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import type { VetraLicensingDB } from "../db/schema.js";
import { createWarmPoolStore } from "../warm-pool-db.js";

describe("warm pool store (real PGlite)", () => {
  let db: Kysely<VetraLicensingDB> | undefined;
  const open = async () => {
    db = new Kysely<VetraLicensingDB>({ dialect: new PGliteDialect(new PGlite()) });
    await up(db as Kysely<any>);
    return createWarmPoolStore(db);
  };
  afterEach(async () => {
    await db?.destroy();
    db = undefined;
  });
  const ins = (s: Awaited<ReturnType<typeof open>>, id: string, nowIso = "2026-11-01T00:00:00.000Z", hash = "h1") =>
    s.insertWarming({ environmentId: id, appId: "app", templateId: "t", templateHash: hash, nowIso });
  const claim = (s: Awaited<ReturnType<typeof open>>, hash = "h1") =>
    s.claimOneAvailable({ appId: "app", templateId: "t", templateHash: hash, rootLicenseId: "root-1", nowIso: "2026-11-02T00:00:00.000Z" });

  it("insert gives WARMING, markAvailable gives AVAILABLE", async () => {
    const s = await open();
    await ins(s, "e1");
    expect((await s.live("app", "t")).map((r) => [r.environment_id, r.state])).toEqual([["e1", "WARMING"]]);
    await s.markAvailable("e1", "2026-11-01T00:05:00.000Z");
    const [r] = await s.allLive();
    expect(r.state).toBe("AVAILABLE");
    expect(r.ready_at).toBe("2026-11-01T00:05:00.000Z");
  });

  it("claims the oldest-ready matching row and marks it CLAIMED", async () => {
    const s = await open();
    await ins(s, "late");
    await ins(s, "early");
    await s.markAvailable("late", "2026-11-01T00:10:00.000Z");
    await s.markAvailable("early", "2026-11-01T00:05:00.000Z");
    const got = await claim(s);
    expect(got?.environment_id).toBe("early");
    expect(got?.state).toBe("CLAIMED");
    expect(got?.root_license_id).toBe("root-1");
    expect(got?.claimed_at).toBe("2026-11-02T00:00:00.000Z");
  });

  it("two concurrent claims get different rows", async () => {
    const s = await open();
    await ins(s, "a");
    await ins(s, "b");
    await s.markAvailable("a", "2026-11-01T00:05:00.000Z");
    await s.markAvailable("b", "2026-11-01T00:06:00.000Z");
    const [x, y] = await Promise.all([claim(s), claim(s)]);
    expect(x && y).toBeTruthy();
    expect(x!.environment_id).not.toBe(y!.environment_id);
  });

  it("a wrong templateHash claims nothing", async () => {
    const s = await open();
    await ins(s, "a");
    await s.markAvailable("a", "2026-11-01T00:05:00.000Z");
    expect(await claim(s, "other")).toBeNull();
  });

  it("releaseClaim makes the row claimable again", async () => {
    const s = await open();
    await ins(s, "a");
    await s.markAvailable("a", "2026-11-01T00:05:00.000Z");
    expect(await claim(s)).not.toBeNull();
    expect(await claim(s)).toBeNull();
    await s.releaseClaim("a");
    const again = await claim(s);
    expect(again?.environment_id).toBe("a");
  });

  it("isWarm is null for CLAIMED and deleted rows", async () => {
    const s = await open();
    await ins(s, "a");
    await ins(s, "b");
    await ins(s, "c");
    await s.markAvailable("a", "2026-11-01T00:05:00.000Z");
    expect(await s.isWarm("a")).toEqual({ appId: "app" });
    expect(await s.isWarm("b")).toEqual({ appId: "app" });
    await claim(s);
    expect(await s.isWarm("a")).toBeNull();
    await s.markDeleted("b", "2026-11-02T00:00:00.000Z");
    expect(await s.isWarm("b")).toBeNull();
    expect(await s.isWarm("nope")).toBeNull();
    expect((await s.allLive()).map((r) => r.environment_id).sort()).toEqual(["a", "c"]);
  });

  it("warmHours splits a row across a month boundary", async () => {
    const s = await open();
    await ins(s, "a", "2026-10-31T22:00:00.000Z");
    await s.markDeleted("a", "2026-11-01T02:00:00.000Z");
    const oct = await s.warmHours("app", "t", "2026-10-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z");
    const nov = await s.warmHours("app", "t", "2026-11-01T00:00:00.000Z", "2026-12-01T00:00:00.000Z");
    expect(oct).toBe(2);
    expect(nov).toBe(2);
  });

  it("warmHours stops at claim and runs open rows to now", async () => {
    const s = await open();
    await ins(s, "a", "2026-11-01T00:00:00.000Z");
    await ins(s, "open", "2026-11-01T00:00:00.000Z");
    await s.markAvailable("a", "2026-11-01T01:00:00.000Z");
    await claim(s); // claimed_at 2026-11-02T00:00
    const h = await s.warmHours("app", "t", "2026-11-01T00:00:00.000Z", "2026-12-01T00:00:00.000Z", "2026-11-01T03:00:00.000Z");
    expect(h).toBe(24 + 3);
  });
  it("markDeletedUnclaimed retires an unclaimed row but never a CLAIMED or deleted one", async () => {
    const s = await open();
    await ins(s, "w");
    await ins(s, "c");
    await s.markAvailable("c", "2026-11-01T00:05:00.000Z");
    await claim(s);
    expect(await s.markDeletedUnclaimed("w", "2026-11-02T01:00:00.000Z")).toBe(true);
    expect(await s.markDeletedUnclaimed("w", "2026-11-02T02:00:00.000Z")).toBe(false);
    expect(await s.markDeletedUnclaimed("c", "2026-11-02T01:00:00.000Z")).toBe(false);
    expect(await s.markDeletedUnclaimed("nope", "2026-11-02T01:00:00.000Z")).toBe(false);
    expect((await s.allLive()).map((r) => [r.environment_id, r.state])).toEqual([["c", "CLAIMED"]]);
  });
});
