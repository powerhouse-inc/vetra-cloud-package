import { RelationalDbProcessorLegacy } from "document-drive/processors/relational";
import type { InternalTransmitterUpdate } from "document-drive/server/transmitter/types";
import { type VetraCloudEnvironmentState } from "../../document-models/vetra-cloud-environment/index.js";
import { up } from "./migrations.js";
import { syncEnvironment } from "./gitops.js";
import { type DB } from "./schema.js";
import { childLogger } from "document-drive";

const logger = childLogger(["vetra-cloud-environment-processor"]);

export class VetraCloudEnvironmentProcessor extends RelationalDbProcessorLegacy<DB> {
  static override getNamespace(driveId: string): string {
    // Default namespace: `${this.name}_${driveId.replaceAll("-", "_")}`
    logger.warn("Getting namespace for VetraCloudEnvironmentProcessor");
    return super.getNamespace(driveId);
  }

  override async initAndUpgrade(): Promise<void> {
    logger.warn("Initializing VetraCloudEnvironmentProcessor");
    await up(this.relationalDb);
  }

  override async onStrands(
    strands: InternalTransmitterUpdate[]
  ): Promise<void> {
    if (strands.length === 0) {
      return;
    }

    logger.info(`Received ${strands.length} strands`);

    for (const strand of strands) {
      if (strand.operations.length === 0) {
        continue;
      }

      const uncastState = strand.state as VetraCloudEnvironmentState;
      const { name, packages, services, status } = uncastState;

      const environment = await this.relationalDb
        .selectFrom("environments")
        .where("name", "=", name ?? "")
        .where("id", "=", strand.documentId)
        .executeTakeFirst();

      if (!environment) {
        await this.relationalDb
          .insertInto("environments")
          .values({
            name,
            id: strand.documentId,
            packages: JSON.stringify(packages),
            services: JSON.stringify(services),
            status: status,
          })
          .execute();
      } else {
        await this.relationalDb
          .updateTable("environments")
          .set({
            packages: JSON.stringify(packages),
            services: JSON.stringify(services),
            status: status,
          })
          .where("name", "=", name ?? "")
          .where("id", "=", strand.documentId)
          .execute();
      }

      await syncEnvironment(uncastState);
    }
  }

  async onDisconnect() {}
}
