// @effect-diagnostics nodeBuiltinImport:off - Builds signed CRX fixtures with real keys.
import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";

import {
  extensionIdFromPublicKey,
  verifyCrx3,
  webStoreDownloadUrl,
  webStoreExtensionId,
} from "./BrowserExtensionCrx.ts";

const varint = (value: number) => {
  const bytes: number[] = [];
  while (value > 0x7f) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value);
  return Buffer.from(bytes);
};
const field = (number: number, bytes: Buffer) =>
  Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);

/** Builds a CRX3 the way the Web Store does, signed by each of `keys`. */
const buildCrx3 = (
  archive: Buffer,
  developer: NodeCrypto.KeyPairKeyObjectResult,
  options: {
    readonly signers?: ReadonlyArray<NodeCrypto.KeyPairKeyObjectResult>;
    readonly tamper?: boolean;
    /** Names another key's ID in the signed header. */
    readonly claimFor?: NodeCrypto.KeyPairKeyObjectResult;
  } = {},
) => {
  const developerKey = developer.publicKey.export({ format: "der", type: "spki" });
  const claimedKey = (options.claimFor ?? developer).publicKey.export({
    format: "der",
    type: "spki",
  });
  const crxId = NodeCrypto.createHash("sha256").update(claimedKey).digest().subarray(0, 16);
  const signedHeaderData = field(1, crxId);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(signedHeaderData.length);
  const message = Buffer.concat([
    Buffer.from("CRX3 SignedData\x00", "latin1"),
    length,
    signedHeaderData,
    archive,
  ]);
  const proofs = [developer, ...(options.signers ?? [])].map((pair) => {
    const key = pair.publicKey.export({ format: "der", type: "spki" });
    const signature = NodeCrypto.sign("sha256", message, pair.privateKey);
    return field(
      pair.publicKey.asymmetricKeyType === "rsa" ? 2 : 3,
      Buffer.concat([field(1, key), field(2, signature)]),
    );
  });
  const header = Buffer.concat([...proofs, field(10000, signedHeaderData)]);
  const prefix = Buffer.alloc(12);
  prefix.write("Cr24", 0, "latin1");
  prefix.writeUInt32LE(3, 4);
  prefix.writeUInt32LE(header.length, 8);
  const payload = options.tamper ? Buffer.concat([archive, Buffer.from("x")]) : archive;
  return {
    crx: Buffer.concat([prefix, header, payload]),
    id: extensionIdFromPublicKey(developerKey),
  };
};

const rsa = () => NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const archive = Buffer.from("PK\x05\x06" + "\0".repeat(18), "latin1");

describe("webStoreExtensionId", () => {
  const id = "ddkjiahejlhfcafbddmgiahcphecmpfh";
  it("reads a bare ID and both Web Store link shapes", () => {
    expect(webStoreExtensionId(id)).toBe(id);
    expect(
      webStoreExtensionId(
        `https://chromewebstore.google.com/detail/ublock-origin-lite/${id}?hl=en`,
      ),
    ).toBe(id);
    expect(webStoreExtensionId(`https://chrome.google.com/webstore/detail/x/${id}`)).toBe(id);
  });
  it("refuses anything that is not the Web Store", () => {
    expect(webStoreExtensionId(`https://example.com/detail/x/${id}`)).toBeNull();
    expect(webStoreExtensionId(`http://chromewebstore.google.com/detail/x/${id}`)).toBeNull();
    expect(webStoreExtensionId(`https://chrome.google.com/other/${id}`)).toBeNull();
    expect(webStoreExtensionId("not an id")).toBeNull();
  });
  it("asks the Web Store for a CRX3 for that Chrome", () => {
    const url = new URL(webStoreDownloadUrl(id, "154.0.0.0"));
    expect(url.hostname).toBe("clients2.google.com");
    expect(url.searchParams.get("x")).toBe(`id=${id}&uc`);
    expect(url.searchParams.get("prodversion")).toBe("154.0.0.0");
  });
});

describe("verifyCrx3", () => {
  it("accepts a package its developer key signed, and returns the ID and archive", () => {
    const developer = rsa();
    const { crx, id } = buildCrx3(archive, developer);
    const verified = verifyCrx3(crx, { expectedId: id, requirePublisher: false });
    expect(verified.extensionId).toBe(id);
    expect(verified.archive.equals(archive)).toBe(true);
    expect(extensionIdFromPublicKey(verified.publicKey)).toBe(id);
  });

  it("accepts ECDSA proofs alongside RSA", () => {
    const ec = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const { crx, id } = buildCrx3(archive, rsa(), { signers: [ec] });
    expect(verifyCrx3(crx, { requirePublisher: false }).extensionId).toBe(id);
  });

  it("rejects a changed archive", () => {
    const { crx } = buildCrx3(archive, rsa(), { tamper: true });
    expect(() => verifyCrx3(crx, { requirePublisher: false })).toThrow(/does not verify/);
  });

  it("rejects a package for another extension", () => {
    const { crx } = buildCrx3(archive, rsa());
    expect(() => verifyCrx3(crx, { expectedId: "a".repeat(32), requirePublisher: false })).toThrow(
      /not aaaa/,
    );
  });

  it("rejects a package the Web Store did not sign when its signature is required", () => {
    const { crx } = buildCrx3(archive, rsa(), { signers: [rsa()] });
    expect(() => verifyCrx3(crx, { requirePublisher: true })).toThrow(/Chrome Web Store/);
  });

  it("rejects a package that claims an ID its signers do not hold", () => {
    const { crx } = buildCrx3(archive, rsa(), { claimFor: rsa() });
    expect(() => verifyCrx3(crx, { requirePublisher: false })).toThrow(/developer key/);
  });

  it("rejects a file that is not a CRX", () => {
    const { crx } = buildCrx3(archive, rsa());
    const forged = Buffer.from(crx);
    forged.write("PK\x03\x04", 0, "latin1");
    expect(() => verifyCrx3(forged, { requirePublisher: false })).toThrow(/not a Chrome extension/);
  });

  it("rejects CRX2 and truncated headers", () => {
    const { crx } = buildCrx3(archive, rsa());
    const crx2 = Buffer.from(crx);
    crx2.writeUInt32LE(2, 4);
    expect(() => verifyCrx3(crx2, { requirePublisher: false })).toThrow(/only CRX3/);
    expect(() => verifyCrx3(crx.subarray(0, 40), { requirePublisher: false })).toThrow(/malformed/);
  });
});
