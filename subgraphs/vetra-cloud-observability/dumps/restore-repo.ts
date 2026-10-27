import type { Kysely } from "kysely";
import type { DatabaseRestores, ObservabilityDB, RestoreStatus } from "../db/schema.js";

const ACTIVE: RestoreStatus[] = ["SAFETY_DUMP", "STOPPING", "RESTORING", "STARTING"];
const ERROR_MESSAGE_LIMIT = 500;

function restoreId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 12; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

export type CreateRestoreInput = {
  documentId: string;
  tenantId: string;
  dumpId: string;
  safetyDumpId: string;
  requestedBy: string;
  now: Date;
};

export type RestorePatch = Partial<
  Pick<DatabaseRestores, "status" | "jobName" | "replicas" | "errorMessage" | "completedAt">
>;

export class RestoresRepo {
  constructor(private readonly db: Kysely<ObservabilityDB>) {}

  async create(input: CreateRestoreInput): Promise<DatabaseRestores> {
    const at = input.now.toISOString();
    const row: DatabaseRestores = {
      id: restoreId(),
      documentId: input.documentId,
      tenantId: input.tenantId,
      dumpId: input.dumpId,
      safetyDumpId: input.safetyDumpId,
      status: "SAFETY_DUMP",
      jobName: null,
      replicas: null,
      errorMessage: null,
      requestedBy: input.requestedBy.toLowerCase(),
      requestedAt: at,
      updatedAt: at,
      completedAt: null,
    };
    await this.db.insertInto("database_restores").values(row).execute();
    return row;
  }

  /** Applies a patch and stamps `updatedAt` (status changes restart the step timeout). */
  async update(id: string, patch: RestorePatch, now: Date): Promise<void> {
    const set: RestorePatch & { updatedAt: string } = { ...patch, updatedAt: now.toISOString() };
    if (set.errorMessage) set.errorMessage = set.errorMessage.slice(0, ERROR_MESSAGE_LIMIT);
    await this.db.updateTable("database_restores").set(set).where("id", "=", id).execute();
  }

  async getById(id: string): Promise<DatabaseRestores | null> {
    const row = await this.db
      .selectFrom("database_restores")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return (row as DatabaseRestores | undefined) ?? null;
  }

  async activeForTenant(tenantId: string): Promise<DatabaseRestores | null> {
    const row = await this.db
      .selectFrom("database_restores")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .where("status", "in", ACTIVE)
      .executeTakeFirst();
    return (row as DatabaseRestores | undefined) ?? null;
  }

  async listActive(): Promise<DatabaseRestores[]> {
    const rows = await this.db
      .selectFrom("database_restores")
      .selectAll()
      .where("status", "in", ACTIVE)
      .execute();
    return rows as DatabaseRestores[];
  }

  async listByTenant(tenantId: string, limit = 10): Promise<DatabaseRestores[]> {
    const rows = await this.db
      .selectFrom("database_restores")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .orderBy("requestedAt", "desc")
      .limit(limit)
      .execute();
    return rows as DatabaseRestores[];
  }
}
