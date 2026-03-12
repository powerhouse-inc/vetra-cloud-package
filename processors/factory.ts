import type {
  IProcessorHostModule,
  ProcessorRecord,
} from "@powerhousedao/reactor-browser";
import type { PHDocumentHeader } from "document-model";
import { vetraCloudEnvironmentProcessorFactory } from "./vetra-cloud-environment/factory.js";

export const processorFactory = (module: IProcessorHostModule) => {
  console.log("[vetra-cloud-environment] processorFactory called, module keys:", Object.keys(module));
  const factory = vetraCloudEnvironmentProcessorFactory(module);

  const wrappedFactory = async (driveHeader: PHDocumentHeader): Promise<ProcessorRecord[]> => {
    console.log("[vetra-cloud-environment] wrappedFactory called for drive:", driveHeader.id);
    const result = await factory(driveHeader);
    console.log("[vetra-cloud-environment] wrappedFactory returning", result.length, "processor records");
    return result;
  };

  return wrappedFactory;
};
