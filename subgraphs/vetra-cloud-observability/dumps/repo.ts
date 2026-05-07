import type { Kysely } from "kysely";
import type { DatabaseDumps, ObservabilityDB } from "../db/schema.js";

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function shortId(len = 12): string {
  let s = "";
  for (let i = 0; i < len; i++) {
    s += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  }
  return s;
}

const TTL_HOURS = 24;
const IN_FLIGHT = ["PENDING", "RUNNING"] as const;
const ERROR_MESSAGE_LIMIT = 500;

export type CreateInput = {
  documentId: string;
  tenantId: string;
  requestedBy: string;
  now: Date;
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

  async pruneOlderThan(cutoff: Date): Promise<number> {
    const result = await this.db
      .deleteFrom("database_dumps")
      .where("requestedAt", "<", cutoff.toISOString())
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0);
  }
}
