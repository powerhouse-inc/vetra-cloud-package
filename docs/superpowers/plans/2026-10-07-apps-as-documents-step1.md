# Apps as Documents — Step 1 (model, backfill, dual-write)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a `vetra-app` document model carrying each app's facts and published artifacts, backfill one document per existing app row **using the row's own id**, and dual-write every app change to both stores — without moving any read.

**Architecture:** Additive by construction. Reads continue to come from the `apps` table for the whole of this step, so behaviour is unchanged and the document is proven correct before anything depends on it. A reconciler reports drift rather than repairing it, so a write bug is visible.

**Tech Stack:** TypeScript, Powerhouse document models (`ph-cli generate`), Kysely (Postgres), vitest, PGlite in tests.

**Spec:** `docs/superpowers/specs/2026-10-07-apps-as-document-models-design.md`

Migration Steps 2 (reads move to the document) and 3 (drop duplicated columns) get their own plans once this has soaked.

## Global Constraints

- Repo: `vetra-cloud-package`; worktree `/home/f/projects/vetra-cloud-package-licensing`; branch `feat/license-provisioning`.
- Model id `powerhouse/vetra-app`, name `VetraApp`, extension `vapp`, version 1.
- **An app document is created with the id of its existing `apps` row.** Environments' `VetraCloudAppLink.appId`, `app_deployments.app_id` and the live `app_license_grants.app_id` all resolve through it; a new id breaks production.
- Reuse `AutoUpdateChannel { DEV, STAGING, LATEST }` from `vetra-cloud-environment`. Do not invent a second channel vocabulary.
- **No reads move in this step.** Every accessor still returns table data.
- Secret material never enters the document. `harbor_robot_secret_enc` and GitHub tokens stay in tables.
- Reducer rejections do not throw from `execute()`; assert on the appended operation's `error` field.
- Codegen: `npx ph-cli generate document-model -d document-models/vetra-app/vetra-app.json`. It rewrites `document-models/index.ts`, `powerhouse.manifest.json` and may inject unused imports into hand-written test files — revert those test-file edits before committing.
- Timestamps are ISO-8601 UTC `Z`. Reducers are pure: the caller passes `publishedAt`, the reducer never calls `Date.now()`.
- Commit messages: no `Co-Authored-By` trailer.
- Verify with `npm run tsc`, `npx oxlint subgraphs document-models`, `npx vitest run`.

## Review Focus

Failure modes the spec implies that no task's main deliverable exercises. Each has a test assigned to the task that owns it.

1. **Backfill run twice** (a retried deploy) must not duplicate or clobber a document whose artifacts were since recorded. *(Task 3)*
2. **An app row with NULL optional columns** — `identity_expires_at`, `production_environment_id` and `harbor_robot_id` are nullable, and a backfill that assumes strings writes `"null"` into the document. *(Task 3)*
3. **A dual-write partial failure** — the table write succeeding and the document write failing must not fail the user's request, because reads are still on the table and the reconciler exists to catch it. *(Task 4)*
4. **An artifact version cap boundary** — the oldest version is dropped at the cap, and the channel pointer must not be left aimed at a dropped version. *(Task 2)*
5. **A DELETED app** — soft-deleted rows are kept forever; the backfill must carry the status rather than skipping the row, or an environment's `appId` resolves to nothing. *(Task 3)*

---

### Task 1: The `vetra-app` document model

**Files:**
- Create: `document-models/vetra-app/vetra-app.json`
- Create: `document-models/vetra-app/v1/schema.graphql` (written by codegen from the spec)
- Modify: `document-models/document-models.ts`, `document-models/index.ts` (codegen)
- Test: `document-models/vetra-app/v1/tests/app.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the module `document-models/vetra-app/v1` exporting `utils.createDocument()`, `reducer`, and action creators `setAppDetails`, `connectRepository`, `setIdentity`, `setStatus`, `setPreviews`, `setProductionEnvironment`; the state type `VetraAppState`.

- [ ] **Step 1: Write the model spec**

Create `document-models/vetra-app/vetra-app.json` modelled on
`document-models/app-license-type/app-license-type.json` — same top-level shape
(`id`, `name`, `author`, `extension`, `description`, `specifications[0]` with
`version`, `changeLog`, `state.global.{schema,initialValue,examples}`, `modules`).

Use `id: "powerhouse/vetra-app"`, `name: "VetraApp"`, `extension: "vapp"`.

The `state.global.schema` is the SDL from the spec's *The document model* section,
plus the operation inputs:

```graphql
input SetAppDetailsInput { name: String  slug: String  owner: EthereumAddress }
input ConnectRepositoryInput { repositoryId: String  fullName: String  productionBranch: String }
input SetIdentityInput { did: String  expiresAt: DateTime }
input SetStatusInput { status: VetraAppStatus! }
input SetPreviewsInput { enabled: Boolean!  limit: Int!  ttlDays: Int! }
input SetProductionEnvironmentInput { environmentId: OID }
```

`state.global.initialValue` is the JSON of an empty app:

```json
{"name":null,"slug":null,"owner":null,"status":"PENDING_IDENTITY","repository":null,"identity":null,"productionEnvironmentId":null,"previews":null,"artifacts":[]}
```

One module named `app` whose operations are `SET_APP_DETAILS`,
`CONNECT_REPOSITORY`, `SET_IDENTITY`, `SET_STATUS`, `SET_PREVIEWS`,
`SET_PRODUCTION_ENVIRONMENT`.

- [ ] **Step 2: Generate the model**

Run: `npx ph-cli generate document-model -d document-models/vetra-app/vetra-app.json`
Expected: `document-models/vetra-app/v1/{gen,src,tests}` created.

Then `git checkout -- document-models/app-license-type/v1/tests/` and any other
pre-existing test file codegen touched: it injects unused imports into
hand-written tests and those edits are noise.

- [ ] **Step 3: Write the failing reducer test**

Create `document-models/vetra-app/v1/tests/app.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  reducer,
  setAppDetails,
  setStatus,
  connectRepository,
  utils,
} from "document-models/vetra-app/v1";

describe("VetraApp", () => {
  it("starts PENDING_IDENTITY with no artifacts", () => {
    const doc = utils.createDocument();
    expect(doc.state.global.status).toBe("PENDING_IDENTITY");
    expect(doc.state.global.artifacts).toStrictEqual([]);
  });

  it("records details and the repository without touching the other", () => {
    let doc = reducer(
      utils.createDocument(),
      setAppDetails({ name: "dtbau", slug: "dtbau", owner: "0xabc" }),
    );
    doc = reducer(
      doc,
      connectRepository({
        repositoryId: "r1",
        fullName: "web3-berlin/dtbau-package",
        productionBranch: "main",
      }),
    );
    expect(doc.operations.global.at(-1)?.error).toBeUndefined();
    expect(doc.state.global.name).toBe("dtbau");
    expect(doc.state.global.repository?.fullName).toBe("web3-berlin/dtbau-package");
  });

  it("carries DELETED, because soft-deleted rows are kept forever", () => {
    const doc = reducer(utils.createDocument(), setStatus({ status: "DELETED" }));
    expect(doc.operations.global.at(-1)?.error).toBeUndefined();
    expect(doc.state.global.status).toBe("DELETED");
  });
});
```

- [ ] **Step 4: Run it, implement the reducers, run again**

Run: `npx vitest run document-models/vetra-app`
Expected first: FAIL. Implement the reducers in
`document-models/vetra-app/v1/src/reducers/app.ts` — each assigns only the fields
its input carries, following `app-license-type/v1/src/reducers/license-type.ts`,
which truthy-guards each field so an omitted one is left alone rather than
nulled. Re-run: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run tsc && npx vitest run document-models
git add document-models/vetra-app document-models/document-models.ts document-models/index.ts powerhouse.manifest.json
git commit -m "feat(apps): vetra-app document model

Apps become documents so environments stop referencing them by bare string into
a table, and so a licence template can reference an app's artifacts as data.
Credentials stay in tables: documents sync, secrets must not."
```

---

### Task 2: Artifact operations

**Files:**
- Modify: `document-models/vetra-app/vetra-app.json` (add the two operations)
- Modify: `document-models/vetra-app/v1/src/reducers/app.ts`
- Test: `document-models/vetra-app/v1/tests/app.test.ts` (extend)

**Interfaces:**
- Consumes: the model from Task 1.
- Produces: action creators `recordArtifactVersion({ kind, name, version, reference, commitSha, runId, publishedAt })` and `setArtifactChannel({ kind, name, channel, version })`; the per-artifact cap constant `MAX_ARTIFACT_VERSIONS = 50` exported from the reducer module.

- [ ] **Step 1: Add the operations to the spec and regenerate**

Add to the `app` module: `RECORD_ARTIFACT_VERSION`, `SET_ARTIFACT_CHANNEL`, with inputs:

```graphql
input RecordArtifactVersionInput {
  kind: VetraAppArtifactKind!
  name: String!
  version: String!
  reference: String!
  commitSha: String
  runId: String
  publishedAt: DateTime!
}
input SetArtifactChannelInput {
  kind: VetraAppArtifactKind!
  name: String!
  channel: AutoUpdateChannel!
  version: String!
}
```

Run: `npx ph-cli generate document-model -d document-models/vetra-app/vetra-app.json`

- [ ] **Step 2: Write the failing tests**

Append to `document-models/vetra-app/v1/tests/app.test.ts`:

```ts
import { recordArtifactVersion, setArtifactChannel } from "document-models/vetra-app/v1";

const v = (version: string, over: Record<string, unknown> = {}) =>
  recordArtifactVersion({
    kind: "FUSION_IMAGE",
    name: "dtbau-psb",
    version,
    reference: `cr.vetra.io/p/dtbau-psb:${version}`,
    commitSha: "abc",
    runId: "1",
    publishedAt: "2026-10-07T00:00:00.000Z",
    ...over,
  });

describe("artifacts", () => {
  it("groups versions under one artifact entry", () => {
    let doc = reducer(utils.createDocument(), v("1.0.0"));
    doc = reducer(doc, v("1.1.0"));
    expect(doc.operations.global.at(-1)?.error).toBeUndefined();
    expect(doc.state.global.artifacts).toHaveLength(1);
    expect(doc.state.global.artifacts[0]!.versions.map((x) => x.version)).toStrictEqual([
      "1.0.0",
      "1.1.0",
    ]);
  });

  it("is idempotent: re-running a job overwrites that version", () => {
    let doc = reducer(utils.createDocument(), v("1.0.0"));
    doc = reducer(doc, v("1.0.0", { commitSha: "def" }));
    const versions = doc.state.global.artifacts[0]!.versions;
    expect(versions).toHaveLength(1);
    expect(versions[0]!.commitSha).toBe("def");
  });

  it("refuses a channel pointing at a version that does not exist", () => {
    let doc = reducer(utils.createDocument(), v("1.0.0"));
    doc = reducer(
      doc,
      setArtifactChannel({ kind: "FUSION_IMAGE", name: "dtbau-psb", channel: "LATEST", version: "9.9.9" }),
    );
    // reducer rejections do not throw; they land on the operation
    expect(doc.operations.global.at(-1)?.error).toBeTruthy();
    expect(doc.state.global.artifacts[0]!.channels).toStrictEqual([]);
  });

  it("lets a channel move back to an older version on a republish", () => {
    let doc = reducer(utils.createDocument(), v("1.0.0"));
    doc = reducer(doc, v("2.0.0"));
    const point = (version: string) =>
      setArtifactChannel({ kind: "FUSION_IMAGE", name: "dtbau-psb", channel: "LATEST", version });
    doc = reducer(doc, point("2.0.0"));
    doc = reducer(doc, point("1.0.0"));
    expect(doc.state.global.artifacts[0]!.channels).toStrictEqual([
      { channel: "LATEST", version: "1.0.0" },
    ]);
  });

  // Review Focus 4: the cap must not strand a channel on a dropped version.
  it("caps versions per artifact and repoints a channel left on a dropped one", () => {
    let doc = reducer(utils.createDocument(), v("0.0.0"));
    doc = reducer(
      doc,
      setArtifactChannel({ kind: "FUSION_IMAGE", name: "dtbau-psb", channel: "LATEST", version: "0.0.0" }),
    );
    for (let i = 1; i <= 55; i++) doc = reducer(doc, v(`0.0.${i}`));

    const artifact = doc.state.global.artifacts[0]!;
    expect(artifact.versions).toHaveLength(50);
    expect(artifact.versions.some((x) => x.version === "0.0.0")).toBe(false);
    // the pointer must still name a version that exists
    const channel = artifact.channels[0];
    expect(artifact.versions.some((x) => x.version === channel!.version)).toBe(true);
  });
});
```

- [ ] **Step 3: Run to verify failure, implement, run to verify pass**

Run: `npx vitest run document-models/vetra-app`

Implement in `document-models/vetra-app/v1/src/reducers/app.ts`:

```ts
export const MAX_ARTIFACT_VERSIONS = 50;
```

`RECORD_ARTIFACT_VERSION`: find the artifact by `(kind, name)` or append a new one
with empty `versions`/`channels`; replace a matching `version` in place or push it;
if `versions.length > MAX_ARTIFACT_VERSIONS`, drop from the front, then drop any
channel whose `version` is no longer present. A document that grows without bound
eventually fails to load, and a channel aimed at a dropped version is worse than
no channel.

`SET_ARTIFACT_CHANNEL`: reject when the artifact is unknown or the version is not
among its `versions`; otherwise replace the entry for that channel or append it.

Re-run: PASS.

- [ ] **Step 4: Prove the channel guard can fail**

Delete the "version is not among its versions" rejection, re-run, and confirm
"refuses a channel pointing at a version that does not exist" FAILS. Restore it
and confirm green.

- [ ] **Step 5: Commit**

```bash
npm run tsc && npx vitest run document-models
git add document-models/vetra-app powerhouse.manifest.json
git commit -m "feat(apps): record artifact versions and channel pointers in the app document

Artifacts live inside the app document, so there is no app id for a forged
document to claim. Versions are capped per artifact and a channel is never left
pointing at a version the cap dropped."
```

---

### Task 3: Backfill one document per app row

**Files:**
- Create: `subgraphs/vetra-apps/app-document.ts`
- Test: `subgraphs/vetra-apps/__tests__/app-document.test.ts`

**Interfaces:**
- Consumes: the model from Tasks 1-2.
- Produces:
  - `appDocumentActions(row: AppRow): Action[]` — the action list that reproduces a row's facts.
  - `backfillAppDocuments(deps: AppDocDeps): Promise<{ created: number; skipped: number }>` where
    `AppDocDeps = { db: Kysely<VetraAppsDB>; docs: { create(id: string): Promise<void>; exists(id: string): Promise<boolean>; execute(id: string, actions: Action[]): Promise<unknown> }; logger: Pick<Console, "warn"> }`

- [ ] **Step 1: Write the failing tests**

Create `subgraphs/vetra-apps/__tests__/app-document.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { makeHarness, seedActiveApp, type Harness } from "./harness.js";
import { backfillAppDocuments, appDocumentActions } from "../app-document.js";

let h: Harness;
beforeEach(async () => { h = await makeHarness(); });
afterEach(async () => { await h.close(); });

const fakeDocs = (existing = new Set<string>()) => ({
  created: [] as string[],
  executed: [] as Array<{ id: string; actions: unknown[] }>,
  async create(id: string) { this.created.push(id); existing.add(id); },
  async exists(id: string) { return existing.has(id); },
  async execute(id: string, actions: unknown[]) { this.executed.push({ id, actions }); },
});

describe("backfillAppDocuments", () => {
  it("creates one document per row, using the row's own id", async () => {
    const app = await seedActiveApp(h);
    const docs = fakeDocs();

    expect(await backfillAppDocuments({ db: h.db, docs, logger: { warn: vi.fn() } }))
      .toEqual({ created: 1, skipped: 0 });
    // the id is what environments, deployments and the licensing gate resolve
    expect(docs.created).toStrictEqual([app.id]);
  });

  // Review Focus 1: a retried deploy must not clobber recorded artifacts.
  it("skips a row whose document already exists", async () => {
    const app = await seedActiveApp(h);
    const docs = fakeDocs(new Set([app.id]));

    expect(await backfillAppDocuments({ db: h.db, docs, logger: { warn: vi.fn() } }))
      .toEqual({ created: 0, skipped: 1 });
    expect(docs.executed).toStrictEqual([]);
  });

  // Review Focus 5: soft-deleted rows are kept forever and must still resolve.
  it("backfills a DELETED app rather than skipping it", async () => {
    const app = await seedActiveApp(h);
    await h.db.updateTable("apps").set({ status: "DELETED" }).where("id", "=", app.id).execute();
    const docs = fakeDocs();

    await backfillAppDocuments({ db: h.db, docs, logger: { warn: vi.fn() } });
    expect(docs.created).toStrictEqual([app.id]);
  });

  // Review Focus 2: nullable columns must stay null, not become "null".
  it("carries NULL columns through as null", async () => {
    const app = await seedActiveApp(h);
    await h.db
      .updateTable("apps")
      .set({ identity_expires_at: null, production_environment_id: "" })
      .where("id", "=", app.id)
      .execute();

    const row = await h.db.selectFrom("apps").selectAll().where("id", "=", app.id).executeTakeFirstOrThrow();
    const actions = appDocumentActions(row);
    const json = JSON.stringify(actions);
    expect(json).not.toContain('"null"');
    expect(json).not.toContain("undefined");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/app-document.test.ts`
Expected: FAIL — cannot find module `../app-document.js`.

- [ ] **Step 3: Implement**

Create `subgraphs/vetra-apps/app-document.ts`. `appDocumentActions` maps a row to
`setAppDetails`, `connectRepository`, `setIdentity`, `setStatus`, `setPreviews`,
`setProductionEnvironment`, converting `""` and `undefined` to `null` so an empty
column never becomes a string. `backfillAppDocuments` selects every row — including
`DELETED`, because environments still reference them — and for each one whose
document does not already exist, creates it with the row's id and executes the
actions. An existing document is skipped untouched: it may already carry artifacts
that the row knows nothing about.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run subgraphs/vetra-apps/__tests__/app-document.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Prove the skip can fail**

Change the `exists` check to always return false, re-run, and confirm "skips a row
whose document already exists" FAILS. Restore and confirm green. Without that
guard a retried backfill would re-run every action over a live document.

- [ ] **Step 6: Commit**

```bash
npm run tsc && npx oxlint subgraphs/vetra-apps
git add subgraphs/vetra-apps/app-document.ts subgraphs/vetra-apps/__tests__/app-document.test.ts
git commit -m "feat(apps): backfill an app document per row, keyed by the row's id

Environments' VetraCloudAppLink, app_deployments and the live app_license_grants
gate all resolve on apps.id, so the document takes it. DELETED rows are
backfilled too: they are kept forever and still referenced."
```

---

### Task 4: Dual-write

**Files:**
- Modify: `subgraphs/vetra-apps/service.ts` (every write that touches `apps`)
- Modify: `subgraphs/vetra-apps/index.ts` (wire `docs` into deps; run the backfill at startup)
- Test: `subgraphs/vetra-apps/__tests__/app-document.test.ts` (extend)

**Interfaces:**
- Consumes: `appDocumentActions`, `backfillAppDocuments` (Task 3).
- Produces: `mirrorAppToDocument(deps, appId, actions: Action[]): Promise<void>` — best-effort, never throws.

- [ ] **Step 1: Write the failing tests**

```ts
describe("dual-write", () => {
  it("mirrors an app change into the document", async () => {
    const app = await seedActiveApp(h);
    const docs = fakeDocs(new Set([app.id]));
    await mirrorAppToDocument({ db: h.db, docs, logger: { warn: vi.fn() } }, app.id, [
      setStatus({ status: "DISCONNECTED" }),
    ]);
    expect(docs.executed).toHaveLength(1);
  });

  // Review Focus 3: reads are still on the table, so a mirror failure must not
  // fail the user's request.
  it("never throws when the document write fails", async () => {
    const warn = vi.fn();
    const docs = { ...fakeDocs(new Set(["a1"])), execute: async () => { throw new Error("reactor down"); } };
    await expect(
      mirrorAppToDocument({ db: h.db, docs, logger: { warn } }, "a1", [setStatus({ status: "ACTIVE" })]),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure, implement, run to verify pass**

`mirrorAppToDocument` executes the actions against the document and catches
everything, logging a warning. It is best-effort **by design**: reads do not move
in this step, so a reactor outage must not break app creation. Task 5's reconciler
is what notices.

Then call it from every service function that writes the `apps` table — the
18 write sites found via `grep -rn 'updateTable("apps")\|insertInto("apps")'
subgraphs/` — passing the actions equivalent to the column change.

- [ ] **Step 3: Run the whole subgraph suite**

Run: `npx vitest run subgraphs/vetra-apps`
Expected: PASS. Existing tests must be untouched: no read moved, so no assertion
about app behaviour should change. If an existing test needed editing, that is a
signal the change was not additive — stop and re-read it.

- [ ] **Step 4: Commit**

```bash
npm run tsc && npx oxlint subgraphs/vetra-apps && npx vitest run subgraphs/vetra-apps
git add subgraphs/vetra-apps/service.ts subgraphs/vetra-apps/index.ts subgraphs/vetra-apps/__tests__/app-document.test.ts
git commit -m "feat(apps): dual-write app changes to the document

Writes go to both stores; reads stay on the table for this whole step, so
behaviour is unchanged and the document is proven before anything depends on it.
The mirror is best-effort and never fails a user request."
```

---

### Task 5: Drift reconciler

**Files:**
- Create: `subgraphs/vetra-apps/app-document-drift.ts`
- Modify: `subgraphs/vetra-apps/index.ts` (schedule hourly via the existing `every(...)` helper)
- Test: `subgraphs/vetra-apps/__tests__/app-document-drift.test.ts`

**Interfaces:**
- Produces: `reportAppDocumentDrift(deps): Promise<{ checked: number; drifted: string[] }>`.

- [ ] **Step 1: Write the failing tests**

```ts
it("reports an app whose document disagrees with its row", async () => {
  const app = await seedActiveApp(h);
  const docs = { getState: async () => ({ name: "WRONG", status: "ACTIVE" }) };
  const out = await reportAppDocumentDrift({ db: h.db, docs, logger: { warn: vi.fn() } });
  expect(out.drifted).toStrictEqual([app.id]);
});

it("reports no drift when they agree", async () => {
  const app = await seedActiveApp(h);
  const row = await h.db.selectFrom("apps").selectAll().where("id", "=", app.id).executeTakeFirstOrThrow();
  const docs = { getState: async () => ({ name: row.name, status: row.status }) };
  expect((await reportAppDocumentDrift({ db: h.db, docs, logger: { warn: vi.fn() } })).drifted).toStrictEqual([]);
});

it("counts a missing document as drift rather than crashing", async () => {
  await seedActiveApp(h);
  const docs = { getState: async () => null };
  const out = await reportAppDocumentDrift({ db: h.db, docs, logger: { warn: vi.fn() } });
  expect(out.drifted).toHaveLength(1);
});
```

- [ ] **Step 2: Run to verify failure, implement, run to verify pass**

Compare the fields the document owns — `name`, `slug`, `owner`, `status`,
repository and identity — and collect ids that differ. **Log, never repair.** A
reconciler that silently fixes drift hides the write bug that caused it, and this
step exists to prove the dual-write is correct.

- [ ] **Step 3: Schedule it and commit**

```bash
npm run tsc && npx oxlint subgraphs/vetra-apps && npx vitest run
git add subgraphs/vetra-apps/app-document-drift.ts subgraphs/vetra-apps/index.ts subgraphs/vetra-apps/__tests__/app-document-drift.test.ts
git commit -m "feat(apps): report drift between app rows and app documents

Logs differences without repairing them: this step exists to prove the dual-write
is correct, and silent repair would hide the write bug that caused the drift."
```

---

## Done when

- `npx vitest run` is green across the repo; `npm run tsc` and `npx oxlint` clean.
- Every existing `vetra-apps` test passes **unedited** — the proof that no read moved.
- A fresh database backfills one document per app row, with the row's id, including DELETED rows.
- An app change appears in both stores, and a reactor outage during the mirror leaves the request successful and logs a warning.
- The drift reconciler reports a seeded disagreement and stays silent when the stores agree.

Step 2 (reads move to the document, in `repo.ts` and `subgraphs/vetra-licensing/index.ts:139`) is the next plan, and must not start until this has soaked on staging.
