import { randomBytes } from "node:crypto";
import type { VetraCloudEnvironmentState } from "../../document-models/vetra-cloud-environment/index.js";
import { STUDIO_KEY_SECRET_NAMES } from "../vetra-licensing/subscriptions-resolvers.js";
import { MODEL_FALLBACKS_VAR, MODEL_VAR, OPENROUTER_KEY_SECRET } from "../vetra-llm/broker.js";
import {
  hashLaunchSecret,
  newLaunchSecret,
  STUDIO_LAUNCH_SECRET_KEY,
} from "../vetra-apps/studio-binding.js";
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
   * include VETRA_MODEL_FALLBACKS. The Studio's launch secret
   * (VETRA_STUDIO_LAUNCH_SECRET, a managed key) rides the same write.
   */
  replaceTenantConfig: (
    tenantId: string,
    state: VetraCloudEnvironmentState,
    entries: TenantEntry[],
  ) => Promise<void>;
  /**
   * Record the sha256 of the Studio's launch secret (vetra-apps
   * studio_launch_secrets, replacing any earlier row for the env). The
   * secret itself is only in `entries`.
   */
  storeLaunchSecretHash: (environmentId: string, secretHash: string) => Promise<void>;
  /**
   * Move the document's reactor-api protection to the new owner and revoke
   * every other grant (env-protection.ts protectForOwner).
   */
  handOver: (documentId: string, address: string) => Promise<void>;
  /** Fully delete an env (deleteDocument) — used to clean up a half-claimed env
   *  on failure so it doesn't leak a pod/namespace/cert as a TERMINATING husk. */
  deleteEnv: (documentId: string) => Promise<void>;
  cfg: { version: string; renownUrl?: string };
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

/** An env document that is about to be handed to a caller. */
export interface ProvidableEnv {
  id: string;
  tenantId: string;
  subdomain: string | null;
  state: VetraCloudEnvironmentState;
}

/**
 * Everything a claimant's Studio needs, in one batched secret write:
 * the model key + model, the legacy Anthropic key names, `ADMINS`, the
 * Renown URL, the session-export secret, the launch secret and the
 * attachment signing secret. Ownership moves last.
 *
 * Shared by the warm claim and the cold-create path — a Studio created while
 * the pool was empty must be configured exactly like a claimed warm one,
 * otherwise the deploy/claim split leaves it without `ADMINS`, key or launch
 * config (the "model couldn't be connected yet" Studio).
 *
 * Self-healing: transient secret writes are retried; on ANY post-assign failure
 * the minted key is released and the half-claimed env deleted, so a failed
 * claim leaks nothing (the keeper refills, the sweeper backstops the key).
 */
export async function provisionClaimedEnv(
  d: ClaimDeps,
  env: ProvidableEnv,
  addr: string,
  did: string,
): Promise<ClaimResult | null> {
  const sleep = d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let granted = false;
  try {
    // 3. The model key for this env, from the licence's budget.
    const llm = await d.grantLlmKey(env.id, did);
    granted = llm !== null;
    const anthropic = await d.legacyAnthropicKey(did);
    // 3b. The launch secret binding this Studio's agent to its own product
    //     (D20). The hash is stored first: a secret the cloud cannot check
    //     would only make launches fail.
    const launchSecret = newLaunchSecret();
    await withRetry(
      () => d.storeLaunchSecretHash(env.id, hashLaunchSecret(launchSecret)),
      SECRET_RETRIES,
      sleep,
    );
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
      // Non-interactive pnpm: ph init must be able to purge a stale node_modules.
      { key: "CI", value: "true", secret: false },
      // Warm envs created before this was configured lack it in their document,
      // and the replace drops anything undeclared — so re-state it here.
      ...(d.cfg.renownUrl?.trim()
        ? [{ key: "VETRA_CLOUD_RENOWN_URL", value: d.cfg.renownUrl.trim(), secret: false }]
        : []),
      // Per-env random secret gating vetra-cli's session-export endpoints
      // (admin-side debugging). Rides this same batched write — no extra bounce.
      { key: "VETRA_SESSION_EXPORT_SECRET", value: randomBytes(32).toString("hex") },
      { key: STUDIO_LAUNCH_SECRET_KEY, value: launchSecret },
      // Signs attachment download targets: the reactor refuses filesystem
      // attachments without it (uploads show "couldn't be added").
      { key: "PH_ATTACHMENT_URL_SIGNING_SECRET", value: randomBytes(32).toString("hex") },
    ];
    // Everything not declared by the document is dropped in the same write,
    // so nothing planted before the claim survives into the user's studio.
    await withRetry(
      () => d.replaceTenantConfig(env.tenantId, env.state, entries),
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
    // keeper refills.
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

/**
 * Atomically claim one warm env for the caller `did` (a `did:pkh:...`), give it
 * its model key, and transfer ownership (system SET_OWNER on the owner-null
 * env). The gate is the studio licence, not a key: a licence without an LLM
 * budget still gets a Studio, which serves in connect-a-model mode. Returns
 * null when the caller has no usable licence or the pool is empty (the caller
 * then falls back to `claimColdEnvironment`).
 */
export async function claimWarmEnvironment(
  d: ClaimDeps,
  did: string,
): Promise<ClaimResult | null> {
  const addr = (did.split(":").pop() ?? did).toLowerCase();

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

  // 2b. The document is the truth: a warm env is owner-null and personal.
  //     One that someone owns already (signed on it before the claim) is
  //     compromised: delete it, never hand it out.
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

  return provisionClaimedEnv(
    d,
    { id: env.id, tenantId: env.tenantId, subdomain: env.subdomain, state: doc.state },
    addr,
    did,
  );
}

export interface ColdClaimDeps extends ClaimDeps {
  /** Create one ownerless studio env document (the same builder the keeper uses). */
  createEnv: () => Promise<ClaimResult>;
}

/**
 * Pool empty: create a fresh Studio for the caller and provision it exactly
 * like a warm claim (owner, `ADMINS`, model key, launch/session/attachment
 * secrets) in the same request. Without this the deploy path and the claim
 * path are split and a cold Studio comes up unowned and unconfigured.
 *
 * Returns null when the caller has no usable licence, or when the env cannot
 * be read back or provisioned (the half-created env is deleted).
 */
export async function claimColdEnvironment(
  d: ColdClaimDeps,
  did: string,
): Promise<ClaimResult | null> {
  const addr = (did.split(":").pop() ?? did).toLowerCase();
  if (!(await d.hasStudioAccess(did))) {
    d.logger.info(`[studio-pool] cold claim: no usable studio licence for ${addr}`);
    return null;
  }
  const created = await d.createEnv();
  const doc = await d.readEnv(created.documentId);
  if (!doc) {
    d.logger.warn(
      `[studio-pool] cold claim: created ${created.documentId} but could not read it back; deleting`,
    );
    await d.deleteEnv(created.documentId).catch((e) =>
      d.logger.warn(`[studio-pool] cleanup delete failed for ${created.documentId}: ${String(e)}`),
    );
    return null;
  }
  d.logger.info(`[studio-pool] cold claim: created ${created.documentId} for ${addr}`);
  return provisionClaimedEnv(
    d,
    {
      id: created.documentId,
      tenantId: created.tenantId,
      subdomain: created.subdomain,
      state: doc.state,
    },
    addr,
    did,
  );
}
