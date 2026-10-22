# Desktop releases

Cogenly ships **macOS arm64** DMG and zip artifacts from
[Release](../../.github/workflows/release.yml). It publishes **prod** only,
GitHub's latest release, behind the **production** approval gate. No npm, relay,
AUR, Discord, mobile, or hosted-web deployment runs here. Standalone CLI archives
are not published; `cogenly update`/`t3 update` remains disabled with an explicit
message. Its channel flag uses `prod` and `staging` for future archive publication;
CLI binaries bundled in the desktop app update with the app.

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
Releases are uploaded as drafts before publication so partial uploads are not
offered as updates. An interrupted publish can leave a draft; inspect it before
retrying. Existing releases are never overwritten automatically.

### Build speed

A run takes about five minutes of machine time before the approval wait. Most
of it is the macOS packaging step: the web build, the Rust resource monitor, and
electron-builder producing the zip and DMG in parallel. Both artifacts ship:
the DMG is the first-install download and the zip is the update payload.

- Every job sets up Node from `engines` in package.json and pnpm from
  `packageManager`, then runs `pnpm install --frozen-lockfile` with the pnpm
  store cached on the lockfile. `vp` is the lockfile's `vite-plus`, from
  `node_modules/.bin`. CI and Release don't use `voidzero-dev/setup-vp`: its
  installer resolves the Vite+ CLI through npm's per-version metadata endpoint,
  and that endpoint has failed for every version at once.
- The resource monitor's crates and Cargo target dir are cached with
  `Swatinem/rust-cache`.
- The build job checks out the commit shallowly, since packaging reads only
  `HEAD`. The artifact uploads without recompressing the DMG and zip.
- The publish job installs no toolchain. The resolve job passes the previous
  prod tag to it, so after approval it only downloads the artifact, writes the
  notes, and publishes.

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

In desktop Settings → About → Update track, choose **Prod** or **Staging**.
Prod retains internal/persisted ID `latest` and reads `latest-mac.yml` with
prereleases disallowed. Staging uses ID `staging`, allows prereleases, and reads
`staging-mac.yml`. Existing explicit nightly preferences migrate to staging.
Prod installs never receive staging unless the user switches tracks. Staging
and prod have distinct app names, but share the same saved channel preference.
Updates also check that an offered version matches the selected track.

**Updates are offered only by promotion.** Day-to-day installs are prod builds
on the Prod track, so they see a new version only after it passes the
production gate. The Release workflow no longer publishes staging builds. The
app's Staging track and its `staging-mac.yml` code remain, but receive no new
builds, so installs on that track stay on the last staging prerelease until
the user switches to Prod. The app checks its feed
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
older app from the mounted DMG and confirm Download opens the DMG instead. Repeat using versions
`0.1.1-staging.20261019.1` and `.2`, selecting Staging and checking
`staging-mac.yml`. Verify Prod does not offer either staging version. To test a
real automatic installation, build **both** artifacts with `--signed` and local
signing/notary credentials; confirm Download → Install restarts into the new
version. Also verify a signed build can switch Staging → Prod. These commands
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
