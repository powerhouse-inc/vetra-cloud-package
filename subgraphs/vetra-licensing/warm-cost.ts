import {
  APP_RESOURCE_MAP,
  DEFAULT_RESOURCE_SIZE,
} from "../../processors/vetra-cloud-environment/gitops.js";

const BINARY: Record<string, number> = { Ki: 1 / 1024 ** 2, Mi: 1 / 1024, Gi: 1, Ti: 1024 };
const DECIMAL: Record<string, number> = { k: 1e3 / 2 ** 30, M: 1e6 / 2 ** 30, G: 1e9 / 2 ** 30 };

/** A k8s CPU quantity ("500m", "2") in cores. */
export function parseCpu(q: string): number {
  return q.endsWith("m") ? Number(q.slice(0, -1)) / 1000 : Number(q);
}

/** A k8s memory quantity ("512Mi", "1Gi") in GiB. */
export function parseMemoryGi(q: string): number {
  const m = /^([0-9.]+)([A-Za-z]*)$/.exec(q);
  if (!m) throw new Error(`unparseable memory quantity "${q}"`);
  const n = Number(m[1]);
  const unit = m[2] ?? "";
  if (unit === "") return n / 2 ** 30;
  const f = BINARY[unit] ?? DECIMAL[unit];
  if (f === undefined) throw new Error(`unknown memory unit "${unit}"`);
  return n * f;
}

const EUR_PER_NODE_MONTH = 40;

/**
 * The monthly cost of one warm environment: the nodes its REQUESTED resources
 * need (a node is 2 vCPU / 4 GB) plus one node of overhead. The size is the
 * FUSION service's, from the table gitops deploys with; null (no size) runs at
 * the default.
 */
export function estimateEnvironmentEurPerMonth(size: string | null): number {
  const key = Object.keys(APP_RESOURCE_MAP).find((k) => k === size);
  const spec = APP_RESOURCE_MAP[(key ?? DEFAULT_RESOURCE_SIZE) as keyof typeof APP_RESOURCE_MAP];
  const cpu = parseCpu(spec.requests.cpu);
  const mem = parseMemoryGi(spec.requests.memory);
  return EUR_PER_NODE_MONTH * (Math.ceil(Math.max(cpu / 2, mem / 4)) + 1);
}
