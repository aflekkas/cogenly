# Settings and project overrides

Settings apply to every machine you have paired: change one on your laptop and your server
gets it too. The "Settings for …" sentence at the top of a Settings page starts at
**All projects**. Choose a project there to override a setting for that project only; the
override covers every repository in the project, on every machine. Pages that only hold device
preferences, such as Appearance, don't show the sentence. The choice stays selected as you move
between categories or search for a setting.

A layers icon beside a row's title shows where the value comes from: the built-in default, the
value for all projects, the repository's `cogenly.json`, or the project's override. With a project
selected, an overridden row says **Overrides All projects** and its reset arrow returns it to the
value for all projects. Settings a project cannot override are shown read-only while a project is
selected.

Changing a value for all projects never touches a project's own override. When projects override
the setting you are editing, the layers icon counts them and lists each one with its value: click a
project to open it, or **Reset all** to make them follow All projects again.

Some settings belong to one machine, such as project actions, where its projects folder is,
its background activity, or its device hub. On a page with other settings these rows say which machine they change, such
as "on MacBook", and you can switch the machine there. Pages about one machine's own state,
Providers, Machines, Storage and Diagnostics, ask for a machine instead of a project: they show
your primary machine until you pick another. If projects still have their own provider switch or
worktree cleanup, a layers icon beside the provider's switch or the Worktrees heading lists them,
and **Reset all** returns them to the machine's setting.

## Worktree branch names

New worktree branches are named when the worktree is created: a short slug
from your first message under a `c/` prefix, such as `c/fix-login-redirect`.
The worktree folder is named by that slug and never moves.

In **Settings → Source control → Worktree branch naming**, choose a static prefix,
a model-selected semantic prefix such as `feat/` or `fix/`, or custom instructions
for the complete name. The static prefix defaults to `c/`; a trailing slash is
optional, and an empty prefix adds nothing. Invalid characters in a static prefix
are replaced with hyphens. Custom instructions are appended to
the naming prompt and can specify issue IDs, namespaces, and casing.

These settings apply when a client names a worktree branch with a temporary
name and Cogenly renames it. Select a project
to override them for it. Worktree directories keep their original names.
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

## Defaults and inheritance

Models holds the default model for new threads and the text generation model. New threads holds
the workspace, submodules and start-from-origin defaults. Projects holds the projects folder, where
new projects and clones go.
Integrations controls agent browser access and computer use. Source control contains automatic pull, the default
pull request merge method and the model that writes commit messages and pull requests. The same rows
edit the value for all projects or a project's override, depending on the project chosen at the top.

With a project selected, New threads also holds the project's actions. Editing them gives the
project its own list on the selected machine's repositories, and reset returns to that machine's
list for all projects. Actions never sync between machines; configure them separately on each one.
A repository's `cogenly.json` actions can be imported there.

The Repository page, opened from a repository in the sidebar, sits under Projects and holds that
repository's name, icon, checkouts and removal.

Settings a repository can also declare in `cogenly.json`, such as the workspace for new threads,
resolve in one order: a project override, then the value for all projects, then `cogenly.json`,
then the built-in default. Leave a setting on **Inherit** to let the next tier decide. A repository
that still has a `t3.json` and no `cogenly.json` is read the same way; rename the file when
convenient. Browser access and computer use changes apply when an agent session next starts.

New worktrees initialize git submodules recursively. If that step is slow because the repository
declares many nested submodules, set **Worktree submodules** in **Settings → New threads** (with a project
selected to override it there) to **Top level only** to stop at the ones the repository declares
itself, or **Skip** to leave them for a setup script. It resolves in the same order as the
workspace default: a `"worktreeSubmodules"` value in the `cogenly.json` of the branch being checked out
applies when the project and All projects are both on **Inherit**.

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
checks safety again. Project cleanup overrides still apply to Work thread retention.

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
with its configured upstream. Leave **All projects** to set the default or choose a project to override it.
Cogenly only pulls when it can fast-forward and the checkout has no changed files, untracked files,
or local commits. It skips checkouts on another branch or without an upstream. If a checkout has
local work, resolve it yourself before automatic pulls can resume.
