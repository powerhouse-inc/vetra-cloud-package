import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isAutomationRequest } from "../subgraphs/vetra-housekeeping/policy.js";
import type { SwitchboardClient } from "./switchboard.js";

const SENTINEL_HEADER = "x-vetra-activator";
const POLL_PARAM = "__vetra_activator_poll";

export interface ActivatorDeps {
  switchboard: SwitchboardClient;
  logger?: { info: (m: string) => void; warn: (m: string) => void };
}

/** Branded wake screen. The poll loop reloads once the studio reclaims the host. */
export function spinnerHtml(host: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Waking ${host}…</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
  background:#12141b;color:#e9ecf3;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
.card{text-align:center;max-width:30rem;padding:2.5rem 2rem}
.ring{width:46px;height:46px;margin:0 auto 1.6rem;border-radius:50%;
  border:3px solid #2a2e3a;border-top-color:#b9740f;animation:spin 0.9s linear infinite}
h1{font-size:1.25rem;font-weight:650;letter-spacing:-0.01em;margin:0 0 .5rem}
p{margin:0;color:#9aa1b2;font-size:.95rem}
code{font-family:ui-monospace,"SF Mono",Menlo,monospace;color:#c2a36f}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.ring{animation:none;border-top-color:#b9740f}}
</style></head>
<body>
<div class="card">
  <div class="ring" role="status" aria-label="Waking your studio"></div>
  <h1>Waking your studio…</h1>
  <p>This studio was asleep to save resources. It's starting back up — <code>${host}</code> will open automatically.</p>
</div>
<script>
(function(){
  var url = location.pathname + (location.search ? location.search + "&" : "?") + "${POLL_PARAM}=1";
  function poll(){
    fetch(url, {method:"HEAD", cache:"no-store"}).then(function(res){
      // Still served by the activator (sleeping/waking) → keep waiting.
      if (res.headers.get("${SENTINEL_HEADER}")) { setTimeout(poll, 3000); return; }
      // Studio router is back AND actually serving (2xx/3xx) → open it. We do
      // NOT reload merely because the sentinel is gone: the studio's ingress
      // returns ~30-60s before its agent is Ready, and hitting it then yields
      // Traefik's "no available server" (404/503). Keep waiting through that gap.
      if (res.status >= 200 && res.status < 400) { location.reload(); return; }
      setTimeout(poll, 3000);
    }).catch(function(){ setTimeout(poll, 3000); });
  }
  setTimeout(poll, 3000);
})();
</script>
</body></html>`;
}

function send(
  res: ServerResponse,
  status: number,
  headers: Record<string, string>,
  body?: string,
): void {
  res.writeHead(status, { [SENTINEL_HEADER]: "1", ...headers });
  res.end(body);
}

function wantsHtml(req: IncomingMessage): boolean {
  return (req.headers["accept"] ?? "").includes("text/html");
}

export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ActivatorDeps,
): Promise<void> {
  const log = deps.logger ?? console;
  const host = (req.headers["host"] ?? "").split(":")[0];
  const rawUrl = req.url ?? "/";
  const path = rawUrl.split("?")[0];
  const ua = req.headers["user-agent"] ?? "";
  const isPoll = rawUrl.includes(`${POLL_PARAM}=1`);

  // Health endpoints for k8s probes.
  if (path === "/healthz" || path === "/readyz") {
    send(res, 200, { "content-type": "text/plain" }, "ok");
    return;
  }

  // Readiness poll from the spinner: answer with the sentinel, never wake.
  if (isPoll) {
    send(res, 200, { "content-type": "text/plain" }, req.method === "HEAD" ? undefined : "waking");
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
    const state = await deps.switchboard.powerState(host);
    status = state.status;
  } catch (err) {
    log.warn(`[activator] powerState failed for ${host}: ${err instanceof Error ? err.message : String(err)}`);
    status = "UNKNOWN";
  }

  if (status === "UNKNOWN") {
    send(res, 404, { "content-type": "text/plain" }, "no studio for this host");
    return;
  }

  // SLEEPING or WAKING (or AWAKE-but-ingress-not-yet-restored): kick the wake
  // (idempotent) and serve the spinner to browsers / 503 to clients.
  if (status === "SLEEPING") {
    deps.switchboard.wakeStudio(host).catch((err) =>
      log.warn(`[activator] wake failed for ${host}: ${err instanceof Error ? err.message : String(err)}`),
    );
    log.info(`[activator] waking ${host}`);
  }

  if (wantsHtml(req)) {
    send(res, 200, { "content-type": "text/html; charset=utf-8" }, spinnerHtml(host));
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
