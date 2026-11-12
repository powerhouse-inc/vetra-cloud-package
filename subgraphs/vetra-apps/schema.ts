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

  "A release or build an app's CI published (spec: releases and instances, section 4)."
  type AppRelease {
    version: String!
    kind: String!
    branch: String
    pr: Int
    commit: String!
    notes: String
    customerNotes: String
    imageRef: String!
    imageDigest: String!
    host: String!
    packages: [AppReleasePackage!]!
    migrates: Boolean!
    "The project's Powerhouse version the image was built with."
    powerhouseVersion: String!
    createdAt: String!
  }

  type AppReleasePackage {
    name: String!
    version: String!
  }

  "A running environment of an app (spec: releases and instances, section 5)."
  type AppInstance {
    id: ID!
    "branch | preview | shared | own"
    kind: String!
    name: String!
    branch: String
    pr: Int
    url: String
    "pending | updating | ready | degraded | failed | stopped"
    status: String!
    reason: String
    targetVersion: String
    targetDigest: String
    runningVersion: String
    runningDigest: String
    "The App settings revision the instance should run (VETRA_SETTINGS_REVISION)"
    settingsRevision: String
    "The settings revision it last ran healthy"
    runningSettingsRevision: String
    "healthy | unhealthy | unknown; null until first checked (spec 14.7)"
    health: String
    "The check behind it: gitops | image | crash | restarts | pod | switchboard | connect | stopped | data"
    healthCheck: String
    healthReason: String
    healthCheckedAt: String
    "The digest the cluster runs (the pod's imageID; see observedDigestSource)"
    observedDigest: String
    "pod | document (the environment's tag, while the pod reports no imageID)"
    observedDigestSource: String
    environmentId: String
    updatedAt: String!
  }

  "Where a publisher setting applies: every instance of the App, or only its branch or preview instances (wins over ALL for the same name)."
  enum AppSettingScope {
    ALL
    BRANCH
    PREVIEW
  }

  "A publisher setting (spec 14.2). Secrets are write-only: value is null for them."
  type AppSetting {
    name: String!
    scope: AppSettingScope!
    secret: Boolean!
    value: String
    updatedAt: String!
    updatedBy: String!
  }

  "A setting Vetra sets on every instance; publishers cannot set or override it."
  type VetraInstanceSetting {
    name: String!
    secret: Boolean!
    "What Vetra sets (a description where the value differs per instance)"
    value: String!
  }

  type AppSettings {
    settings: [AppSetting!]!
    vetra: [VetraInstanceSetting!]!
    "Names no setting may have"
    reservedNames: [String!]!
    "Prefixes no setting name may start with"
    reservedPrefixes: [String!]!
  }

  input SetAppSettingInput {
    appId: ID!
    "Capitals, digits and _ (e.g. SEKTAR_OAUTH_RELAY_BASE)"
    name: String!
    value: String!
    "Secret: stored encrypted, never shown again"
    secret: Boolean!
    "Default ALL"
    scope: AppSettingScope
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
    "Branches besides productionBranch that may publish releases: exact names, or * within one path segment (*.x, release/*)."
    releaseBranches: [String!]!
    productionEnvironmentId: String!
    previewsEnabled: Boolean!
    previewLimit: Int!
    previewTtlDays: Int!
    "Whether Vetra runs this App's instances (one per release branch)."
    instancesEnabled: Boolean!
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
    "Replaces the release branches (at most 20; [] clears them)."
    releaseBranches: [String!]
    previewsEnabled: Boolean
    previewLimit: Int
    previewTtlDays: Int
    instancesEnabled: Boolean
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
    appReleases(appId: ID!, kind: String, limit: Int): [AppRelease!]!
    appInstances(appId: ID!): [AppInstance!]!
    "The App's settings and the ones Vetra sets (operators)"
    appSettings(appId: ID!): AppSettings!
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
    "Set or replace a publisher setting; every instance of the App (or of the scope) rolls on the next pass"
    setAppSetting(input: SetAppSettingInput!): AppSetting!
    "Delete a publisher setting (default scope ALL); instances roll without it"
    deleteAppSetting(
      appId: ID!
      name: String!
      scope: AppSettingScope
    ): Boolean!
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
    "The Studio's agent gets a short-lived push token for its own product's repository, carrying its Studio's existing repository over first when the product has none (with the launch secret header). GITHUB_NOT_CONNECTED carries extensions.reason: NEVER_CONNECTED (never had a repository), DISCONNECTED (GitHub took it away) or TOKEN_REFUSED (no token given for the recorded one)"
    studioPushToken(appId: ID!): StudioPushToken!
    "The Studio's agent records the commit it is about to push to its product's repository, so that push is not taken for a change made on GitHub (with the launch secret header)"
    recordStudioMirror(appId: ID!, sha: String!): Boolean!
    "The Studio's agent brought the changes made on GitHub into its product (with the launch secret header)"
    clearExternalChanges(appId: ID!): Boolean!
    "Admin: give a claimed Studio a new launch secret (writes only that key; backfills Studios without one)"
    rotateStudioLaunchSecret(environmentId: String!): Boolean!
  }
`;
