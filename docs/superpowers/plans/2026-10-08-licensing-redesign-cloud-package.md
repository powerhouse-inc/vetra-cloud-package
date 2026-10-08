# Licensing redesign (cloud package) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move licensing onto the app document (templates + terms), reshape licences onto DIDs and kinds, absorb `vetra-access-codes` into an invite-code issuer, make the keeper a chain-keyed SHARED/DEDICATED handler with an offboarding clock, serve the three API surfaces of the binding contract, relay user stats to Renown, and migrate production data in place.

**Architecture:** The `vetra-app` document gains a `licensing` module (templates, terms). `app-owner-license` carries `kind` and a DID `user`. Every issuer funnels into one `issueLicense()` that checks the app's term, writes the licence document, the `app_license_grants` provenance row and a `license_chain` row. A new `AppLicenseHandler` keeper plans per licence chain (pure planner), provisions DEDICATED environments keyed on the chain root in a new `license_environments` table, sets `stage` for SHARED licences, and runs the offboarding clock. One idempotent startup migration (dry-run by default) converts production data, and the keeper refuses to act until that migration reports complete.

**Tech Stack:** TypeScript (nodenext, strict), Powerhouse document models (`ph-cli generate`), `@powerhousedao/reactor` (`ReactorClientBuilder` in integration tests), Kysely on Postgres (PGlite in tests), GraphQL via `BaseSubgraph`, vitest, oxlint.

**Spec:** `docs/superpowers/specs/2026-10-08-app-document-licensing-redesign-design.md` and the binding contract `docs/superpowers/specs/2026-10-08-licensing-api-contract.md`. Context: `2026-10-07-apps-as-document-models-design.md`, `2026-10-07-licensing-product-model.md`, `2026-10-06-license-driven-provisioning-design.md`.

## Global Constraints

- Repo `vetra-cloud-package`, worktree `/home/f/projects/vetra-cloud-package-licensing`, branch `feat/license-provisioning`. Staging first, then main.
- **reactor-mcp is not available.** Document models are changed by editing `document-models/<name>/<name>.json` (state schema, operations, input schemas, errors, reducer strings) and running `npx ph-cli generate document-model -d document-models/<name>/<name>.json`. Codegen rewrites `document-models/index.ts`, `document-models/document-models.ts`, `document-models/upgrade-manifests.ts`, `powerhouse.manifest.json`, and may inject unused imports into hand-written test files — revert those test-file edits before committing. Never edit anything under `gen/`.
- The reducer string of every operation in a `.json` spec is kept identical (modulo whitespace) to its body in `v1/src/reducers/<module>.ts`. Task 1 adds a test that enforces this for every model.
- Reducers are pure and synchronous: no `Date.now()`, `new Date()`, `crypto.randomUUID()`. Ids and timestamps arrive in action input. Every rejection is a named error declared in the spec's `errors` list. Reducer tests assert on `doc.operations.global[i].error`, never `toThrow()`.
- Reducer coverage stays ≥ 95 % lines/branches/functions/statements: `npm run test:coverage`. Never lower the threshold or exclude files.
- `vitest.config.ts` keeps excluding `**/e2e*` and `**/*.e2e.test.ts`. Do not touch it.
- `subgraphs/index.ts` is a barrel: remove only the `VetraAccessCodesSubgraph` line (Task 17). Never empty it.
- DB migrations are forward-only and idempotent: `createTable(...).ifNotExists()`, `createIndex(...).ifNotExists()`, `alterTable().addColumn()` wrapped to swallow SQLSTATE `42701`. Never drop or rename an existing production table or column. Old tables (`app_user_environments`, `vetra-access-codes.invite_codes`, `vetra-access-codes.invite_redemptions`) are left in place, read-only.
- Production has licensing LIVE: keeper enabled, 6 apps, real `app-license-type` / `app-owner-license` documents and `app_license_grants` rows. Nothing in this plan may delete an environment except the +90-day offboarding destroy, which is additionally gated by `LICENSING_DESTROY_ENABLED` (default `false`). The migration never deletes an environment.
- The keeper never releases, stops or destroys an environment because a licence kind failed to resolve, a licence lacks provenance, or a document could not be read: **unknown is held and logged, never treated as ended.**
- User identity everywhere new is a DID `did:pkh:eip155:1:<lowercased 0x address>`. Inputs accept `did:pkh:eip155:<chain>:0x…` or a bare `0x` address; every other DID method is refused with `UNSUPPORTED_DID`.
- Contract names are exact (`vetraPublisher`, `vetraSubscriptions`, `vetraLicensing`, every field and type in `2026-10-08-licensing-api-contract.md`). vetra.io writes hand-written GraphQL against them.
- Offboarding timeline (DEDICATED, chain ended without replacement): warnings at end − 7 d and end − 1 d; at end a "shutdown in 14 days" warning; `STOPPED` at end + 14 d (data kept); final warning at end + 83 d; destroyed at end + 90 d; re-licensing the same chain before destruction reactivates the environment.
- Renown relay (contract, relay section): Vetra holds no app keys. It mints a ~10-minute token with `mutation { issueAppStatsToken(did) }` on `<RENOWN_SWITCHBOARD_URL>/graphql/renown-workload` using the existing `x-renown-workload-registration-token` header (`RENOWN_WORKLOAD_REGISTRATION_TOKEN`, as `subgraphs/vetra-apps/renown.ts` sends it), caches it per app DID, sends `reportUserStat` with header `X-Renown-App-Token` (never `Authorization`), coalesces per (app, user, metric), and on `FORBIDDEN` drops the token, logs, and returns/delivers nothing. `RENOWN_STATS_URL` unset ⇒ `reportUserStat` returns `false` and logs.
- Studio app slug from `VETRA_STUDIO_APP_SLUG` (default `vetra-studio`); publisher from `VETRA_STUDIO_PUBLISHER_ADDRESS`, else the first `ADMINS` entry.
- Commits: conventional commits, **no `Co-Authored-By` or generated-with trailers**.
- Per task, before committing: `npm run tsc`, `npm run lint:fix`, `npx vitest run <the task's test files>`; for model tasks also `npm run test:coverage`.

## Review Focus

1. **The keeper running before the migration on production data.** `license_environments` starts empty while live environments exist in `app_user_environments`; a keeper that ran first would provision a second environment for every live holder. Expected: the handler does nothing until `licensing_migration_steps` holds `complete`. *(Test in Task 9: `does nothing until the migration reports complete`.)*
2. **A production user holding two ACTIVE licences of one app.** The old keeper gave them one environment ("lowest licence id wins"); per-chain keying would give the second licence a new environment after migration. Expected: the migration chains every other authorised ACTIVE licence of the same (app, user) onto the existing environment's root. *(Test in Task 16: `chains a second active licence of the same holder onto the existing environment`.)*
3. **A licence-stopped environment woken by the public `wakeStudio(host)` mutation.** Housekeeping wakes any `STOPPED` environment by host with no auth. Expected: an environment whose `license_environments.stopped_at` is set is reported as sleeping and not woken. *(Test in Task 10: `refuses to wake an environment licensing has stopped`.)*
4. **A template switched to SHARED (or a term deleted) while DEDICATED environments run on it.** Expected: those environments are held and logged, never ended or offboarded. *(Test in Task 8: `holds a chain whose head resolves to SHARED but which owns an environment`.)*
5. **Re-redeeming an invite code / a redeem that crashed half-way.** Expected: the same caller redeeming the same code again gets the same licence back (idempotent), a reserved redemption with no licence is completed on retry, and a failed issue releases the reservation so the cap is not consumed. *(Tests in Task 7.)*

---

## File Structure

| Path | Responsibility |
|---|---|
| `document-models/vetra-app/vetra-app.json`, `v1/src/reducers/licensing.ts`, `v1/src/utils.ts`, `v1/tests/licensing.test.ts`, `v1/tests/spec-sync.test.ts` | Templates + terms on the app document (Task 1) |
| `document-models/app-owner-license/app-owner-license.json`, `v1/src/reducers/lifecycle.ts`, `v1/tests/lifecycle.test.ts` | Licence reshaped onto `kind` + DID, `SET_STAGE`, `MIGRATE_LICENSE` (Task 2) |
| `subgraphs/vetra-licensing/did.ts` | DID normalisation (Task 3) |
| `subgraphs/vetra-licensing/db/schema.ts`, `db/migrations.ts` | New tables and columns (Task 4) |
| `subgraphs/vetra-licensing/doc-gateway.ts`, `app-reads.ts`, `owner-apps.ts` | App document reads/writes, owner lookup with document fallback (Task 5) |
| `subgraphs/vetra-licensing/issue.ts`, `issuers/publisher-grant.ts`, `grants.ts` | `issueLicense()` and the publisher grant issuer (Task 6) |
| `subgraphs/vetra-licensing/invite-codes.ts`, `issuers/invite-code.ts`, `key-vault.ts` | Invite codes and their issuer (Task 7) |
| `subgraphs/vetra-licensing/chain-plan.ts` | Pure per-chain planner (Task 8) |
| `subgraphs/vetra-licensing/handler.ts`, `environments.ts` | `AppLicenseHandler` keeper, chain-keyed provisioning (Task 9) |
| `subgraphs/vetra-licensing/offboarding.ts`, `subgraphs/vetra-housekeeping/index.ts` | Offboarding clock, warnings, wake guard (Task 10) |
| `subgraphs/vetra-licensing/publisher-schema.ts`, `publisher-resolvers.ts`, `publisher-errors.ts` | `vetraPublisher` (Task 11) |
| `subgraphs/vetra-licensing/subscriptions-schema.ts`, `subscriptions-resolvers.ts` | `vetraSubscriptions` (Task 12) |
| `subgraphs/vetra-licensing/schema.ts`, `resolvers.ts`, `reference-handler/handler.ts` | `vetraLicensing` machine surface (Task 13) |
| `subgraphs/vetra-licensing/reporting.ts`, `renown-stats.ts` | Reporting tokens and the Renown relay (Task 14) |
| `subgraphs/vetra-licensing/studio-access.ts`, `subgraphs/vetra-studio-pool/index.ts` | Studio pool on licences (Task 15) |
| `subgraphs/vetra-licensing/migration/*.ts` | Startup migration, dry-run, verification (Task 16) |
| deletions | `subgraphs/vetra-access-codes/**`, old keeper/plan/grant code (Task 17); `app-license-type` model + editor (Task 18, separate release) |

---

### Task 1: `vetra-app` licensing module (templates and terms)

**Files:**
- Modify: `document-models/vetra-app/vetra-app.json` (state schema, initial value, new module `licensing`)
- Create: `document-models/vetra-app/v1/src/reducers/licensing.ts`
- Modify: `document-models/vetra-app/v1/src/utils.ts`
- Generated: `document-models/vetra-app/v1/gen/**`, `v1/schema.graphql`, `powerhouse.manifest.json`
- Test: `document-models/vetra-app/v1/tests/licensing.test.ts`, `document-models/vetra-app/v1/tests/spec-sync.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (from `document-models/vetra-app`): state types `VetraAppEnvironmentTemplate`, `VetraAppLicenseTerm`, `TemplateInstanceMode = "SHARED" | "DEDICATED"`, `LicenseTermStatus = "DRAFT" | "ACTIVE" | "RETIRED"`, `LicenseIssuerKind = "INVITE_CODE" | "PUBLISHER_GRANT" | "ACHRA_SUBSCRIPTION"`, `TemplateServiceType`; action creators `actions.addTemplate({ id, name, mode })`, `actions.setTemplateDetails({ id, name?, mode?, sharedEnvironment?, size?, baseDomain?, packageRegistry? })` (absent key = unchanged, `null` = clear), `actions.addTemplateService({ templateId, id, type, prefix, artifactName, artifactChannel })`, `actions.removeTemplateService({ templateId, id })`, `actions.addTemplatePackage({ templateId, id, packageName, version })`, `actions.removeTemplatePackage({ templateId, id })`, `actions.deleteTemplate({ id })`, `actions.addTerm({ id, kind, label, templateId, validityDays, issuers })`, `actions.setTermDetails({ id, kind?, label?, templateId?, validityDays?, issuers? })`, `actions.publishTerm({ id })`, `actions.retireTerm({ id })`.

- [ ] **Step 1: Extend the state schema and initial value in the spec**

Edit `document-models/vetra-app/vetra-app.json` → `specifications[0].state.global`. Append to the `schema` string (keep everything already there; add the two fields to `VetraAppState`):

```graphql
type VetraAppState {
  name: String
  slug: String
  owner: EthereumAddress
  status: VetraAppStatus!
  repository: VetraAppRepository
  identity: VetraAppIdentity
  productionEnvironmentId: OID
  previews: VetraAppPreviews
  artifacts: [VetraAppArtifact!]!
  templates: [VetraAppEnvironmentTemplate!]!
  terms: [VetraAppLicenseTerm!]!
}

type VetraAppEnvironmentTemplate {
  id: OID!
  name: String
  mode: TemplateInstanceMode!
  sharedEnvironment: PHID
  services: [TemplateService!]!
  packages: [TemplatePackage!]!
  size: String
  baseDomain: String
  packageRegistry: URL
}

enum TemplateInstanceMode {
  SHARED
  DEDICATED
}

type TemplateService {
  id: OID!
  type: TemplateServiceType!
  prefix: String
  artifactName: String
  artifactChannel: AutoUpdateChannel
}

enum TemplateServiceType {
  CONNECT
  SWITCHBOARD
  FUSION
  CLINT
  DOCLING
  PAPERLESS
  SPECKLE
}

type TemplatePackage {
  id: OID!
  packageName: String
  version: String
}

type VetraAppLicenseTerm {
  id: OID!
  kind: String!
  label: String
  templateId: OID
  validityDays: Int
  issuers: [LicenseIssuerKind!]!
  status: LicenseTermStatus!
}

enum LicenseTermStatus {
  DRAFT
  ACTIVE
  RETIRED
}

enum LicenseIssuerKind {
  INVITE_CODE
  PUBLISHER_GRANT
  ACHRA_SUBSCRIPTION
}
```

Add `"templates": []` and `"terms": []` to the `initialValue` JSON string.

- [ ] **Step 2: Add the `licensing` module to the spec**

Append to `specifications[0].modules` a module `{ "id": "module-licensing", "name": "licensing", "description": "Environment templates and the licence terms an app hands out.", "operations": [...] }`. Every operation has `"scope": "global"`, `"template": ""`, `"examples": []`, and the `reducer` string equal to the body of the same-named method in Step 4. Inputs and errors:

```graphql
input AddTemplateInput { id: OID!  name: String  mode: TemplateInstanceMode! }
input SetTemplateDetailsInput {
  id: OID!  name: String  mode: TemplateInstanceMode  sharedEnvironment: PHID
  size: String  baseDomain: String  packageRegistry: URL
}
input AddTemplateServiceInput {
  templateId: OID!  id: OID!  type: TemplateServiceType!  prefix: String
  artifactName: String  artifactChannel: AutoUpdateChannel
}
input RemoveTemplateServiceInput { templateId: OID!  id: OID! }
input AddTemplatePackageInput { templateId: OID!  id: OID!  packageName: String!  version: String }
input RemoveTemplatePackageInput { templateId: OID!  id: OID! }
input DeleteTemplateInput { id: OID! }
input AddTermInput {
  id: OID!  kind: String!  label: String  templateId: OID  validityDays: Int  issuers: [LicenseIssuerKind!]
}
input SetTermDetailsInput {
  id: OID!  kind: String  label: String  templateId: OID  validityDays: Int  issuers: [LicenseIssuerKind!]
}
input PublishTermInput { id: OID! }
input RetireTermInput { id: OID! }
```

(Write each input on its own lines in the JSON string, one field per line, as the existing operations do.)

| Operation | Errors (`id` / `name` / `code` / description) |
|---|---|
| `ADD_TEMPLATE` | `err-duplicate-template` / `DuplicateTemplateError` / `DUPLICATE_TEMPLATE` / A template with this id exists. |
| `SET_TEMPLATE_DETAILS` | `err-template-not-found-details` / `TemplateNotFoundError` / `TEMPLATE_NOT_FOUND` / No such template. ; `err-shared-services-details` / `SharedTemplateServicesError` / `SHARED_TEMPLATE_SERVICES` / A SHARED template carries no services or packages. |
| `ADD_TEMPLATE_SERVICE` | `err-template-not-found-add-service` / `TemplateNotFoundError` ; `err-shared-services-add-service` / `SharedTemplateServicesError` ; `err-duplicate-service` / `DuplicateServiceError` / `DUPLICATE_SERVICE` ; `err-artifact-on-non-fusion` / `ArtifactOnNonFusionServiceError` / `ARTIFACT_ON_NON_FUSION_SERVICE` |
| `REMOVE_TEMPLATE_SERVICE` | `err-template-not-found-remove-service` / `TemplateNotFoundError` ; `err-unknown-service` / `UnknownServiceError` / `UNKNOWN_SERVICE` |
| `ADD_TEMPLATE_PACKAGE` | `err-template-not-found-add-package` / `TemplateNotFoundError` ; `err-shared-services-add-package` / `SharedTemplateServicesError` ; `err-duplicate-package` / `DuplicatePackageError` / `DUPLICATE_PACKAGE` |
| `REMOVE_TEMPLATE_PACKAGE` | `err-template-not-found-remove-package` / `TemplateNotFoundError` ; `err-unknown-package` / `UnknownPackageError` / `UNKNOWN_PACKAGE` |
| `DELETE_TEMPLATE` | `err-template-not-found-delete` / `TemplateNotFoundError` ; `err-template-in-use` / `TemplateInUseError` / `TEMPLATE_IN_USE` / A term still references this template. |
| `ADD_TERM` | `err-duplicate-term` / `DuplicateTermError` / `DUPLICATE_TERM` ; `err-invalid-kind-add` / `InvalidKindError` / `INVALID_KIND` ; `err-duplicate-kind-add` / `DuplicateKindError` / `DUPLICATE_KIND` ; `err-template-not-found-add-term` / `TemplateNotFoundError` ; `err-negative-validity-add` / `NegativeValidityError` / `NEGATIVE_VALIDITY` |
| `SET_TERM_DETAILS` | `err-term-not-found-details` / `TermNotFoundError` / `TERM_NOT_FOUND` ; `err-invalid-kind-set` / `InvalidKindError` ; `err-kind-immutable` / `KindImmutableError` / `KIND_IMMUTABLE` ; `err-duplicate-kind-set` / `DuplicateKindError` ; `err-template-not-found-set-term` / `TemplateNotFoundError` ; `err-negative-validity-set` / `NegativeValidityError` ; `err-term-incomplete-set` / `TermIncompleteError` / `TERM_INCOMPLETE` |
| `PUBLISH_TERM` | `err-term-not-found-publish` / `TermNotFoundError` ; `err-term-incomplete-publish` / `TermIncompleteError` |
| `RETIRE_TERM` | `err-term-not-found-retire` / `TermNotFoundError` ; `err-term-not-published` / `TermNotPublishedError` / `TERM_NOT_PUBLISHED` / Only an ACTIVE term can be retired. |

Error `template` fields are `""`. Error ids are unique across the whole document.

- [ ] **Step 3: Regenerate**

Run: `npx ph-cli generate document-model -d document-models/vetra-app/vetra-app.json`
Expected: `document-models/vetra-app/v1/gen/licensing/{actions,creators,error,operations}.ts` exist; `gen/reducer.ts` imports `vetraAppLicensingOperations` from `../src/reducers/licensing.js`. `git diff --stat document-models/vetra-app/v1/tests` — revert any injected import (`git checkout -- document-models/vetra-app/v1/tests/app.test.ts document-models/vetra-app/v1/tests/document-model.test.ts`).

- [ ] **Step 4: Write the shared helpers and the reducers**

Append to `document-models/vetra-app/v1/src/utils.ts` (keep its existing `export *` content):

```ts
import type {
  VetraAppEnvironmentTemplate,
  VetraAppLicenseTerm,
  VetraAppState,
} from "../gen/schema/types.js";
import {
  TemplateNotFoundError,
  TermNotFoundError,
} from "../gen/licensing/error.js";

/**
 * App documents created before the licensing module existed carry neither
 * list — their stored state predates the initial value that adds them. Every
 * licensing reducer goes through this, so an old document gains both lists on
 * its first licensing operation instead of crashing on `undefined.push`.
 */
export function licensingLists(state: VetraAppState): {
  templates: VetraAppEnvironmentTemplate[];
  terms: VetraAppLicenseTerm[];
} {
  const s = state as Partial<Pick<VetraAppState, "templates" | "terms">>;
  s.templates ??= [];
  s.terms ??= [];
  return { templates: s.templates, terms: s.terms };
}

export function findTemplate(
  state: VetraAppState,
  id: string,
): VetraAppEnvironmentTemplate {
  const t = licensingLists(state).templates.find((x) => x.id === id);
  if (!t) throw new TemplateNotFoundError(`template ${id} does not exist`);
  return t;
}

export function findTerm(state: VetraAppState, id: string): VetraAppLicenseTerm {
  const t = licensingLists(state).terms.find((x) => x.id === id);
  if (!t) throw new TermNotFoundError(`term ${id} does not exist`);
  return t;
}

/** A kind is what a licence carries forever: it must be non-blank. */
export function isValidKind(kind: string): boolean {
  return kind.trim().length > 0 && kind.trim() === kind;
}
```

Create `document-models/vetra-app/v1/src/reducers/licensing.ts`:

```ts
import type { VetraAppLicensingOperations } from "document-models/vetra-app/v1";
import {
  ArtifactOnNonFusionServiceError,
  DuplicateKindError,
  DuplicatePackageError,
  DuplicateServiceError,
  DuplicateTemplateError,
  DuplicateTermError,
  InvalidKindError,
  KindImmutableError,
  NegativeValidityError,
  SharedTemplateServicesError,
  TemplateInUseError,
  TemplateNotFoundError,
  TermIncompleteError,
  TermNotPublishedError,
  UnknownPackageError,
  UnknownServiceError,
} from "../../gen/licensing/error.js";
import {
  findTemplate,
  findTerm,
  isValidKind,
  licensingLists,
} from "../utils.js";

export const vetraAppLicensingOperations: VetraAppLicensingOperations = {
  addTemplateOperation(state, action) {
    const { templates } = licensingLists(state);
    if (templates.some((t) => t.id === action.input.id)) {
      throw new DuplicateTemplateError(`template ${action.input.id} already exists`);
    }
    templates.push({
      id: action.input.id,
      name: action.input.name ?? null,
      mode: action.input.mode,
      sharedEnvironment: null,
      services: [],
      packages: [],
      size: null,
      baseDomain: null,
      packageRegistry: null,
    });
  },
  setTemplateDetailsOperation(state, action) {
    const t = findTemplate(state, action.input.id);
    const mode = action.input.mode ?? t.mode;
    if (mode === "SHARED" && (t.services.length > 0 || t.packages.length > 0)) {
      throw new SharedTemplateServicesError(
        "a SHARED template provisions nothing; remove its services and packages first",
      );
    }
    t.mode = mode;
    // Absent key = unchanged, explicit null = clear. Resolvers forward only
    // the keys the caller sent, so an edit of one field cannot wipe another.
    if (action.input.name !== undefined) t.name = action.input.name ?? null;
    if (action.input.sharedEnvironment !== undefined)
      t.sharedEnvironment = action.input.sharedEnvironment ?? null;
    if (action.input.size !== undefined) t.size = action.input.size ?? null;
    if (action.input.baseDomain !== undefined)
      t.baseDomain = action.input.baseDomain ?? null;
    if (action.input.packageRegistry !== undefined)
      t.packageRegistry = action.input.packageRegistry ?? null;
  },
  addTemplateServiceOperation(state, action) {
    const t = findTemplate(state, action.input.templateId);
    if (t.mode === "SHARED") {
      throw new SharedTemplateServicesError("a SHARED template carries no services");
    }
    if (t.services.some((s) => s.id === action.input.id)) {
      throw new DuplicateServiceError(`service ${action.input.id} already exists`);
    }
    if (action.input.artifactName && action.input.type !== "FUSION") {
      throw new ArtifactOnNonFusionServiceError(
        `only a FUSION service can reference an artifact, not ${action.input.type}`,
      );
    }
    t.services.push({
      id: action.input.id,
      type: action.input.type,
      prefix: action.input.prefix ?? action.input.artifactName ?? null,
      artifactName: action.input.artifactName ?? null,
      artifactChannel: action.input.artifactName
        ? (action.input.artifactChannel ?? "LATEST")
        : null,
    });
  },
  removeTemplateServiceOperation(state, action) {
    const t = findTemplate(state, action.input.templateId);
    const at = t.services.findIndex((s) => s.id === action.input.id);
    if (at === -1) {
      throw new UnknownServiceError(`service ${action.input.id} does not exist`);
    }
    t.services.splice(at, 1);
  },
  addTemplatePackageOperation(state, action) {
    const t = findTemplate(state, action.input.templateId);
    if (t.mode === "SHARED") {
      throw new SharedTemplateServicesError("a SHARED template carries no packages");
    }
    if (t.packages.some((p) => p.id === action.input.id)) {
      throw new DuplicatePackageError(`package ${action.input.id} already exists`);
    }
    t.packages.push({
      id: action.input.id,
      packageName: action.input.packageName,
      version: action.input.version ?? null,
    });
  },
  removeTemplatePackageOperation(state, action) {
    const t = findTemplate(state, action.input.templateId);
    const at = t.packages.findIndex((p) => p.id === action.input.id);
    if (at === -1) {
      throw new UnknownPackageError(`package ${action.input.id} does not exist`);
    }
    t.packages.splice(at, 1);
  },
  deleteTemplateOperation(state, action) {
    const { templates, terms } = licensingLists(state);
    const at = templates.findIndex((t) => t.id === action.input.id);
    if (at === -1) {
      throw new TemplateNotFoundError(`template ${action.input.id} does not exist`);
    }
    if (terms.some((t) => t.templateId === action.input.id)) {
      throw new TemplateInUseError(`template ${action.input.id} is used by a term`);
    }
    templates.splice(at, 1);
  },
  addTermOperation(state, action) {
    const { templates, terms } = licensingLists(state);
    if (terms.some((t) => t.id === action.input.id)) {
      throw new DuplicateTermError(`term ${action.input.id} already exists`);
    }
    if (!isValidKind(action.input.kind)) {
      throw new InvalidKindError("a kind must be non-blank without surrounding spaces");
    }
    if (terms.some((t) => t.kind === action.input.kind)) {
      throw new DuplicateKindError(`kind ${action.input.kind} is already used by this app`);
    }
    if (action.input.templateId && !templates.some((t) => t.id === action.input.templateId)) {
      throw new TemplateNotFoundError(`template ${action.input.templateId} does not exist`);
    }
    if (action.input.validityDays != null && action.input.validityDays <= 0) {
      throw new NegativeValidityError("validityDays must be positive");
    }
    terms.push({
      id: action.input.id,
      kind: action.input.kind,
      label: action.input.label ?? null,
      templateId: action.input.templateId ?? null,
      validityDays: action.input.validityDays ?? null,
      issuers: [...new Set(action.input.issuers ?? [])],
      status: "DRAFT",
    });
  },
  setTermDetailsOperation(state, action) {
    const { templates, terms } = licensingLists(state);
    const term = findTerm(state, action.input.id);
    const kind = action.input.kind;
    if (kind != null && kind !== term.kind) {
      if (!isValidKind(kind)) {
        throw new InvalidKindError("a kind must be non-blank without surrounding spaces");
      }
      // Licences carry the kind; once one could exist, renaming orphans it.
      if (term.status !== "DRAFT") {
        throw new KindImmutableError(`term ${term.id} is ${term.status}; its kind is fixed`);
      }
      if (terms.some((t) => t.id !== term.id && t.kind === kind)) {
        throw new DuplicateKindError(`kind ${kind} is already used by this app`);
      }
    }
    const templateId =
      action.input.templateId !== undefined ? (action.input.templateId ?? null) : term.templateId;
    if (templateId && !templates.some((t) => t.id === templateId)) {
      throw new TemplateNotFoundError(`template ${templateId} does not exist`);
    }
    if (action.input.validityDays != null && action.input.validityDays <= 0) {
      throw new NegativeValidityError("validityDays must be positive");
    }
    const issuers =
      action.input.issuers != null ? [...new Set(action.input.issuers)] : term.issuers;
    if (term.status === "ACTIVE" && (!templateId || issuers.length === 0)) {
      throw new TermIncompleteError("an ACTIVE term needs a template and at least one issuer");
    }
    if (kind != null) term.kind = kind;
    if (action.input.label !== undefined) term.label = action.input.label ?? null;
    term.templateId = templateId;
    if (action.input.validityDays !== undefined)
      term.validityDays = action.input.validityDays ?? null;
    term.issuers = issuers;
  },
  publishTermOperation(state, action) {
    const term = findTerm(state, action.input.id);
    if (!term.templateId || term.issuers.length === 0) {
      throw new TermIncompleteError("a term needs a template and at least one issuer to be published");
    }
    term.status = "ACTIVE";
  },
  retireTermOperation(state, action) {
    const term = findTerm(state, action.input.id);
    if (term.status !== "ACTIVE") {
      throw new TermNotPublishedError("only an ACTIVE term can be retired");
    }
    term.status = "RETIRED";
  },
};
```

Copy each method body verbatim into the matching operation's `reducer` string in the JSON (the helper calls stay; the src file supplies the imports).

- [ ] **Step 5: Write the failing reducer tests**

Create `document-models/vetra-app/v1/tests/licensing.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  addTemplate,
  addTemplatePackage,
  addTemplateService,
  addTerm,
  deleteTemplate,
  publishTerm,
  reducer,
  removeTemplatePackage,
  removeTemplateService,
  retireTerm,
  setTemplateDetails,
  setTermDetails,
  utils,
  type VetraAppDocument,
  type VetraAppState,
} from "document-models/vetra-app/v1";

type Act = Parameters<typeof reducer>[1];
const run = (doc: VetraAppDocument, ...acts: Act[]) =>
  acts.reduce((d, a) => reducer(d, a), doc);
const lastError = (doc: VetraAppDocument) => doc.operations.global.at(-1)?.error;

const base = () =>
  run(
    utils.createDocument(),
    addTemplate({ id: "t1", name: "Pro", mode: "DEDICATED" }),
    addTerm({
      id: "k1",
      kind: "2026-pro",
      label: "Pro",
      templateId: "t1",
      validityDays: 30,
      issuers: ["PUBLISHER_GRANT", "PUBLISHER_GRANT"],
    }),
  );

describe("licensing: scenario", () => {
  it("builds a template and a term end to end", () => {
    const doc = run(
      base(),
      addTemplateService({
        templateId: "t1",
        id: "s1",
        type: "FUSION",
        prefix: null,
        artifactName: "kv-app",
        artifactChannel: null,
      }),
      addTemplateService({ templateId: "t1", id: "s2", type: "SWITCHBOARD", prefix: "sb", artifactName: null, artifactChannel: null }),
      addTemplatePackage({ templateId: "t1", id: "p1", packageName: "@kv/pkg", version: null }),
      setTemplateDetails({ id: "t1", size: "VETRA_AGENT_S", baseDomain: "vetra.io", packageRegistry: "https://registry.vetra.io" }),
      setTermDetails({ id: "k1", label: "Pro tier", validityDays: null, issuers: ["INVITE_CODE"] }),
      publishTerm({ id: "k1" }),
      removeTemplatePackage({ templateId: "t1", id: "p1" }),
      removeTemplateService({ templateId: "t1", id: "s2" }),
      retireTerm({ id: "k1" }),
      publishTerm({ id: "k1" }),
    );
    expect(doc.operations.global.filter((o) => o.error)).toStrictEqual([]);
    const t = doc.state.global.templates[0]!;
    expect(t.services).toStrictEqual([
      { id: "s1", type: "FUSION", prefix: "kv-app", artifactName: "kv-app", artifactChannel: "LATEST" },
    ]);
    expect(t.packages).toStrictEqual([]);
    expect(t.size).toBe("VETRA_AGENT_S");
    expect(t.name).toBe("Pro"); // untouched: name key absent
    const term = doc.state.global.terms[0]!;
    expect(term).toMatchObject({ label: "Pro tier", validityDays: null, issuers: ["INVITE_CODE"], status: "ACTIVE" });
  });

  it("dedupes issuers on add", () => {
    expect(base().state.global.terms[0]!.issuers).toStrictEqual(["PUBLISHER_GRANT"]);
  });

  it("gives a document that predates the module both lists on first use", () => {
    const old = utils.createDocument();
    const g = old.state.global as Partial<VetraAppState>;
    delete g.templates;
    delete g.terms;
    const doc = reducer(old, addTerm({ id: "k", kind: "free", label: null, templateId: null, validityDays: null, issuers: null }));
    expect(lastError(doc)).toBeUndefined();
    expect(doc.state.global.templates).toStrictEqual([]);
    expect(doc.state.global.terms).toHaveLength(1);
  });

  it("clears a template field with explicit null", () => {
    const doc = run(base(), setTemplateDetails({ id: "t1", name: null, sharedEnvironment: "env-x" }));
    expect(doc.state.global.templates[0]).toMatchObject({ name: null, sharedEnvironment: "env-x" });
  });
});

describe("licensing: errors", () => {
  const cases: [string, () => VetraAppDocument, string][] = [
    ["duplicate template", () => run(base(), addTemplate({ id: "t1", name: null, mode: "SHARED" })), "template t1 already exists"],
    ["details on unknown template", () => run(base(), setTemplateDetails({ id: "nope" })), "template nope does not exist"],
    ["switch to SHARED with services", () => run(base(), addTemplateService({ templateId: "t1", id: "s", type: "CONNECT", prefix: null, artifactName: null, artifactChannel: null }), setTemplateDetails({ id: "t1", mode: "SHARED" })), "a SHARED template provisions nothing; remove its services and packages first"],
    ["switch to SHARED with packages", () => run(base(), addTemplatePackage({ templateId: "t1", id: "p", packageName: "x", version: null }), setTemplateDetails({ id: "t1", mode: "SHARED" })), "a SHARED template provisions nothing; remove its services and packages first"],
    ["service on SHARED", () => run(base(), addTemplate({ id: "t2", name: null, mode: "SHARED" }), addTemplateService({ templateId: "t2", id: "s", type: "CONNECT", prefix: null, artifactName: null, artifactChannel: null })), "a SHARED template carries no services"],
    ["service on unknown template", () => run(base(), addTemplateService({ templateId: "x", id: "s", type: "CONNECT", prefix: null, artifactName: null, artifactChannel: null })), "template x does not exist"],
    ["duplicate service", () => run(base(), addTemplateService({ templateId: "t1", id: "s", type: "CONNECT", prefix: null, artifactName: null, artifactChannel: null }), addTemplateService({ templateId: "t1", id: "s", type: "SWITCHBOARD", prefix: null, artifactName: null, artifactChannel: null })), "service s already exists"],
    ["artifact on non-FUSION", () => run(base(), addTemplateService({ templateId: "t1", id: "s", type: "CONNECT", prefix: null, artifactName: "img", artifactChannel: "DEV" })), "only a FUSION service can reference an artifact, not CONNECT"],
    ["remove unknown service", () => run(base(), removeTemplateService({ templateId: "t1", id: "zz" })), "service zz does not exist"],
    ["package on SHARED", () => run(base(), addTemplate({ id: "t2", name: null, mode: "SHARED" }), addTemplatePackage({ templateId: "t2", id: "p", packageName: "x", version: null })), "a SHARED template carries no packages"],
    ["duplicate package", () => run(base(), addTemplatePackage({ templateId: "t1", id: "p", packageName: "x", version: "1" }), addTemplatePackage({ templateId: "t1", id: "p", packageName: "y", version: null })), "package p already exists"],
    ["remove unknown package", () => run(base(), removeTemplatePackage({ templateId: "t1", id: "zz" })), "package zz does not exist"],
    ["delete unknown template", () => run(base(), deleteTemplate({ id: "zz" })), "template zz does not exist"],
    ["delete template in use", () => run(base(), deleteTemplate({ id: "t1" })), "template t1 is used by a term"],
    ["duplicate term id", () => run(base(), addTerm({ id: "k1", kind: "other", label: null, templateId: null, validityDays: null, issuers: null })), "term k1 already exists"],
    ["blank kind", () => run(base(), addTerm({ id: "k2", kind: " ", label: null, templateId: null, validityDays: null, issuers: null })), "a kind must be non-blank without surrounding spaces"],
    ["duplicate kind", () => run(base(), addTerm({ id: "k2", kind: "2026-pro", label: null, templateId: null, validityDays: null, issuers: null })), "kind 2026-pro is already used by this app"],
    ["term on unknown template", () => run(base(), addTerm({ id: "k2", kind: "x", label: null, templateId: "zz", validityDays: null, issuers: null })), "template zz does not exist"],
    ["non-positive validity on add", () => run(base(), addTerm({ id: "k2", kind: "x", label: null, templateId: null, validityDays: 0, issuers: null })), "validityDays must be positive"],
    ["details on unknown term", () => run(base(), setTermDetails({ id: "zz" })), "term zz does not exist"],
    ["blank kind on set", () => run(base(), setTermDetails({ id: "k1", kind: "" })), "a kind must be non-blank without surrounding spaces"],
    ["kind change after publish", () => run(base(), publishTerm({ id: "k1" }), setTermDetails({ id: "k1", kind: "renamed" })), "term k1 is ACTIVE; its kind is fixed"],
    ["kind clash on set", () => run(base(), addTerm({ id: "k2", kind: "free", label: null, templateId: null, validityDays: null, issuers: null }), setTermDetails({ id: "k2", kind: "2026-pro" })), "kind 2026-pro is already used by this app"],
    ["set unknown template", () => run(base(), setTermDetails({ id: "k1", templateId: "zz" })), "template zz does not exist"],
    ["non-positive validity on set", () => run(base(), setTermDetails({ id: "k1", validityDays: -1 })), "validityDays must be positive"],
    ["emptying an ACTIVE term", () => run(base(), publishTerm({ id: "k1" }), setTermDetails({ id: "k1", issuers: [] })), "an ACTIVE term needs a template and at least one issuer"],
    ["publish unknown", () => run(base(), publishTerm({ id: "zz" })), "term zz does not exist"],
    ["publish without template", () => run(base(), addTerm({ id: "k2", kind: "x", label: null, templateId: null, validityDays: null, issuers: ["INVITE_CODE"] }), publishTerm({ id: "k2" })), "a term needs a template and at least one issuer to be published"],
    ["publish without issuers", () => run(base(), addTerm({ id: "k2", kind: "x", label: null, templateId: "t1", validityDays: null, issuers: [] }), publishTerm({ id: "k2" })), "a term needs a template and at least one issuer to be published"],
    ["retire unknown", () => run(base(), retireTerm({ id: "zz" })), "term zz does not exist"],
    ["retire a DRAFT", () => run(base(), retireTerm({ id: "k1" })), "only an ACTIVE term can be retired"],
  ];
  it.each(cases)("%s is rejected with its message", (_name, build, message) => {
    expect(lastError(build())).toBe(message);
  });

  it("a rejected op leaves state as the previous op left it", () => {
    const ok = base();
    const bad = reducer(ok, deleteTemplate({ id: "t1" }));
    expect(bad.state.global).toStrictEqual(ok.state.global);
  });

  it("allows a kind rename while DRAFT and keeps an unchanged kind", () => {
    const doc = run(base(), setTermDetails({ id: "k1", kind: "2026-pro" }), setTermDetails({ id: "k1", kind: "2027-pro" }));
    expect(doc.operations.global.filter((o) => o.error)).toStrictEqual([]);
    expect(doc.state.global.terms[0]!.kind).toBe("2027-pro");
  });

  it("deletes an unused template", () => {
    const doc = run(base(), addTemplate({ id: "t2", name: null, mode: "SHARED" }), deleteTemplate({ id: "t2" }));
    expect(doc.state.global.templates.map((t) => t.id)).toStrictEqual(["t1"]);
  });
});
```

Create `document-models/vetra-app/v1/tests/spec-sync.test.ts` (it guards every model, so later tasks inherit it):

```ts
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Without reactor-mcp the .json spec is edited by hand, so nothing else keeps
 * its reducer strings and the src reducers in step. Future codegen reads the
 * JSON: a reducer fixed only in src would silently come back broken.
 */
const squash = (s: string) => s.replace(/\s+/g, "");
const root = join(__dirname, "..", "..", "..");

describe("spec reducer strings match src reducers", () => {
  for (const model of readdirSync(root, { withFileTypes: true })) {
    if (!model.isDirectory()) continue;
    const spec = join(root, model.name, `${model.name}.json`);
    if (!existsSync(spec)) continue;
    const json = JSON.parse(readFileSync(spec, "utf8")) as {
      specifications: { modules: { name: string; operations: { name: string; reducer: string }[] }[] }[];
    };
    const latest = json.specifications.at(-1)!;
    for (const mod of latest.modules) {
      const file = join(root, model.name, "v1", "src", "reducers", `${mod.name.replace(/_/g, "-")}.ts`);
      if (!existsSync(file)) continue;
      const src = squash(readFileSync(file, "utf8"));
      for (const op of mod.operations) {
        if (!op.reducer.trim()) continue;
        it(`${model.name} ${op.name}`, () => {
          expect(src).toContain(squash(op.reducer));
        });
      }
    }
  }
});
```

If `vetra-cloud-environment` or `app-license-type` operations fail this test because their JSON already drifted, do **not** change those models here: add their op names to a `KNOWN_DRIFT = new Set([...])` skip list at the top of the file with a comment naming the model, and mention it in the commit body.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run document-models/vetra-app`
Expected: all pass. If a case fails because the JSON reducer string and the src body differ, fix the JSON.

Run: `npm run test:coverage`
Expected: thresholds met; `licensing.ts` and `utils.ts` at 100 % branches (if a branch is reported uncovered, add an input variation to the scenario test, do not exclude).

- [ ] **Step 7: Type-check, lint, commit**

```bash
npm run tsc && npm run lint:fix
git add document-models/vetra-app powerhouse.manifest.json
git commit -m "feat(apps): templates and licence terms on the app document"
```

---

### Task 2: `app-owner-license` reshaped onto kind and DID

Old `ISSUE_LICENSE` operations live in production documents. If the reactor ever replays them through the new reducer, the new input schema must still accept them (`IssueLicenseInputSchema().parse` runs on replay) and produce a sensible state. So `kind` is optional at the schema level, the legacy `licenseType` / `issuedBy` inputs stay as optional deprecated fields, and a legacy issue folds them into `details`. New code always sends `kind` and never the legacy fields.

**Files:**
- Modify: `document-models/app-owner-license/app-owner-license.json`
- Modify: `document-models/app-owner-license/v1/src/reducers/lifecycle.ts`
- Modify: `subgraphs/vetra-licensing/reads.ts` (legacy type id derivation only)
- Generated: `document-models/app-owner-license/v1/gen/**`, `v1/schema.graphql`
- Test: `document-models/app-owner-license/v1/tests/lifecycle.test.ts`, `subgraphs/vetra-licensing/__tests__/reads.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (from `document-models/app-owner-license`): state `{ issuer, user: string|null, app, stage, kind: string|null, details, issued, start, end, status, replacedBy, revokedReason }`; `actions.issueLicense({ app, user, issuer, kind, stage, details, issued, start, end })`; `actions.setStage({ stage })`; `actions.migrateLicense({ kind, user, details })`; existing `activateLicense`, `expireLicense`, `revokeLicense`, `replaceLicense` unchanged. `reads.ts` exports `legacyLicenseTypeOf(g: Record<string, unknown>): string | null`.

- [ ] **Step 1: Edit the spec**

In `document-models/app-owner-license/app-owner-license.json`, replace the state schema's `AppOwnerLicenseState` with:

```graphql
type AppOwnerLicenseState {
  issuer: LicenseIssuerKind
  user: String
  app: PHID
  stage: PHID
  kind: String
  details: String
  issued: DateTime
  start: DateTime
  end: DateTime
  status: LicenseStatus!
  replacedBy: PHID
  revokedReason: String
}
```

(keep the two enums). `initialValue`: `{"issuer":null,"user":null,"app":null,"stage":null,"kind":null,"details":null,"issued":null,"start":null,"end":null,"status":"ISSUED","replacedBy":null,"revokedReason":null}`.

`ISSUE_LICENSE` input becomes:

```graphql
input IssueLicenseInput {
  app: PHID!
  user: String!
  issuer: LicenseIssuerKind!
  kind: String
  stage: PHID
  details: String
  issued: DateTime!
  start: DateTime!
  end: DateTime
  licenseType: PHID
  issuedBy: String
}
```

Add error `{ "id": "err-missing-kind", "name": "MissingKindError", "code": "MISSING_KIND", "description": "A licence needs a kind (or, for a legacy licence, a licence type).", "template": "" }` to `ISSUE_LICENSE`.

Add two operations to module `lifecycle`:

```graphql
input SetStageInput {
  stage: PHID
}
input MigrateLicenseInput {
  kind: String!
  user: String!
  details: String
}
```

Errors: `SET_STAGE` → `err-not-issued-stage` / `NotIssuedError` / `NOT_ISSUED` / The licence has not been issued. `MIGRATE_LICENSE` → `err-not-issued-migrate` / `NotIssuedError` / `NOT_ISSUED`; `err-already-migrated` / `AlreadyMigratedError` / `ALREADY_MIGRATED` / The licence already carries a kind. Descriptions: `SET_STAGE` "Bind the licence to the environment it is served by."; `MIGRATE_LICENSE` "One-time, system-only conversion of a pre-terms licence onto a kind and a DID."

Reducer strings = method bodies from Step 3.

- [ ] **Step 2: Regenerate**

Run: `npx ph-cli generate document-model -d document-models/app-owner-license/app-owner-license.json`
Revert any import injected into `document-models/app-owner-license/v1/tests/*.ts`.

- [ ] **Step 3: Rewrite the reducer**

`document-models/app-owner-license/v1/src/reducers/lifecycle.ts`:

```ts
import type { AppOwnerLicenseLifecycleOperations } from "document-models/app-owner-license/v1";
import {
  AlreadyIssuedError,
  AlreadyMigratedError,
  EndBeforeStartError,
  InvalidStatusTransitionError,
  MissingKindError,
  NotIssuedError,
} from "../../gen/lifecycle/error.js";

export const appOwnerLicenseLifecycleOperations: AppOwnerLicenseLifecycleOperations =
  {
    issueLicenseOperation(state, action) {
      if (state.user) {
        throw new AlreadyIssuedError("this license is already issued");
      }
      if (!action.input.kind && !action.input.licenseType) {
        throw new MissingKindError("a licence needs a kind");
      }
      if (action.input.end && action.input.end < action.input.start) {
        throw new EndBeforeStartError("end must not precede start");
      }
      state.app = action.input.app;
      state.user = action.input.user.toLowerCase();
      state.issuer = action.input.issuer;
      state.kind = action.input.kind ?? null;
      state.stage = action.input.stage ?? null;
      // A pre-terms ISSUE_LICENSE (replayed from history) carries licenseType
      // and issuedBy; both survive in details so MIGRATE_LICENSE can map them.
      state.details =
        action.input.details ??
        (action.input.licenseType
          ? JSON.stringify({
              legacyLicenseType: action.input.licenseType,
              issuedBy: action.input.issuedBy ?? null,
            })
          : null);
      state.issued = action.input.issued;
      state.start = action.input.start;
      state.end = action.input.end ?? null;
      state.status = "ISSUED";
    },
    activateLicenseOperation(state) {
      if (state.status !== "ISSUED") {
        throw new InvalidStatusTransitionError(
          `cannot activate a license with status ${state.status}`,
        );
      }
      state.status = "ACTIVE";
    },
    expireLicenseOperation(state) {
      if (state.status !== "ISSUED" && state.status !== "ACTIVE") {
        throw new InvalidStatusTransitionError(
          `cannot expire a license with status ${state.status}`,
        );
      }
      state.status = "EXPIRED";
    },
    revokeLicenseOperation(state, action) {
      if (state.status !== "ISSUED" && state.status !== "ACTIVE") {
        throw new InvalidStatusTransitionError(
          `cannot revoke a license with status ${state.status}`,
        );
      }
      state.status = "REVOKED";
      state.revokedReason = action.input.reason ?? null;
    },
    replaceLicenseOperation(state, action) {
      if (state.status !== "ACTIVE") {
        throw new InvalidStatusTransitionError(
          `cannot replace a license with status ${state.status}`,
        );
      }
      state.status = "REPLACED";
      state.replacedBy = action.input.replacedBy;
    },
    setStageOperation(state, action) {
      if (!state.user) {
        throw new NotIssuedError("this license has not been issued");
      }
      state.stage = action.input.stage ?? null;
    },
    migrateLicenseOperation(state, action) {
      if (!state.user) {
        throw new NotIssuedError("this license has not been issued");
      }
      if (state.kind) {
        throw new AlreadyMigratedError("this license already carries a kind");
      }
      state.kind = action.input.kind;
      state.user = action.input.user.toLowerCase();
      state.details = action.input.details ?? null;
    },
  };
```

- [ ] **Step 4: Rewrite the reducer tests**

Replace `document-models/app-owner-license/v1/tests/lifecycle.test.ts`:

```ts
import {
  activateLicense,
  expireLicense,
  issueLicense,
  migrateLicense,
  reducer,
  replaceLicense,
  revokeLicense,
  setStage,
  utils,
  type AppOwnerLicenseDocument,
} from "document-models/app-owner-license/v1";
import { describe, expect, it } from "vitest";

const DID = "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";
type Act = Parameters<typeof reducer>[1];
const run = (doc: AppOwnerLicenseDocument, ...acts: Act[]) =>
  acts.reduce((d, a) => reducer(d, a), doc);
const err = (doc: AppOwnerLicenseDocument) => doc.operations.global.at(-1)?.error;

const issue = (over: Partial<Parameters<typeof issueLicense>[0]> = {}) =>
  issueLicense({
    app: "app-1",
    user: DID,
    issuer: "PUBLISHER_GRANT",
    kind: "2026-pro",
    stage: null,
    details: '{"grantedBy":"0x2222222222222222222222222222222222222222"}',
    issued: "2026-10-06T00:00:00.000Z",
    start: "2026-10-06T00:00:00.000Z",
    end: "2027-10-06T00:00:00.000Z",
    ...over,
  });
const issued = () => reducer(utils.createDocument(), issue());

describe("AppOwnerLicense lifecycle", () => {
  it("starts as ISSUED with no holder and no kind", () => {
    const g = utils.createDocument().state.global;
    expect(g.status).toBe("ISSUED");
    expect(g.user).toBeNull();
    expect(g.kind).toBeNull();
  });

  it("issues onto a kind and lowercases the DID", () => {
    const doc = reducer(utils.createDocument(), issue({ user: "did:pkh:eip155:1:0xAbCdEf0123456789aBcDeF0123456789AbCdEf01" }));
    expect(err(doc)).toBeUndefined();
    expect(doc.state.global).toMatchObject({
      user: "did:pkh:eip155:1:0xabcdef0123456789abcdef0123456789abcdef01",
      kind: "2026-pro",
      stage: null,
      end: "2027-10-06T00:00:00.000Z",
    });
  });

  it("inherits a stage given at issue (an upgrade keeps its environment)", () => {
    const doc = reducer(utils.createDocument(), issue({ stage: "env-1", end: null, details: null }));
    expect(doc.state.global).toMatchObject({ stage: "env-1", end: null, details: null });
  });

  it("replays a pre-terms ISSUE_LICENSE into details", () => {
    const doc = reducer(
      utils.createDocument(),
      issue({ kind: null, details: null, licenseType: "type-1", issuedBy: "0x2222222222222222222222222222222222222222", user: "0x1111111111111111111111111111111111111111" }),
    );
    expect(err(doc)).toBeUndefined();
    expect(doc.state.global.kind).toBeNull();
    expect(JSON.parse(doc.state.global.details!)).toStrictEqual({
      legacyLicenseType: "type-1",
      issuedBy: "0x2222222222222222222222222222222222222222",
    });
  });

  it("replays a legacy issue without issuedBy", () => {
    const doc = reducer(utils.createDocument(), issue({ kind: null, details: null, licenseType: "type-1" }));
    expect(JSON.parse(doc.state.global.details!)).toStrictEqual({ legacyLicenseType: "type-1", issuedBy: null });
  });

  it("refuses an issue with neither kind nor licence type", () => {
    const doc = reducer(utils.createDocument(), issue({ kind: null }));
    expect(err(doc)).toBe("a licence needs a kind");
    expect(doc.state.global.user).toBeNull();
  });

  it("refuses a second issue and an end before start", () => {
    expect(err(reducer(issued(), issue()))).toBe("this license is already issued");
    expect(err(reducer(utils.createDocument(), issue({ end: "2026-01-01T00:00:00.000Z" })))).toBe("end must not precede start");
  });

  it("walks ISSUED -> ACTIVE -> REPLACED and guards every transition", () => {
    const active = reducer(issued(), activateLicense({}));
    expect(active.state.global.status).toBe("ACTIVE");
    expect(err(reducer(active, activateLicense({})))).toBe("cannot activate a license with status ACTIVE");
    const replaced = reducer(active, replaceLicense({ replacedBy: "lic-2" }));
    expect(replaced.state.global).toMatchObject({ status: "REPLACED", replacedBy: "lic-2" });
    expect(err(reducer(replaced, expireLicense({})))).toBe("cannot expire a license with status REPLACED");
    expect(err(reducer(replaced, revokeLicense({ reason: null })))).toBe("cannot revoke a license with status REPLACED");
    expect(err(reducer(issued(), replaceLicense({ replacedBy: "x" })))).toBe("cannot replace a license with status ISSUED");
  });

  it("expires and revokes from ISSUED or ACTIVE", () => {
    expect(reducer(issued(), expireLicense({})).state.global.status).toBe("EXPIRED");
    const revoked = run(issued(), activateLicense({}), revokeLicense({ reason: "cancelled by owner" }));
    expect(revoked.state.global).toMatchObject({ status: "REVOKED", revokedReason: "cancelled by owner" });
    expect(reducer(issued(), revokeLicense({})).state.global.revokedReason).toBeNull();
  });

  it("sets and clears the stage, only once issued", () => {
    const staged = reducer(issued(), setStage({ stage: "env-9" }));
    expect(staged.state.global.stage).toBe("env-9");
    expect(reducer(staged, setStage({ stage: null })).state.global.stage).toBeNull();
    expect(err(reducer(utils.createDocument(), setStage({ stage: "env-9" })))).toBe("this license has not been issued");
  });

  it("migrates a legacy licence once", () => {
    const legacy = reducer(utils.createDocument(), issue({ kind: null, details: null, licenseType: "type-1", user: "0x1111111111111111111111111111111111111111" }));
    const migrated = reducer(legacy, migrateLicense({ kind: "2026-pro", user: DID, details: '{"issuedBy":"0x2"}' }));
    expect(err(migrated)).toBeUndefined();
    expect(migrated.state.global).toMatchObject({ kind: "2026-pro", user: DID, details: '{"issuedBy":"0x2"}' });
    expect(err(reducer(migrated, migrateLicense({ kind: "x", user: DID })))).toBe("this license already carries a kind");
    expect(reducer(legacy, migrateLicense({ kind: "k", user: DID })).state.global.details).toBeNull();
    expect(err(reducer(utils.createDocument(), migrateLicense({ kind: "k", user: DID })))).toBe("this license has not been issued");
  });
});
```

- [ ] **Step 5: Keep the current keeper reading legacy licences**

Until Task 9 swaps the keeper, `reads.ts` still keys licences on a licence-type id. New documents no longer store `licenseType` in state, and the old publisher-grant path (still live until Task 11) now lands it in `details`. In `subgraphs/vetra-licensing/reads.ts` add:

```ts
/**
 * The licence-type id a pre-terms licence was issued against. Stored state
 * written before the reshape has `licenseType`; a licence issued (or replayed)
 * through the reshaped reducer carries it in details.legacyLicenseType.
 */
export function legacyLicenseTypeOf(g: Record<string, unknown>): string | null {
  const direct = typeof g.licenseType === "string" ? g.licenseType : null;
  if (direct) return direct;
  if (typeof g.details !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(g.details);
    if (typeof parsed === "object" && parsed !== null) {
      const v = (parsed as Record<string, unknown>).legacyLicenseType;
      return typeof v === "string" ? v : null;
    }
  } catch {
    // details is free text on non-legacy licences.
  }
  return null;
}
```

and in `parseLicense` replace `licenseTypeId: str(g.licenseType),` with `licenseTypeId: legacyLicenseTypeOf(g),`.

Add to `subgraphs/vetra-licensing/__tests__/reads.test.ts`:

```ts
import { legacyLicenseTypeOf } from "../reads.js";

describe("legacyLicenseTypeOf", () => {
  it("prefers stored licenseType, then details.legacyLicenseType", () => {
    expect(legacyLicenseTypeOf({ licenseType: "t1", details: '{"legacyLicenseType":"t2"}' })).toBe("t1");
    expect(legacyLicenseTypeOf({ details: '{"legacyLicenseType":"t2"}' })).toBe("t2");
  });
  it("is null for free-text, non-object or missing details", () => {
    expect(legacyLicenseTypeOf({ details: "not json" })).toBeNull();
    expect(legacyLicenseTypeOf({ details: "42" })).toBeNull();
    expect(legacyLicenseTypeOf({ details: '{"legacyLicenseType":7}' })).toBeNull();
    expect(legacyLicenseTypeOf({})).toBeNull();
  });
});
```

The existing `issuePublisherGrant` keeps sending `licenseType` and `issuedBy` (both still accepted, now optional) — leave it until Task 6/11. Fix any test that asserts `state.licenseType` or `state.issuedBy` on a licence document to assert on `legacyLicenseTypeOf(state)` instead (`grep -rn "issuedBy\|\.licenseType" subgraphs/vetra-licensing/__tests__`).

- [ ] **Step 6: Run and commit**

Run: `npx vitest run document-models/app-owner-license subgraphs/vetra-licensing document-models/vetra-app/v1/tests/spec-sync.test.ts && npm run test:coverage && npm run tsc && npm run lint:fix`
Expected: all green, `lifecycle.ts` 100 % branches.

```bash
git add document-models/app-owner-license subgraphs/vetra-licensing powerhouse.manifest.json
git commit -m "feat(licensing): licences carry a term kind and a DID holder"
```

---

### Task 3: DID normalisation

**Files:**
- Create: `subgraphs/vetra-licensing/did.ts`
- Test: `subgraphs/vetra-licensing/__tests__/did.test.ts`

**Interfaces:**
- Produces: `class UnsupportedDidError extends Error`; `normaliseUserDid(input: string): string` (returns `did:pkh:eip155:1:<lowercased>`, throws `UnsupportedDidError`); `addressOfDid(did: string): string` (lowercased `0x…`, throws `UnsupportedDidError`); `callerDid(ctx: { user?: { address?: string } }): string | null`; `didForAddress(address: string): string`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import {
  UnsupportedDidError,
  addressOfDid,
  callerDid,
  didForAddress,
  normaliseUserDid,
} from "../did.js";

const ADDR = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
const DID = `did:pkh:eip155:1:${ADDR.toLowerCase()}`;

describe("normaliseUserDid", () => {
  it.each([
    [ADDR],
    [ADDR.toLowerCase()],
    [`did:pkh:eip155:1:${ADDR}`],
    [`did:pkh:eip155:137:${ADDR}`],
    [`  ${DID}  `],
  ])("normalises %s to chain 1 lowercased", (input) => {
    expect(normaliseUserDid(input)).toBe(DID);
  });

  it.each([
    ["did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"],
    ["did:pkh:solana:4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZ:abc"],
    ["0x123"],
    [""],
    ["did:pkh:eip155:x:0xabcdef0123456789abcdef0123456789abcdef01"],
  ])("refuses %s", (input) => {
    expect(() => normaliseUserDid(input)).toThrow(UnsupportedDidError);
  });
});

describe("addressOfDid / didForAddress / callerDid", () => {
  it("round-trips", () => {
    expect(addressOfDid(DID)).toBe(ADDR.toLowerCase());
    expect(didForAddress(ADDR)).toBe(DID);
  });
  it("builds the caller's DID from the bearer address, ignoring its chain", () => {
    expect(callerDid({ user: { address: ADDR } })).toBe(DID);
    expect(callerDid({})).toBeNull();
    expect(callerDid({ user: { address: "" } })).toBeNull();
  });
  it("refuses a non-pkh DID in addressOfDid", () => {
    expect(() => addressOfDid("did:key:z6Mk")).toThrow(UnsupportedDidError);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run subgraphs/vetra-licensing/__tests__/did.test.ts`
Expected: FAIL, cannot resolve `../did.js`.

- [ ] **Step 3: Implement**

`subgraphs/vetra-licensing/did.ts`:

```ts
export class UnsupportedDidError extends Error {
  override name = "UnsupportedDidError";
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const PKH = /^did:pkh:eip155:(\d+):(0x[0-9a-fA-F]{40})$/;

/**
 * Every licence, grant, allow-list entry and redemption keys its holder on one
 * spelling: did:pkh:eip155:1:<lowercased address>. Renown issues bearers on
 * several chains for the same wallet; a holder is a wallet, not a chain, so
 * the chain is normalised away. Anything that is not an EVM wallet is refused:
 * an environment owner must be an address.
 */
export function normaliseUserDid(input: string): string {
  const s = input.trim();
  if (ADDRESS.test(s)) return didForAddress(s);
  const m = PKH.exec(s);
  if (m) return didForAddress(m[2]!);
  throw new UnsupportedDidError(
    `${input} is not a did:pkh:eip155 DID or a 0x address`,
  );
}

export function didForAddress(address: string): string {
  return `did:pkh:eip155:1:${address.toLowerCase()}`;
}

export function addressOfDid(did: string): string {
  return normaliseUserDid(did).slice("did:pkh:eip155:1:".length);
}

/** The authenticated caller's DID, or null when the request carries no user. */
export function callerDid(ctx: { user?: { address?: string } }): string | null {
  const address = ctx.user?.address;
  return address ? didForAddress(address) : null;
}
```

- [ ] **Step 4: Run, check, commit**

Run: `npx vitest run subgraphs/vetra-licensing/__tests__/did.test.ts && npm run tsc && npm run lint:fix` → PASS.

```bash
git add subgraphs/vetra-licensing/did.ts subgraphs/vetra-licensing/__tests__/did.test.ts
git commit -m "feat(licensing): one DID spelling for every licence holder"
```

---

### Task 4: Licensing tables (forward-only)

**Files:**
- Modify: `subgraphs/vetra-licensing/db/schema.ts`
- Modify: `subgraphs/vetra-licensing/db/migrations.ts`
- Test: `subgraphs/vetra-licensing/__tests__/migrations.test.ts`

**Interfaces:**
- Produces (in `VetraLicensingDB`): `license_chain`, `license_environments`, `app_allow_list`, `invite_codes`, `invite_redemptions`, `environment_reporting_tokens`, `licensing_migration_type_map`, `licensing_migration_steps`; `app_license_grants` gains `kind: string | null`, `user_did: string | null`. Exact row types below; every later task uses these names.

- [ ] **Step 1: Add the row types**

Append to `subgraphs/vetra-licensing/db/schema.ts` and extend the existing interfaces:

```ts
// AppLicenseGrants gains (both nullable: rows written before this change have neither):
//   kind: string | null;        the term kind the licence was issued on
//   user_did: string | null;    did:pkh:eip155:1:<address>

/** Which chain a licence belongs to. An upgrade/grace licence points at its predecessor's root. */
export interface LicenseChain {
  license_id: string;
  root_license_id: string;
  app_id: string;
  /** Project name the owner chose; becomes the environment label. */
  label: string | null;
  created_at: string;
}

/**
 * One DEDICATED environment per licence chain. Keyed on the environment;
 * root_license_id is UNIQUE and is the claim lock (one chain, one environment).
 * Supersedes app_user_environments, which stays in place, read-only.
 */
export interface LicenseEnvironments {
  environment_id: string;
  root_license_id: string;
  app_id: string;
  user_did: string;
  /** The licence currently justifying the environment (the chain head). */
  license_id: string;
  template_id: string | null;
  label: string | null;
  template_hash: string;
  /** First moment the keeper saw the chain without an ACTIVE licence. */
  ended_at: string | null;
  stopped_at: string | null;
  delete_after: string | null;
  created_at: string;
  updated_at: string;
}

export interface AppAllowList {
  app_id: string;
  user_did: string;
  added_at: string;
}

/** An invite code issues one term (kind) of one app. Moved from vetra-access-codes. */
export interface InviteCodes {
  code: string;
  app_id: string;
  kind: string;
  label: string | null;
  active: boolean;
  expires_at: string | null;
  max_uses: number | null;
  /** OpenBao transit ciphertext of an attached Claude key; never returned. */
  anthropic_key_ciphertext: string | null;
  created_at: string;
}

export interface InviteRedemptions {
  code: string;
  user_did: string;
  redeemed_at: string;
  access_expires: string | null;
  /** Null only while a redemption is reserved and its licence not yet issued. */
  license_id: string | null;
}

/** sha256 of the per-environment reporting token written into the environment's secrets. */
export interface EnvironmentReportingTokens {
  environment_id: string;
  token_hash: string;
  created_at: string;
}

/** Durable licence-type -> term mapping, so the migration is restartable after types are deleted. */
export interface LicensingMigrationTypeMap {
  license_type_id: string;
  app_id: string;
  kind: string;
  template_id: string;
  term_id: string;
  created_at: string;
}

export interface LicensingMigrationSteps {
  step: string;
  completed_at: string;
  detail: string | null;
}
```

Add `kind: string | null; user_did: string | null;` to `AppLicenseGrants`, and to `VetraLicensingDB`:

```ts
  license_chain: LicenseChain;
  license_environments: LicenseEnvironments;
  app_allow_list: AppAllowList;
  invite_codes: InviteCodes;
  invite_redemptions: InviteRedemptions;
  environment_reporting_tokens: EnvironmentReportingTokens;
  licensing_migration_type_map: LicensingMigrationTypeMap;
  licensing_migration_steps: LicensingMigrationSteps;
```

- [ ] **Step 2: Write the failing migration tests**

Append to `subgraphs/vetra-licensing/__tests__/migrations.test.ts` (inside the existing `describe`, reusing `open()`):

```ts
  it("adds kind and user_did to app_license_grants and keeps old rows", async () => {
    const d = await open();
    await d.insertInto("app_license_grants").values({
      license_id: "l1", app_id: "a", license_type_id: "t", user_address: "0x1",
      issued_by: "0x2", created_at: "2026-01-01T00:00:00.000Z", kind: null, user_did: null,
    }).execute();
    await up(d as Kysely<any>); // second run: duplicate-column swallowed
    const row = await d.selectFrom("app_license_grants").selectAll().executeTakeFirstOrThrow();
    expect(row).toMatchObject({ license_id: "l1", kind: null, user_did: null });
  });

  it("makes root_license_id the license_environments claim lock", async () => {
    const d = await open();
    const env = (environment_id: string) => ({
      environment_id, root_license_id: "root", app_id: "a", user_did: "did:pkh:eip155:1:0x1",
      license_id: "root", template_id: null, label: null, template_hash: "unapplied",
      ended_at: null, stopped_at: null, delete_after: null,
      created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    });
    await d.insertInto("license_environments").values(env("e1")).execute();
    await d.insertInto("license_environments").values(env("e2"))
      .onConflict((oc) => oc.column("root_license_id").doNothing()).execute();
    const rows = await d.selectFrom("license_environments").selectAll().execute();
    expect(rows.map((r) => r.environment_id)).toStrictEqual(["e1"]);
  });

  it("keys redemptions on (code, user_did) and allow-list on (app_id, user_did)", async () => {
    const d = await open();
    const r = { code: "c", user_did: "u", redeemed_at: "t", access_expires: null, license_id: null };
    await d.insertInto("invite_redemptions").values(r).execute();
    await expect(d.insertInto("invite_redemptions").values(r).execute()).rejects.toThrow(/duplicate key|unique/i);
    const a = { app_id: "a", user_did: "u", added_at: "t" };
    await d.insertInto("app_allow_list").values(a).execute();
    await expect(d.insertInto("app_allow_list").values(a).execute()).rejects.toThrow(/duplicate key|unique/i);
  });

  it("makes reporting token hashes unique", async () => {
    const d = await open();
    await d.insertInto("environment_reporting_tokens").values({ environment_id: "e1", token_hash: "h", created_at: "t" }).execute();
    await expect(
      d.insertInto("environment_reporting_tokens").values({ environment_id: "e2", token_hash: "h", created_at: "t" }).execute(),
    ).rejects.toThrow(/duplicate key|unique/i);
  });
```

Change the existing "is clean to run up() again, and down() then up()" test to insert into every new table too and assert they are empty after `down(); up()`.

- [ ] **Step 3: Run to see them fail**

Run: `npx vitest run subgraphs/vetra-licensing/__tests__/migrations.test.ts`
Expected: FAIL (`relation "license_environments" does not exist`, unknown column `kind`).

- [ ] **Step 4: Implement**

At the end of `up()` in `subgraphs/vetra-licensing/db/migrations.ts` (after the existing statements, which stay unchanged):

```ts
  await addColumnIfMissing(db, "app_license_grants", "kind", "varchar(255)");
  await addColumnIfMissing(db, "app_license_grants", "user_did", "varchar(255)");
  await db.schema.createIndex("app_license_grants_user_did_idx").on("app_license_grants")
    .column("user_did").ifNotExists().execute();

  await db.schema.createTable("license_chain")
    .addColumn("license_id", "varchar(255)", (c) => c.notNull())
    .addColumn("root_license_id", "varchar(255)", (c) => c.notNull())
    .addColumn("app_id", "varchar(255)", (c) => c.notNull())
    .addColumn("label", "varchar(255)")
    .addColumn("created_at", "varchar(255)", (c) => c.notNull())
    .addPrimaryKeyConstraint("license_chain_pkey", ["license_id"])
    .ifNotExists().execute();
  await db.schema.createIndex("license_chain_root_idx").on("license_chain")
    .column("root_license_id").ifNotExists().execute();

  await db.schema.createTable("license_environments")
    .addColumn("environment_id", "varchar(255)", (c) => c.notNull())
    .addColumn("root_license_id", "varchar(255)", (c) => c.notNull())
    .addColumn("app_id", "varchar(255)", (c) => c.notNull())
    .addColumn("user_did", "varchar(255)", (c) => c.notNull())
    .addColumn("license_id", "varchar(255)", (c) => c.notNull())
    .addColumn("template_id", "varchar(255)")
    .addColumn("label", "varchar(255)")
    .addColumn("template_hash", "varchar(64)", (c) => c.notNull())
    .addColumn("ended_at", "varchar(255)")
    .addColumn("stopped_at", "varchar(255)")
    .addColumn("delete_after", "varchar(255)")
    .addColumn("created_at", "varchar(255)", (c) => c.notNull())
    .addColumn("updated_at", "varchar(255)", (c) => c.notNull())
    .addPrimaryKeyConstraint("license_environments_pkey", ["environment_id"])
    .addUniqueConstraint("license_environments_root_key", ["root_license_id"])
    .ifNotExists().execute();
  for (const col of ["app_id", "license_id"] as const) {
    await db.schema.createIndex(`license_environments_${col}_idx`).on("license_environments")
      .column(col).ifNotExists().execute();
  }

  await db.schema.createTable("app_allow_list")
    .addColumn("app_id", "varchar(255)", (c) => c.notNull())
    .addColumn("user_did", "varchar(255)", (c) => c.notNull())
    .addColumn("added_at", "varchar(255)", (c) => c.notNull())
    .addPrimaryKeyConstraint("app_allow_list_pkey", ["app_id", "user_did"])
    .ifNotExists().execute();

  await db.schema.createTable("invite_codes")
    .addColumn("code", "varchar(255)", (c) => c.notNull())
    .addColumn("app_id", "varchar(255)", (c) => c.notNull())
    .addColumn("kind", "varchar(255)", (c) => c.notNull())
    .addColumn("label", "varchar(255)")
    .addColumn("active", "boolean", (c) => c.notNull().defaultTo(true))
    .addColumn("expires_at", "varchar(255)")
    .addColumn("max_uses", "integer")
    .addColumn("anthropic_key_ciphertext", "text")
    .addColumn("created_at", "varchar(255)", (c) => c.notNull())
    .addPrimaryKeyConstraint("invite_codes_pkey", ["code"])
    .ifNotExists().execute();
  await db.schema.createIndex("invite_codes_app_id_idx").on("invite_codes")
    .column("app_id").ifNotExists().execute();

  await db.schema.createTable("invite_redemptions")
    .addColumn("code", "varchar(255)", (c) => c.notNull())
    .addColumn("user_did", "varchar(255)", (c) => c.notNull())
    .addColumn("redeemed_at", "varchar(255)", (c) => c.notNull())
    .addColumn("access_expires", "varchar(255)")
    .addColumn("license_id", "varchar(255)")
    .addPrimaryKeyConstraint("invite_redemptions_pkey", ["code", "user_did"])
    .ifNotExists().execute();
  await db.schema.createIndex("invite_redemptions_user_did_idx").on("invite_redemptions")
    .column("user_did").ifNotExists().execute();

  await db.schema.createTable("environment_reporting_tokens")
    .addColumn("environment_id", "varchar(255)", (c) => c.notNull())
    .addColumn("token_hash", "varchar(64)", (c) => c.notNull())
    .addColumn("created_at", "varchar(255)", (c) => c.notNull())
    .addPrimaryKeyConstraint("environment_reporting_tokens_pkey", ["environment_id"])
    .addUniqueConstraint("environment_reporting_tokens_hash_key", ["token_hash"])
    .ifNotExists().execute();

  await db.schema.createTable("licensing_migration_type_map")
    .addColumn("license_type_id", "varchar(255)", (c) => c.notNull())
    .addColumn("app_id", "varchar(255)", (c) => c.notNull())
    .addColumn("kind", "varchar(255)", (c) => c.notNull())
    .addColumn("template_id", "varchar(255)", (c) => c.notNull())
    .addColumn("term_id", "varchar(255)", (c) => c.notNull())
    .addColumn("created_at", "varchar(255)", (c) => c.notNull())
    .addPrimaryKeyConstraint("licensing_migration_type_map_pkey", ["license_type_id"])
    .ifNotExists().execute();

  await db.schema.createTable("licensing_migration_steps")
    .addColumn("step", "varchar(64)", (c) => c.notNull())
    .addColumn("completed_at", "varchar(255)", (c) => c.notNull())
    .addColumn("detail", "text")
    .addPrimaryKeyConstraint("licensing_migration_steps_pkey", ["step"])
    .ifNotExists().execute();
```

and above `up()`:

```ts
/** Postgres SQLSTATE for "column already exists". */
const DUPLICATE_COLUMN = "42701";

/** addColumn has no IF NOT EXISTS; the boot-time runner calls up() on every start. */
async function addColumnIfMissing(
  db: Kysely<any>,
  table: string,
  column: string,
  type: "varchar(255)" | "text",
): Promise<void> {
  try {
    await db.schema.alterTable(table).addColumn(column, type).execute();
  } catch (error) {
    if ((error as { code?: string })?.code !== DUPLICATE_COLUMN) throw error;
  }
}
```

Extend `down()` (used only by tests) to drop the eight new tables before the existing drops (`dropTable(name).ifExists()`); it must not touch `app_license_grants` columns beyond the existing full drop.

- [ ] **Step 5: Run, check, commit**

Run: `npx vitest run subgraphs/vetra-licensing/__tests__/migrations.test.ts && npm run tsc && npm run lint:fix`
Expected: PASS. Then `npx vitest run subgraphs/vetra-licensing` — still green (the existing code writes `app_license_grants` without `kind`/`user_did`; add `kind: null, user_did: null` to `recordGrant`'s insert in `index.ts` if tsc demands it).

```bash
git add subgraphs/vetra-licensing/db subgraphs/vetra-licensing/__tests__/migrations.test.ts subgraphs/vetra-licensing/index.ts
git commit -m "feat(licensing): tables for chains, invite codes, allow lists and reporting tokens"
```

---

### Task 5: App document reads, a generic document gateway, and owner lookup with document fallback

The licensing subgraph now reads terms and templates from the app document and writes licensing operations to it. The vetra-studio app (Task 16) exists only as a document, with no `apps` row, so publisher ownership must fall back to the document.

This task also fixes a live bug: `reads.ts parseTemplate` drops `artifactName` / `artifactChannel` from every template service, so an artifact-backed FUSION service is never resolved and `validateTemplate` throws `UnresolvedFusionServiceError` on every tick. The new parser keeps both fields.

**Files:**
- Create: `subgraphs/vetra-licensing/doc-parse.ts`, `subgraphs/vetra-licensing/doc-gateway.ts`, `subgraphs/vetra-licensing/app-reads.ts`, `subgraphs/vetra-licensing/owner-apps.ts`
- Modify: `subgraphs/vetra-licensing/reads.ts` (import helpers from `doc-parse.ts`; `appArtifacts` delegates to `app-reads.ts`), `subgraphs/vetra-licensing/license-gateway.ts` and `license-type-gateway.ts` (use `doc-gateway.ts`), `subgraphs/vetra-licensing/index.ts` (owner lookup wiring)
- Test: `subgraphs/vetra-licensing/__tests__/app-reads.test.ts`, `__tests__/doc-gateway.test.ts`, `__tests__/owner-apps.test.ts`

**Interfaces:**
- Consumes: `LicenseClientLike` (`reads.ts`), `LicenseGatewayClientLike` (`license-gateway.ts`), `TemplateShape`, `templateHash` (`template.ts`), `resolveTemplateArtifacts`, `templateNeedsArtifacts` (`artifact-resolution.ts`), `OwnerAppRecord`, `PublisherAuthDeps` (`publisher-auth.ts`).
- Produces:
  - `doc-parse.ts`: `isRec(v): v is Record<string, unknown>`, `str(v): string | null`, `docId(doc): string | null`, `isDocType(doc, type): boolean`, `globalState(doc): Record<string, unknown> | null`.
  - `doc-gateway.ts`: `interface DocGateway { create(): Promise<string>; execute(id: string, actions: Action[]): Promise<void> }`; `createReactorDocGateway(client: LicenseGatewayClientLike, docType: string, noun: string): DocGateway` (throws `OperationRejectedError` on a rejected or unapplied action, `Error("<noun> <id> not found")` on a missing document).
  - `app-reads.ts`: `APP_DOC_TYPE = "powerhouse/vetra-app"`; `type TemplateMode = "SHARED" | "DEDICATED"`; `interface AppTemplateView { id: string; name: string | null; mode: TemplateMode; sharedEnvironment: string | null; template: TemplateShape; templateHash: string; resolutionError: string | null }`; `interface AppTermView { id: string; kind: string; label: string | null; templateId: string | null; validityDays: number | null; issuers: string[]; status: "DRAFT" | "ACTIVE" | "RETIRED" }`; `interface AppDocView { id: string; name: string | null; slug: string | null; owner: string | null; status: string; identityDid: string | null; productionEnvironmentId: string | null; templates: AppTemplateView[]; terms: AppTermView[]; artifacts: AppArtifact[] }`; `parseAppDocument(doc: unknown): AppDocView | null`; `type KindResolution = { ok: true; term: AppTermView; template: AppTemplateView; stage: string | null; label: string } | { ok: false; reason: string }`; `resolveKind(app: AppDocView, kind: string | null): KindResolution`; `interface AppReads { app(id: string): Promise<AppDocView | null>; appBySlug(slug: string): Promise<AppDocView | null>; appsOwnedBy(address: string): Promise<AppDocView[]> }`; `createAppReads(client: LicenseClientLike): AppReads`.
  - `owner-apps.ts`: `createOwnerAppLookup(deps: { table: { byId(id: string): Promise<OwnerAppRecord | null>; byOwner(address: string): Promise<OwnerAppRecord[]> }; apps: Pick<AppReads, "app" | "appsOwnedBy"> }): PublisherAuthDeps`.

- [ ] **Step 1: Extract the parse helpers**

Create `subgraphs/vetra-licensing/doc-parse.ts` by moving `isRec`, `str`, `docId`, `isDocType`, `globalState` out of `reads.ts` verbatim and exporting them; `reads.ts` imports them. Run `npx vitest run subgraphs/vetra-licensing/__tests__/reads.test.ts` → still PASS.

- [ ] **Step 2: Write the failing tests**

`subgraphs/vetra-licensing/__tests__/app-reads.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createAppReads, parseAppDocument, resolveKind, APP_DOC_TYPE } from "../app-reads.js";

const appDoc = (id: string, global: Record<string, unknown>) => ({
  header: { id, documentType: APP_DOC_TYPE },
  state: { global },
});

const KV = appDoc("app-kv", {
  name: "Knowledge Vault", slug: "knowledge-vault", owner: "0xowner", status: "ACTIVE",
  identity: { did: "did:key:zApp", expiresAt: null },
  productionEnvironmentId: "env-prod",
  artifacts: [{
    id: "FUSION_IMAGE:kv", kind: "FUSION_IMAGE", name: "kv",
    versions: [{ version: "1.2.0", reference: "cr.vetra.io/p/kv:1.2.0" }],
    channels: [{ channel: "LATEST", version: "1.2.0" }],
  }],
  templates: [
    { id: "t-pro", name: "Pro", mode: "DEDICATED", sharedEnvironment: null,
      services: [{ id: "s1", type: "FUSION", prefix: "kv", artifactName: "kv", artifactChannel: "LATEST" }],
      packages: [{ id: "p1", packageName: "@kv/pkg", version: null }],
      size: null, baseDomain: null, packageRegistry: null },
    { id: "t-free", name: null, mode: "SHARED", sharedEnvironment: null, services: [], packages: [],
      size: null, baseDomain: null, packageRegistry: null },
    { id: "t-broken", name: null, mode: "DEDICATED", sharedEnvironment: null,
      services: [{ id: "s", type: "FUSION", prefix: null, artifactName: "gone", artifactChannel: "LATEST" }],
      packages: [], size: null, baseDomain: null, packageRegistry: null },
  ],
  terms: [
    { id: "k1", kind: "2026-pro", label: "Pro", templateId: "t-pro", validityDays: 30, issuers: ["PUBLISHER_GRANT"], status: "ACTIVE" },
    { id: "k2", kind: "2026-free", label: null, templateId: "t-free", validityDays: null, issuers: ["INVITE_CODE"], status: "RETIRED" },
    { id: "k3", kind: "draft", label: null, templateId: "t-pro", validityDays: null, issuers: [], status: "DRAFT" },
    { id: "k4", kind: "orphan", label: null, templateId: "t-deleted", validityDays: null, issuers: ["INVITE_CODE"], status: "ACTIVE" },
    { id: "k5", kind: "broken", label: null, templateId: "t-broken", validityDays: null, issuers: ["INVITE_CODE"], status: "ACTIVE" },
  ],
});

describe("parseAppDocument", () => {
  it("keeps artifact references on template services and resolves them", () => {
    const app = parseAppDocument(KV)!;
    const pro = app.templates.find((t) => t.id === "t-pro")!;
    expect(pro.template.services[0]).toMatchObject({
      artifactName: "kv", artifactChannel: "LATEST",
      resolvedVersion: "1.2.0", resolvedRepository: "cr.vetra.io/p/kv",
    });
    expect(pro.resolutionError).toBeNull();
    expect(pro.templateHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reports an unresolvable artifact instead of throwing", () => {
    const broken = parseAppDocument(KV)!.templates.find((t) => t.id === "t-broken")!;
    expect(broken.resolutionError).toMatch(/has not published/);
  });

  it("treats a pre-licensing app document as having no templates or terms", () => {
    const app = parseAppDocument(appDoc("old", { status: "ACTIVE", artifacts: [] }))!;
    expect(app.templates).toStrictEqual([]);
    expect(app.terms).toStrictEqual([]);
  });

  it("refuses something that is not an app document", () => {
    expect(parseAppDocument({ header: { id: "x", documentType: "powerhouse/app-owner-license" }, state: { global: {} } })).toBeNull();
    expect(parseAppDocument(null)).toBeNull();
  });
});

describe("resolveKind", () => {
  const app = parseAppDocument(KV)!;
  it("resolves a DEDICATED term with its label", () => {
    const r = resolveKind(app, "2026-pro");
    expect(r).toMatchObject({ ok: true, stage: null, label: "Pro" });
  });
  it("resolves a RETIRED SHARED term to the App Environment", () => {
    expect(resolveKind(app, "2026-free")).toMatchObject({ ok: true, stage: "env-prod", label: "2026-free" });
  });
  it.each([
    [null, "licence has no kind"],
    ["nope", "kind nope is not a term of app app-kv"],
    ["draft", "term draft is DRAFT"],
    ["orphan", "term orphan points at missing template t-deleted"],
  ])("refuses %s", (kind, reason) => {
    expect(resolveKind(app, kind)).toStrictEqual({ ok: false, reason });
  });
  it("refuses a DEDICATED template whose artifacts do not resolve", () => {
    const r = resolveKind(app, "broken");
    expect(r.ok).toBe(false);
  });
});

describe("createAppReads", () => {
  const docs = [KV, appDoc("app-other", { slug: "other", owner: "0xOWNER", status: "ACTIVE" })];
  const client = {
    async find() { return { results: docs }; },
    async get(id: string) {
      const d = docs.find((x) => x.header.id === id);
      if (!d) { const e = new Error(`Document not found: ${id}`); throw e; }
      return d;
    },
  };
  const reads = createAppReads(client);
  it("gets by id, null when missing", async () => {
    expect((await reads.app("app-kv"))?.name).toBe("Knowledge Vault");
    expect(await reads.app("missing")).toBeNull();
  });
  it("finds by slug and by owner (case-insensitive)", async () => {
    expect((await reads.appBySlug("other"))?.id).toBe("app-other");
    expect((await reads.appsOwnedBy("0xowner")).map((a) => a.id).sort()).toStrictEqual(["app-kv", "app-other"]);
  });
});
```

`subgraphs/vetra-licensing/__tests__/doc-gateway.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createReactorDocGateway } from "../doc-gateway.js";
import { OperationRejectedError } from "../publisher-errors.js";

function client(opsAfter: { error?: string; action: { id: string; type: string } }[], exists = true) {
  return {
    createEmpty: async () => ({ header: { id: "new-id" } }),
    execute: async () => undefined,
    get: async (id: string) => {
      if (!exists) throw new Error(`Document not found: ${id}`);
      return { header: { revision: { global: 3 } } };
    },
    getOperations: async () => ({ results: opsAfter }),
  };
}
const act = { id: "a1", type: "ADD_TERM", input: {}, scope: "global" } as never;

describe("createReactorDocGateway", () => {
  it("creates and returns the id", async () => {
    expect(await createReactorDocGateway(client([]), "powerhouse/vetra-app", "app").create()).toBe("new-id");
  });
  it("passes when every action was applied cleanly", async () => {
    await expect(createReactorDocGateway(client([{ action: { id: "a1", type: "ADD_TERM" } }]), "t", "app").execute("d", [act])).resolves.toBeUndefined();
  });
  it("throws OperationRejectedError with the reducer message", async () => {
    const gw = createReactorDocGateway(client([{ error: "kind x is already used by this app", action: { id: "a1", type: "ADD_TERM" } }]), "t", "app");
    await expect(gw.execute("d", [act])).rejects.toThrow(new OperationRejectedError("ADD_TERM rejected: kind x is already used by this app"));
  });
  it("throws when an action was not applied", async () => {
    await expect(createReactorDocGateway(client([]), "t", "app").execute("d", [act])).rejects.toThrow("ADD_TERM was not applied to app d");
  });
  it("throws for a missing document", async () => {
    await expect(createReactorDocGateway(client([], false), "t", "app").execute("d", [act])).rejects.toThrow("app d not found");
  });
});
```

`subgraphs/vetra-licensing/__tests__/owner-apps.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createOwnerAppLookup } from "../owner-apps.js";
import type { AppDocView } from "../app-reads.js";

const doc = (id: string, owner: string | null, over: Partial<AppDocView> = {}): AppDocView => ({
  id, name: `doc ${id}`, slug: id, owner, status: "ACTIVE", identityDid: null,
  productionEnvironmentId: null, templates: [], terms: [], artifacts: [], ...over,
});

const lookup = createOwnerAppLookup({
  table: {
    byId: async (id) => (id === "row-app" ? { id, name: "row", status: "ACTIVE", owner_address: "0xa" } : null),
    byOwner: async (a) => (a === "0xa" ? [{ id: "row-app", name: "row", status: "ACTIVE", owner_address: "0xa" }] : []),
  },
  apps: {
    app: async (id) => (id === "studio" ? doc("studio", "0xa") : id === "row-app" ? doc("row-app", "0xb") : id === "ownerless" ? doc("ownerless", null) : null),
    appsOwnedBy: async (a) => (a === "0xa" ? [doc("studio", "0xa"), doc("row-app", "0xb")] : []),
  },
});

describe("owner lookup", () => {
  it("prefers the table row: its owner wins over a drifted document", async () => {
    expect(await lookup.findAppById("row-app")).toMatchObject({ owner_address: "0xa", name: "row" });
  });
  it("falls back to the document for a document-only app", async () => {
    expect(await lookup.findAppById("studio")).toStrictEqual({ id: "studio", name: "doc studio", status: "ACTIVE", owner_address: "0xa" });
  });
  it("never resolves an ownerless document as owned", async () => {
    expect(await lookup.findAppById("ownerless")).toMatchObject({ owner_address: "" });
    expect(await lookup.findAppById("nope")).toBeNull();
  });
  it("lists table rows plus document-only apps, without duplicates", async () => {
    expect((await lookup.listAppsForOwner("0xa")).map((a) => a.id)).toStrictEqual(["row-app", "studio"]);
  });
});
```

- [ ] **Step 3: Run to see them fail**

Run: `npx vitest run subgraphs/vetra-licensing/__tests__/app-reads.test.ts subgraphs/vetra-licensing/__tests__/doc-gateway.test.ts subgraphs/vetra-licensing/__tests__/owner-apps.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 4: Implement `doc-gateway.ts`**

```ts
import type { Action } from "document-model";
import { isDocumentNotFound } from "../vetra-apps/envs.js";
import type { LicenseGatewayClientLike } from "./license-gateway.js";
import { OperationRejectedError } from "./publisher-errors.js";

export interface DocGateway {
  create(): Promise<string>;
  /** Applies actions; throws OperationRejectedError if any is rejected or not applied. */
  execute(id: string, actions: Action[]): Promise<void>;
}

type DocLike = { header?: { revision?: Record<string, number> } };
type OpLike = { error?: string; action?: { id?: string; type?: string } };

/**
 * execute() returns a view without operations, so a reducer rejection is only
 * visible on the appended operations. One copy of that check for every
 * licensing document type (licences, app documents, legacy licence types).
 */
export function createReactorDocGateway(
  client: LicenseGatewayClientLike,
  docType: string,
  noun: string,
): DocGateway {
  async function getDoc(id: string): Promise<DocLike | null> {
    try {
      return ((await client.get(id)) as DocLike | null) ?? null;
    } catch (err) {
      if (isDocumentNotFound(err)) return null;
      throw err;
    }
  }
  return {
    async create() {
      const doc = await client.createEmpty(docType, {});
      return (doc.header as { id: string }).id;
    },
    async execute(id, acts) {
      const before = await getDoc(id);
      if (!before) throw new Error(`${noun} ${id} not found`);
      const sinceRevision = before.header?.revision?.global ?? 0;
      await client.execute(id, "main", acts);
      const appended: OpLike[] = [];
      let cursor = "0";
      for (let page = 0; page < 20; page++) {
        const res = await client.getOperations(
          id,
          { branch: "main", scopes: ["global"] },
          { sinceRevision },
          { cursor, limit: 200 },
        );
        appended.push(...(res.results as OpLike[]));
        if (!res.nextCursor || res.results.length === 0) break;
        cursor = res.nextCursor;
      }
      for (const action of acts) {
        const mine = appended.find((op) => op.action?.id === action.id);
        if (!mine) {
          throw new OperationRejectedError(`${action.type} was not applied to ${noun} ${id}`);
        }
        if (mine.error) {
          throw new OperationRejectedError(`${action.type} rejected: ${mine.error}`);
        }
      }
    },
  };
}
```

Rewrite `license-gateway.ts` to build on it (`const docs = createReactorDocGateway(client, LICENSE_DOC_TYPE, "license")`; `activate: (id) => docs.execute(id, [actions.activateLicense({})])`, `expire` likewise, `create: docs.create`, `execute: docs.execute`), and `license-type-gateway.ts` to `return createReactorDocGateway(client, LICENSE_TYPE_DOC_TYPE, "license type")`. Their existing tests keep passing (same messages).

- [ ] **Step 5: Implement `app-reads.ts`**

```ts
import { isDocumentNotFound } from "../vetra-apps/envs.js";
import { docId, globalState, isDocType, isRec, str } from "./doc-parse.js";
import type { AppArtifact, LicenseClientLike } from "./reads.js";
import { templateHash, type TemplateService, type TemplateShape } from "./template.js";
import { resolveTemplateArtifacts, templateNeedsArtifacts } from "./artifact-resolution.js";

export const APP_DOC_TYPE = "powerhouse/vetra-app";
export type TemplateMode = "SHARED" | "DEDICATED";

export interface AppTemplateView {
  id: string;
  name: string | null;
  mode: TemplateMode;
  sharedEnvironment: string | null;
  /** RESOLVED: artifact channels replaced by the version they point at. */
  template: TemplateShape;
  templateHash: string;
  resolutionError: string | null;
}

export interface AppTermView {
  id: string;
  kind: string;
  label: string | null;
  templateId: string | null;
  validityDays: number | null;
  issuers: string[];
  status: "DRAFT" | "ACTIVE" | "RETIRED";
}

export interface AppDocView {
  id: string;
  name: string | null;
  slug: string | null;
  owner: string | null;
  status: string;
  identityDid: string | null;
  productionEnvironmentId: string | null;
  templates: AppTemplateView[];
  terms: AppTermView[];
  artifacts: AppArtifact[];
}

const TERM_STATUSES = ["DRAFT", "ACTIVE", "RETIRED"] as const;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function parseArtifacts(raw: unknown): AppArtifact[] {
  return arr(raw).flatMap((a): AppArtifact[] => {
    if (!isRec(a)) return [];
    const kind = str(a.kind);
    const name = str(a.name);
    if ((kind !== "PACKAGE" && kind !== "FUSION_IMAGE") || !name) return [];
    const versions = arr(a.versions).flatMap((v) => {
      if (!isRec(v)) return [];
      const version = str(v.version);
      const reference = str(v.reference);
      return version && reference ? [{ version, reference }] : [];
    });
    const channels = arr(a.channels).flatMap((c) => {
      if (!isRec(c)) return [];
      const channel = str(c.channel);
      const version = str(c.version);
      return channel && version ? [{ channel, version }] : [];
    });
    return [{ kind, name, versions, channels }];
  });
}

function parseServices(raw: unknown): TemplateService[] {
  return arr(raw).flatMap((s): TemplateService[] => {
    if (!isRec(s)) return [];
    const id = str(s.id);
    const type = str(s.type);
    if (!id || !type) return [];
    return [{
      id,
      type,
      prefix: str(s.prefix),
      artifactName: str(s.artifactName),
      artifactChannel: str(s.artifactChannel),
    }];
  });
}

function parseTemplateView(raw: unknown, artifacts: AppArtifact[]): AppTemplateView | null {
  if (!isRec(raw)) return null;
  const id = str(raw.id);
  const mode = str(raw.mode);
  if (!id || (mode !== "SHARED" && mode !== "DEDICATED")) return null;
  const shape: TemplateShape = {
    services: parseServices(raw.services),
    packages: arr(raw.packages).flatMap((p) => {
      if (!isRec(p)) return [];
      const pid = str(p.id);
      return pid ? [{ id: pid, packageName: str(p.packageName), version: str(p.version) }] : [];
    }),
    size: str(raw.size),
    baseDomain: str(raw.baseDomain),
    packageRegistry: str(raw.packageRegistry),
  };
  let template = shape;
  let resolutionError: string | null = null;
  if (templateNeedsArtifacts(shape)) {
    try {
      template = resolveTemplateArtifacts(shape, artifacts);
    } catch (err) {
      resolutionError = err instanceof Error ? err.message : String(err);
    }
  }
  return {
    id,
    name: str(raw.name),
    mode,
    sharedEnvironment: str(raw.sharedEnvironment),
    template,
    // Over the RESOLVED template: a publish moves a channel, which moves the hash.
    templateHash: templateHash(template),
    resolutionError,
  };
}

function parseTerm(raw: unknown): AppTermView | null {
  if (!isRec(raw)) return null;
  const id = str(raw.id);
  const kind = str(raw.kind);
  const status = TERM_STATUSES.find((s) => s === raw.status);
  if (!id || !kind || !status) return null;
  return {
    id,
    kind,
    label: str(raw.label),
    templateId: str(raw.templateId),
    validityDays: typeof raw.validityDays === "number" ? raw.validityDays : null,
    issuers: arr(raw.issuers).flatMap((i) => (typeof i === "string" ? [i] : [])),
    status,
  };
}

export function parseAppDocument(doc: unknown): AppDocView | null {
  if (!isDocType(doc, APP_DOC_TYPE)) return null;
  const id = docId(doc);
  const g = globalState(doc);
  if (!id || !g) return null;
  const artifacts = parseArtifacts(g.artifacts);
  const identity = isRec(g.identity) ? g.identity : {};
  return {
    id,
    name: str(g.name),
    slug: str(g.slug),
    owner: str(g.owner),
    status: str(g.status) ?? "PENDING_IDENTITY",
    identityDid: str(identity.did),
    productionEnvironmentId: str(g.productionEnvironmentId),
    // A document from before the licensing module has neither list.
    templates: arr(g.templates).flatMap((t) => {
      const v = parseTemplateView(t, artifacts);
      return v ? [v] : [];
    }),
    terms: arr(g.terms).flatMap((t) => {
      const v = parseTerm(t);
      return v ? [v] : [];
    }),
    artifacts,
  };
}

export type KindResolution =
  | { ok: true; term: AppTermView; template: AppTemplateView; stage: string | null; label: string }
  | { ok: false; reason: string };

/**
 * licence kind -> term -> template. A RETIRED term still resolves: retiring
 * blocks new licences, never existing ones. Anything that does not resolve is
 * a reason to HOLD, never to release.
 */
export function resolveKind(app: AppDocView, kind: string | null): KindResolution {
  if (!kind) return { ok: false, reason: "licence has no kind" };
  const term = app.terms.find((t) => t.kind === kind);
  if (!term) return { ok: false, reason: `kind ${kind} is not a term of app ${app.id}` };
  if (term.status === "DRAFT") return { ok: false, reason: `term ${kind} is DRAFT` };
  const template = app.templates.find((t) => t.id === term.templateId);
  if (!template) {
    return { ok: false, reason: `term ${kind} points at missing template ${term.templateId}` };
  }
  if (template.mode === "DEDICATED" && template.resolutionError) {
    return { ok: false, reason: `template ${template.id} cannot be resolved: ${template.resolutionError}` };
  }
  return {
    ok: true,
    term,
    template,
    stage: template.mode === "SHARED" ? (template.sharedEnvironment ?? app.productionEnvironmentId) : null,
    label: term.label ?? term.kind,
  };
}

export interface AppReads {
  app(id: string): Promise<AppDocView | null>;
  appBySlug(slug: string): Promise<AppDocView | null>;
  appsOwnedBy(address: string): Promise<AppDocView[]>;
}

const PAGE_SIZE = 200;

export function createAppReads(client: LicenseClientLike): AppReads {
  async function all(): Promise<AppDocView[]> {
    const out: AppDocView[] = [];
    let cursor = "0";
    for (;;) {
      const page = await client.find({ type: APP_DOC_TYPE }, undefined, { cursor, limit: PAGE_SIZE });
      for (const d of page.results) {
        const v = parseAppDocument(d);
        if (v) out.push(v);
      }
      if (!page.nextCursor || page.nextCursor === cursor) return out;
      cursor = page.nextCursor;
    }
  }
  return {
    async app(id) {
      try {
        return parseAppDocument(await client.get(id));
      } catch (err) {
        if (isDocumentNotFound(err)) return null;
        throw err;
      }
    },
    async appBySlug(slug) {
      return (await all()).find((a) => a.slug === slug) ?? null;
    },
    async appsOwnedBy(address) {
      const want = address.toLowerCase();
      return (await all()).filter((a) => a.owner?.toLowerCase() === want);
    },
  };
}
```

In `reads.ts`, `appArtifacts(appId)` becomes `return (await appReads.app(appId))?.artifacts ?? [];` with `const appReads = createAppReads(client)` inside `createReactorLicenseReads`.

- [ ] **Step 6: Implement `owner-apps.ts` and wire it**

```ts
import type { AppReads } from "./app-reads.js";
import type { OwnerAppRecord, PublisherAuthDeps } from "./publisher-auth.js";

/**
 * Ownership for the publisher surface. The apps table still wins for every app
 * that has a row (apps-as-documents step 2 has not moved reads yet). An app
 * that exists only as a document — the vetra-studio app — falls back to the
 * document. A document without an owner resolves with an empty owner, which
 * resolveOwnerApp can never match: unowned must not read as yours.
 */
export function createOwnerAppLookup(deps: {
  table: {
    byId(id: string): Promise<OwnerAppRecord | null>;
    byOwner(address: string): Promise<OwnerAppRecord[]>;
  };
  apps: Pick<AppReads, "app" | "appsOwnedBy">;
}): PublisherAuthDeps {
  const fromDoc = (d: { id: string; name: string | null; slug: string | null; status: string; owner: string | null }): OwnerAppRecord => ({
    id: d.id,
    name: d.name ?? d.slug ?? d.id,
    status: d.status,
    owner_address: d.owner?.toLowerCase() ?? "",
  });
  return {
    async findAppById(id) {
      const row = await deps.table.byId(id);
      if (row) return row;
      const doc = await deps.apps.app(id);
      return doc ? fromDoc(doc) : null;
    },
    async listAppsForOwner(address) {
      const rows = await deps.table.byOwner(address);
      const seen = new Set(rows.map((r) => r.id));
      const docs = (await deps.apps.appsOwnedBy(address)).filter((d) => !seen.has(d.id));
      // A document whose row exists but names another owner is not listed:
      // the row is the truth for that app.
      const docOnly = [];
      for (const d of docs) {
        if (!(await deps.table.byId(d.id))) docOnly.push(fromDoc(d));
      }
      return [...rows, ...docOnly];
    },
  };
}
```

In `index.ts`, build `const appReads = createAppReads(this.reactorClient as never);` and pass `auth: createOwnerAppLookup({ table: { byId: <existing findAppById query>, byOwner: <existing listAppsForOwner query> }, apps: appReads })` to `createPublisherResolvers`.

- [ ] **Step 7: Run, check, commit**

Run: `npx vitest run subgraphs/vetra-licensing && npm run tsc && npm run lint:fix` → PASS.

```bash
git add subgraphs/vetra-licensing
git commit -m "feat(licensing): read terms and templates from the app document"
```

---

### Task 6: `issueLicense()` and the publisher grant issuer

**Files:**
- Create: `subgraphs/vetra-licensing/issue.ts`, `subgraphs/vetra-licensing/grants.ts`
- Modify: `subgraphs/vetra-licensing/issuers/publisher-grant.ts` (add `grantLicense`, `replaceGrant`; the old `issuePublisherGrant` stays until Task 11), `subgraphs/vetra-licensing/reads.ts` (add `LicenceRecord`, `licenceRecord`, `allLicenceRecords`, `licenceRecords(ids)`), `subgraphs/vetra-licensing/publisher-errors.ts` (move `NotOnAllowListError` here)
- Test: `subgraphs/vetra-licensing/__tests__/issue.test.ts`, `__tests__/grants.test.ts`, `__tests__/issue-reactor.integration.test.ts`

**Interfaces:**
- Consumes: `normaliseUserDid`, `UnsupportedDidError` (Task 3); `AppReads` (Task 5); tables `app_license_grants`, `license_chain`, `app_allow_list` (Task 4); `actions` from `document-models/app-owner-license` (Task 2); `UnknownLicenseError` (`publisher-errors.ts`).
- Produces:
  - `reads.ts`: `interface LicenceRecord { id: string; app: string; user: string; kind: string | null; issuer: string | null; status: LicenseStatusName; issued: string | null; start: string | null; end: string | null; stage: string | null; details: string | null; replacedBy: string | null; legacyLicenseTypeId: string | null }`; `LicenseReads.licenceRecord(id): Promise<LicenceRecord | null>`; `LicenseReads.allLicenceRecords(): Promise<LicenceRecord[]>`; `LicenseReads.licenceRecords(ids: string[]): Promise<LicenceRecord[]>` (missing ids skipped).
  - `grants.ts`: `createGrantStore(db): GrantStore` with `recordGrant({ licenseId, appId, kind, userDid, issuedBy, now })`, `linkChain({ licenseId, rootLicenseId, appId, label, now })`, `chainRootOf(licenseId): Promise<string>`, `chainRoots(): Promise<Map<string, string>>`, `chainLabel(rootLicenseId): Promise<string | null>`, `authorisedIds(): Promise<Set<string>>`, `licenceIdsFor(appId: string | null, userDid: string): Promise<string[]>`, `isOnAllowList(appId, userDid)`, `addToAllowList(appId, userDid, now)`, `removeFromAllowList(appId, userDid): Promise<boolean>`, `allowList(appId): Promise<{ user: string; addedAt: string }[]>`.
  - `issue.ts`: `type IssuerKind = "INVITE_CODE" | "PUBLISHER_GRANT" | "ACHRA_SUBSCRIPTION"`; `class TermNotIssuableError`, `class LicenceNotUpgradableError`, `class AlreadyHoldsError`; `interface IssueDeps { apps: Pick<AppReads, "app">; licence(id: string): Promise<LicenceRecord | null>; createLicenseDocument(): Promise<string>; executeLicence(id: string, actions: Action[]): Promise<void>; grants: Pick<GrantStore, "recordGrant" | "linkChain" | "chainRootOf">; logger: Pick<Console, "warn"> }`; `interface IssueInput { appId: string; user: string; kind: string; issuer: IssuerKind; details: Record<string, unknown>; issuedBy: string; label?: string | null; upgrades?: string | null; now: string }`; `interface IssuedLicence { licenseId: string; user: string; end: string | null; replaced: string | null }`; `issueLicense(deps: IssueDeps, input: IssueInput): Promise<IssuedLicence>`; `sameHolder(a: string, b: string): boolean`.
  - `issuers/publisher-grant.ts`: `interface PublisherGrantDeps extends IssueDeps { grants: IssueDeps["grants"] & Pick<GrantStore, "isOnAllowList"> }`; `grantLicense(deps, { appId, kind, user, issuedBy, label, now }): Promise<string>`; `replaceGrant(deps, { licenseId, kind, issuedBy, now }): Promise<string>`.

- [ ] **Step 1: Write the failing unit tests**

`subgraphs/vetra-licensing/__tests__/issue.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { Action } from "document-model";
import {
  AlreadyHoldsError,
  LicenceNotUpgradableError,
  TermNotIssuableError,
  issueLicense,
  type IssueDeps,
} from "../issue.js";
import { grantLicense, replaceGrant } from "../issuers/publisher-grant.js";
import { NotOnAllowListError, UnknownLicenseError } from "../publisher-errors.js";
import { UnsupportedDidError } from "../did.js";
import type { AppDocView } from "../app-reads.js";
import type { LicenceRecord } from "../reads.js";

const ADDR = "0x1111111111111111111111111111111111111111";
const DID = `did:pkh:eip155:1:${ADDR}`;
const NOW = "2026-10-08T10:00:00.000Z";

const app: AppDocView = {
  id: "app-1", name: "KV", slug: "kv", owner: "0xowner", status: "ACTIVE", identityDid: null,
  productionEnvironmentId: null, templates: [], artifacts: [],
  terms: [
    { id: "k1", kind: "pro", label: null, templateId: "t", validityDays: 30, issuers: ["PUBLISHER_GRANT", "INVITE_CODE"], status: "ACTIVE" },
    { id: "k2", kind: "free", label: null, templateId: "t", validityDays: null, issuers: ["PUBLISHER_GRANT"], status: "ACTIVE" },
    { id: "k3", kind: "retired", label: null, templateId: "t", validityDays: null, issuers: ["PUBLISHER_GRANT"], status: "RETIRED" },
    { id: "k4", kind: "codes-only", label: null, templateId: "t", validityDays: null, issuers: ["INVITE_CODE"], status: "ACTIVE" },
  ],
};

const lic = (over: Partial<LicenceRecord>): LicenceRecord => ({
  id: "old", app: "app-1", user: DID, kind: "free", issuer: "PUBLISHER_GRANT", status: "ACTIVE",
  issued: "2026-01-01T00:00:00.000Z", start: "2026-01-01T00:00:00.000Z", end: null, stage: "env-7",
  details: null, replacedBy: null, legacyLicenseTypeId: null, ...over,
});

function harness(licences: LicenceRecord[] = [], opts: { allowed?: boolean; replaceFails?: boolean } = {}) {
  const executed: { id: string; actions: Action[] }[] = [];
  const created: string[] = [];
  const deps = {
    apps: { app: async (id: string) => (id === "app-1" ? app : null) },
    licence: async (id: string) => licences.find((l) => l.id === id) ?? null,
    createLicenseDocument: async () => { const id = `lic-${created.length + 1}`; created.push(id); return id; },
    executeLicence: vi.fn(async (id: string, actions: Action[]) => {
      if (opts.replaceFails && actions[0]?.type === "REPLACE_LICENSE") throw new Error("boom");
      executed.push({ id, actions });
    }),
    grants: {
      recordGrant: vi.fn(async () => {}),
      linkChain: vi.fn(async () => {}),
      chainRootOf: async (id: string) => (id === "old" ? "root-0" : id),
      isOnAllowList: async () => opts.allowed ?? true,
    },
    logger: { warn: vi.fn() },
  } satisfies IssueDeps & { grants: { isOnAllowList: unknown } };
  return { deps, executed, created };
}

describe("issueLicense", () => {
  it("issues and activates in one batch, with end from validityDays, and records provenance + chain", async () => {
    const h = harness();
    const out = await issueLicense(h.deps, { appId: "app-1", user: ADDR.toUpperCase().replace("0X", "0x"), kind: "pro", issuer: "PUBLISHER_GRANT", details: { grantedBy: "0xowner" }, issuedBy: "0xowner", label: "Project A", now: NOW });
    expect(out).toStrictEqual({ licenseId: "lic-1", user: DID, end: "2026-11-07T10:00:00.000Z", replaced: null });
    const [issue, activate] = h.executed[0]!.actions;
    expect(issue!.type).toBe("ISSUE_LICENSE");
    expect(issue!.input).toMatchObject({ app: "app-1", user: DID, kind: "pro", issuer: "PUBLISHER_GRANT", stage: null, start: NOW, end: "2026-11-07T10:00:00.000Z" });
    expect(JSON.parse((issue!.input as { details: string }).details)).toStrictEqual({ grantedBy: "0xowner", issuedBy: "0xowner" });
    expect(activate!.type).toBe("ACTIVATE_LICENSE");
    expect(h.deps.grants.recordGrant).toHaveBeenCalledWith({ licenseId: "lic-1", appId: "app-1", kind: "pro", userDid: DID, issuedBy: "0xowner", now: NOW });
    expect(h.deps.grants.linkChain).toHaveBeenCalledWith({ licenseId: "lic-1", rootLicenseId: "lic-1", appId: "app-1", label: "Project A", now: NOW });
  });

  it("leaves end open for an open-ended term", async () => {
    const h = harness();
    expect((await issueLicense(h.deps, { appId: "app-1", user: DID, kind: "free", issuer: "PUBLISHER_GRANT", details: {}, issuedBy: "x", now: NOW })).end).toBeNull();
  });

  it.each([
    ["unknown app", { appId: "nope" }],
    ["unknown kind", { kind: "nope" }],
    ["retired term", { kind: "retired" }],
    ["issuer not allowed", { kind: "codes-only" }],
  ])("refuses %s before creating anything", async (_n, over) => {
    const h = harness();
    await expect(issueLicense(h.deps, { appId: "app-1", user: DID, kind: "pro", issuer: "PUBLISHER_GRANT", details: {}, issuedBy: "x", now: NOW, ...over })).rejects.toBeInstanceOf(TermNotIssuableError);
    expect(h.created).toStrictEqual([]);
  });

  it("refuses a non-pkh DID before creating anything", async () => {
    const h = harness();
    await expect(issueLicense(h.deps, { appId: "app-1", user: "did:key:z6Mk", kind: "pro", issuer: "PUBLISHER_GRANT", details: {}, issuedBy: "x", now: NOW })).rejects.toBeInstanceOf(UnsupportedDidError);
    expect(h.created).toStrictEqual([]);
  });

  it("upgrades in place: inherits stage, joins the chain, replaces the ACTIVE predecessor", async () => {
    const h = harness([lic({})]);
    const out = await issueLicense(h.deps, { appId: "app-1", user: DID, kind: "pro", issuer: "PUBLISHER_GRANT", details: {}, issuedBy: "x", upgrades: "old", now: NOW });
    expect(out.replaced).toBe("old");
    expect(h.executed[0]!.actions[0]!.input).toMatchObject({ stage: "env-7" });
    expect(h.deps.grants.linkChain).toHaveBeenCalledWith(expect.objectContaining({ licenseId: "lic-1", rootLicenseId: "root-0" }));
    expect(h.executed[1]).toStrictEqual({ id: "old", actions: [expect.objectContaining({ type: "REPLACE_LICENSE", input: { replacedBy: "lic-1" } })] });
  });

  it("re-licenses an EXPIRED chain without touching the terminal predecessor", async () => {
    const h = harness([lic({ status: "EXPIRED" })]);
    await issueLicense(h.deps, { appId: "app-1", user: DID, kind: "free", issuer: "PUBLISHER_GRANT", details: {}, issuedBy: "x", upgrades: "old", now: NOW });
    expect(h.executed).toHaveLength(1);
    expect(h.deps.grants.linkChain).toHaveBeenCalledWith(expect.objectContaining({ rootLicenseId: "root-0" }));
  });

  it("matches a legacy 0x holder on the predecessor", async () => {
    const h = harness([lic({ user: ADDR })]);
    await expect(issueLicense(h.deps, { appId: "app-1", user: DID, kind: "pro", issuer: "PUBLISHER_GRANT", details: {}, issuedBy: "x", upgrades: "old", now: NOW })).resolves.toMatchObject({ replaced: "old" });
  });

  it("keeps the new licence when replacing the predecessor fails, and says so", async () => {
    const h = harness([lic({})], { replaceFails: true });
    await expect(issueLicense(h.deps, { appId: "app-1", user: DID, kind: "pro", issuer: "PUBLISHER_GRANT", details: {}, issuedBy: "x", upgrades: "old", now: NOW })).resolves.toMatchObject({ licenseId: "lic-1" });
    expect(h.deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining("could not mark old REPLACED"));
  });

  it.each([
    ["missing predecessor", [], UnknownLicenseError],
    ["another holder's licence", [lic({ user: "did:pkh:eip155:1:0x2222222222222222222222222222222222222222" })], UnknownLicenseError],
    ["another app's licence", [lic({ app: "app-2" })], UnknownLicenseError],
    ["a REPLACED predecessor", [lic({ status: "REPLACED" })], LicenceNotUpgradableError],
    ["an ISSUED predecessor", [lic({ status: "ISSUED" })], LicenceNotUpgradableError],
    ["the same kind, still ACTIVE", [lic({ kind: "pro" })], AlreadyHoldsError],
  ])("refuses an upgrade of %s", async (_n, licences, error) => {
    const h = harness(licences as LicenceRecord[]);
    await expect(issueLicense(h.deps, { appId: "app-1", user: DID, kind: "pro", issuer: "PUBLISHER_GRANT", details: {}, issuedBy: "x", upgrades: "old", now: NOW })).rejects.toBeInstanceOf(error);
    expect(h.created).toStrictEqual([]);
  });
});

describe("publisher grant issuer", () => {
  it("refuses a holder not on the allow list", async () => {
    const h = harness([], { allowed: false });
    await expect(grantLicense(h.deps, { appId: "app-1", kind: "pro", user: ADDR, issuedBy: "0xowner", label: null, now: NOW })).rejects.toBeInstanceOf(NotOnAllowListError);
    expect(h.created).toStrictEqual([]);
  });
  it("grants with the grantor in details", async () => {
    const h = harness();
    expect(await grantLicense(h.deps, { appId: "app-1", kind: "pro", user: ADDR, issuedBy: "0xOwner", label: null, now: NOW })).toBe("lic-1");
    expect(JSON.parse((h.executed[0]!.actions[0]!.input as { details: string }).details)).toMatchObject({ grantedBy: "0xowner" });
  });
  it("replaces a holder's licence in place", async () => {
    const h = harness([lic({})]);
    expect(await replaceGrant(h.deps, { licenseId: "old", kind: "pro", issuedBy: "0xowner", now: NOW })).toBe("lic-1");
    expect(h.executed[1]!.actions[0]!.type).toBe("REPLACE_LICENSE");
  });
  it("refuses to replace a missing licence", async () => {
    await expect(replaceGrant(harness().deps, { licenseId: "nope", kind: "pro", issuedBy: "x", now: NOW })).rejects.toBeInstanceOf(UnknownLicenseError);
  });
});
```

`subgraphs/vetra-licensing/__tests__/grants.test.ts` (real PGlite):

```ts
import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import type { VetraLicensingDB } from "../db/schema.js";
import { createGrantStore } from "../grants.js";

const DID = "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";
let db: Kysely<VetraLicensingDB> | undefined;
const open = async () => {
  db = new Kysely<VetraLicensingDB>({ dialect: new PGliteDialect(new PGlite()) });
  await up(db as Kysely<any>);
  return createGrantStore(db);
};
afterEach(async () => { await db?.destroy(); db = undefined; });

describe("grant store", () => {
  it("records provenance with kind, DID and the derived address, once", async () => {
    const g = await open();
    const row = { licenseId: "l1", appId: "a", kind: "pro", userDid: DID, issuedBy: "0xOwner", now: "t" };
    await g.recordGrant(row);
    await g.recordGrant(row);
    const rows = await db!.selectFrom("app_license_grants").selectAll().execute();
    expect(rows).toStrictEqual([{ license_id: "l1", app_id: "a", license_type_id: "", user_address: "0x1111111111111111111111111111111111111111", issued_by: "0xowner", created_at: "t", kind: "pro", user_did: DID }]);
    expect(await g.authorisedIds()).toStrictEqual(new Set(["l1"]));
    expect(await g.licenceIdsFor("a", DID)).toStrictEqual(["l1"]);
    expect(await g.licenceIdsFor(null, DID)).toStrictEqual(["l1"]);
  });

  it("resolves chain roots; an unchained licence is its own root", async () => {
    const g = await open();
    await g.linkChain({ licenseId: "l1", rootLicenseId: "l1", appId: "a", label: "Project", now: "t" });
    await g.linkChain({ licenseId: "l2", rootLicenseId: "l1", appId: "a", label: null, now: "t" });
    expect(await g.chainRootOf("l2")).toBe("l1");
    expect(await g.chainRootOf("lx")).toBe("lx");
    expect(await g.chainLabel("l1")).toBe("Project");
    expect(await g.chainRoots()).toStrictEqual(new Map([["l1", "l1"], ["l2", "l1"]]));
  });

  it("manages the allow list idempotently", async () => {
    const g = await open();
    await g.addToAllowList("a", DID, "t1");
    await g.addToAllowList("a", DID, "t2");
    expect(await g.isOnAllowList("a", DID)).toBe(true);
    expect(await g.allowList("a")).toStrictEqual([{ user: DID, addedAt: "t1" }]);
    expect(await g.removeFromAllowList("a", DID)).toBe(true);
    expect(await g.removeFromAllowList("a", DID)).toBe(false);
    expect(await g.isOnAllowList("a", DID)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run subgraphs/vetra-licensing/__tests__/issue.test.ts subgraphs/vetra-licensing/__tests__/grants.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement `grants.ts`**

```ts
import type { Kysely } from "kysely";
import type { VetraLicensingDB } from "./db/schema.js";
import { addressOfDid } from "./did.js";

export type GrantStore = ReturnType<typeof createGrantStore>;

export function createGrantStore(db: Kysely<VetraLicensingDB>) {
  return {
    /**
     * The provenance row the keeper requires. license_type_id is a legacy
     * NOT NULL column: new rows carry "" and the kind in `kind`.
     */
    async recordGrant(r: { licenseId: string; appId: string; kind: string; userDid: string; issuedBy: string; now: string }) {
      await db.insertInto("app_license_grants").values({
        license_id: r.licenseId,
        app_id: r.appId,
        license_type_id: "",
        user_address: addressOfDid(r.userDid),
        issued_by: r.issuedBy.toLowerCase(),
        created_at: r.now,
        kind: r.kind,
        user_did: r.userDid,
      }).onConflict((oc) => oc.column("license_id").doNothing()).execute();
    },
    async linkChain(r: { licenseId: string; rootLicenseId: string; appId: string; label: string | null; now: string }) {
      await db.insertInto("license_chain").values({
        license_id: r.licenseId,
        root_license_id: r.rootLicenseId,
        app_id: r.appId,
        label: r.label,
        created_at: r.now,
      }).onConflict((oc) => oc.column("license_id").doNothing()).execute();
    },
    async chainRootOf(licenseId: string): Promise<string> {
      const row = await db.selectFrom("license_chain").select("root_license_id")
        .where("license_id", "=", licenseId).executeTakeFirst();
      return row?.root_license_id ?? licenseId;
    },
    async chainRoots(): Promise<Map<string, string>> {
      const rows = await db.selectFrom("license_chain").select(["license_id", "root_license_id"]).execute();
      return new Map(rows.map((r) => [r.license_id, r.root_license_id]));
    },
    async chainLabel(rootLicenseId: string): Promise<string | null> {
      const row = await db.selectFrom("license_chain").select("label")
        .where("license_id", "=", rootLicenseId).executeTakeFirst();
      return row?.label ?? null;
    },
    async authorisedIds(): Promise<Set<string>> {
      const rows = await db.selectFrom("app_license_grants").select("license_id").execute();
      return new Set(rows.map((r) => r.license_id));
    },
    async licenceIdsFor(appId: string | null, userDid: string): Promise<string[]> {
      let q = db.selectFrom("app_license_grants").select("license_id")
        .where((eb) => eb.or([eb("user_did", "=", userDid), eb("user_address", "=", addressOfDid(userDid))]));
      if (appId) q = q.where("app_id", "=", appId);
      return (await q.orderBy("created_at", "asc").execute()).map((r) => r.license_id);
    },
    async isOnAllowList(appId: string, userDid: string): Promise<boolean> {
      const row = await db.selectFrom("app_allow_list").select("user_did")
        .where("app_id", "=", appId).where("user_did", "=", userDid).executeTakeFirst();
      return row !== undefined;
    },
    async addToAllowList(appId: string, userDid: string, now: string) {
      await db.insertInto("app_allow_list").values({ app_id: appId, user_did: userDid, added_at: now })
        .onConflict((oc) => oc.columns(["app_id", "user_did"]).doNothing()).execute();
    },
    async removeFromAllowList(appId: string, userDid: string): Promise<boolean> {
      const res = await db.deleteFrom("app_allow_list")
        .where("app_id", "=", appId).where("user_did", "=", userDid).executeTakeFirst();
      return Number(res.numDeletedRows) > 0;
    },
    async allowList(appId: string) {
      const rows = await db.selectFrom("app_allow_list").select(["user_did", "added_at"])
        .where("app_id", "=", appId).orderBy("added_at", "asc").execute();
      return rows.map((r) => ({ user: r.user_did, addedAt: r.added_at }));
    },
  };
}
```

- [ ] **Step 4: Add `LicenceRecord` to `reads.ts`**

Add the interface (exact shape in Interfaces), a `toRecord(doc)` parser (uses `parseLicense` plus `kind: str(g.kind)`, `issuer: str(g.issuer)`, `issued: str(g.issued)`, `stage: str(g.stage)`, `details: str(g.details)`, `replacedBy: str(g.replacedBy)`, `legacyLicenseTypeId: legacyLicenseTypeOf(g)`; `null` when `app` is null), and to the returned object:

```ts
    async licenceRecord(id) {
      const doc = await getDoc(id);
      return isDocType(doc, LICENSE_DOC_TYPE) ? toRecord(doc) : null;
    },
    async allLicenceRecords() {
      return (await findAll(LICENSE_DOC_TYPE)).flatMap((d) => {
        const r = toRecord(d);
        return r ? [r] : [];
      });
    },
    async licenceRecords(ids) {
      const out: LicenceRecord[] = [];
      for (const id of ids) {
        const r = await this.licenceRecord(id);
        if (r) out.push(r);
      }
      return out;
    },
```

Add a `reads.test.ts` case: a licence document with `kind`, `stage`, `issuer` in state parses into a `LicenceRecord` with those fields, and a non-licence document id returns `null`.

- [ ] **Step 5: Implement `issue.ts`**

```ts
import type { Action } from "document-model";
import { actions } from "document-models/app-owner-license";
import type { AppReads } from "./app-reads.js";
import { normaliseUserDid } from "./did.js";
import type { GrantStore } from "./grants.js";
import { UnknownLicenseError } from "./publisher-errors.js";
import type { LicenceRecord } from "./reads.js";

export type IssuerKind = "INVITE_CODE" | "PUBLISHER_GRANT" | "ACHRA_SUBSCRIPTION";

export class TermNotIssuableError extends Error {
  override name = "TermNotIssuableError";
}
export class LicenceNotUpgradableError extends Error {
  override name = "LicenceNotUpgradableError";
}
export class AlreadyHoldsError extends Error {
  override name = "AlreadyHoldsError";
}

export interface IssueDeps {
  apps: Pick<AppReads, "app">;
  licence(id: string): Promise<LicenceRecord | null>;
  createLicenseDocument(): Promise<string>;
  executeLicence(id: string, actions: Action[]): Promise<void>;
  grants: Pick<GrantStore, "recordGrant" | "linkChain" | "chainRootOf">;
  logger: Pick<Console, "warn">;
}

export interface IssueInput {
  appId: string;
  user: string;
  kind: string;
  issuer: IssuerKind;
  /** Issuer-specific audit payload: invite code, grantor, subscription id. */
  details: Record<string, unknown>;
  issuedBy: string;
  label?: string | null;
  /** Replace this licence (same app, same holder) and keep its environment. */
  upgrades?: string | null;
  /** ISO-8601 UTC `Z`; the licence starts now. */
  now: string;
}

export interface IssuedLicence {
  licenseId: string;
  user: string;
  end: string | null;
  replaced: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const UPGRADABLE = new Set(["ACTIVE", "EXPIRED", "REVOKED"]);

/** Two holder spellings name the same wallet (legacy licences carry a bare address). */
export function sameHolder(a: string, b: string): boolean {
  try {
    return normaliseUserDid(a) === normaliseUserDid(b);
  } catch {
    return false;
  }
}

/**
 * The one way a licence comes into existence. Everything that can refuse
 * refuses before a document is created, so a refusal never leaves an orphan.
 * The licence is issued AND activated in one batch: it starts now, and a
 * holder must not wait a keeper tick for access they were just given.
 */
export async function issueLicense(deps: IssueDeps, input: IssueInput): Promise<IssuedLicence> {
  const user = normaliseUserDid(input.user);
  const app = await deps.apps.app(input.appId);
  const term = app?.terms.find((t) => t.kind === input.kind);
  if (!app || !term || term.status !== "ACTIVE" || !term.issuers.includes(input.issuer)) {
    throw new TermNotIssuableError(`${input.kind} cannot be issued by ${input.issuer} for app ${input.appId}`);
  }

  let previous: LicenceRecord | null = null;
  if (input.upgrades) {
    previous = await deps.licence(input.upgrades);
    // Another holder's or another app's licence fails exactly like a missing one.
    if (!previous || previous.app !== input.appId || !sameHolder(previous.user, user)) {
      throw new UnknownLicenseError();
    }
    if (!UPGRADABLE.has(previous.status)) {
      throw new LicenceNotUpgradableError(
        `licence ${previous.id} is ${previous.status}; only an ACTIVE, EXPIRED or REVOKED licence can be upgraded`,
      );
    }
    if (previous.status === "ACTIVE" && previous.kind === input.kind) {
      throw new AlreadyHoldsError(`licence ${previous.id} already is ${input.kind}`);
    }
  }

  const start = new Date(Date.parse(input.now)).toISOString();
  const end = term.validityDays === null
    ? null
    : new Date(Date.parse(start) + term.validityDays * DAY_MS).toISOString();

  // Built before create(): the creator validates the input, so a malformed
  // action refuses here instead of after an empty document exists.
  const issueAction = actions.issueLicense({
    app: input.appId,
    user,
    issuer: input.issuer,
    kind: input.kind,
    stage: previous?.stage ?? null,
    details: JSON.stringify({ ...input.details, issuedBy: input.issuedBy.toLowerCase() }),
    issued: start,
    start,
    end,
  });

  const licenseId = await deps.createLicenseDocument();
  await deps.executeLicence(licenseId, [issueAction, actions.activateLicense({})]);
  // After the document exists, so a failed issue never leaves an authorisation
  // for a licence that was not created.
  await deps.grants.recordGrant({ licenseId, appId: input.appId, kind: input.kind, userDid: user, issuedBy: input.issuedBy, now: start });
  const root = previous ? await deps.grants.chainRootOf(previous.id) : licenseId;
  await deps.grants.linkChain({ licenseId, rootLicenseId: root, appId: input.appId, label: input.label ?? null, now: start });

  if (previous?.status === "ACTIVE") {
    try {
      await deps.executeLicence(previous.id, [actions.replaceLicense({ replacedBy: licenseId })]);
    } catch (err) {
      // Safe to continue: both licences sit in one chain and the keeper serves
      // the newest ACTIVE one, so the holder never gets a second environment.
      deps.logger.warn(`[licensing] issued ${licenseId} but could not mark ${previous.id} REPLACED: ${String(err)}`);
    }
  }
  return { licenseId, user, end, replaced: previous?.id ?? null };
}
```

Note the test expects the message `could not mark old REPLACED` — the template above produces `could not mark old REPLACED` for `previous.id === "old"`.

- [ ] **Step 6: Add the grant issuer functions**

Move `NotOnAllowListError` into `publisher-errors.ts` (re-export it from `issuers/publisher-grant.ts` so existing imports compile). Append to `issuers/publisher-grant.ts`:

```ts
import { issueLicense, type IssueDeps } from "../issue.js";
import { normaliseUserDid } from "../did.js";
import type { GrantStore } from "../grants.js";
import { NotOnAllowListError, UnknownLicenseError } from "../publisher-errors.js";

export interface PublisherGrantDeps extends IssueDeps {
  grants: IssueDeps["grants"] & Pick<GrantStore, "isOnAllowList">;
}

/** PublisherGrantIssuer: the caller's ownership is checked by the resolver. */
export async function grantLicense(
  deps: PublisherGrantDeps,
  input: { appId: string; kind: string; user: string; issuedBy: string; label: string | null; now: string },
): Promise<string> {
  const user = normaliseUserDid(input.user);
  if (!(await deps.grants.isOnAllowList(input.appId, user))) {
    throw new NotOnAllowListError(`${user} is not on the allow list for app ${input.appId}`);
  }
  const issued = await issueLicense(deps, {
    appId: input.appId,
    user,
    kind: input.kind,
    issuer: "PUBLISHER_GRANT",
    details: { grantedBy: input.issuedBy.toLowerCase() },
    issuedBy: input.issuedBy,
    label: input.label,
    now: input.now,
  });
  return issued.licenseId;
}

/** Upgrade/downgrade a holder in place: same chain, same environment. */
export async function replaceGrant(
  deps: PublisherGrantDeps,
  input: { licenseId: string; kind: string; issuedBy: string; now: string },
): Promise<string> {
  const previous = await deps.licence(input.licenseId);
  if (!previous) throw new UnknownLicenseError();
  const issued = await issueLicense(deps, {
    appId: previous.app,
    user: previous.user,
    kind: input.kind,
    issuer: "PUBLISHER_GRANT",
    details: { grantedBy: input.issuedBy.toLowerCase(), replaces: previous.id },
    issuedBy: input.issuedBy,
    upgrades: previous.id,
    now: input.now,
  });
  return issued.licenseId;
}
```

- [ ] **Step 7: Integration test against a real reactor**

`subgraphs/vetra-licensing/__tests__/issue-reactor.integration.test.ts`:

```ts
import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { ReactorBuilder, ReactorClientBuilder } from "@powerhousedao/reactor";
import { actions as appActions } from "document-models/vetra-app";
import { documentModels } from "../../../document-models/document-models.js";
import { createReactorAppDocStore } from "../../vetra-apps/app-doc-store.js";
import { up } from "../db/migrations.js";
import type { VetraLicensingDB } from "../db/schema.js";
import { createAppReads } from "../app-reads.js";
import { createReactorLicenseReads } from "../reads.js";
import { createReactorLicenseGateway } from "../license-gateway.js";
import { createGrantStore } from "../grants.js";
import { issueLicense } from "../issue.js";

const APP = "7d1f6f5c-1f0e-4a8b-9d55-0c3b9b8f2a11";
const DID = "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";

describe("issueLicense against a real reactor", () => {
  let deps: Parameters<typeof issueLicense>[0];
  let reads: ReturnType<typeof createReactorLicenseReads>;

  beforeAll(async () => {
    const client = await new ReactorClientBuilder()
      .withReactorBuilder(new ReactorBuilder().withDocumentModelSources([...documentModels]))
      .build();
    const db = new Kysely<VetraLicensingDB>({ dialect: new PGliteDialect(new PGlite()) });
    await up(db as Kysely<any>);
    const appDocs = createReactorAppDocStore(client as never);
    await appDocs.create(APP);
    await appDocs.execute(APP, [
      appActions.addTemplate({ id: "t", name: null, mode: "DEDICATED" }),
      appActions.addTerm({ id: "k", kind: "pro", label: null, templateId: "t", validityDays: 30, issuers: ["PUBLISHER_GRANT"] }),
      appActions.publishTerm({ id: "k" }),
    ]);
    reads = createReactorLicenseReads(client as never);
    const gateway = createReactorLicenseGateway(client as never);
    deps = {
      apps: createAppReads(client as never),
      licence: (id) => reads.licenceRecord(id),
      createLicenseDocument: gateway.create,
      executeLicence: gateway.execute,
      grants: createGrantStore(db),
      logger: console,
    };
  });

  it("creates an ACTIVE licence on the kind, then upgrades it in place", async () => {
    const first = await issueLicense(deps, { appId: APP, user: DID, kind: "pro", issuer: "PUBLISHER_GRANT", details: {}, issuedBy: "0xowner", now: "2026-10-08T00:00:00.000Z" });
    expect(await reads.licenceRecord(first.licenseId)).toMatchObject({ status: "ACTIVE", kind: "pro", user: DID, issuer: "PUBLISHER_GRANT", end: "2026-11-07T00:00:00.000Z" });
  });
});
```

(The upgrade path is covered by the unit tests; this test proves the reshaped model accepts what `issueLicense` sends.)

- [ ] **Step 8: Run, check, commit**

Run: `npx vitest run subgraphs/vetra-licensing && npm run tsc && npm run lint:fix` → PASS.

```bash
git add subgraphs/vetra-licensing
git commit -m "feat(licensing): one issueLicense for every issuer, with upgrade in place"
```

---

### Task 7: Invite codes and the invite-code issuer

`vetra-access-codes` is the precursor; its table logic moves here, keyed to one term of one app. Codes stay in tables (they are redeemable secrets, some carry an encrypted Claude key).

**Files:**
- Create: `subgraphs/vetra-licensing/invite-codes.ts`, `subgraphs/vetra-licensing/issuers/invite-code.ts`, `subgraphs/vetra-licensing/key-vault.ts`
- Test: `subgraphs/vetra-licensing/__tests__/invite-codes.test.ts`, `__tests__/invite-code-issuer.test.ts`

**Interfaces:**
- Consumes: `issueLicense`, `IssueDeps`, `AlreadyHoldsError` (Task 6); `resolveKind`, `AppReads` (Task 5); `normaliseUserDid` (Task 3); tables `invite_codes`, `invite_redemptions` (Task 4); `OpenBaoTransitClient` (`subgraphs/vetra-cloud-secrets/openbao-transit.ts`).
- Produces:
  - `invite-codes.ts`: `CODE_MAX_LENGTH = 100`; `class InvalidCodeError` (message always `"invalid code"`); `class InvalidCodeInputError`; `normalizeCode(code: string): string`; `generateCode(): string`; `interface InviteCodeView { code: string; kind: string; label: string | null; active: boolean; expiresAt: string | null; maxUses: number | null; redemptions: number; hasAnthropicKey: boolean; createdAt: string }`; `createInviteCode(db, { appId, kind, code: string | null, label, expiresAt, maxUses, anthropicKeyCiphertext, now }): Promise<InviteCodeView>`; `setInviteCodeActive(db, appId, code, active): Promise<boolean>`; `listInviteCodes(db, appId): Promise<InviteCodeView[]>`; `getCode(db, code): Promise<InviteCodes | null>`; `isUsable(db, row: InviteCodes, now: string): Promise<boolean>`; `findRedemption(db, code, userDid): Promise<InviteRedemptions | null>`; `reserveRedemption(db, code, userDid, now): Promise<boolean>`; `attachLicence(db, code, userDid, licenseId, accessExpires: string | null): Promise<void>`; `releaseReservation(db, code, userDid): Promise<void>`; `keyCiphertextForCode(db, code): Promise<string | null>`.
  - `key-vault.ts`: `INVITE_KEY_TRANSIT_TENANT = "access-codes"` (unchanged, so existing ciphertexts decrypt); `interface KeyVault { encrypt(plaintext: string): Promise<string>; decrypt(ciphertext: string): Promise<string> }`; `createKeyVault(transit: OpenBaoTransitClient | null): KeyVault | null`; `class KeyStorageUnavailableError`.
  - `issuers/invite-code.ts`: `interface InviteCodeIssuerDeps extends IssueDeps { db: Kysely<VetraLicensingDB>; activeLicencesOf(appId: string, userDid: string): Promise<LicenceRecord[]> }`; `redeemInviteCode(deps, { code: string; user: string; label: string | null; upgrades: string | null; now: string }): Promise<{ licenseId: string; appId: string; fresh: boolean }>`.

- [ ] **Step 1: Write the failing table tests**

`subgraphs/vetra-licensing/__tests__/invite-codes.test.ts` (PGlite; same `open()` pattern as `grants.test.ts`):

```ts
import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import type { VetraLicensingDB } from "../db/schema.js";
import {
  InvalidCodeInputError, attachLicence, createInviteCode, findRedemption, generateCode, getCode,
  isUsable, keyCiphertextForCode, listInviteCodes, normalizeCode, releaseReservation,
  reserveRedemption, setInviteCodeActive,
} from "../invite-codes.js";

let db: Kysely<VetraLicensingDB> | undefined;
const open = async () => {
  db = new Kysely<VetraLicensingDB>({ dialect: new PGliteDialect(new PGlite()) });
  await up(db as Kysely<any>);
  return db;
};
afterEach(async () => { await db?.destroy(); db = undefined; });

const NOW = "2026-10-08T00:00:00.000Z";
const base = { appId: "app-1", kind: "pro", label: null, expiresAt: null, maxUses: null, anthropicKeyCiphertext: null, now: NOW };

describe("invite codes", () => {
  it("normalises and generates unguessable codes", () => {
    expect(normalizeCode("  Cohort-2 ")).toBe("cohort-2");
    expect(generateCode()).toMatch(/^vetra-[a-z]+-[a-z]+-[a-z0-9]{4}$/);
    expect(generateCode()).not.toBe(generateCode());
  });

  it("creates, lists with counts, and never returns the key", async () => {
    const d = await open();
    const v = await createInviteCode(d, { ...base, code: "Cohort-2", maxUses: 2, anthropicKeyCiphertext: "vault:v1:x" });
    expect(v).toMatchObject({ code: "cohort-2", kind: "pro", active: true, maxUses: 2, redemptions: 0, hasAnthropicKey: true });
    expect(Object.keys(v)).not.toContain("anthropicKeyCiphertext");
    await reserveRedemption(d, "cohort-2", "did:a", NOW);
    expect((await listInviteCodes(d, "app-1"))[0]!.redemptions).toBe(1);
    expect(await listInviteCodes(d, "app-2")).toStrictEqual([]);
    expect(await keyCiphertextForCode(d, "cohort-2")).toBe("vault:v1:x");
  });

  it("generates a code when none is given", async () => {
    const d = await open();
    expect((await createInviteCode(d, { ...base, code: null })).code).toMatch(/^vetra-/);
  });

  it.each([
    ["an empty code", { code: "  " }, "code must not be empty"],
    ["a too long code", { code: "x".repeat(101) }, "code must be at most 100 characters"],
    ["a bad expiry", { code: "c", expiresAt: "not a date" }, "expiresAt is not a date"],
    ["a non-positive cap", { code: "c", maxUses: 0 }, "maxUses must be positive"],
  ])("refuses %s", async (_n, over, message) => {
    const d = await open();
    await expect(createInviteCode(d, { ...base, ...over })).rejects.toThrow(new InvalidCodeInputError(message));
  });

  it("refuses a code that already exists, even for another app", async () => {
    const d = await open();
    await createInviteCode(d, { ...base, code: "dup" });
    await expect(createInviteCode(d, { ...base, appId: "app-2", code: "DUP" })).rejects.toThrow(new InvalidCodeInputError("code already exists"));
  });

  it("toggles active only within the owning app", async () => {
    const d = await open();
    await createInviteCode(d, { ...base, code: "c" });
    expect(await setInviteCodeActive(d, "app-2", "c", false)).toBe(false);
    expect(await setInviteCodeActive(d, "app-1", "C", false)).toBe(true);
    expect((await getCode(d, "c"))!.active).toBe(false);
  });

  it("is usable only while active, unexpired and under its cap", async () => {
    const d = await open();
    await createInviteCode(d, { ...base, code: "c", maxUses: 1, expiresAt: "2026-12-01T00:00:00Z" });
    const row = (await getCode(d, "c"))!;
    expect(await isUsable(d, row, NOW)).toBe(true);
    expect(await isUsable(d, row, "2026-12-02T00:00:00.000Z")).toBe(false);
    expect(await reserveRedemption(d, "c", "did:a", NOW)).toBe(true);
    expect(await isUsable(d, row, NOW)).toBe(false);
    expect(await reserveRedemption(d, "c", "did:b", NOW)).toBe(false);
    await setInviteCodeActive(d, "app-1", "c", false);
    expect(await isUsable(d, (await getCode(d, "c"))!, NOW)).toBe(false);
  });

  it("attaches a licence to a reservation and releases only unattached reservations", async () => {
    const d = await open();
    await createInviteCode(d, { ...base, code: "c" });
    await reserveRedemption(d, "c", "did:a", NOW);
    await reserveRedemption(d, "c", "did:b", NOW);
    await attachLicence(d, "c", "did:a", "lic-a", "2026-11-07T00:00:00.000Z");
    await releaseReservation(d, "c", "did:a");
    await releaseReservation(d, "c", "did:b");
    expect(await findRedemption(d, "c", "did:a")).toMatchObject({ license_id: "lic-a", access_expires: "2026-11-07T00:00:00.000Z" });
    expect(await findRedemption(d, "c", "did:b")).toBeNull();
  });
});
```

- [ ] **Step 2: Write the failing issuer tests**

`subgraphs/vetra-licensing/__tests__/invite-code-issuer.test.ts` — real PGlite for the code tables, fakes for the document side:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import type { VetraLicensingDB } from "../db/schema.js";
import { createInviteCode, findRedemption } from "../invite-codes.js";
import { InvalidCodeError } from "../invite-codes.js";
import { AlreadyHoldsError, TermNotIssuableError } from "../issue.js";
import { redeemInviteCode, type InviteCodeIssuerDeps } from "../issuers/invite-code.js";
import type { AppDocView } from "../app-reads.js";
import type { LicenceRecord } from "../reads.js";

const DID = "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";
const NOW = "2026-10-08T00:00:00.000Z";
const tpl = (id: string, mode: "SHARED" | "DEDICATED") => ({
  id, name: null, mode, sharedEnvironment: null, templateHash: "h", resolutionError: null,
  template: { services: [], packages: [], size: null, baseDomain: null, packageRegistry: null },
});
const app: AppDocView = {
  id: "app-1", name: "KV", slug: "kv", owner: "0xo", status: "ACTIVE", identityDid: null,
  productionEnvironmentId: "env-prod", artifacts: [],
  templates: [tpl("ded", "DEDICATED"), tpl("sh", "SHARED")],
  terms: [
    { id: "a", kind: "pro", label: null, templateId: "ded", validityDays: 30, issuers: ["INVITE_CODE"], status: "ACTIVE" },
    { id: "b", kind: "free", label: null, templateId: "sh", validityDays: null, issuers: ["INVITE_CODE"], status: "ACTIVE" },
    { id: "c", kind: "grant-only", label: null, templateId: "ded", validityDays: null, issuers: ["PUBLISHER_GRANT"], status: "ACTIVE" },
  ],
};

let db: Kysely<VetraLicensingDB>;
let deps: InviteCodeIssuerDeps;
let active: LicenceRecord[];
let created: number;

beforeEach(async () => {
  db = new Kysely<VetraLicensingDB>({ dialect: new PGliteDialect(new PGlite()) });
  await up(db as Kysely<any>);
  active = [];
  created = 0;
  deps = {
    db,
    apps: { app: async (id) => (id === "app-1" ? app : null) },
    licence: async () => null,
    createLicenseDocument: async () => `lic-${++created}`,
    executeLicence: vi.fn(async () => {}),
    grants: { recordGrant: vi.fn(async () => {}), linkChain: vi.fn(async () => {}), chainRootOf: async (id) => id },
    activeLicencesOf: async () => active,
    logger: { warn: vi.fn() },
  };
  const c = (code: string, kind: string, maxUses: number | null = null) =>
    createInviteCode(db, { appId: "app-1", kind, code, label: null, expiresAt: null, maxUses, anthropicKeyCiphertext: null, now: NOW });
  await c("ded", "pro", 1);
  await c("shared", "free");
  await c("wrong-issuer", "grant-only");
});
afterEach(async () => { await db.destroy(); });

describe("redeemInviteCode", () => {
  it("issues a licence for the code's term and records the redemption", async () => {
    const out = await redeemInviteCode(deps, { code: "DED", user: DID, label: "My vault", upgrades: null, now: NOW });
    expect(out).toStrictEqual({ licenseId: "lic-1", appId: "app-1", fresh: true });
    expect(await findRedemption(db, "ded", DID)).toMatchObject({ license_id: "lic-1", access_expires: "2026-11-07T00:00:00.000Z" });
    expect(deps.grants.linkChain).toHaveBeenCalledWith(expect.objectContaining({ label: "My vault" }));
  });

  it("is idempotent for the same caller and code, even once the code is exhausted", async () => {
    await redeemInviteCode(deps, { code: "ded", user: DID, label: null, upgrades: null, now: NOW });
    const again = await redeemInviteCode(deps, { code: "ded", user: DID, label: null, upgrades: null, now: NOW });
    expect(again).toStrictEqual({ licenseId: "lic-1", appId: "app-1", fresh: false });
    expect(created).toBe(1);
  });

  it("refuses an exhausted code for another caller with INVALID_CODE", async () => {
    await redeemInviteCode(deps, { code: "ded", user: DID, label: null, upgrades: null, now: NOW });
    await expect(redeemInviteCode(deps, { code: "ded", user: "0x2222222222222222222222222222222222222222", label: null, upgrades: null, now: NOW })).rejects.toBeInstanceOf(InvalidCodeError);
  });

  it("refuses an unknown code with the same error", async () => {
    await expect(redeemInviteCode(deps, { code: "nope", user: DID, label: null, upgrades: null, now: NOW })).rejects.toThrow(new InvalidCodeError());
  });

  it("refuses a SHARED kind the caller already holds", async () => {
    active = [{ id: "x", app: "app-1", user: DID, kind: "free", issuer: "INVITE_CODE", status: "ACTIVE", issued: null, start: null, end: null, stage: null, details: null, replacedBy: null, legacyLicenseTypeId: null }];
    await expect(redeemInviteCode(deps, { code: "shared", user: DID, label: null, upgrades: null, now: NOW })).rejects.toBeInstanceOf(AlreadyHoldsError);
    expect(await findRedemption(db, "shared", DID)).toBeNull();
  });

  it("releases the reservation when issuing fails, so the cap is not consumed", async () => {
    await expect(redeemInviteCode(deps, { code: "wrong-issuer", user: DID, label: null, upgrades: null, now: NOW })).rejects.toBeInstanceOf(TermNotIssuableError);
    expect(await findRedemption(db, "wrong-issuer", DID)).toBeNull();
  });

  it("completes a reservation left behind by a crashed redeem", async () => {
    await db.insertInto("invite_redemptions").values({ code: "ded", user_did: DID, redeemed_at: NOW, access_expires: null, license_id: null }).execute();
    const out = await redeemInviteCode(deps, { code: "ded", user: DID, label: null, upgrades: null, now: NOW });
    expect(out.fresh).toBe(true);
    expect((await findRedemption(db, "ded", DID))!.license_id).toBe("lic-1");
  });
});
```

- [ ] **Step 3: Run to see them fail**

Run: `npx vitest run subgraphs/vetra-licensing/__tests__/invite-codes.test.ts subgraphs/vetra-licensing/__tests__/invite-code-issuer.test.ts` → FAIL (modules missing).

- [ ] **Step 4: Implement `invite-codes.ts`**

```ts
import { randomInt } from "node:crypto";
import type { Kysely } from "kysely";
import type { InviteCodes, InviteRedemptions, VetraLicensingDB } from "./db/schema.js";

export const CODE_MAX_LENGTH = 100;

/** One error for unknown, inactive, expired and exhausted: codes cannot be probed for state. */
export class InvalidCodeError extends Error {
  override name = "InvalidCodeError";
  constructor() {
    super("invalid code");
  }
}
export class InvalidCodeInputError extends Error {
  override name = "InvalidCodeInputError";
}

export interface InviteCodeView {
  code: string;
  kind: string;
  label: string | null;
  active: boolean;
  expiresAt: string | null;
  maxUses: number | null;
  redemptions: number;
  hasAnthropicKey: boolean;
  createdAt: string;
}

const ADJECTIVES = ["swift", "bright", "calm", "clever", "bold", "brave", "keen", "lively", "merry", "nimble", "quiet", "rapid", "sunny", "witty", "eager", "gentle"];
const NOUNS = ["otter", "falcon", "maple", "comet", "harbor", "willow", "ember", "lynx", "cedar", "river", "summit", "meadow", "orbit", "pebble", "quartz", "tundra"];
const SUFFIX = "abcdefghjkmnpqrstuvwxyz23456789";

export function normalizeCode(code: string): string {
  return code.trim().toLowerCase();
}

/** `vetra-<adjective>-<noun>-<4 chars>`; the suffix is what makes it unguessable. */
export function generateCode(): string {
  const pick = (xs: readonly string[]) => xs[randomInt(xs.length)]!;
  const suffix = Array.from({ length: 4 }, () => SUFFIX[randomInt(SUFFIX.length)]).join("");
  return `vetra-${pick(ADJECTIVES)}-${pick(NOUNS)}-${suffix}`;
}

/** Stored as canonical ISO so the lexical comparisons below stay correct. */
function normalizeExpiresAt(v: string | null): string | null {
  if (v === null || v === "") return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new InvalidCodeInputError("expiresAt is not a date");
  return d.toISOString();
}

async function redemptionCount(db: Kysely<VetraLicensingDB>, code: string): Promise<number> {
  const { n } = await db.selectFrom("invite_redemptions")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("code", "=", code).executeTakeFirstOrThrow();
  return Number(n);
}

function view(row: InviteCodes, redemptions: number): InviteCodeView {
  return {
    code: row.code,
    kind: row.kind,
    label: row.label,
    active: Boolean(row.active),
    expiresAt: row.expires_at,
    maxUses: row.max_uses,
    redemptions,
    hasAnthropicKey: row.anthropic_key_ciphertext !== null,
    createdAt: row.created_at,
  };
}

export async function createInviteCode(
  db: Kysely<VetraLicensingDB>,
  input: { appId: string; kind: string; code: string | null; label: string | null; expiresAt: string | null; maxUses: number | null; anthropicKeyCiphertext: string | null; now: string },
): Promise<InviteCodeView> {
  const code = input.code === null ? generateCode() : normalizeCode(input.code);
  if (!code) throw new InvalidCodeInputError("code must not be empty");
  if (code.length > CODE_MAX_LENGTH) throw new InvalidCodeInputError(`code must be at most ${CODE_MAX_LENGTH} characters`);
  if (input.maxUses !== null && input.maxUses <= 0) throw new InvalidCodeInputError("maxUses must be positive");
  const row: InviteCodes = {
    code,
    app_id: input.appId,
    kind: input.kind,
    label: input.label,
    active: true,
    expires_at: normalizeExpiresAt(input.expiresAt),
    max_uses: input.maxUses,
    anthropic_key_ciphertext: input.anthropicKeyCiphertext,
    created_at: input.now,
  };
  // Not "do nothing": a silent no-op would hand back ANOTHER app's code view.
  const res = await db.insertInto("invite_codes").values(row)
    .onConflict((oc) => oc.column("code").doNothing()).executeTakeFirst();
  if (Number(res.numInsertedOrUpdatedRows ?? 0n) === 0) throw new InvalidCodeInputError("code already exists");
  return view(row, 0);
}

export async function setInviteCodeActive(db: Kysely<VetraLicensingDB>, appId: string, code: string, active: boolean): Promise<boolean> {
  const res = await db.updateTable("invite_codes").set({ active })
    .where("code", "=", normalizeCode(code)).where("app_id", "=", appId).executeTakeFirst();
  return Number(res.numUpdatedRows) > 0;
}

export async function listInviteCodes(db: Kysely<VetraLicensingDB>, appId: string): Promise<InviteCodeView[]> {
  const rows = await db.selectFrom("invite_codes").selectAll().where("app_id", "=", appId)
    .orderBy("created_at", "desc").execute();
  const out: InviteCodeView[] = [];
  for (const r of rows) out.push(view(r, await redemptionCount(db, r.code)));
  return out;
}

export async function getCode(db: Kysely<VetraLicensingDB>, code: string): Promise<InviteCodes | null> {
  return (await db.selectFrom("invite_codes").selectAll().where("code", "=", normalizeCode(code)).executeTakeFirst()) ?? null;
}

export async function isUsable(db: Kysely<VetraLicensingDB>, row: InviteCodes, now: string): Promise<boolean> {
  if (!row.active) return false;
  if (row.expires_at !== null && row.expires_at <= now) return false;
  return row.max_uses === null || (await redemptionCount(db, row.code)) < row.max_uses;
}

export async function findRedemption(db: Kysely<VetraLicensingDB>, code: string, userDid: string): Promise<InviteRedemptions | null> {
  return (await db.selectFrom("invite_redemptions").selectAll()
    .where("code", "=", normalizeCode(code)).where("user_did", "=", userDid).executeTakeFirst()) ?? null;
}

/** Locks the code row so two redeems cannot both take the last use. */
export async function reserveRedemption(db: Kysely<VetraLicensingDB>, code: string, userDid: string, now: string): Promise<boolean> {
  const c = normalizeCode(code);
  return db.transaction().execute(async (trx) => {
    const row = await trx.selectFrom("invite_codes").selectAll().where("code", "=", c).forUpdate().executeTakeFirst();
    if (!row || !(await isUsable(trx, row, now))) return false;
    await trx.insertInto("invite_redemptions")
      .values({ code: c, user_did: userDid, redeemed_at: now, access_expires: null, license_id: null })
      .onConflict((oc) => oc.columns(["code", "user_did"]).doNothing()).execute();
    return true;
  });
}

export async function attachLicence(db: Kysely<VetraLicensingDB>, code: string, userDid: string, licenseId: string, accessExpires: string | null): Promise<void> {
  await db.updateTable("invite_redemptions").set({ license_id: licenseId, access_expires: accessExpires })
    .where("code", "=", normalizeCode(code)).where("user_did", "=", userDid).execute();
}

export async function releaseReservation(db: Kysely<VetraLicensingDB>, code: string, userDid: string): Promise<void> {
  await db.deleteFrom("invite_redemptions")
    .where("code", "=", normalizeCode(code)).where("user_did", "=", userDid)
    .where("license_id", "is", null).execute();
}

export async function keyCiphertextForCode(db: Kysely<VetraLicensingDB>, code: string): Promise<string | null> {
  return (await getCode(db, code))?.anthropic_key_ciphertext ?? null;
}
```

`isUsable` takes `trx` inside the transaction: type its first parameter as `Kysely<VetraLicensingDB>` (a `Transaction<DB>` is assignable).

- [ ] **Step 5: Implement `key-vault.ts`**

```ts
import type { OpenBaoTransitClient } from "../vetra-cloud-secrets/openbao-transit.js";

/** Unchanged from vetra-access-codes, so keys attached before the move still decrypt. */
export const INVITE_KEY_TRANSIT_TENANT = "access-codes";

export class KeyStorageUnavailableError extends Error {
  override name = "KeyStorageUnavailableError";
  constructor() {
    super("attached keys cannot be stored: OPENBAO_ADDR is not configured");
  }
}

export interface KeyVault {
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
}

export function createKeyVault(transit: OpenBaoTransitClient | null): KeyVault | null {
  if (!transit) return null;
  return {
    async encrypt(plaintext) {
      await transit.ensureTenantKey(INVITE_KEY_TRANSIT_TENANT);
      return transit.encrypt(INVITE_KEY_TRANSIT_TENANT, plaintext);
    },
    decrypt: (ciphertext) => transit.decrypt(INVITE_KEY_TRANSIT_TENANT, ciphertext),
  };
}
```

- [ ] **Step 6: Implement the issuer**

`subgraphs/vetra-licensing/issuers/invite-code.ts`:

```ts
import type { Kysely } from "kysely";
import type { VetraLicensingDB } from "../db/schema.js";
import { normaliseUserDid } from "../did.js";
import { AlreadyHoldsError, issueLicense, type IssueDeps } from "../issue.js";
import {
  InvalidCodeError, attachLicence, findRedemption, getCode, normalizeCode,
  releaseReservation, reserveRedemption,
} from "../invite-codes.js";
import { resolveKind } from "../app-reads.js";
import type { LicenceRecord } from "../reads.js";

export interface InviteCodeIssuerDeps extends IssueDeps {
  db: Kysely<VetraLicensingDB>;
  /** The caller's ACTIVE, authorised licences of one app. */
  activeLicencesOf(appId: string, userDid: string): Promise<LicenceRecord[]>;
}

/**
 * InviteCodeIssuer. Reserve the use first (the cap is enforced under a row
 * lock), then issue; a failed issue gives the use back. Re-redeeming a code
 * you already redeemed returns the licence you got, which is also what makes
 * a crashed redeem safe to retry.
 */
export async function redeemInviteCode(
  deps: InviteCodeIssuerDeps,
  input: { code: string; user: string; label: string | null; upgrades: string | null; now: string },
): Promise<{ licenseId: string; appId: string; fresh: boolean }> {
  const user = normaliseUserDid(input.user);
  const code = normalizeCode(input.code);
  const row = await getCode(deps.db, code);
  if (!row) throw new InvalidCodeError();

  const existing = await findRedemption(deps.db, code, user);
  if (existing?.license_id) return { licenseId: existing.license_id, appId: row.app_id, fresh: false };

  if (!existing) {
    // A SHARED term grants one thing: an account on one environment. Holding
    // it twice is meaningless, so a second code for it is refused (contract
    // ALREADY_HOLDS). A DEDICATED term may be held many times: one environment
    // per licence chain ("buy another for a different project").
    if (!input.upgrades) {
      const app = await deps.apps.app(row.app_id);
      const resolved = app ? resolveKind(app, row.kind) : null;
      if (resolved?.ok && resolved.template.mode === "SHARED") {
        const held = await deps.activeLicencesOf(row.app_id, user);
        if (held.some((l) => l.kind === row.kind)) {
          throw new AlreadyHoldsError(`you already hold ${row.kind}`);
        }
      }
    }
    if (!(await reserveRedemption(deps.db, code, user, input.now))) throw new InvalidCodeError();
  }

  try {
    const issued = await issueLicense(deps, {
      appId: row.app_id,
      user,
      kind: row.kind,
      issuer: "INVITE_CODE",
      details: { code },
      issuedBy: user,
      label: input.label,
      upgrades: input.upgrades,
      now: input.now,
    });
    await attachLicence(deps.db, code, user, issued.licenseId, issued.end);
    return { licenseId: issued.licenseId, appId: row.app_id, fresh: true };
  } catch (err) {
    await releaseReservation(deps.db, code, user);
    throw err;
  }
}
```

- [ ] **Step 7: Run, check, commit**

Run: `npx vitest run subgraphs/vetra-licensing/__tests__/invite-codes.test.ts subgraphs/vetra-licensing/__tests__/invite-code-issuer.test.ts && npm run tsc && npm run lint:fix` → PASS.

```bash
git add subgraphs/vetra-licensing
git commit -m "feat(licensing): invite codes issue one term of one app"
```

---

### Task 8: Pure per-chain planner

**Files:**
- Create: `subgraphs/vetra-licensing/chain-plan.ts`
- Test: `subgraphs/vetra-licensing/__tests__/chain-plan.test.ts`

**Interfaces:**
- Consumes: `LicenseStatusName` (`transitions.ts`), `TemplateMode` (Task 5).
- Produces:
  ```ts
  export interface PlanLicence { id: string; user: string; kind: string | null; status: LicenseStatusName; issued: string | null; stage: string | null; root: string; authorised: boolean }
  export type PlanResolution =
    | { ok: true; mode: TemplateMode; templateId: string; templateHash: string; sharedStage: string | null; label: string }
    | { ok: false; reason: string };
  export interface PlanEnvironment { environmentId: string; rootLicenseId: string; licenseId: string; templateHash: string; endedAt: string | null }
  export type ChainStep =
    | { kind: "provision"; root: string; licence: PlanLicence; templateId: string; templateHash: string; label: string; environmentId: string | null }
    | { kind: "set-stage"; licenseId: string; stage: string }
    | { kind: "hold"; root: string; reason: string }
    | { kind: "ended"; root: string; environmentId: string }
    | { kind: "resumed"; root: string; environmentId: string };
  export function planChains(input: { licences: PlanLicence[]; environments: PlanEnvironment[]; resolve(kind: string | null): PlanResolution }): ChainStep[];
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { planChains, type PlanEnvironment, type PlanLicence, type PlanResolution } from "../chain-plan.js";

const U1 = "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";
const U2 = "did:pkh:eip155:1:0x2222222222222222222222222222222222222222";
const L = (id: string, over: Partial<PlanLicence> = {}): PlanLicence => ({
  id, user: U1, kind: "pro", status: "ACTIVE", issued: "2026-10-01T00:00:00.000Z",
  stage: null, root: id, authorised: true, ...over,
});
const E = (environmentId: string, rootLicenseId: string, over: Partial<PlanEnvironment> = {}): PlanEnvironment => ({
  environmentId, rootLicenseId, licenseId: rootLicenseId, templateHash: "h-pro", endedAt: null, ...over,
});
const RES: Record<string, PlanResolution> = {
  pro: { ok: true, mode: "DEDICATED", templateId: "t-pro", templateHash: "h-pro", sharedStage: null, label: "Pro" },
  max: { ok: true, mode: "DEDICATED", templateId: "t-max", templateHash: "h-max", sharedStage: null, label: "Max" },
  free: { ok: true, mode: "SHARED", templateId: "t-free", templateHash: "h-free", sharedStage: "env-app", label: "Free" },
  freeNoEnv: { ok: true, mode: "SHARED", templateId: "t-free", templateHash: "h-free", sharedStage: null, label: "Free" },
};
const resolve = (k: string | null): PlanResolution => (k && RES[k]) || { ok: false, reason: `no term ${k}` };
const plan = (licences: PlanLicence[], environments: PlanEnvironment[] = []) => planChains({ licences, environments, resolve });

describe("planChains: the matrix", () => {
  it("single owner, SHARED: provisions nothing, binds the licence to the App Environment", () => {
    expect(plan([L("l1", { kind: "free" })])).toStrictEqual([{ kind: "set-stage", licenseId: "l1", stage: "env-app" }]);
  });
  it("multi owner, SHARED: many licences, one environment, no provisioning", () => {
    expect(plan([L("l1", { kind: "free" }), L("l2", { kind: "free", user: U2, stage: "env-app" })])).toStrictEqual([
      { kind: "set-stage", licenseId: "l1", stage: "env-app" },
    ]);
  });
  it("single owner, DEDICATED: one environment for the licence", () => {
    expect(plan([L("l1")])).toStrictEqual([
      { kind: "provision", root: "l1", licence: L("l1"), templateId: "t-pro", templateHash: "h-pro", label: "Pro", environmentId: null },
    ]);
  });
  it("multi environment: a second purchase by the same owner is a second environment", () => {
    const steps = plan([L("l1"), L("l2")]);
    expect(steps.filter((s) => s.kind === "provision").map((s) => s.kind === "provision" && s.root)).toStrictEqual(["l1", "l2"]);
  });
  it("multi owner, DEDICATED: one environment per licence", () => {
    expect(plan([L("l1"), L("l2", { user: U2 })], [E("e1", "l1", { licenseId: "l1" })]).map((s) => s.kind)).toStrictEqual(["set-stage", "provision"]);
  });
});

describe("planChains: chains", () => {
  it("is quiet when the environment matches and the stage is set", () => {
    expect(plan([L("l1", { stage: "e1" })], [E("e1", "l1")])).toStrictEqual([]);
  });
  it("upgrade re-templates the same environment", () => {
    const head = L("l2", { kind: "max", root: "l1", issued: "2026-10-05T00:00:00.000Z", stage: "e1" });
    expect(plan([L("l1", { status: "REPLACED", stage: "e1" }), head], [E("e1", "l1")])).toStrictEqual([
      { kind: "provision", root: "l1", licence: head, templateId: "t-max", templateHash: "h-max", label: "Max", environmentId: "e1" },
    ]);
  });
  it("a renewal on the same template only repoints the row", () => {
    const head = L("l2", { root: "l1", issued: "2026-10-05T00:00:00.000Z", stage: "e1" });
    const steps = plan([L("l1", { status: "EXPIRED" }), head], [E("e1", "l1")]);
    expect(steps).toStrictEqual([{ kind: "provision", root: "l1", licence: head, templateId: "t-pro", templateHash: "h-pro", label: "Pro", environmentId: "e1" }]);
  });
  it("two ACTIVE licences in one chain: the newest is the head, deterministically", () => {
    const a = L("la", { root: "r", issued: "2026-10-01T00:00:00.000Z", stage: "e1" });
    const b = L("lb", { root: "r", issued: "2026-10-02T00:00:00.000Z", stage: "e1" });
    const one = plan([a, b], [E("e1", "r", { licenseId: "la" })]);
    const two = plan([b, a], [E("e1", "r", { licenseId: "la" })]);
    expect(one).toStrictEqual(two);
    expect(one[0]).toMatchObject({ kind: "provision", licence: { id: "lb" } });
  });
  it("sets the stage of a head that points elsewhere", () => {
    expect(plan([L("l1", { stage: "wrong" })], [E("e1", "l1")])).toStrictEqual([{ kind: "set-stage", licenseId: "l1", stage: "e1" }]);
  });
  it("a SHARED term whose App Environment is unset binds nothing", () => {
    expect(plan([L("l1", { kind: "freeNoEnv" })])).toStrictEqual([]);
  });
});

describe("planChains: never release on doubt", () => {
  it("holds an environment whose head kind does not resolve", () => {
    expect(plan([L("l1", { kind: "gone" })], [E("e1", "l1")])).toStrictEqual([{ kind: "hold", root: "l1", reason: "no term gone" }]);
  });
  it("holds a chain whose head resolves to SHARED but which owns an environment", () => {
    expect(plan([L("l1", { kind: "free" })], [E("e1", "l1")])).toStrictEqual([
      { kind: "hold", root: "l1", reason: "chain owns a DEDICATED environment but its head now resolves to SHARED" },
    ]);
  });
  it("holds an environment whose only ACTIVE licence has no provenance", () => {
    expect(plan([L("l1", { authorised: false })], [E("e1", "l1")])).toStrictEqual([
      { kind: "hold", root: "l1", reason: "ACTIVE licence without provenance" },
    ]);
  });
  it("holds an environment whose licences could not be read", () => {
    expect(plan([], [E("e1", "l1")])).toStrictEqual([{ kind: "hold", root: "l1", reason: "no licence of this chain could be read" }]);
  });
  it("holds while the next licence is ISSUED but not yet ACTIVE", () => {
    expect(plan([L("l1", { status: "EXPIRED" }), L("l2", { status: "ISSUED", root: "l1" })], [E("e1", "l1")])).toStrictEqual([
      { kind: "hold", root: "l1", reason: "licence issued but not yet active" },
    ]);
  });
  it("an unauthorised ACTIVE licence without an environment provisions nothing", () => {
    expect(plan([L("l1", { authorised: false })])).toStrictEqual([]);
  });
});

describe("planChains: ending and resuming", () => {
  it("reports a chain with no live licence as ended, once", () => {
    expect(plan([L("l1", { status: "EXPIRED" })], [E("e1", "l1")])).toStrictEqual([{ kind: "ended", root: "l1", environmentId: "e1" }]);
    expect(plan([L("l1", { status: "REVOKED" })], [E("e1", "l1", { endedAt: "t" })])).toStrictEqual([]);
  });
  it("an ended licence without an environment needs nothing (SHARED never ends anything)", () => {
    expect(plan([L("l1", { kind: "free", status: "EXPIRED" })])).toStrictEqual([]);
  });
  it("re-licensing an ended chain resumes its environment", () => {
    const head = L("l2", { root: "l1", stage: "e1", issued: "2026-10-09T00:00:00.000Z" });
    expect(plan([L("l1", { status: "EXPIRED" }), head], [E("e1", "l1", { endedAt: "t" })])).toStrictEqual([
      { kind: "resumed", root: "l1", environmentId: "e1" },
      { kind: "provision", root: "l1", licence: head, templateId: "t-pro", templateHash: "h-pro", label: "Pro", environmentId: "e1" },
    ]);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run subgraphs/vetra-licensing/__tests__/chain-plan.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
import type { LicenseStatusName } from "./transitions.js";
import type { TemplateMode } from "./app-reads.js";

export interface PlanLicence {
  id: string;
  user: string;
  kind: string | null;
  status: LicenseStatusName;
  issued: string | null;
  stage: string | null;
  /** Chain root: the licence itself unless it upgraded/renewed another. */
  root: string;
  /** Has an app_license_grants row. Without one it provisions and releases nothing. */
  authorised: boolean;
}

export type PlanResolution =
  | { ok: true; mode: TemplateMode; templateId: string; templateHash: string; sharedStage: string | null; label: string }
  | { ok: false; reason: string };

export interface PlanEnvironment {
  environmentId: string;
  rootLicenseId: string;
  licenseId: string;
  templateHash: string;
  endedAt: string | null;
}

export type ChainStep =
  | { kind: "provision"; root: string; licence: PlanLicence; templateId: string; templateHash: string; label: string; environmentId: string | null }
  | { kind: "set-stage"; licenseId: string; stage: string }
  | { kind: "hold"; root: string; reason: string }
  | { kind: "ended"; root: string; environmentId: string }
  | { kind: "resumed"; root: string; environmentId: string };

const newestFirst = (a: PlanLicence, b: PlanLicence) =>
  (b.issued ?? "").localeCompare(a.issued ?? "") || b.id.localeCompare(a.id);

/**
 * Pure. One environment per licence chain. A chain is served by its newest
 * authorised ACTIVE licence (the head). A chain is ENDED only when every
 * licence in it is terminal (EXPIRED, REVOKED, REPLACED); anything unknown —
 * an unresolvable kind, a missing provenance row, an unreadable chain, a
 * licence not yet active — is HELD. Holding is the only answer to doubt.
 */
export function planChains(input: {
  licences: PlanLicence[];
  environments: PlanEnvironment[];
  resolve(kind: string | null): PlanResolution;
}): ChainStep[] {
  const byRoot = new Map<string, PlanLicence[]>();
  for (const l of input.licences) {
    const list = byRoot.get(l.root) ?? [];
    list.push(l);
    byRoot.set(l.root, list);
  }
  const envByRoot = new Map(input.environments.map((e) => [e.rootLicenseId, e]));
  const roots = [...new Set([...byRoot.keys(), ...envByRoot.keys()])].sort();

  const steps: ChainStep[] = [];
  for (const root of roots) {
    const chain = byRoot.get(root) ?? [];
    const env = envByRoot.get(root) ?? null;

    if (chain.length === 0) {
      if (env) steps.push({ kind: "hold", root, reason: "no licence of this chain could be read" });
      continue;
    }

    const heads = chain.filter((l) => l.status === "ACTIVE" && l.authorised).sort(newestFirst);
    const head = heads[0];
    if (!head) {
      if (!env) continue;
      if (chain.some((l) => l.status === "ACTIVE")) {
        steps.push({ kind: "hold", root, reason: "ACTIVE licence without provenance" });
      } else if (chain.some((l) => l.status === "ISSUED")) {
        steps.push({ kind: "hold", root, reason: "licence issued but not yet active" });
      } else if (env.endedAt === null) {
        steps.push({ kind: "ended", root, environmentId: env.environmentId });
      }
      continue;
    }

    const r = input.resolve(head.kind);
    if (!r.ok) {
      steps.push({ kind: "hold", root, reason: r.reason });
      continue;
    }

    if (r.mode === "SHARED") {
      if (env) {
        steps.push({ kind: "hold", root, reason: "chain owns a DEDICATED environment but its head now resolves to SHARED" });
        continue;
      }
      if (r.sharedStage && head.stage !== r.sharedStage) {
        steps.push({ kind: "set-stage", licenseId: head.id, stage: r.sharedStage });
      }
      continue;
    }

    if (env && env.endedAt !== null) {
      steps.push({ kind: "resumed", root, environmentId: env.environmentId });
    }
    if (!env || env.licenseId !== head.id || env.templateHash !== r.templateHash) {
      steps.push({
        kind: "provision", root, licence: head, templateId: r.templateId,
        templateHash: r.templateHash, label: r.label, environmentId: env?.environmentId ?? null,
      });
    } else if (head.stage !== env.environmentId) {
      steps.push({ kind: "set-stage", licenseId: head.id, stage: env.environmentId });
    }
  }
  return steps;
}
```

(A provision step sets the stage itself after it knows the environment id; see Task 9.)

- [ ] **Step 4: Run, check, commit**

Run: `npx vitest run subgraphs/vetra-licensing/__tests__/chain-plan.test.ts && npm run tsc && npm run lint:fix` → PASS.

```bash
git add subgraphs/vetra-licensing/chain-plan.ts subgraphs/vetra-licensing/__tests__/chain-plan.test.ts
git commit -m "feat(licensing): plan environments per licence chain, holding on doubt"
```

---

### Task 9: `AppLicenseHandler` — chain-keyed provisioning, gated on the migration

Replaces `ProvisioningKeeper` in the subgraph wiring. The old keeper and its `app_user_environments` writes stop here; the old files are deleted in Task 17.

**Files:**
- Create: `subgraphs/vetra-licensing/environments.ts`, `subgraphs/vetra-licensing/handler.ts`
- Modify: `subgraphs/vetra-licensing/config.ts`, `subgraphs/vetra-licensing/index.ts`
- Test: `subgraphs/vetra-licensing/__tests__/environments.test.ts`, `__tests__/handler.test.ts`, `__tests__/handler-reactor.integration.test.ts`, `__tests__/config.test.ts`

**Interfaces:**
- Consumes: `planChains`, `ChainStep` (Task 8); `AppReads`, `resolveKind` (Task 5); `LicenceRecord`, `LicenseReads.allLicenceRecords` (Task 6); `GrantStore.chainRoots`, `authorisedIds`, `chainLabel` (Task 6); `didForAddress`, `normaliseUserDid`, `addressOfDid` (Task 3); `renderCreateActions`, `renderUpdateActions`, `validateTemplate`, `TemplateShape` (`template.ts`); `UNAPPLIED_TEMPLATE_HASH`, `AppEnvironmentCapReachedError` (`provision.ts`, re-exported from `environments.ts`); `setStage` action (Task 2).
- Produces:
  - `config.ts`: `LicensingConfig` gains `destroyEnabled: boolean` (`LICENSING_DESTROY_ENABLED`, default false), `migration: "off" | "dry-run" | "apply"` (`LICENSING_MIGRATION`, default `"dry-run"`), `deleteLicenseTypes: boolean` (`LICENSING_MIGRATION_DELETE_LICENSE_TYPES`, default false), `studioAppSlug: string` (`VETRA_STUDIO_APP_SLUG`, default `"vetra-studio"`), `studioPublisher: string | null` (`VETRA_STUDIO_PUBLISHER_ADDRESS`, else first `ADMINS` entry, lowercased), `renownStatsUrl: string | null` (`RENOWN_STATS_URL`), `licensingPublicUrl: string | null` (`VETRA_LICENSING_URL`).
  - `environments.ts`: `createChainEnvironmentRows(db, cfg): ChainEnvRows` with `byRoot(root)`, `byEnvironment(environmentId)`, `forApp(appId)`, `appIds()`, `countForApp(appId)`, `maxForApp(appId)`, `claim(row)`, `update(environmentId, patch)`, `remove(environmentId)`; `class EnvironmentNotReadyError`; `interface ProvisionChainInput { appId; root; licenseId; userDid; templateId; template: TemplateShape; templateHash; label; now }`; `interface ChainEnvDeps { rows: ChainEnvRows; envs: { create(): Promise<string>; execute(id: string, actions: Action[]): Promise<unknown>; getState(id: string): Promise<VetraCloudEnvironmentState | null>; delete(id: string): Promise<void> }; generateSubdomain(id: string): string }`; `provisionChain(deps: ChainEnvDeps, input: ProvisionChainInput): Promise<LicenseEnvironments>`.
  - `handler.ts`: `interface HandlerDeps` (below); `class AppLicenseHandler { start(): void; stop(): void; reconcileOnce(): Promise<void> }`.

- [ ] **Step 1: Config — failing test, then implement**

`subgraphs/vetra-licensing/__tests__/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadLicensingConfig } from "../config.js";

describe("loadLicensingConfig", () => {
  it("is safe by default", () => {
    expect(loadLicensingConfig({})).toMatchObject({
      enabled: false, dryRun: true, destroyEnabled: false, migration: "dry-run",
      deleteLicenseTypes: false, studioAppSlug: "vetra-studio", studioPublisher: null,
      renownStatsUrl: null, licensingPublicUrl: null,
    });
  });
  it("reads every switch", () => {
    expect(loadLicensingConfig({
      LICENSING_DESTROY_ENABLED: "true", LICENSING_MIGRATION: "apply",
      LICENSING_MIGRATION_DELETE_LICENSE_TYPES: "true", VETRA_STUDIO_APP_SLUG: "studio",
      ADMINS: " 0xAA , 0xbb", RENOWN_STATS_URL: "https://r/graphql/renown-stats",
      VETRA_LICENSING_URL: "https://switchboard.vetra.io/graphql/vetra-licensing",
    })).toMatchObject({
      destroyEnabled: true, migration: "apply", deleteLicenseTypes: true, studioAppSlug: "studio",
      studioPublisher: "0xaa", renownStatsUrl: "https://r/graphql/renown-stats",
      licensingPublicUrl: "https://switchboard.vetra.io/graphql/vetra-licensing",
    });
  });
  it("prefers the explicit studio publisher and falls back to dry-run on an unknown mode", () => {
    expect(loadLicensingConfig({ ADMINS: "0xaa", VETRA_STUDIO_PUBLISHER_ADDRESS: "0xCC", LICENSING_MIGRATION: "yes" }))
      .toMatchObject({ studioPublisher: "0xcc", migration: "dry-run" });
  });
});
```

Extend `loadLicensingConfig` accordingly:

```ts
  const trimmed = (name: string): string | null => {
    const v = env[name]?.trim();
    return v ? v : null;
  };
  const mode = (env.LICENSING_MIGRATION ?? "dry-run").toLowerCase();
  const firstAdmin = (env.ADMINS ?? "").split(",").map((a) => a.trim().toLowerCase()).find(Boolean) ?? null;
  // ...existing fields, plus:
    destroyEnabled: (env.LICENSING_DESTROY_ENABLED ?? "false").toLowerCase() === "true",
    migration: mode === "off" || mode === "apply" ? mode : "dry-run",
    deleteLicenseTypes: (env.LICENSING_MIGRATION_DELETE_LICENSE_TYPES ?? "false").toLowerCase() === "true",
    studioAppSlug: trimmed("VETRA_STUDIO_APP_SLUG") ?? "vetra-studio",
    studioPublisher: trimmed("VETRA_STUDIO_PUBLISHER_ADDRESS")?.toLowerCase() ?? firstAdmin,
    renownStatsUrl: trimmed("RENOWN_STATS_URL"),
    licensingPublicUrl: trimmed("VETRA_LICENSING_URL"),
```

Update every `LicensingConfig` literal in existing tests (`grep -rln "defaultMaxEnvironments" subgraphs/vetra-licensing/__tests__`) to spread `loadLicensingConfig({})` first, e.g. `const cfg = { ...loadLicensingConfig({}), enabled: true, dryRun: false, scanIntervalMs: 1_000 };`.

- [ ] **Step 2: Failing tests for `provisionChain`**

`subgraphs/vetra-licensing/__tests__/environments.test.ts` (PGlite rows + a fake env gateway):

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import type { Action } from "document-model";
import { up } from "../db/migrations.js";
import type { VetraLicensingDB } from "../db/schema.js";
import { loadLicensingConfig } from "../config.js";
import {
  AppEnvironmentCapReachedError, EnvironmentNotReadyError, createChainEnvironmentRows,
  provisionChain, type ChainEnvDeps, type ProvisionChainInput,
} from "../environments.js";
import { UNAPPLIED_TEMPLATE_HASH } from "../provision.js";

const DID = "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";
const TEMPLATE = { services: [{ id: "s", type: "CONNECT", prefix: null }], packages: [], size: null, baseDomain: null, packageRegistry: null };
const input = (over: Partial<ProvisionChainInput> = {}): ProvisionChainInput => ({
  appId: "app-1", root: "l1", licenseId: "l1", userDid: DID, templateId: "t",
  template: TEMPLATE, templateHash: "h1", label: "My vault", now: "2026-10-08T00:00:00.000Z", ...over,
});

let db: Kysely<VetraLicensingDB>;
let deps: ChainEnvDeps;
let states: Map<string, { status: string; packages: never[]; services: never[] }>;
let executed: { id: string; actions: Action[] }[];

beforeEach(async () => {
  db = new Kysely<VetraLicensingDB>({ dialect: new PGliteDialect(new PGlite()) });
  await up(db as Kysely<any>);
  states = new Map();
  executed = [];
  let n = 0;
  deps = {
    rows: createChainEnvironmentRows(db, { ...loadLicensingConfig({}), defaultMaxEnvironments: 2 }),
    envs: {
      create: async () => { const id = `env-${++n}`; states.set(id, { status: "DRAFT", packages: [], services: [] }); return id; },
      execute: async (id, actions) => { executed.push({ id, actions }); states.get(id)!.status = "CHANGES_APPROVED"; return states.get(id); },
      getState: async (id) => (states.get(id) as never) ?? null,
      delete: vi.fn(async (id: string) => { states.delete(id); }),
    },
    generateSubdomain: (id) => `sub-${id}`,
  };
});
afterEach(async () => { await db.destroy(); });

describe("provisionChain", () => {
  it("creates one environment owned by the holder's address, labelled with the project", async () => {
    const row = await provisionChain(deps, input());
    expect(row).toMatchObject({ environment_id: "env-1", root_license_id: "l1", license_id: "l1", user_did: DID, template_id: "t", template_hash: "h1", label: "My vault" });
    const types = executed[0]!.actions.map((a) => a.type);
    expect(types).toContain("INITIALIZE");
    expect(executed[0]!.actions.find((a) => a.type === "SET_OWNER")!.input).toStrictEqual({ address: "0x1111111111111111111111111111111111111111" });
  });

  it("is idempotent", async () => {
    await provisionChain(deps, input());
    await provisionChain(deps, input());
    expect(executed).toHaveLength(1);
  });

  it("repoints a renewed chain without dispatching anything", async () => {
    await provisionChain(deps, input());
    const row = await provisionChain(deps, input({ licenseId: "l2" }));
    expect(row.license_id).toBe("l2");
    expect(executed).toHaveLength(1);
  });

  it("re-templates the same environment on upgrade", async () => {
    await provisionChain(deps, input());
    const row = await provisionChain(deps, input({ licenseId: "l2", templateHash: "h2", templateId: "t2" }));
    expect(row).toMatchObject({ environment_id: "env-1", template_hash: "h2", template_id: "t2", license_id: "l2" });
    expect(executed.map((e) => e.id)).toStrictEqual(["env-1", "env-1"]);
    expect(executed[1]!.actions.map((a) => a.type)).not.toContain("INITIALIZE");
  });

  it("refuses to re-template a STOPPED environment until it is woken", async () => {
    await provisionChain(deps, input());
    states.get("env-1")!.status = "STOPPED";
    await expect(provisionChain(deps, input({ templateHash: "h2" }))).rejects.toBeInstanceOf(EnvironmentNotReadyError);
  });

  it("enforces the per-app cap only on creation", async () => {
    await provisionChain(deps, input({ root: "a", licenseId: "a" }));
    await provisionChain(deps, input({ root: "b", licenseId: "b" }));
    await expect(provisionChain(deps, input({ root: "c", licenseId: "c" }))).rejects.toBeInstanceOf(AppEnvironmentCapReachedError);
    await expect(provisionChain(deps, input({ root: "a", licenseId: "a2", templateHash: "h2" }))).resolves.toBeDefined();
  });

  it("a claim lost to a concurrent caller deletes its own document and adopts the winner", async () => {
    await deps.rows.claim({
      environment_id: "env-winner", root_license_id: "l1", app_id: "app-1", user_did: DID, license_id: "l1",
      template_id: "t", label: null, template_hash: "h1", ended_at: null, stopped_at: null, delete_after: null,
      created_at: "t", updated_at: "t",
    });
    const realByRoot = deps.rows.byRoot;
    deps.rows.byRoot = async () => null; // simulate the race: the read happened before the winner's insert
    const row = await provisionChain(deps, input());
    deps.rows.byRoot = realByRoot;
    expect(row.environment_id).toBe("env-winner");
    expect(deps.envs.delete).toHaveBeenCalledWith("env-1");
  });

  it("leaves an unapplied claim when the action list is rejected, and reuses it next time", async () => {
    deps.envs.execute = async () => { throw new Error("SET_OWNER rejected: nope"); };
    await expect(provisionChain(deps, input())).rejects.toThrow("SET_OWNER rejected");
    expect((await deps.rows.byRoot("l1"))!.template_hash).toBe(UNAPPLIED_TEMPLATE_HASH);
  });
});
```

- [ ] **Step 3: Implement `environments.ts`**

```ts
import type { Action } from "document-model";
import type { Kysely } from "kysely";
import type { VetraCloudEnvironmentState } from "document-models/vetra-cloud-environment";
import type { LicensingConfig } from "./config.js";
import type { LicenseEnvironments, VetraLicensingDB } from "./db/schema.js";
import { addressOfDid } from "./did.js";
import { AppEnvironmentCapReachedError, UNAPPLIED_TEMPLATE_HASH } from "./provision.js";
import { renderCreateActions, renderUpdateActions, validateTemplate, type TemplateShape } from "./template.js";

export { AppEnvironmentCapReachedError };

/** The environment is asleep or mid-transition; the next tick retries. */
export class EnvironmentNotReadyError extends Error {
  override name = "EnvironmentNotReadyError";
}

export type ChainEnvRows = ReturnType<typeof createChainEnvironmentRows>;

export function createChainEnvironmentRows(
  db: Kysely<VetraLicensingDB>,
  cfg: Pick<LicensingConfig, "defaultMaxEnvironments">,
) {
  const one = (q: Promise<LicenseEnvironments | undefined>) => q.then((r) => r ?? null);
  return {
    byRoot: (root: string) => one(db.selectFrom("license_environments").selectAll().where("root_license_id", "=", root).executeTakeFirst()),
    byEnvironment: (id: string) => one(db.selectFrom("license_environments").selectAll().where("environment_id", "=", id).executeTakeFirst()),
    forApp: (appId: string) => db.selectFrom("license_environments").selectAll().where("app_id", "=", appId).execute(),
    appIds: async () => (await db.selectFrom("license_environments").select("app_id").distinct().execute()).map((r) => r.app_id),
    countForApp: async (appId: string) => Number((await db.selectFrom("license_environments")
      .select((eb) => eb.fn.countAll<string>().as("n")).where("app_id", "=", appId).executeTakeFirstOrThrow()).n),
    maxForApp: async (appId: string) => (await db.selectFrom("app_environment_limits").select("max_environments")
      .where("app_id", "=", appId).executeTakeFirst())?.max_environments ?? cfg.defaultMaxEnvironments,
    /** Insert if the chain is unclaimed; return whichever row owns the chain. The UNIQUE root is the lock. */
    async claim(row: LicenseEnvironments): Promise<LicenseEnvironments> {
      await db.insertInto("license_environments").values(row)
        .onConflict((oc) => oc.column("root_license_id").doNothing()).execute();
      return db.selectFrom("license_environments").selectAll()
        .where("root_license_id", "=", row.root_license_id).executeTakeFirstOrThrow();
    },
    async update(environmentId: string, patch: Partial<Omit<LicenseEnvironments, "environment_id" | "root_license_id">>) {
      await db.updateTable("license_environments").set(patch).where("environment_id", "=", environmentId).execute();
    },
    async remove(environmentId: string) {
      await db.deleteFrom("license_environments").where("environment_id", "=", environmentId).execute();
    },
  };
}

export interface ChainEnvDeps {
  rows: ChainEnvRows;
  envs: {
    create(): Promise<string>;
    execute(id: string, actions: Action[]): Promise<unknown>;
    getState(id: string): Promise<VetraCloudEnvironmentState | null>;
    delete(id: string): Promise<void>;
  };
  generateSubdomain(id: string): string;
}

export interface ProvisionChainInput {
  appId: string;
  root: string;
  licenseId: string;
  userDid: string;
  templateId: string;
  template: TemplateShape;
  templateHash: string;
  label: string;
  now: string;
}

const NOT_APPLICABLE = new Set(["STOPPED", "TERMINATING", "DESTROYED", "ARCHIVED"]);

/**
 * Ensure the chain's one environment exists and matches the template.
 * Idempotent. Claim before act: a fresh document is written into the row
 * before any action is applied, so a rejected action list leaves a claim the
 * next call reuses rather than an orphan.
 */
export async function provisionChain(deps: ChainEnvDeps, input: ProvisionChainInput): Promise<LicenseEnvironments> {
  const existing = await deps.rows.byRoot(input.root);
  if (existing && existing.template_hash === input.templateHash) {
    if (existing.license_id === input.licenseId) return existing;
    await deps.rows.update(existing.environment_id, { license_id: input.licenseId, updated_at: input.now });
    return { ...existing, license_id: input.licenseId, updated_at: input.now };
  }

  if (!existing) {
    const [count, max] = await Promise.all([deps.rows.countForApp(input.appId), deps.rows.maxForApp(input.appId)]);
    if (count >= max) {
      throw new AppEnvironmentCapReachedError(`app ${input.appId} is at its ceiling of ${max} environments`);
    }
  }
  // Pure and may throw on a bad template: before anything is created.
  validateTemplate(input.template);

  let row = existing;
  if (!row) {
    const fresh = await deps.envs.create();
    row = await deps.rows.claim({
      environment_id: fresh,
      root_license_id: input.root,
      app_id: input.appId,
      user_did: input.userDid,
      license_id: input.licenseId,
      template_id: input.templateId,
      label: input.label,
      template_hash: UNAPPLIED_TEMPLATE_HASH,
      ended_at: null,
      stopped_at: null,
      delete_after: null,
      created_at: input.now,
      updated_at: input.now,
    });
    if (row.environment_id !== fresh) {
      await deps.envs.delete(fresh);
      if (row.template_hash === input.templateHash) return row;
    }
  }

  const state = await deps.envs.getState(row.environment_id);
  if (state && NOT_APPLICABLE.has(state.status)) {
    throw new EnvironmentNotReadyError(`environment ${row.environment_id} is ${state.status}`);
  }
  const actions = state && state.status !== "DRAFT"
    ? renderUpdateActions({ label: input.label, template: input.template, current: state })
    : renderCreateActions({
        label: input.label,
        subdomain: deps.generateSubdomain(row.environment_id),
        owner: addressOfDid(input.userDid),
        template: input.template,
      });
  await deps.envs.execute(row.environment_id, actions);

  const patch = {
    license_id: input.licenseId,
    template_id: input.templateId,
    template_hash: input.templateHash,
    label: input.label,
    updated_at: input.now,
  };
  await deps.rows.update(row.environment_id, patch);
  return { ...row, ...patch };
}
```

Run: `npx vitest run subgraphs/vetra-licensing/__tests__/environments.test.ts` → PASS.

- [ ] **Step 4: Failing handler unit tests**

`subgraphs/vetra-licensing/__tests__/handler.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { AppLicenseHandler, type HandlerDeps } from "../handler.js";
import { loadLicensingConfig } from "../config.js";
import type { AppDocView } from "../app-reads.js";
import type { LicenceRecord } from "../reads.js";
import type { LicenseEnvironments } from "../db/schema.js";

const DID = "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";
const tpl = (id: string, mode: "SHARED" | "DEDICATED") => ({
  id, name: null, mode, sharedEnvironment: null, templateHash: `h-${id}`, resolutionError: null,
  template: { services: [], packages: [], size: null, baseDomain: null, packageRegistry: null },
});
const APP: AppDocView = {
  id: "app-1", name: "KV", slug: "kv", owner: "0xo", status: "ACTIVE", identityDid: null,
  productionEnvironmentId: "env-app", artifacts: [],
  templates: [tpl("ded", "DEDICATED"), tpl("sh", "SHARED")],
  terms: [
    { id: "a", kind: "pro", label: "Pro", templateId: "ded", validityDays: null, issuers: ["PUBLISHER_GRANT"], status: "ACTIVE" },
    { id: "b", kind: "free", label: null, templateId: "sh", validityDays: null, issuers: ["PUBLISHER_GRANT"], status: "ACTIVE" },
  ],
};
const lic = (id: string, over: Partial<LicenceRecord> = {}): LicenceRecord => ({
  id, app: "app-1", user: DID, kind: "pro", issuer: "PUBLISHER_GRANT", status: "ACTIVE",
  issued: "2026-10-01T00:00:00.000Z", start: null, end: null, stage: null, details: null,
  replacedBy: null, legacyLicenseTypeId: null, ...over,
});

function harness(over: Partial<HandlerDeps> = {}, licences: LicenceRecord[] = [lic("l1")]) {
  const provisioned: string[] = [];
  const staged: [string, string][] = [];
  const logger = { info: vi.fn(), warn: vi.fn() };
  const deps: HandlerDeps = {
    licences: async () => licences,
    chainRoots: async () => new Map(),
    authorisedIds: async () => new Set(licences.map((l) => l.id)),
    chainLabel: async () => "Project A",
    app: async (id) => (id === "app-1" ? APP : null),
    environments: async () => [],
    environmentAppIds: async () => [],
    provision: vi.fn(async (input) => {
      provisioned.push(input.root);
      return { environment_id: `env-${input.root}` } as LicenseEnvironments;
    }),
    setStage: vi.fn(async (licenseId, stage) => { staged.push([licenseId, stage]); }),
    onEnded: vi.fn(async () => {}),
    onResumed: vi.fn(async () => {}),
    afterApp: vi.fn(async () => {}),
    migrationComplete: async () => true,
    cfg: { ...loadLicensingConfig({}), enabled: true, dryRun: false },
    logger,
    now: () => "2026-10-08T00:00:00.000Z",
    ...over,
  };
  return { deps, provisioned, staged, logger, handler: new AppLicenseHandler(deps) };
}

describe("AppLicenseHandler", () => {
  it("does nothing until the migration reports complete", async () => {
    const h = harness({ migrationComplete: async () => false });
    await h.handler.reconcileOnce();
    expect(h.provisioned).toStrictEqual([]);
    expect(h.logger.info).toHaveBeenCalledWith(expect.stringContaining("waiting for the licensing migration"));
  });

  it("does nothing when disabled", async () => {
    const h = harness({ cfg: { ...loadLicensingConfig({}), enabled: false } });
    await h.handler.reconcileOnce();
    expect(h.provisioned).toStrictEqual([]);
  });

  it("provisions a DEDICATED chain with the chain's project label, then binds the stage", async () => {
    const h = harness();
    await h.handler.reconcileOnce();
    expect(h.deps.provision).toHaveBeenCalledWith(expect.objectContaining({ root: "l1", licenseId: "l1", userDid: DID, templateId: "ded", templateHash: "h-ded", label: "Project A" }));
    expect(h.staged).toStrictEqual([["l1", "env-l1"]]);
  });

  it("falls back to the term label when the chain has none", async () => {
    const h = harness({ chainLabel: async () => null });
    await h.handler.reconcileOnce();
    expect(h.deps.provision).toHaveBeenCalledWith(expect.objectContaining({ label: "Pro" }));
  });

  it("SHARED never provisions: it binds the stage to the App Environment", async () => {
    const h = harness({}, [lic("l1", { kind: "free" })]);
    await h.handler.reconcileOnce();
    expect(h.provisioned).toStrictEqual([]);
    expect(h.staged).toStrictEqual([["l1", "env-app"]]);
  });

  it("only logs in dry run", async () => {
    const h = harness({ cfg: { ...loadLicensingConfig({}), enabled: true, dryRun: true } });
    await h.handler.reconcileOnce();
    expect(h.provisioned).toStrictEqual([]);
    expect(h.logger.info).toHaveBeenCalledWith(expect.stringContaining("dry run: app app-1"));
  });

  it("holds everything of an app whose document cannot be read", async () => {
    const h = harness({ app: async () => null });
    await h.handler.reconcileOnce();
    expect(h.provisioned).toStrictEqual([]);
    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining("app app-1 has no readable document; holding"));
  });

  it("maps a legacy 0x holder to its DID and skips an unparseable one", async () => {
    const h = harness({}, [lic("l1", { user: "0x1111111111111111111111111111111111111111" }), lic("l2", { user: "garbage" })]);
    await h.handler.reconcileOnce();
    expect(h.provisioned).toStrictEqual(["l1"]);
    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining("licence l2"));
  });

  it("one failing apply does not stop the others", async () => {
    const h = harness({ provision: vi.fn(async (i) => { if (i.root === "l1") throw new Error("cap"); return { environment_id: "env-l2" } as LicenseEnvironments; }) }, [lic("l1"), lic("l2")]);
    await h.handler.reconcileOnce();
    expect(h.staged).toStrictEqual([["l2", "env-l2"]]);
  });

  it("visits apps that only have environments left, and reports ended chains", async () => {
    const env = { environment_id: "e1", root_license_id: "gone", license_id: "gone", template_hash: "h", ended_at: null } as LicenseEnvironments;
    const h = harness({ environmentAppIds: async () => ["app-1"], environments: async () => [env] }, [lic("gone", { status: "EXPIRED" })]);
    await h.handler.reconcileOnce();
    expect(h.deps.onEnded).toHaveBeenCalledWith("app-1", "e1");
  });
});
```

- [ ] **Step 5: Implement `handler.ts`**

```ts
import type { LicensingConfig } from "./config.js";
import type { AppDocView } from "./app-reads.js";
import { resolveKind } from "./app-reads.js";
import { planChains, type PlanLicence, type PlanResolution } from "./chain-plan.js";
import type { LicenseEnvironments } from "./db/schema.js";
import { normaliseUserDid } from "./did.js";
import type { ProvisionChainInput } from "./environments.js";
import type { LicenceRecord } from "./reads.js";

export interface HandlerDeps {
  licences(): Promise<LicenceRecord[]>;
  chainRoots(): Promise<Map<string, string>>;
  authorisedIds(): Promise<Set<string>>;
  chainLabel(rootLicenseId: string): Promise<string | null>;
  app(appId: string): Promise<AppDocView | null>;
  environments(appId: string): Promise<LicenseEnvironments[]>;
  environmentAppIds(): Promise<string[]>;
  provision(input: ProvisionChainInput): Promise<LicenseEnvironments>;
  setStage(licenseId: string, stage: string): Promise<void>;
  /** Task 10 wires the offboarding clock here; until then they only log. */
  onEnded(appId: string, environmentId: string): Promise<void>;
  onResumed(appId: string, environmentId: string): Promise<void>;
  /** Runs after an app's steps (offboarding ticks, reporting tokens). */
  afterApp(appId: string, environments: LicenseEnvironments[]): Promise<void>;
  /** True once the startup migration recorded `complete`. */
  migrationComplete(): Promise<boolean>;
  cfg: LicensingConfig;
  logger: Pick<Console, "info" | "warn">;
  now(): string;
}

/**
 * AppLicenseHandler: licence -> app.terms[kind] -> app.templates[templateId]
 * -> by mode. Timer-driven, re-entrancy guarded, every app isolated from
 * every other app's failures.
 */
export class AppLicenseHandler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly d: HandlerDeps) {}

  start(): void {
    if (this.timer) return;
    const tick = () => {
      if (this.running) return;
      this.running = true;
      this.reconcileOnce()
        .catch((err) => this.d.logger.warn(`[licensing] handler tick failed: ${String(err)}`))
        .finally(() => { this.running = false; });
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
    // Before the migration, license_environments is empty while live
    // environments exist: planning now would provision a second environment
    // for every live holder.
    if (!(await this.d.migrationComplete())) {
      this.d.logger.info("[licensing] handler idle: waiting for the licensing migration to complete");
      return;
    }

    const [licences, roots, authorised] = await Promise.all([
      this.d.licences(), this.d.chainRoots(), this.d.authorisedIds(),
    ]);
    const byApp = new Map<string, PlanLicence[]>();
    for (const l of licences) {
      let user: string;
      try {
        user = normaliseUserDid(l.user);
      } catch {
        this.d.logger.warn(`[licensing] licence ${l.id} has an unusable holder ${l.user}; skipping`);
        continue;
      }
      const list = byApp.get(l.app) ?? [];
      list.push({
        id: l.id, user, kind: l.kind, status: l.status, issued: l.issued,
        stage: l.stage, root: roots.get(l.id) ?? l.id, authorised: authorised.has(l.id),
      });
      byApp.set(l.app, list);
    }
    for (const appId of await this.d.environmentAppIds()) {
      if (!byApp.has(appId)) byApp.set(appId, []);
    }

    for (const [appId, appLicences] of byApp) {
      try {
        await this.reconcileApp(appId, appLicences);
      } catch (err) {
        this.d.logger.warn(`[licensing] reconcile of app ${appId} failed: ${String(err)}`);
      }
    }
  }

  private async reconcileApp(appId: string, licences: PlanLicence[]): Promise<void> {
    const app = await this.d.app(appId);
    if (!app) {
      this.d.logger.warn(`[licensing] app ${appId} has no readable document; holding all its licences and environments`);
      return;
    }
    const environments = await this.d.environments(appId);
    const resolve = (kind: string | null): PlanResolution => {
      const r = resolveKind(app, kind);
      return r.ok
        ? { ok: true, mode: r.template.mode, templateId: r.template.id, templateHash: r.template.templateHash, sharedStage: r.stage, label: r.label }
        : r;
    };
    const steps = planChains({
      licences,
      environments: environments.map((e) => ({
        environmentId: e.environment_id, rootLicenseId: e.root_license_id,
        licenseId: e.license_id, templateHash: e.template_hash, endedAt: e.ended_at,
      })),
      resolve,
    });

    if (this.d.cfg.dryRun) {
      const count = (k: string) => steps.filter((s) => s.kind === k).length;
      this.d.logger.info(
        `[licensing] dry run: app ${appId} would provision ${count("provision")}, set-stage ${count("set-stage")}, end ${count("ended")}, resume ${count("resumed")}; holding ${count("hold")}`,
      );
      return;
    }

    for (const step of steps) {
      try {
        switch (step.kind) {
          case "hold":
            this.d.logger.warn(`[licensing] holding chain ${step.root} of app ${appId}: ${step.reason}`);
            break;
          case "set-stage":
            await this.d.setStage(step.licenseId, step.stage);
            break;
          case "ended":
            await this.d.onEnded(appId, step.environmentId);
            break;
          case "resumed":
            await this.d.onResumed(appId, step.environmentId);
            break;
          case "provision": {
            const resolved = resolveKind(app, step.licence.kind);
            if (!resolved.ok) break; // planChains only emits resolvable heads
            const row = await this.d.provision({
              appId,
              root: step.root,
              licenseId: step.licence.id,
              userDid: step.licence.user,
              templateId: step.templateId,
              template: resolved.template.template,
              templateHash: step.templateHash,
              label: (await this.d.chainLabel(step.root)) ?? step.label,
              now: this.d.now(),
            });
            if (step.licence.stage !== row.environment_id) {
              await this.d.setStage(step.licence.id, row.environment_id);
            }
            break;
          }
        }
      } catch (err) {
        this.d.logger.warn(`[licensing] ${step.kind} for app ${appId} failed: ${String(err)}`);
      }
    }
    await this.d.afterApp(appId, await this.d.environments(appId));
  }
}
```

Run: `npx vitest run subgraphs/vetra-licensing/__tests__/handler.test.ts` → PASS.

- [ ] **Step 6: Integration test against a real reactor**

`subgraphs/vetra-licensing/__tests__/handler-reactor.integration.test.ts` — real reactor + PGlite. Build an app document (as in Task 6's integration test) with templates `ded` (DEDICATED, one CONNECT service), `max` (DEDICATED, CONNECT + SWITCHBOARD) and `sh` (SHARED), terms `pro → ded`, `max → max`, `free → sh` (all ACTIVE, issuers `PUBLISHER_GRANT`), and `SET_PRODUCTION_ENVIRONMENT { environmentId: "env-app" }`. Wire `AppLicenseHandler` with the production pieces (`createReactorLicenseReads(...).allLicenceRecords`, `createGrantStore(db)`, `createAppReads`, `createChainEnvironmentRows`, `provisionChain` over `createReactorEnvGateway(client)`, `setStage = (id, stage) => licenseGateway.execute(id, [actions.setStage({ stage })])`, `migrationComplete: async () => true`, `onEnded/onResumed/afterApp` no-ops). Tests:

```ts
  it("DEDICATED: issuing provisions one environment owned by the holder and binds the licence", async () => {
    const { licenseId } = await issueLicense(issueDeps, { appId: APP, user: DID, kind: "pro", issuer: "PUBLISHER_GRANT", details: {}, issuedBy: "0xo", label: "Vault A", now: NOW });
    await handler.reconcileOnce();
    const rows = await db.selectFrom("license_environments").selectAll().execute();
    expect(rows).toHaveLength(1);
    const state = await envs.getState(rows[0]!.environment_id);
    expect(state).toMatchObject({ owner: ADDR, label: "Vault A" });
    expect((await reads.licenceRecord(licenseId))!.stage).toBe(rows[0]!.environment_id);
    await handler.reconcileOnce();
    expect(await db.selectFrom("license_environments").selectAll().execute()).toHaveLength(1);
  });

  it("a second purchase creates a second environment; an upgrade re-templates in place", async () => {
    const second = await issueLicense(issueDeps, { appId: APP, user: DID, kind: "pro", issuer: "PUBLISHER_GRANT", details: {}, issuedBy: "0xo", label: "Vault B", now: NOW });
    await handler.reconcileOnce();
    expect(await db.selectFrom("license_environments").selectAll().execute()).toHaveLength(2);
    const upgraded = await issueLicense(issueDeps, { appId: APP, user: DID, kind: "max", issuer: "PUBLISHER_GRANT", details: {}, issuedBy: "0xo", upgrades: second.licenseId, now: NOW });
    await handler.reconcileOnce();
    const rows = await db.selectFrom("license_environments").selectAll().execute();
    expect(rows).toHaveLength(2);
    const row = rows.find((r) => r.root_license_id === second.licenseId)!;
    expect(row.license_id).toBe(upgraded.licenseId);
    const state = await envs.getState(row.environment_id);
    expect(state!.services.filter((s) => s.enabled).map((s) => s.type).sort()).toStrictEqual(["CONNECT", "SWITCHBOARD"]);
    expect((await reads.licenceRecord(second.licenseId))!.status).toBe("REPLACED");
  });

  it("SHARED: never provisions, binds the stage to the App Environment", async () => {
    const before = await countEnvDocuments();
    const { licenseId } = await issueLicense(issueDeps, { appId: APP, user: DID2, kind: "free", issuer: "PUBLISHER_GRANT", details: {}, issuedBy: "0xo", now: NOW });
    await handler.reconcileOnce();
    expect(await countEnvDocuments()).toBe(before);
    expect((await reads.licenceRecord(licenseId))!.stage).toBe("env-app");
  });
```

(`countEnvDocuments` as in `provisioning-keeper.integration.test.ts`.)

- [ ] **Step 7: Wire it in `index.ts`**

Replace the `ProvisioningKeeper` construction with:

```ts
    const appReads = createAppReads(this.reactorClient as never);
    const grants = createGrantStore(db);
    const chainRows = createChainEnvironmentRows(db, cfg);
    const chainEnvDeps: ChainEnvDeps = { rows: chainRows, envs, generateSubdomain };
    this.handler = new AppLicenseHandler({
      licences: () => reads.allLicenceRecords(),
      chainRoots: () => grants.chainRoots(),
      authorisedIds: () => grants.authorisedIds(),
      chainLabel: (root) => grants.chainLabel(root),
      app: (id) => appReads.app(id),
      environments: (appId) => chainRows.forApp(appId),
      environmentAppIds: () => chainRows.appIds(),
      provision: (input) => provisionChain(chainEnvDeps, input),
      setStage: (licenseId, stage) => gateway.execute(licenseId, [licenseActions.setStage({ stage })]),
      onEnded: async (appId, env) => console.info(`[licensing] chain of environment ${env} (app ${appId}) ended`),
      onResumed: async (appId, env) => console.info(`[licensing] chain of environment ${env} (app ${appId}) resumed`),
      afterApp: async () => {},
      migrationComplete: async () =>
        (await db.selectFrom("licensing_migration_steps").select("step").where("step", "=", "complete").executeTakeFirst()) !== undefined,
      cfg,
      logger: console,
      now: () => new Date().toISOString(),
    });
    this.handler.start();
```

Rename the field `provisioningKeeper` to `handler: AppLicenseHandler | null` and stop it in `onDisconnect`. Remove the imports of `ProvisioningKeeper`, `createTypeSnapshots`, `resolveTemplateForLicence` from `index.ts` (the files stay until Task 17).

- [ ] **Step 8: Run, check, commit**

Run: `npx vitest run subgraphs/vetra-licensing && npm run tsc && npm run lint:fix` → PASS.

```bash
git add subgraphs/vetra-licensing
git commit -m "feat(licensing): provision one environment per licence chain, by template mode"
```

---

### Task 10: Offboarding clock, subscription warnings, wake guard

**Files:**
- Create: `subgraphs/vetra-licensing/offboarding.ts`, `subgraphs/vetra-housekeeping/wake.ts`
- Modify: `subgraphs/vetra-licensing/index.ts` (wire `onEnded`, `onResumed`, `afterApp`), `subgraphs/vetra-housekeeping/index.ts` (use `createWake`)
- Test: `subgraphs/vetra-licensing/__tests__/offboarding.test.ts`, `subgraphs/vetra-housekeeping/wake.test.ts`

**Interfaces:**
- Consumes: `ChainEnvRows` (Task 9), `EnvGateway` shape, `sleepEnvironment`, `wakeEnvironment` (`document-models/vetra-cloud-environment`), `LicensingConfig.destroyEnabled`.
- Produces:
  - `offboarding.ts`: `STOP_AFTER_DAYS = 14`, `FINAL_WARNING_AFTER_DAYS = 83`, `DESTROY_AFTER_DAYS = 90`, `EXPIRY_WARNING_DAYS = 7`; `addDays(iso: string, days: number): string`; `offboardingAction(env: { endedAt: string | null; stoppedAt: string | null; deleteAfter: string | null }, now: string): "none" | "stop" | "destroy"`; `interface SubscriptionWarning { kind: "EXPIRING" | "ENDED_STOP_PENDING" | "STOPPED_DELETE_PENDING" | "DELETE_IMMINENT"; at: string; message: string }`; `subscriptionWarnings(input: { status: string; end: string | null; mode: "SHARED" | "DEDICATED"; endedAt: string | null; stoppedAt: string | null; deleteAfter: string | null }, now: string): SubscriptionWarning[]`; `interface OffboardingDeps { rows: ChainEnvRows; envStatus(id: string): Promise<string | null>; sleep(id: string): Promise<void>; wake(id: string): Promise<void>; destroy(id: string): Promise<void>; cfg: Pick<LicensingConfig, "destroyEnabled">; logger: Pick<Console, "info" | "warn">; now(): string }`; `markEnded(deps, environmentId)`; `markResumed(deps, environmentId)`; `tickOffboarding(deps, rows: LicenseEnvironments[])`; `isLicenceStopped(db: Kysely<VetraLicensingDB>, environmentId: string): Promise<boolean>`.
  - `subgraphs/vetra-housekeeping/wake.ts`: `createWake(deps: { findStudioByHost(host: string): Promise<StudioRow | null>; dispatchWake(envId: string): Promise<void>; isLicenceStopped(envId: string): Promise<boolean> }): (host: string) => Promise<StudioPowerStateResult>`.

- [ ] **Step 1: Failing tests**

`subgraphs/vetra-licensing/__tests__/offboarding.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import type { VetraLicensingDB } from "../db/schema.js";
import { loadLicensingConfig } from "../config.js";
import { createChainEnvironmentRows } from "../environments.js";
import {
  addDays, isLicenceStopped, markEnded, markResumed, offboardingAction,
  subscriptionWarnings, tickOffboarding, type OffboardingDeps,
} from "../offboarding.js";

const END = "2026-10-01T00:00:00.000Z";
const at = (days: number) => addDays(END, days);

describe("offboardingAction (the timeline)", () => {
  const ended = { endedAt: END, stoppedAt: null, deleteAfter: at(90) };
  it.each([
    [{ endedAt: null, stoppedAt: null, deleteAfter: null }, at(500), "none"],
    [ended, at(13.99), "none"],
    [ended, at(14), "stop"],
    [{ ...ended, stoppedAt: at(14) }, at(89.99), "none"],
    [{ ...ended, stoppedAt: at(14) }, at(90), "destroy"],
  ] as const)("%o at %s -> %s", (env, now, want) => {
    expect(offboardingAction(env, now)).toBe(want);
  });
});

describe("subscriptionWarnings", () => {
  const ded = { status: "ACTIVE", end: END, mode: "DEDICATED" as const, endedAt: null, stoppedAt: null, deleteAfter: null };
  it("warns from end - 7 days, with the days left", () => {
    expect(subscriptionWarnings(ded, at(-8))).toStrictEqual([]);
    expect(subscriptionWarnings(ded, at(-7))).toStrictEqual([{ kind: "EXPIRING", at: END, message: "Your licence expires in 7 days." }]);
    expect(subscriptionWarnings(ded, at(-1))[0]!.message).toBe("Your licence expires in 1 day.");
  });
  it("after the end: shutdown in 14 days, then deletion pending, then imminent", () => {
    const off = { ...ded, status: "EXPIRED", endedAt: END, deleteAfter: at(90) };
    expect(subscriptionWarnings(off, at(1))).toStrictEqual([{ kind: "ENDED_STOP_PENDING", at: at(14), message: `Your environment stops on ${at(14).slice(0, 10)}. Renew to keep it running.` }]);
    expect(subscriptionWarnings({ ...off, stoppedAt: at(14) }, at(20))[0]!.kind).toBe("STOPPED_DELETE_PENDING");
    expect(subscriptionWarnings({ ...off, stoppedAt: at(14) }, at(83))[0]).toMatchObject({ kind: "DELETE_IMMINENT", at: at(90) });
  });
  it("SHARED licences never warn about an environment", () => {
    expect(subscriptionWarnings({ ...ded, mode: "SHARED", status: "EXPIRED", endedAt: END }, at(1))).toStrictEqual([]);
  });
});

describe("offboarding against rows", () => {
  let db: Kysely<VetraLicensingDB>;
  let deps: OffboardingDeps;
  let status: Map<string, string>;
  let now = at(0);
  beforeEach(async () => {
    db = new Kysely<VetraLicensingDB>({ dialect: new PGliteDialect(new PGlite()) });
    await up(db as Kysely<any>);
    const rows = createChainEnvironmentRows(db, loadLicensingConfig({}));
    await rows.claim({ environment_id: "e1", root_license_id: "r", app_id: "a", user_did: "d", license_id: "r", template_id: null, label: null, template_hash: "h", ended_at: null, stopped_at: null, delete_after: null, created_at: "t", updated_at: "t" });
    status = new Map([["e1", "READY"]]);
    now = at(0);
    deps = {
      rows,
      envStatus: async (id) => status.get(id) ?? null,
      sleep: vi.fn(async (id) => { status.set(id, "STOPPED"); }),
      wake: vi.fn(async (id) => { status.set(id, "CHANGES_APPROVED"); }),
      destroy: vi.fn(async (id) => { status.delete(id); }),
      cfg: { destroyEnabled: true },
      logger: { info: vi.fn(), warn: vi.fn() },
      now: () => now,
    };
  });
  afterEach(async () => { await db.destroy(); });
  const row = () => deps.rows.byEnvironment("e1");

  it("walks the whole timeline, then re-licensing a stopped environment wakes it", async () => {
    await markEnded(deps, "e1");
    expect(await row()).toMatchObject({ ended_at: at(0), delete_after: at(90), stopped_at: null });
    now = at(14);
    await tickOffboarding(deps, [(await row())!]);
    expect(deps.sleep).toHaveBeenCalledWith("e1");
    expect((await row())!.stopped_at).toBe(at(14));
    now = at(30);
    await markResumed(deps, "e1");
    expect(deps.wake).toHaveBeenCalledWith("e1");
    expect(await row()).toMatchObject({ ended_at: null, stopped_at: null, delete_after: null });
  });

  it("re-stops a stopped environment someone woke", async () => {
    await markEnded(deps, "e1");
    now = at(14);
    await tickOffboarding(deps, [(await row())!]);
    status.set("e1", "READY");
    now = at(15);
    await tickOffboarding(deps, [(await row())!]);
    expect(deps.sleep).toHaveBeenCalledTimes(2);
  });

  it("does not stop an environment mid-deploy; retries next tick", async () => {
    await markEnded(deps, "e1");
    status.set("e1", "DEPLOYING");
    now = at(14);
    await tickOffboarding(deps, [(await row())!]);
    expect(deps.sleep).not.toHaveBeenCalled();
    expect((await row())!.stopped_at).toBeNull();
  });

  it("destroys at +90 days and forgets the row", async () => {
    await markEnded(deps, "e1");
    now = at(90);
    await tickOffboarding(deps, [(await row())!]);
    expect(deps.destroy).toHaveBeenCalledWith("e1");
    expect(await row()).toBeNull();
  });

  it("only logs the destroy while LICENSING_DESTROY_ENABLED is off", async () => {
    deps.cfg = { destroyEnabled: false };
    await markEnded(deps, "e1");
    now = at(90);
    await tickOffboarding(deps, [(await row())!]);
    expect(deps.destroy).not.toHaveBeenCalled();
    expect(await row()).not.toBeNull();
    expect(deps.logger.info).toHaveBeenCalledWith(expect.stringContaining("would destroy e1"));
  });

  it("reports licence-stopped environments for the housekeeping wake guard", async () => {
    expect(await isLicenceStopped(db, "e1")).toBe(false);
    await markEnded(deps, "e1");
    now = at(14);
    await tickOffboarding(deps, [(await row())!]);
    expect(await isLicenceStopped(db, "e1")).toBe(true);
    expect(await isLicenceStopped(db, "unknown")).toBe(false);
  });
});
```

`subgraphs/vetra-housekeeping/wake.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createWake } from "./wake.js";

const row = { envId: "e1", subdomain: "s", status: "STOPPED", owner: "0x1", poolState: null, tenantId: "t", services: null };

describe("housekeeping wake", () => {
  it("wakes a sleeping studio", async () => {
    const dispatchWake = vi.fn(async () => {});
    const wake = createWake({ findStudioByHost: async () => row, dispatchWake, isLicenceStopped: async () => false });
    expect((await wake("s.vetra.io")).status).toBe("WAKING");
    expect(dispatchWake).toHaveBeenCalledWith("e1");
  });
  it("refuses to wake an environment licensing has stopped", async () => {
    const dispatchWake = vi.fn(async () => {});
    const wake = createWake({ findStudioByHost: async () => row, dispatchWake, isLicenceStopped: async () => true });
    expect((await wake("s.vetra.io")).status).toBe("SLEEPING");
    expect(dispatchWake).not.toHaveBeenCalled();
  });
  it("throws STUDIO_NOT_FOUND for an unknown host", async () => {
    const wake = createWake({ findStudioByHost: async () => null, dispatchWake: vi.fn(), isLicenceStopped: async () => false });
    await expect(wake("x.vetra.io")).rejects.toThrow("STUDIO_NOT_FOUND");
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run subgraphs/vetra-licensing/__tests__/offboarding.test.ts subgraphs/vetra-housekeeping/wake.test.ts` → FAIL.

- [ ] **Step 3: Implement `offboarding.ts`**

```ts
import type { Kysely } from "kysely";
import type { LicensingConfig } from "./config.js";
import type { LicenseEnvironments, VetraLicensingDB } from "./db/schema.js";
import type { ChainEnvRows } from "./environments.js";

export const EXPIRY_WARNING_DAYS = 7;
export const STOP_AFTER_DAYS = 14;
export const FINAL_WARNING_AFTER_DAYS = 83;
export const DESTROY_AFTER_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * DAY_MS).toISOString();
}

export function offboardingAction(
  env: { endedAt: string | null; stoppedAt: string | null; deleteAfter: string | null },
  now: string,
): "none" | "stop" | "destroy" {
  if (!env.endedAt) return "none";
  if (env.deleteAfter && now >= env.deleteAfter) return "destroy";
  if (!env.stoppedAt && now >= addDays(env.endedAt, STOP_AFTER_DAYS)) return "stop";
  return "none";
}

export interface SubscriptionWarning {
  kind: "EXPIRING" | "ENDED_STOP_PENDING" | "STOPPED_DELETE_PENDING" | "DELETE_IMMINENT";
  at: string;
  message: string;
}

const day = (iso: string) => iso.slice(0, 10);

/** Banners for vetra.io. Computed on read; email is out of scope. */
export function subscriptionWarnings(
  input: { status: string; end: string | null; mode: "SHARED" | "DEDICATED"; endedAt: string | null; stoppedAt: string | null; deleteAfter: string | null },
  now: string,
): SubscriptionWarning[] {
  const out: SubscriptionWarning[] = [];
  if (input.mode === "DEDICATED" && input.stoppedAt && input.deleteAfter) {
    const imminent = now >= addDays(input.deleteAfter, -(DESTROY_AFTER_DAYS - FINAL_WARNING_AFTER_DAYS));
    out.push(imminent
      ? { kind: "DELETE_IMMINENT", at: input.deleteAfter, message: `Your stopped environment will be deleted on ${day(input.deleteAfter)}.` }
      : { kind: "STOPPED_DELETE_PENDING", at: input.deleteAfter, message: `Your environment is stopped; its data is deleted on ${day(input.deleteAfter)}.` });
  } else if (input.mode === "DEDICATED" && input.endedAt) {
    const stop = addDays(input.endedAt, STOP_AFTER_DAYS);
    out.push({ kind: "ENDED_STOP_PENDING", at: stop, message: `Your environment stops on ${day(stop)}. Renew to keep it running.` });
  }
  if (input.status === "ACTIVE" && input.end && now < input.end && now >= addDays(input.end, -EXPIRY_WARNING_DAYS)) {
    const days = Math.ceil((Date.parse(input.end) - Date.parse(now)) / DAY_MS);
    out.push({ kind: "EXPIRING", at: input.end, message: `Your licence expires in ${days} ${days === 1 ? "day" : "days"}.` });
  }
  return out;
}

export interface OffboardingDeps {
  rows: ChainEnvRows;
  envStatus(environmentId: string): Promise<string | null>;
  sleep(environmentId: string): Promise<void>;
  wake(environmentId: string): Promise<void>;
  /** Hard delete of the environment document (gitops + namespace teardown follow). */
  destroy(environmentId: string): Promise<void>;
  cfg: Pick<LicensingConfig, "destroyEnabled">;
  logger: Pick<Console, "info" | "warn">;
  now(): string;
}

const SLEEPABLE = new Set(["READY", "DEPLOYMENt_FAILED"]);
const ALREADY_DOWN = new Set(["STOPPED", "TERMINATING", "DESTROYED", "ARCHIVED"]);

export async function markEnded(deps: OffboardingDeps, environmentId: string): Promise<void> {
  const now = deps.now();
  await deps.rows.update(environmentId, { ended_at: now, delete_after: addDays(now, DESTROY_AFTER_DAYS), updated_at: now });
}

/** Re-licensing the same chain before deletion brings the environment back. */
export async function markResumed(deps: OffboardingDeps, environmentId: string): Promise<void> {
  if ((await deps.envStatus(environmentId)) === "STOPPED") await deps.wake(environmentId);
  await deps.rows.update(environmentId, { ended_at: null, stopped_at: null, delete_after: null, updated_at: deps.now() });
}

export async function tickOffboarding(deps: OffboardingDeps, rows: LicenseEnvironments[]): Promise<void> {
  for (const row of rows) {
    const id = row.environment_id;
    try {
      const action = offboardingAction({ endedAt: row.ended_at, stoppedAt: row.stopped_at, deleteAfter: row.delete_after }, deps.now());
      const status = await deps.envStatus(id);
      if (action === "destroy") {
        if (!deps.cfg.destroyEnabled) {
          deps.logger.info(`[licensing] would destroy ${id} (ended ${row.ended_at}); LICENSING_DESTROY_ENABLED is off`);
          continue;
        }
        if (status !== null) await deps.destroy(id);
        await deps.rows.remove(id);
        deps.logger.info(`[licensing] destroyed ${id}, ${DESTROY_AFTER_DAYS} days after its licence ended`);
        continue;
      }
      const shouldBeDown = action === "stop" || row.stopped_at !== null;
      if (!shouldBeDown) continue;
      if (status !== null && SLEEPABLE.has(status)) {
        await deps.sleep(id);
      } else if (status !== null && !ALREADY_DOWN.has(status)) {
        continue; // mid-transition: next tick
      }
      if (!row.stopped_at) await deps.rows.update(id, { stopped_at: deps.now(), updated_at: deps.now() });
    } catch (err) {
      deps.logger.warn(`[licensing] offboarding of ${id} failed: ${String(err)}`);
    }
  }
}

const UNDEFINED_TABLE = "42P01";

/** For housekeeping's public wake: never undo a licence stop. */
export async function isLicenceStopped(db: Kysely<VetraLicensingDB>, environmentId: string): Promise<boolean> {
  try {
    const row = await db.selectFrom("license_environments").select("stopped_at")
      .where("environment_id", "=", environmentId).executeTakeFirst();
    return Boolean(row?.stopped_at);
  } catch (err) {
    // Licensing has not migrated in this deployment: nothing can be licence-stopped.
    if ((err as { code?: string }).code === UNDEFINED_TABLE) return false;
    throw err;
  }
}
```

- [ ] **Step 4: Implement the wake guard**

`subgraphs/vetra-housekeeping/wake.ts` — move the inline `wake` closure from `index.ts` here, adding the guard:

```ts
import { deriveStudioPowerState } from "./policy.js";
import type { StudioRow } from "./db.js";
import type { StudioPowerStateResult } from "./resolvers.js";

export function createWake(deps: {
  findStudioByHost(host: string): Promise<StudioRow | null>;
  dispatchWake(envId: string): Promise<void>;
  /** An environment stopped by licence offboarding stays stopped until re-licensed. */
  isLicenceStopped(envId: string): Promise<boolean>;
}): (host: string) => Promise<StudioPowerStateResult> {
  const result = (host: string, row: StudioRow, status: StudioPowerStateResult["status"]): StudioPowerStateResult => ({
    host, envId: row.envId, subdomain: row.subdomain ?? null, owner: row.owner ?? null, status,
  });
  return async (host) => {
    const row = await deps.findStudioByHost(host);
    if (!row) throw new Error("STUDIO_NOT_FOUND");
    const current = deriveStudioPowerState(row);
    if (current !== "SLEEPING") return result(host, row, current);
    if (await deps.isLicenceStopped(row.envId)) return result(host, row, "SLEEPING");
    await deps.dispatchWake(row.envId);
    return result(host, row, "WAKING");
  };
}
```

(Match `result(...)`'s field list to the existing `result` helper in `vetra-housekeeping/index.ts`; reuse that helper by moving it into `wake.ts` and importing it back.) In `vetra-housekeeping/index.ts`: `const licensingDb = (await this.relationalDb.createNamespace("vetra-licensing")) as unknown as Kysely<VetraLicensingDB>;` and `const wake = createWake({ findStudioByHost: (h) => findStudioByHost(envDb, h), dispatchWake: (id) => dispatch(id, wakeEnvironment({})), isLicenceStopped: (id) => isLicenceStopped(licensingDb, id) });`.

- [ ] **Step 5: Wire the clock into the handler**

In `subgraphs/vetra-licensing/index.ts`:

```ts
    const offboarding: OffboardingDeps = {
      rows: chainRows,
      envStatus: async (id) => (await envs.getState(id))?.status ?? null,
      sleep: async (id) => { await envs.execute(id, [sleepEnvironment({})]); },
      wake: async (id) => { await envs.execute(id, [wakeEnvironment({})]); },
      destroy: (id) => envs.delete(id),
      cfg,
      logger: console,
      now: () => new Date().toISOString(),
    };
    // in the AppLicenseHandler deps:
      onEnded: (_appId, env) => markEnded(offboarding, env),
      onResumed: (_appId, env) => markResumed(offboarding, env),
      afterApp: (_appId, rows) => tickOffboarding(offboarding, rows.filter((r) => r.ended_at !== null)),
```

`envs.delete` → `deleteDocument`; the studio-pool deletion subscription (`subgraphs/vetra-studio-pool/index.ts`) already removes the read-model row and gitops tenant dir for every deleted environment document. Also delete the environment's `environment_reporting_tokens` row in `destroy` once Task 14 exists (Task 14 adds it).

- [ ] **Step 6: Run, check, commit**

Run: `npx vitest run subgraphs/vetra-licensing subgraphs/vetra-housekeeping && npm run tsc && npm run lint:fix` → PASS.

```bash
git add subgraphs/vetra-licensing subgraphs/vetra-housekeeping
git commit -m "feat(licensing): offboarding clock for ended dedicated environments"
```

---

### Task 11: `vetraPublisher` on terms, templates, codes and allow lists

The licence-type mutations go; the contract's surface replaces them. Field and type names are copied verbatim from `2026-10-08-licensing-api-contract.md` § vetraPublisher.

**Files:**
- Rewrite: `subgraphs/vetra-licensing/publisher-schema.ts`, `subgraphs/vetra-licensing/publisher-resolvers.ts`
- Modify: `subgraphs/vetra-licensing/publisher-errors.ts`, `subgraphs/vetra-licensing/index.ts`, `subgraphs/vetra-licensing/schema.ts` (machine `AppUserEnvironment` stays defined there; publisher no longer reuses it)
- Delete: `__tests__/publisher-tier-mutations.test.ts`, `__tests__/publisher-create-validation.test.ts`, `__tests__/publisher-grant-mutations.test.ts`, `__tests__/publisher-queries.test.ts` (replaced below)
- Test: `__tests__/publisher-api.test.ts` (new), `__tests__/publisher-isolation.test.ts` (rewritten), `__tests__/publisher-errors.test.ts` (updated), `__tests__/schema-composition.test.ts` (updated)

**Interfaces:**
- Consumes: Tasks 3–7, 9 (`createChainEnvironmentRows`), `resolveOwnerApp`, `createOwnerAppLookup`, `makeRequireEnabled`, `KeyVault`.
- Produces:
  - `publisher-errors.ts`: `class ForbiddenError`, `class UnknownTemplateError`, `class UnknownTermError`, `class UnknownInviteCodeError`, `class InvalidPublisherInputError`; `toLicensingGraphQLError(err: unknown): unknown` mapping (contract codes):

    | Error | `extensions.code` |
    |---|---|
    | `UnauthenticatedError` | `UNAUTHENTICATED` |
    | `NotAppOwnerError`, `UnknownAppError`, `UnknownLicenseError`, `UnknownTemplateError`, `UnknownTermError`, `UnknownInviteCodeError` | `NOT_FOUND` |
    | `ForbiddenError`, `UnknownAppIdentityError` (machine caller whose identity is not an app) | `FORBIDDEN` |
    | `AppIdentityInactiveError` | `APP_NOT_ACTIVE` |
    | `NotOnAllowListError` | `NOT_ON_ALLOW_LIST` |
    | `TermNotIssuableError` | `TERM_NOT_ISSUABLE` |
    | `UnsupportedDidError` | `UNSUPPORTED_DID` |
    | `LicensingDisabledError` | `LICENSING_DISABLED` |
    | `InvalidCodeError` | `INVALID_CODE` |
    | `AlreadyHoldsError` | `ALREADY_HOLDS` |
    | `OperationRejectedError`, `InvalidPublisherInputError`, `InvalidCodeInputError`, `LicenceNotUpgradableError`, `KeyStorageUnavailableError`, `UnknownTemplateSizeError`, `UnsupportedTemplateServiceError`, `MissingPackageNameError` | `INVALID_INPUT` |

    `toPublisherGraphQLError` stays as an alias of `toLicensingGraphQLError`.
  - `publisher-resolvers.ts`: `interface PublisherDeps { auth: PublisherAuthDeps; apps: AppReads; appGateway: DocGateway; licences: Pick<LicenseReads, "allLicenceRecords" | "licenceRecord">; licenseGateway: LicenseGateway; issue: PublisherGrantDeps; grants: GrantStore; envRows: ChainEnvRows; codes: Kysely<VetraLicensingDB>; keyVault: KeyVault | null; cfg: LicensingConfig; newId(): string; now(): string }`; `createPublisherResolvers(deps: PublisherDeps): Record<string, unknown>`.

- [ ] **Step 1: Rewrite the schema**

`subgraphs/vetra-licensing/publisher-schema.ts` — the contract block verbatim, plus the unchanged artifact types and the root extensions:

```ts
import { gql } from "graphql-tag";
import type { DocumentNode } from "graphql";

/**
 * The human surface (contract: 2026-10-08-licensing-api-contract.md). Every
 * field takes an appId or a document id and authorises it against the app's
 * owner on every call. Enum-valued fields travel as String.
 */
export const publisherSchema: DocumentNode = gql`
  type PublisherApp { id: String! name: String! status: String! }

  type PublisherTemplate {
    id: String!
    name: String
    mode: String!
    sharedEnvironment: String
    size: String
    baseDomain: String
    packageRegistry: String
    services: [PublisherTemplateService!]!
    packages: [PublisherTemplatePackage!]!
    templateHash: String!
    "Environments currently provisioned from this template (DEDICATED), for the 'affects N' warning."
    environmentCount: Int!
  }

  type PublisherTemplateService {
    id: String!
    type: String!
    prefix: String
    artifactName: String
    artifactChannel: String
  }
  type PublisherTemplatePackage { id: String! packageName: String version: String }

  type PublisherTerm {
    id: String!
    kind: String!
    label: String
    templateId: String
    validityDays: Int
    issuers: [String!]!
    status: String!
    activeLicenses: Int!
  }

  type PublisherLicense {
    id: String!
    user: String!
    kind: String!
    issuer: String!
    status: String!
    start: String
    end: String
    environmentId: String
    replacedBy: String
  }

  type PublisherEnvironment {
    environmentId: String!
    user: String!
    licenseId: String!
    rootLicenseId: String!
    label: String
    templateHash: String!
    stoppedAt: String
    deleteAfter: String
  }

  type PublisherInviteCode {
    code: String!
    kind: String!
    label: String
    active: Boolean!
    expiresAt: String
    maxUses: Int
    redemptions: Int!
    hasAnthropicKey: Boolean!
    createdAt: String!
  }

  type PublisherAllowListEntry { user: String! addedAt: String! }

  "One artifact the app has published, as the template builder offers it."
  type PublisherAppArtifact {
    kind: String!
    name: String!
    versions: [PublisherArtifactVersion!]!
    channels: [PublisherArtifactChannel!]!
  }
  type PublisherArtifactVersion { version: String! reference: String! }
  type PublisherArtifactChannel { channel: String! version: String! }

  input AddTemplateInput { appId: String! name: String mode: String! }
  input SetTemplateDetailsInput {
    appId: String!
    templateId: String!
    name: String
    mode: String
    sharedEnvironment: String
    size: String
    baseDomain: String
    packageRegistry: String
  }
  input AddTemplateServiceInput {
    appId: String!
    templateId: String!
    type: String!
    prefix: String
    artifactName: String
    artifactChannel: String
  }
  input AddTemplatePackageInput { appId: String! templateId: String! packageName: String! version: String }
  input RemoveTemplateEntryInput { appId: String! templateId: String! id: String! }
  input AddTermInput {
    appId: String!
    kind: String!
    label: String
    templateId: String
    validityDays: Int
    issuers: [String!]
  }
  input SetTermDetailsInput {
    appId: String!
    termId: String!
    kind: String
    label: String
    templateId: String
    validityDays: Int
    issuers: [String!]
  }
  input IssueGrantInput { appId: String! kind: String! user: String! label: String }
  input ReplaceGrantInput { licenseId: String! kind: String! }
  input RevokeLicenseInput { licenseId: String! reason: String }
  input CreateInviteCodeInput {
    appId: String!
    kind: String!
    label: String
    "Omit to generate a random code."
    code: String
    expiresAt: String
    maxUses: Int
    "Write-only; stored encrypted, never returned."
    anthropicKey: String
  }

  type VetraPublisherQueries {
    myApps: [PublisherApp!]!
    templates(appId: String!): [PublisherTemplate!]!
    terms(appId: String!): [PublisherTerm!]!
    appArtifacts(appId: String!): [PublisherAppArtifact!]!
    licenses(appId: String!, status: String): [PublisherLicense!]!
    environments(appId: String!): [PublisherEnvironment!]!
    inviteCodes(appId: String!): [PublisherInviteCode!]!
    allowList(appId: String!): [PublisherAllowListEntry!]!
  }

  type VetraPublisherMutations {
    addTemplate(input: AddTemplateInput!): String!
    setTemplateDetails(input: SetTemplateDetailsInput!): Boolean!
    addTemplateService(input: AddTemplateServiceInput!): Boolean!
    removeTemplateService(input: RemoveTemplateEntryInput!): Boolean!
    addTemplatePackage(input: AddTemplatePackageInput!): Boolean!
    removeTemplatePackage(input: RemoveTemplateEntryInput!): Boolean!
    deleteTemplate(appId: String!, templateId: String!): Boolean!
    addTerm(input: AddTermInput!): String!
    setTermDetails(input: SetTermDetailsInput!): Boolean!
    publishTerm(appId: String!, termId: String!): Boolean!
    retireTerm(appId: String!, termId: String!): Boolean!
    issueGrant(input: IssueGrantInput!): String!
    replaceGrant(input: ReplaceGrantInput!): String!
    revokeLicense(input: RevokeLicenseInput!): Boolean!
    createInviteCode(input: CreateInviteCodeInput!): PublisherInviteCode!
    setInviteCodeActive(appId: String!, code: String!, active: Boolean!): Boolean!
    addToAllowList(appId: String!, user: String!): Boolean!
    removeFromAllowList(appId: String!, user: String!): Boolean!
  }

  extend type Query { vetraPublisher: VetraPublisherQueries! }
  extend type Mutation { vetraPublisher: VetraPublisherMutations! }
`;
```

- [ ] **Step 2: Write the failing API tests**

`subgraphs/vetra-licensing/__tests__/publisher-api.test.ts` runs the resolvers against a real reactor (app + licence documents) and PGlite, which is what pins the reducer → `INVALID_INPUT` path:

```ts
import { beforeAll, describe, expect, it } from "vitest";
import { GraphQLError } from "graphql";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { ReactorBuilder, ReactorClientBuilder } from "@powerhousedao/reactor";
import { actions as appActions } from "document-models/vetra-app";
import { documentModels } from "../../../document-models/document-models.js";
import { createReactorAppDocStore } from "../../vetra-apps/app-doc-store.js";
import { up } from "../db/migrations.js";
import type { VetraLicensingDB } from "../db/schema.js";
import { APP_DOC_TYPE, createAppReads } from "../app-reads.js";
import { createReactorDocGateway } from "../doc-gateway.js";
import { createReactorLicenseReads } from "../reads.js";
import { createReactorLicenseGateway } from "../license-gateway.js";
import { createGrantStore } from "../grants.js";
import { createChainEnvironmentRows } from "../environments.js";
import { loadLicensingConfig } from "../config.js";
import { createOwnerAppLookup } from "../owner-apps.js";
import { createPublisherResolvers } from "../publisher-resolvers.js";

const NOW = "2026-10-08T00:00:00.000Z";
const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HOLDER = "0x1111111111111111111111111111111111111111";
const HOLDER_DID = `did:pkh:eip155:1:${HOLDER}`;
const APP = "0b8a3c0e-5d0e-4e3e-9a55-1c3b9b8f2a22";
const asOwner = { user: { address: OWNER, networkId: "eip155", chainId: 1 }, isAdmin: () => false };

type R = Record<string, Record<string, (p: unknown, a: unknown, c: unknown) => Promise<unknown>>>;
let r: R;
const q = (field: string, args: object) => r.VetraPublisherQueries![field]!({}, args, asOwner);
const m = (field: string, args: object) => r.VetraPublisherMutations![field]!({}, args, asOwner);
const code = async (p: Promise<unknown>) => {
  try { await p; return "OK"; } catch (e) { return (e as GraphQLError).extensions?.code; }
};

beforeAll(async () => {
  const client = await new ReactorClientBuilder()
    .withReactorBuilder(new ReactorBuilder().withDocumentModelSources([...documentModels]))
    .build();
  const db = new Kysely<VetraLicensingDB>({ dialect: new PGliteDialect(new PGlite()) });
  await up(db as Kysely<any>);
  const appDocs = createReactorAppDocStore(client as never);
  await appDocs.create(APP);
  await appDocs.execute(APP, [
    appActions.setAppDetails({ name: "KV", slug: "kv", owner: OWNER }),
    appActions.setStatus({ status: "ACTIVE" }),
  ]);
  const apps = createAppReads(client as never);
  const reads = createReactorLicenseReads(client as never);
  const licenseGateway = createReactorLicenseGateway(client as never);
  const grants = createGrantStore(db);
  const cfg = { ...loadLicensingConfig({}), enabled: true };
  // The table knows no app, so ownership comes from the document (Task 5's fallback).
  r = createPublisherResolvers({
    auth: createOwnerAppLookup({ table: { byId: async () => null, byOwner: async () => [] }, apps }),
    apps,
    appGateway: createReactorDocGateway(client as never, APP_DOC_TYPE, "app"),
    licences: reads,
    licenseGateway,
    issue: {
      apps,
      licence: (id) => reads.licenceRecord(id),
      createLicenseDocument: licenseGateway.create,
      executeLicence: licenseGateway.execute,
      grants,
      logger: console,
    },
    grants,
    envRows: createChainEnvironmentRows(db, cfg),
    codes: db,
    keyVault: { encrypt: async (p) => `enc:${p}`, decrypt: async (c) => c.slice(4) },
    cfg,
    newId: () => randomUUID(),
    now: () => NOW,
  }) as R;
});

describe("vetraPublisher end to end", () => {
  let templateId: string;
  let termId: string;
  let licenseId: string;

  it("builds a template and a term, and publishes it", async () => {
    templateId = (await m("addTemplate", { input: { appId: APP, name: "Pro", mode: "DEDICATED" } })) as string;
    await m("addTemplateService", { input: { appId: APP, templateId, type: "CONNECT" } });
    await m("setTemplateDetails", { input: { appId: APP, templateId, size: "VETRA_AGENT_S" } });
    termId = (await m("addTerm", { input: { appId: APP, kind: "2026-pro", templateId, validityDays: 30, issuers: ["PUBLISHER_GRANT", "INVITE_CODE"] } })) as string;
    await m("publishTerm", { appId: APP, termId });
    const [t] = (await q("templates", { appId: APP })) as { name: string; size: string; services: unknown[]; environmentCount: number; mode: string }[];
    expect(t).toMatchObject({ name: "Pro", mode: "DEDICATED", size: "VETRA_AGENT_S", environmentCount: 0 });
    expect(t!.services).toHaveLength(1);
    expect(await q("terms", { appId: APP })).toStrictEqual([
      { id: termId, kind: "2026-pro", label: null, templateId, validityDays: 30, issuers: ["PUBLISHER_GRANT", "INVITE_CODE"], status: "ACTIVE", activeLicenses: 0 },
    ]);
  });

  it("an omitted template field is left alone; an explicit null clears it", async () => {
    await m("setTemplateDetails", { input: { appId: APP, templateId, baseDomain: "vetra.io" } });
    expect((await q("templates", { appId: APP }) as { size: string | null }[])[0]!.size).toBe("VETRA_AGENT_S");
    await m("setTemplateDetails", { input: { appId: APP, templateId, size: null } });
    expect((await q("templates", { appId: APP }) as { size: string | null }[])[0]!.size).toBeNull();
  });

  it("surfaces reducer refusals as INVALID_INPUT", async () => {
    expect(await code(m("deleteTemplate", { appId: APP, templateId }))).toBe("INVALID_INPUT");
    expect(await code(m("setTermDetails", { input: { appId: APP, termId, kind: "renamed" } }))).toBe("INVALID_INPUT");
    expect(await code(m("addTemplate", { input: { appId: APP, mode: "SOMETIMES" } }))).toBe("INVALID_INPUT");
    expect(await code(m("addTerm", { input: { appId: APP, kind: "x", issuers: ["SOMEONE"] } }))).toBe("INVALID_INPUT");
  });

  it("grants only to the allow list, then lists licences and environments", async () => {
    expect(await code(m("issueGrant", { input: { appId: APP, kind: "2026-pro", user: HOLDER } }))).toBe("NOT_ON_ALLOW_LIST");
    expect(await m("addToAllowList", { appId: APP, user: HOLDER })).toBe(true);
    expect(await q("allowList", { appId: APP })).toStrictEqual([{ user: HOLDER_DID, addedAt: NOW }]);
    licenseId = (await m("issueGrant", { input: { appId: APP, kind: "2026-pro", user: HOLDER, label: "Vault" } })) as string;
    const [l] = (await q("licenses", { appId: APP })) as Record<string, unknown>[];
    expect(l).toMatchObject({ id: licenseId, user: HOLDER_DID, kind: "2026-pro", issuer: "PUBLISHER_GRANT", status: "ACTIVE", environmentId: null, replacedBy: null });
    expect((await q("terms", { appId: APP }) as { activeLicenses: number }[])[0]!.activeLicenses).toBe(1);
  });

  it("refuses a kind that is not issuable and a non-pkh user", async () => {
    expect(await code(m("issueGrant", { input: { appId: APP, kind: "nope", user: HOLDER } }))).toBe("TERM_NOT_ISSUABLE");
    expect(await code(m("addToAllowList", { appId: APP, user: "did:key:z6Mk" }))).toBe("UNSUPPORTED_DID");
  });

  it("replaces a grant in place and revokes", async () => {
    const termB = (await m("addTerm", { input: { appId: APP, kind: "2026-max", templateId, issuers: ["PUBLISHER_GRANT"] } })) as string;
    await m("publishTerm", { appId: APP, termId: termB });
    const replacement = (await m("replaceGrant", { input: { licenseId, kind: "2026-max" } })) as string;
    const list = (await q("licenses", { appId: APP })) as { id: string; status: string; replacedBy: string | null }[];
    expect(list.find((x) => x.id === licenseId)).toMatchObject({ status: "REPLACED", replacedBy: replacement });
    expect(await m("revokeLicense", { input: { licenseId: replacement, reason: "test" } })).toBe(true);
    expect(await code(m("revokeLicense", { input: { licenseId: replacement } }))).toBe("INVALID_INPUT");
  });

  it("creates invite codes for an issuable term, never returning the key", async () => {
    const c = (await m("createInviteCode", { input: { appId: APP, kind: "2026-pro", maxUses: 5, anthropicKey: "sk-ant-x" } })) as Record<string, unknown>;
    expect(c).toMatchObject({ kind: "2026-pro", active: true, maxUses: 5, redemptions: 0, hasAnthropicKey: true });
    expect(JSON.stringify(c)).not.toContain("sk-ant");
    expect(await code(m("createInviteCode", { input: { appId: APP, kind: "2026-max" } }))).toBe("TERM_NOT_ISSUABLE");
    expect(await m("setInviteCodeActive", { appId: APP, code: c.code, active: false })).toBe(true);
    expect(await code(m("setInviteCodeActive", { appId: APP, code: "nope", active: false }))).toBe("NOT_FOUND");
    expect((await q("inviteCodes", { appId: APP }) as { active: boolean }[])[0]!.active).toBe(false);
  });

  it("removes from the allow list", async () => {
    expect(await m("removeFromAllowList", { appId: APP, user: HOLDER_DID })).toBe(true);
    expect(await q("allowList", { appId: APP })).toStrictEqual([]);
  });
});
```

Fill in the `beforeAll` body with the construction shown in its comment (real code, no comments left behind). Rewrite `publisher-isolation.test.ts` on the same harness with a second app `APP_B` owned by `0xbbbb…`: for **every** query and mutation field of `VetraPublisherQueries` / `VetraPublisherMutations` (enumerate `Object.keys(r.VetraPublisherQueries)` and assert the list equals the contract's field list, so a new field cannot skip isolation), owner A calling with B's `appId` / B's licence id / B's template id gets `NOT_FOUND`, and B's app document revision and B's tables are unchanged afterwards (compare `header.revision.global` and row counts before/after). Add a positive control per field (A on A's own ids is not `NOT_FOUND`). Update `publisher-errors.test.ts` to the code table above (one assertion per row) and `schema-composition.test.ts` to the new field lists.

- [ ] **Step 3: Run to see them fail**

Run: `npx vitest run subgraphs/vetra-licensing/__tests__/publisher-api.test.ts` → FAIL (old resolvers).

- [ ] **Step 4: Implement the resolvers**

`subgraphs/vetra-licensing/publisher-resolvers.ts` (full replacement):

```ts
import type { Kysely } from "kysely";
import { actions as appActions } from "document-models/vetra-app";
import { actions as licenseActions } from "document-models/app-owner-license";
import type { Action } from "document-model";
import { UnauthenticatedError, type AuthContext } from "./auth.js";
import { resolveOwnerApp, NotAppOwnerError, UnknownAppError, type PublisherAuthDeps } from "./publisher-auth.js";
import type { AppReads } from "./app-reads.js";
import type { DocGateway } from "./doc-gateway.js";
import type { LicenseGateway } from "./license-gateway.js";
import type { LicenseReads, LicenceRecord } from "./reads.js";
import type { GrantStore } from "./grants.js";
import type { ChainEnvRows } from "./environments.js";
import type { VetraLicensingDB } from "./db/schema.js";
import type { KeyVault } from "./key-vault.js";
import { KeyStorageUnavailableError } from "./key-vault.js";
import type { LicensingConfig } from "./config.js";
import { makeRequireEnabled } from "./resolvers.js";
import { normaliseUserDid } from "./did.js";
import { grantLicense, replaceGrant, type PublisherGrantDeps } from "./issuers/publisher-grant.js";
import { TermNotIssuableError } from "./issue.js";
import { createInviteCode, listInviteCodes, setInviteCodeActive } from "./invite-codes.js";
import {
  InvalidPublisherInputError, UnknownInviteCodeError, UnknownLicenseError,
  UnknownTemplateError, UnknownTermError, toLicensingGraphQLError,
} from "./publisher-errors.js";

export interface PublisherDeps {
  auth: PublisherAuthDeps;
  apps: AppReads;
  appGateway: DocGateway;
  licences: Pick<LicenseReads, "allLicenceRecords" | "licenceRecord">;
  licenseGateway: LicenseGateway;
  issue: PublisherGrantDeps;
  grants: GrantStore;
  envRows: ChainEnvRows;
  codes: Kysely<VetraLicensingDB>;
  keyVault: KeyVault | null;
  cfg: LicensingConfig;
  newId(): string;
  now(): string;
}

type Ctx = AuthContext & { isAdmin?: (a: string) => boolean };
type In<T> = { input: T };

const MODES = ["SHARED", "DEDICATED"] as const;
const ISSUERS = ["INVITE_CODE", "PUBLISHER_GRANT", "ACHRA_SUBSCRIPTION"] as const;
const SERVICE_TYPES = ["CONNECT", "SWITCHBOARD", "FUSION", "CLINT", "DOCLING", "PAPERLESS", "SPECKLE"] as const;
const CHANNELS = ["DEV", "STAGING", "LATEST"] as const;

function oneOf<T extends string>(list: readonly T[], v: string, field: string): T {
  const found = list.find((x) => x === v);
  if (!found) throw new InvalidPublisherInputError(`${field} must be one of ${list.join(", ")}`);
  return found;
}
const maybe = <T extends string>(list: readonly T[], v: string | null | undefined, field: string) =>
  v === null || v === undefined ? v : oneOf(list, v, field);

/** Only the keys the caller actually sent: absent = unchanged, null = clear. */
function present<T extends object, K extends keyof T>(input: T, keys: readonly K[]): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {};
  for (const k of keys) if (k in input) out[k] = input[k];
  return out;
}

export function createPublisherResolvers(deps: PublisherDeps): Record<string, unknown> {
  const requireEnabled = makeRequireEnabled(deps.cfg);

  const withCodes =
    <A, R>(fn: (a: A, c: Ctx) => Promise<R>) =>
    async (_p: unknown, a: A, c: Ctx): Promise<R> => {
      try {
        return await fn(a, c);
      } catch (err) {
        throw toLicensingGraphQLError(err);
      }
    };

  /** Read: ownership only. Write: ownership, then the deployment switch. */
  const owned = async (appId: string, ctx: Ctx, write: boolean) => {
    const { appId: id } = await resolveOwnerApp(deps.auth, ctx, appId);
    if (write) requireEnabled();
    return id;
  };

  const ownedApp = async (appId: string, ctx: Ctx, write: boolean) => {
    const id = await owned(appId, ctx, write);
    const app = await deps.apps.app(id);
    if (!app) throw new UnknownAppError("no such app");
    return app;
  };

  const dispatch = async (appId: string, acts: Action[]) => {
    await deps.appGateway.execute(appId, acts);
    return true;
  };

  /** The licence's app is read from the licence: another publisher's licence fails like a missing one. */
  const ownedLicence = async (licenseId: string, ctx: Ctx): Promise<LicenceRecord> => {
    if (!ctx.user?.address) throw new UnauthenticatedError("sign in to manage licences");
    const licence = await deps.licences.licenceRecord(licenseId);
    if (!licence) throw new UnknownLicenseError();
    try {
      await resolveOwnerApp(deps.auth, ctx, licence.app);
    } catch (err) {
      if (err instanceof NotAppOwnerError || err instanceof UnknownAppError) throw new UnknownLicenseError();
      throw err;
    }
    requireEnabled();
    return licence;
  };

  const requireTemplate = async (appId: string, templateId: string, ctx: Ctx) => {
    const app = await ownedApp(appId, ctx, true);
    if (!app.templates.some((t) => t.id === templateId)) throw new UnknownTemplateError();
    return app.id;
  };
  const requireTerm = async (appId: string, termId: string, ctx: Ctx) => {
    const app = await ownedApp(appId, ctx, true);
    if (!app.terms.some((t) => t.id === termId)) throw new UnknownTermError();
    return app.id;
  };

  const licencesOf = async (appId: string) =>
    (await deps.licences.allLicenceRecords()).filter((l) => l.app === appId);

  return {
    Query: { vetraPublisher: () => ({}) },
    Mutation: { vetraPublisher: () => ({}) },

    VetraPublisherQueries: {
      myApps: withCodes(async (_a: unknown, ctx) => {
        const address = ctx.user?.address;
        if (!address) throw new UnauthenticatedError("sign in to manage licences");
        const apps = await deps.auth.listAppsForOwner(address.toLowerCase());
        return apps.map((a) => ({ id: a.id, name: a.name, status: a.status }));
      }),

      templates: withCodes(async (a: { appId: string }, ctx) => {
        const app = await ownedApp(a.appId, ctx, false);
        const envs = await deps.envRows.forApp(app.id);
        return app.templates.map((t) => ({
          id: t.id,
          name: t.name,
          mode: t.mode,
          sharedEnvironment: t.sharedEnvironment,
          size: t.template.size,
          baseDomain: t.template.baseDomain,
          packageRegistry: t.template.packageRegistry,
          services: t.template.services.map((s) => ({
            id: s.id, type: s.type, prefix: s.prefix,
            artifactName: s.artifactName ?? null, artifactChannel: s.artifactChannel ?? null,
          })),
          packages: t.template.packages,
          templateHash: t.templateHash,
          environmentCount: envs.filter((e) => e.template_id === t.id).length,
        }));
      }),

      terms: withCodes(async (a: { appId: string }, ctx) => {
        const app = await ownedApp(a.appId, ctx, false);
        const active = (await licencesOf(app.id)).filter((l) => l.status === "ACTIVE");
        return app.terms.map((t) => ({
          ...t,
          activeLicenses: active.filter((l) => l.kind === t.kind).length,
        }));
      }),

      appArtifacts: withCodes(async (a: { appId: string }, ctx) => (await ownedApp(a.appId, ctx, false)).artifacts),

      licenses: withCodes(async (a: { appId: string; status?: string | null }, ctx) => {
        const appId = await owned(a.appId, ctx, false);
        return (await licencesOf(appId))
          .filter((l) => !a.status || l.status === a.status)
          .map((l) => ({
            id: l.id,
            user: l.user,
            kind: l.kind ?? "",
            issuer: l.issuer ?? "PUBLISHER_GRANT",
            status: l.status,
            start: l.start,
            end: l.end,
            environmentId: l.stage,
            replacedBy: l.replacedBy,
          }));
      }),

      environments: withCodes(async (a: { appId: string }, ctx) => {
        const appId = await owned(a.appId, ctx, false);
        return (await deps.envRows.forApp(appId)).map((e) => ({
          environmentId: e.environment_id,
          user: e.user_did,
          licenseId: e.license_id,
          rootLicenseId: e.root_license_id,
          label: e.label,
          templateHash: e.template_hash,
          stoppedAt: e.stopped_at,
          deleteAfter: e.delete_after,
        }));
      }),

      inviteCodes: withCodes(async (a: { appId: string }, ctx) =>
        listInviteCodes(deps.codes, await owned(a.appId, ctx, false))),

      allowList: withCodes(async (a: { appId: string }, ctx) =>
        deps.grants.allowList(await owned(a.appId, ctx, false))),
    },

    VetraPublisherMutations: {
      addTemplate: withCodes(async (a: In<{ appId: string; name?: string | null; mode: string }>, ctx) => {
        const appId = await owned(a.input.appId, ctx, true);
        const id = deps.newId();
        await dispatch(appId, [appActions.addTemplate({ id, name: a.input.name ?? null, mode: oneOf(MODES, a.input.mode, "mode") })]);
        return id;
      }),

      setTemplateDetails: withCodes(async (a: In<{ appId: string; templateId: string; name?: string | null; mode?: string | null; sharedEnvironment?: string | null; size?: string | null; baseDomain?: string | null; packageRegistry?: string | null }>, ctx) => {
        const appId = await requireTemplate(a.input.appId, a.input.templateId, ctx);
        const fields = present(a.input, ["name", "sharedEnvironment", "size", "baseDomain", "packageRegistry"] as const);
        const mode = maybe(MODES, a.input.mode, "mode");
        return dispatch(appId, [appActions.setTemplateDetails({ id: a.input.templateId, ...fields, ...(mode ? { mode } : {}) })]);
      }),

      addTemplateService: withCodes(async (a: In<{ appId: string; templateId: string; type: string; prefix?: string | null; artifactName?: string | null; artifactChannel?: string | null }>, ctx) => {
        const appId = await requireTemplate(a.input.appId, a.input.templateId, ctx);
        return dispatch(appId, [appActions.addTemplateService({
          templateId: a.input.templateId,
          id: deps.newId(),
          type: oneOf(SERVICE_TYPES, a.input.type, "type"),
          prefix: a.input.prefix ?? null,
          artifactName: a.input.artifactName ?? null,
          artifactChannel: maybe(CHANNELS, a.input.artifactChannel, "artifactChannel") ?? null,
        })]);
      }),

      removeTemplateService: withCodes(async (a: In<{ appId: string; templateId: string; id: string }>, ctx) => {
        const appId = await requireTemplate(a.input.appId, a.input.templateId, ctx);
        return dispatch(appId, [appActions.removeTemplateService({ templateId: a.input.templateId, id: a.input.id })]);
      }),

      addTemplatePackage: withCodes(async (a: In<{ appId: string; templateId: string; packageName: string; version?: string | null }>, ctx) => {
        const appId = await requireTemplate(a.input.appId, a.input.templateId, ctx);
        return dispatch(appId, [appActions.addTemplatePackage({ templateId: a.input.templateId, id: deps.newId(), packageName: a.input.packageName, version: a.input.version ?? null })]);
      }),

      removeTemplatePackage: withCodes(async (a: In<{ appId: string; templateId: string; id: string }>, ctx) => {
        const appId = await requireTemplate(a.input.appId, a.input.templateId, ctx);
        return dispatch(appId, [appActions.removeTemplatePackage({ templateId: a.input.templateId, id: a.input.id })]);
      }),

      deleteTemplate: withCodes(async (a: { appId: string; templateId: string }, ctx) => {
        const appId = await requireTemplate(a.appId, a.templateId, ctx);
        return dispatch(appId, [appActions.deleteTemplate({ id: a.templateId })]);
      }),

      addTerm: withCodes(async (a: In<{ appId: string; kind: string; label?: string | null; templateId?: string | null; validityDays?: number | null; issuers?: string[] | null }>, ctx) => {
        const appId = await owned(a.input.appId, ctx, true);
        const id = deps.newId();
        await dispatch(appId, [appActions.addTerm({
          id,
          kind: a.input.kind,
          label: a.input.label ?? null,
          templateId: a.input.templateId ?? null,
          validityDays: a.input.validityDays ?? null,
          issuers: (a.input.issuers ?? []).map((i) => oneOf(ISSUERS, i, "issuers")),
        })]);
        return id;
      }),

      setTermDetails: withCodes(async (a: In<{ appId: string; termId: string; kind?: string | null; label?: string | null; templateId?: string | null; validityDays?: number | null; issuers?: string[] | null }>, ctx) => {
        const appId = await requireTerm(a.input.appId, a.input.termId, ctx);
        const fields = present(a.input, ["kind", "label", "templateId", "validityDays"] as const);
        const issuers = a.input.issuers?.map((i) => oneOf(ISSUERS, i, "issuers"));
        return dispatch(appId, [appActions.setTermDetails({ id: a.input.termId, ...fields, ...(issuers ? { issuers } : {}) })]);
      }),

      publishTerm: withCodes(async (a: { appId: string; termId: string }, ctx) =>
        dispatch(await requireTerm(a.appId, a.termId, ctx), [appActions.publishTerm({ id: a.termId })])),

      retireTerm: withCodes(async (a: { appId: string; termId: string }, ctx) =>
        dispatch(await requireTerm(a.appId, a.termId, ctx), [appActions.retireTerm({ id: a.termId })])),

      issueGrant: withCodes(async (a: In<{ appId: string; kind: string; user: string; label?: string | null }>, ctx) => {
        const appId = await owned(a.input.appId, ctx, true);
        return grantLicense(deps.issue, {
          appId, kind: a.input.kind, user: a.input.user,
          issuedBy: ctx.user!.address, label: a.input.label ?? null, now: deps.now(),
        });
      }),

      replaceGrant: withCodes(async (a: In<{ licenseId: string; kind: string }>, ctx) => {
        const licence = await ownedLicence(a.input.licenseId, ctx);
        return replaceGrant(deps.issue, { licenseId: licence.id, kind: a.input.kind, issuedBy: ctx.user!.address, now: deps.now() });
      }),

      revokeLicense: withCodes(async (a: In<{ licenseId: string; reason?: string | null }>, ctx) => {
        const licence = await ownedLicence(a.input.licenseId, ctx);
        await deps.licenseGateway.execute(licence.id, [licenseActions.revokeLicense({ reason: a.input.reason ?? null })]);
        return true;
      }),

      createInviteCode: withCodes(async (a: In<{ appId: string; kind: string; label?: string | null; code?: string | null; expiresAt?: string | null; maxUses?: number | null; anthropicKey?: string | null }>, ctx) => {
        const app = await ownedApp(a.input.appId, ctx, true);
        const term = app.terms.find((t) => t.kind === a.input.kind);
        if (!term || term.status === "RETIRED" || !term.issuers.includes("INVITE_CODE")) {
          throw new TermNotIssuableError(`${a.input.kind} cannot be issued by invite code`);
        }
        let anthropicKeyCiphertext: string | null = null;
        if (a.input.anthropicKey) {
          if (!deps.keyVault) throw new KeyStorageUnavailableError();
          anthropicKeyCiphertext = await deps.keyVault.encrypt(a.input.anthropicKey);
        }
        return createInviteCode(deps.codes, {
          appId: app.id, kind: term.kind, code: a.input.code ?? null, label: a.input.label ?? null,
          expiresAt: a.input.expiresAt ?? null, maxUses: a.input.maxUses ?? null,
          anthropicKeyCiphertext, now: deps.now(),
        });
      }),

      setInviteCodeActive: withCodes(async (a: { appId: string; code: string; active: boolean }, ctx) => {
        const appId = await owned(a.appId, ctx, true);
        if (!(await setInviteCodeActive(deps.codes, appId, a.code, a.active))) throw new UnknownInviteCodeError();
        return true;
      }),

      addToAllowList: withCodes(async (a: { appId: string; user: string }, ctx) => {
        const appId = await owned(a.appId, ctx, true);
        await deps.grants.addToAllowList(appId, normaliseUserDid(a.user), deps.now());
        return true;
      }),

      removeFromAllowList: withCodes(async (a: { appId: string; user: string }, ctx) => {
        const appId = await owned(a.appId, ctx, true);
        return deps.grants.removeFromAllowList(appId, normaliseUserDid(a.user));
      }),
    },
  };
}
```

`createInviteCode` allows a DRAFT term on purpose (codes can be printed before the term is published; redemption still requires ACTIVE). Note in the test: `2026-max` lacks `INVITE_CODE`, hence `TERM_NOT_ISSUABLE`.

Update `publisher-errors.ts` with the new classes and the mapping table; keep the "same name/message for not-yours and missing" comment and extend it to `UnknownTemplateError` / `UnknownTermError` / `UnknownInviteCodeError` (fixed messages `"no such template"`, `"no such term"`, `"no such invite code"`).

- [ ] **Step 5: Wire it in `index.ts`**

```ts
    const appGateway = createReactorDocGateway(this.reactorClient as never, APP_DOC_TYPE, "app");
    const issueDeps: PublisherGrantDeps = {
      apps: appReads,
      licence: (id) => reads.licenceRecord(id),
      createLicenseDocument: gateway.create,
      executeLicence: gateway.execute,
      grants,
      logger: console,
    };
    const publisherResolvers = createPublisherResolvers({
      auth: ownerLookup, apps: appReads, appGateway, licences: reads, licenseGateway: gateway,
      issue: issueDeps, grants, envRows: chainRows, codes: db, keyVault, cfg,
      newId: () => randomUUID(), now: () => new Date().toISOString(),
    }) as Record<string, Record<string, unknown>>;
```

`keyVault = createKeyVault(transit)` where `transit` is built when `OPENBAO_ADDR` is set (same construction as `vetra-access-codes/index.ts`), else `null` with a `console.warn("[licensing] OPENBAO_ADDR unset — invite-code Claude keys disabled")`. The subgraph must still load without it.

- [ ] **Step 6: Run, check, commit**

Run: `npx vitest run subgraphs/vetra-licensing && npm run tsc && npm run lint:fix` → PASS.

```bash
git add -A subgraphs/vetra-licensing
git commit -m "feat(licensing): publisher API on app terms, templates, codes and allow lists"
```

---

### Task 12: `vetraSubscriptions` — what an owner holds

**Files:**
- Create: `subgraphs/vetra-licensing/subscriptions-schema.ts`, `subgraphs/vetra-licensing/subscriptions-resolvers.ts`, `subgraphs/vetra-licensing/studio-access.ts`
- Modify: `subgraphs/vetra-licensing/schema.ts` (append the subscriptions document), `subgraphs/vetra-licensing/index.ts`
- Test: `__tests__/subscriptions-api.test.ts`, `__tests__/studio-access.test.ts`, `__tests__/schema-composition.test.ts`

**Interfaces:**
- Consumes: `redeemInviteCode`, `InviteCodeIssuerDeps` (Task 7); `subscriptionWarnings` (Task 10); `envUrls` (`subgraphs/vetra-apps/envs.ts`); `ChainEnvRows`; `GrantStore.licenceIdsFor`; `LicenseReads.licenceRecords`; `KeyVault`, `keyCiphertextForCode`, `getCode`, `isUsable`; `SecretsService` (`subgraphs/vetra-cloud-secrets/services/secrets-service.ts`).
- Produces:
  - `studio-access.ts`: `interface StudioAccessDeps { studioApp(): Promise<AppDocView | null>; licencesOf(appId: string, userDid: string): Promise<LicenceRecord[]>; keyCiphertextForCode(code: string): Promise<string | null>; keyVault: KeyVault | null; now(): string }`; `codeOfLicence(l: LicenceRecord): string | null`; `studioAccess(deps, did): Promise<{ allowed: boolean; licenseId: string | null; expires: string | null; hasAttachedKey: boolean }>`; `studioKeyForDid(deps, did): Promise<string | null>`.
  - `subscriptions-resolvers.ts`: `interface SubscriptionDeps { issuer: InviteCodeIssuerDeps; apps: AppReads; licences: Pick<LicenseReads, "licenceRecords" | "licenceRecord">; grants: GrantStore; envRows: ChainEnvRows; envState(id: string): Promise<VetraCloudEnvironmentState | null>; licenseGateway: LicenseGateway; studio: StudioAccessDeps; secrets: Pick<SecretsService, "setSecret"> | null; now(): string }`; `createSubscriptionResolvers(deps): Record<string, unknown>`; `subscriptionFor(deps, licence: LicenceRecord): Promise<Subscription>`.

- [ ] **Step 1: Schema (contract verbatim)**

`subgraphs/vetra-licensing/subscriptions-schema.ts`:

```ts
import { gql } from "graphql-tag";
import type { DocumentNode } from "graphql";

/** The owner surface: any Renown DID, acting on its own licences only. */
export const subscriptionsSchema: DocumentNode = gql`
  type InviteCodeCheck {
    valid: Boolean!
    "Null when invalid."
    appId: String
    appName: String
    kind: String
    termLabel: String
    "DEDICATED | SHARED; the redeem page asks for a project name only for DEDICATED."
    mode: String
  }

  type Subscription {
    licenseId: String!
    appId: String!
    appName: String!
    kind: String!
    termLabel: String
    issuer: String!
    status: String!
    start: String
    end: String
    mode: String!
    environmentId: String
    environmentLabel: String
    "Where 'Open' goes: the environment's primary URL (DEDICATED) or the app URL (SHARED)."
    openUrl: String
    stoppedAt: String
    deleteAfter: String
    "Offboarding/expiry banners, newest relevant first."
    warnings: [SubscriptionWarning!]!
  }

  type SubscriptionWarning {
    kind: String!
    at: String!
    message: String!
  }

  type StudioAccess {
    allowed: Boolean!
    licenseId: String
    expires: String
    hasAttachedKey: Boolean!
  }

  input RedeemInviteCodeInput {
    code: String!
    "Project name for a DEDICATED environment; ignored for SHARED."
    label: String
    "Replace this licence (same app) instead of starting a new environment."
    upgrades: String
  }

  type VetraSubscriptionsQueries {
    "Public, unauthenticated; rate-limited by ingress."
    inviteCode(code: String!): InviteCodeCheck!
    mySubscriptions: [Subscription!]!
    studioAccess: StudioAccess!
  }

  type VetraSubscriptionsMutations {
    redeemInviteCode(input: RedeemInviteCodeInput!): Subscription!
    cancelSubscription(licenseId: String!): Boolean!
    "Writes the caller's studio-licence Claude key into a tenant's secrets (was VetraAccessCodes.applyInviteCodeSecret)."
    applyStudioKey(tenantId: String!, secretNames: [String!]!): Boolean!
  }

  extend type Query { vetraSubscriptions: VetraSubscriptionsQueries! }
  extend type Mutation { vetraSubscriptions: VetraSubscriptionsMutations! }
`;
```

Append `...subscriptionsSchema.definitions` to `schema` in `schema.ts`.

- [ ] **Step 2: Failing tests**

`subgraphs/vetra-licensing/__tests__/studio-access.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { codeOfLicence, studioAccess, studioKeyForDid, type StudioAccessDeps } from "../studio-access.js";
import type { LicenceRecord } from "../reads.js";

const DID = "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";
const L = (id: string, over: Partial<LicenceRecord>): LicenceRecord => ({
  id, app: "studio", user: DID, kind: "studio-early-access-30d", issuer: "INVITE_CODE", status: "ACTIVE",
  issued: "2026-10-01T00:00:00.000Z", start: null, end: "2026-10-31T00:00:00.000Z", stage: null,
  details: '{"code":"with-key"}', replacedBy: null, legacyLicenseTypeId: null, ...over,
});
const deps = (licences: LicenceRecord[], over: Partial<StudioAccessDeps> = {}): StudioAccessDeps => ({
  studioApp: async () => ({ id: "studio" } as never),
  licencesOf: async () => licences,
  keyCiphertextForCode: async (c) => (c === "with-key" ? "enc:sk-ant" : null),
  keyVault: { encrypt: async (p) => `enc:${p}`, decrypt: async (c) => c.slice(4) },
  now: () => "2026-10-08T00:00:00.000Z",
  ...over,
});

describe("studio access", () => {
  it("reads the code from details, tolerating junk", () => {
    expect(codeOfLicence(L("a", {}))).toBe("with-key");
    expect(codeOfLicence(L("a", { details: "nope" }))).toBeNull();
    expect(codeOfLicence(L("a", { details: null }))).toBeNull();
  });
  it("allows an ACTIVE studio licence and resolves its key", async () => {
    expect(await studioAccess(deps([L("a", {})]), DID)).toStrictEqual({ allowed: true, licenseId: "a", expires: "2026-10-31T00:00:00.000Z", hasAttachedKey: true });
    expect(await studioKeyForDid(deps([L("a", {})]), DID)).toBe("sk-ant");
  });
  it("prefers the licence that carries a key", async () => {
    const d = deps([L("b", { details: '{"code":"no-key"}', end: "2026-12-01T00:00:00.000Z" }), L("a", {})]);
    expect(await studioKeyForDid(d, DID)).toBe("sk-ant");
    expect((await studioAccess(d, DID)).licenseId).toBe("b");
  });
  it("denies without an ACTIVE licence, without the studio app, or without a vault for the key", async () => {
    expect((await studioAccess(deps([L("a", { status: "EXPIRED" })]), DID)).allowed).toBe(false);
    expect((await studioAccess(deps([L("a", {})], { studioApp: async () => null }), DID)).allowed).toBe(false);
    expect(await studioKeyForDid(deps([L("a", {})], { keyVault: null }), DID)).toBeNull();
  });
});
```

`subgraphs/vetra-licensing/__tests__/subscriptions-api.test.ts` — real reactor + PGlite like `publisher-api.test.ts`. Seed: app `APP_DED` (KV, DEDICATED term `pro` with INVITE_CODE issuer, `productionEnvironmentId` null), app `APP_SH` (SHARED term `free`, `productionEnvironmentId: "env-app"`), codes `kv-1` (`pro`, maxUses 5) and `sh-1` (`free`); env state lookup stubbed with `envState: async (id) => id === "env-app" ? APP_ENV_STATE : null`, where `APP_ENV_STATE` is a `VetraCloudEnvironmentState` with `genericSubdomain: "pfnuer"`, `genericBaseDomain: "vetra.io"`, and an enabled FUSION service with prefix `app`. Tests:

```ts
const asUser = { user: { address: HOLDER, networkId: "eip155", chainId: 137 } };
const anon = {};

describe("vetraSubscriptions", () => {
  it("checks a code publicly without consuming it, and gives no state away when invalid", async () => {
    expect(await q("inviteCode", { code: "KV-1" }, anon)).toStrictEqual({ valid: true, appId: APP_DED, appName: "KV", kind: "pro", termLabel: "Pro", mode: "DEDICATED" });
    expect(await q("inviteCode", { code: "nope" }, anon)).toStrictEqual({ valid: false, appId: null, appName: null, kind: null, termLabel: null, mode: null });
    expect((await q("inviteCode", { code: "kv-1" }, anon) as { valid: boolean }).valid).toBe(true);
  });

  it("requires a login for everything else", async () => {
    expect(await code(q("mySubscriptions", {}, anon))).toBe("UNAUTHENTICATED");
    expect(await code(m("redeemInviteCode", { input: { code: "kv-1" } }, anon))).toBe("UNAUTHENTICATED");
  });

  it("redeems a DEDICATED code into a subscription named after the project, idempotently", async () => {
    const sub = (await m("redeemInviteCode", { input: { code: "kv-1", label: "Thesis" } }, asUser)) as Record<string, unknown>;
    expect(sub).toMatchObject({ appId: APP_DED, appName: "KV", kind: "pro", issuer: "INVITE_CODE", status: "ACTIVE", mode: "DEDICATED", environmentId: null, warnings: [] });
    const again = (await m("redeemInviteCode", { input: { code: "kv-1" } }, asUser)) as Record<string, unknown>;
    expect(again.licenseId).toBe(sub.licenseId);
  });

  it("redeems a SHARED code: Open goes to the app, a second one is ALREADY_HOLDS", async () => {
    const sub = (await m("redeemInviteCode", { input: { code: "sh-1" } }, asUser)) as Record<string, unknown>;
    expect(sub).toMatchObject({ mode: "SHARED", openUrl: "https://app.pfnuer.vetra.io" });
    await createInviteCode(db, { appId: APP_SH, kind: "free", code: "sh-2", label: null, expiresAt: null, maxUses: null, anthropicKeyCiphertext: null, now: NOW });
    expect(await code(m("redeemInviteCode", { input: { code: "sh-2" } }, asUser))).toBe("ALREADY_HOLDS");
  });

  it("INVALID_CODE for unknown, inactive or exhausted codes; UNSUPPORTED_DID never applies to wallet callers", async () => {
    expect(await code(m("redeemInviteCode", { input: { code: "nope" } }, asUser))).toBe("INVALID_CODE");
  });

  it("lists only the caller's subscriptions, then cancels one into offboarding", async () => {
    const subs = (await q("mySubscriptions", {}, asUser)) as { licenseId: string; kind: string }[];
    expect(subs.map((s) => s.kind).sort()).toStrictEqual(["free", "pro"]);
    expect(await q("mySubscriptions", {}, { user: { address: OTHER, networkId: "eip155", chainId: 1 } })).toStrictEqual([]);
    const pro = subs.find((s) => s.kind === "pro")!;
    expect(await code(m("cancelSubscription", { licenseId: pro.licenseId }, { user: { address: OTHER, networkId: "eip155", chainId: 1 } }))).toBe("NOT_FOUND");
    expect(await m("cancelSubscription", { licenseId: pro.licenseId }, asUser)).toBe(true);
    expect((await reads.licenceRecord(pro.licenseId))).toMatchObject({ status: "REVOKED" });
  });

  it("upgrades through a code: same chain, predecessor replaced", async () => {
    // seed term "max" (DEDICATED, INVITE_CODE) on APP_DED and code "kv-max"
    const before = (await m("redeemInviteCode", { input: { code: "kv-1b", label: "Second" } }, asUser)) as { licenseId: string };
    const up = (await m("redeemInviteCode", { input: { code: "kv-max", upgrades: before.licenseId } }, asUser)) as { licenseId: string };
    expect((await reads.licenceRecord(before.licenseId))).toMatchObject({ status: "REPLACED", replacedBy: up.licenseId });
    expect(await grants.chainRootOf(up.licenseId)).toBe(before.licenseId);
  });

  it("reports studio access and applies the studio key to a tenant", async () => {
    // studio app (slug vetra-studio, SHARED term studio-early-access-30d, INVITE_CODE)
    // and code "studio-1" carrying anthropic_key_ciphertext "enc:sk-ant-1"
    expect(await q("studioAccess", {}, asUser)).toStrictEqual({ allowed: false, licenseId: null, expires: null, hasAttachedKey: false });
    await m("redeemInviteCode", { input: { code: "studio-1" } }, asUser);
    expect(await q("studioAccess", {}, asUser)).toMatchObject({ allowed: true, hasAttachedKey: true });
    expect(await m("applyStudioKey", { tenantId: "t-1", secretNames: ["ANTHROPIC_API_KEY"] }, asUser)).toBe(true);
    expect(setSecret).toHaveBeenCalledWith("t-1", "ANTHROPIC_API_KEY", "sk-ant-1");
    expect(setSecret).toHaveBeenCalledWith("t-1", "VETRA_SESSION_EXPORT_SECRET", expect.stringMatching(/^[0-9a-f]{64}$/));
    expect(await m("applyStudioKey", { tenantId: "t-1", secretNames: ["X"] }, { user: { address: OTHER, networkId: "eip155", chainId: 1 } })).toBe(false);
  });
});
```

Seed every code/term the comments mention in `beforeAll` (no comment left without the code behind it). `setSecret` is a `vi.fn(async () => {})` passed as `secrets`.

- [ ] **Step 3: Run to see them fail**

Run: `npx vitest run subgraphs/vetra-licensing/__tests__/studio-access.test.ts subgraphs/vetra-licensing/__tests__/subscriptions-api.test.ts` → FAIL.

- [ ] **Step 4: Implement `studio-access.ts`**

```ts
import type { AppDocView } from "./app-reads.js";
import type { KeyVault } from "./key-vault.js";
import type { LicenceRecord } from "./reads.js";

export interface StudioAccessDeps {
  studioApp(): Promise<AppDocView | null>;
  /** ACTIVE-or-not licences of one app held by the DID, provenance-checked. */
  licencesOf(appId: string, userDid: string): Promise<LicenceRecord[]>;
  keyCiphertextForCode(code: string): Promise<string | null>;
  keyVault: KeyVault | null;
  now(): string;
}

export function codeOfLicence(l: LicenceRecord): string | null {
  if (!l.details) return null;
  try {
    const d: unknown = JSON.parse(l.details);
    const code = typeof d === "object" && d !== null ? (d as Record<string, unknown>).code : null;
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}

async function activeStudioLicences(deps: StudioAccessDeps, did: string): Promise<LicenceRecord[]> {
  const app = await deps.studioApp();
  if (!app) return [];
  return (await deps.licencesOf(app.id, did))
    .filter((l) => l.status === "ACTIVE")
    .sort((a, b) => (b.end ?? "9999").localeCompare(a.end ?? "9999"));
}

/** The vetra-studio licence gate (replaces getAccessStatus). */
export async function studioAccess(deps: StudioAccessDeps, did: string) {
  const active = await activeStudioLicences(deps, did);
  const best = active[0];
  if (!best) return { allowed: false, licenseId: null, expires: null, hasAttachedKey: false };
  return { allowed: true, licenseId: best.id, expires: best.end, hasAttachedKey: (await keyLicence(deps, active)) !== null };
}

async function keyLicence(deps: StudioAccessDeps, active: LicenceRecord[]): Promise<string | null> {
  for (const l of active) {
    const code = codeOfLicence(l);
    const ct = code ? await deps.keyCiphertextForCode(code) : null;
    if (ct) return ct;
  }
  return null;
}

/** The Claude key behind the caller's studio licence (replaces getRedeemedKeyCiphertext + decrypt). */
export async function studioKeyForDid(deps: StudioAccessDeps, did: string): Promise<string | null> {
  if (!deps.keyVault) return null;
  const ct = await keyLicence(deps, await activeStudioLicences(deps, did));
  return ct === null ? null : deps.keyVault.decrypt(ct);
}
```

- [ ] **Step 5: Implement `subscriptions-resolvers.ts`**

```ts
import { randomBytes } from "node:crypto";
import type { VetraCloudEnvironmentState } from "document-models/vetra-cloud-environment";
import { actions as licenseActions } from "document-models/app-owner-license";
import { envUrls } from "../vetra-apps/envs.js";
import { UnauthenticatedError } from "./auth.js";
import { resolveKind, type AppReads } from "./app-reads.js";
import { callerDid } from "./did.js";
import type { ChainEnvRows } from "./environments.js";
import type { GrantStore } from "./grants.js";
import { getCode, isUsable } from "./invite-codes.js";
import { redeemInviteCode, type InviteCodeIssuerDeps } from "./issuers/invite-code.js";
import type { LicenseGateway } from "./license-gateway.js";
import { subscriptionWarnings, type SubscriptionWarning } from "./offboarding.js";
import { UnknownLicenseError, toLicensingGraphQLError } from "./publisher-errors.js";
import type { LicenseReads, LicenceRecord } from "./reads.js";
import { studioAccess, studioKeyForDid, type StudioAccessDeps } from "./studio-access.js";
import type { SecretsService } from "../vetra-cloud-secrets/services/secrets-service.js";

export interface SubscriptionDeps {
  issuer: InviteCodeIssuerDeps;
  apps: AppReads;
  licences: Pick<LicenseReads, "licenceRecords" | "licenceRecord">;
  grants: GrantStore;
  envRows: ChainEnvRows;
  envState(id: string): Promise<VetraCloudEnvironmentState | null>;
  licenseGateway: LicenseGateway;
  studio: StudioAccessDeps;
  secrets: Pick<SecretsService, "setSecret"> | null;
  now(): string;
}

export interface Subscription {
  licenseId: string; appId: string; appName: string; kind: string; termLabel: string | null;
  issuer: string; status: string; start: string | null; end: string | null; mode: string;
  environmentId: string | null; environmentLabel: string | null; openUrl: string | null;
  stoppedAt: string | null; deleteAfter: string | null; warnings: SubscriptionWarning[];
}

type Ctx = { user?: { address?: string } };

const primaryUrl = (s: VetraCloudEnvironmentState | null) => {
  const u = envUrls(s);
  return u.app ?? u.connect ?? u.switchboard;
};

export async function subscriptionFor(deps: SubscriptionDeps, l: LicenceRecord): Promise<Subscription> {
  const app = await deps.apps.app(l.app);
  const resolved = app ? resolveKind(app, l.kind) : null;
  const mode = resolved?.ok ? resolved.template.mode : "DEDICATED";
  const term = app?.terms.find((t) => t.kind === l.kind) ?? null;
  const root = await deps.grants.chainRootOf(l.id);
  const env = mode === "DEDICATED" ? await deps.envRows.byRoot(root) : null;
  const environmentId = env?.environment_id ?? l.stage;
  return {
    licenseId: l.id,
    appId: l.app,
    appName: app?.name ?? app?.slug ?? l.app,
    kind: l.kind ?? "",
    termLabel: term?.label ?? null,
    issuer: l.issuer ?? "PUBLISHER_GRANT",
    status: l.status,
    start: l.start,
    end: l.end,
    mode,
    environmentId,
    environmentLabel: env?.label ?? null,
    openUrl: environmentId ? primaryUrl(await deps.envState(environmentId)) : null,
    stoppedAt: env?.stopped_at ?? null,
    deleteAfter: env?.delete_after ?? null,
    warnings: subscriptionWarnings({
      status: l.status, end: l.end, mode,
      endedAt: env?.ended_at ?? null, stoppedAt: env?.stopped_at ?? null, deleteAfter: env?.delete_after ?? null,
    }, deps.now()),
  };
}

export function createSubscriptionResolvers(deps: SubscriptionDeps): Record<string, unknown> {
  const did = (ctx: Ctx) => {
    const d = callerDid(ctx);
    if (!d) throw new UnauthenticatedError("sign in with Renown");
    return d;
  };
  const withCodes =
    <A, R>(fn: (a: A, c: Ctx) => Promise<R>) =>
    async (_p: unknown, a: A, c: Ctx): Promise<R> => {
      try {
        return await fn(a, c);
      } catch (err) {
        throw toLicensingGraphQLError(err);
      }
    };
  const mine = async (userDid: string) => {
    const ids = await deps.grants.licenceIdsFor(null, userDid);
    return deps.licences.licenceRecords(ids);
  };

  return {
    Query: { vetraSubscriptions: () => ({}) },
    Mutation: { vetraSubscriptions: () => ({}) },

    VetraSubscriptionsQueries: {
      inviteCode: withCodes(async (a: { code: string }) => {
        const invalid = { valid: false, appId: null, appName: null, kind: null, termLabel: null, mode: null };
        const row = await getCode(deps.issuer.db, a.code);
        if (!row || !(await isUsable(deps.issuer.db, row, deps.now()))) return invalid;
        const app = await deps.apps.app(row.app_id);
        const resolved = app ? resolveKind(app, row.kind) : null;
        if (!app || !resolved?.ok) return invalid;
        return { valid: true, appId: app.id, appName: app.name ?? app.slug ?? app.id, kind: row.kind, termLabel: resolved.term.label, mode: resolved.template.mode };
      }),

      mySubscriptions: withCodes(async (_a: unknown, ctx) => {
        const out: Subscription[] = [];
        for (const l of await mine(did(ctx))) {
          // A replaced licence lives on as its successor; listing both doubles the row.
          if (l.status !== "REPLACED") out.push(await subscriptionFor(deps, l));
        }
        return out;
      }),

      studioAccess: withCodes(async (_a: unknown, ctx) => studioAccess(deps.studio, did(ctx))),
    },

    VetraSubscriptionsMutations: {
      redeemInviteCode: withCodes(async (a: { input: { code: string; label?: string | null; upgrades?: string | null } }, ctx) => {
        const { licenseId } = await redeemInviteCode(deps.issuer, {
          code: a.input.code, user: did(ctx), label: a.input.label ?? null,
          upgrades: a.input.upgrades ?? null, now: deps.now(),
        });
        const licence = await deps.licences.licenceRecord(licenseId);
        if (!licence) throw new UnknownLicenseError();
        return subscriptionFor(deps, licence);
      }),

      cancelSubscription: withCodes(async (a: { licenseId: string }, ctx) => {
        const caller = did(ctx);
        const ids = await deps.grants.licenceIdsFor(null, caller);
        if (!ids.includes(a.licenseId)) throw new UnknownLicenseError();
        await deps.licenseGateway.execute(a.licenseId, [licenseActions.revokeLicense({ reason: "cancelled by owner" })]);
        return true;
      }),

      applyStudioKey: withCodes(async (a: { tenantId: string; secretNames: string[] }, ctx) => {
        const key = await studioKeyForDid(deps.studio, did(ctx));
        if (key === null || !deps.secrets) return false;
        for (const name of a.secretNames) await deps.secrets.setSecret(a.tenantId, name, key);
        // Per-env random secret gating vetra-cli's session-export endpoints (unchanged behaviour).
        await deps.secrets.setSecret(a.tenantId, "VETRA_SESSION_EXPORT_SECRET", randomBytes(32).toString("hex"));
        return true;
      }),
    },
  };
}
```

`applyStudioKey` keeps the old `applyInviteCodeSecret` authorisation exactly (any caller holding a key may write it into any `tenantId`) — see the risk note at the end of this plan; do not tighten it here without the vetra.io cold path being checked.

- [ ] **Step 6: Wire in `index.ts`**

```ts
    const activeLicencesOf = async (appId: string, userDid: string) =>
      (await reads.licenceRecords(await grants.licenceIdsFor(appId, userDid))).filter((l) => l.status === "ACTIVE");
    const studio: StudioAccessDeps = {
      studioApp: () => appReads.appBySlug(cfg.studioAppSlug),
      licencesOf: async (appId, userDid) => reads.licenceRecords(await grants.licenceIdsFor(appId, userDid)),
      keyCiphertextForCode: (c) => keyCiphertextForCode(db, c),
      keyVault,
      now: () => new Date().toISOString(),
    };
    const subscriptionResolvers = createSubscriptionResolvers({
      issuer: { ...issueDeps, db, activeLicencesOf },
      apps: appReads, licences: reads, grants, envRows: chainRows,
      envState: (id) => envs.getState(id), licenseGateway: gateway, studio,
      secrets: secretsService, now: () => new Date().toISOString(),
    }) as Record<string, Record<string, unknown>>;
    this.resolvers = mergeResolvers(mergeResolvers(machineResolvers, publisherResolvers), subscriptionResolvers);
```

`secretsService` is `createSecretsService({ db: secretsDb, transit })` over the `vetra-cloud-secrets` namespace when `transit` exists, else `null`.

- [ ] **Step 7: Run, check, commit**

Run: `npx vitest run subgraphs/vetra-licensing && npm run tsc && npm run lint:fix` → PASS.

```bash
git add subgraphs/vetra-licensing
git commit -m "feat(licensing): owner subscriptions, invite redemption and studio access"
```

---

### Task 13: `vetraLicensing` machine surface on kinds

**Files:**
- Modify: `subgraphs/vetra-licensing/schema.ts` (machine part), `subgraphs/vetra-licensing/resolvers.ts`, `subgraphs/vetra-licensing/reference-handler/handler.ts`, `subgraphs/vetra-licensing/index.ts`
- Test: `__tests__/resolvers.test.ts` (rewritten), `__tests__/reference-handler.test.ts` (rewritten), `__tests__/schema-composition.test.ts`

**Interfaces:**
- Consumes: `resolveCallerApp` (`auth.ts`), Tasks 5, 6, 9, 10.
- Produces: `interface ResolverDeps { auth: AuthDeps; apps: AppReads; licences: Pick<LicenseReads, "allLicenceRecords" | "licenceRecord">; grants: GrantStore; envRows: ChainEnvRows; provision(input: ProvisionChainInput): Promise<LicenseEnvironments>; offboarding: OffboardingDeps; issue: PublisherGrantDeps; cfg: LicensingConfig; now(): string; relay: (token: string | null, input: { user: string; metric: string; value: number }) => Promise<boolean> }`; `createResolvers(deps: ResolverDeps)`. (`relay` is a stub returning `false` until Task 14.)

- [ ] **Step 1: Schema**

Replace the machine `gql` in `schema.ts` with:

```graphql
  type AppUserEnvironment {
    appId: String!
    user: String!
    environmentId: String!
    licenseId: String!
    rootLicenseId: String!
    label: String
    templateHash: String!
    stoppedAt: String
    deleteAfter: String
  }
  input ApplyEnvironmentTemplateInput { licenseId: String! label: String! }
  input ReleaseEnvironmentInput { environmentId: String! }
  input IssuePublisherGrantInput { kind: String! user: String! }

  type AppLicense { id: String! user: String! kind: String! status: String! start: String end: String environmentId: String }
  type AppTermSummary { id: String! kind: String! status: String! templateHash: String }

  type VetraLicensingQueries {
    appLicenses(status: String): [AppLicense!]!
    appTerms: [AppTermSummary!]!
    appUserEnvironments: [AppUserEnvironment!]!
    "SHARED apps: does this DID hold an ACTIVE licence for the calling app?"
    hasLicense(user: String!): Boolean!
  }
  type VetraLicensingMutations {
    applyEnvironmentTemplate(input: ApplyEnvironmentTemplateInput!): AppUserEnvironment!
    releaseEnvironment(input: ReleaseEnvironmentInput!): Boolean!
    issuePublisherGrant(input: IssuePublisherGrantInput!): String!
    "Caller = environment reporting token. Forwards to Renown signed as the app."
    reportUserStat(user: String!, metric: String!, value: Float!): Boolean!
  }
  type Query { vetraLicensing: VetraLicensingQueries! }
  type Mutation { vetraLicensing: VetraLicensingMutations! }
```

(`appLicenseTypes` / `AppLicenseTypeSummary` are gone, per the contract.)

- [ ] **Step 2: Failing tests**

Rewrite `__tests__/resolvers.test.ts` with fakes (`appKey` context → `findAppByIdentityDid` returns `{ id: "app-1", status: "ACTIVE" }`):

```ts
describe("vetraLicensing (machine)", () => {
  it("derives the app from the caller, never from arguments", async () => {
    expect(await code(q("appLicenses", {}, { user: { address: "0x1", networkId: "eip155", chainId: 1 } }))).toBe("UNAUTHENTICATED");
  });
  it("lists the app's licences on kinds with their environment", async () => {
    expect(await q("appLicenses", { status: "ACTIVE" }, asApp)).toStrictEqual([
      { id: "l1", user: DID, kind: "pro", status: "ACTIVE", start: null, end: null, environmentId: "env-1" },
    ]);
  });
  it("summarises terms with their template hash (null for a term without template)", async () => {
    expect(await q("appTerms", {}, asApp)).toStrictEqual([
      { id: "k1", kind: "pro", status: "ACTIVE", templateHash: "h-ded" },
      { id: "k2", kind: "draft", status: "DRAFT", templateHash: null },
    ]);
  });
  it("answers hasLicense only for authorised ACTIVE licences of the calling app", async () => {
    expect(await q("hasLicense", { user: ADDR }, asApp)).toBe(true);
    expect(await q("hasLicense", { user: OTHER_DID }, asApp)).toBe(false);   // holds app-2's licence only
    expect(await q("hasLicense", { user: FORGED_DID }, asApp)).toBe(false);  // ACTIVE doc, no grant row
    expect(await code(q("hasLicense", { user: "did:key:z" }, asApp))).toBe("UNSUPPORTED_DID");
  });
  it("lists environments with chain fields", async () => {
    expect(await q("appUserEnvironments", {}, asApp)).toStrictEqual([
      { appId: "app-1", user: DID, environmentId: "env-1", licenseId: "l1", rootLicenseId: "l1", label: "Vault", templateHash: "h-ded", stoppedAt: null, deleteAfter: null },
    ]);
  });
  it("applyEnvironmentTemplate provisions the licence's chain; refuses a SHARED or foreign licence", async () => {
    expect(await m("applyEnvironmentTemplate", { input: { licenseId: "l1", label: "x" } }, asApp)).toMatchObject({ environmentId: "env-1" });
    expect(await code(m("applyEnvironmentTemplate", { input: { licenseId: "l-shared", label: "x" } }, asApp))).toBe("INVALID_INPUT");
    expect(await code(m("applyEnvironmentTemplate", { input: { licenseId: "l-app2", label: "x" } }, asApp))).toBe("NOT_FOUND");
  });
  it("releaseEnvironment starts the offboarding clock instead of stopping at once", async () => {
    expect(await m("releaseEnvironment", { input: { environmentId: "env-1" } }, asApp)).toBe(true);
    expect(markEndedCalls).toStrictEqual(["env-1"]);
    expect(await m("releaseEnvironment", { input: { environmentId: "env-app2" } }, asApp)).toBe(false);
  });
  it("issuePublisherGrant issues a kind for the calling app", async () => {
    expect(await m("issuePublisherGrant", { input: { kind: "pro", user: ADDR } }, asApp)).toBe("lic-new");
  });
  it("mutations refuse when licensing is disabled", async () => {
    expect(await code(disabledM("issuePublisherGrant", { input: { kind: "pro", user: ADDR } }, asApp))).toBe("LICENSING_DISABLED");
  });
});
```

(Build the fakes with the exact ids used above: licences `l1` (app-1, ACTIVE, pro, stage env-1, authorised), `l-shared` (app-1, ACTIVE, kind `free` on a SHARED template), `l-app2` (app-2), `l-forged` (app-1, ACTIVE, `FORGED_DID`, **not** in `authorisedIds`), `l-other` (app-2, `OTHER_DID`); env rows `env-1` (app-1) and `env-app2` (app-2).)

Rewrite `reference-handler.test.ts` for the new client: given licences `[{ id, kind, status: "ACTIVE" }]`, terms with hashes and environments with `licenseId` + `templateHash`, the handler calls `applyEnvironmentTemplate` for licences whose term has a hash and whose environment row is missing or stale, logs and skips licences whose kind has no term, **never calls `releaseEnvironment`** (Vetra's clock owns offboarding now), and only logs in dry run.

- [ ] **Step 3: Implement**

`resolvers.ts` (replace `createResolvers`; keep `LicensingDisabledError` and `makeRequireEnabled`):

```ts
export function createResolvers(deps: ResolverDeps): Record<string, unknown> {
  const requireEnabled = makeRequireEnabled(deps.cfg);
  const withCodes =
    <A, R>(fn: (a: A, c: AuthContext & { headers?: Record<string, string | string[] | undefined> }) => Promise<R>) =>
    async (_p: unknown, a: A, c: AuthContext & { headers?: Record<string, string | string[] | undefined> }): Promise<R> => {
      try { return await fn(a, c); } catch (err) { throw toLicensingGraphQLError(err); }
    };
  const appLicences = async (appId: string) => (await deps.licences.allLicenceRecords()).filter((l) => l.app === appId);
  const toEnv = (e: LicenseEnvironments) => ({
    appId: e.app_id, user: e.user_did, environmentId: e.environment_id, licenseId: e.license_id,
    rootLicenseId: e.root_license_id, label: e.label, templateHash: e.template_hash,
    stoppedAt: e.stopped_at, deleteAfter: e.delete_after,
  });

  return {
    Query: { vetraLicensing: () => ({}) },
    Mutation: { vetraLicensing: () => ({}) },
    VetraLicensingQueries: {
      appLicenses: withCodes(async (a: { status?: string | null }, ctx) => {
        const { appId } = await resolveCallerApp(deps.auth, ctx);
        return (await appLicences(appId))
          .filter((l) => !a.status || l.status === a.status)
          .map((l) => ({ id: l.id, user: l.user, kind: l.kind ?? "", status: l.status, start: l.start, end: l.end, environmentId: l.stage }));
      }),
      appTerms: withCodes(async (_a: unknown, ctx) => {
        const { appId } = await resolveCallerApp(deps.auth, ctx);
        const app = await deps.apps.app(appId);
        return (app?.terms ?? []).map((t) => ({
          id: t.id, kind: t.kind, status: t.status,
          templateHash: app!.templates.find((x) => x.id === t.templateId)?.templateHash ?? null,
        }));
      }),
      appUserEnvironments: withCodes(async (_a: unknown, ctx) => {
        const { appId } = await resolveCallerApp(deps.auth, ctx);
        return (await deps.envRows.forApp(appId)).map(toEnv);
      }),
      hasLicense: withCodes(async (a: { user: string }, ctx) => {
        const { appId } = await resolveCallerApp(deps.auth, ctx);
        const user = normaliseUserDid(a.user);
        const ids = await deps.grants.licenceIdsFor(appId, user);
        for (const id of ids) {
          const l = await deps.licences.licenceRecord(id);
          if (l && l.app === appId && l.status === "ACTIVE" && sameHolder(l.user, user)) return true;
        }
        return false;
      }),
    },
    VetraLicensingMutations: {
      issuePublisherGrant: withCodes(async (a: { input: { kind: string; user: string } }, ctx) => {
        const { appId } = await resolveCallerApp(deps.auth, ctx);
        requireEnabled();
        return grantLicense(deps.issue, { appId, kind: a.input.kind, user: a.input.user, issuedBy: ctx.user?.appKey ?? "app", label: null, now: deps.now() });
      }),
      applyEnvironmentTemplate: withCodes(async (a: { input: { licenseId: string; label: string } }, ctx) => {
        const { appId } = await resolveCallerApp(deps.auth, ctx);
        requireEnabled();
        const licence = await deps.licences.licenceRecord(a.input.licenseId);
        if (!licence || licence.app !== appId || licence.status !== "ACTIVE") throw new UnknownLicenseError();
        const app = await deps.apps.app(appId);
        const r = app ? resolveKind(app, licence.kind) : null;
        if (!r?.ok) throw new InvalidPublisherInputError(r ? r.reason : `app ${appId} has no document`);
        if (r.template.mode !== "DEDICATED") throw new InvalidPublisherInputError("a SHARED licence has no environment of its own");
        const row = await deps.provision({
          appId, root: await deps.grants.chainRootOf(licence.id), licenseId: licence.id,
          userDid: normaliseUserDid(licence.user), templateId: r.template.id, template: r.template.template,
          templateHash: r.template.templateHash, label: a.input.label, now: deps.now(),
        });
        return toEnv(row);
      }),
      releaseEnvironment: withCodes(async (a: { input: { environmentId: string } }, ctx) => {
        const { appId } = await resolveCallerApp(deps.auth, ctx);
        requireEnabled();
        const row = await deps.envRows.byEnvironment(a.input.environmentId);
        if (!row || row.app_id !== appId) return false;
        // Release = start the offboarding timeline. Nothing here stops or deletes directly.
        if (!row.ended_at) await markEnded(deps.offboarding, row.environment_id);
        return true;
      }),
      reportUserStat: withCodes(async (a: { user: string; metric: string; value: number }, ctx) => {
        const raw = ctx.headers?.[REPORTING_HEADER];
        return deps.relay(typeof raw === "string" ? raw : null, a);
      }),
    },
  };
}
```

`REPORTING_HEADER = "x-vetra-reporting-token"` is exported from `reporting.ts` (created in Task 14; create the file now with only that constant). `ctx.headers` is the reactor-api `Context.headers` (`IncomingHttpHeaders`).

`reference-handler/handler.ts`: switch its `LicensingClient` to `appLicenses({ status })` returning `{ id, user, kind, status }`, `appTerms()`, `appUserEnvironments()` returning `{ environmentId, licenseId, templateHash }`, and `applyEnvironmentTemplate`; drop `releaseEnvironment` from the interface and from `reconcileOnce` (with a comment: Vetra's offboarding clock ends environments; a publisher handler only applies).

- [ ] **Step 4: Run, check, commit**

Run: `npx vitest run subgraphs/vetra-licensing && npm run tsc && npm run lint:fix` → PASS.

```bash
git add subgraphs/vetra-licensing
git commit -m "feat(licensing): machine API on kinds, chains and hasLicense"
```

---

### Task 14: Reporting tokens and the Renown stats relay

Vetra holds no app keys: an App identity is a Renown **workload identity** (`registerWorkloadIdentity` in `subgraphs/vetra-apps/renown.ts`), whose key lives with Renown; Vetra only holds `RENOWN_WORKLOAD_REGISTRATION_TOKEN`. Per the contract's relay section, Vetra mints a short-lived stats token for the app via `issueAppStatsToken` on `/graphql/renown-workload` (authorised by the registration-token header vetra-apps already sends), caches it per app DID, sends reports with `X-Renown-App-Token`, and coalesces reports per (user, metric). `RENOWN_STATS_URL` unset ⇒ the relay is off and `reportUserStat` returns `false`.

Environments authenticate with a per-environment **reporting token** written into their secrets at provisioning. It travels in the `x-vetra-reporting-token` header, never `Authorization`: reactor-api verifies every `Authorization` bearer as a Renown JWT and answers 401 for anything else. The federated supergraph gateway forwards only `authorization` to subgraphs, so environments must call the subgraph endpoint directly — `VETRA_LICENSING_URL` (e.g. `https://switchboard.vetra.io/graphql/vetra-licensing`), which is written into the environment's env next to the token.

**Files:**
- Create/extend: `subgraphs/vetra-licensing/reporting.ts`, `subgraphs/vetra-licensing/renown-stats.ts`
- Modify: `subgraphs/vetra-licensing/index.ts` (token issuance in `afterApp`, relay wiring, `destroy` deletes the token row), `subgraphs/vetra-licensing/config.ts` (renown workload settings), `subgraphs/vetra-apps/renown.ts` (export the header constant only — it already is: `REGISTRATION_TOKEN_HEADER`)
- Test: `__tests__/reporting.test.ts`, `__tests__/renown-stats.test.ts`

**Interfaces:**
- Consumes: `ChainEnvRows`, `LicenceRecord`, `AppReads`, `normaliseUserDid`, `getTenantId` (`processors/vetra-cloud-environment/gitops.ts`), `SecretsService.setSecrets`, `REGISTRATION_TOKEN_HEADER` (`subgraphs/vetra-apps/renown.ts`), `loadAppsConfig(process.env).renown` (`subgraphs/vetra-apps/config.ts`) for `switchboardUrl` + `registrationToken`.
- Produces:
  - `reporting.ts`: `REPORTING_HEADER = "x-vetra-reporting-token"`, `REPORTING_TOKEN_SECRET = "VETRA_REPORTING_TOKEN"`, `LICENSING_URL_ENV = "VETRA_LICENSING_URL"`; `hashToken(token: string): string`; `interface ReportingDeps { db: Kysely<VetraLicensingDB>; secrets: Pick<SecretsService, "setSecrets"> | null; tenantIdOf(environmentId: string): Promise<string | null>; licensingUrl: string | null; newToken(): string; now(): string; logger: Pick<Console, "warn"> }`; `ensureReportingTokens(deps, environmentIds: string[]): Promise<void>`; `environmentForToken(db, token: string): Promise<string | null>`; `interface RelayDeps { db: Kysely<VetraLicensingDB>; envRows: ChainEnvRows; licence(id: string): Promise<LicenceRecord | null>; apps: Pick<AppReads, "app">; stats: RenownStatsClient; logger: Pick<Console, "info" | "warn"> }`; `relayUserStat(deps, token: string | null, input: { user: string; metric: string; value: number }): Promise<boolean>`.
  - `renown-stats.ts`: `interface RenownStatsClient { enqueue(report: { appDid: string; userDid: string; metric: string; value: number }): boolean; flush(): Promise<void>; stop(): void }`; `createRenownStatsClient(cfg: { statsUrl: string | null; workloadUrl: string | null; registrationToken: string | null; flushIntervalMs?: number }, deps?: { fetch?: typeof fetch; now?: () => number; logger?: Pick<Console, "info" | "warn"> }): RenownStatsClient`.

- [ ] **Step 1: Failing tests for the Renown client**

`subgraphs/vetra-licensing/__tests__/renown-stats.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createRenownStatsClient } from "../renown-stats.js";

const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
const gqlError = (code: string) => new Response(JSON.stringify({ errors: [{ message: code, extensions: { code } }] }), { status: 200 });

function setup(responses: Record<string, (body: { query: string; variables: Record<string, unknown> }) => Response>) {
  const calls: { url: string; headers: Record<string, string>; body: { query: string; variables: Record<string, unknown> } }[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
    calls.push({ url, headers: init.headers as Record<string, string>, body });
    return responses[url]!(body);
  });
  let clock = 0;
  const logger = { info: vi.fn(), warn: vi.fn() };
  const client = createRenownStatsClient(
    { statsUrl: "https://renown/graphql/renown-stats", workloadUrl: "https://renown/graphql/renown-workload", registrationToken: "reg-secret", flushIntervalMs: 0 },
    { fetch: fetch as never, now: () => clock, logger },
  );
  return { client, calls, logger, tick: (ms: number) => { clock += ms; } };
}

const R = { appDid: "did:key:zApp", userDid: "did:pkh:eip155:1:0x1", metric: "notes", value: 3 };

describe("Renown stats client", () => {
  it("is off without RENOWN_STATS_URL", () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const client = createRenownStatsClient({ statsUrl: null, workloadUrl: "x", registrationToken: "y" }, { logger });
    expect(client.enqueue(R)).toBe(false);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("RENOWN_STATS_URL unset"));
  });

  it("mints an app token with the registration header, then reports with X-Renown-App-Token", async () => {
    const s = setup({
      "https://renown/graphql/renown-workload": () => ok({ issueAppStatsToken: "tok-1" }),
      "https://renown/graphql/renown-stats": () => ok({ reportUserStat: true }),
    });
    expect(s.client.enqueue(R)).toBe(true);
    await s.client.flush();
    expect(s.calls[0]!.headers["x-renown-workload-registration-token"]).toBe("reg-secret");
    expect(s.calls[0]!.body.variables).toStrictEqual({ did: "did:key:zApp" });
    expect(s.calls[1]!.headers["X-Renown-App-Token"]).toBe("tok-1");
    expect(s.calls[1]!.headers).not.toHaveProperty("authorization");
    expect(s.calls[1]!.body.variables).toStrictEqual(R);
  });

  it("coalesces reports per (app, user, metric): the latest value wins", async () => {
    const s = setup({
      "https://renown/graphql/renown-workload": () => ok({ issueAppStatsToken: "tok" }),
      "https://renown/graphql/renown-stats": () => ok({ reportUserStat: true }),
    });
    s.client.enqueue({ ...R, value: 1 });
    s.client.enqueue({ ...R, value: 2 });
    s.client.enqueue({ ...R, metric: "votes", value: 9 });
    await s.client.flush();
    const sent = s.calls.filter((c) => c.url.endsWith("renown-stats")).map((c) => c.body.variables);
    expect(sent).toStrictEqual([{ ...R, value: 2 }, { ...R, metric: "votes", value: 9 }]);
  });

  it("caches the token per app until shortly before its 10-minute life ends", async () => {
    let minted = 0;
    const s = setup({
      "https://renown/graphql/renown-workload": () => ok({ issueAppStatsToken: `tok-${++minted}` }),
      "https://renown/graphql/renown-stats": () => ok({ reportUserStat: true }),
    });
    s.client.enqueue(R); await s.client.flush();
    s.tick(8 * 60_000);
    s.client.enqueue(R); await s.client.flush();
    expect(minted).toBe(1);
    s.tick(2 * 60_000);
    s.client.enqueue(R); await s.client.flush();
    expect(minted).toBe(2);
  });

  it("FORBIDDEN from the token mint drops the batch for that app and logs", async () => {
    const s = setup({ "https://renown/graphql/renown-workload": () => gqlError("FORBIDDEN"), "https://renown/graphql/renown-stats": () => ok({ reportUserStat: true }) });
    s.client.enqueue(R);
    await s.client.flush();
    expect(s.calls.filter((c) => c.url.endsWith("renown-stats"))).toHaveLength(0);
    expect(s.logger.warn).toHaveBeenCalledWith(expect.stringContaining("FORBIDDEN"));
  });

  it("a FORBIDDEN report invalidates the cached token and is logged, not retried forever", async () => {
    let minted = 0;
    const s = setup({
      "https://renown/graphql/renown-workload": () => ok({ issueAppStatsToken: `tok-${++minted}` }),
      "https://renown/graphql/renown-stats": () => gqlError("FORBIDDEN"),
    });
    s.client.enqueue(R); await s.client.flush();
    s.client.enqueue(R); await s.client.flush();
    expect(minted).toBe(2);
    expect(s.logger.warn).toHaveBeenCalledWith(expect.stringContaining("FORBIDDEN"));
  });
});
```

- [ ] **Step 2: Failing tests for tokens and the relay**

`subgraphs/vetra-licensing/__tests__/reporting.test.ts` (PGlite):

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// PGlite / Kysely / up / loadLicensingConfig / createChainEnvironmentRows imports as in earlier tests
import { ensureReportingTokens, environmentForToken, hashToken, relayUserStat, type RelayDeps, type ReportingDeps } from "../reporting.js";

const DID = "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";
let db: Kysely<VetraLicensingDB>;
let rep: ReportingDeps;
let setSecrets: ReturnType<typeof vi.fn>;
let n = 0;

beforeEach(async () => {
  db = new Kysely<VetraLicensingDB>({ dialect: new PGliteDialect(new PGlite()) });
  await up(db as Kysely<any>);
  setSecrets = vi.fn(async () => {});
  rep = {
    db, secrets: { setSecrets }, tenantIdOf: async (id) => (id === "pending" ? null : `tenant-${id}`),
    licensingUrl: "https://sb/graphql/vetra-licensing", newToken: () => `token-${++n}`,
    now: () => "t", logger: { warn: vi.fn() },
  };
});
afterEach(async () => { await db.destroy(); });

describe("reporting tokens", () => {
  it("writes the token and the endpoint into the environment's secrets, storing only a hash", async () => {
    await ensureReportingTokens(rep, ["e1"]);
    expect(setSecrets).toHaveBeenCalledWith("tenant-e1", [
      { key: "VETRA_REPORTING_TOKEN", value: "token-1" },
      { key: "VETRA_LICENSING_URL", value: "https://sb/graphql/vetra-licensing" },
    ]);
    const row = await db.selectFrom("environment_reporting_tokens").selectAll().executeTakeFirstOrThrow();
    expect(row).toMatchObject({ environment_id: "e1", token_hash: hashToken("token-1") });
    expect(await environmentForToken(db, "token-1")).toBe("e1");
    expect(await environmentForToken(db, "wrong")).toBeNull();
  });
  it("is idempotent and waits for a tenant id", async () => {
    await ensureReportingTokens(rep, ["e1", "pending"]);
    await ensureReportingTokens(rep, ["e1", "pending"]);
    expect(setSecrets).toHaveBeenCalledTimes(1);
  });
  it("does nothing without a secrets service", async () => {
    await ensureReportingTokens({ ...rep, secrets: null }, ["e1"]);
    expect(await db.selectFrom("environment_reporting_tokens").selectAll().execute()).toStrictEqual([]);
  });
});

describe("relayUserStat", () => {
  let relay: RelayDeps;
  let enqueue: ReturnType<typeof vi.fn>;
  let licenceStatus = "ACTIVE";
  beforeEach(async () => {
    const envRows = createChainEnvironmentRows(db, loadLicensingConfig({}));
    await envRows.claim({ environment_id: "e1", root_license_id: "l1", app_id: "app-1", user_did: DID, license_id: "l1", template_id: null, label: null, template_hash: "h", ended_at: null, stopped_at: null, delete_after: null, created_at: "t", updated_at: "t" });
    await ensureReportingTokens(rep, ["e1"]);
    enqueue = vi.fn(() => true);
    licenceStatus = "ACTIVE";
    relay = {
      db, envRows,
      licence: async (id) => (id === "l1" ? ({ id, app: "app-1", status: licenceStatus } as never) : null),
      apps: { app: async () => ({ id: "app-1", identityDid: "did:key:zApp" } as never) },
      stats: { enqueue, flush: async () => {}, stop: () => {} },
      logger: { info: vi.fn(), warn: vi.fn() },
    };
  });

  it("forwards as the environment's app for an ACTIVE licence", async () => {
    expect(await relayUserStat(relay, "token-1", { user: "0x2222222222222222222222222222222222222222", metric: "notes", value: 4 })).toBe(true);
    expect(enqueue).toHaveBeenCalledWith({ appDid: "did:key:zApp", userDid: "did:pkh:eip155:1:0x2222222222222222222222222222222222222222", metric: "notes", value: 4 });
  });
  it("refuses a stat from an environment whose licence is not ACTIVE", async () => {
    licenceStatus = "EXPIRED";
    expect(await relayUserStat(relay, "token-1", { user: DID, metric: "notes", value: 1 })).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
  });
  it("refuses without or with an unknown token", async () => {
    await expect(relayUserStat(relay, null, { user: DID, metric: "m", value: 1 })).rejects.toThrow("a reporting token is required");
    await expect(relayUserStat(relay, "nope", { user: DID, metric: "m", value: 1 })).rejects.toThrow("unknown reporting token");
  });
  it("rejects a malformed metric or a non-finite value", async () => {
    await expect(relayUserStat(relay, "token-1", { user: DID, metric: "has space", value: 1 })).rejects.toThrow(/metric/);
    await expect(relayUserStat(relay, "token-1", { user: DID, metric: "m", value: Number.NaN })).rejects.toThrow(/value/);
  });
  it("returns false for an app without an identity", async () => {
    relay.apps = { app: async () => ({ id: "app-1", identityDid: null } as never) };
    expect(await relayUserStat(relay, "token-1", { user: DID, metric: "m", value: 1 })).toBe(false);
  });
});
```

- [ ] **Step 3: Run to see them fail**

Run: `npx vitest run subgraphs/vetra-licensing/__tests__/renown-stats.test.ts subgraphs/vetra-licensing/__tests__/reporting.test.ts` → FAIL.

- [ ] **Step 4: Implement `renown-stats.ts`**

```ts
import { REGISTRATION_TOKEN_HEADER } from "../vetra-apps/renown.js";

export interface StatReport { appDid: string; userDid: string; metric: string; value: number }

export interface RenownStatsClient {
  /** Queues the CURRENT value; false when the relay is configured off. */
  enqueue(report: StatReport): boolean;
  flush(): Promise<void>;
  stop(): void;
}

/** Renown issues ~10-minute tokens; refresh with a margin. */
const TOKEN_TTL_MS = 9 * 60_000;
const DEFAULT_FLUSH_MS = 5_000;

class RenownError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export function createRenownStatsClient(
  cfg: { statsUrl: string | null; workloadUrl: string | null; registrationToken: string | null; flushIntervalMs?: number },
  deps: { fetch?: typeof fetch; now?: () => number; logger?: Pick<Console, "info" | "warn"> } = {},
): RenownStatsClient {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const logger = deps.logger ?? console;
  const pending = new Map<string, StatReport>();
  const tokens = new Map<string, { token: string; at: number }>();
  let timer: ReturnType<typeof setInterval> | null = null;

  async function gql<T>(url: string, headers: Record<string, string>, query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...headers },
      body: JSON.stringify({ query, variables }),
    });
    const body = (await res.json().catch(() => null)) as { data?: T; errors?: { message: string; extensions?: { code?: string } }[] } | null;
    const err = body?.errors?.[0];
    if (!res.ok || !body?.data || err) {
      throw new RenownError(err?.extensions?.code ?? String(res.status), err?.message ?? "request failed");
    }
    return body.data;
  }

  async function tokenFor(appDid: string): Promise<string> {
    const cached = tokens.get(appDid);
    if (cached && now() - cached.at < TOKEN_TTL_MS) return cached.token;
    const data = await gql<{ issueAppStatsToken: string }>(
      cfg.workloadUrl!,
      { [REGISTRATION_TOKEN_HEADER]: cfg.registrationToken! },
      "mutation Issue($did: String!) { issueAppStatsToken(did: $did) }",
      { did: appDid },
    );
    tokens.set(appDid, { token: data.issueAppStatsToken, at: now() });
    return data.issueAppStatsToken;
  }

  async function flush(): Promise<void> {
    const batch = [...pending.values()];
    pending.clear();
    for (const r of batch) {
      try {
        const token = await tokenFor(r.appDid);
        await gql(
          cfg.statsUrl!,
          { "X-Renown-App-Token": token },
          "mutation Report($appDid: String!, $userDid: String!, $metric: String!, $value: Float!) { reportUserStat(appDid: $appDid, userDid: $userDid, metric: $metric, value: $value) }",
          { appDid: r.appDid, userDid: r.userDid, metric: r.metric, value: r.value },
        );
      } catch (err) {
        // FORBIDDEN: app PENDING_IDENTITY or its delegation lapsed. Drop the
        // cached token so the next report re-checks; values are current-state,
        // so the next report carries the latest value anyway.
        tokens.delete(r.appDid);
        const code = err instanceof RenownError ? err.code : "ERROR";
        logger.warn(`[licensing] renown stat ${r.metric} for ${r.appDid} not delivered (${code}): ${String(err)}`);
      }
    }
  }

  const enabled = Boolean(cfg.statsUrl && cfg.workloadUrl && cfg.registrationToken);
  if (enabled && (cfg.flushIntervalMs ?? DEFAULT_FLUSH_MS) > 0) {
    timer = setInterval(() => void flush(), cfg.flushIntervalMs ?? DEFAULT_FLUSH_MS);
    timer.unref?.();
  }

  return {
    enqueue(report) {
      if (!enabled) {
        logger.info("[licensing] stat not relayed: RENOWN_STATS_URL unset (or Renown workload registration not configured)");
        return false;
      }
      // Current value, not a delta: the newest report per (app, user, metric) wins.
      pending.set(`${report.appDid}\u0000${report.userDid}\u0000${report.metric}`, report);
      return true;
    },
    flush,
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
```

- [ ] **Step 5: Implement `reporting.ts`**

```ts
import { createHash, randomBytes } from "node:crypto";
import type { Kysely } from "kysely";
import type { VetraLicensingDB } from "./db/schema.js";
import type { ChainEnvRows } from "./environments.js";
import type { AppReads } from "./app-reads.js";
import type { LicenceRecord } from "./reads.js";
import { normaliseUserDid } from "./did.js";
import { UnauthenticatedError } from "./auth.js";
import { InvalidPublisherInputError } from "./publisher-errors.js";
import type { RenownStatsClient } from "./renown-stats.js";
import type { SecretsService } from "../vetra-cloud-secrets/services/secrets-service.js";

export const REPORTING_HEADER = "x-vetra-reporting-token";
export const REPORTING_TOKEN_SECRET = "VETRA_REPORTING_TOKEN";
export const LICENSING_URL_ENV = "VETRA_LICENSING_URL";
const METRIC = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const newReportingToken = () => randomBytes(32).toString("hex");

export interface ReportingDeps {
  db: Kysely<VetraLicensingDB>;
  secrets: Pick<SecretsService, "setSecrets"> | null;
  /** null until the environment has a subdomain. */
  tenantIdOf(environmentId: string): Promise<string | null>;
  licensingUrl: string | null;
  newToken(): string;
  now(): string;
  logger: Pick<Console, "warn">;
}

/**
 * Each DEDICATED environment gets its own reporting token, never the app's
 * identity: a leaked environment can then only report for its own licence.
 * Secret first, row second: if the row write fails the next tick mints a new
 * token and overwrites the secret, so the two never disagree for long.
 */
export async function ensureReportingTokens(deps: ReportingDeps, environmentIds: string[]): Promise<void> {
  if (!deps.secrets || environmentIds.length === 0) return;
  const have = new Set((await deps.db.selectFrom("environment_reporting_tokens").select("environment_id")
    .where("environment_id", "in", environmentIds).execute()).map((r) => r.environment_id));
  for (const id of environmentIds) {
    if (have.has(id)) continue;
    try {
      const tenantId = await deps.tenantIdOf(id);
      if (!tenantId) continue;
      const token = deps.newToken();
      const entries = [{ key: REPORTING_TOKEN_SECRET, value: token }];
      if (deps.licensingUrl) entries.push({ key: LICENSING_URL_ENV, value: deps.licensingUrl });
      await deps.secrets.setSecrets(tenantId, entries);
      await deps.db.insertInto("environment_reporting_tokens")
        .values({ environment_id: id, token_hash: hashToken(token), created_at: deps.now() })
        .onConflict((oc) => oc.column("environment_id").doUpdateSet({ token_hash: hashToken(token) }))
        .execute();
    } catch (err) {
      deps.logger.warn(`[licensing] reporting token for ${id} not issued: ${String(err)}`);
    }
  }
}

export async function environmentForToken(db: Kysely<VetraLicensingDB>, token: string): Promise<string | null> {
  const row = await db.selectFrom("environment_reporting_tokens").select("environment_id")
    .where("token_hash", "=", hashToken(token)).executeTakeFirst();
  return row?.environment_id ?? null;
}

export interface RelayDeps {
  db: Kysely<VetraLicensingDB>;
  envRows: ChainEnvRows;
  licence(id: string): Promise<LicenceRecord | null>;
  apps: Pick<AppReads, "app">;
  stats: RenownStatsClient;
  logger: Pick<Console, "info" | "warn">;
}

/** environment -> licence (must be ACTIVE) -> app -> app DID -> Renown. */
export async function relayUserStat(
  deps: RelayDeps,
  token: string | null,
  input: { user: string; metric: string; value: number },
): Promise<boolean> {
  if (!token) throw new UnauthenticatedError("a reporting token is required");
  const environmentId = await environmentForToken(deps.db, token);
  if (!environmentId) throw new UnauthenticatedError("unknown reporting token");
  if (!METRIC.test(input.metric)) throw new InvalidPublisherInputError("metric must be 1-64 characters of A-Z a-z 0-9 . _ -");
  if (!Number.isFinite(input.value)) throw new InvalidPublisherInputError("value must be a finite number");
  const userDid = normaliseUserDid(input.user);

  const row = await deps.envRows.byEnvironment(environmentId);
  const licence = row ? await deps.licence(row.license_id) : null;
  if (!row || licence?.status !== "ACTIVE") {
    deps.logger.info(`[licensing] stat from ${environmentId} refused: its licence is not ACTIVE`);
    return false;
  }
  const app = await deps.apps.app(row.app_id);
  if (!app?.identityDid) {
    deps.logger.info(`[licensing] stat from ${environmentId} refused: app ${row.app_id} has no identity`);
    return false;
  }
  return deps.stats.enqueue({ appDid: app.identityDid, userDid, metric: input.metric, value: input.value });
}
```

- [ ] **Step 6: Wire it**

In `index.ts`:

```ts
    const appsCfg = loadAppsConfig(process.env);
    const stats = createRenownStatsClient({
      statsUrl: cfg.renownStatsUrl,
      workloadUrl: appsCfg.renown ? `${appsCfg.renown.switchboardUrl}/graphql/renown-workload` : null,
      registrationToken: appsCfg.renown?.registrationToken ?? null,
    });
    this.stats = stats; // stopped in onDisconnect
    const reporting: ReportingDeps = {
      db, secrets: secretsService,
      tenantIdOf: async (id) => {
        const s = await envs.getState(id);
        return s?.genericSubdomain ? getTenantId(s.genericSubdomain, id) : null;
      },
      licensingUrl: cfg.licensingPublicUrl, newToken: newReportingToken,
      now: () => new Date().toISOString(), logger: console,
    };
    // AppLicenseHandler deps:
      afterApp: async (_appId, rows) => {
        await tickOffboarding(offboarding, rows.filter((r) => r.ended_at !== null));
        await ensureReportingTokens(reporting, rows.filter((r) => r.ended_at === null).map((r) => r.environment_id));
      },
    // machine resolver deps:
      relay: (token, input) => relayUserStat({ db, envRows: chainRows, licence: (id) => reads.licenceRecord(id), apps: appReads, stats, logger: console }, token, input),
```

and in `offboarding.destroy`: `await envs.delete(id); await db.deleteFrom("environment_reporting_tokens").where("environment_id", "=", id).execute();`.

- [ ] **Step 7: Run, check, commit**

Run: `npx vitest run subgraphs/vetra-licensing && npm run tsc && npm run lint:fix` → PASS.

```bash
git add subgraphs/vetra-licensing
git commit -m "feat(licensing): relay user stats to Renown with per-environment reporting tokens"
```

---

### Task 15: Studio pool gated on the vetra-studio licence

**Files:**
- Modify: `subgraphs/vetra-studio-pool/index.ts`, `subgraphs/vetra-studio-pool/resolvers.ts`
- Modify: `subgraphs/vetra-studio-pool/claim.test.ts` (only if `getKeyForDid` semantics are referenced)
- Create: `subgraphs/vetra-licensing/studio-access-factory.ts`
- Test: `subgraphs/vetra-licensing/__tests__/studio-access-factory.test.ts`

**Interfaces:**
- Consumes: `studioKeyForDid`, `StudioAccessDeps` (Task 12); `createAppReads`, `createReactorLicenseReads`, `createGrantStore`, `keyCiphertextForCode`, `createKeyVault`.
- Produces: `createStudioAccessDeps(input: { client: LicenseClientLike; licensingDb: Kysely<VetraLicensingDB>; transit: OpenBaoTransitClient | null; slug: string }): StudioAccessDeps`.

The warm-pool claim path itself (`claimWarmEnvironment`) does not change: it still takes `getKeyForDid(did)` and still refuses to consume an environment when there is no key. Only the source of the key changes, from "most recent unexpired redemption" to "the caller's ACTIVE vetra-studio licence whose code carries a key".

- [ ] **Step 1: Failing test**

`subgraphs/vetra-licensing/__tests__/studio-access-factory.test.ts` — real reactor + PGlite: create the studio app document (slug `vetra-studio`, SHARED template, ACTIVE term `studio-early-access-30d` with `INVITE_CODE`), a code `studio-1` with `anthropic_key_ciphertext: "enc"`, redeem it for `DID` through `redeemInviteCode`, then:

```ts
  it("resolves the key through the caller's studio licence, on any chain spelling", async () => {
    const deps = createStudioAccessDeps({ client, licensingDb: db, transit: fakeTransit, slug: "vetra-studio" });
    expect(await studioKeyForDid(deps, `did:pkh:eip155:137:${ADDR}`)).toBe("sk-ant-plain");
    expect(await studioKeyForDid(deps, "did:pkh:eip155:1:0x9999999999999999999999999999999999999999")).toBeNull();
  });
  it("loses the key when the licence is revoked", async () => {
    await licenseGateway.execute(licenseId, [licenseActions.revokeLicense({ reason: null })]);
    expect(await studioKeyForDid(createStudioAccessDeps({ client, licensingDb: db, transit: fakeTransit, slug: "vetra-studio" }), DID)).toBeNull();
  });
```

with `fakeTransit = { ensureTenantKey: async () => {}, encrypt: async (_t, p) => p, decrypt: async (_t, c) => (c === "enc" ? "sk-ant-plain" : c) } as unknown as OpenBaoTransitClient`.

- [ ] **Step 2: Implement the factory**

```ts
import type { Kysely } from "kysely";
import type { OpenBaoTransitClient } from "../vetra-cloud-secrets/openbao-transit.js";
import { createAppReads } from "./app-reads.js";
import type { VetraLicensingDB } from "./db/schema.js";
import { createGrantStore } from "./grants.js";
import { keyCiphertextForCode } from "./invite-codes.js";
import { createKeyVault } from "./key-vault.js";
import { createReactorLicenseReads, type LicenseClientLike } from "./reads.js";
import type { StudioAccessDeps } from "./studio-access.js";

/** For subgraphs outside vetra-licensing (the studio pool) that need the studio licence gate. */
export function createStudioAccessDeps(input: {
  client: LicenseClientLike;
  licensingDb: Kysely<VetraLicensingDB>;
  transit: OpenBaoTransitClient | null;
  slug: string;
}): StudioAccessDeps {
  const apps = createAppReads(input.client);
  const reads = createReactorLicenseReads(input.client);
  const grants = createGrantStore(input.licensingDb);
  return {
    studioApp: () => apps.appBySlug(input.slug),
    licencesOf: async (appId, userDid) => reads.licenceRecords(await grants.licenceIdsFor(appId, userDid)),
    keyCiphertextForCode: (code) => keyCiphertextForCode(input.licensingDb, code),
    keyVault: createKeyVault(input.transit),
    now: () => new Date().toISOString(),
  };
}
```

`studioKeyForDid` normalises nothing itself: `licenceIdsFor` matches on the normalised DID. Make `studioKeyForDid` and `studioAccess` call `normaliseUserDid(did)` first (return the "denied" result / `null` on `UnsupportedDidError`) and extend `studio-access.test.ts` with a `did:pkh:eip155:137:` caller.

- [ ] **Step 3: Switch the studio pool**

In `subgraphs/vetra-studio-pool/index.ts` remove the three `vetra-access-codes` imports and `accessDb`, and replace `getKeyForDid` with:

```ts
    const licensingDb = (await this.relationalDb.createNamespace(
      "vetra-licensing",
    )) as unknown as Kysely<VetraLicensingDB>;
    const studioAccess = createStudioAccessDeps({
      client: this.reactorClient as never,
      licensingDb,
      transit,
      slug: process.env.VETRA_STUDIO_APP_SLUG?.trim() || "vetra-studio",
    });
    // inside claimWarmEnvironment deps:
          getKeyForDid: (d) => studioKeyForDid(studioAccess, d),
```

In `resolvers.ts` change the `callerDid` comment to "the studio licence lookup normalises the chain away" (the DID format itself is unchanged).

- [ ] **Step 4: Run, check, commit**

Run: `npx vitest run subgraphs/vetra-studio-pool subgraphs/vetra-licensing && npm run tsc && npm run lint:fix` → PASS.

```bash
git add subgraphs/vetra-studio-pool subgraphs/vetra-licensing
git commit -m "feat(studio-pool): resolve the claim key from the vetra-studio licence"
```

---

### Task 16: The startup migration (dry-run by default, idempotent, verified)

One step runner, started from `onSetup` without being awaited, re-run every 10 minutes until it reports `complete`. Mode `LICENSING_MIGRATION`: `off` (never runs; the handler stays gated), `dry-run` (default: computes everything, writes nothing, logs every action it would take), `apply`. Each item is isolated: one bad licence is a logged problem, never an exception out of the runner; nothing in the runner can throw out of `onSetup`, so a failure never affects other subgraphs. It never deletes an environment; it deletes `app-license-type` documents only with `LICENSING_MIGRATION_DELETE_LICENSE_TYPES=true` and only after every other step verified clean.

**Files:**
- Create: `subgraphs/vetra-licensing/migration/legacy.ts`, `migration/steps.ts`, `migration/run.ts`, `migration/studio.ts`
- Modify: `subgraphs/vetra-licensing/index.ts`
- Test: `subgraphs/vetra-licensing/__tests__/migration.integration.test.ts`, `__tests__/migration-run.test.ts`

**Interfaces:**
- Consumes: everything above; the legacy `vetra-access-codes` namespace tables (`invite_codes`, `invite_redemptions`, read-only) — declare a local `LegacyAccessDB` type in `migration/legacy.ts` (copy of the two row types from `subgraphs/vetra-access-codes/db/schema.ts`) so this survives Task 17's deletion; legacy `app_user_environments` rows.
- Produces:
  - `migration/legacy.ts`: `LEGACY_LICENSE_TYPE_DOC_TYPE = "powerhouse/app-license-type"`; `interface LegacyLicenseType { id: string; app: string | null; kind: string | null; label: string | null; validityDays: number | null; status: string; template: { services: { id: string; type: string; prefix: string | null; artifactName: string | null; artifactChannel: string | null }[]; packages: { id: string; packageName: string | null; version: string | null }[]; size: string | null; baseDomain: string | null; packageRegistry: string | null } }`; `parseLegacyLicenseType(doc: unknown): LegacyLicenseType | null`; `interface LegacyAccessDB`.
  - `migration/studio.ts`: `STUDIO_APP_ID = "398e9897-ab69-4102-8956-1b310323ec72"`, `STUDIO_TEMPLATE_ID = "studio"`, `STUDIO_KIND = "studio-early-access-30d"`.
  - `migration/steps.ts`: `interface MigrationDeps` (below); `interface MigrationReport { mode: "dry-run" | "apply"; actions: string[]; problems: string[] }`; `migrateLicenseTypes`, `migrateLicences`, `migrateEnvironments`, `migrateStudio`, `deleteLegacyLicenseTypes` — each `(deps, report) => Promise<void>`.
  - `migration/run.ts`: `runLicensingMigration(deps): Promise<MigrationReport & { complete: boolean }>`; `startLicensingMigration(deps, intervalMs = 600_000): { stop(): void }`.

```ts
export interface MigrationDeps {
  db: Kysely<VetraLicensingDB>;
  accessDb: Kysely<LegacyAccessDB> | null;
  legacyTypeDocs(): Promise<unknown[]>;          // find({ type: app-license-type }), all pages
  licences(): Promise<LicenceRecord[]>;          // reads.allLicenceRecords
  apps: AppReads;
  appGateway: DocGateway;
  createAppDocument(id: string): Promise<void>;  // createReactorAppDocStore(...).create
  licenseGateway: LicenseGateway;
  deleteDocument(id: string): Promise<void>;
  grants: GrantStore;
  cfg: Pick<LicensingConfig, "migration" | "deleteLicenseTypes" | "studioAppSlug" | "studioPublisher">;
  now(): string;
  logger: Pick<Console, "info" | "warn">;
}
```

- [ ] **Step 1: Write the failing integration test**

`subgraphs/vetra-licensing/__tests__/migration.integration.test.ts` — real reactor + two PGlite namespaces (licensing, legacy access codes). Seed production-shaped legacy data **through the legacy write paths** so the test sees what production has:

1. An app document `APP` (via `createReactorAppDocStore.create(APP)` + `setAppDetails({ owner: OWNER, slug: "kv" })`, `setStatus ACTIVE`) and a second app `APP2` whose document is **missing** (only referenced by a licence type).
2. Legacy licence types created with the still-present `app-license-type` model: `T_PRO` (app APP, kind `PRO`, label `Pro`, validity 30, template CONNECT + FUSION `kv`@LATEST + package `@kv/pkg`, published ACTIVE), `T_OLD` (app APP, kind `PRO` too — the clash case, RETIRED), `T_ORPHAN` (app APP2, ACTIVE).
3. Legacy licences issued with the **legacy input shape** (`issueLicense({ app, licenseType, user: "0x…", issuer: "PUBLISHER_GRANT", issuedBy: "0x…", stage: null, details: null, issued, start, end })` then `activateLicense`): `L1` (HOLDER_A on T_PRO), `L2` (HOLDER_A on T_PRO too — second ACTIVE licence of the same holder), `L3` (HOLDER_B on T_OLD, EXPIRED), `L4` (HOLDER_C on T_PRO, **no** grant row). Grant rows for L1, L2, L3 with `license_type_id` set (the shape `recordGrant` wrote before this change).
4. `app_user_environments` row: (APP, HOLDER_A, env `ENV_A`, license L1, template_hash "old-hash").
5. Legacy access-code tables: code `cohort-1` (label "Cohort 1", ciphertext `vault:v1:abc`, max_uses 10), redemptions: `did:pkh:eip155:137:<HOLDER_D>` redeemed 10 days ago, access_expires in 20 days (live); `did:pkh:eip155:1:<HOLDER_E>` redeemed 60 days ago, expired.

Then:

```ts
  it("dry-run writes nothing and lists what it would do", async () => {
    const report = await runLicensingMigration({ ...deps, cfg: { ...cfg, migration: "dry-run" } });
    expect(report.complete).toBe(false);
    expect(report.actions.length).toBeGreaterThan(0);
    expect(await db.selectFrom("license_environments").selectAll().execute()).toStrictEqual([]);
    expect(await db.selectFrom("licensing_migration_type_map").selectAll().execute()).toStrictEqual([]);
    expect((await appReads.app(APP))!.terms).toStrictEqual([]);
    expect(await appReads.appBySlug("vetra-studio")).toBeNull();
  });

  it("apply converts types into terms and templates with fidelity", async () => {
    const report = await runLicensingMigration(deps);
    const app = (await appReads.app(APP))!;
    const pro = app.terms.find((t) => t.id === `term-${T_PRO}`)!;
    expect(pro).toMatchObject({ kind: "PRO", label: "Pro", validityDays: 30, issuers: ["PUBLISHER_GRANT"], status: "ACTIVE", templateId: `tpl-${T_PRO}` });
    const old = app.terms.find((t) => t.id === `term-${T_OLD}`)!;
    expect(old.kind).toBe(`PRO-${T_OLD.slice(0, 8)}`);
    expect(old.status).toBe("RETIRED");
    const tpl = app.templates.find((t) => t.id === `tpl-${T_PRO}`)!;
    expect(tpl.mode).toBe("DEDICATED");
    expect(tpl.template.services.map((s) => [s.type, s.artifactName ?? null])).toStrictEqual([["CONNECT", null], ["FUSION", "kv"]]);
    expect(tpl.template.packages.map((p) => p.packageName)).toStrictEqual(["@kv/pkg"]);
    expect(report.problems).toContain(`licence type ${T_ORPHAN}: app ${APP2} has no document`);
  });

  it("apply rewrites licences onto kinds and DIDs, keeping provenance", async () => {
    const l1 = (await reads.licenceRecord(L1))!;
    expect(l1).toMatchObject({ kind: "PRO", user: didOf(HOLDER_A), stage: ENV_A });
    expect(JSON.parse(l1.details!)).toMatchObject({ legacyLicenseType: T_PRO, issuedBy: OWNER });
    const grant = await db.selectFrom("app_license_grants").selectAll().where("license_id", "=", L1).executeTakeFirstOrThrow();
    expect(grant).toMatchObject({ kind: "PRO", user_did: didOf(HOLDER_A) });
    expect((await reads.licenceRecord(L4))!.kind).toBe("PRO"); // migrated, but still no grant row: held
    expect(await db.selectFrom("app_license_grants").selectAll().where("license_id", "=", L4).execute()).toStrictEqual([]);
  });

  it("re-keys the live environment and chains a second active licence of the same holder onto it", async () => {
    expect(await db.selectFrom("license_environments").selectAll().execute()).toStrictEqual([
      expect.objectContaining({ environment_id: ENV_A, root_license_id: L1, license_id: L1, user_did: didOf(HOLDER_A), template_id: `tpl-${T_PRO}`, template_hash: "old-hash", ended_at: null }),
    ]);
    expect(await grants.chainRootOf(L2)).toBe(L1);
  });

  it("seeds the allow list from existing holders", async () => {
    expect((await grants.allowList(APP)).map((e) => e.user).sort()).toStrictEqual([didOf(HOLDER_A), didOf(HOLDER_B)].sort());
  });

  it("creates the vetra-studio app with its term, moves codes, and turns live redemptions into ACTIVE licences", async () => {
    const studio = (await appReads.appBySlug("vetra-studio"))!;
    expect(studio).toMatchObject({ id: STUDIO_APP_ID, owner: OWNER, status: "ACTIVE" });
    expect(studio.terms).toStrictEqual([expect.objectContaining({ kind: "studio-early-access-30d", validityDays: 30, issuers: ["INVITE_CODE"], status: "ACTIVE" })]);
    expect(studio.templates[0]).toMatchObject({ mode: "SHARED" });
    expect(await db.selectFrom("invite_codes").selectAll().execute()).toStrictEqual([
      expect.objectContaining({ code: "cohort-1", app_id: STUDIO_APP_ID, kind: "studio-early-access-30d", anthropic_key_ciphertext: "vault:v1:abc", max_uses: 10 }),
    ]);
    const live = await db.selectFrom("invite_redemptions").selectAll().where("user_did", "=", didOf(HOLDER_D)).executeTakeFirstOrThrow();
    const licence = (await reads.licenceRecord(live.license_id!))!;
    expect(licence).toMatchObject({ status: "ACTIVE", kind: "studio-early-access-30d", issuer: "INVITE_CODE", start: D_REDEEMED, end: D_EXPIRES });
    expect(JSON.parse(licence.details!)).toMatchObject({ code: "cohort-1" });
    const expired = await db.selectFrom("invite_redemptions").selectAll().where("user_did", "=", didOf(HOLDER_E)).executeTakeFirstOrThrow();
    expect(expired.license_id).toBeNull();
  });

  it("is complete only when nothing is left, and a second run changes nothing", async () => {
    const before = await snapshot(); // row counts of every licensing table + app doc revisions + licence doc count
    const again = await runLicensingMigration(deps);
    expect(await snapshot()).toStrictEqual(before);
    // T_ORPHAN's app has no document: not complete, so the handler stays gated.
    expect(again.complete).toBe(false);
  });

  it("completes once the missing app document appears, and never deletes an environment", async () => {
    await appDocs.create(APP2);
    const envDocsBefore = await countEnvDocuments();
    const report = await runLicensingMigration(deps);
    expect(report.problems).toStrictEqual([]);
    expect(report.complete).toBe(true);
    expect(await db.selectFrom("licensing_migration_steps").select("step").execute()).toContainEqual({ step: "complete" });
    expect(await countEnvDocuments()).toBe(envDocsBefore);
  });

  it("deletes legacy licence types only when asked, after completion", async () => {
    await runLicensingMigration(deps);
    expect(await legacyTypeCount()).toBe(3);
    await runLicensingMigration({ ...deps, cfg: { ...cfg, deleteLicenseTypes: true } });
    expect(await legacyTypeCount()).toBe(0);
    expect(await db.selectFrom("licensing_migration_type_map").selectAll().execute()).toHaveLength(3);
  });
```

`snapshot`, `countEnvDocuments`, `legacyTypeCount`, `didOf = (a) => \`did:pkh:eip155:1:${a.toLowerCase()}\`` are small helpers defined in the test file. The tests run in order and share state (`describe` with `beforeAll` seeding once).

`subgraphs/vetra-licensing/__tests__/migration-run.test.ts` (fakes):

```ts
  it("does nothing in mode off", async () => { /* runLicensingMigration with cfg.migration "off" -> { complete: false, actions: [], problems: [] }, no dep called */ });
  it("never throws: a step that throws becomes a problem", async () => { /* legacyTypeDocs rejects -> report.problems contains "step license-types failed: boom", complete false */ });
  it("startLicensingMigration stops retrying once complete", async () => { /* vi.useFakeTimers; deps that complete on 2nd run; advance 2 intervals; assert run count 2, then advancing further adds none */ });
```

Write those three with real code against `vi.fn()` deps (each dependency a `vi.fn` rejecting with `new Error("must not be called")` unless the test sets it).

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run subgraphs/vetra-licensing/__tests__/migration.integration.test.ts subgraphs/vetra-licensing/__tests__/migration-run.test.ts` → FAIL.

- [ ] **Step 3: Implement `migration/legacy.ts` and `migration/studio.ts`**

`legacy.ts`: `parseLegacyLicenseType` = the old `parseLicenseType` from `reads.ts`, but it keeps `artifactName` / `artifactChannel` on services and returns an empty template (not `null`) when the document has none; plus:

```ts
export interface LegacyAccessDB {
  invite_codes: { code: string; label: string | null; active: boolean; expires_at: string | null; max_uses: number | null; created_at: string; anthropic_key_ciphertext: string | null };
  invite_redemptions: { code: string; user_did: string; redeemed_at: string; access_expires: string | null };
}
```

`studio.ts`:

```ts
/**
 * Fixed so that two replicas booting at once create ONE studio app: the second
 * create fails on the existing id instead of making a twin. Looked up by slug
 * first, so an operator-created studio app is respected.
 */
export const STUDIO_APP_ID = "398e9897-ab69-4102-8956-1b310323ec72";
export const STUDIO_TEMPLATE_ID = "studio";
export const STUDIO_TERM_ID = "studio-early-access-30d";
export const STUDIO_KIND = "studio-early-access-30d";
```

- [ ] **Step 4: Implement `migration/steps.ts`**

```ts
import type { Kysely } from "kysely";
import type { Action } from "document-model";
import { actions as appActions } from "document-models/vetra-app";
import { actions as licenseActions } from "document-models/app-owner-license";
// + types: VetraLicensingDB, LicenceRecord, AppReads, DocGateway, LicenseGateway, GrantStore, LicensingConfig, LegacyAccessDB
import { didForAddress, normaliseUserDid } from "../did.js";
import { parseLegacyLicenseType, type LegacyLicenseType } from "./legacy.js";
import { STUDIO_APP_ID, STUDIO_KIND, STUDIO_TEMPLATE_ID, STUDIO_TERM_ID } from "./studio.js";

export interface MigrationReport { mode: "dry-run" | "apply"; actions: string[]; problems: string[] }

const apply = (deps: MigrationDeps) => deps.cfg.migration === "apply";

/** In dry-run, record; in apply, record and do. */
async function act(deps: MigrationDeps, report: MigrationReport, what: string, run: () => Promise<unknown>) {
  report.actions.push(what);
  if (apply(deps)) await run();
}

export async function migrateLicenseTypes(deps: MigrationDeps, report: MigrationReport): Promise<void> {
  const mapped = new Set((await deps.db.selectFrom("licensing_migration_type_map").select("license_type_id").execute()).map((r) => r.license_type_id));
  for (const doc of await deps.legacyTypeDocs()) {
    const t = parseLegacyLicenseType(doc);
    if (!t) continue;
    if (mapped.has(t.id)) continue;
    try {
      if (!t.app) { report.problems.push(`licence type ${t.id}: has no app`); continue; }
      const app = await deps.apps.app(t.app);
      if (!app) { report.problems.push(`licence type ${t.id}: app ${t.app} has no document`); continue; }
      const templateId = `tpl-${t.id}`;
      const termId = `term-${t.id}`;
      const existingTerm = app.terms.find((x) => x.id === termId);
      let kind = existingTerm?.kind ?? (t.kind?.trim() || `legacy-${t.id.slice(0, 8)}`);
      if (!existingTerm && app.terms.some((x) => x.kind === kind)) kind = `${kind}-${t.id.slice(0, 8)}`;

      const acts: Action[] = [];
      if (!app.templates.some((x) => x.id === templateId)) {
        acts.push(appActions.addTemplate({ id: templateId, name: t.label ?? kind, mode: "DEDICATED" }));
        acts.push(appActions.setTemplateDetails({ id: templateId, size: t.template.size, baseDomain: t.template.baseDomain, packageRegistry: t.template.packageRegistry }));
        for (const s of t.template.services) {
          acts.push(appActions.addTemplateService({
            templateId, id: s.id, type: s.type as never, prefix: s.prefix,
            artifactName: s.artifactName, artifactChannel: (s.artifactChannel as never) ?? null,
          }));
        }
        for (const p of t.template.packages) {
          if (!p.packageName) { report.actions.push(`licence type ${t.id}: dropped package ${p.id} without a name (it could never render)`); continue; }
          acts.push(appActions.addTemplatePackage({ templateId, id: p.id, packageName: p.packageName, version: p.version }));
        }
      }
      if (!existingTerm) {
        acts.push(appActions.addTerm({ id: termId, kind, label: t.label, templateId, validityDays: t.validityDays, issuers: ["PUBLISHER_GRANT"] }));
      }
      const status = existingTerm?.status ?? "DRAFT";
      if ((t.status === "ACTIVE" || t.status === "RETIRED") && status === "DRAFT") acts.push(appActions.publishTerm({ id: termId }));
      if (t.status === "RETIRED" && status !== "RETIRED") acts.push(appActions.retireTerm({ id: termId }));

      await act(deps, report, `app ${app.id}: licence type ${t.id} -> template ${templateId}, term ${termId} (${kind}, ${t.status})`, async () => {
        if (acts.length > 0) await deps.appGateway.execute(app.id, acts);
        await deps.db.insertInto("licensing_migration_type_map")
          .values({ license_type_id: t.id, app_id: app.id, kind, template_id: templateId, term_id: termId, created_at: deps.now() })
          .onConflict((oc) => oc.column("license_type_id").doNothing()).execute();
      });
    } catch (err) {
      report.problems.push(`licence type ${t.id}: ${String(err)}`);
    }
  }
}

export async function migrateLicences(deps: MigrationDeps, report: MigrationReport): Promise<void> {
  const map = new Map((await deps.db.selectFrom("licensing_migration_type_map").selectAll().execute()).map((r) => [r.license_type_id, r]));
  const grantRows = new Map((await deps.db.selectFrom("app_license_grants").selectAll().execute()).map((r) => [r.license_id, r]));
  const envRows = await deps.db.selectFrom("app_user_environments").selectAll().execute();
  for (const l of await deps.licences()) {
    try {
      const grant = grantRows.get(l.id);
      let userDid: string;
      try { userDid = normaliseUserDid(l.user); } catch { report.problems.push(`licence ${l.id}: holder ${l.user} is not a wallet`); continue; }
      let kind = l.kind;
      if (!kind) {
        const typeId = l.legacyLicenseTypeId ?? (grant?.license_type_id || null);
        const m = typeId ? map.get(typeId) : undefined;
        if (!m) { report.problems.push(`licence ${l.id}: licence type ${typeId ?? "unknown"} is not mapped yet`); continue; }
        kind = m.kind;
        let issuedBy: string | null = grant?.issued_by ?? null;
        try { const d: unknown = l.details ? JSON.parse(l.details) : null; if (d && typeof d === "object" && typeof (d as Record<string, unknown>).issuedBy === "string") issuedBy = (d as Record<string, string>).issuedBy; } catch { /* free text */ }
        const details = JSON.stringify({ legacyLicenseType: typeId, issuedBy });
        await act(deps, report, `licence ${l.id}: kind ${kind}, holder ${userDid}`, () =>
          deps.licenseGateway.execute(l.id, [licenseActions.migrateLicense({ kind: kind!, user: userDid, details })]));
      }
      const env = envRows.find((e) => e.license_id === l.id && e.app_id === l.app);
      if (env && l.stage !== env.environment_id) {
        await act(deps, report, `licence ${l.id}: stage ${env.environment_id}`, () =>
          deps.licenseGateway.execute(l.id, [licenseActions.setStage({ stage: env.environment_id })]));
      }
      // Provenance is never CREATED here: a licence without a grant row stays unauthorised (held).
      if (grant && (grant.kind !== kind || grant.user_did !== userDid)) {
        await act(deps, report, `grant ${l.id}: kind/user_did`, () =>
          deps.db.updateTable("app_license_grants").set({ kind, user_did: userDid }).where("license_id", "=", l.id).execute());
      }
    } catch (err) {
      report.problems.push(`licence ${l.id}: ${String(err)}`);
    }
  }
}

export async function migrateEnvironments(deps: MigrationDeps, report: MigrationReport): Promise<void> {
  const map = new Map((await deps.db.selectFrom("licensing_migration_type_map").selectAll().execute()).map((r) => [r.license_type_id, r]));
  const have = new Set((await deps.db.selectFrom("license_environments").select("environment_id").execute()).map((r) => r.environment_id));
  const roots = await deps.grants.chainRoots();
  const authorised = await deps.grants.authorisedIds();
  const licences = await deps.licences();
  for (const row of await deps.db.selectFrom("app_user_environments").selectAll().execute()) {
    try {
      const userDid = didForAddress(row.user_address);
      const licence = licences.find((l) => l.id === row.license_id);
      const typeId = licence?.legacyLicenseTypeId ?? null;
      if (!have.has(row.environment_id)) {
        await act(deps, report, `environment ${row.environment_id}: chain ${row.license_id} (${userDid})`, async () => {
          await deps.grants.linkChain({ licenseId: row.license_id, rootLicenseId: row.license_id, appId: row.app_id, label: null, now: row.created_at });
          await deps.db.insertInto("license_environments").values({
            environment_id: row.environment_id, root_license_id: row.license_id, app_id: row.app_id, user_did: userDid,
            license_id: row.license_id, template_id: (typeId && map.get(typeId)?.template_id) || null, label: null,
            // Kept: the handler re-applies once if the new template hashes differently, which is a diff, not a rebuild.
            template_hash: row.template_hash, ended_at: null, stopped_at: null, delete_after: null,
            created_at: row.created_at, updated_at: deps.now(),
          }).onConflict((oc) => oc.column("environment_id").doNothing()).execute();
        });
      }
      // The old keeper gave a holder ONE environment however many licences they
      // held. Chain every other authorised ACTIVE licence of that holder onto
      // this environment, or the handler would provision one per licence.
      for (const other of licences) {
        if (other.id === row.license_id || other.app !== row.app_id || other.status !== "ACTIVE") continue;
        if (!authorised.has(other.id) || roots.has(other.id)) continue;
        let otherDid: string;
        try { otherDid = normaliseUserDid(other.user); } catch { continue; }
        if (otherDid !== userDid) continue;
        await act(deps, report, `licence ${other.id}: chained onto environment ${row.environment_id}`, () =>
          deps.grants.linkChain({ licenseId: other.id, rootLicenseId: row.license_id, appId: row.app_id, label: null, now: deps.now() }));
      }
    } catch (err) {
      report.problems.push(`environment ${row.environment_id}: ${String(err)}`);
    }
  }
  // Publishers granted without an allow list before; keep every existing holder grantable.
  // Migrated studio redemptions are not publisher grants: they never join an allow list.
  for (const g of await deps.db.selectFrom("app_license_grants").selectAll().where("issued_by", "!=", "vetra-access-codes").execute()) {
    const userDid = g.user_did ?? didForAddress(g.user_address);
    if (await deps.grants.isOnAllowList(g.app_id, userDid)) continue;
    await act(deps, report, `allow list ${g.app_id}: ${userDid}`, () => deps.grants.addToAllowList(g.app_id, userDid, g.created_at));
  }
}

export async function migrateStudio(deps: MigrationDeps, report: MigrationReport): Promise<void> {
  let app = await deps.apps.appBySlug(deps.cfg.studioAppSlug);
  if (!app) {
    const owner = deps.cfg.studioPublisher;
    if (!owner) { report.problems.push("studio: set VETRA_STUDIO_PUBLISHER_ADDRESS (or ADMINS) to create the vetra-studio app"); return; }
    await act(deps, report, `studio: create app ${STUDIO_APP_ID} (${deps.cfg.studioAppSlug}) owned by ${owner}`, async () => {
      if (!(await deps.apps.app(STUDIO_APP_ID))) await deps.createAppDocument(STUDIO_APP_ID);
      await deps.appGateway.execute(STUDIO_APP_ID, [
        appActions.setAppDetails({ name: "Vetra Studio", slug: deps.cfg.studioAppSlug, owner }),
        appActions.setStatus({ status: "ACTIVE" }),
        appActions.addTemplate({ id: STUDIO_TEMPLATE_ID, name: "Studio early access", mode: "SHARED" }),
        appActions.addTerm({ id: STUDIO_TERM_ID, kind: STUDIO_KIND, label: "Studio early access (30 days)", templateId: STUDIO_TEMPLATE_ID, validityDays: 30, issuers: ["INVITE_CODE"] }),
        appActions.publishTerm({ id: STUDIO_TERM_ID }),
      ]);
    });
    if (!apply(deps)) return; // nothing to attach codes to in a dry run
    app = await deps.apps.appBySlug(deps.cfg.studioAppSlug);
    if (!app) { report.problems.push("studio: app not readable after creation"); return; }
  }
  if (!deps.accessDb) return;
  const studioId = app.id;
  for (const c of await deps.accessDb.selectFrom("invite_codes").selectAll().execute()) {
    const exists = await deps.db.selectFrom("invite_codes").select("code").where("code", "=", c.code).executeTakeFirst();
    if (exists) continue;
    await act(deps, report, `studio: code ${c.code}`, () =>
      deps.db.insertInto("invite_codes").values({ ...c, app_id: studioId, kind: STUDIO_KIND })
        .onConflict((oc) => oc.column("code").doNothing()).execute());
  }
  const studioLicences = (await deps.licences()).filter((l) => l.app === studioId);
  const now = deps.now();
  for (const r of await deps.accessDb.selectFrom("invite_redemptions").selectAll().execute()) {
    try {
      const userDid = normaliseUserDid(r.user_did);
      let row = await deps.db.selectFrom("invite_redemptions").selectAll().where("code", "=", r.code).where("user_did", "=", userDid).executeTakeFirst();
      // Checked before acting, so the verification pass of a finished migration records nothing.
      if (!row) {
        await act(deps, report, `studio: redemption ${r.code} by ${userDid}`, () =>
          deps.db.insertInto("invite_redemptions")
            .values({ code: r.code, user_did: userDid, redeemed_at: r.redeemed_at, access_expires: r.access_expires, license_id: null })
            .onConflict((oc) => oc.columns(["code", "user_did"]).doNothing()).execute());
        row = await deps.db.selectFrom("invite_redemptions").selectAll().where("code", "=", r.code).where("user_did", "=", userDid).executeTakeFirst();
      }
      if (r.access_expires !== null && r.access_expires <= now) continue; // history only
      if (row?.license_id) continue;
      // Idempotent by content: a licence for this code + holder may exist from a run that died before attaching it.
      const found = studioLicences.find((l) => l.issuer === "INVITE_CODE" && l.details?.includes(`"code":"${r.code}"`) && l.user === userDid);
      await act(deps, report, `studio: ACTIVE licence for ${userDid} (${r.redeemed_at} - ${r.access_expires ?? "open"})`, async () => {
        let licenseId = found?.id ?? null;
        if (!licenseId) {
          const issue = licenseActions.issueLicense({
            app: studioId, user: userDid, issuer: "INVITE_CODE", kind: STUDIO_KIND, stage: null,
            details: JSON.stringify({ code: r.code, migratedFrom: "vetra-access-codes" }),
            issued: r.redeemed_at, start: r.redeemed_at, end: r.access_expires,
          });
          licenseId = await deps.licenseGateway.create();
          await deps.licenseGateway.execute(licenseId, [issue, licenseActions.activateLicense({})]);
          await deps.grants.recordGrant({ licenseId, appId: studioId, kind: STUDIO_KIND, userDid, issuedBy: "vetra-access-codes", now: r.redeemed_at });
          await deps.grants.linkChain({ licenseId, rootLicenseId: licenseId, appId: studioId, label: null, now: r.redeemed_at });
        }
        await deps.db.updateTable("invite_redemptions").set({ license_id: licenseId })
          .where("code", "=", r.code).where("user_did", "=", userDid).execute();
      });
    } catch (err) {
      report.problems.push(`studio redemption ${r.code}/${r.user_did}: ${String(err)}`);
    }
  }
}

export async function deleteLegacyLicenseTypes(deps: MigrationDeps, report: MigrationReport): Promise<void> {
  const mapped = new Set((await deps.db.selectFrom("licensing_migration_type_map").select("license_type_id").execute()).map((r) => r.license_type_id));
  for (const doc of await deps.legacyTypeDocs()) {
    const t = parseLegacyLicenseType(doc);
    if (!t) continue;
    if (!mapped.has(t.id)) { report.problems.push(`licence type ${t.id}: not deleted, it is not mapped`); continue; }
    await act(deps, report, `delete licence type ${t.id}`, () => deps.deleteDocument(t.id));
  }
}
```

`recordGrant` lowercases `issuedBy`; `"vetra-access-codes"` is stored as-is, which marks migrated studio grants in the audit trail.

- [ ] **Step 5: Implement `migration/run.ts`**

```ts
import { deleteLegacyLicenseTypes, migrateEnvironments, migrateLicences, migrateLicenseTypes, migrateStudio, type MigrationDeps, type MigrationReport } from "./steps.js";

const STEPS: [string, (d: MigrationDeps, r: MigrationReport) => Promise<void>][] = [
  ["license-types", migrateLicenseTypes],
  ["licences", migrateLicences],
  ["environments", migrateEnvironments],
  ["studio", migrateStudio],
];

export async function runLicensingMigration(deps: MigrationDeps): Promise<MigrationReport & { complete: boolean }> {
  if (deps.cfg.migration === "off") return { mode: "dry-run", actions: [], problems: [], complete: false };
  const report: MigrationReport = { mode: deps.cfg.migration, actions: [], problems: [] };
  for (const [name, step] of STEPS) {
    try {
      await step(deps, report);
    } catch (err) {
      report.problems.push(`step ${name} failed: ${String(err)}`);
    }
  }
  // Verification: in apply mode, a second pass must find nothing left to do.
  let complete = false;
  if (report.mode === "apply" && report.problems.length === 0) {
    const verify: MigrationReport = { mode: "dry-run", actions: [], problems: [] };
    const dry = { ...deps, cfg: { ...deps.cfg, migration: "dry-run" as const } };
    for (const [name, step] of STEPS) {
      try { await step(dry, verify); } catch (err) { verify.problems.push(`verify ${name} failed: ${String(err)}`); }
    }
    complete = verify.actions.length === 0 && verify.problems.length === 0;
    if (!complete) report.problems.push(...verify.problems, ...verify.actions.map((a) => `still pending after apply: ${a}`));
  }
  if (complete) {
    await deps.db.insertInto("licensing_migration_steps")
      .values({ step: "complete", completed_at: deps.now(), detail: `${report.actions.length} actions` })
      .onConflict((oc) => oc.column("step").doNothing()).execute();
    if (deps.cfg.deleteLicenseTypes) {
      try { await deleteLegacyLicenseTypes(deps, report); } catch (err) { report.problems.push(`delete licence types failed: ${String(err)}`); }
    }
  }
  const log = report.problems.length ? deps.logger.warn : deps.logger.info;
  log(`[licensing] migration (${report.mode}): ${report.actions.length} actions, ${report.problems.length} problems${complete ? ", complete" : ""}`);
  for (const a of report.actions) deps.logger.info(`[licensing] migration ${report.mode}: ${a}`);
  for (const p of report.problems) deps.logger.warn(`[licensing] migration problem: ${p}`);
  return { ...report, complete };
}

/** Never throws, never awaited by onSetup. Retries until complete. */
export function startLicensingMigration(deps: MigrationDeps, intervalMs = 600_000): { stop(): void } {
  let timer: ReturnType<typeof setInterval> | null = null;
  let busy = false;
  const stop = () => { if (timer) clearInterval(timer); timer = null; };
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const done = await deps.db.selectFrom("licensing_migration_steps").select("step").where("step", "=", "complete").executeTakeFirst();
      // Already complete: only the optional legacy-type deletion can remain.
      if (done) {
        if (deps.cfg.deleteLicenseTypes && deps.cfg.migration === "apply") {
          await deleteLegacyLicenseTypes(deps, { mode: "apply", actions: [], problems: [] });
        }
        stop();
        return;
      }
      if ((await runLicensingMigration(deps)).complete) stop();
    } catch (err) {
      deps.logger.warn(`[licensing] migration tick failed: ${String(err)}`);
    } finally {
      busy = false;
    }
  };
  if (deps.cfg.migration === "off") {
    deps.logger.warn("[licensing] LICENSING_MIGRATION=off: the licence handler stays idle until the migration completes");
    return { stop };
  }
  void tick();
  timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return { stop };
}
```

The integration test's "is idempotent" case runs after completion was **not** reached (T_ORPHAN), so it exercises a real second apply over migrated data; the deletion test then runs over a completed migration.

- [ ] **Step 6: Wire in `index.ts`**

```ts
    const accessDb = (await this.relationalDb.createNamespace("vetra-access-codes").catch(() => null)) as Kysely<LegacyAccessDB> | null;
    const appDocs = createReactorAppDocStore(this.reactorClient as never);
    this.migration = startLicensingMigration({
      db, accessDb,
      legacyTypeDocs: () => findAllOfType(this.reactorClient as never, LEGACY_LICENSE_TYPE_DOC_TYPE),
      licences: () => reads.allLicenceRecords(),
      apps: appReads, appGateway, createAppDocument: (id) => appDocs.create(id),
      licenseGateway: gateway,
      deleteDocument: async (id) => { await this.reactorClient.deleteDocument(id); },
      grants, cfg, now: () => new Date().toISOString(), logger: console,
    });
```

`findAllOfType(client, type)` is the cursor loop from `reads.ts` `findAll`, exported from `reads.ts` under that name. Stop `this.migration` in `onDisconnect`. Wrap the whole block in `try { … } catch (err) { console.warn(\`[licensing] migration not started: ${String(err)}\`) }` so nothing here can fail `onSetup`.

**Ordering note for operators:** the legacy namespace `vetra-access-codes` must still exist (it does: Task 17 deletes the code, never the tables). `createNamespace` on an existing namespace is a lookup.

- [ ] **Step 7: Run, check, commit**

Run: `npx vitest run subgraphs/vetra-licensing && npm run tsc && npm run lint:fix` → PASS.

```bash
git add subgraphs/vetra-licensing
git commit -m "feat(licensing): idempotent startup migration onto terms, chains and the studio app"
```

---

### Task 17: Delete `vetra-access-codes` and the superseded licensing code

**Files:**
- Delete: `subgraphs/vetra-access-codes/` (whole directory, incl. README and tests)
- Modify: `subgraphs/index.ts` (remove only the `VetraAccessCodesSubgraph` export line), `powerhouse.manifest.json` (remove the `vetra-access-codes` subgraph entry), `subgraphs/vetra-housekeeping/resolvers.ts` (comment that cites access-codes), `scripts/seed-access-codes.mts` → rename to `scripts/seed-invite-codes.mts`
- Delete from `subgraphs/vetra-licensing/`: `plan.ts`, `provisioning-keeper.ts`, `resolve-template.ts`, `release.ts`, `rows.ts`, the old `issuePublisherGrant` / `GrantDeps` / `InvalidHolderAddressError` / `LicenseTypeNotIssuableError` in `issuers/publisher-grant.ts`, `LicenseFullRow` / `LicenseTypeDetail` / `licenseTypes` / `licenseTypeDetails` / `licenseType` / `templateFor` / `license` / `allLicenses` / `parseLicenseType` / `parseTemplate` in `reads.ts`, `LicenseView` / `LicenseTypeView` in `resolvers.ts`; keep from `provision.ts` only `UNAPPLIED_TEMPLATE_HASH` and `AppEnvironmentCapReachedError` (move both into `environments.ts` and delete `provision.ts`)
- Delete their tests: `__tests__/plan.test.ts`, `provisioning-keeper.test.ts`, `provisioning-keeper.integration.test.ts`, `keeper-reactor.integration.test.ts` (rewrite only its `LicenseKeeper` part — see Step 2), `resolve-template.test.ts`, `release.test.ts`, `rows.test.ts`, `provision.test.ts`, `provision-reactor.integration.test.ts`, `publisher-grant.test.ts`, `template-reducers.test.ts` (it drives the `app-license-type` reducers), `license-type-gateway.test.ts`

**Interfaces:**
- Consumes: everything above. Produces: nothing new.

- [ ] **Step 1: Delete and fix references**

```bash
git rm -r subgraphs/vetra-access-codes
git rm subgraphs/vetra-licensing/plan.ts subgraphs/vetra-licensing/provisioning-keeper.ts \
  subgraphs/vetra-licensing/resolve-template.ts subgraphs/vetra-licensing/release.ts \
  subgraphs/vetra-licensing/rows.ts subgraphs/vetra-licensing/provision.ts
git rm subgraphs/vetra-licensing/__tests__/{plan,provisioning-keeper,provisioning-keeper.integration,resolve-template,release,rows,provision,provision-reactor.integration,publisher-grant,template-reducers,license-type-gateway}.test.ts
git mv scripts/seed-access-codes.mts scripts/seed-invite-codes.mts
```

Then `npm run tsc` and fix each remaining reference by deleting the dead import / function listed above. `grep -rn "access-codes\|AccessCodes" subgraphs processors shared scripts editors document-models powerhouse.manifest.json` must return only `migration/legacy.ts` (namespace name `"vetra-access-codes"` in `index.ts` for the read-only legacy view is expected) and `key-vault.ts`'s `INVITE_KEY_TRANSIT_TENANT = "access-codes"`.

- [ ] **Step 2: Keep the lifecycle clock's integration coverage**

`keeper-reactor.integration.test.ts` tests `LicenseKeeper` (ISSUED→ACTIVE→EXPIRED) against a real reactor through licence-type documents. Rewrite its setup to issue licences with the new input (`issueLicense({ app, user: DID, issuer: "PUBLISHER_GRANT", kind: "pro", … })` without `activateLicense`, start in the future / end in the past) and keep its assertions; `LicenseKeeper` and `transitions.ts` are unchanged.

- [ ] **Step 3: Rewrite the seed script for the publisher API**

`scripts/seed-invite-codes.mts`: same config format plus two required flags `--app <appId>` and `--kind <term kind>`; each entry calls

```graphql
mutation Create($input: CreateInviteCodeInput!) {
  vetraPublisher { createInviteCode(input: $input) { code label maxUses expiresAt hasAnthropicKey } }
}
```

with `input: { appId, kind, code, label, expiresAt, maxUses, anthropicKey }` (the key field is `anthropicKey` now, not `anthropicApiKey`). Update its header comment to point at `vetraPublisher` instead of the deleted README. The bearer must belong to the app's owner (or an `ADMINS` address).

- [ ] **Step 4: Run everything, commit**

Run: `npm run tsc && npm run lint:fix && npx vitest run` → all green; `cat subgraphs/index.ts` still lists the seven remaining subgraphs.

```bash
git add -A subgraphs scripts powerhouse.manifest.json
git commit -m "refactor(licensing): remove vetra-access-codes and the per-user keeper"
```

---

### Task 18: Remove the `app-license-type` model (SEPARATE RELEASE)

**Precondition — do not start until all of these hold:** this branch has been deployed to staging and then production; the production log shows `[licensing] migration (apply): … complete`; `LICENSING_MIGRATION_DELETE_LICENSE_TYPES=true` has run there and `find({ type: "powerhouse/app-license-type" })` returns nothing on staging **and** production. The reactor cannot load (or delete) documents of a type whose model is no longer registered, so removing the model first would strand the documents the migration still has to read.

**Files:**
- Delete: `document-models/app-license-type/`, `editors/app-license-type/`, `subgraphs/vetra-licensing/license-type-gateway.ts`, `LICENSE_TYPE_DOC_TYPE` in `reads.ts`
- Regenerate/modify: `document-models/document-models.ts`, `document-models/index.ts`, `document-models/upgrade-manifests.ts`, `editors/editors.ts`, `powerhouse.manifest.json`
- Modify: `subgraphs/vetra-licensing/migration/steps.ts` and `run.ts` — `migrateLicenseTypes` / `deleteLegacyLicenseTypes` read raw documents via `find`, which keeps working only while the type is registered; replace both with no-ops that log `legacy licence types already migrated` when `licensing_migration_type_map` is non-empty, and keep the map table.

- [ ] **Step 1: Delete and regenerate**

```bash
git rm -r document-models/app-license-type editors/app-license-type subgraphs/vetra-licensing/license-type-gateway.ts
npx ph-cli generate document-model -d document-models/vetra-app/vetra-app.json
```

Codegen rewrites the barrels from the directories present. Verify: `grep -rn "app-license-type\|AppLicenseType" document-models editors powerhouse.manifest.json subgraphs` returns nothing except `migration/legacy.ts` (the type string constant). If `editors/editors.ts` or `upgrade-manifests.ts` still import the deleted module, codegen did not rewrite them: remove that import and array entry by hand (the only sanctioned edit of these generated barrels) and say so in the commit body. Revert any import codegen injected into test files.

- [ ] **Step 2: Run everything, commit**

Run: `npm run tsc && npm run lint:fix && npm run test:coverage` → green.

```bash
git add -A document-models editors subgraphs powerhouse.manifest.json
git commit -m "refactor(licensing): drop the app-license-type model after its migration"
```

---

### Task 19: Final verification

- [ ] **Step 1: Full checks**

```bash
npm run tsc
npm run lint:fix
npm run test:coverage
npm run build
git diff --stat main...HEAD -- vitest.config.ts   # expect: no output
grep -n "VetraLicensingSubgraph\|VetraStudioPoolSubgraph\|VetraHousekeepingSubgraph" subgraphs/index.ts   # all present
```

Expected: tsc and lint clean; every reducer file ≥ 95 % on all four metrics (the new `licensing.ts`, `lifecycle.ts` at 100 % branches); `ph-cli build` succeeds and `dist/powerhouse.manifest.json` lists no `vetra-access-codes` subgraph.

- [ ] **Step 2: Contract parity check**

Add `subgraphs/vetra-licensing/__tests__/contract.test.ts`: parse the three GraphQL blocks of `docs/superpowers/specs/2026-10-08-licensing-api-contract.md` (extract the fenced `graphql` blocks under the `vetraPublisher`, `vetraSubscriptions` and `vetraLicensing` headings with a regex), build them with `buildASTSchema` after prepending `type Query { _: Boolean } type Mutation { _: Boolean }`, and assert that every object/input type and every field (name + printed type) in the contract exists identically in `buildASTSchema(schema)` from `../schema.js`. Comments and the `# unchanged` notes in the contract are stripped before parsing; types the contract marks "unchanged" (`PublisherAppArtifact` etc.) are taken from the subgraph. Run it; fix any drift in the subgraph, never in the contract.

```bash
git add subgraphs/vetra-licensing/__tests__/contract.test.ts
git commit -m "test(licensing): pin the served schema to the API contract"
```

- [ ] **Step 3: Staging rollout checklist (staging first, then main)**

1. Deploy to staging with `LICENSING_MIGRATION=dry-run` (default). Read the `[licensing] migration dry-run:` log lines; every action must be expected; every `problem` explained.
2. Set `VETRA_STUDIO_PUBLISHER_ADDRESS` (or confirm `ADMINS`' first entry is the intended studio publisher), `RENOWN_STATS_URL` unset, `VETRA_LICENSING_URL=https://<switchboard>/graphql/vetra-licensing`.
3. Flip to `LICENSING_MIGRATION=apply`; wait for `complete`. Check: `select count(*) from license_environments` equals `select count(*) from app_user_environments`; every live redemption has a licence; `vetraPublisher.terms` for each app shows its former tiers; `vetraSubscriptions.studioAccess` is `allowed` for a known early-access wallet; a studio claim still injects the key.
4. With the handler now active, watch one tick: no `provision` for an environment that already existed (a re-apply of an existing environment id is fine; a **new** environment id for an existing holder is a stop-the-line bug — set `LICENSING_DRY_RUN=true` and investigate).
5. `LICENSING_DESTROY_ENABLED` stays `false` until the first real offboarding has been watched through its `would destroy` log line.
6. Repeat 1–5 on production. Only then run `LICENSING_MIGRATION_DELETE_LICENSE_TYPES=true` (staging, then production), and only then start Task 18.

---

## Self-review notes

- **Spec coverage:** vetra-app licensing module (T1); app-owner-license reshape + `SET_STAGE` (T2); DID refusal `UnsupportedDidError` (T3); tables incl. `stopped_at`/`delete_after` (T4); `issueLicense` steps 1–4 + upgrades + grace (grace = `replaceGrant`/`upgrades` with a grace term) (T6); `InviteCodeIssuer` with cap/expiry (T7); handler matrix, chain keying, upgrade in place, SHARED never provisions/releases (T8–T9); offboarding timeline, re-licence reactivates, warnings (T10); `vetraPublisher` incl. `replaceGrant`, codes, allow list (T11); `vetraSubscriptions` incl. `/redeem` support (`inviteCode`), `studioAccess`, `applyStudioKey` (T12); `vetraLicensing` incl. `hasLicense`, `appTerms` (T13); Renown relay (T14); studio pool gate + key (T15); migration steps 1–4 + verification (T16); deletion of access codes (T17) and of `app-license-type` (T18). Template edits re-apply to all environments automatically through the template hash (T9); the "affects N environments" count is `PublisherTemplate.environmentCount` (T11). vetra.io and renown-package work is out of this plan by design.
- **Contract-fixed names** are pinned by the contract test (T19).

## Deviations from the spec text, and open risks

1. **`app_user_environments` is superseded, not re-keyed in place.** A new table `license_environments` (PK `environment_id`, UNIQUE `root_license_id`) replaces it; the old table stays read-only. Re-keying a live primary key is not forward-only-safe and would break a rollback.
2. **`license_chain` table** (not in the spec) records which chain a licence belongs to, so a failed `REPLACE_LICENSE` can never produce a second environment and the project label survives until provisioning.
3. **`MIGRATE_LICENSE` operation** (not in the spec) is the only way to put `kind` and a DID onto an existing licence document; legacy `licenseType` / `issuedBy` stay as optional, deprecated `ISSUE_LICENSE` inputs so a replay of history still parses.
4. **`releaseEnvironment` (machine) now starts the offboarding clock** instead of stopping at once, and the reference handler no longer releases — Vetra's clock owns ending.
5. **Destroy is additionally gated** by `LICENSING_DESTROY_ENABLED` (default off). The spec's +90-day destroy only happens once an operator turns it on.
6. **The handler is idle until the migration completes**, and the migration defaults to dry-run. Production licensing provisioning pauses from deploy until `LICENSING_MIGRATION=apply` completes.
7. **Allow lists become real.** Today `isOnAllowList` always returns true; the migration seeds every existing holder, but a publisher granting to a new wallet must now add it first (vetra.io Holders tab).
8. **Error codes change** to the contract's set: `UNKNOWN_APP` / `UNKNOWN_LICENSE` / `UNKNOWN_LICENSE_TYPE` → `NOT_FOUND`, `APP_IDENTITY_INACTIVE` → `APP_NOT_ACTIVE`. `UNAUTHENTICATED` is kept although the contract does not list it.
9. **Studio redemptions change behaviour:** a holder of an ACTIVE studio licence redeeming another studio code gets `ALREADY_HOLDS` (contract) — previously a new code extended access by a fresh 30 days. Extension now means `upgrades: <licenseId>` on redeem.
10. **The reporting token must reach the subgraph directly** (`/graphql/vetra-licensing`): the supergraph gateway forwards only `authorization`, and reactor-api rejects any non-Renown bearer with 401.
11. **`applyStudioKey` keeps the old authorisation** (a key holder may write their key into any `tenantId`). Tightening to "tenant must be the caller's environment" needs the vetra.io cold-path timing checked first (the read-model row can lag document creation).
12. **Existing bug fixed in passing:** `reads.ts parseTemplate` drops `artifactName`/`artifactChannel`, so artifact-backed FUSION templates never resolve today. Migrated templates keep the fields; their hash changes once, causing one diff re-apply per affected environment.
13. **The vetra-studio app exists only as a document** (no `apps` row). vetra-apps' own queries (`/user/apps/[id]` in vetra.io) read the table and will not show it; publisher ownership falls back to the document (T5).
14. **Template edits reach every environment on the template on the next tick** (accepted by the spec); `environmentCount` exposes the blast radius.
