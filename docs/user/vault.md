# Vault

The vault stores logins, API keys, cards, and notes so your agents can sign
in and use credentials without ever seeing them. Secrets are encrypted on
this machine; agents only ever see item names and details like which fields
exist.

## What it stores

Each item has a name, a type (login, API key, card, or note), the domains it
may be used on, and its secret fields, such as a username, password, or
one-time-code secret. A card stores its number, expiry, CVC, and the name on
the card as secret fields; only its label and the last 4 digits of the number
are shown in lists. Items can belong to one project or work everywhere.

## Add an item

Open **Settings → Vault** and choose **Add item**. Pick a type, give the item
a name agents can ask for, and fill in its fields. For a login, list the
sites it may be used on. Choose whether agents ask you first (the default)
or which agents may use it without asking, optionally only on certain sites.

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

## Approvals

The first time an always-on agent wants to use an item, you get an approval
request naming the item and field. Approving lets that agent use that item
again (on the approved site, when one was involved). Ordinary chats you
start yourself do not need approval.

## Usage log

Every use is recorded: which item, which agent or chat, which site, and
whether it was allowed, denied, or waited on approval. Settings → Vault
shows each item's uses and all activity across the vault.
