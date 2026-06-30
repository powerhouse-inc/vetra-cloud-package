import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import {
  deleteConnection,
  getConnection,
  saveConnection,
} from "../db/installations.js";
import type { VetraGithubAuthDB } from "../db/schema.js";

let db: Kysely<VetraGithubAuthDB>;

const ADDR = "0x" + "a".repeat(40);
const ADDR2 = "0x" + "b".repeat(40);
const DID = `did:pkh:eip155:1:${ADDR}`;
const DID2 = `did:pkh:eip155:1:${ADDR2}`;
const ENV = "env-1";
const ENV2 = "env-2";

beforeEach(async () => {
  const pglite = new PGlite();
  db = new Kysely<VetraGithubAuthDB>({ dialect: new PGliteDialect(pglite) });
  await up(db);
});

afterEach(async () => {
  await db.destroy();
});

describe("migrations", () => {
  it("creates the installations table empty", async () => {
    expect(
      await db.selectFrom("github_installations").selectAll().execute(),
    ).toEqual([]);
  });
});

describe("getConnection", () => {
  it("returns null when the caller has no connection for the environment", async () => {
    expect(await getConnection(db, DID, ENV)).toBeNull();
  });
});

describe("saveConnection", () => {
  it("persists a connection the caller can read back", async () => {
    const connection = await saveConnection(db, DID, ENV, "alice/widget");
    expect(connection.userDid).toBe(DID);
    expect(connection.environmentId).toBe(ENV);
    expect(connection.repoFullName).toBe("alice/widget");
    expect(connection.createdAt).toBeTruthy();

    const fetched = await getConnection(db, DID, ENV);
    expect(fetched).toEqual(connection);
  });

  it("re-connecting the same environment replaces the row (one row per env)", async () => {
    await saveConnection(db, DID, ENV, "alice/widget");
    await saveConnection(db, DID, ENV, "alice/gadget");

    const fetched = await getConnection(db, DID, ENV);
    expect(fetched?.repoFullName).toBe("alice/gadget");

    const rows = await db
      .selectFrom("github_installations")
      .selectAll()
      .where("user_did", "=", DID)
      .where("environment_id", "=", ENV)
      .execute();
    expect(rows).toHaveLength(1);
  });

  it("keeps a separate repo per environment for the same user", async () => {
    await saveConnection(db, DID, ENV, "alice/widget");
    await saveConnection(db, DID, ENV2, "alice/gadget");

    expect((await getConnection(db, DID, ENV))?.repoFullName).toBe(
      "alice/widget",
    );
    expect((await getConnection(db, DID, ENV2))?.repoFullName).toBe(
      "alice/gadget",
    );

    const rows = await db
      .selectFrom("github_installations")
      .selectAll()
      .where("user_did", "=", DID)
      .execute();
    expect(rows).toHaveLength(2);
  });

  it("keeps connections isolated per DID for the same environment id", async () => {
    await saveConnection(db, DID, ENV, "alice/widget");
    await saveConnection(db, DID2, ENV, "bob/thing");

    expect((await getConnection(db, DID, ENV))?.repoFullName).toBe("alice/widget");
    expect((await getConnection(db, DID2, ENV))?.repoFullName).toBe("bob/thing");
  });
});

describe("deleteConnection", () => {
  it("removes the caller's connection for the environment", async () => {
    await saveConnection(db, DID, ENV, "alice/widget");
    await deleteConnection(db, DID, ENV);
    expect(await getConnection(db, DID, ENV)).toBeNull();
  });

  it("is a no-op when there is nothing to delete", async () => {
    await expect(deleteConnection(db, DID, ENV)).resolves.toBeUndefined();
  });
});
