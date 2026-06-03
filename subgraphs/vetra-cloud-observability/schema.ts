import { gql } from "graphql-tag";
import type { DocumentNode } from "graphql";

export const schema: DocumentNode = gql`
  type Query {
    environmentStatus(tenantId: String!): EnvironmentStatus
    environmentPods(tenantId: String!): [Pod!]!
    environmentEvents(tenantId: String!, limit: Int): [KubeEvent!]!
    cpuUsage(tenantId: String!, range: MetricRange): [MetricSeries!]!
    memoryUsage(tenantId: String!, range: MetricRange): [MetricSeries!]!
    podRestartRate(tenantId: String!, range: MetricRange): [MetricSeries!]!
    httpRequestRate(tenantId: String!, range: MetricRange): [MetricSeries!]!
    httpLatency(tenantId: String!, range: MetricRange): [MetricSeries!]!
    """
    Tail recent logs for an environment. Either filter by a managed
    \`service\` (CONNECT/SWITCHBOARD) or by an \`agent\` prefix; the two are
    mutually exclusive — passing both raises a validation error. Without
    either, returns env-wide logs.

    For \`agent\`, the resolver looks up pods labelled
    \`clint.vetra.io/agent=<prefix>\` from the \`environment_pods\` cache and
    builds a Loki \`pod=~\` matcher from their names. Returns an empty list
    if no matching pods are known yet.
    """
    logs(
      tenantId: String!
      service: TenantService
      agent: String
      since: MetricRange
      limit: Int
    ): [LogEntry!]!
    errorLogs(tenantId: String!, since: MetricRange, limit: Int): [LogEntry!]!

    """
    Returns environments scoped to the calling user.
    - Without a verified Renown bearer token: returns an empty list.
    - With scope=MINE (default): returns environments where owner matches the caller.
    - With scope=ALL: requires admin status; returns all environments.
    """
    myEnvironments(scope: ListScope = MINE): [VetraCloudEnvironmentSummary!]!

    """
    Returns identity info for the caller — used by the UI to decide whether to
    show the admin-only "All" toggle.
    """
    viewer: Viewer!

    """
    Latest known release tag for an (channel, image) pair. Returns null
    if nothing has been recorded yet for that combination (no releases
    since the subgraph started listening).
    """
    latestRelease(channel: AutoUpdateChannel!, image: TenantService!): ReleaseIndexEntry

    """
    Append-only release history for one environment: every
    SET_SERVICE_VERSION dispatched by the subgraph itself (automatic,
    manual, or rollback). Newest first, capped by limit (default 20).
    """
    environmentReleaseHistory(documentId: String!, limit: Int): [ReleaseHistoryEntry!]!

    """
    Endpoints currently announced by clint agents in this environment.
    Sourced from the most recent announcement per (documentId, prefix).
    Returns an empty list if no agent has announced yet (e.g. CLINT
    services still PROVISIONING, or the package's manifest has
    serviceAnnouncement: false).
    """
    clintRuntimeEndpointsByEnv(
      documentId: String!
    ): [ClintRuntimeEndpointsForPrefix!]!

    """
    On-demand pg_dump exports of the env's Postgres, newest first
    (capped at 20). Owner-only. Each entry has a 24h-TTL file on S3;
    \`downloadUrl\` is a 15-min presigned URL minted on every read,
    only present when status=READY and the file hasn't expired.
    """
    environmentDumps(tenantId: String!): [DatabaseDump!]!
  }

  """Grouping of runtime-announced endpoints under a single agent (= service prefix)."""
  type ClintRuntimeEndpointsForPrefix {
    prefix: String!
    endpoints: [ClintRuntimeEndpoint!]!
  }

  enum AutoUpdateChannel { DEV, STAGING, LATEST }
  enum ReleaseTrigger { AUTO, MANUAL, ROLLBACK }

  type ReleaseIndexEntry {
    channel: AutoUpdateChannel!
    image: TenantService!
    tag: String!
    publishedAt: String!
    releaseUrl: String
  }

  type ReleaseHistoryEntry {
    documentId: String!
    tenantId: String
    service: TenantService!
    fromTag: String
    toTag: String!
    trigger: ReleaseTrigger!
    channel: AutoUpdateChannel
    at: String!
    releaseUrl: String
  }

  type Mutation {
    """
    Set (or clear) the custom domain on an environment. Enforces global
    uniqueness across live environments and optionally pins one service to
    the apex of the custom domain (Connect served at admin.vetra.io rather
    than connect.admin.vetra.io).

    Caller must be the environment's owner or an admin. Uniqueness is
    checked against environments whose status is not in
    {TERMINATING, DESTROYED, ARCHIVED}. Raises DOMAIN_TAKEN if another
    live environment already claims the same host.
    """
    setCustomDomain(
      documentId: String!
      enabled: Boolean!
      domain: String
      apexService: TenantService
    ): VetraCloudEnvironmentSummary!

    """
    Receiver for the powerhouse monorepo's docker-publish workflow.
    When a new connect/switchboard image is published on a release channel
    (dev, staging, latest), the workflow calls this mutation with the tag
    and channel; the subgraph maps channel → custom domain and, for each
    matching live environment, dispatches SET_SERVICE_VERSION on every
    enabled service named in images, then APPROVE_CHANGES so the
    processor syncs the new tag to gitops.

    Channel→domain mapping is driven by the CLOUD_AUTO_UPDATE_CHANNELS
    env var on switchboard (comma-separated channel:domain pairs).
    Default: dev:admin-dev.vetra.io,staging:admin.vetra.io

    The provided secret is compared against CLOUD_AUTO_UPDATE_SECRET;
    mismatch returns UNAUTHORIZED.
    """
    notifyNewImageRelease(input: NotifyNewImageReleaseInput!): NotifyNewImageReleaseResult!

    """
    Immediately bump one environment's enabled services to the latest
    known tag on its subscribed channel. Owner-only. Raises
    NO_CHANNEL if the env has no autoUpdateChannel set, and
    NO_RELEASE_KNOWN if the subgraph has never seen a release on that
    channel for any of the enabled services. Returns the same shape as
    notifyNewImageRelease for a single env.
    """
    updateEnvironmentToLatest(documentId: String!): NotifyNewImageReleaseResult!

    """
    Revert an environment's enabled services to the previous tag
    recorded in release_history. Owner-only. Raises NO_PRIOR_RELEASE if
    there's no history to roll back to for any enabled service.
    """
    rollbackEnvironmentRelease(documentId: String!): NotifyNewImageReleaseResult!

    """
    Owner-gated. Creates a new on-demand pg_dump export. Returns the
    new dump in PENDING. Caller polls environmentDumps to observe
    state transitions. Raises DUMP_IN_PROGRESS if a previous dump is
    still PENDING or RUNNING.
    """
    requestEnvironmentDump(tenantId: String!): DatabaseDump!

    """
    Owner-gated. Cancels an in-flight (PENDING or RUNNING) dump:
    deletes its k8s Job (best-effort) and marks the row FAILED with
    'Cancelled by user'. No-op for terminal rows (READY/FAILED) —
    returns them unchanged. Raises ENV_NOT_FOUND if the dump's tenant
    has no env, FORBIDDEN for non-owners, DUMP_NOT_FOUND if the id
    doesn't exist.
    """
    cancelEnvironmentDump(dumpId: ID!): DatabaseDump!

    """
    Owner-gated. Trigger a rolling restart of one of an environment's
    Deployments by stamping the standard rollout-restart annotation on its
    pod template. 'service' selects CONNECT/SWITCHBOARD; for CLINT pass the
    agent's 'agentPrefix' to disambiguate (each agent is its own
    Deployment). The target Deployment is located by its chart labels, so
    this is robust to k8s name truncation.

    Raises UNAUTHENTICATED, FORBIDDEN, ENV_NOT_FOUND, AMBIGUOUS_SERVICE
    (CLINT without a prefix, or >1 matching Deployment), DEPLOYMENT_NOT_FOUND,
    and RESTART_NOT_CONFIGURED (cluster client unavailable).
    """
    restartEnvironmentService(
      tenantId: String!
      service: TenantService!
      agentPrefix: String
    ): RestartEnvironmentServiceResult!
  }

  type RestartEnvironmentServiceResult {
    ok: Boolean!
    """Name of the Deployment that was restarted."""
    deploymentName: String!
    message: String
  }

  enum DatabaseDumpStatus { PENDING, RUNNING, READY, FAILED }

  type DatabaseDump {
    id: ID!
    status: DatabaseDumpStatus!
    requestedAt: String!
    startedAt: String
    completedAt: String
    expiresAt: String!
    """Final size in bytes, populated when status=READY."""
    sizeBytes: Float
    """Last log line from the failed pod, populated when status=FAILED."""
    errorMessage: String
    """Presigned 15-min download URL. Null unless status=READY and not expired."""
    downloadUrl: String
  }

  type ClintRuntimeEndpoint {
    id: String!
    type: String!
    port: String!
    status: String!
    """ISO timestamp of the most recent announcement that included this endpoint."""
    lastSeen: String!
  }

  input NotifyNewImageReleaseInput {
    tag: String!
    channel: String!
    images: [String!]!
    secret: String!
  }

  type NotifyNewImageReleaseResult {
    """Lowercased document IDs whose service versions were just bumped."""
    updatedEnvironments: [String!]!
  }

  enum ListScope { MINE, ALL }

  type Viewer {
    """The caller's wallet address (lowercased), if authenticated; otherwise null."""
    address: String
    """Whether the caller is configured as an admin on switchboard."""
    isAdmin: Boolean!
  }

  type VetraCloudEnvironmentSummary {
    id: String!
    name: String
    subdomain: String
    tenantId: String
    customDomain: String
    status: String
    """Lowercased EthereumAddress of the current owner (from document state)."""
    owner: String
    """Lowercased EthereumAddress of the user who first signed an action on this document (legacy; prefer the owner field)."""
    createdBy: String
  }

  type EnvironmentStatus {
    tenantId: String!
    argoSyncStatus: ArgoSyncStatus!
    argoHealthStatus: ArgoHealthStatus!
    argoLastSyncedAt: String
    argoMessage: String
    configDriftDetected: Boolean!
    tlsCertValid: Boolean
    tlsCertExpiresAt: String
    domainResolves: Boolean
    updatedAt: String!
  }

  type Pod {
    name: String!
    service: TenantService
    """
    Value of the chart's app.kubernetes.io/component label. Examples:
    "connect", "switchboard", "clint", "fusion", "registry". Null for
    pods that don't carry the label.
    """
    component: String
    """
    Value of the clint.vetra.io/agent label set by the chart on every
    clint pod. Matches CloudEnvironmentService.prefix on the doc-model
    side. Null for non-clint pods.
    """
    agent: String
    phase: PodPhase!
    ready: Boolean!
    restartCount: Int!
    updatedAt: String!
  }

  type KubeEvent {
    type: EventType!
    reason: String!
    message: String!
    involvedObject: String!
    timestamp: String!
  }

  type MetricSeries {
    label: String!
    datapoints: [Datapoint!]!
  }

  type Datapoint {
    timestamp: Float!
    value: Float!
  }

  type LogEntry {
    timestamp: Float!
    line: String!
  }

  enum ArgoSyncStatus { SYNCED, OUT_OF_SYNC, UNKNOWN }
  enum ArgoHealthStatus { HEALTHY, DEGRADED, PROGRESSING, MISSING, UNKNOWN }
  enum PodPhase { RUNNING, PENDING, SUCCEEDED, FAILED, UNKNOWN }
  enum EventType { NORMAL, WARNING }
  enum TenantService { CONNECT, SWITCHBOARD, CLINT }
  enum MetricRange { ONE_MIN, FIVE_MIN, FIFTEEN_MIN, ONE_HOUR, SIX_HOURS, TWENTY_FOUR_HOURS }
`;
