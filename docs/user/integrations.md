# Integrations

Ask an agent to connect a service: “Connect my Gmail” or “Connect Wispr Flow.”
It handles setup, gives you a sign-in link, and checks that the connection works.
When a service needs a key or client secret, enter it in the private secret
request the agent opens. Never paste credentials into a conversation.

Settings → Integrations shows connected accounts, live connection status and
which projects can use each account. **Connect with an agent** opens a new chat
that starts “Connect” for you to finish with the service's name; before your
first connection, a suggested service such as Slack or Notion fills it in.
**Reconnect** renews a sign-in;
**Disconnect** stops access until you reconnect; **Remove** deletes the connection.
Ask an agent to rename an account or change its project scope. Connect a service
again to add another account, such as personal Gmail and work Gmail.

## Gmail and Google Workspace

Google Workspace connects Gmail, Calendar, Drive, Docs and Sheets. The first
connection needs a Google Cloud Web application OAuth client. Your agent explains
which APIs to enable, which permissions are required and the exact redirect URI
to register. You may need to create the app or obtain administrator approval.
Enter the downloaded client JSON through the agent's private secret request,
then open its consent link and select the intended Google account.

Setup happens on the machine running Cogenly. The agent can install uv there
when required. On a VPS or another device, give the agent the HTTPS address you
use for Cogenly so the callback returns to an address your browser can reach.
Testing-mode Google apps can require renewed consent after seven days. Ask the
agent to check your app's publishing requirements if this happens.

## Wispr Flow

Ask “Connect Wispr Flow,” then open the sign-in link and approve access. No API
key is needed. Your account needs Notetaker and Cloud Sync. Enterprise accounts
may require an administrator to enable the MCP connector and Scratchpad access;
HIPAA-covered accounts do not support it. The connection reads meeting notes,
transcripts and other supported notes, rather than local dictation history.

## Other services and MCP servers

Agents have setup instructions for Slack, GitHub, Linear, Notion and Fathom.
Slack requires your own app; GitHub can use a personal access token. The agent
handles the configuration and tells you which account-only steps remain.
For another service, provide its MCP URL or the command that starts its server.
Secrets are stored in your vault and referenced by the connection.

Integrations work across providers, persistent agents and scheduled runs.
Persistent agents request owner approval before creating a connection or
changing its credential destination. An agent can only use accounts available
to its project. A successful connection test checks authentication and tool
availability; the agent also verifies that the required data can be read.

## Provider configuration

**Use only Cogenly integrations** is on by default in Settings → Integrations.
Agents then use only the integrations connected in Cogenly, not the MCP
servers, claude.ai connectors and Codex plugins set up in Claude or Codex. This
keeps integrations in one place and avoids duplicate tools. Servers your
organization manages for Claude stay available, and Muse can't hide its own
servers. Turn the setting off to let agents use both; the change applies to new
agent sessions. Claude and Codex configuration files are never modified.

Until you import or skip **Import from Claude and Codex** on the same page,
agents keep using the servers set up in Claude and Codex. **Review** lists what
was found and what each server still needs. **Import** brings the definitions
over, turned off; an agent then collects secrets into the vault and checks each
connection with you. claude.ai connectors need a new sign-in through Cogenly
because their authorization can't be imported.

## Sign-ins on paired machines

When you [share the vault](vault.md#vault-on-several-machines) between paired
machines, signing in to a web integration on one machine signs it in on the
others too. One machine renews the sign-in for all of them: your hub when it
shares the vault with you, otherwise the machine you signed in on. If that
machine is offline when the sign-in runs out, the others show that they are
waiting for it; signing in again on any machine also works. Google and other
local integrations sign in on each machine separately.
