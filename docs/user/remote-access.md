# Remote access

Connect a phone, browser, or another desktop app to Cogenly running on a different
machine. That machine must stay running and reachable while you work.

For a VPS, start with [Run Cogenly on a VPS](./install.md#run-cogenly-on-a-vps).

## Cogenly Connect

Cogenly releases do not include Cogenly Connect yet. Use
[desktop-managed SSH](#desktop-managed-ssh), [pairing](#pair-over-a-lan-or-private-network),
or [Tailscale HTTPS](#tailscale-https) instead.

Cogenly Connect makes an environment available to your other devices without setting
up router forwarding. In the desktop app on the host, open **Settings →
Connections**, sign in, and enable **Cogenly Connect** for that environment.

For a command-line host, run:

```bash
cogenly connect
```

Follow the sign-in instructions. Setup offers a
[background service](./background-service.md); if you decline it, start the
server with `cogenly serve`. Saving your sign-in alone does not make the machine
reachable.

On your other device, sign in to the same Cogenly Connect account and choose the
environment. Over SSH, the CLI prints a browser link and a short code. Open the
link on any device, confirm the code matches, and approve. The CLI continues on
its own, so you do not need to forward an OAuth callback port.

Cogenly Connect renews access credentials when needed without disconnecting a healthy
connection. Pull request diffs and provider settings keep working after the
previous credential expires. A failed renewal affects that request; it does not
disconnect an otherwise healthy conversation.

## Pair over a LAN or private network

Use direct pairing when the other device can reach the host's network address.

On a desktop host, open **Settings → Connections**, enable **Network access**,
then create a pairing link using an address the other device can reach. Changing
network access restarts the desktop app. You can turn it off in the same place.

For a command-line host, replace `<private-ip>` with the host's LAN or tailnet
address:

```bash
cogenly serve --host <private-ip>
```

If a server is already running, generate a fresh link without restarting it:

```bash
cogenly pair
```

Scan the QR code on your phone or paste the pairing URL into **Connect a machine**
in the receiving app. Connection settings are under **Settings → Connections**
on web and desktop. A loopback address
such as `127.0.0.1` reaches only the device opening the link.

Pairing authorizes that device for future connections. Use a fresh one-time link
for each new device; you do not need the original token to reconnect. Links
created in Settings can only be copied from the client that created them while
its Connections page stays open. If you leave or reload that page, create
another link to share.

### Reach one machine several ways

A machine can have more than one route: LAN, Tailscale, another VPN, a public
URL, SSH, or Cogenly Connect. Tailscale shares its `100.64.0.0/10` address range with
other VPNs such as Cloudflare WARP, so an address in that range shows as VPN
unless the machine confirms it is on Tailscale. To add a route, choose **Add
route** in the machine's route list, or next to it in the Cogenly Connect list.
Pairing the same machine again over another address also adds a route instead
of a second machine. A new route is placed by speed, in that order, and you can
reorder routes at any time.

While connected through Cogenly Connect or a paired address, Cogenly also learns the
machine's current LAN and Tailscale addresses and adds them as routes, so
pairing once through Cogenly Connect is enough to use the LAN at home. When the
machine's LAN address changes, for example after it joins another Wi-Fi network,
the learned route follows it. The machine must allow network access for its LAN
address to be learned. You can reorder a learned route, but not remove it; it
goes away with the route it was learned through, or when the machine stops
reporting that address.

Cogenly connects over the first route that answers. Away from home, a LAN
address that does not answer is checked briefly and skipped. It is only tried
again, after the other routes, if none of them connect. While connected over a
later route, Cogenly checks the earlier ones when your network changes, when you
return to the app, and every minute, and moves back as soon as one works.

On web and desktop, select the route count under the machine's name in
**Settings → Connections** to see its routes. Drag a route to change the order,
or remove it. Signing out of Cogenly Connect removes only that route; a machine
you can still reach another way stays saved.

Open **Permissions** next to **Routes** in web or desktop, to see what your current connection can do on that
environment. For a remote environment, this is in its route details. Permissions
shown there apply only to the route marked **In use**; other routes are not
checked. Direct pairing and Cogenly Connect have separate sessions and may grant
different permissions.

### Balance new threads across machines

Auto balance is off by default. On web and desktop, enable it in
**Settings → Connections → Load balancing** to automatically choose a machine for
new threads in projects grouped across connected environments. The section
appears once two or more machines are switched on.
Each machine starts at **Normal**. Choose **Prefer** to favor it when it has CPU and
memory available, **Less often** to reduce its share, or **Manual only** to exclude
it from automatic selection. These are preferences, not fixed traffic percentages.
Preferences are saved separately in each client.

The composer checks eligible machines when choosing a draft's environment, then keeps
that choice stable. Choose **Auto balance** again to check current resources, or choose
a specific machine to override it. Choosing a branch or worktree also keeps the draft
on that machine. Existing threads stay where they started. If resource checks are
unavailable or all eligible machines are full, choose a machine manually to continue.

### Tailscale HTTPS

Join both devices to the same tailnet. On web or desktop, turn on **Private access**
for the machine in **Settings → Machines**, and turn it off there to remove that
route. It is the only Tailscale switch: the desktop app's earlier Tailscale HTTPS
switch moved into it, so a machine that had it on keeps private access.

To start a command-line server with Tailscale HTTPS:

```bash
cogenly serve --tailscale-serve
```

For an already-running server:

```bash
cogenly pair --tailscale
```

The pairing link uses an address such as `https://machine.tailnet.ts.net/`.
The mapping created by `pair --tailscale` persists across restarts. Remove its
default-port mapping with:

```bash
tailscale serve --https=443 off
```

If that port is already in use, choose another with
`--tailscale-serve-port`. See `cogenly pair --help` for other pairing options.

## Desktop-managed SSH

In the desktop app, open **Settings → Connections → Connect a machine**, choose
**SSH**, and enter a host or SSH alias such as `user@example.com`. Cogenly starts
or reuses a server there, opens the port forward, and pairs for you. Projects,
provider credentials, and agent work stay on the remote machine.

What Cogenly runs on the host:

- A Cogenly server that is already running there, such as the
  [background service](./background-service.md), is used as is. A background
  service that is installed but stopped is started.
- Otherwise it starts the server from a Cogenly the host already has: the
  `cogenly` command, or a version installed under `~/.cogenly/runtime`.
- On a host with no Cogenly, it downloads the release matching your desktop app
  from [Cogenly releases](https://github.com/aflekkas/cogenly/releases) to
  `~/.cogenly/runtime`. The first launch takes longer than later ones. The host
  needs Linux (x64 or arm64) with `curl` or `wget`, `tar`, and `sha256sum` or
  `shasum`; it does not need Node.js.

When the host runs an older Cogenly than your desktop app, the app shows a
server version notice. A background service updates from that notice; for other
installs run `cogenly update <version>` on the host
([Updating Cogenly](./updating.md#update-a-connected-server)).

Provider CLIs must be on the `PATH` of a non-interactive login shell there;
check with:

```bash
ssh user@example.com 'sh -lc "command -v claude codex"'
```

A background service sets its own `PATH`; see
[Running in the background](./background-service.md#platform-support).

If SSH reconnecting fails after an app update, retry the launch once. Removing
the connection stops a server that Cogenly launched; a server that was already
running is left alone.

The environment is named after the host's own name, or "<Provider> VPS" (such
as "Contabo VPS") when the host carries its provider's default name. To change
it, open the environment's **⋯** menu in **Settings → Connections** and choose
**Rename…**.

### Ask your agent to add your server

Ask an agent running on the computer with the desktop app, for example "add my
VPS to Cogenly, the SSH host is `myvps`". It adds the server through the desktop
app, which shows "Connecting…" and then "Connected". The agent needs full access.

From a terminal on the same computer:

```bash
cogenly environment add --ssh myvps --name "My VPS"
```

`--ssh` takes an alias from your SSH config or `user@host`. Leave out `--name`
to use the host's own name. The desktop app must be running.

A link works too: `cogenly://environments/add?ssh=myvps&name=My%20VPS`. Because
any web page can open such a link, the app asks before it connects; only accept
it if you opened the link yourself.

## Browser on a remote environment

Browser tabs belong to the environment, so you and your agents see the same
tabs from any device. The desktop app shows its own environment's tabs
directly. Every other device, and the desktop app for other environments,
streams them from the host. Agents keep using them while no device is
connected, and `localhost` addresses reach servers on the host.

The first tab downloads a headless Chrome, about 120 MB, into the Cogenly home. It
is the same browser [HTML renders](html-renders.md) use, so a host downloads it
only once. Some Linux hosts need [setup](#browser-host-setup) before it can
start.

Agent tabs have separate storage and share a Chromium process. While an agent
drives a tab, the page says so; choose **Take control** to use it, which stops
the agent's current action. Back, forward, reload, and the address bar take
control too. When you're done, click **Agent** in the toolbar to hand the tab
back. The agent also takes control back the next time it acts. Read-only
connections can watch without changing the page.

With the browser panel closed, the thread floats a small preview of the tab. Click it to open
the tab, or click its **Agent** chip to see what the page is doing and take control. Drag the
preview to move it and drag its corner grip to resize it.

When you use more than one environment, the toolbar names the machine whose
browser runs the tab.

While you have control, the tab works with your device: text the page copies or
cuts goes to your clipboard, a file picker on the page opens your device's
picker, and a finished download is offered for you to save. Popups such as
sign-in windows open as their own tabs. Downloads stay on the host until the
tab closes. Audio does not play on your device.

### Browser host setup

macOS, Windows, and Linux desktops run the browser as is. Some Linux hosts need
one-time setup: Ubuntu 23.10 and later block the sandbox the browser runs in,
and minimal images and containers lack libraries it loads. When that happens,
the server says so at startup, and browser tabs and HTML previews show the
command to run on the host:

```sh
sudo cogenly browser setup
```

The server shows the exact line for how you started it, such as
`sudo cogenly browser setup`, and keeps your `PATH` when Node is installed only
for your user. Where `cogenly` is not on your `PATH`, such as with only the
desktop app installed, it names the full path of the app's own `cogenly` instead. It allows Chrome's sandbox with an AppArmor profile and installs
any missing libraries with apt. It is safe to run again. Without `sudo`, it
only reports what it would change.

The browser always runs in Chrome's sandbox. Where you cannot change the host,
set `COGENLY_SERVER_BROWSER_SANDBOX=0` for the environment to run without it.

## Check your machine's security

Ask the machine itself how exposed it is:

```sh
cogenly security status          # or --json
```

You can also ask your agent for `machine_security_status`. The check is
read-only and needs no root: it reports Cogenly's bind address, sockets
listening beyond loopback, SSH password/root settings when readable,
Tailscale Serve and Funnel, and the host firewall when readable. Anything it
cannot observe is reported as unknown, never as safe. Listening on a public
address is reported separately from being reachable from the internet, which
the machine cannot prove by itself.

## Connect an outside agent

Claude Code, Codex, ChatGPT and other agents Cogenly did not start can drive
threads on an environment through its MCP server. See
[outside agents](./outside-agents.md) for setup.

## Manage or revoke access

On the host, **Settings → Connections** lets authorized administrators create
pairing links and revoke client sessions. Revoking an unused link prevents new
pairings; revoke a device's session to remove its existing access. Command-line
management is available through `cogenly auth --help`.

A session with an open connection stays listed after its access credential
expires.

To choose a token's permissions, pass `--scope` once for each scope you want:

```sh
cogenly pair --scope orchestration:read --scope relay:read
```

The selected scopes replace the default permissions. The same option works with
`cogenly auth pairing create` and `cogenly auth session issue`; each command's
`--help` lists the available scopes. Without `--scope`, pairing tokens retain
standard client permissions and issued bearer sessions retain administrative
permissions.

To change an existing client's permissions, create a fresh pairing link with the
scopes it needs. In a browser opened directly on the environment, open that link
to replace the browser's current grant. For a saved remote machine
in web or desktop, use **Connect a machine** with the fresh link or code;
connecting the same machine again replaces its saved grant. Reconnecting alone does not change
permissions.

Grouping checkouts does not combine their permissions. Shared project settings
require `orchestration:operate` on every member environment; actions on one
checkout use that checkout's permissions.

`source-control:write` covers direct Git and pull request changes made from the
client: pushing, switching or creating branches, cloning, and removing
worktrees. It does not restrict what a task does. Starting a task in a new
worktree still creates that branch and worktree with `orchestration:operate`,
and the agent it runs can use Git however the environment allows.

Settings changes, provider management, and environment maintenance can be granted
separately from access administration. New standard pairings include these
permissions. Existing clients can stay connected after an update, but newly separated
features may require pairing again with the permissions they need. Older clients
may show controls that the server denies. Create a fresh pairing link to change
a client's permissions.

`filesystem:read` allows browsing host files, opening workspace files, and viewing
local changes. Add `filesystem:write` to allow editing files or saving plans to
the workspace. These scopes control direct file access from the client.

To remove an environment from Cogenly Connect, open your account menu's **Cogenly Connect**
page and choose **Deregister**. This
revokes its cloud access and frees its host space even when the environment is
offline or has been wiped. When Cogenly Connect rejects a host's link, the host
shows that it was removed from Cogenly Connect. To link it again, turn on
**Cogenly Connect** in **Settings → Connections** on a desktop host, or run
`cogenly connect link` on a command-line host and then restart Cogenly there. A
command-line host that released its tunnel when it last stopped may link itself
again on its next start; run `cogenly connect unlink` on that host to keep it off.
Removing an environment from a device's connection settings only forgets it on
that device; it stays registered to your account.

When idle tunnel cleanup is enabled, Cogenly Connect removes a linked environment's
tunnel after it stays offline for several minutes. The environment stays linked
and keeps the same address. When the host starts again or wakes, Cogenly Connect
creates a replacement tunnel on its own. You do not need to pair again. Cleanup
usually runs five to ten minutes after the tunnel goes down.

Cogenly Connect also removes the tunnel of an environment running an older version of
Cogenly once it has been offline for seven days. That environment shows a message
asking you to update. Start Cogenly on that computer and update it to the latest
version; it reconnects at the same address without pairing again.

On a command-line host, `cogenly connect unlink` disables exposure while retaining
your login; `cogenly connect logout` also clears that login. Background-service
[removal](./background-service.md#manage-the-service) is separate.

Treat pairing URLs and authorization codes as passwords. Do not include them in
screenshots, logs, or bug reports.

## Cogenly Connect troubleshooting

Run `cogenly connect status` on the host to inspect saved authorization and link
configuration. It is not a live reachability check. If the environment appears
offline, run `cogenly service status` and read the displayed log. If it disappears
when SSH closes, see [background-service troubleshooting](./background-service.md#troubleshooting).

| Error                                                     | Recovery                                                                                                                                                   |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `environment_link_limit_exceeded` or managed tunnel limit | Deregister an unused environment, then restart Cogenly on the host.                                                                                        |
| `auth_invalid` or `invalid_bearer`                        | Run `cogenly connect login`. If credentials were revoked, run `cogenly connect logout`, then `cogenly connect` again. Restart the server after signing in. |
| Expired or invalid link proof                             | Check the host's date and time, update Cogenly, then restart it.                                                                                           |
| HTTP 403 without a recognized error                       | Check relay access, proxies, and firewall rules. Keep any Cloudflare Ray ID for a bug report.                                                              |
| HTTP 408, 429, or 5xx                                     | Check network and relay availability. Startup retries temporary failures for up to ten minutes.                                                            |

After fixing a permanent rejection, restart the host's server. Use
`cogenly service restart` for the background service. For a
foreground server, stop it and run `cogenly serve` again with your usual options.
Include the diagnostic message and trace ID when reporting a persistent failure.

For a connection that still fails after linking, check the date and time on both
devices. For server version warnings, follow [Updating Cogenly](./updating.md).

## Using the Desktop App as a Remote Only

If a computer should only drive work running elsewhere, turn off its local environment. In the
desktop app, open **Settings → Connections** and switch off **Local
environment**. Cogenly restarts without a local server: no local agents or terminals run, WSL
backends stay off, and other devices can no longer connect to this computer. Your projects,
history, and saved connections are kept, and you keep working through pairing, Cogenly Connect, or SSH.

Switch **Local environment** back on in the same place to restart with your previous local
settings.
