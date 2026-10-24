# Pair your machines

Pair your Cogenly servers to use one Cogenly across them. Choose an always-on
machine as the hub; your other computers connect out to it. Each machine can
join one hub. Paired machines sync project names, instructions, archive state,
repository remotes and source links, agent profiles, fallback chains and
scheduled-task configuration, and every conversation. Changes made while a
machine is offline catch up when it reconnects.

Agents and schedules run only on their owner machine. New ones default to the
hub; existing ones keep the machine they were created on until you
[move them](#move-threads-and-projects). Editing a profile or schedule on
another machine updates the owner's configuration without starting a second
copy. Provider sign-ins and an agent's current fallback position stay on the
owner.

Repository checkouts and worktrees stay local until you move a project, which
clones its repositories on the new machine. Settings, resource files, vault
items, integrations and memory facts do not sync yet. Matching project names
are kept separately until you choose how to combine them.

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
sign-in, then moves its threads and agents. Moving a single thread clones its
repository too when the project links it. An agent moves with its schedules.

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

## Pair from the terminal

Keep Cogenly running on both machines. The computer joining must be able to
reach the hub through Tailscale Serve HTTPS (start the hub with
`--tailscale-serve`) or a private SSH forward to its loopback listener.
Public Connect URLs and public reverse proxies cannot carry peer pairing.
See [remote access](./remote-access.md) to make the hub reachable.

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
