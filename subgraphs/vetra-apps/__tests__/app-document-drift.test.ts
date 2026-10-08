import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeHarness, seedActiveApp, type Harness } from "./harness.js";
import { appDocumentActions, appDocumentFacts } from "../app-document.js";
import { reducer, utils } from "../../../document-models/vetra-app/v1/index.js";
import { reportAppDocumentDrift } from "../app-document-drift.js";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.close();
});

const rowOf = (id: string) =>
  h.db
    .selectFrom("apps")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirstOrThrow();

/** The document state an app in sync would have. */
const inSync = async (id: string) =>
  appDocumentFacts(await rowOf(id)) as unknown as Record<string, unknown>;

describe("reportAppDocumentDrift", () => {
  it("reports no drift when the document agrees with the row", async () => {
    const app = await seedActiveApp(h);
    const state = await inSync(app.id);

    const out = await reportAppDocumentDrift({
      db: h.db,
      docs: { getState: async () => state },
      logger: { warn: vi.fn() },
    });

    expect(out).toEqual({ checked: 1, drifted: [] });
  });

  it("reports an app whose document disagrees with its row", async () => {
    const app = await seedActiveApp(h);
    const state = { ...(await inSync(app.id)), name: "WRONG" };
    const warn = vi.fn();

    const out = await reportAppDocumentDrift({
      db: h.db,
      docs: { getState: async () => state },
      logger: { warn },
    });

    expect(out.drifted).toStrictEqual([app.id]);
    expect(warn.mock.calls.flat().join(" ")).toContain("name");
  });

  // The groups are what a patch-shaped mirror would have silently nulled, so
  // drift has to see inside them, not just compare top-level scalars.
  it("sees drift inside a nested group", async () => {
    const app = await seedActiveApp(h);
    const state = await inSync(app.id);
    const warn = vi.fn();

    const out = await reportAppDocumentDrift({
      db: h.db,
      docs: {
        getState: async () => ({
          ...state,
          repository: {
            ...(state.repository as object),
            productionBranch: "not-main",
          },
        }),
      },
      logger: { warn },
    });

    expect(out.drifted).toStrictEqual([app.id]);
    expect(warn.mock.calls.flat().join(" ")).toContain("repository");
  });

  it("counts a missing document as drift rather than crashing", async () => {
    await seedActiveApp(h);

    const out = await reportAppDocumentDrift({
      db: h.db,
      docs: { getState: async () => null },
      logger: { warn: vi.fn() },
    });

    expect(out.checked).toBe(1);
    expect(out.drifted).toHaveLength(1);
  });

  it("keeps sweeping when one document cannot be read", async () => {
    const first = await seedActiveApp(h);
    // One App per repository, so the second row is cloned straight into the table.
    const row = await rowOf(first.id);
    const second = { ...row, id: "app-2", slug: "second" };
    await h.db.insertInto("apps").values(second).execute();

    const out = await reportAppDocumentDrift({
      db: h.db,
      docs: {
        getState: async (id: string) => {
          if (id === first.id) throw new Error("reactor down");
          return await inSync(second.id);
        },
      },
      logger: { warn: vi.fn() },
    });

    expect(out.checked).toBe(2);
    expect(out.drifted).toStrictEqual([first.id]);
  });

  // Log, never repair: silent repair would hide the write bug that caused it.
  it("never writes to the document or the row", async () => {
    const app = await seedActiveApp(h);
    const before = await rowOf(app.id);
    const docs = {
      getState: async () => ({ ...(await inSync(app.id)), name: "WRONG" }),
      create: vi.fn(),
      execute: vi.fn(),
    };

    await reportAppDocumentDrift({
      db: h.db,
      docs,
      logger: { warn: vi.fn() },
    });

    expect(docs.create).not.toHaveBeenCalled();
    expect(docs.execute).not.toHaveBeenCalled();
    expect(await rowOf(app.id)).toStrictEqual(before);
  });
});

// The payoff: what the dual-write actually writes must read back as zero drift.
// The test above compares the row against itself; this one runs the mirror's
// real actions through the real reducer and checks the resulting document.
describe("the dual-write leaves no drift", () => {
  it("sees no drift in a document built by the mirror's own actions", async () => {
    const app = await seedActiveApp(h);
    const row = await rowOf(app.id);

    let doc = utils.createDocument();
    for (const action of appDocumentActions(row)) {
      doc = reducer(doc, action);
      expect(doc.operations.global.at(-1)?.error).toBeUndefined();
    }

    const out = await reportAppDocumentDrift({
      db: h.db,
      docs: {
        getState: async () =>
          doc.state.global as unknown as Record<string, unknown>,
      },
      logger: { warn: vi.fn() },
    });

    expect(out).toEqual({ checked: 1, drifted: [] });
  });
});
