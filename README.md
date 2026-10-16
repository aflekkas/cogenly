# Cogenly

One workspace for everything you do with AI: everyday chats, long-running coding tasks, and always-on agents. Bring your own Claude and Codex subscriptions, run it on your Mac or a VPS, and keep both in sync.

> [!WARNING]
> Cogenly is early and changing fast. There are no releases yet; run it from source.

## What's in it

- **Chats**: a plain list of conversations, grouped into folders and projects.
- **Tasks**: coding work against GitHub repos, with settle and snooze to keep the list clean.
- **Agents**: scheduled, always-on bots that each get a little face showing what they're doing (working, needs you, blocked, asleep).
- **Projects**: group chats, tasks, and agents together. Projects come from GitHub repos.
- **One set of tools**: a single MCP server that every agent shares.
- **Claude and Codex**: both run with full access, and follow-ups steer the running agent by default.

## Requirements

Install and sign in to at least one provider:

- Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
- Codex: install the [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`

## Run from source

Cogenly uses [Vite+](https://viteplus.dev), so install the `vp` CLI first:

```bash
curl -fsSL https://vite.plus | bash
```

Then:

```bash
vp i          # install dependencies
vp run dev    # start the server and web app
```

App data lives in `~/.cogenly`. Pass `--home-dir <dir>` to `vp run dev` to keep a separate dev profile.

Useful checks: `vp run typecheck`, `vp run lint`, `vp run test`.

## Docs

- [Architecture overview](./docs/internals/overview.md)
- [Development](./docs/operations/development.md)
- [Run it always-on (Mac service or VPS)](./docs/operations/always-on.md)
- Agent and contributor guidelines: [AGENTS.md](./AGENTS.md)

## Credits

Cogenly started as a fork of [T3 Code](https://github.com/pingdotgg/t3code) (MIT) and is now developed independently. The agent faces use [bloub](https://github.com/jeremy-prt/bloub) (MIT). The sidebar and navigation-rail design is inspired by [Dominik Scholz](https://x.com/dom_scholz)'s T3 Code redesign. See [LICENSE](./LICENSE) and the third-party notices for details.
