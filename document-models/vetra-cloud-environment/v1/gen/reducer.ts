/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import type { Reducer, StateReducer } from "document-model";
import { createReducer, isDocumentAction } from "document-model";
import type { VetraCloudEnvironmentPHState } from "document-models/vetra-cloud-environment/v1";

import { vetraCloudEnvironmentDataManagementOperations } from "../src/reducers/data-management.js";
import { vetraCloudEnvironmentPackagesOperations } from "../src/reducers/packages.js";
import { vetraCloudEnvironmentServicesOperations } from "../src/reducers/services.js";
import { vetraCloudEnvironmentStatusTransitionsOperations } from "../src/reducers/status-transitions.js";

import {
  AddPackageInputSchema,
  ApproveChangesInputSchema,
  ArchiveInputSchema,
  DisableServiceInputSchema,
  EnableServiceInputSchema,
  InitializeInputSchema,
  MarkChangesPushedInputSchema,
  MarkDeploymentStartedInputSchema,
  MarkDestroyedInputSchema,
  RemovePackageInputSchema,
  ReportDeploymentFailedInputSchema,
  ReportDeploymentSucceededInputSchema,
  SetApexServiceInputSchema,
  SetAutoUpdateChannelInputSchema,
  SetCustomDomainInputSchema,
  SetDefaultPackageRegistryInputSchema,
  SetDnsRecordsInputSchema,
  SetGenericSubdomainInputSchema,
  SetLabelInputSchema,
  SetOwnerInputSchema,
  SetPackageVersionInputSchema,
  SetRuntimeConfigInputSchema,
  SetServiceConfigInputSchema,
  SetServiceSizeInputSchema,
  SetServiceStatusInputSchema,
  SetServiceVersionInputSchema,
  SetStudioInstanceInputSchema,
  SleepEnvironmentInputSchema,
  TerminateEnvironmentInputSchema,
  ToggleServiceInputSchema,
  UnarchiveInputSchema,
  UpdateServicePrefixInputSchema,
  WakeEnvironmentInputSchema,
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
    case "SET_OWNER": {
      SetOwnerInputSchema().parse(action.input);

      vetraCloudEnvironmentDataManagementOperations.setOwnerOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

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

    case "SET_DEFAULT_PACKAGE_REGISTRY": {
      SetDefaultPackageRegistryInputSchema().parse(action.input);

      vetraCloudEnvironmentDataManagementOperations.setDefaultPackageRegistryOperation(
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

    case "SET_APEX_SERVICE": {
      SetApexServiceInputSchema().parse(action.input);

      vetraCloudEnvironmentDataManagementOperations.setApexServiceOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "SET_AUTO_UPDATE_CHANNEL": {
      SetAutoUpdateChannelInputSchema().parse(action.input);

      vetraCloudEnvironmentDataManagementOperations.setAutoUpdateChannelOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "SET_RUNTIME_CONFIG": {
      SetRuntimeConfigInputSchema().parse(action.input);

      vetraCloudEnvironmentDataManagementOperations.setRuntimeConfigOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "SET_STUDIO_INSTANCE": {
      SetStudioInstanceInputSchema().parse(action.input);

      vetraCloudEnvironmentDataManagementOperations.setStudioInstanceOperation(
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

    case "SET_SERVICE_CONFIG": {
      SetServiceConfigInputSchema().parse(action.input);

      vetraCloudEnvironmentServicesOperations.setServiceConfigOperation(
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

    case "SET_SERVICE_VERSION": {
      SetServiceVersionInputSchema().parse(action.input);

      vetraCloudEnvironmentServicesOperations.setServiceVersionOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "SET_SERVICE_SIZE": {
      SetServiceSizeInputSchema().parse(action.input);

      vetraCloudEnvironmentServicesOperations.setServiceSizeOperation(
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

    case "SET_PACKAGE_VERSION": {
      SetPackageVersionInputSchema().parse(action.input);

      vetraCloudEnvironmentPackagesOperations.setPackageVersionOperation(
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

    case "SLEEP_ENVIRONMENT": {
      SleepEnvironmentInputSchema().parse(action.input);

      vetraCloudEnvironmentStatusTransitionsOperations.sleepEnvironmentOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "WAKE_ENVIRONMENT": {
      WakeEnvironmentInputSchema().parse(action.input);

      vetraCloudEnvironmentStatusTransitionsOperations.wakeEnvironmentOperation(
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
