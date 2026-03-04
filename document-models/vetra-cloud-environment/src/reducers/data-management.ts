import type { VetraCloudEnvironmentDataManagementOperations } from "../../gen/data-management/operations.js";

export const reducer: VetraCloudEnvironmentDataManagementOperations = {
    setEnvironmentNameOperation(state, action, dispatch) {
        const { name } = action.input;
        if (name) {
            state.name = name;
        }
    }
};
