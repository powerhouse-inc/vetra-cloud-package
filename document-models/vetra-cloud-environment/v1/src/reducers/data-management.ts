import type { VetraCloudEnvironmentDataManagementOperations } from "document-models/vetra-cloud-environment/v1";

export const vetraCloudEnvironmentDataManagementOperations: VetraCloudEnvironmentDataManagementOperations =
  {
    setLabelOperation(state, action) {
      if (action.input.label) {
        state.label = action.input.label;
        state.status = "CHANGES_PENDING";
      }
    },
    setGenericSubdomainOperation(state, action) {
      if (action.input.genericSubdomain) {
        state.genericSubdomain = action.input.genericSubdomain;
        state.status = "CHANGES_PENDING";
      }
    },
    setCustomDomainOperation(state, action) {
      state.customDomain = {
        enabled: action.input.enabled,
        domain: action.input.domain || null,
        dnsRecords: state.customDomain?.dnsRecords || [],
      };
      state.status = "CHANGES_PENDING";
    },
    setDnsRecordsOperation(state, action) {
      if (!state.customDomain) {
        state.customDomain = { enabled: false, domain: null, dnsRecords: [] };
      }
      state.customDomain.dnsRecords = action.input.records.map((r) => ({
        type: r.type,
        host: r.host,
        value: r.value,
      }));
    },
  };
