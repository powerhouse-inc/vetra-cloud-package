import type { VetraCloudEnvironmentServicesOperations } from "document-models/vetra-cloud-environment/v1";
import {
  ClintConfigRequiredError,
  NotClintServiceError,
  PrefixInUseError,
  ServiceNotFoundError,
} from "../../gen/services/error.js";
import {
  assertOwner,
  markPendingIfDeployed,
  regenerateDnsRecords,
} from "./utils.js";

export const vetraCloudEnvironmentServicesOperations: VetraCloudEnvironmentServicesOperations =
  {
    enableServiceOperation(state, action) {
      assertOwner(state, action);
      const { type, prefix, clintConfig } = action.input;
      if (type === "CLINT" && !clintConfig) {
        throw new ClintConfigRequiredError(
          "clintConfig is required when enabling a CLINT service",
        );
      }
      if (!state.services) {
        state.services = [];
      }
      const collision = state.services.find(
        (s) => s.prefix === prefix && s.type !== type,
      );
      if (collision) {
        throw new PrefixInUseError(
          `prefix '${prefix}' is already used by service ${collision.type}`,
        );
      }
      const config =
        type === "CLINT" && clintConfig
          ? {
              package: {
                registry: clintConfig.package.registry,
                name: clintConfig.package.name,
                version: clintConfig.package.version ?? null,
              },
              env: clintConfig.env ?? [],
              serviceCommand: clintConfig.serviceCommand ?? null,
              selectedRessource: clintConfig.selectedRessource ?? null,
            }
          : null;
      // CLINT supports multiple entries per env, distinguished by prefix.
      // Other service types are singletons keyed by type alone — a re-enable
      // with a different prefix updates the existing entry.
      const existing =
        type === "CLINT"
          ? state.services.find((s) => s.type === type && s.prefix === prefix)
          : state.services.find((s) => s.type === type);
      if (existing) {
        existing.enabled = true;
        existing.prefix = prefix;
        if (config) existing.config = config;
        if (action.input.selectedRessource) {
          existing.selectedRessource = action.input.selectedRessource;
        }
      } else {
        state.services.push({
          type,
          prefix,
          enabled: true,
          url: null,
          status: "PROVISIONING",
          version: null,
          config,
          selectedRessource: action.input.selectedRessource ?? "VETRA_AGENT_S",
        });
      }
      regenerateDnsRecords(state);
      markPendingIfDeployed(state);
    },
    disableServiceOperation(state, action) {
      assertOwner(state, action);
      const { type, prefix } = action.input;
      if (!state.services) {
        state.services = [];
      }
      // CLINT supports multiple services per env keyed by prefix; without
      // a prefix the lookup would silently disable whichever clint
      // happens to come first (a real bug for multi-agent envs). When a
      // prefix is provided we filter by both. For singleton service types
      // (CONNECT/SWITCHBOARD/FUSION) prefix is optional and ignored.
      const service =
        type === "CLINT" && prefix
          ? state.services.find((s) => s.type === type && s.prefix === prefix)
          : state.services.find((s) => s.type === type);
      if (service) {
        service.enabled = false;
        regenerateDnsRecords(state);
        markPendingIfDeployed(state);
      }
    },
    toggleServiceOperation(state, action) {
      assertOwner(state, action);
      const service = state.services.find((s) => s.type === action.input.type);
      if (!service) {
        throw new ServiceNotFoundError(
          "Service " + action.input.type + " not found",
        );
      }
      service.enabled = !service.enabled;
      regenerateDnsRecords(state);
      markPendingIfDeployed(state);
    },
    updateServicePrefixOperation(state, action) {
      assertOwner(state, action);
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
      assertOwner(state, action);
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
    setServiceVersionOperation(state, action) {
      assertOwner(state, action);
      const service = state.services.find((s) => s.type === action.input.type);
      if (!service) {
        throw new ServiceNotFoundError(
          "Service " + action.input.type + " not found",
        );
      }
      service.version = action.input.version;
      markPendingIfDeployed(state);
    },
    setServiceConfigOperation(state, action) {
      const { prefix, config } = action.input;
      if (!state.services) {
        state.services = [];
      }
      const service = state.services.find((s) => s.prefix === prefix);
      if (!service) {
        throw new ServiceNotFoundError(`No service with prefix '${prefix}'`);
      }
      if (service.type !== "CLINT") {
        throw new NotClintServiceError(
          `Service '${prefix}' is type ${service.type}; only CLINT services accept config`,
        );
      }
      service.config = {
        package: {
          registry: config.package.registry,
          name: config.package.name,
          version: config.package.version ?? null,
        },
        env: config.env ?? [],
        serviceCommand: config.serviceCommand ?? null,
        selectedRessource: config.selectedRessource ?? null,
      };
      if (config.selectedRessource) {
        service.selectedRessource = config.selectedRessource;
      }
      state.status = "CHANGES_PENDING";
    },
    setServiceSizeOperation(state, action) {
      assertOwner(state, action);
      if (!state.services) {
        state.services = [];
      }
      const service = state.services.find(
        (s) => s.prefix === action.input.prefix,
      );
      if (!service) {
        throw new ServiceNotFoundError(
          `No service with prefix '${action.input.prefix}'`,
        );
      }
      service.selectedRessource = action.input.size;
      if (service.type === "CLINT" && service.config) {
        service.config.selectedRessource = action.input.size;
      }
      markPendingIfDeployed(state);
    },
  };
