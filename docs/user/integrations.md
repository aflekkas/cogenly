# Integrations

Ask an agent to connect a service: “Connect my Gmail” or “Connect Wispr Flow.”
The agent does the whole setup in the browser panel, including developer-console
pages, without asking you first. You only step in for what needs you: a password
or two-factor code it doesn't have in your vault, and the final sign-in screen
where you approve access. If it needs a login or secret you haven't saved, enter
it in the private request the agent opens. Never paste credentials into a
conversation.

When a step needs you, a card appears in the chat. **Sign in** opens the
service's sign-in page in your default browser; once you approve, the card
shows Connected and the agent carries on. **Fix** shows the setting that needs
changing, and changes that need your approval show **Approve integration** above
the composer. Persistent agents ask the same way, in their own conversation.

Anything an agent creates for you, such as a Google Cloud project, an OAuth
client or a Slack app, is named **Cogenly**, so you can recognize it in the
service's console. When one already exists, the agent reuses it instead of
making another. The agent also records what it set up and where in the
account's **Setup notes** in Settings → Integrations, so a later agent can find
and fix it.

Settings → Integrations lists your connected accounts, like Settings →
Providers lists agents. Each row shows the service, its account and its status:
Connected, Needs sign-in or Off. Select one to see its status and which projects
can use it. An account that needs attention offers **Reconnect**, which renews
its sign-in; a working one offers **Test**. Turning an account off stops access
until you turn it back on; removing it deletes the connection.

**Add integration** starts a new chat where an agent sets up a service with you;
say which one, or it asks. **Connect sources** in the composer's Sources menu
does the same, and leaves your current chat and draft as they are. Ask an agent
to rename an account or change its project scope. Connect a service again to add
another account, such as personal Gmail and work Gmail.

## Gmail and Google Workspace

Google Workspace connects Gmail, Calendar, Drive, Docs and Sheets. The first
connection reuses a Google Cloud OAuth client from your vault or a paired
machine. If none exists, the agent creates it in the
browser panel: a project named Cogenly, the five APIs, a published consent
screen, and a Web application client with the right redirect address, saved to
your vault. The client works across your paired machines. Choose **Sign in**
on the card for each machine and pick the Google account to
connect. A Workspace organization may also need an administrator's approval.

Setup happens on the machine running Cogenly. The agent can install uv there
when required. On a VPS or another device, give the agent the HTTPS address you
use for Cogenly so the callback returns to an address your browser can reach.
Google signs out apps left in Testing mode after seven days, so the agent
publishes the app. If you are signed out weekly, ask an agent to check it.

## Wispr Flow

Ask “Connect Wispr Flow,” then choose **Sign in** on the card and approve access. No API
key is needed. Your account needs Notetaker and Cloud Sync. Enterprise accounts
may require an administrator to enable the MCP connector and Scratchpad access;
HIPAA-covered accounts do not support it. The connection reads meeting notes,
transcripts and other supported notes, rather than local dictation history.

## Other services and MCP servers

Agents have setup instructions for Slack, GitHub, Linear, Notion and Fathom.
Slack requires your own app; GitHub can use a personal access token. The agent
creates these in the browser panel and asks you only for sign-in and approval.
For another service, provide its MCP URL or the command that starts its server.
Secrets are stored in your vault and referenced by the connection.

Integrations work across providers, persistent agents and scheduled runs.
Persistent agents request owner approval before creating a connection or
changing its credential destination. An agent can only use accounts available
to its project. A successful connection test checks authentication and tool
availability; the agent also verifies that the required data can be read.

## Provider configuration

Agents use only the integrations connected in Cogenly. The MCP servers,
claude.ai connectors and Codex plugins and apps set up in Claude or Codex are
off in Cogenly's agent sessions, which keeps integrations in one place and
avoids duplicate tools. Claude and Codex configuration files are never
modified, so those servers keep working when you use Claude or Codex directly.
To use one of them in Cogenly, ask an agent to connect it.

Some servers stay on:

- **Servers checked into a repo.** A repo's `.mcp.json` (and Codex's
  `.codex/config.toml` in the repo) supplies its web servers automatically.
  Local command servers also load automatically for repos owned by your connected
  GitHub identity, any GitHub owner linked to a Cogenly project, and repos with no
  remote. For other repos, choose **Trust** or **Don't trust** in the thread.
  Trust applies on this machine from the next turn, including other checkouts of
  the same remote. Changes to the server definitions need your trust again.
- **Servers your organization manages for Claude.** Cogenly can't turn these
  off; agents are told they are outside Cogenly.
- **Muse's own servers.** Muse can't hide them.

## Sign-ins on paired machines

With [vault sharing](vault.md#vault-on-several-machines), enabled by default
between paired machines, signing in to a web integration on one machine signs
it in on the others too. One machine renews the sign-in for all of them: your hub when it
shares the vault with you, otherwise the machine you signed in on. If that
machine is offline when the sign-in runs out, the others show that they are
waiting for it; signing in again on any machine also works. Google and other
local integrations sign in on each machine separately.

Web connections also share account labels, enabled state and project access.
API keys and private endpoints work on the other machine once their vault items
arrive. Settings explains when a connection cannot sync and offers **Set up on
<machine>** for your other paired machines. Local programs, their installed
packages and Google's account sign-ins need setup on each machine. The same
setup card offers each remaining sign-in and shows where it is connected.

Claude and Codex can use integrations connected during a running chat, including
ones arriving from another machine, without restarting the chat. Ask the agent
to check your current integrations if it has not noticed the new connection.
