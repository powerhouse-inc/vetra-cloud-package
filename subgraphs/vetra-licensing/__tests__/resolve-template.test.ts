import { describe, expect, it } from "vitest";
import { resolveTemplateForLicence } from "../resolve-template.js";
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
