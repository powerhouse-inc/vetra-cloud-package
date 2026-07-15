import type { VetraCloudEnvironmentStatusTransitionsOperations } from "document-models/vetra-cloud-environment/v1";
import { InvalidStatusTransitionError } from "../../gen/status-transitions/error.js";
import { assertOwner } from "./utils.js";

export const vetraCloudEnvironmentStatusTransitionsOperations: VetraCloudEnvironmentStatusTransitionsOperations =
  {
    initializeOperation(state, action) {
      assertOwner(state, action);
      if (state.status !== "DRAFT") {
        throw new InvalidStatusTransitionError(
          "INITIALIZE can only be called from DRAFT status, current: " +
            state.status,
        );
      }
      state.genericSubdomain = action.input.genericSubdomain;
      state.genericBaseDomain = action.input.genericBaseDomain;
      state.defaultPackageRegistry =
        action.input.defaultPackageRegistry || null;
      state.status = "CHANGES_APPROVED";
    },
    markChangesPushedOperation(state, action) {
      // Processor-dispatched (system). No owner gate.
      if (state.status !== "CHANGES_APPROVED") {
        throw new InvalidStatusTransitionError(
          "MARK_CHANGES_PUSHED can only be called from CHANGES_APPROVED status, current: " +
            state.status,
        );
      }
      state.status = "CHANGES_PUSHED";
    },
    markDeploymentStartedOperation(state, action) {
      // Observability-dispatched (system). No owner gate.
      if (state.status !== "CHANGES_PUSHED") {
        throw new InvalidStatusTransitionError(
          "MARK_DEPLOYMENT_STARTED can only be called from CHANGES_PUSHED status, current: " +
            state.status,
        );
      }
      state.status = "DEPLOYING";
    },
    reportDeploymentSucceededOperation(state, action) {
      // Observability-dispatched (system). No owner gate.
      if (state.status !== "DEPLOYING") {
        throw new InvalidStatusTransitionError(
          "REPORT_DEPLOYMENT_SUCCEEDED can only be called from DEPLOYING status, current: " +
            state.status,
        );
      }
      state.status = "READY";
    },
    reportDeploymentFailedOperation(state, action) {
      // Observability-dispatched (system). No owner gate.
      if (state.status !== "DEPLOYING") {
        throw new InvalidStatusTransitionError(
          "REPORT_DEPLOYMENT_FAILED can only be called from DEPLOYING status, current: " +
            state.status,
        );
      }
      state.status = "DEPLOYMENt_FAILED";
    },
    approveChangesOperation(state, action) {
      assertOwner(state, action);
      if (state.status !== "CHANGES_PENDING" && state.status !== "DRAFT") {
        throw new InvalidStatusTransitionError(
          "APPROVE_CHANGES can only be called from DRAFT or CHANGES_PENDING status, current: " +
            state.status,
        );
      }
      state.status = "CHANGES_APPROVED";
    },
    terminateEnvironmentOperation(state, action) {
      assertOwner(state, action);
      state.status = "TERMINATING";
    },
    markDestroyedOperation(state, action) {
      assertOwner(state, action);
      if (state.status !== "TERMINATING") {
        throw new InvalidStatusTransitionError(
          "MARK_DESTROYED can only be called from TERMINATING status, current: " +
            state.status,
        );
      }
      state.status = "DESTROYED";
    },
    archiveOperation(state, action) {
      assertOwner(state, action);
      if (state.status !== "DESTROYED") {
        throw new InvalidStatusTransitionError(
          "ARCHIVE can only be called from DESTROYED status, current: " +
            state.status,
        );
      }
      state.status = "ARCHIVED";
    },
    unarchiveOperation(state, action) {
      assertOwner(state, action);
      if (state.status !== "ARCHIVED") {
        throw new InvalidStatusTransitionError(
          "UNARCHIVE can only be called from ARCHIVED status, current: " +
            state.status,
        );
      }
      state.status = "DESTROYED";
    },
    sleepEnvironmentOperation(state, action) {
      // Housekeeping-dispatched (system). No owner gate. Only a live (READY)
      // studio can be put to sleep; the processor renders global.disabled=true
      // for STOPPED, removing the workload + ingress while keeping the
      // namespace/PVC/cert. Eligibility (claimed, not core/allowlisted) is
      // enforced by the housekeeping subgraph before dispatch.
      // READY (normal idle-sleep) OR DEPLOYMENt_FAILED: a failed deploy was
      // previously a dead-end (no sleep, no retry — only terminate), so its
      // crash-looping workload ran forever because the processor never
      // re-renders DEPLOYMENt_FAILED. Allowing sleep → STOPPED lets a failed env
      // be put to rest (processor renders global.disabled=true, workload removed).
      if (state.status !== "READY" && state.status !== "DEPLOYMENt_FAILED") {
        throw new InvalidStatusTransitionError(
          "SLEEP_ENVIRONMENT can only be called from READY or DEPLOYMENt_FAILED status, current: " +
            state.status,
        );
      }
      state.status = "STOPPED";
    },
    wakeEnvironmentOperation(state, action) {
      // Housekeeping-dispatched (system). No owner gate. Re-approve the existing
      // config so the processor re-renders enabled values and the normal deploy
      // pipeline (CHANGES_APPROVED -> CHANGES_PUSHED -> DEPLOYING -> READY)
      // brings the studio back.
      if (state.status !== "STOPPED") {
        throw new InvalidStatusTransitionError(
          "WAKE_ENVIRONMENT can only be called from STOPPED status, current: " +
            state.status,
        );
      }
      state.status = "CHANGES_APPROVED";
    },
  };
