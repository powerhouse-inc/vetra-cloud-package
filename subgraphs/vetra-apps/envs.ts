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
  getOperations(
    id: string,
    view?: { branch?: string; scopes?: string[] },
    filter?: { sinceRevision?: number },
    paging?: { cursor: string; limit: number },
  ): Promise<{ results: unknown[]; nextCursor?: string }>;
  deleteDocument(id: string): Promise<unknown>;
};

type DocLike = {
  header?: { revision?: Record<string, number> };
  state?: { global?: VetraCloudEnvironmentState };
};

type OpLike = {
  index?: number;
  error?: string;
  action?: { id?: string; type?: string };
};

/**
 * The reactor's "this document does not exist (any more)" errors:
 * DocumentNotFoundError / DocumentDeletedError, or the document view's
 * plain "Document not found: <id>" when resolving an id.
 */
export function isDocumentNotFound(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (
    err.name === "DocumentNotFoundError" ||
    err.name === "DocumentDeletedError"
  )
    return true;
  return /^Document not found: |^Document \S+ (not found|has been deleted|was deleted at)/.test(
    err.message,
  );
}

export function createReactorEnvGateway(client: ReactorClientLike): EnvGateway {
  async function getDoc(documentId: string): Promise<DocLike | null> {
    try {
      return (await client.get(documentId)) as DocLike;
    } catch (err) {
      if (isDocumentNotFound(err)) return null;
      throw err;
    }
  }

  return {
    async create() {
      const doc = await client.createEmpty(ENV_DOC_TYPE, {});
      return (doc.header as { id: string }).id;
    },
    async execute(documentId, actions) {
      const before = await getDoc(documentId);
      if (!before) throw new Error(`environment ${documentId} not found`);
      const sinceRevision = before.header?.revision?.global ?? 0;
      // execute() returns a view without operations: reducer rejections are
      // only visible in the appended operations themselves.
      await client.execute(documentId, "main", actions);
      const ids = new Set(actions.map((a) => a.id).filter(Boolean));
      const appended: OpLike[] = [];
      let cursor = "0";
      for (let page = 0; page < 20; page++) {
        const res = await client.getOperations(
          documentId,
          { branch: "main", scopes: ["global"] },
          { sinceRevision },
          { cursor, limit: 200 },
        );
        appended.push(...(res.results as OpLike[]));
        if (!res.nextCursor || res.results.length === 0) break;
        cursor = res.nextCursor;
      }
      const mine = appended.filter(
        (op) => op.action?.id && ids.has(op.action.id),
      );
      const failed = mine.find((op) => op.error);
      if (failed) {
        throw new Error(
          `${failed.action?.type ?? "action"} rejected: ${failed.error}`,
        );
      }
      if (ids.size > 0 && mine.length < ids.size) {
        throw new Error(
          `only ${mine.length} of ${ids.size} actions were applied to ${documentId}`,
        );
      }
      const after = await getDoc(documentId);
      const state = after?.state?.global;
      if (!state) throw new Error(`environment ${documentId} has no state`);
      return state;
    },
    async getState(documentId) {
      return (await getDoc(documentId))?.state?.global ?? null;
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
