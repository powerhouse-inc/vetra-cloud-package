/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import type { Reducer, StateReducer } from "document-model";
import { isDocumentAction, createReducer } from "document-model";
import type { VetraCloudEnvironmentPHState } from "document-models/vetra-cloud-environment/v1";

import { vetraCloudEnvironmentDataManagementOperations } from "../src/reducers/data-management.js";
import { vetraCloudEnvironmentServicesOperations } from "../src/reducers/services.js";
import { vetraCloudEnvironmentPackagesOperations } from "../src/reducers/packages.js";
import { vetraCloudEnvironmentStatusTransitionsOperations } from "../src/reducers/status-transitions.js";

import {
  SetLabelInputSchema,
  SetGenericSubdomainInputSchema,
  SetCustomDomainInputSchema,
  SetDnsRecordsInputSchema,
  EnableServiceInputSchema,
  DisableServiceInputSchema,
  ToggleServiceInputSchema,
  UpdateServicePrefixInputSchema,
  SetServiceStatusInputSchema,
  AddPackageInputSchema,
  RemovePackageInputSchema,
  InitializeInputSchema,
  MarkChangesPushedInputSchema,
  MarkDeploymentStartedInputSchema,
  ReportDeploymentSucceededInputSchema,
  ReportDeploymentFailedInputSchema,
  ApproveChangesInputSchema,
  TerminateEnvironmentInputSchema,
  MarkDestroyedInputSchema,
  ArchiveInputSchema,
  UnarchiveInputSchema,
} from "./schema/zod.js";

const stateReducer: StateReducer<VetraCloudEnvironmentPHState> = (
  state,
  action,
  dispatch,
) => {
  if (isDocumentAction(action)) {
    return state;
  }
  switch (action.type) {
    case "SET_LABEL": {
      SetLabelInputSchema().parse(action.input);

      vetraCloudEnvironmentDataManagementOperations.setLabelOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "SET_GENERIC_SUBDOMAIN": {
      SetGenericSubdomainInputSchema().parse(action.input);

      vetraCloudEnvironmentDataManagementOperations.setGenericSubdomainOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "SET_CUSTOM_DOMAIN": {
      SetCustomDomainInputSchema().parse(action.input);

      vetraCloudEnvironmentDataManagementOperations.setCustomDomainOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "SET_DNS_RECORDS": {
      SetDnsRecordsInputSchema().parse(action.input);

      vetraCloudEnvironmentDataManagementOperations.setDnsRecordsOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "ENABLE_SERVICE": {
      EnableServiceInputSchema().parse(action.input);

      vetraCloudEnvironmentServicesOperations.enableServiceOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "DISABLE_SERVICE": {
      DisableServiceInputSchema().parse(action.input);

      vetraCloudEnvironmentServicesOperations.disableServiceOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "TOGGLE_SERVICE": {
      ToggleServiceInputSchema().parse(action.input);

      vetraCloudEnvironmentServicesOperations.toggleServiceOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "UPDATE_SERVICE_PREFIX": {
      UpdateServicePrefixInputSchema().parse(action.input);

      vetraCloudEnvironmentServicesOperations.updateServicePrefixOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "SET_SERVICE_STATUS": {
      SetServiceStatusInputSchema().parse(action.input);

      vetraCloudEnvironmentServicesOperations.setServiceStatusOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "ADD_PACKAGE": {
      AddPackageInputSchema().parse(action.input);

      vetraCloudEnvironmentPackagesOperations.addPackageOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "REMOVE_PACKAGE": {
      RemovePackageInputSchema().parse(action.input);

      vetraCloudEnvironmentPackagesOperations.removePackageOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "INITIALIZE": {
      InitializeInputSchema().parse(action.input);

      vetraCloudEnvironmentStatusTransitionsOperations.initializeOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "MARK_CHANGES_PUSHED": {
      MarkChangesPushedInputSchema().parse(action.input);

      vetraCloudEnvironmentStatusTransitionsOperations.markChangesPushedOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "MARK_DEPLOYMENT_STARTED": {
      MarkDeploymentStartedInputSchema().parse(action.input);

      vetraCloudEnvironmentStatusTransitionsOperations.markDeploymentStartedOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "REPORT_DEPLOYMENT_SUCCEEDED": {
      ReportDeploymentSucceededInputSchema().parse(action.input);

      vetraCloudEnvironmentStatusTransitionsOperations.reportDeploymentSucceededOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "REPORT_DEPLOYMENT_FAILED": {
      ReportDeploymentFailedInputSchema().parse(action.input);

      vetraCloudEnvironmentStatusTransitionsOperations.reportDeploymentFailedOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "APPROVE_CHANGES": {
      ApproveChangesInputSchema().parse(action.input);

      vetraCloudEnvironmentStatusTransitionsOperations.approveChangesOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "TERMINATE_ENVIRONMENT": {
      TerminateEnvironmentInputSchema().parse(action.input);

      vetraCloudEnvironmentStatusTransitionsOperations.terminateEnvironmentOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "MARK_DESTROYED": {
      MarkDestroyedInputSchema().parse(action.input);

      vetraCloudEnvironmentStatusTransitionsOperations.markDestroyedOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "ARCHIVE": {
      ArchiveInputSchema().parse(action.input);

      vetraCloudEnvironmentStatusTransitionsOperations.archiveOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "UNARCHIVE": {
      UnarchiveInputSchema().parse(action.input);

      vetraCloudEnvironmentStatusTransitionsOperations.unarchiveOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    default:
      return state;
  }
};

export const reducer: Reducer<VetraCloudEnvironmentPHState> =
  createReducer(stateReducer);
