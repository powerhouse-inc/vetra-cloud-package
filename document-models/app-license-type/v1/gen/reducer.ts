/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import type { Reducer, StateReducer } from "document-model";
import { createReducer, isDocumentAction } from "document-model";
import type { AppLicenseTypePHState } from "document-models/app-license-type/v1";

import { appLicenseTypeLicenseTypeOperations } from "../src/reducers/license-type.js";

import {
  AddTemplatePackageInputSchema,
  AddTemplateServiceInputSchema,
  PublishLicenseTypeInputSchema,
  RemoveTemplatePackageInputSchema,
  RemoveTemplateServiceInputSchema,
  RetireLicenseTypeInputSchema,
  SetLicenseTypeDetailsInputSchema,
  SetTemplateInputSchema,
} from "./schema/zod.js";

const stateReducer: StateReducer<AppLicenseTypePHState> = (
  state,
  action,
  dispatch,
) => {
  if (isDocumentAction(action)) {
    return state;
  }
  switch (action.type) {
    case "SET_LICENSE_TYPE_DETAILS": {
      SetLicenseTypeDetailsInputSchema().parse(action.input);

      appLicenseTypeLicenseTypeOperations.setLicenseTypeDetailsOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "SET_TEMPLATE": {
      SetTemplateInputSchema().parse(action.input);

      appLicenseTypeLicenseTypeOperations.setTemplateOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "ADD_TEMPLATE_SERVICE": {
      AddTemplateServiceInputSchema().parse(action.input);

      appLicenseTypeLicenseTypeOperations.addTemplateServiceOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "ADD_TEMPLATE_PACKAGE": {
      AddTemplatePackageInputSchema().parse(action.input);

      appLicenseTypeLicenseTypeOperations.addTemplatePackageOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "REMOVE_TEMPLATE_SERVICE": {
      RemoveTemplateServiceInputSchema().parse(action.input);

      appLicenseTypeLicenseTypeOperations.removeTemplateServiceOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "REMOVE_TEMPLATE_PACKAGE": {
      RemoveTemplatePackageInputSchema().parse(action.input);

      appLicenseTypeLicenseTypeOperations.removeTemplatePackageOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "PUBLISH_LICENSE_TYPE": {
      PublishLicenseTypeInputSchema().parse(action.input);

      appLicenseTypeLicenseTypeOperations.publishLicenseTypeOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "RETIRE_LICENSE_TYPE": {
      RetireLicenseTypeInputSchema().parse(action.input);

      appLicenseTypeLicenseTypeOperations.retireLicenseTypeOperation(
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

export const reducer: Reducer<AppLicenseTypePHState> =
  createReducer(stateReducer);
