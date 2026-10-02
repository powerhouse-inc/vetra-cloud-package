import type { Action } from "document-model";
import {
  reducer,
  utils,
} from "../../../document-models/vetra-cloud-environment/v1/index.js";

type Doc = ReturnType<typeof utils.createDocument>;

/**
 * Mirrors the real ReactorClient where it matters here: execute() returns a
 * view whose `operations` is EMPTY (reducer errors are only visible through
 * getOperations), get() of a missing/deleted doc throws the reactor's
 * not-found errors, and arbitrary ids can be made to fail transiently.
 */
export class FakeReactorClient {
  docs = new Map<string, Doc>();
  deleted = new Set<string>();
  transient = new Set<string>();
  /** Action types the "reducer" rejects (simulates a reducer error). */
  rejectTypes = new Set<string>();
  private seq = 0;

  private view(id: string, doc: Doc) {
    return {
      header: {
        ...doc.header,
        id,
        revision: { global: doc.operations.global.length },
      },
      state: doc.state,
      operations: {},
    };
  }

  private load(id: string): Doc {
    if (this.transient.has(id))
      throw new Error("connection terminated unexpectedly");
    if (this.deleted.has(id)) {
      const e = new Error(`Document not found: ${id}`);
      throw e;
    }
    const doc = this.docs.get(id);
    if (!doc) {
      const e = new Error(`Document ${id} not found`);
      e.name = "DocumentNotFoundError";
      throw e;
    }
    return doc;
  }

  async createEmpty() {
    const id = `doc-${++this.seq}`;
    this.docs.set(id, utils.createDocument());
    return { header: { id } };
  }

  async execute(id: string, _branch: string, actions: Action[]) {
    let doc = this.load(id);
    for (const a of actions) {
      if (this.rejectTypes.has(a.type)) {
        // Same shape as a reducer rejection: the op is appended with `error`.
        const index = doc.operations.global.length;
        doc = {
          ...doc,
          operations: {
            ...doc.operations,
            global: [
              ...doc.operations.global,
              {
                ...doc.operations.global.at(-1),
                index,
                action: a,
                error: `${a.type} is not allowed now`,
              } as never,
            ],
          },
        };
        continue;
      }
      doc = reducer(doc, a as never);
    }
    this.docs.set(id, doc);
    return this.view(id, doc);
  }

  async get(id: string) {
    return this.view(id, this.load(id));
  }

  async getOperations(
    id: string,
    _view?: unknown,
    filter?: { sinceRevision?: number },
  ) {
    const doc = this.load(id);
    const since = filter?.sinceRevision ?? 0;
    return {
      results: doc.operations.global.filter((op) => op.index >= since),
      options: { cursor: "0", limit: 100 },
    };
  }

  async deleteDocument(id: string) {
    this.load(id);
    this.deleted.add(id);
  }

  opTypes(id: string): string[] {
    return (this.docs.get(id)?.operations.global ?? []).map(
      (o) => o.action.type,
    );
  }
}
