# App Artifact Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record what every app actually published — packages and fusion images, with their versions and channels — so a licence template can be composed by selecting from real artifacts instead of typing free text.

**Architecture:** Two tables in the `vetra-apps` subgraph, modelled on npm's version/dist-tag split: `app_artifacts` holds one row per published version, `app_artifact_channels` points a channel name at a version. A CI route registers artifacts at publish time; a reconciler backfills from Harbor and the registry for apps that published before the catalog existed. A GraphQL query exposes the catalog to the publisher UI.

**Tech Stack:** TypeScript, Kysely (Postgres), GraphQL (graphql-js SDL + resolvers), vitest, PGlite in tests.

**Spec:** `docs/superpowers/specs/2026-10-07-app-artifacts-and-template-builder-design.md`

This plan implements **Phase 1 only**. Phases 2-4 (publishing under the Renown identity, the template builder, keeper provisioning) each get their own plan once this lands.

## Global Constraints

- Repo: `vetra-cloud-package`; worktree `/home/f/projects/vetra-cloud-package-licensing`; branch `feat/license-provisioning`.
- Artifact kinds are exactly `PACKAGE` and `FUSION_IMAGE`.
- A row exists only once the artifact is **actually published**, so a dropdown can never offer something uninstallable.
- Registration is **idempotent** on `(app_id, kind, name, version)`: re-running the same CI job overwrites, never duplicates.
- `app_artifacts.app_id` is the authorisation boundary: an app may only register artifacts under its own id.
- Discovered (reconciled) artifacts carry `commit_sha = null`; registered ones carry the commit.
- Publishing is never rolled back because a catalog write failed.
- Timestamps are ISO-8601 UTC `Z` strings (`new Date().toISOString()`), matching the existing tables.
- Commit messages: no `Co-Authored-By` trailer.
- Run tests with `npx vitest run <path>`; typecheck with `npm run tsc`; lint with `npx oxlint subgraphs/vetra-apps`.

## Review Focus

Five failure modes the spec implies but that no task's main deliverable exercises. Each has a test assigned to the task that owns the code.

1. **A second app registering a package name another app already owns** — must be refused, not silently re-pointed, or one publisher could hijack another's dropdown entry. *(Task 2)*
2. **A channel pointer asked to move backwards** (a republish of an older version, or a rebuilt tag) — the pointer must follow what was last published rather than assuming versions only increase, because `latest` is a publisher decision, not a sort order. *(Task 2)*
3. **The same artifact under scoped and bare names** (`@powerhousedao/dtbau-package` vs `dtbau-package`) — must not produce two catalog entries for one thing. *(Task 2)*
4. **The reconciler racing a live registration** — a discovered row must never overwrite a registered row's `commit_sha` with null. *(Task 5)*
5. **An app with hundreds of versions** — the read query must be bounded, or the dropdown loads the whole history. *(Task 4)*

---

### Task 1: Catalog tables and migration

**Files:**
- Modify: `subgraphs/vetra-apps/db/schema.ts`
- Modify: `subgraphs/vetra-apps/db/migrations.ts`
- Test: `subgraphs/vetra-apps/__tests__/artifacts.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: table types `AppArtifactsTable`, `AppArtifactChannelsTable`, the literal type `ArtifactKind = "PACKAGE" | "FUSION_IMAGE"`, and both tables registered on `VetraAppsDB` as `app_artifacts` and `app_artifact_channels`.

- [ ] **Step 1: Write the failing test**

Create `subgraphs/vetra-apps/__tests__/artifacts.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { makeHarness, type Harness } from "./harness.js";

let h: Harness;
beforeEach(async () => { h = await makeHarness(); });
afterEach(async () => { await h.stop(); });

describe("catalog tables", () => {
  it("stores one row per published version, keyed by app, kind, name and version", async () => {
    await h.db
      .insertInto("app_artifacts")
      .values({
        app_id: "app-1",
        kind: "FUSION_IMAGE",
        name: "dtbau-psb",
        version: "1.2.0",
        reference: "cr.vetra.io/app-1/dtbau-psb:1.2.0",
        commit_sha: "abc123",
        run_id: "42",
        created_at: new Date().toISOString(),
      })
      .execute();

    const rows = await h.db.selectFrom("app_artifacts").selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("dtbau-psb");
    expect(rows[0]!.reference).toBe("cr.vetra.io/app-1/dtbau-psb:1.2.0");
  });

  it("points a channel at a version", async () => {
    await h.db
      .insertInto("app_artifact_channels")
      .values({
        app_id: "app-1",
        kind: "FUSION_IMAGE",
        name: "dtbau-psb",
        channel: "latest",
        version: "1.2.0",
        updated_at: new Date().toISOString(),
      })
      .execute();

    const row = await h.db
      .selectFrom("app_artifact_channels")
      .selectAll()
      .executeTakeFirst();
    expect(row?.version).toBe("1.2.0");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/artifacts.test.ts`
Expected: FAIL — relation `app_artifacts` does not exist.

- [ ] **Step 3: Add the table types**

In `subgraphs/vetra-apps/db/schema.ts`, add above `export interface VetraAppsDB`:

```ts
/** What an app publishes. PACKAGE goes to the registry; FUSION_IMAGE to Harbor. */
export type ArtifactKind = "PACKAGE" | "FUSION_IMAGE";

/**
 * One published version of one artifact. A row exists only once the artifact is
 * actually published, so a template dropdown can never offer something that
 * cannot be installed.
 */
export interface AppArtifactsTable {
  app_id: string;
  kind: ArtifactKind;
  /** '@powerhousedao/dtbau-package' for a package, 'dtbau-psb' for an image. */
  name: string;
  version: string;
  /** What a consumer installs or pulls: a registry specifier or a full image ref. */
  reference: string;
  /** Commit that produced it. NULL means discovered by the reconciler, not registered. */
  commit_sha: string | null;
  run_id: string | null;
  created_at: string;
}

/** Channel -> version pointer, the dist-tag model. A template references a channel. */
export interface AppArtifactChannelsTable {
  app_id: string;
  kind: ArtifactKind;
  name: string;
  /** 'latest', 'dev', or a branch name. */
  channel: string;
  version: string;
  updated_at: string;
}
```

Then add both to the `VetraAppsDB` interface:

```ts
export interface VetraAppsDB {
  apps: AppsTable;
  app_previews: AppPreviewsTable;
  app_deployments: AppDeploymentsTable;
  app_artifacts: AppArtifactsTable;
  app_artifact_channels: AppArtifactChannelsTable;
  github_deploy_connections: GithubDeployConnectionsTable;
}
```

- [ ] **Step 4: Add the migration**

In `subgraphs/vetra-apps/db/migrations.ts`, inside `up()`, before the final column-adding loop:

```ts
  await db.schema
    .createTable("app_artifacts")
    .addColumn("app_id", "varchar(255)", (col) => col.notNull())
    .addColumn("kind", "varchar(32)", (col) => col.notNull())
    .addColumn("name", "varchar(255)", (col) => col.notNull())
    .addColumn("version", "varchar(128)", (col) => col.notNull())
    .addColumn("reference", "text", (col) => col.notNull())
    .addColumn("commit_sha", "varchar(64)")
    .addColumn("run_id", "varchar(64)")
    .addColumn("created_at", "varchar(64)", (col) => col.notNull())
    .addPrimaryKeyConstraint("app_artifacts_pkey", [
      "app_id",
      "kind",
      "name",
      "version",
    ])
    .ifNotExists()
    .execute();

  await db.schema
    .createIndex("app_artifacts_app_id_kind_idx")
    .on("app_artifacts")
    .columns(["app_id", "kind"])
    .ifNotExists()
    .execute();

  await db.schema
    .createTable("app_artifact_channels")
    .addColumn("app_id", "varchar(255)", (col) => col.notNull())
    .addColumn("kind", "varchar(32)", (col) => col.notNull())
    .addColumn("name", "varchar(255)", (col) => col.notNull())
    .addColumn("channel", "varchar(128)", (col) => col.notNull())
    .addColumn("version", "varchar(128)", (col) => col.notNull())
    .addColumn("updated_at", "varchar(64)", (col) => col.notNull())
    .addPrimaryKeyConstraint("app_artifact_channels_pkey", [
      "app_id",
      "kind",
      "name",
      "channel",
    ])
    .ifNotExists()
    .execute();
```

And in `down()`, add `"app_artifact_channels"` and `"app_artifacts"` to the front of the table list.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/artifacts.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck and commit**

```bash
npm run tsc
git add subgraphs/vetra-apps/db/schema.ts subgraphs/vetra-apps/db/migrations.ts subgraphs/vetra-apps/__tests__/artifacts.test.ts
git commit -m "feat(apps): tables for the artifact catalog

app_artifacts holds one row per published version; app_artifact_channels points
a channel at a version, the dist-tag model, because a licence template
references a channel while an environment needs a concrete version."
```

---

### Task 2: Recording artifacts

**Files:**
- Create: `subgraphs/vetra-apps/artifacts.ts`
- Test: `subgraphs/vetra-apps/__tests__/artifacts.test.ts` (extend)

**Interfaces:**
- Consumes: `VetraAppsDB` with `app_artifacts` and `app_artifact_channels` (Task 1).
- Produces:
  - `normalizeArtifactName(kind: ArtifactKind, name: string): string`
  - `recordArtifact(db: Kysely<VetraAppsDB>, input: RecordArtifactInput): Promise<void>` where
    `RecordArtifactInput = { appId: string; kind: ArtifactKind; name: string; version: string; reference: string; channel: string; commitSha?: string | null; runId?: string | null; now: string }`
  - `ArtifactOwnedByAnotherAppError extends Error`

- [ ] **Step 1: Write the failing tests**

Append to `subgraphs/vetra-apps/__tests__/artifacts.test.ts`:

```ts
import {
  recordArtifact,
  normalizeArtifactName,
  ArtifactOwnedByAnotherAppError,
} from "../artifacts.js";

const base = {
  kind: "PACKAGE" as const,
  name: "@powerhousedao/dtbau-package",
  version: "1.0.0",
  reference: "@powerhousedao/dtbau-package@1.0.0",
  channel: "latest",
  now: "2026-10-07T00:00:00.000Z",
};

describe("recordArtifact", () => {
  it("records the version and points the channel at it", async () => {
    await recordArtifact(h.db, { ...base, appId: "app-1", commitSha: "abc" });

    const art = await h.db.selectFrom("app_artifacts").selectAll().executeTakeFirst();
    expect(art?.version).toBe("1.0.0");
    expect(art?.commit_sha).toBe("abc");

    const chan = await h.db.selectFrom("app_artifact_channels").selectAll().executeTakeFirst();
    expect(chan?.version).toBe("1.0.0");
  });

  it("is idempotent: re-running the same job overwrites rather than duplicating", async () => {
    await recordArtifact(h.db, { ...base, appId: "app-1", commitSha: "abc" });
    await recordArtifact(h.db, { ...base, appId: "app-1", commitSha: "def" });

    const rows = await h.db.selectFrom("app_artifacts").selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.commit_sha).toBe("def");
  });

  // Review Focus 2: 'latest' is a publisher decision, not a sort order.
  it("lets a channel move back to an older version on a republish", async () => {
    await recordArtifact(h.db, { ...base, appId: "app-1", version: "2.0.0" });
    await recordArtifact(h.db, { ...base, appId: "app-1", version: "1.0.0" });

    const chan = await h.db.selectFrom("app_artifact_channels").selectAll().executeTakeFirst();
    expect(chan?.version).toBe("1.0.0");
    // both versions remain installable
    expect(await h.db.selectFrom("app_artifacts").selectAll().execute()).toHaveLength(2);
  });

  // Review Focus 1: one publisher must not be able to claim another's name.
  it("refuses a name another app already published", async () => {
    await recordArtifact(h.db, { ...base, appId: "app-1" });
    await expect(
      recordArtifact(h.db, { ...base, appId: "app-2" }),
    ).rejects.toBeInstanceOf(ArtifactOwnedByAnotherAppError);
  });

  // Review Focus 3: one artifact must not appear twice under two spellings.
  it("normalises package names so a scoped and bare spelling are one entry", () => {
    expect(normalizeArtifactName("PACKAGE", "  @powerhousedao/Dtbau-Package ")).toBe(
      "@powerhousedao/dtbau-package",
    );
    // image names are not lowercased beyond trimming: Harbor paths are case-sensitive
    expect(normalizeArtifactName("FUSION_IMAGE", " dtbau-psb ")).toBe("dtbau-psb");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/artifacts.test.ts`
Expected: FAIL — cannot find module `../artifacts.js`.

- [ ] **Step 3: Write the implementation**

Create `subgraphs/vetra-apps/artifacts.ts`:

```ts
import type { Kysely } from "kysely";
import type { ArtifactKind, VetraAppsDB } from "./db/schema.js";

/**
 * A name another app already published. Registration is refused rather than
 * re-pointed: app_artifacts.app_id is the authorisation boundary, and silently
 * re-pointing would let one publisher take over another's dropdown entry.
 */
export class ArtifactOwnedByAnotherAppError extends Error {}

/**
 * One artifact must not appear twice under two spellings. Package names are
 * registry identifiers and case-insensitive, so they are lowercased; image
 * names address a Harbor path and are only trimmed.
 */
export function normalizeArtifactName(kind: ArtifactKind, name: string): string {
  const trimmed = name.trim();
  return kind === "PACKAGE" ? trimmed.toLowerCase() : trimmed;
}

export interface RecordArtifactInput {
  appId: string;
  kind: ArtifactKind;
  name: string;
  version: string;
  reference: string;
  channel: string;
  commitSha?: string | null;
  runId?: string | null;
  /** ISO-8601 UTC 'Z'. */
  now: string;
}

export async function recordArtifact(
  db: Kysely<VetraAppsDB>,
  input: RecordArtifactInput,
): Promise<void> {
  const name = normalizeArtifactName(input.kind, input.name);

  const owner = await db
    .selectFrom("app_artifacts")
    .select("app_id")
    .where("kind", "=", input.kind)
    .where("name", "=", name)
    .limit(1)
    .executeTakeFirst();

  if (owner && owner.app_id !== input.appId) {
    throw new ArtifactOwnedByAnotherAppError(
      `${name} is already published by another app`,
    );
  }

  await db
    .insertInto("app_artifacts")
    .values({
      app_id: input.appId,
      kind: input.kind,
      name,
      version: input.version,
      reference: input.reference,
      commit_sha: input.commitSha ?? null,
      run_id: input.runId ?? null,
      created_at: input.now,
    })
    .onConflict((oc) =>
      oc.columns(["app_id", "kind", "name", "version"]).doUpdateSet({
        reference: input.reference,
        commit_sha: input.commitSha ?? null,
        run_id: input.runId ?? null,
      }),
    )
    .execute();

  // The pointer follows what was last published. It is not a max(): a publisher
  // republishing an older build is deciding what 'latest' means.
  await db
    .insertInto("app_artifact_channels")
    .values({
      app_id: input.appId,
      kind: input.kind,
      name,
      channel: input.channel,
      version: input.version,
      updated_at: input.now,
    })
    .onConflict((oc) =>
      oc.columns(["app_id", "kind", "name", "channel"]).doUpdateSet({
        version: input.version,
        updated_at: input.now,
      }),
    )
    .execute();
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/artifacts.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Prove the ownership check can fail**

Temporarily delete the `if (owner && owner.app_id !== input.appId)` block, re-run the tests, and confirm "refuses a name another app already published" FAILS. Restore the block and confirm the suite is green again. A guard with no failing test is a guard that can be deleted silently.

- [ ] **Step 6: Typecheck, lint and commit**

```bash
npm run tsc && npx oxlint subgraphs/vetra-apps
git add subgraphs/vetra-apps/artifacts.ts subgraphs/vetra-apps/__tests__/artifacts.test.ts
git commit -m "feat(apps): record published artifacts and move channel pointers

Registration is idempotent on (app_id, kind, name, version) and refuses a name
another app already published, which is the boundary that stops one publisher
appearing in another's template dropdown."
```

---

### Task 3: CI registration route

**Files:**
- Modify: `subgraphs/vetra-apps/ci.ts` (add to the object returned by `createCiRoutes`)
- Modify: `subgraphs/vetra-apps/index.ts:107-116` (route table)
- Modify: `subgraphs/vetra-apps/service.ts` (add `ciRecordArtifacts`)
- Test: `subgraphs/vetra-apps/__tests__/ci.test.ts` (extend)

**Interfaces:**
- Consumes: `recordArtifact`, `RecordArtifactInput`, `ArtifactOwnedByAnotherAppError` (Task 2); `authorizeCi(deps, ci, appId)` (existing, `service.ts:170`).
- Produces: `ciRecordArtifacts(deps, ci, input: { appId: string; artifacts: Array<{ kind: ArtifactKind; name: string; version: string; reference: string; channel: string }>; commitSha: string | null; runId: string | null }): Promise<{ recorded: number }>` and the route `POST apps/ci/artifacts`.

- [ ] **Step 1: Write the failing test**

Append to `subgraphs/vetra-apps/__tests__/ci.test.ts`, inside the existing describe that builds CI routes (mirror how the `deploy` route is exercised there for token minting and app seeding):

```ts
  it("records the artifacts a run published", async () => {
    const routes = createCiRoutes(h.deps, verify);
    const res = await routes.artifacts(
      new Request("https://x/apps/ci/artifacts", {
        method: "POST",
        headers: { authorization: `Bearer ${await ciToken()}` },
        body: JSON.stringify({
          appId: app.id,
          commitSha: "abc123",
          runId: "42",
          artifacts: [
            {
              kind: "PACKAGE",
              name: "@powerhousedao/dtbau-package",
              version: "1.0.0",
              reference: "@powerhousedao/dtbau-package@1.0.0",
              channel: "latest",
            },
            {
              kind: "FUSION_IMAGE",
              name: "dtbau-psb",
              version: "1.0.0",
              reference: "cr.vetra.io/p/dtbau-psb:1.0.0",
              channel: "latest",
            },
          ],
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recorded: 2 });

    const rows = await h.db.selectFrom("app_artifacts").selectAll().execute();
    expect(rows.map((r) => r.kind).sort()).toEqual(["FUSION_IMAGE", "PACKAGE"]);
  });

  it("refuses artifacts for an app the token does not own", async () => {
    const routes = createCiRoutes(h.deps, verify);
    const res = await routes.artifacts(
      new Request("https://x/apps/ci/artifacts", {
        method: "POST",
        headers: { authorization: `Bearer ${await ciToken()}` },
        body: JSON.stringify({
          appId: "some-other-app",
          artifacts: [],
          commitSha: null,
          runId: null,
        }),
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await h.db.selectFrom("app_artifacts").selectAll().execute()).toHaveLength(0);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/ci.test.ts`
Expected: FAIL — `routes.artifacts is not a function`.

- [ ] **Step 3: Add the service function**

In `subgraphs/vetra-apps/service.ts`, next to `ciRegistryCredentials`:

```ts
/** CI route: record what a run published. Authorised like every other CI call. */
export async function ciRecordArtifacts(
  deps: AppsDeps,
  ci: CiIdentity,
  input: {
    appId: string;
    artifacts: Array<{
      kind: ArtifactKind;
      name: string;
      version: string;
      reference: string;
      channel: string;
    }>;
    commitSha: string | null;
    runId: string | null;
  },
): Promise<{ recorded: number }> {
  const app = await authorizeCi(deps, ci, input.appId);
  const now = deps.now().toISOString();
  for (const a of input.artifacts) {
    await recordArtifact(deps.db, {
      appId: app.id,
      kind: a.kind,
      name: a.name,
      version: a.version,
      reference: a.reference,
      channel: a.channel,
      commitSha: input.commitSha,
      runId: input.runId,
      now,
    });
  }
  return { recorded: input.artifacts.length };
}
```

Add `import { recordArtifact } from "./artifacts.js";` and `ArtifactKind` to the `./db/schema.js` type import.

- [ ] **Step 4: Add the route**

In `subgraphs/vetra-apps/ci.ts`, inside the object returned by `createCiRoutes`, after `deploy`:

```ts
    artifacts: (request: Request) =>
      run(request, async (ci) => {
        const body = await jsonBody(request);
        const list = Array.isArray(body.artifacts) ? body.artifacts : [];
        return ciRecordArtifacts(deps, ci, {
          appId: requireString(body, "appId"),
          commitSha: typeof body.commitSha === "string" ? body.commitSha : null,
          runId: typeof body.runId === "string" ? body.runId : null,
          artifacts: list.map((raw) => {
            const o = (raw ?? {}) as Record<string, unknown>;
            return {
              kind: o.kind === "PACKAGE" ? "PACKAGE" : "FUSION_IMAGE",
              name: typeof o.name === "string" ? o.name : "",
              version: typeof o.version === "string" ? o.version : "",
              reference: typeof o.reference === "string" ? o.reference : "",
              channel: typeof o.channel === "string" ? o.channel : "latest",
            };
          }),
        });
      }),
```

Import `ciRecordArtifacts` from `./service.js`.

In `subgraphs/vetra-apps/index.ts`, add to `this.routeHandles.push(...)` beside the other CI routes:

```ts
        this.http.post("apps/ci/artifacts", json, (request) =>
          ci.artifacts(request),
        ),
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/ci.test.ts`
Expected: PASS, including the two new cases.

- [ ] **Step 6: Typecheck, lint and commit**

```bash
npm run tsc && npx oxlint subgraphs/vetra-apps
git add subgraphs/vetra-apps/ci.ts subgraphs/vetra-apps/index.ts subgraphs/vetra-apps/service.ts subgraphs/vetra-apps/__tests__/ci.test.ts
git commit -m "feat(apps): CI route to register published artifacts

POST apps/ci/artifacts records what a run published, authorised by the same
workload token as every other CI call."
```

---

### Task 4: GraphQL read surface

**Files:**
- Modify: `subgraphs/vetra-apps/schema.ts` (SDL)
- Modify: `subgraphs/vetra-apps/resolvers.ts`
- Modify: `subgraphs/vetra-apps/artifacts.ts` (add the query helper)
- Modify: `subgraphs/vetra-apps/service.ts` (add `appArtifactsFor`)
- Test: `subgraphs/vetra-apps/__tests__/artifacts.test.ts` (extend)

**Interfaces:**
- Consumes: `normalizeArtifactName` (Task 2).
- Produces: `listAppArtifacts(db, appId, opts?: { limit?: number }): Promise<ArtifactView[]>`, `appArtifactsFor(deps, caller, appId)`, where
  `ArtifactView = { kind: ArtifactKind; name: string; versions: string[]; channels: Array<{ channel: string; version: string }>; latestReference: string }`,
  and the GraphQL field `Query.appArtifacts(appId: ID!): [AppArtifact!]!`.

- [ ] **Step 1: Write the failing test**

Append to `subgraphs/vetra-apps/__tests__/artifacts.test.ts`:

```ts
import { listAppArtifacts } from "../artifacts.js";

describe("listAppArtifacts", () => {
  it("groups versions and channels per artifact", async () => {
    await recordArtifact(h.db, { ...base, appId: "app-1", version: "1.0.0" });
    await recordArtifact(h.db, { ...base, appId: "app-1", version: "1.1.0" });
    await recordArtifact(h.db, {
      ...base, appId: "app-1", kind: "FUSION_IMAGE", name: "dtbau-psb",
      version: "1.1.0", reference: "cr.vetra.io/p/dtbau-psb:1.1.0",
    });

    const list = await listAppArtifacts(h.db, "app-1");
    const pkg = list.find((a) => a.kind === "PACKAGE")!;
    expect(pkg.versions).toEqual(["1.1.0", "1.0.0"]);   // newest first
    expect(pkg.channels).toEqual([{ channel: "latest", version: "1.1.0" }]);
    expect(list.some((a) => a.name === "dtbau-psb")).toBe(true);
  });

  it("returns nothing for an app that has published nothing", async () => {
    expect(await listAppArtifacts(h.db, "app-nothing")).toEqual([]);
  });

  // Review Focus 5: a dropdown must not load an app's whole history.
  it("bounds how many versions one artifact contributes", async () => {
    for (let i = 0; i < 60; i++) {
      await recordArtifact(h.db, { ...base, appId: "app-1", version: `1.0.${i}` });
    }
    const [artifact] = await listAppArtifacts(h.db, "app-1", { limit: 20 });
    expect(artifact!.versions).toHaveLength(20);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/artifacts.test.ts`
Expected: FAIL — `listAppArtifacts` is not exported.

- [ ] **Step 3: Implement the query helper**

Append to `subgraphs/vetra-apps/artifacts.ts`:

```ts
export interface ArtifactView {
  kind: ArtifactKind;
  name: string;
  /** Newest first. Bounded by `limit`, so a dropdown never loads a whole history. */
  versions: string[];
  channels: Array<{ channel: string; version: string }>;
  /** Reference of the newest recorded version, for display. */
  latestReference: string;
}

const DEFAULT_VERSION_LIMIT = 20;

export async function listAppArtifacts(
  db: Kysely<VetraAppsDB>,
  appId: string,
  opts: { limit?: number } = {},
): Promise<ArtifactView[]> {
  const limit = opts.limit ?? DEFAULT_VERSION_LIMIT;

  const rows = await db
    .selectFrom("app_artifacts")
    .selectAll()
    .where("app_id", "=", appId)
    .orderBy("created_at", "desc")
    .execute();

  const channels = await db
    .selectFrom("app_artifact_channels")
    .selectAll()
    .where("app_id", "=", appId)
    .execute();

  const byArtifact = new Map<string, ArtifactView>();
  for (const r of rows) {
    const key = `${r.kind}\u0000${r.name}`;
    const view = byArtifact.get(key) ?? {
      kind: r.kind,
      name: r.name,
      versions: [],
      channels: [],
      latestReference: r.reference,
    };
    if (view.versions.length < limit) view.versions.push(r.version);
    byArtifact.set(key, view);
  }

  for (const c of channels) {
    const view = byArtifact.get(`${c.kind}\u0000${c.name}`);
    if (view) view.channels.push({ channel: c.channel, version: c.version });
  }

  return [...byArtifact.values()];
}
```

- [ ] **Step 4: Expose it in GraphQL**

In `subgraphs/vetra-apps/schema.ts`, add to the SDL:

```graphql
type AppArtifactChannel {
  channel: String!
  version: String!
}

type AppArtifact {
  kind: String!
  name: String!
  versions: [String!]!
  channels: [AppArtifactChannel!]!
  latestReference: String!
}
```

and add to `type Query`:

```graphql
  appArtifacts(appId: ID!): [AppArtifact!]!
```

Resolvers in this subgraph call a service function rather than reaching into
`deps.db` (see `appDeployment` at `resolvers.ts:189`, which calls
`appDeploymentFor`). Follow that: add to `subgraphs/vetra-apps/service.ts`,
beside `appDeploymentsFor`:

```ts
/** Owner-scoped read of an app's catalogued artifacts. */
export async function appArtifactsFor(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
) {
  const app = await appForOwner(deps, caller, appId);
  return listAppArtifacts(deps.db, app.id);
}
```

`appForOwner` (exported, `service.ts:414`) is the authorised loader —
`loadAppForOwner` is module-private and cannot be imported. Add
`import { listAppArtifacts } from "./artifacts.js";` to `service.ts`.

Then in `subgraphs/vetra-apps/resolvers.ts`, beside `appDeployment`:

```ts
      appArtifacts: (_: unknown, { appId }: { appId: string }, ctx: AppsContext) =>
        guard(deps, "appArtifacts", () =>
          appArtifactsFor(deps, requireCaller(ctx), appId),
        ),
```

Import `appArtifactsFor` from `./service.js`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run subgraphs/vetra-apps`
Expected: PASS, including the SDL test in `subgraph.test.ts` that asserts every Query field has a resolver.

- [ ] **Step 6: Typecheck, lint and commit**

```bash
npm run tsc && npx oxlint subgraphs/vetra-apps
git add subgraphs/vetra-apps/artifacts.ts subgraphs/vetra-apps/schema.ts subgraphs/vetra-apps/resolvers.ts subgraphs/vetra-apps/service.ts subgraphs/vetra-apps/__tests__/artifacts.test.ts
git commit -m "feat(apps): appArtifacts query for the template builder

Groups an app's published versions and channel pointers per artifact, bounded so
a dropdown never loads a whole release history. Authorised through
loadAppForOwner, so a publisher only sees their own app's artifacts."
```

---

### Task 5: Reconciler for artifacts published before the catalog

**Files:**
- Create: `subgraphs/vetra-apps/artifact-reconciler.ts`
- Modify: `subgraphs/vetra-apps/index.ts` (schedule it on the existing `every(...)` timer helper, `index.ts:121`)
- Test: `subgraphs/vetra-apps/__tests__/artifact-reconciler.test.ts` (create)

**Interfaces:**
- Consumes: `recordArtifact`, `normalizeArtifactName` (Task 2).
- Produces: `reconcileAppArtifacts(deps: ReconcilerDeps): Promise<{ discovered: number }>` where
  `ReconcilerDeps = { db: Kysely<VetraAppsDB>; listHarborImages(project: string): Promise<Array<{ name: string; tag: string; reference: string }>>; now(): Date; logger: Pick<Console, "warn"> }`.

- [ ] **Step 1: Write the failing tests**

Create `subgraphs/vetra-apps/__tests__/artifact-reconciler.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { makeHarness, seedActiveApp, type Harness } from "./harness.js";
import { recordArtifact } from "../artifacts.js";
import { reconcileAppArtifacts } from "../artifact-reconciler.js";

let h: Harness;
beforeEach(async () => { h = await makeHarness(); });
afterEach(async () => { await h.stop(); });

const deps = (h: Harness, images: Array<{ name: string; tag: string; reference: string }>) => ({
  db: h.db,
  listHarborImages: vi.fn(async () => images),
  now: () => new Date("2026-10-07T00:00:00.000Z"),
  logger: { warn: vi.fn() },
});

describe("reconcileAppArtifacts", () => {
  it("catalogues an image that was pushed before the catalog existed", async () => {
    const app = await seedActiveApp(h);
    const d = deps(h, [
      { name: "dtbau-psb", tag: "1.0.0", reference: "cr.vetra.io/p/dtbau-psb:1.0.0" },
    ]);

    expect(await reconcileAppArtifacts(d)).toEqual({ discovered: 1 });

    const row = await h.db.selectFrom("app_artifacts").selectAll().executeTakeFirst();
    expect(row?.name).toBe("dtbau-psb");
    expect(row?.app_id).toBe(app.id);
    // discovered, not registered
    expect(row?.commit_sha).toBeNull();
  });

  // Review Focus 4: discovery must never degrade a registered row.
  it("never overwrites a registered artifact's commit with null", async () => {
    const app = await seedActiveApp(h);
    await recordArtifact(h.db, {
      appId: app.id, kind: "FUSION_IMAGE", name: "dtbau-psb", version: "1.0.0",
      reference: "cr.vetra.io/p/dtbau-psb:1.0.0", channel: "latest",
      commitSha: "abc123", runId: "7", now: "2026-10-06T00:00:00.000Z",
    });

    await reconcileAppArtifacts(
      deps(h, [{ name: "dtbau-psb", tag: "1.0.0", reference: "cr.vetra.io/p/dtbau-psb:1.0.0" }]),
    );

    const row = await h.db.selectFrom("app_artifacts").selectAll().executeTakeFirst();
    expect(row?.commit_sha).toBe("abc123");
  });

  it("keeps going when one app's registry is unreachable", async () => {
    await seedActiveApp(h);
    const d = {
      ...deps(h, []),
      listHarborImages: vi.fn(async () => { throw new Error("harbor down"); }),
    };
    await expect(reconcileAppArtifacts(d)).resolves.toEqual({ discovered: 0 });
    expect(d.logger.warn).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/artifact-reconciler.test.ts`
Expected: FAIL — cannot find module `../artifact-reconciler.js`.

- [ ] **Step 3: Write the implementation**

Create `subgraphs/vetra-apps/artifact-reconciler.ts`:

```ts
import type { Kysely } from "kysely";
import type { VetraAppsDB } from "./db/schema.js";

export interface ReconcilerDeps {
  db: Kysely<VetraAppsDB>;
  listHarborImages(
    project: string,
  ): Promise<Array<{ name: string; tag: string; reference: string }>>;
  now(): Date;
  logger: Pick<Console, "warn">;
}

/**
 * Catalogues artifacts that exist but were never registered: apps that published
 * before this table, or through their own pipelines.
 *
 * A discovered row carries commit_sha = null and must never degrade a registered
 * row, so the insert does nothing on conflict rather than updating. Channels are
 * left alone: discovery cannot know which tag a publisher means by 'latest'.
 */
export async function reconcileAppArtifacts(
  deps: ReconcilerDeps,
): Promise<{ discovered: number }> {
  const apps = await deps.db
    .selectFrom("apps")
    .select(["id", "harbor_project"])
    .where("status", "=", "ACTIVE")
    .execute();

  const now = deps.now().toISOString();
  let discovered = 0;

  for (const app of apps) {
    let images: Array<{ name: string; tag: string; reference: string }>;
    try {
      images = await deps.listHarborImages(app.harbor_project);
    } catch (err) {
      deps.logger.warn(
        `[vetra-apps] artifact reconcile of app ${app.id} failed: ${String(err)}`,
      );
      continue;
    }

    for (const image of images) {
      const result = await deps.db
        .insertInto("app_artifacts")
        .values({
          app_id: app.id,
          kind: "FUSION_IMAGE",
          name: image.name,
          version: image.tag,
          reference: image.reference,
          commit_sha: null,
          run_id: null,
          created_at: now,
        })
        .onConflict((oc) =>
          oc.columns(["app_id", "kind", "name", "version"]).doNothing(),
        )
        .executeTakeFirst();

      if (Number(result?.numInsertedOrUpdatedRows ?? 0) > 0) discovered++;
    }
  }

  return { discovered };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/artifact-reconciler.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Prove the no-clobber guarantee can fail**

Change `doNothing()` to `doUpdateSet({ commit_sha: null })`, re-run, and confirm "never overwrites a registered artifact's commit with null" FAILS. Restore `doNothing()` and confirm green. This is the property the reconciler exists to respect.

- [ ] **Step 6: Schedule it**

In `subgraphs/vetra-apps/index.ts`, beside the other scheduled sweeps that use the `every(...)` helper, add an hourly run. Harbor listing is a new capability on the existing Harbor API client (`subgraphs/vetra-apps/harbor.ts`); if that client has no list method yet, add one named `listImages(project: string)` returning `Array<{ name: string; tag: string; reference: string }>` and wire it here. Reconciliation is best-effort: a failure logs and the next tick retries.

- [ ] **Step 7: Typecheck, lint, full suite, commit**

```bash
npm run tsc && npx oxlint subgraphs/vetra-apps && npx vitest run
git add subgraphs/vetra-apps/artifact-reconciler.ts subgraphs/vetra-apps/index.ts subgraphs/vetra-apps/harbor.ts subgraphs/vetra-apps/__tests__/artifact-reconciler.test.ts
git commit -m "feat(apps): reconcile artifacts published before the catalog

achra and dtbau pushed images through their own pipelines and would otherwise be
invisible to the template builder. Discovered rows carry commit_sha = null and
never overwrite a registered row, so discovery cannot degrade provenance."
```

---

## Done when

- `npx vitest run` is green across the repo.
- `npm run tsc` and `npx oxlint subgraphs/vetra-apps` are clean.
- A CI call to `POST apps/ci/artifacts` catalogues a package and two fusion images for one app, and `appArtifacts(appId:)` returns them grouped with their channel pointers.
- The reconciler catalogues an image pushed outside Vetra without touching registered rows.

Phase 2 (publishing under the app's Renown identity, in the separate `vetra-deploy-action` repo) is what first calls the route this plan adds.
