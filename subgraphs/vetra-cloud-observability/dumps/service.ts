import { buildDumpJob } from "./job-spec.js";
import type { DumpResolverDeps } from "./resolvers.js";
import type { DatabaseDumps } from "../db/schema.js";

/**
 * Inputs for {@link createDumpAndJob}. Strictly typed so the runner
 * (which uses literal "scheduler" + "SCHEDULED") can't accidentally
 * mismatch the source discriminator.
 */
export type CreateDumpInput = {
  documentId: string;
  tenantId: string;
  /**
   * Lowercased EthereumAddress for MANUAL dumps; the literal
   * "scheduler" for SCHEDULED dumps. Stored as-is on the row's
   * requestedBy column (repo lowercases it on insert anyway).
   */
  requestedBy: string;
  source: "MANUAL" | "SCHEDULED";
};

/**
 * Shared core of `requestEnvironmentDump` (manual) and the
 * `backupScheduleRunner` (scheduled): inserts the row in PENDING,
 * fires the k8s Job, and reconciles state on failure. Returns the
 * created row.
 *
 * Caller is responsible for any authorization checks — this helper
 * deliberately runs in two modes (resolver-authed and system-fired)
 * and trusts its input. The resolver gates on requireOwner before
 * calling; the runner runs only on envs that have an enabled backup
 * schedule and is otherwise system-initiated.
 *
 * Concurrency: `repo.create` itself rejects with `DUMP_IN_PROGRESS`
 * when another PENDING/RUNNING dump exists for the tenant; the runner
 * is expected to catch+log that case and skip the tick, not promote it
 * into a failure.
 */
export async function createDumpAndJob(
  deps: DumpResolverDeps,
  input: CreateDumpInput,
): Promise<DatabaseDumps> {
  const {
    repo,
    createJob,
    image,
    bucket,
    s3Endpoint,
    s3AccessKey,
    s3SecretKey,
  } = deps;

  const dump = await repo.create({
    documentId: input.documentId,
    tenantId: input.tenantId,
    requestedBy: input.requestedBy,
    source: input.source,
    now: new Date(),
  });

  const job = buildDumpJob({
    dumpId: dump.id,
    tenantNs: input.tenantId,
    image,
    bucket,
    s3Endpoint,
    s3AccessKey,
    s3SecretKey,
  });
  try {
    const jobName = await createJob(input.tenantId, job);
    await repo.setJobName(dump.id, jobName || `pgdump-${dump.id}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "createJob failed";
    await repo.markFailed(dump.id, msg, new Date());
    throw err;
  }

  return dump;
}
