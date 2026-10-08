import {
  TemplateNotFoundError,
  TermNotFoundError,
} from "../gen/licensing/error.js";
import type {
  VetraAppEnvironmentTemplate,
  VetraAppLicenseTerm,
  VetraAppState,
} from "../gen/schema/types.js";

/**
 * App documents created before the licensing module existed carry neither
 * list — their stored state predates the initial value that adds them. Every
 * licensing reducer goes through this, so an old document gains both lists on
 * its first licensing operation instead of crashing on `undefined.push`.
 */
export function licensingLists(state: VetraAppState): {
  templates: VetraAppEnvironmentTemplate[];
  terms: VetraAppLicenseTerm[];
} {
  const s = state as Partial<Pick<VetraAppState, "templates" | "terms">>;
  s.templates ??= [];
  s.terms ??= [];
  return { templates: s.templates, terms: s.terms };
}

export function findTemplate(
  state: VetraAppState,
  id: string,
): VetraAppEnvironmentTemplate {
  const t = licensingLists(state).templates.find((x) => x.id === id);
  if (!t) throw new TemplateNotFoundError(`template ${id} does not exist`);
  return t;
}

export function findTerm(
  state: VetraAppState,
  id: string,
): VetraAppLicenseTerm {
  const t = licensingLists(state).terms.find((x) => x.id === id);
  if (!t) throw new TermNotFoundError(`term ${id} does not exist`);
  return t;
}

/** A kind is what a licence carries forever: it must be non-blank. */
export function isValidKind(kind: string): boolean {
  return kind.trim().length > 0 && kind.trim() === kind;
}
