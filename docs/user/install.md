# Install Cogenly

Cogenly runs coding agents on your computer and lets you control them from its
desktop or web app. Set up the machine where the agents will work first.

## Requirements

You need an installed, authenticated provider before starting a thread. You can
launch Cogenly and configure providers afterwards.

## Desktop app (Mac)

Download the `.dmg` from [Cogenly releases](https://github.com/aflekkas/cogenly/releases/latest).
It is built for Apple Silicon Macs and updates itself.

### The `cogenly` command

The app includes the `cogenly` command-line tool. To run it from any terminal,
open **Settings → General → About** and choose **Install** next to the `cogenly`
command, or run **Install cogenly command line tool** from the command palette.
Then open a new terminal. The command uses the app's data and talks to the
app's running server, so `cogenly project list` shows the same projects as the
app.

Cogenly installs the command to `~/.local/bin`, which needs no password. If your
shell does not have `~/.local/bin` on its `PATH`, the row says so. You can then
choose `/usr/local/bin` instead (macOS asks for your password) or add
`~/.local/bin` to your `PATH`. If you move the app, the row shows the command
as out of date. Choose **Update** to fix it.

**Uninstall** removes the command. Cogenly never overwrites or removes a
`cogenly` file it did not install.

## Linux server (command line)

On a Linux machine (x64 or arm64), install the server and the `cogenly` command:

```bash
curl -fsSL https://raw.githubusercontent.com/aflekkas/cogenly/main/scripts/install.sh | sh
```

This puts `cogenly` in `~/.local/bin`. If your shell reports `command not found`
afterwards, that directory is not on your `PATH` yet; the installer prints the
line to add. Set `COGENLY_VERSION` to install an exact version, such as the one
your desktop app runs. The download is self-contained: the host needs no Node.js.

| Task                                  | Command                                                                           |
| ------------------------------------- | --------------------------------------------------------------------------------- |
| Start the server and open the web app | `cogenly`                                                                         |
| Start the server without a browser    | `cogenly serve`                                                                   |
| Keep it running in the background     | `cogenly service install` ([details](./background-service.md))                    |
| Pair another device                   | `cogenly pair` ([details](./remote-access.md#pair-over-a-lan-or-private-network)) |
| Move to the newest release            | `cogenly update`                                                                  |
| Reclaim database space                | `cogenly doctor` ([details](./background-service.md#reclaim-database-space))      |
| Remove it again                       | `cogenly uninstall`                                                               |

Run `cogenly --help` for the full reference. If `cogenly` reports an already
running server, connect to that server instead. Stop it before starting a
replacement, or use a different `--base-dir` for an independent server.

To run a server from source instead, see the
[README](https://github.com/aflekkas/cogenly#readme). `cogenly update` does not
apply to a source checkout; update it with `git pull` and a rebuild.

## Run Cogenly on a VPS

Agents, projects, and provider logins live on the VPS; your Mac only drives
them. Sign in to the providers on the VPS first (`claude auth login`,
`codex login`, `gh auth login`).

**Recommended: desktop SSH.** In the desktop app, open **Settings → Connections
→ Add environment**, choose **SSH**, and pick the host from your `~/.ssh/config`.
Cogenly connects and pairs without a token to copy. If the VPS has no Cogenly
yet, it downloads the release that matches your desktop app; if it already runs
one, it uses that. See [Desktop-managed SSH](./remote-access.md#desktop-managed-ssh).

To keep the server running when no desktop is connected, run
`cogenly service install` on the VPS once. The service listens on
`127.0.0.1:4773`; desktop SSH finds it and connects through the SSH tunnel.

**Manual fallback.** Install the server with the command above, then:

```bash
cogenly service install
cogenly auth pairing create --base-url http://127.0.0.1:14773
```

On your Mac, forward that port with `ssh -N -L 14773:127.0.0.1:4773 your-vps`
and paste the printed pairing URL into **Add environment**. (`cogenly pair`
prints the same kind of link for the server's own address, `127.0.0.1:4773`;
change its port to `14773` if you use it instead.) The environment connects
while the tunnel runs.
Keep port 4773 closed to the internet: it is plain HTTP. For a route that does
not need the tunnel, see [Tailscale HTTPS](./remote-access.md#tailscale-https).

### Open a project from a terminal

With the desktop app already running on the same machine:

```bash
cogenly app
```

This opens a new thread for the current directory, adding the project if needed.
Pass a path, such as `cogenly app ../my-project`, to open another directory. It requires
the desktop app, so a standalone server or an SSH session is not enough. If the
command cannot reach the app, start or update the desktop app and try again.

## Providers

Open **Settings → Providers** in the web or desktop app, select the environment,
and enable the provider you want. Installation, login, and configuration belong
to that environment's machine, even when you connect from a phone or another
computer.

| Provider | Install and authenticate                                                                                                                                  |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex    | [Connect with ChatGPT](./providers-codex.md#connect-with-chatgpt), or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`. |
| Claude   | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`.                                                              |
| Grok     | [Add a Grok instance](./providers-grok.md), install the Grok Build CLI, then run `grok login`.                                                            |

Provider CLIs must be on the server's `PATH`. If Cogenly cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Codex connected through ChatGPT can use its managed runtime.

Cogenly warns when a provider version has known compatibility problems with your
release. Check **Settings → Providers** on that environment for the recommended
version or range. When its package manager supports installing a specific version,
you can install the recommendation there. Otherwise use the provider's installer
on the environment's machine. An unlisted version is unverified.

When a provider CLI is behind its latest release, its provider card shows the
available version. **Update now** runs the installer that owns the CLI
(Homebrew, or a global npm, pnpm, Yarn, Bun, Volta, or Vite+ install), or the
CLI's own update command when Cogenly cannot tell. Update a CLI installed with
mise through mise. Homebrew installs
compare against the version Homebrew offers, which can trail the npm release by
a few hours.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, Cogenly does not display
their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [Grok](./providers-grok.md).

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a Linux or macOS host available.
- [Updating Cogenly](./updating.md): update the app and connected servers.
