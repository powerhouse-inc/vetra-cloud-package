import { gql } from "graphql-tag";
import type { DocumentNode } from "graphql";

export const schema: DocumentNode = gql`
  scalar JSON

  """
  Resolved Connect runtime configuration for a tenant. \`effective\` is
  BUNDLED_DEFAULT_CONNECT_CONFIG deep-merged with \`overrides\`; the SPA
  sees \`effective\` once the change has propagated through the
  secrets-controller → ConfigMap → pod restart pipeline.
  """
  type RuntimeConfigPayload {
    "Defaults merged with user overrides. Always fully populated."
    effective: JSON!

    "Only the keys the user has explicitly set. Empty object when no overrides exist."
    overrides: JSON!

    "Schema version of the runtime-config JSON Schema this resolver knows."
    schemaVersion: String!

    "ISO-8601 timestamp of the most recent override write; null when no overrides exist."
    updatedAt: String
  }

  extend type Query {
    """
    Fetch the runtime config for a tenant. Returns the default \`connect.*\`
    config deep-merged with stored overrides.
    """
    runtimeConfig(tenantId: String!): RuntimeConfigPayload!
  }

  extend type Mutation {
    """
    Replace the runtime-config overrides for a tenant.

    The provided JSON is the \`connect.*\` subtree of powerhouse.config.json
    (not the full envelope — packages / schemaVersion / etc. are managed
    elsewhere). Validates against the bundled runtime-config JSON Schema;
    invalid input is rejected with INVALID_RUNTIME_CONFIG. An empty object
    clears all overrides.
    """
    setRuntimeConfig(tenantId: String!, json: JSON!): RuntimeConfigPayload!
  }
`;
