import type {
  IProcessorHostModule,
  ProcessorRecord,
  ProcessorFactory,
} from "@powerhousedao/reactor-browser";
import type { PHDocumentHeader } from "document-model";

export const processorFactory = async (module: IProcessorHostModule) => {
  const factories: ProcessorFactory[] = [];

  if (module.processorApp === "connect") {
    await addConnectProcessorFactories(factories, module);
  }

  if (module.processorApp === "switchboard") {
    await addSwitchboardProcessorFactories(factories, module);
  }

  return async (driveHeader: PHDocumentHeader): Promise<ProcessorRecord[]> => {
    const processors: ProcessorRecord[] = [];

    for (const factory of factories) {
      const factoryProcessors = await factory(driveHeader, module.processorApp);
      processors.push(...factoryProcessors);
    }

    return processors;
  };
};

async function addConnectProcessorFactories(factories: ProcessorFactory[], module: IProcessorHostModule) {
  const connectProcessorFactories: ProcessorFactory[] = [];

  for (const factory of connectProcessorFactories) {
    factories.push(factory);
  }
}

async function addSwitchboardProcessorFactories(factories: ProcessorFactory[], module: IProcessorHostModule) {
  const { vetraCloudEnvironmentProcessorFactory } = await import("./vetra-cloud-environment/factory.js");
  const switchboardProcessorFactories: ProcessorFactory[] = [
    vetraCloudEnvironmentProcessorFactory(module),
  ];

  for (const factory of switchboardProcessorFactories) {
    factories.push(factory);
  }
}
