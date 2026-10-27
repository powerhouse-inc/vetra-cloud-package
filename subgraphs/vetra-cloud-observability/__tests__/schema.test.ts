import { buildASTSchema, getVariableValues, parse, printSchema, validate, type OperationDefinitionNode } from "graphql";
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

  // vetra.io sends `$apexService: TenantService`; a FUSION apex (a FUSION
  // service served at the custom domain itself) must pass input coercion.
  it("accepts FUSION as a setCustomDomain apexService", () => {
    const built = buildASTSchema(schema);
    const doc = parse(
      `mutation($apexService: TenantService) { setCustomDomain(documentId: "d", enabled: true, domain: "a.vetra.io", apexService: $apexService) { __typename } }`,
    );
    expect(validate(built, doc)).toEqual([]);
    const op = doc.definitions[0] as OperationDefinitionNode;
    const { errors } = getVariableValues(built, op.variableDefinitions ?? [], { apexService: "FUSION" });
    expect(errors).toBeUndefined();
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
