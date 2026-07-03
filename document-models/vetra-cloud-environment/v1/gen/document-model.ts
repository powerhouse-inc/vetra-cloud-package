import type { DocumentModelGlobalState } from "document-model";

export const documentModel: DocumentModelGlobalState = {
  id: "powerhouse/vetra-cloud-environment",
  name: "Vetra Cloud Environment",
  author: {
    name: "Powerhouse Inc.",
    website: "https://www.powerhouse.inc",
  },
  extension: "vce",
  description: "a vetra cloud environment",
  specifications: [
    {
      state: {
        local: {
          schema: "",
          examples: [],
          initialValue: "",
        },
        global: {
          schema:
            "type VetraCloudEnvironmentState {\n  owner: EthereumAddress\n  label: String\n  genericSubdomain: String\n  genericBaseDomain: String\n  customDomain: VetraCustomDomain\n  defaultPackageRegistry: URL\n  services: [VetraCloudEnvironmentService!]!\n  packages: [VetraCloudPackage!]!\n  status: VetraCloudEnvironmentStatus!\n  apexService: VetraCloudEnvironmentServiceType\n  autoUpdateChannel: AutoUpdateChannel\n  runtimeConfig: String\n  studioInstanceId: OID\n}\n\nenum AutoUpdateChannel {\n  DEV\n  STAGING\n  LATEST\n}\n\ntype VetraCustomDomain {\n  enabled: Boolean!\n  domain: String\n  dnsRecords: [DnsRecord!]!\n}\n\ntype DnsRecord {\n  type: String!\n  host: String!\n  value: String!\n}\n\ntype VetraCloudEnvironmentService {\n  type: VetraCloudEnvironmentServiceType!\n  prefix: String!\n  enabled: Boolean!\n  url: String\n  status: ServiceStatus!\n  version: String\n  config: VetraCloudServiceClint\n  selectedRessource: VetraCloudRessourceSize\n}\n\ntype VetraCloudServiceClint {\n  package: VetraCloudPackage!\n  env: [VetraCloudServiceEnv!]!\n  serviceCommand: String\n  selectedRessource: VetraCloudRessourceSize\n}\n\ntype VetraCloudServiceEnv {\n  name: String!\n  value: String\n  isSecret: Boolean\n}\n\nenum VetraCloudRessourceSize {\n  VETRA_AGENT_S\n  VETRA_AGENT_M\n  VETRA_AGENT_L\n  VETRA_AGENT_XL\n  VETRA_AGENT_XXL\n}\n\nenum VetraCloudEnvironmentServiceType {\n  CONNECT\n  SWITCHBOARD\n  FUSION\n  CLINT\n}\n\nenum ServiceStatus {\n  ACTIVE\n  SUSPENDED\n  PROVISIONING\n  BILLING_ISSUE\n}\n\nenum VetraCloudEnvironmentStatus {\n  DRAFT\n  CHANGES_PENDING\n  CHANGES_APPROVED\n  CHANGES_PUSHED\n  DEPLOYING\n  DEPLOYMENt_FAILED\n  READY\n  TERMINATING\n  DESTROYED\n  ARCHIVED\n  STOPPED\n}\n\ntype VetraCloudPackage {\n  registry: URL!\n  name: String!\n  version: String\n}",
          examples: [],
          initialValue:
            '{\n  "owner": null,\n  "label": null,\n  "genericSubdomain": null,\n  "genericBaseDomain": null,\n  "customDomain": {\n    "enabled": false,\n    "domain": null,\n    "dnsRecords": []\n  },\n  "defaultPackageRegistry": null,\n  "services": [],\n  "packages": [],\n  "status": "DRAFT",\n  "apexService": null,\n  "autoUpdateChannel": null,\n  "runtimeConfig": null,\n  "studioInstanceId": null\n}',
        },
      },
      modules: [
        {
          id: "dm-mod-001",
          name: "data_management",
          description: "",
          operations: [
            {
              id: "op-set-owner",
              name: "SET_OWNER",
              description:
                "Claim or transfer ownership. If owner is null, signer (user-signed actions) can only set their own address; system-signed actions may set any address (used for backfill). If owner is already set, current owner must sign and may pass any new address.",
              schema: "input SetOwnerInput {\n  address: EthereumAddress!\n}",
              template: "",
              reducer:
                'const signerUser = action.context?.signer?.user;\nconst userAddr = signerUser?.address ? signerUser.address.toLowerCase() : null;\nconst inputAddr = action.input.address.toLowerCase();\nif (state.owner) {\n  if (!userAddr || userAddr !== state.owner) {\n    throw new NotOwnerError("Only the current owner can transfer ownership");\n  }\n} else if (userAddr && userAddr !== inputAddr) {\n  throw new SelfClaimRequiredError("A user-signed claim must set the signer\'s own address as owner");\n}\nstate.owner = inputAddr;',
              errors: [
                {
                  id: "err-not-owner-0",
                  name: "NotOwnerError",
                  code: "NOT_OWNER",
                  description:
                    "The action signer is not the current owner of this environment",
                  template: "",
                },
                {
                  id: "err-self-claim-required",
                  name: "SelfClaimRequiredError",
                  code: "SELF_CLAIM_REQUIRED",
                  description:
                    "A user-signed claim of an unowned environment must set the signer's own address as owner",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "op-set-env-name",
              name: "SET_LABEL",
              description: "",
              schema: "input SetLabelInput {\n  label: String!\n}",
              template: "",
              reducer:
                'if (action.input.label) {\n  state.label = action.input.label;\n  state.status = "CHANGES_PENDING";\n}',
              errors: [
                {
                  id: "err-not-owner-100",
                  name: "NotOwnerError",
                  code: "NOT_OWNER",
                  description:
                    "The action signer is not the owner of this environment",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "op-set-subdomain",
              name: "SET_GENERIC_SUBDOMAIN",
              description: "",
              schema:
                "input SetGenericSubdomainInput {\n  genericSubdomain: String!\n}",
              template: "",
              reducer:
                'if (action.input.genericSubdomain) {\n  state.genericSubdomain = action.input.genericSubdomain;\n  state.status = "CHANGES_PENDING";\n}',
              errors: [
                {
                  id: "err-not-owner-101",
                  name: "NotOwnerError",
                  code: "NOT_OWNER",
                  description:
                    "The action signer is not the owner of this environment",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "op-set-custom-domain",
              name: "SET_CUSTOM_DOMAIN",
              description: "",
              schema:
                "input SetCustomDomainInput {\n  enabled: Boolean!\n  domain: String\n}",
              template: "",
              reducer:
                'state.customDomain = {\n  enabled: action.input.enabled,\n  domain: action.input.domain || null,\n  dnsRecords: state.customDomain.dnsRecords || [],\n};\nstate.status = "CHANGES_PENDING";',
              errors: [
                {
                  id: "err-not-owner-102",
                  name: "NotOwnerError",
                  code: "NOT_OWNER",
                  description:
                    "The action signer is not the owner of this environment",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "op-set-default-registry",
              name: "SET_DEFAULT_PACKAGE_REGISTRY",
              description:
                "Set the default package registry URL for this environment",
              schema:
                "input SetDefaultPackageRegistryInput {\n  defaultPackageRegistry: URL!\n}",
              template: "",
              reducer:
                "state.defaultPackageRegistry = action.input.defaultPackageRegistry;",
              errors: [
                {
                  id: "err-not-owner-103",
                  name: "NotOwnerError",
                  code: "NOT_OWNER",
                  description:
                    "The action signer is not the owner of this environment",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "op-set-dns-records",
              name: "SET_DNS_RECORDS",
              description: "",
              schema:
                "input SetDnsRecordsInput {\n  records: [DnsRecordInput!]!\n}\n\ninput DnsRecordInput {\n  type: String!\n  host: String!\n  value: String!\n}",
              template: "",
              reducer:
                "state.customDomain.dnsRecords = action.input.records.map((r) => ({\n  type: r.type,\n  host: r.host,\n  value: r.value,\n}));",
              errors: [
                {
                  id: "err-not-owner-104",
                  name: "NotOwnerError",
                  code: "NOT_OWNER",
                  description:
                    "The action signer is not the owner of this environment",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "op-set-apex-service",
              name: "SET_APEX_SERVICE",
              description:
                "Pin one enabled service to the apex of the customDomain \u2014 the service is served at customDomain.domain instead of <prefix>.<customDomain>. Pass a null type to clear apex routing.",
              schema:
                "input SetApexServiceInput {\n  type: VetraCloudEnvironmentServiceType\n}",
              template: "",
              reducer:
                'const type = action.input.type ?? null;\nif (type) {\n  const svc = state.services.find((s) => s.type === type);\n  if (!svc || !svc.enabled) {\n    throw new ServiceNotEnabledError(type + " is not enabled \u2014 enable it before pinning to apex");\n  }\n}\nstate.apexService = type;\nif (state.status === "READY" || state.status === "DEPLOYING") {\n  state.status = "CHANGES_PENDING";\n} else if (state.status !== "DRAFT") {\n  state.status = "CHANGES_PENDING";\n}',
              errors: [
                {
                  id: "err-not-owner-115",
                  name: "NotOwnerError",
                  code: "NOT_OWNER",
                  description:
                    "The action signer is not the owner of this environment",
                  template: "",
                },
                {
                  id: "err-service-not-enabled",
                  name: "ServiceNotEnabledError",
                  code: "SERVICE_NOT_ENABLED",
                  description:
                    "Cannot pin a disabled service to the apex \u2014 enable the service first",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "op-set-auto-update-channel",
              name: "SET_AUTO_UPDATE_CHANNEL",
              description:
                "Subscribe the environment to a release channel (DEV, STAGING, LATEST) so new image releases on that channel auto-bump the enabled services' versions. Pass null to opt out.",
              schema:
                "input SetAutoUpdateChannelInput {\n  channel: AutoUpdateChannel\n}",
              template: "",
              reducer:
                "state.autoUpdateChannel = action.input.channel ?? null;",
              errors: [
                {
                  id: "err-not-owner-116",
                  name: "NotOwnerError",
                  code: "NOT_OWNER",
                  description:
                    "The action signer is not the owner of this environment",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "op-set-runtime-config",
              name: "SET_RUNTIME_CONFIG",
              description:
                "Set or clear the Connect runtime config for this environment \u2014 the operator-editable subset of powerhouse.config.json (the connect.* block and the top-level packageRegistryUrl). A null or empty-object input clears all overrides (falls back to bundled defaults). Rendered into the tenant's PH_CONNECT_CONFIG_JSON via the vetra-cloud-environment processor on CHANGES_APPROVED.",
              schema: "input SetRuntimeConfigInput {\n  config: String\n}",
              template: "",
              reducer: "state.runtimeConfig = action.input.config ?? null;",
              errors: [
                {
                  id: "err-not-owner-117",
                  name: "NotOwnerError",
                  code: "NOT_OWNER",
                  description:
                    "The action signer is not the owner of this environment",
                  template: "",
                },
                {
                  id: "err-invalid-runtime-config",
                  name: "InvalidRuntimeConfigError",
                  code: "INVALID_RUNTIME_CONFIG",
                  description:
                    "The provided runtime config failed validation against the bundled powerhouse.config.json schema (connect.* subtree and/or packageRegistryUrl)",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "op-set-studio-instance",
              name: "SET_STUDIO_INSTANCE",
              description:
                "Link this environment to the Vetra Studio that produced it (its studio environment's document id). Set when a studio deploys a package into this environment; a null input clears the link. Pure metadata \u2014 it renders nothing into the chart/gitops values, so it does not require re-deploy. null = the studio itself or an environment created directly by the user.",
              schema:
                "input SetStudioInstanceInput {\n  studioInstanceId: OID\n}",
              template: "",
              reducer:
                "state.studioInstanceId = action.input.studioInstanceId ?? null;",
              errors: [
                {
                  id: "err-not-owner-118",
                  name: "NotOwnerError",
                  code: "NOT_OWNER",
                  description:
                    "The action signer is not the owner of this environment",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
          ],
        },
        {
          id: "svc-mod-001",
          name: "services",
          description: "",
          operations: [
            {
              id: "op-enable-svc",
              name: "ENABLE_SERVICE",
              description:
                "Enable a service. For type=CLINT, clintConfig is required and is stored on the service's config field; for other types, clintConfig is ignored if provided.",
              schema:
                "input EnableServiceInput {\n  type: VetraCloudEnvironmentServiceType!\n  prefix: String!\n  clintConfig: VetraCloudServiceClintInput\n  selectedRessource: VetraCloudRessourceSize\n}\n\ninput VetraCloudServiceClintInput {\n  package: VetraCloudPackageInput!\n  env: [VetraCloudServiceEnvInput!]!\n  serviceCommand: String\n  selectedRessource: VetraCloudRessourceSize\n}\n\ninput VetraCloudPackageInput {\n  registry: URL!\n  name: String!\n  version: String\n}\n\ninput VetraCloudServiceEnvInput {\n  name: String!\n  value: String\n  isSecret: Boolean\n}",
              template: "",
              reducer:
                'const { type, prefix, clintConfig } = action.input;\nif (type === "CLINT" && !clintConfig) {\n  throw new ClintConfigRequiredError("clintConfig is required when enabling a CLINT service");\n}\nif (!state.services) {\n  state.services = [];\n}\nconst other = state.services.find((s) => s.prefix === prefix && s.type !== type);\nif (other) {\n  throw new PrefixInUseError(`prefix \'${prefix}\' is already in use by service ${other.type}`);\n}\nconst config = type === "CLINT" && clintConfig ? {\n  package: clintConfig.package,\n  env: clintConfig.env ?? [],\n  serviceCommand: clintConfig.serviceCommand ?? null,\n  selectedRessource: clintConfig.selectedRessource ?? null,\n} : null;\nconst existing = state.services.find((s) => s.type === type && s.prefix === prefix);\nif (existing) {\n  existing.enabled = true;\n  existing.prefix = prefix;\n  if (config) existing.config = config;\n} else {\n  state.services.push({ type, prefix, enabled: true, url: null, status: "PROVISIONING", version: null, config, selectedRessource: action.input.selectedRessource ?? "VETRA_AGENT_S" });\n}\nstate.status = "CHANGES_PENDING";',
              errors: [
                {
                  id: "err-not-owner-105",
                  name: "NotOwnerError",
                  code: "NOT_OWNER",
                  description:
                    "The action signer is not the owner of this environment",
                  template: "",
                },
                {
                  id: "err-clint-config-required",
                  name: "ClintConfigRequiredError",
                  code: "CLINT_CONFIG_REQUIRED",
                  description:
                    "Enabling a CLINT service requires clintConfig to be provided",
                  template: "",
                },
                {
                  id: "err-prefix-in-use-105",
                  name: "PrefixInUseError",
                  code: "PREFIX_IN_USE",
                  description:
                    "The given prefix is already used by a different service in this environment",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "op-set-service-config",
              name: "SET_SERVICE_CONFIG",
              description:
                "Update the CLINT config (package, env vars, serviceCommand, resource size, enabled endpoints) for an existing CLINT service identified by prefix.",
              schema:
                "input SetServiceConfigInput {\n  prefix: String!\n  config: VetraCloudServiceClintConfigInput!\n}\n\ninput VetraCloudServiceClintConfigInput {\n  package: VetraCloudPackageConfigInput!\n  env: [VetraCloudServiceEnvConfigInput!]!\n  serviceCommand: String\n  selectedRessource: VetraCloudRessourceSize\n}\n\ninput VetraCloudPackageConfigInput {\n  registry: URL!\n  name: String!\n  version: String\n}\n\ninput VetraCloudServiceEnvConfigInput {\n  name: String!\n  value: String\n  isSecret: Boolean\n}",
              template: "",
              reducer:
                "const { prefix, config } = action.input;\nif (!state.services) {\n  state.services = [];\n}\nconst service = state.services.find((s) => s.prefix === prefix);\nif (!service) {\n  throw new ServiceNotFoundError(`No service with prefix '${prefix}'`);\n}\nif (service.type !== \"CLINT\") {\n  throw new NotClintServiceError(`Service '${prefix}' is type ${service.type}; only CLINT services accept config`);\n}\nservice.config = {\n  package: config.package,\n  env: config.env ?? [],\n  serviceCommand: config.serviceCommand ?? null,\n  selectedRessource: config.selectedRessource ?? null,\n};\nif (config.selectedRessource) {\n  service.selectedRessource = config.selectedRessource;\n}\nstate.status = \"CHANGES_PENDING\";",
              errors: [
                {
                  id: "err-svc-not-found-config",
                  name: "ServiceNotFoundError",
                  code: "SERVICE_NOT_FOUND",
                  description: "No service exists with the given prefix",
                  template: "",
                },
                {
                  id: "err-not-clint-service",
                  name: "NotClintServiceError",
                  code: "NOT_CLINT_SERVICE",
                  description:
                    "SET_SERVICE_CONFIG only applies to CLINT services",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "op-disable-svc",
              name: "DISABLE_SERVICE",
              description: "",
              schema:
                "input DisableServiceInput {\n  type: VetraCloudEnvironmentServiceType!\n  prefix: String\n}",
              template: "",
              reducer:
                'const { type } = action.input;\nif (!state.services) {\n  state.services = [];\n}\nconst service = state.services.find((s) => s.type === type);\nif (service) {\n  service.enabled = false;\n  state.status = "CHANGES_PENDING";\n}',
              errors: [
                {
                  id: "err-not-owner-106",
                  name: "NotOwnerError",
                  code: "NOT_OWNER",
                  description:
                    "The action signer is not the owner of this environment",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "op-toggle-svc",
              name: "TOGGLE_SERVICE",
              description: "",
              schema:
                "input ToggleServiceInput {\n  type: VetraCloudEnvironmentServiceType!\n}",
              template: "",
              reducer:
                'const service = state.services.find((s) => s.type === action.input.type);\nif (!service) {\n  throw new ServiceNotFoundError("Service " + action.input.type + " not found");\n}\nservice.enabled = !service.enabled;\nstate.status = "CHANGES_PENDING";',
              errors: [
                {
                  id: "err-svc-not-found-1",
                  name: "ServiceNotFoundError",
                  code: "SERVICE_NOT_FOUND",
                  description:
                    "The specified service type was not found in the environment",
                  template: "",
                },
                {
                  id: "err-not-owner-107",
                  name: "NotOwnerError",
                  code: "NOT_OWNER",
                  description:
                    "The action signer is not the owner of this environment",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "op-update-svc-prefix",
              name: "UPDATE_SERVICE_PREFIX",
              description: "",
              schema:
                "input UpdateServicePrefixInput {\n  type: VetraCloudEnvironmentServiceType!\n  prefix: String!\n}",
              template: "",
              reducer:
                'const service = state.services.find((s) => s.type === action.input.type);\nif (!service) {\n  throw new ServiceNotFoundError("Service " + action.input.type + " not found");\n}\nservice.prefix = action.input.prefix;\nstate.status = "CHANGES_PENDING";',
              errors: [
                {
                  id: "err-svc-not-found-2",
                  name: "ServiceNotFoundError",
                  code: "SERVICE_NOT_FOUND",
                  description:
                    "The specified service type was not found in the environment",
                  template: "",
                },
                {
                  id: "err-not-owner-108",
                  name: "NotOwnerError",
                  code: "NOT_OWNER",
                  description:
                    "The action signer is not the owner of this environment",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "op-set-svc-status",
              name: "SET_SERVICE_STATUS",
              description: "",
              schema:
                "input SetServiceStatusInput {\n  type: VetraCloudEnvironmentServiceType!\n  status: ServiceStatus!\n  url: String\n}",
              template: "",
              reducer:
                'const service = state.services.find((s) => s.type === action.input.type);\nif (!service) {\n  throw new ServiceNotFoundError("Service " + action.input.type + " not found");\n}\nservice.status = action.input.status;\nif (action.input.url) {\n  service.url = action.input.url;\n}',
              errors: [
                {
                  id: "err-svc-not-found-3",
                  name: "ServiceNotFoundError",
                  code: "SERVICE_NOT_FOUND",
                  description:
                    "The specified service type was not found in the environment",
                  template: "",
                },
                {
                  id: "err-not-owner-109",
                  name: "NotOwnerError",
                  code: "NOT_OWNER",
                  description:
                    "The action signer is not the owner of this environment",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "op-set-svc-version",
              name: "SET_SERVICE_VERSION",
              description: "Set the version/image tag for a service",
              schema:
                "input SetServiceVersionInput {\n  type: VetraCloudEnvironmentServiceType!\n  version: String!\n}",
              template: "",
              reducer:
                'const service = state.services.find((s) => s.type === action.input.type);\nif (!service) {\n  throw new ServiceNotFoundError("Service " + action.input.type + " not found");\n}\nservice.version = action.input.version;\nmarkPendingIfDeployed(state);',
              errors: [
                {
                  id: "err-svc-not-found-4",
                  name: "ServiceNotFoundError",
                  code: "SERVICE_NOT_FOUND",
                  description:
                    "The specified service type was not found in the environment",
                  template: "",
                },
                {
                  id: "err-not-owner-110",
                  name: "NotOwnerError",
                  code: "NOT_OWNER",
                  description:
                    "The action signer is not the owner of this environment",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "op-set-service-size",
              name: "SET_SERVICE_SIZE",
              description:
                "Set the t-shirt resource size of an existing service (any type) by prefix.",
              schema:
                "input SetServiceSizeInput {\n  prefix: String!\n  size: VetraCloudRessourceSize!\n}",
              template: "",
              reducer:
                'const service = state.services?.find((s) => s.prefix === action.input.prefix);\nif (!service) {\n  throw new ServiceNotFoundError(`No service with prefix \'${action.input.prefix}\'`);\n}\nservice.selectedRessource = action.input.size;\nif (service.type === "CLINT" && service.config) {\n  service.config.selectedRessource = action.input.size;\n}\nstate.status = "CHANGES_PENDING";',
              errors: [
                {
                  id: "err-service-not-found-set-size",
                  name: "ServiceNotFoundError",
                  code: "SERVICE_NOT_FOUND",
                  description:
                    "No service with the given prefix exists in this environment",
                  template: "",
                },
                {
                  id: "err-not-owner-set-size",
                  name: "NotOwnerError",
                  code: "NOT_OWNER",
                  description:
                    "The action signer is not the owner of this environment",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
          ],
        },
        {
          id: "pkg-mod-001",
          name: "packages",
          description: "",
          operations: [
            {
              id: "op-add-pkg",
              name: "ADD_PACKAGE",
              description: "",
              schema:
                "input AddPackageInput {\n  registry: URL\n  packageName: String!\n  version: String\n}",
              template: "",
              reducer:
                'const { packageName, version, registry } = action.input;\nif (!state.packages) {\n  state.packages = [];\n}\nconst resolvedVersion = version ?? "latest";\nconst resolvedRegistry = registry || state.defaultPackageRegistry || "";\nconst existing = state.packages.find((p) => p.name === packageName);\nif (existing) {\n  existing.version = resolvedVersion;\n  if (registry) existing.registry = resolvedRegistry;\n} else {\n  state.packages.push({ registry: resolvedRegistry, name: packageName, version: resolvedVersion });\n}\nstate.status = "CHANGES_PENDING";',
              errors: [
                {
                  id: "err-not-owner-111",
                  name: "NotOwnerError",
                  code: "NOT_OWNER",
                  description:
                    "The action signer is not the owner of this environment",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "op-rm-pkg",
              name: "REMOVE_PACKAGE",
              description: "",
              schema: "input RemovePackageInput {\n  packageName: String!\n}",
              template: "",
              reducer:
                'const { packageName } = action.input;\nif (!state.packages) {\n  state.packages = [];\n}\nif (packageName) {\n  state.packages = state.packages.filter((p) => p.name !== packageName);\n  state.status = "CHANGES_PENDING";\n}',
              errors: [
                {
                  id: "err-not-owner-112",
                  name: "NotOwnerError",
                  code: "NOT_OWNER",
                  description:
                    "The action signer is not the owner of this environment",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "op-set-pkg-version",
              name: "SET_PACKAGE_VERSION",
              description: "Set the version of an installed package",
              schema:
                "input SetPackageVersionInput {\n  packageName: String!\n  version: String!\n}",
              template: "",
              reducer:
                'const pkg = state.packages.find((p) => p.name === action.input.packageName);\nif (!pkg) {\n  throw new PackageNotFoundError("Package " + action.input.packageName + " not found");\n}\npkg.version = action.input.version;\nmarkPendingIfDeployed(state);',
              errors: [
                {
                  id: "err-pkg-not-found",
                  name: "PackageNotFoundError",
                  code: "PACKAGE_NOT_FOUND",
                  description:
                    "The specified package was not found in the environment",
                  template: "",
                },
                {
                  id: "err-not-owner-113",
                  name: "NotOwnerError",
                  code: "NOT_OWNER",
                  description:
                    "The action signer is not the owner of this environment",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
          ],
        },
        {
          id: "st-mod-001",
          name: "status_transitions",
          description:
            "Operations that manage the environment lifecycle status transitions",
          operations: [
            {
              id: "op-initialize",
              name: "INITIALIZE",
              description: "",
              schema:
                "input InitializeInput {\n  genericSubdomain: String!\n  genericBaseDomain: String!\n  defaultPackageRegistry: URL\n}",
              template: "",
              reducer:
                'if (state.status !== "DRAFT") {\n  throw new InvalidStatusTransitionError("INITIALIZE can only be called from DRAFT status, current: " + state.status);\n}\nstate.genericSubdomain = action.input.genericSubdomain;\nstate.genericBaseDomain = action.input.genericBaseDomain;\nstate.defaultPackageRegistry = action.input.defaultPackageRegistry || null;\nstate.status = "CHANGES_APPROVED";',
              errors: [
                {
                  id: "err-invalid-status-1",
                  name: "InvalidStatusTransitionError",
                  code: "INVALID_STATUS_TRANSITION",
                  description:
                    "The operation cannot be performed from the current environment status",
                  template: "",
                },
                {
                  id: "err-not-owner-114",
                  name: "NotOwnerError",
                  code: "NOT_OWNER",
                  description:
                    "The action signer is not the owner of this environment",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "op-mark-changes-pushed",
              name: "MARK_CHANGES_PUSHED",
              description: "",
              schema:
                "input MarkChangesPushedInput {\n  _placeholder: String\n}",
              template: "",
              reducer:
                'if (state.status !== "CHANGES_APPROVED") {\n  throw new InvalidStatusTransitionError("MARK_CHANGES_PUSHED can only be called from CHANGES_APPROVED status, current: " + state.status);\n}\nstate.status = "CHANGES_PUSHED";',
              errors: [
                {
                  id: "err-invalid-status-2",
                  name: "InvalidStatusTransitionError",
                  code: "INVALID_STATUS_TRANSITION",
                  description:
                    "The operation cannot be performed from the current environment status",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "op-mark-deploy-started",
              name: "MARK_DEPLOYMENT_STARTED",
              description: "",
              schema:
                "input MarkDeploymentStartedInput {\n  _placeholder: String\n}",
              template: "",
              reducer:
                'if (state.status !== "CHANGES_PUSHED") {\n  throw new InvalidStatusTransitionError("MARK_DEPLOYMENT_STARTED can only be called from CHANGES_PUSHED status, current: " + state.status);\n}\nstate.status = "DEPLOYING";',
              errors: [
                {
                  id: "err-invalid-status-3",
                  name: "InvalidStatusTransitionError",
                  code: "INVALID_STATUS_TRANSITION",
                  description:
                    "The operation cannot be performed from the current environment status",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "op-report-deploy-ok",
              name: "REPORT_DEPLOYMENT_SUCCEEDED",
              description: "",
              schema:
                "input ReportDeploymentSucceededInput {\n  _placeholder: String\n}",
              template: "",
              reducer:
                'if (state.status !== "DEPLOYING") {\n  throw new InvalidStatusTransitionError("REPORT_DEPLOYMENT_SUCCEEDED can only be called from DEPLOYING status, current: " + state.status);\n}\nstate.status = "READY";',
              errors: [
                {
                  id: "err-invalid-status-4",
                  name: "InvalidStatusTransitionError",
                  code: "INVALID_STATUS_TRANSITION",
                  description:
                    "The operation cannot be performed from the current environment status",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "op-report-deploy-fail",
              name: "REPORT_DEPLOYMENT_FAILED",
              description: "",
              schema:
                "input ReportDeploymentFailedInput {\n  code: String!\n  message: String!\n}",
              template: "",
              reducer:
                'if (state.status !== "DEPLOYING") {\n  throw new InvalidStatusTransitionError("REPORT_DEPLOYMENT_FAILED can only be called from DEPLOYING status, current: " + state.status);\n}\nstate.status = "DEPLOYMENt_FAILED";',
              errors: [
                {
                  id: "err-invalid-status-5",
                  name: "InvalidStatusTransitionError",
                  code: "INVALID_STATUS_TRANSITION",
                  description:
                    "The operation cannot be performed from the current environment status",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "op-approve-changes",
              name: "APPROVE_CHANGES",
              description: "",
              schema: "input ApproveChangesInput {\n  _placeholder: String\n}",
              template: "",
              reducer:
                'if (state.status !== "CHANGES_PENDING") {\n  throw new InvalidStatusTransitionError("APPROVE_CHANGES can only be called from CHANGES_PENDING status, current: " + state.status);\n}\nstate.status = "CHANGES_APPROVED";',
              errors: [
                {
                  id: "err-invalid-status-6",
                  name: "InvalidStatusTransitionError",
                  code: "INVALID_STATUS_TRANSITION",
                  description:
                    "The operation cannot be performed from the current environment status",
                  template: "",
                },
                {
                  id: "err-not-owner-115",
                  name: "NotOwnerError",
                  code: "NOT_OWNER",
                  description:
                    "The action signer is not the owner of this environment",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "op-terminate",
              name: "TERMINATE_ENVIRONMENT",
              description: "",
              schema:
                "input TerminateEnvironmentInput {\n  _placeholder: String\n}",
              template: "",
              reducer: 'state.status = "TERMINATING";',
              errors: [
                {
                  id: "err-not-owner-116",
                  name: "NotOwnerError",
                  code: "NOT_OWNER",
                  description:
                    "The action signer is not the owner of this environment",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "op-mark-destroyed",
              name: "MARK_DESTROYED",
              description: "",
              schema: "input MarkDestroyedInput {\n  _placeholder: String\n}",
              template: "",
              reducer:
                'if (state.status !== "TERMINATING") {\n  throw new InvalidStatusTransitionError("MARK_DESTROYED can only be called from TERMINATING status, current: " + state.status);\n}\nstate.status = "DESTROYED";',
              errors: [
                {
                  id: "err-invalid-status-7",
                  name: "InvalidStatusTransitionError",
                  code: "INVALID_STATUS_TRANSITION",
                  description:
                    "The operation cannot be performed from the current environment status",
                  template: "",
                },
                {
                  id: "err-not-owner-117",
                  name: "NotOwnerError",
                  code: "NOT_OWNER",
                  description:
                    "The action signer is not the owner of this environment",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "op-archive",
              name: "ARCHIVE",
              description: "",
              schema: "input ArchiveInput {\n  _placeholder: String\n}",
              template: "",
              reducer:
                'if (state.status !== "DESTROYED") {\n  throw new InvalidStatusTransitionError("ARCHIVE can only be called from DESTROYED status, current: " + state.status);\n}\nstate.status = "ARCHIVED";',
              errors: [
                {
                  id: "err-invalid-status-8",
                  name: "InvalidStatusTransitionError",
                  code: "INVALID_STATUS_TRANSITION",
                  description:
                    "The operation cannot be performed from the current environment status",
                  template: "",
                },
                {
                  id: "err-not-owner-118",
                  name: "NotOwnerError",
                  code: "NOT_OWNER",
                  description:
                    "The action signer is not the owner of this environment",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "op-unarchive",
              name: "UNARCHIVE",
              description: "",
              schema: "input UnarchiveInput {\n  _placeholder: String\n}",
              template: "",
              reducer:
                'if (state.status !== "ARCHIVED") {\n  throw new InvalidStatusTransitionError("UNARCHIVE can only be called from ARCHIVED status, current: " + state.status);\n}\nstate.status = "DESTROYED";',
              errors: [
                {
                  id: "err-invalid-status-9",
                  name: "InvalidStatusTransitionError",
                  code: "INVALID_STATUS_TRANSITION",
                  description:
                    "The operation cannot be performed from the current environment status",
                  template: "",
                },
                {
                  id: "err-not-owner-119",
                  name: "NotOwnerError",
                  code: "NOT_OWNER",
                  description:
                    "The action signer is not the owner of this environment",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "op-sleep",
              name: "SLEEP_ENVIRONMENT",
              description:
                "Put a claimed studio to sleep (housekeeping). Renders global.disabled via the processor so the workload + ingress are removed while the namespace/PVC/cert/secrets remain.",
              schema:
                "input SleepEnvironmentInput {\n  _placeholder: String\n}",
              template: "",
              reducer: 'state.status = "STOPPED";',
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "op-wake",
              name: "WAKE_ENVIRONMENT",
              description:
                "Wake a sleeping studio (housekeeping). Re-approves the existing config (STOPPED -> CHANGES_APPROVED) so the processor re-renders enabled values and the normal deploy pipeline brings it back to READY.",
              schema: "input WakeEnvironmentInput {\n  _placeholder: String\n}",
              template: "",
              reducer: 'state.status = "CHANGES_APPROVED";',
              errors: [],
              examples: [],
              scope: "global",
            },
          ],
        },
      ],
      version: 1,
      changeLog: [],
    },
  ],
};
