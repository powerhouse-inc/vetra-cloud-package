import { gql } from "graphql-tag";
import { Kind, type DocumentNode } from "graphql";
import { publisherSchema } from "./publisher-schema.js";
import { subscriptionsSchema } from "./subscriptions-schema.js";

/**
 * The machine surface (vetraLicensing, contract § vetraLicensing (machine)):
 * app backends calling with their App identity. Served as part of `schema`.
 */
export const machineSchema: DocumentNode = gql`
  type AppUserEnvironment {
    appId: String!
    user: String!
    environmentId: String!
    licenseId: String!
    rootLicenseId: String!
    label: String
    templateHash: String!
    stoppedAt: String
    deleteAfter: String
  }

  input ApplyEnvironmentTemplateInput {
    licenseId: String!
    label: String!
  }

  input ReleaseEnvironmentInput {
    environmentId: String!
  }

  input IssuePublisherGrantInput {
    kind: String!
    user: String!
  }

  type AppLicense {
    id: String!
    user: String!
    kind: String!
    status: String!
    start: String
    end: String
    environmentId: String
  }

  type AppTermSummary {
    id: String!
    kind: String!
    status: String!
    templateHash: String
  }

  type VetraLicensingQueries {
    appLicenses(status: String): [AppLicense!]!
    appTerms: [AppTermSummary!]!
    appUserEnvironments: [AppUserEnvironment!]!
    "SHARED apps: does this DID hold an ACTIVE licence for the calling app?"
    hasLicense(user: String!): Boolean!
  }

  type VetraLicensingMutations {
    """
    Provision (or bring up to its term's template) the environment of the
    chain whose newest licence this is. Acts immediately: LICENSING_DRY_RUN
    covers only the autonomous handler, not machine mutations (which
    LICENSING_KEEPER_ENABLED gates). BUSY: the chain is busy, retry later.
    """
    applyEnvironmentTemplate(
      input: ApplyEnvironmentTemplateInput!
    ): AppUserEnvironment!
    """
    Starts the offboarding clock of an environment whose licence chain has
    ended (false otherwise); never stops or deletes it directly. Not covered
    by LICENSING_DRY_RUN. BUSY: the chain is busy, retry later.
    """
    releaseEnvironment(input: ReleaseEnvironmentInput!): Boolean!
    """
    Issue a PUBLISHER_GRANT licence of one of the caller app's own terms.
    Returns the new licence document id.
    """
    issuePublisherGrant(input: IssuePublisherGrantInput!): String!
    "Caller = environment reporting token. Forwards to Renown signed as the app."
    reportUserStat(user: String!, metric: String!, value: Float!): Boolean!
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
