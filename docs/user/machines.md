# Pair your machines

Pair your Cogenly servers to use one Cogenly across them. Choose an always-on
machine as the hub; your other computers connect out to it. Each machine can
join one hub. Paired machines sync project names, instructions, archive state,
repository remotes and source links, agent profiles, fallback chains and
scheduled-task configuration, and every conversation. They also sync your
settings, including appearance, keybindings,
notification preferences and composer behavior. Settings that describe one machine
stay on it: provider setup and sign-ins, folders such as the projects root,
storage and backups, background activity, and devices. Changes made while a
machine is offline catch up when it reconnects. A machine on an older version
keeps syncing and picks up anything newer once it updates.

Agents and schedule timers run only on their owner machine. A schedule can
start each fresh conversation on another machine. New owners default to the
online hub, or this machine when the hub is offline; existing ones keep the machine they were created on until you
[move them](#move-threads-and-projects). Editing an agent profile from another machine sends the change to its owner.
The owner must be online to save the edit; an offline notice identifies which machine to reconnect.
Changes never start a second copy. Provider sign-ins and an agent's current fallback position stay on the
owner.

Repository checkouts and worktrees stay local, but every machine lists all of a
project's repositories. One that is not on this machine yet is marked as needing
a clone. Pick it, and it clones into the project's folder on this machine;
[moving a project](#move-threads-and-projects) clones all of them there. A
repository's folder is named after the repository, so it lands in the same
place everywhere. Removing a repository from one machine frees the disk space
and keeps it in the project, so you can clone it back later. Memory, settings and web integration definitions sync between paired machines. Share the vault to sync web sign-ins too; see [Vault on several machines](vault.md#vault-on-several-machines). Local integrations, including Google Workspace, sign in on each machine. Resource files stay local. Matching
project names are kept separately until you choose how to combine them.

## Your conversations on every machine

Chats, Work and agent conversations show up on every paired machine. Each one
runs on one machine, shown as "Runs on" in the thread header. Open it from any
machine to read it, follow it live, or send a message: the message runs on the
machine that runs the thread. If that machine is offline, sending fails with
a notice instead of waiting; reading still works. Attachments open from any
machine and are copied over the first time you view them.

To start a conversation on another machine, pick it in the composer's **Run
on** control before you send; every paired machine is listed, even one you are
not connected to. A new conversation runs on the machine that has the project's
repository unless you pick another. A machine without the repository clones it
first. If the machine you picked is offline, nothing starts and your draft
stays as it was; the notice offers to run it on this machine instead.

Start Work asks which machine to use after you choose its repository. You can
also choose a machine when creating an agent or editing a schedule. A schedule
bound to an existing conversation follows that conversation instead. A fresh
scheduled conversation whose target is offline fails that run; it is not queued.

Agents can name a paired machine with `machine` on `thread_launch`,
`create_threads`, `work_start`, `delegate_task`, and `schedule_task` (or when
updating a schedule). Names and environment IDs work; `this` means the machine
the agent runs on and `auto` means the hub. Isolated delegated work carries the
parent's committed code to the target. Its committed result branch can come
back when the parent reads the task result, without a push; uncommitted changes
stay on their original machine.

## Fork a thread to another machine

Choose **Fork to** in a thread's menu, or **Fork to <machine>** in the command
palette, to continue a copy on another machine. The fork stays in the same
project and repository, cloned on the target if needed, at the source's pushed
branch and commit. Its conversation becomes context for a fresh provider
session; the original thread stays where it is and keeps all its work.

If the source has unpushed commits or uncommitted changes, Cogenly asks you to
commit and push them or explicitly **Start from last pushed commit**. Local
work stays on the source machine. Conflicting target commits or edits must be
resolved before the fork can start; they are never overwritten. Agents use
`thread_fork` with `machine`, and keep the same `clientRequestId` when retrying.

## Move threads and projects

Move threads to the machine you want them to run on, for example everything
from a laptop to an always-on server. Right-click a thread, or several selected
threads, and choose **Move to**; the command palette offers the same for the
open thread. A project's menu has **Move project to**. Moving a project clones
each repository it links onto the new machine, using that machine's GitHub
sign-in, then moves its threads and agents. When the new machine already has a
checkout of one of those repositories outside any project, that checkout joins
the project where it is, with the threads already working in it, instead of a
second clone. Moving a single thread clones its repository too when the project
links it. Chats without a project, including ones imported from T3 Code, land
in the new machine's "No project". An agent moves with its schedules.

From the terminal, on any paired machine:

```sh
cogenly machines move --from 'MacBook' --to 'Cloud server · my-host'
cogenly machines move --project athens-racing --to 'Cloud server · my-host'
cogenly machines move --threads <id>,<id> --to 'Cloud server · my-host'
```

Add `--dry-run` to preview what would move, what would be skipped and the
target paths. Nothing moves or clones. Add `--json` for the complete structured
result.

Agents can do the same with `machines_move_threads` and
`project_move_to_machine`.

Some threads are skipped, each with a reason, and stay where they were. That
happens when a turn is running or waiting for an answer, when Work has
uncommitted or unpushed changes in its worktree, or when no project on the new
machine links the thread's repository. Move them again to retry, or add
`--leave-local-changes` to move Work anyway. Those changes then stay on the old
machine, and the new machine checks out the branch as last pushed. If its local
branch has diverged, the move keeps that work under `preserved/<branch>-<timestamp>`
and reports the preserved branch. `--dry-run` previews branch handling too. A moved
thread starts a fresh provider session that continues from its history. Diffs
and restore points from before the move stay on the old machine.

If a machine is permanently gone, unpair it first. On the hub, run
`cogenly machines adopt --dry-run` to list lost owner ids, then
`cogenly machines adopt --from <environment-id> --dry-run` to preview recovery.
Remove `--dry-run` to run those replicated threads here. Recovery uses the last
copy this machine received; data that never synced remains on the lost machine.
Busy threads and agent conversations are skipped. A machine that is merely
offline keeps ownership until it reconnects.

## Pair from Settings

Machines talk to each other through Tailscale, a free app that gives your
machines a private, encrypted link only you can use. Cogenly walks you through
it; you don't need a terminal or the `cogenly` command on a Mac.

Connect this client to both machines first (Settings → Connections). Then open
Settings → Machines on the always-on machine and choose Add a machine, or run
Add a machine from the command palette. Pick the machine to add, and follow the
checklist for each machine until both are ready:

- **Install Tailscale.** On Linux with passwordless `sudo`, Cogenly installs
  it. On a Mac, Cogenly opens the App Store. Otherwise it shows the one
  command to run, which asks for your password.
- **Turn on Tailscale.** A Mac that slept or restarted can leave Tailscale
  off; the checklist says so and opens it for you.
- **Sign in to Tailscale.** Cogenly opens the sign-in page. Use the same
  account on every machine.
- **Turn on private HTTPS.** Your Tailscale network needs this once. Cogenly
  opens Tailscale's approval page and finishes by itself after you approve.
- **Make the machine reachable.** Cogenly gives it a private address only your
  machines can reach, and keeps it across restarts.

When both checklists are done, choose Pair. The join code passes between the
machines for you; you never copy it.

The same page lists every paired machine, whether it is online, and an Unpair
button for each. `cogenly machines setup` shows the checklist in a terminal.

You can also ask an agent to do all of this. It checks and runs each machine's
steps, then pairs the machines through the desktop app the same way Add a
machine does, so the join code never appears in the conversation. Pairing from
an agent needs the desktop app on the computer the agent runs on, connected to
both machines. An agent can unpair machines too.

## Pair from the terminal

Use this when one client can't connect to both machines. Keep Cogenly running
on both machines. The computer joining must be able to reach the hub through
Tailscale Serve HTTPS or a private SSH forward to its loopback listener.
Public Connect URLs and public reverse proxies cannot carry peer pairing.
See [remote access](./remote-access.md) to make the hub reachable.

`cogenly machines setup` lists what the hub still needs, and
`cogenly machines setup expose` puts it behind Tailscale Serve. For the
background service, `cogenly service install --tailscale-serve` keeps that on
across restarts. If you ran `tailscale serve` yourself and it points at
Cogenly's port, Cogenly uses it. If you set `COGENLY_TAILSCALE_SERVE=1` in a
systemd drop-in, `cogenly doctor` moves that setting into Cogenly.

Turn private access off or back on any time in Settings → Machines with the **Private access** switch under this machine. It shows the private address while it is on.
It is the only Tailscale Serve switch in Cogenly; Settings → Connections links to it.

On the computer joining, prepare its key:

```sh
cogenly machines prepare
```

On the hub, run the command it prints, with the spoke key fingerprint:

```sh
cogenly machines pair --spoke-key=<fingerprint>
```

Keep the `=`: a fingerprint can start with `-`.

Copy the complete `cogenly-join:` code it prints. The code expires after ten
minutes, works once, and can be redeemed only with the prepared machine's key.
Keep it private.

On the joining computer, use the hub's Tailscale Serve HTTPS address:

```sh
cogenly machines join https://your-hub.your-tailnet.ts.net
cogenly machines list
```

Paste the complete code into the hidden prompt. For scripts, use
`cogenly machines join <hub-url> --code-stdin` and pipe the code from a private
source; do not put it in command arguments or shell history. A loopback HTTP
URL is accepted only for a local SSH forward to the hub. Explicit join URLs
replace advertised alternatives, so there is no silent route fallback.

If your running server uses a custom home, supply
`--base-dir /path/to/home` to each machines command on that machine.

Run `cogenly machines list` on either side to see names, machine kinds, online
status, and environment IDs. Add `--json` for structured output including
provider sign-in status. Agents can also inspect the list with `machines_list`.
A sleeping computer appears offline and reconnects when it wakes. Provider
sign-ins remain separate on each machine.

If a machine shows the wrong name or kind, fix it on that machine with
`cogenly machines rename "Work laptop"` or `cogenly machines rename --kind
cloud-server`. `--reset` goes back to the detected name and kind.

## Machine health

Each machine reports the state of what it depends on: the server and its
scheduler, the database, free disk space, provider sign-ins and usage limits,
paired machines and sync, integrations, scheduled tasks, runs stuck far longer
than any real one, the background service, and Tailscale Serve. Each problem
has a **Fix**. Where Cogenly can fix it directly, Fix does it on the machine
with the problem, even when you are connected to the other one: it stops a
thread's stuck runs (they lost their provider session, so they can't be
resumed; send the thread a message to carry on), runs a failed task again,
retries sync, or sets up the chat sandbox. A provider or integration that needs
sign-in opens its sign-in. Anything else opens a new chat with the problem
filled in, so an agent can investigate and fix it once you send it. A paired
machine that can't be reached is shown from what this machine last saw of it.

From a terminal on the machine, run `cogenly health` (or `cogenly doctor
--health`). Add `--machine <environment-id>` to read a paired machine,
and `--json` for structured output. The command exits with status 1 when a
check fails, so a cron job or uptime monitor can use it. Agents read the same
report with `machine_health`. The chat command sandbox check explains whether
bubblewrap is missing, AppArmor or the host blocks user namespaces, seccomp is
unavailable, or the architecture is unsupported. Its **Fix** action installs the
distro package using root or passwordless sudo and checks it again without a
restart. If it cannot elevate, it shows the exact command instead. You can also
run `cogenly health --fix` or `cogenly security setup`. Agents run any direct
fix with `machine_health_fix`, for this machine or a paired one.

A scheduled task that says it succeeded only means its turn started. To prove
the whole path works, turn on the health canary in your hub's health section
under Settings → Machines. It runs a one-line prompt on the cheapest available
model at the interval you choose (60 minutes by default), in a new chat that is
archived once it passes, and the canary check fails when a run errors, takes
longer than 10 minutes, or hasn't passed in two and a half intervals. Each run
uses a small amount of your provider's usage. The canary runs only on the machine
that turned it on.

## Health alerts

Cogenly alerts you when something a machine depends on breaks, such as a
provider that needs sign-in, a failed scheduled task, or a paired machine that
hasn't been reachable for 10 minutes. A problem has to last about two minutes
before it alerts, and it alerts once when it starts and once when it clears.
Problems of one kind on one machine share an alert with a count, such as stuck
runs in several threads. The alert's **Fix** works as it does in Settings →
Machines; click its title for the details.
To also get alerts as a Slack DM or an email, turn the channel on in
Settings → Machines, choose the connected Slack or Google integration, and send
a test. Channels are set per machine, so set them on your laptop too if you want
to hear when the hub itself goes down.

## Unpair a machine

Use its name or environment ID from the list:

```sh
cogenly machines unpair 'Cloud server · my-host'
```

You can unpair on either side. When both are online, this removes the link on
both machines. If either side is offline, run unpair on that side too when it
is available. Unpairing keeps your local projects and conversations.

If the hub refuses the credential or no longer proves its identity, verify the
hub address and installation, then unpair and make a fresh code. Pairing also
needs to be renewed after a year.
