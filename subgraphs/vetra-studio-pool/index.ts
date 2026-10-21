import { BaseSubgraph } from "@powerhousedao/reactor-api";
import { DocumentChangeType } from "@powerhousedao/reactor";
import type { DocumentNode } from "graphql";
import type { Kysely } from "kysely";
import { schema } from "./schema.js";
import { createResolvers } from "./resolvers.js";
import { loadPoolConfig } from "./config.js";
import { makeClaimDb, makeKeeperDb } from "./pool-db.js";
import { claimWarmEnvironment, legacyKeyFor } from "./claim.js";
import { createStudioEnvironmentDoc, type ReactorLike } from "./create-env.js";
import { PoolKeeper } from "./keeper.js";
import type { DB } from "../../processors/vetra-cloud-environment/schema.js";
import { removeEnvironmentRecord } from "../../processors/vetra-cloud-environment/cleanup.js";
import {
  deleteEnvironmentFromGitops,
  getTenantId,
  gcOrphanTenantDirs,
} from "../../processors/vetra-cloud-environment/gitops.js";
import { setOwner } from "../../document-models/vetra-cloud-environment/v1/gen/creators.js";
import type { VetraCloudEnvironmentState } from "../../document-models/vetra-cloud-environment/index.js";
import { tenantConfigEntries } from "../../processors/vetra-cloud-environment/gitops.js";
import {
  protectForOwner,
  protectUnownedForService,
  vetraServiceAddress,
} from "../vetra-cloud-observability/env-protection.js";
import { OpenBaoTransitClient } from "../vetra-cloud-secrets/openbao-transit.js";
import {
  createSecretsService,
  ROTATABLE_MANAGED_KEYS,
  type SecretsService,
} from "../vetra-cloud-secrets/services/secrets-service.js";
import { ensureStudioLaunchSecretsTable } from "../vetra-apps/db/migrations.js";
import { storeLaunchSecretHash } from "../vetra-apps/studio-binding.js";
import type { SecretsDB } from "../vetra-cloud-secrets/db/schema.js";
import type { VetraAppsDB } from "../vetra-apps/db/schema.js";
import type { VetraLicensingDB } from "../vetra-licensing/db/schema.js";
import { studioKeyForDid, studioLlmBudgetForDid } from "../vetra-licensing/studio-access.js";
import { up as ensureLlmTables } from "../vetra-llm/db/migrations.js";
import type { VetraLlmDB } from "../vetra-llm/db/schema.js";
import { isNotConfigured } from "../vetra-llm/errors.js";
import { createProcessBroker } from "../vetra-llm/factory.js";
import { appsTrustedIds, createStudioAccessDeps } from "../vetra-licensing/studio-access-factory.js";

const DEFAULT_TRANSIT_ROLE = "vetra-secrets";
const ENV_DOC_TYPE = "powerhouse/vetra-cloud-environment";

/**
 * Warm pool for Vetra Studio. Two responsibilities, both in-process:
 *  - `claimStudioEnvironment` mutation: atomically assigns a warm env to an
 *    caller with an active studio licence, transfers ownership (system SET_OWNER), and injects the
 *    licence's attached key (found through the licensing tables, written via the secrets service).
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
  private gcTimer: ReturnType<typeof setInterval> | null = null;

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
    // The studio licence gate: the key comes from the caller's ACTIVE
    // vetra-studio licence, found through the licensing tables.
    const licensingDb = (await this.relationalDb.createNamespace(
      "vetra-licensing",
    )) as unknown as Kysely<VetraLicensingDB>;
    const appsDb = (await this.relationalDb.createNamespace(
      "vetra-apps",
    )) as unknown as Kysely<VetraAppsDB>;
    // The launch-secret hashes live in vetra-apps; ensured here too because
    // subgraph boot order is not fixed.
    await ensureStudioLaunchSecretsTable(appsDb as Kysely<any>);
    const studioAccess = createStudioAccessDeps({
      client: this.reactorClient as never,
      licensingDb,
      trustedIds: appsTrustedIds(appsDb),
      transit,
    });

    const secretsService: SecretsService = createSecretsService({
      db: secretsDb,
      transit,
    });
    // The vetra-llm key broker, in-process. Its tables are ensured here too
    // because subgraph boot order is not fixed.
    const llmDb = (await this.relationalDb.createNamespace("vetra-llm")) as unknown as Kysely<VetraLlmDB>;
    await ensureLlmTables(llmDb as Kysely<any>);
    const { broker } = createProcessBroker({
      db: llmDb,
      transit,
      secrets: secretsService,
      studio: studioAccess,
      env: process.env,
    });
    const claimDb = makeClaimDb(envDb);

    const perm = this.documentPermissionService;
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
      // Warm envs are protected for the Vetra service identity at creation:
      // nobody can sign on them (and auto-claim them) before the claim.
      protect: perm
        ? (documentId) => protectUnownedForService(perm, documentId, vetraServiceAddress())
        : undefined,
    };
    if (!perm) {
      console.warn("[studio-pool] no document permission service: warm envs are not protected");
    }

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
          hasStudioAccess: async (d) => (await studioLlmBudgetForDid(studioAccess, d)).allowed,
          grantLlmKey: async (environmentId, d) => {
            try {
              return await broker.ensureVetraKey({ environmentId, ownerDid: d });
            } catch (err) {
              // A deployment without OPENROUTER_MANAGEMENT_KEY still hands out Studios.
              if (isNotConfigured(err)) return null;
              throw err;
            }
          },
          releaseLlmKey: (environmentId) => broker.releaseVetraKey(environmentId),
          legacyAnthropicKey: (d) =>
            legacyKeyFor(cfg.legacyAnthropicKey, (x) => studioKeyForDid(studioAccess, x), d),
          setOwner: (documentId, address) =>
            reactor.execute(documentId, "main", [setOwner({ address })]),
          readEnv: async (documentId) => {
            const doc = await this.reactorClient.get(documentId);
            const state = (doc as { state?: { global?: VetraCloudEnvironmentState } }).state?.global;
            if (!state) return null;
            return { owner: state.owner ?? null, ownerOrgId: state.ownerOrgId ?? null, state };
          },
          storeLaunchSecretHash: (environmentId, secretHash) =>
            storeLaunchSecretHash(appsDb, environmentId, secretHash, new Date().toISOString()),
          // Managed keys (the launch secret) go through the replace's managed
          // entries: the plain entries refuse them, as the user paths do.
          replaceTenantConfig: (tenantId, state, entries) =>
            secretsService.replaceTenantConfig(
              tenantId,
              [
                ...tenantConfigEntries(state),
                ...entries
                  .filter((e) => !ROTATABLE_MANAGED_KEYS.has(e.key))
                  .map((e) => ({ key: e.key, value: e.value, secret: e.secret ?? true })),
              ],
              entries
                .filter((e) => ROTATABLE_MANAGED_KEYS.has(e.key))
                .map((e) => ({ key: e.key, value: e.value })),
            ),
          handOver: async (documentId, address) => {
            if (perm) await protectForOwner(perm, documentId, address);
          },
          deleteEnv,
          cfg: { version: cfg.version, renownUrl: cfg.renownUrl },
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
        void this.reconcileDeletedEnvironment(envDb, id, secretsService);
        // Its launch-secret hash goes with it.
        void appsDb
          .deleteFrom("studio_launch_secrets")
          .where("environment_id", "=", id)
          .execute()
          .catch((e: unknown) =>
            console.warn(`[studio-pool] launch-secret cleanup for deleted env ${id} failed: ${e instanceof Error ? e.name : "error"}`),
          );
        // A deleted Studio's key goes at once; the vetra-llm sweeper is the backstop.
        void broker
          .releaseVetraKey(id)
          .catch((e: unknown) =>
            console.warn(`[studio-pool] key release for deleted env ${id} failed: ${e instanceof Error ? e.name : "error"}`),
          );
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
            switchboardUrl: cfg.switchboardUrl,
            renownUrl: cfg.renownUrl,
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

    // Orphan-dir GC (self-healing net for non-atomic env deletes): periodically
    // remove marker-managed tenant dirs whose env doc is gone. Opt-in; guarded
    // by the ownership marker + the >50% circuit-breaker in gcOrphanTenantDirs,
    // so infra/app tenants and a failed live-set query can never nuke the fleet.
    if ((process.env.GITOPS_ORPHAN_GC_ENABLED ?? "false").toLowerCase() === "true") {
      const intervalMs = Number(process.env.GITOPS_ORPHAN_GC_INTERVAL_MS) || 600_000;
      const gcTick = async () => {
        try {
          const rows = await envDb
            .selectFrom("environments")
            .select(["id", "subdomain"])
            .where("subdomain", "is not", null)
            .execute();
          const live = new Set(
            rows
              .filter((r) => r.subdomain)
              .map((r) => getTenantId(r.subdomain as string, r.id)),
          );
          await gcOrphanTenantDirs(live);
        } catch (e) {
          console.warn(`[studio-pool] orphan-GC tick failed: ${String(e)}`);
        }
      };
      setTimeout(() => void gcTick(), 60_000);
      this.gcTimer = setInterval(() => void gcTick(), intervalMs);
      console.info(`[studio-pool] orphan-dir GC enabled (interval=${intervalMs}ms)`);
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
    secretsService: Pick<SecretsService, "purgeTenant">,
  ): Promise<void> {
    try {
      // The last environment on a tenant takes its env vars and secrets along.
      const removed = await removeEnvironmentRecord(envDb, id, {
        purgeTenant: (tenantId) => secretsService.purgeTenant(tenantId),
      });
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
    if (this.gcTimer) clearInterval(this.gcTimer);
    this.gcTimer = null;
  }
}
