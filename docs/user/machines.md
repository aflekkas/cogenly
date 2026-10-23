# Pair your machines

Pair your Cogenly servers to see which machines are online and establish a link
between them. Choose an always-on machine as the hub; your other computers
connect out to it. Each machine can join one hub. Projects, settings, threads,
files, and provider logins do not sync yet, and pairing does not enable remote
work launches.

## Pair from the terminal

Keep Cogenly running on both machines. The computer joining must be able to
reach the hub through Tailscale Serve HTTPS (start the hub with
`--tailscale-serve`) or a private SSH forward to its loopback listener.
Public Connect URLs and public reverse proxies cannot carry peer pairing. See [remote access](./remote-access.md) to make the hub reachable.

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
