# Releases phase 1 (server) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Vetra accepts releases and builds from CI (`POST apps/ci/releases`), issues push rights to an org namespace (`POST apps/ci/registry-token`), stores them immutably, and serves them over GraphQL — next to the old deploy path, which keeps running.

**Architecture:** Everything lives in the `vetra-apps` subgraph. A new `releases/` folder holds pure units (version rules, the CI-claim check, the attestation verifier) and the service functions; `db/` gets one table and one column; `ci.ts` gets two routes that reuse the existing Renown CI verification; `schema.ts`/`resolvers.ts` get one query. Nothing in the old deploy path changes.

**Tech Stack:** TypeScript, Kysely (Postgres; PGlite in tests), vitest, Harbor REST API v2.0, GitHub REST API (attestations), `sigstore` (bundle verification), Renown GraphQL.

**Spec:** `docs/superpowers/specs/2026-11-11-app-releases-and-instances-design.md` (sections 3, 4, 14, 15, 18 phase 1). The action (`vetra-publish`) and the console's Releases view are separate plans that build against the contract this plan fixes.

## Global Constraints

- Version rule: a version is a **release** when its prerelease part is empty or matches exactly `^(alpha|beta|rc)\.\d+$`; any other valid semver is a **build**.
- Releases are ordered by semver; builds only among themselves, by run; builds and releases are never compared.
- Image path: `cr.vetra.io/<namespace>/<app-slug>:<version>`. `<namespace>`: org apps use the org's Renown handle, else `o-<first 16 alphanumerics of the org id>`; personal apps use the owner's Renown handle, else `u-<first 16 hex of the owner address>`. Each namespace is claimed for its owner in `registry_namespaces`; a name another owner holds is `FORBIDDEN`; reserved names (`library`, `vetra`, `vetra-cloud-package`, `powerhouse-inc[-*]`, `app-*`, `u-*`, `o-*`) fall back. App slugs are already unique across Vetra (`apps.slug` is `UNIQUE`).
- One Harbor project per namespace, private.
- `POST ci/releases` answers 200 for a version already stored with the same digest, 409 (`VERSION_CONFLICT`) for the same version with another digest.
- Release records are never deleted in phase 1 (build pruning comes with phase 2).
- The old path (`ci/deploy`, `ci/artifacts`, `ci/registry-credentials`, previews) is not touched.
- Two deviations from the spec, to be written back into it in Task 1: builds and releases are ordered by the **verified GitHub run id** from the CI claim (`claim.runId`), not a run number the action reports; Harbor robots only expire in whole days, so the 1-hour push rights are a 1-day robot that a sweeper deletes once it is older than 1 hour.

## File structure

| File | Responsibility |
|---|---|
| `subgraphs/vetra-apps/releases/version.ts` | Parse a version, classify release vs build, compare releases |
| `subgraphs/vetra-apps/releases/claim.ts` | Does a verified CI claim allow reporting this version (repo, commit, branch/PR, event)? |
| `subgraphs/vetra-apps/releases/attestation.ts` | `AttestationVerifier` interface + the GitHub implementation |
| `subgraphs/vetra-apps/releases/namespace.ts` | Resolve an app's registry namespace from Renown |
| `subgraphs/vetra-apps/releases/service.ts` | `ciReportRelease`, `ciRegistryToken`, `appReleasesFor`, `sweepPushRobots` |
| `subgraphs/vetra-apps/releases/repo.ts` | Kysely reads/writes of `releases` and `namespace_push_robots` |
| `subgraphs/vetra-apps/db/schema.ts` | Types for the new table/columns |
| `subgraphs/vetra-apps/db/migrations.ts` | `ensureReleasesTables`, `ensureAppsRegistryNamespaceColumn` |
| `subgraphs/vetra-apps/harbor.ts` | `createNamespacePushRobot(project, durationDays)` |
| `subgraphs/vetra-apps/ci.ts` | Two routes |
| `subgraphs/vetra-apps/index.ts` | Mount routes, start the sweeper, wire deps |
| `subgraphs/vetra-apps/schema.ts`, `resolvers.ts` | `AppRelease` type, `appReleases` query |
| `shared/renown-orgs.ts` | `orgHandle(orgId)`, `personHandle(address)` |
| Tests | `subgraphs/vetra-apps/__tests__/releases-*.test.ts` |

---

### Task 1: Spike — the two external unknowns, then write the findings into the spec

Throwaway code; the deliverable is a short findings note, a recorded attestation fixture, and the spec corrected. Needs: permission to create a private test repo under `powerhouse-inc` and to install the Vetra Deploy GitHub App on it (ask the user first).

**Files:**
- Create: `subgraphs/vetra-apps/__tests__/fixtures/attestation-bundle.json` (recorded from GitHub)
- Create: `docs/superpowers/specs/2026-11-11-releases-phase-1-spike.md`
- Modify: `docs/superpowers/specs/2026-11-11-app-releases-and-instances-design.md` (sections 3 "POST ci/registry-token", 14.17, 15)

- [ ] **Step 1: Renown issues tokens for non-production branches?** In the test repo, add a workflow on `push` to any branch that runs the existing exchange (`powerhouse-inc/vetra-deploy-action@v1`'s `src/exchange.js` logic is enough: GitHub OIDC token with audience `https://renown.vetra.io`, POST to `<renown>/api/@powerhousedao/renown-package/workload/token` with `{subject_token, audience}`) and prints the decoded `vetra` claim. Push to `main` and to a branch `next`. Record for each: whether a token was issued, and `ref`, `refClass`, `eventName`, `runId`, `runAttempt`.

Expected: tokens for both, `ref` = `refs/heads/next`, `runId` numeric. If `next` is refused, stop: this is an external dependency on Renown, add it to spec section 15 and ask the user.

- [ ] **Step 2: Attest an image and read it back.** In the same workflow: build a tiny image (`FROM busybox`), push it to `ghcr.io` (only for the spike), run `actions/attest-build-provenance@v2` with `subject-name` and `subject-digest`. Then from a local shell: `gh api repos/<owner>/<repo>/attestations/sha256:<digest>` and save the first `attestations[0].bundle` to `subgraphs/vetra-apps/__tests__/fixtures/attestation-bundle.json`, with the digest, repo, workflow path and commit noted in the findings.

- [ ] **Step 3: Verify the bundle in Node.** In a scratch file (not committed):

```ts
import { verify } from "sigstore";
import bundle from "./fixtures/attestation-bundle.json" with { type: "json" };
await verify(bundle as never, {
  certificateIssuer: "https://token.actions.githubusercontent.com",
  certificateIdentityURI:
    "https://github.com/<owner>/<repo>/.github/workflows/<file>@refs/heads/main",
});
console.log("verified");
```

Private repos are attested by GitHub's own Sigstore instance: if `verify` fails with an unknown root, fetch GitHub's trusted root (`gh attestation trusted-root > github-trusted-root.jsonl`) and pass it as `trustMaterial`/`tufCachePath` per the `sigstore` README. Record exactly which options verify a private-repo bundle.

- [ ] **Step 4: Write the findings and fix the spec.** `2026-11-11-releases-phase-1-spike.md`: the claim fields per branch, the verify call that works for public and private repos. In the spec: 14.17 reads "highest verified GitHub run id (`claim.runId`)"; the `ci/registry-token` paragraph reads "a Harbor robot valid for 1 day, deleted by Vetra once it is 1 hour old"; drop the `run` field from the `ci/releases` example (the server takes it from the claim); add Renown to section 15 if Step 1 found a limit.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs subgraphs/vetra-apps/__tests__/fixtures/attestation-bundle.json
git commit -m "docs(spec): releases phase 1 spike findings"
```

---

### Task 2: Version rules

**Files:**
- Create: `subgraphs/vetra-apps/releases/version.ts`
- Test: `subgraphs/vetra-apps/__tests__/releases-version.test.ts`

**Interfaces:**
- Produces: `parseVersion(v: string): ParsedVersion | null`; `versionKind(v: string): "release" | "build" | null`; `compareReleases(a: string, b: string): number` (throws on a build); `type ParsedVersion = { major: number; minor: number; patch: number; prerelease: (string | number)[] }`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { compareReleases, parseVersion, versionKind } from "../releases/version.js";

describe("versionKind", () => {
  it("calls plain and alpha/beta/rc.N versions releases", () => {
    for (const v of ["1.4.0", "2.0.0-alpha.0", "2.0.0-beta.12", "2.0.0-rc.1"]) {
      expect(versionKind(v)).toBe("release");
    }
  });
  it("calls every other prerelease a build", () => {
    for (const v of ["1.5.0-main.37", "2.0.0-beta.2-next.12", "1.4.0-pr.12.3", "2.0.0-beta", "2.0.0-rc.1.2"]) {
      expect(versionKind(v)).toBe("build");
    }
  });
  it("rejects what is not semver", () => {
    for (const v of ["v1.4.0", "1.4", "sha-cac9276bc10b", "1.4.0+meta", "01.4.0", ""]) {
      expect(versionKind(v)).toBeNull();
      expect(parseVersion(v)).toBeNull();
    }
  });
});

describe("compareReleases", () => {
  it("orders releases by semver, prereleases before the final", () => {
    const sorted = ["2.0.0", "1.4.1", "2.0.0-beta.2", "2.0.0-rc.1", "2.0.0-beta.10", "2.0.0-alpha.0"]
      .sort(compareReleases);
    expect(sorted).toStrictEqual(["1.4.1", "2.0.0-alpha.0", "2.0.0-beta.2", "2.0.0-beta.10", "2.0.0-rc.1", "2.0.0"]);
  });
  it("refuses to compare a build", () => {
    expect(() => compareReleases("1.5.0-main.37", "1.4.0")).toThrow(/build/);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/releases-version.test.ts`
Expected: FAIL, `Cannot find module '../releases/version.js'`.

- [ ] **Step 3: Implement**

```ts
/**
 * Version rules of the releases spec (section 3): every version is semver
 * (no build metadata, no leading zeros); a release has no prerelease part or
 * exactly alpha|beta|rc.<n>; anything else is a build. Builds are never
 * compared with releases.
 */
export type ParsedVersion = {
  major: number;
  minor: number;
  patch: number;
  prerelease: (string | number)[];
};

const NUM = "(0|[1-9]\\d*)";
const IDENT = "(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)";
const SEMVER = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}(?:-(${IDENT}(?:\\.${IDENT})*))?$`);
const RELEASE_PRE = /^(alpha|beta|rc)\.\d+$/;

export function parseVersion(v: string): ParsedVersion | null {
  const m = SEMVER.exec(v);
  if (!m) return null;
  const prerelease = m[4]
    ? m[4].split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p))
    : [];
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease };
}

export function versionKind(v: string): "release" | "build" | null {
  const m = SEMVER.exec(v);
  if (!m) return null;
  return !m[4] || RELEASE_PRE.test(m[4]) ? "release" : "build";
}

function compareIdent(a: string | number, b: string | number): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "number") return -1;
  if (typeof b === "number") return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Semver order of two releases; throws when either is a build. */
export function compareReleases(a: string, b: string): number {
  if (versionKind(a) !== "release" || versionKind(b) !== "release") {
    throw new Error(`compareReleases: ${a} or ${b} is a build, not a release`);
  }
  const x = parseVersion(a)!;
  const y = parseVersion(b)!;
  for (const k of ["major", "minor", "patch"] as const) {
    if (x[k] !== y[k]) return x[k] - y[k];
  }
  if (!x.prerelease.length || !y.prerelease.length) {
    return y.prerelease.length - x.prerelease.length;
  }
  for (let i = 0; i < Math.max(x.prerelease.length, y.prerelease.length); i++) {
    if (x.prerelease[i] === undefined) return -1;
    if (y.prerelease[i] === undefined) return 1;
    const c = compareIdent(x.prerelease[i]!, y.prerelease[i]!);
    if (c !== 0) return c;
  }
  return 0;
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/releases-version.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add subgraphs/vetra-apps/releases/version.ts subgraphs/vetra-apps/__tests__/releases-version.test.ts
git commit -m "feat(releases): version rules: release vs build, semver order of releases"
```

---

### Task 3: Tables and their reads/writes

**Files:**
- Modify: `subgraphs/vetra-apps/db/schema.ts`, `subgraphs/vetra-apps/db/migrations.ts` (call the new `ensure*` from `up`, after `ensureExternalChangesColumns`)
- Create: `subgraphs/vetra-apps/releases/repo.ts`
- Test: `subgraphs/vetra-apps/__tests__/releases-repo.test.ts`

**Interfaces:**
- Consumes: `isConcurrentIndexError` (db/migrations.ts).
- Produces:
  - `type ReleaseRow` (columns below, `packages`/`requires` as JSON text)
  - `insertRelease(db, row: NewRelease): Promise<{ row: ReleaseRow; created: boolean }>` — on (app_id, version) conflict returns the stored row with `created: false`
  - `listReleases(db, appId, { kind?: "release" | "build"; limit: number }): Promise<ReleaseRow[]>` — newest first by `run` desc
  - `recordPushRobot(db, r: { namespace: string; robotId: number; createdAt: string })`, `pushRobotsOlderThan(db, iso: string)`, `forgetPushRobot(db, robotId: number)`
  - column `apps.registry_namespace varchar(255) null`

- [ ] **Step 1: Write the failing test** (uses the existing harness's PGlite database)

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHarness, seedActiveApp, type Harness } from "./harness.js";
import { insertRelease, listReleases } from "../releases/repo.js";

let h: Harness;
beforeEach(async () => { h = await makeHarness(); });
afterEach(async () => { await h.close(); });

const row = (appId: string, over: Record<string, unknown> = {}) => ({
  app_id: appId, version: "1.4.0", kind: "release" as const, branch: "main", pr: null,
  run: 100, commit: "abc123", notes: "## Fixes", customer_notes: "## Fixes",
  image_ref: "cr.vetra.io/acme/shop:1.4.0", image_digest: "sha256:aa", host: "cli",
  packages: JSON.stringify([]), requires: JSON.stringify({}), migrates: false,
  powerhouse_version: "6.2.3", base_image: "node:24-bookworm-slim@sha256:00",
  created_at: "2026-11-11T10:00:00.000Z", ...over,
});

describe("releases table", () => {
  it("stores a release once and returns the stored row on a repeat", async () => {
    const app = await seedActiveApp(h);
    const first = await insertRelease(h.deps.db, row(app.id));
    const again = await insertRelease(h.deps.db, row(app.id, { image_digest: "sha256:bb" }));
    expect(first.created).toBe(true);
    expect(again).toMatchObject({ created: false, row: { image_digest: "sha256:aa" } });
  });

  it("lists newest first by run, filtered by kind", async () => {
    const app = await seedActiveApp(h);
    await insertRelease(h.deps.db, row(app.id, { version: "1.5.0-main.1", kind: "build", run: 101 }));
    await insertRelease(h.deps.db, row(app.id, { version: "1.4.1", run: 103 }));
    await insertRelease(h.deps.db, row(app.id, { version: "1.5.0-main.2", kind: "build", run: 102 }));
    const all = await listReleases(h.deps.db, app.id, { limit: 10 });
    expect(all.map((r) => r.version)).toStrictEqual(["1.4.1", "1.5.0-main.2", "1.5.0-main.1"]);
    const releases = await listReleases(h.deps.db, app.id, { kind: "release", limit: 10 });
    expect(releases.map((r) => r.version)).toStrictEqual(["1.4.1"]);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/releases-repo.test.ts`
Expected: FAIL, `Cannot find module '../releases/repo.js'`.

- [ ] **Step 3: Schema types** — in `db/schema.ts` add:

```ts
export interface ReleasesTable {
  app_id: string;
  version: string;
  kind: "release" | "build";
  branch: string | null;
  pr: number | null;
  /** The verified GitHub run id (claim.runId): orders builds and releases of a branch. */
  run: number;
  commit: string;
  notes: string | null;
  customer_notes: string | null;
  image_ref: string;
  image_digest: string;
  host: string;
  /** JSON: [{ name, version }] */
  packages: string;
  /** JSON: { powerhouse?, services?, size? } */
  requires: string;
  migrates: boolean;
  /** What the image was built on, for rebuilds after base-layer fixes (spec section 8). */
  powerhouse_version: string;
  base_image: string;
  created_at: string;
}

export interface NamespacePushRobotsTable {
  robot_id: number;
  namespace: string;
  created_at: string;
}
```

Add `registry_namespace: string | null;` to `AppsTable`, and `releases: ReleasesTable; namespace_push_robots: NamespacePushRobotsTable;` to `VetraAppsDB`.

- [ ] **Step 4: Migrations** — in `db/migrations.ts`:

```ts
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

export async function ensureAppsRegistryNamespaceColumn(db: Kysely<any>): Promise<void> {
  try {
    await db.schema.alterTable("apps").addColumn("registry_namespace", "varchar(255)").execute();
  } catch {
    // Column already exists
  }
}
```

And in `up`, after `await ensureExternalChangesColumns(db);`:

```ts
  await ensureReleasesTables(db);
  await ensureAppsRegistryNamespaceColumn(db);
```

- [ ] **Step 5: Reads/writes** — `releases/repo.ts`:

```ts
import type { Insertable, Kysely, Selectable } from "kysely";
import type { ReleasesTable, VetraAppsDB } from "../db/schema.js";

export type ReleaseRow = Selectable<ReleasesTable>;
export type NewRelease = Insertable<ReleasesTable>;

/** Stores a release or build once; a repeat returns the stored row unchanged. */
export async function insertRelease(
  db: Kysely<VetraAppsDB>,
  row: NewRelease,
): Promise<{ row: ReleaseRow; created: boolean }> {
  const inserted = await db
    .insertInto("releases")
    .values(row)
    .onConflict((oc) => oc.columns(["app_id", "version"]).doNothing())
    .returningAll()
    .executeTakeFirst();
  if (inserted) return { row: inserted, created: true };
  const stored = await db
    .selectFrom("releases")
    .selectAll()
    .where("app_id", "=", row.app_id)
    .where("version", "=", row.version)
    .executeTakeFirstOrThrow();
  return { row: stored, created: false };
}

export async function listReleases(
  db: Kysely<VetraAppsDB>,
  appId: string,
  opts: { kind?: "release" | "build"; limit: number },
): Promise<ReleaseRow[]> {
  let q = db.selectFrom("releases").selectAll().where("app_id", "=", appId);
  if (opts.kind) q = q.where("kind", "=", opts.kind);
  return q.orderBy("run", "desc").limit(opts.limit).execute();
}

export async function recordPushRobot(
  db: Kysely<VetraAppsDB>,
  r: { namespace: string; robotId: number; createdAt: string },
): Promise<void> {
  await db
    .insertInto("namespace_push_robots")
    .values({ robot_id: r.robotId, namespace: r.namespace, created_at: r.createdAt })
    .execute();
}

export async function pushRobotsOlderThan(db: Kysely<VetraAppsDB>, iso: string) {
  return db.selectFrom("namespace_push_robots").selectAll().where("created_at", "<", iso).execute();
}

export async function forgetPushRobot(db: Kysely<VetraAppsDB>, robotId: number): Promise<void> {
  await db.deleteFrom("namespace_push_robots").where("robot_id", "=", robotId).execute();
}
```

PGlite returns `bigint` columns as strings: if the test sees `run: "100"`, map `run: Number(r.run)` in `insertRelease`/`listReleases` and keep `run: number` in `ReleaseRow`'s consumers.

- [ ] **Step 6: Run the test and the migrations test**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/releases-repo.test.ts subgraphs/vetra-apps/__tests__/migrations.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add subgraphs/vetra-apps/db subgraphs/vetra-apps/releases/repo.ts subgraphs/vetra-apps/__tests__/releases-repo.test.ts
git commit -m "feat(releases): releases and push-robot tables, apps.registry_namespace"
```

---

### Task 4: Does the CI claim allow this report?

**Files:**
- Create: `subgraphs/vetra-apps/releases/claim.ts`
- Test: `subgraphs/vetra-apps/__tests__/releases-claim.test.ts`

**Interfaces:**
- Consumes: `VetraClaim` (from `../auth.js`: `ref, refClass, eventName, sha, repository, repositoryId, runId, runAttempt, actor, prNumber`); `versionKind` (Task 2).
- Produces: `assertReportAllowed(app: { repository_id: string | null }, claim: VetraClaim | null, report: { kind: "release" | "build"; version: string; branch: string | null; pr: number | null; commit: string }): { run: number }` — throws `appsError("FORBIDDEN" | "BAD_USER_INPUT", …)`.

Rules (verified claim fields only, never `refClass`):
- claim present, `repositoryId` equals the app's, `runId` numeric;
- `commit` equals `claim.sha`;
- `version`'s kind equals `report.kind`;
- a `release` comes from a `push` to `refs/heads/<branch>` and has `pr = null`;
- a `build` comes either from a `push` to `refs/heads/<branch>` (`pr = null`) or from a `pull_request` run of `refs/pull/<pr>/merge` (`branch = null`).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { GraphQLError } from "graphql";
import { claim, REPO_ID } from "./harness.js";
import { assertReportAllowed } from "../releases/claim.js";

const app = { repository_id: REPO_ID };
const sha = "abcdef1234567";
const code = (fn: () => unknown) => {
  try { fn(); return "OK"; } catch (e) { return (e as GraphQLError).extensions?.code; }
};

describe("assertReportAllowed", () => {
  it("allows a release pushed to its branch and returns the run id", () => {
    const c = claim("refs/heads/next", { runId: "412" });
    expect(assertReportAllowed(app, c, { kind: "release", version: "2.0.0-beta.1", branch: "next", pr: null, commit: sha }))
      .toStrictEqual({ run: 412 });
  });
  it("allows branch and PR builds", () => {
    expect(code(() => assertReportAllowed(app, claim("refs/heads/main", { runId: "1" }),
      { kind: "build", version: "1.5.0-main.3", branch: "main", pr: null, commit: sha }))).toBe("OK");
    expect(code(() => assertReportAllowed(app, claim("refs/pull/12/merge", { runId: "2" }),
      { kind: "build", version: "1.5.0-pr.12.1", branch: null, pr: 12, commit: sha }))).toBe("OK");
  });
  it("refuses another repo, another commit, a mismatched branch or PR", () => {
    const ok = { kind: "build" as const, version: "1.5.0-main.3", branch: "main", pr: null, commit: sha };
    expect(code(() => assertReportAllowed(app, claim("refs/heads/main", { runId: "1", repositoryId: "9" }), ok))).toBe("FORBIDDEN");
    expect(code(() => assertReportAllowed(app, claim("refs/heads/main", { runId: "1" }), { ...ok, commit: "other" }))).toBe("FORBIDDEN");
    expect(code(() => assertReportAllowed(app, claim("refs/heads/feature", { runId: "1" }), ok))).toBe("FORBIDDEN");
    expect(code(() => assertReportAllowed(app, claim("refs/pull/13/merge", { runId: "1" }),
      { ...ok, branch: null, pr: 12 }))).toBe("FORBIDDEN");
  });
  it("refuses a release from a PR and a kind that does not match the version", () => {
    expect(code(() => assertReportAllowed(app, claim("refs/pull/12/merge", { runId: "1" }),
      { kind: "release", version: "1.5.0", branch: null, pr: 12, commit: sha }))).toBe("FORBIDDEN");
    expect(code(() => assertReportAllowed(app, claim("refs/heads/main", { runId: "1" }),
      { kind: "release", version: "1.5.0-main.3", branch: "main", pr: null, commit: sha }))).toBe("BAD_USER_INPUT");
  });
  it("refuses a token without a claim or a run id", () => {
    const ok = { kind: "build" as const, version: "1.5.0-main.3", branch: "main", pr: null, commit: sha };
    expect(code(() => assertReportAllowed(app, null, ok))).toBe("FORBIDDEN");
    expect(code(() => assertReportAllowed(app, claim("refs/heads/main"), ok))).toBe("FORBIDDEN");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/releases-claim.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
import type { VetraClaim } from "../auth.js";
import { appsError } from "../errors.js";
import { versionKind } from "./version.js";

export interface ReportFacts {
  kind: "release" | "build";
  version: string;
  branch: string | null;
  pr: number | null;
  commit: string;
}

/**
 * A CI token may report only what its own run built: the app's repository,
 * the run's commit, its branch (push) or PR (pull_request). Uses the
 * verified claim fields only; Renown's refClass is not consulted, so any
 * pushed branch can publish. Returns the run id that orders the record.
 */
export function assertReportAllowed(
  app: { repository_id: string | null },
  claim: VetraClaim | null,
  r: ReportFacts,
): { run: number } {
  if (!claim) throw appsError("FORBIDDEN", "Token carries no vetra claim");
  if (!app.repository_id || claim.repositoryId !== app.repository_id)
    throw appsError("FORBIDDEN", "Token was minted for another repository");
  const run = Number(claim.runId);
  if (!claim.runId || !Number.isSafeInteger(run))
    throw appsError("FORBIDDEN", "Token carries no run id");
  if (claim.sha !== r.commit)
    throw appsError("FORBIDDEN", `Token was minted for commit ${claim.sha ?? "?"}, not ${r.commit}`);
  const kind = versionKind(r.version);
  if (!kind) throw appsError("BAD_USER_INPUT", `${r.version} is not a valid version`);
  if (kind !== r.kind)
    throw appsError("BAD_USER_INPUT", `${r.version} is a ${kind}, reported as a ${r.kind}`);

  const fromBranch =
    r.pr === null && !!r.branch && claim.eventName === "push" && claim.ref === `refs/heads/${r.branch}`;
  const fromPr =
    r.branch === null && r.pr !== null && claim.eventName === "pull_request" &&
    claim.ref === `refs/pull/${r.pr}/merge`;
  if (r.kind === "release" ? !fromBranch : !(fromBranch || fromPr)) {
    throw appsError(
      "FORBIDDEN",
      `Token for ${claim.ref} (${claim.eventName ?? "?"}) cannot report a ${r.kind} for ${r.branch ?? `PR #${r.pr}`}`,
    );
  }
  return { run };
}
```

If `appsError` lives elsewhere, import it from where `service.ts` imports it (`grep -n "appsError" subgraphs/vetra-apps/service.ts | head -1`).

- [ ] **Step 4: Run it to see it pass**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/releases-claim.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add subgraphs/vetra-apps/releases/claim.ts subgraphs/vetra-apps/__tests__/releases-claim.test.ts
git commit -m "feat(releases): CI claim check for reported releases and builds"
```

---

### Task 5: Attestation verifier

**Files:**
- Create: `subgraphs/vetra-apps/releases/attestation.ts`
- Test: `subgraphs/vetra-apps/__tests__/releases-attestation.test.ts`
- Modify: `package.json` (add `sigstore`)

**Interfaces:**
- Consumes: the spike's working `verify` options (Task 1 findings); the fixture `__tests__/fixtures/attestation-bundle.json`.
- Produces:
  - `interface AttestationVerifier { verify(i: { repository: string; digest: string; commit: string }): Promise<void> }` — throws `appsError("FORBIDDEN", reason)` when no valid attestation exists
  - `createGithubAttestationVerifier(opts: { token: (repository: string) => Promise<string>; fetch?: typeof fetch; verifyBundle?: (bundle: unknown, identity: { issuer: string; identityURI: RegExp }) => Promise<void> }): AttestationVerifier`

Policy: at least one attestation of `sha256:<digest>` in the repo whose certificate was issued by `https://token.actions.githubusercontent.com` to `https://github.com/<repository>/.github/workflows/vetra.yml@refs/...`, and whose provenance names `commit`.

- [ ] **Step 1: Add the dependency**

Run: `npm install sigstore@^3 --save`

- [ ] **Step 2: Write the failing test** (network-free: GitHub's API faked, the real bundle verified when the fixture's identity matches)

```ts
import { describe, expect, it } from "vitest";
import { createGithubAttestationVerifier } from "../releases/attestation.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("GitHub attestation verifier", () => {
  it("accepts an image with a valid attestation from the repo's vetra.yml at the commit", async () => {
    const seen: unknown[] = [];
    const v = createGithubAttestationVerifier({
      token: async () => "inst-token",
      fetch: (async (url: string) => {
        expect(url).toBe("https://api.github.com/repos/acme/shop/attestations/sha256:aa");
        return json({ attestations: [{ bundle: { provenanceCommit: "abc" } }] });
      }) as never,
      verifyBundle: async (bundle, identity) => {
        seen.push(identity.identityURI.source);
        if ((bundle as { provenanceCommit: string }).provenanceCommit !== "abc") throw new Error("commit");
      },
    });
    await expect(v.verify({ repository: "acme/shop", digest: "sha256:aa", commit: "abc" })).resolves.toBeUndefined();
    expect(String(seen[0])).toContain("acme\\/shop\\/\\.github\\/workflows\\/vetra\\.yml@");
  });

  it("refuses an image GitHub has no attestation for", async () => {
    const v = createGithubAttestationVerifier({
      token: async () => "t",
      fetch: (async () => json({ message: "Not Found" }, 404)) as never,
      verifyBundle: async () => {},
    });
    await expect(v.verify({ repository: "acme/shop", digest: "sha256:aa", commit: "abc" }))
      .rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });

  it("refuses when every bundle fails verification", async () => {
    const v = createGithubAttestationVerifier({
      token: async () => "t",
      fetch: (async () => json({ attestations: [{ bundle: {} }, { bundle: {} }] })) as never,
      verifyBundle: async () => { throw new Error("bad signature"); },
    });
    await expect(v.verify({ repository: "acme/shop", digest: "sha256:aa", commit: "abc" }))
      .rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/releases-attestation.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement**

```ts
import { verify as sigstoreVerify } from "sigstore";
import { appsError } from "../errors.js";

export interface AttestationVerifier {
  verify(i: { repository: string; digest: string; commit: string }): Promise<void>;
}

type VerifyBundle = (
  bundle: unknown,
  identity: { issuer: string; identityURI: RegExp; commit: string },
) => Promise<void>;

const ISSUER = "https://token.actions.githubusercontent.com";
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * The image was built and attested by the repo's own vetra.yml workflow at
 * the reported commit (GitHub artifact attestations, spec section 3). Bundles
 * come from GitHub's attestations API with the Vetra GitHub App's
 * installation token, so private repos work.
 */
export function createGithubAttestationVerifier(opts: {
  token: (repository: string) => Promise<string>;
  fetch?: typeof fetch;
  verifyBundle?: VerifyBundle;
}): AttestationVerifier {
  const fetchImpl = opts.fetch ?? fetch;
  const verifyBundle: VerifyBundle =
    opts.verifyBundle ??
    (async (bundle, identity) => {
      // Options as found in the Task 1 spike (GitHub's trust root for private repos).
      await sigstoreVerify(bundle as never, {
        certificateIssuer: identity.issuer,
        certificateIdentityURI: undefined,
      } as never);
      const uri = certificateIdentity(bundle);
      if (!identity.identityURI.test(uri)) throw new Error(`signed by ${uri}`);
      if (provenanceCommit(bundle) !== identity.commit) throw new Error("another commit");
    });

  return {
    async verify({ repository, digest, commit }) {
      const res = await fetchImpl(
        `https://api.github.com/repos/${repository}/attestations/${digest}`,
        {
          headers: {
            authorization: `Bearer ${await opts.token(repository)}`,
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
          },
        },
      );
      if (!res.ok) throw appsError("FORBIDDEN", `No attestation for ${digest} in ${repository}`);
      const body = (await res.json()) as { attestations?: { bundle: unknown }[] };
      const identity = {
        issuer: ISSUER,
        identityURI: new RegExp(`^https://github\\.com/${escape(repository)}/\\.github/workflows/vetra\\.yml@`),
        commit,
      };
      const reasons: string[] = [];
      for (const a of body.attestations ?? []) {
        try {
          await verifyBundle(a.bundle, identity);
          return;
        } catch (err) {
          reasons.push(String(err));
        }
      }
      throw appsError("FORBIDDEN", `No valid attestation for ${digest}: ${reasons.join("; ") || "none"}`);
    },
  };
}

/** The signing certificate's SAN URI (the workflow ref that signed). */
function certificateIdentity(bundle: unknown): string {
  // Filled in from the Task 1 fixture: the path to the leaf certificate in a
  // v0.3 bundle is verificationMaterial.certificate.rawBytes (base64 DER);
  // read its URI SAN with node:crypto's X509Certificate#subjectAltName.
  throw new Error(`certificateIdentity: implement per spike (${typeof bundle})`);
}

/** The commit named in the SLSA provenance predicate. */
function provenanceCommit(bundle: unknown): string {
  // dsseEnvelope.payload (base64) → in-toto statement →
  // predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit
  throw new Error(`provenanceCommit: implement per spike (${typeof bundle})`);
}
```

Then replace the two helper bodies with the real extraction, using the fixture to check: add a fourth test that runs the default `verifyBundle` against `fixtures/attestation-bundle.json` with the repo, workflow and commit recorded in the spike findings, expecting it to pass, and with another commit, expecting FORBIDDEN.

```ts
import { X509Certificate } from "node:crypto";

function certificateIdentity(bundle: unknown): string {
  const b = bundle as { verificationMaterial?: { certificate?: { rawBytes?: string } } };
  const raw = b.verificationMaterial?.certificate?.rawBytes;
  if (!raw) throw new Error("bundle has no certificate");
  const san = new X509Certificate(Buffer.from(raw, "base64")).subjectAltName ?? "";
  const uri = /URI:([^,\s]+)/.exec(san)?.[1];
  if (!uri) throw new Error("certificate has no URI SAN");
  return uri;
}

function provenanceCommit(bundle: unknown): string {
  const b = bundle as { dsseEnvelope?: { payload?: string } };
  const payload = b.dsseEnvelope?.payload;
  if (!payload) throw new Error("bundle has no DSSE payload");
  const statement = JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as {
    predicate?: { buildDefinition?: { resolvedDependencies?: { digest?: { gitCommit?: string } }[] } };
  };
  const commit = statement.predicate?.buildDefinition?.resolvedDependencies?.[0]?.digest?.gitCommit;
  if (!commit) throw new Error("provenance names no commit");
  return commit;
}
```

Set the `sigstoreVerify` options to exactly what Task 1 recorded (drop the `as never` casts once typed).

- [ ] **Step 5: Run it to see it pass**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/releases-attestation.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json subgraphs/vetra-apps/releases/attestation.ts subgraphs/vetra-apps/__tests__/releases-attestation.test.ts
git commit -m "feat(releases): verify GitHub artifact attestations of reported images"
```

---

### Task 6: Registry namespace

**Files:**
- Modify: `shared/renown-orgs.ts` (two lookups), its test file (`grep -rln "createRenownOrgs" shared` for the existing test)
- Create: `subgraphs/vetra-apps/releases/namespace.ts`
- Test: `subgraphs/vetra-apps/__tests__/releases-namespace.test.ts`

**Interfaces:**
- Produces:
  - `RenownOrgs.orgHandle(orgId: string): Promise<string | null>` — Renown `organization(id) { handle }` on `orgsEndpoint`
  - `RenownOrgs.personHandle(address: string): Promise<string | null>` — Renown `renownUsers(input: { ethAddresses: [a] }) { handle }` on the Renown switchboard GraphQL (`orgsEndpoint` with `/renown-orgs` cut off)
  - `resolveNamespace(app: { owner_org_id: string | null; owner_address: string }, orgs: Pick<RenownOrgs, "orgHandle" | "personHandle"> | null): Promise<string>`
  - `ensureAppNamespace(deps, app): Promise<string>` — returns `apps.registry_namespace`, setting it on first use (never changes in phase 1; transfers are phase 3)

Rules: Harbor project names must be lowercase `[a-z0-9._-]`, 2–255 characters, starting with a letter or digit; a handle is lower-cased and checked against that; anything else falls back to `u-<first 8 hex of the owner address>` (for an org app: `o-<first 8 chars of the org id, alphanumerics only>`).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { resolveNamespace } from "../releases/namespace.js";

const orgs = (o: string | null, p: string | null) => ({
  orgHandle: async () => o,
  personHandle: async () => p,
});
const personal = { owner_org_id: null, owner_address: "0x2BbEa0145d6fb9C6709a74C1179Ca0be71bb3aC6" };
const org = { owner_org_id: "org-7f3a9c1b2d", owner_address: personal.owner_address };

describe("resolveNamespace", () => {
  it("uses the org's handle for an org app", async () => {
    expect(await resolveNamespace(org, orgs("Sektar", "frank"))).toBe("sektar");
  });
  it("uses the owner's handle for a personal app", async () => {
    expect(await resolveNamespace(personal, orgs(null, "frank"))).toBe("frank");
  });
  it("falls back when there is no usable handle", async () => {
    expect(await resolveNamespace(personal, orgs(null, null))).toBe("u-2bbea014");
    expect(await resolveNamespace(personal, orgs(null, "Frank Ü"))).toBe("u-2bbea014");
    expect(await resolveNamespace(org, orgs(null, "frank"))).toBe("o-org7f3a9");
    expect(await resolveNamespace(personal, null)).toBe("u-2bbea014");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/releases-namespace.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `namespace.ts`**

```ts
import type { RenownOrgs } from "../../../shared/renown-orgs.js";

const HARBOR_NAME = /^[a-z0-9][a-z0-9._-]{1,254}$/;

/** The Harbor project an app's images live in (spec section 3, image naming). */
export async function resolveNamespace(
  app: { owner_org_id: string | null; owner_address: string },
  orgs: Pick<RenownOrgs, "orgHandle" | "personHandle"> | null,
): Promise<string> {
  const usable = (h: string | null | undefined) => {
    const lower = h?.trim().toLowerCase() ?? "";
    return HARBOR_NAME.test(lower) ? lower : null;
  };
  if (app.owner_org_id) {
    const handle = usable(await orgs?.orgHandle(app.owner_org_id).catch(() => null));
    return handle ?? `o-${app.owner_org_id.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 8)}`;
  }
  const handle = usable(await orgs?.personHandle(app.owner_address).catch(() => null));
  return handle ?? `u-${app.owner_address.toLowerCase().replace(/^0x/, "").slice(0, 8)}`;
}
```

and below it:

```ts
import type { AppsDeps } from "../service.js";
import type { AppRow } from "../repo.js";

/** The app's namespace, fixed on first use. */
export async function ensureAppNamespace(deps: AppsDeps, app: AppRow): Promise<string> {
  if (app.registry_namespace) return app.registry_namespace;
  const ns = await resolveNamespace(app, deps.orgs ?? null);
  await deps.db
    .updateTable("apps")
    .set({ registry_namespace: ns })
    .where("id", "=", app.id)
    .where("registry_namespace", "is", null)
    .execute();
  const row = await deps.db.selectFrom("apps").select("registry_namespace").where("id", "=", app.id).executeTakeFirstOrThrow();
  return row.registry_namespace ?? ns;
}
```

- [ ] **Step 4: Add the two lookups to `shared/renown-orgs.ts`** — extend the `RenownOrgs` interface with:

```ts
  /** The org's Renown handle; null when unknown or the org has none. */
  orgHandle(orgId: string): Promise<string | null>;
  /** The person's Renown handle; null without a profile or handle. */
  personHandle(address: string): Promise<string | null>;
```

Implement both next to `orgApps` in the factory, following its `gql` + `TtlLru` pattern (same positive/negative TTLs), with these queries:

```ts
const ORG_HANDLE = `query ($id: String!) { organization(id: $id) { handle } }`;
const PERSON_HANDLE = `query ($input: RenownUsersInput!) { renownUsers(input: $input) { handle } }`;
```

`personHandle` posts to `cfg.orgsEndpoint.replace(/\/renown-orgs$/, "")` with `{ input: { ethAddresses: [address.toLowerCase()] } }` and returns `renownUsers[0]?.handle ?? null`. Add one test each in the existing renown-orgs test file using its fake-fetch helper: a handle returned, and null on an empty answer.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/releases-namespace.test.ts shared`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add shared/renown-orgs.ts shared subgraphs/vetra-apps/releases/namespace.ts subgraphs/vetra-apps/__tests__/releases-namespace.test.ts
git commit -m "feat(releases): registry namespace from Renown org or person handle"
```

---

### Task 7: `POST apps/ci/registry-token`

**Files:**
- Modify: `subgraphs/vetra-apps/harbor.ts` (`createNamespacePushRobot`), `__tests__/harness.ts` (`fakeHarbor` gains it)
- Create: `subgraphs/vetra-apps/releases/service.ts` (first two functions)
- Modify: `subgraphs/vetra-apps/ci.ts` (route), `subgraphs/vetra-apps/index.ts` (mount + sweeper)
- Test: `subgraphs/vetra-apps/__tests__/releases-registry-token.test.ts`

**Interfaces:**
- Consumes: `authorizeCi` (export it from `service.ts`: `export async function authorizeCi`), `ensureAppNamespace` (Task 6), `recordPushRobot`/`pushRobotsOlderThan`/`forgetPushRobot` (Task 3).
- Produces:
  - `HarborApi.createNamespacePushRobot(project: string, durationDays: number): Promise<{ id: number; name: string; secret: string }>`
  - `ciRegistryToken(deps, ci, appId): Promise<{ registry: string; username: string; password: string; repository: string; expiresAt: string }>`
  - `sweepPushRobots(deps): Promise<number>` — deletes robots older than 1 hour, returns how many

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ciIdentity, claim, makeHarness, seedActiveApp, type Harness } from "./harness.js";
import { ciRegistryToken, sweepPushRobots } from "../releases/service.js";

let h: Harness;
beforeEach(async () => { h = await makeHarness(); });
afterEach(async () => { await h.close(); });

describe("ciRegistryToken", () => {
  it("creates the namespace's project once and a 1-day robot per call, scoped to the app", async () => {
    const app = await seedActiveApp(h);
    h.deps.orgs = { orgHandle: async () => null, personHandle: async () => "acme" } as never;
    const ci = ciIdentity(claim("refs/heads/main", { runId: "1" }));
    const a = await ciRegistryToken(h.deps, ci, app.id);
    const b = await ciRegistryToken(h.deps, ci, app.id);
    expect(a).toMatchObject({ registry: "cr.vetra.io", repository: `acme/${app.slug}` });
    expect(a.password).not.toBe(b.password);
    expect(h.harbor.projects.filter((p) => p === "acme")).toHaveLength(1);
    expect(h.harbor.namespaceRobots.map((r) => [r.project, r.durationDays])).toStrictEqual([["acme", 1], ["acme", 1]]);
    expect(Date.parse(a.expiresAt) - h.deps.now().getTime()).toBe(60 * 60 * 1000);
  });

  it("refuses another app's identity", async () => {
    const app = await seedActiveApp(h);
    const ci = { ...ciIdentity(claim("refs/heads/main")), appDid: "did:key:other" };
    await expect(ciRegistryToken(h.deps, ci, app.id)).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });

  it("the sweeper deletes robots older than an hour", async () => {
    const app = await seedActiveApp(h);
    h.deps.orgs = { orgHandle: async () => null, personHandle: async () => "acme" } as never;
    await ciRegistryToken(h.deps, ciIdentity(claim("refs/heads/main")), app.id);
    expect(await sweepPushRobots(h.deps)).toBe(0);
    h.advance(61 * 60 * 1000);
    expect(await sweepPushRobots(h.deps)).toBe(1);
    expect(h.harbor.deletedRobots).toHaveLength(1);
  });
});
```

If the harness has no `advance`, add one: the harness's `deps.now` reads a mutable `clock` variable; `advance(ms)` moves it. Check `fakeHarbor` (harness.ts:434) for the names of its recorded `projects`/`deletedRobots` arrays and use those names in the test; add `namespaceRobots: { project, durationDays, id }[]` to it with `createNamespacePushRobot` pushing to it and returning `{ id, name: \`robot$\${project}+vetra-ci-\${id}\`, secret: \`s-\${id}\` }`.

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/releases-registry-token.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Harbor** — in `harbor.ts`, add to the interface:

```ts
  /** A push+pull robot on `project` expiring after `durationDays` (Harbor counts whole days). */
  createNamespacePushRobot(
    project: string,
    durationDays: number,
  ): Promise<{ id: number; name: string; secret: string }>;
```

and to the factory (same body as `createPushRobot`, with `name: \`vetra-ci-${randomBytes(4).toString("hex")}\``, `description: "Vetra CI push token"`, `duration: durationDays`).

- [ ] **Step 4: Service** — `releases/service.ts`:

```ts
import { authorizeCi, type AppsDeps, type CiIdentity } from "../service.js";
import { notConfigured } from "../errors.js";
import { HARBOR_HOST } from "../repo.js";
import { ensureAppNamespace } from "./namespace.js";
import { forgetPushRobot, pushRobotsOlderThan, recordPushRobot } from "./repo.js";

const PUSH_TOKEN_MS = 60 * 60 * 1000;

/** Push rights on the app's namespace for one CI run (spec: POST ci/registry-token). */
export async function ciRegistryToken(deps: AppsDeps, ci: CiIdentity, appId: string) {
  const app = await authorizeCi(deps, ci, appId);
  if (!deps.harbor) throw notConfigured("Harbor (HARBOR_APPS_ADMIN_*)");
  const namespace = await ensureAppNamespace(deps, app);
  await deps.harbor.createProject(namespace); // false = exists: fine, it is ours by name
  const robot = await deps.harbor.createNamespacePushRobot(namespace, 1);
  const now = deps.now();
  await recordPushRobot(deps.db, { namespace, robotId: robot.id, createdAt: now.toISOString() });
  return {
    registry: HARBOR_HOST,
    username: robot.name,
    password: robot.secret,
    repository: `${namespace}/${app.slug}`,
    expiresAt: new Date(now.getTime() + PUSH_TOKEN_MS).toISOString(),
  };
}

/** Deletes push robots older than an hour; Harbor itself only expires them after a day. */
export async function sweepPushRobots(deps: AppsDeps): Promise<number> {
  if (!deps.harbor) return 0;
  const cutoff = new Date(deps.now().getTime() - PUSH_TOKEN_MS).toISOString();
  let n = 0;
  for (const r of await pushRobotsOlderThan(deps.db, cutoff)) {
    try {
      await deps.harbor.deleteRobot(r.robot_id);
      await forgetPushRobot(deps.db, r.robot_id);
      n++;
    } catch (err) {
      deps.logger.warn(`[vetra-apps] push robot ${r.robot_id} not deleted: ${String(err)}`);
    }
  }
  return n;
}
```

Use the real import locations of `HARBOR_HOST` and `notConfigured` (`grep -n "export const HARBOR_HOST\|export function notConfigured\|export const notConfigured" subgraphs/vetra-apps/*.ts`). Note: the `createProject` 409 case means a project of that name exists; in phase 1 that is only ever ours (Vetra is the only writer of `cr.vetra.io` projects named after Renown handles).

- [ ] **Step 5: Route and sweeper** — in `ci.ts`, inside the object `createCiRoutes` returns:

```ts
    registryToken: (request: Request) =>
      run(request, async (ci) => {
        const body = await jsonBody(request);
        return ciRegistryToken(deps, ci, requireString(body, "appId"));
      }),
```

(import `ciRegistryToken` from `./releases/service.js`; add `POST apps/ci/registry-token {appId}` to the route list in the file's header comment). In `index.ts`, next to the existing CI route registrations:

```ts
        this.http.post("apps/ci/registry-token", json, (request) =>
          ci.registryToken(request),
        ),
```

and with the other timers in `onSetup` (follow how `this.timers.push(setInterval(...))` is used there):

```ts
    this.timers.push(
      setInterval(() => {
        void sweepPushRobots(deps).catch((err) =>
          console.warn(`[vetra-apps] push robot sweep failed: ${String(err)}`),
        );
      }, 5 * 60 * 1000),
    );
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/releases-registry-token.test.ts subgraphs/vetra-apps/__tests__/ci.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add subgraphs/vetra-apps/harbor.ts subgraphs/vetra-apps/releases/service.ts subgraphs/vetra-apps/ci.ts subgraphs/vetra-apps/index.ts subgraphs/vetra-apps/service.ts subgraphs/vetra-apps/__tests__
git commit -m "feat(releases): ci/registry-token: per-run push rights on the app's namespace"
```

---

### Task 8: `POST apps/ci/releases`

**Files:**
- Modify: `subgraphs/vetra-apps/releases/service.ts` (`ciReportRelease`), `subgraphs/vetra-apps/service.ts` (`AppsDeps.attestations?: AttestationVerifier | null`), `subgraphs/vetra-apps/ci.ts`, `subgraphs/vetra-apps/index.ts`
- Test: `subgraphs/vetra-apps/__tests__/releases-report.test.ts`

**Interfaces:**
- Consumes: `assertReportAllowed` (Task 4), `AttestationVerifier` (Task 5), `ensureAppNamespace` (Task 6), `insertRelease` (Task 3), `authorizeCi`.
- Produces: `ciReportRelease(deps, ci, input: ReportReleaseInput): Promise<ReleaseJson>` where

```ts
export interface ReportReleaseInput {
  appId: string;
  version: string;
  kind: "release" | "build";
  branch: string | null;
  pr: number | null;
  commit: string;
  notes: string | null;
  image: { ref: string; digest: string; host: string };
  packages: { name: string; version: string }[];
  requires: { powerhouse?: string; services?: string[]; size?: string };
  migrates: boolean;
  /** What the image was built on: the project's Powerhouse version and the base image digest. */
  built: { powerhouse: string; baseImage: string };
}
export interface ReleaseJson {
  appId: string; version: string; kind: "release" | "build"; branch: string | null; pr: number | null;
  run: number; commit: string; notes: string | null; customerNotes: string | null;
  image: { ref: string; digest: string; host: string };
  packages: { name: string; version: string }[];
  requires: { powerhouse?: string; services?: string[]; size?: string };
  migrates: boolean; built: { powerhouse: string; baseImage: string }; createdAt: string;
}
```

Checks, in order: `authorizeCi`; `assertReportAllowed` (gives `run`); `image.ref` must equal `cr.vetra.io/<namespace>/<slug>:<version>`; `image.digest` matches `^sha256:[a-f0-9]{64}$`; `host` matches `^[a-z][a-z0-9-]{0,63}$`; each package version equals `version`; `notes` only for a release; attestation verified (skipped only when `deps.attestations` is null and `cfg.allowUnattestedReleases` is true, a test/dev flag); insert; on a repeat: same digest → the stored record, other digest → `VERSION_CONFLICT` (409).

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ciIdentity, claim, makeHarness, seedActiveApp, type Harness } from "./harness.js";
import { ciReportRelease } from "../releases/service.js";

let h: Harness;
let app: Awaited<ReturnType<typeof seedActiveApp>>;
const verified: unknown[] = [];
beforeEach(async () => {
  h = await makeHarness();
  app = await seedActiveApp(h);
  h.deps.orgs = { orgHandle: async () => null, personHandle: async () => "acme" } as never;
  verified.length = 0;
  h.deps.attestations = { verify: async (i) => { verified.push(i); } };
});
afterEach(async () => { await h.close(); });

const SHA = "abcdef1234567";
const DIGEST = `sha256:${"a".repeat(64)}`;
const input = (over: Record<string, unknown> = {}) => ({
  appId: app.id, version: "1.5.0", kind: "release" as const, branch: "main", pr: null, commit: SHA,
  notes: "## Features\n- x", image: { ref: `cr.vetra.io/acme/${app.slug}:1.5.0`, digest: DIGEST, host: "cli" },
  packages: [{ name: "@acme/shop", version: "1.5.0" }], requires: { powerhouse: ">=6.2.3" }, migrates: true,
  built: { powerhouse: "6.2.3", baseImage: "node:24-bookworm-slim@sha256:00" },
  ...over,
});
const ci = (ref = "refs/heads/main", runId = "500") => ciIdentity(claim(ref, { runId }));

describe("ciReportRelease", () => {
  it("stores a verified release with the claim's run id and returns it", async () => {
    const out = await ciReportRelease(h.deps, ci(), input());
    expect(out).toMatchObject({ version: "1.5.0", kind: "release", run: 500, customerNotes: "## Features\n- x", migrates: true });
    expect(verified).toStrictEqual([{ repository: "acme/shop", digest: DIGEST, commit: SHA }]);
  });

  it("is a no-op on a re-run with the same digest, a conflict with another", async () => {
    await ciReportRelease(h.deps, ci(), input());
    await expect(ciReportRelease(h.deps, ci("refs/heads/main", "501"), input())).resolves.toMatchObject({ run: 500 });
    await expect(ciReportRelease(h.deps, ci(), input({ image: { ref: `cr.vetra.io/acme/${app.slug}:1.5.0`, digest: `sha256:${"b".repeat(64)}`, host: "cli" } })))
      .rejects.toMatchObject({ extensions: { code: "VERSION_CONFLICT" } });
  });

  it("refuses an image outside the app's repository or under another tag", async () => {
    for (const ref of [`cr.vetra.io/other/${app.slug}:1.5.0`, `cr.vetra.io/acme/${app.slug}:1.5.1`, `ghcr.io/acme/${app.slug}:1.5.0`]) {
      await expect(ciReportRelease(h.deps, ci(), input({ image: { ref, digest: DIGEST, host: "cli" } })))
        .rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    }
  });

  it("refuses packages at another version and notes on a build", async () => {
    await expect(ciReportRelease(h.deps, ci(), input({ packages: [{ name: "@acme/shop", version: "1.4.0" }] })))
      .rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    await expect(ciReportRelease(h.deps, ci(), input({ version: "1.5.0-main.4", kind: "build",
      image: { ref: `cr.vetra.io/acme/${app.slug}:1.5.0-main.4`, digest: DIGEST, host: "cli" },
      packages: [] })))
      .rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
  });

  it("stores nothing when the attestation fails", async () => {
    h.deps.attestations = { verify: async () => { throw Object.assign(new Error("no"), { extensions: { code: "FORBIDDEN" } }); } };
    await expect(ciReportRelease(h.deps, ci(), input())).rejects.toBeTruthy();
    const rows = await h.deps.db.selectFrom("releases").selectAll().execute();
    expect(rows).toHaveLength(0);
  });
});
```

Use the real `appsError("FORBIDDEN", …)` in the failing verifier if a plain error with `extensions` does not propagate as such; the assertion only needs "rejects and stores nothing".

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/releases-report.test.ts`
Expected: FAIL, `ciReportRelease` is not exported.

- [ ] **Step 3: Implement** — append to `releases/service.ts`:

```ts
import { appsError } from "../errors.js";
import { assertReportAllowed } from "./claim.js";
import { insertRelease, type ReleaseRow } from "./repo.js";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const HOST = /^[a-z][a-z0-9-]{0,63}$/;

export function releaseJson(r: ReleaseRow): ReleaseJson {
  return {
    appId: r.app_id, version: r.version, kind: r.kind, branch: r.branch, pr: r.pr,
    run: Number(r.run), commit: r.commit, notes: r.notes, customerNotes: r.customer_notes,
    image: { ref: r.image_ref, digest: r.image_digest, host: r.host },
    packages: JSON.parse(r.packages) as ReleaseJson["packages"],
    requires: JSON.parse(r.requires) as ReleaseJson["requires"],
    migrates: r.migrates, built: { powerhouse: r.powerhouse_version, baseImage: r.base_image },
    createdAt: r.created_at,
  };
}

/** Records a release or build CI built and attested (spec: POST ci/releases). */
export async function ciReportRelease(
  deps: AppsDeps,
  ci: CiIdentity,
  input: ReportReleaseInput,
): Promise<ReleaseJson> {
  const app = await authorizeCi(deps, ci, input.appId);
  const { run } = assertReportAllowed(app, ci.claim, input);

  const namespace = await ensureAppNamespace(deps, app);
  const expectedRef = `${HARBOR_HOST}/${namespace}/${app.slug}:${input.version}`;
  if (input.image.ref !== expectedRef)
    throw appsError("BAD_USER_INPUT", `image.ref must be ${expectedRef}`);
  if (!DIGEST.test(input.image.digest))
    throw appsError("BAD_USER_INPUT", "image.digest must be sha256:<64 hex>");
  if (!HOST.test(input.image.host))
    throw appsError("BAD_USER_INPUT", "image.host must name a host (e.g. cli)");
  const off = input.packages.find((p) => p.version !== input.version);
  if (off) throw appsError("BAD_USER_INPUT", `${off.name}@${off.version} is not at ${input.version}`);
  if (input.kind === "build" && input.notes)
    throw appsError("BAD_USER_INPUT", "Only a release carries notes");
  if (!input.built.powerhouse || !input.built.baseImage)
    throw appsError("BAD_USER_INPUT", "built.powerhouse and built.baseImage are required");

  if (deps.attestations) {
    await deps.attestations.verify({
      repository: app.repository_full_name ?? "",
      digest: input.image.digest,
      commit: input.commit,
    });
  } else if (!deps.cfg.allowUnattestedReleases) {
    throw notConfigured("GitHub attestation verification");
  }

  const { row, created } = await insertRelease(deps.db, {
    app_id: app.id, version: input.version, kind: input.kind, branch: input.branch, pr: input.pr,
    run, commit: input.commit, notes: input.notes, customer_notes: input.notes,
    image_ref: input.image.ref, image_digest: input.image.digest, host: input.image.host,
    packages: JSON.stringify(input.packages), requires: JSON.stringify(input.requires),
    migrates: input.migrates, powerhouse_version: input.built.powerhouse,
    base_image: input.built.baseImage, created_at: deps.now().toISOString(),
  });
  if (!created && row.image_digest !== input.image.digest) {
    throw appsError("VERSION_CONFLICT", `${input.version} is already published with another image`);
  }
  if (created) {
    deps.logger.info(`[vetra-apps] ${app.slug} ${input.kind} ${input.version} (${input.image.digest.slice(0, 19)})`);
  }
  return releaseJson(row);
}
```

Add `allowUnattestedReleases: boolean` to the apps config (`config.ts`, from `VETRA_APPS_ALLOW_UNATTESTED_RELEASES === "1"`, default false; the harness sets it to false and injects a fake verifier). Add `attestations?: AttestationVerifier | null` to `AppsDeps`. Add `VERSION_CONFLICT: 409` to the `STATUS` map in `ci.ts`.

- [ ] **Step 4: Route** — in `ci.ts`, a body parser that maps the JSON body to `ReportReleaseInput` strictly (unknown kinds and non-string fields → `BAD_USER_INPUT`):

```ts
    releases: (request: Request) =>
      run(request, async (ci) => {
        const b = await jsonBody(request);
        const obj = (k: string) => {
          const v = b[k];
          if (!v || typeof v !== "object" || Array.isArray(v))
            throw new HttpError("BAD_USER_INPUT", `${k} must be an object`);
          return v as Record<string, unknown>;
        };
        const kind = b.kind;
        if (kind !== "release" && kind !== "build")
          throw new HttpError("BAD_USER_INPUT", "kind must be release or build");
        const image = obj("image");
        return ciReportRelease(deps, ci, {
          appId: requireString(b, "appId"),
          version: requireString(b, "version"),
          kind,
          branch: typeof b.branch === "string" ? b.branch : null,
          pr: typeof b.pr === "number" ? b.pr : null,
          commit: requireString(b, "commit"),
          notes: typeof b.notes === "string" ? b.notes : null,
          image: {
            ref: requireString(image, "ref"),
            digest: requireString(image, "digest"),
            host: requireString(image, "host"),
          },
          packages: Array.isArray(b.packages)
            ? (b.packages as unknown[]).map((p) => {
                const o = (p ?? {}) as Record<string, unknown>;
                return { name: requireString(o, "name"), version: requireString(o, "version") };
              })
            : [],
          requires: (b.requires && typeof b.requires === "object" ? b.requires : {}) as ReportReleaseInput["requires"],
          migrates: b.migrates === true,
          built: (() => {
            const built = obj("built");
            return { powerhouse: requireString(built, "powerhouse"), baseImage: requireString(built, "baseImage") };
          })(),
        });
      }),
```

Mount in `index.ts` next to `registry-token`: `this.http.post("apps/ci/releases", json, (request) => ci.releases(request))`. Wire `deps.attestations = createGithubAttestationVerifier({ token: (repo) => <installation token for repo> })` where `deps` is built in `onSetup`: use the existing GitHub App client (`deps.github`) — find the method that returns an installation token for an app's installation (`grep -n "installationToken\|createInstallationAccessToken\|installation.*token" subgraphs/vetra-apps/github.ts`) and resolve the repo's installation from the `apps` row (`installation_id`, `repository_full_name`). When the GitHub App is not configured, leave `attestations` null.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/releases-report.test.ts subgraphs/vetra-apps/__tests__/ci.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add subgraphs/vetra-apps
git commit -m "feat(releases): ci/releases: verified, idempotent release and build records"
```

---

### Task 9: `appReleases` GraphQL query

**Files:**
- Modify: `subgraphs/vetra-apps/schema.ts`, `subgraphs/vetra-apps/resolvers.ts`, `subgraphs/vetra-apps/releases/service.ts` (`appReleasesFor`)
- Test: `subgraphs/vetra-apps/__tests__/releases-query.test.ts`

**Interfaces:**
- Consumes: `loadAppForOwner` (export it from `service.ts` if it is not), `listReleases` (Task 3), `releaseJson` (Task 8).
- Produces: GraphQL

```graphql
  "A release or build an app's CI published (spec: releases and instances, section 4)."
  type AppRelease {
    version: String!
    kind: String!
    branch: String
    pr: Int
    commit: String!
    notes: String
    customerNotes: String
    imageRef: String!
    imageDigest: String!
    host: String!
    packages: [AppReleasePackage!]!
    migrates: Boolean!
    "The project's Powerhouse version the image was built with."
    powerhouseVersion: String!
    createdAt: String!
  }

  type AppReleasePackage {
    name: String!
    version: String!
  }
```

and on `Query`: `appReleases(appId: ID!, kind: String, limit: Int): [AppRelease!]!` — `kind` `release`|`build`|null (both), `limit` 1–200, default 50; same visibility as `appDeployments` (`need: "view"`).

- [ ] **Step 1: Write the failing test** (resolver level, like `resolvers.test.ts`: find how it calls `appDeployments` through the resolver map and mirror it)

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHarness, owner, seedActiveApp, stranger, type Harness } from "./harness.js";
import { appReleasesFor } from "../releases/service.js";
import { insertRelease } from "../releases/repo.js";

let h: Harness;
beforeEach(async () => { h = await makeHarness(); });
afterEach(async () => { await h.close(); });

const rec = (appId: string, version: string, kind: "release" | "build", run: number) => ({
  app_id: appId, version, kind, branch: "main", pr: null, run, commit: "c", notes: null, customer_notes: null,
  image_ref: `cr.vetra.io/acme/shop:${version}`, image_digest: `sha256:${"a".repeat(64)}`, host: "cli",
  packages: "[]", requires: "{}", migrates: false, powerhouse_version: "6.2.3",
  base_image: "node:24-bookworm-slim@sha256:00", created_at: "2026-11-11T10:00:00.000Z",
});

describe("appReleasesFor", () => {
  it("lists an owner's releases newest first, filtered by kind and limited", async () => {
    const app = await seedActiveApp(h);
    await insertRelease(h.deps.db, rec(app.id, "1.4.0", "release", 1));
    await insertRelease(h.deps.db, rec(app.id, "1.5.0-main.1", "build", 2));
    await insertRelease(h.deps.db, rec(app.id, "1.4.1", "release", 3));
    const all = await appReleasesFor(h.deps, owner, app.id, null, null);
    expect(all.map((r) => r.version)).toStrictEqual(["1.4.1", "1.5.0-main.1", "1.4.0"]);
    const releases = await appReleasesFor(h.deps, owner, app.id, "release", 1);
    expect(releases.map((r) => r.version)).toStrictEqual(["1.4.1"]);
  });

  it("hides another owner's app", async () => {
    const app = await seedActiveApp(h);
    await expect(appReleasesFor(h.deps, stranger, app.id, null, null))
      .rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
  });
});
```

(Use the code `appDeploymentsFor` gives a stranger in the existing tests if it is FORBIDDEN rather than NOT_FOUND.)

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/releases-query.test.ts`
Expected: FAIL, `appReleasesFor` is not exported.

- [ ] **Step 3: Implement**

```ts
import { loadAppForOwner, type Caller } from "../service.js";
import { listReleases } from "./repo.js";

export async function appReleasesFor(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
  kind: string | null | undefined,
  limit: number | null | undefined,
): Promise<ReleaseJson[]> {
  const app = await loadAppForOwner(deps, caller, appId, { need: "view" });
  if (kind != null && kind !== "release" && kind !== "build")
    throw appsError("BAD_USER_INPUT", "kind must be release or build");
  const rows = await listReleases(deps.db, app.id, {
    kind: kind ?? undefined,
    limit: Math.min(Math.max(limit ?? 50, 1), 200),
  });
  return rows.map(releaseJson);
}
```

Schema: add the two types above and the query field next to `appDeployments` in `schema.ts`. Resolver, next to `appDeployments` in `resolvers.ts`, following its `guard(deps, "…", …)` + `requireCaller(ctx)` shape and mapping `ReleaseJson` to the GraphQL shape:

```ts
      appReleases: (
        _: unknown,
        { appId, kind, limit }: { appId: string; kind?: string | null; limit?: number | null },
        ctx: AppsContext,
      ) =>
        guard(deps, "appReleases", async () =>
          (await appReleasesFor(deps, requireCaller(ctx), appId, kind, limit)).map((r) => ({
            version: r.version, kind: r.kind, branch: r.branch, pr: r.pr, commit: r.commit,
            notes: r.notes, customerNotes: r.customerNotes, imageRef: r.image.ref,
            imageDigest: r.image.digest, host: r.image.host, packages: r.packages,
            migrates: r.migrates, powerhouseVersion: r.built.powerhouse, createdAt: r.createdAt,
          })),
        ),
```

- [ ] **Step 4: Run the tests, including the subgraph schema test**

Run: `npx vitest run subgraphs/vetra-apps`
Expected: PASS (the existing suite plus the new files).

- [ ] **Step 5: Commit**

```bash
git add subgraphs/vetra-apps
git commit -m "feat(releases): appReleases query"
```

---

### Task 10: Whole-suite check and typecheck

**Files:** none new.

- [ ] **Step 1: Typecheck and lint**

Run: `npx tsc --noEmit -p . && npx oxlint --type-aware --type-check subgraphs/vetra-apps shared`
Expected: no output (no errors).

- [ ] **Step 2: Full test suite**

Run: `npx vitest run 2>&1 | grep -E "^ FAIL|Test Files|Tests "`
Expected: everything passes except the two `studio-access-factory` tests that already fail on `main` (compare with `git stash; npx vitest run subgraphs/vetra-licensing/__tests__/studio-access-factory.test.ts; git stash pop` if unsure).

- [ ] **Step 3: Commit any lint fixes**

```bash
git add -A && git commit -m "chore(releases): lint" || true
```

## Not in this plan

- The Trivy scan status (`scan_status`) is phase 4; the column comes with it.
- Refusing publishing when the Vetra GitHub App lacks `contents: write` / `pull_requests: write` (spec 14.15): the action fails with GitHub's own permission error in phase 1; the console's approval link and an explicit check come with plan 3 (console).

- The `vetra-publish` action and its workflow (plan 2), the console's Releases view (plan 3).
- Build pruning and registry retention (phase 2), withdrawing releases and customer-notes editing (phases 3–4), transfers (phase 3).
