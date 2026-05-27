import { gql } from "graphql-tag";

export const typeDefs = gql`
  scalar JSON

  """
  Resolved runtime configuration for the Connect instance of a given tenant.
  """
  type RuntimeConfigPayload {
    "Default config deep-merged with overrides. Always fully populated."
    effective: JSON!

    "Only the keys the user has explicitly set."
    overrides: JSON!

    "Schema version of the runtime-config JSON Schema."
    schemaVersion: String!

    "ISO-8601 timestamp of the most recent override write, or null when none."
    updatedAt: String
  }

  extend type Query {
    """
    Fetch the runtime config for the Connect instance of the given tenant.
    """
    runtimeConfig(tenantId: String!): RuntimeConfigPayload!
  }

  extend type Mutation {
    """
    Replace the runtime config overrides for the given tenant. Validates the
    provided JSON against the runtime-config schema; invalid input is
    rejected with INVALID_RUNTIME_CONFIG. Passing the empty object clears
    overrides and reverts to defaults.
    """
    setRuntimeConfig(tenantId: String!, json: JSON!): RuntimeConfigPayload!
  }
`;
