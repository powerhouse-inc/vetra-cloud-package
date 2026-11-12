import type { ProbeResult } from "./health.js";

export type HttpProbe = (url: string) => Promise<ProbeResult>;

export const PROBE_TIMEOUT_MS = 5_000;

/** One GET, no redirects followed, body discarded, 5 s at most. Never throws. */
export const fetchProbe: HttpProbe = async (url) => {
  try {
    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { "user-agent": "vetra-instance-health/1" },
    });
    await res.body?.cancel().catch(() => undefined);
    return {
      status: res.status,
      contentType: res.headers.get("content-type"),
      error: null,
    };
  } catch (err) {
    const e = err as Error;
    const error =
      e?.name === "TimeoutError" ? "timeout" : String(e?.message ?? err);
    return { status: null, contentType: null, error: error.slice(0, 200) };
  }
};
