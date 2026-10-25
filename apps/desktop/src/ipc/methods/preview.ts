import {
  DesktopPreviewAnnotationSendEnabledInputSchema,
  DesktopPreviewAnnotationThemeInputSchema,
  DesktopPreviewArtifactInputSchema,
  DesktopPreviewConfigInputSchema,
  DesktopPreviewNavigateInputSchema,
  DesktopPreviewRecordingArtifactSchema,
  DesktopPreviewRecordingSaveInputSchema,
  DesktopPreviewRegisterWebviewInputSchema,
  DesktopPreviewScreenshotArtifactSchema,
  DesktopPreviewSetAudioMutedInputSchema,
  DesktopPreviewSetColorSchemeInputSchema,
  DesktopPreviewSetZoomFactorInputSchema,
  BrowserImportResult,
  BrowserImportSource,
  DesktopPreviewClearDataInputSchema,
  DesktopPreviewImportCookiesInputSchema,
  DesktopPreviewCreateTabInputSchema,
  DesktopPreviewTabInputSchema,
  DesktopPreviewWebviewConfigSchema,
  PreviewAnnotationSubmissionResultSchema,
  DEFAULT_BROWSER_PROFILE_ID,
  INCOGNITO_BROWSER_PROFILE_ID,
  PreviewForwardedShortcut,
  MAX_KEYBINDINGS_COUNT,
  DesktopPreviewAnswerSitePermissionPromptInputSchema,
  DesktopPreviewSetSitePermissionInputSchema,
  SITE_PERMISSIONS,
  SitePermissionChangeResult,
  SitePermissionsState,
} from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as NodeURL from "node:url";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as BrowserImport from "../../preview/BrowserImport/BrowserImport.ts";
import * as BrowserSession from "../../preview/BrowserSession.ts";
import * as PreviewManager from "../../preview/Manager.ts";
import * as SitePermissions from "../../preview/SitePermissions.ts";
import { permissionOriginOf } from "../../preview/SitePermissionStore.ts";
import * as DesktopClientSettings from "../../settings/DesktopClientSettings.ts";
import { PREVIEW_WEBVIEW_PREFERENCES } from "../../preview/WebviewPreferences.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const installPreviewEventForwarding = Effect.fn(
  "desktop.ipc.preview.installEventForwarding",
)(function* () {
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const manager = yield* PreviewManager.PreviewManager;
  yield* manager.subscribeStateChanges((tabId, state) =>
    electronWindow.sendAll(IpcChannels.PREVIEW_STATE_CHANGE_CHANNEL, tabId, state),
  );
  yield* manager.subscribeRecordingFrames((frame) =>
    electronWindow.sendAll(IpcChannels.PREVIEW_RECORDING_FRAME_CHANNEL, frame),
  );
  yield* manager.subscribeRecordingInputs((event) =>
    electronWindow.sendAll(IpcChannels.PREVIEW_RECORDING_INPUT_CHANNEL, event),
  );
  yield* manager.subscribePointerEvents((event) =>
    electronWindow.sendAll(IpcChannels.PREVIEW_POINTER_EVENT_CHANNEL, event),
  );
  yield* manager.subscribeOpenLinks((event) =>
    electronWindow.sendAll(IpcChannels.PREVIEW_OPEN_LINK_CHANNEL, event),
  );
  // A permission prompt belongs to the tab whose page asked.
  const { controller } = yield* SitePermissions.SitePermissions;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      controller.onPromptChange(({ webContentsId, prompt }) =>
        runFork(
          manager.tabIdForWebContents(webContentsId).pipe(
            Effect.flatMap((tabId) =>
              tabId === null
                ? Effect.void
                : electronWindow.sendAll(IpcChannels.PREVIEW_SITE_PERMISSION_PROMPT_CHANNEL, {
                    tabId,
                    prompt,
                  }),
            ),
          ),
        ),
      ),
    ),
    (unsubscribe) => Effect.sync(unsubscribe),
  );
});

export const setForwardedShortcuts = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_SET_FORWARDED_SHORTCUTS_CHANNEL,
  payload: Schema.Array(PreviewForwardedShortcut).check(Schema.isMaxLength(MAX_KEYBINDINGS_COUNT)),
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.setForwardedShortcuts")(function* (shortcuts) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.setForwardedShortcuts(shortcuts);
  }),
});

export const createTab = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_CREATE_TAB_CHANNEL,
  payload: DesktopPreviewCreateTabInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.createTab")(function* ({
    tabId,
    zoomFactor,
    colorScheme,
    serverTab,
  }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.createTab(tabId, { zoomFactor, colorScheme, serverTab });
  }),
});

export const closeTab = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_CLOSE_TAB_CHANNEL,
  payload: DesktopPreviewTabInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.closeTab")(function* ({ tabId }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.closeTab(tabId);
  }),
});

export const registerWebview = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_REGISTER_WEBVIEW_CHANNEL,
  payload: DesktopPreviewRegisterWebviewInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.registerWebview")(function* ({ tabId, webContentsId }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.registerWebview(tabId, webContentsId);
  }),
});

export const navigate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_NAVIGATE_CHANNEL,
  payload: DesktopPreviewNavigateInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.navigate")(function* ({ tabId, url }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.navigate(tabId, url);
  }),
});

const tabMethod = (
  channel: string,
  name: string,
  invoke: (
    manager: PreviewManager.PreviewManager["Service"],
    tabId: string,
  ) => Effect.Effect<void, PreviewManager.PreviewManagerError>,
) =>
  DesktopIpc.makeIpcMethod({
    channel,
    payload: DesktopPreviewTabInputSchema,
    result: Schema.Void,
    handler: Effect.fn(name)(function* ({ tabId }) {
      const manager = yield* PreviewManager.PreviewManager;
      yield* invoke(manager, tabId);
    }),
  });

export const goBack = tabMethod(
  IpcChannels.PREVIEW_GO_BACK_CHANNEL,
  "desktop.ipc.preview.goBack",
  (manager, tabId) => manager.goBack(tabId),
);
export const goForward = tabMethod(
  IpcChannels.PREVIEW_GO_FORWARD_CHANNEL,
  "desktop.ipc.preview.goForward",
  (manager, tabId) => manager.goForward(tabId),
);
export const refresh = tabMethod(
  IpcChannels.PREVIEW_REFRESH_CHANNEL,
  "desktop.ipc.preview.refresh",
  (manager, tabId) => manager.refresh(tabId),
);
export const zoomIn = tabMethod(
  IpcChannels.PREVIEW_ZOOM_IN_CHANNEL,
  "desktop.ipc.preview.zoomIn",
  (manager, tabId) => manager.zoomIn(tabId),
);
export const zoomOut = tabMethod(
  IpcChannels.PREVIEW_ZOOM_OUT_CHANNEL,
  "desktop.ipc.preview.zoomOut",
  (manager, tabId) => manager.zoomOut(tabId),
);
export const resetZoom = tabMethod(
  IpcChannels.PREVIEW_RESET_ZOOM_CHANNEL,
  "desktop.ipc.preview.resetZoom",
  (manager, tabId) => manager.resetZoom(tabId),
);
export const hardReload = tabMethod(
  IpcChannels.PREVIEW_HARD_RELOAD_CHANNEL,
  "desktop.ipc.preview.hardReload",
  (manager, tabId) => manager.hardReload(tabId),
);
export const setZoomFactor = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_SET_ZOOM_FACTOR_CHANNEL,
  payload: DesktopPreviewSetZoomFactorInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.setZoomFactor")(function* ({ tabId, zoomFactor }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.setZoomFactor(tabId, zoomFactor);
  }),
});
export const setColorScheme = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_SET_COLOR_SCHEME_CHANNEL,
  payload: DesktopPreviewSetColorSchemeInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.setColorScheme")(function* ({ tabId, colorScheme }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.setColorScheme(tabId, colorScheme);
  }),
});
export const setAudioMuted = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_SET_AUDIO_MUTED_CHANNEL,
  payload: DesktopPreviewSetAudioMutedInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.setAudioMuted")(function* ({ tabId, audioMuted }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.setAudioMuted(tabId, audioMuted);
  }),
});
export const openDevTools = tabMethod(
  IpcChannels.PREVIEW_OPEN_DEVTOOLS_CHANNEL,
  "desktop.ipc.preview.openDevTools",
  (manager, tabId) => manager.openDevTools(tabId),
);
export const cancelPickElement = tabMethod(
  IpcChannels.PREVIEW_CANCEL_PICK_ELEMENT_CHANNEL,
  "desktop.ipc.preview.cancelPickElement",
  (manager, tabId) => manager.cancelPickElement(tabId),
);
export const startRecording = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_RECORDING_START_CHANNEL,
  payload: DesktopPreviewTabInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.startRecording")(function* ({ tabId }) {
    const manager = yield* PreviewManager.PreviewManager;
    const store = yield* DesktopClientSettings.DesktopClientSettings;
    const settings = yield* store.get;
    const options = Option.map(settings, (value) => ({
      showKeyPresses: value.browserRecordingShowKeyPresses,
      showMousePresses: value.browserRecordingShowMousePresses,
    }));
    yield* manager.startRecording(tabId, Option.getOrUndefined(options));
  }),
});
export const stopRecording = tabMethod(
  IpcChannels.PREVIEW_RECORDING_STOP_CHANNEL,
  "desktop.ipc.preview.stopRecording",
  (manager, tabId) => manager.stopRecording(tabId),
);
export const openPictureInPicture = tabMethod(
  IpcChannels.PREVIEW_PICTURE_IN_PICTURE_OPEN_CHANNEL,
  "desktop.ipc.preview.openPictureInPicture",
  (manager, tabId) => manager.openPictureInPicture(tabId),
);
export const closePictureInPicture = tabMethod(
  IpcChannels.PREVIEW_PICTURE_IN_PICTURE_CLOSE_CHANNEL,
  "desktop.ipc.preview.closePictureInPicture",
  (manager, tabId) => manager.closePictureInPicture(tabId),
);

export const clearCookies = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_CLEAR_COOKIES_CHANNEL,
  payload: DesktopPreviewClearDataInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.clearCookies")(function* ({ environmentId, profileId }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.clearCookies(yield* resolveClearPartitions(manager, environmentId, profileId));
  }),
});

export const clearCache = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_CLEAR_CACHE_CHANNEL,
  payload: DesktopPreviewClearDataInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.clearCache")(function* ({ environmentId, profileId }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.clearCache(yield* resolveClearPartitions(manager, environmentId, profileId));
  }),
});

/**
 * Partition scope for an (environment, profile) pair.
 *
 * The default profile keeps the bare environment id it used before profiles
 * existed, so upgrading does not strand anyone's existing logins in an
 * orphaned partition. Incognito derives a non-persistent partition.
 */
export function resolvePartitionScope(
  environmentId: string,
  profileId: string | undefined,
): {
  readonly scope: string;
  readonly persistent: boolean;
  readonly namespace?: "profile";
} {
  if (profileId === undefined || profileId === DEFAULT_BROWSER_PROFILE_ID) {
    return { scope: environmentId, persistent: true };
  }
  // JSON's tuple framing is injective for strings, including lone UTF-16
  // surrogates (which it escapes). URI encoding throws on those supported ids,
  // while replacing them with U+FFFD would collapse distinct identities.
  return {
    scope: JSON.stringify([environmentId, profileId]),
    persistent: profileId !== INCOGNITO_BROWSER_PROFILE_ID,
    namespace: "profile" as const,
  };
}

/**
 * Clearing without a profile keeps the historical "everything" behaviour for
 * an explicit all-profiles action; naming a profile confines it to that
 * profile's partition so one profile's sign-out cannot reach the others.
 */
const resolveClearPartitions = Effect.fn("desktop.ipc.preview.resolveClearPartitions")(function* (
  manager: PreviewManager.PreviewManager["Service"],
  environmentId: string,
  profileId: string | undefined,
) {
  if (profileId === undefined) return undefined;
  const { scope, persistent, namespace } = resolvePartitionScope(environmentId, profileId);
  // Loading the session is what puts the partition in the map the clear walks.
  // Deriving the partition string alone leaves nothing to match, so clearing a
  // profile with no tab open this run — after a restart, or when deleting a
  // profile — would report success and delete nothing.
  yield* manager.getBrowserSession(scope, persistent, namespace);
  return [yield* manager.getBrowserPartition(scope, persistent, namespace)];
});

export const getPreviewConfig = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_GET_CONFIG_CHANNEL,
  payload: DesktopPreviewConfigInputSchema,
  result: DesktopPreviewWebviewConfigSchema,
  handler: Effect.fn("desktop.ipc.preview.getConfig")(function* ({ environmentId, profileId }) {
    const manager = yield* PreviewManager.PreviewManager;
    const { scope, persistent, namespace } = resolvePartitionScope(environmentId, profileId);
    // Creating the session first is what installs the UA rewrite and permission
    // handlers; a guest that attached to an untouched partition would run with
    // Electron's default UA and Chromium's default permission behaviour.
    yield* manager.getBrowserSession(scope, persistent, namespace);
    return {
      partition: yield* manager.getBrowserPartition(scope, persistent, namespace),
      webPreferences: PREVIEW_WEBVIEW_PREFERENCES,
      preloadUrl: NodeURL.pathToFileURL(`${__dirname}/preview-pick-preload.cjs`).href,
    };
  }),
});

/**
 * Registered separately from `methods`: these carry `BrowserImport` in their
 * context and their own failure type, so they do not unify with the
 * manager-backed handlers the shared loop iterates.
 */
export const listBrowserImportSources = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_IMPORT_SOURCES_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(BrowserImportSource),
  handler: Effect.fn("desktop.ipc.preview.listBrowserImportSources")(function* () {
    const browserImport = yield* BrowserImport.BrowserImport;
    return yield* browserImport.listSources;
  }),
});

export const importBrowserCookies = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_IMPORT_COOKIES_CHANNEL,
  payload: DesktopPreviewImportCookiesInputSchema,
  result: BrowserImportResult,
  handler: Effect.fn("desktop.ipc.preview.importBrowserCookies")(function* ({
    environmentId,
    ...importInput
  }) {
    const browserImport = yield* BrowserImport.BrowserImport;
    // Derived in main from the same helper the webview config uses, so cookies
    // land in exactly the partition the profile's tabs attach to.
    const { scope, persistent, namespace } = resolvePartitionScope(
      environmentId,
      importInput.targetProfileId,
    );
    return yield* browserImport.importCookies({
      input: importInput,
      scope,
      persistent,
      ...(namespace === undefined ? {} : { namespace }),
    });
  }),
});

/**
 * The tab's page and the permission desk for its browser profile. Registered
 * separately from `methods` for the same reason as the import handlers: their
 * context carries the session and permission services.
 */
const withSiteContext = Effect.fn("desktop.ipc.preview.withSiteContext")(function* (tabId: string) {
  const manager = yield* PreviewManager.PreviewManager;
  const browserSession = yield* BrowserSession.BrowserSession;
  const { controller } = yield* SitePermissions.SitePermissions;
  const guest = yield* manager.requireWebContents(tabId);
  return { controller, guest, partition: browserSession.partitionOf(guest.session) };
});

const noSitePermissions = {
  origin: null,
  entries: SITE_PERMISSIONS.map((permission) => ({ permission, setting: "ask" as const })),
  prompt: null,
};

export const getSitePermissions = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_GET_SITE_PERMISSIONS_CHANNEL,
  payload: DesktopPreviewTabInputSchema,
  result: SitePermissionsState,
  handler: Effect.fn("desktop.ipc.preview.getSitePermissions")(function* ({ tabId }) {
    return yield* withSiteContext(tabId).pipe(
      Effect.map(({ controller, guest, partition }) =>
        partition === undefined
          ? noSitePermissions
          : controller.state(partition, guest.id, guest.getURL()),
      ),
      // A tab whose page is not attached yet has no site to decide for.
      Effect.orElseSucceed(() => noSitePermissions),
    );
  }),
});

export const setSitePermission = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_SET_SITE_PERMISSION_CHANNEL,
  payload: DesktopPreviewSetSitePermissionInputSchema,
  result: SitePermissionChangeResult,
  handler: Effect.fn("desktop.ipc.preview.setSitePermission")(function* ({
    tabId,
    permission,
    setting,
  }) {
    const { controller, guest, partition } = yield* withSiteContext(tabId);
    if (partition === undefined) {
      return { ok: false as const, reason: "unknown-tab" as const, state: null };
    }
    const origin = permissionOriginOf(guest.getURL());
    const stateOf = () => controller.state(partition, guest.id, guest.getURL());
    if (origin === null) {
      return { ok: false as const, reason: "no-origin" as const, state: stateOf() };
    }
    // The person's own choice, so it replaces whatever an agent decided.
    const change = controller.change(partition, origin, permission, setting, "user");
    return change.ok
      ? { ok: true as const, state: stateOf() }
      : { ok: false as const, reason: change.reason, state: stateOf() };
  }),
});

export const answerSitePermissionPrompt = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_ANSWER_SITE_PERMISSION_PROMPT_CHANNEL,
  payload: DesktopPreviewAnswerSitePermissionPromptInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.answerSitePermissionPrompt")(function* ({
    tabId,
    promptId,
    answer,
  }) {
    const { controller, guest } = yield* withSiteContext(tabId);
    controller.answer(guest.id, promptId, answer);
  }),
});

export const setAnnotationTheme = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_SET_ANNOTATION_THEME_CHANNEL,
  payload: DesktopPreviewAnnotationThemeInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.setAnnotationTheme")(function* ({ theme }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.setAnnotationTheme(theme);
  }),
});

export const pickElement = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_PICK_ELEMENT_CHANNEL,
  payload: DesktopPreviewTabInputSchema,
  result: Schema.NullOr(PreviewAnnotationSubmissionResultSchema),
  handler: Effect.fn("desktop.ipc.preview.pickElement")(function* ({ tabId }) {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* manager.pickElement(tabId);
  }),
});

export const setAnnotationSendEnabled = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_SET_ANNOTATION_SEND_ENABLED_CHANNEL,
  payload: DesktopPreviewAnnotationSendEnabledInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.setAnnotationSendEnabled")(function* ({
    tabId,
    enabled,
  }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.setAnnotationSendEnabled(tabId, enabled);
  }),
});

export const captureScreenshot = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_CAPTURE_SCREENSHOT_CHANNEL,
  payload: DesktopPreviewTabInputSchema,
  result: DesktopPreviewScreenshotArtifactSchema,
  handler: Effect.fn("desktop.ipc.preview.captureScreenshot")(function* ({ tabId }) {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* manager.captureScreenshot(tabId);
  }),
});

export const revealArtifact = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_REVEAL_ARTIFACT_CHANNEL,
  payload: DesktopPreviewArtifactInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.revealArtifact")(function* ({ path }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.revealArtifact(path);
  }),
});

export const saveRecording = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_RECORDING_SAVE_CHANNEL,
  payload: DesktopPreviewRecordingSaveInputSchema,
  result: DesktopPreviewRecordingArtifactSchema,
  handler: Effect.fn("desktop.ipc.preview.saveRecording")(function* ({ tabId, mimeType, data }) {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* manager.saveRecording(tabId, mimeType, data);
  }),
});

export const methods = [
  setForwardedShortcuts,
  createTab,
  closeTab,
  registerWebview,
  navigate,
  goBack,
  goForward,
  refresh,
  zoomIn,
  zoomOut,
  resetZoom,
  hardReload,
  setColorScheme,
  setZoomFactor,
  setAudioMuted,
  openDevTools,
  clearCookies,
  clearCache,
  getPreviewConfig,
  setAnnotationTheme,
  setAnnotationSendEnabled,
  pickElement,
  cancelPickElement,
  captureScreenshot,
  revealArtifact,
  openPictureInPicture,
  closePictureInPicture,
  startRecording,
  stopRecording,
  saveRecording,
] as const;
