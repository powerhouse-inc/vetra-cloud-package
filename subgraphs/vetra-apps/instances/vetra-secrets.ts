import type { Kysely } from "kysely";
import { didForAddress } from "../../vetra-licensing/did.js";
import type { LlmBroker } from "../../vetra-llm/broker.js";
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
  deps: Pick<AppsDeps, "llm">,
  row: InstanceRow,
  plan: PlanRow | null,
): string[] {
  const out: string[] = [];
  if (deps.llm && isPlanInstance(row) && plan && (plan.ai_budget_usd ?? 0) > 0)
    out.push(AI_KEY_SECRET);
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
  deps: Pick<AppsDeps, "llm" | "logger">,
  app: AppRow,
  row: InstanceRow,
  plan: PlanRow | null,
  tenantId: string,
): Promise<void> {
  if (!row.environment_id) return;
  if (vetraSecretsOf(deps, row, plan).includes(AI_KEY_SECRET) && deps.llm) {
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
