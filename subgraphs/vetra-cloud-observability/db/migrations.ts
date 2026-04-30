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

  // NOTE: CLINT announce tokens are stateless HMAC-SHA256 signatures
  // (see shared/clint-announce-token.ts). No DB table needed.
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("clint_runtime_endpoints").execute();
  await db.schema.dropTable("release_history").execute();
  await db.schema.dropTable("release_index").execute();
  await db.schema.dropTable("environment_events").execute();
  await db.schema.dropTable("environment_pods").execute();
  await db.schema.dropTable("environment_status").execute();
}
