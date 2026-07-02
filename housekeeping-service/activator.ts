import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isAutomationRequest } from "../subgraphs/vetra-housekeeping/policy.js";
import type { SwitchboardClient } from "./switchboard.js";

export interface ActivatorDeps {
  switchboard: SwitchboardClient;
  /** vetra.io waking page to redirect browsers to, e.g. https://vetra.io/studio/waking */
  wakingPageUrl: string;
  logger?: { info: (m: string) => void; warn: (m: string) => void };
}

function send(
  res: ServerResponse,
  status: number,
  headers: Record<string, string>,
  body?: string,
): void {
  res.writeHead(status, headers);
  res.end(body);
}

function wantsHtml(req: IncomingMessage): boolean {
  return (req.headers["accept"] ?? "").includes("text/html");
}

/**
 * Wake activator. Sits behind the catch-all *.vetra.io route and catches hits to
 * sleeping studio hosts. A browser is redirected to the branded vetra.io
 * /studio/waking page (which wakes the studio, polls, and opens it when ready);
 * an API/CLI client gets 503 + Retry-After (and the wake is still kicked here so
 * it recovers on retry). Automation (pollers/monitors/ACME) is short-circuited
 * and never triggers a wake.
 */
export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ActivatorDeps,
): Promise<void> {
  const log = deps.logger ?? console;
  const host = (req.headers["host"] ?? "").split(":")[0];
  const path = (req.url ?? "/").split("?")[0];
  const ua = req.headers["user-agent"] ?? "";

  // k8s probes.
  if (path === "/healthz" || path === "/readyz") {
    send(res, 200, { "content-type": "text/plain" }, "ok");
    return;
  }

  // Automation (pollers, monitors, ACME): cheap stub, never wake.
  if (isAutomationRequest(path, ua)) {
    send(res, 204, {});
    return;
  }

  if (!host) {
    send(res, 400, { "content-type": "text/plain" }, "missing host");
    return;
  }

  let status: string;
  try {
    status = (await deps.switchboard.powerState(host)).status;
  } catch (err) {
    log.warn(`[activator] powerState failed for ${host}: ${err instanceof Error ? err.message : String(err)}`);
    status = "UNKNOWN";
  }

  if (status === "UNKNOWN") {
    send(res, 404, { "content-type": "text/plain" }, "no studio for this host");
    return;
  }

  // AWAKE but still routed here (brief race before the studio's exact-host
  // router takes over) → bounce to the studio; the exact router will serve it.
  if (status === "AWAKE") {
    send(res, 302, { location: `https://${host}/` });
    return;
  }

  // SLEEPING / WAKING: kick the (idempotent) wake so API/CLI clients recover on
  // retry too, then route the user.
  deps.switchboard.wakeStudio(host).catch((err) =>
    log.warn(`[activator] wake failed for ${host}: ${err instanceof Error ? err.message : String(err)}`),
  );
  log.info(`[activator] ${status} → routing wake for ${host}`);

  if (wantsHtml(req)) {
    // Browser → the branded vetra.io waking page (real green/Inter/logo). It
    // wakes + polls studioPowerState + opens the studio when READY.
    const target = `${deps.wakingPageUrl}?host=${encodeURIComponent(host)}`;
    send(res, 302, { location: target });
  } else {
    send(
      res,
      503,
      { "content-type": "application/json", "retry-after": "10" },
      JSON.stringify({ status: "waking", host }),
    );
  }
}

export function startActivator(deps: ActivatorDeps, port: number): Server {
  const server = createServer((req, res) => {
    handleRequest(req, res, deps).catch((err) => {
      (deps.logger ?? console).warn(
        `[activator] handler error: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (!res.headersSent) send(res, 500, { "content-type": "text/plain" }, "error");
    });
  });
  server.listen(port);
  return server;
}
