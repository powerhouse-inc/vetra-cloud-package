import type { VetraCloudEnvironmentServicesOperations } from "../../gen/services/operations.js";

export const reducer: VetraCloudEnvironmentServicesOperations = {
    enableServiceOperation(state, action, dispatch) {
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
    disableServiceOperation(state, action, dispatch) {
        const { serviceName } = action.input;
        if (!state.services) {
            state.services = [];
        }
        if (serviceName) {
            state.services = state.services.filter((s) => s !== serviceName);
        }
    }
};
