// Mint a short-lived Renown bearer token for publishing to a Vetra registry.
//
//   PH_RENOWN_PRIVATE_KEY=<JWK keypair JSON> RENOWN_ADDRESS=0x… \
//     node scripts/ci/mint-renown-token.mjs https://registry.vetra.io
//
// The token is audience-bound to the registry URL and lives 10 minutes, so CI
// mints one per registry per run instead of storing a token that expires.
// A Renown delegation credential (RENOWN_ADDRESS -> this key's DID) must exist
// and the DID must be an owner of the package on that registry, or the publish
// is rejected.
//
// @renown/sdk is not a direct dependency: it is resolved through ph-cli, which
// depends on it, so the SDK always matches the ph-cli this repo builds with.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const registryUrl = process.argv[2];
if (!registryUrl) throw new Error("usage: mint-renown-token.mjs <registry-url>");
if (!process.env.PH_RENOWN_PRIVATE_KEY) throw new Error("PH_RENOWN_PRIVATE_KEY is not set");
if (!process.env.RENOWN_ADDRESS) throw new Error("RENOWN_ADDRESS is not set");

const require = createRequire(import.meta.url);
const phCli = createRequire(require.resolve("@powerhousedao/ph-cli/package.json"));
const { NodeKeyStorage, RenownCryptoBuilder } = await import(
  pathToFileURL(phCli.resolve("@renown/sdk/node")).href
);

const crypto = await new RenownCryptoBuilder()
  .withKeyPairStorage(new NodeKeyStorage())
  .build();

const token = await crypto.getBearerToken(process.env.RENOWN_ADDRESS, {
  aud: registryUrl,
  expiresIn: 600,
});

process.stdout.write(token);
