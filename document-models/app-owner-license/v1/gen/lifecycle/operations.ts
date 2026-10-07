/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import { type SignalDispatch } from "document-model";
import type { AppOwnerLicenseGlobalState } from "../types.js";
import type {
  ActivateLicenseAction,
  ExpireLicenseAction,
  IssueLicenseAction,
  ReplaceLicenseAction,
  RevokeLicenseAction,
} from "./actions.js";

export interface AppOwnerLicenseLifecycleOperations {
  issueLicenseOperation: (
    state: AppOwnerLicenseGlobalState,
    action: IssueLicenseAction,
    dispatch?: SignalDispatch,
  ) => void;
  activateLicenseOperation: (
    state: AppOwnerLicenseGlobalState,
    action: ActivateLicenseAction,
    dispatch?: SignalDispatch,
  ) => void;
  expireLicenseOperation: (
    state: AppOwnerLicenseGlobalState,
    action: ExpireLicenseAction,
    dispatch?: SignalDispatch,
  ) => void;
  revokeLicenseOperation: (
    state: AppOwnerLicenseGlobalState,
    action: RevokeLicenseAction,
    dispatch?: SignalDispatch,
  ) => void;
  replaceLicenseOperation: (
    state: AppOwnerLicenseGlobalState,
    action: ReplaceLicenseAction,
    dispatch?: SignalDispatch,
  ) => void;
}
