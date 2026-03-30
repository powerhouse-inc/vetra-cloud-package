import { ServiceNotFoundError } from "../../gen/services/error.js";
import { markPendingIfDeployed } from "./utils.js";
import type { VetraCloudEnvironmentServicesOperations } from "document-models/vetra-cloud-environment/v1";

export const vetraCloudEnvironmentServicesOperations: VetraCloudEnvironmentServicesOperations =
  {
    enableServiceOperation(state, action) {
      const { type, prefix } = action.input;
      if (!state.services) {
        state.services = [];
      }
      const existing = state.services.find((s) => s.type === type);
      if (existing) {
        existing.enabled = true;
        existing.prefix = prefix;
      } else {
        state.services.push({
          type,
          prefix,
          enabled: true,
          url: null,
          status: "PROVISIONING",
          imageTag: null,
        });
      }
      markPendingIfDeployed(state);
    },
    disableServiceOperation(state, action) {
      const { type } = action.input;
      if (!state.services) {
        state.services = [];
      }
      const service = state.services.find((s) => s.type === type);
      if (service) {
        service.enabled = false;
        markPendingIfDeployed(state);
      }
    },
    toggleServiceOperation(state, action) {
      const service = state.services.find((s) => s.type === action.input.type);
      if (!service) {
        throw new ServiceNotFoundError(
          "Service " + action.input.type + " not found",
        );
      }
      service.enabled = !service.enabled;
      markPendingIfDeployed(state);
    },
    updateServicePrefixOperation(state, action) {
      const service = state.services.find((s) => s.type === action.input.type);
      if (!service) {
        throw new ServiceNotFoundError(
          "Service " + action.input.type + " not found",
        );
      }
      service.prefix = action.input.prefix;
      markPendingIfDeployed(state);
    },
    setServiceStatusOperation(state, action) {
      const service = state.services.find((s) => s.type === action.input.type);
      if (!service) {
        throw new ServiceNotFoundError(
          "Service " + action.input.type + " not found",
        );
      }
      service.status = action.input.status;
      if (action.input.url) {
        service.url = action.input.url;
      }
    },
  };
