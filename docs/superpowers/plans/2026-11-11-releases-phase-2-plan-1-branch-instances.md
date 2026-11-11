# Releases phase 2, plan 1: branch instances — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An app published with vetra-publish, once its owner turns `instancesEnabled` on, gets one running instance per release branch (`shop-main.vetra.io`, `shop-next.vetra.io`) that follows that branch's newest build or release, pulled by digest, with a visible status. Nothing else changes.

**Architecture:** A new `instances/` folder in the `vetra-apps` subgraph: pure units (host naming, targets, rendering environment actions, reading status) and one reconciler loop that, every 15 s, computes the wanted branch instances from the `releases` table and drives environment documents through the existing `EnvGateway`. An instance environment is an ordinary environment document linked to its app as a `PREVIEW` (so the processor renders it cheaply: size S, single Postgres without S3 backups, `previews/` gitops root) running the release's host image (`PH_HOST`) with FUSION `version = <version>@<digest>`. The processor's image resolver learns to vouch for instance environments. The old production environment, previews and every licensed environment are untouched.

**Tech Stack:** TypeScript, Kysely (Postgres; PGlite in tests), vitest, the `powerhouse/vetra-cloud-environment` document model (system-signed actions), GraphQL (graphql-tag SDL in `schema.ts`).

**Spec:** `docs/superpowers/specs/2026-11-11-app-releases-and-instances-design.md` (sections 5, 6, 14.13, 18 phase 2). Slice list, gaps and the decisions taken here: `docs/superpowers/plans/2026-11-11-releases-phase-2-overview.md` (gaps 3, 4, 5, 6 are decided in this plan as proposed there).

## Global Constraints

- Instance kinds stored: `branch` (this plan); the column allows `preview`, `shared`, `own` for later plans.
- Status words, exactly: `pending`, `updating`, `ready`, `failed`, `stopped` (plus the internal `removed` tombstone, never shown).
- `ready` (interim, until slice 3): the environment document is `READY` **and** its FUSION version equals the target `<version>@<digest>`.
- A failed create or update leaves the instance on its previous digest: on failure the environment is set back to the running digest; the failed target is not retried until a newer target arrives.
- Instances pull by digest: FUSION `version` = `<version>@<image_digest>`; `fusion.image` = the release's `image_ref` without `:<version>`.
- Targets: branch instances move on every build or release reported from their branch; "newest" = highest `releases.run` (verified GitHub run id, spec 14.17), never arrival order.
- Branch instances exist only for release branches: the production branch and branches matching `releaseBranches` (gap 3).
- Hosts: `<slug>-<name>` as one DNS label on `vetra.io`, sanitized and hashed per gap 4, fallback `-<4 hex of the app id>`, plus `VETRA_APPS_INSTANCE_LABEL_SUFFIX` (staging: `-stg`); stored on the instance and never changed.
- Never write to an environment document that has `managedBy` set, or that is not linked to the instance's app. Never read or write `license_environments`, `app_warm_pool`, artifact channels or `app_deployments`.
- Opt-in: `apps.instances_enabled` defaults to `false`. Kill switch: `VETRA_APPS_INSTANCES=off` stops the loop.
- Additive migrations only (`ensure*` functions, schema builder, idempotent, race-tolerant).
- Commits: one per task, conventional (`feat(instances): …`), trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Work on branch `feat/releases-phase-2-instances`.
- Checks after every task: `npx vitest run <the task's test files>`; at the end `npm run tsc`, `npm run lint`, `npx vitest run subgraphs/vetra-apps processors/vetra-cloud-environment`.

## File structure

| File | Responsibility |
|---|---|
| `subgraphs/vetra-apps/db/schema.ts` | `InstancesTable`, `InstanceKind`, `InstanceStatus`; `AppsTable.instances_enabled` |
| `subgraphs/vetra-apps/db/migrations.ts` | `ensureInstancesTable`, `ensureAppsInstancesEnabledColumn` |
| `subgraphs/vetra-apps/instances/repo.ts` | Kysely reads/writes of `instances` |
| `subgraphs/vetra-apps/instances/host.ts` | `instanceLabel`, `appTag`: the DNS label of an instance |
| `subgraphs/vetra-apps/instances/targets.ts` | `branchTargets`: newest build or release per release branch; `targetOf` |
| `subgraphs/vetra-apps/instances/render.ts` | Environment actions: create, update, the FUSION env |
| `subgraphs/vetra-apps/instances/status.ts` | `observeEnvironment`: what an environment's state means for its instance |
| `subgraphs/vetra-apps/instances/reconciler.ts` | `reconcileInstancesOnce`, `syncBranchInstances`, `markBranchDeleted` |
| `subgraphs/vetra-apps/instances/service.ts` | `appInstancesFor`, `instanceJson` (GraphQL reads) |
| `subgraphs/vetra-apps/config.ts` | `instances: { enabled, labelSuffix }` |
| `subgraphs/vetra-apps/service.ts` | `UpdateAppInput.instancesEnabled` in `updateApp` |
| `subgraphs/vetra-apps/webhook.ts` | branch deletion (push with `deleted: true`) |
| `subgraphs/vetra-apps/schema.ts`, `resolvers.ts` | `AppInstance`, `appInstances`, `App.instancesEnabled`, `UpdateAppInput.instancesEnabled` |
| `subgraphs/vetra-apps/index.ts` | start the loop |
| `processors/vetra-cloud-environment/app-image-project.ts` | vouch for an instance environment's registry namespace |
| Tests | `subgraphs/vetra-apps/__tests__/instances-*.test.ts`, `processors/vetra-cloud-environment/app-image-project.test.ts`, `processors/vetra-cloud-environment/fusion.test.ts` |

---

### Task 0: Pre-flight (needs the user; no code)

Nothing below is merged before these answers exist. Ask the user; record the answers in the PR description.

- [ ] **Step 1: Pull rights.** Ask: does the robot in OpenBao `powerhouse/shared/harbor-credentials` (tenant `imagePullSecrets`) pull from **every** Harbor project (a system robot), or only listed projects? Phase 1 created namespace projects (`<org handle>`, `u-…`, `o-…`) that instance pods pull from. If it is project-scoped, the user extends it (or makes it a system robot with `repository:pull` on all projects) before staging.
- [ ] **Step 2: Gitops and cluster sharing.** Ask: do staging and production switchboards write to the same `powerhouse-k8s-hosting` repo and cluster? If yes, staging must use `VETRA_APPS_INSTANCE_LABEL_SUFFIX: "-stg"` (hosts `shop-main-stg.vetra.io`), so a staging app cannot take a production app's host.
- [ ] **Step 3: A staging test app.** Ask the user to create (or let us create) a GitHub repo with `hosts/cli/Dockerfile` (the local `vetra-publish-canary` repo is a candidate), install the Vetra Deploy App on it, and create the App **on staging first** (Renown binds a repo's CI identity to the first platform that registers it).
- [ ] **Step 4: Timing.** No production pin of vetra-cloud-package between 2026-11-13 17:30 UTC and the Sektar v1.0.9 rollout showing COMPLETE (`vetraReleases.rollouts(appId: "43622402-be06-435a-bbfa-bb649b0d6244")`).

---

### Task 1: The `instances` table and its reads/writes

**Files:**
- Modify: `subgraphs/vetra-apps/db/schema.ts`
- Modify: `subgraphs/vetra-apps/db/migrations.ts` (two `ensure*` functions, called at the end of `up()`)
- Create: `subgraphs/vetra-apps/instances/repo.ts`
- Test: `subgraphs/vetra-apps/__tests__/instances-repo.test.ts`

**Interfaces:**
- Produces: `InstancesTable`, `InstanceKind`, `InstanceStatus` (schema.ts); `AppsTable.instances_enabled?: boolean`; in `instances/repo.ts`: `InstanceRow`, `NewInstance`, `listInstances(db, appId, kind?)`, `insertInstance(db, row)`, `updateInstance(db, id, patch, nowIso)`, `deleteInstance(db, id)`, `isHostUsed(db, host)`.

- [ ] **Step 1: Write the failing test**

```ts
// subgraphs/vetra-apps/__tests__/instances-repo.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHarness, seedActiveApp, type Harness } from "./harness.js";
import { up } from "../db/migrations.js";
import { getApp } from "../repo.js";
import {
  deleteInstance,
  insertInstance,
  isHostUsed,
  listInstances,
  updateInstance,
  type NewInstance,
} from "../instances/repo.js";

let h: Harness;
let appId: string;
beforeEach(async () => {
  h = await makeHarness();
  appId = (await seedActiveApp(h)).id;
});
afterEach(async () => {
  await h.close();
});

const row = (over: Partial<NewInstance> = {}): NewInstance => ({
  id: "i-1",
  app_id: appId,
  kind: "branch",
  name: "main",
  branch: "main",
  pr: null,
  host: "shop-main",
  environment_id: null,
  target_version: "1.5.0-main.3",
  target_digest: `sha256:${"a".repeat(64)}`,
  target_repository: "cr.vetra.io/acme/shop",
  target_ph_host: "cli",
  target_run: 9_000_000_001,
  running_version: null,
  running_digest: null,
  running_repository: null,
  status: "pending",
  reason: null,
  failed_digest: null,
  update_started_at: null,
  removed_at: null,
  removed_reason: null,
  created_at: "2026-11-11T00:00:00.000Z",
  updated_at: "2026-11-11T00:00:00.000Z",
  ...over,
});

describe("instances table", () => {
  it("is created idempotently, with instances_enabled off on existing apps", async () => {
    await up(h.db as never);
    await up(h.db as never);
    expect((await getApp(h.db, appId))!.instances_enabled).toBe(false);
  });

  it("stores, lists, updates and deletes instances; run ids come back as numbers", async () => {
    await insertInstance(h.db, row());
    await insertInstance(h.db, row({ id: "i-2", kind: "preview", name: "pr-4", branch: null, pr: 4, host: "shop-pr-4" }));
    expect((await listInstances(h.db, appId)).map((r) => r.id)).toEqual(["i-1", "i-2"]);
    const [main] = await listInstances(h.db, appId, "branch");
    expect(main.target_run).toBe(9_000_000_001);
    const moved = await updateInstance(h.db, "i-1", { status: "ready" }, "2026-11-11T01:00:00.000Z");
    expect(moved).toMatchObject({ status: "ready", updated_at: "2026-11-11T01:00:00.000Z" });
    await deleteInstance(h.db, "i-2");
    expect(await listInstances(h.db, appId)).toHaveLength(1);
  });

  it("refuses a second instance with the same app, kind and name, or the same host", async () => {
    await insertInstance(h.db, row());
    await expect(insertInstance(h.db, row({ id: "i-2", host: "other" }))).rejects.toThrow();
    await expect(insertInstance(h.db, row({ id: "i-3", name: "next", branch: "next" }))).rejects.toThrow();
    // Several rows may have no host yet.
    await insertInstance(h.db, row({ id: "i-4", name: "a", branch: "a", host: null }));
    await insertInstance(h.db, row({ id: "i-5", name: "b", branch: "b", host: null }));
    expect(await isHostUsed(h.db, "shop-main")).toBe(true);
    expect(await isHostUsed(h.db, "shop-next")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/instances-repo.test.ts`
Expected: FAIL, `Cannot find module '../instances/repo.js'`.

- [ ] **Step 3: Types.** In `subgraphs/vetra-apps/db/schema.ts`, add to `AppsTable` (after `release_branches`):

```ts
  /** Whether the reconciler runs this App's instances (releases phase 2; default false). */
  instances_enabled?: boolean;
```

add `instances: InstancesTable;` to `VetraAppsDB`, and at the end of the file:

```ts
export type InstanceKind = "branch" | "preview" | "shared" | "own";
/** `removed`: a tombstone for a deleted branch (never shown). */
export type InstanceStatus =
  | "pending"
  | "updating"
  | "ready"
  | "failed"
  | "stopped"
  | "removed";

/** One running environment of an App (spec section 5). */
export interface InstancesTable {
  id: string;
  app_id: string;
  kind: InstanceKind;
  /** The branch (branch), `pr-<n>` (preview). Unique per app and kind. */
  name: string;
  branch: string | null;
  pr: number | null;
  /** DNS label: https://<host>.vetra.io. Null until a free one is found. */
  host: string | null;
  environment_id: string | null;
  target_version: string | null;
  target_digest: string | null;
  /** The release's image_ref without its tag. */
  target_repository: string | null;
  /** The release's host (PH_HOST), e.g. cli. */
  target_ph_host: string | null;
  /** releases.run of the target (bigint). */
  target_run: number | null;
  /** The target last seen ready: where a failed update goes back to. */
  running_version: string | null;
  running_digest: string | null;
  running_repository: string | null;
  status: InstanceStatus;
  reason: string | null;
  /** A target that failed; not retried until a newer target arrives. */
  failed_digest: string | null;
  update_started_at: string | null;
  /** Set when the instance is to be removed (the reconciler deletes its environment). */
  removed_at: string | null;
  /** "branch deleted" keeps a tombstone; anything else deletes the row. */
  removed_reason: string | null;
  created_at: string;
  updated_at: string;
}
```

- [ ] **Step 4: Migrations.** In `subgraphs/vetra-apps/db/migrations.ts`, append at the end of `up()` (after `await ensureAppsReleaseBranchesColumn(db);`):

```ts
  await ensureInstancesTable(db);
  await ensureAppsInstancesEnabledColumn(db);
```

and at the end of the file:

```ts
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
```

- [ ] **Step 5: The repo.** Create `subgraphs/vetra-apps/instances/repo.ts`:

```ts
import type { Insertable, Kysely, Selectable, Updateable } from "kysely";
import type {
  InstanceKind,
  InstancesTable,
  VetraAppsDB,
} from "../db/schema.js";

export type InstanceRow = Selectable<InstancesTable>;
export type NewInstance = Insertable<InstancesTable>;
export type InstancePatch = Omit<Updateable<InstancesTable>, "id" | "updated_at">;

/** target_run is bigint (GitHub run ids exceed 32 bits): drivers may return a string. */
function normalize(r: InstanceRow): InstanceRow {
  return { ...r, target_run: r.target_run == null ? null : Number(r.target_run) };
}

export async function listInstances(
  db: Kysely<VetraAppsDB>,
  appId: string,
  kind?: InstanceKind,
): Promise<InstanceRow[]> {
  let q = db.selectFrom("instances").selectAll().where("app_id", "=", appId);
  if (kind) q = q.where("kind", "=", kind);
  const rows = await q.orderBy("created_at", "asc").orderBy("id", "asc").execute();
  return rows.map(normalize);
}

export async function insertInstance(
  db: Kysely<VetraAppsDB>,
  row: NewInstance,
): Promise<InstanceRow> {
  return normalize(
    await db.insertInto("instances").values(row).returningAll().executeTakeFirstOrThrow(),
  );
}

export async function updateInstance(
  db: Kysely<VetraAppsDB>,
  id: string,
  patch: InstancePatch,
  nowIso: string,
): Promise<InstanceRow> {
  return normalize(
    await db
      .updateTable("instances")
      .set({ ...patch, updated_at: nowIso })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow(),
  );
}

export async function deleteInstance(
  db: Kysely<VetraAppsDB>,
  id: string,
): Promise<void> {
  await db.deleteFrom("instances").where("id", "=", id).execute();
}

/** Whether any instance (tombstones included) holds this host label. */
export async function isHostUsed(
  db: Kysely<VetraAppsDB>,
  host: string,
): Promise<boolean> {
  return !!(await db
    .selectFrom("instances")
    .select("id")
    .where("host", "=", host)
    .executeTakeFirst());
}
```

- [ ] **Step 6: Run the test**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/instances-repo.test.ts subgraphs/vetra-apps/__tests__/migrations.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add subgraphs/vetra-apps/db subgraphs/vetra-apps/instances/repo.ts subgraphs/vetra-apps/__tests__/instances-repo.test.ts
git commit -m "feat(instances): instances table and apps.instances_enabled

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Instance host labels

**Files:**
- Create: `subgraphs/vetra-apps/instances/host.ts`
- Test: `subgraphs/vetra-apps/__tests__/instances-host.test.ts`

**Interfaces:**
- Produces: `instanceLabel(slug: string, name: string, suffix?: string): string` (throws `InstanceHostError` when it cannot fit 63 chars); `appTag(appId: string): string` (4 hex); `class InstanceHostError extends Error`.

- [ ] **Step 1: Write the failing test**

```ts
// subgraphs/vetra-apps/__tests__/instances-host.test.ts
import { describe, expect, it } from "vitest";
import { appTag, instanceLabel, InstanceHostError } from "../instances/host.js";

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

describe("instanceLabel", () => {
  it("joins slug and a clean name", () => {
    expect(instanceLabel("shop", "main")).toBe("shop-main");
    expect(instanceLabel("shop", "next")).toBe("shop-next");
    expect(instanceLabel("shop", "main", "-stg")).toBe("shop-main-stg");
  });

  it("sanitizes names and adds a hash of the original when it had to", () => {
    const a = instanceLabel("shop", "release/1.x");
    const b = instanceLabel("shop", "release-1-x");
    expect(a).toMatch(/^shop-release-1-x-[0-9a-f]{6}$/);
    expect(b).toBe("shop-release-1-x");
    expect(a).not.toBe(b);
    expect(instanceLabel("shop", "Feature")).toMatch(/^shop-feature-[0-9a-f]{6}$/);
  });

  it("truncates long names to one DNS label, with a hash", () => {
    const long = "a".repeat(80);
    const label = instanceLabel("shop", long, "-stg");
    expect(label.length).toBeLessThanOrEqual(63);
    expect(label).toMatch(LABEL);
    expect(label.endsWith("-stg")).toBe(true);
    expect(label).not.toBe(instanceLabel("shop", `${long}b`, "-stg"));
  });

  it("refuses when the slug leaves no room", () => {
    expect(() => instanceLabel("s".repeat(60), "main")).toThrow(InstanceHostError);
  });

  it("is ambiguous across apps (the reconciler checks and falls back to appTag)", () => {
    expect(instanceLabel("a", "b-c")).toBe(instanceLabel("a-b", "c"));
    expect(appTag("app-1")).toMatch(/^[0-9a-f]{4}$/);
    expect(instanceLabel("a", "b-c", `-${appTag("app-1")}`)).not.toBe(
      instanceLabel("a-b", "c", `-${appTag("app-2")}`),
    );
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/instances-host.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** `subgraphs/vetra-apps/instances/host.ts`:

```ts
import { createHash } from "node:crypto";

const MAX_LABEL = 63;
const HASH = 6;

export class InstanceHostError extends Error {
  override name = "InstanceHostError";
}

const hex = (s: string, n: number) =>
  createHash("sha1").update(s).digest("hex").slice(0, n);

/** 4 hex of the app id: the fallback that tells two apps' equal labels apart. */
export function appTag(appId: string): string {
  return hex(appId, 4);
}

/**
 * The DNS label of an instance: `<slug>-<name><suffix>` (spec section 5,
 * overview gap 4). A name that is not already lowercase alphanumerics and
 * single dashes is sanitized and gets `-<6 hex of sha1(name)>`, so
 * `release/1.x` and `release-1-x` stay apart; a name too long for one label
 * is truncated and hashed the same way.
 */
export function instanceLabel(slug: string, name: string, suffix = ""): string {
  // Room for "<part>" after "<slug>-" and before the suffix.
  const room = MAX_LABEL - slug.length - 1 - suffix.length;
  if (room < HASH + 2)
    throw new InstanceHostError(
      `No host for ${slug}/${name}: the app slug leaves no room in a DNS label`,
    );
  let part = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  let hashed = part !== name || part.length === 0;
  if (part.length + (hashed ? HASH + 1 : 0) > room) {
    hashed = true;
    part = part.slice(0, room - HASH - 1).replace(/-+$/, "");
  }
  // slug + "-" + part + "-" + hash + suffix is at most 63 characters by construction.
  return [slug, part, hashed ? hex(name, HASH) : ""].filter(Boolean).join("-") + suffix;
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/instances-host.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add subgraphs/vetra-apps/instances/host.ts subgraphs/vetra-apps/__tests__/instances-host.test.ts
git commit -m "feat(instances): instance host labels

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Targets — the newest build or release of each release branch

**Files:**
- Create: `subgraphs/vetra-apps/instances/targets.ts`
- Test: `subgraphs/vetra-apps/__tests__/instances-targets.test.ts`
- Create: `subgraphs/vetra-apps/__tests__/instances-fixtures.ts` (shared by Tasks 3, 6, 7, 8)

**Interfaces:**
- Consumes: `insertRelease`, `ReleaseRow` (`releases/repo.ts`); `isReleaseBranch`, `parseReleaseBranches` (`releases/branches.ts`).
- Produces: `branchTargets(db, app): Promise<Map<string, ReleaseRow>>`; `type InstanceTarget = Pick<InstanceRow, "target_version" | "target_digest" | "target_repository" | "target_ph_host" | "target_run">`; `targetOf(release: ReleaseRow): InstanceTarget`; fixture `seedRelease(h, appId, over)` and `digest(c: string)`.

- [ ] **Step 1: Shared fixture.** Create `subgraphs/vetra-apps/__tests__/instances-fixtures.ts`:

```ts
import { insertRelease, type ReleaseRow } from "../releases/repo.js";
import { getApp } from "../repo.js";
import type { Harness } from "./harness.js";

export const digest = (c: string) => `sha256:${c.repeat(64)}`;

/** A recorded build or release of the app, as ciReportRelease stores it. */
export async function seedRelease(
  h: Harness,
  appId: string,
  over: {
    version: string;
    run: number;
    branch?: string | null;
    pr?: number | null;
    kind?: "build" | "release";
    digest?: string;
  },
): Promise<ReleaseRow> {
  const app = (await getApp(h.db, appId))!;
  const { row } = await insertRelease(h.db, {
    app_id: appId,
    version: over.version,
    kind: over.kind ?? "build",
    branch: over.pr != null ? null : (over.branch ?? "main"),
    pr: over.pr ?? null,
    run: over.run,
    commit: "abcdef1234567",
    notes: null,
    customer_notes: null,
    image_ref: `cr.vetra.io/acme/${app.slug}:${over.version}`,
    image_digest: over.digest ?? digest("a"),
    host: "cli",
    packages: "[]",
    requires: "{}",
    migrates: false,
    powerhouse_version: "6.2.3",
    base_image: "node:24@sha256:00",
    created_at: "2026-11-11T00:00:00.000Z",
  });
  return row;
}
```

- [ ] **Step 2: Write the failing test**

```ts
// subgraphs/vetra-apps/__tests__/instances-targets.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHarness, seedActiveApp, type Harness } from "./harness.js";
import { digest, seedRelease } from "./instances-fixtures.js";
import { getApp } from "../repo.js";
import { branchTargets, targetOf } from "../instances/targets.js";

let h: Harness;
let appId: string;
beforeEach(async () => {
  h = await makeHarness();
  appId = (await seedActiveApp(h)).id;
  await h.db
    .updateTable("apps")
    .set({ release_branches: JSON.stringify(["next", "*.x"]) })
    .where("id", "=", appId)
    .execute();
});
afterEach(async () => {
  await h.close();
});
const app = async () => (await getApp(h.db, appId))!;

describe("branchTargets", () => {
  it("picks the highest run per release branch, builds and releases alike", async () => {
    await seedRelease(h, appId, { version: "1.5.0-main.1", run: 100 });
    await seedRelease(h, appId, { version: "1.5.0", run: 300, kind: "release", digest: digest("b") });
    // Arrived last but ran earlier: not the newest (spec 14.17).
    await seedRelease(h, appId, { version: "1.5.0-main.2", run: 200 });
    await seedRelease(h, appId, { version: "2.0.0-beta.0-next.1", run: 150, branch: "next" });
    await seedRelease(h, appId, { version: "1.4.1", run: 120, branch: "1.x", kind: "release" });
    const t = await branchTargets(h.db, await app());
    expect([...t.keys()].sort()).toEqual(["1.x", "main", "next"]);
    expect(t.get("main")!.version).toBe("1.5.0");
    expect(t.get("next")!.version).toBe("2.0.0-beta.0-next.1");
  });

  it("ignores PR builds and branches that are not release branches", async () => {
    await seedRelease(h, appId, { version: "1.5.0-pr.4.1", run: 500, pr: 4 });
    await seedRelease(h, appId, { version: "1.5.0-feat-x.1", run: 501, branch: "feat/x" });
    expect((await branchTargets(h.db, await app())).size).toBe(0);
  });

  it("follows a changed production branch", async () => {
    await seedRelease(h, appId, { version: "1.0.0-trunk.1", run: 10, branch: "trunk" });
    await h.db.updateTable("apps").set({ production_branch: "trunk" }).where("id", "=", appId).execute();
    expect([...(await branchTargets(h.db, await app())).keys()]).toEqual(["trunk"]);
  });
});

describe("targetOf", () => {
  it("pins the digest and strips the tag from the image ref", async () => {
    const r = await seedRelease(h, appId, { version: "1.5.0-main.1", run: 100 });
    expect(targetOf(r)).toEqual({
      target_version: "1.5.0-main.1",
      target_digest: digest("a"),
      target_repository: `cr.vetra.io/acme/${(await app()).slug}`,
      target_ph_host: "cli",
      target_run: 100,
    });
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/instances-targets.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement** `subgraphs/vetra-apps/instances/targets.ts`:

```ts
import type { Kysely } from "kysely";
import type { VetraAppsDB } from "../db/schema.js";
import type { AppRow } from "../repo.js";
import type { ReleaseRow } from "../releases/repo.js";
import { isReleaseBranch, parseReleaseBranches } from "../releases/branches.js";
import type { InstanceRow } from "./repo.js";

export type InstanceTarget = Pick<
  InstanceRow,
  "target_version" | "target_digest" | "target_repository" | "target_ph_host" | "target_run"
>;

/**
 * The newest build or release (highest verified run id, spec 14.17) of each
 * release branch that has one: the production branch and the branches
 * matching releaseBranches (overview gap 3). PR builds are not branch targets.
 */
export async function branchTargets(
  db: Kysely<VetraAppsDB>,
  app: Pick<AppRow, "id" | "production_branch" | "release_branches">,
): Promise<Map<string, ReleaseRow>> {
  const rows = await db
    .selectFrom("releases")
    .selectAll()
    .distinctOn("branch")
    .where("app_id", "=", app.id)
    .where("pr", "is", null)
    .where("branch", "is not", null)
    .orderBy("branch")
    .orderBy("run", "desc")
    .execute();
  const patterns = parseReleaseBranches(app.release_branches);
  const out = new Map<string, ReleaseRow>();
  for (const r of rows) {
    const branch = r.branch!;
    if (!isReleaseBranch(branch, app.production_branch, patterns)) continue;
    out.set(branch, { ...r, run: Number(r.run) });
  }
  return out;
}

/** What an instance runs for this release: pinned by digest (spec: POST ci/registry-token). */
export function targetOf(r: ReleaseRow): InstanceTarget {
  const suffix = `:${r.version}`;
  if (!r.image_ref.endsWith(suffix))
    throw new Error(`release ${r.version}: image ref ${r.image_ref} is not tagged ${r.version}`);
  return {
    target_version: r.version,
    target_digest: r.image_digest,
    target_repository: r.image_ref.slice(0, -suffix.length),
    target_ph_host: r.host,
    target_run: Number(r.run),
  };
}
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/instances-targets.test.ts`
Expected: PASS. (If PGlite rejects `DISTINCT ON` with this order, fall back to selecting all non-PR rows ordered by `run desc` and keeping the first per branch; the test stays the same.)

- [ ] **Step 6: Commit**

```bash
git add subgraphs/vetra-apps/instances/targets.ts subgraphs/vetra-apps/__tests__/instances-targets.test.ts subgraphs/vetra-apps/__tests__/instances-fixtures.ts
git commit -m "feat(instances): newest build or release per release branch

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Rendering environment actions, and the chart accepting a digest

**Files:**
- Create: `subgraphs/vetra-apps/instances/render.ts`
- Test: `subgraphs/vetra-apps/__tests__/instances-render.test.ts`
- Test: `processors/vetra-cloud-environment/fusion.test.ts` (one new case)

**Interfaces:**
- Produces:
  - `interface InstanceImage { repository: string; tag: string; phHost: string }`
  - `imageTag(version: string, digest: string): string` → `` `${version}@${digest}` ``
  - `fusionEnv(image: InstanceImage, admins: string): { name: string; value: string | null; isSecret: boolean }[]`
  - `interface CreateInstanceInput { label: string; host: string; baseDomain: string; registry: string; owner: string; ownerOrgId: string | null; appId: string; gitRef: string; imageProject: string; image: InstanceImage; admins: string }`
  - `instanceCreateActions(i: CreateInstanceInput): Action[]` (without APPROVE)
  - `instanceUpdateActions(state: VetraCloudEnvironmentState, image: InstanceImage, admins: string): Action[]` (`[]` = nothing to do; without APPROVE)

- [ ] **Step 1: Write the failing test** (drives the real reducer through `FakeEnvs`)

```ts
// subgraphs/vetra-apps/__tests__/instances-render.test.ts
import { describe, expect, it } from "vitest";
import { approveChanges } from "../../../document-models/vetra-cloud-environment/v1/gen/creators.js";
import { FakeEnvs } from "./harness.js";
import {
  imageTag,
  instanceCreateActions,
  instanceUpdateActions,
  type InstanceImage,
} from "../instances/render.js";

const D1 = `sha256:${"a".repeat(64)}`;
const D2 = `sha256:${"b".repeat(64)}`;
const image = (tag = imageTag("1.5.0-main.1", D1)): InstanceImage => ({
  repository: "cr.vetra.io/acme/shop",
  tag,
  phHost: "cli",
});
const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

async function created(envs: FakeEnvs) {
  const id = await envs.create();
  await envs.execute(id, [
    ...instanceCreateActions({
      label: "Shop · main",
      host: "shop-main",
      baseDomain: "vetra.io",
      registry: "https://registry.dev.vetra.io",
      owner: OWNER,
      ownerOrgId: null,
      appId: "app-1",
      gitRef: "refs/heads/main",
      imageProject: "acme",
      image: image(),
      admins: OWNER,
    }),
    approveChanges({}),
  ]);
  return id;
}

describe("instanceCreateActions", () => {
  it("makes a host-image environment linked to the app, pinned by digest", async () => {
    const envs = new FakeEnvs();
    const s = (await envs.getState(await created(envs)))!;
    expect(s.status).toBe("CHANGES_APPROVED");
    expect(s.genericSubdomain).toBe("shop-main");
    expect(s.owner).toBe(OWNER);
    expect(s.app).toMatchObject({ appId: "app-1", role: "PREVIEW", prNumber: null, gitRef: "refs/heads/main" });
    expect(s.apexService).toBe("FUSION");
    expect(s.services.filter((x) => x.enabled).map((x) => x.type)).toEqual(["FUSION"]);
    expect(s.services[0].version).toBe(`1.5.0-main.1@${D1}`);
    expect(s.fusion).toMatchObject({ image: "cr.vetra.io/acme/shop", autoUpdate: false });
    expect(s.fusion!.env).toEqual([
      { name: "PH_HOST", value: "cli", isSecret: false },
      { name: "ADMINS", value: OWNER, isSecret: false },
    ]);
  });
});

describe("instanceUpdateActions", () => {
  it("is empty when the environment already runs the image", async () => {
    const envs = new FakeEnvs();
    const s = (await envs.getState(await created(envs)))!;
    expect(instanceUpdateActions(s, image(), OWNER)).toEqual([]);
  });

  it("moves the version only, then needs an approval", async () => {
    const envs = new FakeEnvs();
    const id = await created(envs);
    envs.setStatus(id, "READY");
    const next = image(imageTag("1.5.0-main.2", D2));
    const actions = instanceUpdateActions((await envs.getState(id))!, next, OWNER);
    expect(actions.map((a) => a.type)).toEqual(["SET_SERVICE_VERSION"]);
    const after = await envs.execute(id, actions);
    expect(after.status).toBe("CHANGES_PENDING");
    expect(after.services[0].version).toBe(`1.5.0-main.2@${D2}`);
  });

  it("wakes a stopped environment before changing it", async () => {
    const envs = new FakeEnvs();
    const id = await created(envs);
    envs.setStatus(id, "STOPPED");
    const actions = instanceUpdateActions((await envs.getState(id))!, image(imageTag("1.5.0-main.2", D2)), OWNER);
    expect(actions.map((a) => a.type)).toEqual(["WAKE_ENVIRONMENT", "SET_SERVICE_VERSION"]);
    expect((await envs.execute(id, actions)).status).toBe("CHANGES_PENDING");
  });

  it("rewrites the FUSION config when the repository or ADMINS changed", async () => {
    const envs = new FakeEnvs();
    const id = await created(envs);
    envs.setStatus(id, "READY");
    const moved = { ...image(), repository: "cr.vetra.io/new-org/shop" };
    expect(
      instanceUpdateActions((await envs.getState(id))!, moved, "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb").map((a) => a.type),
    ).toEqual(["SET_FUSION_CONFIG"]);
  });
});
```

- [ ] **Step 2: Add the chart case** to `processors/vetra-cloud-environment/fusion.test.ts`, inside `describe("generateValuesYaml — FUSION host image (PH_HOST)", …)` (it already has a `hostState(env)` helper; the image project `achra` is allowlisted there):

```ts
  it("renders a digest-pinned tag as given (instances pull by digest)", async () => {
    const pinned = `1.5.0-main.1@sha256:${"a".repeat(64)}`;
    const state = hostState([]);
    state.services = state.services.map((s) =>
      s.type === "FUSION" ? { ...s, version: pinned } : s,
    );
    const app = appBlock(await render(state));
    expect(app).toContain("  enabled: true");
    expect(app).toContain(`    tag: "${pinned}"`);
  });
```

The chart renders `image: "{{ repository }}:{{ tag }}"`, so the pod pulls `cr.vetra.io/<ns>/<app>:<version>@sha256:…`; Kubernetes resolves a `name:tag@digest` reference by its digest. This is checked for real on staging (Task 10).

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/instances-render.test.ts processors/vetra-cloud-environment/fusion.test.ts`
Expected: instances-render FAIL (module not found); the fusion case PASSES already (no code change needed: it pins the behaviour).

- [ ] **Step 4: Implement** `subgraphs/vetra-apps/instances/render.ts`:

```ts
import type { Action } from "document-model";
import {
  enableService,
  initialize,
  setApexService,
  setAppLink,
  setFusionConfig,
  setLabel,
  setOwner,
  setOwnerOrg,
  setServiceVersion,
  wakeEnvironment,
} from "../../../document-models/vetra-cloud-environment/v1/gen/creators.js";
import type { VetraCloudEnvironmentState } from "../../../document-models/vetra-cloud-environment/index.js";

/** What an instance runs: repository (no tag), `<version>@<digest>`, and its host (PH_HOST). */
export interface InstanceImage {
  repository: string;
  tag: string;
  phHost: string;
}

export const imageTag = (version: string, digest: string) => `${version}@${digest}`;

type FusionEnvEntry = { name: string; value: string | null; isSecret: boolean };

/** The settings Vetra sets on every instance in this slice (spec section 5; slice 4 adds the rest). */
export function fusionEnv(image: InstanceImage, admins: string): FusionEnvEntry[] {
  return [
    { name: "PH_HOST", value: image.phHost, isSecret: false },
    { name: "ADMINS", value: admins, isSecret: false },
  ];
}

export interface CreateInstanceInput {
  label: string;
  /** The DNS label (genericSubdomain); the host image is served at its apex. */
  host: string;
  baseDomain: string;
  registry: string;
  owner: string;
  ownerOrgId: string | null;
  appId: string;
  gitRef: string;
  imageProject: string;
  image: InstanceImage;
  admins: string;
}

/**
 * A new instance environment. Linked as the App's PREVIEW: the processor
 * renders it as a cheap dev environment (size S, one Postgres without S3
 * backups, no kept /data; overview gaps 5 and 6). APPROVE is sent separately.
 */
export function instanceCreateActions(i: CreateInstanceInput): Action[] {
  return [
    setLabel({ label: i.label }),
    initialize({
      genericSubdomain: i.host,
      genericBaseDomain: i.baseDomain,
      defaultPackageRegistry: i.registry,
    }),
    setOwner({ address: i.owner }),
    ...(i.ownerOrgId ? [setOwnerOrg({ ownerOrgId: i.ownerOrgId, operators: [] })] : []),
    setAppLink({
      appId: i.appId,
      role: "PREVIEW",
      prNumber: null,
      gitRef: i.gitRef,
      imageProject: i.imageProject,
    }),
    enableService({ type: "FUSION", prefix: "fusion" }),
    setApexService({ type: "FUSION" }),
    setFusionConfig({
      image: i.image.repository,
      env: fusionEnv(i.image, i.admins),
      autoUpdate: false,
      autoUpdateTagPattern: null,
    }),
    setServiceVersion({ type: "FUSION", version: i.image.tag }),
  ];
}

const sameEnv = (state: VetraCloudEnvironmentState, want: FusionEnvEntry[]) =>
  JSON.stringify(
    (state.fusion?.env ?? []).map((e) => ({
      name: e.name,
      value: e.value ?? null,
      isSecret: e.isSecret ?? false,
    })),
  ) === JSON.stringify(want);

/** The actions that bring an existing instance environment to `image`; [] when it already runs it. */
export function instanceUpdateActions(
  state: VetraCloudEnvironmentState,
  image: InstanceImage,
  admins: string,
): Action[] {
  const fusion = state.services.find((s) => s.type === "FUSION");
  const env = fusionEnv(image, admins);
  const changes: Action[] = [];
  if (!fusion?.enabled) changes.push(enableService({ type: "FUSION", prefix: "fusion" }));
  if (
    state.fusion?.image !== image.repository ||
    state.fusion?.autoUpdate ||
    !sameEnv(state, env)
  ) {
    changes.push(
      setFusionConfig({
        image: image.repository,
        env,
        autoUpdate: false,
        autoUpdateTagPattern: null,
      }),
    );
  }
  if (fusion?.version !== image.tag)
    changes.push(setServiceVersion({ type: "FUSION", version: image.tag }));
  if (changes.length === 0) return [];
  // STOPPED ignores changes (no CHANGES_PENDING): wake first.
  return state.status === "STOPPED" ? [wakeEnvironment({}), ...changes] : changes;
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/instances-render.test.ts processors/vetra-cloud-environment/fusion.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add subgraphs/vetra-apps/instances/render.ts subgraphs/vetra-apps/__tests__/instances-render.test.ts processors/vetra-cloud-environment/fusion.test.ts
git commit -m "feat(instances): environment actions for a digest-pinned host image

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Reading an environment's status

**Files:**
- Create: `subgraphs/vetra-apps/instances/status.ts`
- Test: `subgraphs/vetra-apps/__tests__/instances-status.test.ts`

**Interfaces:**
- Produces: `UPDATE_TIMEOUT_MS = 20 * 60 * 1000`; `type Observation = { kind: "ready" } | { kind: "updating" } | { kind: "stopped" } | { kind: "failed"; reason: string }`; `observeEnvironment(state, targetTag: string, updateStartedAt: string | null, now: Date): Observation`.

- [ ] **Step 1: Write the failing test**

```ts
// subgraphs/vetra-apps/__tests__/instances-status.test.ts
import { describe, expect, it } from "vitest";
import type { VetraCloudEnvironmentState } from "../../../document-models/vetra-cloud-environment/index.js";
import { observeEnvironment, UPDATE_TIMEOUT_MS } from "../instances/status.js";

const TAG = `1.5.0@sha256:${"a".repeat(64)}`;
const state = (status: string, version: string | null = TAG) =>
  ({
    status,
    services: [{ type: "FUSION", enabled: true, version }],
  }) as unknown as VetraCloudEnvironmentState;
const now = new Date("2026-11-11T12:00:00.000Z");
const started = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString();

describe("observeEnvironment", () => {
  it("is ready only when READY on the target tag", () => {
    expect(observeEnvironment(state("READY"), TAG, null, now)).toEqual({ kind: "ready" });
    expect(observeEnvironment(state("READY", "1.4.0@sha256:x"), TAG, null, now)).toEqual({ kind: "updating" });
  });

  it("is updating while the deploy pipeline runs, failed after the timeout", () => {
    for (const s of ["CHANGES_PENDING", "CHANGES_APPROVED", "CHANGES_PUSHED", "DEPLOYING"])
      expect(observeEnvironment(state(s), TAG, started(60_000), now)).toEqual({ kind: "updating" });
    expect(observeEnvironment(state("DEPLOYING"), TAG, started(UPDATE_TIMEOUT_MS + 1), now)).toEqual({
      kind: "failed",
      reason: "not ready after 20 minutes",
    });
  });

  it("reports a failed deployment, a stopped and a terminated environment", () => {
    expect(observeEnvironment(state("DEPLOYMENt_FAILED"), TAG, null, now)).toEqual({
      kind: "failed",
      reason: "the deployment failed",
    });
    expect(observeEnvironment(state("STOPPED"), TAG, null, now)).toEqual({ kind: "stopped" });
    expect(observeEnvironment(state("TERMINATING"), TAG, null, now)).toEqual({
      kind: "failed",
      reason: "the environment is TERMINATING",
    });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/instances-status.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** `subgraphs/vetra-apps/instances/status.ts`:

```ts
import type { VetraCloudEnvironmentState } from "../../../document-models/vetra-cloud-environment/index.js";

/** A host runs its migrations before it serves: allow minutes. */
export const UPDATE_TIMEOUT_MS = 20 * 60 * 1000;

export type Observation =
  | { kind: "ready" }
  | { kind: "updating" }
  | { kind: "stopped" }
  | { kind: "failed"; reason: string };

const GONE = new Set(["TERMINATING", "DESTROYED", "ARCHIVED"]);

/**
 * What the environment's state says about its instance. Interim health
 * (until releases phase 2 slice 3): READY and running the target tag
 * (`<version>@<digest>`), spec section 6 step 3.
 */
export function observeEnvironment(
  state: VetraCloudEnvironmentState,
  targetTag: string,
  updateStartedAt: string | null,
  now: Date,
): Observation {
  if (state.status === "STOPPED") return { kind: "stopped" };
  if (GONE.has(state.status))
    return { kind: "failed", reason: `the environment is ${state.status}` };
  const version = state.services.find((s) => s.type === "FUSION")?.version ?? null;
  if (version === targetTag) {
    if (state.status === "READY") return { kind: "ready" };
    if (state.status === "DEPLOYMENt_FAILED")
      return { kind: "failed", reason: "the deployment failed" };
  }
  if (
    updateStartedAt &&
    now.getTime() - Date.parse(updateStartedAt) > UPDATE_TIMEOUT_MS
  )
    return { kind: "failed", reason: "not ready after 20 minutes" };
  return { kind: "updating" };
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/instances-status.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add subgraphs/vetra-apps/instances/status.ts subgraphs/vetra-apps/__tests__/instances-status.test.ts
git commit -m "feat(instances): read instance status from the environment

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Config — kill switch and host suffix

**Files:**
- Modify: `subgraphs/vetra-apps/config.ts`
- Modify: `subgraphs/vetra-apps/__tests__/harness.ts` (`testConfig`)
- Test: `subgraphs/vetra-apps/__tests__/config.test.ts` (new cases)

**Interfaces:**
- Produces: `VetraAppsConfig.instances: { enabled: boolean; labelSuffix: string }`.

- [ ] **Step 1: Write the failing test** (append to `subgraphs/vetra-apps/__tests__/config.test.ts`; it already imports `loadAppsConfig`):

```ts
describe("instances config", () => {
  it("is on with no suffix by default", () => {
    expect(loadAppsConfig({}).instances).toEqual({ enabled: true, labelSuffix: "" });
  });
  it("turns off with VETRA_APPS_INSTANCES=off", () => {
    expect(loadAppsConfig({ VETRA_APPS_INSTANCES: "off" }).instances.enabled).toBe(false);
  });
  it("takes a label suffix such as -stg", () => {
    expect(loadAppsConfig({ VETRA_APPS_INSTANCE_LABEL_SUFFIX: "-stg" }).instances).toEqual({
      enabled: true,
      labelSuffix: "-stg",
    });
  });
  it("turns instances off on an invalid suffix rather than risk a production host", () => {
    expect(loadAppsConfig({ VETRA_APPS_INSTANCE_LABEL_SUFFIX: ".staging" }).instances.enabled).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/config.test.ts`
Expected: FAIL (`instances` undefined).

- [ ] **Step 3: Implement.** In `VetraAppsConfig` (config.ts) add:

```ts
  /**
   * Releases phase 2 instances. enabled=false (VETRA_APPS_INSTANCES=off)
   * stops the reconciler. labelSuffix (VETRA_APPS_INSTANCE_LABEL_SUFFIX,
   * e.g. "-stg") ends every instance host, so staging and production never
   * claim the same <slug>-<name>.vetra.io.
   */
  instances: { enabled: boolean; labelSuffix: string };
```

add before `loadAppsConfig`:

```ts
function instancesConfig(env: Env): VetraAppsConfig["instances"] {
  const suffix = trimmed(env.VETRA_APPS_INSTANCE_LABEL_SUFFIX) ?? "";
  if (suffix && !/^-[a-z0-9]{1,8}$/.test(suffix)) {
    console.warn(
      "[vetra-apps] VETRA_APPS_INSTANCE_LABEL_SUFFIX must look like -stg (dash, 1-8 lowercase alphanumerics); instances are off",
    );
    return { enabled: false, labelSuffix: "" };
  }
  return {
    enabled: trimmed(env.VETRA_APPS_INSTANCES) !== "off",
    labelSuffix: suffix,
  };
}
```

and in the returned object of `loadAppsConfig`: `instances: instancesConfig(env),`. In `harness.ts` `testConfig`, add `instances: { enabled: true, labelSuffix: "" },` before `...over`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add subgraphs/vetra-apps/config.ts subgraphs/vetra-apps/__tests__/config.test.ts subgraphs/vetra-apps/__tests__/harness.ts
git commit -m "feat(instances): kill switch and staging host suffix

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The reconciler

**Files:**
- Create: `subgraphs/vetra-apps/instances/reconciler.ts`
- Test: `subgraphs/vetra-apps/__tests__/instances-reconciler.test.ts`

**Interfaces:**
- Consumes: Tasks 1–6; `AppsDeps` (`service.ts`); `getApp`, `normalizeApp`, `hasCiIdentity`, `AppRow` (`repo.ts`); `withKeyLock` (`shared/key-lock.ts`); `expectOrgHandover` (`subgraphs/vetra-cloud-observability/env-protection.ts`); `approveChanges` (creators); `notConfigured` (`errors.ts`).
- Produces: `INSTANCE_BASE_DOMAIN = "vetra.io"`; `BRANCH_DELETED = "branch deleted"`; `reconcileInstancesOnce(deps): Promise<void>`; `syncBranchInstances(deps, app): Promise<void>`; `reconcileInstance(deps, app, row): Promise<void>`; `markBranchDeleted(deps, repositoryId: string, branch: string): Promise<number>`.

- [ ] **Step 1: Write the failing test**

```ts
// subgraphs/vetra-apps/__tests__/instances-reconciler.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHarness, OWNER, REPO_ID, seedActiveApp, type Harness } from "./harness.js";
import { digest, seedRelease } from "./instances-fixtures.js";
import { listInstances } from "../instances/repo.js";
import {
  markBranchDeleted,
  reconcileInstancesOnce,
} from "../instances/reconciler.js";
import { UPDATE_TIMEOUT_MS } from "../instances/status.js";

let h: Harness;
let appId: string;
let slug: string;
beforeEach(async () => {
  h = await makeHarness();
  const app = await seedActiveApp(h);
  appId = app.id;
  slug = app.slug;
  await h.db
    .updateTable("apps")
    .set({ instances_enabled: true, registry_namespace: "acme", release_branches: '["next"]' })
    .where("id", "=", appId)
    .execute();
});
afterEach(async () => {
  await h.close();
});

const instances = () => listInstances(h.db, appId);
const one = async () => (await instances())[0];
const fusionVersion = async (envId: string) =>
  (await h.envs.getState(envId))!.services.find((s) => s.type === "FUSION")!.version;

describe("reconcileInstancesOnce — branch instances", () => {
  it("does nothing for an app that has not opted in", async () => {
    await h.db.updateTable("apps").set({ instances_enabled: false }).where("id", "=", appId).execute();
    await seedRelease(h, appId, { version: "1.5.0-main.1", run: 100 });
    await reconcileInstancesOnce(h.deps);
    expect(await instances()).toEqual([]);
    expect(h.envs.docs.size).toBe(0);
  });

  it("creates one instance per release branch, pinned by digest, then reports ready", async () => {
    await seedRelease(h, appId, { version: "1.5.0-main.1", run: 100 });
    await reconcileInstancesOnce(h.deps);
    const row = await one();
    expect(row).toMatchObject({
      kind: "branch",
      name: "main",
      host: `${slug}-main`,
      status: "updating",
      target_version: "1.5.0-main.1",
    });
    const state = (await h.envs.getState(row.environment_id!))!;
    expect(state.status).toBe("CHANGES_APPROVED");
    expect(await fusionVersion(row.environment_id!)).toBe(`1.5.0-main.1@${digest("a")}`);
    expect(state.fusion!.image).toBe(`cr.vetra.io/acme/${slug}`);

    h.envs.setStatus(row.environment_id!, "READY");
    await reconcileInstancesOnce(h.deps);
    expect(await one()).toMatchObject({ status: "ready", running_version: "1.5.0-main.1", running_digest: digest("a") });
  });

  it("follows the branch's newest build", async () => {
    await seedRelease(h, appId, { version: "1.5.0-main.1", run: 100 });
    await reconcileInstancesOnce(h.deps);
    h.envs.setStatus((await one()).environment_id!, "READY");
    await reconcileInstancesOnce(h.deps);

    await seedRelease(h, appId, { version: "1.5.0-main.2", run: 200, digest: digest("b") });
    await reconcileInstancesOnce(h.deps);
    const row = await one();
    expect(row).toMatchObject({ status: "updating", target_version: "1.5.0-main.2" });
    expect(await fusionVersion(row.environment_id!)).toBe(`1.5.0-main.2@${digest("b")}`);
  });

  it("goes back to the running digest when an update fails, and does not retry it", async () => {
    await seedRelease(h, appId, { version: "1.5.0-main.1", run: 100 });
    await reconcileInstancesOnce(h.deps);
    const envId = (await one()).environment_id!;
    h.envs.setStatus(envId, "READY");
    await reconcileInstancesOnce(h.deps);

    await seedRelease(h, appId, { version: "1.5.0-main.2", run: 200, digest: digest("b") });
    await reconcileInstancesOnce(h.deps);
    h.envs.setStatus(envId, "DEPLOYMENt_FAILED");
    await reconcileInstancesOnce(h.deps);
    expect(await one()).toMatchObject({
      status: "failed",
      reason: "the deployment failed",
      failed_digest: digest("b"),
      running_digest: digest("a"),
    });
    expect(await fusionVersion(envId)).toBe(`1.5.0-main.1@${digest("a")}`);

    h.envs.setStatus(envId, "READY");
    await reconcileInstancesOnce(h.deps);
    expect(await fusionVersion(envId)).toBe(`1.5.0-main.1@${digest("a")}`);
    expect((await one()).status).toBe("failed");

    // A newer build is tried again.
    await seedRelease(h, appId, { version: "1.5.0-main.3", run: 300, digest: digest("c") });
    await reconcileInstancesOnce(h.deps);
    expect(await one()).toMatchObject({ status: "updating", target_version: "1.5.0-main.3" });
  });

  it("fails an update that never gets ready", async () => {
    await seedRelease(h, appId, { version: "1.5.0-main.1", run: 100 });
    await reconcileInstancesOnce(h.deps);
    h.advance(UPDATE_TIMEOUT_MS + 1000);
    await reconcileInstancesOnce(h.deps);
    expect(await one()).toMatchObject({ status: "failed", reason: "not ready after 20 minutes" });
  });

  it("shows a slept environment as stopped and wakes it for a new target", async () => {
    await seedRelease(h, appId, { version: "1.5.0-main.1", run: 100 });
    await reconcileInstancesOnce(h.deps);
    const envId = (await one()).environment_id!;
    h.envs.setStatus(envId, "STOPPED");
    await reconcileInstancesOnce(h.deps);
    expect((await one()).status).toBe("stopped");
    await seedRelease(h, appId, { version: "1.5.0-main.2", run: 200, digest: digest("b") });
    await reconcileInstancesOnce(h.deps);
    expect((await h.envs.getState(envId))!.status).toBe("CHANGES_APPROVED");
  });

  it("recreates an environment that was deleted out of band", async () => {
    await seedRelease(h, appId, { version: "1.5.0-main.1", run: 100 });
    await reconcileInstancesOnce(h.deps);
    const first = (await one()).environment_id!;
    await h.envs.delete(first);
    await reconcileInstancesOnce(h.deps);
    expect(await one()).toMatchObject({ environment_id: null, status: "pending" });
    await reconcileInstancesOnce(h.deps);
    const second = (await one()).environment_id!;
    expect(second).not.toBe(first);
    expect((await one()).host).toBe(`${slug}-main`);
  });

  it("never writes to an environment a licence manages", async () => {
    await seedRelease(h, appId, { version: "1.5.0-main.1", run: 100 });
    await reconcileInstancesOnce(h.deps);
    const envId = (await one()).environment_id!;
    await h.envs.manage(envId);
    const before = h.envs.executed.length;
    await seedRelease(h, appId, { version: "1.5.0-main.2", run: 200, digest: digest("b") });
    await reconcileInstancesOnce(h.deps);
    expect(h.envs.executed.length).toBe(before);
    expect((await one()).status).toBe("failed");
  });

  it("removes the instance when its branch stops being a release branch", async () => {
    await seedRelease(h, appId, { version: "2.0.0-beta.0-next.1", run: 100, branch: "next" });
    await reconcileInstancesOnce(h.deps);
    const envId = (await one()).environment_id!;
    await h.db.updateTable("apps").set({ release_branches: "[]" }).where("id", "=", appId).execute();
    await reconcileInstancesOnce(h.deps);
    await reconcileInstancesOnce(h.deps);
    expect(h.envs.deleted).toContain(envId);
    expect(await instances()).toEqual([]);
  });

  it("removes every instance when the app opts out", async () => {
    await seedRelease(h, appId, { version: "1.5.0-main.1", run: 100 });
    await reconcileInstancesOnce(h.deps);
    await h.db.updateTable("apps").set({ instances_enabled: false }).where("id", "=", appId).execute();
    await reconcileInstancesOnce(h.deps);
    await reconcileInstancesOnce(h.deps);
    expect(await instances()).toEqual([]);
    expect(h.envs.deleted).toHaveLength(1);
  });

  it("keeps a deleted branch removed until a newer build comes from it", async () => {
    await seedRelease(h, appId, { version: "2.0.0-beta.0-next.1", run: 100, branch: "next" });
    await reconcileInstancesOnce(h.deps);
    expect(await markBranchDeleted(h.deps, REPO_ID, "next")).toBe(1);
    await reconcileInstancesOnce(h.deps);
    await reconcileInstancesOnce(h.deps);
    expect(await one()).toMatchObject({ status: "removed", environment_id: null });
    expect(h.envs.docs.size).toBe(0);

    await seedRelease(h, appId, { version: "2.0.0-beta.0-next.2", run: 200, branch: "next", digest: digest("b") });
    await reconcileInstancesOnce(h.deps);
    await reconcileInstancesOnce(h.deps);
    expect(await one()).toMatchObject({ status: "updating", host: `${slug}-next` });
  });

  it("falls back to an app-tagged host when the label is taken", async () => {
    h.deps.subdomainTaken = async (s) => s === `${slug}-main`;
    await seedRelease(h, appId, { version: "1.5.0-main.1", run: 100 });
    await reconcileInstancesOnce(h.deps);
    expect((await one()).host).toMatch(new RegExp(`^${slug}-main-[0-9a-f]{4}$`));
  });

  it("owns the environment as the app's owner, with the owner as ADMINS", async () => {
    await seedRelease(h, appId, { version: "1.5.0-main.1", run: 100 });
    await reconcileInstancesOnce(h.deps);
    const s = (await h.envs.getState((await one()).environment_id!))!;
    expect(s.owner).toBe(OWNER);
    expect(s.fusion!.env.find((e) => e.name === "ADMINS")!.value).toBe(OWNER);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/instances-reconciler.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** `subgraphs/vetra-apps/instances/reconciler.ts`:

```ts
import type { Action } from "document-model";
import { approveChanges } from "../../../document-models/vetra-cloud-environment/v1/gen/creators.js";
import type { VetraCloudEnvironmentState } from "../../../document-models/vetra-cloud-environment/index.js";
import { withKeyLock } from "../../../shared/key-lock.js";
import { expectOrgHandover } from "../../vetra-cloud-observability/env-protection.js";
import { notConfigured } from "../errors.js";
import { hasCiIdentity, normalizeApp, type AppRow } from "../repo.js";
import type { ReleaseRow } from "../releases/repo.js";
import type { AppsDeps } from "../service.js";
import { appTag, instanceLabel, InstanceHostError } from "./host.js";
import {
  instanceCreateActions,
  instanceUpdateActions,
  imageTag,
  type InstanceImage,
} from "./render.js";
import {
  deleteInstance,
  insertInstance,
  isHostUsed,
  listInstances,
  updateInstance,
  type InstancePatch,
  type InstanceRow,
} from "./repo.js";
import { observeEnvironment } from "./status.js";
import { branchTargets, targetOf } from "./targets.js";

export const INSTANCE_BASE_DOMAIN = "vetra.io";
/** removed_reason that keeps a tombstone (the branch may come back with newer builds). */
export const BRANCH_DELETED = "branch deleted";
const NOT_WANTED = "no longer wanted";

/** One pass over every App with instances (opted in, or with rows left to remove). */
export async function reconcileInstancesOnce(deps: AppsDeps): Promise<void> {
  const apps = await deps.db
    .selectFrom("apps")
    .selectAll()
    .where((eb) =>
      eb.or([
        eb("instances_enabled", "=", true),
        eb("id", "in", eb.selectFrom("instances").select("app_id")),
      ]),
    )
    .execute();
  for (const raw of apps) {
    const app = normalizeApp(raw);
    try {
      await withKeyLock(`instances:${app.id}`, () => reconcileApp(deps, app));
    } catch (err) {
      deps.logger.warn(`[vetra-apps] instances of ${app.slug}: ${String(err)}`);
    }
  }
}

async function reconcileApp(deps: AppsDeps, app: AppRow): Promise<void> {
  await syncBranchInstances(deps, app);
  for (const row of await listInstances(deps.db, app.id)) {
    try {
      await reconcileInstance(deps, app, row);
    } catch (err) {
      deps.logger.warn(`[vetra-apps] instance ${app.slug}/${row.name}: ${String(err)}`);
      await patch(deps, row, { reason: String(err instanceof Error ? err.message : err).slice(0, 500) });
    }
  }
}

function wantsInstances(app: AppRow): boolean {
  return !!app.instances_enabled && app.status !== "DELETED" && hasCiIdentity(app);
}

const patch = (deps: AppsDeps, row: InstanceRow, p: InstancePatch) =>
  updateInstance(deps.db, row.id, p, deps.now().toISOString());

/** Rows for the wanted branch instances; targets moved; unwanted ones marked for removal. */
export async function syncBranchInstances(deps: AppsDeps, app: AppRow): Promise<void> {
  const wanted: Map<string, ReleaseRow> = wantsInstances(app)
    ? await branchTargets(deps.db, app)
    : new Map();
  const rows = await listInstances(deps.db, app.id, "branch");
  const nowIso = deps.now().toISOString();
  for (const [branch, release] of wanted) {
    const target = targetOf(release);
    const row = rows.find((r) => r.name === branch);
    if (!row) {
      await insertInstance(deps.db, {
        id: deps.newId(),
        app_id: app.id,
        kind: "branch",
        name: branch,
        branch,
        pr: null,
        host: null,
        environment_id: null,
        ...target,
        running_version: null,
        running_digest: null,
        running_repository: null,
        status: "pending",
        reason: null,
        failed_digest: null,
        update_started_at: null,
        removed_at: null,
        removed_reason: null,
        created_at: nowIso,
        updated_at: nowIso,
      });
      continue;
    }
    if (row.removed_at) {
      // A deleted branch comes back only with a build newer than its last target.
      if (row.removed_reason === BRANCH_DELETED && row.status === "removed" && target.target_run! > (row.target_run ?? 0))
        await patch(deps, row, { ...target, removed_at: null, removed_reason: null, status: "pending", reason: null });
      continue;
    }
    if (row.target_digest !== target.target_digest || row.target_version !== target.target_version || row.target_repository !== target.target_repository)
      await patch(deps, row, target);
  }
  for (const row of rows) {
    if (!wanted.has(row.name) && !row.removed_at)
      await patch(deps, row, { removed_at: nowIso, removed_reason: NOT_WANTED });
  }
}

function targetImage(row: InstanceRow): InstanceImage {
  return {
    repository: row.target_repository!,
    tag: imageTag(row.target_version!, row.target_digest!),
    phHost: row.target_ph_host!,
  };
}

/** Writes to an environment only when it is this App's and no licence's (overview rule 1). */
function ours(state: VetraCloudEnvironmentState, row: InstanceRow): boolean {
  return !state.managedBy && state.app?.appId === row.app_id;
}

async function apply(deps: AppsDeps, envId: string, actions: Action[]): Promise<void> {
  const after = await deps.envs.execute(envId, actions);
  // Content first, APPROVE in its own call: a rejected action never ships half a batch.
  if (after.status === "CHANGES_PENDING" || after.status === "DRAFT")
    await deps.envs.execute(envId, [approveChanges({})]);
}

export async function reconcileInstance(deps: AppsDeps, app: AppRow, row: InstanceRow): Promise<void> {
  if (row.removed_at) return removeInstance(deps, row);
  if (!row.target_digest) return;
  if (!row.environment_id) return createEnvironment(deps, app, row);

  const state = await deps.envs.getState(row.environment_id);
  if (!state || state.status === "DRAFT") {
    // Gone, or a create that never got past its first batch: start over.
    if (state) await deps.envs.delete(row.environment_id);
    return void (await patch(deps, row, { environment_id: null, status: "pending", reason: "recreating the environment" }));
  }
  if (!ours(state, row))
    return void (await patch(deps, row, { status: "failed", reason: "the environment is not this App's instance any more; Vetra leaves it alone" }));
  if (row.failed_digest === row.target_digest) return;

  const image = targetImage(row);
  const updates = instanceUpdateActions(state, image, app.owner_address);
  if (updates.length > 0) {
    await apply(deps, row.environment_id, updates);
    return void (await patch(deps, row, { status: "updating", reason: null, update_started_at: deps.now().toISOString() }));
  }

  const seen = observeEnvironment(state, image.tag, row.update_started_at, deps.now());
  if (seen.kind === "ready") {
    if (row.status !== "ready" || row.running_digest !== row.target_digest)
      await patch(deps, row, {
        status: "ready",
        reason: null,
        running_version: row.target_version,
        running_digest: row.target_digest,
        running_repository: row.target_repository,
      });
    return;
  }
  if (seen.kind === "stopped" || seen.kind === "updating") {
    if (row.status !== seen.kind) await patch(deps, row, { status: seen.kind, reason: null });
    return;
  }
  // Failed: keep the target from being retried, and go back to what ran (spec section 6).
  await patch(deps, row, { status: "failed", reason: seen.reason, failed_digest: row.target_digest });
  if (row.running_digest && row.running_digest !== row.target_digest) {
    const back: InstanceImage = {
      repository: row.running_repository!,
      tag: imageTag(row.running_version!, row.running_digest),
      phHost: row.target_ph_host!,
    };
    const revert = instanceUpdateActions(state, back, app.owner_address);
    if (revert.length > 0) await apply(deps, row.environment_id, revert);
  }
}

async function pickHost(deps: AppsDeps, app: AppRow, row: InstanceRow): Promise<string | null> {
  const suffix = deps.cfg.instances.labelSuffix;
  let candidates: string[];
  try {
    candidates = [
      instanceLabel(app.slug, row.name, suffix),
      instanceLabel(app.slug, row.name, `-${appTag(app.id)}${suffix}`),
    ];
  } catch (err) {
    if (err instanceof InstanceHostError) return null;
    throw err;
  }
  for (const c of candidates) {
    if (await isHostUsed(deps.db, c)) continue;
    if (await deps.subdomainTaken?.(c)) continue;
    return c;
  }
  return null;
}

async function createEnvironment(deps: AppsDeps, app: AppRow, row: InstanceRow): Promise<void> {
  const host = row.host ?? (await pickHost(deps, app, row));
  if (!host)
    return void (await patch(deps, row, { status: "failed", reason: `no free host for ${app.slug}-${row.name}` }));
  if (app.owner_org_id && !deps.orgHandoverDb) throw notConfigured("The organisation hand-over store");
  if (!app.registry_namespace) throw new Error("the App has no registry namespace yet");
  const envId = await deps.envs.create();
  // Recorded before any action: a crash leaves a DRAFT document the next pass deletes.
  await patch(deps, row, {
    host,
    environment_id: envId,
    status: "updating",
    reason: null,
    update_started_at: deps.now().toISOString(),
  });
  if (app.owner_org_id) await expectOrgHandover(deps.orgHandoverDb!, envId, app.owner_org_id, deps.now());
  await apply(
    deps,
    envId,
    instanceCreateActions({
      label: `${app.name} · ${row.name}`,
      host,
      baseDomain: INSTANCE_BASE_DOMAIN,
      registry: deps.cfg.previewRegistry,
      owner: app.owner_address,
      ownerOrgId: app.owner_org_id,
      appId: app.id,
      gitRef: `refs/heads/${row.branch}`,
      imageProject: app.registry_namespace,
      image: targetImage(row),
      admins: app.owner_address,
    }),
  );
}

async function removeInstance(deps: AppsDeps, row: InstanceRow): Promise<void> {
  if (row.status === "removed") return;
  if (row.environment_id) {
    const state = await deps.envs.getState(row.environment_id);
    if (state && ours(state, row)) await deps.envs.delete(row.environment_id);
  }
  if (row.removed_reason === BRANCH_DELETED)
    await patch(deps, row, { environment_id: null, status: "removed", reason: BRANCH_DELETED });
  else await deleteInstance(deps.db, row.id);
}

/** A branch was deleted on GitHub: its instance goes (spec section 5). Returns how many were marked. */
export async function markBranchDeleted(
  deps: AppsDeps,
  repositoryId: string,
  branch: string,
): Promise<number> {
  const rows = await deps.db
    .selectFrom("instances")
    .innerJoin("apps", "apps.id", "instances.app_id")
    .select("instances.id")
    .where("apps.repository_id", "=", repositoryId)
    .where("instances.kind", "=", "branch")
    .where("instances.name", "=", branch)
    .where("instances.removed_at", "is", null)
    .execute();
  const nowIso = deps.now().toISOString();
  for (const r of rows)
    await updateInstance(deps.db, r.id, { removed_at: nowIso, removed_reason: BRANCH_DELETED }, nowIso);
  return rows.length;
}
```

Note for the implementer: `apply` reads the state `execute` returns. When the create batch ends in `CHANGES_PENDING` (it does: `INITIALIZE` gives `CHANGES_APPROVED`, every later action moves it to `CHANGES_PENDING`), the separate `APPROVE_CHANGES` follows. If `seedActiveApp` returns an object without `slug`, read the row with `getApp(h.db, id)` in the test's `beforeEach`.

- [ ] **Step 4: Run the test**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/instances-reconciler.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add subgraphs/vetra-apps/instances/reconciler.ts subgraphs/vetra-apps/__tests__/instances-reconciler.test.ts
git commit -m "feat(instances): reconciler for branch instances

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The processor renders instance images

Without this, the processor renders an instance's FUSION block as `app.enabled: false` (its namespace project is not in `FUSION_IMAGE_PROJECTS` and not the App's old `harbor_project`).

**Files:**
- Modify: `processors/vetra-cloud-environment/app-image-project.ts` (`createAppImageProjectResolver`, the App-linked branch)
- Test: `processors/vetra-cloud-environment/app-image-project.test.ts`

**Interfaces:**
- Consumes: the `instances` table (Task 1), `apps.registry_namespace` (phase 1).
- Produces: the resolver returns `apps.registry_namespace` for a document that is an instance environment of the App its link names.

- [ ] **Step 1: Write the failing tests** (append to `app-image-project.test.ts`; `seed()` and `linked()` exist there):

```ts
describe("instance environments", () => {
  async function seedInstance(appId: string, envId: string) {
    await db.updateTable("apps").set({ registry_namespace: "acme" }).where("id", "=", appId).execute();
    await db
      .insertInto("instances")
      .values({
        id: `i-${envId}`,
        app_id: appId,
        kind: "branch",
        name: "main",
        branch: "main",
        host: `${appId}-main`,
        environment_id: envId,
        status: "updating",
        created_at: "t",
        updated_at: "t",
      })
      .execute();
  }

  it("vouches for the App's registry namespace", async () => {
    await seed();
    await seedInstance("app-1", "instance-env");
    const resolve = createAppImageProjectResolver(db);
    expect(await resolve(linked("app-1"), "instance-env")).toBe("acme");
  });

  it("does not vouch when the link names another App", async () => {
    await seed();
    await seedInstance("app-1", "instance-env");
    const resolve = createAppImageProjectResolver(db);
    expect(await resolve(linked("app-2"), "instance-env")).toBeNull();
  });

  it("keeps answering for production and previews as before", async () => {
    await seed();
    await seedInstance("app-1", "instance-env");
    const resolve = createAppImageProjectResolver(db);
    expect(await resolve(linked("app-1"), "preview-env")).toBe("app-shop");
    expect(await resolve(linked("app-1"), "prod-env")).toBe("app-shop");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run processors/vetra-cloud-environment/app-image-project.test.ts`
Expected: the first case FAILS (`null` instead of `"acme"`).

- [ ] **Step 3: Implement.** In `createAppImageProjectResolver`, replace the App-linked lookup (the `try { const app = … return preview ? app.harbor_project : null; }` block) with:

```ts
    try {
      const app = (await appsDb
        .selectFrom("apps")
        .select(["harbor_project", "production_environment_id", "registry_namespace"])
        .where("id", "=", appId)
        .executeTakeFirst()) as
        | {
            harbor_project: string;
            production_environment_id: string;
            registry_namespace: string | null;
          }
        | undefined;
      if (!app) return null;
      if (app.production_environment_id === documentId)
        return app.harbor_project;
      const preview = await appsDb
        .selectFrom("app_previews")
        .select("environment_id")
        .where("app_id", "=", appId)
        .where("environment_id", "=", documentId)
        .executeTakeFirst();
      if (preview) return app.harbor_project;
      // A releases-phase-2 instance runs the App's images from its registry
      // namespace (cr.vetra.io/<namespace>/<slug>), vouched for by the
      // instances table, never by the document.
      const instance = await appsDb
        .selectFrom("instances")
        .select("id")
        .where("app_id", "=", appId)
        .where("environment_id", "=", documentId)
        .executeTakeFirst();
      return instance ? app.registry_namespace : null;
    } catch {
      return null;
    }
```

Licensed environments carry no `app` link and keep going through `licensedImageProject`, unchanged.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run processors/vetra-cloud-environment/app-image-project.test.ts processors/vetra-cloud-environment/fusion.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add processors/vetra-cloud-environment/app-image-project.ts processors/vetra-cloud-environment/app-image-project.test.ts
git commit -m "feat(instances): processor renders images of instance environments

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Branch deletion from the push webhook

**Files:**
- Modify: `subgraphs/vetra-apps/webhook.ts` (the `push` branch of `handleGithubWebhook`)
- Test: `subgraphs/vetra-apps/__tests__/instances-webhook.test.ts`

**Interfaces:**
- Consumes: `markBranchDeleted` (Task 7).
- Produces: a `push` delivery with `deleted: true` on `refs/heads/<b>` answers `{ flaggedApps, removedInstances }` when it marked any instance, else the body is unchanged (`{ flaggedApps }`).

- [ ] **Step 1: Write the failing test**

```ts
// subgraphs/vetra-apps/__tests__/instances-webhook.test.ts
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INSTALLATION, makeHarness, REPO_ID, seedActiveApp, type Harness } from "./harness.js";
import { seedRelease } from "./instances-fixtures.js";
import { listInstances } from "../instances/repo.js";
import { reconcileInstancesOnce } from "../instances/reconciler.js";
import { handleGithubWebhook } from "../webhook.js";

let h: Harness;
let appId: string;
beforeEach(async () => {
  h = await makeHarness();
  appId = (await seedActiveApp(h)).id;
  await h.db
    .updateTable("apps")
    .set({ instances_enabled: true, registry_namespace: "acme", release_branches: '["next"]' })
    .where("id", "=", appId)
    .execute();
  await seedRelease(h, appId, { version: "2.0.0-beta.0-next.1", run: 100, branch: "next" });
  await reconcileInstancesOnce(h.deps);
});
afterEach(async () => {
  await h.close();
});

const push = (ref: string, deleted: boolean) => {
  const body = JSON.stringify({
    ref,
    before: "1".repeat(40),
    after: deleted ? "0".repeat(40) : "2".repeat(40),
    deleted,
    commits: [],
    repository: { id: Number(REPO_ID), full_name: "acme/shop" },
    installation: { id: Number(INSTALLATION) },
  });
  return handleGithubWebhook(h.deps, {
    rawBody: Buffer.from(body),
    signature: `sha256=${createHmac("sha256", "whsec").update(body).digest("hex")}`,
    event: "push",
  });
};

describe("push webhook — deleted branch", () => {
  it("marks the branch instance for removal", async () => {
    const res = await push("refs/heads/next", true);
    expect(res).toStrictEqual({ status: 200, body: { flaggedApps: 0, removedInstances: 1 } });
    expect((await listInstances(h.db, appId))[0].removed_reason).toBe("branch deleted");
  });

  it("leaves instances alone for an ordinary push, a tag, or another branch", async () => {
    expect((await push("refs/heads/next", false)).body).toStrictEqual({ flaggedApps: 0 });
    expect((await push("refs/tags/next", true)).body).toStrictEqual({ flaggedApps: 0 });
    expect((await push("refs/heads/other", true)).body).toStrictEqual({ flaggedApps: 0 });
    expect((await listInstances(h.db, appId))[0].removed_at).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/instances-webhook.test.ts`
Expected: FAIL (`removedInstances` missing).

- [ ] **Step 3: Implement.** In `webhook.ts`, import `markBranchDeleted` from `./instances/reconciler.js` and replace the `push` branch:

```ts
  if (input.event === "push") {
    const flaggedApps = await flagOutsidePush(deps, payload);
    const removedInstances = await removeDeletedBranchInstances(deps, payload);
    return {
      status: 200,
      body: removedInstances > 0 ? { flaggedApps, removedInstances } : { flaggedApps },
    };
  }
```

and add below `flagOutsidePush`:

```ts
/** A deleted branch (push with deleted: true on refs/heads/…) takes its branch instance with it. */
async function removeDeletedBranchInstances(
  deps: AppsDeps,
  payload: Payload,
): Promise<number> {
  const repositoryId = idOf(pick(payload, "repository.id"));
  const ref = typeof payload.ref === "string" ? payload.ref : "";
  if (!repositoryId || payload.deleted !== true || !ref.startsWith("refs/heads/"))
    return 0;
  return markBranchDeleted(deps, repositoryId, ref.slice("refs/heads/".length));
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/instances-webhook.test.ts subgraphs/vetra-apps/__tests__/webhook-push.test.ts subgraphs/vetra-apps/__tests__/watcher-webhook.test.ts`
Expected: PASS (existing push tests keep `{ flaggedApps }`).

- [ ] **Step 5: Commit**

```bash
git add subgraphs/vetra-apps/webhook.ts subgraphs/vetra-apps/__tests__/instances-webhook.test.ts
git commit -m "feat(instances): a deleted branch removes its instance

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: GraphQL, the opt-in setting, and starting the loop

**Files:**
- Create: `subgraphs/vetra-apps/instances/service.ts`
- Modify: `subgraphs/vetra-apps/service.ts` (`UpdateAppInput`, `updateApp`)
- Modify: `subgraphs/vetra-apps/schema.ts`, `subgraphs/vetra-apps/resolvers.ts`
- Modify: `subgraphs/vetra-apps/index.ts`
- Test: `subgraphs/vetra-apps/__tests__/instances-api.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 7; `loadAppForOwner` (`service.ts`).
- Produces: `InstanceJson`; `instanceJson(row)`; `appInstancesFor(deps, caller, appId): Promise<InstanceJson[]>`; GraphQL `type AppInstance`, `appInstances(appId: ID!): [AppInstance!]!`, `App.instancesEnabled: Boolean!`, `UpdateAppInput.instancesEnabled: Boolean`.

- [ ] **Step 1: Write the failing test**

```ts
// subgraphs/vetra-apps/__tests__/instances-api.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHarness, owner, seedActiveApp, stranger, type Harness } from "./harness.js";
import { seedRelease, digest } from "./instances-fixtures.js";
import { appInstancesFor } from "../instances/service.js";
import { reconcileInstancesOnce } from "../instances/reconciler.js";
import { updateApp } from "../service.js";

let h: Harness;
let appId: string;
let slug: string;
beforeEach(async () => {
  h = await makeHarness();
  const app = await seedActiveApp(h);
  appId = app.id;
  slug = app.slug;
  await h.db.updateTable("apps").set({ registry_namespace: "acme" }).where("id", "=", appId).execute();
});
afterEach(async () => {
  await h.close();
});

describe("instancesEnabled", () => {
  it("is off by default and the owner turns it on", async () => {
    const on = await updateApp(h.deps, owner, appId, { instancesEnabled: true });
    expect(on.instances_enabled).toBe(true);
  });
  it("is refused to strangers", async () => {
    await expect(updateApp(h.deps, stranger, appId, { instancesEnabled: true })).rejects.toThrow();
  });
});

describe("appInstancesFor", () => {
  it("lists the app's instances with URL, status and versions", async () => {
    await updateApp(h.deps, owner, appId, { instancesEnabled: true });
    await seedRelease(h, appId, { version: "1.5.0-main.1", run: 100 });
    await reconcileInstancesOnce(h.deps);
    const [i] = await appInstancesFor(h.deps, owner, appId);
    expect(i).toMatchObject({
      kind: "branch",
      name: "main",
      branch: "main",
      pr: null,
      url: `https://${slug}-main.vetra.io`,
      status: "updating",
      reason: null,
      targetVersion: "1.5.0-main.1",
      targetDigest: digest("a"),
      runningVersion: null,
    });
    expect(i.environmentId).toBeTruthy();
  });
  it("is refused to strangers", async () => {
    await expect(appInstancesFor(h.deps, stranger, appId)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/instances-api.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: The read service.** Create `subgraphs/vetra-apps/instances/service.ts`:

```ts
import type { Caller } from "../auth.js";
import { loadAppForOwner, type AppsDeps } from "../service.js";
import { INSTANCE_BASE_DOMAIN } from "./reconciler.js";
import { listInstances, type InstanceRow } from "./repo.js";

export interface InstanceJson {
  id: string;
  kind: string;
  name: string;
  branch: string | null;
  pr: number | null;
  url: string | null;
  status: string;
  reason: string | null;
  targetVersion: string | null;
  targetDigest: string | null;
  runningVersion: string | null;
  runningDigest: string | null;
  environmentId: string | null;
  updatedAt: string;
}

export function instanceJson(r: InstanceRow): InstanceJson {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    branch: r.branch,
    pr: r.pr,
    url: r.host ? `https://${r.host}.${INSTANCE_BASE_DOMAIN}` : null,
    status: r.status,
    reason: r.reason,
    targetVersion: r.target_version,
    targetDigest: r.target_digest,
    runningVersion: r.running_version,
    runningDigest: r.running_digest,
    environmentId: r.environment_id,
    updatedAt: r.updated_at,
  };
}

/** The App's instances (spec section 11, App page → Instances); tombstones are not shown. */
export async function appInstancesFor(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
): Promise<InstanceJson[]> {
  const app = await loadAppForOwner(deps, caller, appId, { need: "view" });
  return (await listInstances(deps.db, app.id))
    .filter((r) => r.status !== "removed")
    .map(instanceJson);
}
```

- [ ] **Step 4: The setting.** In `service.ts`, add to `UpdateAppInput`:

```ts
  /** Run this App's instances (releases phase 2). Needs a GitHub repository. */
  instancesEnabled?: boolean | null;
```

and in `updateApp`, after the `previewsEnabled` line:

```ts
  if (input.instancesEnabled != null) {
    if (input.instancesEnabled && !hasCiIdentity(app))
      throw appsError(
        "BAD_USER_INPUT",
        "Instances run releases published from GitHub (vetra-publish); this App has no repository",
      );
    patch.instances_enabled = input.instancesEnabled;
  }
```

(`hasCiIdentity` is in `./repo.js`; import it if `service.ts` does not yet.)

- [ ] **Step 5: GraphQL.** In `schema.ts`: add to `type App` after `previewTtlDays: Int!`:

```graphql
    "Whether Vetra runs this App's instances (one per release branch)."
    instancesEnabled: Boolean!
```

to `input UpdateAppInput`: `instancesEnabled: Boolean`; after `type AppReleasePackage { … }`:

```graphql
  "A running environment of an app (spec: releases and instances, section 5)."
  type AppInstance {
    id: ID!
    "branch | preview | shared | own"
    kind: String!
    name: String!
    branch: String
    pr: Int
    url: String
    "pending | updating | ready | failed | stopped"
    status: String!
    reason: String
    targetVersion: String
    targetDigest: String
    runningVersion: String
    runningDigest: String
    environmentId: String
    updatedAt: String!
  }
```

and to `type Query` after `appReleases(…)`: `appInstances(appId: ID!): [AppInstance!]!`.

In `resolvers.ts`: in `mapApp`, after `previewTtlDays: app.preview_ttl_days,` add `instancesEnabled: app.instances_enabled ?? false,`; import `appInstancesFor` from `./instances/service.js`; next to `appReleases` add:

```ts
      appInstances: (
        _: unknown,
        { appId }: { appId: string },
        ctx: AppsContext,
      ) =>
        guard(deps, "appInstances", () =>
          appInstancesFor(deps, requireCaller(ctx), appId),
        ),
```

Check that the `updateApp` resolver passes `input` through unchanged (it does for the other optional fields); if it whitelists fields, add `instancesEnabled`.

- [ ] **Step 6: Start the loop.** In `index.ts`, import `reconcileInstancesOnce` from `./instances/reconciler.js` and after the `push robot sweep` line add:

```ts
    if (cfg.instances.enabled) {
      every(WATCH_INTERVAL_MS, "instance reconciler", () =>
        reconcileInstancesOnce(deps),
      );
    } else {
      console.info("[vetra-apps] instances are off (VETRA_APPS_INSTANCES)");
    }
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/instances-api.test.ts subgraphs/vetra-apps/__tests__/resolvers.test.ts subgraphs/vetra-apps/__tests__/subgraph.test.ts subgraphs/vetra-apps/__tests__/apps.test.ts`
Expected: PASS. If `subgraph.test.ts` snapshots the SDL, update the snapshot only for the added fields.

- [ ] **Step 8: Commit**

```bash
git add subgraphs/vetra-apps
git commit -m "feat(instances): appInstances query, instancesEnabled setting, reconciler loop

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Whole-suite check

- [ ] **Step 1:** Run `npm run tsc 2>&1 | tail -20`. Expected: no errors.
- [ ] **Step 2:** Run `npm run lint 2>&1 | tail -20`. Expected: no errors (fix, never disable a rule).
- [ ] **Step 3:** Run `npx vitest run subgraphs/vetra-apps processors/vetra-cloud-environment subgraphs/vetra-licensing 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: no FAIL; the licensing suite is unchanged by this plan and must stay green.
- [ ] **Step 4:** If anything was fixed, commit: `git commit -am "fix(instances): <what>"` with the trailer.

---

### Task 12: Staging, then production (needs the user for every push and pin)

- [ ] **Step 1: PR and merge.** Open the PR from `feat/releases-phase-2-instances` (description: Task 0 answers, the overview's slice 1 section). The user merges; `main` publishes `0.0.<n>`.
- [ ] **Step 2: Staging values (user PR in `powerhouse-k8s-hosting`).** `tenants/staging/powerhouse-values.yaml`: set `PH_REGISTRY_PACKAGES` (two places) to the new version and add `VETRA_APPS_INSTANCE_LABEL_SUFFIX: "-stg"` to the switchboard env. Wait for the roll (1-1.5 min).
- [ ] **Step 3: Turn it on for the staging test app** (owner's session on the staging console's GraphQL): `mutation { updateApp(appId: "<id>", input: { instancesEnabled: true }) { instancesEnabled } }`.
- [ ] **Step 4: Verify on staging.**
  - Push to `main` of the test repo; the action reports a build. Within a minute `appInstances` shows `main` `updating`, URL `https://<slug>-main-stg.vetra.io`; within ~5 minutes `ready`.
  - The pod pulls by digest: `kubectl -n <tenant> get pod -l powerhouse.io/service=fusion -o jsonpath='{..imageID}'` ends with the build's `image_digest`.
  - Push again: the instance moves to the new build and is `ready` on it.
  - Push a commit whose host fails to start (e.g. `CMD ["false"]` in `hosts/cli/Dockerfile`): the instance shows `failed`, then the environment is back on the previous digest and serving.
  - Add `next` to the app's release branches and push `next`: `<slug>-next-stg` appears. Delete branch `next` on GitHub: the instance disappears, the tenant dir leaves `previews/` in `powerhouse-k8s-hosting`.
  - `instancesEnabled: false`: every instance environment is deleted.
  - Nothing else moved: `vetraPublisher.environments` and the licensing logs show no activity caused by the test.
- [ ] **Step 5: Production pin** (not inside the Sektar window of Task 0 Step 4): `tenants/vetra/powerhouse-values.yaml` `PH_REGISTRY_PACKAGES` (two places); no suffix. Instances stay off for every app until an owner turns them on; check the switchboard log shows the reconciler starting and no warnings.

---

## Self-review

**Spec coverage (phase 2 parts this slice owns):**
- `instances` table (section 5): Task 1. Kinds column ready for preview/shared/own.
- Reconciler: desired = target digest + settings (6.1): Tasks 3, 4, 7; compare and apply create/update/stop-wake/delete (6.2): Task 7 (stop is the housekeeping's; the reconciler wakes for a new target); status words and "ready requires running digest = target" (6.3): Tasks 5, 7; failed update stays on previous digest: Task 7; "plan can't be provisioned": not reachable in this slice (no services rendered; gap 6 assigns it to a later slice); warm pool: gap 13, none.
- Branch instances (table in 5, targets in 6, removed when branch deleted): Tasks 3, 7, 9.
- Pull by digest (`image_ref@image_digest`): Tasks 3, 4, 8, verified in 12.
- Instance hosts (5): Task 2, 7; collisions per gap 4.
- What every instance runs (5): `PH_HOST`, database, `PUBLIC_URL` (rendered by the processor in host mode), `ADMINS` (owner only, gap 9); `PH_WORKFLOWS_SECRETS_MASTER_KEY`, `/data` persistence, org admins: slice 4 / gap 5, not here.
- 14.13 (single Postgres without S3 backups for branch instances): by the PREVIEW link (Task 4); preview limits and sleep: slices 2 and 6.
- 14.2, 14.6, 14.7, 14.18, removals of section 16: slices 2–7 (overview), not this plan.
- Licensed environments untouched: Global Constraints, `ours()` in Task 7, resolver change after the licensed path in Task 8, licensing suite in Task 11.

**Placeholder scan:** every code step carries its code; the two conditional notes (DISTINCT ON fallback in Task 3, SDL snapshot in Task 10) state the exact action.

**Type consistency:** `InstanceRow`/`NewInstance`/`InstancePatch` (Task 1) used by Tasks 7, 10; `InstanceTarget` keys equal the `target_*` columns; `InstanceImage { repository, tag, phHost }` and `imageTag(version, digest)` (Task 4) used by Task 7; `observeEnvironment(state, targetTag, updateStartedAt, now)` (Task 5) called with `image.tag`; `cfg.instances.{enabled,labelSuffix}` (Task 6) read in Tasks 7, 10; `markBranchDeleted(deps, repositoryId, branch)` (Task 7) used in Task 9; `INSTANCE_BASE_DOMAIN` (Task 7) used in Task 10; status `"removed"` is in `InstanceStatus` (Task 1) and filtered in Task 10.

## Not in this plan

Preview instances and old-preview cut-over (slice 2), the full health definition (slice 3), Vetra-owned and publisher settings (slice 4), PR comment/check/title check (slice 5), sleep and registry retention (slice 6), removal of `ci/deploy` PREVIEW and the old action's PR runs (slice 7). The console (vetra.to) Instances tab is a separate plan in that repo against the `appInstances` query fixed here.
