// Snapshot of `DEFAULT_CONNECT_CONFIG` from
// `@powerhousedao/shared/connect/runtime-config.ts` (powerhouse monorepo,
// branch `feat/connect-config-json-2`). Bundled here so the subgraph does
// not pin a specific @powerhousedao/shared release.
//
// Update when DEFAULT_CONNECT_CONFIG changes upstream. Deployments that need
// per-instance defaults can pass `defaults` to the subgraph constructor.

import type { PHConnectRuntimeConfig } from "./types.js";

export const BUNDLED_DEFAULT_CONNECT_CONFIG: PHConnectRuntimeConfig = {
  branding: {
    appName: "Powerhouse Connect",
    homeBackground: null,
  },
  app: {
    logLevel: "info",
    basePath: "/",
  },
  packages: {
    externalEnabled: true,
  },
  drives: {
    allowAddDrive: true,
    defaultDrives: [],
    sections: {
      remote: { enabled: true, allowAdd: true, allowDelete: true },
      local: { enabled: true, allowAdd: true, allowDelete: true },
    },
  },
  renown: {
    url: "https://www.renown.id",
    networkId: "eip155",
    chainId: 1,
  },
  sentry: {
    dsn: null,
    env: "dev",
    tracing: false,
  },
};
