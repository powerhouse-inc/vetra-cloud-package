import { describe, expect, it } from "vitest";
import { validateDomain } from "../domains/validate.js";

describe("validateDomain (plan 7 H5)", () => {
  it.each([
    ["Example.COM.", "example.com"],
    ["  app.sektar.io ", "app.sektar.io"],
    ["xn--bcher-kva.example", "xn--bcher-kva.example"],
    ["bücher.example", "xn--bcher-kva.example"],
    ["a-b.c-d.example.org", "a-b.c-d.example.org"],
  ])("accepts %s as %s", (input, domain) => {
    expect(validateDomain(input)).toEqual({ domain });
  });

  it.each([
    [""],
    ["   "],
    ["foo.vetra.io"],
    ["vetra.io"],
    ["VETRA.IO."],
    ["x.staging.vetra.io"],
    ["staging.vetra.io"],
    ["1.2.3.4"],
    ["[::1]"],
    ["::1"],
    ["localhost"],
    ["a.localhost"],
    ["a"],
    ["-a.com"],
    ["a-.com"],
    ["a..com"],
    ["a_b.com"],
    ["a b.com"],
    ["https://a.com"],
    ["a.com/x"],
    ["*.a.com"],
    [`${"a".repeat(64)}.com`],
    [`${"a.".repeat(126)}com`], // 255 chars
  ])("refuses %s", (input) => {
    expect(validateDomain(input)).toHaveProperty("error");
  });

  it("refuses extra base domains it is given", () => {
    expect(
      validateDomain("x.example.net", { refused: ["example.net"] }),
    ).toHaveProperty("error");
    expect(
      validateDomain("example.net", { refused: ["example.net"] }),
    ).toHaveProperty("error");
    expect(
      validateDomain("myexample.net", { refused: ["example.net"] }),
    ).toEqual({ domain: "myexample.net" });
  });

  it("refuses 254 characters and accepts 253", () => {
    const label = "a".repeat(61);
    const d253 =
      `${label}.${label}.${label}.${label}.com`.slice(0, 249) + ".com";
    expect(d253.length).toBe(253);
    expect(validateDomain(d253)).toEqual({ domain: d253 });
    expect(validateDomain(`a${d253}`)).toHaveProperty("error");
  });
});
