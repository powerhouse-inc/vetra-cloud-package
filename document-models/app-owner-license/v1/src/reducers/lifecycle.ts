import type { AppOwnerLicenseLifecycleOperations } from "document-models/app-owner-license/v1";
import {
  AlreadyIssuedError,
  EndBeforeStartError,
  InvalidStatusTransitionError,
} from "../../gen/lifecycle/error.js";

export const appOwnerLicenseLifecycleOperations: AppOwnerLicenseLifecycleOperations =
  {
    issueLicenseOperation(state, action) {
      if (state.user) {
        throw new AlreadyIssuedError("this license is already issued");
      }
      if (action.input.end && action.input.end < action.input.start) {
        throw new EndBeforeStartError("end must not precede start");
      }
      state.app = action.input.app;
      state.licenseType = action.input.licenseType;
      state.user = action.input.user.toLowerCase();
      state.issuer = action.input.issuer;
      state.issuedBy = action.input.issuedBy.toLowerCase();
      state.stage = action.input.stage ?? null;
      state.details = action.input.details ?? null;
      state.issued = action.input.issued;
      state.start = action.input.start;
      state.end = action.input.end ?? null;
      state.status = "ISSUED";
    },
    activateLicenseOperation(state) {
      if (state.status !== "ISSUED") {
        throw new InvalidStatusTransitionError(
          `cannot activate a license with status ${state.status}`,
        );
      }
      state.status = "ACTIVE";
    },
    expireLicenseOperation(state) {
      if (state.status !== "ISSUED" && state.status !== "ACTIVE") {
        throw new InvalidStatusTransitionError(
          `cannot expire a license with status ${state.status}`,
        );
      }
      state.status = "EXPIRED";
    },
    revokeLicenseOperation(state, action) {
      if (state.status !== "ISSUED" && state.status !== "ACTIVE") {
        throw new InvalidStatusTransitionError(
          `cannot revoke a license with status ${state.status}`,
        );
      }
      state.status = "REVOKED";
      state.revokedReason = action.input.reason ?? null;
    },
    replaceLicenseOperation(state, action) {
      if (state.status !== "ACTIVE") {
        throw new InvalidStatusTransitionError(
          `cannot replace a license with status ${state.status}`,
        );
      }
      state.status = "REPLACED";
      state.replacedBy = action.input.replacedBy;
    },
  };
