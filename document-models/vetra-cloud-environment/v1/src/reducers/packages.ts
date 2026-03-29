import { markPendingIfDeployed } from "./utils.js";
import type { VetraCloudEnvironmentPackagesOperations } from "document-models/vetra-cloud-environment/v1";

export const vetraCloudEnvironmentPackagesOperations: VetraCloudEnvironmentPackagesOperations =
  {
    addPackageOperation(state, action) {
      const { packageName, version, registry } = action.input;
      if (!state.packages) {
        state.packages = [];
      }
      const resolvedVersion = version ?? "latest";
      const resolvedRegistry = registry || state.defaultPackageRegistry || "";
      const existing = state.packages.find((p) => p.name === packageName);
      if (existing) {
        existing.version = resolvedVersion;
        if (registry) existing.registry = resolvedRegistry;
      } else {
        state.packages.push({
          registry: resolvedRegistry,
          name: packageName,
          version: resolvedVersion,
        });
      }
      markPendingIfDeployed(state);
    },
    removePackageOperation(state, action) {
      const { packageName } = action.input;
      if (!state.packages) {
        state.packages = [];
      }
      if (packageName) {
        state.packages = state.packages.filter((p) => p.name !== packageName);
        markPendingIfDeployed(state);
      }
    },
  };
