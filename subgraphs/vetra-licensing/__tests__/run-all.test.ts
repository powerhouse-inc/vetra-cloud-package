import { describe, expect, it } from "vitest";
import { runAll } from "../run-all.js";

describe("runAll", () => {
  it("resolves when no step fails, having run each in order", async () => {
    const ran: string[] = [];
    await expect(
      runAll([async () => void ran.push("a"), async () => void ran.push("b")]),
    ).resolves.toBeUndefined();
    expect(ran).toStrictEqual(["a", "b"]);
  });

  it("runs every step when the first throws", async () => {
    const ran: string[] = [];
    await expect(
      runAll([
        () => Promise.reject(new Error("first")),
        async () => void ran.push("second"),
      ]),
    ).rejects.toThrow("first");
    expect(ran).toStrictEqual(["second"]);
  });

  it("rethrows a single failure unchanged", async () => {
    const err = new Error("only");
    await expect(
      runAll([async () => {}, () => Promise.reject(err)]),
    ).rejects.toBe(err);
  });

  it("gives an AggregateError carrying both failures when two fail", async () => {
    const a = new Error("tracking down");
    const b = new Error("marker down");
    const failure = await runAll([
      () => Promise.reject(a),
      () => Promise.reject(b),
    ]).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toStrictEqual([a, b]);
    // The handler dedupes its warning on the message: it must be stable.
    expect((failure as AggregateError).message).toBe(
      "2 steps failed: Error: tracking down; Error: marker down",
    );
  });
});
