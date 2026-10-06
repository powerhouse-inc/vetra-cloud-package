/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import { type SignalDispatch } from "document-model";
import type { AppLicenseTypeGlobalState } from "../types.js";
import type {
  AddTemplatePackageAction,
  AddTemplateServiceAction,
  PublishLicenseTypeAction,
  RetireLicenseTypeAction,
  SetLicenseTypeDetailsAction,
  SetTemplateAction,
} from "./actions.js";

export interface AppLicenseTypeLicenseTypeOperations {
  setLicenseTypeDetailsOperation: (
    state: AppLicenseTypeGlobalState,
    action: SetLicenseTypeDetailsAction,
    dispatch?: SignalDispatch,
  ) => void;
  setTemplateOperation: (
    state: AppLicenseTypeGlobalState,
    action: SetTemplateAction,
    dispatch?: SignalDispatch,
  ) => void;
  addTemplateServiceOperation: (
    state: AppLicenseTypeGlobalState,
    action: AddTemplateServiceAction,
    dispatch?: SignalDispatch,
  ) => void;
  addTemplatePackageOperation: (
    state: AppLicenseTypeGlobalState,
    action: AddTemplatePackageAction,
    dispatch?: SignalDispatch,
  ) => void;
  publishLicenseTypeOperation: (
    state: AppLicenseTypeGlobalState,
    action: PublishLicenseTypeAction,
    dispatch?: SignalDispatch,
  ) => void;
  retireLicenseTypeOperation: (
    state: AppLicenseTypeGlobalState,
    action: RetireLicenseTypeAction,
    dispatch?: SignalDispatch,
  ) => void;
}
