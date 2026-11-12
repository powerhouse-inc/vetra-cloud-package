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
    "shared/own: the plan it serves"
    planId: String
    "own: the holder's address"
    holder: String
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
    "restore:<id> while a backup is restored into it; held:<id> after a failed restore (stays stopped until a restore succeeds)"
    maintenance: String
    updatedAt: String!
  }

  "A backup of a shared or own instance: its database and /data, taken together (releases phase 3 slice 4)"
  type InstanceBackup {
    id: ID!
    instanceId: ID!
    "pre_update | daily | manual | pre_restore | pre_stop"
    reason: String!
    "pending | ready | failed"
    status: String!
    "The release the instance ran when it was taken"
    version: String
    sizeBytes: Float
    error: String
    requestedBy: String!
    createdAt: String!
    finishedAt: String
    expiresAt: String!
    rolloutStepId: ID
  }

  type InstanceRestore {
    id: ID!
    instanceId: ID!
    backupId: ID!
    "rollback | failed_update | manual"
    purpose: String!
    "safety_backup | stopping | restoring_db | restoring_data | starting | succeeded | failed"
    status: String!
    "The release the instance runs afterwards (null: unchanged)"
    thenVersion: String
    error: String
    "Failed with /data possibly half restored: the instance stays stopped"
    held: Boolean!
    requestedBy: String!
    createdAt: String!
    finishedAt: String
  }

  "What holders of one licensing term get (spec: releases and instances, section 7). The plan adopted the term by its kind."
  type AppPlan {
    id: ID!
    appId: ID!
    slug: String!
    name: String!
    kind: String!
    "shared | own"
    access: String!
    "VETRA_AGENT_S … VETRA_AGENT_XXL"
    size: String!
    targetVersion: String
    "manual (rollouts arrive later)"
    policy: String!
    noticeHours: Int!
    "active | retired"
    status: String!
    createdAt: String!
    updatedAt: String!
  }

  "An instance the caller holds a licence for"
  type HolderInstance {
    instanceId: ID!
    appId: ID!
    appName: String!
    planName: String!
    "shared | own"
    access: String!
    url: String
    status: String!
    reason: String
    runningVersion: String
  }

  input CreatePlanInput {
    appId: ID!
    "The licensing term's kind; it must have no holders yet"
    kind: String!
    "shared | own"
    access: String!
    slug: String
    name: String
    size: String
    "A recorded release of the App"
    targetVersion: String
  }

  input UpdatePlanInput {
    planId: ID!
    name: String
    size: String
  }

  "Who did what to an App, when and from where (spec: releases and instances, section 10). Kept one year."
  type AppAuditEntry {
    id: ID!
    appId: ID!
    at: String!
    "A lowercased address (a person, or the address CI acts for), or vetra for Vetra itself"
    actor: String!
    "console | api | policy | system | ci"
    source: String!
    "plan.created | plan.updated | plan.target_set | plan.retired | setting.set | setting.deleted | role.granted | role.removed | instance.status | release.recorded | build.recorded | backup.requested | backup.failed | restore.started | restore.finished"
    action: String!
    "plan:<id> | setting:<SCOPE>/<NAME> | role:<address> | instance:<id> | release:<version>"
    subject: String!
    "A JSON object; never a setting value or secret"
    detail: String!
  }

  type AppAuditPage {
    "Newest first"
    entries: [AppAuditEntry!]!
    "Pass as before for the next (older) page; null on the last page"
    nextBefore: String
  }

  "A per-App role kept by Vetra (release managers: plans, settings and rollouts without being an org admin)"
  type AppRole {
    appId: ID!
    address: String!
    "release_manager"
    role: String!
    grantedBy: String!
    grantedAt: String!
  }

  "What the signed-in caller may do with an App"
  type AppAccess {
    "Edit, deploy, roll back, delete (owner, org OWNER/ADMIN, publishers in scope)"
    operate: Boolean!
    "Plans, settings, rollouts (operators and release managers)"
    release: Boolean!
    "Name release managers (owner, org OWNER/ADMIN)"
    administer: Boolean!
    releaseManager: Boolean!
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
    "An instance's backups, newest first (shared and own instances; metadata only)"
    instanceBackups(instanceId: ID!, limit: Int): [InstanceBackup!]!
    "An instance's restores, newest first"
    instanceRestores(instanceId: ID!): [InstanceRestore!]!
    "The App's settings and the ones Vetra sets (operators)"
    appSettings(appId: ID!): AppSettings!
    appPlans(appId: ID!): [AppPlan!]!
    "The App's audit log, newest first (default 50, at most 200 per page)"
    appAudit(appId: ID!, limit: Int, before: String): AppAuditPage!
    "The App's release managers"
    appRoles(appId: ID!): [AppRole!]!
    "What the caller may do with the App; FORBIDDEN when the caller may not view it"
    appAccess(appId: ID!): AppAccess!
    "Instances of the plans the caller holds licences of"
    myInstances: [HolderInstance!]!
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
    "Turn a licensing term into a plan (shared or own instances)"
    createPlan(input: CreatePlanInput!): AppPlan!
    updatePlan(input: UpdatePlanInput!): AppPlan!
    "Move the plan's instances to a release at once (no notice; replaced by rollouts)"
    setPlanTarget(planId: ID!, version: String!): AppPlan!
    retirePlan(planId: ID!): AppPlan!
    "Back up a shared or own instance now (database and /data)"
    backUpInstance(instanceId: ID!): InstanceBackup!
    "Restore one of the instance's backups into it; acceptDataLoss must be true (data written since is lost)"
    restoreInstanceBackup(instanceId: ID!, backupId: ID!, acceptDataLoss: Boolean!): InstanceRestore!
    "Name a release manager (owner or org OWNER/ADMIN; role default release_manager)"
    setAppRole(appId: ID!, address: String!, role: String): AppRole!
    removeAppRole(appId: ID!, address: String!, role: String): Boolean!
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
