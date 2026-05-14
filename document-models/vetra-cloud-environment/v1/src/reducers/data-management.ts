import type { VetraCloudEnvironmentDataManagementOperations } from "document-models/vetra-cloud-environment/v1";
import {
  NotOwnerError,
  OwnerDriveMismatchError,
  SelfClaimRequiredError,
  ServiceNotEnabledError,
} from "../../gen/data-management/error.js";
import {
  assertOwner,
  backfillOwnerDriveIfMissing,
  markPendingIfDeployed,
  regenerateDnsRecords,
} from "./utils.js";

export const vetraCloudEnvironmentDataManagementOperations: VetraCloudEnvironmentDataManagementOperations =
  {
    setOwnerOperation(state, action) {
      backfillOwnerDriveIfMissing(state);
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
    setOwnerDriveOperation(state, action) {
      backfillOwnerDriveIfMissing(state);
      if (state.ownerDrive && state.ownerDrive !== action.input.ownerDrive) {
        const driveEth = state.ownerDrive.startsWith("user:")
          ? state.ownerDrive.slice("user:".length)
          : null;
        const userAddr = action.context?.signer?.user?.address?.toLowerCase();
        if (!driveEth || !userAddr || driveEth.toLowerCase() !== userAddr) {
          throw new OwnerDriveMismatchError(
            `Cannot reassign ownerDrive from ${state.ownerDrive} to ${action.input.ownerDrive}`,
          );
        }
      }
      state.ownerDrive = action.input.ownerDrive;
    },
    setLabelOperation(state, action) {
      backfillOwnerDriveIfMissing(state);
      assertOwner(state, action);
      if (action.input.label) {
        state.label = action.input.label;
        markPendingIfDeployed(state);
      }
    },
    setGenericSubdomainOperation(state, action) {
      backfillOwnerDriveIfMissing(state);
      assertOwner(state, action);
      if (action.input.genericSubdomain) {
        state.genericSubdomain = action.input.genericSubdomain;
        markPendingIfDeployed(state);
      }
    },
    setCustomDomainOperation(state, action) {
      backfillOwnerDriveIfMissing(state);
      assertOwner(state, action);
      const domain = action.input.domain || null;
      const enabled = action.input.enabled;

      state.customDomain = { enabled, domain, dnsRecords: [] };
      regenerateDnsRecords(state);
      markPendingIfDeployed(state);
    },
    setDnsRecordsOperation(state, action) {
      backfillOwnerDriveIfMissing(state);
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
      backfillOwnerDriveIfMissing(state);
      assertOwner(state, action);
      state.defaultPackageRegistry = action.input.defaultPackageRegistry;
    },
    setApexServiceOperation(state, action) {
      backfillOwnerDriveIfMissing(state);
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
      backfillOwnerDriveIfMissing(state);
      assertOwner(state, action);
      state.autoUpdateChannel = action.input.channel ?? null;
      // Channel change doesn't affect rendered chart values, so no
      // markPendingIfDeployed — no gitops sync is required.
    },
  };
