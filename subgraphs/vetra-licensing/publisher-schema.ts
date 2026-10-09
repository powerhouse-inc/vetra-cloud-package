import { gql } from "graphql-tag";
import type { DocumentNode } from "graphql";

/**
 * The human surface (contract: 2026-10-08-licensing-api-contract.md §
 * vetraPublisher; field names are binding, vetra.io's GraphQL strings match
 * them). Every field takes an appId or a document id and authorises it
 * against the app's owner on every call -- the exact opposite of
 * vetraLicensing, where the app is derived from the caller's App identity.
 * Enum-valued fields travel as String.
 */
export const publisherSchema: DocumentNode = gql`
  type PublisherApp {
    id: String!
    name: String!
    status: String!
    "The app's Renown identity (did:key); null before one is registered."
    identityDid: String
  }

  input PublisherAppLinkInput {
    id: String!
    label: String!
    url: String!
  }

  "Absent or null: unchanged. Empty string: clear. links replaces the whole list."
  input UpdateAppProfileInput {
    appId: String!
    name: String
    tagline: String
    website: String
    "Markdown subset, at most 2000 characters"
    description: String
    category: String
    "attachment://v1:<sha256> from Renown's upload route"
    logoRef: String
    coverRef: String
    links: [PublisherAppLinkInput!]
    "Publisher-defined metrics, the whole list (at most 16); [] clears."
    metrics: [PublisherAppMetricInput!]
  }

  enum PublisherMetricAggregation {
    SUM
    MAX
    AVG
    COUNT_USERS
  }

  "A publisher-defined metric: key is what environments report; the rest is how Renown shows it."
  input PublisherAppMetricInput {
    id: String!
    key: String!
    label: String!
    unit: String
    description: String
    aggregation: PublisherMetricAggregation!
    public: Boolean!
  }

  type PublisherTemplate {
    id: String!
    name: String
    "SHARED | DEDICATED"
    mode: String!
    "SHARED only; null = App Environment"
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
    "The app artifact this FUSION service runs; null for every other type."
    artifactName: String
    "DEV, STAGING or LATEST — which published version the service follows."
    artifactChannel: String
  }

  type PublisherTemplatePackage {
    id: String!
    packageName: String
    version: String
  }

  type PublisherTerm {
    id: String!
    kind: String!
    label: String
    templateId: String
    validityDays: Int
    "INVITE_CODE | PUBLISHER_GRANT | ACHRA_SUBSCRIPTION"
    issuers: [String!]!
    "DRAFT | ACTIVE | RETIRED"
    status: String!
    activeLicenses: Int!
  }

  type PublisherLicense {
    id: String!
    "DID"
    user: String!
    kind: String!
    issuer: String!
    "ISSUED | ACTIVE | EXPIRED | REVOKED | REPLACED"
    status: String!
    start: String
    end: String
    "= stage"
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

  type PublisherAllowListEntry {
    user: String!
    addedAt: String!
  }

  "One artifact the app has published, as the template builder offers it."
  type PublisherAppArtifact {
    kind: String!
    name: String!
    "Every published version, newest last."
    versions: [PublisherArtifactVersion!]!
    channels: [PublisherArtifactChannel!]!
  }

  type PublisherArtifactVersion {
    version: String!
    "The full image reference or registry URL CI published."
    reference: String!
  }

  type PublisherArtifactChannel {
    channel: String!
    version: String!
  }

  input AddTemplateInput {
    appId: String!
    name: String
    mode: String!
  }

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

  input AddTemplatePackageInput {
    appId: String!
    templateId: String!
    packageName: String!
    version: String
  }

  input RemoveTemplateEntryInput {
    appId: String!
    templateId: String!
    id: String!
  }

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

  input IssueGrantInput {
    appId: String!
    kind: String!
    user: String!
    label: String
  }

  input ReplaceGrantInput {
    licenseId: String!
    kind: String!
  }

  input RevokeLicenseInput {
    licenseId: String!
    reason: String
  }

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
    "Returns the template id."
    addTemplate(input: AddTemplateInput!): String!
    setTemplateDetails(input: SetTemplateDetailsInput!): Boolean!
    addTemplateService(input: AddTemplateServiceInput!): Boolean!
    removeTemplateService(input: RemoveTemplateEntryInput!): Boolean!
    addTemplatePackage(input: AddTemplatePackageInput!): Boolean!
    removeTemplatePackage(input: RemoveTemplateEntryInput!): Boolean!
    deleteTemplate(appId: String!, templateId: String!): Boolean!
    "Returns the term id."
    addTerm(input: AddTermInput!): String!
    setTermDetails(input: SetTermDetailsInput!): Boolean!
    publishTerm(appId: String!, termId: String!): Boolean!
    retireTerm(appId: String!, termId: String!): Boolean!
    "Returns the licence id."
    issueGrant(input: IssueGrantInput!): String!
    "Returns the new licence id."
    replaceGrant(input: ReplaceGrantInput!): String!
    revokeLicense(input: RevokeLicenseInput!): Boolean!
    createInviteCode(input: CreateInviteCodeInput!): PublisherInviteCode!
    setInviteCodeActive(appId: String!, code: String!, active: Boolean!): Boolean!
    addToAllowList(appId: String!, user: String!): Boolean!
    removeFromAllowList(appId: String!, user: String!): Boolean!
    """
    Writes the app's public Renown profile (through Renown's relay).
    Errors: INVALID_INPUT (extensions.field), FORBIDDEN, NO_IDENTITY,
    RATE_LIMITED, PROFILE_UNAVAILABLE, plus the ownership codes.
    """
    updateAppProfile(input: UpdateAppProfileInput!): Boolean!
  }

  extend type Query {
    vetraPublisher: VetraPublisherQueries!
  }

  extend type Mutation {
    vetraPublisher: VetraPublisherMutations!
  }
`;
