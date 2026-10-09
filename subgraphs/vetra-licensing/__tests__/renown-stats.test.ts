import { afterEach, describe, expect, it, vi } from "vitest";
import { REGISTRATION_TOKEN_HEADER } from "../../vetra-apps/renown.js";
import { APP_TOKEN_HEADER, createRenownStatsClient } from "../renown-stats.js";

const WORKLOAD = "https://renown/graphql/renown-workload";
const STATS = "https://renown/graphql/renown-stats";

type Body = { query: string; variables: Record<string, unknown> };
const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
const gqlError = (code: string) =>
  new Response(JSON.stringify({ errors: [{ message: code, extensions: { code } }], data: null }), { status: 200 });
const token = (accessToken: string, expiresIn = 600) =>
  ok({ issueAppStatsToken: { accessToken, audience: STATS, expiresIn } });

function setup(responses: Record<string, (body: Body, headers: Record<string, string>) => Response | Promise<Response>>) {
  const calls: { url: string; headers: Record<string, string>; body: Body }[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Body;
    const headers = init.headers as Record<string, string>;
    calls.push({ url, headers, body });
    return responses[url]!(body, headers);
  });
  let clock = 0;
  const logger = { info: vi.fn(), warn: vi.fn() };
  const client = createRenownStatsClient(
    { statsUrl: STATS, workloadUrl: WORKLOAD, registrationToken: "reg-secret", flushIntervalMs: 0 },
    { fetch: fetch as never, now: () => clock, logger },
  );
  const reports = () => calls.filter((c) => c.url === STATS);
  const mints = () => calls.filter((c) => c.url === WORKLOAD);
  return { client, calls, reports, mints, logger, tick: (ms: number) => { clock += ms; } };
}

const R = { appDid: "did:key:zApp", userDid: "did:pkh:eip155:1:0x1", metric: "notes", value: 3 };

afterEach(() => {
  vi.useRealTimers();
});

describe("Renown stats client", () => {
  it("is off without RENOWN_STATS_URL, and says so once, not on every call", () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const fetch = vi.fn();
    const client = createRenownStatsClient(
      { statsUrl: null, workloadUrl: WORKLOAD, registrationToken: "y" },
      { logger, fetch: fetch as never },
    );
    expect(client.enqueue(R)).toBe(false);
    expect(client.enqueue(R)).toBe(false);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("RENOWN_STATS_URL unset"));
    expect(fetch).not.toHaveBeenCalled();
    client.stop();
  });

  it("is off without the Renown workload registration, and says why", () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const client = createRenownStatsClient(
      { statsUrl: STATS, workloadUrl: null, registrationToken: null },
      { logger },
    );
    expect(client.enqueue(R)).toBe(false);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("RENOWN_WORKLOAD_REGISTRATION_TOKEN"));
  });

  it("mints an app token with the registration header, then reports with X-Renown-App-Token", async () => {
    const s = setup({
      [WORKLOAD]: () => token("tok-1"),
      [STATS]: () => ok({ reportUserStat: true }),
    });
    expect(s.client.enqueue(R)).toBe(true);
    await s.client.flush();
    const [mint, report] = s.calls;
    expect(mint!.url).toBe(WORKLOAD);
    expect(mint!.headers[REGISTRATION_TOKEN_HEADER]).toBe("reg-secret");
    expect(mint!.body.variables).toStrictEqual({ did: "did:key:zApp" });
    // Renown's schema: issueAppStatsToken(did: String!): AppStatsToken! { accessToken }.
    expect(mint!.body.query).toMatch(/issueAppStatsToken\(did: \$did\)\s*\{\s*accessToken\s+expiresIn\s*\}/);
    expect(mint!.body.query).toContain("$did: String!");
    expect(report!.url).toBe(STATS);
    expect(report!.headers[APP_TOKEN_HEADER]).toBe("tok-1");
    expect(APP_TOKEN_HEADER).toBe("X-Renown-App-Token");
    expect(Object.keys(report!.headers).map((h) => h.toLowerCase())).not.toContain("authorization");
    expect(Object.keys(report!.headers).map((h) => h.toLowerCase())).not.toContain(REGISTRATION_TOKEN_HEADER);
    expect(report!.body.query).toContain(
      "reportUserStat(appDid: $appDid, userDid: $userDid, metric: $metric, value: $value)",
    );
    expect(report!.body.query).toContain("$appDid: String!, $userDid: String!, $metric: String!, $value: Float!");
    expect(report!.body.variables).toStrictEqual(R);
  });

  it("coalesces reports per (app, user, metric): the latest value wins", async () => {
    const s = setup({
      [WORKLOAD]: () => token("tok"),
      [STATS]: () => ok({ reportUserStat: true }),
    });
    s.client.enqueue({ ...R, value: 1 });
    s.client.enqueue({ ...R, value: 2 });
    s.client.enqueue({ ...R, metric: "votes", value: 9 });
    s.client.enqueue({ ...R, userDid: "did:pkh:eip155:1:0x2", value: 5 });
    s.client.enqueue({ ...R, appDid: "did:key:zOther", value: 7 });
    await s.client.flush();
    expect(s.reports().map((c) => c.body.variables)).toStrictEqual([
      { ...R, value: 2 },
      { ...R, metric: "votes", value: 9 },
      { ...R, userDid: "did:pkh:eip155:1:0x2", value: 5 },
      { ...R, appDid: "did:key:zOther", value: 7 },
    ]);
    // One token per app DID.
    expect(s.mints().map((c) => c.body.variables)).toStrictEqual([{ did: "did:key:zApp" }, { did: "did:key:zOther" }]);
    await s.client.flush();
    expect(s.reports()).toHaveLength(4);
  });

  it("caches the token per app until shortly before it expires", async () => {
    let minted = 0;
    const s = setup({
      [WORKLOAD]: () => token(`tok-${++minted}`),
      [STATS]: () => ok({ reportUserStat: true }),
    });
    s.client.enqueue(R); await s.client.flush();
    s.tick(8 * 60_000);
    s.client.enqueue(R); await s.client.flush();
    expect(minted).toBe(1);
    s.tick(2 * 60_000);
    s.client.enqueue(R); await s.client.flush();
    expect(minted).toBe(2);
    expect(s.reports().map((c) => c.headers[APP_TOKEN_HEADER])).toStrictEqual(["tok-1", "tok-1", "tok-2"]);
  });

  it("honours a shorter expiresIn, and a missing one falls back to ten minutes", async () => {
    let minted = 0;
    const s = setup({
      [WORKLOAD]: () =>
        minted++ === 0
          ? token("short", 120)
          : ok({ issueAppStatsToken: { accessToken: "long" } }),
      [STATS]: () => ok({ reportUserStat: true }),
    });
    s.client.enqueue(R); await s.client.flush();
    s.tick(61_000);
    s.client.enqueue(R); await s.client.flush();
    s.tick(8 * 60_000);
    s.client.enqueue(R); await s.client.flush();
    expect(s.reports().map((c) => c.headers[APP_TOKEN_HEADER])).toStrictEqual(["short", "long", "long"]);
  });

  it("FORBIDDEN from the token mint drops the batch for that app, logs once, and backs off", async () => {
    const s = setup({ [WORKLOAD]: () => gqlError("FORBIDDEN"), [STATS]: () => ok({ reportUserStat: true }) });
    s.client.enqueue(R);
    await s.client.flush();
    expect(s.reports()).toHaveLength(0);
    expect(s.logger.warn).toHaveBeenCalledTimes(1);
    expect(s.logger.warn).toHaveBeenCalledWith(expect.stringContaining("FORBIDDEN"));
    // Backed off: the next report for that app is refused (false) without a call.
    expect(s.client.enqueue(R)).toBe(false);
    expect(s.client.enqueue({ ...R, appDid: "did:key:zOther" })).toBe(true);
    await s.client.flush();
    expect(s.mints()).toHaveLength(2);
    // After the back-off it tries again; the same failure is not logged again.
    s.tick(5 * 60_000);
    expect(s.client.enqueue(R)).toBe(true);
    await s.client.flush();
    expect(s.mints()).toHaveLength(3);
    expect(s.logger.warn).toHaveBeenCalledTimes(2); // once per app
  });

  it("an HTTP 401 on a cached token drops it, re-mints once and retries", async () => {
    let minted = 0;
    let reported = 0;
    const s = setup({
      [WORKLOAD]: () => token(`tok-${++minted}`),
      [STATS]: () => (++reported === 2 ? new Response("unauthorised", { status: 401 }) : ok({ reportUserStat: true })),
    });
    s.client.enqueue(R); await s.client.flush();
    s.client.enqueue({ ...R, value: 4 }); await s.client.flush();
    expect(minted).toBe(2);
    expect(s.reports().map((c) => [c.headers[APP_TOKEN_HEADER], c.body.variables.value])).toStrictEqual([
      ["tok-1", 3],
      ["tok-1", 4],
      ["tok-2", 4],
    ]);
    expect(s.logger.warn).not.toHaveBeenCalled();
  });

  it("a FORBIDDEN report re-mints once, then drops, logs and backs off: never retried forever", async () => {
    let minted = 0;
    const s = setup({
      [WORKLOAD]: () => token(`tok-${++minted}`),
      [STATS]: () => gqlError("FORBIDDEN"),
    });
    s.client.enqueue(R); await s.client.flush();
    expect(minted).toBe(2);
    expect(s.reports()).toHaveLength(2);
    expect(s.logger.warn).toHaveBeenCalledWith(expect.stringContaining("FORBIDDEN"));
    s.client.enqueue(R); await s.client.flush();
    expect(minted).toBe(2);
    expect(s.reports()).toHaveLength(2);
  });

  it("recovers: a delivered report after a failure is logged once", async () => {
    let fail = true;
    const s = setup({
      [WORKLOAD]: () => (fail ? gqlError("FORBIDDEN") : token("tok")),
      [STATS]: () => ok({ reportUserStat: true }),
    });
    s.client.enqueue(R); await s.client.flush();
    fail = false;
    s.tick(5 * 60_000);
    s.client.enqueue(R); await s.client.flush();
    s.client.enqueue({ ...R, value: 8 }); await s.client.flush();
    expect(s.reports()).toHaveLength(2);
    expect(s.logger.info).toHaveBeenCalledTimes(1);
    expect(s.logger.info).toHaveBeenCalledWith(expect.stringContaining("delivered again"));
  });

  it("keeps a report that failed transiently for the next flush unless a newer value arrived", async () => {
    let calls = 0;
    const s = setup({
      [WORKLOAD]: () => token("tok"),
      [STATS]: () => {
        calls++;
        if (calls === 1) throw new Error("ECONNRESET");
        if (calls === 2) return new Response("bad gateway", { status: 502 });
        if (calls === 3) return gqlError("RATE_LIMITED");
        return ok({ reportUserStat: true });
      },
    });
    s.client.enqueue(R); await s.client.flush(); // network error: kept
    await s.client.flush(); // 502: kept
    s.client.enqueue({ ...R, value: 10 }); // newer value replaces the kept one
    await s.client.flush(); // RATE_LIMITED: kept
    await s.client.flush(); // delivered
    await s.client.flush(); // nothing left
    expect(s.reports().map((c) => c.body.variables.value)).toStrictEqual([3, 3, 10, 10]);
    // One warning per distinct failure, never the token.
    for (const [msg] of s.logger.warn.mock.calls as [string][]) expect(msg).not.toContain("tok");
  });

  it("drops (and logs) a report Renown rejects as invalid", async () => {
    const s = setup({ [WORKLOAD]: () => token("tok"), [STATS]: () => gqlError("BAD_USER_INPUT") });
    s.client.enqueue(R); await s.client.flush();
    await s.client.flush();
    expect(s.reports()).toHaveLength(1);
    expect(s.logger.warn).toHaveBeenCalledWith(expect.stringContaining("BAD_USER_INPUT"));
  });

  it("drops a report answered with a non-GraphQL error page or an error without a code", async () => {
    let n = 0;
    const s = setup({
      [WORKLOAD]: () => token("tok"),
      [STATS]: () =>
        ++n === 1
          ? new Response("<html>forbidden</html>", { status: 403 })
          : new Response(JSON.stringify({ errors: [{}] }), { status: 200 }),
    });
    s.client.enqueue(R); await s.client.flush();
    s.tick(5 * 60_000);
    s.client.enqueue(R); await s.client.flush();
    expect(s.logger.warn.mock.calls.map(([m]) => String(m).match(/\((\w+)\)/)?.[1])).toStrictEqual(["HTTP_403", "GRAPHQL_ERROR"]);
  });

  it("flush is a no-op when off", async () => {
    const fetch = vi.fn();
    const client = createRenownStatsClient(
      { statsUrl: null, workloadUrl: null, registrationToken: null },
      { fetch: fetch as never, logger: { info: vi.fn(), warn: vi.fn() } },
    );
    await client.flush();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("drops a report Renown rejects as bad input without backing off the app", async () => {
    let n = 0;
    const s = setup({
      [WORKLOAD]: () => token("tok"),
      [STATS]: () => (++n === 1 ? gqlError("BAD_USER_INPUT") : ok({ reportUserStat: true })),
    });
    s.client.enqueue(R); await s.client.flush();
    expect(s.client.enqueue({ ...R, metric: "votes" })).toBe(true);
    await s.client.flush();
    expect(s.reports().map((c) => c.body.variables.metric)).toStrictEqual(["notes", "votes"]);
    expect(s.mints()).toHaveLength(1);
  });

  it("a mint that fails for any non-transient reason backs off the app", async () => {
    const s = setup({ [WORKLOAD]: () => gqlError("SERVICE_NOT_CONFIGURED"), [STATS]: () => ok({ reportUserStat: true }) });
    s.client.enqueue(R); await s.client.flush();
    expect(s.client.enqueue(R)).toBe(false);
  });

  it("a transient mint failure keeps the reports and does not back off", async () => {
    let n = 0;
    const s = setup({
      [WORKLOAD]: () => (++n === 1 ? new Response("down", { status: 503 }) : token("tok")),
      [STATS]: () => ok({ reportUserStat: true }),
    });
    s.client.enqueue(R); await s.client.flush();
    expect(s.reports()).toHaveLength(0);
    await s.client.flush();
    expect(s.reports()).toHaveLength(1);
  });

  it("SERVICE_UNAVAILABLE on a report is retried on the next flush, not dropped", async () => {
    let n = 0;
    const s = setup({
      [WORKLOAD]: () => token("tok"),
      [STATS]: () => (++n === 1 ? gqlError("SERVICE_UNAVAILABLE") : ok({ reportUserStat: true })),
    });
    s.client.enqueue(R); await s.client.flush();
    await s.client.flush();
    expect(s.reports()).toHaveLength(2);
    expect(s.client.enqueue(R)).toBe(true);
  });

  it("RATE_LIMITED skips that app for the rest of the flush and keeps its reports queued", async () => {
    let n = 0;
    const s = setup({
      [WORKLOAD]: () => token("tok"),
      [STATS]: (body) =>
        body.variables.appDid === R.appDid && ++n === 1 ? gqlError("RATE_LIMITED") : ok({ reportUserStat: true }),
    });
    s.client.enqueue(R);
    s.client.enqueue({ ...R, metric: "votes" });
    s.client.enqueue({ ...R, appDid: "did:key:zOther" });
    s.client.enqueue({ ...R, metric: "likes" });
    await s.client.flush();
    // zApp: the first report is refused, the rest of zApp waits; zOther goes out.
    expect(s.reports().map((c) => `${c.body.variables.appDid}/${c.body.variables.metric}`)).toStrictEqual([
      "did:key:zApp/notes",
      "did:key:zOther/notes",
    ]);
    // Not backed off: everything of zApp goes out on the next flush.
    expect(s.client.enqueue({ ...R, metric: "votes", value: 6 })).toBe(true);
    await s.client.flush();
    expect(s.reports().slice(2).map((c) => [c.body.variables.metric, c.body.variables.value])).toStrictEqual([
      ["notes", 3],
      ["votes", 6],
      ["likes", 3],
    ]);
  });

  it("treats a malformed token answer as a failed mint", async () => {
    const s = setup({ [WORKLOAD]: () => ok({ issueAppStatsToken: null }), [STATS]: () => ok({ reportUserStat: true }) });
    s.client.enqueue(R); await s.client.flush();
    expect(s.reports()).toHaveLength(0);
    expect(s.logger.warn).toHaveBeenCalledTimes(1);
  });

  it("refuses new keys beyond its queue bound, but still updates queued ones", async () => {
    const s = setup({ [WORKLOAD]: () => token("tok"), [STATS]: () => ok({ reportUserStat: true }) });
    for (let i = 0; i < 10_000; i++) expect(s.client.enqueue({ ...R, metric: `m${i}` })).toBe(true);
    expect(s.client.enqueue({ ...R, metric: "one-too-many" })).toBe(false);
    expect(s.client.enqueue({ ...R, metric: "m0", value: 99 })).toBe(true);
    expect(s.logger.warn).toHaveBeenCalledWith(expect.stringContaining("queue is full"));
  });

  it("does not run two flushes at once", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const s = setup({
      [WORKLOAD]: async () => { await gate; return token("tok"); },
      [STATS]: () => ok({ reportUserStat: true }),
    });
    s.client.enqueue(R);
    const first = s.client.flush();
    const second = s.client.flush();
    release();
    await Promise.all([first, second]);
    expect(s.mints()).toHaveLength(1);
    expect(s.reports()).toHaveLength(1);
  });

  it("flushes on its interval with an unref'd timer, and stop() clears it", async () => {
    vi.useFakeTimers();
    const unref = vi.fn();
    const realSetInterval = globalThis.setInterval;
    const spy = vi.spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms: number) => {
      const t = realSetInterval(fn, ms);
      const orig = t.unref.bind(t);
      t.unref = () => { unref(); return orig(); };
      return t;
    }) as never);
    const fetch = vi.fn(async (url: string) =>
      url === WORKLOAD ? token("tok") : ok({ reportUserStat: true }),
    );
    const client = createRenownStatsClient(
      { statsUrl: STATS, workloadUrl: WORKLOAD, registrationToken: "reg", flushIntervalMs: 1000 },
      { fetch: fetch as never, logger: { info: vi.fn(), warn: vi.fn() } },
    );
    expect(unref).toHaveBeenCalledTimes(1);
    client.enqueue(R);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).toHaveBeenCalledTimes(2);
    client.stop();
    client.enqueue({ ...R, value: 4 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetch).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it("starts no timer when off", () => {
    const spy = vi.spyOn(globalThis, "setInterval");
    const client = createRenownStatsClient(
      { statsUrl: null, workloadUrl: null, registrationToken: null, flushIntervalMs: 1000 },
      { logger: { info: vi.fn(), warn: vi.fn() } },
    );
    expect(spy).not.toHaveBeenCalled();
    client.stop();
    spy.mockRestore();
  });
});
