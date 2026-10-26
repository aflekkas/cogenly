# Cogenly

One workspace for chats, coding tasks and always-on agents. Cogenly runs the Claude Code and Codex CLIs with your own subscriptions, and you use it from the desktop app or a browser. Run it on your Mac, on a Linux server, or both: paired machines share one set of conversations, projects and settings.

## What's in it

- **Chats, Work and Agents.** Chats are conversations. Work is coding in a repository, with a worktree, diffs and pull requests. Agents are persistent assistants with their own conversation, triggers and schedules. See [Agents](./docs/user/agents.md).
- **Memory.** Agents propose facts you confirm, keep a core memory that goes with every turn, and carry a handoff brief across model and session changes. Agents can fall back to another provider when one hits its usage limit. See [Memory](./docs/user/memory-and-export.md).
- **Vault.** Logins, API keys, cards and notes, encrypted on your machine. Agents fill them into pages without seeing the values, and ask for a missing login with a sign-in card in the thread. See [Vault](./docs/user/vault.md).
- **Integrations.** Ask an agent to connect Gmail, Wispr Flow or another service or MCP server, and it does the setup for you. See [Integrations](./docs/user/integrations.md).
- **Collaborative browser.** You and your agents share the same browser tabs, and you can take control at any time. You can import sign-ins from another browser. See [Browser](./docs/user/remote-access.md#browser-on-a-remote-environment) and [Importing sign-ins](./docs/user/browser-import.md).
- **Computer use.** On a Mac, agents can operate your other apps. See [Computer use](./docs/user/computer-use.md).
- **Paired machines.** Pick one always-on machine as the hub and pair the others with it. Conversations, projects, memory, settings and agents sync across them. A thread runs on one machine, and you can follow it from any of them. See [Machines](./docs/user/machines.md).
- **Cloud subagents.** An agent can delegate work to another paired machine, then get the result back. See [Machines](./docs/user/machines.md).
- **Providers.** Claude and Codex, plus Muse Code and Grok. See [Install](./docs/user/install.md#providers).

## Install

Install at least one provider CLI (Claude Code or Codex) on the machine that runs your agents, then sign it in from **Settings → Providers**.

**Mac.** Download the `.dmg` from [the latest release](https://github.com/alexandros-lekkas/cogenly/releases/latest). It is built for Apple Silicon, runs its own server and updates itself. To install the `cogenly` command, open **Settings → General → About**.

**Linux server** (x64 or arm64):

```bash
curl -fsSL https://raw.githubusercontent.com/alexandros-lekkas/cogenly/main/scripts/install.sh | sh
cogenly service install   # keep it running in the background
```

Connect to the server from the desktop app with **Settings → Connections → Connect a machine**. See [Run Cogenly on a VPS](./docs/user/install.md#run-cogenly-on-a-vps).

Useful commands:

| Command                                           | What it does                                    |
| ------------------------------------------------- | ----------------------------------------------- |
| `cogenly update`                                  | Move to the newest release                      |
| `cogenly machines pair` / `cogenly machines join` | Pair a machine with a hub from the terminal     |
| `cogenly health`                                  | Check this machine; `--fix` repairs what it can |
| `cogenly browser import-cookies`                  | Copy sign-ins from a local browser into Cogenly |
| `cogenly --help`                                  | Everything else                                 |

## Update

Open **Updates** at the bottom left of the app and choose **Update all**. This updates providers, every connected server and the desktop app in one step. On a Linux server you can also run `cogenly update`. See [Updating](./docs/user/updating.md).

## Docs

User guides are in [docs/user](./docs/user). Start with [Install](./docs/user/install.md), [Machines](./docs/user/machines.md) and [Agents](./docs/user/agents.md).

Contributing or running from source: [Development](./docs/operations/development.md).

## Credits

Cogenly started as a fork of [T3 Code](https://github.com/pingdotgg/t3code) and is now developed independently. The agent faces use [bloub](https://github.com/jeremy-prt/bloub). The sidebar and navigation rail were inspired by [Dominik Scholz](https://x.com/dom_scholz)'s T3 Code redesign. MIT licensed; see [LICENSE](./LICENSE).
