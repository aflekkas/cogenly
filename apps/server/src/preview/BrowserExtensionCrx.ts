// @effect-diagnostics nodeBuiltinImport:off - CRX verification is synchronous byte work on node:crypto.
/**
 * Chrome Web Store packages (CRX3): finding an extension ID in what a user or
 * agent typed, and verifying a downloaded package the way Chrome does before
 * anything in it is unpacked.
 *
 * A CRX3 file is `Cr24`, a little-endian version (3) and header length, a
 * `CrxFileHeader` protobuf, then the ZIP. Each proof in the header signs
 * `"CRX3 SignedData\0" + len(signed_header_data) + signed_header_data + zip`.
 * The signed header names the extension's ID, which is the first 16 bytes of
 * the SHA-256 of the developer's public key, so a valid developer proof ties
 * the ZIP to that ID. The Web Store adds its own publisher proof.
 */
import * as NodeCrypto from "node:crypto";

/** SHA-256 of the Chrome Web Store's publisher key, as Chromium's crx_verifier pins it. */
const WEB_STORE_PUBLISHER_KEY_HASH =
  "61f7f2a6bfcf74cd0bc1fe2497cc9b04254c658f79f2145392867ea8366367cf";

const CRX_MAGIC = "Cr24";
const SIGNATURE_CONTEXT = Buffer.from("CRX3 SignedData\x00", "latin1");
/** Chrome refuses headers this large; it bounds what an attacker can make us parse. */
const MAX_HEADER_BYTES = 1 << 20;

export class CrxError extends Error {
  override readonly name = "CrxError";
}

const EXTENSION_ID = /^[a-p]{32}$/;

export const isExtensionId = (value: string) => EXTENSION_ID.test(value);

/** Chrome's extension ID alphabet: each hex digit of the key hash becomes a letter a to p. */
export const extensionIdFromHash = (hash: Uint8Array) =>
  Array.from(hash.subarray(0, 16), (byte) =>
    String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15)),
  ).join("");

/** The ID Chrome gives an extension whose manifest carries this public key. */
export const extensionIdFromPublicKey = (publicKey: Uint8Array) =>
  extensionIdFromHash(NodeCrypto.createHash("sha256").update(publicKey).digest());

const WEB_STORE_HOSTS = new Set(["chromewebstore.google.com", "chrome.google.com"]);

/**
 * The extension ID in a bare ID or a Chrome Web Store link, such as
 * `https://chromewebstore.google.com/detail/name/<id>`. Anything else is null,
 * so only the Web Store can name what gets downloaded.
 */
export const webStoreExtensionId = (input: string): string | null => {
  const trimmed = input.trim();
  if (isExtensionId(trimmed)) return trimmed;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !WEB_STORE_HOSTS.has(url.hostname)) return null;
  if (url.hostname === "chrome.google.com" && !url.pathname.startsWith("/webstore/")) return null;
  const id = url.pathname.split("/").find((segment) => isExtensionId(segment));
  return id ?? null;
};

/** The Web Store download for an extension, as the version of Chrome that will run it. */
export const webStoreDownloadUrl = (extensionId: string, chromeVersion: string) => {
  const url = new URL("https://clients2.google.com/service/update2/crx");
  url.searchParams.set("response", "redirect");
  url.searchParams.set("prodversion", chromeVersion);
  url.searchParams.set("acceptformat", "crx3");
  url.searchParams.set("x", `id=${extensionId}&uc`);
  return url.toString();
};

interface ProtoField {
  readonly field: number;
  readonly bytes: Buffer;
}

/** The length-delimited fields of a protobuf message; varint fields are skipped. */
const protoFields = (message: Buffer): ProtoField[] => {
  const fields: ProtoField[] = [];
  let offset = 0;
  const varint = () => {
    let value = 0;
    for (let shift = 0; ; shift += 7) {
      if (offset >= message.length || shift > 35)
        throw new CrxError("The CRX header is malformed.");
      const byte = message[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return value;
    }
  };
  while (offset < message.length) {
    const tag = varint();
    const wireType = tag % 8;
    const field = Math.floor(tag / 8);
    if (wireType === 0) {
      varint();
    } else if (wireType === 2) {
      const length = varint();
      if (offset + length > message.length) throw new CrxError("The CRX header is malformed.");
      fields.push({ field, bytes: message.subarray(offset, offset + length) });
      offset += length;
    } else {
      throw new CrxError("The CRX header is malformed.");
    }
  }
  return fields;
};

const only = (fields: ReadonlyArray<ProtoField>, field: number) => {
  const matches = fields.filter((entry) => entry.field === field);
  return matches.length === 1 ? matches[0]!.bytes : null;
};

export interface VerifiedCrx {
  readonly extensionId: string;
  /** The developer's public key (DER SPKI), which keeps the ID when the extension loads unpacked. */
  readonly publicKey: Buffer;
  /** The ZIP payload, safe to unpack. */
  readonly archive: Buffer;
}

/**
 * Verifies a CRX3 package: every proof's signature checks out, one proof is
 * the developer key for the ID the header names, and, when `requirePublisher`,
 * one is the Chrome Web Store's. Throws CrxError otherwise.
 */
export const verifyCrx3 = (
  crx: Buffer,
  options: { readonly expectedId?: string; readonly requirePublisher: boolean },
): VerifiedCrx => {
  if (crx.length < 12 || crx.toString("latin1", 0, 4) !== CRX_MAGIC) {
    throw new CrxError("This is not a Chrome extension package (CRX).");
  }
  const version = crx.readUInt32LE(4);
  if (version !== 3) throw new CrxError(`CRX version ${version} is not supported; only CRX3 is.`);
  const headerLength = crx.readUInt32LE(8);
  if (headerLength > MAX_HEADER_BYTES || 12 + headerLength > crx.length) {
    throw new CrxError("The CRX header is malformed.");
  }
  const header = protoFields(crx.subarray(12, 12 + headerLength));
  const archive = crx.subarray(12 + headerLength);
  const signedHeaderData = only(header, 10000);
  if (!signedHeaderData) throw new CrxError("The CRX has no signed header.");
  const crxId = only(protoFields(signedHeaderData), 1);
  if (!crxId || crxId.length !== 16) throw new CrxError("The CRX does not name its extension.");
  const extensionId = extensionIdFromHash(crxId);
  if (options.expectedId !== undefined && extensionId !== options.expectedId) {
    throw new CrxError(`The package is for extension ${extensionId}, not ${options.expectedId}.`);
  }

  const length = Buffer.alloc(4);
  length.writeUInt32LE(signedHeaderData.length);
  const signed = Buffer.concat([SIGNATURE_CONTEXT, length, signedHeaderData, archive]);
  let publicKey: Buffer | undefined;
  let publisherSigned = false;
  const proofs = header.filter((entry) => entry.field === 2 || entry.field === 3);
  if (proofs.length === 0) throw new CrxError("The CRX is not signed.");
  for (const proof of proofs) {
    const fields = protoFields(proof.bytes);
    const key = only(fields, 1);
    const signature = only(fields, 2);
    if (!key || !signature) throw new CrxError("The CRX has an incomplete signature.");
    let valid = false;
    try {
      const keyObject = NodeCrypto.createPublicKey({ key, format: "der", type: "spki" });
      const expectedType = proof.field === 2 ? "rsa" : "ec";
      valid =
        keyObject.asymmetricKeyType === expectedType &&
        NodeCrypto.verify("sha256", signed, keyObject, signature);
    } catch {
      valid = false;
    }
    if (!valid) throw new CrxError("The CRX signature does not verify. Nothing was installed.");
    const hash = NodeCrypto.createHash("sha256").update(key).digest();
    if (hash.subarray(0, 16).equals(crxId)) publicKey = key;
    if (hash.toString("hex") === WEB_STORE_PUBLISHER_KEY_HASH) publisherSigned = true;
  }
  if (!publicKey) throw new CrxError("The CRX is not signed by its developer key.");
  if (options.requirePublisher && !publisherSigned) {
    throw new CrxError("The CRX is not signed by the Chrome Web Store.");
  }
  return { extensionId, publicKey, archive };
};
