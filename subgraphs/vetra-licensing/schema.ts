import { gql } from "graphql-tag";
import { Kind, type DocumentNode } from "graphql";
import { publisherSchema } from "./publisher-schema.js";
import { subscriptionsSchema } from "./subscriptions-schema.js";

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
 * Everything this subgraph serves: the machine, publisher and subscriptions
 * surfaces in one document. The publisher and subscriptions documents extend
 * Query and Mutation, so they are only valid together with the machine
 * document. Each defines its own types (PublisherEnvironment, not the machine
 * AppUserEnvironment).
 */
export const schema: DocumentNode = {
  kind: Kind.DOCUMENT,
  definitions: [
    ...machineSchema.definitions,
    ...publisherSchema.definitions,
    ...subscriptionsSchema.definitions,
  ],
};
