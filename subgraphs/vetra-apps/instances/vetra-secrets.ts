import type { Kysely } from "kysely";
import {
  ensureReportingTokens,
  LICENSING_URL_ENV,
  newReportingToken,
  REPORTING_TOKEN_SECRET,
} from "../../vetra-licensing/reporting.js";
import { didForAddress } from "../../vetra-licensing/did.js";
import type { LlmBroker } from "../../vetra-llm/broker.js";
import { notConfigured } from "../errors.js";
import type { VetraAppsDB } from "../db/schema.js";
import type { AppRow } from "../repo.js";
import type { PlanRow } from "../plans/repo.js";
import type { AppsDeps } from "../service.js";
import type { InstanceRow } from "./repo.js";

/** The tenant secret the instance's AI key lives under (the agent reads it by this name). */
export const AI_KEY_SECRET = "OPENROUTER_API_KEY";

/** What a plan instance's AI key needs from the key broker. */
export type InstanceLlm = Pick<
  LlmBroker,
  "provisionVetraKey" | "releaseVetraKey"
>;

const isPlanInstance = (row: InstanceRow) =>
  row.kind === "shared" || row.kind === "own";

/**
 * Secret names Vetra writes for this instance outside settings (declared in
 * its document): the AI key of a plan with a budget, when the key broker is
 * configured. Pure; the reconciler calls it for every pass.
 */
export function vetraSecretsOf(
  deps: Pick<AppsDeps, "licensingDb" | "cfg">,
  row: InstanceRow,
  plan: PlanRow | null,
): string[] {
  const out: string[] = [];
  // Declared whenever the plan has a budget, broker or not: a missing broker
  // fails the pass (ensureInstanceVetraSecrets) instead of dropping the key.
  if (isPlanInstance(row) && plan && (plan.ai_budget_usd ?? 0) > 0)
    out.push(AI_KEY_SECRET);
  // H8: an own instance reports its holder's user stats; a shared one has no single holder.
  if (row.kind === "own" && deps.cfg.licensingUrl && deps.licensingDb)
    out.push(REPORTING_TOKEN_SECRET, LICENSING_URL_ENV);
  return out;
}

/** A plan's key is held by the holder (own) or by the App's owner (shared). */
export function keyOwnerDid(app: AppRow, row: InstanceRow): string {
  return didForAddress(
    row.kind === "own" && row.holder_address
      ? row.holder_address
      : app.owner_address,
  );
}

/**
 * Ensures the instance's AI key in its tenant; idempotent (the broker reuses
 * the key). Throws when the broker fails, so the reconciler retries.
 */
export async function ensureInstanceVetraSecrets(
  deps: Pick<
    AppsDeps,
    "llm" | "logger" | "licensingDb" | "cfg" | "instanceSecrets" | "envs" | "now"
  >,
  app: AppRow,
  row: InstanceRow,
  plan: PlanRow | null,
  tenantId: string,
): Promise<void> {
  if (!row.environment_id) return;
  if (vetraSecretsOf(deps, row, plan).includes(AI_KEY_SECRET)) {
    if (!deps.llm) throw notConfigured("The AI key broker (OPENROUTER_MANAGEMENT_KEY)");
    const out = await deps.llm.provisionVetraKey({
      environmentId: row.environment_id,
      tenantId,
      ownerDid: keyOwnerDid(app, row),
      instanceId: row.id,
      fixedBudgetUsd: plan!.ai_budget_usd!,
    });
    if (!out.connected)
      deps.logger.warn(
        `[vetra-apps] instance ${app.slug}/${row.name}: no AI key was issued (budget unavailable)`,
      );
  }
  if (vetraSecretsOf(deps, row, plan).includes(REPORTING_TOKEN_SECRET))
    await ensureReportingToken(deps, row, tenantId);
}

/** Plan-instance reporting token: the first token is written before the first start (asleep: free). */
export async function ensureReportingToken(
  deps: Pick<
    AppsDeps,
    "licensingDb" | "cfg" | "instanceSecrets" | "envs" | "now" | "logger"
  >,
  row: InstanceRow,
  tenantId: string,
): Promise<void> {
  if (!row.environment_id || !deps.licensingDb) return;
  const envId = row.environment_id;
  await ensureReportingTokens(
    {
      db: deps.licensingDb,
      secrets: deps.instanceSecrets ?? null,
      tenantIdOf: async () => tenantId,
      envStatus: async (id) => (await deps.envs.getState(id))?.status ?? null,
      licensingUrl: deps.cfg.licensingUrl ?? null,
      newToken: newReportingToken,
      now: () => deps.now().toISOString(),
      logger: deps.logger,
    },
    [envId],
  );
  // ensureReportingTokens logs its failures; the reconciler must retry them.
  const recorded = await deps.licensingDb
    .selectFrom("environment_reporting_tokens")
    .select("environment_id")
    .where("environment_id", "=", envId)
    .executeTakeFirst();
  if (!recorded) throw new Error("the reporting token was not issued");
}

/** Releases what ensureInstanceVetraSecrets made (instance destroyed): deletes the AI key. */
export async function releaseInstanceVetraSecrets(
  deps: Pick<AppsDeps, "llm">,
  row: InstanceRow,
): Promise<void> {
  if (row.environment_id && deps.llm)
    await deps.llm.releaseVetraKey(row.environment_id);
}

/**
 * The monthly AI budget of an instance's plan while the instance is to run;
 * null when it has none, is stopping or is gone (the sweeper then disables the key).
 */
export const planBudgetOf =
  (db: Kysely<VetraAppsDB>) =>
  async (instanceId: string): Promise<number | null> => {
    const r = await db
      .selectFrom("instances as i")
      .innerJoin("plans as p", "p.id", "i.plan_id")
      .select("p.ai_budget_usd")
      .where("i.id", "=", instanceId)
      .where("i.stop_reason", "is", null)
      .where("i.removed_at", "is", null)
      .executeTakeFirst();
    return r?.ai_budget_usd ?? null;
  };

/**
 * The licence chain of an own plan instance, for the user-stat relay (plan 7
 * Task 11): an own, not removed instance by its environment. A shared instance
 * has none (no single holder), so the relay refuses it.
 */
export const ownInstanceChain =
  (db: Kysely<VetraAppsDB>) =>
  async (
    environmentId: string,
  ): Promise<{
    root_license_id: string;
    app_id: string;
    user_did: string;
  } | null> => {
    const r = await db
      .selectFrom("instances")
      .select(["licence_root_id", "app_id", "holder_address"])
      .where("environment_id", "=", environmentId)
      .where("kind", "=", "own")
      .where("removed_at", "is", null)
      .executeTakeFirst();
    return r?.licence_root_id && r.holder_address
      ? {
          root_license_id: r.licence_root_id,
          app_id: r.app_id,
          user_did: didForAddress(r.holder_address),
        }
      : null;
  };
