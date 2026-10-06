/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 * Factory methods for creating AppLicenseTypeDocument instances
 */
import type { PHAuthState, PHBaseState, PHDocumentState } from "document-model";
import { createBaseState, defaultBaseState } from "document-model";
import type {
  AppLicenseTypeDocument,
  AppLicenseTypeGlobalState,
  AppLicenseTypeLocalState,
  AppLicenseTypePHState,
} from "./types.js";
import { utils } from "./utils.js";

export function defaultGlobalState(): AppLicenseTypeGlobalState {
  return {
    app: null,
    kind: null,
    label: null,
    validityDays: null,
    template: null,
    status: "DRAFT",
  };
}

export function defaultLocalState(): AppLicenseTypeLocalState {
  return {};
}

export function defaultPHState(): AppLicenseTypePHState {
  return {
    ...defaultBaseState(),
    global: defaultGlobalState(),
    local: defaultLocalState(),
  };
}

export function createGlobalState(
  state?: Partial<AppLicenseTypeGlobalState>,
): AppLicenseTypeGlobalState {
  return {
    ...defaultGlobalState(),
    ...(state || {}),
  };
}

export function createLocalState(
  state?: Partial<AppLicenseTypeLocalState>,
): AppLicenseTypeLocalState {
  return {
    ...defaultLocalState(),
    ...(state || {}),
  } as AppLicenseTypeLocalState;
}

export function createState(
  baseState?: Partial<PHBaseState>,
  globalState?: Partial<AppLicenseTypeGlobalState>,
  localState?: Partial<AppLicenseTypeLocalState>,
): AppLicenseTypePHState {
  return {
    ...createBaseState(baseState?.auth, baseState?.document),
    global: createGlobalState(globalState),
    local: createLocalState(localState),
  };
}

/**
 * Creates a AppLicenseTypeDocument with custom global and local state
 * This properly handles the PHBaseState requirements while allowing
 * document-specific state to be set.
 */
export function createAppLicenseTypeDocument(
  state?: Partial<{
    auth?: Partial<PHAuthState>;
    document?: Partial<PHDocumentState>;
    global?: Partial<AppLicenseTypeGlobalState>;
    local?: Partial<AppLicenseTypeLocalState>;
  }>,
): AppLicenseTypeDocument {
  const document = utils.createDocument(
    createState(
      createBaseState(state?.auth, { version: 1, ...state?.document }),
      state?.global,
      state?.local,
    ),
  );

  return document;
}
