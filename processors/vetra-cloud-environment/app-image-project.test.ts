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
