/** RFC 6238 TOTP (HMAC-SHA1, 30-second period) over a base32 secret. Pure. */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- node:crypto is the TOTP primitive.
import * as NodeCrypto from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

const decodeBase32 = (input: string): Buffer => {
  const clean = input.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const bytes: Array<number> = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new Error("TOTP secret is not base32.");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
};

const hotp = (secret: Buffer, counter: number, digits = 6): string => {
  const message = Buffer.alloc(8);
  message.writeBigInt64BE(BigInt(counter));
  const digest = NodeCrypto.createHmac("sha1", secret).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const code =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(code % 10 ** digits).padStart(digits, "0");
};

export const totp = (
  base32Secret: string,
  options: {
    readonly atMs?: number;
    readonly digits?: number;
    readonly periodSeconds?: number;
  } = {},
): string => {
  const period = options.periodSeconds ?? 30;
  // @effect-diagnostics-next-line globalDate:off -- Pure function; callers pass atMs in tests, Date.now is only the default.
  const counter = Math.floor((options.atMs ?? Date.now()) / 1000 / period);
  return hotp(decodeBase32(base32Secret), counter, options.digits ?? 6);
};
