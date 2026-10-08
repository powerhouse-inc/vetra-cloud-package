import type { AppLicenseTypeLicenseTypeOperations } from "document-models/app-license-type/v1";
import {
  ArtifactOnNonFusionServiceError,
  DuplicatePackageError,
  DuplicateServiceError,
  IncompleteTemplateError,
  NegativeValidityError,
  NotPublishedError,
  UnknownPackageError,
  UnknownServiceError,
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
      // Validate before touching state: a rejected action must leave the
      // document exactly as it was, and creating the template first left an
      // empty one behind on every refusal.
      if (state.template?.services.some((s) => s.id === action.input.id)) {
        throw new DuplicateServiceError(
          `service ${action.input.id} already exists`,
        );
      }
      // Only a FUSION service runs the app's own image. Carrying an artifact on
      // any other type would render a service the provisioner cannot build.
      if (action.input.artifactName && action.input.type !== "FUSION") {
        throw new ArtifactOnNonFusionServiceError(
          `only a FUSION service can reference an artifact, not ${action.input.type}`,
        );
      }
      state.template ??= {
        services: [],
        packages: [],
        size: null,
        baseDomain: null,
        packageRegistry: null,
      };
      state.template.services.push({
        id: action.input.id,
        type: action.input.type,
        // The artifact names the image, so it is the obvious default prefix.
        prefix: action.input.prefix ?? action.input.artifactName ?? null,
        artifactName: action.input.artifactName ?? null,
        // A referenced artifact always tracks a channel; LATEST is what a
        // publisher means by picking one without saying more.
        artifactChannel: action.input.artifactName
          ? (action.input.artifactChannel ?? "LATEST")
          : null,
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
    removeTemplateServiceOperation(state, action) {
      const list = state.template?.services ?? [];
      const at = list.findIndex((x) => x.id === action.input.id);
      if (at === -1) {
        throw new UnknownServiceError(
          `service ${action.input.id} does not exist`,
        );
      }
      list.splice(at, 1);
    },
    removeTemplatePackageOperation(state, action) {
      const list = state.template?.packages ?? [];
      const at = list.findIndex((x) => x.id === action.input.id);
      if (at === -1) {
        throw new UnknownPackageError(
          `package ${action.input.id} does not exist`,
        );
      }
      list.splice(at, 1);
    },
  };
