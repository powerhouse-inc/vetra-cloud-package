import type { IProcessor, OperationWithContext } from "@powerhousedao/reactor-browser";
import type { Kysely } from "kysely";
import { type VetraCloudEnvironmentState } from "../../document-models/vetra-cloud-environment/index.js";
import { syncEnvironment, deleteEnvironmentFromGitops, getTenantId } from "./gitops.js";
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

    // Collect deleted document IDs from drive operations
    const deletedIds = new Set<string>();
    for (const { operation, context } of operations) {
      if (context.documentType === "powerhouse/document-drive") {
        const deletedId = await this.handleDriveOperation(operation);
        if (deletedId) deletedIds.add(deletedId);
      }
    }

    // Deduplicate environment operations: only process the last operation per document.
    // Skip documents that were deleted in this same batch to avoid resurrecting them.
    const lastByDocument = new Map<string, OperationWithContext>();
    for (const entry of operations) {
      if (entry.context.documentType === "powerhouse/vetra-cloud-environment"
        && !deletedIds.has(entry.context.documentId)) {
        lastByDocument.set(entry.context.documentId, entry);
      }
    }

    if (lastByDocument.size > 0) {
      logger.info(
        `Processing ${lastByDocument.size} environment(s) ` +
        `(deduplicated from ${operations.filter((o) => o.context.documentType === "powerhouse/vetra-cloud-environment").length} operations)`,
      );
    }

    for (const [documentId, { operation, context }] of lastByDocument) {
      const phState = context.resultingState
        ? JSON.parse(context.resultingState) as { global: VetraCloudEnvironmentState }
        : undefined;

      if (!phState) {
        logger.warn(`No resulting state for operation ${operation.index} on ${documentId}`);
        continue;
      }

      const state = phState.global;
      const { name, subdomain, customDomain, packages, services, status } = state;
      const label = name ?? documentId;
      const tenantId = subdomain
        ? getTenantId(subdomain, documentId)
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
        .where("id", "=", documentId)
        .executeTakeFirst();

      if (!environment) {
        logger.info(`Creating new environment record for "${label}"`);
        await this.relationalDb
          .insertInto("environments")
          .values({ id: documentId, ...row })
          .execute();
      } else {
        logger.info(`Updating existing environment record for "${label}"`);
        await this.relationalDb
          .updateTable("environments")
          .set(row)
          .where("id", "=", documentId)
          .execute();
      }

      logger.info(`Triggering gitops sync for "${label}"`);
      try {
        await syncEnvironment(state, documentId);
        logger.info(`Gitops sync completed for "${label}"`);
      } catch (error) {
        logger.error(`Gitops sync failed for "${label}": ${String(error)}`);
      }
    }
  }

  /**
   * Handle a drive-level operation. Returns the deleted document ID if a
   * DELETE_NODE was processed, so the caller can skip syncing it.
   */
  private async handleDriveOperation(operation: OperationWithContext["operation"]): Promise<string | undefined> {
    if (operation.action.type !== "DELETE_NODE") return undefined;

    const input = operation.action.input as { id?: string } | undefined;
    const deletedNodeId = input?.id;
    if (!deletedNodeId) return undefined;

    const environment = await this.relationalDb
      .selectFrom("environments")
      .select(["id", "name", "subdomain"])
      .where("id", "=", deletedNodeId)
      .executeTakeFirst();

    if (!environment) return deletedNodeId;

    const label = environment.name ?? deletedNodeId;
    logger.info(`Deleting environment record for "${label}"`);

    await this.relationalDb
      .deleteFrom("environments")
      .where("id", "=", deletedNodeId)
      .execute();

    // Clean up gitops tenant directory
    if (environment.subdomain) {
      const tenantId = getTenantId(environment.subdomain, deletedNodeId);
      logger.info(`Removing gitops tenant "${tenantId}" for deleted environment "${label}"`);
      try {
        await deleteEnvironmentFromGitops(tenantId);
        logger.info(`Gitops cleanup completed for "${label}"`);
      } catch (error) {
        logger.error(`Gitops cleanup failed for "${label}": ${String(error)}`);
      }
    }

    return deletedNodeId;
  }

  async onDisconnect() {}
}
