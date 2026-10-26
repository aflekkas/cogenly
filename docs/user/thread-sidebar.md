# Working with threads

Use a new thread for a separate task. Choose **New worktree** when its code changes
need a separate branch and working directory.

## Message an agent

An agent is a persistent specialist, such as "Spawn Ops", with its own conversation,
responsibility and permissions. The sidebar's **Agents** tab lists them. Each row shows its status
(**Needs approval**, **Needs you**, **Running** or **Idle**) and a
count only when decisions are waiting on you. Drag an agent up or down within its project, or
focus it and press `Alt+Up` or `Alt+Down`, to change its place. New agents arrive at the top of
their project. The server saves the order, like Work's.

Choose **New agent** in the sidebar or command palette to create one. Tell the builder
what the agent should take care of, in a sentence ("watch my GitHub PRs and summarize them
every morning"). It asks a short question only when it has to, then proposes the agent as a
card: its face, name, responsibility, when it runs, what it needs, and the model (your
default). Keep talking to adjust anything ("make it run on Mondays only"); the card
updates. **Create** makes the agent and opens its conversation, where it introduces itself
and gets going. Nothing creates an agent for you.

Opening an agent shows its chat. Ask it what is outstanding, give it direction, or
ask it to start Work. **Details** in its header opens everything else in a side sheet:

- **Responsibility**: its face, name, what it owns, and standing instructions.
- **Schedule**: its triggers, each in plain words, with a switch, **Run now** and
  **Delete**. **+** opens the full trigger editor.
- **Tools & permissions**: what it may do on its own.
- **Open items**: things to follow up on, owned by you, the agent or someone else,
  with due dates, projects, and links to where they came from. Items the agent
  finds stay **Proposed** until you confirm or dismiss them. **Mark done** asks
  what finished it, optionally with a link as evidence; done and dismissed items
  can be reopened. **Delete** removes an item and its history for good; dismiss it
  instead to keep a record. **History** on an item lists every status change: who
  made it, when, why, and any evidence. Pending approvals sit at the top, and also appear
  in the chat.
- **Recent activity**: each run with what woke it (your message, a trigger, an event, an
  approved action, or Work), its recorded status, model and summary, and what it
  did, such as items it proposed or Work it started. Work links open the session;
  event runs also link the Work, pull request or open item the event was about.
- **Memory**: facts it proposed wait there for you to confirm; see
  [Memory](./memory-and-export.md#memory).
- **Advanced**: notifications, the daily run cap, its home repository, and **Delete**.

Everything in Details can also be changed by telling the agent in its chat; what it
cannot do itself (a trigger, more permissions) it asks you to approve.

Agents work on their own across all of your projects and repositories, and can add
new projects. What they may do is set by permission switches: read, draft and start
Work are on for a new agent; the high-impact send, create PRs, merge, deploy and
delete stay off until you turn them on. An agent cannot grant itself anything.
When it wants to start Work, add a trigger, or change its permissions, it
asks, and you **Approve** or **Reject**. Approvals expire after seven days.

**Start Work…** at the top of Details starts a coding session in any repository, its
home repository first. Without the start Work permission the agent would ask you
first; starting it yourself approves that one session. The session runs in a new worktree and appears in **Work**, named by its
repository and marked with the agent's name.
The command palette also has **Start Work with …** and **Open items for …** for
each agent.

The badge on **Agents** counts decisions waiting for you across all agents:
approvals they asked for, and approvals or questions inside their runs. Unread
replies show as a dot on the agent instead.

Triggers wake an agent for one recorded run: on an interval, at a time, on a
webhook, or **When something happens**, such as PR checks failing, a PR merging,
Work finishing or becoming ready for review, or an open item coming due. An event
trigger can be limited to some projects, repositories, or Work you, a chat or an
agent started. Filters only narrow what wakes it, and a repeated event wakes it
once. Event triggers have no **Run now**; they run when the event happens. Add triggers under
**Details → Schedule**, by describing them when creating the agent, or in **Settings →
Scheduled tasks**. An agent can suggest one, but it is added only if you approve.

An agent uses the model picked in its chat, for its replies and its background runs.
A new agent starts on the model a new chat in its workspace would get. Agents are
always on: their triggers keep running, up to the daily run cap, and a run that fails
waits a little longer before the next one. To stop a trigger, turn it off under
**Schedule**. Messages sent while an agent is busy use its normal queue or steering
behavior.

An agent can also have a fallback chain: an ordered list of other provider
instances and models to run on when its main one stops it. If a background run
hits a usage limit ("You've hit your weekly limit") or finds that provider
signed out, the next run uses the next entry in the chain instead of waiting
on the same provider, and **Recent activity** shows which instance the run
actually used and why it switched. When the provider names a reset time, the
agent returns to its main instance then; otherwise it tries the main one
again after an hour. Other failures, and agents without a chain, behave as
before. Ask the agent in its chat to set or change its fallback chain, for
example "fall back to Codex if Claude hits its limit".

Coding work an agent starts appears in **Work** with your own threads, named by its
repository and marked with the agent's name.

## Start Work from a chat

When a chat turns into a coding task, hover a message and choose the hammer to hand
off the chat up to that message, or hand off the whole chat with **Start Work…** in
the thread's title or right-click menu, **Start Work from this thread in...** in the
command palette, or `mod+alt+s`. Pick a repository, or **No repository**, and the
session starts right away with the chat's model: in a new worktree when the
repository uses git, otherwise in its folder. It carries your recent requests from
the chat and a link back to it, and names itself like any new thread.

The chat keeps a **Work started** line for each session it handed off. The session's
header shows the chat or agent it came from and its status, such as **Running**,
**Needs input**, or **Ready for review**. You don't need to return to the chat.

The chat's agent can also hand work off itself when you ask for something that changes
things, such as editing a repository or uninstalling an app, or that runs for a long
time. Lookups stay in the chat. It picks a
repository, or **No project** for work on this machine, and shows a task card in the
chat. A card it only proposes waits for **Approve**; **Edit** lets you change where it
runs and what it's told first, and **Dismiss** can be undone with **Restore**. When you
clearly asked for the action, the agent may start the task right away. Either way the
card follows the task, has **Stop** while it runs, and when the task ends the chat's
agent tells you how it went. For a task whose result is all you need, the agent can ask
for its Work thread to settle once it completes, so it doesn't linger in your list; a
task that fails stays active. Un-settle the thread to continue there.

## Start a thread

On web and desktop, a new thread keeps the current project and carries your model
and mode selections, unless the destination project has its own model default.
Its branch and workspace mode come from your configured defaults. In **Work**,
**New task** starts in a new worktree unless the project, its `cogenly.json`, or
Settings choose a workspace mode. To continue in an existing worktree, use
**New thread in this worktree** from the branch toolbar.

When you change a new thread's project, Cogenly stays in the current environment
if that project exists there. Otherwise it selects an environment that has it.

### Chats

The **Chats** tab lists threads without a project, newest first under **Today**,
**Yesterday**, **Previous 7 days** and **Older**. Each heading shows how many chats it
holds; click it to fold the group away, and the sidebar remembers that per tab. **New chat** beside search, `mod+n`
while Chats is open, and **New chat** in the command palette all start one without a
project; they never open a repository. Opening **Chats** returns to the chat you last
had open there; the first time, or once that chat is archived or deleted, it shows your
most recent chat, or a new one when you have none. Every tab in the rail works the same
way, Settings included: switching away and back returns to where you were. A small dot marks a chat that is still running
or waiting on you. Older chats load as you scroll, and search covers all of them. Add
repositories from **Work** or the command palette.

A chat is a conversation; Work is a coding session in a repository. Chats run in
conversation mode: the agent answers directly and looks things up itself. It can run
quick read-only commands, such as searching files, reading git history or querying
`gh`, from the chat's project folder (or its own folder when it has no project), and
each command shows in the conversation. It doesn't edit repositories, install
anything or run long builds from a chat; it hands that work to a task instead.
Chat commands need full-access mode and the `enableAgentTerminals` preference. They also require a working local sandbox:
macOS uses the built-in `sandbox-exec`. On Linux, Cogenly installs the distro's
`bubblewrap` package during installation, updates, and background service setup
when running as root or with passwordless sudo. If elevation needs a password,
it prints the exact command to run. On Ubuntu/Debian:
`sudo apt-get update && sudo apt-get install -y bubblewrap`.
Settings → Machines → Health offers **Fix** for a missing or blocked sandbox;
`cogenly health --fix` and `cogenly security setup` do the same. After installation,
Cogenly checks confinement again and enables chat commands without a restart.
Hosts that block user namespaces or seccomp keep chat commands off.
On Windows or when the sandbox probe fails, commands are unavailable in chats;
use Work for command-based tasks.

The sandbox prevents local file writes except in a fresh private temporary folder.
It stays in effect for child processes and further input to the same terminal.
Network access remains available for lookups. The sandbox does **not** prevent
remote writes: chat agents are instructed never to run commands that change
remote state, such as sending messages, changing issues or pushing commits.

A chat's menu has **Start Work…**, rename, **Mark unread**, projects, copy and **Delete**,
which always asks first, while settling, snoozing, archiving, repository settings
and the branch and worktree controls, the right panel with its browser and device, and the
terminal panel belong to Work. When a
chat turns into code, **Start Work…** hands it to a new Work session. An agent's
conversation belongs to the agent: rename it or remove it from the agent's
**Details**.

### Start without a project

A thread does not need a project. To start one without a project, click **or
start without a project** under a new thread's heading, pick **No project** from
the project menu in that heading or from **New thread in...** in the command
palette, or press `mod+alt+n`. It starts on your current machine; before sending, pick another machine
from the machine menu to move it there. To move a draft into a project, pick the
project in the heading.

Work started in a project without a repository (**No repository (project
folder)** in the heading's repository menu) runs in the project's own folder, so
the files the agent makes sit with the project's other files.

Each thread without a project works in its own folder under `~/.cogenly/scratch` (the
`scratch` folder of your Cogenly data directory), named after its date, the first words
of its first message, and a short id, like
`2026-09-25-convert-these-pngs-to-webp-a1b2c3d4`. Deleting a thread keeps its
folder, so the files the agent wrote stay until you delete them. Branch and worktree controls stay hidden because
these folders are not Git repositories. This is unavailable when the data
directory itself sits inside a Git checkout.

### Start in the background

In a desktop browser or the desktop app, press `Cmd+Enter` on macOS or `Ctrl+Enter`
on Windows and Linux to start a new thread and immediately open another draft. The
next draft keeps the workspace mode and base branch you selected. With **New
worktree**, each background submission creates its own worktree.

To send the same prompt to several models on web or desktop, **Shift-click** models
in a new thread's model picker to add or remove them. A regular click returns to a
single model. Choose a base branch and send. Each selection starts a separate thread
and worktree while you stay in the new thread composer. This requires a Git project.

## Pin and reorder threads

Pin a thread from its menu to keep it above your active work.

On web and desktop, unpinning, settling, snoozing, and archiving a thread each show
a notification with **Undo** for five seconds. Undo restores the thread's previous
state, including its pinned position, and reopens an archived thread you were
viewing. Discarding an unsent draft from the sidebar works the same way: Undo brings
back its text and attachments. `mod+z` triggers the most recent Undo when no text field is focused; see
[Keybindings](./keybindings.md#commands-with-special-behavior).

Archived threads stay in **Settings → Archive**. Search them, then choose **Unarchive** to
bring one back to the sidebar or the trash button to delete it for good.

On web and desktop, you can also drag files from your computer onto any thread row:
the thread opens and the files are attached in its composer, ready for
your next message. The same per-message file limits apply as when attaching
files directly; see [Attach files](./composer.md#attach-files).

On web and desktop, pinning or unpinning a thread keeps the sidebar at your current
scroll position instead of following the thread to its new place in the list.

Settling a thread removes its pin.

On web and desktop, drag a thread between sections to change its state. Drag a thread up into
the pinned section to pin it at the spot you drop it; drag a pinned thread down into the active
list to unpin it. Dragging a thread onto the **Settled** header settles it, and dragging a settled
thread into the active list un-settles it. A snoozed thread can be dragged out of the snoozed
shelf, which wakes it, but threads cannot be dragged into the shelf because snoozing needs a wake
time. Dragging a pinned thread out of the pinned section does not ask for unpin confirmation.
Pinned and active boundary labels appear only while dragging, without moving the rows. The
other rows slide aside to show where the thread will land. When you cross into another section,
the dragged thread shows the action the drop performs, with its icon: **Pin**, **Unpin**,
**Settle**, **Un-settle**, or **Wake**. Its status and hover actions hide during the drag. A pinned
thread keeps its pin only while it stays in the pinned section; once it leaves, the badge takes
over. Reordering within the same section shows no badge. When there are no pins, drag to the top
edge to pin a thread. Section labels stay readable for the whole drag, and the section the
thread is over takes the accent color. Section labels also
identify empty sections and a collapsed settled shelf.

**Work** groups its cards under a heading per project, alphabetically, with **No project**
last. A card's project is the one you filed it in, else the project its repository belongs to.
Click a heading to fold its group away; the card you have open stays visible. In the first
filter, drag a card up or down within its project to change its place; the other cards slide
aside to show where it will land. With a card focused, `Alt+Up` and `Alt+Down` move it one
place. The server saves the order, so it survives a refresh and appears on your other connected devices. **Needs you**
lists its tasks in the same order; **Snoozed** lists them by when they come back and
**Settled** by when they settled, so cards don't move there.

Search is docked at the bottom of the sidebar by default: lists stack up toward it, and Work's
cards are drawn the other way up, so new Work arrives at the bottom of its project, nearest
search. To put search at the top and read lists down from it, with new Work at the top of its
project, set **Settings → Appearance → Sidebar layout** to **Top**. Your saved order is the same in both layouts; each device keeps
its own choice.

On web and desktop, the list also animates section changes made with thread actions such as
**Pin**, **Settle**, and **Snooze**. These transitions respect your system's reduced-motion
preference. While dragging, rows follow the insertion gap without replaying a second transition
after the drop.

New threads appear above the active threads you have arranged. Settling clears a thread's active
position, so using **Un-settle** returns it to the top. Pinning and snoozing preserve its active
position until you move it again. Thread activity does not change the order. The settled shelf
continues to use settlement time.

If dragging is unavailable for one environment, update the Cogenly server running in that
environment. Pinned and active reordering require server support. Threads from older servers keep
their default order until the server is updated.

To generate a fresh title from the conversation, choose **Rename…** in a thread's menu
and press the regenerate button at the end of the title field. To regenerate several at
once, select them and choose **Regenerate titles** from the selection's menu. The button
is missing while title generation is in progress or when the connected environment
needs a server update.

Agents connected through Cogenly can use the same server-owned metadata workflow to
rename a thread, regenerate its title, or link and unlink a pull request. These changes
appear on web and desktop without requiring the originating browser to remain
open.

### Fold working threads (beta)

Turn on **Settings → General → Working section (beta)** on web and desktop, or **Settings →
Thread behavior → Working section** on iOS and Android, to move threads that are working or
monitoring into a collapsed **Working** section below the active list. A thread returns to the top
of the active list when it finishes, fails, or needs an approval or answer. The Working section
lists the thread you last sent work to first. Pinned threads stay in the pinned section. Each
device keeps its own choice. Work does not fold: its first filter lists all tasks, running ones
included, and **Needs attention** lists the tasks waiting on you for an approval, an answer, or a
plan decision. A filter with nothing in it is dimmed and cannot be chosen; when the one you
are on empties, the list switches to the first filter that still has something.

While this is on, the active list is ordered by when each thread last came back to you, so you
cannot drag or move threads within it. Your saved order returns when you turn it off.

## Settle finished work

Choose **Settle thread** from its menu to move finished work out of the active list
without deleting the conversation. **Un-settle thread** restores it to active work.
Threads never settle on their own, however long they sit idle.
Manually settling an idle thread dismisses unanswered async questions without
sending an answer or restarting the agent. Settling also closes the thread's
terminals that wait at an idle prompt, and keeps their output. A project script you
started stays open while it runs a command. Agent-run terminals, including dev servers
and their child processes, stop when you settle, archive, or delete the thread.

Every shell command the agent runs appears in the terminal panel under the conversation
(see [Terminal](terminal.md)), newest first and labelled with the command. The panel never
opens by itself. Running commands stream live
and have a stop button. Finished ones stay listed with their exit status. You can scroll, select and copy
their output, and type into a command that still reads input. Cogenly does not open a
shell of its own there. Agent terminal commands require full-access/default mode. To
restore provider-native shells, set the server preference `enableAgentTerminals` to
`false` and restart provider sessions.

To reclaim disk space from settled work, turn on **Run in the thread's worktree when the
thread settles** for one of the project's actions, or set `"runOnSettle": true` on a
`cogenly.json` script, for example `cargo clean`. It runs each time a thread in its own
worktree settles, even if a terminal there still runs a
command such as a dev server. Threads in the project's main checkout skip it. Its terminal
closes when the command succeeds and stays open when it fails.

On web and desktop, press a thread's **Settle** button and drag up or down to
settle every thread in that section between it and the one you release on.
The **Un-settle** and **Wake** buttons work the same way in their sections.
Press `Escape` while dragging to cancel.

## Link a pull request

The server finds the PR for each unsettled thread's saved branch, even when your
apps are closed. Settled threads keep their saved links. Update the server if
automatic branch links do not appear.

On web and desktop, right-click a pull request link in a thread and choose
**Link to thread** to select a different PR. Use **Unlink from thread** on the
same link to return to the branch PR, if one exists.

## Organize threads in projects

A project, such as a client or a course, is a folder for related chats, Work and
repositories. A project can hold several repositories, but each repository and each
thread is in at most one project. Work goes in its repository's project unless you move
it. Projects are context only; they never change what an agent can access.

**When to make a project.** Make one when work spans several repositories, or is a big effort with its own
files, instructions and agents. A single repository, a side project or a class repo works
fine on its own: it stays under **No project**, and agents clone it there too. You can
always add a project later and move work into it.

If two projects created separately on paired machines have the same name, choose
**Merge** to move their contents into one project, or **Keep separate** to dismiss the
suggestion on every machine. Merging removes the source project everywhere and cannot
be undone automatically; files with conflicting names are kept under new names.

A new task's heading reads "What should we build in _project_ / _repository_?". Pick
the project there or in the composer's project control, and the task moves to that
project's most recently used repository, or to the project's folder when it has none.
The repository menu lists every repository in the project, on the machine the task runs on
(with **No project**, that machine's repositories). A repository the project has but this
machine doesn't reads **Clone to set up**: pick it to clone it here, and the task moves to it
once the clone lands. The command palette's **New thread in...** lists the same repositories
under **Not cloned here**; picking one clones it. A repository not cloned here still shows
its icon once any machine with a checkout has found it, or its owner's GitHub avatar until
then. A repository's **⋯** menu can remove it from this machine (the project
keeps it, so you can clone it again here or on another machine), move its folder into the
project's folder, or take it out of the project. **Add repository…** lists this machine's
other repositories and the project's GitHub repositories to clone in. **No repository
(project folder)** runs the task in the project's own folder instead. **Manage
repositories…** opens the project's page, which lists the same repositories.

Manage projects in **Settings → Projects** (or **Open projects** in the command palette,
or `mod+alt+4`). It shows every project as a card; open one for its page with its
repositories, recent chats and Work, agents, files and GitHub org. The GitHub org (the
button beside the project's name) is where agents and the repository picker look for its
repositories; **Sources** lists any other repositories it reaches. Use **Add repository** to bring one in
from this machine or GitHub (a repository already in another project asks before it moves),
click a **Clone to set up** row to clone it on this machine, a repository row's **⋯** menu
to remove it from this machine or the project, and the page's **⋯** menu to rename,
recolor, describe or delete the project. Deleting a project keeps its chats, Work and repositories; they are just no
longer in a folder. Start one with **New project** on the page or in the command palette.

Deleting a project also removes its folder if it is empty. If you put files in it, the
folder stays on disk and shows under **Leftover folders** at the bottom of **Settings →
Projects**, along with any other folder in your projects folder that no project uses.
Each machine lists its own. Open one to look inside, choose **Turn into project** to keep
working with it, or **Move to Trash**. You can put it back from the Trash. Cogenly cleans
up empty leftover folders by itself.

You can also ask an agent in any chat or Work to set a project up or change it: add a
repository, link GitHub, set the instructions its agents follow, rename or recolor it, or
archive it.

From a terminal on the computer running Cogenly, `cogenly project label` does the
same while Cogenly runs: `list`, `create <name> [--color <color>]`,
`rename <project> <name>`, `delete <project>`, and
`add-repo`/`remove-repo <project> <repository>`. Name a project by its name or id and
a repository by its folder or id; add `--json` for scripts. A folder Cogenly doesn't
track yet needs `cogenly project add <folder>` first.

When a project is done, right-click its card (or use the project's **⋯** menu) and
choose **Archive**. An archived project leaves every project picker and move menu, but
its chats, Work and agents stay as they are, and threads already in it still show its
name. Neither you nor an agent can add threads or repositories to it until you
unarchive it, though you can still move threads out. **Archived** at the top of
Settings → Projects lists them; choose **Unarchive** to bring one back.

To file a thread, right-click it and choose **Move to project…**, run **Move to project…**
from the command palette, or pick a project in the composer. Choose **Remove from
project** to take it out; Work then falls back to its repository's project. A filed chat also gets
[project context](./memory-and-export.md#project-context-in-chats).

**Chats** stays one list of titles by date. **Work** is one list of cards in the order you
arrange. Each card's first line names its project and repository ("Spawn Partners ·
platform"), the project alone for Work without a repository, or **No project**. Right-click
that line for a new thread in the repository, its project, and **Repository settings**. In **Agents**, right-click a project
heading for **New Agent in** that project. To start a thread on the open
thread's branch, run **New thread on** _branch_ from the command palette.

## Find and reference work

On web and desktop, open the command palette with `Cmd/Ctrl+K` or the rail's
**Search** button to search threads in every mode across connected environments,
and to open an agent by name. Message search starts after two characters and
includes your messages and final agent responses.

After two characters the palette also lists **Search everything** results: chats,
Work, agents, open items, projects, and pull requests, with the matching words in
bold. An open item opens in its agent's **Open items**, or in the thread it came
from; a project opens its project view; a pull request opens in your browser.

Use **Settings → Keybindings** to find or customize shortcuts for searching files
and copying a thread reference. A copied reference uses the thread's pull request
link when available, otherwise its thread ID. See [keybindings](./keybindings.md)
for custom configuration.

## Inspect agent work

**Limited** means the provider stopped on a usage or rate limit. The conversation
keeps the provider's explanation. Retry after the limit resets, or switch to
another provider instance.
On web and desktop, press **Resume** in an empty composer to continue a limited
or interrupted turn manually.
Queued messages stay saved while the limit blocks the thread. They run after
the continuation finishes. If the queue was held by a restart, resume it then.

When the provider reports a reset time, the thread continues on its own at the
reset. Choose **Don't resume** in the thread's banner, its sidebar menu, or the
command palette to opt this stop out, and **Resume at reset** to schedule it
again. Turn off **Settings → General → Threads → Resume after usage limits**
to make opting in the default instead. A stop whose reset already passed waits for
you to resume it. The environment must be running when the reset arrives; it
resumes overdue continuations after a restart. Sending a new message, archiving,
or settling the thread prevents a pending continuation from starting.

To hide a limited thread until its allowance returns, snooze it like any other
thread, or turn on **Settings → General → Threads → Snooze at usage limits** to
snooze limit stops until their reset by default. Snoozing does not change
whether the thread resumes; a snooze that outlasts the reset delays the
continuation until the thread wakes. Providers without a reset time offer manual
retry and the normal snooze choices.

On web and desktop, use **Agents** to follow work delegated to subagents.
Stop on a thread also stops the subagents it delegated to.

You can message a subagent from its own thread. While it runs, a subagent the
agent started with its own tools takes your message once its current work ends;
one started with `delegate_task` takes it the way any running thread does. When
your message produces a new result after the subagent reported, the parent
thread is told it has an updated result. When a subagent the agent started with
its own tools needs an approval or an answer, the parent thread asks for it.

Expand a tool call in the conversation to see its full command and output.
Summaries shorten shell wrappers and can still describe the latest call after it
finishes; the call's own result shows its status.

## Snooze until later

Choose **Snooze → Custom…** from a thread's menu and type when it should come
back, such as "tmrw", "friday 2pm" or "in 2 days", or pick a date and time in
your local time zone, or a duration in minutes, hours, or days. A weekday means
its next occurrence, and a day without a time means 9 AM. **Snooze thread…** in
the command palette (`mod+alt+z`) takes the same phrases. Durations start when
you confirm; one day means 24 hours. On web and desktop, you can also snooze
several selected threads together. Choose **Wake thread** to bring a thread back early.

You can also ask the agent, as in "snooze this until tomorrow" or "settle this",
and it snoozes, wakes or settles the thread in your environment's time zone.
