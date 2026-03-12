import { createAction } from "document-model/core";
import {
  AddPackageInputSchema,
  RemovePackageInputSchema,
} from "../schema/zod.js";
import type { AddPackageInput, RemovePackageInput } from "../types.js";
import type { AddPackageAction, RemovePackageAction } from "./actions.js";

export const addPackage = (input: AddPackageInput) =>
  createAction<AddPackageAction>(
    "ADD_PACKAGE",
    { ...input },
    undefined,
    AddPackageInputSchema,
    "global",
  );

export const removePackage = (input: RemovePackageInput) =>
  createAction<RemovePackageAction>(
    "REMOVE_PACKAGE",
    { ...input },
    undefined,
    RemovePackageInputSchema,
    "global",
  );
