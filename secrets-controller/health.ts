import { createServer, type Server } from "node:http";

/**
 * Start a minimal HTTP server exposing `/healthz` and `/readyz` for k8s
 * probes. Both endpoints take their truth from caller-supplied predicates
 * — this module owns the listening socket only, not what "healthy" means.
 *
 * - `/healthz` returns 200 when the Postgres LISTEN socket is connected.
 *   k8s liveness probe reads this; a sustained false flips the pod into
 *   CrashLoopBackoff and the controller restarts (which itself reconnects).
 * - `/readyz` returns 200 once the startup full sweep has finished.
 *   k8s readiness probe reads this; the Service won't route traffic to
 *   the pod until then. We don't actually serve traffic, so readiness is
 *   only useful as an indicator visible via `kubectl get pods`.
 */
export interface HealthSignals {
  listenerConnected(): boolean;
  startupReconcileDone(): boolean;
}

export function startHealthServer(port: number, signals: HealthSignals): Server {
  const server = createServer((req, res) => {
    if (req.url === "/healthz") {
      const ok = signals.listenerConnected();
      res.statusCode = ok ? 200 : 503;
      res.end(ok ? "ok" : "listener disconnected");
      return;
    }
    if (req.url === "/readyz") {
      const ok = signals.startupReconcileDone();
      res.statusCode = ok ? 200 : 503;
      res.end(ok ? "ok" : "startup reconcile pending");
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  server.listen(port, () => {
    console.info(`[health] listening on :${port}`);
  });
  return server;
}
