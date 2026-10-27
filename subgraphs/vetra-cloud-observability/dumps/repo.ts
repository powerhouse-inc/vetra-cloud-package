import type { Kysely } from "kysely";
import type { DatabaseDumps, DumpSource, ObservabilityDB } from "../db/schema.js";

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function shortId(len = 12): string {
  let s = "";
  for (let i = 0; i < len; i++) {
    s += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  }
  return s;
}

/** Hard ceiling for every dump; count-based retention usually removes it sooner. */
const TTL_HOURS = 24 * 30;
const IN_FLIGHT = ["PENDING", "RUNNING"] as const;
const ERROR_MESSAGE_LIMIT = 500;

export type CreateInput = {
  documentId: string;
  tenantId: string;
  requestedBy: string;
  now: Date;
  /** Defaults to MANUAL (owner-requested). */
  source?: DumpSource;
};

export class DumpsRepo {
  constructor(private readonly db: Kysely<ObservabilityDB>) {}

  async create(input: CreateInput): Promise<DatabaseDumps> {
    const existing = await this.db
      .selectFrom("database_dumps")
      .select(["id"])
      .where("tenantId", "=", input.tenantId)
      .where("status", "in", [...IN_FLIGHT])
      .executeTakeFirst();
    if (existing) throw new Error("DUMP_IN_PROGRESS");

    const id = shortId();
    const expiresAt = new Date(input.now.getTime() + TTL_HOURS * 3600 * 1000);
    const row: DatabaseDumps = {
      id,
      documentId: input.documentId,
      tenantId: input.tenantId,
      requestedBy: input.requestedBy.toLowerCase(),
      status: "PENDING",
      jobName: null,
      s3Key: null,
      sizeBytes: null,
      errorMessage: null,
      requestedAt: input.now.toISOString(),
      startedAt: null,
      completedAt: null,
      expiresAt: expiresAt.toISOString(),
      source: input.source ?? "MANUAL",
    };
    await this.db.insertInto("database_dumps").values(row).execute();
    return row;
  }

  async setJobName(id: string, jobName: string): Promise<void> {
    await this.db
      .updateTable("database_dumps")
      .set({ jobName })
      .where("id", "=", id)
      .execute();
  }

  async markRunning(id: string, jobName: string, at: Date): Promise<void> {
    await this.db
      .updateTable("database_dumps")
      .set({ status: "RUNNING", jobName, startedAt: at.toISOString() })
      .where("id", "=", id)
      .where("status", "=", "PENDING")
      .execute();
  }

  async markReady(
    id: string,
    s3Key: string,
    sizeBytes: number,
    at: Date,
  ): Promise<void> {
    await this.db
      .updateTable("database_dumps")
      .set({
        status: "READY",
        s3Key,
        sizeBytes,
        completedAt: at.toISOString(),
      })
      .where("id", "=", id)
      .execute();
  }

  async markFailed(id: string, errorMessage: string, at: Date): Promise<void> {
    await this.db
      .updateTable("database_dumps")
      .set({
        status: "FAILED",
        errorMessage: errorMessage.slice(0, ERROR_MESSAGE_LIMIT),
        completedAt: at.toISOString(),
      })
      .where("id", "=", id)
      .execute();
  }

  async listByTenant(tenantId: string, limit = 20): Promise<DatabaseDumps[]> {
    const rows = await this.db
      .selectFrom("database_dumps")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .orderBy("requestedAt", "desc")
      .limit(limit)
      .execute();
    return rows as DatabaseDumps[];
  }

  async getById(id: string): Promise<DatabaseDumps | null> {
    const row = await this.db
      .selectFrom("database_dumps")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return (row as DatabaseDumps | undefined) ?? null;
  }

  async listInFlight(): Promise<DatabaseDumps[]> {
    const rows = await this.db
      .selectFrom("database_dumps")
      .selectAll()
      .where("status", "in", [...IN_FLIGHT])
      .execute();
    return rows as DatabaseDumps[];
  }

  /** Rows of one source for a tenant, oldest first. */
  async listBySource(tenantId: string, source: DumpSource): Promise<DatabaseDumps[]> {
    const rows = await this.db
      .selectFrom("database_dumps")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .where("source", "=", source)
      .orderBy("requestedAt", "asc")
      .execute();
    return rows as DatabaseDumps[];
  }

  async lastRequestedAt(tenantId: string, source: DumpSource): Promise<Date | null> {
    const row = await this.db
      .selectFrom("database_dumps")
      .select(["requestedAt"])
      .where("tenantId", "=", tenantId)
      .where("source", "=", source)
      .orderBy("requestedAt", "desc")
      .limit(1)
      .executeTakeFirst();
    return row ? new Date(row.requestedAt) : null;
  }

  /** In-flight dumps of one source across all tenants (scheduler concurrency cap). */
  async countInFlightBySource(source: DumpSource): Promise<number> {
    const row = await this.db
      .selectFrom("database_dumps")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("source", "=", source)
      .where("status", "in", [...IN_FLIGHT])
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  async deleteById(id: string): Promise<void> {
    await this.db.deleteFrom("database_dumps").where("id", "=", id).execute();
  }

  /**
   * Drops rows a day past their `expiresAt`. The bucket lifecycle has
   * removed their files by then; the grace day keeps an expired row visible
   * (as expired) briefly instead of vanishing at the exact TTL.
   */
  async pruneExpired(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - 24 * 3600 * 1000);
    const result = await this.db
      .deleteFrom("database_dumps")
      .where("expiresAt", "<", cutoff.toISOString())
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0);
  }
}
