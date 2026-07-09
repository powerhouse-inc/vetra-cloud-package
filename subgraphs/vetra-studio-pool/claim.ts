import { randomBytes } from "node:crypto";
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
  /**
   * Inject several secrets into the tenant secret store atomically — one write,
   * one notify, one pod bounce. Carries the Anthropic key(s) AND `ADMINS` so the
   * claimant becomes the embedded switchboard's admin without a gitops
   * re-render (which was the slow ~30s second restart).
   */
  setSecrets: (
    tenantId: string,
    entries: Array<{ key: string; value: string }>,
  ) => Promise<void>;
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
    // 3. Inject the key (under all required names) AND ADMINS in ONE batched
    //    write — a single pg_notify → one secrets-controller reconcile → ONE
    //    Reloader bounce of the agent pod. Delivering ADMINS here (instead of
    //    via an owner-change gitops re-render) is what collapses the claim from
    //    two restarts (~3s secret bounce + ~30s gitops/ADMINS rollout) to one
    //    ~3s bounce. Retried as a whole for transient failures.
    const secretEntries = [
      ...SECRET_NAMES.map((key) => ({ key, value: apiKey })),
      { key: "ADMINS", value: addr },
      // Per-env random secret gating vetra-cli's session-export endpoints
      // (admin-side debugging). Rides this same batched write — no extra bounce.
      { key: "VETRA_SESSION_EXPORT_SECRET", value: randomBytes(32).toString("hex") },
    ];
    await withRetry(() => d.setSecrets(env.tenantId!, secretEntries), SECRET_RETRIES, sleep);
    // 4. Transfer ownership LAST (system action — env was created owner-null).
    //    SET_OWNER updates ownership/read-model only; it no longer triggers a
    //    gitops rollout (ADMINS now arrives via the Secret above).
    await d.setOwner(env.id, addr);
    d.logger.info(`[studio-pool] claimed ${env.id} (${env.tenantId}) for ${addr}`);
    return {
      documentId: env.id,
      subdomain: env.subdomain ?? "",
      tenantId: env.tenantId,
    };
  } catch (err) {
    // Half-claimed (owned, possibly key-less) → delete so nothing leaks; the
    // keeper refills. Caller gets null → cold-falls-back.
    d.logger.warn(
      `[studio-pool] claim post-assign failed for ${env.id}; deleting: ${String(err)}`,
    );
    await d.deleteEnv(env.id).catch((e) =>
      d.logger.warn(`[studio-pool] cleanup delete failed for ${env.id}: ${String(e)}`),
    );
    return null;
  }
}
