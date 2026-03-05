import type { Action } from "document-model";
import type { StartInput, StopInput } from "../types.js";

export type StartAction = Action & { type: "START"; input: StartInput };
export type StopAction = Action & { type: "STOP"; input: StopInput };

export type VetraCloudEnvironmentStatusAction = StartAction | StopAction;
