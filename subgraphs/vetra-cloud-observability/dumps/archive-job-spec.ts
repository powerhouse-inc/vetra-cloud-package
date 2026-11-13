import type { V1EnvVar, V1Job } from "@kubernetes/client-node";
import { archiveKey } from "./archive-repo.js";

const MANAGED_BY = "vetra-cloud-observability";
/** The host image's user and the chart's app fsGroup: /data's files are its own. */
export const APP_UID = 1000;
/** The chart's label on the host-image Deployment, its pods and its data PVC. */
export const APP_LABELS = { "app.kubernetes.io/component": "app" } as const;

export type DataJobInput = {
  tenantNs: string;
  pvcName: string;
  /** pgdump-uploader >= 1.1.0 (GNU tar, zstd, s5cmd). */
  image: string;
  bucket: string;
  s3Endpoint: string;
  /** Inline, as for the dump Job (see buildDumpJob's note on the threat model). */
  s3AccessKey: string;
  s3SecretKey: string;
  /** The object's key, when not `<tenantNs>/data/<archiveId>.tar.zst` (switch-overs: `switchover/…`). */
  s3Key?: string;
};
export type BuildArchiveJobInput = DataJobInput & {
  archiveId: string;
  /** The app pod runs: the RWO volume is attached to its node, so the Job must run there. */
  colocate: boolean;
};
export type BuildDataRestoreJobInput = DataJobInput & {
  restoreId: string;
  archiveId: string;
  /** data_archives.sha256: checked before /data is touched. */
  sha256: string;
};

/** Restore Jobs: kept a day after they end (a missing Job is an unknown outcome). */
export const RESTORE_JOB_TTL_S = 24 * 3600;

/** Both scripts depend on GNU tar's exit codes and options. */
const REQUIRE_GNU_TAR =
  'tar --version 2>/dev/null | grep -q "GNU tar" || { echo "GNU tar is required"; exit 1; }';

/**
 * Streams /data to S3 as tar+zstd and prints the stored object's sha256.
 * GNU tar exits 1 when a file changed while it was read (the app keeps
 * running, decision B3); that is accepted, anything else fails the Job.
 * BusyBox tar also exits 1, on any error, so the script refuses to run
 * without GNU tar (pgdump-uploader >= 1.1.0).
 */
export const ARCHIVE_SCRIPT = [
  "set -eu -o pipefail",
  REQUIRE_GNU_TAR,
  "mkfifo /tmp/sum.fifo",
  "sha256sum < /tmp/sum.fifo > /tmp/sum &",
  "SUM_PID=$!",
  "{ tar --exclude=./lost+found -C /data -cf - . || [ $? -eq 1 ]; }" +
    " | zstd -q -3 -T0" +
    " | tee /tmp/sum.fifo" +
    ' | s5cmd --endpoint-url "$S3_ENDPOINT" pipe "s3://$S3_BUCKET/$S3_KEY"',
  'wait "$SUM_PID"',
  'echo "ARCHIVE_SHA256=$(cut -d" " -f1 /tmp/sum)"',
].join("\n");

/**
 * Replaces /data with an archive. The archive is downloaded once and its checksum
 * checked before anything is deleted; a mismatch leaves /data as it was.
 * The app is stopped while this runs (backups/restore.ts).
 */
export const DATA_RESTORE_SCRIPT = [
  "set -eu -o pipefail",
  REQUIRE_GNU_TAR,
  'FILE=/tmp/archive.tar.zst',
  'trap \'rm -f "$FILE"\' EXIT',
  // One download: the bytes checked are the bytes extracted.
  's5cmd --endpoint-url "$S3_ENDPOINT" cat "s3://$S3_BUCKET/$S3_KEY" > "$FILE"',
  'GOT=$(sha256sum "$FILE" | cut -d" " -f1)',
  'if [ "$GOT" != "$ARCHIVE_SHA256" ]; then echo "archive checksum mismatch: $GOT"; exit 1; fi',
  "find /data -mindepth 1 -maxdepth 1 ! -name lost+found -exec rm -rf {} +",
  'zstd -q -d < "$FILE" | tar --no-same-owner -x -C /data -f -',
  'echo "data restore complete"',
].join("\n");

export function parseArchiveSha256(logs: string): string | null {
  return /^ARCHIVE_SHA256=([0-9a-f]{64})\s*$/m.exec(logs)?.[1] ?? null;
}

function s3Env(i: DataJobInput, key: string): V1EnvVar[] {
  return [
    { name: "S3_BUCKET", value: i.bucket },
    { name: "S3_KEY", value: key },
    { name: "S3_ENDPOINT", value: i.s3Endpoint },
    { name: "AWS_ACCESS_KEY_ID", value: i.s3AccessKey },
    { name: "AWS_SECRET_ACCESS_KEY", value: i.s3SecretKey },
  ];
}

/** One Job shape for both directions; it stays inside the admission policy (Task 16). */
function dataJob(o: {
  name: string;
  input: DataJobInput;
  labels: Record<string, string>;
  script: string;
  env: V1EnvVar[];
  readOnly: boolean;
  colocate: boolean;
  ttlSecondsAfterFinished?: number;
}): V1Job {
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name: o.name, namespace: o.input.tenantNs, labels: o.labels },
    spec: {
      ttlSecondsAfterFinished: o.ttlSecondsAfterFinished ?? 600,
      backoffLimit: 0,
      activeDeadlineSeconds: 3600,
      template: {
        metadata: { labels: o.labels },
        spec: {
          restartPolicy: "Never",
          serviceAccountName: "default",
          imagePullSecrets: [{ name: "harbor-credentials" }],
          securityContext: {
            runAsNonRoot: true,
            runAsUser: APP_UID,
            runAsGroup: APP_UID,
            fsGroup: APP_UID,
            // A large /data is not re-chowned on every mount.
            fsGroupChangePolicy: "OnRootMismatch",
          },
          ...(o.colocate
            ? {
                affinity: {
                  podAffinity: {
                    requiredDuringSchedulingIgnoredDuringExecution: [
                      {
                        labelSelector: { matchLabels: { ...APP_LABELS } },
                        topologyKey: "kubernetes.io/hostname",
                      },
                    ],
                  },
                },
              }
            : {}),
          volumes: [
            {
              name: "app-data",
              persistentVolumeClaim: {
                claimName: o.input.pvcName,
                readOnly: o.readOnly,
              },
            },
          ],
          containers: [
            {
              name: "data",
              image: o.input.image,
              command: ["/bin/sh", "-c"],
              args: [o.script],
              env: o.env,
              volumeMounts: [
                { name: "app-data", mountPath: "/data", readOnly: o.readOnly },
              ],
              securityContext: { allowPrivilegeEscalation: false },
              resources: {
                requests: { cpu: "200m", memory: "256Mi" },
                limits: { cpu: "1", memory: "1Gi" },
              },
            },
          ],
        },
      },
    },
  };
}

export function buildArchiveJob(input: BuildArchiveJobInput): V1Job {
  return dataJob({
    name: `dataarchive-${input.archiveId}`,
    input,
    labels: {
      "app.kubernetes.io/managed-by": MANAGED_BY,
      "vetra.io/archive-id": input.archiveId,
    },
    script: ARCHIVE_SCRIPT,
    env: s3Env(input, input.s3Key ?? archiveKey(input.tenantNs, input.archiveId)),
    readOnly: true,
    colocate: input.colocate,
  });
}

/**
 * Labelled vetra.io/kind=data-restore and never with a dump or archive id,
 * so the Job watcher ignores it; vetra-apps polls it by name.
 */
export function buildDataRestoreJob(input: BuildDataRestoreJobInput): V1Job {
  return dataJob({
    name: `datarestore-${input.restoreId}`,
    input,
    labels: {
      "app.kubernetes.io/managed-by": MANAGED_BY,
      "vetra.io/kind": "data-restore",
      "vetra.io/restore-id": input.restoreId,
    },
    script: DATA_RESTORE_SCRIPT,
    env: [
      ...s3Env(input, input.s3Key ?? archiveKey(input.tenantNs, input.archiveId)),
      { name: "ARCHIVE_SHA256", value: input.sha256 },
    ],
    readOnly: false,
    colocate: false,
    // vetra-apps reads the outcome of a restore Job by name: it must outlive a missed pass (it deletes the Job itself).
    ttlSecondsAfterFinished: RESTORE_JOB_TTL_S,
  });
}
