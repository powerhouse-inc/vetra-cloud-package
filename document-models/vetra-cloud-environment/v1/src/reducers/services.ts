import type { VetraCloudEnvironmentServicesOperations } from "vetra-cloud-package/document-models/vetra-cloud-environment/v1";

export const vetraCloudEnvironmentServicesOperations: VetraCloudEnvironmentServicesOperations =
  {
    enableServiceOperation(state, action) {
      const { serviceName } = action.input;
      if (!state.services) {
        state.services = [];
      }
      if (serviceName) {
        if (state.services.find((s) => s === serviceName)) {
          return;
        }
        state.services.push(serviceName);
      }
    },
    disableServiceOperation(state, action) {
      const { serviceName } = action.input;
      if (!state.services) {
        state.services = [];
      }
      if (serviceName) {
        state.services = state.services.filter((s) => s !== serviceName);
      }
    },
  };
