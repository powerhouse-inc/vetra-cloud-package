import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Action } from "document-model";
import { makeHarness, owner, seedActiveApp, type Harness } from "./harness.js";
import { deleteApp, updateApp } from "../service.js";
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
    await mirrorAppToDocument(
      { db: h.db, docs, logger: { warn: vi.fn() } },
      "a1",
      [setStatus({ status: "DISCONNECTED" }) as Action],
    );
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

describe("dual-write", () => {
  const names = (docs: ReturnType<typeof fakeDocs>, at = -1) =>
    docs.executed.at(at)!.actions.map((a) => a.type);

  it("mirrors the row's current facts, not just the column that changed", async () => {
    const app = await seedActiveApp(h);
    const docs = fakeDocs(new Set([app.id]));
    h.deps.docs = docs;

    await updateApp(h.deps, owner, app.id, { name: "renamed" });

    expect(docs.executed).toHaveLength(1);
    // CONNECT_REPOSITORY / SET_IDENTITY / SET_PREVIEWS replace their group
    // wholesale, so a patch-shaped mirror would null what the patch left alone.
    expect(names(docs)).toStrictEqual([
      "SET_APP_DETAILS",
      "CONNECT_REPOSITORY",
      "SET_IDENTITY",
      "SET_PREVIEWS",
      "SET_PRODUCTION_ENVIRONMENT",
      "SET_STATUS",
    ]);
    const details = docs.executed[0]!.actions[0] as unknown as {
      input: { name: string; slug: string };
    };
    expect(details.input.name).toBe("renamed");
    expect(details.input.slug).toBe(app.slug);
  });

  it("creates the document first when it is missing", async () => {
    const app = await seedActiveApp(h);
    const docs = fakeDocs();
    h.deps.docs = docs;

    await updateApp(h.deps, owner, app.id, { name: "healed" });

    expect(docs.created).toStrictEqual([app.id]);
    expect(docs.executed).toHaveLength(1);
  });

  it("mirrors the DELETED status when an app is deleted", async () => {
    const app = await seedActiveApp(h);
    const docs = fakeDocs(new Set([app.id]));
    h.deps.docs = docs;

    await deleteApp(h.deps, owner, app.id, true);

    const status = docs.executed.at(-1)!.actions.at(-1) as unknown as {
      input: { status: string };
    };
    expect(status.input.status).toBe("DELETED");
  });

  // Reads are still served from the table in this step, so a reactor outage
  // must not fail the user's request.
  it("still updates the app when the document write throws", async () => {
    const app = await seedActiveApp(h);
    h.deps.docs = {
      async create() {},
      async exists() {
        return true;
      },
      async execute() {
        throw new Error("reactor down");
      },
    };

    const updated = await updateApp(h.deps, owner, app.id, { name: "kept" });
    expect(updated.name).toBe("kept");
  });

  it("does not mirror at all when no document store is wired", async () => {
    const app = await seedActiveApp(h);
    h.deps.docs = null;
    const updated = await updateApp(h.deps, owner, app.id, { name: "no-docs" });
    expect(updated.name).toBe("no-docs");
  });
});
