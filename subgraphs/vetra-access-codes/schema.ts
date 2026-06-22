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
    "Whether the caller has an active redemption whose code carries a Claude key. The key value itself is never returned."
    hasAttachedKey: Boolean!
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
    "Whether a Claude API key is attached to this code. The key value itself is never returned."
    hasAnthropicKey: Boolean!
  }

  """
  Result of applying a code's attached secret to a tenant's secret store.
  """
  type ApplyInviteCodeSecretResult {
    "True when a key was found for the caller and written to the tenant."
    injected: Boolean!
    "The secret names that were written (empty when nothing was injected)."
    secretNames: [String!]!
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
    """
    Write the caller's attached Claude key into a tenant's secret store under
    each of secretNames. The key is resolved server-side from the caller's
    redeemed code and never leaves the reactor. Returns injected=false when the
    caller has no active redemption carrying a key. Authenticated caller only.
    """
    applyInviteCodeSecret(
      tenantId: String!
      secretNames: [String!]!
    ): ApplyInviteCodeSecretResult!
    "Create a code, optionally attaching a Claude API key. Admin only."
    createInviteCode(
      code: String!
      label: String
      expiresAt: String
      maxUses: Int
      anthropicApiKey: String
    ): InviteCode!
    "Enable/disable a code. Admin only."
    setInviteCodeActive(code: String!, active: Boolean!): InviteCode!
    "Attach or rotate (value) / detach (null) a code's Claude API key. Admin only."
    setInviteCodeAnthropicKey(code: String!, anthropicApiKey: String): InviteCode!
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
