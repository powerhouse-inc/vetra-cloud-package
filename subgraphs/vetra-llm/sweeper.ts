import { withKeyLock } from "../../shared/key-lock.js";
import { redactSecrets } from "../../shared/redact.js";
import type { SecretsService } from "../vetra-cloud-secrets/services/secrets-service.js";
import type { KeyVault } from "../vetra-licensing/key-vault.js";
import type { StudioLlmBudget } from "../vetra-licensing/studio-access.js";
import {
  KEY_NAME_PREFIX,
  OPENROUTER_KEY_SECRET,
  llmLockKey,
  sameUsd,
} from "./broker.js";
import type { OpenRouterApi } from "./openrouter.js";
import type { LlmKeyStore } from "./store.js";

/** Like the Apps watcher. */
export const SWEEP_INTERVAL_MS = 15 * 60_000;
/**
 * A studio: key younger than this is never an orphan: provisionVetraKey mints
 * the key before it records the row, and a claim may still be in flight.
 */
export const ORPHAN_GRACE_MS = 30 * 60_000;

const RELEASED_STATUSES = new Set(["TERMINATING", "DESTROYED", "ARCHIVED"]);

export interface SweepDeps {
  store: LlmKeyStore;
  openrouter: OpenRouterApi;
  keyVault: KeyVault;
  secrets: Pick<SecretsService, "setSecret" | "deleteSecret">;
  budgetForDid(did: string): Promise<StudioLlmBudget>;
  /** The env's projection row; null when the env document is gone. */
  envOf(
    environmentId: string,
  ): Promise<{ tenantId: string | null; status: string | null } | null>;
  /** OPENROUTER_WORKSPACE_ID; without it the orphan rule never runs. */
  workspaceId: string | null;
  now(): Date;
  logger: Pick<Console, "info" | "warn" | "error">;
}

export interface SweepReport {
  deleted: number;
  disabled: number;
  enabled: number;
  limited: number;
  orphans: number;
  failed: number;
}

async function sweepRow(
  d: SweepDeps,
  environmentId: string,
  report: SweepReport,
): Promise<void> {
  // Re-read under the env lock: a provision may have changed it since listHeld.
  const row = await d.store.get(environmentId);
  if (!row || row.status === "DELETED" || !row.key_hash) return;
  const now = d.now().toISOString();

  const env = await d.envOf(environmentId);
  if (!env || (env.status !== null && RELEASED_STATUSES.has(env.status))) {
    await d.openrouter.deleteKey(row.key_hash);
    await d.store.update(environmentId, {
      status: "DELETED",
      key_ciphertext: null,
      updated_at: now,
    });
    report.deleted += 1;
    return;
  }

  const budget = await d.budgetForDid(row.owner_did);
  if (!budget.allowed || budget.budgetUsd <= 0) {
    if (row.status === "ACTIVE") {
      await d.openrouter.updateKey(row.key_hash, { disabled: true });
      if (env.tenantId)
        await d.secrets.deleteSecret(env.tenantId, OPENROUTER_KEY_SECRET);
      await d.store.update(environmentId, {
        status: "DISABLED",
        updated_at: now,
      });
      report.disabled += 1;
    }
    return;
  }

  if (row.status === "DISABLED") {
    await d.openrouter.updateKey(row.key_hash, {
      disabled: false,
      limitUsd: budget.budgetUsd,
    });
    if (env.tenantId && row.key_ciphertext) {
      await d.secrets.setSecret(
        env.tenantId,
        OPENROUTER_KEY_SECRET,
        await d.keyVault.decrypt(row.key_ciphertext),
      );
    }
    await d.store.update(environmentId, {
      status: "ACTIVE",
      limit_usd: budget.budgetUsd,
      updated_at: now,
    });
    report.enabled += 1;
    return;
  }

  if (!sameUsd(row.limit_usd, budget.budgetUsd)) {
    await d.openrouter.updateKey(row.key_hash, { limitUsd: budget.budgetUsd });
    await d.store.update(environmentId, {
      limit_usd: budget.budgetUsd,
      updated_at: now,
    });
    report.limited += 1;
  }
}

async function sweepOrphans(
  d: SweepDeps,
  workspaceId: string,
  report: SweepReport,
): Promise<void> {
  const known = new Set((await d.store.listHeld()).map((r) => r.key_hash));
  const cutoff = d.now().getTime() - ORPHAN_GRACE_MS;
  for (const key of await d.openrouter.listKeys({ workspaceId })) {
    if (!key.name.startsWith(KEY_NAME_PREFIX) || known.has(key.hash)) continue;
    const created = Date.parse(key.createdAt);
    if (!Number.isFinite(created) || created > cutoff) continue;
    try {
      await d.openrouter.deleteKey(key.hash);
      report.orphans += 1;
    } catch (err) {
      report.failed += 1;
      d.logger.warn(
        `[vetra-llm] orphan ${key.hash} not deleted: ${redactSecrets(String(err))}`,
      );
    }
  }
}

/**
 * One pass of the lifecycle rules (spec "Lifecycle sweeper"):
 * - a deleted or released Studio → its key is deleted;
 * - a licence no longer usable → the key is disabled and the secret removed;
 * - a renewed licence → the key is re-enabled, its limit updated and the secret written back;
 * - a changed budget → the limit is PATCHed;
 * - `studio:` keys with no row → deleted, but only within this deployment's
 *   workspace and only once they are older than the grace window.
 *
 * Each row runs under the broker's env lock; one failing row never stops the pass.
 */
export async function runLlmSweepOnce(d: SweepDeps): Promise<SweepReport> {
  const report: SweepReport = {
    deleted: 0,
    disabled: 0,
    enabled: 0,
    limited: 0,
    orphans: 0,
    failed: 0,
  };
  for (const row of await d.store.listHeld()) {
    try {
      await withKeyLock(llmLockKey(row.environment_id), () =>
        sweepRow(d, row.environment_id, report),
      );
    } catch (err) {
      report.failed += 1;
      d.logger.warn(
        `[vetra-llm] sweep of ${row.environment_id} failed: ${redactSecrets(String(err))}`,
      );
    }
  }
  if (d.workspaceId) await sweepOrphans(d, d.workspaceId, report);
  return report;
}
