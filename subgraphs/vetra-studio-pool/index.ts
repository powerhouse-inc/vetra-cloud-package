import { BaseSubgraph } from "@powerhousedao/reactor-api";
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
import {
  setOwner,
  terminateEnvironment,
} from "../../document-models/vetra-cloud-environment/v1/gen/creators.js";
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
          setSecret: (tenantId, key, value) =>
            secretsService.setSecret(tenantId, key, value).then(() => undefined),
          terminate: (documentId) =>
            reactor.execute(documentId, "main", [terminateEnvironment({})]),
          cfg: { version: cfg.version },
          nowIso: () => new Date().toISOString(),
          logger: console,
        },
        did,
      );

    this.resolvers = createResolvers({ claim });

    if (cfg.enabled) {
      this.keeper = new PoolKeeper({
        db: makeKeeperDb(envDb),
        createEnv: () =>
          createStudioEnvironmentDoc(reactor, {
            version: cfg.version,
            sizeName: cfg.sizeName,
            registry: cfg.registry,
          }),
        terminate: (documentId) =>
          reactor.execute(documentId, "main", [terminateEnvironment({})]),
        cfg,
        logger: console,
      });
      this.keeper.start();
      console.info(
        `[studio-pool] keeper started (size=${cfg.size}, version=${cfg.version})`,
      );
    }
  }

  async onDisconnect() {
    this.keeper?.stop();
    this.keeper = null;
  }
}
