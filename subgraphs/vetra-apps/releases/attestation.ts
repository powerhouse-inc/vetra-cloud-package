import { bundleFromJSON } from "@sigstore/bundle";
import { TrustedRoot } from "@sigstore/protobuf-specs";
import {
  type SignedEntity,
  type Signer,
  toSignedEntity,
  toTrustMaterial,
  Verifier,
} from "@sigstore/verify";
import { uncompress } from "snappyjs";
import { appsError } from "../errors.js";
import { GITHUB_TRUSTED_ROOTS } from "./github-trusted-root.js";

export interface AttestationVerifier {
  verify(i: {
    repository: string;
    digest: string;
    commit: string;
  }): Promise<void>;
}

/** What a bundle must prove beyond a valid signature. */
export interface AttestationExpectation {
  /** Certificate issuer extension (the OIDC issuer). */
  issuer: string;
  /** Anchored pattern for the certificate's SAN URI (the signing workflow). */
  identityURI: RegExp;
  /** The commit the SLSA provenance must name. */
  commit: string;
  /** `sha256:<hex>`, one of the statement's subjects. */
  digest: string;
  /**
   * `owner/name` the build ran in. The SAN names the workflow file, which
   * another repo can call (`workflow_call`); Fulcio's Source Repository URI
   * extension and the provenance's source URI name the calling repo.
   */
  repository: string;
}

export type VerifyBundle = (
  bundle: unknown,
  expect: AttestationExpectation,
) => Promise<void>;

/** Sigstore public good (public repos) and GitHub's instance (private repos). */
export interface GithubTrustedRoots {
  publicGood: TrustedRoot;
  github: TrustedRoot;
}

const ISSUER = "https://token.actions.githubusercontent.com";
const PROVENANCE = "https://slsa.dev/provenance/v1";
const IN_TOTO = "application/vnd.in-toto+json";
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DIGEST = /^sha256:([0-9a-f]{64})$/;
/** Fulcio: Source Repository URI (UTF8String), asserted from the OIDC token. */
const OID_SOURCE_REPOSITORY_URI = "1.3.6.1.4.1.57264.1.12";
/** A Snappy blob may not declare more than this uncompressed size. */
export const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * Reads `gh attestation trusted-root` output (JSONL text, or its lines
 * already parsed) into the two roots, told apart by their Fulcio CA.
 */
export function parseTrustedRoots(
  input: string | readonly unknown[],
): GithubTrustedRoots {
  const items =
    typeof input === "string"
      ? input
          .split("\n")
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l) as unknown)
      : input;
  let publicGood: TrustedRoot | undefined;
  let github: TrustedRoot | undefined;
  for (const item of items) {
    const root = TrustedRoot.fromJSON(item);
    const onGithub = root.certificateAuthorities.some((ca) =>
      ca.uri.includes("fulcio.githubapp.com"),
    );
    if (onGithub) github = root;
    else if (
      root.certificateAuthorities.some((ca) =>
        ca.uri.includes("fulcio.sigstore.dev"),
      )
    )
      publicGood = root;
  }
  if (!publicGood || !github)
    throw new Error(
      "trusted roots must contain Sigstore public good and GitHub",
    );
  return { publicGood, github };
}

let bundledRoots: GithubTrustedRoots | undefined;
/** The bundled snapshot (github-trusted-root.ts), parsed once. */
function defaultRoots(): GithubTrustedRoots {
  return (bundledRoots ??= parseTrustedRoots(GITHUB_TRUSTED_ROOTS));
}

/**
 * Verifies the bundle's signature, certificate chain and timestamps, and
 * returns the signer. A bundle without Rekor entries comes from GitHub's
 * instance (no tlog, no CT log, one RFC 3161 timestamp required); otherwise
 * public good (one tlog entry and one SCT required). Choosing by shape is
 * safe: a certificate from one CA never chains to the other root.
 */
export function verifyBundleSignature(
  bundle: unknown,
  roots: GithubTrustedRoots = defaultRoots(),
): Signer {
  return verifyEntity(bundle, roots).signer;
}

function verifyEntity(
  bundle: unknown,
  roots: GithubTrustedRoots,
): { signer: Signer; entity: SignedEntity } {
  const parsed = bundleFromJSON(bundle);
  const onGithub = parsed.verificationMaterial.tlogEntries.length === 0;
  const verifier = onGithub
    ? new Verifier(toTrustMaterial(roots.github), {
        tlogThreshold: 0,
        ctlogThreshold: 0,
        tsaThreshold: 1,
      })
    : new Verifier(toTrustMaterial(roots.publicGood), {
        tlogThreshold: 1,
        ctlogThreshold: 1,
        tsaThreshold: 0,
      });
  const entity = toSignedEntity(parsed);
  return { signer: verifier.verify(entity), entity };
}

/** Reads a DER UTF8String (tag 0x0c, short or long form length). */
function derUtf8(der: Buffer): string {
  if (der[0] !== 0x0c) throw new Error("extension is not a UTF8String");
  if (der.length < 2) throw new Error("extension is truncated");
  let len = der[1];
  let off = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 2) throw new Error("extension length unsupported");
    len = der.readUIntBE(2, n);
    off = 2 + n;
  }
  if (off + len !== der.length) throw new Error("extension length mismatch");
  return der.subarray(off).toString("utf8");
}

/** The leaf certificate's Fulcio Source Repository URI, if any. */
function certificateSourceRepository(entity: SignedEntity): string | undefined {
  if (entity.key.$case !== "certificate") return undefined;
  const ext = entity.key.certificate.extension(OID_SOURCE_REPOSITORY_URI);
  return ext ? derUtf8(ext.value) : undefined;
}

/**
 * Throws unless both the certificate's Source Repository URI and the
 * provenance's source URI name `repository` (case-insensitive, as GitHub
 * names are).
 */
export function assertSourceRepository(
  facts: { certificate: string | undefined; provenance: string | undefined },
  repository: string,
): void {
  const repo = repository.toLowerCase();
  if (facts.certificate?.toLowerCase() !== `https://github.com/${repo}`)
    throw new Error(
      `certificate source repository ${facts.certificate ?? "none"}`,
    );
  if (
    !facts.provenance
      ?.toLowerCase()
      .startsWith(`git+https://github.com/${repo}@`)
  )
    throw new Error(`provenance source ${facts.provenance ?? "none"}`);
}

interface Statement {
  _type?: string;
  predicateType?: string;
  subject?: { digest?: Record<string, string> }[];
  predicate?: {
    buildDefinition?: {
      resolvedDependencies?: {
        uri?: string;
        digest?: { gitCommit?: string };
      }[];
    };
  };
}

/**
 * The default bundle check: a valid signature (verifyBundleSignature), then
 * the signer's issuer and workflow identity, then the signed in-toto
 * statement: SLSA provenance v1, naming `digest` as a subject and `commit`
 * as the source. The statement is read only after the signature verified.
 */
export function verifyGithubBundle(
  bundle: unknown,
  expect: AttestationExpectation,
  roots: GithubTrustedRoots = defaultRoots(),
): Promise<void> {
  return new Promise((resolve) => {
    checkGithubBundle(bundle, expect, roots);
    resolve();
  });
}

function checkGithubBundle(
  bundle: unknown,
  expect: AttestationExpectation,
  roots: GithubTrustedRoots,
): void {
  const { signer, entity } = verifyEntity(bundle, roots);
  const issuer = signer.identity?.extensions?.issuer;
  if (issuer !== expect.issuer)
    throw new Error(`certificate issuer ${issuer ?? "none"}`);
  const san = signer.identity?.subjectAlternativeName ?? "";
  if (!expect.identityURI.test(san)) throw new Error(`signed by ${san}`);

  const envelope = (
    bundle as { dsseEnvelope?: { payload?: string; payloadType?: string } }
  ).dsseEnvelope;
  if (envelope?.payloadType !== IN_TOTO || !envelope.payload)
    throw new Error("bundle carries no in-toto statement");
  const statement = JSON.parse(
    Buffer.from(envelope.payload, "base64").toString("utf8"),
  ) as Statement;
  if (statement.predicateType !== PROVENANCE)
    throw new Error(`predicate ${statement.predicateType ?? "none"}`);
  const sha = DIGEST.exec(expect.digest)?.[1];
  if (!sha || !statement.subject?.some((s) => s.digest?.sha256 === sha))
    throw new Error(`no subject ${expect.digest}`);
  const source =
    statement.predicate?.buildDefinition?.resolvedDependencies?.[0];
  assertSourceRepository(
    {
      certificate: certificateSourceRepository(entity),
      provenance: source?.uri,
    },
    expect.repository,
  );
  const commit = source?.digest?.gitCommit;
  if (commit !== expect.commit)
    throw new Error(`provenance commit ${commit ?? "none"}`);
}

/** The uncompressed length a raw Snappy blob declares (leading varint). */
function snappyLength(blob: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < 5 && i < blob.length; i++) {
    const b = blob[i];
    n += (b & 0x7f) * 2 ** (7 * i);
    if (!(b & 0x80)) return n;
  }
  throw new Error("bundle is not Snappy data");
}

/**
 * The image was built and attested by the repo's own vetra.yml workflow at
 * the reported commit (GitHub artifact attestations, spec section 3). Bundles
 * come from GitHub's attestations API with the Vetra GitHub App's
 * installation token, so private repos work.
 */
export function createGithubAttestationVerifier(opts: {
  token: (repository: string) => Promise<string>;
  fetch?: typeof fetch;
  verifyBundle?: VerifyBundle;
}): AttestationVerifier {
  const fetchImpl = opts.fetch ?? fetch;
  const verifyBundle: VerifyBundle =
    opts.verifyBundle ?? ((b, e) => verifyGithubBundle(b, e));

  /** Inline `bundle`, else the Snappy-compressed blob at `bundle_url`. */
  async function loadBundle(a: {
    bundle?: unknown;
    bundle_url?: string;
  }): Promise<unknown> {
    if (a.bundle) return a.bundle;
    if (!a.bundle_url?.startsWith("https://"))
      throw new Error("attestation has no bundle");
    const res = await fetchImpl(a.bundle_url);
    if (!res.ok) throw new Error(`bundle_url answered ${res.status}`);
    const blob = new Uint8Array(await res.arrayBuffer());
    const size = snappyLength(blob);
    if (size > MAX_BUNDLE_BYTES)
      throw new Error(`bundle declares ${size} bytes, over the limit`);
    const raw = uncompress(blob);
    return JSON.parse(new TextDecoder().decode(raw)) as unknown;
  }

  return {
    async verify({ repository, digest, commit }) {
      if (!REPOSITORY.test(repository) || repository.includes(".."))
        throw appsError("FORBIDDEN", `Invalid repository ${repository}`);
      if (!DIGEST.test(digest))
        throw appsError("FORBIDDEN", `Invalid image digest ${digest}`);
      const res = await fetchImpl(
        `https://api.github.com/repos/${repository}/attestations/${digest}?predicate_type=provenance`,
        {
          headers: {
            authorization: `Bearer ${await opts.token(repository)}`,
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
          },
        },
      );
      if (!res.ok)
        throw appsError(
          "FORBIDDEN",
          `No attestation for ${digest} in ${repository}`,
        );
      const body = (await res.json().catch(() => null)) as {
        attestations?: unknown;
      } | null;
      const attestations = Array.isArray(body?.attestations)
        ? (body.attestations as { bundle?: unknown; bundle_url?: string }[])
        : [];
      const expect: AttestationExpectation = {
        issuer: ISSUER,
        // GitHub names are case-insensitive; the repo is bound exactly by
        // its source repository checks.
        identityURI: new RegExp(
          `^https://github\\.com/${escape(repository)}/\\.github/workflows/vetra\\.yml@`,
          "i",
        ),
        commit,
        digest,
        repository,
      };
      const reasons: string[] = [];
      for (const a of attestations) {
        try {
          await verifyBundle(await loadBundle(a), expect);
          return;
        } catch (err) {
          reasons.push(err instanceof Error ? err.message : String(err));
        }
      }
      throw appsError(
        "FORBIDDEN",
        `No valid attestation for ${digest}: ${reasons.join("; ") || "none"}`,
      );
    },
  };
}
