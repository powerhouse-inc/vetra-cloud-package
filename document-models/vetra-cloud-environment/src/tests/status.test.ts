/**
 * This is a scaffold file meant for customization:
 * - change it by adding new tests or modifying the existing ones
 */

import { describe, it, expect, beforeEach } from "vitest";
import { generateMock } from "@powerhousedao/codegen";
import { utils } from "../../gen/utils.js";
import { StartInputSchema, type StartInput } from "../../gen/schema/index.js";
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
});
