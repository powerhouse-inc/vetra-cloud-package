import { context } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";

/**
 * Run `fn` with OpenTelemetry tracing suppressed for the duration of the
 * call (and anything it awaits within the same async context).
 *
 * The management Switchboard's background pollers — the 60s reconcile loop
 * and the 15s clint pull-worker — issue Postgres queries and Kubernetes API
 * calls on a fixed cadence. Under the Switchboard's auto-instrumentation
 * (pg + http) each of those becomes a root span, i.e. a standalone Sentry
 * transaction and a Tempo trace, at a rate that scales O(tenant-count).
 * That telemetry has no diagnostic value (there's no request to correlate
 * it to) and at hundreds–thousands of tenants it dominates ingest volume.
 *
 * Suppressing at the source makes poller spans structurally zero,
 * independent of whatever head-sampling rate the deployment is running —
 * cleaner than sampling them away downstream. Health/throughput of the
 * pollers is tracked via metrics, not traces.
 *
 * `context.with` + `suppressTracing` are safe no-ops when no OpenTelemetry
 * SDK is registered (e.g. in unit tests), so callers need no guards.
 */
export function withTracingSuppressed<T>(fn: () => Promise<T>): Promise<T> {
  return context.with(suppressTracing(context.active()), fn);
}
