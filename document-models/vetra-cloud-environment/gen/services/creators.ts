import { createAction } from "document-model";
import {
  z,
  type EnableServiceInput,
  type DisableServiceInput,
} from "../types.js";
import {
  type EnableServiceAction,
  type DisableServiceAction,
} from "./actions.js";

export const enableService = (input: EnableServiceInput) =>
  createAction<EnableServiceAction>(
    "ENABLE_SERVICE",
    { ...input },
    undefined,
    z.EnableServiceInputSchema,
    "global",
  );

export const disableService = (input: DisableServiceInput) =>
  createAction<DisableServiceAction>(
    "DISABLE_SERVICE",
    { ...input },
    undefined,
    z.DisableServiceInputSchema,
    "global",
  );
