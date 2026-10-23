# Machines

A user's Cogenly servers can pair so they share state and work. One always-on
machine is the **hub**; every other machine is a **spoke** that dials it. A
server is standalone, a hub with spokes, or a spoke of exactly one hub, never
both. With one machine nothing here runs. The service every transport calls is
[Machines](../../apps/server/src/machines/Machines.ts).

This is the first time a server holds a credential to another server. The link
carries no data yet: shared documents, thread replicas and cross-machine
delegation register handlers on it later.

## Spokes dial the hub

Only the spoke opens connections. A laptop behind NAT, asleep, or on a new
network never has to be reachable, and the hub needs no route to it. A hub
request to a spoke goes down the socket that spoke already holds open
([PeerHub](../../apps/server/src/machines/PeerHub.ts)). When the spoke is not
connected the request is refused, never queued, so a caller on the hub always
knows a laptop is asleep instead of waiting on it.

The spoke walks its saved routes in order (the address the pairing client used
first, then the hub's tailnet and LAN addresses), moves the one that worked to
the front, and redials with backoff
([HubLink](../../apps/server/src/machines/HubLink.ts)). Routes are hints like a
client's: the hub's signature, not the address, decides whether a server is the
hub.

## The `peer` subject is confined to `/peer`

Pairing produces an ordinary environment session with subject `peer`, scopes
`sync:replicate` and `peer:delegate`, bound to the spoke's DPoP key. Like
`mcp-client` sessions are confined to `/mcp`, peer sessions are accepted only by
the `/peer` endpoints ([peerHttp](../../apps/server/src/machines/peerHttp.ts)).
[EnvironmentAuth](../../apps/server/src/auth/EnvironmentAuth.ts) rejects the
subject on every other HTTP route, the `/ws` upgrade, and `/mcp`. Peer scopes
are outside `AuthGrantScope`, so no pairing link, token exchange or client
grant can ask for them, and no client RPC requires one. A peer grant presented
to a client pairing path is refused.

So a stolen peer token is useless without the spoke's private key, and with the
key it reaches only the peer protocol: no client RPCs, files, terminals,
settings, or MCP tools. What it can do grows with what features register on the
link, each behind one of the two scopes.

Inside `/peer`, every link method needs `sync:replicate`. `peer.call` instead
checks the scope of the channel it names. Pairing grants both scopes in both
directions: the hub's requests to a spoke are checked against the scopes the
spoke's link holds.

## Pinning

Each side pins the other's environment id. The hub ties the session to the
environment id that redeemed the grant; a hello from another id is refused.
The spoke pins the hub's environment id and Ed25519 environment key from the
join code. The hub signs the join nonce and every `peer.hello` nonce with that
key, and a spoke that cannot verify the signature distrusts the route and keeps
its credential. A different server answering on a saved LAN address therefore
never receives a hello it could pass, and cannot unpair the machine.

The join code reaches the spoke through a client signed in to both servers with
access management, or through the CLI. That is where trust starts: whoever
holds a join code can pair one machine, once, within ten minutes. A grant is
bound to the spoke's proof key when the broker knows it (`machines.prepareJoin`
on the spoke first); a wrong key is refused without spending the grant. The CLI
grant is unbound, so the first redeemer's key is bound.

## Unpairing

Either side can unpair. On the hub this revokes the session, deletes the spoke's
row, and pushes `Unpaired` before closing the socket, so a connected spoke
forgets its credential and keys. The socket is closed only after that push has
been delivered. Revoking the session anywhere else, such as Settings →
Connections, does the same. A spoke that was offline learns on its next dial:
the hub refuses its ticket and the spoke shows the hub as unpaired, retrying
slowly until it is unpaired locally too, because a refusal from a different
server on one route must not unpair it for good.

## Using the link

A feature defines a `PeerChannel` in contracts (name, scope, payload, success
and error schemas), registers its handler with `PeerChannels.register` on the
receiving side for the life of its scope, and sends with `Machines.call`. Calls
work in both directions over the same socket. The hub also pushes its machine
list to every spoke, which is how spokes list each other.
