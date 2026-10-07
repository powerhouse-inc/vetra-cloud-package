# Publisher Dashboard UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a publisher a working dashboard at `/user/publisher` on vetra.io where they define licence tiers, grant and revoke licences, and see holders and environments — with every rule enforced by the switchboard.

**Architecture:** One new vetra.io module, `modules/publisher`, following `modules/apps` exactly: hand-written types, plain template-string GraphQL through a typed transport, React Query hooks keyed by viewer DID, and a tabbed page under the authenticated `/user` route tree. One backend task ships first, giving the `vetraPublisher` resolvers real GraphQL error codes so the UI can tell error kinds apart.

**Tech Stack:** Next.js (App Router), React Query, shadcn/Radix, react-hook-form + zod, vitest + happy-dom + @testing-library/react.

**Spec:** `/home/f/projects/vetra-cloud-package-licensing/docs/superpowers/specs/2026-10-07-publisher-dashboard-design.md`

## Repos and branches

| Task | Repo | Branch |
|---|---|---|
| 1 | `/home/f/projects/vetra-cloud-package-licensing` | `feat/license-provisioning` |
| 2–10 | `/home/f/projects/vetra.io` | `merge/main-into-staging` |

## Global Constraints

- Commit messages carry **no** `Co-Authored-By` trailer and no generated-with line.
- **The route is `app/user/publisher/`, not `app/publisher/`.** The spec says `app/publisher/`; that is wrong. vetra.io's auth guard is `proxy.ts` with matcher `['/user/:path*', '/profile/:path*']`. A page outside `/user` is publicly reachable.
- **No licensing logic in the UI.** Every rule is enforced by the switchboard. The UI only disables controls to match and surfaces what the server says.
- **Backend error text is surfaced verbatim.** `describePublisherError` returns `err.message` for every server-controlled code. Canned copy is only allowed for `NETWORK` and `PUBLISHER_UNAVAILABLE`, which the server never sends.
- Follow `modules/apps` patterns by name. Do not invent helpers that already exist.
- Endpoint is `getCloudEndpoint()` from `@/modules/cloud/graphql`. Do not read env vars directly.
- Every per-user query key embeds `useDid()`.
- A test must fail if the behaviour it covers is removed.

## The live surface (introspected from staging, 0.0.56-staging.3)

Queries on `vetraPublisher`: `myApps`, `licenseTypes(appId)`, `licenses(appId, status)`, `environments(appId)`.
Mutations: `createLicenseType`, `setLicenseTypeDetails`, `setLicenseTypeTemplate`, `addLicenseTypeService`, `addLicenseTypePackage`, `publishLicenseType`, `retireLicenseType`, `issueGrant`, `revokeLicense`.

```
PublisherApp           { id: String!, name: String!, status: String! }
PublisherLicenseType   { id: String!, kind: String, label: String, status: String!,
                         validityDays: Int, templateHash: String!,
                         services: [PublisherTemplateService!]!,
                         packages: [PublisherTemplatePackage!]! }
PublisherTemplateService { id: String!, type: String!, prefix: String }
PublisherTemplatePackage { id: String!, packageName: String, version: String }
PublisherLicense       { id: String!, user: String!, licenseTypeId: String!, status: String!,
                         start: String, end: String, environmentId: String }
AppUserEnvironment     { appId: String!, user: String!, environmentId: String!,
                         licenseId: String!, templateHash: String! }
```

Inputs:

```
CreateLicenseTypeInput      { appId: String!, kind: String!, label: String, validityDays: Int }
SetLicenseTypeDetailsInput  { licenseTypeId: String!, kind: String, label: String, validityDays: Int }
SetLicenseTypeTemplateInput { licenseTypeId: String!, size: String, baseDomain: String, packageRegistry: String }
AddLicenseTypeServiceInput  { licenseTypeId: String!, type: String!, prefix: String }
AddLicenseTypePackageInput  { licenseTypeId: String!, packageName: String!, version: String }
IssueGrantInput             { appId: String!, licenseTypeId: String!, user: String! }
RevokeLicenseInput          { licenseId: String!, reason: String }
```

`createLicenseType` returns `String!` (the new id), `issueGrant` returns `String!` (the new licence id), every other mutation returns `Boolean!`.

## Known limitations the UI must surface, not hide

Each is from the spec's "Known limitations, accepted" section. The owning task is named.

| Limitation | Where it must appear | Task |
|---|---|---|
| Tiers are append-only — a service or package added by mistake cannot be removed | Note above the add-service and add-package forms | 8 |
| CLINT is selectable in the model but refused by the subgraph | The service-type select lists CLINT, flagged as not provisionable | 8 |
| Publishing a RETIRED tier reactivates it | Confirmation copy on Publish when status is RETIRED | 8 |
| Retiring a tier does **not** end service for existing holders | Confirmation copy on Retire | 8 |
| A holder with two active licences gets an arbitrary one (lowest UUID) | Warning in the grant dialog when the address already holds an active licence | 9 |

## Review Focus

1. **A wallet that owns no apps.** `myApps` returns `[]`. The dashboard must render a real empty state explaining how to register an App, never an endless spinner and never a crash from indexing `apps[0]`. — Task 7.
2. **Licensing disabled on the deployment.** Reads succeed, every mutation fails with `LICENSING_DISABLED`. The dashboard must render tiers, holders and environments normally and surface the disabled error only on the action. — Tasks 8 and 9.
3. **Server error text replaced by canned copy.** The spec requires verbatim messages; the `modules/apps` `describeAppsError` pattern replaces them per code. `describePublisherError` must return `err.message` for every server-controlled code. — Task 2.
4. **Granting a second licence to an existing holder.** Silently a coin flip. The grant dialog must detect that the address already holds an ACTIVE licence and require an explicit confirmation. — Task 9.
5. **A mutation fired immediately after login or redirect.** The Renown token may not exist yet, and the call goes out unauthenticated. Mutations must resolve their token through `waitForToken`, not a bare `getAuthToken`. — Task 6.

---

### Task 1: GraphQL error codes on the publisher surface

**Repo:** `/home/f/projects/vetra-cloud-package-licensing`, branch `feat/license-provisioning`.

**Files:**
- Create: `subgraphs/vetra-licensing/publisher-errors.ts`
- Modify: `subgraphs/vetra-licensing/publisher-resolvers.ts`
- Test: `subgraphs/vetra-licensing/__tests__/publisher-errors.test.ts`

**Why:** verified against live staging — an unauthenticated publisher query returns the right message (`"sign in to manage licences"`) but `extensions.code: INTERNAL_SERVER_ERROR`, because the resolvers throw plain `Error` subclasses. The UI cannot distinguish "sign in" from "not your app" from "licensing disabled" except by string-matching, and vetra.io's `retryUnlessFinal` convention keys off codes.

**Interfaces:**
- Produces: `toPublisherGraphQLError(err: unknown): unknown` — returns a `GraphQLError` carrying `extensions.code` for known licensing errors, and the original value otherwise.
- Produces these exact code strings, which Task 2 consumes verbatim: `UNAUTHENTICATED`, `NOT_APP_OWNER`, `UNKNOWN_APP`, `APP_IDENTITY_INACTIVE`, `LICENSING_DISABLED`, `UNKNOWN_LICENSE_TYPE`, `UNKNOWN_LICENSE`, `INVALID_INPUT`.

The error classes already exist: `UnauthenticatedError` and `AppIdentityInactiveError` in `auth.ts`; `NotAppOwnerError` and `UnknownAppError` in `publisher-auth.ts`; `UnknownLicenseTypeError` and `UnknownLicenseError` in `publisher-resolvers.ts`; `LicensingDisabledError` in `resolvers.ts`; `UnknownTemplateSizeError`, `UnsupportedTemplateServiceError` and `MissingPackageNameError` in `template.ts`.

**Note on the message contract:** `NotAppOwnerError` and `UnknownAppError` both carry the message `"no such app"` deliberately, so a publisher cannot tell another publisher's app from a missing one. Giving them **different codes would reintroduce that oracle.** They must therefore share one code, `UNKNOWN_APP`. Do not give `NotAppOwnerError` its own code.

- [ ] **Step 1: Write the failing test**

```ts
// subgraphs/vetra-licensing/__tests__/publisher-errors.test.ts
import { describe, it, expect } from "vitest";
import { GraphQLError } from "graphql";
import { toPublisherGraphQLError } from "../publisher-errors.js";
import { UnauthenticatedError, AppIdentityInactiveError } from "../auth.js";
import { NotAppOwnerError, UnknownAppError } from "../publisher-auth.js";
import { UnknownLicenseTypeError, UnknownLicenseError } from "../publisher-resolvers.js";
import { LicensingDisabledError } from "../resolvers.js";

const codeOf = (e: unknown) => (e as GraphQLError).extensions?.code;

describe("toPublisherGraphQLError", () => {
  it("maps each licensing error to its code and keeps the message verbatim", () => {
    const cases: Array<[Error, string]> = [
      [new UnauthenticatedError("sign in to manage licences"), "UNAUTHENTICATED"],
      [new UnknownAppError("no such app"), "UNKNOWN_APP"],
      [new AppIdentityInactiveError("app identity inactive"), "APP_IDENTITY_INACTIVE"],
      [new LicensingDisabledError("licensing is disabled"), "LICENSING_DISABLED"],
      [new UnknownLicenseTypeError(), "UNKNOWN_LICENSE_TYPE"],
      [new UnknownLicenseError(), "UNKNOWN_LICENSE"],
    ];
    for (const [err, code] of cases) {
      const out = toPublisherGraphQLError(err);
      expect(out).toBeInstanceOf(GraphQLError);
      expect(codeOf(out)).toBe(code);
      expect((out as GraphQLError).message).toBe(err.message);
    }
  });

  it("gives NotAppOwnerError the SAME code and message as UnknownAppError", () => {
    // The two are deliberately indistinguishable: a publisher must not be able to
    // tell another publisher's app from one that does not exist. Distinct codes
    // would reintroduce exactly the oracle the identical message text removes.
    const mine = toPublisherGraphQLError(new NotAppOwnerError("no such app")) as GraphQLError;
    const missing = toPublisherGraphQLError(new UnknownAppError("no such app")) as GraphQLError;
    expect(codeOf(mine)).toBe(codeOf(missing));
    expect(mine.message).toBe(missing.message);
  });

  it("passes an unknown error through unchanged", () => {
    const boom = new Error("something else");
    expect(toPublisherGraphQLError(boom)).toBe(boom);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run subgraphs/vetra-licensing/__tests__/publisher-errors.test.ts`
Expected: FAIL — cannot find module `../publisher-errors.js`.

- [ ] **Step 3: Implement**

```ts
// subgraphs/vetra-licensing/publisher-errors.ts
import { GraphQLError } from "graphql";
import { UnauthenticatedError, AppIdentityInactiveError } from "./auth.js";
import { NotAppOwnerError, UnknownAppError } from "./publisher-auth.js";
import { LicensingDisabledError } from "./resolvers.js";
import {
  UnknownTemplateSizeError,
  UnsupportedTemplateServiceError,
  MissingPackageNameError,
} from "./template.js";
import { UnknownLicenseTypeError, UnknownLicenseError } from "./publisher-resolvers.js";

/**
 * Map a licensing error to a GraphQLError carrying a stable `extensions.code`.
 *
 * NotAppOwnerError and UnknownAppError share ONE code on purpose. They already
 * share their message text so that a publisher cannot distinguish another
 * publisher's app from a missing one; separate codes would hand back exactly
 * that oracle in machine-readable form.
 */
export function toPublisherGraphQLError(err: unknown): unknown {
  const code = codeFor(err);
  if (!code) return err;
  const e = err as Error;
  return new GraphQLError(e.message, { extensions: { code }, originalError: e });
}

function codeFor(err: unknown): string | null {
  if (err instanceof UnauthenticatedError) return "UNAUTHENTICATED";
  if (err instanceof NotAppOwnerError || err instanceof UnknownAppError) return "UNKNOWN_APP";
  if (err instanceof AppIdentityInactiveError) return "APP_IDENTITY_INACTIVE";
  if (err instanceof LicensingDisabledError) return "LICENSING_DISABLED";
  if (err instanceof UnknownLicenseTypeError) return "UNKNOWN_LICENSE_TYPE";
  if (err instanceof UnknownLicenseError) return "UNKNOWN_LICENSE";
  if (
    err instanceof UnknownTemplateSizeError ||
    err instanceof UnsupportedTemplateServiceError ||
    err instanceof MissingPackageNameError
  ) {
    return "INVALID_INPUT";
  }
  return null;
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run subgraphs/vetra-licensing/__tests__/publisher-errors.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Wrap every publisher resolver**

In `publisher-resolvers.ts`, wrap the body of each of the 4 query and 9 mutation resolvers so a thrown licensing error is converted. Add this helper beside `createPublisherResolvers` and use it on every field:

```ts
const withCodes = <A, R>(fn: (p: unknown, a: A, c: Ctx) => Promise<R>) =>
  async (p: unknown, a: A, c: Ctx): Promise<R> => {
    try {
      return await fn(p, a, c);
    } catch (err) {
      throw toPublisherGraphQLError(err);
    }
  };
```

Apply it to all 13 fields. Do not change any resolver's logic, argument handling or gate order.

- [ ] **Step 6: Add the regression test that every field is wrapped**

```ts
// append to subgraphs/vetra-licensing/__tests__/publisher-errors.test.ts
it("every publisher field maps an unauthenticated call to UNAUTHENTICATED", async () => {
  // A field added later without withCodes would return INTERNAL_SERVER_ERROR to
  // the browser and silently break the dashboard's error handling.
  const deps = makeDeps(); // reuse the harness from publisher-resolvers.test.ts
  const r = createPublisherResolvers(fakeDb(), deps);
  const anon = { user: undefined } as never;
  const queries = Object.values(r.VetraPublisherQueries as Record<string, Function>);
  const mutations = Object.values(r.VetraPublisherMutations as Record<string, Function>);
  expect(queries.length + mutations.length).toBe(13);
  for (const field of [...queries, ...mutations]) {
    const err = await field({}, { appId: "a", input: {}, licenseTypeId: "t" }, anon).catch((e: unknown) => e);
    expect((err as GraphQLError).extensions?.code).toBe("UNAUTHENTICATED");
  }
});
```

- [ ] **Step 7: Prove it has teeth**

Remove `withCodes` from exactly one field, run the test, confirm it fails naming that field, restore it, confirm `git status --porcelain` is empty.

- [ ] **Step 8: Verify and commit**

Run: `npm run tsc && npx oxlint subgraphs/vetra-licensing && npx vitest run`

```bash
git add subgraphs/vetra-licensing/publisher-errors.ts subgraphs/vetra-licensing/publisher-resolvers.ts subgraphs/vetra-licensing/__tests__/publisher-errors.test.ts
git commit -m "feat(licensing): publisher errors carry GraphQL extensions.code"
```

---

### Task 2: the publisher module's types, transport and error mapping

**Repo:** `/home/f/projects/vetra.io`, branch `merge/main-into-staging`. All later tasks are in this repo.

**Files:**
- Create: `modules/publisher/types.ts`
- Create: `modules/publisher/graphql.ts`
- Test: `modules/publisher/__tests__/graphql.test.ts`

**Interfaces:**
- Produces: `PublisherApp`, `PublisherLicenseType`, `PublisherTemplateService`, `PublisherTemplatePackage`, `PublisherLicense`, `AppUserEnvironment`, `PublisherErrorCode`.
- Produces: `PublisherApiError` (fields `code: PublisherErrorCode`, `status: number | null`), `publisherGql<T>(query, variables, token, fetchImpl?)`, `toPublisherError(err, status)`, `describePublisherError(err)`, `isPublisherError(err, code?)`, `type FetchLike`.

- [ ] **Step 1: Write the types**

```ts
// modules/publisher/types.ts
export type PublisherApp = { id: string; name: string; status: string }

export type PublisherTemplateService = { id: string; type: string; prefix: string | null }
export type PublisherTemplatePackage = { id: string; packageName: string | null; version: string | null }

export type PublisherLicenseType = {
  id: string
  kind: string | null
  label: string | null
  status: string
  validityDays: number | null
  templateHash: string
  services: PublisherTemplateService[]
  packages: PublisherTemplatePackage[]
}

export type PublisherLicense = {
  id: string
  user: string
  licenseTypeId: string
  status: string
  start: string | null
  end: string | null
  environmentId: string | null
}

export type AppUserEnvironment = {
  appId: string
  user: string
  environmentId: string
  licenseId: string
  templateHash: string
}
```

- [ ] **Step 2: Write the failing transport test**

```ts
// modules/publisher/__tests__/graphql.test.ts
import { describe, it, expect, vi } from 'vitest'
import {
  publisherGql,
  describePublisherError,
  isPublisherError,
  PublisherApiError,
  type FetchLike,
} from '../graphql'

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('publisherGql', () => {
  it('sends the bearer token when there is one', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: { ok: 1 } })) as unknown as FetchLike
    await publisherGql('{ ok }', undefined, 'tok-1', fetchImpl)
    const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1]
    expect(init.headers.Authorization).toBe('Bearer tok-1')
  })

  it('omits Authorization when the token is null', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: { ok: 1 } })) as unknown as FetchLike
    await publisherGql('{ ok }', undefined, null, fetchImpl)
    const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1]
    expect(init.headers.Authorization).toBeUndefined()
  })

  it('maps a server error code onto PublisherApiError', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ errors: [{ message: 'no such app', extensions: { code: 'UNKNOWN_APP' } }] }),
    ) as unknown as FetchLike
    const err = await publisherGql('{ ok }', undefined, 't', fetchImpl).catch((e) => e)
    expect(isPublisherError(err, 'UNKNOWN_APP')).toBe(true)
    expect((err as PublisherApiError).message).toBe('no such app')
  })

  it('turns a thrown fetch into NETWORK', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline')
    }) as unknown as FetchLike
    const err = await publisherGql('{ ok }', undefined, 't', fetchImpl).catch((e) => e)
    expect(isPublisherError(err, 'NETWORK')).toBe(true)
  })

  it('maps a schema mismatch to PUBLISHER_UNAVAILABLE', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ errors: [{ message: 'Cannot query field "vetraPublisher" on type "Query".' }] }),
    ) as unknown as FetchLike
    const err = await publisherGql('{ ok }', undefined, 't', fetchImpl).catch((e) => e)
    expect(isPublisherError(err, 'PUBLISHER_UNAVAILABLE')).toBe(true)
  })
})

describe('describePublisherError', () => {
  it('returns the SERVER message verbatim for every server-controlled code', () => {
    // The spec requires backend error text be surfaced verbatim; the UI invents
    // no error copy of its own. Canned copy here would hide, for example, which
    // licence type a tier mutation rejected.
    for (const code of [
      'UNAUTHENTICATED',
      'UNKNOWN_APP',
      'APP_IDENTITY_INACTIVE',
      'LICENSING_DISABLED',
      'UNKNOWN_LICENSE_TYPE',
      'UNKNOWN_LICENSE',
      'INVALID_INPUT',
      'UNKNOWN',
    ] as const) {
      const err = new PublisherApiError(code, 'the exact server text', null)
      expect(describePublisherError(err)).toBe('the exact server text')
    }
  })

  it('supplies copy only for the two codes the server never sends', () => {
    expect(describePublisherError(new PublisherApiError('NETWORK', 'fetch failed', null))).toMatch(/connection/i)
    expect(describePublisherError(new PublisherApiError('PUBLISHER_UNAVAILABLE', 'x', null))).toMatch(/not available/i)
  })

  it('falls back to the message for a non-PublisherApiError', () => {
    expect(describePublisherError(new Error('plain'))).toBe('plain')
  })
})
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run --config vitest.unit.config.ts modules/publisher/__tests__/graphql.test.ts`
Expected: FAIL — cannot resolve `../graphql`.

- [ ] **Step 4: Implement the transport**

```ts
// modules/publisher/graphql.ts
import { getCloudEndpoint } from '@/modules/cloud/graphql'

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export type PublisherErrorCode =
  | 'UNAUTHENTICATED'
  | 'UNKNOWN_APP'
  | 'APP_IDENTITY_INACTIVE'
  | 'LICENSING_DISABLED'
  | 'UNKNOWN_LICENSE_TYPE'
  | 'UNKNOWN_LICENSE'
  | 'INVALID_INPUT'
  | 'PUBLISHER_UNAVAILABLE'
  | 'NETWORK'
  | 'UNKNOWN'

const KNOWN_CODES = new Set<string>([
  'UNAUTHENTICATED',
  'UNKNOWN_APP',
  'APP_IDENTITY_INACTIVE',
  'LICENSING_DISABLED',
  'UNKNOWN_LICENSE_TYPE',
  'UNKNOWN_LICENSE',
  'INVALID_INPUT',
])

export class PublisherApiError extends Error {
  code: PublisherErrorCode
  status: number | null
  constructor(code: PublisherErrorCode, message: string, status: number | null) {
    super(message)
    this.name = 'PublisherApiError'
    this.code = code
    this.status = status
  }
}

export function isPublisherError(err: unknown, code?: PublisherErrorCode): err is PublisherApiError {
  return err instanceof PublisherApiError && (code === undefined || err.code === code)
}

export function toPublisherError(
  gqlError: { message?: string; extensions?: { code?: unknown } } | undefined,
  status: number | null,
): PublisherApiError {
  const message = (gqlError?.message ?? '').trim() || 'Request failed'
  if (/Cannot query field|Unknown type|Unknown argument/i.test(message)) {
    return new PublisherApiError('PUBLISHER_UNAVAILABLE', message, status)
  }
  const raw = gqlError?.extensions?.code
  const code = typeof raw === 'string' && KNOWN_CODES.has(raw) ? (raw as PublisherErrorCode) : 'UNKNOWN'
  return new PublisherApiError(code, message, status)
}

export async function publisherGql<T>(
  query: string,
  variables: Record<string, unknown> | undefined,
  token: string | null | undefined,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`

  let res: Response
  try {
    res = await fetchImpl(getCloudEndpoint(), {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables }),
    })
  } catch (err) {
    throw new PublisherApiError('NETWORK', err instanceof Error ? err.message : 'Network error', null)
  }

  let body: { data?: T; errors?: Array<{ message?: string; extensions?: { code?: unknown } }> } | null = null
  try {
    body = (await res.json()) as typeof body
  } catch {
    body = null
  }

  if (body?.errors?.length) throw toPublisherError(body.errors[0], res.status)
  if (!res.ok) throw toPublisherError({ message: `Request failed (${res.status})` }, res.status)
  if (!body || body.data == null) throw new PublisherApiError('UNKNOWN', 'Empty response', res.status)
  return body.data
}

/**
 * The spec requires backend error text be surfaced verbatim, so this returns the
 * SERVER's message for every code the server can send. Only NETWORK and
 * PUBLISHER_UNAVAILABLE get copy of our own, because those two are produced here
 * and their raw text ("fetch failed") means nothing to a publisher.
 */
export function describePublisherError(err: unknown): string {
  if (isPublisherError(err, 'NETWORK')) return 'Lost the connection to Vetra. Check your network and try again.'
  if (isPublisherError(err, 'PUBLISHER_UNAVAILABLE')) {
    return 'The licensing API is not available on this deployment.'
  }
  if (err instanceof Error && err.message) return err.message
  return 'Something went wrong.'
}

/** Retry only transport-level failures; a coded refusal will not change on retry. */
export function retryPublisher(failureCount: number, error: unknown): boolean {
  if (isPublisherError(error) && !['NETWORK', 'UNKNOWN'].includes(error.code)) return false
  return failureCount < 2
}
```

- [ ] **Step 5: Run it and watch it pass**

Run: `npx vitest run --config vitest.unit.config.ts modules/publisher/__tests__/graphql.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Prove the verbatim rule has teeth**

Change `describePublisherError` to return canned copy for `LICENSING_DISABLED`. Run the test; the verbatim test must fail. Restore, confirm `git status --porcelain` is empty.

- [ ] **Step 7: Commit**

```bash
git add modules/publisher/types.ts modules/publisher/graphql.ts modules/publisher/__tests__/graphql.test.ts
git commit -m "feat(publisher): typed GraphQL transport for the licensing surface"
```

---

### Task 3: query fetchers

**Files:**
- Modify: `modules/publisher/graphql.ts`
- Test: `modules/publisher/__tests__/queries.test.ts`

**Interfaces:**
- Consumes: `publisherGql`, the types from Task 2.
- Produces: `fetchMyApps(token, fetchImpl?)`, `fetchLicenseTypes(appId, token, fetchImpl?)`, `fetchLicenses(appId, status, token, fetchImpl?)`, `fetchEnvironments(appId, token, fetchImpl?)`.

- [ ] **Step 1: Write the failing test**

```ts
// modules/publisher/__tests__/queries.test.ts
import { describe, it, expect, vi } from 'vitest'
import { fetchMyApps, fetchLicenseTypes, fetchLicenses, fetchEnvironments } from '../graphql'
import type { FetchLike } from '../graphql'

const capture = (data: unknown) => {
  const calls: Array<{ query: string; variables: unknown }> = []
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(init.body as string))
    return new Response(JSON.stringify({ data }), { status: 200 })
  }) as unknown as FetchLike
  return { calls, fetchImpl }
}

describe('publisher query fetchers', () => {
  it('fetchMyApps unwraps vetraPublisher.myApps and sends no variables', async () => {
    const { calls, fetchImpl } = capture({ vetraPublisher: { myApps: [{ id: 'a1', name: 'Vault', status: 'ACTIVE' }] } })
    const apps = await fetchMyApps('t', fetchImpl)
    expect(apps).toEqual([{ id: 'a1', name: 'Vault', status: 'ACTIVE' }])
    expect(calls[0].variables).toEqual({})
  })

  it('fetchLicenseTypes passes appId and asks for services and packages', async () => {
    const { calls, fetchImpl } = capture({ vetraPublisher: { licenseTypes: [] } })
    await fetchLicenseTypes('app-1', 't', fetchImpl)
    expect(calls[0].variables).toEqual({ appId: 'app-1' })
    expect(calls[0].query).toContain('services')
    expect(calls[0].query).toContain('packages')
  })

  it('fetchLicenses passes a null status when none is given', async () => {
    const { calls, fetchImpl } = capture({ vetraPublisher: { licenses: [] } })
    await fetchLicenses('app-1', null, 't', fetchImpl)
    expect(calls[0].variables).toEqual({ appId: 'app-1', status: null })
  })

  it('fetchEnvironments unwraps vetraPublisher.environments', async () => {
    const row = { appId: 'app-1', user: '0xa', environmentId: 'e1', licenseId: 'l1', templateHash: 'h' }
    const { fetchImpl } = capture({ vetraPublisher: { environments: [row] } })
    expect(await fetchEnvironments('app-1', 't', fetchImpl)).toEqual([row])
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --config vitest.unit.config.ts modules/publisher/__tests__/queries.test.ts`
Expected: FAIL — the fetchers are not exported.

- [ ] **Step 3: Implement — append to `modules/publisher/graphql.ts`**

```ts
import type {
  PublisherApp,
  PublisherLicense,
  PublisherLicenseType,
  AppUserEnvironment,
} from './types'

const APP_FIELDS = `id name status`
const TYPE_FIELDS = `id kind label status validityDays templateHash
  services { id type prefix }
  packages { id packageName version }`
const LICENSE_FIELDS = `id user licenseTypeId status start end environmentId`
const ENV_FIELDS = `appId user environmentId licenseId templateHash`

export async function fetchMyApps(token: string | null, fetchImpl?: FetchLike): Promise<PublisherApp[]> {
  const data = await publisherGql<{ vetraPublisher: { myApps: PublisherApp[] } }>(
    `query { vetraPublisher { myApps { ${APP_FIELDS} } } }`,
    {},
    token,
    fetchImpl,
  )
  return data.vetraPublisher.myApps
}

export async function fetchLicenseTypes(
  appId: string,
  token: string | null,
  fetchImpl?: FetchLike,
): Promise<PublisherLicenseType[]> {
  const data = await publisherGql<{ vetraPublisher: { licenseTypes: PublisherLicenseType[] } }>(
    `query ($appId: String!) { vetraPublisher { licenseTypes(appId: $appId) { ${TYPE_FIELDS} } } }`,
    { appId },
    token,
    fetchImpl,
  )
  return data.vetraPublisher.licenseTypes
}

export async function fetchLicenses(
  appId: string,
  status: string | null,
  token: string | null,
  fetchImpl?: FetchLike,
): Promise<PublisherLicense[]> {
  const data = await publisherGql<{ vetraPublisher: { licenses: PublisherLicense[] } }>(
    `query ($appId: String!, $status: String) { vetraPublisher { licenses(appId: $appId, status: $status) { ${LICENSE_FIELDS} } } }`,
    { appId, status },
    token,
    fetchImpl,
  )
  return data.vetraPublisher.licenses
}

export async function fetchEnvironments(
  appId: string,
  token: string | null,
  fetchImpl?: FetchLike,
): Promise<AppUserEnvironment[]> {
  const data = await publisherGql<{ vetraPublisher: { environments: AppUserEnvironment[] } }>(
    `query ($appId: String!) { vetraPublisher { environments(appId: $appId) { ${ENV_FIELDS} } } }`,
    { appId },
    token,
    fetchImpl,
  )
  return data.vetraPublisher.environments
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run --config vitest.unit.config.ts modules/publisher/__tests__/queries.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add modules/publisher/graphql.ts modules/publisher/__tests__/queries.test.ts
git commit -m "feat(publisher): read fetchers for apps, tiers, licences and environments"
```

---

### Task 4: mutation fetchers

**Files:**
- Modify: `modules/publisher/graphql.ts`
- Test: `modules/publisher/__tests__/mutations.test.ts`

**Interfaces:**
- Produces: `createLicenseType(input, token, fetchImpl?) => Promise<string>`, `setLicenseTypeDetails(input, token, fetchImpl?) => Promise<boolean>`, `setLicenseTypeTemplate(input, …)`, `addLicenseTypeService(input, …)`, `addLicenseTypePackage(input, …)`, `publishLicenseType(licenseTypeId, …)`, `retireLicenseType(licenseTypeId, …)`, `issueGrant(input, …) => Promise<string>`, `revokeLicense(input, …) => Promise<boolean>`.
- Produces input types `CreateLicenseTypeInput`, `SetLicenseTypeDetailsInput`, `SetLicenseTypeTemplateInput`, `AddLicenseTypeServiceInput`, `AddLicenseTypePackageInput`, `IssueGrantInput`, `RevokeLicenseInput` in `types.ts`, matching the server exactly.

**Critical:** `SetLicenseTypeDetailsInput` has **no `app` field** and must never be given one — the server deliberately omits it so a publisher cannot move a licence type into another publisher's app. Omit a key entirely to leave that field unchanged; send `validityDays: null` to clear it.

- [ ] **Step 1: Add the input types to `modules/publisher/types.ts`**

```ts
export type CreateLicenseTypeInput = { appId: string; kind: string; label?: string | null; validityDays?: number | null }
export type SetLicenseTypeDetailsInput = { licenseTypeId: string; kind?: string | null; label?: string | null; validityDays?: number | null }
export type SetLicenseTypeTemplateInput = { licenseTypeId: string; size?: string | null; baseDomain?: string | null; packageRegistry?: string | null }
export type AddLicenseTypeServiceInput = { licenseTypeId: string; type: string; prefix?: string | null }
export type AddLicenseTypePackageInput = { licenseTypeId: string; packageName: string; version?: string | null }
export type IssueGrantInput = { appId: string; licenseTypeId: string; user: string }
export type RevokeLicenseInput = { licenseId: string; reason?: string | null }
```

- [ ] **Step 2: Write the failing test**

```ts
// modules/publisher/__tests__/mutations.test.ts
import { describe, it, expect } from 'vitest'
import {
  createLicenseType, setLicenseTypeDetails, addLicenseTypeService,
  publishLicenseType, retireLicenseType, issueGrant, revokeLicense,
} from '../graphql'
import type { FetchLike } from '../graphql'

const capture = (data: unknown) => {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = []
  const fetchImpl = (async (_u: string, init: RequestInit) => {
    calls.push(JSON.parse(init.body as string))
    return new Response(JSON.stringify({ data }), { status: 200 })
  }) as unknown as FetchLike
  return { calls, fetchImpl }
}

describe('publisher mutation fetchers', () => {
  it('createLicenseType returns the new id', async () => {
    const { calls, fetchImpl } = capture({ vetraPublisher: { createLicenseType: 'lt-9' } })
    const id = await createLicenseType({ appId: 'a1', kind: 'PRO', label: 'Pro', validityDays: 365 }, 't', fetchImpl)
    expect(id).toBe('lt-9')
    expect(calls[0].variables.input).toEqual({ appId: 'a1', kind: 'PRO', label: 'Pro', validityDays: 365 })
  })

  it('setLicenseTypeDetails NEVER sends an app field', async () => {
    // The server input has no `app`. Sending one would be rejected, but more
    // importantly the absence is what stops a tier being moved into another
    // publisher's app; the UI must not reintroduce it.
    const { calls, fetchImpl } = capture({ vetraPublisher: { setLicenseTypeDetails: true } })
    await setLicenseTypeDetails({ licenseTypeId: 'lt-1', label: 'New name' }, 't', fetchImpl)
    expect(Object.keys(calls[0].variables.input as object)).not.toContain('app')
    expect(Object.keys(calls[0].variables.input as object)).not.toContain('appId')
  })

  it('setLicenseTypeDetails omits keys the caller did not set, and sends an explicit null to clear', async () => {
    const a = capture({ vetraPublisher: { setLicenseTypeDetails: true } })
    await setLicenseTypeDetails({ licenseTypeId: 'lt-1', label: 'x' }, 't', a.fetchImpl)
    expect(Object.keys(a.calls[0].variables.input as object)).toEqual(['licenseTypeId', 'label'])

    const b = capture({ vetraPublisher: { setLicenseTypeDetails: true } })
    await setLicenseTypeDetails({ licenseTypeId: 'lt-1', validityDays: null }, 't', b.fetchImpl)
    expect((b.calls[0].variables.input as { validityDays: unknown }).validityDays).toBeNull()
  })

  it('publishLicenseType and retireLicenseType take a bare id argument', async () => {
    const p = capture({ vetraPublisher: { publishLicenseType: true } })
    expect(await publishLicenseType('lt-1', 't', p.fetchImpl)).toBe(true)
    expect(p.calls[0].variables).toEqual({ licenseTypeId: 'lt-1' })

    const r = capture({ vetraPublisher: { retireLicenseType: true } })
    expect(await retireLicenseType('lt-1', 't', r.fetchImpl)).toBe(true)
  })

  it('issueGrant returns the new licence id', async () => {
    const { fetchImpl } = capture({ vetraPublisher: { issueGrant: 'lic-3' } })
    expect(await issueGrant({ appId: 'a1', licenseTypeId: 'lt-1', user: '0xabc' }, 't', fetchImpl)).toBe('lic-3')
  })

  it('revokeLicense sends licenseId and reason only', async () => {
    const { calls, fetchImpl } = capture({ vetraPublisher: { revokeLicense: true } })
    await revokeLicense({ licenseId: 'lic-3', reason: 'non-payment' }, 't', fetchImpl)
    expect(calls[0].variables.input).toEqual({ licenseId: 'lic-3', reason: 'non-payment' })
  })

  it('addLicenseTypeService forwards the service type verbatim', async () => {
    const { calls, fetchImpl } = capture({ vetraPublisher: { addLicenseTypeService: true } })
    await addLicenseTypeService({ licenseTypeId: 'lt-1', type: 'CONNECT', prefix: null }, 't', fetchImpl)
    expect((calls[0].variables.input as { type: string }).type).toBe('CONNECT')
  })
})
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run --config vitest.unit.config.ts modules/publisher/__tests__/mutations.test.ts`
Expected: FAIL — the mutation fetchers are not exported.

- [ ] **Step 4: Implement — append to `modules/publisher/graphql.ts`**

```ts
import type {
  CreateLicenseTypeInput, SetLicenseTypeDetailsInput, SetLicenseTypeTemplateInput,
  AddLicenseTypeServiceInput, AddLicenseTypePackageInput, IssueGrantInput, RevokeLicenseInput,
} from './types'

const mutate = async <T>(
  field: string,
  args: string,
  selection: string,
  variables: Record<string, unknown>,
  token: string | null,
  fetchImpl?: FetchLike,
): Promise<T> => {
  const data = await publisherGql<{ vetraPublisher: Record<string, T> }>(
    `mutation ${args} { vetraPublisher { ${selection} } }`,
    variables,
    token,
    fetchImpl,
  )
  return data.vetraPublisher[field]
}

export const createLicenseType = (input: CreateLicenseTypeInput, token: string | null, fetchImpl?: FetchLike) =>
  mutate<string>('createLicenseType', '($input: CreateLicenseTypeInput!)', 'createLicenseType(input: $input)', { input }, token, fetchImpl)

export const setLicenseTypeDetails = (input: SetLicenseTypeDetailsInput, token: string | null, fetchImpl?: FetchLike) =>
  mutate<boolean>('setLicenseTypeDetails', '($input: SetLicenseTypeDetailsInput!)', 'setLicenseTypeDetails(input: $input)', { input }, token, fetchImpl)

export const setLicenseTypeTemplate = (input: SetLicenseTypeTemplateInput, token: string | null, fetchImpl?: FetchLike) =>
  mutate<boolean>('setLicenseTypeTemplate', '($input: SetLicenseTypeTemplateInput!)', 'setLicenseTypeTemplate(input: $input)', { input }, token, fetchImpl)

export const addLicenseTypeService = (input: AddLicenseTypeServiceInput, token: string | null, fetchImpl?: FetchLike) =>
  mutate<boolean>('addLicenseTypeService', '($input: AddLicenseTypeServiceInput!)', 'addLicenseTypeService(input: $input)', { input }, token, fetchImpl)

export const addLicenseTypePackage = (input: AddLicenseTypePackageInput, token: string | null, fetchImpl?: FetchLike) =>
  mutate<boolean>('addLicenseTypePackage', '($input: AddLicenseTypePackageInput!)', 'addLicenseTypePackage(input: $input)', { input }, token, fetchImpl)

export const publishLicenseType = (licenseTypeId: string, token: string | null, fetchImpl?: FetchLike) =>
  mutate<boolean>('publishLicenseType', '($licenseTypeId: String!)', 'publishLicenseType(licenseTypeId: $licenseTypeId)', { licenseTypeId }, token, fetchImpl)

export const retireLicenseType = (licenseTypeId: string, token: string | null, fetchImpl?: FetchLike) =>
  mutate<boolean>('retireLicenseType', '($licenseTypeId: String!)', 'retireLicenseType(licenseTypeId: $licenseTypeId)', { licenseTypeId }, token, fetchImpl)

export const issueGrant = (input: IssueGrantInput, token: string | null, fetchImpl?: FetchLike) =>
  mutate<string>('issueGrant', '($input: IssueGrantInput!)', 'issueGrant(input: $input)', { input }, token, fetchImpl)

export const revokeLicense = (input: RevokeLicenseInput, token: string | null, fetchImpl?: FetchLike) =>
  mutate<boolean>('revokeLicense', '($input: RevokeLicenseInput!)', 'revokeLicense(input: $input)', { input }, token, fetchImpl)
```

Because the input objects are passed straight through, a key the caller omits is absent from the JSON body and a key set to `null` is sent as `null` — which is exactly the server's absent-vs-null contract for `validityDays`.

- [ ] **Step 5: Run it and watch it pass**

Run: `npx vitest run --config vitest.unit.config.ts modules/publisher/__tests__/mutations.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add modules/publisher/types.ts modules/publisher/graphql.ts modules/publisher/__tests__/mutations.test.ts
git commit -m "feat(publisher): tier and licence mutation fetchers"
```

---

### Task 5: query keys and read hooks

**Files:**
- Create: `modules/publisher/hooks/keys.ts`
- Create: `modules/publisher/hooks/use-publisher.ts`
- Test: `modules/publisher/__tests__/use-publisher.test.tsx`

**Interfaces:**
- Produces: `publisherKeys.apps(did)`, `publisherKeys.types(appId, did)`, `publisherKeys.licenses(appId, status, did)`, `publisherKeys.environments(appId, did)`.
- Produces: `useMyApps()`, `usePublisherLicenseTypes(appId)`, `usePublisherLicenses(appId, status)`, `usePublisherEnvironments(appId)` — each returning `UseQueryResult`.
- Produces: `usePublisherToken()` — the token resolver that Task 6 consumes.

**Decision carried from the pattern survey:** `modules/apps`'s `useTokenResolver` is file-local and **not exported**. Rather than import across module boundaries or duplicate it silently, this module defines its own `usePublisherToken` in `use-publisher.ts`, built on the exported `waitForToken` from `@/modules/apps/lib/token` and `getAuthToken` from `@/modules/cloud/graphql`. If `waitForToken` is not exported, export it in this task and say so in the report.

- [ ] **Step 1: Write the keys**

```ts
// modules/publisher/hooks/keys.ts
export const publisherKeys = {
  all: ['publisher'] as const,
  apps: (did: string) => ['publisher', 'apps', did] as const,
  types: (appId: string, did: string) => ['publisher', 'types', appId, did] as const,
  licenses: (appId: string, status: string | null, did: string) =>
    ['publisher', 'licenses', appId, status ?? 'ALL', did] as const,
  environments: (appId: string, did: string) => ['publisher', 'environments', appId, did] as const,
}
```

- [ ] **Step 2: Write the failing test**

```tsx
// modules/publisher/__tests__/use-publisher.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'

const fetchMyApps = vi.fn()
const fetchLicenseTypes = vi.fn()
vi.mock('../graphql', async (orig) => ({
  ...(await orig<typeof import('../graphql')>()),
  fetchMyApps: (...a: unknown[]) => fetchMyApps(...a),
  fetchLicenseTypes: (...a: unknown[]) => fetchLicenseTypes(...a),
}))
vi.mock('@/modules/cloud/query/use-authed-query', () => ({
  useAuthedQuery: (key: readonly unknown[], fetcher: (t: string | null) => Promise<unknown>, options?: object) => {
    const { useQuery } = require('@tanstack/react-query')
    return useQuery({ queryKey: key, queryFn: () => fetcher('tok'), ...options })
  },
}))
vi.mock('@powerhousedao/reactor-browser', () => ({ useRenown: () => ({ user: { did: 'did:key:z1' } }) }))

import { useMyApps, usePublisherLicenseTypes } from '../hooks/use-publisher'
import { publisherKeys } from '../hooks/keys'

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

beforeEach(() => { fetchMyApps.mockReset(); fetchLicenseTypes.mockReset() })

describe('publisher read hooks', () => {
  it('useMyApps returns the apps the wallet owns', async () => {
    fetchMyApps.mockResolvedValue([{ id: 'a1', name: 'Vault', status: 'ACTIVE' }])
    const { result } = renderHook(() => useMyApps(), { wrapper })
    await waitFor(() => expect(result.current.data).toHaveLength(1))
    expect(result.current.data![0].name).toBe('Vault')
  })

  it('useMyApps returns an empty array rather than undefined when the wallet owns none', async () => {
    // Review Focus 1: a wallet with no apps is the FIRST thing a new publisher
    // hits. The page must be able to render an empty state from this.
    fetchMyApps.mockResolvedValue([])
    const { result } = renderHook(() => useMyApps(), { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual([])
  })

  it('usePublisherLicenseTypes does not fire without an appId', async () => {
    const { result } = renderHook(() => usePublisherLicenseTypes(null), { wrapper })
    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'))
    expect(fetchLicenseTypes).not.toHaveBeenCalled()
  })

  it('keys embed the viewer did so two wallets never share a cache entry', () => {
    expect(publisherKeys.apps('did:key:z1')).not.toEqual(publisherKeys.apps('did:key:z2'))
    expect(publisherKeys.types('app-1', 'did:a')).not.toEqual(publisherKeys.types('app-1', 'did:b'))
  })
})
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run --config vitest.unit.config.ts modules/publisher/__tests__/use-publisher.test.tsx`
Expected: FAIL — `../hooks/use-publisher` does not exist.

- [ ] **Step 4: Implement**

```ts
// modules/publisher/hooks/use-publisher.ts
'use client'

import { useCallback, useEffect, useRef } from 'react'
import { useRenown } from '@powerhousedao/reactor-browser'
import { useAuthedQuery } from '@/modules/cloud/query/use-authed-query'
import { getAuthToken } from '@/modules/cloud/graphql'
import { waitForToken } from '@/modules/apps/lib/token'
import {
  fetchMyApps, fetchLicenseTypes, fetchLicenses, fetchEnvironments, retryPublisher,
} from '../graphql'
import type { PublisherApp, PublisherLicense, PublisherLicenseType, AppUserEnvironment } from '../types'
import { publisherKeys } from './keys'

function useDid(): string {
  const renown = useRenown() as { user?: { did?: string } } | null
  return renown?.user?.did ?? 'anon'
}

/**
 * Mutations resolve their token through waitForToken, not a bare getAuthToken:
 * a call fired right after login or a redirect can otherwise go out with no
 * token at all and come back UNAUTHENTICATED (Review Focus 5).
 */
export function usePublisherToken(): () => Promise<string | null> {
  const renown = useRenown()
  const ref = useRef(renown)
  useEffect(() => { ref.current = renown }, [renown])
  return useCallback(() => waitForToken(() => getAuthToken(ref.current)), [])
}

export function useMyApps() {
  const did = useDid()
  return useAuthedQuery<PublisherApp[]>(publisherKeys.apps(did), (token) => fetchMyApps(token), {
    retry: retryPublisher,
  })
}

export function usePublisherLicenseTypes(appId: string | null) {
  const did = useDid()
  return useAuthedQuery<PublisherLicenseType[]>(
    publisherKeys.types(appId ?? '', did),
    (token) => fetchLicenseTypes(appId ?? '', token),
    { retry: retryPublisher, enabled: !!appId },
  )
}

export function usePublisherLicenses(appId: string | null, status: string | null) {
  const did = useDid()
  return useAuthedQuery<PublisherLicense[]>(
    publisherKeys.licenses(appId ?? '', status, did),
    (token) => fetchLicenses(appId ?? '', status, token),
    { retry: retryPublisher, enabled: !!appId },
  )
}

export function usePublisherEnvironments(appId: string | null) {
  const did = useDid()
  return useAuthedQuery<AppUserEnvironment[]>(
    publisherKeys.environments(appId ?? '', did),
    (token) => fetchEnvironments(appId ?? '', token),
    { retry: retryPublisher, enabled: !!appId },
  )
}
```

- [ ] **Step 5: Run it and watch it pass**

Run: `npx vitest run --config vitest.unit.config.ts modules/publisher/__tests__/use-publisher.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 6: Prove the enabled guard has teeth**

Delete `enabled: !!appId` from `usePublisherLicenseTypes`, run the test, confirm the "does not fire without an appId" case fails. Restore, confirm `git status --porcelain` is empty.

- [ ] **Step 7: Commit**

```bash
git add modules/publisher/hooks modules/publisher/__tests__/use-publisher.test.tsx
git commit -m "feat(publisher): query keys and read hooks"
```

---

### Task 6: mutation hooks

**Files:**
- Create: `modules/publisher/hooks/use-publisher-mutations.ts`
- Test: `modules/publisher/__tests__/use-publisher-mutations.test.tsx`

**Interfaces:**
- Consumes: `usePublisherToken`, `publisherKeys`, the mutation fetchers.
- Produces: `useCreateLicenseType(appId)`, `useSetLicenseTypeDetails(appId)`, `useSetLicenseTypeTemplate(appId)`, `useAddLicenseTypeService(appId)`, `useAddLicenseTypePackage(appId)`, `usePublishLicenseType(appId)`, `useRetireLicenseType(appId)`, `useIssueGrant(appId)`, `useRevokeLicense(appId)` — each a `UseMutationResult` that invalidates the right keys on success.

- [ ] **Step 1: Write the failing test**

```tsx
// modules/publisher/__tests__/use-publisher-mutations.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'

const createLicenseType = vi.fn()
const issueGrant = vi.fn()
const waitForToken = vi.fn()
vi.mock('../graphql', async (orig) => ({
  ...(await orig<typeof import('../graphql')>()),
  createLicenseType: (...a: unknown[]) => createLicenseType(...a),
  issueGrant: (...a: unknown[]) => issueGrant(...a),
}))
vi.mock('@/modules/apps/lib/token', () => ({ waitForToken: (f: () => unknown) => waitForToken(f) }))
vi.mock('@/modules/cloud/graphql', () => ({ getAuthToken: async () => 'tok', getCloudEndpoint: () => '/graphql' }))
vi.mock('@powerhousedao/reactor-browser', () => ({ useRenown: () => ({ user: { did: 'did:key:z1' } }) }))

import { useCreateLicenseType, useIssueGrant } from '../hooks/use-publisher-mutations'
import { publisherKeys } from '../hooks/keys'

let qc: QueryClient
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={qc}>{children}</QueryClientProvider>
)

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  createLicenseType.mockReset(); issueGrant.mockReset()
  waitForToken.mockReset().mockImplementation(async (f: () => unknown) => f())
})

describe('publisher mutation hooks', () => {
  it('resolves the token through waitForToken, not a bare getAuthToken', async () => {
    // Review Focus 5: a grant fired right after login would otherwise go out
    // unauthenticated and come back UNAUTHENTICATED for no visible reason.
    createLicenseType.mockResolvedValue('lt-1')
    const { result } = renderHook(() => useCreateLicenseType('app-1'), { wrapper })
    await act(async () => { await result.current.mutateAsync({ appId: 'app-1', kind: 'PRO' }) })
    expect(waitForToken).toHaveBeenCalled()
  })

  it('invalidates the tier list for this app after a create', async () => {
    createLicenseType.mockResolvedValue('lt-1')
    const spy = vi.spyOn(qc, 'invalidateQueries')
    const { result } = renderHook(() => useCreateLicenseType('app-1'), { wrapper })
    await act(async () => { await result.current.mutateAsync({ appId: 'app-1', kind: 'PRO' }) })
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith({ queryKey: publisherKeys.types('app-1', 'did:key:z1') }),
    )
  })

  it('a grant invalidates licences AND environments, because the keeper creates one', async () => {
    issueGrant.mockResolvedValue('lic-1')
    const spy = vi.spyOn(qc, 'invalidateQueries')
    const { result } = renderHook(() => useIssueGrant('app-1'), { wrapper })
    await act(async () => {
      await result.current.mutateAsync({ appId: 'app-1', licenseTypeId: 'lt-1', user: '0xabc' })
    })
    const keys = spy.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey))
    expect(keys.some((k) => k.includes('licenses'))).toBe(true)
    expect(keys.some((k) => k.includes('environments'))).toBe(true)
  })

  it('surfaces the server error unchanged', async () => {
    createLicenseType.mockRejectedValue(new Error('licensing is disabled'))
    const { result } = renderHook(() => useCreateLicenseType('app-1'), { wrapper })
    const err = await result.current.mutateAsync({ appId: 'app-1', kind: 'PRO' }).catch((e) => e)
    expect((err as Error).message).toBe('licensing is disabled')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --config vitest.unit.config.ts modules/publisher/__tests__/use-publisher-mutations.test.tsx`
Expected: FAIL — `../hooks/use-publisher-mutations` does not exist.

- [ ] **Step 3: Implement**

```ts
// modules/publisher/hooks/use-publisher-mutations.ts
'use client'

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRenown } from '@powerhousedao/reactor-browser'
import * as api from '../graphql'
import type {
  CreateLicenseTypeInput, SetLicenseTypeDetailsInput, SetLicenseTypeTemplateInput,
  AddLicenseTypeServiceInput, AddLicenseTypePackageInput, IssueGrantInput, RevokeLicenseInput,
} from '../types'
import { publisherKeys } from './keys'
import { usePublisherToken } from './use-publisher'

function useDid(): string {
  const renown = useRenown() as { user?: { did?: string } } | null
  return renown?.user?.did ?? 'anon'
}

/** Tier mutations invalidate the tier list. */
function useTierMutation<V>(appId: string, fn: (vars: V, token: string | null) => Promise<unknown>) {
  const qc = useQueryClient()
  const did = useDid()
  const token = usePublisherToken()
  return useMutation({
    mutationFn: async (vars: V) => fn(vars, await token()),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: publisherKeys.types(appId, did) })
    },
  })
}

/** Licence mutations invalidate licences and environments: the provisioning
 *  keeper turns a licence change into an environment change on its next tick. */
function useLicenceMutation<V, R>(appId: string, fn: (vars: V, token: string | null) => Promise<R>) {
  const qc = useQueryClient()
  const did = useDid()
  const token = usePublisherToken()
  return useMutation({
    mutationFn: async (vars: V) => fn(vars, await token()),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: publisherKeys.licenses(appId, null, did) })
      void qc.invalidateQueries({ queryKey: publisherKeys.licenses(appId, 'ACTIVE', did) })
      void qc.invalidateQueries({ queryKey: publisherKeys.environments(appId, did) })
    },
  })
}

export const useCreateLicenseType = (appId: string) =>
  useTierMutation<CreateLicenseTypeInput>(appId, (v, t) => api.createLicenseType(v, t))
export const useSetLicenseTypeDetails = (appId: string) =>
  useTierMutation<SetLicenseTypeDetailsInput>(appId, (v, t) => api.setLicenseTypeDetails(v, t))
export const useSetLicenseTypeTemplate = (appId: string) =>
  useTierMutation<SetLicenseTypeTemplateInput>(appId, (v, t) => api.setLicenseTypeTemplate(v, t))
export const useAddLicenseTypeService = (appId: string) =>
  useTierMutation<AddLicenseTypeServiceInput>(appId, (v, t) => api.addLicenseTypeService(v, t))
export const useAddLicenseTypePackage = (appId: string) =>
  useTierMutation<AddLicenseTypePackageInput>(appId, (v, t) => api.addLicenseTypePackage(v, t))
export const usePublishLicenseType = (appId: string) =>
  useTierMutation<string>(appId, (id, t) => api.publishLicenseType(id, t))
export const useRetireLicenseType = (appId: string) =>
  useTierMutation<string>(appId, (id, t) => api.retireLicenseType(id, t))

export const useIssueGrant = (appId: string) =>
  useLicenceMutation<IssueGrantInput, string>(appId, (v, t) => api.issueGrant(v, t))
export const useRevokeLicense = (appId: string) =>
  useLicenceMutation<RevokeLicenseInput, boolean>(appId, (v, t) => api.revokeLicense(v, t))
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run --config vitest.unit.config.ts modules/publisher/__tests__/use-publisher-mutations.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 5: Prove the token rule has teeth**

Replace `await token()` with `await getAuthToken(null)` in `useTierMutation`, run the test, confirm the `waitForToken` case fails. Restore, confirm `git status --porcelain` is empty.

- [ ] **Step 6: Commit**

```bash
git add modules/publisher/hooks/use-publisher-mutations.ts modules/publisher/__tests__/use-publisher-mutations.test.tsx
git commit -m "feat(publisher): tier and licence mutation hooks"
```

---

### Task 7: route, page shell, app picker and navigation

**Files:**
- Create: `app/user/publisher/page.tsx`
- Create: `modules/publisher/components/publisher-dashboard.tsx`
- Create: `modules/publisher/lib/status.ts`
- Create: `modules/publisher/components/status.tsx`
- Modify: `modules/shared/components/navbar/navbar-config.tsx`
- Test: `modules/publisher/__tests__/publisher-dashboard.test.tsx`

**Interfaces:**
- Consumes: `useMyApps`, `usePublisherLicenseTypes` and siblings.
- Produces: `PublisherDashboard` (default export of the component file), `tierStatusMeta(status)`, `licenseStatusMeta(status)`, `StatusPill({ meta })`.

**The route must be `app/user/publisher/page.tsx`.** `proxy.ts`'s matcher is `['/user/:path*', '/profile/:path*']`, so this path is auth-gated with no further work; `app/publisher/` would be public.

- [ ] **Step 1: Write the failing test**

```tsx
// modules/publisher/__tests__/publisher-dashboard.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import React from 'react'

let appsState: { data?: unknown; isPending?: boolean; error?: Error | null; isSuccess?: boolean } = {}
vi.mock('../hooks/use-publisher', () => ({
  useMyApps: () => appsState,
  usePublisherLicenseTypes: () => ({ data: [], isPending: false }),
  usePublisherLicenses: () => ({ data: [], isPending: false }),
  usePublisherEnvironments: () => ({ data: [], isPending: false }),
  usePublisherToken: () => async () => 'tok',
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/user/publisher',
  useSearchParams: () => new URLSearchParams(),
}))

import PublisherDashboard from '../components/publisher-dashboard'

beforeEach(() => { appsState = {} })

describe('PublisherDashboard', () => {
  it('shows an empty state, not a spinner, when the wallet owns no apps', async () => {
    // Review Focus 1. Indexing apps[0] here would throw and blank the page.
    appsState = { data: [], isPending: false, isSuccess: true, error: null }
    render(<PublisherDashboard />)
    expect(await screen.findByText(/no apps/i)).toBeTruthy()
    expect(screen.queryByRole('tablist')).toBeNull()
  })

  it('renders the tabs when the wallet owns one app and shows no picker', async () => {
    appsState = { data: [{ id: 'a1', name: 'Knowledge Vault', status: 'ACTIVE' }], isPending: false, isSuccess: true }
    render(<PublisherDashboard />)
    expect(await screen.findByRole('tablist')).toBeTruthy()
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('shows an app picker when the wallet owns more than one', async () => {
    appsState = {
      data: [
        { id: 'a1', name: 'Knowledge Vault', status: 'ACTIVE' },
        { id: 'a2', name: 'Other', status: 'ACTIVE' },
      ],
      isPending: false,
      isSuccess: true,
    }
    render(<PublisherDashboard />)
    expect(await screen.findByRole('combobox')).toBeTruthy()
  })

  it('surfaces the server error text verbatim and offers a retry', async () => {
    appsState = { data: undefined, isPending: false, error: new Error('sign in to manage licences') }
    render(<PublisherDashboard />)
    expect(await screen.findByText('sign in to manage licences')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --config vitest.unit.config.ts modules/publisher/__tests__/publisher-dashboard.test.tsx`
Expected: FAIL — the component does not exist.

- [ ] **Step 3: Write the status helpers**

```ts
// modules/publisher/lib/status.ts
export type StatusTone = 'neutral' | 'positive' | 'warning' | 'danger'
export type StatusMeta = { label: string; tone: StatusTone }

export function tierStatusMeta(status: string): StatusMeta {
  switch (status) {
    case 'DRAFT': return { label: 'Draft', tone: 'neutral' }
    case 'ACTIVE': return { label: 'Active', tone: 'positive' }
    case 'RETIRED': return { label: 'Retired', tone: 'danger' }
    default: return { label: status, tone: 'neutral' }
  }
}

export function licenseStatusMeta(status: string): StatusMeta {
  switch (status) {
    case 'ISSUED': return { label: 'Issued', tone: 'neutral' }
    case 'ACTIVE': return { label: 'Active', tone: 'positive' }
    case 'EXPIRED': return { label: 'Expired', tone: 'warning' }
    case 'REVOKED': return { label: 'Revoked', tone: 'danger' }
    default: return { label: status, tone: 'neutral' }
  }
}

export const TONE_BADGE: Record<StatusTone, string> = {
  neutral: 'bg-muted text-muted-foreground',
  positive: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  warning: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  danger: 'bg-destructive/10 text-destructive',
}
```

```tsx
// modules/publisher/components/status.tsx
import { cn } from '@/shared/lib/utils'
import { TONE_BADGE, type StatusMeta } from '../lib/status'

export function StatusPill({ meta }: { meta: StatusMeta }) {
  return (
    <span className={cn('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium', TONE_BADGE[meta.tone])}>
      {meta.label}
    </span>
  )
}
```

- [ ] **Step 4: Write the dashboard shell**

```tsx
// modules/publisher/components/publisher-dashboard.tsx
'use client'

import React, { useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/shared/components/ui/alert'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/components/ui/select'
import { useMyApps } from '../hooks/use-publisher'
import { describePublisherError } from '../graphql'
import { TiersTab } from './tiers-tab'
import { HoldersTab } from './holders-tab'
import { EnvironmentsTab } from './environments-tab'

const TABS = ['tiers', 'holders', 'environments'] as const
type TabKey = (typeof TABS)[number]

export default function PublisherDashboard() {
  const apps = useMyApps()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  const list = apps.data ?? []
  const [selected, setSelected] = useState<string | null>(null)
  const appId = selected ?? list[0]?.id ?? null

  const tab = useMemo<TabKey>(() => {
    const raw = params.get('tab')
    return (TABS as readonly string[]).includes(raw ?? '') ? (raw as TabKey) : 'tiers'
  }, [params])

  const setTab = (next: string) => {
    const qs = new URLSearchParams(params.toString())
    if (next === 'tiers') qs.delete('tab')
    else qs.set('tab', next)
    const s = qs.toString()
    router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false })
  }

  if (apps.isPending) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 py-16">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading your apps…
      </div>
    )
  }

  if (apps.error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not load your apps</AlertTitle>
        <AlertDescription>{describePublisherError(apps.error)}</AlertDescription>
      </Alert>
    )
  }

  if (list.length === 0) {
    return (
      <div className="border-border rounded-xl border border-dashed p-10 text-center">
        <h2 className="text-lg font-semibold">No apps yet</h2>
        <p className="text-muted-foreground mt-2 text-sm">
          Licensing is managed per app. Register an app first, then come back to define tiers and grant licences.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {list.length > 1 && (
        <Select value={appId ?? undefined} onValueChange={setSelected}>
          <SelectTrigger className="w-72"><SelectValue placeholder="Choose an app" /></SelectTrigger>
          <SelectContent>
            {list.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
          </SelectContent>
        </Select>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="tiers">Tiers</TabsTrigger>
          <TabsTrigger value="holders">Holders</TabsTrigger>
          <TabsTrigger value="environments">Environments</TabsTrigger>
        </TabsList>
        <TabsContent value="tiers">{appId && <TiersTab appId={appId} />}</TabsContent>
        <TabsContent value="holders">{appId && <HoldersTab appId={appId} />}</TabsContent>
        <TabsContent value="environments">{appId && <EnvironmentsTab appId={appId} />}</TabsContent>
      </Tabs>
    </div>
  )
}
```

For this task only, create the three tab components as one-line placeholders returning `null` so the shell compiles; Tasks 8–10 replace them. Record in the report that they are stubs.

- [ ] **Step 5: Write the route**

```tsx
// app/user/publisher/page.tsx
'use client'

import { EarlyAccessGate } from '@/modules/invites/early-access-gate'
import PublisherDashboard from '@/modules/publisher/components/publisher-dashboard'

export default function PublisherPage() {
  return (
    <EarlyAccessGate>
      <main className="mx-auto mt-20 max-w-screen-xl px-4 py-8 sm:px-6">
        <h1 className="mb-6 text-2xl font-semibold">Licensing</h1>
        <PublisherDashboard />
      </main>
    </EarlyAccessGate>
  )
}
```

Check the real export style of `EarlyAccessGate` in `modules/invites/early-access-gate.tsx` (default vs named) and match it.

- [ ] **Step 6: Register the nav item in BOTH places**

In `modules/shared/components/navbar/navbar-config.tsx`, add to `PRIVATE_NAV_ITEMS` **and** to `NAVBAR_CONFIGS['/vetra'].navItems`:

```tsx
{ label: 'Licensing', href: '/user/publisher', isActive: (p: string) => p.startsWith('/user/publisher') },
```

Missing the second one is the known failure here: the item appears in one surface and not the other.

- [ ] **Step 7: Run the tests and typecheck**

Run: `npx vitest run --config vitest.unit.config.ts modules/publisher && pnpm tsc`
Expected: PASS, and tsc exits 0.

- [ ] **Step 8: Commit**

```bash
git add app/user/publisher modules/publisher modules/shared/components/navbar/navbar-config.tsx
git commit -m "feat(publisher): dashboard shell, app picker and route"
```

---

### Task 8: Tiers tab

**Files:**
- Create: `modules/publisher/components/tiers-tab.tsx`
- Create: `modules/publisher/components/create-tier-dialog.tsx`
- Create: `modules/publisher/components/tier-detail.tsx`
- Test: `modules/publisher/__tests__/tiers-tab.test.tsx`

**Interfaces:**
- Consumes: `usePublisherLicenseTypes`, `useCreateLicenseType`, `useSetLicenseTypeDetails`, `useSetLicenseTypeTemplate`, `useAddLicenseTypeService`, `useAddLicenseTypePackage`, `usePublishLicenseType`, `useRetireLicenseType`, `StatusPill`, `tierStatusMeta`.
- Produces: `TiersTab({ appId })` (named export), `CreateTierDialog`, `TierDetail`.

Service types offered: `CONNECT`, `SWITCHBOARD`, `FUSION`, `CLINT`. **CLINT must be listed and flagged as not provisionable**, matching the Connect editor, rather than hidden.

- [ ] **Step 1: Write the failing test**

```tsx
// modules/publisher/__tests__/tiers-tab.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import React from 'react'

const publish = vi.fn()
const retire = vi.fn()
let types: unknown[] = []
vi.mock('../hooks/use-publisher', () => ({ usePublisherLicenseTypes: () => ({ data: types, isPending: false, error: null }) }))
vi.mock('../hooks/use-publisher-mutations', () => ({
  useCreateLicenseType: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSetLicenseTypeDetails: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSetLicenseTypeTemplate: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useAddLicenseTypeService: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useAddLicenseTypePackage: () => ({ mutateAsync: vi.fn(), isPending: false }),
  usePublishLicenseType: () => ({ mutateAsync: publish, isPending: false }),
  useRetireLicenseType: () => ({ mutateAsync: retire, isPending: false }),
}))

import { TiersTab } from '../components/tiers-tab'

const tier = (over: Record<string, unknown> = {}) => ({
  id: 'lt-1', kind: 'PRO', label: 'Pro', status: 'DRAFT', validityDays: 365,
  templateHash: 'h', services: [], packages: [], ...over,
})

beforeEach(() => { types = []; publish.mockReset(); retire.mockReset() })

describe('TiersTab', () => {
  it('says tiers are append-only where a publisher would otherwise be surprised', () => {
    types = [tier()]
    render(<TiersTab appId="a1" />)
    expect(screen.getByText(/cannot be removed/i)).toBeTruthy()
  })

  it('lists CLINT but marks it as not provisionable', () => {
    types = [tier()]
    render(<TiersTab appId="a1" />)
    expect(screen.getByText(/CLINT/)).toBeTruthy()
    expect(screen.getByText(/not provisionable/i)).toBeTruthy()
  })

  it('warns that retiring does NOT end service for existing holders', () => {
    types = [tier({ status: 'ACTIVE' })]
    render(<TiersTab appId="a1" />)
    fireEvent.click(screen.getByRole('button', { name: /retire/i }))
    expect(screen.getByText(/existing holders keep/i)).toBeTruthy()
  })

  it('warns that publishing a RETIRED tier reactivates it', () => {
    types = [tier({ status: 'RETIRED' })]
    render(<TiersTab appId="a1" />)
    fireEvent.click(screen.getByRole('button', { name: /publish/i }))
    expect(screen.getByText(/reactivate/i)).toBeTruthy()
  })

  it('renders an empty state when the app has no tiers', () => {
    types = []
    render(<TiersTab appId="a1" />)
    expect(screen.getByText(/no tiers/i)).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --config vitest.unit.config.ts modules/publisher/__tests__/tiers-tab.test.tsx`
Expected: FAIL — `../components/tiers-tab` does not exist.

- [ ] **Step 3: Implement `tiers-tab.tsx`**

Build a table of tiers using the `app-deployments.tsx:155-290` pattern — columns Label, Kind, Status (`StatusPill` + `tierStatusMeta`), Validity, Services, Packages, Actions — wrapped in `<div className="bg-card border-border overflow-x-auto rounded-xl border shadow-sm">`, with a `sr-only` "Actions" header on the last column. Above the table render a "New tier" button opening `CreateTierDialog`, and this note, always visible:

```tsx
<p className="text-muted-foreground text-sm">
  Tiers are append-only: a service or package added by mistake cannot be removed — retire the tier and replace it.
</p>
```

Row actions: **Publish** when status is `DRAFT` or `RETIRED`, **Retire** when `ACTIVE`, and **Edit** opening `TierDetail`. Both Publish and Retire go through `AlertDialog` (the `RollbackDialog` pattern at `app-deployments.tsx:99-147`) with this copy:

- Retire: “Retiring stops new grants of this tier. **Existing holders keep their environments** — revoke a licence to end service for a holder.”
- Publish on a `RETIRED` tier: “This tier is retired. Publishing will **reactivate** it and allow new grants again.”

In `TierDetail`, the service-type select offers `CONNECT`, `SWITCHBOARD`, `FUSION` and `CLINT`, with CLINT rendered as `CLINT — not provisionable yet` and the submit disabled while it is chosen. Errors from mutations go through `toast.error(describePublisherError(err))`.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run --config vitest.unit.config.ts modules/publisher/__tests__/tiers-tab.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 5: Prove one warning has teeth**

Delete the “existing holders keep” sentence from the retire dialog, run the test, confirm that case fails. Restore, confirm `git status --porcelain` is empty.

- [ ] **Step 6: Commit**

```bash
git add modules/publisher/components modules/publisher/__tests__/tiers-tab.test.tsx
git commit -m "feat(publisher): tiers tab with append-only and lifecycle warnings"
```

---

### Task 9: Holders tab — grant and revoke

**Files:**
- Create: `modules/publisher/components/holders-tab.tsx`
- Create: `modules/publisher/components/grant-dialog.tsx`
- Test: `modules/publisher/__tests__/holders-tab.test.tsx`

**Interfaces:**
- Consumes: `usePublisherLicenses`, `usePublisherLicenseTypes`, `useIssueGrant`, `useRevokeLicense`, `StatusPill`, `licenseStatusMeta`.
- Produces: `HoldersTab({ appId })`, `GrantDialog({ appId, licenses, types, open, onOpenChange })`.

- [ ] **Step 1: Write the failing test**

```tsx
// modules/publisher/__tests__/holders-tab.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import React from 'react'

const issueGrant = vi.fn()
const revoke = vi.fn()
let licenses: unknown[] = []
vi.mock('../hooks/use-publisher', () => ({
  usePublisherLicenses: () => ({ data: licenses, isPending: false, error: null }),
  usePublisherLicenseTypes: () => ({ data: [{ id: 'lt-1', label: 'Pro', kind: 'PRO', status: 'ACTIVE', validityDays: 365, templateHash: 'h', services: [], packages: [] }], isPending: false }),
}))
vi.mock('../hooks/use-publisher-mutations', () => ({
  useIssueGrant: () => ({ mutateAsync: issueGrant, isPending: false }),
  useRevokeLicense: () => ({ mutateAsync: revoke, isPending: false }),
}))

import { HoldersTab } from '../components/holders-tab'

const HOLDER = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01'

beforeEach(() => { licenses = []; issueGrant.mockReset(); revoke.mockReset() })

describe('HoldersTab', () => {
  it('warns before granting a SECOND licence to an address that already holds one', async () => {
    // Review Focus 4: computeLicensePlan picks the lowest licence id, and ids are
    // UUIDs, so a silent upgrade works only about half the time.
    licenses = [{ id: 'lic-1', user: HOLDER.toLowerCase(), licenseTypeId: 'lt-1', status: 'ACTIVE', start: null, end: null, environmentId: 'env-1' }]
    render(<HoldersTab appId="a1" />)
    fireEvent.click(screen.getByRole('button', { name: /grant/i }))
    fireEvent.change(screen.getByLabelText(/address/i), { target: { value: HOLDER } })
    expect(await screen.findByText(/already holds an active licence/i)).toBeTruthy()
    expect(screen.getByText(/which one applies is not deterministic/i)).toBeTruthy()
  })

  it('matches the existing holder case-insensitively', async () => {
    // Addresses arrive checksummed from a wallet and lowercased from the server;
    // a case-sensitive compare would miss the duplicate and show no warning.
    licenses = [{ id: 'lic-1', user: HOLDER.toLowerCase(), licenseTypeId: 'lt-1', status: 'ACTIVE', start: null, end: null, environmentId: null }]
    render(<HoldersTab appId="a1" />)
    fireEvent.click(screen.getByRole('button', { name: /grant/i }))
    fireEvent.change(screen.getByLabelText(/address/i), { target: { value: HOLDER.toUpperCase().replace('0X', '0x') } })
    expect(await screen.findByText(/already holds an active licence/i)).toBeTruthy()
  })

  it('does NOT warn for an address holding only a revoked licence', async () => {
    licenses = [{ id: 'lic-1', user: HOLDER.toLowerCase(), licenseTypeId: 'lt-1', status: 'REVOKED', start: null, end: null, environmentId: null }]
    render(<HoldersTab appId="a1" />)
    fireEvent.click(screen.getByRole('button', { name: /grant/i }))
    fireEvent.change(screen.getByLabelText(/address/i), { target: { value: HOLDER } })
    expect(screen.queryByText(/already holds an active licence/i)).toBeNull()
  })

  it('revoking asks for confirmation before calling the server', () => {
    licenses = [{ id: 'lic-1', user: HOLDER.toLowerCase(), licenseTypeId: 'lt-1', status: 'ACTIVE', start: null, end: null, environmentId: 'env-1' }]
    render(<HoldersTab appId="a1" />)
    fireEvent.click(screen.getByRole('button', { name: /revoke/i }))
    expect(revoke).not.toHaveBeenCalled()
    expect(screen.getByText(/release their environment/i)).toBeTruthy()
  })

  it('renders an empty state when nobody holds a licence', () => {
    render(<HoldersTab appId="a1" />)
    expect(screen.getByText(/no licences/i)).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --config vitest.unit.config.ts modules/publisher/__tests__/holders-tab.test.tsx`
Expected: FAIL — `../components/holders-tab` does not exist.

- [ ] **Step 3: Implement**

A table with columns Holder, Tier, Status (`StatusPill` + `licenseStatusMeta`), Start, End, Environment, Actions, plus a "Grant licence" button opening `GrantDialog`, and a status filter driving `usePublisherLicenses(appId, status)`.

`GrantDialog` uses react-hook-form + zod with `user` validated as `/^0x[a-fA-F0-9]{40}$/` and a required `licenseTypeId` select listing only `ACTIVE` tiers. The duplicate check is:

```ts
const duplicate = licenses.some(
  (l) => l.status === 'ACTIVE' && l.user.toLowerCase() === address.trim().toLowerCase(),
)
```

When `duplicate` is true, render, above the submit button:

```tsx
<Alert variant="destructive">
  <AlertTitle>This address already holds an active licence</AlertTitle>
  <AlertDescription>
    Granting a second one does not replace the first. Which one applies is not deterministic — revoke the existing
    licence first if you mean to change their tier.
  </AlertDescription>
</Alert>
```

Revoke uses `AlertDialog` with copy “Revoking ends this licence. The provisioning keeper will release their environment on its next tick.” and an optional reason field feeding `RevokeLicenseInput.reason`.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run --config vitest.unit.config.ts modules/publisher/__tests__/holders-tab.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 5: Prove the duplicate warning has teeth**

Remove `.toLowerCase()` from both sides of the duplicate check, run the tests, confirm the case-insensitivity test fails. Restore, confirm `git status --porcelain` is empty.

- [ ] **Step 6: Commit**

```bash
git add modules/publisher/components modules/publisher/__tests__/holders-tab.test.tsx
git commit -m "feat(publisher): holders tab with grant and revoke"
```

---

### Task 10: Environments tab, and the disabled-deployment behaviour

**Files:**
- Create: `modules/publisher/components/environments-tab.tsx`
- Test: `modules/publisher/__tests__/environments-tab.test.tsx`
- Test: `modules/publisher/__tests__/disabled-deployment.test.tsx`

**Interfaces:**
- Consumes: `usePublisherEnvironments`, `useCreateLicenseType`.
- Produces: `EnvironmentsTab({ appId })`.

- [ ] **Step 1: Write the failing tests**

```tsx
// modules/publisher/__tests__/environments-tab.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import React from 'react'

let state: Record<string, unknown> = {}
vi.mock('../hooks/use-publisher', () => ({ usePublisherEnvironments: () => state }))

import { EnvironmentsTab } from '../components/environments-tab'

beforeEach(() => { state = {} })

describe('EnvironmentsTab', () => {
  it('lists the rows', () => {
    state = { data: [{ appId: 'a1', user: '0xabc', environmentId: 'env-1', licenseId: 'lic-1', templateHash: 'h1' }], isPending: false, error: null }
    render(<EnvironmentsTab appId="a1" />)
    expect(screen.getByText('env-1')).toBeTruthy()
  })

  it('explains the delay instead of showing a bare empty table', () => {
    state = { data: [], isPending: false, error: null }
    render(<EnvironmentsTab appId="a1" />)
    expect(screen.getByText(/no environments/i)).toBeTruthy()
    expect(screen.getByText(/appear shortly after/i)).toBeTruthy()
  })

  it('surfaces a read error verbatim', () => {
    state = { data: undefined, isPending: false, error: new Error('no such app') }
    render(<EnvironmentsTab appId="a1" />)
    expect(screen.getByText('no such app')).toBeTruthy()
  })
})
```

```tsx
// modules/publisher/__tests__/disabled-deployment.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import React from 'react'
import { PublisherApiError } from '../graphql'

// Review Focus 2: on a deployment with licensing switched off, READS still work
// and every mutation refuses. The dashboard must look normal and fail only on
// the action — that is the designed state, not a broken page.
vi.mock('../hooks/use-publisher', () => ({
  usePublisherLicenseTypes: () => ({
    data: [{ id: 'lt-1', kind: 'PRO', label: 'Pro', status: 'ACTIVE', validityDays: 365, templateHash: 'h', services: [], packages: [] }],
    isPending: false,
    error: null,
  }),
}))
vi.mock('../hooks/use-publisher-mutations', () => {
  const refuse = { mutateAsync: vi.fn().mockRejectedValue(new PublisherApiError('LICENSING_DISABLED', 'licensing is disabled on this deployment', null)), isPending: false }
  return {
    useCreateLicenseType: () => refuse, useSetLicenseTypeDetails: () => refuse,
    useSetLicenseTypeTemplate: () => refuse, useAddLicenseTypeService: () => refuse,
    useAddLicenseTypePackage: () => refuse, usePublishLicenseType: () => refuse,
    useRetireLicenseType: () => refuse,
  }
})

import { TiersTab } from '../components/tiers-tab'

describe('a deployment with licensing disabled', () => {
  it('still renders the tier list rather than an error page', () => {
    render(<TiersTab appId="a1" />)
    expect(screen.getByText('Pro')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run --config vitest.unit.config.ts modules/publisher/__tests__/environments-tab.test.tsx modules/publisher/__tests__/disabled-deployment.test.tsx`
Expected: FAIL — `../components/environments-tab` does not exist.

- [ ] **Step 3: Implement**

```tsx
// modules/publisher/components/environments-tab.tsx
'use client'

import { Loader2 } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/shared/components/ui/alert'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/shared/components/ui/table'
import { usePublisherEnvironments } from '../hooks/use-publisher'
import { describePublisherError } from '../graphql'

export function EnvironmentsTab({ appId }: { appId: string }) {
  const envs = usePublisherEnvironments(appId)

  if (envs.isPending) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 py-10">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading environments…
      </div>
    )
  }
  if (envs.error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not load environments</AlertTitle>
        <AlertDescription>{describePublisherError(envs.error)}</AlertDescription>
      </Alert>
    )
  }
  const rows = envs.data ?? []
  if (rows.length === 0) {
    return (
      <div className="border-border rounded-xl border border-dashed p-10 text-center">
        <h3 className="font-medium">No environments yet</h3>
        <p className="text-muted-foreground mt-2 text-sm">
          Environments appear shortly after a licence becomes active — provisioning runs on a timer, so it is not instant.
        </p>
      </div>
    )
  }

  return (
    <div className="bg-card border-border overflow-x-auto rounded-xl border shadow-sm">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Holder</TableHead>
            <TableHead>Environment</TableHead>
            <TableHead>Licence</TableHead>
            <TableHead>Template</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.environmentId}>
              <TableCell className="font-mono text-xs">{r.user}</TableCell>
              <TableCell className="font-mono text-xs">{r.environmentId}</TableCell>
              <TableCell className="font-mono text-xs">{r.licenseId}</TableCell>
              <TableCell className="font-mono text-xs">{r.templateHash.slice(0, 12)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run --config vitest.unit.config.ts modules/publisher`
Expected: PASS, every publisher test.

- [ ] **Step 5: Full verification**

Run: `pnpm tsc && pnpm lint && pnpm test:unit && pnpm build`

`pnpm test:unit` has **3 pre-existing failures** on this branch — `use-create-studio-environment`, `use-create-environment` and `agent-card` — which fail identically on `origin/main` and `origin/staging` and are unrelated to this work. Any fourth failure is yours.

- [ ] **Step 6: Commit**

```bash
git add modules/publisher
git commit -m "feat(publisher): environments tab and disabled-deployment behaviour"
```

---

## Self-review

**Spec coverage.** Component 3 of the spec asks for an app picker shown only when `myApps` returns more than one (Task 7), Tiers with list/create/edit/add service/add package/publish/retire (Task 8), Holders with status, holder, tier, linked environment, a grant form and a revoke behind confirmation (Task 9), and Environments (Task 10). The spec's error-handling section — reads available while licensing is disabled, mutations refusing, backend text verbatim — is Tasks 2 and 10. All five Known limitations have an owning task in the table above. The spec's `app/publisher/` route is deliberately corrected to `app/user/publisher/` and the reason is recorded in Global Constraints.

**Type consistency.** `PublisherLicenseType.services` is `PublisherTemplateService[]` in Task 2 and consumed under that name in Task 8. `createLicenseType` and `issueGrant` return `string` in Tasks 4 and 6; every other mutation returns `boolean`. `publishLicenseType`/`retireLicenseType` take a bare `licenseTypeId: string`, matching the server, while the other tier mutations take an input object — Task 6's `useTierMutation<string>` for those two reflects that.

**Review Focus coverage.** 1 → Task 5 (empty array) and Task 7 (empty state, no `apps[0]` crash). 2 → Task 10's `disabled-deployment.test.tsx`. 3 → Task 2's verbatim test plus its mutation. 4 → Task 9's duplicate-holder tests, including the case-insensitivity one. 5 → Task 6's `waitForToken` test and mutation.

**Known gap, deliberately not covered.** No test drives the real staging endpoint; everything is mocked at the fetcher or hook boundary. The surface was introspected from live staging while writing this plan, so the documents and types match the server as deployed, but a schema change would not be caught by this suite. Reconciling that is a follow-up, not a task here.
