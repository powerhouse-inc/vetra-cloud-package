import { gql } from "graphql-tag";
import type { DocumentNode } from "graphql";

export const schema: DocumentNode = gql`
  """
  A user's current early-access status, derived from their most recent
  non-expired redemption.
  """
  type AccessStatus {
    allowed: Boolean!
    code: String
    label: String
    accessExpires: String
  }

  """
  An invite code and its redemption count (admin view).
  """
  type InviteCode {
    code: String!
    label: String
    active: Boolean!
    expiresAt: String
    maxUses: Int
    createdAt: String!
    redemptions: Int!
  }

  """
  A single redemption: which wallet (DID) redeemed which code, and when.
  """
  type Redemption {
    code: String!
    userDid: String!
    redeemedAt: String!
    accessExpires: String
  }

  type VetraAccessCodesQueries {
    "Whether a code is currently usable. Public; never consumes the code."
    inviteCodeValid(code: String!): Boolean!
    "Access status for the authenticated caller (DID taken from the token)."
    myAccessStatus: AccessStatus!
    "All codes with redemption counts. Admin only."
    inviteCodes: [InviteCode!]!
    "Redemptions (which wallet used which code), newest first. Filter by code and/or wallet address, or omit for all. Admin only."
    redemptions(code: String, address: String): [Redemption!]!
  }

  type VetraAccessCodesMutations {
    "Redeem a code for the authenticated caller. Idempotent."
    redeemInviteCode(code: String!): AccessStatus!
    "Create a code. Admin only."
    createInviteCode(
      code: String!
      label: String
      expiresAt: String
      maxUses: Int
    ): InviteCode!
    "Enable/disable a code. Admin only."
    setInviteCodeActive(code: String!, active: Boolean!): InviteCode!
    "Revoke a wallet's current access by expiring its redemptions. Returns how many grants were revoked. Admin only."
    revokeAccess(address: String!): Int!
  }

  type Query {
    VetraAccessCodes: VetraAccessCodesQueries!
  }

  type Mutation {
    VetraAccessCodes: VetraAccessCodesMutations!
  }
`;
