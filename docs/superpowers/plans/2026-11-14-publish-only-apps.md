# Publish-only apps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Creating an app connects the repository and creates no environment; the wizard has no environment step.

**Architecture:** `apps.production_environment_id` becomes nullable; null means publish-only. `createApp` only attaches an environment when one is passed explicitly and otherwise creates none. Every deploy-path reader goes through one guard (`deployEnvOf`), every read path treats null as "no environment". The generated workflow drops the old `deploy` job for such apps. The console wizard drops the environment section; the app page hides Production and Deployments for such apps.

**Tech Stack:** vetra-cloud-package (TypeScript, Kysely, PGlite, vitest, pnpm, oxlint/oxfmt); vetra.to (Next.js, React, vitest, Testing Library, npm).

**Spec:** `docs/superpowers/specs/2026-11-14-publish-only-apps-design.md` (vetra-cloud-package)

## Global Constraints

- Never add "Generated with Claude Code" lines or `Co-Authored-By: Claude` trailers to commits or PRs.
- Work on branches: vetra-cloud-package `feat/publish-only-apps` (exists, has the spec), vetra.to `feat/publish-only-apps`. Never commit on `main`.
- Refusal for a deploy on a publish-only app: code `BAD_USER_INPUT`, message exactly `This app publishes releases; it has no deploy environment`.
- Existing apps and Vetra Studio apps (`createStudioApp`) keep their environment and behaviour unchanged.
- `createApp` keeps the `productionEnvironmentId` input as an explicit attach.
- GraphQL: only `App.productionEnvironmentId: String!` → `String`; no type added or renamed (gateway composition).
- Pre-existing, unrelated failures: `subgraphs/vetra-licensing/__tests__/studio-access-factory.test.ts` (2 tests) fail on `main`; ignore them.
- vetra-cloud-package checks: `pnpm tsc`, `pnpm lint`, `pnpm vitest run <files>`. vetra.to checks: `npm run tsc`, `npx eslint <files>`, `npm run test:unit`.

---

## Part A — vetra-cloud-package

### Task 1: Nullable production environment column

**Files:**
- Modify: `subgraphs/vetra-apps/db/migrations.ts` (add `ensureAppsProductionEnvNullable`, call it at the end of `up`, after `await ensureSwitchoverSchema(db);`)
- Test: `subgraphs/vetra-apps/__tests__/migrations.test.ts`

**Interfaces:**
- Produces: `export async function ensureAppsProductionEnvNullable(db: Kysely<any>): Promise<void>`

- [ ] **Step 1: Write the failing test** (append to `migrations.test.ts`; use the file's existing imports, add the ones missing)

```ts
import { makeHarness, seedActiveApp } from "./harness.js";

describe("apps.production_environment_id", () => {
  it("accepts null (publish-only apps) and the migration runs twice", async () => {
    const h = await makeHarness();
    try {
      const app = await seedActiveApp(h);
      await h.db
        .updateTable("apps")
        .set({ production_environment_id: null as never })
        .where("id", "=", app.id)
        .execute();
      const row = await h.db
        .selectFrom("apps")
        .select("production_environment_id")
        .where("id", "=", app.id)
        .executeTakeFirstOrThrow();
      expect(row.production_environment_id).toBeNull();
      const { ensureAppsProductionEnvNullable } = await import("../db/migrations.js");
      await ensureAppsProductionEnvNullable(h.db as never);
    } finally {
      await h.close();
    }
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** — `pnpm vitest run subgraphs/vetra-apps/__tests__/migrations.test.ts` → fails with a not-null violation on `production_environment_id`.

- [ ] **Step 3: Implement** (in `migrations.ts`)

```ts
/** Publish-only apps (spec 2026-11-14) have no production environment. Idempotent: DROP NOT NULL on a nullable column is a no-op. */
export async function ensureAppsProductionEnvNullable(
  db: Kysely<any>,
): Promise<void> {
  await db.schema
    .alterTable("apps")
    .alterColumn("production_environment_id", (c) => c.dropNotNull())
    .execute();
}
```

and in `up`, after `await ensureSwitchoverSchema(db);`:

```ts
  await ensureAppsProductionEnvNullable(db);
```

- [ ] **Step 4: Run it, expect PASS** — same command.

- [ ] **Step 5: Commit**

```bash
git add subgraphs/vetra-apps/db/migrations.ts subgraphs/vetra-apps/__tests__/migrations.test.ts
git commit -m "feat(apps): production_environment_id may be null (publish-only apps)"
```

### Task 2: Type change and the deploy guard

**Files:**
- Modify: `subgraphs/vetra-apps/db/schema.ts` (`production_environment_id: string;` → `production_environment_id: string | null;`)
- Modify: `subgraphs/vetra-apps/service.ts` (add `NO_DEPLOY_ENV`, `deployEnvOf`; use them at the sites below; `InsertAppRowInput.productionEnvironmentId: string | null`; `deleteApp`)
- Modify: `subgraphs/vetra-apps/watcher.ts:245`, `subgraphs/vetra-apps/org-ownership.ts:277`, `subgraphs/vetra-apps/resolvers.ts:272`
- Test: create `subgraphs/vetra-apps/__tests__/publish-only.test.ts`

**Interfaces:**
- Produces: `export const NO_DEPLOY_ENV: string`, `export function deployEnvOf(app: Pick<AppRow, "production_environment_id">): string` (both in `service.ts`)
- Produces (test helper, same file): `async function makePublishOnly(h: Harness, appId: string): Promise<void>` sets the column to null.

- [ ] **Step 1: Write the failing tests** (`publish-only.test.ts`)

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteApp,
  deployApp,
  NO_DEPLOY_ENV,
  rollbackApp,
} from "../service.js";
import { reconcileAppOwnership } from "../org-ownership.js";
import { makeHarness, owner, seedActiveApp, type Harness } from "./harness.js";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(() => h.close());

async function makePublishOnly(h: Harness, appId: string) {
  await h.db
    .updateTable("apps")
    .set({ production_environment_id: null })
    .where("id", "=", appId)
    .execute();
}

const sha = "a".repeat(40);
const failure = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected a refusal");
    },
    (e: { message: string; extensions: { code: string } }) => e,
  );

describe("an app without a production environment (publish-only)", () => {
  it("refuses deploys with NO_DEPLOY_ENV", async () => {
    const app = await seedActiveApp(h);
    await makePublishOnly(h, app.id);
    const err = await failure(
      deployApp(h.deps, owner, {
        appId: app.id,
        kind: "PRODUCTION",
        sha,
        gitRef: "refs/heads/main",
        packages: [],
      }),
    );
    expect(err.extensions.code).toBe("BAD_USER_INPUT");
    expect(err.message).toBe(NO_DEPLOY_ENV);
    expect(NO_DEPLOY_ENV).toBe(
      "This app publishes releases; it has no deploy environment",
    );
  });

  it("refuses rollbacks with NO_DEPLOY_ENV", async () => {
    const app = await seedActiveApp(h);
    const now = new Date().toISOString();
    await h.db
      .insertInto("app_deployments")
      .values({
        id: "dep-1",
        app_id: app.id,
        kind: "PRODUCTION",
        status: "READY",
        environment_id: "gone",
        sha,
        git_ref: "refs/heads/main",
        packages: "[]",
        created_at: now,
        updated_at: now,
      } as never)
      .execute();
    await makePublishOnly(h, app.id);
    const err = await failure(rollbackApp(h.deps, owner, "dep-1"));
    expect(err.message).toBe(NO_DEPLOY_ENV);
  });

  it("deletes the app without touching any environment", async () => {
    const app = await seedActiveApp(h);
    await makePublishOnly(h, app.id);
    const before = h.envs.deleted.length;
    expect(await deleteApp(h.deps, owner, app.id, true)).toBe(true);
    expect(h.envs.deleted.length).toBe(before);
  });

  it("resolves no production URLs", async () => {
    const app = await seedActiveApp(h);
    await makePublishOnly(h, app.id);
    const { appJson } = await import("../resolvers.js");
    const row = await h.db
      .selectFrom("apps")
      .selectAll()
      .where("id", "=", app.id)
      .executeTakeFirstOrThrow();
    const json = appJson(h.deps, row);
    expect(json.productionEnvironmentId).toBeNull();
    expect(await json.productionUrls()).toStrictEqual({
      app: null,
      connect: null,
      switchboard: null,
    });
  });
});
```

Before writing the rollback and URL tests, check two names against the code and adjust the test (not the code) if they differ: the `app_deployments` column list in `subgraphs/vetra-apps/db/schema.ts` (fill every NOT NULL column), and the exported function in `resolvers.ts` that maps an `AppRow` to the GraphQL `App` (the object at `resolvers.ts:255-275`; if it is not exported, export it as `appJson(deps, app)` in this task). `reconcileAppOwnership` is covered in Task 3's org tests; drop its import if unused.

- [ ] **Step 2: Run, expect FAIL** — `pnpm vitest run subgraphs/vetra-apps/__tests__/publish-only.test.ts` → `NO_DEPLOY_ENV` is not exported.

- [ ] **Step 3: Implement**

In `db/schema.ts`: `production_environment_id: string | null;` (with the comment `/** Null: a publish-only App (spec 2026-11-14); it has no deploy environment. */`).

In `service.ts`, next to `assertProductionEnv`:

```ts
export const NO_DEPLOY_ENV =
  "This app publishes releases; it has no deploy environment";

/** The App's production env id. A publish-only App (no production env) refuses every deploy. */
export function deployEnvOf(
  app: Pick<AppRow, "production_environment_id">,
): string {
  if (app.production_environment_id === null)
    throw appsError("BAD_USER_INPUT", NO_DEPLOY_ENV);
  return app.production_environment_id;
}
```

Sites in `service.ts` (line numbers as of `origin/main` 2026-11-14):
- `deployChecked`: right after `if (app.status !== "ACTIVE") throw …`, add `const envId = deployEnvOf(app);`; replace `deps.envs.getState(app.production_environment_id)` (≈3613) with `deps.envs.getState(envId)`.
- `rollbackApp`: right after its `APP_NOT_ACTIVE` check, add `const envId = deployEnvOf(app);`; replace the `getState(app.production_environment_id)` (≈3713) with `getState(envId)`.
- `performDeploy` (≈4092): `envId: deployEnvOf(app),`.
- `studioProductionEnv` (≈4190): `await deps.envs.getState(deployEnvOf(app)),`.
- `findStudioLaunch` (≈4223-4228): add `const envId = deployEnvOf(app);` before `const rows`, use `envId` in both places.
- `queueStudioDeployment` (≈4250) and `pointConnectAtDrive` (≈4458): `const envId = deployEnvOf(app);`.
- `InsertAppRowInput.productionEnvironmentId: string | null;`.
- `deleteApp` (≈3105):

```ts
  if (deleteEnvironments && app.production_environment_id !== null) {
    const prodId = app.production_environment_id;
    const prod = await deps.envs.getState(prodId);
    if (prod?.app?.appId === app.id) await deps.envs.delete(prodId);
  }
```

`watcher.ts` (≈245):

```ts
  const envId = app.production_environment_id;
  const env = envId === null ? null : await deps.envs.getState(envId);
  let envNote = envId === null ? "no production env" : "env already gone";
  if (
    envId !== null &&
    env &&
```

(the rest of the condition unchanged).

`org-ownership.ts` (≈277):

```ts
    const envIds = [
      ...(row.production_environment_id ? [row.production_environment_id] : []),
      ...(await listPreviews(deps.db, row.id)).map((p) => p.environment_id),
    ];
```

`resolvers.ts` (≈272):

```ts
    productionUrls: async () =>
      envUrls(
        app.production_environment_id
          ? await deps.envs.getState(app.production_environment_id)
          : null,
      ),
```

Then run `pnpm tsc`. Every remaining error is a `string | null` where a string is needed. Rule: on a deploy or Studio path use `deployEnvOf(app)`; on a read path treat null as "no environment" (skip, or `null`). Equality comparisons (`!== app.production_environment_id`) need no change. `subgraphs/vetra-licensing/index.ts:283` is fixed in Task 5; until then leave it to Task 5 only if `pnpm tsc` passes (it reads through an untyped namespace); otherwise apply Task 5 Step 3 now.

- [ ] **Step 4: Run, expect PASS** — `pnpm vitest run subgraphs/vetra-apps/__tests__/publish-only.test.ts` and `pnpm tsc` (no errors).

- [ ] **Step 5: Regression** — `pnpm vitest run subgraphs/vetra-apps subgraphs/vetra-licensing processors` → only the 2 pre-existing `studio-access-factory` failures.

- [ ] **Step 6: Commit**

```bash
git add -A subgraphs/vetra-apps
git commit -m "feat(apps): an app without a production env refuses deploys (deployEnvOf)"
```

### Task 3: createApp creates no environment

**Files:**
- Modify: `subgraphs/vetra-apps/service.ts` (`createApp`, ≈866-915)
- Modify: `subgraphs/vetra-apps/__tests__/harness.ts` (add `seedLegacyProductionEnv`; `seedActiveApp` attaches it)
- Modify: `subgraphs/vetra-apps/__tests__/apps.test.ts`, `org-apps.test.ts`, `studio-apps-errors.test.ts`

**Interfaces:**
- Consumes: Task 2's nullable type.
- Produces: `export async function seedLegacyProductionEnv(h: Harness, name: string, address?: string): Promise<string>` in `harness.ts`.

- [ ] **Step 1: Rewrite the createApp test to the new behaviour** (`apps.test.ts`, the test "creates Harbor project + robot, Renown identity and a new production env"): rename it to `"creates Harbor project + robot and Renown identity, and no environment"`, keep every assertion up to `h.renown.registered`, and replace the env assertions (`const env = await h.envs.getState(…)` through the `services` expectation) with:

```ts
    expect(app.production_environment_id).toBeNull();
    expect(h.envs.docs.size).toBe(0);
```

- [ ] **Step 2: Run, expect FAIL** — `pnpm vitest run subgraphs/vetra-apps/__tests__/apps.test.ts -t "no environment"` → an env was created.

- [ ] **Step 3: Implement** in `createApp`: replace

```ts
    if (attachEnvState) {
      envId = input.productionEnvironmentId!;
    } else {
      envId = await deps.envs.create();
      made.envId = envId;
    }
```

with

```ts
    // Publish-only (spec 2026-11-14): an environment only when one is attached.
    envId = attachEnvState ? input.productionEnvironmentId! : null;
```

declare `let envId: string | null;`, and wrap the provisioning:

```ts
    if (attachEnvState && envId !== null) {
      step = "provisioning the production environment";
      await provisionProductionEnv(
        deps,
        caller,
        {
          envId,
          appId,
          name,
          harborProject,
          productionBranch,
          orgId,
          attach: { state: attachEnvState },
        },
        made,
      );
    }
```

Rename the step string `"creating the production environment"` to `"recording the production environment"`. Update the final log line to `env ${envId ?? "none"}`.

- [ ] **Step 4: Run, expect PASS** — same command.

- [ ] **Step 5: Harness helper** (`harness.ts`; import `setLabel`, `initialize`, `setOwner`, `enableService`, `approveChanges` the same way `seedStandalone` does):

```ts
/**
 * The production env createApp made before publish-only apps (spec
 * 2026-11-14): tests of the old deploy path start from it, attached.
 */
export async function seedLegacyProductionEnv(
  h: Harness,
  name: string,
  address = OWNER,
): Promise<string> {
  const id = await h.envs.create();
  await h.envs.execute(id, [
    setLabel({ label: name }),
    initialize({
      genericSubdomain: `sub-${id}`,
      genericBaseDomain: "vetra.io",
      defaultPackageRegistry: "https://registry.vetra.io",
    }),
    setOwner({ address }),
    enableService({ type: "SWITCHBOARD", prefix: "switchboard" }),
    enableService({ type: "CONNECT", prefix: "connect" }),
  ]);
  return id;
}
```

and in `seedActiveApp`:

```ts
  const envId =
    productionEnvironmentId ?? (await seedLegacyProductionEnv(h, name));
  const app = await createApp(h.deps, owner, {
    name,
    installationId: INSTALLATION,
    repositoryId: REPO_ID,
    productionEnvironmentId: envId,
  });
  if (!productionEnvironmentId)
    await h.envs.execute(envId, [approveChanges({})]);
```

- [ ] **Step 6: Update the tests that relied on a created env.** Run `pnpm vitest run subgraphs/vetra-apps subgraphs/vetra-licensing processors`. Expected failures (from a dry run on 2026-11-14) and the fix for each:
  - `org-apps.test.ts` "createApp in an organisation" (8 tests): every `createApp(h.deps, owner, input)` / `{ ...input, … }` call that should still get an environment passes `productionEnvironmentId: await seedLegacyProductionEnv(h, input.name)`; the hand-over assertions stay (the attach path hands an env without an org to the org and announces it).
  - `apps.test.ts` "makes slugs unique", "never hands out the studio app's reserved slug", "confirmAppIdentity activates only once the delegation exists", "create → delete → create with the same name": add `productionEnvironmentId: await seedLegacyProductionEnv(h, "<the name passed>")` to each direct `createApp` call, unless the test asserts nothing about environments, in which case keep it publish-only and delete env-only assertions.
  - `reactor-errors.test.ts` (7 tests): these use `seedActiveApp`; they pass once Step 5 is in. If any still fails, compare the env state with `seedLegacyProductionEnv` (label, owner, services, `CHANGES_APPROVED`) and align the helper, not the test.
  - `studio-apps-errors.test.ts` "createApp rollback › deletes the new production env document it created": delete this test (createApp creates no env any more); keep "never deletes an attached env".

- [ ] **Step 7: Run all, expect PASS** — `pnpm vitest run subgraphs/vetra-apps subgraphs/vetra-licensing processors` → only the 2 pre-existing failures; `pnpm tsc` clean.

- [ ] **Step 8: Commit**

```bash
git add -A subgraphs/vetra-apps
git commit -m "feat(apps): createApp creates no environment (publish-only apps)"
```

### Task 4: Workflow without the deploy job

**Files:**
- Modify: `subgraphs/vetra-apps/workflow-template.ts` (4th parameter), `subgraphs/vetra-apps/service.ts` (`openAppSetupPullRequest`)
- Test: create `subgraphs/vetra-apps/__tests__/workflow-template.test.ts`; extend `apps.test.ts` ("opens the setup PR …")

**Interfaces:**
- Produces: `workflowTemplate(appId: string, productionBranch?: string, repo?: {...}, options?: { deploy?: boolean }): string` — `deploy` defaults to `true`.

- [ ] **Step 1: Failing tests**

```ts
// workflow-template.test.ts
import { describe, expect, it } from "vitest";
import { workflowTemplate } from "../workflow-template.js";

describe("workflowTemplate", () => {
  it("keeps the deploy job by default (existing apps)", () => {
    const yaml = workflowTemplate("app-1", "main");
    expect(yaml).toContain("powerhouse-inc/vetra-publish@v1");
    expect(yaml).toContain("powerhouse-inc/vetra-deploy-action@v1");
  });

  it("has only the publish job for a publish-only app", () => {
    const yaml = workflowTemplate("app-1", "main", {}, { deploy: false });
    expect(yaml).toContain("powerhouse-inc/vetra-publish@v1");
    expect(yaml).not.toContain("vetra-deploy-action");
    expect(yaml).not.toMatch(/^\s+deploy:/m);
  });
});
```

and in `apps.test.ts`, a new test next to "opens the setup PR with the workflow for this App":

```ts
  it("opens a publish-only setup PR for an app without a production env", async () => {
    const app = await seedActiveApp(h);
    await h.db
      .updateTable("apps")
      .set({ production_environment_id: null })
      .where("id", "=", app.id)
      .execute();
    await openAppSetupPullRequest(h.deps, owner, app.id);
    const [, , input] = h.github.calls.openPullRequestWithFile[0] as [
      string,
      string,
      { content: string; body: string },
    ];
    expect(input.content).not.toContain("vetra-deploy-action");
    expect(input.body).not.toContain("vetra-deploy-action");
  });
```

- [ ] **Step 2: Run, expect FAIL** — `pnpm vitest run subgraphs/vetra-apps/__tests__/workflow-template.test.ts subgraphs/vetra-apps/__tests__/apps.test.ts -t "setup PR|workflowTemplate"`.

- [ ] **Step 3: Implement** — `workflowTemplate` gains `options: { deploy?: boolean } = {}`; build the deploy block into a `deployJob` string (the text from `  # The production environment and PR previews…` through `${deployCommands}${branchInput}`) and emit `${options.deploy === false ? "" : deployJob}` in its place, so the publish job's trailing `${commands}` stays. In `openAppSetupPullRequest`: `const deploy = app.production_environment_id !== null;`, pass `{ deploy }` as the 4th argument, and include the `vetra-deploy-action` bullet in `body` only when `deploy` is true.

- [ ] **Step 4: Run, expect PASS** — same command, plus the existing "opens the setup PR with the workflow for this App" still passes.

- [ ] **Step 5: Commit**

```bash
git add subgraphs/vetra-apps/workflow-template.ts subgraphs/vetra-apps/service.ts subgraphs/vetra-apps/__tests__/workflow-template.test.ts subgraphs/vetra-apps/__tests__/apps.test.ts
git commit -m "feat(apps): publish-only apps get a workflow without the deploy job"
```

### Task 5: Licensing never sees a null environment

**Files:**
- Modify: `subgraphs/vetra-apps/repo.ts` (add `appEnvironmentIds`), `subgraphs/vetra-licensing/index.ts:270-286` (use it)
- Test: `subgraphs/vetra-apps/__tests__/publish-only.test.ts` (append)

**Interfaces:**
- Produces: `export async function appEnvironmentIds(db: Kysely<VetraAppsDB>, appId: string): Promise<string[]>` in `repo.ts`.

- [ ] **Step 1: Failing test** (append to `publish-only.test.ts`; add `import { appEnvironmentIds } from "../repo.js";`)

```ts
describe("appEnvironmentIds", () => {
  it("lists the production env, and nothing for a publish-only app", async () => {
    const app = await seedActiveApp(h);
    expect(await appEnvironmentIds(h.db, app.id)).toStrictEqual([
      app.production_environment_id,
    ]);
    await makePublishOnly(h, app.id);
    expect(await appEnvironmentIds(h.db, app.id)).toStrictEqual([]);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `appEnvironmentIds` is not exported.

- [ ] **Step 3: Implement** in `repo.ts`:

```ts
/** The App's production env (if any) and its preview envs: what licensing may treat as the App's own. */
export async function appEnvironmentIds(
  db: Kysely<VetraAppsDB>,
  appId: string,
): Promise<string[]> {
  const [row, previews] = await Promise.all([
    db
      .selectFrom("apps")
      .select("production_environment_id")
      .where("id", "=", appId)
      .executeTakeFirst(),
    db
      .selectFrom("app_previews")
      .select("environment_id")
      .where("app_id", "=", appId)
      .execute(),
  ]);
  return [
    ...(row?.production_environment_id ? [row.production_environment_id] : []),
    ...previews.map((p) => p.environment_id),
  ];
}
```

In `vetra-licensing/index.ts` replace the inline `appEnvironments: async (appId) => { … }` body with `appEnvironments: (appId) => appEnvironmentIds(appsDb, appId),` and import `appEnvironmentIds` from `"../vetra-apps/repo.js"` (next to `getAppByIdentity`).

- [ ] **Step 4: Run, expect PASS**; `pnpm tsc` clean.

- [ ] **Step 5: Commit**

```bash
git add subgraphs/vetra-apps/repo.ts subgraphs/vetra-licensing/index.ts subgraphs/vetra-apps/__tests__/publish-only.test.ts
git commit -m "fix(licensing): an app's environments never include a null production env"
```

### Task 6: GraphQL `App.productionEnvironmentId` nullable

**Files:**
- Modify: `subgraphs/vetra-apps/schema.ts:683` (`productionEnvironmentId: String!` → `productionEnvironmentId: String`)
- Test: `subgraphs/vetra-apps/__tests__/resolvers.test.ts` ("SDL" describe)

- [ ] **Step 1: Failing test** (in the "SDL" describe, using the file's existing schema helper as the neighbouring "App exposes releaseBranches …" test does):

```ts
  it("App.productionEnvironmentId is nullable (publish-only apps)", () => {
    const field = appType().getFields().productionEnvironmentId;
    expect(String(field.type)).toBe("String");
  });
```

Reuse whatever the neighbouring test uses to get the `App` type (rename `appType()` to that).

- [ ] **Step 2: Run, expect FAIL** (`String!`).
- [ ] **Step 3: Implement** the one-word SDL change.
- [ ] **Step 4: Run, expect PASS**.
- [ ] **Step 5: Gateway safety** — `grep -rn "^\s*type \|^\s*input \|^\s*enum " subgraphs/vetra-apps/schema.ts | wc -l` is unchanged against `origin/main` (no type added or renamed).
- [ ] **Step 6: Commit**

```bash
git add subgraphs/vetra-apps/schema.ts subgraphs/vetra-apps/__tests__/resolvers.test.ts
git commit -m "feat(apps): App.productionEnvironmentId is nullable"
```

### Task 7: Backend verification and PR

- [ ] **Step 1:** `pnpm tsc && pnpm lint && npx oxfmt --check .` (run `npx oxfmt` on changed files if the check fails) and `pnpm vitest run` → only the 2 pre-existing failures.
- [ ] **Step 2:** Push `feat/publish-only-apps`, open a PR titled `feat(apps): publish-only apps (no environment at app creation)` whose body summarises the spec and links it. No attribution lines.
- [ ] **Step 3:** Ask the user before merging. After merge the release workflow publishes the next `0.0.x`; note the version.

## Part B — vetra.to (branch `feat/publish-only-apps` from `origin/main`)

### Task 8: App page without a production environment

**Files:**
- Modify: `modules/apps/types.ts:352` (`productionEnvironmentId: string` → `string | null`)
- Modify: `modules/apps/components/app-detail.tsx` (`visibleAppTabs` gains `hasDeployEnv?: boolean`, default `true`; the call site passes `hasDeployEnv: app.productionEnvironmentId !== null`)
- Modify: `modules/apps/components/app-overview.tsx` (`AppOverview` renders `ProductionCard` and `PreviewsSection` only when `app.productionEnvironmentId`)
- Test: `modules/apps/__tests__/app-detail-tabs.test.tsx`

- [ ] **Step 1: Failing test** (in the file's `visibleAppTabs` describe):

```ts
  it('hides Deployments for a publish-only app', () => {
    expect(visibleAppTabs({ isPublisher: true, hasDeployEnv: false })).not.toContain(
      'deployments',
    )
    expect(visibleAppTabs({ isPublisher: true })).toContain('deployments')
  })
```

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run --config vitest.unit.config.ts modules/apps/__tests__/app-detail-tabs.test.tsx`.
- [ ] **Step 3: Implement** — in `visibleAppTabs`, replace `'deployments',` with `...(hasDeployEnv ? (['deployments'] as const) : []),` and add `hasDeployEnv = true` to the destructuring and `/** The app has a production env (old deploy path); publish-only apps do not. */ hasDeployEnv?: boolean` to the props type. In `AppOverview`:

```tsx
      {app.productionEnvironmentId && <ProductionCard app={app} deployment={production} />}
      …
      {app.productionEnvironmentId && <PreviewsSection app={app} />}
```

Change the type in `types.ts`; run `npm run tsc` and fix any remaining use by rendering nothing when null.
- [ ] **Step 4: Run, expect PASS**; `npm run tsc` clean.
- [ ] **Step 5: Commit** — `git commit -am "feat(apps): no Production card or Deployments tab for publish-only apps"`

### Task 9: Wizard without an environment

**Files:**
- Modify: `modules/apps/components/new-app-wizard.tsx`
- Test: create `modules/apps/__tests__/new-app-wizard.test.tsx`

**Interfaces:**
- Produces: `export function ConfigureStep(...)` (exported for the test; signature unchanged).

- [ ] **Step 1: Failing test**

```tsx
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import React from 'react'

const mutate = vi.fn()
vi.mock('../hooks/use-apps', () => ({
  useCreateApp: () => ({ mutate, isPending: false, error: null }),
}))
vi.mock('@/modules/orgs/hooks/use-orgs', () => ({
  useActiveOrg: () => ({ orgId: null, org: null }),
}))
vi.mock('@/modules/cloud/hooks/use-environment', () => ({
  useViewer: () => ({ viewer: { address: '0xabc' } }),
  useEnvironments: () => {
    throw new Error('the wizard must not load environments')
  },
}))

import { ConfigureStep } from '../components/new-app-wizard'

const draft = {
  installationId: '77',
  repo: { id: '4242', fullName: 'acme/shop', defaultBranch: 'main', private: false },
  name: 'Shop',
  productionBranch: 'main',
}

describe('ConfigureStep', () => {
  it('asks for no environment and creates the app without one', () => {
    render(
      <ConfigureStep
        draft={draft as never}
        update={vi.fn()}
        onBack={vi.fn()}
        onCreated={vi.fn()}
      />,
    )
    expect(screen.queryByText(/environment/i)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /create app/i }))
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(mutate.mock.calls[0][0]).not.toHaveProperty('productionEnvironmentId')
  })
})
```

Match `draft.repo` to the `GithubRepo` type in `modules/apps/types.ts` (fill its required fields).

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run --config vitest.unit.config.ts modules/apps/__tests__/new-app-wizard.test.tsx`.
- [ ] **Step 3: Implement**
  - Delete the `<fieldset>` "Production environment" block, `EnvMode`, `envMode`/`existingEnvId` from `Draft` and `EMPTY_DRAFT`, `envError`, the `useEnvironments`/`useViewer` calls, `standalone`, and the `productionEnvironmentId` line in `createApp.mutate`. Remove now-unused imports (`Rocket`, `Server`, `Select*`, `useEnvironments`, `useViewer`, `attachableEnvironments`, `useMemo` if unused).
  - Export `ConfigureStep`.
  - `ConfigureStep` description: `"Releases are cut from this branch. Merge the setup pull request next, and every push publishes."`; `branchError`: `'Pick the branch releases are cut from'`.
  - `STEPS`: `{ id: 'deploys', label: 'Publish' }`; `DeploysStep` title `"Set up publishing"`, description: `Add the Vetra workflow to <repo>. Every push publishes a build; merging the release pull request publishes a release.`; the PENDING_IDENTITY note: `Publishing starts once the app identity is authorized. You can do that from the app page any time.`
  - `useCreateApp` (`modules/apps/hooks/use-apps.ts`): drop the `['environments']` invalidation and its comment.
- [ ] **Step 4: Run, expect PASS**; `npm run tsc`; `npx eslint modules/apps`; `npm run test:unit` all green.
- [ ] **Step 5: Commit** — `git commit -am "feat(apps): the new-app wizard creates no environment"`

### Task 10: Rollout

- [ ] **Step 1:** Push vetra.to `feat/publish-only-apps`, open a PR (no attribution lines). Ask the user before merging either PR.
- [ ] **Step 2:** After the backend PR is merged and published as `0.0.N`: in powerhouse-k8s-hosting, on a branch, pin `@powerhousedao/vetra-cloud-package@0.0.N` in `tenants/staging/powerhouse-values.yaml` (`PH_REGISTRY_PACKAGES`), PR, merge, wait for the staging switchboard rollout.
- [ ] **Step 3: Staging checks** — gateway: `curl -s https://switchboard.staging.vetra.io/graphql -H 'content-type: application/json' -d '{"query":"{ vetraPublisher { __typename } }"}'` returns data, and `kubectl --context k3s -n staging logs deploy/powerhouse-staging-switchboard --since=10m | grep -c 'Excluding subgraph'` is `0`; migration ran: `kubectl --context k3s -n staging exec staging-pg-1 -c postgres -- psql -U postgres -d staging_db -Atc "select is_nullable from information_schema.columns where table_schema='hcnlbjgnam' and table_name='apps' and column_name='production_environment_id'"` is `YES`.
- [ ] **Step 4: Staging rehearsal** (with the user, on staging.vetra.io after the vetra.to staging image is out): create an app from a test repository — no environment step, no environment created; merge the setup PR — workflow has no `deploy` job; a build appears in Releases; Overview shows no Production card, no Deployments tab; an existing app (e.g. the canary) still opens and its Deployments tab still shows.
- [ ] **Step 5: Production** — same pin in `tenants/vetra/powerhouse-values.yaml`, PR, merge, the Step 3 checks against `switchboard.vetra.io` / namespace `vetra` / `vetra-pg-1` `vetra_db` (read-only SELECT), then merge vetra.to and confirm the image `main-<sha>` rolls out.
