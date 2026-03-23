export interface EnvironmentStatus {
  tenantId: string;
  argoSyncStatus: string;
  argoHealthStatus: string;
  argoLastSyncedAt: string | null;
  argoMessage: string | null;
  configDriftDetected: number; // 0/1 for boolean compat
  tlsCertValid: number | null;
  tlsCertExpiresAt: string | null;
  domainResolves: number | null;
  updatedAt: string;
}

export interface EnvironmentPods {
  id: string; // {tenantId}/{podName}
  tenantId: string;
  name: string;
  service: string; // CONNECT, SWITCHBOARD, OTHER
  phase: string;
  ready: number; // 0/1
  restartCount: number;
  updatedAt: string;
}

export interface EnvironmentEvents {
  id: string; // K8s event .metadata.uid
  tenantId: string;
  type: string; // Normal, Warning
  reason: string;
  message: string;
  involvedObject: string;
  timestamp: string;
}

export interface ObservabilityDB {
  environment_status: EnvironmentStatus;
  environment_pods: EnvironmentPods;
  environment_events: EnvironmentEvents;
}
