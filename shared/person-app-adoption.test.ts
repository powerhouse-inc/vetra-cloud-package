import { afterEach, describe, expect, it, vi } from "vitest";
import { adoptPersonAppsViaVetraApps, setPersonAppAdopter } from "./person-app-adoption.js";

afterEach(() => setPersonAppAdopter(null));

describe("person app adoption hook", () => {
  it("does nothing until vetra-apps registers, then forwards; a failure never throws", async () => {
    await expect(adoptPersonAppsViaVetraApps("0xa")).resolves.toBeUndefined();
    const adopter = vi.fn(async () => {});
    setPersonAppAdopter(adopter);
    await adoptPersonAppsViaVetraApps("0xa");
    expect(adopter).toHaveBeenCalledWith("0xa");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setPersonAppAdopter(async () => {
      throw new Error("renown down");
    });
    await expect(adoptPersonAppsViaVetraApps("0xa")).resolves.toBeUndefined();
    setPersonAppAdopter(async () => {
      throw "plain";
    });
    await expect(adoptPersonAppsViaVetraApps("0xa")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
