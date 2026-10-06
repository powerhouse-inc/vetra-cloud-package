import type { AppLicenseTypeLicenseTypeOperations } from "document-models/app-license-type/v1";
import {
  DuplicatePackageError,
  DuplicateServiceError,
  IncompleteTemplateError,
  NegativeValidityError,
  NotPublishedError,
} from "../../gen/license-type/error.js";

export const appLicenseTypeLicenseTypeOperations: AppLicenseTypeLicenseTypeOperations =
  {
    setLicenseTypeDetailsOperation(state, action) {
      if (action.input.validityDays != null && action.input.validityDays <= 0) {
        throw new NegativeValidityError("validityDays must be positive");
      }
      if (action.input.app) state.app = action.input.app;
      if (action.input.kind) state.kind = action.input.kind;
      if (action.input.label) state.label = action.input.label;
      state.validityDays = action.input.validityDays ?? null;
    },
    setTemplateOperation(state, action) {
      state.template ??= {
        services: [],
        packages: [],
        size: null,
        baseDomain: null,
        packageRegistry: null,
      };
      state.template.size = action.input.size ?? null;
      state.template.baseDomain = action.input.baseDomain ?? null;
      state.template.packageRegistry = action.input.packageRegistry ?? null;
    },
    addTemplateServiceOperation(state, action) {
      state.template ??= {
        services: [],
        packages: [],
        size: null,
        baseDomain: null,
        packageRegistry: null,
      };
      if (state.template.services.some((s) => s.id === action.input.id)) {
        throw new DuplicateServiceError(
          `service ${action.input.id} already exists`,
        );
      }
      state.template.services.push({
        id: action.input.id,
        type: action.input.type,
        prefix: action.input.prefix ?? null,
      });
    },
    addTemplatePackageOperation(state, action) {
      state.template ??= {
        services: [],
        packages: [],
        size: null,
        baseDomain: null,
        packageRegistry: null,
      };
      if (state.template.packages.some((p) => p.id === action.input.id)) {
        throw new DuplicatePackageError(
          `package ${action.input.id} already exists`,
        );
      }
      state.template.packages.push({
        id: action.input.id,
        packageName: action.input.packageName ?? null,
        version: action.input.version ?? null,
      });
    },
    publishLicenseTypeOperation(state) {
      if (
        !state.kind ||
        !state.template ||
        state.template.services.length === 0
      ) {
        throw new IncompleteTemplateError(
          "a license type needs at least one service before it can be published",
        );
      }
      state.status = "ACTIVE";
    },
    retireLicenseTypeOperation(state) {
      if (state.status !== "ACTIVE") {
        throw new NotPublishedError(
          "only an ACTIVE license type can be retired",
        );
      }
      state.status = "RETIRED";
    },
  };
