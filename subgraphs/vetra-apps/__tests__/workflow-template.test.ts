import { describe, expect, it } from "vitest";
import { workflowTemplate } from "../workflow-template.js";

describe("workflowTemplate", () => {
  it("keeps the deploy job by default (existing apps)", () => {
    const yaml = workflowTemplate("app-1", "main");
    expect(yaml).toContain("powerhouse-inc/vetra-publish@v1");
    expect(yaml).toContain("powerhouse-inc/vetra-deploy-action@v1");
  });

  it("has only the publish job for a publish-only app", () => {
    const yaml = workflowTemplate("app-1", "main", {}, { deploy: false });
    expect(yaml).toContain("powerhouse-inc/vetra-publish@v1");
    expect(yaml).not.toContain("vetra-deploy-action");
    expect(yaml).not.toMatch(/^\s+deploy:/m);
  });
});
