// TODO: remove eslint-disable rules once refactor is done
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import {
  type StateReducer,
  isDocumentAction,
  createReducer,
} from "document-model";
import { VetraCloudEnvironmentPHState } from "./ph-factories.js";
import { z } from "./types.js";

import { reducer as DataManagementReducer } from "../src/reducers/data-management.js";
import { reducer as ServicesReducer } from "../src/reducers/services.js";
import { reducer as PackagesReducer } from "../src/reducers/packages.js";
import { reducer as StatusReducer } from "../src/reducers/status.js";

export const stateReducer: StateReducer<VetraCloudEnvironmentPHState> = (
  state,
  action,
  dispatch,
) => {
  if (isDocumentAction(action)) {
    return state;
  }

  switch (action.type) {
    case "SET_ENVIRONMENT_NAME":
      z.SetEnvironmentNameInputSchema().parse(action.input);
      DataManagementReducer.setEnvironmentNameOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );
      break;

    case "ENABLE_SERVICE":
      z.EnableServiceInputSchema().parse(action.input);
      ServicesReducer.enableServiceOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );
      break;

    case "DISABLE_SERVICE":
      z.DisableServiceInputSchema().parse(action.input);
      ServicesReducer.disableServiceOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );
      break;

    case "ADD_PACKAGE":
      z.AddPackageInputSchema().parse(action.input);
      PackagesReducer.addPackageOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );
      break;

    case "REMOVE_PACKAGE":
      z.RemovePackageInputSchema().parse(action.input);
      PackagesReducer.removePackageOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );
      break;

    case "START":
      z.StartInputSchema().parse(action.input);
      StatusReducer.startOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );
      break;

    case "STOP":
      z.StopInputSchema().parse(action.input);
      StatusReducer.stopOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );
      break;

    default:
      return state;
  }
};

export const reducer =
  createReducer<VetraCloudEnvironmentPHState>(stateReducer);
