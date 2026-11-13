import type { Readable } from "node:stream";
import { S3Helper } from "../../vetra-cloud-observability/dumps/s3.js";
import {
  createDefaultDumpsK8sClient,
  createDefaultRestoreK8s,
} from "../../vetra-cloud-observability/dumps/k8s-client.js";
import type { RestoreK8s } from "../../vetra-cloud-observability/dumps/restore.js";

/** The chart's host-image Deployment, its pods and its data PVC. */
export const APP_SELECTOR = "app.kubernetes.io/component=app";

const DEFAULT_DUMP_IMAGE =
  "cr.vetra.io/powerhouse-inc-powerhouse/pgdump-uploader:1.0.0";
/** 1.0.0 plus GNU tar and zstd (powerhouse-k8s-hosting infrastructure/pgdump-uploader). */
const DEFAULT_ARCHIVE_IMAGE =
  "cr.vetra.io/powerhouse-inc-powerhouse/pgdump-uploader:1.1.0";

/** What instance backups and restores need from the cluster (RBAC: jobs, deployments, pods, PVCs). */
export interface BackupK8s extends RestoreK8s {
  deleteJob(namespace: string, name: string): Promise<void>;
  /** The tenant's app data PVC (`<fullname>-app-data`, labelled component=app), or null. */
  findDataPvc(namespace: string): Promise<string | null>;
  /** The container images of the Deployments matching the selector. */
  deploymentImages(namespace: string, labelSelector: string): Promise<string[]>;
  /**
   * The tenant's data PVC is Bound (switch-over: a new instance's storage
   * exists before anything is restored into it). Absent: not asked.
   */
  dataPvcBound?(namespace: string): Promise<boolean>;
  /** The tenant's CNPG primary pod is Ready (switch-over: the new instance's database exists before the copy). Absent: not asked. */
  databaseReady?(namespace: string): Promise<boolean>;
}

export interface DumpJobConfig {
  image: string;
  bucket: string;
  s3Endpoint: string;
  s3AccessKey: string;
  s3SecretKey: string;
}

export interface InstanceBackupDeps {
  k8s: BackupK8s;
  /** VETRA_DUMPS_*: the dump Jobs' image, bucket and credentials (the archive Jobs share bucket and credentials). */
  dumpJob: DumpJobConfig;
  /** VETRA_DATA_ARCHIVE_IMAGE: the /data Jobs' image. */
  archiveImage: string;
  deleteObject(key: string): Promise<void>;
  /** An object's bytes as a stream (the switch-over reads two key files out of its /data archive). Absent: not configured. */
  readObject?(key: string): Promise<Readable>;
}

/** In-cluster: observability's dump and restore clients plus PVC and Deployment reads. */
export async function createDefaultBackupK8s(): Promise<BackupK8s> {
  const dumps = await createDefaultDumpsK8sClient();
  const restore = await createDefaultRestoreK8s(dumps);
  const { KubeConfig, AppsV1Api, CoreV1Api } =
    await import("@kubernetes/client-node");
  const kc = new KubeConfig();
  kc.loadFromCluster();
  const apps = kc.makeApiClient(AppsV1Api);
  const core = kc.makeApiClient(CoreV1Api);
  return {
    ...restore,
    deleteJob: (ns, name) => dumps.deleteJob(ns, name),
    async findDataPvc(namespace) {
      const res = await core.listNamespacedPersistentVolumeClaim({
        namespace,
        labelSelector: APP_SELECTOR,
      });
      return (
        res.items
          .map((p) => p.metadata?.name ?? "")
          .find((n) => n.endsWith("-app-data")) ?? null
      );
    },
    async dataPvcBound(namespace) {
      const res = await core.listNamespacedPersistentVolumeClaim({
        namespace,
        labelSelector: APP_SELECTOR,
      });
      return res.items.some(
        (p) =>
          (p.metadata?.name ?? "").endsWith("-app-data") &&
          p.status?.phase === "Bound",
      );
    },
    async databaseReady(namespace) {
      const res = await core.listNamespacedPod({
        namespace,
        labelSelector: `cnpg.io/cluster=${namespace}-pg,cnpg.io/instanceRole=primary`,
      });
      return res.items.some(
        (p) =>
          p.status?.phase === "Running" &&
          (p.status.conditions ?? []).some(
            (c) => c.type === "Ready" && c.status === "True",
          ),
      );
    },
    async deploymentImages(namespace, labelSelector) {
      const res = await apps.listNamespacedDeployment({
        namespace,
        labelSelector,
      });
      return res.items.flatMap((d) =>
        (d.spec?.template.spec?.containers ?? []).map((c) => c.image ?? ""),
      );
    },
  };
}

/**
 * The same settings observability's dumps read (one process, one
 * environment). Null without the S3 credentials: backups are then not
 * configured, and VETRA_APPS_BACKUPS=on fails steps closed.
 */
export async function instanceBackupDepsFromEnv(
  env: Record<string, string | undefined> = process.env,
  makeK8s: () => Promise<BackupK8s> = createDefaultBackupK8s,
): Promise<InstanceBackupDeps | null> {
  const accessKey = env.VETRA_DUMPS_S3_ACCESS_KEY;
  const secretKey = env.VETRA_DUMPS_S3_SECRET_KEY;
  if (!accessKey || !secretKey) return null;
  const endpoint =
    env.VETRA_DUMPS_S3_ENDPOINT ?? "https://fsn1.your-objectstorage.com";
  const bucket = env.VETRA_DUMPS_BUCKET ?? "powerhouse-env-dumps";
  const s3 = new S3Helper({
    endpoint,
    region: env.VETRA_DUMPS_S3_REGION ?? "fsn1",
    accessKeyId: accessKey,
    secretAccessKey: secretKey,
    bucket,
  });
  return {
    k8s: await makeK8s(),
    dumpJob: {
      image: env.VETRA_DUMPS_IMAGE ?? DEFAULT_DUMP_IMAGE,
      bucket,
      s3Endpoint: endpoint,
      s3AccessKey: accessKey,
      s3SecretKey: secretKey,
    },
    archiveImage: env.VETRA_DATA_ARCHIVE_IMAGE ?? DEFAULT_ARCHIVE_IMAGE,
    deleteObject: (key) => s3.deleteObject(key),
    readObject: (key) => s3.getObjectStream(key),
  };
}
