import { describe, expect, it } from "vitest";
import {
  UnsupportedDidError,
  addressOfDid,
  callerDid,
  didForAddress,
  normaliseUserDid,
} from "../did.js";

const ADDR = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
const DID = `did:pkh:eip155:1:${ADDR.toLowerCase()}`;

describe("normaliseUserDid", () => {
  it.each([
    [ADDR],
    [ADDR.toLowerCase()],
    [`did:pkh:eip155:1:${ADDR}`],
    [`did:pkh:eip155:137:${ADDR}`],
    [`  ${DID}  `],
  ])("normalises %s to chain 1 lowercased", (input) => {
    expect(normaliseUserDid(input)).toBe(DID);
  });

  it.each([
    ["did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"],
    ["did:pkh:solana:4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZ:abc"],
    ["0x123"],
    [""],
    ["did:pkh:eip155:x:0xabcdef0123456789abcdef0123456789abcdef01"],
  ])("refuses %s", (input) => {
    expect(() => normaliseUserDid(input)).toThrow(UnsupportedDidError);
  });
});

describe("addressOfDid / didForAddress / callerDid", () => {
  it("round-trips", () => {
    expect(addressOfDid(DID)).toBe(ADDR.toLowerCase());
    expect(didForAddress(ADDR)).toBe(DID);
  });
  it("builds the caller's DID from the bearer address, ignoring its chain", () => {
    expect(callerDid({ user: { address: ADDR } })).toBe(DID);
    expect(callerDid({})).toBeNull();
    expect(callerDid({ user: { address: "" } })).toBeNull();
  });
  it("refuses a non-pkh DID in addressOfDid", () => {
    expect(() => addressOfDid("did:key:z6Mk")).toThrow(UnsupportedDidError);
  });
});
