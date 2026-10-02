import type { Action } from "document-model";
import type { VetraCloudEnvironmentState } from "../../document-models/vetra-cloud-environment/index.js";
import {
  resolveGenericHost,
  isTypeAtApex,
} from "../../processors/vetra-cloud-environment/gitops.js";

/**
 * Narrow surface over the reactor for environment documents. Every action is
 * system-signed (built without a signer), which is what SET_APP_LINK requires
 * and what lets the vetra-apps subgraph act on an owner's env.
 */
export interface EnvGateway {
  /** Create an empty powerhouse/vetra-cloud-environment document; returns its id. */
  create(): Promise<string>;
  /** Apply actions; throws when any of them is rejected by its reducer. */
  execute(
    documentId: string,
    actions: Action[],
  ): Promise<VetraCloudEnvironmentState>;
  /** Current global state, or null when the document does not exist. */
  getState(documentId: string): Promise<VetraCloudEnvironmentState | null>;
  /** Hard-delete the document (the studio-pool reconciler removes its gitops dir). */
  delete(documentId: string): Promise<void>;
}

export const ENV_DOC_TYPE = "powerhouse/vetra-cloud-environment";

type ReactorClientLike = {
  createEmpty(type: string, options: object): Promise<{ header: unknown }>;
  execute(id: string, branch: string, actions: Action[]): Promise<unknown>;
  get(id: string): Promise<unknown>;
  deleteDocument(id: string): Promise<unknown>;
};

type DocLike = {
  state?: { global?: VetraCloudEnvironmentState };
  operations?: { global?: { error?: string; action?: { type?: string } }[] };
};

export function createReactorEnvGateway(client: ReactorClientLike): EnvGateway {
  return {
    async create() {
      const doc = await client.createEmpty(ENV_DOC_TYPE, {});
      return (doc.header as { id: string }).id;
    },
    async execute(documentId, actions) {
      const doc = (await client.execute(
        documentId,
        "main",
        actions,
      )) as DocLike;
      const ops = doc.operations?.global ?? [];
      const failed = ops.slice(-actions.length).find((op) => op.error);
      if (failed) {
        throw new Error(
          `${failed.action?.type ?? "action"} rejected: ${failed.error}`,
        );
      }
      const state = doc.state?.global;
      if (!state) throw new Error(`environment ${documentId} has no state`);
      return state;
    },
    async getState(documentId) {
      try {
        const doc = (await client.get(documentId)) as DocLike;
        return doc.state?.global ?? null;
      } catch {
        return null;
      }
    },
    async delete(documentId) {
      await client.deleteDocument(documentId);
    },
  };
}

export interface EnvUrls {
  app: string | null;
  connect: string | null;
  switchboard: string | null;
}

/** Public URLs of an environment's enabled Connect / Switchboard / FUSION app. */
export function envUrls(state: VetraCloudEnvironmentState | null): EnvUrls {
  const none = { app: null, connect: null, switchboard: null };
  if (!state?.genericSubdomain) return none;
  const base = state.genericBaseDomain ?? "vetra.io";
  const custom = state.customDomain?.enabled
    ? (state.customDomain.domain ?? null)
    : null;
  const url = (
    type: "CONNECT" | "SWITCHBOARD" | "FUSION",
    fallbackPrefix: string,
  ) => {
    const svc = (state.services ?? []).find(
      (s) => s.type === type && s.enabled,
    );
    if (!svc) return null;
    if (custom && state.apexService === type) return `https://${custom}`;
    return `https://${resolveGenericHost(
      state.genericSubdomain!,
      svc.prefix || fallbackPrefix,
      isTypeAtApex(state, type),
      base,
    )}`;
  };
  return {
    app: url("FUSION", "fusion"),
    connect: url("CONNECT", "connect"),
    switchboard: url("SWITCHBOARD", "switchboard"),
  };
}
