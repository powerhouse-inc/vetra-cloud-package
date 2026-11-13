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
  await ensureReleasesTables(db);
  await ensureAppsRegistryNamespaceColumn(db);
  await ensureRegistryNamespacesTable(db);
  await ensureAppsReleaseBranchesColumn(db);
  await ensureInstancesTable(db);
  await ensureAppsInstancesEnabledColumn(db);
  await ensureInstancesHealthColumns(db);
  await ensureAppSettingsTable(db);
  await ensureInstancesSettingsColumns(db);
  await ensurePlansTable(db);
  await ensureInstancesPlanColumns(db);
  await ensureAppAuditTable(db);
  await ensureAppRolesTable(db);
  await ensureInstanceBackupTables(db);
  await ensureInstanceSettingsTable(db);
  await ensureInstanceDomainColumns(db);
  await ensureSettingsMountPath(db);
  await ensurePlanAiBudget(db);
  await ensureEnvironmentHoldsTable(db);
  await ensureInstanceGateTokensTable(db);
  await ensureWarmPoolColumns(db);
  await ensureRolloutTables(db);
  await ensureRolloutColumns(db);
  await ensureRolloutBackupColumns(db);
  await ensureTeamPlanSchema(db);
  await ensureSwitchoverSchema(db);
}

/** Switch-overs and the instances' switchover_id (plan 9). Schema builder only (namespaced). */
export async function ensureSwitchoverSchema(db: Kysely<any>): Promise<void> {
  try {
    await db.schema
      .createTable("switchovers")
      .ifNotExists()
      .addColumn("id", "varchar(64)", (c) => c.primaryKey())
      .addColumn("app_id", "varchar(255)", (c) => c.notNull())
      .addColumn("environment_id", "varchar(255)", (c) => c.notNull())
      .addColumn("old_tenant", "varchar(255)", (c) => c.notNull())
      .addColumn("old_host", "varchar(255)", (c) => c.notNull())
      .addColumn("licence_root_id", "varchar(255)", (c) => c.notNull())
      .addColumn("holder_address", "varchar(255)", (c) => c.notNull())
      .addColumn("kind", "varchar(255)", (c) => c.notNull())
      .addColumn("plan_id", "varchar(64)", (c) => c.notNull())
      .addColumn("instance_id", "varchar(64)")
      .addColumn("release_version", "varchar(255)", (c) => c.notNull())
      .addColumn("release_digest", "varchar(255)", (c) => c.notNull())
      .addColumn("mode", "varchar(16)", (c) => c.notNull())
      .addColumn("state", "varchar(32)", (c) => c.notNull())
      .addColumn("failed_state", "varchar(32)")
      .addColumn("error", "varchar(500)")
      .addColumn("window_start", "varchar(64)")
      .addColumn("window_end", "varchar(64)")
      .addColumn("step_started_at", "varchar(64)")
      .addColumn("attempts", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("prepare_archive_id", "varchar(255)")
      .addColumn("dump_id", "varchar(255)")
      .addColumn("archive_id", "varchar(255)")
      .addColumn("restore_db_id", "varchar(255)")
      .addColumn("restore_data_id", "varchar(255)")
      .addColumn("key_fingerprints", "text")
      .addColumn("source_counts", "text")
      .addColumn("copy_counts", "text")
      .addColumn("started_counts", "text")
      .addColumn("timings", "text")
      .addColumn("downtime_started_at", "varchar(64)")
      .addColumn("started_at", "varchar(64)")
      .addColumn("confirmed_at", "varchar(64)")
      .addColumn("done_at", "varchar(64)")
      .addColumn("hold_until", "varchar(64)")
      .addColumn("rolled_back_at", "varchar(64)")
      .addColumn("created_by", "varchar(255)", (c) => c.notNull())
      .addColumn("created_at", "varchar(64)", (c) => c.notNull())
      .addColumn("updated_at", "varchar(64)", (c) => c.notNull())
      .execute();
  } catch (err) {
    if (!isConcurrentIndexError(err)) throw err;
  }
  try {
    await db.schema
      .createIndex("switchovers_environment_real_uq")
      .ifNotExists()
      .unique()
      .on("switchovers")
      .column("environment_id")
      .where(sql.ref("mode"), "=", "real")
      .where(sql.ref("state"), "<>", "ROLLED_BACK")
      .execute();
    await db.schema
      .createIndex("switchovers_app_state_idx")
      .ifNotExists()
      .on("switchovers")
      .columns(["app_id", "state"])
      .execute();
  } catch (err) {
    if (!isConcurrentIndexError(err)) throw err;
  }
  try {
    await db.schema
      .alterTable("instances")
      .addColumn("switchover_id", "varchar(64)", (c) => c.ifNotExists())
      .execute();
  } catch (err) {
    if (!isConcurrentIndexError(err) && !isDuplicateColumnError(err)) throw err;
  }
}

/** The Team plan (releases phase 3 slice 6). Schema builder only (namespaced). */
export async function ensureTeamPlanSchema(db: Kysely<any>): Promise<void> {
  const tolerate = (err: unknown) => {
    if (!isConcurrentIndexError(err) && !isDuplicateColumnError(err)) throw err;
  };
  try {
    await db.schema
      .alterTable("plans")
      .addColumn("team", "boolean", (c) => c.ifNotExists())
      .execute();
  } catch (err) {
    tolerate(err);
  }
  // A kind-less plan; DROP NOT NULL on a nullable column is a no-op.
  try {
    await db.schema
      .alterTable("plans")
      .alterColumn("kind", (c) => c.dropNotNull())
      .execute();
  } catch (err) {
    tolerate(err);
  }
  try {
    await db.schema
      .createIndex("plans_app_team_uq")
      .ifNotExists()
      .unique()
      .on("plans")
      .column("app_id")
      .where(sql.ref("team"), "=", true)
      .execute();
  } catch (err) {
    tolerate(err);
  }
  for (const [name, type] of [
    ["admins_override", "text"],
    ["admins_checked_at", "varchar(64)"],
    ["admins_override_org", "varchar(255)"],
  ] as const) {
    try {
      await db.schema
        .alterTable("instances")
        .addColumn(name, type, (c) => c.ifNotExists())
        .execute();
    } catch (err) {
      tolerate(err);
    }
  }
  try {
    await db.schema
      .createTable("team_release_runs")
      .ifNotExists()
      .addColumn("app_id", "varchar(255)", (c) => c.notNull())
      .addColumn("version", "varchar(255)", (c) => c.notNull())
      .addColumn("digest", "varchar(128)", (c) => c.notNull())
      .addColumn("instance_id", "varchar(64)", (c) => c.notNull())
      .addColumn("healthy_since", "varchar(64)", (c) => c.notNull())
      .addColumn("recorded_at", "varchar(64)", (c) => c.notNull())
      .addPrimaryKeyConstraint("team_release_runs_pk", ["app_id", "version"])
      .execute();
  } catch (err) {
    tolerate(err);
  }
}

/** The AI budget of a plan's instances (plan 7 Task 10). */
export async function ensurePlanAiBudget(db: Kysely<any>): Promise<void> {
  try {
    await db.schema
      .alterTable("plans")
      .addColumn("ai_budget_usd", "double precision", (c) => c.ifNotExists())
      .execute();
  } catch (err) {
    if (!isConcurrentIndexError(err) && !isDuplicateColumnError(err)) throw err;
  }
}

/** Publisher file settings (plan 7 Task 9): where a file row is mounted. */
export async function ensureSettingsMountPath(db: Kysely<any>): Promise<void> {
  try {
    await db.schema
      .alterTable("app_settings")
      .addColumn("mount_path", "varchar(512)", (c) => c.ifNotExists())
      .execute();
  } catch (err) {
    if (!isConcurrentIndexError(err) && !isDuplicateColumnError(err)) throw err;
  }
}

/** A holder's custom domain on an own instance (plan 7 Task 7), unique where set. */
export async function ensureInstanceDomainColumns(
  db: Kysely<any>,
): Promise<void> {
  for (const [name, type] of [
    ["custom_domain", "varchar(253)"],
    ["custom_domain_status", "varchar(16)"],
    ["custom_domain_reason", "text"],
    ["custom_domain_since", "varchar(64)"],
    ["custom_domain_checked_at", "varchar(64)"],
    ["custom_domain_failures", "integer"],
    ["custom_domain_token", "varchar(64)"],
  ] as const) {
    try {
      await db.schema
        .alterTable("instances")
        .addColumn(name, type, (c) => c.ifNotExists())
        .execute();
    } catch (err) {
      if (!isConcurrentIndexError(err) && !isDuplicateColumnError(err))
        throw err;
    }
  }
  try {
    await db.schema
      .createIndex("instances_custom_domain_uq")
      .ifNotExists()
      .unique()
      .on("instances")
      .column("custom_domain")
      .where(sql.ref("custom_domain"), "is not", null)
      .execute();
  } catch (err) {
    if (!isConcurrentIndexError(err)) throw err;
  }
}

/** Holder settings per own instance (phase 3 plan 7, spec 14.2). Schema builder only (namespaced). */
export async function ensureInstanceSettingsTable(
  db: Kysely<any>,
): Promise<void> {
  try {
    await db.schema
      .createTable("instance_settings")
      .ifNotExists()
      .addColumn("instance_id", "varchar(64)", (c) => c.notNull())
      .addColumn("name", "varchar(128)", (c) => c.notNull())
      .addColumn("kind", "varchar(16)", (c) => c.notNull())
      .addColumn("mount_path", "varchar(512)")
      .addColumn("value", "text")
      .addColumn("ciphertext", "text")
      .addColumn("write_id", "varchar(64)", (c) => c.notNull())
      .addColumn("updated_at", "varchar(64)", (c) => c.notNull())
      .addColumn("updated_by", "varchar(255)", (c) => c.notNull())
      .addPrimaryKeyConstraint("instance_settings_pk", ["instance_id", "name"])
      .execute();
  } catch (err) {
    if (!isConcurrentIndexError(err)) throw err;
  }
  try {
    await db.schema
      .createIndex("instance_settings_instance_idx")
      .ifNotExists()
      .on("instance_settings")
      .column("instance_id")
      .execute();
  } catch (err) {
    if (!isConcurrentIndexError(err)) throw err;
  }
}

/** Rollouts (releases phase 3 slice 3, spec section 7). Schema builder only (namespaced). */
export async function ensureRolloutTables(db: Kysely<any>): Promise<void> {
  const tolerant = async (run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (err) {
      if (!isConcurrentIndexError(err)) throw err;
    }
  };
  await tolerant(() =>
    db.schema
      .createTable("rollouts")
      .ifNotExists()
      .addColumn("id", "varchar(64)", (c) => c.primaryKey())
      .addColumn("app_id", "varchar(255)", (c) => c.notNull())
      .addColumn("version", "varchar(255)", (c) => c.notNull())
      .addColumn("status", "varchar(16)", (c) => c.notNull())
      .addColumn("direction", "varchar(16)", (c) => c.notNull())
      .addColumn("source", "varchar(16)", (c) => c.notNull())
      .addColumn("started_by", "varchar(255)", (c) => c.notNull())
      .addColumn("started_at", "varchar(64)", (c) => c.notNull())
      .addColumn("notes", "text")
      .addColumn("paused_at", "varchar(64)")
      .addColumn("paused_reason", "text")
      .addColumn("finished_at", "varchar(64)")
      .addColumn("rolled_back_by", "varchar(255)")
      .addColumn("rolled_back_at", "varchar(64)")
      .addColumn("updated_at", "varchar(64)", (c) => c.notNull())
      .execute(),
  );
  await tolerant(() =>
    db.schema
      .createTable("rollout_plans")
      .ifNotExists()
      .addColumn("rollout_id", "varchar(64)", (c) => c.notNull())
      .addColumn("plan_id", "varchar(64)", (c) => c.notNull())
      .addColumn("from_version", "varchar(255)")
      .addColumn("notice_hours", "integer", (c) => c.notNull())
      .addPrimaryKeyConstraint("rollout_plans_pk", ["rollout_id", "plan_id"])
      .execute(),
  );
  await tolerant(() =>
    db.schema
      .createTable("rollout_steps")
      .ifNotExists()
      .addColumn("id", "varchar(64)", (c) => c.primaryKey())
      .addColumn("rollout_id", "varchar(64)", (c) => c.notNull())
      .addColumn("app_id", "varchar(255)", (c) => c.notNull())
      .addColumn("plan_id", "varchar(64)", (c) => c.notNull())
      .addColumn("instance_id", "varchar(64)", (c) => c.notNull())
      .addColumn("instance_kind", "varchar(16)", (c) => c.notNull())
      .addColumn("instance_name", "varchar(255)", (c) => c.notNull())
      .addColumn("position", "integer", (c) => c.notNull())
      .addColumn("from_version", "varchar(255)")
      .addColumn("to_version", "varchar(255)", (c) => c.notNull())
      .addColumn("status", "varchar(16)", (c) => c.notNull())
      .addColumn("due_at", "varchar(64)", (c) => c.notNull())
      .addColumn("requested_at", "varchar(64)")
      .addColumn("started_at", "varchar(64)")
      .addColumn("finished_at", "varchar(64)")
      .addColumn("target_moved", "boolean", (c) => c.notNull())
      .addColumn("attempts", "integer", (c) => c.notNull())
      .addColumn("error", "text")
      .addColumn("note", "text")
      .addColumn("created_at", "varchar(64)", (c) => c.notNull())
      .addColumn("updated_at", "varchar(64)", (c) => c.notNull())
      .addUniqueConstraint("rollout_steps_instance_uq", ["rollout_id", "instance_id"])
      .execute(),
  );
  for (const [name, table, columns] of [
    ["rollouts_app_status_idx", "rollouts", ["app_id", "status"]],
    ["rollout_plans_plan_idx", "rollout_plans", ["plan_id"]],
    ["rollout_steps_rollout_idx", "rollout_steps", ["rollout_id", "position"]],
    ["rollout_steps_instance_idx", "rollout_steps", ["instance_id", "status"]],
  ] as const)
    await tolerant(() =>
      db.schema.createIndex(name).ifNotExists().on(table).columns([...columns]).execute(),
    );
  // One moving instance per App (spec section 7: one instance at a time).
  await tolerant(() =>
    db.schema
      .createIndex("rollout_steps_moving_uq")
      .ifNotExists()
      .unique()
      .on("rollout_steps")
      .column("app_id")
      .where(sql<boolean>`status in ('applying', 'reverting')`)
      .execute(),
  );
}

/** Pinning, withdrawing, plan windows and policy notes (slice 3). Nullable. */
export async function ensureRolloutColumns(db: Kysely<any>): Promise<void> {
  for (const [table, name, type] of [
    ["instances", "pinned_version", "varchar(255)"],
    ["releases", "withdrawn_at", "varchar(64)"],
    ["releases", "withdrawn_by", "varchar(255)"],
    ["releases", "withdrawn_reason", "text"],
    ["plans", "update_window", "text"],
    ["plans", "policy_note", "text"],
  ] as const) {
    try {
      await db.schema
        .alterTable(table)
        .addColumn(name, type, (c) => c.ifNotExists())
        .execute();
    } catch (err) {
      if (!isConcurrentIndexError(err) && !isDuplicateColumnError(err)) throw err;
    }
  }
}

/** Rollout steps that back up first and restore (releases phase 3 slice 4). */
export async function ensureRolloutBackupColumns(db: Kysely<any>): Promise<void> {
  for (const name of ["backup_id", "restore_id"]) {
    try {
      await db.schema
        .alterTable("rollout_steps")
        .addColumn(name, "varchar(64)", (c) => c.ifNotExists())
        .execute();
    } catch (err) {
      if (!isConcurrentIndexError(err) && !isDuplicateColumnError(err)) throw err;
    }
  }
  try {
    // One moving instance per App, now counting backups and restores.
    await db.schema
      .createIndex("rollout_steps_moving_v2_uq")
      .ifNotExists()
      .unique()
      .on("rollout_steps")
      .column("app_id")
      .where(
        sql<boolean>`status in ('backing_up', 'applying', 'restoring', 'reverting')`,
      )
      .execute();
  } catch (err) {
    if (!isConcurrentIndexError(err)) throw err;
  }
  try {
    await db.schema.dropIndex("rollout_steps_moving_uq").ifExists().execute();
  } catch (err) {
    if (!isConcurrentIndexError(err)) throw err;
  }
}

/** Publisher settings per App (releases phase 2 slice 4, spec 14.2). Schema builder only (namespaced). */
export async function ensureAppSettingsTable(db: Kysely<any>): Promise<void> {
  try {
    await db.schema
      .createTable("app_settings")
      .ifNotExists()
      .addColumn("app_id", "varchar(255)", (c) => c.notNull())
      .addColumn("scope", "varchar(16)", (c) => c.notNull())
      .addColumn("name", "varchar(128)", (c) => c.notNull())
      .addColumn("secret", "boolean", (c) => c.notNull())
      .addColumn("value", "text")
      .addColumn("ciphertext", "text")
      .addColumn("write_id", "varchar(64)", (c) => c.notNull())
      .addColumn("updated_at", "varchar(64)", (c) => c.notNull())
      .addColumn("updated_by", "varchar(255)", (c) => c.notNull())
      .addPrimaryKeyConstraint("app_settings_pk", ["app_id", "scope", "name"])
      .execute();
  } catch (err) {
    if (!isConcurrentIndexError(err)) throw err;
  }
}

/** Settings revisions on instances (slice 4). Nullable. */
export async function ensureInstancesSettingsColumns(
  db: Kysely<any>,
): Promise<void> {
  for (const [name, type] of [
    ["target_settings", "varchar(32)"],
    ["running_settings", "varchar(32)"],
    ["failed_settings", "varchar(32)"],
    ["settings_delivered", "varchar(32)"],
    ["settings_delivered_at", "varchar(64)"],
    ["health_settings", "varchar(32)"],
    ["observed_settings", "varchar(32)"],
  ] as const) {
    try {
      await db.schema
        .alterTable("instances")
        .addColumn(name, type, (c) => c.ifNotExists())
        .execute();
    } catch (err) {
      if (!isConcurrentIndexError(err) && !isDuplicateColumnError(err))
        throw err;
    }
  }
}

/** Plans (releases phase 3 slice 1). Schema builder only (namespaced). */
export async function ensurePlansTable(db: Kysely<any>): Promise<void> {
  try {
    await db.schema
      .createTable("plans")
      .ifNotExists()
      .addColumn("id", "varchar(64)", (c) => c.primaryKey())
      .addColumn("app_id", "varchar(255)", (c) => c.notNull())
      .addColumn("slug", "varchar(63)", (c) => c.notNull())
      .addColumn("name", "varchar(255)", (c) => c.notNull())
      .addColumn("kind", "varchar(255)", (c) => c.notNull())
      .addColumn("access", "varchar(16)", (c) => c.notNull())
      .addColumn("size", "varchar(32)", (c) => c.notNull())
      .addColumn("target_version", "varchar(255)")
      .addColumn("policy", "varchar(255)", (c) => c.notNull())
      .addColumn("notice_hours", "integer", (c) => c.notNull())
      .addColumn("status", "varchar(16)", (c) => c.notNull())
      .addColumn("created_by", "varchar(255)", (c) => c.notNull())
      .addColumn("created_at", "varchar(64)", (c) => c.notNull())
      .addColumn("updated_at", "varchar(64)", (c) => c.notNull())
      .addUniqueConstraint("plans_app_slug_uq", ["app_id", "slug"])
      .addUniqueConstraint("plans_app_kind_uq", ["app_id", "kind"])
      .execute();
  } catch (err) {
    if (!isConcurrentIndexError(err)) throw err;
  }
}

/** Plan columns on instances (slice 1). Nullable. */
export async function ensureInstancesPlanColumns(
  db: Kysely<any>,
): Promise<void> {
  for (const [name, type] of [
    ["plan_id", "varchar(64)"],
    ["holder_address", "varchar(255)"],
    ["licence_root_id", "varchar(255)"],
    ["licence_ended_at", "varchar(64)"],
    ["stop_reason", "text"],
    ["stopped_by_vetra", "boolean"],
    ["target_size", "varchar(32)"],
  ] as const) {
    try {
      await db.schema
        .alterTable("instances")
        .addColumn(name, type, (c) => c.ifNotExists())
        .execute();
    } catch (err) {
      if (!isConcurrentIndexError(err) && !isDuplicateColumnError(err))
        throw err;
    }
  }
  try {
    await db.schema
      .createIndex("instances_licence_root_uq")
      .ifNotExists()
      .unique()
      .on("instances")
      .columns(["app_id", "licence_root_id"])
      .where(sql.ref("licence_root_id"), "is not", null)
      .execute();
  } catch (err) {
    if (!isConcurrentIndexError(err)) throw err;
  }
}

/** The audit log (releases phase 3 slice 2, spec section 10). Schema builder only (namespaced). */
export async function ensureAppAuditTable(db: Kysely<any>): Promise<void> {
  try {
    await db.schema
      .createTable("app_audit")
      .ifNotExists()
      .addColumn("id", "varchar(64)", (c) => c.primaryKey())
      .addColumn("app_id", "varchar(255)", (c) => c.notNull())
      .addColumn("at", "varchar(64)", (c) => c.notNull())
      .addColumn("actor", "varchar(255)", (c) => c.notNull())
      .addColumn("source", "varchar(16)", (c) => c.notNull())
      .addColumn("action", "varchar(64)", (c) => c.notNull())
      .addColumn("subject", "varchar(512)", (c) => c.notNull())
      .addColumn("detail", "text", (c) => c.notNull())
      .execute();
  } catch (err) {
    if (!isConcurrentIndexError(err)) throw err;
  }
  for (const [name, columns] of [
    ["app_audit_app_at_idx", ["app_id", "at", "id"]],
    ["app_audit_at_idx", ["at"]],
  ] as const) {
    try {
      await db.schema
        .createIndex(name)
        .ifNotExists()
        .on("app_audit")
        .columns([...columns])
        .execute();
    } catch (err) {
      if (!isConcurrentIndexError(err)) throw err;
    }
  }
}

/** Held environments (plan 9). Schema builder only (namespaced). */
export async function ensureEnvironmentHoldsTable(
  db: Kysely<any>,
): Promise<void> {
  try {
    await db.schema
      .createTable("environment_holds")
      .ifNotExists()
      .addColumn("environment_id", "varchar(255)", (c) => c.primaryKey())
      .addColumn("reason", "varchar(500)", (c) => c.notNull())
      .addColumn("switchover_id", "varchar(64)")
      .addColumn("created_by", "varchar(255)", (c) => c.notNull())
      .addColumn("created_at", "varchar(64)", (c) => c.notNull())
      .execute();
  } catch (err) {
    if (!isConcurrentIndexError(err)) throw err;
  }
}

/** Per-App roles (release managers, releases phase 3 D7). Schema builder only (namespaced). */
export async function ensureAppRolesTable(db: Kysely<any>): Promise<void> {
  try {
    await db.schema
      .createTable("app_roles")
      .ifNotExists()
      .addColumn("app_id", "varchar(255)", (c) => c.notNull())
      .addColumn("address", "varchar(255)", (c) => c.notNull())
      .addColumn("role", "varchar(32)", (c) => c.notNull())
      .addColumn("owner_scope", "varchar(320)", (c) => c.notNull())
      .addColumn("granted_by", "varchar(255)", (c) => c.notNull())
      .addColumn("granted_at", "varchar(64)", (c) => c.notNull())
      .addPrimaryKeyConstraint("app_roles_pk", ["app_id", "address", "role"])
      .execute();
  } catch (err) {
    if (!isConcurrentIndexError(err)) throw err;
  }
}

/** Gate tokens of shared instances (releases phase 3 slice 5). Schema builder only (namespaced). */
export async function ensureInstanceGateTokensTable(
  db: Kysely<any>,
): Promise<void> {
  try {
    await db.schema
      .createTable("instance_gate_tokens")
      .ifNotExists()
      .addColumn("instance_id", "varchar(64)", (c) => c.primaryKey())
      .addColumn("app_id", "varchar(255)", (c) => c.notNull())
      .addColumn("token_hash", "varchar(64)", (c) => c.notNull())
      .addColumn("token_ciphertext", "text", (c) => c.notNull())
      .addColumn("token_id", "varchar(64)", (c) => c.notNull())
      .addColumn("previous_hash", "varchar(64)")
      .addColumn("previous_until", "varchar(64)")
      .addColumn("delivered_at", "varchar(64)")
      .addColumn("created_at", "varchar(64)", (c) => c.notNull())
      .addColumn("rotated_at", "varchar(64)", (c) => c.notNull())
      .execute();
  } catch (err) {
    if (!isConcurrentIndexError(err)) throw err;
  }
  for (const [name, column, unique] of [
    ["instance_gate_tokens_hash_uq", "token_hash", true],
    ["instance_gate_tokens_previous_idx", "previous_hash", false],
  ] as const) {
    try {
      let q = db.schema
        .createIndex(name)
        .ifNotExists()
        .on("instance_gate_tokens")
        .column(column);
      if (unique) q = q.unique();
      await q.execute();
    } catch (err) {
      if (!isConcurrentIndexError(err)) throw err;
    }
  }
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

export async function ensureReleasesTables(db: Kysely<any>): Promise<void> {
  try {
    await db.schema
      .createTable("releases")
      .ifNotExists()
      .addColumn("app_id", "varchar(255)", (c) => c.notNull())
      .addColumn("version", "varchar(255)", (c) => c.notNull())
      .addColumn("kind", "varchar(16)", (c) => c.notNull())
      .addColumn("branch", "varchar(255)")
      .addColumn("pr", "integer")
      .addColumn("run", "bigint", (c) => c.notNull())
      .addColumn("commit", "varchar(64)", (c) => c.notNull())
      .addColumn("notes", "text")
      .addColumn("customer_notes", "text")
      .addColumn("image_ref", "varchar(512)", (c) => c.notNull())
      .addColumn("image_digest", "varchar(128)", (c) => c.notNull())
      .addColumn("host", "varchar(64)", (c) => c.notNull())
      .addColumn("packages", "text", (c) => c.notNull())
      .addColumn("requires", "text", (c) => c.notNull())
      .addColumn("migrates", "boolean", (c) => c.notNull())
      .addColumn("powerhouse_version", "varchar(64)", (c) => c.notNull())
      .addColumn("base_image", "varchar(512)", (c) => c.notNull())
      .addColumn("created_at", "varchar(64)", (c) => c.notNull())
      .addPrimaryKeyConstraint("releases_pk", ["app_id", "version"])
      .execute();
    await db.schema
      .createTable("namespace_push_robots")
      .ifNotExists()
      .addColumn("robot_id", "integer", (c) => c.primaryKey())
      .addColumn("namespace", "varchar(255)", (c) => c.notNull())
      .addColumn("created_at", "varchar(64)", (c) => c.notNull())
      .execute();
  } catch (err) {
    // Two boots racing on CREATE TABLE IF NOT EXISTS (see ensureStudioLaunchSecretsTable).
    if (!isConcurrentIndexError(err)) throw err;
  }
}

export async function ensureAppsRegistryNamespaceColumn(
  db: Kysely<any>,
): Promise<void> {
  try {
    await db.schema
      .alterTable("apps")
      .addColumn("registry_namespace", "varchar(255)", (c) => c.ifNotExists())
      .execute();
  } catch (err) {
    if (!isConcurrentIndexError(err) && !isDuplicateColumnError(err))
      throw err;
  }
}

/**
 * The branches besides the production branch that may publish releases
 * (JSON array of names / patterns, releases/branches.ts). Existing Apps get
 * []. Additive and idempotent.
 */
export async function ensureAppsReleaseBranchesColumn(
  db: Kysely<any>,
): Promise<void> {
  try {
    await db.schema
      .alterTable("apps")
      .addColumn("release_branches", "text", (c) =>
        c.ifNotExists().notNull().defaultTo("[]"),
      )
      .execute();
  } catch (err) {
    if (!isConcurrentIndexError(err) && !isDuplicateColumnError(err))
      throw err;
  }
}

/** Who holds each Harbor namespace (one owner per project name, first claim wins). */
export async function ensureRegistryNamespacesTable(
  db: Kysely<any>,
): Promise<void> {
  try {
    await db.schema
      .createTable("registry_namespaces")
      .ifNotExists()
      .addColumn("namespace", "varchar(255)", (c) => c.primaryKey())
      .addColumn("owner_kind", "varchar(8)", (c) => c.notNull())
      .addColumn("owner_id", "varchar(255)", (c) => c.notNull())
      .addColumn("created_at", "varchar(64)", (c) => c.notNull())
      .execute();
  } catch (err) {
    // Two boots racing on CREATE TABLE IF NOT EXISTS (see ensureStudioLaunchSecretsTable).
    if (!isConcurrentIndexError(err)) throw err;
  }
}

/** Releases phase 2: one row per running instance (branch, preview, …). Schema builder only (namespaced). */
export async function ensureInstancesTable(db: Kysely<any>): Promise<void> {
  try {
    await db.schema
      .createTable("instances")
      .ifNotExists()
      .addColumn("id", "varchar(64)", (c) => c.primaryKey())
      .addColumn("app_id", "varchar(255)", (c) => c.notNull())
      .addColumn("kind", "varchar(16)", (c) => c.notNull())
      .addColumn("name", "varchar(255)", (c) => c.notNull())
      .addColumn("branch", "varchar(255)")
      .addColumn("pr", "integer")
      .addColumn("host", "varchar(63)")
      .addColumn("environment_id", "varchar(255)")
      .addColumn("target_version", "varchar(255)")
      .addColumn("target_digest", "varchar(128)")
      .addColumn("target_repository", "varchar(512)")
      .addColumn("target_ph_host", "varchar(64)")
      .addColumn("target_run", "bigint")
      .addColumn("running_version", "varchar(255)")
      .addColumn("running_digest", "varchar(128)")
      .addColumn("running_repository", "varchar(512)")
      .addColumn("status", "varchar(16)", (c) => c.notNull())
      .addColumn("reason", "text")
      .addColumn("failed_digest", "varchar(128)")
      .addColumn("update_started_at", "varchar(64)")
      .addColumn("removed_at", "varchar(64)")
      .addColumn("removed_reason", "varchar(64)")
      .addColumn("created_at", "varchar(64)", (c) => c.notNull())
      .addColumn("updated_at", "varchar(64)", (c) => c.notNull())
      .addUniqueConstraint("instances_app_kind_name_uq", ["app_id", "kind", "name"])
      .execute();
  } catch (err) {
    if (!isConcurrentIndexError(err)) throw err;
  }
  for (const [name, column] of [
    ["instances_host_uq", "host"],
    ["instances_environment_uq", "environment_id"],
  ] as const) {
    try {
      await db.schema
        .createIndex(name)
        .ifNotExists()
        .unique()
        .on("instances")
        .column(column)
        .where(sql.ref(column), "is not", null)
        .execute();
    } catch (err) {
      if (!isConcurrentIndexError(err)) throw err;
    }
  }
}

/** Per-App opt-in for instances (releases phase 2). Existing Apps: off. */
export async function ensureAppsInstancesEnabledColumn(
  db: Kysely<any>,
): Promise<void> {
  try {
    await db.schema
      .alterTable("apps")
      .addColumn("instances_enabled", "boolean", (c) =>
        c.ifNotExists().notNull().defaultTo(false),
      )
      .execute();
  } catch (err) {
    if (!isConcurrentIndexError(err) && !isDuplicateColumnError(err))
      throw err;
  }
}

/** Instance health (releases phase 2 slice 3, spec 14.7). Nullable, filled by the health monitor. */
export async function ensureInstancesHealthColumns(
  db: Kysely<any>,
): Promise<void> {
  for (const [name, type] of [
    ["health", "varchar(16)"],
    ["health_check", "varchar(16)"],
    ["health_reason", "text"],
    ["health_checked_at", "varchar(64)"],
    ["health_since", "varchar(64)"],
    ["health_digest", "varchar(128)"],
    ["health_restarts", "integer"],
    ["observed_digest", "varchar(128)"],
    ["observed_digest_source", "varchar(16)"],
    ["running_degraded", "boolean"],
  ] as const) {
    try {
      await db.schema
        .alterTable("instances")
        .addColumn(name, type, (c) => c.ifNotExists())
        .execute();
    } catch (err) {
      if (!isConcurrentIndexError(err) && !isDuplicateColumnError(err))
        throw err;
    }
  }
}

/** Instance backups and restores, instances.maintenance (releases phase 3 slice 4). Schema builder only (namespaced). */
export async function ensureInstanceBackupTables(db: Kysely<any>): Promise<void> {
  try {
    await db.schema
      .createTable("instance_backups")
      .ifNotExists()
      .addColumn("id", "varchar(64)", (c) => c.primaryKey())
      .addColumn("app_id", "varchar(255)", (c) => c.notNull())
      .addColumn("instance_id", "varchar(64)", (c) => c.notNull())
      .addColumn("environment_id", "varchar(255)", (c) => c.notNull())
      .addColumn("tenant_id", "varchar(255)", (c) => c.notNull())
      .addColumn("reason", "varchar(16)", (c) => c.notNull())
      .addColumn("version", "varchar(255)")
      .addColumn("digest", "varchar(255)")
      .addColumn("dump_id", "varchar(64)")
      .addColumn("archive_id", "varchar(64)")
      .addColumn("status", "varchar(16)", (c) => c.notNull())
      .addColumn("error", "text")
      .addColumn("size_bytes", "bigint")
      .addColumn("requested_by", "varchar(255)", (c) => c.notNull())
      .addColumn("rollout_step_id", "varchar(64)")
      .addColumn("created_at", "varchar(64)", (c) => c.notNull())
      .addColumn("updated_at", "varchar(64)", (c) => c.notNull())
      .addColumn("finished_at", "varchar(64)")
      .addColumn("expires_at", "varchar(64)", (c) => c.notNull())
      .execute();
  } catch (err) {
    if (!isConcurrentIndexError(err)) throw err;
  }
  try {
    await db.schema
      .createTable("instance_restores")
      .ifNotExists()
      .addColumn("id", "varchar(64)", (c) => c.primaryKey())
      .addColumn("app_id", "varchar(255)", (c) => c.notNull())
      .addColumn("instance_id", "varchar(64)", (c) => c.notNull())
      .addColumn("environment_id", "varchar(255)", (c) => c.notNull())
      .addColumn("tenant_id", "varchar(255)", (c) => c.notNull())
      .addColumn("backup_id", "varchar(64)", (c) => c.notNull())
      .addColumn("safety_backup_id", "varchar(64)")
      .addColumn("purpose", "varchar(16)", (c) => c.notNull())
      .addColumn("then_version", "varchar(255)")
      .addColumn("data", "boolean", (c) => c.notNull())
      .addColumn("status", "varchar(16)", (c) => c.notNull())
      .addColumn("phase_started_at", "varchar(64)", (c) => c.notNull())
      .addColumn("db_job", "varchar(255)")
      .addColumn("data_job", "varchar(255)")
      .addColumn("replicas", "text")
      .addColumn("target_set", "boolean", (c) => c.notNull())
      .addColumn("was_held", "boolean", (c) => c.notNull())
      .addColumn("error", "text")
      .addColumn("held", "boolean", (c) => c.notNull())
      .addColumn("requested_by", "varchar(255)", (c) => c.notNull())
      .addColumn("rollout_step_id", "varchar(64)")
      .addColumn("created_at", "varchar(64)", (c) => c.notNull())
      .addColumn("updated_at", "varchar(64)", (c) => c.notNull())
      .addColumn("finished_at", "varchar(64)")
      .execute();
  } catch (err) {
    if (!isConcurrentIndexError(err)) throw err;
  }
  for (const [name, table, columns] of [
    ["instance_backups_instance_idx", "instance_backups", ["instance_id", "created_at"]],
    ["instance_backups_status_idx", "instance_backups", ["status", "expires_at"]],
    ["instance_restores_instance_idx", "instance_restores", ["instance_id", "created_at"]],
  ] as const) {
    try {
      await db.schema.createIndex(name).ifNotExists().on(table).columns([...columns]).execute();
    } catch (err) {
      if (!isConcurrentIndexError(err)) throw err;
    }
  }
  try {
    // One active restore per instance.
    await db.schema
      .createIndex("instance_restores_active_uq")
      .ifNotExists()
      .unique()
      .on("instance_restores")
      .column("instance_id")
      .where(sql.ref("status"), "not in", ["succeeded", "failed"])
      .execute();
  } catch (err) {
    if (!isConcurrentIndexError(err)) throw err;
  }
  try {
    await db.schema
      .alterTable("instances")
      .addColumn("maintenance", "varchar(255)", (c) => c.ifNotExists())
      .execute();
  } catch (err) {
    if (!isConcurrentIndexError(err) && !isDuplicateColumnError(err)) throw err;
  }
}

/** Warm pools of own plans (releases phase 3 slice 8). Schema builder only (namespaced). */
export async function ensureWarmPoolColumns(db: Kysely<any>): Promise<void> {
  const tolerate = (err: unknown) => {
    if (!isConcurrentIndexError(err) && !isDuplicateColumnError(err)) throw err;
  };
  try {
    await db.schema
      .alterTable("plans")
      .addColumn("warm_pool_size", "integer", (c) => c.ifNotExists())
      .execute();
  } catch (err) {
    tolerate(err);
  }
  for (const [name, type] of [
    ["warm", "boolean"],
    ["claimed_at", "varchar(64)"],
  ] as const) {
    try {
      await db.schema
        .alterTable("instances")
        .addColumn(name, type, (c) => c.ifNotExists())
        .execute();
    } catch (err) {
      tolerate(err);
    }
  }
  try {
    await db.schema
      .createIndex("instances_warm_idx")
      .ifNotExists()
      .on("instances")
      .columns(["app_id", "plan_id"])
      .where(sql.ref("warm"), "=", true)
      .execute();
  } catch (err) {
    tolerate(err);
  }
}
