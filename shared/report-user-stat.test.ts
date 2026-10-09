import { describe, expect, it, vi } from "vitest";
import { reportUserStat, ReportUserStatError } from "./report-user-stat.js";

const ENV = {
  VETRA_LICENSING_URL: "https://switchboard.staging.vetra.io/graphql/vetra-licensing",
  VETRA_REPORTING_TOKEN: "env-token",
};
const USER = "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";

function answering(status: number, body: unknown) {
  return vi.fn(async (_url: string, _init: RequestInit) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
  );
}

async function refusal(promise: Promise<unknown>): Promise<ReportUserStatError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ReportUserStatError);
  return error as ReportUserStatError;
}

describe("reportUserStat (package authors' helper)", () => {
  it("sends nothing outside a Vetra environment", async () => {
    const fetch = answering(200, {});
    expect(await reportUserStat(USER, "notes", 1, { env: {}, fetch: fetch as never })).toBe(false);
    expect(
      await reportUserStat(USER, "notes", 1, {
        env: { VETRA_LICENSING_URL: ENV.VETRA_LICENSING_URL, VETRA_REPORTING_TOKEN: " " },
        fetch: fetch as never,
      }),
    ).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("posts the current value with the reporting token header", async () => {
    const fetch = answering(200, { data: { vetraLicensing: { reportUserStat: true } } });
    expect(await reportUserStat(USER, "notes", 0, { env: ENV, fetch: fetch as never })).toBe(true);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(ENV.VETRA_LICENSING_URL);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/json", "x-vetra-reporting-token": "env-token" });
    const body = JSON.parse(init.body as string) as { query: string; variables: unknown };
    expect(body.query).toContain("vetraLicensing { reportUserStat(user: $user, metric: $metric, value: $value) }");
    expect(body.variables).toEqual({ user: USER, metric: "notes", value: 0 });
  });

  it("resolves false when Vetra does not relay the report", async () => {
    const fetch = answering(200, { data: { vetraLicensing: { reportUserStat: false } } });
    expect(await reportUserStat(USER, "notes", 3, { env: ENV, fetch: fetch as never })).toBe(false);
  });

  it("rejects an invalid metric or value without sending", async () => {
    const fetch = answering(200, {});
    expect((await refusal(reportUserStat(USER, "9lives", 1, { env: ENV, fetch: fetch as never }))).code).toBe("INVALID_INPUT");
    expect((await refusal(reportUserStat(USER, "notes", Number.NaN, { env: ENV, fetch: fetch as never }))).code).toBe(
      "INVALID_INPUT",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("surfaces Vetra's error code, HTTP failures and network failures", async () => {
    const unknownToken = answering(200, {
      errors: [{ message: "unknown reporting token", extensions: { code: "UNAUTHENTICATED" } }],
    });
    const error = await refusal(reportUserStat(USER, "notes", 1, { env: ENV, fetch: unknownToken as never }));
    expect(error).toMatchObject({ code: "UNAUTHENTICATED", message: "unknown reporting token" });
    const noCode = answering(200, { errors: [{}] });
    expect((await refusal(reportUserStat(USER, "notes", 1, { env: ENV, fetch: noCode as never }))).code).toBe("ERROR");
    const gateway = answering(502, "bad gateway");
    expect((await refusal(reportUserStat(USER, "notes", 1, { env: ENV, fetch: gateway as never }))).code).toBe("HTTP_502");
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect((await refusal(reportUserStat(USER, "notes", 1, { env: ENV, fetch: down as never }))).code).toBe("NETWORK");
  });
  it("reports a stalled response body as NETWORK", async () => {
    const stalled = vi.fn(async (_url: string, init: RequestInit) => {
      const body = new ReadableStream({
        start(controller) {
          init.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
        },
      });
      return new Response(body, { status: 200 });
    });
    const error = await refusal(reportUserStat(USER, "notes", 1, { env: ENV, fetch: stalled as never, timeoutMs: 50 }));
    expect(error.code).toBe("NETWORK");
  });
});
