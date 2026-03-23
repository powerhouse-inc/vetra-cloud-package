import { buildASTSchema, printSchema } from "graphql";
import { schema } from "../schema.js";

describe("GraphQL schema", () => {
  it("is a valid DocumentNode", () => {
    expect(schema).toBeDefined();
    expect(schema.kind).toBe("Document");
  });

  it("can be built into a valid schema", () => {
    const built = buildASTSchema(schema);
    expect(built).toBeDefined();
  });

  it("has all expected query fields", () => {
    const built = buildASTSchema(schema);
    const query = built.getQueryType();
    expect(query).toBeDefined();
    const fields = Object.keys(query!.getFields());
    expect(fields).toContain("environmentStatus");
    expect(fields).toContain("environmentPods");
    expect(fields).toContain("environmentEvents");
    expect(fields).toContain("cpuUsage");
    expect(fields).toContain("memoryUsage");
    expect(fields).toContain("podRestartRate");
    expect(fields).toContain("httpRequestRate");
    expect(fields).toContain("httpLatency");
    expect(fields).toContain("logs");
    expect(fields).toContain("errorLogs");
  });

  it("has all expected enums", () => {
    const built = buildASTSchema(schema);
    expect(built.getType("ArgoSyncStatus")).toBeDefined();
    expect(built.getType("ArgoHealthStatus")).toBeDefined();
    expect(built.getType("PodPhase")).toBeDefined();
    expect(built.getType("EventType")).toBeDefined();
    expect(built.getType("TenantService")).toBeDefined();
    expect(built.getType("MetricRange")).toBeDefined();
  });

  it("has all expected types", () => {
    const built = buildASTSchema(schema);
    expect(built.getType("EnvironmentStatus")).toBeDefined();
    expect(built.getType("Pod")).toBeDefined();
    expect(built.getType("KubeEvent")).toBeDefined();
    expect(built.getType("MetricSeries")).toBeDefined();
    expect(built.getType("Datapoint")).toBeDefined();
    expect(built.getType("LogEntry")).toBeDefined();
  });
});
