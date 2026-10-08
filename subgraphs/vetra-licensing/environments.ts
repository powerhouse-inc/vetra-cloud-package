import type { Action } from "document-model";
import type { Kysely } from "kysely";
import type { VetraCloudEnvironmentState } from "document-models/vetra-cloud-environment";
import type { LicensingConfig } from "./config.js";
import type { LicenseEnvironments, VetraLicensingDB } from "./db/schema.js";
import { addressOfDid } from "./did.js";
import { AppEnvironmentCapReachedError, UNAPPLIED_TEMPLATE_HASH } from "./provision.js";
import {
  renderCreateActions,
  renderFloorUpdateActions,
  validateTemplate,
  type TemplateShape,
} from "./template.js";

export { AppEnvironmentCapReachedError };

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
