#!/usr/bin/env node
/**
 * E2E: invite-code → claim a warm Studio environment → it becomes reachable.
 *
 * Exercises the real studio-pool flow against a LIVE switchboard:
 *   createInviteCode (admin) → redeemInviteCode → claimStudioEnvironment,
 *   then polls the claimed env's URL until it is externally reachable.
 * Deactivates the test code at the end. Exits 0 on PASS, 1 on FAIL.
 *
 * Prerequisites:
 *   - SWITCHBOARD_URL  GraphQL endpoint
 *                      (default https://switchboard.staging.vetra.io/graphql)
 *   - BEARER_TOKEN     a Renown bearer token whose address is in the
 *                      switchboard's ADMINS. Same identity mints, redeems,
 *                      and claims. Generate from a ph project: `ph access-token`.
 *   - A warm env AVAILABLE in the pool (STUDIO_POOL_SIZE > 0).
 *   - ENV_BASE_DOMAIN  base domain for the agent URL (default vetra.io).
 *
 * Run:
 *   BEARER_TOKEN=$(cd <ph-project> && ph access-token) \
 *     node subgraphs/vetra-studio-pool/e2e-claim.mjs
 */

const SWITCHBOARD_URL =
  process.env.SWITCHBOARD_URL ?? "https://switchboard.staging.vetra.io/graphql";
const BEARER_TOKEN = process.env.BEARER_TOKEN ?? "";
const BASE_DOMAIN = process.env.ENV_BASE_DOMAIN ?? "vetra.io";
const AGENT_PREFIX = "vetra-agent";
const REACHABLE_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 5_000;
const REACHABLE_STATUSES = new Set([200, 301, 302, 307, 308, 401, 403]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
function check(label, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    throw new Error(`assertion failed: ${label}`);
  }
}

async function gql(query, variables) {
  const res = await fetch(SWITCHBOARD_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${BEARER_TOKEN}` },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors?.length) throw new Error(`GraphQL: ${body.errors.map((e) => e.message).join("; ")}`);
  return body.data;
}

/** Locked/unprovisioned → 502/503/000; a serving switchboard → 200/3xx/401. */
async function probe(url) {
  try {
    const res = await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(8_000) });
    return res.status;
  } catch {
    return 0;
  }
}

async function main() {
  if (!BEARER_TOKEN) throw new Error("BEARER_TOKEN is required (generate with `ph access-token`)");
  console.log(`E2E studio claim against ${SWITCHBOARD_URL}`);

  const code = `e2e-claim-${Math.random().toString(36).slice(2, 8)}`;
  const exampleKey = "sk-ant-api03-EXAMPLE-e2e-claim-do-not-use-0000000000000000";
  let env;
  try {
    console.log(`\n[1] createInviteCode (${code})`);
    const created = await gql(
      `mutation($c:String!,$k:String){ VetraAccessCodes{ createInviteCode(code:$c,label:"e2e claim test",maxUses:3,anthropicApiKey:$k){ active hasAnthropicKey } } }`,
      { c: code, k: exampleKey },
    );
    const ci = created.VetraAccessCodes.createInviteCode;
    check("code is active", ci.active === true);
    check("code carries a Claude key", ci.hasAnthropicKey === true);

    console.log("\n[2] redeemInviteCode");
    const redeemed = await gql(
      `mutation($c:String!){ VetraAccessCodes{ redeemInviteCode(code:$c){ allowed hasAttachedKey } } }`,
      { c: code },
    );
    const r = redeemed.VetraAccessCodes.redeemInviteCode;
    check("redemption allowed", r.allowed === true);
    check("caller has the attached key", r.hasAttachedKey === true);

    console.log("\n[3] claimStudioEnvironment");
    const claimed = await gql(
      `mutation{ VetraStudioPool{ claimStudioEnvironment{ documentId subdomain tenantId } } }`,
    );
    env = claimed.VetraStudioPool.claimStudioEnvironment;
    check("claim returned an env (pool had AVAILABLE + key found)", env != null, "got null");
    check("env has documentId", !!env.documentId);
    check("env has subdomain", !!env.subdomain);
    check("env has tenantId", !!env.tenantId);
    console.log(`      claimed ${env.tenantId} (subdomain=${env.subdomain})`);

    console.log("\n[4] claimed env becomes externally reachable");
    const url = `https://${AGENT_PREFIX}.${env.subdomain}.${BASE_DOMAIN}/`;
    const start = Date.now();
    let status = 0;
    // Poll until the switchboard is actually serving. A just-claimed env
    // restarts (Reloader picks up the owner/key), so transient 000/502/503 and
    // a brief 404 (static server up before routes are ready) are expected — keep
    // polling until a serving status (2xx/3xx/401/403).
    while (Date.now() - start < REACHABLE_TIMEOUT_MS) {
      status = await probe(url);
      if (REACHABLE_STATUSES.has(status)) break;
      process.stdout.write(`      [${Math.round((Date.now() - start) / 1000)}s] HTTP ${status}…\r`);
      await sleep(POLL_INTERVAL_MS);
    }
    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(`\n      reachable HTTP ${status} after ${elapsed}s at ${url}`);
    check("env is reachable (serving, not 502/000)", REACHABLE_STATUSES.has(status), `last HTTP ${status}`);
  } finally {
    await gql(
      `mutation($c:String!){ VetraAccessCodes{ setInviteCodeActive(code:$c,active:false){ active } } }`,
      { c: code },
    ).catch(() => {});
    console.log(`\n[cleanup] deactivated ${code}`);
  }

  console.log(`\n✅ PASS — ${passed} checks; claimed env ${env.tenantId} is live and reachable.`);
}

main().catch((err) => {
  console.error(`\n❌ FAIL — ${err.message}`);
  process.exit(1);
});
