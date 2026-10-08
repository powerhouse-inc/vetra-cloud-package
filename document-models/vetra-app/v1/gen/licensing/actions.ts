/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import type { Action } from "document-model";
import type {
  AddTemplateInput,
  AddTemplatePackageInput,
  AddTemplateServiceInput,
  AddTermInput,
  DeleteTemplateInput,
  DeleteTermInput,
  PublishTermInput,
  RemoveTemplatePackageInput,
  RemoveTemplateServiceInput,
  RetireTermInput,
  SetTemplateDetailsInput,
  SetTermDetailsInput,
} from "../types.js";

export type AddTemplateAction = Action & {
  type: "ADD_TEMPLATE";
  input: AddTemplateInput;
};
export type SetTemplateDetailsAction = Action & {
  type: "SET_TEMPLATE_DETAILS";
  input: SetTemplateDetailsInput;
};
export type AddTemplateServiceAction = Action & {
  type: "ADD_TEMPLATE_SERVICE";
  input: AddTemplateServiceInput;
};
export type RemoveTemplateServiceAction = Action & {
  type: "REMOVE_TEMPLATE_SERVICE";
  input: RemoveTemplateServiceInput;
};
export type AddTemplatePackageAction = Action & {
  type: "ADD_TEMPLATE_PACKAGE";
  input: AddTemplatePackageInput;
};
export type RemoveTemplatePackageAction = Action & {
  type: "REMOVE_TEMPLATE_PACKAGE";
  input: RemoveTemplatePackageInput;
};
export type DeleteTemplateAction = Action & {
  type: "DELETE_TEMPLATE";
  input: DeleteTemplateInput;
};
export type AddTermAction = Action & { type: "ADD_TERM"; input: AddTermInput };
export type SetTermDetailsAction = Action & {
  type: "SET_TERM_DETAILS";
  input: SetTermDetailsInput;
};
export type PublishTermAction = Action & {
  type: "PUBLISH_TERM";
  input: PublishTermInput;
};
export type RetireTermAction = Action & {
  type: "RETIRE_TERM";
  input: RetireTermInput;
};
export type DeleteTermAction = Action & {
  type: "DELETE_TERM";
  input: DeleteTermInput;
};

export type VetraAppLicensingAction =
  | AddTemplateAction
  | SetTemplateDetailsAction
  | AddTemplateServiceAction
  | RemoveTemplateServiceAction
  | AddTemplatePackageAction
  | RemoveTemplatePackageAction
  | DeleteTemplateAction
  | AddTermAction
  | SetTermDetailsAction
  | PublishTermAction
  | RetireTermAction
  | DeleteTermAction;
