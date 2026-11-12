import { describe, expect, it } from "vitest";
import { instanceBackupDepsFromEnv } from "../backups/k8s.js";
import { fakeBackupK8s } from "./backups-fixtures.js";

describe("instanceBackupDepsFromEnv", () => {
  it("needs the dumps S3 credentials, and takes the dumps settings and the archive image from the environment", async () => {
    const fake = fakeBackupK8s();
    let made = 0;
    const make = async () => {
      made++;
      return fake.k8s;
    };
    expect(await instanceBackupDepsFromEnv({}, make)).toBeNull();
    expect(made).toBe(0);
    const deps = await instanceBackupDepsFromEnv(
      {
        VETRA_DUMPS_S3_ACCESS_KEY: "AK",
        VETRA_DUMPS_S3_SECRET_KEY: "SK",
        VETRA_DUMPS_BUCKET: "b",
      },
      make,
    );
    expect(deps).toMatchObject({
      k8s: fake.k8s,
      dumpJob: {
        image: "cr.vetra.io/powerhouse-inc-powerhouse/pgdump-uploader:1.0.0",
        bucket: "b",
        s3Endpoint: "https://fsn1.your-objectstorage.com",
        s3AccessKey: "AK",
        s3SecretKey: "SK",
      },
      archiveImage:
        "cr.vetra.io/powerhouse-inc-powerhouse/pgdump-uploader:1.1.0",
    });
  });
});
