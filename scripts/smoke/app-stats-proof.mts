/**
 * Identity hub phase 3: proves the app-stats path end to end on a live stack.
 *
 *   environment pod (VETRA_REPORTING_TOKEN, VETRA_LICENSING_URL)
 *     -> Vetra vetraLicensing.reportUserStat (x-vetra-reporting-token)
 *     -> Vetra's relay -> Renown renown-stats reportUserStat
 *     -> userStats(user), appStats(appDid), renown.id /app/<did>, the user's profile
 *
 * The report is sent from INSIDE the environment's switchboard pod with the
 * pod's own variables, so it also proves they reached the environment.
 * Nothing secret is printed (presence checks print set/MISSING only).
 *
 * Usage (staging defaults):
 *   node --experimental-strip-types scripts/smoke/app-stats-proof.mts \
 *     --namespace <env namespace> --deployment <env switchboard deployment> \
 *     --app-did did:key:z... --user did:pkh:eip155:1:0x... --metric notes \
 *     [--container switchboard] [--value 42] \
 *     [--renown-switchboard https://switchboard.renown-staging.vetra.io] \
 *     [--renown-web https://renown-staging.vetra.io] [--timeout 180]
 *
 * The metric must be declared public in the app's Profile tab (vetra.io).
 * Exit 0 when every check passes; 1 at the first failing check.
 */
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    namespace: { type: "string" },
    deployment: { type: "string" },
    container: { type: "string" },
    "app-did": { type: "string" },
    user: { type: "string" },
    metric: { type: "string" },
    value: { type: "string" },
    "renown-switchboard": { type: "string", default: "https://switchboard.renown-staging.vetra.io" },
    "renown-web": { type: "string", default: "https://renown-staging.vetra.io" },
    timeout: { type: "string", default: "180" },
    "allow-prod": { type: "boolean", default: false },
  },
});

function fail(message: string): never {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

function ok(message: string): void {
  console.log(`ok   ${message}`);
}

function need(name: "namespace" | "deployment" | "app-did" | "user" | "metric"): string {
  const value = args[name];
  if (typeof value !== "string" || value.trim() === "") fail(`--${name} is required`);
  return value.trim();
}

const namespace = need("namespace");
const deployment = need("deployment");
const appDid = need("app-did");
const user = need("user");
const metric = need("metric");
// A fresh value per run, so a stale page can never pass for this run.
const value = args.value ? Number(args.value) : (Date.now() % 100_000) + 1;
if (!Number.isFinite(value)) fail("--value must be a number");
const statsUrl = `${String(args["renown-switchboard"]).replace(/\/+$/, "")}/graphql/renown-stats`;
const web = String(args["renown-web"]).replace(/\/+$/, "");
const deadline = Date.now() + Number(args.timeout) * 1000;
const address = /^did:pkh:eip155:\d+:(0x[0-9a-fA-F]{40})$/.exec(user)?.[1]?.toLowerCase() ?? null;

// Staging guard: this script writes a stat, so it must never hit production by accident.
function isStagingHost(raw: string): boolean {
  let host: string;
  try {
    host = new URL(raw).hostname;
  } catch {
    return false;
  }
  return host.includes("staging") || host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}
const PROD_NAMESPACES = ["vetra", "renown"];
let kubeContext = "unknown";
try {
  kubeContext = execFileSync("kubectl", ["config", "current-context"], { encoding: "utf8", timeout: 15000 }).trim();
} catch {
  kubeContext = "unreadable";
}
const problems: string[] = [];
if (!isStagingHost(String(args["renown-switchboard"]))) problems.push("--renown-switchboard is not a staging host");
if (!isStagingHost(String(args["renown-web"]))) problems.push("--renown-web is not a staging host");
if (PROD_NAMESPACES.includes(namespace)) problems.push(`namespace "${namespace}" is a production tenant`);
// Contexts are not reliably named (a single k3s cluster hosts both), so only a context that
// says "prod" or cannot be read is refused; the namespace and hosts carry the real check.
if (kubeContext === "unreadable" || kubeContext.toLowerCase().includes("prod")) problems.push(`kubectl context "${kubeContext}" is not usable for staging`);
if (problems.length > 0 && !args["allow-prod"]) {
  fail(`staging guard refused (pass --allow-prod to override): ${problems.join("; ")}`);
}
console.log(problems.length > 0 ? `guard OVERRIDDEN by --allow-prod: ${problems.join("; ")}` : `guard ok: no production target (context ${kubeContext}, namespace ${namespace})`);

const excerpt = (text: string): string => text.replace(/\s+/g, " ").slice(0, 200);

function inPod(command: string[]): string {
  const container = args.container ? ["-c", args.container] : [];
  try {
    return execFileSync("kubectl", ["-n", namespace, "exec", `deploy/${deployment}`, ...container, "--", ...command], {
      encoding: "utf8",
      timeout: 60000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    return fail(`kubectl exec failed: ${excerpt(typeof stderr === "string" && stderr ? stderr : String(error))}`);
  }
}

// 1. The environment holds both variables (values never leave the pod).
const presence = inPod([
  "sh",
  "-c",
  'for v in VETRA_REPORTING_TOKEN VETRA_LICENSING_URL; do if [ -n "$(printenv $v)" ]; then echo "$v set"; else echo "$v MISSING"; fi; done',
]);
if (presence.includes("MISSING")) fail(`the environment lacks its reporting variables:\n${presence.trim()}`);
ok("the environment has VETRA_REPORTING_TOKEN and VETRA_LICENSING_URL");

// The report goes to the pod's own endpoint: it must be a staging Vetra, whatever the namespace.
const podUrl = inPod(["sh", "-c", "printenv VETRA_LICENSING_URL"]).trim();
let podHost = "";
try {
  podHost = new URL(podUrl).hostname;
} catch {
  podHost = "";
}
if (!isStagingHost(podUrl)) {
  const message = `the environment's VETRA_LICENSING_URL host "${podHost || "unparseable"}" is not a staging host`;
  if (!args["allow-prod"]) fail(`staging guard refused (pass --allow-prod to override): ${message}`);
  console.log(`guard OVERRIDDEN by --allow-prod: ${message}`);
} else {
  ok(`the environment reports to ${podHost}`);
}

// 2. Report from inside the pod, exactly as package code there would.
const REPORT = [
  "const [user, metric, value] = process.argv.slice(-3);",
  "fetch(process.env.VETRA_LICENSING_URL, {",
  '  method: "POST",',
  '  headers: { "content-type": "application/json", "x-vetra-reporting-token": process.env.VETRA_REPORTING_TOKEN },',
  "  body: JSON.stringify({",
  '    query: "mutation R($u: String!, $m: String!, $v: Float!) { vetraLicensing { reportUserStat(user: $u, metric: $m, value: $v) } }",',
  "    variables: { u: user, m: metric, v: Number(value) },",
  "  }),",
  "})",
  "  .then(async (r) => console.log(JSON.stringify({ status: r.status, body: await r.json().catch(() => null) })))",
  "  .catch((e) => console.log(JSON.stringify({ error: String(e) })));",
].join("\n");
const answerLine = inPod(["node", "-e", REPORT, user, metric, String(value)]).trim().split("\n").at(-1) ?? "{}";
let answer: {
  status?: number;
  error?: string;
  body?: { data?: { vetraLicensing?: { reportUserStat?: boolean } }; errors?: unknown } | null;
};
try {
  answer = JSON.parse(answerLine) as typeof answer;
} catch {
  fail(`the pod printed something unexpected: ${excerpt(answerLine)}`);
}
if (answer.body?.data?.vetraLicensing?.reportUserStat !== true) {
  fail(`Vetra did not queue the report: ${excerpt(answerLine)} (see the Task 15 decision table)`);
}
ok(`Vetra queued ${metric}=${value} for ${user}`);

async function stats<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(statsUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15000),
  });
  const body = (await res.json().catch(() => ({}))) as { data?: T; errors?: { message?: string }[] };
  if (body.errors?.length || !body.data) throw new Error(body.errors?.[0]?.message ?? `HTTP ${res.status}`);
  return body.data;
}

async function until<T>(what: string, probe: () => Promise<T | null>): Promise<T> {
  let last = "not yet";
  for (;;) {
    try {
      const result = await probe();
      if (result !== null) return result;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() > deadline) fail(`timed out waiting for ${what} (last: ${last})`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

async function page(url: string): Promise<string> {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.text();
}

type UserStat = { appDid: string; metric: string; value: number; label: string | null };
type AppStats = { metrics: { key: string; value: number; top: { userDid: string; value: number }[] }[] } | null;

// 3. Renown stored it (the relay flushes every 5 s).
const stored = await until("Renown to store the value", async () => {
  const data = await stats<{ userStats: UserStat[] }>(
    "query U($u: String!) { userStats(userDid: $u) { appDid metric value label } }",
    { u: user },
  );
  return data.userStats.find((s) => s.appDid === appDid && s.metric === metric && s.value === value) ?? null;
});
ok(`Renown userStats has ${metric}=${value}`);
if (stored.label === null) fail(`${metric} is not declared as a public metric: declare it in the app's Profile tab`);
ok(`${metric} is declared public ("${stored.label}")`);

// 4. appStats lists THIS user's fresh value among the top contributors.
const aggregate = await until("appStats to show the value", async () => {
  const data = await stats<{ appStats: AppStats }>(
    "query S($d: String!) { appStats(appDid: $d) { metrics { key value top { userDid value } } } }",
    { d: appDid },
  );
  const m = data.appStats?.metrics.find((x) => x.key === metric);
  return m && m.top.some((t) => t.userDid === user && t.value === value) ? m : null;
});
ok(`appStats ${metric} = ${aggregate.value}`);

// 5. The public pages render it (server-rendered; markers carry raw values).
// The app page tile is a consistency check on the aggregate, not proof of this report.
const tile = new RegExp(`data-metric="${metric.replace(/[.]/g, "\\.")}"[^>]*data-value="${aggregate.value}"`);
await until(`${web}/app/<did> to show the tile`, async () => (tile.test(await page(`${web}/app/${appDid}`)) ? true : null));
ok(`${web}/app/${appDid} tile matches the aggregate (consistency)`);
if (address) {
  const marker = new RegExp(`data-metric="${metric.replace(/[.]/g, "\\.")}"[^>]*data-value="${value}"`);
  await until("the user's profile to show the stat", async () => {
    const html = await page(`${web}/profile/${address}`);
    const start = html.indexOf(`data-app-did="${appDid}"`);
    if (start < 0) return null;
    const next = html.indexOf('data-app-did="', start + 1);
    const group = html.slice(start, next < 0 ? undefined : next);
    return marker.test(group) ? true : null;
  });
  ok(`${web}/profile/${address} shows ${metric}=${value}`);
} else {
  console.log("skip the user is not a did:pkh wallet, so there is no profile page to check");
}
console.log("PROVEN app stats flow end to end");
