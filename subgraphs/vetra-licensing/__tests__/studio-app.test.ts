import { describe, expect, it } from "vitest";
import { STUDIO_APP_ID, studioPublisherAddress } from "../studio-app.js";

describe("studio app", () => {
  it("has a fixed UUIDv4 id", () => {
    expect(STUDIO_APP_ID).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it("takes the publisher from VETRA_STUDIO_PUBLISHER_ADDRESS, else the first ADMINS entry, lowercased", () => {
    expect(studioPublisherAddress({ VETRA_STUDIO_PUBLISHER_ADDRESS: " 0xABC ", ADMINS: "0xdef" })).toBe("0xabc");
    expect(studioPublisherAddress({ ADMINS: " , 0xDEF,0x123" })).toBe("0xdef");
    expect(studioPublisherAddress({})).toBeNull();
  });
});
