# Licensing API contract (cloud package ⇄ vetra.io ⇄ renown)

**Date:** 2026-10-08
**Implements:** `2026-10-08-app-document-licensing-redesign-design.md`
**Status:** binding for all three implementation plans. Field names here are
exact; vetra.io's hand-written GraphQL strings must match them.

Three surfaces, by who is calling:

| Namespace | Caller | Auth |
|---|---|---|
| `vetraPublisher` | the app's owner (publisher), wallet bearer | `resolveOwnerApp` on every `appId` |
| `vetraSubscriptions` | any logged-in Renown DID (an owner) | the caller's own DID; ids authorised against it |
| `vetraLicensing` | an App identity (machine) or an environment reporting token | app derived from the caller, never from arguments |

All three live in the `vetra-licensing` subgraph. `vetra-access-codes` is
deleted.

Enum-valued fields are transported as `String` (as today) with the values listed.

## vetraPublisher

```graphql
type PublisherApp { id: String!  name: String!  status: String! }

type PublisherTemplate {
  id: String!
  name: String
  mode: String!                    # SHARED | DEDICATED
  sharedEnvironment: String        # SHARED only; null = App Environment
  size: String
  baseDomain: String
  packageRegistry: String
  services: [PublisherTemplateService!]!
  packages: [PublisherTemplatePackage!]!
  templateHash: String!
  "Environments currently provisioned from this template (DEDICATED), for the 'affects N' warning."
  environmentCount: Int!
}

type PublisherTemplateService {    # unchanged
  id: String!  type: String!  prefix: String  artifactName: String  artifactChannel: String
}
type PublisherTemplatePackage { id: String!  packageName: String  version: String }   # unchanged

type PublisherTerm {
  id: String!
  kind: String!
  label: String
  templateId: String
  validityDays: Int
  issuers: [String!]!              # INVITE_CODE | PUBLISHER_GRANT | ACHRA_SUBSCRIPTION
  status: String!                  # DRAFT | ACTIVE | RETIRED
  activeLicenses: Int!
}

type PublisherLicense {
  id: String!
  user: String!                    # DID
  kind: String!
  issuer: String!
  status: String!                  # ISSUED | ACTIVE | EXPIRED | REVOKED | REPLACED
  start: String
  end: String
  environmentId: String            # = stage
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

type PublisherAllowListEntry { user: String!  addedAt: String! }

# PublisherAppArtifact / PublisherArtifactVersion / PublisherArtifactChannel unchanged.

input AddTemplateInput { appId: String!  name: String  mode: String! }
input SetTemplateDetailsInput {
  appId: String!  templateId: String!
  name: String  mode: String  sharedEnvironment: String
  size: String  baseDomain: String  packageRegistry: String
}
input AddTemplateServiceInput {
  appId: String!  templateId: String!
  type: String!  prefix: String  artifactName: String  artifactChannel: String
}
input AddTemplatePackageInput { appId: String!  templateId: String!  packageName: String!  version: String }
input RemoveTemplateEntryInput { appId: String!  templateId: String!  id: String! }

input AddTermInput {
  appId: String!  kind: String!  label: String  templateId: String
  validityDays: Int  issuers: [String!]
}
input SetTermDetailsInput {
  appId: String!  termId: String!
  kind: String  label: String  templateId: String  validityDays: Int  issuers: [String!]
}

input IssueGrantInput { appId: String!  kind: String!  user: String!  label: String }
input ReplaceGrantInput { licenseId: String!  kind: String! }
input RevokeLicenseInput { licenseId: String!  reason: String }

input CreateInviteCodeInput {
  appId: String!  kind: String!  label: String
  "Omit to generate a random code."
  code: String
  expiresAt: String  maxUses: Int
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
  addTemplate(input: AddTemplateInput!): String!            # template id
  setTemplateDetails(input: SetTemplateDetailsInput!): Boolean!
  addTemplateService(input: AddTemplateServiceInput!): Boolean!
  removeTemplateService(input: RemoveTemplateEntryInput!): Boolean!
  addTemplatePackage(input: AddTemplatePackageInput!): Boolean!
  removeTemplatePackage(input: RemoveTemplateEntryInput!): Boolean!
  deleteTemplate(appId: String!, templateId: String!): Boolean!
  addTerm(input: AddTermInput!): String!                    # term id
  setTermDetails(input: SetTermDetailsInput!): Boolean!
  publishTerm(appId: String!, termId: String!): Boolean!
  retireTerm(appId: String!, termId: String!): Boolean!
  issueGrant(input: IssueGrantInput!): String!              # licence id
  replaceGrant(input: ReplaceGrantInput!): String!          # new licence id
  revokeLicense(input: RevokeLicenseInput!): Boolean!
  createInviteCode(input: CreateInviteCodeInput!): PublisherInviteCode!
  setInviteCodeActive(appId: String!, code: String!, active: Boolean!): Boolean!
  addToAllowList(appId: String!, user: String!): Boolean!
  removeFromAllowList(appId: String!, user: String!): Boolean!
}
```

`user` arguments accept a `did:pkh:eip155:<chain>:0x…` DID or a bare `0x` address
(normalised to `did:pkh:eip155:1:<lowercased>`). Every other DID method is refused
with `UNSUPPORTED_DID`.

Error codes (`extensions.code`, existing mechanism): `NOT_FOUND`, `FORBIDDEN`,
`INVALID_INPUT`, `APP_NOT_ACTIVE`, `NOT_ON_ALLOW_LIST`, `TERM_NOT_ISSUABLE`,
`UNSUPPORTED_DID`, `LICENSING_DISABLED`, plus reducer errors surfaced as
`INVALID_INPUT` with the reducer message.

## vetraSubscriptions

```graphql
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
  mode: String!                     # SHARED | DEDICATED
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
  kind: String!                     # EXPIRING | ENDED_STOP_PENDING | STOPPED_DELETE_PENDING | DELETE_IMMINENT
  at: String!                       # the moment the warning is about (expiry, stop, deletion)
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
```

Errors: `INVALID_CODE` (unknown, inactive, expired or exhausted — one code, so
codes cannot be probed for state), `ALREADY_HOLDS` (redeeming a code for a kind
the caller already holds ACTIVE on that chain), `NOT_FOUND`, `FORBIDDEN`,
`UNSUPPORTED_DID`.

The studio app is found by slug `vetra-studio` (config `VETRA_STUDIO_APP_SLUG`,
default `vetra-studio`).

## vetraLicensing (machine)

Existing fields stay, re-expressed on kinds:

```graphql
type AppLicense { id: String!  user: String!  kind: String!  status: String!  start: String  end: String  environmentId: String }
type AppTermSummary { id: String!  kind: String!  status: String!  templateHash: String }

type VetraLicensingQueries {
  appLicenses(status: String): [AppLicense!]!
  appTerms: [AppTermSummary!]!                     # replaces appLicenseTypes
  appUserEnvironments: [AppUserEnvironment!]!
  "SHARED apps: does this DID hold an ACTIVE licence for the calling app?"
  hasLicense(user: String!): Boolean!
}

type VetraLicensingMutations {
  applyEnvironmentTemplate(input: ApplyEnvironmentTemplateInput!): AppUserEnvironment!
  releaseEnvironment(input: ReleaseEnvironmentInput!): Boolean!
  issuePublisherGrant(input: IssuePublisherGrantInput!): String!   # input: { kind: String!, user: String! }
  "Caller = environment reporting token. Forwards to Renown signed as the app."
  reportUserStat(user: String!, metric: String!, value: Float!): Boolean!
}
```

`AppUserEnvironment` gains `rootLicenseId`, `label`, `stoppedAt`, `deleteAfter`.

## Renown (renown-package)

Document types: `powerhouse/renown-app-profile`, `powerhouse/renown-user-stats`.

Subgraph `renown-stats`:

```graphql
type UserStat { appDid: String!  metric: String!  value: Float!  updatedAt: String! }
type AppProfile { appDid: String!  name: String  tagline: String  logo: String  website: String  publisherDid: String }

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
```

Authentication of the relay (Vetra holds no app keys): Vetra first calls
`mutation { issueAppStatsToken(did: <appDid>) { accessToken } }` (returns an `AppStatsToken` object) on Renown's
`/graphql/renown-workload`, authorised by the existing registration-token header
(`RENOWN_WORKLOAD_REGISTRATION_TOKEN`), receiving a ~10-minute token whose
audience is only renown-stats. It caches the token and sends it to
`reportUserStat` in the **`X-Renown-App-Token`** header (not `Authorization`).
FORBIDDEN (app in PENDING_IDENTITY, delegation expired/revoked) → relay returns
`false` and logs. The relay coalesces reports per (user, metric) before sending.

Ownership is anchored on Renown's workload identity record (not on
self-issued delegations, which any wallet can mint): `reportUserStat` requires
the app DID to be a registered renown-workload identity and the token's subject
wallet to be that identity's `ownerAddress` with a live delegation; an app DID
that is not a workload identity is always FORBIDDEN. The first
`upsertAppProfile` requires the caller wallet to be the identity's
`ownerAddress`, and every upsert requires the calling app (`ctx.user.appKey`) to
be in `RENOWN_STATS_PROFILE_APPS` (unset → profile edits refused). In
`upsertAppProfile`, `null` leaves a field unchanged and `""` clears it (unlike
the cloud package's detail operations, where `null` clears).

Until renown-package with `renown-stats` is deployed, the Vetra relay is configured off
(`RENOWN_STATS_URL` unset → `reportUserStat` returns `false` and logs).
