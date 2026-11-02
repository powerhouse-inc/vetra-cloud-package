import type { Action } from "document-model";
import type { Kysely } from "kysely";
import type { VetraCloudEnvironmentState } from "document-models/vetra-cloud-environment";
import { approveChanges, setLabel, setOwner } from "document-models/vetra-cloud-environment";
import { getTenantId } from "../../processors/vetra-cloud-environment/gitops.js";
import type { LicensingConfig } from "./config.js";
import type { LicenseEnvironments, VetraLicensingDB } from "./db/schema.js";
import { addressOfDid } from "./did.js";
import { keyedMutex, LockTimeoutError, type AcquireOptions } from "./keyed-mutex.js";
import {
  renderCreateActions,
  renderFloorUpdateActions,
  validateTemplate,
  type TemplateShape,
} from "./template.js";
import type { WarmPoolStore, WarmRow } from "./warm-pool-db.js";

export class AppEnvironmentCapReachedError extends Error {
  override name = "AppEnvironmentCapReachedError";
}

/**
 * The `template_hash` of a row that owns an environment document whose template
 * has not been applied yet. Never a sha256, so it can never compare equal to a
 * wanted hash: the next call always re-applies against the claimed document.
 */
export const UNAPPLIED_TEMPLATE_HASH = "unapplied";

/** The environment is asleep, mid-transition or gone; nothing is dispatched and the next tick retries. */
export class EnvironmentNotReadyError extends Error {
  override name = "EnvironmentNotReadyError";
}

/**
 * The chain's environment row names a different holder or app than the
 * licence asking for it. Nothing is dispatched: re-templating (or repointing)
 * someone else's environment is never the answer to inconsistent data.
 */
export class EnvironmentOwnershipMismatchError extends Error {
  override name = "EnvironmentOwnershipMismatchError";
}

export type ChainEnvRows = ReturnType<typeof createChainEnvironmentRows>;

type RowPatch = Partial<Omit<LicenseEnvironments, "environment_id" | "root_license_id">>;

/** `license_environments`: one DEDICATED environment per licence chain. */
export function createChainEnvironmentRows(
  db: Kysely<VetraLicensingDB>,
  cfg: Pick<LicensingConfig, "defaultMaxEnvironments">,
) {
  const one = (q: Promise<LicenseEnvironments | undefined>) => q.then((r) => r ?? null);
  return {
    byRoot: (root: string): Promise<LicenseEnvironments | null> =>
      one(
        db
          .selectFrom("license_environments")
          .selectAll()
          .where("root_license_id", "=", root)
          .executeTakeFirst(),
      ),
    byEnvironment: (environmentId: string): Promise<LicenseEnvironments | null> =>
      one(
        db
          .selectFrom("license_environments")
          .selectAll()
          .where("environment_id", "=", environmentId)
          .executeTakeFirst(),
      ),
    forApp: (appId: string): Promise<LicenseEnvironments[]> =>
      db
        .selectFrom("license_environments")
        .selectAll()
        .where("app_id", "=", appId)
        .orderBy("root_license_id")
        .execute(),
    appIds: async (): Promise<string[]> =>
      (
        await db.selectFrom("license_environments").select("app_id").distinct().execute()
      ).map((r) => r.app_id),
    countForApp: async (appId: string): Promise<number> =>
      Number(
        (
          await db
            .selectFrom("license_environments")
            .select((eb) => eb.fn.countAll<string>().as("n"))
            .where("app_id", "=", appId)
            .executeTakeFirstOrThrow()
        ).n,
      ),
    maxForApp: async (appId: string): Promise<number> =>
      (
        await db
          .selectFrom("app_environment_limits")
          .select("max_environments")
          .where("app_id", "=", appId)
          .executeTakeFirst()
      )?.max_environments ?? cfg.defaultMaxEnvironments,
    /**
     * Insert if the chain is unclaimed; return whichever row owns the chain.
     * The UNIQUE root_license_id is the lock: an existing claim is never overwritten.
     */
    async claim(row: LicenseEnvironments): Promise<LicenseEnvironments> {
      await db
        .insertInto("license_environments")
        .values(row)
        .onConflict((oc) => oc.column("root_license_id").doNothing())
        .execute();
      return db
        .selectFrom("license_environments")
        .selectAll()
        .where("root_license_id", "=", row.root_license_id)
        .executeTakeFirstOrThrow();
    },
    async update(environmentId: string, patch: RowPatch): Promise<void> {
      await db
        .updateTable("license_environments")
        .set(patch)
        .where("environment_id", "=", environmentId)
        .execute();
    },
    async remove(environmentId: string): Promise<void> {
      await db
        .deleteFrom("license_environments")
        .where("environment_id", "=", environmentId)
        .execute();
    },
  };
}

/**
 * What a claim of a warm environment needs. Without it provisionChain only
 * ever builds cold.
 */
export interface WarmClaimDeps {
  store: WarmPoolStore;
  /** Hands the document's protection to its new owner (protectForOwner). */
  handOver(documentId: string, owner: string): Promise<void>;
  /** Writes the licence's included AI key, when it carries one (§3.11). */
  appKey?: (input: {
    environmentId: string;
    tenantId: string;
    rootLicenseId: string;
    ownerDid: string;
  }) => Promise<void>;
}

export interface ChainEnvDeps {
  rows: ChainEnvRows;
  envs: {
    create(): Promise<string>;
    execute(id: string, actions: Action[]): Promise<unknown>;
    getState(id: string): Promise<VetraCloudEnvironmentState | null>;
    delete(id: string): Promise<void>;
  };
  generateSubdomain(id: string): string;
  logger?: Pick<Console, "error">;
  /** Claim a warm environment before building one (DEDICATED templates only). */
  warmPool?: WarmClaimDeps;
}

export interface ProvisionChainInput {
  appId: string;
  root: string;
  licenseId: string;
  /** did:pkh:eip155:1:<address>; the environment's owner is its address. */
  userDid: string;
  templateId: string;
  template: TemplateShape;
  templateHash: string;
  label: string;
  now: string;
}

/** Statuses a template must not be applied in: asleep, going away, or gone. */
const NOT_APPLICABLE = new Set(["STOPPED", "TERMINATING", "DESTROYED", "ARCHIVED"]);

function assertSameOwner(row: LicenseEnvironments, input: ProvisionChainInput): void {
  if (row.app_id !== input.appId || row.user_did !== input.userDid) {
    throw new EnvironmentOwnershipMismatchError(
      `environment ${row.environment_id} of chain ${row.root_license_id} belongs to ${row.user_did} (app ${row.app_id}), not ${input.userDid} (app ${input.appId}); leaving it alone`,
    );
  }
}

/**
 * Ensure the chain's one environment exists and matches the template.
 * Idempotent, so the handler can call it every tick.
 *
 * Claim before act: a fresh document is written into the row (with
 * UNAPPLIED_TEMPLATE_HASH) before any action is applied, so a rejected action
 * list leaves a claim the next call reuses rather than an orphan. The per-app
 * cap applies only to creation. Re-templating a live environment treats the
 * template as a floor (renderFloorUpdateActions): it adds and upgrades, never
 * removes, and never touches the label. Nothing here deletes or stops an
 * environment; the only deletes are of a document this call just created and
 * nothing references (a lost claim race, or a claim that failed).
 */
export async function provisionChain(
  deps: ChainEnvDeps,
  input: ProvisionChainInput,
): Promise<LicenseEnvironments> {
  const existing = await deps.rows.byRoot(input.root);
  if (existing) assertSameOwner(existing, input);
  if (existing && existing.template_hash === input.templateHash) {
    if (existing.license_id === input.licenseId) return existing;
    // A renewal: the environment is already right; only repoint the row at
    // the licence that now justifies it.
    await deps.rows.update(existing.environment_id, {
      license_id: input.licenseId,
      updated_at: input.now,
    });
    return { ...existing, license_id: input.licenseId, updated_at: input.now };
  }

  if (!existing) {
    const [count, max] = await Promise.all([
      deps.rows.countForApp(input.appId),
      deps.rows.maxForApp(input.appId),
    ]);
    if (count >= max) {
      throw new AppEnvironmentCapReachedError(
        `app ${input.appId} is at its ceiling of ${max} environments`,
      );
    }
  }
  // Pure and may throw on a bad template: before anything is created.
  validateTemplate(input.template);

  let row = existing;
  if (deps.warmPool) {
    const warm = await claimWarm(deps, deps.warmPool, existing, input);
    if (warm.done) return warm.done;
    row = warm.row;
  }
  if (!row) {
    const fresh = await deps.envs.create();
    const claim = deps.rows.claim({
      environment_id: fresh,
      root_license_id: input.root,
      app_id: input.appId,
      user_did: input.userDid,
      license_id: input.licenseId,
      template_id: input.templateId,
      label: input.label,
      template_hash: UNAPPLIED_TEMPLATE_HASH,
      ended_at: null,
      stopped_at: null,
      delete_after: null,
      created_at: input.now,
      updated_at: input.now,
    });
    try {
      row = await claim;
    } catch (err) {
      // The claim is an INSERT then a SELECT: the INSERT may have committed.
      // Delete the fresh DRAFT document only when no row references it;
      // otherwise (or when that cannot be told) leave it for the next tick,
      // which finds the claim and initialises it.
      const log = deps.logger ?? console;
      let owner: LicenseEnvironments | null | undefined;
      try {
        owner = await deps.rows.byRoot(input.root);
      } catch (checkErr) {
        log.error(
          `[licensing] claim of chain ${input.root} failed and whether it references ${fresh} cannot be told; leaving the document: ${String(checkErr)}`,
        );
        throw err;
      }
      if (owner?.environment_id !== fresh) {
        // Without this, a claim that keeps failing would leak one document per tick.
        await deps.envs.delete(fresh).catch((deleteErr: unknown) => {
          log.error(
            `[licensing] claim of chain ${input.root} failed and its fresh environment ${fresh} could not be deleted: ${String(deleteErr)}`,
          );
        });
      }
      throw err;
    }
    if (row.environment_id !== fresh) {
      // Another caller claimed the chain first; our document is referenced
      // by nothing, so drop it rather than orphan it.
      await deps.envs.delete(fresh);
      assertSameOwner(row, input);
      if (row.template_hash === input.templateHash) return row;
    }
  }

  const state = await deps.envs.getState(row.environment_id);
  if (!state) {
    // The claimed document is gone. Never recreate behind the row's back:
    // hold until someone looks at it.
    throw new EnvironmentNotReadyError(
      `environment ${row.environment_id} of chain ${row.root_license_id} has no document`,
    );
  }
  if (NOT_APPLICABLE.has(state.status)) {
    throw new EnvironmentNotReadyError(`environment ${row.environment_id} is ${state.status}`);
  }
  // DRAFT is "created, never initialised": also what a claim whose action
  // list was rejected leaves behind, so that retry is a create. A live
  // environment is only brought UP TO the template (a floor): its label, its
  // extra packages and its other services are the holder's.
  const actions =
    state.status !== "DRAFT"
      ? renderFloorUpdateActions({ template: input.template, current: state })
      : renderCreateActions({
          label: input.label,
          subdomain: deps.generateSubdomain(row.environment_id),
          owner: addressOfDid(input.userDid),
          template: input.template,
        });
  if (actions.length > 0) await deps.envs.execute(row.environment_id, actions);

  // The row's label is the one the environment was created with.
  const patch = {
    license_id: input.licenseId,
    template_id: input.templateId,
    template_hash: input.templateHash,
    updated_at: input.now,
  };
  await deps.rows.update(row.environment_id, patch);
  return { ...row, ...patch };
}

/** The warm environment cannot be used; it is discarded and the chain built cold. */
class WarmEnvironmentUnusableError extends Error {
  override name = "WarmEnvironmentUnusableError";
}

/**
 * Claim a warm environment for the chain, or finish one a crashed call
 * claimed (a row still UNAPPLIED whose environment is this chain's CLAIMED
 * warm row: roll forward, never a second environment). `done` is the
 * claimed chain's row; otherwise `row` is what the caller carries on with
 * (null: build cold).
 */
async function claimWarm(
  deps: ChainEnvDeps,
  warmPool: WarmClaimDeps,
  existing: LicenseEnvironments | null,
  input: ProvisionChainInput,
): Promise<{ done: LicenseEnvironments; row?: never } | { done?: never; row: LicenseEnvironments | null }> {
  if (existing) {
    if (existing.template_hash !== UNAPPLIED_TEMPLATE_HASH) return { row: existing };
    const warm = await warmPool.store.byEnvironment(existing.environment_id);
    if (warm?.state !== "CLAIMED" || warm.root_license_id !== existing.root_license_id) {
      return { row: existing };
    }
    const done = await finishWarmClaim(deps, warmPool, existing, warm, input);
    return done ? { done } : { row: null };
  }

  // Claimed and the chain's row written in one transaction (see claimForChain).
  const claim = await warmPool.store.claimForChain(
    {
      appId: input.appId,
      templateId: input.templateId,
      templateHash: input.templateHash,
      rootLicenseId: input.root,
      nowIso: input.now,
    },
    {
      root_license_id: input.root,
      app_id: input.appId,
      user_did: input.userDid,
      license_id: input.licenseId,
      template_id: input.templateId,
      label: input.label,
      template_hash: UNAPPLIED_TEMPLATE_HASH,
      ended_at: null,
      stopped_at: null,
      delete_after: null,
      created_at: input.now,
      updated_at: input.now,
    },
  );
  if (!claim.warm) {
    // None available (build cold), or another caller holds the chain: adopt
    // its row as a lost cold claim would.
    if (!claim.row) return { row: null };
    assertSameOwner(claim.row, input);
    if (claim.row.template_hash === input.templateHash) return { done: claim.row };
    return { row: claim.row };
  }
  const done = await finishWarmClaim(deps, warmPool, claim.row, claim.warm, input);
  return done ? { done } : { row: null };
}

/**
 * Steps 3-4 of a claim (spec §3.5), idempotent so a crashed claim can be
 * rolled forward: re-read the document, give it to the holder (SET_OWNER and
 * the template's floor, whose ADMINS follows the owner, in one batch), the
 * included key, protection, then record the template hash. On any failure
 * the environment is discarded, never returned to the pool (it may carry a
 * partial owner write), and null tells the caller to build cold.
 */
async function finishWarmClaim(
  deps: ChainEnvDeps,
  warmPool: WarmClaimDeps,
  row: LicenseEnvironments,
  warm: WarmRow,
  input: ProvisionChainInput,
): Promise<LicenseEnvironments | null> {
  const id = row.environment_id;
  const holder = addressOfDid(input.userDid);
  const log = deps.logger ?? console;
  try {
    if (warm.deleted_at !== null) {
      throw new WarmEnvironmentUnusableError(`warm environment ${id} was recycled`);
    }
    const state = await deps.envs.getState(id);
    if (!state) throw new WarmEnvironmentUnusableError(`warm environment ${id} has no document`);
    const owner = state.owner?.toLowerCase() ?? null;
    if (owner === holder && NOT_APPLICABLE.has(state.status)) {
      // A rolled-forward claim whose owner write landed: the environment is
      // the holder's now. Hold, as for any chain environment.
      throw new EnvironmentNotReadyError(`environment ${id} is ${state.status}`);
    }
    if (owner !== null && owner !== holder) {
      throw new WarmEnvironmentUnusableError(`warm environment ${id} is already owned by ${owner}`);
    }
    if (owner === null && state.status !== "READY") {
      throw new WarmEnvironmentUnusableError(`warm environment ${id} is ${state.status}, not READY`);
    }
    // One batch: gitops re-renders once and the app restarts once. The warm
    // label ("<App> (warm)") becomes the holder's, as a cold build's would.
    const label = row.label ?? input.label;
    const floor = renderFloorUpdateActions({ template: input.template, current: { ...state, owner: holder } });
    const relabel = state.label !== label ? [setLabel({ label })] : [];
    // SET_LABEL leaves a deployed environment CHANGES_PENDING: approve it even
    // when the floor is already met.
    const approve = relabel.length > 0 && floor.at(-1)?.type !== "APPROVE_CHANGES" ? [approveChanges({})] : [];
    await deps.envs.execute(id, [setOwner({ address: holder }), ...relabel, ...floor, ...approve]);
    if (warmPool.appKey) {
      if (!state.genericSubdomain) {
        throw new WarmEnvironmentUnusableError(`warm environment ${id} has no subdomain to key`);
      }
      await warmPool.appKey({
        environmentId: id,
        tenantId: getTenantId(state.genericSubdomain, id),
        rootLicenseId: row.root_license_id,
        ownerDid: input.userDid,
      });
    }
    await warmPool.handOver(id, holder);
  } catch (err) {
    if (err instanceof EnvironmentNotReadyError) throw err;
    log.error(
      `[licensing] claim of warm environment ${id} for chain ${row.root_license_id} failed; discarding it and building cold: ${String(err)}`,
    );
    await discardWarmClaim(deps, warmPool, id, input.now);
    return null;
  }
  const patch = {
    license_id: input.licenseId,
    template_id: input.templateId,
    template_hash: input.templateHash,
    updated_at: input.now,
  };
  await deps.rows.update(id, patch);
  return { ...row, ...patch };
}

/**
 * Undo a failed claim: the environment deleted, its warm row deleted, the
 * chain's row removed (the key goes with the environment, as Studio's do).
 * Any step failing rethrows with the chain row still in place, so the next
 * call rolls the claim forward or discards it again; never a second
 * environment alongside it.
 */
async function discardWarmClaim(
  deps: ChainEnvDeps,
  warmPool: WarmClaimDeps,
  id: string,
  now: string,
): Promise<void> {
  try {
    await deps.envs.delete(id);
  } catch (err) {
    // Already gone (a recycle) is what we wanted.
    if ((await deps.envs.getState(id)) !== null) throw err;
  }
  await warmPool.store.markDeleted(id, now);
  await deps.rows.remove(id);
}

/**
 * Another caller (usually a handler step, possibly one that timed out but
 * is still running) holds the chain, and this call gave up waiting for it.
 * Nothing was done; retry later. Mapped to BUSY.
 */
export class ChainBusyError extends Error {
  override name = "ChainBusyError";
  constructor() {
    super("this licence chain is busy; retry shortly");
  }
}

/**
 * One lock per licence chain (keyed by its root), shared by every path that
 * provisions or ends a chain: the AppLicenseHandler's ticks and the machine
 * API. In-process, which is enough because the subgraph runs as a single
 * replica (pgbouncer in transaction mode rules out session advisory locks).
 * A handler step that timed out but is still running keeps holding it, so
 * nothing else touches that chain until it settles.
 */
export const withChainLock = keyedMutex();

/**
 * fn under the chain's lock. With `timeoutMs`, a caller that cannot get the
 * lock in time leaves the queue without running fn and gets ChainBusyError.
 */
export async function lockChain<T>(root: string, fn: () => Promise<T>, opts: AcquireOptions = {}): Promise<T> {
  try {
    return await withChainLock(root, fn, opts);
  } catch (err) {
    if (err instanceof LockTimeoutError) throw new ChainBusyError();
    throw err;
  }
}

/**
 * provisionChain under the chain's lock: two callers on one chain never both
 * create an environment (the second finds the first one's row and is a
 * no-op, a repoint or a re-template of the same environment).
 */
export function provisionChainExclusive(
  deps: ChainEnvDeps,
  input: ProvisionChainInput,
  opts: AcquireOptions = {},
): Promise<LicenseEnvironments> {
  return lockChain(input.root, () => provisionChain(deps, input), opts);
}
