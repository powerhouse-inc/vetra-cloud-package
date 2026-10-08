# Renown App Profile and User Stats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `powerhouse/renown-app-profile` and `powerhouse/renown-user-stats`
document models and a `renown-stats` subgraph to renown-package. Apps report
per-user metrics as current values. Only the app's own DID may write them.
Publishers maintain their app's public profile.

**Architecture:**
- **Two document models**, each built from a spec JSON with `ph-cli generate`
  (reactor-mcp is not used in this repo).
- **One document per user DID and one per app DID.** A subgraph-owned
  relational index (`renown-stats` namespace, primary key on the DID) records
  which document belongs to which DID. The index is written synchronously when
  a document is created. An in-process keyed lock plus a first-claim-wins insert
  stop concurrent first writes from creating duplicates.
- **Authentication without host changes.** `reportUserStat` accepts two kinds of
  caller:
  - the host-resolved bearer, whose `ctx.user.appKey` is the app DID;
  - an app token in the `X-Renown-App-Token` header. It must carry the
    renown-stats audience, and it is verified in the resolver against the local
    delegation read model.

  `upsertAppProfile` uses the host-resolved wallet address. The first upsert also
  requires a delegation credential from that wallet to the app DID.
- **The Vetra relay gets its token from Renown.** A registration-token-gated
  `issueAppStatsToken` mutation in `renown-workload` signs a short-lived token
  with the app's server-held did:key. The token is valid only for the
  renown-stats audience.

**Tech Stack:** TypeScript (nodenext, strict), Powerhouse 6.2.3-dev.26 (`ph-cli`, `@powerhousedao/reactor-api` `BaseSubgraph`, `document-model`), `@renown/sdk` (`verifyAuthBearerToken`, `createAuthBearerToken`, `RenownCryptoBuilder`), Kysely + PGlite (tests), viem (`getAddress`), Vitest 4, oxlint.

**Spec:**
- `/home/f/projects/vetra-cloud-package-licensing/docs/superpowers/specs/2026-10-08-app-document-licensing-redesign-design.md`.
  Read the section "Renown: App Profile and user stats".
- `/home/f/projects/vetra-cloud-package-licensing/docs/superpowers/specs/2026-10-08-licensing-api-contract.md`.
  Read the section "Renown (renown-package)". It is **binding**: field names are
  exact.

## Global Constraints

- **Repo and branch:**
  - Work in the worktree `/home/f/projects/renown-package-stats`, branch
    `feat/app-profile-user-stats`, which is based on `origin/main`. The PR
    targets `main`.
  - Never touch `/home/f/projects/renown-package`, which holds the user's other
    work.
- **First step, once:** run `cd /home/f/projects/renown-package-stats && pnpm install`.
  The worktree has no `node_modules`.
- **Strictly additive.** Renown is production auth for everything, so no
  existing behaviour may change:
  - Do not edit existing files, with these exceptions: codegen-maintained
    barrels and the manifest (`document-models/{document-models,index,upgrade-manifests}.ts`,
    `subgraphs/index.ts`, `powerhouse.manifest.json`), and the additive parts of
    Task 7 in `subgraphs/renown-workload/`.
  - Never modify an existing test.
  - Never empty or reorder a barrel. Every diff to a barrel or the manifest must
    contain additions only.
- **Codegen:**
  - Allowed commands: `pnpm generate document-model --document <file>` and
    `pnpm generate subgraph --name renown-stats`.
  - **Never run `generate all`**: it clobbers tests and prunes the manifest.
  - Never edit anything under `gen/`.
  - Reducer code lives in `v1/src/reducers/*.ts`. Repo convention: the spec
    JSON's `reducer` fields stay `""`.
- **Document types:**
  - `powerhouse/renown-user-stats`: name `RenownUserStats`, extension `phus`.
  - `powerhouse/renown-app-profile`: name `RenownAppProfile`, extension `phap`.
- **Reducers:**
  - Pure and synchronous. Ids and timestamps come from the input.
  - Errors are named classes whose names end in `Error`.
  - Tests assert `operations.global[i].error` and never use `.toThrow()` on
    reducers.
  - Reducer coverage is at least **95 %** on lines, branches, functions and
    statements (`vitest.config.ts` enforces it with `pnpm vitest run --coverage`).
- **Subgraph `renown-stats`:**
  - Its GraphQL surface is exactly the contract's (types `UserStat` and
    `AppProfile`, three queries, two mutations).
  - Its relational namespace is `renown-stats`.
  - `onSetup` must never throw.
- **DIDs:**
  - App DIDs are `did:key:z…`.
  - User DIDs are `did:pkh:eip155:<chain>:<address>` or `did:key:z…`.
  - A user `did:pkh` is canonicalised to `did:pkh:eip155:1:<EIP-55 address>`,
    the same form as the Renown OIDC `sub`.
  - `publisherDid` is stored in that canonical form, and publishers are compared
    by lowercase address.
- **Header and audience:**
  - The app-token header is `x-renown-app-token`. Node lowercases incoming
    header names.
  - The audience defaults to `https://switchboard.renown.vetra.io/graphql/renown-stats`
    and can be overridden with the `RENOWN_STATS_AUDIENCE` env var.
- **Commits:**
  - Conventional commits with scope `stats`, e.g. `feat(stats): …`.
    semantic-release reads them.
  - **No Co-Authored-By or any AI attribution line.**
  - Stage explicit paths only. Never `git add -A` or `git add .`.
- **Before every commit:** `pnpm lint`, `pnpm tsc` and `pnpm test` pass.
- **Before the PR:** `pnpm build` passes.

## Review Focus

1. **A caller sends the app token as `Authorization: Bearer …` instead of the
   `X-Renown-App-Token` header.** The token carries an `aud`, and the host's
   bearer middleware verifies it without an audience. did-jwt then fails it, so
   the host answers HTTP 401 before any resolver runs. The plan cannot change the
   host. Instead, the header path must reject a token that has the wrong audience
   or no audience at all, so that it is never weaker than the host path.
   Pinned in Task 5 ("header token for another audience / without audience is
   FORBIDDEN").
2. **An app DID whose owner's delegation is revoked or expired.** The header
   path must refuse it, just as the host refuses a bearer whose credential is no
   longer valid. Pinned in Task 5.
3. **Two reports for a new user arrive at the same moment** (the relay bursts).
   Exactly one user-stats document must exist afterwards, and it must hold both
   metrics. Pinned in Task 5, with first-claim-wins pinned in Task 4.
4. **The same wallet arrives as different user DID strings**
   (`did:pkh:eip155:137:0xabc…` and `did:pkh:eip155:1:0xABC…`). Both must land in
   one document and read back from either spelling. Pinned in Task 5.
5. **Someone claims an app profile they don't own.** A wallet without a
   delegation to the app DID must not create the profile. A second wallet must
   not overwrite an existing profile, even if it holds a delegation. Pinned in
   Task 5.

The host keeping its other subgraphs up when the `renown-stats` namespace cannot
be created is also pinned, in Task 6.

---

### Task 1: The `powerhouse/renown-user-stats` document model

**Files:**
- Create: `specs/renown-user-stats.json`
- Generated by codegen:
  - `document-models/renown-user-stats/**`
  - additions to `document-models/{document-models,index,upgrade-manifests}.ts`
  - the manifest entry in `powerhouse.manifest.json`
- Hand-write:
  - `document-models/renown-user-stats/v1/src/utils.ts`
  - `document-models/renown-user-stats/v1/src/reducers/stats.ts`
- Test: `document-models/renown-user-stats/v1/tests/stats.test.ts`

**Interfaces:**
- Produces, from the barrel `document-models/renown-user-stats` (and `…/v1`):
  - Type and document exports: `renownUserStatsDocumentType` (`"powerhouse/renown-user-stats"`),
    `RenownUserStatsDocument`, `RenownUserStatsState`, `RenownUserStat`.
  - `actions.setUserDid({ userDid })` and
    `actions.setStat({ id, appDid, metric, value, updatedAt })`. The plain
    creators `setUserDid` and `setStat` are also exported.
  - `reducer`, `utils`.
  - Pure helpers from `v1/src/utils.ts`:
    - `isUserDid(v: string): boolean`
    - `isAppDid(v: string): boolean`
    - `isMetricName(v: string): boolean`
    - `MAX_METRICS_PER_APP = 32`
  - Error classes:
    - `InvalidUserDidError`, `UserDidImmutableError` (on SET_USER_DID)
    - `UserDidNotSetError`, `InvalidAppDidError`, `InvalidMetricError`,
      `DuplicateStatIdError`, `TooManyMetricsError` (on SET_STAT)

- [ ] **Step 1: Write the spec JSON**

`specs/renown-user-stats.json`. Its shape matches `specs/renown-oidc-client.json`:

```json
{
  "id": "powerhouse/renown-user-stats",
  "name": "RenownUserStats",
  "author": {
    "name": "Powerhouse Inc.",
    "website": "https://www.powerhouse.inc"
  },
  "extension": "phus",
  "description": "Per-app metrics reported about one Renown user: the current value of each (app, metric)",
  "specifications": [
    {
      "state": {
        "local": { "schema": "", "examples": [], "initialValue": "" },
        "global": {
          "schema": "type RenownUserStatsState {\n  userDid: String\n  stats: [RenownUserStat!]!\n}\n\ntype RenownUserStat {\n  id: OID!\n  appDid: String!\n  metric: String!\n  value: Float!\n  updatedAt: DateTime!\n}",
          "examples": [],
          "initialValue": "{\n  \"userDid\": null,\n  \"stats\": []\n}"
        }
      },
      "modules": [
        {
          "id": "f39e5c5a-1d0c-4424-b2a4-e2fc8317f897",
          "name": "stats",
          "description": "",
          "operations": [
            {
              "id": "3710c132-ce81-4d2e-b1d1-a37ce406d4c8",
              "name": "SET_USER_DID",
              "description": "Binds the document to the user it describes. Set once; repeating the same DID is a no-op.",
              "schema": "input SetUserDidInput {\n  userDid: String!\n}",
              "template": "",
              "reducer": "",
              "errors": [
                {
                  "id": "invalid-user-did-error",
                  "name": "InvalidUserDidError",
                  "code": "INVALID_USER_DID",
                  "description": "The user DID is not a did:pkh:eip155 or did:key DID",
                  "template": ""
                },
                {
                  "id": "user-did-immutable-error",
                  "name": "UserDidImmutableError",
                  "code": "USER_DID_IMMUTABLE",
                  "description": "The document already belongs to another user DID",
                  "template": ""
                }
              ],
              "examples": [],
              "scope": "global"
            },
            {
              "id": "88b27b0e-0f0d-4857-a16f-5511a33cb46b",
              "name": "SET_STAT",
              "description": "Reports the current value of one metric for one app. Upserts by (appDid, metric); a report older than the stored one is ignored.",
              "schema": "input SetStatInput {\n  id: OID!\n  appDid: String!\n  metric: String!\n  value: Float!\n  updatedAt: DateTime!\n}",
              "template": "",
              "reducer": "",
              "errors": [
                {
                  "id": "user-did-not-set-error",
                  "name": "UserDidNotSetError",
                  "code": "USER_DID_NOT_SET",
                  "description": "SET_USER_DID must run before any stat is reported",
                  "template": ""
                },
                {
                  "id": "invalid-app-did-error",
                  "name": "InvalidAppDidError",
                  "code": "INVALID_APP_DID",
                  "description": "The app DID is not a did:key DID",
                  "template": ""
                },
                {
                  "id": "invalid-metric-error",
                  "name": "InvalidMetricError",
                  "code": "INVALID_METRIC",
                  "description": "The metric name must match ^[A-Za-z][A-Za-z0-9_.:-]{0,63}$",
                  "template": ""
                },
                {
                  "id": "duplicate-stat-id-error",
                  "name": "DuplicateStatIdError",
                  "code": "DUPLICATE_STAT_ID",
                  "description": "A new stat reused the id of an existing one",
                  "template": ""
                },
                {
                  "id": "too-many-metrics-error",
                  "name": "TooManyMetricsError",
                  "code": "TOO_MANY_METRICS",
                  "description": "The app already reports the maximum number of metrics for this user",
                  "template": ""
                }
              ],
              "examples": [],
              "scope": "global"
            }
          ]
        }
      ],
      "version": 1,
      "changeLog": []
    }
  ]
}
```

- [ ] **Step 2: Generate**

Run: `cd /home/f/projects/renown-package-stats && pnpm generate document-model --document ./specs/renown-user-stats.json`

Expected:
- `document-models/renown-user-stats/` exists, with `v1/gen/stats/error.ts`
  defining the seven error classes.
- `git diff -- document-models/document-models.ts document-models/index.ts document-models/upgrade-manifests.ts powerhouse.manifest.json`
  shows **additions only**. The manifest gains
  `{"id":"powerhouse/renown-user-stats","name":"RenownUserStats"}`.

If the codegen touched any other model's files, restore them with
`git checkout -- <path>`. Note the names the codegen chose for the reducer
interface and its export in `v1/src/reducers/stats.ts`. The expected names are
`RenownUserStatsStatsOperations` and `renownUserStatsStatsOperations`. If they
differ, keep the codegen's names in Step 5.

- [ ] **Step 3: Write the failing tests**

`document-models/renown-user-stats/v1/tests/stats.test.ts`. If the codegen
created a stub with this name, replace it. Keep the generated
`document-model.test.ts`.

```ts
import { generateId } from "document-model";
import { describe, expect, it } from "vitest";
import {
  isAppDid,
  isMetricName,
  isUserDid,
  MAX_METRICS_PER_APP,
  reducer,
  setStat,
  setUserDid,
  utils,
} from "document-models/renown-user-stats/v1";

const USER = "did:pkh:eip155:1:0xAbC0000000000000000000000000000000000001";
const OTHER_USER = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const APP = "did:key:zDnaerDaTF5BXEavCrfRZEk316dpbLsfPDZ3WJ5hRTPFU2169";
const OTHER_APP = "did:key:z6MkjchhfUsD6mmvni8mCdXHw216Xrm9bQe2mBH1P5RDjVJG";
const T0 = "2026-10-08T10:00:00.000Z";
const T1 = "2026-10-08T11:00:00.000Z";
const T2 = "2026-10-08T12:00:00.000Z";

function withUser() {
  return reducer(utils.createDocument(), setUserDid({ userDid: USER }));
}

describe("RenownUserStats stats module", () => {
  it("keeps the current value per (app, metric) across a reporting flow", () => {
    const [s1, s2, s3, s4, s5, s6] = Array.from({ length: 6 }, () => generateId());
    let d = withUser();
    d = reducer(d, setUserDid({ userDid: USER })); // same DID again: no-op
    d = reducer(d, setStat({ id: s1, appDid: APP, metric: "messagesSent", value: 3, updatedAt: T0 }));
    d = reducer(d, setStat({ id: s2, appDid: APP, metric: "messagesSent", value: 5, updatedAt: T1 }));
    d = reducer(d, setStat({ id: s3, appDid: OTHER_APP, metric: "messagesSent", value: 1, updatedAt: T1 }));
    d = reducer(d, setStat({ id: s4, appDid: APP, metric: "messagesSent", value: 4, updatedAt: T0 })); // late retry: ignored
    d = reducer(d, setStat({ id: s5, appDid: APP, metric: "messagesSent", value: 5, updatedAt: T1 })); // duplicate: harmless
    d = reducer(d, setStat({ id: s6, appDid: APP, metric: "score", value: 0, updatedAt: T2 })); // falsy but valid

    expect(d.operations.global.map((op) => op.error)).toEqual(Array(8).fill(undefined));
    expect(d.state.global.userDid).toBe(USER);
    expect(d.state.global.stats).toEqual([
      { id: s1, appDid: APP, metric: "messagesSent", value: 5, updatedAt: T1 },
      { id: s3, appDid: OTHER_APP, metric: "messagesSent", value: 1, updatedAt: T1 },
      { id: s6, appDid: APP, metric: "score", value: 0, updatedAt: T2 },
    ]);
  });

  it("rejects an invalid user DID and a second, different one", () => {
    let d = reducer(utils.createDocument(), setUserDid({ userDid: "alice" }));
    expect(d.operations.global[0].error).toMatch(/user DID/i);
    expect(d.state.global.userDid).toBeNull();
    d = reducer(d, setUserDid({ userDid: USER }));
    d = reducer(d, setUserDid({ userDid: OTHER_USER }));
    expect(d.operations.global[2].error).toMatch(/belongs to/i);
    expect(d.state.global.userDid).toBe(USER);
  });

  it("rejects stats before the user DID is set", () => {
    const d = reducer(
      utils.createDocument(),
      setStat({ id: generateId(), appDid: APP, metric: "m", value: 1, updatedAt: T0 }),
    );
    expect(d.operations.global[0].error).toMatch(/user DID/i);
    expect(d.state.global.stats).toEqual([]);
  });

  it("rejects a non-did:key app DID and malformed metric names", () => {
    let d = withUser();
    d = reducer(d, setStat({ id: generateId(), appDid: USER, metric: "m", value: 1, updatedAt: T0 }));
    expect(d.operations.global[1].error).toMatch(/app DID/i);
    d = reducer(d, setStat({ id: generateId(), appDid: APP, metric: "has space", value: 1, updatedAt: T0 }));
    expect(d.operations.global[2].error).toMatch(/metric/i);
    expect(d.state.global.stats).toEqual([]);
  });

  it("rejects a new stat that reuses an existing id", () => {
    const id = generateId();
    let d = withUser();
    d = reducer(d, setStat({ id, appDid: APP, metric: "a", value: 1, updatedAt: T0 }));
    d = reducer(d, setStat({ id, appDid: APP, metric: "b", value: 2, updatedAt: T0 }));
    expect(d.operations.global[2].error).toMatch(/already used/i);
    expect(d.state.global.stats).toHaveLength(1);
  });

  it("caps the metrics per app, not per document", () => {
    let d = withUser();
    for (let i = 0; i < MAX_METRICS_PER_APP; i++) {
      d = reducer(d, setStat({ id: generateId(), appDid: APP, metric: `m${i}`, value: i, updatedAt: T0 }));
    }
    d = reducer(d, setStat({ id: generateId(), appDid: APP, metric: "oneTooMany", value: 1, updatedAt: T0 }));
    expect(d.operations.global[MAX_METRICS_PER_APP + 1].error).toMatch(/already reports/i);
    d = reducer(d, setStat({ id: generateId(), appDid: OTHER_APP, metric: "m0", value: 1, updatedAt: T0 }));
    expect(d.operations.global[MAX_METRICS_PER_APP + 2].error).toBeUndefined();
    // Updating an existing metric still works at the cap.
    d = reducer(d, setStat({ id: generateId(), appDid: APP, metric: "m0", value: 99, updatedAt: T1 }));
    expect(d.state.global.stats.find((s) => s.appDid === APP && s.metric === "m0")?.value).toBe(99);
  });
});

describe("utils", () => {
  it("isUserDid", () => {
    expect(isUserDid(USER)).toBe(true);
    expect(isUserDid(OTHER_USER)).toBe(true);
    expect(isUserDid("did:pkh:eip155:0:0xAbC0000000000000000000000000000000000001")).toBe(false);
    expect(isUserDid("did:web:example.com")).toBe(false);
  });
  it("isAppDid", () => {
    expect(isAppDid(APP)).toBe(true);
    expect(isAppDid(USER)).toBe(false);
    expect(isAppDid("did:key:zShort")).toBe(false);
  });
  it("isMetricName", () => {
    expect(isMetricName("messagesSent")).toBe(true);
    expect(isMetricName("vetra.deploys:prod-1")).toBe(true);
    expect(isMetricName("")).toBe(false);
    expect(isMetricName("1st")).toBe(false);
    expect(isMetricName("a".repeat(65))).toBe(false);
  });
});
```

- [ ] **Step 4: Run and confirm failure**

Run: `pnpm vitest run document-models/renown-user-stats`
Expected: FAIL. The utils don't exist yet, and the reducer stubs throw.

- [ ] **Step 5: Implement utils and reducers**

`document-models/renown-user-stats/v1/src/utils.ts`:

```ts
/** Most metrics one app may keep for one user; bounds document state. */
export const MAX_METRICS_PER_APP = 32;

const DID_PKH = /^did:pkh:eip155:[1-9][0-9]{0,19}:0x[0-9a-fA-F]{40}$/;
const DID_KEY = /^did:key:z[1-9A-HJ-NP-Za-km-z]{32,128}$/;
const METRIC = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;

/** A Renown user: a wallet (`did:pkh:eip155`) or a key (`did:key`). */
export function isUserDid(value: string): boolean {
  return DID_PKH.test(value) || DID_KEY.test(value);
}

/** An app identity: always a `did:key` (Vetra App identities are did:key). */
export function isAppDid(value: string): boolean {
  return DID_KEY.test(value);
}

export function isMetricName(value: string): boolean {
  return METRIC.test(value);
}
```

`document-models/renown-user-stats/v1/src/reducers/stats.ts`. Replace the stub
bodies and keep the generated export name:

```ts
import type { RenownUserStatsStatsOperations } from "document-models/renown-user-stats/v1";
import {
  DuplicateStatIdError,
  InvalidAppDidError,
  InvalidMetricError,
  InvalidUserDidError,
  TooManyMetricsError,
  UserDidImmutableError,
  UserDidNotSetError,
} from "../../gen/stats/error.js";
import { isAppDid, isMetricName, isUserDid, MAX_METRICS_PER_APP } from "../utils.js";

export const renownUserStatsStatsOperations: RenownUserStatsStatsOperations = {
  setUserDidOperation(state, action) {
    const { userDid } = action.input;
    if (!isUserDid(userDid)) {
      throw new InvalidUserDidError(`Invalid user DID: ${userDid}`);
    }
    if (state.userDid && state.userDid !== userDid) {
      throw new UserDidImmutableError(`This document belongs to ${state.userDid}`);
    }
    state.userDid = userDid;
  },
  setStatOperation(state, action) {
    const { id, appDid, metric, value, updatedAt } = action.input;
    if (!state.userDid) {
      throw new UserDidNotSetError("Set the user DID before reporting stats");
    }
    if (!isAppDid(appDid)) {
      throw new InvalidAppDidError(`Invalid app DID: ${appDid}`);
    }
    if (!isMetricName(metric)) {
      throw new InvalidMetricError(`Invalid metric name: ${metric}`);
    }
    const existing = state.stats.find((s) => s.appDid === appDid && s.metric === metric);
    if (existing) {
      // Current-value semantics: an older report is a late retry, not news.
      if (Date.parse(updatedAt) < Date.parse(existing.updatedAt)) return;
      existing.value = value;
      existing.updatedAt = updatedAt;
      return;
    }
    if (state.stats.some((s) => s.id === id)) {
      throw new DuplicateStatIdError(`Stat id ${id} is already used`);
    }
    if (state.stats.filter((s) => s.appDid === appDid).length >= MAX_METRICS_PER_APP) {
      throw new TooManyMetricsError(`App ${appDid} already reports ${MAX_METRICS_PER_APP} metrics`);
    }
    state.stats.push({ id, appDid, metric, value, updatedAt });
  },
};
```

- [ ] **Step 6: Run tests and coverage**

Run: `pnpm vitest run document-models/renown-user-stats && pnpm vitest run --coverage`
Expected: PASS. `document-models/renown-user-stats/v1/src/reducers/stats.ts` is
at 100 % on all four metrics, and the global thresholds still hold.

- [ ] **Step 7: Lint, typecheck, commit**

```bash
pnpm lint && pnpm tsc && pnpm test
git status --short   # stage every new file under document-models/renown-user-stats by path
git add specs/renown-user-stats.json document-models/renown-user-stats document-models/document-models.ts document-models/index.ts document-models/upgrade-manifests.ts powerhouse.manifest.json
git commit -m "feat(stats): powerhouse/renown-user-stats document model"
```

---

### Task 2: The `powerhouse/renown-app-profile` document model

**Files:**
- Create: `specs/renown-app-profile.json`
- Generated by codegen:
  - `document-models/renown-app-profile/**`
  - additions to the three `document-models/*.ts` barrels and to the manifest
- Hand-write:
  - `document-models/renown-app-profile/v1/src/utils.ts`
  - `document-models/renown-app-profile/v1/src/reducers/profile.ts`
- Test: `document-models/renown-app-profile/v1/tests/profile.test.ts`

**Interfaces:**
- Produces, from the barrel `document-models/renown-app-profile` (and `…/v1`):
  - Type and document exports: `renownAppProfileDocumentType` (`"powerhouse/renown-app-profile"`),
    `RenownAppProfileDocument`, `RenownAppProfileState`.
  - Actions and creators: `actions.setAppDid({ appDid })`,
    `actions.setPublisherDid({ publisherDid })` and
    `actions.setProfile({ name?, tagline?, logo?, website? })`. Each profile
    field is `string | null | undefined`: null or absent leaves the field
    unchanged, and `""` clears it.
  - `reducer`, `utils`.
  - Pure helpers from `v1/src/utils.ts`: `isAppDid`, `isPublisherDid`,
    `isWebsite`, `isLogo` (all `(v: string) => boolean`).
  - Errors:
    - `InvalidAppDidError`, `AppDidImmutableError` (on SET_APP_DID)
    - `InvalidPublisherDidError` (on SET_PUBLISHER_DID)
    - `AppDidNotSetError`, `InvalidWebsiteError`, `InvalidLogoError` (on SET_PROFILE)

- [ ] **Step 1: Write the spec JSON**

`specs/renown-app-profile.json`:

```json
{
  "id": "powerhouse/renown-app-profile",
  "name": "RenownAppProfile",
  "author": {
    "name": "Powerhouse Inc.",
    "website": "https://www.powerhouse.inc"
  },
  "extension": "phap",
  "description": "The public profile of an app identity (did:key) and the publisher who maintains it",
  "specifications": [
    {
      "state": {
        "local": { "schema": "", "examples": [], "initialValue": "" },
        "global": {
          "schema": "type RenownAppProfileState {\n  appDid: String\n  publisherDid: String\n  name: String\n  tagline: String\n  logo: String\n  website: String\n}",
          "examples": [],
          "initialValue": "{\n  \"appDid\": null,\n  \"publisherDid\": null,\n  \"name\": null,\n  \"tagline\": null,\n  \"logo\": null,\n  \"website\": null\n}"
        }
      },
      "modules": [
        {
          "id": "5bf298c2-359f-43b0-8c89-fd9efd187f24",
          "name": "profile",
          "description": "",
          "operations": [
            {
              "id": "dcc8a7ed-fff5-4215-97b0-ae3302e7dcf9",
              "name": "SET_APP_DID",
              "description": "Binds the profile to its app DID. Set once; repeating the same DID is a no-op.",
              "schema": "input SetAppDidInput {\n  appDid: String!\n}",
              "template": "",
              "reducer": "",
              "errors": [
                {
                  "id": "invalid-app-did-error",
                  "name": "InvalidAppDidError",
                  "code": "INVALID_APP_DID",
                  "description": "The app DID is not a did:key DID",
                  "template": ""
                },
                {
                  "id": "app-did-immutable-error",
                  "name": "AppDidImmutableError",
                  "code": "APP_DID_IMMUTABLE",
                  "description": "The profile already belongs to another app DID",
                  "template": ""
                }
              ],
              "examples": [],
              "scope": "global"
            },
            {
              "id": "f3dff6ec-0ee2-4928-af7c-0251ff759275",
              "name": "SET_PUBLISHER_DID",
              "description": "Records the publisher (a did:pkh:eip155 wallet DID) who maintains the profile.",
              "schema": "input SetPublisherDidInput {\n  publisherDid: String!\n}",
              "template": "",
              "reducer": "",
              "errors": [
                {
                  "id": "invalid-publisher-did-error",
                  "name": "InvalidPublisherDidError",
                  "code": "INVALID_PUBLISHER_DID",
                  "description": "The publisher DID is not a did:pkh:eip155 DID",
                  "template": ""
                }
              ],
              "examples": [],
              "scope": "global"
            },
            {
              "id": "baca5b92-7ce1-45dc-a483-4dab2575a7b2",
              "name": "SET_PROFILE",
              "description": "Patches the public fields. A null or absent field is unchanged; an empty string clears it.",
              "schema": "input SetProfileInput {\n  name: String\n  tagline: String\n  logo: String\n  website: String\n}",
              "template": "",
              "reducer": "",
              "errors": [
                {
                  "id": "app-did-not-set-error",
                  "name": "AppDidNotSetError",
                  "code": "APP_DID_NOT_SET",
                  "description": "SET_APP_DID must run before the profile is edited",
                  "template": ""
                },
                {
                  "id": "invalid-website-error",
                  "name": "InvalidWebsiteError",
                  "code": "INVALID_WEBSITE",
                  "description": "The website is not an http(s) URL",
                  "template": ""
                },
                {
                  "id": "invalid-logo-error",
                  "name": "InvalidLogoError",
                  "code": "INVALID_LOGO",
                  "description": "The logo is neither an https URL nor a base64 image data URL",
                  "template": ""
                }
              ],
              "examples": [],
              "scope": "global"
            }
          ]
        }
      ],
      "version": 1,
      "changeLog": []
    }
  ]
}
```

- [ ] **Step 2: Generate**

Run: `pnpm generate document-model --document ./specs/renown-app-profile.json`

Expected:
- `document-models/renown-app-profile/` exists.
- The barrel and manifest diffs are additions only. The manifest gains
  `{"id":"powerhouse/renown-app-profile","name":"RenownAppProfile"}`, and the
  Task 1 entry is still there.

Restore anything else the codegen touched. Note the generated reducer names. The
expected names are `RenownAppProfileProfileOperations` and
`renownAppProfileProfileOperations`.

- [ ] **Step 3: Write the failing tests**

`document-models/renown-app-profile/v1/tests/profile.test.ts`. If the codegen
created a stub with this name, replace it:

```ts
import { describe, expect, it } from "vitest";
import {
  isAppDid,
  isLogo,
  isPublisherDid,
  isWebsite,
  reducer,
  setAppDid,
  setProfile,
  setPublisherDid,
  utils,
} from "document-models/renown-app-profile/v1";

const APP = "did:key:zDnaerDaTF5BXEavCrfRZEk316dpbLsfPDZ3WJ5hRTPFU2169";
const OTHER_APP = "did:key:z6MkjchhfUsD6mmvni8mCdXHw216Xrm9bQe2mBH1P5RDjVJG";
const PUBLISHER = "did:pkh:eip155:1:0xAbC0000000000000000000000000000000000001";
const LOGO = "data:image/png;base64,iVBORw0KGgo=";

describe("RenownAppProfile profile module", () => {
  it("builds a profile end to end, patching and clearing fields", () => {
    let d = utils.createDocument();
    d = reducer(d, setAppDid({ appDid: APP }));
    d = reducer(d, setAppDid({ appDid: APP })); // same DID again: no-op
    d = reducer(d, setPublisherDid({ publisherDid: PUBLISHER }));
    d = reducer(d, setProfile({ name: " Speckle ", tagline: "3D data", logo: LOGO, website: "https://speckle.systems" }));
    d = reducer(d, setProfile({ tagline: "", logo: null })); // clear tagline, keep logo
    d = reducer(d, setProfile({ name: "Speckle Pro" }));
    d = reducer(d, setProfile({ logo: "https://cdn.example/logo.png", website: "http://localhost:3000" }));

    expect(d.operations.global.map((op) => op.error)).toEqual(Array(7).fill(undefined));
    expect(d.state.global).toEqual({
      appDid: APP,
      publisherDid: PUBLISHER,
      name: "Speckle Pro",
      tagline: null,
      logo: "https://cdn.example/logo.png",
      website: "http://localhost:3000",
    });
  });

  it("rejects a non-did:key app DID and a second, different one", () => {
    let d = reducer(utils.createDocument(), setAppDid({ appDid: PUBLISHER }));
    expect(d.operations.global[0].error).toMatch(/app DID/i);
    d = reducer(d, setAppDid({ appDid: APP }));
    d = reducer(d, setAppDid({ appDid: OTHER_APP }));
    expect(d.operations.global[2].error).toMatch(/belongs to/i);
    expect(d.state.global.appDid).toBe(APP);
  });

  it("rejects a publisher that is not a wallet DID", () => {
    const d = reducer(utils.createDocument(), setPublisherDid({ publisherDid: APP }));
    expect(d.operations.global[0].error).toMatch(/publisher/i);
    expect(d.state.global.publisherDid).toBeNull();
  });

  it("rejects profile edits before the app DID is set", () => {
    const d = reducer(utils.createDocument(), setProfile({ name: "x" }));
    expect(d.operations.global[0].error).toMatch(/app DID/i);
    expect(d.state.global.name).toBeNull();
  });

  it("rejects unsafe websites and logos without changing anything", () => {
    let d = reducer(utils.createDocument(), setAppDid({ appDid: APP }));
    d = reducer(d, setProfile({ name: "kept?", website: "javascript:alert(1)" }));
    expect(d.operations.global[1].error).toMatch(/website/i);
    d = reducer(d, setProfile({ logo: "http://insecure.example/logo.png" }));
    expect(d.operations.global[2].error).toMatch(/logo/i);
    d = reducer(d, setProfile({ logo: "data:text/html;base64,PGgxPg==" }));
    expect(d.operations.global[3].error).toMatch(/logo/i);
    expect(d.state.global).toMatchObject({ name: null, website: null, logo: null });
  });
});

describe("utils", () => {
  it("isAppDid / isPublisherDid", () => {
    expect(isAppDid(APP)).toBe(true);
    expect(isAppDid(PUBLISHER)).toBe(false);
    expect(isPublisherDid(PUBLISHER)).toBe(true);
    expect(isPublisherDid(APP)).toBe(false);
  });
  it("isWebsite", () => {
    expect(isWebsite("https://a.b/c")).toBe(true);
    expect(isWebsite("http://a.b")).toBe(true);
    expect(isWebsite("ftp://a.b")).toBe(false);
    expect(isWebsite("not a url")).toBe(false);
  });
  it("isLogo", () => {
    expect(isLogo(LOGO)).toBe(true);
    expect(isLogo("data:image/svg+xml;base64,PHN2Zz4=")).toBe(true);
    expect(isLogo("https://cdn.example/l.png")).toBe(true);
    expect(isLogo("http://cdn.example/l.png")).toBe(false);
    expect(isLogo("nope")).toBe(false);
  });
});
```

- [ ] **Step 4: Run and confirm failure**

Run: `pnpm vitest run document-models/renown-app-profile`
Expected: FAIL. The utils are missing, and the reducer stubs throw.

- [ ] **Step 5: Implement utils and reducers**

`document-models/renown-app-profile/v1/src/utils.ts`:

```ts
const DID_PKH = /^did:pkh:eip155:[1-9][0-9]{0,19}:0x[0-9a-fA-F]{40}$/;
const DID_KEY = /^did:key:z[1-9A-HJ-NP-Za-km-z]{32,128}$/;
const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/;

function protocolOf(value: string): string | null {
  try {
    return new URL(value).protocol;
  } catch {
    return null;
  }
}

export function isAppDid(value: string): boolean {
  return DID_KEY.test(value);
}

export function isPublisherDid(value: string): boolean {
  return DID_PKH.test(value);
}

export function isWebsite(value: string): boolean {
  const protocol = protocolOf(value);
  return protocol === "https:" || protocol === "http:";
}

export function isLogo(value: string): boolean {
  return DATA_IMAGE.test(value) || protocolOf(value) === "https:";
}
```

`document-models/renown-app-profile/v1/src/reducers/profile.ts`:

```ts
import type { RenownAppProfileProfileOperations } from "document-models/renown-app-profile/v1";
import {
  AppDidImmutableError,
  AppDidNotSetError,
  InvalidAppDidError,
  InvalidLogoError,
  InvalidPublisherDidError,
  InvalidWebsiteError,
} from "../../gen/profile/error.js";
import { isAppDid, isLogo, isPublisherDid, isWebsite } from "../utils.js";

/** undefined = leave unchanged, null = clear, string = set (trimmed). */
function patchValue(value: string | null | undefined): string | null | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export const renownAppProfileProfileOperations: RenownAppProfileProfileOperations = {
  setAppDidOperation(state, action) {
    const { appDid } = action.input;
    if (!isAppDid(appDid)) {
      throw new InvalidAppDidError(`Invalid app DID: ${appDid}`);
    }
    if (state.appDid && state.appDid !== appDid) {
      throw new AppDidImmutableError(`This profile belongs to ${state.appDid}`);
    }
    state.appDid = appDid;
  },
  setPublisherDidOperation(state, action) {
    const { publisherDid } = action.input;
    if (!isPublisherDid(publisherDid)) {
      throw new InvalidPublisherDidError(`Invalid publisher DID: ${publisherDid}`);
    }
    state.publisherDid = publisherDid;
  },
  setProfileOperation(state, action) {
    if (!state.appDid) {
      throw new AppDidNotSetError("Set the app DID before editing the profile");
    }
    const name = patchValue(action.input.name);
    const tagline = patchValue(action.input.tagline);
    const logo = patchValue(action.input.logo);
    const website = patchValue(action.input.website);
    if (website && !isWebsite(website)) {
      throw new InvalidWebsiteError(`Invalid website: ${website}`);
    }
    if (logo && !isLogo(logo)) {
      throw new InvalidLogoError("The logo must be an https URL or a base64 image data URL");
    }
    if (name !== undefined) state.name = name;
    if (tagline !== undefined) state.tagline = tagline;
    if (logo !== undefined) state.logo = logo;
    if (website !== undefined) state.website = website;
  },
};
```

- [ ] **Step 6: Run tests and coverage**

Run: `pnpm vitest run document-models/renown-app-profile && pnpm vitest run --coverage`
Expected: PASS. `profile.ts` is at 100 % on all four metrics.

- [ ] **Step 7: Lint, typecheck, commit**

```bash
pnpm lint && pnpm tsc && pnpm test
git add specs/renown-app-profile.json document-models/renown-app-profile document-models/document-models.ts document-models/index.ts document-models/upgrade-manifests.ts powerhouse.manifest.json
git commit -m "feat(stats): powerhouse/renown-app-profile document model"
```

---

### Task 3: `renown-stats` core helpers (DIDs, audience, keyed lock)

**Files:**
- Create: `subgraphs/renown-stats/core/dids.ts`
- Create: `subgraphs/renown-stats/core/config.ts`
- Create: `subgraphs/renown-stats/core/keyed-lock.ts`
- Test: `subgraphs/renown-stats/tests/core.test.ts`

**Interfaces:**
- Produces:
  - `pkhDidFor(address: string): string`: returns
    `did:pkh:eip155:1:<EIP-55 address>`.
  - `canonicalUserDid(did: string): string | null`: canonicalises a `did:pkh`
    to chain 1 and EIP-55. A `did:key` is returned unchanged. Anything else
    gives `null`.
  - `canonicalAppDid(did: string): string | null`: returns a trimmed `did:key`,
    else `null`.
  - `addressOf(didOrAddress: string): string | null`: the lowercase address of
    a `did:pkh:eip155` DID or a bare `0x` address, else `null`.
  - `DEFAULT_STATS_AUDIENCE = "https://switchboard.renown.vetra.io/graphql/renown-stats"`.
  - `statsAudience(env: Record<string, string | undefined>): string`.
  - `createKeyedLock(): <T>(key: string, fn: () => Promise<T>) => Promise<T>`.
    Calls with the same key run one after another. Calls with different keys
    run concurrently.

- [ ] **Step 1: Write the failing tests**

`subgraphs/renown-stats/tests/core.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_STATS_AUDIENCE, statsAudience } from "../core/config.js";
import { addressOf, canonicalAppDid, canonicalUserDid, pkhDidFor } from "../core/dids.js";
import { createKeyedLock } from "../core/keyed-lock.js";

const LOWER = "0xabc0000000000000000000000000000000000001";
const CHECKSUMMED = "0xABC0000000000000000000000000000000000001";
const KEY_DID = "did:key:zDnaerDaTF5BXEavCrfRZEk316dpbLsfPDZ3WJ5hRTPFU2169";

describe("dids", () => {
  it("pkhDidFor uses chain 1 and the EIP-55 address", () => {
    expect(pkhDidFor(LOWER)).toBe(`did:pkh:eip155:1:${CHECKSUMMED}`);
  });

  it("canonicalUserDid folds chains and case into one DID", () => {
    expect(canonicalUserDid(`did:pkh:eip155:137:${LOWER}`)).toBe(`did:pkh:eip155:1:${CHECKSUMMED}`);
    expect(canonicalUserDid(` did:pkh:eip155:1:${LOWER.toUpperCase().replace("0X", "0x")} `)).toBe(
      `did:pkh:eip155:1:${CHECKSUMMED}`,
    );
    expect(canonicalUserDid(KEY_DID)).toBe(KEY_DID);
    expect(canonicalUserDid("did:web:example.com")).toBeNull();
    expect(canonicalUserDid(LOWER)).toBeNull();
  });

  it("canonicalAppDid accepts only did:key", () => {
    expect(canonicalAppDid(` ${KEY_DID} `)).toBe(KEY_DID);
    expect(canonicalAppDid(`did:pkh:eip155:1:${LOWER}`)).toBeNull();
  });

  it("addressOf reads did:pkh DIDs and bare addresses", () => {
    expect(addressOf(`did:pkh:eip155:10:${CHECKSUMMED}`)).toBe(LOWER);
    expect(addressOf(CHECKSUMMED)).toBe(LOWER);
    expect(addressOf(KEY_DID)).toBeNull();
  });
});

describe("statsAudience", () => {
  it("defaults, and trims trailing slashes from an override", () => {
    expect(statsAudience({})).toBe(DEFAULT_STATS_AUDIENCE);
    expect(statsAudience({ RENOWN_STATS_AUDIENCE: "  " })).toBe(DEFAULT_STATS_AUDIENCE);
    expect(statsAudience({ RENOWN_STATS_AUDIENCE: "https://sb.example/graphql/renown-stats/" })).toBe(
      "https://sb.example/graphql/renown-stats",
    );
  });
});

describe("createKeyedLock", () => {
  it("serialises one key, keeps going after a failure, and doesn't block other keys", async () => {
    const lock = createKeyedLock();
    const log: string[] = [];
    const step = (name: string, ms: number) => () =>
      new Promise<string>((resolve) =>
        setTimeout(() => {
          log.push(name);
          resolve(name);
        }, ms),
      );
    const failing = lock("a", () => Promise.reject(new Error("boom")));
    const results = await Promise.all([
      lock("a", step("a1", 20)),
      lock("a", step("a2", 0)),
      lock("b", step("b1", 5)),
      failing.catch((e: Error) => e.message),
    ]);
    expect(results).toEqual(["a1", "a2", "b1", "boom"]);
    expect(log.indexOf("a1")).toBeLessThan(log.indexOf("a2"));
    expect(log.indexOf("b1")).toBeLessThan(log.indexOf("a1"));
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm vitest run subgraphs/renown-stats/tests/core.test.ts`
Expected: FAIL. The modules cannot be resolved.

- [ ] **Step 3: Implement**

`subgraphs/renown-stats/core/dids.ts`:

```ts
import { getAddress } from "viem";

const DID_PKH = /^did:pkh:eip155:([1-9][0-9]{0,19}):(0x[0-9a-fA-F]{40})$/;
const DID_KEY = /^did:key:z[1-9A-HJ-NP-Za-km-z]{32,128}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** One DID per wallet, whatever chain it signed on: the Renown OIDC `sub` form. */
export function pkhDidFor(address: string): string {
  return `did:pkh:eip155:1:${getAddress(address.toLowerCase())}`;
}

/** A user DID in canonical form (did:pkh → chain 1 + EIP-55; did:key unchanged), or null. */
export function canonicalUserDid(did: string): string | null {
  const value = did.trim();
  const pkh = DID_PKH.exec(value);
  if (pkh) return pkhDidFor(pkh[2]);
  return DID_KEY.test(value) ? value : null;
}

/** An app DID (did:key), trimmed, or null. */
export function canonicalAppDid(did: string): string | null {
  const value = did.trim();
  return DID_KEY.test(value) ? value : null;
}

/** The lowercase address behind a did:pkh:eip155 DID or a bare address, or null. */
export function addressOf(didOrAddress: string): string | null {
  const value = didOrAddress.trim();
  if (ADDRESS.test(value)) return value.toLowerCase();
  const pkh = DID_PKH.exec(value);
  return pkh ? pkh[2].toLowerCase() : null;
}
```

`subgraphs/renown-stats/core/config.ts`:

```ts
/**
 * The `aud` an app token must carry for `reportUserStat` via the
 * `X-Renown-App-Token` header. Also what renown-workload's
 * `issueAppStatsToken` mints for, so both sides read the same env.
 */
export const DEFAULT_STATS_AUDIENCE = "https://switchboard.renown.vetra.io/graphql/renown-stats";

export function statsAudience(env: Record<string, string | undefined>): string {
  const raw = env.RENOWN_STATS_AUDIENCE?.trim();
  return raw ? raw.replace(/\/+$/, "") : DEFAULT_STATS_AUDIENCE;
}
```

`subgraphs/renown-stats/core/keyed-lock.ts`:

```ts
/**
 * In-process mutual exclusion per key: same-key calls run one after another
 * (a failure doesn't block the next), different keys run concurrently. Idle
 * keys are dropped so the map doesn't grow.
 */
export function createKeyedLock(): <T>(key: string, fn: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<void>>();
  return async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve();
    const result = previous.then(fn);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, tail);
    try {
      return await result;
    } finally {
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}
```

(`previous` never rejects, because every stored tail swallows its errors, so
`previous.then(fn)` always runs `fn`.)

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run subgraphs/renown-stats/tests/core.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
pnpm lint && pnpm tsc && pnpm test
git add subgraphs/renown-stats/core subgraphs/renown-stats/tests/core.test.ts
git commit -m "feat(stats): DID canonicalisation, stats audience and keyed lock"
```

---

### Task 4: The DID → document index (`renown-stats` relational namespace)

**Files:**
- Create: `subgraphs/renown-stats/store/types.ts`
- Create: `subgraphs/renown-stats/store/migrations.ts`
- Create: `subgraphs/renown-stats/store/kysely.ts`
- Test: `subgraphs/renown-stats/tests/store.test.ts`

**Interfaces:**
- Produces:
  - `migrate(db: Kysely<any>): Promise<void>`: idempotent.
  - `StatsKysely`: `Kysely<StatsDB>`.
  - `AppProfileEntry`: `{ appDid: string; documentId: string; publisherAddress: string }`.
    `publisherAddress` is lowercase.
  - `StatsIndex`, implemented by `class KyselyStatsIndex(db: StatsKysely)`:
    - `userStatsDocument(userDid: string): Promise<string | undefined>`
    - `claimUserStatsDocument(userDid: string, documentId: string, now: Date): Promise<string>`:
      the first claim wins. It returns the recorded document id.
    - `appProfile(appDid: string): Promise<AppProfileEntry | undefined>`
    - `claimAppProfile(entry: AppProfileEntry, now: Date): Promise<AppProfileEntry>`:
      the first claim wins. It returns the recorded entry.
    - `appProfilesByPublisher(publisherAddress: string): Promise<AppProfileEntry[]>`:
      oldest first.

**Why a table and not a read-model processor:** renown-user profiles are found
through the asynchronous `renown-user` processor. Duplicates can appear there,
and `findNewestProfileDoc` has to choose among them. Stats reports for a new user
arrive in bursts, and a processor would not have indexed the first document
before the second report looked it up. A primary key on the DID, written at
creation time, makes "one document per DID" a database guarantee.

- [ ] **Step 1: Write the failing tests**

`subgraphs/renown-stats/tests/store.test.ts`:

```ts
import { PGlite } from "@electric-sql/pglite";
import { Kysely, sql } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { afterAll, describe, expect, it } from "vitest";
import { KyselyStatsIndex } from "../store/kysely.js";
import { migrate } from "../store/migrations.js";
import type { StatsDB } from "../store/types.js";

const opened: Kysely<StatsDB>[] = [];
afterAll(async () => {
  await Promise.all(opened.map((db) => db.destroy()));
});

/** A fresh PGlite scoped like `relationalDb.createNamespace("renown-stats")`, migrated twice. */
async function makeIndex(): Promise<KyselyStatsIndex> {
  const root = new Kysely<StatsDB>({ dialect: new PGliteDialect(new PGlite()) });
  opened.push(root);
  await sql`create schema "renown-stats"`.execute(root);
  const db = root.withSchema("renown-stats");
  await migrate(db);
  await migrate(db);
  return new KyselyStatsIndex(db);
}

const NOW = new Date("2026-10-08T10:00:00Z");
const LATER = new Date("2026-10-08T11:00:00Z");
const ALICE = "0xabc0000000000000000000000000000000000001";
const BOB = "0xb0b0000000000000000000000000000000000002";

describe("KyselyStatsIndex", () => {
  it("records one user-stats document per user DID: first claim wins", async () => {
    const index = await makeIndex();
    expect(await index.userStatsDocument("did:x")).toBeUndefined();
    expect(await index.claimUserStatsDocument("did:x", "doc-1", NOW)).toBe("doc-1");
    expect(await index.claimUserStatsDocument("did:x", "doc-2", NOW)).toBe("doc-1");
    expect(await index.userStatsDocument("did:x")).toBe("doc-1");
  });

  it("records one app profile per app DID: first claim wins, publisher included", async () => {
    const index = await makeIndex();
    expect(await index.appProfile("did:app")).toBeUndefined();
    const first = { appDid: "did:app", documentId: "p-1", publisherAddress: ALICE };
    expect(await index.claimAppProfile(first, NOW)).toEqual(first);
    expect(await index.claimAppProfile({ appDid: "did:app", documentId: "p-2", publisherAddress: BOB }, NOW)).toEqual(
      first,
    );
    expect(await index.appProfile("did:app")).toEqual(first);
  });

  it("lists a publisher's profiles oldest first and nobody else's", async () => {
    const index = await makeIndex();
    await index.claimAppProfile({ appDid: "did:b", documentId: "p-b", publisherAddress: ALICE }, LATER);
    await index.claimAppProfile({ appDid: "did:a", documentId: "p-a", publisherAddress: ALICE }, NOW);
    await index.claimAppProfile({ appDid: "did:c", documentId: "p-c", publisherAddress: BOB }, NOW);
    expect((await index.appProfilesByPublisher(ALICE)).map((e) => e.appDid)).toEqual(["did:a", "did:b"]);
    expect(await index.appProfilesByPublisher("0x0000000000000000000000000000000000000000")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm vitest run subgraphs/renown-stats/tests/store.test.ts`
Expected: FAIL. The modules are missing.

- [ ] **Step 3: Implement**

`subgraphs/renown-stats/store/types.ts`:

```ts
import type { Kysely } from "kysely";

/** A `timestamptz` column: the driver returns a `Date`, but accepts either on write. */
export type Timestamp = Date | string;

export interface UserStatsDocumentRow {
  user_did: string;
  document_id: string;
  created_at: Timestamp;
}

export interface AppProfileDocumentRow {
  app_did: string;
  document_id: string;
  /** Lowercase wallet address of the publisher. */
  publisher_address: string;
  created_at: Timestamp;
}

export interface StatsDB {
  user_stats_documents: UserStatsDocumentRow;
  app_profile_documents: AppProfileDocumentRow;
}

export type StatsKysely = Kysely<StatsDB>;

export interface AppProfileEntry {
  appDid: string;
  documentId: string;
  publisherAddress: string;
}

/** Which document holds each user's stats and each app's profile. */
export interface StatsIndex {
  userStatsDocument(userDid: string): Promise<string | undefined>;
  /** Records `documentId` for `userDid` unless one is recorded; returns the recorded id. */
  claimUserStatsDocument(userDid: string, documentId: string, now: Date): Promise<string>;
  appProfile(appDid: string): Promise<AppProfileEntry | undefined>;
  /** Records `entry` unless the app DID is recorded; returns the recorded entry. */
  claimAppProfile(entry: AppProfileEntry, now: Date): Promise<AppProfileEntry>;
  appProfilesByPublisher(publisherAddress: string): Promise<AppProfileEntry[]>;
}
```

`subgraphs/renown-stats/store/migrations.ts`:

```ts
import type { Kysely } from "kysely";

/** Creates the index tables. Idempotent. */
export async function migrate(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("user_stats_documents")
    .ifNotExists()
    .addColumn("user_did", "text", (col) => col.primaryKey())
    .addColumn("document_id", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) => col.notNull())
    .execute();
  await db.schema
    .createTable("app_profile_documents")
    .ifNotExists()
    .addColumn("app_did", "text", (col) => col.primaryKey())
    .addColumn("document_id", "text", (col) => col.notNull())
    .addColumn("publisher_address", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) => col.notNull())
    .execute();
  await db.schema
    .createIndex("app_profile_documents_publisher_address")
    .ifNotExists()
    .on("app_profile_documents")
    .column("publisher_address")
    .execute();
}
```

`subgraphs/renown-stats/store/kysely.ts`:

```ts
import type { AppProfileEntry, StatsIndex, StatsKysely } from "./types.js";

/** Kysely-backed `StatsIndex`. The `db` passed in is already namespace-scoped. */
export class KyselyStatsIndex implements StatsIndex {
  constructor(private readonly db: StatsKysely) {}

  async userStatsDocument(userDid: string): Promise<string | undefined> {
    const row = await this.db
      .selectFrom("user_stats_documents")
      .select("document_id")
      .where("user_did", "=", userDid)
      .executeTakeFirst();
    return row?.document_id;
  }

  async claimUserStatsDocument(userDid: string, documentId: string, now: Date): Promise<string> {
    await this.db
      .insertInto("user_stats_documents")
      .values({ user_did: userDid, document_id: documentId, created_at: now })
      .onConflict((oc) => oc.column("user_did").doNothing())
      .execute();
    const recorded = await this.userStatsDocument(userDid);
    if (recorded === undefined) throw new Error(`user_stats_documents lost the row for ${userDid}`);
    return recorded;
  }

  async appProfile(appDid: string): Promise<AppProfileEntry | undefined> {
    const row = await this.db
      .selectFrom("app_profile_documents")
      .select(["app_did", "document_id", "publisher_address"])
      .where("app_did", "=", appDid)
      .executeTakeFirst();
    return row && { appDid: row.app_did, documentId: row.document_id, publisherAddress: row.publisher_address };
  }

  async claimAppProfile(entry: AppProfileEntry, now: Date): Promise<AppProfileEntry> {
    await this.db
      .insertInto("app_profile_documents")
      .values({
        app_did: entry.appDid,
        document_id: entry.documentId,
        publisher_address: entry.publisherAddress,
        created_at: now,
      })
      .onConflict((oc) => oc.column("app_did").doNothing())
      .execute();
    const recorded = await this.appProfile(entry.appDid);
    if (recorded === undefined) throw new Error(`app_profile_documents lost the row for ${entry.appDid}`);
    return recorded;
  }

  async appProfilesByPublisher(publisherAddress: string): Promise<AppProfileEntry[]> {
    const rows = await this.db
      .selectFrom("app_profile_documents")
      .select(["app_did", "document_id", "publisher_address"])
      .where("publisher_address", "=", publisherAddress)
      .orderBy("created_at", "asc")
      .orderBy("app_did", "asc")
      .execute();
    return rows.map((row) => ({
      appDid: row.app_did,
      documentId: row.document_id,
      publisherAddress: row.publisher_address,
    }));
  }
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run subgraphs/renown-stats/tests/store.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
pnpm lint && pnpm tsc && pnpm test
git add subgraphs/renown-stats/store subgraphs/renown-stats/tests/store.test.ts
git commit -m "feat(stats): DID-to-document index in the renown-stats namespace"
```

---

### Task 5: The `renown-stats` schema, resolvers and authorisation

**Files:**
- Create: `subgraphs/renown-stats/schema.ts`
- Create: `subgraphs/renown-stats/lookups.ts`
- Create: `subgraphs/renown-stats/resolvers.ts`
- Test: `subgraphs/renown-stats/tests/resolvers.test.ts`

**Interfaces:**
- Consumes:
  - Task 1: `actions.setUserDid`, `actions.setStat`, `isMetricName`,
    `renownUserStatsDocumentType`, `RenownUserStatsDocument`.
  - Task 2: `actions.setAppDid`, `actions.setPublisherDid`, `actions.setProfile`,
    `isWebsite`, `isLogo`, `renownAppProfileDocumentType`,
    `RenownAppProfileDocument`.
  - Task 3: `canonicalUserDid`, `canonicalAppDid`, `addressOf`, `pkhDidFor`,
    `createKeyedLock`.
  - Task 4: `StatsIndex`, `AppProfileEntry`.
  - Existing code:
    - `createRateLimiter` (`subgraphs/renown-auth/core/rate-limit.ts`)
    - `ReadModelDb` (`subgraphs/renown-auth/lookups.ts`)
    - `RenownCredentialProcessor`
- Produces:
  - `schema: DocumentNode`, exactly the contract's.
  - `APP_TOKEN_HEADER = "x-renown-app-token"`.
  - `hasDelegation(db: ReadModelDb, address: string, appDid: string, now: Date): Promise<boolean>`.
  - `StatsResolverDeps`:
    ```ts
    {
      reactorClient: Pick<IReactorClient, "createEmpty" | "execute" | "get">;
      relationalDb: ReadModelDb;
      index(): StatsIndex | undefined;
      audience(): string;
      now?: () => Date;
      reportRateLimiter?: RateLimiter;
      profileRateLimiter?: RateLimiter;
    }
    ```
  - `createResolvers(deps: StatsResolverDeps): Record<string, unknown>`.
    Resolver keys:
    - `Query.userStats`, `Query.appProfile`, `Query.appProfilesByPublisher`
    - `Mutation.reportUserStat`, `Mutation.upsertAppProfile`

**Authorisation rules:**
- **`reportUserStat`:** the caller's app DID must equal the canonical `appDid`.
  The caller's app DID comes from one of two places:
  1. **The `x-renown-app-token` header**, when present. It is verified with
     `verifyAuthBearerToken(token, { audience })`. Its `aud` must contain the
     stats audience. The issuer is the app DID, and the
     `credentialSubject.address` must hold an unrevoked, unexpired delegation
     credential to that DID in the local `renown-credential` read model. When
     the header is present but invalid, the call is FORBIDDEN, with no fallback
     to path 2.
  2. **Otherwise, the host-resolved bearer's `ctx.user.appKey`.** The host has
     already verified the signature and the delegation, because the renown
     tenant runs with `RESOLVE_CALLER_IDENTITY=true` and `RENOWN_SOURCE=self`.
- **`upsertAppProfile`:** the caller is `ctx.user.address`, the host-resolved
  wallet.
  - The first upsert of an app DID additionally needs `hasDelegation(caller,
    appDid)`. That proves the caller is the identity's owner and stops squatting.
    The first upsert sets `publisherDid = pkhDidFor(caller)`.
  - Later upserts require the caller to be the recorded publisher.
- **Queries are public**, like the rest of the Renown read surface.
- **Error codes:** FORBIDDEN, BAD_USER_INPUT, RATE_LIMITED, and
  SERVICE_NOT_CONFIGURED when the index is unavailable. A FORBIDDEN error never
  says which check failed.

- [ ] **Step 1: Write the failing tests**

`subgraphs/renown-stats/tests/resolvers.test.ts`:

```ts
import { PGlite } from "@electric-sql/pglite";
import type { IRelationalDb } from "@powerhousedao/reactor-browser";
import {
  createAuthBearerToken,
  DEFAULT_RENOWN_NETWORK_ID,
  MemoryKeyStorage,
  RenownCryptoBuilder,
} from "@renown/sdk";
import { generateId, type Action, type PHDocument } from "document-model";
import { GraphQLError } from "graphql";
import { Kysely, sql } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  reducer as profileReducer,
  renownAppProfileDocumentType,
  utils as profileUtils,
} from "../../../document-models/renown-app-profile/index.js";
import {
  reducer as statsReducer,
  renownUserStatsDocumentType,
  utils as statsUtils,
} from "../../../document-models/renown-user-stats/index.js";
import { RenownCredentialProcessor } from "../../../processors/renown-credential/index.js";
import { up as upCredential } from "../../../processors/renown-credential/migrations.js";
import type { DB as CredentialDB } from "../../../processors/renown-credential/schema.js";
import { createRateLimiter } from "../../renown-auth/core/rate-limit.js";
import { pkhDidFor } from "../core/dids.js";
import { APP_TOKEN_HEADER, createResolvers, type StatsResolverDeps } from "../resolvers.js";
import { KyselyStatsIndex } from "../store/kysely.js";
import { migrate } from "../store/migrations.js";
import type { StatsDB } from "../store/types.js";

const AUDIENCE = "https://switchboard.renown.vetra.io/graphql/renown-stats";
const OWNER = "0xabc0000000000000000000000000000000000001";
const MALLORY = "0xbad0000000000000000000000000000000000666";
const USER = `did:pkh:eip155:1:${"0x1111111111111111111111111111111111111111"}`;
const NOW = new Date("2026-10-08T10:00:00.000Z");
const CRED_NS = RenownCredentialProcessor.getNamespace("renown-credential");

let root: Kysely<CredentialDB & StatsDB>;

beforeAll(async () => {
  root = new Kysely<CredentialDB & StatsDB>({ dialect: new PGliteDialect(new PGlite()) });
  await sql`create schema ${sql.id(CRED_NS)}`.execute(root);
  await upCredential(root.withSchema(CRED_NS) as never);
  await sql`create schema "renown-stats"`.execute(root);
  await migrate(root.withSchema("renown-stats"));
});

afterAll(async () => {
  await root.destroy();
});

beforeEach(async () => {
  await root.withSchema(CRED_NS).deleteFrom("renown_credential").execute();
  await root.withSchema("renown-stats").deleteFrom("user_stats_documents").execute();
  await root.withSchema("renown-stats").deleteFrom("app_profile_documents").execute();
});

const relationalDb = {
  queryNamespace: (namespace: string) => root.withSchema(namespace),
} as unknown as IRelationalDb<unknown>;

/** A delegation credential row from `address` to `appDid`, as the renown-credential processor writes it. */
async function insertDelegation(
  address: string,
  appDid: string,
  options: { revoked?: boolean; expiresAt?: Date | null } = {},
): Promise<void> {
  await root
    .withSchema(CRED_NS)
    .insertInto("renown_credential")
    .values({
      document_id: generateId(),
      context: "[]",
      credential_id: generateId(),
      type: "[]",
      issuer_id: `did:pkh:eip155:1:${address}`,
      issuer_ethereum_address: address,
      issuance_date: NOW,
      expiration_date: options.expiresAt === undefined ? new Date("2027-10-08T00:00:00Z") : options.expiresAt,
      credential_subject_id: appDid,
      credential_subject_app: "test-app",
      credential_status_id: null,
      credential_status_type: null,
      credential_schema_id: "schema",
      credential_schema_type: "type",
      proof_verification_method: "method",
      proof_ethereum_address: address,
      proof_created: NOW,
      proof_purpose: "assertionMethod",
      proof_type: "EthereumEip712Signature2021",
      proof_value: "0x",
      proof_eip712_domain: "{}",
      proof_eip712_primary_type: "VerifiableCredential",
      revoked: options.revoked ?? false,
      revoked_at: null,
      revocation_reason: null,
    })
    .execute();
}

/** An app identity with its own did:key, acting for `owner`. */
async function makeApp(owner = OWNER) {
  const renownCrypto = await new RenownCryptoBuilder()
    .withKeyPairStorage(new MemoryKeyStorage())
    .withChainId(1)
    .build();
  return {
    did: renownCrypto.did,
    token: (options: { aud?: string; expiresIn?: number } = { aud: AUDIENCE, expiresIn: 600 }) =>
      createAuthBearerToken(1, DEFAULT_RENOWN_NETWORK_ID, owner, renownCrypto.issuer, options),
  };
}

/** A reactor client over the real reducers, in memory. */
function fakeReactor() {
  const docs = new Map<string, PHDocument>();
  const reducers: Record<string, (doc: PHDocument, action: Action) => PHDocument> = {
    [renownUserStatsDocumentType]: statsReducer as never,
    [renownAppProfileDocumentType]: profileReducer as never,
  };
  const creators: Record<string, () => PHDocument> = {
    [renownUserStatsDocumentType]: () => statsUtils.createDocument() as never,
    [renownAppProfileDocumentType]: () => profileUtils.createDocument() as never,
  };
  const createEmpty = vi.fn((documentType: string) => {
    const doc = creators[documentType]();
    docs.set(doc.header.id, doc);
    return Promise.resolve(doc);
  });
  const execute = vi.fn((id: string, _branch: string, actions: Action[]) => {
    let doc = docs.get(id);
    if (!doc) return Promise.reject(new Error(`no document ${id}`));
    for (const action of actions) doc = reducers[doc.header.documentType](doc, action);
    docs.set(id, doc);
    return Promise.resolve(doc);
  });
  const get = vi.fn((id: string) => {
    const doc = docs.get(id);
    return doc ? Promise.resolve(doc) : Promise.reject(new Error(`no document ${id}`));
  });
  const ofType = (type: string) => [...docs.values()].filter((d) => d.header.documentType === type);
  return { createEmpty, execute, get, ofType };
}

type Ctx = { user?: { address?: string; appKey?: string }; headers?: Record<string, string> };
type Resolver = (parent: unknown, args: Record<string, unknown>, ctx: Ctx) => Promise<unknown>;

function setup(options: { reportLimit?: number; withIndex?: boolean } = {}) {
  const reactor = fakeReactor();
  const index = new KyselyStatsIndex(root.withSchema("renown-stats"));
  const resolvers = createResolvers({
    reactorClient: reactor as unknown as StatsResolverDeps["reactorClient"],
    relationalDb,
    index: () => (options.withIndex === false ? undefined : index),
    audience: () => AUDIENCE,
    now: () => NOW,
    ...(options.reportLimit !== undefined
      ? { reportRateLimiter: createRateLimiter(options.reportLimit, 60_000) }
      : {}),
  }) as { Query: Record<string, Resolver>; Mutation: Record<string, Resolver> };
  return {
    reactor,
    report: (args: Record<string, unknown>, ctx: Ctx) => resolvers.Mutation.reportUserStat(null, args, ctx),
    upsert: (args: Record<string, unknown>, ctx: Ctx) => resolvers.Mutation.upsertAppProfile(null, args, ctx),
    userStats: (userDid: string) => resolvers.Query.userStats(null, { userDid }, {}),
    appProfile: (appDid: string) => resolvers.Query.appProfile(null, { appDid }, {}),
    byPublisher: (publisherDid: string) => resolvers.Query.appProfilesByPublisher(null, { publisherDid }, {}),
  };
}

async function code(promise: Promise<unknown>): Promise<unknown> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(GraphQLError);
  return (error as GraphQLError).extensions.code;
}

const hostBearer = (appKey: string, address = OWNER): Ctx => ({ user: { address, appKey } });
const appHeader = async (token: Promise<string>): Promise<Ctx> => ({ headers: { [APP_TOKEN_HEADER]: await token } });
const wallet = (address: string): Ctx => ({ user: { address } });

describe("reportUserStat", () => {
  it("accepts a host-resolved bearer issued by the app DID and reads the stat back", async () => {
    const app = await makeApp();
    const { report, userStats } = setup();
    expect(await report({ appDid: app.did, userDid: USER, metric: "messagesSent", value: 3 }, hostBearer(app.did))).toBe(
      true,
    );
    expect(await userStats(USER)).toEqual([
      { appDid: app.did, metric: "messagesSent", value: 3, updatedAt: NOW.toISOString() },
    ]);
  });

  it("accepts an app token in X-Renown-App-Token when the owner delegated to the app", async () => {
    const app = await makeApp();
    await insertDelegation(OWNER, app.did);
    const { report, userStats } = setup();
    expect(await report({ appDid: app.did, userDid: USER, metric: "m", value: 1 }, await appHeader(app.token()))).toBe(
      true,
    );
    expect(await userStats(USER)).toHaveLength(1);
  });

  it.each([
    ["no delegation", (_did: string) => Promise.resolve()],
    ["a revoked delegation", (did: string) => insertDelegation(OWNER, did, { revoked: true })],
    ["an expired delegation", (did: string) => insertDelegation(OWNER, did, { expiresAt: new Date("2026-01-01T00:00:00Z") })],
  ])("refuses an app token with %s", async (_label, delegate) => {
    const app = await makeApp();
    await delegate(app.did);
    const { report, reactor } = setup();
    expect(await code(report({ appDid: app.did, userDid: USER, metric: "m", value: 1 }, await appHeader(app.token())))).toBe(
      "FORBIDDEN",
    );
    expect(reactor.ofType(renownUserStatsDocumentType)).toHaveLength(0);
  });

  it("refuses a header token for another audience or without an audience", async () => {
    const app = await makeApp();
    await insertDelegation(OWNER, app.did);
    const { report } = setup();
    const args = { appDid: app.did, userDid: USER, metric: "m", value: 1 };
    expect(await code(report(args, await appHeader(app.token({ aud: "https://registry.vetra.io", expiresIn: 600 }))))).toBe(
      "FORBIDDEN",
    );
    expect(await code(report(args, await appHeader(app.token({ expiresIn: 600 }))))).toBe("FORBIDDEN");
    expect(await code(report(args, { headers: { [APP_TOKEN_HEADER]: "not-a-jwt" } }))).toBe("FORBIDDEN");
  });

  it("refuses anyone but the app: anonymous, another app, a user's own session key", async () => {
    const app = await makeApp();
    const other = await makeApp();
    const { report } = setup();
    const args = { appDid: app.did, userDid: USER, metric: "m", value: 1 };
    expect(await code(report(args, {}))).toBe("FORBIDDEN");
    expect(await code(report(args, hostBearer(other.did)))).toBe("FORBIDDEN");
    expect(await code(report(args, wallet(OWNER)))).toBe("FORBIDDEN");
  });

  it("keeps current values: duplicates are harmless, a new value replaces the old", async () => {
    const app = await makeApp();
    const { report, userStats, reactor } = setup();
    const ctx = hostBearer(app.did);
    await report({ appDid: app.did, userDid: USER, metric: "m", value: 5 }, ctx);
    await report({ appDid: app.did, userDid: USER, metric: "m", value: 5 }, ctx);
    await report({ appDid: app.did, userDid: USER, metric: "m", value: 7 }, ctx);
    expect(await userStats(USER)).toEqual([{ appDid: app.did, metric: "m", value: 7, updatedAt: NOW.toISOString() }]);
    expect(reactor.ofType(renownUserStatsDocumentType)).toHaveLength(1);
  });

  it("folds did:pkh spellings of one wallet into one document", async () => {
    const app = await makeApp();
    const { report, userStats, reactor } = setup();
    const address = "0x1111111111111111111111111111111111111111";
    await report({ appDid: app.did, userDid: `did:pkh:eip155:137:${address}`, metric: "a", value: 1 }, hostBearer(app.did));
    await report({ appDid: app.did, userDid: `did:pkh:eip155:1:${address}`, metric: "b", value: 2 }, hostBearer(app.did));
    expect(reactor.ofType(renownUserStatsDocumentType)).toHaveLength(1);
    expect(await userStats(`did:pkh:eip155:10:${address}`)).toHaveLength(2);
  });

  it("creates exactly one document when first reports race", async () => {
    const app = await makeApp();
    const { report, userStats, reactor } = setup();
    const ctx = hostBearer(app.did);
    await Promise.all([
      report({ appDid: app.did, userDid: USER, metric: "a", value: 1 }, ctx),
      report({ appDid: app.did, userDid: USER, metric: "b", value: 2 }, ctx),
      report({ appDid: app.did, userDid: USER, metric: "c", value: 3 }, ctx),
    ]);
    expect(reactor.ofType(renownUserStatsDocumentType)).toHaveLength(1);
    expect(await userStats(USER)).toHaveLength(3);
  });

  it("rejects malformed input with BAD_USER_INPUT", async () => {
    const app = await makeApp();
    const { report } = setup();
    const ctx = hostBearer(app.did);
    expect(await code(report({ appDid: "did:web:x", userDid: USER, metric: "m", value: 1 }, ctx))).toBe("BAD_USER_INPUT");
    expect(await code(report({ appDid: app.did, userDid: "alice", metric: "m", value: 1 }, ctx))).toBe("BAD_USER_INPUT");
    expect(await code(report({ appDid: app.did, userDid: USER, metric: "no spaces", value: 1 }, ctx))).toBe(
      "BAD_USER_INPUT",
    );
    expect(await code(report({ appDid: app.did, userDid: USER, metric: "m", value: Number.POSITIVE_INFINITY }, ctx))).toBe(
      "BAD_USER_INPUT",
    );
  });

  it("rate-limits per app DID", async () => {
    const app = await makeApp();
    const { report } = setup({ reportLimit: 1 });
    await report({ appDid: app.did, userDid: USER, metric: "m", value: 1 }, hostBearer(app.did));
    expect(await code(report({ appDid: app.did, userDid: USER, metric: "m", value: 2 }, hostBearer(app.did)))).toBe(
      "RATE_LIMITED",
    );
  });

  it("answers SERVICE_NOT_CONFIGURED without its index", async () => {
    const app = await makeApp();
    const { report, userStats } = setup({ withIndex: false });
    expect(await code(report({ appDid: app.did, userDid: USER, metric: "m", value: 1 }, hostBearer(app.did)))).toBe(
      "SERVICE_NOT_CONFIGURED",
    );
    expect(await code(userStats(USER))).toBe("SERVICE_NOT_CONFIGURED");
  });

  it("returns [] for a user nobody reported on", async () => {
    expect(await setup().userStats(USER)).toEqual([]);
  });
});

describe("upsertAppProfile", () => {
  it("lets the delegating owner create the profile and become its publisher", async () => {
    const app = await makeApp();
    await insertDelegation(OWNER, app.did);
    const { upsert, appProfile, byPublisher } = setup();
    const fields = { name: "Speckle", tagline: "3D data", logo: "https://cdn.example/l.png", website: "https://speckle.systems" };
    expect(await upsert({ appDid: app.did, ...fields }, wallet(OWNER))).toBe(true);
    const expected = { appDid: app.did, publisherDid: pkhDidFor(OWNER), ...fields };
    expect(await appProfile(app.did)).toEqual(expected);
    expect(await byPublisher(`did:pkh:eip155:137:${OWNER}`)).toEqual([expected]);
    expect(await byPublisher(OWNER.toUpperCase().replace("0X", "0x"))).toEqual([expected]);
  });

  it("lets the publisher patch and clear fields later", async () => {
    const app = await makeApp();
    await insertDelegation(OWNER, app.did);
    const { upsert, appProfile } = setup();
    await upsert({ appDid: app.did, name: "Speckle", tagline: "3D" }, wallet(OWNER));
    await upsert({ appDid: app.did, tagline: "", website: "https://speckle.systems" }, wallet(OWNER));
    expect(await appProfile(app.did)).toMatchObject({ name: "Speckle", tagline: null, website: "https://speckle.systems" });
  });

  it("refuses anonymous callers and a first upsert without a delegation", async () => {
    const app = await makeApp();
    const { upsert, reactor } = setup();
    expect(await code(upsert({ appDid: app.did, name: "x" }, {}))).toBe("FORBIDDEN");
    expect(await code(upsert({ appDid: app.did, name: "squat" }, wallet(MALLORY)))).toBe("FORBIDDEN");
    expect(reactor.ofType(renownAppProfileDocumentType)).toHaveLength(0);
  });

  it("refuses anyone but the publisher once the profile exists, even with a delegation", async () => {
    const app = await makeApp();
    await insertDelegation(OWNER, app.did);
    await insertDelegation(MALLORY, app.did);
    const { upsert, appProfile } = setup();
    await upsert({ appDid: app.did, name: "Speckle" }, wallet(OWNER));
    expect(await code(upsert({ appDid: app.did, name: "Hijacked" }, wallet(MALLORY)))).toBe("FORBIDDEN");
    expect(await appProfile(app.did)).toMatchObject({ name: "Speckle", publisherDid: pkhDidFor(OWNER) });
  });

  it("rejects bad input before creating anything", async () => {
    const app = await makeApp();
    await insertDelegation(OWNER, app.did);
    const { upsert, reactor } = setup();
    expect(await code(upsert({ appDid: app.did, website: "javascript:alert(1)" }, wallet(OWNER)))).toBe("BAD_USER_INPUT");
    expect(await code(upsert({ appDid: app.did, logo: "http://x/l.png" }, wallet(OWNER)))).toBe("BAD_USER_INPUT");
    expect(await code(upsert({ appDid: app.did, name: "x".repeat(121) }, wallet(OWNER)))).toBe("BAD_USER_INPUT");
    expect(await code(upsert({ appDid: "did:web:x", name: "x" }, wallet(OWNER)))).toBe("BAD_USER_INPUT");
    expect(reactor.ofType(renownAppProfileDocumentType)).toHaveLength(0);
  });

  it("returns null for an unknown app and rejects a non-wallet publisher query", async () => {
    const app = await makeApp();
    const { appProfile, byPublisher } = setup();
    expect(await appProfile(app.did)).toBeNull();
    expect(await code(byPublisher(app.did))).toBe("BAD_USER_INPUT");
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm vitest run subgraphs/renown-stats/tests/resolvers.test.ts`
Expected: FAIL. `../resolvers.js` cannot be resolved.

- [ ] **Step 3: Implement the schema**

`subgraphs/renown-stats/schema.ts`, verbatim from the contract:

```ts
import type { DocumentNode } from "graphql";
import { gql } from "graphql-tag";

export const schema: DocumentNode = gql`
  type UserStat {
    appDid: String!
    metric: String!
    value: Float!
    updatedAt: String!
  }

  type AppProfile {
    appDid: String!
    name: String
    tagline: String
    logo: String
    website: String
    publisherDid: String
  }

  type Query {
    userStats(userDid: String!): [UserStat!]!
    appProfile(appDid: String!): AppProfile
    appProfilesByPublisher(publisherDid: String!): [AppProfile!]!
  }

  type Mutation {
    "Caller must authenticate as appDid (bearer whose issuer/subject is the app DID)."
    reportUserStat(appDid: String!, userDid: String!, metric: String!, value: Float!): Boolean!
    "Caller must be the publisherDid."
    upsertAppProfile(appDid: String!, name: String, tagline: String, logo: String, website: String): Boolean!
  }
`;
```

- [ ] **Step 4: Implement the delegation lookup**

`subgraphs/renown-stats/lookups.ts`:

```ts
import { RenownCredentialProcessor } from "../../processors/renown-credential/index.js";
import type { DB as RenownCredentialDB } from "../../processors/renown-credential/schema.js";
import type { ReadModelDb } from "../renown-auth/lookups.js";

/**
 * True when `address` holds an unrevoked, unexpired Renown credential
 * delegating to `appDid`: the same fact the host checks before it accepts a
 * bearer issued by `appDid` for `address`.
 */
export async function hasDelegation(
  db: ReadModelDb,
  address: string,
  appDid: string,
  now: Date,
): Promise<boolean> {
  const row = await RenownCredentialProcessor.query<RenownCredentialDB>("renown-credential", db)
    .selectFrom("renown_credential")
    .select("document_id")
    .where((eb) => eb(eb.fn("LOWER", ["issuer_ethereum_address"]), "=", address.toLowerCase()))
    .where("credential_subject_id", "=", appDid)
    .where("revoked", "=", false)
    .where((eb) => eb.or([eb("expiration_date", "is", null), eb("expiration_date", ">", now)]))
    .executeTakeFirst();
  return row !== undefined;
}
```

- [ ] **Step 5: Implement the resolvers**

`subgraphs/renown-stats/resolvers.ts`:

```ts
import type { IReactorClient } from "@powerhousedao/reactor";
import { verifyAuthBearerToken } from "@renown/sdk";
import { generateId, type Action, type PHDocument } from "document-model";
import { GraphQLError } from "graphql";
import {
  actions as profileActions,
  isLogo,
  isWebsite,
  renownAppProfileDocumentType,
  type RenownAppProfileDocument,
} from "../../document-models/renown-app-profile/index.js";
import {
  actions as statsActions,
  isMetricName,
  renownUserStatsDocumentType,
  type RenownUserStatsDocument,
} from "../../document-models/renown-user-stats/index.js";
import { createRateLimiter } from "../renown-auth/core/rate-limit.js";
import type { ReadModelDb } from "../renown-auth/lookups.js";
import { addressOf, canonicalAppDid, canonicalUserDid, pkhDidFor } from "./core/dids.js";
import { createKeyedLock } from "./core/keyed-lock.js";
import { hasDelegation } from "./lookups.js";
import type { AppProfileEntry, StatsIndex } from "./store/types.js";

/** Carries an app token whose `aud` is the stats audience (the host would 401 it as a bearer). */
export const APP_TOKEN_HEADER = "x-renown-app-token";

const REPORT_LIMIT = 600; // per app DID per minute
const PROFILE_LIMIT = 30; // per wallet per minute
const WINDOW_MS = 60_000;
const MAX_LENGTH = { name: 120, tagline: 280, website: 2048, logo: 524_288 } as const;

type RateLimiter = { take(key: string, now?: number): boolean };

interface ResolverContext {
  /** Set by the host when it resolved a bearer: the wallet, and the DID that signed the bearer. */
  user?: { address?: string; appKey?: string };
  headers?: Record<string, string | string[] | undefined>;
}

export interface StatsResolverDeps {
  reactorClient: Pick<IReactorClient, "createEmpty" | "execute" | "get">;
  relationalDb: ReadModelDb;
  /** Undefined until set up, or when the relational namespace is unavailable. */
  index(): StatsIndex | undefined;
  audience(): string;
  now?: () => Date;
  reportRateLimiter?: RateLimiter;
  profileRateLimiter?: RateLimiter;
}

interface ReportUserStatArgs {
  appDid: string;
  userDid: string;
  metric: string;
  value: number;
}

interface ProfileFields {
  name?: string | null;
  tagline?: string | null;
  logo?: string | null;
  website?: string | null;
}

interface UpsertAppProfileArgs extends ProfileFields {
  appDid: string;
}

interface UserStatOutput {
  appDid: string;
  metric: string;
  value: number;
  updatedAt: string;
}

interface AppProfileOutput {
  appDid: string;
  name: string | null;
  tagline: string | null;
  logo: string | null;
  website: string | null;
  publisherDid: string | null;
}

const forbidden = () => new GraphQLError("Forbidden", { extensions: { code: "FORBIDDEN" } });
const invalidRequest = (message: string) => new GraphQLError(message, { extensions: { code: "BAD_USER_INPUT" } });
const rateLimited = () => new GraphQLError("Rate limited", { extensions: { code: "RATE_LIMITED" } });
const notConfigured = () =>
  new GraphQLError("renown-stats is not available", { extensions: { code: "SERVICE_NOT_CONFIGURED" } });

/** Rejects oversized or unsafe profile fields before anything is written ("" means clear). */
function assertProfileFields(fields: ProfileFields): void {
  for (const key of ["name", "tagline", "website", "logo"] as const) {
    const value = fields[key];
    if (value != null && value.length > MAX_LENGTH[key]) {
      throw invalidRequest(`${key} exceeds ${MAX_LENGTH[key]} characters`);
    }
  }
  const website = fields.website?.trim();
  if (website && !isWebsite(website)) throw invalidRequest("website must be an http(s) URL");
  const logo = fields.logo?.trim();
  if (logo && !isLogo(logo)) throw invalidRequest("logo must be an https URL or a base64 image data URL");
}

export function createResolvers(deps: StatsResolverDeps): Record<string, unknown> {
  const { reactorClient, relationalDb } = deps;
  const now = deps.now ?? (() => new Date());
  const reportRateLimiter = deps.reportRateLimiter ?? createRateLimiter(REPORT_LIMIT, WINDOW_MS);
  const profileRateLimiter = deps.profileRateLimiter ?? createRateLimiter(PROFILE_LIMIT, WINDOW_MS);
  const lock = createKeyedLock();

  function requireIndex(): StatsIndex {
    const index = deps.index();
    if (!index) throw notConfigured();
    return index;
  }

  /** Applies `actions`; a rejected operation becomes BAD_USER_INPUT with the reducer's message. */
  async function execute(documentId: string, actions: Action[]): Promise<void> {
    const document: PHDocument = await reactorClient.execute(documentId, "main", actions);
    const sent = new Set(actions.map((action) => action.id));
    const failed = Object.values(document.operations)
      .flat()
      .find((operation) => operation.error && sent.has(operation.action.id));
    if (failed?.error) throw invalidRequest(`${failed.action.type} failed: ${failed.error}`);
  }

  /** The app DID a header app token proves, or undefined. */
  async function appTokenIssuer(token: string): Promise<string | undefined> {
    const audience = deps.audience();
    const verified = await verifyAuthBearerToken(token, { audience });
    if (!verified) return undefined;
    // did-jwt only checks `aud` when the token has one; we require it.
    const aud = verified.payload.aud;
    if (!(Array.isArray(aud) ? aud.includes(audience) : aud === audience)) return undefined;
    const { address } = verified.verifiableCredential.credentialSubject;
    if (!(await hasDelegation(relationalDb, address, verified.issuer, now()))) return undefined;
    return verified.issuer;
  }

  /** The app DID the caller proves: the header token if sent (no fallback), else the host bearer's signer. */
  async function callerAppDid(ctx: ResolverContext): Promise<string | undefined> {
    const header = ctx.headers?.[APP_TOKEN_HEADER];
    if (typeof header === "string" && header.trim() !== "") {
      return appTokenIssuer(header.trim().replace(/^Bearer\s+/i, ""));
    }
    return ctx.user?.appKey;
  }

  /** The user's stats document, created (and bound to the user) on first use. */
  async function userStatsDocument(index: StatsIndex, userDid: string): Promise<string> {
    const existing = await index.userStatsDocument(userDid);
    if (existing) return existing;
    const created = (await reactorClient.createEmpty(renownUserStatsDocumentType)).header.id;
    // Bind before claiming: a claimed document always has its user DID.
    await execute(created, [statsActions.setUserDid({ userDid })]);
    return index.claimUserStatsDocument(userDid, created, now());
  }

  async function profileOutput(entry: AppProfileEntry): Promise<AppProfileOutput> {
    const doc = await reactorClient.get<RenownAppProfileDocument>(entry.documentId);
    const { name, tagline, logo, website, publisherDid } = doc.state.global;
    return { appDid: entry.appDid, name, tagline, logo, website, publisherDid };
  }

  return {
    Query: {
      userStats: async (_: unknown, args: { userDid: string }): Promise<UserStatOutput[]> => {
        const userDid = canonicalUserDid(args.userDid);
        if (userDid === null) throw invalidRequest("userDid must be a did:pkh:eip155 or did:key DID");
        const documentId = await requireIndex().userStatsDocument(userDid);
        if (!documentId) return [];
        const doc = await reactorClient.get<RenownUserStatsDocument>(documentId);
        return doc.state.global.stats.map(({ appDid, metric, value, updatedAt }) => ({
          appDid,
          metric,
          value,
          updatedAt,
        }));
      },

      appProfile: async (_: unknown, args: { appDid: string }): Promise<AppProfileOutput | null> => {
        const appDid = canonicalAppDid(args.appDid);
        if (appDid === null) throw invalidRequest("appDid must be a did:key DID");
        const entry = await requireIndex().appProfile(appDid);
        return entry ? profileOutput(entry) : null;
      },

      appProfilesByPublisher: async (_: unknown, args: { publisherDid: string }): Promise<AppProfileOutput[]> => {
        const address = addressOf(args.publisherDid);
        if (address === null) throw invalidRequest("publisherDid must be a did:pkh:eip155 DID or an address");
        const entries = await requireIndex().appProfilesByPublisher(address);
        return Promise.all(entries.map(profileOutput));
      },
    },

    Mutation: {
      reportUserStat: async (_: unknown, args: ReportUserStatArgs, ctx: ResolverContext): Promise<boolean> => {
        const appDid = canonicalAppDid(args.appDid);
        if (appDid === null) throw invalidRequest("appDid must be a did:key DID");
        if ((await callerAppDid(ctx)) !== appDid) throw forbidden();

        const userDid = canonicalUserDid(args.userDid);
        if (userDid === null) throw invalidRequest("userDid must be a did:pkh:eip155 or did:key DID");
        if (!isMetricName(args.metric)) throw invalidRequest("metric must match ^[A-Za-z][A-Za-z0-9_.:-]{0,63}$");
        if (!Number.isFinite(args.value)) throw invalidRequest("value must be a finite number");
        const index = requireIndex();
        if (!reportRateLimiter.take(appDid, now().getTime())) throw rateLimited();

        await lock(`user:${userDid}`, async () => {
          const documentId = await userStatsDocument(index, userDid);
          await execute(documentId, [
            statsActions.setStat({
              id: generateId(),
              appDid,
              metric: args.metric,
              value: args.value,
              updatedAt: now().toISOString(),
            }),
          ]);
        });
        return true;
      },

      upsertAppProfile: async (_: unknown, args: UpsertAppProfileArgs, ctx: ResolverContext): Promise<boolean> => {
        const appDid = canonicalAppDid(args.appDid);
        if (appDid === null) throw invalidRequest("appDid must be a did:key DID");
        const caller = ctx.user?.address?.toLowerCase();
        if (!caller) throw forbidden();
        const fields: ProfileFields = {
          name: args.name,
          tagline: args.tagline,
          logo: args.logo,
          website: args.website,
        };
        assertProfileFields(fields);
        const index = requireIndex();
        if (!profileRateLimiter.take(caller, now().getTime())) throw rateLimited();

        await lock(`app:${appDid}`, async () => {
          let entry = await index.appProfile(appDid);
          if (!entry) {
            // Only the identity's owner (who delegated to it) may claim its profile.
            if (!(await hasDelegation(relationalDb, caller, appDid, now()))) throw forbidden();
            const created = (await reactorClient.createEmpty(renownAppProfileDocumentType)).header.id;
            await execute(created, [
              profileActions.setAppDid({ appDid }),
              profileActions.setPublisherDid({ publisherDid: pkhDidFor(caller) }),
            ]);
            entry = await index.claimAppProfile({ appDid, documentId: created, publisherAddress: caller }, now());
          }
          if (entry.publisherAddress !== caller) throw forbidden();
          if (Object.values(fields).some((value) => value != null)) {
            await execute(entry.documentId, [profileActions.setProfile(fields)]);
          }
        });
        return true;
      },
    },
  };
}
```

If `tsc` reports that the barrel does not export `isLogo`, `isWebsite` or
`isMetricName`, check the generated `v1/src/index.ts`. It must contain
`export * from "./utils.js";`. Do not deep-import past the barrel.

- [ ] **Step 6: Run tests**

Run: `pnpm vitest run subgraphs/renown-stats`
Expected: PASS, every test in all three files.

- [ ] **Step 7: Lint, typecheck, commit**

```bash
pnpm lint && pnpm tsc && pnpm test
git add subgraphs/renown-stats/schema.ts subgraphs/renown-stats/lookups.ts subgraphs/renown-stats/resolvers.ts subgraphs/renown-stats/tests/resolvers.test.ts
git commit -m "feat(stats): reportUserStat and app profile resolvers with app-DID authorisation"
```

---

### Task 6: Register the `renown-stats` subgraph

**Files:**
- Generated by codegen:
  - `subgraphs/renown-stats/lib.ts`, plus `index.ts` if the codegen writes one
  - an addition to `subgraphs/index.ts`
  - a manifest entry in `powerhouse.manifest.json`
- Create or overwrite: `subgraphs/renown-stats/index.ts`
- Create: `subgraphs/renown-stats/README.md`
- Test: `subgraphs/renown-stats/tests/subgraph.test.ts`

**Interfaces:**
- Consumes:
  - `createResolvers`, `StatsResolverDeps` (Task 5)
  - `schema` (Task 5)
  - `KyselyStatsIndex`, `migrate`, `StatsKysely` (Task 4)
  - `statsAudience` (Task 3)
- Produces: `class RenownStatsSubgraph extends BaseSubgraph` with
  `name = "renown-stats"`. Its GraphQL is served at `/graphql/renown-stats`.

- [ ] **Step 1: Write the failing test**

`subgraphs/renown-stats/tests/subgraph.test.ts`:

```ts
import { PGlite } from "@electric-sql/pglite";
import { GraphQLError } from "graphql";
import { Kysely, sql } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { describe, expect, it, vi } from "vitest";
import { RenownStatsSubgraph } from "../index.js";

type Resolver = (parent: unknown, args: unknown, ctx: unknown) => Promise<unknown>;
const USER = "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";

function makeSubgraph(open: () => Promise<unknown>) {
  const createNamespace = vi.fn(open);
  // Same constructor shape as renown-workload's subgraph test.
  const subgraph = new RenownStatsSubgraph({
    http: { owner: "@powerhousedao/renown-package", baseUrl: "https://sb.example", get: vi.fn(), post: vi.fn() },
    reactorClient: {},
    relationalDb: { createNamespace },
  } as never);
  const resolver = (type: string, field: string) =>
    (subgraph.resolvers as Record<string, Record<string, Resolver>>)[type][field];
  return { subgraph, resolver, createNamespace };
}

async function pgliteNamespace(): Promise<unknown> {
  const root = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
  await sql`create schema "renown-stats"`.execute(root);
  return root.withSchema("renown-stats");
}

describe("RenownStatsSubgraph", () => {
  it("is named renown-stats", () => {
    expect(makeSubgraph(pgliteNamespace).subgraph.name).toBe("renown-stats");
  });

  it("sets up its namespace once and serves reads", async () => {
    const { subgraph, resolver, createNamespace } = makeSubgraph(pgliteNamespace);
    await subgraph.onSetup();
    await subgraph.onSetup();
    expect(createNamespace).toHaveBeenCalledTimes(1);
    expect(createNamespace).toHaveBeenCalledWith("renown-stats");
    expect(await resolver("Query", "userStats")(null, { userDid: USER }, {})).toEqual([]);
  });

  it("never fails the host when its namespace is unavailable", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { subgraph, resolver } = makeSubgraph(() => Promise.reject(new Error("no db")));
    await expect(subgraph.onSetup()).resolves.toBeUndefined();
    const result = await resolver("Query", "userStats")(null, { userDid: USER }, {}).catch((e: unknown) => e);
    expect(result).toBeInstanceOf(GraphQLError);
    expect((result as GraphQLError).extensions.code).toBe("SERVICE_NOT_CONFIGURED");
    expect(error).toHaveBeenCalledWith(expect.stringContaining("[renown-stats]"));
    error.mockRestore();
  });
});
```

- [ ] **Step 2: Run the subgraph codegen, then restore your files**

```bash
git status --short     # must be clean: Tasks 3-5 are committed
pnpm generate subgraph --name renown-stats
git status --short
git diff -- subgraphs/index.ts powerhouse.manifest.json
```

Expected:
- `subgraphs/index.ts` gains exactly
  `export * as RenownStatsSubgraph from "./renown-stats/index.js";`, in
  alphabetical order, with every existing line kept.
- The manifest `subgraphs` array gains `{"id":"renown-stats","name":"renown-stats"}`
  and nothing else changes.

If the codegen overwrote the committed `schema.ts` or `resolvers.ts`, run
`git checkout -- subgraphs/renown-stats/schema.ts subgraphs/renown-stats/resolvers.ts`.
Keep the generated `lib.ts` scaffold.

- [ ] **Step 3: Run the test and confirm failure**

Run: `pnpm vitest run subgraphs/renown-stats/tests/subgraph.test.ts`
Expected: FAIL. Either `index.ts` is the codegen scaffold, which does not use
`createResolvers`, or it is missing.

- [ ] **Step 4: Write the subgraph class**

`subgraphs/renown-stats/index.ts` (overwrite the scaffold):

```ts
import { BaseSubgraph } from "@powerhousedao/reactor-api";
import type { DocumentNode } from "graphql";
import type { ReadModelDb } from "../renown-auth/lookups.js";
import { statsAudience } from "./core/config.js";
import { createResolvers } from "./resolvers.js";
import { schema } from "./schema.js";
import { KyselyStatsIndex } from "./store/kysely.js";
import { migrate } from "./store/migrations.js";
import type { StatsKysely } from "./store/types.js";

/**
 * App profiles and per-user app stats. Documents are written with the
 * in-process reactor client (system writes); every mutation authorises its
 * caller itself. Which document belongs to which DID lives in the
 * `renown-stats` relational namespace.
 *
 * Never fails the host: without its namespace every field answers
 * SERVICE_NOT_CONFIGURED.
 */
export class RenownStatsSubgraph extends BaseSubgraph {
  #index: KyselyStatsIndex | undefined;
  #audience: string | undefined;
  #setUp = false;

  name = "renown-stats";
  typeDefs: DocumentNode = schema;
  resolvers: Record<string, unknown> = createResolvers({
    reactorClient: this.reactorClient,
    relationalDb: this.relationalDb as unknown as ReadModelDb,
    index: () => this.#index,
    audience: () => (this.#audience ??= statsAudience(process.env)),
  });
  additionalContextFields = {};

  async onSetup() {
    // Idempotent: a second setup must not migrate twice.
    if (this.#setUp) return;
    this.#setUp = true;
    try {
      const db = (await this.relationalDb.createNamespace("renown-stats")) as unknown as StatsKysely;
      await migrate(db);
      this.#index = new KyselyStatsIndex(db);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      console.error(`[renown-stats] relational namespace/migration failed (${reason}) — stats and app profiles disabled`);
    }
  }

  onDisconnect(): Promise<void> {
    this.#index = undefined;
    this.#setUp = false;
    return Promise.resolve();
  }
}
```

- [ ] **Step 5: Write the README**

`subgraphs/renown-stats/README.md`:

```markdown
# renown-stats

App profiles (`powerhouse/renown-app-profile`) and per-user app stats
(`powerhouse/renown-user-stats`), at `/graphql/renown-stats`.

## Who may write

| Mutation | Caller |
| --- | --- |
| `reportUserStat(appDid, …)` | The app itself: a host-resolved bearer issued by `appDid`, **or** an app token in `X-Renown-App-Token` whose `aud` is the stats audience, issued by `appDid` for an owner who holds an unrevoked, unexpired delegation to it. |
| `upsertAppProfile(appDid, …)` | The publisher, by wallet bearer. The first upsert needs a delegation from that wallet to `appDid` and makes it the publisher; later upserts need the same wallet. |

Reads are public. Stats are current values per (app, metric): resending a value is harmless.

App tokens go in `X-Renown-App-Token`, not `Authorization`: the host verifies
`Authorization` bearers without an audience and answers 401 to any token that
carries one. Vetra gets app tokens from renown-workload's `issueAppStatsToken`.

## Environment

| Variable | Purpose | Default |
| --- | --- | --- |
| `RENOWN_STATS_AUDIENCE` | The `aud` app tokens must carry (also what `issueAppStatsToken` mints). | `https://switchboard.renown.vetra.io/graphql/renown-stats` |

## Limits

600 reports per app DID per minute; 30 profile upserts per wallet per minute
(in memory, per replica); 32 metrics per app per user.
```

- [ ] **Step 6: Run tests**

Run: `pnpm vitest run subgraphs/renown-stats`
Expected: PASS.

- [ ] **Step 7: Lint, typecheck, build, commit**

```bash
pnpm lint && pnpm tsc && pnpm test && pnpm build
git add subgraphs/index.ts powerhouse.manifest.json subgraphs/renown-stats/index.ts subgraphs/renown-stats/lib.ts subgraphs/renown-stats/README.md subgraphs/renown-stats/tests/subgraph.test.ts
git commit -m "feat(stats): register the renown-stats subgraph"
```

---

### Task 7: `issueAppStatsToken` for the Vetra relay (renown-workload, additive)

**Why:** App did:key private keys exist only inside Renown, sealed in
`workload_identities`. Today the only way to get a token signed by one is the
GitHub Actions OIDC exchange, which serves CI runs. The Vetra server therefore
cannot sign as an app. This mutation lets the registration-token holder mint a
10-minute token whose `aud` is fixed to the stats audience. Vetra already holds
that token, and it already registers and deletes these identities. A token for
this audience cannot be used anywhere else:
- Hosts that verify the bearer without an audience reject it (did-jwt).
- Endpoints that check their own audience don't accept this one.

**Files:**
- Modify (additive): `subgraphs/renown-workload/core/keys.ts`. Append
  `issueAppToken`.
- Modify (additive): `subgraphs/renown-workload/schema.ts`. Add the
  `AppStatsToken` type and the mutation field.
- Modify (additive): `subgraphs/renown-workload/resolvers.ts`. Add an optional
  `statsAudience` dep and the `issueAppStatsToken` resolver.
- Modify (additive): `subgraphs/renown-workload/README.md`. Add one bullet.
- Test: `subgraphs/renown-workload/tests/app-token.test.ts` (new file; existing
  tests are untouched)

**Interfaces:**
- Consumes:
  - `statsAudience` (Task 3)
  - existing `authorized(ctx)`, `open`, `WorkloadStore.getByDid`, `JwkKeyPair`
- Produces:
  - `issueAppToken(input: { keyPair: JwkKeyPair; did: string; chainId: number; address: string; audience: string; expiresInSec: number }): Promise<string>`
  - `APP_STATS_TOKEN_TTL_SEC = 600`
  - GraphQL: `issueAppStatsToken(did: String!): AppStatsToken!` with
    `AppStatsToken { accessToken: String!, audience: String!, expiresIn: Int! }`.
    It requires the `x-renown-workload-registration-token` header.

- [ ] **Step 1: Write the failing test**

`subgraphs/renown-workload/tests/app-token.test.ts`:

```ts
import { verifyAuthBearerToken } from "@renown/sdk";
import { GraphQLError } from "graphql";
import { getAddress } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import type { WorkloadConfig } from "../core/types.js";
import { APP_STATS_TOKEN_TTL_SEC, createResolvers, REGISTRATION_TOKEN_HEADER } from "../resolvers.js";
import { MemoryWorkloadStore } from "../store/memory.js";

type Resolver = (parent: unknown, args: unknown, ctx: unknown) => Promise<unknown>;

const STATS_AUDIENCE = "https://sb.example/graphql/renown-stats";
const OWNER = "0xabcdef0123456789abcdef0123456789abcdef01";
const authorized = { headers: { [REGISTRATION_TOKEN_HEADER]: "right-token" } };

let config: WorkloadConfig;
let store: MemoryWorkloadStore;

function mutation(field: string): Resolver {
  const resolvers = createResolvers({
    config: () => config,
    store: () => store,
    statsAudience: () => STATS_AUDIENCE,
  }) as Record<string, Record<string, Resolver>>;
  return resolvers.Mutation[field];
}

async function registeredDid(): Promise<string> {
  const identity = (await mutation("registerWorkloadIdentity")(
    null,
    { input: { repositoryId: "123", repository: "acme/shop", productionBranch: "main", ownerAddress: OWNER, chainId: 1 } },
    authorized,
  )) as { did: string };
  return identity.did;
}

async function code(promise: Promise<unknown>): Promise<unknown> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(GraphQLError);
  return (error as GraphQLError).extensions.code;
}

beforeEach(() => {
  config = { encryptionKey: new Uint8Array(32).fill(5), registrationToken: "right-token", audiences: [] };
  store = new MemoryWorkloadStore();
});

describe("issueAppStatsToken", () => {
  it("mints a short-lived token signed by the app's did:key, for the stats audience only", async () => {
    const did = await registeredDid();
    const result = (await mutation("issueAppStatsToken")(null, { did }, authorized)) as {
      accessToken: string;
      audience: string;
      expiresIn: number;
    };
    expect(result.audience).toBe(STATS_AUDIENCE);
    expect(result.expiresIn).toBe(APP_STATS_TOKEN_TTL_SEC);

    const verified = await verifyAuthBearerToken(result.accessToken, { audience: STATS_AUDIENCE });
    expect(verified && verified.issuer).toBe(did);
    expect(verified && verified.verifiableCredential.credentialSubject.address).toBe(getAddress(OWNER));
    expect(verified && verified.payload.vetra).toBeUndefined();
    // Useless as an Authorization bearer elsewhere:
    expect(await verifyAuthBearerToken(result.accessToken)).toBe(false);
    expect(await verifyAuthBearerToken(result.accessToken, { audience: "https://registry.vetra.io" })).toBe(false);
  });

  it("requires the registration token", async () => {
    const did = await registeredDid();
    expect(await code(mutation("issueAppStatsToken")(null, { did }, {}))).toBe("FORBIDDEN");
    expect(
      await code(mutation("issueAppStatsToken")(null, { did }, { headers: { [REGISTRATION_TOKEN_HEADER]: "wrong" } })),
    ).toBe("FORBIDDEN");
  });

  it("answers NOT_FOUND for an unknown DID and SERVICE_NOT_CONFIGURED without the encryption key", async () => {
    expect(await code(mutation("issueAppStatsToken")(null, { did: "did:key:zUnknown" }, authorized))).toBe("NOT_FOUND");
    const did = await registeredDid();
    config = { ...config, encryptionKey: null };
    expect(await code(mutation("issueAppStatsToken")(null, { did }, authorized))).toBe("SERVICE_NOT_CONFIGURED");
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm vitest run subgraphs/renown-workload/tests/app-token.test.ts`
Expected: FAIL. `APP_STATS_TOKEN_TTL_SEC` is not exported, and the mutation is
undefined.

- [ ] **Step 3: Implement (append only)**

Append to `subgraphs/renown-workload/core/keys.ts`. Also extend its existing
`@renown/sdk` import with `createAuthBearerToken`, an import-only addition:

```ts
export interface IssueAppTokenInput {
  keyPair: JwkKeyPair;
  /** The DID the key pair must resolve to (guards against a mismatched row). */
  did: string;
  chainId: number;
  address: string;
  audience: string;
  expiresInSec: number;
}

/**
 * A Renown auth bearer token for one service audience, signed by the
 * identity's did:key, without the CI `vetra` claim. Used for the Vetra
 * stats relay (`issueAppStatsToken`).
 */
export async function issueAppToken(input: IssueAppTokenInput): Promise<string> {
  const renownCrypto = await new RenownCryptoBuilder()
    .withKeyPairStorage(new MemoryKeyStorage(input.keyPair))
    .withChainId(input.chainId)
    .build();
  if (renownCrypto.did !== input.did) {
    throw new Error("Stored key pair does not match the identity's DID");
  }
  return createAuthBearerToken(input.chainId, DEFAULT_RENOWN_NETWORK_ID, input.address, renownCrypto.issuer, {
    aud: input.audience,
    expiresIn: input.expiresInSec,
  });
}
```

In `subgraphs/renown-workload/schema.ts`, add this type after `WorkloadIdentity`:

```graphql
  type AppStatsToken {
    accessToken: String!
    audience: String!
    expiresIn: Int!
  }
```

Then add this as the last field inside `type Mutation { … }`:

```graphql
    "A 10-minute Renown bearer signed by the identity's did:key, valid only for the renown-stats audience (send it as X-Renown-App-Token). For the Vetra stats relay."
    issueAppStatsToken(did: String!): AppStatsToken!
```

In `subgraphs/renown-workload/resolvers.ts`:
- Add these imports:
  ```ts
  import { statsAudience } from "../renown-stats/core/config.js";
  import { open } from "./core/crypto.js";
  import { issueAppToken } from "./core/keys.js";
  import type { JwkKeyPair } from "./core/types.js";
  ```
  `WorkloadConfig` and `WorkloadIdentity` are already imported from
  `./core/types.js`. Add `JwkKeyPair` to that import.
- Add an optional field to `ResolverDeps`:
  ```ts
  /** The audience app stats tokens are minted for (defaults to RENOWN_STATS_AUDIENCE / renown-stats default). */
  statsAudience?: () => string;
  ```
- Export the constant:
  ```ts
  /** Lifetime of an app stats token, in seconds. */
  export const APP_STATS_TOKEN_TTL_SEC = 600;
  ```
- Add this resolver as the last entry of `Mutation`:

```ts
      issueAppStatsToken: async (
        _parent: unknown,
        args: { did: string },
        ctx: ResolverContext,
      ): Promise<{ accessToken: string; audience: string; expiresIn: number }> => {
        const registry = authorized(ctx);
        const { encryptionKey } = registry;
        if (encryptionKey === null) {
          throw notConfigured("RENOWN_WORKLOAD_KEY_ENCRYPTION_KEY");
        }
        const identity = await registry.store.getByDid(args.did);
        if (!identity) {
          throw new GraphQLError("No workload identity with this DID", {
            extensions: { code: "NOT_FOUND" },
          });
        }
        let keyPair: JwkKeyPair;
        try {
          keyPair = JSON.parse(
            await open(encryptionKey, identity.encryptedKeyPair, identity.did),
          ) as JwkKeyPair;
        } catch {
          console.error(
            `[renown-workload] cannot decrypt the key of ${identity.did} (wrong RENOWN_WORKLOAD_KEY_ENCRYPTION_KEY?)`,
          );
          throw new GraphQLError("Internal error", {
            extensions: { code: "INTERNAL_SERVER_ERROR" },
          });
        }
        const audience = (deps.statsAudience ?? (() => statsAudience(process.env)))();
        const accessToken = await issueAppToken({
          keyPair,
          did: identity.did,
          chainId: identity.chainId,
          address: identity.ownerAddress,
          audience,
          expiresInSec: APP_STATS_TOKEN_TTL_SEC,
        });
        console.info(
          `[renown-workload] issued app stats token ${JSON.stringify({ did: identity.did, audience })}`,
        );
        return { accessToken, audience, expiresIn: APP_STATS_TOKEN_TTL_SEC };
      },
```

Append to `subgraphs/renown-workload/README.md`, under the GraphQL bullet:

```markdown
- GraphQL `issueAppStatsToken(did)` (same header): a 10-minute bearer signed by the identity's did:key with `aud` = `RENOWN_STATS_AUDIENCE` (default `https://switchboard.renown.vetra.io/graphql/renown-stats`). Vetra's stats relay sends it to `reportUserStat` as `X-Renown-App-Token`.
```

- [ ] **Step 4: Run the new and the existing workload tests**

Run: `pnpm vitest run subgraphs/renown-workload`
Expected: PASS. Every pre-existing workload test passes unmodified.

- [ ] **Step 5: End-to-end check against renown-stats**

Append to `subgraphs/renown-stats/tests/resolvers.test.ts`, inside
`describe("reportUserStat")`. This test proves that a token minted by Task 7
passes Task 5's header path:

```ts
  it("accepts a token minted by renown-workload's issueAppToken", async () => {
    const { generateWorkloadKey, issueAppToken } = await import("../../renown-workload/core/keys.js");
    const { did, keyPair } = await generateWorkloadKey();
    await insertDelegation(OWNER, did);
    const token = issueAppToken({ keyPair, did, chainId: 1, address: OWNER, audience: AUDIENCE, expiresInSec: 600 });
    const { report } = setup();
    expect(await report({ appDid: did, userDid: USER, metric: "m", value: 1 }, await appHeader(token))).toBe(true);
  });
```

Run: `pnpm vitest run subgraphs/renown-stats subgraphs/renown-workload`
Expected: PASS.

- [ ] **Step 6: Lint, typecheck, commit**

```bash
pnpm lint && pnpm tsc && pnpm test
git add subgraphs/renown-workload/core/keys.ts subgraphs/renown-workload/schema.ts subgraphs/renown-workload/resolvers.ts subgraphs/renown-workload/README.md subgraphs/renown-workload/tests/app-token.test.ts subgraphs/renown-stats/tests/resolvers.test.ts
git commit -m "feat(stats): issueAppStatsToken so the Vetra relay can report as the app"
```

---

### Task 8: Whole-branch verification and PR

**Files:** none new.

- [ ] **Step 1: Prove the change is additive**

```bash
git diff --stat origin/main...HEAD
git diff origin/main...HEAD -- subgraphs/index.ts document-models/document-models.ts document-models/index.ts document-models/upgrade-manifests.ts powerhouse.manifest.json | grep '^-[^-]' || echo "additions only"
git diff origin/main...HEAD --name-only | grep -E '^(subgraphs/(renown-auth|renown-oidc|renown-read-model|renown-user)/|processors/|editors/|document-models/renown-(user|credential|oidc-client)/)' || echo "no existing module touched"
git diff origin/main...HEAD -- subgraphs/renown-workload | grep '^-[^-]'
```

Expected:
- `additions only`.
- `no existing module touched`.
- The last command prints only import-line rewrites in `keys.ts` and
  `resolvers.ts`, where an existing import gained names. It prints no removed
  logic.

- [ ] **Step 2: Full verification**

Run: `pnpm lint && pnpm tsc && pnpm test && pnpm vitest run --coverage && pnpm build`
Expected: everything exits 0. Coverage thresholds of 95 % hold. The build
emits `dist/` without errors.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feat/app-profile-user-stats
gh pr create --base main --title "feat(stats): app profiles and per-user app stats (renown-stats)" --body "$(cat <<'EOF'
Adds powerhouse/renown-app-profile, powerhouse/renown-user-stats and the renown-stats subgraph (contract: vetra-cloud-package docs/superpowers/specs/2026-10-08-licensing-api-contract.md, "Renown"), plus renown-workload issueAppStatsToken for the Vetra relay.

- Strictly additive: no existing subgraph, model, processor or test changes behaviour.
- reportUserStat: only the app DID (host bearer appKey, or X-Renown-App-Token with the stats audience + a valid owner delegation).
- upsertAppProfile: first upsert needs a delegation from the caller's wallet to the app DID; later upserts only by that publisher.
- Deploy: no new required env. Optional RENOWN_STATS_AUDIENCE. Validate on staging before prod.
EOF
)"
```

Do not merge. The human merges, then releases through the `Sync and Publish`
workflow (manual `workflow_dispatch`, staging channel first), and then bumps the
renown tenant image in powerhouse-k8s-hosting.

---

## Self-review notes

- **Spec coverage:**
  - The two models and their fields: Tasks 1 and 2.
  - Current-value semantics, retries harmless: Task 1 scenario, Task 5
    "keeps current values".
  - Only the app DID writes its metrics, checked against the bearer's
    credential: Task 5.
  - The contract's queries and mutations verbatim: Task 5 Step 3.
  - Registered in the barrel: Task 6.
  - "Vetra calls reportUserStat with a bearer issued for the app's DID":
    Task 7, header transport (see Review Focus 1).
  - "Listed under the publisher's Renown profile" is served by
    `appProfilesByPublisher`. The Renown UI that renders it is out of scope for
    this repo.
- **Deliberate deviations from the contract text:**
  - The app token travels in `X-Renown-App-Token`, not `Authorization`, because
    the host 401s audience-bearing bearers. The cloud-package relay must use
    the header.
  - The first `upsertAppProfile` additionally requires a delegation, to stop
    squatting. It still "sets publisherDid = caller".
