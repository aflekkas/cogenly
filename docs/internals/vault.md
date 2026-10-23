# Vault

Encrypted secrets that agents use without ever seeing. Built single-machine
first; the data model is ready to replicate later. User guide:
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
- Caveat for sync: rotating a secret creates a new data key wrapped only for
  the machine that made the change, so peers cannot open that revision until
  a re-wrap pass runs. Metadata-only edits keep the existing data key and
  wrapped keys.

## What is plaintext and what is not

`vault_items` keeps plaintext: name, type, scope (environment-wide or a
project label id), an optional display `label`, field _names_, allowed
domains, policy, timestamps, and a deleted tombstone. The secret body —
username, password, TOTP secret, value — exists only inside the ciphertext.
Usernames are secret too; only `label` is safe to display.

## Use, policy, approvals

Decryption happens only in the `Vault` service (`apps/server/src/vault/Vault.ts`),
for one field, and every outcome is appended to `vault_usage` (item, thread,
agent, action, domain, outcome).

Humans (owner-initiated turns) and server-internal callers are allowed.
Agents default to `ask`: the first use inserts a pending row in the existing
`agent_approvals` table with action kind `vault_use` and the tool returns a
clear "waiting on you" result — no hang. Approving (existing agents RPCs)
grants that item's policy to that agent, and to the approved domain when one
was involved, so a retry succeeds. Rejecting leaves the policy untouched.

`resolveSecretByName` is the server-internal API for other server features
(e.g. the integrations gateway): it returns a decrypted field by name and is
never exposed through MCP or RPC.

## Scrubbing and the preview_evaluate trap

Any string that equals a stored secret value (length ≥ 6) must not reach a
model. All vault field values are cached in memory only (loaded lazily,
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
never logged; lengths and names are the most telemetry may carry.
