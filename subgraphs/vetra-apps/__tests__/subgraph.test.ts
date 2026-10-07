import { afterEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { VetraAppsSubgraph } from "../index.js";

const ENV_KEYS = [
  "GITHUB_DEPLOY_APP_ID",
  "GITHUB_DEPLOY_APP_SLUG",
  "GITHUB_DEPLOY_APP_CLIENT_ID",
  "GITHUB_DEPLOY_APP_CLIENT_SECRET",
  "GITHUB_DEPLOY_APP_PRIVATE_KEY",
  "GITHUB_DEPLOY_APP_WEBHOOK_SECRET",
  "HARBOR_APPS_ADMIN_USERNAME",
  "HARBOR_APPS_ADMIN_PASSWORD",
  "RENOWN_WORKLOAD_REGISTRATION_TOKEN",
  "VETRA_APPS_ENCRYPTION_KEY",
];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

type Handler = (req: Request, ctx: { rawBody?: Buffer }) => Promise<Response>;

describe("VetraAppsSubgraph boot (Review Focus 4)", () => {
  it("loads without any GitHub/Harbor/Renown config; mutations answer SERVICE_NOT_CONFIGURED", async () => {
    for (const k of ENV_KEYS) vi.stubEnv(k, "");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
    const routes: {
      method: string;
      path: string;
      options: unknown;
      handler: Handler;
    }[] = [];
    const disposed = vi.fn();
    const route =
      (method: string) =>
      (path: string, options: unknown, handler: Handler) => {
        routes.push({ method, path, options, handler });
        return { url: `https://x/api/pkg/${path}`, dispose: disposed };
      };
    const subgraph = new VetraAppsSubgraph({
      reactorClient: {},
      relationalDb: { createNamespace: async () => db },
      http: { post: route("POST"), get: route("GET") },
    } as never);

    await subgraph.onSetup();

    expect(routes.map((r) => [r.method, r.path, r.options])).toStrictEqual([
      [
        "POST",
        "github/webhook",
        { auth: "public", body: "raw", maxBodyBytes: 5 * 1024 * 1024 },
      ],
      [
        "POST",
        "apps/ci/registry-credentials",
        { auth: "public", maxBodyBytes: 256 * 1024 },
      ],
      ["POST", "apps/ci/deploy", { auth: "public", maxBodyBytes: 256 * 1024 }],
      [
        "POST",
        "apps/ci/artifacts",
        { auth: "public", maxBodyBytes: 256 * 1024 },
      ],
      ["GET", "apps/ci/deployments/:id", { auth: "public" }],
    ]);
    const res = await routes[0].handler(
      new Request("https://x/api/pkg/github/webhook", {
        method: "POST",
        body: "{}",
      }),
      { rawBody: Buffer.from("{}") },
    );
    expect(res.status).toBe(503);
    // CI routes answer 401 without a bearer
    // by path, not by index: adding a route must not silently move this check
    // onto a different handler
    const deploymentsRoute = routes.find(
      (r) => r.path === "apps/ci/deployments/:id",
    )!;
    const ciRes = await deploymentsRoute.handler(
      new Request("https://x/api/pkg/apps/ci/deployments/1"),
      {
        params: { id: "1" },
      } as never,
    );
    expect(ciRes.status).toBe(401);
    expect(await ciRes.json()).toMatchObject({ error: "UNAUTHENTICATED" });

    const resolvers = subgraph.resolvers as {
      Mutation: Record<string, (...a: unknown[]) => Promise<unknown>>;
      Query: Record<string, (...a: unknown[]) => Promise<unknown>>;
    };
    const ctx = {
      user: {
        address: "0xabc",
        chainId: 1,
        networkId: "eip155",
        appKey: "did:key:z",
      },
      headers: {},
    };
    await expect(
      resolvers.Mutation.createApp(
        null,
        { input: { name: "x", installationId: "1", repositoryId: "2" } },
        ctx,
      ),
    ).rejects.toMatchObject({ extensions: { code: "SERVICE_NOT_CONFIGURED" } });
    await expect(
      resolvers.Query.githubDeployAppInfo(null, {}, ctx),
    ).rejects.toMatchObject({
      extensions: { code: "SERVICE_NOT_CONFIGURED" },
    });
    expect(await resolvers.Query.myApps(null, {}, ctx)).toStrictEqual([]);

    await subgraph.onDisconnect();
    // every registered route is disposed — derived, so a new route cannot
    // quietly leave a handle behind
    expect(disposed).toHaveBeenCalledTimes(routes.length);
    await db.destroy();
  });

  it("verifies the webhook signature from the raw body when configured", async () => {
    vi.stubEnv("GITHUB_DEPLOY_APP_WEBHOOK_SECRET", "whsec");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
    let handler: Handler | null = null;
    const subgraph = new VetraAppsSubgraph({
      reactorClient: {},
      relationalDb: { createNamespace: async () => db },
      http: {
        post: (p: string, _o: unknown, h: Handler) => {
          if (p === "github/webhook") handler = h;
          return { url: "", dispose: () => undefined };
        },
        get: () => ({ url: "", dispose: () => undefined }),
      },
    } as never);
    await subgraph.onSetup();
    const unsigned = await handler!(
      new Request("https://x", {
        method: "POST",
        headers: { "x-github-event": "pull_request" },
        body: "{}",
      }),
      { rawBody: Buffer.from("{}") },
    );
    expect(unsigned.status).toBe(401);
    const { createHmac } = await import("node:crypto");
    const sig = `sha256=${createHmac("sha256", "whsec").update("{}").digest("hex")}`;
    const ping = await handler!(
      new Request("https://x", {
        method: "POST",
        headers: { "x-github-event": "ping", "x-hub-signature-256": sig },
        body: "{}",
      }),
      { rawBody: Buffer.from("{}") },
    );
    expect(ping.status).toBe(204);
    await subgraph.onDisconnect();
    await db.destroy();
  });
});
