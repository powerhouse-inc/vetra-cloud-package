import { describe, expect, it } from "vitest";
import { buildDumpJob, buildRestoreJob, RESTORE_SCRIPT } from "../dumps/job-spec.js";

describe("buildDumpJob", () => {
  it("builds a Job manifest with the expected metadata, env vars, and resources", () => {
    const job = buildDumpJob({
      dumpId: "abc12345",
      tenantNs: "brave-lion-22-9c4d",
      image: "cr.vetra.io/powerhouse-inc/pgdump-uploader:1.0.0",
      bucket: "powerhouse-env-dumps",
      s3Endpoint: "https://fsn1.your-objectstorage.com",
      s3AccessKey: "TESTACCESS",
      s3SecretKey: "TESTSECRET",
    });

    expect(job.metadata?.name).toBe("pgdump-abc12345");
    expect(job.metadata?.namespace).toBe("brave-lion-22-9c4d");
    expect(job.metadata?.labels?.["app.kubernetes.io/managed-by"]).toBe(
      "vetra-cloud-observability",
    );
    expect(job.metadata?.labels?.["vetra.io/dump-id"]).toBe("abc12345");

    expect(job.spec?.backoffLimit).toBe(0);
    expect(job.spec?.ttlSecondsAfterFinished).toBe(600);
    expect(job.spec?.activeDeadlineSeconds).toBe(3600);
    expect(job.spec?.template.spec?.restartPolicy).toBe("Never");

    const envVars = job.spec?.template.spec?.containers?.[0]?.env ?? [];
    const envMap = Object.fromEntries(
      envVars.map((e: { name?: string }) => [e.name, e]),
    );

    expect(envMap.PGHOST.value).toBe(
      "brave-lion-22-9c4d-pg-pooler.brave-lion-22-9c4d.svc.cluster.local",
    );
    expect(envMap.PGPORT.value).toBe("5432");
    expect(envMap.S3_BUCKET.value).toBe("powerhouse-env-dumps");
    expect(envMap.S3_KEY.value).toBe("brave-lion-22-9c4d/abc12345.dump");
    expect(envMap.S3_ENDPOINT.value).toBe(
      "https://fsn1.your-objectstorage.com",
    );

    // DB credentials come from the chart-rendered <ns>-pg-app secret.
    expect(envMap.PGPASSWORD.valueFrom.secretKeyRef.name).toBe(
      "brave-lion-22-9c4d-pg-app",
    );
    expect(envMap.PGPASSWORD.valueFrom.secretKeyRef.key).toBe("password");

    // S3 credentials are inlined from the subgraph host's env (see
    // BuildDumpJobInput jsdoc on threat model). No per-namespace
    // Secret is required, so dump Jobs work in any tenant ns without
    // a chart change.
    expect(envMap.AWS_ACCESS_KEY_ID.value).toBe("TESTACCESS");
    expect(envMap.AWS_SECRET_ACCESS_KEY.value).toBe("TESTSECRET");
    expect(envMap.AWS_ACCESS_KEY_ID.valueFrom).toBeUndefined();
    expect(envMap.AWS_SECRET_ACCESS_KEY.valueFrom).toBeUndefined();

    const resources = job.spec?.template.spec?.containers?.[0]?.resources;
    expect(resources?.requests?.cpu).toBe("200m");
    expect(resources?.limits?.memory).toBe("1Gi");

    // Tenant namespaces ship a `harbor-credentials` Secret via the
    // chart so the cr.vetra.io image can be pulled. Without this the
    // pod hits ImagePullBackOff.
    expect(job.spec?.template.spec?.imagePullSecrets).toEqual([
      { name: "harbor-credentials" },
    ]);
  });
});

describe("buildRestoreJob", () => {
  const job = buildRestoreJob({
    restoreId: "r123",
    dumpId: "abc12345",
    tenantNs: "brave-lion-22-9c4d",
    image: "img:1",
    bucket: "powerhouse-env-dumps",
    s3Endpoint: "https://fsn1.your-objectstorage.com",
    s3AccessKey: "A",
    s3SecretKey: "S",
  });
  const container = job.spec!.template.spec!.containers[0];
  const env = Object.fromEntries((container.env ?? []).map((e) => [e.name, e]));

  it("connects to the CNPG primary, not the pooler", () => {
    expect(env.PGHOST.value).toBe("brave-lion-22-9c4d-pg-rw.brave-lion-22-9c4d.svc.cluster.local");
    expect(env.PGPASSWORD.valueFrom?.secretKeyRef?.name).toBe("brave-lion-22-9c4d-pg-app");
  });

  it("reads the chosen dump's file", () => {
    expect(env.S3_KEY.value).toBe("brave-lion-22-9c4d/abc12345.dump");
  });

  it("is labelled as a restore and invisible to the dump watcher", () => {
    expect(job.metadata?.name).toBe("pgrestore-r123");
    expect(job.metadata?.labels).toEqual({
      "app.kubernetes.io/managed-by": "vetra-cloud-observability",
      "vetra.io/kind": "restore",
      "vetra.io/restore-id": "r123",
    });
    expect(job.spec?.template.metadata?.labels?.["vetra.io/dump-id"]).toBeUndefined();
    expect(job.spec?.backoffLimit).toBe(0);
  });

  it("restores all-or-nothing after dropping what the app role owns", () => {
    expect(container.command).toEqual(["/bin/sh", "-c"]);
    expect(RESTORE_SCRIPT).toContain("set -eu -o pipefail");
    expect(RESTORE_SCRIPT).toContain("DROP OWNED BY CURRENT_USER CASCADE;");
    expect(RESTORE_SCRIPT).toContain("--single-transaction");
    expect(RESTORE_SCRIPT).toContain("ON_ERROR_STOP=1");
    expect(RESTORE_SCRIPT).toContain("--no-owner --no-acl -L /tmp/restore.list");
    expect(container.args).toEqual([RESTORE_SCRIPT]);
  });
});
