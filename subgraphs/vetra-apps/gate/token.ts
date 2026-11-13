import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Gate tokens (releases phase 3 slice 5, G2): `vgt_` + 32 random bytes in
 * hex. The prefix makes a leaked token findable by secret scanners. Only the
 * sha256 (and the transit ciphertext, G1) is stored.
 */
export const GATE_TOKEN_PREFIX = "vgt_";
const SHAPE = /^vgt_[0-9a-f]{64}$/;

export function newGateToken(): string {
  return `${GATE_TOKEN_PREFIX}${randomBytes(32).toString("hex")}`;
}

/** sha256 (hex) of a token: what instance_gate_tokens keeps and the route looks up. */
export function hashGateToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function isGateTokenShape(token: string): boolean {
  return SHAPE.test(token);
}

/** Constant-time equality of two sha256 hex digests; false for anything else. */
export function sameGateHash(a: string, b: string | null | undefined): boolean {
  if (typeof b !== "string") return false;
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === 32 && y.length === 32 && timingSafeEqual(x, y);
}
