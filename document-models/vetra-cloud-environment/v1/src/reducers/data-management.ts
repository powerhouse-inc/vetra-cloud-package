import type { VetraCloudEnvironmentDataManagementOperations } from "document-models/vetra-cloud-environment/v1";
import {
  InvalidRuntimeConfigError,
  NotOwnerError,
  SelfClaimRequiredError,
  ServiceNotEnabledError,
} from "../../gen/data-management/error.js";
import { validateRuntimeConfig } from "./runtime-config-validation.js";
import {
  assertOwner,
  markPendingIfDeployed,
  regenerateDnsRecords,
} from "./utils.js";

export const vetraCloudEnvironmentDataManagementOperations: VetraCloudEnvironmentDataManagementOperations =
  {
    setOwnerOperation(state, action) {
      const userAddr =
        action.context?.signer?.user?.address?.toLowerCase() ?? null;
      const inputAddr = action.input.address.toLowerCase();

      if (state.owner) {
        if (!userAddr || userAddr !== state.owner) {
          throw new NotOwnerError(
            "Only the current owner can transfer ownership",
          );
        }
      } else if (userAddr && userAddr !== inputAddr) {
        // User-signed claim of an unowned env must set the signer's own address.
        // System-signed claims (no user in signer) may set any address — this
        // is how the backfill assigns owner for historical envs.
        throw new SelfClaimRequiredError(
          "A user-signed claim must set the signer's own address as owner",
        );
      }

      state.owner = inputAddr;
    },
    setLabelOperation(state, action) {
      assertOwner(state, action);
      if (action.input.label) {
        state.label = action.input.label;
        markPendingIfDeployed(state);
      }
    },
    setGenericSubdomainOperation(state, action) {
      assertOwner(state, action);
      if (action.input.genericSubdomain) {
        state.genericSubdomain = action.input.genericSubdomain;
        markPendingIfDeployed(state);
      }
    },
    setCustomDomainOperation(state, action) {
      assertOwner(state, action);
      const domain = action.input.domain || null;
      const enabled = action.input.enabled;

      state.customDomain = { enabled, domain, dnsRecords: [] };
      regenerateDnsRecords(state);
      markPendingIfDeployed(state);
    },
    setDnsRecordsOperation(state, action) {
      assertOwner(state, action);
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
      assertOwner(state, action);
      state.defaultPackageRegistry = action.input.defaultPackageRegistry;
    },
    setApexServiceOperation(state, action) {
      assertOwner(state, action);
      const type = action.input.type ?? null;
      if (type) {
        const svc = state.services.find((s) => s.type === type);
        if (!svc || !svc.enabled) {
          throw new ServiceNotEnabledError(
            `${type} is not enabled — enable it before pinning to apex`,
          );
        }
      }
      state.apexService = type;
      markPendingIfDeployed(state);
    },
    setAutoUpdateChannelOperation(state, action) {
      assertOwner(state, action);
      state.autoUpdateChannel = action.input.channel ?? null;
      // Channel change doesn't affect rendered chart values, so no
      // markPendingIfDeployed — no gitops sync is required.
    },
    setRuntimeConfigOperation(state, action) {
      assertOwner(state, action);
      // Stored as a JSON String (not Unknown) so the field composes in the
      // federated supergraph. `config` is the JSON-stringified operator-editable
      // powerhouse.config.json partial ({ connect, packageRegistryUrl }).
      const raw = action.input.config ?? null;

      // null / empty string / "{}" means "clear all overrides, fall back to the
      // bundled defaults applied at the Connect entrypoint".
      if (raw === null || raw.trim() === "" || raw.trim() === "{}") {
        state.runtimeConfig = null;
        // Clearing overrides changes the rendered values.yaml, so a deployed
        // env must go through approve → deploy again.
        markPendingIfDeployed(state);
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new InvalidRuntimeConfigError(
          "Runtime config must be a valid JSON string",
        );
      }

      const result = validateRuntimeConfig(parsed);
      if (!result.ok) {
        throw new InvalidRuntimeConfigError(
          `Invalid runtime config: ${result.issues
            .map((i) => `${i.path}: ${i.message}`)
            .join("; ")}`,
        );
      }

      // Runtime config is part of the declarative tenant spec: it is rendered
      // into tenants/<name>/powerhouse-values.yaml (connect.env.PH_CONNECT_CONFIG_JSON)
      // by the processor on CHANGES_APPROVED, then deployed via ArgoCD. So a
      // change moves a deployed env to CHANGES_PENDING, same as service/env edits.
      // Store the JSON string verbatim (the parsed value was validated above).
      state.runtimeConfig = raw;
      markPendingIfDeployed(state);
    },
    setStudioInstanceOperation(state, action) {
      assertOwner(state, action);
      // Pure metadata linking this env to the studio that produced it. Renders
      // nothing into the chart/gitops values, so no markPendingIfDeployed.
      state.studioInstanceId = action.input.studioInstanceId ?? null;
    },
  };
