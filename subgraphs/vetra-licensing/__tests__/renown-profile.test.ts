import { describe, expect, it, vi } from "vitest";
import { createRenownProfileRelay, RenownProfileError } from "../renown-profile.js";

const URL_ = "https://switchboard.renown-staging.vetra.io/graphql/renown-stats";
const DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

function answering(status: number, body: unknown) {
  return vi.fn(async (_url: string, _init: RequestInit) =>
    new Response(body === undefined ? null : JSON.stringify(body), { status }),
  );
}

async function refusal(promise: Promise<unknown>): Promise<RenownProfileError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RenownProfileError);
  return error as RenownProfileError;
}

describe("createRenownProfileRelay", () => {
  it("is off without a stats URL or a registration token", () => {
    expect(createRenownProfileRelay({ statsUrl: null, registrationToken: "t" })).toBeNull();
    expect(createRenownProfileRelay({ statsUrl: URL_, registrationToken: null })).toBeNull();
  });

  it("forwards the bearer and the registration token with only the given fields", async () => {
    const fetch = answering(200, { data: { upsertAppProfile: true } });
    const relay = createRenownProfileRelay({ statsUrl: URL_, registrationToken: "reg", fetch: fetch as never })!;
    await relay.upsert(DID, "user-bearer", {
      name: "Vault",
      description: "",
      links: [{ id: "l1", label: "Docs", url: "https://docs.example" }],
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(URL_);
    expect(init.headers).toMatchObject({
      authorization: "Bearer user-bearer",
      "x-renown-workload-registration-token": "reg",
    });
    const body = JSON.parse(init.body as string) as { query: string; variables: Record<string, unknown> };
    expect(body.query).toContain("upsertAppProfile(appDid: $appDid");
    expect(body.variables).toEqual({
      appDid: DID,
      name: "Vault",
      description: "",
      links: [{ id: "l1", label: "Docs", url: "https://docs.example" }],
    });
  });

  it.each([
    ["BAD_USER_INPUT", "description", "INVALID_INPUT", "description"],
    ["INVALID_IMAGE", "logoRef", "INVALID_INPUT", "logoRef"],
    ["FORBIDDEN", undefined, "FORBIDDEN", null],
    ["RATE_LIMITED", undefined, "RATE_LIMITED", null],
    ["UNAUTHENTICATED", undefined, "UNAUTHENTICATED", null],
    ["SERVICE_UNAVAILABLE", undefined, "PROFILE_UNAVAILABLE", null],
    ["SERVICE_NOT_CONFIGURED", undefined, "PROFILE_UNAVAILABLE", null],
  ])("maps Renown's %s", async (renownCode, field, code, expectedField) => {
    const fetch = answering(200, {
      data: null,
      errors: [{ message: "Description must be at most 2000 characters", extensions: { code: renownCode, field } }],
    });
    const relay = createRenownProfileRelay({ statsUrl: URL_, registrationToken: "reg", fetch: fetch as never })!;
    const error = await refusal(relay.upsert(DID, "b", { description: "x" }));
    expect(error.code).toBe(code);
    expect(error.field).toBe(expectedField);
    if (code === "INVALID_INPUT") expect(error.message).toBe("Description must be at most 2000 characters");
  });

  it("maps a bare 401, a 5xx, a non-true answer and a network failure", async () => {
    const make = (fetch: unknown) =>
      createRenownProfileRelay({ statsUrl: URL_, registrationToken: "reg", fetch: fetch as never })!;
    expect((await refusal(make(answering(401, undefined)).upsert(DID, "b", {}))).code).toBe("UNAUTHENTICATED");
    expect((await refusal(make(answering(502, undefined)).upsert(DID, "b", {}))).code).toBe("PROFILE_UNAVAILABLE");
    expect((await refusal(make(answering(200, { data: { upsertAppProfile: false } })).upsert(DID, "b", {}))).code).toBe(
      "PROFILE_UNAVAILABLE",
    );
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect((await refusal(make(down).upsert(DID, "b", {}))).code).toBe("PROFILE_UNAVAILABLE");
  });
});

describe("metric definitions (identity hub phase 3)", () => {
  it("forwards the metric list as Renown's AppMetricInput", async () => {
    const fetch = answering(200, { data: { upsertAppProfile: true } });
    const relay = createRenownProfileRelay({ statsUrl: URL_, registrationToken: "reg", fetch: fetch as never })!;
    const metrics = [
      { id: "m1", key: "notes", label: "Notes", unit: "notes", description: null, aggregation: "SUM" as const, public: true },
    ];
    await relay.upsert(DID, "user-bearer", { metrics });
    const [, init] = fetch.mock.calls[0]!;
    const body = JSON.parse(init.body as string) as { query: string; variables: Record<string, unknown> };
    expect(body.query).toContain("$metrics: [AppMetricInput!]");
    expect(body.query).toContain("metrics: $metrics");
    expect(body.variables).toEqual({ appDid: DID, metrics });
  });

  describe("PROFILE_UNAVAILABLE logs its cause, never the credentials", () => {
    const run = async (fetch: unknown, logger: { warn: ReturnType<typeof vi.fn> }) => {
      const relay = createRenownProfileRelay({
        statsUrl: URL_, registrationToken: "reg-secret", fetch: fetch as never, logger,
      } as never)!;
      return refusal(relay.upsert(DID, "bearer-secret", { name: "x" }));
    };
    const cases: [string, unknown, string][] = [
      ["network", vi.fn(async () => { throw new Error("boom bearer-secret"); }), "network"],
      ["http status", answering(502, undefined), "502"],
      ["error code", answering(200, { errors: [{ message: "m", extensions: { code: "INTERNAL" } }] }), "INTERNAL"],
      ["contract drift", answering(200, { data: { upsertAppProfile: "nope" } }), "validation"],
    ];
    it.each(cases)("%s", async (_n, fetch, expected) => {
      const logger = { warn: vi.fn() };
      const e = await run(fetch, logger);
      expect(e.code).toBe("PROFILE_UNAVAILABLE");
      expect(logger.warn).toHaveBeenCalledTimes(1);
      const line = String(logger.warn.mock.calls[0]![0]);
      expect(line).toContain(expected);
      expect(line).not.toContain("bearer-secret");
      expect(line).not.toContain("reg-secret");
    });
  });
});
