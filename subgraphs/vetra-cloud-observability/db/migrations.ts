import type { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("environment_status")
    .addColumn("tenantId", "varchar(255)")
    .addColumn("argoSyncStatus", "varchar(50)")
    .addColumn("argoHealthStatus", "varchar(50)")
    .addColumn("argoLastSyncedAt", "varchar(255)")
    .addColumn("argoMessage", "text")
    .addColumn("configDriftDetected", "integer")
    .addColumn("tlsCertValid", "integer")
    .addColumn("tlsCertExpiresAt", "varchar(255)")
    .addColumn("domainResolves", "integer")
    .addColumn("updatedAt", "varchar(255)")
    .addPrimaryKeyConstraint("environment_status_pkey", ["tenantId"])
    .ifNotExists()
    .execute();

  await db.schema
    .createTable("environment_pods")
    .addColumn("id", "varchar(512)")
    .addColumn("tenantId", "varchar(255)")
    .addColumn("name", "varchar(255)")
    .addColumn("service", "varchar(50)")
    .addColumn("component", "varchar(64)")
    .addColumn("agent", "varchar(64)")
    .addColumn("phase", "varchar(50)")
    .addColumn("ready", "integer")
    .addColumn("restartCount", "integer")
    .addColumn("updatedAt", "varchar(255)")
    .addPrimaryKeyConstraint("environment_pods_pkey", ["id"])
    .ifNotExists()
    .execute();

  await db.schema
    .createTable("environment_events")
    .addColumn("id", "varchar(255)")
    .addColumn("tenantId", "varchar(255)")
    .addColumn("type", "varchar(50)")
    .addColumn("reason", "varchar(255)")
    .addColumn("message", "text")
    .addColumn("involvedObject", "varchar(255)")
    .addColumn("timestamp", "varchar(255)")
    .addPrimaryKeyConstraint("environment_events_pkey", ["id"])
    .ifNotExists()
    .execute();

  // Latest release per (channel, image). Upserted by notifyNewImageRelease.
  await db.schema
    .createTable("release_index")
    .addColumn("id", "varchar(128)")
    .addColumn("channel", "varchar(32)")
    .addColumn("image", "varchar(64)")
    .addColumn("tag", "varchar(128)")
    .addColumn("publishedAt", "varchar(64)")
    .addColumn("releaseUrl", "text")
    .addPrimaryKeyConstraint("release_index_pkey", ["id"])
    .ifNotExists()
    .execute();

  // Append-only history: one row per SET_SERVICE_VERSION dispatch that this
  // subgraph triggers (auto, manual update-now, rollback).
  await db.schema
    .createTable("release_history")
    .addColumn("id", "varchar(255)")
    .addColumn("documentId", "varchar(255)")
    .addColumn("tenantId", "varchar(255)")
    .addColumn("service", "varchar(32)")
    .addColumn("fromTag", "varchar(128)")
    .addColumn("toTag", "varchar(128)")
    .addColumn("trigger", "varchar(32)")
    .addColumn("channel", "varchar(32)")
    .addColumn("at", "varchar(64)")
    .addColumn("releaseUrl", "text")
    .addPrimaryKeyConstraint("release_history_pkey", ["id"])
    .ifNotExists()
    .execute();

  // Add `component` and `agent` columns to environment_pods if they
  // don't exist yet — in-place upgrade for envs running the older
  // schema. We attempt ADD COLUMN and swallow the duplicate-column
  // error so this stays idempotent across Postgres (production) and
  // SQLite (tests).
  for (const col of ["component", "agent"] as const) {
    try {
      await db.schema
        .alterTable("environment_pods")
        .addColumn(col, "varchar(64)")
        .execute();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Postgres: 'column "component" of relation "environment_pods" already exists'
      // SQLite:   'duplicate column name: component'
      if (!/already exists|duplicate column/i.test(msg)) throw err;
    }
  }

  // Runtime-announced endpoints from clint agents. Upserted on each
  // announcement; rows are keyed by (documentId, prefix, endpointId) so a
  // single env can host N agents (distinguished by prefix), each
  // exposing M endpoints.
  await db.schema
    .createTable("clint_runtime_endpoints")
    .addColumn("id", "varchar(512)")
    .addColumn("documentId", "varchar(255)")
    .addColumn("prefix", "varchar(64)")
    .addColumn("endpointId", "varchar(128)")
    .addColumn("type", "varchar(32)")
    .addColumn("port", "varchar(16)")
    .addColumn("status", "varchar(32)")
    .addColumn("lastSeen", "varchar(64)")
    .addPrimaryKeyConstraint("clint_runtime_endpoints_pkey", ["id"])
    .ifNotExists()
    .execute();

  // On-demand pg_dump exports. One row per dump request. Status flows
  // PENDING -> RUNNING -> READY/FAILED. See vetra.to spec
  // `2026-05-07-environment-database-dump-design.md`.
  await db.schema
    .createTable("database_dumps")
    .addColumn("id", "varchar(64)", (col) => col.primaryKey())
    .addColumn("documentId", "varchar(255)", (col) => col.notNull())
    .addColumn("tenantId", "varchar(255)", (col) => col.notNull())
    .addColumn("requestedBy", "varchar(255)", (col) => col.notNull())
    .addColumn("status", "varchar(32)", (col) => col.notNull())
    .addColumn("jobName", "varchar(255)")
    .addColumn("s3Key", "varchar(512)")
    .addColumn("sizeBytes", "bigint")
    .addColumn("errorMessage", "text")
    .addColumn("requestedAt", "varchar(64)", (col) => col.notNull())
    .addColumn("startedAt", "varchar(64)")
    .addColumn("completedAt", "varchar(64)")
    .addColumn("expiresAt", "varchar(64)", (col) => col.notNull())
    .ifNotExists()
    .execute();

  await db.schema
    .createIndex("database_dumps_tenant_idx")
    .ifNotExists()
    .on("database_dumps")
    .columns(["tenantId", "requestedAt"])
    .execute();

  // Add `source` discriminator to database_dumps (MANUAL | SCHEDULED).
  // Existing rows backfill to MANUAL via the column default. Stays
  // idempotent across Postgres (production) and SQLite (tests) by
  // swallowing the duplicate-column error — same pattern as the
  // environment_pods component/agent columns above.
  try {
    await db.schema
      .alterTable("database_dumps")
      .addColumn("source", "varchar(16)", (col) =>
        col.notNull().defaultTo("MANUAL"),
      )
      .execute();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/already exists|duplicate column/i.test(msg)) throw err;
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("database_dumps").ifExists().execute();
  await db.schema.dropTable("clint_runtime_endpoints").execute();
  await db.schema.dropTable("release_history").execute();
  await db.schema.dropTable("release_index").execute();
  await db.schema.dropTable("environment_events").execute();
  await db.schema.dropTable("environment_pods").execute();
  await db.schema.dropTable("environment_status").execute();
}
