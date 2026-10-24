# Vault

Encrypted credential storage. Browser fill keeps values out of model context;
Accounts can separately authorize portable token exposure to agent terminals.
Items replicate to machines the owner shares with; see
[vault sync](./vault-sync.md). User guide:
[docs/user/vault.md](../user/vault.md).

## Key hierarchy

- Each environment owns an X25519 key pair (`VaultCrypto.generateKeyPair`),
  created on first use and stored through `ServerSecretStore` under
  `vault-x25519-key-pair`. Access goes through the `VaultMachineKeyStore`
  interface in [VaultCrypto.ts](../../apps/server/src/vault/VaultCrypto.ts);
  today that is the file-backed secret store (0600 files in a 0700 dir). A
  macOS Keychain store replaces it behind that seam; the crypto does not
  change.
- An item body is encrypted once with a random 256-bit data key
  (AES-256-GCM, item id as AAD). The data key is wrapped **once per machine**
  (ECDH X25519 + HKDF-SHA256 + AES-256-GCM, environment id in the AAD and in
  the HKDF salt) and stored as a list in `wrapped_keys_json`. Adding a
  machine later is a new wrapped-key entry; the ciphertext is untouched and
  a hub can relay items it cannot open.
- These local rows are always wrapped for this machine only. A synced item
  arrives as a separate sealed document and is stored again here under this
  machine's own key ([vault sync](./vault-sync.md)).

## What is plaintext and what is not

`vault_items` keeps plaintext: name, type, scope (environment-wide or a
project label id), an optional display `label`, field _names_, allowed
domains, policy, timestamps, and a deleted tombstone. The secret body —
username, password, TOTP secret, value, and a card's number, expiry
month/year, CVC and cardholder name — exists only inside the ciphertext.
Usernames are secret too; only `label` is safe to display. A card also keeps
its last 4 digits in plaintext metadata: that fragment is display text for
telling cards apart (it cannot be filled or used on its own), and it is the
only secret-derived value outside the ciphertext. Legacy card-shaped items
written onto the old slots are left as they are; nothing migrates them.

## Use, policy, approvals

Decryption happens only in the `Vault` service (`apps/server/src/vault/Vault.ts`),
for one field, and every outcome is appended to `vault_usage`. Process delivery
adds the credential revision, machine, project, provider instance, terminal id
and delivery method. This records delivery, not every downstream API action.

MCP browser fills identify a thread or its persistent agent, never a human.
Both default to `ask`: the first use inserts a pending row in the existing
`agent_approvals` table with action kind `vault_use` and the tool returns a
clear "waiting on you" result — no hang. Approving (existing agents RPCs)
grants that item's policy to that thread or agent, and to the approved domain when one
was involved, so a retry succeeds. Rejecting leaves the policy untouched.

`resolveSecretByName` is the server-internal API for other server features
(e.g. the integrations gateway): it returns a decrypted field by name and is
never exposed through MCP or RPC. It takes the destination host and refuses
items whose allowed domains miss it unless the caller says the owner approved
the item there; integrations record those approvals per credential origin.

Integration OAuth tokens are vault items too, one per integration account,
written and read only by the gateway ([IntegrationTokens.ts](../../apps/server/src/integrations/IntegrationTokens.ts)).
Each secret gets its own field (access token `value`, refresh token
`password`, a registered client's secret `username`) because scrubbing matches
exact field values: a JSON blob in one field would leave the tokens inside it
unscrubbed. Expiry, server metadata, client registration and refresh ownership
travel in the item's sealed sync attachment. The gateway reads them with all
token fields and their revision from one vault-row snapshot; writes return
the revision committed with those tokens. A replacement sign-in updates the
refresher's server and client metadata even while it remains signed in. A client
authentication mismatch does not revoke the shared grant; only `invalid_grant`
does, and an obsolete refusal first retries a newer token revision.

Accounts reference vault items without copying their encrypted identities. The
legacy backfill reads metadata only and preserves item ids and encrypted
bodies. Account lookups filter by project, including direct id lookups; an
unfiled caller sees only all-project accounts.

CLI process exposure uses separate revision-bound grants, including for owner
threads. It reuses `vault_use` approvals with a `processExposure` payload; this
branch must never update the browser policy. Approval grants this thread by
default, or explicitly this agent in this project. Scheduled runs may reuse
that agent grant, while a child remains bounded by every ancestor's live
bindings and grants. Changing a token requires new approval. Removing access
blocks future delivery; existing processes retain their copies until stopped,
and upstream revocation is needed to invalidate captured copies.

Private account connections bind the service, project and intended CLI use
server-side. Vault storage and association commit together before the private
receipt is removed, so storage failures remain retryable. CLI verification
uses a replacement environment and private empty configuration directories;
provider-native credential files are neither imported nor cloned.

## Scrubbing and the preview_evaluate trap

Stored and delivered secret values are scrubbed from tool results; values shorter
than six characters use whole-token matching.
This is an output guard, not a boundary against an agent already authorized
to read a process token. All vault field values are cached in memory only (loaded lazily,
invalidated on writes) and `McpToolAccess` redacts every MCP tool result
against them before serialization. That covers terminal output
(`terminal_run`/`terminal_read`) and other tool output as a second layer.
Exact-value scrubbing cannot catch transformed secrets (base64, character
codes, etc.). Before dispatching a `vault_fill`, `PreviewAutomationBroker`
therefore disables agent evaluation on that tab for its remaining lifetime,
across provider sessions and browser-host reconnections. It also seals fills
whose browser response fails: typing may already have happened. Navigation
does not lift the restriction, since history can restore filled inputs and
pages can retain values in script state or storage. Snapshots and focused
browser actions remain available; evaluation needs a fresh tab. Values are
never logged; lengths and names are the most telemetry may carry. Card values
are also scrubbed in the shapes a page echoes them: the number digits-only or
grouped in fours, and the expiry as `MM/YYYY`; the CVC and `MM/YY` expiry are
below the length floor, so they are scrubbed as whole tokens only (never
inside a longer number). TOTP codes for the current 30-second window and its
neighbours take the same whole-token pass; delivered codes remain registered
after their window expires.
Scrubbing fails closed: when the secrets cannot be loaded, every string in the
result is replaced by a withheld notice and the error is logged.

Delivered values stay registered for the server lifetime, including old revisions
after replacement/deletion; process values also register base64, URL-encoded and
JSON-escaped forms. The registry is bounded and refuses new deliveries when full
rather than forgetting values that may still appear in retained output. This deliberately outlives a PTY: descendants and retained
output may outlive it. All terminals also redact against the vault across PTY chunk boundaries
before output enters events or persisted history. Tokens are resolved after
provider environment configuration and overlay only the selected terminal's
environment; they never enter settings or launch arguments. Provider-native
shell delivery is separate work because provider sessions can share threads.
