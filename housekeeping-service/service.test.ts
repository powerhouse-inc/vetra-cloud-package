import { describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleRequest } from "./activator.js";

const WAKING_URL = "https://vetra.io/studio/waking";

function fakeRes() {
  const out: { status?: number; headers?: Record<string, string>; body?: string } = {};
  const res: {
    headersSent: boolean;
    writeHead(status: number, headers: Record<string, string>): typeof res;
    end(body?: string): void;
  } = {
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
  };
  return { res: res as unknown as ServerResponse, out };
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

const silent = { info: () => {}, warn: () => {} };

function deps(status: string) {
  const switchboard = {
    powerState: vi.fn(async (host: string) => ({
      host, envId: "doc-1", subdomain: "tall-duck-ab12", owner: "0xabc", status: status as any,
    })),
    wakeStudio: vi.fn(async (host: string) => ({
      host, envId: "doc-1", subdomain: "tall-duck-ab12", owner: "0xabc", status: "WAKING" as const,
    })),
  };
  return { switchboard, wakingPageUrl: WAKING_URL, logger: silent };
}

describe("activator handleRequest", () => {
  it("redirects a browser hitting a sleeping host to the vetra.io waking page (and wakes)", async () => {
    const d = deps("SLEEPING");
    const { res, out } = fakeRes();
    await handleRequest(fakeReq({ accept: "text/html" }), res, d);
    expect(out.status).toBe(302);
    expect(out.headers?.["location"]).toBe(
      `${WAKING_URL}?host=tall-duck-ab12.vetra.io`,
    );
    expect(d.switchboard.wakeStudio).toHaveBeenCalledWith("tall-duck-ab12.vetra.io");
  });

  it("returns 503 JSON (and wakes) for a non-browser client on a sleeping host", async () => {
    const d = deps("SLEEPING");
    const { res, out } = fakeRes();
    await handleRequest(fakeReq({ accept: "application/json" }), res, d);
    expect(out.status).toBe(503);
    expect(out.headers?.["retry-after"]).toBe("10");
    expect(d.switchboard.wakeStudio).toHaveBeenCalled();
  });

  it("bounces an AWAKE host straight to the studio (no wake)", async () => {
    const d = deps("AWAKE");
    const { res, out } = fakeRes();
    await handleRequest(fakeReq({ accept: "text/html" }), res, d);
    expect(out.status).toBe(302);
    expect(out.headers?.["location"]).toBe("https://tall-duck-ab12.vetra.io/");
    expect(d.switchboard.wakeStudio).not.toHaveBeenCalled();
  });

  it("short-circuits automation (the observability poll) with 204 and never wakes", async () => {
    const d = deps("SLEEPING");
    const { res, out } = fakeRes();
    await handleRequest(fakeReq({ url: "/_proxy/routes", accept: "*/*" }), res, d);
    expect(out.status).toBe(204);
    expect(d.switchboard.wakeStudio).not.toHaveBeenCalled();
    expect(d.switchboard.powerState).not.toHaveBeenCalled();
  });

  it("404s an unknown host (no studio)", async () => {
    const d = deps("UNKNOWN");
    const { res, out } = fakeRes();
    await handleRequest(fakeReq({ accept: "text/html" }), res, d);
    expect(out.status).toBe(404);
    expect(d.switchboard.wakeStudio).not.toHaveBeenCalled();
  });

  it("serves healthz", async () => {
    const d = deps("SLEEPING");
    const { res, out } = fakeRes();
    await handleRequest(fakeReq({ url: "/healthz" }), res, d);
    expect(out.status).toBe(200);
    expect(out.body).toBe("ok");
  });
});
