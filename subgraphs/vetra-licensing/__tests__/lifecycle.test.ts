import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { actions } from "document-models/app-owner-license";
import { up } from "../db/migrations.js";
import type { VetraLicensingDB } from "../db/schema.js";
import { createLifecycleStore, lifecycleOf } from "../lifecycle.js";

const issue = (end: string | null) =>
  actions.issueLicense({
    app: "a", user: "did:pkh:eip155:1:0x1111111111111111111111111111111111111111", issuer: "PUBLISHER_GRANT",
    kind: "pro", stage: null, details: null, issued: "2026-10-08T00:00:00.000Z", start: "2026-10-08T00:00:00.000Z", end,
  });

describe("lifecycleOf", () => {
  it("is the final status of the batch, from the actions sent", () => {
    expect(lifecycleOf([issue("2026-11-07T00:00:00.000Z"), actions.activateLicense({})]))
      .toStrictEqual({ status: "ACTIVE", end: "2026-11-07T00:00:00.000Z" });
    expect(lifecycleOf([issue(null)])).toStrictEqual({ status: "ISSUED", end: null });
    expect(lifecycleOf([actions.activateLicense({})])).toStrictEqual({ status: "ACTIVE" });
    expect(lifecycleOf([actions.expireLicense({})])).toStrictEqual({ status: "EXPIRED" });
    expect(lifecycleOf([actions.revokeLicense({ reason: "x" })])).toStrictEqual({ status: "REVOKED" });
    expect(lifecycleOf([actions.replaceLicense({ replacedBy: "l2" })])).toStrictEqual({ status: "REPLACED", replacedBy: "l2" });
  });
  it("is null for a batch without a lifecycle action", () => {
    expect(lifecycleOf([actions.setStage({ stage: "e" })])).toBeNull();
    expect(lifecycleOf([])).toBeNull();
  });
});

describe("lifecycle store", () => {
  let db: Kysely<VetraLicensingDB> | undefined;
  afterEach(async () => { await db?.destroy(); db = undefined; });

  it("records the status after each write, keeping the issued end", async () => {
    db = new Kysely<VetraLicensingDB>({ dialect: new PGliteDialect(new PGlite()) });
    await up(db as Kysely<any>);
    let t = 0;
    const store = createLifecycleStore(db, () => `t${++t}`);
    await store.record("l1", [issue("2026-11-07T00:00:00.000Z"), actions.activateLicense({})]);
    await store.record("l1", [actions.setStage({ stage: "e" })]);
    await store.record("l1", [actions.replaceLicense({ replacedBy: "l2" })]);
    await store.record("l2", [actions.expireLicense({})]);
    expect(await db.selectFrom("license_lifecycle").selectAll().orderBy("license_id").execute()).toStrictEqual([
      { license_id: "l1", status: "REPLACED", end_at: "2026-11-07T00:00:00.000Z", replaced_by: "l2", updated_at: "t2" },
      { license_id: "l2", status: "EXPIRED", end_at: null, replaced_by: null, updated_at: "t3" },
    ]);
    expect(await store.all()).toStrictEqual(new Map([
      ["l1", { status: "REPLACED", replacedBy: "l2" }],
      ["l2", { status: "EXPIRED", replacedBy: null }],
    ]));
    expect(await store.forIds(["l2", "nope"])).toStrictEqual(new Map([["l2", { status: "EXPIRED", replacedBy: null }]]));
    expect(await store.forIds([])).toStrictEqual(new Map());
    expect(await store.get("l1")).toStrictEqual({ status: "REPLACED", replacedBy: "l2" });
    expect(await store.get("nope")).toBeNull();
  });
});
