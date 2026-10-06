# License-Driven Environment Provisioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A licence held by a user produces a running environment from a template, reconciled on a timer, and expiring or revoking that licence stops it.

**Architecture:** Two new document models carry the data (`app-license-type` describes a kind of grant and the environment shape it buys; `app-owner-license` is one grant to one user). A new `vetra-licensing` subgraph owns an upsert-keyed `applyEnvironmentTemplate` API plus a `LicenseKeeper` that moves licences through their lifecycle on a timer. The publisher's handler is a separate timer-driven reconciler that diffs active licences against existing environments — it has no event stream and therefore no replay semantics.

**Tech Stack:** TypeScript (`module: nodenext`, strict), Kysely over Postgres, GraphQL via `BaseSubgraph` from `@powerhousedao/reactor-api`, vitest, Powerhouse document models authored through `reactor-mcp`.

**Spec:** `docs/superpowers/specs/2026-10-06-license-driven-provisioning-design.md`

## Prerequisites

Neither is optional; both block Task 1.

1. **`feat/vetra-apps` merged to `main`.** Authorization resolves a caller DID to an App via `identity_did`, and that table (`apps`, in `subgraphs/vetra-apps/db/schema.ts`) exists only on that branch. It also provides `EnvGateway` (`subgraphs/vetra-apps/envs.ts:13-27`), the only environment adapter that detects reducer rejections. The studio pool's `ReactorLike.execute` silently swallows them and must not be used.
2. **`ph vetra` running in a separate terminal**, with `reactor-mcp` connected. Document models are authored only through MCP tools. Per `CLAUDE.md`, ask the user to start it — do not start it yourself.

## Global Constraints

Copied from `CLAUDE.md` and the spec. Every task's requirements implicitly include this section.

- **Reducers are pure synchronous functions.** `Date.now()`, `new Date()`, `crypto.randomUUID()` and `Math.random()` are forbidden inside them. Every timestamp and id arrives in the action input.
- **Document model reducers must stay at or above 95% coverage on lines, branches, functions and statements.** Do not lower the threshold or exclude files to make the check pass.
- **Never edit files under `gen/`.** They are regenerated and your changes are lost.
- **Any document model change is two steps:** the MCP action (`SET_STATE_SCHEMA`, `SET_OPERATION_SCHEMA`, `SET_OPERATION_REDUCER`) *and* the hand-written file under `src/reducers/`. Doing only one means the next codegen reintroduces the bug.
- **State type must be named `<DocumentModelName>State`.** Never `...GlobalState`.
- **Input type must be named `<OperationName>Input`** exactly, or codegen breaks.
- **Errors are declared with `ADD_OPERATION_ERROR`** and referenced bare in reducer code (`throw new NotLicenseOwnerError("…")`) — never imported, never `throw new Error`.
- **Relative imports carry `.js` extensions.** Document-model symbols come from the top-level barrel (`document-models/app-owner-license`), never a deep `gen/` path.
- **Available scalars:** `String`, `Int`, `Float`, `Boolean`, `OID`, `PHID`, `OLabel`, the `Amount_*` family, `EthereumAddress`, `EmailAddress`, `Date`, `DateTime`, `URL`, `Currency`. There is no `AID` and no `Json`.
- **`!` only where there is a logical default** — the status enums and the `[T!]!` collections. A user must be able to create an empty document.
- **Objects inside arrays carry `id: OID!`.** `PHID` is only for references to other documents.
- After any change run `npm run tsc`, `npm run lint:fix`, and `npm run test:coverage`.

## Review Focus

Five conditions the spec implies that no task's happy path exercises, most likely to bite first. Each has its test assigned to the task that owns the code.

1. **A licence whose `end` precedes its `start`** — issued, never legitimately valid. If the clock activates it before expiring it, an environment is provisioned and torn down for nothing. It must go straight to `EXPIRED`. → Task 4.
2. **Two `ACTIVE` licences for the same `(app, user)`** — spec open question 1. A `Map` keyed on user silently lets whichever arrived last win, so the same input produces different environments on different ticks. Precedence must be deterministic. → Task 9.
3. **A licence pointing at a `RETIRED` or missing licence type** — the handler cannot resolve a template. It must skip that licence and leave any existing environment alone, not release it. → Task 7.
4. **Two keeper ticks calling `applyEnvironmentTemplate` concurrently for the same `(app, user)`** — the row does not exist yet, so both branches decide to create. Exactly one environment must result. → Task 7.
5. **The App identity expired (`PENDING_IDENTITY`) while the handler keeps calling** — provisioning must fail closed with a named error, never proceed unauthenticated. → Task 8.

---

### Task 1: `vetra-licensing` subgraph skeleton and tables

**Files:**
- Create: `subgraphs/vetra-licensing/index.ts`
- Create: `subgraphs/vetra-licensing/db/schema.ts`
- Create: `subgraphs/vetra-licensing/db/migrations.ts`
- Create: `subgraphs/vetra-licensing/schema.ts`
- Create: `subgraphs/vetra-licensing/resolvers.ts`
- Modify: `subgraphs/index.ts`
- Test: `subgraphs/vetra-licensing/__tests__/migrations.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `VetraLicensingDB` (table types), `up(db)`, `VetraLicensingSubgraph`. Table `app_user_environments` with primary key `(app_id, user_address)`; table `app_environment_limits` with primary key `app_id`.

- [ ] **Step 1: Write the failing test**

```ts
// subgraphs/vetra-licensing/__tests__/migrations.test.ts
import { describe, it, expect } from "vitest";
import { up } from "../db/migrations.js";

describe("vetra-licensing migrations", () => {
  it("creates app_user_environments and app_environment_limits", async () => {
    const created: string[] = [];
    const fake = {
      schema: {
        createTable: (name: string) => {
          created.push(name);
          const chain: any = {
            addColumn: () => chain,
            addPrimaryKeyConstraint: () => chain,
            ifNotExists: () => chain,
            execute: async () => undefined,
          };
          return chain;
        },
        createIndex: () => {
          const chain: any = {
            on: () => chain,
            column: () => chain,
            ifNotExists: () => chain,
            execute: async () => undefined,
          };
          return chain;
        },
      },
    };
    await up(fake as never);
    expect(created).toEqual(["app_user_environments", "app_environment_limits"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run subgraphs/vetra-licensing/__tests__/migrations.test.ts`
Expected: FAIL — cannot resolve `../db/migrations.js`.

- [ ] **Step 3: Write the table types**

```ts
// subgraphs/vetra-licensing/db/schema.ts

/** One environment, owned by one user, under one app. Upsert key of the whole design. */
export interface AppUserEnvironments {
  app_id: string;
  /** Lowercased 0x address. The DID form is normalised away at the resolver boundary. */
  user_address: string;
  environment_id: string;
  license_id: string;
  /** sha256 of the canonical rendered template; how a stale environment is recognised. */
  template_hash: string;
  created_at: string;
  updated_at: string;
}

/** Per-app ceiling on how many environments may exist. Absent row = configured default. */
export interface AppEnvironmentLimits {
  app_id: string;
  max_environments: number;
}

export interface VetraLicensingDB {
  app_user_environments: AppUserEnvironments;
  app_environment_limits: AppEnvironmentLimits;
}
```

- [ ] **Step 4: Write the migration**

```ts
// subgraphs/vetra-licensing/db/migrations.ts
import { type Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("app_user_environments")
    .addColumn("app_id", "varchar(255)", (col) => col.notNull())
    .addColumn("user_address", "varchar(255)", (col) => col.notNull())
    .addColumn("environment_id", "varchar(255)", (col) => col.notNull())
    .addColumn("license_id", "varchar(255)", (col) => col.notNull())
    .addColumn("template_hash", "varchar(64)", (col) => col.notNull())
    .addColumn("created_at", "varchar(255)", (col) => col.notNull())
    .addColumn("updated_at", "varchar(255)", (col) => col.notNull())
    .addPrimaryKeyConstraint("app_user_environments_pkey", [
      "app_id",
      "user_address",
    ])
    .ifNotExists()
    .execute();

  await db.schema
    .createTable("app_environment_limits")
    .addColumn("app_id", "varchar(255)", (col) => col.notNull())
    .addColumn("max_environments", "integer", (col) => col.notNull())
    .addPrimaryKeyConstraint("app_environment_limits_pkey", ["app_id"])
    .ifNotExists()
    .execute();

  await db.schema
    .createIndex("app_user_environments_app_id_idx")
    .on("app_user_environments")
    .column("app_id")
    .ifNotExists()
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("app_environment_limits").execute();
  await db.schema.dropTable("app_user_environments").execute();
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run subgraphs/vetra-licensing/__tests__/migrations.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the subgraph shell**

`schema.ts` starts with an empty-but-valid document; Task 7 and Task 8 fill it.

```ts
// subgraphs/vetra-licensing/schema.ts
import { gql } from "graphql-tag";
import type { DocumentNode } from "graphql";

export const schema: DocumentNode = gql`
  type AppUserEnvironment {
    appId: String!
    user: String!
    environmentId: String!
    licenseId: String!
    templateHash: String!
  }

  type VetraLicensingQueries {
    _placeholder: Boolean
  }

  type Query {
    vetraLicensing: VetraLicensingQueries!
  }
`;
```

```ts
// subgraphs/vetra-licensing/resolvers.ts
import type { Kysely } from "kysely";
import type { VetraLicensingDB } from "./db/schema.js";

export function createResolvers(
  _db: Kysely<VetraLicensingDB>,
): Record<string, unknown> {
  return {
    Query: {
      vetraLicensing: () => ({}),
    },
    VetraLicensingQueries: {
      _placeholder: () => true,
    },
  };
}
```

```ts
// subgraphs/vetra-licensing/index.ts
import { BaseSubgraph } from "@powerhousedao/reactor-api";
import type { DocumentNode } from "graphql";
import type { Kysely } from "kysely";
import { schema } from "./schema.js";
import { createResolvers } from "./resolvers.js";
import { up } from "./db/migrations.js";
import type { VetraLicensingDB } from "./db/schema.js";

/**
 * Licence lifecycle and environment provisioning. Owns its own relational
 * tables in an isolated namespace. The licences themselves are documents;
 * these tables are the upsert key and the per-app ceiling.
 */
export class VetraLicensingSubgraph extends BaseSubgraph {
  name = "vetra-licensing";
  typeDefs: DocumentNode = schema;
  resolvers: Record<string, unknown> = {};
  additionalContextFields = {};

  async onSetup() {
    const db = (await this.relationalDb.createNamespace(
      "vetra-licensing",
    )) as unknown as Kysely<VetraLicensingDB>;

    await up(db as Kysely<any>);

    this.resolvers = createResolvers(db);
  }
}
```

- [ ] **Step 7: Register the subgraph**

Add to `subgraphs/index.ts`, keeping alphabetical order:

```ts
export * as VetraLicensingSubgraph from "./vetra-licensing/index.js";
```

Then add `{ "id": "vetra-licensing", "name": "Vetra Licensing" }` to the `subgraphs` array in `powerhouse.manifest.json`.

- [ ] **Step 8: Verify the build**

Run: `npm run tsc && npm run lint:fix`
Expected: both clean.

- [ ] **Step 9: Commit**

```bash
git add subgraphs/vetra-licensing subgraphs/index.ts powerhouse.manifest.json
git commit -m "feat(licensing): add vetra-licensing subgraph skeleton and tables"
```

---

### Task 2: `app-license-type` document model

**Files:**
- Create (via MCP, then codegen): `document-models/app-license-type/**`
- Create: `document-models/app-license-type/v1/src/reducers/license-type.ts`
- Modify: `document-models/index.ts`
- Test: `document-models/app-license-type/v1/tests/license-type.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: document type `powerhouse/app-license-type`, extension `.lict`. State `AppLicenseTypeState`. Actions `SET_LICENSE_TYPE_DETAILS`, `SET_TEMPLATE`, `ADD_TEMPLATE_SERVICE`, `ADD_TEMPLATE_PACKAGE`, `PUBLISH_LICENSE_TYPE`, `RETIRE_LICENSE_TYPE`. Barrel `document-models/app-license-type`.

- [ ] **Step 1: Confirm `reactor-mcp` is reachable**

If the MCP server is unavailable, ask the user to run `ph vetra` in a separate terminal. Do not run it yourself.

- [ ] **Step 2: Read the document-model schema before authoring**

Call `mcp__reactor-mcp__getDocumentModelSchema` with `type: "powerhouse/document-model"`. Required: the input schemas for `ADD_MODULE`, `ADD_OPERATION`, `ADD_OPERATION_ERROR`.

- [ ] **Step 3: Create the model document and set its state schema**

Create a `powerhouse/document-model` document on the `vetra-{hash}` drive. Set id `powerhouse/app-license-type`, name `AppLicenseType`, extension `.lict`. Then `SET_STATE_SCHEMA` (scope `global`):

```graphql
type AppLicenseTypeState {
  app: PHID
  kind: String
  label: String
  validityDays: Int
  template: EnvironmentTemplate
  status: LicenseTypeStatus!
}

enum LicenseTypeStatus {
  DRAFT
  ACTIVE
  RETIRED
}

enum TemplateServiceType {
  CONNECT
  SWITCHBOARD
  CLINT
}

type EnvironmentTemplate {
  services: [TemplateService!]!
  packages: [TemplatePackage!]!
  size: String
  baseDomain: String
  packageRegistry: URL
}

type TemplateService {
  id: OID!
  type: TemplateServiceType!
  prefix: String
}

type TemplatePackage {
  id: OID!
  packageName: String
  version: String
}
```

`SET_INITIAL_STATE` with `status: "DRAFT"`, `template: null`, everything else null.

- [ ] **Step 4: Add the operations and their errors**

Module `license_type`, operations below. Errors via `ADD_OPERATION_ERROR`.

| Operation | Input | Errors |
|---|---|---|
| `SET_LICENSE_TYPE_DETAILS` | `app: PHID`, `kind: String`, `label: String`, `validityDays: Int` | `NegativeValidityError` / `NEGATIVE_VALIDITY` |
| `SET_TEMPLATE` | `size: String`, `baseDomain: String`, `packageRegistry: URL` | — |
| `ADD_TEMPLATE_SERVICE` | `id: OID!`, `type: TemplateServiceType!`, `prefix: String` | `DuplicateServiceError` / `DUPLICATE_SERVICE` |
| `ADD_TEMPLATE_PACKAGE` | `id: OID!`, `packageName: String`, `version: String` | `DuplicatePackageError` / `DUPLICATE_PACKAGE` |
| `PUBLISH_LICENSE_TYPE` | `_: Boolean` | `IncompleteTemplateError` / `INCOMPLETE_TEMPLATE` |
| `RETIRE_LICENSE_TYPE` | `_: Boolean` | `NotPublishedError` / `NOT_PUBLISHED` |

`PUBLISH_LICENSE_TYPE` moves `DRAFT → ACTIVE` and requires `kind` set and at least one service. `RETIRE_LICENSE_TYPE` moves `ACTIVE → RETIRED` and rejects any other source status.

- [ ] **Step 5: Write the failing reducer tests**

```ts
// document-models/app-license-type/v1/tests/license-type.test.ts
import { describe, it, expect } from "vitest";
import { utils, actions, reducer } from "document-models/app-license-type";

describe("AppLicenseType", () => {
  it("starts as DRAFT with an empty template", () => {
    const doc = utils.createDocument();
    expect(doc.state.global.status).toBe("DRAFT");
    expect(doc.state.global.template).toBeNull();
  });

  it("publishes once a kind and a service exist", () => {
    let doc = utils.createDocument();
    doc = reducer(doc, actions.setLicenseTypeDetails({
      app: "app-1", kind: "2026-free-tier", label: "Free", validityDays: 365,
    }));
    doc = reducer(doc, actions.addTemplateService({
      id: "svc-1", type: "CONNECT", prefix: "connect",
    }));
    doc = reducer(doc, actions.publishLicenseType({ _: true }));
    expect(doc.state.global.status).toBe("ACTIVE");
  });

  it("refuses to publish without a service", () => {
    let doc = utils.createDocument();
    doc = reducer(doc, actions.setLicenseTypeDetails({
      app: "app-1", kind: "2026-free-tier", label: "Free", validityDays: 365,
    }));
    doc = reducer(doc, actions.publishLicenseType({ _: true }));
    expect(doc.operations.global[1].error).toBe(
      "a license type needs at least one service before it can be published",
    );
    expect(doc.state.global.status).toBe("DRAFT");
  });

  it("refuses a duplicate service id", () => {
    let doc = utils.createDocument();
    doc = reducer(doc, actions.addTemplateService({
      id: "svc-1", type: "CONNECT", prefix: "connect",
    }));
    doc = reducer(doc, actions.addTemplateService({
      id: "svc-1", type: "SWITCHBOARD", prefix: "switchboard",
    }));
    expect(doc.operations.global[1].error).toBe("service svc-1 already exists");
  });

  it("refuses to retire a draft", () => {
    const doc = reducer(utils.createDocument(), actions.retireLicenseType({ _: true }));
    expect(doc.operations.global[0].error).toBe(
      "only an ACTIVE license type can be retired",
    );
  });

  it("refuses negative validity", () => {
    const doc = reducer(utils.createDocument(), actions.setLicenseTypeDetails({
      app: "app-1", kind: "k", label: "l", validityDays: -1,
    }));
    expect(doc.operations.global[0].error).toBe("validityDays must be positive");
  });
});
```

Note the error-testing idiom: a rejected operation is still recorded, with the message on `operations.global[n].error`, and state is unchanged. Never use `.toThrow()`.

- [ ] **Step 6: Run tests to verify they fail**

Run: `npx vitest run document-models/app-license-type`
Expected: FAIL — module not found, or reducers unimplemented.

- [ ] **Step 7: Implement the reducers**

Write both in the MCP action (`SET_OPERATION_REDUCER`) **and** in `src/reducers/license-type.ts`.

```ts
// document-models/app-license-type/v1/src/reducers/license-type.ts
import type { AppLicenseTypeLicenseTypeOperations } from "../../gen/license-type/operations.js";

const emptyTemplate = () => ({
  services: [],
  packages: [],
  size: null,
  baseDomain: null,
  packageRegistry: null,
});

export const reducer: AppLicenseTypeLicenseTypeOperations = {
  setLicenseTypeDetailsOperation(state, action) {
    if (action.input.validityDays != null && action.input.validityDays <= 0) {
      throw new NegativeValidityError("validityDays must be positive");
    }
    if (action.input.app) state.app = action.input.app;
    if (action.input.kind) state.kind = action.input.kind;
    if (action.input.label) state.label = action.input.label;
    state.validityDays = action.input.validityDays ?? null;
  },

  setTemplateOperation(state, action) {
    state.template ??= emptyTemplate();
    state.template.size = action.input.size ?? null;
    state.template.baseDomain = action.input.baseDomain ?? null;
    state.template.packageRegistry = action.input.packageRegistry ?? null;
  },

  addTemplateServiceOperation(state, action) {
    state.template ??= emptyTemplate();
    if (state.template.services.some((s) => s.id === action.input.id)) {
      throw new DuplicateServiceError(`service ${action.input.id} already exists`);
    }
    state.template.services.push({
      id: action.input.id,
      type: action.input.type,
      prefix: action.input.prefix ?? null,
    });
  },

  addTemplatePackageOperation(state, action) {
    state.template ??= emptyTemplate();
    if (state.template.packages.some((p) => p.id === action.input.id)) {
      throw new DuplicatePackageError(`package ${action.input.id} already exists`);
    }
    state.template.packages.push({
      id: action.input.id,
      packageName: action.input.packageName ?? null,
      version: action.input.version ?? null,
    });
  },

  publishLicenseTypeOperation(state) {
    if (!state.kind || !state.template || state.template.services.length === 0) {
      throw new IncompleteTemplateError(
        "a license type needs at least one service before it can be published",
      );
    }
    state.status = "ACTIVE";
  },

  retireLicenseTypeOperation(state) {
    if (state.status !== "ACTIVE") {
      throw new NotPublishedError("only an ACTIVE license type can be retired");
    }
    state.status = "RETIRED";
  },
};
```

Error classes are referenced bare — codegen imports them. Do not add import statements for them.

- [ ] **Step 8: Run tests and coverage**

Run: `npm run tsc && npx vitest run document-models/app-license-type && npm run test:coverage`
Expected: tests PASS, coverage at or above 95% on all four metrics. If a branch is uncovered, categorise it before adding a test — a nullable field that is always set means the *type* is wrong, not the test.

- [ ] **Step 9: Register the model**

Add to `document-models/index.ts`:

```ts
export { AppLicenseType as AppLicenseTypeV1 } from "./app-license-type/v1/module.js";
```

Confirm codegen updated `document-models/document-models.ts` and `upgrade-manifests.ts`; if not, add the entries by hand. Add the model to `powerhouse.manifest.json` under `documentModels`.

- [ ] **Step 10: Commit**

```bash
git add document-models/app-license-type document-models/index.ts document-models/document-models.ts document-models/upgrade-manifests.ts powerhouse.manifest.json
git commit -m "feat(licensing): add app-license-type document model"
```

---

### Task 3: `app-owner-license` document model

**Files:**
- Create (via MCP, then codegen): `document-models/app-owner-license/**`
- Create: `document-models/app-owner-license/v1/src/reducers/lifecycle.ts`
- Modify: `document-models/index.ts`
- Test: `document-models/app-owner-license/v1/tests/lifecycle.test.ts`

**Interfaces:**
- Consumes: nothing at runtime; `licenseType: PHID` points at a Task 2 document.
- Produces: document type `powerhouse/app-owner-license`, extension `.lic`. State `AppOwnerLicenseState`. Actions `ISSUE_LICENSE`, `ACTIVATE_LICENSE`, `EXPIRE_LICENSE`, `REVOKE_LICENSE`, `REPLACE_LICENSE`. Barrel `document-models/app-owner-license`.

- [ ] **Step 1: Set the state schema via MCP**

Id `powerhouse/app-owner-license`, name `AppOwnerLicense`, extension `.lic`.

```graphql
type AppOwnerLicenseState {
  app: PHID
  licenseType: PHID
  user: EthereumAddress
  issuer: LicenseIssuerKind
  issuedBy: EthereumAddress
  stage: PHID
  details: String
  issued: DateTime
  start: DateTime
  end: DateTime
  status: LicenseStatus!
  replacedBy: PHID
  revokedReason: String
}

enum LicenseIssuerKind {
  INVITE_CODE
  PUBLISHER_GRANT
  ACHRA_SUBSCRIPTION
}

enum LicenseStatus {
  ISSUED
  ACTIVE
  EXPIRED
  REVOKED
  REPLACED
}
```

`SET_INITIAL_STATE` with `status: "ISSUED"` and every other field null.

- [ ] **Step 2: Add the operations and errors**

Module `lifecycle`.

| Operation | Input | Errors |
|---|---|---|
| `ISSUE_LICENSE` | `app: PHID!`, `licenseType: PHID!`, `user: EthereumAddress!`, `issuer: LicenseIssuerKind!`, `issuedBy: EthereumAddress!`, `stage: PHID`, `details: String`, `issued: DateTime!`, `start: DateTime!`, `end: DateTime` | `AlreadyIssuedError` / `ALREADY_ISSUED`, `EndBeforeStartError` / `END_BEFORE_START` |
| `ACTIVATE_LICENSE` | `_: Boolean` | `InvalidStatusTransitionError` / `INVALID_STATUS_TRANSITION` |
| `EXPIRE_LICENSE` | `_: Boolean` | `InvalidStatusTransitionError` |
| `REVOKE_LICENSE` | `reason: String` | `InvalidStatusTransitionError` |
| `REPLACE_LICENSE` | `replacedBy: PHID!` | `InvalidStatusTransitionError` |

`validityDays` is deliberately **not** an input here. Reducers are pure, so the caller resolves the licence type's duration into `start` and `end` before dispatching.

- [ ] **Step 3: Write the failing tests**

```ts
// document-models/app-owner-license/v1/tests/lifecycle.test.ts
import { describe, it, expect } from "vitest";
import { utils, actions, reducer } from "document-models/app-owner-license";

const issue = (over: Partial<Record<string, unknown>> = {}) =>
  actions.issueLicense({
    app: "app-1",
    licenseType: "type-1",
    user: "0x1111111111111111111111111111111111111111",
    issuer: "PUBLISHER_GRANT",
    issuedBy: "0x2222222222222222222222222222222222222222",
    stage: null,
    details: null,
    issued: "2026-10-06T00:00:00.000Z",
    start: "2026-10-06T00:00:00.000Z",
    end: "2027-10-06T00:00:00.000Z",
    ...over,
  });

describe("AppOwnerLicense lifecycle", () => {
  it("issues and lowercases the holder address", () => {
    const doc = reducer(utils.createDocument(), issue({
      user: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    }));
    expect(doc.state.global.status).toBe("ISSUED");
    expect(doc.state.global.user).toBe(
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
  });

  it("walks ISSUED to ACTIVE to EXPIRED", () => {
    let doc = reducer(utils.createDocument(), issue());
    doc = reducer(doc, actions.activateLicense({ _: true }));
    expect(doc.state.global.status).toBe("ACTIVE");
    doc = reducer(doc, actions.expireLicense({ _: true }));
    expect(doc.state.global.status).toBe("EXPIRED");
  });

  it("records a revocation reason", () => {
    let doc = reducer(utils.createDocument(), issue());
    doc = reducer(doc, actions.activateLicense({ _: true }));
    doc = reducer(doc, actions.revokeLicense({ reason: "non-payment" }));
    expect(doc.state.global.status).toBe("REVOKED");
    expect(doc.state.global.revokedReason).toBe("non-payment");
  });

  it("refuses to expire a licence that was never activated", () => {
    const doc = reducer(utils.createDocument(), actions.expireLicense({ _: true }));
    expect(doc.operations.global[0].error).toBe(
      "cannot expire a license with status ISSUED",
    );
  });

  it("treats EXPIRED as terminal", () => {
    let doc = reducer(utils.createDocument(), issue());
    doc = reducer(doc, actions.activateLicense({ _: true }));
    doc = reducer(doc, actions.expireLicense({ _: true }));
    doc = reducer(doc, actions.activateLicense({ _: true }));
    expect(doc.operations.global[3].error).toBe(
      "cannot activate a license with status EXPIRED",
    );
    expect(doc.state.global.status).toBe("EXPIRED");
  });

  it("refuses a second issue", () => {
    let doc = reducer(utils.createDocument(), issue());
    doc = reducer(doc, issue());
    expect(doc.operations.global[1].error).toBe("this license is already issued");
  });

  it("refuses an end date before the start date", () => {
    const doc = reducer(utils.createDocument(), issue({
      start: "2027-01-01T00:00:00.000Z",
      end: "2026-01-01T00:00:00.000Z",
    }));
    expect(doc.operations.global[0].error).toBe("end must not precede start");
  });

  it("records the replacement", () => {
    let doc = reducer(utils.createDocument(), issue());
    doc = reducer(doc, actions.activateLicense({ _: true }));
    doc = reducer(doc, actions.replaceLicense({ replacedBy: "lic-2" }));
    expect(doc.state.global.status).toBe("REPLACED");
    expect(doc.state.global.replacedBy).toBe("lic-2");
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run document-models/app-owner-license`
Expected: FAIL.

- [ ] **Step 5: Implement the reducers**

In the MCP action **and** `src/reducers/lifecycle.ts`.

```ts
// document-models/app-owner-license/v1/src/reducers/lifecycle.ts
import type { AppOwnerLicenseLifecycleOperations } from "../../gen/lifecycle/operations.js";

/** Only these moves are legal; everything else is rejected. */
const ALLOWED: Record<string, string[]> = {
  ISSUED: ["ACTIVE", "EXPIRED", "REVOKED"],
  ACTIVE: ["EXPIRED", "REVOKED", "REPLACED"],
  EXPIRED: [],
  REVOKED: [],
  REPLACED: [],
};

function assertTransition(from: string, to: string, verb: string): void {
  if (!ALLOWED[from].includes(to)) {
    throw new InvalidStatusTransitionError(
      `cannot ${verb} a license with status ${from}`,
    );
  }
}

export const reducer: AppOwnerLicenseLifecycleOperations = {
  issueLicenseOperation(state, action) {
    if (state.user) {
      throw new AlreadyIssuedError("this license is already issued");
    }
    if (action.input.end && action.input.end < action.input.start) {
      throw new EndBeforeStartError("end must not precede start");
    }
    state.app = action.input.app;
    state.licenseType = action.input.licenseType;
    state.user = action.input.user.toLowerCase();
    state.issuer = action.input.issuer;
    state.issuedBy = action.input.issuedBy.toLowerCase();
    state.stage = action.input.stage ?? null;
    state.details = action.input.details ?? null;
    state.issued = action.input.issued;
    state.start = action.input.start;
    state.end = action.input.end ?? null;
    state.status = "ISSUED";
  },

  activateLicenseOperation(state) {
    assertTransition(state.status, "ACTIVE", "activate");
    state.status = "ACTIVE";
  },

  expireLicenseOperation(state) {
    assertTransition(state.status, "EXPIRED", "expire");
    state.status = "EXPIRED";
  },

  revokeLicenseOperation(state, action) {
    assertTransition(state.status, "REVOKED", "revoke");
    state.status = "REVOKED";
    state.revokedReason = action.input.reason ?? null;
  },

  replaceLicenseOperation(state, action) {
    assertTransition(state.status, "REPLACED", "replace");
    state.status = "REPLACED";
    state.replacedBy = action.input.replacedBy;
  },
};
```

`ISSUED → EXPIRED` is legal on purpose: it is how Review Focus item 1 is resolved without a pointless activation.

- [ ] **Step 6: Run tests and coverage**

Run: `npm run tsc && npx vitest run document-models/app-owner-license && npm run test:coverage`
Expected: PASS, 95%+ on all four metrics.

- [ ] **Step 7: Register and commit**

```ts
export { AppOwnerLicense as AppOwnerLicenseV1 } from "./app-owner-license/v1/module.js";
```

```bash
git add document-models/app-owner-license document-models/index.ts document-models/document-models.ts document-models/upgrade-manifests.ts powerhouse.manifest.json
git commit -m "feat(licensing): add app-owner-license document model"
```

---

### Task 4: `computeLicenseTransitions`

**Files:**
- Create: `subgraphs/vetra-licensing/transitions.ts`
- Test: `subgraphs/vetra-licensing/__tests__/transitions.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `computeLicenseTransitions(rows: LicenseRow[], nowIso: string): LicenseTransitions` where `LicenseRow = { id: string; status: LicenseStatusName; start: string | null; end: string | null }`, `LicenseTransitions = { toActivate: string[]; toExpire: string[] }`, and `LicenseStatusName = "ISSUED" | "ACTIVE" | "EXPIRED" | "REVOKED" | "REPLACED"`.

- [ ] **Step 1: Write the failing tests**

```ts
// subgraphs/vetra-licensing/__tests__/transitions.test.ts
import { describe, it, expect } from "vitest";
import { computeLicenseTransitions, type LicenseRow } from "../transitions.js";

const NOW = "2026-10-06T12:00:00.000Z";
const row = (over: Partial<LicenseRow>): LicenseRow => ({
  id: "lic-1",
  status: "ISSUED",
  start: "2026-10-01T00:00:00.000Z",
  end: null,
  ...over,
});

describe("computeLicenseTransitions", () => {
  it("activates an issued licence whose start has passed", () => {
    expect(computeLicenseTransitions([row({})], NOW)).toEqual({
      toActivate: ["lic-1"],
      toExpire: [],
    });
  });

  it("leaves an issued licence whose start is in the future", () => {
    const rows = [row({ start: "2027-01-01T00:00:00.000Z" })];
    expect(computeLicenseTransitions(rows, NOW)).toEqual({
      toActivate: [],
      toExpire: [],
    });
  });

  it("expires an active licence whose end has passed", () => {
    const rows = [row({ status: "ACTIVE", end: "2026-10-05T00:00:00.000Z" })];
    expect(computeLicenseTransitions(rows, NOW)).toEqual({
      toActivate: [],
      toExpire: ["lic-1"],
    });
  });

  it("never expires an open-ended active licence", () => {
    const rows = [row({ status: "ACTIVE", end: null })];
    expect(computeLicenseTransitions(rows, NOW)).toEqual({
      toActivate: [],
      toExpire: [],
    });
  });

  // Review Focus 1: end precedes start — never activate, go straight to EXPIRED.
  it("expires an issued licence that is already past its end, without activating it", () => {
    const rows = [row({
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-02-01T00:00:00.000Z",
    })];
    expect(computeLicenseTransitions(rows, NOW)).toEqual({
      toActivate: [],
      toExpire: ["lic-1"],
    });
  });

  it("ignores terminal statuses", () => {
    const rows: LicenseRow[] = [
      row({ id: "a", status: "EXPIRED", end: "2020-01-01T00:00:00.000Z" }),
      row({ id: "b", status: "REVOKED" }),
      row({ id: "c", status: "REPLACED" }),
    ];
    expect(computeLicenseTransitions(rows, NOW)).toEqual({
      toActivate: [],
      toExpire: [],
    });
  });

  it("treats a null start as not yet startable", () => {
    expect(computeLicenseTransitions([row({ start: null })], NOW)).toEqual({
      toActivate: [],
      toExpire: [],
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run subgraphs/vetra-licensing/__tests__/transitions.test.ts`
Expected: FAIL — cannot resolve `../transitions.js`.

- [ ] **Step 3: Implement**

```ts
// subgraphs/vetra-licensing/transitions.ts

export type LicenseStatusName =
  | "ISSUED"
  | "ACTIVE"
  | "EXPIRED"
  | "REVOKED"
  | "REPLACED";

export interface LicenseRow {
  id: string;
  status: LicenseStatusName;
  /** ISO-8601, normalised on write. Lexical comparison is safe for this form. */
  start: string | null;
  end: string | null;
}

export interface LicenseTransitions {
  toActivate: string[];
  toExpire: string[];
}

/**
 * Pure. Given every licence of an app and the current instant, decide which
 * must move. A licence already past its end is expired without first being
 * activated — activating it would provision an environment only to tear it
 * down on the next tick.
 */
export function computeLicenseTransitions(
  rows: LicenseRow[],
  nowIso: string,
): LicenseTransitions {
  const toActivate: string[] = [];
  const toExpire: string[] = [];

  for (const r of rows) {
    const past = r.end !== null && r.end <= nowIso;

    if (r.status === "ISSUED") {
      if (past) {
        toExpire.push(r.id);
      } else if (r.start !== null && r.start <= nowIso) {
        toActivate.push(r.id);
      }
      continue;
    }

    if (r.status === "ACTIVE" && past) {
      toExpire.push(r.id);
    }
  }

  return { toActivate, toExpire };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run subgraphs/vetra-licensing/__tests__/transitions.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add subgraphs/vetra-licensing/transitions.ts subgraphs/vetra-licensing/__tests__/transitions.test.ts
git commit -m "feat(licensing): add pure licence transition planner"
```

---

### Task 5: `LicenseKeeper`

**Files:**
- Create: `subgraphs/vetra-licensing/keeper.ts`
- Create: `subgraphs/vetra-licensing/config.ts`
- Modify: `subgraphs/vetra-licensing/index.ts`
- Test: `subgraphs/vetra-licensing/__tests__/keeper.test.ts`

**Interfaces:**
- Consumes: `computeLicenseTransitions` from Task 4; `ACTIVATE_LICENSE` / `EXPIRE_LICENSE` from Task 3.
- Produces: `class LicenseKeeper { start(): void; stop(): void; reconcileOnce(): Promise<void> }`, constructed with `KeeperDeps = { listLicenses(): Promise<LicenseRow[]>; activate(id: string): Promise<void>; expire(id: string): Promise<void>; now(): string; cfg: LicensingConfig; logger: Pick<Console, "info" | "warn"> }`. Also `loadLicensingConfig(env)`.

- [ ] **Step 1: Write the failing tests**

```ts
// subgraphs/vetra-licensing/__tests__/keeper.test.ts
import { describe, it, expect, vi } from "vitest";
import { LicenseKeeper } from "../keeper.js";
import type { LicenseRow } from "../transitions.js";

const cfg = { enabled: true, dryRun: false, scanIntervalMs: 60_000 };
const rows: LicenseRow[] = [
  { id: "a", status: "ISSUED", start: "2026-01-01T00:00:00.000Z", end: null },
  { id: "b", status: "ACTIVE", start: "2026-01-01T00:00:00.000Z", end: "2026-02-01T00:00:00.000Z" },
];

const deps = (over: Record<string, unknown> = {}) => ({
  listLicenses: vi.fn(async () => rows),
  activate: vi.fn(async () => undefined),
  expire: vi.fn(async () => undefined),
  now: () => "2026-10-06T12:00:00.000Z",
  cfg,
  logger: { info: vi.fn(), warn: vi.fn() },
  ...over,
});

describe("LicenseKeeper", () => {
  it("activates and expires in one pass", async () => {
    const d = deps();
    await new LicenseKeeper(d as never).reconcileOnce();
    expect(d.activate).toHaveBeenCalledWith("a");
    expect(d.expire).toHaveBeenCalledWith("b");
  });

  it("does nothing when disabled", async () => {
    const d = deps({ cfg: { ...cfg, enabled: false } });
    await new LicenseKeeper(d as never).reconcileOnce();
    expect(d.listLicenses).not.toHaveBeenCalled();
  });

  it("logs but does not act in dry run", async () => {
    const d = deps({ cfg: { ...cfg, dryRun: true } });
    await new LicenseKeeper(d as never).reconcileOnce();
    expect(d.activate).not.toHaveBeenCalled();
    expect(d.expire).not.toHaveBeenCalled();
    expect(d.logger.info).toHaveBeenCalled();
  });

  it("keeps going when one transition throws", async () => {
    const d = deps({
      activate: vi.fn(async () => { throw new Error("boom"); }),
    });
    await new LicenseKeeper(d as never).reconcileOnce();
    expect(d.expire).toHaveBeenCalledWith("b");
    expect(d.logger.warn).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run subgraphs/vetra-licensing/__tests__/keeper.test.ts`
Expected: FAIL — cannot resolve `../keeper.js`.

- [ ] **Step 3: Write the config**

```ts
// subgraphs/vetra-licensing/config.ts

export interface LicensingConfig {
  enabled: boolean;
  /** Default-safe: even when enabled, only logs until explicitly turned off. */
  dryRun: boolean;
  scanIntervalMs: number;
  /** Ceiling applied to an app with no row in app_environment_limits. */
  defaultMaxEnvironments: number;
}

export function loadLicensingConfig(
  env: NodeJS.ProcessEnv = process.env,
): LicensingConfig {
  const int = (name: string, fallback: number): number => {
    const v = env[name];
    if (!v) return fallback;
    const n = Number.parseInt(v, 10);
    return Number.isNaN(n) || n <= 0 ? fallback : n;
  };
  return {
    enabled: (env.LICENSING_KEEPER_ENABLED ?? "false").toLowerCase() === "true",
    dryRun: (env.LICENSING_DRY_RUN ?? "true").toLowerCase() !== "false",
    scanIntervalMs: int("LICENSING_SCAN_INTERVAL_MS", 60 * 1000),
    defaultMaxEnvironments: int("LICENSING_DEFAULT_MAX_ENVIRONMENTS", 50),
  };
}
```

- [ ] **Step 4: Write the keeper**

```ts
// subgraphs/vetra-licensing/keeper.ts
import { computeLicenseTransitions, type LicenseRow } from "./transitions.js";
import type { LicensingConfig } from "./config.js";

export interface KeeperDeps {
  listLicenses(): Promise<LicenseRow[]>;
  activate(id: string): Promise<void>;
  expire(id: string): Promise<void>;
  now(): string;
  cfg: LicensingConfig;
  logger: Pick<Console, "info" | "warn">;
}

/**
 * Moves licences through their lifecycle on a timer. Copies HousekeepingKeeper
 * rather than PoolKeeper: the re-entrancy guard matters here because a slow
 * reconcile must not overlap itself.
 */
export class LicenseKeeper {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly d: KeeperDeps) {}

  start(): void {
    if (this.timer) return;
    const tick = () => {
      if (this.running) return;
      this.running = true;
      this.reconcileOnce()
        .catch((err) =>
          this.d.logger.warn(`[licensing] keeper tick failed: ${String(err)}`),
        )
        .finally(() => {
          this.running = false;
        });
    };
    tick();
    this.timer = setInterval(tick, this.d.cfg.scanIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async reconcileOnce(): Promise<void> {
    if (!this.d.cfg.enabled) return;

    const rows = await this.d.listLicenses();
    const plan = computeLicenseTransitions(rows, this.d.now());

    if (this.d.cfg.dryRun) {
      this.d.logger.info(
        `[licensing] dry run: would activate ${plan.toActivate.length}, expire ${plan.toExpire.length}`,
      );
      return;
    }

    for (const id of plan.toActivate) {
      try {
        await this.d.activate(id);
      } catch (err) {
        this.d.logger.warn(`[licensing] activate ${id} failed: ${String(err)}`);
      }
    }
    for (const id of plan.toExpire) {
      try {
        await this.d.expire(id);
      } catch (err) {
        this.d.logger.warn(`[licensing] expire ${id} failed: ${String(err)}`);
      }
    }
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run subgraphs/vetra-licensing/__tests__/keeper.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Start and stop the keeper from the subgraph**

In `subgraphs/vetra-licensing/index.ts`, add a `private keeper: LicenseKeeper | null = null;` field, construct and `start()` it at the end of `onSetup()` when `cfg.enabled`, and add:

```ts
  async onDisconnect() {
    this.keeper?.stop();
    this.keeper = null;
  }
```

- [ ] **Step 7: Verify and commit**

Run: `npm run tsc && npm run lint:fix`

```bash
git add subgraphs/vetra-licensing
git commit -m "feat(licensing): add LicenseKeeper lifecycle clock"
```

---

### Task 6: Template rendering and hashing

**Files:**
- Create: `subgraphs/vetra-licensing/template.ts`
- Test: `subgraphs/vetra-licensing/__tests__/template.test.ts`

**Interfaces:**
- Consumes: action creators from `document-models/vetra-cloud-environment`.
- Produces: `renderTemplateActions(input: RenderInput): Action[]` and `templateHash(t: TemplateShape): string`, where
  `TemplateShape = { services: { id: string; type: "CONNECT" | "SWITCHBOARD" | "CLINT"; prefix: string | null }[]; packages: { id: string; packageName: string | null; version: string | null }[]; size: string | null; baseDomain: string | null; packageRegistry: string | null }`
  and `RenderInput = { label: string; subdomain: string; owner: string; template: TemplateShape }`.

- [ ] **Step 1: Write the failing tests**

```ts
// subgraphs/vetra-licensing/__tests__/template.test.ts
import { describe, it, expect } from "vitest";
import { renderTemplateActions, templateHash, type TemplateShape } from "../template.js";

const template: TemplateShape = {
  services: [
    { id: "s1", type: "CONNECT", prefix: "connect" },
    { id: "s2", type: "SWITCHBOARD", prefix: "switchboard" },
  ],
  packages: [{ id: "p1", packageName: "@powerhousedao/knowledge", version: "1.0.0" }],
  size: "VETRA_AGENT_XXL",
  baseDomain: "vetra.io",
  packageRegistry: "https://registry.example.com",
};

describe("renderTemplateActions", () => {
  it("emits initialize, owner, packages, services and approval in order", () => {
    const actions = renderTemplateActions({
      label: "Acme vault",
      subdomain: "acme-vault",
      owner: "0x1111111111111111111111111111111111111111",
      template,
    });
    expect(actions.map((a) => a.type)).toEqual([
      "SET_LABEL",
      "INITIALIZE",
      "SET_OWNER",
      "ADD_PACKAGE",
      "ENABLE_SERVICE",
      "ENABLE_SERVICE",
      "APPROVE_CHANGES",
    ]);
  });

  it("renders a browser-only template with no switchboard", () => {
    const actions = renderTemplateActions({
      label: "Browser vault",
      subdomain: "browser-vault",
      owner: "0x1111111111111111111111111111111111111111",
      template: { ...template, services: [{ id: "s1", type: "CONNECT", prefix: "connect" }], size: null },
    });
    expect(actions.filter((a) => a.type === "ENABLE_SERVICE")).toHaveLength(1);
  });
});

describe("templateHash", () => {
  it("is stable across key order", () => {
    const reordered: TemplateShape = {
      packages: template.packages,
      baseDomain: template.baseDomain,
      services: template.services,
      packageRegistry: template.packageRegistry,
      size: template.size,
    };
    expect(templateHash(reordered)).toBe(templateHash(template));
  });

  it("changes when the size changes", () => {
    expect(templateHash({ ...template, size: "VETRA_AGENT_S" })).not.toBe(
      templateHash(template),
    );
  });

  it("changes when a service is added", () => {
    const more: TemplateShape = {
      ...template,
      services: [...template.services, { id: "s3", type: "CLINT", prefix: "agent" }],
    };
    expect(templateHash(more)).not.toBe(templateHash(template));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run subgraphs/vetra-licensing/__tests__/template.test.ts`
Expected: FAIL — cannot resolve `../template.js`.

- [ ] **Step 3: Implement**

```ts
// subgraphs/vetra-licensing/template.ts
import { createHash } from "node:crypto";
import type { Action } from "document-model";
import {
  setLabel,
  initialize,
  setOwner,
  addPackage,
  enableService,
  approveChanges,
} from "document-models/vetra-cloud-environment";

export interface TemplateService {
  id: string;
  type: "CONNECT" | "SWITCHBOARD" | "CLINT";
  prefix: string | null;
}

export interface TemplatePackage {
  id: string;
  packageName: string | null;
  version: string | null;
}

export interface TemplateShape {
  services: TemplateService[];
  packages: TemplatePackage[];
  size: string | null;
  baseDomain: string | null;
  packageRegistry: string | null;
}

export interface RenderInput {
  label: string;
  subdomain: string;
  owner: string;
  template: TemplateShape;
}

const DEFAULT_BASE_DOMAIN = "vetra.io";

/**
 * Turn a template into the action list that already builds every environment
 * in this repo (see subgraphs/vetra-apps/service.ts:589-601). Order matters:
 * initialize before owner, packages before services, approval last.
 */
export function renderTemplateActions(input: RenderInput): Action[] {
  const t = input.template;
  const actions: Action[] = [
    setLabel({ label: input.label }),
    initialize({
      genericSubdomain: input.subdomain,
      genericBaseDomain: t.baseDomain ?? DEFAULT_BASE_DOMAIN,
      defaultPackageRegistry: t.packageRegistry ?? undefined,
    }),
    setOwner({ address: input.owner }),
  ];

  for (const p of t.packages) {
    if (!p.packageName) continue;
    actions.push(
      addPackage({ packageName: p.packageName, version: p.version ?? undefined }),
    );
  }

  for (const s of t.services) {
    actions.push(
      enableService({
        type: s.type,
        prefix: s.prefix ?? s.type.toLowerCase(),
        ...(s.type === "CLINT" && t.size
          ? { selectedRessource: t.size as never }
          : {}),
      } as never),
    );
  }

  actions.push(approveChanges({}));
  return actions;
}

/**
 * sha256 over a canonical form. Used to recognise an environment whose
 * template has changed since it was provisioned; never for security.
 */
export function templateHash(t: TemplateShape): string {
  const canonical = JSON.stringify({
    baseDomain: t.baseDomain ?? null,
    packageRegistry: t.packageRegistry ?? null,
    size: t.size ?? null,
    packages: [...t.packages]
      .map((p) => ({ n: p.packageName ?? null, v: p.version ?? null }))
      .sort((a, b) => (a.n ?? "").localeCompare(b.n ?? "")),
    services: [...t.services]
      .map((s) => ({ t: s.type, p: s.prefix ?? null }))
      .sort((a, b) => a.t.localeCompare(b.t)),
  });
  return createHash("sha256").update(canonical).digest("hex");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run subgraphs/vetra-licensing/__tests__/template.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add subgraphs/vetra-licensing/template.ts subgraphs/vetra-licensing/__tests__/template.test.ts
git commit -m "feat(licensing): render environment templates into action lists"
```

---

### Task 7: `applyEnvironmentTemplate`

**Files:**
- Create: `subgraphs/vetra-licensing/provision.ts`
- Test: `subgraphs/vetra-licensing/__tests__/provision.test.ts`

**Interfaces:**
- Consumes: `renderTemplateActions`, `templateHash` (Task 6); `EnvGateway` from `subgraphs/vetra-apps/envs.js`; `VetraLicensingDB` (Task 1).
- Produces: `applyEnvironmentTemplate(deps: ProvisionDeps, input: ApplyInput): Promise<AppUserEnvironmentRow>` where `ApplyInput = { appId: string; user: string; licenseId: string; template: TemplateShape | null; label: string; now: string }`. Throws `LicenseTypeUnavailableError`, `AppEnvironmentCapReachedError`.

- [ ] **Step 1: Write the failing tests**

```ts
// subgraphs/vetra-licensing/__tests__/provision.test.ts
import { describe, it, expect, vi } from "vitest";
import {
  applyEnvironmentTemplate,
  AppEnvironmentCapReachedError,
  LicenseTypeUnavailableError,
} from "../provision.js";
import type { TemplateShape } from "../template.js";

const template: TemplateShape = {
  services: [{ id: "s1", type: "CONNECT", prefix: "connect" }],
  packages: [],
  size: null,
  baseDomain: "vetra.io",
  packageRegistry: null,
};

const base = (over: Record<string, unknown> = {}) => ({
  findRow: vi.fn(async () => null),
  countForApp: vi.fn(async () => 0),
  maxForApp: vi.fn(async () => 50),
  upsertRow: vi.fn(async (row: unknown) => row),
  envs: {
    create: vi.fn(async () => "env-1"),
    execute: vi.fn(async () => undefined),
  },
  generateSubdomain: (id: string) => `sub-${id}`,
  ...over,
});

const input = {
  appId: "app-1",
  user: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  licenseId: "lic-1",
  template,
  label: "Acme vault",
  now: "2026-10-06T12:00:00.000Z",
};

describe("applyEnvironmentTemplate", () => {
  it("creates an environment when none exists", async () => {
    const d = base();
    const row = await applyEnvironmentTemplate(d as never, input);
    expect(d.envs.create).toHaveBeenCalledOnce();
    expect(row.environment_id).toBe("env-1");
    expect(row.user_address).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("creates nothing on a second identical call", async () => {
    const existing = {
      app_id: "app-1",
      user_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      environment_id: "env-1",
      license_id: "lic-1",
      template_hash: "",
      created_at: input.now,
      updated_at: input.now,
    };
    const d = base({ findRow: vi.fn(async () => ({ ...existing, template_hash: hashOf(template) })) });
    await applyEnvironmentTemplate(d as never, input);
    expect(d.envs.create).not.toHaveBeenCalled();
    expect(d.envs.execute).not.toHaveBeenCalled();
  });

  // Review Focus 4: two concurrent first-time calls must yield one environment.
  it("yields one environment when two calls race", async () => {
    let created = 0;
    const d = base({ envs: { create: vi.fn(async () => `env-${++created}`), execute: vi.fn(async () => undefined) } });
    await Promise.all([
      applyEnvironmentTemplate(d as never, input),
      applyEnvironmentTemplate(d as never, input),
    ]);
    expect(d.upsertRow).toHaveBeenCalledTimes(2);
    const ids = d.upsertRow.mock.calls.map((c: any[]) => c[0].environment_id);
    expect(new Set(ids).size).toBe(1);
  });

  // Review Focus 3: a retired or missing licence type has no template.
  it("refuses when the template is unavailable", async () => {
    const d = base();
    await expect(
      applyEnvironmentTemplate(d as never, { ...input, template: null }),
    ).rejects.toBeInstanceOf(LicenseTypeUnavailableError);
    expect(d.envs.create).not.toHaveBeenCalled();
  });

  it("refuses a new environment at the cap", async () => {
    const d = base({ countForApp: vi.fn(async () => 50), maxForApp: vi.fn(async () => 50) });
    await expect(
      applyEnvironmentTemplate(d as never, input),
    ).rejects.toBeInstanceOf(AppEnvironmentCapReachedError);
  });

  it("still updates an existing environment at the cap", async () => {
    const d = base({
      countForApp: vi.fn(async () => 50),
      maxForApp: vi.fn(async () => 50),
      findRow: vi.fn(async () => ({
        app_id: "app-1",
        user_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        environment_id: "env-1",
        license_id: "lic-1",
        template_hash: "stale",
        created_at: input.now,
        updated_at: input.now,
      })),
    });
    await applyEnvironmentTemplate(d as never, input);
    expect(d.envs.execute).toHaveBeenCalled();
    expect(d.envs.create).not.toHaveBeenCalled();
  });
});
```

Add at the top of the test file:

```ts
import { templateHash as hashOf } from "../template.js";
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run subgraphs/vetra-licensing/__tests__/provision.test.ts`
Expected: FAIL — cannot resolve `../provision.js`.

- [ ] **Step 3: Implement**

```ts
// subgraphs/vetra-licensing/provision.ts
import type { Action } from "document-model";
import { renderTemplateActions, templateHash, type TemplateShape } from "./template.js";
import type { AppUserEnvironments } from "./db/schema.js";

export class LicenseTypeUnavailableError extends Error {}
export class AppEnvironmentCapReachedError extends Error {}

export interface ProvisionDeps {
  findRow(appId: string, user: string): Promise<AppUserEnvironments | null>;
  countForApp(appId: string): Promise<number>;
  maxForApp(appId: string): Promise<number>;
  upsertRow(row: AppUserEnvironments): Promise<AppUserEnvironments>;
  envs: {
    create(): Promise<string>;
    execute(environmentId: string, actions: Action[]): Promise<unknown>;
  };
  generateSubdomain(environmentId: string): string;
}

export interface ApplyInput {
  appId: string;
  user: string;
  licenseId: string;
  /** null when the licence type is missing or RETIRED. */
  template: TemplateShape | null;
  label: string;
  now: string;
}

/**
 * Ensure exactly one environment exists for (appId, user), matching the
 * template. Idempotent: called twice with the same arguments the second call
 * does nothing. This is what lets the publisher's handler call it every tick
 * without guarding anything.
 */
export async function applyEnvironmentTemplate(
  deps: ProvisionDeps,
  input: ApplyInput,
): Promise<AppUserEnvironments> {
  if (!input.template) {
    throw new LicenseTypeUnavailableError(
      `license ${input.licenseId} has no usable template; leaving any existing environment alone`,
    );
  }

  const user = input.user.toLowerCase();
  const wanted = templateHash(input.template);
  const existing = await deps.findRow(input.appId, user);

  if (existing && existing.template_hash === wanted) {
    return existing;
  }

  if (!existing) {
    const [count, max] = await Promise.all([
      deps.countForApp(input.appId),
      deps.maxForApp(input.appId),
    ]);
    if (count >= max) {
      throw new AppEnvironmentCapReachedError(
        `app ${input.appId} is at its ceiling of ${max} environments`,
      );
    }
  }

  const environmentId = existing?.environment_id ?? (await deps.envs.create());

  await deps.envs.execute(
    environmentId,
    renderTemplateActions({
      label: input.label,
      subdomain: deps.generateSubdomain(environmentId),
      owner: user,
      template: input.template,
    }),
  );

  return deps.upsertRow({
    app_id: input.appId,
    user_address: user,
    environment_id: environmentId,
    license_id: input.licenseId,
    template_hash: wanted,
    created_at: existing?.created_at ?? input.now,
    updated_at: input.now,
  });
}
```

The race in Review Focus 4 is closed at the database, not here: `upsertRow` writes with
`onConflict(["app_id", "user_address"]).doUpdateSet(...)` and then **re-reads** the row, so
the loser of a race adopts the winner's `environment_id`. Implement `upsertRow` in
`resolvers.ts` (Task 8) as:

```ts
async function upsertRow(row: AppUserEnvironments) {
  await db
    .insertInto("app_user_environments")
    .values(row)
    .onConflict((oc) =>
      oc.columns(["app_id", "user_address"]).doUpdateSet({
        license_id: row.license_id,
        template_hash: row.template_hash,
        updated_at: row.updated_at,
      }),
    )
    .execute();
  const fresh = await db
    .selectFrom("app_user_environments")
    .selectAll()
    .where("app_id", "=", row.app_id)
    .where("user_address", "=", row.user_address)
    .executeTakeFirstOrThrow();
  return fresh;
}
```

Note the conflict clause deliberately does **not** overwrite `environment_id`: the first
writer's environment is the one that survives.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run subgraphs/vetra-licensing/__tests__/provision.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add subgraphs/vetra-licensing/provision.ts subgraphs/vetra-licensing/__tests__/provision.test.ts
git commit -m "feat(licensing): add idempotent applyEnvironmentTemplate with per-app cap"
```

---

### Task 8: GraphQL surface and App-identity authorization

**Files:**
- Modify: `subgraphs/vetra-licensing/schema.ts`
- Modify: `subgraphs/vetra-licensing/resolvers.ts`
- Modify: `subgraphs/vetra-licensing/index.ts`
- Create: `subgraphs/vetra-licensing/auth.ts`
- Create: `subgraphs/vetra-licensing/release.ts`
- Test: `subgraphs/vetra-licensing/__tests__/auth.test.ts`
- Test: `subgraphs/vetra-licensing/__tests__/release.test.ts`

**Interfaces:**
- Consumes: `applyEnvironmentTemplate` (Task 7); the `apps` table from `subgraphs/vetra-apps/db/schema.js`.
- Produces: `resolveCallerApp(deps, ctx): Promise<{ appId: string }>`, throwing `UnauthenticatedError`, `UnknownAppIdentityError`, `AppIdentityInactiveError`. GraphQL mutations `applyEnvironmentTemplate`, `releaseEnvironment`; queries `appLicenses`, `appLicenseTypes`, `appUserEnvironments`.

- [ ] **Step 1: Write the failing tests**

```ts
// subgraphs/vetra-licensing/__tests__/auth.test.ts
import { describe, it, expect, vi } from "vitest";
import {
  resolveCallerApp,
  UnauthenticatedError,
  UnknownAppIdentityError,
  AppIdentityInactiveError,
} from "../auth.js";

const ctx = (address?: string) =>
  address
    ? { user: { address, networkId: "eip155", chainId: 1 } }
    : {};

const deps = (app: unknown) => ({ findAppByIdentityDid: vi.fn(async () => app) });

describe("resolveCallerApp", () => {
  it("resolves an active app from the caller DID", async () => {
    const d = deps({ id: "app-1", status: "ACTIVE" });
    await expect(resolveCallerApp(d as never, ctx("0xAbC") as never)).resolves.toEqual({
      appId: "app-1",
    });
    expect(d.findAppByIdentityDid).toHaveBeenCalledWith("did:pkh:eip155:1:0xabc");
  });

  it("rejects an unauthenticated caller", async () => {
    await expect(
      resolveCallerApp(deps(null) as never, ctx() as never),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it("rejects a DID that matches no app", async () => {
    await expect(
      resolveCallerApp(deps(null) as never, ctx("0xAbC") as never),
    ).rejects.toBeInstanceOf(UnknownAppIdentityError);
  });

  // Review Focus 5: an expired delegation must fail closed.
  it("rejects an app whose identity has lapsed", async () => {
    const d = deps({ id: "app-1", status: "PENDING_IDENTITY" });
    await expect(
      resolveCallerApp(d as never, ctx("0xAbC") as never),
    ).rejects.toBeInstanceOf(AppIdentityInactiveError);
  });

  it("rejects a disconnected app", async () => {
    const d = deps({ id: "app-1", status: "DISCONNECTED" });
    await expect(
      resolveCallerApp(d as never, ctx("0xAbC") as never),
    ).rejects.toBeInstanceOf(AppIdentityInactiveError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run subgraphs/vetra-licensing/__tests__/auth.test.ts`
Expected: FAIL — cannot resolve `../auth.js`.

- [ ] **Step 3: Implement**

```ts
// subgraphs/vetra-licensing/auth.ts

export class UnauthenticatedError extends Error {}
export class UnknownAppIdentityError extends Error {}
export class AppIdentityInactiveError extends Error {}

export interface AuthContext {
  user?: { address: string; networkId: string; chainId: number };
}

export interface AppRecord {
  id: string;
  status: string;
}

export interface AuthDeps {
  findAppByIdentityDid(did: string): Promise<AppRecord | null>;
}

/**
 * The caller is an App identity, never a person. The app id is taken from the
 * delegation, never from an argument, so no app can name another app's id.
 */
export async function resolveCallerApp(
  deps: AuthDeps,
  ctx: AuthContext,
): Promise<{ appId: string }> {
  const u = ctx.user;
  if (!u) {
    throw new UnauthenticatedError("a license call must carry an app identity");
  }

  const did = `did:pkh:${u.networkId}:${u.chainId}:${u.address.toLowerCase()}`;
  const app = await deps.findAppByIdentityDid(did);
  if (!app) {
    throw new UnknownAppIdentityError(`no app is registered for ${did}`);
  }
  if (app.status !== "ACTIVE") {
    throw new AppIdentityInactiveError(
      `app ${app.id} is ${app.status}; its identity delegation must be renewed`,
    );
  }

  return { appId: app.id };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run subgraphs/vetra-licensing/__tests__/auth.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Extend the GraphQL schema**

Replace the placeholder block in `schema.ts`:

```graphql
  input ApplyEnvironmentTemplateInput {
    licenseId: String!
    label: String!
  }

  input ReleaseEnvironmentInput {
    environmentId: String!
  }

  type VetraLicensingQueries {
    appLicenses(status: String): [AppLicense!]!
    appLicenseTypes: [AppLicenseTypeSummary!]!
    appUserEnvironments: [AppUserEnvironment!]!
  }

  type VetraLicensingMutations {
    applyEnvironmentTemplate(
      input: ApplyEnvironmentTemplateInput!
    ): AppUserEnvironment!
    releaseEnvironment(input: ReleaseEnvironmentInput!): Boolean!
  }

  type AppLicense {
    id: String!
    user: String!
    licenseTypeId: String!
    status: String!
    start: String
    end: String
  }

  type AppLicenseTypeSummary {
    id: String!
    kind: String!
    status: String!
    templateHash: String!
  }

  type Query {
    vetraLicensing: VetraLicensingQueries!
  }

  type Mutation {
    vetraLicensing: VetraLicensingMutations!
  }
```

Note no resolver takes an `appId` argument — it always comes from `resolveCallerApp`.

- [ ] **Step 6: Write the failing release test**

```ts
// subgraphs/vetra-licensing/__tests__/release.test.ts
import { describe, it, expect, vi } from "vitest";
import { releaseEnvironment } from "../release.js";

const deps = (over: Record<string, unknown> = {}) => ({
  findRowByEnvironment: vi.fn(async () => ({
    app_id: "app-1",
    user_address: "0xaaa",
    environment_id: "env-1",
  })),
  stopEnvironment: vi.fn(async () => undefined),
  deleteRow: vi.fn(async () => undefined),
  ...over,
});

describe("releaseEnvironment", () => {
  it("stops the environment and drops its row", async () => {
    const d = deps();
    await expect(releaseEnvironment(d as never, "app-1", "env-1")).resolves.toBe(true);
    expect(d.stopEnvironment).toHaveBeenCalledWith("env-1");
    expect(d.deleteRow).toHaveBeenCalledWith("app-1", "0xaaa");
  });

  it("never destroys the document", async () => {
    const d = deps() as Record<string, unknown>;
    await releaseEnvironment(d as never, "app-1", "env-1");
    expect(d).not.toHaveProperty("deleteEnvironment");
  });

  it("is a no-op when the row is already gone", async () => {
    const d = deps({ findRowByEnvironment: vi.fn(async () => null) });
    await expect(releaseEnvironment(d as never, "app-1", "env-1")).resolves.toBe(false);
    expect(d.stopEnvironment).not.toHaveBeenCalled();
  });

  it("refuses an environment belonging to another app", async () => {
    const d = deps();
    await expect(releaseEnvironment(d as never, "app-2", "env-1")).resolves.toBe(false);
    expect(d.stopEnvironment).not.toHaveBeenCalled();
  });
});
```

Run: `npx vitest run subgraphs/vetra-licensing/__tests__/release.test.ts`
Expected: FAIL — cannot resolve `../release.js`.

- [ ] **Step 7: Implement release**

```ts
// subgraphs/vetra-licensing/release.ts
import type { AppUserEnvironments } from "./db/schema.js";

export interface ReleaseDeps {
  findRowByEnvironment(environmentId: string): Promise<AppUserEnvironments | null>;
  /** Drives the environment document to STOPPED. Never destroys it. */
  stopEnvironment(environmentId: string): Promise<void>;
  deleteRow(appId: string, user: string): Promise<void>;
}

/**
 * Stop an environment and forget the mapping. Archival and destruction stay
 * with the existing housekeeping ladder — nothing here deletes a document.
 * Returns false when there is nothing to do, so the handler can call it freely.
 */
export async function releaseEnvironment(
  deps: ReleaseDeps,
  callerAppId: string,
  environmentId: string,
): Promise<boolean> {
  const row = await deps.findRowByEnvironment(environmentId);
  if (!row || row.app_id !== callerAppId) return false;

  await deps.stopEnvironment(environmentId);
  await deps.deleteRow(row.app_id, row.user_address);
  return true;
}
```

Run: `npx vitest run subgraphs/vetra-licensing/__tests__/release.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 8: Wire the resolvers**

Every field resolves the caller first and never reads an app id from arguments.

```ts
// subgraphs/vetra-licensing/resolvers.ts
import type { Kysely } from "kysely";
import type { VetraLicensingDB, AppUserEnvironments } from "./db/schema.js";
import { resolveCallerApp, type AuthContext, type AuthDeps } from "./auth.js";
import { applyEnvironmentTemplate, type ProvisionDeps } from "./provision.js";
import { releaseEnvironment, type ReleaseDeps } from "./release.js";
import type { LicensingConfig } from "./config.js";

export interface ResolverDeps {
  auth: AuthDeps;
  provision: Omit<ProvisionDeps, "findRow" | "countForApp" | "maxForApp" | "upsertRow">;
  release: ReleaseDeps;
  cfg: LicensingConfig;
  /** Reads licence and licence-type documents for one app. */
  read: {
    licenses(appId: string, status: string | null): Promise<
      {
        id: string;
        user: string;
        licenseTypeId: string;
        status: string;
        start: string | null;
        end: string | null;
      }[]
    >;
    licenseTypes(appId: string): Promise<
      { id: string; kind: string; status: string; templateHash: string }[]
    >;
    templateFor(licenseId: string): Promise<
      import("./template.js").TemplateShape | null
    >;
  };
}

export function createResolvers(
  db: Kysely<VetraLicensingDB>,
  deps: ResolverDeps,
): Record<string, unknown> {
  const findRow = (appId: string, user: string) =>
    db
      .selectFrom("app_user_environments")
      .selectAll()
      .where("app_id", "=", appId)
      .where("user_address", "=", user)
      .executeTakeFirst()
      .then((r) => r ?? null);

  const countForApp = (appId: string) =>
    db
      .selectFrom("app_user_environments")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("app_id", "=", appId)
      .executeTakeFirstOrThrow()
      .then((r) => Number(r.n));

  const maxForApp = (appId: string) =>
    db
      .selectFrom("app_environment_limits")
      .select("max_environments")
      .where("app_id", "=", appId)
      .executeTakeFirst()
      .then((r) => r?.max_environments ?? deps.cfg.defaultMaxEnvironments);

  // See Task 7: the conflict clause deliberately leaves environment_id alone,
  // so the loser of a race adopts the winner's environment.
  const upsertRow = async (row: AppUserEnvironments) => {
    await db
      .insertInto("app_user_environments")
      .values(row)
      .onConflict((oc) =>
        oc.columns(["app_id", "user_address"]).doUpdateSet({
          license_id: row.license_id,
          template_hash: row.template_hash,
          updated_at: row.updated_at,
        }),
      )
      .execute();
    return db
      .selectFrom("app_user_environments")
      .selectAll()
      .where("app_id", "=", row.app_id)
      .where("user_address", "=", row.user_address)
      .executeTakeFirstOrThrow();
  };

  return {
    Query: { vetraLicensing: () => ({}) },
    Mutation: { vetraLicensing: () => ({}) },

    VetraLicensingQueries: {
      appLicenses: async (
        _p: unknown,
        args: { status?: string | null },
        ctx: AuthContext,
      ) => {
        const { appId } = await resolveCallerApp(deps.auth, ctx);
        return deps.read.licenses(appId, args.status ?? null);
      },
      appLicenseTypes: async (_p: unknown, _a: unknown, ctx: AuthContext) => {
        const { appId } = await resolveCallerApp(deps.auth, ctx);
        return deps.read.licenseTypes(appId);
      },
      appUserEnvironments: async (_p: unknown, _a: unknown, ctx: AuthContext) => {
        const { appId } = await resolveCallerApp(deps.auth, ctx);
        const rows = await db
          .selectFrom("app_user_environments")
          .selectAll()
          .where("app_id", "=", appId)
          .execute();
        return rows.map((r) => ({
          appId: r.app_id,
          user: r.user_address,
          environmentId: r.environment_id,
          licenseId: r.license_id,
          templateHash: r.template_hash,
        }));
      },
    },

    VetraLicensingMutations: {
      applyEnvironmentTemplate: async (
        _p: unknown,
        args: { input: { licenseId: string; label: string } },
        ctx: AuthContext,
      ) => {
        const { appId } = await resolveCallerApp(deps.auth, ctx);
        const licenses = await deps.read.licenses(appId, "ACTIVE");
        const licence = licenses.find((l) => l.id === args.input.licenseId);
        if (!licence) {
          throw new Error(
            `license ${args.input.licenseId} is not an active license of app ${appId}`,
          );
        }
        const row = await applyEnvironmentTemplate(
          { ...deps.provision, findRow, countForApp, maxForApp, upsertRow },
          {
            appId,
            user: licence.user,
            licenseId: licence.id,
            template: await deps.read.templateFor(licence.id),
            label: args.input.label,
            now: new Date().toISOString(),
          },
        );
        return {
          appId: row.app_id,
          user: row.user_address,
          environmentId: row.environment_id,
          licenseId: row.license_id,
          templateHash: row.template_hash,
        };
      },

      releaseEnvironment: async (
        _p: unknown,
        args: { input: { environmentId: string } },
        ctx: AuthContext,
      ) => {
        const { appId } = await resolveCallerApp(deps.auth, ctx);
        return releaseEnvironment(deps.release, appId, args.input.environmentId);
      },
    },
  };
}
```

Update `index.ts` to build `ResolverDeps` and pass them to `createResolvers`.

- [ ] **Step 9: Verify and commit**

Run: `npm run tsc && npm run lint:fix && npx vitest run subgraphs/vetra-licensing`

```bash
git add subgraphs/vetra-licensing
git commit -m "feat(licensing): add GraphQL surface scoped to the calling app identity"
```

---

### Task 9: `computeLicensePlan`

**Files:**
- Create: `subgraphs/vetra-licensing/plan.ts`
- Test: `subgraphs/vetra-licensing/__tests__/plan.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `computeLicensePlan(licenses: ActiveLicense[], environments: UserEnvironment[]): LicensePlan` where `ActiveLicense = { licenseId: string; user: string; licenseTypeId: string; templateHash: string }`, `UserEnvironment = { user: string; environmentId: string; templateHash: string }`, `LicensePlan = { toApply: ActiveLicense[]; toRelease: string[] }`. This is the function the generated handler calls, so its shape is the publisher-facing contract.

- [ ] **Step 1: Write the failing tests**

```ts
// subgraphs/vetra-licensing/__tests__/plan.test.ts
import { describe, it, expect } from "vitest";
import { computeLicensePlan, type ActiveLicense, type UserEnvironment } from "../plan.js";

const lic = (over: Partial<ActiveLicense> = {}): ActiveLicense => ({
  licenseId: "lic-1",
  user: "0xaaa",
  licenseTypeId: "type-1",
  templateHash: "hash-1",
  ...over,
});

const env = (over: Partial<UserEnvironment> = {}): UserEnvironment => ({
  user: "0xaaa",
  environmentId: "env-1",
  templateHash: "hash-1",
  ...over,
});

describe("computeLicensePlan", () => {
  it("applies a licence with no environment", () => {
    expect(computeLicensePlan([lic()], [])).toEqual({
      toApply: [lic()],
      toRelease: [],
    });
  });

  it("does nothing when the environment already matches", () => {
    expect(computeLicensePlan([lic()], [env()])).toEqual({
      toApply: [],
      toRelease: [],
    });
  });

  it("re-applies when the template has changed", () => {
    const plan = computeLicensePlan([lic({ templateHash: "hash-2" })], [env()]);
    expect(plan.toApply).toHaveLength(1);
    expect(plan.toRelease).toEqual([]);
  });

  it("releases an environment with no licence behind it", () => {
    expect(computeLicensePlan([], [env()])).toEqual({
      toApply: [],
      toRelease: ["env-1"],
    });
  });

  // Review Focus 2: a user holding two active licences must resolve deterministically.
  it("picks the same licence regardless of input order", () => {
    const a = lic({ licenseId: "lic-a", templateHash: "hash-a" });
    const b = lic({ licenseId: "lic-b", templateHash: "hash-b" });
    const forwards = computeLicensePlan([a, b], []);
    const backwards = computeLicensePlan([b, a], []);
    expect(forwards).toEqual(backwards);
    expect(forwards.toApply).toHaveLength(1);
    expect(forwards.toApply[0].licenseId).toBe("lic-a");
  });

  it("keeps users independent", () => {
    const plan = computeLicensePlan(
      [lic({ user: "0xaaa" })],
      [env({ user: "0xbbb", environmentId: "env-2" })],
    );
    expect(plan.toApply).toHaveLength(1);
    expect(plan.toRelease).toEqual(["env-2"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run subgraphs/vetra-licensing/__tests__/plan.test.ts`
Expected: FAIL — cannot resolve `../plan.js`.

- [ ] **Step 3: Implement**

```ts
// subgraphs/vetra-licensing/plan.ts

export interface ActiveLicense {
  licenseId: string;
  user: string;
  licenseTypeId: string;
  templateHash: string;
}

export interface UserEnvironment {
  user: string;
  environmentId: string;
  templateHash: string;
}

export interface LicensePlan {
  toApply: ActiveLicense[];
  toRelease: string[];
}

/**
 * Pure. Desired state from licences, actual state from environments, diffed.
 *
 * A user may hold more than one active licence (spec open question 1). Until a
 * real precedence rule is decided, the lowest licence id wins — chosen because
 * it is stable: the same input produces the same plan on every tick, whatever
 * order the rows arrive in.
 */
export function computeLicensePlan(
  licenses: ActiveLicense[],
  environments: UserEnvironment[],
): LicensePlan {
  const desired = new Map<string, ActiveLicense>();
  for (const l of licenses) {
    const held = desired.get(l.user);
    if (!held || l.licenseId < held.licenseId) {
      desired.set(l.user, l);
    }
  }

  const actual = new Map(environments.map((e) => [e.user, e]));

  const toApply = [...desired.values()].filter((l) => {
    const env = actual.get(l.user);
    return !env || env.templateHash !== l.templateHash;
  });

  const toRelease = environments
    .filter((e) => !desired.has(e.user))
    .map((e) => e.environmentId);

  return { toApply, toRelease };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run subgraphs/vetra-licensing/__tests__/plan.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add subgraphs/vetra-licensing/plan.ts subgraphs/vetra-licensing/__tests__/plan.test.ts
git commit -m "feat(licensing): add deterministic licence-to-environment planner"
```

---

### Task 10: `PublisherGrantIssuer` and the reference handler

**Files:**
- Create: `subgraphs/vetra-licensing/issuers/publisher-grant.ts`
- Create: `subgraphs/vetra-licensing/reference-handler/handler.ts`
- Test: `subgraphs/vetra-licensing/__tests__/publisher-grant.test.ts`
- Test: `subgraphs/vetra-licensing/__tests__/reference-handler.test.ts`

**Interfaces:**
- Consumes: `computeLicensePlan` (Task 9); the GraphQL surface (Task 8); `ISSUE_LICENSE` (Task 3).
- Produces: `issuePublisherGrant(deps, input): Promise<string>` returning the new licence document id. `LicenseHandler` class with `reconcileOnce()`. The handler file is the exact text the codegen generator will later emit — keep it dependency-light and readable.

- [ ] **Step 1: Write the failing issuer test**

```ts
// subgraphs/vetra-licensing/__tests__/publisher-grant.test.ts
import { describe, it, expect, vi } from "vitest";
import { issuePublisherGrant, NotOnAllowListError } from "../issuers/publisher-grant.js";

const deps = (allow: string[], validityDays: number | null = 365) => ({
  isOnAllowList: vi.fn(async (_app: string, addr: string) => allow.includes(addr)),
  getLicenseType: vi.fn(async () => ({
    id: "type-1",
    app: "app-1",
    status: "ACTIVE",
    validityDays,
  })),
  createLicenseDocument: vi.fn(async () => "lic-1"),
  execute: vi.fn(async () => undefined),
});

const input = {
  appId: "app-1",
  licenseTypeId: "type-1",
  user: "0xAAA",
  issuedBy: "0xBBB",
  now: "2026-10-06T00:00:00.000Z",
};

describe("issuePublisherGrant", () => {
  it("issues with an end date derived from validityDays", async () => {
    const d = deps(["0xaaa"]);
    await expect(issuePublisherGrant(d as never, input)).resolves.toBe("lic-1");
    const action = d.execute.mock.calls[0][1][0];
    expect(action.input.start).toBe("2026-10-06T00:00:00.000Z");
    expect(action.input.end).toBe("2027-10-06T00:00:00.000Z");
    expect(action.input.issuer).toBe("PUBLISHER_GRANT");
  });

  it("issues an open-ended licence when validityDays is null", async () => {
    const d = deps(["0xaaa"], null);
    await issuePublisherGrant(d as never, input);
    expect(d.execute.mock.calls[0][1][0].input.end).toBeNull();
  });

  it("refuses a user who is not on the allow list", async () => {
    const d = deps([]);
    await expect(issuePublisherGrant(d as never, input)).rejects.toBeInstanceOf(
      NotOnAllowListError,
    );
    expect(d.createLicenseDocument).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run subgraphs/vetra-licensing/__tests__/publisher-grant.test.ts`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Implement the issuer**

Note the date arithmetic happens **here**, not in the reducer — reducers are pure.

```ts
// subgraphs/vetra-licensing/issuers/publisher-grant.ts
import { issueLicense } from "document-models/app-owner-license";

export class NotOnAllowListError extends Error {}
export class LicenseTypeNotIssuableError extends Error {}

export interface GrantDeps {
  isOnAllowList(appId: string, user: string): Promise<boolean>;
  getLicenseType(id: string): Promise<{
    id: string;
    app: string;
    status: string;
    validityDays: number | null;
  } | null>;
  createLicenseDocument(): Promise<string>;
  execute(documentId: string, actions: unknown[]): Promise<void>;
}

export interface GrantInput {
  appId: string;
  licenseTypeId: string;
  user: string;
  issuedBy: string;
  now: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function issuePublisherGrant(
  deps: GrantDeps,
  input: GrantInput,
): Promise<string> {
  const user = input.user.toLowerCase();

  if (!(await deps.isOnAllowList(input.appId, user))) {
    throw new NotOnAllowListError(
      `${user} is not on the allow list for app ${input.appId}`,
    );
  }

  const type = await deps.getLicenseType(input.licenseTypeId);
  if (!type || type.status !== "ACTIVE" || type.app !== input.appId) {
    throw new LicenseTypeNotIssuableError(
      `license type ${input.licenseTypeId} is not issuable for app ${input.appId}`,
    );
  }

  const end =
    type.validityDays === null
      ? null
      : new Date(Date.parse(input.now) + type.validityDays * DAY_MS).toISOString();

  const documentId = await deps.createLicenseDocument();
  await deps.execute(documentId, [
    issueLicense({
      app: input.appId,
      licenseType: type.id,
      user,
      issuer: "PUBLISHER_GRANT",
      issuedBy: input.issuedBy.toLowerCase(),
      stage: null,
      details: null,
      issued: input.now,
      start: input.now,
      end,
    }),
  ]);

  return documentId;
}
```

- [ ] **Step 4: Run the issuer tests**

Run: `npx vitest run subgraphs/vetra-licensing/__tests__/publisher-grant.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Write the failing handler test**

```ts
// subgraphs/vetra-licensing/__tests__/reference-handler.test.ts
import { describe, it, expect, vi } from "vitest";
import { LicenseHandler } from "../reference-handler/handler.js";

const client = (over: Record<string, unknown> = {}) => ({
  appLicenses: vi.fn(async () => [
    { id: "lic-1", user: "0xaaa", licenseTypeId: "type-1", status: "ACTIVE", start: null, end: null },
  ]),
  appLicenseTypes: vi.fn(async () => [
    { id: "type-1", kind: "2026-free-tier", status: "ACTIVE", templateHash: "hash-1" },
  ]),
  appUserEnvironments: vi.fn(async () => []),
  applyEnvironmentTemplate: vi.fn(async () => ({ environmentId: "env-1" })),
  releaseEnvironment: vi.fn(async () => true),
  ...over,
});

describe("LicenseHandler", () => {
  it("applies a template for an active licence with no environment", async () => {
    const c = client();
    await new LicenseHandler(c as never, console).reconcileOnce();
    expect(c.applyEnvironmentTemplate).toHaveBeenCalledWith({
      licenseId: "lic-1",
      label: "2026-free-tier",
    });
  });

  it("is a no-op on the second run", async () => {
    const c = client({
      appUserEnvironments: vi.fn(async () => [
        { user: "0xaaa", environmentId: "env-1", templateHash: "hash-1", licenseId: "lic-1", appId: "app-1" },
      ]),
    });
    await new LicenseHandler(c as never, console).reconcileOnce();
    expect(c.applyEnvironmentTemplate).not.toHaveBeenCalled();
    expect(c.releaseEnvironment).not.toHaveBeenCalled();
  });

  // Review Focus 3: a retired type leaves the existing environment alone.
  it("skips a licence whose type is retired and releases nothing", async () => {
    const c = client({
      appLicenseTypes: vi.fn(async () => [
        { id: "type-1", kind: "2026-free-tier", status: "RETIRED", templateHash: "hash-1" },
      ]),
      appUserEnvironments: vi.fn(async () => [
        { user: "0xaaa", environmentId: "env-1", templateHash: "stale", licenseId: "lic-1", appId: "app-1" },
      ]),
    });
    await new LicenseHandler(c as never, console).reconcileOnce();
    expect(c.applyEnvironmentTemplate).not.toHaveBeenCalled();
    expect(c.releaseEnvironment).not.toHaveBeenCalled();
  });

  it("releases an environment whose licence is gone", async () => {
    const c = client({
      appLicenses: vi.fn(async () => []),
      appUserEnvironments: vi.fn(async () => [
        { user: "0xaaa", environmentId: "env-1", templateHash: "hash-1", licenseId: "lic-1", appId: "app-1" },
      ]),
    });
    await new LicenseHandler(c as never, console).reconcileOnce();
    expect(c.releaseEnvironment).toHaveBeenCalledWith({ environmentId: "env-1" });
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run subgraphs/vetra-licensing/__tests__/reference-handler.test.ts`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 7: Implement the reference handler**

This file is the generator's future output. Keep it short enough that a publisher can read
it in one sitting and edit it with confidence.

```ts
// subgraphs/vetra-licensing/reference-handler/handler.ts
import { computeLicensePlan, type ActiveLicense } from "../plan.js";

export interface LicensingClient {
  appLicenses(args: { status: string }): Promise<
    { id: string; user: string; licenseTypeId: string; status: string }[]
  >;
  appLicenseTypes(): Promise<
    { id: string; kind: string; status: string; templateHash: string }[]
  >;
  appUserEnvironments(): Promise<
    { user: string; environmentId: string; templateHash: string }[]
  >;
  applyEnvironmentTemplate(input: {
    licenseId: string;
    label: string;
  }): Promise<{ environmentId: string }>;
  releaseEnvironment(input: { environmentId: string }): Promise<boolean>;
}

/**
 * Reconciles active licences against existing environments. Driven by a timer,
 * not by events, so it has no replay semantics and heals itself after any
 * failure. Safe to run as often as you like: applyEnvironmentTemplate is an
 * upsert keyed on (app, user).
 *
 * Edit this file only if "every active licence gets its type's template" is not
 * the rule you want.
 */
export class LicenseHandler {
  constructor(
    private readonly client: LicensingClient,
    private readonly logger: Pick<Console, "info" | "warn">,
  ) {}

  async reconcileOnce(): Promise<void> {
    const [licenses, types, environments] = await Promise.all([
      this.client.appLicenses({ status: "ACTIVE" }),
      this.client.appLicenseTypes(),
      this.client.appUserEnvironments(),
    ]);

    // A retired or missing type has no usable template. Such a licence is left
    // out of the desired set entirely — and so is its user's environment, so
    // the plan neither re-applies nor releases it.
    const usable = new Map(
      types.filter((t) => t.status === "ACTIVE").map((t) => [t.id, t]),
    );

    const active: ActiveLicense[] = [];
    const parked = new Set<string>();
    for (const l of licenses) {
      const type = usable.get(l.licenseTypeId);
      if (!type) {
        parked.add(l.user);
        this.logger.warn(
          `[license-handler] licence ${l.id} points at unusable type ${l.licenseTypeId}; skipping`,
        );
        continue;
      }
      active.push({
        licenseId: l.id,
        user: l.user,
        licenseTypeId: l.licenseTypeId,
        templateHash: type.templateHash,
      });
    }

    const plan = computeLicensePlan(
      active,
      environments.filter((e) => !parked.has(e.user)),
    );

    for (const l of plan.toApply) {
      const type = usable.get(l.licenseTypeId);
      try {
        await this.client.applyEnvironmentTemplate({
          licenseId: l.licenseId,
          label: type?.kind ?? l.licenseTypeId,
        });
      } catch (err) {
        this.logger.warn(
          `[license-handler] apply for ${l.licenseId} failed: ${String(err)}`,
        );
      }
    }

    for (const environmentId of plan.toRelease) {
      try {
        await this.client.releaseEnvironment({ environmentId });
      } catch (err) {
        this.logger.warn(
          `[license-handler] release of ${environmentId} failed: ${String(err)}`,
        );
      }
    }
  }
}
```

- [ ] **Step 8: Run the handler tests**

Run: `npx vitest run subgraphs/vetra-licensing/__tests__/reference-handler.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 9: Full verification**

Run: `npm run tsc && npm run lint:fix && npm run test:coverage`
Expected: all clean, document-model coverage at or above 95% on all four metrics.

- [ ] **Step 10: Commit**

```bash
git add subgraphs/vetra-licensing
git commit -m "feat(licensing): add publisher-grant issuer and reference license handler"
```

---

## Manual verification in staging

The spec's definition of done. Run after Task 10, with `LICENSING_KEEPER_ENABLED=true` and
`LICENSING_DRY_RUN=false`.

- [ ] Create an `app-license-type`, add a CONNECT service, publish it.
- [ ] Add the holder's address to the app's allow list, call `issuePublisherGrant`.
- [ ] Wait one keeper interval — the licence moves `ISSUED → ACTIVE`.
- [ ] Run the reference handler once — an environment appears, owned by the holder.
- [ ] Run it again — nothing changes, and no new environment appears.
- [ ] Set the licence `end` into the past, wait one interval — status becomes `EXPIRED`.
- [ ] Run the handler — the environment moves to `STOPPED`.
- [ ] Revoke a second licence directly — its environment stops on the next handler run.

## Follow-on plan

`ph generate license-handler` lives in `/home/f/projects/powerhouse` (the `ph` CLI
monorepo) and is a separate plan. Its template input is
`subgraphs/vetra-licensing/reference-handler/handler.ts` from Task 10, which is why it
comes after this one rather than beside it. `ph generate processor --type` is a closed
`oneOf(["analytics", "relationalDb"])` and a reconciler is not an operation processor, so
that work adds a generator rather than extending the enum.
