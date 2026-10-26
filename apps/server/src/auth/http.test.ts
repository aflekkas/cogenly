import { describe, expect, it } from "@effect/vitest";

import { isSecureRequest } from "./http.ts";

describe("isSecureRequest", () => {
  it("trusts X-Forwarded-Proto https only from a loopback TLS terminator", () => {
    expect(
      isSecureRequest({ headers: { "x-forwarded-proto": "https" }, remoteAddress: "127.0.0.1" }),
    ).toBe(true);
    expect(
      isSecureRequest({
        headers: { "x-forwarded-proto": "https" },
        remoteAddress: "::ffff:127.0.0.1",
      }),
    ).toBe(true);
    // A remote client spoofing the header does not get Secure cookies trusted.
    expect(
      isSecureRequest({ headers: { "x-forwarded-proto": "https" }, remoteAddress: "203.0.113.9" }),
    ).toBe(false);
  });

  it("keeps loopback http dev non-secure", () => {
    expect(isSecureRequest({ headers: {}, remoteAddress: "127.0.0.1" })).toBe(false);
    expect(
      isSecureRequest({ headers: { "x-forwarded-proto": "http" }, remoteAddress: "127.0.0.1" }),
    ).toBe(false);
    expect(isSecureRequest({ headers: { "x-forwarded-proto": "https" } })).toBe(false);
  });
});
