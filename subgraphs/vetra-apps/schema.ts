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
    "Withdrawn by the publisher (spec 14.3): no plan may target it"
    withdrawnAt: String
    withdrawnBy: String
    withdrawnReason: String
    "When this release ran healthy on the App's Team instance (customer rollouts need it)"
    teamHealthyAt: String
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
    "own: the release the publisher pinned it to; rollouts skip it"
    pinnedVersion: String
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
    "A warm-pool instance: no holder yet, closed to everyone"
    warm: Boolean!
    "When a holder claimed it from the warm pool"
    claimedAt: String
    "own: how many settings its holder set (their names stay the holder's)"
    holderSettingsCount: Int!
    "own: the holder's custom domain"
    customDomain: InstanceCustomDomain
    updatedAt: String!
    "shared only: the licence gate"
    gate: AppInstanceGate
  }

  "The licence gate of a shared instance (spec 5, releases phase 3 slice 5)."
  type AppInstanceGate {
    "VETRA_APPS_GATE is on: the instance is given ACCESS=licensed"
    enabled: Boolean!
    "Its running (else target) release was built on a Powerhouse that enforces ACCESS=licensed"
    active: Boolean!
    "Why not active, in words (gate off, or built on Powerhouse < X)"
    reason: String
    tokenRotatedAt: String
    "False until the current token reached the instance's secrets"
    tokenDelivered: Boolean!
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
    "The licensing term adopted; null for the Team plan"
    kind: String
    "The App's Team plan (organisation members; follows a branch)"
    team: Boolean!
    "shared | own"
    access: String!
    "VETRA_AGENT_S … VETRA_AGENT_XXL"
    size: String!
    "Monthly AI budget in USD of every instance's own key; null: no AI key"
    aiBudgetUsd: Float
    targetVersion: String
    "manual | patches | minor | follow:<branch>: whether new releases roll out by themselves (stable only; in 0.x minor takes patches only; in 0.0.x patches and minor take nothing)"
    policy: String!
    noticeHours: Int!
    "When the plan's instances may be updated; null: any time after the notice"
    updateWindow: PlanUpdateWindow
    "The last release the policy could not roll out, and why"
    policyNote: String
    "active | retired"
    status: String!
    createdAt: String!
    updatedAt: String!
    "Warm instances kept ready for new holders (own plans); capped by Vetra"
    warmPoolSize: Int!
    "What is kept: warmPoolSize capped by this Vetra's limit"
    warmPoolEffective: Int!
    "Monthly cost of the warm instances, in euros (estimate)"
    warmPoolEurPerMonth: Int!
    "Warm instances ready to be claimed now"
    warmReady: Int!
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
    "own: the custom domain the holder set"
    customDomain: InstanceCustomDomain
    "The live licence's end; null when open-ended or none is live"
    licenceEndsAt: String
    "own, licence ended: when Vetra stops the instance"
    stopsAt: String
    "own, licence ended, deletion on: when its data is deleted"
    deletesAt: String
    notices: [HolderNotice!]!
    "own, just moved from a licensed environment: ask the holder to check it (confirmSwitchover); null otherwise"
    switchover: HolderSwitchover
    "A coming update of this instance; null when none"
    update: HolderUpdate
  }

  """
  A licensed environment moving to an own plan instance (plan 9; platform
  admins, except confirmSwitchover for its holder). Counts are per document
  type, never content.
  """
  type Switchover {
    id: ID!
    appId: ID!
    environmentId: ID!
    oldHost: String!
    kind: String!
    planId: ID!
    instanceId: ID
    "real | dry_run"
    mode: String!
    state: String!
    failedState: String
    error: String
    windowStart: String
    windowEnd: String
    releaseVersion: String!
    "JSON counts (admins only)"
    sourceCounts: String
    copyCounts: String
    startedCounts: String
    "JSON seconds per step (admins only)"
    timings: String
    downtimeStartedAt: String
    startedAt: String
    confirmedAt: String
    doneAt: String
    holdUntil: String
    canRollBack: Boolean!
    rollBackLosesWrites: Boolean!
  }

  type HolderSwitchover {
    id: ID!
    "LINKING | AWAITING_CONFIRMATION"
    state: String!
    "Without an answer by then the switch-over counts as confirmed"
    confirmBy: String!
  }

  enum HolderNoticeKind {
    EXPIRING
    ENDED_STOP_PENDING
    STOPPED
    STOPPED_DELETE_PENDING
    DELETE_IMMINENT
    APP_DISCONTINUED
  }

  type HolderNotice {
    kind: HolderNoticeKind!
    at: String
    message: String!
  }

  "Where a holder's custom domain stands: DNS (waiting for the holder's DNS), ISSUING (applied, certificate pending), ACTIVE (served), FAILED (see reason)"
  enum CustomDomainStatus {
    DNS
    ISSUING
    ACTIVE
    FAILED
  }

  "A DNS record the holder sets"
  type DnsRecordHint {
    type: String!
    host: String!
    value: String!
  }

  "A holder's custom domain on their own instance. Applying it moves the instance's host: the generated host stops serving, and HTTPS works once the certificate is issued (minutes)."
  type InstanceCustomDomain {
    domain: String!
    status: CustomDomainStatus!
    reason: String
    since: String
    records: [DnsRecordHint!]!
    "A CNAME instead of the A record (not at an apex domain)"
    alternative: DnsRecordHint
  }

  "A holder setting's kind: plain (value shown), secret or file (write-only)"
  enum HolderSettingKind {
    PLAIN
    SECRET
    FILE
  }

  "A setting the holder of an own instance set on it (spec 14.2). Only its holder sees it; secrets and files are write-only."
  type HolderSetting {
    name: String!
    kind: HolderSettingKind!
    "Plain settings only"
    value: String
    "Files only"
    mountPath: String
    updatedAt: String!
  }

  type HolderSettings {
    settings: [HolderSetting!]!
    vetra: [VetraInstanceSetting!]!
    "Names the App's publisher sets on this instance; a holder setting of the same name replaces it."
    publisherNames: [String!]!
    reservedNames: [String!]!
    reservedPrefixes: [String!]!
  }

  input SetHolderSettingInput {
    instanceId: ID!
    "Capitals, digits and _ (derived for files)"
    name: String
    kind: HolderSettingKind!
    value: String!
    "Files only: where the file is mounted"
    mountPath: String
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
    "Monthly AI budget in USD (0 < x <= 1000)"
    aiBudgetUsd: Float
    "A recorded release of the App"
    targetVersion: String
  }

  input UpdatePlanInput {
    planId: ID!
    name: String
    size: String
    "Monthly AI budget in USD; null removes it"
    aiBudgetUsd: Float
    "manual | patches | minor | follow:<branch>"
    policy: String
    "Hours holders are told before an update"
    noticeHours: Int
    updateWindow: PlanUpdateWindowInput
    "Remove the update window (any time after the notice)"
    clearUpdateWindow: Boolean
    "Warm instances kept ready for new holders (own plans only, 0 to 10); capped by Vetra"
    warmPoolSize: Int
  }

  "Weekdays 1 (Monday) to 7 (Sunday) the window starts on; local HH:MM; end <= start runs past midnight; equal: the whole day"
  type PlanUpdateWindow {
    days: [Int!]!
    start: String!
    end: String!
    "IANA time zone, e.g. Europe/Berlin"
    timeZone: String!
  }

  input PlanUpdateWindowInput {
    days: [Int!]!
    start: String!
    end: String!
    timeZone: String!
  }

  "A move of one or more plans to a release, one instance at a time (spec: releases and instances, section 7)"
  type PlanRollout {
    id: ID!
    appId: ID!
    version: String!
    "active | paused | complete | cancelled | rolled_back"
    status: String!
    "forward | back (a rollback)"
    direction: String!
    "console | api | policy"
    source: String!
    "An address, or vetra (a policy)"
    startedBy: String!
    startedAt: String!
    "What holders are told: the release's customer notes when it started"
    notes: String
    pausedAt: String
    pausedReason: String
    finishedAt: String
    rolledBackBy: String
    rolledBackAt: String
    plans: [AppRolloutPlan!]!
    steps: [AppRolloutStep!]!
  }

  type AppRolloutPlan {
    planId: ID!
    "The plan's target before the rollout"
    fromVersion: String
    noticeHours: Int!
  }

  type AppRolloutStep {
    id: ID!
    instanceId: ID!
    instanceName: String!
    "shared | own"
    instanceKind: String!
    planId: ID!
    position: Int!
    fromVersion: String
    toVersion: String!
    "pending | backing_up | applying | restoring | succeeded | failed | skipped | revert_pending | reverting | revert_failed | rolled_back"
    status: String!
    "Not before (the notice); the plan's window applies after it"
    dueAt: String!
    "Update now (holder) or retry (publisher)"
    requestedAt: String
    startedAt: String
    finishedAt: String
    attempts: Int!
    error: String
    "pinned at 1.4.2, stopped: updated when it wakes, …"
    note: String
    "The backup taken before this step moved its instance (releases phase 3 slice 4)"
    backupId: ID
    "The restore this step runs (rollback of a release that migrates, or a failed update of one)"
    restoreId: ID
  }

  "What startRollout would do"
  type AppRolloutCheck {
    version: String!
    ok: Boolean!
    problems: [String!]!
    steps: [AppRolloutStepPreview!]!
  }

  type AppRolloutStepPreview {
    instanceId: ID!
    instanceName: String!
    instanceKind: String!
    planId: ID!
    fromVersion: String
    "pending | skipped"
    status: String!
    note: String
    "Start plus the notice (the plan's window applies after it)"
    dueAt: String!
  }

  "A coming update a holder is told about (in-app)"
  type HolderUpdate {
    rolloutId: ID!
    version: String!
    "When it is expected; null: never as things stand (the plan's update window never opens)"
    dueAt: String
    notes: String
    paused: Boolean!
    canUpdateNow: Boolean!
  }

  input StartRolloutInput {
    appId: ID!
    "A release of the App"
    version: String!
    planIds: [ID!]!
    "Hours before instances are updated; default each plan's notice"
    noticeHours: Int
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
    "plan.created | plan.updated | plan.target_set | plan.retired | setting.set | setting.deleted | role.granted | role.removed | instance.status | release.recorded | build.recorded | gate.token_issued | gate.token_rotated | backup.requested | backup.failed | restore.started | restore.finished"
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

  "Where a publisher setting applies: every instance of the App, or only its branch, preview or plan instances (wins over ALL for the same name)."
  enum AppSettingScope {
    ALL
    BRANCH
    PREVIEW
    "PLAN: shared and own instances (customers). ALL secrets do not reach them."
    PLAN
  }

  "A publisher setting (spec 14.2). Secrets are write-only: value is null for them."
  type AppSetting {
    name: String!
    scope: AppSettingScope!
    secret: Boolean!
    value: String
    "Files only: where the file is mounted (needs powerhouse-chart secretFiles)"
    mountPath: String
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
    "What Vetra sets on shared instances only (licence gate); empty while the gate is off"
    vetraShared: [VetraInstanceSetting!]!
    "Names no setting may have"
    reservedNames: [String!]!
    "Prefixes no setting name may start with"
    reservedPrefixes: [String!]!
  }

  input SetAppSettingInput {
    appId: ID!
    "Capitals, digits and _ (e.g. SEKTAR_OAUTH_RELAY_BASE); derived for files"
    name: String
    value: String!
    "Secret: stored encrypted, never shown again (files always are)"
    secret: Boolean!
    "Default ALL"
    scope: AppSettingScope
    "A file: mounted at this absolute path from a tenant secret (at most 64 KiB, 10 per scope)"
    mountPath: String
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
    "Platform admins: the App's switch-overs, newest first"
    switchovers(appId: ID!): [Switchover!]!
    "Platform admins: why a licensed environment cannot be switched over (empty: it can)"
    switchoverChecks(environmentId: ID!): [String!]!
    "The App's audit log, newest first (default 50, at most 200 per page)"
    appAudit(appId: ID!, limit: Int, before: String): AppAuditPage!
    "The App's release managers"
    appRoles(appId: ID!): [AppRole!]!
    "What the caller may do with the App; FORBIDDEN when the caller may not view it"
    appAccess(appId: ID!): AppAccess!
    "Instances of the plans the caller holds licences of"
    myInstances: [HolderInstance!]!
    "The settings the caller set on their own instance (holder only)"
    myInstanceSettings(instanceId: ID!): HolderSettings!
    "The App's rollouts, newest first (default 20, at most 100)"
    appRollouts(appId: ID!, limit: Int): [PlanRollout!]!
    rollout(id: ID!): PlanRollout
    "What a rollout would move, and why it cannot start (noticeHours: as startRollout's)"
    checkRollout(appId: ID!, version: String!, planIds: [ID!]!, noticeHours: Int): AppRolloutCheck!
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
    "Set or replace a setting on the caller's own instance (holder only); it rolls on the next pass"
    setMyInstanceSetting(input: SetHolderSettingInput!): HolderSetting!
    "Delete a setting from the caller's own instance (holder only)"
    deleteMyInstanceSetting(instanceId: ID!, name: String!): Boolean!
    "Point the caller's own instance at a custom domain (holder only); applied once DNS points at Vetra, and then the generated host stops serving"
    setMyInstanceCustomDomain(instanceId: ID!, domain: String!): InstanceCustomDomain!
    "Drop the custom domain of the caller's own instance (holder only); it is served at its generated host again"
    removeMyInstanceCustomDomain(instanceId: ID!): Boolean!
    "Platform admins: slice 9 moves a licensed environment's domain to the holder's instance."
    moveCustomDomainToInstance(fromEnvironmentId: ID!, instanceId: ID!): InstanceCustomDomain!
    "Platform admins: turn a licensing term that has licensed environments into an own plan (the first step of a switch-over)"
    adoptLicensedKind(
      appId: ID!
      kind: String!
      slug: String!
      name: String!
      size: String!
      targetVersion: String!
    ): AppPlan!
    "Platform admins: no gated promotion or update of the App's licensed environments while it is frozen"
    freezeAppReleases(appId: ID!, reason: String!): Boolean!
    unfreezeAppReleases(appId: ID!): Boolean!
    "Platform admins: plan a switch-over of a licensed environment; the window starts 72 h or more from now"
    planSwitchover(environmentId: ID!, windowStart: String!, windowEnd: String!): Switchover!
    "Platform admins: copy the environment into a throwaway clone while it keeps running, to size the window"
    dryRunSwitchover(environmentId: ID!): Switchover!
    "Platform admins: a failed switch-over goes back to the step it failed in"
    resumeSwitchover(id: ID!): Switchover!
    "Platform admins: back to the old environment; from the start of the new instance this discards what was written on it (acceptDataLoss)"
    rollBackSwitchover(id: ID!, acceptDataLoss: Boolean): Switchover!
    "Platform admins: remove the clone of a failed dry run"
    cleanUpDryRun(id: ID!): Switchover!
    "The holder of that switch-over: the moved instance looks right"
    confirmSwitchover(id: ID!): Switchover!
    "Turn a licensing term into a plan (shared or own instances)"
    createPlan(input: CreatePlanInput!): AppPlan!
    updatePlan(input: UpdatePlanInput!): AppPlan!
    "Start a rollout of this plan to a release (the plan's notice; instances one at a time)"
    setPlanTarget(planId: ID!, version: String!): AppPlan!
    "Start a rollout of plans to a release (operators and release managers)"
    startRollout(input: StartRolloutInput!): PlanRollout!
    pauseRollout(rolloutId: ID!, reason: String): PlanRollout!
    "Refused while a step is failed (retry or skip it)"
    resumeRollout(rolloutId: ID!): PlanRollout!
    "Skip what waits; moved instances stay; plans keep the new target"
    cancelRollout(rolloutId: ID!): PlanRollout!
    retryRolloutStep(stepId: ID!): PlanRollout!
    skipRolloutStep(stepId: ID!): PlanRollout!
    "Plans back to their previous release; instances back one at a time (image only). A release that migrates restores each instance's backup from before its update: acceptDataLoss must be true, data written since is lost"
    rollBackRollout(rolloutId: ID!, acceptDataLoss: Boolean): PlanRollout!
    "Own instances: rollouts skip it; another release is applied at once"
    pinInstance(instanceId: ID!, version: String!): AppInstance!
    unpinInstance(instanceId: ID!): AppInstance!
    "No plan may target it any more (spec 14.3)"
    withdrawRelease(appId: ID!, version: String!, reason: String): AppRelease!
    "A holder's own instance: its waiting update starts now, outside the notice and window"
    updateInstanceNow(instanceId: ID!): HolderUpdate!
    retirePlan(planId: ID!): AppPlan!
    "Back up a shared or own instance now (database and /data)"
    backUpInstance(instanceId: ID!): InstanceBackup!
    "Restore one of the instance's backups into it; acceptDataLoss must be true (data written since is lost)"
    restoreInstanceBackup(instanceId: ID!, backupId: ID!, acceptDataLoss: Boolean!): InstanceRestore!
    "Owner and organisation admins: turn on the Team plan (organisation Apps), following a release branch (default: the production branch)"
    enableTeamPlan(appId: ID!, followBranch: String): AppPlan!
    "Owner and organisation admins: turn the Team plan off (its instance stops; data kept)"
    disableTeamPlan(appId: ID!): AppPlan!
    "Name a release manager (owner or org OWNER/ADMIN; role default release_manager)"
    setAppRole(appId: ID!, address: String!, role: String): AppRole!
    removeAppRole(appId: ID!, address: String!, role: String): Boolean!
    "A new licence gate token for a shared instance (at most once a minute, else RATE_LIMITED), delivered on the next pass; the old one works until 15 minutes after the instance runs the new one"
    rotateInstanceGateToken(instanceId: ID!): AppInstance!
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
