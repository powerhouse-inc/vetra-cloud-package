import type { SecretsRepository } from "./db.js";
import type { K8sClient } from "./k8s-client.js";
import type { OpenBaoTransitClient } from "../subgraphs/vetra-cloud-secrets/openbao-transit.js";

export interface ReconcilerDeps {
  repo: SecretsRepository;
  k8s: K8sClient;
  transit: OpenBaoTransitClient;
  managedLabelValue: string;
}

export interface Reconciler {
  reconcileTenant(tenantId: string): Promise<void>;
  reconcileAll(): Promise<void>;
}

export function createReconciler(deps: ReconcilerDeps): Reconciler {
  const { repo, k8s, transit, managedLabelValue } = deps;

  async function decryptSecrets(
    rows: Array<{ key: string; ciphertext: string | null }>,
  ): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    // Decrypt in parallel; isolate per-key failures so one bad ciphertext
    // doesn't break the whole secret.
    const results = await Promise.all(
      rows.map(async (r) => {
        if (r.ciphertext == null) {
          // Legacy row, no ciphertext yet — skip (will be repopulated on next setSecret).
          return { key: r.key, value: null as string | null, error: null };
        }
        try {
          const value = await transit.decrypt(r.ciphertext);
          return { key: r.key, value, error: null };
        } catch (err) {
          return {
            key: r.key,
            value: null,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );
    for (const r of results) {
      if (r.error) {
        console.error(
          `[reconciler] decrypt failed for key '${r.key}': ${r.error} — omitting from Secret`,
        );
        continue;
      }
      if (r.value != null) out[r.key] = r.value;
    }
    return out;
  }

  async function reconcileTenant(tenantId: string): Promise<void> {
    const [envRows, secretRows] = await Promise.all([
      repo.envVarsForTenant(tenantId),
      repo.secretsForTenant(tenantId),
    ]);

    const envData: Record<string, string> = {};
    for (const row of envRows) envData[row.key] = row.value;

    const secretData = await decryptSecrets(secretRows);

    const cmResult = await k8s.upsertConfigMap(
      {
        namespace: tenantId,
        name: `${tenantId}-env`,
        managedLabel: managedLabelValue,
      },
      envData,
    );
    const secretResult = await k8s.upsertSecret(
      {
        namespace: tenantId,
        name: `${tenantId}-secrets`,
        managedLabel: managedLabelValue,
      },
      secretData,
    );

    console.info(
      `[reconciler] tenant=${tenantId} env=${Object.keys(envData).length}:${cmResult} secrets=${Object.keys(secretData).length}:${secretResult}`,
    );
  }

  async function reconcileAll(): Promise<void> {
    const tenantIds = await repo.allTenantIds();
    console.info(`[reconciler] full reconcile: ${tenantIds.length} tenant(s)`);
    const errors: Array<{ tenantId: string; error: string }> = [];
    for (const tenantId of tenantIds) {
      try {
        await reconcileTenant(tenantId);
      } catch (err) {
        errors.push({
          tenantId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (errors.length > 0) {
      console.error(
        `[reconciler] full reconcile finished with ${errors.length} error(s): ${JSON.stringify(errors)}`,
      );
    }
  }

  return { reconcileTenant, reconcileAll };
}
