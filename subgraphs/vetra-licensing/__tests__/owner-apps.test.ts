import { describe, expect, it, vi } from "vitest";
import { createOwnerAppLookup } from "../owner-apps.js";
import type { AppDocView } from "../app-reads.js";
import { STUDIO_APP_ID } from "../studio-app.js";
import type { OwnerAppRecord } from "../publisher-auth.js";

const doc = (id: string, owner: string | null, over: Partial<AppDocView> = {}): AppDocView => ({
  id, name: `doc ${id}`, slug: id, owner, status: "ACTIVE", identityDid: null,
  productionEnvironmentId: null, templates: [], terms: [], artifacts: [], tampered: false, tamperReason: null, licensingStateHash: "h", unverified: true, ...over,
});

const ROW: OwnerAppRecord = { id: "row-app", name: "row", status: "ACTIVE", owner_address: "0xa" };

// Documents anyone could have written: a forged app claiming 0xvictim, a row
// app whose document drifted to another owner, and the studio document
// claiming an attacker owns it.
const DOCS: Record<string, AppDocView> = {
  forged: doc("forged", "0xvictim"),
  "row-app": doc("row-app", "0xb"),
  [STUDIO_APP_ID]: doc(STUDIO_APP_ID, "0xattacker", { name: "Vetra Studio", status: "SUSPENDED" }),
};

const make = (over: { studioPublisher?: string | null; app?: (id: string) => Promise<AppDocView | null> } = {}) =>
  createOwnerAppLookup({
    table: {
      byId: async (id) => (id === "row-app" ? ROW : null),
      byOwner: async (a) => (a === "0xa" ? [ROW] : []),
    },
    apps: { app: over.app ?? (async (id) => DOCS[id] ?? null) },
    studioPublisher: over.studioPublisher === undefined ? "0xstudio" : over.studioPublisher,
  });

describe("owner lookup", () => {
  it("prefers the table row: its owner wins over a drifted document", async () => {
    expect(await make().findAppById("row-app")).toStrictEqual(ROW);
  });

  it("never trusts a forged document's owner: an id with no row is unknown", async () => {
    expect(await make().findAppById("forged")).toBeNull();
    expect(await make().findAppById("nope")).toBeNull();
  });

  it("does not list a forged document in its claimed owner's apps", async () => {
    expect(await make().listAppsForOwner("0xvictim")).toStrictEqual([]);
    expect((await make().listAppsForOwner("0xa")).map((a) => a.id)).toStrictEqual(["row-app"]);
  });

  it("resolves the studio app to the configured publisher, ACTIVE, ignoring document owner and status", async () => {
    expect(await make().findAppById(STUDIO_APP_ID)).toStrictEqual({
      id: STUDIO_APP_ID, name: "Vetra Studio", status: "ACTIVE", owner_address: "0xstudio",
    });
  });

  it("lists the studio app only for the studio publisher", async () => {
    expect((await make().listAppsForOwner("0xSTUDIO")).map((a) => a.id)).toStrictEqual([STUDIO_APP_ID]);
    expect(await make().listAppsForOwner("0xattacker")).toStrictEqual([]);
  });

  it("leaves the studio app unknown when no publisher is configured or its document is missing", async () => {
    expect(await make({ studioPublisher: null }).findAppById(STUDIO_APP_ID)).toBeNull();
    const missing = make({ app: async () => null });
    expect(await missing.findAppById(STUDIO_APP_ID)).toBeNull();
    expect(await missing.listAppsForOwner("0xstudio")).toStrictEqual([]);
  });

  it("rethrows a document read error rather than reading the studio app as unknown", async () => {
    const failing = make({ app: async () => { throw new Error("reactor down"); } });
    await expect(failing.findAppById(STUDIO_APP_ID)).rejects.toThrow("reactor down");
  });

  it("keeps the publisher's table rows when the studio document read fails", async () => {
    const warn = vi.fn();
    const lookup = createOwnerAppLookup({
      table: { byId: async () => null, byOwner: async () => [{ ...ROW, owner_address: "0xstudio" }] },
      apps: { app: async () => { throw new Error("reactor down"); } },
      studioPublisher: "0xstudio",
      logger: { warn },
    });
    expect((await lookup.listAppsForOwner("0xstudio")).map((a) => a.id)).toStrictEqual(["row-app"]);
    expect(warn).toHaveBeenCalledOnce();
  });
});
