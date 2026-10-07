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
import type { AppUserEnvironments, VetraLicensingDB } from "../db/schema.js";
import { createReactorLicenseReads, LICENSE_DOC_TYPE } from "../reads.js";
import { createReactorLicenseGateway } from "../license-gateway.js";
import { createReactorLicenseTypeGateway } from "../license-type-gateway.js";
import { applyEnvironmentTemplate, type ProvisionDeps } from "../provision.js";
import { releaseEnvironment } from "../release.js";
import { ProvisioningKeeper } from "../provisioning-keeper.js";
import { templateHash, type TemplateShape } from "../template.js";
import type { LicensingConfig } from "../config.js";

/**
 * The provisioning keeper against a REAL reactor and a REAL database (in-memory
 * PGlite). The reads, both gateways, the environment gateway and the reducers
 * are all real; only the two things the Task 9 wiring owns are supplied here:
 * resolving a template hash back to a TemplateShape, and the "stop" step of a
 * release (it needs the deployment processor to have made the environment
 * READY, which does not run in a reactor-only test).
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

    const provision: ProvisionDeps = {
      findRow: (appId, user) =>
        db
          .selectFrom("app_user_environments")
          .selectAll()
          .where("app_id", "=", appId)
          .where("user_address", "=", user.toLowerCase())
          .executeTakeFirst()
          .then((r) => r ?? null),
      countForApp: (appId) =>
        db
          .selectFrom("app_user_environments")
          .select((eb) => eb.fn.countAll<number>().as("n"))
          .where("app_id", "=", appId)
          .executeTakeFirstOrThrow()
          .then((r) => Number(r.n)),
      maxForApp: async () => cfg.defaultMaxEnvironments,
      claimRow: async (input: AppUserEnvironments) => {
        await db
          .insertInto("app_user_environments")
          .values(input)
          .onConflict((oc) =>
            oc.columns(["app_id", "user_address"]).doNothing(),
          )
          .execute();
        return db
          .selectFrom("app_user_environments")
          .selectAll()
          .where("app_id", "=", input.app_id)
          .where("user_address", "=", input.user_address)
          .executeTakeFirstOrThrow();
      },
      upsertRow: async (input: AppUserEnvironments) => {
        await db
          .insertInto("app_user_environments")
          .values(input)
          .onConflict((oc) =>
            oc.columns(["app_id", "user_address"]).doUpdateSet({
              license_id: input.license_id,
              template_hash: input.template_hash,
              updated_at: input.updated_at,
            }),
          )
          .execute();
        return db
          .selectFrom("app_user_environments")
          .selectAll()
          .where("app_id", "=", input.app_id)
          .where("user_address", "=", input.user_address)
          .executeTakeFirstOrThrow();
      },
      envs,
      generateSubdomain,
    };

    // The wiring's job, done by hand: the test holds the template it created.
    const templates = new Map([[typeId, TEMPLATE]]);

    keeper = new ProvisioningKeeper({
      allLicenses: () => reads.allLicenses(),
      licenseTypes: (appId) => reads.licenseTypes(appId),
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
        await applyEnvironmentTemplate(provision, {
          appId,
          user: licence.user,
          licenseId: licence.licenseId,
          template: templates.get(licence.licenseTypeId) ?? null,
          label: "Pro",
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
                .where("user_address", "=", u)
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

    await keeper.reconcileOnce();

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
