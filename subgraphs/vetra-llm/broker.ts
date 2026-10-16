import { withKeyLock } from "../../shared/key-lock.js";
import { redactSecrets } from "../../shared/redact.js";
import type { SecretsService } from "../vetra-cloud-secrets/services/secrets-service.js";
import type { KeyVault } from "../vetra-licensing/key-vault.js";
import type { StudioLlmBudget } from "../vetra-licensing/studio-access.js";
import type { LlmConfig } from "./config.js";
import type { StudioLlmKeys } from "./db/schema.js";
import { notConfigured } from "./errors.js";
import { OpenRouterError, type OpenRouterApi } from "./openrouter.js";
import type { LlmKeyStore } from "./store.js";

/** The tenant secret the agent reads (vetra-cli llm.ts resolveOpenRouterKey). */
export const OPENROUTER_KEY_SECRET = "OPENROUTER_API_KEY";
/** The tenant env var the agent reads as its main model (ph-clint: VETRA_ + model). */
export const MODEL_VAR = "VETRA_MODEL";
export const KEY_NAME_PREFIX = "studio:";
/** Verified enum (daily | weekly | monthly | null) in https://openrouter.ai/openapi.yaml. */
export const LIMIT_RESET = "monthly" as const;
export const USAGE_CACHE_MS = 60_000;

export const keyName = (environmentId: string): string =>
  `${KEY_NAME_PREFIX}${environmentId}`;
/** The per-env lock every key mutation (broker and sweeper) takes. */
export const llmLockKey = (environmentId: string): string =>
  `llm:${environmentId}`;

/** Budgets are cents; doubles compare within half a cent. */
export const sameUsd = (a: number | null, b: number): boolean =>
  a !== null && Math.abs(a - b) < 0.005;

/** OpenRouter resets monthly limits at midnight UTC on the 1st. */
export function nextMonthlyReset(now: Date): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
  ).toISOString();
}

export interface VetraKeyGrant {
  key: string;
  model: string;
  limitUsd: number;
  /** True when this call minted the key (an undo deletes it). */
  created: boolean;
}

export interface ProvisionResult {
  connected: boolean;
  llmBudgetUsd: number;
}

export interface StudioLlmUsage {
  source: "VETRA" | "BYO";
  model: string;
  usageUsd: number;
  limitUsd: number | null;
  resetsAt: string | null;
}

export interface BrokerDeps {
  store: LlmKeyStore;
  /** Null without OPENROUTER_MANAGEMENT_KEY. */
  openrouter: OpenRouterApi | null;
  /** Null without OPENBAO_ADDR. */
  keyVault: KeyVault | null;
  secrets: Pick<
    SecretsService,
    "setSecret" | "setEnvVar" | "deleteSecret"
  > | null;
  /** The holder's licence gate and effective monthly budget (studioLlmBudgetForDid). */
  budgetForDid(did: string): Promise<StudioLlmBudget>;
  cfg: Pick<LlmConfig, "defaultModel" | "workspaceId">;
  now(): Date;
  logger: Pick<Console, "info" | "warn" | "error">;
}

export interface LlmBroker {
  /**
   * The env's Vetra key, created or reused, limited to the holder's budget.
   * Null (and an existing key disabled) when the licence is not usable or its
   * budget is 0. Writes no tenant secret: the pool claim batches it.
   */
  ensureVetraKey(input: {
    environmentId: string;
    ownerDid: string;
  }): Promise<VetraKeyGrant | null>;
  /**
   * ensureVetraKey + OPENROUTER_API_KEY / VETRA_MODEL into the tenant; a key
   * minted here is deleted when the write fails. When there is no grant
   * (licence ended, budget 0), OPENROUTER_API_KEY is removed so the agent
   * falls back to no-model mode instead of 401ing with a disabled key.
   */
  provisionVetraKey(input: {
    environmentId: string;
    tenantId: string;
    ownerDid: string;
  }): Promise<ProvisionResult>;
  /** Delete the env's key on OpenRouter and mark its row DELETED. Idempotent. */
  releaseVetraKey(environmentId: string): Promise<void>;
  /** This month's spend against the limit; null without a key. Cached 60 s. */
  studioLlmUsage(environmentId: string): Promise<StudioLlmUsage | null>;
}

/** A row whose key still exists on OpenRouter and can be decrypted. */
type HeldRow = StudioLlmKeys & { key_hash: string; key_ciphertext: string };

const heldRow = (row: StudioLlmKeys | null): HeldRow | null =>
  row && row.status !== "DELETED" && row.key_hash && row.key_ciphertext
    ? (row as HeldRow)
    : null;

/** A grant plus the key hash, for the undo; never handed out. */
type Grant = VetraKeyGrant & { hash: string };

const is404 = (err: unknown) =>
  err instanceof OpenRouterError && err.status === 404;

/** Any error as one log-safe line: keys and ciphertexts redacted. */
const safe = (err: unknown): string =>
  redactSecrets(
    err instanceof Error ? `${err.name}: ${err.message}` : String(err),
  );

/**
 * Assumes ONE switchboard replica: every key mutation is serialised per env by
 * the process-local withKeyLock (llmLockKey), as the rest of this codebase's
 * locks are. With two replicas, two concurrent provisions of one env could
 * each POST /keys; the last upsert wins the row, the other key is unrecorded,
 * and the tenant secret may hold either one. The orphan sweep would then
 * delete the unrecorded key, which may be the very key the Studio holds,
 * leaving it with a dead key until the next provision. Scaling out needs a
 * cross-process guard first (e.g. a conditional insert on environment_id).
 */
export function createLlmBroker(d: BrokerDeps): LlmBroker {
  const usageCache = new Map<
    string,
    { at: number; value: StudioLlmUsage | null }
  >();

  const configured = () => {
    if (!d.openrouter)
      throw notConfigured("OpenRouter (OPENROUTER_MANAGEMENT_KEY)");
    if (!d.keyVault) throw notConfigured("key storage (OPENBAO_ADDR)");
    return { openrouter: d.openrouter, keyVault: d.keyVault };
  };

  /**
   * Undo a key this process minted. A failed delete leaves the key on
   * OpenRouter unrecorded; its hash is logged and the orphan sweep (after
   * its grace window) deletes it.
   */
  async function undoMint(
    openrouter: OpenRouterApi,
    environmentId: string,
    hash: string,
  ): Promise<void> {
    try {
      await openrouter.deleteKey(hash);
      d.logger.warn(
        `[vetra-llm] undo: deleted key ${hash} of ${environmentId}`,
      );
    } catch (err) {
      d.logger.error(
        `[vetra-llm] undo: could not delete key ${hash} of ${environmentId}; left to the orphan sweep: ${safe(err)}`,
      );
    }
  }

  async function ensureLocked(input: {
    environmentId: string;
    ownerDid: string;
  }): Promise<Grant | null> {
    const { openrouter, keyVault } = configured();
    const env = input.environmentId;
    usageCache.delete(env);
    const budget = await d.budgetForDid(input.ownerDid);
    const row = await d.store.get(env);
    const now = d.now().toISOString();
    const held = heldRow(row);

    if (!budget.allowed || budget.budgetUsd <= 0) {
      if (held && held.status === "ACTIVE") {
        try {
          await openrouter.updateKey(held.key_hash, { disabled: true });
          await d.store.update(env, { status: "DISABLED", updated_at: now });
          d.logger.info(`[vetra-llm] disabled key ${held.key_hash} of ${env}`);
        } catch (err) {
          if (!is404(err)) throw err;
          await d.store.update(env, {
            status: "DELETED",
            key_ciphertext: null,
            updated_at: now,
          });
        }
      }
      return null;
    }

    if (held) {
      try {
        if (
          held.status !== "ACTIVE" ||
          !sameUsd(held.limit_usd, budget.budgetUsd)
        ) {
          await openrouter.updateKey(held.key_hash, {
            limitUsd: budget.budgetUsd,
            disabled: false,
          });
        } else {
          // Nothing to update, so confirm the key still exists and is enabled
          // (a disable may have landed on OpenRouter while our row update failed).
          const live = await openrouter.getKey(held.key_hash);
          if (!live) throw new OpenRouterError(404, "key not found");
          if (live.disabled)
            await openrouter.updateKey(held.key_hash, { disabled: false });
        }
        await d.store.update(env, {
          status: "ACTIVE",
          limit_usd: budget.budgetUsd,
          owner_did: input.ownerDid,
          updated_at: now,
        });
        return {
          key: await keyVault.decrypt(held.key_ciphertext),
          model: held.model,
          limitUsd: budget.budgetUsd,
          created: false,
          hash: held.key_hash,
        };
      } catch (err) {
        // Deleted on OpenRouter behind our back: mint a fresh one below.
        if (!is404(err)) throw err;
        d.logger.warn(
          `[vetra-llm] key ${held.key_hash} of ${env} is gone on OpenRouter; creating a new one`,
        );
      }
    }

    const created = await openrouter.createKey({
      name: keyName(env),
      limitUsd: budget.budgetUsd,
      limitReset: LIMIT_RESET,
      workspaceId: d.cfg.workspaceId,
    });
    const hash = created.data.hash;
    const model = row?.model ?? d.cfg.defaultModel;
    try {
      await d.store.upsert({
        environment_id: env,
        source: "VETRA",
        key_hash: hash,
        key_ciphertext: await keyVault.encrypt(created.key),
        limit_usd: budget.budgetUsd,
        limit_reset: LIMIT_RESET,
        model,
        owner_did: input.ownerDid,
        status: "ACTIVE",
        created_at: row?.created_at ?? now,
        updated_at: now,
      });
    } catch (err) {
      d.logger.error(
        `[vetra-llm] recording key ${hash} of ${env} failed: ${safe(err)}`,
      );
      await undoMint(openrouter, env, hash);
      throw err;
    }
    d.logger.info(
      `[vetra-llm] created key ${hash} for ${env} (limit $${budget.budgetUsd}/month)`,
    );
    return {
      key: created.key,
      model,
      limitUsd: budget.budgetUsd,
      created: true,
      hash,
    };
  }

  async function releaseLocked(environmentId: string): Promise<void> {
    usageCache.delete(environmentId);
    const row = await d.store.get(environmentId);
    if (!row || row.status === "DELETED") return;
    if (row.key_hash) await configured().openrouter.deleteKey(row.key_hash);
    await d.store.update(environmentId, {
      status: "DELETED",
      key_ciphertext: null,
      updated_at: d.now().toISOString(),
    });
  }

  return {
    ensureVetraKey: (input) =>
      withKeyLock(llmLockKey(input.environmentId), async () => {
        const g = await ensureLocked(input);
        return g
          ? {
              key: g.key,
              model: g.model,
              limitUsd: g.limitUsd,
              created: g.created,
            }
          : null;
      }),

    provisionVetraKey: (input) =>
      withKeyLock(llmLockKey(input.environmentId), async () => {
        if (!d.secrets) throw notConfigured("tenant secrets (OPENBAO_ADDR)");
        const env = input.environmentId;
        const grant = await ensureLocked(input);
        if (!grant) {
          // The agent must fall back to no-model mode, not 401 with a disabled
          // key. Only a Studio that held a Vetra key loses the secret; one with
          // no row may carry the user's own key. A failed delete throws: the
          // row is already DISABLED, so the sweeper won't retry it, the caller does.
          if ((await d.store.get(env))?.key_hash)
            await d.secrets.deleteSecret(input.tenantId, OPENROUTER_KEY_SECRET);
          return { connected: false, llmBudgetUsd: 0 };
        }
        try {
          // The key goes last: when any write fails, the tenant never holds
          // a key the undo below is about to delete.
          await d.secrets.setEnvVar(input.tenantId, MODEL_VAR, grant.model);
          await d.secrets.setSecret(
            input.tenantId,
            OPENROUTER_KEY_SECRET,
            grant.key,
          );
        } catch (err) {
          d.logger.error(
            `[vetra-llm] writing the key of ${env} to tenant ${input.tenantId} failed: ${safe(err)}`,
          );
          if (grant.created) {
            // Undo the mint: release the row first, delete the key only once
            // it is released, so an ACTIVE row never points at a deleted key.
            // A failed delete leaves the key unrecorded for the orphan sweep.
            let released = false;
            try {
              await d.store.update(env, {
                status: "DELETED",
                key_ciphertext: null,
                updated_at: d.now().toISOString(),
              });
              released = true;
            } catch (e) {
              d.logger.error(
                `[vetra-llm] undo: could not release the row of ${env}; keeping key ${grant.hash}: ${safe(e)}`,
              );
            }
            if (released)
              await undoMint(configured().openrouter, env, grant.hash);
          }
          throw err;
        }
        return { connected: true, llmBudgetUsd: grant.limitUsd };
      }),

    releaseVetraKey: (environmentId) =>
      withKeyLock(llmLockKey(environmentId), () =>
        releaseLocked(environmentId),
      ),

    async studioLlmUsage(environmentId) {
      const nowMs = d.now().getTime();
      const hit = usageCache.get(environmentId);
      if (hit && nowMs - hit.at < USAGE_CACHE_MS) return hit.value;
      const row = await d.store.get(environmentId);
      let value: StudioLlmUsage | null = null;
      if (row && row.status !== "DELETED" && row.key_hash) {
        const key = await configured().openrouter.getKey(row.key_hash);
        value = {
          source: row.source,
          model: row.model,
          usageUsd: key?.usageMonthly ?? 0,
          limitUsd: key?.limit ?? row.limit_usd,
          resetsAt:
            row.limit_reset === LIMIT_RESET ? nextMonthlyReset(d.now()) : null,
        };
      }
      usageCache.set(environmentId, { at: nowMs, value });
      return value;
    },
  };
}
