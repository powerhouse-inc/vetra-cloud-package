import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("apps")
    .addColumn("id", "varchar(64)", (c) => c.primaryKey())
    .addColumn("slug", "varchar(255)", (c) => c.notNull().unique())
    .addColumn("name", "varchar(255)", (c) => c.notNull())
    .addColumn("owner_address", "varchar(255)", (c) => c.notNull())
    .addColumn("owner_chain_id", "integer", (c) => c.notNull())
    .addColumn("status", "varchar(32)", (c) => c.notNull())
    .addColumn("installation_id", "varchar(64)", (c) => c.notNull())
    .addColumn("repository_id", "varchar(64)", (c) => c.notNull())
    .addColumn("repository_full_name", "varchar(255)", (c) => c.notNull())
    .addColumn("production_branch", "varchar(255)", (c) => c.notNull())
    .addColumn("production_environment_id", "varchar(255)", (c) => c.notNull())
    .addColumn("previews_enabled", "boolean", (c) => c.notNull())
    .addColumn("preview_limit", "integer", (c) => c.notNull())
    .addColumn("preview_ttl_days", "integer", (c) => c.notNull())
    .addColumn("harbor_project", "varchar(255)", (c) => c.notNull())
    .addColumn("harbor_robot_name", "varchar(255)", (c) => c.notNull())
    .addColumn("harbor_robot_id", "integer")
    .addColumn("harbor_robot_secret_enc", "text", (c) => c.notNull())
    .addColumn("identity_did", "varchar(255)", (c) => c.notNull())
    .addColumn("created_at", "varchar(64)", (c) => c.notNull())
    .addColumn("updated_at", "varchar(64)", (c) => c.notNull())
    .ifNotExists()
    .execute();
  for (const [column, type] of [
    ["harbor_robot_id", "integer"],
    ["identity_expires_at", "varchar(64)"],
    ["owner_org_id", "varchar(255)"],
    ["org_disputed", "boolean"],
  ] as const) {
    try {
      await db.schema.alterTable("apps").addColumn(column, type).execute();
    } catch {
      // Column already exists
    }
  }
  await db.schema
    .createIndex("apps_owner_org_idx")
    .on("apps")
    .column("owner_org_id")
    .ifNotExists()
    .execute();
  await db.schema
    .createIndex("apps_owner_idx")
    .on("apps")
    .column("owner_address")
    .ifNotExists()
    .execute();
  await db.schema
    .createIndex("apps_repository_idx")
    .on("apps")
    .column("repository_id")
    .ifNotExists()
    .execute();

  await db.schema
    .createTable("app_previews")
    .addColumn("app_id", "varchar(64)", (c) => c.notNull())
    .addColumn("pr_number", "integer", (c) => c.notNull())
    .addColumn("environment_id", "varchar(255)", (c) => c.notNull())
    .addColumn("git_ref", "varchar(255)")
    .addColumn("created_at", "varchar(64)", (c) => c.notNull())
    .addColumn("last_deployed_at", "varchar(64)", (c) => c.notNull())
    .addPrimaryKeyConstraint("app_previews_pkey", ["app_id", "pr_number"])
    .ifNotExists()
    .execute();

  await db.schema
    .createTable("app_deployments")
    .addColumn("id", "varchar(64)", (c) => c.primaryKey())
    .addColumn("app_id", "varchar(64)", (c) => c.notNull())
    .addColumn("environment_id", "varchar(255)")
    .addColumn("kind", "varchar(32)", (c) => c.notNull())
    .addColumn("pr_number", "integer")
    .addColumn("git_ref", "varchar(255)", (c) => c.notNull())
    .addColumn("sha", "varchar(64)", (c) => c.notNull())
    .addColumn("packages", "text", (c) => c.notNull())
    .addColumn("image_tag", "varchar(512)")
    .addColumn("status", "varchar(32)", (c) => c.notNull())
    .addColumn("actor_did", "varchar(255)")
    .addColumn("actor_github", "varchar(255)")
    .addColumn("run_url", "varchar(1024)")
    .addColumn("error", "text")
    .addColumn("github_deployment_id", "varchar(64)")
    .addColumn("created_at", "varchar(64)", (c) => c.notNull())
    .addColumn("updated_at", "varchar(64)", (c) => c.notNull())
    .ifNotExists()
    .execute();
  await db.schema
    .createIndex("app_deployments_app_idx")
    .on("app_deployments")
    .columns(["app_id", "created_at"])
    .ifNotExists()
    .execute();
  await db.schema
    .createIndex("app_deployments_status_idx")
    .on("app_deployments")
    .column("status")
    .ifNotExists()
    .execute();

  await db.schema
    .createTable("github_deploy_connections")
    .addColumn("owner_address", "varchar(255)", (c) => c.notNull())
    .addColumn("installation_id", "varchar(64)", (c) => c.notNull())
    .addColumn("account_login", "varchar(255)", (c) => c.notNull())
    .addColumn("account_type", "varchar(64)", (c) => c.notNull())
    .addColumn("created_at", "varchar(64)", (c) => c.notNull())
    .addPrimaryKeyConstraint("github_deploy_connections_pkey", [
      "owner_address",
      "installation_id",
    ])
    .ifNotExists()
    .execute();
  await addConnectionTokenColumns(db);
  await ensureAppsStudioColumn(db);
  await ensureStudioLaunchSecretsTable(db);
  await ensureStudioProductColumns(db);
  await ensureDeploymentTriggerColumns(db);
  await ensureStudioRepositoryColumns(db);
  await ensureExternalChangesColumns(db);
}

/** Name of the partial unique index that makes a Studio launch idempotent. */
export const STUDIO_LAUNCH_KEY_INDEX = "app_deployments_studio_launch_key";

/**
 * Who started a deployment and for whom (D20, Task 2.3): `trigger`
 * (STUDIO_LAUNCH, STUDIO_ROLLBACK, OWNER, CI; null on older rows),
 * `on_behalf_of` (the owner's did:pkh) and the Studio's `version_number`.
 * `pre_apply_packages` (JSON names the env had installed right before a
 * Studio deployment was applied; a restore removes only what it added).
 * Plus the idempotency key of a Studio launch: at most one pending or under
 * way STUDIO_LAUNCH row per (app_id, version_number, sha), so concurrent
 * retries find the same deployment (READY ones are matched by the service
 * only while still live; a later launch of the same version is a new one). Additive and idempotent; schema
 * builder only, so it lands in the namespace schema.
 */
export async function ensureDeploymentTriggerColumns(
  db: Kysely<any>,
): Promise<void> {
  for (const [column, type] of [
    ["trigger", "text"],
    ["on_behalf_of", "text"],
    ["version_number", "integer"],
    ["pre_apply_packages", "text"],
  ] as const) {
    try {
      await db.schema
        .alterTable("app_deployments")
        .addColumn(column, type, (c) => c.ifNotExists())
        .execute();
    } catch (err) {
      // Two boots racing on the same ALTER: the loser sees a duplicate.
      if (!isConcurrentIndexError(err) && !isDuplicateColumnError(err)) throw err;
    }
  }
  await dropStaleLaunchKeyIndex(db);
  try {
    await db.schema
      .createIndex(STUDIO_LAUNCH_KEY_INDEX)
      .ifNotExists()
      .unique()
      .on("app_deployments")
      .columns(["app_id", "version_number", "sha"])
      .where(sql.ref("trigger"), "=", "STUDIO_LAUNCH")
      .where(sql.ref("status"), "in", ["PENDING", "DEPLOYING"])
      .execute();
  } catch (err) {
    if (!isConcurrentIndexError(err)) throw err;
  }
}

/**
 * Studio products without GitHub (Task 2.2): the repository columns become
 * nullable (an App made by ensureStudioProduct has no repository until one is
 * connected), plus the product drive id, the first-launch time and the
 * adoption time of a pre-existing env. Additive and idempotent (DROP NOT NULL
 * on a nullable column is a no-op; ADD COLUMN IF NOT EXISTS); schema builder
 * only, so it lands in the namespace schema. Existing rows are untouched.
 */
export async function ensureStudioProductColumns(
  db: Kysely<any>,
): Promise<void> {
  const tolerate = (err: unknown) => {
    // Two boots racing on the same ALTER: the loser sees a duplicate.
    if (!isConcurrentIndexError(err) && !isDuplicateColumnError(err)) throw err;
  };
  for (const column of [
    "installation_id",
    "repository_id",
    "repository_full_name",
  ]) {
    try {
      await db.schema
        .alterTable("apps")
        .alterColumn(column, (c) => c.dropNotNull())
        .execute();
    } catch (err) {
      tolerate(err);
    }
  }
  for (const column of ["product_drive_id", "launched_at", "adopted_at"]) {
    try {
      await db.schema
        .alterTable("apps")
        .addColumn(column, "text", (c) => c.ifNotExists())
        .execute();
    } catch (err) {
      tolerate(err);
    }
  }
}

/**
 * Studio products on GitHub (Task 4.1): the account the repository was made
 * in (login + type), who connected it, and when GitHub took it away.
 * Additive and idempotent.
 */
export async function ensureStudioRepositoryColumns(
  db: Kysely<any>,
): Promise<void> {
  for (const column of [
    "repository_account_login",
    "repository_account_type",
    "repository_disconnected_at",
    "repository_connected_by",
  ]) {
    try {
      await db.schema
        .alterTable("apps")
        .addColumn(column, "text", (c) => c.ifNotExists())
        .execute();
    } catch (err) {
      if (!isConcurrentIndexError(err) && !isDuplicateColumnError(err)) throw err;
    }
  }
}

/**
 * Pushes made on GitHub (Task 4.2, D15): `apps.external_changes_sha`, the
 * Studio's own mirror shas (`apps.mirror_sha`, `app_deployments.mirror_sha`).
 * Additive and idempotent.
 */
export async function ensureExternalChangesColumns(
  db: Kysely<any>,
): Promise<void> {
  for (const [table, column] of [
    ["apps", "external_changes_sha"],
    ["apps", "mirror_sha"],
    ["app_deployments", "mirror_sha"],
  ] as const) {
    try {
      await db.schema
        .alterTable(table)
        .addColumn(column, "text", (c) => c.ifNotExists())
        .execute();
    } catch (err) {
      if (!isConcurrentIndexError(err) && !isDuplicateColumnError(err)) throw err;
    }
  }
}

/**
 * The first definition of the launch key (never released) also covered READY
 * rows, which blocks launching a version again after a Go back. When the
 * namespace has that definition, drop it so up() recreates it with the
 * in-flight predicate. The schema is the one the namespaced builder
 * qualifies with (current_schema() when unqualified). Concurrent boots:
 * DROP … IF EXISTS, and the recreate tolerates a lost race.
 */
export async function dropStaleLaunchKeyIndex(db: Kysely<any>): Promise<void> {
  const drop = db.schema.dropIndex(STUDIO_LAUNCH_KEY_INDEX).ifExists();
  const qualified = /^drop index if exists "((?:[^"]|"")+)"\./i.exec(
    drop.compile().sql,
  );
  const schema = qualified ? qualified[1].replace(/""/g, '"') : null;
  const found = await sql<{ indexdef: string }>`
    SELECT indexdef FROM pg_indexes
    WHERE indexname = ${STUDIO_LAUNCH_KEY_INDEX}
      AND schemaname = coalesce(${schema}::text, current_schema())`.execute(db);
  const def = found.rows[0]?.indexdef;
  if (!def || !def.includes("'READY'")) return;
  await drop.execute();
}

/** Postgres 42701 (duplicate column). */
function isDuplicateColumnError(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "42701";
}

/**
 * sha256 of each Studio's launch secret (D20), keyed by the Studio env. The
 * secret itself lives only in the Studio's tenant secrets. Also run by the
 * studio pool (subgraph boot order is not fixed). Additive and idempotent;
 * schema builder only, so it lands in the namespace schema.
 */
export async function ensureStudioLaunchSecretsTable(
  db: Kysely<any>,
): Promise<void> {
  try {
    await db.schema
      .createTable("studio_launch_secrets")
      .ifNotExists()
      .addColumn("environment_id", "varchar(255)", (c) => c.primaryKey())
      .addColumn("secret_hash", "varchar(64)", (c) => c.notNull())
      .addColumn("rotated_at", "varchar(64)", (c) => c.notNull())
      .execute();
  } catch (err) {
    // Two boots (vetra-apps and the studio pool, or two replicas) racing on
    // CREATE TABLE IF NOT EXISTS: the loser sees 42P07/23505; the table is there.
    if (!isConcurrentIndexError(err)) throw err;
  }
}

async function addConnectionTokenColumns(db: Kysely<any>): Promise<void> {
  for (const [column, type] of [
    ["user_token_enc", "text"],
    ["user_token_expires_at", "varchar(64)"],
    ["refresh_token_enc", "text"],
    ["refresh_token_expires_at", "varchar(64)"],
  ] as const) {
    try {
      await db.schema
        .alterTable("github_deploy_connections")
        .addColumn(column, type)
        .execute();
    } catch {
      // Column already exists
    }
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const t of [
    "studio_launch_secrets",
    "github_deploy_connections",
    "app_deployments",
    "app_previews",
    "apps",
  ]) {
    await db.schema.dropTable(t).ifExists().execute();
  }
}

/**
 * The organisation column licensing reads from the apps table, added by
 * licensing itself at setup so its first queries do not depend on vetra-apps
 * having migrated first (m4). Idempotent; a missing table is left alone.
 */
export async function ensureAppsOrgColumn(db: Kysely<any>): Promise<void> {
  for (const [column, type] of [
    ["owner_org_id", "varchar(255)"],
    ["org_disputed", "boolean"],
  ] as const) {
    try {
      await db.schema.alterTable("apps").addColumn(column, type).execute();
    } catch {
      // Column already exists, or no apps table yet
    }
  }
}

/**
 * The Studio env an App was created from (null: an imported repo), and at
 * most one live App per Studio. Idempotent.
 */
export async function ensureAppsStudioColumn(db: Kysely<any>): Promise<void> {
  try {
    await db.schema
      .alterTable("apps")
      .addColumn("studio_environment_id", "varchar(255)")
      .execute();
  } catch {
    // Column already exists
  }
  try {
    // Built with the schema builder, not raw SQL: the subgraph's db is
    // withSchema("vetra-apps"), and only builder table refs get qualified.
    await db.schema
      .createIndex("apps_studio_env_live")
      .ifNotExists()
      .unique()
      .on("apps")
      .column("studio_environment_id")
      .where(sql.ref("status"), "<>", "DELETED")
      .where(sql.ref("studio_environment_id"), "is not", null)
      .execute();
  } catch (err) {
    // Another replica booting at the same time won the race to create it.
    if (!isConcurrentIndexError(err)) throw err;
  }
}

/** Postgres 42P07 (duplicate relation) or 23505 (unique violation), as raised when two boots create the same index. */
export function isConcurrentIndexError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "42P07" || code === "23505";
}
