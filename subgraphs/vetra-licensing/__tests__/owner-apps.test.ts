import { describe, expect, it, vi } from "vitest";
import { createOwnerAppLookup } from "../owner-apps.js";
import type { AppDocView } from "../app-reads.js";

const doc = (id: string, owner: string | null, over: Partial<AppDocView> = {}): AppDocView => ({
  id, name: `doc ${id}`, slug: id, owner, status: "ACTIVE", identityDid: null,
  productionEnvironmentId: null, templates: [], terms: [], artifacts: [], ...over,
});

const lookup = createOwnerAppLookup({
  table: {
    byId: async (id) => (id === "row-app" ? { id, name: "row", status: "ACTIVE", owner_address: "0xa" } : null),
    byOwner: async (a) => (a === "0xa" ? [{ id: "row-app", name: "row", status: "ACTIVE", owner_address: "0xa" }] : []),
  },
  apps: {
    app: async (id) => (id === "studio" ? doc("studio", "0xa") : id === "row-app" ? doc("row-app", "0xb") : id === "ownerless" ? doc("ownerless", null) : null),
    appsOwnedBy: async (a) => (a === "0xa" ? [doc("studio", "0xa"), doc("row-app", "0xb")] : []),
  },
});

describe("owner lookup", () => {
  it("prefers the table row: its owner wins over a drifted document", async () => {
    expect(await lookup.findAppById("row-app")).toMatchObject({ owner_address: "0xa", name: "row" });
  });
  it("falls back to the document for a document-only app", async () => {
    expect(await lookup.findAppById("studio")).toStrictEqual({ id: "studio", name: "doc studio", status: "ACTIVE", owner_address: "0xa" });
  });
  it("never resolves an ownerless document as owned", async () => {
    expect(await lookup.findAppById("ownerless")).toMatchObject({ owner_address: "" });
    expect(await lookup.findAppById("nope")).toBeNull();
  });
  it("lists table rows plus document-only apps, without duplicates", async () => {
    expect((await lookup.listAppsForOwner("0xa")).map((a) => a.id)).toStrictEqual(["row-app", "studio"]);
  });
  it("keeps the table rows when the document scan fails", async () => {
    const warn = vi.fn();
    const failing = createOwnerAppLookup({
      table: {
        byId: async () => null,
        byOwner: async () => [{ id: "row-app", name: "row", status: "ACTIVE", owner_address: "0xa" }],
      },
      apps: {
        app: async () => null,
        appsOwnedBy: async () => { throw new Error("reactor down"); },
      },
      logger: { warn },
    });
    expect((await failing.listAppsForOwner("0xa")).map((a) => a.id)).toStrictEqual(["row-app"]);
    expect(warn).toHaveBeenCalledOnce();
  });
});
