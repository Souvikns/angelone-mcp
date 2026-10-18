import { expect, test } from "bun:test";
import { totp } from "./totp.ts";

// RFC 6238 Appendix B vectors (SHA-1, secret "12345678901234567890"), truncated to 6 digits.
const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

test.each([
  [59, "287082"],
  [1111111109, "081804"],
  [1234567890, "005924"],
  [2000000000, "279037"],
])("totp at %d", (seconds, expected) => {
  expect(totp(SECRET, seconds * 1000)).toBe(expected);
});
