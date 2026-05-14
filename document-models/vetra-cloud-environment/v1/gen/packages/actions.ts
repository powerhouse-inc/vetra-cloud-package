/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import type { Action } from "document-model";
import type {
  AddPackageInput,
  RemovePackageInput,
  SetPackageVersionInput,
} from "../types.js";

export type AddPackageAction = Action & {
  type: "ADD_PACKAGE";
  input: AddPackageInput;
};
export type RemovePackageAction = Action & {
  type: "REMOVE_PACKAGE";
  input: RemovePackageInput;
};
export type SetPackageVersionAction = Action & {
  type: "SET_PACKAGE_VERSION";
  input: SetPackageVersionInput;
};

export type VetraCloudEnvironmentPackagesAction =
  | AddPackageAction
  | RemovePackageAction
  | SetPackageVersionAction;
