import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { ReactorBuilder, ReactorClientBuilder } from "@powerhousedao/reactor";
import { actions as appActions } from "document-models/vetra-app";
import { documentModels } from "../../../document-models/document-models.js";
import { createReactorAppDocStore } from "../../vetra-apps/app-doc-store.js";
import { up } from "../db/migrations.js";
import type { VetraLicensingDB } from "../db/schema.js";
import { createAppReads } from "../app-reads.js";
import { createReactorLicenseReads } from "../reads.js";
import { createReactorLicenseGateway } from "../license-gateway.js";
import { createGrantStore } from "../grants.js";
import { createLifecycleStore } from "../lifecycle.js";
import { issueLicense } from "../issue.js";

/**
 * Proves the reshaped app-owner-license model accepts what issueLicense sends
 * (ISSUE_LICENSE + ACTIVATE_LICENSE in one batch, then REPLACE_LICENSE), and
 * that terms are read from a real vetra-app document.
 */
const APP = "7d1f6f5c-1f0e-4a8b-9d55-0c3b9b8f2a11";
const DID = "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";

describe("issueLicense against a real reactor", () => {
  let deps: Parameters<typeof issueLicense>[0];
  let reads: ReturnType<typeof createReactorLicenseReads>;
  let db: Kysely<VetraLicensingDB>;

  beforeAll(async () => {
    const client = await new ReactorClientBuilder()
      .withReactorBuilder(new ReactorBuilder().withDocumentModelSources([...documentModels]))
      .build();
    db = new Kysely<VetraLicensingDB>({ dialect: new PGliteDialect(new PGlite()) });
    await up(db as Kysely<any>);
    const appDocs = createReactorAppDocStore(client as never);
    await appDocs.create(APP);
    await appDocs.execute(APP, [
      appActions.addTemplate({ id: "t", name: null, mode: "DEDICATED" }),
      appActions.addTerm({ id: "k", kind: "pro", label: null, templateId: "t", validityDays: 30, issuers: ["PUBLISHER_GRANT"] }),
      appActions.publishTerm({ id: "k" }),
      appActions.addTerm({ id: "k2", kind: "max", label: null, templateId: "t", validityDays: null, issuers: ["PUBLISHER_GRANT"] }),
      appActions.publishTerm({ id: "k2" }),
    ]);
    reads = createReactorLicenseReads(client as never);
    const lifecycle = createLifecycleStore(db, () => "2026-10-08T00:00:00.000Z");
    const gateway = createReactorLicenseGateway(client as never, { lifecycle });
    deps = {
      owners: {
        findAppById: async (id) =>
          id === APP ? { id, name: "KV", status: "ACTIVE", owner_address: "0xowner" } : null,
      },
      apps: createAppReads(client as never),
      licence: (id) => reads.licenceRecord(id),
      createLicenseDocument: gateway.create,
      executeLicence: gateway.execute,
      grants: createGrantStore(db),
      lifecycle,
      logger: console,
    };
  }, 120_000);

  it("creates an ACTIVE licence on the kind, then upgrades it in place", async () => {
    const first = await issueLicense(deps, { appId: APP, user: DID, kind: "pro", issuer: "PUBLISHER_GRANT", details: {}, issuedBy: "0xowner", label: "Project", now: "2026-10-08T00:00:00.000Z" });
    expect(await reads.licenceRecord(first.licenseId)).toMatchObject({
      status: "ACTIVE", kind: "pro", user: DID, issuer: "PUBLISHER_GRANT", end: "2026-11-07T00:00:00.000Z",
    });

    const second = await issueLicense(deps, { appId: APP, user: DID, kind: "max", issuer: "PUBLISHER_GRANT", details: {}, issuedBy: "0xowner", upgrades: first.licenseId, now: "2026-10-09T00:00:00.000Z" });
    expect(second.replaced).toBe(first.licenseId);
    expect(await reads.licenceRecord(first.licenseId)).toMatchObject({ status: "REPLACED", replacedBy: second.licenseId });
    expect(await reads.licenceRecord(second.licenseId)).toMatchObject({ status: "ACTIVE", kind: "max", end: null });
    const chain = await db.selectFrom("license_chain").select(["license_id", "root_license_id", "label"]).orderBy("created_at").execute();
    expect(chain).toStrictEqual([
      { license_id: first.licenseId, root_license_id: first.licenseId, label: "Project" },
      { license_id: second.licenseId, root_license_id: first.licenseId, label: null },
    ]);
  });
});
