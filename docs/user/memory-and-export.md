# Memory and export

## Memory

Memory holds facts that chats and agents can use as context, each with who added it and where it
came from. Manage it in **Settings → Memory**: filter by project, agent, or status, add something
with **Remember something**, correct a fact, forget it, or open its history. A correction keeps the
old wording in history; a forgotten fact stays in history and can be remembered again.

To save part of a conversation, hover a message and choose **Remember this**. The fact links back
to the message, and its projects start as the chat's confirmed projects. A fact without projects is
private to you (and to the agent it belongs to).

Agents propose facts as they work. A proposal is never used until you choose **Confirm**;
**Reject** discards it. An agent's own facts also appear under **Memory** in its
**Details**.

## Project context in chats

A chat in a project sends that project's confirmed facts, open items, and Work outcomes to the
model at the start of each turn. To keep a chat in its project without sending context, turn off
**Use project context** in the chat's folder picker.

When a reply used context, **Context used** appears under it. Expand it to see each item and open
where it came from.

## Export

**Settings → Data** writes a portable export of chats, Work, agents, open items, projects, and
memory, optionally limited to one project. The export is saved on the machine running that
environment, and the page shows its location, size, and record counts. **Validate** reads an export
back and reports any problems without changing it.

Secrets, provider sign-ins, and connection tokens are never exported. Importing an export isn't
available yet; to keep a full recovery copy, see [Keeping a recovery copy](./thread-migration.md#keeping-a-recovery-copy).
