import { describe, it, expect, vi } from "vitest";
import {
  AppWarmPoolKeeper,
  type WarmPoolKeeperConfig,
  type WarmPoolKeeperDeps,
} from "../warm-pool-keeper.js";
import type { AppDocView, AppTemplateView } from "../app-reads.js";
import type { WarmRow } from "../warm-pool-db.js";
import type { WarmEnvInput } from "../warm-env.js";

const NOW = "2026-11-02T12:00:00.000Z";
const SHAPE = {
  services: [],
  packages: [],
  size: null,
  baseDomain: null,
  packageRegistry: null,
};

const tmpl = (
  id: string,
  size: number,
  over: Partial<AppTemplateView> = {},
): AppTemplateView => ({
  id,
  name: id,
  mode: "DEDICATED",
  sharedEnvironment: null,
  warmPoolSize: size,
  template: SHAPE,
  templateHash: `hash-${id}`,
  resolutionError: null,
  ...over,
});

const app = (
  id: string,
  templates: AppTemplateView[],
  over: Partial<AppDocView> = {},
): AppDocView => ({
  id,
  name: `App ${id}`,
  slug: id,
  owner: "0xowner",
  status: "ACTIVE",
  identityDid: null,
  productionEnvironmentId: null,
  templates,
  terms: templates.map((t) => ({
    id: `term-${t.id}`,
    kind: `kind-${t.id}`,
    label: null,
    templateId: t.id,
    validityDays: null,
    issuers: [],
    status: "ACTIVE" as const,
  })),
  artifacts: [],
  tampered: false,
  tamperReason: null,
  licensingStateHash: "x",
  unverified: false,
  ...over,
});

const liveRow = (
  id: string,
  appId: string,
  templateId: string,
  state: WarmRow["state"],
  hash: string,
): WarmRow => ({
  environment_id: id,
  app_id: appId,
  template_id: templateId,
  template_hash: hash,
  state,
  // Five minutes before NOW: young enough that a WARMING row has not timed out.
  created_at: "2026-11-02T11:55:00.000Z",
  ready_at: state === "AVAILABLE" ? "2026-11-02T11:58:00.000Z" : null,
  claimed_at: null,
  deleted_at: null,
  env_deleted_at: null,
  pool_size: null,
  root_license_id: null,
});

const CFG: WarmPoolKeeperConfig = {
  enabled: true,
  dryRun: false,
  scanIntervalMs: 30_000,
  createsPerTick: 3,
  maxPerTemplate: 10,
};

function setup(input: {
  apps: AppDocView[];
  rows?: WarmRow[];
  /** Consecutive WARMING timeouts the store reports for a pool. */
  streak?: (q: { templateHash: string; poolSize: number }) => number;
  /** Retired rows whose environment is not yet known deleted. */
  retired?: WarmRow[];
  status?: Record<string, string | null>;
  create?: (i: WarmEnvInput) => Promise<string>;
  cfg?: Partial<WarmPoolKeeperConfig>;
}) {
  let n = 0;
  const created: WarmEnvInput[] = [];
  const deps = {
    appIds: vi.fn(async () => input.apps.map((a) => a.id)),
    apps: {
      app: vi.fn(
        async (id: string) => input.apps.find((a) => a.id === id) ?? null,
      ),
    },
    store: {
      allLive: vi.fn(async () => input.rows ?? []),
      markAvailable: vi.fn(async () => {}),
      markDeletedUnclaimed: vi.fn(async () => true),
      awaitingDeletion: vi.fn(async () => input.retired ?? []),
      markEnvDeleted: vi.fn(async (_id: string, _nowIso: string) => {}),
      timeoutStreak: vi.fn(
        async (q: { appId: string; templateId: string; templateHash: string; poolSize: number; limit: number }) =>
          input.streak?.(q) ?? 0,
      ),
    },
    envStatus: vi.fn(async (id: string) => input.status?.[id] ?? null),
    deleteEnv: vi.fn(async (_id: string) => {}),
    createWarm: vi.fn(
      input.create ??
        (async (i: WarmEnvInput) => {
          created.push(i);
          return `new-${++n}`;
        }),
    ),
    now: () => NOW,
    logger: { info: vi.fn(), warn: vi.fn() },
  } satisfies WarmPoolKeeperDeps;
  const keeper = new AppWarmPoolKeeper(deps, { ...CFG, ...input.cfg });
  return { deps, keeper, created };
}

describe("AppWarmPoolKeeper", () => {
  it("creates at most createsPerTick across pools in one tick", async () => {
    const { deps, keeper, created } = setup({
      apps: [app("a", [tmpl("ta", 2)]), app("b", [tmpl("tb", 2)])],
      cfg: { createsPerTick: 1 },
    });
    await keeper.reconcileOnce();
    expect(deps.createWarm).toHaveBeenCalledTimes(1);
    expect(created[0]).toEqual({
      appId: "a",
      appName: "App a",
      template: { ...SHAPE, id: "ta" },
      templateHash: "hash-ta",
      poolSize: 2,
      nowIso: NOW,
    });
    expect(created.map((c) => c.template.id)).toEqual(["ta"]);
  });

  it("a pool whose creation throws does not stop the next pool filling", async () => {
    const { deps, keeper } = setup({
      apps: [app("a", [tmpl("ta", 2)]), app("b", [tmpl("tb", 2)])],
      create: async (i) => {
        if (i.appId === "a") throw new Error("cluster says no");
        return `env-${i.appId}`;
      },
    });
    await keeper.reconcileOnce();
    const byApp = deps.createWarm.mock.calls.map(([i]) => i.appId);
    expect(byApp).toEqual(["a", "b"]);
    expect(deps.logger.warn).toHaveBeenCalled();
  });

  it("a pool whose reads throw does not stop the next pool", async () => {
    const { deps, keeper } = setup({
      apps: [app("a", [tmpl("ta", 1)]), app("b", [tmpl("tb", 1)])],
      rows: [liveRow("wa", "a", "ta", "WARMING", "hash-ta")],
    });
    deps.envStatus.mockRejectedValueOnce(new Error("reactor down"));
    await keeper.reconcileOnce();
    expect(deps.createWarm.mock.calls.map(([i]) => i.appId)).toEqual(["b"]);
  });

  it("reconcileOnce while a tick is running is a no-op", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { deps, keeper } = setup({ apps: [app("a", [tmpl("ta", 1)])] });
    deps.appIds.mockImplementationOnce(async () => {
      await gate;
      return ["a"];
    });
    const first = keeper.reconcileOnce();
    await keeper.reconcileOnce();
    expect(deps.appIds).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(deps.createWarm).toHaveBeenCalledTimes(1);
  });

  it("removed rows are marked deleted and their documents deleted; ready ones promoted", async () => {
    const { deps, keeper } = setup({
      apps: [app("a", [tmpl("ta", 2)])],
      rows: [
        liveRow("stale", "a", "ta", "AVAILABLE", "hash-old"),
        liveRow("ready", "a", "ta", "WARMING", "hash-ta"),
        liveRow("claimed", "a", "ta", "CLAIMED", "hash-old"),
      ],
      status: { stale: "READY", ready: "READY", claimed: "READY" },
    });
    await keeper.reconcileOnce();
    expect(deps.store.markDeletedUnclaimed).toHaveBeenCalledWith("stale", NOW);
    expect(deps.deleteEnv).toHaveBeenCalledWith("stale");
    expect(deps.store.markAvailable).toHaveBeenCalledWith("ready", NOW);
    expect(deps.createWarm).toHaveBeenCalledTimes(1);
    // A CLAIMED row is never read, promoted, retired or deleted.
    expect(deps.envStatus).not.toHaveBeenCalledWith("claimed");
    expect(deps.store.markDeletedUnclaimed).not.toHaveBeenCalledWith(
      "claimed",
      NOW,
    );
    expect(deps.deleteEnv).not.toHaveBeenCalledWith("claimed");
  });

  it("does not delete the document of a row claimed since it was read", async () => {
    const { deps, keeper } = setup({
      apps: [app("a", [tmpl("ta", 0)])],
      rows: [liveRow("w", "a", "ta", "AVAILABLE", "hash-ta")],
      status: { w: "READY" },
    });
    deps.store.markDeletedUnclaimed.mockResolvedValueOnce(false);
    await keeper.reconcileOnce();
    expect(deps.deleteEnv).not.toHaveBeenCalled();
  });

  it("drains the pool of a suspended app, a template at 0 and a template with no active term", async () => {
    const retired = app("r", [tmpl("tr", 2)]);
    retired.terms = retired.terms.map((t) => ({
      ...t,
      status: "RETIRED" as const,
    }));
    const { deps, keeper } = setup({
      apps: [
        app("s", [tmpl("ts", 2)], { status: "DISCONNECTED" }),
        app("z", [tmpl("tz", 0)]),
        retired,
      ],
      rows: [
        liveRow("s1", "s", "ts", "AVAILABLE", "hash-ts"),
        liveRow("z1", "z", "tz", "WARMING", "hash-tz"),
        liveRow("r1", "r", "tr", "AVAILABLE", "hash-tr"),
        liveRow("gone1", "deleted-app", "t", "AVAILABLE", "h"),
      ],
      status: { s1: "READY", z1: "DEPLOYING", r1: "READY", gone1: "READY" },
    });
    await keeper.reconcileOnce();
    expect(deps.deleteEnv.mock.calls.map(([id]) => id).sort()).toEqual([
      "gone1",
      "r1",
      "s1",
      "z1",
    ]);
    expect(deps.createWarm).not.toHaveBeenCalled();
  });

  it("holds a tampered app, an unverified app and an unresolvable template", async () => {
    const { deps, keeper } = setup({
      apps: [
        app("t", [tmpl("tt", 2)], { tampered: true, tamperReason: "x" }),
        app("u", [tmpl("tu", 2)], { unverified: true }),
        app("x", [tmpl("tx", 2, { resolutionError: "no artifact" })]),
      ],
      rows: [
        liveRow("t1", "t", "tt", "AVAILABLE", "old"),
        liveRow("u1", "u", "tu", "AVAILABLE", "old"),
        liveRow("x1", "x", "tx", "AVAILABLE", "old"),
      ],
      status: { t1: "READY", u1: "READY", x1: "READY" },
    });
    await keeper.reconcileOnce();
    expect(deps.createWarm).not.toHaveBeenCalled();
    expect(deps.deleteEnv).not.toHaveBeenCalled();
    expect(deps.store.markDeletedUnclaimed).not.toHaveBeenCalled();
  });

  it("does nothing beyond listing when every pool is 0 and nothing is live", async () => {
    const { deps, keeper } = setup({
      apps: [
        app("a", [tmpl("ta", 0)]),
        app("b", [tmpl("tb", 0, { warmPoolSize: 0 })]),
      ],
    });
    await keeper.reconcileOnce();
    expect(deps.envStatus).not.toHaveBeenCalled();
    expect(deps.store.markAvailable).not.toHaveBeenCalled();
    expect(deps.store.markDeletedUnclaimed).not.toHaveBeenCalled();
    expect(deps.deleteEnv).not.toHaveBeenCalled();
    expect(deps.createWarm).not.toHaveBeenCalled();
  });

  it("caps a pool at maxPerTemplate", async () => {
    const { deps, keeper } = setup({
      apps: [app("a", [tmpl("ta", 5)])],
      rows: [
        liveRow("a1", "a", "ta", "AVAILABLE", "hash-ta"),
        liveRow("a2", "a", "ta", "AVAILABLE", "hash-ta"),
      ],
      status: { a1: "READY", a2: "READY" },
      cfg: { maxPerTemplate: 2, createsPerTick: 10 },
    });
    await keeper.reconcileOnce();
    expect(deps.createWarm).not.toHaveBeenCalled();
  });

  it("rotates the starting pool each tick so a fourth pool is not starved", async () => {
    const { deps, keeper } = setup({
      apps: ["p1", "p2", "p3", "p4"].map((id) => app(id, [tmpl(`t${id}`, 2)])),
      cfg: { createsPerTick: 3 },
    });
    const perTick: string[][] = [];
    for (let i = 0; i < 2; i++) {
      deps.createWarm.mockClear();
      await keeper.reconcileOnce();
      perTick.push(deps.createWarm.mock.calls.map(([c]) => c.appId));
    }
    expect(perTick).toEqual([
      ["p1", "p2", "p3"],
      ["p2", "p3", "p4"],
    ]);
  });

  it("gives a pool at most one creation per tick", async () => {
    const { deps, keeper } = setup({
      apps: [app("a", [tmpl("ta", 5)])],
      cfg: { createsPerTick: 10 },
    });
    await keeper.reconcileOnce();
    expect(deps.createWarm).toHaveBeenCalledTimes(1);
    await keeper.reconcileOnce();
    expect(deps.createWarm).toHaveBeenCalledTimes(2);
  });

  it("backs creation off after a dead removal, doubling, without blocking other pools", async () => {
    const status: Record<string, string | null> = {
      d1: "DEPLOYMENt_FAILED",
      d2: null,
    };
    const { deps, keeper } = setup({
      apps: [app("a", [tmpl("ta", 1)]), app("b", [tmpl("tb", 10)])],
      status,
    });
    const deadAt: Record<number, WarmRow> = {
      1: liveRow("d1", "a", "ta", "WARMING", "hash-ta"),
      5: liveRow("d2", "a", "ta", "WARMING", "hash-ta"),
    };
    const aCreated: number[] = [];
    const bCreated: number[] = [];
    for (let tick = 1; tick <= 10; tick++) {
      deps.store.allLive.mockResolvedValueOnce(
        deadAt[tick] ? [deadAt[tick]] : [],
      );
      deps.createWarm.mockClear();
      await keeper.reconcileOnce();
      const apps = deps.createWarm.mock.calls.map(([c]) => c.appId);
      if (apps.includes("a")) aCreated.push(tick);
      if (apps.includes("b")) bCreated.push(tick);
    }
    // Dead in tick 1: ticks 1-3 withheld, creates in 4. Dead (missing) in 5:
    // the wait doubles to 4, so 5-9 withheld and creates in 10.
    expect(aCreated).toEqual([4, 10]);
    expect(deps.deleteEnv).toHaveBeenCalledWith("d1");
    expect(deps.deleteEnv).toHaveBeenCalledWith("d2");
    expect(bCreated).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("resets the backoff once the pool is full and healthy", async () => {
    const { deps, keeper } = setup({
      apps: [app("a", [tmpl("ta", 1)])],
      status: { d1: "STOPPED", ok: "READY", d2: "DESTROYED" },
    });
    const rowsAt: Record<number, WarmRow[]> = {
      1: [liveRow("d1", "a", "ta", "WARMING", "hash-ta")],
      4: [liveRow("ok", "a", "ta", "AVAILABLE", "hash-ta")],
      5: [liveRow("d2", "a", "ta", "WARMING", "hash-ta")],
    };
    const aCreated: number[] = [];
    for (let tick = 1; tick <= 8; tick++) {
      deps.store.allLive.mockResolvedValueOnce(rowsAt[tick] ?? []);
      deps.createWarm.mockClear();
      await keeper.reconcileOnce();
      if (deps.createWarm.mock.calls.length > 0) aCreated.push(tick);
    }
    // Full at tick 4 resets the level: the death in tick 5 waits 2 again (5-7), creates in 8.
    expect(aCreated).toEqual([8]);
  });

  it("retires a WARMING row stuck past the limit, a DRAFT one included, deletes its environment, logs it and refills", async () => {
    const old = (id: string): WarmRow => ({
      ...liveRow(id, "a", "ta", "WARMING", "hash-ta"),
      created_at: "2026-11-02T11:29:00.000Z", // 31 minutes before NOW
    });
    const { deps, keeper } = setup({
      apps: [app("a", [tmpl("ta", 2)])],
      rows: [old("stuck"), old("draft")],
      status: { stuck: "DEPLOYING", draft: "DRAFT" },
    });
    await keeper.reconcileOnce();
    expect(deps.store.markDeletedUnclaimed).toHaveBeenCalledWith("stuck", NOW);
    expect(deps.store.markDeletedUnclaimed).toHaveBeenCalledWith("draft", NOW);
    expect(deps.deleteEnv).toHaveBeenCalledWith("stuck");
    expect(deps.deleteEnv).toHaveBeenCalledWith("draft");
    const warned = deps.logger.warn.mock.calls.map(([m]) => String(m));
    expect(warned.some((m) => m.includes("stuck") && m.includes("WARMING") && m.includes("30 minutes"))).toBe(true);
    expect(warned.some((m) => m.includes("draft") && m.includes("DRAFT"))).toBe(true);
    // A failed warm-up: the pool's creation backs off like after a dead environment.
    expect(deps.createWarm).not.toHaveBeenCalled();
  });

  it("backs creation off after a WARMING timeout, so a template that never gets READY is not rebuilt every 30 minutes", async () => {
    const { deps, keeper } = setup({
      apps: [app("a", [tmpl("ta", 1)])],
      status: { slow: "DEPLOYING" },
    });
    const timedOut: WarmRow = {
      ...liveRow("slow", "a", "ta", "WARMING", "hash-ta"),
      created_at: "2026-11-02T11:00:00.000Z",
    };
    const created: number[] = [];
    for (let tick = 1; tick <= 4; tick++) {
      deps.store.allLive.mockResolvedValueOnce(tick === 1 ? [timedOut] : []);
      deps.createWarm.mockClear();
      await keeper.reconcileOnce();
      if (deps.createWarm.mock.calls.length > 0) created.push(tick);
    }
    // As a dead removal: ticks 1-3 withheld, creates in 4.
    expect(deps.deleteEnv).toHaveBeenCalledWith("slow");
    expect(created).toEqual([4]);
  });

  it("does not reset the backoff while the replacement is still WARMING, so repeated timeouts escalate", async () => {
    const { deps, keeper } = setup({
      apps: [app("a", [tmpl("ta", 1)])],
      status: { s1: "DEPLOYING", s2: "DEPLOYING", w2: "DEPLOYING" },
    });
    const old = (id: string): WarmRow => ({
      ...liveRow(id, "a", "ta", "WARMING", "hash-ta"),
      created_at: "2026-11-02T11:00:00.000Z",
    });
    // s1 times out in tick 1; its replacement (w2) warms in 4-6 and times out (as s2) in 7.
    const rowsAt: Record<number, WarmRow[]> = {
      1: [old("s1")],
      5: [liveRow("w2", "a", "ta", "WARMING", "hash-ta")],
      6: [liveRow("w2", "a", "ta", "WARMING", "hash-ta")],
      7: [old("s2")],
    };
    const created: number[] = [];
    for (let tick = 1; tick <= 12; tick++) {
      deps.store.allLive.mockResolvedValueOnce(rowsAt[tick] ?? []);
      deps.createWarm.mockClear();
      await keeper.reconcileOnce();
      if (deps.createWarm.mock.calls.length > 0) created.push(tick);
    }
    // Level 1 after tick 1 (creates in 4); level 2 after tick 7: 7-11 withheld, creates in 12.
    expect(created).toEqual([4, 12]);
  });

  it("records a removed environment as deleted; one whose delete fails stays to be swept", async () => {
    const { deps, keeper } = setup({
      apps: [app("a", [tmpl("ta", 0)])],
      rows: [liveRow("ok", "a", "ta", "AVAILABLE", "hash-ta"), liveRow("stuck", "a", "ta", "AVAILABLE", "hash-ta")],
      status: { stuck: "READY" },
    });
    deps.deleteEnv.mockImplementation(async (id: string) => {
      if (id === "stuck") throw new Error("reactor down");
    });
    // The store lists the failed one as awaiting deletion: not retried in the same tick.
    deps.store.awaitingDeletion.mockResolvedValue([{ ...liveRow("stuck", "a", "ta", "AVAILABLE", "hash-ta"), deleted_at: NOW }]);
    await keeper.reconcileOnce();
    expect(deps.deleteEnv.mock.calls.filter(([id]) => id === "stuck")).toHaveLength(1);
    expect(deps.store.markEnvDeleted).toHaveBeenCalledExactlyOnceWith("ok", NOW);
    expect(deps.logger.warn.mock.calls.some(([m]) => String(m).includes("stuck") && String(m).includes("retried"))).toBe(true);
  });

  it("sweeps retired rows whose environment was never deleted: retries, accepts a document already gone, keeps one still there", async () => {
    const retired = (id: string): WarmRow => ({
      ...liveRow(id, "gone-app", "t", "AVAILABLE", "h"),
      deleted_at: "2026-11-02T11:00:00.000Z",
    });
    const { deps, keeper } = setup({
      apps: [],
      retired: [retired("retry-ok"), retired("already-gone"), retired("still-there")],
      status: { "still-there": "READY" },
    });
    deps.deleteEnv.mockImplementation(async (id: string) => {
      if (id !== "retry-ok") throw new Error("delete refused");
    });
    await keeper.reconcileOnce();
    expect(deps.deleteEnv.mock.calls.map(([id]) => id)).toEqual(["retry-ok", "already-gone", "still-there"]);
    expect(deps.store.markEnvDeleted.mock.calls.map(([id]) => id)).toEqual(["retry-ok", "already-gone"]);
    expect(deps.logger.warn.mock.calls.some(([m]) => String(m).includes("still-there"))).toBe(true);
  });

  it("logs a delete that keeps being refused at the first failure and then every 20th", async () => {
    const { deps, keeper } = setup({
      apps: [],
      retired: [{ ...liveRow("stuck", "a", "ta", "AVAILABLE", "h"), deleted_at: NOW }],
      status: { stuck: "READY" },
    });
    deps.deleteEnv.mockRejectedValue(new Error("delete refused"));
    const warnedAt: number[] = [];
    for (let tick = 1; tick <= 41; tick++) {
      deps.logger.warn.mockClear();
      await keeper.reconcileOnce();
      if (deps.logger.warn.mock.calls.some(([m]) => String(m).includes("stuck"))) warnedAt.push(tick);
    }
    expect(deps.deleteEnv).toHaveBeenCalledTimes(41);
    expect(warnedAt).toEqual([1, 21, 41]);
    expect(String(deps.logger.warn.mock.calls[0]![0])).toContain("41 attempts");
  });

  it("in dry-run, says what it would sweep when the set changes or every 20th tick", async () => {
    const r = (id: string): WarmRow => ({ ...liveRow(id, "a", "ta", "AVAILABLE", "h"), deleted_at: NOW });
    const { deps, keeper } = setup({ apps: [], retired: [r("x")], cfg: { dryRun: true } });
    const loggedAt: number[] = [];
    for (let tick = 1; tick <= 25; tick++) {
      if (tick === 23) deps.store.awaitingDeletion.mockResolvedValue([r("x"), r("y")]);
      deps.logger.info.mockClear();
      await keeper.reconcileOnce();
      if (deps.logger.info.mock.calls.some(([m]) => String(m).includes("would delete"))) loggedAt.push(tick);
    }
    expect(loggedAt).toEqual([1, 21, 23]);
  });

  it("stops creating for a pool after 3 consecutive WARMING timeouts until its hash or size changes, logging once", async () => {
    let size = 2;
    let hash = "hash-ta";
    const apps = () => [app("a", [tmpl("ta", size, { templateHash: hash })]), app("b", [tmpl("tb", 1)])];
    const { deps, keeper } = setup({
      apps: [],
      streak: (q) => (q.templateHash === "hash-ta" && q.poolSize === 2 ? 3 : 2),
    });
    deps.appIds.mockImplementation(async () => apps().map((a) => a.id));
    deps.apps.app.mockImplementation(async (id: string) => apps().find((a) => a.id === id) ?? null);
    for (let tick = 1; tick <= 3; tick++) await keeper.reconcileOnce();
    // Pool b (streak 2) keeps filling; pool a never creates.
    expect(deps.createWarm.mock.calls.map(([i]) => i.appId)).toEqual(["b", "b", "b"]);
    expect(deps.store.timeoutStreak).toHaveBeenCalledWith(
      expect.objectContaining({ appId: "a", templateId: "ta", templateHash: "hash-ta", poolSize: 2, limit: 3 }),
    );
    const halted = deps.logger.warn.mock.calls.map(([m]) => String(m)).filter((m) => m.includes("stopped creating"));
    expect(halted).toHaveLength(1);
    expect(halted[0]).toContain("a/ta");
    expect(halted[0]).toContain("3 consecutive");
    // The publisher changes the pool size: it creates again.
    size = 3;
    deps.createWarm.mockClear();
    await keeper.reconcileOnce();
    expect(deps.createWarm.mock.calls.map(([i]) => i.appId)).toContain("a");
    // Back at size 2 it is halted again (the same streak), and a new hash lifts it.
    size = 2;
    deps.createWarm.mockClear();
    await keeper.reconcileOnce();
    expect(deps.createWarm.mock.calls.map(([i]) => i.appId)).not.toContain("a");
    hash = "hash-new";
    deps.createWarm.mockClear();
    await keeper.reconcileOnce();
    expect(deps.createWarm.mock.calls.map(([i]) => i.appId)).toContain("a");
  });

  it("is inert when disabled and only logs in dry-run", async () => {
    const off = setup({
      apps: [app("a", [tmpl("ta", 2)])],
      cfg: { enabled: false },
    });
    await off.keeper.reconcileOnce();
    expect(off.deps.appIds).not.toHaveBeenCalled();

    const dry = setup({
      apps: [app("a", [tmpl("ta", 2)])],
      rows: [liveRow("w", "a", "ta", "WARMING", "old")],
      status: { w: "READY" },
      cfg: { dryRun: true },
    });
    await dry.keeper.reconcileOnce();
    expect(dry.deps.createWarm).not.toHaveBeenCalled();
    expect(dry.deps.store.markAvailable).not.toHaveBeenCalled();
    expect(dry.deps.store.markDeletedUnclaimed).not.toHaveBeenCalled();
    expect(dry.deps.deleteEnv).not.toHaveBeenCalled();
    expect(dry.deps.logger.info).toHaveBeenCalled();

    const drySweep = setup({
      apps: [],
      retired: [{ ...liveRow("r", "a", "ta", "AVAILABLE", "h"), deleted_at: NOW }],
      cfg: { dryRun: true },
    });
    await drySweep.keeper.reconcileOnce();
    expect(drySweep.deps.deleteEnv).not.toHaveBeenCalled();
    expect(drySweep.deps.store.markEnvDeleted).not.toHaveBeenCalled();
  });

  it("stop waits for the in-flight tick, which starts nothing more, and later ticks do nothing", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { deps, keeper } = setup({
      apps: [app("a", [tmpl("ta", 1)]), app("b", [tmpl("tb", 1)])],
      create: async (i) => {
        if (i.appId === "a") await gate;
        return `env-${i.appId}`;
      },
    });
    const tick = keeper.reconcileOnce();
    await vi.waitFor(() => expect(deps.createWarm).toHaveBeenCalledTimes(1));
    let stopped = false;
    const stopping = keeper.stop().then(() => (stopped = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(stopped).toBe(false);
    release();
    await stopping;
    await tick;
    // Pool b came after the stop: never created, nor swept.
    expect(deps.createWarm.mock.calls.map(([i]) => i.appId)).toEqual(["a"]);
    expect(deps.store.awaitingDeletion).not.toHaveBeenCalled();
    await keeper.reconcileOnce();
    expect(deps.appIds).toHaveBeenCalledTimes(1);
  });

  it("stop resolves even when the tick in flight fails", async () => {
    let fail!: (e: Error) => void;
    const { deps, keeper } = setup({ apps: [app("a", [tmpl("ta", 1)])] });
    deps.appIds.mockImplementationOnce(
      () => new Promise<string[]>((_, reject) => (fail = reject)),
    );
    const tick = keeper.reconcileOnce().catch(() => {});
    const stopping = keeper.stop();
    fail(new Error("reactor down"));
    await expect(stopping).resolves.toBeUndefined();
    await tick;
  });

  it("stop warns once when the tick in flight is still running after 30 s, and keeps waiting", async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const { deps, keeper } = setup({
        apps: [app("a", [tmpl("ta", 1)])],
        create: async () => {
          await gate;
          return "env";
        },
      });
      const tick = keeper.reconcileOnce();
      await vi.advanceTimersByTimeAsync(0);
      expect(deps.createWarm).toHaveBeenCalledTimes(1);
      let stopped = false;
      const stopping = keeper.stop().then(() => (stopped = true));
      await vi.advanceTimersByTimeAsync(29_000);
      expect(deps.logger.warn).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60_000);
      const slow = deps.logger.warn.mock.calls.filter(([m]) => String(m).includes("still running"));
      expect(slow).toHaveLength(1);
      expect(stopped).toBe(false);
      release();
      await stopping;
      await tick;
    } finally {
      vi.useRealTimers();
    }
  });

  it("a stopping keeper reads no further apps", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { deps, keeper } = setup({ apps: [app("a", [tmpl("ta", 1)]), app("b", [tmpl("tb", 1)])] });
    const read = deps.apps.app.getMockImplementation()!;
    deps.apps.app.mockImplementationOnce(async (id: string) => {
      await gate;
      return read(id);
    });
    const tick = keeper.reconcileOnce();
    await vi.waitFor(() => expect(deps.apps.app).toHaveBeenCalledTimes(1));
    const stopping = keeper.stop();
    release();
    await stopping;
    await tick;
    expect(deps.apps.app).toHaveBeenCalledTimes(1);
    expect(deps.createWarm).not.toHaveBeenCalled();
  });

  it("start runs a tick and stop clears the timer", async () => {
    vi.useFakeTimers();
    try {
      const { deps, keeper } = setup({ apps: [] });
      keeper.start();
      keeper.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(deps.appIds).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(deps.appIds).toHaveBeenCalledTimes(2);
      await keeper.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(deps.appIds).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
