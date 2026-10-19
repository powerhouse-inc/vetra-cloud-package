import { describe, expect, it, vi } from "vitest";

vi.mock("@octokit/auth-app", () => ({
  createAppAuth: () => async () => ({ token: "ghs_installation" }),
}));

const { createGithubDeployApi, RepoNameTakenError, GithubHttpError } =
  await import("../github.js");

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

  it("reads a pull request's state with the installation token", async () => {
    const f = fakeFetch({
      "GET /repos/acme/shop/pulls/7": () =>
        Response.json({ state: "closed", merged: true }),
      "GET /repos/acme/shop/pulls/8": () => Response.json({ state: "open" }),
    });
    const gh = createGithubDeployApi(cfg, f.impl as never);
    expect(await gh.getPullRequestState("5", "acme/shop", 7)).toBe("closed");
    expect(await gh.getPullRequestState("5", "acme/shop", 8)).toBe("open");
    expect(f.calls[0].auth).toBe("token ghs_installation");
    await expect(
      gh.getPullRequestState("5", "acme/shop", 9),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("raises GithubHttpError with the status on failures", async () => {
    const f = fakeFetch({});
    const gh = createGithubDeployApi(cfg, f.impl as never);
    await expect(gh.listUserInstallationRepos("t", "5")).rejects.toMatchObject({
      status: 404,
    });
  });
  describe("Studio App repo calls", () => {
    const INST = "88";
    const ORG_ACCOUNT = { login: "acme", type: "Organization" };
    const USER_ACCOUNT = { login: "alice", type: "User" };
    const created =
      (fullName: string, priv = true) =>
      () =>
        Response.json(
          { id: 5, full_name: fullName, private: priv, default_branch: "main" },
          { status: 201 },
        );

    it("createRepoAsUser posts to the org with the user token and maps the repo", async () => {
      const f = fakeFetch({ "POST /orgs/acme/repos": created("acme/shop") });
      const gh = createGithubDeployApi(cfg, f.impl as never);
      expect(
        await gh.createRepoAsUser("ghu_user", ORG_ACCOUNT, "shop", "A shop"),
      ).toStrictEqual({
        id: "5",
        fullName: "acme/shop",
        private: true,
        defaultBranch: "main",
      });
      expect(f.calls[0]).toMatchObject({
        method: "POST",
        url: "https://api.github.com/orgs/acme/repos",
        auth: "token ghu_user",
        body: {
          name: "shop",
          private: true,
          auto_init: true,
          description: "A shop",
        },
      });
    });

    it("createRepoAsUser posts to /user/repos for a user account", async () => {
      const f = fakeFetch({ "POST /user/repos": created("alice/shop") });
      const gh = createGithubDeployApi(cfg, f.impl as never);
      expect(
        (await gh.createRepoAsUser("ghu_user", USER_ACCOUNT, "shop", ""))
          .fullName,
      ).toBe("alice/shop");
      expect(
        f.calls.map((c) => `${c.method} ${c.url} ${c.auth}`),
      ).toStrictEqual([
        "POST https://api.github.com/user/repos token ghu_user",
      ]);
    });

    it("createRepoAsUser returns a public response as such, for the caller's undo (no user-token delete)", async () => {
      const f = fakeFetch({
        "POST /orgs/acme/repos": created("acme/shop", false),
      });
      const gh = createGithubDeployApi(cfg, f.impl as never);
      expect(
        await gh.createRepoAsUser("ghu_user", ORG_ACCOUNT, "shop", ""),
      ).toMatchObject({ id: "5", fullName: "acme/shop", private: false });
      expect(f.calls.map((c) => c.method)).toStrictEqual(["POST"]);
    });

    it("createRepoAsUser maps a 422 name clash to RepoNameTakenError", async () => {
      const f = fakeFetch({
        "POST /user/repos": () =>
          new Response(
            JSON.stringify({
              message: "Repository creation failed.",
              errors: [
                {
                  message: "name already exists on this account",
                  field: "name",
                },
              ],
            }),
            { status: 422 },
          ),
      });
      const gh = createGithubDeployApi(cfg, f.impl as never);
      await expect(
        gh.createRepoAsUser("ghu_user", USER_ACCOUNT, "shop", ""),
      ).rejects.toBeInstanceOf(RepoNameTakenError);
    });

    it("createRepoAsUser surfaces other 422s as RepoNameInvalidError with GitHub's reason", async () => {
      const f = fakeFetch({
        "POST /orgs/acme/repos": () =>
          new Response(JSON.stringify({ message: "Validation Failed" }), {
            status: 422,
          }),
      });
      const gh = createGithubDeployApi(cfg, f.impl as never);
      const err = await gh
        .createRepoAsUser("ghu_user", ORG_ACCOUNT, "shop", "")
        .catch((e: unknown) => e);
      expect(err).not.toBeInstanceOf(RepoNameTakenError);
      expect(err).toMatchObject({
        name: "RepoNameInvalidError",
        reason: "Validation Failed",
      });
    });

    it("createRepoAsUser surfaces GitHub's 403 with its status", async () => {
      const f = fakeFetch({
        "POST /orgs/acme/repos": () =>
          new Response(JSON.stringify({ message: "Must have admin rights" }), {
            status: 403,
          }),
      });
      const gh = createGithubDeployApi(cfg, f.impl as never);
      await expect(
        gh.createRepoAsUser("ghu_user", ORG_ACCOUNT, "shop", ""),
      ).rejects.toMatchObject({ status: 403 });
    });

    it("addRepoToInstallation PUTs with the user token; 204 and 304 are fine", async () => {
      const f = fakeFetch({
        "PUT /user/installations/88/repositories/5": () =>
          new Response(null, { status: 204 }),
        "PUT /user/installations/88/repositories/6": () =>
          new Response(null, { status: 304 }),
        "PUT /user/installations/88/repositories/7": () =>
          new Response("nope", { status: 403 }),
      });
      const gh = createGithubDeployApi(cfg, f.impl as never);
      await gh.addRepoToInstallation("ghu_user", INST, "5");
      await gh.addRepoToInstallation("ghu_user", INST, "6");
      await expect(
        gh.addRepoToInstallation("ghu_user", INST, "7"),
      ).rejects.toMatchObject({ status: 403 });
      expect(f.calls[0]).toMatchObject({
        method: "PUT",
        url: "https://api.github.com/user/installations/88/repositories/5",
        auth: "token ghu_user",
      });
    });

    it("getInstallationRepositorySelection reads the installation with the app JWT", async () => {
      const f = fakeFetch({
        "GET /app/installations/88": () =>
          Response.json({ id: 88, repository_selection: "selected" }),
        "GET /app/installations/89": () =>
          Response.json({ id: 89, repository_selection: "all" }),
      });
      const gh = createGithubDeployApi(cfg, f.impl as never);
      expect(await gh.getInstallationRepositorySelection(INST)).toBe(
        "selected",
      );
      expect(await gh.getInstallationRepositorySelection("89")).toBe("all");
      f.impl.mockImplementationOnce(async () => Response.json({ id: 90 }));
      await expect(
        gh.getInstallationRepositorySelection("90"),
      ).rejects.toBeInstanceOf(GithubHttpError);
      expect(f.calls[0]).toMatchObject({
        method: "GET",
        url: "https://api.github.com/app/installations/88",
        auth: "Bearer ghs_installation",
      });
    });

    it("deleteRepoAsUser deletes with the user token and reports a 404 as not deleted", async () => {
      const f = fakeFetch({
        "DELETE /repos/acme/shop": () => new Response(null, { status: 204 }),
      });
      const gh = createGithubDeployApi(cfg, f.impl as never);
      expect(await gh.deleteRepoAsUser("ghu_user", "acme/shop")).toBe(true);
      expect(await gh.deleteRepoAsUser("ghu_user", "acme/gone")).toBe(false);
      expect(
        f.calls.map((c) => `${c.method} ${c.url} ${c.auth}`),
      ).toStrictEqual([
        "DELETE https://api.github.com/repos/acme/shop token ghu_user",
        "DELETE https://api.github.com/repos/acme/gone token ghu_user",
      ]);
    });

    it("deleteRepo deletes and treats 404 as done", async () => {
      const f = fakeFetch({
        "DELETE /repos/vetra-apps/shop": () =>
          new Response(null, { status: 204 }),
        "DELETE /repos/vetra-apps/gone": () =>
          new Response("not found", { status: 404 }),
      });
      const gh = createGithubDeployApi(cfg, f.impl as never);
      expect(await gh.deleteRepo(INST, "vetra-apps/shop")).toBe(true);
      expect(await gh.deleteRepo(INST, "vetra-apps/gone")).toBe(false);
      expect(f.calls.map((c) => `${c.method} ${c.url}`)).toStrictEqual([
        "DELETE https://api.github.com/repos/vetra-apps/shop",
        "DELETE https://api.github.com/repos/vetra-apps/gone",
      ]);
    });

    it("setRepoVariable creates, and updates on 409", async () => {
      const f = fakeFetch({
        "POST /repos/vetra-apps/shop/actions/variables": () =>
          new Response(null, { status: 201 }),
        "POST /repos/vetra-apps/dup/actions/variables": () =>
          new Response("exists", { status: 409 }),
        "PATCH /repos/vetra-apps/dup/actions/variables/VETRA_APP_ID": () =>
          new Response(null, { status: 204 }),
      });
      const gh = createGithubDeployApi(cfg, f.impl as never);
      await gh.setRepoVariable(INST, "vetra-apps/shop", "VETRA_APP_ID", "a1");
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]).toMatchObject({
        method: "POST",
        body: { name: "VETRA_APP_ID", value: "a1" },
      });
      await gh.setRepoVariable(INST, "vetra-apps/dup", "VETRA_APP_ID", "a2");
      expect(f.calls.slice(1).map((c) => `${c.method} ${c.url}`)).toStrictEqual(
        [
          "POST https://api.github.com/repos/vetra-apps/dup/actions/variables",
          "PATCH https://api.github.com/repos/vetra-apps/dup/actions/variables/VETRA_APP_ID",
        ],
      );
      expect(f.calls[2].body).toStrictEqual({
        name: "VETRA_APP_ID",
        value: "a2",
      });
    });

    it("commitFile PUTs base64 content to the contents API", async () => {
      const f = fakeFetch({
        "PUT /repos/vetra-apps/shop/contents/": () =>
          Response.json({}, { status: 201 }),
      });
      const gh = createGithubDeployApi(cfg, f.impl as never);
      await gh.commitFile(INST, "vetra-apps/shop", {
        path: ".github/workflows/vetra.yml",
        content: "name: vetra\n",
        message: "ci: add workflow",
      });
      expect(f.calls[0]).toMatchObject({
        method: "PUT",
        url: "https://api.github.com/repos/vetra-apps/shop/contents/.github/workflows/vetra.yml",
        body: {
          message: "ci: add workflow",
          content: Buffer.from("name: vetra\n").toString("base64"),
        },
      });
    });
  });
});
