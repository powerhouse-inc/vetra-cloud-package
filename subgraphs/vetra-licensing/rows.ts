import type { Kysely } from "kysely";
import type { LicensingConfig } from "./config.js";
import type { VetraLicensingDB, AppUserEnvironments } from "./db/schema.js";

/**
 * The row operations behind applyEnvironmentTemplate. One copy, used by the
 * resolvers and by the provisioning keeper, so the per-app environment cap
 * (countForApp / maxForApp) is enforced identically on both paths.
 */
export function createEnvironmentRows(
  db: Kysely<VetraLicensingDB>,
  cfg: Pick<LicensingConfig, "defaultMaxEnvironments">,
) {
  // user_address is stored lowercased; normalise at every database boundary so
  // a mixed-case caller can never produce a second row.
  const findRow = (appId: string, user: string) =>
    db
      .selectFrom("app_user_environments")
      .selectAll()
      .where("app_id", "=", appId)
      .where("user_address", "=", user.toLowerCase())
      .executeTakeFirst()
      .then((r) => r ?? null);

  const countForApp = (appId: string) =>
    db
      .selectFrom("app_user_environments")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("app_id", "=", appId)
      .executeTakeFirstOrThrow()
      .then((r) => Number(r.n));

  const maxForApp = (appId: string) =>
    db
      .selectFrom("app_environment_limits")
      .select("max_environments")
      .where("app_id", "=", appId)
      .executeTakeFirst()
      .then((r) => r?.max_environments ?? cfg.defaultMaxEnvironments);

  // Claim: insert if the key is free, otherwise change nothing and return the
  // row that already owns it. This is what makes the primary key the lock —
  // the loser of a race adopts the winner's environment instead of orphaning
  // its own, and a claim is never overwritten by a later claimant.
  const claimRow = async (input: AppUserEnvironments) => {
    const row = { ...input, user_address: input.user_address.toLowerCase() };
    await db
      .insertInto("app_user_environments")
      .values(row)
      .onConflict((oc) => oc.columns(["app_id", "user_address"]).doNothing())
      .execute();
    return db
      .selectFrom("app_user_environments")
      .selectAll()
      .where("app_id", "=", row.app_id)
      .where("user_address", "=", row.user_address)
      .executeTakeFirstOrThrow();
  };

  // The conflict clause deliberately leaves environment_id alone, so the loser
  // of a race adopts the winner's environment; the re-read returns that row.
  const upsertRow = async (input: AppUserEnvironments) => {
    const row = { ...input, user_address: input.user_address.toLowerCase() };
    await db
      .insertInto("app_user_environments")
      .values(row)
      .onConflict((oc) =>
        oc.columns(["app_id", "user_address"]).doUpdateSet({
          license_id: row.license_id,
          template_hash: row.template_hash,
          updated_at: row.updated_at,
        }),
      )
      .execute();
    return db
      .selectFrom("app_user_environments")
      .selectAll()
      .where("app_id", "=", row.app_id)
      .where("user_address", "=", row.user_address)
      .executeTakeFirstOrThrow();
  };

  return { findRow, countForApp, maxForApp, claimRow, upsertRow };
}
