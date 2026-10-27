// @effect-diagnostics nodeBuiltinImport:off - Owns Playwright resources outside the Effect runtime.
import { INCOGNITO_BROWSER_PROFILE_ID } from "@cogenly/contracts";
import { constVoid } from "effect/Function";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Browser, BrowserContext, CDPSession } from "playwright-core";

import { sandboxDisabled } from "./PreviewBrowserHost.ts";

// Playwright needs its files on disk. createRequire also resolves it from a Node SEA executable.
const requirePlaywright = NodeModule.createRequire(import.meta.url);
const loadPlaywright = () =>
  requirePlaywright("playwright-core") as typeof import("playwright-core");

interface Options {
  readonly profilesDir: string;
  /** The shared headless browser's executable, installing it on first use. */
  readonly executable: () => Promise<string>;
  /** Replaces a failed launch's error with the host setup it is missing, if any. */
  readonly diagnose?: (executable: string, cause: unknown) => Promise<unknown>;
  readonly env?: NodeJS.ProcessEnv;
  readonly onContextClose?: (context: BrowserContext) => void;
  /** Unpacked extension directories a human profile loads; none keeps the headless shell. */
  readonly extensionsFor?: (
    profileId: string,
  ) => Promise<ReadonlyArray<{ readonly id: string; readonly path: string }>>;
  /** A browser that can load extensions, installing it on first use. */
  readonly extensionsExecutable?: () => Promise<string>;
  readonly onExtensionLoad?: (profileId: string, path: string, error?: string) => Promise<void>;
}

/** Keep browser errors useful in tool output without Playwright's launch transcript. */
export const browserErrorMessage = (cause: unknown) => {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    cause._tag === "PreviewBrowserInstallingError"
  ) {
    return "The extension browser is still installing. Extensions will load when installation finishes.";
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return (message.split("\n").find((line) => line.trim()) ?? "Unknown browser error.")
    .replace(/^.*?Protocol error \(Extensions\.loadUnpacked\):\s*/, "")
    .replace(/^browserType\.[^:]+:\s*/, "")
    .trim();
};

const UA_PLATFORMS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "macOS",
  linux: "Linux",
  win32: "Windows",
};

/**
 * The headless shell's identity as the Chrome it is built from: its user agent
 * without `HeadlessChrome`, and client hints whose brands agree with it. Sites
 * block a user agent that disagrees with `Sec-CH-UA`, so both change together.
 */
const chromeIdentity = (
  headlessUserAgent: string,
  host: { readonly platform: NodeJS.Platform; readonly arch: string; readonly release: string },
) => {
  const version = /HeadlessChrome\/((\d+)[\d.]*)/.exec(headlessUserAgent);
  const fullVersion = version?.[1];
  const major = version?.[2];
  if (!version || !fullVersion || !major) return null;
  // Chrome's GREASE brand and order for this major version, as the shell reports them.
  const brands = (names: (version: string) => string) => [
    { brand: "Chromium", version: names(major) },
    { brand: "Google Chrome", version: names(major) },
    { brand: "Not A(Brand", version: names("99") },
  ];
  return {
    // Chrome reduces its user agent to the major version.
    userAgent: headlessUserAgent.replace(version[0], `Chrome/${major}.0.0.0`),
    userAgentMetadata: {
      brands: brands((value) => value),
      fullVersionList: brands((value) => (value === major ? fullVersion : `${value}.0.0.0`)),
      platform: UA_PLATFORMS[host.platform] ?? "Unknown",
      platformVersion: host.platform === "linux" ? host.release : "",
      architecture: host.arch.startsWith("arm") ? "arm" : "x86",
      bitness: host.arch.endsWith("64") ? "64" : "32",
      model: "",
      mobile: false,
      wow64: false,
    },
  };
};

/**
 * Presents a headless page as plain Chrome. Applies to the page, its frames,
 * and its workers; a popup gets its own call once it becomes a tab.
 */
export const presentAsChrome = async (
  cdp: CDPSession,
  host: { readonly platform: NodeJS.Platform; readonly arch: string },
) => {
  const { userAgent } = await cdp.send("Browser.getVersion");
  const identity = chromeIdentity(userAgent, { ...host, release: NodeOS.release() });
  if (identity) await cdp.send("Emulation.setUserAgentOverride", identity);
};

/** Persistent human profiles keep their storage; isolated agents share a browser, never a context. */
export class ServerBrowserContexts {
  private readonly options: Options;
  private readonly contexts = new Map<string, Promise<BrowserContext>>();
  /** Profile clears in progress; a context for that profile opens after its storage is gone. */
  private readonly clearing = new Map<string, Promise<void>>();
  /** The extension directories each running human profile launched with. */
  private readonly launchedExtensions = new Map<string, string>();
  private readonly extensionFallbacks = new Set<string>();
  private browser: Promise<Browser> | undefined;
  private closing: Promise<void> | undefined;

  constructor(options: Options) {
    this.options = options;
  }

  private async launchOptions(executable = this.options.executable) {
    const executablePath = await executable();
    const env = this.options.env ?? process.env;
    return {
      executablePath,
      env,
      // People drive these tabs, so they must not announce automation (navigator.webdriver).
      args: [
        "--disable-gpu",
        "--force-device-scale-factor=2",
        "--disable-blink-features=AutomationControlled",
        // A VPS has no camera or microphone. Pages an agent allows through
        // preview_permission get a synthetic test source instead of an error.
        // Unlike --use-fake-ui-for-media-stream this does not skip permission:
        // an ungranted page is still denied.
        "--use-fake-device-for-media-stream",
      ],
      ignoreDefaultArgs: ["--enable-automation"],
      headless: true,
      // Only an explicit operator opt-out disables sandboxing. Launch errors never do.
      chromiumSandbox: !sandboxDisabled(env),
    };
  }

  private async launch<A>(options: { readonly executablePath: string }, start: () => Promise<A>) {
    try {
      return await start();
    } catch (cause) {
      throw (await this.options.diagnose?.(options.executablePath, cause)) ?? cause;
    }
  }

  private sharedBrowser() {
    if (!this.browser) {
      const launched = this.launchOptions().then(async (options) => {
        const { chromium } = loadPlaywright();
        const browser = await this.launch(options, () => chromium.launch(options));
        browser.on("disconnected", () => {
          if (this.browser === launched) this.browser = undefined;
        });
        return browser;
      });
      this.browser = launched;
      void launched.catch(() => {
        if (this.browser === launched) this.browser = undefined;
      });
    }
    return this.browser;
  }

  contextFor(profileId: string, isolationKey?: string): Promise<BrowserContext> {
    if (this.closing) return Promise.reject(new Error("The preview browser is closed."));
    const key = JSON.stringify([profileId, isolationKey ?? null]);
    const cached = this.contexts.get(key);
    if (cached) return cached;
    const cleared = this.clearing.get(key)?.catch(constVoid) ?? Promise.resolve();
    const pending = cleared
      .then(() => this.createContext(profileId, isolationKey))
      .then(async (context) => {
        context.on("close", () => {
          if (this.contexts.get(key) === pending) this.contexts.delete(key);
          this.options.onContextClose?.(context);
        });
        for (const page of context.pages()) await page.close().catch(constVoid);
        if (this.closing) {
          await context.close().catch(constVoid);
          throw new Error("The preview browser is closed.");
        }
        return context;
      });
    this.contexts.set(key, pending);
    void pending.catch(() => {
      if (this.contexts.get(key) === pending) this.contexts.delete(key);
    });
    return pending;
  }

  private async createContext(profileId: string, isolationKey?: string) {
    const contextOptions = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 };
    if (isolationKey !== undefined || profileId === INCOGNITO_BROWSER_PROFILE_ID) {
      const browser = await this.sharedBrowser();
      return browser.newContext(contextOptions);
    }
    const directory = this.profileDirectory(profileId);
    const extensions = (await this.options.extensionsFor?.(profileId)) ?? [];
    const { chromium } = loadPlaywright();
    await NodeFSP.mkdir(directory, { recursive: true });
    const key = JSON.stringify([profileId, null]);
    const start = async (withExtensions: boolean) => {
      const options = await this.launchOptions(
        withExtensions ? this.options.extensionsExecutable : this.options.executable,
      );
      return this.launch(options, () =>
        chromium.launchPersistentContext(directory, {
          ...options,
          // Load individually after startup: Chrome returns each extension's real error,
          // and a rejected manifest cannot abort the browser's launch.
          // Keep this on while extensions are off: otherwise Chrome persists an
          // unsupported-developer disable reason that survives loadUnpacked.
          // --disable-extensions still prevents execution in those launches.
          args: [...options.args, "--enable-unsafe-extension-debugging"],
          ignoreDefaultArgs: [
            ...options.ignoreDefaultArgs,
            ...(withExtensions ? ["--disable-extensions"] : []),
          ],
          ...contextOptions,
        }),
      );
    };
    const fallback = async (error?: string) => {
      this.launchedExtensions.set(key, "");
      if (extensions.length > 0) this.extensionFallbacks.add(profileId);
      for (const { path } of extensions) {
        if (error) await this.options.onExtensionLoad?.(profileId, path, error);
      }
      return start(false);
    };
    if (extensions.length === 0) {
      this.extensionFallbacks.delete(profileId);
      return fallback();
    }
    let context: BrowserContext;
    try {
      context = await start(true);
    } catch (cause) {
      // A missing or broken full Chrome install must not take down ordinary browsing.
      return fallback(browserErrorMessage(cause));
    }
    let session: CDPSession | undefined;
    let storageSession: CDPSession | undefined;
    try {
      session = await context.browser()!.newBrowserCDPSession();
      storageSession = await context.newCDPSession(context.pages()[0] ?? (await context.newPage()));
      for (const { id, path } of extensions) {
        try {
          // A persisted worker can keep running old scripts after files change.
          // Keep local/extension storage, including chrome.storage, intact.
          await storageSession.send("Storage.clearDataForOrigin", {
            origin: `chrome-extension://${id}`,
            storageTypes: "service_workers,cache_storage",
          });
          await session.send("Extensions.loadUnpacked", { path });
          await this.options.onExtensionLoad?.(profileId, path);
        } catch (cause) {
          await this.options.onExtensionLoad?.(profileId, path, browserErrorMessage(cause));
        }
      }
    } catch (cause) {
      for (const { path } of extensions) {
        await this.options.onExtensionLoad?.(profileId, path, browserErrorMessage(cause));
      }
    } finally {
      await storageSession?.detach().catch(constVoid);
      await session?.detach().catch(constVoid);
    }
    if (!context.browser()?.isConnected()) {
      await context.close().catch(constVoid);
      return fallback("The extension browser disconnected; extensions are not running.");
    }
    this.extensionFallbacks.delete(profileId);
    this.launchedExtensions.set(key, extensions.map(({ path }) => path).join("\n"));
    return context;
  }

  /** Profiles currently browsing without their requested extensions. */
  extensionFallbackProfiles() {
    return [...this.extensionFallbacks];
  }

  /**
   * Closes a human profile's running browser, ending its tabs, so the next tab
   * starts it again with the profile's current extensions. Keeps its storage.
   * False when it was not running.
   */
  async restartProfile(profileId: string, extensions: ReadonlyArray<string>) {
    const key = JSON.stringify([profileId, null]);
    const pending = this.contexts.get(key);
    if (!pending) return false;
    // Already running exactly these.
    if (this.launchedExtensions.get(key) === extensions.join("\n")) return false;
    this.contexts.delete(key);
    const closing = (async () => {
      const context = await pending.catch(() => undefined);
      await context?.close().catch(constVoid);
      return context !== undefined;
    })();
    // A concurrent tab must not launch against a profile whose browser still
    // holds its lock. Publish the barrier before yielding to the close.
    const clearing = closing.then(constVoid);
    this.clearing.set(key, clearing);
    try {
      return await closing;
    } finally {
      if (this.clearing.get(key) === clearing) this.clearing.delete(key);
    }
  }

  private profileDirectory(profileId: string) {
    const encoded = encodeURIComponent(profileId);
    return NodePath.join(
      this.options.profilesDir,
      profileId === "." || profileId === ".." ? encoded.replaceAll(".", "%2E") : encoded,
    );
  }

  /** A throwaway page in the shared browser, for work that must not touch a tab's own storage. */
  async scratchPage() {
    if (this.closing) throw new Error("The preview browser is closed.");
    const context = await (await this.sharedBrowser()).newContext();
    const page = await context.newPage();
    page.once("close", () => void context.close().catch(constVoid));
    return page;
  }

  /**
   * Drives a page the desktop app renders, through the CDP endpoint its relay
   * serves. The page keeps the desktop's storage, size, and window.
   */
  async connectDesktopPage(endpoint: string) {
    const { chromium } = loadPlaywright();
    const browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 });
    const page = browser.contexts().flatMap((context) => context.pages())[0];
    if (!page) {
      await browser.close().catch(constVoid);
      throw new Error("The desktop tab has no page.");
    }
    return { browser, page };
  }

  /** Closes a human profile's persistent context, ending its tabs, then deletes its storage. */
  async clearProfile(profileId: string) {
    if (profileId === INCOGNITO_BROWSER_PROFILE_ID) return;
    const key = JSON.stringify([profileId, null]);
    const clearing = (async () => {
      const pending = this.contexts.get(key);
      if (pending) {
        this.contexts.delete(key);
        const context = await pending.catch(() => undefined);
        await context?.close();
      }
      await NodeFSP.rm(this.profileDirectory(profileId), { recursive: true, force: true });
    })();
    this.clearing.set(key, clearing);
    try {
      await clearing;
    } finally {
      if (this.clearing.get(key) === clearing) this.clearing.delete(key);
    }
  }

  close() {
    this.closing ??= this.dispose();
    return this.closing;
  }

  private async dispose() {
    await Promise.allSettled(
      [...this.contexts.values()].map(async (pending) => (await pending).close()),
    );
    const browser = await this.browser?.catch(() => undefined);
    await browser?.close().catch(constVoid);
    this.contexts.clear();
  }
}
