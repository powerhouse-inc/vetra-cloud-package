import { describe, it, expect } from "vitest";
import type { Action } from "document-model";
import {
  reducer,
  utils,
  markChangesPushed,
  markDeploymentStarted,
  reportDeploymentSucceeded,
  type VetraCloudEnvironmentDocument,
} from "document-models/vetra-cloud-environment";
import {
  renderCreateActions,
  renderUpdateActions,
  type TemplateShape,
} from "../template.js";

/**
 * The provisioning path driven through the real environment reducers instead of
 * a mocked EnvGateway. Every test above this one stubs `envs.execute` to a
 * resolving promise, which is exactly how a create-only action list on the
 * update path stayed invisible: the reducers reject it, the stub does not.
 */

const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const template: TemplateShape = {
  services: [
    { id: "s1", type: "CONNECT", prefix: "connect" },
    { id: "s2", type: "SWITCHBOARD", prefix: "switchboard" },
  ],
  packages: [
    { id: "p1", packageName: "@powerhousedao/knowledge", version: "1.0.0" },
  ],
  size: null,
  baseDomain: "vetra.io",
  packageRegistry: "https://registry.example.com",
};

const apply = (doc: VetraCloudEnvironmentDocument, actions: Action[]) =>
  actions.reduce<VetraCloudEnvironmentDocument>(
    (d, a) => reducer(d, a as never),
    doc,
  );

/** Every rejection the reducers recorded, as "ACTION_TYPE: message". */
const rejections = (doc: VetraCloudEnvironmentDocument) =>
  doc.operations.global
    .filter((op) => op.error)
    .map((op) => `${op.action?.type ?? "?"}: ${op.error ?? ""}`);

const service = (doc: VetraCloudEnvironmentDocument, type: string) =>
  doc.state.global.services.find((s) => s.type === type);

/** Walk a freshly approved environment through its deploy pipeline to READY. */
const deploy = (doc: VetraCloudEnvironmentDocument) =>
  apply(doc, [
    markChangesPushed({}),
    markDeploymentStarted({}),
    reportDeploymentSucceeded({}),
  ]);

const provision = () =>
  apply(
    utils.createDocument(),
    renderCreateActions({
      label: "Acme vault",
      subdomain: "acme-vault",
      owner: OWNER,
      template,
    }),
  );

describe("renderCreateActions against the real reducers", () => {
  it("builds an approved environment with no rejected action", () => {
    const doc = provision();
    expect(rejections(doc)).toEqual([]);
    expect(doc.state.global.status).toBe("CHANGES_APPROVED");
    expect(doc.state.global.owner).toBe(OWNER);
    expect(doc.state.global.genericSubdomain).toBe("acme-vault");
    expect(doc.state.global.genericBaseDomain).toBe("vetra.io");
    expect(service(doc, "CONNECT")?.enabled).toBe(true);
    expect(service(doc, "SWITCHBOARD")?.enabled).toBe(true);
    expect(doc.state.global.packages).toEqual([
      {
        registry: "https://registry.example.com",
        name: "@powerhousedao/knowledge",
        version: "1.0.0",
      },
    ]);
  });
});

describe("renderUpdateActions against the real reducers", () => {
  it("converges a deployed environment onto a changed template", () => {
    const live = deploy(provision());
    expect(live.state.global.status).toBe("READY");

    const changed: TemplateShape = {
      ...template,
      // SWITCHBOARD dropped, knowledge bumped, vault added.
      services: [{ id: "s1", type: "CONNECT", prefix: "connect" }],
      packages: [
        { id: "p1", packageName: "@powerhousedao/knowledge", version: "2.0.0" },
        { id: "p2", packageName: "@powerhousedao/vault", version: null },
      ],
    };

    const before = live.operations.global.length;
    const updated = apply(
      live,
      renderUpdateActions({
        label: "Acme vault",
        template: changed,
        current: live.state.global,
      }),
    );

    expect(rejections(updated)).toEqual([]);
    expect(updated.operations.global.length).toBeGreaterThan(before);
    expect(updated.state.global.status).toBe("CHANGES_APPROVED");
    expect(service(updated, "CONNECT")?.enabled).toBe(true);
    expect(service(updated, "SWITCHBOARD")?.enabled).toBe(false);
    expect(updated.state.global.packages).toEqual([
      {
        registry: "https://registry.example.com",
        name: "@powerhousedao/knowledge",
        version: "2.0.0",
      },
      {
        registry: "https://registry.example.com",
        name: "@powerhousedao/vault",
        version: "latest",
      },
    ]);
  });

  it("re-approves without rejection when the template has not moved", () => {
    const live = deploy(provision());
    const again = apply(
      live,
      renderUpdateActions({
        label: "Acme vault",
        template,
        current: live.state.global,
      }),
    );
    expect(rejections(again)).toEqual([]);
    expect(again.state.global.status).toBe("CHANGES_APPROVED");
  });

  // The defect the split exists to fix: INITIALIZE only works from DRAFT and
  // SET_OWNER is rejected on an owned environment signed by the system, so the
  // create list can never be replayed on an existing environment.
  it("is required: the create list is rejected by a deployed environment", () => {
    const live = deploy(provision());
    const replayed = apply(
      live,
      renderCreateActions({
        label: "Acme vault",
        subdomain: "acme-vault",
        owner: OWNER,
        template,
      }),
    );
    expect(rejections(replayed)).toEqual([
      expect.stringContaining("INITIALIZE"),
      expect.stringContaining("SET_OWNER"),
    ]);
  });
});
