import { GraphQLError } from "graphql";

export type AuthContext = {
  user?: { address?: string | null };
};

export function requireAuthenticatedUser(ctx: AuthContext): {
  address: string;
} {
  const address = ctx.user?.address;
  if (!address) {
    throw new GraphQLError("Unauthenticated", {
      extensions: { code: "UNAUTHENTICATED" },
    });
  }
  return { address };
}
