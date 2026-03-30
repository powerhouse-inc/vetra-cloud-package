import { gql } from "graphql-tag";

export const schema = gql`
  input NewImageReleaseInput {
    tag: String!
    channel: String!
    images: [String!]!
    secret: String!
  }

  type AutoUpdateResult {
    updatedEnvironments: [String!]!
  }

  type Mutation {
    notifyNewImageRelease(input: NewImageReleaseInput!): AutoUpdateResult!
  }
`;
