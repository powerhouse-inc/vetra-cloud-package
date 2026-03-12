// TODO: remove eslint-disable rules once refactor is done
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import type { StateReducer } from "document-model";
import { isDocumentAction, createReducer } from "document-model/core";
import type { VetraCloudEnvironmentPHState } from "vetra-cloud-package/document-models/vetra-cloud-environment/v1";

import { vetraCloudEnvironmentDataManagementOperations } from "../src/reducers/data-management.js";
import { vetraCloudEnvironmentServicesOperations } from "../src/reducers/services.js";
import { vetraCloudEnvironmentPackagesOperations } from "../src/reducers/packages.js";
import { vetraCloudEnvironmentStatusOperations } from "../src/reducers/status.js";

import {
  SetEnvironmentNameInputSchema,
  EnableServiceInputSchema,
  DisableServiceInputSchema,
  AddPackageInputSchema,
  RemovePackageInputSchema,
  StartInputSchema,
  StopInputSchema,
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
    case "SET_ENVIRONMENT_NAME": {
      SetEnvironmentNameInputSchema().parse(action.input);

      vetraCloudEnvironmentDataManagementOperations.setEnvironmentNameOperation(
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

    case "START": {
      StartInputSchema().parse(action.input);

      vetraCloudEnvironmentStatusOperations.startOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "STOP": {
      StopInputSchema().parse(action.input);

      vetraCloudEnvironmentStatusOperations.stopOperation(
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

export const reducer =
  createReducer<VetraCloudEnvironmentPHState>(stateReducer);
