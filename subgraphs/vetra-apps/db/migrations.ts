import type { Kysely } from "kysely";

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
  try {
    await db.schema
      .alterTable("apps")
      .addColumn("harbor_robot_id", "integer")
      .execute();
  } catch {
    // Column already exists
  }
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
    "github_deploy_connections",
    "app_deployments",
    "app_previews",
    "apps",
  ]) {
    await db.schema.dropTable(t).ifExists().execute();
  }
}
