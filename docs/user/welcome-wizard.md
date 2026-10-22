# Welcome wizard

Cogenly shows a setup flow when you open a new installation or connect to the
hosted app for the first time. Existing workspaces skip this flow.

## This computer is set up for you

When you open the desktop app, or Cogenly served by `cogenly serve` on your
computer, setup uses that computer right away. It is already connected, so
setup goes straight to checking your agents. Add more computers later in
**Settings → Connections**.

## Connect a computer (hosted app)

The hosted app has no computer of its own, so setup starts by connecting one.
Select one or more computers to set up.

- **Cogenly Connect** connects computers that are signed in to your account.
  [Install the CLI](./install.md#command-line) and run `cogenly connect` on each
  computer you want to add, then start Cogenly or run `cogenly serve` so the
  computer stays available.
- **Add a computer** connects directly to a server on your network or tailnet.
  Start the server with `cogenly serve`, then run `cogenly pair --tailscale` and paste
  the pairing link. You can also run `cogenly serve --host <address>` and use
  `cogenly pair` when the server is already reachable on your network.

Saved computers and computers discovered through Cogenly Connect are selected by
default. Uncheck any you do not want to set up; this does not disconnect them.
Continue when your selected computers are connected. Setup checks
agents across the selected computers, then offers project import grouped by computer.

If your own computer cannot connect during setup, Cogenly shows this step too,
so you can pick another computer.

If Cogenly cannot confirm the workspace during startup, the setup flow shows
**Still connecting** instead of opening the app. Select **Reload** to try again.

If Cogenly cannot read your saved settings, it shows **Could not read settings**.
Select **Retry** after storage becomes available. Setup does not replace
unreadable settings with defaults.

## Check your agents

Cogenly checks each selected computer for Claude Code and Codex. If an agent is
not installed or signed in, select its action to open a terminal with the
correct command ready to run. Install uses the vendor's own installer, which
keeps **Update now** working in Settings. Other providers can be enabled in
Settings.

The setup terminal uses the home directory and environment configured for the
selected provider instance. Sensitive values remain redacted in Settings and
terminal metadata while the terminal process can use them.

## Bring your projects over from T3 Code

If Cogenly finds T3 Code on the computer, setup offers **Bring your projects
and chats over from T3 Code**. It imports each project's full history, subagent
threads, attachments, and providers, the same as **Settings → Import**. See
[Importing from T3 Code](./importing-from-t3-code.md). T3 Code can stay open.

In that case setup does not offer the Claude Code and Codex session import
below by default, because it reads the same conversations and would add a
second, shorter copy of each. Select **Or import raw Claude Code and Codex
sessions** only for conversations you had outside T3 Code.

You can skip this step and import later from **Settings → Import**.

## Import your projects

Without T3 Code, Cogenly finds directories that Claude Code or Codex has used. Git repositories
are listed first, newest activity on top. When the remote is on GitHub, the
group shows the repository as `owner/name`. Clones with the same remote share
one group. Directories that are not git repositories sit under "Other folders".

The default selection includes git repositories active within the last 30 days
with at least three conversations. Use the checkboxes, or "Select all" and
"Select none", to change the selection. Linked git worktrees, Codex scratch
directories under `Documents/Codex`, and anything under `Downloads` are not
offered.

A large or malformed history can reach the scan limit. Cogenly keeps the
projects it found and warns when projects or conversations may be missing.

Imported projects include Codex and Claude conversations active within the last
30 days. You can continue those conversations in Cogenly.

Conversation import is best effort. Cogenly keeps the first user prompt and the
newest remaining visible user and assistant messages, with 200 messages total.
It omits tool activity and attachments. For Codex, it omits generated setup
context only when a canonical user event and a valid shared turn ID identify the
same user turn. Ambiguous legacy or response-only context stays in the imported
conversation so Cogenly does not remove user text. It reads one conversation at
a time and skips files larger than 16 MiB. It ignores malformed records and skips
unreadable or unparseable conversations.

Each import attempt reads up to 100 conversation files and 64 MiB per project,
with up to 100,000 input records. Run import again to continue a large batch.
Completed conversations are not imported again. You can continue without the
remaining history.

You can continue without configuring agents or importing projects, or return to an earlier step
using the setup progress bar. Navigation pauses while an import is running.

## Set up from the terminal

`cogenly setup` runs the same setup in a terminal: it shows which agents are
installed and signed in, adds more Claude or Codex accounts with their own
config folders, picks the default model for new chats, imports from T3 Code,
and can import raw Claude Code and Codex sessions. It finishes with a summary.
Run it again any time.

It works whether Cogenly is running or not, and T3 Code can stay open. While
Cogenly runs, setup makes its changes through it, so nothing restarts and
running agents aren't interrupted. The raw session import needs Cogenly
running.

For scripts and agents, `--yes` skips every question and does only what the
flags say:

```sh
cogenly setup --yes --import-t3 --projects cogenly,site --settings
cogenly setup --yes --claude-home claude-personal=~/.claude_personal \
  --default-model claude-personal:claude-opus-4-1
```

- `--import-t3` imports from T3 Code; `--projects` picks projects by T3 id,
  title, or folder (default: every project with threads, except Scratch);
  `--settings` also brings keybindings and models; `--dry-run` only reports.
- `--claude-home [id=]folder` and `--codex-home [id=]folder` add an account.
  Without an id, one is made from the folder, such as `claude-personal`.
- `--default-model instance:model` sets the default model for new chats.
- `--sessions all` or `--sessions <folder,folder>` imports raw sessions.
