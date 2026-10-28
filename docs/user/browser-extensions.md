# Browser extensions

Cogenly's browser can run Chromium extensions, such as an ad blocker, a password manager or a tool that marks up pages. Each browser profile has its own extensions.

## Add one

- In the browser panel, open the extensions menu (the puzzle piece in the toolbar) and choose **Add extension…**. Paste the extension's Chrome Web Store link or its ID.
- Or go to **Settings → Integrations → Browser → Browser extensions**, choose a profile, and add it there. The command palette's **Manage browser extensions** opens the same place.
- To install an extension you are building, enter the absolute path to its unpacked folder on the machine Cogenly runs on. After you rebuild it, choose **Reload from folder** in its menu or its details. It keeps its ID either way.

Cogenly downloads extensions only from the Chrome Web Store. It checks the Web Store's signature before installing anything. Adding an extension that is already installed updates it to the current version.

Each extension lists the sites it can read and change. Install only extensions you trust with those sites.

## Use them

Extensions with a toolbar button show their icon beside the address bar; the first three sit there and the rest are in the extensions menu.

- Click an icon to open its popup under it, as in Chrome. Click outside it or press Esc to close it. A popup acts on the tab it opened from.
- Extensions with a side panel open it from the extensions menu. It sits beside the page, and you can drag its edge to resize it. In a narrow panel it covers the page until you close it. While the browser panel has focus, `Cmd+Option+E` on macOS or `Ctrl+Alt+E` on Windows and Linux opens or closes the side panel of the extension you used last.
- The extensions menu also turns each extension on or off, opens its options page in a tab, and shows **Details**: its version, ID, source, access, pages and whether it loaded.

## When one fails to load

An extension that fails to load is skipped so browsing can continue. Its icon and its row in the menu and in Settings carry a red mark, and **Details** shows the browser's reason. Fix the problem and reinstall it, reload it from its folder, or turn it off.

## Agents

Agents can install, list, reload, turn off and remove extensions themselves. They can open a popup or side panel for a website tab, click an extension's toolbar action, and open its options page. A popup or side panel an agent opens shows in your panel too, beside the tab it belongs to. A popup an agent opened doesn't take your keyboard focus and stays open until the agent closes it or you press its close button. Ask in plain words, for example "open this extension's side panel for the current page".

With `browser_extension_open`, pass the website's `tabId` and choose `page: "popup"`, `"sidePanel"`, or `"action"`. The website must be a server browser tab in the extension's profile. Options pages open with `page: "options"`.

## Where extensions run

Extensions run in Cogenly's built-in Chrome on the machine that owns the tab, and its tabs stream into the browser panel, including in the desktop app.

- In the desktop app, new tabs in a profile with enabled extensions open in that Chrome. Tabs you already had stay where they are, with their pages and logins intact, and show the extension icons greyed out. Open a new tab to use your extensions. Turning off or removing every extension makes new desktop tabs native again.
- A desktop tab of a paired machine runs on your computer, where that machine's extensions don't run. Move the tab to the machine's browser from the extensions menu to use them.
- Extension tabs keep their own browsing storage, so you may need to sign in again in them.
- The first time a profile needs extensions, the machine downloads a larger copy of Chrome (about 200 MB).
- Changing a profile's extensions restarts its browser, which closes its streamed tabs. Tabs the desktop app draws itself are never moved or closed.
- Incognito never runs extensions.

The extension list belongs to each machine. A paired machine keeps its own list.

## Popups and side panels

Extension popups and side panels stream into the browser panel beside their host website: a popup hangs from its toolbar icon at the size the extension asks for, and a side panel sits in a column beside the page. Toolbar actions run against that host, including actions that have no popup. Closing the host also closes its popups and side panels.

Some extensions need a fallback page whose behavior differs from a native popup or side panel; Cogenly shows a notice when that happens. Options pages open as ordinary tabs.

## Passwords

Extensions can read the pages they have access to, including fields where Cogenly fills a password from the vault. Turn off extensions you don't trust before signing in with the vault.
