# Machine peer links

Machine pairing connects servers owned by the same user. A hub accepts spokes;
spokes dial out so a laptop needs no inbound address or exposed port. The same
socket carries requests in either direction. A machine may join one hub or have
spokes, never both. Client connection catalogs remain independent of this link.

The link carries machine presence, self reports, and registered typed channels.
[Shared state](./sync.md) uses those channels for project, agent and schedule
configuration. Settings, threads, files and credentials do not replicate yet,
and the link does not launch work remotely. Provider reports contain status,
never login tokens.

## Pairing establishes a separate audience

An admin-connected client calls `machines.prepareJoin` on the spoke, passes its
key thumbprint to `machines.createPeerGrant` on the hub, and hands the resulting
join code to `machines.joinHub` on the spoke. Only the spoke server redeems it.
The hub grant expires after ten minutes and can be spent once. The CLI follows
the same prepare → grant → join exchange: grants always bind the intended spoke
key before issuance, and old unbound grants are refused.
Transfer the code privately. The CLI reads it through a hidden prompt or
`--code-stdin`, never a positional argument or a suggested command line.

The hub issues a one-year DPoP session with subject `peer`, holding
`sync:replicate` and `peer:delegate`. Neither scope belongs to legacy, standard,
or administrative client grants. Access-management authority is required to
create a peer grant, join, or unpair; it authorizes this specific delegation of
peer rights without granting those rights to the client itself.

[EnvironmentAuth](../../apps/server/src/auth/EnvironmentAuth.ts) rejects this
subject on ordinary HTTP, `/ws`, and `/mcp`, and rejects peer grants on client
bootstrap paths. A peer token cannot read files, open terminals, change settings,
or call client RPCs. A stolen token alone cannot authenticate without its DPoP
private key. Theft of both allows impersonating that paired machine within its
peer channels until revocation or expiry. Future sync and delegation handlers
must enforce their own domain limits; these scopes do not make arbitrary RPC
forwarding safe.

The spoke pins the hub environment ID and Ed25519 public key from the admin's
join code. Before join and each reconnect, a secret-free `/peer/identity`
challenge checks that pin before sending any grant or peer token. Identity,
join and hello use separate signature domains. Join and hello bind the hub key,
spoke proof-key thumbprint, both machine reports, nonce, granted scopes, expiry,
and SHA-256 digest of the access token. Join also binds the grant digest. The
spoke verifies the complete signed result before saving it. The hub verifies a
separate P-256 body proof before consuming a grant or trusting a spoke report;
DPoP alone authenticates an HTTP request's target and credential, not its body.
Keep the environment ID, environment key and peer secrets together across
restarts. Key replacement requires unpairing and pairing again.

A socket ticket selects a session; it does not establish possession of the
spoke's proof key. Each socket gets a fresh connection ID and ephemeral P-256
hub key. The spoke signs the challenge, its own ephemeral key, hub pin, report,
nonce and token digest with the key bound to its access token. The hub checks
that token against the ticket's session and verifies the proof before marking
the spoke online. Its signed hello also binds the challenge and both ephemeral
keys. Both ends derive a session key with ECDH and HKDF-SHA-256, using the signed
hello digest as salt and a protocol-specific context. Protocol version 2 is
required; both machines must be upgraded together.

Every later RPC envelope, including replies, inbox pushes such as `Unpaired`,
and transport controls, carries an HMAC-SHA-256 over the connection ID,
direction, strictly increasing per-direction sequence number, method and SHA-256
digest of the exact serialized payload. Verification happens before RPC decoding
or dispatch. A bad MAC, gap, replay, reflection or old-session frame poisons the
connection and closes it; it cannot deliver a result, run a handler or erase the
spoke's pairing. Each reconnect starts with new keys and counters. The canonical
transcripts and frame boundary live in
[peerCrypto.ts](../../apps/server/src/machines/peerCrypto.ts) and
[peerFrames.ts](../../apps/server/src/machines/peerFrames.ts).

Endpoint proofs and frame MACs protect authenticity through relays; TLS protects
confidentiality. A relay can still observe traffic where TLS terminates, drop
frames, or force reconnects. The shared peer-route policy requires HTTPS/WSS,
with HTTP/WS allowed only for literal loopback or localhost (a local SSH forward).
A tailnet name or 100.64/10 address does not exempt a route from TLS. Supplied
join routes replace advertised routes rather than silently adding fallbacks.
Entire route lists are validated before dialing, cannot mix TLS with loopback
plaintext, and are validated again on reconnect, including links saved by older
versions. HTTP redirects are never followed. Pairing does not provision a tunnel.

## Private ingress boundary

All `/peer` endpoints, including the secret-free identity challenge, check the
actual socket's remote address before reading credentials or upgrading. The
`COGENLY_PEER_INGRESS` server setting defaults to `loopback`; `disabled` refuses
all peer ingress. Public or tailnet socket sources are refused even if they
supply localhost Host or Tailscale identity headers. Use an SSH forward or
Tailscale Serve terminating HTTPS and forwarding to loopback.

Both Serve and Connect dial loopback, so the socket alone cannot distinguish
them. ManagedEndpointRuntime runs cloudflared with a remotely provisioned
loopback origin. Cloudflare adds `cf-ray` and client/forwarding headers; any
`cf-*` header is a denial marker, never an authorization signal. This rejects
Connect even when a public caller spoofs Tailscale headers. RFC Forwarded, Via,
and X-Real-IP are refused too. Other X-Forwarded headers are refused unless
Serve mode is on, and then must match Serve's overwritten tuple: HTTPS, a
single numeric tailnet source, and forwarded host. Public addresses, chains,
and `Tailscale-Funnel-Request` are refused. Identity headers grant no
exception; tagged Tailscale nodes need none.

Serve mode is `TailscaleServeMode`: `--tailscale-serve` for one run, otherwise
`tailscale-serve.json` in the state directory, which machine setup changes
live. The headers alone never turn it on. A refused forwarded request only
asks `MachineSetup.adoptServe` to read `tailscale serve status` from the local
daemon, and Serve mode turns on only when a non-Funnel mapping targets this
server's loopback port. A saved `enabled: false` is the user's opt-out
(`--no-tailscale-serve`) and is never adopted over. Under `--tailscale-serve`,
setup changes stay in memory, so a one-run flag never becomes a saved setting.

This boundary trusts local processes and proxy configuration. A locally
configured public proxy that deliberately strips every ingress marker is
indistinguishable from a local client; it must block `/peer` itself or set
`COGENLY_PEER_INGRESS=disabled`. Do not publish an SSH forward or enable Funnel.
The source for Serve's overwritten forwarding/Funnel headers is
[Tailscale's reverse proxy](https://github.com/tailscale/tailscale/blob/main/ipn/ipnlocal/serve.go);
Cloudflare's edge headers are described in its
[HTTP headers reference](https://developers.cloudflare.com/fundamentals/reference/http-headers/).

## Connection and revocation lifetimes

The spoke stores its token, routes, hub pin, and proof key in
[ServerSecretStore](../../apps/server/src/auth/ServerSecretStore.ts), with the
store's existing file permissions and plaintext-at-rest policy. The hub stores
spoke metadata and its session ID in `machine_peers`, never the raw token.

Routes are tried in order, with exponential backoff after failure. A connected
route remains selected until it fails. A ping every 30 seconds has a 15-second
deadline, so a half-open link is redialed. The hub marks a silent spoke offline
after 75 seconds without a heartbeat. Revoked or untrusted routes retry more
slowly without silently deleting the pairing. There is no token renewal yet;
expiry requires pairing again.

Unpairing on the hub revokes the session and closes its socket. A connected
spoke receives an unpair notice and deletes its local credential and key. An
offline spoke learns only that its credential was refused when it reconnects;
it retains a revoked link until cleared locally. Unpairing on a spoke tells the
hub when reachable, then forgets its secrets. If the hub is offline, its metadata
and session remain there until separately revoked or expired. Clear that entry
on the hub as well, particularly if the old spoke secrets may have been copied.

## Adding a sync or delegation handler

Define a channel with `makePeerChannel` in contracts, assigning
`AuthSyncReplicateScope` for replication or `AuthPeerDelegateScope` for work
commands. During the receiving feature's scoped initialization, obtain
`PeerChannels.PeerChannels` and call `register(channel, handler)`. Registration
lasts for that scope. The handler receives a decoded payload and an authenticated
`PeerCaller` containing the remote environment ID and link scopes.

Send with `Machines.Machines.call(targetEnvironmentId, channel, payload)` from
either side. Calls require an online direct hub–spoke link; another spoke being
visible in the list does not make it directly callable. The receiver checks the
channel scope before decoding and invokes only registered handlers. Results and
declared errors cross the wire through their schemas; channel errors arrive in
`PeerCallError.error`. Calls fail on disconnection and are never queued. Callers
own any operation deadline; scope channel work to its connection so it cannot
continue after disconnect.

The inbox stream carries hub-to-spoke requests and presence pushes. Feature
notifications can use a channel with an empty acknowledgement rather than a
second transport. Replication will still need its own durable cursors, replay
handling, merge rules, and reconnect catch-up; socket delivery is not a commit.
See the bidirectional and cancellation examples in
[Machines.test.ts](../../apps/server/src/machines/Machines.test.ts).
