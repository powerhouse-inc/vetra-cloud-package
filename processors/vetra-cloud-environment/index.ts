import type { IProcessor, OperationWithContext } from "@powerhousedao/reactor-browser";
import type { Kysely } from "kysely";
import { markChangesPushed, type VetraCloudEnvironmentAction, type VetraCloudEnvironmentDocument, type VetraCloudEnvironmentState } from "../../document-models/vetra-cloud-environment/index.js";
import { syncEnvironment, deleteEnvironmentFromGitops, getTenantId } from "./gitops.js";
import type { DB } from "./schema.js";
import { childLogger } from "document-model";
import type { IReactorClient } from "@powerhousedao/reactor";

const logger = childLogger(["vetra-cloud-environment-processor"]);


export class VetraCloudEnvironmentProcessor implements IProcessor {
  private relationalDb: Kysely<DB>;
  private reactorClient?: IReactorClient;

  constructor(relationalDb: Kysely<DB>, reactorClient?: IReactorClient) {
    this.relationalDb = relationalDb;
    this.reactorClient = reactorClient;
  }

  private async dispatchAction(documentId: string, action: VetraCloudEnvironmentAction) {
    if (!this.reactorClient) {
      logger.warn(`Cannot dispatch ${action.type}: no reactor client`);
      return;
    }
    try {
      await this.reactorClient.execute(documentId, "main", [action]);
      logger.info(`Dispatched ${action.type} for ${documentId}`);
    } catch (err) {
      logger.error(`Failed to dispatch ${action.type} for ${documentId}: ${String(err)}`);
    }
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
      let phState = context.resultingState
        ? JSON.parse(context.resultingState) as { global: VetraCloudEnvironmentState }
        : undefined;

      // Fallback: fetch current document state if resultingState is missing
      if (!phState && this.reactorClient) {
        try {
          const doc = await this.reactorClient.get<VetraCloudEnvironmentDocument>(documentId);
          phState = doc.state;
          if (phState) {
            logger.info(`Fetched current state for ${documentId} (resultingState was missing)`);
          }
        } catch (err) {
          logger.warn(`Failed to fetch state for ${documentId}: ${String(err)}`);
        }
      }

      if (!phState) {
        logger.warn(`No state available for operation ${operation.index} on ${documentId}`);
        continue;
      }

      const state = phState.global;
      const { label: envLabel, genericSubdomain, customDomain, packages, services, status } = state;
      const label = envLabel ?? documentId;
      const tenantId = genericSubdomain
        ? getTenantId(genericSubdomain, documentId)
        : null;

      logger.info(
        `Processing document ${label} (op ${operation.index}): ` +
        `label=${envLabel ?? "unset"}, status=${status ?? "unset"}, ` +
        `subdomain=${genericSubdomain ?? "unset"}, tenantId=${tenantId ?? "unset"}, ` +
        `services=[${services?.map((s) => `${s.type}:${s.enabled}`).join(", ") ?? ""}], ` +
        `packages=[${(packages?.map((p) => `${p.name}@${p.version}`).join(", ")) ?? ""}]`,
      );

      const row = {
        name: envLabel ?? null,
        subdomain: genericSubdomain ?? null,
        tenantId,
        customDomain: customDomain?.domain ?? null,
        packages: JSON.stringify(packages ?? []),
        services: JSON.stringify(services ?? []),
        status: status ?? null,
      };

      logger.info(`Upserting environment record for "${label}"`);
      await this.relationalDb
        .insertInto("environments")
        .values({ id: documentId, ...row })
        .onConflict((oc) => oc.column("id").doUpdateSet(row))
        .execute();

      // Only sync to git when changes are approved
      if (status === "CHANGES_APPROVED") {
        logger.info(`Triggering gitops sync for "${label}"`);
        try {
          await syncEnvironment(state, documentId);
          logger.info(`Gitops sync completed for "${label}"`);

          // Re-check status before dispatching to avoid duplicate transitions
          // when multiple processor instances process the same document
          if (this.reactorClient) {
            const freshDoc = await this.reactorClient.get<VetraCloudEnvironmentDocument>(documentId);
            const freshStatus = freshDoc?.state?.global?.status;
            if (freshStatus !== "CHANGES_APPROVED") {
              logger.info(`Skipping MARK_CHANGES_PUSHED for "${label}" — status already changed to ${freshStatus}`);
            } else {
              await this.dispatchAction(documentId, markChangesPushed({}));
            }
          } else {
            await this.dispatchAction(documentId, markChangesPushed({}));
          }
        } catch (error) {
          logger.error(`Gitops sync failed for "${label}": ${String(error)}`);
        }
      } else {
        logger.info(`Skipping gitops sync for "${label}" (status: ${status})`);
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
