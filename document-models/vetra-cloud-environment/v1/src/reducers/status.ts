import type { VetraCloudEnvironmentStatusOperations } from "@powerhousedao/vetra-cloud-package/document-models/vetra-cloud-environment/v1";

export const vetraCloudEnvironmentStatusOperations: VetraCloudEnvironmentStatusOperations =
  {
    startOperation(state) {
      state.status = "STARTED";
    },
    stopOperation(state) {
      state.status = "STOPPED";
    },
  };
