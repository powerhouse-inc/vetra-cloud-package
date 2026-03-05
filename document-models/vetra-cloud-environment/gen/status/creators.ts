import { createAction } from "document-model/core";
import { StartInputSchema, StopInputSchema } from "../schema/zod.js";
import type { StartInput, StopInput } from "../types.js";
import type { StartAction, StopAction } from "./actions.js";

export const start = (input: StartInput) =>
  createAction<StartAction>(
    "START",
    { ...input },
    undefined,
    StartInputSchema,
    "global",
  );

export const stop = (input: StopInput) =>
  createAction<StopAction>(
    "STOP",
    { ...input },
    undefined,
    StopInputSchema,
    "global",
  );
