import {
  addTemplatePackage,
  addTemplateService,
  publishLicenseType,
  reducer,
  retireLicenseType,
  setLicenseTypeDetails,
  setTemplate,
  utils,
} from "document-models/app-license-type/v1";
import { describe, expect, it } from "vitest";

const details = {
  app: "app-1",
  kind: "2026-free-tier",
  label: "Free",
  validityDays: 365,
};

describe("AppLicenseType", () => {
  it("starts as DRAFT with an empty template", () => {
    const doc = utils.createDocument();
    expect(doc.state.global.status).toBe("DRAFT");
    expect(doc.state.global.template).toBeNull();
  });

  describe("SET_LICENSE_TYPE_DETAILS", () => {
    it("sets every detail", () => {
      const doc = reducer(
        utils.createDocument(),
        setLicenseTypeDetails(details),
      );
      expect(doc.state.global).toMatchObject(details);
      expect(doc.operations.global[0].error).toBeUndefined();
    });

    it("keeps existing details when the input omits them, and clears validity", () => {
      let doc = reducer(utils.createDocument(), setLicenseTypeDetails(details));
      doc = reducer(doc, setLicenseTypeDetails({}));
      expect(doc.state.global.app).toBe("app-1");
      expect(doc.state.global.kind).toBe("2026-free-tier");
      expect(doc.state.global.label).toBe("Free");
      expect(doc.state.global.validityDays).toBeNull();
    });

    it("refuses negative validity", () => {
      const doc = reducer(
        utils.createDocument(),
        setLicenseTypeDetails({ ...details, validityDays: -1 }),
      );
      expect(doc.operations.global[0].error).toBe(
        "validityDays must be positive",
      );
      expect(doc.state.global.kind).toBeNull();
    });

    it("refuses zero validity", () => {
      const doc = reducer(
        utils.createDocument(),
        setLicenseTypeDetails({ ...details, validityDays: 0 }),
      );
      expect(doc.operations.global[0].error).toBe(
        "validityDays must be positive",
      );
    });
  });

  describe("SET_TEMPLATE", () => {
    it("creates the template and sets its scalar fields", () => {
      const doc = reducer(
        utils.createDocument(),
        setTemplate({
          size: "small",
          baseDomain: "vetra.io",
          packageRegistry: "https://registry.example.com",
        }),
      );
      expect(doc.state.global.template).toStrictEqual({
        services: [],
        packages: [],
        size: "small",
        baseDomain: "vetra.io",
        packageRegistry: "https://registry.example.com",
      });
    });

    it("nulls scalars the input omits", () => {
      const doc = reducer(
        utils.createDocument(),
        setTemplate({ baseDomain: "vetra.io" }),
      );
      expect(doc.state.global.template?.size).toBeNull();
      expect(doc.state.global.template?.baseDomain).toBe("vetra.io");
    });

    it("keeps services and packages when the scalars change", () => {
      let doc = reducer(
        utils.createDocument(),
        addTemplateService({ id: "svc-1", type: "CONNECT", prefix: "c" }),
      );
      doc = reducer(doc, setTemplate({ size: "large" }));
      expect(doc.state.global.template?.services).toHaveLength(1);
      expect(doc.state.global.template?.size).toBe("large");
      expect(doc.state.global.template?.baseDomain).toBeNull();
      expect(doc.state.global.template?.packageRegistry).toBeNull();
    });
  });

  describe("ADD_TEMPLATE_SERVICE", () => {
    // The Knowledge Vault template is a fusion app plus a switchboard, and some
    // apps need docling. A licence type must be able to express every service an
    // environment can actually run; when it could not, the reducer rejected the
    // action and the publisher saw a raw schema error.
    it("accepts every service type an environment can run", () => {
      const types = [
        "CONNECT",
        "SWITCHBOARD",
        "FUSION",
        "CLINT",
        "DOCLING",
        "PAPERLESS",
        "SPECKLE",
      ] as const;
      let doc = utils.createDocument();
      types.forEach((type, i) => {
        doc = reducer(doc, addTemplateService({ id: `svc-${i}`, type }));
      });
      const last = doc.operations.global.at(-1);
      expect(last?.error).toBeUndefined();
      expect(doc.state.global.template?.services.map((s) => s.type)).toStrictEqual([
        ...types,
      ]);
    });

    it("builds the Knowledge Vault shape: fusion app plus switchboard", () => {
      let doc = reducer(
        utils.createDocument(),
        addTemplateService({ id: "svc-1", type: "SWITCHBOARD", prefix: "api" }),
      );
      doc = reducer(doc, addTemplateService({ id: "svc-2", type: "FUSION" }));
      expect(doc.operations.global.at(-1)?.error).toBeUndefined();
      expect(doc.state.global.template?.services).toStrictEqual([
        { id: "svc-1", type: "SWITCHBOARD", prefix: "api" },
        { id: "svc-2", type: "FUSION", prefix: null },
      ]);
    });

    it("adds a service, defaulting an omitted prefix to null", () => {
      let doc = reducer(
        utils.createDocument(),
        addTemplateService({ id: "svc-1", type: "CONNECT", prefix: "connect" }),
      );
      doc = reducer(doc, addTemplateService({ id: "svc-2", type: "CLINT" }));
      expect(doc.state.global.template?.services).toStrictEqual([
        { id: "svc-1", type: "CONNECT", prefix: "connect" },
        { id: "svc-2", type: "CLINT", prefix: null },
      ]);
    });

    it("refuses a duplicate service id", () => {
      let doc = utils.createDocument();
      doc = reducer(
        doc,
        addTemplateService({ id: "svc-1", type: "CONNECT", prefix: "connect" }),
      );
      doc = reducer(
        doc,
        addTemplateService({
          id: "svc-1",
          type: "SWITCHBOARD",
          prefix: "switchboard",
        }),
      );
      expect(doc.operations.global[1].error).toBe(
        "service svc-1 already exists",
      );
      expect(doc.state.global.template?.services).toHaveLength(1);
    });
  });

  describe("ADD_TEMPLATE_PACKAGE", () => {
    it("adds a package, defaulting omitted fields to null", () => {
      let doc = reducer(
        utils.createDocument(),
        addTemplatePackage({
          id: "pkg-1",
          packageName: "@powerhouse/vetra",
          version: "1.2.3",
        }),
      );
      doc = reducer(doc, addTemplatePackage({ id: "pkg-2" }));
      expect(doc.state.global.template?.packages).toStrictEqual([
        { id: "pkg-1", packageName: "@powerhouse/vetra", version: "1.2.3" },
        { id: "pkg-2", packageName: null, version: null },
      ]);
    });

    it("refuses a duplicate package id", () => {
      let doc = utils.createDocument();
      doc = reducer(
        doc,
        addTemplatePackage({ id: "pkg-1", packageName: "a", version: "1" }),
      );
      doc = reducer(
        doc,
        addTemplatePackage({ id: "pkg-1", packageName: "b", version: "2" }),
      );
      expect(doc.operations.global[1].error).toBe(
        "package pkg-1 already exists",
      );
      expect(doc.state.global.template?.packages).toStrictEqual([
        { id: "pkg-1", packageName: "a", version: "1" },
      ]);
    });
  });

  describe("PUBLISH_LICENSE_TYPE", () => {
    it("publishes once a kind and a service exist", () => {
      let doc = utils.createDocument();
      doc = reducer(doc, setLicenseTypeDetails(details));
      doc = reducer(
        doc,
        addTemplateService({ id: "svc-1", type: "CONNECT", prefix: "connect" }),
      );
      doc = reducer(doc, publishLicenseType({ _: true }));
      expect(doc.state.global.status).toBe("ACTIVE");
    });

    it("refuses to publish without a service", () => {
      let doc = utils.createDocument();
      doc = reducer(doc, setLicenseTypeDetails(details));
      doc = reducer(doc, publishLicenseType({ _: true }));
      expect(doc.operations.global[1].error).toBe(
        "a license type needs at least one service before it can be published",
      );
      expect(doc.state.global.status).toBe("DRAFT");
    });

    it("refuses to publish a template with no services", () => {
      let doc = utils.createDocument();
      doc = reducer(doc, setLicenseTypeDetails(details));
      doc = reducer(doc, setTemplate({ size: "small" }));
      doc = reducer(doc, publishLicenseType({ _: true }));
      expect(doc.operations.global[2].error).toBeDefined();
      expect(doc.state.global.status).toBe("DRAFT");
    });

    it("refuses to publish without a kind", () => {
      let doc = utils.createDocument();
      doc = reducer(
        doc,
        addTemplateService({ id: "svc-1", type: "CONNECT", prefix: "connect" }),
      );
      doc = reducer(doc, publishLicenseType({ _: true }));
      expect(doc.operations.global[1].error).toBeDefined();
      expect(doc.state.global.status).toBe("DRAFT");
    });
  });

  describe("RETIRE_LICENSE_TYPE", () => {
    it("retires an ACTIVE license type", () => {
      let doc = utils.createDocument();
      doc = reducer(doc, setLicenseTypeDetails(details));
      doc = reducer(
        doc,
        addTemplateService({ id: "svc-1", type: "CONNECT", prefix: "connect" }),
      );
      doc = reducer(doc, publishLicenseType({ _: true }));
      doc = reducer(doc, retireLicenseType({ _: true }));
      expect(doc.state.global.status).toBe("RETIRED");
    });

    it("refuses to retire a draft", () => {
      const doc = reducer(
        utils.createDocument(),
        retireLicenseType({ _: true }),
      );
      expect(doc.operations.global[0].error).toBe(
        "only an ACTIVE license type can be retired",
      );
      expect(doc.state.global.status).toBe("DRAFT");
    });
  });
});
