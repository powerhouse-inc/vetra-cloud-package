import type { V1Job } from "@kubernetes/client-node";
import type { DatabaseDumps, DumpSource } from "../db/schema.js";
import { buildDumpJob } from "./job-spec.js";
import type { DumpsRepo } from "./repo.js";

/** What it takes to start a pg_dump Job; shared by the resolver, scheduler and restore flow. */
export type DumpJobDeps = {
  repo: DumpsRepo;
  createJob: (namespace: string, body: V1Job) => Promise<string>;
  image: string;
  bucket: string;
  s3Endpoint: string;
  s3AccessKey: string;
  s3SecretKey: string;
};

export type CreateDumpInput = {
  documentId: string;
  tenantId: string;
  requestedBy: string;
  source: DumpSource;
};

/**
 * Inserts a PENDING dump row and creates its pg_dump Job. Throws
 * DUMP_IN_PROGRESS when the tenant already has a dump in flight. A Job
 * creation failure marks the row FAILED and rethrows.
 */
export async function createDumpAndJob(
  deps: DumpJobDeps,
  input: CreateDumpInput,
): Promise<DatabaseDumps> {
  const dump = await deps.repo.create({ ...input, now: new Date() });
  const job = buildDumpJob({
    dumpId: dump.id,
    tenantNs: input.tenantId,
    image: deps.image,
    bucket: deps.bucket,
    s3Endpoint: deps.s3Endpoint,
    s3AccessKey: deps.s3AccessKey,
    s3SecretKey: deps.s3SecretKey,
  });
  try {
    const jobName = await deps.createJob(input.tenantId, job);
    await deps.repo.setJobName(dump.id, jobName || `pgdump-${dump.id}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "createJob failed";
    await deps.repo.markFailed(dump.id, msg, new Date());
    throw err;
  }
  return dump;
}
