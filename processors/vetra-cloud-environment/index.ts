import type { IProcessor, OperationWithContext } from "@powerhousedao/reactor-browser";
import type { Kysely } from "kysely";
import { type VetraCloudEnvironmentState } from "../../document-models/vetra-cloud-environment/index.js";
import { syncEnvironment } from "./gitops.js";
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

      const state: VetraCloudEnvironmentState | undefined = context.resultingState
        ? JSON.parse(context.resultingState)
        : undefined;

      if (!state) {
        logger.warn(`No resulting state for operation ${operation.index} on ${context.documentId}`);
        continue;
      }

      const { name, packages, services, status } = state;

      logger.info(
        `Processing document ${context.documentId} (op ${operation.index}): ` +
        `name=${name}, status=${status}, services=[${services?.join(", ")}], ` +
        `packages=[${packages?.map((p) => `${p.name}@${p.version}`).join(", ")}]`,
      );

      const environment = await this.relationalDb
        .selectFrom("environments")
        .where("id", "=", context.documentId)
        .executeTakeFirst();

      if (!environment) {
        logger.info(`Creating new environment record for "${name}" (${context.documentId})`);
        await this.relationalDb
          .insertInto("environments")
          .values({
            name: name ?? null,
            id: context.documentId,
            packages: JSON.stringify(packages),
            services: JSON.stringify(services),
            status: status,
          })
          .execute();
      } else {
        logger.info(`Updating existing environment record for "${name}" (${context.documentId})`);
        await this.relationalDb
          .updateTable("environments")
          .set({
            name: name ?? null,
            packages: JSON.stringify(packages),
            services: JSON.stringify(services),
            status: status,
          })
          .where("id", "=", context.documentId)
          .execute();
      }

      logger.info(`Triggering gitops sync for "${name}"`);
      try {
        await syncEnvironment(state);
        logger.info(`Gitops sync completed for "${name}"`);
      } catch (error) {
        logger.error(`Gitops sync failed for "${name}": ${error}`);
      }
    }
  }

  async onDisconnect() {}
}
