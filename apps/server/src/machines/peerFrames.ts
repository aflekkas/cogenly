/** Authenticate the whole RPC envelope before it reaches the RPC state machine. */
import { PEER_METHODS, PeerAuthenticatedFrame } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as RpcSerialization from "effect/rpc/RpcSerialization";

import { peerDigest, peerMac, verifyPeerMac } from "./peerCrypto.ts";

const decodeFrame = Schema.decodeUnknownSync(PeerAuthenticatedFrame);
const decodeEnvelope = Schema.decodeUnknownSync(
  Schema.Struct({
    _tag: Schema.String,
    id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
    requestId: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
    tag: Schema.optionalKey(Schema.String),
  }),
);

export class PeerFrameCodec {
  readonly failed = Deferred.makeUnsafe<void>();
  #key: Buffer | undefined;
  #connectionId = "";
  #sent = 0;
  #received = 0;
  #poisoned = false;
  readonly #bootstrap = new Map<string | number, string>();
  readonly #seen = new Set<string>();

  readonly role: "hub" | "spoke";
  constructor(role: "hub" | "spoke") {
    this.role = role;
  }

  establish(connectionId: string, key: Buffer) {
    if (this.#key !== undefined || this.#poisoned)
      throw new Error("Peer session already established or rejected");
    this.#connectionId = connectionId;
    this.#key = key;
  }

  #reject(): never {
    this.#poisoned = true;
    Deferred.doneUnsafe(this.failed, Effect.void);
    throw new Error("Peer frame authentication failed");
  }

  #plain(message: unknown, outbound: boolean): boolean {
    const envelope = decodeEnvelope(message);
    const requesting = this.role === "spoke" ? outbound : !outbound;
    if (
      requesting &&
      envelope._tag === "Request" &&
      this.#key === undefined &&
      envelope.id !== undefined &&
      (envelope.tag === PEER_METHODS.challenge || envelope.tag === PEER_METHODS.hello) &&
      !this.#seen.has(envelope.tag)
    ) {
      if (envelope.tag === PEER_METHODS.hello && !this.#seen.has(PEER_METHODS.challenge))
        return false;
      this.#seen.add(envelope.tag);
      this.#bootstrap.set(envelope.id, envelope.tag);
      return true;
    }
    if (
      !requesting &&
      envelope._tag === "Exit" &&
      envelope.requestId !== undefined &&
      this.#bootstrap.has(envelope.requestId)
    ) {
      this.#bootstrap.delete(envelope.requestId);
      return true;
    }
    // The RPC transport's keepalive has no domain authority. After hello it too needs a MAC.
    return this.#key === undefined && (envelope._tag === "Ping" || envelope._tag === "Pong");
  }

  readonly serialization: RpcSerialization.RpcSerialization["Service"] = {
    ...RpcSerialization.json,
    makeUnsafe: () => ({
      encode: (message) => {
        if (this.#poisoned) return undefined;
        const payload = JSON.stringify(message);
        if (!Array.isArray(message) && this.#plain(message, true)) return payload;
        if (this.#key === undefined || !Number.isSafeInteger(this.#sent + 1)) return this.#reject();
        const fields = {
          connectionId: this.#connectionId,
          direction: this.role === "hub" ? ("hub-to-spoke" as const) : ("spoke-to-hub" as const),
          sequence: ++this.#sent,
          method: Array.isArray(message)
            ? "batch"
            : (decodeEnvelope(message).tag ?? decodeEnvelope(message)._tag),
          payloadHash: peerDigest(payload),
        };
        const { payloadHash: _, ...header } = fields;
        return JSON.stringify({ ...header, payload, mac: peerMac(this.#key, fields) });
      },
      decode: (bytes) => {
        try {
          if (this.#poisoned) return this.#reject();
          const message: unknown = JSON.parse(
            typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes),
          );
          if (this.#key === undefined) {
            if (!this.#plain(message, false)) return this.#reject();
            return [message];
          }
          const frame = decodeFrame(message);
          const { payload, mac, ...header } = frame;
          if (
            frame.connectionId !== this.#connectionId ||
            frame.direction !== (this.role === "hub" ? "spoke-to-hub" : "hub-to-spoke") ||
            !Number.isSafeInteger(frame.sequence) ||
            frame.sequence !== this.#received + 1 ||
            !verifyPeerMac(this.#key, { ...header, payloadHash: peerDigest(payload) }, mac)
          )
            return this.#reject();
          const decoded: unknown = JSON.parse(payload);
          const method = Array.isArray(decoded)
            ? "batch"
            : (decodeEnvelope(decoded).tag ?? decodeEnvelope(decoded)._tag);
          if (method !== frame.method) return this.#reject();
          this.#received = frame.sequence;
          return Array.isArray(decoded) ? decoded : [decoded];
        } catch {
          return this.#reject();
        }
      },
    }),
  };
}
