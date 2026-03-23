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
