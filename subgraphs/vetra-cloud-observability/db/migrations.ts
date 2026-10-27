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

  // Dump source (MANUAL | SCHEDULED | PRE_RESTORE). Pre-existing rows were
  // all owner-requested, so the default backfills them as MANUAL.
  try {
    await db.schema
      .alterTable("database_dumps")
      .addColumn("source", "varchar(32)", (col) => col.notNull().defaultTo("MANUAL"))
      .execute();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/already exists|duplicate column/i.test(msg)) throw err;
  }

  // Owner-triggered restores. See vetra.io
  // `docs/superpowers/specs/2026-10-27-environment-db-restore-design.md`.
  await db.schema
    .createTable("database_restores")
    .addColumn("id", "varchar(64)", (col) => col.primaryKey())
    .addColumn("documentId", "varchar(255)", (col) => col.notNull())
    .addColumn("tenantId", "varchar(255)", (col) => col.notNull())
    .addColumn("dumpId", "varchar(64)", (col) => col.notNull())
    .addColumn("safetyDumpId", "varchar(64)", (col) => col.notNull())
    .addColumn("status", "varchar(32)", (col) => col.notNull())
    .addColumn("jobName", "varchar(255)")
    .addColumn("replicas", "text")
    .addColumn("errorMessage", "text")
    .addColumn("requestedBy", "varchar(255)", (col) => col.notNull())
    .addColumn("requestedAt", "varchar(64)", (col) => col.notNull())
    .addColumn("updatedAt", "varchar(64)", (col) => col.notNull())
    .addColumn("completedAt", "varchar(64)")
    .ifNotExists()
    .execute();

  await db.schema
    .createIndex("database_restores_tenant_idx")
    .ifNotExists()
    .on("database_restores")
    .columns(["tenantId", "requestedAt"])
    .execute();

  // Cached studio product identity (BrandSheet name/maxim/concept), pulled from
  // each awake studio's switchboard by the clint-pull-worker so /user/products
  // shows the real name even when the studio is hibernated.
  await db.schema
    .createTable("studio_brand")
    .addColumn("documentId", "varchar(255)", (col) => col.primaryKey())
    .addColumn("subdomain", "varchar(255)")
    .addColumn("name", "text")
    .addColumn("maxim", "text")
    .addColumn("concept", "text")
    .addColumn("updatedAt", "varchar(255)")
    .ifNotExists()
    .execute();

  // Document permissions Vetra granted for organisation access. Only grants
  // recorded here are ever revoked by the organisation operator sync.
  await db.schema
    .createTable("org_document_grants")
    .addColumn("documentId", "varchar(255)", (c) => c.notNull())
    .addColumn("address", "varchar(255)", (c) => c.notNull())
    .addColumn("level", "varchar(16)", (c) => c.notNull())
    .addColumn("grantedAt", "varchar(64)", (c) => c.notNull())
    .addPrimaryKeyConstraint("org_document_grants_pkey", ["documentId", "address"])
    .ifNotExists()
    .execute();

  // Organisation envs whose protection ownership moved to the Vetra service identity.
  await db.schema
    .createTable("org_document_protection")
    .addColumn("documentId", "varchar(255)", (c) => c.primaryKey())
    .addColumn("orgId", "varchar(255)")
    .addColumn("previousOwner", "varchar(255)")
    .addColumn("transferredAt", "varchar(64)", (c) => c.notNull())
    .ifNotExists()
    .execute();

  // Organisation moves Vetra announced (setEnvironmentOrg & co.); any other move is reverted.
  await db.schema
    .createTable("org_expected_handovers")
    .addColumn("documentId", "varchar(255)", (c) => c.primaryKey())
    .addColumn("orgId", "varchar(255)")
    .addColumn("expiresAt", "varchar(64)", (c) => c.notNull())
    .ifNotExists()
    .execute();

  // The operator list the sync last computed (detects SYNC_ORG_OPERATORS from elsewhere).
  await db.schema
    .createTable("org_env_operators")
    .addColumn("documentId", "varchar(255)", (c) => c.primaryKey())
    .addColumn("operators", "text", (c) => c.notNull())
    .addColumn("computedAt", "varchar(64)", (c) => c.notNull())
    .ifNotExists()
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("org_env_operators").ifExists().execute();
  await db.schema.dropTable("org_expected_handovers").ifExists().execute();
  await db.schema.dropTable("org_document_protection").ifExists().execute();
  await db.schema.dropTable("org_document_grants").ifExists().execute();
  await db.schema.dropTable("studio_brand").ifExists().execute();
  await db.schema.dropTable("database_restores").ifExists().execute();
  await db.schema.dropTable("database_dumps").ifExists().execute();
  await db.schema.dropTable("clint_runtime_endpoints").execute();
  await db.schema.dropTable("release_history").execute();
  await db.schema.dropTable("release_index").execute();
  await db.schema.dropTable("environment_events").execute();
  await db.schema.dropTable("environment_pods").execute();
  await db.schema.dropTable("environment_status").execute();
}
