/**
 * The old START/STOP status operations have been replaced by the
 * status_transitions module. See status-transitions.test.ts for tests.
 */
import { describe, it, expect } from "vitest";
import { utils } from "@powerhousedao/vetra-cloud-package/document-models/vetra-cloud-environment/v1";

describe("StatusOperations (legacy)", () => {
  it("should have DRAFT as initial status", () => {
    const document = utils.createDocument();
    expect(document.state.global.status).toBe("DRAFT");
  });
});
