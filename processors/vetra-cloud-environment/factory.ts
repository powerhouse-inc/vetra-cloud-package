import type { IProcessorHostModule, ProcessorRecord } from "@powerhousedao/reactor-browser";
import type { Kysely } from "kysely";
import type { PHDocumentHeader } from "document-model";
import { type DB } from "./schema.js";
import { VetraCloudEnvironmentProcessor } from "./index.js";
import { up } from "./migrations.js";
import { childLogger } from "document-drive";

const logger = childLogger(["vetra-cloud-environment-factory"]);

export const vetraCloudEnvironmentProcessorFactory =
  (module: IProcessorHostModule) =>
  async (driveHeader: PHDocumentHeader): Promise<ProcessorRecord[]> => {
    console.log(`[vetra-cloud-environment] Creating processor for drive ${driveHeader.id}`, JSON.stringify(driveHeader));
    logger.info(`Creating processor for drive ${driveHeader.id}`);

    const db = await module.relationalDb.createNamespace("vetra-cloud-environments") as unknown as Kysely<DB>;

    await up(db);

    const processor = new VetraCloudEnvironmentProcessor(db);

    console.log(`[vetra-cloud-environment] Processor created with filter:`, JSON.stringify({
      branch: ["main"],
      documentId: ["*"],
      documentType: ["powerhouse/vetra-cloud-environment"],
      scope: ["global"],
    }));

    return [
      {
        processor,
        filter: {
          branch: ["main"],
          documentId: ["*"],
          documentType: ["powerhouse/vetra-cloud-environment"],
          scope: ["global"],
        },
      },
    ];
  };
