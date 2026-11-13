import type { V1Job } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import {
  ARCHIVE_SCRIPT,
  buildArchiveJob,
  buildDataRestoreJob,
  DATA_RESTORE_SCRIPT,
  parseArchiveSha256,
} from "../dumps/archive-job-spec.js";

const base = {
  tenantNs: "calm-bat-t1",
  pvcName: "powerhouse-calm-bat-t1-app-data",
  image: "cr.vetra.io/powerhouse-inc-powerhouse/pgdump-uploader:1.1.0",
  bucket: "powerhouse-env-dumps",
  s3Endpoint: "https://fsn1.your-objectstorage.com",
  s3AccessKey: "AK",
  s3SecretKey: "SK",
};

const env = (job: V1Job) =>
  Object.fromEntries(
    (job.spec!.template.spec!.containers[0].env ?? []).map((e) => [
      e.name,
      e.value,
    ]),
  );

/** The admission policy's rules (powerhouse-k8s-hosting, switchboard-tier-scoped-writes), relaxed by Task 16. */
function admitted(job: V1Job): boolean {
  const pod = job.spec!.template.spec!;
  const volumes = pod.volumes ?? [];
  return (
    [undefined, "", "default"].includes(pod.serviceAccountName) &&
    volumes.length <= 1 &&
    volumes.every(
      (v) => !!v.persistentVolumeClaim?.claimName.endsWith("-app-data"),
    ) &&
    !pod.hostPID &&
    !pod.hostNetwork &&
    !pod.hostIPC &&
    !pod.nodeName &&
    !(pod.tolerations ?? []).length &&
    !(pod.initContainers ?? []).length &&
    pod.containers.every(
      (c) =>
        c.image!.startsWith("cr.vetra.io/") &&
        (c.volumeMounts ?? []).every(
          (m) => m.mountPath === "/data" && !m.subPath,
        ) &&
        !c.securityContext?.privileged &&
        !c.securityContext?.allowPrivilegeEscalation &&
        !c.securityContext?.capabilities?.add,
    )
  );
}

describe("the /data archive Job", () => {
  it("mounts the app data PVC read-only as the app's user, next to the app pod, and streams to <tenant>/data/<id>.tar.zst", () => {
    const job = buildArchiveJob({
      ...base,
      archiveId: "abc123",
      colocate: true,
    });
    expect(job.metadata).toMatchObject({
      name: "dataarchive-abc123",
      namespace: "calm-bat-t1",
      labels: {
        "app.kubernetes.io/managed-by": "vetra-cloud-observability",
        "vetra.io/archive-id": "abc123",
      },
    });
    expect(job.spec).toMatchObject({
      backoffLimit: 0,
      activeDeadlineSeconds: 3600,
      ttlSecondsAfterFinished: 600,
    });
    const pod = job.spec!.template.spec!;
    expect(pod.securityContext).toMatchObject({
      runAsUser: 1000,
      runAsGroup: 1000,
      fsGroup: 1000,
      runAsNonRoot: true,
    });
    expect(pod.volumes).toEqual([
      {
        name: "app-data",
        persistentVolumeClaim: {
          claimName: "powerhouse-calm-bat-t1-app-data",
          readOnly: true,
        },
      },
    ]);
    expect(pod.containers[0].volumeMounts).toEqual([
      { name: "app-data", mountPath: "/data", readOnly: true },
    ]);
    expect(
      pod.affinity?.podAffinity
        ?.requiredDuringSchedulingIgnoredDuringExecution?.[0],
    ).toEqual({
      labelSelector: { matchLabels: { "app.kubernetes.io/component": "app" } },
      topologyKey: "kubernetes.io/hostname",
    });
    expect(env(job)).toMatchObject({
      S3_BUCKET: "powerhouse-env-dumps",
      S3_KEY: "calm-bat-t1/data/abc123.tar.zst",
    });
    expect(pod.containers[0].args).toEqual([ARCHIVE_SCRIPT]);
    expect(ARCHIVE_SCRIPT).toContain("--exclude=./lost+found");
    expect(ARCHIVE_SCRIPT).toContain("ARCHIVE_SHA256=");
    // BusyBox tar exits 1 on any error, which the script would take for "file changed".
    expect(ARCHIVE_SCRIPT).toContain('grep -q "GNU tar"');
    expect(DATA_RESTORE_SCRIPT).toContain('grep -q "GNU tar"');
    expect(admitted(job)).toBe(true);
    // Nothing to be next to when the app is stopped.
    expect(
      buildArchiveJob({ ...base, archiveId: "abc123", colocate: false }).spec!
        .template.spec!.affinity,
    ).toBeUndefined();
  });
});

describe("the /data restore Job", () => {
  it("checks the checksum before it empties /data, mounts it read-write, and is not a dump or archive Job", () => {
    const job = buildDataRestoreJob({
      ...base,
      restoreId: "r-1",
      archiveId: "abc123",
      sha256: "d".repeat(64),
    });
    expect(job.metadata!.name).toBe("datarestore-r-1");
    expect(job.metadata!.labels).toEqual({
      "app.kubernetes.io/managed-by": "vetra-cloud-observability",
      "vetra.io/kind": "data-restore",
      "vetra.io/restore-id": "r-1",
    });
    const pod = job.spec!.template.spec!;
    expect(pod.volumes![0].persistentVolumeClaim!.readOnly).toBe(false);
    expect(pod.containers[0].volumeMounts![0].readOnly).toBe(false);
    expect(pod.affinity).toBeUndefined();
    expect(env(job)).toMatchObject({
      S3_KEY: "calm-bat-t1/data/abc123.tar.zst",
      ARCHIVE_SHA256: "d".repeat(64),
    });
    expect(DATA_RESTORE_SCRIPT.indexOf("checksum mismatch")).toBeLessThan(
      DATA_RESTORE_SCRIPT.indexOf("rm -rf"),
    );
    expect(admitted(job)).toBe(true);
  });

  it("downloads the archive once and extracts the very file it verified", () => {
    expect(DATA_RESTORE_SCRIPT.match(/s5cmd/g)).toHaveLength(1);
    const lines = DATA_RESTORE_SCRIPT.split("\n");
    const at = (needle: string) => lines.findIndex((l) => l.includes(needle));
    expect(at("s5cmd")).toBeLessThan(at("sha256sum"));
    expect(at("checksum mismatch")).toBeLessThan(at("rm -rf"));
    expect(at("rm -rf")).toBeLessThan(at("tar --no-same-owner"));
    expect(lines[at("zstd -q -d")]).toContain('"$FILE"');
    expect(lines[at("sha256sum")]).toContain('"$FILE"');
  });

  it("reads the checksum from the archive Job's log", () => {
    expect(
      parseArchiveSha256(
        `tar: ./x: file changed as we read it\nARCHIVE_SHA256=${"a".repeat(64)}\n`,
      ),
    ).toBe("a".repeat(64));
    expect(parseArchiveSha256("ARCHIVE_SHA256=\n")).toBeNull();
  });
});
