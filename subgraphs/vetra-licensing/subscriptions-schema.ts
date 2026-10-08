import { gql } from "graphql-tag";
import type { DocumentNode } from "graphql";

/**
 * The owner surface (contract § vetraSubscriptions): any Renown DID, acting on
 * its own licences only. Field names are exact; vetra.io writes hand-written
 * GraphQL against them.
 */
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
    "SHARED | DEDICATED"
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
    "EXPIRING | ENDED_STOP_PENDING | STOPPED_DELETE_PENDING | DELETE_IMMINENT"
    kind: String!
    "The moment the warning is about (expiry, stop, deletion)."
    at: String!
    message: String!
  }

  type StudioAccess {
    allowed: Boolean!
    "The usable studio licence; when not allowed, the caller's newest studio licence (for its warnings). Null only if the caller never held one."
    licenseId: String
    "The end of the licence named by licenseId."
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

  extend type Query {
    vetraSubscriptions: VetraSubscriptionsQueries!
  }

  extend type Mutation {
    vetraSubscriptions: VetraSubscriptionsMutations!
  }
`;
