import { createAction } from "document-model/core";
import {
  EnableServiceInputSchema,
  DisableServiceInputSchema,
} from "../schema/zod.js";
import type { EnableServiceInput, DisableServiceInput } from "../types.js";
import type { EnableServiceAction, DisableServiceAction } from "./actions.js";

export const enableService = (input: EnableServiceInput) =>
  createAction<EnableServiceAction>(
    "ENABLE_SERVICE",
    { ...input },
    undefined,
    EnableServiceInputSchema,
    "global",
  );

export const disableService = (input: DisableServiceInput) =>
  createAction<DisableServiceAction>(
    "DISABLE_SERVICE",
    { ...input },
    undefined,
    DisableServiceInputSchema,
    "global",
  );
