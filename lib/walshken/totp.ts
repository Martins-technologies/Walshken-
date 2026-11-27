import { createHmac, timingSafeEqual } from "node:crypto";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function authenticatorSetupKey(bytes: Buffer): string {
  let bits = 0;
  let remaining = 0;
  let output = "";
  for (const byte of bytes) {
    remaining = (remaining << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += alphabet[(remaining >>> bits) & 31];
    }
  }
  return bits ? output + alphabet[(remaining << (5 - bits)) & 31] : output;
}

export function matchingAuthenticatorStep(secret: Buffer, code: string): number | undefined {
  if (!/^\d{6}$/.test(code)) return;
  const current = Math.floor(Date.now() / 30_000);
  const submitted = Buffer.from(code);
  for (const step of [current, current - 1, current + 1]) {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(step));
    const hashed = createHmac("sha1", secret).update(counter).digest();
    const offset = hashed[hashed.length - 1] & 15;
    const expected = String((hashed.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
    if (timingSafeEqual(Buffer.from(expected), submitted)) return step;
  }
}
