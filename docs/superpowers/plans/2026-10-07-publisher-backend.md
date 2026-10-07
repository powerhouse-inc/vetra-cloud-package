# Publisher Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a human App owner a GraphQL surface to manage licence types, grants and revocations, and make a granted licence produce an environment by itself.

**Architecture:** A second, owner-authenticated resolver set (`vetraPublisher`) lives beside the existing machine-only `vetraLicensing` surface in the same subgraph, authorising every call against `apps.owner_address`. A server-side provisioning keeper reconciles active licences into environments on a timer, reusing the existing pure planner and provisioning functions.

**Tech Stack:** TypeScript (ESM, `.js` extensions on relative imports), GraphQL via `graphql-tag`, Kysely over Postgres, vitest, `@powerhousedao/reactor` client.

**Spec:** `docs/superpowers/specs/2026-10-07-publisher-dashboard-design.md`

**Scope note:** This plan covers the cloud-package backend only (spec components 1 and 2). The vetra.io dashboard (component 3) is a separate plan in a separate repository, and consumes what this one produces.

## Global Constraints

- The existing machine path is unchanged, byte for byte. `subgraphs/vetra-licensing/auth.ts` and `resolvers.ts`'s existing fields are not edited to serve the human path.
- **No field on the existing `vetraLicensing` namespace ever gains an `appId` argument.** Only the new `vetraPublisher` namespace takes one, and it authorises it on every call.
- `config.ts` defaults are untouched: `enabled` false, `dryRun` true.
- Publisher **reads** work when licensing is disabled; publisher **mutations** throw `LicensingDisabledError`. Gate order on every field: authenticate → authorise → (mutations only) enabled check.
- A licence type or licence belonging to another owner's app is reported as not found, never as forbidden.
- Do NOT re-run `ph generate` for any reason: codegen is not idempotent in this repo and corrupts hand-written tests.
- Commits carry no `Co-Authored-By` trailer.
- `npm run tsc` and `npx oxlint subgraphs/vetra-licensing` must be clean; the full `npx vitest run` must stay green (1051 tests at BASE).

## Review Focus

1. **A non-owner naming someone else's app id** — must be refused and must leak nothing, including via error wording or timing differences between "not yours" and "does not exist". (Task 1, Task 10)
2. **A licence type id that belongs to another app** passed to a mutation keyed on document id — must be refused by reading the document's own `app`, not by trusting the argument. (Task 6, Task 10)
3. **An app whose identity has lapsed** (`status !== "ACTIVE"`) — the owner must be refused, not just machine callers, because provisioning spends real infrastructure. (Task 1)
4. **A licence whose licence type was retired or deleted after the grant** — the provisioning keeper must skip it and keep going, never throw out of a tick. (Task 8)
5. **A grant to a malformed address** — refused before any document is created, so a typo cannot leave an empty licence document behind. (Task 7)

---

### Task 1: `resolveOwnerApp` — the human authorisation gate

**Files:**
- Create: `subgraphs/vetra-licensing/publisher-auth.ts`
- Test: `subgraphs/vetra-licensing/__tests__/publisher-auth.test.ts`

**Interfaces:**
- Consumes: `AuthContext` from `./auth.js`, `callerIsAdmin` from `../../shared/admins.js`.
- Produces:
  ```ts
  export class NotAppOwnerError extends Error {}
  export class UnknownAppError extends Error {}
  export interface OwnerAppRecord { id: string; status: string; owner_address: string }
  export interface PublisherAuthDeps {
    findAppById(id: string): Promise<OwnerAppRecord | null>;
    listAppsForOwner(address: string): Promise<OwnerAppRecord[]>;
  }
  export function resolveOwnerApp(
    deps: PublisherAuthDeps,
    ctx: AuthContext & { isAdmin?: (a: string) => boolean },
    appId: string,
  ): Promise<{ appId: string }>;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, vi } from "vitest";
import {
  resolveOwnerApp,
  NotAppOwnerError,
  UnknownAppError,
  type PublisherAuthDeps,
} from "../publisher-auth.js";
import { UnauthenticatedError, AppIdentityInactiveError } from "../auth.js";

const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const STRANGER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const deps = (app: Partial<{ status: string; owner_address: string }> = {}) =>
  ({
    findAppById: vi.fn(async () => ({
      id: "app-1",
      status: "ACTIVE",
      owner_address: OWNER,
      ...app,
    })),
    listAppsForOwner: vi.fn(async () => []),
  }) satisfies PublisherAuthDeps;

const ctx = (address?: string) =>
  address ? { user: { address, networkId: "eip155", chainId: 1 } } : {};

describe("resolveOwnerApp", () => {
  it("authorises the owner", async () => {
    await expect(resolveOwnerApp(deps(), ctx(OWNER), "app-1")).resolves.toEqual({
      appId: "app-1",
    });
  });

  it("matches the owner case-insensitively", async () => {
    await expect(
      resolveOwnerApp(deps(), ctx(OWNER.toUpperCase()), "app-1"),
    ).resolves.toEqual({ appId: "app-1" });
  });

  it("refuses an unauthenticated caller", async () => {
    const d = deps();
    await expect(resolveOwnerApp(d, ctx(), "app-1")).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
    // Refused before any lookup: an anonymous caller learns nothing.
    expect(d.findAppById).not.toHaveBeenCalled();
  });

  it("reports an unknown app as unknown", async () => {
    const d = { ...deps(), findAppById: vi.fn(async () => null) };
    await expect(resolveOwnerApp(d, ctx(OWNER), "nope")).rejects.toBeInstanceOf(
      UnknownAppError,
    );
  });

  it("refuses a stranger", async () => {
    await expect(
      resolveOwnerApp(deps(), ctx(STRANGER), "app-1"),
    ).rejects.toBeInstanceOf(NotAppOwnerError);
  });

  it("refuses the owner when the app is not ACTIVE", async () => {
    await expect(
      resolveOwnerApp(deps({ status: "PENDING_IDENTITY" }), ctx(OWNER), "app-1"),
    ).rejects.toBeInstanceOf(AppIdentityInactiveError);
  });

  it("authorises a platform admin who is not the owner", async () => {
    const adminCtx = {
      ...ctx(STRANGER),
      isAdmin: (a: string) => a.toLowerCase() === STRANGER,
    };
    await expect(
      resolveOwnerApp(deps(), adminCtx, "app-1"),
    ).resolves.toEqual({ appId: "app-1" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run subgraphs/vetra-licensing/__tests__/publisher-auth.test.ts`
Expected: FAIL, cannot resolve `../publisher-auth.js`.

- [ ] **Step 3: Implement**

```ts
import { callerIsAdmin } from "../../shared/admins.js";
import {
  UnauthenticatedError,
  AppIdentityInactiveError,
  type AuthContext,
} from "./auth.js";

export class NotAppOwnerError extends Error {
  override name = "NotAppOwnerError";
}
export class UnknownAppError extends Error {
  override name = "UnknownAppError";
}

export interface OwnerAppRecord {
  id: string;
  status: string;
  owner_address: string;
}

export interface PublisherAuthDeps {
  findAppById(id: string): Promise<OwnerAppRecord | null>;
  listAppsForOwner(address: string): Promise<OwnerAppRecord[]>;
}

/**
 * The human counterpart to resolveCallerApp. A person proves who they are with
 * a wallet, then proves the app is theirs. The app id IS an argument here --
 * the opposite of the machine surface -- which is only safe because ownership
 * is checked on every single call.
 */
export async function resolveOwnerApp(
  deps: PublisherAuthDeps,
  ctx: AuthContext & { isAdmin?: (a: string) => boolean },
  appId: string,
): Promise<{ appId: string }> {
  const address = ctx.user?.address;
  if (!address) {
    throw new UnauthenticatedError("sign in to manage licences");
  }

  const app = await deps.findAppById(appId);
  if (!app) {
    throw new UnknownAppError(`no app ${appId}`);
  }

  const isOwner = app.owner_address.toLowerCase() === address.toLowerCase();
  if (!isOwner && !callerIsAdmin(ctx, address)) {
    throw new NotAppOwnerError(`no app ${appId}`);
  }

  if (app.status !== "ACTIVE") {
    throw new AppIdentityInactiveError(
      `app ${app.id} is ${app.status}; its identity delegation must be renewed`,
    );
  }

  return { appId: app.id };
}
```

Note the message on `NotAppOwnerError`: it is deliberately identical to
`UnknownAppError`'s, so the surface is not an oracle for other publishers' app
ids. The distinct class exists for server-side logging only.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run subgraphs/vetra-licensing/__tests__/publisher-auth.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add subgraphs/vetra-licensing/publisher-auth.ts subgraphs/vetra-licensing/__tests__/publisher-auth.test.ts
git commit -m "feat(licensing): authorise a human app owner"
```

---

### Task 2: richer reads for the publisher surface and the keeper

**Files:**
- Modify: `subgraphs/vetra-licensing/reads.ts`
- Test: `subgraphs/vetra-licensing/__tests__/reads.test.ts` (append)

**Interfaces:**
- Produces, added to `LicenseReads`:
  ```ts
  export interface LicenseFullRow {
    id: string;
    app: string;
    user: string;
    licenseTypeId: string;
    status: LicenseStatusName;
    start: string | null;
    end: string | null;
  }
  /** Every licence across all apps, with the fields provisioning needs. */
  allLicenses(): Promise<LicenseFullRow[]>;
  ```

`listLicenses()` stays exactly as it is — `LicenseKeeper` depends on it and must
not change.

- [ ] **Step 1: Write the failing test** (append to the existing file)

```ts
describe("allLicenses", () => {
  it("returns every licence across apps with app, user and type", async () => {
    const client = fakeClient([
      license("a", { app: "app-1", user: "0xAA", licenseType: "t-1", status: "ACTIVE" }),
      license("b", { app: "app-2", user: "0xBB", licenseType: "t-2", status: "ISSUED" }),
    ]);
    const reads = createReactorLicenseReads(client);

    const rows = await reads.allLicenses();

    expect(rows).toHaveLength(2);
    const a = rows.find((r) => r.id === "a")!;
    expect(a.app).toBe("app-1");
    expect(a.licenseTypeId).toBe("t-1");
    expect(a.status).toBe("ACTIVE");
    // Lowercased at the boundary, as every other read does.
    expect(a.user).toBe("0xaa");
  });

  it("skips a licence with an unrecognised status rather than throwing", async () => {
    const client = fakeClient([
      license("a", { app: "app-1", user: "0xAA", licenseType: "t-1", status: "ACTIVE" }),
      license("bad", { app: "app-1", user: "0xCC", licenseType: "t-1", status: "WAT" }),
    ]);
    const rows = await createReactorLicenseReads(client).allLicenses();
    expect(rows.map((r) => r.id)).toEqual(["a"]);
  });
});
```

Reuse the `fakeClient` and `license` helpers already in that file; match their
existing signatures rather than adding new ones.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run subgraphs/vetra-licensing/__tests__/reads.test.ts`
Expected: FAIL, `reads.allLicenses is not a function`.

- [ ] **Step 3: Implement**

Add to the object returned by `createReactorLicenseReads`, reusing the module's
existing `findAll`, `parseLicense` and status-validation helpers rather than
writing new parsing. The row shape is `LicenseFullRow`; skip any document whose
status is not one of the five `LicenseStatusName` values, and lowercase `user`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run subgraphs/vetra-licensing/__tests__/reads.test.ts`
Expected: PASS, all existing tests plus 2.

- [ ] **Step 5: Commit**

```bash
git add subgraphs/vetra-licensing/reads.ts subgraphs/vetra-licensing/__tests__/reads.test.ts
git commit -m "feat(licensing): read every licence with its app, user and type"
```

---

### Task 3: licence-type gateway

**Files:**
- Create: `subgraphs/vetra-licensing/license-type-gateway.ts`
- Test: `subgraphs/vetra-licensing/__tests__/license-type-gateway.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const LICENSE_TYPE_DOC_TYPE = "powerhouse/app-license-type"; // re-export from reads.js, do not redeclare
  export interface LicenseTypeGateway {
    create(): Promise<string>;
    execute(id: string, actions: Action[]): Promise<void>;
  }
  export function createReactorLicenseTypeGateway(
    client: LicenseGatewayClientLike,
  ): LicenseTypeGateway;
  ```

**This is the same shape as `license-gateway.ts` for the other document type.**
Read that file first and mirror it exactly, including the rejection detection:
capture `header.revision.global` BEFORE the execute, read back the appended
operations with `sinceRevision`, match them by this call's own `action.id`, and
throw on both a missing operation and one carrying `error`. The reactor's
`execute()` does not throw on a reducer rejection — a gateway that misses this
would let a failed `PUBLISH_LICENSE_TYPE` look like success.

Import `LicenseGatewayClientLike` and `isDocumentNotFound` from the existing
modules; do not re-declare either.

- [ ] **Step 1: Write the failing test**

Mirror `__tests__/license-gateway.test.ts`. Required cases: create returns the
new id; execute succeeds on the happy path; **a reducer rejection throws with
the reducer's message in it**; a missing operation throws; a missing document
throws.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run subgraphs/vetra-licensing/__tests__/license-type-gateway.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** by mirroring `license-gateway.ts`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run subgraphs/vetra-licensing/__tests__/license-type-gateway.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add subgraphs/vetra-licensing/license-type-gateway.ts subgraphs/vetra-licensing/__tests__/license-type-gateway.test.ts
git commit -m "feat(licensing): gateway for licence-type documents"
```

---

### Task 4: the `vetraPublisher` schema

**Files:**
- Create: `subgraphs/vetra-licensing/publisher-schema.ts`

**Interfaces:**
- Produces: `export const publisherSchema: DocumentNode`.

- [ ] **Step 1: Write the schema**

```ts
import { gql } from "graphql-tag";
import type { DocumentNode } from "graphql";

/**
 * The human surface. Every field here takes an appId or a document id and
 * authorises it against apps.owner_address -- the exact opposite of
 * vetraLicensing, where the app is derived from the caller's App identity and
 * an id argument would be a vulnerability.
 */
export const publisherSchema: DocumentNode = gql`
  type PublisherApp {
    id: String!
    name: String!
    status: String!
  }

  type PublisherLicenseType {
    id: String!
    kind: String
    label: String
    status: String!
    validityDays: Int
    templateHash: String!
    services: [PublisherTemplateService!]!
    packages: [PublisherTemplatePackage!]!
  }

  type PublisherTemplateService {
    id: String!
    type: String!
    prefix: String
  }

  type PublisherTemplatePackage {
    id: String!
    packageName: String
    version: String
  }

  type PublisherLicense {
    id: String!
    user: String!
    licenseTypeId: String!
    status: String!
    start: String
    end: String
    environmentId: String
  }

  input CreateLicenseTypeInput {
    appId: String!
    kind: String!
    label: String
    validityDays: Int
  }

  input SetLicenseTypeTemplateInput {
    licenseTypeId: String!
    size: String
    baseDomain: String
    packageRegistry: String
  }

  input AddLicenseTypeServiceInput {
    licenseTypeId: String!
    type: String!
    prefix: String
  }

  input AddLicenseTypePackageInput {
    licenseTypeId: String!
    packageName: String!
    version: String
  }

  input IssueGrantInput {
    appId: String!
    licenseTypeId: String!
    user: String!
  }

  input RevokeLicenseInput {
    licenseId: String!
    reason: String
  }

  type VetraPublisherQueries {
    myApps: [PublisherApp!]!
    licenseTypes(appId: String!): [PublisherLicenseType!]!
    licenses(appId: String!, status: String): [PublisherLicense!]!
    environments(appId: String!): [AppUserEnvironment!]!
  }

  type VetraPublisherMutations {
    createLicenseType(input: CreateLicenseTypeInput!): String!
    setLicenseTypeTemplate(input: SetLicenseTypeTemplateInput!): Boolean!
    addLicenseTypeService(input: AddLicenseTypeServiceInput!): Boolean!
    addLicenseTypePackage(input: AddLicenseTypePackageInput!): Boolean!
    publishLicenseType(licenseTypeId: String!): Boolean!
    retireLicenseType(licenseTypeId: String!): Boolean!
    issueGrant(input: IssueGrantInput!): String!
    revokeLicense(input: RevokeLicenseInput!): Boolean!
  }

  extend type Query {
    vetraPublisher: VetraPublisherQueries!
  }

  extend type Mutation {
    vetraPublisher: VetraPublisherMutations!
  }
`;
```

`AppUserEnvironment` is already defined in `schema.ts`; reuse it rather than
declaring a second type with the same fields.

- [ ] **Step 2: Verify it parses**

Run: `npx vitest run subgraphs/vetra-licensing` — any gql syntax error fails at
import time. Also `npm run tsc`.

- [ ] **Step 3: Commit**

```bash
git add subgraphs/vetra-licensing/publisher-schema.ts
git commit -m "feat(licensing): schema for the publisher surface"
```

---

### Task 5: publisher queries

**Files:**
- Create: `subgraphs/vetra-licensing/publisher-resolvers.ts`
- Test: `subgraphs/vetra-licensing/__tests__/publisher-queries.test.ts`

**Interfaces:**
- Consumes: `resolveOwnerApp`, `PublisherAuthDeps` (Task 1); `LicenseReads` incl. `allLicenses` (Task 2).
- Produces:
  ```ts
  export interface PublisherDeps {
    auth: PublisherAuthDeps;
    reads: LicenseReads;
    cfg: LicensingConfig;
    typeGateway: LicenseTypeGateway;
    licenseGateway: LicenseGateway;
    grant: GrantDeps;
    appName(appId: string): Promise<string>;
  }
  export function createPublisherResolvers(
    db: Kysely<VetraLicensingDB>,
    deps: PublisherDeps,
  ): Record<string, unknown>;

  // Defined in this file and used by Tasks 6 and 7. Both carry a message that
  // does not distinguish "not yours" from "does not exist", for the same reason
  // NotAppOwnerError does.
  export class UnknownLicenseTypeError extends Error {}
  export class UnknownLicenseError extends Error {}
  ```

Implement the four queries in this task; mutations land in Tasks 6 and 7 in the
same file.

- `myApps` — `deps.auth.listAppsForOwner(ctx.user.address)`; no appId argument, and an unauthenticated caller gets `UnauthenticatedError`.
- `licenseTypes(appId)` — authorise, then `reads.licenseTypes(appId)`, enriched with the services and packages from the licence-type document.
- `licenses(appId, status)` — authorise, then `reads.licenses(appId, status)`, joined to `app_user_environments` so each licence carries its `environmentId` or null.
- `environments(appId)` — authorise, then the rows for that app.

- [ ] **Step 1: Write the failing tests**

Cover, with a database that is a throwing `Proxy` so any accidental query fails
loudly:

```ts
it("refuses a stranger and touches neither the db nor the reactor", async () => {
  const reads = { licenses: vi.fn(), licenseTypes: vi.fn(), environments: vi.fn() };
  const r = createPublisherResolvers(throwingDb, depsFor({ owner: OWNER, reads }));
  await expect(
    r.VetraPublisherQueries.licenseTypes({}, { appId: "app-1" }, ctx(STRANGER)),
  ).rejects.toBeInstanceOf(NotAppOwnerError);
  expect(reads.licenseTypes).not.toHaveBeenCalled();
});

it("returns licence types for an app the caller owns", async () => { /* … */ });

it("serves reads even when licensing is disabled", async () => {
  // cfg.enabled false: reads still work, so an operator can inspect a
  // deployment that is switched off.
});

it("joins each licence to its environment id, or null when it has none", async () => { /* … */ });
```

- [ ] **Step 2: Run to verify it fails.** Expected: module not found.

- [ ] **Step 3: Implement the four queries.**

- [ ] **Step 4: Run to verify they pass.**

- [ ] **Step 5: Commit**

```bash
git add subgraphs/vetra-licensing/publisher-resolvers.ts subgraphs/vetra-licensing/__tests__/publisher-queries.test.ts
git commit -m "feat(licensing): publisher queries"
```

---

### Task 6: tier-authoring mutations

**Files:**
- Modify: `subgraphs/vetra-licensing/publisher-resolvers.ts`
- Test: `subgraphs/vetra-licensing/__tests__/publisher-tier-mutations.test.ts`

Implements `createLicenseType`, `setLicenseTypeTemplate`, `addLicenseTypeService`,
`addLicenseTypePackage`, `publishLicenseType`, `retireLicenseType`.

`createLicenseType` authorises `input.appId`, then `typeGateway.create()` followed
by `typeGateway.execute(id, [actions.setLicenseTypeDetails({ app: appId, kind, label, validityDays })])`,
returning the new document id.

**Every other field is keyed on `licenseTypeId`, not `appId`.** Each must:

1. `reads.licenseType(licenseTypeId)` → if null, throw `UnknownLicenseTypeError`.
2. `resolveOwnerApp(deps.auth, ctx, thatType.app)` — authorise the document's own
   app, never an argument.
3. `requireEnabled()`.
4. Dispatch through `typeGateway.execute`.

A licence type owned by another publisher must therefore surface as
`UnknownLicenseTypeError`, identical to one that does not exist.

Action creators come from `document-models/app-license-type`:
`setLicenseTypeDetails`, `setTemplate`, `addTemplateService`, `addTemplatePackage`,
`publishLicenseType`, `retireLicenseType`. Service and package ids are generated
server-side with `crypto.randomUUID()`; the client never supplies one.

- [ ] **Step 1: Write the failing tests**, including:
  - creating a tier returns the new document id and dispatches `SET_LICENSE_TYPE_DETAILS` carrying the authorised `appId` (never a client-supplied one);
  - **another publisher's licence type is `UnknownLicenseTypeError`**, and nothing is dispatched;
  - every mutation throws `LicensingDisabledError` when `cfg.enabled` is false, and dispatches nothing;
  - `publishLicenseType` propagates the reducer's `IncompleteTemplateError` unchanged when the tier has no service.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify they pass.**
- [ ] **Step 5: Commit**

```bash
git add subgraphs/vetra-licensing/publisher-resolvers.ts subgraphs/vetra-licensing/__tests__/publisher-tier-mutations.test.ts
git commit -m "feat(licensing): tier authoring for publishers"
```

---

### Task 7: `issueGrant` and `revokeLicense`

**Files:**
- Modify: `subgraphs/vetra-licensing/publisher-resolvers.ts`
- Test: `subgraphs/vetra-licensing/__tests__/publisher-grant-mutations.test.ts`

`issueGrant(appId, licenseTypeId, user)`: authorise `appId`, `requireEnabled()`,
then call the existing `issuePublisherGrant(deps.grant, { appId, licenseTypeId,
user, issuedBy: ctx.user.address, now: new Date().toISOString() })` and return the
licence id. `issuePublisherGrant` already validates the holder address and already
checks that the licence type belongs to `appId`, so neither check is duplicated
here — but there must be a test proving a malformed address is refused **and no
document is created**, because that guard is what keeps a typo from leaving an
empty licence document behind.

`revokeLicense(licenseId, reason)`: read the licence, authorise its `app`, then
`licenseGateway.execute(licenseId, [actions.revokeLicense({ reason })])`. A
licence belonging to another owner is `UnknownLicenseError`.

- [ ] **Step 1: Write the failing tests**, including:
  - a grant returns the new licence id and records `issuedBy` as the caller's wallet;
  - a malformed holder address is refused and `createLicenseDocument` is never called;
  - another publisher's licence cannot be revoked, and nothing is dispatched;
  - both mutations refuse with `LicensingDisabledError` when disabled.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify they pass.**
- [ ] **Step 5: Commit**

```bash
git add subgraphs/vetra-licensing/publisher-resolvers.ts subgraphs/vetra-licensing/__tests__/publisher-grant-mutations.test.ts
git commit -m "feat(licensing): grant and revoke for publishers"
```

---

### Task 8: the provisioning keeper

**Files:**
- Create: `subgraphs/vetra-licensing/provisioning-keeper.ts`
- Test: `subgraphs/vetra-licensing/__tests__/provisioning-keeper.test.ts`
- Test: `subgraphs/vetra-licensing/__tests__/provisioning-keeper.integration.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ProvisioningKeeperDeps {
    allLicenses(): Promise<LicenseFullRow[]>;
    licenseTypes(appId: string): Promise<LicenseTypeView[]>;
    environments(appId: string): Promise<UserEnvironment[]>;
    applyFor(appId: string, licence: ActiveLicense): Promise<void>;
    releaseFor(appId: string, environmentId: string): Promise<void>;
    cfg: LicensingConfig;
    logger: Pick<Console, "info" | "warn">;
  }
  export class ProvisioningKeeper {
    constructor(d: ProvisioningKeeperDeps);
    start(): void;
    stop(): void;
    reconcileOnce(): Promise<void>;
  }
  ```

Copy `keeper.ts`'s shape exactly: `setInterval`, a `running` re-entrancy guard,
`tick()` called once immediately then on the interval, `reconcileOnce` returning
early unless `cfg.enabled`, and a dry-run branch that logs and returns.

`reconcileOnce`:
1. `allLicenses()`, keep only `status === "ACTIVE"`.
2. Group by `app`.
3. Per app: `licenseTypes(appId)` → a `Map<id, templateHash>`. Build
   `ActiveLicense[]` by joining each licence to its type's hash. **A licence
   whose type is missing, retired, or absent from the map is skipped and
   logged** — never throws, never guesses a hash.
4. `computeLicensePlan(actives, await environments(appId))`.
5. `applyFor` each `toApply`, `releaseFor` each `toRelease`, each in its own
   try/catch that logs and continues.

- [ ] **Step 1: Write the failing unit tests**, including:
  - an active licence with a known type produces one `applyFor` call carrying the right `templateHash`;
  - **a licence whose type is missing is skipped, the tick completes, and the other app's licence is still applied** (Review Focus 4);
  - a failing `applyFor` is logged and the remaining work still runs;
  - `cfg.enabled` false does nothing at all;
  - `cfg.dryRun` true logs and calls neither `applyFor` nor `releaseFor`;
  - `reconcileOnce` is re-entrancy safe when `start()` ticks overlap.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify they pass.**
- [ ] **Step 5: Write the integration test**

Follow `__tests__/provision-reactor.integration.test.ts` exactly — a real
reactor via `ReactorClientBuilder`/`ReactorBuilder` plus a real PGlite Kysely
database with the licensing migrations. Prove end to end that: a granted,
activated licence produces a real environment document; a second tick creates
nothing more; and a revoked licence releases its environment.

- [ ] **Step 6: Run the integration test, then commit**

```bash
git add subgraphs/vetra-licensing/provisioning-keeper.ts subgraphs/vetra-licensing/__tests__/provisioning-keeper.test.ts subgraphs/vetra-licensing/__tests__/provisioning-keeper.integration.test.ts
git commit -m "feat(licensing): reconcile active licences into environments"
```

---

### Task 9: wire it into the subgraph

**Files:**
- Modify: `subgraphs/vetra-licensing/index.ts`
- Modify: `subgraphs/vetra-licensing/schema.ts`

- [ ] **Step 1: Merge the schemas.** In `schema.ts`, export the combined
  document so both namespaces are served: import `publisherSchema` and merge it
  with the existing `schema` (concatenate the `definitions` arrays into one
  `DocumentNode`, keeping `schema`'s existing export name intact so `index.ts`'s
  `typeDefs` assignment is unchanged).

- [ ] **Step 2: Wire the dependencies in `onSetup`.** Add, beside the existing
  wiring and reusing the SAME `cfg` object already computed there:
  - `auth: { findAppById, listAppsForOwner }` querying the `vetra-apps`
    namespace's `apps` table for `id, status, owner_address` (and `name` for
    `appName`);
  - `typeGateway: createReactorLicenseTypeGateway(this.reactorClient)`;
  - a `ProvisioningKeeper`, held on the instance and `start()`ed, exactly as the
    existing keeper is;
  - merge `createPublisherResolvers(db, publisherDeps)` into `this.resolvers`.

- [ ] **Step 3: Stop the new keeper in `onDisconnect`** alongside the existing
  one, with the same `?.` guard for an `onSetup` that threw.

- [ ] **Step 4: Verify.** `npm run tsc`, `npx oxlint subgraphs/vetra-licensing`,
  `npx vitest run`.

- [ ] **Step 5: Commit**

```bash
git add subgraphs/vetra-licensing/index.ts subgraphs/vetra-licensing/schema.ts
git commit -m "feat(licensing): serve the publisher surface and run the provisioning keeper"
```

---

### Task 10: cross-publisher isolation

**Files:**
- Test: `subgraphs/vetra-licensing/__tests__/publisher-isolation.test.ts`

This is the security property of the whole design and gets its own test file, so
it cannot be weakened by an unrelated edit without someone noticing.

Two publishers, A and B, each owning one app, each with a licence type, a licence
and an environment row. For **every** publisher field, assert that A acting on
B's identifiers is refused and that nothing is read or written:

- [ ] **Step 1: Write the tests** — one case per field (`licenseTypes`,
  `licenses`, `environments`, `createLicenseType`, `setLicenseTypeTemplate`,
  `addLicenseTypeService`, `addLicenseTypePackage`, `publishLicenseType`,
  `retireLicenseType`, `issueGrant`, `revokeLicense`), plus one asserting
  `myApps` returns only A's apps.
- [ ] **Step 2: Assert the error wording does not distinguish** "not yours" from
  "does not exist" — both `NotAppOwnerError` and `UnknownAppError` carry the same
  message text (Review Focus 1).
- [ ] **Step 3: Run; fix any leak the tests expose.**
- [ ] **Step 4: Commit**

```bash
git add subgraphs/vetra-licensing/__tests__/publisher-isolation.test.ts
git commit -m "test(licensing): publishers cannot reach each other's licences"
```
