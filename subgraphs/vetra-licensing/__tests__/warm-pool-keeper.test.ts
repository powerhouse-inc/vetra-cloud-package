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
  created_at: "2026-11-01T00:00:00.000Z",
  ready_at: state === "AVAILABLE" ? "2026-11-01T00:05:00.000Z" : null,
  claimed_at: null,
  deleted_at: null,
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
  it("creates at most createsPerTick across two pools in one tick", async () => {
    const { deps, keeper, created } = setup({
      apps: [app("a", [tmpl("ta", 2)]), app("b", [tmpl("tb", 2)])],
    });
    await keeper.reconcileOnce();
    expect(deps.createWarm).toHaveBeenCalledTimes(3);
    expect(created[0]).toEqual({
      appId: "a",
      appName: "App a",
      template: { ...SHAPE, id: "ta" },
      templateHash: "hash-ta",
      nowIso: NOW,
    });
    expect(created.map((c) => c.template.id)).toEqual(["ta", "ta", "tb"]);
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
    expect(byApp.filter((a) => a === "b")).toHaveLength(2);
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
      cfg: { maxPerTemplate: 2, createsPerTick: 10 },
    });
    await keeper.reconcileOnce();
    expect(deps.createWarm).toHaveBeenCalledTimes(2);
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
      keeper.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(deps.appIds).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
