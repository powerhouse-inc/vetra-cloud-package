import { createAction } from "document-model";
import { z, type SetEnvironmentNameInput } from "../types.js";
import { type SetEnvironmentNameAction } from "./actions.js";

export const setEnvironmentName = (input: SetEnvironmentNameInput) =>
  createAction<SetEnvironmentNameAction>(
    "SET_ENVIRONMENT_NAME",
    { ...input },
    undefined,
    z.SetEnvironmentNameInputSchema,
    "global",
  );
