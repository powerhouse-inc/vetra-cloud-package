import { markPendingIfDeployed } from "./utils.js";
import type { VetraCloudEnvironmentDataManagementOperations } from "document-models/vetra-cloud-environment/v1";

export const vetraCloudEnvironmentDataManagementOperations: VetraCloudEnvironmentDataManagementOperations =
  {
    setLabelOperation(state, action) {
      if (action.input.label) {
        state.label = action.input.label;
        markPendingIfDeployed(state);
      }
    },
    setGenericSubdomainOperation(state, action) {
      if (action.input.genericSubdomain) {
        state.genericSubdomain = action.input.genericSubdomain;
        markPendingIfDeployed(state);
      }
    },
    setCustomDomainOperation(state, action) {
      const LB_IP = "138.199.129.93";
      const domain = action.input.domain || null;
      const enabled = action.input.enabled;

      // Auto-generate DNS A records for each enabled service when domain is set
      const dnsRecords =
        enabled && domain
          ? (state.services ?? [])
              .filter((s) => s.enabled)
              .map((s) => ({
                type: "A",
                host: `${s.prefix}.${domain}`,
                value: LB_IP,
              }))
          : [];

      state.customDomain = { enabled, domain, dnsRecords };
      markPendingIfDeployed(state);
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
    setDefaultPackageRegistryOperation(state, action) {
      state.defaultPackageRegistry = action.input.defaultPackageRegistry;
    },
  };
