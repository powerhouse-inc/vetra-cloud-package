import type { Action } from "document-model";
import type { AddPackageInput, RemovePackageInput } from "../types.js";

export type AddPackageAction = Action & {
  type: "ADD_PACKAGE";
  input: AddPackageInput;
};
export type RemovePackageAction = Action & {
  type: "REMOVE_PACKAGE";
  input: RemovePackageInput;
};

export type VetraCloudEnvironmentPackagesAction =
  | AddPackageAction
  | RemovePackageAction;
