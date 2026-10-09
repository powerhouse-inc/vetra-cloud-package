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

function inPod(command: string[]): string {
  const container = args.container ? ["-c", args.container] : [];
  return execFileSync("kubectl", ["-n", namespace, "exec", `deploy/${deployment}`, ...container, "--", ...command], {
    encoding: "utf8",
  });
}

// 1. The environment holds both variables (values never leave the pod).
const presence = inPod([
  "sh",
  "-c",
  'for v in VETRA_REPORTING_TOKEN VETRA_LICENSING_URL; do if [ -n "$(printenv $v)" ]; then echo "$v set"; else echo "$v MISSING"; fi; done',
]);
if (presence.includes("MISSING")) fail(`the environment lacks its reporting variables:\n${presence.trim()}`);
ok("the environment has VETRA_REPORTING_TOKEN and VETRA_LICENSING_URL");

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
const answer = JSON.parse(answerLine) as {
  status?: number;
  error?: string;
  body?: { data?: { vetraLicensing?: { reportUserStat?: boolean } }; errors?: unknown } | null;
};
if (answer.body?.data?.vetraLicensing?.reportUserStat !== true) {
  fail(`Vetra did not queue the report: ${answerLine} (see the Task 15 decision table)`);
}
ok(`Vetra queued ${metric}=${value} for ${user}`);

async function stats<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(statsUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json()) as { data?: T; errors?: { message?: string }[] };
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
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.text();
}

type UserStat = { appDid: string; metric: string; value: number; label: string | null };
type AppStats = { metrics: { key: string; value: number; top: { value: number }[] }[] } | null;

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

// 4. appStats shows it, with this user among the top contributors.
const aggregate = await until("appStats to show the value", async () => {
  const data = await stats<{ appStats: AppStats }>(
    "query S($d: String!) { appStats(appDid: $d) { metrics { key value top { value } } } }",
    { d: appDid },
  );
  const m = data.appStats?.metrics.find((x) => x.key === metric);
  return m && m.top.some((t) => t.value === value) ? m : null;
});
ok(`appStats ${metric} = ${aggregate.value}`);

// 5. The public pages render it (server-rendered; markers carry raw values).
const tile = new RegExp(`data-metric="${metric.replace(/[.]/g, "\\.")}"[^>]*data-value="${aggregate.value}"`);
await until(`${web}/app/<did> to show the tile`, async () => (tile.test(await page(`${web}/app/${appDid}`)) ? true : null));
ok(`${web}/app/${appDid} shows ${metric}`);
if (address) {
  const row = new RegExp(`data-metric="${metric.replace(/[.]/g, "\\.")}"[^>]*data-value="${value}"`);
  await until("the user's profile to show the stat", async () => {
    const html = await page(`${web}/profile/${address}`);
    return html.includes(`data-app-did="${appDid}"`) && row.test(html) ? true : null;
  });
  ok(`${web}/profile/${address} shows ${metric}=${value}`);
} else {
  console.log("skip the user is not a did:pkh wallet, so there is no profile page to check");
}
console.log("PROVEN app stats flow end to end");
