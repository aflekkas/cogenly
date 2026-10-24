# Vault sync

Vault items replicate between paired machines as end-to-end encrypted
[shared documents](./sync.md) of kind `vault`. A hub relays them whether or not
it can read them. Code: [VaultSync.ts](../../apps/server/src/vault/VaultSync.ts),
[VaultSyncCapture.ts](../../apps/server/src/vault/VaultSyncCapture.ts), and the
primitives in [VaultCrypto.ts](../../apps/server/src/vault/VaultCrypto.ts). User
guide: [Vault on several machines](../user/vault.md#vault-on-several-machines).

## Who can read

A **holder** is a machine that can decrypt synced items. Sharing is a local
owner decision per direct peer, stored in `vault_peer_shares` with that peer's
vault public key. Only an access-management client can make it
(`vault.setPeerSharing`). There is deliberately no MCP tool, so an agent cannot
add a holder.

- The key is fetched with `VaultPeerKey` from that machine itself, over the
  authenticated direct link, and pinned. A key relayed through the hub would
  be the hub's word, not the machine's, so a spoke can share only with its hub
  and a hub only with its own spokes. A later fetch that returns a different
  key for the same pairing is refused (`key_changed`), never silently
  re-pinned. The owner turns sharing off and on to trust the new key.
- Mutual consent: a machine projects only wraps made by itself or by a peer in
  its own share table. When A shares with the hub but the hub does not share
  with A, the hub relays A's items and cannot read them.
- A holder hub forwards: when it can open the current revision and a share
  peer lacks a wrap for it, the hub writes one. That is the only way spoke B
  reads spoke A's item. A non-holder hub cannot forward.

## Document format

`sealed` holds the item payload (name, type, scope, label, domains, secret
fields, timestamps and an opaque `attachment`) under a fresh data key per
revision. `wrap:<recipient>` holds that data key for one recipient. Ids,
timestamps, author and recipient ids are all a non-holder learns.

- **One field per recipient.** Fields merge last-writer-wins. A single map of
  wraps would let two holders adding different recipients at the same time
  drop one of them.
- **The field clock is in the sealed AAD.** The hub is a trusted relay for
  authorship and could re-send an old `sealed` value under a newer clock to
  roll a secret back. Binding the clock SharedState assigns
  (`SharedState.writeBuilt`) makes that value fail to open.
- **Wraps commit to the sealed digest and are authenticated.** The wrap key
  mixes an ephemeral X25519 exchange with one from the wrapper's static key,
  and the recipient checks `by` against a key it trusts. A relay can encrypt
  to a public key but cannot make a wrap that verifies as a holder, so it
  cannot substitute secrets or allowed domains, or pair a valid wrap with
  another revision.
- **Signed values are atomic.** `preserveUnknown` does not carry a newer
  build's keys into a rewritten `sealed` or wrap, because that would break the
  digest every wrap commits to. Unknown payload keys survive instead: a reseal
  starts from the decrypted current payload. Unknown document fields and wrap
  recipients survive the per-field merge as for any document. A newer `v`
  fails validation and waits in `shared_deferred_changes`.

## What stays on each machine

Policy, approvals, usage and portability are never in the document. An
approval authorizes an agent or thread, which runs on one machine, to decrypt
there; a grant made on a laptop must not widen what the always-on hub's agents
may fill. An item arrives with the default policy (`ask`). Later revisions keep
the local policy. A policy-only edit writes nothing.

An item is machine-only when its `portability` column says so, when a
`transport: "local"` integration references it (`google-oauth-client` by name,
and any `{{credential:…}}` in a local integration's config), or when its
account credential is machine-only ([vaultPortability.ts](../../apps/server/src/vault/vaultPortability.ts)).
Local integrations run a command here with those secrets. Their sign-in files
live in the state directory, never in the vault, so they never sync. Making an
item machine-only stops later revisions. Machines that already have a copy keep
it.

## Integration sign-ins

A web integration's OAuth tokens are one vault item, so they travel like any
other item. Its attachment carries the non-secret rest of the sign-in
(integration id, authorization server, registered client, expiry, refresh
owner); the tokens and a registered client's secret stay in the sealed secret
fields. Code: [Integrations.ts](../../apps/server/src/integrations/Integrations.ts)
and [IntegrationTokens.ts](../../apps/server/src/integrations/IntegrationTokens.ts).

- **Adoption.** Integration definitions do not live in the vault, so a machine
  links them up itself: `Integrations.adoptSyncedSignIns` signs in a local
  definition that is not signed in from the newest readable item whose
  attachment names its id. It runs on `Vault.syncedChanges`, at startup, on
  create, and wherever another path writes a definition. It never adopts for a
  `transport: "local"` integration, or when the item's allowed domains do not
  cover the integration's host: the domains are signed into the item, the
  attachment's server is only the author's claim. A removed or emptied item
  makes a signed-in integration need sign-in.
- **One refresher.** Many servers rotate refresh tokens and revoke the whole
  grant when an old one is reused, so two machines refreshing on their own can
  sign the owner out everywhere. Only the attachment's `refreshOwner` calls the
  token endpoint. A sign-in names the hub when it is made on a spoke whose hub
  reads this vault (the hub is always on), otherwise the machine it was made
  on. Another machine uses the synced access token until it expires or is
  refused, then fails with "Waiting for <machine> to refresh this sign-in"
  without touching its own sign-in state. The owner refreshes due items from
  the scheduler while the vault has a share peer, including items for a
  definition that has not reached it, when the client is a registered one.
  A grant the owner finds dead is emptied in the item, so every machine shows
  **Needs sign-in**. Cached decrypted tokens are keyed by `credential_revision`.
- **A lost refresher.** Nothing elects a new one. If the refresh owner is
  unpaired or gone, the others wait until the next sign-in on one of them,
  which replaces the item and picks the refresher by the rule above.

## Projection is asynchronous

[sync.md](./sync.md) projects a merged document in the merge transaction. Vault
documents do not: `SharedDocumentProjection` skips them, and VaultSync
reconciles after `SharedState.changes`, after the share list changes, and at
startup. Opening a revision needs this machine's private key, and a revision
this machine cannot read yet is normal (a wrap may arrive later). Neither may
refuse a batch, since a refusal that depends on local keys would wedge the
cursor. The document and cursor still commit together. `vault_sync_applied`
records the digest last projected, so passes are idempotent and a forward is
written only when a wrap is missing.

Local writes are captured inside Vault's own transaction, and only while this
machine shares with someone. Turning sharing on runs a full pass that captures
existing items. A full pass never reseals over a revision this machine cannot
read, so an older copy cannot overwrite a newer unreadable edit.

When an arriving item's name is taken by a different item in the same scope,
it is stored here as `Name (from Machine)`. `local_name` remembers that, so
editing it here does not rename it everywhere else.

## Revocation and residual risk

Unpairing on either side, re-pairing, or a revoked session removes the share
row when the machine list changes. Each revision has a new data key and is
wrapped only for current share peers. Revoking is not remote wipe: copies on
that machine stay readable there. Rotate secrets if a machine is lost.

Deletes are SharedState tombstones: permanent, and they win over later edits.
Agents can delete items (`vault_delete`), and a delete removes the item from
every holder. A relay can withhold changes or forge a tombstone, which affects
availability as it does for every synced document, but it cannot read or alter
content. A holder sees everything shared with it. An item that synced before a
rule made it machine-only, for example one a local integration starts using
later, stays on the machines that have it.
