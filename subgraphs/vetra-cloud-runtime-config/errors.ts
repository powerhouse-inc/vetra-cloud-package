import { GraphQLError } from "graphql";

export type RuntimeConfigIssue = { path: string; message: string };

export class InvalidRuntimeConfigError extends GraphQLError {
  constructor(public readonly issues: RuntimeConfigIssue[]) {
    super(
      `Invalid runtime config: ${issues
        .map((i) => `${i.path}: ${i.message}`)
        .join("; ")}`,
      {
        extensions: {
          code: "INVALID_RUNTIME_CONFIG",
          issues,
        },
      },
    );
  }
}
