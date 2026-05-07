import { describe, expect, it, vi } from "vitest";

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn(
    async (_client: unknown, _command: unknown, opts: { expiresIn: number }) =>
      `https://signed.example/path?expiresIn=${opts.expiresIn}`,
  ),
}));

import { S3Helper } from "../dumps/s3.js";

describe("S3Helper", () => {
  it("generates a presigned GET URL with 15-min (900s) expiry", async () => {
    const helper = new S3Helper({
      endpoint: "https://fsn1.your-objectstorage.com",
      region: "fsn1",
      accessKeyId: "k",
      secretAccessKey: "s",
      bucket: "powerhouse-env-dumps",
    });
    const url = await helper.presignDownload("tenant/abc.dump");
    expect(url).toContain("expiresIn=900");
    expect(url).toContain("https://signed.example");
  });

  it("returns null from headSize on AWS errors", async () => {
    const helper = new S3Helper({
      endpoint: "https://invalid.endpoint.example",
      region: "fsn1",
      accessKeyId: "k",
      secretAccessKey: "s",
      bucket: "powerhouse-env-dumps",
    });
    // Inject a stub send() that throws — simulates a missing object or
    // network failure. Helper must catch and return null.
    (helper as unknown as { client: { send: () => Promise<never> } }).client = {
      send: () => {
        throw new Error("NotFound");
      },
    };
    const size = await helper.headSize("tenant/missing.dump");
    expect(size).toBeNull();
  });

  it("returns ContentLength when present", async () => {
    const helper = new S3Helper({
      endpoint: "https://fsn1.your-objectstorage.com",
      region: "fsn1",
      accessKeyId: "k",
      secretAccessKey: "s",
      bucket: "powerhouse-env-dumps",
    });
    (helper as unknown as { client: { send: () => Promise<unknown> } }).client =
      {
        send: async () => ({ ContentLength: 4242 }),
      };
    const size = await helper.headSize("tenant/exists.dump");
    expect(size).toBe(4242);
  });
});
