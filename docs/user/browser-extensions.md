# Browser extensions

Cogenly's browser can run Chromium extensions, such as an ad blocker or a tool that marks up pages. Each browser profile has its own extensions.

## Add one

- In the browser panel, open **⋮ → Extensions → Add from Chrome Web Store…** and paste the extension's Chrome Web Store link or its ID.
- Or go to **Settings → Integrations → Browser → Browser extensions**, choose a profile, and add it there.
- To install an extension you are building, enter the absolute path to its unpacked folder on the machine Cogenly runs on.

Cogenly downloads extensions only from the Chrome Web Store. It checks the Web Store's signature before installing anything. Adding an extension that is already installed updates it to the current version.

The same menus can turn an extension off, remove it, and open its popup or options page in a tab. Each extension lists the sites it can read and change. Install only extensions you trust with those sites.

## Agents

Agents can install, list, turn off and remove extensions themselves, and open an extension's popup or options page as a tab they can click through. Ask in plain words, for example "install uBlock Origin Lite in my Work profile".

## Where extensions run

- Profiles with enabled extensions run in full Chrome on their machine and stream into the browser panel, including in the desktop app. The first time a profile needs extensions, that machine downloads a larger copy of Chrome (about 200 MB).
- These profiles keep separate browsing storage from native desktop tabs. You may need to sign in again after first enabling extensions.
- Incognito never runs extensions.

Changing a profile's extensions restarts its browser, which closes its server browser tabs. Reinstall an unpacked folder after rebuilding it, even if its version has not changed.

An extension that fails to load is skipped so browsing can continue. Agents can read its name and the load error with `browser_extensions_list`; reinstall or turn it off after correcting the problem.

The extension list belongs to each machine. A paired machine keeps its own list.

## Popups open as tabs

Cogenly's browser has no extension toolbar. An extension's popup opens as a normal tab instead, so a popup that acts on "the current page" sees itself rather than the page you meant. Extensions whose toolbar button runs an action without showing a popup can't be triggered.

## Passwords

Extensions can read the pages they have access to, including fields where Cogenly fills a password from the vault. Turn off extensions you don't trust before signing in with the vault.
