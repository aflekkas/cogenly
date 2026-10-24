import { ensureLocalApi } from "../../localApi";

/**
 * Opens the service's sign-in page from a click. A web browser blocks a tab
 * opened after an await, so the tab opens first and follows the link once the
 * server returns it; the desktop app hands the link to the system browser.
 */
export async function openSignInPage(link: () => Promise<string | null>) {
  const tab = window.desktopBridge ? null : window.open("", "_blank");
  let url: string | null;
  try {
    url = await link();
  } catch (cause) {
    tab?.close();
    throw cause;
  }
  if (url === null) {
    tab?.close();
    return;
  }
  if (tab) {
    tab.opener = null;
    tab.location.href = url;
    return;
  }
  if (window.desktopBridge) await ensureLocalApi().shell.openExternal(url);
  else window.location.assign(url);
}
