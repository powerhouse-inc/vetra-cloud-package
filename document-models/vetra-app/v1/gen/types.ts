/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import type { PHBaseState, PHDocument } from "document-model";
import type { VetraAppAction } from "./actions.js";
import type { VetraAppState as VetraAppGlobalState } from "./schema/types.js";

type VetraAppLocalState = Record<PropertyKey, never>;

type VetraAppPHState = PHBaseState & {
  global: VetraAppGlobalState;
  local: VetraAppLocalState;
};
type VetraAppDocument = PHDocument<VetraAppPHState>;

export * from "./schema/types.js";

export type {
  VetraAppAction,
  VetraAppDocument,
  VetraAppGlobalState,
  VetraAppLocalState,
  VetraAppPHState,
};
