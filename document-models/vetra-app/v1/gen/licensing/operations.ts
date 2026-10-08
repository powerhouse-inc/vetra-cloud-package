/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import { type SignalDispatch } from "document-model";
import type { VetraAppGlobalState } from "../types.js";
import type {
  AddTemplateAction,
  AddTemplatePackageAction,
  AddTemplateServiceAction,
  AddTermAction,
  DeleteTemplateAction,
  PublishTermAction,
  RemoveTemplatePackageAction,
  RemoveTemplateServiceAction,
  RetireTermAction,
  SetTemplateDetailsAction,
  SetTermDetailsAction,
} from "./actions.js";

export interface VetraAppLicensingOperations {
  addTemplateOperation: (
    state: VetraAppGlobalState,
    action: AddTemplateAction,
    dispatch?: SignalDispatch,
  ) => void;
  setTemplateDetailsOperation: (
    state: VetraAppGlobalState,
    action: SetTemplateDetailsAction,
    dispatch?: SignalDispatch,
  ) => void;
  addTemplateServiceOperation: (
    state: VetraAppGlobalState,
    action: AddTemplateServiceAction,
    dispatch?: SignalDispatch,
  ) => void;
  removeTemplateServiceOperation: (
    state: VetraAppGlobalState,
    action: RemoveTemplateServiceAction,
    dispatch?: SignalDispatch,
  ) => void;
  addTemplatePackageOperation: (
    state: VetraAppGlobalState,
    action: AddTemplatePackageAction,
    dispatch?: SignalDispatch,
  ) => void;
  removeTemplatePackageOperation: (
    state: VetraAppGlobalState,
    action: RemoveTemplatePackageAction,
    dispatch?: SignalDispatch,
  ) => void;
  deleteTemplateOperation: (
    state: VetraAppGlobalState,
    action: DeleteTemplateAction,
    dispatch?: SignalDispatch,
  ) => void;
  addTermOperation: (
    state: VetraAppGlobalState,
    action: AddTermAction,
    dispatch?: SignalDispatch,
  ) => void;
  setTermDetailsOperation: (
    state: VetraAppGlobalState,
    action: SetTermDetailsAction,
    dispatch?: SignalDispatch,
  ) => void;
  publishTermOperation: (
    state: VetraAppGlobalState,
    action: PublishTermAction,
    dispatch?: SignalDispatch,
  ) => void;
  retireTermOperation: (
    state: VetraAppGlobalState,
    action: RetireTermAction,
    dispatch?: SignalDispatch,
  ) => void;
}
