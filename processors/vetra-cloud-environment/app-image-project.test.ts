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

  it("gets nothing without the licensing tables", async () => {
    await seed();
    expect(await createAppImageProjectResolver(db, db)(unlinked, "licensed-env")).toBeNull();
    expect(await createAppImageProjectResolver(db)(unlinked, "licensed-env")).toBeNull();
  });
});
