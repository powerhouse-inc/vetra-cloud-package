# Releases phase 2, plan 2: preview instances — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For an app with `instancesEnabled`, every open same-repository pull request that has a vetra-publish build gets a `preview` instance (`<slug>-pr-12-<hash>.vetra.io`) running that PR's newest build, pinned by digest; at most `preview_limit` (default 5) per app, removed when the PR closes or after `preview_ttl_days` (default 7) without a new build. For those apps the old `ci/deploy` PREVIEW path is switched off and its previews are retired. Apps that have not opted in keep the old preview path, unchanged.

**Architecture:** Slice 1 built the `instances` table, a reconciler loop (`reconcileInstancesOnce`, every 15 s, under `instances:<appId>` and `withEnvLock`) and the environment actions; it already knows a `preview` kind and a `pr` column. This plan adds a second sync step beside `syncBranchInstances`: `syncPreviewInstances` computes the wanted previews from `releases` (`pr = n`, `kind = build`, newest by run, within the TTL, capped), asks GitHub once per new PR whether it is open and from the app's own repository, and keeps preview rows as tombstones (`status = removed`) so a closed PR never comes back from a late build. Creating, updating, reverting and removing environments reuse slice 1's locked code unchanged. The `pull_request` webhook marks previews of a closed PR (and un-marks them on reopen). `ci/deploy` with `kind: PREVIEW` is answered with a recorded no-op for opted-in apps, and the reconciler deletes their old `app_previews`.

**Tech Stack:** TypeScript, Kysely (Postgres; PGlite in tests), vitest, the `powerhouse/vetra-cloud-environment` document model (system-signed actions), the GitHub REST API through `subgraphs/vetra-apps/github.ts`.

**Spec:** `docs/superpowers/specs/2026-11-11-app-releases-and-instances-design.md` (sections 5, 6, 14.13, 14.17; 14.18 is slice 5; 18 phase 2). Slice list and spec gaps: `docs/superpowers/plans/2026-11-11-releases-phase-2-overview.md` (slice 2; gap rulings for previews at the end of this plan). Conventions and the code this builds on: `docs/superpowers/plans/2026-11-11-releases-phase-2-plan-1-branch-instances.md`, `subgraphs/vetra-apps/instances/*`.

## Global Constraints

- Preview instances exist only for apps with `apps.instances_enabled = true` **and** `apps.previews_enabled = true` **and** a CI identity, while the kill switch is on (`VETRA_APPS_INSTANCES` not `off`).
- One preview instance per open PR: kind `preview`, `name = "pr-<n>"`, `pr = n`, `branch = null`.
- Target: the PR's newest build: `releases.pr = n`, `kind = 'build'`, highest `run` (verified run id, spec 14.17), on an equal run the newest record. Pinned by digest exactly as branch instances (`targetOf`).
- Same repository only: a preview is created (or brought back) only after GitHub says the PR is `open` **and** its head repository id equals `apps.repository_id`. GitHub unreachable or unconfigured: nothing is created this pass (asked again next pass). A PR that GitHub answers 404 for counts as closed.
- Cap: at most `apps.preview_limit` (1-20, default 5) live previews per app; beyond it the PR whose newest build has the lowest run (oldest-updated) is removed first. Removals run before creations in a pass.
- TTL: a PR with no build recorded (`releases.created_at`) in the last `apps.preview_ttl_days` (default 7) days has no preview.
- Removal: PR closed or merged (signed `pull_request` webhook, `closed`), TTL, cap, app opt-out or `previews_enabled = false`. A closed PR's preview never comes back from a build; only `reopened` lifts that.
- Hosts: `instanceLabel(app.id, app.slug, "pr-<n>", cfg.instances.labelSuffix)` (ends in a 6-hex hash; staging suffix `-stg`), stored on the row and kept by its tombstone.
- Rendered as slice 1 renders instances: app link `role: PREVIEW`, `prNumber: n`, `gitRef: refs/pull/<n>/head`; size S, one Postgres without S3 backups, no kept `/data`.
- Never write to an environment with `managedBy` set or not linked to the instance's app (the guards in `render.ts`/`reconciler.ts` stay as they are). Never read or write `license_environments`, `app_warm_pool`, artifact channels. Old-path previews are deleted only through `deletePreview` (which refuses anything that is not this app's PREVIEW).
- Old path for opted-in apps (kill switch on): `ci/deploy` and `deployApp` with `kind: PREVIEW` record a `SUPERSEDED` deployment with error `PREVIEWS_FROM_INSTANCES` and touch no environment; existing `app_previews` are deleted by the reconciler. Kill switch off: the old path works again for every app. Apps not opted in: no change at all.
- Not in this plan: build pruning (deleting PR build images or records), PR comment/check (slice 5), sleep (slice 6).
- Additive only: no migration in this plan (the `instances` table already has `kind = 'preview'` and `pr`).
- Commits: one per task, conventional (`feat(instances): …`), trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Work on branch `feat/releases-phase-2-previews` from `main`.
- Checks after every task: `npx vitest run <the task's test files>`; at the end `npm run tsc`, `npm run lint`, `npx vitest run subgraphs/vetra-apps processors/vetra-cloud-environment subgraphs/vetra-licensing`.

## File structure

| File | Change |
|---|---|
| `subgraphs/vetra-apps/github.ts` | `getPullRequest` (state and head repository id) on `GithubDeployApi` |
| `subgraphs/vetra-apps/instances/targets.ts` | `previewCandidates`, `pickPreviews` |
| `subgraphs/vetra-apps/instances/pull-requests.ts` (new) | `pullRequestGate`: open, closed, fork, unknown |
| `subgraphs/vetra-apps/instances/render.ts` | `CreateInstanceInput.prNumber` |
| `subgraphs/vetra-apps/instances/reconciler.ts` | `syncPreviewInstances`, preview tombstones, removals first, preview `gitRef`, `markPullRequestClosed`, `markPullRequestReopened`, retiring old previews |
| `subgraphs/vetra-apps/webhook.ts` | `pull_request` `closed` and `reopened` for instances |
| `subgraphs/vetra-apps/service.ts` | `PREVIEWS_FROM_INSTANCES`; PREVIEW deploys of opted-in apps are a recorded no-op |
| Tests | `__tests__/github.test.ts`, `__tests__/harness.ts` (fake), `__tests__/instances-fixtures.ts` (`createdAt`), `__tests__/instances-targets.test.ts`, `__tests__/instances-render.test.ts`, `__tests__/instances-previews.test.ts` (new), `__tests__/instances-webhook.test.ts`, `__tests__/deploy.test.ts` |

All paths below are relative to the repository root; test paths are under `subgraphs/vetra-apps/`.

---

### Task 0: Pre-flight (needs the user; no code)

- [ ] **Step 1: Staging test app.** The slice-1 staging test app (vetra-publish workflow, `instancesEnabled` on) is reused. Confirm it still exists and its workflow runs on `pull_request` (`types: [opened, synchronize, reopened]`, the generated default).
- [ ] **Step 2: Webhook events.** Confirm the Vetra Deploy GitHub App delivers **Pull request** events (it does today for `closed`; `reopened` is the same event, so nothing to change). Staging and production share the App; nothing is changed on it.
- [ ] **Step 3: Timing.** No production pin of vetra-cloud-package between 2026-11-13 17:30 UTC and the Sektar v1.0.9 rollout showing COMPLETE (`vetraReleases.rollouts(appId: "43622402-be06-435a-bbfa-bb649b0d6244")`).
- [ ] **Step 4: Branch.** `git checkout -b feat/releases-phase-2-previews origin/main`.

---

### Task 1: GitHub — a PR's state and head repository

**Files:**
- Modify: `subgraphs/vetra-apps/github.ts` (interface near line 66, client near line 574)
- Modify: `subgraphs/vetra-apps/__tests__/harness.ts` (`fakeGithub`)
- Test: `subgraphs/vetra-apps/__tests__/github.test.ts`

**Interfaces:**
- Produces: `GithubDeployApi.getPullRequest(installationId: string, repoFullName: string, prNumber: number): Promise<{ state: "open" | "closed"; headRepositoryId: string | null }>`; fake: `h.github.prHeadRepos: Map<number, string | null>` (absent: `REPO_ID`), `h.github.prStates` gains `"missing"` (404).

- [ ] **Step 1: Write the failing test.** In `__tests__/github.test.ts`, after the test `"reads a pull request's state with the installation token"`, add:

```ts
  it("reads a pull request's state and head repository", async () => {
    const f = fakeFetch({
      "GET /repos/acme/shop/pulls/7": () =>
        Response.json({ state: "open", head: { repo: { id: 4242 } } }),
      "GET /repos/acme/shop/pulls/8": () =>
        Response.json({ state: "closed", merged: true, head: { repo: null } }),
    });
    const gh = createGithubDeployApi(cfg, f.impl as never);
    expect(await gh.getPullRequest("5", "acme/shop", 7)).toStrictEqual({
      state: "open",
      headRepositoryId: "4242",
    });
    expect(await gh.getPullRequest("5", "acme/shop", 8)).toStrictEqual({
      state: "closed",
      headRepositoryId: null,
    });
    expect(f.calls[0].auth).toBe("token ghs_installation");
    await expect(gh.getPullRequest("5", "acme/shop", 9)).rejects.toMatchObject({
      status: 404,
    });
  });
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/github.test.ts -t "head repository"`
Expected: FAIL, `gh.getPullRequest is not a function`.

- [ ] **Step 3: Implement.** In `github.ts`, in `interface GithubDeployApi` after `getPullRequestState(…)`:

```ts
  /**
   * A PR's state ("open"; merged counts as "closed") and the id of the
   * repository its head branch lives in (null: the fork was deleted).
   * Read with the installation token.
   */
  getPullRequest(
    installationId: string,
    repoFullName: string,
    prNumber: number,
  ): Promise<{ state: "open" | "closed"; headRepositoryId: string | null }>;
```

and in the client, after `async getPullRequestState(…) { … },`:

```ts
    async getPullRequest(installationId, fullName, prNumber) {
      const { data } = await inst<{
        state?: string;
        head?: { repo?: { id?: number | string } | null };
      }>(installationId, "GET", `/repos/${repoPath(fullName)}/pulls/${prNumber}`);
      const id = data.head?.repo?.id;
      return {
        state: data.state === "open" ? "open" : "closed",
        headRepositoryId: id == null ? null : String(id),
      };
    },
```

- [ ] **Step 4: The fake.** In `__tests__/harness.ts`, `fakeGithub()`:
  - change the `prStates` type in the return type and its `new Map` to `Map<number, "open" | "closed" | "error" | "missing">` and its doc comment to `/** PR number → state; "error": GitHub unreachable; "missing": 404. Default open. */`;
  - add to the return type: `/** PR number → its head repository id (null: deleted fork). Absent: REPO_ID (same repository). */ prHeadRepos: Map<number, string | null>;`
  - declare `const prHeadRepos = new Map<number, string | null>();` next to `prStates`;
  - in `getPullRequestState`'s fake add `if (st === "missing") throw new GithubHttpError(404, "Not Found");` before `return st;`;
  - after the `getPullRequestState` entry add:

```ts
    prHeadRepos,
    getPullRequest: rec(
      "getPullRequest",
      (_i: string, _r: string, n: number) => {
        const st = prStates.get(n) ?? "open";
        if (st === "error") throw new Error("GitHub unreachable");
        if (st === "missing") throw new GithubHttpError(404, "Not Found");
        return {
          state: st,
          headRepositoryId: prHeadRepos.has(n) ? prHeadRepos.get(n)! : REPO_ID,
        };
      },
    ),
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/github.test.ts subgraphs/vetra-apps/__tests__/deploy.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add subgraphs/vetra-apps/github.ts subgraphs/vetra-apps/__tests__/github.test.ts subgraphs/vetra-apps/__tests__/harness.ts
git commit -m "feat(instances): read a pull request's state and head repository

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Preview targets — newest build per PR, TTL and cap

**Files:**
- Modify: `subgraphs/vetra-apps/instances/targets.ts`
- Modify: `subgraphs/vetra-apps/__tests__/instances-fixtures.ts` (`createdAt`)
- Test: `subgraphs/vetra-apps/__tests__/instances-targets.test.ts`

**Interfaces:**
- Consumes: `ReleaseRow` (`releases/repo.ts`).
- Produces: `previewCandidates(db: Kysely<VetraAppsDB>, appId: string, sinceIso: string): Promise<ReleaseRow[]>` (newest build of every PR with a build since `sinceIso`, newest first); `pickPreviews(candidates: ReleaseRow[], excluded: ReadonlySet<number>, limit: number): Map<number, ReleaseRow>`; fixture `seedRelease(h, appId, { …, createdAt?: string })`.

- [ ] **Step 1: Fixture.** In `__tests__/instances-fixtures.ts`, add `createdAt?: string;` to the `over` type and replace `created_at: "2026-11-11T00:00:00.000Z",` with `created_at: over.createdAt ?? "2026-11-11T00:00:00.000Z",`.

- [ ] **Step 2: Write the failing test.** In `__tests__/instances-targets.test.ts`, extend the import to `import { branchTargets, pickPreviews, previewCandidates, targetOf } from "../instances/targets.js";` and append:

```ts
describe("previewCandidates", () => {
  const SINCE = "2026-11-04T00:00:00.000Z";

  it("takes each PR's newest build by run, never a branch build, newest PR first", async () => {
    await seedRelease(h, appId, { version: "1.5.0-pr.12.1", run: 100, pr: 12 });
    await seedRelease(h, appId, { version: "1.5.0-pr.12.3", run: 300, pr: 12, digest: digest("c") });
    // Arrives last, but an older run: not the target (spec 14.17).
    await seedRelease(h, appId, { version: "1.5.0-pr.12.2", run: 200, pr: 12, digest: digest("b") });
    await seedRelease(h, appId, { version: "1.5.0-pr.13.1", run: 250, pr: 13 });
    await seedRelease(h, appId, { version: "1.5.0-main.9", run: 999 });
    const c = await previewCandidates(h.db, appId, SINCE);
    expect(c.map((r) => [r.pr, r.version])).toEqual([
      [12, "1.5.0-pr.12.3"],
      [13, "1.5.0-pr.13.1"],
    ]);
    expect(typeof c[0].run).toBe("number");
  });

  it("leaves out a PR whose last build is older than the TTL", async () => {
    await seedRelease(h, appId, { version: "1.5.0-pr.12.1", run: 100, pr: 12, createdAt: "2026-11-01T00:00:00.000Z" });
    await seedRelease(h, appId, { version: "1.5.0-pr.13.1", run: 90, pr: 13, createdAt: "2026-11-01T00:00:00.000Z" });
    await seedRelease(h, appId, { version: "1.5.0-pr.13.2", run: 95, pr: 13, createdAt: "2026-11-05T00:00:00.000Z" });
    const c = await previewCandidates(h.db, appId, SINCE);
    expect(c.map((r) => r.version)).toEqual(["1.5.0-pr.13.2"]);
  });
});

describe("pickPreviews", () => {
  const r = (pr: number, run: number) =>
    ({ pr, run, version: `1.0.0-pr.${pr}.1` }) as never;

  it("keeps the newest PRs up to the limit, skipping excluded ones", () => {
    const picked = pickPreviews([r(5, 500), r(4, 400), r(3, 300), r(2, 200)], new Set([4]), 2);
    expect([...picked.keys()]).toEqual([5, 3]);
  });

  it("keeps none at limit 0", () => {
    expect(pickPreviews([r(5, 500)], new Set(), 0).size).toBe(0);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/instances-targets.test.ts`
Expected: FAIL, `previewCandidates is not a function` (or an import error).

- [ ] **Step 4: Implement.** Append to `instances/targets.ts`:

```ts
/**
 * The newest build of every PR that has a build recorded since `sinceIso`
 * (spec 14.13: a preview goes after its TTL without a new build), newest
 * first. Newest = highest verified run id, on an equal run the newest record
 * (spec 14.17); ties between PRs go to the higher PR number.
 */
export async function previewCandidates(
  db: Kysely<VetraAppsDB>,
  appId: string,
  sinceIso: string,
): Promise<ReleaseRow[]> {
  const recent = db
    .selectFrom("releases")
    .select("pr")
    .where("app_id", "=", appId)
    .where("kind", "=", "build")
    .where("pr", "is not", null)
    .where("created_at", ">=", sinceIso);
  const rows = await db
    .selectFrom("releases")
    .selectAll()
    .distinctOn("pr")
    .where("app_id", "=", appId)
    .where("kind", "=", "build")
    .where("pr", "in", recent)
    .orderBy("pr")
    .orderBy("run", "desc")
    .orderBy("created_at", "desc")
    .execute();
  return rows
    .map((r) => ({ ...r, run: Number(r.run) }))
    .sort(
      (a, b) =>
        b.run - a.run ||
        b.created_at.localeCompare(a.created_at) ||
        b.pr! - a.pr!,
    );
}

/**
 * The PRs that get a preview: the newest `limit` candidates (spec 14.13: the
 * oldest-updated goes first beyond the cap), never an excluded one (closed,
 * or from a fork). `candidates` is newest first (previewCandidates).
 */
export function pickPreviews(
  candidates: ReleaseRow[],
  excluded: ReadonlySet<number>,
  limit: number,
): Map<number, ReleaseRow> {
  const out = new Map<number, ReleaseRow>();
  for (const r of candidates) {
    if (out.size >= limit) break;
    if (r.pr == null || excluded.has(r.pr)) continue;
    out.set(r.pr, r);
  }
  return out;
}
```

If Kysely's types refuse `.where("pr", "in", recent)`, write `.where("pr", "in", (eb) => eb.selectFrom("releases").select("pr")…)` with the same conditions; do not change the semantics.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/instances-targets.test.ts subgraphs/vetra-apps/__tests__/instances-reconciler.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add subgraphs/vetra-apps/instances/targets.ts subgraphs/vetra-apps/__tests__/instances-targets.test.ts subgraphs/vetra-apps/__tests__/instances-fixtures.ts
git commit -m "feat(instances): preview targets, the newest build per PR within the TTL and cap

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Render — a preview's PR number

**Files:**
- Modify: `subgraphs/vetra-apps/instances/render.ts`
- Test: `subgraphs/vetra-apps/__tests__/instances-render.test.ts`

**Interfaces:**
- Produces: `CreateInstanceInput.prNumber?: number | null` (default `null`), written to `setAppLink.prNumber`.

- [ ] **Step 1: Write the failing test.** In `__tests__/instances-render.test.ts`, inside `describe("instanceCreateActions", …)` add:

```ts
  it("links a preview instance to its PR", async () => {
    const envs = new FakeEnvs();
    const id = await envs.create();
    await envs.execute(id, [
      ...instanceCreateActions({
        label: "Shop · pr-12",
        host: "shop-pr-12-abc123",
        baseDomain: "vetra.io",
        registry: "https://registry.dev.vetra.io",
        owner: OWNER,
        ownerOrgId: null,
        appId: "app-1",
        gitRef: "refs/pull/12/head",
        prNumber: 12,
        imageProject: "acme",
        image: image(),
        admins: OWNER,
      }),
      approveChanges({}),
    ]);
    expect((await envs.getState(id))!.app).toMatchObject({
      appId: "app-1",
      role: "PREVIEW",
      prNumber: 12,
      gitRef: "refs/pull/12/head",
    });
  });
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/instances-render.test.ts`
Expected: FAIL: TypeScript-unknown property is ignored at runtime, so the assertion fails with `prNumber: null` received.

- [ ] **Step 3: Implement.** In `render.ts`, add to `CreateInstanceInput` after `gitRef: string;`:

```ts
  /** The PR of a preview instance; null (or absent) for a branch instance. */
  prNumber?: number | null;
```

and in `instanceCreateActions` change `prNumber: null,` to `prNumber: i.prNumber ?? null,`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/instances-render.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add subgraphs/vetra-apps/instances/render.ts subgraphs/vetra-apps/__tests__/instances-render.test.ts
git commit -m "feat(instances): link a preview instance's environment to its PR

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The reconciler runs preview instances

**Files:**
- Create: `subgraphs/vetra-apps/instances/pull-requests.ts`
- Modify: `subgraphs/vetra-apps/instances/reconciler.ts`
- Test (new): `subgraphs/vetra-apps/__tests__/instances-previews.test.ts`

**Interfaces:**
- Consumes: `previewCandidates`, `pickPreviews`, `targetOf` (Task 2, `targets.ts`); `getPullRequest` (Task 1); `CreateInstanceInput.prNumber` (Task 3); slice 1's `listInstances`, `insertInstance`, `updateInstance`, `deleteInstance`, `reconcileInstance`, `instanceLabel`.
- Produces: `pullRequestGate(deps: AppsDeps, app: AppRow, pr: number): Promise<"open" | "closed" | "fork" | "unknown">`; in `reconciler.ts`: `syncPreviewInstances(deps: AppsDeps, app: AppRow): Promise<void>`, exported constants `PR_CLOSED = "pull request closed"`, `PR_FORK = "pull request from a fork"`, `PR_REOPENED = "pull request reopened"`, `previewName(pr: number): string`.

Behaviour (all in one pass of `reconcileApp`, under `instances:<appId>`):
1. `syncBranchInstances` (unchanged), then `syncPreviewInstances`.
2. Rows are reconciled removals first (an evicted preview's environment goes before a new one is created).
3. A preview row is never deleted on removal: it becomes a tombstone (`status = removed`, host kept, environment cleared, `reason = removed_reason`). Tombstones whose PR has no candidate build any more (TTL passed) are deleted.
4. A tombstone with `removed_reason` `PR_CLOSED` or `PR_FORK` is excluded from the cap and never revived by `syncPreviewInstances`. Any other tombstone is revived when its PR is picked again (after the GitHub gate).

- [ ] **Step 1: Write the failing test.** Create `__tests__/instances-previews.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHarness, seedActiveApp, type Harness } from "./harness.js";
import { digest, seedRelease } from "./instances-fixtures.js";
import { instanceLabel } from "../instances/host.js";
import { listInstances, type InstanceRow } from "../instances/repo.js";
import {
  PR_CLOSED,
  PR_FORK,
  reconcileInstancesOnce,
} from "../instances/reconciler.js";

let h: Harness;
let appId: string;
let slug: string;
let baseDocs: number;

beforeEach(async () => {
  h = await makeHarness();
  const app = await seedActiveApp(h);
  appId = app.id;
  slug = app.slug;
  await h.db
    .updateTable("apps")
    .set({ instances_enabled: true, registry_namespace: "acme" })
    .where("id", "=", appId)
    .execute();
  baseDocs = h.envs.docs.size;
});
afterEach(async () => {
  await h.close();
});

const DAY = 86_400_000;
const previews = async () =>
  (await listInstances(h.db, appId)).filter((r) => r.kind === "preview");
const live = async () => (await previews()).filter((r) => !r.removed_at);
const byPr = async (pr: number) =>
  (await previews()).find((r) => r.pr === pr) as InstanceRow;
const fusionVersion = async (envId: string) =>
  (await h.envs.getState(envId))!.services.find((s) => s.type === "FUSION")!
    .version;
const prBuild = (pr: number, n: number, run: number, c = "a") =>
  seedRelease(h, appId, {
    version: `1.5.0-pr.${pr}.${n}`,
    run,
    pr,
    digest: digest(c),
    createdAt: h.clock.now.toISOString(),
  });
const setApp = (patch: Record<string, unknown>) =>
  h.db.updateTable("apps").set(patch).where("id", "=", appId).execute();

describe("preview instances", () => {
  it("creates a preview for a PR's build, pinned by digest, linked to the PR", async () => {
    await prBuild(12, 1, 100);
    await reconcileInstancesOnce(h.deps);
    const row = await byPr(12);
    expect(row).toMatchObject({
      kind: "preview",
      name: "pr-12",
      branch: null,
      host: instanceLabel(appId, slug, "pr-12"),
      status: "updating",
      target_version: "1.5.0-pr.12.1",
    });
    const state = (await h.envs.getState(row.environment_id!))!;
    expect(state.app).toMatchObject({
      appId,
      role: "PREVIEW",
      prNumber: 12,
      gitRef: "refs/pull/12/head",
    });
    expect(await fusionVersion(row.environment_id!)).toBe(
      `1.5.0-pr.12.1@${digest("a")}`,
    );
    h.envs.setStatus(row.environment_id!, "READY");
    await reconcileInstancesOnce(h.deps);
    expect((await byPr(12)).status).toBe("ready");
    // A PR build is never a branch instance.
    expect((await listInstances(h.db, appId, "branch")).length).toBe(0);
  });

  it("follows the PR's newest build by run, not by arrival", async () => {
    await prBuild(12, 1, 100);
    await reconcileInstancesOnce(h.deps);
    await prBuild(12, 3, 300, "c");
    await prBuild(12, 2, 200, "b");
    await reconcileInstancesOnce(h.deps);
    const row = await byPr(12);
    expect(row.target_version).toBe("1.5.0-pr.12.3");
    expect(await fusionVersion(row.environment_id!)).toBe(
      `1.5.0-pr.12.3@${digest("c")}`,
    );
  });

  it("keeps at most preview_limit previews, removing the oldest-updated first", async () => {
    await setApp({ preview_limit: 2 });
    await prBuild(1, 1, 100);
    await prBuild(2, 1, 200);
    await prBuild(3, 1, 300);
    await reconcileInstancesOnce(h.deps);
    expect((await live()).map((r) => r.pr).sort()).toEqual([2, 3]);
    expect(h.envs.docs.size - baseDocs).toBe(2);

    // PR 1 gets a new build: it is now among the newest two; PR 2 goes, before PR 1 is created.
    const pr2Env = (await byPr(2)).environment_id!;
    const create = h.envs.create.bind(h.envs);
    let liveAtCreate = -1;
    h.envs.create = async () => {
      liveAtCreate = h.envs.docs.size - baseDocs;
      return create();
    };
    await prBuild(1, 2, 400, "d");
    await reconcileInstancesOnce(h.deps);
    expect(liveAtCreate).toBe(1);
    expect(h.envs.deleted).toContain(pr2Env);
    expect((await live()).map((r) => r.pr).sort()).toEqual([1, 3]);
    expect(await byPr(2)).toMatchObject({ status: "removed", environment_id: null });
  });

  it("removes a preview after preview_ttl_days without a build, and brings it back on a new one", async () => {
    await prBuild(12, 1, 100);
    await reconcileInstancesOnce(h.deps);
    const host = (await byPr(12)).host;
    h.advance(7 * DAY + 60_000);
    await reconcileInstancesOnce(h.deps); // removed: tombstone
    expect(await byPr(12)).toMatchObject({ status: "removed" });
    expect(h.envs.docs.size).toBe(baseDocs);
    await reconcileInstancesOnce(h.deps); // no candidate any more: purged
    expect(await previews()).toEqual([]);

    await prBuild(12, 2, 200, "b");
    await reconcileInstancesOnce(h.deps);
    expect(await byPr(12)).toMatchObject({ status: "updating", host });
  });

  it("brings an evicted preview back on its old host", async () => {
    await setApp({ preview_limit: 1 });
    await prBuild(1, 1, 100);
    await reconcileInstancesOnce(h.deps);
    const host = (await byPr(1)).host;
    await prBuild(2, 1, 200);
    await reconcileInstancesOnce(h.deps);
    expect((await byPr(1)).status).toBe("removed");
    await prBuild(1, 2, 300, "c");
    await reconcileInstancesOnce(h.deps);
    expect(await byPr(1)).toMatchObject({ status: "updating", host, removed_at: null });
  });

  it("makes no previews when previews are off, and removes the ones there are", async () => {
    await prBuild(12, 1, 100);
    await reconcileInstancesOnce(h.deps);
    await setApp({ previews_enabled: false });
    await reconcileInstancesOnce(h.deps);
    expect(await live()).toEqual([]);
    expect(h.envs.docs.size).toBe(baseDocs);
  });

  it("removes previews when the app opts out", async () => {
    await prBuild(12, 1, 100);
    await reconcileInstancesOnce(h.deps);
    await setApp({ instances_enabled: false });
    await reconcileInstancesOnce(h.deps);
    expect(await live()).toEqual([]);
    expect(h.envs.docs.size).toBe(baseDocs);
  });

  it("does nothing for an app that has not opted in", async () => {
    await setApp({ instances_enabled: false });
    await prBuild(12, 1, 100);
    await reconcileInstancesOnce(h.deps);
    expect(await previews()).toEqual([]);
    expect(h.github.calls.getPullRequest).toBeUndefined();
  });
});

describe("preview instances — the PR on GitHub", () => {
  it("creates nothing for a closed PR, and does not ask GitHub again", async () => {
    h.github.prStates.set(12, "closed");
    await prBuild(12, 1, 100);
    await reconcileInstancesOnce(h.deps);
    await prBuild(12, 2, 200, "b");
    await reconcileInstancesOnce(h.deps);
    expect(await byPr(12)).toMatchObject({
      status: "removed",
      removed_reason: PR_CLOSED,
      environment_id: null,
    });
    expect(h.envs.docs.size).toBe(baseDocs);
    expect(h.github.calls.getPullRequest).toHaveLength(1);
  });

  it("treats a PR GitHub does not know (404) as closed", async () => {
    h.github.prStates.set(12, "missing");
    await prBuild(12, 1, 100);
    await reconcileInstancesOnce(h.deps);
    expect((await byPr(12)).removed_reason).toBe(PR_CLOSED);
  });

  it("creates nothing for a PR from a fork", async () => {
    h.github.prHeadRepos.set(12, "999");
    await prBuild(12, 1, 100);
    await reconcileInstancesOnce(h.deps);
    expect(await byPr(12)).toMatchObject({ status: "removed", removed_reason: PR_FORK });
    expect(h.envs.docs.size).toBe(baseDocs);
  });

  it("waits while GitHub is unreachable, then creates the preview", async () => {
    h.github.prStates.set(12, "error");
    await prBuild(12, 1, 100);
    await reconcileInstancesOnce(h.deps);
    expect(await previews()).toEqual([]);
    h.github.prStates.set(12, "open");
    await reconcileInstancesOnce(h.deps);
    expect((await byPr(12)).status).toBe("updating");
  });

  it("does not count a closed PR against the limit", async () => {
    await setApp({ preview_limit: 1 });
    h.github.prStates.set(2, "closed");
    await prBuild(1, 1, 100);
    await prBuild(2, 1, 200);
    await reconcileInstancesOnce(h.deps);
    expect((await live()).map((r) => r.pr)).toEqual([1]);
  });

  it("forgets a closed PR's tombstone once its builds are past the TTL", async () => {
    h.github.prStates.set(12, "closed");
    await prBuild(12, 1, 100);
    await reconcileInstancesOnce(h.deps);
    h.advance(7 * DAY + 60_000);
    await reconcileInstancesOnce(h.deps);
    expect(await previews()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/instances-previews.test.ts`
Expected: FAIL, `PR_CLOSED` is not exported (import error).

- [ ] **Step 3: The GitHub gate.** Create `instances/pull-requests.ts`:

```ts
import { GithubHttpError } from "../github.js";
import { appRepository, type AppRow } from "../repo.js";
import type { AppsDeps } from "../service.js";

export type PullRequestGate = "open" | "closed" | "fork" | "unknown";

/**
 * Whether a PR may have a preview: open, and from the app's own repository
 * (a fork's head lives elsewhere). "unknown" when GitHub is not configured or
 * not reachable: the caller asks again on its next pass. A 404 is "closed"
 * (the PR is gone), so a vanished PR is not asked about every pass.
 */
export async function pullRequestGate(
  deps: AppsDeps,
  app: AppRow,
  pr: number,
): Promise<PullRequestGate> {
  const repo = appRepository(app);
  if (!deps.github || !repo) return "unknown";
  try {
    const p = await deps.github.getPullRequest(
      repo.installationId,
      repo.fullName,
      pr,
    );
    if (p.state !== "open") return "closed";
    return p.headRepositoryId === repo.repositoryId ? "open" : "fork";
  } catch (err) {
    if (err instanceof GithubHttpError && err.status === 404) return "closed";
    deps.logger.warn(
      `[vetra-apps] PR #${pr} of ${repo.fullName}: state unavailable: ${String(err)}`,
    );
    return "unknown";
  }
}
```

- [ ] **Step 4: The reconciler.** In `instances/reconciler.ts`:

(a) Imports: add `previewCandidates, pickPreviews` to the `./targets.js` import; add `import { pullRequestGate } from "./pull-requests.js";`.

(b) Constants, after `const NOT_WANTED = "no longer wanted";`:

```ts
/** removed_reason of a closed (or merged) PR's preview: never revived by a build, only by reopening. */
export const PR_CLOSED = "pull request closed";
/** removed_reason of a PR whose head is in another repository: never gets a preview. */
export const PR_FORK = "pull request from a fork";
/** removed_reason after a closed PR was reopened: revived like any other tombstone. */
export const PR_REOPENED = "pull request reopened";
/** Tombstones syncPreviewInstances never revives and the cap does not count. */
const FINAL = new Set<string>([PR_CLOSED, PR_FORK]);
const DAY_MS = 86_400_000;

export const previewName = (pr: number) => `pr-${pr}`;
```

(c) `reconcileApp`: replace its body's first two lines (`await syncBranchInstances(deps, app);` and `for (const row of await listInstances(deps.db, app.id)) {`) with:

```ts
  await syncBranchInstances(deps, app);
  await syncPreviewInstances(deps, app);
  const rows = await listInstances(deps.db, app.id);
  // Removals first: an evicted preview frees its place before a new one is
  // created (spec 14.13). Array.prototype.sort is stable.
  rows.sort((a, b) => Number(!a.removed_at) - Number(!b.removed_at));
  for (const row of rows) {
```

(the loop body is unchanged).

(d) Add, after `wantsInstances`:

```ts
function wantsPreviews(app: AppRow): boolean {
  return wantsInstances(app) && app.previews_enabled;
}
```

(e) Add, after `syncBranchInstances`:

```ts
/**
 * Rows for the wanted preview instances (spec section 5: one per open PR, on
 * that PR's newest build; 14.13: at most preview_limit, none after
 * preview_ttl_days without a build). A new or returning preview is created
 * only once GitHub says its PR is open and from the app's repository. Preview
 * rows are kept as tombstones (removeInstance): a closed PR's stays closed
 * until reopened, and a returning preview gets its old host back. Tombstones
 * go when their PR has no build within the TTL any more.
 */
export async function syncPreviewInstances(
  deps: AppsDeps,
  app: AppRow,
): Promise<void> {
  const rows = await listInstances(deps.db, app.id, "preview");
  const since = new Date(
    deps.now().getTime() - app.preview_ttl_days * DAY_MS,
  ).toISOString();
  const candidates = await previewCandidates(deps.db, app.id, since);
  const excluded = new Set(
    rows
      .filter((r) => r.removed_reason && FINAL.has(r.removed_reason))
      .map((r) => r.pr!),
  );
  const wanted: Map<number, ReleaseRow> = wantsPreviews(app)
    ? pickPreviews(candidates, excluded, app.preview_limit)
    : new Map<number, ReleaseRow>();
  const nowIso = deps.now().toISOString();

  for (const [pr, release] of wanted) {
    let target: InstanceTarget;
    try {
      target = targetOf(release);
    } catch (err) {
      deps.logger.warn(
        `[vetra-apps] instance ${app.slug}/${previewName(pr)}: ${message(err)}`,
      );
      continue;
    }
    const row = rows.find((r) => r.pr === pr);
    if (row && !row.removed_at) {
      if (
        row.target_digest !== target.target_digest ||
        row.target_version !== target.target_version ||
        row.target_repository !== target.target_repository ||
        row.target_ph_host !== target.target_ph_host
      )
        await patch(deps, row, target);
      continue;
    }
    // Still being removed: wait until its environment is gone.
    if (row && row.status !== "removed") continue;

    const gate = await pullRequestGate(deps, app, pr);
    if (gate === "unknown") continue;
    if (gate !== "open") {
      const reason = gate === "fork" ? PR_FORK : PR_CLOSED;
      if (row) await patch(deps, row, { removed_reason: reason });
      else
        await insertInstance(deps.db, {
          ...previewRow(deps, app, pr, target, nowIso),
          status: "removed",
          reason,
          removed_at: nowIso,
          removed_reason: reason,
        });
      continue;
    }
    if (row)
      await patch(deps, row, {
        ...target,
        ...CLEAN,
        environment_id: null,
        removed_at: null,
        removed_reason: null,
        status: "pending",
        reason: null,
      });
    else
      await insertInstance(deps.db, previewRow(deps, app, pr, target, nowIso));
  }

  const recent = new Set(candidates.map((r) => r.pr));
  for (const row of rows) {
    if (row.status === "removed") {
      if (!recent.has(row.pr)) await deleteInstance(deps.db, row.id);
      continue;
    }
    if (!row.removed_at && !wanted.has(row.pr!))
      await patch(deps, row, {
        removed_at: nowIso,
        removed_reason: NOT_WANTED,
      });
  }
}

function previewRow(
  deps: AppsDeps,
  app: AppRow,
  pr: number,
  target: InstanceTarget,
  nowIso: string,
) {
  return {
    id: deps.newId(),
    app_id: app.id,
    kind: "preview" as const,
    name: previewName(pr),
    branch: null,
    pr,
    host: null,
    environment_id: null,
    ...target,
    running_version: null,
    running_digest: null,
    running_repository: null,
    status: "pending" as const,
    reason: null,
    failed_digest: null,
    update_started_at: null,
    removed_at: null,
    removed_reason: null,
    created_at: nowIso,
    updated_at: nowIso,
  };
}
```

(f) `initEnvironment`: replace `gitRef: \`refs/heads/${row.branch}\`,` with:

```ts
        gitRef:
          row.kind === "preview"
            ? `refs/pull/${row.pr}/head`
            : `refs/heads/${row.branch}`,
        prNumber: row.kind === "preview" ? row.pr : null,
```

(g) `removeInstance`: replace its final `if (row.removed_reason === BRANCH_DELETED) … else await deleteInstance(deps.db, row.id);` with:

```ts
  // Tombstones: a deleted branch (may come back with a newer build) and every
  // preview (a closed PR stays closed; a returning one keeps its host).
  if (row.kind === "preview" || row.removed_reason === BRANCH_DELETED)
    await patch(deps, row, {
      ...CLEAN,
      environment_id: null,
      status: "removed",
      reason: row.removed_reason,
    });
  else await deleteInstance(deps.db, row.id);
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/instances-previews.test.ts subgraphs/vetra-apps/__tests__/instances-reconciler.test.ts subgraphs/vetra-apps/__tests__/instances-api.test.ts`
Expected: PASS. The slice-1 reconciler tests must pass unchanged (branch removal still deletes rows; `BRANCH_DELETED` tombstones still carry `reason: "branch deleted"`).

- [ ] **Step 6: Commit**

```bash
git add subgraphs/vetra-apps/instances subgraphs/vetra-apps/__tests__/instances-previews.test.ts
git commit -m "feat(instances): preview instances for open PRs, capped and expiring

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: PR closed and reopened (webhook)

**Files:**
- Modify: `subgraphs/vetra-apps/instances/reconciler.ts` (`markPullRequestClosed`, `markPullRequestReopened`)
- Modify: `subgraphs/vetra-apps/webhook.ts`
- Test: `subgraphs/vetra-apps/__tests__/instances-webhook.test.ts`

**Interfaces:**
- Consumes: `PR_CLOSED`, `PR_REOPENED` (Task 4).
- Produces: `markPullRequestClosed(deps: AppsDeps, repositoryId: string, pr: number): Promise<number>`; `markPullRequestReopened(deps: AppsDeps, repositoryId: string, pr: number): Promise<number>`; webhook `pull_request` `closed` body `{ removedPreviews, removedInstances? }` (the latter only when > 0); `reopened` → `200 { reopenedInstances }` when > 0, else `204`.

- [ ] **Step 1: Write the failing test.** In `__tests__/instances-webhook.test.ts`, extend the reconciler import to `import { PR_CLOSED, reconcileInstancesOnce } from "../instances/reconciler.js";` and append:

```ts
const pullRequest = (action: string, pr: number, repoId = REPO_ID) => {
  const body = JSON.stringify({
    action,
    number: pr,
    pull_request: { number: pr },
    repository: { id: Number(repoId) },
    installation: { id: Number(INSTALLATION) },
  });
  return handleGithubWebhook(h.deps, {
    rawBody: Buffer.from(body),
    signature: `sha256=${createHmac("sha256", "whsec").update(body).digest("hex")}`,
    event: "pull_request",
  });
};

describe("pull_request webhook — preview instances", () => {
  const preview = async () =>
    (await listInstances(h.db, appId)).find((r) => r.kind === "preview")!;

  beforeEach(async () => {
    await seedRelease(h, appId, { version: "1.5.0-pr.12.1", run: 200, pr: 12 });
    await reconcileInstancesOnce(h.deps);
  });

  it("removes a closed PR's preview, and a late build does not bring it back", async () => {
    const envId = (await preview()).environment_id!;
    expect(await pullRequest("closed", 12)).toStrictEqual({
      status: 200,
      body: { removedPreviews: 0, removedInstances: 1 },
    });
    await reconcileInstancesOnce(h.deps);
    expect(h.envs.deleted).toContain(envId);
    expect(await preview()).toMatchObject({
      status: "removed",
      removed_reason: PR_CLOSED,
    });
    await seedRelease(h, appId, { version: "1.5.0-pr.12.2", run: 300, pr: 12 });
    await reconcileInstancesOnce(h.deps);
    expect((await preview()).status).toBe("removed");
  });

  it("brings the preview back when the PR is reopened", async () => {
    await pullRequest("closed", 12);
    await reconcileInstancesOnce(h.deps);
    expect(await pullRequest("reopened", 12)).toStrictEqual({
      status: 200,
      body: { reopenedInstances: 1 },
    });
    await reconcileInstancesOnce(h.deps);
    expect((await preview()).status).toBe("updating");
  });

  it("leaves previews alone for another repository or PR", async () => {
    expect((await pullRequest("closed", 12, "999")).body).toStrictEqual({
      removedPreviews: 0,
    });
    expect((await pullRequest("closed", 13)).body).toStrictEqual({
      removedPreviews: 0,
    });
    expect((await pullRequest("reopened", 13)).status).toBe(204);
    expect((await preview()).removed_at).toBeNull();
  });

  it("refuses an unsigned delivery without touching the preview", async () => {
    const body = JSON.stringify({
      action: "closed",
      number: 12,
      repository: { id: Number(REPO_ID) },
    });
    const res = await handleGithubWebhook(h.deps, {
      rawBody: Buffer.from(body),
      signature: "sha256=00",
      event: "pull_request",
    });
    expect(res.status).toBe(401);
    expect((await preview()).removed_at).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/instances-webhook.test.ts`
Expected: FAIL: the `closed` body lacks `removedInstances`; `reopened` answers 204.

- [ ] **Step 3: Mark functions.** Append to `instances/reconciler.ts`:

```ts
async function previewRowsOfPr(
  deps: AppsDeps,
  repositoryId: string,
  pr: number,
): Promise<{ id: string; app_id: string }[]> {
  return deps.db
    .selectFrom("instances")
    .innerJoin("apps", "apps.id", "instances.app_id")
    .select(["instances.id", "instances.app_id"])
    .where("apps.repository_id", "=", repositoryId)
    .where("instances.kind", "=", "preview")
    .where("instances.pr", "=", pr)
    .execute();
}

/**
 * A PR was closed or merged: its preview goes (spec section 5) and stays
 * gone, whatever builds still arrive, until the PR is reopened. Runs under
 * the app's instances lock, so a reconciler pass cannot revive the row
 * concurrently. Returns how many rows were marked.
 */
export async function markPullRequestClosed(
  deps: AppsDeps,
  repositoryId: string,
  pr: number,
): Promise<number> {
  const rows = await previewRowsOfPr(deps, repositoryId, pr);
  for (const r of rows)
    await withKeyLock(`instances:${r.app_id}`, async () => {
      const nowIso = deps.now().toISOString();
      await deps.db
        .updateTable("instances")
        .set({ removed_at: nowIso, updated_at: nowIso })
        .where("id", "=", r.id)
        .where("removed_at", "is", null)
        .execute();
      await deps.db
        .updateTable("instances")
        .set({ removed_reason: PR_CLOSED, updated_at: nowIso })
        .where("id", "=", r.id)
        .execute();
    });
  return rows.length;
}

/** A closed PR was reopened: its preview may come back (after the GitHub check). */
export async function markPullRequestReopened(
  deps: AppsDeps,
  repositoryId: string,
  pr: number,
): Promise<number> {
  let n = 0;
  for (const r of await previewRowsOfPr(deps, repositoryId, pr))
    await withKeyLock(`instances:${r.app_id}`, async () => {
      const nowIso = deps.now().toISOString();
      const res = await deps.db
        .updateTable("instances")
        .set({ removed_reason: PR_REOPENED, updated_at: nowIso })
        .where("id", "=", r.id)
        .where("removed_reason", "=", PR_CLOSED)
        .executeTakeFirst();
      n += Number(res.numUpdatedRows);
    });
  return n;
}
```

- [ ] **Step 4: Webhook.** In `webhook.ts`, change the import to `import { markBranchDeleted, markPullRequestClosed, markPullRequestReopened } from "./instances/reconciler.js";` and replace the `if (input.event === "pull_request" && action === "closed") { … }` block with:

```ts
  if (
    input.event === "pull_request" &&
    (action === "closed" || action === "reopened")
  ) {
    const repositoryId = idOf(pick(payload, "repository.id"));
    const prNumber = Number(
      pick(payload, "pull_request.number") ?? payload.number,
    );
    if (!repositoryId || !Number.isInteger(prNumber)) return { status: 204 };
    if (action === "reopened") {
      const reopened = await markPullRequestReopened(deps, repositoryId, prNumber);
      return reopened > 0
        ? { status: 200, body: { reopenedInstances: reopened } }
        : { status: 204 };
    }
    let removed = 0;
    for (const app of await appsByRepository(deps, repositoryId)) {
      const preview = await getPreview(deps.db, app.id, prNumber);
      if (!preview) continue;
      await deletePreview(
        deps,
        app,
        preview,
        `pull request #${prNumber} closed`,
      );
      removed++;
    }
    const removedInstances = await markPullRequestClosed(
      deps,
      repositoryId,
      prNumber,
    );
    return {
      status: 200,
      body:
        removedInstances > 0
          ? { removedPreviews: removed, removedInstances }
          : { removedPreviews: removed },
    };
  }
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/instances-webhook.test.ts subgraphs/vetra-apps/__tests__/watcher-webhook.test.ts subgraphs/vetra-apps/__tests__/webhook-push.test.ts`
Expected: PASS (the old-preview webhook tests keep their bodies: `removedInstances` appears only when > 0).

- [ ] **Step 6: Commit**

```bash
git add subgraphs/vetra-apps/instances/reconciler.ts subgraphs/vetra-apps/webhook.ts subgraphs/vetra-apps/__tests__/instances-webhook.test.ts
git commit -m "feat(instances): remove a closed PR's preview, and allow it back on reopen

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The old preview path is off for opted-in apps

**Files:**
- Modify: `subgraphs/vetra-apps/service.ts` (`deployChecked`, near line 3478; a new exported constant near `DEFAULT_PREVIEW_TTL_DAYS`, line 223)
- Modify: `subgraphs/vetra-apps/instances/reconciler.ts` (`retireOldPreviews` in `reconcileApp`)
- Test: `subgraphs/vetra-apps/__tests__/deploy.test.ts`, `subgraphs/vetra-apps/__tests__/instances-previews.test.ts`

**Interfaces:**
- Consumes: `recordSkippedDeployment` (service.ts, private), `deletePreviewsOfApp` (service.ts), `listPreviews` (repo.ts).
- Produces: `PREVIEWS_FROM_INSTANCES` (service.ts): `"previews of this app come from its vetra-publish builds (instances)"`.

- [ ] **Step 1: Write the failing tests.** In `__tests__/deploy.test.ts`, add `PREVIEWS_FROM_INSTANCES` to the `../service.js` import, add `testConfig` to the `./harness.js` import, and append:

```ts
describe("PREVIEW deploys of an app on instances", () => {
  const optIn = () =>
    h.db
      .updateTable("apps")
      .set({ instances_enabled: true })
      .where("id", "=", app.id)
      .execute();

  it("are recorded as SUPERSEDED and touch no environment", async () => {
    await optIn();
    const envsBefore = h.envs.docs.size;
    const d = await deployAsCi(h.deps, claim("refs/pull/12/merge"), preview(12));
    expect(d).toMatchObject({
      status: "SUPERSEDED",
      kind: "PREVIEW",
      error: PREVIEWS_FROM_INSTANCES,
      environment_id: null,
    });
    expect(await getPreview(h.db, app.id, 12)).toBeNull();
    expect(h.envs.docs.size).toBe(envsBefore);
    expect(h.github.calls.getPullRequestState).toBeUndefined();
  });

  it("leave the production deploy as it is", async () => {
    await optIn();
    const d = await deployAsCi(h.deps, claim("refs/heads/main"), prod());
    expect(d).toMatchObject({ status: "DEPLOYING", kind: "PRODUCTION" });
  });

  it("deploy as before while the instances kill switch is off", async () => {
    await h.close();
    h = await makeHarness(
      testConfig({ instances: { enabled: false, labelSuffix: "" } }),
    );
    app = await seedActiveApp(h);
    h.envs.setStatus(app.production_environment_id, "READY");
    await optIn();
    const d = await deployAsCi(h.deps, claim("refs/pull/12/merge"), preview(12));
    expect(d.status).not.toBe("SUPERSEDED");
    expect(await getPreview(h.db, app.id, 12)).not.toBeNull();
  });
});
```

In `__tests__/instances-previews.test.ts`, add imports `import { deployApp } from "../service.js";`, `import { listPreviews } from "../repo.js";`, `owner` to the `./harness.js` import, and append:

```ts
describe("old previews", () => {
  const oldPreview = (pr: number) =>
    deployApp(h.deps, owner, {
      appId,
      kind: "PREVIEW",
      prNumber: pr,
      gitRef: `refs/pull/${pr}/merge`,
      sha: "abcdef1234567890abcdef1234567890abcdef12",
      packages: [{ name: "@acme/shop", version: `1.2.0-pr.${pr}.abcdef1` }],
    });

  it("are deleted once the app is on instances", async () => {
    await setApp({ instances_enabled: false });
    const app = await h.db.selectFrom("apps").selectAll().where("id", "=", appId).executeTakeFirstOrThrow();
    h.envs.setStatus(app.production_environment_id, "READY");
    const d = await oldPreview(7);
    await setApp({ instances_enabled: true });
    await reconcileInstancesOnce(h.deps);
    expect(await listPreviews(h.db, appId)).toEqual([]);
    expect(h.envs.deleted).toContain(d.environment_id);
  });

  it("stay for an app that is not on instances", async () => {
    await setApp({ instances_enabled: false });
    const app = await h.db.selectFrom("apps").selectAll().where("id", "=", appId).executeTakeFirstOrThrow();
    h.envs.setStatus(app.production_environment_id, "READY");
    await oldPreview(7);
    await reconcileInstancesOnce(h.deps);
    expect(await listPreviews(h.db, appId)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/deploy.test.ts subgraphs/vetra-apps/__tests__/instances-previews.test.ts -t "instances|old previews"`
Expected: FAIL (`PREVIEWS_FROM_INSTANCES` undefined; old previews remain).

- [ ] **Step 3: No-op in `deployChecked`.** In `service.ts`, after `export const PREVIEW_COMMENT_MARKER = …;` add:

```ts
/** Why an old-path PREVIEW deploy of an app on instances is not applied (releases phase 2 slice 2). */
export const PREVIEWS_FROM_INSTANCES =
  "previews of this app come from its vetra-publish builds (instances)";
```

In `deployChecked`, directly after `const image = resolveImage(app, input.imageTag, productionState);` and before the closed-PR check, add:

```ts
  // An app on instances gets its PR previews from vetra-publish builds
  // (instances/reconciler.ts): the old action's preview deploy is recorded,
  // never applied, so a PR never has two previews. The kill switch
  // (VETRA_APPS_INSTANCES=off) hands previews back to this path.
  if (
    input.kind === "PREVIEW" &&
    app.instances_enabled &&
    deps.cfg.instances.enabled
  ) {
    return recordSkippedDeployment(deps, app, {
      prNumber,
      gitRef: actor.gitRef,
      sha: input.sha.toLowerCase(),
      runUrl,
      actorGithub: actor.github,
      actorDid: actor.did,
      packages: input.packages.map((p) => ({
        name: p.name,
        version: p.version,
      })),
      imageTag: image ? `${image.repository}:${image.tag}` : null,
      reason: PREVIEWS_FROM_INSTANCES,
      trigger: actor.trigger,
      onBehalfOf: actor.onBehalfOf,
    });
  }
```

- [ ] **Step 4: Retire old previews.** In `instances/reconciler.ts`, add imports `import { listPreviews } from "../repo.js";` (merge into the existing `../repo.js` import) and `import { deletePreviewsOfApp, PREVIEWS_FROM_INSTANCES } from "../service.js";` (merge with the existing type import: `import { deletePreviewsOfApp, PREVIEWS_FROM_INSTANCES, type AppsDeps } from "../service.js";`). Add after `wantsPreviews`:

```ts
/**
 * An app on instances has no old-path previews (overview slice 2): they are
 * deleted through deletePreview, which only deletes this app's PREVIEW
 * documents and marks their deployments SUPERSEDED.
 */
async function retireOldPreviews(deps: AppsDeps, app: AppRow): Promise<void> {
  if (!wantsInstances(app)) return;
  if ((await listPreviews(deps.db, app.id)).length === 0) return;
  await deletePreviewsOfApp(deps, app, PREVIEWS_FROM_INSTANCES);
}
```

and in `reconcileApp`, after `await syncPreviewInstances(deps, app);`, add `await retireOldPreviews(deps, app);`.

If `service.ts` importing nothing from `instances/` stays true, there is no import cycle at load time (`reconciler.ts` → `service.ts` only); check with `grep -n "instances/" subgraphs/vetra-apps/service.ts` (expected: no output).

- [ ] **Step 5: Run the tests**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/deploy.test.ts subgraphs/vetra-apps/__tests__/instances-previews.test.ts subgraphs/vetra-apps/__tests__/watcher-webhook.test.ts subgraphs/vetra-apps/__tests__/ci.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add subgraphs/vetra-apps/service.ts subgraphs/vetra-apps/instances/reconciler.ts subgraphs/vetra-apps/__tests__/deploy.test.ts subgraphs/vetra-apps/__tests__/instances-previews.test.ts
git commit -m "feat(instances): old-path previews off for apps on instances

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Whole-suite check

- [ ] **Step 1:** `npm run tsc 2>&1 | tail -20`. Expected: no errors.
- [ ] **Step 2:** `npm run lint 2>&1 | tail -20`. Expected: no errors (fix, never disable a rule).
- [ ] **Step 3:** `npx vitest run subgraphs/vetra-apps processors/vetra-cloud-environment subgraphs/vetra-licensing 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: no FAIL; the licensing suite is untouched by this plan and stays green.
- [ ] **Step 4:** If anything was fixed: `git commit -am "fix(instances): <what>"` with the trailer.

---

### Task 8: Staging, then production (needs the user for every push and pin)

- [ ] **Step 1: PR and merge.** PR from `feat/releases-phase-2-previews` (description: the overview's slice 2 section and this plan's gap rulings). The user merges; `main` publishes `0.0.<n>`.
- [ ] **Step 2: Staging pin (user PR in `powerhouse-k8s-hosting`).** `tenants/staging/powerhouse-values.yaml`, `PH_REGISTRY_PACKAGES` in both places. Wait for the roll (1-1.5 min).
- [ ] **Step 3: Verify on the staging test app** (`instancesEnabled` already on).
  - Open PR A from a branch of the test repo: vetra-publish reports a build `…-pr.<A>.<run>`; within a minute `appInstances` shows `pr-<A>` `updating`, URL `https://<slug>-pr-<A>-<6 hex>-stg.vetra.io`; then `ready`. The pod's `imageID` ends in the build's digest.
  - Push to PR A: the preview moves to the new build.
  - The old action's PR job (if the repo still runs it) gets a `SUPERSEDED` deployment and does not fail the job; no `app_previews` row appears (`vetraApps.app(...).previews` empty). If the old job fails on `SUPERSEDED`, stop and tell the user (the action release is slice 7).
  - Open PR B: two previews. `updateApp(input: { previewLimit: 1 })`: the older-updated one goes within a pass. Set it back to 5.
  - Close PR A: its preview is removed, its tenant dir leaves `previews/`; re-run PR A's last workflow run: no preview comes back. Reopen PR A: the preview returns.
  - Merge PR B: preview removed; the merge's push build updates the branch instance `main` (slice 1), unaffected.
  - Nothing else moved: licensing logs and `vetraPublisher.environments` show no activity caused by the test; an app not on instances still gets old previews on a PR.
- [ ] **Step 4: Production pin** (not inside the Sektar window, Task 0 Step 3): `tenants/vetra/powerhouse-values.yaml`, `PH_REGISTRY_PACKAGES` (two places). No app on production has `instancesEnabled` unless an owner turned it on; for those, their old previews are deleted on the first pass (announce to their owners first).

---

## Spec gaps touching previews (overview list): rulings

| Gap | Ruling here | Why |
|---|---|---|
| 1. Removing `ci/deploy` freezes production | Resolved for this slice: only `kind: PREVIEW` is turned off, only for opted-in apps; PRODUCTION deploy and rollback untouched | Shared plans still follow the production environment until phase 3. |
| 2. Deprecating the old action cuts licensed envs off | Deferred to slice 7: the action is not changed; the server answers its PR deploys with a recorded no-op | Old-action PR jobs keep passing; `ci/artifacts` and tag runs are untouched. |
| 3. Which branches get branch instances | Not affected: PR builds (`pr` set, `branch` null) never feed branch targets (`branchTargets` filters `pr is null`) | Already enforced in slice 1. |
| 4. Host collisions | Resolved: `instanceLabel(appId, slug, "pr-<n>", suffix)`, hash over app id and name, kept on the tombstone; the unique index stays the last guard. A release branch literally named `pr-<n>` would share the label: the second one fails "host taken". Reserving `pr-<n>` as a branch/plan name is deferred to phase 3 (plan slugs) | The overlap needs a release branch named like a PR, which nothing produces today. |
| 5. `/data` persistence | Resolved: previews render as PREVIEW like branch instances (no kept `/data`) | Previews are disposable by definition. |
| 6. Built-in dev template | Resolved as slice 1: size S, `vetra.io`, no extra services. `requires.services` → `failed: plan can't be provisioned` deferred with branch instances | Same render path; nothing new for previews. |
| 7. Publisher settings | Deferred to slice 4 | Applies to all instance kinds at once. |
| 8. Host-reported version | Deferred to slice 3; previews use slice 1's interim health rule | Same status code path. |
| 9. `ADMINS` = org admins | Deferred to slice 4; previews get the owner, as branch instances | Needs a Renown query. |
| 10. GitHub permissions for checks | Deferred to slice 5 (PR comment, check, PR-title check) | 14.18 is a later slice; this slice needs only the PR read it already has. |
| 11. `instances` replaces `app_deployments` | Clarified: the no-op still writes one `SUPERSEDED` audit row in `app_deployments` per old-action PR run until slice 7 removes that path | Keeps the old action's response contract. |
| 12. Build pruning vs running instances | Deferred to a later slice (with registry retention); this slice only stops following PR builds (TTL, close) | Decision taken: pruning is not part of slice 2. |
| 13. Warm pool | None for previews | Only licensed warm pools exist. |

Also ruled here:
- **14.13 "oldest PR's preview is removed first"** reads as the oldest-*updated* PR (lowest newest-build run), as decided; a long-open PR that keeps getting builds keeps its preview.
- **"At most 5" and "7 days"** are the existing per-app settings `preview_limit` (default 5, 1-20) and `preview_ttl_days` (default 7, 1-90), which the spec's "configurable" asks for; `previews_enabled = false` means no preview instances.
- **Same-repository PRs**: GitHub issues no OIDC token to fork `pull_request` runs by default, but private repos can allow it, so the reconciler checks the head repository once per new PR instead of trusting that.
- **Old previews at enable time** are deleted by the reconciler (overview slice 2 "Removes"), not left to expire.

## Self-review

**Spec coverage:** section 5 preview row (one per open PR, newest build, removed when PR closed): Tasks 2, 4, 5. Section 6 (targets move on every build of the PR; failed update stays on previous digest; status words): Task 4 via slice 1's `reconcileInstance` unchanged. 14.13 (limit, oldest first, single Postgres without backups): Tasks 2, 4 (render as PREVIEW); sleep: slice 6. 14.17 (newest = highest run): Task 2 test. Hosts (`pr-<n>`): Task 4. Old path off for opted-in apps, unchanged for others, kill switch fallback: Task 6. Licensed environments untouched: no new environment write path; `deletePreview` and `instanceUpdateActions` guards; licensing suite in Task 7.

**Placeholder scan:** every code step carries its code; the one conditional (Kysely `in` subquery typing, Task 2) states the exact fallback.

**Type consistency:** `previewCandidates(db, appId, sinceIso)` and `pickPreviews(candidates, excluded, limit)` (Task 2) used in Task 4; `pullRequestGate` returns `"open" | "closed" | "fork" | "unknown"` (Task 4) and uses `getPullRequest` → `{ state, headRepositoryId }` (Task 1); `CreateInstanceInput.prNumber` (Task 3) set in Task 4 (f); `PR_CLOSED`/`PR_FORK`/`PR_REOPENED` (Task 4) used in Task 5; `PREVIEWS_FROM_INSTANCES` (Task 6) used in service and reconciler; `h.github.prHeadRepos` and `prStates` `"missing"` (Task 1) used in Task 4 tests; `seedRelease(…, { createdAt })` (Task 2) used in Tasks 4, 5.

## Not in this plan

Build pruning and Harbor retention (later slice, with 14.6), PR comment and Vetra check with the PR-title check (slice 5), sleeping idle previews (slice 6), health (slice 3), settings (slice 4), removing the old preview path for every app and the old action's PR refusal (slice 7). The console (vetra.to) shows previews through the existing `appInstances` query (`kind: "preview"`, `pr`); grouping them under the app's Instances tab is a vetra.to change.
