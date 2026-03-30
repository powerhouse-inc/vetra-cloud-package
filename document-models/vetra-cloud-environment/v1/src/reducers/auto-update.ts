import { ServiceNotFoundError } from "../../gen/auto-update/error.js";
import { markPendingIfDeployed } from "./utils.js";
import type { VetraCloudEnvironmentAutoUpdateOperations } from "document-models/vetra-cloud-environment/v1";

export const vetraCloudEnvironmentAutoUpdateOperations: VetraCloudEnvironmentAutoUpdateOperations =
  {
    toggleAutoUpdateOperation(state, action) {
      state.autoUpdate = action.input.enabled;
      markPendingIfDeployed(state);
    },
    setAutoUpdateChannelOperation(state, action) {
      state.autoUpdateChannel = action.input.channel;
      markPendingIfDeployed(state);
    },
    setImageTagOperation(state, action) {
      const service = state.services.find(
        (s) => s.type === action.input.serviceType,
      );
      if (!service) {
        throw new ServiceNotFoundError(
          "Service " + action.input.serviceType + " not found",
        );
      }
      service.imageTag = action.input.tag;
      markPendingIfDeployed(state);
    },
  };
