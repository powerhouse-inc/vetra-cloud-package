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
    logs(tenantId: String!, service: TenantService, since: MetricRange, limit: Int): [LogEntry!]!
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
  enum TenantService { CONNECT, SWITCHBOARD }
  enum MetricRange { ONE_MIN, FIVE_MIN, FIFTEEN_MIN, ONE_HOUR, SIX_HOURS, TWENTY_FOUR_HOURS }
`;
