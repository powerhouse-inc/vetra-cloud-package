import { gql } from "graphql-tag";
import type { DocumentNode } from "graphql";

export const schema: DocumentNode = gql`
  type ClaimStudioEnvironmentResult {
    documentId: String!
    subdomain: String!
    tenantId: String!
  }

  type VetraStudioPoolMutations {
    "Claim a warm studio env for the authenticated invite-code caller. Null when none available."
    claimStudioEnvironment: ClaimStudioEnvironmentResult
  }

  type Query {
    VetraStudioPool: String
  }

  type Mutation {
    VetraStudioPool: VetraStudioPoolMutations!
  }
`;
