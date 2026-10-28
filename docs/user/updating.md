# Updating Cogenly

The app you use and the server running your agents can be on different machines.
When a server is behind your web or desktop app, an update notice appears in the
conversation and **Settings → Connections**. Update the machine named in that
notice.

## Update everything at once

**Updates**, below Settings at the bottom left, lists the desktop app, the
server, and each provider CLI once, however many machines you have connected.
With several machines, a row sums up their versions, such as "1.4.12 → 1.4.13
on 2 of 5 machines", and its **Update** button updates it everywhere it is
behind. Click the row to see each machine's version and update one machine on
its own. A dot on **Updates** means something has an update. Choose **Update
all** to update every connected machine in one step: outdated providers, then
servers that are behind, then the desktop app you are using. Machines your
connection is not allowed to update are left out.
**Check for updates** checks again. On a narrow window the update button sits
at the bottom of the sidebar instead. Servers move to the
version your desktop app is installing, or to your web app's version. A
background service stays on its current release channel. A remote desktop app
installs the latest release from its own channel.

While it runs, the Updates list shows its progress. It names a machine that is
taking longer than usual, and offers **Retry** for a server that failed. Click
the progress to see every machine. The desktop app restarts once each server has started
its own restart, after a short countdown. Choose **Later** to keep working and
restart from the update button when you are ready. A server still restarting
finishes on its own, and the button keeps showing it after the desktop app
restarts.

Server updates appear only after that version's GitHub release is published.
Servers run by a desktop app do not wait for it, because they update with that
app. The confirmation lists each machine it skips
and why, such as a machine that is offline or needs a manual update. Use the
notice or **Settings → Connections** for those.

If a desktop app restarts on its old version, Cogenly tells you the update did
not apply. It does not install that version again on its own, even when another
device asks. Use the update button on that machine to retry.

The confirmation counts the running threads that the restarts will interrupt,
and how many can resume afterwards. See **Continue threads after restarts**
below.

## Desktop app on Mac

The Mac app installs its own updates and restarts into the new version. To do
that, it must run from a folder you can write to, such as Applications. If you
open it straight from the disk image, or macOS runs it from a temporary copy,
the update button opens the new disk image instead. Drag Cogenly to
Applications and open it from there. If the new version cannot start, Cogenly
puts the previous version back and tells you the update did not apply.

## Before you update

Server updates restart the connection and can interrupt active agents and
terminal commands. Saved threads, settings, and project files remain.

**Settings → General → Continue threads after restarts** is on by default.
It resumes supported active threads after an update, crash, or machine
restart. It applies to every paired machine; servers too old to support it need
an update first. Cogenly must start again on that machine;
the setting does not enable automatic startup. Terminal commands may still be
interrupted, and threads without saved provider resume state need a new message.
A thread that finished its turn to wait on a monitor, subagent, or background task
is woken and told that this work stopped. A background shell, such as a dev server,
does not wake it; the thread learns about it with your next message.
A thread is not resumed while it waits for your approval, answer, or secret, or
while it is archived, snoozed, or settled. After three automatic resumes in a row,
the thread waits for your next message. Agent jobs resume the same way, and their
result is posted once the resumed turn finishes.

Updates from the previous orchestration system preserve conversation transcripts but cannot carry
every kind of runtime history forward. Read [Threads from older Cogenly versions](./thread-migration.md)
before continuing an important older thread.

## When versions don't match

A client and server must speak the same orchestration protocol. If they do not, the connection is
refused rather than running half-upgraded:

- An app newer than the server is blocked before connecting, with a notice telling you to update
  Cogenly on the machine named in the notice.
- A server newer than your app refuses the connection with an update message.

Update the side the notice names, then reconnect.

## Update a connected server

The offered action depends on how the server runs:

| Action                     | What to do                                                                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Update server**          | Keep the client open while it installs and reconnects. Supported background services update remotely. For a desktop-hosted server, this also closes and relaunches the desktop app on the host. |
| **Update the desktop app** | Update the desktop app on the machine running the server, then reopen it if needed.                                                                                                             |
| **Copy update command**    | Run the copied `cogenly update` command on the named host, as described below.                                                                                                                  |

On the host, run:

```sh
cogenly update <client-version>
```

Replace `<client-version>` with the version shown in the notice. The command
asks before restarting the background service; if you decline, run
`cogenly service restart` when you are ready. Over non-interactive SSH, use
`cogenly update <client-version> --yes` to restart as part of the update, or
run the restart command printed by the update afterwards. For a server you started by hand,
stop it and start it again afterwards with your usual options such as `--host`
or `--tailscale-serve`.

If you run the server from a source checkout, there is nothing to download:
check out the client's version, rebuild, and restart the server.

## If an update fails

Keep the client open until it reconnects or reports a failure. A failed service
update can roll back to the previous version. If the update still fails:

1. Retry the offered action once.
2. Check that you updated the server's machine, not only the device you are using.
3. For a command-line server, run `cogenly update` with the exact version shown in the notice.

Only one server can use a Cogenly home directory at a time. If startup reports that
another server owns it, stop that server before retrying, or use a separate home
directory and pair with the running server.

## Update providers

**Settings → Providers** shows provider updates for the selected environment.
**Update all** updates every outdated provider on every connected environment
at once. Hover it to see which providers it will update. Providers that only
offer a manual update command are not included.
