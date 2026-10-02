import type { Kysely, Selectable } from "kysely";
import type {
  AppDeploymentStatus,
  AppDeploymentsTable,
  AppPreviewsTable,
  AppsTable,
  VetraAppsDB,
} from "./db/schema.js";

export type AppRow = Selectable<AppsTable>;
export type PreviewRow = Selectable<AppPreviewsTable>;
export type DeploymentRow = Selectable<AppDeploymentsTable>;

export const ACTIVE_DEPLOYMENT_STATUSES: AppDeploymentStatus[] = [
  "PENDING",
  "DEPLOYING",
];

/** Postgres returns booleans as booleans; PGlite/SQLite may hand back 0/1. */
export function normalizeApp(row: AppRow): AppRow {
  return { ...row, previews_enabled: Boolean(row.previews_enabled) };
}

export async function getApp(
  db: Kysely<VetraAppsDB>,
  id: string,
): Promise<AppRow | null> {
  const row = await db
    .selectFrom("apps")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  return row ? normalizeApp(row) : null;
}

export async function getAppByIdentity(
  db: Kysely<VetraAppsDB>,
  did: string,
): Promise<AppRow | null> {
  const row = await db
    .selectFrom("apps")
    .selectAll()
    .where("identity_did", "=", did)
    .executeTakeFirst();
  return row ? normalizeApp(row) : null;
}

export async function listPreviews(
  db: Kysely<VetraAppsDB>,
  appId: string,
): Promise<PreviewRow[]> {
  return db
    .selectFrom("app_previews")
    .selectAll()
    .where("app_id", "=", appId)
    .orderBy("pr_number", "asc")
    .execute();
}

export async function getPreview(
  db: Kysely<VetraAppsDB>,
  appId: string,
  prNumber: number,
): Promise<PreviewRow | null> {
  return (
    (await db
      .selectFrom("app_previews")
      .selectAll()
      .where("app_id", "=", appId)
      .where("pr_number", "=", prNumber)
      .executeTakeFirst()) ?? null
  );
}

export async function getDeployment(
  db: Kysely<VetraAppsDB>,
  id: string,
): Promise<DeploymentRow | null> {
  return (
    (await db
      .selectFrom("app_deployments")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst()) ?? null
  );
}

export async function latestDeployment(
  db: Kysely<VetraAppsDB>,
  appId: string,
  environmentId?: string,
): Promise<DeploymentRow | null> {
  let q = db
    .selectFrom("app_deployments")
    .selectAll()
    .where("app_id", "=", appId);
  if (environmentId) q = q.where("environment_id", "=", environmentId);
  return (
    (await q
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .executeTakeFirst()) ?? null
  );
}

export async function updateDeployment(
  db: Kysely<VetraAppsDB>,
  id: string,
  patch: Partial<Omit<DeploymentRow, "id">>,
  nowIso: string,
): Promise<void> {
  await db
    .updateTable("app_deployments")
    .set({ ...patch, updated_at: nowIso })
    .where("id", "=", id)
    .execute();
}

export function parsePackages(
  raw: string,
): { name: string; version: string }[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return (parsed as unknown[]).flatMap((p) => {
      const o = p as { name?: unknown; version?: unknown } | null;
      return o && typeof o.name === "string" && typeof o.version === "string"
        ? [{ name: o.name, version: o.version }]
        : [];
    });
  } catch {
    return [];
  }
}
