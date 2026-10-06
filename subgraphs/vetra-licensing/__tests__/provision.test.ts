import { describe, it, expect, vi } from "vitest";
import { defaultGlobalState } from "document-models/vetra-cloud-environment";
import {
  applyEnvironmentTemplate,
  AppEnvironmentCapReachedError,
  LicenseTypeUnavailableError,
  UNAPPLIED_TEMPLATE_HASH,
  type ProvisionDeps,
} from "../provision.js";
import type { AppUserEnvironments } from "../db/schema.js";
import {
  templateHash as hashOf,
  UnknownTemplateSizeError,
  type TemplateShape,
} from "../template.js";

const template: TemplateShape = {
  services: [{ id: "s1", type: "CONNECT", prefix: "connect" }],
  packages: [],
  size: null,
  baseDomain: "vetra.io",
  packageRegistry: null,
};

const USER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const input = {
  appId: "app-1",
  user: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  licenseId: "lic-1",
  template,
  label: "Acme vault",
  now: "2026-10-06T12:00:00.000Z",
};

const existingRow = (templateHash: string): AppUserEnvironments => ({
  app_id: "app-1",
  user_address: USER,
  environment_id: "env-1",
  license_id: "lic-1",
  template_hash: templateHash,
  created_at: input.now,
  updated_at: input.now,
});

/** An environment that has been initialized, so provisioning must update it. */
const liveState = () => ({ ...defaultGlobalState(), status: "READY" as const });

const base = (over: Partial<ProvisionDeps> = {}) => {
  const deps = {
    findRow: vi.fn<ProvisionDeps["findRow"]>(async () => null),
    countForApp: vi.fn<ProvisionDeps["countForApp"]>(async () => 0),
    maxForApp: vi.fn<ProvisionDeps["maxForApp"]>(async () => 50),
    claimRow: vi.fn<ProvisionDeps["claimRow"]>(async (row) => row),
    upsertRow: vi.fn<ProvisionDeps["upsertRow"]>(async (row) => row),
    envs: {
      create: vi.fn<ProvisionDeps["envs"]["create"]>(async () => "env-1"),
      execute: vi.fn<ProvisionDeps["envs"]["execute"]>(async () => undefined),
      getState: vi.fn<ProvisionDeps["envs"]["getState"]>(async () => null),
      delete: vi.fn<ProvisionDeps["envs"]["delete"]>(async () => undefined),
    },
    generateSubdomain: (id: string) => `sub-${id}`,
    ...over,
  };
  return deps;
};

describe("applyEnvironmentTemplate", () => {
  it("creates an environment when none exists", async () => {
    const d = base();
    const row = await applyEnvironmentTemplate(d, input);
    expect(d.envs.create).toHaveBeenCalledOnce();
    expect(d.envs.execute).toHaveBeenCalledOnce();
    expect(row.environment_id).toBe("env-1");
    expect(row.user_address).toBe(USER);
    expect(row.template_hash).toBe(hashOf(template));
  });

  // Claim-first: the row owns the document before any action is applied to it.
  it("claims the row before touching the new document", async () => {
    const order: string[] = [];
    const claimRow = vi.fn<ProvisionDeps["claimRow"]>(async (row) => {
      order.push("claim");
      return row;
    });
    const d = base({
      claimRow,
      envs: {
        create: vi.fn(async () => {
          order.push("create");
          return "env-1";
        }),
        execute: vi.fn(async () => {
          order.push("execute");
        }),
        getState: vi.fn(async () => null),
        delete: vi.fn(async () => undefined),
      },
    });
    await applyEnvironmentTemplate(d, input);
    expect(order).toEqual(["create", "claim", "execute"]);
    expect(claimRow.mock.calls[0][0].template_hash).toBe(
      UNAPPLIED_TEMPLATE_HASH,
    );
  });

  // The defect this replaces leaked one environment document per tick forever.
  it("reuses the claimed document after a rejected action list", async () => {
    const store = new Map<string, AppUserEnvironments>();
    let created = 0;
    let rejections = 1;
    const d = base({
      findRow: vi.fn(async (a, u) => store.get(`${a}|${u}`) ?? null),
      claimRow: vi.fn(async (row) => {
        const key = `${row.app_id}|${row.user_address}`;
        const held = store.get(key);
        if (held) return held;
        store.set(key, row);
        return row;
      }),
      upsertRow: vi.fn(async (row) => {
        store.set(`${row.app_id}|${row.user_address}`, row);
        return row;
      }),
      envs: {
        create: vi.fn(async () => `env-${++created}`),
        execute: vi.fn(async () => {
          if (rejections-- > 0) throw new Error("ENABLE_SERVICE rejected");
        }),
        // A document whose action list was rejected never left DRAFT.
        getState: vi.fn(async () => null),
        delete: vi.fn(async () => undefined),
      },
    });

    await expect(applyEnvironmentTemplate(d, input)).rejects.toThrow(
      "ENABLE_SERVICE rejected",
    );
    const claimed = store.get(`app-1|${USER}`);
    expect(claimed?.environment_id).toBe("env-1");
    expect(claimed?.template_hash).toBe(UNAPPLIED_TEMPLATE_HASH);

    const row = await applyEnvironmentTemplate(d, input);
    expect(created).toBe(1);
    expect(d.envs.create).toHaveBeenCalledOnce();
    expect(row.environment_id).toBe("env-1");
    expect(row.template_hash).toBe(hashOf(template));
  });

  it("creates nothing on a second identical call", async () => {
    const d = base({
      findRow: vi.fn(async () => existingRow(hashOf(template))),
    });
    const row = await applyEnvironmentTemplate(d, input);
    expect(row.environment_id).toBe("env-1");
    expect(d.envs.create).not.toHaveBeenCalled();
    expect(d.envs.execute).not.toHaveBeenCalled();
    expect(d.upsertRow).not.toHaveBeenCalled();
  });

  // lic-1 expired and lic-2 was issued for the same user and type. The
  // environment is already right, so nothing is dispatched to it, but the row
  // must stop citing the expired licence.
  it("repoints the row at a renewed licence without touching the environment", async () => {
    const upsertRow = vi.fn<ProvisionDeps["upsertRow"]>(async (r) => r);
    const d = base({
      findRow: vi.fn(async () => existingRow(hashOf(template))),
      upsertRow,
    });
    const row = await applyEnvironmentTemplate(d, {
      ...input,
      licenseId: "lic-2",
      now: "2026-11-01T00:00:00.000Z",
    });
    expect(upsertRow).toHaveBeenCalledOnce();
    expect(upsertRow.mock.calls[0][0]).toMatchObject({
      environment_id: "env-1",
      license_id: "lic-2",
      template_hash: hashOf(template),
      created_at: input.now,
      updated_at: "2026-11-01T00:00:00.000Z",
    });
    expect(row.license_id).toBe("lic-2");
    expect(d.envs.create).not.toHaveBeenCalled();
    expect(d.envs.execute).not.toHaveBeenCalled();
    expect(d.envs.getState).not.toHaveBeenCalled();
    expect(d.claimRow).not.toHaveBeenCalled();
  });

  it("is idempotent end to end against a stateful store", async () => {
    const store = new Map<string, AppUserEnvironments>();
    const d = base({
      findRow: vi.fn(async (a, u) => store.get(`${a}|${u}`) ?? null),
      claimRow: vi.fn(async (row) => {
        const key = `${row.app_id}|${row.user_address}`;
        const held = store.get(key);
        if (held) return held;
        store.set(key, row);
        return row;
      }),
      upsertRow: vi.fn(async (row) => {
        store.set(`${row.app_id}|${row.user_address}`, row);
        return row;
      }),
    });
    await applyEnvironmentTemplate(d, input);
    await applyEnvironmentTemplate(d, input);
    expect(d.envs.create).toHaveBeenCalledOnce();
    expect(d.envs.execute).toHaveBeenCalledOnce();
    expect(store.size).toBe(1);
  });

  // Two concurrent first-time calls must yield one environment, and the loser
  // must not leave a fully-provisioned document behind that nothing can reclaim.
  it("deletes the loser's document when two calls race", async () => {
    let created = 0;
    const store = new Map<string, AppUserEnvironments>();
    const d = base({
      envs: {
        create: vi.fn(async () => `env-${++created}`),
        execute: vi.fn(async () => undefined),
        getState: vi.fn(async () => null),
        delete: vi.fn(async () => undefined),
      },
      claimRow: vi.fn(async (row) => {
        const key = `${row.app_id}|${row.user_address}`;
        const held = store.get(key);
        if (held) return held;
        store.set(key, row);
        return row;
      }),
      upsertRow: vi.fn(async (row) => {
        const key = `${row.app_id}|${row.user_address}`;
        const winner = store.get(key);
        const landed = winner
          ? {
              ...winner,
              template_hash: row.template_hash,
              updated_at: row.updated_at,
            }
          : row;
        store.set(key, landed);
        return landed;
      }),
    });
    const [a, b] = await Promise.all([
      applyEnvironmentTemplate(d, input),
      applyEnvironmentTemplate(d, input),
    ]);
    expect(a.environment_id).toBe(b.environment_id);
    expect(store.size).toBe(1);
    expect(d.envs.delete).toHaveBeenCalledTimes(1);
    expect(d.envs.delete).toHaveBeenCalledWith("env-2");
  });

  it("refuses when the template is unavailable and leaves the environment alone", async () => {
    const d = base({ findRow: vi.fn(async () => existingRow("stale")) });
    await expect(
      applyEnvironmentTemplate(d, { ...input, template: null }),
    ).rejects.toBeInstanceOf(LicenseTypeUnavailableError);
    expect(d.envs.create).not.toHaveBeenCalled();
    expect(d.envs.execute).not.toHaveBeenCalled();
    expect(d.upsertRow).not.toHaveBeenCalled();
  });

  it("refuses a new environment at the cap", async () => {
    const d = base({
      countForApp: vi.fn(async () => 50),
      maxForApp: vi.fn(async () => 50),
    });
    await expect(applyEnvironmentTemplate(d, input)).rejects.toBeInstanceOf(
      AppEnvironmentCapReachedError,
    );
    expect(d.envs.create).not.toHaveBeenCalled();
  });

  it("still updates an existing environment at the cap", async () => {
    const d = base({
      countForApp: vi.fn(async () => 50),
      maxForApp: vi.fn(async () => 50),
      findRow: vi.fn(async () => existingRow("stale")),
    });
    const row = await applyEnvironmentTemplate(d, input);
    expect(d.envs.execute).toHaveBeenCalled();
    expect(d.envs.create).not.toHaveBeenCalled();
    expect(row.template_hash).toBe(hashOf(template));
  });

  it("updates an initialized environment without replaying the create actions", async () => {
    const execute = vi.fn<ProvisionDeps["envs"]["execute"]>(
      async () => undefined,
    );
    const d = base({
      findRow: vi.fn(async () => existingRow("stale")),
      envs: {
        create: vi.fn(async () => "env-1"),
        execute,
        getState: vi.fn(async () => liveState()),
        delete: vi.fn(async () => undefined),
      },
    });
    await applyEnvironmentTemplate(d, input);
    const types = execute.mock.calls[0][1].map((a) => a.type);
    expect(types).not.toContain("INITIALIZE");
    expect(types).not.toContain("SET_OWNER");
  });

  it("keeps created_at from the row it is updating", async () => {
    const d = base({ findRow: vi.fn(async () => existingRow("stale")) });
    const row = await applyEnvironmentTemplate(d, {
      ...input,
      now: "2026-11-01T00:00:00.000Z",
    });
    expect(row.created_at).toBe(input.now);
    expect(row.updated_at).toBe("2026-11-01T00:00:00.000Z");
  });

  it("lets an unknown template size propagate unchanged", async () => {
    const d = base();
    await expect(
      applyEnvironmentTemplate(d, {
        ...input,
        template: { ...template, size: "HUGE" },
      }),
    ).rejects.toBeInstanceOf(UnknownTemplateSizeError);
    expect(d.envs.create).not.toHaveBeenCalled();
    expect(d.claimRow).not.toHaveBeenCalled();
    expect(d.upsertRow).not.toHaveBeenCalled();
  });
});
