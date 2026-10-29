import type { IProcessor, IProcessorHostModule, OperationWithContext } from "@powerhousedao/reactor-browser";
import type { IDocumentView } from "@powerhousedao/reactor";
import type { Kysely } from "kysely";
import { markChangesPushed, type VetraCloudEnvironmentAction, type VetraCloudEnvironmentDocument, type VetraCloudEnvironmentState, type VetraCloudAppLink, type BackupSchedule } from "../../document-models/vetra-cloud-environment/index.js";
import { syncEnvironment, deleteEnvironmentFromGitops, getTenantId } from "./gitops.js";
import { removeEnvironmentRecord, tenantIdOwner } from "./cleanup.js";
import type { DB } from "./schema.js";
import { sendNotifications } from "./notifications.js";
import type { AppImageProjectResolver } from "./app-image-project.js";
import { childLogger } from "document-model";
import type { SecretsService } from "../../subgraphs/vetra-cloud-secrets/services/secrets-service.js";

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
  private resolveAppImageProject: AppImageProjectResolver | null;

  constructor(
    relationalDb: Kysely<DB>,
    dispatch: IProcessorHostModule["dispatch"],
    documentView: IDocumentView,
    secretsService: SecretsService | null = null,
    resolveAppImageProject: AppImageProjectResolver | null = null,
  ) {
    this.resolveAppImageProject = resolveAppImageProject;
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

    // Owner notification webhooks. Not awaited: delivery is best effort and
    // must never delay or fail the read-model / gitops work below.
    void sendNotifications(operations);

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
      const { owner, label: envLabel, genericSubdomain, customDomain, packages, services, status, autoUpdateChannel, studioInstanceId } = state;
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

      // Fail closed on a tenantId collision: another (older) environment
      // document is already deployed as this tenant (same subdomain + same 8-character id
      // prefix; document ids can be chosen client-side). Projecting this one
      // would make it a co-owner of the tenant's env vars and secrets and
      // point its gitops sync at the other environment's namespace.
      // Only a document newly taking the tenantId (no row yet, or a row with
      // another tenantId) is refused; re-projecting a document that already
      // holds it never is, so legacy rows sharing a tenantId keep updating.
      const alreadyHolds = tenantId
        ? !!(await this.relationalDb
            .selectFrom("environments")
            .select("id")
            .where("id", "=", documentId)
            .where("tenantId", "=", tenantId)
            .executeTakeFirst())
        : false;
      if (tenantId && !alreadyHolds) {
        const holder = await tenantIdOwner(this.relationalDb, tenantId, documentId);
        if (holder) {
          logger.error(
            `Refusing environment ${documentId}: tenantId "${tenantId}" is already deployed by environment ${holder}. ` +
              `Not projected, no gitops sync.`,
          );
          continue;
        }
      }

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
        studioInstanceId: studioInstanceId ?? null,
        fusion: state.fusion ? JSON.stringify(state.fusion) : null,
        ...appLinkColumns(state),
        ...orgColumns(state),
        ...backupScheduleColumn(state),
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
      await this.relationalDb
        .insertInto("environments")
        .values({ id: documentId, ...row, createdBy })
        .onConflict((oc) => oc.column("id").doUpdateSet(row))
        .execute();

      // Only sync to git when changes are approved
      if (status === "CHANGES_APPROVED") {
        logger.info(`Triggering gitops sync for "${label}"`);
        try {
          await syncEnvironment(
            this.relationalDb,
            state,
            documentId,
            this.secretsService,
            this.resolveAppImageProject,
          );
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
      } else if (status === "STOPPED") {
        // Housekeeping sleep: re-render so the chart sees global.disabled=true
        // (workload + ingress removed; namespace/PVC/cert kept). No
        // MARK_CHANGES_PUSHED dance — STOPPED is a resting state, not a deploy.
        // (Wake flips the env back to CHANGES_APPROVED, which re-enables via the
        // branch above and runs the normal deploy pipeline.)
        logger.info(`Triggering gitops sync for "${label}" (sleep → disabled)`);
        try {
          await syncEnvironment(
            this.relationalDb,
            state,
            documentId,
            this.secretsService,
            this.resolveAppImageProject,
          );
          logger.info(`Gitops sleep sync completed for "${label}"`);
        } catch (error) {
          logger.error(`Gitops sleep sync failed for "${label}": ${String(error)}`);
        }
      } else {
        // No gitops re-render on a bare ownership transfer (warm-pool claim).
        // ADMINS — the only owner-gated value that remained after the network
        // lock was removed — is now delivered through the tenant Secret in the
        // claim's batched write (one Reloader bounce), so the slow ~30s
        // owner-change gitops rollout is gone. A real config change still
        // renders via the CHANGES_APPROVED path above.
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
    // A refused DELETE_NODE removed nothing.
    if (operation.error) return undefined;

    const input = operation.action.input as { id?: string } | undefined;
    const deletedNodeId = input?.id;
    if (!deletedNodeId) return undefined;

    // A DELETE_NODE only proves a node left some drive: any drive's writer can
    // name any document id. So only the reversible read-model/gitops cleanup
    // happens here; the tenant's env vars and secrets are purged solely on a
    // proven document deletion (studio-pool's reactor `Deleted` subscription).
    const removed = await removeEnvironmentRecord(this.relationalDb, deletedNodeId);

    if (!removed) return deletedNodeId;

    const label = removed.name ?? deletedNodeId;
    logger.info(`Deleting environment record for "${label}"`);

    // Clean up gitops tenant directory
    if (removed.subdomain) {
      const tenantId = getTenantId(removed.subdomain, deletedNodeId);
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

/** Read-model columns mirroring the system-only App link (state.app). */
export function appLinkColumns(state: {
  app?: VetraCloudAppLink | null;
}): { appId: string | null; appRole: string | null; prNumber: number | null } {
  const app = state.app ?? null;
  return {
    appId: app?.appId ?? null,
    appRole: app?.role ?? null,
    prNumber: app?.prNumber ?? null,
  };
}

/**
 * Read-model column mirroring `state.backupSchedule` as JSON. Read by the
 * observability subgraph's backup scheduler; NULL means the platform default.
 */
export function backupScheduleColumn(state: {
  backupSchedule?: BackupSchedule | null;
}): { backupSchedule: string | null } {
  const schedule = state.backupSchedule ?? null;
  return { backupSchedule: schedule ? JSON.stringify(schedule) : null };
}

/** Read-model columns mirroring organisation ownership. */
export function orgColumns(state: {
  ownerOrgId?: string | null;
  orgOperators?: readonly string[] | null;
}): { ownerOrgId: string | null; orgOperators: string } {
  return {
    ownerOrgId: state.ownerOrgId ?? null,
    orgOperators: JSON.stringify(state.orgOperators ?? []),
  };
}
