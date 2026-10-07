import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { ReactorBuilder, ReactorClientBuilder } from "@powerhousedao/reactor";
import { documentModels } from "../../../document-models/document-models.js";
import {
  createReactorEnvGateway,
  ENV_DOC_TYPE,
} from "../../vetra-apps/envs.js";
import { generateSubdomain } from "../../../shared/subdomain-generator.js";
import { up } from "../db/migrations.js";
import type { AppUserEnvironments, VetraLicensingDB } from "../db/schema.js";
import {
  applyEnvironmentTemplate,
  AppEnvironmentCapReachedError,
  UNAPPLIED_TEMPLATE_HASH,
  type ProvisionDeps,
} from "../provision.js";
import { templateHash, type TemplateShape } from "../template.js";

/**
 * The provisioning half of the licensing slice, against a REAL reactor and a
 * REAL relational database (in-memory PGlite -- no Postgres, no switchboard).
 *
 * This is where both Criticals of the final review lived, and both were
 * invisible because every test mocked the environment gateway to a stub that
 * always resolved:
 *
 *   C1 - a rejected action list leaked one environment document per tick,
 *        because the document was created before anything referenced it.
 *   C2 - the update path replayed INITIALIZE / SET_OWNER, which the environment
 *        reducer rejects once a document is initialised and owned, so a template
 *        change could never have applied at all.
 *
 * Here the environment documents are real and the reducers really run, so both
 * failure modes are observable.
 */

const APP = "app-provision";
const USER = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
const USER_LC = USER.toLowerCase();
const NOW = "2026-06-01T12:00:00.000Z";

const template = (packageName: string): TemplateShape => ({
  services: [{ id: "svc-1", type: "CONNECT", prefix: null }],
  packages: [{ id: "pkg-1", packageName, version: "1.0.0" }],
  size: null,
  baseDomain: null,
  packageRegistry: null,
});

const TEMPLATE_A = template("@powerhousedao/knowledge-note");
const TEMPLATE_B = template("@powerhousedao/other-package");

type Client = Awaited<ReturnType<ReactorClientBuilder["build"]>>;

describe("applyEnvironmentTemplate against a real reactor + real database", () => {
  let client: Client;
  let db: Kysely<VetraLicensingDB>;
  let deps: ProvisionDeps;
  /** Set to make the next envs.execute throw, simulating a reducer rejection. */
  let failNextExecute = false;

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

    const envs = createReactorEnvGateway(client as never);

    deps = {
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
      maxForApp: (appId) =>
        db
          .selectFrom("app_environment_limits")
          .select("max_environments")
          .where("app_id", "=", appId)
          .executeTakeFirst()
          .then((r) => r?.max_environments ?? 50),
      claimRow: async (input: AppUserEnvironments) => {
        const row = { ...input, user_address: input.user_address.toLowerCase() };
        await db
          .insertInto("app_user_environments")
          .values(row)
          .onConflict((oc) =>
            oc.columns(["app_id", "user_address"]).doNothing(),
          )
          .execute();
        return db
          .selectFrom("app_user_environments")
          .selectAll()
          .where("app_id", "=", row.app_id)
          .where("user_address", "=", row.user_address)
          .executeTakeFirstOrThrow();
      },
      upsertRow: async (input: AppUserEnvironments) => {
        const row = { ...input, user_address: input.user_address.toLowerCase() };
        await db
          .insertInto("app_user_environments")
          .values(row)
          .onConflict((oc) =>
            oc.columns(["app_id", "user_address"]).doUpdateSet({
              license_id: row.license_id,
              template_hash: row.template_hash,
              updated_at: row.updated_at,
            }),
          )
          .execute();
        return db
          .selectFrom("app_user_environments")
          .selectAll()
          .where("app_id", "=", row.app_id)
          .where("user_address", "=", row.user_address)
          .executeTakeFirstOrThrow();
      },
      envs: {
        ...envs,
        // Real gateway, with an injectable transient failure so a rejected
        // action list can be observed. Everything else stays real.
        execute: async (id, actions) => {
          if (failNextExecute) {
            failNextExecute = false;
            throw new Error("simulated reducer rejection");
          }
          return envs.execute(id, actions);
        },
      },
      generateSubdomain,
    };
  }, 120_000);

  beforeEach(async () => {
    failNextExecute = false;
    await db.deleteFrom("app_user_environments").execute();
    await db.deleteFrom("app_environment_limits").execute();
  });

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

  const apply = (t: TemplateShape, licenseId = "lic-1") =>
    applyEnvironmentTemplate(deps, {
      appId: APP,
      user: USER,
      licenseId,
      template: t,
      label: "Knowledge Vault",
      now: NOW,
    });

  it("creates a real environment document with the template applied", async () => {
    const before = await countEnvDocuments();
    const row = await apply(TEMPLATE_A);

    expect(row.app_id).toBe(APP);
    expect(row.user_address).toBe(USER_LC);
    expect(row.template_hash).toBe(templateHash(TEMPLATE_A));
    expect(row.environment_id).toBeTruthy();
    expect(await countEnvDocuments()).toBe(before + 1);

    // The document really exists and the reducers really ran.
    const state = await deps.envs.getState(row.environment_id);
    expect(state).not.toBeNull();
    expect(state!.status).not.toBe("DRAFT");
    expect(state!.owner?.toLowerCase()).toBe(USER_LC);
    expect(state!.services.map((s) => s.type)).toContain("CONNECT");
    // NOTE the rename across this boundary: a TEMPLATE package carries
    // `packageName`, and validateTemplate maps it to the environment's `name`.
    expect(state!.packages.map((p) => p.name)).toContain(
      "@powerhousedao/knowledge-note",
    );
    expect(state!.packages.map((p) => p.version)).toContain("1.0.0");
  }, 120_000);

  it("is a no-op on a second call: no second environment document", async () => {
    const first = await apply(TEMPLATE_A);
    const afterFirst = await countEnvDocuments();

    const second = await apply(TEMPLATE_A);

    expect(second.environment_id).toBe(first.environment_id);
    expect(second.template_hash).toBe(first.template_hash);
    expect(await countEnvDocuments()).toBe(afterFirst);
  }, 120_000);

  it("C2: a template change applies through the update path", async () => {
    const first = await apply(TEMPLATE_A);
    const afterFirst = await countEnvDocuments();

    // Before the fix this threw: the update path replayed INITIALIZE and
    // SET_OWNER, which the reducer rejects on an initialised, owned document.
    const second = await apply(TEMPLATE_B);

    expect(second.environment_id).toBe(first.environment_id);
    expect(second.template_hash).toBe(templateHash(TEMPLATE_B));
    expect(second.template_hash).not.toBe(first.template_hash);
    expect(await countEnvDocuments()).toBe(afterFirst);

    const state = await deps.envs.getState(second.environment_id);
    expect(state!.packages.map((p) => p.name)).toContain(
      "@powerhousedao/other-package",
    );
  }, 120_000);

  it("C1: a rejected action list does not leak an environment per retry", async () => {
    const before = await countEnvDocuments();

    failNextExecute = true;
    await expect(apply(TEMPLATE_A)).rejects.toThrow(
      "simulated reducer rejection",
    );

    // The document was claimed before the action list ran, so the row remembers
    // it and it is left at DRAFT rather than orphaned.
    const claimed = await deps.findRow(APP, USER);
    expect(claimed).not.toBeNull();
    expect(claimed!.template_hash).toBe(UNAPPLIED_TEMPLATE_HASH);
    expect(await countEnvDocuments()).toBe(before + 1);

    // The retry REUSES that document instead of creating a second one.
    const row = await apply(TEMPLATE_A);
    expect(row.environment_id).toBe(claimed!.environment_id);
    expect(row.template_hash).toBe(templateHash(TEMPLATE_A));
    expect(await countEnvDocuments()).toBe(before + 1);
  }, 120_000);

  it("enforces the per-app cap on the create path only", async () => {
    await db
      .insertInto("app_environment_limits")
      .values({ app_id: APP, max_environments: 1 })
      .execute();

    await apply(TEMPLATE_A);
    const afterFirst = await countEnvDocuments();

    // A different user on the same app is refused once the ceiling is reached.
    await expect(
      applyEnvironmentTemplate(deps, {
        appId: APP,
        user: "0x1111111111111111111111111111111111111111",
        licenseId: "lic-2",
        template: TEMPLATE_A,
        label: "Second",
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(AppEnvironmentCapReachedError);

    // Refused before creating anything.
    expect(await countEnvDocuments()).toBe(afterFirst);

    // The existing user is NOT refused -- the cap applies to creates only.
    await expect(apply(TEMPLATE_A)).resolves.toBeTruthy();
  }, 120_000);
});
