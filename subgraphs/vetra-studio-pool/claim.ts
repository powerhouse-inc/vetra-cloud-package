import { randomBytes } from "node:crypto";
import type { VetraCloudEnvironmentState } from "../../document-models/vetra-cloud-environment/index.js";
import { STUDIO_KEY_SECRET_NAMES } from "../vetra-licensing/subscriptions-resolvers.js";
import { MODEL_FALLBACKS_VAR, MODEL_VAR, OPENROUTER_KEY_SECRET } from "../vetra-llm/broker.js";
import type { ClaimDb } from "./pool-db.js";

const SECRET_RETRIES = 3;

/** One tenant config entry; `secret` defaults to true (a plain env var sets false). */
export type TenantEntry = { key: string; value: string; secret?: boolean };

export interface ClaimDeps {
  claimDb: ClaimDb;
  /** The licence gate: a caller without a usable studio licence consumes no env. */
  hasStudioAccess: (did: string) => Promise<boolean>;
  /**
   * The env's Vetra OpenRouter key (vetra-llm broker ensureVetraKey), created
   * or reused, capped at the licence's monthly budget. Null when the licence
   * has no budget or the broker is not configured: the Studio then serves in
   * connect-a-model mode.
   */
  grantLlmKey: (
    environmentId: string,
    did: string,
  ) => Promise<{ key: string; model: string; fallbackModels: string[] } | null>;
  /** Delete the env's Vetra key after a failed claim (the env is deleted too). */
  releaseLlmKey: (environmentId: string) => Promise<void>;
  /**
   * Transition only (removed in phase 3): the Anthropic key on the caller's
   * licence, still written for agents built before OpenRouter; null when none
   * or when STUDIO_POOL_LEGACY_ANTHROPIC_KEY=false.
   */
  legacyAnthropicKey: (did: string) => Promise<string | null>;
  /** System action: SET_OWNER on the (owner-null) claimed document. */
  setOwner: (documentId: string, address: string) => Promise<void>;
  /**
   * The claimed document's current ownership and state (null when it cannot
   * be read). The read-model row says AVAILABLE; the document is the truth.
   */
  readEnv: (documentId: string) => Promise<{
    owner: string | null;
    ownerOrgId: string | null;
    state: VetraCloudEnvironmentState;
  } | null>;
  /**
   * Replace the tenant's env vars and secrets with what the document declares
   * plus `entries`, atomically — one write, one notify, one pod bounce.
   * Anything written before the claim (and not declared by the document) is
   * gone. `entries` carry the model key and model, the legacy key names,
   * `ADMINS` (so the claimant is the embedded switchboard's admin without a
   * gitops re-render) and the session-export secret; the model entries
   * include VETRA_MODEL_FALLBACKS.
   */
  replaceTenantConfig: (
    tenantId: string,
    state: VetraCloudEnvironmentState,
    entries: TenantEntry[],
  ) => Promise<void>;
  /**
   * Move the document's reactor-api protection to the new owner and revoke
   * every other grant (env-protection.ts protectForOwner).
   */
  handOver: (documentId: string, address: string) => Promise<void>;
  /** Fully delete an env (deleteDocument) — used to clean up a half-claimed env
   *  on failure so it doesn't leak a pod/namespace/cert as a TERMINATING husk. */
  deleteEnv: (documentId: string) => Promise<void>;
  cfg: { version: string };
  nowIso: () => string;
  /** Optional async sleep (injectable for tests); defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  logger: { info(m: string): void; warn(m: string): void; error(m: string): void };
}

export interface ClaimResult {
  documentId: string;
  subdomain: string;
  tenantId: string;
}

/** The legacy Anthropic key for a claim: the licence's key when the flag is on, else null. */
export function legacyKeyFor(
  enabled: boolean,
  lookup: (did: string) => Promise<string | null>,
  did: string,
): Promise<string | null> {
  return enabled ? lookup(did) : Promise.resolve(null);
}

async function withRetry(
  fn: () => Promise<void>,
  retries: number,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      await fn();
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < retries - 1) await sleep(2 ** attempt * 100);
    }
  }
  throw lastErr;
}

/**
 * Atomically claim one warm env for the caller `did` (a `did:pkh:...`), give it
 * its model key, and transfer ownership (system SET_OWNER on the owner-null
 * env). The gate is the studio licence, not a key: a licence without an LLM
 * budget still gets a Studio, which serves in connect-a-model mode. Returns
 * null when the caller has no usable licence or the pool is empty (frontend
 * then cold-falls-back).
 *
 * Self-healing: transient secret writes are retried; on ANY post-assign failure
 * the minted key is released and the half-claimed env deleted, so a failed
 * claim leaks nothing (the keeper refills, the sweeper backstops the key).
 */
export async function claimWarmEnvironment(
  d: ClaimDeps,
  did: string,
): Promise<ClaimResult | null> {
  const addr = (did.split(":").pop() ?? did).toLowerCase();
  const sleep = d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  // 1. No usable studio licence → don't consume an env.
  if (!(await d.hasStudioAccess(did))) {
    d.logger.info(`[studio-pool] claim: no usable studio licence for ${addr}`);
    return null;
  }

  // 2. Atomic assign (only a READY, AVAILABLE, current-version env).
  const env = await d.claimDb.claimOneAvailable(addr, d.cfg.version, d.nowIso());
  if (!env || !env.tenantId) {
    d.logger.info(`[studio-pool] claim: pool empty for ${addr}`);
    return null;
  }

  let granted = false;
  try {
    // 2b. The document is the truth: a warm env is owner-null and personal.
    //     One that someone owns already (signed on it before the claim) is
    //     compromised: delete it, never hand it out (caller falls back cold).
    const doc = await d.readEnv(env.id);
    if (!doc || doc.owner || doc.ownerOrgId) {
      d.logger.warn(
        `[studio-pool] claim: ${env.id} is not an unowned warm env (owner=${doc?.owner ?? "?"}, org=${doc?.ownerOrgId ?? "-"}); deleting`,
      );
      await d.deleteEnv(env.id).catch((e) =>
        d.logger.warn(`[studio-pool] cleanup delete failed for ${env.id}: ${String(e)}`),
      );
      return null;
    }
    // 3. The model key for this env, from the licence's budget.
    const llm = await d.grantLlmKey(env.id, did);
    granted = llm !== null;
    const anthropic = await d.legacyAnthropicKey(did);
    // 4. Everything in ONE batched write — a single pg_notify → one
    //    secrets-controller reconcile → ONE Reloader bounce of the agent pod.
    //    Retried as a whole for transient failures.
    const entries: TenantEntry[] = [
      ...(llm
        ? [
            { key: OPENROUTER_KEY_SECRET, value: llm.key },
            { key: MODEL_VAR, value: llm.model, secret: false },
            // Always present (blank = the agent's default chain, `none` = no
            // fallbacks): the replace drops anything absent.
            { key: MODEL_FALLBACKS_VAR, value: llm.fallbackModels.join(","), secret: false },
          ]
        : []),
      ...(anthropic ? STUDIO_KEY_SECRET_NAMES.map((key) => ({ key, value: anthropic })) : []),
      { key: "ADMINS", value: addr },
      // Per-env random secret gating vetra-cli's session-export endpoints
      // (admin-side debugging). Rides this same batched write — no extra bounce.
      { key: "VETRA_SESSION_EXPORT_SECRET", value: randomBytes(32).toString("hex") },
    ];
    // Everything not declared by the document is dropped in the same write,
    // so nothing planted before the claim survives into the user's studio.
    await withRetry(
      () => d.replaceTenantConfig(env.tenantId!, doc.state, entries),
      SECRET_RETRIES,
      sleep,
    );
    // 5. Transfer ownership LAST (system action — env was created owner-null).
    await d.setOwner(env.id, addr);
    // 6. Protection follows the owner; every other grant goes. The env
    //    protector does the same on the change event, so a failure here only
    //    delays it.
    try {
      await d.handOver(env.id, addr);
    } catch (err) {
      d.logger.warn(`[studio-pool] claim: protection hand-over for ${env.id} failed: ${String(err)}`);
    }
    d.logger.info(
      `[studio-pool] claimed ${env.id} (${env.tenantId}) for ${addr}${granted ? "" : " (no model key: connect-a-model mode)"}`,
    );
    return {
      documentId: env.id,
      subdomain: env.subdomain ?? "",
      tenantId: env.tenantId,
    };
  } catch (err) {
    // Half-claimed → release the key and delete the env so nothing leaks; the
    // keeper refills. Caller gets null → cold-falls-back.
    d.logger.warn(
      `[studio-pool] claim post-assign failed for ${env.id}; deleting: ${err instanceof Error ? err.name : "error"}`,
    );
    // Unconditional: grantLlmKey may have minted and then thrown (a secret or
    // store write failed). The broker's release is a no-op when no row exists.
    await d.releaseLlmKey(env.id).catch((e) =>
      d.logger.warn(
        `[studio-pool] key release failed for ${env.id}; the vetra-llm sweeper deletes it: ${e instanceof Error ? e.name : "error"}`,
      ),
    );
    await d.deleteEnv(env.id).catch((e) =>
      d.logger.warn(`[studio-pool] cleanup delete failed for ${env.id}: ${String(e)}`),
    );
    return null;
  }
}
