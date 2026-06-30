import { describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildProperRequestCountQuery } from "./loki.js";
import { runDetectionOnce, studioHost } from "./detector.js";
import { handleRequest } from "./activator.js";
import type { StudioRow } from "../subgraphs/vetra-housekeeping/db.js";

const silent = { info: () => {}, warn: () => {} };

describe("buildProperRequestCountQuery", () => {
  it("selects the host and excludes automation paths + user-agents", () => {
    const q = buildProperRequestCountQuery('{namespace="traefik"}', "x.vetra.io", 86400);
    expect(q).toContain("x.vetra.io");
    expect(q).toContain("[86400s]");
    expect(q).toContain("_proxy/routes"); // path exclusion present
    expect(q).toContain("vetra-observability-pull"); // UA exclusion present
    expect(q).toMatch(/count_over_time/);
  });
});

function studio(over: Partial<StudioRow> = {}): StudioRow {
  return {
    envId: "doc-1",
    subdomain: "tall-duck-ab12",
    status: "READY",
    owner: "0xabc",
    poolState: null,
    tenantId: "tall-duck-ab12-9f8e",
    ...over,
  };
}

describe("runDetectionOnce", () => {
  const base = {
    baseDomain: "vetra.io",
    idleThresholdSeconds: 86400,
    allowlist: [] as string[],
    logger: silent,
  };

  it("sleeps an eligible idle studio", async () => {
    const switchboard = {
      powerState: vi.fn(),
      wakeStudio: vi.fn(),
      sleepStudio: vi.fn(async (h: string) => ({
        host: h, envId: "doc-1", subdomain: "tall-duck-ab12", owner: "0xabc", status: "SLEEPING" as const,
      })),
    };
    const slept = await runDetectionOnce({
      ...base,
      dryRun: false,
      envDb: { listReadyStudios: async () => [studio()], close: async () => {} },
      loki: { hasRecentProperRequest: async () => false }, // idle
      switchboard,
    });
    expect(switchboard.sleepStudio).toHaveBeenCalledWith("tall-duck-ab12.vetra.io");
    expect(slept).toEqual(["tall-duck-ab12.vetra.io"]);
  });

  it("does not sleep when there is recent proper traffic", async () => {
    const switchboard = { powerState: vi.fn(), wakeStudio: vi.fn(), sleepStudio: vi.fn() };
    await runDetectionOnce({
      ...base,
      dryRun: false,
      envDb: { listReadyStudios: async () => [studio()], close: async () => {} },
      loki: { hasRecentProperRequest: async () => true }, // active
      switchboard,
    });
    expect(switchboard.sleepStudio).not.toHaveBeenCalled();
  });

  it("dry-run never calls sleep but reports candidates", async () => {
    const switchboard = { powerState: vi.fn(), wakeStudio: vi.fn(), sleepStudio: vi.fn() };
    const slept = await runDetectionOnce({
      ...base,
      dryRun: true,
      envDb: { listReadyStudios: async () => [studio()], close: async () => {} },
      loki: { hasRecentProperRequest: async () => false },
      switchboard,
    });
    expect(switchboard.sleepStudio).not.toHaveBeenCalled();
    expect(slept).toEqual(["tall-duck-ab12.vetra.io"]);
  });

  it("skips ineligible studios (warm-pool / allowlist)", async () => {
    const switchboard = { powerState: vi.fn(), wakeStudio: vi.fn(), sleepStudio: vi.fn() };
    await runDetectionOnce({
      ...base,
      dryRun: false,
      allowlist: ["tall-duck-ab12"],
      envDb: {
        listReadyStudios: async () => [
          studio({ poolState: "AVAILABLE" }),
          studio({ subdomain: "tall-duck-ab12" }), // allowlisted
        ],
        close: async () => {},
      },
      loki: { hasRecentProperRequest: async () => false },
      switchboard,
    });
    expect(switchboard.sleepStudio).not.toHaveBeenCalled();
  });

  it("studioHost builds the apex host", () => {
    expect(studioHost("cozy-bat-09", "vetra.io")).toBe("cozy-bat-09.vetra.io");
  });
});

// --- activator -----------------------------------------------------------

function fakeRes() {
  const out: { status?: number; headers?: Record<string, string>; body?: string } = {};
  const res = {
    headersSent: false,
    writeHead(status: number, headers: Record<string, string>) {
      out.status = status;
      out.headers = headers;
      this.headersSent = true;
      return this;
    },
    end(body?: string) {
      out.body = body;
    },
  } as unknown as ServerResponse;
  return { res, out };
}

function fakeReq(opts: { host?: string; url?: string; method?: string; accept?: string; ua?: string }): IncomingMessage {
  return {
    method: opts.method ?? "GET",
    url: opts.url ?? "/",
    headers: {
      host: opts.host ?? "tall-duck-ab12.vetra.io",
      accept: opts.accept,
      "user-agent": opts.ua,
    },
  } as unknown as IncomingMessage;
}

describe("activator handleRequest", () => {
  function deps(status: string) {
    const switchboard = {
      powerState: vi.fn(async (host: string) => ({
        host, envId: "doc-1", subdomain: "tall-duck-ab12", owner: "0xabc", status: status as any,
      })),
      sleepStudio: vi.fn(),
      wakeStudio: vi.fn(async (host: string) => ({
        host, envId: "doc-1", subdomain: "tall-duck-ab12", owner: "0xabc", status: "WAKING" as const,
      })),
    };
    return { switchboard, logger: silent };
  }

  it("serves the spinner and triggers wake for a browser hitting a sleeping host", async () => {
    const d = deps("SLEEPING");
    const { res, out } = fakeRes();
    await handleRequest(fakeReq({ accept: "text/html" }), res, d);
    expect(out.status).toBe(200);
    expect(out.headers?.["x-vetra-activator"]).toBe("1");
    expect(out.body).toContain("Waking your studio");
    expect(d.switchboard.wakeStudio).toHaveBeenCalledWith("tall-duck-ab12.vetra.io");
  });

  it("returns 503 JSON (and wakes) for a non-browser client", async () => {
    const d = deps("SLEEPING");
    const { res, out } = fakeRes();
    await handleRequest(fakeReq({ accept: "application/json" }), res, d);
    expect(out.status).toBe(503);
    expect(out.headers?.["retry-after"]).toBe("10");
    expect(d.switchboard.wakeStudio).toHaveBeenCalled();
  });

  it("short-circuits automation (the observability poll) with 204 and never wakes", async () => {
    const d = deps("SLEEPING");
    const { res, out } = fakeRes();
    await handleRequest(fakeReq({ url: "/_proxy/routes", accept: "*/*" }), res, d);
    expect(out.status).toBe(204);
    expect(d.switchboard.wakeStudio).not.toHaveBeenCalled();
  });

  it("answers the readiness poll with the sentinel and never wakes", async () => {
    const d = deps("SLEEPING");
    const { res, out } = fakeRes();
    await handleRequest(fakeReq({ url: "/?__vetra_activator_poll=1", method: "HEAD" }), res, d);
    expect(out.status).toBe(200);
    expect(out.headers?.["x-vetra-activator"]).toBe("1");
    expect(d.switchboard.wakeStudio).not.toHaveBeenCalled();
    expect(d.switchboard.powerState).not.toHaveBeenCalled();
  });

  it("404s an unknown host (no studio)", async () => {
    const d = deps("UNKNOWN");
    const { res, out } = fakeRes();
    await handleRequest(fakeReq({ accept: "text/html" }), res, d);
    expect(out.status).toBe(404);
  });

  it("serves healthz", async () => {
    const d = deps("SLEEPING");
    const { res, out } = fakeRes();
    await handleRequest(fakeReq({ url: "/healthz" }), res, d);
    expect(out.status).toBe(200);
    expect(out.body).toBe("ok");
  });
});
