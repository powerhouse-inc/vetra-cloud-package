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
            "type AppLicenseTypeState {\n  app: PHID\n  kind: String\n  label: String\n  validityDays: Int\n  template: EnvironmentTemplate\n  status: LicenseTypeStatus!\n}\n\nenum LicenseTypeStatus {\n  DRAFT\n  ACTIVE\n  RETIRED\n}\n\nenum TemplateServiceType {\n  CONNECT\n  SWITCHBOARD\n  FUSION\n  CLINT\n  DOCLING\n  PAPERLESS\n  SPECKLE\n}\n\ntype EnvironmentTemplate {\n  services: [TemplateService!]!\n  packages: [TemplatePackage!]!\n  size: String\n  baseDomain: String\n  packageRegistry: URL\n}\n\ntype TemplateService {\n  id: OID!\n  type: TemplateServiceType!\n  prefix: String\n}\n\ntype TemplatePackage {\n  id: OID!\n  packageName: String\n  version: String\n}",
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
                "input AddTemplateServiceInput {\n  id: OID!\n  type: TemplateServiceType!\n  prefix: String\n}",
              template: "",
              reducer:
                "state.template ??= { services: [], packages: [], size: null, baseDomain: null, packageRegistry: null };\nif (state.template.services.some((s) => s.id === action.input.id)) {\n  throw new DuplicateServiceError(`service ${action.input.id} already exists`);\n}\nstate.template.services.push({\n  id: action.input.id,\n  type: action.input.type,\n  prefix: action.input.prefix ?? null,\n});",
              errors: [
                {
                  id: "err-duplicate-service",
                  name: "DuplicateServiceError",
                  code: "DUPLICATE_SERVICE",
                  description: "A template service with this id already exists",
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
