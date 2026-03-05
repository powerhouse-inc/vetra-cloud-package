import { createAction } from "document-model/core";
import { SetEnvironmentNameInputSchema } from "../schema/zod.js";
import type { SetEnvironmentNameInput } from "../types.js";
import type { SetEnvironmentNameAction } from "./actions.js";

export const setEnvironmentName = (input: SetEnvironmentNameInput) =>
  createAction<SetEnvironmentNameAction>(
    "SET_ENVIRONMENT_NAME",
    { ...input },
    undefined,
    SetEnvironmentNameInputSchema,
    "global",
  );
