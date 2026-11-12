import { describe, expect, it } from "vitest";
import { createHarborApi, RELEASE_TAG_RULE } from "../harbor.js";

type Call = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
};

function harborWith(rules: unknown[] | number) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(init.body as string) : undefined,
    });
    if ((init.method ?? "GET") === "GET") {
      return typeof rules === "number"
        ? new Response("no", { status: rules })
        : Response.json(rules);
    }
    return new Response(null, { status: 201 });
  };
  const harbor = createHarborApi(
    { url: "https://cr.vetra.io", username: "u", password: "p" },
    fetchImpl as never,
  );
  return { harbor, calls };
}

const URL = "https://cr.vetra.io/api/v2.0/projects/acme/immutabletagrules";

describe("ensureImmutableReleaseTags", () => {
  it("adds the rule that keeps tags without a '-' (stable X.Y.Z) from being overwritten", async () => {
    const { harbor, calls } = harborWith([]);
    expect(await harbor.ensureImmutableReleaseTags("acme")).toBe(true);
    expect(calls.map((c) => [c.method, c.url])).toStrictEqual([
      ["GET", URL],
      ["POST", URL],
    ]);
    expect(calls[0]!.headers["x-is-resource-name"]).toBe("true");
    expect(calls[1]!.headers["x-is-resource-name"]).toBe("true");
    expect(calls[1]!.body).toStrictEqual({
      action: "immutable",
      template: "immutable_template",
      disabled: false,
      scope_selectors: {
        repository: [
          { kind: "doublestar", decoration: "repoMatches", pattern: "**" },
        ],
      },
      tag_selectors: [
        { kind: "doublestar", decoration: "excludes", pattern: "*-*" },
      ],
    });
    expect(calls[1]!.body).toMatchObject(RELEASE_TAG_RULE);
  });

  it("adds nothing when the project already has the rule", async () => {
    const { harbor, calls } = harborWith([
      { id: 3, ...RELEASE_TAG_RULE, priority: 0 },
    ]);
    expect(await harbor.ensureImmutableReleaseTags("acme")).toBe(false);
    expect(calls.map((c) => c.method)).toStrictEqual(["GET"]);
  });

  it("adds it next to other rules", async () => {
    const { harbor, calls } = harborWith([
      {
        id: 3,
        ...RELEASE_TAG_RULE,
        tag_selectors: [
          { kind: "doublestar", decoration: "matches", pattern: "latest" },
        ],
      },
    ]);
    expect(await harbor.ensureImmutableReleaseTags("acme")).toBe(true);
    expect(calls.map((c) => c.method)).toStrictEqual(["GET", "POST"]);
  });

  it("throws when Harbor refuses", async () => {
    const { harbor } = harborWith(403);
    await expect(harbor.ensureImmutableReleaseTags("acme")).rejects.toThrow(
      "harbor: immutable tag rules of acme → 403",
    );
  });
});
