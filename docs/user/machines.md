# Machines

Pair the computers and servers you run Cogenly on, so they know about each
other. One always-on machine, usually a cloud server, is the **hub**. Your
other machines connect to it, so a laptop never has to be reachable from the
internet. With only one machine you don't need any of this.

Pairing only links the machines for now: each lists the others with their kind
and whether they are online. Sharing projects, settings and conversations
between them comes in later releases.

## Pair a machine from the terminal

Both machines need Cogenly running (see
[running in the background](./background-service.md)), and the other machine
must be able to reach the hub, for example over [Tailscale](./remote-access.md#tailscale-https).

1. On the hub, run:

   ```bash
   cogenly machines pair --name "MacBook Pro"
   ```

   It prints a join code and the command to run on the other machine. The code
   works once and expires after 10 minutes.

2. On the machine you are adding, run the printed command, with an address that
   machine reaches the hub on:

   ```bash
   cogenly machines join https://my-server.tailnet-name.ts.net/ cogenly-join:…
   ```

3. Check both sides with `cogenly machines list`.

Treat a join code like a password until it is used: whoever runs it first
pairs their machine.

A machine that already has machines paired to it can't join another hub, and a
machine that joined a hub can't be one. Unpair first to change roles.

## Names and kinds

Each machine is shown as **This computer**, **Cloud server** or **Another
computer**, detected from its hardware: a Linux machine without a screen or
battery is a cloud server, a Mac with a battery is a laptop. A cloud server is
named after its hosting provider or host name, for example "Cloud server ·
Contabo". To correct the name or kind, run on that machine:

```bash
cogenly machines rename "Studio Mac" --kind computer
```

Your choice wins over detection; `cogenly machines rename --reset` goes back to it.

Agents can see your machines with the `machines_list` tool.

## Unpair

Run `cogenly machines unpair <name>` on either machine. The pairing stops
working on both sides right away. If the other machine was offline, it shows
the pairing as ended the next time it starts and stops trying once you unpair
it there too.

Revoking a machine's session in **Settings → Connections** on the hub also
unpairs it.
