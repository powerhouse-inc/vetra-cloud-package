import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import {
  createTypeSnapshots,
  resolveTemplateForLicence,
} from "../resolve-template.js";
import type { LicenseTypeDetail } from "../reads.js";

const TEMPLATE = { size: "small", services: [], packages: [] } as never;
const type = (o: Partial<LicenseTypeDetail> = {}): LicenseTypeDetail => ({
  id: "t1",
  kind: "SUBSCRIPTION",
  label: "Pro",
  status: "ACTIVE",
  validityDays: 30,
  templateHash: "h1",
  template: TEMPLATE,
  ...o,
});
const licence = { licenseId: "l1", user: "0xa", licenseTypeId: "t1", templateHash: "h1" };

describe("resolveTemplateForLicence", () => {
  it("resolves the matching type to its template and label", () => {
    expect(
      resolveTemplateForLicence([type({ id: "other" }), type()], licence),
    ).toEqual({ ok: true, template: TEMPLATE, label: "Pro" });
  });

  it("skips, without a template, when the type hash disagrees (stale shape)", () => {
    const r = resolveTemplateForLicence([type({ templateHash: "h2" })], licence);
    expect(r.ok).toBe(false);
    expect(r).not.toHaveProperty("template");
    expect((r as { reason: string }).reason).toMatch(/changed/);
  });

  it("skips rather than throws when the type is absent", () => {
    const r = resolveTemplateForLicence([type({ id: "other" })], licence);
    expect(r).toEqual({ ok: false, reason: "licence type t1 not found" });
  });

  it("falls back to kind when label is null", () => {
    const r = resolveTemplateForLicence([type({ label: null })], licence);
    expect(r).toMatchObject({ ok: true, label: "SUBSCRIPTION" });
  });
});

describe("createTypeSnapshots", () => {
  const reads = () => ({
    licenseTypeDetails: vi.fn(async (appId: string) => [type({ id: `t-${appId}` })]),
  });

  it("serves detailsFor from the snapshot licenseTypes just took: one read per app", async () => {
    const r = reads();
    const s = createTypeSnapshots(r);
    await s.licenseTypes("a");
    await s.detailsFor("a");
    await s.detailsFor("a");
    await s.detailsFor("a");
    expect(r.licenseTypeDetails).toHaveBeenCalledTimes(1);
  });

  it("keeps one snapshot per app", async () => {
    const r = reads();
    const s = createTypeSnapshots(r);
    await s.licenseTypes("a");
    await s.licenseTypes("b");
    expect((await s.detailsFor("a"))[0]?.id).toBe("t-a");
    expect((await s.detailsFor("b"))[0]?.id).toBe("t-b");
    expect(r.licenseTypeDetails).toHaveBeenCalledTimes(2);
  });

  it("a later licenseTypes read replaces the snapshot", async () => {
    const r = reads();
    r.licenseTypeDetails.mockResolvedValueOnce([type({ id: "old" })]);
    const s = createTypeSnapshots(r);
    await s.licenseTypes("a");
    r.licenseTypeDetails.mockResolvedValueOnce([type({ id: "new" })]);
    await s.licenseTypes("a");
    expect((await s.detailsFor("a"))[0]?.id).toBe("new");
  });

  it("reads afresh when no snapshot exists", async () => {
    const r = reads();
    const s = createTypeSnapshots(r);
    expect((await s.detailsFor("a"))[0]?.id).toBe("t-a");
    expect(r.licenseTypeDetails).toHaveBeenCalledTimes(1);
  });
});
