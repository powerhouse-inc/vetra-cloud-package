import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import type { VetraLicensingDB } from "../db/schema.js";
import { loadLicensingConfig } from "../config.js";
import { createChainEnvironmentRows } from "../environments.js";
import {
  addDays, confirmedEndedRows, isLicenceStopped, markEnded, markResumed, offboardingAction,
  subscriptionWarnings, tickOffboarding, type OffboardingDeps,
} from "../offboarding.js";

const END = "2026-10-01T00:00:00.000Z";
const at = (days: number) => addDays(END, days);

describe("offboardingAction (the timeline)", () => {
  const ended = { endedAt: END, stoppedAt: null, deleteAfter: at(90) };
  it.each([
    [{ endedAt: null, stoppedAt: null, deleteAfter: null }, at(500), "none"],
    [ended, at(13.99), "none"],
    [ended, at(14), "stop"],
    [{ ...ended, stoppedAt: at(14) }, at(89.99), "none"],
    [{ ...ended, stoppedAt: at(14) }, at(90), "destroy"],
  ] as const)("%o at %s -> %s", (env, now, want) => {
    expect(offboardingAction(env, now)).toBe(want);
  });
});

describe("subscriptionWarnings", () => {
  const ded = { status: "ACTIVE", end: END, mode: "DEDICATED" as const, endedAt: null, stoppedAt: null, deleteAfter: null };
  it("compares instants: a date-only or offset end", () => {
    const dateOnly = { ...ded, end: "2026-10-01" };
    expect(subscriptionWarnings(dateOnly, at(-8))).toStrictEqual([]);
    expect(subscriptionWarnings(dateOnly, at(-7))).toStrictEqual([{ kind: "EXPIRING", at: END, message: "Your licence expires in 7 days." }]);
    const offset = { ...ded, end: "2026-10-01T02:00:00.000+02:00" }; // = END
    expect(subscriptionWarnings(offset, at(-1))[0]).toMatchObject({ at: END, message: "Your licence expires in 1 day." });
    expect(subscriptionWarnings({ ...ded, end: "garbage" }, at(-1))).toStrictEqual([]);
  });
  it("shows no stop banner once the stop time has passed, and a renewal call to action once stopped", () => {
    const off = { ...ded, status: "EXPIRED", endedAt: END, deleteAfter: at(90) };
    expect(subscriptionWarnings(off, at(14))).toStrictEqual([]);
    expect(subscriptionWarnings({ ...off, stoppedAt: at(14) }, at(20))[0]!.message).toContain("Renew");
  });
  it("warns from end - 7 days, with the days left", () => {
    expect(subscriptionWarnings(ded, at(-8))).toStrictEqual([]);
    expect(subscriptionWarnings(ded, at(-7))).toStrictEqual([{ kind: "EXPIRING", at: END, message: "Your licence expires in 7 days." }]);
    expect(subscriptionWarnings(ded, at(-1))[0]!.message).toBe("Your licence expires in 1 day.");
  });
  it("after the end: shutdown in 14 days, then deletion pending, then imminent", () => {
    const off = { ...ded, status: "EXPIRED", endedAt: END, deleteAfter: at(90) };
    expect(subscriptionWarnings(off, at(1))).toStrictEqual([{ kind: "ENDED_STOP_PENDING", at: at(14), message: `Your environment stops on ${at(14).slice(0, 10)}. Renew to keep it running.` }]);
    expect(subscriptionWarnings({ ...off, stoppedAt: at(14) }, at(20))[0]!.kind).toBe("STOPPED_DELETE_PENDING");
    expect(subscriptionWarnings({ ...off, stoppedAt: at(14) }, at(83))[0]).toMatchObject({ kind: "DELETE_IMMINENT", at: at(90) });
  });
  it("SHARED licences never warn about an environment", () => {
    expect(subscriptionWarnings({ ...ded, mode: "SHARED", status: "EXPIRED", endedAt: END }, at(1))).toStrictEqual([]);
  });
});

describe("offboarding against rows", () => {
  let db: Kysely<VetraLicensingDB>;
  let deps: OffboardingDeps;
  let status: Map<string, string>;
  let now = at(0);
  beforeEach(async () => {
    db = new Kysely<VetraLicensingDB>({ dialect: new PGliteDialect(new PGlite()) });
    await up(db as Kysely<any>);
    const rows = createChainEnvironmentRows(db, loadLicensingConfig({}));
    await rows.claim({ environment_id: "e1", root_license_id: "r", app_id: "a", user_did: "d", license_id: "r", template_id: null, label: null, template_hash: "h", ended_at: null, stopped_at: null, delete_after: null, created_at: "t", updated_at: "t" });
    status = new Map([["e1", "READY"]]);
    now = at(0);
    deps = {
      rows,
      envStatus: async (id) => status.get(id) ?? null,
      sleep: vi.fn(async (id) => { status.set(id, "STOPPED"); }),
      wake: vi.fn(async (id) => { status.set(id, "CHANGES_APPROVED"); }),
      destroy: vi.fn(async (id) => { status.delete(id); }),
      cfg: { destroyEnabled: true },
      logger: { info: vi.fn(), warn: vi.fn() },
      now: () => now,
    };
  });
  afterEach(async () => { await db.destroy(); });
  const row = () => deps.rows.byEnvironment("e1");

  it("walks the whole timeline, then re-licensing a stopped environment wakes it", async () => {
    await markEnded(deps, "e1");
    expect(await row()).toMatchObject({ ended_at: at(0), delete_after: at(90), stopped_at: null });
    now = at(14);
    await tickOffboarding(deps, [(await row())!]);
    expect(deps.sleep).toHaveBeenCalledWith("e1");
    expect((await row())!.stopped_at).toBe(at(14));
    now = at(30);
    await markResumed(deps, "e1");
    expect(deps.wake).toHaveBeenCalledWith("e1");
    expect(await row()).toMatchObject({ ended_at: null, stopped_at: null, delete_after: null });
  });

  it("re-stops a stopped environment someone woke", async () => {
    await markEnded(deps, "e1");
    now = at(14);
    await tickOffboarding(deps, [(await row())!]);
    status.set("e1", "READY");
    now = at(15);
    await tickOffboarding(deps, [(await row())!]);
    expect(deps.sleep).toHaveBeenCalledTimes(2);
  });

  it("does not stop an environment mid-deploy; retries next tick", async () => {
    await markEnded(deps, "e1");
    status.set("e1", "DEPLOYING");
    now = at(14);
    await tickOffboarding(deps, [(await row())!]);
    expect(deps.sleep).not.toHaveBeenCalled();
    expect((await row())!.stopped_at).toBeNull();
  });

  it("destroys at +90 days and forgets the row", async () => {
    await markEnded(deps, "e1");
    now = at(90);
    await tickOffboarding(deps, [(await row())!]);
    expect(deps.destroy).toHaveBeenCalledWith("e1");
    expect(await row()).toBeNull();
  });

  it("only logs the destroy while LICENSING_DESTROY_ENABLED is off", async () => {
    deps.cfg = { destroyEnabled: false };
    await markEnded(deps, "e1");
    now = at(90);
    await tickOffboarding(deps, [(await row())!]);
    expect(deps.destroy).not.toHaveBeenCalled();
    expect(await row()).not.toBeNull();
    expect(deps.logger.info).toHaveBeenCalledWith(expect.stringContaining("would destroy e1"));
  });

  it("reports licence-stopped environments for the housekeeping wake guard", async () => {
    expect(await isLicenceStopped(db, "e1")).toBe(false);
    await markEnded(deps, "e1");
    now = at(14);
    await tickOffboarding(deps, [(await row())!]);
    expect(await isLicenceStopped(db, "e1")).toBe(true);
    expect(await isLicenceStopped(db, "unknown")).toBe(false);
  });

  it("markEnded is idempotent and ignores unknown environments", async () => {
    await markEnded(deps, "e1");
    now = at(5);
    await markEnded(deps, "e1");
    expect(await row()).toMatchObject({ ended_at: at(0), delete_after: at(90) });
    await markEnded(deps, "nope");
    await markResumed(deps, "nope");
    expect(deps.wake).not.toHaveBeenCalled();
  });

  it("markResumed never wakes an environment the holder stopped themselves", async () => {
    status.set("e1", "STOPPED");
    await markEnded(deps, "e1");
    await markResumed(deps, "e1");
    expect(deps.wake).not.toHaveBeenCalled();
    expect(await row()).toMatchObject({ ended_at: null, delete_after: null });
  });

  it("a failing wake leaves the clock state alone", async () => {
    await markEnded(deps, "e1");
    now = at(14);
    await tickOffboarding(deps, [(await row())!]);
    (deps.wake as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));
    await expect(markResumed(deps, "e1")).rejects.toThrow("boom");
    expect((await row())!.stopped_at).toBe(at(14));
  });

  it("does nothing for a chain that has not ended, and logs the would-destroy once", async () => {
    now = at(500);
    await tickOffboarding(deps, [(await row())!]);
    expect(deps.sleep).not.toHaveBeenCalled();
    now = at(0);
    deps.cfg = { destroyEnabled: false };
    await markEnded(deps, "e1");
    now = at(90);
    const r = (await row())!;
    await tickOffboarding(deps, [r]);
    await tickOffboarding(deps, [r]);
    expect(deps.logger.info).toHaveBeenCalledTimes(1);
  });

  it("removes the row of an environment whose document is already gone; never stamps an already-down env", async () => {
    await markEnded(deps, "e1");
    status.set("e1", "STOPPED");
    now = at(14);
    await tickOffboarding(deps, [(await row())!]);
    expect(deps.sleep).not.toHaveBeenCalled();
    expect((await row())!.stopped_at).toBeNull();
    expect(await isLicenceStopped(db, "e1")).toBe(false);
    status.delete("e1");
    now = at(90);
    await tickOffboarding(deps, [(await row())!]);
    expect(deps.destroy).not.toHaveBeenCalled();
    expect(await row()).toBeNull();
  });

  it("logs and continues when a step fails", async () => {
    await markEnded(deps, "e1");
    now = at(14);
    (deps.sleep as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("nope"));
    await tickOffboarding(deps, [(await row())!]);
    expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining("e1 failed"));
    expect((await row())!.stopped_at).toBeNull();
  });

  it("is not licence-stopped when only stopped_at is set (holder sleep), or when the table is missing", async () => {
    await deps.rows.update("e1", { stopped_at: at(1) });
    expect(await isLicenceStopped(db, "e1")).toBe(false);
    const bare = new Kysely<VetraLicensingDB>({ dialect: new PGliteDialect(new PGlite()) });
    expect(await isLicenceStopped(bare, "e1")).toBe(false);
    await bare.destroy();
    const broken = { selectFrom: () => { throw Object.assign(new Error("x"), { code: "XX" }); } } as unknown as Kysely<VetraLicensingDB>;
    await expect(isLicenceStopped(broken, "e1")).rejects.toThrow("x");
  });

  it("an environment the holder stopped is not woken by markResumed after the clock ran", async () => {
    await markEnded(deps, "e1");
    status.set("e1", "STOPPED"); // the holder sleeps it
    now = at(14);
    await tickOffboarding(deps, [(await row())!]);
    await markResumed(deps, "e1");
    expect(deps.wake).not.toHaveBeenCalled();
    expect(await row()).toMatchObject({ ended_at: null, stopped_at: null, delete_after: null });
  });

  it("a holder-stopped environment someone wakes is re-stopped and then stamped", async () => {
    await markEnded(deps, "e1");
    status.set("e1", "STOPPED");
    now = at(14);
    await tickOffboarding(deps, [(await row())!]);
    status.set("e1", "READY");
    now = at(15);
    await tickOffboarding(deps, [(await row())!]);
    expect(deps.sleep).toHaveBeenCalledTimes(1);
    expect((await row())!.stopped_at).toBe(at(15));
  });

  it("confirmedEndedRows keeps only ended rows whose root was confirmed", async () => {
    await markEnded(deps, "e1");
    const r = (await row())!;
    expect(confirmedEndedRows([r], new Set(["r"]))).toStrictEqual([r]);
    expect(confirmedEndedRows([r], new Set())).toStrictEqual([]);
    expect(confirmedEndedRows([{ ...r, ended_at: null }], new Set(["r"]))).toStrictEqual([]);
  });
});
