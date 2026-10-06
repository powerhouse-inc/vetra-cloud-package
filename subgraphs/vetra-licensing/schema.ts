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

  input ApplyEnvironmentTemplateInput {
    licenseId: String!
    label: String!
  }

  input ReleaseEnvironmentInput {
    environmentId: String!
  }

  type VetraLicensingQueries {
    appLicenses(status: String): [AppLicense!]!
    appLicenseTypes: [AppLicenseTypeSummary!]!
    appUserEnvironments: [AppUserEnvironment!]!
  }

  type VetraLicensingMutations {
    applyEnvironmentTemplate(
      input: ApplyEnvironmentTemplateInput!
    ): AppUserEnvironment!
    releaseEnvironment(input: ReleaseEnvironmentInput!): Boolean!
  }

  type AppLicense {
    id: String!
    user: String!
    licenseTypeId: String!
    status: String!
    start: String
    end: String
  }

  type AppLicenseTypeSummary {
    id: String!
    kind: String!
    status: String!
    templateHash: String!
  }

  type Query {
    vetraLicensing: VetraLicensingQueries!
  }

  type Mutation {
    vetraLicensing: VetraLicensingMutations!
  }
`;
