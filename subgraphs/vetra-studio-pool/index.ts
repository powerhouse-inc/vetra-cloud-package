import { BaseSubgraph } from "@powerhousedao/reactor-api";
import { DocumentChangeType } from "@powerhousedao/reactor";
import type { DocumentNode } from "graphql";
import type { Kysely } from "kysely";
import { schema } from "./schema.js";
import { createResolvers } from "./resolvers.js";
import { loadPoolConfig } from "./config.js";
import { makeClaimDb, makeKeeperDb } from "./pool-db.js";
import { claimWarmEnvironment } from "./claim.js";
import { createStudioEnvironmentDoc, type ReactorLike } from "./create-env.js";
import { PoolKeeper } from "./keeper.js";
import type { DB } from "../../processors/vetra-cloud-environment/schema.js";
import { removeEnvironmentRecord } from "../../processors/vetra-cloud-environment/cleanup.js";
import {
  deleteEnvironmentFromGitops,
  getTenantId,
} from "../../processors/vetra-cloud-environment/gitops.js";
import { setOwner } from "../../document-models/vetra-cloud-environment/v1/gen/creators.js";
import { OpenBaoTransitClient } from "../vetra-cloud-secrets/openbao-transit.js";
import {
  createSecretsService,
  type SecretsService,
} from "../vetra-cloud-secrets/services/secrets-service.js";
import type { SecretsDB } from "../vetra-cloud-secrets/db/schema.js";
import { getRedeemedKeyCiphertext } from "../vetra-access-codes/db/codes.js";
import { ACCESS_CODES_TRANSIT_TENANT } from "../vetra-access-codes/resolvers.js";
import type { VetraAccessCodesDB } from "../vetra-access-codes/db/schema.js";

const DEFAULT_TRANSIT_ROLE = "vetra-secrets";
const ENV_DOC_TYPE = "powerhouse/vetra-cloud-environment";

/**
 * Warm pool for Vetra Studio. Two responsibilities, both in-process:
 *  - `claimStudioEnvironment` mutation: atomically assigns a warm env to an
 *    invite-code caller, transfers ownership (system SET_OWNER), and injects the
 *    code's attached key (reusing the access-codes lookup + secrets service).
 *  - PoolKeeper worker: creates/maintains STUDIO_POOL_SIZE warm envs via the
 *    reactor client directly (no wallet, no separate service). Started only when
 *    STUDIO_POOL_SIZE > 0.
 */
export class VetraStudioPoolSubgraph extends BaseSubgraph {
  name = "vetra-studio-pool";
  typeDefs: DocumentNode = schema;
  resolvers: Record<string, unknown> = {};
  additionalContextFields = {};
  private keeper: PoolKeeper | null = null;
  private unsubscribeDocumentDeleted: (() => void) | null = null;

  async onSetup() {
    const cfg = loadPoolConfig(process.env);

    const openbaoAddr = process.env.OPENBAO_ADDR;
    if (!openbaoAddr) {
      console.warn("[studio-pool] OPENBAO_ADDR unset — claim + keeper disabled");
      return;
    }
    const transit = new OpenBaoTransitClient({
      addr: openbaoAddr,
      role: process.env.OPENBAO_TRANSIT_ROLE ?? DEFAULT_TRANSIT_ROLE,
      keyNamePrefix: process.env.OPENBAO_TRANSIT_KEY_PREFIX,
    });

    const envDb = (await this.relationalDb.createNamespace(
      "vetra-cloud-environments",
    )) as unknown as Kysely<DB>;
    const secretsDb = (await this.relationalDb.createNamespace(
      "vetra-cloud-secrets",
    )) as unknown as Kysely<SecretsDB>;
    const accessDb = (await this.relationalDb.createNamespace(
      "vetra-access-codes",
    )) as unknown as Kysely<VetraAccessCodesDB>;

    const secretsService: SecretsService = createSecretsService({
      db: secretsDb,
      transit,
    });
    const claimDb = makeClaimDb(envDb);

    // In-process reactor adapter: create doc + apply system-signed actions.
    const reactor: ReactorLike = {
      createDocument: async () => {
        const doc = await this.reactorClient.createEmpty(ENV_DOC_TYPE, {});
        return (doc.header as { id: string }).id;
      },
      execute: (documentId, branch, actions) =>
        this.reactorClient
          .execute(documentId, branch, actions as never)
          .then(() => undefined),
    };

    // Hard-delete an env document. The delete subscription below tears down the
    // read-model row + gitops tenant dir; the namespace reaper releases the
    // namespace + its TLS cert. Used for recycling stale warm envs and cleaning
    // up half-claimed/failed-seed orphans — replaces the old `terminateEnvironment`
    // status flip, which left a pod + cert running (a leak).
    const deleteEnv = (documentId: string) =>
      this.reactorClient.deleteDocument(documentId).then(() => undefined);

    const claim = (did: string) =>
      claimWarmEnvironment(
        {
          claimDb,
          getKeyForDid: async (d) => {
            const ct = await getRedeemedKeyCiphertext(accessDb, d);
            return ct === null ? null : transit.decrypt(ACCESS_CODES_TRANSIT_TENANT, ct);
          },
          setOwner: (documentId, address) =>
            reactor.execute(documentId, "main", [setOwner({ address })]),
          setSecrets: (tenantId, entries) =>
            secretsService.setSecrets(tenantId, entries),
          deleteEnv,
          cfg: { version: cfg.version },
          nowIso: () => new Date().toISOString(),
          logger: console,
        },
        did,
      );

    this.resolvers = createResolvers({ claim, version: cfg.version });

    // Reconcile the `environments` read-model + gitops tenant dir when a
    // document is deleted via `deleteDocument(identifier)`. That path never
    // emits a DELETE_NODE drive operation the vetra-cloud-environment processor
    // can see, so without this subscription the row + tenant dir linger forever
    // and surface as "phantom studios" in the UI. The DELETE_NODE path in the
    // processor shares the same `removeEnvironmentRecord` cleanup.
    //
    // The reactor's deletion signal is exposed on IReactorClient via
    // `subscribe(search, cb)` — it delivers a DocumentChangeEvent whose
    // `type === Deleted` carries the deleted id in `context.childId`
    // (onDocumentDeleted itself lives on the private subscriptionManager and is
    // not reachable from the client). SearchFilter supports a `type` filter, so
    // we scope to env documents; `removeEnvironmentRecord` is also a safe no-op
    // for any non-env id that slips through (it deletes nothing, returns null).
    this.unsubscribeDocumentDeleted = this.reactorClient.subscribe(
      { type: ENV_DOC_TYPE },
      (event) => {
        if (event.type !== DocumentChangeType.Deleted) return;
        const id = event.context?.childId;
        if (!id) return;
        void this.reconcileDeletedEnvironment(envDb, id);
      },
    );

    if (cfg.enabled) {
      this.keeper = new PoolKeeper({
        db: makeKeeperDb(envDb),
        createEnv: () =>
          createStudioEnvironmentDoc(reactor, {
            version: cfg.version,
            sizeName: cfg.sizeName,
            registry: cfg.registry,
          }),
        deleteEnv,
        cfg,
        logger: console,
      });
      this.keeper.start();
      console.info(
        `[studio-pool] keeper started (size=${cfg.size}, version=${cfg.version})`,
      );
    }
  }

  /**
   * Remove a deleted environment's read-model row and tear down its gitops
   * tenant directory. Defensive: a failure for one document must never kill the
   * subscription, so the whole body is wrapped in try/catch.
   */
  private async reconcileDeletedEnvironment(
    envDb: Kysely<DB>,
    id: string,
  ): Promise<void> {
    try {
      const removed = await removeEnvironmentRecord(envDb, id);
      if (removed?.subdomain) {
        try {
          await deleteEnvironmentFromGitops(getTenantId(removed.subdomain, id));
        } catch (e) {
          console.warn(
            `[studio-pool] gitops cleanup failed for deleted env ${id}: ${String(e)}`,
          );
        }
      }
    } catch (e) {
      console.warn(
        `[studio-pool] failed to reconcile deleted document ${id}: ${String(e)}`,
      );
    }
  }

  async onDisconnect() {
    this.unsubscribeDocumentDeleted?.();
    this.unsubscribeDocumentDeleted = null;
    this.keeper?.stop();
    this.keeper = null;
  }
}
