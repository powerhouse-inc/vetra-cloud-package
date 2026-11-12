import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { GraphQLError, parse } from "graphql";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stackFreeError, withoutStacktraces } from "./graphql-errors.js";

/**
 * Runs the resolvers through the same server stack as the Switchboard: the
 * reactor-api's own @apollo/server + @apollo/subgraph (ESM builds), with
 * stack traces switched on as they are under NODE_ENV=development.
 */
const reactorApi = createRequire(
  join(
    realpathSync(
      fileURLToPath(
        new URL("../node_modules/@powerhousedao/reactor-api", import.meta.url),
      ),
    ),
    "package.json",
  ),
);
const esm = (pkg: string, cjsEntry: string, esmEntry: string) =>
  pathToFileURL(
    join(dirname(reactorApi.resolve(pkg)).replace(cjsEntry, ""), esmEntry),
  ).href;

type Server = {
  start(): Promise<void>;
  stop(): Promise<void>;
  executeOperation(req: { query: string }): Promise<{
    body: { kind: string; singleResult?: { errors?: unknown[] } };
  }>;
};

const typeDefs = parse(`
  type Query {
    unauthenticated: String
    asyncUnauthenticated: String
    plain: String
    kysely: String
    ok: String
    nested: Nested
  }
  type Mutation { boom(x: Int!): Boolean }
  type Nested { deep: String }
`);

let pglite: PGlite;
let db: Kysely<any>;

const resolvers = () => ({
  Query: {
    unauthenticated: () => {
      throw new GraphQLError("Sign in with Renown", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    },
    asyncUnauthenticated: async () => {
      await Promise.resolve();
      throw new GraphQLError("Sign in with Renown", {
        extensions: { code: "UNAUTHENTICATED", reason: "x" },
      });
    },
    plain: async () => {
      throw new Error("something internal");
    },
    kysely: async () => {
      await db.selectFrom("no_such_table").selectAll().execute();
      return "unreachable";
    },
    ok: () => "fine",
    nested: () => ({}),
  },
  Mutation: {
    boom: () => {
      throw new TypeError("bad");
    },
  },
  Nested: {
    deep: () => Promise.reject(new Error("deep failure")),
  },
});

async function serve(
  map: Record<string, unknown>,
): Promise<(query: string) => Promise<Record<string, any>[]>> {
  const { ApolloServer } = (await import(
    esm("@apollo/server", "dist/cjs", "dist/esm/index.js")
  )) as { ApolloServer: new (o: unknown) => Server };
  const { buildSubgraphSchema } = (await import(
    esm("@apollo/subgraph", "dist", "dist/index.js")
  )) as { buildSubgraphSchema: (m: unknown) => unknown };
  const server = new ApolloServer({
    schema: buildSubgraphSchema([{ typeDefs, resolvers: map }]),
    includeStacktraceInErrorResponses: true,
  });
  await server.start();
  servers.push(server);
  return async (query) => {
    const res = await server.executeOperation({ query });
    expect(res.body.kind).toBe("single");
    return (res.body.singleResult?.errors ?? []) as Record<string, any>[];
  };
}

const servers: Server[] = [];

beforeAll(async () => {
  pglite = new PGlite();
  db = new Kysely({ dialect: new PGliteDialect(pglite) });
});
afterAll(async () => {
  await Promise.all(servers.map((s) => s.stop()));
  await db.destroy();
});

const hasFrames = (err: Record<string, any>) =>
  JSON.stringify(err.extensions?.stacktrace ?? []).match(/\bat |\.m?[jt]s:\d+/);

describe("withoutStacktraces against Apollo with stack traces on", () => {
  it("unwrapped resolvers leak file paths (the bug)", async () => {
    const run = await serve(resolvers());
    const [err] = await run("{ unauthenticated }");
    expect(hasFrames(err)).toBeTruthy();
  });

  it.each([
    ["{ unauthenticated }", "Sign in with Renown", "UNAUTHENTICATED"],
    ["{ asyncUnauthenticated }", "Sign in with Renown", "UNAUTHENTICATED"],
    ["{ plain }", "something internal", "INTERNAL_SERVER_ERROR"],
    ["mutation { boom(x: 1) }", "bad", "INTERNAL_SERVER_ERROR"],
    ["{ nested { deep } }", "deep failure", "INTERNAL_SERVER_ERROR"],
  ])("%s: no frames, message and code kept", async (query, message, code) => {
    const run = await serve(withoutStacktraces(resolvers()));
    const [err] = await run(query);
    expect(err.message).toBe(message);
    expect(err.extensions.code).toBe(code);
    expect(err.extensions.stacktrace).toEqual([`GraphQLError: ${message}`]);
    expect(err.locations).toBeDefined();
    expect(err.path).toBeDefined();
  });

  it("keeps the other extensions", async () => {
    const run = await serve(withoutStacktraces(resolvers()));
    const [err] = await run("{ asyncUnauthenticated }");
    expect(err.extensions.reason).toBe("x");
    expect(err.path).toEqual(["asyncUnauthenticated"]);
  });

  it("strips frames from errors thrown deep inside Kysely", async () => {
    const run = await serve(withoutStacktraces(resolvers()));
    const [err] = await run("{ kysely }");
    expect(err.message).toMatch(/no_such_table/);
    expect(hasFrames(err)).toBeFalsy();
  });

  it("leaves successful fields alone", async () => {
    const run = await serve(withoutStacktraces(resolvers()));
    expect(await run("{ ok nested { __typename } }")).toEqual([]);
  });
});

describe("withoutStacktraces", () => {
  it("is idempotent and keeps non-resolver entries", () => {
    const scalar = { name: "S" };
    const once = withoutStacktraces({
      Query: { a: () => 1 },
      Thing: { __resolveType: () => "X" },
      Scalar: Object.create({ inherited: true }) as object,
      S: scalar,
    });
    const twice = withoutStacktraces(once);
    const q = twice.Query as Record<string, unknown>;
    expect(q.a).toBe((once.Query as Record<string, unknown>).a);
    expect((twice.Thing as Record<string, unknown>).__resolveType).toBe(
      (once.Thing as Record<string, unknown>).__resolveType,
    );
    expect(twice.Scalar).toBe(once.Scalar);
  });

  it("returns sync results synchronously", () => {
    const map = withoutStacktraces({ Query: { a: () => 1 } });
    const a = (map.Query as Record<string, (...x: unknown[]) => unknown>).a;
    expect(a(undefined, {}, {}, { path: { key: "a" }, fieldNodes: [] })).toBe(
      1,
    );
  });

  it("wraps { resolve, subscribe } field configs", async () => {
    const map = withoutStacktraces({
      Subscription: {
        s: {
          subscribe: async () => {
            throw new Error("nope");
          },
        },
      },
    });
    const s = (map.Subscription as any).s;
    await expect(
      s.subscribe(undefined, {}, {}, { path: { key: "s" }, fieldNodes: [] }),
    ).rejects.toMatchObject({ stack: "GraphQLError: nope", message: "nope" });
  });
});

describe("stackFreeError", () => {
  it("keeps the thrown error with its stack as originalError", () => {
    const cause = new Error("db down");
    const err = stackFreeError(cause);
    expect(err.originalError).toBe(cause);
    expect(cause.stack).toMatch(/\bat /);
    expect(err.stack).toBe("GraphQLError: db down");
  });

  it("handles non-Error values", () => {
    expect(stackFreeError("x").message).toBe("Unexpected error value: x");
  });
});

describe("every subgraph", () => {
  it("serves its resolvers through withoutStacktraces", async () => {
    const { readdirSync, readFileSync, existsSync } = await import("node:fs");
    const root = fileURLToPath(new URL("../subgraphs/", import.meta.url));
    const subgraphs = readdirSync(root, { withFileTypes: true })
      .filter(
        (d) => d.isDirectory() && existsSync(join(root, d.name, "index.ts")),
      )
      .map((d) => d.name);
    expect(subgraphs.length).toBeGreaterThanOrEqual(8);
    for (const name of subgraphs) {
      const src = readFileSync(join(root, name, "index.ts"), "utf8");
      const assignments = src.match(/this\.resolvers = [^;]*/g) ?? [];
      expect(assignments.length, name).toBeGreaterThan(0);
      for (const a of assignments) {
        expect(a, name).toMatch(/^this\.resolvers = withoutStacktraces\(/);
      }
    }
  });
});
