/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import type { Reducer, StateReducer } from "document-model";
import { createReducer, isDocumentAction } from "document-model";
import type { VetraAppPHState } from "document-models/vetra-app/v1";

import { vetraAppAppOperations } from "../src/reducers/app.js";

import {
  ConnectRepositoryInputSchema,
  RecordArtifactVersionInputSchema,
  SetAppDetailsInputSchema,
  SetArtifactChannelInputSchema,
  SetIdentityInputSchema,
  SetPreviewsInputSchema,
  SetProductionEnvironmentInputSchema,
  SetStatusInputSchema,
} from "./schema/zod.js";

const stateReducer: StateReducer<VetraAppPHState> = (
  state,
  action,
  dispatch,
) => {
  if (isDocumentAction(action)) {
    return state;
  }
  switch (action.type) {
    case "SET_APP_DETAILS": {
      SetAppDetailsInputSchema().parse(action.input);

      vetraAppAppOperations.setAppDetailsOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "CONNECT_REPOSITORY": {
      ConnectRepositoryInputSchema().parse(action.input);

      vetraAppAppOperations.connectRepositoryOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "SET_IDENTITY": {
      SetIdentityInputSchema().parse(action.input);

      vetraAppAppOperations.setIdentityOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "SET_STATUS": {
      SetStatusInputSchema().parse(action.input);

      vetraAppAppOperations.setStatusOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "SET_PREVIEWS": {
      SetPreviewsInputSchema().parse(action.input);

      vetraAppAppOperations.setPreviewsOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "SET_PRODUCTION_ENVIRONMENT": {
      SetProductionEnvironmentInputSchema().parse(action.input);

      vetraAppAppOperations.setProductionEnvironmentOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "RECORD_ARTIFACT_VERSION": {
      RecordArtifactVersionInputSchema().parse(action.input);

      vetraAppAppOperations.recordArtifactVersionOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "SET_ARTIFACT_CHANNEL": {
      SetArtifactChannelInputSchema().parse(action.input);

      vetraAppAppOperations.setArtifactChannelOperation(
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

export const reducer: Reducer<VetraAppPHState> = createReducer(stateReducer);
