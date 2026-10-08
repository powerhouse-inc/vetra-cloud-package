import type { Action } from "document-model";
import { createPresignedHeader } from "document-model";
import { utils } from "../../document-models/vetra-app/v1/index.js";
import type { AppDocStore } from "./app-document.js";
import { isDocumentNotFound } from "./envs.js";
import {
  appendAppOps,
  type AppStateLedger,
} from "../vetra-licensing/licensing-ledger.js";

export const APP_DOC_TYPE = "powerhouse/vetra-app";

type ReactorClientLike = {
  create(document: unknown): Promise<unknown>;
  execute(id: string, branch: string, actions: Action[]): Promise<unknown>;
  get(id: string): Promise<unknown>;
  getOperations(
    id: string,
    view?: { branch?: string; scopes?: string[] },
    filter?: { sinceRevision?: number },
    paging?: { cursor: string; limit: number },
  ): Promise<{ results: unknown[]; nextCursor?: string }>;
};

type DocLike = {
  header?: { revision?: Record<string, number> };
  state?: { global?: Record<string, unknown> };
};
type OpLike = { error?: string; action?: { id?: string; type?: string } };

/**
 * The reactor-backed store for app documents.
 *
 * The document id IS the app id. `createEmpty` cannot choose one, so the
 * document is built locally with a presigned header carrying the app's id and
 * handed to `create`. Every environments link, deployment row and licence grant
 * resolves on that id.
 */
export function createReactorAppDocStore(
  client: ReactorClientLike,
  /**
   * Makes a new document system-write-only (see app-doc-protection.ts).
   * Absent when document permissions are off. Callers run it AFTER populating
   * the document, so a failure never leaves an empty document behind.
   */
  protect?: (id: string) => Promise<void>,
  /**
   * The app-state ledger (licensing-ledger.ts). With it, `create` records the
   * state it created and every `execute` goes through appendAppOps, so the
   * backfill, the row mirror and CI artifact registration all leave the
   * document verifiably clean. Without it (tests, no licensing) nothing is
   * recorded.
   */
  ledger?: AppStateLedger,
  logger: Pick<Console, "error"> = console,
): AppDocStore {
  async function getDoc(id: string): Promise<DocLike | null> {
    try {
      return (await client.get(id)) as DocLike;
    } catch (err) {
      if (isDocumentNotFound(err)) return null;
      throw err;
    }
  }

  return {
    async create(id) {
      const doc = utils.createDocument();
      doc.header = createPresignedHeader(id, APP_DOC_TYPE);
      await client.create(doc);
      // Record exactly what was created, not a re-read: a write landing
      // between create and a re-read would otherwise be recorded as ours.
      await ledger?.record(id, doc.state.global);
    },
    protect,
    async exists(id) {
      return (await getDoc(id)) !== null;
    },
    async getState(id) {
      return (await getDoc(id))?.state?.global ?? null;
    },
    async execute(id, actions) {
      if (!ledger) return executeChecked(id, actions);
      await appendAppOps(
        {
          execute: executeChecked,
          getState: async (appId) => (await getDoc(appId))?.state?.global ?? null,
          ledger,
          logger,
        },
        id,
        actions,
        // A document this store did not create and that was never recorded
        // stays unverified: recording it now could launder a foreign change.
        { seedUnrecorded: false },
      );
    },
  };

  async function executeChecked(id: string, actions: Action[]): Promise<void> {
    const before = await getDoc(id);
    if (!before) throw new Error(`app document ${id} not found`);
    const sinceRevision = before.header?.revision?.global ?? 0;
    // execute() returns a view without operations: a reducer rejection is
    // only visible on the appended operation itself.
    await client.execute(id, "main", actions);
    const ids = new Set(actions.map((a) => a.id).filter(Boolean));
    const res = await client.getOperations(
      id,
      { branch: "main", scopes: ["global"] },
      { sinceRevision },
      { cursor: "0", limit: 200 },
    );
    const failed = (res.results as OpLike[]).find(
      (op) => op.error && op.action?.id && ids.has(op.action.id),
    );
    if (failed) {
      throw new Error(
        `${failed.action?.type ?? "action"} rejected: ${failed.error}`,
      );
    }
  }
}
