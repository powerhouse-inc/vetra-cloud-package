import type { VetraCloudEnvironmentDataManagementOperations } from "@powerhousedao/vetra-cloud-package/document-models/vetra-cloud-environment";

export const vetraCloudEnvironmentDataManagementOperations: VetraCloudEnvironmentDataManagementOperations =
  {
    setEnvironmentNameOperation(state, action) {
      const { name } = action.input;
      if (name) {
        state.name = name;
      }
    },
    setSubdomainOperation(state, action) {
      if (state.subdomain) return;
      const { subdomain } = action.input;
      if (subdomain) {
        state.subdomain = subdomain;
      }
    },
    setCustomDomainOperation(state, action) {
      state.customDomain = action.input.customDomain || null;
    },
  };
