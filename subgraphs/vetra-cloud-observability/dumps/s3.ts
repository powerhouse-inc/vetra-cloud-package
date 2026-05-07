import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const PRESIGN_TTL_SECONDS = 15 * 60;

export type S3HelperConfig = {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
};

/**
 * Thin wrapper around the AWS SDK for S3-compatible Hetzner Object
 * Storage. Holds the bucket so call sites only pass keys.
 *
 * The presigned URL has a 15-min validity. We deliberately do not
 * persist the URL anywhere — it is minted on every read so a leaked
 * URL has at most 15 minutes of authority, and re-listing always
 * re-verifies env ownership.
 */
export class S3Helper {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: S3HelperConfig) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: true,
    });
  }

  async presignDownload(key: string): Promise<string> {
    const cmd = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return getSignedUrl(this.client, cmd, { expiresIn: PRESIGN_TTL_SECONDS });
  }

  async headSize(key: string): Promise<number | null> {
    try {
      const res = (await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      )) as { ContentLength?: number };
      return res.ContentLength ?? null;
    } catch {
      return null;
    }
  }
}
