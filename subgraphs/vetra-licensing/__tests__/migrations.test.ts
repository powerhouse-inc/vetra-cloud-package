import { describe, it, expect } from "vitest";
import { up } from "../db/migrations.js";

describe("vetra-licensing migrations", () => {
  it("creates app_user_environments and app_environment_limits", async () => {
    const created: string[] = [];
    const fake = {
      schema: {
        createTable: (name: string) => {
          created.push(name);
          const chain: any = {
            addColumn: () => chain,
            addPrimaryKeyConstraint: () => chain,
            ifNotExists: () => chain,
            execute: async () => undefined,
          };
          return chain;
        },
        createIndex: () => {
          const chain: any = {
            on: () => chain,
            column: () => chain,
            ifNotExists: () => chain,
            execute: async () => undefined,
          };
          return chain;
        },
      },
    };
    await up(fake as never);
    expect(created).toEqual(["app_user_environments", "app_environment_limits"]);
  });
});
