import { describe, expect, it, vi } from "vitest";
import type { Action } from "document-model";
import type { AppDocView } from "../app-reads.js";
import type { LicenseEnvironments } from "../db/schema.js";
import { createManagedBySync, wantedManagedBy } from "../managed-by.js";

const T = "2026-11-10T00:00:00.000Z";
const tpl = (id: string, mode: "SHARED" | "DEDICATED", types: string[]) => ({
  id,
  name: null,
  mode,
  sharedEnvironment: null,
  warmPoolSize: 0,
  templateHash: `h-${id}`,
  resolutionError: null,
  template: {
    services: types.map((type, i) => ({ id: `s${i}`, type, prefix: null })),
    packages: [],
    size: null,
    baseDomain: null,
    packageRegistry: null,
  },
});
const app = (types = ["FUSION", "CONNECT"]): AppDocView => ({
  id: "a",
  name: "Sektar",
  slug: "sektar",
  owner: "0xo",
  status: "ACTIVE",
  identityDid: null,
  productionEnvironmentId: null,
  templates: [tpl("t", "DEDICATED", types), tpl("sh", "SHARED", ["CONNECT"])],
  terms: [],
  artifacts: [],
  tampered: false,
  tamperReason: null,
  licensingStateHash: "x",
  unverified: false,
});
const row = (over: Partial<LicenseEnvironments> = {}): LicenseEnvironments => ({
  environment_id: "e1",
  root_license_id: "l1",
  app_id: "a",
  user_did: "u",
  license_id: "l1",
  template_id: "t",
  label: null,
  template_hash: "h",
  ended_at: null,
  stopped_at: null,
  delete_after: null,
  created_at: T,
  updated_at: T,
  ...over,
});
const WANTED = {
  appId: "a",
  templateId: "t",
  rootLicenseId: "l1",
  services: ["CONNECT", "FUSION"],
};

describe("wantedManagedBy", () => {
  it("names the app, template, chain and the template's service types in model order", () => {
    expect(wantedManagedBy(row(), app())).toStrictEqual(WANTED);
  });
  it("is null for an unknown or SHARED template", () => {
    expect(wantedManagedBy(row({ template_id: "gone" }), app())).toBeNull();
    expect(wantedManagedBy(row({ template_id: "sh" }), app())).toBeNull();
  });
});

describe("createManagedBySync", () => {
  function setup(state: Record<string, unknown> | null) {
    const executed: Action[][] = [];
    const getState = vi.fn(async () => state as never);
    const warn = vi.fn();
    const sync = createManagedBySync({
      envs: {
        getState,
        execute: async (_id, actions) => {
          executed.push(actions);
        },
      },
      logger: { warn },
    });
    return { sync, executed, getState, warn };
  }

  it("backfills a live environment without the marker, once", async () => {
    const s = setup({ status: "READY", managedBy: null });
    await s.sync(app(), [row()]);
    await s.sync(app(), [row()]);
    expect(s.executed).toHaveLength(1);
    expect(s.executed[0]!.map((a) => a.type)).toStrictEqual(["SET_MANAGED_BY"]);
    expect(s.executed[0]![0]!.input).toStrictEqual(WANTED);
    expect(s.getState).toHaveBeenCalledOnce();
  });

  it("leaves a document that already carries the marker, and re-marks it when the template's services change", async () => {
    const s = setup({ status: "READY", managedBy: WANTED });
    await s.sync(app(), [row()]);
    expect(s.executed).toHaveLength(0);
    await s.sync(app(["FUSION", "CONNECT", "SWITCHBOARD"]), [row()]);
    expect(s.executed[0]![0]!.input).toMatchObject({
      services: ["CONNECT", "SWITCHBOARD", "FUSION"],
    });
  });

  it("leaves a marker whose services only differ in order", async () => {
    const s = setup({
      status: "READY",
      managedBy: { ...WANTED, services: ["FUSION", "CONNECT"] },
    });
    await s.sync(app(), [row()]);
    expect(s.executed).toHaveLength(0);
  });

  it("leaves an ended environment alone", async () => {
    const s = setup({ status: "STOPPED", managedBy: null });
    await s.sync(app(), [row({ ended_at: T })]);
    expect(s.getState).not.toHaveBeenCalled();
    expect(s.executed).toHaveLength(0);
  });

  it("skips a DRAFT or missing document and tries again next time", async () => {
    const draft = setup({ status: "DRAFT", managedBy: null });
    await draft.sync(app(), [row()]);
    await draft.sync(app(), [row()]);
    expect(draft.executed).toHaveLength(0);
    expect(draft.getState).toHaveBeenCalledTimes(2);
    const gone = setup(null);
    await gone.sync(app(), [row()]);
    expect(gone.executed).toHaveLength(0);
  });

  it("logs a failed write and retries it", async () => {
    const getState = vi.fn(
      async () => ({ status: "READY", managedBy: null }) as never,
    );
    const warn = vi.fn();
    let calls = 0;
    const sync = createManagedBySync({
      envs: {
        getState,
        execute: async () => {
          if (++calls === 1) throw new Error("reactor down");
        },
      },
      logger: { warn },
    });
    await sync(app(), [row()]);
    await sync(app(), [row()]);
    expect(calls).toBe(2);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "marking environment e1 as managed by app a failed: Error: reactor down",
      ),
    );
  });

  it("logs a write that keeps failing once, again when its message changes, and again after a success", async () => {
    const warn = vi.fn();
    let failure: string | null = "reactor down";
    const sync = createManagedBySync({
      envs: {
        getState: async () => ({ status: "READY", managedBy: null }) as never,
        execute: async () => {
          if (failure) throw new Error(failure);
        },
      },
      logger: { warn },
    });
    await sync(app(), [row()]);
    await sync(app(), [row()]);
    expect(warn).toHaveBeenCalledOnce();
    failure = "locked";
    await sync(app(), [row()]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith(
      expect.stringContaining("failed: Error: locked"),
    );
    failure = null;
    await sync(app(), [row()]);
    // The marker changes, so the next tick writes (and fails) again.
    failure = "locked";
    await sync(app(["FUSION"]), [row()]);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("forgets an ended environment, so a live row for it again is re-checked", async () => {
    const s = setup({ status: "READY", managedBy: null });
    await s.sync(app(), [row()]);
    await s.sync(app(), [row({ ended_at: T })]);
    await s.sync(app(), [row()]);
    expect(s.getState).toHaveBeenCalledTimes(2);
  });

  it("leaves a row without a template alone", async () => {
    const s = setup({ status: "READY", managedBy: null });
    await s.sync(app(), [row({ template_id: null })]);
    expect(s.getState).not.toHaveBeenCalled();
    expect(s.executed).toHaveLength(0);
  });

  it("marks a stopped environment that has not ended", async () => {
    const s = setup({ status: "STOPPED", managedBy: null });
    await s.sync(app(), [row({ stopped_at: T })]);
    expect(s.executed).toHaveLength(1);
    expect(s.executed[0]![0]!.input).toStrictEqual(WANTED);
  });

  it("re-marks an environment whose row moves to another template", async () => {
    const two: AppDocView = {
      ...app(),
      templates: [
        tpl("t", "DEDICATED", ["FUSION", "CONNECT"]),
        tpl("t2", "DEDICATED", ["SWITCHBOARD"]),
      ],
    };
    const s = setup({ status: "READY", managedBy: WANTED });
    await s.sync(two, [row()]);
    expect(s.executed).toHaveLength(0);
    await s.sync(two, [row({ template_id: "t2" })]);
    expect(s.executed).toHaveLength(1);
    expect(s.executed[0]![0]!.input).toStrictEqual({
      appId: "a",
      templateId: "t2",
      rootLicenseId: "l1",
      services: ["SWITCHBOARD"],
    });
  });

  it("marks the other environments when one fails", async () => {
    const executed: string[] = [];
    const sync = createManagedBySync({
      envs: {
        getState: async (id) => {
          if (id === "e1") throw new Error("reactor down");
          return { status: "READY", managedBy: null } as never;
        },
        execute: async (id) => {
          executed.push(id);
        },
      },
      logger: { warn: vi.fn() },
    });
    await sync(app(), [
      row(),
      row({ environment_id: "e2", root_license_id: "l2" }),
    ]);
    expect(executed).toStrictEqual(["e2"]);
  });
});
