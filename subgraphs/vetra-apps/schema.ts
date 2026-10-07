import type { DocumentNode } from "graphql";
import { gql } from "graphql-tag";

/** Contract C3 — Vetra Apps (vetra switchboard). */
export const schema: DocumentNode = gql`
  enum AppStatus {
    PENDING_IDENTITY
    ACTIVE
    DISCONNECTED
    DELETED
  }

  enum AppDeploymentKind {
    PRODUCTION
    PREVIEW
  }

  enum AppDeploymentStatus {
    PENDING
    DEPLOYING
    READY
    FAILED
    SUPERSEDED
  }

  type AppRepository {
    installationId: String!
    repositoryId: String!
    fullName: String!
  }

  type AppUrls {
    app: String
    connect: String
    switchboard: String
  }

  type AppPreview {
    environmentId: String!
    prNumber: Int!
    gitRef: String
    prUrl: String!
    lastDeployedAt: String
    status: AppDeploymentStatus
    urls: AppUrls!
  }

  type DeployedPackage {
    name: String!
    version: String!
  }

  type AppDeployment {
    id: ID!
    appId: ID!
    environmentId: String
    kind: AppDeploymentKind!
    prNumber: Int
    gitRef: String!
    sha: String!
    packages: [DeployedPackage!]!
    imageTag: String
    status: AppDeploymentStatus!
    actorDid: String
    actorGithub: String
    runUrl: String
    error: String
    createdAt: String!
    updatedAt: String!
    urls: AppUrls!
  }

  type App {
    id: ID!
    slug: String!
    name: String!
    ownerAddress: String!
    status: AppStatus!
    repository: AppRepository!
    productionBranch: String!
    productionEnvironmentId: String!
    previewsEnabled: Boolean!
    previewLimit: Int!
    previewTtlDays: Int!
    harborProject: String!
    identityDid: String!
    """
    When the owner's authorization of the App identity expires (CI stops deploying then); null = unknown.
    """
    identityExpiresAt: String
    renownAuthorizeUrl: String!
    productionUrls: AppUrls!
    previews: [AppPreview!]!
    latestDeployment: AppDeployment
    createdAt: String!
    updatedAt: String!
  }

  type GithubDeployInstallation {
    installationId: String!
    accountLogin: String!
    accountType: String!
  }

  type GithubRepo {
    id: String!
    fullName: String!
    private: Boolean!
    defaultBranch: String!
  }

  type AppRegistryCredentials {
    registry: String!
    project: String!
    username: String!
    password: String!
  }

  type GithubDeployAppInfo {
    slug: String!
    installUrl: String!
    authorizeUrl: String!
  }

  input CreateAppInput {
    name: String!
    installationId: String!
    repositoryId: String!
    productionBranch: String
    productionEnvironmentId: String
  }

  input UpdateAppInput {
    name: String
    productionBranch: String
    previewsEnabled: Boolean
    previewLimit: Int
    previewTtlDays: Int
  }

  input DeployedPackageInput {
    name: String!
    version: String!
  }

  input DeployAppInput {
    appId: ID!
    kind: AppDeploymentKind!
    prNumber: Int
    gitRef: String!
    sha: String!
    runUrl: String
    actorGithub: String
    packages: [DeployedPackageInput!]!
    imageTag: String
  }

  type Query {
    myApps: [App!]!
    app(id: ID!): App
    appDeployments(appId: ID!, limit: Int): [AppDeployment!]!
    appDeployment(id: ID!): AppDeployment
    githubDeployAppInfo: GithubDeployAppInfo!
    myGithubDeployInstallations: [GithubDeployInstallation!]!
    githubDeployRepositories(installationId: String!): [GithubRepo!]!
  }

  type Mutation {
    connectGithubDeploy(code: String!): [GithubDeployInstallation!]!
    createApp(input: CreateAppInput!): App!
    confirmAppIdentity(appId: ID!): App!
    updateApp(appId: ID!, input: UpdateAppInput!): App!
    deleteApp(appId: ID!, deleteEnvironments: Boolean!): Boolean!
    openAppSetupPullRequest(appId: ID!): String!
    appRegistryCredentials(appId: ID!): AppRegistryCredentials!
    deployApp(input: DeployAppInput!): AppDeployment!
    rollbackApp(deploymentId: ID!): AppDeployment!
  }
`;
