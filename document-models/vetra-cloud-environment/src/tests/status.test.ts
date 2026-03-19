import { describe, it, expect, beforeEach } from "vitest";
import { generateMock } from "@powerhousedao/codegen";
import { utils } from "../../gen/utils.js";
import {
  StartInputSchema,
  StopInputSchema,
  type StartInput,
  type StopInput,
} from "../../gen/schema/index.js";
import { reducer } from "../../gen/reducer.js";
import * as creators from "../../gen/status/creators.js";
import type { VetraCloudEnvironmentDocument } from "../../gen/types.js";

describe("Status Operations", () => {
  let document: VetraCloudEnvironmentDocument;

  beforeEach(() => {
    document = utils.createDocument();
  });

  it("should handle start operation", () => {
    const input: StartInput = generateMock(StartInputSchema());
    const updatedDocument = reducer(document, creators.start(input));

    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe("START");
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should have initial status of STOPPED", () => {
    expect(document.state.global.status).toBe("STOPPED");
  });

  it("should change status to STARTED on START", () => {
    const input: StartInput = generateMock(StartInputSchema());
    const updatedDocument = reducer(document, creators.start(input));

    expect(updatedDocument.state.global.status).toBe("STARTED");
  });

  it("should handle stop operation", () => {
    const startInput: StartInput = generateMock(StartInputSchema());
    const stopInput: StopInput = generateMock(StopInputSchema());

    let updatedDocument = reducer(document, creators.start(startInput));
    updatedDocument = reducer(updatedDocument, creators.stop(stopInput));

    expect(updatedDocument.operations.global).toHaveLength(2);
    expect(updatedDocument.operations.global[1].action.type).toBe("STOP");
    expect(updatedDocument.operations.global[1].action.input).toStrictEqual(
      stopInput,
    );
    expect(updatedDocument.operations.global[1].index).toEqual(1);
  });

  it("should change status from STARTED to STOPPED on STOP", () => {
    const startInput: StartInput = generateMock(StartInputSchema());
    const stopInput: StopInput = generateMock(StopInputSchema());

    let updatedDocument = reducer(document, creators.start(startInput));
    expect(updatedDocument.state.global.status).toBe("STARTED");

    updatedDocument = reducer(updatedDocument, creators.stop(stopInput));
    expect(updatedDocument.state.global.status).toBe("STOPPED");
  });

  it("should handle START then STOP then START sequence", () => {
    const startInput1: StartInput = generateMock(StartInputSchema());
    const stopInput: StopInput = generateMock(StopInputSchema());
    const startInput2: StartInput = generateMock(StartInputSchema());

    let updatedDocument = reducer(document, creators.start(startInput1));
    expect(updatedDocument.state.global.status).toBe("STARTED");

    updatedDocument = reducer(updatedDocument, creators.stop(stopInput));
    expect(updatedDocument.state.global.status).toBe("STOPPED");

    updatedDocument = reducer(updatedDocument, creators.start(startInput2));
    expect(updatedDocument.state.global.status).toBe("STARTED");

    expect(updatedDocument.operations.global).toHaveLength(3);
  });

  it("should not affect other state fields when changing status", () => {
    const input: StartInput = generateMock(StartInputSchema());
    const updatedDocument = reducer(document, creators.start(input));

    expect(updatedDocument.state.global.name).toBeNull();
    expect(updatedDocument.state.global.services).toEqual([]);
    expect(updatedDocument.state.global.packages).toBeNull();
  });
});
