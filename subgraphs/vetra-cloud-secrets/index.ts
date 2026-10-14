import { BaseSubgraph } from "@powerhousedao/reactor-api";
import type { DocumentNode } from "graphql";
import type { Kysely } from "kysely";
import { schema } from "./schema.js";
import { createResolvers } from "./resolvers.js";
import { orphanPurgeMode, purgeOrphanTenantRows } from "./tenant-purge.js";
import type { DB as EnvProjection } from "../../processors/vetra-cloud-environment/schema.js";
import { up } from "./db/migrations.js";
import type { SecretsDB } from "./db/schema.js";
import { OpenBaoTransitClient } from "./openbao-transit.js";
import { defaultRenownOrgs } from "../../shared/renown-orgs.js";
import {
  appDidLookup,
  appDisputeLookup,
  createEnvAccess,
  type EnvAccessRow,
} from "../vetra-cloud-observability/env-access.js";

const DEFAULT_ROLE = "vetra-secrets";

/**
 * GraphQL surface for tenant env vars + secrets.
 *
 * Reads/writes go through the encrypted Postgres tables; on every write
 * the resolvers `pg_notify('vetra_secrets_changed', tenantId)` so the
 * standalone `secrets-controller` pod (see `/secrets-controller`) can
 * reconcile that tenant's `<tenantId>-env` ConfigMap and
 * `<tenantId>-secrets` Secret in the tenant namespace.
 *
 * History note: between commits e98be36 and the standalone-controller
 * restoration in May 2026, this subgraph also embedded the reconcile
 * loop directly. The management switchboard's ServiceAccount has no
 * cross-namespace RBAC, so every reconcile attempt failed and no
 * tenant ever saw its secrets reach a pod. The reconciler now lives in
 * its own deployment with its own ClusterRole; this subgraph is a
 * pure GraphQL service again.
 */
export class VetraCloudSecretsSubgraph extends BaseSubgraph {
  name = "vetra-cloud-secrets";
  typeDefs: DocumentNode = schema;
  resolvers: Record<string, unknown> = {};
  additionalContextFields = {};

  async onSetup() {
    const db = (await this.relationalDb.createNamespace(
      "vetra-cloud-secrets",
    )) as unknown as Kysely<SecretsDB>;

    await up(db as Kysely<any>);

    const openbaoAddr = process.env.OPENBAO_ADDR;
    if (!openbaoAddr) {
      throw new Error(
        "[secrets] OPENBAO_ADDR is required — secrets cannot be encrypted without transit engine access",
      );
    }

    const transit = new OpenBaoTransitClient({
      addr: openbaoAddr,
      role: process.env.OPENBAO_TRANSIT_ROLE ?? DEFAULT_ROLE,
      keyNamePrefix: process.env.OPENBAO_TRANSIT_KEY_PREFIX,
    });

    // The environment processor's projection: maps tenantId -> environments.
    const envDb = (await this.relationalDb.createNamespace(
      "vetra-cloud-environments",
    )) as unknown as Kysely<any>;
    // Organisation access: Renown memberships + app DIDs, as in observability.
    const appsDb = (await this.relationalDb.createNamespace(
      "vetra-apps",
    )) as unknown as Kysely<any>;

    this.resolvers = createResolvers(db, transit, {
      tenantEnvironments: async (tenantId) =>
        (await envDb
          .selectFrom("environments")
          .select(["owner", "ownerOrgId", "appId"])
          .where("tenantId", "=", tenantId)
          .execute()) as EnvAccessRow[],
      access: createEnvAccess({
        orgs: defaultRenownOrgs(),
        appDidOf: appDidLookup(appsDb),
      appOrgDisputed: appDisputeLookup(appsDb),
      }),
      tenantWait: { timeoutMs: 10_000, intervalMs: 500 },
    });

    // One-off cleanup (idempotent, every boot): env vars and secrets whose
    // environment was deleted before deletion purged them. Fail-safe, see
    // tenant-purge.ts; never blocks startup. Dry run unless
    // SECRETS_ORPHAN_PURGE=true.
    const sweep = orphanPurgeMode(process.env.SECRETS_ORPHAN_PURGE);
    if (sweep !== "off") {
      void purgeOrphanTenantRows({
        secretsDb: db,
        envDb: envDb as unknown as Kysely<EnvProjection>,
        dryRun: sweep === "dry-run",
      })
        .then(({ purged, skippedForSafety }) => {
          if (purged.length > 0) {
            // warn: prod runs LOG_LEVEL=warn and operators must see this.
            console.warn(
              `[secrets] ${sweep === "dry-run" ? "would purge (dry run; SECRETS_ORPHAN_PURGE=true to purge)" : "purged"} ` +
                `env vars/secrets of ${purged.length} deleted tenant(s): ${purged.join(", ")}`,
            );
          }
          if (skippedForSafety) {
            console.warn("[secrets] orphan tenant sweep skipped: projection empty or too many tenants would go");
          }
        })
        .catch((err: unknown) => {
          const e = (err ?? {}) as { code?: unknown; message?: unknown };
          console.error(
            "[secrets] orphan tenant sweep failed:",
            typeof e.code === "string" ? e.code : "",
            typeof e.message === "string" ? e.message : "",
          );
        });
    }
  }
}
