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
      const LB_IP = "138.199.129.93";
      const domain = action.input.domain || null;
      const enabled = action.input.enabled;

      // Auto-generate DNS A records for each enabled service when domain is set
      const dnsRecords = enabled && domain
        ? (state.services ?? [])
            .filter((s) => s.enabled)
            .map((s) => ({
              type: "A",
              host: `${s.prefix}.${domain}`,
              value: LB_IP,
            }))
        : [];

      state.customDomain = { enabled, domain, dnsRecords };
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
