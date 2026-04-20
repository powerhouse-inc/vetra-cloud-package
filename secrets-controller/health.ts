import http from "node:http";

export interface HealthState {
  listenerConnected: () => boolean;
  startupReconcileDone: () => boolean;
}

export function startHealthServer(
  port: number,
  state: HealthState,
): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === "/healthz") {
      const ok = state.listenerConnected();
      res.writeHead(ok ? 200 : 503, { "Content-Type": "text/plain" });
      res.end(ok ? "ok" : "listener disconnected");
      return;
    }
    if (req.url === "/readyz") {
      const ok = state.listenerConnected() && state.startupReconcileDone();
      res.writeHead(ok ? 200 : 503, { "Content-Type": "text/plain" });
      res.end(ok ? "ready" : "not ready");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(port, () => {
    console.info(`[health] listening on :${port}`);
  });
  return server;
}
