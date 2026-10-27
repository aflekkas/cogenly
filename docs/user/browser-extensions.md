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

- **Background and agent tabs, and every tab on a remote machine or VPS**, run the full set of Chrome extension features. The first time a profile needs extensions, that machine downloads a larger copy of Chrome (about 200 MB).
- **The desktop app's browser panel**, for the machine it runs on, supports content scripts, background workers, storage and extension pages. It does not support ad-blocking rules, cookies, context menus or notifications, so most ad blockers and password managers do nothing there.
- Incognito never runs extensions.

Changing a profile's extensions restarts its background browser, which closes that profile's background tabs.

The extension list belongs to each machine. A paired machine keeps its own list.

## Popups open as tabs

Cogenly's browser has no extension toolbar. An extension's popup opens as a normal tab instead, so a popup that acts on "the current page" sees itself rather than the page you meant. Extensions whose toolbar button runs an action without showing a popup can't be triggered.

## Passwords

Extensions can read the pages they have access to, including fields where Cogenly fills a password from the vault. Turn off extensions you don't trust before signing in with the vault.
