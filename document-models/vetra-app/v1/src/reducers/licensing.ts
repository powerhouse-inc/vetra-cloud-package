import type { VetraAppLicensingOperations } from "document-models/vetra-app/v1";
import {
  ArtifactOnNonFusionServiceError,
  DuplicateKindError,
  DuplicatePackageError,
  DuplicateServiceError,
  DuplicateTemplateError,
  DuplicateTermError,
  InvalidKindError,
  KindImmutableError,
  NegativeValidityError,
  SharedTemplateServicesError,
  TemplateInUseError,
  TemplateNotFoundError,
  TermIncompleteError,
  TermNotPublishedError,
  UnknownPackageError,
  UnknownServiceError,
} from "../../gen/licensing/error.js";
import {
  findTemplate,
  findTerm,
  isValidKind,
  licensingLists,
} from "../utils.js";

export const vetraAppLicensingOperations: VetraAppLicensingOperations = {
  addTemplateOperation(state, action) {
    const { templates } = licensingLists(state);
    if (templates.some((t) => t.id === action.input.id)) {
      throw new DuplicateTemplateError(
        `template ${action.input.id} already exists`,
      );
    }
    templates.push({
      id: action.input.id,
      name: action.input.name ?? null,
      mode: action.input.mode,
      sharedEnvironment: null,
      services: [],
      packages: [],
      size: null,
      baseDomain: null,
      packageRegistry: null,
    });
  },
  setTemplateDetailsOperation(state, action) {
    const t = findTemplate(state, action.input.id);
    const mode = action.input.mode ?? t.mode;
    if (mode === "SHARED" && (t.services.length > 0 || t.packages.length > 0)) {
      throw new SharedTemplateServicesError(
        "a SHARED template provisions nothing; remove its services and packages first",
      );
    }
    t.mode = mode;
    // undefined = unchanged, explicit null = clear.
    if (action.input.name !== undefined) t.name = action.input.name ?? null;
    if (action.input.sharedEnvironment !== undefined)
      t.sharedEnvironment = action.input.sharedEnvironment ?? null;
    if (action.input.size !== undefined) t.size = action.input.size ?? null;
    if (action.input.baseDomain !== undefined)
      t.baseDomain = action.input.baseDomain ?? null;
    if (action.input.packageRegistry !== undefined)
      t.packageRegistry = action.input.packageRegistry ?? null;
  },
  addTemplateServiceOperation(state, action) {
    const t = findTemplate(state, action.input.templateId);
    if (t.mode === "SHARED") {
      throw new SharedTemplateServicesError(
        "a SHARED template carries no services",
      );
    }
    if (t.services.some((s) => s.id === action.input.id)) {
      throw new DuplicateServiceError(
        `service ${action.input.id} already exists`,
      );
    }
    if (action.input.artifactName && action.input.type !== "FUSION") {
      throw new ArtifactOnNonFusionServiceError(
        `only a FUSION service can reference an artifact, not ${action.input.type}`,
      );
    }
    t.services.push({
      id: action.input.id,
      type: action.input.type,
      prefix: action.input.prefix ?? action.input.artifactName ?? null,
      artifactName: action.input.artifactName ?? null,
      artifactChannel: action.input.artifactName
        ? (action.input.artifactChannel ?? "LATEST")
        : null,
    });
  },
  removeTemplateServiceOperation(state, action) {
    const t = findTemplate(state, action.input.templateId);
    const at = t.services.findIndex((s) => s.id === action.input.id);
    if (at === -1) {
      throw new UnknownServiceError(
        `service ${action.input.id} does not exist`,
      );
    }
    t.services.splice(at, 1);
  },
  addTemplatePackageOperation(state, action) {
    const t = findTemplate(state, action.input.templateId);
    if (t.mode === "SHARED") {
      throw new SharedTemplateServicesError(
        "a SHARED template carries no packages",
      );
    }
    if (t.packages.some((p) => p.id === action.input.id)) {
      throw new DuplicatePackageError(
        `package ${action.input.id} already exists`,
      );
    }
    t.packages.push({
      id: action.input.id,
      packageName: action.input.packageName,
      version: action.input.version ?? null,
    });
  },
  removeTemplatePackageOperation(state, action) {
    const t = findTemplate(state, action.input.templateId);
    const at = t.packages.findIndex((p) => p.id === action.input.id);
    if (at === -1) {
      throw new UnknownPackageError(
        `package ${action.input.id} does not exist`,
      );
    }
    t.packages.splice(at, 1);
  },
  deleteTemplateOperation(state, action) {
    const { templates, terms } = licensingLists(state);
    const at = templates.findIndex((t) => t.id === action.input.id);
    if (at === -1) {
      throw new TemplateNotFoundError(
        `template ${action.input.id} does not exist`,
      );
    }
    if (terms.some((t) => t.templateId === action.input.id)) {
      throw new TemplateInUseError(
        `template ${action.input.id} is used by a term`,
      );
    }
    templates.splice(at, 1);
  },
  addTermOperation(state, action) {
    const { templates, terms } = licensingLists(state);
    if (terms.some((t) => t.id === action.input.id)) {
      throw new DuplicateTermError(`term ${action.input.id} already exists`);
    }
    if (!isValidKind(action.input.kind)) {
      throw new InvalidKindError(
        "a kind must be non-blank without surrounding spaces",
      );
    }
    if (terms.some((t) => t.kind === action.input.kind)) {
      throw new DuplicateKindError(
        `kind ${action.input.kind} is already used by this app`,
      );
    }
    if (
      action.input.templateId &&
      !templates.some((t) => t.id === action.input.templateId)
    ) {
      throw new TemplateNotFoundError(
        `template ${action.input.templateId} does not exist`,
      );
    }
    if (action.input.validityDays != null && action.input.validityDays <= 0) {
      throw new NegativeValidityError("validityDays must be positive");
    }
    terms.push({
      id: action.input.id,
      kind: action.input.kind,
      label: action.input.label ?? null,
      templateId: action.input.templateId ?? null,
      validityDays: action.input.validityDays ?? null,
      issuers: [...new Set(action.input.issuers ?? [])],
      status: "DRAFT",
    });
  },
  setTermDetailsOperation(state, action) {
    const { templates, terms } = licensingLists(state);
    const term = findTerm(state, action.input.id);
    const kind = action.input.kind;
    if (kind != null && kind !== term.kind) {
      if (!isValidKind(kind)) {
        throw new InvalidKindError(
          "a kind must be non-blank without surrounding spaces",
        );
      }
      // Licences carry the kind; once one could exist, renaming orphans it.
      if (term.status !== "DRAFT") {
        throw new KindImmutableError(
          `term ${term.id} is ${term.status}; its kind is fixed`,
        );
      }
      if (terms.some((t) => t.id !== term.id && t.kind === kind)) {
        throw new DuplicateKindError(
          `kind ${kind} is already used by this app`,
        );
      }
    }
    const templateId =
      action.input.templateId !== undefined
        ? (action.input.templateId ?? null)
        : term.templateId;
    if (templateId && !templates.some((t) => t.id === templateId)) {
      throw new TemplateNotFoundError(`template ${templateId} does not exist`);
    }
    if (action.input.validityDays != null && action.input.validityDays <= 0) {
      throw new NegativeValidityError("validityDays must be positive");
    }
    const issuers =
      action.input.issuers != null
        ? [...new Set(action.input.issuers)]
        : term.issuers;
    if (term.status === "ACTIVE" && (!templateId || issuers.length === 0)) {
      throw new TermIncompleteError(
        "an ACTIVE term needs a template and at least one issuer",
      );
    }
    if (kind != null) term.kind = kind;
    if (action.input.label !== undefined)
      term.label = action.input.label ?? null;
    term.templateId = templateId;
    if (action.input.validityDays !== undefined)
      term.validityDays = action.input.validityDays ?? null;
    term.issuers = issuers;
  },
  publishTermOperation(state, action) {
    const term = findTerm(state, action.input.id);
    if (!term.templateId || term.issuers.length === 0) {
      throw new TermIncompleteError(
        "a term needs a template and at least one issuer to be published",
      );
    }
    term.status = "ACTIVE";
  },
  retireTermOperation(state, action) {
    const term = findTerm(state, action.input.id);
    if (term.status !== "ACTIVE") {
      throw new TermNotPublishedError("only an ACTIVE term can be retired");
    }
    term.status = "RETIRED";
  },
};
