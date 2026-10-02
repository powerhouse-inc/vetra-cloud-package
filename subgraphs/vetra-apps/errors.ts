import { GraphQLError } from "graphql";

export type AppsErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "BAD_USER_INPUT"
  | "PREVIEWS_DISABLED"
  | "APP_NOT_ACTIVE"
  | "GITHUB_NOT_CONNECTED"
  | "SERVICE_NOT_CONFIGURED";

/** GraphQL error with the code in `extensions.code`. */
export function appsError(code: AppsErrorCode, message?: string): GraphQLError {
  return new GraphQLError(message ?? code, { extensions: { code } });
}

export function notConfigured(what: string): GraphQLError {
  return appsError("SERVICE_NOT_CONFIGURED", `${what} is not configured`);
}
