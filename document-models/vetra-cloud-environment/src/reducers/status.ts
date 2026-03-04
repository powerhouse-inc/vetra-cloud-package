import type { VetraCloudEnvironmentStatusOperations } from "../../gen/status/operations.js";

export const reducer: VetraCloudEnvironmentStatusOperations = {
    startOperation(state, action, dispatch) {
        state.status = "STARTED";
    },
    stopOperation(state, action, dispatch) {
        state.status = "STOPPED";
    }
};
