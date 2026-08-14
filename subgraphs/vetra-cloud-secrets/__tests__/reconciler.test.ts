import { vi } from "vitest";
import { createReconciler } from "../reconciler.js";
import type { SecretsRepository } from "../repository.js";
import type { K8sClient } from "../k8s-client.js";
import type { OpenBaoTransitClient } from "../openbao-transit.js";

function mockRepo(
  overrides: Partial<SecretsRepository> = {},
): SecretsRepository {
  return {
    envVarsForTenant: vi.fn().mockResolvedValue([]),
    secretsForTenant: vi.fn().mockResolvedValue([]),
    allTenantIds: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function mockK8s(): K8sClient & {
  listNamespaceNames: ReturnType<typeof vi.fn>;
  upsertConfigMap: ReturnType<typeof vi.fn>;
  upsertSecret: ReturnType<typeof vi.fn>;
} {
  return {
    // Default: every namespace a test references exists. Tests that exercise
    // the orphan-skip path override this with an explicit set.
    listNamespaceNames: vi.fn().mockResolvedValue(new Set<string>()),
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
    k8s.listNamespaceNames.mockResolvedValue(new Set(["a", "b", "c"]));
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

  it("skips tenants whose namespace does not exist — no DB read, no decrypt, no upsert", async () => {
    const envVarsForTenant = vi.fn().mockResolvedValue([]);
    // Only the orphan "gone" carries a secret — if it were (wrongly)
    // reconciled, transit.decrypt would fire. "live" has none, so a clean run
    // decrypts nothing at all.
    const secretsForTenant = vi.fn().mockImplementation(async (id: string) =>
      id === "gone" ? [{ key: "K", ciphertext: "vault:v1:secret" }] : [],
    );
    const repo = mockRepo({
      allTenantIds: vi.fn().mockResolvedValue(["live", "gone"]),
      envVarsForTenant,
      secretsForTenant,
    });
    const k8s = mockK8s();
    // Only "live" has a namespace; "gone" is a slept/deleted studio.
    k8s.listNamespaceNames.mockResolvedValue(new Set(["live"]));
    const transit = mockTransit();
    const r = createReconciler({
      repo,
      k8s,
      transit,
      managedLabelValue: "test",
    });

    await r.reconcileAll();

    // live reconciled exactly once
    expect(k8s.upsertConfigMap).toHaveBeenCalledTimes(1);
    expect(k8s.upsertConfigMap).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "live" }),
      {},
    );
    // gone is skipped entirely — no create attempt, no DB fetch, no OpenBao
    // decrypt. This is what stops the per-sweep spam + churn for orphans.
    expect(k8s.upsertConfigMap).not.toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "gone" }),
      expect.anything(),
    );
    expect(envVarsForTenant).not.toHaveBeenCalledWith("gone");
    expect(secretsForTenant).not.toHaveBeenCalledWith("gone");
    expect(transit.decrypt).not.toHaveBeenCalled();
  });

  it("falls back to reconciling all tenants when namespace listing is denied (pre-RBAC)", async () => {
    const repo = mockRepo({
      allTenantIds: vi.fn().mockResolvedValue(["a", "b"]),
    });
    const k8s = mockK8s();
    k8s.listNamespaceNames.mockRejectedValue(
      new Error('namespaces is forbidden: cannot list resource "namespaces"'),
    );
    const r = createReconciler({
      repo,
      k8s,
      transit: mockTransit(),
      managedLabelValue: "test",
    });

    await r.reconcileAll();

    // Degraded but functional: without the namespace list we reconcile all,
    // exactly as before this filter existed — no regression on missing RBAC.
    expect(k8s.upsertConfigMap).toHaveBeenCalledTimes(2);
  });
});
