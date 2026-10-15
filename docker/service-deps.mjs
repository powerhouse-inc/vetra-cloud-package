// Dependency helper for the standalone service images (secrets-controller,
// housekeeping-service) in the root Dockerfile.
//
//   node service-deps.mjs manifests <package.json> <outDir>
//     Writes <outDir>/{runtime,build}/package.json: copies of the root
//     manifest that keep only the dependencies the services actually import
//     (runtime) or need to type-check (build). The version is pinned to 0.0.0
//     so the release version bump does not invalidate the cached install
//     layers -- the trimmed manifests are byte-identical across releases.
//
//   node service-deps.mjs verify <full pnpm-lock.yaml> <trimmed pnpm-lock.yaml>
//     Fails unless every package the trimmed install resolved is in the full
//     lockfile with the same integrity. The trimmed install cannot use
//     --frozen-lockfile (the root importer changed), so this keeps the image
//     pinned to exactly what the repo lockfile already locked.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Bare-module imports of the compiled controller / activator (see the
// tsconfig.{controller,housekeeping}.json scopes in the Dockerfile). The
// housekeeping activator imports only node: builtins.
const RUNTIME = ["@kubernetes/client-node", "@powerhousedao/shared", "kysely", "pg"];
// What `tsc` additionally needs: the compiler, @types/pg, and the
// `types: ["node", "vitest/globals"]` entries of the root tsconfig.json.
const BUILD = [...RUNTIME, "@types/pg", "@types/node", "typescript", "vitest"];

function pick(pkg, names) {
  const all = { ...pkg.devDependencies, ...pkg.dependencies };
  const out = {};
  for (const name of names) {
    if (!all[name]) throw new Error(`${name} is not a dependency of ${pkg.name}`);
    out[name] = all[name];
  }
  return out;
}

function manifests(pkgPath, outDir) {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  for (const [kind, names] of [["runtime", RUNTIME], ["build", BUILD]]) {
    const trimmed = {
      name: pkg.name,
      version: "0.0.0",
      private: true,
      type: pkg.type,
      dependencies: pick(pkg, names),
      pnpm: pkg.pnpm,
    };
    mkdirSync(join(outDir, kind), { recursive: true });
    writeFileSync(join(outDir, kind, "package.json"), JSON.stringify(trimmed, null, 2) + "\n");
  }
}

// `packages:` section of a v9 lockfile -> { "name@version": "resolution: {...}" }
function lockedPackages(path) {
  const lines = readFileSync(path, "utf8").split("\n");
  const out = new Map();
  let inPackages = false;
  let key = null;
  for (const line of lines) {
    if (/^\S/.test(line)) {
      inPackages = line === "packages:";
      key = null;
      continue;
    }
    if (!inPackages) continue;
    const k = line.match(/^ {2}(\S.*):$/);
    if (k) {
      key = k[1].replace(/^'(.*)'$/, "$1");
      out.set(key, "");
    } else if (key && /^ {4}resolution:/.test(line)) {
      out.set(key, line.trim());
    }
  }
  return out;
}

function verify(fullPath, trimmedPath) {
  const full = lockedPackages(fullPath);
  const trimmed = lockedPackages(trimmedPath);
  const bad = [];
  for (const [key, resolution] of trimmed) {
    if (!full.has(key)) bad.push(`${key}: not in the repo lockfile`);
    else if (full.get(key) !== resolution) bad.push(`${key}: resolution differs`);
  }
  if (trimmed.size === 0 || bad.length) {
    console.error(`trimmed install diverged from pnpm-lock.yaml:\n  ${bad.join("\n  ") || "no packages"}`);
    process.exit(1);
  }
  console.log(`verified ${trimmed.size} packages against the repo lockfile`);
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === "manifests") manifests(a, b);
else if (cmd === "verify") verify(a, b);
else {
  console.error("usage: service-deps.mjs manifests <package.json> <outDir> | verify <full-lock> <trimmed-lock>");
  process.exit(2);
}
