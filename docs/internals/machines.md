# Machine peer links

Machine pairing connects servers owned by the same user. A hub accepts spokes;
spokes dial out so a laptop needs no inbound address or exposed port. The same
socket carries requests in either direction. A machine may join one hub or have
spokes, never both. Client connection catalogs remain independent of this link.

The link currently carries machine presence, self reports, and registered typed
channels. It does not replicate projects, settings, threads, files, credentials,
or launch work remotely. Provider reports contain status, never login tokens.

## Pairing establishes a separate audience

An admin-connected client calls `machines.prepareJoin` on the spoke, passes its
key thumbprint to `machines.createPeerGrant` on the hub, and hands the resulting
join code to `machines.joinHub` on the spoke. Only the spoke server redeems it.
The hub grant expires after ten minutes and can be spent once. The CLI fallback
can omit the thumbprint: that code is a secret usable by the first redeemer,
whose proof key is then bound. Transfer it privately.

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
join code. Before join and each reconnect, a secret-free `/peer/identity` challenge
checks that pin before sending any grant or peer token. Join and the socket
hello also sign fresh nonces with both environment IDs. The hub pins the spoke environment ID to its proof-bound
session and checks subsequent self reports against it. Keep the environment ID,
environment key, and peer secrets together across restarts. Key replacement
requires unpairing and pairing again.

DPoP and the signed hello authenticate endpoints; TLS encrypts network traffic.
The shared peer-route policy requires HTTPS/WSS, with HTTP/WS allowed only for
literal loopback or localhost (a local SSH forward). A tailnet name or
100.64/10 address does not exempt a route from TLS. Supplied join routes replace
advertised routes rather than silently adding fallbacks. Entire route lists are
validated before dialing, cannot mix TLS with loopback plaintext, and are
validated again on reconnect, including links saved by older versions. HTTP
redirects are never followed. Pairing does not provision a tunnel.

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
