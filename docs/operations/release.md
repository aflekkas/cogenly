# Releases

Each release from [Release](../../.github/workflows/release.yml) ships the
**macOS arm64** desktop app (DMG and zip) and the **Linux server** for x64 and
arm64. It publishes **prod** only, GitHub's latest release, behind the
**production** approval gate. No npm, relay, AUR, Discord, mobile, or
hosted-web deployment runs here.

## Release assets

| Asset                                                                | Consumer                                                                                                                 |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `Cogenly-X.Y.Z-arm64.dmg`, `.zip`, `.blockmap`, `latest-mac.yml`     | Mac first install and the desktop updater                                                                                |
| `cogenly-X.Y.Z-linux-x64.tar.gz`, `cogenly-X.Y.Z-linux-arm64.tar.gz` | Desktop SSH provisioning, `scripts/install.sh`, `cogenly update`, `cogenly service install`, remote server updates       |
| `t3-X.Y.Z-linux-x64.tar.gz`, `t3-X.Y.Z-linux-arm64.tar.gz`           | The same bytes under the old names, for installs older than the rename (see [Transition](#transition-t3--cogenly-names)) |
| `SHA256SUMS`                                                         | One `<sha256>  <file>` line per asset, bare file names; every downloader verifies against it                             |

A Linux archive holds one directory, `cogenly-X.Y.Z-linux-<arch>/`, containing
the `cogenly` single executable (Node is embedded), a `t3` symlink to it,
`client/` (the web app), `resource-monitor/`, and `node_modules/` with the
native externals. Installers unpack it into
`~/.cogenly/runtime/versions/X.Y.Z/` and write `.install-complete`. The names
are spelled in [`cliRelease.ts`](../../packages/shared/src/cliRelease.ts),
[`release-plan.cjs`](../../.github/scripts/release-plan.cjs), the SSH runner in
[`tunnel.ts`](../../packages/ssh/src/tunnel.ts),
[`install.sh`](../../scripts/install.sh), and the service launcher in
[`serviceLauncher.ts`](../../apps/server/src/serviceLauncher.ts). Installed
servers and launchers keep looking for the names they were built with, so a
rename needs a transition like the one below.

The desktop app provisions an SSH host with the archive of its own version, so a
release without Linux archives leaves desktop SSH unable to install on a fresh
host. Publish refuses a `SHA256SUMS` that lacks any of the four archive names,
or whose `t3-` and `cogenly-` archives differ.

### Transition: t3 → cogenly names

Releases up to v0.2.2 named the archives `t3-X.Y.Z-linux-<arch>.tar.gz` and the
executable `t3`. The first release that ships the `cogenly` names is the first
prod release after v0.2.2 (v0.2.3 if it is a patch; record the actual tag here
when it ships). From it on, each release uploads one archive under both names,
and the archive carries `t3` as a symlink to `cogenly`.

Why both are needed, by what an older install does against a new release:

- **Servers and CLIs from v0.2.2 or older** (`cogenly update` / `t3 update`, a
  remote update from the app, `cogenly service install`) look up
  `t3-X.Y.Z-linux-<arch>.tar.gz` in `SHA256SUMS`, unpack it, and run
  `versions/X.Y.Z/t3`. The `t3-` upload and the `t3` symlink satisfy both.
- **Service launchers from v0.2.2 or older** run `versions/<active>/t3 serve`
  and treat a version as installed when `stat` of that path is a file and
  `.install-complete` matches. The symlink passes. The launcher is the binary
  named in the unit's `ExecStart` (or the plist's `ProgramArguments`), for
  example `versions/0.1.11/t3 __service-launcher`. It never updates itself: a
  remote update from the app only changes which version it runs. Only
  `cogenly update` or `cogenly service install` on that machine rewrites the
  unit, and then it names `versions/<new>/cogenly __service-launcher`.
  `cogenly service status` reports a unit that still names `t3` as needing
  repair.
- **Current code** downloads the `cogenly-` archive, falls back to the `t3-`
  one when `SHA256SUMS` lists only that (a release from before the rename, so
  pinning or rolling back to one still works), and runs `cogenly`, falling
  back to `t3` in a version directory unpacked from an older archive.

Every place that keeps an old name says "Transition: t3 → cogenly names";
search for that phrase to find them all. There are two separate removals.

**Publishing the old names** (the `t3-` uploads in `release.yml` and
`release-plan.cjs`, the `t3` symlink in `build-cli-archive.ts`, its check in
`smoke-cli-archive.ts`) may stop in a minor release, and only when all of these
hold:

1. Every machine we know of runs a service launcher from v0.2.3 or later. On
   each one, `systemctl --user cat cogenly.service | grep ExecStart` (on macOS,
   the `ProgramArguments` in
   `~/Library/LaunchAgents/com.cogenly.app.service.plist`) names
   `runtime/versions/<v>/cogenly __service-launcher` with `<v>` at least
   0.2.3. As of 2026-10-24 the owner's VPS names `0.1.11/t3`, so run
   `cogenly update` or `cogenly service install` there first.
2. Every machine we know of runs a server and CLI from v0.2.3 or later
   (`activeVersion` in `~/.cogenly/runtime/service-state.json`, and
   `cogenly --version`), so nothing still downloads a `t3-` name.
3. At least two prod releases after the first transition release have shipped,
   and not before 2027-01-24, three months after the first one, for installs
   we don't know about.

The release notes of that release tell users with older installs to run
`cogenly update` on the machine first, or reinstall with `scripts/install.sh`.
An older launcher asked to update to it rolls the update back
(`target-runtime-missing`) and keeps running; it does not lose data.

**Reading the old names** (the `t3` fallbacks in `cliRelease.ts`,
`pinnedRuntime.ts`, `serviceLauncher.ts`, `install.sh`, and `tunnel.ts`) stays
as long as rolling back to a release older than the first transition release
is supported, because those releases and the version directories they
unpacked hold only `t3`. Remove them no earlier than the publishing side.

## Main → prod

Builds happen only when a maintainer dispatches Release to promote a commit.
Pushes to `main` run CI and nothing else. We decided this because building
staging on every push was wasteful: each push queued a macOS build behind the
previous one, and most of those builds were never installed.

1. Land the change on `main`. CI's **Lint**, **Typecheck**, and **Test** checks
   run on every push to `main`.
2. Wait for that commit's push CI run to succeed.
3. In Actions → Release → Run workflow, select **main**, enter the commit as
   **ref** (full or short SHA, or `main` for its HEAD), and optionally a prod
   **version**. Or:

   ```sh
   gh workflow run release.yml --ref main -f ref=<sha>
   ```

4. The workflow resolves the full SHA. It refuses to build unless the commit is
   on `main`'s first-parent history and a push CI run for exactly that SHA
   succeeded. When several commits are pushed together, only the pushed head
   has a CI run, so promote that commit.
5. Inspect the resolved SHA and build artifacts. Approve the **production**
   deployment when ready. The workflow publishes `vX.Y.Z` and marks it latest.

The run's workflow comes from `main`; its source checkout, application code, and
packaging script come from the selected commit. Test the prod DMG before wider
distribution.

The desktop matrix has one macOS arm64 row and can be extended later. The
workflow checks zip integrity, updater metadata, and checksums, and verifies
code signature, notarization ticket, and Gatekeeper assessment in signed mode.
The `cli` matrix builds each Linux archive on a native runner (`ubuntu-24.04`,
`ubuntu-24.04-arm`) and smoke-tests it: the extracted executable runs
`--version` and a real `serve` with an empty `PATH`. Each job uploads its
archive with a `SHA256SUMS.linux-<arch>`; publish merges those with the Mac
checksums into the single `SHA256SUMS`.
Releases are uploaded as drafts before publication so partial uploads are not
offered as updates. An interrupted publish can leave a draft; inspect it before
retrying. Existing releases are never overwritten automatically.

### Build speed

A run takes about five minutes of wall time before the approval wait; the
Linux jobs run beside the macOS one. Most of it is the macOS packaging step: the web build, the Rust resource monitor, and
electron-builder producing the zip and DMG in parallel. Both artifacts ship:
the DMG is the first-install download and the zip is the update payload.

- Every job sets up Node from `engines` in package.json and pnpm from
  `packageManager` through Node's bundled Corepack, then runs
  `pnpm install --frozen-lockfile` with the pnpm store cached on the lockfile. `vp` is the lockfile's `vite-plus`, from
  `node_modules/.bin`. CI and Release don't use `voidzero-dev/setup-vp`: its
  installer resolves the Vite+ CLI through npm's per-version metadata endpoint,
  and that endpoint has failed for every version at once. `pnpm/action-setup`
  isn't used either, because its npm-based bootstrap has stalled for minutes.
- The resource monitor's crates and Cargo target dir are cached with
  `Swatinem/rust-cache`.
- The dictation helper (`native/speech-helper`) needs the macOS 26 SDK, so the
  job points `COGENLY_SPEECH_DEVELOPER_DIR` at the runner's newest Xcode 26 for
  `swiftc` only; the rest of the build keeps the image's default Xcode.
- The build job checks out the commit shallowly, since packaging reads only
  `HEAD`. The artifact uploads without recompressing the DMG and zip.
- The publish job installs no toolchain. The resolve job passes the previous
  prod tag to it, so after approval it only downloads the artifact, writes the
  notes, and publishes.

- The Linux jobs install with `ELECTRON_SKIP_BINARY_DOWNLOAD=1`, build the
  web client and server, then switch to Node 26.8.2 only for `build-exe`,
  because `--build-sea` needs Node 25.7+ on the host. Staging the archive and
  the smoke test run on the workspace Node, as macOS packaging does.

### Publishing by hand

If the publish job fails after approval (for example HTTP 403 "Resource not
accessible by integration" when creating the release), publish from the run's
artifacts. Download `desktop-mac-arm64`, `cli-linux-x64`, and `cli-linux-arm64`
into one directory, then merge the checksums exactly as the job does:

```sh
cd release-publish
node -e 'const fs=require("node:fs");const {mergeChecksums,assertReleaseAssets}=require(process.argv[1]);
  const parts=fs.readdirSync(".").filter(n=>/^SHA256SUMS(\.|$)/.test(n)).sort();
  const merged=mergeChecksums(parts.map(n=>fs.readFileSync(n,"utf8")));assertReleaseAssets(merged,process.argv[2]);
  parts.forEach(n=>fs.rmSync(n));fs.writeFileSync("SHA256SUMS",merged)' "$REPO/.github/scripts/release-plan.cjs" X.Y.Z
shasum -a 256 -c SHA256SUMS
rm -f signing-mode.txt
gh release create vX.Y.Z --target <sha> --title "Cogenly vX.Y.Z" --notes-file notes.md --draft ./*
gh release edit vX.Y.Z --draft=false --latest
```

These steps are inlined in each workflow rather than shared through a local
composite action, because the build job checks out the selected commit, and
older commits do not contain the shared action.

## Versions and notes

Keep `apps/desktop/package.json` at the **next intended prod version**, e.g.
`0.1.0`. Prod defaults to that version at the selected commit; an override must
be plain `X.Y.Z` and advance the current latest prod release. A rerun uses the
same tag and cannot overwrite a published release. After shipping prod, bump
the next package versions on `main` (use `node scripts/update-release-package-versions.ts 0.1.1`).
The workflow stamps server, desktop, web, and contracts versions in its checkout;
it never commits a version change to main.

Before 1.0, choose the number by what a user has to know or do:

- **Patch (`0.x.Y`)**: fixes, polish, security hardening, and features that
  work without the user doing anything new. Routine database migrations are
  fine in a patch.
- **Minor (`0.X.0`)**: a release that changes how Cogenly is set up or used
  across the board. Examples: a new capability users opt into with setup steps
  (pairing machines, a new provider), data that starts syncing between
  machines, a removed or renamed command, tool, or setting, or anything that
  needs a migration step from the user. Its release notes say what to do.
- Never reuse or skip back: each prod release advances the latest one, and the
  workflow refuses anything else.

Notes are generated against the latest prod release, ignoring old staging
prereleases. The first prod release uses the source commit's first-parent
history, since there is no previous tag. Every release body records the source
SHA, the signing mode, and the main commit it was promoted from.

## Unsigned builds

Cogenly has no Apple Developer account yet, so releases build unsigned.
electron-builder runs with `identity: null`. That keeps the ad-hoc signatures
the linker gave Electron's binaries and does not seal the bundle. What that
costs on macOS:

- **Gatekeeper.** A zip or DMG downloaded by a browser is quarantined, and its
  first launch is blocked until it is allowed in System Settings → Privacy &
  Security. Files the app downloads itself, or that `gh` and `curl` download,
  carry no quarantine and launch without a prompt. The app does not set
  `LSFileQuarantineEnabled`.
- **Identity.** The designated requirement is the cdhash of the main
  executable, which is Electron's stock binary. It stays the same from one
  Cogenly build to the next, so the "Cogenly Safe Storage" keychain item and
  privacy grants survive normal updates. An Electron upgrade changes it: macOS
  asks again for keychain access, and grants such as Screen Recording must be
  given again. Any other unsigned app on the same Electron version has the
  same identity.
- **No Squirrel.Mac.** Squirrel refuses bundles without a valid signature, so
  unsigned apps install updates themselves (see below).
- **No restricted entitlements.** Browser passkeys and associated domains need
  a provisioning profile.

A self-signed code-signing certificate would make the designated requirement
stable across Electron upgrades too (identifier plus certificate leaf). It is
not used. It would need a new secret, and the workflow's signing branch
requires all five Apple secrets and always notarizes.

## Signing and notarization

With only `GITHUB_TOKEN`, releases build **unsigned**. If any of the five Apple
secrets below is absent, signing is disabled, partial credentials are discarded,
and the workflow logs `macOS release mode: unsigned`; the release body labels
it as unsigned. Once all five exist, it automatically signs and notarizes. Invalid
credentials or notarization failures fail the build rather than silently falling
back to unsigned.

Configure these as **repository Actions secrets**, since the build job runs before
the publishing environment gate:

| Secret             | Value                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------- |
| `CSC_LINK`         | Base64 of the Developer ID Application certificate and private key exported as `.p12` |
| `CSC_KEY_PASSWORD` | Nonempty `.p12` export password                                                       |
| `APPLE_API_KEY`    | Raw contents of the downloaded `.p8` API private key                                  |
| `APPLE_API_KEY_ID` | App Store Connect team API Key ID                                                     |
| `APPLE_API_ISSUER` | App Store Connect team API Issuer ID                                                  |

1. Complete [Apple Developer Program enrollment](https://developer.apple.com/programs/enroll/).
2. In Xcode → Settings → Accounts → your team → Manage Certificates, create a
   **Developer ID Application** certificate, or follow Apple's
   [certificate procedure](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/)
   using a CSR from Keychain Access. Install the downloaded certificate on the Mac
   holding its private key.
3. In Keychain Access → My Certificates, select the certificate **with its
   private key**, export as `.p12`, and set a password. Encode it with
   `base64 -i DeveloperID.p12 | pbcopy`; save the result as `CSC_LINK` and the
   password as `CSC_KEY_PASSWORD`. Keep private keys out of git and logs.
4. In App Store Connect → Users and Access → Integrations → App Store Connect API,
   request API access if necessary, then create a **team API key** with Developer
   access suitable for notarization. Download its `.p8` once and record its Key ID
   and Issuer ID. See [Apple's API key guide](https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api/).
5. Populate the three `APPLE_API_*` secrets. The workflow writes the raw key to a
   temporary `.p8` file for electron-builder/notarytool. Promote a commit and verify
   the release logs `signed-and-notarized` and passes the signature checks.

Normal Developer ID signing does not require an Associated Domains profile,
Clerk, or `APPLE_TEAM_ID`. Optional browser-passkey provisioning remains a separate
packager capability; it is not required by this release workflow.

Once the secrets exist, builds record `cogenlyUpdatesSigned: true` and install
updates through Squirrel.Mac. The last unsigned build still updates itself with
the in-app installer, so it can move to the first signed build without a manual
DMG install. The signing identity changes at that point, so macOS asks once
for keychain access and privacy grants must be given again.

## Channels and update verification

Releases are prod-only. The app has no update track setting: it uses ID
`latest`, reads `latest-mac.yml`, and disallows prereleases. A stored `staging`
or `nightly` preference from an older build is ignored and falls back to prod.
Updates also check that an offered version is a prod version.

**Updates are offered only by promotion.** Day-to-day installs are prod builds
on the Prod track, so they see a new version only after it passes the
production gate. The Release workflow no longer publishes staging builds, and
installs still on a staging prerelease move to prod on their next update. The
app checks its feed
at startup and every four minutes, which is cheap because the prod feed changes
only on promotion.

Signed macOS builds download the zip and use Squirrel.Mac to install. Unsigned
builds carry baked-in signing metadata and install updates themselves
([`unsignedMacUpdate.ts`](../../apps/desktop/src/updates/unsignedMacUpdate.ts)):

1. electron-updater checks the channel feed as usual.
2. **Download** fetches the feed's arm64 zip directly and checks its size and
   sha512 against the feed. It extracts the zip with `ditto` into
   `<Cogenly home>/caches/desktop-update/` and checks that the bundle has the
   offered version and the running app's bundle identifier.
3. **Install** asks for confirmation as usual. It then stops the backends,
   starts a detached shell helper, and quits normally. The helper waits for the
   app's PID to exit, moves the installed bundle into the cache, and moves the
   new bundle into its place. It starts the new executable directly, with the
   environment the app had, so `COGENLY_HOME` and similar settings carry over.
   `ELECTRON_RUN_AS_NODE` is dropped.
4. Every unsigned macOS start writes `runtime/desktop-update-launched` once
   Electron is ready. If the new app exits first, or the marker has not
   appeared after 90 seconds, the helper stops that process. It then restores
   the old bundle and starts it the same way. The old app reports that the
   version did not apply. The helper logs to `desktop-update-helper.log` in
   the desktop log directory.

The app falls back to opening the DMG when it cannot replace itself: macOS is
running a translocated copy, it runs from the disk image, the bundle or its
folder is not writable, or the feed lists no zip. Its update message says which.
Remote update requests install unsigned updates like signed ones. They stop
with an explanation only in that fallback.

For an end-to-end local check (no GitHub publication), on an Apple Silicon Mac:

```sh
# Build an older mock-feed app and a newer mock-feed update into separate dirs.
pnpm exec vp run dist:desktop:dmg:arm64 --build-version 0.1.0 --mock-updates --output-dir release-old
pnpm exec vp run dist:desktop:dmg:arm64 --build-version 0.1.1 --mock-updates --output-dir release-mock
# Serve exactly the directory containing latest-mac.yml, DMG, zip, and blockmaps.
COGENLY_DESKTOP_MOCK_UPDATE_SERVER_ROOT="$PWD/release-mock" \
  pnpm exec vp run start:mock-update-server
```

Install and launch the older DMG from `/Applications`, check for updates, and
confirm Download fetches `http://localhost:3000/Cogenly-0.1.1-arm64.zip` without
quitting the app. Install and confirm it restarts into the new version. Run the
older app from the mounted DMG and confirm Download opens the DMG instead. To test a
real automatic installation, build **both** artifacts with `--signed` and local
signing/notary credentials; confirm Download → Install restarts into the new
version. These commands
are maintainer procedures, not part of the agent's targeted test run.

## Rollback

Prefer a **forward fix**: revert the bad commit on `main`, wait for its CI, then
promote it with a higher prod version. Automatic prod updates
do not downgrade. For an urgent stop, edit the bad release back to a draft and
mark a known-good prod release latest; this prevents further offers but does not
downgrade machines already updated. Those users can manually install the older
DMG or wait for the forward fix. Never rewrite published tags or replace release
assets. Keep release signing-mode labels accurate during rollback.

See [repository setup](./repo-setup.md) before the first publication.
