import type {
  IProcessorHostModule,
  ProcessorRecord,
} from "@powerhousedao/reactor-browser";
import type { PHDocumentHeader } from "document-model";
import { vetraCloudEnvironmentProcessorFactory } from "./vetra-cloud-environment/factory.js";

export const processorFactory = (module: IProcessorHostModule) => {
  return vetraCloudEnvironmentProcessorFactory(module);
};
