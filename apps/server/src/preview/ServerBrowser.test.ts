import {
  EnvironmentId,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationStatus,
  type PreviewAutomationSnapshot,
} from "@cogenly/contracts";
import { NodeCrypto } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@cogenly/shared/HostProcess";
import { afterEach, expect, it, vi } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as NodeEvents from "node:events";
import type { BrowserContext, Page } from "playwright-core";
import * as Vault from "../vault/Vault.ts";
import * as Config from "../config.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import type { McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as Channel from "./DesktopBrowserChannel.ts";
import * as Manager from "./Manager.ts";
import * as Browser from "./PreviewBrowser.ts";
import * as BrowserHost from "./PreviewBrowserHost.ts";
import * as ServerBrowser from "./ServerBrowser.ts";
import { ServerBrowserContexts } from "./ServerBrowserContexts.ts";

const environmentId = EnvironmentId.make("environment:test");
const threadId = ThreadId.make("thread:browser");
// Snapshots default to compact elements; these tests read the full page text.
const FULL = { output: "full" } as const;
const scope: McpThreadInvocationScope = {
  environmentId,
  capabilities: new Set(["preview"]),
  issuedAt: 0,
  requestNamespace: "test",
  client: undefined,
  thread: {
    threadId,
    providerSessionId: "session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
};
afterEach(() => vi.restoreAllMocks());

/** Playwright boundary only: the real manager, broker, control, operations, and viewer lifecycle run. */
const rig = (native = false, autoOpen = true) =>
  Effect.gen(function* () {
    const connected = yield* Deferred.make<void>();
    let titleAvailable = true;
    const permission = vi.fn<Channel.DesktopBrowserChannel["Service"]["permission"]>(() =>
      Effect.succeedSome({
        ok: true,
        state: { origin: "https://example.test", entries: [], prompt: null },
      }),
    );
    let attached = native;
    const awaitAttached = vi.fn<Channel.DesktopBrowserChannel["Service"]["awaitAttached"]>(() =>
      Effect.succeed(attached),
    );
    let disconnecting = false;
    const detached = yield* PubSub.unbounded<{ threadId: string; tabId: string }>();
    const detachedProcessed = yield* Deferred.make<void>();
    const cdp = Object.assign(new NodeEvents.EventEmitter(), {
      detach: async () => {},
      send: async (method: string) => {
        if (method === "Runtime.evaluate") return { result: { value: "signed-in-session" } };
        if (method === "Page.captureScreenshot") return { data: "aW1hZ2U=" };
        if (method === "Page.getLayoutMetrics")
          return { cssVisualViewport: { pageX: 0, pageY: 0 } };
        return {};
      },
    });
    const page = Object.assign(new NodeEvents.EventEmitter(), {
      isClosed: () => false,
      url: () => "https://example.test/setup",
      title: async () => {
        if (!titleAvailable) throw new Error("CDP disconnected");
        return "Signed in";
      },
      viewportSize: () => ({ width: 640, height: 400 }),
      setViewportSize: async () => {},
      setDefaultTimeout: () => {},
      setDefaultNavigationTimeout: () => {},
      mainFrame: () => page,
      context: () => context,
      evaluate: async () => ({
        url: page.url(),
        title: "Signed in",
        loading: false,
        visibleText: "Signed in",
        interactiveElements: [],
      }),
      locator: () => ({ evaluateAll: async () => [] }),
      ariaSnapshot: vi.fn(async () => '- document "Signed in"'),
      close: vi.fn(async () => {}),
    });
    const context = {
      newPage: vi.fn(async () => page as unknown as Page),
      newCDPSession: async () => cdp,
      grantPermissions: async () => {},
      close: async () => {},
    };
    vi.spyOn(ServerBrowserContexts.prototype, "contextFor").mockResolvedValue(
      context as unknown as BrowserContext,
    );
    vi.spyOn(ServerBrowserContexts.prototype, "close").mockResolvedValue();
    const closeConnection = vi.fn(async () => {});
    const connectDesktop = vi
      .spyOn(ServerBrowserContexts.prototype, "connectDesktopPage")
      .mockResolvedValue({ page, browser: { close: closeConnection } } as unknown as Awaited<
        ReturnType<ServerBrowserContexts["connectDesktopPage"]>
      >);
    const dependencies = yield* Layer.build(
      Layer.mergeAll(
        Manager.layer,
        Layer.mock(Vault.Vault)({}),
        Broker.layer,
        Config.layerTest(process.cwd(), { prefix: "v033-browser-" }),
        Layer.mock(Environment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(environmentId),
        }),
        Layer.mock(Browser.PreviewBrowser)({
          executable: Effect.die("No real browser in this test"),
          installed: Effect.succeedNone,
        }),
        Layer.mock(Channel.DesktopBrowserChannel)({
          available: true,
          attached: Stream.empty,
          detached: Stream.fromPubSub(detached),
          isAttached: () => Effect.succeed(attached),
          awaitAttached,
          endpoint: () => Effect.succeed("ws://test-only"),
          permission,
        }),
      ).pipe(Layer.provideMerge(NodeServices.layer), Layer.provideMerge(NodeCrypto.layer)),
    );
    const broker = Context.get(dependencies, Broker.PreviewAutomationBroker);
    const reportingBroker = {
      ...broker,
      focusHost: (input: Parameters<typeof broker.focusHost>[0]) =>
        broker.focusHost(input).pipe(
          Effect.andThen(Deferred.succeed(connected, undefined)),
          Effect.andThen(() =>
            disconnecting && input.liveTabs?.length === 0
              ? Deferred.succeed(detachedProcessed, undefined)
              : Effect.void,
          ),
          Effect.asVoid,
        ),
    };
    const browserContext = yield* Layer.build(
      ServerBrowser.layer.pipe(
        Layer.provide(
          Layer.succeedContext(
            Context.add(dependencies, Broker.PreviewAutomationBroker, reportingBroker),
          ),
        ),
        Layer.provide(Layer.succeed(HostProcess.HomeDirectory, "/tmp/v033-browser-test-home")),
      ),
    );
    const browser = Context.get(browserContext, ServerBrowser.ServerBrowser);
    yield* Deferred.await(connected);
    const invoke = <A>(
      operation: Parameters<typeof broker.invoke>[0]["operation"],
      tabId?: string,
      input: unknown = {},
      timeoutMs?: number,
      backgroundRead = false,
    ) =>
      broker.invoke<A>({
        scope,
        operation,
        input:
          operation === "snapshot"
            ? { output: "full", ...(typeof input === "object" && input !== null ? input : {}) }
            : input,
        ...(backgroundRead ? { updateCurrentTab: false } : {}),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(tabId ? { tabId: PreviewTabId.make(tabId) } : {}),
      });
    const open = autoOpen
      ? yield* invoke<PreviewAutomationStatus>("open", undefined, {
          open: native,
          reuseExistingTab: false,
        })
      : undefined;
    if (autoOpen) expect(open?.tabId).not.toBeNull();
    return {
      browser,
      manager: Context.get(dependencies, Manager.PreviewManager),
      awaitAttached,
      permission,
      invoke,
      tabId: open?.tabId ?? "",
      page,
      context,
      closeConnection,
      connectDesktop,
      disconnect: Effect.gen(function* () {
        attached = false;
        disconnecting = true;
        yield* PubSub.publish(detached, { threadId, tabId: open?.tabId ?? "" });
        yield* Deferred.await(detachedProcessed);
      }),
      reconnect: () => {
        attached = true;
      },
      setTitleAvailable: (value: boolean) => {
        titleAvailable = value;
      },
    };
  });

it.effect("keeps snapshot, evaluate, and login across background → panel → background", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const r = yield* rig();
      const check = Effect.gen(function* () {
        const snapshot = yield* r.invoke<PreviewAutomationSnapshot>("snapshot", r.tabId, FULL);
        expect(snapshot.visibleText).toBe("Signed in");
        expect(yield* r.invoke("evaluate", r.tabId, { expression: "sessionStorage.login" })).toBe(
          "signed-in-session",
        );
      });
      yield* check;
      expect((yield* r.invoke<PreviewAutomationStatus>("status", r.tabId)).rendering).toBe(
        "background",
      );
      const viewerScope = yield* Scope.make();
      yield* r.browser
        .attachViewer({
          threadId,
          tabId: r.tabId,
          canOperate: true,
          quality: 80,
          maxWidth: 1280,
          maxHeight: 800,
        })
        .pipe(Scope.provide(viewerScope));
      const shown = yield* r.invoke<PreviewAutomationStatus>("status", r.tabId);
      expect(shown.rendering).toBe("panel");
      expect(shown.tabs?.find((tab) => tab.tabId === r.tabId)?.rendering).toBe("panel");
      yield* check;
      yield* Scope.close(viewerScope, Exit.void);
      expect((yield* r.invoke<PreviewAutomationStatus>("status", r.tabId)).rendering).toBe(
        "background",
      );
      yield* check;
      expect(r.context.newPage).toHaveBeenCalledTimes(1);
      expect(r.page.close).not.toHaveBeenCalled();
    }),
  ),
);

it.effect("reports an unresponsive page honestly and keeps its signed-in page", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const r = yield* rig();
      r.setTitleAvailable(false);
      const status = yield* r.invoke<PreviewAutomationStatus>("status", r.tabId);
      expect(status.available).toBe(false);
      expect(status.automation).toEqual({ connected: false, state: "unresponsive" });
      expect(status.tabId).toBe(r.tabId);
      expect(status.notice).toContain("do not reload or recreate");
      r.setTitleAvailable(true);
      expect((yield* r.invoke<PreviewAutomationStatus>("status", r.tabId)).automation).toEqual({
        connected: true,
        state: "ready",
      });
      expect(r.context.newPage).toHaveBeenCalledTimes(1);
      expect(r.page.close).not.toHaveBeenCalled();
    }),
  ),
);

it.effect("reconnects a native tab without replacing it and reports a detached debugger", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const r = yield* rig(true);
      yield* r.disconnect;
      const status = yield* r.invoke<PreviewAutomationStatus>("status", r.tabId);
      expect(status.available).toBe(false);
      expect(status.automation).toEqual({ connected: false, state: "disconnected" });
      expect(status.tabId).toBe(r.tabId);
      r.reconnect();
      const reconnected = yield* r.invoke<PreviewAutomationStatus>("status", r.tabId);
      expect(reconnected.automation).toEqual({ connected: true, state: "ready" });
      expect(
        (yield* r.invoke<PreviewAutomationSnapshot>("snapshot", r.tabId, FULL)).visibleText,
      ).toBe("Signed in");
      expect(yield* r.invoke("evaluate", r.tabId, { expression: "sessionStorage.login" })).toBe(
        "signed-in-session",
      );
      expect(r.connectDesktop).toHaveBeenCalledTimes(2);
      expect(r.context.newPage).not.toHaveBeenCalled();
      expect(r.page.close).not.toHaveBeenCalled();
    }),
  ),
);

it.effect(
  "returns tab diagnostics on a stalled snapshot and reattaches automation to the same native page",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const r = yield* rig(true);
        const started = Promise.withResolvers<void>();
        r.page.ariaSnapshot.mockImplementationOnce(() => {
          started.resolve();
          return new Promise<string>(() => {});
        });
        const pending = yield* r
          .invoke("snapshot", r.tabId, {}, 10)
          .pipe(Effect.result, Effect.forkScoped);
        yield* Effect.promise(() => started.promise);
        yield* TestClock.adjust(260);
        const result = yield* Fiber.join(pending);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(result.failure.message).toContain("rendering=panel");
        expect((yield* r.invoke<PreviewAutomationStatus>("status", r.tabId)).available).toBe(true);
        expect(
          (yield* r.invoke<PreviewAutomationSnapshot>("snapshot", r.tabId, FULL)).visibleText,
        ).toBe("Signed in");
        expect(r.connectDesktop).toHaveBeenCalledTimes(2);
        expect(r.page.close).not.toHaveBeenCalled();
      }),
    ),
);

it.effect("does not disconnect a responsive native page for an ordinary operation timeout", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const r = yield* rig(true);
      r.page.ariaSnapshot.mockRejectedValueOnce(
        Object.assign(new Error("Timeout 10ms exceeded"), { name: "TimeoutError" }),
      );
      const result = yield* r.invoke("snapshot", r.tabId).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure.message).toContain("automationConnected=true");
      expect((yield* r.invoke<PreviewAutomationStatus>("status", r.tabId)).available).toBe(true);
      expect(r.connectDesktop).toHaveBeenCalledTimes(1);
      expect(r.closeConnection).not.toHaveBeenCalled();
    }),
  ),
);

it.effect("a short metadata read cannot disconnect a native tab", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const r = yield* rig(true);
      const started = Promise.withResolvers<void>();
      const answer = Promise.withResolvers<Option.Option<never>>();
      r.permission.mockImplementationOnce(() =>
        Effect.promise(() => {
          started.resolve();
          return answer.promise;
        }),
      );
      const pending = yield* r
        .invoke("status", r.tabId, {}, 500, true)
        .pipe(Effect.result, Effect.forkScoped);
      yield* Effect.promise(() => started.promise);
      yield* TestClock.adjust(750);
      expect((yield* Fiber.join(pending))._tag).toBe("Failure");
      answer.resolve(Option.none());
      expect((yield* r.invoke<PreviewAutomationStatus>("status", r.tabId)).available).toBe(true);
      expect(r.connectDesktop).toHaveBeenCalledTimes(1);
      expect(r.closeConnection).not.toHaveBeenCalled();
    }),
  ),
);

it.effect(
  "visible desktop open waits for the panel instead of returning a temporary sign-in page",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const r = yield* rig(false, false);
        const started = Promise.withResolvers<void>();
        const attachment = Promise.withResolvers<boolean>();
        r.awaitAttached.mockImplementationOnce(() =>
          Effect.promise(() => {
            started.resolve();
            return attachment.promise;
          }),
        );
        const pending = yield* r
          .invoke<PreviewAutomationStatus>("open", undefined, { reuseExistingTab: false })
          .pipe(Effect.forkScoped);
        yield* Effect.promise(() => started.promise);
        expect(r.context.newPage).not.toHaveBeenCalled();
        expect(r.connectDesktop).not.toHaveBeenCalled();
        r.reconnect();
        attachment.resolve(true);
        const opened = yield* Fiber.join(pending);
        expect(opened.available).toBe(true);
        expect(opened.rendering).toBe("panel");
        expect(opened.sessionMismatch).not.toBe(true);
        expect(r.connectDesktop).toHaveBeenCalledTimes(1);
        expect(r.context.newPage).not.toHaveBeenCalled();
      }),
    ),
);

it.effect("a panel attach failure preserves its tab and can be retried automatically", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const r = yield* rig(false, false);
      const failed = yield* r
        .invoke("open", undefined, { reuseExistingTab: false })
        .pipe(Effect.result);
      expect(failed._tag).toBe("Failure");
      if (failed._tag === "Failure")
        expect(failed.failure.message).toContain("Retry preview_open with tabId=");
      const { sessions } = yield* r.manager.list({ threadId });
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.serverRendering).toBe("native");
      expect(r.context.newPage).not.toHaveBeenCalled();
      r.reconnect();
      const opened = yield* r.invoke<PreviewAutomationStatus>("open", sessions[0]!.tabId, {});
      expect(opened.tabId).toBe(sessions[0]!.tabId);
      expect(opened.available).toBe(true);
      expect(opened.rendering).toBe("panel");
      expect(r.page.close).not.toHaveBeenCalled();
    }),
  ),
);

it.effect("caller interruption leaves panel automation and its signed-in page alive", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const r = yield* rig(true);
      const started = Promise.withResolvers<void>();
      const snapshot = Promise.withResolvers<string>();
      r.page.ariaSnapshot.mockImplementationOnce(() => {
        started.resolve();
        return snapshot.promise;
      });
      const pending = yield* r.invoke("snapshot", r.tabId).pipe(Effect.forkScoped);
      yield* Effect.promise(() => started.promise);
      yield* Fiber.interrupt(pending);
      snapshot.resolve('- document "Signed in"');
      expect(
        (yield* r.invoke<PreviewAutomationSnapshot>("snapshot", r.tabId, FULL)).visibleText,
      ).toBe("Signed in");
      expect(yield* r.invoke("evaluate", r.tabId, { expression: "sessionStorage.login" })).toBe(
        "signed-in-session",
      );
      expect((yield* r.invoke<PreviewAutomationStatus>("status", r.tabId)).automation).toEqual({
        connected: true,
        state: "ready",
      });
      expect(r.connectDesktop).toHaveBeenCalledTimes(1);
      expect(r.closeConnection).not.toHaveBeenCalled();
      expect(r.page.close).not.toHaveBeenCalled();
    }),
  ),
);

it.effect(
  "revealing an explicit background tab waits for its existing page to stream into the panel",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const r = yield* rig();
        const events = yield* r.manager.subscribeEvents;
        const pending = yield* r
          .invoke<PreviewAutomationStatus>("open", r.tabId, { open: true })
          .pipe(Effect.forkScoped);
        yield* Stream.fromSubscription(events).pipe(
          Stream.filter(
            (event) =>
              event.type === "navigated" &&
              event.tabId === r.tabId &&
              event.snapshot.reveal === true,
          ),
          Stream.runHead,
        );
        expect(pending.pollUnsafe()).toBeUndefined();
        const viewerScope = yield* Scope.make();
        yield* r.browser
          .attachViewer({
            threadId,
            tabId: r.tabId,
            canOperate: true,
            quality: 80,
            maxWidth: 1280,
            maxHeight: 800,
          })
          .pipe(Scope.provide(viewerScope));
        const shown = yield* Fiber.join(pending);
        expect(shown.tabId).toBe(r.tabId);
        expect(shown.rendering).toBe("panel");
        expect(shown.sessionMismatch).not.toBe(true);
        expect(r.context.newPage).toHaveBeenCalledTimes(1);
        expect(r.connectDesktop).not.toHaveBeenCalled();
        expect(r.page.close).not.toHaveBeenCalled();
        yield* Scope.close(viewerScope, Exit.void);
      }),
    ),
);

it.effect("keeps an unseen agent tab and its login alive across days of inactivity", () =>
  Effect.gen(function* () {
    const r = yield* rig();
    vi.spyOn(Date, "now").mockReturnValue(Number.MAX_SAFE_INTEGER);
    yield* TestClock.adjust("7 days");
    expect((yield* r.manager.list({ threadId })).sessions.map((tab) => tab.tabId)).toContain(
      r.tabId,
    );
    expect(yield* r.invoke("evaluate", r.tabId, { expression: "sessionStorage.login" })).toBe(
      "signed-in-session",
    );
    expect(r.context.newPage).toHaveBeenCalledTimes(1);
    expect(r.page.close).not.toHaveBeenCalled();
  }).pipe(Effect.scoped),
);

it.effect.each([
  new Browser.PreviewBrowserInstallingError({
    downloadedBytes: 10,
    totalBytes: 100,
    unpacking: false,
  }),
  new Browser.PreviewBrowserInstallError({ detail: "Check this machine's network access." }),
  new Browser.PreviewBrowserUnsupportedError({ platform: "test", arch: "test" }),
  new BrowserHost.PreviewBrowserSandboxError({ setupCommand: "sudo cogenly browser setup" }),
  new BrowserHost.PreviewBrowserLibrariesError({
    setupCommand: "sudo cogenly browser setup",
    libraries: ["libnss3.so"],
  }),
])("opening preserves actionable browser setup errors: %s", (error) =>
  Effect.scoped(
    Effect.gen(function* () {
      const r = yield* rig(false, false);
      vi.mocked(ServerBrowserContexts.prototype.contextFor).mockRejectedValue(error);
      const snapshot = yield* r.manager.open({
        threadId,
        runtime: "server",
        serverRendering: "stream",
        reveal: false,
      });
      const result = yield* r.invoke("open", snapshot.tabId, { open: false }).pipe(Effect.result);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { message: expect.stringContaining(error.message) },
      });
      vi.mocked(ServerBrowserContexts.prototype.contextFor).mockResolvedValue(
        r.context as unknown as BrowserContext,
      );
      expect(
        (yield* r.invoke<PreviewAutomationStatus>("open", snapshot.tabId, { open: false }))
          .available,
      ).toBe(true);
    }),
  ),
);
