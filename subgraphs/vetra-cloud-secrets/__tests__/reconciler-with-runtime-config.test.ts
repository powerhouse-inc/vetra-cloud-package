import { vi } from "vitest";
import { createReconciler } from "../reconciler.js";
import type { SecretsRepository } from "../repository.js";
import type { K8sClient } from "../k8s-client.js";
import type { OpenBaoTransitClient } from "../openbao-transit.js";
import type { RuntimeConfigRepository } from "../../runtime-config/repository.js";
import { RUNTIME_CONFIG_ENV_KEY } from "../../runtime-config/types.js";

function mockRepo(overrides: Partial<SecretsRepository> = {}): SecretsRepository {
  return {
    envVarsForTenant: vi.fn().mockResolvedValue([]),
    secretsForTenant: vi.fn().mockResolvedValue([]),
    allTenantIds: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function mockRuntimeConfigRepo(
  overrides: Partial<RuntimeConfigRepository> = {},
): RuntimeConfigRepository {
  return {
    runtimeConfigForTenant: vi.fn().mockResolvedValue(null),
    allTenantIds: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function mockK8s(): K8sClient & {
  upsertConfigMap: ReturnType<typeof vi.fn>;
  upsertSecret: ReturnType<typeof vi.fn>;
} {
  return {
    upsertConfigMap: vi.fn().mockResolvedValue("updated"),
    upsertSecret: vi.fn().mockResolvedValue("updated"),
  };
}

function mockTransit(
  overrides: Partial<OpenBaoTransitClient> = {},
): OpenBaoTransitClient {
  return {
    authenticate: vi.fn(),
    ensureTenantKey: vi.fn().mockResolvedValue(undefined),
    keyFor: vi
      .fn()
      .mockImplementation((tenantId: string) => `vetra-tenant-${tenantId}`),
    encrypt: vi.fn(),
    decrypt: vi
      .fn()
      .mockImplementation(async (_tenantId: string, ciphertext: string) =>
        ciphertext.replace(/^vault:v\d+:/, ""),
      ),
    ...overrides,
  } as OpenBaoTransitClient;
}

describe("reconcileTenant — runtime-config fan-in", () => {
  it("projects runtime-config row as PH_CONNECT_CONFIG_JSON wrapped in envelope", async () => {
    const repo = mockRepo({
      envVarsForTenant: vi.fn().mockResolvedValue([{ key: "OTHER", value: "X" }]),
    });
    const runtimeConfigRepo = mockRuntimeConfigRepo({
      runtimeConfigForTenant: vi.fn().mockResolvedValue({
        value: JSON.stringify({ branding: { appName: "Acme" } }),
        updatedAt: "2026-05-28T00:00:00Z",
      }),
    });
    const k8s = mockK8s();
    const r = createReconciler({
      repo,
      runtimeConfigRepo,
      k8s,
      transit: mockTransit(),
      managedLabelValue: "test",
    });

    await r.reconcileTenant("dev");

    expect(k8s.upsertConfigMap).toHaveBeenCalledWith(
      { namespace: "dev", name: "dev-env", managedLabel: "test" },
      expect.objectContaining({
        OTHER: "X",
        [RUNTIME_CONFIG_ENV_KEY]: JSON.stringify({
          connect: { branding: { appName: "Acme" } },
        }),
      }),
    );
  });

  it("omits PH_CONNECT_CONFIG_JSON when no runtime-config row exists", async () => {
    const repo = mockRepo({
      envVarsForTenant: vi.fn().mockResolvedValue([{ key: "A", value: "1" }]),
    });
    const runtimeConfigRepo = mockRuntimeConfigRepo({
      runtimeConfigForTenant: vi.fn().mockResolvedValue(null),
    });
    const k8s = mockK8s();
    const r = createReconciler({
      repo,
      runtimeConfigRepo,
      k8s,
      transit: mockTransit(),
      managedLabelValue: "test",
    });

    await r.reconcileTenant("dev");

    expect(k8s.upsertConfigMap).toHaveBeenCalledWith(
      { namespace: "dev", name: "dev-env", managedLabel: "test" },
      { A: "1" },
    );
    const callArgs = k8s.upsertConfigMap.mock.calls[0][1] as Record<string, string>;
    expect(callArgs[RUNTIME_CONFIG_ENV_KEY]).toBeUndefined();
  });

  it("still works when no env vars exist but runtime-config does", async () => {
    const repo = mockRepo({
      envVarsForTenant: vi.fn().mockResolvedValue([]),
    });
    const runtimeConfigRepo = mockRuntimeConfigRepo({
      runtimeConfigForTenant: vi.fn().mockResolvedValue({
        value: JSON.stringify({ app: { logLevel: "debug" } }),
        updatedAt: "2026-05-28T00:00:00Z",
      }),
    });
    const k8s = mockK8s();
    const r = createReconciler({
      repo,
      runtimeConfigRepo,
      k8s,
      transit: mockTransit(),
      managedLabelValue: "test",
    });

    await r.reconcileTenant("dev");

    expect(k8s.upsertConfigMap).toHaveBeenCalledWith(
      { namespace: "dev", name: "dev-env", managedLabel: "test" },
      {
        [RUNTIME_CONFIG_ENV_KEY]: JSON.stringify({
          connect: { app: { logLevel: "debug" } },
        }),
      },
    );
  });

  it("skips runtime-config when stored value is invalid JSON (does not throw)", async () => {
    const repo = mockRepo({
      envVarsForTenant: vi.fn().mockResolvedValue([{ key: "A", value: "1" }]),
    });
    const runtimeConfigRepo = mockRuntimeConfigRepo({
      runtimeConfigForTenant: vi.fn().mockResolvedValue({
        value: "{not-json",
        updatedAt: "2026-05-28T00:00:00Z",
      }),
    });
    const k8s = mockK8s();
    const r = createReconciler({
      repo,
      runtimeConfigRepo,
      k8s,
      transit: mockTransit(),
      managedLabelValue: "test",
    });

    await r.reconcileTenant("dev");

    // ConfigMap still gets written without PH_CONNECT_CONFIG_JSON.
    expect(k8s.upsertConfigMap).toHaveBeenCalledWith(
      { namespace: "dev", name: "dev-env", managedLabel: "test" },
      { A: "1" },
    );
  });

  it("skips runtime-config when stored value is an array (object guard)", async () => {
    const repo = mockRepo();
    const runtimeConfigRepo = mockRuntimeConfigRepo({
      runtimeConfigForTenant: vi.fn().mockResolvedValue({
        value: JSON.stringify([1, 2, 3]),
        updatedAt: "2026-05-28T00:00:00Z",
      }),
    });
    const k8s = mockK8s();
    const r = createReconciler({
      repo,
      runtimeConfigRepo,
      k8s,
      transit: mockTransit(),
      managedLabelValue: "test",
    });

    await r.reconcileTenant("dev");

    expect(k8s.upsertConfigMap).toHaveBeenCalledWith(
      { namespace: "dev", name: "dev-env", managedLabel: "test" },
      {},
    );
  });

  it("backward compatible: works without runtimeConfigRepo (undefined)", async () => {
    const repo = mockRepo({
      envVarsForTenant: vi.fn().mockResolvedValue([{ key: "A", value: "1" }]),
    });
    const k8s = mockK8s();
    const r = createReconciler({
      repo,
      // No runtimeConfigRepo at all — secrets-only mode.
      k8s,
      transit: mockTransit(),
      managedLabelValue: "test",
    });

    await r.reconcileTenant("dev");

    expect(k8s.upsertConfigMap).toHaveBeenCalledWith(
      { namespace: "dev", name: "dev-env", managedLabel: "test" },
      { A: "1" },
    );
  });
});

describe("reconcileAll — runtime-config fan-in", () => {
  it("unions secrets + runtime-config tenant ids", async () => {
    const repo = mockRepo({
      allTenantIds: vi.fn().mockResolvedValue(["a", "b"]),
      envVarsForTenant: vi.fn().mockResolvedValue([]),
      secretsForTenant: vi.fn().mockResolvedValue([]),
    });
    const runtimeConfigRepo = mockRuntimeConfigRepo({
      allTenantIds: vi.fn().mockResolvedValue(["b", "c"]),
      runtimeConfigForTenant: vi.fn().mockResolvedValue(null),
    });
    const k8s = mockK8s();
    const r = createReconciler({
      repo,
      runtimeConfigRepo,
      k8s,
      transit: mockTransit(),
      managedLabelValue: "test",
    });

    await r.reconcileAll();

    // Each unique tenant id should trigger one ConfigMap upsert.
    expect(k8s.upsertConfigMap).toHaveBeenCalledTimes(3);
    const seenTenants = k8s.upsertConfigMap.mock.calls.map(
      (c: any[]) => (c[0] as { namespace: string }).namespace,
    );
    expect(seenTenants.sort()).toEqual(["a", "b", "c"]);
  });
});
