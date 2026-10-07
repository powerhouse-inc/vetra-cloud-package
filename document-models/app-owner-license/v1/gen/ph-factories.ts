/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 * Factory methods for creating AppOwnerLicenseDocument instances
 */
import type { PHAuthState, PHBaseState, PHDocumentState } from "document-model";
import { createBaseState, defaultBaseState } from "document-model";
import type {
  AppOwnerLicenseDocument,
  AppOwnerLicenseGlobalState,
  AppOwnerLicenseLocalState,
  AppOwnerLicensePHState,
} from "./types.js";
import { utils } from "./utils.js";

export function defaultGlobalState(): AppOwnerLicenseGlobalState {
  return {
    app: null,
    licenseType: null,
    user: null,
    issuer: null,
    issuedBy: null,
    stage: null,
    details: null,
    issued: null,
    start: null,
    end: null,
    status: "ISSUED",
    replacedBy: null,
    revokedReason: null,
  };
}

export function defaultLocalState(): AppOwnerLicenseLocalState {
  return {};
}

export function defaultPHState(): AppOwnerLicensePHState {
  return {
    ...defaultBaseState(),
    global: defaultGlobalState(),
    local: defaultLocalState(),
  };
}

export function createGlobalState(
  state?: Partial<AppOwnerLicenseGlobalState>,
): AppOwnerLicenseGlobalState {
  return {
    ...defaultGlobalState(),
    ...(state || {}),
  };
}

export function createLocalState(
  state?: Partial<AppOwnerLicenseLocalState>,
): AppOwnerLicenseLocalState {
  return {
    ...defaultLocalState(),
    ...(state || {}),
  } as AppOwnerLicenseLocalState;
}

export function createState(
  baseState?: Partial<PHBaseState>,
  globalState?: Partial<AppOwnerLicenseGlobalState>,
  localState?: Partial<AppOwnerLicenseLocalState>,
): AppOwnerLicensePHState {
  return {
    ...createBaseState(baseState?.auth, baseState?.document),
    global: createGlobalState(globalState),
    local: createLocalState(localState),
  };
}

/**
 * Creates a AppOwnerLicenseDocument with custom global and local state
 * This properly handles the PHBaseState requirements while allowing
 * document-specific state to be set.
 */
export function createAppOwnerLicenseDocument(
  state?: Partial<{
    auth?: Partial<PHAuthState>;
    document?: Partial<PHDocumentState>;
    global?: Partial<AppOwnerLicenseGlobalState>;
    local?: Partial<AppOwnerLicenseLocalState>;
  }>,
): AppOwnerLicenseDocument {
  const document = utils.createDocument(
    createState(
      createBaseState(state?.auth, { version: 1, ...state?.document }),
      state?.global,
      state?.local,
    ),
  );

  return document;
}
