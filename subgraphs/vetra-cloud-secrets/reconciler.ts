import type { SecretsRepository } from "./repository.js";
import type { K8sClient } from "./k8s-client.js";
import type { OpenBaoTransitClient } from "./openbao-transit.js";
import type { RuntimeConfigRepository } from "../runtime-config/repository.js";
import { RUNTIME_CONFIG_ENV_KEY } from "../runtime-config/types.js";

export interface ReconcilerDeps {
  repo: SecretsRepository;
  k8s: K8sClient;
  transit: OpenBaoTransitClient;
  managedLabelValue: string;
  /**
   * Optional second data source. When provided, reconcileTenant also reads
   * the tenant's runtime-config row and projects it as a single
   * `PH_CONNECT_CONFIG_JSON` entry in the `<tenantId>-env` ConfigMap
   * (wrapped as `{ "connect": <stored-subtree> }` to match the full
   * powerhouse.config.json envelope shape that Connect's entrypoint
   * deep-merges). reconcileAll walks the union of secrets + runtime-config
   * tenant ids.
   *
   * When undefined, the reconciler behaves exactly as before (secrets only).
   */
  runtimeConfigRepo?: RuntimeConfigRepository;
}

export interface Reconciler {
  reconcileTenant(tenantId: string): Promise<void>;
  reconcileAll(): Promise<void>;
}

export function createReconciler(deps: ReconcilerDeps): Reconciler {
  const { repo, k8s, transit, managedLabelValue, runtimeConfigRepo } = deps;

  async function decryptSecrets(
    tenantId: string,
    rows: Array<{ key: string; ciphertext: string | null }>,
  ): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    // Decrypt in parallel with the tenant's own transit key; isolate per-key
    // failures so one bad ciphertext doesn't break the whole Secret.
    const results = await Promise.all(
      rows.map(async (r) => {
        if (r.ciphertext == null) {
          return { key: r.key, value: null as string | null, error: null };
        }
        try {
          const value = await transit.decrypt(tenantId, r.ciphertext);
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
    const [envRows, secretRows, runtimeRow] = await Promise.all([
      repo.envVarsForTenant(tenantId),
      repo.secretsForTenant(tenantId),
      runtimeConfigRepo
        ? runtimeConfigRepo.runtimeConfigForTenant(tenantId)
        : Promise.resolve(null),
    ]);

    const envData: Record<string, string> = {};
    for (const row of envRows) envData[row.key] = row.value;

    // Fan-in runtime-config: wrap the stored connect.* subtree back into the
    // full envelope shape Connect's entrypoint expects to deep-merge into
    // /dist/powerhouse.config.json. Skip when the stored value is corrupt —
    // a single broken row should not poison the rest of the tenant's env.
    if (runtimeRow) {
      try {
        const connect: unknown = JSON.parse(runtimeRow.value);
        if (connect && typeof connect === "object" && !Array.isArray(connect)) {
          envData[RUNTIME_CONFIG_ENV_KEY] = JSON.stringify({ connect });
        } else {
          console.warn(
            `[reconciler] runtime-config row for ${tenantId} is not a plain object; skipping`,
          );
        }
      } catch (err) {
        console.error(
          `[reconciler] runtime-config row for ${tenantId} is invalid JSON; skipping (${
            err instanceof Error ? err.message : String(err)
          })`,
        );
      }
    }

    const secretData = await decryptSecrets(tenantId, secretRows);

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
    const [secretsIds, runtimeIds] = await Promise.all([
      repo.allTenantIds(),
      runtimeConfigRepo
        ? runtimeConfigRepo.allTenantIds()
        : Promise.resolve([] as string[]),
    ]);
    const tenantIds = [...new Set([...secretsIds, ...runtimeIds])].sort();
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
