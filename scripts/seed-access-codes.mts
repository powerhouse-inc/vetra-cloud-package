/** Seed early-access invite codes, optionally attaching a Claude API key to each. */
// Config format and usage: subgraphs/vetra-access-codes/README.md
import { parseArgs } from "node:util";
import { randomInt } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

type CodeEntry = {
  label?: string;
  anthropicApiKey?: string | null;
  count: number;
  maxUses?: number | null;
  expiresAt?: string | null;
};

type CreatedCode = {
  code: string;
  label: string | null;
  maxUses: number | null;
  expiresAt: string | null;
  hasAnthropicKey: boolean;
};

// A code reads as `<prefix>-<adjective>-<noun>-<suffix>`, e.g.
// `vetra-swift-otter-7k2p`; the suffix is what makes it unguessable.
const ADJECTIVES = [
  "swift", "bright", "calm", "clever", "bold", "brave", "keen", "lively",
  "merry", "nimble", "quiet", "rapid", "sunny", "witty", "eager", "gentle",
  "jolly", "lucky", "mellow", "proud", "spry", "tidy", "vivid", "warm",
];
const NOUNS = [
  "otter", "falcon", "maple", "river", "comet", "ember", "harbor", "meadow",
  "pebble", "willow", "cedar", "lark", "fern", "heron", "cove", "dune",
  "grove", "quartz", "raven", "thistle", "vale", "wren", "birch", "coral",
];
// Crockford-ish base32 without easily-confused characters (no i/l/o/u/0/1).
const SUFFIX_ALPHABET = "23456789abcdefghjkmnpqrstvwxyz";
const SUFFIX_LENGTH = 4;

function pick<T>(arr: T[]): T {
  return arr[randomInt(arr.length)];
}

function randomSuffix(): string {
  let out = "";
  for (let i = 0; i < SUFFIX_LENGTH; i++) {
    out += SUFFIX_ALPHABET[randomInt(SUFFIX_ALPHABET.length)];
  }
  return out;
}

/** A unique, memorable code name. `used` guards against an in-run collision. */
function generateCode(prefix: string, used: Set<string>): string {
  for (let attempt = 0; attempt < 100; attempt++) {
    const code = `${prefix}-${pick(ADJECTIVES)}-${pick(NOUNS)}-${randomSuffix()}`;
    if (!used.has(code)) {
      used.add(code);
      return code;
    }
  }
  throw new Error("Exhausted attempts generating a unique code name");
}

const CREATE_MUTATION = `
  mutation Create(
    $code: String!
    $label: String
    $expiresAt: String
    $maxUses: Int
    $anthropicApiKey: String
  ) {
    VetraAccessCodes {
      createInviteCode(
        code: $code
        label: $label
        expiresAt: $expiresAt
        maxUses: $maxUses
        anthropicApiKey: $anthropicApiKey
      ) {
        code
        label
        maxUses
        expiresAt
        redemptions
        hasAnthropicKey
      }
    }
  }
`;

type CreateResult = {
  code: string;
  label: string | null;
  maxUses: number | null;
  expiresAt: string | null;
  redemptions: number;
  hasAnthropicKey: boolean;
};

async function createInviteCode(
  endpoint: string,
  token: string,
  vars: Record<string, unknown>,
): Promise<CreateResult> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query: CREATE_MUTATION, variables: vars }),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${await res.text()}`);
  }
  const json = (await res.json()) as {
    data?: { VetraAccessCodes?: { createInviteCode?: CreateResult } };
    errors?: Array<{ message?: string }>;
  };
  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join("; "));
  }
  const created = json.data?.VetraAccessCodes?.createInviteCode;
  if (!created) throw new Error("Mutation returned no data");
  return created;
}

function validateConfig(raw: unknown): CodeEntry[] {
  if (!Array.isArray(raw)) throw new Error("Config must be a JSON array of entries");
  return raw.map((entry, i) => {
    const where = `entry ${i}`;
    if (typeof entry !== "object" || entry === null) throw new Error(`${where}: not an object`);
    const e = entry as Record<string, unknown>;
    if (e.anthropicApiKey != null && typeof e.anthropicApiKey !== "string") {
      throw new Error(`${where}: "anthropicApiKey" must be a string if set`);
    }
    const count = e.count;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1) {
      throw new Error(`${where}: "count" must be a positive integer`);
    }
    if (e.maxUses != null && (typeof e.maxUses !== "number" || e.maxUses < 1)) {
      throw new Error(`${where}: "maxUses" must be a positive integer if set`);
    }
    return {
      label: typeof e.label === "string" ? e.label : undefined,
      anthropicApiKey: typeof e.anthropicApiKey === "string" ? e.anthropicApiKey : null,
      count,
      maxUses: (e.maxUses as number | undefined) ?? 1,
      expiresAt: typeof e.expiresAt === "string" ? e.expiresAt : undefined,
    };
  });
}

function toCsv(rows: CreatedCode[]): string {
  const header = "code,label,maxUses,expiresAt,hasAnthropicKey";
  const lines = rows.map((r) =>
    [
      r.code,
      r.label ?? "",
      r.maxUses ?? "",
      r.expiresAt ?? "",
      r.hasAnthropicKey ? "yes" : "no",
    ]
      .map((v) => {
        const s = String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      })
      .join(","),
  );
  return [header, ...lines].join("\n") + "\n";
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      endpoint: { type: "string" },
      token: { type: "string" },
      config: { type: "string" },
      prefix: { type: "string", default: "vetra" },
      "expires-days": { type: "string" },
      out: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });

  const endpoint = values.endpoint;
  const configPath = values.config;
  const token = values.token ?? process.env.VETRA_ADMIN_TOKEN ?? "";
  const dryRun = values["dry-run"];
  const prefix = values.prefix.trim();

  if (!configPath) throw new Error("--config <path-to-keys.json> is required");
  if (!dryRun && !endpoint) throw new Error("--endpoint <switchboard-graphql-url> is required");
  if (!dryRun && !token) {
    throw new Error("An admin token is required: pass --token or set VETRA_ADMIN_TOKEN");
  }

  // A global expiry (days from now) applies to entries without their own expiresAt.
  let defaultExpiresAt: string | undefined;
  if (values["expires-days"]) {
    const days = Number(values["expires-days"]);
    if (!Number.isFinite(days) || days <= 0) throw new Error("--expires-days must be a positive number");
    defaultExpiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
  }

  const config = validateConfig(JSON.parse(readFileSync(configPath, "utf8")));
  const total = config.reduce((n, e) => n + e.count, 0);
  console.log(
    `${dryRun ? "[dry-run] " : ""}Seeding ${total} code(s) across ${config.length} set(s) -> ${endpoint ?? "(no endpoint)"}`,
  );

  const used = new Set<string>();
  const created: CreatedCode[] = [];
  const failures: Array<{ code: string; error: string }> = [];

  for (const entry of config) {
    const expiresAt = entry.expiresAt ?? defaultExpiresAt ?? null;
    const label = entry.label ?? null;
    const wantsKey = Boolean(entry.anthropicApiKey);
    for (let i = 0; i < entry.count; i++) {
      const code = generateCode(prefix, used);
      if (dryRun) {
        created.push({
          code,
          label,
          maxUses: entry.maxUses ?? null,
          expiresAt,
          hasAnthropicKey: wantsKey,
        });
        continue;
      }
      try {
        const result = await createInviteCode(endpoint!, token, {
          code,
          label,
          expiresAt,
          maxUses: entry.maxUses ?? null,
          anthropicApiKey: entry.anthropicApiKey ?? null,
        });
        // createInviteCode is idempotent on the code string: a random-name
        // collision returns the pre-existing (redeemed or differently-keyed) row.
        if (result.redemptions > 0 || result.hasAnthropicKey !== wantsKey) {
          throw new Error(`name collided with an existing code (${code}); re-run to mint a fresh one`);
        }
        created.push({
          code: result.code,
          label: result.label,
          maxUses: result.maxUses,
          expiresAt: result.expiresAt,
          hasAnthropicKey: result.hasAnthropicKey,
        });
        console.log(`  ok  ${result.code}  (key: ${result.hasAnthropicKey ? "yes" : "no"})`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push({ code, error: message });
        console.error(`  FAIL ${code}: ${message}`);
      }
    }
  }

  const csv = toCsv(created);
  if (values.out) {
    writeFileSync(values.out, csv);
    console.log(`\nWrote ${created.length} code(s) to ${values.out}`);
  } else {
    console.log("\n--- handout (code,label,maxUses,expiresAt,hasAnthropicKey) ---");
    process.stdout.write(csv);
  }

  if (failures.length) {
    console.error(`\n${failures.length} of ${total} failed.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
