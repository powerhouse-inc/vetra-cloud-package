import type { VetraCloudEnvironmentServicesOperations } from "document-models/vetra-cloud-environment/v1";
import {
  ClintConfigRequiredError,
  InvalidFusionConfigError,
  NotClintServiceError,
  PrefixInUseError,
  ServiceNotFoundError,
} from "../../gen/services/error.js";
import {
  assertOwner,
  markPendingIfDeployed,
  regenerateDnsRecords,
} from "./utils.js";

export const vetraCloudEnvironmentServicesOperations: VetraCloudEnvironmentServicesOperations =
  {
    enableServiceOperation(state, action) {
      assertOwner(state, action);
      const { type, prefix, clintConfig } = action.input;
      if (type === "CLINT" && !clintConfig) {
        throw new ClintConfigRequiredError(
          "clintConfig is required when enabling a CLINT service",
        );
      }
      if (!state.services) {
        state.services = [];
      }
      const collision = state.services.find(
        (s) => s.prefix === prefix && s.type !== type,
      );
      if (collision) {
        throw new PrefixInUseError(
          `prefix '${prefix}' is already used by service ${collision.type}`,
        );
      }
      const config =
        type === "CLINT" && clintConfig
          ? {
              package: {
                registry: clintConfig.package.registry,
                name: clintConfig.package.name,
                version: clintConfig.package.version ?? null,
              },
              // Normalize each env entry. Secret VALUES are intentionally
              // never persisted in the document: when isSecret=true, the
              // reducer drops the value field so the document only carries
              // a reference to the env name. The actual encrypted value
              // lives in tenant_secrets (written separately via the
              // vetra-cloud-secrets `setSecret` mutation).
              env: (clintConfig.env ?? []).map((e) => ({
                name: e.name,
                value: e.isSecret === true ? null : (e.value ?? null),
                isSecret: e.isSecret ?? null,
              })),
              serviceCommand: clintConfig.serviceCommand ?? null,
              selectedRessource: clintConfig.selectedRessource ?? null,
            }
          : null;
      // CLINT supports multiple entries per env, distinguished by prefix.
      // Other service types are singletons keyed by type alone — a re-enable
      // with a different prefix updates the existing entry.
      const existing =
        type === "CLINT"
          ? state.services.find((s) => s.type === type && s.prefix === prefix)
          : state.services.find((s) => s.type === type);
      if (existing) {
        existing.enabled = true;
        existing.prefix = prefix;
        if (config) existing.config = config;
        if (action.input.selectedRessource) {
          existing.selectedRessource = action.input.selectedRessource;
        }
      } else {
        state.services.push({
          type,
          prefix,
          enabled: true,
          url: null,
          status: "PROVISIONING",
          version: null,
          config,
          selectedRessource: action.input.selectedRessource ?? "VETRA_AGENT_S",
        });
      }
      regenerateDnsRecords(state);
      markPendingIfDeployed(state);
    },
    disableServiceOperation(state, action) {
      assertOwner(state, action);
      const { type, prefix } = action.input;
      if (!state.services) {
        state.services = [];
      }
      // CLINT supports multiple services per env keyed by prefix; without
      // a prefix the lookup would silently disable whichever clint
      // happens to come first (a real bug for multi-agent envs). When a
      // prefix is provided we filter by both. For singleton service types
      // (CONNECT/SWITCHBOARD/FUSION) prefix is optional and ignored.
      const service =
        type === "CLINT" && prefix
          ? state.services.find((s) => s.type === type && s.prefix === prefix)
          : state.services.find((s) => s.type === type);
      if (service) {
        service.enabled = false;
        regenerateDnsRecords(state);
        markPendingIfDeployed(state);
      }
    },
    toggleServiceOperation(state, action) {
      assertOwner(state, action);
      const service = state.services.find((s) => s.type === action.input.type);
      if (!service) {
        throw new ServiceNotFoundError(
          "Service " + action.input.type + " not found",
        );
      }
      service.enabled = !service.enabled;
      regenerateDnsRecords(state);
      markPendingIfDeployed(state);
    },
    updateServicePrefixOperation(state, action) {
      assertOwner(state, action);
      const service = state.services.find((s) => s.type === action.input.type);
      if (!service) {
        throw new ServiceNotFoundError(
          "Service " + action.input.type + " not found",
        );
      }
      service.prefix = action.input.prefix;
      markPendingIfDeployed(state);
    },
    setServiceStatusOperation(state, action) {
      assertOwner(state, action);
      const { type, prefix } = action.input;
      // CLINT supports multiple services per env keyed by prefix; without a
      // prefix the lookup would silently advance whichever clint happens to
      // come first — so non-first CLINT agents could never reach ACTIVE and the
      // clint-pull-worker re-fired SET_SERVICE_STATUS every tick (the storm that
      // bloated env docs to 30k ops). When a prefix is provided we filter by
      // both. Singleton types (CONNECT/SWITCHBOARD/FUSION) ignore prefix.
      const service =
        type === "CLINT" && prefix
          ? state.services.find((s) => s.type === type && s.prefix === prefix)
          : state.services.find((s) => s.type === type);
      if (!service) {
        throw new ServiceNotFoundError("Service " + type + " not found");
      }
      service.status = action.input.status;
      if (action.input.url) {
        service.url = action.input.url;
      }
    },
    setServiceVersionOperation(state, action) {
      assertOwner(state, action);
      const service = state.services.find((s) => s.type === action.input.type);
      if (!service) {
        throw new ServiceNotFoundError(
          "Service " + action.input.type + " not found",
        );
      }
      service.version = action.input.version;
      markPendingIfDeployed(state);
    },
    setServiceConfigOperation(state, action) {
      const { prefix, config } = action.input;
      if (!state.services) {
        state.services = [];
      }
      const service = state.services.find((s) => s.prefix === prefix);
      if (!service) {
        throw new ServiceNotFoundError(`No service with prefix '${prefix}'`);
      }
      if (service.type !== "CLINT") {
        throw new NotClintServiceError(
          `Service '${prefix}' is type ${service.type}; only CLINT services accept config`,
        );
      }
      service.config = {
        package: {
          registry: config.package.registry,
          name: config.package.name,
          version: config.package.version ?? null,
        },
        // Same secret-value drop as enableService — see comment there.
        env: (config.env ?? []).map((e) => ({
          name: e.name,
          value: e.isSecret === true ? null : (e.value ?? null),
          isSecret: e.isSecret ?? null,
        })),
        serviceCommand: config.serviceCommand ?? null,
        selectedRessource: config.selectedRessource ?? null,
      };
      if (config.selectedRessource) {
        service.selectedRessource = config.selectedRessource;
      }
      state.status = "CHANGES_PENDING";
    },
    setServiceSizeOperation(state, action) {
      assertOwner(state, action);
      if (!state.services) {
        state.services = [];
      }
      const service = state.services.find(
        (s) => s.prefix === action.input.prefix,
      );
      if (!service) {
        throw new ServiceNotFoundError(
          `No service with prefix '${action.input.prefix}'`,
        );
      }
      service.selectedRessource = action.input.size;
      if (service.type === "CLINT" && service.config) {
        service.config.selectedRessource = action.input.size;
      }
      markPendingIfDeployed(state);
    },
    setFusionConfigOperation(state, action) {
      const { image, env, autoUpdate, autoUpdateTagPattern } = action.input;
      const repo = image?.trim() || null;
      if (repo !== null) {
        if (!/^cr\.vetra\.io\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/.test(repo)) {
          throw new InvalidFusionConfigError(
            repo.includes(":") || repo.includes("@")
              ? `Image '${repo}' must not carry a tag or digest — the version picks the tag`
              : `Image '${repo}' must be a repository on cr.vetra.io (e.g. cr.vetra.io/<project>/<app>)`,
          );
        }
      }
      const pattern = autoUpdateTagPattern?.trim() || null;
      if (pattern !== null) {
        // The poller runs this on the shared switchboard: keep it short and
        // free of nested quantifiers (catastrophic backtracking).
        if (pattern.length > 100 || /\([^()]*[+*{][^()]*\)\s*[+*{]/.test(pattern)) {
          throw new InvalidFusionConfigError(
            `Auto-update tag pattern '${pattern}' is too long or has nested quantifiers`,
          );
        }
        try {
          new RegExp(pattern);
        } catch {
          throw new InvalidFusionConfigError(`Invalid auto-update tag pattern '${pattern}'`);
        }
      }
      for (const e of env ?? []) {
        // Names become YAML keys and env var names in the rendered values.
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(e.name)) {
          throw new InvalidFusionConfigError(`Invalid env name '${e.name}'`);
        }
        if (e.isSecret === true && e.name.startsWith("NEXT_PUBLIC_")) {
          throw new InvalidFusionConfigError(
            `'${e.name}' cannot be a secret: NEXT_PUBLIC_ values are inlined into browser JS`,
          );
        }
      }
      state.fusion = {
        image: repo,
        // Secret values never live in the document — the UI writes them to the
        // tenant secrets store; the pod gets them via envFrom <tenant>-secrets.
        env: (env ?? []).map((e) => ({
          name: e.name,
          value: e.isSecret === true ? null : (e.value ?? null),
          isSecret: e.isSecret ?? null,
        })),
        autoUpdate,
        autoUpdateTagPattern: pattern,
      };
      markPendingIfDeployed(state);
    },
  };
