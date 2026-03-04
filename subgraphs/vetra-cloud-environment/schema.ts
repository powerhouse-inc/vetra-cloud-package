import { gql } from "graphql-tag";
import type { DocumentNode } from "graphql";

export const schema: DocumentNode = gql`
  """
  Subgraph definition for VetraCloudEnvironment (powerhouse/vetra-cloud-environment)
  """
  enum VetraCloudEnvironmentService {
    CONNECT
    SWITCHBOARD
  }

  enum VetraCloudEnvironmentStatus {
    STOPPED
    STARTED
  }

  type VetraCloudPackage {
    name: String!
    version: String
  }

  type VetraCloudEnvironmentState {
    name: String
    services: [VetraCloudEnvironmentService!]!
    packages: [VetraCloudPackage!]
    status: VetraCloudEnvironmentStatus!
  }

  """
  Queries: VetraCloudEnvironment
  """
  type VetraCloudEnvironmentQueries {
    getDocument(docId: PHID!, driveId: PHID): VetraCloudEnvironment
    getDocuments(driveId: String!): [VetraCloudEnvironment!]
  }

  type Query {
    VetraCloudEnvironment: VetraCloudEnvironmentQueries
  }

  """
  Mutations: VetraCloudEnvironment
  """
  type Mutation {
    VetraCloudEnvironment_createDocument(name: String!, driveId: String): String

    VetraCloudEnvironment_setEnvironmentName(
      driveId: String
      docId: PHID
      input: VetraCloudEnvironment_SetEnvironmentNameInput
    ): Int
    VetraCloudEnvironment_enableService(
      driveId: String
      docId: PHID
      input: VetraCloudEnvironment_EnableServiceInput
    ): Int
    VetraCloudEnvironment_disableService(
      driveId: String
      docId: PHID
      input: VetraCloudEnvironment_DisableServiceInput
    ): Int
    VetraCloudEnvironment_addPackage(
      driveId: String
      docId: PHID
      input: VetraCloudEnvironment_AddPackageInput
    ): Int
    VetraCloudEnvironment_removePackage(
      driveId: String
      docId: PHID
      input: VetraCloudEnvironment_RemovePackageInput
    ): Int
    VetraCloudEnvironment_start(
      driveId: String
      docId: PHID
      input: VetraCloudEnvironment_StartInput
    ): Int
    VetraCloudEnvironment_stop(
      driveId: String
      docId: PHID
      input: VetraCloudEnvironment_StopInput
    ): Int
  }

  """
  Module: DataManagement
  """
  input VetraCloudEnvironment_SetEnvironmentNameInput {
    "Add your inputs here"
    name: String!
  }

  """
  Module: Services
  """
  input VetraCloudEnvironment_EnableServiceInput {
    "Add your inputs here"
    serviceName: VetraCloudEnvironmentService!
  }
  input VetraCloudEnvironment_DisableServiceInput {
    "Add your inputs here"
    serviceName: VetraCloudEnvironmentService!
  }

  """
  Module: Packages
  """
  input VetraCloudEnvironment_AddPackageInput {
    "Add your inputs here"
    packageName: String!
    version: String
  }
  input VetraCloudEnvironment_RemovePackageInput {
    "Add your inputs here"
    packageName: String!
  }

  """
  Module: Status
  """
  input VetraCloudEnvironment_StartInput {
    "Add your inputs here"
    _placeholder: String
  }
  input VetraCloudEnvironment_StopInput {
    "Add your inputs here"
    _placeholder: String
  }
`;
