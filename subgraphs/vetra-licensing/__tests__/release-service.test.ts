import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import type { Action } from "document-model";
import { up } from "../db/migrations.js";
import type {
  AppRollouts,
  EnvironmentUpdates,
  LicenseEnvironments,
  VetraLicensingDB,
} from "../db/schema.js";
import type { AppDocView } from "../app-reads.js";
import { loadLicensingConfig } from "../config.js";
import { createChainEnvironmentRows } from "../environments.js";
import { UnknownAppError } from "../publisher-auth.js";
import { UnknownEnvironmentError } from "../publisher-errors.js";
import { createRolloutStore } from "../rollout-db.js";
import {
  environmentRelease,
  environmentUpdate,
  forceEnvironmentUpdate,
  promoteRelease,
  releaseCandidates,
  requestUpdateNow,
  resumeRollout,
  rolloutsOf,
  setCanaryEnvironment,
  setReleasePolicy,
  type ReleaseServiceDeps,
} from "../release-service.js";

const NOW = "2026-11-10T12:00:00.000Z";
const PUBLISHER = "did:pkh:eip155:1:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CUSTOMER = "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";

let db: Kysely<VetraLicensingDB>;
let deps: ReleaseServiceDeps;
let app: AppDocView;
let written: Action[];
let states: Map<string, { status: string; version: string | null }>;
let kicks: number;

/** Points the artifact's `channel` at `version`, as SET_ARTIFACT_CHANNEL does. */
const point = (channel: string, version: string, name = "host") => {
  const artifact = app.artifacts.find((a) => a.name === name)!;
  const c = artifact.channels.find((x) => x.channel === channel);
  if (c) c.version = version;
  else artifact.channels.push({ channel, version });
};
const channelOps = () =>
  written
    .filter((a) => a.type === "SET_ARTIFACT_CHANNEL")
    .map((a) => a.input as { channel: string; version: string })
    .map((i) => `${i.channel} ${i.version}`);

const envRow = (
  environment_id: string,
  user_did: string,
  over: Partial<LicenseEnvironments> = {},
): LicenseEnvironments => ({
  environment_id,
  root_license_id: `l-${environment_id}`,
  app_id: "a",
  user_did,
  license_id: `l-${environment_id}`,
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
const update = (
  over: Partial<EnvironmentUpdates> = {},
): EnvironmentUpdates => ({
  id: "u1",
  rollout_id: null,
  environment_id: "cust",
  app_id: "a",
  from_version: "1.0.0",
  to_version: "1.1.0",
  status: "PENDING",
  due_at: NOW,
  requested_at: null,
  started_at: null,
  finished_at: null,
  pre_update_dump_id: null,
  error: null,
  forced_at: null,
  created_at: NOW,
  ...over,
});

beforeEach(async () => {
  db = new Kysely<VetraLicensingDB>({
    dialect: new PGliteDialect(new PGlite()),
  });
  await up(db as Kysely<any>);
  app = {
    id: "a",
    name: "Sektar",
    slug: "sektar",
    owner: "0xo",
    status: "ACTIVE",
    identityDid: null,
    productionEnvironmentId: null,
    templates: [],
    terms: [],
    artifacts: [
      {
        kind: "FUSION_IMAGE",
        name: "host",
        versions: [
          { version: "1.0.0", reference: "cr.vetra.io/p/host:1.0.0" },
          { version: "1.1.0", reference: "cr.vetra.io/p/host:1.1.0" },
        ],
        channels: [{ channel: "LATEST", version: "1.0.0" }],
      },
    ],
    tampered: false,
    tamperReason: null,
    licensingStateHash: "x",
    unverified: false,
  };
  written = [];
  states = new Map();
  kicks = 0;
  let n = 0;
  deps = {
    store: createRolloutStore(db),
    envRows: createChainEnvironmentRows(db, loadLicensingConfig({})),
    apps: { app: async (id) => (id === "a" ? app : null) },
    appWriter: {
      appendLicensingOps: async (_id, actions) => {
        written.push(...actions);
        for (const a of actions) {
          if (a.type !== "SET_ARTIFACT_CHANNEL") continue;
          const i = a.input as {
            name: string;
            channel: string;
            version: string;
          };
          point(i.channel, i.version, i.name);
        }
      },
    },
    envState: async (id) => {
      const s = states.get(id);
      return s
        ? ({
            status: s.status,
            services: [{ type: "FUSION", version: s.version }],
          } as never)
        : null;
    },
    kick: () => {
      kicks++;
    },
    newId: () => `r${++n}`,
    now: () => NOW,
  };
  await db
    .insertInto("license_environments")
    .values([envRow("mine", PUBLISHER), envRow("cust", CUSTOMER)])
    .execute();
});
afterEach(async () => {
  await db.destroy();
});

const markCanary = () =>
  setCanaryEnvironment(deps, {
    appId: "a",
    environmentId: "mine",
    canary: true,
    callerDid: PUBLISHER,
  });

describe("setReleasePolicy", () => {
  it("refuses GATED without a canary", async () => {
    await expect(
      setReleasePolicy(deps, { appId: "a", policy: "GATED" }),
    ).rejects.toThrow(/canary/);
    expect((await deps.store.settings("a")).policy).toBe("AUTO");
  });

  it("gates with a canary, keeping the notice when none is given", async () => {
    await markCanary();
    written.length = 0;
    expect(
      await setReleasePolicy(deps, {
        appId: "a",
        policy: "GATED",
        defaultNoticeHours: 24,
      }),
    ).toStrictEqual({ appId: "a", policy: "GATED", defaultNoticeHours: 24 });
    // The mark already brought STAGING up to LATEST.
    expect(written).toStrictEqual([]);
    point("STAGING", "1.1.0");
    await setReleasePolicy(deps, { appId: "a", policy: "GATED" });
    expect(written).toStrictEqual([]);
    expect((await deps.store.settings("a")).defaultNoticeHours).toBe(24);
  });

  it("refuses an unknown policy and a notice out of range", async () => {
    await expect(
      setReleasePolicy(deps, { appId: "a", policy: "SOMETIMES" }),
    ).rejects.toThrow(/policy must be one of AUTO, GATED/);
    await expect(
      setReleasePolicy(deps, {
        appId: "a",
        policy: "AUTO",
        defaultNoticeHours: -1,
      }),
    ).rejects.toThrow(/noticeHours/);
    await expect(
      setReleasePolicy(deps, {
        appId: "a",
        policy: "AUTO",
        defaultNoticeHours: 1.5,
      }),
    ).rejects.toThrow(/noticeHours/);
  });
});

describe("setCanaryEnvironment", () => {
  it("marks only the caller's own environment of the app", async () => {
    await expect(
      setCanaryEnvironment(deps, {
        appId: "a",
        environmentId: "cust",
        canary: true,
        callerDid: PUBLISHER,
      }),
    ).rejects.toThrow(/hold yourself/);
    await expect(
      setCanaryEnvironment(deps, {
        appId: "b",
        environmentId: "mine",
        canary: true,
        callerDid: PUBLISHER,
      }),
    ).rejects.toThrow("no such environment");
    expect(await markCanary()).toBe(true);
    expect((await deps.envRows.byEnvironment("mine"))!.channel_override).toBe(
      "STAGING",
    );
    expect(kicks).toBe(1);
  });

  it("keeps the last canary of a gated app", async () => {
    await markCanary();
    await setReleasePolicy(deps, { appId: "a", policy: "GATED" });
    await expect(
      setCanaryEnvironment(deps, {
        appId: "a",
        environmentId: "mine",
        canary: false,
        callerDid: PUBLISHER,
      }),
    ).rejects.toThrow(/needs a canary/);
    await setReleasePolicy(deps, { appId: "a", policy: "AUTO" });
    await setCanaryEnvironment(deps, {
      appId: "a",
      environmentId: "mine",
      canary: false,
      callerDid: PUBLISHER,
    });
    expect(
      (await deps.envRows.byEnvironment("mine"))!.channel_override,
    ).toBeNull();
  });
});

describe("promoteRelease", () => {
  const promote = (
    over: { version?: string; noticeHours?: number | null } = {},
  ) =>
    promoteRelease(deps, {
      appId: "a",
      artifactName: "host",
      version: "1.1.0",
      promotedBy: "0xAAAA",
      ...over,
    });

  beforeEach(async () => {
    await markCanary();
  });

  it("refuses an app that is not gated", async () => {
    await expect(promote()).rejects.toThrow(/not gated/);
  });

  it("refuses until a canary is READY on the version", async () => {
    await setReleasePolicy(deps, { appId: "a", policy: "GATED" });
    states.set("mine", { status: "DEPLOYING", version: "1.1.0" });
    await expect(promote()).rejects.toThrow(
      "no canary environment of this app is READY on 1.1.0",
    );
    await expect(promote({ version: "9.9.9" })).rejects.toThrow(
      "host has no published version 9.9.9",
    );
  });

  it("moves LATEST, supersedes the previous rollout and is due after the notice", async () => {
    await setReleasePolicy(deps, {
      appId: "a",
      policy: "GATED",
      defaultNoticeHours: 72,
    });
    states.set("mine", { status: "READY", version: "1.1.0" });
    const first = await promote({ noticeHours: 0 });
    expect(first).toMatchObject({
      id: "r1",
      status: "ACTIVE",
      apply_after: NOW,
      promoted_by: "0xaaaa",
    });
    const second = await promote();
    expect(second.apply_after).toBe("2026-11-13T12:00:00.000Z");
    expect((await deps.store.rollout("r1"))!.status).toBe("SUPERSEDED");
    expect(
      written.filter((a) => a.type === "SET_ARTIFACT_CHANNEL").at(-1)!.input,
    ).toStrictEqual({
      kind: "FUSION_IMAGE",
      name: "host",
      channel: "LATEST",
      version: "1.1.0",
    });
  });
});

describe("resumeRollout, forceEnvironmentUpdate and requestUpdateNow", () => {
  const rollout = (status: "ACTIVE" | "PAUSED") =>
    deps.store.promote({
      id: "r1",
      app_id: "a",
      artifact_name: "host",
      version: "1.1.0",
      status,
      apply_after: NOW,
      promoted_by: "0xp",
      promoted_at: NOW,
      paused_at: null,
      paused_reason: null,
    });

  it("resumes only the app's own PAUSED rollout", async () => {
    await rollout("ACTIVE");
    await expect(
      resumeRollout(deps, { appId: "b", rolloutId: "r1" }),
    ).rejects.toThrow("no such rollout");
    await expect(
      resumeRollout(deps, { appId: "a", rolloutId: "r1" }),
    ).rejects.toThrow(/is ACTIVE, not PAUSED/);
    await deps.store.pause("r1", "x", NOW);
    expect(await resumeRollout(deps, { appId: "a", rolloutId: "r1" })).toBe(
      true,
    );
  });

  it("forces a waiting or failed update, and nothing else", async () => {
    await expect(
      forceEnvironmentUpdate(deps, { appId: "a", environmentId: "cust" }),
    ).rejects.toThrow(/no update/);
    await deps.store.insertUpdate(
      update({
        status: "FAILED",
        error: "boom",
        started_at: NOW,
        finished_at: NOW,
      }),
    );
    expect(
      await forceEnvironmentUpdate(deps, { appId: "a", environmentId: "cust" }),
    ).toBe(true);
    expect(await deps.store.update("u1")).toMatchObject({
      status: "PENDING",
      forced_at: NOW,
      requested_at: NOW,
      started_at: null,
    });
  });

  it("clears a forced FAILED update's error, so its stale reason is not shown", async () => {
    await deps.store.insertUpdate(
      update({
        status: "FAILED",
        error: "boom",
        started_at: NOW,
        finished_at: NOW,
      }),
    );
    expect(
      await forceEnvironmentUpdate(deps, { appId: "a", environmentId: "cust" }),
    ).toBe(true);
    expect(await deps.store.update("u1")).toMatchObject({
      status: "PENDING",
      forced_at: NOW,
      error: null,
      finished_at: null,
    });
  });

  it.each([
    ["PENDING", "APPLYING"],
    ["FAILED", "SUCCEEDED"],
  ] as const)(
    "rejects a %s update that became %s before the force, changing nothing",
    async (from, to) => {
      await deps.store.insertUpdate(
        update({ status: from, error: from === "FAILED" ? "boom" : null }),
      );
      const real = deps.store;
      // The update moves on between the force's read and its write.
      deps = {
        ...deps,
        store: {
          ...real,
          latest: async (id) => {
            const u = await real.latest(id);
            await real.transitionUpdate("u1", from, {
              status: to,
              started_at: NOW,
            });
            return u;
          },
        },
      };
      const before = kicks;
      await expect(
        forceEnvironmentUpdate(deps, { appId: "a", environmentId: "cust" }),
      ).rejects.toThrow(/no longer waiting or failed/);
      expect(await real.update("u1")).toMatchObject({
        status: to,
        forced_at: null,
        requested_at: null,
        started_at: NOW,
      });
      expect(kicks).toBe(before);
    },
  );

  it("requests a PENDING update now, unless its rollout is paused", async () => {
    const row = (await deps.envRows.byEnvironment("cust"))!;
    await expect(requestUpdateNow(deps, row)).rejects.toThrow(/no update/);
    await rollout("PAUSED");
    await deps.store.insertUpdate(update({ rollout_id: "r1" }));
    await expect(requestUpdateNow(deps, row)).rejects.toThrow(/paused/);
    await deps.store.resume("r1");
    expect(await requestUpdateNow(deps, row)).toBe(true);
    expect((await deps.store.update("u1"))!.requested_at).toBe(NOW);
  });
});

describe("the read side", () => {
  it("lists each FUSION image's STAGING, LATEST and what the canaries run", async () => {
    await markCanary();
    point("STAGING", "1.1.0");
    states.set("mine", { status: "READY", version: "1.1.0" });
    expect(await releaseCandidates(deps, "a")).toStrictEqual([
      {
        artifactName: "host",
        staging: "1.1.0",
        latest: "1.0.0",
        canaries: [
          { environmentId: "mine", version: "1.1.0", status: "READY" },
        ],
      },
    ]);
    expect(await releaseCandidates(deps, "unknown")).toStrictEqual([]);
  });

  it("counts a rollout's updates by status", async () => {
    await deps.store.promote({
      id: "r1",
      app_id: "a",
      artifact_name: "host",
      version: "1.1.0",
      status: "ACTIVE",
      apply_after: NOW,
      promoted_by: "0xp",
      promoted_at: NOW,
      paused_at: null,
      paused_reason: null,
    });
    await deps.store.insertUpdate(update({ rollout_id: "r1" }));
    expect((await rolloutsOf(deps, "a"))[0]).toMatchObject({
      id: "r1",
      counts: [{ status: "PENDING", count: 1 }],
    });
  });

  it("shows the holder the open update and whether it can be applied now", async () => {
    expect(await environmentUpdate(deps, "cust")).toStrictEqual({
      open: null,
      history: [],
    });
    await deps.store.insertUpdate(update());
    expect((await environmentUpdate(deps, "cust")).open).toStrictEqual({
      toVersion: "1.1.0",
      dueAt: NOW,
      status: "PENDING",
      canUpdateNow: true,
    });
    await deps.store.patchUpdate("u1", { requested_at: NOW });
    expect((await environmentUpdate(deps, "cust")).open!.canUpdateNow).toBe(
      false,
    );
  });

  it("gives the publisher an environment's running version, canary flag and update", async () => {
    await markCanary();
    states.set("mine", { status: "READY", version: "1.1.0" });
    await deps.store.insertUpdate(
      update({ environment_id: "mine", status: "SUCCEEDED" }),
    );
    expect(await environmentRelease(deps, "mine")).toStrictEqual({
      runningVersion: "1.1.0",
      isCanary: true,
      update: {
        status: "SUCCEEDED",
        toVersion: "1.1.0",
        dueAt: NOW,
        error: null,
      },
    });
    expect(await environmentRelease(deps, "cust")).toStrictEqual({
      runningVersion: null,
      isCanary: false,
      update: null,
    });
  });
});

describe("a tampered app", () => {
  it("is never written to", async () => {
    await markCanary();
    written.length = 0;
    app = { ...app, tampered: true, tamperReason: "x" };
    await expect(
      setReleasePolicy(deps, { appId: "a", policy: "GATED" }),
    ).rejects.toThrow(/held/);
    await expect(markCanary()).rejects.toThrow(/held/);
    expect(written).toStrictEqual([]);
  });
});

const rolloutRow = (over: Partial<AppRollouts> = {}): AppRollouts => ({
  id: "r1",
  app_id: "a",
  artifact_name: "host",
  version: "1.1.0",
  status: "ACTIVE",
  apply_after: NOW,
  promoted_by: "0xp",
  promoted_at: NOW,
  paused_at: null,
  paused_reason: null,
  ...over,
});
const gate = async () => {
  await markCanary();
  await setReleasePolicy(deps, { appId: "a", policy: "GATED" });
};
const promoteIt = (
  over: { appId?: string; version?: string; noticeHours?: number | null } = {},
) =>
  promoteRelease(deps, {
    appId: "a",
    artifactName: "host",
    version: "1.1.0",
    promotedBy: "0xp",
    ...over,
  });
const publisherEnv = (id: string, over: Partial<LicenseEnvironments> = {}) =>
  db
    .insertInto("license_environments")
    .values(envRow(id, PUBLISHER, over))
    .execute();
const canaryOf = async (id: string) =>
  (await deps.envRows.byEnvironment(id))!.channel_override;

describe("leaving gating", () => {
  it.each([
    [
      "ACTIVE",
      /the release of host 1\.1\.0 is still rolling out and must finish first/,
    ],
    ["PAUSED", /the release of host 1\.1\.0 is paused and must finish first/],
  ] as const)("is refused while a rollout is %s", async (status, message) => {
    await gate();
    await deps.store.promote(rolloutRow({ status }));
    await expect(
      setReleasePolicy(deps, { appId: "a", policy: "AUTO" }),
    ).rejects.toThrow(message);
    expect((await deps.store.settings("a")).policy).toBe("GATED");
    expect(await canaryOf("mine")).toBe("STAGING");
  });

  it("is allowed once every rollout is COMPLETE or SUPERSEDED, and unmarks the canaries", async () => {
    await publisherEnv("mine2");
    await gate();
    await setCanaryEnvironment(deps, {
      appId: "a",
      environmentId: "mine2",
      canary: true,
      callerDid: PUBLISHER,
    });
    await deps.store.promote(rolloutRow({ id: "r1" }));
    await deps.store.promote(rolloutRow({ id: "r2" }));
    await deps.store.complete("r2");
    expect(
      await setReleasePolicy(deps, { appId: "a", policy: "AUTO" }),
    ).toMatchObject({ policy: "AUTO" });
    expect([await canaryOf("mine"), await canaryOf("mine2")]).toStrictEqual([
      null,
      null,
    ]);
    expect((await deps.store.settings("a")).policy).toBe("AUTO");
  });

  it("stays GATED when an unmark fails partway, and a retry finishes it", async () => {
    await publisherEnv("mine2");
    await gate();
    await setCanaryEnvironment(deps, {
      appId: "a",
      environmentId: "mine2",
      canary: true,
      callerDid: PUBLISHER,
    });
    const rows = deps.envRows;
    let unmarks = 0;
    deps = {
      ...deps,
      envRows: {
        ...rows,
        update: async (id, patch) => {
          if (patch.channel_override === null && ++unmarks === 2)
            throw new Error("database down");
          return rows.update(id, patch);
        },
      },
    };
    await expect(
      setReleasePolicy(deps, { appId: "a", policy: "AUTO" }),
    ).rejects.toThrow("database down");
    expect((await deps.store.settings("a")).policy).toBe("GATED");
    expect(
      [await canaryOf("mine"), await canaryOf("mine2")].filter(
        (c) => c !== null,
      ),
    ).toHaveLength(1);
    expect(
      await setReleasePolicy(deps, { appId: "a", policy: "AUTO" }),
    ).toMatchObject({ policy: "AUTO" });
    expect([await canaryOf("mine"), await canaryOf("mine2")]).toStrictEqual([
      null,
      null,
    ]);
    expect((await deps.store.settings("a")).policy).toBe("AUTO");
  });

  it("AUTO to AUTO touches nothing but the notice", async () => {
    await markCanary();
    written.length = 0;
    expect(
      await setReleasePolicy(deps, {
        appId: "a",
        policy: "AUTO",
        defaultNoticeHours: 12,
      }),
    ).toStrictEqual({ appId: "a", policy: "AUTO", defaultNoticeHours: 12 });
    expect(await canaryOf("mine")).toBe("STAGING");
    expect(written).toStrictEqual([]);
  });
});

describe("STAGING follows LATEST up when a canary starts following it", () => {
  it("is seeded at LATEST when a canary is marked and it has no pointer", async () => {
    await markCanary();
    expect(channelOps()).toStrictEqual(["STAGING 1.0.0"]);
  });

  it("moves up to LATEST when it is provably older", async () => {
    point("LATEST", "1.1.0");
    point("STAGING", "1.0.0");
    await markCanary();
    expect(channelOps()).toStrictEqual(["STAGING 1.1.0"]);
  });

  it("is left alone when it is newer than LATEST, or the order cannot be proven", async () => {
    point("STAGING", "1.1.0");
    await markCanary();
    point("STAGING", "sha-unrecorded");
    await markCanary();
    expect(channelOps()).toStrictEqual([]);
  });

  it("is left alone on an artifact with no LATEST", async () => {
    app.artifacts[0]!.channels = [];
    expect(await markCanary()).toBe(true);
    expect(written).toStrictEqual([]);
  });

  it("moves up when the app is gated with a stale STAGING", async () => {
    await markCanary();
    point("LATEST", "1.1.0");
    written.length = 0;
    await setReleasePolicy(deps, { appId: "a", policy: "GATED" });
    expect(channelOps()).toStrictEqual(["STAGING 1.1.0"]);
  });
});

describe("promote is forward-only", () => {
  beforeEach(gate);

  it("refuses a version older than LATEST and writes nothing", async () => {
    point("LATEST", "1.1.0");
    states.set("mine", { status: "READY", version: "1.0.0" });
    written.length = 0;
    await expect(promoteIt({ version: "1.0.0" })).rejects.toThrow(
      "host 1.0.0 is older than its LATEST 1.1.0: releases only move forward",
    );
    expect(written).toStrictEqual([]);
    expect(await deps.store.rolloutsOf("a")).toStrictEqual([]);
  });

  it("allows the version LATEST already points at", async () => {
    point("LATEST", "1.1.0");
    states.set("mine", { status: "READY", version: "1.1.0" });
    expect(await promoteIt()).toMatchObject({ version: "1.1.0" });
  });

  it("allows a version whose order to LATEST cannot be proven", async () => {
    app.artifacts[0]!.versions.push({
      version: "sha-new",
      reference: "cr.vetra.io/p/host:sha-new",
    });
    point("LATEST", "sha-unrecorded");
    states.set("mine", { status: "READY", version: "sha-new" });
    expect(await promoteIt({ version: "sha-new" })).toMatchObject({
      version: "sha-new",
    });
  });
});

describe("promote's canary and notice checks", () => {
  beforeEach(gate);

  it("refuses an ended canary, another app's canary and a canary READY on another version", async () => {
    await deps.envRows.update("mine", { ended_at: NOW });
    states.set("mine", { status: "READY", version: "1.1.0" });
    await expect(promoteIt()).rejects.toThrow(/no canary environment/);
    await deps.envRows.update("mine", { ended_at: null });
    states.delete("mine");
    await publisherEnv("other", { app_id: "b", channel_override: "STAGING" });
    states.set("other", { status: "READY", version: "1.1.0" });
    await expect(promoteIt()).rejects.toThrow(/no canary environment/);
    states.set("mine", { status: "READY", version: "1.0.0" });
    await expect(promoteIt()).rejects.toThrow(/no canary environment/);
    expect(await deps.store.rolloutsOf("a")).toStrictEqual([]);
  });

  it("takes a whole notice from 0 to 720 hours", async () => {
    states.set("mine", { status: "READY", version: "1.1.0" });
    for (const noticeHours of [-1, 1.5, 721]) {
      await expect(promoteIt({ noticeHours })).rejects.toThrow(/noticeHours/);
    }
    expect((await promoteIt({ noticeHours: 0 })).apply_after).toBe(NOW);
    expect((await promoteIt({ noticeHours: 720 })).apply_after).toBe(
      "2026-12-10T12:00:00.000Z",
    );
  });

  it("refuses an app without a readable document as NOT_FOUND", async () => {
    await deps.store.saveSettings(
      { appId: "b", policy: "GATED", defaultNoticeHours: 0 },
      NOW,
    );
    await expect(promoteIt({ appId: "b" })).rejects.toBeInstanceOf(
      UnknownAppError,
    );
  });
});

describe("force's refusals", () => {
  it("treats another app's environment as missing", async () => {
    await deps.store.insertUpdate(update({ status: "FAILED" }));
    await expect(
      forceEnvironmentUpdate(deps, { appId: "b", environmentId: "cust" }),
    ).rejects.toBeInstanceOf(UnknownEnvironmentError);
  });

  it.each(["SUCCEEDED", "APPLYING"] as const)(
    "refuses when the latest update is %s",
    async (status) => {
      await deps.store.insertUpdate(update({ status }));
      await expect(
        forceEnvironmentUpdate(deps, { appId: "a", environmentId: "cust" }),
      ).rejects.toThrow(/no update/);
      expect((await deps.store.update("u1"))!.forced_at).toBeNull();
    },
  );
});

describe("one release decision of an app at a time", () => {
  it("two concurrent unmarks cannot leave a gated app without a canary", async () => {
    await publisherEnv("mine2");
    await gate();
    await setCanaryEnvironment(deps, {
      appId: "a",
      environmentId: "mine2",
      canary: true,
      callerDid: PUBLISHER,
    });
    const unmark = (environmentId: string) =>
      setCanaryEnvironment(deps, {
        appId: "a",
        environmentId,
        canary: false,
        callerDid: PUBLISHER,
      });
    const results = await Promise.allSettled([unmark("mine"), unmark("mine2")]);
    expect(results.map((r) => r.status)).toStrictEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(await canaryOf("mine2")).toBe("STAGING");
  });

  it("a promotion and leaving gating cannot both go through", async () => {
    await gate();
    states.set("mine", { status: "READY", version: "1.1.0" });
    const results = await Promise.allSettled([
      promoteIt(),
      setReleasePolicy(deps, { appId: "a", policy: "AUTO" }),
    ]);
    expect(results.map((r) => r.status)).toStrictEqual([
      "fulfilled",
      "rejected",
    ]);
    expect((await deps.store.settings("a")).policy).toBe("GATED");
  });

  it("two concurrent promotions cannot move LATEST backwards", async () => {
    await publisherEnv("mine2");
    app.artifacts[0]!.versions.push({
      version: "1.2.0",
      reference: "cr.vetra.io/p/host:1.2.0",
    });
    await gate();
    await setCanaryEnvironment(deps, {
      appId: "a",
      environmentId: "mine2",
      canary: true,
      callerDid: PUBLISHER,
    });
    states.set("mine", { status: "READY", version: "1.2.0" });
    states.set("mine2", { status: "READY", version: "1.1.0" });
    const results = await Promise.allSettled([
      promoteIt({ version: "1.2.0" }),
      promoteIt({ version: "1.1.0" }),
    ]);
    expect(results.map((r) => r.status)).toStrictEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(
      app.artifacts[0]!.channels.find((c) => c.channel === "LATEST")!.version,
    ).toBe("1.2.0");
  });
});
