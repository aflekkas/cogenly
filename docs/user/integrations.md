# Integrations

Ask an agent to connect a service: “Connect my Gmail” or “Connect Wispr Flow.”
The agent does the whole setup in the browser panel, including developer-console
pages, without asking you first. You only step in for what needs you: a password
or two-factor code it doesn't have in your vault, and the final sign-in screen
where you approve access. If it needs a login or secret you haven't saved, enter
it in the private request the agent opens. Never paste credentials into a
conversation.

Anything an agent creates for you, such as a Google Cloud project, an OAuth
client or a Slack app, is named **Cogenly**, so you can recognize it in the
service's console. When one already exists, the agent reuses it instead of
making another. The agent also records what it set up and where in the
account's **Setup notes** in Settings → Integrations, so a later agent can find
and fix it.

Settings → Integrations shows connected accounts, live connection status and
which projects can use each account. **Connect with an agent** opens a new chat
that starts “Connect” for you to finish with the service's name; a suggested
service such as Slack or Notion fills it in. An account that needs attention
offers **Reconnect**, which renews its sign-in; a working one offers **Test**.
The account's menu also has **Turn off**, which stops access until you
reconnect, and **Remove**, which deletes the connection.
Ask an agent to rename an account or change its project scope. Connect a service
again to add another account, such as personal Gmail and work Gmail.

## Gmail and Google Workspace

Google Workspace connects Gmail, Calendar, Drive, Docs and Sheets. The first
connection needs a Google Cloud OAuth client. The agent creates it in the
browser panel: a project named Cogenly, the five APIs, a published consent
screen, and a Web application client with the right redirect address, saved to
your vault. Then open its consent link and choose the Google account to
connect. A Workspace organization may also need an administrator's approval.

Setup happens on the machine running Cogenly. The agent can install uv there
when required. On a VPS or another device, give the agent the HTTPS address you
use for Cogenly so the callback returns to an address your browser can reach.
Google signs out apps left in Testing mode after seven days, so the agent
publishes the app. If you are signed out weekly, ask an agent to check it.

## Wispr Flow

Ask “Connect Wispr Flow,” then open the sign-in link and approve access. No API
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

**Use only Cogenly integrations** is on by default in Settings → Integrations →
Agent access.
Agents then use only the integrations connected in Cogenly, not the MCP
servers, claude.ai connectors and Codex plugins set up in Claude or Codex. This
keeps integrations in one place and avoids duplicate tools. The setting follows
you to every paired machine. Turn it off to let agents use both; the change
applies to new agent sessions. Claude and Codex configuration files are never
modified.

Some servers stay on either way:

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

To keep using a server you set up in Claude or Codex, bring it over with
**Import from Claude and Codex** at the top of Settings → Integrations. **Review** lists what was
found and what each server still needs. **Import** brings the definitions over,
turned off; an agent then collects secrets into the vault and checks each
connection with you. claude.ai connectors need a new sign-in through Cogenly
because their authorization can't be imported. Repo servers aren't imported;
they already load from the repo. On a paired machine, an imported web
integration asks you to sign in on that machine, and integrations that run a
command stay on the machine that imported them.

## Sign-ins on paired machines

When you [share the vault](vault.md#vault-on-several-machines) between paired
machines, signing in to a web integration on one machine signs it in on the
others too. One machine renews the sign-in for all of them: your hub when it
shares the vault with you, otherwise the machine you signed in on. If that
machine is offline when the sign-in runs out, the others show that they are
waiting for it; signing in again on any machine also works. Google and other
local integrations sign in on each machine separately.
