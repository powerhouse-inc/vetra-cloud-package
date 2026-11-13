import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { createAppImageProjectResolver } from "./app-image-project.js";
import { up } from "../../subgraphs/vetra-apps/db/migrations.js";
import type { VetraCloudEnvironmentState } from "../../document-models/vetra-cloud-environment/index.js";

let db: Kysely<any>;
beforeEach(() => {
  db = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
});
afterEach(async () => {
  await db.destroy();
});

const linked = (appId: string, imageProject = "app-evil") =>
  ({
    app: { appId, role: "PREVIEW", prNumber: 1, gitRef: null, imageProject },
  }) as unknown as VetraCloudEnvironmentState;

async function seed() {
  await up(db);
  const row = (id: string, project: string, prodEnv: string) => ({
    id,
    slug: id,
    name: id,
    owner_address: "0xa",
    owner_chain_id: 1,
    status: "ACTIVE",
    installation_id: "1",
    repository_id: `r-${id}`,
    repository_full_name: `a/${id}`,
    production_branch: "main",
    production_environment_id: prodEnv,
    previews_enabled: true,
    preview_limit: 5,
    preview_ttl_days: 7,
    harbor_project: project,
    harbor_robot_name: "r",
    harbor_robot_secret_enc: "x",
    identity_did: `did:key:${id}`,
    created_at: "t",
    updated_at: "t",
  });
  await db
    .insertInto("apps")
    .values([
      row("app-1", "app-shop", "prod-env"),
      row("app-2", "app-other", "prod-2"),
    ])
    .execute();
  await db
    .insertInto("app_previews")
    .values({
      app_id: "app-1",
      pr_number: 7,
      environment_id: "preview-env",
      git_ref: null,
      created_at: "t",
      last_deployed_at: "t",
    })
    .execute();
}

describe("createAppImageProjectResolver", () => {
  it("returns null when the vetra-apps tables do not exist yet", async () => {
    const resolve = createAppImageProjectResolver(db);
    expect(await resolve(linked("app-1"), "prod-env")).toBeNull();
  });

  it("returns the App's harbor project for its production and preview envs (ignoring the doc's imageProject)", async () => {
    await seed();
    const resolve = createAppImageProjectResolver(db);
    expect(await resolve(linked("app-1"), "prod-env")).toBe("app-shop");
    expect(await resolve(linked("app-1"), "preview-env")).toBe("app-shop");
  });

  it("keeps allowing the production env of a DELETED App (kept site stays up), not its previews", async () => {
    await seed();
    await db
      .updateTable("apps")
      .set({ status: "DELETED" })
      .where("id", "=", "app-1")
      .execute();
    await db.deleteFrom("app_previews").execute();
    const resolve = createAppImageProjectResolver(db);
    expect(await resolve(linked("app-1"), "prod-env")).toBe("app-shop");
    expect(await resolve(linked("app-1"), "preview-env")).toBeNull();
  });

  it("returns null for forged links: unknown App, another App's id, or an env the App does not own", async () => {
    await seed();
    const resolve = createAppImageProjectResolver(db);
    expect(await resolve(linked("nope"), "prod-env")).toBeNull();
    expect(await resolve(linked("app-2"), "prod-env")).toBeNull();
    expect(await resolve(linked("app-1"), "standalone-env")).toBeNull();
    expect(
      await resolve(
        { app: null } as unknown as VetraCloudEnvironmentState,
        "prod-env",
      ),
    ).toBeNull();
  });
});

describe("licensed environments (provisioned for a licence, not App-linked)", () => {
  const unlinked = {} as unknown as VetraCloudEnvironmentState;
  async function seedLicence() {
    await seed();
    await db.schema
      .createTable("license_environments")
      .addColumn("environment_id", "varchar(255)")
      .addColumn("app_id", "varchar(255)")
      .execute();
    await db
      .insertInto("license_environments")
      .values([
        { environment_id: "licensed-env", app_id: "app-1" },
        { environment_id: "orphan-env", app_id: "app-gone" },
      ])
      .execute();
  }

  it("may pull its licence's App's images", async () => {
    await seedLicence();
    const resolve = createAppImageProjectResolver(db, db);
    expect(await resolve(unlinked, "licensed-env")).toBe("app-shop");
  });

  it("gets nothing for an App that does not exist, or an env no licence provisioned", async () => {
    await seedLicence();
    const resolve = createAppImageProjectResolver(db, db);
    expect(await resolve(unlinked, "orphan-env")).toBeNull();
    expect(await resolve(unlinked, "someone-elses-env")).toBeNull();
  });

  // Releases (vetra-publish) push to the App's registry namespace; the
  // ci/releases bridge points licensed environments at those images. Only
  // the App's own repository, proven by its recorded releases: never the
  // rest of the owner's namespace.
  const running = (image: string) =>
    ({ fusion: { image } }) as unknown as VetraCloudEnvironmentState;
  async function seedRelease(appId: string, imageRef: string, version: string) {
    await db
      .insertInto("releases")
      .values({
        app_id: appId,
        version,
        kind: "release",
        branch: "main",
        pr: null,
        run: 1,
        commit: "abc",
        notes: null,
        customer_notes: null,
        image_ref: imageRef,
        image_digest: `sha256:${"a".repeat(64)}`,
        host: "cli",
        packages: "[]",
        requires: "{}",
        migrates: false,
        powerhouse_version: "6.2.3",
        base_image: "node:24",
        created_at: "t",
      })
      .execute();
  }

  it("may pull its licence's App's release images from the App's own released repository", async () => {
    await seedLicence();
    await seedRelease("app-1", "cr.vetra.io/acme/app-1:1.0.10", "1.0.10");
    const resolve = createAppImageProjectResolver(db, db);
    expect(
      await resolve(running("cr.vetra.io/acme/app-1"), "licensed-env"),
    ).toBe("acme");
    expect(
      await resolve(running("cr.vetra.io/app-shop/host"), "licensed-env"),
    ).toBe("app-shop");
    const warm = createAppImageProjectResolver(db, db, async () => ({
      appId: "app-1",
    }));
    expect(await warm(running("cr.vetra.io/acme/app-1"), "warm-env")).toBe(
      "acme",
    );
  });

  it("never vouches for the rest of the namespace, another registry, or another App's releases", async () => {
    await seedLicence();
    await seedRelease("app-1", "cr.vetra.io/acme/app-1:1.0.10", "1.0.10");
    await seedRelease("app-2", "cr.vetra.io/acme/other-app:2.0.0", "2.0.0");
    const resolve = createAppImageProjectResolver(db, db);
    for (const image of [
      "cr.vetra.io/acme/other-app",
      "evil.io/acme/app-1",
      "cr.vetra.io/acme/app-1x",
      "cr.vetra.io/acme/app",
      "cr.vetra.io/other/app-1",
    ]) {
      expect(await resolve(running(image), "licensed-env")).toBe("app-shop");
    }
  });

  it("does not vouch for a repository the App has not released from", async () => {
    await seedLicence();
    expect(
      await createAppImageProjectResolver(db, db)(
        running("cr.vetra.io/acme/app-1"),
        "licensed-env",
      ),
    ).toBe("app-shop");
  });

  it("gets nothing without the licensing tables", async () => {
    await seed();
    expect(
      await createAppImageProjectResolver(db, db)(unlinked, "licensed-env"),
    ).toBeNull();
    expect(
      await createAppImageProjectResolver(db)(unlinked, "licensed-env"),
    ).toBeNull();
  });
});

describe("createAppImageProjectResolver — warm environment", () => {
  const unlinked = { app: null } as unknown as VetraCloudEnvironmentState;

  it("treats a warm document as licensed for its app, without a license_environments row", async () => {
    await seed();
    const resolve = createAppImageProjectResolver(db, db, async (id) =>
      id === "warm-env" ? { appId: "app-1" } : null,
    );
    expect(await resolve(unlinked, "warm-env")).toBe("app-shop");
    expect(await resolve(unlinked, "other-env")).toBeNull();
  });

  it("uses a warm result handed in by the caller instead of looking it up again", async () => {
    await seed();
    let lookups = 0;
    const resolve = createAppImageProjectResolver(db, db, async () => {
      lookups++;
      return null;
    });
    expect(await resolve(unlinked, "warm-env", { appId: "app-1" })).toBe(
      "app-shop",
    );
    expect(await resolve(unlinked, "warm-env", null)).toBeNull();
    expect(lookups).toBe(0);
  });
});

describe("instance environments", () => {
  async function seedInstance(appId: string, envId: string) {
    await db
      .updateTable("apps")
      .set({ registry_namespace: "acme" })
      .where("id", "=", appId)
      .execute();
    await db
      .insertInto("instances")
      .values({
        id: `i-${envId}`,
        app_id: appId,
        kind: "branch",
        name: "main",
        branch: "main",
        host: `${appId}-main`,
        environment_id: envId,
        status: "updating",
        created_at: "t",
        updated_at: "t",
      })
      .execute();
  }

  it("vouches for the App's registry namespace", async () => {
    await seed();
    await seedInstance("app-1", "instance-env");
    const resolve = createAppImageProjectResolver(db);
    expect(await resolve(linked("app-1"), "instance-env")).toBe("acme");
  });

  it("does not vouch when the link names another App", async () => {
    await seed();
    await seedInstance("app-1", "instance-env");
    const resolve = createAppImageProjectResolver(db);
    expect(await resolve(linked("app-2"), "instance-env")).toBeNull();
  });

  it("does not vouch for an instance when the App has no registry namespace", async () => {
    await seed();
    await seedInstance("app-1", "instance-env");
    await db
      .updateTable("apps")
      .set({ registry_namespace: null })
      .where("id", "=", "app-1")
      .execute();
    const resolve = createAppImageProjectResolver(db);
    expect(await resolve(linked("app-1"), "instance-env")).toBeNull();
  });

  it("keeps answering for production and previews as before", async () => {
    await seed();
    await seedInstance("app-1", "instance-env");
    const resolve = createAppImageProjectResolver(db);
    expect(await resolve(linked("app-1"), "preview-env")).toBe("app-shop");
    expect(await resolve(linked("app-1"), "prod-env")).toBe("app-shop");
  });

  it("leaves licensed environments (no app link) on the licence path", async () => {
    await seed();
    await seedInstance("app-1", "instance-env");
    await db.schema
      .createTable("license_environments")
      .addColumn("environment_id", "varchar(255)")
      .addColumn("app_id", "varchar(255)")
      .execute();
    await db
      .insertInto("license_environments")
      .values({ environment_id: "licensed-env", app_id: "app-1" })
      .execute();
    const unlinked = {} as unknown as VetraCloudEnvironmentState;
    const resolve = createAppImageProjectResolver(db, db);
    // Licensed env still gets the old harbor project, not the namespace.
    expect(await resolve(unlinked, "licensed-env")).toBe("app-shop");
    // An unlinked document is never vouched for as an instance.
    expect(await resolve(unlinked, "instance-env")).toBeNull();
  });
});

describe("lookup failures (a render fails rather than render the app disabled)", () => {
  // A failed render writes nothing to git: the environment keeps running on
  // its previous values. Rendering `app.enabled: false` instead would drop
  // its CNPG cluster, and with it the database.
  const unlinked = {} as unknown as VetraCloudEnvironmentState;
  /** `db`, except that reading `table` fails with a connection error. */
  const failing = (table: string) =>
    new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "selectFrom") return Reflect.get(target, prop, receiver);
        return (t: string) => {
          if (t !== table) return target.selectFrom(t as never);
          const chain: Record<string, unknown> = {};
          for (const m of ["select", "where"]) chain[m] = () => chain;
          chain.executeTakeFirst = async () => {
            throw Object.assign(new Error("connection reset"), {
              code: "08006",
            });
          };
          return chain;
        };
      },
    });

  it("an App-linked environment's lookup rethrows", async () => {
    await seed();
    await expect(
      createAppImageProjectResolver(failing("apps"))(linked("app-1"), "prod-env"),
    ).rejects.toThrow("connection reset");
    await expect(
      createAppImageProjectResolver(failing("app_previews"))(
        linked("app-1"),
        "preview-env",
      ),
    ).rejects.toThrow("connection reset");
  });

  it("a licensed environment's lookup rethrows (licensing, apps or releases)", async () => {
    await seed();
    await db.schema
      .createTable("license_environments")
      .addColumn("environment_id", "varchar(255)")
      .addColumn("app_id", "varchar(255)")
      .execute();
    await db
      .insertInto("license_environments")
      .values({ environment_id: "licensed-env", app_id: "app-1" })
      .execute();
    await expect(
      createAppImageProjectResolver(db, failing("license_environments"))(
        unlinked,
        "licensed-env",
      ),
    ).rejects.toThrow("connection reset");
    await expect(
      createAppImageProjectResolver(failing("apps"), db)(unlinked, "licensed-env"),
    ).rejects.toThrow("connection reset");
    await expect(
      createAppImageProjectResolver(failing("releases"), db)(
        { fusion: { image: "cr.vetra.io/ns/shop" } } as never,
        "licensed-env",
      ),
    ).rejects.toThrow("connection reset");
  });

  it("a warm-pool lookup failure rethrows; its missing table (42P01) is not warm", async () => {
    await seed();
    const boom = async () => {
      throw Object.assign(new Error("connection reset"), { code: "08006" });
    };
    await expect(
      createAppImageProjectResolver(db, null, boom)(unlinked, "licensed-env"),
    ).rejects.toThrow("connection reset");
    const missing = async () => {
      throw Object.assign(new Error("no table"), { code: "42P01" });
    };
    expect(
      await createAppImageProjectResolver(db, null, missing)(unlinked, "x"),
    ).toBeNull();
  });
});
