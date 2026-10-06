import { describe, it, expect, vi } from "vitest";
import type { Action } from "document-model";
import {
  issuePublisherGrant,
  LicenseTypeNotIssuableError,
  NotOnAllowListError,
} from "../issuers/publisher-grant.js";

const deps = (
  allow: string[],
  validityDays: number | null = 365,
  type: Partial<{ status: string; app: string }> = {},
) => ({
  isOnAllowList: vi.fn(async (_app: string, addr: string) =>
    allow.includes(addr),
  ),
  getLicenseType: vi.fn(async () => ({
    id: "type-1",
    app: "app-1",
    status: "ACTIVE",
    validityDays,
    ...type,
  })),
  createLicenseDocument: vi.fn(async () => "lic-1"),
  execute: vi.fn(async (_id: string, _actions: Action[]) => undefined),
});

const input = {
  appId: "app-1",
  licenseTypeId: "type-1",
  user: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  issuedBy: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  now: "2026-10-06T00:00:00.000Z",
};

describe("issuePublisherGrant", () => {
  it("issues with an end date derived from validityDays", async () => {
    const d = deps(["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]);
    await expect(issuePublisherGrant(d, input)).resolves.toBe("lic-1");
    expect(d.execute.mock.calls[0][0]).toBe("lic-1");
    const action = d.execute.mock.calls[0][1][0] as Action & {
      input: Record<string, unknown>;
    };
    expect(action.type).toBe("ISSUE_LICENSE");
    expect(action.input.start).toBe("2026-10-06T00:00:00.000Z");
    expect(action.input.issued).toBe("2026-10-06T00:00:00.000Z");
    expect(action.input.end).toBe("2027-10-06T00:00:00.000Z");
    expect(action.input.issuer).toBe("PUBLISHER_GRANT");
    expect(action.input.user).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(action.input.issuedBy).toBe("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(action.input.licenseType).toBe("type-1");
  });

  it("issues an open-ended licence when validityDays is null", async () => {
    const d = deps(["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"], null);
    await issuePublisherGrant(d, input);
    const action = d.execute.mock.calls[0][1][0] as Action & {
      input: { end: unknown };
    };
    expect(action.input.end).toBeNull();
  });

  it("normalises a non-canonical now to fixed-width UTC Z", async () => {
    const d = deps(["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"], 1);
    await issuePublisherGrant(d, { ...input, now: "2026-10-06T02:00:00+02:00" });
    const action = d.execute.mock.calls[0][1][0] as Action & {
      input: { start: string; end: string };
    };
    expect(action.input.start).toBe("2026-10-06T00:00:00.000Z");
    expect(action.input.end).toBe("2026-10-07T00:00:00.000Z");
  });

  it("refuses a user who is not on the allow list", async () => {
    const d = deps([]);
    await expect(issuePublisherGrant(d, input)).rejects.toBeInstanceOf(
      NotOnAllowListError,
    );
    expect(d.createLicenseDocument).not.toHaveBeenCalled();
  });

  it("refuses a retired licence type", async () => {
    const d = deps(["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"], 365, { status: "RETIRED" });
    await expect(issuePublisherGrant(d, input)).rejects.toBeInstanceOf(
      LicenseTypeNotIssuableError,
    );
    expect(d.createLicenseDocument).not.toHaveBeenCalled();
  });

  it("refuses a licence type that belongs to another app", async () => {
    const d = deps(["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"], 365, { app: "app-2" });
    await expect(issuePublisherGrant(d, input)).rejects.toBeInstanceOf(
      LicenseTypeNotIssuableError,
    );
  });
});
