import { gql } from "graphql-tag";
import type { DocumentNode } from "graphql";

export const schema: DocumentNode = gql`
  type AppUserEnvironment {
    appId: String!
    user: String!
    environmentId: String!
    licenseId: String!
    templateHash: String!
  }

  type VetraLicensingQueries {
    _placeholder: Boolean
  }

  type Query {
    vetraLicensing: VetraLicensingQueries!
  }
`;
