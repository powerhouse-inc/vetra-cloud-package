import {
  activateLicense,
  expireLicense,
  issueLicense,
  reducer,
  replaceLicense,
  revokeLicense,
  utils,
} from "document-models/app-owner-license/v1";
import { describe, expect, it } from "vitest";

const issue = (over: Partial<Parameters<typeof issueLicense>[0]> = {}) =>
  issueLicense({
    app: "app-1",
    licenseType: "type-1",
    user: "0x1111111111111111111111111111111111111111",
    issuer: "PUBLISHER_GRANT",
    issuedBy: "0x2222222222222222222222222222222222222222",
    stage: null,
    details: null,
    issued: "2026-10-06T00:00:00.000Z",
    start: "2026-10-06T00:00:00.000Z",
    end: "2027-10-06T00:00:00.000Z",
    ...over,
  });

const issued = () => reducer(utils.createDocument(), issue());

describe("AppOwnerLicense lifecycle", () => {
  it("starts as ISSUED with no holder", () => {
    const doc = utils.createDocument();
    expect(doc.state.global.status).toBe("ISSUED");
    expect(doc.state.global.user).toBeNull();
  });

  it("issues and lowercases the holder and issuer addresses", () => {
    const doc = reducer(
      utils.createDocument(),
      issue({
        user: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        issuedBy: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        stage: "stage-1",
        details: '{"seats":3}',
      }),
    );
    expect(doc.operations.global[0].error).toBeUndefined();
    expect(doc.state.global.status).toBe("ISSUED");
    expect(doc.state.global.user).toBe(
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(doc.state.global.issuedBy).toBe(
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    expect(doc.state.global).toMatchObject({
      app: "app-1",
      licenseType: "type-1",
      issuer: "PUBLISHER_GRANT",
      stage: "stage-1",
      details: '{"seats":3}',
      issued: "2026-10-06T00:00:00.000Z",
      start: "2026-10-06T00:00:00.000Z",
      end: "2027-10-06T00:00:00.000Z",
    });
  });

  it("issues an open-ended license without an end date", () => {
    const doc = reducer(utils.createDocument(), issue({ end: undefined }));
    expect(doc.operations.global[0].error).toBeUndefined();
    expect(doc.state.global.end).toBeNull();
  });

  it("walks ISSUED to ACTIVE to EXPIRED", () => {
    let doc = issued();
    doc = reducer(doc, activateLicense({ _: true }));
    expect(doc.state.global.status).toBe("ACTIVE");
    doc = reducer(doc, expireLicense({ _: true }));
    expect(doc.state.global.status).toBe("EXPIRED");
  });

  it("records a revocation reason", () => {
    let doc = issued();
    doc = reducer(doc, activateLicense({ _: true }));
    doc = reducer(doc, revokeLicense({ reason: "non-payment" }));
    expect(doc.state.global.status).toBe("REVOKED");
    expect(doc.state.global.revokedReason).toBe("non-payment");
  });

  it("revokes without a reason", () => {
    const doc = reducer(issued(), revokeLicense({}));
    expect(doc.state.global.status).toBe("REVOKED");
    expect(doc.state.global.revokedReason).toBeNull();
  });

  it("permits ISSUED to EXPIRED without activating first", () => {
    const doc = reducer(issued(), expireLicense({ _: true }));
    expect(doc.operations.global[1].error).toBeUndefined();
    expect(doc.state.global.status).toBe("EXPIRED");
  });

  it("rejects expiring a license that is not live", () => {
    let doc = issued();
    doc = reducer(doc, revokeLicense({ reason: "x" }));
    const before = doc.state.global;
    doc = reducer(doc, expireLicense({ _: true }));
    expect(doc.operations.global[2].error).toBe(
      "cannot expire a license with status REVOKED",
    );
    expect(doc.state.global).toEqual(before);
  });

  it("treats EXPIRED as terminal", () => {
    let doc = issued();
    doc = reducer(doc, activateLicense({ _: true }));
    doc = reducer(doc, expireLicense({ _: true }));
    const before = doc.state.global;
    doc = reducer(doc, activateLicense({ _: true }));
    expect(doc.operations.global[3].error).toBe(
      "cannot activate a license with status EXPIRED",
    );
    expect(doc.state.global).toEqual(before);
    expect(doc.state.global.status).toBe("EXPIRED");
  });

  it("rejects revoking a license that is already terminal", () => {
    let doc = issued();
    doc = reducer(doc, expireLicense({ _: true }));
    const before = doc.state.global;
    doc = reducer(doc, revokeLicense({ reason: "late" }));
    expect(doc.operations.global[2].error).toBe(
      "cannot revoke a license with status EXPIRED",
    );
    expect(doc.state.global).toEqual(before);
  });

  it("refuses a second issue", () => {
    let doc = issued();
    const before = doc.state.global;
    doc = reducer(doc, issue());
    expect(doc.operations.global[1].error).toBe(
      "this license is already issued",
    );
    expect(doc.state.global).toEqual(before);
  });

  it("refuses an end date before the start date", () => {
    const before = utils.createDocument().state.global;
    const doc = reducer(
      utils.createDocument(),
      issue({
        start: "2027-01-01T00:00:00.000Z",
        end: "2026-01-01T00:00:00.000Z",
      }),
    );
    expect(doc.operations.global[0].error).toBe("end must not precede start");
    expect(doc.state.global).toEqual(before);
  });

  it("records the replacement", () => {
    let doc = issued();
    doc = reducer(doc, activateLicense({ _: true }));
    doc = reducer(doc, replaceLicense({ replacedBy: "lic-2" }));
    expect(doc.state.global.status).toBe("REPLACED");
    expect(doc.state.global.replacedBy).toBe("lic-2");
  });

  it("refuses to replace a license that is not active", () => {
    let doc = issued();
    const before = doc.state.global;
    doc = reducer(doc, replaceLicense({ replacedBy: "lic-2" }));
    expect(doc.operations.global[1].error).toBe(
      "cannot replace a license with status ISSUED",
    );
    expect(doc.state.global).toEqual(before);
  });
});
