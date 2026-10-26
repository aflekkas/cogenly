import { describe, expect, it } from "@effect/vitest";

import { vaultFillOriginDenial } from "./VaultPolicy.ts";

describe("vaultFillOriginDenial", () => {
  it("allows https pages", () => {
    expect(vaultFillOriginDenial("https://github.com/login", [])).toBeNull();
    expect(vaultFillOriginDenial("https://evil.example/phish", ["github.com"])).toBeNull();
  });

  it("refuses plain http on non-loopback hosts", () => {
    expect(vaultFillOriginDenial("http://github.com/login", ["github.com"])).toBe("requires-https");
    expect(vaultFillOriginDenial("http://192.168.1.10/login", [])).toBe("requires-https");
  });

  it("allows loopback http only when the item lists that origin with its scheme", () => {
    expect(
      vaultFillOriginDenial("http://localhost:3000/login", ["http://localhost:3000"]),
    ).toBeNull();
    expect(vaultFillOriginDenial("http://127.0.0.1:8080/", ["http://127.0.0.1:8080"])).toBeNull();
    // A bare host entry, a different port, or another loopback spelling does not opt in.
    expect(vaultFillOriginDenial("http://localhost:3000/login", ["localhost"])).toBe(
      "loopback-not-listed",
    );
    expect(vaultFillOriginDenial("http://localhost:3000/login", ["http://localhost:4000"])).toBe(
      "loopback-not-listed",
    );
    expect(vaultFillOriginDenial("http://localhost:3000/login", ["https://localhost:3000"])).toBe(
      "loopback-not-listed",
    );
  });

  it("refuses non-http schemes and bad URLs", () => {
    expect(vaultFillOriginDenial("ftp://localhost/file", ["ftp://localhost"])).toBe(
      "requires-https",
    );
    expect(vaultFillOriginDenial("not a url", [])).toBe("invalid-url");
  });
});
