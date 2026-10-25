// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - Playwright callbacks run outside the Effect runtime.
// Screencasts ignore emulated device scale; real 2x keeps captures sharp.
// --disable-gpu uses cheaper software compositing while preserving SwiftShader WebGL.
import {
  BUILT_IN_BROWSER_PROFILES,
  DEFAULT_BROWSER_PROFILE_ID,
  FILL_PREVIEW_VIEWPORT,
  findBrowserProfile,
  INCOGNITO_BROWSER_PROFILE_ID,
  resolveBrowserProfiles,
  type BrowserProfile,
  type PreviewReportProfilesInput,
  type PreviewReportShownInput,
  type PreviewAutomationTabSummary,
  PREVIEW_AUTOMATION_SERVER_OPERATIONS,
  PreviewViewportSetting as PreviewViewportSettingSchema,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  type PreviewAutomationActionEvent,
  type PreviewAutomationClickInput,
  type PreviewAutomationDialogInput,
  type PreviewAutomationConsoleEntry,
  type PreviewAutomationDragInput,
  type PreviewAutomationEvaluateInput,
  type PreviewAutomationHoverInput,
  type PreviewAutomationNavigateInput,
  type PreviewAutomationNetworkEntry,
  type PreviewAutomationOpenInput,
  type PreviewAutomationPermissionInput,
  type PreviewAutomationPressInput,
  type PreviewAutomationRequest,
  type PreviewAutomationResizeInput,
  type PreviewAutomationScrollInput,
  type PreviewAutomationSelectInput,
  type PreviewAutomationSetColorSchemeInput,
  type PreviewAutomationStatus,
  type PreviewAutomationTypeInput,
  type PreviewAutomationUploadInput,
  type PreviewAutomationWaitForInput,
  PreviewClearProfileError,
  type PreviewAnnotationPayload,
  type PreviewEvent,
  type PreviewNavStatus,
  type PreviewSessionSnapshot,
  type PreviewViewportSetting,
  ThreadId,
  SERVER_BROWSER_AUTOMATION_CLIENT_ID,
  type PreviewAppearancePreference,
  type SitePermissionsState,
} from "@cogenly/contracts";
import * as HostProcess from "@cogenly/shared/HostProcess";
import { normalizePreviewUrl } from "@cogenly/shared/preview";
import { resolvePreviewViewport } from "@cogenly/shared/previewViewport";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { constVoid } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type {
  BrowserContext,
  CDPSession,
  Dialog,
  Download,
  FileChooser,
  Frame,
  Page,
} from "playwright-core";

import { PENDING_ATTACHMENT_THREAD_SEGMENT } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { resolveRootCliCommand } from "../cli/invocation.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import * as DesktopBrowserChannel from "./DesktopBrowserChannel.ts";
import * as PreviewManager from "./Manager.ts";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";
import * as ServerBrowserPick from "./ServerBrowserPick.ts";
import * as PreviewBrowser from "./PreviewBrowser.ts";
import * as PreviewBrowserHost from "./PreviewBrowserHost.ts";
import { presentAsChrome, ServerBrowserContexts } from "./ServerBrowserContexts.ts";
import {
  HeadlessSitePermissions,
  permissionPromptNotice,
  permissionRefusalMessage,
  siteOrigin,
} from "./SitePermissionAgent.ts";
import { BrowserControlInterrupted, SessionControl } from "./SessionControl.ts";
import * as Targeting from "./serverBrowserTargeting.ts";

const SERVER_HOST_CLIENT_ID = SERVER_BROWSER_AUTOMATION_CLIENT_ID;
const RENDER_SCALE = 2;
// Chromium allows three unacked frames, so 100 ms pacing caps viewers near 30 fps.
const SCREENCAST_ACK_PACE_MS = 100;
const SCREENCAST_SETTLE_MS = 200;
// Only scrolling triggers reduced-quality motion frames; animations stay sharp.
const SCREENCAST_MOTION_FRAMES = 4;
const SCREENCAST_MOTION_WINDOW_MS = 300;
const SCREENCAST_MOTION_QUALITY = 50;
const HOST_RECONNECT_DELAY = "1 second";
/** How long a new tab waits for the desktop app to mount it before running headless. */
const DESKTOP_ATTACH_TIMEOUT = "10 seconds";
const VIEWER_OUTPUT_LIMIT = 64;
const RECORDING_SCREENCAST = { format: "jpeg", quality: 90, everyNthFrame: 1 } as const;
const decodeViewportSetting = Schema.decodeUnknownSync(PreviewViewportSettingSchema);
/** The agent cursor glides to its target, then pulses just before the press, like desktop tabs. */
const AGENT_CURSOR_MOVE_MS = 160;
const AGENT_CURSOR_CLICK_LEAD_MS = 40;

const sleepUntil = (deadline: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now())));

// Touch viewers raise the keyboard for editable targets, including opaque frames.
const EDITABLE_AT_POINT_SCRIPT = `(x, y) => {
  let element = document.elementFromPoint(x, y);
  while (element && element.shadowRoot) {
    const inner = element.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === element) break;
    element = inner;
  }
  if (element && element.tagName === "LABEL" && element.control) element = element.control;
  if (!element) return false;
  if (element.tagName === "IFRAME" || element.tagName === "FRAME") return true;
  if (element.isContentEditable) return true;
  if (element.tagName === "TEXTAREA") return !element.disabled && !element.readOnly;
  if (element.tagName !== "INPUT") return false;
  const nonText = ["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"];
  return !nonText.includes(element.type) && !element.disabled && !element.readOnly;
}`;
const UNATTACHED_FILL_VIEWPORT = { width: 1280, height: 800 } as const;
const NAVIGATION_TIMEOUT_MS = 15_000;
const VIEWER_NAVIGATION_OPTIONS = { waitUntil: "commit", timeout: NAVIGATION_TIMEOUT_MS } as const;
/** Toolbar commands a viewer may send without holding control; they take it first. */
const VIEWER_PAGE_COMMANDS: ReadonlySet<string> = new Set(["navigate", "history", "reload"]);
const ACTION_TIMELINE_LIMIT = 50;

export class ServerBrowserTabNotFoundError extends Schema.TaggedError<ServerBrowserTabNotFoundError>()(
  "ServerBrowserTabNotFoundError",
  { threadId: Schema.String, tabId: Schema.String },
) {
  override get message(): string {
    return "The server preview tab does not exist.";
  }
}

const isTabNotFound = Schema.is(ServerBrowserTabNotFoundError);
const isHostSetupError = Schema.is(
  Schema.Union([
    PreviewBrowserHost.PreviewBrowserSandboxError,
    PreviewBrowserHost.PreviewBrowserLibrariesError,
  ]),
);

export class ServerBrowserLaunchError extends Schema.TaggedError<ServerBrowserLaunchError>()(
  "ServerBrowserLaunchError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The server preview browser could not start.";
  }
}

export type ServerBrowserViewerOutput =
  | {
      readonly _tag: "frame";
      readonly data: Uint8Array;
      readonly ack: Effect.Effect<void>;
    }
  | { readonly _tag: "viewport"; readonly width: number; readonly height: number }
  | {
      readonly _tag: "control";
      readonly canOperate: boolean;
      readonly controller: "agent" | "you" | "another-viewer" | "unclaimed";
      /** An agent opened or has used the tab, so the viewer in control can hand it back. */
      readonly agentInvolved: boolean;
      readonly generation: number;
      readonly capabilities: { readonly pick: boolean };
      readonly dialog: {
        readonly type: string;
        readonly message: string;
        readonly defaultValue: string;
      } | null;
    }
  | {
      readonly _tag: "pickHover";
      readonly box: {
        readonly x: number;
        readonly y: number;
        readonly width: number;
        readonly height: number;
      } | null;
      readonly label: string | null;
    }
  | { readonly _tag: "pickResult"; readonly annotation: PreviewAnnotationPayload }
  | { readonly _tag: "pickError"; readonly message: string }
  | {
      readonly _tag: "probe";
      readonly x: number;
      readonly y: number;
      readonly editable: boolean;
    }
  | { readonly _tag: "clipboard"; readonly text: string }
  | {
      readonly _tag: "pointer";
      readonly phase: "move" | "click";
      readonly x: number;
      readonly y: number;
      readonly sequence: number;
      /** The element acted on, so the viewer can outline it; null for point actions. */
      readonly box: ServerBrowserPage.PointerTargetBox | null;
    }
  | {
      readonly _tag: "fileChooser";
      readonly id: string;
      readonly multiple: boolean;
      readonly accept: string;
    }
  | { readonly _tag: "fileChooserClosed"; readonly id: string }
  /** The page this viewer controls opened a new tab; the viewer shows it, as a browser would. */
  | { readonly _tag: "popup"; readonly tabId: string }
  | {
      readonly _tag: "download";
      readonly id: string;
      readonly fileName: string;
      readonly sizeBytes: number;
    }
  | { readonly _tag: "gone" }
  /** The page is still open, but this connection to it ended; the viewer reconnects. */
  | { readonly _tag: "reconnect" };

export interface ServerBrowserViewer {
  readonly output: Queue.Dequeue<ServerBrowserViewerOutput>;
  readonly input: (message: unknown) => Effect.Effect<void>;
}

export class ServerBrowser extends Context.Service<
  ServerBrowser,
  {
    readonly attachViewer: (input: {
      readonly threadId: string;
      readonly tabId: string;
      readonly maxWidth: number;
      readonly maxHeight: number;
      readonly quality: number;
      readonly canOperate: boolean;
    }) => Effect.Effect<
      ServerBrowserViewer,
      ServerBrowserTabNotFoundError | ServerBrowserLaunchError,
      Scope.Scope
    >;
    /**
     * Gives a page's open file picker the files a viewer uploaded, by path, and
     * closes it. No files cancels the pick. False when that picker is gone.
     */
    readonly answerFileChooser: (input: {
      readonly threadId: string;
      readonly tabId: string;
      readonly chooserId: string;
      readonly files: ReadonlyArray<{
        readonly name: string;
        readonly mimeType: string;
        readonly buffer: Buffer;
      }>;
    }) => Effect.Effect<boolean>;
    /** A finished download of a live tab, for the authenticated download route. */
    readonly openDownload: (input: {
      readonly threadId: string;
      readonly tabId: string;
      readonly downloadId: string;
    }) => Effect.Effect<Option.Option<{ readonly path: string; readonly fileName: string }>>;
    /** Deletes a human profile's server-side storage, closing its open tabs first. */
    readonly clearProfile: (profileId: string) => Effect.Effect<void, PreviewClearProfileError>;
    /**
     * Records a client's browser profiles for agents' preview_open. In memory:
     * clients report again on connect and whenever the list changes.
     */
    readonly reportProfiles: (input: PreviewReportProfilesInput) => Effect.Effect<void>;
    /** Records which tabs the desktop app's panel shows; see `PreviewReportShownInput`. */
    readonly reportShown: (input: PreviewReportShownInput) => Effect.Effect<void>;
  }
>()("cogenly-server/preview/ServerBrowser") {}

interface ViewerState {
  readonly id: string;
  readonly canOperate: boolean;
  readonly pressedKeys: Map<string, { key: string; code: string }>;
  readonly pressedButtons: Map<"left" | "middle" | "right", { x: number; y: number }>;
  readonly pickHitTest: ServerBrowserPick.PickHitTestQueue;
  readonly push: (output: ServerBrowserViewerOutput) => void;
  /** Lets go of every key and button this viewer holds down. */
  readonly releaseInput: () => Promise<void>;
  readonly pause: () => Promise<void>;
  readonly resume: () => Promise<void>;
  scrolledAt: number;
  /** Panel bounds, retained in fixed mode; passive viewers never request a size. */
  requestedSize: { width: number; height: number; order: number } | null;
}

interface EncoderWindow {
  __t3Recorder: {
    cursor(x: number, y: number, click: boolean): void;
    frame(data: string, width: number): Promise<boolean>;
    stop(): Promise<{ mimeType: string | null; count: number; bytes: number }>;
    chunk(index: number): Promise<string>;
  };
}

interface Recording {
  readonly encoder: Page;
  readonly session: CDPSession;
  readonly startedAt: string;
  /** Frames still being handed to the encoder; stopping waits for them. */
  readonly framesInFlight: Set<Promise<void>>;
}

interface ServerTab {
  readonly threadId: ThreadId;
  readonly tabId: string;
  readonly page: Page;
  readonly cdp: CDPSession;
  /** Sessions of the page's frames that run in their own process. */
  readonly frameSessions: Map<Frame, CDPSession>;
  readonly createdAt: number;
  /** The agent's latest request on this tab; idle agent tabs close. */
  usedAt: number;
  readonly viewers: Set<ViewerState>;
  readonly consoleEntries: Array<PreviewAutomationConsoleEntry>;
  readonly networkEntries: Array<PreviewAutomationNetworkEntry>;
  readonly actionTimeline: Array<PreviewAutomationActionEvent>;
  readonly control: SessionControl;
  /** The tab's own storage context, closed with it. Popups share their opener's. */
  readonly isolatedContext: boolean;
  /**
   * Set when the desktop app renders this tab. The server drives the desktop's
   * page; the desktop owns its size, storage, and window.
   */
  readonly desktop: { readonly close: () => Promise<void> } | null;
  readonly profileId: string | undefined;
  /** Set when a page in another tab opened this one with `window.open` or a link. */
  readonly openerTabId: string | undefined;
  /** Finished downloads, newest last; files live until the tab closes. */
  readonly downloads: Array<ServerDownload>;
  /**
   * A page's open file picker, waiting for the controlling viewer's files. Its
   * id is reissued for each viewer it is offered to, so only that viewer can answer.
   */
  fileChooser: {
    readonly id: string;
    readonly chooser: FileChooser;
    readonly accept: string;
    readonly offeredTo: string | null;
  } | null;
  dialog: Dialog | null;
  setting: PreviewViewportSetting;
  colorScheme: PreviewAppearancePreference;
  zoomFactor: number;
  loading: boolean;
  closing: boolean;
  recording: Recording | null;
  initialNavigation: Promise<void> | null;
  /** Counts main-frame navigation requests, so late events can tell they were superseded. */
  navigationGeneration: number;
  /**
   * The latest main-frame navigation, when it aborted, to tell a navigation's
   * download from a page's. The timer settles it if no download follows.
   */
  abortedNavigation: {
    readonly url: string;
    readonly generation: number;
    readonly timer: ReturnType<typeof setTimeout>;
  } | null;
  /** The latest queued start, so a stop can find a recording still starting. */
  recordingStart: Promise<Recording> | null;
  /** Serializes captures and recording start/stop. */
  captureLock: Promise<void>;
  /** Scaled captures rendering now; screencasts stay stopped meanwhile. */
  capturing: number;
}

interface ServerDownload {
  readonly id: string;
  readonly fileName: string;
  readonly path: string;
  readonly sizeBytes: number;
  readonly url: string;
  readonly completedAt: string;
}

/** One agent session and the whole server; each tab holds a renderer process. */
/**
 * Operations an agent may run on any tab in its thread, even while a human
 * drives it. Evaluate is not one: page script can change anything, so it needs
 * the same control as clicking. Site permissions are: they never touch the
 * page's input, so deciding one must not interrupt a person typing in it.
 */
const READ_OPERATIONS: ReadonlySet<PreviewAutomationRequest["operation"]> = new Set([
  "status",
  "snapshot",
  "waitFor",
  "permission",
]);

/** How long the desktop gets to answer a site-permission read before the agent goes on without it. */
const DESKTOP_PERMISSION_READ_TIMEOUT_MS = 1_000;
/** A desktop that stayed silent (an older app) is not asked again for a while. */
const DESKTOP_PERMISSION_BACKOFF_MS = 60_000;
const DESKTOP_PERMISSION_CHANGE_TIMEOUT_MS = 5_000;

const AGENT_TAB_LIMIT = 8;
const SERVER_TAB_LIMIT = 32;
/** Agent tabs nobody watches close after this long without an agent request. */
const AGENT_TAB_IDLE_MS = 30 * 60 * 1000;
/** How often one tab may ask the panel to show it. */
const PANEL_REVEAL_INTERVAL_MS = 5_000;
const IDLE_SWEEP_INTERVAL = "1 minute";

const DOWNLOAD_LIMIT = 20;
/** How long an aborted navigation waits for the download that usually explains it. */
const ABORTED_NAVIGATION_DOWNLOAD_WAIT_MS = 5_000;
const DOWNLOAD_MAX_BYTES = 1024 * 1024 * 1024;

const tabKey = (threadId: string, tabId: string) => `${threadId}\u0000${tabId}`;

const pushBounded = <A>(
  buffer: Array<A>,
  entry: A,
  limit = ServerBrowserPage.DIAGNOSTIC_BUFFER_LIMIT,
) => {
  buffer.push(entry);
  if (buffer.length > limit) buffer.splice(0, buffer.length - limit);
};

const viewportSettingsEqual = (left: PreviewViewportSetting, right: PreviewViewportSetting) =>
  left._tag === right._tag &&
  (left._tag === "fill" ||
    (right._tag !== "fill" && left.width === right.width && left.height === right.height));

const fixedViewportSize = (setting: PreviewViewportSetting) =>
  setting._tag === "fill" ? null : { width: setting.width, height: setting.height };

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

const num = (value: unknown, fallback = 0) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const modifiersOf = (message: Record<string, unknown>) => {
  const value = num(message.modifiers);
  return Number.isInteger(value) && value >= 0 && value < 16 ? value : 0;
};

// Cmd shortcuts from Apple viewers are no editing shortcut for Linux or headless
// Chromium, so they carry the command. Ctrl already works natively on Linux,
// except copy and cut, which headless Chromium only runs as commands.
const editingCommand = (key: string, modifiers: number) => {
  const modifier = modifiers & 0b0111;
  if (modifier !== 2 && modifier !== 4) return null;
  const lower = key.toLowerCase();
  const command =
    lower === "c"
      ? "copy"
      : lower === "x"
        ? "cut"
        : modifier !== 4
          ? null
          : lower === "a"
            ? "selectAll"
            : lower === "z"
              ? modifiers & 8
                ? "redo"
                : "undo"
              : null;
  return command ? { commands: [command] } : null;
};

const CLIPBOARD_TEXT_LIMIT = 1024 * 1024;
const CLIPBOARD_WORLD = "t3-preview-clipboard";
// Headless Chromium shares one clipboard between every context, so the copy
// a viewer's copy or cut key makes is read from this world instead of the
// clipboard. Page scripts cannot see the world, and only a copy made while a
// real key is handled counts.
const CLIPBOARD_SCRIPT = `(() => {
  let keying = false;
  let copied = "";
  // The same Ctrl or Cmd + C or X that editingCommand sends as copy or cut.
  addEventListener("keydown", (event) => {
    if (!event.isTrusted || event.altKey || event.ctrlKey === event.metaKey) return;
    const key = event.key.toLowerCase();
    if (key !== "c" && key !== "x") return;
    keying = true;
    copied = "";
    setTimeout(() => { keying = false; });
  }, true);
  const selection = () => {
    let field = document.activeElement;
    while (field?.shadowRoot?.activeElement) field = field.shadowRoot.activeElement;
    if ((field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) && field.selectionStart !== null)
      return field.value.slice(field.selectionStart, field.selectionEnd ?? field.selectionStart);
    return String(document.getSelection() ?? "");
  };
  const record = (text) => {
    copied = String(text ?? "").slice(0, ${CLIPBOARD_TEXT_LIMIT});
  };
  // Capturing at window runs before page handlers can stop the event, and
  // before cut removes the selection.
  const snapshot = (event) => {
    if (keying && event.isTrusted) record(selection());
  };
  // Bubbling back to window picks up text a page handler set instead.
  const replace = (event) => {
    if (keying && event.isTrusted && event.defaultPrevented) record(event.clipboardData?.getData("text/plain"));
  };
  for (const type of ["copy", "cut"]) {
    addEventListener(type, snapshot, true);
    addEventListener(type, replace);
  }
  globalThis.takeCopy = () => {
    const text = copied;
    copied = "";
    return text;
  };
})();`;

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const host = { platform: yield* HostProcess.Platform, arch: yield* HostProcess.Architecture };
  const manager = yield* PreviewManager.PreviewManager;
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const previewBrowser = yield* PreviewBrowser.PreviewBrowser;
  const desktopChannel = yield* DesktopBrowserChannel.DesktopBrowserChannel;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const launchServices = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>();
  // The fix every host error names, rendered for how this server was launched.
  const setupCommand = yield* resolveRootCliCommand(PreviewBrowserHost.SETUP_SUBCOMMAND);

  const tabs = new Map<string, ServerTab>();
  const pendingTabs = new Map<string, Promise<ServerTab>>();
  /** Sessions closed while their tab was still opening; the open discards its page. */
  const closedPendingTabs = new Set<string>();
  /** Popup pages waiting for the tab their `opened` event creates. */
  const adoptedPages = new Map<string, { readonly page: Page; readonly openerTabId: string }>();
  /** Sessions the manager closed, so their tabs end for good. Pruned once dropped. */
  const closedSessions = new Set<string>();
  let hostConnectionId: string | null = null;
  let viewerResizeOrder = 0;
  /** Native tabs the desktop panel last reported on screen; null until it reports. */
  let shownReport: ReadonlySet<string> | null = null;
  /** When each tab last asked the panel to show it, so busy agents do not flood viewers. */
  const revealRequestedAt = new Map<string, number>();

  const targetable = (tab: ServerTab): Targeting.TargetableTab => ({
    tabId: tab.tabId,
    threadId: tab.threadId,
    agentId: tab.control.agentId,
    createdAt: tab.createdAt,
    usedAt: tab.usedAt,
    viewerCount: tab.viewers.size,
    rendersOnDesktop: tab.desktop !== null,
  });
  /** Advisory: the user can see the tab. Nothing refuses to act because it is false. */
  const isShown = (tab: ServerTab) =>
    Targeting.isTabShown(targetable(tab), { reported: shownReport });

  const contexts = new ServerBrowserContexts({
    profilesDir: NodePath.join(config.stateDir, "server-browser", "profiles"),
    executable: () => Effect.runPromise(previewBrowser.executable),
    // Playwright's launch error drops Chrome's own output; its sandbox note survives.
    diagnose: (executable, cause) =>
      Effect.runPromiseWith(launchServices)(
        PreviewBrowserHost.diagnoseLaunchFailure({
          executable,
          setupCommand,
          output: /sandboxing failed/i.test(String(cause))
            ? PreviewBrowserHost.NO_SANDBOX_SIGNATURE
            : "",
        }),
      ),
    onContextClose: (context) => {
      for (const tab of tabs.values()) {
        if (tab.page.context() === context) dropTab(tab, true);
      }
    },
  });

  const dialogStatus = (tab: ServerTab) =>
    tab.dialog
      ? {
          type: tab.dialog.type(),
          message: tab.dialog.message().slice(0, 4000),
          defaultValue: tab.dialog.defaultValue().slice(0, 4000),
        }
      : null;

  const broadcastControl = (tab: ServerTab) => {
    // Every client's panel, including the desktop's native tabs, which have no
    // viewer stream, shows when an agent drives the tab.
    runFork(
      manager
        .reportAgentDriving({
          threadId: tab.threadId,
          tabId: tab.tabId,
          agentDriving: tab.control.agentDrives && !tab.closing,
        })
        .pipe(Effect.ignore),
    );
    for (const viewer of tab.viewers)
      viewer.push({
        _tag: "control",
        canOperate: viewer.canOperate,
        controller:
          tab.control.controller === viewer.id
            ? "you"
            : tab.control.controller !== null
              ? "another-viewer"
              : tab.control.agentDrives
                ? "agent"
                : "unclaimed",
        agentInvolved: tab.control.agentInvolved,
        generation: tab.control.generation,
        capabilities: ServerBrowserPick.PICK_CAPABILITIES,
        dialog: dialogStatus(tab),
      });
  };

  const resolveDialog = async (tab: ServerTab, input: PreviewAutomationDialogInput) => {
    const dialog = tab.dialog;
    if (!dialog) throw new Error("No dialog is pending.");
    if (input.accept) await dialog.accept(input.promptText);
    else await dialog.dismiss();
    if (tab.dialog === dialog) tab.dialog = null;
    ServerBrowserPage.invalidateRefs(tab.page);
    broadcastControl(tab);
  };

  const report = (tab: ServerTab, navStatus: PreviewNavStatus) => {
    void tab.cdp
      .send("Page.getNavigationHistory")
      .catch(() => null)
      .then((history) => {
        const index = history?.currentIndex ?? 0;
        const count = history?.entries.length ?? 0;
        runFork(
          manager
            .reportStatus({
              threadId: tab.threadId,
              tabId: tab.tabId,
              serverControlled: true,
              navStatus,
              canGoBack: index > 0,
              canGoForward: index < count - 1,
            })
            .pipe(Effect.ignore),
        );
      });
  };

  const reportLoaded = async (tab: ServerTab) => {
    const url = tab.page.url();
    // Chromium's error page loads after `requestfailed` and must not clear LoadFailed.
    if (url === "about:blank" || url.startsWith("chrome-error://")) return;
    const title = (await tab.page.title().catch(() => "")).slice(0, 512);
    // A navigation that started while reading the title owns the status now.
    if (tab.loading || tab.page.url() !== url) return;
    report(tab, { _tag: "Success", url: url.slice(0, 2048), title });
  };

  const reportLiveTabs = () => {
    const connectionId = hostConnectionId;
    if (connectionId === null) return;
    runFork(
      environment.getEnvironmentId.pipe(
        Effect.flatMap((environmentId) =>
          broker.focusHost({
            clientId: SERVER_HOST_CLIENT_ID,
            environmentId,
            connectionId,
            focused: true,
            liveTabs: [...tabs.values()].map((tab) => ({
              threadId: tab.threadId,
              tabId: tab.tabId,
              visible: isShown(tab),
            })),
          }),
        ),
      ),
    );
  };

  /** The CSS size the page lays out in: the viewport shrunk by the tab's zoom, as Chrome zooms. */
  const layoutSize = (tab: ServerTab) => {
    const size = tab.page.viewportSize();
    if (!size || tab.desktop) return size;
    return {
      width: Math.max(1, Math.round(size.width / tab.zoomFactor)),
      height: Math.max(1, Math.round(size.height / tab.zoomFactor)),
    };
  };

  /**
   * Zooms a headless page as Chrome's zoom does: it lays out in fewer CSS
   * pixels and draws each one larger, so frames keep their size. The desktop
   * zooms the pages it renders itself.
   */
  const applyZoom = async (tab: ServerTab) => {
    if (tab.desktop) return;
    const size = tab.page.viewportSize();
    if (!size) return;
    if (tab.zoomFactor === 1) {
      // Playwright's own override carries the plain viewport.
      await tab.page.setViewportSize(size);
      return;
    }
    const layout = layoutSize(tab)!;
    await tab.cdp.send("Emulation.setDeviceMetricsOverride", {
      width: layout.width,
      height: layout.height,
      deviceScaleFactor: RENDER_SCALE * tab.zoomFactor,
      mobile: false,
    });
  };

  const broadcastViewport = (tab: ServerTab) => {
    const size = layoutSize(tab);
    if (!size) return;
    for (const viewer of tab.viewers) viewer.push({ _tag: "viewport", ...size });
  };

  const applySetting = async (tab: ServerTab, setting: PreviewViewportSetting) => {
    tab.setting = setting;
    // The desktop lays its webview out at the published setting itself.
    if (tab.desktop) return;
    const size =
      fixedViewportSize(setting) ??
      [...tab.viewers]
        .map((viewer) => viewer.requestedSize)
        .filter((requested) => requested !== null)
        .sort((left, right) => right.order - left.order)[0] ??
      UNATTACHED_FILL_VIEWPORT;
    await tab.page.setViewportSize({ width: size.width, height: size.height });
    await applyZoom(tab);
    broadcastViewport(tab);
  };

  /** Applies a tab's published appearance and, for headless tabs, zoom. */
  const applyRendering = async (tab: ServerTab, snapshot: PreviewSessionSnapshot) => {
    const colorScheme = snapshot.colorScheme ?? "system";
    if (colorScheme !== tab.colorScheme) {
      tab.colorScheme = colorScheme;
      await tab.page.emulateMedia({ colorScheme: colorScheme === "system" ? null : colorScheme });
    }
    const zoomFactor = snapshot.zoomFactor ?? 1;
    if (zoomFactor !== tab.zoomFactor && !tab.desktop) {
      tab.zoomFactor = zoomFactor;
      await applyZoom(tab);
      broadcastViewport(tab);
    }
  };

  /** Whether the preview session for a tab still exists. */
  const sessionOpen = (tab: ServerTab) => !closedSessions.has(tabKey(tab.threadId, tab.tabId));

  /** `reconnect` tells viewers the tab lives on in another page, as when it moves to the desktop. */
  const dropTab = (tab: ServerTab, closeSession: boolean, viewerEnd?: "reconnect") => {
    const key = tabKey(tab.threadId, tab.tabId);
    if (tabs.get(key) !== tab) return;
    tabs.delete(key);
    if (closeSession) revealRequestedAt.delete(key);
    tab.closing = true;
    clearAbortedNavigation(tab);
    // A desktop page outlives the connection unless its session closed with it.
    const end =
      viewerEnd ?? (tab.desktop && !closeSession && sessionOpen(tab) ? "reconnect" : "gone");
    for (const viewer of tab.viewers) viewer.push({ _tag: end });
    void tab.control.close().catch(constVoid);
    // The desktop owns its page; letting go only ends this connection.
    if (tab.desktop) void tab.desktop.close().catch(constVoid);
    else void tab.page.close().catch(constVoid);
    if (tab.isolatedContext) void tab.page.context().close().catch(constVoid);
    void tab.recording?.encoder.close().catch(constVoid);
    void NodeFSP.rm(downloadDir(tab), { recursive: true, force: true }).catch(constVoid);
    reportLiveTabs();
    if (closeSession) {
      runFork(manager.close({ threadId: tab.threadId, tabId: tab.tabId }).pipe(Effect.ignore));
    }
  };

  /**
   * Agent `preview_open` calls in flight with `open: false`, per thread and
   * agent session. The tab they create stays out of the panel.
   */
  const backgroundOpens = new Map<string, number>();
  const backgroundOpenKey = (threadId: string, agentSessionId: string) =>
    `${threadId}\u0000${agentSessionId}`;

  /**
   * Asks every client to show a tab and select it in the thread's browser
   * panel, for a new agent tab that needs the panel's `<webview>` to attach.
   * Throttled per tab.
   */
  const requestPanelReveal = (threadId: string, tabId: string) => {
    const key = tabKey(threadId, tabId);
    const now = Date.now();
    if (now - (revealRequestedAt.get(key) ?? Number.NEGATIVE_INFINITY) < PANEL_REVEAL_INTERVAL_MS)
      return;
    revealRequestedAt.set(key, now);
    runFork(
      manager
        .requestReveal({ threadId: ThreadId.make(threadId), tabId, force: true })
        .pipe(Effect.ignore),
    );
  };

  /**
   * With a desktop app attached, every tab of this server renders there, so a
   * new tab waits for its `<webview>` instead of launching headless.
   */
  const desktopRenders = (snapshot: PreviewSessionSnapshot) =>
    desktopChannel.available
      ? Effect.runPromise(
          desktopChannel.awaitAttached(
            { threadId: snapshot.threadId, tabId: snapshot.tabId },
            DESKTOP_ATTACH_TIMEOUT,
          ),
        )
      : Promise.resolve(false);

  /** Connects to the desktop's page for a tab, which it renders and the server drives. */
  const connectDesktop = async (snapshot: PreviewSessionSnapshot) => {
    const scope = await Effect.runPromise(Scope.make());
    try {
      const endpoint = await Effect.runPromise(
        desktopChannel
          .endpoint({ threadId: snapshot.threadId, tabId: snapshot.tabId })
          .pipe(Scope.provide(scope)),
      );
      const connected = await contexts.connectDesktopPage(endpoint);
      return {
        page: connected.page,
        close: async () => {
          await connected.browser.close().catch(constVoid);
          await Effect.runPromise(Scope.close(scope, Exit.void));
        },
      };
    } catch (cause) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      throw cause;
    }
  };

  const createTab = async (snapshot: PreviewSessionSnapshot): Promise<ServerTab> => {
    const adopted = adoptedPages.get(tabKey(snapshot.threadId, snapshot.tabId));
    adoptedPages.delete(tabKey(snapshot.threadId, snapshot.tabId));
    // An agent tab nobody shows never gets a `<webview>`, and would run headless
    // with logins the panel does not have. Ask the panel to show it first.
    if (
      Targeting.revealBeforeAttach({
        desktopAvailable: desktopChannel.available,
        alreadyAttached: await Effect.runPromise(
          desktopChannel.isAttached({ threadId: snapshot.threadId, tabId: snapshot.tabId }),
        ),
        adopted: adopted !== undefined,
        agentOwned: snapshot.automationOwner !== undefined,
        background:
          snapshot.automationOwner !== undefined &&
          (backgroundOpens.get(backgroundOpenKey(snapshot.threadId, snapshot.automationOwner)) ??
            0) > 0,
      })
    ) {
      requestPanelReveal(snapshot.threadId, snapshot.tabId);
    }
    const desktop =
      adopted === undefined && (await desktopRenders(snapshot))
        ? await connectDesktop(snapshot)
        : null;
    // An agent tab without a profile (no client reported one) keeps throwaway storage.
    const isolatedContext =
      Targeting.tabBacking({
        adopted: adopted !== undefined,
        desktopAttached: desktop !== null,
        agentOwned: snapshot.automationOwner !== undefined,
        profileId: snapshot.profileId,
        incognitoProfileId: INCOGNITO_BROWSER_PROFILE_ID,
      }) === "headless-isolated";
    const context =
      adopted?.page.context() ??
      desktop?.page.context() ??
      (await contexts.contextFor(
        snapshot.profileId ?? "default",
        isolatedContext ? tabKey(snapshot.threadId, snapshot.tabId) : undefined,
      ));
    if (adopted?.page.isClosed()) throw new Error("The popup closed before it opened.");
    // The desktop page already has its own clipboard.
    if (!desktop) await prepareContext(context);
    const page = adopted?.page ?? desktop?.page ?? (await context.newPage());
    const cdp = await context.newCDPSession(page);
    // The desktop's page is already a normal browser. A popup's first request
    // went out before it became a tab; everything after presents as Chrome.
    if (!desktop) await presentAsChrome(cdp, host);
    if (!desktop) await recordCopies(cdp);
    page.setDefaultTimeout(NAVIGATION_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    const control = new SessionControl(snapshot.automationOwner ?? null, {
      onGenerationChange: () => ServerBrowserPage.invalidateRefs(page),
      // A person mid-drag loses control to an agent or another viewer: drop what they held.
      onDisplaced: async (viewerId) => {
        for (const viewer of tab.viewers) if (viewer.id === viewerId) await viewer.releaseInput();
      },
    });
    const tab: ServerTab = {
      threadId: ThreadId.make(snapshot.threadId),
      tabId: snapshot.tabId,
      page,
      cdp,
      frameSessions: new Map(),
      createdAt: Date.now(),
      usedAt: Date.now(),
      viewers: new Set(),
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
      control,
      isolatedContext,
      desktop: desktop === null ? null : { close: desktop.close },
      profileId: snapshot.profileId,
      openerTabId: adopted?.openerTabId,
      downloads: [],
      fileChooser: null,
      dialog: null,
      setting: snapshot.viewport ?? FILL_PREVIEW_VIEWPORT,
      colorScheme: "system",
      zoomFactor: 1,
      loading: false,
      closing: false,
      recording: null,
      recordingStart: null,
      initialNavigation: null,
      navigationGeneration: 0,
      abortedNavigation: null,
      captureLock: Promise.resolve(),
      capturing: 0,
    };
    if (!desktop) {
      await page.setViewportSize(fixedViewportSize(tab.setting) ?? UNATTACHED_FILL_VIEWPORT);
    }
    await applyRendering(tab, snapshot);
    const isMainNavigation = (request: { isNavigationRequest(): boolean; frame(): unknown }) =>
      request.isNavigationRequest() && request.frame() === page.mainFrame();
    const navigationGenerations = new WeakMap<object, number>();
    page.on("request", (request) => {
      if (!isMainNavigation(request)) return;
      navigationGenerations.set(request, ++tab.navigationGeneration);
      clearAbortedNavigation(tab);
      tab.loading = true;
      report(tab, { _tag: "Loading", url: request.url().slice(0, 2048), title: "" });
    });
    page.on("load", () => {
      tab.loading = false;
      void reportLoaded(tab);
    });
    page.on("framenavigated", (frame) => {
      // Same-document navigations (SPA routes) fire no load event.
      if (frame === page.mainFrame() && !tab.loading) void reportLoaded(tab);
      if (!desktop) void recordFrameCopies(tab, frame);
    });
    // An adopted popup's frames may have loaded before the tab listened.
    if (adopted) for (const frame of page.frames()) void recordFrameCopies(tab, frame);
    page.on("requestfailed", (request) => {
      const errorText = request.failure()?.errorText ?? "";
      pushBounded(tab.networkEntries, {
        url: request.url(),
        method: request.method(),
        status: null,
        failed: true,
        errorText,
        timestamp: new Date().toISOString(),
      });
      if (!isMainNavigation(request)) return;
      // A navigation a newer one replaced leaves the status to the newer one. A
      // popup's first request can predate the listener, so it is untracked and
      // superseded by any tracked one.
      const generation = navigationGenerations.get(request) ?? 0;
      if (generation !== tab.navigationGeneration) return;
      // An aborted navigation is usually a download; its `download` event settles the status.
      if (errorText.includes("ERR_ABORTED")) {
        const url = request.url();
        const navigationGeneration = tab.navigationGeneration;
        clearAbortedNavigation(tab);
        tab.abortedNavigation = {
          url,
          generation: navigationGeneration,
          timer: setTimeout(() => {
            if (tab.abortedNavigation?.generation !== navigationGeneration) return;
            tab.abortedNavigation = null;
            if (!tab.closing) settleAbortedNavigation(tab, navigationGeneration, url, undefined);
          }, ABORTED_NAVIGATION_DOWNLOAD_WAIT_MS),
        };
        return;
      }
      tab.loading = false;
      const { code, description } = ServerBrowserPage.parseNetError(errorText);
      report(tab, {
        _tag: "LoadFailed",
        url: request.url().slice(0, 2048),
        title: "",
        code,
        description,
      });
    });
    page.on("response", (response) => {
      pushBounded(tab.networkEntries, {
        url: response.url(),
        method: response.request().method(),
        status: response.status(),
        failed: false,
        timestamp: new Date().toISOString(),
      });
    });
    page.on("console", (message) => {
      pushBounded(tab.consoleEntries, {
        level: message.type(),
        text: message.text().slice(0, 2_000),
        timestamp: new Date().toISOString(),
      });
    });
    page.on("dialog", (dialog) => {
      tab.dialog = dialog;
      broadcastControl(tab);
    });
    page.on("download", (download) => void saveDownload(tab, download));
    page.on("filechooser", (chooser) => void offerFileChooser(tab, chooser));
    // Popups become tabs and keep `window.opener`, so sign-in popups can report back.
    page.on("popup", (popup) => void adoptPopup(tab, popup));
    // Playwright cannot reload a crashed page, so it must leave the tab list.
    const key = tabKey(tab.threadId, tab.tabId);
    if (closedPendingTabs.delete(key)) {
      await control.close().catch(constVoid);
      if (desktop) await desktop.close().catch(constVoid);
      else await page.close().catch(constVoid);
      if (isolatedContext) await context.close().catch(constVoid);
      throw new ServerBrowserTabNotFoundError({ threadId: tab.threadId, tabId: tab.tabId });
    }
    page.on("close", () => dropTab(tab, true));
    page.on("crash", () => dropTab(tab, true));
    tabs.set(key, tab);
    reportLiveTabs();
    // An agent's own tab is the agent's from the start; the panel says so.
    if (control.agentDrives) broadcastControl(tab);
    // A popup is already loading its own URL, and the desktop loads its tab's.
    if (!adopted && !desktop && snapshot.navStatus._tag === "Loading") {
      tab.initialNavigation = page
        .goto(snapshot.navStatus.url, { waitUntil: "commit", timeout: NAVIGATION_TIMEOUT_MS })
        .then(constVoid);
      // Background creation keeps the failed tab; automation awaits the original error.
      void tab.initialNavigation.catch(constVoid);
    }
    return tab;
  };

  const downloadsRoot = NodePath.join(config.stateDir, "server-browser", "downloads");
  // Tab ids are opaque server strings; hashing keeps them out of the path.
  const downloadDir = (tab: ServerTab) =>
    NodePath.join(
      downloadsRoot,
      NodeCrypto.createHash("sha256").update(tabKey(tab.threadId, tab.tabId)).digest("hex"),
    );

  const clearAbortedNavigation = (tab: ServerTab) => {
    if (tab.abortedNavigation !== null) clearTimeout(tab.abortedNavigation.timer);
    tab.abortedNavigation = null;
  };

  /**
   * Settles the status of a navigation that aborted, usually into a download.
   * A tab opened straight to the file has no page to show, so it reports the
   * file with its download; a page that linked to it keeps showing itself.
   */
  const settleAbortedNavigation = (
    tab: ServerTab,
    generation: number,
    url: string,
    offered: { readonly id: string; readonly fileName: string } | undefined,
  ) => {
    // A newer navigation owns the status.
    if (tab.navigationGeneration !== generation) return;
    tab.loading = false;
    if (tab.page.url() !== "about:blank") {
      void reportLoaded(tab);
      return;
    }
    report(tab, {
      _tag: "LoadFailed",
      url: url.slice(0, 2048),
      title: "",
      code: -3,
      description: "ERR_ABORTED",
      ...(offered === undefined ? {} : { download: offered }),
    });
  };

  const saveDownload = async (tab: ServerTab, download: Download) => {
    const id = NodeCrypto.randomUUID();
    const path = NodePath.join(downloadDir(tab), id);
    const navigation =
      download.url() === tab.abortedNavigation?.url ? tab.abortedNavigation.generation : null;
    if (navigation !== null) clearAbortedNavigation(tab);
    let offered: { readonly id: string; readonly fileName: string } | undefined;
    try {
      if (await download.failure()) return;
      await NodeFSP.mkdir(downloadDir(tab), { recursive: true });
      await download.saveAs(path);
      const { size } = await NodeFSP.stat(path);
      if (tab.closing || size > DOWNLOAD_MAX_BYTES) {
        await NodeFSP.rm(path, { force: true });
        return;
      }
      const saved: ServerDownload = {
        id,
        fileName: download.suggestedFilename().slice(0, 255) || "download",
        path,
        sizeBytes: size,
        url: download.url().slice(0, 2048),
        completedAt: new Date().toISOString(),
      };
      tab.downloads.push(saved);
      for (const evicted of tab.downloads.splice(0, tab.downloads.length - DOWNLOAD_LIMIT)) {
        await NodeFSP.rm(evicted.path, { force: true }).catch(constVoid);
      }
      offered = { id, fileName: saved.fileName };
      // A tab whose own address was the file shows it in place (see
      // settleAbortedNavigation), unless it navigated on while the file saved.
      const shownInTab =
        navigation === tab.navigationGeneration && tab.page.url() === "about:blank";
      if (shownInTab) return;
      // Only the person driving the page gets the file offered; agents read it from status.
      const controller = [...tab.viewers].find((viewer) => viewer.id === tab.control.controller);
      controller?.push({
        _tag: "download",
        id,
        fileName: saved.fileName,
        sizeBytes: saved.sizeBytes,
      });
    } catch (cause) {
      await NodeFSP.rm(path, { force: true }).catch(constVoid);
      runFork(Effect.logWarning("server preview download failed", { cause }));
    } finally {
      if (navigation !== null && !tab.closing) {
        settleAbortedNavigation(tab, navigation, download.url(), offered);
      }
    }
  };

  const fileChooserMessage = (tab: ServerTab): ServerBrowserViewerOutput | null =>
    tab.fileChooser
      ? {
          _tag: "fileChooser",
          id: tab.fileChooser.id,
          multiple: tab.fileChooser.chooser.isMultiple(),
          accept: tab.fileChooser.accept,
        }
      : null;

  const offerFileChooser = async (tab: ServerTab, chooser: FileChooser) => {
    const previous = tab.fileChooser;
    const accept =
      (await chooser
        .element()
        .getAttribute("accept")
        .catch(() => null)) ?? "";
    // A newer picker replaces an unanswered one, as a real browser allows only one.
    if (previous) closeFileChooser(tab);
    tab.fileChooser = {
      id: NodeCrypto.randomUUID(),
      chooser,
      accept: accept.slice(0, 1024),
      offeredTo: null,
    };
    pushFileChooser(tab);
  };

  const pushFileChooser = (tab: ServerTab) => {
    const open = tab.fileChooser;
    const controller = [...tab.viewers].find((viewer) => viewer.id === tab.control.controller);
    if (!open || !controller) return;
    if (open.offeredTo !== controller.id) {
      // A new controller gets a fresh id; the previous one can no longer answer.
      tab.fileChooser = { ...open, id: NodeCrypto.randomUUID(), offeredTo: controller.id };
      if (open.offeredTo !== null)
        for (const viewer of tab.viewers) viewer.push({ _tag: "fileChooserClosed", id: open.id });
    }
    const message = fileChooserMessage(tab);
    if (message) controller.push(message);
  };

  const closeFileChooser = (tab: ServerTab) => {
    const open = tab.fileChooser;
    if (!open) return;
    tab.fileChooser = null;
    for (const viewer of tab.viewers) viewer.push({ _tag: "fileChooserClosed", id: open.id });
  };

  /** Hands uploaded files to the page's open picker; an empty list cancels it. */
  const setChooserFiles = async (
    input: Parameters<ServerBrowser["Service"]["answerFileChooser"]>[0],
  ) => {
    const tab = tabs.get(tabKey(input.threadId, input.tabId));
    const open = tab?.fileChooser;
    if (
      !tab ||
      !open ||
      open.id !== input.chooserId ||
      open.offeredTo === null ||
      open.offeredTo !== tab.control.controller
    )
      return false;
    if (input.files.length > 0) {
      await open.chooser.setFiles(
        open.chooser.isMultiple() ? [...input.files] : input.files.slice(0, 1),
      );
    }
    if (tab.fileChooser === open) closeFileChooser(tab);
    return true;
  };
  /** The agent's files go to a named file input, or else to the page's open picker. */
  const uploadFiles = async (tab: ServerTab, input: PreviewAutomationUploadInput) => {
    const relative = input.paths.find((path) => !NodePath.isAbsolute(path));
    if (relative !== undefined)
      throw new ServerBrowserPage.ServerBrowserOperationError(
        "PreviewAutomationExecutionError",
        `Upload paths must be absolute: ${relative}`,
      );
    if (await ServerBrowserPage.setInputFiles(tab.page, input, pointerFor(tab))) return undefined;
    const open = tab.fileChooser;
    if (!open)
      throw new ServerBrowserPage.ServerBrowserOperationError(
        "PreviewAutomationExecutionError",
        "No file picker is open. Click the page's upload control first, or pass the file input's locator.",
      );
    if (input.paths.length > 1 && !open.chooser.isMultiple())
      throw new ServerBrowserPage.ServerBrowserOperationError(
        "PreviewAutomationExecutionError",
        "This file picker accepts one file.",
      );
    if (input.paths.length > 0)
      await open.chooser.setFiles([...input.paths], {
        timeout: input.timeoutMs ?? NAVIGATION_TIMEOUT_MS,
      });
    if (tab.fileChooser === open) closeFileChooser(tab);
    return undefined;
  };

  const answerFileChooser: ServerBrowser["Service"]["answerFileChooser"] = (input) =>
    Effect.promise(() => setChooserFiles(input).catch(() => false));

  const openDownload: ServerBrowser["Service"]["openDownload"] = (input) =>
    Effect.sync(() => {
      const download = tabs
        .get(tabKey(input.threadId, input.tabId))
        ?.downloads.find((candidate) => candidate.id === input.downloadId);
      return download === undefined
        ? Option.none()
        : Option.some({ path: download.path, fileName: download.fileName });
    });

  const preparedContexts = new WeakSet<BrowserContext>();
  const prepareContext = async (context: BrowserContext) => {
    if (preparedContexts.has(context)) return;
    preparedContexts.add(context);
    await context.grantPermissions(["clipboard-write"]);
  };

  /**
   * What the desktop says about a tab's site permissions, or undefined for a
   * tab it does not render or an app too old to answer. A silent desktop is
   * not asked again for a minute, so a status never waits on it twice.
   */
  let desktopPermissionsSilentUntil = 0;
  const askDesktopPermissions = async (
    tab: ServerTab,
    change: DesktopBrowserChannel.DesktopPermissionChange | null,
  ) => {
    if (tab.desktop === null) return undefined;
    if (change === null && Date.now() < desktopPermissionsSilentUntil) return undefined;
    const answer = await Effect.runPromise(
      desktopChannel.permission(
        { threadId: tab.threadId, tabId: tab.tabId },
        change,
        change === null ? DESKTOP_PERMISSION_READ_TIMEOUT_MS : DESKTOP_PERMISSION_CHANGE_TIMEOUT_MS,
      ),
    );
    if (Option.isNone(answer)) {
      if (change === null)
        desktopPermissionsSilentUntil = Date.now() + DESKTOP_PERMISSION_BACKOFF_MS;
      return undefined;
    }
    return answer.value;
  };

  /** The site permissions of a tab the desktop renders, with the page waiting on the user if any. */
  const desktopSitePermissions = async (
    tab: ServerTab,
  ): Promise<SitePermissionsState | undefined> => {
    const answer = await askDesktopPermissions(tab, null);
    return answer?.ok === true ? answer.state : undefined;
  };

  const headlessPermissions = new WeakMap<BrowserContext, HeadlessSitePermissions>();
  /** Grants a headless context exactly what its decisions allow; Playwright can only clear and re-grant. */
  const applyHeadlessPermissions = async (
    context: BrowserContext,
    decisions: HeadlessSitePermissions,
  ) => {
    await context.clearPermissions();
    await context.grantPermissions(["clipboard-write"]);
    for (const { origin, permissions } of decisions.grants()) {
      await context.grantPermissions([...permissions], { origin });
    }
  };

  /** `preview_permission`: decides one permission for a site, in the desktop or the headless browser. */
  const decideSitePermission = async (
    tab: ServerTab,
    input: PreviewAutomationPermissionInput,
  ): Promise<SitePermissionsState> => {
    const requestedOrigin = input.origin === undefined ? undefined : siteOrigin(input.origin);
    if (input.origin !== undefined && requestedOrigin === null) {
      throw new ServerBrowserPage.ServerBrowserOperationError(
        "PreviewAutomationExecutionError",
        "origin must be an http or https URL such as https://app.example.com.",
      );
    }
    const refuse = (reason: "user-blocked" | "no-origin" | "unknown-tab", origin: string | null) =>
      new ServerBrowserPage.ServerBrowserOperationError(
        "PreviewAutomationExecutionError",
        permissionRefusalMessage(reason, input.permission, origin),
      );
    if (tab.desktop !== null) {
      const answer = await askDesktopPermissions(tab, {
        permission: input.permission,
        setting: input.decision,
        ...(requestedOrigin ? { origin: requestedOrigin } : {}),
      });
      if (answer === undefined) {
        throw new ServerBrowserPage.ServerBrowserOperationError(
          "PreviewAutomationExecutionError",
          "The desktop app did not answer. Ask the user to click Allow in the browser toolbar, and update the desktop app if this keeps happening.",
        );
      }
      if (!answer.ok) throw refuse(answer.reason, answer.state?.origin ?? requestedOrigin ?? null);
      return answer.state;
    }
    const origin = requestedOrigin ?? siteOrigin(tab.page.url());
    if (origin === null) throw refuse("no-origin", null);
    const context = tab.page.context();
    const decisions = headlessPermissions.get(context) ?? new HeadlessSitePermissions();
    headlessPermissions.set(context, decisions);
    decisions.set(origin, input.permission, input.decision);
    await applyHeadlessPermissions(context, decisions);
    return decisions.state(origin);
  };

  /** Records the copies made in each frame a session reaches. */
  const recordCopies = async (cdp: CDPSession) => {
    // Scripts for new documents run only while this session's Page domain is on.
    await cdp.send("Page.enable");
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: CLIPBOARD_SCRIPT,
      worldName: CLIPBOARD_WORLD,
      runImmediately: true,
    });
  };

  /**
   * A frame in its own process, such as one with an `Origin-Agent-Cluster`
   * header, is out of the page session's reach, so it records copies through
   * its own session until that target closes.
   */
  const recordFrameCopies = async (tab: ServerTab, frame: Frame) => {
    if (frame === tab.page.mainFrame() || tab.frameSessions.has(frame)) return;
    // A frame in its parent's process has no session of its own.
    const cdp = await tab.page
      .context()
      .newCDPSession(frame)
      .catch(() => null);
    if (!cdp) return;
    if (tab.frameSessions.has(frame) || frame.isDetached()) {
      await cdp.detach().catch(constVoid);
      return;
    }
    tab.frameSessions.set(frame, cdp);
    cdp.on("close", () => {
      if (tab.frameSessions.get(frame) !== cdp) return;
      tab.frameSessions.delete(frame);
      // A frame that moved to another process records through its new target.
      if (!frame.isDetached()) void recordFrameCopies(tab, frame);
    });
    await recordCopies(cdp).catch(constVoid);
  };

  /** Clears and returns the copy of each frame a session reaches. */
  const takeSessionCopies = async (cdp: CDPSession) => {
    // An out-of-process frame that closed meanwhile copied nothing.
    const tree = await cdp.send("Page.getFrameTree").catch(() => null);
    if (!tree) return [];
    const frameIds = (node: typeof tree.frameTree): Array<string> => [
      node.frame.id,
      ...(node.childFrames ?? []).flatMap(frameIds),
    ];
    return Promise.all(
      frameIds(tree.frameTree).map((frameId) =>
        cdp
          .send("Page.createIsolatedWorld", { frameId, worldName: CLIPBOARD_WORLD })
          .then(({ executionContextId }) =>
            cdp.send("Runtime.evaluate", {
              contextId: executionContextId,
              expression: "globalThis.takeCopy?.()",
              returnByValue: true,
            }),
          )
          .then(
            ({ result }) => (typeof result.value === "string" ? result.value : ""),
            // A frame that detached meanwhile copied nothing.
            () => "",
          ),
      ),
    );
  };

  /** Clears every frame's copy and returns what the key just handled copied or cut. */
  const takeCopiedText = async (tab: ServerTab) => {
    const copies = await Promise.all(
      [tab.cdp, ...tab.frameSessions.values()].map(takeSessionCopies),
    );
    return copies.flat().find((text) => text.length > 0);
  };

  const adoptPopup = async (opener: ServerTab, popup: Page) => {
    const agentId = opener.control.agentId;
    // A popup past an agent's limit closes; its page sees window.open return a closed window.
    if (opener.closing || (agentId !== null && atTabLimit(agentId))) {
      await popup.close().catch(constVoid);
      return;
    }
    const url = popup.url();
    // Captured now: the person whose click opened the popup gets switched to it.
    const controller = [...opener.viewers].find(
      (viewer) => viewer.id === opener.control.controller,
    );
    await Effect.runPromise(
      manager.open({
        threadId: opener.threadId,
        ...(/^https?:/i.test(url) ? { url } : {}),
        runtime: "server",
        ...(opener.profileId === undefined ? {} : { profileId: opener.profileId }),
        // Agent popups stay with the agent and only show when it asks, like its own opens.
        ...(opener.control.agentId === null
          ? {}
          : { automationOwner: opener.control.agentId, reveal: false }),
        beforePublish: (snapshot) =>
          adoptedPages.set(tabKey(snapshot.threadId, snapshot.tabId), {
            page: popup,
            openerTabId: opener.tabId,
          }),
      }),
    ).then(
      (snapshot) => {
        // The opener stays open behind it, so `window.opener` can still report back.
        if (opener.control.agentId === null)
          controller?.push({ _tag: "popup", tabId: snapshot.tabId });
      },
      async () => {
        await popup.close().catch(constVoid);
      },
    );
  };

  const ensureTab = (snapshot: PreviewSessionSnapshot): Promise<ServerTab> => {
    const key = tabKey(snapshot.threadId, snapshot.tabId);
    const pending = pendingTabs.get(key);
    if (pending) return pending;
    const existing = tabs.get(key);
    if (existing) return Promise.resolve(existing);
    const opening = createTab(snapshot)
      .catch((cause: unknown) => {
        runFork(
          Effect.logWarning(
            isHostSetupError(cause) ? cause.message : "server preview tab failed to start",
            { cause },
          ),
        );
        throw cause;
      })
      .finally(() => {
        pendingTabs.delete(key);
        closedPendingTabs.delete(key);
      });
    pendingTabs.set(key, opening);
    return opening;
  };

  const findTab = (threadId: string, tabId: string) =>
    Effect.gen(function* () {
      const existing = tabs.get(tabKey(threadId, tabId));
      if (existing) return existing;
      const { sessions } = yield* manager.list({ threadId: ThreadId.make(threadId) });
      const snapshot = sessions.find(
        (session) => session.tabId === tabId && session.runtime === "server",
      );
      if (!snapshot) return yield* new ServerBrowserTabNotFoundError({ threadId, tabId });
      return yield* Effect.tryPromise({
        try: () => ensureTab(snapshot),
        catch: (cause) => (isTabNotFound(cause) ? cause : new ServerBrowserLaunchError({ cause })),
      });
    });

  const atTabLimit = (agentSessionId: string) =>
    tabs.size + pendingTabs.size >= SERVER_TAB_LIMIT ||
    [...tabs.values()].filter((tab) => tab.control.agentId === agentSessionId).length >=
      AGENT_TAB_LIMIT;

  const assertTabCapacity = (agentSessionId: string) => {
    if (atTabLimit(agentSessionId))
      throw new BrowserControlInterrupted(
        `Too many server browser tabs are open (${AGENT_TAB_LIMIT} per agent session, ${SERVER_TAB_LIMIT} per server). Close one with preview_close or reuse one from preview_status tabs.`,
        "tabLimit",
      );
  };

  /** Closes agent tabs that no one watches and the agent stopped using. */
  const closeIdleAgentTabs = () => {
    const cutoff = Date.now() - AGENT_TAB_IDLE_MS;
    for (const tab of tabs.values()) {
      if (tab.control.agentId !== null && !isShown(tab) && tab.usedAt < cutoff) dropTab(tab, true);
    }
  };

  /**
   * The tab a request without a tabId means: the caller's newest tab, else the
   * thread's tab the user is looking at or used last, so "this page" works.
   */
  const latestThreadTab = (threadId: string, agentSessionId?: string) => {
    const byTargetable = new Map([...tabs.values()].map((tab) => [targetable(tab), tab]));
    const picked = Targeting.pickDefaultTab(byTargetable.keys(), threadId, agentSessionId, {
      reported: shownReport,
    });
    return picked === undefined ? undefined : byTargetable.get(picked);
  };

  /** Which tab an action ran on, returned with its result. */
  const tabSummary = (tab: ServerTab): PreviewAutomationTabSummary => {
    const url = tab.page.url();
    const threadTabs = [...tabs.values()]
      .filter((candidate) => candidate.threadId === tab.threadId)
      .map((candidate) => ({
        ...targetable(candidate),
        url: candidate.page.url() === "about:blank" ? null : candidate.page.url(),
      }));
    const rendering = Targeting.tabRenderingStatus(targetable(tab), desktopChannel.available);
    const notice = Targeting.targetNotice(
      { ...targetable(tab), url: url === "about:blank" ? null : url },
      threadTabs,
      desktopChannel.available,
      { reported: shownReport },
    );
    return {
      tabId: tab.tabId,
      url: url === "about:blank" ? null : url,
      ...(tab.profileId === undefined ? {} : { profileId: tab.profileId }),
      visible: isShown(tab),
      rendering: rendering.rendering,
      ...(rendering.sessionMismatch ? { sessionMismatch: true } : {}),
      ...(notice === undefined ? {} : { notice }),
    };
  };

  /** Adds what the user's waiting prompt means to the tab's notice, so an agent sees it and says so. */
  const withPermissionNotice = (
    summary: PreviewAutomationTabSummary,
    permissions: SitePermissionsState | undefined,
  ): PreviewAutomationTabSummary => {
    const prompt = permissions === undefined ? undefined : permissionPromptNotice(permissions);
    if (prompt === undefined) return summary;
    return {
      ...summary,
      notice: summary.notice === undefined ? prompt : `${summary.notice} ${prompt}`,
    };
  };

  /** Adds the tab an action ran on to its result; `evaluate` returns the page's own value. */
  const withTabSummary = (operation: string, result: unknown, tab: ServerTab): unknown => {
    if (operation === "evaluate") return result;
    if (result === undefined) return { tab: tabSummary(tab) };
    if (typeof result !== "object" || result === null || Array.isArray(result)) return result;
    return { ...result, tab: tabSummary(tab) };
  };

  const reportShown: ServerBrowser["Service"]["reportShown"] = (input) =>
    Effect.sync(() => {
      shownReport = new Set(input.tabs.map((tab) => tabKey(tab.threadId, tab.tabId)));
      reportLiveTabs();
    });

  const tabOwner = (tab: ServerTab) =>
    tab.control.controller !== null
      ? ("human" as const)
      : tab.control.agentId !== null
        ? ("agent" as const)
        : ("unclaimed" as const);

  /** The latest profile list a client reported; agents choose from it. */
  let reportedProfiles: {
    readonly profiles: ReadonlyArray<BrowserProfile>;
    readonly defaultProfileId: string;
  } | null = null;

  const reportProfiles: ServerBrowser["Service"]["reportProfiles"] = (input) =>
    Effect.sync(() => {
      const profiles = resolveBrowserProfiles(input.profiles);
      reportedProfiles = {
        profiles,
        defaultProfileId:
          findBrowserProfile(profiles, input.defaultProfileId)?.id ?? DEFAULT_BROWSER_PROFILE_ID,
      };
    });

  const profileStatus = () => {
    const profiles = reportedProfiles?.profiles ?? BUILT_IN_BROWSER_PROFILES;
    return {
      profiles: profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        ...(profile.kind === "incognito" ? { incognito: true } : {}),
      })),
      ...(reportedProfiles ? { defaultProfileId: reportedProfiles.defaultProfileId } : {}),
    };
  };

  /** Matches an id, then a case-insensitive name. Omitted means the reported default. */
  const resolveOpenProfile = (requested: string | undefined): string | undefined => {
    if (requested === undefined) return reportedProfiles?.defaultProfileId;
    const profiles = reportedProfiles?.profiles ?? BUILT_IN_BROWSER_PROFILES;
    const wanted = requested.toLowerCase();
    const match =
      findBrowserProfile(profiles, requested) ??
      profiles.find((profile) => profile.name.toLowerCase() === wanted);
    if (match) return match.id;
    throw new ServerBrowserPage.ServerBrowserOperationError(
      "PreviewAutomationUnknownProfileError",
      `No browser profile is named "${requested}". Use one of: ${profiles
        .map((profile) => `${profile.name} (id ${profile.id})`)
        .join(", ")}.`,
    );
  };

  const statusWithTitle = async (
    tab: ServerTab | undefined,
    agentSessionId?: string,
  ): Promise<PreviewAutomationStatus> => {
    if (!tab) {
      return {
        available: false,
        visible: false,
        tabId: null,
        url: null,
        title: null,
        loading: false,
        ...profileStatus(),
      };
    }
    const url = tab.page.url();
    const viewport = tab.page.viewportSize();
    const sitePermissions = await desktopSitePermissions(tab);
    const summary = withPermissionNotice(tabSummary(tab), sitePermissions);
    const status = {
      available: true,
      visible: summary.visible,
      tabId: tab.tabId,
      url: url === "about:blank" ? null : url,
      title: null,
      loading: tab.loading,
      ...(summary.profileId === undefined ? {} : { profileId: summary.profileId }),
      ...(summary.rendering === undefined ? {} : { rendering: summary.rendering }),
      ...(summary.sessionMismatch ? { sessionMismatch: true } : {}),
      ...(summary.notice === undefined ? {} : { notice: summary.notice }),
      control: {
        owner: tabOwner(tab),
        ownedByCaller: tab.control.agentId === agentSessionId,
        generation: tab.control.generation,
      },
      dialog: dialogStatus(tab),
      ...(sitePermissions === undefined ? {} : { sitePermissions }),
      fileChooser: tab.fileChooser
        ? { multiple: tab.fileChooser.chooser.isMultiple(), accept: tab.fileChooser.accept }
        : null,
      viewportSetting: tab.setting,
      ...(viewport ? { viewport } : {}),
      tabs: [...tabs.values()]
        .filter((candidate) => candidate.threadId === tab.threadId)
        .map((candidate) => ({
          tabId: candidate.tabId,
          url: candidate.page.url() === "about:blank" ? null : candidate.page.url(),
          ...(candidate.openerTabId === undefined ? {} : { openerTabId: candidate.openerTabId }),
          owner: tabOwner(candidate),
          ownedByCaller: candidate.control.agentId === agentSessionId,
          visible: isShown(candidate),
          ...(candidate.profileId === undefined ? {} : { profileId: candidate.profileId }),
          rendering: candidate.desktop === null ? ("background" as const) : ("panel" as const),
        })),
      ...profileStatus(),
      downloads: tab.downloads.map(({ fileName, path, sizeBytes, url, completedAt }) => ({
        fileName,
        path,
        sizeBytes,
        url,
        completedAt,
      })),
    };
    if (status.url === null || tab.dialog) return status;
    return { ...status, title: (await tab.page.title().catch(() => "")) || null };
  };

  const resolveNavigationUrl = (input: PreviewAutomationNavigateInput) => {
    if (input.url !== undefined) return normalizePreviewUrl(input.url);
    const target = input.target!;
    if (target.kind === "url") return normalizePreviewUrl(target.url);
    // The browser runs inside the environment, so its ports are loopback.
    const path = target.path ?? "";
    return `${target.protocol ?? "http"}://localhost:${target.port}${path.startsWith("/") || path === "" ? path : `/${path}`}`;
  };

  const navigate = async (
    tab: ServerTab,
    url: string,
    readiness: "load" | "domContentLoaded" | "none",
    timeout: number,
  ) => {
    const navigation = tab.page.goto(url, {
      timeout,
      waitUntil:
        readiness === "domContentLoaded"
          ? "domcontentloaded"
          : readiness === "none"
            ? "commit"
            : "load",
    });
    if (readiness === "none") {
      tab.control.track(navigation);
      return;
    }
    await navigation.catch((cause: unknown) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (message.includes("Download is starting")) {
        throw new ServerBrowserPage.ServerBrowserOperationError(
          "PreviewAutomationExecutionError",
          `${url} is a file this browser cannot show, so it was downloaded instead. preview_status lists it under downloads.`,
        );
      }
      if (/ERR_[A-Z_]+/.test(message)) {
        throw new ServerBrowserPage.ServerBrowserOperationError(
          "PreviewAutomationExecutionError",
          `Navigation to ${url} failed: ${ServerBrowserPage.parseNetError(message).description}`,
        );
      }
      throw cause;
    });
  };

  const withCaptureLock = <A>(tab: ServerTab, operation: () => Promise<A>): Promise<A> => {
    const run = tab.captureLock.then(() => {
      if (tab.closing) throw new Error("The preview tab closed.");
      return operation();
    });
    tab.captureLock = run.then(constVoid, constVoid);
    return run;
  };

  const startRecording = (tab: ServerTab): Promise<Recording> => {
    const started = withCaptureLock(tab, async () => {
      if (tab.recording) return tab.recording;
      const encoder = await contexts.scratchPage();
      let session: CDPSession | null = null;
      try {
        await encoder.evaluate(ServerBrowserPage.RECORDING_ENCODER_SCRIPT);
        // Seed idle pages before returning so an immediate stop has a frame to encode.
        const firstFrame = await ServerBrowserPage.captureViewport(tab.page, tab.cdp, {
          format: "jpeg",
          quality: RECORDING_SCREENCAST.quality,
          scale: 1,
        });
        await encoder.evaluate(
          ([data, width]) =>
            (globalThis as unknown as EncoderWindow).__t3Recorder.frame(data, width),
          [firstFrame, tab.page.viewportSize()?.width ?? UNATTACHED_FILL_VIEWPORT.width] as const,
        );
        const opened = await tab.page.context().newCDPSession(tab.page);
        session = opened;
        const framesInFlight = new Set<Promise<void>>();
        opened.on("Page.screencastFrame", (frame) => {
          const cssWidth = tab.page.viewportSize()?.width ?? frame.metadata.deviceWidth;
          const delivered: Promise<void> = encoder
            .evaluate(
              ([data, width]) =>
                (globalThis as unknown as EncoderWindow).__t3Recorder.frame(data, width),
              [frame.data, cssWidth] as const,
            )
            .then(async (accepted) => {
              if (!accepted) await opened.send("Page.stopScreencast");
            })
            .catch(constVoid)
            .finally(() => {
              framesInFlight.delete(delivered);
              void opened
                .send("Page.screencastFrameAck", { sessionId: frame.sessionId })
                .catch(constVoid);
            });
          framesInFlight.add(delivered);
        });
        await opened.send("Page.startScreencast", RECORDING_SCREENCAST);
        if (tab.closing) throw new Error("The tab closed while the recording started.");
        const recording: Recording = {
          encoder,
          session: opened,
          startedAt: new Date().toISOString(),
          framesInFlight,
        };
        tab.recording = recording;
        return recording;
      } catch (cause) {
        // A start that fails partway must not leave its encoder page behind.
        await encoder.close().catch(constVoid);
        await session?.detach().catch(constVoid);
        throw cause;
      }
    }).finally(() => {
      if (tab.recordingStart === started) tab.recordingStart = null;
    });
    tab.recordingStart = started;
    return started;
  };

  // Scaled captures repaint every screencast; pause them to avoid leaking that frame.
  const withScreencastsPaused = <A>(tab: ServerTab, capture: () => Promise<A>): Promise<A> =>
    withCaptureLock(tab, async () => {
      tab.capturing += 1;
      const recording = tab.recording;
      try {
        await Promise.all([
          ...[...tab.viewers].map((viewer) => viewer.pause()),
          recording?.session.send("Page.stopScreencast").catch(constVoid),
        ]);
        return await capture();
      } finally {
        tab.capturing -= 1;
        // Viewers that attached during the capture start here too.
        await Promise.all([
          ...[...tab.viewers].map((viewer) => viewer.resume()),
          recording && tab.recording === recording
            ? recording.session.send("Page.startScreencast", RECORDING_SCREENCAST).catch(constVoid)
            : undefined,
        ]);
      }
    });

  const stopRecording = (tab: ServerTab) =>
    withCaptureLock(tab, async () => {
      const recording = tab.recording;
      if (!recording) {
        throw new ServerBrowserPage.ServerBrowserOperationError(
          "PreviewAutomationRecordingNotActiveError",
          "No recording is active for this tab.",
        );
      }
      let mimeType: string | null;
      const chunks: Array<Buffer> = [];
      try {
        await recording.session.send("Page.stopScreencast").catch(constVoid);
        // The last frames may still be on their way into the encoder.
        await Promise.all(recording.framesInFlight);
        await recording.session.detach().catch(constVoid);
        const stopped = await recording.encoder.evaluate(() =>
          (globalThis as unknown as EncoderWindow).__t3Recorder.stop(),
        );
        mimeType = stopped.mimeType;
        // Checked before the transfer so an oversized video never lands in this process.
        if (stopped.bytes > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
          throw new ServerBrowserPage.ServerBrowserOperationError(
            "PreviewAutomationRecordingTooLargeError",
            "The recording is larger than the attachment limit.",
          );
        }
        for (let index = 0; index < stopped.count; index += 1) {
          const chunk = await recording.encoder.evaluate(
            (chunkIndex) => (globalThis as unknown as EncoderWindow).__t3Recorder.chunk(chunkIndex),
            index,
          );
          chunks.push(Buffer.from(chunk, "base64"));
        }
      } finally {
        await recording.encoder.close().catch(constVoid);
        tab.recording = null;
      }
      const data = Buffer.concat(chunks);
      if (!mimeType || data.byteLength === 0) {
        throw new ServerBrowserPage.ServerBrowserOperationError(
          "PreviewAutomationExecutionError",
          "The recording captured no frames.",
        );
      }
      // Use the desktop upload location so the MCP handler can claim the recording.
      const extension = mimeType.startsWith("video/mp4") ? "mp4" : "webm";
      const pendingId = `${PENDING_ATTACHMENT_THREAD_SEGMENT}-${NodeCrypto.randomUUID()}-${extension}`;
      const path = NodePath.join(config.attachmentsDir, `${pendingId}.${extension}`);
      await NodeFSP.mkdir(config.attachmentsDir, { recursive: true });
      await NodeFSP.writeFile(path, data);
      return {
        id: pendingId,
        tabId: tab.tabId,
        path,
        mimeType: mimeType.split(";")[0]!,
        sizeBytes: data.byteLength,
        createdAt: new Date().toISOString(),
        uploadedAttachmentId: pendingId,
      };
    });

  let pointerSequence = 0;
  /**
   * Shows viewers and recordings where the agent is about to act. Nobody is
   * watching a headless agent tab, so it pays no glide delay.
   */
  const pointerFor =
    (tab: ServerTab): ServerBrowserPage.PointerReporter =>
    async ({ x, y, box }, phase) => {
      const encoder = tab.recording?.encoder;
      // A desktop-rendered tab is always on screen in the desktop app.
      if (tab.viewers.size === 0 && !encoder && !tab.desktop) return;
      const show = (next: "move" | "click") => {
        const sequence = ++pointerSequence;
        for (const viewer of tab.viewers)
          viewer.push({ _tag: "pointer", phase: next, x, y, sequence, box });
        if (tab.desktop)
          runFork(
            desktopChannel.pointer(
              { threadId: tab.threadId, tabId: tab.tabId },
              { phase: next, x, y, ...(box ? { box } : {}) },
            ),
          );
        void encoder
          ?.evaluate(
            ([px, py, click]) =>
              (globalThis as unknown as EncoderWindow).__t3Recorder?.cursor(px, py, click),
            [x, y, next === "click"] as const,
          )
          .catch(constVoid);
      };
      show("move");
      await sleepUntil(Date.now() + AGENT_CURSOR_MOVE_MS);
      if (phase !== "click") return;
      show("click");
      await sleepUntil(Date.now() + AGENT_CURSOR_CLICK_LEAD_MS);
    };

  const recordAction = <A>(tab: ServerTab, action: string, run: () => Promise<A>): Promise<A> => {
    const event: {
      -readonly [K in keyof PreviewAutomationActionEvent]: PreviewAutomationActionEvent[K];
    } = {
      id: NodeCrypto.randomUUID(),
      action,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    pushBounded(tab.actionTimeline, event, ACTION_TIMELINE_LIMIT);
    return run().then(
      (result) => {
        event.status = "succeeded";
        event.completedAt = new Date().toISOString();
        return result;
      },
      (cause: unknown) => {
        event.status = "failed";
        event.completedAt = new Date().toISOString();
        event.error = cause instanceof Error ? cause.message.split("\n")[0] : String(cause);
        throw cause;
      },
    );
  };

  /** Runs an agent's claim on a tab, telling viewers when control moved to the agent. */
  const agentClaim = <A>(tab: ServerTab, claim: () => A): A => {
    const drove = tab.control.agentDrives;
    const generation = tab.control.generation;
    const result = claim();
    if (tab.control.agentDrives !== drove || tab.control.generation !== generation)
      broadcastControl(tab);
    return result;
  };

  /** An agent action; it takes control from a person driving the tab. */
  const agentAction = <A>(tab: ServerTab, agentSessionId: string, run: () => Promise<A>) =>
    agentClaim(tab, () => tab.control.agent(agentSessionId, run));

  const requireTab = async (request: PreviewAutomationRequest) => {
    if (!request.agentSessionId)
      throw new BrowserControlInterrupted("The agent session is missing. Reconnect the provider.");
    const owned = [...tabs.values()].filter(
      (tab) => tab.threadId === request.threadId && tab.control.agentId === request.agentSessionId,
    );
    if (!request.tabIdExplicit && owned.length > 1)
      throw new BrowserControlInterrupted(
        "Multiple tabs belong to this agent session. Pass a tabId from preview_open or preview_status tabs.",
        "tabRequired",
      );
    const tab =
      request.tabId === undefined
        ? latestThreadTab(request.threadId, request.agentSessionId)
        : await Effect.runPromise(
            findTab(request.threadId, request.tabId).pipe(Effect.orElseSucceed(constVoid)),
          );
    if (!tab) {
      throw new ServerBrowserPage.ServerBrowserOperationError(
        "PreviewAutomationTabNotFoundError",
        "No server preview tab is open for this thread. Call preview_open first.",
      );
    }
    // Any tab in the thread can be read; acting is checked by its control.
    if (!READ_OPERATIONS.has(request.operation) && !tab.control.agentMayAct(request.agentSessionId))
      throw new BrowserControlInterrupted(
        "This tab belongs to another agent session. You can read it, but open your own tab to act.",
        "agentMismatch",
      );
    return tab;
  };

  /**
   * Any request, even a failed one, keeps the agent's tabs on the thread from
   * idling out. The tab it targeted becomes the thread's most recently used.
   */
  const markUsed = (request: PreviewAutomationRequest) => {
    const now = Date.now();
    for (const tab of tabs.values()) {
      if (
        tab.threadId === request.threadId &&
        (tab.control.agentId === request.agentSessionId || tab.tabId === request.tabId)
      )
        tab.usedAt = now;
    }
  };

  const runOperation = async (request: PreviewAutomationRequest): Promise<unknown> => {
    const input = request.input;
    switch (request.operation) {
      case "status":
        return statusWithTitle(
          request.tabId === undefined
            ? latestThreadTab(request.threadId, request.agentSessionId)
            : tabs.get(tabKey(request.threadId, request.tabId)),
          request.agentSessionId,
        );
      case "open": {
        if (!request.agentSessionId)
          throw new BrowserControlInterrupted(
            "The agent session is missing. Reconnect the provider.",
          );
        const open = input as PreviewAutomationOpenInput;
        const url = open.url === undefined ? undefined : normalizePreviewUrl(open.url);
        const reuse = open.reuseExistingTab ?? true;
        if (
          reuse &&
          !request.tabIdExplicit &&
          [...tabs.values()].filter(
            (tab) =>
              tab.threadId === request.threadId && tab.control.agentId === request.agentSessionId,
          ).length > 1
        )
          throw new BrowserControlInterrupted(
            "Multiple tabs are open. Pass tabId or reuseExistingTab=false.",
            "tabRequired",
          );
        // A tab still launching exists only as a session, so resolve it like a viewer would.
        const found =
          reuse && request.tabId !== undefined
            ? await Effect.runPromise(
                findTab(request.threadId, request.tabId).pipe(
                  Effect.catchTags({
                    ServerBrowserTabNotFoundError: () => Effect.succeed(undefined),
                  }),
                ),
              )
            : undefined;
        // Only an explicit tabId reuses a tab this session did not open; a tab
        // it last read (such as the user's) is not taken over implicitly.
        const existing =
          found && (request.tabIdExplicit || found.control.agentId === request.agentSessionId)
            ? found
            : undefined;
        const navigationTimeout = Math.min(request.timeoutMs, NAVIGATION_TIMEOUT_MS);
        const profileId = existing ? undefined : resolveOpenProfile(open.profileId);
        if (!existing) {
          closeIdleAgentTabs();
          assertTabCapacity(request.agentSessionId);
        }
        const background = (open.open ?? open.show) === false;
        const backgroundKey = backgroundOpenKey(request.threadId, request.agentSessionId);
        if (!existing && background)
          backgroundOpens.set(backgroundKey, (backgroundOpens.get(backgroundKey) ?? 0) + 1);
        let tab: ServerTab;
        try {
          tab =
            existing ??
            (await ensureTab(
              await Effect.runPromise(
                manager.open({
                  threadId: request.threadId,
                  ...(url ? { url } : {}),
                  ...(profileId === undefined ? {} : { profileId }),
                  runtime: "server",
                  reveal: false,
                  automationOwner: request.agentSessionId,
                }),
              ),
            ));
        } finally {
          if (!existing && background) {
            const remaining = (backgroundOpens.get(backgroundKey) ?? 1) - 1;
            if (remaining > 0) backgroundOpens.set(backgroundKey, remaining);
            else backgroundOpens.delete(backgroundKey);
          }
        }
        if (existing?.dialog)
          throw new BrowserControlInterrupted(
            "A browser dialog is pending. Read preview_status and use preview_dialog first.",
            "dialogPending",
          );
        return agentAction(tab, request.agentSessionId, async () => {
          if (tab.dialog)
            throw new BrowserControlInterrupted(
              "A browser dialog is pending. Read preview_status and use preview_dialog first.",
              "dialogPending",
            );
          if (existing) {
            if (url) await navigate(tab, url, "load", navigationTimeout);
          } else {
            // Await the original navigation failure even though background creation keeps the tab.
            await tab.initialNavigation;
          }
          const reveal = open.open ?? open.show;
          if (reveal !== false) {
            await Effect.runPromise(
              manager.requestReveal({
                threadId: tab.threadId,
                tabId: tab.tabId,
                force: reveal === true,
              }),
            );
          }
          if (!existing && url) {
            await tab.page
              .waitForLoadState("load", { timeout: navigationTimeout })
              .catch(constVoid);
          }
          return statusWithTitle(tab, request.agentSessionId);
        });
      }
      case "recordingStop": {
        if (
          !request.tabIdExplicit &&
          [...tabs.values()].filter(
            (candidate) =>
              candidate.threadId === request.threadId &&
              candidate.control.agentId === request.agentSessionId,
          ).length > 1
        )
          throw new BrowserControlInterrupted(
            "Multiple tabs belong to this agent session. Pass a tabId from preview_open or preview_status tabs.",
            "tabRequired",
          );
        const recordings = [...tabs.values()].filter(
          (candidate) =>
            candidate.threadId === request.threadId &&
            candidate.control.agentMayAct(request.agentSessionId ?? "") &&
            (candidate.recording || candidate.recordingStart),
        );
        const targetTabId =
          request.tabId ?? latestThreadTab(request.threadId, request.agentSessionId)?.tabId;
        const tab =
          recordings.find((candidate) => candidate.tabId === targetTabId) ??
          (!request.tabIdExplicit && recordings.length === 1 ? recordings[0] : undefined);
        if (!tab) {
          throw new ServerBrowserPage.ServerBrowserOperationError(
            "PreviewAutomationRecordingNotActiveError",
            "No recording is active for this thread.",
          );
        }
        return agentAction(tab, request.agentSessionId ?? "", () => stopRecording(tab));
      }
    }
    const tab = await requireTab(request);
    // Closing must unblock an action waiting on a dialog, without queueing behind it.
    if (request.operation === "close") {
      if (tab.control.agentId !== request.agentSessionId)
        throw new BrowserControlInterrupted(
          "Only the agent session that opened this tab can close it.",
          "agentMismatch",
        );
      void tab.control.close().catch(constVoid);
      await Effect.runPromise(manager.close({ threadId: tab.threadId, tabId: tab.tabId }));
      dropTab(tab, false);
      return {};
    }
    // A click can be waiting for its dialog. Resolve it outside the serial queue,
    // taking control like any agent action, so the operation can finish and control can drain.
    if (request.operation === "dialog") {
      agentClaim(tab, () => tab.control.claimAgent(request.agentSessionId ?? ""));
      await resolveDialog(tab, input as PreviewAutomationDialogInput);
      return statusWithTitle(tab, request.agentSessionId);
    }
    const agentSessionId = request.agentSessionId!;
    const result = await runOnTab(tab, request, agentSessionId);
    const summarized = withTabSummary(request.operation, result, tab);
    // A snapshot is where an agent looks at what the page is stuck on.
    if (request.operation !== "snapshot" || typeof summarized !== "object" || summarized === null) {
      return summarized;
    }
    const permissions = await desktopSitePermissions(tab);
    const withTab = summarized as { readonly tab?: PreviewAutomationTabSummary };
    return withTab.tab === undefined
      ? summarized
      : { ...summarized, tab: withPermissionNotice(withTab.tab, permissions) };
  };

  const runOnTab = async (
    tab: ServerTab,
    request: PreviewAutomationRequest,
    agentSessionId: string,
  ): Promise<unknown> => {
    // Acting on a tab never brings the panel back: a person who closed it
    // keeps it closed, and follows along in the floating preview instead.
    // A read of another agent's tab, or of any tab while a person drives it,
    // runs in place: it neither queues behind their input nor takes control.
    // Every other call takes control, and a person taking it back interrupts it.
    if (
      READ_OPERATIONS.has(request.operation) &&
      (tab.control.controller !== null || !tab.control.agentMayAct(agentSessionId))
    ) {
      return tab.control.observe(async () => {
        if (tab.dialog)
          throw new BrowserControlInterrupted(
            "A browser dialog is pending. Read preview_status.",
            "dialogPending",
          );
        return executeTabOperation(tab, request);
      });
    }
    return agentAction(tab, agentSessionId, async () => {
      if (tab.dialog)
        throw new BrowserControlInterrupted(
          "A browser dialog is pending. Read preview_status and use preview_dialog first.",
          "dialogPending",
        );
      const generation = tab.control.generation;
      try {
        return await executeTabOperation(tab, request);
      } finally {
        if (generation !== tab.control.generation) ServerBrowserPage.invalidateRefs(tab.page);
      }
    });
  };

  const executeTabOperation = async (tab: ServerTab, request: PreviewAutomationRequest) => {
    const input = request.input;
    switch (request.operation) {
      case "navigate": {
        const navigateInput = input as PreviewAutomationNavigateInput;
        await recordAction(tab, "navigate", () =>
          navigate(
            tab,
            resolveNavigationUrl(navigateInput),
            navigateInput.readiness ?? "load",
            navigateInput.timeoutMs ?? request.timeoutMs,
          ),
        );
        return statusWithTitle(tab, request.agentSessionId);
      }
      case "resize": {
        const setting = resolvePreviewViewport(input as PreviewAutomationResizeInput);
        await Effect.runPromise(
          manager.resize({ threadId: tab.threadId, tabId: tab.tabId, viewport: setting }),
        );
        await applySetting(tab, setting);
        return {
          tabId: tab.tabId,
          setting,
          viewport: tab.page.viewportSize() ?? UNATTACHED_FILL_VIEWPORT,
        };
      }
      case "permission":
        return decideSitePermission(tab, input as PreviewAutomationPermissionInput);
      case "setColorScheme": {
        const { colorScheme } = input as PreviewAutomationSetColorSchemeInput;
        const snapshot = await Effect.runPromise(
          manager.adjust({ threadId: tab.threadId, tabId: tab.tabId, colorScheme }),
        );
        await applyRendering(tab, snapshot);
        return { tabId: tab.tabId, colorScheme };
      }
      case "snapshot": {
        return withScreencastsPaused(tab, () =>
          ServerBrowserPage.snapshot({ ...tab, renderScale: RENDER_SCALE }),
        );
      }
      case "click": {
        const clickInput = input as PreviewAutomationClickInput;
        await recordAction(tab, "click", () =>
          ServerBrowserPage.click(tab.page, clickInput, pointerFor(tab)),
        );
        return undefined;
      }
      case "hover":
        return recordAction(tab, "hover", () =>
          ServerBrowserPage.hover(tab.page, input as PreviewAutomationHoverInput, pointerFor(tab)),
        );
      case "select":
        return recordAction(tab, "select", () =>
          ServerBrowserPage.select(
            tab.page,
            input as PreviewAutomationSelectInput,
            pointerFor(tab),
          ),
        );
      case "drag":
        return recordAction(tab, "drag", () =>
          ServerBrowserPage.drag(tab.page, input as PreviewAutomationDragInput, pointerFor(tab)),
        );
      case "upload":
        return recordAction(tab, "upload", () =>
          uploadFiles(tab, input as PreviewAutomationUploadInput),
        );
      case "type":
        return recordAction(tab, "type", () =>
          ServerBrowserPage.type(tab.page, input as PreviewAutomationTypeInput, pointerFor(tab)),
        );
      case "press":
        return recordAction(tab, "press", () =>
          ServerBrowserPage.press(tab.page, input as PreviewAutomationPressInput, pointerFor(tab)),
        );
      case "scroll":
        return recordAction(tab, "scroll", () =>
          ServerBrowserPage.scroll(
            tab.page,
            input as PreviewAutomationScrollInput,
            pointerFor(tab),
          ),
        );
      case "evaluate":
        return ServerBrowserPage.evaluate(
          tab.cdp,
          input as PreviewAutomationEvaluateInput,
          request.timeoutMs,
        );
      case "waitFor":
        return ServerBrowserPage.waitFor(tab.page, input as PreviewAutomationWaitForInput);
      case "recordingStart": {
        const recording = await startRecording(tab);
        return { tabId: tab.tabId, recording: true, startedAt: recording.startedAt };
      }
    }
  };

  const handleRequest = (connectionId: string, request: PreviewAutomationRequest) =>
    Effect.tryPromise({
      try: () => runOperation(request).finally(() => markUsed(request)),
      catch: ServerBrowserPage.toOperationError,
    }).pipe(
      Effect.match({
        onSuccess: (result) => ({ ok: true as const, result }),
        onFailure: (error) => ({
          ok: false as const,
          error: {
            _tag: error.tag,
            message: error.message,
            ...(error.detail === undefined ? {} : { detail: error.detail }),
          },
        }),
      }),
      Effect.flatMap((outcome) =>
        broker.respond({
          clientId: SERVER_HOST_CLIENT_ID,
          connectionId,
          requestId: request.requestId,
          ...outcome,
        }),
      ),
      Effect.ignore,
    );

  const mirrorManagerEvent = (event: PreviewEvent) =>
    Effect.promise(async () => {
      if (event.type === "opened" && event.snapshot.runtime === "server") {
        await ensureTab(event.snapshot).catch(constVoid);
        return;
      }
      const key = tabKey(event.threadId, event.tabId);
      const tab = tabs.get(key);
      if (event.type === "closed" && !tab && pendingTabs.has(key)) closedPendingTabs.add(key);
      if (!tab) return;
      if (event.type === "closed") {
        closedSessions.add(key);
        dropTab(tab, false);
        closedSessions.delete(key);
        return;
      }
      // Any client or agent may change these; the page follows what was published.
      if (event.type === "resized") {
        await tab.control
          .system(async () => {
            if (
              !viewportSettingsEqual(event.snapshot.viewport ?? FILL_PREVIEW_VIEWPORT, tab.setting)
            ) {
              await applySetting(tab, event.snapshot.viewport ?? FILL_PREVIEW_VIEWPORT);
            }
            await applyRendering(tab, event.snapshot);
            const request = event.request;
            if (request?.clear === "cookies") await tab.cdp.send("Network.clearBrowserCookies");
            if (request?.clear === "cache") await tab.cdp.send("Network.clearBrowserCache");
            if (request?.hardReload) await tab.cdp.send("Page.reload", { ignoreCache: true });
          })
          .catch((cause: unknown) =>
            runFork(Effect.logWarning("server preview could not apply a tab setting", { cause })),
          );
      }
    });

  const releaseViewerInput = async (viewer: ViewerState, session: CDPSession) => {
    for (const { key, code } of viewer.pressedKeys.values()) {
      await session.send("Input.dispatchKeyEvent", { type: "keyUp", key, code }).catch(constVoid);
    }
    viewer.pressedKeys.clear();
    for (const [button, point] of viewer.pressedButtons) {
      await session
        .send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          button,
          ...point,
          buttons: 0,
          clickCount: 1,
        })
        .catch(constVoid);
    }
    viewer.pressedButtons.clear();
    viewer.requestedSize = null;
  };

  const dispatchViewerInput = async (
    tab: ServerTab,
    session: CDPSession,
    viewer: ViewerState,
    raw: unknown,
  ) => {
    const message = asRecord(raw);
    if (!message) return;
    const modifiers = modifiersOf(message);
    switch (message.type) {
      case "mouse": {
        const action = message.action;
        const type =
          action === "down" ? "mousePressed" : action === "up" ? "mouseReleased" : "mouseMoved";
        const button = ["none", "left", "middle", "right"].includes(String(message.button))
          ? (message.button as "none" | "left" | "middle" | "right")
          : "none";
        await session.send("Input.dispatchMouseEvent", {
          type,
          x: num(message.x),
          y: num(message.y),
          button,
          buttons: num(message.buttons),
          clickCount: num(message.clickCount, type === "mouseMoved" ? 0 : 1),
          modifiers,
        });
        if (button !== "none") {
          if (action === "down")
            viewer.pressedButtons.set(button, { x: num(message.x), y: num(message.y) });
          else if (action === "up") viewer.pressedButtons.delete(button);
        }
        return;
      }
      case "wheel":
        viewer.scrolledAt = Date.now();
        await session.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: num(message.x),
          y: num(message.y),
          deltaX: num(message.deltaX),
          deltaY: num(message.deltaY),
          modifiers,
        });
        return;
      case "key": {
        const key = typeof message.key === "string" ? message.key : "";
        const code = typeof message.code === "string" ? message.code : "";
        const text = typeof message.text === "string" ? message.text : undefined;
        if (message.action === "up") {
          await session.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers });
          viewer.pressedKeys.delete(code || key);
          return;
        }
        const command = editingCommand(key, modifiers);
        // Only the controlling viewer's own copy and cut reach its clipboard.
        const copying =
          !tab.desktop && (command?.commands[0] === "copy" || command?.commands[0] === "cut");
        // Clear what any frame kept from an earlier key, so only this key's copy is read.
        if (copying) await takeCopiedText(tab);
        await session.send("Input.dispatchKeyEvent", {
          type: text ? "keyDown" : "rawKeyDown",
          key,
          code,
          modifiers,
          ...(text ? { text, unmodifiedText: text } : {}),
          ...command,
          windowsVirtualKeyCode: num(
            message.keyCode,
            key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0,
          ),
        });
        viewer.pressedKeys.set(code || key, { key, code });
        if (copying) {
          const copied = await takeCopiedText(tab);
          if (copied) viewer.push({ _tag: "clipboard", text: copied });
        }
        return;
      }
      case "text":
        if (typeof message.text === "string" && message.text.length > 0) {
          await session.send("Input.insertText", { text: message.text.slice(0, 10_000) });
        }
        return;
      case "resize": {
        const width = Math.min(Math.round(num(message.width)), 3840);
        const height = Math.min(Math.round(num(message.height)), 2160);
        if (width < 100 || height < 100) return;
        viewer.requestedSize = { width, height, order: ++viewerResizeOrder };
        if (tab.setting._tag !== "fill" || tab.desktop) return;
        const current = tab.page.viewportSize();
        if (current?.width === width && current.height === height) return;
        await tab.page.setViewportSize({ width, height });
        broadcastViewport(tab);
        return;
      }
      case "viewport": {
        const setting = decodeViewportSetting(message.setting);
        await Effect.runPromise(
          manager.resize({ threadId: tab.threadId, tabId: tab.tabId, viewport: setting }),
        );
        await applySetting(tab, setting);
        return;
      }
      case "navigate":
        if (typeof message.url === "string") {
          const url = normalizePreviewUrl(message.url);
          await tab.page.goto(url, VIEWER_NAVIGATION_OPTIONS);
        }
        return;
      case "history":
        await (num(message.delta) < 0
          ? tab.page.goBack(VIEWER_NAVIGATION_OPTIONS)
          : tab.page.goForward(VIEWER_NAVIGATION_OPTIONS));
        return;
      case "reload":
        // A hard reload fetches everything again, as Chrome's Shift+Reload does.
        if (message.ignoreCache === true) {
          await session.send("Page.reload", { ignoreCache: true });
          return;
        }
        await tab.page.reload(VIEWER_NAVIGATION_OPTIONS);
        return;
      case "probe": {
        const x = num(message.x);
        const y = num(message.y);
        const result = await session.send("Runtime.evaluate", {
          expression: `(${EDITABLE_AT_POINT_SCRIPT})(${x}, ${y})`,
          returnByValue: true,
        });
        viewer.push({ _tag: "probe", x, y, editable: result.result.value === true });
        return;
      }
    }
  };

  /**
   * Answers one element or region commit. Like hover probes this is a read:
   * it runs through `observe`, so picking never needs or takes control, and
   * dispatches no input to the page. The screenshot pauses screencasts like
   * any scaled capture.
   */
  const runPickRequest = async (
    tab: ServerTab,
    session: CDPSession,
    viewer: ViewerState,
    request: ServerBrowserPick.PickRequest,
  ) => {
    if (request.kind === "hitTest") {
      viewer.pickHitTest.request(request.point);
      return;
    }
    try {
      const annotation = await tab.control.observe(() =>
        withScreencastsPaused(tab, () =>
          request.kind === "commit"
            ? ServerBrowserPick.captureElementPick({
                cdp: session,
                page: tab.page,
                point: request.point,
                newId: () => NodeCrypto.randomUUID(),
                nowIso: () => new Date().toISOString(),
              })
            : ServerBrowserPick.captureRegionPick({
                cdp: session,
                page: tab.page,
                rect: request.rect,
                newId: () => NodeCrypto.randomUUID(),
                nowIso: () => new Date().toISOString(),
              }),
        ),
      );
      viewer.push({ _tag: "pickResult", annotation });
    } catch (cause) {
      viewer.push({
        _tag: "pickError",
        message:
          cause instanceof ServerBrowserPick.PickCaptureError
            ? cause.message
            : "The pick failed. Move the pointer and try again.",
      });
    }
  };

  const attachViewer: ServerBrowser["Service"]["attachViewer"] = (input) =>
    Effect.gen(function* () {
      const tab = yield* findTab(input.threadId, input.tabId);
      const output = yield* Queue.make<ServerBrowserViewerOutput>({
        capacity: VIEWER_OUTPUT_LIMIT,
        strategy: "dropping",
      });
      const session = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => tab.page.context().newCDPSession(tab.page),
          catch: (cause) => new ServerBrowserLaunchError({ cause }),
        }),
        (session) =>
          Effect.promise(() =>
            session
              .send("Page.stopScreencast")
              .catch(constVoid)
              .then(() => session.detach())
              .catch(constVoid),
          ),
      );
      const quality = Math.min(100, Math.max(1, Math.round(input.quality)));
      // Chromium may drop the final frame during a burst; send a still when it settles.
      let framesInFlight = 0;
      let mayHaveDropped = false;
      let motion = false;
      const recentFrames: Array<number> = [];
      let screencastParams = Promise.resolve();
      let screencastScale = 1;
      const startScreencast = (scale: number) => {
        screencastScale = scale;
        screencastParams = screencastParams.then(async () => {
          // A scaled capture is rendering; its resume starts the stream.
          if (tab.capturing > 0) return;
          await session.send("Page.stopScreencast").catch(constVoid);
          await session
            .send("Page.startScreencast", {
              format: "jpeg",
              quality: screencastScale < 1 ? Math.min(quality, SCREENCAST_MOTION_QUALITY) : quality,
              maxWidth: Math.max(1, Math.round(input.maxWidth * screencastScale)),
              maxHeight: Math.max(1, Math.round(input.maxHeight * screencastScale)),
            })
            .catch(constVoid);
        });
        return screencastParams;
      };
      const viewerId = NodeCrypto.randomUUID();
      const pushOutput = (next: ServerBrowserViewerOutput) => {
        // Dropped frames must still release Chromium.
        if (Queue.offerUnsafe(output, next)) return;
        if (next._tag === "frame") runFork(next.ack);
        // State a stalled viewer cannot miss replaces its backlog. It runs
        // synchronously so an older replacement can never land after a newer one.
        else if (next._tag === "gone" || next._tag === "control" || next._tag === "fileChooser") {
          const dropped = Effect.runSyncExit(Queue.clear(output));
          if (dropped._tag === "Failure") return;
          Queue.offerUnsafe(output, next);
          // The controller's open picker may have been in the dropped backlog.
          const chooser = next._tag === "control" ? fileChooserMessage(tab) : null;
          if (chooser && tab.control.controller === viewerId) Queue.offerUnsafe(output, chooser);
          for (const item of dropped.value) if (item._tag === "frame") runFork(item.ack);
        }
      };
      const viewer: ViewerState = {
        id: viewerId,
        canOperate: input.canOperate,
        pressedKeys: new Map(),
        pressedButtons: new Map(),
        pickHitTest: ServerBrowserPick.createPickHitTestQueue({
          minIntervalMs: ServerBrowserPick.PICK_HOVER_MIN_INTERVAL_MS,
          now: () => Date.now(),
          sleep: (ms) => sleepUntil(Date.now() + ms),
          // A read, not an action: picking never needs or takes control.
          run: async (point) => {
            try {
              const hover = await tab.control.observe(() =>
                ServerBrowserPick.hitTestElement(session, point),
              );
              pushOutput({ _tag: "pickHover", box: hover.box, label: hover.label });
            } catch {
              pushOutput({ _tag: "pickHover", box: null, label: null });
            }
          },
        }),
        push: pushOutput,
        releaseInput: () => releaseViewerInput(viewer, session),
        pause: () => {
          screencastParams = screencastParams.then(() =>
            session.send("Page.stopScreencast").then(constVoid, constVoid),
          );
          return screencastParams;
        },
        resume: () => startScreencast(screencastScale),
        scrolledAt: 0,
        requestedSize: null,
      };
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          tab.viewers.add(viewer);
          reportLiveTabs();
        }),
        () =>
          Effect.promise(async () => {
            await tab.control.disconnect(viewer.id, () => releaseViewerInput(viewer, session));
            tab.viewers.delete(viewer);
            broadcastControl(tab);
            reportLiveTabs();
          }),
      );
      // A person's tab is theirs when they open it, unless an agent is driving it.
      if (input.canOperate && tab.control.controller === null && !tab.control.agentDrives) {
        yield* Effect.promise(() => tab.control.take(viewer.id));
      }
      broadcastControl(tab);
      pushFileChooser(tab);
      // Full scale: a scaled capture would flash in every other viewer.
      const pushStill = async () => {
        const data = await withCaptureLock(tab, () =>
          ServerBrowserPage.captureViewport(tab.page, session, {
            format: "jpeg",
            quality,
            scale: 1,
          }),
        ).catch(() => null);
        if (data)
          viewer.push({ _tag: "frame", data: Buffer.from(data, "base64"), ack: Effect.void });
      };
      let settleTimer: ReturnType<typeof setTimeout> | null = null;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (settleTimer !== null) clearTimeout(settleTimer);
        }),
      );
      let screencastStarted = false;
      session.on("Page.screencastFrame", (frame) => {
        screencastStarted = true;
        if (framesInFlight > 0) mayHaveDropped = true;
        framesInFlight += 1;
        const arrivedAt = Date.now();
        recentFrames.push(arrivedAt);
        while (recentFrames[0]! < arrivedAt - SCREENCAST_MOTION_WINDOW_MS) recentFrames.shift();
        if (
          !motion &&
          recentFrames.length >= SCREENCAST_MOTION_FRAMES &&
          arrivedAt - viewer.scrolledAt < SCREENCAST_MOTION_WINDOW_MS
        ) {
          motion = true;
          void startScreencast(0.5);
        } else if (motion && arrivedAt - viewer.scrolledAt > SCREENCAST_SETTLE_MS) {
          // The page keeps animating after the scroll; its own frames are sharp again.
          motion = false;
          recentFrames.length = 0;
          void startScreencast(1);
        }
        if (settleTimer !== null) clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
          settleTimer = null;
          if (!motion && !mayHaveDropped) return;
          mayHaveDropped = false;
          if (motion) {
            motion = false;
            recentFrames.length = 0;
            void startScreencast(1);
          }
          void pushStill();
        }, SCREENCAST_SETTLE_MS);
        viewer.push({
          _tag: "frame",
          data: Buffer.from(frame.data, "base64"),
          ack: Effect.promise(() =>
            sleepUntil(arrivedAt + SCREENCAST_ACK_PACE_MS).then(() => {
              framesInFlight -= 1;
              return session
                .send("Page.screencastFrameAck", { sessionId: frame.sessionId })
                .catch(constVoid);
            }),
          ),
        });
      });
      broadcastViewport(tab);
      yield* Effect.promise(() => startScreencast(1));
      // An idle page does not repaint for a new screencast, so the viewer
      // starts from a still unless a live frame beat it.
      if (!screencastStarted) yield* Effect.promise(pushStill);
      return {
        output,
        input: (raw: unknown) =>
          Effect.promise(async () => {
            if (!viewer.canOperate) return;
            const message = asRecord(raw);
            if (!message) return;
            // Picking answers questions about the page without touching
            // control, so it runs before the ownership check below.
            const pick = ServerBrowserPick.describePickRequest(viewer.canOperate, message);
            if (pick.ok) {
              await runPickRequest(tab, session, viewer, pick.request);
              return;
            }
            if (pick.reason === "invalid" && pick.pickType !== "pickHitTest") {
              viewer.push({
                _tag: "pickError",
                message: "That pick was malformed. Move the pointer and try again.",
              });
              return;
            }
            try {
              if (message.type === "takeControl") {
                const taking = tab.control.take(viewer.id);
                broadcastControl(tab);
                await taking;
                pushFileChooser(tab);
              } else if (message.type === "handBack") {
                // Control moves before the drain, so every viewer sees the agent driving at once.
                const handing = tab.control.handBack(viewer.id, () =>
                  releaseViewerInput(viewer, session),
                );
                broadcastControl(tab);
                await handing;
              } else if (
                message.type === "dialog" &&
                tab.control.controller === viewer.id &&
                typeof message.accept === "boolean"
              ) {
                await resolveDialog(tab, {
                  accept: message.accept,
                  ...(typeof message.promptText === "string"
                    ? { promptText: message.promptText }
                    : {}),
                });
              } else if (
                typeof message.type === "string" &&
                VIEWER_PAGE_COMMANDS.has(message.type) &&
                tab.control.controller !== viewer.id
              ) {
                // The toolbar's back, forward, reload, and address bar act like
                // the desktop's own tabs: pressing one takes the page from the agent.
                const running = tab.control.takeAndRun(viewer.id, () =>
                  dispatchViewerInput(tab, session, viewer, message),
                );
                broadcastControl(tab);
                await running;
                pushFileChooser(tab);
              } else {
                await tab.control.human(viewer.id, () =>
                  dispatchViewerInput(tab, session, viewer, message),
                );
              }
            } catch {
              // Rejected ownership cannot mutate the page; refresh the viewer's controls.
              broadcastControl(tab);
            }
          }),
      } satisfies ServerBrowserViewer;
    });

  yield* manager.events.pipe(Stream.runForEach(mirrorManagerEvent), Effect.forkScoped);
  // Whoever runs the server learns the fix before anyone opens a tab.
  if (
    !PreviewBrowserHost.sandboxDisabled(yield* HostProcess.Environment) &&
    (yield* PreviewBrowserHost.sandboxBlocked)
  ) {
    yield* Effect.logWarning(
      `This host blocks the sandbox Cogenly's browser runs in, so browser tabs and HTML previews will not start. Run \`${setupCommand}\` once to allow it.`,
    );
  }
  // The desktop took its page back (closed, swapped, crashed, or devtools opened).
  // The session stays; the next viewer or agent reconnects when it re-attaches.
  yield* desktopChannel.detached.pipe(
    Stream.runForEach((key) =>
      Effect.sync(() => {
        const tab = tabs.get(tabKey(key.threadId, key.tabId));
        if (tab?.desktop) dropTab(tab, false);
      }),
    ),
    Effect.forkScoped,
  );
  // The page came back, for example after its DevTools closed. Reconnect now
  // rather than on the next viewer or agent, or the tab's URL and title stop
  // reaching every client in the meantime.
  //
  // A tab that had to start headless (its thread was not open on the desktop)
  // moves to the desktop's page as soon as it attaches. The headless page has
  // the server's own cookies; left running, the agent would drive a page the
  // user never sees, signed out where the panel is signed in.
  yield* desktopChannel.attached.pipe(
    Stream.runForEach((key) =>
      Effect.gen(function* () {
        const existing = tabs.get(tabKey(key.threadId, key.tabId));
        if (
          existing &&
          !Targeting.shouldMoveToDesktop({ rendersOnDesktop: existing.desktop !== null })
        )
          return;
        if (existing) dropTab(existing, false, "reconnect");
        const { sessions } = yield* manager.list({ threadId: ThreadId.make(key.threadId) });
        const snapshot = sessions.find(
          (session) => session.tabId === key.tabId && session.runtime === "server",
        );
        if (snapshot) yield* Effect.promise(() => ensureTab(snapshot).catch(constVoid));
      }).pipe(Effect.ignore),
    ),
    Effect.forkScoped,
  );
  yield* Effect.sync(closeIdleAgentTabs).pipe(
    Effect.repeat(Schedule.spaced(IDLE_SWEEP_INTERVAL)),
    Effect.forkScoped,
  );
  const environmentId = yield* environment.getEnvironmentId;
  const hostSession = broker
    .connect(
      {
        clientId: SERVER_HOST_CLIENT_ID,
        environmentId,
        supportedOperations: [...PREVIEW_AUTOMATION_SERVER_OPERATIONS],
      },
      { preferred: true },
    )
    .pipe(
      Effect.flatMap((events) =>
        events.pipe(
          Stream.runForEach((event) => {
            if (event.type === "connected") {
              hostConnectionId = event.connectionId;
              return Effect.sync(reportLiveTabs);
            }
            return handleRequest(event.connectionId, event.request).pipe(
              Effect.forkScoped,
              Effect.asVoid,
            );
          }),
        ),
      ),
    );
  // The broker disconnects timed-out hosts, including slow first installs. Reconnect.
  yield* hostSession.pipe(
    Effect.exit,
    Effect.andThen(Effect.sleep(HOST_RECONNECT_DELAY)),
    Effect.forever,
    Effect.forkScoped,
  );
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      await contexts.close();
    }),
  );

  const clearProfile = (profileId: string) =>
    Effect.tryPromise({
      try: () => contexts.clearProfile(profileId),
      catch: (cause) => new PreviewClearProfileError({ profileId, cause }),
    });

  return ServerBrowser.of({
    attachViewer,
    clearProfile,
    reportProfiles,
    reportShown,
    openDownload,
    answerFileChooser,
  });
});

export const layer = Layer.effect(ServerBrowser, make);
