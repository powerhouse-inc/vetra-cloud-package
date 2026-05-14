/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 * Factory methods for creating VetraCloudEnvironmentDocument instances
 */
import type { PHAuthState, PHBaseState, PHDocumentState } from "document-model";
import { createBaseState, defaultBaseState } from "document-model";
import type {
  VetraCloudEnvironmentDocument,
  VetraCloudEnvironmentGlobalState,
  VetraCloudEnvironmentLocalState,
  VetraCloudEnvironmentPHState,
} from "./types.js";
import { utils } from "./utils.js";

export function defaultGlobalState(): VetraCloudEnvironmentGlobalState {
  return {
    owner: null,
    ownerDrive: null,
    label: null,
    genericSubdomain: null,
    genericBaseDomain: null,
    customDomain: {
      enabled: false,
      domain: null,
      dnsRecords: [],
    },
    defaultPackageRegistry: null,
    services: [],
    packages: [],
    status: "DRAFT",
    apexService: null,
    autoUpdateChannel: null,
  };
}

export function defaultLocalState(): VetraCloudEnvironmentLocalState {
  return {};
}

export function defaultPHState(): VetraCloudEnvironmentPHState {
  return {
    ...defaultBaseState(),
    global: defaultGlobalState(),
    local: defaultLocalState(),
  };
}

export function createGlobalState(
  state?: Partial<VetraCloudEnvironmentGlobalState>,
): VetraCloudEnvironmentGlobalState {
  return {
    ...defaultGlobalState(),
    ...(state || {}),
  };
}

export function createLocalState(
  state?: Partial<VetraCloudEnvironmentLocalState>,
): VetraCloudEnvironmentLocalState {
  return {
    ...defaultLocalState(),
    ...(state || {}),
  } as VetraCloudEnvironmentLocalState;
}

export function createState(
  baseState?: Partial<PHBaseState>,
  globalState?: Partial<VetraCloudEnvironmentGlobalState>,
  localState?: Partial<VetraCloudEnvironmentLocalState>,
): VetraCloudEnvironmentPHState {
  return {
    ...createBaseState(baseState?.auth, baseState?.document),
    global: createGlobalState(globalState),
    local: createLocalState(localState),
  };
}

/**
 * Creates a VetraCloudEnvironmentDocument with custom global and local state
 * This properly handles the PHBaseState requirements while allowing
 * document-specific state to be set.
 */
export function createVetraCloudEnvironmentDocument(
  state?: Partial<{
    auth?: Partial<PHAuthState>;
    document?: Partial<PHDocumentState>;
    global?: Partial<VetraCloudEnvironmentGlobalState>;
    local?: Partial<VetraCloudEnvironmentLocalState>;
  }>,
): VetraCloudEnvironmentDocument {
  const document = utils.createDocument(
    state
      ? createState(
          createBaseState(state.auth, state.document),
          state.global,
          state.local,
        )
      : undefined,
  );

  return document;
}
