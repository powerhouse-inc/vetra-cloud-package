import { createAction } from "document-model";
import { z, type AddPackageInput, type RemovePackageInput } from "../types.js";
import { type AddPackageAction, type RemovePackageAction } from "./actions.js";

export const addPackage = (input: AddPackageInput) =>
  createAction<AddPackageAction>(
    "ADD_PACKAGE",
    { ...input },
    undefined,
    z.AddPackageInputSchema,
    "global",
  );

export const removePackage = (input: RemovePackageInput) =>
  createAction<RemovePackageAction>(
    "REMOVE_PACKAGE",
    { ...input },
    undefined,
    z.RemovePackageInputSchema,
    "global",
  );
