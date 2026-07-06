import { generateSubdomain } from "../../shared/subdomain-generator.js";
import { getTenantId } from "../../processors/vetra-cloud-environment/gitops.js";
import {
  setLabel,
  initialize,
  addPackage,
  enableService,
  approveChanges,
} from "../../document-models/vetra-cloud-environment/v1/gen/creators.js";

/** Narrow reactor surface needed to create + initialize a studio env in-process. */
export interface ReactorLike {
  /** Create a new powerhouse/vetra-cloud-environment document; returns its id. */
  createDocument(): Promise<string>;
  /** Apply a batch of (system-signed) actions to a document on the "main" branch. */
  execute(documentId: string, branch: string, actions: unknown[]): Promise<void>;
}

export interface CreateEnvConfig {
  version: string;
  sizeName: string;
  registry: string;
  /** Cloud switchboard base URL stamped as VETRA_CLOUD_SWITCHBOARD_URL so the
   * warm studio's vetra-cli creates/deploys environments against the right
   * (per-tenant) switchboard instead of the CLI's staging default. */
  switchboardUrl: string;
}

export interface CreatedStudioEnv {
  documentId: string;
  subdomain: string;
  tenantId: string;
}

/**
 * Create one ownerless, key-less studio environment and drive it to
 * CHANGES_APPROVED so the existing processor deploys it. No SET_OWNER here — the
 * env stays owner-null until claimed (claim sets the owner via system action).
 *
 * Actions are system-signed (no user in context), so `assertOwner` passes on the
 * owner-null doc without auto-claiming. Order mirrors the frontend cold flow.
 */
export async function createStudioEnvironmentDoc(
  reactor: ReactorLike,
  cfg: CreateEnvConfig,
): Promise<CreatedStudioEnv> {
  const documentId = await reactor.createDocument();
  const subdomain = generateSubdomain(documentId);
  const tenantId = getTenantId(subdomain, documentId);

  await reactor.execute(documentId, "main", [
    setLabel({ label: "Vetra Studio" }),
    initialize({
      genericSubdomain: subdomain,
      genericBaseDomain: "vetra.io",
      defaultPackageRegistry: cfg.registry,
    }),
    addPackage({ packageName: "vetra-cli", version: cfg.version }),
    enableService({
      type: "CLINT",
      prefix: "vetra-agent",
      clintConfig: {
        package: { registry: cfg.registry, name: "vetra-cli", version: cfg.version },
        env: [
          { name: "VETRA_OBSERVABILITY_CONSENT", value: "granted", isSecret: false },
          // Gate agent work on a credential: an unclaimed (key-less) warm pod
          // refuses to run until a claim injects the key — so "no key" is the
          // lock, complementing/replacing the network policy.
          { name: "VETRA_REQUIRE_API_KEY", value: "true", isSecret: false },
          // Point the agent's env-creation/deploy at the right switchboard.
          // Without this, vetra-cli falls to its staging default, so prod warm
          // studios would create environments on staging.
          {
            name: "VETRA_CLOUD_SWITCHBOARD_URL",
            value: cfg.switchboardUrl,
            isSecret: false,
          },
          // Point the agent's product PUBLISH at the pool's registry. Without
          // it, vetra-cli's resolveRegistryUrl falls to its hardcoded
          // registry.dev.vetra.io default, so prod warm studios would publish
          // products to the dev registry. Mirrors STUDIO_POOL_REGISTRY.
          {
            name: "PH_REGISTRY_URL",
            value: cfg.registry,
            isSecret: false,
          },
        ],
        serviceCommand: "vetra",
        selectedRessource: cfg.sizeName as never,
      },
      selectedRessource: cfg.sizeName as never,
    }),
    approveChanges({}),
  ]);

  return { documentId, subdomain, tenantId };
}
