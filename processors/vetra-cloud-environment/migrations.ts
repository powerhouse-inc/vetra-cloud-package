import type { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("environments")
    .addColumn("id", "varchar(255)")
    .addColumn("name", "varchar(255)")
    .addColumn("subdomain", "varchar(255)")
    .addColumn("tenantId", "varchar(255)")
    .addColumn("customDomain", "varchar(255)")
    .addColumn("packages", "text")
    .addColumn("services", "text")
    .addColumn("status", "varchar(50)")
    .addColumn("deployingSince", "varchar(255)")
    .addColumn("createdBy", "varchar(255)")
    .addPrimaryKeyConstraint("environments_pkey", ["id"])
    .ifNotExists()
    .execute();

  // Migrate from old schema: add columns that may not exist yet
  for (const column of ["subdomain", "tenantId", "customDomain"] as const) {
    try {
      await db.schema
        .alterTable("environments")
        .addColumn(column, "varchar(255)")
        .execute();
    } catch {
      // Column already exists — expected for fresh installs
    }
  }

  // Drop legacy "domain" column if present
  try {
    await db.schema
      .alterTable("environments")
      .dropColumn("domain")
      .execute();
  } catch {
    // Column doesn't exist — expected for fresh installs
  }

  // Add deployingSince column for tracking deployment grace period
  try {
    await db.schema
      .alterTable("environments")
      .addColumn("deployingSince", "varchar(255)")
      .execute();
  } catch {
    // Column already exists — expected for fresh installs
  }

  // Add createdBy column for per-user environment scoping
  // Stores the lowercased EthereumAddress of the user who first signed
  // an action on this document (captured by the processor on first insert).
  try {
    await db.schema
      .alterTable("environments")
      .addColumn("createdBy", "varchar(255)")
      .execute();
  } catch {
    // Column already exists — expected for fresh installs
  }

  // Add owner column — mirrors document state's `owner` field.
  // Populated by the processor from state.owner on each upsert.
  // Used by the `myEnvironments` subgraph resolver for per-user scoping.
  try {
    await db.schema
      .alterTable("environments")
      .addColumn("owner", "varchar(255)")
      .execute();
  } catch {
    // Column already exists — expected for fresh installs
  }

  // Add autoUpdateChannel column — mirrors state's `autoUpdateChannel`.
  // Read by the observability subgraph's notifyNewImageRelease mutation
  // to find envs subscribed to a given release channel.
  try {
    await db.schema
      .alterTable("environments")
      .addColumn("autoUpdateChannel", "varchar(32)")
      .execute();
  } catch {
    // Column already exists — expected for fresh installs
  }

  // CLINT agents now expose endpoints via pull (see
  // docs/superpowers/specs/2026-05-01-clint-endpoints-pull-design.md).
  // Drop the legacy token table if a previous version created it.
  try {
    await db.schema.dropTable("clint_announce_tokens").execute();
  } catch {
    // Table doesn't exist — fresh installs and post-drop no-ops.
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("environments").execute();
}
