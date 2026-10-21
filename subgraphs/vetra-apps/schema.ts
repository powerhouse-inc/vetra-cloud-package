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

  "Who started a deployment (D20)."
  enum DeploymentTrigger {
    STUDIO_LAUNCH
    STUDIO_ROLLBACK
    OWNER
    CI
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
    "GitHub account the repository is in (Studio products, attachStudioRepository); null when not recorded."
    accountLogin: String
    "GitHub's account type of accountLogin (User or Organization); null when not recorded."
    accountType: String
    "When GitHub took the repository away (a Studio product stays live); null while connected."
    disconnectedAt: String
  }

  "A short-lived credential to push a Studio product's code to its repository."
  type StudioPushToken {
    "Installation token limited to the App's repository (contents: write)."
    token: String!
    "At most one hour after it was issued."
    expiresAt: String!
    "HTTPS URL of the repository, without credentials."
    remoteUrl: String!
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
    "Null on deployments made before the trigger was recorded."
    trigger: DeploymentTrigger
    "did:pkh of the owner the deployment was made for."
    onBehalfOf: String
    "The Studio product's version (Studio launches and rollbacks to them)."
    versionNumber: Int
    createdAt: String!
    updatedAt: String!
    urls: AppUrls!
  }

  type App {
    id: ID!
    slug: String!
    name: String!
    ownerAddress: String!
    "Renown organisation owning the App; null for personal Apps."
    ownerOrgId: String
    studioEnvironmentId: String
    status: AppStatus!
    "The GitHub repository; null for a Studio product without GitHub."
    repository: AppRepository
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
    "The live product's drive (Studio products), set at first launch."
    productDriveId: String
    "When the product first went live; null = never launched."
    launchedAt: String
    "Head commit of the latest push to the production branch made outside the Studio (Studio products); null when none or brought in."
    externalChangesSha: String
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

  input CreateStudioAppInput {
    name: String!
    studioEnvironmentId: String!
    "The caller's connected Vetra Deploy installation; the repository is created in its account."
    installationId: String!
    orgId: String
  }

  input AttachStudioRepositoryInput {
    appId: ID!
    "One of the caller's connected Vetra Deploy installations; the repository is created in its account (personal or organisation)."
    installationId: String!
    "Repository name wanted (default: the product's slug; a taken name gets a suffix)."
    name: String
  }

  input EnsureStudioProductInput {
    studioEnvironmentId: String!
    name: String!
    "An existing environment of the Studio's owner that becomes the product's live environment."
    adoptEnvironmentId: String
  }

  input CreateAppInput {
    name: String!
    installationId: String!
    repositoryId: String!
    productionBranch: String
    productionEnvironmentId: String
    "Create the App for this Renown organisation (OWNER/ADMIN, or PUBLISHER with access to all apps)."
    orgId: String
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

  input LaunchStudioVersionInput {
    appId: ID!
    versionNumber: Int!
    sha: String!
    gitTag: String!
    packages: [DeployedPackageInput!]!
  }

  type Query {
    "Personal Apps, or with orgId the organisation's Apps (members only)"
    myApps(orgId: String, "Also list Studio products (with or without a GitHub repository); without it only Apps deployed by their own CI" includeStudioProducts: Boolean): [App!]!
    app(id: ID!): App
    "The Studio's product App (its agent with the launch secret header, or the owner)"
    studioProduct(studioEnvironmentId: String!): App
    appDeployments(appId: ID!, limit: Int): [AppDeployment!]!
    appDeployment(id: ID!): AppDeployment
    "A deployment of the Studio's own product (its agent, with the launch secret header)"
    studioDeployment(id: ID!): AppDeployment
    githubDeployAppInfo: GithubDeployAppInfo!
    myGithubDeployInstallations: [GithubDeployInstallation!]!
    githubDeployRepositories(installationId: String!): [GithubRepo!]!
  }

  type Mutation {
    connectGithubDeploy(code: String!): [GithubDeployInstallation!]!
    createApp(input: CreateAppInput!): App!
    createStudioApp(input: CreateStudioAppInput!): App!
    "The Studio's product App and live environment, created on first call (no GitHub needed)"
    ensureStudioProduct(input: EnsureStudioProductInput!): App!
    confirmAppIdentity(appId: ID!): App!
    updateApp(appId: ID!, input: UpdateAppInput!): App!
    deleteApp(appId: ID!, deleteEnvironments: Boolean!): Boolean!
    openAppSetupPullRequest(appId: ID!): String!
    appRegistryCredentials(appId: ID!): AppRegistryCredentials!
    deployApp(input: DeployAppInput!): AppDeployment!
    rollbackApp(deploymentId: ID!): AppDeployment!
    "The Studio's agent puts a version of its own product live (returns PENDING; idempotent per appId, versionNumber, sha)"
    launchStudioVersion(input: LaunchStudioVersionInput!): AppDeployment!
    "The Studio's agent makes a READY production deployment of its own product live again"
    rollbackStudioVersion(deploymentId: ID!): AppDeployment!
    "The Studio's agent records its product's drive (once) and opens the live Connect on it"
    setStudioProductDrive(appId: ID!, driveId: String!): App!
    "The owner keeps a copy of a Studio product's code on GitHub: a private repository in their account or an organisation (no deploy workflow)"
    attachStudioRepository(input: AttachStudioRepositoryInput!): App!
    "The Studio's agent carries its Studio's existing GitHub repository (connected before GitHub moved to the product's settings) over to its product, when Vetra Deploy reaches it; nothing is created or moved (with the launch secret header; studioPushToken does this on its own)"
    adoptStudioRepository(appId: ID!): App!
    "The Studio's agent gets a short-lived push token for its own product's repository, carrying its Studio's existing repository over first when the product has none (with the launch secret header)"
    studioPushToken(appId: ID!): StudioPushToken!
    "The Studio's agent records the commit it is about to push to its product's repository, so that push is not taken for a change made on GitHub (with the launch secret header)"
    recordStudioMirror(appId: ID!, sha: String!): Boolean!
    "The Studio's agent brought the changes made on GitHub into its product (with the launch secret header)"
    clearExternalChanges(appId: ID!): Boolean!
    "Admin: give a claimed Studio a new launch secret (writes only that key; backfills Studios without one)"
    rotateStudioLaunchSecret(environmentId: String!): Boolean!
  }
`;
