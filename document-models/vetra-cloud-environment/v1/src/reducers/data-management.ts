import type { VetraCloudEnvironmentDataManagementOperations } from "vetra-cloud-package/document-models/vetra-cloud-environment/v1";

export const vetraCloudEnvironmentDataManagementOperations: VetraCloudEnvironmentDataManagementOperations =
  {
    setEnvironmentNameOperation(state, action) {
      const { name } = action.input;
      if (name) {
        state.name = name;
      }
    },
  };
