# Licensing redesign — vetra.io Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every publisher one page per app (`/user/apps/[id]`) that holds artifacts, templates, plans, holders and invite codes; give every owner a Subscriptions page and a shareable `/redeem/<code>` flow; replace the invite-code early-access gate with a Vetra Studio licence gate.

**Architecture:** The publisher data layer stays in `modules/publisher` (rewritten against the `vetraPublisher` contract) and renders as tabs inside the existing `modules/apps` app page. A new `modules/subscriptions` module carries the owner side (`vetraSubscriptions`: subscriptions, redeem, studio access, studio key). A new `modules/studio-license` module replaces `modules/invites` with a gate that reads `vetraSubscriptions.studioAccess`. All GraphQL is hand-written and goes through the existing `publisherGql` transport and `PublisherApiError` mapping.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Tailwind v4, shadcn/Radix (`modules/shared/components/ui`), react-hook-form + zod, TanStack Query via `useAuthedQuery`, sonner, lucide-react, date-fns, vitest + happy-dom + Testing Library, Playwright.

**Spec:** `/home/f/projects/vetra-cloud-package-licensing/docs/superpowers/specs/2026-10-08-app-document-licensing-redesign-design.md` (section "vetra.io") and the binding API contract `/home/f/projects/vetra-cloud-package-licensing/docs/superpowers/specs/2026-10-08-licensing-api-contract.md`. Executors read both.

**Repo / branch:** `/home/f/projects/vetra.io-licensing`, branch `feat/app-licensing-redesign` (based on `origin/staging`). Every path below is relative to that worktree. PR targets `staging` first, then `main`.

## Global Constraints

- GraphQL strings must match the contract exactly: namespaces `vetraPublisher` and `vetraSubscriptions`, field, argument, input-type and output-field names as listed in the contract. No codegen; hand-written strings.
- Enum values travel as `String`: template mode `SHARED | DEDICATED`; term status `DRAFT | ACTIVE | RETIRED`; issuers `INVITE_CODE | PUBLISHER_GRANT | ACHRA_SUBSCRIPTION`; licence status `ISSUED | ACTIVE | EXPIRED | REVOKED | REPLACED`; warning kind `EXPIRING | ENDED_STOP_PENDING | STOPPED_DELETE_PENDING | DELETE_IMMINENT`.
- `user` arguments accept `did:pkh:eip155:<chain>:0x…` or a bare `0x` address; every other DID method is refused server-side with `UNSUPPORTED_DID`. Client validation accepts exactly those two shapes.
- Server error codes (`extensions.code`): `NOT_FOUND`, `FORBIDDEN`, `INVALID_INPUT`, `APP_NOT_ACTIVE`, `NOT_ON_ALLOW_LIST`, `TERM_NOT_ISSUABLE`, `UNSUPPORTED_DID`, `LICENSING_DISABLED`, `INVALID_CODE`, `ALREADY_HOLDS`, plus `UNAUTHENTICATED` from the gateway. Server text is shown verbatim via `describePublisherError`; only `NETWORK` and `PUBLISHER_UNAVAILABLE` get our own copy.
- `VetraAccessCodes` no longer exists server-side. After Task 12 no client code references it (`grep -rn VetraAccessCodes app modules` returns nothing).
- No new dependencies and no new UI libraries. Use `modules/shared/components/ui/*`, `lucide-react`, `date-fns` (already installed).
- Mutations never retry (`useMutation` default `retry: 0`; never pass `retryPublisher` to a mutation). Queries use `retryPublisher`.
- Query keys embed the viewer DID (`useViewerDid().keyDid`); queries are `enabled` on the raw DID, never on `keyDid`.
- Copy: plain language in the tone of `docs/plain-language-cloud-copy.md` — short sentences, say what happens next, no jargon ("environment", "plan", "licence" are fine; "term", "issuer", "stage" are not shown to users). UI copy spells "licence" (noun) as the existing UI does; identifiers keep the API's `license`.
- Layout: everything works at 375 px wide. Tab bars scroll horizontally, tables sit in `overflow-x-auto`, dialogs and sheets scroll (`max-h-[85vh] overflow-y-auto` / sheet `overflow-y-auto`).
- Every list has a skeleton while loading, an empty state that names the next step, and an error state with a retry.
- Commits: conventional commits, **no `Co-Authored-By` trailer, no "Generated with" footer**.
- Gates before every commit of a task: `pnpm test:unit` (for the touched tests) and `pnpm tsc`. Before the final task: `pnpm tsc`, `pnpm lint`, `pnpm test:unit`, `pnpm build` all pass.

## Review Focus

1. **Template edits on a template with running environments** (`environmentCount > 0`): every write (details, add/remove service, add/remove package) must ask first, and *Keep editing* must not send anything. Pinned in Task 4 (`affects-confirm.test.tsx`) and Task 5 (`template-services.test.tsx`).
2. **Redeem while holding an ended licence for the same app**: only `ACTIVE`/`ISSUED` licences may be offered as "upgrade"; an `EXPIRED`/`REVOKED`/`REPLACED` one must not be. Pinned in Task 9 (`subscriptions-lib.test.ts`) and Task 11 (`redeem-flow.test.tsx`).
3. **Codes in URLs**: a custom code with mixed case, `-` or `_` must survive the copy link → `/redeem/<code>` → `inviteCode(code)` round trip unchanged; `%`-encoded paths decode once. Pinned in Task 8 (`invite-codes-lib.test.ts`) and Task 11 (`redeem-page.test.tsx`).
4. **A non-owner (admin) opening someone else's app**, including a deep link `?tab=holders`: no licensing tabs, falls back to Overview, no `vetraPublisher` per-app query fires. Pinned in Task 3 (`app-detail-tabs.test.tsx`).
5. **A transient `studioAccess` failure** must not tell a licensed user to redeem a code: it shows a retry, never the "you need a licence" panel. Pinned in Task 12 (`studio-license-gate.test.tsx`).

## Decisions taken in this plan

- **D1 Ownership:** licensing tabs show when `vetraPublisher.myApps` contains the app id (the server's own ownership rule), not by comparing `App.ownerAddress` client-side. Admins viewing another publisher's app see no licensing tabs.
- **D2 Gate scope:** `StudioLicenseGate` wraps `/user/studio`, `/user/apps/new` and `/user/environments/new` (all are "build with Vetra" actions). `/user`, `/user/apps/[id]`, `/user/environments`, `/user/subscriptions` and `/redeem` need only a Renown login. Existing app pages are deliberately not gated: a publisher whose studio licence ends must still be able to serve their holders.
- **D3 `/user/publisher`:** server redirect. `?app=<id>` → `/user/apps/<id>?tab=plans`; otherwise `/user`.
- **D4 Detail writes send every field.** `setTemplateDetails` and `setTermDetails` always send the full set of editable fields (unchanged values included). This is correct whether the server treats an absent key as "unchanged" or "clear", which the contract does not state.
- **D5 Holders filter client-side** over one unfiltered `licenses(appId)` query (the list is small and the grant dialog needs it unfiltered anyway).
- **D6 Transport reuse:** `vetraSubscriptions` calls use `publisherGql` (same `vetra-licensing` subgraph, same `extensions.code` mechanism). `PublisherApiError` keeps its name.

## File map

```
modules/publisher/
  graphql.ts                      REWRITE  vetraPublisher reads + writes, error codes
  types.ts                        REWRITE  contract types
  hooks/keys.ts                   REWRITE  per-resource keys
  hooks/use-publisher.ts          REWRITE  queries + useAppPublisher
  hooks/use-publisher-mutations.ts REWRITE mutations bound to appId
  hooks/use-viewer-did.ts         KEEP
  lib/format.ts                   NEW      shortDid, termName, templateName, validity/env text
  lib/status.ts                   REWRITE  StatusMeta (apps tones) for terms, licences, codes
  lib/run.ts                      NEW      runWithToast
  lib/artifacts.ts                NEW      channels + artifact copy
  lib/template.ts                 NEW      service types, describeTemplate, form <-> input
  lib/plan.ts                     NEW      plan schema, publishBlocker, kindFromLabel
  lib/holders.ts                  NEW      user pattern/normalise, joinHolders
  lib/invite-codes.ts             NEW      code pattern, redeemUrl, expiresAt
  components/primitives.tsx       NEW      TabHeader, TabSkeleton, EmptyState, TabError
  components/licensing-unavailable-banner.tsx NEW
  components/artifacts/artifacts-tab.tsx      NEW
  components/templates/*.tsx      NEW      tab, card, create dialog, editor sheet, details form,
                                           mode choice, services, packages, affects confirm
  components/plans/*.tsx          NEW      tab, plan dialog, publish/retire dialog
  components/holders/*.tsx        NEW      tab, grant, change plan, revoke, allow list
  components/invite-codes/*.tsx   NEW      tab, create dialog
  (old create-tier-dialog, environments-tab, grant-dialog, holders-tab, publisher-dashboard,
   status.tsx, tier-detail, tiers-tab and their tests)  DELETE in Task 1
modules/apps/components/app-detail.tsx   MODIFY tabs + owner gating + banner
modules/apps/components/banner.tsx       NEW (extracted from app-detail)
modules/subscriptions/                   NEW owner side: types, graphql, hooks, lib, components
modules/studio-license/                  NEW gate, no-licence panel, pre-alpha dialog
modules/cloud/studio/pool-client.ts      NEW (VetraStudioPool calls moved out of modules/invites)
modules/shared/components/renown/require-login.tsx NEW
modules/shared/test/native-select.tsx    NEW test stand-in for Radix Select
modules/invites/                         DELETE in Task 12
app/user/publisher/page.tsx              REWRITE redirect
app/user/subscriptions/page.tsx          NEW
app/redeem/page.tsx, app/redeem/[code]/page.tsx NEW
app/user/{page,studio/page,apps/new/page,apps/[id]/page,environments/page,environments/new/page}.tsx MODIFY gate
app/user/environments/cloud-projects.tsx, app/user/environments/[project]/page.tsx MODIFY licence info
modules/shared/components/navbar/navbar-config.tsx, components/navbar-right-side.tsx MODIFY nav
playwright.config.ts MODIFY, playwright.licensing.config.ts NEW, tests/licensing/** NEW
package.json MODIFY (script test:e2e:licensing)
```

---

### Task 1: Publisher API client on the `vetraPublisher` contract

Replaces the licence-type client with the template/term/invite-code/allow-list contract, retires the old Licensing dashboard (its API no longer exists), turns `/user/publisher` into a redirect and removes the Licensing nav entries.

**Files:**
- Rewrite: `modules/publisher/types.ts`
- Modify: `modules/publisher/graphql.ts` (error codes; replace everything below the `retryPublisher` function)
- Delete: `modules/publisher/components/{create-tier-dialog,environments-tab,grant-dialog,holders-tab,publisher-dashboard,status,tier-detail,tiers-tab}.tsx`, `modules/publisher/lib/status.ts`, `modules/publisher/hooks/use-publisher.ts`, `modules/publisher/hooks/use-publisher-mutations.ts`, `modules/publisher/hooks/keys.ts`, `modules/publisher/__tests__/{disabled-deployment,environments-tab,holders-tab,publisher-dashboard,tiers-tab,use-publisher,use-publisher-mutations}.test.tsx`
- Rewrite: `modules/publisher/__tests__/queries.test.ts`, `modules/publisher/__tests__/mutations.test.ts`
- Modify: `modules/publisher/__tests__/graphql.test.ts` (code lists)
- Rewrite: `app/user/publisher/page.tsx`
- Create: `app/user/publisher/__tests__/page.test.ts`
- Modify: `modules/shared/components/navbar/navbar-config.tsx`, `modules/shared/components/navbar/components/navbar-right-side.tsx`
- Create: `modules/shared/components/navbar/__tests__/navbar-config.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (all exported from `modules/publisher/graphql.ts`; every function takes `token: string | null` then optional `fetchImpl?: FetchLike` last):
  - Types re-used everywhere: `FetchLike`, `PublisherErrorCode`, `PublisherApiError`, `isPublisherError(err, code?)`, `toPublisherError`, `publisherGql<T>(query, variables, token, fetchImpl?)`, `describePublisherError(err): string`, `retryPublisher(count, err): boolean`.
  - Reads: `fetchPublisherApps(token)`, `fetchTemplates(appId, token)`, `fetchTerms(appId, token)`, `fetchAppArtifacts(appId, token)`, `fetchLicenses(appId, status: string | null, token)`, `fetchEnvironments(appId, token)`, `fetchInviteCodes(appId, token)`, `fetchAllowList(appId, token)` — each resolves to the matching array type from `types.ts`.
  - Input writes `(input, token)`: `addTemplate → string`, `setTemplateDetails → boolean`, `addTemplateService → boolean`, `removeTemplateService → boolean`, `addTemplatePackage → boolean`, `removeTemplatePackage → boolean`, `addTerm → string`, `setTermDetails → boolean`, `issueGrant → string`, `replaceGrant → string`, `revokeLicense → boolean`, `createInviteCode → PublisherInviteCode`.
  - Argument writes `(args, token) → boolean`: `deleteTemplate({appId, templateId})`, `publishTerm({appId, termId})`, `retireTerm({appId, termId})`, `setInviteCodeActive({appId, code, active})`, `addToAllowList({appId, user})`, `removeFromAllowList({appId, user})`.
  - Types from `modules/publisher/types.ts` exactly as written in Step 3.

- [ ] **Step 0: Prepare the worktree (once)**

```bash
cd /home/f/projects/vetra.io-licensing
pnpm install
cp /home/f/projects/vetra.io/.env.local .env.local   # gitignored; build needs HOMEPAGE_REMOTE_URL + NEXT_PUBLIC_SWITCHBOARD_URL
git check-ignore .env.local                          # must print .env.local
pnpm test:unit                                       # baseline: all green before touching anything
```

- [ ] **Step 1: Write the failing query tests**

Replace `modules/publisher/__tests__/queries.test.ts` entirely:

```ts
import { describe, it, expect } from 'vitest'
import * as api from '../graphql'
import type { FetchLike } from '../graphql'

const capture = (data: unknown) => {
  const calls: Array<{ query: string; variables: unknown }> = []
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(init.body as string))
    return new Response(JSON.stringify({ data }), { status: 200 })
  }) as unknown as FetchLike
  return { calls, fetchImpl }
}

// Body of the `{ ... }` that follows `field`, brace-balanced, so a variable
// declaration like `$status: String` can never satisfy a selection check.
const selectionOf = (query: string, field: string): string => {
  const m = new RegExp(`\\b${field}\\s*(\\([^)]*\\))?\\s*\\{`).exec(query)
  if (!m) throw new Error(`no selection for ${field} in: ${query}`)
  let depth = 1
  let i = m.index + m[0].length
  const start = i
  for (; i < query.length && depth > 0; i++) {
    if (query[i] === '{') depth++
    else if (query[i] === '}') depth--
  }
  return query.slice(start, i - 1)
}
const topLevelFields = (selection: string): string[] => {
  let flat = selection
  let prev: string
  do {
    prev = flat
    flat = flat.replace(/\{[^{}]*\}/g, '')
  } while (flat !== prev)
  return flat.split(/\s+/).filter(Boolean)
}
const fieldsOf = (query: string, field: string) => topLevelFields(selectionOf(query, field))

type Read = {
  name: string
  field: string
  call: (f: FetchLike) => Promise<unknown>
  variables: Record<string, unknown>
  fields: string[]
}

const READS: Read[] = [
  {
    name: 'fetchPublisherApps',
    field: 'myApps',
    call: (f) => api.fetchPublisherApps('t', f),
    variables: {},
    fields: ['id', 'name', 'status'],
  },
  {
    name: 'fetchTemplates',
    field: 'templates',
    call: (f) => api.fetchTemplates('app-1', 't', f),
    variables: { appId: 'app-1' },
    fields: [
      'id', 'name', 'mode', 'sharedEnvironment', 'size', 'baseDomain', 'packageRegistry',
      'templateHash', 'environmentCount', 'services', 'packages',
    ],
  },
  {
    name: 'fetchTerms',
    field: 'terms',
    call: (f) => api.fetchTerms('app-1', 't', f),
    variables: { appId: 'app-1' },
    fields: ['id', 'kind', 'label', 'templateId', 'validityDays', 'issuers', 'status', 'activeLicenses'],
  },
  {
    name: 'fetchAppArtifacts',
    field: 'appArtifacts',
    call: (f) => api.fetchAppArtifacts('app-1', 't', f),
    variables: { appId: 'app-1' },
    fields: ['kind', 'name', 'versions', 'channels'],
  },
  {
    name: 'fetchLicenses',
    field: 'licenses',
    call: (f) => api.fetchLicenses('app-1', null, 't', f),
    variables: { appId: 'app-1', status: null },
    fields: ['id', 'user', 'kind', 'issuer', 'status', 'start', 'end', 'environmentId', 'replacedBy'],
  },
  {
    name: 'fetchEnvironments',
    field: 'environments',
    call: (f) => api.fetchEnvironments('app-1', 't', f),
    variables: { appId: 'app-1' },
    fields: [
      'environmentId', 'user', 'licenseId', 'rootLicenseId', 'label', 'templateHash',
      'stoppedAt', 'deleteAfter',
    ],
  },
  {
    name: 'fetchInviteCodes',
    field: 'inviteCodes',
    call: (f) => api.fetchInviteCodes('app-1', 't', f),
    variables: { appId: 'app-1' },
    fields: [
      'code', 'kind', 'label', 'active', 'expiresAt', 'maxUses', 'redemptions',
      'hasAnthropicKey', 'createdAt',
    ],
  },
  {
    name: 'fetchAllowList',
    field: 'allowList',
    call: (f) => api.fetchAllowList('app-1', 't', f),
    variables: { appId: 'app-1' },
    fields: ['user', 'addedAt'],
  },
]

describe.each(READS)('$name', ({ field, call, variables, fields }) => {
  it('unwraps vetraPublisher.<field>, sends the variables, selects exactly the contract fields', async () => {
    const { calls, fetchImpl } = capture({ vetraPublisher: { [field]: [] } })
    await expect(call(fetchImpl)).resolves.toEqual([])
    expect(calls).toHaveLength(1)
    expect(calls[0].query).toMatch(/^query\b/)
    expect(calls[0].query).toMatch(/vetraPublisher\s*\{/)
    expect(calls[0].variables).toEqual(variables)
    expect(fieldsOf(calls[0].query, field)).toEqual(fields)
  })
})

describe('nested selections', () => {
  it('templates select every service and package field', async () => {
    const { calls, fetchImpl } = capture({ vetraPublisher: { templates: [] } })
    await api.fetchTemplates('app-1', 't', fetchImpl)
    expect(fieldsOf(calls[0].query, 'services')).toEqual([
      'id', 'type', 'prefix', 'artifactName', 'artifactChannel',
    ])
    expect(fieldsOf(calls[0].query, 'packages')).toEqual(['id', 'packageName', 'version'])
  })

  it('myApps takes no argument: ownership comes from the wallet', async () => {
    const { calls, fetchImpl } = capture({ vetraPublisher: { myApps: [] } })
    await api.fetchPublisherApps('t', fetchImpl)
    expect(calls[0].query).not.toContain('appId')
  })

  it('licences pass a status filter through untouched', async () => {
    const { calls, fetchImpl } = capture({ vetraPublisher: { licenses: [] } })
    await api.fetchLicenses('app-1', 'ACTIVE', 't', fetchImpl)
    expect(calls[0].variables).toEqual({ appId: 'app-1', status: 'ACTIVE' })
    expect(calls[0].query).toContain('licenses(appId: $appId, status: $status)')
  })
})
```

- [ ] **Step 2: Write the failing mutation tests**

Replace `modules/publisher/__tests__/mutations.test.ts` entirely:

```ts
import { describe, it, expect } from 'vitest'
import * as api from '../graphql'
import type { FetchLike } from '../graphql'

const capture = (data: unknown) => {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = []
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(init.body as string))
    return new Response(JSON.stringify({ data }), { status: 200 })
  }) as unknown as FetchLike
  return { calls, fetchImpl }
}

type Writer = (input: never, token: string | null, f?: FetchLike) => Promise<unknown>

const INPUT_WRITES: Array<[keyof typeof api, string, Record<string, unknown>, unknown]> = [
  ['addTemplate', 'AddTemplateInput', { appId: 'a', name: 'Free', mode: 'SHARED' }, 'tpl-1'],
  ['setTemplateDetails', 'SetTemplateDetailsInput', { appId: 'a', templateId: 't', size: null }, true],
  ['addTemplateService', 'AddTemplateServiceInput', { appId: 'a', templateId: 't', type: 'FUSION', artifactName: 'kv', artifactChannel: 'LATEST' }, true],
  ['removeTemplateService', 'RemoveTemplateEntryInput', { appId: 'a', templateId: 't', id: 's1' }, true],
  ['addTemplatePackage', 'AddTemplatePackageInput', { appId: 'a', templateId: 't', packageName: '@acme/kv' }, true],
  ['removeTemplatePackage', 'RemoveTemplateEntryInput', { appId: 'a', templateId: 't', id: 'p1' }, true],
  ['addTerm', 'AddTermInput', { appId: 'a', kind: '2026-free', issuers: ['INVITE_CODE'] }, 'term-1'],
  ['setTermDetails', 'SetTermDetailsInput', { appId: 'a', termId: 'term-1', validityDays: null }, true],
  ['issueGrant', 'IssueGrantInput', { appId: 'a', kind: '2026-free', user: '0xabc', label: null }, 'lic-1'],
  ['replaceGrant', 'ReplaceGrantInput', { licenseId: 'lic-1', kind: '2026-pro' }, 'lic-2'],
  ['revokeLicense', 'RevokeLicenseInput', { licenseId: 'lic-1', reason: null }, true],
]

describe.each(INPUT_WRITES)('%s', (field, inputType, input, result) => {
  it(`sends $input typed ${inputType}! and returns the field value`, async () => {
    const { calls, fetchImpl } = capture({ vetraPublisher: { [field]: result } })
    const fn = api[field] as unknown as Writer
    await expect(fn(input as never, 't', fetchImpl)).resolves.toEqual(result)
    expect(calls[0].query).toMatch(/^mutation\b/)
    expect(calls[0].query).toContain(`($input: ${inputType}!)`)
    expect(calls[0].query).toMatch(new RegExp(`vetraPublisher\\s*\\{\\s*${field}\\(input: \\$input\\)`))
    // Passed through untouched: null stays null, absent stays absent.
    expect(calls[0].variables).toEqual({ input })
  })
})

describe('createInviteCode', () => {
  it('selects the created code back, never the key', async () => {
    const code = {
      code: 'LFC-2026', kind: 'conf', label: null, active: true, expiresAt: null, maxUses: 50,
      redemptions: 0, hasAnthropicKey: true, createdAt: '2026-10-08T00:00:00Z',
    }
    const { calls, fetchImpl } = capture({ vetraPublisher: { createInviteCode: code } })
    const input = { appId: 'a', kind: 'conf', anthropicKey: 'sk-secret', maxUses: 50 }
    await expect(api.createInviteCode(input, 't', fetchImpl)).resolves.toEqual(code)
    expect(calls[0].query).toContain('($input: CreateInviteCodeInput!)')
    expect(calls[0].query).toContain('createInviteCode(input: $input) {')
    expect(calls[0].query).not.toContain('anthropicKey')
    expect(calls[0].variables).toEqual({ input })
  })
})

const ARG_WRITES: Array<[keyof typeof api, Record<string, unknown>, string, string]> = [
  ['deleteTemplate', { appId: 'a', templateId: 't' }, '($appId: String!, $templateId: String!)', 'deleteTemplate(appId: $appId, templateId: $templateId)'],
  ['publishTerm', { appId: 'a', termId: 'x' }, '($appId: String!, $termId: String!)', 'publishTerm(appId: $appId, termId: $termId)'],
  ['retireTerm', { appId: 'a', termId: 'x' }, '($appId: String!, $termId: String!)', 'retireTerm(appId: $appId, termId: $termId)'],
  ['setInviteCodeActive', { appId: 'a', code: 'C', active: false }, '($appId: String!, $code: String!, $active: Boolean!)', 'setInviteCodeActive(appId: $appId, code: $code, active: $active)'],
  ['addToAllowList', { appId: 'a', user: '0xabc' }, '($appId: String!, $user: String!)', 'addToAllowList(appId: $appId, user: $user)'],
  ['removeFromAllowList', { appId: 'a', user: '0xabc' }, '($appId: String!, $user: String!)', 'removeFromAllowList(appId: $appId, user: $user)'],
]

describe.each(ARG_WRITES)('%s', (field, args, decl, call) => {
  it('passes bare arguments, not an input object', async () => {
    const { calls, fetchImpl } = capture({ vetraPublisher: { [field]: true } })
    const fn = api[field] as unknown as Writer
    await expect(fn(args as never, 't', fetchImpl)).resolves.toBe(true)
    expect(calls[0].query).toContain(`mutation ${decl}`)
    expect(calls[0].query).toContain(call)
    expect(calls[0].variables).toEqual(args)
  })
})
```

- [ ] **Step 3: Update the error-code tests**

In `modules/publisher/__tests__/graphql.test.ts`, replace both code arrays (in `passes every code the server can send through unchanged` and `returns the SERVER message verbatim…`) with this list (the second array additionally keeps `'UNKNOWN'` at the end):

```ts
const SERVER_CODES = [
  'UNAUTHENTICATED',
  'NOT_FOUND',
  'FORBIDDEN',
  'INVALID_INPUT',
  'APP_NOT_ACTIVE',
  'NOT_ON_ALLOW_LIST',
  'TERM_NOT_ISSUABLE',
  'UNSUPPORTED_DID',
  'LICENSING_DISABLED',
  'INVALID_CODE',
  'ALREADY_HOLDS',
] as const
```

Define `SERVER_CODES` once at the top of the file and use `for (const code of SERVER_CODES)` and `for (const code of [...SERVER_CODES, 'UNKNOWN'] as const)`. Add one test to the `toPublisherError` block:

```ts
it('maps the retired licence-type codes to UNKNOWN', () => {
  for (const code of ['UNKNOWN_APP', 'APP_IDENTITY_INACTIVE', 'UNKNOWN_LICENSE_TYPE', 'UNKNOWN_LICENSE']) {
    expect(toPublisherError({ message: 'x', extensions: { code } }, 200).code).toBe('UNKNOWN')
  }
})
```

- [ ] **Step 4: Run the tests to see them fail**

Run: `pnpm vitest run --config vitest.unit.config.ts modules/publisher/__tests__`
Expected: FAIL — `api.fetchPublisherApps is not a function`, `addTemplate` missing, code-list assertions failing.

- [ ] **Step 5: Rewrite `modules/publisher/types.ts`**

```ts
/**
 * Types for vetraPublisher (vetra-licensing subgraph). Field names and
 * nullability mirror docs/superpowers/specs/2026-10-08-licensing-api-contract.md
 * in vetra-cloud-package exactly. Enum-valued fields arrive as strings.
 */

export type PublisherApp = { id: string; name: string; status: string }

export type TemplateMode = 'SHARED' | 'DEDICATED'
export type TermStatus = 'DRAFT' | 'ACTIVE' | 'RETIRED'
export type IssuerKind = 'INVITE_CODE' | 'PUBLISHER_GRANT' | 'ACHRA_SUBSCRIPTION'
export type LicenseStatus = 'ISSUED' | 'ACTIVE' | 'EXPIRED' | 'REVOKED' | 'REPLACED'

export type PublisherTemplateService = {
  id: string
  type: string
  prefix: string | null
  /** The app artifact a FUSION service runs; null for every other type. */
  artifactName: string | null
  /** DEV | STAGING | LATEST — which published version the service follows. */
  artifactChannel: string | null
}

export type PublisherTemplatePackage = {
  id: string
  packageName: string | null
  version: string | null
}

export type PublisherTemplate = {
  id: string
  name: string | null
  mode: TemplateMode
  /** SHARED only; null means the App Environment. */
  sharedEnvironment: string | null
  size: string | null
  baseDomain: string | null
  packageRegistry: string | null
  services: PublisherTemplateService[]
  packages: PublisherTemplatePackage[]
  templateHash: string
  /** Environments currently provisioned from this template (DEDICATED). */
  environmentCount: number
}

export type PublisherTerm = {
  id: string
  kind: string
  label: string | null
  templateId: string | null
  validityDays: number | null
  issuers: IssuerKind[]
  status: TermStatus
  activeLicenses: number
}

export type PublisherLicense = {
  id: string
  /** DID of the holder. */
  user: string
  kind: string
  issuer: string
  status: LicenseStatus
  start: string | null
  end: string | null
  environmentId: string | null
  replacedBy: string | null
}

export type PublisherEnvironment = {
  environmentId: string
  user: string
  licenseId: string
  rootLicenseId: string
  label: string | null
  templateHash: string
  stoppedAt: string | null
  deleteAfter: string | null
}

export type PublisherInviteCode = {
  code: string
  kind: string
  label: string | null
  active: boolean
  expiresAt: string | null
  maxUses: number | null
  redemptions: number
  hasAnthropicKey: boolean
  createdAt: string
}

export type PublisherAllowListEntry = { user: string; addedAt: string }

/** One artifact the app has published, as the template builder offers it. */
export type PublisherAppArtifact = {
  kind: 'PACKAGE' | 'FUSION_IMAGE'
  name: string
  /** Oldest first, as the document stores them. */
  versions: { version: string; reference: string }[]
  channels: { channel: string; version: string }[]
}

// Mutation inputs — mirror the server input types exactly. Omit a key to leave
// it out of the JSON; null is sent as null. Never default or strip keys.
export type AddTemplateInput = { appId: string; name?: string | null; mode: TemplateMode }
export type SetTemplateDetailsInput = {
  appId: string
  templateId: string
  name?: string | null
  mode?: TemplateMode | null
  sharedEnvironment?: string | null
  size?: string | null
  baseDomain?: string | null
  packageRegistry?: string | null
}
export type AddTemplateServiceInput = {
  appId: string
  templateId: string
  type: string
  prefix?: string | null
  artifactName?: string | null
  artifactChannel?: string | null
}
export type AddTemplatePackageInput = {
  appId: string
  templateId: string
  packageName: string
  version?: string | null
}
export type RemoveTemplateEntryInput = { appId: string; templateId: string; id: string }
export type AddTermInput = {
  appId: string
  kind: string
  label?: string | null
  templateId?: string | null
  validityDays?: number | null
  issuers?: IssuerKind[] | null
}
export type SetTermDetailsInput = {
  appId: string
  termId: string
  kind?: string | null
  label?: string | null
  templateId?: string | null
  validityDays?: number | null
  issuers?: IssuerKind[] | null
}
export type IssueGrantInput = { appId: string; kind: string; user: string; label?: string | null }
export type ReplaceGrantInput = { licenseId: string; kind: string }
export type RevokeLicenseInput = { licenseId: string; reason?: string | null }
export type CreateInviteCodeInput = {
  appId: string
  kind: string
  label?: string | null
  /** Omit to let the server generate a random code. */
  code?: string | null
  expiresAt?: string | null
  maxUses?: number | null
  /** Write-only; stored encrypted, never returned. */
  anthropicKey?: string | null
}
```

- [ ] **Step 6: Update error codes in `modules/publisher/graphql.ts`**

Replace the import block, `PublisherErrorCode` and `KNOWN_CODES` with:

```ts
import { getCloudEndpoint } from '@/modules/cloud/graphql'
import type {
  AddTemplateInput,
  AddTemplatePackageInput,
  AddTemplateServiceInput,
  AddTermInput,
  CreateInviteCodeInput,
  IssueGrantInput,
  PublisherAllowListEntry,
  PublisherApp,
  PublisherAppArtifact,
  PublisherEnvironment,
  PublisherInviteCode,
  PublisherLicense,
  PublisherTemplate,
  PublisherTerm,
  RemoveTemplateEntryInput,
  ReplaceGrantInput,
  RevokeLicenseInput,
  SetTemplateDetailsInput,
  SetTermDetailsInput,
} from './types'

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export type PublisherErrorCode =
  | 'UNAUTHENTICATED'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'INVALID_INPUT'
  | 'APP_NOT_ACTIVE'
  | 'NOT_ON_ALLOW_LIST'
  | 'TERM_NOT_ISSUABLE'
  | 'UNSUPPORTED_DID'
  | 'LICENSING_DISABLED'
  | 'INVALID_CODE'
  | 'ALREADY_HOLDS'
  | 'PUBLISHER_UNAVAILABLE'
  | 'NETWORK'
  | 'UNKNOWN'

// Codes the vetra-licensing subgraph (vetraPublisher + vetraSubscriptions) sends in
// extensions.code. PUBLISHER_UNAVAILABLE, NETWORK and UNKNOWN are produced locally.
const KNOWN_CODES = new Set<string>([
  'UNAUTHENTICATED',
  'NOT_FOUND',
  'FORBIDDEN',
  'INVALID_INPUT',
  'APP_NOT_ACTIVE',
  'NOT_ON_ALLOW_LIST',
  'TERM_NOT_ISSUABLE',
  'UNSUPPORTED_DID',
  'LICENSING_DISABLED',
  'INVALID_CODE',
  'ALREADY_HOLDS',
])
```

Keep `GqlError`, `GqlBody`, `PublisherApiError`, `isPublisherError`, `toPublisherError`, `publisherGql`, `describePublisherError`, `retryPublisher` unchanged. In the `describePublisherError` doc comment delete the paragraph about `UNKNOWN_APP`.

- [ ] **Step 7: Replace the reads and writes in `modules/publisher/graphql.ts`**

Delete everything after `retryPublisher` and append:

```ts
// ---------------------------------------------------------------------------
// Reads. Every per-app field takes an appId the SERVER authorises against the
// app's owner; fetchers pass it through and never filter. myApps takes no
// argument: the server derives it from the caller's wallet.
// ---------------------------------------------------------------------------

const APP_FIELDS = `id name status`
const TEMPLATE_FIELDS = `id name mode sharedEnvironment size baseDomain packageRegistry
  templateHash environmentCount
  services { id type prefix artifactName artifactChannel }
  packages { id packageName version }`
const TERM_FIELDS = `id kind label templateId validityDays issuers status activeLicenses`
const ARTIFACT_FIELDS = `kind name versions { version reference } channels { channel version }`
const LICENSE_FIELDS = `id user kind issuer status start end environmentId replacedBy`
const ENVIRONMENT_FIELDS = `environmentId user licenseId rootLicenseId label templateHash stoppedAt deleteAfter`
export const INVITE_CODE_FIELDS = `code kind label active expiresAt maxUses redemptions hasAnthropicKey createdAt`
const ALLOW_LIST_FIELDS = `user addedAt`

async function read<T>(
  field: string,
  declaration: string,
  call: string,
  variables: Record<string, unknown>,
  token: string | null,
  fetchImpl?: FetchLike,
): Promise<T> {
  const data = await publisherGql<{ vetraPublisher: Record<string, T> }>(
    `query ${declaration} { vetraPublisher { ${call} } }`.replace('query  {', 'query {'),
    variables,
    token,
    fetchImpl,
  )
  return data.vetraPublisher[field]
}

const APP_ID = '($appId: String!)'

export const fetchPublisherApps = (token: string | null, fetchImpl?: FetchLike) =>
  read<PublisherApp[]>('myApps', '', `myApps { ${APP_FIELDS} }`, {}, token, fetchImpl)

export const fetchTemplates = (appId: string, token: string | null, fetchImpl?: FetchLike) =>
  read<PublisherTemplate[]>(
    'templates',
    APP_ID,
    `templates(appId: $appId) { ${TEMPLATE_FIELDS} }`,
    { appId },
    token,
    fetchImpl,
  )

export const fetchTerms = (appId: string, token: string | null, fetchImpl?: FetchLike) =>
  read<PublisherTerm[]>('terms', APP_ID, `terms(appId: $appId) { ${TERM_FIELDS} }`, { appId }, token, fetchImpl)

/** Published artifacts. An app that has published nothing returns []. */
export const fetchAppArtifacts = (appId: string, token: string | null, fetchImpl?: FetchLike) =>
  read<PublisherAppArtifact[]>(
    'appArtifacts',
    APP_ID,
    `appArtifacts(appId: $appId) { ${ARTIFACT_FIELDS} }`,
    { appId },
    token,
    fetchImpl,
  )

export const fetchLicenses = (
  appId: string,
  status: string | null,
  token: string | null,
  fetchImpl?: FetchLike,
) =>
  read<PublisherLicense[]>(
    'licenses',
    '($appId: String!, $status: String)',
    `licenses(appId: $appId, status: $status) { ${LICENSE_FIELDS} }`,
    { appId, status },
    token,
    fetchImpl,
  )

export const fetchEnvironments = (appId: string, token: string | null, fetchImpl?: FetchLike) =>
  read<PublisherEnvironment[]>(
    'environments',
    APP_ID,
    `environments(appId: $appId) { ${ENVIRONMENT_FIELDS} }`,
    { appId },
    token,
    fetchImpl,
  )

export const fetchInviteCodes = (appId: string, token: string | null, fetchImpl?: FetchLike) =>
  read<PublisherInviteCode[]>(
    'inviteCodes',
    APP_ID,
    `inviteCodes(appId: $appId) { ${INVITE_CODE_FIELDS} }`,
    { appId },
    token,
    fetchImpl,
  )

export const fetchAllowList = (appId: string, token: string | null, fetchImpl?: FetchLike) =>
  read<PublisherAllowListEntry[]>(
    'allowList',
    APP_ID,
    `allowList(appId: $appId) { ${ALLOW_LIST_FIELDS} }`,
    { appId },
    token,
    fetchImpl,
  )

// ---------------------------------------------------------------------------
// Writes. Inputs and arguments go through untouched: a key the caller omits stays
// absent from the JSON and null stays null. No retry or swallowing here.
// ---------------------------------------------------------------------------

async function mutate<T>(
  field: string,
  declaration: string,
  call: string,
  variables: Record<string, unknown>,
  token: string | null,
  fetchImpl?: FetchLike,
): Promise<T> {
  const data = await publisherGql<{ vetraPublisher: Record<string, T> }>(
    `mutation ${declaration} { vetraPublisher { ${call} } }`,
    variables,
    token,
    fetchImpl,
  )
  return data.vetraPublisher[field]
}

/** A mutation that takes one `input` object. `selection` is for object results. */
function inputWrite<I extends object, R>(field: string, inputType: string, selection?: string) {
  return (input: I, token: string | null, fetchImpl?: FetchLike) =>
    mutate<R>(
      field,
      `($input: ${inputType}!)`,
      selection ? `${field}(input: $input) { ${selection} }` : `${field}(input: $input)`,
      { input },
      token,
      fetchImpl,
    )
}

/** A mutation that takes bare scalar arguments and returns Boolean!. */
function argsWrite<A extends Record<string, string | boolean>>(
  field: string,
  types: { [K in keyof A & string]: string },
) {
  const names = Object.keys(types) as Array<keyof A & string>
  const declaration = `(${names.map((n) => `$${n}: ${types[n]}`).join(', ')})`
  const call = `${field}(${names.map((n) => `${n}: $${n}`).join(', ')})`
  return (args: A, token: string | null, fetchImpl?: FetchLike) =>
    mutate<boolean>(field, declaration, call, args, token, fetchImpl)
}

export const addTemplate = inputWrite<AddTemplateInput, string>('addTemplate', 'AddTemplateInput')
export const setTemplateDetails = inputWrite<SetTemplateDetailsInput, boolean>(
  'setTemplateDetails',
  'SetTemplateDetailsInput',
)
export const addTemplateService = inputWrite<AddTemplateServiceInput, boolean>(
  'addTemplateService',
  'AddTemplateServiceInput',
)
export const removeTemplateService = inputWrite<RemoveTemplateEntryInput, boolean>(
  'removeTemplateService',
  'RemoveTemplateEntryInput',
)
export const addTemplatePackage = inputWrite<AddTemplatePackageInput, boolean>(
  'addTemplatePackage',
  'AddTemplatePackageInput',
)
export const removeTemplatePackage = inputWrite<RemoveTemplateEntryInput, boolean>(
  'removeTemplatePackage',
  'RemoveTemplateEntryInput',
)
export const addTerm = inputWrite<AddTermInput, string>('addTerm', 'AddTermInput')
export const setTermDetails = inputWrite<SetTermDetailsInput, boolean>(
  'setTermDetails',
  'SetTermDetailsInput',
)
export const issueGrant = inputWrite<IssueGrantInput, string>('issueGrant', 'IssueGrantInput')
export const replaceGrant = inputWrite<ReplaceGrantInput, string>('replaceGrant', 'ReplaceGrantInput')
export const revokeLicense = inputWrite<RevokeLicenseInput, boolean>(
  'revokeLicense',
  'RevokeLicenseInput',
)
export const createInviteCode = inputWrite<CreateInviteCodeInput, PublisherInviteCode>(
  'createInviteCode',
  'CreateInviteCodeInput',
  INVITE_CODE_FIELDS,
)

export const deleteTemplate = argsWrite<{ appId: string; templateId: string }>('deleteTemplate', {
  appId: 'String!',
  templateId: 'String!',
})
export const publishTerm = argsWrite<{ appId: string; termId: string }>('publishTerm', {
  appId: 'String!',
  termId: 'String!',
})
export const retireTerm = argsWrite<{ appId: string; termId: string }>('retireTerm', {
  appId: 'String!',
  termId: 'String!',
})
export const setInviteCodeActive = argsWrite<{ appId: string; code: string; active: boolean }>(
  'setInviteCodeActive',
  { appId: 'String!', code: 'String!', active: 'Boolean!' },
)
export const addToAllowList = argsWrite<{ appId: string; user: string }>('addToAllowList', {
  appId: 'String!',
  user: 'String!',
})
export const removeFromAllowList = argsWrite<{ appId: string; user: string }>(
  'removeFromAllowList',
  { appId: 'String!', user: 'String!' },
)
```

- [ ] **Step 8: Delete the retired dashboard**

```bash
cd /home/f/projects/vetra.io-licensing
git rm modules/publisher/components/{create-tier-dialog,environments-tab,grant-dialog,holders-tab,publisher-dashboard,status,tier-detail,tiers-tab}.tsx \
  modules/publisher/lib/status.ts \
  modules/publisher/hooks/{use-publisher,use-publisher-mutations,keys}.ts \
  modules/publisher/__tests__/{disabled-deployment,environments-tab,holders-tab,publisher-dashboard,tiers-tab,use-publisher,use-publisher-mutations}.test.tsx
```

- [ ] **Step 9: Write the failing redirect + nav tests**

`app/user/publisher/__tests__/page.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const redirect = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT ${url}`)
})
vi.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url) }))

import PublisherRedirect from '../page'

describe('/user/publisher', () => {
  beforeEach(() => redirect.mockClear())

  it('sends a bare visit to the apps home', async () => {
    await expect(PublisherRedirect({ searchParams: Promise.resolve({}) })).rejects.toThrow()
    expect(redirect).toHaveBeenCalledWith('/user')
  })

  it('sends ?app=<id> to that app’s Plans tab', async () => {
    await expect(
      PublisherRedirect({ searchParams: Promise.resolve({ app: 'app 1' }) }),
    ).rejects.toThrow()
    expect(redirect).toHaveBeenCalledWith('/user/apps/app%201?tab=plans')
  })

  it('uses the first value when app is repeated', async () => {
    await expect(
      PublisherRedirect({ searchParams: Promise.resolve({ app: ['a1', 'a2'] }) }),
    ).rejects.toThrow()
    expect(redirect).toHaveBeenCalledWith('/user/apps/a1?tab=plans')
  })
})
```

`modules/shared/components/navbar/__tests__/navbar-config.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { NAVBAR_CONFIGS, PRIVATE_NAV_ITEMS } from '../navbar-config'

describe('navigation', () => {
  it('no longer links the retired Licensing page anywhere', () => {
    for (const list of [PRIVATE_NAV_ITEMS, NAVBAR_CONFIGS['/vetra'].navItems]) {
      expect(list.find((i) => i.label === 'Licensing')).toBeUndefined()
      expect(list.find((i) => i.href === '/user/publisher')).toBeUndefined()
    }
  })
})
```

- [ ] **Step 10: Implement the redirect and nav changes**

`app/user/publisher/page.tsx`:

```tsx
import { redirect } from 'next/navigation'

type Props = { searchParams: Promise<{ app?: string | string[] }> }

/**
 * The old Licensing dashboard. Licensing now lives on each app's page, so an
 * old bookmark with ?app=<id> lands on that app's Plans tab and anything else
 * on the apps home.
 */
export default async function PublisherRedirect({ searchParams }: Props) {
  const { app } = await searchParams
  const id = Array.isArray(app) ? app[0] : app
  redirect(id ? `/user/apps/${encodeURIComponent(id)}?tab=plans` : '/user')
}
```

In `modules/shared/components/navbar/navbar-config.tsx` delete the `Licensing` object from `PRIVATE_NAV_ITEMS` and from `NAVBAR_CONFIGS['/vetra'].navItems`. In `modules/shared/components/navbar/components/navbar-right-side.tsx` delete the `<DropdownMenuItem>` that links `/user/publisher` (and the `FileKey` import if it becomes unused).

- [ ] **Step 11: Run tests and typecheck**

Run: `pnpm vitest run --config vitest.unit.config.ts modules/publisher app/user/publisher modules/shared/components/navbar && pnpm tsc`
Expected: PASS; `tsc` reports no errors (nothing imports the deleted files any more — if it does, the import is in a deleted file's sibling you missed; delete or fix it).

- [ ] **Step 12: Commit**

```bash
git add -A modules/publisher app/user/publisher modules/shared/components/navbar
git commit -m "refactor(publisher): move the client to the vetraPublisher licensing contract

Templates, terms, invite codes and the allow list replace licence types. The
standalone Licensing dashboard is retired; /user/publisher now redirects to the
app page."
```

---

### Task 2: Publisher query and mutation hooks

**Files:**
- Create: `modules/publisher/hooks/keys.ts`, `modules/publisher/hooks/use-publisher.ts`, `modules/publisher/hooks/use-publisher-mutations.ts`
- Test: `modules/publisher/__tests__/use-publisher.test.tsx`, `modules/publisher/__tests__/use-publisher-mutations.test.tsx`

**Interfaces:**
- Consumes: Task 1 fetchers and writers from `modules/publisher/graphql.ts`; `useViewerDid()` from `modules/publisher/hooks/use-viewer-did.ts`; `useAuthedQuery` from `@/modules/cloud/query/use-authed-query`.
- Produces:
  - `publisherKeys.apps(did)`, `publisherKeys.resource(r, appId, did)`, `publisherKeys.of(r, appId)`; `type PublisherResource = 'templates' | 'terms' | 'artifacts' | 'licenses' | 'environments' | 'inviteCodes' | 'allowList'`.
  - `usePublisherToken(): () => Promise<string | null>`
  - `usePublisherApps(): UseQueryResult<PublisherApp[]>`
  - `useAppPublisher(appId: string): { isPublisher: boolean; app: PublisherApp | undefined; isPending: boolean }`
  - `usePublisherTemplates(appId: string | null)`, `usePublisherTerms(appId)`, `usePublisherAppArtifacts(appId)`, `usePublisherLicenses(appId)` (all statuses), `usePublisherEnvironments(appId)`, `usePublisherInviteCodes(appId)`, `usePublisherAllowList(appId)` — each `UseQueryResult<T[]>`.
  - Mutation hooks, all `(appId: string) => UseMutationResult<R, Error, V>`; `V` omits `appId` where the input has one:
    `useAddTemplate` (`{name?, mode}` → string), `useSetTemplateDetails` (`Omit<SetTemplateDetailsInput,'appId'>` → boolean), `useAddTemplateService`, `useRemoveTemplateService`, `useAddTemplatePackage`, `useRemoveTemplatePackage`, `useDeleteTemplate` (`{templateId}`), `useAddTerm` (→ string), `useSetTermDetails`, `usePublishTerm` (`{termId}`), `useRetireTerm` (`{termId}`), `useIssueGrant` (→ string), `useReplaceGrant` (`ReplaceGrantInput` → string), `useRevokeLicense` (`RevokeLicenseInput`), `useCreateInviteCode` (→ `PublisherInviteCode`), `useSetInviteCodeActive` (`{code, active}`), `useAddToAllowList` (`{user}`), `useRemoveFromAllowList` (`{user}`).

- [ ] **Step 1: Write the failing query-hook tests**

`modules/publisher/__tests__/use-publisher.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import React from 'react'

const fetchPublisherApps = vi.fn()
const fetchTemplates = vi.fn()
const fetchLicenses = vi.fn()
const fetchEnvironments = vi.fn()
let currentDid: string | undefined = 'did:pkh:eip155:1:0xme'

vi.mock('../graphql', async (orig) => ({
  ...(await orig<typeof import('../graphql')>()),
  fetchPublisherApps: (...a: unknown[]) => fetchPublisherApps(...a),
  fetchTemplates: (...a: unknown[]) => fetchTemplates(...a),
  fetchLicenses: (...a: unknown[]) => fetchLicenses(...a),
  fetchEnvironments: (...a: unknown[]) => fetchEnvironments(...a),
}))
vi.mock('@/modules/cloud/graphql', () => ({ getAuthToken: async () => 'tok' }))
vi.mock('@/modules/cloud/query/use-authed-query', () => ({
  useAuthedQuery: (key: readonly unknown[], fetcher: (t: string | null) => Promise<unknown>, options?: object) =>
    useQuery({ queryKey: key, queryFn: () => fetcher('tok'), ...options }),
}))
vi.mock('@powerhousedao/reactor-browser', () => ({
  useDid: () => currentDid,
  useRenown: () => ({}),
}))

import {
  useAppPublisher,
  usePublisherApps,
  usePublisherLicenses,
  usePublisherTemplates,
} from '../hooks/use-publisher'
import { publisherKeys } from '../hooks/keys'
import { PublisherApiError } from '../graphql'

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  return { qc, Wrapper }
}

describe('publisher query hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    currentDid = 'did:pkh:eip155:1:0xme'
  })

  it('usePublisherApps caches under the viewer DID and resolves an empty list', async () => {
    fetchPublisherApps.mockResolvedValue([])
    const { qc, Wrapper } = wrapper()
    const { result } = renderHook(() => usePublisherApps(), { wrapper: Wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual([])
    expect(qc.getQueryData(publisherKeys.apps('did:pkh:eip155:1:0xme'))).toEqual([])
  })

  it('does not fetch before the wallet resolves', () => {
    currentDid = undefined
    const { Wrapper } = wrapper()
    renderHook(() => usePublisherApps(), { wrapper: Wrapper })
    expect(fetchPublisherApps).not.toHaveBeenCalled()
  })

  it('per-app hooks stay idle without an appId', () => {
    const { Wrapper } = wrapper()
    renderHook(() => usePublisherTemplates(null), { wrapper: Wrapper })
    expect(fetchTemplates).not.toHaveBeenCalled()
  })

  it('usePublisherLicenses asks for every status', async () => {
    fetchLicenses.mockResolvedValue([])
    const { Wrapper } = wrapper()
    const { result } = renderHook(() => usePublisherLicenses('app-1'), { wrapper: Wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(fetchLicenses).toHaveBeenCalledWith('app-1', null, 'tok')
  })

  it('useAppPublisher is true only for an app in myApps', async () => {
    fetchPublisherApps.mockResolvedValue([{ id: 'app-1', name: 'Vault', status: 'ACTIVE' }])
    const { Wrapper } = wrapper()
    const mine = renderHook(() => useAppPublisher('app-1'), { wrapper: Wrapper })
    await waitFor(() => expect(mine.result.current.isPending).toBe(false))
    expect(mine.result.current.isPublisher).toBe(true)
    expect(mine.result.current.app?.name).toBe('Vault')

    const theirs = renderHook(() => useAppPublisher('app-2'), { wrapper: Wrapper })
    await waitFor(() => expect(theirs.result.current.isPending).toBe(false))
    expect(theirs.result.current.isPublisher).toBe(false)
  })

  it('useAppPublisher reports "not the publisher" when myApps fails', async () => {
    // A coded refusal is not retried by retryPublisher, so the query settles at once.
    fetchPublisherApps.mockRejectedValue(new PublisherApiError('FORBIDDEN', 'no', 403))
    const { Wrapper } = wrapper()
    const { result } = renderHook(() => useAppPublisher('app-1'), { wrapper: Wrapper })
    await waitFor(() => expect(result.current.isPending).toBe(false))
    expect(result.current.isPublisher).toBe(false)
  })

  it('useAppPublisher is not pending while signed out', () => {
    currentDid = undefined
    const { Wrapper } = wrapper()
    const { result } = renderHook(() => useAppPublisher('app-1'), { wrapper: Wrapper })
    expect(result.current).toEqual({ isPublisher: false, app: undefined, isPending: false })
  })
})
```

- [ ] **Step 2: Write the failing mutation-hook tests**

`modules/publisher/__tests__/use-publisher-mutations.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'

const addTemplate = vi.fn()
const issueGrant = vi.fn()
const publishTerm = vi.fn()
const setInviteCodeActive = vi.fn()

vi.mock('../graphql', async (orig) => ({
  ...(await orig<typeof import('../graphql')>()),
  addTemplate: (...a: unknown[]) => addTemplate(...a),
  issueGrant: (...a: unknown[]) => issueGrant(...a),
  publishTerm: (...a: unknown[]) => publishTerm(...a),
  setInviteCodeActive: (...a: unknown[]) => setInviteCodeActive(...a),
}))
vi.mock('../hooks/use-publisher', () => ({ usePublisherToken: () => async () => 'tok' }))

import {
  useAddTemplate,
  useIssueGrant,
  usePublishTerm,
  useSetInviteCodeActive,
} from '../hooks/use-publisher-mutations'

function setup() {
  const qc = new QueryClient()
  const invalidate = vi.spyOn(qc, 'invalidateQueries')
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  const invalidated = () => invalidate.mock.calls.map((c) => (c[0] as { queryKey: unknown[] }).queryKey)
  return { Wrapper, invalidated }
}

describe('publisher mutation hooks', () => {
  beforeEach(() => vi.clearAllMocks())

  it('binds the appId into the input and refreshes templates', async () => {
    addTemplate.mockResolvedValue('tpl-1')
    const { Wrapper, invalidated } = setup()
    const { result } = renderHook(() => useAddTemplate('app-1'), { wrapper: Wrapper })
    let id: string | undefined
    await act(async () => {
      id = await result.current.mutateAsync({ name: 'Free', mode: 'SHARED' })
    })
    expect(id).toBe('tpl-1')
    expect(addTemplate).toHaveBeenCalledWith({ appId: 'app-1', name: 'Free', mode: 'SHARED' }, 'tok')
    expect(invalidated()).toEqual([['publisher', 'templates', 'app-1']])
  })

  it('a grant refreshes licences, environments, plan counts and template counts', async () => {
    issueGrant.mockResolvedValue('lic-1')
    const { Wrapper, invalidated } = setup()
    const { result } = renderHook(() => useIssueGrant('app-1'), { wrapper: Wrapper })
    await act(async () => {
      await result.current.mutateAsync({ kind: 'pro', user: '0xabc', label: null })
    })
    expect(issueGrant).toHaveBeenCalledWith({ appId: 'app-1', kind: 'pro', user: '0xabc', label: null }, 'tok')
    expect(invalidated()).toEqual([
      ['publisher', 'licenses', 'app-1'],
      ['publisher', 'environments', 'app-1'],
      ['publisher', 'terms', 'app-1'],
      ['publisher', 'templates', 'app-1'],
    ])
  })

  it('argument mutations get the appId as a bare argument', async () => {
    publishTerm.mockResolvedValue(true)
    setInviteCodeActive.mockResolvedValue(true)
    const { Wrapper } = setup()
    const pub = renderHook(() => usePublishTerm('app-1'), { wrapper: Wrapper })
    const act1 = renderHook(() => useSetInviteCodeActive('app-1'), { wrapper: Wrapper })
    await act(async () => {
      await pub.result.current.mutateAsync({ termId: 't1' })
      await act1.result.current.mutateAsync({ code: 'C', active: false })
    })
    expect(publishTerm).toHaveBeenCalledWith({ appId: 'app-1', termId: 't1' }, 'tok')
    expect(setInviteCodeActive).toHaveBeenCalledWith({ appId: 'app-1', code: 'C', active: false }, 'tok')
  })

  it('never retries a failed write', async () => {
    issueGrant.mockRejectedValue(new Error('nope'))
    const { Wrapper } = setup()
    const { result } = renderHook(() => useIssueGrant('app-1'), { wrapper: Wrapper })
    await act(async () => {
      await expect(result.current.mutateAsync({ kind: 'pro', user: '0xabc' })).rejects.toThrow('nope')
    })
    expect(issueGrant).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 3: Run to see them fail**

Run: `pnpm vitest run --config vitest.unit.config.ts modules/publisher/__tests__/use-publisher`
Expected: FAIL — cannot resolve `../hooks/use-publisher` / `../hooks/keys`.

- [ ] **Step 4: Implement `modules/publisher/hooks/keys.ts`**

```ts
/**
 * React Query keys for the publisher tabs. Keys embed the viewer DID so two
 * wallets on one machine never share a cache entry; `of()` is the DID-less
 * prefix used to invalidate one resource of one app for every viewer.
 */
export type PublisherResource =
  | 'templates'
  | 'terms'
  | 'artifacts'
  | 'licenses'
  | 'environments'
  | 'inviteCodes'
  | 'allowList'

export const publisherKeys = {
  all: ['publisher'] as const,
  apps: (did: string) => ['publisher', 'apps', did] as const,
  resource: (r: PublisherResource, appId: string, did: string) => ['publisher', r, appId, did] as const,
  of: (r: PublisherResource, appId: string) => ['publisher', r, appId] as const,
}
```

- [ ] **Step 5: Implement `modules/publisher/hooks/use-publisher.ts`**

```ts
'use client'

import { useCallback, useRef } from 'react'
import { useRenown } from '@powerhousedao/reactor-browser'
import type { UseQueryOptions } from '@tanstack/react-query'
import { getAuthToken } from '@/modules/cloud/graphql'
import { useAuthedQuery } from '@/modules/cloud/query/use-authed-query'
import { waitForToken } from '@/modules/apps/lib/token'
import {
  fetchAllowList,
  fetchAppArtifacts,
  fetchEnvironments,
  fetchInviteCodes,
  fetchLicenses,
  fetchPublisherApps,
  fetchTemplates,
  fetchTerms,
  retryPublisher,
} from '../graphql'
import type {
  PublisherAllowListEntry,
  PublisherApp,
  PublisherAppArtifact,
  PublisherEnvironment,
  PublisherInviteCode,
  PublisherLicense,
  PublisherTemplate,
  PublisherTerm,
} from '../types'
import { publisherKeys, type PublisherResource } from './keys'
import { useViewerDid } from './use-viewer-did'

const ENVIRONMENTS_POLL_MS = 10_000
const LICENCES_POLL_MS = 15_000

/**
 * Token resolver for mutations. Goes through waitForToken so a write fired right
 * after login or a redirect does not go out unauthenticated.
 */
export function usePublisherToken(): () => Promise<string | null> {
  const renown = useRenown()
  const ref = useRef(renown)
  // eslint-disable-next-line react-hooks/refs
  ref.current = renown
  return useCallback(() => waitForToken(() => getAuthToken(ref.current)), [])
}

export function usePublisherApps() {
  const { did, keyDid } = useViewerDid()
  return useAuthedQuery<PublisherApp[]>(
    publisherKeys.apps(keyDid),
    async (token) => (await fetchPublisherApps(token)) ?? [],
    { retry: retryPublisher, enabled: !!did },
  )
}

/** Is the viewer this app's publisher? Uses the server's own ownership rule (myApps). */
export function useAppPublisher(appId: string) {
  const apps = usePublisherApps()
  const app = apps.data?.find((a) => a.id === appId)
  // A disabled query (signed out) is "pending" forever in React Query; it is not loading.
  const isPending = apps.isPending && apps.fetchStatus !== 'idle'
  return { isPublisher: !!app, app, isPending }
}

type ListOptions<T> = Omit<UseQueryOptions<T[], Error, T[], readonly unknown[]>, 'queryKey' | 'queryFn'>

function useAppList<T>(
  resource: PublisherResource,
  appId: string | null,
  fetcher: (appId: string, token: string | null) => Promise<T[]>,
  options: ListOptions<T> = {},
) {
  const { did, keyDid } = useViewerDid()
  return useAuthedQuery<T[]>(
    publisherKeys.resource(resource, appId ?? '', keyDid),
    async (token) => (await fetcher(appId ?? '', token)) ?? [],
    { retry: retryPublisher, enabled: !!did && !!appId, ...options },
  )
}

export const usePublisherTemplates = (appId: string | null) =>
  useAppList<PublisherTemplate>('templates', appId, fetchTemplates)

export const usePublisherTerms = (appId: string | null) =>
  useAppList<PublisherTerm>('terms', appId, fetchTerms)

export const usePublisherAppArtifacts = (appId: string | null) =>
  useAppList<PublisherAppArtifact>('artifacts', appId, fetchAppArtifacts)

/** Every licence of the app; tabs filter client-side. Polls while one is still ISSUED. */
export const usePublisherLicenses = (appId: string | null) =>
  useAppList<PublisherLicense>('licenses', appId, (id, t) => fetchLicenses(id, null, t), {
    refetchInterval: (query) =>
      query.state.data?.some((l) => l.status === 'ISSUED') ? LICENCES_POLL_MS : false,
    refetchIntervalInBackground: false,
  })

/** Keeper-driven and delayed, so it polls while mounted. */
export const usePublisherEnvironments = (appId: string | null) =>
  useAppList<PublisherEnvironment>('environments', appId, fetchEnvironments, {
    refetchInterval: ENVIRONMENTS_POLL_MS,
    refetchIntervalInBackground: false,
  })

export const usePublisherInviteCodes = (appId: string | null) =>
  useAppList<PublisherInviteCode>('inviteCodes', appId, fetchInviteCodes)

export const usePublisherAllowList = (appId: string | null) =>
  useAppList<PublisherAllowListEntry>('allowList', appId, fetchAllowList)
```

- [ ] **Step 6: Implement `modules/publisher/hooks/use-publisher-mutations.ts`**

```ts
'use client'

import { useMutation, useQueryClient } from '@tanstack/react-query'
import * as api from '../graphql'
import type {
  AddTemplateInput,
  AddTemplatePackageInput,
  AddTemplateServiceInput,
  AddTermInput,
  CreateInviteCodeInput,
  IssueGrantInput,
  PublisherInviteCode,
  RemoveTemplateEntryInput,
  ReplaceGrantInput,
  RevokeLicenseInput,
  SetTemplateDetailsInput,
  SetTermDetailsInput,
} from '../types'
import { publisherKeys, type PublisherResource } from './keys'
import { usePublisherToken } from './use-publisher'

// No mutation retries: retrying a grant could issue two licences for one click.
// Errors are not caught here; the UI shows the server's sentence verbatim.

type NoApp<T> = Omit<T, 'appId'>

function usePublisherMutation<V, R>(
  appId: string,
  fn: (vars: V, token: string | null) => Promise<R>,
  invalidates: readonly PublisherResource[],
) {
  const qc = useQueryClient()
  const token = usePublisherToken()
  return useMutation<R, Error, V>({
    mutationFn: async (vars) => fn(vars, await token()),
    onSuccess: () => {
      for (const r of invalidates) void qc.invalidateQueries({ queryKey: publisherKeys.of(r, appId) })
    },
  })
}

const TEMPLATE_WRITES = ['templates'] as const
// A template edit re-applies to its environments, so their hashes change too.
const TEMPLATE_CONTENT_WRITES = ['templates', 'environments'] as const
const TERM_WRITES = ['terms'] as const
// Licence changes move counts on plans (activeLicenses) and templates (environmentCount).
const LICENCE_WRITES = ['licenses', 'environments', 'terms', 'templates'] as const

export const useAddTemplate = (appId: string) =>
  usePublisherMutation<NoApp<AddTemplateInput>, string>(
    appId,
    (v, t) => api.addTemplate({ appId, ...v }, t),
    TEMPLATE_WRITES,
  )
export const useSetTemplateDetails = (appId: string) =>
  usePublisherMutation<NoApp<SetTemplateDetailsInput>, boolean>(
    appId,
    (v, t) => api.setTemplateDetails({ appId, ...v }, t),
    TEMPLATE_CONTENT_WRITES,
  )
export const useAddTemplateService = (appId: string) =>
  usePublisherMutation<NoApp<AddTemplateServiceInput>, boolean>(
    appId,
    (v, t) => api.addTemplateService({ appId, ...v }, t),
    TEMPLATE_CONTENT_WRITES,
  )
export const useRemoveTemplateService = (appId: string) =>
  usePublisherMutation<NoApp<RemoveTemplateEntryInput>, boolean>(
    appId,
    (v, t) => api.removeTemplateService({ appId, ...v }, t),
    TEMPLATE_CONTENT_WRITES,
  )
export const useAddTemplatePackage = (appId: string) =>
  usePublisherMutation<NoApp<AddTemplatePackageInput>, boolean>(
    appId,
    (v, t) => api.addTemplatePackage({ appId, ...v }, t),
    TEMPLATE_CONTENT_WRITES,
  )
export const useRemoveTemplatePackage = (appId: string) =>
  usePublisherMutation<NoApp<RemoveTemplateEntryInput>, boolean>(
    appId,
    (v, t) => api.removeTemplatePackage({ appId, ...v }, t),
    TEMPLATE_CONTENT_WRITES,
  )
export const useDeleteTemplate = (appId: string) =>
  usePublisherMutation<{ templateId: string }, boolean>(
    appId,
    (v, t) => api.deleteTemplate({ appId, ...v }, t),
    TEMPLATE_WRITES,
  )

export const useAddTerm = (appId: string) =>
  usePublisherMutation<NoApp<AddTermInput>, string>(
    appId,
    (v, t) => api.addTerm({ appId, ...v }, t),
    TERM_WRITES,
  )
export const useSetTermDetails = (appId: string) =>
  usePublisherMutation<NoApp<SetTermDetailsInput>, boolean>(
    appId,
    (v, t) => api.setTermDetails({ appId, ...v }, t),
    TERM_WRITES,
  )
export const usePublishTerm = (appId: string) =>
  usePublisherMutation<{ termId: string }, boolean>(
    appId,
    (v, t) => api.publishTerm({ appId, ...v }, t),
    TERM_WRITES,
  )
export const useRetireTerm = (appId: string) =>
  usePublisherMutation<{ termId: string }, boolean>(
    appId,
    (v, t) => api.retireTerm({ appId, ...v }, t),
    TERM_WRITES,
  )

export const useIssueGrant = (appId: string) =>
  usePublisherMutation<NoApp<IssueGrantInput>, string>(
    appId,
    (v, t) => api.issueGrant({ appId, ...v }, t),
    LICENCE_WRITES,
  )
export const useReplaceGrant = (appId: string) =>
  usePublisherMutation<ReplaceGrantInput, string>(appId, (v, t) => api.replaceGrant(v, t), LICENCE_WRITES)
export const useRevokeLicense = (appId: string) =>
  usePublisherMutation<RevokeLicenseInput, boolean>(appId, (v, t) => api.revokeLicense(v, t), LICENCE_WRITES)

export const useCreateInviteCode = (appId: string) =>
  usePublisherMutation<NoApp<CreateInviteCodeInput>, PublisherInviteCode>(
    appId,
    (v, t) => api.createInviteCode({ appId, ...v }, t),
    ['inviteCodes'],
  )
export const useSetInviteCodeActive = (appId: string) =>
  usePublisherMutation<{ code: string; active: boolean }, boolean>(
    appId,
    (v, t) => api.setInviteCodeActive({ appId, ...v }, t),
    ['inviteCodes'],
  )

export const useAddToAllowList = (appId: string) =>
  usePublisherMutation<{ user: string }, boolean>(
    appId,
    (v, t) => api.addToAllowList({ appId, ...v }, t),
    ['allowList'],
  )
export const useRemoveFromAllowList = (appId: string) =>
  usePublisherMutation<{ user: string }, boolean>(
    appId,
    (v, t) => api.removeFromAllowList({ appId, ...v }, t),
    ['allowList'],
  )
```

- [ ] **Step 7: Run tests and typecheck**

Run: `pnpm vitest run --config vitest.unit.config.ts modules/publisher && pnpm tsc`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add modules/publisher/hooks modules/publisher/__tests__/use-publisher.test.tsx modules/publisher/__tests__/use-publisher-mutations.test.tsx
git commit -m "feat(publisher): query and mutation hooks for templates, plans, holders and codes"
```

---
### Task 3: App page shell with owner-only licensing tabs, and the Artifacts tab

Turns `/user/apps/[id]` into the one app page. This task adds the tab plumbing, the shared look of every licensing tab (header, skeleton, empty state, error), the inactive-app banner and the first licensing tab (Artifacts). Tasks 4, 6, 7 and 8 each append one tab id to `LICENSING_TABS`.

**Files:**
- Create: `modules/apps/components/banner.tsx` (the `Banner` function moved verbatim out of `app-detail.tsx`, now exported)
- Modify: `modules/apps/components/app-detail.tsx`
- Create: `modules/publisher/components/primitives.tsx`
- Create: `modules/publisher/components/licensing-unavailable-banner.tsx`
- Create: `modules/publisher/components/artifacts/artifacts-tab.tsx`
- Create: `modules/publisher/lib/format.ts`, `modules/publisher/lib/status.ts`, `modules/publisher/lib/run.ts`, `modules/publisher/lib/artifacts.ts`
- Create: `modules/shared/test/native-select.tsx`
- Test: `modules/apps/__tests__/app-detail-tabs.test.tsx`, `modules/publisher/__tests__/artifacts-tab.test.tsx`, `modules/publisher/__tests__/format-status.test.ts`

**Interfaces:**
- Consumes: `useAppPublisher`, `usePublisherAppArtifacts` (Task 2); `StatusPill`, `StatusMeta` from `modules/apps/components/status` and `modules/apps/lib/status`; `formatDate` from `modules/apps/lib/time`; `CopyButton` from `modules/apps/components/copy-button`.
- Produces:
  - `modules/apps/components/banner.tsx`: `Banner({ tone: 'warning' | 'danger' | 'neutral'; icon: LucideIcon; title: string; children: ReactNode; actions?: ReactNode })`.
  - `modules/apps/components/app-detail.tsx`: `LICENSING_TABS` (readonly tuple), `type AppTab`, `APP_TAB_LABEL: Record<AppTab, string>`, `visibleAppTabs({ readOnly, isPublisher }): AppTab[]`.
  - `primitives.tsx`: `TabHeader({ title, description, action? })`, `TabSkeleton({ rows?, label })`, `EmptyState({ icon, title, children, action? })`, `TabError({ error, onRetry, retrying? })`, `SectionCard({ title, description?, action?, children })`.
  - `lib/format.ts`: `shortDid(did): string`, `termName(term): string`, `templateName(template): string`, `validityText(days: number | null): string`, `envCountText(n: number): string`, `dateRange(start, end): string`.
  - `lib/status.ts`: `termStatusMeta(status)`, `licenseStatusMeta(status)`, `type InviteCodeState = 'active' | 'paused' | 'expired' | 'used-up'`, `inviteCodeState(code, now?)`, `inviteCodeStatusMeta(state)`, all returning the apps `StatusMeta`.
  - `lib/run.ts`: `runWithToast(fn: () => Promise<unknown>, ok: string): Promise<boolean>`.
  - `lib/artifacts.ts`: `CHANNELS`, `type ChannelValue`, `channelLabel(channel): string`, `artifactKindLabel(kind): string`, `NO_IMAGES_YET`, `NO_PACKAGES_YET`.
  - `modules/shared/test/native-select.tsx`: a drop-in module for `vi.mock('@/shared/components/ui/select', () => import('@/modules/shared/test/native-select'))` rendering a native `<select aria-label=…>` (label taken from the trigger's `aria-label`).

- [ ] **Step 1: Write the failing format/status tests**

`modules/publisher/__tests__/format-status.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { dateRange, envCountText, shortDid, templateName, termName, validityText } from '../lib/format'
import { inviteCodeState, licenseStatusMeta, termStatusMeta } from '../lib/status'

describe('format', () => {
  it('shortens did:pkh and bare addresses to 0x1234…abcd', () => {
    const addr = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01'
    expect(shortDid(`did:pkh:eip155:1:${addr}`)).toBe('0xAbCd…Ef01')
    expect(shortDid(addr)).toBe('0xAbCd…Ef01')
    expect(shortDid('did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK')).toBe('did:key:z6Mk…ta2doK')
  })

  it('names plans and templates without ever showing an empty string', () => {
    expect(termName({ label: 'Free', kind: '2026-free' })).toBe('Free')
    expect(termName({ label: '  ', kind: '2026-free' })).toBe('2026-free')
    expect(templateName({ name: null, mode: 'SHARED' })).toBe('Untitled shared template')
    expect(templateName({ name: 'Pro', mode: 'DEDICATED' })).toBe('Pro')
  })

  it('reads validity and counts like a sentence', () => {
    expect(validityText(null)).toBe('No end date')
    expect(validityText(1)).toBe('1 day')
    expect(validityText(30)).toBe('30 days')
    expect(envCountText(0)).toBe('No environments yet')
    expect(envCountText(1)).toBe('1 environment')
    expect(envCountText(4)).toBe('4 environments')
  })

  it('formats an open-ended range', () => {
    expect(dateRange(null, null)).toBe('Not started')
    expect(dateRange('2026-10-01T00:00:00Z', null)).toMatch(/2026 – no end date$/)
  })
})

describe('status meta', () => {
  it('labels every term and licence status, and passes unknown ones through', () => {
    expect(termStatusMeta('DRAFT').label).toBe('Draft')
    expect(termStatusMeta('ACTIVE')).toMatchObject({ label: 'Published', tone: 'success' })
    expect(termStatusMeta('RETIRED').label).toBe('Retired')
    expect(licenseStatusMeta('ISSUED')).toMatchObject({ label: 'Setting up', active: true })
    expect(licenseStatusMeta('REPLACED').label).toBe('Replaced')
    expect(licenseStatusMeta('WEIRD').label).toBe('WEIRD')
  })

  it('derives an invite code state: paused beats expired beats used up', () => {
    const now = new Date('2026-10-08T12:00:00Z')
    const base = { active: true, expiresAt: null, maxUses: null, redemptions: 0 }
    expect(inviteCodeState(base, now)).toBe('active')
    expect(inviteCodeState({ ...base, active: false, expiresAt: '2026-01-01T00:00:00Z' }, now)).toBe('paused')
    expect(inviteCodeState({ ...base, expiresAt: '2026-10-08T11:59:59Z' }, now)).toBe('expired')
    expect(inviteCodeState({ ...base, maxUses: 3, redemptions: 3 }, now)).toBe('used-up')
    expect(inviteCodeState({ ...base, maxUses: 3, redemptions: 2 }, now)).toBe('active')
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm vitest run --config vitest.unit.config.ts modules/publisher/__tests__/format-status.test.ts`
Expected: FAIL — cannot resolve `../lib/format`.

- [ ] **Step 3: Implement `lib/format.ts`, `lib/status.ts`, `lib/run.ts`, `lib/artifacts.ts`**

`modules/publisher/lib/format.ts`:

```ts
import { formatDate } from '@/modules/apps/lib/time'
import type { PublisherTemplate, PublisherTerm } from '../types'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const PKH = /^did:pkh:eip155:\d+:(0x[0-9a-fA-F]{40})$/

/** "0x1234…abcd" for wallets; first 12 + "…" + last 6 characters for any other long DID. */
export function shortDid(did: string): string {
  const address = PKH.exec(did)?.[1] ?? (ADDRESS.test(did) ? did : null)
  if (address) return `${address.slice(0, 6)}…${address.slice(-4)}`
  return did.length > 20 ? `${did.slice(0, 12)}…${did.slice(-6)}` : did
}

export function termName(term: Pick<PublisherTerm, 'label' | 'kind'>): string {
  return term.label?.trim() || term.kind
}

export function templateName(template: Pick<PublisherTemplate, 'name' | 'mode'>): string {
  return (
    template.name?.trim() ||
    (template.mode === 'SHARED' ? 'Untitled shared template' : 'Untitled dedicated template')
  )
}

export function validityText(days: number | null): string {
  if (days == null) return 'No end date'
  return days === 1 ? '1 day' : `${days} days`
}

export function envCountText(n: number): string {
  if (n === 0) return 'No environments yet'
  return n === 1 ? '1 environment' : `${n} environments`
}

export function dateRange(start: string | null, end: string | null): string {
  if (!start) return 'Not started'
  return `${formatDate(start)} – ${end ? formatDate(end) : 'no end date'}`
}
```

`modules/publisher/lib/status.ts`:

```ts
import type { StatusMeta } from '@/modules/apps/lib/status'
import type { PublisherInviteCode } from '../types'

const TERM: Record<string, StatusMeta> = {
  DRAFT: { label: 'Draft', tone: 'neutral', active: false },
  ACTIVE: { label: 'Published', tone: 'success', active: false },
  RETIRED: { label: 'Retired', tone: 'warning', active: false },
}

const LICENSE: Record<string, StatusMeta> = {
  ISSUED: { label: 'Setting up', tone: 'progress', active: true },
  ACTIVE: { label: 'Active', tone: 'success', active: false },
  EXPIRED: { label: 'Expired', tone: 'warning', active: false },
  REVOKED: { label: 'Revoked', tone: 'danger', active: false },
  REPLACED: { label: 'Replaced', tone: 'neutral', active: false },
}

const unknown = (status: string): StatusMeta => ({ label: status, tone: 'neutral', active: false })

export const termStatusMeta = (status: string): StatusMeta => TERM[status] ?? unknown(status)
export const licenseStatusMeta = (status: string): StatusMeta => LICENSE[status] ?? unknown(status)

export type InviteCodeState = 'active' | 'paused' | 'expired' | 'used-up'

export function inviteCodeState(
  code: Pick<PublisherInviteCode, 'active' | 'expiresAt' | 'maxUses' | 'redemptions'>,
  now: Date = new Date(),
): InviteCodeState {
  if (!code.active) return 'paused'
  if (code.expiresAt && new Date(code.expiresAt).getTime() <= now.getTime()) return 'expired'
  if (code.maxUses != null && code.redemptions >= code.maxUses) return 'used-up'
  return 'active'
}

const CODE: Record<InviteCodeState, StatusMeta> = {
  active: { label: 'Active', tone: 'success', active: false },
  paused: { label: 'Paused', tone: 'neutral', active: false },
  expired: { label: 'Expired', tone: 'warning', active: false },
  'used-up': { label: 'Used up', tone: 'neutral', active: false },
}
export const inviteCodeStatusMeta = (state: InviteCodeState): StatusMeta => CODE[state]
```

`modules/publisher/lib/run.ts`:

```ts
import { toast } from 'sonner'
import { describePublisherError } from '../graphql'

/** Runs a write; success toasts `ok`, failure toasts the server's sentence verbatim. */
export async function runWithToast(fn: () => Promise<unknown>, ok: string): Promise<boolean> {
  try {
    await fn()
    toast.success(ok)
    return true
  } catch (err) {
    toast.error(describePublisherError(err))
    return false
  }
}
```

`modules/publisher/lib/artifacts.ts`:

```ts
export const CHANNELS = [
  { value: 'LATEST', label: 'Latest release' },
  { value: 'STAGING', label: 'Staging builds' },
  { value: 'DEV', label: 'Dev builds' },
] as const

export type ChannelValue = (typeof CHANNELS)[number]['value']

export function channelLabel(channel: string): string {
  return CHANNELS.find((c) => c.value === channel)?.label ?? channel
}

export function artifactKindLabel(kind: string): string {
  return kind === 'FUSION_IMAGE' ? 'App image' : kind === 'PACKAGE' ? 'Package' : kind
}

export const NO_IMAGES_YET =
  'This app has not published an app image yet. Run the Vetra deploy workflow once, then pick the image here.'

export const NO_PACKAGES_YET =
  'This app has not published a package yet. Run the Vetra deploy workflow once, then pick the package here.'
```

- [ ] **Step 4: Run the format/status tests**

Run: `pnpm vitest run --config vitest.unit.config.ts modules/publisher/__tests__/format-status.test.ts`
Expected: PASS.

- [ ] **Step 5: Create the shared native Select stand-in**

`modules/shared/test/native-select.tsx` (test-only; not under `__tests__`, so vitest never runs it as a suite):

```tsx
import React from 'react'

/**
 * Radix Select cannot be driven in happy-dom. Tests replace it with:
 *   vi.mock('@/shared/components/ui/select', () => import('@/modules/shared/test/native-select'))
 * The native <select> takes its accessible name from the SelectTrigger's aria-label.
 */
export const SelectTrigger = (_: { 'aria-label'?: string; className?: string; children?: React.ReactNode }) => null
export const SelectValue = (_: { placeholder?: string }) => null
export const SelectContent = ({ children }: { children: React.ReactNode }) => <>{children}</>
export const SelectItem = ({
  value,
  children,
  disabled,
}: {
  value: string
  children: React.ReactNode
  disabled?: boolean
}) => (
  <option value={value} disabled={disabled}>
    {children}
  </option>
)

function findTriggerLabel(node: React.ReactNode): string | undefined {
  for (const child of React.Children.toArray(node)) {
    if (!React.isValidElement(child)) continue
    const el = child as React.ReactElement<{ 'aria-label'?: string; children?: React.ReactNode }>
    if (el.type === SelectTrigger) return el.props['aria-label']
    const inner = findTriggerLabel(el.props.children)
    if (inner) return inner
  }
  return undefined
}

export function Select({
  value,
  onValueChange,
  disabled,
  children,
}: {
  value?: string
  onValueChange?: (v: string) => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <select
      aria-label={findTriggerLabel(children)}
      value={value ?? ''}
      disabled={disabled}
      onChange={(e) => onValueChange?.(e.target.value)}
    >
      <option value="" />
      {children}
    </select>
  )
}
```

- [ ] **Step 6: Create `primitives.tsx` and the banner**

`modules/publisher/components/primitives.tsx`:

```tsx
'use client'

import { RefreshCw, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/modules/shared/components/ui/button'
import { Skeleton } from '@/modules/shared/components/ui/skeleton'
import { describePublisherError } from '../graphql'

/** Title + one-line explanation + primary action, shared by every licensing tab. */
export function TabHeader({
  title,
  description,
  action,
}: {
  title: string
  description: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="space-y-1">
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        <p className="text-muted-foreground max-w-2xl text-sm">{description}</p>
      </div>
      {action && <div className="flex shrink-0 flex-wrap gap-2">{action}</div>}
    </div>
  )
}

export function TabSkeleton({ rows = 3, label }: { rows?: number; label: string }) {
  return (
    <div className="space-y-3" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="bg-card border-border flex items-center gap-4 rounded-xl border p-4">
          <Skeleton className="h-10 w-10 shrink-0 rounded-xl" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-2/3" />
          </div>
          <Skeleton className="hidden h-8 w-20 sm:block" />
        </div>
      ))}
    </div>
  )
}

export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
}: {
  icon: LucideIcon
  title: string
  children: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="border-border flex flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-14 text-center">
      <span className="bg-primary/10 text-primary flex h-12 w-12 items-center justify-center rounded-2xl">
        <Icon className="h-5 w-5" aria-hidden />
      </span>
      <div className="space-y-1.5">
        <p className="font-semibold">{title}</p>
        <p className="text-muted-foreground mx-auto max-w-md text-sm">{children}</p>
      </div>
      {action}
    </div>
  )
}

export function TabError({
  error,
  onRetry,
  retrying = false,
}: {
  error: unknown
  onRetry: () => void
  retrying?: boolean
}) {
  return (
    <div
      role="alert"
      className="border-destructive/30 bg-destructive/5 flex flex-col items-center gap-3 rounded-xl border px-6 py-10 text-center"
    >
      <p className="text-sm font-semibold">This did not load</p>
      <p className="text-muted-foreground max-w-md text-sm">{describePublisherError(error)}</p>
      <Button size="sm" variant="outline" onClick={onRetry} disabled={retrying}>
        <RefreshCw className={retrying ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
        Try again
      </Button>
    </div>
  )
}

export function SectionCard({
  title,
  description,
  action,
  children,
}: {
  title: string
  description?: ReactNode
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="bg-card border-border space-y-4 rounded-xl border p-5 shadow-sm">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-0.5">
          <h3 className="font-semibold">{title}</h3>
          {description && <p className="text-muted-foreground text-sm">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}
```

`modules/publisher/components/licensing-unavailable-banner.tsx`:

```tsx
import { PauseCircle } from 'lucide-react'
import { Banner } from '@/modules/apps/components/banner'

/** Shown on licensing tabs while the app is not ACTIVE; the server refuses writes then. */
export function LicensingUnavailableBanner({ status }: { status: string }) {
  const readable = status.toLowerCase().replace(/_/g, ' ')
  return (
    <Banner tone="warning" icon={PauseCircle} title="Licensing is paused for this app">
      This app is {readable}. You can look around, but plans, grants and invite codes can only be
      changed once the app is active again — usually after you authorize its deploy identity.
    </Banner>
  )
}
```

Create `modules/apps/components/banner.tsx` by moving the `Banner` function out of `app-detail.tsx` unchanged, adding `'use client'` is not needed (no hooks). Add at the top:

```tsx
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
```

and change its signature to `export function Banner({ tone, icon: Icon, title, children, actions }: { tone: 'warning' | 'danger' | 'neutral'; icon: LucideIcon; title: string; children: ReactNode; actions?: ReactNode })`. In `app-detail.tsx` delete the local `Banner` and `import { Banner } from './banner'`.

- [ ] **Step 7: Write the failing Artifacts tab test**

`modules/publisher/__tests__/artifacts-tab.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import React from 'react'

let state: { data?: unknown; isPending: boolean; error: Error | null } = { isPending: true, error: null }
const refetch = vi.fn()
vi.mock('../hooks/use-publisher', () => ({
  usePublisherAppArtifacts: () => ({ ...state, refetch, isRefetching: false }),
}))

import { ArtifactsTab } from '../components/artifacts/artifacts-tab'

const versions = Array.from({ length: 7 }, (_, i) => ({ version: `1.${i}.0`, reference: `sha256:${i}` }))

describe('ArtifactsTab', () => {
  beforeEach(() => cleanup())

  it('shows a skeleton while loading', () => {
    state = { isPending: true, error: null }
    render(<ArtifactsTab appId="app-1" />)
    expect(screen.getByRole('status', { name: /loading artifacts/i })).toBeTruthy()
  })

  it('explains what to do when nothing is published', () => {
    state = { isPending: false, error: null, data: [] }
    render(<ArtifactsTab appId="app-1" />)
    expect(screen.getByText('Nothing published yet')).toBeTruthy()
    expect(screen.getByRole('link', { name: /deploy guide/i }).getAttribute('href')).toBe('/docs/deploy')
  })

  it('lists newest versions first, five at a time, with channel pointers', () => {
    state = {
      isPending: false,
      error: null,
      data: [{ kind: 'PACKAGE', name: '@acme/vault', versions, channels: [{ channel: 'LATEST', version: '1.6.0' }] }],
    }
    render(<ArtifactsTab appId="app-1" />)
    const card = screen.getByTestId('artifact-@acme/vault')
    expect(within(card).getByText('Package')).toBeTruthy()
    expect(within(card).getByText('Latest release')).toBeTruthy()
    const rows = within(card).getAllByTestId('artifact-version')
    expect(rows.map((r) => r.textContent?.match(/1\.\d\.0/)?.[0])).toEqual(['1.6.0', '1.5.0', '1.4.0', '1.3.0', '1.2.0'])
    fireEvent.click(within(card).getByRole('button', { name: /show all 7 versions/i }))
    expect(within(card).getAllByTestId('artifact-version')).toHaveLength(7)
  })

  it('offers a retry on error', () => {
    state = { isPending: false, error: new Error('down'), data: undefined }
    render(<ArtifactsTab appId="app-1" />)
    fireEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(refetch).toHaveBeenCalled()
  })
})
```

- [ ] **Step 8: Implement the Artifacts tab**

`modules/publisher/components/artifacts/artifacts-tab.tsx`:

```tsx
'use client'

import { BookOpen, Box, Container, PackageOpen } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'
import { CopyButton } from '@/modules/apps/components/copy-button'
import { Button } from '@/modules/shared/components/ui/button'
import { usePublisherAppArtifacts } from '../../hooks/use-publisher'
import { artifactKindLabel, channelLabel } from '../../lib/artifacts'
import type { PublisherAppArtifact } from '../../types'
import { EmptyState, TabError, TabHeader, TabSkeleton } from '../primitives'

const VISIBLE = 5

function ArtifactCard({ artifact }: { artifact: PublisherAppArtifact }) {
  const [all, setAll] = useState(false)
  const newestFirst = [...artifact.versions].reverse()
  const shown = all ? newestFirst : newestFirst.slice(0, VISIBLE)
  const Icon = artifact.kind === 'FUSION_IMAGE' ? Container : Box
  return (
    <article
      data-testid={`artifact-${artifact.name}`}
      className="bg-card border-border space-y-4 rounded-xl border p-5 shadow-sm"
    >
      <header className="flex items-start gap-3">
        <span className="bg-primary/10 text-primary flex h-10 w-10 shrink-0 items-center justify-center rounded-xl">
          <Icon className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-mono text-sm font-semibold">{artifact.name}</h3>
          <p className="text-muted-foreground text-xs">
            {artifactKindLabel(artifact.kind)} · {artifact.versions.length} published
          </p>
        </div>
      </header>
      {artifact.channels.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="Channels">
          {artifact.channels.map((c) => (
            <li
              key={c.channel}
              className="bg-muted inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs"
            >
              <span className="font-medium">{channelLabel(c.channel)}</span>
              <span className="text-muted-foreground font-mono">{c.version}</span>
            </li>
          ))}
        </ul>
      )}
      <ul className="divide-border divide-y text-sm">
        {shown.map((v) => (
          <li key={v.version} data-testid="artifact-version" className="flex items-center gap-3 py-2">
            <span className="w-24 shrink-0 font-mono">{v.version}</span>
            <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-xs">
              {v.reference}
            </span>
            <CopyButton value={v.reference} label={`Copy reference of ${v.version}`} />
          </li>
        ))}
      </ul>
      {newestFirst.length > VISIBLE && (
        <Button variant="ghost" size="sm" onClick={() => setAll((x) => !x)}>
          {all ? 'Show fewer' : `Show all ${newestFirst.length} versions`}
        </Button>
      )}
    </article>
  )
}

/** Read-only: what CI has published for this app. Templates pick from this list. */
export function ArtifactsTab({ appId }: { appId: string }) {
  const artifacts = usePublisherAppArtifacts(appId)
  const list = artifacts.data ?? []
  return (
    <div className="space-y-6">
      <TabHeader
        title="Artifacts"
        description="Packages and app images your deploy workflow has published. Templates use them to decide what every owner runs."
      />
      {artifacts.isPending ? (
        <TabSkeleton label="Loading artifacts" />
      ) : artifacts.error ? (
        <TabError
          error={artifacts.error}
          onRetry={() => void artifacts.refetch()}
          retrying={artifacts.isRefetching}
        />
      ) : list.length === 0 ? (
        <EmptyState
          icon={PackageOpen}
          title="Nothing published yet"
          action={
            <Button asChild variant="outline" size="sm">
              <Link href="/docs/deploy">
                <BookOpen className="h-4 w-4" />
                Deploy guide
              </Link>
            </Button>
          }
        >
          Artifacts appear here after the Vetra deploy workflow publishes a package or an app image.
        </EmptyState>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {list.map((a) => (
            <ArtifactCard key={`${a.kind}:${a.name}`} artifact={a} />
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 9: Write the failing app-detail tab test**

`modules/apps/__tests__/app-detail-tabs.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import React from 'react'
import type { App } from '../types'

let searchParams = new URLSearchParams()
let publisher: { isPublisher: boolean; app?: { id: string; name: string; status: string }; isPending: boolean } = {
  isPublisher: true,
  app: { id: 'app-1', name: 'Vault', status: 'ACTIVE' },
  isPending: false,
}
let app: App

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/user/apps/app-1',
  useSearchParams: () => searchParams,
}))
vi.mock('@powerhousedao/reactor-browser', () => ({
  useRenownAuthAsync: () => ({ state: 'authenticated' }),
}))
vi.mock('../hooks/use-apps', () => ({
  useApp: () => ({ data: app, isPending: false, error: null }),
  useAppDeployments: () => ({ data: [], isPending: false, error: null }),
  useGithubDeployAppInfo: () => ({ data: undefined }),
  useConfirmAppIdentity: () => ({ mutate: vi.fn(), isPending: false }),
}))
vi.mock('@/modules/publisher/hooks/use-publisher', () => ({
  useAppPublisher: () => publisher,
}))
vi.mock('../components/app-overview', () => ({ AppOverview: () => <div>overview-content</div> }))
vi.mock('../components/app-deployments', () => ({ AppDeployments: () => <div>deployments-content</div> }))
vi.mock('../components/app-settings', () => ({ AppSettings: () => <div>settings-content</div> }))
vi.mock('../components/github-flow-link', () => ({ GithubFlowLink: () => null }))
vi.mock('@/modules/publisher/components/artifacts/artifacts-tab', () => ({
  ArtifactsTab: () => <div>artifacts-content</div>,
}))

import { AppDetail, visibleAppTabs } from '../components/app-detail'

function makeApp(over: Partial<App> = {}): App {
  const urls = { app: null, connect: null, switchboard: null }
  return {
    id: 'app-1', slug: 'vault', name: 'Vault', ownerAddress: '0xme', status: 'ACTIVE',
    repository: { installationId: '1', repositoryId: '2', fullName: 'acme/vault' },
    productionBranch: 'main', productionEnvironmentId: 'env-prod', previewsEnabled: false,
    previewLimit: 0, previewTtlDays: 0, harborProject: 'acme', identityDid: 'did:key:z',
    renownAuthorizeUrl: 'https://renown/authorize', identityExpiresAt: null, productionUrls: urls,
    previews: [], latestDeployment: null, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
    ...over,
  }
}

const tabNames = () => screen.getAllByRole('tab').map((t) => t.textContent?.replace(/\d+$/, '').trim())

describe('AppDetail tabs', () => {
  beforeEach(() => {
    cleanup()
    searchParams = new URLSearchParams()
    app = makeApp()
    publisher = { isPublisher: true, app: { id: 'app-1', name: 'Vault', status: 'ACTIVE' }, isPending: false }
  })

  it('computes the tab list from ownership and read-only state', () => {
    expect(visibleAppTabs({ readOnly: false, isPublisher: true })).toEqual([
      'overview', 'deployments', 'artifacts', 'settings',
    ])
    expect(visibleAppTabs({ readOnly: false, isPublisher: false })).toEqual(['overview', 'deployments', 'settings'])
    expect(visibleAppTabs({ readOnly: true, isPublisher: true })).toEqual(['overview', 'deployments'])
  })

  it('shows licensing tabs to the publisher, with readable labels', () => {
    render(<AppDetail appId="app-1" />)
    expect(tabNames()).toEqual(['Overview', 'Deployments', 'Artifacts', 'Settings'])
  })

  it('opens a licensing tab from the URL', () => {
    searchParams = new URLSearchParams('tab=artifacts')
    render(<AppDetail appId="app-1" />)
    expect(screen.getByText('artifacts-content')).toBeTruthy()
  })

  it('hides licensing tabs from anyone else and ignores a deep link to them', () => {
    publisher = { isPublisher: false, app: undefined, isPending: false }
    searchParams = new URLSearchParams('tab=artifacts')
    render(<AppDetail appId="app-1" />)
    expect(tabNames()).toEqual(['Overview', 'Deployments', 'Settings'])
    expect(screen.queryByText('artifacts-content')).toBeNull()
    expect(screen.getByText('overview-content')).toBeTruthy()
  })

  it('shows the paused-licensing banner on a licensing tab of an inactive app', () => {
    publisher = { isPublisher: true, app: { id: 'app-1', name: 'Vault', status: 'PENDING_IDENTITY' }, isPending: false }
    searchParams = new URLSearchParams('tab=artifacts')
    render(<AppDetail appId="app-1" />)
    expect(screen.getByText('Licensing is paused for this app')).toBeTruthy()
  })

  it('does not show the paused banner on Overview', () => {
    publisher = { isPublisher: true, app: { id: 'app-1', name: 'Vault', status: 'PENDING_IDENTITY' }, isPending: false }
    render(<AppDetail appId="app-1" />)
    expect(screen.queryByText('Licensing is paused for this app')).toBeNull()
  })
})
```

- [ ] **Step 10: Run to see it fail**

Run: `pnpm vitest run --config vitest.unit.config.ts modules/apps/__tests__/app-detail-tabs.test.tsx`
Expected: FAIL — `visibleAppTabs` is not exported; tab labels are lowercase.

- [ ] **Step 11: Modify `modules/apps/components/app-detail.tsx`**

Replace the `TABS`/`Tab` declarations with:

```tsx
/** Owner-only tabs, in display order. Tasks append to this as each tab lands. */
export const LICENSING_TABS = ['artifacts'] as const
const ALL_TABS = ['overview', 'deployments', ...LICENSING_TABS, 'settings'] as const
export type AppTab = (typeof ALL_TABS)[number]

export const APP_TAB_LABEL: Record<AppTab, string> = {
  overview: 'Overview',
  deployments: 'Deployments',
  artifacts: 'Artifacts',
  settings: 'Settings',
}

const isLicensingTab = (t: AppTab): boolean => (LICENSING_TABS as readonly string[]).includes(t)

/** Licensing tabs only for the app's publisher; nothing editable on a deleted app. */
export function visibleAppTabs({
  readOnly,
  isPublisher,
}: {
  readOnly: boolean
  isPublisher: boolean
}): AppTab[] {
  const tabs: AppTab[] = ['overview', 'deployments']
  if (isPublisher && !readOnly) tabs.push(...LICENSING_TABS)
  if (!readOnly) tabs.push('settings')
  return tabs
}
```

Add imports:

```tsx
import { ArtifactsTab } from '@/modules/publisher/components/artifacts/artifacts-tab'
import { LicensingUnavailableBanner } from '@/modules/publisher/components/licensing-unavailable-banner'
import { useAppPublisher } from '@/modules/publisher/hooks/use-publisher'
import { Banner } from './banner'
```

Inside `AppDetail`, after `const app = appQuery.data`:

```tsx
const publisher = useAppPublisher(appId)
```

Replace the `visibleTabs`/`tab` lines with:

```tsx
const visibleTabs = visibleAppTabs({ readOnly, isPublisher: publisher.isPublisher })
const tab: AppTab = visibleTabs.includes(tabParam as AppTab) ? (tabParam as AppTab) : 'overview'
const showLicensing = publisher.isPublisher && !readOnly
```

Directly above `<Tabs …>` add:

```tsx
{showLicensing && isLicensingTab(tab) && publisher.app && publisher.app.status !== 'ACTIVE' && (
  <LicensingUnavailableBanner status={publisher.app.status} />
)}
```

Make the tab bar scroll on narrow screens and use the labels — the `TabsList` and trigger become:

```tsx
<TabsList className="border-border h-auto w-full justify-start gap-6 overflow-x-auto rounded-none border-b bg-transparent p-0 [scrollbar-width:none]">
  {visibleTabs.map((t) => (
    <TabsTrigger
      key={t}
      value={t}
      className="data-[state=active]:border-b-foreground text-muted-foreground data-[state=active]:text-foreground dark:data-[state=active]:border-b-foreground -mb-px h-10 flex-none shrink-0 rounded-none border-0 border-b-2 border-transparent bg-transparent px-0 shadow-none data-[state=active]:bg-transparent data-[state=active]:shadow-none dark:data-[state=active]:bg-transparent"
    >
      {APP_TAB_LABEL[t]}
      {t === 'deployments' && deployments.length > 0 && (
        <span className="bg-muted text-muted-foreground rounded-full px-1.5 text-[10px] font-semibold">
          {deployments.length}
        </span>
      )}
    </TabsTrigger>
  ))}
</TabsList>
```

(`capitalize` is removed from the trigger class.) Before the Settings `TabsContent` add:

```tsx
{showLicensing && (
  <TabsContent value="artifacts">
    <ArtifactsTab appId={appId} />
  </TabsContent>
)}
```

- [ ] **Step 12: Run tests, typecheck, lint the touched files**

Run: `pnpm vitest run --config vitest.unit.config.ts modules/apps modules/publisher && pnpm tsc && pnpm eslint modules/apps modules/publisher modules/shared/test`
Expected: PASS, no type or lint errors.

- [ ] **Step 13: Commit**

```bash
git add modules/apps modules/publisher modules/shared/test
git commit -m "feat(apps): owner-only licensing tabs on the app page, starting with Artifacts"
```

---

### Task 4: Templates tab — list, create, details editor, "affects N environments"

**Files:**
- Create: `modules/publisher/lib/template.ts`
- Create: `modules/publisher/components/templates/templates-tab.tsx`, `template-card.tsx`, `mode-choice.tsx`, `create-template-dialog.tsx`, `template-editor.tsx`, `template-details-form.tsx`, `affects-confirm.tsx`, `delete-template-dialog.tsx`
- Modify: `modules/apps/components/app-detail.tsx` (append `'templates'`)
- Test: `modules/publisher/__tests__/template-lib.test.ts`, `affects-confirm.test.tsx`, `templates-tab.test.tsx`, `template-details-form.test.tsx`
- Modify: `modules/apps/__tests__/app-detail-tabs.test.tsx` (expected tab lists)

**Interfaces:**
- Consumes: `usePublisherTemplates`, `usePublisherTerms`, `useAddTemplate`, `useSetTemplateDetails`, `useDeleteTemplate` (Task 2); `TabHeader`, `TabSkeleton`, `EmptyState`, `TabError` (Task 3); `runWithToast`, `templateName`, `termName`, `envCountText` (Task 3); `useEnvironments`, `useViewer` from `@/modules/cloud/hooks/use-environment`; `CloudResourceSize` from `@/modules/cloud/types`.
- Produces:
  - `lib/template.ts`: `SERVICE_TYPES`, `NOT_PROVISIONABLE: Set<string>`, `SIZES: { value: CloudResourceSize; label: string }[]`, `describeService(s): string`, `describeTemplate(t): string`, `type TemplateForm = { name: string; mode: TemplateMode; sharedEnvironment: string; size: string; baseDomain: string; packageRegistry: string }`, `templateToForm(t): TemplateForm`, `templateDetailsInput(templateId, f): Omit<SetTemplateDetailsInput, 'appId'>`, `isTemplateFormDirty(t, f): boolean`, `sharedModeBlocker(t): string | null`.
  - `affects-confirm.tsx`: `useAffectsConfirm(environmentCount: number): { guard(title: string, run: () => Promise<unknown>): void; dialog: ReactNode }`, `affectsCopy(n): string`.
  - `template-editor.tsx`: `TemplateEditor({ appId, template, open, onClose })` with an extension point: it renders `<TemplateContents appId template guard />` from `./template-contents` (created in Task 5; this task creates the file with the SHARED explanation only — see Step 8).
  - `templates-tab.tsx`: `TemplatesTab({ appId })`.

- [ ] **Step 1: Write the failing template-lib tests**

`modules/publisher/__tests__/template-lib.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  describeTemplate,
  isTemplateFormDirty,
  sharedModeBlocker,
  templateDetailsInput,
  templateToForm,
} from '../lib/template'
import type { PublisherTemplate } from '../types'

const tpl = (over: Partial<PublisherTemplate> = {}): PublisherTemplate => ({
  id: 'tpl-1', name: 'Pro', mode: 'DEDICATED', sharedEnvironment: null, size: 'VETRA_AGENT_M',
  baseDomain: null, packageRegistry: null, services: [], packages: [], templateHash: 'h',
  environmentCount: 0, ...over,
})

describe('describeTemplate', () => {
  it('describes a shared template by where owners land', () => {
    expect(describeTemplate(tpl({ mode: 'SHARED' }))).toBe('Owners get an account on your App Environment.')
    expect(describeTemplate(tpl({ mode: 'SHARED', sharedEnvironment: 'env-9' }))).toBe(
      'Owners get an account on one shared environment.',
    )
  })

  it('asks for a service on an empty dedicated template', () => {
    expect(describeTemplate(tpl())).toBe('Nothing to run yet — add at least one service.')
  })

  it('reads a dedicated template as one sentence', () => {
    const t = tpl({
      services: [
        { id: 's1', type: 'FUSION', prefix: 'kv', artifactName: 'vault-app', artifactChannel: 'LATEST' },
        { id: 's2', type: 'SWITCHBOARD', prefix: null, artifactName: null, artifactChannel: null },
      ],
      packages: [{ id: 'p1', packageName: '@acme/vault', version: '1.2.0' }],
    })
    expect(describeTemplate(t)).toBe(
      'Each owner gets vault-app at kv, following latest release, SWITCHBOARD, with @acme/vault@1.2.0 installed.',
    )
  })
})

describe('template form', () => {
  it('round-trips a template into a full details input', () => {
    const t = tpl({ mode: 'SHARED', sharedEnvironment: 'env-9', size: null })
    const form = templateToForm(t)
    expect(form).toEqual({ name: 'Pro', mode: 'SHARED', sharedEnvironment: 'env-9', size: '', baseDomain: '', packageRegistry: '' })
    expect(isTemplateFormDirty(t, form)).toBe(false)
    expect(templateDetailsInput('tpl-1', { ...form, name: '  Pro 2 ' })).toEqual({
      templateId: 'tpl-1', name: 'Pro 2', mode: 'SHARED', sharedEnvironment: 'env-9',
      size: null, baseDomain: null, packageRegistry: null,
    })
  })

  it('drops the shared environment when the template is dedicated', () => {
    const input = templateDetailsInput('tpl-1', { ...templateToForm(tpl()), sharedEnvironment: 'env-9' })
    expect(input.sharedEnvironment).toBeNull()
  })

  it('treats whitespace-only edits as unchanged', () => {
    const t = tpl()
    expect(isTemplateFormDirty(t, { ...templateToForm(t), name: ' Pro ' })).toBe(false)
    expect(isTemplateFormDirty(t, { ...templateToForm(t), size: 'VETRA_AGENT_L' })).toBe(true)
  })

  it('blocks switching to shared while services or packages exist', () => {
    expect(sharedModeBlocker(tpl())).toBeNull()
    expect(sharedModeBlocker(tpl({ packages: [{ id: 'p', packageName: 'x', version: null }] }))).toMatch(
      /remove its services and packages/i,
    )
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm vitest run --config vitest.unit.config.ts modules/publisher/__tests__/template-lib.test.ts`
Expected: FAIL — cannot resolve `../lib/template`.

- [ ] **Step 3: Implement `modules/publisher/lib/template.ts`**

```ts
import type { CloudResourceSize } from '@/modules/cloud/types'
import type {
  PublisherTemplate,
  PublisherTemplateService,
  SetTemplateDetailsInput,
  TemplateMode,
} from '../types'
import { channelLabel } from './artifacts'

// Mirrors TemplateServiceType in the vetra-app document model. Anything else is
// rejected by input validation with a schema error a publisher cannot act on.
export const SERVICE_TYPES = [
  { value: 'CONNECT', label: 'Connect — the document app' },
  { value: 'SWITCHBOARD', label: 'Switchboard — the API' },
  { value: 'FUSION', label: 'Your app image' },
  { value: 'DOCLING', label: 'Docling — document parsing' },
  { value: 'PAPERLESS', label: 'Paperless — document archive' },
  { value: 'SPECKLE', label: 'Speckle — 3D models' },
  { value: 'CLINT', label: 'Clint — not available yet' },
] as const

export const NOT_PROVISIONABLE = new Set<string>(['CLINT'])

export const SIZES: { value: CloudResourceSize; label: string }[] = [
  { value: 'VETRA_AGENT_S', label: 'Small' },
  { value: 'VETRA_AGENT_M', label: 'Medium' },
  { value: 'VETRA_AGENT_L', label: 'Large' },
  { value: 'VETRA_AGENT_XL', label: 'Extra large' },
  { value: 'VETRA_AGENT_XXL', label: 'Double extra large' },
]

/** "vault-app at kv, following latest release". */
export function describeService(s: PublisherTemplateService): string {
  const where = s.prefix ? ` at ${s.prefix}` : ''
  if (!s.artifactName) return `${s.type}${where}`
  const follows = s.artifactChannel ? `, following ${channelLabel(s.artifactChannel).toLowerCase()}` : ''
  return `${s.artifactName}${where}${follows}`
}

/** The whole template as one sentence, so a publisher can check it at a glance. */
export function describeTemplate(t: PublisherTemplate): string {
  if (t.mode === 'SHARED') {
    return t.sharedEnvironment
      ? 'Owners get an account on one shared environment.'
      : 'Owners get an account on your App Environment.'
  }
  if (t.services.length === 0) return 'Nothing to run yet — add at least one service.'
  const services = t.services.map(describeService).join(', ')
  const packages = t.packages
    .map((p) => (p.packageName ? (p.version ? `${p.packageName}@${p.version}` : p.packageName) : null))
    .filter((x): x is string => x !== null)
  const withPackages = packages.length > 0 ? `, with ${packages.join(' and ')} installed` : ''
  return `Each owner gets ${services}${withPackages}.`
}

export type TemplateForm = {
  name: string
  mode: TemplateMode
  /** '' = the App Environment. */
  sharedEnvironment: string
  /** '' = the default size. */
  size: string
  baseDomain: string
  packageRegistry: string
}

export function templateToForm(t: PublisherTemplate): TemplateForm {
  return {
    name: t.name ?? '',
    mode: t.mode,
    sharedEnvironment: t.sharedEnvironment ?? '',
    size: t.size ?? '',
    baseDomain: t.baseDomain ?? '',
    packageRegistry: t.packageRegistry ?? '',
  }
}

const orNull = (v: string): string | null => v.trim() || null

/**
 * Always the full set of fields (decision D4): correct whether the server reads
 * an absent key as "unchanged" or as "clear".
 */
export function templateDetailsInput(
  templateId: string,
  f: TemplateForm,
): Omit<SetTemplateDetailsInput, 'appId'> {
  return {
    templateId,
    name: orNull(f.name),
    mode: f.mode,
    sharedEnvironment: f.mode === 'SHARED' ? orNull(f.sharedEnvironment) : null,
    size: orNull(f.size),
    baseDomain: orNull(f.baseDomain),
    packageRegistry: orNull(f.packageRegistry),
  }
}

export function isTemplateFormDirty(t: PublisherTemplate, f: TemplateForm): boolean {
  const next = templateDetailsInput(t.id, f)
  const current = templateDetailsInput(t.id, templateToForm(t))
  return (Object.keys(next) as Array<keyof typeof next>).some((k) => next[k] !== current[k])
}

/** The reducer refuses SHARED while services or packages exist; say so before trying. */
export function sharedModeBlocker(t: PublisherTemplate): string | null {
  return t.services.length > 0 || t.packages.length > 0
    ? 'Shared templates run nothing per owner. Remove its services and packages first.'
    : null
}
```

- [ ] **Step 4: Run the lib tests**

Run: `pnpm vitest run --config vitest.unit.config.ts modules/publisher/__tests__/template-lib.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing affects-confirm test**

`modules/publisher/__tests__/affects-confirm.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { affectsCopy, useAffectsConfirm } from '../components/templates/affects-confirm'

function Harness({ count, run }: { count: number; run: () => Promise<unknown> }) {
  const { guard, dialog } = useAffectsConfirm(count)
  return (
    <>
      <button onClick={() => guard('Save template changes?', run)}>save</button>
      {dialog}
    </>
  )
}

describe('useAffectsConfirm', () => {
  beforeEach(() => cleanup())

  it('words the count', () => {
    expect(affectsCopy(1)).toBe('This change re-applies to 1 running environment.')
    expect(affectsCopy(3)).toBe('This change re-applies to 3 running environments.')
  })

  it('runs straight away when no environment uses the template', async () => {
    const run = vi.fn().mockResolvedValue(true)
    render(<Harness count={0} run={run} />)
    await act(async () => fireEvent.click(screen.getByText('save')))
    expect(run).toHaveBeenCalledOnce()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('asks first, and Keep editing sends nothing', async () => {
    const run = vi.fn().mockResolvedValue(true)
    render(<Harness count={3} run={run} />)
    await act(async () => fireEvent.click(screen.getByText('save')))
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    expect(screen.getByText(/re-applies to 3 running environments/)).toBeTruthy()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Keep editing' })))
    expect(run).not.toHaveBeenCalled()
  })

  it('runs once after confirming', async () => {
    const run = vi.fn().mockResolvedValue(true)
    render(<Harness count={2} run={run} />)
    await act(async () => fireEvent.click(screen.getByText('save')))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Apply to 2 environments' })))
    expect(run).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 6: Implement `affects-confirm.tsx`**

`modules/publisher/components/templates/affects-confirm.tsx`:

```tsx
'use client'

import { useCallback, useState, type ReactNode } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/modules/shared/components/ui/alert-dialog'

export function affectsCopy(n: number): string {
  return n === 1
    ? 'This change re-applies to 1 running environment.'
    : `This change re-applies to ${n} running environments.`
}

type Pending = { title: string; run: () => Promise<unknown> }

/**
 * Every template write re-applies to all environments built from it, with no
 * staged rollout yet. When there are any, ask before sending.
 */
export function useAffectsConfirm(environmentCount: number): {
  guard: (title: string, run: () => Promise<unknown>) => void
  dialog: ReactNode
} {
  const [pending, setPending] = useState<Pending | null>(null)

  const guard = useCallback(
    (title: string, run: () => Promise<unknown>) => {
      if (environmentCount === 0) void run()
      else setPending({ title, run })
    },
    [environmentCount],
  )

  const confirm = () => {
    const p = pending
    setPending(null)
    if (p) void p.run()
  }

  const dialog = (
    <AlertDialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{pending?.title}</AlertDialogTitle>
          <AlertDialogDescription>
            {affectsCopy(environmentCount)} Every owner on this template gets it on the next
            provisioning pass, all at once.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep editing</AlertDialogCancel>
          <AlertDialogAction onClick={confirm}>
            Apply to {environmentCount === 1 ? '1 environment' : `${environmentCount} environments`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )

  return { guard, dialog }
}
```

- [ ] **Step 7: Run the affects-confirm tests**

Run: `pnpm vitest run --config vitest.unit.config.ts modules/publisher/__tests__/affects-confirm.test.tsx`
Expected: PASS.

- [ ] **Step 8: Write the failing tab and details-form tests**

`modules/publisher/__tests__/templates-tab.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import React from 'react'
import type { PublisherTemplate, PublisherTerm } from '../types'

let templates: { data?: PublisherTemplate[]; isPending: boolean; error: Error | null }
let terms: PublisherTerm[] = []
const addTemplate = vi.fn()
const deleteTemplate = vi.fn()

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../hooks/use-publisher', () => ({
  usePublisherTemplates: () => ({ ...templates, refetch: vi.fn(), isRefetching: false }),
  usePublisherTerms: () => ({ data: terms, isPending: false, error: null }),
}))
vi.mock('../hooks/use-publisher-mutations', () => ({
  useAddTemplate: () => ({ mutateAsync: addTemplate, isPending: false }),
  useDeleteTemplate: () => ({ mutateAsync: deleteTemplate, isPending: false }),
}))
// The editor has its own tests; here it only needs to say which template is open.
vi.mock('../components/templates/template-editor', () => ({
  TemplateEditor: ({ open, template }: { open: boolean; template: PublisherTemplate | null }) =>
    open ? <div data-testid="editor">{template ? template.id : 'loading'}</div> : null,
}))

import { TemplatesTab } from '../components/templates/templates-tab'

const tpl = (over: Partial<PublisherTemplate>): PublisherTemplate => ({
  id: 'tpl-1', name: 'Pro', mode: 'DEDICATED', sharedEnvironment: null, size: null, baseDomain: null,
  packageRegistry: null, services: [], packages: [], templateHash: 'h', environmentCount: 0, ...over,
})
const term = (over: Partial<PublisherTerm>): PublisherTerm => ({
  id: 'term-1', kind: '2026-pro', label: 'Pro', templateId: 'tpl-1', validityDays: null,
  issuers: ['PUBLISHER_GRANT'], status: 'ACTIVE', activeLicenses: 0, ...over,
})

describe('TemplatesTab', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    terms = []
  })

  it('invites a first template when there are none', () => {
    templates = { data: [], isPending: false, error: null }
    render(<TemplatesTab appId="app-1" />)
    expect(screen.getByText('No templates yet')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Create your first template' })).toBeTruthy()
  })

  it('shows mode, plan usage and environment count per template', () => {
    templates = {
      data: [tpl({ id: 'tpl-1', environmentCount: 3 }), tpl({ id: 'tpl-2', name: 'Free', mode: 'SHARED' })],
      isPending: false,
      error: null,
    }
    terms = [term({ templateId: 'tpl-1' })]
    render(<TemplatesTab appId="app-1" />)
    const pro = screen.getByTestId('template-tpl-1')
    expect(within(pro).getByText('Dedicated')).toBeTruthy()
    expect(within(pro).getByText('Used by Pro')).toBeTruthy()
    expect(within(pro).getByText('3 environments')).toBeTruthy()
    const free = screen.getByTestId('template-tpl-2')
    expect(within(free).getByText('Shared')).toBeTruthy()
    expect(within(free).getByText('Not used by a plan yet')).toBeTruthy()
  })

  it('cannot delete a template a plan still uses', () => {
    templates = { data: [tpl({})], isPending: false, error: null }
    terms = [term({})]
    render(<TemplatesTab appId="app-1" />)
    expect((screen.getByRole('button', { name: 'Delete Pro' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('creates a template and opens it in the editor', async () => {
    templates = { data: [tpl({ id: 'tpl-0' })], isPending: false, error: null }
    addTemplate.mockResolvedValue('tpl-new')
    render(<TemplatesTab appId="app-1" />)
    fireEvent.click(screen.getByRole('button', { name: 'New template' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Starter' } })
    fireEvent.click(screen.getByRole('radio', { name: /dedicated/i }))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Create template' })))
    expect(addTemplate).toHaveBeenCalledWith({ name: 'Starter', mode: 'DEDICATED' })
    expect(screen.getByTestId('editor').textContent).toBe('loading')
  })
})
```

`modules/publisher/__tests__/template-details-form.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import type { PublisherTemplate } from '../types'

const setDetails = vi.fn()
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../hooks/use-publisher-mutations', () => ({
  useSetTemplateDetails: () => ({ mutateAsync: setDetails, isPending: false }),
}))
vi.mock('@/modules/cloud/hooks/use-environment', () => ({
  useViewer: () => ({ viewer: { address: '0xme', isAdmin: false }, isLoading: false }),
  useEnvironments: () => ({
    environments: [{ id: 'env-9', name: 'Community', state: { label: 'Community', genericSubdomain: 'community' } }],
    isPending: false,
    isError: false,
  }),
}))
vi.mock('@/shared/components/ui/select', () => import('@/modules/shared/test/native-select'))

import { TemplateDetailsForm } from '../components/templates/template-details-form'

const tpl = (over: Partial<PublisherTemplate> = {}): PublisherTemplate => ({
  id: 'tpl-1', name: 'Pro', mode: 'DEDICATED', sharedEnvironment: null, size: null, baseDomain: null,
  packageRegistry: null, services: [], packages: [], templateHash: 'h', environmentCount: 0, ...over,
})

describe('TemplateDetailsForm', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('keeps Save disabled until something changes', () => {
    render(<TemplateDetailsForm appId="app-1" template={tpl()} guard={(_, run) => void run()} />)
    expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('sends every field through the guard', async () => {
    setDetails.mockResolvedValue(true)
    const guard = vi.fn((_: string, run: () => Promise<unknown>) => void run())
    render(<TemplateDetailsForm appId="app-1" template={tpl()} guard={guard} />)
    fireEvent.change(screen.getByLabelText('Size'), { target: { value: 'VETRA_AGENT_L' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save changes' })))
    expect(guard).toHaveBeenCalledWith('Save template changes?', expect.any(Function))
    expect(setDetails).toHaveBeenCalledWith({
      templateId: 'tpl-1', name: 'Pro', mode: 'DEDICATED', sharedEnvironment: null,
      size: 'VETRA_AGENT_L', baseDomain: null, packageRegistry: null,
    })
  })

  it('lets a shared template pick another of my environments', async () => {
    setDetails.mockResolvedValue(true)
    render(
      <TemplateDetailsForm appId="app-1" template={tpl({ mode: 'SHARED' })} guard={(_, run) => void run()} />,
    )
    fireEvent.change(screen.getByLabelText('Shared environment'), { target: { value: 'env-9' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save changes' })))
    expect(setDetails.mock.calls[0][0]).toMatchObject({ mode: 'SHARED', sharedEnvironment: 'env-9' })
  })

  it('explains why it cannot become shared while it runs services', () => {
    const t = tpl({ services: [{ id: 's', type: 'CONNECT', prefix: null, artifactName: null, artifactChannel: null }] })
    render(<TemplateDetailsForm appId="app-1" template={t} guard={(_, run) => void run()} />)
    expect((screen.getByRole('radio', { name: /shared/i }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/remove its services and packages first/i)).toBeTruthy()
  })
})
```

- [ ] **Step 9: Run to see them fail**

Run: `pnpm vitest run --config vitest.unit.config.ts modules/publisher/__tests__/templates-tab.test.tsx modules/publisher/__tests__/template-details-form.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 10: Implement `mode-choice.tsx`**

```tsx
'use client'

import { Server, Users } from 'lucide-react'
import { RadioGroup, RadioGroupItem } from '@/modules/shared/components/ui/radio-group'
import { cn } from '@/shared/lib/utils'
import type { TemplateMode } from '../../types'

const OPTIONS = [
  {
    value: 'SHARED' as const,
    icon: Users,
    title: 'Shared',
    body: 'Everyone gets an account on one environment you run. Good for free tiers and communities.',
  },
  {
    value: 'DEDICATED' as const,
    icon: Server,
    title: 'Dedicated',
    body: 'Every licence gets its own environment, built from the services and packages you pick.',
  },
]

export function ModeChoice({
  value,
  onChange,
  sharedDisabledReason,
}: {
  value: TemplateMode
  onChange: (mode: TemplateMode) => void
  sharedDisabledReason?: string | null
}) {
  return (
    <div className="space-y-2">
      <RadioGroup
        value={value}
        onValueChange={(v) => onChange(v as TemplateMode)}
        className="grid gap-3 sm:grid-cols-2"
        aria-label="Template type"
      >
        {OPTIONS.map((o) => {
          const disabled = o.value === 'SHARED' && !!sharedDisabledReason && value !== 'SHARED'
          return (
            <label
              key={o.value}
              className={cn(
                'border-border flex cursor-pointer gap-3 rounded-xl border p-4 transition-colors',
                value === o.value && 'border-primary bg-primary/5 ring-primary/30 ring-1',
                disabled && 'cursor-not-allowed opacity-60',
              )}
            >
              <RadioGroupItem value={o.value} disabled={disabled} aria-label={o.title} className="mt-1" />
              <span className="space-y-1">
                <span className="flex items-center gap-2 font-medium">
                  <o.icon className="h-4 w-4" aria-hidden />
                  {o.title}
                </span>
                <span className="text-muted-foreground block text-sm">{o.body}</span>
              </span>
            </label>
          )
        })}
      </RadioGroup>
      {sharedDisabledReason && value !== 'SHARED' && (
        <p className="text-muted-foreground text-xs">{sharedDisabledReason}</p>
      )}
    </div>
  )
}
```

- [ ] **Step 11: Implement `create-template-dialog.tsx`**

```tsx
'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { Loader2 } from 'lucide-react'
import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { Button } from '@/modules/shared/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/modules/shared/components/ui/dialog'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/modules/shared/components/ui/form'
import { Input } from '@/modules/shared/components/ui/input'
import { useAddTemplate } from '../../hooks/use-publisher-mutations'
import { runWithToast } from '../../lib/run'
import { ModeChoice } from './mode-choice'

const schema = z.object({
  name: z.string().trim().max(60, 'Keep it under 60 characters'),
  mode: z.enum(['SHARED', 'DEDICATED']),
})
type Values = z.infer<typeof schema>

export function CreateTemplateDialog({
  appId,
  open,
  onOpenChange,
  onCreated,
}: {
  appId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (templateId: string) => void
}) {
  const add = useAddTemplate(appId)
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { name: '', mode: 'SHARED' } })

  useEffect(() => {
    if (!open) form.reset()
  }, [open, form])

  const submit = async (v: Values) => {
    let id = ''
    const ok = await runWithToast(async () => {
      id = await add.mutateAsync({ name: v.name.trim() || null, mode: v.mode })
    }, 'Template created')
    if (ok) {
      onOpenChange(false)
      onCreated(id)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>New template</DialogTitle>
          <DialogDescription>
            Decide how owners use your app. You can add services and packages next.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(submit)} className="space-y-5">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. Community, Pro workspace" autoComplete="off" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="mode"
              render={({ field }) => <ModeChoice value={field.value} onChange={field.onChange} />}
            />
            <DialogFooter>
              <Button type="submit" disabled={add.isPending}>
                {add.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                Create template
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 12: Implement `template-details-form.tsx`**

```tsx
'use client'

import { ChevronDown, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { useEnvironments, useViewer } from '@/modules/cloud/hooks/use-environment'
import { Button } from '@/modules/shared/components/ui/button'
import { Input } from '@/modules/shared/components/ui/input'
import { Label } from '@/modules/shared/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/components/ui/select'
import { useSetTemplateDetails } from '../../hooks/use-publisher-mutations'
import { runWithToast } from '../../lib/run'
import {
  isTemplateFormDirty,
  SIZES,
  sharedModeBlocker,
  templateDetailsInput,
  templateToForm,
  type TemplateForm,
} from '../../lib/template'
import type { PublisherTemplate } from '../../types'
import { ModeChoice } from './mode-choice'

// Radix Select items cannot have value ''. These sentinels stand for "none".
const APP_ENVIRONMENT = '__app_environment__'
const DEFAULT_SIZE = '__default_size__'

type Guard = (title: string, run: () => Promise<unknown>) => void

export function TemplateDetailsForm({
  appId,
  template,
  guard,
}: {
  appId: string
  template: PublisherTemplate
  guard: Guard
}) {
  const setDetails = useSetTemplateDetails(appId)
  const { viewer } = useViewer()
  const { environments } = useEnvironments('MINE', viewer?.address ?? null)
  // The editor remounts this form (key) whenever the server's values change, so
  // initial state is enough — no syncing effect.
  const [form, setForm] = useState<TemplateForm>(() => templateToForm(template))
  const [advanced, setAdvanced] = useState(!!(template.baseDomain || template.packageRegistry))

  const set = <K extends keyof TemplateForm>(key: K, value: TemplateForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }))
  const dirty = isTemplateFormDirty(template, form)

  const save = () =>
    guard('Save template changes?', () =>
      runWithToast(() => setDetails.mutateAsync(templateDetailsInput(template.id, form)), 'Template saved'),
    )

  return (
    <section className="space-y-5" aria-label="Template details">
      <div className="space-y-1.5">
        <Label htmlFor="template-name">Name</Label>
        <Input id="template-name" value={form.name} onChange={(e) => set('name', e.target.value)} />
      </div>

      <ModeChoice
        value={form.mode}
        onChange={(mode) => set('mode', mode)}
        sharedDisabledReason={sharedModeBlocker(template)}
      />

      {form.mode === 'SHARED' ? (
        <div className="space-y-1.5">
          <Label>Shared environment</Label>
          <Select
            value={form.sharedEnvironment || APP_ENVIRONMENT}
            onValueChange={(v) => set('sharedEnvironment', v === APP_ENVIRONMENT ? '' : v)}
          >
            <SelectTrigger aria-label="Shared environment" className="w-full sm:w-80">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={APP_ENVIRONMENT}>App Environment (production)</SelectItem>
              {environments.map((e) => (
                <SelectItem key={e.id} value={e.id}>
                  {e.state.label || e.name || e.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-xs">
            Owners get an account here. Ending a licence never touches this environment.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Size</Label>
            <Select
              value={form.size || DEFAULT_SIZE}
              onValueChange={(v) => set('size', v === DEFAULT_SIZE ? '' : v)}
            >
              <SelectTrigger aria-label="Size" className="w-full sm:w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_SIZE}>Default</SelectItem>
                {SIZES.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
            onClick={() => setAdvanced((x) => !x)}
            aria-expanded={advanced}
          >
            <ChevronDown className={advanced ? 'h-4 w-4 rotate-180 transition-transform' : 'h-4 w-4 transition-transform'} />
            Advanced
          </button>
          {advanced && (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="template-domain">Base domain</Label>
                <Input
                  id="template-domain"
                  placeholder="vetra.io"
                  value={form.baseDomain}
                  onChange={(e) => set('baseDomain', e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="template-registry">Package registry</Label>
                <Input
                  id="template-registry"
                  placeholder="https://registry.vetra.io"
                  value={form.packageRegistry}
                  onChange={(e) => set('packageRegistry', e.target.value)}
                />
              </div>
            </div>
          )}
        </div>
      )}

      <div className="flex justify-end">
        <Button onClick={save} disabled={!dirty || setDetails.isPending}>
          {setDetails.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          Save changes
        </Button>
      </div>
    </section>
  )
}
```

- [ ] **Step 13: Implement `template-contents.tsx` (shared-only part; Task 5 extends it), `template-editor.tsx`, `template-card.tsx`, `delete-template-dialog.tsx`, `templates-tab.tsx`**

`modules/publisher/components/templates/template-contents.tsx`:

```tsx
'use client'

import { Info } from 'lucide-react'
import type { PublisherTemplate } from '../../types'

type Guard = (title: string, run: () => Promise<unknown>) => void

/** What each owner gets. Task 5 adds services and packages for DEDICATED templates. */
export function TemplateContents({
  template,
}: {
  appId: string
  template: PublisherTemplate
  guard: Guard
}) {
  if (template.mode === 'SHARED') {
    return (
      <p className="bg-muted text-muted-foreground flex gap-2 rounded-lg p-3 text-sm">
        <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        Shared templates do not start anything. Your app decides who gets in by checking whether
        someone holds a licence.
      </p>
    )
  }
  return null
}
```

`modules/publisher/components/templates/template-editor.tsx`:

```tsx
'use client'

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/modules/shared/components/ui/sheet'
import { describeTemplate, templateToForm } from '../../lib/template'
import { envCountText, templateName } from '../../lib/format'
import type { PublisherTemplate } from '../../types'
import { TabSkeleton } from '../primitives'
import { useAffectsConfirm } from './affects-confirm'
import { TemplateContents } from './template-contents'
import { TemplateDetailsForm } from './template-details-form'

/** Side sheet for one template. `template` is null right after create, until the list refetches. */
export function TemplateEditor({
  appId,
  template,
  open,
  onClose,
}: {
  appId: string
  template: PublisherTemplate | null
  open: boolean
  onClose: () => void
}) {
  const { guard, dialog } = useAffectsConfirm(template?.environmentCount ?? 0)
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>{template ? templateName(template) : 'New template'}</SheetTitle>
          <SheetDescription>
            {template && template.environmentCount > 0
              ? `${envCountText(template.environmentCount)} run on this template. Saving re-applies to all of them.`
              : 'Changes apply to every environment built from this template.'}
          </SheetDescription>
        </SheetHeader>
        {!template ? (
          <div className="px-4">
            <TabSkeleton rows={2} label="Loading template" />
          </div>
        ) : (
          <div className="space-y-8 px-4 pb-10">
            <p className="bg-muted rounded-lg px-3 py-2 text-sm" data-testid="template-summary">
              {describeTemplate(template)}
            </p>
            {/* Remount on any server-side change so the form shows what was saved. */}
            <TemplateDetailsForm
              key={JSON.stringify(templateToForm(template))}
              appId={appId}
              template={template}
              guard={guard}
            />
            <TemplateContents appId={appId} template={template} guard={guard} />
          </div>
        )}
        {dialog}
      </SheetContent>
    </Sheet>
  )
}
```

`modules/publisher/components/templates/template-card.tsx`:

```tsx
'use client'

import { Pencil, Server, Trash2, Users } from 'lucide-react'
import { Button } from '@/modules/shared/components/ui/button'
import { envCountText, templateName, termName } from '../../lib/format'
import { describeTemplate } from '../../lib/template'
import type { PublisherTemplate, PublisherTerm } from '../../types'

export function TemplateCard({
  template,
  usedBy,
  onEdit,
  onDelete,
}: {
  template: PublisherTemplate
  usedBy: PublisherTerm[]
  onEdit: () => void
  onDelete: () => void
}) {
  const name = templateName(template)
  const inUse = usedBy.length > 0
  const Icon = template.mode === 'SHARED' ? Users : Server
  return (
    <article
      data-testid={`template-${template.id}`}
      className="bg-card border-border flex flex-col gap-4 rounded-xl border p-5 shadow-sm"
    >
      <div className="flex items-start gap-3">
        <span className="bg-primary/10 text-primary flex h-10 w-10 shrink-0 items-center justify-center rounded-xl">
          <Icon className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate font-semibold">{name}</h3>
            <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs font-medium">
              {template.mode === 'SHARED' ? 'Shared' : 'Dedicated'}
            </span>
          </div>
          <p className="text-muted-foreground text-sm">{describeTemplate(template)}</p>
        </div>
      </div>
      <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <span>{inUse ? `Used by ${usedBy.map(termName).join(', ')}` : 'Not used by a plan yet'}</span>
        {template.mode === 'DEDICATED' && <span>{envCountText(template.environmentCount)}</span>}
      </div>
      <div className="border-border mt-auto flex gap-2 border-t pt-3">
        <Button size="sm" variant="outline" onClick={onEdit}>
          <Pencil className="h-3.5 w-3.5" />
          Edit
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={onDelete}
          disabled={inUse}
          title={inUse ? 'Move its plans to another template first' : undefined}
          aria-label={`Delete ${name}`}
          className="text-muted-foreground hover:text-destructive ml-auto"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </article>
  )
}
```

`modules/publisher/components/templates/delete-template-dialog.tsx`:

```tsx
'use client'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/modules/shared/components/ui/alert-dialog'
import { useDeleteTemplate } from '../../hooks/use-publisher-mutations'
import { templateName } from '../../lib/format'
import { runWithToast } from '../../lib/run'
import type { PublisherTemplate } from '../../types'

export function DeleteTemplateDialog({
  appId,
  template,
  onClose,
}: {
  appId: string
  template: PublisherTemplate | null
  onClose: () => void
}) {
  const del = useDeleteTemplate(appId)
  const confirm = async () => {
    if (!template) return
    const ok = await runWithToast(() => del.mutateAsync({ templateId: template.id }), 'Template deleted')
    if (ok) onClose()
  }
  return (
    <AlertDialog open={!!template} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {template ? templateName(template) : 'template'}?</AlertDialogTitle>
          <AlertDialogDescription>
            No plan uses it, so nobody loses anything. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={del.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={del.isPending}
            onClick={(e) => {
              e.preventDefault()
              void confirm()
            }}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            Delete template
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
```

`modules/publisher/components/templates/templates-tab.tsx`:

```tsx
'use client'

import { LayoutTemplate, Plus } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/modules/shared/components/ui/button'
import { usePublisherTemplates, usePublisherTerms } from '../../hooks/use-publisher'
import type { PublisherTemplate } from '../../types'
import { EmptyState, TabError, TabHeader, TabSkeleton } from '../primitives'
import { CreateTemplateDialog } from './create-template-dialog'
import { DeleteTemplateDialog } from './delete-template-dialog'
import { TemplateCard } from './template-card'
import { TemplateEditor } from './template-editor'

export function TemplatesTab({ appId }: { appId: string }) {
  const templates = usePublisherTemplates(appId)
  const terms = usePublisherTerms(appId)
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<PublisherTemplate | null>(null)

  const list = templates.data ?? []
  const editing = editingId ? (list.find((t) => t.id === editingId) ?? null) : null
  const usedBy = (id: string) => (terms.data ?? []).filter((t) => t.templateId === id)

  return (
    <div className="space-y-6">
      <TabHeader
        title="Templates"
        description="What an owner gets with a licence: an account on a shared environment, or an environment of their own."
        action={
          list.length > 0 && (
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" />
              New template
            </Button>
          )
        }
      />
      {templates.isPending ? (
        <TabSkeleton label="Loading templates" />
      ) : templates.error ? (
        <TabError error={templates.error} onRetry={() => void templates.refetch()} retrying={templates.isRefetching} />
      ) : list.length === 0 ? (
        <EmptyState
          icon={LayoutTemplate}
          title="No templates yet"
          action={
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" />
              Create your first template
            </Button>
          }
        >
          Start here. A template describes what people get; a plan then decides who gets it and for
          how long.
        </EmptyState>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {list.map((t) => (
            <TemplateCard
              key={t.id}
              template={t}
              usedBy={usedBy(t.id)}
              onEdit={() => setEditingId(t.id)}
              onDelete={() => setDeleting(t)}
            />
          ))}
        </div>
      )}
      <CreateTemplateDialog
        appId={appId}
        open={creating}
        onOpenChange={setCreating}
        onCreated={(id) => setEditingId(id)}
      />
      <TemplateEditor appId={appId} template={editing} open={editingId !== null} onClose={() => setEditingId(null)} />
      <DeleteTemplateDialog appId={appId} template={deleting} onClose={() => setDeleting(null)} />
    </div>
  )
}
```

The header's `New template` button is hidden on an empty list so the empty state's button is the single call to action.

- [ ] **Step 14: Wire the tab into the app page**

In `modules/apps/components/app-detail.tsx`: `LICENSING_TABS = ['artifacts', 'templates'] as const`, add `templates: 'Templates'` to `APP_TAB_LABEL`, import `TemplatesTab` from `@/modules/publisher/components/templates/templates-tab`, and add after the artifacts `TabsContent`:

```tsx
{showLicensing && (
  <TabsContent value="templates">
    <TemplatesTab appId={appId} />
  </TabsContent>
)}
```

In `modules/apps/__tests__/app-detail-tabs.test.tsx` add `vi.mock('@/modules/publisher/components/templates/templates-tab', () => ({ TemplatesTab: () => <div>templates-content</div> }))` and update the expected lists to include `'templates'` / `'Templates'` after artifacts.

- [ ] **Step 15: Run tests, typecheck, lint**

Run: `pnpm vitest run --config vitest.unit.config.ts modules/publisher modules/apps && pnpm tsc && pnpm eslint modules/publisher modules/apps`
Expected: PASS.

- [ ] **Step 16: Commit**

```bash
git add modules/publisher modules/apps
git commit -m "feat(publisher): templates tab with shared/dedicated editor and environment-impact confirmation"
```

---

### Task 5: Template services and packages with artifact pickers

**Files:**
- Create: `modules/publisher/components/templates/template-services.tsx`, `template-packages.tsx`
- Modify: `modules/publisher/components/templates/template-contents.tsx`
- Test: `modules/publisher/__tests__/template-services.test.tsx`, `template-packages.test.tsx`

**Interfaces:**
- Consumes: `useAddTemplateService`, `useRemoveTemplateService`, `useAddTemplatePackage`, `useRemoveTemplatePackage`, `usePublisherAppArtifacts` (Task 2); `SERVICE_TYPES`, `NOT_PROVISIONABLE`, `describeService` (Task 4); `CHANNELS`, `ChannelValue`, `NO_IMAGES_YET`, `NO_PACKAGES_YET` (Task 3); `runWithToast`; the `guard` from `useAffectsConfirm`.
- Produces: `TemplateServices({ appId, template, guard, artifacts, artifactsLoading })`, `TemplatePackages({ appId, template, guard, artifacts, artifactsLoading })`; `TemplateContents` now renders both for DEDICATED templates.

- [ ] **Step 1: Write the failing services test**

`modules/publisher/__tests__/template-services.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import type { PublisherAppArtifact, PublisherTemplate } from '../types'

const addService = vi.fn()
const removeService = vi.fn()
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../hooks/use-publisher-mutations', () => ({
  useAddTemplateService: () => ({ mutateAsync: addService, isPending: false }),
  useRemoveTemplateService: () => ({ mutateAsync: removeService, isPending: false }),
}))
vi.mock('@/shared/components/ui/select', () => import('@/modules/shared/test/native-select'))

import { TemplateServices } from '../components/templates/template-services'

const tpl = (over: Partial<PublisherTemplate> = {}): PublisherTemplate => ({
  id: 'tpl-1', name: 'Pro', mode: 'DEDICATED', sharedEnvironment: null, size: null, baseDomain: null,
  packageRegistry: null, services: [], packages: [], templateHash: 'h', environmentCount: 2, ...over,
})
const image: PublisherAppArtifact = {
  kind: 'FUSION_IMAGE', name: 'vault-app', versions: [{ version: '1.0.0', reference: 'sha' }], channels: [],
}

describe('TemplateServices', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('adds an app-image service following a channel, through the guard', async () => {
    addService.mockResolvedValue(true)
    const guard = vi.fn((_: string, run: () => Promise<unknown>) => void run())
    render(<TemplateServices appId="app-1" template={tpl()} guard={guard} artifacts={[image]} artifactsLoading={false} />)
    fireEvent.change(screen.getByLabelText('Service type'), { target: { value: 'FUSION' } })
    fireEvent.change(screen.getByLabelText('Image'), { target: { value: 'vault-app' } })
    fireEvent.change(screen.getByLabelText('Follows'), { target: { value: 'STAGING' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Add service' })))
    expect(guard).toHaveBeenCalledWith('Add this service?', expect.any(Function))
    expect(addService).toHaveBeenCalledWith({
      templateId: 'tpl-1', type: 'FUSION', prefix: 'vault-app', artifactName: 'vault-app', artifactChannel: 'STAGING',
    })
  })

  it('does not write when the guard holds the change back', async () => {
    const guard = vi.fn()
    render(<TemplateServices appId="app-1" template={tpl()} guard={guard} artifacts={[image]} artifactsLoading={false} />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Add service' })))
    expect(guard).toHaveBeenCalledOnce()
    expect(addService).not.toHaveBeenCalled()
  })

  it('explains a missing image instead of showing an empty picker', () => {
    render(<TemplateServices appId="app-1" template={tpl()} guard={vi.fn()} artifacts={[]} artifactsLoading={false} />)
    fireEvent.change(screen.getByLabelText('Service type'), { target: { value: 'FUSION' } })
    expect(screen.getByText(/has not published an app image yet/i)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Add service' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('removes a service through the guard', async () => {
    removeService.mockResolvedValue(true)
    const t = tpl({ services: [{ id: 's1', type: 'CONNECT', prefix: null, artifactName: null, artifactChannel: null }] })
    render(<TemplateServices appId="app-1" template={t} guard={(_, run) => void run()} artifacts={[]} artifactsLoading={false} />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Remove CONNECT service' })))
    expect(removeService).toHaveBeenCalledWith({ templateId: 'tpl-1', id: 's1' })
  })
})
```

`modules/publisher/__tests__/template-packages.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import type { PublisherAppArtifact, PublisherTemplate } from '../types'

const addPackage = vi.fn()
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../hooks/use-publisher-mutations', () => ({
  useAddTemplatePackage: () => ({ mutateAsync: addPackage, isPending: false }),
  useRemoveTemplatePackage: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))
vi.mock('@/shared/components/ui/select', () => import('@/modules/shared/test/native-select'))

import { TemplatePackages } from '../components/templates/template-packages'

const tpl: PublisherTemplate = {
  id: 'tpl-1', name: 'Pro', mode: 'DEDICATED', sharedEnvironment: null, size: null, baseDomain: null,
  packageRegistry: null, services: [], packages: [], templateHash: 'h', environmentCount: 0,
}
const pkg: PublisherAppArtifact = {
  kind: 'PACKAGE', name: '@acme/vault',
  versions: [{ version: '1.0.0', reference: 'a' }, { version: '1.1.0', reference: 'b' }], channels: [],
}

describe('TemplatePackages', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('offers versions newest first and sends the pick', async () => {
    addPackage.mockResolvedValue(true)
    render(<TemplatePackages appId="app-1" template={tpl} guard={(_, run) => void run()} artifacts={[pkg]} artifactsLoading={false} />)
    fireEvent.change(screen.getByLabelText('Package'), { target: { value: '@acme/vault' } })
    const versions = Array.from((screen.getByLabelText('Version') as HTMLSelectElement).options).map((o) => o.value)
    expect(versions).toEqual(['', '1.1.0', '1.0.0'])
    fireEvent.change(screen.getByLabelText('Version'), { target: { value: '1.0.0' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Add package' })))
    expect(addPackage).toHaveBeenCalledWith({ templateId: 'tpl-1', packageName: '@acme/vault', version: '1.0.0' })
  })

  it('sends no version for "latest"', async () => {
    addPackage.mockResolvedValue(true)
    render(<TemplatePackages appId="app-1" template={tpl} guard={(_, run) => void run()} artifacts={[pkg]} artifactsLoading={false} />)
    fireEvent.change(screen.getByLabelText('Package'), { target: { value: '@acme/vault' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Add package' })))
    expect(addPackage).toHaveBeenCalledWith({ templateId: 'tpl-1', packageName: '@acme/vault', version: null })
  })
})
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm vitest run --config vitest.unit.config.ts modules/publisher/__tests__/template-services.test.tsx modules/publisher/__tests__/template-packages.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `template-services.tsx`**

```tsx
'use client'

import { Loader2, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/modules/shared/components/ui/button'
import { Input } from '@/modules/shared/components/ui/input'
import { Label } from '@/modules/shared/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/components/ui/select'
import { useAddTemplateService, useRemoveTemplateService } from '../../hooks/use-publisher-mutations'
import { CHANNELS, NO_IMAGES_YET, type ChannelValue } from '../../lib/artifacts'
import { runWithToast } from '../../lib/run'
import { describeService, NOT_PROVISIONABLE, SERVICE_TYPES } from '../../lib/template'
import type { PublisherAppArtifact, PublisherTemplate } from '../../types'
import { SectionCard } from '../primitives'

type Guard = (title: string, run: () => Promise<unknown>) => void

export function TemplateServices({
  appId,
  template,
  guard,
  artifacts,
  artifactsLoading,
}: {
  appId: string
  template: PublisherTemplate
  guard: Guard
  artifacts: PublisherAppArtifact[]
  artifactsLoading: boolean
}) {
  const add = useAddTemplateService(appId)
  const remove = useRemoveTemplateService(appId)
  const [type, setType] = useState('CONNECT')
  const [prefix, setPrefix] = useState('')
  const [artifactName, setArtifactName] = useState('')
  const [channel, setChannel] = useState<ChannelValue>('LATEST')

  const images = artifacts.filter((a) => a.kind === 'FUSION_IMAGE')
  // Only an app-image service runs the app's own image; the server refuses an artifact on the rest.
  const wantsImage = type === 'FUSION'
  const noImages = wantsImage && !artifactsLoading && images.length === 0

  const submit = () =>
    guard('Add this service?', async () => {
      const ok = await runWithToast(
        () =>
          add.mutateAsync({
            templateId: template.id,
            type,
            prefix: prefix.trim() || null,
            artifactName: wantsImage && artifactName ? artifactName : null,
            artifactChannel: wantsImage && artifactName ? channel : null,
          }),
        'Service added',
      )
      if (ok) {
        setPrefix('')
        setArtifactName('')
      }
    })

  return (
    <SectionCard title="Services" description="What runs in every owner’s environment.">
      {template.services.length === 0 ? (
        <p className="text-muted-foreground text-sm">No services yet. Add at least one before a plan can use this template.</p>
      ) : (
        <ul className="divide-border divide-y text-sm">
          {template.services.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-2 py-2">
              <span className="min-w-0 truncate font-mono text-xs">
                {describeService(s)}
                {NOT_PROVISIONABLE.has(s.type) ? ' — not available yet' : ''}
              </span>
              <Button
                size="icon"
                variant="ghost"
                aria-label={`Remove ${s.type} service`}
                disabled={remove.isPending}
                onClick={() =>
                  guard('Remove this service?', () =>
                    runWithToast(() => remove.mutateAsync({ templateId: template.id, id: s.id }), 'Service removed'),
                  )
                }
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Service type</Label>
          <Select value={type} onValueChange={setType}>
            <SelectTrigger aria-label="Service type" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SERVICE_TYPES.map((t) => (
                <SelectItem key={t.value} value={t.value} disabled={NOT_PROVISIONABLE.has(t.value)}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="svc-prefix">Subdomain prefix (optional)</Label>
          <Input id="svc-prefix" value={prefix} onChange={(e) => setPrefix(e.target.value)} />
        </div>
        {wantsImage && (
          <>
            <div className="space-y-1.5">
              <Label>Image</Label>
              <Select
                value={artifactName}
                onValueChange={(v) => {
                  setArtifactName(v)
                  if (!prefix.trim()) setPrefix(v)
                }}
                disabled={images.length === 0}
              >
                <SelectTrigger aria-label="Image" className="w-full">
                  <SelectValue placeholder={artifactsLoading ? 'Loading…' : 'Pick an image'} />
                </SelectTrigger>
                <SelectContent>
                  {images.map((a) => (
                    <SelectItem key={a.name} value={a.name}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Follows</Label>
              <Select value={channel} onValueChange={(v) => setChannel(v as ChannelValue)} disabled={!artifactName}>
                <SelectTrigger aria-label="Follows" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CHANNELS.map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </>
        )}
      </div>
      {noImages && <p className="text-muted-foreground text-xs">{NO_IMAGES_YET}</p>}
      <div className="flex justify-end">
        <Button size="sm" onClick={submit} disabled={NOT_PROVISIONABLE.has(type) || noImages || add.isPending}>
          {add.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          Add service
        </Button>
      </div>
    </SectionCard>
  )
}
```

- [ ] **Step 4: Implement `template-packages.tsx`**

```tsx
'use client'

import { Loader2, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/modules/shared/components/ui/button'
import { Label } from '@/modules/shared/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/components/ui/select'
import { useAddTemplatePackage, useRemoveTemplatePackage } from '../../hooks/use-publisher-mutations'
import { NO_PACKAGES_YET } from '../../lib/artifacts'
import { runWithToast } from '../../lib/run'
import type { PublisherAppArtifact, PublisherTemplate } from '../../types'
import { SectionCard } from '../primitives'

type Guard = (title: string, run: () => Promise<unknown>) => void

export function TemplatePackages({
  appId,
  template,
  guard,
  artifacts,
  artifactsLoading,
}: {
  appId: string
  template: PublisherTemplate
  guard: Guard
  artifacts: PublisherAppArtifact[]
  artifactsLoading: boolean
}) {
  const add = useAddTemplatePackage(appId)
  const remove = useRemoveTemplatePackage(appId)
  const [name, setName] = useState('')
  const [version, setVersion] = useState('')

  const published = artifacts.filter((a) => a.kind === 'PACKAGE')
  const noPackages = !artifactsLoading && published.length === 0
  // Newest first: the version a publisher wants is almost always the newest.
  const versions = [...(published.find((a) => a.name === name)?.versions ?? [])].reverse()

  const submit = () =>
    guard('Add this package?', async () => {
      const ok = await runWithToast(
        () => add.mutateAsync({ templateId: template.id, packageName: name, version: version || null }),
        'Package added',
      )
      if (ok) {
        setName('')
        setVersion('')
      }
    })

  return (
    <SectionCard title="Packages" description="Installed in every owner’s environment.">
      {template.packages.length === 0 ? (
        <p className="text-muted-foreground text-sm">No packages yet.</p>
      ) : (
        <ul className="divide-border divide-y">
          {template.packages.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-2 py-2">
              <span className="min-w-0 truncate font-mono text-xs">
                {p.packageName ?? '—'}
                {p.version ? `@${p.version}` : ' (latest)'}
              </span>
              <Button
                size="icon"
                variant="ghost"
                aria-label={`Remove ${p.packageName ?? 'package'}`}
                disabled={remove.isPending}
                onClick={() =>
                  guard('Remove this package?', () =>
                    runWithToast(() => remove.mutateAsync({ templateId: template.id, id: p.id }), 'Package removed'),
                  )
                }
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Package</Label>
          <Select
            value={name}
            onValueChange={(v) => {
              setName(v)
              setVersion('')
            }}
            disabled={published.length === 0}
          >
            <SelectTrigger aria-label="Package" className="w-full">
              <SelectValue placeholder={artifactsLoading ? 'Loading…' : 'Pick a package'} />
            </SelectTrigger>
            <SelectContent>
              {published.map((a) => (
                <SelectItem key={a.name} value={a.name}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Version</Label>
          <Select value={version} onValueChange={setVersion} disabled={!name}>
            <SelectTrigger aria-label="Version" className="w-full">
              <SelectValue placeholder="Always the latest" />
            </SelectTrigger>
            <SelectContent>
              {versions.map((v) => (
                <SelectItem key={v.version} value={v.version}>
                  {v.version}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {noPackages && <p className="text-muted-foreground text-xs">{NO_PACKAGES_YET}</p>}
      <div className="flex justify-end">
        <Button size="sm" onClick={submit} disabled={!name || add.isPending}>
          {add.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          Add package
        </Button>
      </div>
    </SectionCard>
  )
}
```

- [ ] **Step 5: Extend `template-contents.tsx`**

Replace the `return null` at the end and the props destructuring so DEDICATED templates render both sections:

```tsx
export function TemplateContents({
  appId,
  template,
  guard,
}: {
  appId: string
  template: PublisherTemplate
  guard: Guard
}) {
  const artifacts = usePublisherAppArtifacts(template.mode === 'DEDICATED' ? appId : null)
  if (template.mode === 'SHARED') {
    /* …the SHARED <p> from Task 4, unchanged… */
  }
  const list = artifacts.data ?? []
  return (
    <div className="space-y-6">
      <TemplateServices appId={appId} template={template} guard={guard} artifacts={list} artifactsLoading={artifacts.isLoading} />
      <TemplatePackages appId={appId} template={template} guard={guard} artifacts={list} artifactsLoading={artifacts.isLoading} />
    </div>
  )
}
```

with imports `usePublisherAppArtifacts` from `../../hooks/use-publisher`, `TemplateServices` from `./template-services`, `TemplatePackages` from `./template-packages`. (Write the SHARED branch out in full — it is the `<p>` block from Task 4 Step 13.)

- [ ] **Step 6: Run tests, typecheck, lint**

Run: `pnpm vitest run --config vitest.unit.config.ts modules/publisher && pnpm tsc && pnpm eslint modules/publisher`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add modules/publisher
git commit -m "feat(publisher): pick services and packages for a template from published artifacts"
```

---
### Task 6: Plans tab — terms with template, validity, issuers, publish and retire

"Plan" is the UI word for a term.

**Files:**
- Create: `modules/publisher/lib/plan.ts`
- Create: `modules/publisher/components/plans/plans-tab.tsx`, `plan-dialog.tsx`, `plan-status-dialog.tsx`, `plan-row.tsx`
- Modify: `modules/apps/components/app-detail.tsx` (append `'plans'`), `modules/apps/__tests__/app-detail-tabs.test.tsx`
- Test: `modules/publisher/__tests__/plan-lib.test.ts`, `plans-tab.test.tsx`, `plan-dialog.test.tsx`

**Interfaces:**
- Consumes: `usePublisherTerms`, `usePublisherTemplates`, `useAddTerm`, `useSetTermDetails`, `usePublishTerm`, `useRetireTerm` (Task 2); primitives, `termName`, `templateName`, `validityText`, `termStatusMeta`, `runWithToast` (Task 3); `slugify` from `@/modules/shared/lib/slug`.
- Produces:
  - `lib/plan.ts`: `ISSUER_OPTIONS`, `KIND_PATTERN`, `planSchema`, `type PlanForm`, `EMPTY_PLAN`, `termToForm(term)`, `planInput(form): Omit<AddTermInput, 'appId'>`, `planDetailsInput(term, form): Omit<SetTermDetailsInput, 'appId'>`, `kindFromLabel(label)`, `publishBlocker(term): string | null`, `issuerLabel(issuer)`.
  - `PlansTab({ appId })`; `PlanDialog({ appId, term: PublisherTerm | null, templates, open, onOpenChange })`.

- [ ] **Step 1: Write the failing plan-lib tests**

`modules/publisher/__tests__/plan-lib.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { kindFromLabel, planDetailsInput, planInput, planSchema, publishBlocker, termToForm } from '../lib/plan'
import type { PublisherTerm } from '../types'

const term = (over: Partial<PublisherTerm> = {}): PublisherTerm => ({
  id: 'term-1', kind: '2026-pro', label: 'Pro', templateId: 'tpl-1', validityDays: 30,
  issuers: ['PUBLISHER_GRANT'], status: 'DRAFT', activeLicenses: 0, ...over,
})

describe('plan lib', () => {
  it('suggests a kind from the label', () => {
    expect(kindFromLabel('Local-First Conf 2026')).toBe('local-first-conf-2026')
    expect(kindFromLabel('  Pro (monthly)! ')).toBe('pro-monthly')
  })

  it('validates kind and validity', () => {
    const ok = { label: '', kind: '2026-free', templateId: '', validityDays: '', issuers: [] }
    expect(planSchema.safeParse(ok).success).toBe(true)
    expect(planSchema.safeParse({ ...ok, kind: 'Free Tier' }).success).toBe(false)
    expect(planSchema.safeParse({ ...ok, validityDays: '0' }).success).toBe(false)
    expect(planSchema.safeParse({ ...ok, validityDays: '1.5' }).success).toBe(false)
    expect(planSchema.safeParse({ ...ok, validityDays: '365' }).success).toBe(true)
  })

  it('turns a form into an input with nulls for empty fields', () => {
    expect(planInput({ label: ' ', kind: '2026-free', templateId: '', validityDays: '', issuers: ['INVITE_CODE'] })).toEqual({
      kind: '2026-free', label: null, templateId: null, validityDays: null, issuers: ['INVITE_CODE'],
    })
  })

  it('never sends the kind of a published plan: licences carry it', () => {
    const published = term({ status: 'ACTIVE' })
    expect(planDetailsInput(published, termToForm(published))).not.toHaveProperty('kind')
    const draft = term()
    expect(planDetailsInput(draft, { ...termToForm(draft), kind: '2026-pro-v2' })).toMatchObject({ termId: 'term-1', kind: '2026-pro-v2' })
  })

  it('names what is missing before a plan can be published', () => {
    expect(publishBlocker(term({ templateId: null }))).toBe('Pick a template first.')
    expect(publishBlocker(term({ issuers: [] }))).toBe('Choose at least one way to hand it out.')
    expect(publishBlocker(term())).toBeNull()
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm vitest run --config vitest.unit.config.ts modules/publisher/__tests__/plan-lib.test.ts`
Expected: FAIL — cannot resolve `../lib/plan`.

- [ ] **Step 3: Implement `modules/publisher/lib/plan.ts`**

```ts
import { z } from 'zod'
import { slugify } from '@/modules/shared/lib/slug'
import type { AddTermInput, IssuerKind, PublisherTerm, SetTermDetailsInput } from '../types'

export const ISSUER_OPTIONS: { value: IssuerKind; label: string; hint: string; disabled?: boolean }[] = [
  { value: 'INVITE_CODE', label: 'Invite codes', hint: 'People redeem a code or link you share.' },
  { value: 'PUBLISHER_GRANT', label: 'Granted by you', hint: 'You add people by wallet address.' },
  { value: 'ACHRA_SUBSCRIPTION', label: 'Paid subscription', hint: 'Coming with Achra.', disabled: true },
]

export const issuerLabel = (issuer: string): string =>
  ISSUER_OPTIONS.find((o) => o.value === issuer)?.label ?? issuer

export const KIND_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/

export const planSchema = z.object({
  label: z.string().trim().max(80, 'Keep it under 80 characters'),
  kind: z
    .string()
    .trim()
    .regex(KIND_PATTERN, 'Use lowercase letters, numbers and dashes, e.g. 2026-free-tier'),
  templateId: z.string(),
  validityDays: z
    .string()
    .trim()
    .refine(
      (v) => v === '' || (/^\d+$/.test(v) && Number(v) > 0 && Number(v) <= 3650),
      'A whole number of days (up to 3650), or empty for no end date',
    ),
  issuers: z.array(z.enum(['INVITE_CODE', 'PUBLISHER_GRANT', 'ACHRA_SUBSCRIPTION'])),
})
export type PlanForm = z.infer<typeof planSchema>

export const EMPTY_PLAN: PlanForm = { label: '', kind: '', templateId: '', validityDays: '', issuers: ['INVITE_CODE'] }

export function termToForm(t: PublisherTerm): PlanForm {
  return {
    label: t.label ?? '',
    kind: t.kind,
    templateId: t.templateId ?? '',
    validityDays: t.validityDays == null ? '' : String(t.validityDays),
    issuers: [...t.issuers],
  }
}

export function planInput(f: PlanForm): Omit<AddTermInput, 'appId'> {
  const days = f.validityDays.trim()
  return {
    kind: f.kind.trim(),
    label: f.label.trim() || null,
    templateId: f.templateId || null,
    validityDays: days ? Number(days) : null,
    issuers: f.issuers,
  }
}

/**
 * Every editable field (decision D4), except `kind` once the plan has left DRAFT:
 * licences carry the kind, and the reducer refuses to change it (KindImmutableError).
 */
export function planDetailsInput(t: PublisherTerm, f: PlanForm): Omit<SetTermDetailsInput, 'appId'> {
  const { kind, ...rest } = planInput(f)
  return t.status === 'DRAFT' ? { termId: t.id, kind, ...rest } : { termId: t.id, ...rest }
}

export function kindFromLabel(label: string): string {
  return slugify(label)
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 63)
}

/** Mirrors the reducer's TermIncompleteError so the button can say why before the server does. */
export function publishBlocker(t: Pick<PublisherTerm, 'templateId' | 'issuers'>): string | null {
  if (!t.templateId) return 'Pick a template first.'
  if (t.issuers.length === 0) return 'Choose at least one way to hand it out.'
  return null
}
```

- [ ] **Step 4: Run the lib tests**

Run: `pnpm vitest run --config vitest.unit.config.ts modules/publisher/__tests__/plan-lib.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing tab and dialog tests**

`modules/publisher/__tests__/plans-tab.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import React from 'react'
import type { PublisherTemplate, PublisherTerm } from '../types'

let terms: PublisherTerm[] = []
const publish = vi.fn()
const retire = vi.fn()
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../hooks/use-publisher', () => ({
  usePublisherTerms: () => ({ data: terms, isPending: false, error: null, refetch: vi.fn() }),
  usePublisherTemplates: () => ({
    data: [{ id: 'tpl-1', name: 'Workspace', mode: 'DEDICATED' } as PublisherTemplate],
    isPending: false,
    error: null,
  }),
}))
vi.mock('../hooks/use-publisher-mutations', () => ({
  usePublishTerm: () => ({ mutateAsync: publish, isPending: false }),
  useRetireTerm: () => ({ mutateAsync: retire, isPending: false }),
  useAddTerm: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSetTermDetails: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))

import { PlansTab } from '../components/plans/plans-tab'

const term = (over: Partial<PublisherTerm>): PublisherTerm => ({
  id: 'term-1', kind: '2026-pro', label: 'Pro', templateId: 'tpl-1', validityDays: 30,
  issuers: ['PUBLISHER_GRANT', 'INVITE_CODE'], status: 'DRAFT', activeLicenses: 0, ...over,
})

describe('PlansTab', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('points at templates when there are no plans', () => {
    terms = []
    render(<PlansTab appId="app-1" />)
    expect(screen.getByText('No plans yet')).toBeTruthy()
  })

  it('summarises a plan in one row', () => {
    terms = [term({ status: 'ACTIVE', activeLicenses: 12 })]
    render(<PlansTab appId="app-1" />)
    const row = screen.getByTestId('plan-term-1')
    expect(within(row).getByText('Pro')).toBeTruthy()
    expect(within(row).getByText('2026-pro')).toBeTruthy()
    expect(within(row).getByText('Published')).toBeTruthy()
    expect(within(row).getByText('Workspace')).toBeTruthy()
    expect(within(row).getByText('30 days')).toBeTruthy()
    expect(within(row).getByText('Granted by you, Invite codes')).toBeTruthy()
    expect(within(row).getByText('12 active licences')).toBeTruthy()
  })

  it('explains why a draft cannot be published yet', () => {
    terms = [term({ templateId: null })]
    render(<PlansTab appId="app-1" />)
    const row = screen.getByTestId('plan-term-1')
    expect((within(row).getByRole('button', { name: 'Publish' }) as HTMLButtonElement).disabled).toBe(true)
    expect(within(row).getByText('Pick a template first.')).toBeTruthy()
  })

  it('publishes after confirmation', async () => {
    terms = [term({})]
    publish.mockResolvedValue(true)
    render(<PlansTab appId="app-1" />)
    fireEvent.click(within(screen.getByTestId('plan-term-1')).getByRole('button', { name: 'Publish' }))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Publish plan' })))
    expect(publish).toHaveBeenCalledWith({ termId: 'term-1' })
  })

  it('retires a published plan after confirmation, keeping existing holders', async () => {
    terms = [term({ status: 'ACTIVE' })]
    retire.mockResolvedValue(true)
    render(<PlansTab appId="app-1" />)
    fireEvent.click(within(screen.getByTestId('plan-term-1')).getByRole('button', { name: 'Retire' }))
    expect(screen.getByText(/existing licences run until they end/i)).toBeTruthy()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retire plan' })))
    expect(retire).toHaveBeenCalledWith({ termId: 'term-1' })
  })
})
```

`modules/publisher/__tests__/plan-dialog.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import type { PublisherTemplate, PublisherTerm } from '../types'

const addTerm = vi.fn()
const setTerm = vi.fn()
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../hooks/use-publisher-mutations', () => ({
  useAddTerm: () => ({ mutateAsync: addTerm, isPending: false }),
  useSetTermDetails: () => ({ mutateAsync: setTerm, isPending: false }),
}))
vi.mock('@/shared/components/ui/select', () => import('@/modules/shared/test/native-select'))

import { PlanDialog } from '../components/plans/plan-dialog'

const templates = [{ id: 'tpl-1', name: 'Workspace', mode: 'DEDICATED' } as PublisherTemplate]

describe('PlanDialog', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('creates a plan, deriving the kind from the label until the kind is edited', async () => {
    addTerm.mockResolvedValue('term-1')
    render(<PlanDialog appId="app-1" term={null} templates={templates} open onOpenChange={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Conference 2026' } })
    expect((screen.getByLabelText('Kind') as HTMLInputElement).value).toBe('conference-2026')
    fireEvent.change(screen.getByLabelText('Template'), { target: { value: 'tpl-1' } })
    fireEvent.change(screen.getByLabelText('Valid for (days)'), { target: { value: '30' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /granted by you/i }))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Create plan' })))
    expect(addTerm).toHaveBeenCalledWith({
      kind: 'conference-2026', label: 'Conference 2026', templateId: 'tpl-1', validityDays: 30,
      issuers: ['INVITE_CODE', 'PUBLISHER_GRANT'],
    })
  })

  it('locks the kind of a published plan', () => {
    const term: PublisherTerm = {
      id: 'term-1', kind: '2026-pro', label: 'Pro', templateId: 'tpl-1', validityDays: null,
      issuers: ['INVITE_CODE'], status: 'ACTIVE', activeLicenses: 3,
    }
    render(<PlanDialog appId="app-1" term={term} templates={templates} open onOpenChange={vi.fn()} />)
    expect((screen.getByLabelText('Kind') as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByText(/existing licences carry it/i)).toBeTruthy()
  })

  it('rejects a kind with spaces', async () => {
    render(<PlanDialog appId="app-1" term={null} templates={templates} open onOpenChange={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'Free Tier' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Create plan' })))
    expect(screen.getByText(/lowercase letters, numbers and dashes/i)).toBeTruthy()
    expect(addTerm).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 6: Run to see them fail**

Run: `pnpm vitest run --config vitest.unit.config.ts modules/publisher/__tests__/plans-tab.test.tsx modules/publisher/__tests__/plan-dialog.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 7: Implement `plan-dialog.tsx`**

```tsx
'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { Button } from '@/modules/shared/components/ui/button'
import { Checkbox } from '@/modules/shared/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/modules/shared/components/ui/dialog'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/modules/shared/components/ui/form'
import { Input } from '@/modules/shared/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/components/ui/select'
import { useAddTerm, useSetTermDetails } from '../../hooks/use-publisher-mutations'
import { templateName } from '../../lib/format'
import {
  EMPTY_PLAN,
  ISSUER_OPTIONS,
  kindFromLabel,
  planDetailsInput,
  planInput,
  planSchema,
  termToForm,
  type PlanForm,
} from '../../lib/plan'
import { runWithToast } from '../../lib/run'
import type { PublisherTemplate, PublisherTerm } from '../../types'

const NO_TEMPLATE = '__no_template__'

export function PlanDialog({
  appId,
  term,
  templates,
  open,
  onOpenChange,
}: {
  appId: string
  /** null = create a new plan. */
  term: PublisherTerm | null
  templates: PublisherTemplate[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const add = useAddTerm(appId)
  const update = useSetTermDetails(appId)
  const form = useForm<PlanForm>({
    resolver: zodResolver(planSchema),
    defaultValues: term ? termToForm(term) : EMPTY_PLAN,
  })
  const [kindTouched, setKindTouched] = useState(!!term)
  const kindLocked = !!term && term.status !== 'DRAFT'
  const busy = add.isPending || update.isPending

  useEffect(() => {
    if (open) {
      form.reset(term ? termToForm(term) : EMPTY_PLAN)
    }
  }, [open, term, form])

  const submit = async (values: PlanForm) => {
    const ok = term
      ? await runWithToast(() => update.mutateAsync(planDetailsInput(term, values)), 'Plan saved')
      : await runWithToast(() => add.mutateAsync(planInput(values)), 'Plan created')
    if (ok) onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{term ? 'Edit plan' : 'New plan'}</DialogTitle>
          <DialogDescription>
            A plan decides which template people get, for how long, and how they can get it.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(submit)} className="space-y-5">
            <FormField
              control={form.control}
              name="label"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g. Free, Pro, Local-First Conf 2026"
                      autoComplete="off"
                      {...field}
                      onChange={(e) => {
                        field.onChange(e)
                        if (!kindTouched) form.setValue('kind', kindFromLabel(e.target.value))
                      }}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="kind"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Kind</FormLabel>
                  <FormControl>
                    <Input
                      className="font-mono"
                      autoComplete="off"
                      spellCheck={false}
                      disabled={kindLocked}
                      {...field}
                      onChange={(e) => {
                        setKindTouched(true)
                        field.onChange(e)
                      }}
                    />
                  </FormControl>
                  <FormDescription>
                    {kindLocked
                      ? 'Published plans keep their kind: existing licences carry it.'
                      : 'The id licences carry. Lowercase, numbers and dashes.'}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="templateId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Template</FormLabel>
                  <Select
                    value={field.value || NO_TEMPLATE}
                    onValueChange={(v) => field.onChange(v === NO_TEMPLATE ? '' : v)}
                  >
                    <FormControl>
                      <SelectTrigger aria-label="Template" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value={NO_TEMPLATE}>Not chosen yet</SelectItem>
                      {templates.map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          {templateName(t)} ({t.mode === 'SHARED' ? 'shared' : 'dedicated'})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="validityDays"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Valid for (days)</FormLabel>
                  <FormControl>
                    <Input inputMode="numeric" placeholder="No end date" className="w-40" {...field} />
                  </FormControl>
                  <FormDescription>Counted from the day someone gets the licence.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="issuers"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>How people get it</FormLabel>
                  <div className="space-y-2">
                    {ISSUER_OPTIONS.map((o) => {
                      const checked = field.value.includes(o.value)
                      return (
                        <label
                          key={o.value}
                          className="border-border flex items-start gap-3 rounded-lg border p-3 data-[disabled=true]:opacity-60"
                          data-disabled={o.disabled ? 'true' : 'false'}
                        >
                          <Checkbox
                            checked={checked}
                            disabled={o.disabled}
                            aria-label={o.label}
                            onCheckedChange={(next) =>
                              field.onChange(
                                next === true
                                  ? [...field.value, o.value]
                                  : field.value.filter((v) => v !== o.value),
                              )
                            }
                          />
                          <span className="space-y-0.5">
                            <span className="block text-sm font-medium">{o.label}</span>
                            <span className="text-muted-foreground block text-xs">{o.hint}</span>
                          </span>
                        </label>
                      )
                    })}
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="submit" disabled={busy}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                {term ? 'Save plan' : 'Create plan'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
```

Note: `form.reset` inside the effect does not trip `react-hooks/set-state-in-effect` (it is not a `useState` setter) — the same pattern exists in today's grant dialog. `setKindTouched` is set only from event handlers. When the dialog reopens for a different term, the parent passes `key={term?.id ?? 'new'}` (Step 9) so `kindTouched` starts fresh.

- [ ] **Step 8: Implement `plan-status-dialog.tsx` and `plan-row.tsx`**

`modules/publisher/components/plans/plan-status-dialog.tsx`:

```tsx
'use client'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/modules/shared/components/ui/alert-dialog'
import { usePublishTerm, useRetireTerm } from '../../hooks/use-publisher-mutations'
import { termName } from '../../lib/format'
import { runWithToast } from '../../lib/run'
import type { PublisherTerm } from '../../types'

export type PlanStatusAction = { action: 'publish' | 'retire'; term: PublisherTerm }

export function PlanStatusDialog({
  appId,
  pending,
  onClose,
}: {
  appId: string
  pending: PlanStatusAction | null
  onClose: () => void
}) {
  const publish = usePublishTerm(appId)
  const retire = useRetireTerm(appId)
  const busy = publish.isPending || retire.isPending
  const name = pending ? termName(pending.term) : ''
  const isRetire = pending?.action === 'retire'

  const confirm = async () => {
    if (!pending) return
    const ok = isRetire
      ? await runWithToast(() => retire.mutateAsync({ termId: pending.term.id }), `${name} retired`)
      : await runWithToast(() => publish.mutateAsync({ termId: pending.term.id }), `${name} is live`)
    if (ok) onClose()
  }

  return (
    <AlertDialog open={!!pending} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{isRetire ? `Retire ${name}?` : `Publish ${name}?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {isRetire
              ? 'Nobody new can get this plan. Existing licences run until they end.'
              : pending?.term.status === 'RETIRED'
                ? 'People can get this plan again, through the ways you chose.'
                : 'People can get this plan through the ways you chose. Its kind is fixed from now on.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            onClick={(e) => {
              e.preventDefault()
              void confirm()
            }}
          >
            {isRetire ? 'Retire plan' : 'Publish plan'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
```

`modules/publisher/components/plans/plan-row.tsx`:

```tsx
'use client'

import { Pencil } from 'lucide-react'
import { StatusPill } from '@/modules/apps/components/status'
import { Button } from '@/modules/shared/components/ui/button'
import { templateName, termName, validityText } from '../../lib/format'
import { issuerLabel, publishBlocker } from '../../lib/plan'
import { termStatusMeta } from '../../lib/status'
import type { PublisherTemplate, PublisherTerm } from '../../types'

export function PlanRow({
  term,
  template,
  onEdit,
  onPublish,
  onRetire,
}: {
  term: PublisherTerm
  template: PublisherTemplate | undefined
  onEdit: () => void
  onPublish: () => void
  onRetire: () => void
}) {
  const blocker = term.status !== 'ACTIVE' ? publishBlocker(term) : null
  return (
    <li data-testid={`plan-${term.id}`} className="flex flex-col gap-4 p-5 lg:flex-row lg:items-center">
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-semibold">{termName(term)}</h3>
          <code className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-xs">{term.kind}</code>
          <StatusPill meta={termStatusMeta(term.status)} />
        </div>
        <dl className="text-muted-foreground grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs">Template</dt>
            <dd className="text-foreground">{template ? templateName(template) : 'Not chosen yet'}</dd>
          </div>
          <div>
            <dt className="text-xs">Valid for</dt>
            <dd className="text-foreground">{validityText(term.validityDays)}</dd>
          </div>
          <div>
            <dt className="text-xs">Given out by</dt>
            <dd className="text-foreground">
              {term.issuers.length ? term.issuers.map(issuerLabel).join(', ') : 'Nobody yet'}
            </dd>
          </div>
          <div>
            <dt className="text-xs">Holders</dt>
            <dd className="text-foreground">
              {term.activeLicenses === 1 ? '1 active licence' : `${term.activeLicenses} active licences`}
            </dd>
          </div>
        </dl>
        {blocker && <p className="text-warning text-xs">{blocker}</p>}
      </div>
      <div className="flex shrink-0 gap-2">
        <Button size="sm" variant="outline" onClick={onEdit}>
          <Pencil className="h-3.5 w-3.5" />
          Edit
        </Button>
        {term.status === 'ACTIVE' ? (
          <Button size="sm" variant="outline" onClick={onRetire}>
            Retire
          </Button>
        ) : (
          <Button size="sm" onClick={onPublish} disabled={!!blocker}>
            Publish
          </Button>
        )}
      </div>
    </li>
  )
}
```

- [ ] **Step 9: Implement `plans-tab.tsx`**

```tsx
'use client'

import { Plus, Tags } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'
import { Button } from '@/modules/shared/components/ui/button'
import { usePublisherTemplates, usePublisherTerms } from '../../hooks/use-publisher'
import type { PublisherTerm } from '../../types'
import { EmptyState, TabError, TabHeader, TabSkeleton } from '../primitives'
import { PlanDialog } from './plan-dialog'
import { PlanRow } from './plan-row'
import { PlanStatusDialog, type PlanStatusAction } from './plan-status-dialog'

export function PlansTab({ appId }: { appId: string }) {
  const terms = usePublisherTerms(appId)
  const templates = usePublisherTemplates(appId)
  const [editing, setEditing] = useState<{ term: PublisherTerm | null } | null>(null)
  const [status, setStatus] = useState<PlanStatusAction | null>(null)
  const list = terms.data ?? []
  const templateList = templates.data ?? []
  const noTemplates = !templates.isPending && templateList.length === 0

  return (
    <div className="space-y-6">
      <TabHeader
        title="Plans"
        description="What you offer: a template, for how long, handed out by invite code or by you."
        action={
          list.length > 0 && (
            <Button onClick={() => setEditing({ term: null })}>
              <Plus className="h-4 w-4" />
              New plan
            </Button>
          )
        }
      />
      {terms.isPending ? (
        <TabSkeleton label="Loading plans" />
      ) : terms.error ? (
        <TabError error={terms.error} onRetry={() => void terms.refetch()} />
      ) : list.length === 0 ? (
        <EmptyState
          icon={Tags}
          title="No plans yet"
          action={
            noTemplates ? (
              <Button asChild variant="outline">
                <Link href="?tab=templates">Create a template first</Link>
              </Button>
            ) : (
              <Button onClick={() => setEditing({ term: null })}>
                <Plus className="h-4 w-4" />
                Create your first plan
              </Button>
            )
          }
        >
          A plan is what people actually get, like “Free” or “Conference 2026”. It points at a
          template and says how long it lasts.
        </EmptyState>
      ) : (
        <ul className="bg-card border-border divide-border divide-y rounded-xl border shadow-sm">
          {list.map((t) => (
            <PlanRow
              key={t.id}
              term={t}
              template={templateList.find((x) => x.id === t.templateId)}
              onEdit={() => setEditing({ term: t })}
              onPublish={() => setStatus({ action: 'publish', term: t })}
              onRetire={() => setStatus({ action: 'retire', term: t })}
            />
          ))}
        </ul>
      )}
      <PlanDialog
        key={editing?.term?.id ?? 'new'}
        appId={appId}
        term={editing?.term ?? null}
        templates={templateList}
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
      />
      <PlanStatusDialog appId={appId} pending={status} onClose={() => setStatus(null)} />
    </div>
  )
}
```

- [ ] **Step 10: Wire the tab into the app page**

In `app-detail.tsx`: `LICENSING_TABS = ['artifacts', 'templates', 'plans'] as const`, `plans: 'Plans'` in `APP_TAB_LABEL`, import `PlansTab` from `@/modules/publisher/components/plans/plans-tab`, add its `TabsContent value="plans"` after templates (same `showLicensing &&` pattern). Update `app-detail-tabs.test.tsx`: mock `@/modules/publisher/components/plans/plans-tab` and add `'plans'`/`'Plans'` to expected lists.

- [ ] **Step 11: Run tests, typecheck, lint**

Run: `pnpm vitest run --config vitest.unit.config.ts modules/publisher modules/apps && pnpm tsc && pnpm eslint modules/publisher modules/apps`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add modules/publisher modules/apps
git commit -m "feat(publisher): plans tab to define, publish and retire what an app offers"
```

---

### Task 7: Holders tab — licences with environments, grant, change plan, revoke, allow list

**Files:**
- Create: `modules/publisher/lib/holders.ts`
- Create: `modules/publisher/components/holders/holders-tab.tsx`, `holders-table.tsx`, `grant-dialog.tsx`, `change-plan-dialog.tsx`, `revoke-dialog.tsx`, `allow-list-card.tsx`
- Modify: `modules/apps/components/app-detail.tsx` (append `'holders'`), `modules/apps/__tests__/app-detail-tabs.test.tsx`
- Test: `modules/publisher/__tests__/holders-lib.test.ts`, `holders-tab.test.tsx`, `grant-dialog.test.tsx`, `allow-list-card.test.tsx`

**Interfaces:**
- Consumes: `usePublisherLicenses`, `usePublisherEnvironments`, `usePublisherTerms`, `usePublisherTemplates`, `usePublisherAllowList`, `useIssueGrant`, `useReplaceGrant`, `useRevokeLicense`, `useAddToAllowList`, `useRemoveFromAllowList` (Task 2); primitives, format, status, `runWithToast` (Task 3); `CopyButton`, `StatusPill` from `modules/apps`.
- Produces:
  - `lib/holders.ts`: `USER_PATTERN`, `addressOf(user): string | null`, `sameUser(a, b): boolean`, `type HolderRow = PublisherLicense & { environment: PublisherEnvironment | null }`, `joinHolders(licenses, environments): HolderRow[]`, `LICENSE_FILTERS`, `type LicenseFilter`, `filterHolders(rows, { status, kind, query }): HolderRow[]`, `liveLicenseOf(licenses, user): PublisherLicense | undefined`, `isOnAllowList(entries, user): boolean`, `grantablePlans(terms): PublisherTerm[]`, `modeOfKind(kind, terms, templates): TemplateMode | null`.
  - `HoldersTab({ appId })`.

- [ ] **Step 1: Write the failing holders-lib tests**

`modules/publisher/__tests__/holders-lib.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  addressOf,
  filterHolders,
  grantablePlans,
  isOnAllowList,
  joinHolders,
  liveLicenseOf,
  modeOfKind,
  sameUser,
  USER_PATTERN,
} from '../lib/holders'
import type { PublisherEnvironment, PublisherLicense, PublisherTemplate, PublisherTerm } from '../types'

const A = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01'
const lic = (over: Partial<PublisherLicense>): PublisherLicense => ({
  id: 'l1', user: `did:pkh:eip155:1:${A.toLowerCase()}`, kind: 'pro', issuer: 'PUBLISHER_GRANT',
  status: 'ACTIVE', start: '2026-10-01T00:00:00Z', end: null, environmentId: 'env-1', replacedBy: null, ...over,
})
const env = (over: Partial<PublisherEnvironment>): PublisherEnvironment => ({
  environmentId: 'env-1', user: 'u', licenseId: 'l1', rootLicenseId: 'l1', label: 'Acme', templateHash: 'h',
  stoppedAt: null, deleteAfter: null, ...over,
})

describe('users', () => {
  it('accepts exactly a 0x address or a did:pkh on eip155', () => {
    expect(USER_PATTERN.test(A)).toBe(true)
    expect(USER_PATTERN.test(`did:pkh:eip155:137:${A}`)).toBe(true)
    expect(USER_PATTERN.test('did:key:z6Mk')).toBe(false)
    expect(USER_PATTERN.test(`${A} `)).toBe(false)
  })

  it('compares a bare address with a did:pkh case-insensitively', () => {
    expect(addressOf(A)).toBe(A.toLowerCase())
    expect(sameUser(A, `did:pkh:eip155:1:${A.toLowerCase()}`)).toBe(true)
    expect(sameUser('did:key:z1', 'did:key:z1')).toBe(true)
    expect(sameUser('did:key:z1', A)).toBe(false)
  })
})

describe('joinHolders', () => {
  it('attaches the environment by licence id, else by environment id', () => {
    const rows = joinHolders(
      [lic({ id: 'l1' }), lic({ id: 'l2', environmentId: 'env-2' }), lic({ id: 'l3', environmentId: null })],
      [env({ licenseId: 'l1' }), env({ environmentId: 'env-2', licenseId: 'old' })],
    )
    expect(rows.find((r) => r.id === 'l1')?.environment?.environmentId).toBe('env-1')
    expect(rows.find((r) => r.id === 'l2')?.environment?.environmentId).toBe('env-2')
    expect(rows.find((r) => r.id === 'l3')?.environment).toBeNull()
  })

  it('puts live licences first, newest first', () => {
    const rows = joinHolders(
      [
        lic({ id: 'old', status: 'EXPIRED', start: '2026-01-01T00:00:00Z' }),
        lic({ id: 'a', start: '2026-09-01T00:00:00Z' }),
        lic({ id: 'b', status: 'ISSUED', start: null }),
      ],
      [],
    )
    expect(rows.map((r) => r.id)).toEqual(['b', 'a', 'old'])
  })
})

describe('filters and checks', () => {
  const rows = joinHolders([lic({ id: 'l1' }), lic({ id: 'l2', status: 'REVOKED', kind: 'free', user: 'did:pkh:eip155:1:0x1111111111111111111111111111111111111111' })], [])

  it('filters by status, plan and a search over the DID', () => {
    expect(filterHolders(rows, { status: 'REVOKED', kind: 'ALL', query: '' }).map((r) => r.id)).toEqual(['l2'])
    expect(filterHolders(rows, { status: 'ALL', kind: 'pro', query: '' }).map((r) => r.id)).toEqual(['l1'])
    expect(filterHolders(rows, { status: 'ALL', kind: 'ALL', query: '0x1111' }).map((r) => r.id)).toEqual(['l2'])
    expect(filterHolders(rows, { status: 'ALL', kind: 'ALL', query: 'ABCDEF' }).map((r) => r.id)).toEqual(['l1'])
  })

  it('finds a live licence and allow-list membership whatever the address form', () => {
    expect(liveLicenseOf([lic({})], A)?.id).toBe('l1')
    expect(liveLicenseOf([lic({ status: 'EXPIRED' })], A)).toBeUndefined()
    expect(isOnAllowList([{ user: A.toLowerCase(), addedAt: 'x' }], `did:pkh:eip155:1:${A}`)).toBe(true)
  })

  it('offers only published plans a publisher may grant', () => {
    const t = (over: Partial<PublisherTerm>): PublisherTerm => ({
      id: 'x', kind: 'k', label: null, templateId: 't', validityDays: null, issuers: ['PUBLISHER_GRANT'],
      status: 'ACTIVE', activeLicenses: 0, ...over,
    })
    const plans = [t({ id: 'a' }), t({ id: 'b', status: 'DRAFT' }), t({ id: 'c', issuers: ['INVITE_CODE'] })]
    expect(grantablePlans(plans).map((p) => p.id)).toEqual(['a'])
  })

  it('knows whether a kind provisions its own environment', () => {
    const terms = [{ kind: 'pro', templateId: 'tpl-1' } as PublisherTerm]
    const templates = [{ id: 'tpl-1', mode: 'DEDICATED' } as PublisherTemplate]
    expect(modeOfKind('pro', terms, templates)).toBe('DEDICATED')
    expect(modeOfKind('gone', terms, templates)).toBeNull()
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm vitest run --config vitest.unit.config.ts modules/publisher/__tests__/holders-lib.test.ts`
Expected: FAIL — cannot resolve `../lib/holders`.

- [ ] **Step 3: Implement `modules/publisher/lib/holders.ts`**

```ts
import type {
  PublisherAllowListEntry,
  PublisherEnvironment,
  PublisherLicense,
  PublisherTemplate,
  PublisherTerm,
  TemplateMode,
} from '../types'

/** What the server accepts for `user`; every other DID method is refused (UNSUPPORTED_DID). */
export const USER_PATTERN = /^(0x[0-9a-fA-F]{40}|did:pkh:eip155:\d+:0x[0-9a-fA-F]{40})$/

const PKH = /^did:pkh:eip155:\d+:(0x[0-9a-fA-F]{40})$/i

/** Lowercased wallet address behind a DID or bare address; null for other DIDs. */
export function addressOf(user: string): string | null {
  const trimmed = user.trim()
  const fromPkh = PKH.exec(trimmed)?.[1]
  if (fromPkh) return fromPkh.toLowerCase()
  return /^0x[0-9a-fA-F]{40}$/.test(trimmed) ? trimmed.toLowerCase() : null
}

export function sameUser(a: string, b: string): boolean {
  const aa = addressOf(a)
  const bb = addressOf(b)
  if (aa && bb) return aa === bb
  return a.trim() === b.trim()
}

export type HolderRow = PublisherLicense & { environment: PublisherEnvironment | null }

const LIVE = new Set(['ISSUED', 'ACTIVE'])
const isLive = (l: Pick<PublisherLicense, 'status'>) => LIVE.has(l.status)

export function joinHolders(
  licenses: PublisherLicense[],
  environments: PublisherEnvironment[],
): HolderRow[] {
  const rows = licenses.map((l) => ({
    ...l,
    environment:
      environments.find((e) => e.licenseId === l.id) ??
      (l.environmentId ? (environments.find((e) => e.environmentId === l.environmentId) ?? null) : null),
  }))
  const time = (s: string | null) => (s ? new Date(s).getTime() : Number.POSITIVE_INFINITY)
  return rows.sort((a, b) => {
    if (isLive(a) !== isLive(b)) return isLive(a) ? -1 : 1
    // `|| 0`: two open-ended starts give Infinity - Infinity = NaN.
    return time(b.start) - time(a.start) || 0
  })
}

export const LICENSE_FILTERS = ['ALL', 'ISSUED', 'ACTIVE', 'EXPIRED', 'REVOKED', 'REPLACED'] as const
export type LicenseFilter = (typeof LICENSE_FILTERS)[number]

export function filterHolders(
  rows: HolderRow[],
  { status, kind, query }: { status: LicenseFilter; kind: string; query: string },
): HolderRow[] {
  const q = query.trim().toLowerCase()
  return rows.filter(
    (r) =>
      (status === 'ALL' || r.status === status) &&
      (kind === 'ALL' || r.kind === kind) &&
      (q === '' || r.user.toLowerCase().includes(q) || (r.environment?.label ?? '').toLowerCase().includes(q)),
  )
}

export function liveLicenseOf(licenses: PublisherLicense[], user: string): PublisherLicense | undefined {
  return licenses.find((l) => isLive(l) && sameUser(l.user, user))
}

export function isOnAllowList(entries: PublisherAllowListEntry[], user: string): boolean {
  return entries.some((e) => sameUser(e.user, user))
}

/** Published plans that allow a publisher grant — the only ones issueGrant/replaceGrant accept. */
export function grantablePlans(terms: PublisherTerm[]): PublisherTerm[] {
  return terms.filter((t) => t.status === 'ACTIVE' && t.issuers.includes('PUBLISHER_GRANT'))
}

export function modeOfKind(
  kind: string,
  terms: Pick<PublisherTerm, 'kind' | 'templateId'>[],
  templates: Pick<PublisherTemplate, 'id' | 'mode'>[],
): TemplateMode | null {
  const term = terms.find((t) => t.kind === kind)
  return templates.find((t) => t.id === term?.templateId)?.mode ?? null
}
```

- [ ] **Step 4: Run the lib tests**

Run: `pnpm vitest run --config vitest.unit.config.ts modules/publisher/__tests__/holders-lib.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing component tests**

`modules/publisher/__tests__/grant-dialog.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import type { PublisherLicense, PublisherTemplate, PublisherTerm } from '../types'

const issueGrant = vi.fn()
const addToAllowList = vi.fn()
const toastError = vi.fn()
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: (...a: unknown[]) => toastError(...a) } }))
vi.mock('../hooks/use-publisher-mutations', () => ({
  useIssueGrant: () => ({ mutateAsync: issueGrant, isPending: false }),
  useAddToAllowList: () => ({ mutateAsync: addToAllowList, isPending: false }),
}))
vi.mock('@/shared/components/ui/select', () => import('@/modules/shared/test/native-select'))

import { GrantDialog } from '../components/holders/grant-dialog'
import { PublisherApiError } from '../graphql'

const A = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01'
const terms: PublisherTerm[] = [
  { id: 't1', kind: 'pro', label: 'Pro', templateId: 'tpl-1', validityDays: null, issuers: ['PUBLISHER_GRANT'], status: 'ACTIVE', activeLicenses: 0 },
  { id: 't2', kind: 'conf', label: 'Conf', templateId: 'tpl-1', validityDays: null, issuers: ['INVITE_CODE'], status: 'ACTIVE', activeLicenses: 0 },
]
const templates = [{ id: 'tpl-1', mode: 'DEDICATED' } as PublisherTemplate]

function renderDialog(licenses: PublisherLicense[] = [], allowList = [{ user: A.toLowerCase(), addedAt: 'x' }]) {
  return render(
    <GrantDialog appId="app-1" open onOpenChange={vi.fn()} licenses={licenses} terms={terms} templates={templates} allowList={allowList} />,
  )
}

describe('GrantDialog', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('offers only plans a publisher may grant', () => {
    renderDialog()
    const options = Array.from((screen.getByLabelText('Plan') as HTMLSelectElement).options).map((o) => o.textContent)
    expect(options).toEqual(['', 'Pro'])
  })

  it('refuses DIDs the server will refuse', async () => {
    renderDialog()
    fireEvent.change(screen.getByLabelText('Wallet address or DID'), { target: { value: 'did:key:z6Mk' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Grant licence' })))
    expect(screen.getByText(/0x wallet address or a did:pkh/i)).toBeTruthy()
    expect(issueGrant).not.toHaveBeenCalled()
  })

  it('grants with a project name for a dedicated plan', async () => {
    issueGrant.mockResolvedValue('lic-1')
    renderDialog()
    fireEvent.change(screen.getByLabelText('Wallet address or DID'), { target: { value: A } })
    fireEvent.change(screen.getByLabelText('Plan'), { target: { value: 'pro' } })
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Acme vault' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Grant licence' })))
    expect(addToAllowList).not.toHaveBeenCalled()
    expect(issueGrant).toHaveBeenCalledWith({ kind: 'pro', user: A, label: 'Acme vault' })
  })

  it('adds someone to the allow list first when they are not on it', async () => {
    issueGrant.mockResolvedValue('lic-1')
    addToAllowList.mockResolvedValue(true)
    renderDialog([], [])
    fireEvent.change(screen.getByLabelText('Wallet address or DID'), { target: { value: A } })
    expect(screen.getByText(/added to your allow list/i)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Plan'), { target: { value: 'pro' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Grant licence' })))
    expect(addToAllowList).toHaveBeenCalledWith({ user: A })
    expect(issueGrant).toHaveBeenCalledOnce()
    expect(addToAllowList.mock.invocationCallOrder[0]).toBeLessThan(issueGrant.mock.invocationCallOrder[0])
  })

  it('points to Change plan when they already hold a licence', () => {
    const live: PublisherLicense = {
      id: 'l1', user: `did:pkh:eip155:1:${A.toLowerCase()}`, kind: 'pro', issuer: 'PUBLISHER_GRANT',
      status: 'ACTIVE', start: null, end: null, environmentId: null, replacedBy: null,
    }
    renderDialog([live])
    fireEvent.change(screen.getByLabelText('Wallet address or DID'), { target: { value: A } })
    expect(screen.getByText(/already holds pro/i)).toBeTruthy()
  })

  it('shows the server sentence when the grant is refused', async () => {
    issueGrant.mockRejectedValue(new PublisherApiError('TERM_NOT_ISSUABLE', 'pro cannot be granted', 200))
    renderDialog()
    fireEvent.change(screen.getByLabelText('Wallet address or DID'), { target: { value: A } })
    fireEvent.change(screen.getByLabelText('Plan'), { target: { value: 'pro' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Grant licence' })))
    expect(toastError).toHaveBeenCalledWith('pro cannot be granted')
  })
})
```

`modules/publisher/__tests__/holders-tab.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import React from 'react'
import type { PublisherEnvironment, PublisherLicense, PublisherTemplate, PublisherTerm } from '../types'

let licenses: PublisherLicense[] = []
let environments: PublisherEnvironment[] = []
const replaceGrant = vi.fn()
const revoke = vi.fn()

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../hooks/use-publisher', () => ({
  usePublisherLicenses: () => ({ data: licenses, isPending: false, error: null, refetch: vi.fn() }),
  usePublisherEnvironments: () => ({ data: environments, isPending: false, error: null }),
  usePublisherTerms: () => ({
    data: [
      { id: 't1', kind: 'free', label: 'Free', templateId: 'tpl-s', validityDays: null, issuers: ['PUBLISHER_GRANT'], status: 'ACTIVE', activeLicenses: 1 },
      { id: 't2', kind: 'pro', label: 'Pro', templateId: 'tpl-d', validityDays: null, issuers: ['PUBLISHER_GRANT'], status: 'ACTIVE', activeLicenses: 1 },
    ] satisfies PublisherTerm[],
    isPending: false,
    error: null,
  }),
  usePublisherTemplates: () => ({
    data: [{ id: 'tpl-s', mode: 'SHARED' }, { id: 'tpl-d', mode: 'DEDICATED' }] as PublisherTemplate[],
    isPending: false,
    error: null,
  }),
  usePublisherAllowList: () => ({ data: [], isPending: false, error: null }),
}))
vi.mock('../hooks/use-publisher-mutations', () => ({
  useIssueGrant: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useReplaceGrant: () => ({ mutateAsync: replaceGrant, isPending: false }),
  useRevokeLicense: () => ({ mutateAsync: revoke, isPending: false }),
  useAddToAllowList: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRemoveFromAllowList: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))
vi.mock('@/shared/components/ui/select', () => import('@/modules/shared/test/native-select'))

import { HoldersTab } from '../components/holders/holders-tab'

const lic = (over: Partial<PublisherLicense>): PublisherLicense => ({
  id: 'l1', user: 'did:pkh:eip155:1:0xabcdef0123456789abcdef0123456789abcdef01', kind: 'pro',
  issuer: 'PUBLISHER_GRANT', status: 'ACTIVE', start: '2026-10-01T00:00:00Z', end: null,
  environmentId: 'env-1', replacedBy: null, ...over,
})

describe('HoldersTab', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    environments = []
  })

  it('invites a first grant when nobody holds a licence', () => {
    licenses = []
    render(<HoldersTab appId="app-1" />)
    expect(screen.getByText('Nobody holds a licence yet')).toBeTruthy()
  })

  it('links each holder’s environment and shows its offboarding dates', () => {
    licenses = [lic({ status: 'REVOKED' })]
    environments = [{
      environmentId: 'env-1', user: 'u', licenseId: 'l1', rootLicenseId: 'l1', label: 'Acme vault',
      templateHash: 'h', stoppedAt: '2026-10-20T00:00:00Z', deleteAfter: '2027-01-10T00:00:00Z',
    }]
    render(<HoldersTab appId="app-1" />)
    const row = screen.getByTestId('holder-l1')
    expect(within(row).getByRole('link', { name: 'Acme vault' }).getAttribute('href')).toBe('/user/environments/env-1')
    expect(within(row).getByText(/stopped/i)).toBeTruthy()
    expect(within(row).getByText(/deleted on/i)).toBeTruthy()
  })

  it('says a dedicated environment is on its way, and a shared plan has none of its own', () => {
    licenses = [lic({ id: 'l1', environmentId: null, status: 'ISSUED' }), lic({ id: 'l2', kind: 'free', environmentId: null })]
    render(<HoldersTab appId="app-1" />)
    expect(within(screen.getByTestId('holder-l1')).getByText('Being set up…')).toBeTruthy()
    expect(within(screen.getByTestId('holder-l2')).getByText('Shared environment')).toBeTruthy()
  })

  it('filters by status', () => {
    licenses = [lic({ id: 'l1' }), lic({ id: 'l2', status: 'EXPIRED' })]
    render(<HoldersTab appId="app-1" />)
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'EXPIRED' } })
    expect(screen.queryByTestId('holder-l1')).toBeNull()
    expect(screen.getByTestId('holder-l2')).toBeTruthy()
  })

  it('moves a holder to another plan in place', async () => {
    licenses = [lic({})]
    replaceGrant.mockResolvedValue('l9')
    render(<HoldersTab appId="app-1" />)
    fireEvent.click(within(screen.getByTestId('holder-l1')).getByRole('button', { name: 'Change plan' }))
    fireEvent.change(screen.getByLabelText('New plan'), { target: { value: 'free' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Move to Free' })))
    expect(replaceGrant).toHaveBeenCalledWith({ licenseId: 'l1', kind: 'free' })
  })

  it('revokes with an optional reason and tells what happens to the environment', async () => {
    licenses = [lic({})]
    revoke.mockResolvedValue(true)
    render(<HoldersTab appId="app-1" />)
    fireEvent.click(within(screen.getByTestId('holder-l1')).getByRole('button', { name: 'Revoke' }))
    expect(screen.getByText(/stops in 14 days/i)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Reason (optional)'), { target: { value: 'refund' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Revoke licence' })))
    expect(revoke).toHaveBeenCalledWith({ licenseId: 'l1', reason: 'refund' })
  })
})
```

`modules/publisher/__tests__/allow-list-card.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import React from 'react'

const add = vi.fn()
const remove = vi.fn()
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../hooks/use-publisher-mutations', () => ({
  useAddToAllowList: () => ({ mutateAsync: add, isPending: false }),
  useRemoveFromAllowList: () => ({ mutateAsync: remove, isPending: false }),
}))

import { AllowListCard } from '../components/holders/allow-list-card'

const A = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01'

describe('AllowListCard', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('adds a valid address and clears the field', async () => {
    add.mockResolvedValue(true)
    render(<AllowListCard appId="app-1" entries={[]} />)
    const input = screen.getByLabelText('Add to allow list') as HTMLInputElement
    fireEvent.change(input, { target: { value: ` ${A} ` } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Add' })))
    expect(add).toHaveBeenCalledWith({ user: A })
    expect(input.value).toBe('')
  })

  it('keeps Add disabled for anything the server would refuse', () => {
    render(<AllowListCard appId="app-1" entries={[]} />)
    fireEvent.change(screen.getByLabelText('Add to allow list'), { target: { value: 'hello' } })
    expect((screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('removes an entry', async () => {
    remove.mockResolvedValue(true)
    render(<AllowListCard appId="app-1" entries={[{ user: A, addedAt: '2026-10-01T00:00:00Z' }]} />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: `Remove ${A} from the allow list` })))
    expect(remove).toHaveBeenCalledWith({ user: A })
  })
})
```

- [ ] **Step 6: Run to see them fail**

Run: `pnpm vitest run --config vitest.unit.config.ts modules/publisher/__tests__/grant-dialog.test.tsx modules/publisher/__tests__/holders-tab.test.tsx modules/publisher/__tests__/allow-list-card.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 7: Implement `grant-dialog.tsx`**

```tsx
'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { Info, Loader2 } from 'lucide-react'
import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { Alert, AlertDescription, AlertTitle } from '@/modules/shared/components/ui/alert'
import { Button } from '@/modules/shared/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/modules/shared/components/ui/dialog'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/modules/shared/components/ui/form'
import { Input } from '@/modules/shared/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/components/ui/select'
import { useAddToAllowList, useIssueGrant } from '../../hooks/use-publisher-mutations'
import { termName } from '../../lib/format'
import { grantablePlans, isOnAllowList, liveLicenseOf, modeOfKind, USER_PATTERN } from '../../lib/holders'
import { runWithToast } from '../../lib/run'
import type {
  PublisherAllowListEntry,
  PublisherLicense,
  PublisherTemplate,
  PublisherTerm,
} from '../../types'

const schema = z.object({
  user: z.string().trim().regex(USER_PATTERN, 'Enter a 0x wallet address or a did:pkh:eip155 DID'),
  kind: z.string().min(1, 'Choose a plan'),
  label: z.string().trim().max(60, 'Keep it under 60 characters'),
})
type Values = z.infer<typeof schema>

export function GrantDialog({
  appId,
  open,
  onOpenChange,
  licenses,
  terms,
  templates,
  allowList,
}: {
  appId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Every licence of the app (unfiltered), for the "already holds" check. */
  licenses: PublisherLicense[]
  terms: PublisherTerm[]
  templates: PublisherTemplate[]
  allowList: PublisherAllowListEntry[]
}) {
  const issue = useIssueGrant(appId)
  const allow = useAddToAllowList(appId)
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { user: '', kind: '', label: '' } })
  const plans = grantablePlans(terms)
  const user = form.watch('user').trim()
  const kind = form.watch('kind')
  const validUser = USER_PATTERN.test(user)
  const existing = validUser ? liveLicenseOf(licenses, user) : undefined
  const needsAllowList = validUser && !isOnAllowList(allowList, user)
  const dedicated = modeOfKind(kind, terms, templates) === 'DEDICATED'
  const busy = issue.isPending || allow.isPending

  useEffect(() => {
    if (!open) form.reset()
  }, [open, form])

  const submit = async (v: Values) => {
    const ok = await runWithToast(async () => {
      // The server only grants to people on the allow list (NOT_ON_ALLOW_LIST).
      if (needsAllowList) await allow.mutateAsync({ user: v.user.trim() })
      await issue.mutateAsync({
        kind: v.kind,
        user: v.user.trim(),
        label: dedicated ? v.label.trim() || null : null,
      })
    }, 'Licence granted')
    if (ok) onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Grant a licence</DialogTitle>
          <DialogDescription>Give someone one of your published plans.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(submit)} className="space-y-4">
            <FormField
              control={form.control}
              name="user"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Wallet address or DID</FormLabel>
                  <FormControl>
                    <Input placeholder="0x… or did:pkh:eip155:1:0x…" autoComplete="off" spellCheck={false} className="font-mono" {...field} />
                  </FormControl>
                  {needsAllowList && (
                    <FormDescription className="flex items-center gap-1.5">
                      <Info className="h-3.5 w-3.5" aria-hidden />
                      Not on your allow list yet — they will be added to your allow list when you grant.
                    </FormDescription>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="kind"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Plan</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger aria-label="Plan" className="w-full">
                        <SelectValue placeholder={plans.length ? 'Choose a plan' : 'No plan allows grants yet'} />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {plans.map((t) => (
                        <SelectItem key={t.id} value={t.kind}>
                          {termName(t)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {plans.length === 0 && (
                    <FormDescription>Publish a plan with “Granted by you” switched on first.</FormDescription>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />
            {dedicated && (
              <FormField
                control={form.control}
                name="label"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Project name</FormLabel>
                    <FormControl>
                      <Input placeholder="Shown as their environment’s name" autoComplete="off" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            {existing && (
              <Alert>
                <AlertTitle>Already holds {termName(terms.find((t) => t.kind === existing.kind) ?? { label: null, kind: existing.kind })}</AlertTitle>
                <AlertDescription>
                  Granting gives them a second licence and a second environment. To move them to
                  another plan and keep their environment, use “Change plan” on their row.
                </AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button type="submit" disabled={busy || plans.length === 0}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                Grant licence
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
```

The test `points to Change plan` expects `/already holds pro/i`; with term `Pro` the title reads "Already holds Pro" — the case-insensitive regex matches.

- [ ] **Step 8: Implement `change-plan-dialog.tsx` and `revoke-dialog.tsx`**

`modules/publisher/components/holders/change-plan-dialog.tsx`:

```tsx
'use client'

import { Loader2 } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/modules/shared/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/modules/shared/components/ui/dialog'
import { Label } from '@/modules/shared/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/components/ui/select'
import { useReplaceGrant } from '../../hooks/use-publisher-mutations'
import { shortDid, termName } from '../../lib/format'
import { grantablePlans } from '../../lib/holders'
import { runWithToast } from '../../lib/run'
import type { PublisherLicense, PublisherTerm } from '../../types'

/** Upgrade or downgrade in place: the new licence inherits the environment. */
export function ChangePlanDialog({
  appId,
  license,
  terms,
  onClose,
}: {
  appId: string
  license: PublisherLicense | null
  terms: PublisherTerm[]
  onClose: () => void
}) {
  const replace = useReplaceGrant(appId)
  const [kind, setKind] = useState('')
  const options = grantablePlans(terms).filter((t) => t.kind !== license?.kind)
  const target = options.find((t) => t.kind === kind)

  const close = () => {
    setKind('')
    onClose()
  }
  const submit = async () => {
    if (!license || !target) return
    const ok = await runWithToast(
      () => replace.mutateAsync({ licenseId: license.id, kind: target.kind }),
      `Moved to ${termName(target)}`,
    )
    if (ok) close()
  }

  return (
    <Dialog open={!!license} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change plan</DialogTitle>
          <DialogDescription>
            {license ? `${shortDid(license.user)} keeps their environment. It is rebuilt from the new plan’s template.` : ''}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label>New plan</Label>
          <Select value={kind} onValueChange={setKind}>
            <SelectTrigger aria-label="New plan" className="w-full">
              <SelectValue placeholder={options.length ? 'Choose a plan' : 'No other plan allows grants'} />
            </SelectTrigger>
            <SelectContent>
              {options.map((t) => (
                <SelectItem key={t.id} value={t.kind}>
                  {termName(t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={!target || replace.isPending}>
            {replace.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {target ? `Move to ${termName(target)}` : 'Move'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

`modules/publisher/components/holders/revoke-dialog.tsx`:

```tsx
'use client'

import { Loader2 } from 'lucide-react'
import { useState } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/modules/shared/components/ui/alert-dialog'
import { Input } from '@/modules/shared/components/ui/input'
import { useRevokeLicense } from '../../hooks/use-publisher-mutations'
import { shortDid } from '../../lib/format'
import { runWithToast } from '../../lib/run'
import type { PublisherLicense, TemplateMode } from '../../types'

export function RevokeDialog({
  appId,
  license,
  mode,
  onClose,
}: {
  appId: string
  license: PublisherLicense | null
  mode: TemplateMode | null
  onClose: () => void
}) {
  const revoke = useRevokeLicense(appId)
  const [reason, setReason] = useState('')
  const close = () => {
    setReason('')
    onClose()
  }
  const confirm = async () => {
    if (!license) return
    const ok = await runWithToast(
      () => revoke.mutateAsync({ licenseId: license.id, reason: reason.trim() || null }),
      'Licence revoked',
    )
    if (ok) close()
  }
  return (
    <AlertDialog open={!!license} onOpenChange={(o) => !o && close()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke {license ? shortDid(license.user) : ''}’s licence?</AlertDialogTitle>
          <AlertDialogDescription>
            {mode === 'SHARED'
              ? 'They lose access to your app right away.'
              : 'Their environment stops in 14 days and is deleted about three months later, unless they get a new licence first.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-1.5">
          <label htmlFor="revoke-reason" className="text-sm font-medium">
            Reason (optional)
          </label>
          <Input id="revoke-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={revoke.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={revoke.isPending}
            onClick={(e) => {
              e.preventDefault()
              void confirm()
            }}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {revoke.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Revoke licence
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
```

- [ ] **Step 9: Implement `allow-list-card.tsx`**

```tsx
'use client'

import { Loader2, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Button } from '@/modules/shared/components/ui/button'
import { Input } from '@/modules/shared/components/ui/input'
import { formatDate } from '@/modules/apps/lib/time'
import { useAddToAllowList, useRemoveFromAllowList } from '../../hooks/use-publisher-mutations'
import { shortDid } from '../../lib/format'
import { USER_PATTERN } from '../../lib/holders'
import { runWithToast } from '../../lib/run'
import type { PublisherAllowListEntry } from '../../types'
import { SectionCard } from '../primitives'

export function AllowListCard({ appId, entries }: { appId: string; entries: PublisherAllowListEntry[] }) {
  const add = useAddToAllowList(appId)
  const remove = useRemoveFromAllowList(appId)
  const [user, setUser] = useState('')
  const valid = USER_PATTERN.test(user.trim())

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!valid) return
    const ok = await runWithToast(() => add.mutateAsync({ user: user.trim() }), 'Added to the allow list')
    if (ok) setUser('')
  }

  return (
    <SectionCard
      title="Allow list"
      description="You can only grant licences to people on this list. Granting adds them automatically."
    >
      <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row">
        <Input
          aria-label="Add to allow list"
          placeholder="0x… or did:pkh:eip155:1:0x…"
          className="font-mono"
          value={user}
          onChange={(e) => setUser(e.target.value)}
        />
        <Button type="submit" variant="outline" disabled={!valid || add.isPending}>
          {add.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          Add
        </Button>
      </form>
      {entries.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nobody on the list yet.</p>
      ) : (
        <ul className="divide-border divide-y text-sm">
          {entries.map((e) => (
            <li key={e.user} className="flex items-center gap-3 py-2">
              <span className="min-w-0 flex-1 truncate font-mono text-xs" title={e.user}>
                {shortDid(e.user)}
              </span>
              <span className="text-muted-foreground hidden text-xs sm:inline">Added {formatDate(e.addedAt)}</span>
              <Button
                size="icon"
                variant="ghost"
                aria-label={`Remove ${e.user} from the allow list`}
                disabled={remove.isPending}
                onClick={() => void runWithToast(() => remove.mutateAsync({ user: e.user }), 'Removed from the allow list')}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  )
}
```

- [ ] **Step 10: Implement `holders-table.tsx` and `holders-tab.tsx`**

`modules/publisher/components/holders/holders-table.tsx`:

```tsx
'use client'

import { Loader2 } from 'lucide-react'
import Link from 'next/link'
import { CopyButton } from '@/modules/apps/components/copy-button'
import { StatusPill } from '@/modules/apps/components/status'
import { formatDate } from '@/modules/apps/lib/time'
import { Button } from '@/modules/shared/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/modules/shared/components/ui/table'
import { dateRange, shortDid, termName } from '../../lib/format'
import type { HolderRow } from '../../lib/holders'
import { licenseStatusMeta } from '../../lib/status'
import type { PublisherTerm, TemplateMode } from '../../types'

function EnvironmentCell({ row, mode }: { row: HolderRow; mode: TemplateMode | null }) {
  const env = row.environment
  if (env) {
    return (
      <div className="space-y-1">
        <Link href={`/user/environments/${env.environmentId}`} className="text-primary font-medium hover:underline">
          {env.label || env.environmentId.slice(0, 8)}
        </Link>
        {env.stoppedAt && <p className="text-warning text-xs">Stopped {formatDate(env.stoppedAt)}</p>}
        {env.deleteAfter && <p className="text-destructive text-xs">Deleted on {formatDate(env.deleteAfter)}</p>}
      </div>
    )
  }
  if (mode === 'SHARED') return <span className="text-muted-foreground">Shared environment</span>
  if (row.status === 'ISSUED' || row.status === 'ACTIVE') {
    return (
      <span className="text-muted-foreground inline-flex items-center gap-1.5">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        Being set up…
      </span>
    )
  }
  return <span className="text-muted-foreground">—</span>
}

export function HoldersTable({
  rows,
  terms,
  modeOf,
  onChangePlan,
  onRevoke,
}: {
  rows: HolderRow[]
  terms: PublisherTerm[]
  modeOf: (kind: string) => TemplateMode | null
  onChangePlan: (row: HolderRow) => void
  onRevoke: (row: HolderRow) => void
}) {
  const planName = (kind: string) => {
    const t = terms.find((x) => x.kind === kind)
    return t ? termName(t) : kind
  }
  return (
    <div className="bg-card border-border overflow-x-auto rounded-xl border shadow-sm">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="pl-4">Holder</TableHead>
            <TableHead>Plan</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Valid</TableHead>
            <TableHead>Environment</TableHead>
            <TableHead className="pr-4 text-right">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => {
            const live = r.status === 'ACTIVE' || r.status === 'ISSUED'
            return (
              <TableRow key={r.id} data-testid={`holder-${r.id}`}>
                <TableCell className="pl-4">
                  <span className="inline-flex items-center gap-1 font-mono text-xs" title={r.user}>
                    {shortDid(r.user)}
                    <CopyButton value={r.user} label="Copy holder DID" />
                  </span>
                </TableCell>
                <TableCell>{planName(r.kind)}</TableCell>
                <TableCell>
                  <StatusPill meta={licenseStatusMeta(r.status)} />
                </TableCell>
                <TableCell className="text-muted-foreground text-sm whitespace-nowrap">{dateRange(r.start, r.end)}</TableCell>
                <TableCell className="text-sm">
                  <EnvironmentCell row={r} mode={modeOf(r.kind)} />
                </TableCell>
                <TableCell className="pr-4 text-right whitespace-nowrap">
                  {live && (
                    <div className="inline-flex gap-2">
                      <Button size="sm" variant="outline" className="h-8" onClick={() => onChangePlan(r)}>
                        Change plan
                      </Button>
                      <Button size="sm" variant="ghost" className="text-destructive h-8" onClick={() => onRevoke(r)}>
                        Revoke
                      </Button>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}
```

`modules/publisher/components/holders/holders-tab.tsx`:

```tsx
'use client'

import { Search, UserPlus, Users } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Button } from '@/modules/shared/components/ui/button'
import { Input } from '@/modules/shared/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/components/ui/select'
import {
  usePublisherAllowList,
  usePublisherEnvironments,
  usePublisherLicenses,
  usePublisherTemplates,
  usePublisherTerms,
} from '../../hooks/use-publisher'
import { termName } from '../../lib/format'
import {
  filterHolders,
  joinHolders,
  LICENSE_FILTERS,
  modeOfKind,
  type HolderRow,
  type LicenseFilter,
} from '../../lib/holders'
import { licenseStatusMeta } from '../../lib/status'
import { EmptyState, TabError, TabHeader, TabSkeleton } from '../primitives'
import { AllowListCard } from './allow-list-card'
import { ChangePlanDialog } from './change-plan-dialog'
import { GrantDialog } from './grant-dialog'
import { HoldersTable } from './holders-table'
import { RevokeDialog } from './revoke-dialog'

const ALL_PLANS = 'ALL'

export function HoldersTab({ appId }: { appId: string }) {
  const licenses = usePublisherLicenses(appId)
  const environments = usePublisherEnvironments(appId)
  const terms = usePublisherTerms(appId)
  const templates = usePublisherTemplates(appId)
  const allowList = usePublisherAllowList(appId)

  const [status, setStatus] = useState<LicenseFilter>('ALL')
  const [kind, setKind] = useState<string>(ALL_PLANS)
  const [query, setQuery] = useState('')
  const [granting, setGranting] = useState(false)
  const [changing, setChanging] = useState<HolderRow | null>(null)
  const [revoking, setRevoking] = useState<HolderRow | null>(null)

  const termList = terms.data ?? []
  const templateList = templates.data ?? []
  const rows = useMemo(
    () => joinHolders(licenses.data ?? [], environments.data ?? []),
    [licenses.data, environments.data],
  )
  const shown = filterHolders(rows, { status, kind, query })
  const modeOf = (k: string) => modeOfKind(k, termList, templateList)

  const grantButton = (
    <Button onClick={() => setGranting(true)} disabled={licenses.data === undefined}>
      <UserPlus className="h-4 w-4" />
      Grant licence
    </Button>
  )

  return (
    <div className="space-y-6">
      <TabHeader
        title="Holders"
        description="Everyone who holds a licence for this app, and the environment each one runs on."
        action={rows.length > 0 && grantButton}
      />
      {licenses.isPending ? (
        <TabSkeleton rows={4} label="Loading holders" />
      ) : licenses.error ? (
        <TabError error={licenses.error} onRetry={() => void licenses.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState icon={Users} title="Nobody holds a licence yet" action={grantButton}>
          Grant one yourself, or create an invite code and share its link.
        </EmptyState>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" aria-hidden />
              <Input
                aria-label="Search holders"
                placeholder="Search by address or project"
                className="pl-9"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <Select value={status} onValueChange={(v) => setStatus(v as LicenseFilter)}>
              <SelectTrigger aria-label="Status" className="w-full sm:w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LICENSE_FILTERS.map((f) => (
                  <SelectItem key={f} value={f}>
                    {f === 'ALL' ? 'All statuses' : licenseStatusMeta(f).label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={kind} onValueChange={setKind}>
              <SelectTrigger aria-label="Plan filter" className="w-full sm:w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_PLANS}>All plans</SelectItem>
                {termList.map((t) => (
                  <SelectItem key={t.id} value={t.kind}>
                    {termName(t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {shown.length === 0 ? (
            <p className="text-muted-foreground border-border rounded-xl border border-dashed py-10 text-center text-sm">
              No holders match these filters.
            </p>
          ) : (
            <HoldersTable
              rows={shown}
              terms={termList}
              modeOf={modeOf}
              onChangePlan={setChanging}
              onRevoke={setRevoking}
            />
          )}
        </div>
      )}

      <AllowListCard appId={appId} entries={allowList.data ?? []} />

      <GrantDialog
        appId={appId}
        open={granting}
        onOpenChange={setGranting}
        licenses={licenses.data ?? []}
        terms={termList}
        templates={templateList}
        allowList={allowList.data ?? []}
      />
      <ChangePlanDialog appId={appId} license={changing} terms={termList} onClose={() => setChanging(null)} />
      <RevokeDialog
        appId={appId}
        license={revoking}
        mode={revoking ? modeOf(revoking.kind) : null}
        onClose={() => setRevoking(null)}
      />
    </div>
  )
}
```

- [ ] **Step 11: Wire the tab into the app page**

`LICENSING_TABS = ['artifacts', 'templates', 'plans', 'holders'] as const`, `holders: 'Holders'`, import `HoldersTab` from `@/modules/publisher/components/holders/holders-tab`, add `TabsContent value="holders"`. Update `app-detail-tabs.test.tsx` (mock + expected lists).

- [ ] **Step 12: Run tests, typecheck, lint**

Run: `pnpm vitest run --config vitest.unit.config.ts modules/publisher modules/apps && pnpm tsc && pnpm eslint modules/publisher modules/apps`
Expected: PASS.

- [ ] **Step 13: Commit**

```bash
git add modules/publisher modules/apps
git commit -m "feat(publisher): holders tab with environments, grants, plan changes, revocation and allow list"
```

---

### Task 8: Invite codes tab

**Files:**
- Create: `modules/publisher/lib/invite-codes.ts`
- Create: `modules/publisher/components/invite-codes/invite-codes-tab.tsx`, `create-invite-code-dialog.tsx`
- Modify: `modules/apps/components/app-detail.tsx` (append `'invite-codes'`), `modules/apps/__tests__/app-detail-tabs.test.tsx`
- Test: `modules/publisher/__tests__/invite-codes-lib.test.ts`, `invite-codes-tab.test.tsx`, `create-invite-code-dialog.test.tsx`

**Interfaces:**
- Consumes: `usePublisherInviteCodes`, `usePublisherTerms`, `useCreateInviteCode`, `useSetInviteCodeActive` (Task 2); `inviteCodeState`, `inviteCodeStatusMeta`, primitives, `runWithToast` (Task 3); `CopyButton`; `Switch`, `Progress`.
- Produces:
  - `lib/invite-codes.ts`: `CODE_PATTERN`, `redeemPath(code): string`, `redeemUrl(origin, code): string`, `endOfDayIso(date: string): string`, `usesText(code): string`, `codePlans(terms): PublisherTerm[]`, `inviteCodeSchema`, `type InviteCodeForm`, `inviteCodeInput(form): Omit<CreateInviteCodeInput, 'appId'>`.
  - `InviteCodesTab({ appId })`.

- [ ] **Step 1: Write the failing lib test**

`modules/publisher/__tests__/invite-codes-lib.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { CODE_PATTERN, codePlans, endOfDayIso, inviteCodeInput, inviteCodeSchema, redeemPath, redeemUrl, usesText } from '../lib/invite-codes'
import type { PublisherTerm } from '../types'

describe('invite codes', () => {
  it('keeps mixed case, dashes and underscores intact in the link', () => {
    expect(CODE_PATTERN.test('LFC_2026-vip')).toBe(true)
    expect(redeemPath('LFC_2026-vip')).toBe('/redeem/LFC_2026-vip')
    expect(redeemUrl('https://vetra.io/', 'LFC_2026-vip')).toBe('https://vetra.io/redeem/LFC_2026-vip')
  })

  it('refuses codes that would not survive a URL or are too short', () => {
    expect(CODE_PATTERN.test('abc')).toBe(false)
    expect(CODE_PATTERN.test('has space')).toBe(false)
    expect(CODE_PATTERN.test('a/b/c/d')).toBe(false)
    expect(CODE_PATTERN.test('-leading')).toBe(false)
  })

  it('expires at the end of the chosen local day', () => {
    const iso = endOfDayIso('2026-12-31')
    const d = new Date(iso)
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(11)
    expect(d.getDate()).toBe(31)
    expect(d.getHours()).toBe(23)
    expect(d.getMinutes()).toBe(59)
  })

  it('counts uses', () => {
    expect(usesText({ redemptions: 3, maxUses: 50 })).toBe('3 of 50')
    expect(usesText({ redemptions: 1, maxUses: null })).toBe('1 redeemed')
  })

  it('offers only published plans that allow invite codes', () => {
    const t = (o: Partial<PublisherTerm>) => ({ id: 'x', kind: 'k', label: null, templateId: 't', validityDays: null, issuers: ['INVITE_CODE'], status: 'ACTIVE', activeLicenses: 0, ...o }) as PublisherTerm
    expect(codePlans([t({ id: 'a' }), t({ id: 'b', issuers: ['PUBLISHER_GRANT'] }), t({ id: 'c', status: 'RETIRED' })]).map((p) => p.id)).toEqual(['a'])
  })

  it('omits the code and key when left empty, so the server generates the code', () => {
    const form = { kind: 'conf', label: '', code: '', maxUses: '', expiresOn: '', anthropicKey: '' }
    expect(inviteCodeSchema.safeParse(form).success).toBe(true)
    expect(inviteCodeInput(form)).toEqual({ kind: 'conf', label: null, maxUses: null, expiresAt: null })
    expect(inviteCodeInput({ ...form, code: ' VIP-1 ', maxUses: '50', anthropicKey: ' sk-ant ' })).toMatchObject({
      code: 'VIP-1', maxUses: 50, anthropicKey: 'sk-ant',
    })
  })

  it('rejects a past expiry date and a zero use cap', () => {
    const form = { kind: 'conf', label: '', code: '', maxUses: '0', expiresOn: '2000-01-01', anthropicKey: '' }
    const result = inviteCodeSchema.safeParse(form)
    expect(result.success).toBe(false)
    const paths = result.success ? [] : result.error.issues.map((i) => i.path[0])
    expect(paths).toEqual(expect.arrayContaining(['maxUses', 'expiresOn']))
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm vitest run --config vitest.unit.config.ts modules/publisher/__tests__/invite-codes-lib.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `modules/publisher/lib/invite-codes.ts`**

```ts
import { z } from 'zod'
import type { CreateInviteCodeInput, PublisherInviteCode, PublisherTerm } from '../types'

/** URL-safe without encoding, so a shared link reads exactly like the code. */
export const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$/

export const redeemPath = (code: string): string => `/redeem/${encodeURIComponent(code)}`
export const redeemUrl = (origin: string, code: string): string => `${origin.replace(/\/+$/, '')}${redeemPath(code)}`

/** `yyyy-mm-dd` from a date input → the last second of that day in the publisher's time zone. */
export function endOfDayIso(date: string): string {
  return new Date(`${date}T23:59:59`).toISOString()
}

export function usesText(c: Pick<PublisherInviteCode, 'redemptions' | 'maxUses'>): string {
  return c.maxUses != null ? `${c.redemptions} of ${c.maxUses}` : `${c.redemptions} redeemed`
}

export function codePlans(terms: PublisherTerm[]): PublisherTerm[] {
  return terms.filter((t) => t.status === 'ACTIVE' && t.issuers.includes('INVITE_CODE'))
}

const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export const inviteCodeSchema = z.object({
  kind: z.string().min(1, 'Choose a plan'),
  label: z.string().trim().max(80, 'Keep it under 80 characters'),
  code: z
    .string()
    .trim()
    .refine((v) => v === '' || CODE_PATTERN.test(v), '4–64 letters, numbers, dashes or underscores'),
  maxUses: z
    .string()
    .trim()
    .refine((v) => v === '' || (/^\d+$/.test(v) && Number(v) > 0), 'A whole number above zero, or empty for no limit'),
  expiresOn: z.string().refine((v) => v === '' || v >= today(), 'Pick today or a later date'),
  anthropicKey: z.string().trim(),
})
export type InviteCodeForm = z.infer<typeof inviteCodeSchema>

export function inviteCodeInput(f: InviteCodeForm): Omit<CreateInviteCodeInput, 'appId'> {
  const code = f.code.trim()
  const key = f.anthropicKey.trim()
  return {
    kind: f.kind,
    label: f.label.trim() || null,
    maxUses: f.maxUses.trim() ? Number(f.maxUses) : null,
    expiresAt: f.expiresOn ? endOfDayIso(f.expiresOn) : null,
    // Omitted, not null: "omit to generate a random code"; the key is write-only.
    ...(code ? { code } : {}),
    ...(key ? { anthropicKey: key } : {}),
  }
}
```

- [ ] **Step 4: Run the lib test**

Run: `pnpm vitest run --config vitest.unit.config.ts modules/publisher/__tests__/invite-codes-lib.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing component tests**

`modules/publisher/__tests__/invite-codes-tab.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import React from 'react'
import type { PublisherInviteCode, PublisherTerm } from '../types'

let codes: PublisherInviteCode[] = []
let terms: PublisherTerm[] = []
const setActive = vi.fn()
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../hooks/use-publisher', () => ({
  usePublisherInviteCodes: () => ({ data: codes, isPending: false, error: null, refetch: vi.fn() }),
  usePublisherTerms: () => ({ data: terms, isPending: false, error: null }),
}))
vi.mock('../hooks/use-publisher-mutations', () => ({
  useCreateInviteCode: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSetInviteCodeActive: () => ({ mutateAsync: setActive, isPending: false }),
}))

import { InviteCodesTab } from '../components/invite-codes/invite-codes-tab'

const code = (over: Partial<PublisherInviteCode> = {}): PublisherInviteCode => ({
  code: 'LFC_2026-vip', kind: 'conf', label: 'Speakers', active: true, expiresAt: null, maxUses: 50,
  redemptions: 12, hasAnthropicKey: true, createdAt: '2026-10-01T00:00:00Z', ...over,
})

describe('InviteCodesTab', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    terms = [{ id: 't', kind: 'conf', label: 'Conference', templateId: 'x', validityDays: 30, issuers: ['INVITE_CODE'], status: 'ACTIVE', activeLicenses: 12 }]
  })

  it('sends a publisher without code-ready plans to Plans first', () => {
    codes = []
    terms = []
    render(<InviteCodesTab appId="app-1" />)
    expect(screen.getByText('No invite codes yet')).toBeTruthy()
    expect(screen.getByRole('link', { name: /set up a plan first/i }).getAttribute('href')).toBe('?tab=plans')
  })

  it('shows usage, status, the plan and a copyable redeem link', () => {
    codes = [code()]
    render(<InviteCodesTab appId="app-1" />)
    const row = screen.getByTestId('code-LFC_2026-vip')
    expect(within(row).getByText('12 of 50')).toBeTruthy()
    expect(within(row).getByText('Conference')).toBeTruthy()
    expect(within(row).getByText('Active')).toBeTruthy()
    expect(within(row).getByLabelText('Includes a Claude key')).toBeTruthy()
    expect(within(row).getByRole('button', { name: /copy redeem link/i })).toBeTruthy()
  })

  it('pauses a code', async () => {
    codes = [code()]
    setActive.mockResolvedValue(true)
    render(<InviteCodesTab appId="app-1" />)
    await act(async () => fireEvent.click(within(screen.getByTestId('code-LFC_2026-vip')).getByRole('switch', { name: /accepting redemptions/i })))
    expect(setActive).toHaveBeenCalledWith({ code: 'LFC_2026-vip', active: false })
  })
})
```

`modules/publisher/__tests__/create-invite-code-dialog.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import type { PublisherTerm } from '../types'

const create = vi.fn()
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../hooks/use-publisher-mutations', () => ({
  useCreateInviteCode: () => ({ mutateAsync: create, isPending: false }),
}))
vi.mock('@/shared/components/ui/select', () => import('@/modules/shared/test/native-select'))

import { CreateInviteCodeDialog } from '../components/invite-codes/create-invite-code-dialog'

const plans: PublisherTerm[] = [
  { id: 't', kind: 'conf', label: 'Conference', templateId: 'x', validityDays: 30, issuers: ['INVITE_CODE'], status: 'ACTIVE', activeLicenses: 0 },
]

describe('CreateInviteCodeDialog', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('creates a code and then shows its link to share', async () => {
    create.mockResolvedValue({
      code: 'VIP-1', kind: 'conf', label: null, active: true, expiresAt: null, maxUses: 10,
      redemptions: 0, hasAnthropicKey: false, createdAt: '2026-10-08T00:00:00Z',
    })
    render(<CreateInviteCodeDialog appId="app-1" plans={plans} open onOpenChange={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Plan'), { target: { value: 'conf' } })
    fireEvent.change(screen.getByLabelText('Custom code (optional)'), { target: { value: 'VIP-1' } })
    fireEvent.change(screen.getByLabelText('Maximum uses'), { target: { value: '10' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Create code' })))
    expect(create).toHaveBeenCalledWith({ kind: 'conf', label: null, maxUses: 10, expiresAt: null, code: 'VIP-1' })
    expect(screen.getByText('VIP-1')).toBeTruthy()
    expect(screen.getByText(/\/redeem\/VIP-1$/)).toBeTruthy()
  })

  it('never shows the Claude key back after typing it', () => {
    render(<CreateInviteCodeDialog appId="app-1" plans={plans} open onOpenChange={vi.fn()} />)
    expect((screen.getByLabelText('Claude API key (optional)') as HTMLInputElement).type).toBe('password')
  })
})
```

- [ ] **Step 6: Run to see them fail**

Run: `pnpm vitest run --config vitest.unit.config.ts modules/publisher/__tests__/invite-codes-tab.test.tsx modules/publisher/__tests__/create-invite-code-dialog.test.tsx`
Expected: FAIL.

- [ ] **Step 7: Implement `create-invite-code-dialog.tsx`**

```tsx
'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { CheckCircle2, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { CopyButton } from '@/modules/apps/components/copy-button'
import { Button } from '@/modules/shared/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/modules/shared/components/ui/dialog'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/modules/shared/components/ui/form'
import { Input } from '@/modules/shared/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/components/ui/select'
import { useCreateInviteCode } from '../../hooks/use-publisher-mutations'
import { termName } from '../../lib/format'
import { inviteCodeInput, inviteCodeSchema, redeemUrl, type InviteCodeForm } from '../../lib/invite-codes'
import { runWithToast } from '../../lib/run'
import type { PublisherInviteCode, PublisherTerm } from '../../types'

const EMPTY: InviteCodeForm = { kind: '', label: '', code: '', maxUses: '', expiresOn: '', anthropicKey: '' }

export function CreateInviteCodeDialog({
  appId,
  plans,
  open,
  onOpenChange,
}: {
  appId: string
  /** Published plans that allow invite codes. */
  plans: PublisherTerm[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const create = useCreateInviteCode(appId)
  const form = useForm<InviteCodeForm>({ resolver: zodResolver(inviteCodeSchema), defaultValues: EMPTY })
  const [created, setCreated] = useState<PublisherInviteCode | null>(null)

  useEffect(() => {
    if (!open) form.reset(EMPTY)
  }, [open, form])

  const close = (o: boolean) => {
    if (!o) setCreated(null)
    onOpenChange(o)
  }

  const submit = async (v: InviteCodeForm) => {
    await runWithToast(async () => {
      setCreated(await create.mutateAsync(inviteCodeInput(v)))
    }, 'Invite code created')
  }

  const link = created ? redeemUrl(typeof window === 'undefined' ? '' : window.location.origin, created.code) : ''

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CheckCircle2 className="text-success h-5 w-5" aria-hidden />
                Your code is ready
              </DialogTitle>
              <DialogDescription>Share the link. People log in with Renown and get the plan.</DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <p className="bg-muted rounded-lg py-4 text-center font-mono text-2xl font-semibold tracking-wide">
                {created.code}
              </p>
              <div className="border-border flex items-center gap-2 rounded-lg border px-3 py-2">
                <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-xs">{link}</span>
                <CopyButton value={link} label="Copy redeem link" showLabel />
              </div>
            </div>
            <DialogFooter>
              <Button onClick={() => close(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>New invite code</DialogTitle>
              <DialogDescription>Anyone with the code gets the plan, until it runs out or expires.</DialogDescription>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(submit)} className="space-y-4">
                <FormField
                  control={form.control}
                  name="kind"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Plan</FormLabel>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger aria-label="Plan" className="w-full">
                            <SelectValue placeholder="Choose a plan" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {plans.map((t) => (
                            <SelectItem key={t.id} value={t.kind}>
                              {termName(t)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="label"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Note (optional)</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. Speakers, Newsletter October" autoComplete="off" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="code"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Custom code (optional)</FormLabel>
                      <FormControl>
                        <Input placeholder="Leave empty for a random code" className="font-mono" autoComplete="off" spellCheck={false} {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField
                    control={form.control}
                    name="maxUses"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Maximum uses</FormLabel>
                        <FormControl>
                          <Input inputMode="numeric" placeholder="No limit" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="expiresOn"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Expires on</FormLabel>
                        <FormControl>
                          <Input type="date" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <FormField
                  control={form.control}
                  name="anthropicKey"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Claude API key (optional)</FormLabel>
                      <FormControl>
                        <Input type="password" autoComplete="off" placeholder="sk-ant-…" {...field} />
                      </FormControl>
                      <FormDescription>
                        For Vetra Studio plans: people who redeem get this key in their studio. Stored
                        encrypted and never shown again.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <DialogFooter>
                  <Button type="submit" disabled={create.isPending}>
                    {create.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                    Create code
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 8: Implement `invite-codes-tab.tsx`**

```tsx
'use client'

import { KeyRound, Plus, Ticket } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'
import { CopyButton } from '@/modules/apps/components/copy-button'
import { StatusPill } from '@/modules/apps/components/status'
import { formatDate } from '@/modules/apps/lib/time'
import { Button } from '@/modules/shared/components/ui/button'
import { Progress } from '@/modules/shared/components/ui/progress'
import { Switch } from '@/modules/shared/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/modules/shared/components/ui/table'
import { usePublisherInviteCodes, usePublisherTerms } from '../../hooks/use-publisher'
import { useSetInviteCodeActive } from '../../hooks/use-publisher-mutations'
import { termName } from '../../lib/format'
import { codePlans, redeemUrl, usesText } from '../../lib/invite-codes'
import { runWithToast } from '../../lib/run'
import { inviteCodeState, inviteCodeStatusMeta } from '../../lib/status'
import { EmptyState, TabError, TabHeader, TabSkeleton } from '../primitives'
import { CreateInviteCodeDialog } from './create-invite-code-dialog'

export function InviteCodesTab({ appId }: { appId: string }) {
  const codes = usePublisherInviteCodes(appId)
  const terms = usePublisherTerms(appId)
  const setActive = useSetInviteCodeActive(appId)
  const [creating, setCreating] = useState(false)
  const list = codes.data ?? []
  const termList = terms.data ?? []
  const plans = codePlans(termList)
  const origin = typeof window === 'undefined' ? '' : window.location.origin
  const planName = (kind: string) => {
    const t = termList.find((x) => x.kind === kind)
    return t ? termName(t) : kind
  }

  const createButton =
    plans.length > 0 ? (
      <Button onClick={() => setCreating(true)}>
        <Plus className="h-4 w-4" />
        New invite code
      </Button>
    ) : (
      <Button asChild variant="outline">
        <Link href="?tab=plans">Set up a plan first</Link>
      </Button>
    )

  return (
    <div className="space-y-6">
      <TabHeader
        title="Invite codes"
        description="Share a code or a link. Whoever redeems it gets the plan — no wallet address needed up front."
        action={list.length > 0 && createButton}
      />
      {codes.isPending ? (
        <TabSkeleton label="Loading invite codes" />
      ) : codes.error ? (
        <TabError error={codes.error} onRetry={() => void codes.refetch()} />
      ) : list.length === 0 ? (
        <EmptyState icon={Ticket} title="No invite codes yet" action={createButton}>
          {plans.length > 0
            ? 'Create a code for a conference, a newsletter or a pilot customer.'
            : 'Invite codes hand out a published plan that allows invite codes. Set one up in Plans.'}
        </EmptyState>
      ) : (
        <div className="bg-card border-border overflow-x-auto rounded-xl border shadow-sm">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Code</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead>Uses</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="pr-4 text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((c) => {
                const state = inviteCodeState(c)
                const pct = c.maxUses ? Math.min(100, Math.round((c.redemptions / c.maxUses) * 100)) : null
                return (
                  <TableRow key={c.code} data-testid={`code-${c.code}`}>
                    <TableCell className="pl-4">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-semibold">{c.code}</span>
                        {c.hasAnthropicKey && (
                          <span role="img" aria-label="Includes a Claude key" title="Includes a Claude key">
                            <KeyRound className="text-muted-foreground h-3.5 w-3.5" aria-hidden />
                          </span>
                        )}
                      </div>
                      {c.label && <p className="text-muted-foreground text-xs">{c.label}</p>}
                    </TableCell>
                    <TableCell>{planName(c.kind)}</TableCell>
                    <TableCell className="min-w-32">
                      <p className="text-sm">{usesText(c)}</p>
                      {pct !== null && <Progress value={pct} className="mt-1 h-1.5" aria-hidden />}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm whitespace-nowrap">
                      {c.expiresAt ? formatDate(c.expiresAt) : 'Never'}
                    </TableCell>
                    <TableCell>
                      <StatusPill meta={inviteCodeStatusMeta(state)} />
                    </TableCell>
                    <TableCell className="pr-4">
                      <div className="flex items-center justify-end gap-3">
                        <CopyButton value={redeemUrl(origin, c.code)} label={`Copy redeem link for ${c.code}`} />
                        <Switch
                          checked={c.active}
                          disabled={setActive.isPending}
                          aria-label={`${c.code} accepting redemptions`}
                          onCheckedChange={(active) =>
                            void runWithToast(
                              () => setActive.mutateAsync({ code: c.code, active }),
                              active ? 'Code resumed' : 'Code paused',
                            )
                          }
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}
      <CreateInviteCodeDialog appId={appId} plans={plans} open={creating} onOpenChange={setCreating} />
    </div>
  )
}
```

Check `CopyButton` renders its `label` as the button's `aria-label` (it does today — the `label` prop is the accessible name); the test's `/copy redeem link/i` matches `Copy redeem link for LFC_2026-vip`.

- [ ] **Step 9: Wire the tab into the app page**

`LICENSING_TABS = ['artifacts', 'templates', 'plans', 'holders', 'invite-codes'] as const`, `'invite-codes': 'Invite codes'`, import `InviteCodesTab`, add `TabsContent value="invite-codes"`. Update `app-detail-tabs.test.tsx`: mock the module; final expected publisher list is `['Overview', 'Deployments', 'Artifacts', 'Templates', 'Plans', 'Holders', 'Invite codes', 'Settings']` and `visibleAppTabs({ readOnly: false, isPublisher: true })` equals `['overview', 'deployments', 'artifacts', 'templates', 'plans', 'holders', 'invite-codes', 'settings']`.

- [ ] **Step 10: Run tests, typecheck, lint**

Run: `pnpm vitest run --config vitest.unit.config.ts modules/publisher modules/apps && pnpm tsc && pnpm eslint modules/publisher modules/apps`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add modules/publisher modules/apps
git commit -m "feat(publisher): invite codes tab with shareable redeem links"
```

---
### Task 9: Owner data layer — `vetraSubscriptions` client, hooks and helpers

**Files:**
- Create: `modules/subscriptions/types.ts`, `modules/subscriptions/graphql.ts`, `modules/subscriptions/hooks/keys.ts`, `modules/subscriptions/hooks/use-subscriptions.ts`, `modules/subscriptions/lib/subscriptions.ts`
- Test: `modules/subscriptions/__tests__/graphql.test.ts`, `subscriptions-lib.test.ts`, `use-subscriptions.test.tsx`

**Interfaces:**
- Consumes: `publisherGql`, `FetchLike`, `retryPublisher` from `@/modules/publisher/graphql`; `usePublisherToken`, `useViewerDid` from `@/modules/publisher/hooks/*`; `useAuthedQuery`; `formatDate`; `StatusMeta`.
- Produces:
  - Types: `InviteCodeCheck`, `Subscription`, `SubscriptionWarning`, `SubscriptionWarningKind`, `StudioAccess`, `RedeemInviteCodeInput` (exact contract fields).
  - `graphql.ts`: `fetchInviteCodeCheck(code, fetchImpl?)` (no token), `fetchMySubscriptions(token, fetchImpl?)`, `fetchStudioAccess(token, fetchImpl?)`, `redeemInviteCode(input, token, fetchImpl?) → Subscription`, `cancelSubscription(licenseId, token, fetchImpl?) → boolean`, `applyStudioKey(tenantId, secretNames, token, fetchImpl?) → boolean`.
  - `hooks/keys.ts`: `subscriptionsKeys.all`, `.mine(did)`, `.studioAccess(did)`, `.inviteCode(code)`.
  - `hooks/use-subscriptions.ts`: `useInviteCodeCheck(code)`, `useMySubscriptions()`, `useStudioAccess()` (data `StudioAccess | null`; null = token not ready yet, polls), `useRedeemInviteCode()`, `useCancelSubscription()`, `useSubscriptionForEnvironment(environmentId) → { subscription: Subscription | undefined; isPending: boolean }`.
  - `lib/subscriptions.ts`: `isLive(s)`, `type AppGroup = { appId; appName; live: Subscription[]; past: Subscription[] }`, `groupByApp(subs)`, `subscriptionStatusMeta(status)`, `subscriptionName(s)`, `issuerText(issuer)`, `validityLine(s, now?)`, `warningTone(kind): 'warning' | 'danger'`, `upgradeCandidates(subs, appId)`, `environmentHref(s): string | null`, `subscriptionHref(licenseId)`.

- [ ] **Step 1: Write the failing client test**

`modules/subscriptions/__tests__/graphql.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { FetchLike } from '@/modules/publisher/graphql'
import {
  applyStudioKey,
  cancelSubscription,
  fetchInviteCodeCheck,
  fetchMySubscriptions,
  fetchStudioAccess,
  redeemInviteCode,
} from '../graphql'

const capture = (data: unknown) => {
  const calls: Array<{ query: string; variables: unknown; auth: string | undefined }> = []
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls.push({ ...JSON.parse(init.body as string), auth: (init.headers as Record<string, string>).Authorization })
    return new Response(JSON.stringify({ data }), { status: 200 })
  }) as unknown as FetchLike
  return { calls, fetchImpl }
}

const SUB_FIELDS =
  'licenseId appId appName kind termLabel issuer status start end mode environmentId environmentLabel openUrl stoppedAt deleteAfter warnings { kind at message }'

describe('vetraSubscriptions client', () => {
  it('checks a code without a token', async () => {
    const check = { valid: true, appId: 'a', appName: 'Vault', kind: 'pilot', termLabel: 'Pilot', mode: 'DEDICATED' }
    const { calls, fetchImpl } = capture({ vetraSubscriptions: { inviteCode: check } })
    await expect(fetchInviteCodeCheck('LFC_2026-vip', fetchImpl)).resolves.toEqual(check)
    expect(calls[0].auth).toBeUndefined()
    expect(calls[0].variables).toEqual({ code: 'LFC_2026-vip' })
    expect(calls[0].query).toContain('inviteCode(code: $code) { valid appId appName kind termLabel mode }')
  })

  it('lists my subscriptions with every contract field', async () => {
    const { calls, fetchImpl } = capture({ vetraSubscriptions: { mySubscriptions: [] } })
    await fetchMySubscriptions('tok', fetchImpl)
    expect(calls[0].auth).toBe('Bearer tok')
    expect(calls[0].query.replace(/\s+/g, ' ')).toContain(`mySubscriptions { ${SUB_FIELDS} }`)
  })

  it('reads studio access', async () => {
    const access = { allowed: true, licenseId: 'l', expires: null, hasAttachedKey: true }
    const { calls, fetchImpl } = capture({ vetraSubscriptions: { studioAccess: access } })
    await expect(fetchStudioAccess('tok', fetchImpl)).resolves.toEqual(access)
    expect(calls[0].query).toContain('studioAccess { allowed licenseId expires hasAttachedKey }')
  })

  it('redeems with the input passed through untouched', async () => {
    const { calls, fetchImpl } = capture({ vetraSubscriptions: { redeemInviteCode: { licenseId: 'l' } } })
    await redeemInviteCode({ code: 'C', upgrades: 'old' }, 'tok', fetchImpl)
    expect(calls[0].query).toContain('mutation ($input: RedeemInviteCodeInput!)')
    expect(calls[0].query).toContain('redeemInviteCode(input: $input) {')
    expect(calls[0].variables).toEqual({ input: { code: 'C', upgrades: 'old' } })
  })

  it('cancels and applies the studio key with bare arguments', async () => {
    const a = capture({ vetraSubscriptions: { cancelSubscription: true } })
    await expect(cancelSubscription('l1', 'tok', a.fetchImpl)).resolves.toBe(true)
    expect(a.calls[0].query).toContain('cancelSubscription(licenseId: $licenseId)')
    const b = capture({ vetraSubscriptions: { applyStudioKey: true } })
    await expect(applyStudioKey('t-1', ['ANTHROPIC_API_KEY'], 'tok', b.fetchImpl)).resolves.toBe(true)
    expect(b.calls[0].query).toContain('mutation ($tenantId: String!, $secretNames: [String!]!)')
    expect(b.calls[0].query).toContain('applyStudioKey(tenantId: $tenantId, secretNames: $secretNames)')
    expect(b.calls[0].variables).toEqual({ tenantId: 't-1', secretNames: ['ANTHROPIC_API_KEY'] })
  })
})
```

- [ ] **Step 2: Write the failing helper test**

`modules/subscriptions/__tests__/subscriptions-lib.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  environmentHref,
  groupByApp,
  subscriptionName,
  subscriptionStatusMeta,
  upgradeCandidates,
  validityLine,
  warningTone,
} from '../lib/subscriptions'
import type { Subscription } from '../types'

const sub = (over: Partial<Subscription>): Subscription => ({
  licenseId: 'l1', appId: 'kv', appName: 'Knowledge Vault', kind: 'kv-pro', termLabel: 'Pro',
  issuer: 'INVITE_CODE', status: 'ACTIVE', start: '2026-10-01T00:00:00Z', end: null, mode: 'DEDICATED',
  environmentId: 'env-1', environmentLabel: 'Acme', openUrl: 'https://acme.kv', stoppedAt: null,
  deleteAfter: null, warnings: [], ...over,
})

describe('subscriptions lib', () => {
  it('groups by app, apps with something live first, then by name', () => {
    const groups = groupByApp([
      sub({ licenseId: 'a', appId: 'z', appName: 'Zeta', status: 'EXPIRED' }),
      sub({ licenseId: 'b', appId: 'kv' }),
      sub({ licenseId: 'c', appId: 'kv', status: 'REPLACED' }),
      sub({ licenseId: 'd', appId: 'al', appName: 'Alpha' }),
    ])
    expect(groups.map((g) => g.appName)).toEqual(['Alpha', 'Knowledge Vault', 'Zeta'])
    const kv = groups[1]
    expect(kv.live.map((s) => s.licenseId)).toEqual(['b'])
    expect(kv.past.map((s) => s.licenseId)).toEqual(['c'])
  })

  it('offers only live licences of the same app as upgrade targets', () => {
    const subs = [
      sub({ licenseId: 'live' }),
      sub({ licenseId: 'issued', status: 'ISSUED' }),
      sub({ licenseId: 'ended', status: 'EXPIRED' }),
      sub({ licenseId: 'revoked', status: 'REVOKED' }),
      sub({ licenseId: 'replaced', status: 'REPLACED' }),
      sub({ licenseId: 'other', appId: 'other' }),
    ]
    expect(upgradeCandidates(subs, 'kv').map((s) => s.licenseId)).toEqual(['live', 'issued'])
  })

  it('reads validity in plain words', () => {
    const now = new Date('2026-10-08T00:00:00Z')
    expect(validityLine(sub({ end: null }), now)).toMatch(/^Since .* · no end date$/)
    expect(validityLine(sub({ end: '2026-11-01T00:00:00Z' }), now)).toMatch(/· until /)
    expect(validityLine(sub({ status: 'EXPIRED', end: '2026-10-02T00:00:00Z' }), now)).toMatch(/^Ended /)
    expect(validityLine(sub({ status: 'ISSUED', start: null }), now)).toBe('Starting now')
  })

  it('names, statuses, tones and links', () => {
    expect(subscriptionName(sub({ termLabel: null }))).toBe('kv-pro')
    expect(subscriptionStatusMeta('REVOKED').label).toBe('Ended')
    expect(subscriptionStatusMeta('ISSUED').label).toBe('Setting up')
    expect(warningTone('EXPIRING')).toBe('warning')
    expect(warningTone('DELETE_IMMINENT')).toBe('danger')
    expect(environmentHref(sub({}))).toBe('/user/environments/env-1')
    expect(environmentHref(sub({ environmentId: null }))).toBeNull()
  })
})
```

- [ ] **Step 3: Write the failing hook test**

`modules/subscriptions/__tests__/use-subscriptions.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import React from 'react'

const fetchMySubscriptions = vi.fn()
const fetchStudioAccess = vi.fn()
const redeemInviteCode = vi.fn()
let did: string | undefined = 'did:pkh:eip155:1:0xme'

vi.mock('../graphql', () => ({
  fetchInviteCodeCheck: vi.fn(),
  fetchMySubscriptions: (...a: unknown[]) => fetchMySubscriptions(...a),
  fetchStudioAccess: (...a: unknown[]) => fetchStudioAccess(...a),
  redeemInviteCode: (...a: unknown[]) => redeemInviteCode(...a),
  cancelSubscription: vi.fn(),
}))
vi.mock('@/modules/cloud/query/use-authed-query', () => ({
  useAuthedQuery: (key: readonly unknown[], fetcher: (t: string | null) => Promise<unknown>, options?: object) =>
    useQuery({ queryKey: key, queryFn: () => fetcher('tok'), ...options }),
}))
vi.mock('@/modules/publisher/hooks/use-publisher', () => ({ usePublisherToken: () => async () => 'tok' }))
vi.mock('@powerhousedao/reactor-browser', () => ({ useDid: () => did }))

import {
  useMySubscriptions,
  useRedeemInviteCode,
  useStudioAccess,
  useSubscriptionForEnvironment,
} from '../hooks/use-subscriptions'

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const invalidate = vi.spyOn(qc, 'invalidateQueries')
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  return { Wrapper, invalidate }
}

describe('subscription hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    did = 'did:pkh:eip155:1:0xme'
  })

  it('stays idle while signed out', () => {
    did = undefined
    const { Wrapper } = setup()
    renderHook(() => useMySubscriptions(), { wrapper: Wrapper })
    renderHook(() => useStudioAccess(), { wrapper: Wrapper })
    expect(fetchMySubscriptions).not.toHaveBeenCalled()
    expect(fetchStudioAccess).not.toHaveBeenCalled()
  })

  it('finds the subscription behind an environment, preferring a live one', async () => {
    fetchMySubscriptions.mockResolvedValue([
      { licenseId: 'old', environmentId: 'env-1', status: 'REPLACED' },
      { licenseId: 'new', environmentId: 'env-1', status: 'ACTIVE' },
    ])
    const { Wrapper } = setup()
    const { result } = renderHook(() => useSubscriptionForEnvironment('env-1'), { wrapper: Wrapper })
    await waitFor(() => expect(result.current.subscription?.licenseId).toBe('new'))
  })

  it('refreshes every subscription query after a redemption', async () => {
    redeemInviteCode.mockResolvedValue({ licenseId: 'l1' })
    const { Wrapper, invalidate } = setup()
    const { result } = renderHook(() => useRedeemInviteCode(), { wrapper: Wrapper })
    await act(async () => {
      await result.current.mutateAsync({ code: 'C' })
    })
    expect(redeemInviteCode).toHaveBeenCalledWith({ code: 'C' }, 'tok')
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['subscriptions'] })
  })
})
```

- [ ] **Step 4: Run to see them fail**

Run: `pnpm vitest run --config vitest.unit.config.ts modules/subscriptions`
Expected: FAIL — modules not found.

- [ ] **Step 5: Implement types and client**

`modules/subscriptions/types.ts`:

```ts
/** vetraSubscriptions (vetra-licensing subgraph), exactly as the contract names them. */

export type InviteCodeCheck = {
  valid: boolean
  /** All null when invalid. */
  appId: string | null
  appName: string | null
  kind: string | null
  termLabel: string | null
  /** DEDICATED | SHARED — only DEDICATED asks for a project name. */
  mode: string | null
}

export type SubscriptionWarningKind =
  | 'EXPIRING'
  | 'ENDED_STOP_PENDING'
  | 'STOPPED_DELETE_PENDING'
  | 'DELETE_IMMINENT'

export type SubscriptionWarning = { kind: SubscriptionWarningKind; at: string; message: string }

export type Subscription = {
  licenseId: string
  appId: string
  appName: string
  kind: string
  termLabel: string | null
  issuer: string
  status: string
  start: string | null
  end: string | null
  mode: 'SHARED' | 'DEDICATED'
  environmentId: string | null
  environmentLabel: string | null
  /** The environment's primary URL (DEDICATED) or the app URL (SHARED). */
  openUrl: string | null
  stoppedAt: string | null
  deleteAfter: string | null
  warnings: SubscriptionWarning[]
}

export type StudioAccess = {
  allowed: boolean
  licenseId: string | null
  expires: string | null
  hasAttachedKey: boolean
}

export type RedeemInviteCodeInput = {
  code: string
  /** Project name for a DEDICATED environment; ignored for SHARED. */
  label?: string | null
  /** Replace this licence (same app) instead of starting a new environment. */
  upgrades?: string | null
}
```

`modules/subscriptions/graphql.ts`:

```ts
import { publisherGql, type FetchLike } from '@/modules/publisher/graphql'
import type { InviteCodeCheck, RedeemInviteCodeInput, StudioAccess, Subscription } from './types'

// Same subgraph (vetra-licensing) and error mechanism as vetraPublisher, so the
// publisher transport and PublisherApiError are reused (decision D6).

const SUBSCRIPTION_FIELDS = `licenseId appId appName kind termLabel issuer status start end mode
  environmentId environmentLabel openUrl stoppedAt deleteAfter
  warnings { kind at message }`

type Ns<T> = { vetraSubscriptions: T }

/** Public: no token is sent. One answer for unknown, paused, expired and used up. */
export async function fetchInviteCodeCheck(code: string, fetchImpl?: FetchLike): Promise<InviteCodeCheck> {
  const data = await publisherGql<Ns<{ inviteCode: InviteCodeCheck }>>(
    `query ($code: String!) { vetraSubscriptions { inviteCode(code: $code) { valid appId appName kind termLabel mode } } }`,
    { code },
    null,
    fetchImpl,
  )
  return data.vetraSubscriptions.inviteCode
}

export async function fetchMySubscriptions(token: string | null, fetchImpl?: FetchLike): Promise<Subscription[]> {
  const data = await publisherGql<Ns<{ mySubscriptions: Subscription[] }>>(
    `query { vetraSubscriptions { mySubscriptions { ${SUBSCRIPTION_FIELDS} } } }`,
    {},
    token,
    fetchImpl,
  )
  return data.vetraSubscriptions.mySubscriptions ?? []
}

export async function fetchStudioAccess(token: string | null, fetchImpl?: FetchLike): Promise<StudioAccess> {
  const data = await publisherGql<Ns<{ studioAccess: StudioAccess }>>(
    `query { vetraSubscriptions { studioAccess { allowed licenseId expires hasAttachedKey } } }`,
    {},
    token,
    fetchImpl,
  )
  return data.vetraSubscriptions.studioAccess
}

export async function redeemInviteCode(
  input: RedeemInviteCodeInput,
  token: string | null,
  fetchImpl?: FetchLike,
): Promise<Subscription> {
  const data = await publisherGql<Ns<{ redeemInviteCode: Subscription }>>(
    `mutation ($input: RedeemInviteCodeInput!) { vetraSubscriptions { redeemInviteCode(input: $input) { ${SUBSCRIPTION_FIELDS} } } }`,
    { input },
    token,
    fetchImpl,
  )
  return data.vetraSubscriptions.redeemInviteCode
}

export async function cancelSubscription(
  licenseId: string,
  token: string | null,
  fetchImpl?: FetchLike,
): Promise<boolean> {
  const data = await publisherGql<Ns<{ cancelSubscription: boolean }>>(
    `mutation ($licenseId: String!) { vetraSubscriptions { cancelSubscription(licenseId: $licenseId) } }`,
    { licenseId },
    token,
    fetchImpl,
  )
  return data.vetraSubscriptions.cancelSubscription
}

/** Writes the caller's studio-licence Claude key into a tenant's secrets, server-side. */
export async function applyStudioKey(
  tenantId: string,
  secretNames: string[],
  token: string | null,
  fetchImpl?: FetchLike,
): Promise<boolean> {
  const data = await publisherGql<Ns<{ applyStudioKey: boolean }>>(
    `mutation ($tenantId: String!, $secretNames: [String!]!) { vetraSubscriptions { applyStudioKey(tenantId: $tenantId, secretNames: $secretNames) } }`,
    { tenantId, secretNames },
    token,
    fetchImpl,
  )
  return data.vetraSubscriptions.applyStudioKey
}
```

- [ ] **Step 6: Implement `lib/subscriptions.ts`**

```ts
import type { StatusMeta } from '@/modules/apps/lib/status'
import { formatDate } from '@/modules/apps/lib/time'
import type { Subscription, SubscriptionWarningKind } from '../types'

const LIVE = new Set(['ISSUED', 'ACTIVE'])
export const isLive = (s: Pick<Subscription, 'status'>): boolean => LIVE.has(s.status)

export type AppGroup = { appId: string; appName: string; live: Subscription[]; past: Subscription[] }

const startTime = (s: Subscription) => (s.start ? new Date(s.start).getTime() : Number.POSITIVE_INFINITY)

export function groupByApp(subs: Subscription[]): AppGroup[] {
  const groups = new Map<string, AppGroup>()
  for (const s of subs) {
    const g = groups.get(s.appId) ?? { appId: s.appId, appName: s.appName, live: [], past: [] }
    ;(isLive(s) ? g.live : g.past).push(s)
    groups.set(s.appId, g)
  }
  const byStart = (a: Subscription, b: Subscription) => startTime(b) - startTime(a) || 0
  return [...groups.values()]
    .map((g) => ({ ...g, live: g.live.sort(byStart), past: g.past.sort(byStart) }))
    .sort((a, b) => {
      if ((a.live.length > 0) !== (b.live.length > 0)) return a.live.length > 0 ? -1 : 1
      return a.appName.localeCompare(b.appName)
    })
}

const STATUS: Record<string, StatusMeta> = {
  ISSUED: { label: 'Setting up', tone: 'progress', active: true },
  ACTIVE: { label: 'Active', tone: 'success', active: false },
  EXPIRED: { label: 'Expired', tone: 'warning', active: false },
  // Owner-facing: whether the publisher revoked it or the owner cancelled, it has ended.
  REVOKED: { label: 'Ended', tone: 'neutral', active: false },
  REPLACED: { label: 'Upgraded', tone: 'neutral', active: false },
}
export const subscriptionStatusMeta = (status: string): StatusMeta =>
  STATUS[status] ?? { label: status, tone: 'neutral', active: false }

export const subscriptionName = (s: Pick<Subscription, 'termLabel' | 'kind'>): string =>
  s.termLabel?.trim() || s.kind

export function issuerText(issuer: string): string {
  if (issuer === 'INVITE_CODE') return 'From an invite code'
  if (issuer === 'PUBLISHER_GRANT') return 'Given to you by the publisher'
  if (issuer === 'ACHRA_SUBSCRIPTION') return 'Paid subscription'
  return issuer
}

export function validityLine(s: Subscription, now: Date = new Date()): string {
  if (!isLive(s)) return s.end ? `Ended ${formatDate(s.end)}` : 'Ended'
  if (!s.start) return 'Starting now'
  const until = s.end
    ? new Date(s.end).getTime() > now.getTime()
      ? `until ${formatDate(s.end)}`
      : `ended ${formatDate(s.end)}`
    : 'no end date'
  return `Since ${formatDate(s.start)} · ${until}`
}

export function warningTone(kind: SubscriptionWarningKind | string): 'warning' | 'danger' {
  return kind === 'STOPPED_DELETE_PENDING' || kind === 'DELETE_IMMINENT' ? 'danger' : 'warning'
}

/** Only a live licence of the same app can be upgraded in place. */
export function upgradeCandidates(subs: Subscription[], appId: string): Subscription[] {
  return subs.filter((s) => s.appId === appId && isLive(s))
}

export const environmentHref = (s: Pick<Subscription, 'environmentId'>): string | null =>
  s.environmentId ? `/user/environments/${s.environmentId}` : null

export const subscriptionHref = (licenseId: string): string =>
  `/user/subscriptions?highlight=${encodeURIComponent(licenseId)}`
```

- [ ] **Step 7: Implement keys and hooks**

`modules/subscriptions/hooks/keys.ts`:

```ts
export const subscriptionsKeys = {
  all: ['subscriptions'] as const,
  mine: (did: string) => ['subscriptions', 'mine', did] as const,
  studioAccess: (did: string) => ['subscriptions', 'studio-access', did] as const,
  inviteCode: (code: string) => ['subscriptions', 'invite-code', code] as const,
}
```

`modules/subscriptions/hooks/use-subscriptions.ts`:

```ts
'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuthedQuery } from '@/modules/cloud/query/use-authed-query'
import { retryPublisher } from '@/modules/publisher/graphql'
import { usePublisherToken } from '@/modules/publisher/hooks/use-publisher'
import { useViewerDid } from '@/modules/publisher/hooks/use-viewer-did'
import {
  cancelSubscription,
  fetchInviteCodeCheck,
  fetchMySubscriptions,
  fetchStudioAccess,
  redeemInviteCode,
} from '../graphql'
import { isLive } from '../lib/subscriptions'
import type { RedeemInviteCodeInput, StudioAccess, Subscription } from '../types'
import { subscriptionsKeys } from './keys'

const SETTLING_POLL_MS = 10_000

/** Public check, before login. Cached briefly so going back and forth does not re-ask. */
export function useInviteCodeCheck(code: string) {
  return useQuery({
    queryKey: subscriptionsKeys.inviteCode(code),
    queryFn: () => fetchInviteCodeCheck(code),
    enabled: code.length > 0,
    retry: retryPublisher,
    staleTime: 30_000,
  })
}

export function useMySubscriptions() {
  const { did, keyDid } = useViewerDid()
  return useAuthedQuery<Subscription[]>(subscriptionsKeys.mine(keyDid), (token) => fetchMySubscriptions(token), {
    enabled: !!did,
    retry: retryPublisher,
    // A fresh licence is ISSUED and its environment appears a little later: poll until settled.
    refetchInterval: (query) =>
      query.state.data?.some(
        (s) => s.status === 'ISSUED' || (s.mode === 'DEDICATED' && isLive(s) && !s.environmentId),
      )
        ? SETTLING_POLL_MS
        : false,
    refetchIntervalInBackground: false,
  })
}

/**
 * Studio licence. `null` means "not known yet" (no bearer token right after a
 * redirect), never "no licence": it keeps polling until a real answer arrives.
 */
export function useStudioAccess() {
  const { did, keyDid } = useViewerDid()
  return useAuthedQuery<StudioAccess | null>(
    subscriptionsKeys.studioAccess(keyDid),
    (token) => (token ? fetchStudioAccess(token) : Promise.resolve(null)),
    {
      enabled: !!did,
      retry: retryPublisher,
      staleTime: 60_000,
      refetchInterval: (query) => (query.state.data === null ? 2_000 : false),
    },
  )
}

function useSubscriptionsMutation<V, R>(fn: (vars: V, token: string | null) => Promise<R>) {
  const qc = useQueryClient()
  const token = usePublisherToken()
  return useMutation<R, Error, V>({
    mutationFn: async (vars) => fn(vars, await token()),
    // Redeeming the studio code changes studioAccess too, so drop every subscription query.
    onSuccess: () => void qc.invalidateQueries({ queryKey: subscriptionsKeys.all }),
  })
}

export const useRedeemInviteCode = () =>
  useSubscriptionsMutation<RedeemInviteCodeInput, Subscription>((input, t) => redeemInviteCode(input, t))

export const useCancelSubscription = () =>
  useSubscriptionsMutation<{ licenseId: string }, boolean>(({ licenseId }, t) => cancelSubscription(licenseId, t))

export function useSubscriptionForEnvironment(environmentId: string) {
  const subs = useMySubscriptions()
  const matches = (subs.data ?? []).filter((s) => s.environmentId === environmentId)
  return {
    subscription: matches.find(isLive) ?? matches[0],
    isPending: subs.isPending && subs.fetchStatus !== 'idle',
  }
}
```

- [ ] **Step 8: Run tests and typecheck**

Run: `pnpm vitest run --config vitest.unit.config.ts modules/subscriptions && pnpm tsc`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add modules/subscriptions
git commit -m "feat(subscriptions): client and hooks for an owner's subscriptions, redemption and studio access"
```

---

### Task 10: Subscriptions page and nav

**Files:**
- Create: `modules/shared/components/renown/require-login.tsx`
- Create: `modules/subscriptions/components/subscriptions-view.tsx`, `subscription-card.tsx`, `warning-banner.tsx`, `cancel-dialog.tsx`
- Create: `app/user/subscriptions/page.tsx`
- Modify: `modules/shared/components/navbar/navbar-config.tsx`, `modules/shared/components/navbar/components/navbar-right-side.tsx`, `modules/shared/components/navbar/__tests__/navbar-config.test.ts`
- Test: `modules/shared/components/renown/__tests__/require-login.test.tsx`, `modules/subscriptions/__tests__/subscription-card.test.tsx`, `subscriptions-view.test.tsx`

**Interfaces:**
- Consumes: Task 9 hooks/lib; `Banner` (Task 3); `StatusPill`; `useOpenLogin`; `useRenownAuthAsync`.
- Produces: `RequireLogin({ children, title?, description? })`; `SubscriptionsView()`; `SubscriptionCard({ subscription, highlighted, onCancel })`; `WarningBanner({ warning })`; `CancelDialog({ subscription, onClose })`.

- [ ] **Step 1: Write the failing tests**

`modules/shared/components/renown/__tests__/require-login.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import React from 'react'

let state = 'resolving'
const openLogin = vi.fn()
vi.mock('@powerhousedao/reactor-browser', () => ({ useRenownAuthAsync: () => ({ state }) }))
vi.mock('@/modules/shared/components/renown/login-modal-context', () => ({ useOpenLogin: () => openLogin }))

import { RequireLogin } from '../require-login'

describe('RequireLogin', () => {
  beforeEach(() => cleanup())

  it('shows a skeleton while Renown resolves', () => {
    state = 'resolving'
    render(<RequireLogin>secret</RequireLogin>)
    expect(screen.getByRole('status', { name: /checking your login/i })).toBeTruthy()
    expect(screen.queryByText('secret')).toBeNull()
  })

  it('asks a logged-out visitor to log in', () => {
    state = 'unauthenticated'
    render(<RequireLogin title="See your subscriptions">secret</RequireLogin>)
    expect(screen.getByRole('heading', { name: 'See your subscriptions' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Log in with Renown' }))
    expect(openLogin).toHaveBeenCalled()
  })

  it('renders children once logged in', () => {
    state = 'authenticated'
    render(<RequireLogin>secret</RequireLogin>)
    expect(screen.getByText('secret')).toBeTruthy()
  })
})
```

`modules/subscriptions/__tests__/subscription-card.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import type { Subscription } from '../types'
import { SubscriptionCard } from '../components/subscription-card'

const sub = (over: Partial<Subscription> = {}): Subscription => ({
  licenseId: 'l1', appId: 'kv', appName: 'Knowledge Vault', kind: 'kv-pro', termLabel: 'Pro',
  issuer: 'INVITE_CODE', status: 'ACTIVE', start: '2026-10-01T00:00:00Z', end: '2026-10-31T00:00:00Z',
  mode: 'DEDICATED', environmentId: 'env-1', environmentLabel: 'Acme research', openUrl: 'https://acme.kv.vetra.io',
  stoppedAt: null, deleteAfter: null, warnings: [], ...over,
})

describe('SubscriptionCard', () => {
  beforeEach(() => cleanup())

  it('shows plan, status, environment and an Open button', () => {
    render(<SubscriptionCard subscription={sub()} highlighted={false} onCancel={vi.fn()} />)
    expect(screen.getByText('Pro')).toBeTruthy()
    expect(screen.getByText('Active')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Acme research' }).getAttribute('href')).toBe('/user/environments/env-1')
    const open = screen.getByRole('link', { name: /open/i })
    expect(open.getAttribute('href')).toBe('https://acme.kv.vetra.io')
    expect(open.getAttribute('target')).toBe('_blank')
  })

  it('shows every warning as a banner', () => {
    render(
      <SubscriptionCard
        subscription={sub({
          warnings: [
            { kind: 'EXPIRING', at: '2026-10-31T00:00:00Z', message: 'Your licence ends on Oct 31.' },
            { kind: 'DELETE_IMMINENT', at: '2027-01-29T00:00:00Z', message: 'Your environment is deleted tomorrow.' },
          ],
        })}
        highlighted={false}
        onCancel={vi.fn()}
      />,
    )
    expect(screen.getByText('Your licence ends on Oct 31.')).toBeTruthy()
    expect(screen.getByText('Your environment is deleted tomorrow.')).toBeTruthy()
  })

  it('offers Cancel only while live', () => {
    const onCancel = vi.fn()
    const { rerender } = render(<SubscriptionCard subscription={sub()} highlighted={false} onCancel={onCancel} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalled()
    rerender(<SubscriptionCard subscription={sub({ status: 'EXPIRED' })} highlighted={false} onCancel={onCancel} />)
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
  })

  it('describes a shared plan without an environment link', () => {
    render(<SubscriptionCard subscription={sub({ mode: 'SHARED', environmentId: null, environmentLabel: null })} highlighted={false} onCancel={vi.fn()} />)
    expect(screen.getByText('An account on Knowledge Vault')).toBeTruthy()
  })

  it('says a new environment is on its way', () => {
    render(<SubscriptionCard subscription={sub({ status: 'ISSUED', environmentId: null, environmentLabel: null, openUrl: null })} highlighted={false} onCancel={vi.fn()} />)
    expect(screen.getByText(/your environment is being set up/i)).toBeTruthy()
    expect(screen.queryByRole('link', { name: /open/i })).toBeNull()
  })
})
```

`modules/subscriptions/__tests__/subscriptions-view.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import React from 'react'
import type { Subscription } from '../types'

let subs: { data?: Subscription[]; isPending: boolean; error: Error | null }
let params = new URLSearchParams()
const cancel = vi.fn()
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('next/navigation', () => ({ useSearchParams: () => params }))
vi.mock('../hooks/use-subscriptions', () => ({
  useMySubscriptions: () => ({ ...subs, refetch: vi.fn(), isRefetching: false }),
  useCancelSubscription: () => ({ mutateAsync: cancel, isPending: false }),
}))

import { SubscriptionsView } from '../components/subscriptions-view'

const sub = (over: Partial<Subscription>): Subscription => ({
  licenseId: 'l1', appId: 'kv', appName: 'Knowledge Vault', kind: 'kv-pro', termLabel: 'Pro',
  issuer: 'INVITE_CODE', status: 'ACTIVE', start: '2026-10-01T00:00:00Z', end: null, mode: 'DEDICATED',
  environmentId: 'env-1', environmentLabel: 'Acme', openUrl: null, stoppedAt: null, deleteAfter: null,
  warnings: [], ...over,
})

describe('SubscriptionsView', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    params = new URLSearchParams()
  })

  it('explains what will show up here and links to /redeem', () => {
    subs = { data: [], isPending: false, error: null }
    render(<SubscriptionsView />)
    expect(screen.getByText('No subscriptions yet')).toBeTruthy()
    expect(screen.getAllByRole('link', { name: /redeem a code/i })[0].getAttribute('href')).toBe('/redeem')
  })

  it('groups by app and tucks ended ones away', () => {
    subs = {
      data: [sub({ licenseId: 'a' }), sub({ licenseId: 'b', status: 'EXPIRED' }), sub({ licenseId: 'c', appId: 'pf', appName: 'pfnuer' })],
      isPending: false,
      error: null,
    }
    render(<SubscriptionsView />)
    const kv = screen.getByRole('region', { name: 'Knowledge Vault' })
    expect(within(kv).getByTestId('subscription-a')).toBeTruthy()
    expect(within(kv).queryByTestId('subscription-b')).toBeNull()
    fireEvent.click(within(kv).getByRole('button', { name: 'Show 1 ended' }))
    expect(within(kv).getByTestId('subscription-b')).toBeTruthy()
    expect(screen.getByRole('region', { name: 'pfnuer' })).toBeTruthy()
  })

  it('highlights the subscription named in the URL', () => {
    params = new URLSearchParams('highlight=a')
    subs = { data: [sub({ licenseId: 'a' })], isPending: false, error: null }
    render(<SubscriptionsView />)
    expect(screen.getByTestId('subscription-a').getAttribute('data-highlighted')).toBe('true')
  })

  it('cancels after confirming, with dedicated-environment copy', async () => {
    subs = { data: [sub({ licenseId: 'a' })], isPending: false, error: null }
    cancel.mockResolvedValue(true)
    render(<SubscriptionsView />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByText(/keeps running for 14 days/i)).toBeTruthy()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Cancel subscription' })))
    expect(cancel).toHaveBeenCalledWith({ licenseId: 'a' })
  })
})
```

Update `modules/shared/components/navbar/__tests__/navbar-config.test.ts` — add:

```ts
it('links Subscriptions for logged-in users, right after Environments', () => {
  const labels = PRIVATE_NAV_ITEMS.map((i) => i.label)
  expect(labels.indexOf('Subscriptions')).toBe(labels.indexOf('Environments') + 1)
  const item = PRIVATE_NAV_ITEMS.find((i) => i.label === 'Subscriptions')
  expect(item?.href).toBe('/user/subscriptions')
  expect(item && 'isActive' in item && item.isActive ? item.isActive('/user/subscriptions') : false).toBe(true)
})
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm vitest run --config vitest.unit.config.ts modules/subscriptions modules/shared/components`
Expected: FAIL.

- [ ] **Step 3: Implement `require-login.tsx`**

```tsx
'use client'

import { useRenownAuthAsync } from '@powerhousedao/reactor-browser'
import { LogIn } from 'lucide-react'
import type { ReactNode } from 'react'
import { useOpenLogin } from '@/modules/shared/components/renown/login-modal-context'
import { Button } from '@/modules/shared/components/ui/button'
import { Skeleton } from '@/modules/shared/components/ui/skeleton'

/** Renown login only — no licence needed. Used by owner pages and the app page. */
export function RequireLogin({
  children,
  title = 'Log in to continue',
  description = 'Vetra uses Renown to know it is you. It takes a few seconds.',
}: {
  children: ReactNode
  title?: string
  description?: string
}) {
  const { state } = useRenownAuthAsync()
  const openLogin = useOpenLogin()

  if (state === 'authenticated') return <>{children}</>
  if (state === 'resolving') {
    return (
      <div role="status" aria-label="Checking your login" className="mx-auto mt-28 max-w-4xl space-y-4 px-6">
        <Skeleton className="h-8 w-1/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    )
  }
  return (
    <div className="mx-auto mt-28 flex max-w-md flex-col items-center gap-4 px-6 text-center">
      <span className="bg-primary/10 text-primary flex h-12 w-12 items-center justify-center rounded-2xl">
        <LogIn className="h-5 w-5" aria-hidden />
      </span>
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="text-muted-foreground text-sm">{description}</p>
      <Button size="lg" onClick={openLogin}>
        Log in with Renown
      </Button>
    </div>
  )
}
```

- [ ] **Step 4: Implement `warning-banner.tsx`, `subscription-card.tsx`, `cancel-dialog.tsx`**

`modules/subscriptions/components/warning-banner.tsx`:

```tsx
import { AlertTriangle, Clock } from 'lucide-react'
import { Banner } from '@/modules/apps/components/banner'
import { formatDate } from '@/modules/apps/lib/time'
import { warningTone } from '../lib/subscriptions'
import type { SubscriptionWarning } from '../types'

const TITLE: Record<string, string> = {
  EXPIRING: 'Ending soon',
  ENDED_STOP_PENDING: 'Your environment will stop',
  STOPPED_DELETE_PENDING: 'Your environment is stopped',
  DELETE_IMMINENT: 'Your environment will be deleted',
}

export function WarningBanner({ warning }: { warning: SubscriptionWarning }) {
  const tone = warningTone(warning.kind)
  return (
    <Banner tone={tone} icon={tone === 'danger' ? AlertTriangle : Clock} title={`${TITLE[warning.kind] ?? 'Heads up'} · ${formatDate(warning.at)}`}>
      {warning.message}
    </Banner>
  )
}
```

`modules/subscriptions/components/subscription-card.tsx`:

```tsx
'use client'

import { ArrowUpRight, Loader2, Server, Users } from 'lucide-react'
import Link from 'next/link'
import { StatusPill } from '@/modules/apps/components/status'
import { Button } from '@/modules/shared/components/ui/button'
import { cn } from '@/shared/lib/utils'
import {
  environmentHref,
  isLive,
  issuerText,
  subscriptionName,
  subscriptionStatusMeta,
  validityLine,
} from '../lib/subscriptions'
import type { Subscription } from '../types'
import { WarningBanner } from './warning-banner'

function EnvironmentLine({ s }: { s: Subscription }) {
  if (s.mode === 'SHARED') {
    return (
      <span className="inline-flex items-center gap-1.5">
        <Users className="h-4 w-4" aria-hidden />
        An account on {s.appName}
      </span>
    )
  }
  const href = environmentHref(s)
  if (href) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <Server className="h-4 w-4" aria-hidden />
        <Link href={href} className="text-foreground font-medium hover:underline">
          {s.environmentLabel || 'Your environment'}
        </Link>
      </span>
    )
  }
  if (isLive(s)) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        Your environment is being set up. This takes a minute or two.
      </span>
    )
  }
  return null
}

export function SubscriptionCard({
  subscription: s,
  highlighted,
  onCancel,
}: {
  subscription: Subscription
  highlighted: boolean
  onCancel: () => void
}) {
  return (
    <article
      id={`subscription-${s.licenseId}`}
      data-testid={`subscription-${s.licenseId}`}
      data-highlighted={highlighted ? 'true' : 'false'}
      className={cn(
        'bg-card border-border space-y-4 rounded-xl border p-5 shadow-sm transition-shadow',
        highlighted && 'ring-primary/60 shadow-md ring-2',
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">{subscriptionName(s)}</h3>
            <StatusPill meta={subscriptionStatusMeta(s.status)} />
          </div>
          <p className="text-muted-foreground text-sm">
            {validityLine(s)} · {issuerText(s.issuer)}
          </p>
          <p className="text-muted-foreground text-sm">
            <EnvironmentLine s={s} />
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          {isLive(s) && s.openUrl && (
            <Button asChild>
              <a href={s.openUrl} target="_blank" rel="noopener noreferrer">
                Open
                <ArrowUpRight className="h-4 w-4" />
              </a>
            </Button>
          )}
          {isLive(s) && (
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
      </div>
      {s.warnings.length > 0 && (
        <div className="space-y-2">
          {s.warnings.map((w) => (
            <WarningBanner key={`${w.kind}-${w.at}`} warning={w} />
          ))}
        </div>
      )}
    </article>
  )
}
```

`modules/subscriptions/components/cancel-dialog.tsx`:

```tsx
'use client'

import { Loader2 } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/modules/shared/components/ui/alert-dialog'
import { runWithToast } from '@/modules/publisher/lib/run'
import { useCancelSubscription } from '../hooks/use-subscriptions'
import { subscriptionName } from '../lib/subscriptions'
import type { Subscription } from '../types'

export function CancelDialog({ subscription, onClose }: { subscription: Subscription | null; onClose: () => void }) {
  const cancel = useCancelSubscription()
  const confirm = async () => {
    if (!subscription) return
    const ok = await runWithToast(() => cancel.mutateAsync({ licenseId: subscription.licenseId }), 'Subscription cancelled')
    if (ok) onClose()
  }
  return (
    <AlertDialog open={!!subscription} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Cancel {subscription ? `${subscriptionName(subscription)} on ${subscription.appName}` : 'subscription'}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {subscription?.mode === 'SHARED'
              ? `You lose access to ${subscription.appName} right away.`
              : 'Your environment keeps running for 14 days, then stops. Your data is kept for about three months before it is deleted — get a new licence before then and it comes back.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={cancel.isPending}>Keep it</AlertDialogCancel>
          <AlertDialogAction
            disabled={cancel.isPending}
            onClick={(e) => {
              e.preventDefault()
              void confirm()
            }}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {cancel.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Cancel subscription
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
```

- [ ] **Step 5: Implement `subscriptions-view.tsx` and the page**

`modules/subscriptions/components/subscriptions-view.tsx`:

```tsx
'use client'

import { BadgeCheck, Ticket } from 'lucide-react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useEffect, useState } from 'react'
import { EmptyState, TabError, TabSkeleton } from '@/modules/publisher/components/primitives'
import { Button } from '@/modules/shared/components/ui/button'
import { useMySubscriptions } from '../hooks/use-subscriptions'
import { groupByApp, type AppGroup } from '../lib/subscriptions'
import type { Subscription } from '../types'
import { CancelDialog } from './cancel-dialog'
import { SubscriptionCard } from './subscription-card'

function AppSection({
  group,
  highlight,
  onCancel,
}: {
  group: AppGroup
  highlight: string | null
  onCancel: (s: Subscription) => void
}) {
  const [showPast, setShowPast] = useState(group.past.some((s) => s.licenseId === highlight))
  const headingId = `app-${group.appId}`
  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id={headingId} className="text-lg font-semibold">
          {group.appName}
        </h2>
        <span className="text-muted-foreground text-sm">
          {group.live.length === 0 ? 'Nothing active' : `${group.live.length} active`}
        </span>
      </div>
      <div className="space-y-3">
        {group.live.map((s) => (
          <SubscriptionCard key={s.licenseId} subscription={s} highlighted={s.licenseId === highlight} onCancel={() => onCancel(s)} />
        ))}
        {showPast &&
          group.past.map((s) => (
            <SubscriptionCard key={s.licenseId} subscription={s} highlighted={s.licenseId === highlight} onCancel={() => onCancel(s)} />
          ))}
      </div>
      {group.past.length > 0 && (
        <Button variant="ghost" size="sm" onClick={() => setShowPast((x) => !x)}>
          {showPast ? 'Hide ended' : `Show ${group.past.length} ended`}
        </Button>
      )}
    </section>
  )
}

/** `/user/subscriptions` — everything I hold, grouped by app. */
export function SubscriptionsView() {
  const subs = useMySubscriptions()
  const params = useSearchParams()
  const highlight = params.get('highlight')
  const [cancelling, setCancelling] = useState<Subscription | null>(null)
  const groups = groupByApp(subs.data ?? [])

  // Bring a just-redeemed subscription into view once it has rendered.
  useEffect(() => {
    if (!highlight || !subs.data) return
    document.getElementById(`subscription-${highlight}`)?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
  }, [highlight, subs.data])

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1.5">
          <h1 className="text-3xl font-bold tracking-tight">Subscriptions</h1>
          <p className="text-muted-foreground max-w-2xl">
            Apps you have access to, how long for, and where they run.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href="/redeem">
            <Ticket className="h-4 w-4" />
            Redeem a code
          </Link>
        </Button>
      </div>
      {subs.isPending ? (
        <TabSkeleton rows={3} label="Loading subscriptions" />
      ) : subs.error ? (
        <TabError error={subs.error} onRetry={() => void subs.refetch()} retrying={subs.isRefetching} />
      ) : groups.length === 0 ? (
        <EmptyState
          icon={BadgeCheck}
          title="No subscriptions yet"
          action={
            <Button asChild>
              <Link href="/redeem">Redeem a code</Link>
            </Button>
          }
        >
          When an app gives you access — with an invite code or directly — it shows up here, with a
          button to open it.
        </EmptyState>
      ) : (
        <div className="space-y-10">
          {groups.map((g) => (
            <AppSection key={g.appId} group={g} highlight={highlight} onCancel={setCancelling} />
          ))}
        </div>
      )}
      <CancelDialog subscription={cancelling} onClose={() => setCancelling(null)} />
    </div>
  )
}
```

`app/user/subscriptions/page.tsx`:

```tsx
import { Suspense } from 'react'
import { RequireLogin } from '@/modules/shared/components/renown/require-login'
import { SubscriptionsView } from '@/modules/subscriptions/components/subscriptions-view'

export default function SubscriptionsPage() {
  return (
    <main className="mx-auto mt-20 max-w-4xl px-4 py-8 sm:px-6">
      <RequireLogin title="See your subscriptions">
        <Suspense fallback={null}>
          <SubscriptionsView />
        </Suspense>
      </RequireLogin>
    </main>
  )
}
```

- [ ] **Step 6: Add the nav item**

In `navbar-config.tsx` insert into `PRIVATE_NAV_ITEMS` right after the Environments item:

```tsx
{
  label: 'Subscriptions',
  href: '/user/subscriptions',
  isActive: (p) => p.startsWith('/user/subscriptions'),
},
```

In `navbar-right-side.tsx` add a dropdown entry after Environments (icon `BadgeCheck` from lucide-react):

```tsx
<DropdownMenuItem asChild className="cursor-pointer rounded-md px-3 py-2 text-sm font-medium">
  <Link href="/user/subscriptions">
    <BadgeCheck className="h-4 w-4" />
    Subscriptions
  </Link>
</DropdownMenuItem>
```

- [ ] **Step 7: Run tests, typecheck, lint**

Run: `pnpm vitest run --config vitest.unit.config.ts modules/subscriptions modules/shared && pnpm tsc && pnpm eslint modules/subscriptions modules/shared app/user/subscriptions`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add modules/subscriptions modules/shared app/user/subscriptions
git commit -m "feat(subscriptions): owner subscriptions page with offboarding banners, open and cancel"
```

---

### Task 11: `/redeem` and `/redeem/<code>`

**Files:**
- Create: `modules/subscriptions/lib/redeem.ts`
- Create: `modules/subscriptions/components/redeem/redeem-flow.tsx`, `redeem-code-form.tsx`, `redeem-steps.tsx`
- Create: `app/redeem/page.tsx`, `app/redeem/[code]/page.tsx`
- Test: `modules/subscriptions/__tests__/redeem-lib.test.ts`, `redeem-flow.test.tsx`, `redeem-page.test.tsx`

**Interfaces:**
- Consumes: `useInviteCodeCheck`, `useMySubscriptions`, `useRedeemInviteCode` (Task 9); `upgradeCandidates`, `subscriptionName`, `subscriptionHref` (Task 9); `isPublisherError`, `describePublisherError`; `redeemPath` from `@/modules/publisher/lib/invite-codes`; `useOpenLogin`; `useRenownAuthAsync`.
- Produces: `safeDecode(segment): string`; `type RedeemChoice = 'new' | { upgrades: string }`; `redeemInput({ code, choice, label, mode }): RedeemInviteCodeInput`; `RedeemFlow({ code })`; `RedeemCodeForm({ initial? })`.

- [ ] **Step 1: Write the failing tests**

`modules/subscriptions/__tests__/redeem-lib.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { redeemInput, safeDecode } from '../lib/redeem'

describe('redeem lib', () => {
  it('decodes a path segment once and survives a malformed one', () => {
    expect(safeDecode('LFC_2026-vip')).toBe('LFC_2026-vip')
    expect(safeDecode('ab%2Dc')).toBe('ab-c')
    expect(safeDecode('%E0%A4%A')).toBe('%E0%A4%A')
  })

  it('builds the input for each choice', () => {
    expect(redeemInput({ code: 'C', choice: 'new', label: ' Acme ', mode: 'DEDICATED' })).toEqual({ code: 'C', label: 'Acme' })
    expect(redeemInput({ code: 'C', choice: 'new', label: 'ignored', mode: 'SHARED' })).toEqual({ code: 'C' })
    expect(redeemInput({ code: 'C', choice: { upgrades: 'lic-1' }, label: 'x', mode: 'DEDICATED' })).toEqual({ code: 'C', upgrades: 'lic-1' })
  })
})
```

`modules/subscriptions/__tests__/redeem-flow.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { PublisherApiError } from '@/modules/publisher/graphql'
import type { InviteCodeCheck, Subscription } from '../types'

let check: { data?: InviteCodeCheck; isPending: boolean; error: Error | null }
let authState = 'unauthenticated'
let subs: Subscription[] = []
const redeem = vi.fn()
const push = vi.fn()
const openLogin = vi.fn()

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))
vi.mock('@powerhousedao/reactor-browser', () => ({ useRenownAuthAsync: () => ({ state: authState }) }))
vi.mock('@/modules/shared/components/renown/login-modal-context', () => ({ useOpenLogin: () => openLogin }))
vi.mock('../hooks/use-subscriptions', () => ({
  useInviteCodeCheck: () => check,
  useMySubscriptions: () => ({ data: subs, isPending: false, fetchStatus: 'idle' }),
  useRedeemInviteCode: () => ({ mutateAsync: redeem, isPending: false }),
}))

import { RedeemFlow } from '../components/redeem/redeem-flow'

const valid = (over: Partial<InviteCodeCheck> = {}): InviteCodeCheck => ({
  valid: true, appId: 'kv', appName: 'Knowledge Vault', kind: 'kv-pilot', termLabel: 'Pilot', mode: 'DEDICATED', ...over,
})
const sub = (over: Partial<Subscription>): Subscription => ({
  licenseId: 'l1', appId: 'kv', appName: 'Knowledge Vault', kind: 'kv-free', termLabel: 'Free',
  issuer: 'INVITE_CODE', status: 'ACTIVE', start: '2026-10-01T00:00:00Z', end: null, mode: 'DEDICATED',
  environmentId: 'env-1', environmentLabel: 'Acme', openUrl: null, stoppedAt: null, deleteAfter: null, warnings: [], ...over,
})

describe('RedeemFlow', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    subs = []
    authState = 'unauthenticated'
  })

  it('says an invalid code is invalid before asking anyone to log in', () => {
    check = { data: { valid: false, appId: null, appName: null, kind: null, termLabel: null, mode: null }, isPending: false, error: null }
    render(<RedeemFlow code="NOPE" />)
    expect(screen.getByText('This code can’t be used')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Log in with Renown' })).toBeNull()
    expect(screen.getByRole('link', { name: /try another code/i }).getAttribute('href')).toBe('/redeem')
  })

  it('shows what the code gives, then asks to log in', () => {
    check = { data: valid(), isPending: false, error: null }
    render(<RedeemFlow code="KV-PILOT" />)
    expect(screen.getByRole('heading', { name: 'Knowledge Vault' })).toBeTruthy()
    expect(screen.getByText('Pilot')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Log in with Renown' }))
    expect(openLogin).toHaveBeenCalled()
  })

  it('asks a project name for a dedicated plan and lands on the new subscription', async () => {
    authState = 'authenticated'
    check = { data: valid(), isPending: false, error: null }
    redeem.mockResolvedValue(sub({ licenseId: 'new-1', termLabel: 'Pilot' }))
    render(<RedeemFlow code="KV-PILOT" />)
    const button = screen.getByRole('button', { name: 'Get access' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Acme research' } })
    await act(async () => fireEvent.click(button))
    expect(redeem).toHaveBeenCalledWith({ code: 'KV-PILOT', label: 'Acme research' })
    expect(push).toHaveBeenCalledWith('/user/subscriptions?highlight=new-1')
  })

  it('needs no name for a shared plan', async () => {
    authState = 'authenticated'
    check = { data: valid({ mode: 'SHARED' }), isPending: false, error: null }
    redeem.mockResolvedValue(sub({ licenseId: 'new-2' }))
    render(<RedeemFlow code="FREE" />)
    expect(screen.queryByLabelText('Project name')).toBeNull()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Get access' })))
    expect(redeem).toHaveBeenCalledWith({ code: 'FREE' })
  })

  it('offers to upgrade a live licence of the same app, and only that', async () => {
    authState = 'authenticated'
    check = { data: valid(), isPending: false, error: null }
    subs = [sub({ licenseId: 'live' }), sub({ licenseId: 'ended', status: 'EXPIRED', termLabel: 'Old' })]
    redeem.mockResolvedValue(sub({ licenseId: 'new-3' }))
    render(<RedeemFlow code="KV-PILOT" />)
    expect(screen.queryByRole('radio', { name: /upgrade old/i })).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: /upgrade free/i }))
    expect(screen.queryByLabelText('Project name')).toBeNull()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Get access' })))
    expect(redeem).toHaveBeenCalledWith({ code: 'KV-PILOT', upgrades: 'live' })
  })

  it('explains ALREADY_HOLDS and links to subscriptions', async () => {
    authState = 'authenticated'
    check = { data: valid({ mode: 'SHARED' }), isPending: false, error: null }
    redeem.mockRejectedValue(new PublisherApiError('ALREADY_HOLDS', 'already holds kv-pilot', 200))
    render(<RedeemFlow code="FREE" />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Get access' })))
    expect(screen.getByText('You already have this plan')).toBeTruthy()
    expect(screen.getByRole('link', { name: /see your subscriptions/i }).getAttribute('href')).toBe('/user/subscriptions')
    expect(push).not.toHaveBeenCalled()
  })
})
```

`modules/subscriptions/__tests__/redeem-page.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import React from 'react'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))

import { RedeemCodeForm } from '../components/redeem/redeem-code-form'

describe('RedeemCodeForm', () => {
  beforeEach(() => {
    cleanup()
    push.mockClear()
  })

  it('goes to /redeem/<code> with the code unchanged', () => {
    render(<RedeemCodeForm />)
    fireEvent.change(screen.getByLabelText('Invite code'), { target: { value: '  LFC_2026-vip ' } })
    fireEvent.submit(screen.getByRole('form', { name: 'Redeem an invite code' }))
    expect(push).toHaveBeenCalledWith('/redeem/LFC_2026-vip')
  })

  it('encodes characters that are not URL-safe', () => {
    render(<RedeemCodeForm />)
    fireEvent.change(screen.getByLabelText('Invite code'), { target: { value: 'a/b c' } })
    fireEvent.submit(screen.getByRole('form', { name: 'Redeem an invite code' }))
    expect(push).toHaveBeenCalledWith('/redeem/a%2Fb%20c')
  })

  it('does nothing for an empty code', () => {
    render(<RedeemCodeForm />)
    fireEvent.submit(screen.getByRole('form', { name: 'Redeem an invite code' }))
    expect(push).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm vitest run --config vitest.unit.config.ts modules/subscriptions/__tests__/redeem`
Expected: FAIL.

- [ ] **Step 3: Implement `lib/redeem.ts`**

```ts
import type { RedeemInviteCodeInput } from '../types'

/** Decode a URL path segment once; a malformed escape is returned as typed. */
export function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

export type RedeemChoice = 'new' | { upgrades: string }

export function redeemInput({
  code,
  choice,
  label,
  mode,
}: {
  code: string
  choice: RedeemChoice
  label: string
  mode: string | null
}): RedeemInviteCodeInput {
  if (choice !== 'new') return { code, upgrades: choice.upgrades }
  if (mode === 'DEDICATED') return { code, label: label.trim() || null }
  return { code }
}
```

- [ ] **Step 4: Implement `redeem-steps.tsx` and `redeem-code-form.tsx`**

`modules/subscriptions/components/redeem/redeem-steps.tsx`:

```tsx
import { Check } from 'lucide-react'
import { cn } from '@/shared/lib/utils'

const STEPS = ['Check code', 'Log in', 'Set up'] as const

/** 1-based current step. */
export function RedeemSteps({ current }: { current: 1 | 2 | 3 }) {
  return (
    <ol className="flex items-center gap-2 text-xs sm:gap-3" aria-label="Progress">
      {STEPS.map((label, i) => {
        const n = i + 1
        const done = n < current
        return (
          <li key={label} className="flex items-center gap-2" aria-current={n === current ? 'step' : undefined}>
            <span
              className={cn(
                'flex h-6 w-6 items-center justify-center rounded-full border text-[11px] font-semibold',
                done && 'bg-primary border-primary text-primary-foreground',
                n === current && 'border-primary text-primary',
                n > current && 'border-border text-muted-foreground',
              )}
            >
              {done ? <Check className="h-3.5 w-3.5" aria-hidden /> : n}
            </span>
            <span className={cn('hidden sm:inline', n === current ? 'text-foreground font-medium' : 'text-muted-foreground')}>
              {label}
            </span>
            {n < STEPS.length && <span className="bg-border h-px w-6 sm:w-10" aria-hidden />}
          </li>
        )
      })}
    </ol>
  )
}
```

`modules/subscriptions/components/redeem/redeem-code-form.tsx`:

```tsx
'use client'

import { ArrowRight } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'
import { redeemPath } from '@/modules/publisher/lib/invite-codes'
import { Button } from '@/modules/shared/components/ui/button'
import { Input } from '@/modules/shared/components/ui/input'

export function RedeemCodeForm({ initial = '' }: { initial?: string }) {
  const router = useRouter()
  const [code, setCode] = useState(initial)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const trimmed = code.trim()
    if (trimmed) router.push(redeemPath(trimmed))
  }
  return (
    <form onSubmit={submit} aria-label="Redeem an invite code" className="flex flex-col gap-2 sm:flex-row">
      <Input
        aria-label="Invite code"
        placeholder="Enter your code"
        className="h-11 font-mono text-base"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        value={code}
        onChange={(e) => setCode(e.target.value)}
      />
      <Button type="submit" size="lg" className="h-11">
        Continue
        <ArrowRight className="h-4 w-4" />
      </Button>
    </form>
  )
}
```

- [ ] **Step 5: Implement `redeem-flow.tsx`**

```tsx
'use client'

import { useRenownAuthAsync } from '@powerhousedao/reactor-browser'
import { ArrowRight, Loader2, Server, Ticket, Users, XCircle } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { describePublisherError, isPublisherError } from '@/modules/publisher/graphql'
import { useOpenLogin } from '@/modules/shared/components/renown/login-modal-context'
import { Alert, AlertDescription, AlertTitle } from '@/modules/shared/components/ui/alert'
import { Button } from '@/modules/shared/components/ui/button'
import { Input } from '@/modules/shared/components/ui/input'
import { Label } from '@/modules/shared/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/modules/shared/components/ui/radio-group'
import { Skeleton } from '@/modules/shared/components/ui/skeleton'
import { useInviteCodeCheck, useMySubscriptions, useRedeemInviteCode } from '../../hooks/use-subscriptions'
import { redeemInput, type RedeemChoice } from '../../lib/redeem'
import { subscriptionHref, subscriptionName, upgradeCandidates } from '../../lib/subscriptions'
import { RedeemSteps } from './redeem-steps'

const NEW = 'new'

function Shell({ step, children }: { step: 1 | 2 | 3; children: ReactNode }) {
  return (
    <div className="bg-card border-border space-y-6 rounded-2xl border p-6 shadow-sm sm:p-8">
      <RedeemSteps current={step} />
      {children}
    </div>
  )
}

export function RedeemFlow({ code }: { code: string }) {
  const check = useInviteCodeCheck(code)
  const { state } = useRenownAuthAsync()
  const openLogin = useOpenLogin()
  const subs = useMySubscriptions()
  const redeem = useRedeemInviteCode()
  const router = useRouter()
  const [choice, setChoice] = useState<string>(NEW)
  const [label, setLabel] = useState('')
  const [error, setError] = useState<unknown>(null)

  if (check.isPending) {
    return (
      <Shell step={1}>
        <div role="status" aria-label="Checking your code" className="space-y-3">
          <Skeleton className="h-8 w-1/2" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      </Shell>
    )
  }

  if (check.error || !check.data?.valid) {
    return (
      <Shell step={1}>
        <div className="space-y-4 text-center">
          <XCircle className="text-destructive mx-auto h-10 w-10" aria-hidden />
          <h1 className="text-xl font-semibold">This code can’t be used</h1>
          <p className="text-muted-foreground text-sm">
            {check.error
              ? describePublisherError(check.error)
              : 'It may be mistyped, paused, expired or used up. Check the link you were sent, or ask whoever shared it.'}
          </p>
          <Button asChild variant="outline">
            <Link href="/redeem">Try another code</Link>
          </Button>
        </div>
      </Shell>
    )
  }

  const info = check.data
  const dedicated = info.mode === 'DEDICATED'
  const candidates = info.appId ? upgradeCandidates(subs.data ?? [], info.appId) : []
  const redeemChoice: RedeemChoice = choice === NEW ? 'new' : { upgrades: choice }
  const needsName = dedicated && choice === NEW
  const authenticated = state === 'authenticated'

  const hero = (
    <div className="space-y-2">
      <p className="text-muted-foreground inline-flex items-center gap-1.5 text-sm">
        <Ticket className="h-4 w-4" aria-hidden />
        Invite code <span className="text-foreground font-mono">{code}</span>
      </p>
      <h1 className="text-3xl font-bold tracking-tight">{info.appName}</h1>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="bg-primary/10 text-primary rounded-full px-2.5 py-0.5 font-medium">
          {info.termLabel || info.kind}
        </span>
        <span className="text-muted-foreground inline-flex items-center gap-1.5">
          {dedicated ? <Server className="h-4 w-4" aria-hidden /> : <Users className="h-4 w-4" aria-hidden />}
          {dedicated ? 'Your own environment' : `An account on ${info.appName}`}
        </span>
      </div>
    </div>
  )

  if (!authenticated) {
    return (
      <Shell step={2}>
        {hero}
        <div className="border-border space-y-3 border-t pt-6">
          <p className="text-muted-foreground text-sm">Log in with Renown to claim it. No wallet needed in advance.</p>
          <Button size="lg" onClick={openLogin} disabled={state === 'resolving'}>
            {state === 'resolving' && <Loader2 className="h-4 w-4 animate-spin" />}
            Log in with Renown
          </Button>
        </div>
      </Shell>
    )
  }

  const submit = async () => {
    setError(null)
    try {
      const sub = await redeem.mutateAsync(redeemInput({ code, choice: redeemChoice, label, mode: info.mode }))
      toast.success(`${subscriptionName(sub)} is yours`)
      router.push(subscriptionHref(sub.licenseId))
    } catch (err) {
      setError(err)
    }
  }

  return (
    <Shell step={3}>
      {hero}
      <div className="border-border space-y-5 border-t pt-6">
        {candidates.length > 0 && (
          <div className="space-y-2">
            <Label>You already have {info.appName}</Label>
            <RadioGroup value={choice} onValueChange={setChoice} className="space-y-2">
              {candidates.map((s) => (
                <label key={s.licenseId} className="border-border has-[[data-state=checked]]:border-primary flex cursor-pointer items-start gap-3 rounded-xl border p-3">
                  <RadioGroupItem value={s.licenseId} aria-label={`Upgrade ${subscriptionName(s)}`} className="mt-1" />
                  <span>
                    <span className="block text-sm font-medium">Upgrade {subscriptionName(s)}</span>
                    <span className="text-muted-foreground block text-xs">
                      {s.environmentLabel ? `${s.environmentLabel} keeps its data and switches to the new plan.` : 'Your access switches to the new plan.'}
                    </span>
                  </span>
                </label>
              ))}
              <label className="border-border has-[[data-state=checked]]:border-primary flex cursor-pointer items-start gap-3 rounded-xl border p-3">
                <RadioGroupItem value={NEW} aria-label="Start something new" className="mt-1" />
                <span>
                  <span className="block text-sm font-medium">Start something new</span>
                  <span className="text-muted-foreground block text-xs">
                    {dedicated ? 'A second environment, for a different project.' : 'Keep what you have and add this.'}
                  </span>
                </span>
              </label>
            </RadioGroup>
          </div>
        )}
        {needsName && (
          <div className="space-y-1.5">
            <Label htmlFor="project-name">Project name</Label>
            <Input
              id="project-name"
              placeholder="e.g. Acme research"
              value={label}
              maxLength={60}
              onChange={(e) => setLabel(e.target.value)}
            />
            <p className="text-muted-foreground text-xs">Your environment is called this. You can have several.</p>
          </div>
        )}
        {error !== null && (
          <Alert variant={isPublisherError(error, 'ALREADY_HOLDS') ? 'default' : 'destructive'}>
            <AlertTitle>
              {isPublisherError(error, 'ALREADY_HOLDS')
                ? 'You already have this plan'
                : isPublisherError(error, 'INVALID_CODE')
                  ? 'This code can’t be used any more'
                  : 'That did not work'}
            </AlertTitle>
            <AlertDescription className="space-y-2">
              <p>{describePublisherError(error)}</p>
              {isPublisherError(error, 'ALREADY_HOLDS') && (
                <Link href="/user/subscriptions" className="text-primary font-medium hover:underline">
                  See your subscriptions
                </Link>
              )}
            </AlertDescription>
          </Alert>
        )}
        <Button size="lg" className="w-full sm:w-auto" onClick={submit} disabled={redeem.isPending || (needsName && !label.trim())}>
          {redeem.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Get access
          {!redeem.isPending && <ArrowRight className="h-4 w-4" />}
        </Button>
      </div>
    </Shell>
  )
}
```

- [ ] **Step 6: Implement the pages**

`app/redeem/page.tsx`:

```tsx
import { Ticket } from 'lucide-react'
import { RedeemCodeForm } from '@/modules/subscriptions/components/redeem/redeem-code-form'

export const metadata = { title: 'Redeem a code · Vetra' }

export default function RedeemPage() {
  return (
    <main className="mx-auto mt-24 max-w-xl px-4 py-10 sm:px-6">
      <div className="bg-card border-border space-y-6 rounded-2xl border p-6 shadow-sm sm:p-8">
        <span className="bg-primary/10 text-primary flex h-12 w-12 items-center justify-center rounded-2xl">
          <Ticket className="h-5 w-5" aria-hidden />
        </span>
        <div className="space-y-1.5">
          <h1 className="text-2xl font-bold tracking-tight">Redeem an invite code</h1>
          <p className="text-muted-foreground text-sm">
            Got a code from an app or an event? Enter it to see what it gives you.
          </p>
        </div>
        <RedeemCodeForm />
      </div>
    </main>
  )
}
```

`app/redeem/[code]/page.tsx`:

```tsx
'use client'

import { use } from 'react'
import { RedeemFlow } from '@/modules/subscriptions/components/redeem/redeem-flow'
import { safeDecode } from '@/modules/subscriptions/lib/redeem'

export default function RedeemCodePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params)
  return (
    <main className="mx-auto mt-24 max-w-xl px-4 py-10 sm:px-6">
      <RedeemFlow code={safeDecode(code)} />
    </main>
  )
}
```

`/redeem` is outside `proxy.ts`'s matcher (`/user/:path*`, `/profile/:path*`), so it is public by construction; do not add it to the matcher.

- [ ] **Step 7: Run tests, typecheck, lint**

Run: `pnpm vitest run --config vitest.unit.config.ts modules/subscriptions && pnpm tsc && pnpm eslint modules/subscriptions app/redeem`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add modules/subscriptions app/redeem
git commit -m "feat(subscriptions): shareable /redeem/<code> flow with new-project and upgrade choices"
```

---

### Task 12: Studio licence gate replaces the invite-code gate

**Files:**
- Create: `modules/cloud/studio/pool-client.ts` (`fetchStudioPoolVersion`, `claimStudioEnvironment`, `ClaimStudioEnvironmentResult` moved verbatim from `modules/invites/lib/client.ts`, together with its private `readEnv`, `getEndpoint`, `gql` helpers)
- Create: `modules/studio-license/components/studio-license-gate.tsx`, `no-licence-panel.tsx`
- Move: `modules/invites/pre-alpha-warning-dialog.tsx` → `modules/studio-license/components/pre-alpha-warning-dialog.tsx` (`git mv`, content unchanged except the doc comment's second paragraph: "Shown once per browser the first time a studio licence is seen.")
- Move: `modules/invites/lib/__tests__/claim-studio-environment.test.ts` → `modules/cloud/__tests__/claim-studio-environment.test.ts` (import `../studio/pool-client`)
- Modify: `modules/cloud/__tests__/studio-pool-version.test.ts` (import `@/modules/cloud/studio/pool-client`)
- Modify: `modules/cloud/studio/use-create-studio-environment.ts`, `modules/cloud/__tests__/use-create-studio-environment.test.tsx`
- Modify: `modules/cloud/studio/use-studio-products.ts`
- Modify: `app/user/page.tsx`, `app/user/studio/page.tsx`, `app/user/apps/new/page.tsx`, `app/user/apps/[id]/page.tsx`, `app/user/environments/page.tsx`, `app/user/environments/new/page.tsx`
- Modify: `modules/home/components/hero-terminal.tsx` (comment now points at `modules/studio-license/components/no-licence-panel.tsx`)
- Delete: `modules/invites/` (whole directory)
- Test: `modules/studio-license/__tests__/studio-license-gate.test.tsx`

**Interfaces:**
- Consumes: `useStudioAccess`, `applyStudioKey` (Task 9); `RequireLogin` (Task 10); `CopyButton`.
- Produces: `StudioLicenseGate({ children })`; `NoLicencePanel()`.

- [ ] **Step 1: Write the failing gate test**

`modules/studio-license/__tests__/studio-license-gate.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { PublisherApiError } from '@/modules/publisher/graphql'

let access: { data?: unknown; isPending: boolean; error: Error | null; isRefetching?: boolean }
const refetch = vi.fn()
vi.mock('@/modules/shared/components/renown/require-login', () => ({
  RequireLogin: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock('@/modules/subscriptions/hooks/use-subscriptions', () => ({
  useStudioAccess: () => ({ ...access, refetch }),
}))

import { StudioLicenseGate } from '../components/studio-license-gate'

describe('StudioLicenseGate', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    localStorage.setItem('vetra_prealpha_ack', '1')
  })

  it('shows a skeleton while access is unknown, including the token-not-ready null', () => {
    access = { data: null, isPending: false, error: null }
    render(<StudioLicenseGate>studio</StudioLicenseGate>)
    expect(screen.getByRole('status', { name: /checking your studio access/i })).toBeTruthy()
    expect(screen.queryByText('studio')).toBeNull()
  })

  it('opens the studio for a licence holder', () => {
    access = { data: { allowed: true, licenseId: 'l', expires: null, hasAttachedKey: true }, isPending: false, error: null }
    render(<StudioLicenseGate>studio</StudioLicenseGate>)
    expect(screen.getByText('studio')).toBeTruthy()
  })

  it('points everyone else at /redeem', () => {
    access = { data: { allowed: false, licenseId: null, expires: null, hasAttachedKey: false }, isPending: false, error: null }
    render(<StudioLicenseGate>studio</StudioLicenseGate>)
    expect(screen.getByRole('heading', { name: /vetra studio is in early access/i })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Redeem a code' }).getAttribute('href')).toBe('/redeem')
  })

  it('never tells a licensed user to redeem a code when the check fails', () => {
    access = { data: undefined, isPending: false, error: new PublisherApiError('NETWORK', 'fetch failed', null) }
    render(<StudioLicenseGate>studio</StudioLicenseGate>)
    expect(screen.queryByRole('link', { name: 'Redeem a code' })).toBeNull()
    expect(screen.getByText(/lost the connection to vetra/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(refetch).toHaveBeenCalled()
  })

  it('shows the pre-alpha notice once per browser', () => {
    localStorage.removeItem('vetra_prealpha_ack')
    access = { data: { allowed: true, licenseId: 'l', expires: null, hasAttachedKey: true }, isPending: false, error: null }
    render(<StudioLicenseGate>studio</StudioLicenseGate>)
    expect(screen.getByRole('dialog')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm vitest run --config vitest.unit.config.ts modules/studio-license`
Expected: FAIL — module not found.

- [ ] **Step 3: Move the pool client and switch the studio to `applyStudioKey`**

```bash
git mv modules/invites/pre-alpha-warning-dialog.tsx modules/studio-license/components/pre-alpha-warning-dialog.tsx
git mv modules/invites/lib/__tests__/claim-studio-environment.test.ts modules/cloud/__tests__/claim-studio-environment.test.ts
```

Create `modules/cloud/studio/pool-client.ts` containing, verbatim from `modules/invites/lib/client.ts`: `readEnv`, `getEndpoint`, `GqlResponse`, `gql`, `fetchStudioPoolVersion`, `ClaimStudioEnvironmentResult`, `claimStudioEnvironment` (with their doc comments; replace the file header comment with `// Browser client for the VetraStudioPool namespace on the cloud Switchboard.`). In the moved test change the import to `import { claimStudioEnvironment } from '../studio/pool-client'`; in `studio-pool-version.test.ts` change it to `import { fetchStudioPoolVersion } from '@/modules/cloud/studio/pool-client'`.

In `modules/cloud/studio/use-create-studio-environment.ts` replace the `@/modules/invites/lib/client` import with:

```ts
import { claimStudioEnvironment, fetchStudioPoolVersion } from './pool-client'
import { applyStudioKey } from '@/modules/subscriptions/graphql'
```

and replace the server-side key branch with:

```ts
      } else {
        // Inject the Claude key attached to the caller's studio licence, server-side.
        const token = await getAuthToken(renown)
        if (!token) throw new Error('Could not authenticate to provision the studio key')
        const injected = await applyStudioKey(tenantId, [...STUDIO_ANTHROPIC_SECRET_NAMES], token)
        if (!injected) {
          throw new Error('No Anthropic API key is available for your studio licence')
        }
      }
```

Update the doc comment bullet "omitted → asked of the vetra-access-codes subgraph…" to "omitted → `vetraSubscriptions.applyStudioKey` writes the key attached to the caller's studio licence into the tenant secret store server-side."

In `modules/cloud/__tests__/use-create-studio-environment.test.tsx` replace the invites mock and import with:

```ts
vi.mock('@/modules/cloud/studio/pool-client', () => ({
  claimStudioEnvironment: vi.fn(),
  fetchStudioPoolVersion: vi.fn().mockResolvedValue(null),
}))
vi.mock('@/modules/subscriptions/graphql', () => ({ applyStudioKey: vi.fn() }))

import { claimStudioEnvironment } from '@/modules/cloud/studio/pool-client'
import { applyStudioKey } from '@/modules/subscriptions/graphql'
```

then rename every `applyInviteCodeSecret` to `applyStudioKey`, change `mockResolvedValue({ injected: true, secretNames: [...] })` to `mockResolvedValue(true)`, `mockResolvedValue({ injected: false, secretNames: [] })` to `mockResolvedValue(false)`, and the error regex stays `/no anthropic api key/i`. The `[tenantId, secretNames]` destructuring of `mock.calls[0]` is unchanged (the token is now the third argument).

In `modules/cloud/studio/use-studio-products.ts` replace the `myAccessStatus` import and the `useAuthedQuery(['vetra-access-status', did], …)` block with:

```ts
import { useStudioAccess } from '@/modules/subscriptions/hooks/use-subscriptions'
// …
  // Whether the caller's studio licence carries a Claude key, so creating a studio
  // can skip the manual key prompt. useStudioAccess polls while the answer is
  // still unknown (null), so a fresh login never wrongly prompts for a key.
  const { data: access } = useStudioAccess()
  const hasAttachedKey = access?.hasAttachedKey ?? false
```

- [ ] **Step 4: Implement the gate and the no-licence panel**

`modules/studio-license/components/no-licence-panel.tsx`:

```tsx
'use client'

import { BookOpen, ExternalLink, Github, Mail, MessageCircle, Sparkles, Terminal, Ticket } from 'lucide-react'
import Link from 'next/link'
import { CopyButton } from '@/modules/apps/components/copy-button'
import { Button } from '@/modules/shared/components/ui/button'

const DISCORD_URL = 'https://discord.gg/Py28EMafEr'
const CURL_CMD = 'curl -fsSL https://get.vetra.io | sh'
const NPM_CMD = 'npm install -g ph-cmd vetra'
const GITHUB_URL = 'https://github.com/powerhouse-inc/vetra-cli'
const WAITLIST_ACTION =
  'https://gmail.us21.list-manage.com/subscribe/post?u=a65ca7e437961008f5f5c1bad&id=c8ea339c46&f_id=00fda7e6f0'
const ACADEMY_URL = 'https://academy.vetra.io/academy/GetStarted/VetraStudio#running-vetra-studio-locally'

function Command({ cmd, label }: { cmd: string; label: string }) {
  return (
    <div className="bg-muted flex items-center gap-2 rounded-lg px-3 py-2">
      <span className="text-primary font-mono text-xs font-bold">$</span>
      <code className="min-w-0 flex-1 truncate font-mono text-xs">{cmd}</code>
      <CopyButton value={cmd} label={label} />
    </div>
  )
}

/** What a logged-in person without a studio licence sees on Studio and app creation. */
export function NoLicencePanel() {
  return (
    <main className="mx-auto mt-24 max-w-4xl space-y-6 px-4 py-10 sm:px-6">
      <section className="bg-card border-border relative overflow-hidden rounded-2xl border p-6 shadow-sm sm:p-10">
        <div aria-hidden className="bg-primary/10 pointer-events-none absolute -top-24 right-0 h-64 w-96 rounded-full blur-3xl" />
        <div className="relative space-y-4">
          <span className="bg-primary/10 text-primary flex h-12 w-12 items-center justify-center rounded-2xl">
            <Sparkles className="h-5 w-5" aria-hidden />
          </span>
          <h1 className="text-3xl font-bold tracking-tight">Vetra Studio is in early access</h1>
          <p className="text-muted-foreground max-w-xl">
            Building apps and running a studio needs an early-access licence. If someone gave you an
            invite code, redeem it and you are in.
          </p>
          <Button asChild size="lg">
            <Link href="/redeem">
              <Ticket className="h-4 w-4" />
              Redeem a code
            </Link>
          </Button>
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <section className="bg-card border-border space-y-4 rounded-2xl border p-5 shadow-sm">
          <h2 className="flex items-center gap-2 font-semibold">
            <Mail className="text-primary h-4 w-4" aria-hidden />
            No code yet?
          </h2>
          <p className="text-muted-foreground text-sm">Join the waitlist and we will send one when a spot opens.</p>
          <form action={WAITLIST_ACTION} method="post" target="_blank" className="flex gap-2">
            <input
              type="email"
              name="EMAIL"
              required
              aria-label="Email for the waitlist"
              placeholder="you@example.com"
              className="border-border bg-background focus:ring-primary/40 h-9 min-w-0 flex-1 rounded-lg border px-3 text-sm focus:ring-2 focus:outline-none"
            />
            <Button type="submit" size="sm" className="h-9">
              Join
            </Button>
          </form>
          <Button asChild variant="outline" size="sm">
            <Link href={DISCORD_URL} target="_blank" rel="noopener noreferrer">
              <MessageCircle className="h-4 w-4" />
              Ask for a code on Discord
            </Link>
          </Button>
        </section>

        <section className="bg-card border-border space-y-4 rounded-2xl border p-5 shadow-sm">
          <h2 className="flex items-center gap-2 font-semibold">
            <Terminal className="text-primary h-4 w-4" aria-hidden />
            Run it on your machine
          </h2>
          <p className="text-muted-foreground text-sm">No code needed: run Vetra locally with one command.</p>
          <Command cmd={CURL_CMD} label="Copy install script command" />
          <Command cmd={NPM_CMD} label="Copy npm install command" />
          <div className="flex flex-wrap gap-3 text-sm">
            <Link href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5">
              <Github className="h-4 w-4" aria-hidden />
              powerhouse-inc/vetra-cli
              <ExternalLink className="h-3 w-3" aria-hidden />
            </Link>
            <Link href={ACADEMY_URL} target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5">
              <BookOpen className="h-4 w-4" aria-hidden />
              Step-by-step guide
            </Link>
          </div>
        </section>
      </div>
    </main>
  )
}
```

`modules/studio-license/components/studio-license-gate.tsx`:

```tsx
'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { TabError } from '@/modules/publisher/components/primitives'
import { RequireLogin } from '@/modules/shared/components/renown/require-login'
import { Skeleton } from '@/modules/shared/components/ui/skeleton'
import { useStudioAccess } from '@/modules/subscriptions/hooks/use-subscriptions'
import { NoLicencePanel } from './no-licence-panel'
import { PreAlphaWarningDialog } from './pre-alpha-warning-dialog'

const PREALPHA_ACK_KEY = 'vetra_prealpha_ack'

function readAck(): boolean {
  try {
    return localStorage.getItem(PREALPHA_ACK_KEY) === '1'
  } catch {
    return true // storage blocked: do not nag on every visit
  }
}

function PreAlphaOnce() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reading localStorage after mount is hydration-safe
    if (!readAck()) setOpen(true)
  }, [])
  const acknowledge = () => {
    try {
      localStorage.setItem(PREALPHA_ACK_KEY, '1')
    } catch {
      /* storage blocked */
    }
    setOpen(false)
  }
  return <PreAlphaWarningDialog open={open} onAcknowledge={acknowledge} />
}

function LicenceCheck({ children }: { children: ReactNode }) {
  const access = useStudioAccess()
  if (access.data?.allowed) {
    return (
      <>
        {children}
        <PreAlphaOnce />
      </>
    )
  }
  // A failed check is not a "no": never send a licensed user to /redeem because the network blinked.
  if (access.error) {
    return (
      <div className="mx-auto mt-28 max-w-lg px-6">
        <TabError error={access.error} onRetry={() => void access.refetch()} retrying={access.isRefetching} />
      </div>
    )
  }
  if (access.isPending || access.data == null) {
    return (
      <div role="status" aria-label="Checking your studio access" className="mx-auto mt-28 max-w-4xl space-y-4 px-6">
        <Skeleton className="h-10 w-1/3" />
        <Skeleton className="h-48 w-full rounded-2xl" />
      </div>
    )
  }
  return <NoLicencePanel />
}

/** Gates Vetra Studio and app creation on a vetra-studio licence (decision D2). */
export function StudioLicenseGate({ children }: { children: ReactNode }) {
  return (
    <RequireLogin title="Log in to use Vetra Studio">
      <LicenceCheck>{children}</LicenceCheck>
    </RequireLogin>
  )
}
```

- [ ] **Step 5: Re-gate the pages and delete `modules/invites`**

`app/user/page.tsx`:

```tsx
import { RequireLogin } from '@/modules/shared/components/renown/require-login'
import { AppsHome } from './apps-home'

/** Logged-in home: apps, standalone environments, Studio. Creating an app is gated on its own page. */
export default function UserHomePage() {
  return (
    <RequireLogin>
      <AppsHome />
    </RequireLogin>
  )
}
```

`app/user/studio/page.tsx` and `app/user/apps/new/page.tsx`: replace `EarlyAccessGate` (import and JSX) with `StudioLicenseGate` from `@/modules/studio-license/components/studio-license-gate`.

`app/user/apps/[id]/page.tsx`: replace `EarlyAccessGate` with `RequireLogin` from `@/modules/shared/components/renown/require-login`.

`app/user/environments/new/page.tsx`: replace `EarlyAccessGate` with `StudioLicenseGate`; update the comment to "Creating an environment by hand is a builder action, gated on the Vetra Studio licence (decision D2)."

`app/user/environments/page.tsx`: drop the `EarlyAccessGate` import and render `<CloudDashboard />` directly when authenticated; update the doc comment's last paragraph to "Owners see environments that came with a licence here; only a Renown login is needed."

Then:

```bash
git rm -r modules/invites
grep -rn "modules/invites\|EarlyAccessGate\|VetraAccessCodes\|applyInviteCodeSecret\|myAccessStatus\|vetra-access-status" app modules tests
```

Expected: the grep prints nothing (fix `modules/home/components/hero-terminal.tsx`'s comment to reference `modules/studio-license/components/no-licence-panel.tsx`).

- [ ] **Step 6: Run tests, typecheck, lint**

Run: `pnpm vitest run --config vitest.unit.config.ts modules/studio-license modules/cloud && pnpm tsc && pnpm eslint modules app`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A app modules
git commit -m "feat(studio): gate Vetra Studio and app creation on the studio licence

Replaces the early-access invite-code gate. Subscriptions, owner environments
and /redeem only need a Renown login; studio key injection moves to
vetraSubscriptions.applyStudioKey."
```

---

### Task 13: Environments show the licence they came with

**Files:**
- Create: `modules/subscriptions/components/environment-licence.tsx`
- Modify: `app/user/environments/cloud-projects.tsx` (`CloudEnvironmentCard`), `app/user/environments/[project]/page.tsx` (`EnvironmentDetail`)
- Test: `modules/subscriptions/__tests__/environment-licence.test.tsx`

**Interfaces:**
- Consumes: `useSubscriptionForEnvironment` (Task 9); `subscriptionName`, `subscriptionHref`, `warningTone`, `subscriptionStatusMeta` (Task 9); `Banner` (Task 3).
- Produces: `EnvironmentLicenceBadge({ environmentId })` (compact, for cards) and `EnvironmentLicenceBanner({ environmentId })` (detail page). Both render nothing for environments without a subscription.

- [ ] **Step 1: Write the failing test**

`modules/subscriptions/__tests__/environment-licence.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import React from 'react'
import type { Subscription } from '../types'

let found: Subscription | undefined
vi.mock('../hooks/use-subscriptions', () => ({
  useSubscriptionForEnvironment: () => ({ subscription: found, isPending: false }),
}))

import { EnvironmentLicenceBadge, EnvironmentLicenceBanner } from '../components/environment-licence'

const sub = (over: Partial<Subscription> = {}): Subscription => ({
  licenseId: 'l1', appId: 'kv', appName: 'Knowledge Vault', kind: 'kv-pro', termLabel: 'Pro',
  issuer: 'INVITE_CODE', status: 'ACTIVE', start: null, end: null, mode: 'DEDICATED', environmentId: 'env-1',
  environmentLabel: 'Acme', openUrl: null, stoppedAt: null, deleteAfter: null, warnings: [], ...over,
})

describe('environment licence', () => {
  beforeEach(() => cleanup())

  it('renders nothing for a hand-made environment', () => {
    found = undefined
    const { container } = render(<><EnvironmentLicenceBadge environmentId="env-x" /><EnvironmentLicenceBanner environmentId="env-x" /></>)
    expect(container.textContent).toBe('')
  })

  it('names the app and plan and links the subscription', () => {
    found = sub()
    render(<EnvironmentLicenceBadge environmentId="env-1" />)
    expect(screen.getByText('Knowledge Vault · Pro')).toBeTruthy()
    expect(screen.getByRole('link', { name: /subscription/i }).getAttribute('href')).toBe('/user/subscriptions?highlight=l1')
  })

  it('shows the offboarding state on the detail banner', () => {
    found = sub({
      status: 'REVOKED',
      stoppedAt: '2026-10-22T00:00:00Z',
      warnings: [{ kind: 'STOPPED_DELETE_PENDING', at: '2027-01-20T00:00:00Z', message: 'Deleted on Jan 20 unless you renew.' }],
    })
    render(<EnvironmentLicenceBanner environmentId="env-1" />)
    expect(screen.getByText('Deleted on Jan 20 unless you renew.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'View subscription' }).getAttribute('href')).toBe('/user/subscriptions?highlight=l1')
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm vitest run --config vitest.unit.config.ts modules/subscriptions/__tests__/environment-licence.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement `environment-licence.tsx`**

```tsx
'use client'

import { BadgeCheck, Clock } from 'lucide-react'
import Link from 'next/link'
import { Banner } from '@/modules/apps/components/banner'
import { Button } from '@/modules/shared/components/ui/button'
import { useSubscriptionForEnvironment } from '../hooks/use-subscriptions'
import { isLive, subscriptionHref, subscriptionName, warningTone } from '../lib/subscriptions'

export function EnvironmentLicenceBadge({ environmentId }: { environmentId: string }) {
  const { subscription: s } = useSubscriptionForEnvironment(environmentId)
  if (!s) return null
  const warning = s.warnings[0]
  return (
    <div className="space-y-1 text-xs">
      <p className="text-muted-foreground flex items-center gap-1.5">
        <BadgeCheck className="text-primary h-3.5 w-3.5" aria-hidden />
        <span className="text-foreground font-medium">{`${s.appName} · ${subscriptionName(s)}`}</span>
        <Link href={subscriptionHref(s.licenseId)} className="text-primary ml-auto hover:underline">
          Subscription
        </Link>
      </p>
      {warning && (
        <p className={warningTone(warning.kind) === 'danger' ? 'text-destructive' : 'text-warning'}>{warning.message}</p>
      )}
    </div>
  )
}

export function EnvironmentLicenceBanner({ environmentId }: { environmentId: string }) {
  const { subscription: s } = useSubscriptionForEnvironment(environmentId)
  if (!s) return null
  const warning = s.warnings[0]
  const tone = warning ? warningTone(warning.kind) : 'neutral'
  return (
    <Banner
      tone={tone}
      icon={warning ? Clock : BadgeCheck}
      title={`${s.appName} · ${subscriptionName(s)}`}
      actions={
        <Button asChild size="sm" variant="outline">
          <Link href={subscriptionHref(s.licenseId)}>View subscription</Link>
        </Button>
      }
    >
      {warning
        ? warning.message
        : isLive(s)
          ? `This environment comes with your ${subscriptionName(s)} licence for ${s.appName}.`
          : `Your ${subscriptionName(s)} licence for ${s.appName} has ended.`}
    </Banner>
  )
}
```

- [ ] **Step 4: Use them on the environment card and detail page**

In `app/user/environments/cloud-projects.tsx`, `CloudEnvironmentCard`: import `EnvironmentLicenceBadge` from `@/modules/subscriptions/components/environment-licence` and render `<EnvironmentLicenceBadge environmentId={env.id} />` as the first child of `CardContent` (above the packages row).

In `app/user/environments/[project]/page.tsx`, `EnvironmentDetail`: import `EnvironmentLicenceBanner` and render `<EnvironmentLicenceBanner environmentId={documentId} />` directly after the "Back to Cloud" `<Link>` and before `<HeroCard glass>`.

- [ ] **Step 5: Run tests, typecheck, lint**

Run: `pnpm vitest run --config vitest.unit.config.ts modules/subscriptions app && pnpm tsc && pnpm eslint modules/subscriptions app/user/environments`
Expected: PASS. (If an existing test renders `CloudEnvironmentCard` without a QueryClient, add `vi.mock('@/modules/subscriptions/components/environment-licence', () => ({ EnvironmentLicenceBadge: () => null }))` to it.)

- [ ] **Step 6: Commit**

```bash
git add modules/subscriptions app/user/environments
git commit -m "feat(environments): show the app, plan and offboarding state of licence environments"
```

---
### Task 14: Playwright journeys with a mocked backend

The existing Playwright setup (`playwright.config.ts`, `pnpm dev` on :3000) only has logged-out smoke tests and no auth harness. `/user/*` is guarded server-side by `proxy.ts`, which only checks the Renown session cookie's JWT signature locally (`verifyCredential: false`). So the journeys log in for real with the **Renown mock adapter** (`NEXT_PUBLIC_RENOWN_MOCK=1`, a headless signer with a fixed test key — address `0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266`), replay the Renown switchboard from a recorded HAR, and answer every cloud GraphQL call from an in-memory mock.

**Files:**
- Modify: `playwright.config.ts` (add `testIgnore: ['licensing/**']`)
- Create: `playwright.licensing.config.ts`
- Modify: `package.json` (script `"test:e2e:licensing": "playwright test -c playwright.licensing.config.ts"`)
- Create: `tests/licensing/fixtures/cloud-mock.ts`, `tests/licensing/fixtures/data.ts`, `tests/licensing/fixtures/auth.ts`, `tests/licensing/fixtures/renown.har` (recorded in Step 2)
- Create: `tests/licensing/auth.spec.ts`, `tests/licensing/publisher-journey.spec.ts`, `tests/licensing/owner-redeem.spec.ts`

**Interfaces:**
- Consumes: every UI label from Tasks 3–13 (tab names, button names, field labels) exactly as written there.
- Produces: `CLOUD_URL`; `mockCloud(page, state): Promise<void>`; `type CloudState`; `baseState(): CloudState`; `logIn(page, path?)`; `routeRenown(page)`; `snap(page, name)`.

- [ ] **Step 1: Config, script and fixtures**

`playwright.config.ts` — add one line inside `defineConfig({ … })`:

```ts
  // The licensing journeys need their own server env; see playwright.licensing.config.ts.
  testIgnore: ['licensing/**'],
```

`playwright.licensing.config.ts`:

```ts
import { defineConfig, devices } from '@playwright/test'

const PORT = 3100
/** Every cloud GraphQL call goes here and is answered by tests/licensing/fixtures/cloud-mock.ts. */
export const CLOUD_URL = 'http://cloud.e2e.test/graphql'

export default defineConfig({
  testDir: './tests/licensing',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-licensing' }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    // The same journeys at phone width: the CEO demo will be shown on a phone too.
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: `pnpm exec next dev --turbopack --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 180_000,
    // Merged over process.env (and .env.local) by Playwright.
    env: {
      NEXT_PUBLIC_RENOWN_MOCK: '1',
      NEXT_PUBLIC_CLOUD_SWITCHBOARD_URL: CLOUD_URL,
    },
  },
})
```

`tests/licensing/fixtures/data.ts`:

```ts
import type { App } from '../../../modules/apps/types'
import type {
  PublisherAllowListEntry,
  PublisherApp,
  PublisherAppArtifact,
  PublisherEnvironment,
  PublisherInviteCode,
  PublisherLicense,
  PublisherTemplate,
  PublisherTerm,
} from '../../../modules/publisher/types'
import type { InviteCodeCheck, StudioAccess, Subscription } from '../../../modules/subscriptions/types'

export const ME = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'

export type CloudState = {
  apps: App[]
  publisherApps: PublisherApp[]
  artifacts: PublisherAppArtifact[]
  templates: PublisherTemplate[]
  terms: PublisherTerm[]
  licenses: PublisherLicense[]
  environments: PublisherEnvironment[]
  inviteCodes: PublisherInviteCode[]
  allowList: PublisherAllowListEntry[]
  subscriptions: Subscription[]
  inviteChecks: Record<string, InviteCodeCheck>
  studioAccess: StudioAccess
  calls: Array<{ query: string; variables: Record<string, unknown> }>
  unmatched: string[]
}

const urls = { app: 'https://vault.vetra.io', connect: null, switchboard: null }

export function app(id: string, name: string): App {
  return {
    id, slug: id, name, ownerAddress: ME, status: 'ACTIVE',
    repository: { installationId: '1', repositoryId: '2', fullName: `acme/${id}` },
    productionBranch: 'main', productionEnvironmentId: 'env-prod', previewsEnabled: false, previewLimit: 0,
    previewTtlDays: 0, harborProject: 'acme', identityDid: 'did:key:z6Mk', renownAuthorizeUrl: 'https://renown.id',
    identityExpiresAt: null, productionUrls: urls, previews: [], latestDeployment: null,
    createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
  }
}

export const INVALID_CHECK: InviteCodeCheck = { valid: false, appId: null, appName: null, kind: null, termLabel: null, mode: null }

export function baseState(): CloudState {
  return {
    apps: [app('app-vault', 'Knowledge Vault')],
    publisherApps: [{ id: 'app-vault', name: 'Knowledge Vault', status: 'ACTIVE' }],
    artifacts: [
      { kind: 'FUSION_IMAGE', name: 'vault-app', versions: [{ version: '1.4.0', reference: 'sha256:abc' }], channels: [{ channel: 'LATEST', version: '1.4.0' }] },
      { kind: 'PACKAGE', name: '@acme/vault', versions: [{ version: '1.4.0', reference: 'npm:@acme/vault@1.4.0' }], channels: [] },
    ],
    templates: [],
    terms: [],
    licenses: [],
    environments: [],
    inviteCodes: [],
    allowList: [],
    subscriptions: [],
    inviteChecks: {
      // Used only to reach a public page with a login button (see auth.ts).
      'E2E-LOGIN': { valid: true, appId: 'app-e2e', appName: 'E2E', kind: 'e2e', termLabel: 'E2E', mode: 'SHARED' },
      'KV-PILOT': { valid: true, appId: 'app-kv', appName: 'Knowledge Vault', kind: 'kv-pilot', termLabel: 'Pilot', mode: 'DEDICATED' },
    },
    studioAccess: { allowed: true, licenseId: 'lic-studio', expires: null, hasAttachedKey: true },
    calls: [],
    unmatched: [],
  }
}
```

`tests/licensing/fixtures/cloud-mock.ts`:

```ts
import type { Page } from '@playwright/test'
import { CLOUD_URL } from '../../../playwright.licensing.config'
import { INVALID_CHECK, type CloudState } from './data'

type Vars = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
type Handler = { match: RegExp; reply: (v: Vars, s: CloudState) => unknown }

const pub = (field: string, value: unknown) => ({ vetraPublisher: { [field]: value } })
const subs = (field: string, value: unknown) => ({ vetraSubscriptions: { [field]: value } })
const defined = (o: Vars) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))

// First match wins: namespaced vetraPublisher { myApps } must come before the top-level apps myApps.
const HANDLERS: Handler[] = [
  { match: /vetraPublisher\s*\{\s*myApps/, reply: (_, s) => pub('myApps', s.publisherApps) },
  { match: /vetraPublisher\s*\{\s*templates\(/, reply: (_, s) => pub('templates', s.templates) },
  { match: /vetraPublisher\s*\{\s*terms\(/, reply: (_, s) => pub('terms', s.terms) },
  { match: /vetraPublisher\s*\{\s*appArtifacts\(/, reply: (_, s) => pub('appArtifacts', s.artifacts) },
  { match: /vetraPublisher\s*\{\s*licenses\(/, reply: (_, s) => pub('licenses', s.licenses) },
  { match: /vetraPublisher\s*\{\s*environments\(/, reply: (_, s) => pub('environments', s.environments) },
  { match: /vetraPublisher\s*\{\s*inviteCodes\(/, reply: (_, s) => pub('inviteCodes', s.inviteCodes) },
  { match: /vetraPublisher\s*\{\s*allowList\(/, reply: (_, s) => pub('allowList', s.allowList) },
  {
    match: /addTemplate\(input/,
    reply: (v, s) => {
      const id = `tpl-${s.templates.length + 1}`
      s.templates.push({
        id, name: v.input.name ?? null, mode: v.input.mode, sharedEnvironment: null, size: null, baseDomain: null,
        packageRegistry: null, services: [], packages: [], templateHash: `h-${id}`, environmentCount: 0,
      })
      return pub('addTemplate', id)
    },
  },
  {
    match: /setTemplateDetails\(input/,
    reply: (v, s) => {
      const { templateId, ...rest } = v.input
      Object.assign(s.templates.find((t) => t.id === templateId)!, defined(rest))
      return pub('setTemplateDetails', true)
    },
  },
  {
    match: /addTemplateService\(input/,
    reply: (v, s) => {
      const t = s.templates.find((x) => x.id === v.input.templateId)!
      t.services.push({
        id: `svc-${t.services.length + 1}`, type: v.input.type, prefix: v.input.prefix ?? null,
        artifactName: v.input.artifactName ?? null, artifactChannel: v.input.artifactChannel ?? null,
      })
      return pub('addTemplateService', true)
    },
  },
  {
    match: /addTerm\(input/,
    reply: (v, s) => {
      const id = `term-${s.terms.length + 1}`
      s.terms.push({
        id, kind: v.input.kind, label: v.input.label ?? null, templateId: v.input.templateId ?? null,
        validityDays: v.input.validityDays ?? null, issuers: v.input.issuers ?? [], status: 'DRAFT', activeLicenses: 0,
      })
      return pub('addTerm', id)
    },
  },
  {
    match: /publishTerm\(/,
    reply: (v, s) => {
      s.terms.find((t) => t.id === v.termId)!.status = 'ACTIVE'
      return pub('publishTerm', true)
    },
  },
  {
    match: /createInviteCode\(input/,
    reply: (v, s) => {
      const code = {
        code: v.input.code ?? 'GEN-0001', kind: v.input.kind, label: v.input.label ?? null, active: true,
        expiresAt: v.input.expiresAt ?? null, maxUses: v.input.maxUses ?? null, redemptions: 0,
        hasAnthropicKey: !!v.input.anthropicKey, createdAt: new Date().toISOString(),
      }
      s.inviteCodes.push(code)
      return pub('createInviteCode', code)
    },
  },
  { match: /vetraSubscriptions\s*\{\s*inviteCode\(/, reply: (v, s) => subs('inviteCode', s.inviteChecks[v.code] ?? INVALID_CHECK) },
  { match: /mySubscriptions/, reply: (_, s) => subs('mySubscriptions', s.subscriptions) },
  { match: /studioAccess/, reply: (_, s) => subs('studioAccess', s.studioAccess) },
  {
    match: /redeemInviteCode\(input/,
    reply: (v, s) => {
      const check = s.inviteChecks[v.input.code]
      const replaced = v.input.upgrades ? s.subscriptions.find((x) => x.licenseId === v.input.upgrades) : undefined
      if (replaced) replaced.status = 'REPLACED'
      const sub = {
        licenseId: `lic-${s.subscriptions.length + 1}`, appId: check.appId!, appName: check.appName!, kind: check.kind!,
        termLabel: check.termLabel, issuer: 'INVITE_CODE', status: 'ACTIVE', start: new Date().toISOString(), end: null,
        mode: (check.mode ?? 'SHARED') as 'SHARED' | 'DEDICATED',
        environmentId: replaced?.environmentId ?? (check.mode === 'DEDICATED' ? 'env-kv-1' : null),
        environmentLabel: replaced?.environmentLabel ?? v.input.label ?? null,
        openUrl: 'https://acme.kv.vetra.io', stoppedAt: null, deleteAfter: null, warnings: [],
      }
      s.subscriptions.push(sub)
      return subs('redeemInviteCode', sub)
    },
  },
  // vetra-apps (top-level fields)
  { match: /\bapp\(id:/, reply: (v, s) => ({ app: s.apps.find((a) => a.id === v.id) ?? null }) },
  { match: /appDeployments\(/, reply: () => ({ appDeployments: [] }) },
  { match: /githubDeployAppInfo/, reply: () => ({ githubDeployAppInfo: { slug: 'vetra-deploy', installUrl: 'https://github.com/apps/vetra-deploy', authorizeUrl: 'https://github.com' } }) },
  { match: /\bmyApps\s*\{/, reply: (_, s) => ({ myApps: s.apps }) },
]

/** Answers every cloud GraphQL POST from `state`; unknown operations get a GraphQL error and are recorded. */
export async function mockCloud(page: Page, state: CloudState): Promise<void> {
  await page.route(CLOUD_URL, async (route) => {
    const body = route.request().postDataJSON() as { query: string; variables?: Vars }
    const variables = body.variables ?? {}
    state.calls.push({ query: body.query, variables })
    const handler = HANDLERS.find((h) => h.match.test(body.query))
    if (!handler) {
      state.unmatched.push(body.query.replace(/\s+/g, ' ').slice(0, 140))
      return route.fulfill({ json: { data: null, errors: [{ message: 'not mocked in e2e' }] } })
    }
    return route.fulfill({ json: { data: handler.reply(variables, state) } })
  })
}
```

`tests/licensing/fixtures/auth.ts`:

```ts
import { expect, test, type Page } from '@playwright/test'
import { RENOWN_SESSION_COOKIE } from '@renown/sdk/node'

const HAR = 'tests/licensing/fixtures/renown.har'
// Renown hosts only — never this app's own /api/renown/session route on localhost.
const RENOWN_HOSTS = /^https:\/\/[^/]*renown[^/]*\//

/**
 * Replays the Renown switchboard from a recorded HAR.
 * E2E_RECORD_RENOWN=1 re-records it against the live Renown; E2E_LIVE_RENOWN=1 skips replay.
 */
export async function routeRenown(page: Page): Promise<void> {
  if (process.env.E2E_LIVE_RENOWN === '1') return
  await page.routeFromHAR(HAR, {
    url: RENOWN_HOSTS,
    update: process.env.E2E_RECORD_RENOWN === '1',
    updateContent: 'embed',
    notFound: 'abort',
  })
}

/**
 * Logs in with the mock adapter from a public page (everything under /user is
 * behind proxy.ts) and waits for the session cookie the proxy checks.
 */
export async function logIn(page: Page, path = '/redeem/E2E-LOGIN'): Promise<void> {
  await page.goto(path)
  await page.getByRole('main').getByRole('button', { name: 'Log in with Renown' }).click()
  // The mock adapter answers for wallet, google and email; any of them signs with the test key.
  await page.getByRole('dialog').getByRole('button', { name: /wallet/i }).first().click()
  await expect
    .poll(async () => (await page.context().cookies()).some((c) => c.name === RENOWN_SESSION_COOKIE), {
      timeout: 30_000,
    })
    .toBe(true)
}

/** Full-page screenshot into the test's output folder, for the visual pass in Task 15. */
export async function snap(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true })
}
```

`tests/licensing/auth.spec.ts`:

```ts
import { expect, test } from '@playwright/test'
import { logIn, routeRenown } from './fixtures/auth'
import { mockCloud } from './fixtures/cloud-mock'
import { baseState } from './fixtures/data'

test('the mock adapter logs in and the proxy lets us into /user', async ({ page }) => {
  const state = baseState()
  await routeRenown(page)
  await mockCloud(page, state)
  await logIn(page)
  await page.goto('/user/subscriptions')
  await expect(page).toHaveURL(/\/user\/subscriptions$/)
  await expect(page.getByRole('heading', { name: 'Subscriptions' })).toBeVisible()
})
```

- [ ] **Step 2: Record the Renown HAR and confirm the login selectors (one-time spike)**

```bash
cd /home/f/projects/vetra.io-licensing
pnpm exec playwright install chromium
E2E_RECORD_RENOWN=1 pnpm test:e2e:licensing --project=desktop auth.spec.ts --headed
```

Expected: PASS and `tests/licensing/fixtures/renown.har` written. If the login dialog's method button is not named like `/wallet/i`, open the trace (`pnpm exec playwright show-trace test-results/**/trace.zip`), read the button's accessible name, and change only the regex in `logIn()`. Then verify replay works offline-from-Renown:

```bash
pnpm test:e2e:licensing --project=desktop auth.spec.ts
```

Expected: PASS without network access to Renown. If replay fails because the recorded credential has expired or is time-bound, set `E2E_LIVE_RENOWN=1` in CI for this suite and note it in the PR description (see Risks). Commit the HAR only if it contains no secrets beyond the public test key's signatures (`grep -i "authorization\|cookie" tests/licensing/fixtures/renown.har` — strip any such header values).

- [ ] **Step 3: Write the publisher journey**

`tests/licensing/publisher-journey.spec.ts`:

```ts
import { expect, test } from '@playwright/test'
import { logIn, routeRenown, snap } from './fixtures/auth'
import { mockCloud } from './fixtures/cloud-mock'
import { baseState } from './fixtures/data'

test('publisher: template → plan → invite code, all on the app page', async ({ page }) => {
  const state = baseState()
  await routeRenown(page)
  await mockCloud(page, state)
  await logIn(page)

  await page.goto('/user/apps/app-vault')
  const tabs = ['Overview', 'Deployments', 'Artifacts', 'Templates', 'Plans', 'Holders', 'Invite codes', 'Settings']
  for (const name of tabs) await expect(page.getByRole('tab', { name })).toBeVisible()

  // Artifacts
  await page.getByRole('tab', { name: 'Artifacts' }).click()
  await expect(page.getByTestId('artifact-vault-app')).toContainText('Latest release')
  await snap(page, 'artifacts')

  // Template
  await page.getByRole('tab', { name: 'Templates' }).click()
  await page.getByRole('button', { name: 'Create your first template' }).click()
  await page.getByLabel('Name').fill('Pro workspace')
  await page.getByRole('radio', { name: 'Dedicated' }).click()
  await page.getByRole('button', { name: 'Create template' }).click()
  const sheet = page.getByRole('dialog')
  await expect(sheet.getByRole('heading', { name: 'Pro workspace' })).toBeVisible()
  await sheet.getByRole('combobox', { name: 'Service type' }).click()
  await page.getByRole('option', { name: 'Your app image' }).click()
  await sheet.getByRole('combobox', { name: 'Image' }).click()
  await page.getByRole('option', { name: 'vault-app' }).click()
  await sheet.getByRole('button', { name: 'Add service' }).click()
  await expect(sheet.getByTestId('template-summary')).toContainText('Each owner gets vault-app')
  await snap(page, 'template-editor')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('template-tpl-1')).toContainText('Dedicated')

  // Plan
  await page.getByRole('tab', { name: 'Plans' }).click()
  await page.getByRole('button', { name: 'Create your first plan' }).click()
  await page.getByLabel('Name').fill('Conference 2026')
  await expect(page.getByLabel('Kind')).toHaveValue('conference-2026')
  await page.getByRole('combobox', { name: 'Template' }).click()
  await page.getByRole('option', { name: /Pro workspace/ }).click()
  await page.getByLabel('Valid for (days)').fill('30')
  await page.getByRole('button', { name: 'Create plan' }).click()
  const plan = page.getByTestId('plan-term-1')
  await plan.getByRole('button', { name: 'Publish' }).click()
  await page.getByRole('button', { name: 'Publish plan' }).click()
  await expect(plan).toContainText('Published')
  await snap(page, 'plans')

  // Invite code
  await page.getByRole('tab', { name: 'Invite codes' }).click()
  await page.getByRole('button', { name: 'New invite code' }).click()
  await page.getByRole('combobox', { name: 'Plan' }).click()
  await page.getByRole('option', { name: 'Conference 2026' }).click()
  await page.getByLabel('Custom code (optional)').fill('LFC-2026')
  await page.getByLabel('Maximum uses').fill('50')
  await page.getByRole('button', { name: 'Create code' }).click()
  await expect(page.getByText('Your code is ready')).toBeVisible()
  await expect(page.getByText(/\/redeem\/LFC-2026$/)).toBeVisible()
  await snap(page, 'invite-code-created')

  // The server saw contract-shaped writes.
  const input = (field: string) =>
    state.calls.find((c) => c.query.includes(`${field}(input: $input)`))?.variables.input
  expect(input('addTemplate')).toEqual({ appId: 'app-vault', name: 'Pro workspace', mode: 'DEDICATED' })
  expect(input('addTerm')).toEqual({
    appId: 'app-vault', kind: 'conference-2026', label: 'Conference 2026', templateId: 'tpl-1',
    validityDays: 30, issuers: ['INVITE_CODE'],
  })
  expect(input('createInviteCode')).toEqual({
    appId: 'app-vault', kind: 'conference-2026', label: null, maxUses: 50, expiresAt: null, code: 'LFC-2026',
  })
})

test('the old Licensing URL lands on the app page', async ({ page }) => {
  const state = baseState()
  await routeRenown(page)
  await mockCloud(page, state)
  await logIn(page)
  await page.goto('/user/publisher?app=app-vault')
  await expect(page).toHaveURL(/\/user\/apps\/app-vault\?tab=plans$/)
  await expect(page.getByRole('tab', { name: 'Plans', selected: true })).toBeVisible()
})
```

- [ ] **Step 4: Write the owner journeys**

`tests/licensing/owner-redeem.spec.ts`:

```ts
import { expect, test } from '@playwright/test'
import { logIn, routeRenown, snap } from './fixtures/auth'
import { mockCloud } from './fixtures/cloud-mock'
import { baseState } from './fixtures/data'

test('owner: redeem → subscription → environment', async ({ page }) => {
  const state = baseState()
  await routeRenown(page)
  await mockCloud(page, state)

  await page.goto('/redeem/KV-PILOT')
  await expect(page.getByRole('heading', { name: 'Knowledge Vault' })).toBeVisible()
  await snap(page, 'redeem-before-login')
  await logIn(page, '/redeem/KV-PILOT')

  await page.getByLabel('Project name').fill('Acme research')
  await snap(page, 'redeem-setup')
  await page.getByRole('button', { name: 'Get access' }).click()

  await expect(page).toHaveURL(/\/user\/subscriptions\?highlight=lic-1$/)
  const card = page.getByTestId('subscription-lic-1')
  await expect(card).toHaveAttribute('data-highlighted', 'true')
  await expect(card).toContainText('Pilot')
  await expect(card.getByRole('link', { name: /open/i })).toHaveAttribute('href', 'https://acme.kv.vetra.io')
  await snap(page, 'subscriptions')
  await card.getByRole('link', { name: 'Acme research' }).click()
  await expect(page).toHaveURL(/\/user\/environments\/env-kv-1$/)
})

test('owner: an invalid code says so before asking to log in', async ({ page }) => {
  const state = baseState()
  await routeRenown(page)
  await mockCloud(page, state)
  await page.goto('/redeem/NOPE')
  await expect(page.getByText('This code can’t be used')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Log in with Renown' })).toHaveCount(0)
})

test('owner: holding a licence offers the upgrade instead of a second environment', async ({ page }) => {
  const state = baseState()
  state.subscriptions.push({
    licenseId: 'lic-free', appId: 'app-kv', appName: 'Knowledge Vault', kind: 'kv-free', termLabel: 'Free',
    issuer: 'INVITE_CODE', status: 'ACTIVE', start: '2026-10-01T00:00:00Z', end: null, mode: 'DEDICATED',
    environmentId: 'env-kv-0', environmentLabel: 'Acme', openUrl: null, stoppedAt: null, deleteAfter: null, warnings: [],
  })
  await routeRenown(page)
  await mockCloud(page, state)
  await logIn(page, '/redeem/KV-PILOT')

  await page.getByRole('radio', { name: 'Upgrade Free' }).click()
  await expect(page.getByLabel('Project name')).toHaveCount(0)
  await page.getByRole('button', { name: 'Get access' }).click()
  await expect(page).toHaveURL(/highlight=lic-2$/)
  const redeem = state.calls.find((c) => c.query.includes('redeemInviteCode(input: $input)'))
  expect(redeem?.variables).toEqual({ input: { code: 'KV-PILOT', upgrades: 'lic-free' } })
})
```

- [ ] **Step 5: Run the suite on both viewports**

Run: `pnpm test:e2e:licensing`
Expected: all tests PASS on `desktop` and `mobile`. On failure, open the HTML report (`pnpm exec playwright show-report playwright-report-licensing`); a label mismatch means the spec and the component disagree — fix the component only if the plan's label is the one in the unit tests, otherwise fix the spec.

- [ ] **Step 6: Commit**

```bash
git add playwright.config.ts playwright.licensing.config.ts package.json tests/licensing
git commit -m "test(e2e): publisher and owner licensing journeys against a mocked backend"
```

---

### Task 15: Whole-branch verification and the polish pass

**Files:**
- Modify: whatever the checks below flag (copy, spacing, formatting). No new features.

- [ ] **Step 1: Leftover scan**

```bash
cd /home/f/projects/vetra.io-licensing
grep -rn "VetraAccessCodes\|modules/invites\|EarlyAccessGate\|licenseType\|LicenseType\|/user/publisher\|applyInviteCodeSecret" app modules tests --include='*.ts' --include='*.tsx' | grep -v "app/user/publisher/"
```

Expected: no output (the redirect page and its test are the only `/user/publisher` references and are excluded).

- [ ] **Step 2: Format**

Run: `pnpm format && git diff --stat`
Expected: only whitespace/format changes in files this branch touched.

- [ ] **Step 3: Full gates**

Run, in order, each must pass:

```bash
pnpm tsc
pnpm lint
pnpm test:unit
pnpm build
pnpm test:e2e:licensing
pnpm exec playwright test   # the pre-existing suite, now ignoring tests/licensing
```

- [ ] **Step 4: Visual pass (the CEO demo)**

Open every `*.png` written by the e2e run under `test-results/` for both `desktop` and `mobile` and check, fixing anything that fails:

- Each tab has a heading, a one-line description, and exactly one primary button.
- Nothing overflows horizontally at phone width except tables, which scroll inside their card.
- Empty states say what the thing is and offer the next step (templates → plans → codes chain works by link).
- Status pills use the same colours as Deployments (success/progress/warning/danger/neutral).
- No raw ids visible where a name exists (template names, plan names, environment labels).
- Dark mode: run `pnpm dev`, toggle theme from the avatar menu, and look at the app page tabs, subscriptions and redeem pages; text contrast is readable and banners keep their tone.
- Copy review against `docs/plain-language-cloud-copy.md`: no "term", "issuer", "stage", "kind" in sentences shown to owners (only the plan editor's "Kind" field label may use it).

- [ ] **Step 5: Commit any polish**

```bash
git add -A app modules tests
git commit -m "chore(licensing): polish copy and layout after the visual pass"
```

(Skip if nothing changed.)

- [ ] **Step 6: Hand back for review**

Do not push without the user's go-ahead. When approved: `git push -u origin feat/app-licensing-redesign` and open a PR against **staging** (not main) whose description lists: the decisions D1–D6, the backend dependency (vetra-cloud-package `vetraPublisher`/`vetraSubscriptions` must be deployed to staging first — this UI breaks against the old `licenseTypes` API), and how to run `pnpm test:e2e:licensing`. No `Co-Authored-By` trailer.

---

## Risks and open questions (for the reviewer of this plan)

1. **Spec vs contract naming.** The design spec names owner APIs `vetraLicensing.redeemInviteCode / myLicenses / cancelLicense / hasLicense(appId, did)` and the publisher write `deactivateInviteCode`; the binding contract has `vetraSubscriptions.redeemInviteCode / mySubscriptions / cancelSubscription / studioAccess` and `vetraPublisher.setInviteCodeActive`. This plan follows the contract.
2. **Absent-key semantics** of `setTemplateDetails` / `setTermDetails` are not stated in the contract. D4 sends every field; the one exception is `kind` on non-DRAFT terms, which is omitted because sending even an unchanged kind may trip `KindImmutableError` if the reducer checks presence rather than change. Confirm with the cloud-package plan.
3. **Holder environment links** go to `/user/environments/<id>`, but the publisher does not own a DEDICATED holder's environment (the holder does). The environment page may show nothing for the publisher. Acceptable for now; a publisher-side environment view is a follow-up.
4. **Playwright auth** depends on the Renown mock adapter plus a recorded HAR of the Renown switchboard. If replay is time-bound, CI needs `E2E_LIVE_RENOWN=1` (network to Renown). Server-side `verifySession` in `app/layout.tsx` also calls Renown from the dev server, which the browser-side HAR cannot intercept; it only affects first-paint seeding, not the journeys.
5. **Deployment order.** Task 1 deletes the old Licensing UI; staging must run the new cloud-package API before this branch deploys, or the publisher tabs and the studio gate fail (the gate fails safe: it shows a retry, not "redeem a code").
6. **Standalone environments on `/user`.** Licence-provisioned environments are not app-linked from the owner's view, so they appear under "Standalone environments" on the apps home. They carry the licence badge (Task 13), which is enough for now.
7. **Gate scope (D2).** `/user/environments/new` stays gated as a builder action; the spec only names Studio and app creation. Flip it to `RequireLogin` if product disagrees.
