import { instanceHealth } from "../config.js";
import type { AppsDeps } from "../service.js";
import { readCluster } from "./cluster.js";
import {
  digestOf,
  judgeCluster,
  judgedPods,
  judgeProbes,
  NO_DATA,
  observedDigest,
  observedSettings,
  STOPPED,
  type HealthVerdict,
  type ProbeResult,
} from "./health.js";
import type { HttpProbe } from "./probe.js";
import { INSTANCE_BASE_DOMAIN, ours } from "./reconciler.js";
import { settingsRevisionOf } from "./render.js";
import { listDueForHealth, recordHealth, type InstanceRow } from "./repo.js";

/** An instance is checked at most this often. */
export const PROBE_EVERY_MS = 30_000;
const PARALLEL = 4;

/** At most perPass rows, at most perApp of one app, in the given (oldest-checked-first) order. */
export function pickDue<T extends { app_id: string }>(
  rows: T[],
  perPass: number,
  perApp: number,
): T[] {
  const taken = new Map<string, number>();
  const out: T[] = [];
  for (const r of rows) {
    if (out.length >= perPass) break;
    const n = taken.get(r.app_id) ?? 0;
    if (n >= perApp) continue;
    taken.set(r.app_id, n + 1);
    out.push(r);
  }
  return out;
}

async function inParallel<T>(
  items: T[],
  n: number,
  run: (t: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) await run(items[next++]);
    }),
  );
}

/** A probe that throws is an answer too: no response. */
const safely =
  (probe: HttpProbe): HttpProbe =>
  async (url) => {
    try {
      return await probe(url);
    } catch (err) {
      return {
        status: null,
        contentType: null,
        error: String(err).slice(0, 200),
      };
    }
  };

async function probeHost(
  probe: HttpProbe,
  base: string,
): Promise<{ ready: ProbeResult; connect: ProbeResult | null }> {
  let ready = await probe(`${base}/ready`);
  // Switchboards before 6.2.0-dev.4 have no /ready; /health only says the process is up.
  if (ready.status === 404) ready = await probe(`${base}/health`);
  if (ready.status !== 200) return { ready, connect: null };
  return { ready, connect: await probe(`${base}/`) };
}

/**
 * One health pass (spec 14.7): judges due instances from the cluster
 * (observability's tables) and, when the cluster shows a ready pod on the
 * wanted digest, from the host itself. Writes health columns only; never an
 * environment, never status (the reconciler decides that). Runs outside the
 * per-app lock. Returns how many instances were checked.
 */
export async function monitorInstancesOnce(deps: AppsDeps): Promise<number> {
  const cfg = instanceHealth(deps.cfg);
  if (!deps.cfg.instances.enabled || cfg.mode === "off") return 0;
  const now = deps.now();
  const due = await listDueForHealth(
    deps.db,
    new Date(now.getTime() - PROBE_EVERY_MS).toISOString(),
    cfg.probesPerPass * 5,
  );
  const picked = pickDue(due, cfg.probesPerPass, cfg.probesPerApp);
  let checked = 0;
  await inParallel(picked, PARALLEL, async (row) => {
    try {
      if (await checkInstance(deps, row)) checked++;
    } catch (err) {
      deps.logger.warn(
        `[vetra-apps] health of instance ${row.id}: ${String(err).slice(0, 300)}`,
      );
      // Stamped all the same: a row that always throws must not starve the caps.
      await stamp(
        deps,
        row,
        `the check failed: ${String(err).slice(0, 200)}`,
      ).catch(() => undefined);
    }
  });
  return checked;
}

/** When the clock restarts: any change of value, digest or settings revision, or leaving the STOPPED check. */
function sinceOf(
  row: InstanceRow,
  verdict: HealthVerdict,
  digest: string | null,
  settings: string | null,
  at: string,
): string {
  const changed =
    row.health === null ||
    row.health_digest !== digest ||
    (row.health_settings ?? null) !== settings ||
    row.health !== verdict.health ||
    (row.health_check === "stopped") !== (verdict.check === "stopped");
  return changed || !row.health_since ? at : row.health_since;
}

/**
 * Records a check that judged nothing (gone, not ours, managed, or an error) as
 * unknown with no data, keeping the digests: it counts as checked, so the
 * oldest-first caps move on to the next instance.
 */
async function stamp(
  deps: AppsDeps,
  row: InstanceRow,
  reason: string,
): Promise<void> {
  const at = deps.now().toISOString();
  const verdict: HealthVerdict = { ...NO_DATA, reason };
  await recordHealth(deps.db, row, {
    health: verdict.health,
    health_check: verdict.check,
    health_reason: verdict.reason,
    health_checked_at: at,
    health_since: sinceOf(
      row,
      verdict,
      row.health_digest,
      row.health_settings ?? null,
      at,
    ),
  });
}

async function checkInstance(
  deps: AppsDeps,
  row: InstanceRow,
): Promise<boolean> {
  const state = await deps.envs.getState(row.environment_id!);
  // Gone (the reconciler recreates it), or not this App's instance: never read, never probed.
  if (!state) {
    await stamp(deps, row, "the environment is gone");
    return false;
  }
  if (!ours(state, row)) {
    await stamp(deps, row, "the environment is not this App's instance");
    return false;
  }
  const version =
    state.services.find((s) => s.type === "FUSION")?.version ?? null;
  const wanted = digestOf(version);
  const wantedSettings = settingsRevisionOf(state);
  let verdict: HealthVerdict = NO_DATA;
  let restarts: number | null = null;
  let observed: {
    digest: string | null;
    source: "pod" | "document" | null;
  } = { digest: null, source: null };
  let seenSettings: string | null = null;

  if (state.status === "STOPPED") verdict = STOPPED;
  else {
    const tenant = deps.envTenant
      ? await deps.envTenant(row.environment_id!)
      : null;
    const cluster =
      tenant && deps.observabilityDb
        ? await readCluster(
            deps.observabilityDb,
            tenant,
            state.fusion?.image ?? null,
            deps.now(),
          )
        : null;
    if (cluster === "stale")
      verdict = {
        ...NO_DATA,
        reason: "the cluster data is older than 5 minutes",
      };
    else if (cluster) {
      const judged = judgedPods(cluster.hostPods, wanted, wantedSettings);
      restarts = judged.reduce((n, p) => n + p.restartCount, 0);
      observed = observedDigest(cluster.hostPods, wanted, version);
      seenSettings = observedSettings(cluster.hostPods, wanted, wantedSettings);
      const previous =
        row.health_digest === wanted &&
        (row.health_settings ?? null) === wantedSettings
          ? row.health_restarts
          : null;
      const fromCluster = judgeCluster(
        cluster.argo,
        judged,
        previous,
        wantedSettings,
      );
      if (fromCluster) verdict = fromCluster;
      else if (deps.probe) {
        const p = await probeHost(
          safely(deps.probe),
          `https://${row.host}.${INSTANCE_BASE_DOMAIN}`,
        );
        verdict = judgeProbes(p.ready, p.connect);
      } else verdict = { ...NO_DATA, reason: "host probes are not configured" };
    }
  }

  const at = deps.now().toISOString();
  await recordHealth(deps.db, row, {
    health: verdict.health,
    health_check: verdict.check,
    health_reason: verdict.reason,
    health_checked_at: at,
    health_since: sinceOf(row, verdict, wanted, wantedSettings, at),
    health_digest: wanted,
    health_restarts: restarts,
    observed_digest: observed.digest,
    observed_digest_source: observed.source,
    health_settings: wantedSettings,
    observed_settings: seenSettings,
  });
  return true;
}
