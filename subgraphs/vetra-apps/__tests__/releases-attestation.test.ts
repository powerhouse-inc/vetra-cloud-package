import { readFileSync } from "node:fs";
import { compress } from "snappyjs";
import { describe, expect, it } from "vitest";
import {
  createGithubAttestationVerifier,
  parseTrustedRoots,
  verifyBundleSignature,
  verifyGithubBundle,
} from "../releases/attestation.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const publicBundle = JSON.parse(fixture("attestation-bundle.json")) as unknown;
const githubBundle = JSON.parse(
  fixture("attestation-bundle-github-instance.json"),
) as unknown;
// gh attestation trusted-root output: offline, no TUF at test time.
const roots = parseTrustedRoots(fixture("github-trusted-root.jsonl"));

// cli/cli's real attestation (spike section 2), not made by a vetra.yml.
const cliCli = {
  issuer: "https://token.actions.githubusercontent.com",
  identityURI:
    /^https:\/\/github\.com\/cli\/cli\/\.github\/workflows\/deployment\.yml@/,
  commit: "63837fb778d6a39f02be0ce76ff89f2bc8d74bdc",
  digest:
    "sha256:4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d",
};

describe("GitHub attestation verifier", () => {
  it("accepts an image with a valid attestation from the repo's vetra.yml at the commit", async () => {
    const seen: unknown[] = [];
    const v = createGithubAttestationVerifier({
      token: async () => "inst-token",
      fetch: (async (url: string) => {
        expect(url).toBe(
          "https://api.github.com/repos/acme/shop/attestations/sha256:aa?predicate_type=provenance",
        );
        return json({
          attestations: [{ bundle: { provenanceCommit: "abc" } }],
        });
      }) as never,
      verifyBundle: async (bundle, identity) => {
        seen.push(identity.identityURI.source);
        if ((bundle as { provenanceCommit: string }).provenanceCommit !== "abc")
          throw new Error("commit");
      },
    });
    await expect(
      v.verify({ repository: "acme/shop", digest: "sha256:aa", commit: "abc" }),
    ).resolves.toBeUndefined();
    expect(String(seen[0])).toContain(
      "acme\\/shop\\/\\.github\\/workflows\\/vetra\\.yml@",
    );
  });

  it("refuses an image GitHub has no attestation for", async () => {
    const v = createGithubAttestationVerifier({
      token: async () => "t",
      fetch: (async () => json({ message: "Not Found" }, 404)) as never,
      verifyBundle: async () => {},
    });
    await expect(
      v.verify({ repository: "acme/shop", digest: "sha256:aa", commit: "abc" }),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });

  it("refuses when every bundle fails verification", async () => {
    const v = createGithubAttestationVerifier({
      token: async () => "t",
      fetch: (async () =>
        json({ attestations: [{ bundle: {} }, { bundle: {} }] })) as never,
      verifyBundle: async () => {
        throw new Error("bad signature");
      },
    });
    await expect(
      v.verify({ repository: "acme/shop", digest: "sha256:aa", commit: "abc" }),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });

  it("fetches a Snappy-compressed bundle_url when the API returns bundle: null", async () => {
    const blob = compress(
      new TextEncoder().encode(JSON.stringify({ provenanceCommit: "abc" })),
    );
    const urls: string[] = [];
    const v = createGithubAttestationVerifier({
      token: async () => "t",
      fetch: (async (url: string) => {
        urls.push(url);
        if (url.startsWith("https://blob.example/"))
          return new Response(blob, { status: 200 });
        return json({
          attestations: [
            { bundle: null, bundle_url: "https://blob.example/b.json.sn" },
          ],
        });
      }) as never,
      verifyBundle: async (bundle) => {
        if ((bundle as { provenanceCommit: string }).provenanceCommit !== "abc")
          throw new Error("commit");
      },
    });
    await expect(
      v.verify({ repository: "acme/shop", digest: "sha256:aa", commit: "abc" }),
    ).resolves.toBeUndefined();
    expect(urls[1]).toBe("https://blob.example/b.json.sn");
  });

  it("refuses a repository or digest that is not well formed", async () => {
    const v = createGithubAttestationVerifier({
      token: async () => "t",
      fetch: (async () => json({ attestations: [] })) as never,
      verifyBundle: async () => {},
    });
    for (const [repository, digest] of [
      ["acme/shop/../x", "sha256:aa"],
      ["acme/shop", "sha256:aa?x=1"],
      ["acme/shop", "sha512:aa"],
    ])
      await expect(
        v.verify({ repository, digest, commit: "abc" }),
      ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });
});

describe("verifyGithubBundle (real bundles, offline trust roots)", () => {
  it("verifies cli/cli's public-good provenance at its commit", async () => {
    await expect(
      verifyGithubBundle(publicBundle, cliCli, roots),
    ).resolves.toBeUndefined();
  });

  it("verifies with the bundled production trust roots too", async () => {
    await expect(
      verifyGithubBundle(publicBundle, cliCli),
    ).resolves.toBeUndefined();
  });

  it("refuses another commit", async () => {
    await expect(
      verifyGithubBundle(
        publicBundle,
        { ...cliCli, commit: "0000000000000000000000000000000000000000" },
        roots,
      ),
    ).rejects.toThrow(/commit/);
  });

  it("refuses a digest the statement does not name", async () => {
    await expect(
      verifyGithubBundle(
        publicBundle,
        { ...cliCli, digest: `sha256:${"0".repeat(64)}` },
        roots,
      ),
    ).rejects.toThrow(/subject/);
  });

  it("refuses another workflow identity", async () => {
    await expect(
      verifyGithubBundle(
        publicBundle,
        {
          ...cliCli,
          identityURI:
            /^https:\/\/github\.com\/cli\/cli\/\.github\/workflows\/vetra\.yml@/,
        },
        roots,
      ),
    ).rejects.toThrow(/signed by/);
  });

  it("refuses another issuer", async () => {
    await expect(
      verifyGithubBundle(
        publicBundle,
        { ...cliCli, issuer: "https://accounts.google.com" },
        roots,
      ),
    ).rejects.toThrow(/issuer/);
  });

  it("refuses an altered statement", async () => {
    const b = structuredClone(publicBundle) as {
      dsseEnvelope: { payload: string };
    };
    const statement = JSON.parse(
      Buffer.from(b.dsseEnvelope.payload, "base64").toString("utf8"),
    ) as {
      predicate: {
        buildDefinition: {
          resolvedDependencies: { digest: { gitCommit: string } }[];
        };
      };
    };
    statement.predicate.buildDefinition.resolvedDependencies[0]!.digest.gitCommit =
      "1111111111111111111111111111111111111111";
    b.dsseEnvelope.payload = Buffer.from(JSON.stringify(statement)).toString(
      "base64",
    );
    await expect(
      verifyGithubBundle(
        b,
        { ...cliCli, commit: "1111111111111111111111111111111111111111" },
        roots,
      ),
    ).rejects.toThrow(/signature|mismatch/i);
  });

  it("verifies a GitHub-instance (private repo shaped) bundle against GitHub's root", () => {
    const signer = verifyBundleSignature(githubBundle, roots);
    expect(signer.identity?.subjectAlternativeName).toBe(
      "https://dotcom.releases.github.com",
    );
  });

  it("refuses a GitHub-instance bundle without its timestamp", () => {
    const b = structuredClone(githubBundle) as {
      verificationMaterial: { timestampVerificationData?: unknown };
    };
    b.verificationMaterial.timestampVerificationData = {
      rfc3161Timestamps: [],
    };
    expect(() => verifyBundleSignature(b, roots)).toThrow(/timestamp/i);
  });

  it("refuses the GitHub-instance release attestation (not issued to a workflow)", async () => {
    await expect(
      verifyGithubBundle(
        githubBundle,
        {
          ...cliCli,
          identityURI: /^https:\/\/dotcom\.releases\.github\.com$/,
        },
        roots,
      ),
    ).rejects.toThrow(/issuer/);
  });
});
