import { describe, expect, it } from "vitest";
import { buildDumpJob } from "../dumps/job-spec.js";

describe("buildDumpJob", () => {
  it("builds a Job manifest with the expected metadata, env vars, and resources", () => {
    const job = buildDumpJob({
      dumpId: "abc12345",
      tenantNs: "brave-lion-22-9c4d",
      image: "cr.vetra.io/powerhouse-inc/pgdump-uploader:1.0.0",
      bucket: "powerhouse-env-dumps",
      s3Endpoint: "https://fsn1.your-objectstorage.com",
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

    // S3 credentials come from a per-tenant ExternalSecret.
    expect(envMap.AWS_ACCESS_KEY_ID.valueFrom.secretKeyRef.name).toBe(
      "env-dumps-s3-credentials",
    );
    expect(envMap.AWS_SECRET_ACCESS_KEY.valueFrom.secretKeyRef.name).toBe(
      "env-dumps-s3-credentials",
    );

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
