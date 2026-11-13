import type { Kysely } from "kysely";
import type { VetraAppsDB } from "../db/schema.js";
import type { AppRow } from "../repo.js";
import type { PlanRow } from "./repo.js";

// Leaf module (no service imports): what the Team plan's callers share without import cycles.

export const TEAM_NOT_ORG = "the App is not an organisation's";

export const isTeamPlan = (p: Pick<PlanRow, "team">): boolean =>
  p.team === true;

/** Owned by an organisation whose claim Vetra trusts (not disputed). */
export const isOrgApp = (
  app: Pick<AppRow, "owner_org_id" | "org_disputed">,
): boolean => !!app.owner_org_id && app.org_disputed !== true;

export async function teamPlanOf(
  db: Kysely<VetraAppsDB>,
  appId: string,
): Promise<PlanRow | null> {
  return (
    (await db
      .selectFrom("plans")
      .selectAll()
      .where("app_id", "=", appId)
      .where("team", "=", true)
      .executeTakeFirst()) ?? null
  );
}

export async function activeTeamPlan(
  db: Kysely<VetraAppsDB>,
  appId: string,
): Promise<PlanRow | null> {
  const p = await teamPlanOf(db, appId);
  return p?.status === "active" ? p : null;
}
