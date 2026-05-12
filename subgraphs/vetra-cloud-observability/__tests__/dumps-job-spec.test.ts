import { describe, expect, it } from "vitest";
import { buildDumpJob, buildRestoreJob } from "../dumps/job-spec.js";

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

    // The dump container relies on the image's default ENTRYPOINT —
    // unlike the restore container, which overrides `command`. Locking
    // this in so a future edit can't accidentally inject a command
    // that breaks pgdump-uploader.
    expect(job.spec?.template.spec?.containers[0].command).toBeUndefined();
  });
});

describe("buildRestoreJob", () => {
  it("builds a Job manifest reusing the dump image with pg_restore command and discriminator labels", () => {
    const job = buildRestoreJob({
      dumpId: "abc12345",
      tenantNs: "brave-lion-22-9c4d",
      image: "cr.vetra.io/powerhouse-inc/pgdump-uploader:1.0.0",
      bucket: "powerhouse-env-dumps",
      s3Endpoint: "https://fsn1.your-objectstorage.com",
      s3AccessKey: "TESTACCESS",
      s3SecretKey: "TESTSECRET",
    });

    expect(job.metadata?.name).toBe("pgrestore-abc12345");
    expect(job.metadata?.namespace).toBe("brave-lion-22-9c4d");

    // Labels: existing managed-by selector still finds the Job, plus
    // the kind discriminator and the new restore-id label.
    expect(job.metadata?.labels?.["app.kubernetes.io/managed-by"]).toBe(
      "vetra-cloud-observability",
    );
    expect(job.metadata?.labels?.["vetra.io/kind"]).toBe("restore");
    expect(job.metadata?.labels?.["vetra.io/restore-id"]).toBe("abc12345");
    // Restore Jobs do NOT carry the dump-id label — that would confuse
    // the dump watcher into reconciling them as dump rows.
    expect(job.metadata?.labels?.["vetra.io/dump-id"]).toBeUndefined();

    // Same ttl/backoff/deadline knobs as the dump Job.
    expect(job.spec?.backoffLimit).toBe(0);
    expect(job.spec?.ttlSecondsAfterFinished).toBe(600);
    expect(job.spec?.activeDeadlineSeconds).toBe(3600);
    expect(job.spec?.template.spec?.restartPolicy).toBe("Never");

    // Same image, but the container command runs pg_restore via s5cmd.
    const container = job.spec?.template.spec?.containers?.[0];
    expect(container?.image).toBe(
      "cr.vetra.io/powerhouse-inc/pgdump-uploader:1.0.0",
    );
    expect(container?.command).toEqual(["/bin/sh", "-c"]);
    expect(container?.args).toHaveLength(1);
    expect(container?.args?.[0]).toContain("s5cmd");
    expect(container?.args?.[0]).toContain("pg_restore");
    expect(container?.args?.[0]).toContain("--clean");
    expect(container?.args?.[0]).toContain("--if-exists");
    expect(container?.args?.[0]).toContain("--no-owner");
    expect(container?.args?.[0]).toContain("--no-acl");
    expect(container?.args?.[0]).toContain("pipefail");

    const envVars = container?.env ?? [];
    const envMap = Object.fromEntries(
      envVars.map((e: { name?: string }) => [e.name, e]),
    );

    expect(envMap.PGHOST.value).toBe(
      "brave-lion-22-9c4d-pg-pooler.brave-lion-22-9c4d.svc.cluster.local",
    );
    expect(envMap.PGPORT.value).toBe("5432");
    expect(envMap.S3_BUCKET.value).toBe("powerhouse-env-dumps");
    // Same key the dump pipeline writes — restore reads from there.
    expect(envMap.S3_KEY.value).toBe("brave-lion-22-9c4d/abc12345.dump");
    expect(envMap.S3_ENDPOINT.value).toBe(
      "https://fsn1.your-objectstorage.com",
    );

    expect(envMap.PGPASSWORD.valueFrom.secretKeyRef.name).toBe(
      "brave-lion-22-9c4d-pg-app",
    );
    expect(envMap.PGPASSWORD.valueFrom.secretKeyRef.key).toBe("password");

    expect(envMap.AWS_ACCESS_KEY_ID.value).toBe("TESTACCESS");
    expect(envMap.AWS_SECRET_ACCESS_KEY.value).toBe("TESTSECRET");

    expect(job.spec?.template.spec?.imagePullSecrets).toEqual([
      { name: "harbor-credentials" },
    ]);
  });
});
