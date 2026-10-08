import { describe, expect, it } from "vitest";
import {
  addTemplate,
  addTemplatePackage,
  addTemplateService,
  addTerm,
  deleteTemplate,
  publishTerm,
  reducer,
  removeTemplatePackage,
  removeTemplateService,
  retireTerm,
  setTemplateDetails,
  setTermDetails,
  utils,
  type VetraAppDocument,
  type VetraAppState,
} from "document-models/vetra-app/v1";

type Act = Parameters<typeof reducer>[1];
const run = (doc: VetraAppDocument, ...acts: Act[]) =>
  acts.reduce((d, a) => reducer(d, a), doc);
const lastError = (doc: VetraAppDocument) => doc.operations.global.at(-1)?.error;

const base = () =>
  run(
    utils.createDocument(),
    addTemplate({ id: "t1", name: "Pro", mode: "DEDICATED" }),
    addTerm({
      id: "k1",
      kind: "2026-pro",
      label: "Pro",
      templateId: "t1",
      validityDays: 30,
      issuers: ["PUBLISHER_GRANT", "PUBLISHER_GRANT"],
    }),
  );

describe("licensing: scenario", () => {
  it("builds a template and a term end to end", () => {
    const doc = run(
      base(),
      addTemplateService({
        templateId: "t1",
        id: "s1",
        type: "FUSION",
        prefix: null,
        artifactName: "kv-app",
        artifactChannel: null,
      }),
      addTemplateService({ templateId: "t1", id: "s2", type: "SWITCHBOARD", prefix: "sb", artifactName: null, artifactChannel: null }),
      addTemplatePackage({ templateId: "t1", id: "p1", packageName: "@kv/pkg", version: null }),
      setTemplateDetails({ id: "t1", size: "VETRA_AGENT_S", baseDomain: "vetra.io", packageRegistry: "https://registry.vetra.io" }),
      setTermDetails({ id: "k1", label: "Pro tier", validityDays: 90, issuers: ["INVITE_CODE"] }),
      publishTerm({ id: "k1" }),
      removeTemplatePackage({ templateId: "t1", id: "p1" }),
      removeTemplateService({ templateId: "t1", id: "s2" }),
      retireTerm({ id: "k1" }),
      publishTerm({ id: "k1" }),
    );
    expect(doc.operations.global.filter((o) => o.error)).toStrictEqual([]);
    const t = doc.state.global.templates[0]!;
    expect(t.services).toStrictEqual([
      { id: "s1", type: "FUSION", prefix: "kv-app", artifactName: "kv-app", artifactChannel: "LATEST" },
    ]);
    expect(t.packages).toStrictEqual([]);
    expect(t.size).toBe("VETRA_AGENT_S");
    expect(t.name).toBe("Pro"); // untouched: name key absent
    const term = doc.state.global.terms[0]!;
    expect(term).toMatchObject({ label: "Pro tier", validityDays: 90, issuers: ["INVITE_CODE"], status: "ACTIVE" });
  });

  it("dedupes issuers on add", () => {
    expect(base().state.global.terms[0]!.issuers).toStrictEqual(["PUBLISHER_GRANT"]);
  });

  it("gives a document that predates the module both lists on first use", () => {
    const old = utils.createDocument();
    const g = old.state.global as Partial<VetraAppState>;
    delete g.templates;
    delete g.terms;
    const doc = reducer(old, addTerm({ id: "k", kind: "free", label: null, templateId: null, validityDays: null, issuers: null }));
    expect(lastError(doc)).toBeUndefined();
    expect(doc.state.global.templates).toStrictEqual([]);
    expect(doc.state.global.terms).toHaveLength(1);
  });

  it("leaves fields that are absent or null unchanged", () => {
    const doc = run(
      base(),
      setTemplateDetails({ id: "t1", sharedEnvironment: "env-x", size: "S" }),
      setTemplateDetails({ id: "t1", name: null, mode: null, sharedEnvironment: null, size: null, baseDomain: null, packageRegistry: null }),
      setTermDetails({ id: "k1", kind: null, label: null, templateId: null, validityDays: null, issuers: null }),
    );
    expect(doc.operations.global.filter((o) => o.error)).toStrictEqual([]);
    expect(doc.state.global.templates[0]).toMatchObject({ name: "Pro", mode: "DEDICATED", sharedEnvironment: "env-x", size: "S" });
    expect(doc.state.global.terms[0]).toMatchObject({ kind: "2026-pro", label: "Pro", templateId: "t1", validityDays: 30, issuers: ["PUBLISHER_GRANT"] });
  });

  it("changes a term's template and updates every field in one go", () => {
    const doc = run(
      base(),
      addTemplate({ id: "t2", name: "Team", mode: "SHARED" }),
      setTemplateDetails({ id: "t1", name: "Pro+", mode: "SHARED" }),
      setTermDetails({ id: "k1", templateId: "t2" }),
    );
    expect(doc.operations.global.filter((o) => o.error)).toStrictEqual([]);
    expect(doc.state.global.templates[0]).toMatchObject({ name: "Pro+", mode: "SHARED" });
    expect(doc.state.global.terms[0]!.templateId).toBe("t2");
  });
});

describe("licensing: errors", () => {
  const cases: [string, () => VetraAppDocument, string][] = [
    ["duplicate template", () => run(base(), addTemplate({ id: "t1", name: null, mode: "SHARED" })), "template t1 already exists"],
    ["details on unknown template", () => run(base(), setTemplateDetails({ id: "nope" })), "template nope does not exist"],
    ["switch to SHARED with services", () => run(base(), addTemplateService({ templateId: "t1", id: "s", type: "CONNECT", prefix: null, artifactName: null, artifactChannel: null }), setTemplateDetails({ id: "t1", mode: "SHARED" })), "a SHARED template provisions nothing; remove its services and packages first"],
    ["switch to SHARED with packages", () => run(base(), addTemplatePackage({ templateId: "t1", id: "p", packageName: "x", version: null }), setTemplateDetails({ id: "t1", mode: "SHARED" })), "a SHARED template provisions nothing; remove its services and packages first"],
    ["service on SHARED", () => run(base(), addTemplate({ id: "t2", name: null, mode: "SHARED" }), addTemplateService({ templateId: "t2", id: "s", type: "CONNECT", prefix: null, artifactName: null, artifactChannel: null })), "a SHARED template carries no services"],
    ["service on unknown template", () => run(base(), addTemplateService({ templateId: "x", id: "s", type: "CONNECT", prefix: null, artifactName: null, artifactChannel: null })), "template x does not exist"],
    ["duplicate service", () => run(base(), addTemplateService({ templateId: "t1", id: "s", type: "CONNECT", prefix: null, artifactName: null, artifactChannel: null }), addTemplateService({ templateId: "t1", id: "s", type: "SWITCHBOARD", prefix: null, artifactName: null, artifactChannel: null })), "service s already exists"],
    ["artifact on non-FUSION", () => run(base(), addTemplateService({ templateId: "t1", id: "s", type: "CONNECT", prefix: null, artifactName: "img", artifactChannel: "DEV" })), "only a FUSION service can reference an artifact, not CONNECT"],
    ["remove unknown service", () => run(base(), removeTemplateService({ templateId: "t1", id: "zz" })), "service zz does not exist"],
    ["package on SHARED", () => run(base(), addTemplate({ id: "t2", name: null, mode: "SHARED" }), addTemplatePackage({ templateId: "t2", id: "p", packageName: "x", version: null })), "a SHARED template carries no packages"],
    ["duplicate package", () => run(base(), addTemplatePackage({ templateId: "t1", id: "p", packageName: "x", version: "1" }), addTemplatePackage({ templateId: "t1", id: "p", packageName: "y", version: null })), "package p already exists"],
    ["remove unknown package", () => run(base(), removeTemplatePackage({ templateId: "t1", id: "zz" })), "package zz does not exist"],
    ["delete unknown template", () => run(base(), deleteTemplate({ id: "zz" })), "template zz does not exist"],
    ["delete template in use", () => run(base(), deleteTemplate({ id: "t1" })), "template t1 is used by a term"],
    ["duplicate term id", () => run(base(), addTerm({ id: "k1", kind: "other", label: null, templateId: null, validityDays: null, issuers: null })), "term k1 already exists"],
    ["blank kind", () => run(base(), addTerm({ id: "k2", kind: " ", label: null, templateId: null, validityDays: null, issuers: null })), "a kind must be non-blank without surrounding spaces"],
    ["duplicate kind", () => run(base(), addTerm({ id: "k2", kind: "2026-pro", label: null, templateId: null, validityDays: null, issuers: null })), "kind 2026-pro is already used by this app"],
    ["term on unknown template", () => run(base(), addTerm({ id: "k2", kind: "x", label: null, templateId: "zz", validityDays: null, issuers: null })), "template zz does not exist"],
    ["non-positive validity on add", () => run(base(), addTerm({ id: "k2", kind: "x", label: null, templateId: null, validityDays: 0, issuers: null })), "validityDays must be positive"],
    ["details on unknown term", () => run(base(), setTermDetails({ id: "zz" })), "term zz does not exist"],
    ["blank kind on set", () => run(base(), setTermDetails({ id: "k1", kind: "" })), "a kind must be non-blank without surrounding spaces"],
    ["kind change after publish", () => run(base(), publishTerm({ id: "k1" }), setTermDetails({ id: "k1", kind: "renamed" })), "term k1 is ACTIVE; its kind is fixed"],
    ["kind clash on set", () => run(base(), addTerm({ id: "k2", kind: "free", label: null, templateId: null, validityDays: null, issuers: null }), setTermDetails({ id: "k2", kind: "2026-pro" })), "kind 2026-pro is already used by this app"],
    ["set unknown template", () => run(base(), setTermDetails({ id: "k1", templateId: "zz" })), "template zz does not exist"],
    ["non-positive validity on set", () => run(base(), setTermDetails({ id: "k1", validityDays: -1 })), "validityDays must be positive"],
    ["emptying an ACTIVE term", () => run(base(), publishTerm({ id: "k1" }), setTermDetails({ id: "k1", issuers: [] })), "an ACTIVE term needs a template and at least one issuer"],
    ["publish unknown", () => run(base(), publishTerm({ id: "zz" })), "term zz does not exist"],
    ["publish without template", () => run(base(), addTerm({ id: "k2", kind: "x", label: null, templateId: null, validityDays: null, issuers: ["INVITE_CODE"] }), publishTerm({ id: "k2" })), "a term needs a template and at least one issuer to be published"],
    ["publish without issuers", () => run(base(), addTerm({ id: "k2", kind: "x", label: null, templateId: "t1", validityDays: null, issuers: [] }), publishTerm({ id: "k2" })), "a term needs a template and at least one issuer to be published"],
    ["retire unknown", () => run(base(), retireTerm({ id: "zz" })), "term zz does not exist"],
    ["retire a DRAFT", () => run(base(), retireTerm({ id: "k1" })), "only an ACTIVE term can be retired"],
  ];
  it.each(cases)("%s is rejected with its message", (_name, build, message) => {
    expect(lastError(build())).toBe(message);
  });

  it("a rejected op leaves state as the previous op left it", () => {
    const ok = base();
    const bad = reducer(ok, deleteTemplate({ id: "t1" }));
    expect(bad.state.global).toStrictEqual(ok.state.global);
  });

  it("allows a kind rename while DRAFT and keeps an unchanged kind", () => {
    const doc = run(base(), setTermDetails({ id: "k1", kind: "2026-pro" }), setTermDetails({ id: "k1", kind: "2027-pro" }));
    expect(doc.operations.global.filter((o) => o.error)).toStrictEqual([]);
    expect(doc.state.global.terms[0]!.kind).toBe("2027-pro");
  });

  it("deletes an unused template", () => {
    const doc = run(base(), addTemplate({ id: "t2", name: null, mode: "SHARED" }), deleteTemplate({ id: "t2" }));
    expect(doc.state.global.templates.map((t) => t.id)).toStrictEqual(["t1"]);
  });
});
