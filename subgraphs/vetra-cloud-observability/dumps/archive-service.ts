import type { V1Job } from "@kubernetes/client-node";
import type { DataArchives } from "../db/schema.js";
import { buildArchiveJob } from "./archive-job-spec.js";
import type { ArchivesRepo, CreateArchiveInput } from "./archive-repo.js";

export type ArchiveJobDeps = {
  repo: ArchivesRepo;
  createJob: (namespace: string, body: V1Job) => Promise<string>;
  image: string;
  bucket: string;
  s3Endpoint: string;
  s3AccessKey: string;
  s3SecretKey: string;
};

/**
 * Inserts a PENDING archive row and creates its Job. Throws
 * ARCHIVE_IN_PROGRESS when the tenant already has one in flight; a Job
 * creation failure marks the row FAILED and rethrows (as createDumpAndJob).
 */
export async function createArchiveAndJob(
  deps: ArchiveJobDeps,
  input: CreateArchiveInput & { colocate: boolean },
): Promise<DataArchives> {
  const archive = await deps.repo.create(input);
  const job = buildArchiveJob({
    archiveId: archive.id,
    tenantNs: input.tenantId,
    pvcName: input.pvcName,
    colocate: input.colocate,
    image: deps.image,
    bucket: deps.bucket,
    s3Endpoint: deps.s3Endpoint,
    s3AccessKey: deps.s3AccessKey,
    s3SecretKey: deps.s3SecretKey,
    s3Key: input.s3Key,
  });
  try {
    const name = await deps.createJob(input.tenantId, job);
    await deps.repo.setJobName(archive.id, name || `dataarchive-${archive.id}`);
  } catch (err) {
    await deps.repo.markFailed(
      archive.id,
      err instanceof Error ? err.message : "createJob failed",
      input.now,
    );
    throw err;
  }
  return archive;
}
