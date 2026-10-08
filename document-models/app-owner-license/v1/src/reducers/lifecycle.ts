import type { AppOwnerLicenseLifecycleOperations } from "document-models/app-owner-license/v1";
import {
  AlreadyIssuedError,
  AlreadyMigratedError,
  EndBeforeStartError,
  InvalidStatusTransitionError,
  MissingKindError,
  NotIssuedError,
} from "../../gen/lifecycle/error.js";

export const appOwnerLicenseLifecycleOperations: AppOwnerLicenseLifecycleOperations =
  {
    issueLicenseOperation(state, action) {
      if (state.user) {
        throw new AlreadyIssuedError("this license is already issued");
      }
      if (!action.input.kind && !action.input.licenseType) {
        throw new MissingKindError("a licence needs a kind");
      }
      if (action.input.end && action.input.end < action.input.start) {
        throw new EndBeforeStartError("end must not precede start");
      }
      state.app = action.input.app;
      state.user = action.input.user.toLowerCase();
      state.issuer = action.input.issuer;
      state.kind = action.input.kind ?? null;
      state.stage = action.input.stage ?? null;
      // A pre-terms ISSUE_LICENSE (replayed from history) carries licenseType
      // and issuedBy; both survive in details so MIGRATE_LICENSE can map them.
      state.details =
        action.input.details ??
        (action.input.licenseType
          ? JSON.stringify({
              legacyLicenseType: action.input.licenseType,
              issuedBy: action.input.issuedBy ?? null,
            })
          : null);
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
    setStageOperation(state, action) {
      if (!state.user) {
        throw new NotIssuedError("this license has not been issued");
      }
      state.stage = action.input.stage ?? null;
    },
    migrateLicenseOperation(state, action) {
      if (!state.user) {
        throw new NotIssuedError("this license has not been issued");
      }
      if (state.kind) {
        throw new AlreadyMigratedError("this license already carries a kind");
      }
      state.kind = action.input.kind;
      state.user = action.input.user.toLowerCase();
      state.details = action.input.details ?? null;
    },
  };
