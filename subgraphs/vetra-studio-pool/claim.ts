import type { ClaimDb } from "./pool-db.js";

const SECRET_NAMES = [
  "ANTHROPIC_API_KEY",
  "VETRA_ANTHROPIC_API_KEY",
  "VETRA_CLI_ANTHROPIC_API_KEY",
] as const;

export interface ClaimDeps {
  claimDb: ClaimDb;
  /** Resolve + decrypt the Anthropic key attached to the caller's redeemed invite code; null if none. */
  getKeyForDid: (addr: string) => Promise<string | null>;
  /** System action: SET_OWNER on the (owner-null) claimed document. */
  setOwner: (documentId: string, address: string) => Promise<void>;
  /** Inject one secret into the tenant secret store. */
  setSecret: (tenantId: string, key: string, value: string) => Promise<void>;
  cfg: { version: string };
  nowIso: () => string;
  logger: { info(m: string): void; warn(m: string): void; error(m: string): void };
}

export interface ClaimResult {
  documentId: string;
  subdomain: string;
  tenantId: string;
}

/**
 * Atomically claim one warm env for `addrRaw`, transfer ownership (system
 * SET_OWNER on the owner-null env), and inject the caller's attached key.
 * Returns null when the caller has no key or the pool is empty (frontend then
 * cold-falls-back). On post-assign failure the env is marked FAILED (never
 * returned to AVAILABLE — it may be partially mutated).
 */
export async function claimWarmEnvironment(
  d: ClaimDeps,
  addrRaw: string,
): Promise<ClaimResult | null> {
  const addr = addrRaw.toLowerCase();

  // 1. No key → don't consume an env.
  const apiKey = await d.getKeyForDid(addr);
  if (!apiKey) {
    d.logger.info(`[studio-pool] claim: no attached key for ${addr}`);
    return null;
  }

  // 2. Atomic assign.
  const env = await d.claimDb.claimOneAvailable(addr, d.cfg.version, d.nowIso());
  if (!env || !env.tenantId) {
    d.logger.info(`[studio-pool] claim: pool empty for ${addr}`);
    return null;
  }

  try {
    // 3. Transfer ownership (system action — env was created owner-null).
    await d.setOwner(env.id, addr);
    // 4. Inject the key under all required names → secrets-controller → Reloader bounce.
    for (const name of SECRET_NAMES) {
      await d.setSecret(env.tenantId, name, apiKey);
    }
    d.logger.info(`[studio-pool] claimed ${env.id} (${env.tenantId}) for ${addr}`);
    return {
      documentId: env.id,
      subdomain: env.subdomain ?? "",
      tenantId: env.tenantId,
    };
  } catch (err) {
    d.logger.warn(
      `[studio-pool] claim post-assign failed for ${env.id}: ${String(err)}`,
    );
    await d.claimDb.markFailed(env.id).catch(() => {});
    return null;
  }
}
