import { createAction } from "document-model";
import { z, type StartInput, type StopInput } from "../types.js";
import { type StartAction, type StopAction } from "./actions.js";

export const start = (input: StartInput) =>
  createAction<StartAction>(
    "START",
    { ...input },
    undefined,
    z.StartInputSchema,
    "global",
  );

export const stop = (input: StopInput) =>
  createAction<StopAction>(
    "STOP",
    { ...input },
    undefined,
    z.StopInputSchema,
    "global",
  );
