import type { DocumentModelGlobalState } from "document-model";

export const documentModel: DocumentModelGlobalState = {
  id: "powerhouse/vetra-app",
  name: "VetraApp",
  author: {
    name: "Powerhouse",
    website: "https://powerhouse.inc",
  },
  extension: "vapp",
  description:
    "A Vetra App: what a publisher owns, the repository it deploys from, and what it has published.",
  specifications: [
    {
      version: 1,
      changeLog: [],
      state: {
        global: {
          schema:
            "type VetraAppState {\n  name: String\n  slug: String\n  owner: EthereumAddress\n  status: VetraAppStatus!\n  repository: VetraAppRepository\n  identity: VetraAppIdentity\n  productionEnvironmentId: OID\n  previews: VetraAppPreviews\n  artifacts: [VetraAppArtifact!]!\n  templates: [VetraAppEnvironmentTemplate!]!\n  terms: [VetraAppLicenseTerm!]!\n}\n\nenum VetraAppStatus {\n  PENDING_IDENTITY\n  ACTIVE\n  DISCONNECTED\n  DELETED\n}\n\ntype VetraAppRepository {\n  repositoryId: String\n  fullName: String\n  productionBranch: String\n}\n\ntype VetraAppIdentity {\n  did: String\n  expiresAt: DateTime\n}\n\ntype VetraAppPreviews {\n  enabled: Boolean!\n  limit: Int!\n  ttlDays: Int!\n}\n\ntype VetraAppArtifact {\n  id: OID!\n  kind: VetraAppArtifactKind!\n  name: String!\n  versions: [VetraAppArtifactVersion!]!\n  channels: [VetraAppArtifactChannel!]!\n}\n\nenum VetraAppArtifactKind {\n  PACKAGE\n  FUSION_IMAGE\n}\n\ntype VetraAppArtifactVersion {\n  version: String!\n  reference: String!\n  commitSha: String\n  runId: String\n  publishedAt: DateTime!\n}\n\ntype VetraAppArtifactChannel {\n  channel: AutoUpdateChannel!\n  version: String!\n}\n\nenum AutoUpdateChannel {\n  DEV\n  STAGING\n  LATEST\n}\n\ntype VetraAppEnvironmentTemplate {\n  id: OID!\n  name: String\n  mode: TemplateInstanceMode!\n  sharedEnvironment: PHID\n  services: [TemplateService!]!\n  packages: [TemplatePackage!]!\n  size: String\n  baseDomain: String\n  packageRegistry: URL\n}\n\nenum TemplateInstanceMode {\n  SHARED\n  DEDICATED\n}\n\ntype TemplateService {\n  id: OID!\n  type: TemplateServiceType!\n  prefix: String\n  artifactName: String\n  artifactChannel: AutoUpdateChannel\n}\n\nenum TemplateServiceType {\n  CONNECT\n  SWITCHBOARD\n  FUSION\n  CLINT\n  DOCLING\n  PAPERLESS\n  SPECKLE\n}\n\ntype TemplatePackage {\n  id: OID!\n  packageName: String\n  version: String\n}\n\ntype VetraAppLicenseTerm {\n  id: OID!\n  kind: String!\n  label: String\n  templateId: OID\n  validityDays: Int\n  issuers: [LicenseIssuerKind!]!\n  status: LicenseTermStatus!\n}\n\nenum LicenseTermStatus {\n  DRAFT\n  ACTIVE\n  RETIRED\n}\n\nenum LicenseIssuerKind {\n  INVITE_CODE\n  PUBLISHER_GRANT\n  ACHRA_SUBSCRIPTION\n}",
          initialValue:
            '{\n  "name": null,\n  "slug": null,\n  "owner": null,\n  "status": "PENDING_IDENTITY",\n  "repository": null,\n  "identity": null,\n  "productionEnvironmentId": null,\n  "previews": null,\n  "artifacts": [],\n  "templates": [],\n  "terms": []\n}',
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
          id: "module-app",
          name: "app",
          description: "App facts and published artifacts.",
          operations: [
            {
              id: "op-set-app-details",
              name: "SET_APP_DETAILS",
              description: "Set the app's name, slug and owner.",
              schema:
                "input SetAppDetailsInput {\n  name: String\n  slug: String\n  owner: EthereumAddress\n}",
              template: "",
              reducer:
                "if (action.input.name) state.name = action.input.name;\nif (action.input.slug) state.slug = action.input.slug;\nif (action.input.owner) state.owner = action.input.owner;",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "op-connect-repository",
              name: "CONNECT_REPOSITORY",
              description:
                "Record the GitHub repository this app deploys from.",
              schema:
                "input ConnectRepositoryInput {\n  repositoryId: String\n  fullName: String\n  productionBranch: String\n}",
              template: "",
              reducer:
                "state.repository = {\n  repositoryId: action.input.repositoryId ?? null,\n  fullName: action.input.fullName ?? null,\n  productionBranch: action.input.productionBranch ?? null,\n};",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "op-set-identity",
              name: "SET_IDENTITY",
              description:
                "Record the app's Renown workload identity and its expiry.",
              schema:
                "input SetIdentityInput {\n  did: String\n  expiresAt: DateTime\n}",
              template: "",
              reducer:
                "state.identity = {\n  did: action.input.did ?? null,\n  expiresAt: action.input.expiresAt ?? null,\n};",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "op-set-status",
              name: "SET_STATUS",
              description:
                "Set the app's lifecycle status. DELETED is a soft delete and is kept forever.",
              schema: "input SetStatusInput {\n  status: VetraAppStatus!\n}",
              template: "",
              reducer: "state.status = action.input.status;",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "op-set-previews",
              name: "SET_PREVIEWS",
              description: "Set the preview environment policy.",
              schema:
                "input SetPreviewsInput {\n  enabled: Boolean!\n  limit: Int!\n  ttlDays: Int!\n}",
              template: "",
              reducer:
                "state.previews = {\n  enabled: action.input.enabled,\n  limit: action.input.limit,\n  ttlDays: action.input.ttlDays,\n};",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "op-set-production-environment",
              name: "SET_PRODUCTION_ENVIRONMENT",
              description:
                "Point the app at its production environment document.",
              schema:
                "input SetProductionEnvironmentInput {\n  environmentId: OID\n}",
              template: "",
              reducer:
                "state.productionEnvironmentId = action.input.environmentId ?? null;",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "op-record-artifact-version",
              name: "RECORD_ARTIFACT_VERSION",
              description:
                "Record a published version of one of this app's artifacts.",
              schema:
                "input RecordArtifactVersionInput {\n  kind: VetraAppArtifactKind!\n  name: String!\n  version: String!\n  reference: String!\n  commitSha: String\n  runId: String\n  publishedAt: DateTime!\n}",
              template: "",
              reducer:
                "const MAX_ARTIFACT_VERSIONS = 50;\n\nlet artifact = state.artifacts.find(\n  (a) => a.kind === action.input.kind && a.name === action.input.name,\n);\nif (!artifact) {\n  artifact = {\n    id: `${action.input.kind}:${action.input.name}`,\n    kind: action.input.kind,\n    name: action.input.name,\n    versions: [],\n    channels: [],\n  };\n  state.artifacts.push(artifact);\n}\n\nconst entry = {\n  version: action.input.version,\n  reference: action.input.reference,\n  commitSha: action.input.commitSha ?? null,\n  runId: action.input.runId ?? null,\n  publishedAt: action.input.publishedAt,\n};\nconst at = artifact.versions.findIndex((v) => v.version === action.input.version);\nif (at >= 0) {\n  artifact.versions[at] = entry;\n} else {\n  artifact.versions.push(entry);\n}\n\n// A document that grows without bound eventually fails to load, and a dropdown\n// never needs the whole history.\nif (artifact.versions.length > MAX_ARTIFACT_VERSIONS) {\n  artifact.versions = artifact.versions.slice(\n    artifact.versions.length - MAX_ARTIFACT_VERSIONS,\n  );\n}\n// A channel aimed at a version the cap dropped is worse than no channel.\nartifact.channels = artifact.channels.filter((c) =>\n  artifact.versions.some((v) => v.version === c.version),\n);",
              errors: [],
              examples: [],
              scope: "global",
            },
            {
              id: "op-set-artifact-channel",
              name: "SET_ARTIFACT_CHANNEL",
              description: "Point a channel at a published version.",
              schema:
                "input SetArtifactChannelInput {\n  kind: VetraAppArtifactKind!\n  name: String!\n  channel: AutoUpdateChannel!\n  version: String!\n}",
              template: "",
              reducer:
                "const artifact = state.artifacts.find(\n  (a) => a.kind === action.input.kind && a.name === action.input.name,\n);\nif (!artifact) {\n  throw new UnknownArtifactError(\n    `${action.input.kind} ${action.input.name} has published nothing`,\n  );\n}\nif (!artifact.versions.some((v) => v.version === action.input.version)) {\n  throw new UnknownArtifactVersionError(\n    `${action.input.name} has no published version ${action.input.version}`,\n  );\n}\nconst at = artifact.channels.findIndex((c) => c.channel === action.input.channel);\nconst entry = { channel: action.input.channel, version: action.input.version };\nif (at >= 0) {\n  artifact.channels[at] = entry;\n} else {\n  artifact.channels.push(entry);\n}",
              errors: [
                {
                  id: "err-unknown-artifact",
                  name: "UnknownArtifactError",
                  code: "UNKNOWN_ARTIFACT",
                  description: "No such artifact on this app.",
                  template: "",
                },
                {
                  id: "err-unknown-artifact-version",
                  name: "UnknownArtifactVersionError",
                  code: "UNKNOWN_ARTIFACT_VERSION",
                  description:
                    "A channel may only point at a published version.",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
          ],
        },
        {
          id: "module-licensing",
          name: "licensing",
          description:
            "Environment templates and the licence terms an app hands out.",
          operations: [
            {
              id: "op-add-template",
              name: "ADD_TEMPLATE",
              description: "Add an environment template.",
              schema:
                "input AddTemplateInput {\n  id: OID!\n  name: String\n  mode: TemplateInstanceMode!\n}",
              template: "",
              reducer:
                "const { templates } = licensingLists(state);\nif (templates.some((t) => t.id === action.input.id)) {\n  throw new DuplicateTemplateError(\n    `template ${action.input.id} already exists`,\n  );\n}\ntemplates.push({\n  id: action.input.id,\n  name: action.input.name ?? null,\n  mode: action.input.mode,\n  sharedEnvironment: null,\n  services: [],\n  packages: [],\n  size: null,\n  baseDomain: null,\n  packageRegistry: null,\n});",
              errors: [
                {
                  id: "err-duplicate-template",
                  name: "DuplicateTemplateError",
                  code: "DUPLICATE_TEMPLATE",
                  description: "A template with this id exists.",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "op-set-template-details",
              name: "SET_TEMPLATE_DETAILS",
              description: "Update a template; absent fields are unchanged.",
              schema:
                "input SetTemplateDetailsInput {\n  id: OID!\n  name: String\n  mode: TemplateInstanceMode\n  sharedEnvironment: PHID\n  size: String\n  baseDomain: String\n  packageRegistry: URL\n}",
              template: "",
              reducer:
                'const t = findTemplate(state, action.input.id);\nconst mode = action.input.mode ?? t.mode;\nif (mode === "SHARED" && (t.services.length > 0 || t.packages.length > 0)) {\n  throw new SharedTemplateServicesError(\n    "a SHARED template provisions nothing; remove its services and packages first",\n  );\n}\nt.mode = mode;\n// undefined = unchanged, explicit null = clear.\nif (action.input.name !== undefined) t.name = action.input.name ?? null;\nif (action.input.sharedEnvironment !== undefined)\n  t.sharedEnvironment = action.input.sharedEnvironment ?? null;\nif (action.input.size !== undefined) t.size = action.input.size ?? null;\nif (action.input.baseDomain !== undefined)\n  t.baseDomain = action.input.baseDomain ?? null;\nif (action.input.packageRegistry !== undefined)\n  t.packageRegistry = action.input.packageRegistry ?? null;',
              errors: [
                {
                  id: "err-template-not-found-details",
                  name: "TemplateNotFoundError",
                  code: "TEMPLATE_NOT_FOUND",
                  description: "No such template.",
                  template: "",
                },
                {
                  id: "err-shared-services-details",
                  name: "SharedTemplateServicesError",
                  code: "SHARED_TEMPLATE_SERVICES",
                  description:
                    "A SHARED template carries no services or packages.",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "op-add-template-service",
              name: "ADD_TEMPLATE_SERVICE",
              description: "Add a service to a DEDICATED template.",
              schema:
                "input AddTemplateServiceInput {\n  templateId: OID!\n  id: OID!\n  type: TemplateServiceType!\n  prefix: String\n  artifactName: String\n  artifactChannel: AutoUpdateChannel\n}",
              template: "",
              reducer:
                'const t = findTemplate(state, action.input.templateId);\nif (t.mode === "SHARED") {\n  throw new SharedTemplateServicesError(\n    "a SHARED template carries no services",\n  );\n}\nif (t.services.some((s) => s.id === action.input.id)) {\n  throw new DuplicateServiceError(\n    `service ${action.input.id} already exists`,\n  );\n}\nif (action.input.artifactName && action.input.type !== "FUSION") {\n  throw new ArtifactOnNonFusionServiceError(\n    `only a FUSION service can reference an artifact, not ${action.input.type}`,\n  );\n}\nt.services.push({\n  id: action.input.id,\n  type: action.input.type,\n  prefix: action.input.prefix ?? action.input.artifactName ?? null,\n  artifactName: action.input.artifactName ?? null,\n  artifactChannel: action.input.artifactName\n    ? (action.input.artifactChannel ?? "LATEST")\n    : null,\n});',
              errors: [
                {
                  id: "err-template-not-found-add-service",
                  name: "TemplateNotFoundError",
                  code: "TEMPLATE_NOT_FOUND",
                  description: "No such template.",
                  template: "",
                },
                {
                  id: "err-shared-services-add-service",
                  name: "SharedTemplateServicesError",
                  code: "SHARED_TEMPLATE_SERVICES",
                  description:
                    "A SHARED template carries no services or packages.",
                  template: "",
                },
                {
                  id: "err-duplicate-service",
                  name: "DuplicateServiceError",
                  code: "DUPLICATE_SERVICE",
                  description: "A service with this id exists on the template.",
                  template: "",
                },
                {
                  id: "err-artifact-on-non-fusion",
                  name: "ArtifactOnNonFusionServiceError",
                  code: "ARTIFACT_ON_NON_FUSION_SERVICE",
                  description:
                    "Only a FUSION service can reference an artifact.",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "op-remove-template-service",
              name: "REMOVE_TEMPLATE_SERVICE",
              description: "Remove a service from a template.",
              schema:
                "input RemoveTemplateServiceInput {\n  templateId: OID!\n  id: OID!\n}",
              template: "",
              reducer:
                "const t = findTemplate(state, action.input.templateId);\nconst at = t.services.findIndex((s) => s.id === action.input.id);\nif (at === -1) {\n  throw new UnknownServiceError(\n    `service ${action.input.id} does not exist`,\n  );\n}\nt.services.splice(at, 1);",
              errors: [
                {
                  id: "err-template-not-found-remove-service",
                  name: "TemplateNotFoundError",
                  code: "TEMPLATE_NOT_FOUND",
                  description: "No such template.",
                  template: "",
                },
                {
                  id: "err-unknown-service",
                  name: "UnknownServiceError",
                  code: "UNKNOWN_SERVICE",
                  description: "No such service on the template.",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "op-add-template-package",
              name: "ADD_TEMPLATE_PACKAGE",
              description: "Add a package to a DEDICATED template.",
              schema:
                "input AddTemplatePackageInput {\n  templateId: OID!\n  id: OID!\n  packageName: String!\n  version: String\n}",
              template: "",
              reducer:
                'const t = findTemplate(state, action.input.templateId);\nif (t.mode === "SHARED") {\n  throw new SharedTemplateServicesError(\n    "a SHARED template carries no packages",\n  );\n}\nif (t.packages.some((p) => p.id === action.input.id)) {\n  throw new DuplicatePackageError(\n    `package ${action.input.id} already exists`,\n  );\n}\nt.packages.push({\n  id: action.input.id,\n  packageName: action.input.packageName,\n  version: action.input.version ?? null,\n});',
              errors: [
                {
                  id: "err-template-not-found-add-package",
                  name: "TemplateNotFoundError",
                  code: "TEMPLATE_NOT_FOUND",
                  description: "No such template.",
                  template: "",
                },
                {
                  id: "err-shared-services-add-package",
                  name: "SharedTemplateServicesError",
                  code: "SHARED_TEMPLATE_SERVICES",
                  description:
                    "A SHARED template carries no services or packages.",
                  template: "",
                },
                {
                  id: "err-duplicate-package",
                  name: "DuplicatePackageError",
                  code: "DUPLICATE_PACKAGE",
                  description: "A package with this id exists on the template.",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "op-remove-template-package",
              name: "REMOVE_TEMPLATE_PACKAGE",
              description: "Remove a package from a template.",
              schema:
                "input RemoveTemplatePackageInput {\n  templateId: OID!\n  id: OID!\n}",
              template: "",
              reducer:
                "const t = findTemplate(state, action.input.templateId);\nconst at = t.packages.findIndex((p) => p.id === action.input.id);\nif (at === -1) {\n  throw new UnknownPackageError(\n    `package ${action.input.id} does not exist`,\n  );\n}\nt.packages.splice(at, 1);",
              errors: [
                {
                  id: "err-template-not-found-remove-package",
                  name: "TemplateNotFoundError",
                  code: "TEMPLATE_NOT_FOUND",
                  description: "No such template.",
                  template: "",
                },
                {
                  id: "err-unknown-package",
                  name: "UnknownPackageError",
                  code: "UNKNOWN_PACKAGE",
                  description: "No such package on the template.",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "op-delete-template",
              name: "DELETE_TEMPLATE",
              description: "Delete an unused template.",
              schema: "input DeleteTemplateInput {\n  id: OID!\n}",
              template: "",
              reducer:
                "const { templates, terms } = licensingLists(state);\nconst at = templates.findIndex((t) => t.id === action.input.id);\nif (at === -1) {\n  throw new TemplateNotFoundError(\n    `template ${action.input.id} does not exist`,\n  );\n}\nif (terms.some((t) => t.templateId === action.input.id)) {\n  throw new TemplateInUseError(\n    `template ${action.input.id} is used by a term`,\n  );\n}\ntemplates.splice(at, 1);",
              errors: [
                {
                  id: "err-template-not-found-delete",
                  name: "TemplateNotFoundError",
                  code: "TEMPLATE_NOT_FOUND",
                  description: "No such template.",
                  template: "",
                },
                {
                  id: "err-template-in-use",
                  name: "TemplateInUseError",
                  code: "TEMPLATE_IN_USE",
                  description: "A term still references this template.",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "op-add-term",
              name: "ADD_TERM",
              description: "Add a licence term in DRAFT.",
              schema:
                "input AddTermInput {\n  id: OID!\n  kind: String!\n  label: String\n  templateId: OID\n  validityDays: Int\n  issuers: [LicenseIssuerKind!]\n}",
              template: "",
              reducer:
                'const { templates, terms } = licensingLists(state);\nif (terms.some((t) => t.id === action.input.id)) {\n  throw new DuplicateTermError(`term ${action.input.id} already exists`);\n}\nif (!isValidKind(action.input.kind)) {\n  throw new InvalidKindError(\n    "a kind must be non-blank without surrounding spaces",\n  );\n}\nif (terms.some((t) => t.kind === action.input.kind)) {\n  throw new DuplicateKindError(\n    `kind ${action.input.kind} is already used by this app`,\n  );\n}\nif (\n  action.input.templateId &&\n  !templates.some((t) => t.id === action.input.templateId)\n) {\n  throw new TemplateNotFoundError(\n    `template ${action.input.templateId} does not exist`,\n  );\n}\nif (action.input.validityDays != null && action.input.validityDays <= 0) {\n  throw new NegativeValidityError("validityDays must be positive");\n}\nterms.push({\n  id: action.input.id,\n  kind: action.input.kind,\n  label: action.input.label ?? null,\n  templateId: action.input.templateId ?? null,\n  validityDays: action.input.validityDays ?? null,\n  issuers: [...new Set(action.input.issuers ?? [])],\n  status: "DRAFT",\n});',
              errors: [
                {
                  id: "err-duplicate-term",
                  name: "DuplicateTermError",
                  code: "DUPLICATE_TERM",
                  description: "A term with this id exists.",
                  template: "",
                },
                {
                  id: "err-invalid-kind-add",
                  name: "InvalidKindError",
                  code: "INVALID_KIND",
                  description:
                    "A kind must be non-blank without surrounding spaces.",
                  template: "",
                },
                {
                  id: "err-duplicate-kind-add",
                  name: "DuplicateKindError",
                  code: "DUPLICATE_KIND",
                  description:
                    "Another term of this app already uses this kind.",
                  template: "",
                },
                {
                  id: "err-template-not-found-add-term",
                  name: "TemplateNotFoundError",
                  code: "TEMPLATE_NOT_FOUND",
                  description: "No such template.",
                  template: "",
                },
                {
                  id: "err-negative-validity-add",
                  name: "NegativeValidityError",
                  code: "NEGATIVE_VALIDITY",
                  description: "validityDays must be positive.",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "op-set-term-details",
              name: "SET_TERM_DETAILS",
              description: "Update a term; absent fields are unchanged.",
              schema:
                "input SetTermDetailsInput {\n  id: OID!\n  kind: String\n  label: String\n  templateId: OID\n  validityDays: Int\n  issuers: [LicenseIssuerKind!]\n}",
              template: "",
              reducer:
                'const { templates, terms } = licensingLists(state);\nconst term = findTerm(state, action.input.id);\nconst kind = action.input.kind;\nif (kind != null && kind !== term.kind) {\n  if (!isValidKind(kind)) {\n    throw new InvalidKindError(\n      "a kind must be non-blank without surrounding spaces",\n    );\n  }\n  // Licences carry the kind; once one could exist, renaming orphans it.\n  if (term.status !== "DRAFT") {\n    throw new KindImmutableError(\n      `term ${term.id} is ${term.status}; its kind is fixed`,\n    );\n  }\n  if (terms.some((t) => t.id !== term.id && t.kind === kind)) {\n    throw new DuplicateKindError(\n      `kind ${kind} is already used by this app`,\n    );\n  }\n}\nconst templateId =\n  action.input.templateId !== undefined\n    ? (action.input.templateId ?? null)\n    : term.templateId;\nif (templateId && !templates.some((t) => t.id === templateId)) {\n  throw new TemplateNotFoundError(`template ${templateId} does not exist`);\n}\nif (action.input.validityDays != null && action.input.validityDays <= 0) {\n  throw new NegativeValidityError("validityDays must be positive");\n}\nconst issuers =\n  action.input.issuers != null\n    ? [...new Set(action.input.issuers)]\n    : term.issuers;\nif (term.status === "ACTIVE" && (!templateId || issuers.length === 0)) {\n  throw new TermIncompleteError(\n    "an ACTIVE term needs a template and at least one issuer",\n  );\n}\nif (kind != null) term.kind = kind;\nif (action.input.label !== undefined)\n  term.label = action.input.label ?? null;\nterm.templateId = templateId;\nif (action.input.validityDays !== undefined)\n  term.validityDays = action.input.validityDays ?? null;\nterm.issuers = issuers;',
              errors: [
                {
                  id: "err-term-not-found-details",
                  name: "TermNotFoundError",
                  code: "TERM_NOT_FOUND",
                  description: "No such term.",
                  template: "",
                },
                {
                  id: "err-invalid-kind-set",
                  name: "InvalidKindError",
                  code: "INVALID_KIND",
                  description:
                    "A kind must be non-blank without surrounding spaces.",
                  template: "",
                },
                {
                  id: "err-kind-immutable",
                  name: "KindImmutableError",
                  code: "KIND_IMMUTABLE",
                  description: "The kind of a published term is fixed.",
                  template: "",
                },
                {
                  id: "err-duplicate-kind-set",
                  name: "DuplicateKindError",
                  code: "DUPLICATE_KIND",
                  description:
                    "Another term of this app already uses this kind.",
                  template: "",
                },
                {
                  id: "err-template-not-found-set-term",
                  name: "TemplateNotFoundError",
                  code: "TEMPLATE_NOT_FOUND",
                  description: "No such template.",
                  template: "",
                },
                {
                  id: "err-negative-validity-set",
                  name: "NegativeValidityError",
                  code: "NEGATIVE_VALIDITY",
                  description: "validityDays must be positive.",
                  template: "",
                },
                {
                  id: "err-term-incomplete-set",
                  name: "TermIncompleteError",
                  code: "TERM_INCOMPLETE",
                  description:
                    "An ACTIVE term needs a template and at least one issuer.",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "op-publish-term",
              name: "PUBLISH_TERM",
              description: "Make a term ACTIVE.",
              schema: "input PublishTermInput {\n  id: OID!\n}",
              template: "",
              reducer:
                'const term = findTerm(state, action.input.id);\nif (!term.templateId || term.issuers.length === 0) {\n  throw new TermIncompleteError(\n    "a term needs a template and at least one issuer to be published",\n  );\n}\nterm.status = "ACTIVE";',
              errors: [
                {
                  id: "err-term-not-found-publish",
                  name: "TermNotFoundError",
                  code: "TERM_NOT_FOUND",
                  description: "No such term.",
                  template: "",
                },
                {
                  id: "err-term-incomplete-publish",
                  name: "TermIncompleteError",
                  code: "TERM_INCOMPLETE",
                  description:
                    "A term needs a template and at least one issuer to be published.",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "op-retire-term",
              name: "RETIRE_TERM",
              description: "Retire an ACTIVE term.",
              schema: "input RetireTermInput {\n  id: OID!\n}",
              template: "",
              reducer:
                'const term = findTerm(state, action.input.id);\nif (term.status !== "ACTIVE") {\n  throw new TermNotPublishedError("only an ACTIVE term can be retired");\n}\nterm.status = "RETIRED";',
              errors: [
                {
                  id: "err-term-not-found-retire",
                  name: "TermNotFoundError",
                  code: "TERM_NOT_FOUND",
                  description: "No such term.",
                  template: "",
                },
                {
                  id: "err-term-not-published",
                  name: "TermNotPublishedError",
                  code: "TERM_NOT_PUBLISHED",
                  description: "Only an ACTIVE term can be retired.",
                  template: "",
                },
              ],
              examples: [],
              scope: "global",
            },
            {
              id: "op-delete-term",
              name: "DELETE_TERM",
              description:
                "Delete a term, whatever its status. System-only: the licensing migration uses it to strip foreign terms from a squatted studio document. A licence still carrying the kind no longer resolves and is held.",
              schema: "input DeleteTermInput {\n  id: OID!\n}",
              template: "",
              reducer:
                "const { terms } = licensingLists(state);\nconst at = terms.findIndex((t) => t.id === action.input.id);\nif (at === -1) {\n  throw new TermNotFoundError(`term ${action.input.id} does not exist`);\n}\nterms.splice(at, 1);",
              errors: [
                {
                  id: "err-term-not-found-delete",
                  name: "TermNotFoundError",
                  code: "TERM_NOT_FOUND",
                  description: "No such term.",
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
