import { describe, it, expect, vi } from "vitest";
import {
  applyEnvironmentTemplate,
  AppEnvironmentCapReachedError,
  LicenseTypeUnavailableError,
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

const base = (over: Partial<ProvisionDeps> = {}) => {
  const deps = {
    findRow: vi.fn<ProvisionDeps["findRow"]>(async () => null),
    countForApp: vi.fn<ProvisionDeps["countForApp"]>(async () => 0),
    maxForApp: vi.fn<ProvisionDeps["maxForApp"]>(async () => 50),
    upsertRow: vi.fn<ProvisionDeps["upsertRow"]>(async (row) => row),
    envs: {
      create: vi.fn<ProvisionDeps["envs"]["create"]>(async () => "env-1"),
      execute: vi.fn<ProvisionDeps["envs"]["execute"]>(async () => undefined),
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

  it("creates nothing on a second identical call", async () => {
    const d = base({ findRow: vi.fn(async () => existingRow(hashOf(template))) });
    const row = await applyEnvironmentTemplate(d, input);
    expect(row.environment_id).toBe("env-1");
    expect(d.envs.create).not.toHaveBeenCalled();
    expect(d.envs.execute).not.toHaveBeenCalled();
    expect(d.upsertRow).not.toHaveBeenCalled();
  });

  it("is idempotent end to end against a stateful store", async () => {
    const store = new Map<string, AppUserEnvironments>();
    const d = base({
      findRow: vi.fn(async (a, u) => store.get(`${a}|${u}`) ?? null),
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

  // Two concurrent first-time calls must yield one environment. The database
  // closes the race: the first writer's environment_id survives and the loser
  // adopts it, so the function must return what upsertRow returns.
  it("adopts the winner's environment when two calls race", async () => {
    let created = 0;
    const store = new Map<string, AppUserEnvironments>();
    const d = base({
      envs: {
        create: vi.fn(async () => `env-${++created}`),
        execute: vi.fn(async () => undefined),
      },
      upsertRow: vi.fn(async (row) => {
        const key = `${row.app_id}|${row.user_address}`;
        const winner = store.get(key);
        const landed = winner
          ? { ...winner, template_hash: row.template_hash, updated_at: row.updated_at }
          : row;
        store.set(key, landed);
        return landed;
      }),
    });
    const [a, b] = await Promise.all([
      applyEnvironmentTemplate(d, input),
      applyEnvironmentTemplate(d, input),
    ]);
    expect(d.upsertRow).toHaveBeenCalledTimes(2);
    expect(a.environment_id).toBe(b.environment_id);
    expect(store.size).toBe(1);
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
    const d = base({ countForApp: vi.fn(async () => 50), maxForApp: vi.fn(async () => 50) });
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

  it("lets an unknown template size propagate unchanged", async () => {
    const d = base();
    await expect(
      applyEnvironmentTemplate(d, { ...input, template: { ...template, size: "HUGE" } }),
    ).rejects.toBeInstanceOf(UnknownTemplateSizeError);
    expect(d.envs.create).not.toHaveBeenCalled();
    expect(d.upsertRow).not.toHaveBeenCalled();
  });
});
