# Settings

Settings are global and apply to every machine you have paired: change one on your laptop and
your server gets it too. Projects group your work; they don't have settings of their own. What
belongs to one project, such as its instructions, repositories and links, is on the project's page.

A setting you have changed shows a reset arrow beside its title that puts back the default.

Some settings belong to one machine, such as where its projects folder is, its background activity,
or its device hub. On a page with other settings these rows name their machine after the title,
such as "Background activity · MacBook". With more than one machine connected, pick another
machine there to change its value. Pages about one machine's own state,
Providers, Machines, Storage and Diagnostics, start with "Settings for" and a machine: they show
your primary machine until you pick another.

Before 0.3.2 a setting could be overridden for one project. Those overrides no longer apply:
every project now uses the global value. A repository's own actions moved to its Repository page.
The old per-project values are kept in `legacy-project-settings.json` beside `settings.json`.

## Notifications

Cogenly plays a short sound when an agent finishes, fails or needs you, unless it was a quick reply
in the thread you are looking at. Change this in **Settings → General → Notifications → Thread
notifications**: choose **Off**, or add desktop notifications.

## Providers on paired machines

Add or edit a provider in **Settings → Providers** and its identity and model preferences follow you to your paired machines. CLI locations and sensitive environment values stay with their machine; use the vault for shared secrets.

The provider's **Account** section lists each machine with its sign-in status: **Sign in**, **Change account** or **Sign out**. You don't need a terminal on that machine. Sign-in opens the provider's page in your browser on the device you're using: Codex shows a code to enter there and finishes by itself once you approve; Claude shows a code on its page for you to paste back. Each machine keeps an independent login, so a token refresh on one cannot consume a copied refresh token on another. Signing out affects only that machine. Credentials use each official CLI's storage. On Linux, Claude protects its credential file with file permissions; use an encrypted disk if you need encryption at rest.

The same sign-in opens wherever a signed-out provider gets in your way: the notice above the composer, the model picker, a turn that failed because the provider was signed out, and machine health. If you sent a message while signed out, it sends once sign-in finishes. An agent can ask you to sign in too; its card appears in the thread, and the agent continues when the machine is signed in.

A new additional account gets a separate CLI home on each machine. Muse and other providers that do not advertise in-app authentication still require their own setup on that machine.

## Worktree branch names

New worktree branches are named when the worktree is created: a short slug
from your first message under a `c/` prefix, such as `c/fix-login-redirect`.
The worktree folder is named by that slug and never moves.

In **Settings → Source control → Branch names**, choose a static prefix,
a model-selected semantic prefix such as `feat/` or `fix/`, or custom instructions
for the complete name. The static prefix defaults to `c/`; a trailing slash is
optional, and an empty prefix adds nothing. Invalid characters in a static prefix
are replaced with hyphens. Custom instructions are appended to
the naming prompt and can specify issue IDs, namespaces, and casing.

These settings apply when a client names a worktree branch with a temporary
name and Cogenly renames it. Worktree directories keep their original names.
If generation fails, or a custom name is invalid or already taken, the temporary
branch name remains.

## Webhook automations

In **Settings → Scheduled tasks**, choose **On webhook**
as a task's schedule to run it whenever another service calls its URL, such as
GitHub on a new pull request or a CI job that failed. A public URL needs a
[Cogenly Connect](remote-access.md) managed tunnel; after you save the task, copy
its URL from the editor. Without one, the editor shows only the URL's path.
**Rotate** replaces the URL and the old one stops working.

The prompt decides what the agent sees. Placeholders pull values out of the
request: `{{body.path}}` for a JSON or form field, `{{headers.name}}`,
`{{query.name}}`, `{{body}}` for the raw body, and `{{request}}` for everything.
For example, `Review this PR: {{body.pull_request.html_url}}` sends only the
pull request link. A placeholder with no value is left empty.

For GitHub, turn on **Require signature**, keep the header
`x-hub-signature-256`, hex encoding and the `sha256=` prefix, and enter the
same secret in the repository's webhook settings with content type
`application/json`. Requests without a valid signature are rejected. Set this
up on desktop or web.

On desktop and web, pick **Deliveries** from a task's menu to see recent
requests and the prompt each one produced.

If the environment is offline, the sender gets an error and nothing runs;
redeliver from the sender, such as GitHub's **Recent Deliveries**, once it is
back. To have Cogenly Connect keep requests instead, turn on **Hold webhooks while
offline** in **Settings → Connections**. Cogenly Connect then stores requests to a
Cogenly Connect URL for up to 24 hours and delivers them when the environment
returns. Leave it off if you don't want request bodies stored outside your
machine. To skip requests that waited too long, set **Skip requests older
than** on the task.

## Defaults

Models holds the default model for new threads and the text generation model. New threads holds
the workspace, submodules and start-from-origin defaults. Projects holds the projects folder, where
new projects and clones go.
Integrations controls agent browser access and computer use. Source control contains automatic pull, the default
pull request merge method and the model that writes commit messages and pull requests.

The Repository page, opened from a repository in the sidebar, sits under Projects and holds that
repository's name, icon, actions, checkouts and removal. Actions are commands that run in the
repository or its worktrees, with optional shortcuts. Editing them updates every checkout of the
repository, so connect each machine that has one first. A repository's `cogenly.json` actions can
be imported there.

Settings a repository can also declare in `cogenly.json`, such as the workspace for new threads,
use your setting when you set one, then `cogenly.json`, then the built-in default. Reset a setting
to let the repository's file decide. A repository that still has a `t3.json` and no
`cogenly.json` is read the same way; rename the file when convenient. Browser access and computer
use changes apply when an agent session next starts.

New worktrees initialize git submodules recursively. If that step is slow because the repository
declares many nested submodules, set **Worktree submodules** in **Settings → New threads** to **Top
level only** to stop at the ones the repository declares itself, or **Skip** to leave them for a
setup script. It resolves in the same order as the workspace default: a `"worktreeSubmodules"` value
in the `cogenly.json` of the branch being checked out applies while the setting is unset.

## Worktree location

New worktrees go in the `.worktrees` folder of the repository's project folder. A repository in no
project uses the `worktrees` folder of the Cogenly home directory. To put them somewhere else,
such as another drive, set **Settings → Storage → Worktree location** to an absolute path like
`D:\worktrees` or `~/worktrees`. The setting is per machine. Existing worktrees stay where they
are, and cleanup covers both the default folder and the custom one.

## Storage cleanup

Open **Settings → Storage** and pick a machine to see allocated disk usage and preview cleanup.
Volume usage counts shared blocks once. APFS clones and reflinks make exact per-category disk use unavailable without deletion; those category sizes are shown as unknown, with file counts. Cleanup reports the change in available volume space instead of adding directory sizes.

Completed delegated tasks release their separate worktrees when safe. Settled and archived Work
threads keep theirs for 7 days by default. Active-thread retention is off until you choose an
inactivity period. Branches, conversation history and checkpoints stay. Starting another turn
recreates a removed checkout from its branch and runs the project's setup script.

Cleanup keeps worktrees with edits, untracked files, stashes, live sessions, running processes,
pending work or other live thread references. Unknown ignored files such as a real `.env` also
block removal. **Keep ignored local files too** additionally protects ignored build output and
dev data copies. Rebuildable dependencies and isolated dev data are otherwise removed with the
checkout. Cleanup never deletes the branch or an unreferenced worktree folder.

Optional dependency pruning removes ignored `node_modules`, `.turbo` and `dist` from idle
worktrees after the chosen period. It is off by default: package stores often share these files,
so removing them may reclaim little disk space. Project setup runs before the next turn.

Cleanup runs at startup, hourly, when its rules change, and after delegated task completion.
Choose **Preview cleanup**, review eligible items and blockers, then **Clean up now**. Execution
checks safety again.

Nightly backups keep the newest two complete snapshots by default. Storage shows backup files and the database file size; **Clean up now** uses the same backup retention. Cleanup keeps conversation history and does not compact the database.

Browser captures and inactive rotated logs expire after 14 days by default. Current logs,
message attachments and browser profiles are kept. Expired capture links stop working.
Agents can use `storage_status` and `storage_cleanup` (dry run by default). On the machine,
`cogenly doctor --storage` reports usage, `--dry-run` previews cleanup, and `--fix` applies it
through the running server.

## Repository icons

Open the repository's Repository page from the sidebar to choose an icon, emoji, monogram, or image. The choice applies to
every checkout in the repository group and appears on connected clients. Choose **Automatic** to let
Cogenly detect an icon again.

Choose **Monogram** in the icon picker to set one or two letters or numbers and a color.

When no image is found, web and desktop show a two-character monogram with a color
from the icon palette, derived from the saved repository name. For example, `Nebula` becomes `NA`,
`Silver Orchard` becomes `SO`, and `M7 Forge` becomes `M7`.

## Keep the default branch current

In Source control, enable **Automatically pull** to keep the default-branch checkout up to date
with its configured upstream.
Cogenly only pulls when it can fast-forward and the checkout has no changed files, untracked files,
or local commits. It skips checkouts on another branch or without an upstream. If a checkout has
local work, resolve it yourself before automatic pulls can resume.
