/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import type { Action } from "document-model";
import type {
  AddTemplatePackageInput,
  AddTemplateServiceInput,
  PublishLicenseTypeInput,
  RemoveTemplatePackageInput,
  RemoveTemplateServiceInput,
  RetireLicenseTypeInput,
  SetLicenseTypeDetailsInput,
  SetTemplateInput,
} from "../types.js";

export type SetLicenseTypeDetailsAction = Action & {
  type: "SET_LICENSE_TYPE_DETAILS";
  input: SetLicenseTypeDetailsInput;
};
export type SetTemplateAction = Action & {
  type: "SET_TEMPLATE";
  input: SetTemplateInput;
};
export type AddTemplateServiceAction = Action & {
  type: "ADD_TEMPLATE_SERVICE";
  input: AddTemplateServiceInput;
};
export type AddTemplatePackageAction = Action & {
  type: "ADD_TEMPLATE_PACKAGE";
  input: AddTemplatePackageInput;
};
export type RemoveTemplateServiceAction = Action & {
  type: "REMOVE_TEMPLATE_SERVICE";
  input: RemoveTemplateServiceInput;
};
export type RemoveTemplatePackageAction = Action & {
  type: "REMOVE_TEMPLATE_PACKAGE";
  input: RemoveTemplatePackageInput;
};
export type PublishLicenseTypeAction = Action & {
  type: "PUBLISH_LICENSE_TYPE";
  input: PublishLicenseTypeInput;
};
export type RetireLicenseTypeAction = Action & {
  type: "RETIRE_LICENSE_TYPE";
  input: RetireLicenseTypeInput;
};

export type AppLicenseTypeLicenseTypeAction =
  | SetLicenseTypeDetailsAction
  | SetTemplateAction
  | AddTemplateServiceAction
  | AddTemplatePackageAction
  | RemoveTemplateServiceAction
  | RemoveTemplatePackageAction
  | PublishLicenseTypeAction
  | RetireLicenseTypeAction;
