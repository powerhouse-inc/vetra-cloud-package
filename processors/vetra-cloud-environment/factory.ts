import type {
  IProcessorHostModule,
  ProcessorRecord,
  RelationalDbProcessorFilter,
} from "document-drive/processors/types";
import type { PHDocumentHeader } from "document-model";
import { VetraCloudEnvironmentProcessor } from "./index.js";

export const vetraCloudEnvironmentProcessorFactory =
  (module: IProcessorHostModule) =>
  async (driveHeader: PHDocumentHeader): Promise<ProcessorRecord[]> => {
    // Create a namespace for the processor and the provided drive id
    const namespace = VetraCloudEnvironmentProcessor.getNamespace(
      driveHeader.id
    );

    // Create a namespaced db for the processor
    const store =
      await module.relationalDb.createNamespace<VetraCloudEnvironmentProcessor>(
        namespace
      );

    // Create a filter for the processor
    const filter: RelationalDbProcessorFilter = {
      branch: ["main"],
      documentId: ["*"],
      documentType: ["powerhouse/vetra-cloud-environment"],
      scope: ["global"],
    };

    console.log("filter", filter);

    // Create the processor
    const processor = new VetraCloudEnvironmentProcessor(
      namespace,
      filter,
      store
    );
    await processor.initAndUpgrade();
    return [
      {
        processor,
        filter,
      },
    ];
  };
