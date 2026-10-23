# Always-on server

Run the Cogenly server headless so agents keep working with no terminal or
desktop app open: as a background service on your Mac or a Linux VPS. All
commands below use the `cogenly` CLI from a release install or a checkout.

## On the Mac

Install the background service once:

```sh
cogenly service install
cogenly service status
cogenly service logs --lines 50
```

This writes a launchd LaunchAgent that starts the server at login and keeps it
alive (`KeepAlive`, logs under `userdata/logs/boot-service.log`). macOS stops
it at logout, so keep the Mac logged in for unattended access.

Only one server owns a data directory at a time. If the desktop app is running
on the same home, the service fails with "already owns" instead of corrupting
state; quit the desktop app or point one of them at another `--base-dir`.

## On a VPS

### Install

The user-facing steps are in [Run Cogenly on a VPS](../user/install.md#run-cogenly-on-a-vps):
desktop SSH provisions the matching release itself, or `scripts/install.sh`
installs it by hand. Either way the release archive lands in
`~/.cogenly/runtime/versions/<version>`, and then:

```sh
cogenly service install   # systemd user unit cogenly.service, lingering enabled
cogenly service status
```

To run a source checkout instead (Node 24 and `vp`):

```sh
git clone https://github.com/aflekkas/cogenly /opt/cogenly
cd /opt/cogenly && vp i && vp run build:desktop
node apps/server/dist/bin.mjs service install
```

Run from a checkout, install pins a small wrapper that execs the checkout's
built CLI: updating means `git pull`, rebuilding, and `cogenly service
restart`. If the checkout moves, reinstall. Preview the unit without
installing with `cogenly service install --print`, or render the other
platform's file with `--print --format launchd|systemd`.

Data lives under `COGENLY_HOME` (`~/.cogenly` by default): `userdata/statev2.sqlite`
is the state database, plus `settings.json`, `secrets/`, `logs/`, and
`server-runtime.json` (origin, port, pid of the running server).

### Reach it

The server binds loopback by default. Use Tailscale first: it keeps Cogenly
private to your tailnet with no open ports. A public reverse proxy is an
explicit public-mode option, not the default path — only choose it when you
want Cogenly reachable from the internet.

Tailscale Serve (HTTPS on your tailnet, no open ports):

```sh
cogenly serve --tailscale-serve   # or once: cogenly pair --tailscale
```

Public mode — reverse proxy (Caddy example; the server stays on loopback,
but the proxy makes it internet-facing):

```caddy
cogenly.example.com {
        reverse_proxy 127.0.0.1:4773
}
```

Pair a browser by running on the server and opening the printed URL:

```sh
cogenly pair
```

Over plain SSH without Tailscale, mint a link for the public origin instead:

```sh
cogenly auth pairing create --base-url https://cogenly.example.com
```

Pairing URLs carry a one-time token: serve them over HTTPS only, and use a
fresh link per device.

### Provider credentials

Agents run on the server, so their logins must live there too. On the server,
as the service user:

```sh
claude auth login    # Claude Code; device flow works over SSH
codex login          # Codex CLI
```

Separate accounts go in separate config dirs (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`)
wired up as extra provider instances in Settings. API-key-only setups can use
the instance's Environment variables instead. See the provider docs under
`docs/user/providers-*.md`.

### Timezone

Fixed-time triggers ("daily at 02:00") run in `COGENLY_TZ`, defaulting to the
host's zone. Set it explicitly on a UTC VPS, either in the environment or
baked into the service unit:

```sh
cogenly service install --tz America/New_York
```

Without `--tz`, install captures the installing shell's `COGENLY_TZ` when set.
An invalid zone fails startup loudly rather than firing at wrong hours. DST
gaps shift forward (02:30 becomes 03:30 on spring-forward day); ambiguous
fall-back times fire once.

### Backups

The server backs itself up nightly — no cron needed. Each run writes
`<home>/backups/<timestamp>/` with a consistent snapshot of the state
database (taken through SQLite's online backup API, safe while the server
runs), plus `settings.json` and `secrets/`. Backup directories are `0700`
and files `0600` because they contain secrets. The newest 7 backups are
kept; change that or turn backups off with `automaticBackups` in
`settings.json` (`{ "enabled": true, "retentionCount": 7 }`). The server
also prunes old logs, removes orphaned worktrees whose thread is deleted
or archived (never one with uncommitted or unpushed work), and runs
`PRAGMA optimize` on a timer.

A one-off snapshot is still available by hand:

```sh
cogenly backup --keep 7   # -> <home>/backups/cogenly-backup-<timestamp>.sqlite
```

Restore: stop the server (`cogenly service uninstall` keeps data but removes
startup; prefer `systemctl --user stop cogenly` / `launchctl bootout`, or just
stop the manual server), copy the snapshot over `userdata/statev2.sqlite`,
delete the `statev2.sqlite-wal` and `statev2.sqlite-shm` sidecars if present,
restore `settings.json` and `secrets/` alongside it, and start again.

### Upgrades and health

A release install updates with `cogenly update` (it asks before restarting the
service), or from the desktop app's server version notice. A checkout updates
with `git pull && vp i && vp run build:desktop && cogenly service restart`.

`GET /health` is an unauthenticated liveness probe
returning `ok`, `version`, `uptimeSeconds`, and `schedulerHeartbeatAgeSeconds`;
point uptime monitors at it over loopback or the tailnet. The Linux service uses
systemd's 60-second watchdog: the server sends notifications through
`systemd-notify` only while the scheduler's 5-second heartbeat is at most 20 seconds
old. A hung event loop or dead scheduler therefore causes a restart. Reinstall
the service once after upgrading an older unit to enable the watchdog.

Startup resumes eligible conversation turns and marks interrupted agent Work jobs
failed with a restart reason in the work details and agent conversation.
`cogenly doctor` reclaims database space, pausing the service itself while it runs.
