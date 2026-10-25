# Import browser sessions

Open **Settings → Integrations → Browser → Import sign-ins from another browser**.
Choose a source browser and profile, a Cogenly profile, and comma-separated domains
such as `github.com,linear.app`. Preview the counts, then import. Leave domains empty
to copy everything. Reload open tabs afterward.

You can also run this on the machine holding your logins:

```sh
cogenly browser import-cookies --list
cogenly browser import-cookies --from chrome --profile Default --domain github.com,linear.app --dry-run
cogenly browser import-cookies --from chrome --profile Default --to default --domain github.com,linear.app
```

Omit `--from` or `--profile` to include every detected browser or source profile.
Listing and dry runs work while Cogenly is stopped; importing needs the local server.
Matching cookies are replaced. Later login changes stay separate, and some sites
may require another sign-in. Choose **Clear profile data** to remove its sign-ins and site data.

macOS supports Chrome, Chromium, Dia, Arc, Brave, Edge, Vivaldi, Opera, Helium,
Firefox, and Safari. Approve the macOS Keychain prompt for Chromium browsers.
Safari needs **System Settings → Privacy & Security → Full Disk Access** for Cogenly
(or your terminal when running the server there). Restart it if the grant does not
apply immediately. You can revoke the grant after importing. Safari's file does not
expose reliable SameSite metadata, so its imports use Lax.

Linux supports detected Chromium-family and Firefox profiles, including Chromium
and Firefox Snap profiles. Encrypted Chromium cookies may need an unlocked keyring
and `secret-tool` from `libsecret-tools`. A VPS without local profiles has nothing
to import. Expired and unsupported partitioned cookies are skipped.

Cogenly reads the source cookie store and its local encryption key when needed.
It writes cookies into its browser profile on that same machine, including the desktop
app when it launched that server. Nothing leaves the machine or enters vault sync.
Remote clients operate only on stores already on the selected machine. Output contains
domain counts, never cookie values. Agents use `browser_cookie_sources` and
`browser_import_cookies` with only the domains needed for their task; no extra Cogenly
approval is required. The operating system still controls Keychain consent.

The desktop's **Browser profiles → Add profile → Import from** also creates profiles
from local browsers. That flow requires closing the source browser first. On Windows,
it supports Firefox and Helium profiles with standard encryption; app-bound Chromium
encryption cannot be imported.
