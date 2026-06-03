import type { IProcessorHostModule, ProcessorRecord } from "@powerhousedao/reactor-browser";
import type { IDocumentView } from "@powerhousedao/reactor";
import type { Kysely } from "kysely";
import type { PHDocumentHeader } from "document-model";
import { type DB } from "./schema.js";
import { VetraCloudEnvironmentProcessor } from "./index.js";
import { up } from "./migrations.js";
import { childLogger } from "document-model";
import type { SecretsDB } from "../../subgraphs/vetra-cloud-secrets/db/schema.js";
import { up as upSecrets } from "../../subgraphs/vetra-cloud-secrets/db/migrations.js";
import { OpenBaoTransitClient } from "../../subgraphs/vetra-cloud-secrets/openbao-transit.js";
import {
  createSecretsService,
  type SecretsService,
} from "../../subgraphs/vetra-cloud-secrets/services/secrets-service.js";

const logger = childLogger(["vetra-cloud-environment-factory"]);

const DEFAULT_TRANSIT_ROLE = "vetra-secrets";

/**
 * Wire a SecretsService for the processor. Returns null when OPENBAO_ADDR
 * is unset (test mode, local dev without OpenBao) — the processor will
 * keep emitting env vars inline in values.yaml in that case, same as
 * before the refactor. In production OPENBAO_ADDR is required.
 */
async function createSecretsServiceForProcessor(
  module: IProcessorHostModule,
): Promise<SecretsService | null> {
  const openbaoAddr = process.env.OPENBAO_ADDR;
  if (!openbaoAddr) {
    logger.warn(
      "[secrets] OPENBAO_ADDR is not set — env entries will be emitted inline " +
        "in values.yaml. Set OPENBAO_ADDR to route secrets through the " +
        "encrypted vetra-secrets-controller path.",
    );
    return null;
  }

  const secretsDb = (await module.relationalDb.createNamespace(
    "vetra-cloud-secrets",
  )) as unknown as Kysely<SecretsDB>;
  // Defensive: ensure tables exist. Idempotent — the subgraph runs the
  // same migrations on its own startup; whichever loads first wins.
  await upSecrets(secretsDb as Kysely<any>);

  const transit = new OpenBaoTransitClient({
    addr: openbaoAddr,
    role: process.env.OPENBAO_TRANSIT_ROLE ?? DEFAULT_TRANSIT_ROLE,
    keyNamePrefix: process.env.OPENBAO_TRANSIT_KEY_PREFIX,
  });

  return createSecretsService({ db: secretsDb, transit });
}

export const vetraCloudEnvironmentProcessorFactory =
  (module: IProcessorHostModule) =>
  async (driveHeader: PHDocumentHeader): Promise<ProcessorRecord[]> => {
    logger.info(`Creating processor for drive ${driveHeader.id}`);

    const db = await module.relationalDb.createNamespace("vetra-cloud-environments") as unknown as Kysely<DB>;

    await up(db);

    const documentView = module.getReadModel<IDocumentView>("document-view");
    const secretsService = await createSecretsServiceForProcessor(module);
    const processor = new VetraCloudEnvironmentProcessor(
      db,
      module.dispatch,
      documentView,
      secretsService,
    );

    return [
      {
        processor,
        filter: {
          branch: ["main"],
          documentId: ["*"],
          documentType: ["powerhouse/vetra-cloud-environment", "powerhouse/document-drive"],
          scope: ["global"],
        },
      },
    ];
  };
