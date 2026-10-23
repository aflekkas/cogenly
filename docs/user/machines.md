# Pair your machines

Pair your Cogenly servers to see which machines are online and establish a link
between them. Choose an always-on machine as the hub; your other computers
connect out to it. Each machine can join one hub. Paired machines sync project
names, instructions, archive state, repository remotes and source links, plus
agent profiles, fallback chains and scheduled-task configuration. Changes made
while a machine is offline catch up when it reconnects.

Agents and schedules run only on their owner machine. New ones default to the
hub; existing ones keep the machine they were created on. Ownership cannot be
changed yet. Editing a profile or schedule on another machine updates the
owner's configuration without starting a second copy. Provider sign-ins and
an agent's current fallback position stay on the owner.

Repository checkouts and worktrees stay local. Syncing a repository link does
not clone it on another machine. Settings, conversations, resource files,
vault items, integrations and memory facts do not sync yet. Pairing does not
enable remote work launches. Matching project names are kept separately until
you choose how to combine them.

## Pair from the terminal

Keep Cogenly running on both machines. The computer joining must be able to
reach the hub at an HTTPS address or over an encrypted network such as
Tailscale. See [remote access](./remote-access.md) to make the hub reachable.

On the hub, run:

```sh
cogenly machines pair
```

Copy the complete `cogenly-join:` code it prints. The code expires after ten
minutes and works once. Keep it private: anyone with this terminal-generated
code can redeem it first.

On the other computer, use the hub address that computer can reach:

```sh
cogenly machines join https://your-hub.example 'cogenly-join:...'
cogenly machines list
```

Use the complete code in place of `cogenly-join:...`. An address starting with
`127.0.0.1` or `localhost` refers to the joining computer, so use the hub's
network address instead. If your running server uses a custom home, supply
`--base-dir /path/to/home` to each machines command on that machine.

Run `cogenly machines list` on either side to see names, machine kinds, online
status, and environment IDs. Add `--json` for structured output including
provider sign-in status. Agents can also inspect the list with `machines_list`.
A sleeping computer appears offline and reconnects when it wakes. Provider
sign-ins remain separate on each machine.

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
