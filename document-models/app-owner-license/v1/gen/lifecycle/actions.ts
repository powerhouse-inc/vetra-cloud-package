/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import type { Action } from "document-model";
import type {
  ActivateLicenseInput,
  ExpireLicenseInput,
  IssueLicenseInput,
  MigrateLicenseInput,
  ReplaceLicenseInput,
  RevokeLicenseInput,
  SetStageInput,
} from "../types.js";

export type IssueLicenseAction = Action & {
  type: "ISSUE_LICENSE";
  input: IssueLicenseInput;
};
export type ActivateLicenseAction = Action & {
  type: "ACTIVATE_LICENSE";
  input: ActivateLicenseInput;
};
export type ExpireLicenseAction = Action & {
  type: "EXPIRE_LICENSE";
  input: ExpireLicenseInput;
};
export type RevokeLicenseAction = Action & {
  type: "REVOKE_LICENSE";
  input: RevokeLicenseInput;
};
export type ReplaceLicenseAction = Action & {
  type: "REPLACE_LICENSE";
  input: ReplaceLicenseInput;
};
export type SetStageAction = Action & {
  type: "SET_STAGE";
  input: SetStageInput;
};
export type MigrateLicenseAction = Action & {
  type: "MIGRATE_LICENSE";
  input: MigrateLicenseInput;
};

export type AppOwnerLicenseLifecycleAction =
  | IssueLicenseAction
  | ActivateLicenseAction
  | ExpireLicenseAction
  | RevokeLicenseAction
  | ReplaceLicenseAction
  | SetStageAction
  | MigrateLicenseAction;
