import type { IProcessor, IProcessorHostModule, OperationWithContext } from "@powerhousedao/reactor-browser";
import type { IDocumentView } from "@powerhousedao/reactor";
import type { Kysely } from "kysely";
import { markChangesPushed, type VetraCloudEnvironmentAction, type VetraCloudEnvironmentDocument, type VetraCloudEnvironmentState } from "../../document-models/vetra-cloud-environment/index.js";
import { syncEnvironment, deleteEnvironmentFromGitops, getTenantId } from "./gitops.js";
import type { DB } from "./schema.js";
import { childLogger } from "document-model";
import type { SecretsService } from "../../subgraphs/vetra-cloud-secrets/services/secrets-service.js";

// Re-export the factory under the codegen-expected name so the auto-
// generated processors/switchboard.ts (which imports
// `vetraCloudEnvironmentFactoryBuilder` from this module) resolves.
export { vetraCloudEnvironmentProcessorFactory as vetraCloudEnvironmentFactoryBuilder } from "./factory.js";

const logger = childLogger(["vetra-cloud-environment-processor"]);


export class VetraCloudEnvironmentProcessor implements IProcessor {
  private relationalDb: Kysely<DB>;
  private dispatch: IProcessorHostModule["dispatch"];
  private documentView: IDocumentView;
  /**
   * Optional — null when OPENBAO_ADDR is unset (local dev, tests). When
   * present, gitops sync routes secret env entries through the encrypted
   * tenant_secrets table so they never land in values.yaml plaintext.
   */
  private secretsService: SecretsService | null;

  constructor(
    relationalDb: Kysely<DB>,
    dispatch: IProcessorHostModule["dispatch"],
    documentView: IDocumentView,
    secretsService: SecretsService | null = null,
  ) {
    this.relationalDb = relationalDb;
    this.dispatch = dispatch;
    this.documentView = documentView;
    this.secretsService = secretsService;
  }

  private async dispatchAction(documentId: string, action: VetraCloudEnvironmentAction) {
    try {
      await this.dispatch.execute(documentId, "main", [action]);
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
    // Capture the FIRST user-signed signer per document for the legacy createdBy column.
    // We still populate createdBy for historical reference and to seed the owner-backfill
    // in the observability subgraph, but ownership itself is now sourced from state.owner.
    const firstUserSignerByDocument = new Map<string, string>();
    for (const entry of operations) {
      if (entry.context.documentType === "powerhouse/vetra-cloud-environment"
        && !deletedIds.has(entry.context.documentId)) {
        lastByDocument.set(entry.context.documentId, entry);

        if (!firstUserSignerByDocument.has(entry.context.documentId)) {
          const userAddress = extractUserSignerAddress(entry.operation);
          if (userAddress) {
            firstUserSignerByDocument.set(entry.context.documentId, userAddress);
          }
        }
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
      if (!phState) {
        try {
          const doc = await this.documentView.get<VetraCloudEnvironmentDocument>(documentId);
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
      const { owner, label: envLabel, genericSubdomain, customDomain, packages, services, status, autoUpdateChannel } = state;
      const label = envLabel ?? documentId;
      const tenantId = genericSubdomain
        ? getTenantId(genericSubdomain, documentId)
        : null;

      logger.info(
        `Processing document ${label} (op ${operation.index}): ` +
        `label=${envLabel ?? "unset"}, status=${status ?? "unset"}, ` +
        `subdomain=${genericSubdomain ?? "unset"}, tenantId=${tenantId ?? "unset"}, ` +
        `owner=${owner ?? "unset"}, ` +
        `services=[${services?.map((s) => `${s.type}:${s.enabled}`).join(", ") ?? ""}], ` +
        `packages=[${(packages?.map((p) => `${p.name}@${p.version}`).join(", ")) ?? ""}]`,
      );

      // owner mirrors state.owner, refreshed on every upsert (it can change via
      // a SET_OWNER transfer). Normalize to lowercase for consistent matching
      // against the auth context's user address.
      const ownerNormalized = owner ? owner.toLowerCase() : null;

      const row = {
        name: envLabel ?? null,
        subdomain: genericSubdomain ?? null,
        tenantId,
        customDomain: customDomain?.domain ?? null,
        packages: JSON.stringify(packages ?? []),
        services: JSON.stringify(services ?? []),
        status: status ?? null,
        owner: ownerNormalized,
        autoUpdateChannel: autoUpdateChannel ?? null,
      };

      // createdBy is INSERT-only — never overwritten by later updates.
      // Pulled from the first user-signed op in this batch for this document.
      // Kept for historical reference and to seed the owner-backfill.
      const createdBy = firstUserSignerByDocument.get(documentId) ?? null;

      logger.info(
        `Upserting environment record for "${label}"` +
          `${createdBy ? ` (createdBy=${createdBy})` : ""}` +
          `${ownerNormalized ? ` (owner=${ownerNormalized})` : ""}`,
      );
      // Capture the prior owner so we can detect an ownership transfer (e.g. a
      // warm-pool claim) that doesn't move status to CHANGES_APPROVED but still
      // needs a gitops re-render (owner-gated config like the network lock).
      const existingRow = await this.relationalDb
        .selectFrom("environments")
        .select("owner")
        .where("id", "=", documentId)
        .executeTakeFirst();
      const prevOwner = existingRow?.owner ?? null;
      await this.relationalDb
        .insertInto("environments")
        .values({ id: documentId, ...row, createdBy })
        .onConflict((oc) => oc.column("id").doUpdateSet(row))
        .execute();

      // Only sync to git when changes are approved
      if (status === "CHANGES_APPROVED") {
        logger.info(`Triggering gitops sync for "${label}"`);
        try {
          await syncEnvironment(this.relationalDb, state, documentId, this.secretsService);
          logger.info(`Gitops sync completed for "${label}"`);

          // Re-check status before dispatching to avoid duplicate transitions
          // when multiple processor instances process the same document
          const freshDoc = await this.documentView.get<VetraCloudEnvironmentDocument>(documentId);
          const freshStatus = freshDoc?.state?.global?.status;
          if (freshStatus !== "CHANGES_APPROVED") {
            logger.info(`Skipping MARK_CHANGES_PUSHED for "${label}" — status already changed to ${freshStatus}`);
          } else {
            await this.dispatchAction(documentId, markChangesPushed({}));
          }
        } catch (error) {
          logger.error(`Gitops sync failed for "${label}": ${String(error)}`);
        }
      } else if (prevOwner !== ownerNormalized && tenantId) {
        // Ownership transferred (e.g. a warm-pool claim) without a status
        // change. Re-render gitops so owner-gated config updates — notably
        // dropping the default-deny NetworkPolicy on a freshly-claimed studio.
        // No status transition / MARK_CHANGES_PUSHED here. Use the freshest doc
        // state so `locked` is rendered from the just-set owner (avoids a
        // transient locked:true → locked:false double-commit).
        logger.info(
          `Owner changed for "${label}" (${prevOwner ?? "none"} → ${ownerNormalized ?? "none"}); scheduling gitops re-sync`,
        );
        // Fire-and-forget so a claim's re-render never head-of-line-blocks the
        // processor's operation loop (other envs / keeper creates keep flowing).
        // syncEnvironment serializes on gitMutex, so a detached render can't race
        // a concurrent one; errors are logged (same swallow-and-log semantics as
        // the CHANGES_APPROVED path — the keeper / next event re-renders).
        void (async () => {
          try {
            const freshDoc = await this.documentView.get<VetraCloudEnvironmentDocument>(documentId);
            const syncState = freshDoc?.state?.global ?? state;
            await syncEnvironment(this.relationalDb, syncState, documentId, this.secretsService);
            logger.info(`Owner-change gitops re-sync completed for "${label}"`);
          } catch (error) {
            logger.error(`Owner-change gitops re-sync failed for "${label}": ${String(error)}`);
          }
        })();
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

/**
 * Extract a user's EthereumAddress from a signed action's signer context.
 * Returns null for unsigned actions, or for actions signed by system identities
 * (e.g. switchboard) where there is no human user.
 *
 * The returned address is lowercased to match the convention used by
 * reactor-api's AuthService when comparing against the configured ADMINS list.
 */
function extractUserSignerAddress(
  operation: OperationWithContext["operation"],
): string | null {
  const signer = operation.action?.context?.signer;
  if (!signer) return null;

  const userAddress = signer.user?.address;
  if (!userAddress) return null;

  // System actions have an empty user address (only an app signer);
  // we only want human creators here.
  if (typeof userAddress !== "string" || userAddress.length === 0) return null;

  return userAddress.toLowerCase();
}
