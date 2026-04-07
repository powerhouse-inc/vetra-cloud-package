import { gql } from "graphql-tag";
import type { DocumentNode } from "graphql";

export const schema: DocumentNode = gql`
  type Query {
    envVars(tenantId: String!): [EnvVar!]!
    secrets(tenantId: String!): [SecretEntry!]!
  }

  type Mutation {
    setEnvVar(tenantId: String!, key: String!, value: String!): EnvVar!
    deleteEnvVar(tenantId: String!, key: String!): Boolean!
    setSecret(tenantId: String!, key: String!, value: String!): SecretEntry!
    deleteSecret(tenantId: String!, key: String!): Boolean!
  }

  type EnvVar {
    key: String!
    value: String!
  }

  type SecretEntry {
    key: String!
  }
`;
