import { hashNamespace } from "@powerhousedao/shared/processors";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import type { DB } from "../processors/vetra-cloud-environment/schema.js";
import type { StudioRow } from "../subgraphs/vetra-housekeeping/db.js";

export interface EnvDb {
  /** All claimed studios currently READY (sleep candidates, pre-eligibility). */
  listReadyStudios(): Promise<StudioRow[]>;
  close(): Promise<void>;
}

/**
 * Read-only connection to the environments read-model, in its own Postgres
 * pool (the service has no reactor-api runtime). The reactor hashes the
 * human-readable namespace to the schema name; we recompute it the same way.
 */
export function createEnvDb(opts: { databaseUrl: string; namespace: string }): EnvDb {
  const schema = hashNamespace(opts.namespace);
  const pool = new Pool({ connectionString: opts.databaseUrl });
  const db = (new Kysely<DB>({
    dialect: new PostgresDialect({ pool }),
  }).withSchema(schema)) as unknown as Kysely<DB>;

  return {
    async listReadyStudios() {
      const rows = await db
        .selectFrom("environments")
        .select(["id", "subdomain", "status", "owner", "poolState", "tenantId"])
        .where("status", "=", "READY")
        .where("owner", "is not", null)
        .execute();
      return rows.map((r) => ({
        envId: r.id,
        subdomain: r.subdomain,
        status: r.status,
        owner: r.owner,
        poolState: r.poolState,
        tenantId: r.tenantId,
      }));
    },
    close: () => db.destroy(),
  };
}
