# Pair your machines

Pair your Cogenly servers to use one Cogenly across them. Choose an always-on
machine as the hub; your other computers connect out to it. Each machine can
join one hub. Paired machines sync project names, instructions, archive state,
repository remotes and source links, agent profiles, fallback chains and
scheduled-task configuration, and every conversation. They also sync your
settings and each project's own settings, including appearance, keybindings,
notification preferences and composer behavior. Settings that describe one machine
stay on it: provider setup and sign-ins, folders such as the projects root,
storage and backups, background activity, and devices. Changes made while a
machine is offline catch up when it reconnects. A machine on an older version
keeps syncing and picks up anything newer once it updates.

Agents and schedules run only on their owner machine. New ones default to the
hub; existing ones keep the machine they were created on until you
[move them](#move-threads-and-projects). Editing a profile or schedule on
another machine updates the owner's configuration without starting a second
copy. Provider sign-ins and an agent's current fallback position stay on the
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

Agents can do the same with `machines_move_threads` and
`project_move_to_machine`.

Some threads are skipped, each with a reason, and stay where they were. That
happens when a turn is running or waiting for an answer, when Work has
uncommitted or unpushed changes in its worktree, or when no project on the new
machine links the thread's repository. Move them again to retry, or add
`--leave-local-changes` to move Work anyway. Those changes then stay on the old
machine, and the new machine checks out the branch as last pushed. A moved
thread starts a fresh provider session that continues from its history. Diffs
and restore points from before the move stay on the old machine.

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

Turn private access off or back on any time in Settings → Machines with the Private access switch on this machine.
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
