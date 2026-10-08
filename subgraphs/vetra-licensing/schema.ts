import { gql } from "graphql-tag";
import { Kind, type DocumentNode } from "graphql";
import { publisherSchema } from "./publisher-schema.js";

/** The machine surface (vetraLicensing). Unchanged; served as part of `schema`. */
export const machineSchema: DocumentNode = gql`
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

  input IssuePublisherGrantInput {
    licenseTypeId: String!
    user: String!
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
    """
    Issue a PUBLISHER_GRANT licence for one of the caller app's own licence
    types. Returns the new licence document id.
    """
    issuePublisherGrant(input: IssuePublisherGrantInput!): String!
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

/**
 * Everything this subgraph serves: the machine surface and the publisher
 * surface in one document. The publisher document extends Query and Mutation,
 * so it is only valid together with the machine document. It defines its own
 * types (PublisherEnvironment, not the machine AppUserEnvironment).
 */
export const schema: DocumentNode = {
  kind: Kind.DOCUMENT,
  definitions: [...machineSchema.definitions, ...publisherSchema.definitions],
};
