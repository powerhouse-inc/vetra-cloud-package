import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import type { LicenseEnvironments, VetraLicensingDB } from "../db/schema.js";
import {
  createRolloutStore,
  type RolloutQueries,
  type RolloutStore,
} from "../rollout-db.js";
import {
  activeUpdateGate,
  createUpdateGate,
  type UpdateGate,
} from "../update-gate.js";

const NOW = "2026-11-10T12:00:00.000Z";
const LATER = "2026-11-13T12:00:00.000Z";
const MOVE = {
  artifactName: "host",
  from: "1.0.0",
  to: "1.1.0",
  stranded: false,
};
const envRow = (
  over: Partial<LicenseEnvironments> = {},
): LicenseEnvironments => ({
  environment_id: "e1",
  root_license_id: "l1",
  app_id: "a",
  user_did: "did:pkh:eip155:1:0x1",
  license_id: "l1",
  template_id: "t",
  label: null,
  template_hash: "h",
  channel_override: null,
  ended_at: null,
  stopped_at: null,
  delete_after: null,
  created_at: NOW,
  updated_at: NOW,
  ...over,
});

let db: Kysely<VetraLicensingDB>;
let store: RolloutStore;
let gate: UpdateGate;
let warn: ReturnType<typeof vi.fn>;
let info: ReturnType<typeof vi.fn>;
let n: number;
beforeEach(async () => {
  db = new Kysely<VetraLicensingDB>({
    dialect: new PGliteDialect(new PGlite()),
  });
  await up(db as Kysely<any>);
  store = createRolloutStore(db);
  warn = vi.fn();
  info = vi.fn();
  n = 0;
  gate = createUpdateGate({
    store,
    logger: { warn, info },
    newId: () => `u${++n}`,
  });
});
afterEach(async () => {
  await db.destroy();
});

const gated = () =>
  store.saveSettings(
    { appId: "a", policy: "GATED", defaultNoticeHours: 72 },
    NOW,
  );
const promote = (
  over: { apply_after?: string; status?: "ACTIVE" | "PAUSED" } = {},
) =>
  store.promote({
    id: "r1",
    app_id: "a",
    artifact_name: "host",
    version: "1.1.0",
    status: over.status ?? "ACTIVE",
    apply_after: over.apply_after ?? LATER,
    promoted_by: "0xp",
    promoted_at: NOW,
    paused_at: null,
    paused_reason: null,
  });
/** The real store, with the queries of its transactions passed through `wrap`. */
const wrapped = (
  wrap: (q: RolloutQueries) => RolloutQueries,
): RolloutStore => ({
  ...store,
  inTransaction: (fn) => store.inTransaction((q) => fn(wrap(q))),
});

describe("createUpdateGate", () => {
  it("records an AUTO app's update APPLYING and lets the floor move it", async () => {
    expect(
      await gate.admit({ row: envRow(), move: MOVE, now: NOW }),
    ).toStrictEqual({ version: "floor", updateId: "u1" });
    expect(await store.update("u1")).toMatchObject({
      rollout_id: null,
      status: "APPLYING",
      started_at: NOW,
      environment_id: "e1",
      app_id: "a",
    });
  });

  it("supersedes an AUTO app's applying update when a newer version comes", async () => {
    await gate.admit({ row: envRow(), move: MOVE, now: NOW });
    const newer = { ...MOVE, from: "1.1.0", to: "1.2.0" };
    expect(
      await gate.admit({ row: envRow(), move: newer, now: LATER }),
    ).toStrictEqual({ version: "floor", updateId: "u2" });
    expect(await store.update("u1")).toMatchObject({
      status: "SUPERSEDED",
      finished_at: LATER,
    });
    expect(await store.update("u2")).toMatchObject({
      status: "APPLYING",
      to_version: "1.2.0",
    });
  });

  it("holds a gated customer until due, then starts it on a later admit", async () => {
    await gated();
    await promote();
    expect(
      await gate.admit({ row: envRow(), move: MOVE, now: NOW }),
    ).toStrictEqual({ version: "hold", updateId: null });
    expect(await store.updateFor("r1", "e1")).toMatchObject({
      id: "u1",
      status: "PENDING",
      due_at: LATER,
    });
    expect(
      await gate.admit({ row: envRow(), move: MOVE, now: LATER }),
    ).toStrictEqual({ version: "floor", updateId: "u1" });
    expect(await store.update("u1")).toMatchObject({
      status: "APPLYING",
      started_at: LATER,
    });
    expect(await store.history("e1", 20)).toHaveLength(1);
  });

  it("starts only one environment of a gated app at a time", async () => {
    await gated();
    await promote({ apply_after: NOW });
    expect(
      (await gate.admit({ row: envRow(), move: MOVE, now: NOW })).version,
    ).toBe("floor");
    const second = envRow({ environment_id: "e2", root_license_id: "l2" });
    expect(
      (await gate.admit({ row: second, move: MOVE, now: NOW })).version,
    ).toBe("hold");
    expect(await store.updateFor("r1", "e2")).toMatchObject({
      status: "PENDING",
    });
  });

  it("moves a customer that missed a COMPLETE rollout, recording it under that rollout", async () => {
    await gated();
    await promote({ apply_after: NOW });
    expect(await store.complete("r1")).toBe(true);
    expect(
      await gate.admit({ row: envRow(), move: MOVE, now: LATER }),
    ).toStrictEqual({ version: "floor", updateId: "u1" });
    expect(await store.update("u1")).toMatchObject({
      rollout_id: "r1",
      status: "APPLYING",
      due_at: NOW,
    });
    expect((await store.rollout("r1"))!.status).toBe("COMPLETE");
  });

  it("holds a customer whose version's only rollout was superseded, writing nothing", async () => {
    await gated();
    await promote({ apply_after: NOW });
    await store.promote({
      ...(await store.rollout("r1"))!,
      id: "r2",
      version: "1.2.0",
    });
    expect(
      await gate.admit({ row: envRow(), move: MOVE, now: LATER }),
    ).toStrictEqual({ version: "hold", updateId: null });
    expect(await store.history("e1", 20)).toStrictEqual([]);
  });

  it("revives the update of a customer whose chain ended and was resumed, and starts it", async () => {
    await gated();
    await promote({ apply_after: NOW });
    await store.insertUpdate({
      id: "u0",
      rollout_id: "r1",
      environment_id: "e1",
      app_id: "a",
      from_version: "1.0.0",
      to_version: "1.1.0",
      status: "SUPERSEDED",
      due_at: NOW,
      requested_at: null,
      started_at: null,
      finished_at: NOW,
      pre_update_dump_id: null,
      error: "environment ended",
      forced_at: null,
      created_at: NOW,
    });
    expect(
      await gate.admit({ row: envRow(), move: MOVE, now: LATER }),
    ).toStrictEqual({ version: "floor", updateId: "u0" });
    expect(await store.update("u0")).toMatchObject({
      status: "APPLYING",
      due_at: NOW,
      started_at: LATER,
      finished_at: null,
      error: null,
    });
    expect(await store.history("e1", 20)).toHaveLength(1);
  });

  it("revives nothing when the ended update moved on after it was read", async () => {
    await gated();
    await promote({ apply_after: NOW });
    await gate.admit({ row: envRow(), move: MOVE, now: NOW });
    await store.finishUpdate("u1", "SUCCEEDED", null, NOW);
    const transitions: unknown[][] = [];
    const racing = createUpdateGate({
      store: wrapped((q) => ({
        ...q,
        updateFor: async (rolloutId, environmentId) => {
          const read = await q.updateFor(rolloutId, environmentId);
          return (
            read && {
              ...read,
              status: "SUPERSEDED",
              error: "environment ended",
            }
          );
        },
        transitionUpdate: (...args) => {
          transitions.push(args);
          return q.transitionUpdate(...args);
        },
      })),
      logger: { warn, info },
      newId: () => "u2",
    });
    expect(
      await racing.admit({ row: envRow(), move: MOVE, now: LATER }),
    ).toStrictEqual({ version: "hold", updateId: null });
    // The revive was attempted, found the row moved on, and rolled back.
    expect(transitions).toStrictEqual([
      [
        "u1",
        "SUPERSEDED",
        { status: "PENDING", error: null, started_at: null, finished_at: null },
      ],
    ]);
    expect(await store.update("u1")).toMatchObject({ status: "SUCCEEDED" });
  });

  it("lets a canary of a gated app through without a rollout", async () => {
    await gated();
    expect(
      await gate.admit({
        row: envRow({ channel_override: "STAGING" }),
        move: MOVE,
        now: NOW,
      }),
    ).toStrictEqual({ version: "floor", updateId: "u1" });
    expect(await store.update("u1")).toMatchObject({
      rollout_id: null,
      status: "APPLYING",
    });
  });

  it("logs a stranded version once, however often it is admitted", async () => {
    const stranded = {
      artifactName: "host",
      from: "sha-aaaaaaaaaaaa",
      to: "sha-bbbbbbbbbbbb",
      stranded: true,
    };
    expect(
      (await gate.admit({ row: envRow(), move: stranded, now: NOW })).version,
    ).toBe("hold");
    expect(
      (await gate.admit({ row: envRow(), move: stranded, now: LATER })).version,
    ).toBe("hold");
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]![0])).toMatch(
      /environment e1 of chain l1 stays on FUSION sha-aaaaaaaaaaaa: .*cannot be proven older than sha-bbbbbbbbbbbb/,
    );
    expect(await store.history("e1", 20)).toHaveLength(1);
  });

  it("logs why an environment waits once per reason, and again once its update has started", async () => {
    await gated();
    await promote();
    const waits = (reason: string) =>
      `[licensing] environment e1 of chain l1 waits for FUSION 1.1.0: ${reason}`;
    await gate.admit({ row: envRow(), move: MOVE, now: NOW });
    await gate.admit({ row: envRow(), move: MOVE, now: NOW });
    expect(info.mock.calls).toStrictEqual([[waits(`due at ${LATER}`)]]);
    // The reason changes: logged again.
    await store.pause("r1", "environment e9: boom", NOW);
    await gate.admit({ row: envRow(), move: MOVE, now: NOW });
    await store.resume("r1");
    await gate.admit({ row: envRow(), move: MOVE, now: NOW });
    expect(info.mock.calls).toStrictEqual([
      [waits(`due at ${LATER}`)],
      [waits("its rollout is paused")],
      [waits(`due at ${LATER}`)],
    ]);
    // It starts (asked for), and is handed back: the same reason is news again.
    await store.patchUpdate("u1", { requested_at: NOW });
    expect(
      (await gate.admit({ row: envRow(), move: MOVE, now: NOW })).version,
    ).toBe("floor");
    await gate.release("u1");
    await store.patchUpdate("u1", { requested_at: null });
    await gate.admit({ row: envRow(), move: MOVE, now: NOW });
    expect(info).toHaveBeenCalledTimes(4);
    expect(info).toHaveBeenLastCalledWith(waits(`due at ${LATER}`));
    expect(warn).not.toHaveBeenCalled();
  });

  it("puts a released update back to PENDING", async () => {
    const { updateId } = await gate.admit({
      row: envRow(),
      move: MOVE,
      now: NOW,
    });
    await gate.release(updateId!);
    expect(await store.update(updateId!)).toMatchObject({
      status: "PENDING",
      started_at: null,
    });
  });

  it("takes the app's lock before it reads anything", async () => {
    const calls: string[] = [];
    const spied = createUpdateGate({
      store: wrapped(
        (q) =>
          new Proxy(q, {
            get(target, key, receiver) {
              const value = Reflect.get(target, key, receiver);
              if (typeof value !== "function") return value;
              return (...args: unknown[]) => {
                calls.push(`${String(key)}(${String(args[0])})`);
                return value(...args);
              };
            },
          }),
      ),
      logger: { warn, info },
      newId: () => "u1",
    });
    await spied.admit({ row: envRow(), move: MOVE, now: NOW });
    expect(calls[0]).toBe("lockApp(a)");
    expect(calls.filter((c) => c.startsWith("lockApp"))).toHaveLength(1);
    expect(calls.length).toBeGreaterThan(1);
  });

  it("holds when its update leaves PENDING before it can start", async () => {
    await gated();
    await promote();
    await gate.admit({ row: envRow(), move: MOVE, now: NOW });
    // Another writer settled the row after the gate read it PENDING.
    await store.finishUpdate("u1", "FAILED", "settled", LATER, "PENDING");
    const racing = createUpdateGate({
      store: wrapped((q) => ({
        ...q,
        updateFor: async (rolloutId, environmentId) => {
          const read = await q.updateFor(rolloutId, environmentId);
          return read && { ...read, status: "PENDING" };
        },
      })),
      logger: { warn, info },
      newId: () => "u2",
    });
    expect(
      await racing.admit({ row: envRow(), move: MOVE, now: LATER }),
    ).toStrictEqual({ version: "hold", updateId: null });
    expect(await store.update("u1")).toMatchObject({
      status: "FAILED",
      started_at: null,
    });
  });
});

describe("createUpdateGate commits a decision whole, or nothing of it", () => {
  const update = (
    id: string,
    to: string,
    status: "PENDING" | "APPLYING" | "SUCCEEDED" | "FAILED",
    created: string,
  ) =>
    store.insertUpdate({
      id,
      rollout_id: null,
      environment_id: "e1",
      app_id: "a",
      from_version: "1.0.0",
      to_version: to,
      status,
      due_at: created,
      requested_at: null,
      started_at: status === "APPLYING" ? created : null,
      finished_at: null,
      pre_update_dump_id: null,
      error: null,
      forced_at: null,
      created_at: created,
    });
  const EARLIER = "2026-11-09T12:00:00.000Z";
  /** The gate over the store, reading `id` as `status` whatever it holds. */
  const staleGate = (
    id: string,
    status: "PENDING" | "APPLYING",
  ): UpdateGate => {
    const stale = <T extends { id: string } | null>(read: T): T =>
      read && read.id === id ? { ...read, status } : read;
    return createUpdateGate({
      store: wrapped((q) => ({
        ...q,
        unrolledUpdate: async (e, to) => stale(await q.unrolledUpdate(e, to)),
        openExcept: async (e, except) => stale(await q.openExcept(e, except)),
      })),
      logger: { warn, info },
      newId: () => "unused",
    });
  };

  it("keeps nothing of a decision whose start is lost, not even its supersede", async () => {
    // u2 (to 1.1.0) was read PENDING but had already failed; the decision
    // also supersedes u1, still applying.
    await update("u1", "1.0.5", "APPLYING", EARLIER);
    await update("u2", "1.1.0", "FAILED", NOW);
    expect(
      await staleGate("u2", "PENDING").admit({
        row: envRow(),
        move: MOVE,
        now: LATER,
      }),
    ).toStrictEqual({ version: "hold", updateId: null });
    expect(await store.update("u1")).toMatchObject({
      status: "APPLYING",
      finished_at: null,
    });
    expect(await store.update("u2")).toMatchObject({ status: "FAILED" });
  });

  it("decides on when the update it supersedes has already settled", async () => {
    // u1 was read APPLYING but had already succeeded.
    await update("u1", "1.0.5", "SUCCEEDED", EARLIER);
    await update("u2", "1.1.0", "PENDING", NOW);
    expect(
      await staleGate("u1", "APPLYING").admit({
        row: envRow(),
        move: MOVE,
        now: LATER,
      }),
    ).toStrictEqual({ version: "floor", updateId: "u2" });
    expect(await store.update("u1")).toMatchObject({ status: "SUCCEEDED" });
    expect(await store.update("u2")).toMatchObject({
      status: "APPLYING",
      started_at: LATER,
    });
  });

  it("logs a held version only once its error is committed", async () => {
    const stranded = {
      artifactName: "host",
      from: "sha-aaaaaaaaaaaa",
      to: "sha-bbbbbbbbbbbb",
      stranded: true,
    };
    const failing = createUpdateGate({
      store: {
        ...store,
        inTransaction: (fn) =>
          store.inTransaction(async (q) => {
            await fn(q);
            throw new Error("commit failed");
          }),
      },
      logger: { warn, info },
      newId: () => "u1",
    });
    await expect(
      failing.admit({ row: envRow(), move: stranded, now: NOW }),
    ).rejects.toThrow("commit failed");
    expect(warn).not.toHaveBeenCalled();
    expect(await store.history("e1", 20)).toStrictEqual([]);
    // Nothing was recorded, so the next admission records and logs it.
    await gate.admit({ row: envRow(), move: stranded, now: LATER });
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe("activeUpdateGate", () => {
  const gate: UpdateGate = {
    admit: () => Promise.resolve({ version: "floor", updateId: null }),
    release: () => Promise.resolve(),
  };

  it("wires the gate when the keeper applies", () => {
    expect(activeUpdateGate({ dryRun: false }, gate)).toBe(gate);
  });

  it("wires no gate in dry run, so nothing is left APPLYING", () => {
    expect(activeUpdateGate({ dryRun: true }, gate)).toBeUndefined();
  });
});
