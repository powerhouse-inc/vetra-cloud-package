import { describe, expect, it } from "vitest";
import {
  reducer,
  utils,
  initialize,
  markChangesPushed,
  markDeploymentStarted,
  reportDeploymentSucceeded,
  reportDeploymentFailed,
  approveChanges,
  terminateEnvironment,
  markDestroyed,
  archive,
  unarchive,
  setLabel,
  enableService,
  addPackage,
  setCustomDomain,
  setGenericSubdomain,
  isVetraCloudEnvironmentDocument,
  InitializeInputSchema,
  MarkChangesPushedInputSchema,
  MarkDeploymentStartedInputSchema,
  ReportDeploymentSucceededInputSchema,
  ReportDeploymentFailedInputSchema,
  ApproveChangesInputSchema,
  TerminateEnvironmentInputSchema,
  MarkDestroyedInputSchema,
} from "@powerhousedao/vetra-cloud-package/document-models/vetra-cloud-environment/v1";
import { generateMock } from "@powerhousedao/codegen";

/** Helper to create an initialized document (CHANGES_APPROVED status) */
function createInitializedDocument() {
  const document = utils.createDocument();
  return reducer(
    document,
    initialize({
      genericSubdomain: "test-env",
      defaultPackageRegistry: "https://registry.example.com",
    }),
  );
}

/** Helper to advance document through the full deploy cycle to READY */
function createReadyDocument() {
  let doc = createInitializedDocument();
  doc = reducer(doc, markChangesPushed({}));
  doc = reducer(doc, markDeploymentStarted({}));
  doc = reducer(doc, reportDeploymentSucceeded({}));
  return doc;
}

describe("StatusTransitionsOperations", () => {
  describe("INITIALIZE (DRAFT -> CHANGES_APPROVED)", () => {
    it("should transition from DRAFT to CHANGES_APPROVED", () => {
      const document = utils.createDocument();
      expect(document.state.global.status).toBe("DRAFT");

      const updatedDocument = reducer(
        document,
        initialize({
          genericSubdomain: "my-env",
          defaultPackageRegistry: "https://registry.example.com",
        }),
      );

      expect(updatedDocument.state.global.status).toBe("CHANGES_APPROVED");
    });

    it("should set genericSubdomain and defaultPackageRegistry", () => {
      const document = utils.createDocument();
      const updatedDocument = reducer(
        document,
        initialize({
          genericSubdomain: "my-env",
          defaultPackageRegistry: "https://registry.example.com",
        }),
      );

      expect(updatedDocument.state.global.genericSubdomain).toBe("my-env");
      expect(updatedDocument.state.global.defaultPackageRegistry).toBe(
        "https://registry.example.com",
      );
    });

    it("should allow null defaultPackageRegistry", () => {
      const document = utils.createDocument();
      const updatedDocument = reducer(
        document,
        initialize({
          genericSubdomain: "my-env",
          defaultPackageRegistry: null,
        }),
      );

      expect(updatedDocument.state.global.defaultPackageRegistry).toBeNull();
    });

    it("should throw when not in DRAFT status", () => {
      const document = createInitializedDocument();
      expect(document.state.global.status).toBe("CHANGES_APPROVED");

      expect(() =>
        reducer(
          document,
          initialize({
            genericSubdomain: "another",
            defaultPackageRegistry: null,
          }),
        ),
      ).toThrow("INITIALIZE can only be called from DRAFT status");
    });
  });

  describe("MARK_CHANGES_PUSHED (CHANGES_APPROVED -> CHANGES_PUSHED)", () => {
    it("should transition from CHANGES_APPROVED to CHANGES_PUSHED", () => {
      const document = createInitializedDocument();
      expect(document.state.global.status).toBe("CHANGES_APPROVED");

      const updatedDocument = reducer(document, markChangesPushed({}));
      expect(updatedDocument.state.global.status).toBe("CHANGES_PUSHED");
    });

    it("should throw when not in CHANGES_APPROVED status", () => {
      const document = utils.createDocument();
      expect(() => reducer(document, markChangesPushed({}))).toThrow(
        "MARK_CHANGES_PUSHED can only be called from CHANGES_APPROVED status",
      );
    });
  });

  describe("MARK_DEPLOYMENT_STARTED (CHANGES_PUSHED -> DEPLOYING)", () => {
    it("should transition from CHANGES_PUSHED to DEPLOYING", () => {
      let document = createInitializedDocument();
      document = reducer(document, markChangesPushed({}));
      expect(document.state.global.status).toBe("CHANGES_PUSHED");

      document = reducer(document, markDeploymentStarted({}));
      expect(document.state.global.status).toBe("DEPLOYING");
    });

    it("should throw when not in CHANGES_PUSHED status", () => {
      const document = createInitializedDocument();
      expect(() => reducer(document, markDeploymentStarted({}))).toThrow(
        "MARK_DEPLOYMENT_STARTED can only be called from CHANGES_PUSHED status",
      );
    });
  });

  describe("REPORT_DEPLOYMENT_SUCCEEDED (DEPLOYING -> READY)", () => {
    it("should transition from DEPLOYING to READY", () => {
      let document = createInitializedDocument();
      document = reducer(document, markChangesPushed({}));
      document = reducer(document, markDeploymentStarted({}));
      expect(document.state.global.status).toBe("DEPLOYING");

      document = reducer(document, reportDeploymentSucceeded({}));
      expect(document.state.global.status).toBe("READY");
    });

    it("should throw when not in DEPLOYING status", () => {
      const document = createInitializedDocument();
      expect(() => reducer(document, reportDeploymentSucceeded({}))).toThrow(
        "REPORT_DEPLOYMENT_SUCCEEDED can only be called from DEPLOYING status",
      );
    });
  });

  describe("REPORT_DEPLOYMENT_FAILED (DEPLOYING -> DEPLOYMENT_FAILED)", () => {
    it("should transition from DEPLOYING to DEPLOYMENt_FAILED", () => {
      let document = createInitializedDocument();
      document = reducer(document, markChangesPushed({}));
      document = reducer(document, markDeploymentStarted({}));
      expect(document.state.global.status).toBe("DEPLOYING");

      document = reducer(
        document,
        reportDeploymentFailed({
          code: "TIMEOUT",
          message: "Deployment timed out after 300s",
        }),
      );
      expect(document.state.global.status).toBe("DEPLOYMENt_FAILED");
    });

    it("should throw when not in DEPLOYING status", () => {
      const document = createInitializedDocument();
      expect(() =>
        reducer(
          document,
          reportDeploymentFailed({ code: "ERR", message: "fail" }),
        ),
      ).toThrow(
        "REPORT_DEPLOYMENT_FAILED can only be called from DEPLOYING status",
      );
    });
  });

  describe("APPROVE_CHANGES (CHANGES_PENDING -> CHANGES_APPROVED)", () => {
    it("should transition from CHANGES_PENDING to CHANGES_APPROVED", () => {
      let document = createInitializedDocument();
      // Trigger CHANGES_PENDING by modifying data
      document = reducer(document, setLabel({ label: "updated" }));
      expect(document.state.global.status).toBe("CHANGES_PENDING");

      document = reducer(document, approveChanges({}));
      expect(document.state.global.status).toBe("CHANGES_APPROVED");
    });

    it("should throw when not in CHANGES_PENDING status", () => {
      const document = createInitializedDocument();
      expect(document.state.global.status).toBe("CHANGES_APPROVED");
      expect(() => reducer(document, approveChanges({}))).toThrow(
        "APPROVE_CHANGES can only be called from CHANGES_PENDING status",
      );
    });

    it("should throw from DRAFT status", () => {
      const document = utils.createDocument();
      expect(() => reducer(document, approveChanges({}))).toThrow();
    });
  });

  describe("TERMINATE_ENVIRONMENT (any -> TERMINATING)", () => {
    it("should transition from READY to TERMINATING", () => {
      const document = createReadyDocument();
      expect(document.state.global.status).toBe("READY");

      const updatedDocument = reducer(document, terminateEnvironment({}));
      expect(updatedDocument.state.global.status).toBe("TERMINATING");
    });

    it("should transition from DRAFT to TERMINATING", () => {
      const document = utils.createDocument();
      const updatedDocument = reducer(document, terminateEnvironment({}));
      expect(updatedDocument.state.global.status).toBe("TERMINATING");
    });

    it("should transition from CHANGES_APPROVED to TERMINATING", () => {
      const document = createInitializedDocument();
      const updatedDocument = reducer(document, terminateEnvironment({}));
      expect(updatedDocument.state.global.status).toBe("TERMINATING");
    });

    it("should transition from CHANGES_PENDING to TERMINATING", () => {
      let document = createInitializedDocument();
      document = reducer(document, setLabel({ label: "test" }));
      expect(document.state.global.status).toBe("CHANGES_PENDING");

      document = reducer(document, terminateEnvironment({}));
      expect(document.state.global.status).toBe("TERMINATING");
    });
  });

  describe("MARK_DESTROYED (TERMINATING -> DESTROYED)", () => {
    it("should transition from TERMINATING to DESTROYED", () => {
      let document = createReadyDocument();
      document = reducer(document, terminateEnvironment({}));
      expect(document.state.global.status).toBe("TERMINATING");

      document = reducer(document, markDestroyed({}));
      expect(document.state.global.status).toBe("DESTROYED");
    });

    it("should throw when not in TERMINATING status", () => {
      const document = createReadyDocument();
      expect(() => reducer(document, markDestroyed({}))).toThrow(
        "MARK_DESTROYED can only be called from TERMINATING status",
      );
    });
  });

  describe("ARCHIVE (DESTROYED -> ARCHIVED)", () => {
    it("should transition from DESTROYED to ARCHIVED", () => {
      let document = createReadyDocument();
      document = reducer(document, terminateEnvironment({}));
      document = reducer(document, markDestroyed({}));
      expect(document.state.global.status).toBe("DESTROYED");

      document = reducer(document, archive({}));
      expect(document.state.global.status).toBe("ARCHIVED");
    });

    it("should throw when not in DESTROYED status", () => {
      const document = createReadyDocument();
      expect(() => reducer(document, archive({}))).toThrow(
        "ARCHIVE can only be called from DESTROYED status",
      );
    });
  });

  describe("UNARCHIVE (ARCHIVED -> DESTROYED)", () => {
    it("should transition from ARCHIVED to DESTROYED", () => {
      let document = createReadyDocument();
      document = reducer(document, terminateEnvironment({}));
      document = reducer(document, markDestroyed({}));
      document = reducer(document, archive({}));
      expect(document.state.global.status).toBe("ARCHIVED");

      document = reducer(document, unarchive({}));
      expect(document.state.global.status).toBe("DESTROYED");
    });

    it("should throw when not in ARCHIVED status", () => {
      let document = createReadyDocument();
      document = reducer(document, terminateEnvironment({}));
      document = reducer(document, markDestroyed({}));
      expect(document.state.global.status).toBe("DESTROYED");

      expect(() => reducer(document, unarchive({}))).toThrow(
        "UNARCHIVE can only be called from ARCHIVED status",
      );
    });

    it("should allow re-archiving after unarchive", () => {
      let document = createReadyDocument();
      document = reducer(document, terminateEnvironment({}));
      document = reducer(document, markDestroyed({}));
      document = reducer(document, archive({}));
      document = reducer(document, unarchive({}));
      expect(document.state.global.status).toBe("DESTROYED");

      document = reducer(document, archive({}));
      expect(document.state.global.status).toBe("ARCHIVED");
    });
  });

  describe("Full lifecycle", () => {
    it("should complete the full happy path: DRAFT -> READY", () => {
      let document = utils.createDocument();
      expect(document.state.global.status).toBe("DRAFT");

      // Initialize
      document = reducer(
        document,
        initialize({
          genericSubdomain: "prod-env",
          defaultPackageRegistry: "https://registry.example.com",
        }),
      );
      expect(document.state.global.status).toBe("CHANGES_APPROVED");

      // Push changes
      document = reducer(document, markChangesPushed({}));
      expect(document.state.global.status).toBe("CHANGES_PUSHED");

      // Start deployment
      document = reducer(document, markDeploymentStarted({}));
      expect(document.state.global.status).toBe("DEPLOYING");

      // Deployment succeeds
      document = reducer(document, reportDeploymentSucceeded({}));
      expect(document.state.global.status).toBe("READY");
    });

    it("should handle the change-approve-deploy cycle from READY", () => {
      let document = createReadyDocument();

      // User makes a change -> CHANGES_PENDING
      document = reducer(document, setLabel({ label: "updated-env" }));
      expect(document.state.global.status).toBe("CHANGES_PENDING");

      // Approve changes
      document = reducer(document, approveChanges({}));
      expect(document.state.global.status).toBe("CHANGES_APPROVED");

      // Push and deploy
      document = reducer(document, markChangesPushed({}));
      document = reducer(document, markDeploymentStarted({}));
      document = reducer(document, reportDeploymentSucceeded({}));
      expect(document.state.global.status).toBe("READY");
    });

    it("should handle deployment failure and retry", () => {
      let document = createInitializedDocument();
      document = reducer(document, markChangesPushed({}));
      document = reducer(document, markDeploymentStarted({}));
      document = reducer(
        document,
        reportDeploymentFailed({
          code: "OOM",
          message: "Out of memory",
        }),
      );
      expect(document.state.global.status).toBe("DEPLOYMENt_FAILED");
    });

    it("should handle the full teardown: READY -> ARCHIVED", () => {
      let document = createReadyDocument();

      document = reducer(document, terminateEnvironment({}));
      expect(document.state.global.status).toBe("TERMINATING");

      document = reducer(document, markDestroyed({}));
      expect(document.state.global.status).toBe("DESTROYED");

      document = reducer(document, archive({}));
      expect(document.state.global.status).toBe("ARCHIVED");
    });
  });

  describe("CHANGES_PENDING transitions from data operations", () => {
    it("SET_LABEL should set status to CHANGES_PENDING", () => {
      let document = createInitializedDocument();
      document = reducer(document, setLabel({ label: "new" }));
      expect(document.state.global.status).toBe("CHANGES_PENDING");
    });

    it("SET_GENERIC_SUBDOMAIN should set status to CHANGES_PENDING", () => {
      let document = createInitializedDocument();
      document = reducer(
        document,
        setGenericSubdomain({ genericSubdomain: "new-sub" }),
      );
      expect(document.state.global.status).toBe("CHANGES_PENDING");
    });

    it("SET_CUSTOM_DOMAIN should set status to CHANGES_PENDING", () => {
      let document = createInitializedDocument();
      document = reducer(
        document,
        setCustomDomain({ enabled: true, domain: "test.com" }),
      );
      expect(document.state.global.status).toBe("CHANGES_PENDING");
    });

    it("ENABLE_SERVICE should set status to CHANGES_PENDING", () => {
      let document = createInitializedDocument();
      document = reducer(
        document,
        enableService({ type: "CONNECT", prefix: "connect" }),
      );
      expect(document.state.global.status).toBe("CHANGES_PENDING");
    });

    it("ADD_PACKAGE should set status to CHANGES_PENDING", () => {
      let document = createInitializedDocument();
      document = reducer(document, addPackage({ packageName: "my-pkg" }));
      expect(document.state.global.status).toBe("CHANGES_PENDING");
    });
  });

  it("should handle initialize operation", () => {
    const document = utils.createDocument();
    const input = generateMock(InitializeInputSchema());

    const updatedDocument = reducer(document, initialize(input));

    expect(isVetraCloudEnvironmentDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe("INITIALIZE");
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle markChangesPushed operation", () => {
    const document = utils.createDocument();
    const input = generateMock(MarkChangesPushedInputSchema());

    const updatedDocument = reducer(document, markChangesPushed(input));

    expect(isVetraCloudEnvironmentDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "MARK_CHANGES_PUSHED",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle markDeploymentStarted operation", () => {
    const document = utils.createDocument();
    const input = generateMock(MarkDeploymentStartedInputSchema());

    const updatedDocument = reducer(document, markDeploymentStarted(input));

    expect(isVetraCloudEnvironmentDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "MARK_DEPLOYMENT_STARTED",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle reportDeploymentSucceeded operation", () => {
    const document = utils.createDocument();
    const input = generateMock(ReportDeploymentSucceededInputSchema());

    const updatedDocument = reducer(document, reportDeploymentSucceeded(input));

    expect(isVetraCloudEnvironmentDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "REPORT_DEPLOYMENT_SUCCEEDED",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle reportDeploymentFailed operation", () => {
    const document = utils.createDocument();
    const input = generateMock(ReportDeploymentFailedInputSchema());

    const updatedDocument = reducer(document, reportDeploymentFailed(input));

    expect(isVetraCloudEnvironmentDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "REPORT_DEPLOYMENT_FAILED",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle approveChanges operation", () => {
    const document = utils.createDocument();
    const input = generateMock(ApproveChangesInputSchema());

    const updatedDocument = reducer(document, approveChanges(input));

    expect(isVetraCloudEnvironmentDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "APPROVE_CHANGES",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle terminateEnvironment operation", () => {
    const document = utils.createDocument();
    const input = generateMock(TerminateEnvironmentInputSchema());

    const updatedDocument = reducer(document, terminateEnvironment(input));

    expect(isVetraCloudEnvironmentDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "TERMINATE_ENVIRONMENT",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle markDestroyed operation", () => {
    const document = utils.createDocument();
    const input = generateMock(MarkDestroyedInputSchema());

    const updatedDocument = reducer(document, markDestroyed(input));

    expect(isVetraCloudEnvironmentDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "MARK_DESTROYED",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });
});
