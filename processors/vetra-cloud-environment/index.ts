import type { IProcessor, OperationWithContext } from "@powerhousedao/reactor-browser";
import type { Kysely } from "kysely";
import { type VetraCloudEnvironmentState } from "../../document-models/vetra-cloud-environment/index.js";
import { syncEnvironment, getTenantId } from "./gitops.js";
import { type DB } from "./schema.js";
import { childLogger } from "document-drive";

const logger = childLogger(["vetra-cloud-environment-processor"]);

export class VetraCloudEnvironmentProcessor implements IProcessor {
  private relationalDb: Kysely<DB>;

  constructor(relationalDb: Kysely<DB>) {
    this.relationalDb = relationalDb;
  }

  async onOperations(operations: OperationWithContext[]): Promise<void> {
    if (operations.length === 0) return;

    logger.info(`Received ${operations.length} operations`);

    for (const { operation, context } of operations) {
      if (context.documentType !== "powerhouse/vetra-cloud-environment") continue;

      const phState = context.resultingState
        ? JSON.parse(context.resultingState) as { global: VetraCloudEnvironmentState }
        : undefined;

      if (!phState) {
        logger.warn(`No resulting state for operation ${operation.index} on ${context.documentId}`);
        continue;
      }

      const state = phState.global;
      const { name, subdomain, customDomain, packages, services, status } = state;
      const label = name ?? context.documentId;
      const tenantId = subdomain
        ? getTenantId(subdomain, context.documentId)
        : null;

      logger.info(
        `Processing document ${label} (op ${operation.index}): ` +
        `name=${name ?? "unset"}, status=${status ?? "unset"}, ` +
        `subdomain=${subdomain ?? "unset"}, tenantId=${tenantId ?? "unset"}, ` +
        `services=[${services?.join(", ") ?? ""}], ` +
        `packages=[${(packages?.map((p) => `${p.name}@${p.version}`).join(", ")) ?? ""}]`,
      );

      const row = {
        name: name ?? null,
        subdomain: subdomain ?? null,
        tenantId,
        customDomain: customDomain ?? null,
        packages: JSON.stringify(packages ?? []),
        services: JSON.stringify(services ?? []),
        status: status ?? null,
      };

      const environment = await this.relationalDb
        .selectFrom("environments")
        .where("id", "=", context.documentId)
        .executeTakeFirst();

      if (!environment) {
        logger.info(`Creating new environment record for "${label}"`);
        await this.relationalDb
          .insertInto("environments")
          .values({ id: context.documentId, ...row })
          .execute();
      } else {
        logger.info(`Updating existing environment record for "${label}"`);
        await this.relationalDb
          .updateTable("environments")
          .set(row)
          .where("id", "=", context.documentId)
          .execute();
      }

      logger.info(`Triggering gitops sync for "${label}"`);
      try {
        await syncEnvironment(state, context.documentId);
        logger.info(`Gitops sync completed for "${label}"`);
      } catch (error) {
        logger.error(`Gitops sync failed for "${label}": ${String(error)}`);
      }
    }
  }

  async onDisconnect() {}
}
