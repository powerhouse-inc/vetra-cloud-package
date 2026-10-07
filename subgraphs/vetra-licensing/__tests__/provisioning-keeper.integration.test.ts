import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { ReactorBuilder, ReactorClientBuilder } from "@powerhousedao/reactor";
import { actions as typeActions } from "document-models/app-license-type";
import { actions as licenseActions } from "document-models/app-owner-license";
import { documentModels } from "../../../document-models/document-models.js";
import {
  createReactorEnvGateway,
  ENV_DOC_TYPE,
} from "../../vetra-apps/envs.js";
import { generateSubdomain } from "../../../shared/subdomain-generator.js";
import { up } from "../db/migrations.js";
import type { VetraLicensingDB } from "../db/schema.js";
import { createReactorLicenseReads, LICENSE_DOC_TYPE } from "../reads.js";
import { createReactorLicenseGateway } from "../license-gateway.js";
import { createReactorLicenseTypeGateway } from "../license-type-gateway.js";
import { applyEnvironmentTemplate, type ProvisionDeps } from "../provision.js";
import { createEnvironmentRows } from "../rows.js";
import {
  createTypeSnapshots,
  resolveTemplateForLicence,
} from "../resolve-template.js";
import { releaseEnvironment } from "../release.js";
import { ProvisioningKeeper } from "../provisioning-keeper.js";
import { templateHash, type TemplateShape } from "../template.js";
import type { LicensingConfig } from "../config.js";

/**
 * The provisioning keeper against a REAL reactor and a REAL database (in-memory
 * PGlite). The reads, both gateways, the environment gateway, the reducers, the
 * row operations (createEnvironmentRows) and template resolution
 * (resolveTemplateForLicence, createTypeSnapshots) are the production ones.
 * What is still supplied here: the release step's two row helpers (inline in
 * index.ts, not extracted) and the "stop" step of a release, a recorder,
 * because it needs the deployment processor to have made the environment READY,
 * which does not run in a reactor-only test.
 */

const APP = "app-keeper-integration";
const USER = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
const USER_LC = USER.toLowerCase();
const NOW = "2026-06-01T12:00:00.000Z";
const START = "2026-05-01T00:00:00.000Z";

const PKG = "@powerhousedao/knowledge-note";
const TEMPLATE: TemplateShape = {
  services: [{ id: "svc-1", type: "CONNECT", prefix: null }],
  packages: [{ id: "pkg-1", packageName: PKG, version: "1.0.0" }],
  size: null,
  baseDomain: null,
  packageRegistry: null,
};

const cfg: LicensingConfig = {
  enabled: true,
  dryRun: false,
  scanIntervalMs: 1_000,
  defaultMaxEnvironments: 50,
};
const silent = { info: () => {}, warn: () => {} };

type Client = Awaited<ReturnType<ReactorClientBuilder["build"]>>;

describe("ProvisioningKeeper against a real reactor + real database", () => {
  let client: Client;
  let db: Kysely<VetraLicensingDB>;
  let keeper: ProvisioningKeeper;
  let licenseGateway: ReturnType<typeof createReactorLicenseGateway>;
  let envs: ReturnType<typeof createReactorEnvGateway>;
  let typeId: string;
  const stopped: string[] = [];
  /** Full licence-type scans made by the keeper wiring. */
  let typeScans = 0;

  const rows = () =>
    db
      .selectFrom("app_user_environments")
      .selectAll()
      .where("app_id", "=", APP)
      .execute();

  const countEnvDocuments = async (): Promise<number> => {
    let cursor = "0";
    let n = 0;
    for (let page = 0; page < 20; page++) {
      const res = await (
        client as unknown as {
          find(
            s: object,
            v?: unknown,
            p?: object,
          ): Promise<{ results: unknown[]; nextCursor?: string }>;
        }
      ).find({ type: ENV_DOC_TYPE }, undefined, { cursor, limit: 200 });
      n += res.results.length;
      if (!res.nextCursor || res.nextCursor === cursor) break;
      cursor = res.nextCursor;
    }
    return n;
  };

  beforeAll(async () => {
    client = await new ReactorClientBuilder()
      .withReactorBuilder(
        new ReactorBuilder().withDocumentModelSources([...documentModels]),
      )
      .build();

    db = new Kysely<VetraLicensingDB>({
      dialect: new PGliteDialect(new PGlite()),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await up(db as Kysely<any>);

    envs = createReactorEnvGateway(client as never);
    licenseGateway = createReactorLicenseGateway(client as never);
    const typeGateway = createReactorLicenseTypeGateway(client as never);
    const reads = createReactorLicenseReads(client as never);

    // A real, published licence type holding TEMPLATE.
    typeId = await typeGateway.create();
    await typeGateway.execute(typeId, [
      typeActions.setLicenseTypeDetails({
        app: APP,
        kind: "PRO",
        label: "Pro",
        validityDays: null,
      }),
      typeActions.setTemplate({
        size: null,
        baseDomain: null,
        packageRegistry: null,
      }),
      typeActions.addTemplateService({
        id: "svc-1",
        type: "CONNECT",
        prefix: null,
      }),
      typeActions.addTemplatePackage({
        id: "pkg-1",
        packageName: PKG,
        version: "1.0.0",
      }),
      typeActions.publishLicenseType({}),
    ]);

    // The production row operations, not copies: the lowercasing at the
    // database boundary and the per-app cap are what is being exercised.
    const provision: ProvisionDeps = {
      ...createEnvironmentRows(db, cfg),
      envs,
      generateSubdomain,
    };

    // The production snapshot and resolution, wrapped only to count scans.
    const typeSnapshots = createTypeSnapshots({
      licenseTypeDetails: (appId) => {
        typeScans += 1;
        return reads.licenseTypeDetails(appId);
      },
    });

    keeper = new ProvisioningKeeper({
      allLicenses: () => reads.allLicenses(),
      authorizedLicenseIds: async (appId: string) =>
        new Set(
          (await reads.allLicenses())
            .filter((r) => r.app === appId)
            .map((r) => r.id),
        ),
      licenseTypes: typeSnapshots.licenseTypes,
      environments: async (appId) =>
        (
          await db
            .selectFrom("app_user_environments")
            .selectAll()
            .where("app_id", "=", appId)
            .execute()
        ).map((r) => ({
          user: r.user_address,
          environmentId: r.environment_id,
          licenseId: r.license_id,
          templateHash: r.template_hash,
        })),
      applyFor: async (appId, licence) => {
        const resolved = resolveTemplateForLicence(
          await typeSnapshots.detailsFor(appId),
          licence,
        );
        if (!resolved.ok) throw new Error(resolved.reason);
        await applyEnvironmentTemplate(provision, {
          appId,
          user: licence.user,
          licenseId: licence.licenseId,
          template: resolved.template,
          label: resolved.label,
          now: NOW,
        });
      },
      releaseFor: async (appId, environmentId) => {
        await releaseEnvironment(
          {
            findRowByEnvironment: (id) =>
              db
                .selectFrom("app_user_environments")
                .selectAll()
                .where("environment_id", "=", id)
                .executeTakeFirst()
                .then((r) => r ?? null),
            environmentStatus: async (id) =>
              (await envs.getState(id))?.status ?? null,
            stopEnvironment: async (id) => {
              stopped.push(id);
            },
            deleteRow: async (a, u) => {
              await db
                .deleteFrom("app_user_environments")
                .where("app_id", "=", a)
                .where("user_address", "=", u.toLowerCase())
                .execute();
            },
            deleteEnvironment: (id) => envs.delete(id),
            logger: silent,
          },
          appId,
          environmentId,
        );
      },
      cfg,
      logger: silent,
    });
  }, 120_000);

  afterAll(async () => {
    const c = client as unknown as { shutdown?: () => Promise<void> };
    await c.shutdown?.();
  });

  async function grantActive(): Promise<string> {
    const doc = await client.createEmpty(LICENSE_DOC_TYPE);
    const id = (doc as { header: { id: string } }).header.id;
    await licenseGateway.execute(id, [
      licenseActions.issueLicense({
        app: APP,
        licenseType: typeId,
        user: USER,
        issuer: "PUBLISHER_GRANT",
        issuedBy: USER,
        stage: null,
        details: null,
        issued: START,
        start: START,
        end: null,
      }),
    ]);
    await licenseGateway.activate(id);
    return id;
  }

  it("provisions a real environment for an active licence, is idempotent, and releases on revoke", async () => {
    const before = await countEnvDocuments();
    const licenceId = await grantActive();

    // The hash the keeper reads from the licence type must equal the hash of
    // the template applyFor writes, or every tick would re-apply.
    expect(
      (await createReactorLicenseReads(client as never).licenseTypes(APP))[0]
        ?.templateHash,
    ).toBe(templateHash(TEMPLATE));

    typeScans = 0;
    await keeper.reconcileOnce();
    // One app, one apply: one licence-type scan, not one per apply as well.
    expect(typeScans).toBe(1);

    const created = await rows();
    expect(created).toHaveLength(1);
    expect(created[0].user_address).toBe(USER_LC);
    expect(created[0].license_id).toBe(licenceId);
    expect(created[0].template_hash).toBe(templateHash(TEMPLATE));
    expect(await countEnvDocuments()).toBe(before + 1);

    const state = await envs.getState(created[0].environment_id);
    expect(state).not.toBeNull();
    expect(state!.status).not.toBe("DRAFT");
    expect(state!.owner?.toLowerCase()).toBe(USER_LC);
    expect(state!.services.map((s) => s.type)).toContain("CONNECT");
    // TEMPLATE's `packageName` maps to the environment package's `name`.
    expect(state!.packages.map((p) => p.name)).toContain(PKG);

    // A second tick changes nothing: same row, no new document.
    await keeper.reconcileOnce();
    const again = await rows();
    expect(again).toHaveLength(1);
    expect(again[0].environment_id).toBe(created[0].environment_id);
    expect(await countEnvDocuments()).toBe(before + 1);
    expect(stopped).toEqual([]);

    // Revoke: the app now has no active licence at all, and the tick still
    // releases its environment.
    await licenseGateway.execute(licenceId, [
      licenseActions.revokeLicense({ reason: "test" }),
    ]);
    await keeper.reconcileOnce();

    expect(await rows()).toHaveLength(0);
    expect(stopped).toEqual([created[0].environment_id]);
    // Released, never destroyed: the document is still there.
    expect(await countEnvDocuments()).toBe(before + 1);
    expect(await envs.getState(created[0].environment_id)).not.toBeNull();
  }, 120_000);
});
