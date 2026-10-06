/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import type { Reducer, StateReducer } from "document-model";
import { createReducer, isDocumentAction } from "document-model";
import type { AppOwnerLicensePHState } from "document-models/app-owner-license/v1";

import { appOwnerLicenseLifecycleOperations } from "../src/reducers/lifecycle.js";

import {
  ActivateLicenseInputSchema,
  ExpireLicenseInputSchema,
  IssueLicenseInputSchema,
  ReplaceLicenseInputSchema,
  RevokeLicenseInputSchema,
} from "./schema/zod.js";

const stateReducer: StateReducer<AppOwnerLicensePHState> = (
  state,
  action,
  dispatch,
) => {
  if (isDocumentAction(action)) {
    return state;
  }
  switch (action.type) {
    case "ISSUE_LICENSE": {
      IssueLicenseInputSchema().parse(action.input);

      appOwnerLicenseLifecycleOperations.issueLicenseOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "ACTIVATE_LICENSE": {
      ActivateLicenseInputSchema().parse(action.input);

      appOwnerLicenseLifecycleOperations.activateLicenseOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "EXPIRE_LICENSE": {
      ExpireLicenseInputSchema().parse(action.input);

      appOwnerLicenseLifecycleOperations.expireLicenseOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "REVOKE_LICENSE": {
      RevokeLicenseInputSchema().parse(action.input);

      appOwnerLicenseLifecycleOperations.revokeLicenseOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "REPLACE_LICENSE": {
      ReplaceLicenseInputSchema().parse(action.input);

      appOwnerLicenseLifecycleOperations.replaceLicenseOperation(
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

export const reducer: Reducer<AppOwnerLicensePHState> =
  createReducer(stateReducer);
