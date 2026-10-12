# Renown Organisations C1 — vetra-cloud-package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Renown organisations own Vetra environments and apps: membership-aware access checks (`canOperate` / `canView`) against Renown's public `orgMembership`, org ownership on the environment document (`ownerOrgId`, `orgOperators`, `SET_OWNER_ORG`, `SYNC_ORG_OPERATORS`), an operator sync job plus an on-demand `syncEnvironmentOrg`, `myEnvironments(scope: ORG)`, org-owned apps in vetra-apps (`owner_org_id`, `myApps(orgId)`, `createApp(orgId)`, workload `ownerOrgId`, lazy ownership sync from Renown `appProfile.publisherOrg`), `canOperate` in the licensing publisher surface, and the app-profile relay passing `publisherOrgId`, `supportContact` and `securityContact`.

**Architecture:** One framework-free client, `shared/renown-orgs.ts`, asks Renown (`<renown switchboard>/graphql/renown-orgs` and `/graphql/renown-stats`) with a TTL LRU cache (30 s positive, 10 s negative, errors never cached) and throws on any failure; `shared/org-access.ts` turns that into `canOperate` / `canView` / `isOrgMember` / `canCreateOrgApp` and fails closed (an error means "no"). The environment reducer cannot call Renown, so the document carries the list of addresses allowed to sign (`orgOperators`), kept fresh by a 5-minute job and by `syncEnvironmentOrg(environmentId)` (which vetra.io calls before signed actions); the same sync grants/revokes reactor document permissions so operators can push to protected documents. Subgraph resolvers call `canOperate` directly. vetra-apps keeps `apps.owner_org_id` as Vetra's ownership record and reconciles it lazily with Renown on reads.

**Tech Stack:** TypeScript (nodenext, strict), Powerhouse 6.2.3 (`ph-cli generate`, `BaseSubgraph`, reactor client, `DocumentPermissionService`), Kysely on Postgres (PGlite in tests), graphql-tag SDL, vitest (+ v8 coverage), oxlint.

**Spec:** `/home/f/projects/renown-package-orgs/docs/superpowers/specs/2026-10-12-renown-organisations-design.md` §6 (sub-project C, vetra-cloud-package part), with §3.2 (roles, app scope), §3.7 (apps, transfers, contacts), §9 (testing, rollout). Binding API: the "Appendix — API contract" and Rulings of `/home/f/projects/renown-package-orgs/docs/superpowers/plans/2026-10-12-orgs-a1-core.md` (`orgMembership`, `organization(id).apps`, calling conventions for Vetra), A2 (`2026-10-12-orgs-a2-security-apps.md`: Ruling 10 org-owned apps, Ruling 12 transfers, Ruling 13 `registerWorkloadIdentity(ownerOrgId)`, `AppProfile.publisherOrg`, `APP_FROZEN`) and A3 (`2026-10-12-orgs-a3-integrations.md`: Ruling 9 contacts on `upsertAppProfile`). Executors read the spec and that appendix.

**Precondition:** renown-package A1–A3 are deployed on the Renown tenant this Vetra talks to (staging first). C1 only calls `orgMembership`, `organization(id) { apps }`, `appProfile { publisherDid publisherOrg }`, `registerWorkloadIdentity(input.ownerOrgId)` and `upsertAppProfile(…, publisherOrgId, supportContact, securityContact)`.

## Rulings

1. **Who may operate what.** `canOperate(caller, {owner, ownerOrgId, appDid?})`: a platform admin (`ADMINS`) always; a **personal** resource (`ownerOrgId` null) when `owner` equals the caller; an **org** resource only through an ACTIVE membership with publisher capability — `OWNER`/`ADMIN`, or `PUBLISHER` whose `effectiveScope` covers `appDid` (`all`, or the DID listed); a standalone org environment (no app) needs `PUBLISHER`+ only. For org resources the `owner` field (the creator) grants nothing: leaving the org must revoke (spec §3.7 derived revocation). `canView` = admin, personal owner, or any ACTIVE member of the owning org. Vetra's own `apps.owner_org_id` is the ownership source, so the appendix's "app belongs to the org (`organization(id).apps`)" check is not repeated (a freshly created org app is only attached to the org at its first profile claim, A2 Ruling 10).
2. **Fail closed, but never destroy on an outage.** Every Renown error (network, timeout, non-2xx, GraphQL `errors`) is thrown as `RenownOrgsUnavailableError`, logged once per lookup and never cached; request-time checks treat it as "no". The operator sync job and the lazy app sync treat it as "unknown": they leave the document, the grants and the `apps` row unchanged.
3. **Cache.** One process-wide `defaultRenownOrgs()` (shared by every subgraph): TTL LRU with 2000 entries, 30 s for answers with a value, 10 s for `null`, concurrent identical lookups share one request, 5 s request timeout. A removed member therefore loses request-time access within 30 s and their operator entry within the next job run (≤ 5 min) or the next `syncEnvironmentOrg`.
4. **Environment model.** `ownerOrgId: String`, `orgOperators: [EthereumAddress!]!` (initial `null` / `[]`). `SET_OWNER_ORG {ownerOrgId, operators}`: system-signed sets or clears freely; user-signed only by the current `owner`, only while the env is personal (`OrgOwnedError` once org-owned, so a creator who left cannot pull it back), and the signer becomes the sole operator (input operators are ignored for user-signed hand-overs). `SYNC_ORG_OPERATORS {operators}`: system-only (`OrgSyncSystemOnlyError`), org envs only (`NotOrgOwnedError`). Operators are lowercased and de-duplicated. Neither op marks the env `CHANGES_PENDING` (nothing renders differently).
5. **`assertOwner`.** When `ownerOrgId` is set, a user signer must be in `orgOperators` (missing list = empty, for legacy replays), else `NotOwnerError`; system-signed actions still bypass. Personal envs keep today's rules (auto-claim, owner match).
6. **`SET_OWNER` on owned envs.** System-signed `SET_OWNER` may now transfer an already-owned environment (needed when an org app is transferred out to a person at Renown, A2 Ruling 12). This adds no new hole: system-signed actions already bypass every other owner gate, and protected documents refuse unsigned remote writes at reactor-api. User-signed `SET_OWNER` on an org env is refused (`NotOwnerError`). The JSON reducer string and `src` are brought in line, and `SET_OWNER` leaves the spec-sync `KNOWN_DRIFT` list.
7. **Vetra-side hand-over is vetted.** vetra.io never dispatches `SET_OWNER_ORG` itself: it calls the observability mutation `setEnvironmentOrg(environmentId, orgId)` (caller must operate the personal env and be `PUBLISHER`+ in the org; app-linked envs follow their app and are refused). `myEnvironments(scope: ORG, orgId)` lists rows with that `ownerOrgId` for members (and admins); `MINE` now lists only personal envs (`ownerOrgId IS NULL`).
8. **Document permissions.** Owned envs are protected at reactor-api (protection reconciler), so the sync grants `WRITE` to each operator and `READ` to members who call `syncEnvironmentOrg` without operating, and revokes them when they no longer qualify. Grants Vetra made are tracked in the observability table `org_document_grants`; Vetra only ever revokes grants it recorded and never touches the env `owner`'s own grant (its `ADMIN` would be downgraded by `grantPermission`). Known limit: a creator who left the org keeps read access to the env document through the protection owner; writes and every subgraph operation are refused.
9. **Tenant admins unchanged.** The deployed tenant's `ADMINS` (gitops `switchboardAuthEnv`) and Speckle `allowedSubjects` stay the env `owner`. Org-wide access inside a tenant's own Connect/Switchboard is the spec's "org grants in reactor-api" follow-up (§8).
10. **Apps.** `apps.owner_org_id varchar(255) NULL` (+ index). `owner_address` stays the creator (history, GitHub connection). `myApps` = personal apps (`owner_org_id IS NULL`); `myApps(orgId)` = org apps, members only. Reads (`app`, `appDeployments`, `appDeployment`) need `canView`; every other owner-level call needs `canOperate`. `createApp(input.orgId)` requires `OWNER`/`ADMIN`, or `PUBLISHER` with `effectiveScope.all` (the new app's DID does not exist yet); admins get no bypass for creating inside an org. It registers the workload with `ownerOrgId` and dispatches `SET_OWNER_ORG {orgId, [caller]}` on the production env. Previews copy the production env's `ownerOrgId` and operators.
11. **Lazy ownership sync.** On every app read path, `syncAppOrg` reads `appProfile(appDid) { publisherDid publisherOrg { id } }` (cached): person→org sets `owner_org_id`; org→org changes it; org→person sets `owner_org_id = NULL` and `owner_address` = the profile's `did:pkh` address. Each changes the app's envs with system `SET_OWNER(new person)` (org→person only) and `SET_OWNER_ORG(newOrg | null, [])` (operators refill through the sync). `myApps(orgId)` first adopts every app DID listed in `organization(orgId).apps`. A personal app is never moved to another *person* (only an org transfer does that).
12. **CI and identity for org apps.** A CI token acts for an org app only when its address has publisher capability for the app now (the creator included: leaving the org stops their CI tokens); a personal app keeps the owner rule. `confirmAppIdentity` on an org app checks the *caller's* delegation (any operator may authorise the identity), on a personal app the owner's.
13. **Licensing.** `resolveOwnerApp` uses `canOperate` (same opaque "no such app" for a refusal). `vetraPublisher.myApps` lists personal apps only (`owner_org_id IS NULL`); `vetraPublisher.myApps(orgId)` lists that org's apps for callers who operate them. No licence, template or term behaviour changes.
14. **Profile relay.** `updateAppProfile` gains `supportContact` and `securityContact`; for an org app the relay also sends `publisherOrgId = owner_org_id` (Renown accepts it on the first claim and when it equals the existing org). The mutation text declares only the arguments being sent, so a write without them works against any Renown. Renown `APP_FROZEN` maps to code `APP_FROZEN` with "This app is frozen by its organisation."
15. **No package bump for vetra.io.** No new action creator is used client-side; vetra.io talks to the new GraphQL fields only.

## Global Constraints

- Worktree `/home/f/projects/vetra-cloud-package-orgs`, branch `feat/organisations` (from `origin/main`). Rollout: `dev` → `-dev.N` build → staging tenant → `main` → prod (Task 9). Never main-first.
- Conventional commits (`feat(orgs): …`, `fix(…)`, `test(…)`); **no `Co-Authored-By` or "Generated with" lines** in commits or PR descriptions.
- **Never edit `gen/`.** reactor-mcp is not available: the environment model changes by editing `document-models/vetra-cloud-environment/vetra-cloud-environment.json` and running `npx ph-cli generate document-model -d document-models/vetra-cloud-environment/vetra-cloud-environment.json`. Codegen may rewrite `document-models/index.ts`, `document-models/document-models.ts`, `document-models/upgrade-manifests.ts`, `powerhouse.manifest.json` and inject imports into hand-written tests: restore every file outside `v1/gen/`, `v1/schema.graphql` and the JSON with `git checkout -- <file>` unless the task lists it. Never run `generate all`. Never empty `subgraphs/index.ts`.
- The JSON reducer string of every touched operation is contained (whitespace-insensitive) in `v1/src/reducers/data-management.ts` — `document-models/vetra-app/v1/tests/spec-sync.test.ts` enforces it.
- Reducers are pure and synchronous; reducer errors are tested through `operations.global[i].error`, never `.toThrow()`. Reducer coverage ≥ 95 % lines/branches/functions/statements (`npm run test:coverage`); never lower the threshold or exclude files.
- DB migrations are forward-only and idempotent (`ifNotExists()`, `addColumn` wrapped in try/catch). Never drop or rename a production table or column.
- Relative imports carry `.js`; no `@/` alias.
- QA after every task (per `CLAUDE.md`): `npm run tsc 2>&1 | tail -5`, `npm run lint:fix 2>&1 | tail -5`, the task's tests with `npx vitest run <files> 2>&1 | grep -E "Test Files|Tests |FAIL"`; after Task 2 also `npm run test:coverage 2>&1 | grep -E "All files|ERROR"`. Before Task 9: `npx vitest run 2>&1 | grep -E "Test Files|Tests |FAIL"`.
- New env vars default safely: `RENOWN_ORGS_ENDPOINT` (default `<RENOWN_SWITCHBOARD_URL or https://switchboard.renown.vetra.io>/graphql/renown-orgs`), `RENOWN_STATS_URL` (existing; default for lookups `<same origin>/graphql/renown-stats`).
- Error strings in observability stay plain `Error` messages as today (`UNAUTHENTICATED`, `FORBIDDEN`, `ENV_NOT_FOUND`, plus new `ORG_ID_REQUIRED`, `ALREADY_ORG_OWNED`, `APP_ENVIRONMENT`); vetra-apps uses `appsError` codes; licensing keeps its contract codes.

## Review Focus

1. **Renown unreachable while a member works.** Expected: org members are refused (`FORBIDDEN` / opaque "no such app"), personal owners and admins are unaffected, and neither the sync job nor the lazy app sync changes any document, grant or row. Pinned in Task 1 ("never caches a failure"), Task 5 ("leaves everything as it is when Renown is down") and Task 6 ("keeps ownership when the publisher lookup fails").
2. **A member is removed or demoted.** Expected: after the cache window their subgraph calls are refused; the next sync drops them from `orgOperators` and revokes the `WRITE` grant Vetra gave, without touching the env owner's grant. Pinned in Task 5 ("drops a removed operator and revokes only grants it made").
3. **The creator of an org environment left the org.** Expected: their user-signed actions are rejected by the reducer although `state.owner` is still them, they cannot re-point or clear `ownerOrgId`, and they cannot use observability mutations. Pinned in Task 2 ("refuses the creator once the env belongs to an org") and Task 4 ("refuses the creator of an org env who is no longer a publisher").
4. **Legacy environment documents without the new fields** (replayed in production). Expected: personal semantics unchanged; an org-owned legacy state with no `orgOperators` refuses every user signer instead of crashing. Pinned in Task 2 ("treats a missing operator list as empty").
5. **An org app transferred out to a person at Renown.** Expected: on the next read the app row and every env move to the recipient (`owner`, `ownerOrgId = null`), the recipient operates it, the former creator does not. Pinned in Task 6 ("follows a transfer out to a person").

---

## File Structure

| Path | Responsibility |
| --- | --- |
| `shared/renown-orgs.ts` (+ `.test.ts`) | Renown client: `membership`, `orgApps`, `appPublisher`; `TtlLru`; config; process singleton (Task 1) |
| `shared/org-access.ts` (+ `.test.ts`) | `hasPublisherCapability`, `canOperate`, `canView`, `isOrgMember`, `canCreateOrgApp` (Task 1) |
| `document-models/vetra-cloud-environment/vetra-cloud-environment.json`, `v1/src/reducers/{data-management,utils}.ts`, `v1/tests/org-ownership.test.ts` | model fields and ops, `assertOwner` (Task 2) |
| `document-models/vetra-app/v1/tests/spec-sync.test.ts` | drop `SET_OWNER` from `KNOWN_DRIFT` (Task 2) |
| `processors/vetra-cloud-environment/{schema,migrations,processor}.ts`, `read-model.test.ts` | `ownerOrgId`, `orgOperators` columns (Task 3) |
| `subgraphs/vetra-cloud-observability/env-access.ts` (+ test) | env access checks with app-DID lookup (Task 4) |
| `subgraphs/vetra-cloud-observability/{resolvers,schema,restart,package-registry}.ts`, `dumps/resolvers.ts` | owner checks → `canOperate`, `myEnvironments(ORG)` (Task 4) |
| `subgraphs/vetra-cloud-observability/org-sync.ts` (+ test), `db/{schema,migrations}.ts`, `index.ts` | operator sync, grants, job, `syncEnvironmentOrg`, `setEnvironmentOrg` (Task 5) |
| `subgraphs/vetra-apps/{db/schema,db/migrations,org-ownership,service,resolvers,schema,renown,index}.ts`, `__tests__/{harness,org-apps}.test.ts` | org-owned apps (Tasks 6–7) |
| `subgraphs/vetra-licensing/{publisher-auth,owner-apps,publisher-resolvers,publisher-schema,renown-profile,index}.ts` (+ tests) | `canOperate`, org app lists, relay fields (Task 8) |

Setup for every task: `cd /home/f/projects/vetra-cloud-package-orgs && git switch feat/organisations && pnpm install --frozen-lockfile 2>&1 | tail -2`. Baseline: `npx vitest run 2>&1 | grep -E "Test Files|Tests "` all passing.

---

### Task 1: Renown orgs client and access predicates

**Files:**
- Create: `shared/renown-orgs.ts`, `shared/renown-orgs.test.ts`, `shared/org-access.ts`, `shared/org-access.test.ts`

**Interfaces:**
- Consumes: Renown `orgMembership(orgId, address) { role status effectiveScope { all appDids } }`, `organization(id) { id archived takenDown apps { appDid } }`, renown-stats `appProfile(appDid) { publisherDid publisherOrg { id } }`.
- Produces (`shared/renown-orgs.ts`): `type OrgRole = "OWNER" | "ADMIN" | "PUBLISHER" | "MEMBER"`; `interface OrgScope { all: boolean; appDids: string[] }`; `interface OrgMembership { role: OrgRole; effectiveScope: OrgScope }`; `interface AppPublisher { orgId: string | null; address: string | null }`; `class RenownOrgsUnavailableError extends Error`; `interface RenownOrgs { membership(orgId: string, address: string): Promise<OrgMembership | null>; orgApps(orgId: string): Promise<string[] | null>; appPublisher(appDid: string): Promise<AppPublisher | null> }`; `interface RenownOrgsConfig { orgsEndpoint; statsEndpoint; fetch?; now?: () => number; timeoutMs?; positiveTtlMs?; negativeTtlMs?; maxEntries?; logger? }`; `renownOrgsConfigFromEnv(env?)`; `createRenownOrgs(cfg): RenownOrgs`; `defaultRenownOrgs(): RenownOrgs`; `class TtlLru<V>`.
- Produces (`shared/org-access.ts`): `interface AccessCaller { address: string; isAdmin: boolean }`; `interface OwnedResource { owner: string | null; ownerOrgId?: string | null; appDid?: string | null }`; `type MembershipReader = Pick<RenownOrgs, "membership">`; `hasPublisherCapability(m: OrgMembership | null, appDid?: string | null): boolean`; `canOperate(orgs: MembershipReader | null, caller: AccessCaller, r: OwnedResource): Promise<boolean>`; `canView(orgs, caller, r): Promise<boolean>`; `isOrgMember(orgs, caller, orgId): Promise<boolean>` (admins: true); `canCreateOrgApp(orgs, caller, orgId): Promise<boolean>` (no admin bypass).

- [ ] **Step 1: Write the failing client tests**

`shared/renown-orgs.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  TtlLru,
  createRenownOrgs,
  renownOrgsConfigFromEnv,
  RenownOrgsUnavailableError,
} from "./renown-orgs.js";

const ORG = "org-1";
const ALICE = "0xAaAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

type Answer = { data?: unknown; errors?: { message: string }[] } | Error | { status: number };

function client(answers: Answer[], clock = { t: 0 }) {
  const calls: { url: string; body: { query: string; variables: Record<string, unknown> } }[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(init.body as string) });
    const next = answers.shift();
    if (!next) throw new Error("unexpected request");
    if (next instanceof Error) throw next;
    if ("status" in next) return new Response("nope", { status: next.status });
    return new Response(JSON.stringify(next), { status: 200, headers: { "content-type": "application/json" } });
  });
  const orgs = createRenownOrgs({
    orgsEndpoint: "https://renown.test/graphql/renown-orgs",
    statsEndpoint: "https://renown.test/graphql/renown-stats",
    fetch: fetchImpl as unknown as typeof fetch,
    now: () => clock.t,
    logger: { warn: vi.fn() },
  });
  return { orgs, calls, clock };
}

const member = (role = "PUBLISHER", all = true, appDids: string[] = []) => ({
  data: { orgMembership: { role, status: "ACTIVE", effectiveScope: { all, appDids } } },
});

describe("renown orgs client", () => {
  it("asks orgMembership with a lowercased address and caches the answer for 30 s", async () => {
    const { orgs, calls, clock } = client([member(), member("ADMIN")]);
    expect(await orgs.membership(ORG, ALICE)).toStrictEqual({ role: "PUBLISHER", effectiveScope: { all: true, appDids: [] } });
    expect(calls[0].url).toBe("https://renown.test/graphql/renown-orgs");
    expect(calls[0].body.variables).toStrictEqual({ orgId: ORG, address: ALICE.toLowerCase() });
    clock.t = 29_999;
    expect((await orgs.membership(ORG, ALICE.toLowerCase()))?.role).toBe("PUBLISHER");
    expect(calls).toHaveLength(1);
    clock.t = 30_000;
    expect((await orgs.membership(ORG, ALICE))?.role).toBe("ADMIN");
    expect(calls).toHaveLength(2);
  });

  it("caches a missing membership for 10 s only", async () => {
    const { orgs, calls, clock } = client([{ data: { orgMembership: null } }, member()]);
    expect(await orgs.membership(ORG, ALICE)).toBeNull();
    clock.t = 9_999;
    expect(await orgs.membership(ORG, ALICE)).toBeNull();
    clock.t = 10_000;
    expect(await orgs.membership(ORG, ALICE)).not.toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("never caches a failure (network, HTTP status, GraphQL errors)", async () => {
    const { orgs, calls } = client([
      new Error("ECONNREFUSED"),
      { status: 502 },
      { errors: [{ message: "boom" }] },
      member(),
    ]);
    for (let i = 0; i < 3; i++) {
      await expect(orgs.membership(ORG, ALICE)).rejects.toBeInstanceOf(RenownOrgsUnavailableError);
    }
    expect((await orgs.membership(ORG, ALICE))?.role).toBe("PUBLISHER");
    expect(calls).toHaveLength(4);
  });

  it("shares one request between concurrent identical lookups", async () => {
    const { orgs, calls } = client([member()]);
    const [a, b] = await Promise.all([orgs.membership(ORG, ALICE), orgs.membership(ORG, ALICE)]);
    expect(a).toStrictEqual(b);
    expect(calls).toHaveLength(1);
  });

  it("lists an organisation's app DIDs; unknown, archived or taken-down orgs have none", async () => {
    const { orgs } = client([
      { data: { organization: { id: ORG, archived: false, takenDown: false, apps: [{ appDid: "did:key:a" }] } } },
      { data: { organization: null } },
      { data: { organization: { id: "o3", archived: true, takenDown: false, apps: [] } } },
    ]);
    expect(await orgs.orgApps(ORG)).toStrictEqual(["did:key:a"]);
    expect(await orgs.orgApps("o2")).toBeNull();
    expect(await orgs.orgApps("o3")).toBeNull();
  });

  it("reads an app's publisher from renown-stats", async () => {
    const { orgs, calls } = client([
      { data: { appProfile: { publisherDid: "did:web:www.renown.id:org:o1", publisherOrg: { id: "o1" } } } },
      { data: { appProfile: { publisherDid: `did:pkh:eip155:1:${ALICE}`, publisherOrg: null } } },
      { data: { appProfile: null } },
    ]);
    expect(await orgs.appPublisher("did:key:a")).toStrictEqual({ orgId: "o1", address: null });
    expect(calls[0].url).toBe("https://renown.test/graphql/renown-stats");
    expect(await orgs.appPublisher("did:key:b")).toStrictEqual({ orgId: null, address: ALICE.toLowerCase() });
    expect(await orgs.appPublisher("did:key:c")).toBeNull();
  });

  it("evicts the least recently used entry", () => {
    const lru = new TtlLru<number>(2);
    lru.set("a", 1, 1000, 0);
    lru.set("b", 2, 1000, 0);
    expect(lru.get("a", 1)?.value).toBe(1);
    lru.set("c", 3, 1000, 0);
    expect(lru.get("b", 1)).toBeUndefined();
    expect(lru.get("a", 1)?.value).toBe(1);
    expect(lru.get("a", 1000)).toBeUndefined();
  });

  it("derives both endpoints from RENOWN_SWITCHBOARD_URL unless overridden", () => {
    expect(renownOrgsConfigFromEnv({})).toMatchObject({
      orgsEndpoint: "https://switchboard.renown.vetra.io/graphql/renown-orgs",
      statsEndpoint: "https://switchboard.renown.vetra.io/graphql/renown-stats",
    });
    expect(renownOrgsConfigFromEnv({ RENOWN_SWITCHBOARD_URL: "https://sb.staging/graphql/" })).toMatchObject({
      orgsEndpoint: "https://sb.staging/graphql/renown-orgs",
    });
    expect(
      renownOrgsConfigFromEnv({ RENOWN_ORGS_ENDPOINT: " https://x/orgs ", RENOWN_STATS_URL: "https://x/stats" }),
    ).toMatchObject({ orgsEndpoint: "https://x/orgs", statsEndpoint: "https://x/stats" });
  });
});
```

- [ ] **Step 2: Write the failing access tests**

`shared/org-access.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { canCreateOrgApp, canOperate, canView, hasPublisherCapability, isOrgMember } from "./org-access.js";
import { RenownOrgsUnavailableError, type OrgMembership } from "./renown-orgs.js";

const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const APP = "did:key:zApp";
const m = (role: OrgMembership["role"], all = true, appDids: string[] = []): OrgMembership => ({
  role,
  effectiveScope: { all, appDids },
});
const orgsWith = (membership: OrgMembership | null | Error) => ({
  membership: vi.fn(async () => {
    if (membership instanceof Error) throw membership;
    return membership;
  }),
});
const user = (address: string) => ({ address, isAdmin: false });
const admin = { address: BOB, isAdmin: true };

describe("hasPublisherCapability", () => {
  it("ranks roles and applies the app scope to publishers only", () => {
    expect(hasPublisherCapability(m("OWNER", false), APP)).toBe(true);
    expect(hasPublisherCapability(m("ADMIN", false), APP)).toBe(true);
    expect(hasPublisherCapability(m("PUBLISHER", true), APP)).toBe(true);
    expect(hasPublisherCapability(m("PUBLISHER", false, [APP]), APP)).toBe(true);
    expect(hasPublisherCapability(m("PUBLISHER", false, ["did:key:other"]), APP)).toBe(false);
    expect(hasPublisherCapability(m("PUBLISHER", false, []), null)).toBe(true);
    expect(hasPublisherCapability(m("MEMBER"), null)).toBe(false);
    expect(hasPublisherCapability(null, null)).toBe(false);
  });
});

describe("canOperate / canView", () => {
  it("personal resources: owner (any case) and admins; nobody asks Renown", async () => {
    const orgs = orgsWith(m("OWNER"));
    expect(await canOperate(orgs, user(OWNER), { owner: OWNER.toUpperCase().replace("0X", "0x"), ownerOrgId: null })).toBe(true);
    expect(await canOperate(orgs, user(BOB), { owner: OWNER })).toBe(false);
    expect(await canOperate(orgs, admin, { owner: OWNER })).toBe(true);
    expect(await canOperate(orgs, user(OWNER), { owner: null })).toBe(false);
    expect(await canView(orgs, user(OWNER), { owner: OWNER })).toBe(true);
    expect(orgs.membership).not.toHaveBeenCalled();
  });

  it("org resources: publisher capability operates, any member views, the creator gets nothing for being the owner", async () => {
    const r = { owner: OWNER, ownerOrgId: "o1", appDid: APP };
    expect(await canOperate(orgsWith(m("PUBLISHER", false, [APP])), user(BOB), r)).toBe(true);
    expect(await canOperate(orgsWith(m("MEMBER")), user(BOB), r)).toBe(false);
    expect(await canView(orgsWith(m("MEMBER")), user(BOB), r)).toBe(true);
    expect(await canOperate(orgsWith(null), user(OWNER), r)).toBe(false);
    expect(await canView(orgsWith(null), user(OWNER), r)).toBe(false);
    expect(await canOperate(orgsWith(null), admin, r)).toBe(true);
  });

  it("fails closed when Renown is unreachable or not configured", async () => {
    const r = { owner: OWNER, ownerOrgId: "o1" };
    const down = orgsWith(new RenownOrgsUnavailableError("down"));
    expect(await canOperate(down, user(BOB), r)).toBe(false);
    expect(await canView(down, user(BOB), r)).toBe(false);
    expect(await canOperate(null, user(BOB), r)).toBe(false);
    expect(await isOrgMember(down, user(BOB), "o1")).toBe(false);
    expect(await isOrgMember(down, admin, "o1")).toBe(true);
  });
});

describe("canCreateOrgApp", () => {
  it("needs OWNER/ADMIN or a publisher with access to all apps; admins get no bypass", async () => {
    expect(await canCreateOrgApp(orgsWith(m("ADMIN", false)), user(BOB), "o1")).toBe(true);
    expect(await canCreateOrgApp(orgsWith(m("PUBLISHER", true)), user(BOB), "o1")).toBe(true);
    expect(await canCreateOrgApp(orgsWith(m("PUBLISHER", false, [APP])), user(BOB), "o1")).toBe(false);
    expect(await canCreateOrgApp(orgsWith(m("MEMBER")), user(BOB), "o1")).toBe(false);
    expect(await canCreateOrgApp(orgsWith(null), admin, "o1")).toBe(false);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run shared/renown-orgs.test.ts shared/org-access.test.ts 2>&1 | grep -E "Test Files|Tests |FAIL"`
Expected: FAIL (modules not found).

- [ ] **Step 4: Implement `shared/renown-orgs.ts`**

```ts
/**
 * Renown organisations, as Vetra needs them (spec §6, A1 appendix "Vetra (C)").
 * Public reads only: orgMembership and organization(id) on renown-orgs,
 * appProfile on renown-stats. Every failure throws RenownOrgsUnavailableError
 * and is never cached, so callers can fail closed (org-access.ts) or leave
 * state untouched (sync jobs).
 */
export type OrgRole = "OWNER" | "ADMIN" | "PUBLISHER" | "MEMBER";
export interface OrgScope {
  all: boolean;
  appDids: string[];
}
export interface OrgMembership {
  role: OrgRole;
  effectiveScope: OrgScope;
}
/** An app's Renown publisher: an organisation, or a person's address. */
export interface AppPublisher {
  orgId: string | null;
  address: string | null;
}

export class RenownOrgsUnavailableError extends Error {
  override name = "RenownOrgsUnavailableError";
}

export interface RenownOrgs {
  /** The ACTIVE membership of `address`, or null (none, archived or taken-down org). */
  membership(orgId: string, address: string): Promise<OrgMembership | null>;
  /** App DIDs attached to the org; null for an unknown, archived or taken-down org. */
  orgApps(orgId: string): Promise<string[] | null>;
  /** The app's publisher per its Renown profile; null when it has no profile. */
  appPublisher(appDid: string): Promise<AppPublisher | null>;
}

export interface RenownOrgsConfig {
  orgsEndpoint: string;
  statsEndpoint: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  positiveTtlMs?: number;
  negativeTtlMs?: number;
  maxEntries?: number;
  logger?: Pick<Console, "warn">;
}

/** A small LRU whose entries expire. `get` refreshes recency. */
export class TtlLru<V> {
  private readonly map = new Map<string, { value: V; expiresAt: number }>();
  constructor(private readonly max: number) {}

  get(key: string, now: number): { value: V } | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    this.map.delete(key);
    if (entry.expiresAt <= now) return undefined;
    this.map.set(key, entry);
    return { value: entry.value };
  }

  set(key: string, value: V, ttlMs: number, now: number): void {
    this.map.delete(key);
    this.map.set(key, { value, expiresAt: now + ttlMs });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}

const MEMBERSHIP = `query VetraOrgMembership($orgId: String!, $address: String!) {
  orgMembership(orgId: $orgId, address: $address) { role status effectiveScope { all appDids } }
}`;
const ORG_APPS = `query VetraOrgApps($id: String!) {
  organization(id: $id) { id archived takenDown apps { appDid } }
}`;
const APP_PUBLISHER = `query VetraAppPublisher($appDid: String!) {
  appProfile(appDid: $appDid) { publisherDid publisherOrg { id } }
}`;

const PKH = /^did:pkh:eip155:\d+:(0x[0-9a-fA-F]{40})$/;

type Env = Record<string, string | undefined>;

export function renownOrgsConfigFromEnv(env: Env = process.env): RenownOrgsConfig {
  const origin = (env.RENOWN_SWITCHBOARD_URL?.trim() || "https://switchboard.renown.vetra.io")
    .replace(/\/+$/, "")
    .replace(/\/graphql$/, "");
  return {
    orgsEndpoint: env.RENOWN_ORGS_ENDPOINT?.trim() || `${origin}/graphql/renown-orgs`,
    statsEndpoint: env.RENOWN_STATS_URL?.trim() || `${origin}/graphql/renown-stats`,
  };
}

export function createRenownOrgs(cfg: RenownOrgsConfig): RenownOrgs {
  const fetchImpl = cfg.fetch ?? fetch;
  const now = cfg.now ?? Date.now;
  const timeoutMs = cfg.timeoutMs ?? 5_000;
  const positiveTtl = cfg.positiveTtlMs ?? 30_000;
  const negativeTtl = cfg.negativeTtlMs ?? 10_000;
  const logger = cfg.logger ?? console;
  const cache = new TtlLru<unknown>(cfg.maxEntries ?? 2_000);
  const inflight = new Map<string, Promise<unknown>>();

  async function post<T>(endpoint: string, query: string, variables: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new RenownOrgsUnavailableError(`network: ${err instanceof Error ? err.message : String(err)}`);
    }
    const body = (await res.json().catch(() => null)) as {
      data?: T | null;
      errors?: { message?: string }[];
    } | null;
    if (!res.ok || !body || body.errors?.length || !body.data) {
      const message = body?.errors?.[0]?.message;
      throw new RenownOrgsUnavailableError(`HTTP ${res.status}${message ? `: ${message}` : ""}`);
    }
    return body.data;
  }

  function cached<V>(key: string, load: () => Promise<V>): Promise<V> {
    const hit = cache.get(key, now());
    if (hit) return Promise.resolve(hit.value as V);
    const pending = inflight.get(key);
    if (pending) return pending as Promise<V>;
    const request = load()
      .then((value) => {
        cache.set(key, value, value === null ? negativeTtl : positiveTtl, now());
        return value;
      })
      .catch((err: unknown) => {
        logger.warn(`[renown-orgs] ${key} failed: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, request);
    return request;
  }

  return {
    membership(orgId, address) {
      const addr = address.toLowerCase();
      return cached(`m|${orgId}|${addr}`, async () => {
        const data = await post<{
          orgMembership: { role: OrgRole; status: string; effectiveScope: OrgScope } | null;
        }>(cfg.orgsEndpoint, MEMBERSHIP, { orgId, address: addr });
        const m = data.orgMembership;
        return m && m.status === "ACTIVE"
          ? { role: m.role, effectiveScope: { all: m.effectiveScope.all, appDids: m.effectiveScope.appDids } }
          : null;
      });
    },
    orgApps(orgId) {
      return cached(`a|${orgId}`, async () => {
        const data = await post<{
          organization: { archived: boolean; takenDown: boolean; apps: { appDid: string }[] } | null;
        }>(cfg.orgsEndpoint, ORG_APPS, { id: orgId });
        const org = data.organization;
        return org && !org.archived && !org.takenDown ? org.apps.map((a) => a.appDid) : null;
      });
    },
    appPublisher(appDid) {
      return cached(`p|${appDid}`, async () => {
        const data = await post<{
          appProfile: { publisherDid: string | null; publisherOrg: { id: string } | null } | null;
        }>(cfg.statsEndpoint, APP_PUBLISHER, { appDid });
        const profile = data.appProfile;
        if (!profile) return null;
        if (profile.publisherOrg) return { orgId: profile.publisherOrg.id, address: null };
        const pkh = PKH.exec(profile.publisherDid ?? "");
        return { orgId: null, address: pkh ? pkh[1].toLowerCase() : null };
      });
    },
  };
}

let shared: RenownOrgs | null = null;

/** One client (and cache) per process, shared by every subgraph. */
export function defaultRenownOrgs(): RenownOrgs {
  shared ??= createRenownOrgs(renownOrgsConfigFromEnv());
  return shared;
}
```

- [ ] **Step 5: Implement `shared/org-access.ts`**

```ts
import type { OrgMembership, RenownOrgs } from "./renown-orgs.js";

export interface AccessCaller {
  /** Lowercased address. */
  address: string;
  isAdmin: boolean;
}

/** An environment or app: personal when ownerOrgId is null. */
export interface OwnedResource {
  owner: string | null;
  ownerOrgId?: string | null;
  /** For app-linked resources: the app's Renown DID (publisher scope). */
  appDid?: string | null;
}

export type MembershipReader = Pick<RenownOrgs, "membership">;

/** OWNER/ADMIN always; PUBLISHER when the scope covers appDid (or there is no app). */
export function hasPublisherCapability(m: OrgMembership | null, appDid?: string | null): boolean {
  if (!m) return false;
  if (m.role === "OWNER" || m.role === "ADMIN") return true;
  if (m.role !== "PUBLISHER") return false;
  return !appDid || m.effectiveScope.all || m.effectiveScope.appDids.includes(appDid);
}

/** The caller's membership, or null; a Renown failure is "no membership" (fail closed). */
async function membershipOf(
  orgs: MembershipReader | null,
  orgId: string,
  address: string,
): Promise<OrgMembership | null> {
  if (!orgs) return null;
  try {
    return await orgs.membership(orgId, address);
  } catch {
    return null;
  }
}

export async function canOperate(
  orgs: MembershipReader | null,
  caller: AccessCaller,
  r: OwnedResource,
): Promise<boolean> {
  if (caller.isAdmin) return true;
  if (!r.ownerOrgId) return !!r.owner && r.owner.toLowerCase() === caller.address.toLowerCase();
  return hasPublisherCapability(await membershipOf(orgs, r.ownerOrgId, caller.address), r.appDid);
}

export async function canView(
  orgs: MembershipReader | null,
  caller: AccessCaller,
  r: OwnedResource,
): Promise<boolean> {
  if (caller.isAdmin) return true;
  if (!r.ownerOrgId) return !!r.owner && r.owner.toLowerCase() === caller.address.toLowerCase();
  return (await membershipOf(orgs, r.ownerOrgId, caller.address)) !== null;
}

export async function isOrgMember(
  orgs: MembershipReader | null,
  caller: AccessCaller,
  orgId: string,
): Promise<boolean> {
  if (caller.isAdmin) return true;
  return (await membershipOf(orgs, orgId, caller.address)) !== null;
}

/** Creating an app in an org: the new app's DID is not in anyone's list yet. */
export async function canCreateOrgApp(
  orgs: MembershipReader | null,
  caller: AccessCaller,
  orgId: string,
): Promise<boolean> {
  const m = await membershipOf(orgs, orgId, caller.address);
  if (!m) return false;
  return m.role === "OWNER" || m.role === "ADMIN" || (m.role === "PUBLISHER" && m.effectiveScope.all);
}
```

- [ ] **Step 6: Run the tests, types and lint**

Run: `npx vitest run shared/renown-orgs.test.ts shared/org-access.test.ts 2>&1 | grep -E "Test Files|Tests |FAIL"` → all pass.
Run: `npm run tsc 2>&1 | tail -5 && npm run lint:fix 2>&1 | tail -5` → clean.

- [ ] **Step 7: Commit**

```bash
git add shared/renown-orgs.ts shared/renown-orgs.test.ts shared/org-access.ts shared/org-access.test.ts
git commit -m "feat(orgs): Renown organisations client with fail-closed access checks"
```

---

### Task 2: Environment model — `ownerOrgId`, `orgOperators`, `SET_OWNER_ORG`, `SYNC_ORG_OPERATORS`, `assertOwner`

**Files:**
- Modify: `document-models/vetra-cloud-environment/vetra-cloud-environment.json`
- Modify: `document-models/vetra-cloud-environment/v1/src/reducers/data-management.ts`, `v1/src/reducers/utils.ts`
- Modify: `document-models/vetra-app/v1/tests/spec-sync.test.ts` (remove `"vetra-cloud-environment SET_OWNER",` from `KNOWN_DRIFT`)
- Generated: `document-models/vetra-cloud-environment/v1/gen/**`, `v1/schema.graphql`
- Test: `document-models/vetra-cloud-environment/v1/tests/org-ownership.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `VetraCloudEnvironmentState.ownerOrgId?: Maybe<string>`, `.orgOperators: string[]`; action creators `setOwnerOrg({ ownerOrgId: string | null, operators: string[] })` and `syncOrgOperators({ operators: string[] })` (from `document-models/vetra-cloud-environment/v1` and `v1/gen/creators.js`); action types `"SET_OWNER_ORG"`, `"SYNC_ORG_OPERATORS"`; errors `OrgOwnedError`, `OrgSyncSystemOnlyError`, `NotOrgOwnedError`; `normalizeOperators(list: readonly string[]): string[]` in `v1/src/reducers/utils.ts`.

- [ ] **Step 1: Edit the spec JSON**

Run this script once from the worktree root (it asserts the anchors, so a second run fails loudly):

```bash
python3 - <<'PY'
import json, pathlib
p = pathlib.Path("document-models/vetra-cloud-environment/vetra-cloud-environment.json")
d = json.loads(p.read_text())
s = d["specifications"][-1]
g = s["state"]["global"]
anchor = "  owner: EthereumAddress\n"
assert g["schema"].count(anchor) == 1 and "ownerOrgId" not in g["schema"]
g["schema"] = g["schema"].replace(
    anchor,
    anchor + "  ownerOrgId: String\n  orgOperators: [EthereumAddress!]!\n",
)
iv, out = json.loads(g["initialValue"]), {}
for k, v in iv.items():
    out[k] = v
    if k == "owner":
        out["ownerOrgId"] = None
        out["orgOperators"] = []
g["initialValue"] = json.dumps(out, indent=2)

dm = next(m for m in s["modules"] if m["name"] == "data_management")
ops = dm["operations"]
set_owner = next(o for o in ops if o["name"] == "SET_OWNER")
set_owner["description"] = (
    "Claim or transfer ownership. A user-signed claim of an unowned env must set the signer's own "
    "address; a user-signed transfer needs the current owner and is refused on organisation "
    "environments. System-signed actions may set any address (backfill, app transfers)."
)
set_owner["reducer"] = (
    "const userAddr = action.context?.signer?.user?.address?.toLowerCase() ?? null;\n"
    "const inputAddr = action.input.address.toLowerCase();\n"
    "if (userAddr && state.ownerOrgId) {\n"
    "  throw new NotOwnerError(\"The owner of an organisation environment changes through Vetra\");\n"
    "}\n"
    "if (state.owner) {\n"
    "  if (userAddr && userAddr !== state.owner) {\n"
    "    throw new NotOwnerError(\"Only the current owner can transfer ownership\");\n"
    "  }\n"
    "} else if (userAddr && userAddr !== inputAddr) {\n"
    "  throw new SelfClaimRequiredError(\"A user-signed claim must set the signer's own address as owner\");\n"
    "}\n"
    "state.owner = inputAddr;"
)
assert not any(o["name"] in ("SET_OWNER_ORG", "SYNC_ORG_OPERATORS") for o in ops)
idx = ops.index(set_owner) + 1
ops[idx:idx] = [
    {
        "id": "op-set-owner-org",
        "name": "SET_OWNER_ORG",
        "description": (
            "Hand the environment to a Renown organisation (or, system-signed, change or clear it). "
            "System-signed: sets ownerOrgId and operators as given. User-signed: only the current owner, "
            "only while the env is personal; the signer becomes the only operator."
        ),
        "schema": "input SetOwnerOrgInput {\n  ownerOrgId: String\n  operators: [EthereumAddress!]!\n}",
        "template": "",
        "reducer": (
            "const userAddr = action.context?.signer?.user?.address?.toLowerCase() ?? null;\n"
            "if (userAddr) {\n"
            "  if (!state.owner || userAddr !== state.owner) {\n"
            "    throw new NotOwnerError(\"Only the current owner can hand this environment to an organisation\");\n"
            "  }\n"
            "  if (state.ownerOrgId) {\n"
            "    throw new OrgOwnedError(\"An organisation environment changes organisation only through Vetra\");\n"
            "  }\n"
            "}\n"
            "state.ownerOrgId = action.input.ownerOrgId || null;\n"
            "if (!state.ownerOrgId) {\n"
            "  state.orgOperators = [];\n"
            "} else {\n"
            "  state.orgOperators = userAddr ? [userAddr] : normalizeOperators(action.input.operators);\n"
            "}"
        ),
        "errors": [
            {"id": "err-not-owner-set-owner-org", "name": "NotOwnerError", "code": "NOT_OWNER",
             "description": "The action signer is not the current owner of this environment", "template": ""},
            {"id": "err-org-owned", "name": "OrgOwnedError", "code": "ORG_OWNED",
             "description": "A user may only hand a personal environment to an organisation", "template": ""},
        ],
        "examples": [],
        "scope": "global",
    },
    {
        "id": "op-sync-org-operators",
        "name": "SYNC_ORG_OPERATORS",
        "description": (
            "Replace the addresses allowed to sign on an organisation environment. System-only: written "
            "by the observability subgraph's operator sync from Renown memberships."
        ),
        "schema": "input SyncOrgOperatorsInput {\n  operators: [EthereumAddress!]!\n}",
        "template": "",
        "reducer": (
            "const userAddr = action.context?.signer?.user?.address;\n"
            "if (userAddr) {\n"
            "  throw new OrgSyncSystemOnlyError(\n"
            "    `OrgSyncSystemOnly: SYNC_ORG_OPERATORS can only be dispatched by the system, not by ${userAddr.toLowerCase()}`,\n"
            "  );\n"
            "}\n"
            "if (!state.ownerOrgId) {\n"
            "  throw new NotOrgOwnedError(\"This environment does not belong to an organisation\");\n"
            "}\n"
            "state.orgOperators = normalizeOperators(action.input.operators);"
        ),
        "errors": [
            {"id": "err-org-sync-system-only", "name": "OrgSyncSystemOnlyError", "code": "ORG_SYNC_SYSTEM_ONLY",
             "description": "OrgSyncSystemOnly: operators are only synced by the system", "template": ""},
            {"id": "err-not-org-owned", "name": "NotOrgOwnedError", "code": "NOT_ORG_OWNED",
             "description": "The environment does not belong to an organisation", "template": ""},
        ],
        "examples": [],
        "scope": "global",
    },
]
p.write_text(json.dumps(d, indent=2, ensure_ascii=False))
PY
```

(The file has no trailing newline today; `json.dumps(..., indent=2, ensure_ascii=False)` reproduces its formatting byte for byte.)

- [ ] **Step 2: Regenerate and restore side effects**

Run: `npx ph-cli generate document-model -d document-models/vetra-cloud-environment/vetra-cloud-environment.json 2>&1 | tail -5`
Then: `git status --short | grep -v "vetra-cloud-environment/v1/gen/\|vetra-cloud-environment/v1/schema.graphql\|vetra-cloud-environment.json"` and `git checkout -- <each listed file>` (expect `document-models/index.ts`, `document-models/document-models.ts`, `document-models/upgrade-manifests.ts`, `powerhouse.manifest.json`, test files with injected imports). The generator also rewrites `v1/src/reducers/data-management.ts` stubs if it adds missing methods: keep the existing file content and add only the methods of Step 4.
Expected: `grep -c "SET_OWNER_ORG\|SYNC_ORG_OPERATORS" document-models/vetra-cloud-environment/v1/gen/data-management/actions.ts` ≥ 2, and `v1/schema.graphql` contains `orgOperators: [EthereumAddress!]!`.

- [ ] **Step 3: Write the failing reducer tests**

`document-models/vetra-cloud-environment/v1/tests/org-ownership.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  reducer,
  utils,
  setOwner,
  setOwnerOrg,
  syncOrgOperators,
  setLabel,
} from "document-models/vetra-cloud-environment/v1";

const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CAROL = "0xcccccccccccccccccccccccccccccccccccccccc";
const ORG = "org-acme";

const signedBy = (address: string) => ({
  context: {
    signer: {
      user: { address, networkId: "eip155:1", chainId: 1 },
      app: { name: "test", key: "test" },
      signatures: [],
    },
  },
});
const lastError = (doc: { operations: { global: { error?: string }[] } }) =>
  doc.operations.global.at(-1)?.error;

/** An env owned by OWNER (system claim), optionally handed to ORG by the system. */
function ownedEnv(org?: { operators: string[] }) {
  let doc = reducer(utils.createDocument(), setOwner({ address: OWNER }));
  if (org) doc = reducer(doc, setOwnerOrg({ ownerOrgId: ORG, operators: org.operators }));
  return doc;
}

describe("organisation ownership", () => {
  it("starts personal", () => {
    const s = utils.createDocument().state.global;
    expect(s.ownerOrgId ?? null).toBeNull();
    expect(s.orgOperators).toStrictEqual([]);
  });

  it("lets the system hand an env to an org, normalising operators, and clear it again", () => {
    let doc = ownedEnv({ operators: [BOB.toUpperCase().replace("0X", "0x"), BOB, CAROL] });
    expect(lastError(doc)).toBeUndefined();
    expect(doc.state.global.ownerOrgId).toBe(ORG);
    expect(doc.state.global.orgOperators).toStrictEqual([BOB, CAROL]);
    doc = reducer(doc, setOwnerOrg({ ownerOrgId: null, operators: [BOB] }));
    expect(doc.state.global.ownerOrgId).toBeNull();
    expect(doc.state.global.orgOperators).toStrictEqual([]);
  });

  it("lets the owner hand a personal env over; the owner becomes the only operator", () => {
    const doc = reducer(ownedEnv(), { ...setOwnerOrg({ ownerOrgId: ORG, operators: [BOB, CAROL] }), ...signedBy(OWNER) });
    expect(lastError(doc)).toBeUndefined();
    expect(doc.state.global.orgOperators).toStrictEqual([OWNER]);
    expect(doc.state.global.status).toBe("DRAFT");
  });

  it("refuses a hand-over by a non-owner or on an unowned env", () => {
    let doc = reducer(ownedEnv(), { ...setOwnerOrg({ ownerOrgId: ORG, operators: [] }), ...signedBy(BOB) });
    expect(lastError(doc)).toMatch(/current owner/);
    expect(doc.state.global.ownerOrgId ?? null).toBeNull();
    doc = reducer(utils.createDocument(), { ...setOwnerOrg({ ownerOrgId: ORG, operators: [] }), ...signedBy(BOB) });
    expect(lastError(doc)).toMatch(/current owner/);
    expect(doc.state.global.owner).toBeNull();
  });

  it("refuses the creator once the env belongs to an org (no re-pointing, no clearing)", () => {
    for (const ownerOrgId of ["org-other", null]) {
      const doc = reducer(ownedEnv({ operators: [BOB] }), { ...setOwnerOrg({ ownerOrgId, operators: [OWNER] }), ...signedBy(OWNER) });
      expect(lastError(doc)).toMatch(/only through Vetra/);
      expect(doc.state.global.ownerOrgId).toBe(ORG);
    }
  });

  it("syncs operators from the system only, and only on org envs", () => {
    let doc = reducer(ownedEnv({ operators: [BOB] }), syncOrgOperators({ operators: [CAROL, CAROL] }));
    expect(doc.state.global.orgOperators).toStrictEqual([CAROL]);
    doc = reducer(doc, { ...syncOrgOperators({ operators: [OWNER] }), ...signedBy(CAROL) });
    expect(lastError(doc)).toMatch(/OrgSyncSystemOnly/);
    expect(doc.state.global.orgOperators).toStrictEqual([CAROL]);
    doc = reducer(ownedEnv(), syncOrgOperators({ operators: [BOB] }));
    expect(lastError(doc)).toMatch(/does not belong to an organisation/);
  });

  it("lets operators sign, refuses everyone else including the creator, and lets the system through", () => {
    let doc = reducer(ownedEnv({ operators: [BOB] }), { ...setLabel({ label: "by bob" }), ...signedBy(BOB) });
    expect(lastError(doc)).toBeUndefined();
    doc = reducer(doc, { ...setLabel({ label: "by owner" }), ...signedBy(OWNER) });
    expect(lastError(doc)).toMatch(/not an operator/);
    doc = reducer(doc, { ...setLabel({ label: "by carol" }), ...signedBy(CAROL) });
    expect(lastError(doc)).toMatch(/not an operator/);
    doc = reducer(doc, setLabel({ label: "by system" }));
    expect(doc.state.global.label).toBe("by system");
  });

  it("treats a missing operator list as empty (legacy replay)", () => {
    const doc = ownedEnv({ operators: [BOB] });
    delete (doc.state.global as unknown as Record<string, unknown>).orgOperators;
    const next = reducer(doc, { ...setLabel({ label: "x" }), ...signedBy(BOB) });
    expect(lastError(next)).toMatch(/not an operator/);
  });

  it("lets the system transfer an owned env, but not a user on an org env", () => {
    let doc = reducer(ownedEnv(), setOwner({ address: BOB }));
    expect(lastError(doc)).toBeUndefined();
    expect(doc.state.global.owner).toBe(BOB);
    doc = reducer(ownedEnv({ operators: [OWNER] }), { ...setOwner({ address: CAROL }), ...signedBy(OWNER) });
    expect(lastError(doc)).toMatch(/changes through Vetra/);
    expect(doc.state.global.owner).toBe(OWNER);
  });
});
```

Run: `npx vitest run document-models/vetra-cloud-environment/v1/tests/org-ownership.test.ts 2>&1 | grep -E "Test Files|Tests |FAIL"`
Expected: FAIL (reducers not implemented: `setOwnerOrgOperation is not a function` or wrong state).

- [ ] **Step 4: Implement the reducers**

In `v1/src/reducers/utils.ts`:
- Change the `assertOwner` signature and add the org branch at the top of its body:

```ts
export function assertOwner(
  state: {
    owner: string | null | undefined;
    ownerOrgId?: string | null;
    orgOperators?: readonly string[] | null;
  },
  action: MaybeSigner,
) {
  const userAddr = action.context?.signer?.user?.address?.toLowerCase();

  if (state.ownerOrgId) {
    // Organisation env: only the synced operators sign; the creator gets nothing
    // for being `owner` (derived revocation). System actions still pass.
    if (userAddr && !(state.orgOperators ?? []).includes(userAddr)) {
      throw new NotOwnerError(
        `Signer ${userAddr} is not an operator of this organisation environment`,
      );
    }
    return;
  }
  // …existing personal-env body unchanged…
}
```

- Append:

```ts
/** Lowercased, de-duplicated, order kept. */
export function normalizeOperators(list: readonly string[]): string[] {
  return [...new Set(list.map((a) => a.toLowerCase()))];
}
```

- Update the doc comment of `assertOwner` with one line: "Organisation env (ownerOrgId set): a user signer must be in orgOperators."

In `v1/src/reducers/data-management.ts`:
- import `NotOrgOwnedError`, `OrgOwnedError`, `OrgSyncSystemOnlyError` from `../../gen/data-management/error.js` and `normalizeOperators` from `./utils.js`;
- replace the body of `setOwnerOperation` with the exact `SET_OWNER` reducer string of Step 1;
- add, after `setOwnerOperation`, the two methods whose bodies are exactly the JSON reducer strings of Step 1:

```ts
    setOwnerOrgOperation(state, action) {
      const userAddr = action.context?.signer?.user?.address?.toLowerCase() ?? null;
      if (userAddr) {
        if (!state.owner || userAddr !== state.owner) {
          throw new NotOwnerError("Only the current owner can hand this environment to an organisation");
        }
        if (state.ownerOrgId) {
          throw new OrgOwnedError("An organisation environment changes organisation only through Vetra");
        }
      }
      state.ownerOrgId = action.input.ownerOrgId || null;
      if (!state.ownerOrgId) {
        state.orgOperators = [];
      } else {
        state.orgOperators = userAddr ? [userAddr] : normalizeOperators(action.input.operators);
      }
    },
    syncOrgOperatorsOperation(state, action) {
      const userAddr = action.context?.signer?.user?.address;
      if (userAddr) {
        throw new OrgSyncSystemOnlyError(
          `OrgSyncSystemOnly: SYNC_ORG_OPERATORS can only be dispatched by the system, not by ${userAddr.toLowerCase()}`,
        );
      }
      if (!state.ownerOrgId) {
        throw new NotOrgOwnedError("This environment does not belong to an organisation");
      }
      state.orgOperators = normalizeOperators(action.input.operators);
    },
```

(Use the method names the generated `VetraCloudEnvironmentDataManagementOperations` type declares; check `v1/gen/data-management/operations.ts`.)

In `document-models/vetra-app/v1/tests/spec-sync.test.ts` delete the line `"vetra-cloud-environment SET_OWNER",`.

- [ ] **Step 5: Run the model suites, spec sync and coverage**

Run: `npx vitest run document-models/vetra-cloud-environment document-models/vetra-app/v1/tests/spec-sync.test.ts 2>&1 | grep -E "Test Files|Tests |FAIL"` → all pass (existing `data-management.test.ts` SET_OWNER tests still pass: none asserts that a system transfer of an owned env fails).
Run: `npm run test:coverage 2>&1 | grep -E "All files|ERROR"` → every column ≥ 95.
Run: `npm run tsc 2>&1 | tail -5 && npm run lint:fix 2>&1 | tail -5` → clean (`subgraphs/vetra-apps/__tests__/harness.ts` and other callers of `assertOwner`-gated ops compile unchanged).

- [ ] **Step 6: Commit**

```bash
git add document-models/vetra-cloud-environment document-models/vetra-app/v1/tests/spec-sync.test.ts
git commit -m "feat(orgs): organisation ownership on vetra-cloud-environment (SET_OWNER_ORG, SYNC_ORG_OPERATORS)"
```

---

### Task 3: Read-model columns `ownerOrgId` and `orgOperators`

**Files:**
- Modify: `processors/vetra-cloud-environment/schema.ts`, `migrations.ts`, `processor.ts`
- Test: `processors/vetra-cloud-environment/read-model.test.ts`

**Interfaces:**
- Consumes: `VetraCloudEnvironmentState.ownerOrgId`, `.orgOperators` (Task 2).
- Produces: columns `environments.ownerOrgId varchar(255) NULL`, `environments.orgOperators text NULL` (JSON array of lowercased addresses); `orgColumns(state: { ownerOrgId?: string | null; orgOperators?: readonly string[] | null }): { ownerOrgId: string | null; orgOperators: string }` exported from `processor.ts`.

- [ ] **Step 1: Write the failing tests** — append to `read-model.test.ts` (import `orgColumns` next to `appLinkColumns`):

```ts
describe("environments read model — organisation columns", () => {
  it("adds ownerOrgId / orgOperators (idempotently)", async () => {
    const db = new Kysely<DB>({ dialect: new PGliteDialect(new PGlite()) });
    await up(db as Kysely<any>);
    await up(db as Kysely<any>);
    await db
      .insertInto("environments")
      .values({ id: "e1", ownerOrgId: "org-1", orgOperators: '["0xabc"]' } as never)
      .execute();
    const row = await db
      .selectFrom("environments")
      .select(["ownerOrgId", "orgOperators"])
      .where("id", "=", "e1")
      .executeTakeFirstOrThrow();
    expect(row).toStrictEqual({ ownerOrgId: "org-1", orgOperators: '["0xabc"]' });
    await db.destroy();
  });

  it("maps the state to the columns; personal and legacy states map to NULL and []", () => {
    expect(orgColumns({ ownerOrgId: "org-1", orgOperators: ["0xabc"] })).toStrictEqual({
      ownerOrgId: "org-1",
      orgOperators: '["0xabc"]',
    });
    expect(orgColumns({ ownerOrgId: null, orgOperators: [] })).toStrictEqual({ ownerOrgId: null, orgOperators: "[]" });
    expect(orgColumns({})).toStrictEqual({ ownerOrgId: null, orgOperators: "[]" });
  });
});
```

Run: `npx vitest run processors/vetra-cloud-environment/read-model.test.ts 2>&1 | grep -E "Tests |FAIL"` → FAIL.

- [ ] **Step 2: Implement**

`schema.ts` — in `Environments`, after `owner`:

```ts
  /** Renown organisation id owning this env (state.ownerOrgId), else NULL. */
  ownerOrgId: string | null;
  /** JSON array of lowercased addresses allowed to sign (state.orgOperators). */
  orgOperators: string | null;
```

`migrations.ts` — before the warm-pool index block:

```ts
  // Renown organisation ownership (state.ownerOrgId / state.orgOperators).
  for (const [column, type] of [
    ["ownerOrgId", "varchar(255)"],
    ["orgOperators", "text"],
  ] as const) {
    try {
      await db.schema.alterTable("environments").addColumn(column, type).execute();
    } catch {
      // Column already exists
    }
  }
  await db.schema
    .createIndex("environments_owner_org_idx")
    .on("environments")
    .column("ownerOrgId")
    .ifNotExists()
    .execute();
```

`processor.ts` — next to `appLinkColumns`:

```ts
/** Read-model columns mirroring organisation ownership. */
export function orgColumns(state: {
  ownerOrgId?: string | null;
  orgOperators?: readonly string[] | null;
}): { ownerOrgId: string | null; orgOperators: string } {
  return {
    ownerOrgId: state.ownerOrgId ?? null,
    orgOperators: JSON.stringify(state.orgOperators ?? []),
  };
}
```

and add `...orgColumns(state),` to the `row` object after `...appLinkColumns(state),`. (`SYNC_ORG_OPERATORS` leaves `status` unchanged, so it never triggers a gitops sync.)

- [ ] **Step 3: Run tests, types, lint** — `npx vitest run processors/vetra-cloud-environment 2>&1 | grep -E "Test Files|Tests |FAIL"` (golden gitops tests unchanged), `npm run tsc 2>&1 | tail -5`, `npm run lint:fix 2>&1 | tail -5`.

- [ ] **Step 4: Commit**

```bash
git add processors/vetra-cloud-environment
git commit -m "feat(orgs): mirror environment organisation ownership in the read model"
```

---

### Task 4: Observability — `canOperate` at every owner check, `myEnvironments(scope: ORG)`

**Files:**
- Create: `subgraphs/vetra-cloud-observability/env-access.ts`, `subgraphs/vetra-cloud-observability/__tests__/env-access.test.ts`, `subgraphs/vetra-cloud-observability/__tests__/org-environments.test.ts`
- Modify: `subgraphs/vetra-cloud-observability/resolvers.ts` (`ResolverConfig.access`, `myEnvironments`, `setCustomDomain`, `updateEnvironmentToLatest`, `rollbackEnvironmentRelease`), `schema.ts`, `restart.ts`, `package-registry.ts`, `dumps/resolvers.ts`, `index.ts`
- Modify (test helpers): `__tests__/my-environments.test.ts` (`createEnvTable` gains the two columns)

**Interfaces:**
- Consumes: `canOperate`, `canView`, `isOrgMember`, `MembershipReader`, `AccessCaller` (Task 1); columns from Task 3.
- Produces (`env-access.ts`): `interface EnvAccessRow { owner: string | null; ownerOrgId?: string | null; appId?: string | null }`; `interface EnvAccess { canOperate(caller: AccessCaller, env: EnvAccessRow): Promise<boolean>; canView(caller: AccessCaller, env: EnvAccessRow): Promise<boolean>; isMember(caller: AccessCaller, orgId: string): Promise<boolean> }`; `createEnvAccess(deps: { orgs: MembershipReader | null; appDidOf(appId: string): Promise<string | null> }): EnvAccess`; `OWNER_ONLY_ACCESS: EnvAccess`; `appDidLookup(appsDb: Kysely<any>): (appId: string) => Promise<string | null>`; `parseOperators(raw: string | null | undefined): string[]`. `ResolverConfig.access?: EnvAccess` (default `OWNER_ONLY_ACCESS`), same optional field on `RestartResolverDeps`, `PackageRegistryResolverDeps`, `DumpResolverDeps`. GraphQL: `enum ListScope { MINE, ALL, ORG }`, `myEnvironments(scope: ListScope = MINE, orgId: String)`, `VetraCloudEnvironmentSummary.ownerOrgId: String`, `.orgOperators: [String!]!`.

- [ ] **Step 1: Write the failing `env-access` tests**

`__tests__/env-access.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { appDidLookup, createEnvAccess, OWNER_ONLY_ACCESS, parseOperators } from "../env-access.js";

const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const bob = { address: BOB, isAdmin: false };

describe("env access", () => {
  it("checks an app-linked org env against the app's DID", async () => {
    const membership = vi.fn(async () => ({ role: "PUBLISHER" as const, effectiveScope: { all: false, appDids: ["did:key:shop"] } }));
    const appDidOf = vi.fn(async (id: string) => (id === "app-shop" ? "did:key:shop" : "did:key:blog"));
    const access = createEnvAccess({ orgs: { membership }, appDidOf });
    expect(await access.canOperate(bob, { owner: OWNER, ownerOrgId: "o1", appId: "app-shop" })).toBe(true);
    expect(await access.canOperate(bob, { owner: OWNER, ownerOrgId: "o1", appId: "app-blog" })).toBe(false);
    expect(await access.canOperate(bob, { owner: OWNER, ownerOrgId: "o1", appId: null })).toBe(true);
    expect(appDidOf).toHaveBeenCalledTimes(2);
  });

  it("owner-only access knows no organisations", async () => {
    expect(await OWNER_ONLY_ACCESS.canOperate({ address: OWNER, isAdmin: false }, { owner: OWNER })).toBe(true);
    expect(await OWNER_ONLY_ACCESS.canOperate(bob, { owner: OWNER, ownerOrgId: "o1" })).toBe(false);
    expect(await OWNER_ONLY_ACCESS.isMember(bob, "o1")).toBe(false);
  });

  it("reads an app's identity DID from the vetra-apps namespace", async () => {
    const db = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
    await db.schema.createTable("apps").addColumn("id", "varchar(64)").addColumn("identity_did", "varchar(255)").execute();
    await db.insertInto("apps").values({ id: "app-1", identity_did: "did:key:one" }).execute();
    const lookup = appDidLookup(db);
    expect(await lookup("app-1")).toBe("did:key:one");
    expect(await lookup("nope")).toBeNull();
    await db.destroy();
  });

  it("parses the operators column defensively", () => {
    expect(parseOperators('["0xa","0xb"]')).toStrictEqual(["0xa", "0xb"]);
    expect(parseOperators(null)).toStrictEqual([]);
    expect(parseOperators("not json")).toStrictEqual([]);
    expect(parseOperators('{"a":1}')).toStrictEqual([]);
  });
});
```

- [ ] **Step 2: Write the failing resolver tests**

First add to `createEnvTable` in `__tests__/my-environments.test.ts` (before `.ifNotExists()`):

```ts
    .addColumn("ownerOrgId", "varchar(255)")
    .addColumn("orgOperators", "text")
```

`__tests__/org-environments.test.ts` (copy the PGlite setup of `my-environments.test.ts`: `createEnvTable` with the two new columns, `seedEnv` gaining `ownerOrgId?: string | null; orgOperators?: string[]`, written as `ownerOrgId: env.ownerOrgId ?? null, orgOperators: JSON.stringify(env.orgOperators ?? [])`):

```ts
const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CAROL = "0xcccccccccccccccccccccccccccccccccccccccc";
const members: Record<string, { role: "OWNER" | "ADMIN" | "PUBLISHER" | "MEMBER"; effectiveScope: { all: boolean; appDids: string[] } }> = {
  [`o1|${BOB}`]: { role: "PUBLISHER", effectiveScope: { all: true, appDids: [] } },
  [`o1|${CAROL}`]: { role: "MEMBER", effectiveScope: { all: false, appDids: [] } },
};
const access = createEnvAccess({
  orgs: { membership: async (orgId, address) => members[`${orgId}|${address}`] ?? null },
  appDidOf: async () => null,
});
const ctx = (address: string) => ({ user: { address } });

function resolvers(dispatch = vi.fn(async () => undefined)) {
  return createResolvers(db, { prometheusUrl: "http://p", lokiUrl: "http://l", envDb, dispatch, access });
}

describe("myEnvironments ORG scope", () => {
  beforeEach(async () => {
    await seedEnv({ id: "personal", owner: OWNER });
    await seedEnv({ id: "org-env", owner: OWNER, ownerOrgId: "o1", orgOperators: [BOB] });
    await seedEnv({ id: "other-org", owner: BOB, ownerOrgId: "o2", orgOperators: [BOB] });
  });

  it("MINE lists only personal environments, even for the creator of an org env", async () => {
    const rows = await resolvers().Query.myEnvironments(null, { scope: "MINE" }, ctx(OWNER));
    expect(rows.map((r: { id: string }) => r.id)).toStrictEqual(["personal"]);
  });

  it("ORG lists the org's environments for any member, with parsed operators", async () => {
    for (const who of [BOB, CAROL]) {
      const rows = await resolvers().Query.myEnvironments(null, { scope: "ORG", orgId: "o1" }, ctx(who));
      expect(rows.map((r: { id: string }) => r.id)).toStrictEqual(["org-env"]);
      expect(rows[0]).toMatchObject({ ownerOrgId: "o1", orgOperators: [BOB] });
    }
  });

  it("ORG refuses non-members (the creator included) and needs an orgId", async () => {
    await expect(resolvers().Query.myEnvironments(null, { scope: "ORG", orgId: "o1" }, ctx(OWNER))).rejects.toThrow("FORBIDDEN");
    await expect(resolvers().Query.myEnvironments(null, { scope: "ORG" }, ctx(BOB))).rejects.toThrow("ORG_ID_REQUIRED");
  });
});

describe("owner checks on org environments", () => {
  beforeEach(async () => {
    await seedEnv({ id: "org-env", owner: OWNER, ownerOrgId: "o1", orgOperators: [BOB] });
  });

  it("lets a publisher set the custom domain", async () => {
    const dispatch = vi.fn(async () => undefined);
    await resolvers(dispatch).Mutation.setCustomDomain(null, { documentId: "org-env", enabled: false }, ctx(BOB));
    expect(dispatch).toHaveBeenCalledWith("org-env", "SET_CUSTOM_DOMAIN", { enabled: false, domain: null });
  });

  it("refuses the creator of an org env who is no longer a publisher, and plain members", async () => {
    for (const who of [OWNER, CAROL]) {
      await expect(
        resolvers().Mutation.setCustomDomain(null, { documentId: "org-env", enabled: false }, ctx(who)),
      ).rejects.toThrow("FORBIDDEN");
    }
  });
});
```

(Imports: `createResolvers` from `../resolvers.js`, `createEnvAccess` from `../env-access.js`, plus the PGlite/Kysely imports and `up` from `../db/migrations.js` as in `my-environments.test.ts`.)

Run: `npx vitest run subgraphs/vetra-cloud-observability/__tests__/env-access.test.ts subgraphs/vetra-cloud-observability/__tests__/org-environments.test.ts 2>&1 | grep -E "Tests |FAIL"` → FAIL.

- [ ] **Step 3: Implement `env-access.ts`**

```ts
import type { Kysely } from "kysely";
import {
  canOperate,
  canView,
  isOrgMember,
  type AccessCaller,
  type MembershipReader,
} from "../../shared/org-access.js";

/** The environments-row fields access depends on. */
export interface EnvAccessRow {
  owner: string | null;
  ownerOrgId?: string | null;
  appId?: string | null;
}

export interface EnvAccess {
  canOperate(caller: AccessCaller, env: EnvAccessRow): Promise<boolean>;
  canView(caller: AccessCaller, env: EnvAccessRow): Promise<boolean>;
  isMember(caller: AccessCaller, orgId: string): Promise<boolean>;
}

export function createEnvAccess(deps: {
  orgs: MembershipReader | null;
  appDidOf(appId: string): Promise<string | null>;
}): EnvAccess {
  const resource = async (env: EnvAccessRow) => ({
    owner: env.owner,
    ownerOrgId: env.ownerOrgId ?? null,
    // The app DID only matters for org envs (publisher scope).
    appDid: env.ownerOrgId && env.appId ? await deps.appDidOf(env.appId) : null,
  });
  return {
    canOperate: async (caller, env) => canOperate(deps.orgs, caller, await resource(env)),
    canView: async (caller, env) => canView(deps.orgs, caller, await resource(env)),
    isMember: (caller, orgId) => isOrgMember(deps.orgs, caller, orgId),
  };
}

/** Default for hosts and tests without Renown: org environments are admin-only. */
export const OWNER_ONLY_ACCESS: EnvAccess = createEnvAccess({ orgs: null, appDidOf: async () => null });

/** apps.identity_did by apps.id in the vetra-apps namespace. */
export function appDidLookup(appsDb: Kysely<any>): (appId: string) => Promise<string | null> {
  return async (appId) => {
    const row = (await appsDb
      .selectFrom("apps")
      .select("identity_did")
      .where("id", "=", appId)
      .executeTakeFirst()) as { identity_did: string | null } | undefined;
    return row?.identity_did ?? null;
  };
}

/** The orgOperators column (JSON text) as a list; anything unexpected is []. */
export function parseOperators(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Wire the checks**

`resolvers.ts`:
- `ResolverConfig` gains `/** Org-aware access checks; default: owner/admin only. */ access?: EnvAccess;` and `createResolvers` reads `const access = config.access ?? OWNER_ONLY_ACCESS;`.
- `myEnvironments`: signature `{ scope, orgId }: { scope?: "MINE" | "ALL" | "ORG" | null; orgId?: string | null }`; add `"ownerOrgId", "orgOperators"` to the select list; replace the `rows` computation with:

```ts
        let rows;
        if (scope === "ORG") {
          const org = orgId?.trim();
          if (!org) throw new Error("ORG_ID_REQUIRED");
          if (!(await access.isMember({ address: userAddress, isAdmin }, org))) throw new Error("FORBIDDEN");
          rows = await query.where("ownerOrgId", "=", org).execute();
        } else if (wantAll && isAdmin) {
          rows = await query.execute();
        } else {
          // Personal envs only: org envs are listed under their organisation.
          rows = await query
            .where("ownerOrgId", "is", null)
            .where((eb) => eb.or([eb("owner", "=", userAddress), eb("owner", "is", null)]))
            .execute();
        }
```

  and add `orgOperators: parseOperators(row.orgOperators as string | null),` to the mapped row.
- `setCustomDomain`, `updateEnvironmentToLatest`, `rollbackEnvironmentRelease`: add `"ownerOrgId", "appId"` to each `envRow` select (and to the row types) and replace each `isOwner`/`isAdmin` pair with:

```ts
        if (!(await access.canOperate({ address: callerAddress, isAdmin }, envRow))) {
          throw new Error("FORBIDDEN");
        }
```

- Pass `access` into `createDumpResolvers({ ...config.dumpDeps, access })` (when `dumpDeps` is set), `createRestartResolver(config.restartDeps && { ...config.restartDeps, access })` and `createPackageRegistryResolver({ envDb, dispatch, access })` (keep however each is wired today; add the field).

`restart.ts` / `package-registry.ts`: deps types gain `access?: EnvAccess`; selects gain `"ownerOrgId", "appId"`; the owner check becomes `if (!(await (deps.access ?? OWNER_ONLY_ACCESS).canOperate({ address: caller, isAdmin }, envRow))) throw new Error("FORBIDDEN");`.

`dumps/resolvers.ts`: `EnvRow` and `loadEnv` select gain `ownerOrgId`, `appId`; `DumpResolverDeps` gains `access?: EnvAccess`; add

```ts
/** Dumps keep their stricter rule: no admin bypass. Org envs: publisher capability. */
async function authorizeDump(access: EnvAccess, ctx: Caller, env: EnvRow | null): Promise<void> {
  const caller = ctx.user?.address?.toLowerCase() ?? null;
  if (env?.ownerOrgId) {
    if (!caller) throw new Error("UNAUTHENTICATED");
    if (!(await access.canOperate({ address: caller, isAdmin: false }, env))) throw new Error("FORBIDDEN");
    return;
  }
  requireOwner({ caller, envOwner: env?.owner ?? null });
}
```

  and replace every `requireOwner({...})` call in the resolvers with `await authorizeDump(deps.access ?? OWNER_ONLY_ACCESS, ctx, env);`.

`schema.ts`: `enum ListScope { MINE, ALL, ORG }`; `myEnvironments(scope: ListScope = MINE, "Required with scope ORG" orgId: String): [VetraCloudEnvironmentSummary!]!` with the doc block extended by "- With scope=ORG: environments of organisation `orgId`; active members (and admins) only."; on `VetraCloudEnvironmentSummary` add `"""Renown organisation owning this environment; null for personal environments."""\n    ownerOrgId: String` and `"""Addresses allowed to sign on an organisation environment (lowercased)."""\n    orgOperators: [String!]!`.

`index.ts` (`onSetup`): after `envDb`:

```ts
    // Organisation access: Renown memberships + app DIDs from the vetra-apps namespace.
    const appsDb = (await this.relationalDb.createNamespace("vetra-apps")) as unknown as Kysely<any>;
    const access = createEnvAccess({ orgs: defaultRenownOrgs(), appDidOf: appDidLookup(appsDb) });
```

pass `access` into `createResolvers(db, { …, access })` and `restartDeps = { envDb, k8s, access }`, and add `access` to the object `buildDumpDeps` returns (or spread it in when calling `createResolvers`). Imports: `createEnvAccess`, `appDidLookup` from `./env-access.js`, `defaultRenownOrgs` from `../../shared/renown-orgs.js`.

- [ ] **Step 5: Run the observability suite, types, lint**

Run: `npx vitest run subgraphs/vetra-cloud-observability 2>&1 | grep -E "Test Files|Tests |FAIL"` → all pass (stub-based restart/registry/dumps tests keep passing: their rows have no `ownerOrgId`, so personal rules apply).
Run: `npm run tsc 2>&1 | tail -5 && npm run lint:fix 2>&1 | tail -5`.

- [ ] **Step 6: Commit**

```bash
git add subgraphs/vetra-cloud-observability
git commit -m "feat(orgs): organisation-aware environment access and myEnvironments ORG scope"
```

---

### Task 5: Operator sync — job, grants, `syncEnvironmentOrg`, `setEnvironmentOrg`

**Files:**
- Create: `subgraphs/vetra-cloud-observability/org-sync.ts`, `subgraphs/vetra-cloud-observability/__tests__/org-sync.test.ts`
- Modify: `subgraphs/vetra-cloud-observability/db/schema.ts`, `db/migrations.ts` (table `org_document_grants`), `resolvers.ts` (two mutations), `schema.ts`, `index.ts` (5-minute job)

**Interfaces:**
- Consumes: `hasPublisherCapability`, `MembershipReader` (Task 1); `EnvAccess`, `parseOperators` (Task 4); actions `SYNC_ORG_OPERATORS`, `SET_OWNER_ORG` (Task 2).
- Produces (`org-sync.ts`): `interface DocumentGrants { grantPermission(documentId: string, userAddress: string, permission: "READ" | "WRITE" | "ADMIN", grantedBy: string): Promise<unknown>; revokePermission(documentId: string, userAddress: string): Promise<void> }`; `interface OrgSyncDeps { envDb: Kysely<any>; db: Kysely<ObservabilityDB>; orgs: MembershipReader; appDidOf(appId: string): Promise<string | null>; dispatch(documentId: string, type: string, input: Record<string, unknown>): Promise<void>; perm: DocumentGrants | null; logger?: Pick<Console, "info" | "warn"> }`; `interface OrgEnvRow { id: string; owner: string | null; ownerOrgId: string | null; orgOperators: string | null; appId: string | null }`; `syncEnvironmentOrgOnce(deps, env: OrgEnvRow, candidates?: string[]): Promise<{ result: "UPDATED" | "UNCHANGED" | "SKIPPED"; operators: string[] }>`; `grantViewer(deps, env: OrgEnvRow, address: string): Promise<void>`; `runOrgSyncOnce(deps): Promise<number>`. `ResolverConfig.orgSync?: OrgSyncDeps`. GraphQL: `type EnvironmentOrgAccess { environmentId: String! ownerOrgId: String canOperate: Boolean! canView: Boolean! }`, `Mutation.syncEnvironmentOrg(environmentId: String!): EnvironmentOrgAccess!`, `Mutation.setEnvironmentOrg(environmentId: String!, orgId: String!): EnvironmentOrgAccess!`.

- [ ] **Step 1: Add the grants table**

`db/schema.ts` — add to `ObservabilityDB`:

```ts
  /** Document permissions Vetra granted for organisation access (revoked only by Vetra). */
  org_document_grants: {
    documentId: string;
    address: string;
    /** READ | WRITE */
    level: string;
    grantedAt: string;
  };
```

`db/migrations.ts` — append to `up`:

```ts
  await db.schema
    .createTable("org_document_grants")
    .addColumn("documentId", "varchar(255)", (c) => c.notNull())
    .addColumn("address", "varchar(255)", (c) => c.notNull())
    .addColumn("level", "varchar(16)", (c) => c.notNull())
    .addColumn("grantedAt", "varchar(64)", (c) => c.notNull())
    .addPrimaryKeyConstraint("org_document_grants_pkey", ["documentId", "address"])
    .ifNotExists()
    .execute();
```

- [ ] **Step 2: Write the failing sync tests**

`__tests__/org-sync.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import type { ObservabilityDB } from "../db/schema.js";
import { grantViewer, runOrgSyncOnce, syncEnvironmentOrgOnce, type OrgSyncDeps, type OrgEnvRow } from "../org-sync.js";
import { RenownOrgsUnavailableError, type OrgMembership } from "../../../shared/renown-orgs.js";

const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CAROL = "0xcccccccccccccccccccccccccccccccccccccccc";

let db: Kysely<ObservabilityDB>;
let envDb: Kysely<any>;
let members: Map<string, OrgMembership>;
let down: boolean;
let deps: OrgSyncDeps;
let perm: { grantPermission: ReturnType<typeof vi.fn>; revokePermission: ReturnType<typeof vi.fn> };
let dispatch: ReturnType<typeof vi.fn>;

const publisher: OrgMembership = { role: "PUBLISHER", effectiveScope: { all: true, appDids: [] } };
const plain: OrgMembership = { role: "MEMBER", effectiveScope: { all: false, appDids: [] } };

async function seed(env: Partial<OrgEnvRow> & { id: string }) {
  await envDb.insertInto("environments").values({
    id: env.id,
    owner: env.owner ?? OWNER,
    ownerOrgId: env.ownerOrgId ?? null,
    orgOperators: env.orgOperators ?? "[]",
    appId: env.appId ?? null,
  }).execute();
}
const row = async (id: string) =>
  (await envDb.selectFrom("environments").selectAll().where("id", "=", id).executeTakeFirstOrThrow()) as OrgEnvRow;
const grants = async () => db.selectFrom("org_document_grants").select(["documentId", "address", "level"]).orderBy("address").execute();

beforeEach(async () => {
  db = new Kysely<ObservabilityDB>({ dialect: new PGliteDialect(new PGlite()) });
  await up(db);
  envDb = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
  await envDb.schema.createTable("environments")
    .addColumn("id", "varchar(255)", (c) => c.primaryKey())
    .addColumn("owner", "varchar(255)").addColumn("ownerOrgId", "varchar(255)")
    .addColumn("orgOperators", "text").addColumn("appId", "varchar(255)").execute();
  members = new Map();
  down = false;
  perm = { grantPermission: vi.fn(async () => undefined), revokePermission: vi.fn(async () => undefined) };
  dispatch = vi.fn(async (id: string, _type: string, input: { operators: string[] }) => {
    await envDb.updateTable("environments").set({ orgOperators: JSON.stringify(input.operators) }).where("id", "=", id).execute();
  });
  deps = {
    envDb,
    db,
    orgs: {
      membership: async (orgId: string, address: string) => {
        if (down) throw new RenownOrgsUnavailableError("down");
        return members.get(`${orgId}|${address}`) ?? null;
      },
    },
    appDidOf: async () => null,
    dispatch,
    perm,
    logger: { info: vi.fn(), warn: vi.fn() },
  };
});
afterEach(async () => {
  await db.destroy();
  await envDb.destroy();
});

describe("operator sync", () => {
  it("adds a publisher candidate, grants WRITE, never touches the owner's grant", async () => {
    members.set(`o1|${BOB}`, publisher);
    members.set(`o1|${OWNER}`, publisher);
    await seed({ id: "e1", ownerOrgId: "o1" });
    const out = await syncEnvironmentOrgOnce(deps, await row("e1"), [BOB.toUpperCase().replace("0X", "0x")]);
    expect(out).toStrictEqual({ result: "UPDATED", operators: [OWNER, BOB] });
    expect(dispatch).toHaveBeenCalledWith("e1", "SYNC_ORG_OPERATORS", { operators: [OWNER, BOB] });
    expect(perm.grantPermission).toHaveBeenCalledTimes(1);
    expect(perm.grantPermission).toHaveBeenCalledWith("e1", BOB, "WRITE", "vetra-org-sync");
    expect(await grants()).toStrictEqual([{ documentId: "e1", address: BOB, level: "WRITE" }]);
  });

  it("drops a removed operator and revokes only grants it made", async () => {
    members.set(`o1|${BOB}`, publisher);
    await seed({ id: "e1", ownerOrgId: "o1", orgOperators: JSON.stringify([BOB, CAROL]) });
    await syncEnvironmentOrgOnce(deps, await row("e1"));
    members.delete(`o1|${BOB}`);
    perm.revokePermission.mockClear();
    const out = await syncEnvironmentOrgOnce(deps, await row("e1"));
    expect(out).toStrictEqual({ result: "UPDATED", operators: [] });
    // CAROL was never granted by Vetra: nothing to revoke for her.
    expect(perm.revokePermission.mock.calls).toStrictEqual([["e1", BOB]]);
    expect(await grants()).toStrictEqual([]);
  });

  it("respects the app scope of app-linked envs", async () => {
    members.set(`o1|${BOB}`, { role: "PUBLISHER", effectiveScope: { all: false, appDids: ["did:key:other"] } });
    await seed({ id: "e1", ownerOrgId: "o1", appId: "app-1" });
    const out = await syncEnvironmentOrgOnce({ ...deps, appDidOf: async () => "did:key:shop" }, await row("e1"), [BOB]);
    expect(out.operators).toStrictEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("leaves everything as it is when Renown is down", async () => {
    await seed({ id: "e1", ownerOrgId: "o1", orgOperators: JSON.stringify([BOB]) });
    down = true;
    const out = await syncEnvironmentOrgOnce(deps, await row("e1"), [CAROL]);
    expect(out).toStrictEqual({ result: "SKIPPED", operators: [BOB] });
    expect(dispatch).not.toHaveBeenCalled();
    expect(perm.grantPermission).not.toHaveBeenCalled();
    expect(perm.revokePermission).not.toHaveBeenCalled();
  });

  it("grants READ to a viewer and the job revokes it once they leave", async () => {
    members.set(`o1|${CAROL}`, plain);
    await seed({ id: "e1", ownerOrgId: "o1" });
    await grantViewer(deps, await row("e1"), CAROL);
    expect(perm.grantPermission).toHaveBeenCalledWith("e1", CAROL, "READ", "vetra-org-sync");
    members.delete(`o1|${CAROL}`);
    expect(await runOrgSyncOnce(deps)).toBe(1);
    expect(perm.revokePermission).toHaveBeenCalledWith("e1", CAROL);
    expect(await grants()).toStrictEqual([]);
  });

  it("skips personal envs and reports how many org envs it visited", async () => {
    await seed({ id: "p1" });
    await seed({ id: "e1", ownerOrgId: "o1" });
    await seed({ id: "e2", ownerOrgId: "o2" });
    expect(await runOrgSyncOnce(deps)).toBe(2);
  });
});
```

Run: `npx vitest run subgraphs/vetra-cloud-observability/__tests__/org-sync.test.ts 2>&1 | grep -E "Tests |FAIL"` → FAIL.

- [ ] **Step 3: Implement `org-sync.ts`**

```ts
import type { Kysely } from "kysely";
import type { ObservabilityDB } from "./db/schema.js";
import { hasPublisherCapability, type MembershipReader } from "../../shared/org-access.js";
import { parseOperators } from "./env-access.js";

/** The slice of reactor-api's DocumentPermissionService the sync uses. */
export interface DocumentGrants {
  grantPermission(documentId: string, userAddress: string, permission: "READ" | "WRITE" | "ADMIN", grantedBy: string): Promise<unknown>;
  revokePermission(documentId: string, userAddress: string): Promise<void>;
}

export interface OrgSyncDeps {
  envDb: Kysely<any>;
  db: Kysely<ObservabilityDB>;
  orgs: MembershipReader;
  appDidOf(appId: string): Promise<string | null>;
  dispatch(documentId: string, type: string, input: Record<string, unknown>): Promise<void>;
  perm: DocumentGrants | null;
  logger?: Pick<Console, "info" | "warn">;
}

export interface OrgEnvRow {
  id: string;
  owner: string | null;
  ownerOrgId: string | null;
  orgOperators: string | null;
  appId: string | null;
}

const GRANTED_BY = "vetra-org-sync";
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * Recompute the operators of one org env from Renown: every current operator,
 * every candidate and the creator are checked; those with publisher capability
 * (for the env's app, if any) stay. Any Renown failure → SKIPPED, nothing changes.
 */
export async function syncEnvironmentOrgOnce(
  deps: OrgSyncDeps,
  env: OrgEnvRow,
  candidates: string[] = [],
): Promise<{ result: "UPDATED" | "UNCHANGED" | "SKIPPED"; operators: string[] }> {
  const current = parseOperators(env.orgOperators);
  if (!env.ownerOrgId) return { result: "SKIPPED", operators: current };
  const appDid = env.appId ? await deps.appDidOf(env.appId) : null;
  const owner = env.owner?.toLowerCase() ?? null;
  const pool = [...new Set([...(owner ? [owner] : []), ...current, ...candidates.map((c) => c.toLowerCase())])];
  const next: string[] = [];
  for (const address of pool) {
    try {
      if (hasPublisherCapability(await deps.orgs.membership(env.ownerOrgId, address), appDid)) next.push(address);
    } catch {
      return { result: "SKIPPED", operators: current };
    }
  }
  const changed = !sameSet(current, next);
  if (changed) await deps.dispatch(env.id, "SYNC_ORG_OPERATORS", { operators: next });
  await reconcileWriteGrants(deps, env.id, owner, next);
  return { result: changed ? "UPDATED" : "UNCHANGED", operators: next };
}

async function reconcileWriteGrants(deps: OrgSyncDeps, envId: string, owner: string | null, operators: string[]) {
  if (!deps.perm) return;
  const rows = await deps.db.selectFrom("org_document_grants").selectAll().where("documentId", "=", envId).execute();
  const have = new Map(rows.map((r) => [r.address, r.level]));
  const now = new Date().toISOString();
  for (const address of operators) {
    // The owner's protection grant is ADMIN; granting WRITE would downgrade it.
    if (address === owner || have.get(address) === "WRITE") continue;
    await deps.perm.grantPermission(envId, address, "WRITE", GRANTED_BY);
    await deps.db
      .insertInto("org_document_grants")
      .values({ documentId: envId, address, level: "WRITE", grantedAt: now })
      .onConflict((oc) => oc.columns(["documentId", "address"]).doUpdateSet({ level: "WRITE", grantedAt: now }))
      .execute();
  }
  for (const r of rows) {
    if (r.level !== "WRITE" || operators.includes(r.address)) continue;
    if (r.address !== owner) await deps.perm.revokePermission(envId, r.address);
    await deps.db.deleteFrom("org_document_grants").where("documentId", "=", envId).where("address", "=", r.address).execute();
  }
}

/** READ for a member who views (but does not operate) an org env. */
export async function grantViewer(deps: OrgSyncDeps, env: OrgEnvRow, address: string): Promise<void> {
  const addr = address.toLowerCase();
  if (!deps.perm || addr === env.owner?.toLowerCase()) return;
  const existing = await deps.db
    .selectFrom("org_document_grants")
    .select("level")
    .where("documentId", "=", env.id)
    .where("address", "=", addr)
    .executeTakeFirst();
  if (existing) return;
  await deps.perm.grantPermission(env.id, addr, "READ", GRANTED_BY);
  await deps.db
    .insertInto("org_document_grants")
    .values({ documentId: env.id, address: addr, level: "READ", grantedAt: new Date().toISOString() })
    .execute();
}

/** READ grants of members who left; a Renown failure keeps the grant. */
async function revalidateViewers(deps: OrgSyncDeps, env: OrgEnvRow): Promise<void> {
  if (!deps.perm || !env.ownerOrgId) return;
  const viewers = await deps.db
    .selectFrom("org_document_grants")
    .select("address")
    .where("documentId", "=", env.id)
    .where("level", "=", "READ")
    .execute();
  for (const { address } of viewers) {
    let member: unknown;
    try {
      member = await deps.orgs.membership(env.ownerOrgId, address);
    } catch {
      continue;
    }
    if (member) continue;
    await deps.perm.revokePermission(env.id, address);
    await deps.db.deleteFrom("org_document_grants").where("documentId", "=", env.id).where("address", "=", address).execute();
  }
}

/** The 5-minute job: every org env. Returns how many it visited. */
export async function runOrgSyncOnce(deps: OrgSyncDeps): Promise<number> {
  const envs = (await deps.envDb
    .selectFrom("environments")
    .select(["id", "owner", "ownerOrgId", "orgOperators", "appId"])
    .where("ownerOrgId", "is not", null)
    .execute()) as OrgEnvRow[];
  for (const env of envs) {
    try {
      await syncEnvironmentOrgOnce(deps, env);
      await revalidateViewers(deps, env);
    } catch (err) {
      deps.logger?.warn(`[org-sync] ${env.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return envs.length;
}
```

- [ ] **Step 4: Add the mutations**

Add to `__tests__/org-environments.test.ts` (Task 4 file) a block driving the mutations through `createResolvers(db, { …, access, orgSync })` with `orgSync = { envDb, db, orgs, appDidOf: async () => null, dispatch, perm: null }`:

```ts
describe("syncEnvironmentOrg / setEnvironmentOrg", () => {
  it("syncs the caller in as operator and answers their access", async () => {
    await seedEnv({ id: "org-env", owner: OWNER, ownerOrgId: "o1", orgOperators: [] });
    const out = await resolversWithSync().Mutation.syncEnvironmentOrg(null, { environmentId: "org-env" }, ctx(BOB));
    expect(out).toStrictEqual({ environmentId: "org-env", ownerOrgId: "o1", canOperate: true, canView: true });
    expect(dispatch).toHaveBeenCalledWith("org-env", "SYNC_ORG_OPERATORS", { operators: [BOB] });
    const carol = await resolversWithSync().Mutation.syncEnvironmentOrg(null, { environmentId: "org-env" }, ctx(CAROL));
    expect(carol).toMatchObject({ canOperate: false, canView: true });
  });

  it("answers personal envs without touching Renown", async () => {
    await seedEnv({ id: "personal", owner: OWNER });
    expect(await resolversWithSync().Mutation.syncEnvironmentOrg(null, { environmentId: "personal" }, ctx(OWNER)))
      .toStrictEqual({ environmentId: "personal", ownerOrgId: null, canOperate: true, canView: true });
  });

  it("hands a personal env to an org for its owner when they publish there", async () => {
    await seedEnv({ id: "mine", owner: BOB });
    await resolversWithSync().Mutation.setEnvironmentOrg(null, { environmentId: "mine", orgId: "o1" }, ctx(BOB));
    expect(dispatch).toHaveBeenCalledWith("mine", "SET_OWNER_ORG", { ownerOrgId: "o1", operators: [BOB] });
  });

  it("refuses strangers, plain members, app envs and envs already in an org", async () => {
    await seedEnv({ id: "carols", owner: CAROL });
    await seedEnv({ id: "app-env", owner: BOB, appId: "app-1" });
    await seedEnv({ id: "org-env", owner: BOB, ownerOrgId: "o2" });
    const r = resolversWithSync().Mutation;
    await expect(r.setEnvironmentOrg(null, { environmentId: "carols", orgId: "o1" }, ctx(BOB))).rejects.toThrow("FORBIDDEN");
    await expect(r.setEnvironmentOrg(null, { environmentId: "carols", orgId: "o1" }, ctx(CAROL))).rejects.toThrow("FORBIDDEN");
    await expect(r.setEnvironmentOrg(null, { environmentId: "app-env", orgId: "o1" }, ctx(BOB))).rejects.toThrow("APP_ENVIRONMENT");
    await expect(r.setEnvironmentOrg(null, { environmentId: "org-env", orgId: "o1" }, ctx(BOB))).rejects.toThrow("ALREADY_ORG_OWNED");
  });
});
```

(`resolversWithSync()` = `createResolvers(db, { prometheusUrl: "http://p", lokiUrl: "http://l", envDb, dispatch, access, orgSync: { envDb, db, orgs: { membership: async (o, a) => members[`${o}|${a}`] ?? null }, appDidOf: async () => null, dispatch, perm: null } })` with a `dispatch = vi.fn(async () => undefined)` reset in `beforeEach`.)

Implement in `resolvers.ts` (`ResolverConfig.orgSync?: OrgSyncDeps`), inside `Mutation`:

```ts
      syncEnvironmentOrg: async (_p: unknown, { environmentId }: { environmentId: string }, ctx: AuthAwareContext) => {
        const caller = ctx.user?.address?.toLowerCase();
        if (!caller) throw new Error("UNAUTHENTICATED");
        const isAdmin = callerIsAdmin(ctx, caller);
        const env = (await envDb
          .selectFrom("environments")
          .select(["id", "owner", "ownerOrgId", "orgOperators", "appId"])
          .where("id", "=", environmentId)
          .executeTakeFirst()) as OrgEnvRow | undefined;
        if (!env) throw new Error("ENV_NOT_FOUND");
        const who = { address: caller, isAdmin };
        if (!env.ownerOrgId) {
          const own = await access.canOperate(who, env);
          return { environmentId, ownerOrgId: null, canOperate: own, canView: own };
        }
        const operate = await access.canOperate(who, env);
        const view = operate || (await access.canView(who, env));
        if (config.orgSync && !isAdmin) {
          if (operate) await syncEnvironmentOrgOnce(config.orgSync, env, [caller]);
          else if (view) await grantViewer(config.orgSync, env, caller);
        }
        return { environmentId, ownerOrgId: env.ownerOrgId, canOperate: operate, canView: view };
      },

      setEnvironmentOrg: async (
        _p: unknown,
        { environmentId, orgId }: { environmentId: string; orgId: string },
        ctx: AuthAwareContext,
      ) => {
        const caller = ctx.user?.address?.toLowerCase();
        if (!caller) throw new Error("UNAUTHENTICATED");
        const org = orgId.trim();
        if (!org) throw new Error("ORG_ID_REQUIRED");
        const isAdmin = callerIsAdmin(ctx, caller);
        const env = (await envDb
          .selectFrom("environments")
          .select(["id", "owner", "ownerOrgId", "orgOperators", "appId"])
          .where("id", "=", environmentId)
          .executeTakeFirst()) as OrgEnvRow | undefined;
        if (!env) throw new Error("ENV_NOT_FOUND");
        if (env.ownerOrgId) throw new Error("ALREADY_ORG_OWNED");
        if (env.appId) throw new Error("APP_ENVIRONMENT");
        const mayHandOver =
          (await access.canOperate({ address: caller, isAdmin }, env)) &&
          (await access.canOperate({ address: caller, isAdmin: false }, { owner: null, ownerOrgId: org }));
        if (!mayHandOver) throw new Error("FORBIDDEN");
        await dispatch(env.id, "SET_OWNER_ORG", { ownerOrgId: org, operators: [caller] });
        if (config.orgSync) {
          await syncEnvironmentOrgOnce(config.orgSync, { ...env, ownerOrgId: org, orgOperators: JSON.stringify([caller]) });
        }
        return { environmentId, ownerOrgId: org, canOperate: true, canView: true };
      },
```

`schema.ts` — add the `EnvironmentOrgAccess` type and both mutations with doc strings ("Called by vetra.io before signed actions on an environment: refreshes the caller's operator entry (publishers) or read grant (members) from Renown and answers their access." / "Hand a personal, non-app environment to a Renown organisation. Caller: the env's owner (or an admin) who is a PUBLISHER or above in the organisation.").

`index.ts`: build the deps once and start the job next to `startOwnerBackfill()`:

```ts
    const orgSync: OrgSyncDeps = {
      envDb,
      db,
      orgs: defaultRenownOrgs(),
      appDidOf: appDidLookup(appsDb),
      dispatch,
      perm: this.documentPermissionService ?? null,
      logger: console,
    };
```

pass `orgSync` into `createResolvers(db, { …, orgSync })`, add a field `private orgOperatorSync: ReturnType<typeof setInterval> | null = null;`, and in `onSetup`:

```ts
    // Organisation operators: refresh orgOperators and document grants from Renown.
    const syncOrgs = async () => {
      try {
        const n = await runOrgSyncOnce(orgSync);
        if (n > 0) console.info(`[org-sync] checked ${n} organisation environment(s)`);
      } catch (err) {
        if (String(err).includes("does not exist")) return;
        console.warn("[org-sync] error:", err);
      }
    };
    this.orgOperatorSync = setInterval(() => void syncOrgs(), 5 * 60 * 1000);
    void syncOrgs();
```

and clear it in `onDisconnect` like `ownerBackfill`. (The `dispatch` used here is the in-process one, so these actions are system-signed.)

- [ ] **Step 5: Run the observability suite, types, lint** — as Task 4 Step 5.

- [ ] **Step 6: Commit**

```bash
git add subgraphs/vetra-cloud-observability
git commit -m "feat(orgs): sync organisation operators and grants; syncEnvironmentOrg and setEnvironmentOrg"
```

---

### Task 6: vetra-apps — `owner_org_id`, org-aware access, `myApps(orgId)`, lazy sync from Renown

**Files:**
- Create: `subgraphs/vetra-apps/org-ownership.ts`, `subgraphs/vetra-apps/__tests__/org-apps.test.ts`
- Modify: `subgraphs/vetra-apps/db/schema.ts`, `db/migrations.ts`, `service.ts` (`AppsDeps.orgs`, `loadAppForOwner`, `appForOwner`, `myApps`, `appDeploymentsFor`, `appDeploymentFor`), `resolvers.ts`, `schema.ts`, `index.ts`, `__tests__/harness.ts`

**Interfaces:**
- Consumes: `RenownOrgs`, `AppPublisher`, `RenownOrgsUnavailableError` (Task 1); `canOperate`, `canView`, `isOrgMember`, `AccessCaller`, `OwnedResource` (Task 1); `setOwner`, `setOwnerOrg` creators (Task 2).
- Produces: `AppsTable.owner_org_id: string | null`; `AppsDeps.orgs?: RenownOrgs | null`; `org-ownership.ts`: `callerAccess(caller: Caller): AccessCaller`, `appResource(app: AppRow): OwnedResource`, `syncAppOrg(deps: AppsDeps, app: AppRow): Promise<AppRow>`, `adoptOrgApps(deps: AppsDeps, orgId: string): Promise<void>`; `myApps(deps, caller, orgId?: string | null)`; `appForOwner(deps, caller, appId, opts?: { includeDeleted?: boolean; need?: "view" | "operate" })`; GraphQL `App.ownerOrgId: String`, `Query.myApps(orgId: String)`; harness `fakeOrgs()`, `Harness.orgs`, constants `ORG`, `MEMBER`, `member: Caller`.

- [ ] **Step 1: Column and harness**

`db/schema.ts` — `AppsTable` gains `/** Renown organisation owning the App (null: personal). */ owner_org_id: string | null;`.
`db/migrations.ts` — add `["owner_org_id", "varchar(255)"]` to the existing `for (const [column, type] of [...])` list for `apps`, and after it:

```ts
  await db.schema.createIndex("apps_owner_org_idx").on("apps").column("owner_org_id").ifNotExists().execute();
```

Find every `insertInto("apps").values({...})` in `subgraphs/` and tests (`grep -rn 'insertInto("apps")' subgraphs`) and add `owner_org_id: null` where TypeScript requires it (in `createApp` Task 7 sets the real value).

`__tests__/harness.ts`:

```ts
import { RenownOrgsUnavailableError, type AppPublisher, type OrgMembership } from "../../../shared/renown-orgs.js";

export const ORG = "org-acme";
export const MEMBER = "0xdddddddddddddddddddddddddddddddddddddddd";
export const member: Caller = { address: MEMBER, chainId: 1, appKey: null, isAdmin: false };

export function fakeOrgs() {
  const self = {
    members: new Map<string, OrgMembership>(),
    apps: new Map<string, string[]>(),
    publishers: new Map<string, AppPublisher>(),
    down: false,
    join(orgId: string, address: string, role: OrgMembership["role"], scope: string[] | "ALL" = "ALL") {
      self.members.set(`${orgId}|${address.toLowerCase()}`, {
        role,
        effectiveScope: scope === "ALL" ? { all: true, appDids: [] } : { all: false, appDids: scope },
      });
    },
    async membership(orgId: string, address: string) {
      if (self.down) throw new RenownOrgsUnavailableError("down");
      return self.members.get(`${orgId}|${address.toLowerCase()}`) ?? null;
    },
    async orgApps(orgId: string) {
      if (self.down) throw new RenownOrgsUnavailableError("down");
      return self.apps.get(orgId) ?? null;
    },
    async appPublisher(appDid: string) {
      if (self.down) throw new RenownOrgsUnavailableError("down");
      return self.publishers.get(appDid) ?? null;
    },
  };
  return self;
}
```

and in `makeHarness`: `const orgs = fakeOrgs();`, `deps.orgs = orgs` (field `orgs,` in the deps object), `Harness.orgs: ReturnType<typeof fakeOrgs>` returned.

- [ ] **Step 2: Write the failing tests**

`__tests__/org-apps.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appForOwner, connectGithubDeploy, myApps, updateApp } from "../service.js";
import { getApp, type AppRow } from "../repo.js";
import { APP_DID, MEMBER, ORG, OWNER, STRANGER, admin, makeHarness, member, owner, seedActiveApp, stranger, type Harness } from "./harness.js";

let h: Harness;
let app: AppRow;
const code = (p: Promise<unknown>) =>
  p.then(() => "OK", (e: { extensions?: { code?: string } }) => e.extensions?.code ?? String(e));
/** The app as Renown would report it after a transfer into ORG. */
async function moveToOrg() {
  h.orgs.publishers.set(APP_DID, { orgId: ORG, address: null });
  return appForOwner(h.deps, admin, app.id);
}

beforeEach(async () => {
  h = await makeHarness();
  app = await seedActiveApp(h);
});
afterEach(async () => h.close());

describe("org-owned apps", () => {
  it("adopts an app transferred in at Renown and moves its envs to the org", async () => {
    h.orgs.join(ORG, MEMBER, "MEMBER");
    h.orgs.apps.set(ORG, [APP_DID]);
    h.orgs.publishers.set(APP_DID, { orgId: ORG, address: null });
    const listed = await myApps(h.deps, member, ORG);
    expect(listed.map((a) => [a.id, a.owner_org_id])).toStrictEqual([[app.id, ORG]]);
    const env = await h.envs.getState(app.production_environment_id);
    expect(env).toMatchObject({ owner: OWNER, ownerOrgId: ORG, orgOperators: [] });
    expect(await myApps(h.deps, owner)).toStrictEqual([]);
  });

  it("a publisher operates, a member only views, the creator and strangers neither", async () => {
    await moveToOrg();
    h.orgs.join(ORG, MEMBER, "PUBLISHER", [APP_DID]);
    expect(await code(updateApp(h.deps, member, app.id, { name: "Renamed" }))).toBe("OK");
    h.orgs.join(ORG, MEMBER, "MEMBER");
    expect(await code(appForOwner(h.deps, member, app.id, { need: "view" }))).toBe("OK");
    expect(await code(updateApp(h.deps, member, app.id, { name: "Nope" }))).toBe("FORBIDDEN");
    expect(await code(updateApp(h.deps, owner, app.id, { name: "Nope" }))).toBe("FORBIDDEN");
    expect(await code(appForOwner(h.deps, stranger, app.id, { need: "view" }))).toBe("FORBIDDEN");
    expect(await code(updateApp(h.deps, admin, app.id, { name: "By admin" }))).toBe("OK");
  });

  it("a publisher scoped to other apps cannot operate it", async () => {
    await moveToOrg();
    h.orgs.join(ORG, MEMBER, "PUBLISHER", ["did:key:other"]);
    expect(await code(updateApp(h.deps, member, app.id, { name: "Nope" }))).toBe("FORBIDDEN");
  });

  it("myApps(orgId) is for members only", async () => {
    expect(await code(myApps(h.deps, stranger, ORG))).toBe("FORBIDDEN");
    expect(await code(myApps(h.deps, admin, ORG))).toBe("OK");
  });

  it("fails closed when Renown is unreachable, and keeps ownership when the publisher lookup fails", async () => {
    await moveToOrg();
    h.orgs.join(ORG, MEMBER, "OWNER");
    h.orgs.down = true;
    expect(await code(updateApp(h.deps, member, app.id, { name: "Nope" }))).toBe("FORBIDDEN");
    expect((await appForOwner(h.deps, admin, app.id)).owner_org_id).toBe(ORG);
    expect((await getApp(h.db, app.id))?.owner_org_id).toBe(ORG);
  });

  it("follows a transfer out to a person: row, env owner and org are moved", async () => {
    await moveToOrg();
    h.orgs.publishers.set(APP_DID, { orgId: null, address: STRANGER });
    expect(await code(updateApp(h.deps, stranger, app.id, { name: "Mine now" }))).toBe("OK");
    expect(await getApp(h.db, app.id)).toMatchObject({ owner_address: STRANGER, owner_org_id: null });
    expect(await h.envs.getState(app.production_environment_id)).toMatchObject({ owner: STRANGER, ownerOrgId: null });
    expect(await code(updateApp(h.deps, owner, app.id, { name: "Nope" }))).toBe("FORBIDDEN");
  });

  it("never moves a personal app to another person", async () => {
    h.orgs.publishers.set(APP_DID, { orgId: null, address: STRANGER });
    expect((await appForOwner(h.deps, owner, app.id)).owner_address).toBe(OWNER);
  });
});
```

(`connectGithubDeploy` is imported only if `seedActiveApp` needs it; drop unused imports before linting.)

Run: `npx vitest run subgraphs/vetra-apps/__tests__/org-apps.test.ts 2>&1 | grep -E "Tests |FAIL"` → FAIL.

- [ ] **Step 3: Implement `org-ownership.ts`**

```ts
import { setOwner, setOwnerOrg } from "../../document-models/vetra-cloud-environment/v1/gen/creators.js";
import type { AccessCaller, OwnedResource } from "../../shared/org-access.js";
import type { AppPublisher } from "../../shared/renown-orgs.js";
import type { Caller } from "./auth.js";
import { mirrorAppRow } from "./app-document.js";
import { getApp, listPreviews, type AppRow } from "./repo.js";
import type { AppsDeps } from "./service.js";

export const callerAccess = (c: Caller): AccessCaller => ({ address: c.address, isAdmin: c.isAdmin });

export const appResource = (app: AppRow): OwnedResource => ({
  owner: app.owner_address,
  ownerOrgId: app.owner_org_id ?? null,
  appDid: app.identity_did,
});

/**
 * Reconcile the App's owner with its Renown profile's publisher (Ruling 11).
 * No profile, no Renown client or a failed lookup: unchanged.
 */
export async function syncAppOrg(deps: AppsDeps, app: AppRow): Promise<AppRow> {
  if (!deps.orgs || app.status === "DELETED") return app;
  let publisher: AppPublisher | null;
  try {
    publisher = await deps.orgs.appPublisher(app.identity_did);
  } catch {
    return app;
  }
  if (!publisher) return app;
  const currentOrg = app.owner_org_id ?? null;
  const nextOrg = publisher.orgId;
  // Only an org transfer hands an App to another person.
  const nextOwner = !nextOrg && currentOrg && publisher.address ? publisher.address : app.owner_address;
  if (nextOrg === currentOrg && nextOwner === app.owner_address) return app;

  await deps.db
    .updateTable("apps")
    .set({ owner_org_id: nextOrg, owner_address: nextOwner, updated_at: deps.now().toISOString() })
    .where("id", "=", app.id)
    .execute();
  const envIds = [
    app.production_environment_id,
    ...(await listPreviews(deps.db, app.id)).map((p) => p.environment_id),
  ];
  for (const envId of envIds) {
    try {
      await deps.envs.execute(envId, [
        ...(nextOwner !== app.owner_address ? [setOwner({ address: nextOwner })] : []),
        setOwnerOrg({ ownerOrgId: nextOrg, operators: [] }),
      ]);
    } catch (err) {
      deps.logger.warn(`[vetra-apps] moving env ${envId} of App ${app.slug} failed: ${String(err)}`);
    }
  }
  deps.logger.info(
    `[vetra-apps] App ${app.slug} is now owned by ${nextOrg ? `organisation ${nextOrg}` : nextOwner} (Renown)`,
  );
  const updated = (await getApp(deps.db, app.id))!;
  await mirrorAppRow(deps, updated);
  return updated;
}

/** Apps Renown lists for the org whose rows do not say so yet. */
export async function adoptOrgApps(deps: AppsDeps, orgId: string): Promise<void> {
  if (!deps.orgs) return;
  let dids: string[] | null;
  try {
    dids = await deps.orgs.orgApps(orgId);
  } catch {
    return;
  }
  if (!dids?.length) return;
  const rows = await deps.db
    .selectFrom("apps")
    .selectAll()
    .where("identity_did", "in", dids)
    .where("status", "!=", "DELETED")
    .execute();
  for (const row of rows) {
    if (row.owner_org_id !== orgId) await syncAppOrg(deps, { ...row, previews_enabled: Boolean(row.previews_enabled) });
  }
}
```

(If importing `AppsDeps` from `service.js` creates a cycle that `npx dpdm -T ./index.ts` reports, move `AppsDeps` and `AppsLogger` into a new `subgraphs/vetra-apps/deps.ts` and re-export them from `service.ts`.)

- [ ] **Step 4: Use it in `service.ts`**

- `AppsDeps` gains `/** Renown organisations; null/absent: org-owned Apps are admin-only. */ orgs?: RenownOrgs | null;`.
- `loadAppForOwner(deps, caller, appId, opts: { includeDeleted?: boolean; need?: "view" | "operate" } = {})`: after the DELETED check replace the owner check with

```ts
  const synced = await syncAppOrg(deps, app);
  const allowed =
    opts.need === "view"
      ? await canView(deps.orgs ?? null, callerAccess(caller), appResource(synced))
      : await canOperate(deps.orgs ?? null, callerAccess(caller), appResource(synced));
  if (!allowed) throw appsError("FORBIDDEN", "Not allowed to manage this App");
  return synced;
```

- `appForOwner` forwards `opts` unchanged; `appDeploymentsFor` and `appDeploymentFor` call `loadAppForOwner(…, { need: "view" })`.
- `myApps(deps, caller, orgId?: string | null)`:

```ts
export async function myApps(deps: AppsDeps, caller: Caller, orgId?: string | null): Promise<AppRow[]> {
  await assertNotWorkload(deps, caller);
  const org = orgId?.trim() || null;
  if (org) {
    if (!(await isOrgMember(deps.orgs ?? null, callerAccess(caller), org))) {
      throw appsError("FORBIDDEN", "Not a member of this organisation");
    }
    await adoptOrgApps(deps, org);
    const rows = await deps.db
      .selectFrom("apps")
      .selectAll()
      .where("owner_org_id", "=", org)
      .where("status", "!=", "DELETED")
      .orderBy("created_at", "desc")
      .execute();
    return rows.map(normalizeApp);
  }
  const rows = await deps.db
    .selectFrom("apps")
    .selectAll()
    .where("owner_address", "=", caller.address)
    .where("owner_org_id", "is", null)
    .where("status", "!=", "DELETED")
    .orderBy("created_at", "desc")
    .execute();
  const synced = await Promise.all(rows.map((r) => syncAppOrg(deps, normalizeApp(r))));
  return synced.filter((a) => a.owner_org_id === null);
}
```

`resolvers.ts`: `myApps: (_, { orgId }: { orgId?: string | null }, ctx) => … myApps(deps, requireCaller(ctx), orgId)`; `app` uses `appForOwner(deps, caller, id, { includeDeleted: true, need: "view" })`; `mapApp` adds `ownerOrgId: app.owner_org_id ?? null,`.
`schema.ts`: `type App` gains `"Renown organisation owning the App; null for personal Apps." ownerOrgId: String` (after `ownerAddress`); `myApps(orgId: String): [App!]!` with doc "Personal Apps, or with orgId the organisation's Apps (members only)".
`index.ts`: `orgs: defaultRenownOrgs(),` in the deps object (import from `../../shared/renown-orgs.js`).

- [ ] **Step 5: Run the vetra-apps suite, types, lint**

Run: `npx vitest run subgraphs/vetra-apps 2>&1 | grep -E "Test Files|Tests |FAIL"` → all pass (existing tests: `fakeOrgs().appPublisher` answers null, so nothing syncs; "owner-level calls" test unchanged).
Run: `npm run tsc 2>&1 | tail -5 && npm run lint:fix 2>&1 | tail -5 && npx dpdm -T ./index.ts 2>&1 | grep -i "circular" | head -3`.

- [ ] **Step 6: Commit**

```bash
git add subgraphs/vetra-apps
git commit -m "feat(orgs): organisation-owned apps with lazy ownership sync from Renown"
```

---

### Task 7: vetra-apps — `createApp(orgId)`, workload `ownerOrgId`, previews, CI and identity

**Files:**
- Modify: `subgraphs/vetra-apps/service.ts` (`CreateAppInput`, `createApp`, preview creation, `authorizeCi`, `confirmAppIdentity`), `renown.ts` (`registerWorkloadIdentity` input), `schema.ts` (`CreateAppInput.orgId`)
- Test: `subgraphs/vetra-apps/__tests__/org-apps.test.ts` (new `describe` blocks)

**Interfaces:**
- Consumes: `canCreateOrgApp`, `canOperate` (Task 1); `syncAppOrg`, `callerAccess`, `appResource` (Task 6); `setOwnerOrg` (Task 2); Renown `RegisterWorkloadIdentityInput.ownerOrgId` (A2).
- Produces: `CreateAppInput.orgId?: string | null`; `RenownApi.registerWorkloadIdentity(input: { …; ownerOrgId?: string })`; GraphQL `input CreateAppInput { …; orgId: String }`.

- [ ] **Step 1: Write the failing tests** — append to `__tests__/org-apps.test.ts` (import `createApp`, `confirmAppIdentity`, `INSTALLATION`, `REPO_ID`, `claim`, `deployAsCi`, `ciIdentity` from the harness/service; the `beforeEach` of this file seeds a personal app, so these tests use a second repository id `"4343"` from `fakeGithub().listUserInstallationRepos`):

```ts
describe("createApp in an organisation", () => {
  const input = { name: "Org Shop", installationId: INSTALLATION, repositoryId: "4343", orgId: ORG };

  it("registers the workload for the org and hands the production env to it", async () => {
    h.orgs.join(ORG, OWNER, "PUBLISHER");
    const created = await createApp(h.deps, owner, input);
    expect(created.owner_org_id).toBe(ORG);
    expect(h.renown.registered.at(-1)).toMatchObject({ ownerAddress: OWNER, ownerOrgId: ORG });
    expect(await h.envs.getState(created.production_environment_id)).toMatchObject({
      owner: OWNER,
      ownerOrgId: ORG,
      orgOperators: [OWNER],
    });
  });

  it("refuses members, scoped publishers, admins outside the org, and a Renown outage", async () => {
    h.orgs.join(ORG, OWNER, "MEMBER");
    expect(await code(createApp(h.deps, owner, input))).toBe("FORBIDDEN");
    h.orgs.join(ORG, OWNER, "PUBLISHER", [APP_DID]);
    expect(await code(createApp(h.deps, owner, input))).toBe("FORBIDDEN");
    expect(await code(createApp(h.deps, admin, input))).toBe("FORBIDDEN");
    h.orgs.join(ORG, OWNER, "ADMIN");
    h.orgs.down = true;
    expect(await code(createApp(h.deps, owner, input))).toBe("FORBIDDEN");
  });

  it("attaches a personal env (handing it over) but refuses an env of another org", async () => {
    h.orgs.join(ORG, OWNER, "ADMIN");
    const personal = await h.envs.seedStandalone(OWNER);
    const created = await createApp(h.deps, owner, { ...input, productionEnvironmentId: personal });
    expect(await h.envs.getState(personal)).toMatchObject({ ownerOrgId: ORG, orgOperators: [OWNER] });
    expect(created.production_environment_id).toBe(personal);
  });

  it("refuses to attach an org env to a personal app or to another org's app", async () => {
    h.orgs.join(ORG, OWNER, "ADMIN");
    h.orgs.join("org-other", OWNER, "ADMIN");
    const orgEnv = await h.envs.seedStandalone(OWNER);
    await h.envs.execute(orgEnv, [setOwnerOrg({ ownerOrgId: "org-other", operators: [OWNER] })]);
    expect(await code(createApp(h.deps, owner, { ...input, productionEnvironmentId: orgEnv }))).toBe("BAD_USER_INPUT");
    expect(await code(createApp(h.deps, owner, { ...input, orgId: null, productionEnvironmentId: orgEnv }))).toBe("BAD_USER_INPUT");
  });
});

describe("CI and identity for org apps", () => {
  it("accepts a CI token from a publisher of the app and refuses one from a removed member or the creator who left", async () => {
    h.orgs.publishers.set(APP_DID, { orgId: ORG, address: null });
    await appForOwner(h.deps, admin, app.id);
    h.envs.setStatus(app.production_environment_id, "READY");
    h.orgs.join(ORG, MEMBER, "PUBLISHER");
    const memberCi = (c: ReturnType<typeof claim>) => ({ ...ciIdentity(c), address: MEMBER });
    const prod = { appId: app.id, kind: "PRODUCTION" as const, gitRef: "refs/heads/main", sha: "a".repeat(40), packages: [{ name: "@acme/shop", version: "1.0.0" }] };
    expect(await code(ciDeployApp(h.deps, memberCi(claim("refs/heads/main")), prod))).toBe("OK");
    h.orgs.members.clear();
    expect(await code(ciDeployApp(h.deps, memberCi(claim("refs/heads/main")), prod))).toBe("FORBIDDEN");
    expect(await code(ciDeployApp(h.deps, ciIdentity(claim("refs/heads/main")), prod))).toBe("FORBIDDEN");
  });

  it("confirmAppIdentity on an org app looks up the caller's delegation", async () => {
    h.orgs.publishers.set(APP_DID, { orgId: ORG, address: null });
    h.orgs.join(ORG, MEMBER, "PUBLISHER");
    const lookups: unknown[] = [];
    h.renown.getDelegation = async (input) => {
      lookups.push(input);
      return { expiresAt: "2027-01-01T00:00:00.000Z" };
    };
    await confirmAppIdentity(h.deps, member, app.id);
    expect(lookups.at(-1)).toMatchObject({ address: MEMBER, did: APP_DID });
  });
});

describe("previews of org apps", () => {
  it("copy the production env's organisation and operators", async () => {
    h.orgs.publishers.set(APP_DID, { orgId: ORG, address: null });
    await appForOwner(h.deps, admin, app.id);
    await h.envs.execute(app.production_environment_id, [syncOrgOperators({ operators: [MEMBER] })]);
    h.orgs.join(ORG, OWNER, "PUBLISHER"); // the CI token below is the creator's; org apps need capability
    h.envs.setStatus(app.production_environment_id, "READY");
    const d = await deployAsCi(h.deps, claim("refs/pull/7/merge", { prNumber: 7 }), {
      appId: app.id, kind: "PREVIEW", prNumber: 7, gitRef: "refs/pull/7/merge", sha: "a".repeat(40),
      packages: [{ name: "@acme/shop", version: "1.0.0-pr.7" }],
    });
    expect(await h.envs.getState(d.environment_id!)).toMatchObject({ ownerOrgId: ORG, orgOperators: [MEMBER] });
  });
});
```

(Imports: `setOwnerOrg`, `syncOrgOperators` from `../../../document-models/vetra-cloud-environment/v1/index.js`; `ciDeployApp` from `../service.js`. `ciIdentity(...)` has `address: OWNER`, the creator, who needs publisher capability like anyone else once the app is org-owned.)

Run: `npx vitest run subgraphs/vetra-apps/__tests__/org-apps.test.ts 2>&1 | grep -E "Tests |FAIL"` → FAIL.

- [ ] **Step 2: Implement**

`renown.ts`: the `registerWorkloadIdentity` input type gains `/** Register for this Renown organisation (A2). */ ownerOrgId?: string;` (sent inside `input` unchanged).
`schema.ts`: `input CreateAppInput` gains `"Create the App for this Renown organisation (OWNER/ADMIN, or PUBLISHER with access to all apps)." orgId: String`.
`service.ts`:
- `CreateAppInput` gains `orgId?: string | null;`.
- In `createApp`, right after the name check:

```ts
  const orgId = input.orgId?.trim() || null;
  if (orgId && !(await canCreateOrgApp(deps.orgs ?? null, callerAccess(caller), orgId))) {
    throw appsError(
      "FORBIDDEN",
      "Creating Apps in this organisation needs the publisher role with access to all its apps",
    );
  }
```

- Replace the attach-env owner check (`if ((attachEnvState.owner ?? "").toLowerCase() !== caller.address) { … }`) with:

```ts
    const envOrg = attachEnvState.ownerOrgId ?? null;
    if (envOrg !== null && envOrg !== orgId) {
      throw appsError(
        "BAD_USER_INPUT",
        orgId ? "Environment belongs to another organisation" : "This environment belongs to an organisation; create the App there",
      );
    }
    const mayAttach = await canOperate(
      deps.orgs ?? null,
      { address: caller.address, isAdmin: false },
      { owner: attachEnvState.owner ?? null, ownerOrgId: envOrg },
    );
    if (!mayAttach) throw appsError("FORBIDDEN", "You do not own this environment");
```

- `registerWorkloadIdentity({ …existing fields…, ...(orgId ? { ownerOrgId: orgId } : {}) })`.
- The `apps` insert gains `owner_org_id: orgId,`.
- Hand-over action: `const handOver = orgId ? [setOwnerOrg({ ownerOrgId: orgId, operators: [caller.address] })] : [];`. Attach path: `await deps.envs.execute(envId, [link, ...(attachEnvState!.ownerOrgId ? [] : handOver)]);`. New env path: insert `...handOver,` right after `setOwner({ address: caller.address }),`.
- Preview creation (the function that builds `createActions` with `setOwner({ address: app.owner_address })`): after that line add

```ts
    ...(app.owner_org_id
      ? [setOwnerOrg({ ownerOrgId: app.owner_org_id, operators: productionState?.orgOperators ?? [] })]
      : []),
```

  (`productionState` is the production env state that function already reads for the FUSION template.)
- `authorizeCi`: replace the owner comparison with

```ts
  const ciAddress = ci.address.toLowerCase();
  const actsFor = app.owner_org_id
    ? await canOperate(deps.orgs ?? null, { address: ciAddress, isAdmin: false }, appResource(app))
    : ciAddress === app.owner_address;
  if (!actsFor) throw appsError("FORBIDDEN", "App identity does not act for this App's owner");
```

  (call `syncAppOrg(deps, app)` first and use its result, so a transfer is seen by CI too).
- `confirmAppIdentity`: `getDelegation({ address: app.owner_org_id ? caller.address : app.owner_address, chainId: app.owner_org_id ? caller.chainId : app.owner_chain_id, did: app.identity_did })`.

Imports in `service.ts`: `setOwnerOrg` from the env creators, `canCreateOrgApp`, `canOperate`, `canView`, `isOrgMember` from `../../shared/org-access.js`, `type RenownOrgs` from `../../shared/renown-orgs.js`, and `adoptOrgApps`, `appResource`, `callerAccess`, `syncAppOrg` from `./org-ownership.js`.

- [ ] **Step 3: Run the vetra-apps suite, types, lint** — as Task 6 Step 5 (existing "creates Harbor project…" test still sees `registered` without `ownerOrgId`).

- [ ] **Step 4: Commit**

```bash
git add subgraphs/vetra-apps
git commit -m "feat(orgs): create apps in an organisation; org-aware CI, previews and identity"
```

---

### Task 8: Licensing — `canOperate` in `resolveOwnerApp`, org app lists, profile relay fields

**Files:**
- Modify: `subgraphs/vetra-licensing/publisher-auth.ts`, `owner-apps.ts`, `publisher-resolvers.ts`, `publisher-schema.ts`, `renown-profile.ts`, `index.ts`
- Test: `subgraphs/vetra-licensing/__tests__/publisher-auth.test.ts`, `__tests__/renown-profile.test.ts`, `__tests__/app-profile-relay.test.ts`, `__tests__/owner-apps.test.ts`

**Interfaces:**
- Consumes: `canOperate`, `MembershipReader` (Task 1); `apps.owner_org_id` (Task 6).
- Produces: `OwnerAppRecord.owner_org_id?: string | null`; `PublisherAuthDeps.orgs?: MembershipReader | null` and `PublisherAuthDeps.listAppsForOrg?(orgId: string): Promise<OwnerAppRecord[]>`; `AppProfileWrite.supportContact?`, `.securityContact?`, `.publisherOrgId?`; `PROFILE_WRITE_KEYS` includes them; `upsertMutation(keys: readonly ProfileWriteKey[]): string`; GraphQL `UpdateAppProfileInput.supportContact: String`, `.securityContact: String`, `VetraPublisherQueries.myApps(orgId: String)`; relay code `APP_FROZEN`.

- [ ] **Step 1: Write the failing tests**

Append to `__tests__/publisher-auth.test.ts`:

```ts
describe("resolveOwnerApp for organisation apps", () => {
  const orgApp = (membership: unknown) => ({
    ...deps({ owner_address: OWNER }),
    findAppById: vi.fn(async () => ({
      id: "app-1", name: "Vault", status: "ACTIVE", owner_address: OWNER,
      owner_org_id: "o1", identity_did: "did:key:vault",
    })),
    orgs: { membership: vi.fn(async () => membership as never) },
  });

  it("authorises a publisher of the org and refuses the creator who left", async () => {
    const publisher = { role: "PUBLISHER", effectiveScope: { all: false, appDids: ["did:key:vault"] } };
    await expect(resolveOwnerApp(orgApp(publisher), ctx(STRANGER), "app-1")).resolves.toEqual({ appId: "app-1" });
    await expect(resolveOwnerApp(orgApp(null), ctx(OWNER), "app-1")).rejects.toBeInstanceOf(NotAppOwnerError);
  });

  it("fails closed with the same opaque refusal when Renown is down", async () => {
    const down = orgApp(null);
    down.orgs.membership.mockRejectedValue(new Error("down"));
    await expect(resolveOwnerApp(down, ctx(STRANGER), "app-1")).rejects.toThrow("no such app");
  });
});
```

Append to `__tests__/renown-profile.test.ts` (reuse the file's fake-fetch helper pattern of "forwards the bearer …"):

```ts
  it("declares only the arguments it sends, including contacts and the publishing organisation", async () => {
    const { relay, calls } = makeRelay(); // the file's existing helper; returns { data: { upsertAppProfile: true } }
    await relay!.upsert("did:key:app", "bearer", { supportContact: "help@acme.example", publisherOrgId: "o1" });
    const body = JSON.parse(calls[0].init.body as string) as { query: string; variables: Record<string, unknown> };
    expect(body.query).toContain("$supportContact: String");
    expect(body.query).toContain("publisherOrgId: $publisherOrgId");
    expect(body.query).not.toContain("$name");
    expect(body.variables).toStrictEqual({ appDid: "did:key:app", supportContact: "help@acme.example", publisherOrgId: "o1" });
  });

  it("maps APP_FROZEN", async () => {
    const { relay } = makeRelay({ errors: [{ message: "frozen", extensions: { code: "APP_FROZEN" } }] });
    await expect(relay!.upsert("did:key:app", "bearer", { name: "x" })).rejects.toMatchObject({ code: "APP_FROZEN" });
  });
```

(If the file has no such helper, write one at its top: `function makeRelay(answer: unknown = { data: { upsertAppProfile: true } }) { const calls: { url: string; init: RequestInit }[] = []; const relay = createRenownProfileRelay({ statsUrl: "https://renown.test/graphql/renown-stats", registrationToken: "reg", fetch: (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify(answer), { status: 200 }); }) as unknown as typeof fetch, logger: { warn: vi.fn() } }); return { relay, calls }; }`.)

Append to `__tests__/app-profile-relay.test.ts` a test in the style of "forwards the owner's bearer …": the fake `findAppById` returns `{ …, owner_org_id: "o1" }` and `orgs` lets the caller operate; expect `fake.upsert` called with `(APP_DID, bearer, expect.objectContaining({ publisherOrgId: "o1", supportContact: "help@acme.example" }))` when the input carries `supportContact`.

Append to `__tests__/owner-apps.test.ts`: `listAppsForOrg` returns the table rows of `byOrg` and never the studio app.

Run: `npx vitest run subgraphs/vetra-licensing/__tests__/publisher-auth.test.ts subgraphs/vetra-licensing/__tests__/renown-profile.test.ts subgraphs/vetra-licensing/__tests__/app-profile-relay.test.ts subgraphs/vetra-licensing/__tests__/owner-apps.test.ts 2>&1 | grep -E "Tests |FAIL"` → FAIL.

- [ ] **Step 2: Implement**

`publisher-auth.ts`:
- `OwnerAppRecord` gains `/** Renown organisation owning the app; absent/null: personal. */ owner_org_id?: string | null;`.
- `PublisherAuthDeps` gains `/** Renown memberships; absent: org apps are admin-only. */ orgs?: MembershipReader | null;` and `/** Apps of an organisation (vetraPublisher.myApps(orgId)). */ listAppsForOrg?(orgId: string): Promise<OwnerAppRecord[]>;`.
- In `resolveOwnerApp` replace `isOwner` and the refusal with:

```ts
  const allowed = await canOperate(
    deps.orgs ?? null,
    { address: address.toLowerCase(), isAdmin: callerIsAdmin(ctx, address) },
    { owner: app.owner_address, ownerOrgId: app.owner_org_id ?? null, appDid: app.identity_did ?? null },
  );
  if (!allowed) {
    throw new NotAppOwnerError("no such app");
  }
```

`owner-apps.ts`: `table` gains `byOrg(orgId: string): Promise<OwnerAppRecord[]>`; the returned object gains `listAppsForOrg: (orgId) => deps.table.byOrg(orgId)`.
`index.ts`: the `byId` select list gains `"owner_org_id"`; `byOwner` gains `"owner_org_id"` in the select and `.where("owner_org_id", "is", null)`; add

```ts
        byOrg: (orgId) =>
          appsDb
            .selectFrom("apps")
            .select(["id", "name", "status", "owner_address", "owner_org_id", "identity_did"])
            .where("owner_org_id", "=", orgId)
            .where("status", "!=", "DELETED")
            .execute(),
```

and pass `auth: { ...ownerLookup, orgs: defaultRenownOrgs() }` where `createPublisherResolvers` receives `auth`.
`publisher-resolvers.ts`:
- `myApps: withCodes(async (a: { orgId?: string | null }, ctx) => { … })`: with an `orgId`, list `deps.auth.listAppsForOrg?.(orgId) ?? []` and keep only apps for which `resolveOwnerApp(deps.auth, ctx, app.id)` resolves (ignore `AppIdentityInactiveError` — an inactive org app is still listed, as personal ones are); without, unchanged.
- `updateAppProfile`: after resolving `appDid`, read the record once (`const app = await deps.auth.findAppById(appId)`) and call

```ts
          await deps.renownProfile.upsert(appDid, bearer, {
            ...a.input,
            ...(app?.owner_org_id ? { publisherOrgId: app.owner_org_id } : {}),
          });
```

`publisher-schema.ts`: `UpdateAppProfileInput` gains `"Support contact: an email address or an https URL, at most 200 characters; empty clears" supportContact: String` and `"Security contact: same rules" securityContact: String`; `myApps(orgId: String): [PublisherApp!]!` with doc "Your apps, or with orgId the organisation's apps you operate".
`renown-profile.ts`:

```ts
export interface AppProfileWrite {
  // …existing fields…
  supportContact?: string | null;
  securityContact?: string | null;
  /** First claim (and every write) of an org-owned app: the organisation (A2). */
  publisherOrgId?: string | null;
}

export const PROFILE_WRITE_KEYS = [
  "name", "tagline", "website", "description", "category", "logoRef", "coverRef",
  "links", "metrics", "supportContact", "securityContact", "publisherOrgId",
] as const;
export type ProfileWriteKey = (typeof PROFILE_WRITE_KEYS)[number];

const ARG_TYPES: Record<ProfileWriteKey, string> = {
  name: "String", tagline: "String", website: "String", description: "String", category: "String",
  logoRef: "String", coverRef: "String", links: "[AppProfileLinkInput!]", metrics: "[AppMetricInput!]",
  supportContact: "String", securityContact: "String", publisherOrgId: "String",
};

/** The mutation for exactly these arguments, so older Renowns accept writes that do not use newer ones. */
export function upsertMutation(keys: readonly ProfileWriteKey[]): string {
  const defs = ["$appDid: String!", ...keys.map((k) => `$${k}: ${ARG_TYPES[k]}`)].join(", ");
  const args = ["appDid: $appDid", ...keys.map((k) => `${k}: $${k}`)].join(", ");
  return `mutation UpsertAppProfile(${defs}) {\n  upsertAppProfile(${args})\n}`;
}
```

  Delete the `UPSERT` constant; in `upsert`, collect `const keys = PROFILE_WRITE_KEYS.filter((k) => fields[k] !== undefined);`, build `variables` from them and send `query: upsertMutation(keys)`. In `refusal`, add `case "APP_FROZEN": return new RenownProfileError("APP_FROZEN", "This app is frozen by its organisation.");`. Make sure `publisher-errors.ts`/contract tests accept the new code if they enumerate codes (`grep -rn "PROFILE_UNAVAILABLE" subgraphs/vetra-licensing/*.ts`).

- [ ] **Step 3: Run the licensing suite, types, lint**

Run: `npx vitest run subgraphs/vetra-licensing 2>&1 | grep -E "Test Files|Tests |FAIL"` → all pass (the existing relay tests still find `upsertAppProfile(appDid: $appDid` and `$metrics: [AppMetricInput!]`).
Run: `npm run tsc 2>&1 | tail -5 && npm run lint:fix 2>&1 | tail -5`.

- [ ] **Step 4: Commit**

```bash
git add subgraphs/vetra-licensing
git commit -m "feat(orgs): organisation access for the publisher surface; relay contacts and publisherOrgId"
```

---

### Task 9: Full check and rollout (staging first)

**Files:** none new.

- [ ] **Step 1: Whole-repo gates**

Run: `npm run tsc 2>&1 | tail -5`, `npm run lint:fix 2>&1 | tail -5`, `npx vitest run 2>&1 | grep -E "Test Files|Tests |FAIL"`, `npm run test:coverage 2>&1 | grep -E "All files|ERROR"`, `npx dpdm -T ./index.ts 2>&1 | grep -ci "circular"` (expect `0` new cycles compared with `origin/main`).
Expected: all green, reducer coverage ≥ 95 in every column.

- [ ] **Step 2: Push and release on `dev`**

```bash
git push -u origin feat/organisations
git fetch origin && git switch dev && git merge --ff-only origin/dev
git merge --ff-only origin/main 2>/dev/null || true   # keep dev level with main first (see the staging-first rule)
git merge --no-ff feat/organisations -m "feat(orgs): Renown organisations own Vetra environments and apps"
git push origin dev
```

Expected: the `sync-and-publish` workflow publishes `@powerhousedao/vetra-cloud-package@<next>-dev.N` to `registry.dev.vetra.io` (`gh run list --workflow sync-and-publish.yml --limit 1`).

- [ ] **Step 3: Staging tenant**

Bump the staging tenant's `PH_REGISTRY_PACKAGES` to the new `-dev.N` (powerhouse-k8s-cluster, `tenants/staging`). Make sure the tenant's switchboard has `RENOWN_SWITCHBOARD_URL=https://switchboard.renown-staging.vetra.io` (or set `RENOWN_ORGS_ENDPOINT=https://switchboard.renown-staging.vetra.io/graphql/renown-orgs` and `RENOWN_STATS_URL=https://switchboard.renown-staging.vetra.io/graphql/renown-stats`). Smoke on staging with a staging Renown org you are a PUBLISHER of:
- `query { myEnvironments(scope: ORG, orgId: "<orgId>") { id ownerOrgId orgOperators } }` → `[]` (member) / `FORBIDDEN` (non-member wallet);
- create an env on staging.vetra.io, then `mutation { setEnvironmentOrg(environmentId: "<id>", orgId: "<orgId>") { ownerOrgId canOperate } }` → `{ownerOrgId, canOperate: true}`; within a minute the env appears in the ORG list with `orgOperators` = your address;
- logs show `[org-sync] checked N organisation environment(s)` every 5 minutes and no `[renown-orgs] … failed` lines.

- [ ] **Step 4: Promote to main (after C2 staging is verified)**

```bash
git switch main && git merge --ff-only origin/main
git merge --no-ff origin/dev -m "chore: release Renown organisations support"
git push origin main
```

Then bump the `vetra` (prod) tenant to the stable version with prod `RENOWN_SWITCHBOARD_URL` (default) and repeat the read-only smoke.
