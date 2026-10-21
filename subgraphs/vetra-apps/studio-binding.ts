import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Kysely } from "kysely";
import { canOperate } from "../../shared/org-access.js";
import { isStudioState } from "../../shared/studio-package.js";
import { getTenantId } from "../../processors/vetra-cloud-environment/gitops.js";
import { STUDIO_LAUNCH_SECRET_KEY } from "../vetra-cloud-secrets/services/secrets-service.js";
import type { VetraCloudEnvironmentState } from "../../document-models/vetra-cloud-environment/index.js";
import type { SecretsService } from "../vetra-cloud-secrets/services/secrets-service.js";
import type { AppsContext, Caller } from "./auth.js";
import type { VetraAppsDB } from "./db/schema.js";
import { appsError, notConfigured } from "./errors.js";
import { appResource, callerAccess, syncAppOrg } from "./org-ownership.js";
import type { AppRow } from "./repo.js";
import type { AppsDeps } from "./service.js";

/**
 * The Studio-agent path (D20): a Studio's agent may launch and roll back only
 * the App bound to its own Studio, on the owner's behalf, under the owner's
 * current Renown delegation. The binding is a per-Studio launch secret: the
 * plaintext lives only in the Studio's tenant secrets (the agent's env), the
 * cloud keeps its sha256. The agent presents it in STUDIO_SECRET_HEADER.
 */

export { STUDIO_LAUNCH_SECRET_KEY };

export const STUDIO_SECRET_HEADER = "x-vetra-studio-secret";

export const STUDIO_BINDING_MESSAGE = "This Studio can only launch its own product";
/** Spec §5.9 copy for a missing or expired publishing permission. */
export const DELEGATION_MESSAGE = "Your Studio needs your OK to publish.";

/** A fresh launch secret: 32 random bytes, hex. */
export function newLaunchSecret(): string {
  return randomBytes(32).toString("hex");
}

/** sha256 (hex) of a launch secret — the only form the cloud stores. */
export function hashLaunchSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** Record (or replace) a Studio's launch secret hash. */
export async function storeLaunchSecretHash(
  db: Kysely<VetraAppsDB>,
  environmentId: string,
  secretHash: string,
  rotatedAt: string,
): Promise<void> {
  await db
    .insertInto("studio_launch_secrets")
    .values({ environment_id: environmentId, secret_hash: secretHash, rotated_at: rotatedAt })
    .onConflict((oc) =>
      oc
        .column("environment_id")
        .doUpdateSet({ secret_hash: secretHash, rotated_at: rotatedAt }),
    )
    .execute();
}

/**
 * Whether the request comes through the Studio-agent path: it carries
 * STUDIO_SECRET_HEADER, even empty (an agent whose Studio has no launch
 * secret yet sends it empty — see ensureStudioProduct).
 */
export function hasStudioSecretHeader(ctx: AppsContext): boolean {
  return ctx.headers?.[STUDIO_SECRET_HEADER] !== undefined;
}

/** The secret the request presents in STUDIO_SECRET_HEADER, or null. */
export function presentedStudioSecret(ctx: AppsContext): string | null {
  const raw = ctx.headers?.[STUDIO_SECRET_HEADER];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return value ? value : null;
}

const bindingError = () => appsError("STUDIO_BINDING", STUDIO_BINDING_MESSAGE);

/** Constant-time comparison of two sha256 hex digests. */
function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === 32 && y.length === 32 && timingSafeEqual(x, y);
}

/**
 * Passes only when the caller is an agent key (`appKey`) acting for
 * `caller.address` under a delegation that is current right now, the caller
 * owns (or, for an organisation's Studio, operates) that Studio env, and
 * sha256(presentedSecret) equals the Studio's stored hash. Refusals:
 * DELEGATION_MISSING (no agent key), STUDIO_BINDING (no/wrong secret, not a
 * Studio, not the caller's), DELEGATION_EXPIRED (the owner's delegation for
 * the key is gone or expired). Never logs or echoes the secret.
 */
export async function verifyStudioSecret(
  deps: AppsDeps,
  caller: Caller,
  presentedSecret: string | null,
  studioEnvironmentId: string | null,
): Promise<void> {
  if (!caller.appKey) throw appsError("DELEGATION_MISSING", DELEGATION_MESSAGE);
  if (!studioEnvironmentId || !presentedSecret) throw bindingError();

  const stored = await deps.db
    .selectFrom("studio_launch_secrets")
    .select("secret_hash")
    .where("environment_id", "=", studioEnvironmentId)
    .executeTakeFirst();
  if (!stored || !sameHash(hashLaunchSecret(presentedSecret), stored.secret_hash)) {
    throw bindingError();
  }
  await assertStudioAgent(deps, caller, studioEnvironmentId);
}

/**
 * The checks of verifyStudioSecret that need no secret: the caller is an
 * agent key, the env is a Studio the caller owns (or operates for its
 * organisation), and the owner's delegation for the key is current. Returns
 * the Studio's state. Same refusals as verifyStudioSecret.
 */
export async function assertStudioAgent(
  deps: AppsDeps,
  caller: Caller,
  studioEnvironmentId: string,
): Promise<VetraCloudEnvironmentState> {
  if (!caller.appKey) throw appsError("DELEGATION_MISSING", DELEGATION_MESSAGE);
  const studio = await deps.envs.getState(studioEnvironmentId);
  if (!studio || !isStudioState(studio)) throw bindingError();
  // The agent acts as the owner, never as a platform admin.
  const operates = await canOperate(
    deps.orgs ?? null,
    { address: caller.address, isAdmin: false },
    { owner: studio.owner ?? null, ownerOrgId: studio.ownerOrgId ?? null, appDid: null },
  );
  if (!operates) throw bindingError();

  // The owner's permission must be current on every call, not only when the
  // agent's session was opened.
  if (!deps.renown) throw notConfigured("Renown");
  const delegation = await deps.renown.getDelegation({
    address: caller.address,
    chainId: caller.chainId,
    did: caller.appKey,
  });
  const expiresAt = delegation?.expiresAt ? Date.parse(delegation.expiresAt) : null;
  if (
    !delegation ||
    (expiresAt !== null && (Number.isNaN(expiresAt) || expiresAt <= deps.now().getTime()))
  ) {
    throw appsError("DELEGATION_EXPIRED", DELEGATION_MESSAGE);
  }
  return studio;
}

/** Whether the Studio has a launch secret hash recorded. */
export async function hasLaunchSecret(
  db: Kysely<VetraAppsDB>,
  environmentId: string,
): Promise<boolean> {
  return !!(await db
    .selectFrom("studio_launch_secrets")
    .select("environment_id")
    .where("environment_id", "=", environmentId)
    .executeTakeFirst());
}

/**
 * Write one launch secret into the tenant through the single-key path
 * (ensureSecret when absent, setManagedSecret otherwise; F31). The secrets
 * controller syncs it and Reloader restarts the Studio's pods.
 */
async function writeLaunchSecret(
  secrets: Pick<SecretsService, "ensureSecret" | "setManagedSecret">,
  tenantId: string,
  secret: string,
): Promise<void> {
  const wrote = await secrets.ensureSecret(
    tenantId,
    STUDIO_LAUNCH_SECRET_KEY,
    () => secret,
  );
  if (!wrote) {
    await secrets.setManagedSecret(tenantId, STUDIO_LAUNCH_SECRET_KEY, secret);
  }
}

/**
 * Give a claimed Studio a launch secret when it has none (controller ruling
 * X22: existing Studios and Studios made outside the warm pool need no manual
 * backfill). The hash row is claimed first (insert … on conflict do nothing),
 * so of two concurrent callers, on any replica, only one writes a secret; if
 * the tenant write then fails, the claimed row is removed again. Returns true
 * when a secret was written: the Studio's agent sees it only after its pod
 * restarts. Never logs the secret.
 */
export async function ensureStudioLaunchSecret(
  deps: AppsDeps,
  environmentId: string,
  studio: VetraCloudEnvironmentState,
): Promise<boolean> {
  if (await hasLaunchSecret(deps.db, environmentId)) return false;
  if (!deps.studioSecrets) throw notConfigured("Tenant secrets");
  if (!studio.genericSubdomain) {
    throw appsError("BAD_USER_INPUT", "This Studio is not initialised yet");
  }
  const tenantId = getTenantId(studio.genericSubdomain, environmentId);
  const secret = newLaunchSecret();
  const secretHash = hashLaunchSecret(secret);
  const claimed = await deps.db
    .insertInto("studio_launch_secrets")
    .values({
      environment_id: environmentId,
      secret_hash: secretHash,
      rotated_at: deps.now().toISOString(),
    })
    .onConflict((oc) => oc.column("environment_id").doNothing())
    .returning("environment_id")
    .executeTakeFirst();
  if (!claimed) return false;
  try {
    await writeLaunchSecret(deps.studioSecrets, tenantId, secret);
  } catch (err) {
    await deps.db
      .deleteFrom("studio_launch_secrets")
      .where("environment_id", "=", environmentId)
      .where("secret_hash", "=", secretHash)
      .execute()
      .catch((e: unknown) =>
        deps.logger.error(
          `[vetra-apps] removing the launch secret claim of Studio ${environmentId} failed: ${String(e)}`,
        ),
      );
    throw err;
  }
  deps.logger.info(
    `[vetra-apps] launch secret provisioned for Studio ${environmentId}; its agent picks it up after the restart`,
  );
  return true;
}

/**
 * verifyStudioSecret against the App's own Studio, plus: the caller still
 * acts for the App (its personal owner, or a publisher of its organisation),
 * with ownership first reconciled with Renown. A deleted App, or one not made
 * from a Studio, is refused with STUDIO_BINDING.
 */
export async function verifyStudioBinding(
  deps: AppsDeps,
  caller: Caller,
  presentedSecret: string | null,
  app: AppRow,
): Promise<void> {
  if (app.status === "DELETED") throw bindingError();
  await verifyStudioSecret(deps, caller, presentedSecret, app.studio_environment_id ?? null);
  const synced = await syncAppOrg(deps, app);
  const operates = await canOperate(
    deps.orgs ?? null,
    callerAccess({ ...caller, isAdmin: false }),
    appResource(synced),
  );
  if (!operates) throw bindingError();
}

/**
 * Admin: give a Studio a new launch secret (also the backfill for Studios
 * claimed before launch secrets existed, and for Studios made outside the
 * warm pool). Writes that one key through the secrets service's single-key
 * path (ensureSecret when absent, setManagedSecret otherwise) — no other
 * tenant entry is read or touched — then records the hash.
 */
export async function rotateStudioLaunchSecret(
  deps: AppsDeps,
  caller: Caller,
  environmentId: string,
): Promise<boolean> {
  if (!caller.isAdmin) throw appsError("FORBIDDEN", "Admins only");
  if (!deps.studioSecrets) throw notConfigured("Tenant secrets");
  const studio = await deps.envs.getState(environmentId);
  if (!studio) throw appsError("NOT_FOUND", "Environment not found");
  if (!isStudioState(studio)) throw appsError("BAD_USER_INPUT", "Not a Vetra Studio");
  if (!studio.owner && !studio.ownerOrgId) {
    // A warm Studio gets its secret when it is claimed.
    throw appsError("BAD_USER_INPUT", "This Studio has not been claimed yet");
  }
  if (!studio.genericSubdomain) {
    throw appsError("BAD_USER_INPUT", "This Studio is not initialised yet");
  }
  const tenantId = getTenantId(studio.genericSubdomain, environmentId);

  const secret = newLaunchSecret();
  await writeLaunchSecret(deps.studioSecrets, tenantId, secret);
  await storeLaunchSecretHash(
    deps.db,
    environmentId,
    hashLaunchSecret(secret),
    deps.now().toISOString(),
  );
  deps.logger.info(`[vetra-apps] launch secret rotated for Studio ${environmentId}`);
  return true;
}
