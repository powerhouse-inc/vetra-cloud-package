import type { VetraCloudEnvironmentPackagesOperations } from "@powerhousedao/vetra-cloud-package/document-models/vetra-cloud-environment";

export const vetraCloudEnvironmentPackagesOperations: VetraCloudEnvironmentPackagesOperations =
  {
    addPackageOperation(state, action) {
      const { packageName, version } = action.input;
      if (!state.packages) {
        state.packages = [];
      }
      const resolvedVersion = version ?? "latest";
      const existing = state.packages.find((p) => p.name === packageName);
      if (existing) {
        if (existing.version === resolvedVersion) return;
        existing.version = resolvedVersion;
      } else {
        state.packages.push({ name: packageName, version: resolvedVersion });
      }
    },
    removePackageOperation(state, action) {
      const { packageName } = action.input;
      if (!state.packages) {
        state.packages = [];
      }
      if (packageName) {
        state.packages = state.packages.filter((p) => p.name !== packageName);
      }
    },
  };
