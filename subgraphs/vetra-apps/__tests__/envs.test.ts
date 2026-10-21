import { describe, expect, it } from "vitest";
import {
  addPackage,
  approveChanges,
  initialize,
} from "../../../document-models/vetra-cloud-environment/v1/index.js";
import { PGlite } from "@electric-sql/pglite";
import { Kysely, sql } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import {
  createReactorEnvGateway,
  subdomainsCollide,
  subdomainTakenIn,
} from "../envs.js";
import { FakeReactorClient } from "./fake-reactor.js";

async function setup() {
  const client = new FakeReactorClient();
  const envs = createReactorEnvGateway(client as never);
  const id = await envs.create();
  await envs.execute(id, [
    initialize({
      genericSubdomain: "s",
      genericBaseDomain: "vetra.io",
      defaultPackageRegistry: null,
    }),
  ]);
  return { client, envs, id };
}

describe("EnvGateway over the reactor client (I3/I4)", () => {
  it("surfaces a reducer rejection that is only visible via getOperations", async () => {
    const { client, envs, id } = await setup();
    client.rejectTypes.add("ADD_PACKAGE");
    await expect(
      envs.execute(id, [
        addPackage({ packageName: "x", version: "1", registry: null }),
      ]),
    ).rejects.toThrow(/ADD_PACKAGE is not allowed now/);
  });

  it("succeeds when every appended op is clean", async () => {
    const { envs, id } = await setup();
    const state = await envs.execute(id, [
      addPackage({ packageName: "x", version: "1", registry: null }),
      approveChanges({}),
    ]);
    expect(state.packages[0]?.name).toBe("x");
  });

  it("getState: null only for a definite not-found; transient errors are rethrown", async () => {
    const { client, envs, id } = await setup();
    expect(await envs.getState("missing")).toBeNull();
    await client.deleteDocument(id);
    expect(await envs.getState(id)).toBeNull();
    const other = await envs.create();
    client.transient.add(other);
    await expect(envs.getState(other)).rejects.toThrow(/connection terminated/);
  });
});

describe("product subdomains", () => {
  it("collide on a shared host, never on a numeric suffix", () => {
    expect(subdomainsCollide("shop", "shop")).toBe(true);
    // shop's switchboard is shop-switchboard.vetra.io.
    expect(subdomainsCollide("shop-switchboard", "shop")).toBe(true);
    expect(subdomainsCollide("shop", "shop-connect")).toBe(true);
    expect(subdomainsCollide("shop-2", "shop")).toBe(false);
    expect(subdomainsCollide("shop", "shopping")).toBe(false);
    expect(subdomainsCollide("rapid-2", "rapid-fox")).toBe(false);
  });

  it("are looked up in the environments read model of the namespace schema", async () => {
    const root = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
    try {
      await sql`CREATE SCHEMA "vetra-cloud-environments"`.execute(root);
      await sql`CREATE TABLE "vetra-cloud-environments".environments (id text PRIMARY KEY, subdomain text)`.execute(root);
      const db = root.withSchema("vetra-cloud-environments");
      await db
        .insertInto("environments")
        .values([
          { id: "1", subdomain: "rapid-fox" },
          { id: "2", subdomain: "shop" },
          { id: "3", subdomain: null },
        ])
        .execute();
      const taken = subdomainTakenIn(db);
      expect(await taken("rapid-fox")).toBe(true);
      expect(await taken("rapid-fox-switchboard")).toBe(true);
      expect(await taken("rapid")).toBe(true); // rapid-fox could be rapid's "fox" host
      expect(await taken("rapid-fox-2")).toBe(false);
      expect(await taken("shop-2")).toBe(false);
      expect(await taken("garden")).toBe(false);
    } finally {
      await root.destroy();
    }
  });
});
