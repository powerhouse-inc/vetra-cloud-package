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

  type StudioPoolConfig {
    "The vetra-cli version the pool currently provisions (from STUDIO_POOL_VERSION)."
    version: String!
  }

  type VetraStudioPoolQueries {
    "Live provisioning config so clients source the version instead of baking it into a cacheable bundle."
    config: StudioPoolConfig!
  }

  type Query {
    VetraStudioPool: VetraStudioPoolQueries
  }

  type Mutation {
    VetraStudioPool: VetraStudioPoolMutations!
  }
`;
