import type { VetraCloudEnvironmentPackagesOperations } from "../../gen/packages/operations.js";

export const reducer: VetraCloudEnvironmentPackagesOperations = {
    addPackageOperation(state, action, dispatch) {
        const { packageName, version } = action.input;
        if (!state.packages) {
            state.packages = [];
        }
        if (packageName) {
            // is package already in state?
            if (state.packages.find((p) => p.name === packageName)) {
                // if version is same, do nothing
                if (state.packages.find((p) => p.name === packageName && p.version === version)) {
                    return;
                }

                // if version is different, update the version
                state.packages = state.packages.map((p) => p.name === packageName ? { ...p, version: version ?? "latest" } : p);
            } else {
                state.packages.push({ name: packageName, version: version ?? "latest" });
            }
        }
    },
    removePackageOperation(state, action, dispatch) {
        const { packageName } = action.input;
        if (!state.packages) {
            state.packages = [];
        }
        if (packageName) {
            state.packages = state.packages.filter((p) => p.name !== packageName);
        }
    }
};
