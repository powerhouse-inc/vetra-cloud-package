import type { DocumentNode } from "graphql";
import { gql } from "graphql-tag";

/** Vetra LLM broker: per-Studio OpenRouter keys from the licence's monthly budget. */
export const schema: DocumentNode = gql`
  type StudioLlmStatus {
    environmentId: String!
    "True when the Studio's tenant holds an OPENROUTER_API_KEY (Vetra-provisioned or user-set)."
    connected: Boolean!
  }

  type StudioLlmUsage {
    "VETRA (Vetra budget) or BYO (the user's OpenRouter account, phase 2)."
    source: String!
    model: String!
    "Spend this month (USD)."
    usageUsd: Float!
    "Monthly limit (USD); null when unlimited."
    limitUsd: Float
    "When the monthly limit resets (ISO); null when it does not."
    resetsAt: String
  }

  type StudioLlmProvision {
    environmentId: String!
    "False when the licence has no LLM budget: the Studio runs in connect-a-model mode."
    connected: Boolean!
    llmBudgetUsd: Float!
  }

  type StudioLlmMigrationReport {
    dryRun: Boolean!
    scanned: Int!
    provisioned: [String!]!
    noBudget: [String!]!
    noLicence: [String!]!
    failed: [String!]!
    anthropicSecretsRemoved: Int!
  }

  type VetraLlmQueries {
    "Operators of the Studio only."
    studioLlmStatus(environmentId: String!): StudioLlmStatus!
    "Operators of the Studio only; null without a key. Cached 60 s."
    studioLlmUsage(environmentId: String!): StudioLlmUsage
  }

  type VetraLlmMutations {
    "Cold Studio creation: provision the Studio's key from the caller's licence budget (replaces vetraSubscriptions.applyStudioKey). Every environment on the tenant must be the caller's."
    provisionStudioLlm(tenantId: String!): StudioLlmProvision!
    "Platform admins only. Gives every live, claimed Studio with a usable licence its Vetra key; removeAnthropicSecrets also deletes the three Anthropic secrets (cut-over step 4)."
    migrateStudiosToOpenRouter(
      dryRun: Boolean = true
      removeAnthropicSecrets: Boolean = false
    ): StudioLlmMigrationReport!
  }

  extend type Query {
    vetraLlm: VetraLlmQueries!
  }

  extend type Mutation {
    vetraLlm: VetraLlmMutations!
  }
`;
