import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";

import { AuthPeerScope, EnvironmentAuthorizationError } from "./auth.ts";
import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ExecutionEnvironmentPlatformOs, MachineRole } from "./environment.ts";
import { ServerProvider, ServerProviderAuthStatus } from "./server.ts";

/**
 * Machines are the Cogenly servers one user owns, paired so they can share
 * state. One always-on machine is the hub; others dial out to it.
 * See docs/internals/machines.md.
 */

/**
 * How a machine is presented, relative to the server answering: itself is
 * "this-computer" unless it is a cloud server; another personal machine is
 * "other-computer". Clients that know they run elsewhere may relabel.
 */
export const MachineKind = Schema.Literals(["this-computer", "cloud-server", "other-computer"]);
export type MachineKind = typeof MachineKind.Type;

/** The icon shape: detected, or derived from the environment icon setting. */
export const MachineHardware = Schema.Literals(["laptop", "desktop", "server"]);
export type MachineHardware = typeof MachineHardware.Type;

/**
 * Where a machine sits relative to the answering server: itself, the hub it
 * dials, one of its spokes, or another spoke of the same hub.
 */
export const MachineRelation = Schema.Literals(["this", "hub", "spoke", "peer"]);
export type MachineRelation = typeof MachineRelation.Type;

export const MachineProvider = Schema.Struct({
  instanceId: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  auth: ServerProviderAuthStatus,
  installed: Schema.optionalKey(Schema.Boolean),
  canAuthenticate: Schema.optionalKey(Schema.Boolean),
});
export type MachineProvider = typeof MachineProvider.Type;

/** What a server says about itself to its peers. */
export const MachineSelfReport = Schema.Struct({
  environmentId: EnvironmentId,
  name: TrimmedNonEmptyString,
  role: MachineRole,
  hardware: MachineHardware,
  platform: ExecutionEnvironmentPlatformOs,
  serverVersion: TrimmedNonEmptyString,
  providers: Schema.Array(MachineProvider),
});
export type MachineSelfReport = typeof MachineSelfReport.Type;

export const MachineInfo = Schema.Struct({
  environmentId: EnvironmentId,
  name: TrimmedNonEmptyString,
  kind: MachineKind,
  hardware: MachineHardware,
  platform: ExecutionEnvironmentPlatformOs,
  relation: MachineRelation,
  online: Schema.Boolean,
  /** Null for this machine and for a peer never seen since pairing. */
  lastSeenAt: Schema.NullOr(Schema.DateTimeUtc),
  pairedAt: Schema.NullOr(Schema.DateTimeUtc),
  /** "revoked" when the other side unpaired; unpair here to clear it. */
  pairing: Schema.Literals(["self", "paired", "revoked"]),
  /** Empty when the machine has not reported them. */
  providers: Schema.Array(MachineProvider),
});
export type MachineInfo = typeof MachineInfo.Type;

/** This server's place in the pairing: alone, the hub, or a spoke of one hub. */
export const MachineLinkState = Schema.Union([
  Schema.TaggedStruct("standalone", {}),
  Schema.TaggedStruct("hub", { spokes: Schema.Number }),
  Schema.TaggedStruct("spoke", {
    hubEnvironmentId: EnvironmentId,
    status: Schema.Literals(["connecting", "online", "offline", "revoked", "untrusted"]),
    /** The route of the current or last connection. */
    route: Schema.NullOr(TrimmedNonEmptyString),
    lastError: Schema.NullOr(TrimmedNonEmptyString),
  }),
]);
export type MachineLinkState = typeof MachineLinkState.Type;

export const MachineCatalogInput = Schema.Struct({ machine: EnvironmentId });
export const MachineCatalogResult = Schema.Struct({ providers: Schema.Array(ServerProvider) });

export const MachineListResult = Schema.Struct({
  machines: Schema.Array(MachineInfo),
  link: MachineLinkState,
});
export type MachineListResult = typeof MachineListResult.Type;

/** Null resets a field to what the server detects. */
export const MachineUpdateInput = Schema.Struct({
  name: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(80)))),
  role: Schema.optionalKey(Schema.NullOr(MachineRole)),
});
export type MachineUpdateInput = typeof MachineUpdateInput.Type;

/** What a hub needs to bind a peer grant to the machine that will redeem it. */
export const MachinePeerIdentity = Schema.Struct({
  environmentId: EnvironmentId,
  name: TrimmedNonEmptyString,
  /** RFC 7638 thumbprint of the key the machine signs peer requests with. */
  keyThumbprint: TrimmedNonEmptyString,
});
export type MachinePeerIdentity = typeof MachinePeerIdentity.Type;

export const MachineCreatePeerGrantInput = Schema.Struct({
  /** The intended spoke must prepare its proof key before the hub issues a grant. */
  spokeKeyThumbprint: TrimmedNonEmptyString,
  spokeName: Schema.optionalKey(TrimmedNonEmptyString),
});
export type MachineCreatePeerGrantInput = typeof MachineCreatePeerGrantInput.Type;

/**
 * Everything a spoke needs to join: the one-time grant, plus the hub identity
 * it pins. The CLI prints this as one `cogenly-join:` code.
 */
export const MachineJoinCode = Schema.Struct({
  grant: TrimmedNonEmptyString,
  hubEnvironmentId: EnvironmentId,
  hubName: TrimmedNonEmptyString,
  /** SPKI PEM of the hub's Ed25519 environment key. */
  hubPublicKey: TrimmedNonEmptyString,
  /** Advertised addresses, used only when the joiner supplies no explicit routes. */
  routes: Schema.Array(TrimmedNonEmptyString),
  expiresAt: Schema.DateTimeUtc,
});
export type MachineJoinCode = typeof MachineJoinCode.Type;

export const MachineJoinHubInput = Schema.Struct({
  /** Explicit routes in order; when present, replace advertised alternatives. */
  hubUrls: Schema.Array(TrimmedNonEmptyString),
  code: MachineJoinCode,
});
export type MachineJoinHubInput = typeof MachineJoinHubInput.Type;

export const MachineUnpairInput = Schema.Struct({ environmentId: EnvironmentId });
export type MachineUnpairInput = typeof MachineUnpairInput.Type;

export const MachineUnpairResult = Schema.Struct({ unpaired: Schema.Boolean });
export type MachineUnpairResult = typeof MachineUnpairResult.Type;

export class MachineError extends Schema.TaggedError<MachineError>()("MachineError", {
  operation: Schema.Literals(["list", "update", "prepare-join", "create-grant", "join", "unpair"]),
  reason: Schema.Literals([
    "already-paired",
    "hub-is-spoke",
    "spoke-is-hub",
    "not-paired",
    "hub-unreachable",
    "grant-rejected",
    "hub-identity-mismatch",
    "invalid-input",
    "storage",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "already-paired":
        return "This machine is already paired with a hub. Unpair it first.";
      case "hub-is-spoke":
        return "This machine joined a hub, so it cannot be a hub too.";
      case "spoke-is-hub":
        return "This machine has machines paired to it, so it cannot join another hub.";
      case "not-paired":
        return "That machine is not paired with this one.";
      case "hub-unreachable":
        return "The hub could not be reached on any of its addresses.";
      case "grant-rejected":
        return "The hub refused the pairing grant. It may be used, expired, or for another machine.";
      case "hub-identity-mismatch":
        return "The hub did not prove it is the machine the grant came from.";
      case "invalid-input":
        return "The pairing details are invalid.";
      case "storage":
        return `Could not ${this.operation} machines.`;
    }
  }
}
export const isMachineError = Schema.is(MachineError);

// ---------------------------------------------------------------------------
// The `/peer` protocol, spoken only between paired servers.
// ---------------------------------------------------------------------------

/** HTTP paths a spoke uses before the socket opens. */
export const PEER_IDENTITY_PATH = "/peer/identity";
export const PEER_JOIN_PATH = "/peer/join";
export const PEER_TICKET_PATH = "/peer/ticket";
export const PEER_SOCKET_PATH = "/peer";

/** A secret-free challenge, verified before sending a grant or peer token. */
export const PeerIdentityRequest = Schema.Struct({
  spokeEnvironmentId: EnvironmentId,
  nonce: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
});
export type PeerIdentityRequest = typeof PeerIdentityRequest.Type;
export const PeerIdentityResult = Schema.Struct({
  hubEnvironmentId: EnvironmentId,
  signature: TrimmedNonEmptyString,
});

export const PeerProofKey = Schema.Struct({
  kty: Schema.Literal("EC"),
  crv: Schema.Literal("P-256"),
  x: TrimmedNonEmptyString,
  y: TrimmedNonEmptyString,
});

export const PEER_PROTOCOL_VERSION = 2;

export const PeerJoinRequest = Schema.Struct({
  proofKey: PeerProofKey,
  proof: TrimmedNonEmptyString,
  grant: TrimmedNonEmptyString,
  /** Random, single-use; covered by the join transcript. */
  nonce: TrimmedNonEmptyString,
  spoke: MachineSelfReport,
});
export type PeerJoinRequest = typeof PeerJoinRequest.Type;

export const PeerJoinResult = Schema.Struct({
  accessToken: TrimmedNonEmptyString,
  expiresAt: Schema.DateTimeUtc,
  hubEnvironmentId: EnvironmentId,
  scopes: Schema.Array(AuthPeerScope),
  /** Ed25519 signature over the canonical, domain-separated join transcript. */
  signature: TrimmedNonEmptyString,
  hub: MachineSelfReport,
});
export type PeerJoinResult = typeof PeerJoinResult.Type;

export const PeerTicketResult = Schema.Struct({ ticket: TrimmedNonEmptyString });
export type PeerTicketResult = typeof PeerTicketResult.Type;

/**
 * A typed request one paired server sends the other. Feature code (sync,
 * delegation) defines channels and registers handlers on the receiving side;
 * the link carries them as JSON through `peer.call` or the inbox stream.
 */
export interface PeerChannel<
  Payload extends Schema.Top = Schema.Top,
  Success extends Schema.Top = Schema.Top,
  Failure extends Schema.Top = Schema.Top,
> {
  readonly name: string;
  /** The scope the calling machine's link must hold. */
  readonly scope: AuthPeerScope;
  readonly payload: Payload;
  readonly success: Success;
  readonly error: Failure;
}

export const makePeerChannel = <
  Payload extends Schema.Top,
  Success extends Schema.Top,
  Failure extends Schema.Top = Schema.Never,
>(channel: {
  readonly name: string;
  readonly scope: AuthPeerScope;
  readonly payload: Payload;
  readonly success: Success;
  readonly error?: Failure;
}): PeerChannel<Payload, Success, Failure> => ({
  ...channel,
  error: (channel.error ?? Schema.Never) as Failure,
});

export class PeerCallError extends Schema.TaggedError<PeerCallError>()("PeerCallError", {
  channel: Schema.String,
  reason: Schema.Literals([
    "offline",
    "unknown-channel",
    "forbidden",
    "invalid-payload",
    "handler-failed",
    "disconnected",
  ]),
  /** The channel's own error, encoded with its error schema. */
  error: Schema.optional(Schema.Json),
}) {
  override get message(): string {
    return `Peer call ${this.channel} failed (${this.reason}).`;
  }
}

export class PeerProtocolError extends Schema.TaggedError<PeerProtocolError>()(
  "PeerProtocolError",
  {
    reason: Schema.Literals([
      "hello-required",
      "machine-mismatch",
      "not-paired",
      "version-mismatch",
      "invalid-proof",
    ]),
  },
) {
  override get message(): string {
    if (this.reason === "version-mismatch")
      return "Incompatible peer protocol version; upgrade both machines.";
    if (this.reason === "invalid-proof") return "Peer connection proof is invalid.";
    return this.reason === "hello-required"
      ? "Say peer.hello before anything else."
      : this.reason === "machine-mismatch"
        ? "This credential belongs to a different machine."
        : "This machine is no longer paired.";
  }
}

/** A fresh challenge belongs to exactly one socket. It grants no authority. */
export const PeerChallengeResult = Schema.Struct({
  version: Schema.Number,
  connectionId: TrimmedNonEmptyString,
  hubEphemeralKey: TrimmedNonEmptyString,
});
export type PeerChallengeResult = typeof PeerChallengeResult.Type;

export const PeerHelloInput = Schema.Struct({
  version: Schema.Number,
  nonce: TrimmedNonEmptyString,
  spoke: MachineSelfReport,
  accessToken: TrimmedNonEmptyString,
  proofKey: PeerProofKey,
  spokeEphemeralKey: TrimmedNonEmptyString,
  proof: TrimmedNonEmptyString,
});
export type PeerHelloInput = typeof PeerHelloInput.Type;

export const PeerHelloResult = Schema.Struct({
  hubEnvironmentId: EnvironmentId,
  signature: TrimmedNonEmptyString,
  hub: MachineSelfReport,
  scopes: Schema.Array(AuthPeerScope),
  expiresAt: Schema.DateTimeUtc,
});
export type PeerHelloResult = typeof PeerHelloResult.Type;

/** The serialized RPC envelope is hashed once and authenticated before RPC decoding. */
export const PeerAuthenticatedFrame = Schema.Struct({
  connectionId: TrimmedNonEmptyString,
  direction: Schema.Literals(["spoke-to-hub", "hub-to-spoke"]),
  sequence: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  method: TrimmedNonEmptyString,
  payload: Schema.String,
  mac: TrimmedNonEmptyString,
});

/** Messages the hub pushes down the spoke's open socket. */
export const PeerPush = Schema.Union([
  Schema.TaggedStruct("Request", {
    id: TrimmedNonEmptyString,
    channel: TrimmedNonEmptyString,
    payload: Schema.Json,
  }),
  Schema.TaggedStruct("Machines", { machines: Schema.Array(MachineInfo) }),
  Schema.TaggedStruct("Unpaired", {}),
]);
export type PeerPush = typeof PeerPush.Type;

export const PeerReplyInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  result: Schema.Union([
    Schema.TaggedStruct("Success", { value: Schema.Json }),
    Schema.TaggedStruct("Failure", { error: PeerCallError }),
  ]),
});
export type PeerReplyInput = typeof PeerReplyInput.Type;

export const PeerCallInput = Schema.Struct({
  channel: TrimmedNonEmptyString,
  payload: Schema.Json,
});
export type PeerCallInput = typeof PeerCallInput.Type;

export const PEER_METHODS = {
  challenge: "peer.challenge",
  hello: "peer.hello",
  ping: "peer.ping",
  machines: "peer.machines",
  inbox: "peer.inbox",
  reply: "peer.reply",
  call: "peer.call",
  leave: "peer.leave",
} as const;

/** Authorizes every `/peer` call against the connection's peer scopes. */
export class PeerScopeAuthorization extends RpcMiddleware.Service<PeerScopeAuthorization>()(
  "cogenly/contracts/PeerScopeAuthorization",
  { error: EnvironmentAuthorizationError },
) {}

const peerErrors = Schema.Union([PeerProtocolError, EnvironmentAuthorizationError]);

export const PeerRpcGroup = RpcGroup.make(
  Rpc.make(PEER_METHODS.challenge, {
    payload: Schema.Struct({ version: Schema.Number }),
    success: PeerChallengeResult,
    error: peerErrors,
  }),
  Rpc.make(PEER_METHODS.hello, {
    payload: PeerHelloInput,
    success: PeerHelloResult,
    error: peerErrors,
  }),
  Rpc.make(PEER_METHODS.ping, {
    payload: Schema.Struct({ spoke: Schema.optionalKey(MachineSelfReport) }),
    success: Schema.Struct({}),
    error: peerErrors,
  }),
  Rpc.make(PEER_METHODS.machines, {
    payload: Schema.Struct({}),
    success: Schema.Array(MachineInfo),
    error: peerErrors,
  }),
  Rpc.make(PEER_METHODS.inbox, {
    payload: Schema.Struct({}),
    success: PeerPush,
    error: peerErrors,
    stream: true,
  }),
  Rpc.make(PEER_METHODS.reply, {
    payload: PeerReplyInput,
    success: Schema.Struct({}),
    error: peerErrors,
  }),
  Rpc.make(PEER_METHODS.call, {
    payload: PeerCallInput,
    success: Schema.Json,
    error: Schema.Union([PeerCallError, PeerProtocolError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(PEER_METHODS.leave, {
    payload: Schema.Struct({}),
    success: Schema.Struct({}),
    error: peerErrors,
  }),
).middleware(PeerScopeAuthorization);
