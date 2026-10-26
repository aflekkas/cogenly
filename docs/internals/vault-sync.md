# Vault sync

Vault items replicate between paired machines as end-to-end encrypted
[shared documents](./sync.md) of kind `vault`. A hub relays them whether or not
it can read them. Code: [VaultSync.ts](../../apps/server/src/vault/VaultSync.ts),
[VaultSyncCapture.ts](../../apps/server/src/vault/VaultSyncCapture.ts), and the
primitives in [VaultCrypto.ts](../../apps/server/src/vault/VaultCrypto.ts). User
guide: [Vault on several machines](../user/vault.md#vault-on-several-machines).

## Who can read

A **holder** is a machine that can decrypt synced items. Directly paired
machines are authorized by default; an access-management client or an agent can
opt out or restore sharing through `VaultSync.setPeerSharing`. Each direct
peer's X25519 vault key is fetched over its authenticated link and pinned to that pairing. Invalid and
low-order keys are refused. A changed key requires unpairing and pairing again
with its new key.

Both sides default on, but either can opt out before future data keys are
released. Missing records on upgrade mean never touched and default on;
legacy disabled records remain disabled. A preference keyed to the pairing
also records opt-outs made before a peer supplies its vault key. The peer's
`VaultPeerKey.sharing` confirmation is stored locally and refreshed on enable,
on topology changes, and on reconcile for online peers. A false confirmation
stops future wraps. Offline peers retain their last confirmation. Every use of
a share also checks the current pairing, including session expiry and
revocation; the event stream is not the revocation boundary.

A spoke can share only with its hub, and a hub only with its own spokes. A
holder hub can wrap readable revisions for its other holders. A non-holder hub
relays ciphertext but cannot read or fan it out. Authorizing a holder trusts
that machine with the whole shared vault, including permission to edit it and
share its readable items with its own authorized holders.

## Authenticated revisions

Each author owns `sealed:<author>` and each wrapper owns
`wrap:<recipient>:<by>`. On receipt, keys naming an author or wrapper other than
`updatedBy` are dropped, without refusing the batch. An untrusted spoke's
far-future revision or junk wrap therefore cannot replace a holder's fields.
Vault SharedState tombstones are also dropped: a delete is an encrypted
`{ deleted: true }` revision, accepted only through a trusted wrap.

Every new revision has a fresh AES-256-GCM data key. Its versioned ciphertext,
nonce, and wraps for self and all confirmed holders are written under one HLC
in one SharedState change and transaction. Additional recipients get separate
wrap fields bound to that revision's digest; a mismatched wrap never opens a
body. Recipient wrap failures are skipped with item and machine ids logged,
so a bad recipient does not prevent saving locally.

The sealed AAD binds the item, author, and exact field clock. Authenticated
wrap keys mix ephemeral and static X25519 exchanges; HKDF info and GCM AAD bind
the ephemeral public key, both static public keys, both machine identities,
the item, and sealed digest. Relabeling a ciphertext, clock, identity or key
cannot make it authenticate. Plaintexts include their length inside padding
to the next power of two, at least 512 bytes. Relays see ids, clocks,
recipient relationships and size buckets, never plaintext lengths or secrets.

The newest revision that authenticates through self or a current holder wins,
including deletes. A later edit resurrects the same id with default approval
policy. The last authenticated clock is persisted, so losing a wrap or ending
a share never rolls a machine back to an older readable revision. Accepted
revisions also get a self-wrap, retaining access to copies already received.
Fan-out and status use exact local records of successfully produced wraps for
the pinned recipient key; a plausible digest or copied ciphertext does not
prove that recipient can open it. This means "shared" proves a valid wrap was
produced, not that the other machine has received or projected it.

Unknown document fields survive merge. Sealed values are replaced atomically,
without grafting unknown keys onto authenticated ciphertext. Unknown decrypted
payload keys, including nested `secretFields` keys, are kept in a separate
locally encrypted extras blob and merged back on edit. A newer envelope `v`
waits in the deferred log rather than stalling sync. A local edit can proceed
using the last readable local copy; fields present only in an unreadable newer
revision are then lost. Changes to the encryption format need a coordinated
upgrade if preserving those fields is required.

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
records the last authenticated digest and clock. Projection re-reads the
document and updates the local vault row in one transaction with local vault
mutations, so a stale pass cannot overwrite a committed local edit.

Local writes are captured inside Vault's own transaction. Once an item has a
document, capturing continues even with no shares, using a self-wrap only.
Turning sharing on captures items that have never synced and forwards current
revisions. It never overwrites an existing unreadable document from an older
local row.

When an arriving item's name is taken by a different item in the same scope,
it is stored here as `Name (from Machine)`. `local_name` remembers that, so
editing it here does not rename it everywhere else.

## Revocation and residual risk

Unpairing, re-pairing, or session revocation/expiry invalidates the local share
before its next use, even if a stale row remains. New revisions use new data
keys and exclude invalidated shares. Revocation is not remote wipe: previously
copied ciphertext and keys remain readable, so rotate secrets after losing a
machine. An offline machine cannot know that its peer revoked the pairing;
clear the pairing on both sides when either cannot deliver the unpair notice
(see [machine lifetimes](./machines.md#connection-and-revocation-lifetimes)).

A malicious hub is the trusted relay for authorship. It can withhold changes,
forge relayed field ownership or clocks, and permanently deny delivery. It
cannot authenticate substituted content or deletes without a holder's key.
Previously accepted authenticated clocks prevent rollback of local copies;
availability and complete delivery through a malicious hub are not guaranteed.
Untrusted spokes cannot mask a holder's fields, even when their own clocks are
far in the future. Item ids, topology, timing and padded size buckets are not
hidden. A compromised holder can read and change everything it holds.
