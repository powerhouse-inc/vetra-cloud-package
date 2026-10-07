/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 * Factory methods for creating VetraAppDocument instances
 */
import type { PHAuthState, PHBaseState, PHDocumentState } from "document-model";
import { createBaseState, defaultBaseState } from "document-model";
import type {
  VetraAppDocument,
  VetraAppGlobalState,
  VetraAppLocalState,
  VetraAppPHState,
} from "./types.js";
import { utils } from "./utils.js";

export function defaultGlobalState(): VetraAppGlobalState {
  return {
    name: null,
    slug: null,
    owner: null,
    status: "PENDING_IDENTITY",
    repository: null,
    identity: null,
    productionEnvironmentId: null,
    previews: null,
    artifacts: [],
  };
}

export function defaultLocalState(): VetraAppLocalState {
  return {};
}

export function defaultPHState(): VetraAppPHState {
  return {
    ...defaultBaseState(),
    global: defaultGlobalState(),
    local: defaultLocalState(),
  };
}

export function createGlobalState(
  state?: Partial<VetraAppGlobalState>,
): VetraAppGlobalState {
  return {
    ...defaultGlobalState(),
    ...(state || {}),
  };
}

export function createLocalState(
  state?: Partial<VetraAppLocalState>,
): VetraAppLocalState {
  return {
    ...defaultLocalState(),
    ...(state || {}),
  } as VetraAppLocalState;
}

export function createState(
  baseState?: Partial<PHBaseState>,
  globalState?: Partial<VetraAppGlobalState>,
  localState?: Partial<VetraAppLocalState>,
): VetraAppPHState {
  return {
    ...createBaseState(baseState?.auth, baseState?.document),
    global: createGlobalState(globalState),
    local: createLocalState(localState),
  };
}

/**
 * Creates a VetraAppDocument with custom global and local state
 * This properly handles the PHBaseState requirements while allowing
 * document-specific state to be set.
 */
export function createVetraAppDocument(
  state?: Partial<{
    auth?: Partial<PHAuthState>;
    document?: Partial<PHDocumentState>;
    global?: Partial<VetraAppGlobalState>;
    local?: Partial<VetraAppLocalState>;
  }>,
): VetraAppDocument {
  const document = utils.createDocument(
    createState(
      createBaseState(state?.auth, { version: 1, ...state?.document }),
      state?.global,
      state?.local,
    ),
  );

  return document;
}
