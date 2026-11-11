/**
 * Version rules of the releases spec (section 3): every version is semver
 * (no build metadata, no leading zeros); a release has no prerelease part or
 * exactly alpha|beta|rc.<n>; anything else is a build. Builds are never
 * compared with releases.
 */
export type ParsedVersion = {
  major: number;
  minor: number;
  patch: number;
  prerelease: (string | number)[];
};

const NUM = "(0|[1-9]\\d*)";
const IDENT = "(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)";
const SEMVER = new RegExp(
  `^${NUM}\\.${NUM}\\.${NUM}(?:-(${IDENT}(?:\\.${IDENT})*))?$`,
);
const RELEASE_PRE = /^(alpha|beta|rc)\.\d+$/;

export function parseVersion(v: string): ParsedVersion | null {
  const m = SEMVER.exec(v);
  if (!m) return null;
  const prerelease = m[4]
    ? m[4].split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p))
    : [];
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease,
  };
}

export function versionKind(v: string): "release" | "build" | null {
  const m = SEMVER.exec(v);
  if (!m) return null;
  return !m[4] || RELEASE_PRE.test(m[4]) ? "release" : "build";
}

function compareIdent(a: string | number, b: string | number): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "number") return -1;
  if (typeof b === "number") return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Semver order of two releases; throws when either is a build. */
export function compareReleases(a: string, b: string): number {
  if (versionKind(a) !== "release" || versionKind(b) !== "release") {
    throw new Error(`compareReleases: ${a} or ${b} is a build, not a release`);
  }
  const x = parseVersion(a)!;
  const y = parseVersion(b)!;
  for (const k of ["major", "minor", "patch"] as const) {
    if (x[k] !== y[k]) return x[k] - y[k];
  }
  if (!x.prerelease.length || !y.prerelease.length) {
    return y.prerelease.length - x.prerelease.length;
  }
  for (let i = 0; i < Math.max(x.prerelease.length, y.prerelease.length); i++) {
    if (x.prerelease[i] === undefined) return -1;
    if (y.prerelease[i] === undefined) return 1;
    const c = compareIdent(x.prerelease[i]!, y.prerelease[i]!);
    if (c !== 0) return c;
  }
  return 0;
}
