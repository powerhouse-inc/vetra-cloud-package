import type { ClaimDb } from "./pool-db.js";

const SECRET_NAMES = [
  "ANTHROPIC_API_KEY",
  "VETRA_ANTHROPIC_API_KEY",
  "VETRA_CLI_ANTHROPIC_API_KEY",
] as const;

const SECRET_RETRIES = 3;

export interface ClaimDeps {
  claimDb: ClaimDb;
  /** Resolve + decrypt the Anthropic key attached to the caller's redeemed invite code; null if none. */
  getKeyForDid: (did: string) => Promise<string | null>;
  /** System action: SET_OWNER on the (owner-null) claimed document. */
  setOwner: (documentId: string, address: string) => Promise<void>;
  /** Inject one secret into the tenant secret store. */
  setSecret: (tenantId: string, key: string, value: string) => Promise<void>;
  /** Terminate an env (used to clean up a half-claimed env on failure). */
  terminate: (documentId: string) => Promise<void>;
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
 * Atomically claim one warm env for the caller `did` (a `did:pkh:...`), transfer
 * ownership (system SET_OWNER on the owner-null env), and inject the caller's
 * attached key. The key lookup is keyed by the full DID (matching how the
 * redemption was recorded); `claimedBy`/owner use the bare address. Returns null
 * when the caller has no key or the pool is empty (frontend then cold-falls-back).
 *
 * Self-healing: transient secret writes are retried; on ANY post-assign failure
 * the half-claimed env is TERMINATED (not left as an owned, key-less orphan) and
 * the keeper provisions a replacement, so a failed claim leaks nothing.
 */
export async function claimWarmEnvironment(
  d: ClaimDeps,
  did: string,
): Promise<ClaimResult | null> {
  const addr = (did.split(":").pop() ?? did).toLowerCase();
  const sleep = d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  // 1. No key → don't consume an env.
  const apiKey = await d.getKeyForDid(did);
  if (!apiKey) {
    d.logger.info(`[studio-pool] claim: no attached key for ${addr}`);
    return null;
  }

  // 2. Atomic assign (only a READY, AVAILABLE, current-version env).
  const env = await d.claimDb.claimOneAvailable(addr, d.cfg.version, d.nowIso());
  if (!env || !env.tenantId) {
    d.logger.info(`[studio-pool] claim: pool empty for ${addr}`);
    return null;
  }

  try {
    // 3. Transfer ownership (system action — env was created owner-null).
    await d.setOwner(env.id, addr);
    // 4. Inject the key under all required names → secrets-controller → Reloader
    //    bounce. Retried for transient failures.
    for (const name of SECRET_NAMES) {
      await withRetry(() => d.setSecret(env.tenantId!, name, apiKey), SECRET_RETRIES, sleep);
    }
    d.logger.info(`[studio-pool] claimed ${env.id} (${env.tenantId}) for ${addr}`);
    return {
      documentId: env.id,
      subdomain: env.subdomain ?? "",
      tenantId: env.tenantId,
    };
  } catch (err) {
    // Half-claimed (owned, possibly key-less) → terminate so nothing leaks; the
    // keeper refills. Caller gets null → cold-falls-back.
    d.logger.warn(
      `[studio-pool] claim post-assign failed for ${env.id}; terminating: ${String(err)}`,
    );
    await d.terminate(env.id).catch((e) =>
      d.logger.warn(`[studio-pool] cleanup terminate failed for ${env.id}: ${String(e)}`),
    );
    return null;
  }
}
