# Releases phase 3, plan 5: the licence gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a shared instance admits only its admins and the live licence holders of its plan. A lapsed licence loses access within 60 s. If Vetra is down, a caller who was let in during the last 24 h keeps access, and a caller never seen before is refused.

There are two parts. They ship separately and meet at one HTTP contract (below):

- **Part A (this repo, vetra-cloud-package):**
  - Every shared instance gets a gate token (`VETRA_GATE_TOKEN`), delivered as a Vetra-owned secret through the phase 2 slice 4 settings delivery. Its plain settings are `ACCESS=licensed`, `VETRA_APP_ID` and `VETRA_GATE_URL`.
  - A new route `POST apps/gate/check` answers `{allowed, reason, until, ttlSeconds}` for one address.
  - Tokens rotate per instance.
  - Shared plans refuse releases built on a Powerhouse without the gate (D9).
- **Part B (Powerhouse monorepo, `/home/froid/projects/powerhouse`):**
  - A new switchboard access mode `ACCESS=licensed` in `packages/reactor-api` `AuthService`, with an `AccessGate` client that caches answers 60 s and keeps the last positive answer 24 h.
  - It ships in a Powerhouse release **X**. An App gets it only by being rebuilt on X.

**Architecture (part A):**
- **New table** `instance_gate_tokens` (vetra-apps namespace), one row per shared instance. It keeps:
  - the sha256 of the current token, which is what the route verifies;
  - the token's transit ciphertext under the existing `app-settings` key, which is what delivery decrypts, exactly like a publisher secret;
  - the previous token's hash, accepted until 15 minutes after the new one reached the tenant.
- **Settings.** For each shared row the reconciler appends the gate settings to `settingsForKind(…)`: three plain entries and the token as a `ResolvedSecret` whose `writeId` is the token's id. They are part of the settings revision. So the existing path does everything:
  - issuing and rotating the token, or switching the gate on, is a settings change;
  - it is delivered to `<tenant>-secrets`;
  - `VETRA_SETTINGS_REVISION` moves, the pod restarts, and health is checked against the revision.

  No new delivery code is needed.
- **The route.** `apps/gate/check` hashes the bearer, finds the row, and then the instance, its plan and its App. It answers:
  - `admin` when the address is the instance's `ADMINS` (`adminsOf`);
  - `licence` when the address holds a live licence of the plan's `kind` (`app_license_grants` ⋈ `license_lifecycle`, `isLiveEntry`);
  - `none` otherwise.

  `member` is reserved for the Team instance (slice 6). Nothing is cached on the Vetra side: the host's 60 s cache is the only one, so the 60 s lapse holds end to end. Rate limits run in memory (per instance, plus one global bucket for bad tokens), with counters in one log line per 5 minutes.

**Tech Stack:** TypeScript, Kysely (Postgres; PGlite in tests), vitest, GraphQL (vetra-apps subgraph); part B: `@powerhousedao/reactor-api` and `apps/switchboard` (vitest, zod), Nx release.

**Spec:** `docs/superpowers/specs/2026-11-11-app-releases-and-instances-design.md`:
- section 5, the "What every instance runs" row "access gate" and "Licence gate (Powerhouse switchboard)";
- 14.14 (24 h grace; never-seen callers refused);
- 15 (the Powerhouse monorepo row).

Slice scope and decisions D8/D9: `docs/superpowers/plans/2026-11-12-releases-phase-3-overview.md`, slice 5 and gaps 7 and 8. Conventions: plans 1 and 2 in this directory.

## Decisions to confirm (recommended default first; the plan is written with the default)

**Vetra side**

- **G1 Token storage.** The sha256 of the token is kept for verification. The token is also kept encrypted under the `app-settings` transit key, the same protection as publisher secrets. The overview said "only its sha256". The ciphertext is needed because every settings delivery rewrites the tenant's secrets in one batch, and a delivery that failed halfway must be retryable with the *same* token. Without it, each retry would mint a new token and could lock out pods that already run the old one. The alternative is `ensureSecret` only, with no ciphertext. Then rotation is not safely retryable and a tenant purge loses the token, so it is rejected.
- **G2 Token format.** `vgt_` + 64 hex (32 random bytes). The prefix makes a leaked token greppable (secret scanners).
- **G3 Rotation.**
  - The mutation is `rotateInstanceGateToken(instanceId)`. It needs `need: "release"` (operators and release managers, like settings) and is audited.
  - The old token keeps working until 15 minutes after the new one was delivered to the tenant (`GATE_PREVIOUS_GRACE_MS`), so pods that have not restarted yet are not locked out.
  - A second rotation before the first was delivered replaces only the undelivered token. The delivered one stays accepted.
  - There is no automatic periodic rotation in this slice.
  - A tenant purge (the environment is recreated) drops the row, and the next pass issues a fresh token.
- **G4 The answer is for the instance's plan (D8).**
  - `admin`: the caller is the instance's `ADMINS`, which for a shared instance is today the App owner (`adminsOf`).
  - `licence`: a live licence of the plan's kind for that App, whatever the plan's status. A retired plan keeps serving its holders (spec 5).
  - `until`: the latest `end_at` among the caller's live licences of that kind, or `null` (open-ended, or admin).
  - `ttlSeconds`: allowed → `min(60, seconds until "until")`, at least 1. Denied → 15. This means a new buyer gets in within 15 s, and nobody keeps access past the licence's end.
- **G5 No answer cache on the Vetra side.** The host caches per address for `ttlSeconds`. A second cache in Vetra would stretch the 60 s lapse to 120 s. Each check costs two indexed queries: the token lookup, then the licence query on the new `(app_id, user_address)` index, plus primary-key reads of the instance, plan and App.
- **G6 Rate limits** (in memory, per switchboard replica; production runs one):
  - Per instance: a token bucket of 50/s with a burst of 500 → `429` with `Retry-After: 1`.
  - Unknown or bad tokens: one global bucket of 20/s with a burst of 100 → `429` before any DB read.
  - The host treats `429` like Vetra being down (its 24 h grace applies).
- **G7 Audit.** The token being issued (`gate.token_issued`, source `system`) and rotated (`gate.token_rotated`, the caller's source) go into `app_audit`. Checks are never audited (too hot). Counters per instance (checks, allowed, denied) and totals (unauthorised, limited, failed) are logged once per 5 minutes when non-zero.
- **G8 Switch.** `VETRA_APPS_GATE` defaults to off. When on, it needs:
  - `VETRA_APPS_GATE_URL`, the full `…/apps/gate/check` URL the hosts call (staging: `https://switchboard.staging.vetra.io/api/@powerhousedao/vetra-cloud-package/apps/gate/check`);
  - `VETRA_APPS_GATE_MIN_POWERHOUSE`, version X.

  Startup fails if either is missing or invalid. There is no default URL, so a staging Vetra can never point hosts at production.

  The route is always registered and answers any valid token, even with the switch off. A host that still runs with the gate env is then never refused only because the switch was flipped.

  Turning the switch off removes the gate env on the next pass. The shared instances then admit any signed-in user again, as before this slice. Production never turns it off once on.
- **G9 D9 (the Powerhouse floor).** With the gate on, `createPlan` (with a target) and `setPlanTarget` refuse a release for a **shared** plan when its `powerhouse_version` is below `VETRA_APPS_GATE_MIN_POWERHOUSE`, or cannot be parsed. Own plans are not affected. Slice 3's rollout check reuses `gateFloorError` (this plan exports it).

  Shared instances already on an older target still get the gate env, which their host ignores. The console shows `gate.active = false` with the reason.
- **G10 Addresses.** `0x` + 40 hex digits, compared in lowercase. Anything else is 400. DIDs are not accepted, because the host has `user.address`.
- **G11 Accepted exposure.** The App's own code runs in the instance, so its publisher can read `VETRA_GATE_TOKEN` and ask about any address. The token answers only "does this address hold a live licence of **this plan**". That is the publisher's own customer list, which the publisher already sees. It never answers about other Apps or plans.
- **G12** `VETRA_GATE_TOKEN` joins `PLATFORM_MANAGED_KEYS`, so the user-facing tenant-secrets mutations refuse it. `ACCESS` is already reserved, and so is the whole `VETRA_` prefix for publisher settings.

**Powerhouse side**

- **H1 Where it hooks in.** It hooks into `AuthService.verifyBearer` (HTTP: GraphQL, SSE, drive-info, subgraph routes with `auth: "renown"`, MCP, attachments) and `authenticateWebSocketConnection` (WS), right after the Renown credential check.
  - A refused caller gets a `403` Response or a thrown error.
  - Routes declared `auth: "public"` (webhooks, OAuth callbacks, waitpoints) and function-authorised routes stay public.
  - `/health` and `/ready` stay open, and so does Connect's static app, which is served apart from the switchboard.
- **H2 Licensed implies:**
  - identity resolution on and `requireAuthenticatedCaller` on (anonymous callers get 401; `/health` and `/ready` are exempt as today);
  - the document policy `DOCUMENT_PERMISSIONS` if enabled, else **OPEN** among admitted callers, **not ADMIN_ONLY**. Under ADMIN_ONLY a licensee would pass the gate and then be refused every document.
  - `AuthContext.auth_enabled` still reports `true`.
- **H3 Cache.**
  - Answers are kept per address for `ttlSeconds` (clamped to 1-300 s; the default if absent is 60).
  - Concurrent checks for one address share one fetch.
  - At most 10,000 entries; the oldest go first.
  - The last positive answer is kept 24 h (`ACCESS_GATE_GRACE_MS`, default 86,400,000) and is used only when Vetra is unreachable: a network error, a timeout (5 s), or any non-2xx other than 401 and 400.
  - A 401 (bad token) is never answered from grace: everyone except admins is refused, with an error log. This makes a revoked token final.
  - The grace store is in memory. A restart while Vetra is down admits only admins. File persistence on `/data` (like `FileCredentialKeep`) is a follow-up if wanted.
- **H4 Open WebSocket sockets** are re-checked by the existing credential monitor: `isCredentialValid` also asks the gate. A lapsed licence's socket closes at the next recheck (`WS_CREDENTIAL_RECHECK_INTERVAL_MS`).
- **H5 Misconfiguration fails closed at boot.** `ACCESS=licensed` without `VETRA_GATE_URL` or `VETRA_GATE_TOKEN`, or with an unknown `ACCESS` value, refuses to start. Vetra's health then sees the instance fail and reverts the update (phase 2). `ACCESS=members` is rejected as "not supported" (D8: Team uses the same gate).
- **H6 Ownership of part B.** The PR is opened by us against `powerhouse-inc/powerhouse` `main`. The user names the reviewer. It ships in the first nightly `dev` release after the merge (Nx release, `X.Y.Z-dev.N`), and X is that version. Production Apps on `latest` get it with the next production release. D9's floor is set to X.

## What exists today (checked 2026-11-12 on `main` = 0.0.117)

- **HTTP routes** (`subgraphs/vetra-apps/index.ts`):
  - `this.http.post(path, { auth: "public", maxBodyBytes }, (request) => Response)` under `/api/@powerhousedao/vetra-cloud-package/`.
  - The CI routes (`ci.ts` `createCiRoutes(deps, verify)`) verify their own bearer and map `HttpError`/`GraphQLError` codes to statuses (`STATUS`, `errorResponse`). Handles go into `this.routeHandles` and are disposed in `onDisconnect`.
  - Periodic jobs use `every(ms, name, run)`.
  - CI route tests call `createCiRoutes(h.deps, fakeVerifier)` with `new Request(...)` (`__tests__/ci.test.ts`).
- **Settings delivery** (`settings/*`, `instances/reconciler.ts`):
  - `settingsForKind(rows, kind)` → `InstanceSettings { revision, plain, secrets: ResolvedSecret[] }`, with `settingsRevision(plain, secrets)` hashing names, values and `writeId`s.
  - `reconcileApp` reads the App's setting rows once and passes `settingsForKind(settingRows, row.kind)` to `reconcileInstance`.
  - `reconcileEnvironment` calls `deliverSettings(deps, tenantId, settings, declaredSecretNames(state))` when `row.settings_delivered !== settings.revision`, then patches `settings_delivered`/`settings_delivered_at`. `deliverSettings`:
    - ensures `VETRA_GENERATED_SECRETS`;
    - decrypts each `ResolvedSecret.ciphertext` with `deps.settingsVault` and `setSecrets` them in one batch;
    - deletes declared secrets no longer wanted;
    - notifies the tenant.
  - `fusionEnv(image, admins, settings)` renders plain entries inline and secret names as `isSecret: true` refs. `forgetTenant(deps, row)` purges the tenant when an environment is gone for good.
- **Reserved names** (`settings/names.ts`): `RESERVED_SETTING_NAMES` contains `ACCESS`, and `RESERVED_PREFIXES` contains `VETRA_`, so publishers cannot set any gate name. `VETRA_SETTINGS` is the read-only list `appSettings` shows (`settings/service.ts` line ~101: `vetra: VETRA_SETTINGS`).
- **Managed secret keys** (`subgraphs/vetra-cloud-secrets/services/secrets-service.ts`): `PLATFORM_MANAGED_KEYS` (user-facing paths refuse them); `setSecrets` is internal and allowed.
- **Hash precedent** (`studio-binding.ts`): `newLaunchSecret`, `hashLaunchSecret` (sha256 hex) and a constant-time `sameHash`, with the table `studio_launch_secrets`.
- **Holders** (`plans/holders.ts`):
  - `liveChains`, `liveKindsOfHolder(db, address, nowIso)` (by `user_address`, no index), `isLiveEntry({status, endAt}, nowIso)` (`vetra-licensing/lifecycle.ts`).
  - The licensing indexes are `app_license_grants_app_id_idx` and `app_license_grants_user_did_idx` (`vetra-licensing/db/migrations.ts` lines ~93 and ~140). There is none on `(app_id, user_address)`.
- **Plans** (`plans/service.ts`): `checkTarget(deps, appId, version)` is used by `createPlan` and `setPlanTarget` (release, not build). `releases.powerhouse_version` holds what the image was built on (e.g. `6.2.3-dev.101`). `releases/version.ts` has `parseVersion` and `compareReleases`; the latter throws on non-release prereleases such as `-dev.N`.
- **Shared instances:**
  - `ADMINS` = `adminsOf(app, row)`, which for shared is `app.owner_address`.
  - Health probes hit `/ready` (`/health` on older hosts) and `/`, all of which stay open under the gate (H1).
  - Instance writes go through `updateInstance`, and audit uses `recordAudit`/`auditCaller` with `AUDIT_ACTIONS` (`audit/repo.ts`).
- **Staging values** (`powerhouse-k8s-hosting/tenants/staging/powerhouse-values.yaml`): `VETRA_APPS_PLANS: "on"`, `VETRA_APPS_INSTANCE_HEALTH: enforce`, pinned `0.0.117`.
- **Monorepo** (`/home/froid/projects/powerhouse`, `packages/reactor-api` 6.2.3-dev.101): see part B, "What exists".

## The contract (both parts build against this)

```
POST <VETRA_GATE_URL>                      (…/api/@powerhousedao/vetra-cloud-package/apps/gate/check)
Authorization: Bearer <VETRA_GATE_TOKEN>   (vgt_ + 64 hex)
Content-Type: application/json
{ "address": "0x<40 hex>" }

200 { "allowed": true,  "reason": "admin" | "licence" | "member", "until": ISO | null, "ttlSeconds": 1..60 }
200 { "allowed": false, "reason": "none", "until": null, "ttlSeconds": 15 }
400 { "error": "BAD_USER_INPUT", "message": … }     bad body/address (host: refuse, no grace, log)
401 { "error": "UNAUTHENTICATED", "message": … }    missing/unknown/retired token (host: refuse non-admins, no grace, log error)
429 { "error": "RATE_LIMITED", … } + Retry-After     (host: treat as unavailable → grace)
503 { "error": "SERVICE_UNAVAILABLE", … }           (host: grace)
Every answer: cache-control: no-store.
```

The host calls only for callers who are not in its own `ADMINS`, so `admin` is there for completeness and tests. `until` is informational. The host obeys `ttlSeconds`.

## Global Constraints

- Additive schema only, through idempotent, race-tolerant `ensure…` migrations in the schema builder (namespaced). The licensing index goes into `vetra-licensing`'s own migrations.
- Nothing changes for branch, preview or own instances, and nothing changes with `VETRA_APPS_GATE` off: no token rows, no extra env, the same settings revisions (tested).
- A token's plaintext exists only in memory while it is generated and while it is delivered. It never reaches a log line, an audit row, an error message or a GraphQL answer.
- The route never says *why* a token is unknown (unknown, retired or removed are all 401 with the same text).
- Commits: one per task, conventional (`feat(gate): …`, `feat(plans): …`, `feat(licensing): …`), trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Branch `feat/releases-phase-3-licence-gate` from `main`.
- Checks after every task: `npx vitest run <the task's test files> 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. At the end: `npm run tsc`, `npm run lint`, `npx vitest run subgraphs/vetra-apps subgraphs/vetra-licensing subgraphs/vetra-cloud-secrets shared 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`.
- No production pin of vetra-cloud-package while a Sektar gated rollout is APPLYING (overview rule 4): check `vetraReleases.rollouts(appId: "43622402-be06-435a-bbfa-bb649b0d6244")` first.
- No customer goes on a shared plan in production before both parts are live and Task 13 passed on staging (overview slice 1 risk).

## File structure (part A)

| File | Change |
|---|---|
| `subgraphs/vetra-apps/config.ts` | `GateConfig`, `DEFAULT_GATE`, `gateConfigOf`, `gateConfig(env)`; `VetraAppsConfig.gate?` |
| `subgraphs/vetra-apps/db/schema.ts` | `InstanceGateTokensTable`; `VetraAppsDB.instance_gate_tokens` |
| `subgraphs/vetra-apps/db/migrations.ts` | `ensureInstanceGateTokensTable` in `up` |
| `subgraphs/vetra-licensing/db/migrations.ts` | index `app_license_grants_app_user_idx (app_id, user_address)` |
| `subgraphs/vetra-apps/gate/token.ts` (new) | `newGateToken`, `hashGateToken`, `isGateTokenShape` |
| `subgraphs/vetra-apps/gate/repo.ts` (new) | row reads/writes: `getGateToken`, `insertGateToken`, `lockGateToken`, `replaceGateToken`, `markGateDelivered`, `deleteGateToken`, `findByTokenHash` |
| `subgraphs/vetra-apps/gate/service.ts` (new) | `ensureGateToken`, `rotateInstanceGateToken`, `withGate`, `GATE_*` names, `gateFloorError`, `instanceGateJson` |
| `subgraphs/vetra-apps/gate/check.ts` (new) | `checkGate` (the decision), `GateAnswer` |
| `subgraphs/vetra-apps/gate/limit.ts` (new) | `TokenBucket`, `GateCounters` |
| `subgraphs/vetra-apps/gate/routes.ts` (new) | `createGateRoutes(deps, opts)` |
| `subgraphs/vetra-apps/plans/holders.ts` | `liveLicenceOf` |
| `subgraphs/vetra-apps/releases/version.ts` | `compareSemver`, `powerhouseAtLeast` |
| `subgraphs/vetra-apps/settings/names.ts` | `VETRA_SHARED_SETTINGS` (display) |
| `subgraphs/vetra-apps/settings/service.ts` | `vetraShared: VETRA_SHARED_SETTINGS` when the gate is on |
| `subgraphs/vetra-cloud-secrets/services/secrets-service.ts` | `VETRA_GATE_TOKEN` in `PLATFORM_MANAGED_KEYS` |
| `subgraphs/vetra-apps/instances/reconciler.ts` | gate settings for shared rows; `markGateDelivered` after delivery; `deleteGateToken` in `forgetTenant` |
| `subgraphs/vetra-apps/plans/service.ts` | `checkTarget(…, access)` applies D9 |
| `subgraphs/vetra-apps/audit/repo.ts` | `gate.token_issued`, `gate.token_rotated` |
| `subgraphs/vetra-apps/instances/service.ts`, `schema.ts`, `resolvers.ts` | `AppInstance.gate`, `rotateInstanceGateToken` |
| `subgraphs/vetra-apps/index.ts` | register `apps/gate/check`, counters log |
| Tests (new) | `__tests__/gate-config.test.ts` (or in `config.test.ts`), `gate-token.test.ts`, `gate-check.test.ts`, `gate-routes.test.ts`, `instances-gate.test.ts`, `plans-gate-floor.test.ts` |

---

## Part A — Vetra

### Task 0: Pre-flight (no code)

- [ ] **Step 1: Branch.** `git fetch && git checkout -b feat/releases-phase-3-licence-gate origin/main`. Never stash, and never touch the other worktrees of this repository (`git worktree list` shows them).
- [ ] **Step 2: Baseline.** `npx vitest run subgraphs/vetra-apps subgraphs/vetra-licensing shared 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Record failures that exist before any change in the PR description; do not fix them here.

---

### Task 1: The gate config

**Files:**
- Modify: `subgraphs/vetra-apps/config.ts`
- Test: `subgraphs/vetra-apps/__tests__/config.test.ts`

**Interfaces:**
- Produces: `GateConfig { enabled: boolean; url: string | null; minPowerhouse: string | null }`; `DEFAULT_GATE`; `gateConfigOf(cfg): GateConfig`; `VetraAppsConfig.gate?: GateConfig` (absent = off, so hand-built test configs stay valid).

- [ ] **Step 1: Write the failing test.** Append to `config.test.ts`:

```ts
describe("gate config", () => {
  const base = { VETRA_APPS_GATE_URL: "https://switchboard.staging.vetra.io/api/@powerhousedao/vetra-cloud-package/apps/gate/check", VETRA_APPS_GATE_MIN_POWERHOUSE: "6.2.3-dev.102" };
  it("is off by default and needs nothing then", () => {
    expect(gateConfigOf(loadAppsConfig({}))).toEqual({ enabled: false, url: null, minPowerhouse: null });
  });
  it("reads the URL and the Powerhouse floor when on", () => {
    expect(loadAppsConfig({ VETRA_APPS_GATE: "on", ...base }).gate).toEqual({
      enabled: true, url: base.VETRA_APPS_GATE_URL, minPowerhouse: "6.2.3-dev.102",
    });
  });
  it("refuses to start when on without a URL or floor, or with bad values", () => {
    expect(() => loadAppsConfig({ VETRA_APPS_GATE: "on" })).toThrow(/VETRA_APPS_GATE_URL/);
    expect(() => loadAppsConfig({ VETRA_APPS_GATE: "on", VETRA_APPS_GATE_URL: base.VETRA_APPS_GATE_URL })).toThrow(/VETRA_APPS_GATE_MIN_POWERHOUSE/);
    expect(() => loadAppsConfig({ VETRA_APPS_GATE: "on", ...base, VETRA_APPS_GATE_URL: "http://x/gate/check" })).toThrow(/https/);
    expect(() => loadAppsConfig({ VETRA_APPS_GATE: "on", ...base, VETRA_APPS_GATE_MIN_POWERHOUSE: "six" })).toThrow(/semver/);
    expect(() => loadAppsConfig({ VETRA_APPS_GATE: "maybe" })).toThrow(/on\/off/);
  });
});
```

Import `gateConfigOf` from `../config.js`.

- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/config.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL.
- [ ] **Step 3: Implement.** In `config.ts`, after `plansConfigOf`:

```ts
/**
 * The licence gate of shared instances (releases phase 3 slice 5). Absent = off.
 * VETRA_APPS_GATE=on gives shared instances ACCESS=licensed, VETRA_APP_ID,
 * VETRA_GATE_URL (= VETRA_APPS_GATE_URL, no default: a staging Vetra must never
 * point hosts at production) and a VETRA_GATE_TOKEN; VETRA_APPS_GATE_MIN_POWERHOUSE
 * is the first Powerhouse with ACCESS=licensed (D9).
 */
export interface GateConfig {
  enabled: boolean;
  url: string | null;
  minPowerhouse: string | null;
}

export const DEFAULT_GATE: GateConfig = { enabled: false, url: null, minPowerhouse: null };

export const gateConfigOf = (cfg: VetraAppsConfig): GateConfig => cfg.gate ?? DEFAULT_GATE;
```

Add `gate?: GateConfig;` to `VetraAppsConfig` with a doc comment pointing at `GateConfig`. Add the parser next to `plansConfig`, importing `parseVersion` from `./releases/version.js`:

```ts
function gateConfig(env: Env): GateConfig {
  const raw = (trimmed(env.VETRA_APPS_GATE) ?? "").toLowerCase();
  if (!INSTANCES_OFF.has(raw) && !INSTANCES_ON.has(raw))
    throw new Error(`VETRA_APPS_GATE "${env.VETRA_APPS_GATE}" is invalid: use on/off (also true/false, 1/0, yes/no)`);
  if (raw === "" || INSTANCES_OFF.has(raw)) return DEFAULT_GATE;
  const url = trimmed(env.VETRA_APPS_GATE_URL);
  if (!url) throw new Error("VETRA_APPS_GATE=on needs VETRA_APPS_GATE_URL (the …/apps/gate/check URL hosts call)");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`VETRA_APPS_GATE_URL "${url}" is not a URL`);
  }
  if (parsed.protocol !== "https:" || !parsed.pathname.endsWith("/apps/gate/check"))
    throw new Error(`VETRA_APPS_GATE_URL "${url}" must be an https URL ending in /apps/gate/check`);
  const min = trimmed(env.VETRA_APPS_GATE_MIN_POWERHOUSE);
  if (!min) throw new Error("VETRA_APPS_GATE=on needs VETRA_APPS_GATE_MIN_POWERHOUSE (the first Powerhouse with ACCESS=licensed)");
  if (!parseVersion(min))
    throw new Error(`VETRA_APPS_GATE_MIN_POWERHOUSE "${min}" is not a semver version`);
  return { enabled: true, url, minPowerhouse: min };
}
```

In `loadAppsConfig`, add `gate: gateConfig(env),` after `plans`.

- [ ] **Step 4: Run it again.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** `git add subgraphs/vetra-apps/config.ts subgraphs/vetra-apps/__tests__/config.test.ts && git commit -m "feat(gate): VETRA_APPS_GATE config (URL and Powerhouse floor required when on)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 2: `instance_gate_tokens` and the licensing index

**Files:**
- Modify: `subgraphs/vetra-apps/db/schema.ts`, `subgraphs/vetra-apps/db/migrations.ts`, `subgraphs/vetra-licensing/db/migrations.ts`
- Create: `subgraphs/vetra-apps/gate/repo.ts`
- Test: `subgraphs/vetra-apps/__tests__/migrations.test.ts`, `subgraphs/vetra-apps/__tests__/gate-token.test.ts` (repo part)

**Interfaces:**
- Produces (schema):

```ts
/** One gate token per shared instance (releases phase 3 slice 5). Plaintext is never stored. */
export interface InstanceGateTokensTable {
  instance_id: string;
  app_id: string;
  /** sha256 hex of the current token: what apps/gate/check verifies. */
  token_hash: string;
  /** The current token under the app-settings transit key: what delivery decrypts (G1). */
  token_ciphertext: string;
  /** Changes with every token: the ResolvedSecret writeId, so the settings revision moves. */
  token_id: string;
  /** The token before the last rotation, accepted while previous_until is null (new one not delivered) or in the future. */
  previous_hash: string | null;
  previous_until: string | null;
  /** When the current token reached the tenant; null until then. */
  delivered_at: string | null;
  created_at: string;
  rotated_at: string;
}
```

  plus `VetraAppsDB.instance_gate_tokens: InstanceGateTokensTable`.
- Produces (migrations): `ensureInstanceGateTokensTable(db)`, which builds:
  - the primary key `instance_id`;
  - the unique index `instance_gate_tokens_hash_uq (token_hash)`;
  - the index `instance_gate_tokens_previous_idx (previous_hash)`;
  - a call at the end of `up`.
- Produces (licensing): index `app_license_grants_app_user_idx` on `app_license_grants (app_id, user_address)`, created `ifNotExists`, race-tolerant.
- Produces (`gate/repo.ts`):
  - `GateTokenRow = Selectable<InstanceGateTokensTable>`;
  - `getGateToken(db, instanceId)`;
  - `insertGateToken(db, row): Promise<GateTokenRow | null>` (`ON CONFLICT (instance_id) DO NOTHING`, returning null when it existed);
  - `lockGateToken(trx, instanceId)` (`FOR UPDATE`);
  - `replaceGateToken(trx, instanceId, next: { token_hash; token_ciphertext; token_id }, nowIso)`;
  - `markGateDelivered(db, instanceId, tokenId, nowIso, graceMs): Promise<boolean>`;
  - `deleteGateToken(db, instanceId)`;
  - `findByTokenHash(db, hash, nowIso): Promise<GateTokenRow | null>`.

- [ ] **Step 1: Write the failing tests.**
  - In `migrations.test.ts`, following the `ensureAppRolesTable` test: `up` twice, insert a row, and expect a second row with the same `token_hash` to fail with a unique violation.
  - In `gate-token.test.ts` (new, using `makeHarness`):

```ts
const T = (n: string) => ({ token_hash: n.repeat(64), token_ciphertext: `vault:${n}`, token_id: `tid-${n}` });
it("finds a row by its current hash, and by the previous one only while it is accepted", async () => {
  const now = "2026-11-12T10:00:00.000Z";
  await insertGateToken(h.db, { instance_id: "i1", app_id: "a1", ...T("a"), previous_hash: null, previous_until: null, delivered_at: now, created_at: now, rotated_at: now });
  expect((await findByTokenHash(h.db, "a".repeat(64), now))?.instance_id).toBe("i1");
  await h.db.transaction().execute(async (trx) => {
    await lockGateToken(trx, "i1");
    await replaceGateToken(trx, "i1", T("b"), now);
  });
  // Not delivered yet: both work.
  expect((await findByTokenHash(h.db, "a".repeat(64), now))?.instance_id).toBe("i1");
  expect((await findByTokenHash(h.db, "b".repeat(64), now))?.instance_id).toBe("i1");
  expect(await markGateDelivered(h.db, "i1", "tid-b", now, 15 * 60_000)).toBe(true);
  expect(await markGateDelivered(h.db, "i1", "tid-b", now, 15 * 60_000)).toBe(false); // once
  expect(await findByTokenHash(h.db, "a".repeat(64), "2026-11-12T10:14:00.000Z")).not.toBeNull();
  expect(await findByTokenHash(h.db, "a".repeat(64), "2026-11-12T10:16:00.000Z")).toBeNull();
});
it("a second rotation before delivery keeps the delivered token as the previous one", async () => {
  const now = "2026-11-12T10:00:00.000Z";
  await insertGateToken(h.db, { instance_id: "i1", app_id: "a1", ...T("a"), previous_hash: null, previous_until: null, delivered_at: now, created_at: now, rotated_at: now });
  for (const n of ["b", "c"])
    await h.db.transaction().execute(async (trx) => {
      await lockGateToken(trx, "i1");
      await replaceGateToken(trx, "i1", T(n), now);
    });
  const row = (await getGateToken(h.db, "i1"))!;
  expect(row.previous_hash).toBe("a".repeat(64));
  expect(row.token_hash).toBe("c".repeat(64));
  expect(await findByTokenHash(h.db, "b".repeat(64), now)).toBeNull();
});
```

- [ ] **Step 2: Run them.** Expected: FAIL (no table, no repo).
- [ ] **Step 3: Implement.**
  - **Migration.** In `db/migrations.ts`, follow the `ensureAppAuditTable` pattern (create table `ifNotExists` in try/catch with `isConcurrentIndexError`, then the indexes in a loop). The columns are `varchar(64)` for ids, hashes and timestamps, `varchar(255)` for `app_id`, and `text` for `token_ciphertext`. Call it after `ensureAppRolesTable(db)` in `up`.
  - **Licensing index.** In `vetra-licensing/db/migrations.ts`, add a `createIndex("app_license_grants_app_user_idx").ifNotExists().on("app_license_grants").columns(["app_id", "user_address"])` in a try/catch that tolerates the concurrent-create error, as that file already does for its indexes. Call it at the end of that file's `up`.
  - **Repo.** `gate/repo.ts` (schema builder only, so it resolves in the namespace):

```ts
export async function replaceGateToken(
  trx: Kysely<VetraAppsDB>,
  instanceId: string,
  next: Pick<GateTokenRow, "token_hash" | "token_ciphertext" | "token_id">,
  nowIso: string,
): Promise<GateTokenRow> {
  const cur = await lockGateToken(trx, instanceId);
  if (!cur) throw new Error(`No gate token for instance ${instanceId}`);
  // Only a delivered token can be in pods: an undelivered one is simply replaced (G3).
  const keepPrevious = cur.delivered_at === null;
  return trx
    .updateTable("instance_gate_tokens")
    .set({
      ...next,
      previous_hash: keepPrevious ? cur.previous_hash : cur.token_hash,
      previous_until: keepPrevious ? cur.previous_until : null,
      delivered_at: null,
      rotated_at: nowIso,
    })
    .where("instance_id", "=", instanceId)
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function markGateDelivered(db: Kysely<VetraAppsDB>, instanceId: string, tokenId: string, nowIso: string, graceMs: number): Promise<boolean> {
  const until = new Date(Date.parse(nowIso) + graceMs).toISOString();
  const r = await db
    .updateTable("instance_gate_tokens")
    .set((eb) => ({
      delivered_at: nowIso,
      // Grace starts now for a previous token waiting on this delivery.
      previous_until: eb.case().when("previous_hash", "is not", null).then(until).else(null).end(),
    }))
    .where("instance_id", "=", instanceId)
    .where("token_id", "=", tokenId)
    .where("delivered_at", "is", null)
    .executeTakeFirst();
  return Number(r.numUpdatedRows) > 0;
}

export async function findByTokenHash(db: Kysely<VetraAppsDB>, hash: string, nowIso: string): Promise<GateTokenRow | null> {
  return (
    (await db
      .selectFrom("instance_gate_tokens")
      .selectAll()
      .where((eb) =>
        eb.or([
          eb("token_hash", "=", hash),
          eb.and([
            eb("previous_hash", "=", hash),
            eb.or([eb("previous_until", "is", null), eb("previous_until", ">", nowIso)]),
          ]),
        ]),
      )
      .executeTakeFirst()) ?? null
  );
}
```

  The lookup is by equality on an indexed sha256, so a comparison that leaks timing reveals nothing usable: the attacker controls the input, not the hash. The others (`getGateToken`, `insertGateToken`, `lockGateToken`, `deleteGateToken`) are one statement each.
- [ ] **Step 4: Run them again.** Expected: PASS. Also run `npx vitest run subgraphs/vetra-licensing 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`.
- [ ] **Step 5: Commit.** `git add -A subgraphs/vetra-apps/db subgraphs/vetra-apps/gate/repo.ts subgraphs/vetra-licensing/db/migrations.ts subgraphs/vetra-apps/__tests__/migrations.test.ts subgraphs/vetra-apps/__tests__/gate-token.test.ts && git commit -m "feat(gate): instance_gate_tokens table and repo; licence index by holder" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 3: Issuing and rotating tokens

**Files:**
- Create: `subgraphs/vetra-apps/gate/token.ts`, `subgraphs/vetra-apps/gate/service.ts`
- Modify: `subgraphs/vetra-apps/audit/repo.ts`, `subgraphs/vetra-cloud-secrets/services/secrets-service.ts`
- Test: `subgraphs/vetra-apps/__tests__/gate-token.test.ts`

**Interfaces:**
- Produces (`gate/token.ts`):
  - `GATE_TOKEN_PREFIX = "vgt_"`;
  - `newGateToken(): string` (`vgt_` + `randomBytes(32).toString("hex")`);
  - `hashGateToken(t): string` (sha256 hex);
  - `isGateTokenShape(t): boolean` (`/^vgt_[0-9a-f]{64}$/`).
- Produces (`gate/service.ts`):
  - `GATE_ACCESS_ENV = "ACCESS"`, `GATE_APP_ID_ENV = "VETRA_APP_ID"`, `GATE_URL_ENV = "VETRA_GATE_URL"`, `GATE_TOKEN_ENV = "VETRA_GATE_TOKEN"`, `GATE_PREVIOUS_GRACE_MS = 15 * 60_000`;
  - `ensureGateToken(deps, row: InstanceRow): Promise<GateTokenRow>`: issues once, audited `gate.token_issued` (actor `vetra`, source `system`) in the insert's transaction;
  - `rotateInstanceGateToken(deps, caller, instanceId): Promise<GateTokenRow>`: `need: "release"`, shared only, audited `gate.token_rotated` via `auditCaller`.
- Produces (audit): `"gate.token_issued"` and `"gate.token_rotated"` appended to `AUDIT_ACTIONS`. The subject is `instance:<id>`; the detail is `{ name, planId, tokenId }`, never the token or its hash.
- Produces (secrets): `"VETRA_GATE_TOKEN"` in `PLATFORM_MANAGED_KEYS`, with its writer named in the doc comment list (`vetra-apps/settings/deliver.ts` via the gate).

- [ ] **Step 1: Write the failing tests** (append to `gate-token.test.ts`; set up a shared plan row and its instance row with `insertPlan` and `insertInstance` as in `instances-plans.test.ts`, App owner `OWNER`, `testConfig({ plans: …, gate: GATE_ON })` where `GATE_ON = { enabled: true, url: "https://switchboard.staging.vetra.io/api/@powerhousedao/vetra-cloud-package/apps/gate/check", minPowerhouse: "6.2.3-dev.102" }`):
  - `ensureGateToken` twice → one row, the same `token_id`; one `gate.token_issued` audit row; `fakeVault().decrypt(row.token_ciphertext)` matches `isGateTokenShape` and `hashGateToken(plain) === row.token_hash`.
  - `JSON.stringify(await h.db.selectFrom("app_audit").selectAll().execute())` contains neither the plaintext nor the hash.
  - `rotateInstanceGateToken(h.deps, owner, id)` → a new `token_id`, `previous_hash` = the old hash, and an audit `gate.token_rotated` with actor `OWNER`. As `stranger` → FORBIDDEN. For an own instance → BAD_USER_INPUT `"Only shared instances have a gate token"`. For a shared instance without a row yet → BAD_USER_INPUT `"The instance has no gate token yet"`.
  - Without `deps.settingsVault` → SERVICE_NOT_CONFIGURED.
  - `PLATFORM_MANAGED_KEYS.has("VETRA_GATE_TOKEN")`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** `gate/service.ts`:

```ts
export async function ensureGateToken(deps: AppsDeps, row: InstanceRow): Promise<GateTokenRow> {
  const have = await getGateToken(deps.db, row.id);
  if (have) return have;
  const vault = deps.settingsVault;
  if (!vault) throw notConfigured("The licence gate (OPENBAO_ADDR)");
  const token = newGateToken();
  const nowIso = deps.now().toISOString();
  const fresh = {
    instance_id: row.id,
    app_id: row.app_id,
    token_hash: hashGateToken(token),
    token_ciphertext: await vault.encrypt(token),
    token_id: deps.newId(),
    previous_hash: null,
    previous_until: null,
    delivered_at: null,
    created_at: nowIso,
    rotated_at: nowIso,
  };
  const made = await deps.db.transaction().execute(async (trx) => {
    const inserted = await insertGateToken(trx, fresh);
    if (inserted)
      await recordAudit(trx, {
        appId: row.app_id,
        at: nowIso,
        actor: AUDIT_SYSTEM_ACTOR,
        source: "system",
        action: "gate.token_issued",
        subject: `instance:${row.id}`,
        detail: { name: row.name, planId: row.plan_id ?? null, tokenId: fresh.token_id },
      });
    return inserted;
  });
  // A concurrent pass inserted first: use its token.
  return made ?? (await getGateToken(deps.db, row.id))!;
}

export async function rotateInstanceGateToken(deps: AppsDeps, caller: Caller, instanceId: string): Promise<GateTokenRow> {
  const row = await getInstance(deps.db, instanceId);
  if (!row) throw appsError("NOT_FOUND", "Instance not found");
  await loadAppForOwner(deps, caller, row.app_id, { need: "release" });
  if (row.kind !== "shared") throw appsError("BAD_USER_INPUT", "Only shared instances have a gate token");
  const vault = deps.settingsVault;
  if (!vault) throw notConfigured("The licence gate (OPENBAO_ADDR)");
  const token = newGateToken();
  const next = { token_hash: hashGateToken(token), token_ciphertext: await vault.encrypt(token), token_id: deps.newId() };
  const nowIso = deps.now().toISOString();
  return deps.db.transaction().execute(async (trx) => {
    if (!(await lockGateToken(trx, row.id)))
      throw appsError("BAD_USER_INPUT", "The instance has no gate token yet");
    const after = await replaceGateToken(trx, row.id, next, nowIso);
    await auditCaller(trx, caller, {
      appId: row.app_id,
      at: nowIso,
      action: "gate.token_rotated",
      subject: `instance:${row.id}`,
      detail: { name: row.name, planId: row.plan_id ?? null, tokenId: next.token_id },
    });
    return after;
  });
}
```

  `replaceGateToken` locks again inside; the second `FOR UPDATE` in the same transaction is a no-op.
- [ ] **Step 4: Run them again.** Expected: PASS. Also `npx vitest run subgraphs/vetra-cloud-secrets 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`.
- [ ] **Step 5: Commit.** `git commit -am "feat(gate): issue and rotate per-instance gate tokens, audited" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"` (add the new files first).

---

### Task 4: Gate settings on shared instances (delivery through settings)

**Files:**
- Modify: `subgraphs/vetra-apps/gate/service.ts` (`withGate`), `subgraphs/vetra-apps/instances/reconciler.ts`, `subgraphs/vetra-apps/settings/names.ts`, `subgraphs/vetra-apps/settings/service.ts`
- Test: `subgraphs/vetra-apps/__tests__/instances-gate.test.ts` (new)

**Interfaces:**
- Produces: `withGate(base: InstanceSettings, gate: { appId: string; url: string; token: Pick<GateTokenRow, "token_ciphertext" | "token_id"> }): InstanceSettings`. It merges three plain entries and one secret and recomputes `revision` with `settingsRevision`. Names cannot collide with publisher settings (all reserved), but `withGate` still drops any base entry with a gate name before merging (defence).
- Produces: `VETRA_SHARED_SETTINGS: VetraSetting[]` (ACCESS, VETRA_APP_ID, VETRA_GATE_URL, VETRA_GATE_TOKEN, each with "shared instances only" in `value`). `appSettings` returns them under a new field `vetraShared` when the gate is on (GraphQL in Task 8).
- Changes (reconciler):
  - `reconcileApp`: for each row with `kind === "shared"`, while `gateConfigOf(deps.cfg).enabled` and `!row.removed_at`: `settings = withGate(base, { appId: app.id, url: gate.url!, token: await ensureGateToken(deps, row) })`. This sits inside the existing per-row `try`, so a vault failure fails that row with its reason, as other settings failures do.
  - `reconcileEnvironment`: after the successful `deliverSettings` and its `patch`, `const gateSecret = settings.secrets.find((s) => s.name === GATE_TOKEN_ENV); if (gateSecret) await markGateDelivered(deps.db, row.id, gateSecret.writeId, deliveredAt, GATE_PREVIOUS_GRACE_MS);`.
  - `forgetTenant`: also `await deleteGateToken(deps.db, row.id)` (the purge removed the token from the tenant; a fresh one is issued on the next pass).

- [ ] **Step 1: Write the failing tests** (`instances-gate.test.ts`, harness and setup as in `instances-plans.test.ts`, with `gate: GATE_ON` in `testConfig`, a shared plan `starter` targeting `1.4.0`):
  - **Env and tenant.** One `reconcileInstancesOnce` pass, then mark the environment `READY` and run another. The shared environment's `fusion.env` has `ACCESS=licensed`, `VETRA_APP_ID=<appId>`, `VETRA_GATE_URL=<GATE_ON.url>` (plain) and `VETRA_GATE_TOKEN` (`isSecret: true`, value null). The tenant store (`h.secrets.store.get(tenantId)`) holds a `VETRA_GATE_TOKEN` whose `hashGateToken` equals the row's `token_hash`, and the row's `delivered_at` is set.
  - **Rotation is a settings change.** Record `target_settings`, rotate, run a pass. `target_settings` changed, the tenant holds the new token, `previous_hash` is the old one, and `previous_until` is `delivered_at + 15 min`.
  - **Gate off.** The same App with `testConfig` without `gate`: no `ACCESS` in env, no row in `instance_gate_tokens`. With the same publisher settings, `target_settings` is exactly what `settingsForKind(rows, "shared").revision` gives (unchanged by this slice).
  - **Other kinds untouched.** An own plan with a holder (`seedLicence`) and a branch instance get no gate env and no token rows.
  - **Switching off later.** Turn the gate on, run passes until delivered, then rebuild the harness config with the gate off (`h.deps.cfg = testConfig({ plans })`) and run a pass. `ACCESS` is gone from env and `VETRA_GATE_TOKEN` is deleted from the tenant (the existing "declared but no longer wanted" path).
  - **Recreation.** Delete the environment (`h.envs.delete(envId)`) and run a pass. The purge ran (`h.secrets.purged`), the token row is gone, and the next passes issue a new `token_id` (one more `gate.token_issued` audit row).
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** `withGate`:

```ts
const GATE_NAMES = new Set([GATE_ACCESS_ENV, GATE_APP_ID_ENV, GATE_URL_ENV, GATE_TOKEN_ENV]);
const byName = <T extends { name: string }>(a: T, b: T) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

export function withGate(base: InstanceSettings, gate: { appId: string; url: string; token: Pick<GateTokenRow, "token_ciphertext" | "token_id"> }): InstanceSettings {
  const plain = [
    ...base.plain.filter((p) => !GATE_NAMES.has(p.name)),
    { name: GATE_ACCESS_ENV, value: "licensed" },
    { name: GATE_APP_ID_ENV, value: gate.appId },
    { name: GATE_URL_ENV, value: gate.url },
  ].sort(byName);
  const secrets = [
    ...base.secrets.filter((s) => !GATE_NAMES.has(s.name)),
    { name: GATE_TOKEN_ENV, ciphertext: gate.token.token_ciphertext, writeId: gate.token.token_id },
  ].sort(byName);
  return { revision: settingsRevision(plain, secrets), plain, secrets };
}
```

  Then wire the reconciler as in Interfaces, and add `VETRA_SHARED_SETTINGS` plus the `vetraShared` field in `appSettingsFor` (filled only when the gate is on, else `[]`).
- [ ] **Step 4: Run them again,** plus the existing instance suites: `npx vitest run subgraphs/vetra-apps/__tests__/instances-*.test.ts subgraphs/vetra-apps/__tests__/settings-*.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(gate): shared instances get ACCESS=licensed, VETRA_APP_ID, VETRA_GATE_URL and their token through settings" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"` (after `git add` of the touched files).

---

### Task 5: The decision (`checkGate`) and `liveLicenceOf`

**Files:**
- Modify: `subgraphs/vetra-apps/plans/holders.ts`
- Create: `subgraphs/vetra-apps/gate/check.ts`
- Test: `subgraphs/vetra-apps/__tests__/gate-check.test.ts` (new), `subgraphs/vetra-apps/__tests__/plans-holders.test.ts`

**Interfaces:**
- Produces (`holders.ts`): `liveLicenceOf(db: Kysely<VetraLicensingDB>, appId, kind, address, nowIso): Promise<{ until: string | null } | null>`. Live means `isLiveEntry`. `until` is null if any live licence is open-ended, else the latest `end_at`.
- Produces (`check.ts`):

```ts
export type GateReason = "admin" | "licence" | "member" | "none";
export interface GateAnswer { allowed: boolean; reason: GateReason; until: string | null; ttlSeconds: number }
export const GATE_TTL_SECONDS = 60;
export const GATE_DENIED_TTL_SECONDS = 15;
export const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** null: the token is unknown, retired, or not a live shared instance's (→ 401). */
export async function checkGate(deps: AppsDeps, token: string, address: string): Promise<{ instanceId: string; answer: GateAnswer } | null>;
```

- [ ] **Step 1: Write the failing tests.**
  - In `plans-holders.test.ts`, for `liveLicenceOf`:
    - ACTIVE with no end → `{ until: null }`;
    - two live licences with ends → the later end;
    - EXPIRED, or ACTIVE past its end → null;
    - another kind, another App, another address → null;
    - address case-insensitive.
  - In `gate-check.test.ts` (shared plan of kind `starter`, its instance, `ensureGateToken` → decrypt with `fakeVault()` to get the plaintext):
    - The owner → `{ allowed: true, reason: "admin", until: null, ttlSeconds: 60 }`.
    - A holder of `starter` with `endAt` 30 s ahead → `{ allowed: true, reason: "licence", until: <end>, ttlSeconds: 30 }`. With `endAt` a day ahead → `ttlSeconds: 60`.
    - A holder of another kind, or a stranger → `{ allowed: false, reason: "none", until: null, ttlSeconds: 15 }`.
    - After the licence's lifecycle goes EXPIRED → `none` on the next call (no cache).
    - A retired plan with a live holder → still `licence`.
    - An unknown token, a malformed token (`"abc"`), the previous token after its grace, the token of a removed instance (`removed_at` set) → `null`.
    - The token of an instance whose `kind` is not shared (row forged into the table) → `null`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**

```ts
export async function checkGate(deps: AppsDeps, token: string, address: string) {
  if (!isGateTokenShape(token)) return null;
  const nowIso = deps.now().toISOString();
  const gate = await findByTokenHash(deps.db, hashGateToken(token), nowIso);
  if (!gate) return null;
  const row = await getInstance(deps.db, gate.instance_id);
  if (!row || row.kind !== "shared" || row.removed_at || !row.plan_id) return null;
  const [plan, app] = await Promise.all([getPlan(deps.db, row.plan_id), getApp(deps.db, row.app_id)]);
  if (!plan || !app) return null;
  const who = address.toLowerCase();
  if (adminsOf(app, row).split(",").map((a) => a.trim().toLowerCase()).includes(who))
    return { instanceId: row.id, answer: { allowed: true, reason: "admin", until: null, ttlSeconds: GATE_TTL_SECONDS } };
  if (!deps.licensingDb) throw notConfigured("The licensing tables");
  const live = await liveLicenceOf(deps.licensingDb, app.id, plan.kind, who, nowIso);
  if (!live)
    return { instanceId: row.id, answer: { allowed: false, reason: "none", until: null, ttlSeconds: GATE_DENIED_TTL_SECONDS } };
  const left = live.until ? Math.floor((Date.parse(live.until) - Date.parse(nowIso)) / 1000) : GATE_TTL_SECONDS;
  return {
    instanceId: row.id,
    answer: { allowed: true, reason: "licence", until: live.until, ttlSeconds: Math.max(1, Math.min(GATE_TTL_SECONDS, left)) },
  };
}
```

  Import `adminsOf` from `../instances/reconciler.js`, which already exports it. `liveLicenceOf` follows `liveKindsOfHolder`: the same join, plus `where("g.app_id", "=", appId)`, `where("g.kind", "=", kind)`, `where("g.user_address", "=", address.toLowerCase())`, `where("l.status", "=", "ACTIVE")`, then `isLiveEntry` in code.
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(gate): answer per plan: admin, live licence of the plan's kind, or none" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 6: The route `POST apps/gate/check`, rate limits, counters

**Files:**
- Create: `subgraphs/vetra-apps/gate/limit.ts`, `subgraphs/vetra-apps/gate/routes.ts`
- Modify: `subgraphs/vetra-apps/index.ts`
- Test: `subgraphs/vetra-apps/__tests__/gate-routes.test.ts` (new)

**Interfaces:**
- Produces (`limit.ts`):
  - `class TokenBucket { constructor(ratePerSec, burst, maxKeys = 10_000, now = () => Date.now()); take(key: string): boolean }`. Refill is continuous. Over `maxKeys` the oldest key is evicted (Map insertion order, re-inserted on use).
  - `class GateCounters { hit(instanceId, allowed: boolean); unauthorized(); limited(); failed(); flush(): string | null }` (one line, then reset; null when nothing happened).
- Produces (`routes.ts`): `createGateRoutes(deps, opts?: { perInstance?: TokenBucket; badTokens?: TokenBucket; counters?: GateCounters }) → { check(request: Request): Promise<Response>; counters: GateCounters }`. The defaults are 50/s with a burst of 500 per instance, and 20/s with a burst of 100 for bad tokens (G6).

- [ ] **Step 1: Write the failing tests** (`gate-routes.test.ts`; `post(token, body)` builds `new Request("https://x/api/@powerhousedao/vetra-cloud-package/apps/gate/check", { method: "POST", headers: { authorization: \`Bearer ${token}\`, "content-type": "application/json" }, body: JSON.stringify(body) })`):
  - A holder → 200 with the `checkGate` answer and `cache-control: no-store`.
  - No `Authorization`, or a wrong token → 401 `{ error: "UNAUTHENTICATED", message: "Invalid gate token" }` (the same message for both).
  - A non-JSON body, a missing address, `"0x123"`, a DID → 400 `BAD_USER_INPUT`.
  - A per-instance bucket of `new TokenBucket(1, 2)`: the third call in the same instant → 429, `Retry-After: 1`, `{ error: "RATE_LIMITED" }`.
  - A bad-token bucket of `new TokenBucket(1, 1)`: the second bad token → 429 without a DB read. Spy on `h.db.selectFrom` (or count queries through a wrapping `deps.db`) and assert no lookup.
  - `deps.licensingDb` made to throw (`vi.spyOn(liveLicenceOf…)` or a closed licensing db) → 503 `SERVICE_UNAVAILABLE`, and the token never appears in `h.logs` (a capturing logger).
  - `counters.flush()` after one allowed, one denied and one 401 → a string with `checks=2 allowed=1 denied=1 unauthorized=1`, then `flush()` → null.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** `routes.ts`:

```ts
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });

export function createGateRoutes(deps: AppsDeps, opts: { perInstance?: TokenBucket; badTokens?: TokenBucket; counters?: GateCounters } = {}) {
  const perInstance = opts.perInstance ?? new TokenBucket(50, 500);
  const badTokens = opts.badTokens ?? new TokenBucket(20, 100);
  const counters = opts.counters ?? new GateCounters();
  const unauthorized = () => {
    counters.unauthorized();
    return json(401, { error: "UNAUTHENTICATED", message: "Invalid gate token" });
  };
  const limited = () => {
    counters.limited();
    return json(429, { error: "RATE_LIMITED", message: "Too many gate checks" }, { "retry-after": "1" });
  };
  return {
    counters,
    async check(request: Request): Promise<Response> {
      const m = /^Bearer\s+(\S+)$/i.exec((request.headers.get("authorization") ?? "").trim());
      const token = m?.[1] ?? "";
      if (!isGateTokenShape(token)) return badTokens.take("*") ? unauthorized() : limited();
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json(400, { error: "BAD_USER_INPUT", message: "Body must be JSON" });
      }
      const address = (body as { address?: unknown } | null)?.address;
      if (typeof address !== "string" || !ADDRESS.test(address))
        return json(400, { error: "BAD_USER_INPUT", message: "address must be a 0x address" });
      try {
        const res = await checkGate(deps, token, address);
        if (!res) return badTokens.take("*") ? unauthorized() : limited();
        if (!perInstance.take(res.instanceId)) return limited();
        counters.hit(res.instanceId, res.answer.allowed);
        return json(200, res.answer);
      } catch (err) {
        counters.failed();
        deps.logger.warn(`[vetra-apps] gate check failed: ${String(err)}`);
        return json(503, { error: "SERVICE_UNAVAILABLE", message: "Try again" });
      }
    },
  };
}
```

  The per-instance bucket is taken after the lookup: keying on unverified input would let random tokens fill the map. A bad token costs one indexed read, and the global bucket bounds those reads.

  `index.ts`, next to the CI routes:

```ts
    // Licence gate of shared instances (releases phase 3 slice 5): hosts with
    // ACCESS=licensed ask here with their instance's VETRA_GATE_TOKEN.
    // /api/@powerhousedao/vetra-cloud-package/apps/gate/check
    let gate: ReturnType<typeof createGateRoutes> | null = null;
    try {
      gate = createGateRoutes(deps);
      const g = gate;
      this.routeHandles.push(
        this.http.post("apps/gate/check", { auth: "public", maxBodyBytes: 1024 }, (request) => g.check(request)),
      );
    } catch (err) {
      console.warn(`[vetra-apps] gate route not registered: ${String(err)}`);
    }
```

  After the other `every(...)` calls: `every(5 * 60 * 1000, "gate counters", async () => { const line = gate?.counters.flush(); if (line) console.info(\`[vetra-apps] gate: ${line}\`); });`.
- [ ] **Step 4: Run them again.** Expected: PASS. Also `npx vitest run subgraphs/vetra-apps/__tests__/subgraph.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20` (route registration).
- [ ] **Step 5: Commit.** `git commit -m "feat(gate): POST apps/gate/check with per-instance rate limits and counters" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 7: D9, the Powerhouse floor for shared plans

**Files:**
- Modify: `subgraphs/vetra-apps/releases/version.ts`, `subgraphs/vetra-apps/gate/service.ts`, `subgraphs/vetra-apps/plans/service.ts`
- Test: `subgraphs/vetra-apps/__tests__/releases-version.test.ts`, `subgraphs/vetra-apps/__tests__/plans-gate-floor.test.ts` (new)

**Interfaces:**
- Produces (`version.ts`):
  - `compareSemver(a, b): number` (full semver precedence, prerelease-aware, for any parseable version, builds included);
  - `powerhouseAtLeast(v: string, min: string): boolean` (false when either does not parse).
- Produces (`gate/service.ts`): `gateFloorError(cfg, release: Pick<ReleaseRow, "version" | "powerhouse_version">): string | null` (null when the gate is off or the floor is met). Slice 3's rollout check calls it for shared plans.
- Changes: `checkTarget(deps, appId, version, access: PlanAccess)` throws `BAD_USER_INPUT` with that message for `access === "shared"`. `createPlan` passes `access`, and `setPlanTarget` passes `plan.access`.

- [ ] **Step 1: Write the failing tests.**
  - `compareSemver("6.2.3-dev.101", "6.2.3-dev.102") < 0`;
  - `compareSemver("6.2.3", "6.2.3-dev.999") > 0`;
  - `compareSemver("6.2.3-staging.1", "6.2.3-dev.5") > 0` (`staging` > `dev` lexically, which is fine: staging is cut after dev);
  - `powerhouseAtLeast("6.3.0", "6.2.3-dev.102")`;
  - `!powerhouseAtLeast("garbage", "6.2.3")`.

  In `plans-gate-floor.test.ts`, seed releases `1.4.0` (built on `6.2.3-dev.101`) and `1.5.0` (`6.2.3-dev.102`) with the gate floor at `6.2.3-dev.102`. Note that `seedRelease` must accept `powerhouse`; add the option to `instances-fixtures.ts`, defaulting to the current value.
  - `createPlan` shared with `targetVersion: "1.4.0"` → BAD_USER_INPUT matching `/built on Powerhouse 6\.2\.3-dev\.101.*6\.2\.3-dev\.102/`;
  - `createPlan` shared with `1.5.0` → ok, then `setPlanTarget(…, "1.4.0")` → refused;
  - an own plan with `1.4.0` → ok;
  - the gate off → shared with `1.4.0` ok.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**

```ts
export function gateFloorError(cfg: VetraAppsConfig, r: { version: string; powerhouse_version: string }): string | null {
  const gate = gateConfigOf(cfg);
  if (!gate.enabled || !gate.minPowerhouse) return null;
  if (powerhouseAtLeast(r.powerhouse_version, gate.minPowerhouse)) return null;
  return `${r.version} was built on Powerhouse ${r.powerhouse_version || "(unknown)"}; shared plans need ${gate.minPowerhouse} or newer for the licence gate. Rebuild the App on it and release again.`;
}
```

  `compareSemver` reuses `parseVersion` and `compareIdent`. It is the `compareReleases` body without the release-only guard, and `compareReleases` keeps its guard and calls it.
- [ ] **Step 4: Run them again,** plus `plans-api.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(plans): shared plans refuse releases built on a Powerhouse without the gate (D9)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 8: GraphQL (gate status, rotation, Vetra-set settings)

**Files:**
- Modify: `subgraphs/vetra-apps/schema.ts`, `subgraphs/vetra-apps/resolvers.ts`, `subgraphs/vetra-apps/instances/service.ts`, `subgraphs/vetra-apps/settings/service.ts`
- Test: `subgraphs/vetra-apps/__tests__/instances-api.test.ts`, `subgraphs/vetra-apps/__tests__/resolvers.test.ts` (SDL)

**Interfaces:**
- SDL:

```graphql
  "The licence gate of a shared instance (spec 5, releases phase 3 slice 5)."
  type AppInstanceGate {
    "VETRA_APPS_GATE is on: the instance is given ACCESS=licensed"
    enabled: Boolean!
    "Its running (else target) release was built on a Powerhouse that enforces ACCESS=licensed"
    active: Boolean!
    "Why not active, in words (gate off, or built on Powerhouse < X)"
    reason: String
    tokenRotatedAt: String
    "False until the current token reached the instance's secrets"
    tokenDelivered: Boolean!
  }
  # AppInstance gets:   "shared only" gate: AppInstanceGate
  # Mutation:           rotateInstanceGateToken(instanceId: ID!): AppInstance!
  # AppSettings gets:   "What Vetra sets on shared instances only (licence gate)" vetraShared: [AppVetraSetting!]!
```

  (`AppVetraSetting` is the existing type behind `vetra`; use its actual name from `schema.ts`.)
- `appInstancesFor` builds `gate` for shared rows only, via `instanceGateJson(deps, row, tokenRow, release)`. The release is the one at `running_version ?? target_version`, read once per version with `releaseByVersion`, and `active` is `gateFloorError(...) === null` with the gate on.
- The resolver: `rotateInstanceGateToken: (_, { instanceId }, ctx) => guard(deps, "rotateInstanceGateToken", async () => { await rotateInstanceGateToken(deps, person(ctx), instanceId); return instanceJsonFor(deps, instanceId); })`.

- [ ] **Step 1: Write the failing tests.**
  - `appInstances` as the owner:
    - a shared instance shows `gate { enabled: true, active: true, tokenDelivered: true }` after delivery;
    - on a release built below the floor, `active: false` with a reason naming both versions;
    - own and branch instances have `gate: null`.
  - `rotateInstanceGateToken` as a stranger → FORBIDDEN. As the owner → `gate.tokenDelivered: false` until the next pass.
  - `appSettings(appId).vetraShared` lists the four names only with the gate on.
  - The SDL test passes (every Mutation field has a resolver).
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** as in Interfaces. The token row is read with `getGateToken`. No hash, ciphertext or token id is ever returned.
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(apps): instance gate status, rotateInstanceGateToken, Vetra-set shared settings" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 9: Full checks and PR

- [ ] **Step 1: Full checks.**
  - `npm run tsc 2>&1 | tail -20`
  - `npm run lint 2>&1 | grep -E "error|✖" | head -20`
  - `npx vitest run subgraphs/vetra-apps subgraphs/vetra-licensing subgraphs/vetra-cloud-secrets shared 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`

  Expected: no new failures compared with Task 0.
- [ ] **Step 2: Secret hygiene grep.** `git diff origin/main -- . | grep -nE "console\.(log|info|warn).*token" | head`. Expected: nothing that prints a token value.
- [ ] **Step 3: PR.** `git push -u origin feat/releases-phase-3-licence-gate` and `gh pr create --title "feat(apps): licence gate for shared instances (releases phase 3, slice 5)"`. The body covers:
  - the contract;
  - the switch and its two required values;
  - G1-G12 as built;
  - that nothing changes with the switch off (tested);
  - that hosts enforce only once built on Powerhouse X (part B);
  - the staging steps below.

  End the body with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. The user merges.

---

## Part B — Powerhouse monorepo (`ACCESS=licensed`)

**Location and status.** The monorepo is at `/home/froid/projects/powerhouse` (checked 2026-11-12):
- `packages/reactor-api` and `apps/switchboard` are at `6.2.3-dev.101`;
- the local checkout is on `fix/ci-drop-vetra-e2e`, so work starts from a fresh `origin/main` branch, never from that one;
- releases go through Nx release: `main` → `dev` tag `X.Y.Z-dev.N` nightly, `release/staging/*` → `staging`, `release/production/*` → `latest`.

**What exists (paths under the monorepo):**
- **Env parsing:** `packages/reactor-api/src/api-config.ts` `reactorApiConfigFromEnv` (around lines 47-99) reads `AUTH_ENABLED`, `ADMINS`, `RESOLVE_CALLER_IDENTITY`, `REQUIRE_AUTHENTICATED_CALLER` (+ `_EXEMPT_PATHS`), `DOCUMENT_PERMISSIONS_ENABLED` and the rest into `ReactorApiConfig.auth` (type around lines 23-39).
- **Switchboard config:** `apps/switchboard/src/config/from-env.ts` spreads it. The zod `authSchema` (`apps/switchboard/src/config/schema.ts` around lines 144-175) and the compile-time key asserts (around lines 340-398) require every new auth key in both places. `config/merge.ts` `ENV_WINS_AUTH` lists the env-wins keys. `ph run <host> serve` reaches the same `switchboardConfigFromEnv` (`clis/ph-run/src/runners/member-config.ts`).
- **Policy:** `packages/reactor-api/src/server.ts` around lines 1011-1016 picks the policy: DOCUMENT_PERMISSIONS if a permission service exists, else ADMIN_ONLY if `authEnabled`, else OPEN. `AuthService` is built around lines 894-935 when `resolveCallerIdentity || authEnabled`.
- **`AuthService`** (`packages/reactor-api/src/services/auth.service.ts`):
  - `verifyBearer(authorization)` (around line 163) is async and returns `AuthContext | Response`. It answers 401 for a bad token or credential, and calls `onVerified` synchronously.
  - `authenticateWebSocketConnection(params)` (around line 219) throws on refusal.
  - `isCredentialValid(user)` (around line 316) is used by `graphql/ws-credential-monitor.ts` `recheck` to close sockets with 4403.
  - The credential cache (around lines 370-430) is a Map of promise entries with `expiresAt`, capped at 1,000 entries.
- **Who calls `verifyBearer`:**
  - the GraphQL fetch chain (`graphql/gateway/auth-middleware.ts`, then `require-auth-middleware.ts`, composed in `graphql-manager.ts` `#composeFetchMiddleware`: subgraphs, supergraph, SSE);
  - subgraph HTTP routes (`http/route-service.ts` `#authenticate`; `auth: "public"` and function authorizers skip it);
  - MCP (`services/mcp-request-authorizer.ts`);
  - switchboard attachments (`apps/switchboard/src/attachments/auth.ts`).

  WS goes through `graphql-manager.ts` `createWsAuthHandlers` `onConnect` → `authenticateWebSocketConnection`. `/health`, `/ready` and the explorer bypass auth. Connect is served apart (nginx or vite preview) and proxies only `/graphql`, `/d/`, `/attachments`, `/mcp` and `/api/` to the switchboard.
- **Nothing named `ACCESS`, `VETRA_GATE_*` or a licence check exists** in the monorepo. There is no LRU/TTL utility; the credential cache is the pattern to copy.
- **Tests:** vitest in `packages/reactor-api/test/`, e.g. `auth.service.test.ts` (`vi.mock("@renown/sdk")`, `makeVerified(address)`), `api-config.test.ts`, `auth-chain.test.ts`, `require-auth-middleware.test.ts`, `gateway/ws-auth-close-code.test.ts`; `apps/switchboard/test/boot-auth-config.test.ts`.

**Files (part B):**

| File | Change |
|---|---|
| `packages/reactor-api/src/services/access-gate.ts` (new) | `AccessGate` interface, `createVetraAccessGate(opts)` (fetch, 60 s cache, 24 h last-positive, in-flight sharing, cap) |
| `packages/reactor-api/src/api-config.ts` | `auth.access?: { mode: "open" \| "licensed"; gateUrl?; gateToken?; appId? }` from `ACCESS`, `VETRA_GATE_URL`, `VETRA_GATE_TOKEN`, `VETRA_APP_ID`; `ACCESS_GATE_GRACE_MS` |
| `packages/reactor-api/src/services/auth.service.ts` | `AuthConfig.accessGate?: AccessGate`; enforced in `verifyBearer`, `authenticateWebSocketConnection`, `isCredentialValid` |
| `packages/reactor-api/src/server.ts` | licensed ⇒ resolve identity + require authenticated caller; policy per H2; boot assertion (H5); gate construction |
| `apps/switchboard/src/config/schema.ts`, `config/merge.ts` | `access` in `authSchema` and the key asserts; `access` env-wins |
| `packages/reactor-api/test/access-gate.test.ts` (new) | cache, TTL, grace, statuses |
| `packages/reactor-api/test/auth.service.access-gate.test.ts` (new) | admins bypass, 403, WS, recheck |
| `packages/reactor-api/test/api-config.test.ts`, `apps/switchboard/test/boot-auth-config.test.ts` | env parsing, boot refusal, policy |

### Task B0: Pre-flight (in the monorepo; no code)

- [ ] **Step 1: Branch from main, not from the local branch.** `git -C /home/froid/projects/powerhouse fetch origin && git -C /home/froid/projects/powerhouse worktree add ../powerhouse-access-licensed -b feat/switchboard-access-licensed origin/main`. Work only in `/home/froid/projects/powerhouse-access-licensed`. Never stash, and never touch the existing checkout's branch.
- [ ] **Step 2: Baseline.** `pnpm install --frozen-lockfile --silent` then `pnpm --filter @powerhousedao/reactor-api test 2>&1 | grep -E "FAIL|Tests|failed" | tail -20` and the same for `@powerhousedao/switchboard`. Record pre-existing failures.

### Task B1: The `AccessGate` client

**Interfaces:**

```ts
export type AccessVerdict = { allowed: boolean; source: "gate" | "cache" | "grace" | "refused" };
export interface AccessGate {
  /** address is lowercased by the caller; never throws. */
  check(address: string): Promise<AccessVerdict>;
}
export interface VetraAccessGateOptions {
  url: string;
  token: string;
  appId?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  timeoutMs?: number;      // 5_000
  defaultTtlMs?: number;   // 60_000 (ttlSeconds absent or invalid)
  graceMs?: number;        // 86_400_000 (ACCESS_GATE_GRACE_MS)
  maxEntries?: number;     // 10_000
  logger?: ILogger;
}
export function createVetraAccessGate(o: VetraAccessGateOptions): AccessGate;
```

**Behaviour (each line is a test in `access-gate.test.ts`, with a fake `fetch` and a fake clock):**
- **Fresh cache.** An entry younger than its TTL (`ttlSeconds` clamped to 1-300, in ms) is answered from the cache with no fetch (`source: "cache"`). Both allowed and denied answers are cached for their TTL.
- **Shared fetches.** Concurrent `check`s of one address share one fetch.
- **The request.** `POST url` with `authorization: Bearer <token>`, `content-type: application/json`, body `{"address": "<addr>"}`, aborted after `timeoutMs`. `x-vetra-app-id: <appId>` is sent when set (informational).
- **200.** Parse `{allowed, ttlSeconds}`. A body that does not parse counts as unavailable. When allowed, record `lastPositiveAt = now`.
- **401 or 400.** Refuse (`source: "refused"`) and drop the address's last positive answer: no grace. Log at error level, once per minute at most: `"Vetra refused the gate token (401): only ADMINS can sign in"`.
- **Unavailable** (network error, timeout, 429, 5xx, any other status, bad JSON). Allowed only if `lastPositiveAt` is within `graceMs` (`source: "grace"`), else refused. Warn once per minute. The grace answer is not cached as fresh, so the next request tries Vetra again; but in-flight sharing applies, and a failing Vetra is asked at most once per address per 5 s (a backoff entry).
- **Cap.** Over `maxEntries` entries, the oldest go (Map insertion order). Grace answers live in the same entries.
- **No secrets in logs.** The token never appears in a log message or a thrown error.

- [ ] **Steps:** write the tests (fail) → implement `services/access-gate.ts` → tests pass → commit `feat(reactor-api): AccessGate client for ACCESS=licensed (60 s cache, 24 h last-positive)`.

### Task B2: Config (`ACCESS`, `VETRA_GATE_URL`, `VETRA_GATE_TOKEN`, `VETRA_APP_ID`)

**Interfaces:**
- `ReactorApiConfig.auth.access?: { mode?: "open" | "licensed"; gateUrl?: string; gateToken?: string; appId?: string; graceMs?: number }`.
- In `reactorApiConfigFromEnv`:
  - `ACCESS` unset or `open` → `mode: "open"`; `licensed` → `"licensed"`;
  - `members` or anything else → `mode` set to the raw value, so the boot assertion (B3) refuses with a clear message instead of falling back silently;
  - `VETRA_GATE_URL`, `VETRA_GATE_TOKEN`, `VETRA_APP_ID` and `ACCESS_GATE_GRACE_MS` (non-negative integer, else a warning and unset) map straight across.
- `apps/switchboard`: add `access` to `authSchema`. `mode` is a `z.enum(["open", "licensed"]).default("open")`; an invalid value fails config validation with the env name in the message. Add it to the key asserts, and `"access"` to `ENV_WINS_AUTH`.

- [ ] **Steps:**
  - Tests in `api-config.test.ts`: the mappings above, `ACCESS=Licensed` (case-insensitive) → licensed.
  - Tests in `boot-auth-config.test.ts`: `ACCESS=members` → a boot error `"ACCESS=members is not supported; use ACCESS=licensed with Vetra's gate"`.
  - Implement, run, then commit `feat(switchboard): ACCESS/VETRA_GATE_* config`.

### Task B3: Enforcement

**Changes:**
- **`server.ts`.** When `access.mode === "licensed"`:
  - **Boot assertion (H5).** `gateUrl` must be https (http only for `localhost`/`127.0.0.1`, for tests) and `gateToken` must be non-empty, else throw `"ACCESS=licensed needs VETRA_GATE_URL and VETRA_GATE_TOKEN"`. `skipCredentialVerification` with licensed throws too: a licence must belong to a verified address.
  - **Identity and anonymous callers.** Force `resolveCallerIdentity = true` and `requireAuthenticatedCaller = true`. Keep the configured exempt paths; `/health` and `/ready` already bypass.
  - **Policy (H2).** `documentPermissionService || ownDocumentPermissions ? DOCUMENT_PERMISSIONS : OPEN`, never ADMIN_ONLY. `AuthService.enabled` stays `true`, so `auth_enabled` still reports enforcement.
  - **The gate.** Build it with `createVetraAccessGate({ url, token, appId, graceMs, logger })` and pass it as `accessGate` to `new AuthService({...})`. Log once at boot: `"ACCESS=licensed: non-admin callers are checked with Vetra (@url)"`. Log the URL only, never the token.
- **`auth.service.ts`.** Add `accessGate?: AccessGate` to `AuthConfig` and a private helper:

```ts
  /** ACCESS=licensed: admins pass; everyone else needs the gate's yes (or its 24 h grace). */
  private async admitted(user: User): Promise<boolean> {
    const gate = this.config.accessGate;
    if (!gate) return true;
    if (this.config.admins.includes(user.address.toLowerCase())) return true;
    return (await gate.check(user.address.toLowerCase())).allowed;
  }
```

  In `verifyBearer`, after the credential check and before `onVerified`:

```ts
      if (!(await this.admitted(user))) {
        return new Response(JSON.stringify({ error: "No licence for this app" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }
```

  In `authenticateWebSocketConnection`, at the same point: `if (!(await this.admitted(user))) throw new Error("No licence for this app");`. Confirm that `onConnect` maps this to its existing bearer-rejected close (`WS_CLOSE_REASON_BEARER_REJECTED`); if it distinguishes, add a 4403 reason `"licence required"`.

  In `isCredentialValid(user)`: `return (await <existing check>) && (await this.admitted(user));`. The WS monitor then closes a lapsed licence's socket at its next recheck (H4).
- **No other call sites change.** GraphQL, SSE, drive-info, renown routes, MCP and attachments already forward a `Response` from `verifyBearer`. `auth: "public"` routes stay public (H1).

- [ ] **Steps:**
  - Tests in `auth.service.access-gate.test.ts` (mock `@renown/sdk` as `auth.service.test.ts` does, `skipCredentialVerification: false` with an injected `verifyCredential` that answers true, a fake `AccessGate`):
    - an admin → context, and the gate is never called;
    - a holder → context;
    - a stranger → a 403 Response;
    - no bearer → anonymous context (the require-auth middleware then 401s; covered in `auth-chain.test.ts` with licensed config);
    - WS: a stranger throws;
    - `isCredentialValid`: false once the gate denies.
  - In `auth-chain.test.ts`, an end-to-end licensed config: anonymous `/graphql` → 401, stranger → 403, holder → 200, `/health` → 200.
  - In `boot-auth-config.test.ts`:
    - licensed + `AUTH_ENABLED=true` without document permissions → policy OPEN (not ADMIN_ONLY);
    - with `DOCUMENT_PERMISSIONS_ENABLED=true` → DOCUMENT_PERMISSIONS;
    - missing URL or token → boot error;
    - `SKIP_CREDENTIAL_VERIFICATION=true` → boot error.
  - Implement, run both packages' suites, then commit `feat(reactor-api): ACCESS=licensed enforces Vetra's licence gate`.

### Task B4: Docs, PR, release X

- [ ] **Step 1: Docs.** Add the four env names and their meaning, H2 and H3, to the switchboard env documentation (the file that lists `AUTH_ENABLED`/`ADMINS`; find it with `grep -rl "REQUIRE_AUTHENTICATED_CALLER" apps/switchboard/*.md docs 2>/dev/null`).
- [ ] **Step 2: Checks.** `pnpm --filter @powerhousedao/reactor-api test`, `pnpm --filter @powerhousedao/switchboard test`, `pnpm tsc --noEmit -p packages/reactor-api` and `pnpm lint` on the touched packages, each piped through `grep -E "FAIL|Tests|failed|error" | tail -20`.
- [ ] **Step 3: PR.** Use conventional commits; Nx release reads them. `gh pr create -R powerhouse-inc/powerhouse --base main --title "feat(switchboard): ACCESS=licensed access mode (Vetra licence gate)"`. The body has the contract, H1-H5 and the test list, and ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. The user names the reviewer and merges (H6).
- [ ] **Step 4: X.** After the merge, the next nightly `dev` release (e.g. `6.2.3-dev.10x`) is X. Write it down: it becomes `VETRA_APPS_GATE_MIN_POWERHOUSE` on staging. Production's floor is the first `latest` release that contains the change.

---

## Task 10: Staging verification (needs the user and both parts; no code)

- [ ] **Step 1: Pin and switch on.** After part A is merged and published, the user merges a `powerhouse-k8s-hosting` PR. In `tenants/staging/powerhouse-values.yaml` it:
  - pins the new vetra-cloud-package version (`PH_REGISTRY_PACKAGES`, two places);
  - sets `VETRA_APPS_GATE: "on"`;
  - sets `VETRA_APPS_GATE_URL: https://switchboard.staging.vetra.io/api/@powerhousedao/vetra-cloud-package/apps/gate/check`;
  - sets `VETRA_APPS_GATE_MIN_POWERHOUSE: <X>`.

  Production is unchanged.
- [ ] **Step 2: Rebuild the canary on X.** On the staging canary App's repo (`96e56853-7041-4c32-a8f7-e9cc8afb50d4`), bump `@powerhousedao/*` to X and cut a release `x.y.z` through vetra-publish. `releases(appId)` shows `powerhouse: X`.
- [ ] **Step 3: Floor.** `setPlanTarget` of a shared plan to an older release (built below X) → refused with the D9 message. To `x.y.z` → ok.
- [ ] **Step 4: Instance.** After a pass, `appInstances` shows the shared instance `ready` with `gate { enabled: true, active: true, tokenDelivered: true }`. The environment's FUSION env has `ACCESS`, `VETRA_APP_ID`, `VETRA_GATE_URL` and the `VETRA_GATE_TOKEN` ref. `appAudit` has `gate.token_issued`.
- [ ] **Step 5: Who gets in.** On `https://<app>-<plan>-stg.vetra.io`, signed in with Renown:
  - the App owner → in (admin, no gate call);
  - a holder (issue a publisher grant of the plan's kind) → in;
  - a stranger → 403 on `/graphql` (Connect shows its sign-in error);
  - anonymous `/graphql` → 401;
  - `/ready` → 200.
- [ ] **Step 6: Lapse.** Revoke the holder's licence (`license_lifecycle` → REVOKED through licensing's revoke path). Within 60 s, the holder's next request is 403, and an open Connect tab's socket closes at the next WS recheck.
- [ ] **Step 7: Vetra down.** Point one instance at a dead gate: `kubectl -n <tenant> set env deploy/<fusion> VETRA_GATE_URL=https://gate.invalid/apps/gate/check`. This is temporary; the next settings change restores it. A holder who was in during the last 24 h stays in. A second holder who never signed in is refused. Restore the URL by rotating the token (`rotateInstanceGateToken`), which re-renders the env.
- [ ] **Step 8: Rotation.** `rotateInstanceGateToken`, then the pod restarts on the new revision. During the restart, the old pod's checks still answer 200 (previous token in grace). After 15 minutes, a manual `curl` with the old token → 401.
- [ ] **Step 9: Rate limit and counters.** `hey -n 2000 -c 50` (or a loop) against the route with the instance token → some 429s. The switchboard log shows one `[vetra-apps] gate:` line per 5 minutes with counts and no token.
- [ ] **Step 10: Record** all results in the PR. Production follows only after the user decides to: the production values get the same three keys with production's URL and floor, after the Sektar rollout check (Global Constraints). No customer is put on a shared plan before that.

---

## Task 11: Console follow-up (vetra.to; separate PR after staging works; no code here)

On a `feat/instance-licence-gate` branch in vetra.to:
- **Codegen** for `AppInstanceGate`, `rotateInstanceGateToken` and `AppSettings.vetraShared`.
- **Instances list** (shared rows): a "Licence gate" badge.
  - On and active: "Only holders can sign in".
  - On and not active: "Not enforced: built on Powerhouse <v> (needs <X>)", with a link to the App's releases.
  - Off: "Any signed-in user can sign in".
- **Instance detail.** "Rotate gate token" (confirm dialog: "The instance restarts with a new token; the old one works for 15 more minutes"), visible with the `release` access from plan 2's `appAccess`. "Token delivered" status.
- **Settings tab.** A read-only "Set by Vetra on shared instances" group from `vetraShared`.
- **Audit tab.** Copy for `gate.token_issued` ("issued the licence gate token of <instance>") and `gate.token_rotated`.

---

## Self-review

- **Spec coverage.**
  - **Spec 5 "Licence gate":** an admin or a live licence for `VETRA_APP_ID`, cached 60 s, a lapse at the next check → part A Tasks 4-6 (the answer is per plan: D8, G4) and part B Tasks B1-B3. The spec's `hasLicense` is replaced by the per-plan route, so an App-wide licence of another plan does not open this plan's instance.
  - **Spec 5 table "access gate":** `ACCESS=licensed`, `VETRA_APP_ID` → Task 4. `ACCESS=members` for Team is not built: overview gap 8 and D8 send Team through the same route (`reason: "member"`, slice 6), and part B refuses `members` at boot.
  - **14.14** (24 h last positive; never-seen refused) → B1.
  - **15** (monorepo) → part B.
  - **Overview slice 5:**
    - token per shared instance, only its hash used to verify (G1 explains the ciphertext);
    - the env names; the contract; 401/503 semantics;
    - rate limit per token; no audit of checks;
    - D9 and the console hint (Tasks 7 and 8);
    - the staging scenario (Task 10).
- **Lapse within 60 s:** no Vetra cache (G5), host TTL ≤ 60 s, TTL shortened to the licence's end (G4), WS recheck (H4).
- **Failure modes:**
  - Vetra down: 503/network → grace (B1).
  - Token wrong (e.g. a stale pod after the grace window): 401 → admins only, loud log (B1).
  - Delivery failure: the old token stays valid until the new one is delivered (G3, Task 2 test).
  - OpenBao down: the shared row fails with its reason, and its pods keep the old token.
  - Misconfigured host: refuses to boot, Vetra health reverts (H5).
- **No change when off:** Task 4 "gate off" test (same revision, no rows); own, branch and preview untouched.
- **Secrets:** plaintext only in `ensureGateToken`/`rotateInstanceGateToken` (generation) and `deliverSettings` (decrypt → `setSecrets`). Audit detail carries `tokenId` only, and the route logs never include the bearer (Task 6 test).
- **Type consistency:**
  - `GateTokenRow` is used by repo and service;
  - `ResolvedSecret { name, ciphertext, writeId }` carries the token (`writeId = token_id`), and `markGateDelivered` matches on it;
  - `GateAnswer` matches the contract on both sides;
  - `gateFloorError` is shared by plans now and rollouts (slice 3).
- **Later slices:**
  - Slice 3's rollout check calls `gateFloorError` for shared plans.
  - Slice 6 adds `member` in `checkGate` (an org-membership lookup when the plan is the Team plan) without changing the host.
  - Slice 7's `grantSupportAccess` adds the publisher to `ADMINS`, so the gate's `admin` branch covers it.
  - Slice 9 creates Sektar's shared instance only after part B is in Sektar's image.
