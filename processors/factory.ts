import type {
  IProcessorHostModule,
  ProcessorRecord,
} from "@powerhousedao/reactor-browser";
import type { PHDocumentHeader } from "document-model";
import { vetraCloudEnvironmentProcessorFactory } from "./vetra-cloud-environment/factory.js";

export const processorFactory = (module: IProcessorHostModule) => {
  console.log("[vetra-cloud-environment] processorFactory initialized");
  const factory = vetraCloudEnvironmentProcessorFactory(module);

  return async (driveHeader: PHDocumentHeader): Promise<ProcessorRecord[]> => {
    return factory(driveHeader);
  };
};
