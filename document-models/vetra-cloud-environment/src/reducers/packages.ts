import type { VetraCloudEnvironmentPackagesOperations } from "vetra-cloud-package/document-models/vetra-cloud-environment";

export const vetraCloudEnvironmentPackagesOperations: VetraCloudEnvironmentPackagesOperations =
  {
    addPackageOperation(state, action) {
      const { packageName, version } = action.input;
      if (!state.packages) {
        state.packages = [];
      }
      if (packageName) {
        if (state.packages.find((p) => p.name === packageName)) {
          if (
            state.packages.find(
              (p) => p.name === packageName && p.version === version,
            )
          ) {
            return;
          }
          state.packages = state.packages.map((p) =>
            p.name === packageName ? { ...p, version: version ?? "latest" } : p,
          );
        } else {
          state.packages.push({
            name: packageName,
            version: version ?? "latest",
          });
        }
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
