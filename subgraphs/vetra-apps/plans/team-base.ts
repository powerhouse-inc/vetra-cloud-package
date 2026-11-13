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

/** While Renown is down, an admins override is trusted this long past its last check. */
export const TEAM_ADMINS_TRUST_MS = 60 * 60_000;

/**
 * The Team instance's ADMINS override, when still valid: read for the App's
 * current organisation and checked within the trust window. Otherwise null:
 * no admins, so access goes through the gate's membership branch.
 */
export function validTeamAdmins(
  app: Pick<AppRow, "owner_org_id" | "org_disputed">,
  row: {
    admins_override?: string | null;
    admins_override_org?: string | null;
    admins_checked_at?: string | null;
  },
  now: Date,
): string | null {
  if (!row.admins_override || !isOrgApp(app)) return null;
  if (row.admins_override_org !== app.owner_org_id) return null;
  const checked = Date.parse(row.admins_checked_at ?? "");
  if (
    !Number.isFinite(checked) ||
    now.getTime() - checked > TEAM_ADMINS_TRUST_MS
  )
    return null;
  return row.admins_override;
}
