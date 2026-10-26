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
- If an agent needs a secret only you know, it asks with a private card.
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
whether it was allowed, denied, or waited on approval. In Settings → Vault,
the history button on an item shows its uses, and **Recent activity** lists
uses across the vault, including items you have since deleted.

## Vault on several machines

With [paired machines](machines.md), you can share the vault between a
machine and its hub. Turn on **Share vault** for the other machine under
**Paired machines** in **Settings → Vault**, on both machines: items move only
when each side has chosen to share with the other. Until the other side does,
the machine shows **Waiting for (machine) to share back**, and releases no
keys to that machine. Sharing is
end-to-end encrypted. The secrets, names, and sites of items are readable only
on machines you share with. The other machine must be online to turn sharing
on.

- A hub you have not shared with still passes items between your other
  machines, but cannot read them. For one laptop's items to reach another
  laptop, share both laptops with the hub, and the hub with both.
- Approvals stay on each machine. An item arriving on a machine asks before any
  agent there uses it, even if you allowed that agent elsewhere.
- To keep an item on one machine, edit it and choose **Keep on this machine
  only**. Credentials that a local integration runs with, such as the Google
  OAuth client, always stay on their machine. Either way the item shows
  **This machine only**.
- If a machine shows **Key changed**, it now presents a different vault key
  than the one this machine trusted. Unpair it and pair again, then turn
  sharing back on on both machines.
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
