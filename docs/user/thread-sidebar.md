# Working with threads

Use a new thread for a separate task. Choose **New worktree** when its code changes
need a separate branch and working directory.

## Message an agent

An agent is a persistent specialist, such as "Spawn Ops", with its own conversation,
responsibility and permissions. The sidebar's **Agents** tab lists them under the
projects they may access, with **Other** for the rest. Each row shows its status
(**Needs approval**, **Needs you**, **Running**, **Paused** or **Enabled**) and a
count only when decisions are waiting on you.

Choose **New agent** in the sidebar or command palette to create one. Give it a
name, a responsibility, the projects it may access, and an autonomy level. Nothing
creates an agent for you.

Opening an agent shows its chat. Ask it what is outstanding, give it direction, or
ask it to start Work. The tabs above the chat hold the rest:

- **Activity**: each run with what woke it (your message, a trigger, an approved
  action, or Work), its recorded status, model and summary, and what it did, such
  as items it proposed or Work it started. Work links open the session.
- **Open items**: things to follow up on, owned by you, the agent or someone else,
  with due dates, projects, and links to where they came from. Items the agent
  finds stay **Proposed** until you confirm or dismiss them. **Mark done** asks
  what finished it, optionally with a link as evidence; done and dismissed items
  can be reopened. Pending approvals sit at the top, and also appear in the chat.
- **Responsibilities**: the agent's mission, instructions, model, project access,
  autonomy, permissions, notifications, daily run cap, triggers, memory, **Pause**,
  and **Delete**.

Project tags give an agent context only. It can read and propose items only in the
projects granted under **Project scope**; a tag on a chat never grants access.

Autonomy decides how far it goes on its own:

- **Observe** reads and summarizes, and never changes anything.
- **Propose** (the default) drafts plans and items, and asks before starting Work.
- **Execute bounded work** starts Work in its home repository, the workspace
  chosen when it was created, within its permissions, and asks for anything else.
- **Autonomous within policy** also runs its recurring work within its
  permissions without asking. Work in another repository still needs you.

Permissions are separate switches: read, draft, start Work, and the high-impact
send, create PRs, merge, deploy and delete. An agent cannot grant itself anything.
When it wants to start Work, add a recurring trigger, or change its permissions, it
asks, and you **Approve** or **Reject**. Approvals expire after seven days.

**Start Work** in the agent's header starts a coding session in a repository linked
to one of its granted projects. The session runs in a new worktree and appears in
**Work** under its repository, marked with the agent's name.

**Pause** stops triggers and background runs; you can still chat. Messages sent
while an agent is busy use its normal queue or steering behavior.

Coding work an agent starts appears in **Work** with your own threads, under its
repository and marked with the agent's name.

## Start Work from a chat

When a chat turns into a coding task, choose **Start Work…** from the thread's title
menu or right-click menu, run **Start Work from this thread** in the command palette,
or press `mod+alt+s`. Cogenly drafts a title and scope from the conversation and
suggests a repository. Edit any of them, then choose a new worktree or the local
checkout and, optionally, a different model. The session starts from the scope you
approved, with a link back to the chat rather than the whole transcript.

The chat keeps a **Work started** line for each session it handed off. The session's
header shows the chat or agent it came from and its status, such as **Running**,
**Needs input**, or **Ready for review**. You don't need to return to the chat.

## Start a thread

On web and desktop, a new thread keeps the current project and carries your model
and mode selections, unless the destination project has its own model default.
Its branch and workspace mode come from your configured defaults. In **Work**,
**New work** starts in a new worktree unless the project, its `t3.json`, or
Settings choose a workspace mode. To continue in an existing worktree, use
**New thread in this worktree** from the branch toolbar.

When you change a new thread's project, Cogenly stays in the current environment
if that project exists there. Otherwise it selects an environment that has it.

### Start without a project

A thread does not need a project. To start one without a project, click **or
start without a project** under a new thread's heading, pick **No project** from
the project menu in that heading or from **New thread in...** in the command
palette, or press `mod+alt+n`. It starts on your current machine; before sending, pick another machine
from the machine menu to move it there. To move a draft into a project, pick the
project in the heading.

Each thread without a project works in its own folder under `~/.cogenly/scratch` (the
`scratch` folder of your T3 data directory), named after its date, the first words
of its first message, and a short id, like
`2026-09-25-convert-these-pngs-to-webp-a1b2c3d4`. Deleting a thread keeps its
folder, so the files the agent wrote stay until you delete them. Branch, worktree, and diff controls stay hidden because
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

On web and desktop, you can also drag files from your computer onto any thread row:
the thread opens and the files are attached in its composer, ready for
your next message. The same per-message file limits apply as when attaching
files directly; see [Attach files](./composer.md#attach-files).

On web and desktop, pinning or unpinning a thread keeps the sidebar at your current
scroll position instead of following the thread to its new place in the list.

Pinning does not prevent automatic settlement. Settling a thread removes its pin.

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

Drag within the pinned or active section to change its order. Other rows slide aside to show the
spot where the thread will land. Drops into either section keep the position you choose.
**Move up** and **Move down** are also available in the thread menu. The server
saves the order, so it survives a refresh and appears on your other connected devices.

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

To generate a fresh title from the conversation, open a thread's menu and choose
**Regenerate title**. The action is unavailable while title generation is in progress
or when the connected environment needs a server update.

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
device keeps its own choice.

While this is on, the active list is ordered by when each thread last came back to you, so you
cannot drag or move threads within it. Your saved order returns when you turn it off.

## Settle finished work

Choose **Settle thread** from its menu to move finished work out of the active list
without deleting the conversation. **Un-settle thread** restores it to active work
and prevents automatic settlement until new activity resumes the usual rules.
Manually settling an idle thread dismisses unanswered async questions without
sending an answer or restarting the agent. Settling also closes the thread's
terminals that wait at an idle prompt, and keeps their output. A project script you
started stays open while it runs a command. Agent-run terminals, including dev servers
and their child processes, stop when you settle, archive, or delete the thread.

Every shell command the agent runs appears in the right panel's **Terminal** tab, newest
first and labelled with the command. The tab opens when the agent starts a command,
without taking focus from the composer. Running commands stream live and have a stop
button. Finished ones stay listed with their exit status. You can scroll, select and copy
their output, and type into a command that still reads input. Cogenly does not open a
shell of its own there. Agent terminal commands require full-access/default mode. To
restore provider-native shells, set the server preference `enableAgentTerminals` to
`false` and restart provider sessions.

To reclaim disk space from settled work, turn on **Run in the thread's worktree when the
thread settles** for one of the project's actions, or set `"runOnSettle": true` on a
`t3.json` script, for example `cargo clean`. It runs each time a thread in its own
worktree settles, manually or automatically, even if a terminal there still runs a
command such as a dev server. Threads in the project's main checkout skip it. Its terminal
closes when the command succeeds and stays open when it fails.

On web and desktop, press a thread's **Settle** button and drag up or down to
settle every thread in that section between it and the one you release on.
The **Un-settle** and **Wake** buttons work the same way in their sections.
Press `Escape` while dragging to cancel.

By default, environments settle inactive threads after three days and settle
threads whose pull request merged. A closed pull request can also settle an idle
thread. Work in progress, pending questions or approvals, and live background work
prevent automatic settlement. An open pull request does not prevent inactivity
settlement unless you turn on **Keep threads with a PR** in **Settings → General**,
but an old closed or merged pull request does not settle work you
resumed after it closed. Only your own messages count as resuming. A turn that
finished background work or a pull request watch starts on its own does not.

To keep one thread out of the settled shelf no matter how long it sits idle, open its menu,
choose **Auto-settle behavior**, and pick **Disabled**. The current option is checked. Pick
**Enabled** to return to the usual rules. Manual settle, snooze, and archive still work while it
is disabled.

Change these rules in **Settings → General** on web and desktop.
They continue to run when your apps are closed. On web and desktop, choose an environment at the
top to change only its rules, or **All environments** to update connected environments together.
Mixed values show where the selected environments disagree. Offline environments
and older servers keep their previous values. Changing a rule does not reopen
already settled threads.

## Link a pull request

The server finds the PR for each unsettled thread's saved branch, even when your
apps are closed. Settled threads keep their saved links. Update the server if
automatic branch links do not appear.

On web and desktop, right-click a pull request link in a thread and choose
**Link to thread** to select a different PR. Use **Unlink from thread** on the
same link to return to the branch PR, if one exists.
The linked pull request participates in automatic settlement.

## Tag threads with projects

A project, such as a client or a course, is a tag for related chats and Work. It is
separate from the repository a thread runs in: one project can link several
repositories, and a chat can carry several projects or none. Tags organize and
suggest context only; they never change what an agent can access. An agent's access
comes only from its own project scope.

Create, recolor, describe, and delete projects, and link their repositories, in
**Settings → Projects**, or with **New project** and **Manage projects** in the
command palette. Deleting a project removes its tag from threads but keeps the threads.

To tag a thread, click the tag button beside its title, or run **Edit this thread's
projects** from the command palette. Pick projects to add or remove them, type a new
name to create one, or choose **No project** to clear them. After a thread's first
reply, Cogenly may suggest projects from its repository and wording. Suggestions
show outlined and do nothing until you accept them; a dismissed suggestion is not
offered again for that thread.

**Chats** stays one list by date. Each chat shows one of its projects, and the
filter button beside search narrows the list to one project. **Work** groups
repositories under the projects that link them, so a repository linked to two
projects appears under both. Repositories without a project come last under
**Other repositories**.

## Find and reference work

On web and desktop, open the command palette with `Cmd/Ctrl+K` or the rail's
**Search** button to search threads in every mode across connected environments,
and to open an agent by name. Message search starts after two characters and
includes your messages and final agent responses.

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

When the provider reports a reset time, choose **Resume at reset** to schedule a
continuation. You can cancel it from the thread. Enable **Auto-resume limited
threads** in **Settings → General** on web and desktop, to schedule limit stops by default.
The environment must be running when the reset arrives; it resumes overdue
continuations after a restart. Sending a new message, archiving, or settling the
thread prevents a pending continuation from starting.

Choose **Snooze until reset** to hide the thread until its allowance returns.
Snooze and auto-resume are independent: snooze alone wakes the thread without
sending a message; enabling both wakes and continues it. **Wake now** cancels
the snooze. Enable **Snooze limited threads** in thread behavior settings to
snooze limit stops by default. Providers without a reset time offer manual
retry and the normal snooze choices.

On web and desktop, use **Agents** to follow work delegated to subagents.
Stop on a thread also stops the subagents it delegated to.

Subagent threads started by the agent can't take messages; message the parent
thread instead. When such a subagent needs an approval or an answer, the parent
thread asks for it.

Expand a tool call in the conversation to see its full command and output.
Summaries shorten shell wrappers and can still describe the latest call after it
finishes; the call's own result shows its status.

## Snooze until later

Choose **Snooze → Custom…** from a thread's menu to pick a date and time in your
local time zone, or a duration in minutes, hours, or days. Durations start when
you confirm; one day means 24 hours. On web and desktop, you can also snooze
several selected threads together. Choose **Wake thread** to bring a thread back early.
