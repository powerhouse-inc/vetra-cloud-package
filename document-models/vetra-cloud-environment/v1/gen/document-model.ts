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
            "type VetraCloudEnvironmentState {\n  label: String\n  genericSubdomain: String\n  genericBaseDomain: String\n  customDomain: VetraCustomDomain\n  defaultPackageRegistry: URL\n  services: [VetraCloudEnvironmentService!]!\n  packages: [VetraCloudPackage!]!\n  status: VetraCloudEnvironmentStatus!\n}\n\ntype VetraCustomDomain {\n  enabled: Boolean!\n  domain: String\n  dnsRecords: [DnsRecord!]!\n}\n\ntype DnsRecord {\n  type: String!\n  host: String!\n  value: String!\n}\n\ntype VetraCloudEnvironmentService {\n  type: VetraCloudEnvironmentServiceType!\n  prefix: String!\n  enabled: Boolean!\n  url: String\n  status: ServiceStatus!\n}\n\nenum VetraCloudEnvironmentServiceType {\n  CONNECT\n  SWITCHBOARD\n  FUSION\n}\n\nenum ServiceStatus {\n  ACTIVE\n  SUSPENDED\n  PROVISIONING\n  BILLING_ISSUE\n}\n\nenum VetraCloudEnvironmentStatus {\n  DRAFT\n  CHANGES_PENDING\n  CHANGES_APPROVED\n  CHANGES_PUSHED\n  DEPLOYING\n  DEPLOYMENt_FAILED\n  READY\n  TERMINATING\n  DESTROYED\n  ARCHIVED\n  STOPPED\n}\n\ntype VetraCloudPackage {\n  registry: URL!\n  name: String!\n  version: String\n}",
          examples: [],
          initialValue:
            '{\n  "label": null,\n  "genericSubdomain": null,\n  "genericBaseDomain": null,\n  "customDomain": {\n    "enabled": false,\n    "domain": null,\n    "dnsRecords": []\n  },\n  "defaultPackageRegistry": null,\n  "services": [],\n  "packages": [],\n  "status": "DRAFT"\n}',
        },
      },
      modules: [
        {
          id: "dm-mod-001",
          name: "data_management",
          description: "",
          operations: [
            {
              id: "op-set-env-name",
              name: "SET_LABEL",
              description: "",
              schema: "input SetLabelInput {\n  label: String!\n}",
              template: "",
              reducer:
                'if (action.input.label) {\n  state.label = action.input.label;\n  state.status = "CHANGES_PENDING";\n}',
              errors: [],
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
              errors: [],
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
              errors: [],
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
              errors: [],
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
              description: "",
              schema:
                "input EnableServiceInput {\n  type: VetraCloudEnvironmentServiceType!\n  prefix: String!\n}",
              template: "",
              reducer:
                'const { type, prefix } = action.input;\nif (!state.services) {\n  state.services = [];\n}\nconst existing = state.services.find((s) => s.type === type);\nif (existing) {\n  existing.enabled = true;\n  existing.prefix = prefix;\n} else {\n  state.services.push({ type, prefix, enabled: true, url: null, status: "PROVISIONING" });\n}\nstate.status = "CHANGES_PENDING";',
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "op-disable-svc",
              name: "DISABLE_SERVICE",
              description: "",
              schema:
                "input DisableServiceInput {\n  type: VetraCloudEnvironmentServiceType!\n}",
              template: "",
              reducer:
                'const { type } = action.input;\nif (!state.services) {\n  state.services = [];\n}\nconst service = state.services.find((s) => s.type === type);\nif (service) {\n  service.enabled = false;\n  state.status = "CHANGES_PENDING";\n}',
              errors: [],
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
              errors: [],
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
              errors: [],
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
              errors: [],
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
              ],
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
