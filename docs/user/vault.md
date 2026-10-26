# Vault

The vault stores logins, API keys, cards, and notes so your agents can sign
in and use credentials. Secrets are encrypted on this machine. Browser fill
shows agents only metadata and a confirmation; separately approved account
tokens are readable by the agent and the terminal commands it runs.

## What it stores

Each item has a name, a type (login, API key, card, or note), the domains it
may be used on, and its secret fields, such as a username, password, or
one-time-code secret. A card stores its number, expiry, CVC, and the name on
the card as secret fields; only its description and the last 4 digits of the number
are shown in lists. Items can belong to one project or work everywhere. Agents can list and use
only items for their thread’s project, plus items that work everywhere.

## Add an item

Open **Settings → Vault** and choose **Add item**. Pick a type, give the item
a name agents can ask for, and fill in its fields. For a login, list the
sites it may be used on. Choose whether agents ask you first (the default)
or which agents may use it without asking, optionally only on certain sites,
under **Access**.

Saved secrets cannot be viewed again, even by you. When you edit an item,
leave a secret field blank to keep it, or type a new value to replace it.

## How agents use it

- When an agent creates a credential, for example signing up for a service,
  it saves it with **vault_save**.
- To log in, it uses **vault_fill**: Cogenly checks the page address against
  the item's domains and types the value in. The agent gets only a "filled"
  confirmation. At checkout it can fill a card's number, expiry, CVC, and
  cardholder name the same way, one field at a time.
- When a site needs a login the vault doesn't have, the agent shows a
  **Sign in to (site)** card in the thread instead of asking in chat. Enter
  the username and password there and choose **Submit**. With **Save to
  vault** on (the default), the login is saved for that site and any agent
  can sign in there next time without asking; turn it off to use it for the
  current task only. **Skip** tells the agent you declined. If a saved
  password stops working, the agent shows the card again to update that
  login. Cards from scheduled runs wait for you and mark the thread as
  needing input.
- If an agent needs another secret only you know, it asks with a private card.
  It can keep your answer in the vault so it never has to ask again.
- Secret values are scrubbed from tool results and terminal output, so a
  filled password does not leak back into the conversation.
- Integrations send an item only to servers in its allowed domains, or to an
  integration you approved it for.

## Approvals

The first time an agent wants to use an item, you get an approval
request naming the item and field. Approving lets that agent use that item
again (on the approved site, when one was involved). For chats and Work,
the request is a card above that thread's composer, the thread shows
**Needs approval**, and allowing it applies to that thread only; deny it and
the agent is told you declined. A persistent agent's requests wait in its open
items. CLI process exposure always needs its own approval.

## Usage log

Every use is recorded: which item, which agent or chat, which site, and
whether it was allowed, denied, or waited on approval. A login you entered on
a sign-in card shows which thread and agent it was saved from. In Settings → Vault,
the history button on an item shows its uses, and **Recent activity** lists
uses across the vault, including items you have since deleted.

## Vault on several machines

With [paired machines](machines.md), portable vault items and web integration
sign-ins share automatically between a machine and its hub. Sharing is
end-to-end encrypted. Turn off **Share vault** for a machine in **Settings →
Vault** to stop future sharing in both directions. Either machine can opt out.
The other machine must be online to turn sharing back on and verify its key.
Agents can inspect and change the same switches with `vault_sharing_status`
and `vault_sharing_update`, without an owner approval prompt.

Existing pairings share automatically after upgrading unless sharing was
explicitly disabled. Older peers keep their opt-in behavior until they upgrade.
A hub that shares can pass readable items to its other sharing machines.

- Approvals stay on each machine. An item arriving on a machine asks before any
  agent there uses it, even if you allowed that agent elsewhere.
- To keep an item on one machine, edit it and choose **Keep on this machine
  only**. Credentials that a local integration runs with, such as the Google
  OAuth client, always stay on their machine. Either way the item shows
  **This machine only**.
- If a machine shows **Key changed**, it now presents a different vault key
  than the one this machine trusted. Unpair it and pair again.
- If an arriving item has the same name as one already there, it shows up as
  "Name (from Machine)" on that machine.
- Deleting an item sends the delete to every machine you share with. The
  newest change wins, so an edit made elsewhere after a delete brings the
  item back. It asks for approval again on machines where it was deleted.
- Turning sharing off or unpairing stops new changes from reaching that
  machine. Items it already has stay on it. If a machine is lost or stolen,
  change the passwords and keys it held.

## Accounts

From a thread filed in the project that should have access, ask an agent to
connect a Cloudflare or GitHub account for CLI use. It gives
you token-creation instructions and asks for the token in a private input
card. Use a scoped API token with only the permissions needed for the task;
do not paste it into chat or copy a CLI's OAuth login files. Connections default
to the current project, and display labels such as “Work” are public metadata.

Storage alone grants no process access. Approve exposure for this thread, or
for this agent in this project when it should work unattended. Only credentials
attached to a thread are supplied to its new Cogenly agent terminals. The agent
and its commands can read approved tokens; output scrubbing reduces accidental
disclosure but cannot keep those tokens secret from that agent. A successful
connection check proves authentication, not permission for every deployment.

Removing access blocks future delivery. Stop affected terminals to end their
process access, and revoke the token at Cloudflare or GitHub to invalidate any
copies already captured. Replacing a token requires approval for its new value.
