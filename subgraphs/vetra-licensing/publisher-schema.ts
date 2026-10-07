import { gql } from "graphql-tag";
import type { DocumentNode } from "graphql";

/**
 * The human surface. Every field here takes an appId or a document id and
 * authorises it against apps.owner_address -- the exact opposite of
 * vetraLicensing, where the app is derived from the caller's App identity and
 * an id argument would be a vulnerability.
 */
export const publisherSchema: DocumentNode = gql`
  type PublisherApp {
    id: String!
    name: String!
    status: String!
  }

  type PublisherLicenseType {
    id: String!
    kind: String
    label: String
    status: String!
    validityDays: Int
    templateHash: String!
    # The template's scalar fields. SET_TEMPLATE is a full replace, so a client
    # editing one of them must read all three to send the others back unchanged.
    size: String
    baseDomain: String
    packageRegistry: String
    services: [PublisherTemplateService!]!
    packages: [PublisherTemplatePackage!]!
  }

  type PublisherTemplateService {
    id: String!
    type: String!
    prefix: String
  }

  type PublisherTemplatePackage {
    id: String!
    packageName: String
    version: String
  }

  type PublisherLicense {
    id: String!
    user: String!
    licenseTypeId: String!
    status: String!
    start: String
    end: String
    environmentId: String
  }

  input CreateLicenseTypeInput {
    appId: String!
    kind: String!
    label: String
    validityDays: Int
  }

  # Deliberately no app field: a type's app is fixed at creation.
  input SetLicenseTypeDetailsInput {
    licenseTypeId: String!
    kind: String
    label: String
    validityDays: Int
  }

  input SetLicenseTypeTemplateInput {
    licenseTypeId: String!
    size: String
    baseDomain: String
    packageRegistry: String
  }

  input AddLicenseTypeServiceInput {
    licenseTypeId: String!
    type: String!
    prefix: String
  }

  input AddLicenseTypePackageInput {
    licenseTypeId: String!
    packageName: String!
    version: String
  }

  input IssueGrantInput {
    appId: String!
    licenseTypeId: String!
    user: String!
  }

  input RevokeLicenseInput {
    licenseId: String!
    reason: String
  }

  type VetraPublisherQueries {
    myApps: [PublisherApp!]!
    licenseTypes(appId: String!): [PublisherLicenseType!]!
    licenses(appId: String!, status: String): [PublisherLicense!]!
    environments(appId: String!): [AppUserEnvironment!]!
  }

  type VetraPublisherMutations {
    createLicenseType(input: CreateLicenseTypeInput!): String!
    setLicenseTypeDetails(input: SetLicenseTypeDetailsInput!): Boolean!
    setLicenseTypeTemplate(input: SetLicenseTypeTemplateInput!): Boolean!
    addLicenseTypeService(input: AddLicenseTypeServiceInput!): Boolean!
    addLicenseTypePackage(input: AddLicenseTypePackageInput!): Boolean!
    publishLicenseType(licenseTypeId: String!): Boolean!
    retireLicenseType(licenseTypeId: String!): Boolean!
    issueGrant(input: IssueGrantInput!): String!
    revokeLicense(input: RevokeLicenseInput!): Boolean!
  }

  extend type Query {
    vetraPublisher: VetraPublisherQueries!
  }

  extend type Mutation {
    vetraPublisher: VetraPublisherMutations!
  }
`;
