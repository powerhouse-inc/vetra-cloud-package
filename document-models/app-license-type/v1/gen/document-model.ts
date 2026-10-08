import type { DocumentModelGlobalState } from "document-model";

export const documentModel: DocumentModelGlobalState = {
  id: "powerhouse/app-license-type",
  name: "AppLicenseType",
  author: {
    name: "Powerhouse Inc.",
    website: "https://www.powerhouse.inc",
  },
  extension: "lict",
  description:
    "A kind of license an app can grant, and the environment template it provisions.",
  specifications: [
    {
      version: 1,
      changeLog: [],
      state: {
        global: {
          schema:
            "type AppLicenseTypeState {\n  app: PHID\n  kind: String\n  label: String\n  validityDays: Int\n  template: EnvironmentTemplate\n  status: LicenseTypeStatus!\n}\n\nenum LicenseTypeStatus {\n  DRAFT\n  ACTIVE\n  RETIRED\n}\n\nenum TemplateServiceType {\n  CONNECT\n  SWITCHBOARD\n  FUSION\n  CLINT\n  DOCLING\n  PAPERLESS\n  SPECKLE\n}\n\ntype EnvironmentTemplate {\n  services: [TemplateService!]!\n  packages: [TemplatePackage!]!\n  size: String\n  baseDomain: String\n  packageRegistry: URL\n}\n\ntype TemplateService {\n  id: OID!\n  type: TemplateServiceType!\n  prefix: String\n  artifactName: String\n  artifactChannel: AutoUpdateChannel\n}\n\nenum AutoUpdateChannel {\n  DEV\n  STAGING\n  LATEST\n}\n\ntype TemplatePackage {\n  id: OID!\n  packageName: String\n  version: String\n}",
          initialValue:
            '{\n  "app": null,\n  "kind": null,\n  "label": null,\n  "validityDays": null,\n  "template": null,\n  "status": "DRAFT"\n}',
          examples: [],
        },
        local: {
          schema: "",
          initialValue: "",
          examples: [],
        },
      },
      modules: [
        {
          id: "lt-mod-001",
          name: "license_type",
          description: "",
          operations: [
            {
              id: "op-set-license-type-details",
              name: "SET_LICENSE_TYPE_DETAILS",
              description:
                "Set the app, kind, label and validity of this license type.",
              schema:
                "input SetLicenseTypeDetailsInput {\n  app: PHID\n  kind: String\n  label: String\n  validityDays: Int\n}",
              template: "",
              reducer:
                'if (action.input.validityDays != null && action.input.validityDays <= 0) {\n  throw new NegativeValidityError("validityDays must be positive");\n}\nif (action.input.app) state.app = action.input.app;\nif (action.input.kind) state.kind = action.input.kind;\nif (action.input.label) state.label = action.input.label;\nstate.validityDays = action.input.validityDays ?? null;',
              errors: [
                {
                  id: "err-negative-validity",
                  name: "NegativeValidityError",
                  code: "NEGATIVE_VALIDITY",
                  description: "validityDays must be a positive number of days",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "op-set-template",
              name: "SET_TEMPLATE",
              description: "Set the scalar fields of the environment template.",
              schema:
                "input SetTemplateInput {\n  size: String\n  baseDomain: String\n  packageRegistry: URL\n}",
              template: "",
              reducer:
                "state.template ??= { services: [], packages: [], size: null, baseDomain: null, packageRegistry: null };\nstate.template.size = action.input.size ?? null;\nstate.template.baseDomain = action.input.baseDomain ?? null;\nstate.template.packageRegistry = action.input.packageRegistry ?? null;",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "op-add-template-service",
              name: "ADD_TEMPLATE_SERVICE",
              description: "Add a service to the environment template.",
              schema:
                "input AddTemplateServiceInput {\n  id: OID!\n  type: TemplateServiceType!\n  prefix: String\n  artifactName: String\n  artifactChannel: AutoUpdateChannel\n}",
              template: "",
              reducer:
                'state.template ??= { services: [], packages: [], size: null, baseDomain: null, packageRegistry: null };\nif (state.template.services.some((s) => s.id === action.input.id)) {\n  throw new DuplicateServiceError(`service ${action.input.id} already exists`);\n}\n// Only a FUSION service runs the app\'s own image. Carrying an artifact on any\n// other type would render a service the provisioner cannot build.\nif (action.input.artifactName && action.input.type !== "FUSION") {\n  throw new ArtifactOnNonFusionServiceError(\n    `only a FUSION service can reference an artifact, not ${action.input.type}`,\n  );\n}\nstate.template.services.push({\n  id: action.input.id,\n  type: action.input.type,\n  // The artifact names the image, so it is the obvious default prefix.\n  prefix: action.input.prefix ?? action.input.artifactName ?? null,\n  artifactName: action.input.artifactName ?? null,\n  // A referenced artifact always tracks a channel; LATEST is what a publisher means.\n  artifactChannel: action.input.artifactName\n    ? (action.input.artifactChannel ?? "LATEST")\n    : null,\n});',
              errors: [
                {
                  id: "err-duplicate-service",
                  name: "DuplicateServiceError",
                  code: "DUPLICATE_SERVICE",
                  description: "A template service with this id already exists",
                  template: "",
                },
                {
                  id: "err-artifact-on-non-fusion",
                  name: "ArtifactOnNonFusionServiceError",
                  code: "ARTIFACT_ON_NON_FUSION_SERVICE",
                  description:
                    "Only a FUSION service can reference an app artifact",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "op-add-template-package",
              name: "ADD_TEMPLATE_PACKAGE",
              description: "Add a package to the environment template.",
              schema:
                "input AddTemplatePackageInput {\n  id: OID!\n  packageName: String\n  version: String\n}",
              template: "",
              reducer:
                "state.template ??= { services: [], packages: [], size: null, baseDomain: null, packageRegistry: null };\nif (state.template.packages.some((p) => p.id === action.input.id)) {\n  throw new DuplicatePackageError(`package ${action.input.id} already exists`);\n}\nstate.template.packages.push({\n  id: action.input.id,\n  packageName: action.input.packageName ?? null,\n  version: action.input.version ?? null,\n});",
              errors: [
                {
                  id: "err-duplicate-package",
                  name: "DuplicatePackageError",
                  code: "DUPLICATE_PACKAGE",
                  description: "A template package with this id already exists",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "op-remove-template-service",
              name: "REMOVE_TEMPLATE_SERVICE",
              description: "Remove a service from the environment template.",
              schema: "input RemoveTemplateServiceInput {\n  id: OID!\n}",
              template: "",
              reducer:
                "const list = state.template?.services ?? [];\nconst at = list.findIndex((x) => x.id === action.input.id);\nif (at === -1) {\n  throw new UnknownServiceError(`service ${action.input.id} does not exist`);\n}\nlist.splice(at, 1);",
              errors: [
                {
                  id: "err-unknown-service",
                  name: "UnknownServiceError",
                  code: "UNKNOWN_SERVICE",
                  description: "No template service with this id",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "op-remove-template-package",
              name: "REMOVE_TEMPLATE_PACKAGE",
              description: "Remove a package from the environment template.",
              schema: "input RemoveTemplatePackageInput {\n  id: OID!\n}",
              template: "",
              reducer:
                "const list = state.template?.packages ?? [];\nconst at = list.findIndex((x) => x.id === action.input.id);\nif (at === -1) {\n  throw new UnknownPackageError(`package ${action.input.id} does not exist`);\n}\nlist.splice(at, 1);",
              errors: [
                {
                  id: "err-unknown-package",
                  name: "UnknownPackageError",
                  code: "UNKNOWN_PACKAGE",
                  description: "No template package with this id",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "op-publish-license-type",
              name: "PUBLISH_LICENSE_TYPE",
              description:
                "Move the license type from DRAFT to ACTIVE. Requires a kind and at least one service.",
              schema: "input PublishLicenseTypeInput {\n  _: Boolean\n}",
              template: "",
              reducer:
                'if (!state.kind || !state.template || state.template.services.length === 0) {\n  throw new IncompleteTemplateError(\n    "a license type needs at least one service before it can be published",\n  );\n}\nstate.status = "ACTIVE";',
              errors: [
                {
                  id: "err-incomplete-template",
                  name: "IncompleteTemplateError",
                  code: "INCOMPLETE_TEMPLATE",
                  description:
                    "The license type has no kind or no template service",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "op-retire-license-type",
              name: "RETIRE_LICENSE_TYPE",
              description: "Move the license type from ACTIVE to RETIRED.",
              schema: "input RetireLicenseTypeInput {\n  _: Boolean\n}",
              template: "",
              reducer:
                'if (state.status !== "ACTIVE") {\n  throw new NotPublishedError("only an ACTIVE license type can be retired");\n}\nstate.status = "RETIRED";',
              errors: [
                {
                  id: "err-not-published",
                  name: "NotPublishedError",
                  code: "NOT_PUBLISHED",
                  description: "Only an ACTIVE license type can be retired",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
          ],
        },
      ],
    },
  ],
};
