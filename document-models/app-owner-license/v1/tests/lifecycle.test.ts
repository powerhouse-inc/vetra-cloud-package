import {
  activateLicense,
  expireLicense,
  IssueLicenseInputSchema,
  issueLicense,
  migrateLicense,
  reducer,
  replaceLicense,
  revokeLicense,
  setStage,
  utils,
} from "document-models/app-owner-license/v1";
import { describe, expect, it } from "vitest";

const DID = "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";
type Doc = ReturnType<typeof utils.createDocument>;
const err = (doc: Doc) => doc.operations.global.at(-1)?.error;

const issue = (over: Partial<Parameters<typeof issueLicense>[0]> = {}) =>
  issueLicense({
    app: "app-1",
    user: DID,
    issuer: "PUBLISHER_GRANT",
    kind: "2026-pro",
    stage: null,
    details: '{"grantedBy":"0x2222222222222222222222222222222222222222"}',
    issued: "2026-10-06T00:00:00.000Z",
    start: "2026-10-06T00:00:00.000Z",
    end: "2027-10-06T00:00:00.000Z",
    ...over,
  });
const issued = () => reducer(utils.createDocument(), issue());
const LEGACY_USER = "0x1111111111111111111111111111111111111111";
const LEGACY_BY = "0x2222222222222222222222222222222222222222";

describe("AppOwnerLicense lifecycle", () => {
  it("starts as ISSUED with no holder and no kind", () => {
    const g = utils.createDocument().state.global;
    expect(g.status).toBe("ISSUED");
    expect(g.user).toBeNull();
    expect(g.kind).toBeNull();
  });

  it("issues onto a kind and lowercases the DID", () => {
    const doc = reducer(
      utils.createDocument(),
      issue({
        user: "did:pkh:eip155:1:0xAbCdEf0123456789aBcDeF0123456789AbCdEf01",
      }),
    );
    expect(err(doc)).toBeUndefined();
    expect(doc.state.global).toMatchObject({
      user: "did:pkh:eip155:1:0xabcdef0123456789abcdef0123456789abcdef01",
      kind: "2026-pro",
      stage: null,
      end: "2027-10-06T00:00:00.000Z",
    });
  });

  it("inherits a stage given at issue (an upgrade keeps its environment)", () => {
    const doc = reducer(
      utils.createDocument(),
      issue({ stage: "env-1", end: null, details: null }),
    );
    expect(doc.state.global).toMatchObject({
      stage: "env-1",
      end: null,
      details: null,
    });
  });

  it("replays a pre-terms ISSUE_LICENSE into details", () => {
    const doc = reducer(
      utils.createDocument(),
      issue({
        kind: null,
        details: null,
        licenseType: "type-1",
        issuedBy: LEGACY_BY,
        user: LEGACY_USER,
      }),
    );
    expect(err(doc)).toBeUndefined();
    expect(doc.state.global.kind).toBeNull();
    expect(JSON.parse(doc.state.global.details ?? "null")).toStrictEqual({
      legacyLicenseType: "type-1",
      issuedBy: LEGACY_BY,
    });
  });

  it("still parses a production-shaped legacy ISSUE_LICENSE input", () => {
    const legacyInput = {
      app: "app-1",
      licenseType: "type-1",
      user: LEGACY_USER,
      issuer: "PUBLISHER_GRANT",
      issuedBy: LEGACY_BY,
      stage: null,
      details: null,
      issued: "2026-10-01T00:00:00.000Z",
      start: "2026-10-01T00:00:00.000Z",
      end: null,
    };
    const parsed = IssueLicenseInputSchema().parse(legacyInput);
    const doc = reducer(utils.createDocument(), issueLicense(parsed));
    expect(err(doc)).toBeUndefined();
    expect(doc.state.global).toMatchObject({ user: LEGACY_USER, kind: null });
  });

  it("replays a legacy issue without issuedBy", () => {
    const doc = reducer(
      utils.createDocument(),
      issue({ kind: null, details: null, licenseType: "type-1" }),
    );
    expect(JSON.parse(doc.state.global.details ?? "null")).toStrictEqual({
      legacyLicenseType: "type-1",
      issuedBy: null,
    });
  });

  it("refuses an issue with neither kind nor licence type", () => {
    const doc = reducer(utils.createDocument(), issue({ kind: null }));
    expect(err(doc)).toBe("a licence needs a kind");
    expect(doc.state.global.user).toBeNull();
  });

  it("refuses a second issue and an end before start", () => {
    expect(err(reducer(issued(), issue()))).toBe(
      "this license is already issued",
    );
    expect(
      err(
        reducer(
          utils.createDocument(),
          issue({ end: "2026-01-01T00:00:00.000Z" }),
        ),
      ),
    ).toBe("end must not precede start");
  });

  it("walks ISSUED -> ACTIVE -> REPLACED and guards every transition", () => {
    const active = reducer(issued(), activateLicense({}));
    expect(active.state.global.status).toBe("ACTIVE");
    expect(err(reducer(active, activateLicense({})))).toBe(
      "cannot activate a license with status ACTIVE",
    );
    const replaced = reducer(active, replaceLicense({ replacedBy: "lic-2" }));
    expect(replaced.state.global).toMatchObject({
      status: "REPLACED",
      replacedBy: "lic-2",
    });
    expect(err(reducer(replaced, expireLicense({})))).toBe(
      "cannot expire a license with status REPLACED",
    );
    expect(err(reducer(replaced, revokeLicense({ reason: null })))).toBe(
      "cannot revoke a license with status REPLACED",
    );
    expect(err(reducer(issued(), replaceLicense({ replacedBy: "x" })))).toBe(
      "cannot replace a license with status ISSUED",
    );
  });

  it("expires and revokes from ISSUED or ACTIVE", () => {
    expect(reducer(issued(), expireLicense({})).state.global.status).toBe(
      "EXPIRED",
    );
    const revoked = reducer(
      reducer(issued(), activateLicense({})),
      revokeLicense({ reason: "cancelled by owner" }),
    );
    expect(revoked.state.global).toMatchObject({
      status: "REVOKED",
      revokedReason: "cancelled by owner",
    });
    expect(
      reducer(issued(), revokeLicense({})).state.global.revokedReason,
    ).toBeNull();
  });

  it("sets and clears the stage, only once issued", () => {
    const staged = reducer(issued(), setStage({ stage: "env-9" }));
    expect(staged.state.global.stage).toBe("env-9");
    expect(
      reducer(staged, setStage({ stage: null })).state.global.stage,
    ).toBeNull();
    expect(
      err(reducer(utils.createDocument(), setStage({ stage: "env-9" }))),
    ).toBe("this license has not been issued");
  });

  it("migrates a legacy licence once", () => {
    const legacy = reducer(
      utils.createDocument(),
      issue({
        kind: null,
        details: null,
        licenseType: "type-1",
        user: LEGACY_USER,
      }),
    );
    const migrated = reducer(
      legacy,
      migrateLicense({
        kind: "2026-pro",
        user: DID.toUpperCase().replace("DID:PKH", "did:pkh"),
        details: '{"issuedBy":"0x2"}',
      }),
    );
    expect(err(migrated)).toBeUndefined();
    expect(migrated.state.global).toMatchObject({
      kind: "2026-pro",
      user: DID.toLowerCase(),
      details: '{"issuedBy":"0x2"}',
    });
    expect(
      err(reducer(migrated, migrateLicense({ kind: "x", user: DID }))),
    ).toBe("this license already carries a kind");
    expect(
      reducer(legacy, migrateLicense({ kind: "k", user: DID })).state.global
        .details,
    ).toBeNull();
    expect(
      err(
        reducer(
          utils.createDocument(),
          migrateLicense({ kind: "k", user: DID }),
        ),
      ),
    ).toBe("this license has not been issued");
  });
});
