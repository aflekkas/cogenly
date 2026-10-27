// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Owns native Chrome targets and event deadlines.
import type {
  BrowserExtension,
  BrowserExtensionOpenSurfaceInput,
  PreviewExtensionSurface,
} from "@cogenly/contracts";
import type { Page } from "playwright-core";
import {
  adoptExtensionTarget,
  ExtensionPipe,
  hostTabTarget,
  type ExtensionTarget,
} from "./ServerBrowserExtensionRelay.ts";

/** Action behavior can be changed by the worker, including module workers using setPanelBehavior. */
export function extensionActionKind(
  requested: BrowserExtensionOpenSurfaceInput["kind"],
  popup: string | undefined,
  opensPanel: boolean,
): PreviewExtensionSurface["kind"] | undefined {
  if (requested === "sidePanel") return "sidePanel";
  if (opensPanel) return "sidePanel";
  return popup ? "popup" : undefined;
}

export async function openExtensionSurface(
  host: Page,
  extension: BrowserExtension,
  requested: BrowserExtensionOpenSurfaceInput["kind"],
  createPage: () => Promise<Page> = () => host.context().newPage(),
) {
  const context = host.context();
  const browser = context.browser();
  if (!browser)
    throw new Error(
      "Extension surfaces require a server Chrome tab. Move the host tab to the server browser.",
    );
  const pipe = new ExtensionPipe(await browser.newBrowserCDPSession());
  let release = true;
  try {
    const pageSession = await context.newCDPSession(host);
    const { targetInfo } = await pageSession.send("Target.getTargetInfo");
    await pageSession.detach();
    const targetId = await hostTabTarget(pipe, targetInfo.targetId);
    await host.bringToFront();
    const evaluateWorker = async <A>(expression: string): Promise<A | undefined> => {
      // Extensions.loadUnpacked can start a worker that Playwright's original
      // context did not announce. Discover it on the browser pipe as well.
      const worker = (await pipe.cdp.send("Target.getTargets", { filter: [{}] })).targetInfos.find(
        (target) =>
          target.type === "service_worker" &&
          target.url.startsWith(`chrome-extension://${extension.id}/`),
      );
      if (!worker) return undefined;
      const { sessionId } = await pipe.send("Target.attachToTarget", { targetId: worker.targetId });
      if (typeof sessionId !== "string") return undefined;
      try {
        const result = await pipe.send(
          "Runtime.evaluate",
          { expression, awaitPromise: true, returnByValue: true },
          sessionId,
        );
        if (result.exceptionDetails) throw new Error("The extension worker rejected the action.");
        return (result.result as { value?: A }).value;
      } finally {
        await pipe.send("Target.detachFromTarget", { sessionId }).catch(() => {});
      }
    };
    const settings = await evaluateWorker<{
      popup?: string;
      path?: string;
      enabled?: boolean;
      opensPanel?: boolean;
    }>(`(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const popup = await chrome.action?.getPopup({ tabId: tab?.id });
      const options = await chrome.sidePanel?.getOptions({ tabId: tab?.id });
      const behavior = await chrome.sidePanel?.getPanelBehavior();
      return { popup, path: options?.path, enabled: options?.enabled, opensPanel: behavior?.openPanelOnActionClick };
    })()`).catch(() => undefined);
    const relativePath = (path: string | undefined) =>
      path?.replace(`chrome-extension://${extension.id}/`, "").replace(/^\/+/, "");
    const popup = relativePath(settings?.popup ?? extension.popupPage);
    const kind = extensionActionKind(requested, popup, settings?.opensPanel ?? false);
    const path =
      kind === "sidePanel" ? relativePath(settings?.path ?? extension.sidePanelPage) : popup;
    if (kind === "sidePanel" && settings?.enabled === false)
      throw new Error("This extension's side panel is disabled for the host tab.");
    const before = new Set(
      (await pipe.cdp.send("Target.getTargets", { filter: [{}] })).targetInfos.map(
        (target) => target.targetId,
      ),
    );
    const targets = new Map<string, ExtensionTarget>();
    let signal: (() => void) | undefined;
    const changed = ({ targetInfo }: { targetInfo: ExtensionTarget }) => {
      if (
        targetInfo.type !== "page" ||
        before.has(targetInfo.targetId) ||
        !targetInfo.url.startsWith(`chrome-extension://${extension.id}/`)
      )
        return;
      const candidatePath = new URL(targetInfo.url).pathname.replace(/^\//, "");
      const expected = requested === "sidePanel" ? [path] : [];
      if (
        expected.some(Boolean) &&
        !expected.some((path) => path?.split(/[?#]/)[0] === candidatePath)
      )
        return;
      targets.set(targetInfo.targetId, targetInfo);
      signal?.();
    };
    pipe.cdp.on("Target.targetCreated", changed);
    pipe.cdp.on("Target.targetInfoChanged", changed);
    await pipe.cdp.send("Target.setDiscoverTargets", { discover: true, filter: [{}] });
    const find = async () => {
      for (const targetInfo of (await pipe.cdp.send("Target.getTargets", { filter: [{}] }))
        .targetInfos)
        changed({ targetInfo });
      return targets.values().next().value;
    };
    const waitForTarget = async () => {
      const existing = await find();
      if (existing) return existing;
      return new Promise<ExtensionTarget | undefined>((resolve) => {
        const timer = setTimeout(() => {
          signal = undefined;
          resolve(undefined);
        }, 1500);
        signal = () => {
          clearTimeout(timer);
          signal = undefined;
          resolve(targets.values().next().value);
        };
        if (targets.size) signal();
      });
    };
    let target: ExtensionTarget | undefined;
    let actionError: unknown;
    try {
      // For a side panel without openPanelOnActionClick, a toolbar click may open
      // an unrelated popup. Go straight to its configured panel page instead.
      if (requested !== "sidePanel" || settings?.opensPanel !== false) {
        try {
          await pipe.cdp.send("Extensions.triggerAction", { id: extension.id, targetId });
        } catch (cause) {
          actionError = cause;
        }
        target = await waitForTarget();
      }
      if (!target && kind === "popup") {
        await evaluateWorker("chrome.action.openPopup()").catch(() => {});
        target = await waitForTarget();
      }
    } finally {
      pipe.cdp.off("Target.targetCreated", changed);
      pipe.cdp.off("Target.targetInfoChanged", changed);
    }
    if (target) {
      // tabs.create/openOptionsPage already belong to the original context and
      // its page listener. Only native UI targets need the second CDP client.
      for (const page of context.pages()) {
        const session = await context.newCDPSession(page).catch(() => undefined);
        if (!session) continue;
        const info = await session.send("Target.getTargetInfo").catch(() => undefined);
        await session.detach().catch(() => {});
        if (info?.targetInfo.targetId === target.targetId) return undefined;
      }
      const adopted = await adoptExtensionTarget(pipe, target);
      release = false;
      return {
        ...adopted,
        kind:
          new URL(target.url).pathname.slice(1) ===
          relativePath(settings?.path ?? extension.sidePanelPage)
            ? ("sidePanel" as const)
            : (kind ?? "popup"),
        close: async () => {
          await adopted.close();
          await pipe.close();
        },
      };
    }
    if (!kind) {
      if (actionError) throw actionError;
      return undefined;
    }
    if (!path)
      throw new Error(
        `This extension has no ${kind === "sidePanel" ? "side panel" : "popup"} page configured for the host tab.`,
      );
    const page = await createPage();
    try {
      await page.goto(`chrome-extension://${extension.id}/${path.replace(/^\/+/, "")}`, {
        waitUntil: "domcontentloaded",
      });
    } catch (cause) {
      await page.close().catch(() => {});
      throw cause;
    }
    return {
      page,
      kind,
      close: async () => {},
      notice: `Opened the extension's ${kind === "popup" ? "popup" : "side panel"} as a surface page. This is not a native ${kind === "popup" ? "popup" : "side panel"}; active-tab queries can differ.`,
    };
  } finally {
    if (release) await pipe.close();
  }
}
