import type { Kysely } from "kysely";
import type { DataArchives, ObservabilityDB } from "../db/schema.js";

const IN_FLIGHT = ["PENDING", "RUNNING"] as const;
/** The dumps bucket's lifecycle ceiling (same as database dumps). */
const TTL_MS = 30 * 24 * 3600 * 1000;
const ERROR_MESSAGE_LIMIT = 500;
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function archiveId(): string {
  let s = "";
  for (let i = 0; i < 12; i++)
    s += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  return s;
}

/** Where an archive is stored in the dumps bucket. */
export const archiveKey = (tenantId: string, id: string): string =>
  `${tenantId}/data/${id}.tar.zst`;

export type CreateArchiveInput = {
  documentId: string;
  tenantId: string;
  requestedBy: string;
  /** The tenant's app data PVC (`<fullname>-app-data`). */
  pvcName: string;
  now: Date;
};

export class ArchivesRepo {
  constructor(private readonly db: Kysely<ObservabilityDB>) {}

  async inFlightForTenant(tenantId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("data_archives")
      .select("id")
      .where("tenantId", "=", tenantId)
      .where("status", "in", [...IN_FLIGHT])
      .executeTakeFirst();
    return !!row;
  }

  /** Throws ARCHIVE_IN_PROGRESS when the tenant already has one in flight. */
  async create(input: CreateArchiveInput): Promise<DataArchives> {
    if (await this.inFlightForTenant(input.tenantId))
      throw new Error("ARCHIVE_IN_PROGRESS");
    const row: DataArchives = {
      id: archiveId(),
      documentId: input.documentId,
      tenantId: input.tenantId,
      requestedBy: input.requestedBy.toLowerCase(),
      status: "PENDING",
      pvcName: input.pvcName,
      jobName: null,
      s3Key: null,
      sizeBytes: null,
      sha256: null,
      errorMessage: null,
      requestedAt: input.now.toISOString(),
      startedAt: null,
      completedAt: null,
      expiresAt: new Date(input.now.getTime() + TTL_MS).toISOString(),
    };
    await this.db.insertInto("data_archives").values(row).execute();
    return row;
  }

  async setJobName(id: string, jobName: string): Promise<void> {
    await this.db
      .updateTable("data_archives")
      .set({ jobName })
      .where("id", "=", id)
      .execute();
  }

  async markRunning(id: string, jobName: string, at: Date): Promise<void> {
    await this.db
      .updateTable("data_archives")
      .set({ status: "RUNNING", jobName, startedAt: at.toISOString() })
      .where("id", "=", id)
      .where("status", "=", "PENDING")
      .execute();
  }

  async markReady(
    id: string,
    s3Key: string,
    sizeBytes: number,
    sha256: string,
    at: Date,
  ): Promise<void> {
    await this.db
      .updateTable("data_archives")
      .set({
        status: "READY",
        s3Key,
        sizeBytes,
        sha256,
        completedAt: at.toISOString(),
      })
      .where("id", "=", id)
      .execute();
  }

  async markFailed(id: string, errorMessage: string, at: Date): Promise<void> {
    await this.db
      .updateTable("data_archives")
      .set({
        status: "FAILED",
        errorMessage: errorMessage.slice(0, ERROR_MESSAGE_LIMIT),
        completedAt: at.toISOString(),
      })
      .where("id", "=", id)
      .execute();
  }

  async getById(id: string): Promise<DataArchives | null> {
    const row = await this.db
      .selectFrom("data_archives")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return (row as DataArchives | undefined) ?? null;
  }

  async listInFlight(): Promise<DataArchives[]> {
    return (await this.db
      .selectFrom("data_archives")
      .selectAll()
      .where("status", "in", [...IN_FLIGHT])
      .execute()) as DataArchives[];
  }

  async deleteById(id: string): Promise<void> {
    await this.db.deleteFrom("data_archives").where("id", "=", id).execute();
  }

  /** Rows a day past their expiry (the bucket lifecycle removed the files by then). */
  async pruneExpired(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
    const r = await this.db
      .deleteFrom("data_archives")
      .where("expiresAt", "<", cutoff)
      .executeTakeFirst();
    return Number(r.numDeletedRows ?? 0);
  }
}
