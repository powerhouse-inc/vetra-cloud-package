/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import { createAction } from "document-model";
import {
  AddPackageInputSchema,
  RemovePackageInputSchema,
  SetPackageVersionInputSchema,
} from "../schema/zod.js";
import type {
  AddPackageInput,
  RemovePackageInput,
  SetPackageVersionInput,
} from "../types.js";
import type {
  AddPackageAction,
  RemovePackageAction,
  SetPackageVersionAction,
} from "./actions.js";

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

export const setPackageVersion = (input: SetPackageVersionInput) =>
  createAction<SetPackageVersionAction>(
    "SET_PACKAGE_VERSION",
    { ...input },
    undefined,
    SetPackageVersionInputSchema,
    "global",
  );
