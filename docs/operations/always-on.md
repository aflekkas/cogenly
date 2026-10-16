# Always-on server

Run the Cogenly server headless so agents keep working with no terminal or
desktop app open: as a background service on your Mac today, on a VPS later.
All commands below use the `cogenly` CLI from a checkout or install.

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

On the server, as the user that will run Cogenly:

```sh
# Node 24 (see engines in package.json), git, and a C compiler for native modules.
git clone <cogenly-repo> /opt/cogenly
cd /opt/cogenly
vp i
vp run --filter @t3tools/web build
vp run --filter t3 build:bundle
```

`cogenly` is `apps/server/dist/bin.mjs`; add an alias or symlink it onto PATH.
Then install the systemd user service:

```sh
cogenly service install
sudo loginctl enable-linger "$(id -un)"   # survive logout, start at boot
cogenly service status
```

Cogenly publishes no release archives yet, so install pins a small wrapper
that execs this checkout's built CLI: updating means `git pull`, rebuilding,
and `cogenly service restart`. If the checkout moves, reinstall. Preview the
unit without installing with `cogenly service install --print`, or render the
other platform's file with `--print --format launchd|systemd`.

Data lives under `COGENLY_HOME` (`~/.cogenly` by default): `userdata/statev2.sqlite`
is the state database, plus `settings.json`, `secrets/`, `logs/`, and
`server-runtime.json` (origin, port, pid of the running server).

### Reach it

The server binds loopback by default. Prefer Tailscale; use a reverse proxy
for public access.

Tailscale Serve (HTTPS on your tailnet, no open ports):

```sh
cogenly serve --tailscale-serve   # or once: cogenly pair --tailscale
```

Reverse proxy (Caddy example; the server stays on loopback):

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

Snapshots are consistent while the server runs:

```sh
cogenly backup --keep 7   # -> <home>/backups/cogenly-backup-<timestamp>.sqlite
```

Nightly via cron:

```cron
0 2 * * * /opt/cogenly/apps/server/dist/bin.mjs backup --base-dir /home/owner/.cogenly --keep 7
```

The snapshot covers the state database only. For full disaster recovery also
copy `settings.json` and `secrets/` (or the whole home).

Restore: stop the server (`cogenly service uninstall` keeps data but removes
startup; prefer `systemctl --user stop cogenly` / `launchctl bootout`, or just
stop the manual server), copy the snapshot over `userdata/statev2.sqlite`,
delete the `statev2.sqlite-wal` and `statev2.sqlite-shm` sidecars if present,
and start again.

### Upgrades and health

```sh
cd /opt/cogenly && git pull && vp i
vp run --filter @t3tools/web build
vp run --filter t3 build:bundle
cogenly service restart
```

(`cogenly update` tracks release trains and reports unavailable until Cogenly
publishes releases.) `GET /health` is an unauthenticated liveness probe
returning `ok`, `version`, `uptimeSeconds`, and `schedulerHeartbeatAgeSeconds`;
point uptime monitors at it over loopback or the tailnet. The scheduler ticks
every 5 seconds, so a heartbeat age far beyond that means the event loop
stopped turning. `cogenly doctor` reclaims database space, pausing the service
itself while it runs.
