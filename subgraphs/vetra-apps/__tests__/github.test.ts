import { describe, expect, it, vi } from "vitest";

vi.mock("@octokit/auth-app", () => ({
  createAppAuth: () => async () => ({ token: "ghs_installation" }),
}));

const { createGithubDeployApi } = await import("../github.js");

const cfg = {
  appId: "1",
  slug: "vetra-deploy",
  clientId: "cid",
  clientSecret: "csecret",
  privateKey: "k",
};

type Call = {
  method: string;
  url: string;
  body: any;
  auth: string | undefined;
};

function fakeFetch(routes: Record<string, (call: Call) => Response>) {
  const calls: Call[] = [];
  const impl = vi.fn(async (url: string, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const call: Call = {
      method: init.method ?? "GET",
      url,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      auth: headers.Authorization,
    };
    calls.push(call);
    const key = `${call.method} ${url.replace("https://api.github.com", "")}`;
    const route = Object.entries(routes).find(([k]) => key.startsWith(k));
    if (!route) return new Response("not found", { status: 404 });
    return route[1](call);
  });
  return { impl, calls };
}

describe("GitHub deploy client", () => {
  it("exchanges the OAuth code with client id + secret", async () => {
    const f = fakeFetch({});
    f.impl.mockImplementationOnce(async () =>
      Response.json({
        access_token: "ghu_user",
        expires_in: 28800,
        refresh_token: "ghr_refresh",
        refresh_token_expires_in: 15897600,
      }),
    );
    const gh = createGithubDeployApi(cfg, f.impl as never);
    expect(await gh.exchangeOAuthCode("abc")).toStrictEqual({
      accessToken: "ghu_user",
      expiresInSec: 28800,
      refreshToken: "ghr_refresh",
      refreshTokenExpiresInSec: 15897600,
    });
    expect(f.impl.mock.calls[0][0]).toBe(
      "https://github.com/login/oauth/access_token",
    );
    expect(JSON.parse(String(f.impl.mock.calls[0][1]?.body))).toStrictEqual({
      client_id: "cid",
      client_secret: "csecret",
      code: "abc",
    });
    f.impl.mockImplementationOnce(async () =>
      Response.json({ error: "bad_verification_code" }),
    );
    await expect(gh.exchangeOAuthCode("x")).rejects.toThrow(
      /bad_verification_code/,
    );
    f.impl.mockImplementationOnce(async () =>
      Response.json({ access_token: "ghu_2" }),
    );
    expect(await gh.refreshUserToken("ghr_refresh")).toMatchObject({
      accessToken: "ghu_2",
      refreshToken: null,
    });
    expect(JSON.parse(String(f.impl.mock.calls[2][1]?.body))).toStrictEqual({
      client_id: "cid",
      client_secret: "csecret",
      grant_type: "refresh_token",
      refresh_token: "ghr_refresh",
    });
  });

  it("lists user installations and the repos the USER can access in one", async () => {
    const f = fakeFetch({
      "GET /user/installations/5/repositories": () =>
        Response.json({
          repositories: [
            {
              id: 9,
              full_name: "acme/shop",
              private: true,
              default_branch: "main",
            },
          ],
        }),
      "GET /user/installations": () =>
        Response.json({
          installations: [
            {
              id: 5,
              app_id: 1,
              account: { login: "acme", type: "Organization" },
            },
          ],
        }),
    });
    const gh = createGithubDeployApi(cfg, f.impl as never);
    expect(await gh.listUserInstallations("ghu_user")).toStrictEqual([
      {
        installationId: "5",
        appId: "1",
        accountLogin: "acme",
        accountType: "Organization",
      },
    ]);
    expect(f.calls[0].auth).toBe("token ghu_user");
    expect(await gh.listUserInstallationRepos("ghu_user", "5")).toStrictEqual([
      { id: "9", fullName: "acme/shop", private: true, defaultBranch: "main" },
    ]);
    // the user's token, not an installation token
    expect(f.calls[1].auth).toBe("token ghu_user");
  });

  it("creates deployments and statuses with the Deployments API shape", async () => {
    const f = fakeFetch({
      "POST /repos/acme/shop/deployments/12/statuses": () =>
        Response.json({}, { status: 201 }),
      "POST /repos/acme/shop/deployments": () =>
        Response.json({ id: 12 }, { status: 201 }),
    });
    const gh = createGithubDeployApi(cfg, f.impl as never);
    expect(
      await gh.createDeployment("5", "acme/shop", {
        ref: "abc",
        environment: "preview-pr-3",
        transient: true,
        description: "d",
      }),
    ).toBe("12");
    expect(f.calls[0].body).toStrictEqual({
      ref: "abc",
      environment: "preview-pr-3",
      description: "d",
      auto_merge: false,
      required_contexts: [],
      transient_environment: true,
      production_environment: false,
    });
    await gh.createDeploymentStatus("5", "acme/shop", "12", {
      state: "success",
      environment: "preview-pr-3",
      environmentUrl: "https://x",
      logUrl: null,
      description: "Ready",
    });
    expect(f.calls[1].body).toStrictEqual({
      state: "success",
      environment: "preview-pr-3",
      description: "Ready",
      environment_url: "https://x",
      auto_inactive: false,
    });
  });

  it("updates the existing sticky comment, or creates one", async () => {
    const f = fakeFetch({
      "GET /repos/acme/shop/issues/3/comments": () =>
        Response.json([
          { id: 1, body: "hello" },
          { id: 2, body: "<!-- vetra-preview -->\nold" },
        ]),
      "PATCH /repos/acme/shop/issues/comments/2": () => Response.json({}),
      "POST /repos/acme/shop/issues/4/comments": () =>
        Response.json({}, { status: 201 }),
      "GET /repos/acme/shop/issues/4/comments": () => Response.json([]),
    });
    const gh = createGithubDeployApi(cfg, f.impl as never);
    await gh.upsertPrComment(
      "5",
      "acme/shop",
      3,
      "<!-- vetra-preview -->",
      "<!-- vetra-preview -->\nnew",
    );
    expect(f.calls[1]).toMatchObject({
      method: "PATCH",
      body: { body: "<!-- vetra-preview -->\nnew" },
    });
    await gh.upsertPrComment(
      "5",
      "acme/shop",
      4,
      "<!-- vetra-preview -->",
      "body",
    );
    expect(f.calls[3]).toMatchObject({
      method: "POST",
      body: { body: "<!-- vetra-preview -->\nbody" },
    });
  });

  it("opens the setup PR: branch from default, PUT the workflow, open (or reuse) the PR", async () => {
    let pullsStatus = 201;
    const f = fakeFetch({
      "GET /repos/acme/shop/git/ref/heads/main": () =>
        Response.json({ object: { sha: "base-sha" } }),
      "POST /repos/acme/shop/git/refs": () =>
        new Response("exists", { status: 422 }),
      "GET /repos/acme/shop/contents/.github/workflows/vetra.yml": () =>
        Response.json({ sha: "file-sha" }),
      "PUT /repos/acme/shop/contents/.github/workflows/vetra.yml": () =>
        Response.json({}),
      "POST /repos/acme/shop/pulls": () =>
        pullsStatus === 201
          ? Response.json(
              { html_url: "https://github.com/acme/shop/pull/1" },
              { status: 201 },
            )
          : new Response("exists", { status: 422 }),
      "GET /repos/acme/shop/pulls?state=open": () =>
        Response.json([{ html_url: "https://github.com/acme/shop/pull/2" }]),
      "GET /repos/acme/shop": () =>
        Response.json({ default_branch: "main", owner: { login: "acme" } }),
    });
    const gh = createGithubDeployApi(cfg, f.impl as never);
    const input = {
      branch: "vetra/setup",
      path: ".github/workflows/vetra.yml",
      content: "name: Vetra\n",
      commitMessage: "ci",
      title: "t",
      body: "b",
    };
    expect(await gh.openPullRequestWithFile("5", "acme/shop", input)).toBe(
      "https://github.com/acme/shop/pull/1",
    );
    const put = f.calls.find((c) => c.method === "PUT")!;
    expect(put.body).toStrictEqual({
      message: "ci",
      content: Buffer.from("name: Vetra\n").toString("base64"),
      branch: "vetra/setup",
      sha: "file-sha",
    });
    expect(
      f.calls.find((c) => c.url.endsWith("/git/refs"))?.body,
    ).toStrictEqual({
      ref: "refs/heads/vetra/setup",
      sha: "base-sha",
    });
    pullsStatus = 422;
    expect(await gh.openPullRequestWithFile("5", "acme/shop", input)).toBe(
      "https://github.com/acme/shop/pull/2",
    );
  });

  it("raises GithubHttpError with the status on failures", async () => {
    const f = fakeFetch({});
    const gh = createGithubDeployApi(cfg, f.impl as never);
    await expect(gh.listUserInstallationRepos("t", "5")).rejects.toMatchObject({
      status: 404,
    });
  });
});
