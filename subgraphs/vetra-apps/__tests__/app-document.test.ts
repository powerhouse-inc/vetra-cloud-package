import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Action } from "document-model";
import { makeHarness, seedActiveApp, type Harness } from "./harness.js";
import { setStatus } from "../../../document-models/vetra-app/v1/index.js";
import {
  appDocumentActions,
  backfillAppDocuments,
  mirrorAppToDocument,
} from "../app-document.js";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.close();
});

const fakeDocs = (existing = new Set<string>()) => ({
  created: [] as string[],
  executed: [] as Array<{ id: string; actions: Action[] }>,
  async create(id: string) {
    this.created.push(id);
    existing.add(id);
  },
  async exists(id: string) {
    return existing.has(id);
  },
  async execute(id: string, actions: Action[]) {
    this.executed.push({ id, actions });
  },
});

describe("backfillAppDocuments", () => {
  it("creates one document per row, using the row's own id", async () => {
    const app = await seedActiveApp(h);
    const docs = fakeDocs();

    expect(
      await backfillAppDocuments({ db: h.db, docs, logger: { warn: vi.fn() } }),
    ).toEqual({ created: 1, skipped: 0 });
    // the id environments, deployments and the licensing gate all resolve on
    expect(docs.created).toStrictEqual([app.id]);
  });

  it("skips a row whose document already exists", async () => {
    const app = await seedActiveApp(h);
    const docs = fakeDocs(new Set([app.id]));

    expect(
      await backfillAppDocuments({ db: h.db, docs, logger: { warn: vi.fn() } }),
    ).toEqual({ created: 0, skipped: 1 });
    expect(docs.executed).toStrictEqual([]);
  });

  it("backfills a DELETED app rather than skipping it", async () => {
    const app = await seedActiveApp(h);
    await h.db
      .updateTable("apps")
      .set({ status: "DELETED" })
      .where("id", "=", app.id)
      .execute();
    const docs = fakeDocs();

    await backfillAppDocuments({ db: h.db, docs, logger: { warn: vi.fn() } });
    expect(docs.created).toStrictEqual([app.id]);
  });

  it("carries NULL columns through as null, never the string 'null'", async () => {
    const app = await seedActiveApp(h);
    await h.db
      .updateTable("apps")
      .set({ identity_expires_at: null, production_environment_id: "" })
      .where("id", "=", app.id)
      .execute();

    const row = await h.db
      .selectFrom("apps")
      .selectAll()
      .where("id", "=", app.id)
      .executeTakeFirstOrThrow();

    const json = JSON.stringify(appDocumentActions(row));
    expect(json).not.toContain('"null"');
    expect(json).not.toContain("undefined");
  });
});

describe("mirrorAppToDocument", () => {
  it("mirrors an app change into the document", async () => {
    const docs = fakeDocs(new Set(["a1"]));
    await mirrorAppToDocument({ db: h.db, docs, logger: { warn: vi.fn() } }, "a1", [
      setStatus({ status: "DISCONNECTED" }) as Action,
    ]);
    expect(docs.executed).toHaveLength(1);
  });

  it("never throws when the document write fails", async () => {
    // Reads are still on the table in this step, so a reactor outage must not
    // fail the user's request.
    const warn = vi.fn();
    const docs = {
      ...fakeDocs(new Set(["a1"])),
      execute: async () => {
        throw new Error("reactor down");
      },
    };
    await expect(
      mirrorAppToDocument({ db: h.db, docs, logger: { warn } }, "a1", [
        setStatus({ status: "ACTIVE" }) as Action,
      ]),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
