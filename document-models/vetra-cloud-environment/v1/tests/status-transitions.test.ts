import { generateMock } from "document-model";
import {
  approveChanges,
  ApproveChangesInputSchema,
  archive,
  ArchiveInputSchema,
  initialize,
  InitializeInputSchema,
  isVetraCloudEnvironmentDocument,
  markChangesPushed,
  MarkChangesPushedInputSchema,
  markDeploymentStarted,
  MarkDeploymentStartedInputSchema,
  markDestroyed,
  MarkDestroyedInputSchema,
  reducer,
  reportDeploymentFailed,
  ReportDeploymentFailedInputSchema,
  reportDeploymentSucceeded,
  ReportDeploymentSucceededInputSchema,
  sleepEnvironment,
  SleepEnvironmentInputSchema,
  terminateEnvironment,
  TerminateEnvironmentInputSchema,
  unarchive,
  UnarchiveInputSchema,
  utils,
  wakeEnvironment,
  WakeEnvironmentInputSchema,
} from "document-models/vetra-cloud-environment/v1";
import { describe, expect, it } from "vitest";

describe("StatusTransitionsOperations", () => {
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

  it("should handle archive operation", () => {
    const document = utils.createDocument();
    const input = generateMock(ArchiveInputSchema());

    const updatedDocument = reducer(document, archive(input));

    expect(isVetraCloudEnvironmentDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe("ARCHIVE");
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle unarchive operation", () => {
    const document = utils.createDocument();
    const input = generateMock(UnarchiveInputSchema());

    const updatedDocument = reducer(document, unarchive(input));

    expect(isVetraCloudEnvironmentDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe("UNARCHIVE");
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("sleepEnvironment puts a READY studio to sleep (READY → STOPPED)", () => {
    const document = utils.createDocument({ global: { status: "READY" } });
    const input = generateMock(SleepEnvironmentInputSchema());

    const updatedDocument = reducer(document, sleepEnvironment(input));

    expect(updatedDocument.operations.global[0].action.type).toBe(
      "SLEEP_ENVIRONMENT",
    );
    expect(updatedDocument.operations.global[0].error).toBeUndefined();
    expect(updatedDocument.state.global.status).toBe("STOPPED");
  });

  it("sleepEnvironment is rejected unless the studio is READY", () => {
    const document = utils.createDocument({ global: { status: "DEPLOYING" } });
    const input = generateMock(SleepEnvironmentInputSchema());

    const updatedDocument = reducer(document, sleepEnvironment(input));

    expect(updatedDocument.operations.global[0].error).toBeDefined();
    expect(updatedDocument.state.global.status).toBe("DEPLOYING");
  });

  it("wakeEnvironment re-approves a sleeping studio (STOPPED → CHANGES_APPROVED)", () => {
    const document = utils.createDocument({ global: { status: "STOPPED" } });
    const input = generateMock(WakeEnvironmentInputSchema());

    const updatedDocument = reducer(document, wakeEnvironment(input));

    expect(updatedDocument.operations.global[0].action.type).toBe(
      "WAKE_ENVIRONMENT",
    );
    expect(updatedDocument.operations.global[0].error).toBeUndefined();
    expect(updatedDocument.state.global.status).toBe("CHANGES_APPROVED");
  });

  it("wakeEnvironment is rejected unless the studio is STOPPED", () => {
    const document = utils.createDocument({ global: { status: "READY" } });
    const input = generateMock(WakeEnvironmentInputSchema());

    const updatedDocument = reducer(document, wakeEnvironment(input));

    expect(updatedDocument.operations.global[0].error).toBeDefined();
    expect(updatedDocument.state.global.status).toBe("READY");
  });
});
