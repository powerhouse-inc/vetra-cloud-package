import { vi } from "vitest";
import { createReconciler } from "../reconciler.js";
import type { SecretsRepository } from "../db.js";
import type { K8sClient } from "../k8s-client.js";
import type { OpenBaoTransitClient } from "../../subgraphs/vetra-cloud-secrets/openbao-transit.js";

function mockRepo(
  overrides: Partial<SecretsRepository> = {},
): SecretsRepository {
  return {
    envVarsForTenant: vi.fn().mockResolvedValue([]),
    secretsForTenant: vi.fn().mockResolvedValue([]),
    allTenantIds: vi.fn().mockResolvedValue([]),
    close: vi.fn().mockResolvedValue(undefined),
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

describe("reconcileTenant", () => {
  it("writes env ConfigMap and decrypted Secret for a tenant", async () => {
    const repo = mockRepo({
      envVarsForTenant: vi.fn().mockResolvedValue([
        { key: "FLAG_A", value: "on" },
        { key: "URL", value: "https://x.example" },
      ]),
      secretsForTenant: vi.fn().mockResolvedValue([
        { key: "API_KEY", ciphertext: "vault:v1:sk-123" },
        { key: "DB_PASS", ciphertext: "vault:v1:p@ss" },
      ]),
    });
    const k8s = mockK8s();
    const transit = mockTransit();
    const r = createReconciler({
      repo,
      k8s,
      transit,
      managedLabelValue: "test",
    });

    await r.reconcileTenant("dev");

    expect(k8s.upsertConfigMap).toHaveBeenCalledWith(
      { namespace: "dev", name: "dev-env", managedLabel: "test" },
      { FLAG_A: "on", URL: "https://x.example" },
    );
    expect(k8s.upsertSecret).toHaveBeenCalledWith(
      { namespace: "dev", name: "dev-secrets", managedLabel: "test" },
      { API_KEY: "sk-123", DB_PASS: "p@ss" },
    );
  });

  it("omits a secret key when its ciphertext fails to decrypt, keeps others", async () => {
    const repo = mockRepo({
      secretsForTenant: vi.fn().mockResolvedValue([
        { key: "GOOD", ciphertext: "vault:v1:good-val" },
        { key: "BAD", ciphertext: "vault:v1:broken" },
      ]),
    });
    const k8s = mockK8s();
    const transit = mockTransit({
      decrypt: vi
        .fn()
        .mockImplementation(async (_tenantId: string, ct: string) => {
          if (ct === "vault:v1:broken") throw new Error("decrypt error");
          return ct.replace(/^vault:v\d+:/, "");
        }),
    });
    const r = createReconciler({
      repo,
      k8s,
      transit,
      managedLabelValue: "test",
    });

    await r.reconcileTenant("dev");

    expect(k8s.upsertSecret).toHaveBeenCalledWith(expect.anything(), {
      GOOD: "good-val",
    });
  });

  it("skips legacy rows with null ciphertext (they have no value)", async () => {
    const repo = mockRepo({
      secretsForTenant: vi.fn().mockResolvedValue([
        { key: "LEGACY", ciphertext: null },
        { key: "NEW", ciphertext: "vault:v1:fresh" },
      ]),
    });
    const k8s = mockK8s();
    const transit = mockTransit();
    const r = createReconciler({
      repo,
      k8s,
      transit,
      managedLabelValue: "test",
    });

    await r.reconcileTenant("dev");

    expect(k8s.upsertSecret).toHaveBeenCalledWith(expect.anything(), {
      NEW: "fresh",
    });
  });

  it("passes empty maps when a tenant has no entries", async () => {
    const repo = mockRepo();
    const k8s = mockK8s();
    const r = createReconciler({
      repo,
      k8s,
      transit: mockTransit(),
      managedLabelValue: "test",
    });

    await r.reconcileTenant("empty");

    expect(k8s.upsertConfigMap).toHaveBeenCalledWith(expect.anything(), {});
    expect(k8s.upsertSecret).toHaveBeenCalledWith(expect.anything(), {});
  });
});

describe("reconcileAll", () => {
  it("reconciles every tenant even if one fails", async () => {
    const repo = mockRepo({
      allTenantIds: vi.fn().mockResolvedValue(["a", "b", "c"]),
      envVarsForTenant: vi.fn().mockImplementation(async (id: string) => {
        if (id === "b") throw new Error("db blew up");
        return [];
      }),
    });
    const k8s = mockK8s();
    const r = createReconciler({
      repo,
      k8s,
      transit: mockTransit(),
      managedLabelValue: "test",
    });

    await r.reconcileAll();

    // a and c succeeded → upserts for both, none for b
    expect(k8s.upsertConfigMap).toHaveBeenCalledTimes(2);
    expect(k8s.upsertConfigMap).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "a" }),
      {},
    );
    expect(k8s.upsertConfigMap).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "c" }),
      {},
    );
  });
});
