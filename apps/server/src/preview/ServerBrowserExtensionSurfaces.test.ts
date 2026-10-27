// @effect-diagnostics nodeBuiltinImport:off - Tests real Chrome in temporary profiles and isolated server state.
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  PreviewTabId,
  type PreviewAutomationStatus,
} from "@cogenly/contracts";
import { NodeCrypto } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@cogenly/shared/HostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/http";
import * as NodeHttp from "node:http";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as Vault from "../vault/Vault.ts";
import * as Config from "../config.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import type { McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as Channel from "./DesktopBrowserChannel.ts";
import * as Manager from "./Manager.ts";
import * as Browser from "./PreviewBrowser.ts";
import * as Extensions from "./BrowserExtensions.ts";
import * as ServerBrowser from "./ServerBrowser.ts";
import { extensionActionKind } from "./ServerBrowserExtensionSurfaces.ts";

const chrome = (() => {
  const configured = process.env.COGENLY_TEST_EXTENSION_CHROME;
  if (configured) return configured;
  const require = NodeModule.createRequire(import.meta.url);
  const bundled = (
    require("playwright-core") as typeof import("playwright-core")
  ).chromium.executablePath();
  return NodeFS.existsSync(bundled) ? bundled : undefined;
})();
const threadId = ThreadId.make("thread:extension-surfaces");
const otherThreadId = ThreadId.make("thread:other-profile-tab");
const environmentId = EnvironmentId.make("environment:extension-test");
const scope: McpThreadInvocationScope = {
  environmentId,
  capabilities: new Set(["preview"]),
  issuedAt: 0,
  requestNamespace: "test",
  client: undefined,
  thread: {
    threadId,
    providerSessionId: "extension-test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
};

it("chooses popup, onClicked, or side panel from runtime action behavior", () => {
  expect(extensionActionKind("popup", "popup.html", false)).toBe("popup");
  expect(extensionActionKind("popup", undefined, false)).toBeUndefined();
  expect(extensionActionKind("action", undefined, false)).toBeUndefined();
  expect(extensionActionKind("action", "popup.html", false)).toBe("popup");
  expect(extensionActionKind("popup", "popup.html", true)).toBe("sidePanel");
  expect(extensionActionKind("sidePanel", "popup.html", false)).toBe("sidePanel");
});

it.effect("refuses a surface whose host was already closed", () =>
  Effect.gen(function* () {
    const manager = yield* Manager.PreviewManager;
    const host = yield* manager.open({ threadId, runtime: "server" });
    yield* manager.close({ threadId, tabId: host.tabId });
    const error = yield* Effect.flip(
      manager.open({
        threadId,
        runtime: "server",
        extensionSurface: { kind: "popup", extensionId: "a".repeat(32), hostTabId: host.tabId },
      }),
    );
    expect(error._tag).toBe("PreviewSessionLookupError");
    expect((yield* manager.list({ threadId })).sessions).toEqual([]);
  }).pipe(Effect.provide(Manager.layer.pipe(Layer.provide(NodeCrypto.layer)))),
);

it.effect("surface sessions always stream and cannot be claimed as native", () =>
  Effect.gen(function* () {
    const manager = yield* Manager.PreviewManager;
    const host = yield* manager.open({ threadId, runtime: "server" });
    const surface = yield* manager.open({
      threadId,
      runtime: "desktop",
      serverRendering: "native",
      extensionSurface: { kind: "popup", extensionId: "a".repeat(32), hostTabId: host.tabId },
    });
    expect(surface.runtime).toBe("server");
    expect(surface.serverRendering).toBe("stream");
    yield* manager.reportServerRendering({ ...surface, serverRendering: "native" });
    const saved = (yield* manager.list({ threadId })).sessions.find(
      (tab) => tab.tabId === surface.tabId,
    )!;
    expect(saved.serverRendering).toBe("stream");
  }).pipe(Effect.provide(Manager.layer.pipe(Layer.provide(NodeCrypto.layer)))),
);

const rig = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogenly-extension-surfaces-" });
  const folder = path.join(root, "extension");
  yield* fs.makeDirectory(folder);
  yield* fs.writeFileString(
    path.join(folder, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "Surface test",
      version: "1.0.0",
      permissions: ["storage", "tabs", "sidePanel"],
      host_permissions: ["http://127.0.0.1/*"],
      action: { default_popup: "popup.html" },
      background: { service_worker: "worker.js", type: "module" },
      side_panel: { default_path: "panel.html" },
      options_page: "options.html",
      content_scripts: [{ matches: ["http://127.0.0.1/*"], js: ["content.js"] }],
    }),
  );
  yield* fs.writeFileString(
    path.join(folder, "worker.js"),
    `
    globalThis.ready = chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
    chrome.action.onClicked.addListener(async () => { await chrome.storage.local.set({ actionClicked: true }); });
  `,
  );
  for (const [file, title] of [
    ["popup", "Popup"],
    ["panel", "Panel"],
    ["options", "Options"],
  ]) {
    yield* fs.writeFileString(
      path.join(folder, `${file}.html`),
      `<!doctype html>${file === "popup" ? "<style>body{display:flow-root;margin:0;width:320px;height:180px}</style>" : ""}<h1>${title}</h1><button>Test content script</button><output>idle</output><script src="ui.js"></script>`,
    );
  }
  yield* fs.writeFileString(
    path.join(folder, "ui.js"),
    `document.querySelector('button').onclick = async () => {
    const [host] = await chrome.tabs.query({url: 'http://127.0.0.1/*'});
    const result = await chrome.tabs.sendMessage(host.id, {});
    document.querySelector('output').textContent = result;
  };`,
  );
  yield* fs.writeFileString(
    path.join(folder, "content.js"),
    `chrome.runtime.onMessage.addListener((_m,_s,respond) => respond('content script reached'));`,
  );
  const site = NodeHttp.createServer((_q, r) => r.end("<!doctype html><h1>Host page</h1>"));
  yield* Effect.promise(() => new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve)));
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => new Promise<void>((resolve) => site.close(() => resolve()))),
  );
  const address = site.address();
  const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`;
  const extensions = yield* Extensions.makeBrowserExtensions({ rootDir: path.join(root, "store") });
  const configLayer = Config.layerTest(root, { prefix: "extension-surfaces-" });
  const dependencies = yield* Layer.build(
    Layer.mergeAll(
      Manager.layer,
      Broker.layer,
      configLayer,
      Layer.succeed(Extensions.BrowserExtensions, extensions),
      Layer.mock(Vault.Vault)({}),
      Layer.mock(Environment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(environmentId),
      }),
      Layer.mock(Browser.PreviewBrowser)({
        executable: Effect.succeed(chrome!),
        extensionsExecutable: Effect.succeed(chrome!),
        extensionsReady: Stream.empty,
      }),
      Layer.mock(Channel.DesktopBrowserChannel)({
        available: false,
        attached: Stream.empty,
        detached: Stream.empty,
        isAttached: () => Effect.succeed(false),
      }),
    ).pipe(Layer.provideMerge(NodeServices.layer), Layer.provideMerge(NodeCrypto.layer)),
  );
  const broker = Context.get(dependencies, Broker.PreviewAutomationBroker);
  const connected = yield* Deferred.make<void>();
  const liveTabs = new Set<string>();
  const milestones = new Set<() => void>();
  const reporting = {
    ...broker,
    focusHost: (input: Parameters<typeof broker.focusHost>[0]) =>
      broker.focusHost(input).pipe(
        Effect.andThen(() =>
          Effect.sync(() => {
            liveTabs.clear();
            for (const tab of input.liveTabs ?? []) liveTabs.add(tab.tabId);
            for (const check of milestones) check();
          }),
        ),
        Effect.andThen(Deferred.succeed(connected, undefined)),
        Effect.asVoid,
      ),
  };
  const browserContext = yield* Layer.build(
    ServerBrowser.layer.pipe(
      Layer.provide(
        Layer.succeedContext(Context.add(dependencies, Broker.PreviewAutomationBroker, reporting)),
      ),
      Layer.provide(Layer.succeed(HostProcess.HomeDirectory, root)),
    ),
  );
  yield* Deferred.await(connected);
  const invoke = <A>(
    operation: Parameters<typeof broker.invoke>[0]["operation"],
    tabId?: string,
    input: unknown = {},
  ) =>
    broker.invoke<A>({
      scope,
      operation,
      input,
      ...(tabId ? { tabId: PreviewTabId.make(tabId) } : {}),
    });
  const manager = Context.get(dependencies, Manager.PreviewManager);
  const awaitTab = (predicate: () => boolean) =>
    Effect.callback<void>((resume) => {
      const check = () => {
        if (predicate()) {
          milestones.delete(check);
          resume(Effect.void);
        }
      };
      milestones.add(check);
      check();
      return Effect.sync(() => {
        milestones.delete(check);
      });
    });
  const awaitPage = (url: string) =>
    Effect.gen(function* () {
      const subscription = yield* manager.subscribeEvents;
      const { sessions } = yield* manager.list({ threadId });
      if (
        sessions.some(
          (session) => session.navStatus._tag === "Success" && session.navStatus.url === url,
        )
      )
        return;
      yield* Stream.fromSubscription(subscription).pipe(
        Stream.filter(
          (event) =>
            event.type === "navigated" &&
            event.threadId === threadId &&
            event.snapshot.navStatus._tag === "Success" &&
            event.snapshot.navStatus.url === url,
        ),
        Stream.take(1),
        Stream.runDrain,
      );
    }).pipe(Effect.scoped);
  const awaitPreferredSize = (tabId: string, width: number, height: number) =>
    Effect.gen(function* () {
      const subscription = yield* manager.subscribeEvents;
      const matches = (snapshot: import("@cogenly/contracts").PreviewSessionSnapshot) =>
        snapshot.tabId === tabId &&
        snapshot.extensionSurface?.preferredSize?.width === width &&
        snapshot.extensionSurface.preferredSize.height === height;
      if ((yield* manager.list({ threadId })).sessions.some(matches)) return;
      yield* Stream.fromSubscription(subscription).pipe(
        Stream.filter((event) => event.type === "navigated" && matches(event.snapshot)),
        Stream.take(1),
        Stream.runDrain,
      );
    }).pipe(Effect.scoped);
  const installed = yield* extensions.install({ source: folder });
  yield* extensions.subscribe({}).pipe(
    Stream.filter((list) =>
      list.extensions.some(
        (entry) => entry.id === installed.extension.id && entry.state === "loaded",
      ),
    ),
    Stream.take(1),
    Stream.runDrain,
  );
  const host = yield* invoke<PreviewAutomationStatus>("open", undefined, {
    url,
    profileId: "default",
    open: false,
    reuseExistingTab: false,
  });
  const openSurface = (kind: "popup" | "sidePanel" | "action") =>
    extensions.openSurface({ id: installed.extension.id, kind, hostTabId: host.tabId!, threadId });
  return {
    extensions,
    browser: Context.get(browserContext, ServerBrowser.ServerBrowser),
    manager,
    invoke,
    host,
    openSurface,
    awaitTab,
    awaitPage,
    awaitPreferredSize,
    liveTabs,
    root,
    folder,
    url,
    id: installed.extension.id,
  };
});
const provide = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | FileSystem.FileSystem
    | Path.Path
    | import("effect/http/HttpClient").HttpClient
    | import("effect/Scope").Scope
  >,
) =>
  effect.pipe(
    Effect.scoped,
    Effect.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer)),
  );

describe.skipIf(!chrome)("real Chrome extension surfaces", () => {
  it.live("reveals new and reused MCP surfaces while toolbar opens remain unrevealed", () =>
    provide(
      Effect.gen(function* () {
        const r = yield* rig;
        const host = yield* r.manager.open({
          threadId,
          runtime: "server",
          profileId: "default",
          url: r.url,
        });
        yield* r.awaitTab(() => r.liveTabs.size === 2);
        const toolbar = yield* r.extensions.openSurface({
          id: r.id,
          kind: "sidePanel",
          hostTabId: host.tabId,
          threadId,
        });
        const toolbarSession = (yield* r.manager.list({ threadId })).sessions.find(
          (tab) => tab.tabId === toolbar.surfaceTabId,
        )!;
        expect(toolbarSession.reveal).toBe(false);
        const userPopup = yield* r.extensions.openSurface({
          id: r.id,
          kind: "popup",
          hostTabId: host.tabId,
          threadId,
        });
        expect(userPopup.notice).toBeUndefined();
        const events = yield* r.manager.subscribeEvents;
        const agent = yield* r.invoke<PreviewAutomationStatus>("extensionOpen", host.tabId, {
          id: r.id,
          page: "popup",
        });
        const opened = yield* Stream.fromSubscription(events).pipe(
          Stream.filter((event) => event.type === "opened" && event.tabId === agent.surfaceTabId),
          Stream.take(1),
          Stream.runCollect,
        );
        expect(opened[0]?.type === "opened" && opened[0].snapshot.reveal).toBe(true);
        const agentSession = (yield* r.manager.list({ threadId })).sessions.find(
          (tab) => tab.tabId === agent.surfaceTabId,
        )!;
        expect(agent.surfaceTabId).not.toBe(userPopup.surfaceTabId);
        expect(agentSession.automationOwner).toBeDefined();
        expect(agent.notice).toContain("persistent extension surface");
        const reused = yield* r.invoke<PreviewAutomationStatus>("extensionOpen", host.tabId, {
          id: r.id,
          page: "sidePanel",
        });
        expect(reused.surfaceTabId).toBe(toolbar.surfaceTabId);
        const revealed = (yield* r.manager.list({ threadId })).sessions.find(
          (tab) => tab.tabId === toolbar.surfaceTabId,
        )!;
        expect(revealed.reveal).toBe(true);
        expect(revealed.revealRequest?.force).toBe(true);
      }),
    ),
  );

  it.live(
    "keeps an agent popup alive across blur, drives the native module-worker panel, and closes both with the host",
    () =>
      provide(
        Effect.gen(function* () {
          const r = yield* rig;
          const popup = yield* r.openSurface("popup");
          expect(popup.notice).toContain("persistent extension surface");
          expect(popup.hostTabId).toBe(r.host.tabId);
          expect(popup.surfaceTabId).toBeDefined();
          expect(
            yield* r.invoke("evaluate", popup.surfaceTabId, {
              expression:
                "chrome.tabs.query({active:true,lastFocusedWindow:true}).then(([tab])=>tab.index)",
            }),
          ).toBe(0);
          const snap = yield* r.invoke<{ text: string }>("snapshot", popup.surfaceTabId, {
            output: "full",
          });
          expect(JSON.stringify(snap)).toContain("Test content script");
          yield* r.invoke("click", popup.surfaceTabId, { selector: "button", output: "none" });
          yield* r.invoke("waitFor", popup.surfaceTabId, { text: "content script reached" });
          const popupStatus = yield* r.invoke<PreviewAutomationStatus>(
            "status",
            popup.surfaceTabId,
          );
          expect(popupStatus.extensionSurface).toMatchObject({
            kind: "popup",
            extensionId: r.id,
            hostTabId: r.host.tabId,
          });
          yield* r.invoke("evaluate", popup.surfaceTabId, {
            expression: "chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true})",
          });
          const panel = yield* r.openSurface("sidePanel");
          expect(panel.notice).toBeUndefined();
          expect(
            (yield* r.invoke<PreviewAutomationStatus>("status", panel.surfaceTabId))
              .extensionSurface?.preferredSize,
          ).toBeUndefined();
          expect(panel.surfaceTabId).not.toBe(popup.surfaceTabId);
          expect(
            JSON.stringify(yield* r.invoke("snapshot", popup.surfaceTabId, { output: "full" })),
          ).toContain("content script reached");
          expect(
            JSON.stringify(yield* r.invoke("snapshot", panel.surfaceTabId, { output: "full" })),
          ).toContain("Panel");
          yield* r.invoke("click", panel.surfaceTabId, { selector: "button", output: "none" });
          yield* r.invoke("waitFor", panel.surfaceTabId, { text: "content script reached" });
          expect((yield* r.openSurface("sidePanel")).surfaceTabId).toBe(panel.surfaceTabId);
          expect((yield* r.invoke<PreviewAutomationStatus>("status")).tabId).toBe(r.host.tabId);
          yield* r.manager.close({ threadId, tabId: r.host.tabId! });
          yield* r.awaitTab(
            () => !r.liveTabs.has(panel.surfaceTabId!) && !r.liveTabs.has(r.host.tabId!),
          );
          expect((yield* r.manager.list({ threadId })).sessions).toHaveLength(0);
        }),
      ),
  );

  it.live("adopts a user's native popup on the correct host when URLs repeat", () =>
    provide(
      Effect.gen(function* () {
        const r = yield* rig;
        const host = yield* r.manager.open({
          threadId,
          runtime: "server",
          profileId: "default",
          url: r.url,
        });
        yield* r.awaitTab(() => r.liveTabs.size === 2);
        const popup = yield* r.extensions.openSurface({
          id: r.id,
          kind: "popup",
          hostTabId: host.tabId,
          threadId,
        });
        expect(popup.notice).toBeUndefined();
        yield* r.awaitPreferredSize(popup.surfaceTabId!, 320, 180);
        expect(
          yield* r.invoke("evaluate", popup.surfaceTabId, {
            expression:
              "chrome.tabs.query({active:true,lastFocusedWindow:true}).then(([tab])=>tab.index)",
          }),
        ).toBe(1);
        expect(
          JSON.stringify(yield* r.invoke("snapshot", popup.surfaceTabId, { output: "full" })),
        ).toContain("Test content script");
        yield* r.invoke("click", popup.surfaceTabId, { selector: "button", output: "none" });
        yield* r.invoke("waitFor", popup.surfaceTabId, { text: "content script reached" });
        yield* r.manager.close({ threadId, tabId: host.tabId });
        yield* r.awaitTab(() => !r.liveTabs.has(popup.surfaceTabId!));
      }),
    ),
  );

  it.live("measures popup content changes, clamps them, and ignores stream resize", () =>
    provide(
      Effect.gen(function* () {
        const r = yield* rig;
        const popup = yield* r.openSurface("popup");
        yield* r.awaitPreferredSize(popup.surfaceTabId!, 320, 180);
        const viewer = yield* r.browser.attachViewer({
          threadId,
          tabId: popup.surfaceTabId!,
          maxWidth: 800,
          maxHeight: 600,
          quality: 70,
          canOperate: true,
        });
        yield* viewer.input({ type: "takeControl" });
        yield* viewer.input({ type: "resize", width: 740, height: 540 });
        const streamed = yield* r.invoke<PreviewAutomationStatus>("status", popup.surfaceTabId);
        expect(streamed.viewport).toEqual({ width: 320, height: 180 });
        expect(streamed.extensionSurface?.preferredSize).toEqual({ width: 320, height: 180 });
        const viewport = yield* r.invoke<{ viewport: { width: number; height: number } }>(
          "resize",
          popup.surfaceTabId,
          { mode: "freeform", width: 740, height: 540 },
        );
        expect(viewport.viewport).toEqual({ width: 320, height: 180 });
        yield* r.invoke("evaluate", popup.surfaceTabId, {
          expression:
            "document.body.style.width='420px'; document.body.style.height='260px'; undefined",
        });
        yield* r.awaitPreferredSize(popup.surfaceTabId!, 420, 260);
        yield* r.invoke("evaluate", popup.surfaceTabId, {
          expression:
            "document.body.style.width='1200px'; document.body.style.height='900px'; undefined",
        });
        yield* r.awaitPreferredSize(popup.surfaceTabId!, 800, 600);
        yield* r.invoke("evaluate", popup.surfaceTabId, {
          expression:
            "document.body.style.width='320px'; document.body.style.height='180px'; undefined",
        });
        yield* r.awaitPreferredSize(popup.surfaceTabId!, 320, 180);
        const status = yield* r.invoke<PreviewAutomationStatus>("status", popup.surfaceTabId);
        expect(status.viewport).toEqual({ width: 320, height: 180 });
        const saved = (yield* r.manager.list({ threadId })).sessions.find(
          (tab) => tab.tabId === popup.surfaceTabId,
        )!;
        expect(saved.serverRendering).toBe("stream");
      }),
    ),
  );

  it.live(
    "adopts extension-created pages into the opener thread and excludes surfaces from agent capacity",
    () =>
      provide(
        Effect.gen(function* () {
          const r = yield* rig;
          const popup = yield* r.openSurface("sidePanel");
          // A newer page in a different thread shares this profile. Explicit opener
          // ancestry wins; an extension-created tab without one uses recent use.
          yield* r.manager.open({
            threadId: otherThreadId,
            runtime: "server",
            profileId: "default",
            url: r.url,
          });
          yield* r.awaitTab(() => r.liveTabs.size >= 3);
          yield* r.invoke("evaluate", popup.surfaceTabId, {
            expression: "chrome.tabs.create({url:chrome.runtime.getURL('popup.html')})",
          });
          yield* r.awaitTab(() => r.liveTabs.size >= 4);
          yield* r.invoke("evaluate", popup.surfaceTabId, {
            expression: "chrome.runtime.openOptionsPage()",
          });
          yield* r.awaitTab(() => r.liveTabs.size >= 5);
          yield* r.invoke("evaluate", popup.surfaceTabId, {
            expression: `chrome.tabs.create({url:${JSON.stringify(r.url + "from-extension")}})`,
          });
          yield* r.awaitTab(() => r.liveTabs.size >= 6);
          yield* r.awaitPage(r.url + "from-extension");
          yield* r.awaitPage(`chrome-extension://${r.id}/options.html`);
          const status = yield* r.invoke<PreviewAutomationStatus>("status", r.host.tabId!);
          expect(status.tabs?.filter((tab) => tab.url?.endsWith("/from-extension"))).toHaveLength(
            1,
          );
          expect(status.tabs?.filter((tab) => tab.url?.endsWith("/options.html"))).toHaveLength(1);
          // Eight regular tabs fill this agent's capacity; its popup does not consume a slot.
          for (let i = 0; i < 3; i++)
            yield* r.invoke("open", undefined, {
              url: r.url,
              profileId: "default",
              open: false,
              reuseExistingTab: false,
            });
          const final = yield* r.invoke<PreviewAutomationStatus>("open", undefined, {
            url: r.url,
            profileId: "default",
            open: false,
            reuseExistingTab: false,
          });
          expect(final.available).toBe(true);
          yield* r.invoke("evaluate", popup.surfaceTabId, {
            expression:
              "chrome.action.setPopup({popup:''}); chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:false})",
          });
          yield* r.invoke("evaluate", popup.surfaceTabId, {
            expression:
              "globalThis.actionFired = new Promise(resolve => chrome.storage.onChanged.addListener(changes => { if (changes.actionClicked) resolve(changes.actionClicked.newValue); })); undefined",
          });
          const action = yield* r.openSurface("action");
          expect(action.surfaceTabId).toBeUndefined();
          expect(
            yield* r.invoke("evaluate", popup.surfaceTabId, {
              expression: "globalThis.actionFired",
            }),
          ).toBe(true);
        }),
      ),
  );
});
