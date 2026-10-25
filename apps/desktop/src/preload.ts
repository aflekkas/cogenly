import type {
  DesktopBridge,
  DesktopPreviewOpenLinkEvent,
  DesktopPreviewPointerEvent,
  DesktopPreviewRecordingInputEvent,
  DesktopPreviewRecordingFrame,
  DesktopPreviewSitePermissionPromptEvent,
  DesktopPreviewTabState,
} from "@cogenly/contracts";
import { exposeClerkBridge } from "@clerk/electron/preload";
import { contextBridge, ipcRenderer, webFrame, webUtils } from "electron";

import * as IpcChannels from "./ipc/channels.ts";
import { mergeLegacyLocalStorage } from "./legacyLocalStorageMerge.ts";

exposeClerkBridge({ passkeys: true });

// Runs before any app script reads localStorage. See DesktopLegacyLocalStorage.
try {
  const legacyItems: unknown = ipcRenderer.sendSync(IpcChannels.TAKE_LEGACY_LOCAL_STORAGE_CHANNEL);
  if (typeof legacyItems === "object" && legacyItems !== null) {
    if (mergeLegacyLocalStorage(window.localStorage, legacyItems as Record<string, string>)) {
      void ipcRenderer.invoke(IpcChannels.COMPLETE_LEGACY_LOCAL_STORAGE_CHANNEL);
    }
  }
} catch {
  // Best effort: the app still starts on the V2 profile's own storage.
}

// oxlint-disable-next-line t3code/no-global-process-runtime -- Electron exposes the client platform in its sandboxed preload process.
const clientPlatform = process.platform;

if (clientPlatform === "darwin") {
  // Native window buttons do not scale with Chromium zoom. Keep their reserved
  // space in native points, including when a zoomed page is reloaded.
  // The buttons start 16pt in (see DesktopWindow) and span 54pt, so they end at
  // 70pt; the inset leaves room for a control beside them.
  const syncWindowControlInset = () => {
    const zoomFactor = webFrame.getZoomFactor();
    const style = document.documentElement.style;
    style.setProperty("--desktop-window-controls-inset", `${90 / zoomFactor}px`);
  };
  window.addEventListener("DOMContentLoaded", syncWindowControlInset, { once: true });
  window.addEventListener("resize", syncWindowControlInset);
}

function unwrapEnsureSshEnvironmentResult(result: unknown) {
  if (
    typeof result === "object" &&
    result !== null &&
    "type" in result &&
    result.type === IpcChannels.SSH_PASSWORD_PROMPT_CANCELLED_RESULT
  ) {
    const message =
      "message" in result && typeof result.message === "string"
        ? result.message
        : "SSH authentication cancelled.";
    throw new Error(message);
  }
  return result as Awaited<ReturnType<DesktopBridge["ensureSshEnvironment"]>>;
}

// Only the main frame gets the bridge: a subframe must never reach desktop IPC.
const isMainFrame = (process as NodeJS.Process & { isMainFrame?: boolean }).isMainFrame === true;

const desktopBridge = {
  getAppBranding: () => {
    const result = ipcRenderer.sendSync(IpcChannels.GET_APP_BRANDING_CHANNEL);
    if (typeof result !== "object" || result === null) {
      return null;
    }
    return result as ReturnType<DesktopBridge["getAppBranding"]>;
  },
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  getClientPlatform: () => clientPlatform,
  setNotificationBadge: (badge) =>
    ipcRenderer.invoke(IpcChannels.SET_NOTIFICATION_BADGE_CHANNEL, badge),
  onNotificationBadgeClear: (listener) => {
    const handler = () => listener();
    ipcRenderer.on(IpcChannels.SET_NOTIFICATION_BADGE_CHANNEL, handler);
    return () => ipcRenderer.removeListener(IpcChannels.SET_NOTIFICATION_BADGE_CHANNEL, handler);
  },
  onTrackpadScrollEnd: (listener) => {
    const handler = () => listener();
    ipcRenderer.on(IpcChannels.TRACKPAD_SCROLL_END_CHANNEL, handler);
    return () => ipcRenderer.removeListener(IpcChannels.TRACKPAD_SCROLL_END_CHANNEL, handler);
  },
  getSystemLocale: () => {
    const result = ipcRenderer.sendSync(IpcChannels.GET_SYSTEM_LOCALE_CHANNEL);
    return typeof result === "string" ? result : null;
  },
  getLocalEnvironmentBootstraps: () => {
    const result = ipcRenderer.sendSync(IpcChannels.GET_LOCAL_ENVIRONMENT_BOOTSTRAPS_CHANNEL);
    if (!Array.isArray(result)) {
      return [];
    }
    return result as ReturnType<DesktopBridge["getLocalEnvironmentBootstraps"]>;
  },
  getLocalEnvironmentBearerToken: () =>
    ipcRenderer.invoke(IpcChannels.GET_LOCAL_ENVIRONMENT_BEARER_TOKEN_CHANNEL),
  getLocalEnvironmentEnabled: () =>
    ipcRenderer.sendSync(IpcChannels.GET_LOCAL_ENVIRONMENT_ENABLED_CHANNEL) !== false,
  setLocalEnvironmentEnabled: (enabled) =>
    ipcRenderer.invoke(IpcChannels.SET_LOCAL_ENVIRONMENT_ENABLED_CHANNEL, enabled),
  getClientSettings: () => ipcRenderer.invoke(IpcChannels.GET_CLIENT_SETTINGS_CHANNEL),
  setClientSettings: (settings) =>
    ipcRenderer.invoke(IpcChannels.SET_CLIENT_SETTINGS_CHANNEL, settings),
  getConnectionCatalog: () => ipcRenderer.invoke(IpcChannels.GET_CONNECTION_CATALOG_CHANNEL),
  setConnectionCatalog: (catalog) =>
    ipcRenderer.invoke(IpcChannels.SET_CONNECTION_CATALOG_CHANNEL, catalog),
  clearConnectionCatalog: () => ipcRenderer.invoke(IpcChannels.CLEAR_CONNECTION_CATALOG_CHANNEL),
  discoverSshHosts: () => ipcRenderer.invoke(IpcChannels.DISCOVER_SSH_HOSTS_CHANNEL),
  resolveSshHost: (alias) => ipcRenderer.invoke(IpcChannels.RESOLVE_SSH_HOST_CHANNEL, alias),
  ensureSshEnvironment: async (target, options) =>
    unwrapEnsureSshEnvironmentResult(
      await ipcRenderer.invoke(IpcChannels.ENSURE_SSH_ENVIRONMENT_CHANNEL, {
        target,
        ...(options === undefined ? {} : { options }),
      }),
    ),
  disconnectSshEnvironment: (target) =>
    ipcRenderer.invoke(IpcChannels.DISCONNECT_SSH_ENVIRONMENT_CHANNEL, target),
  fetchSshEnvironmentDescriptor: (httpBaseUrl) =>
    ipcRenderer.invoke(IpcChannels.FETCH_SSH_ENVIRONMENT_DESCRIPTOR_CHANNEL, { httpBaseUrl }),
  bootstrapSshBearerSession: (httpBaseUrl, credential) =>
    ipcRenderer.invoke(IpcChannels.BOOTSTRAP_SSH_BEARER_SESSION_CHANNEL, {
      httpBaseUrl,
      credential,
    }),
  fetchSshSessionState: (httpBaseUrl, bearerToken) =>
    ipcRenderer.invoke(IpcChannels.FETCH_SSH_SESSION_STATE_CHANNEL, { httpBaseUrl, bearerToken }),
  issueSshWebSocketTicket: (httpBaseUrl, bearerToken) =>
    ipcRenderer.invoke(IpcChannels.ISSUE_SSH_WEBSOCKET_TOKEN_CHANNEL, { httpBaseUrl, bearerToken }),
  onSshPasswordPrompt: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, request: unknown) => {
      if (typeof request !== "object" || request === null) return;
      listener(request as Parameters<typeof listener>[0]);
    };

    ipcRenderer.on(IpcChannels.SSH_PASSWORD_PROMPT_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.SSH_PASSWORD_PROMPT_CHANNEL, wrappedListener);
    };
  },
  resolveSshPasswordPrompt: (requestId, password) =>
    ipcRenderer.invoke(IpcChannels.RESOLVE_SSH_PASSWORD_PROMPT_CHANNEL, { requestId, password }),
  getServerExposureState: () => ipcRenderer.invoke(IpcChannels.GET_SERVER_EXPOSURE_STATE_CHANNEL),
  setServerExposureMode: (mode) =>
    ipcRenderer.invoke(IpcChannels.SET_SERVER_EXPOSURE_MODE_CHANNEL, mode),
  getAdvertisedEndpoints: () => ipcRenderer.invoke(IpcChannels.GET_ADVERTISED_ENDPOINTS_CHANNEL),
  getWslState: () => ipcRenderer.invoke(IpcChannels.GET_WSL_STATE_CHANNEL),
  setWslBackendEnabled: (enabled) =>
    ipcRenderer.invoke(IpcChannels.SET_WSL_BACKEND_ENABLED_CHANNEL, enabled),
  setWslDistro: (distro) => ipcRenderer.invoke(IpcChannels.SET_WSL_DISTRO_CHANNEL, distro),
  setWslOnly: (enabled) => ipcRenderer.invoke(IpcChannels.SET_WSL_ONLY_CHANNEL, enabled),
  pickFolder: (options) => ipcRenderer.invoke(IpcChannels.PICK_FOLDER_CHANNEL, options),
  pickProjectFavicon: (initialPath) =>
    ipcRenderer.invoke(IpcChannels.PICK_PROJECT_FAVICON_CHANNEL, initialPath),
  setTheme: (theme) => ipcRenderer.invoke(IpcChannels.SET_THEME_CHANNEL, theme),
  setAccentColor: (accent) => ipcRenderer.invoke(IpcChannels.SET_ACCENT_COLOR_CHANNEL, accent),
  showContextMenu: (items, position) =>
    ipcRenderer.invoke(IpcChannels.CONTEXT_MENU_CHANNEL, {
      items,
      ...(position === undefined ? {} : { position }),
    }),
  receiveProviderAuthCallback: (url: string) =>
    ipcRenderer.invoke(IpcChannels.RECEIVE_PROVIDER_AUTH_CALLBACK_CHANNEL, url),
  cancelProviderAuthCallback: (url: string) =>
    ipcRenderer.invoke(IpcChannels.CANCEL_PROVIDER_AUTH_CALLBACK_CHANNEL, url),
  openExternal: (url: string) => ipcRenderer.invoke(IpcChannels.OPEN_EXTERNAL_CHANNEL, url),
  checkSystemPermission: (pane: string) =>
    ipcRenderer.invoke(IpcChannels.CHECK_SYSTEM_PERMISSION_CHANNEL, pane),
  openSystemSettings: (pane: string) =>
    ipcRenderer.invoke(IpcChannels.OPEN_SYSTEM_SETTINGS_CHANNEL, pane),
  pasteAsText: () => ipcRenderer.invoke(IpcChannels.PASTE_AS_TEXT_CHANNEL, undefined),
  relaunchApp: () => ipcRenderer.invoke(IpcChannels.RELAUNCH_APP_CHANNEL, undefined),
  ...(clientPlatform === "darwin"
    ? {
        dictation: {
          isAvailable: () => ipcRenderer.invoke(IpcChannels.DICTATION_IS_AVAILABLE_CHANNEL),
          requestMicrophoneAccess: () =>
            ipcRenderer.invoke(IpcChannels.DICTATION_REQUEST_MICROPHONE_CHANNEL),
          startStream: (input) =>
            ipcRenderer.invoke(IpcChannels.DICTATION_STREAM_START_CHANNEL, input),
          // Fire-and-forget: audio arrives about a dozen times a second.
          sendStreamAudio: (requestId, audio) =>
            ipcRenderer.send(IpcChannels.DICTATION_STREAM_AUDIO_CHANNEL, requestId, audio),
          finishStream: (requestId) =>
            ipcRenderer.invoke(IpcChannels.DICTATION_STREAM_FINISH_CHANNEL, requestId),
          onStreamEvent: (listener) => {
            const wrappedListener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
              if (typeof payload !== "object" || payload === null) return;
              listener(payload as Parameters<typeof listener>[0]);
            };
            ipcRenderer.on(IpcChannels.DICTATION_STREAM_EVENT_CHANNEL, wrappedListener);
            return () => {
              ipcRenderer.removeListener(
                IpcChannels.DICTATION_STREAM_EVENT_CHANNEL,
                wrappedListener,
              );
            };
          },
          cancel: (requestId) =>
            ipcRenderer.invoke(IpcChannels.DICTATION_CANCEL_CHANNEL, requestId),
        },
      }
    : {}),
  onMenuAction: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, action: unknown) => {
      if (typeof action !== "string") return;
      listener(action);
    };

    ipcRenderer.on(IpcChannels.MENU_ACTION_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.MENU_ACTION_CHANNEL, wrappedListener);
    };
  },
  onQuitShortcut: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, hint: unknown) => {
      if (typeof hint !== "object" || hint === null || !("state" in hint)) return;
      if (hint.state === "up") {
        listener({ state: "up" });
        return;
      }
      if (
        hint.state === "down" &&
        "mode" in hint &&
        (hint.mode === "hold" || hint.mode === "double-click")
      ) {
        listener({ state: "down", mode: hint.mode });
      }
    };

    ipcRenderer.on(IpcChannels.QUIT_SHORTCUT_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.QUIT_SHORTCUT_CHANNEL, wrappedListener);
    };
  },
  getWindowFullscreenState: () =>
    ipcRenderer.sendSync(IpcChannels.GET_WINDOW_FULLSCREEN_STATE_CHANNEL) === true,
  onWindowFullscreenStateChange: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, fullscreen: unknown) => {
      if (typeof fullscreen !== "boolean") return;
      listener(fullscreen);
    };

    ipcRenderer.on(IpcChannels.WINDOW_FULLSCREEN_STATE_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.WINDOW_FULLSCREEN_STATE_CHANNEL, wrappedListener);
    };
  },
  getUpdateState: () => ipcRenderer.invoke(IpcChannels.UPDATE_GET_STATE_CHANNEL),
  setUpdateChannel: (channel) =>
    ipcRenderer.invoke(IpcChannels.UPDATE_SET_CHANNEL_CHANNEL, channel),
  checkForUpdate: () => ipcRenderer.invoke(IpcChannels.UPDATE_CHECK_CHANNEL),
  downloadUpdate: () => ipcRenderer.invoke(IpcChannels.UPDATE_DOWNLOAD_CHANNEL),
  installUpdate: () => ipcRenderer.invoke(IpcChannels.UPDATE_INSTALL_CHANNEL),
  cliCommand: {
    getState: () => ipcRenderer.invoke(IpcChannels.CLI_COMMAND_GET_STATE_CHANNEL),
    install: (input) => ipcRenderer.invoke(IpcChannels.CLI_COMMAND_INSTALL_CHANNEL, input ?? {}),
    uninstall: () => ipcRenderer.invoke(IpcChannels.CLI_COMMAND_UNINSTALL_CHANNEL),
  },
  onUpdateState: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, state: unknown) => {
      if (typeof state !== "object" || state === null) return;
      listener(state as Parameters<typeof listener>[0]);
    };

    ipcRenderer.on(IpcChannels.UPDATE_STATE_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.UPDATE_STATE_CHANNEL, wrappedListener);
    };
  },
  webLinks: {
    setReady: (ready) => ipcRenderer.invoke(IpcChannels.WEB_LINK_READY_CHANNEL, ready),
    onOpen: (listener) => {
      const wrappedListener = (_event: Electron.IpcRendererEvent, url: unknown) => {
        if (typeof url === "string") listener(url);
      };
      ipcRenderer.on(IpcChannels.WEB_LINK_OPEN_CHANNEL, wrappedListener);
      return () => {
        ipcRenderer.removeListener(IpcChannels.WEB_LINK_OPEN_CHANNEL, wrappedListener);
      };
    },
  },
  appActivation: {
    setReady: (ready) =>
      ipcRenderer.invoke(IpcChannels.DESKTOP_APP_ACTIVATION_READY_CHANNEL, ready),
    complete: (response) =>
      ipcRenderer.invoke(IpcChannels.DESKTOP_APP_ACTIVATION_COMPLETE_CHANNEL, response),
    onRequest: (listener) => {
      const wrappedListener = (_event: Electron.IpcRendererEvent, request: unknown) => {
        if (typeof request !== "object" || request === null) return;
        listener(request as Parameters<typeof listener>[0]);
      };
      ipcRenderer.on(IpcChannels.DESKTOP_APP_ACTIVATION_REQUEST_CHANNEL, wrappedListener);
      return () => {
        ipcRenderer.removeListener(
          IpcChannels.DESKTOP_APP_ACTIVATION_REQUEST_CHANNEL,
          wrappedListener,
        );
      };
    },
  },
  preview: {
    setForwardedShortcuts: (shortcuts) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_SET_FORWARDED_SHORTCUTS_CHANNEL, shortcuts),
    createTab: (tabId, defaults) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_CREATE_TAB_CHANNEL, {
        tabId,
        zoomFactor: defaults?.zoomFactor,
        serverTab: defaults?.serverTab,
        colorScheme: defaults?.colorScheme,
      }),
    closeTab: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_CLOSE_TAB_CHANNEL, { tabId }),
    registerWebview: (tabId, webContentsId) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_REGISTER_WEBVIEW_CHANNEL, { tabId, webContentsId }),
    navigate: (tabId, url) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_NAVIGATE_CHANNEL, { tabId, url }),
    goBack: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_GO_BACK_CHANNEL, { tabId }),
    goForward: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_GO_FORWARD_CHANNEL, { tabId }),
    refresh: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_REFRESH_CHANNEL, { tabId }),
    zoomIn: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_ZOOM_IN_CHANNEL, { tabId }),
    zoomOut: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_ZOOM_OUT_CHANNEL, { tabId }),
    resetZoom: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_RESET_ZOOM_CHANNEL, { tabId }),
    setZoomFactor: (tabId, zoomFactor) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_SET_ZOOM_FACTOR_CHANNEL, { tabId, zoomFactor }),
    hardReload: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_HARD_RELOAD_CHANNEL, { tabId }),
    setColorScheme: (tabId, colorScheme) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_SET_COLOR_SCHEME_CHANNEL, { tabId, colorScheme }),
    setAudioMuted: (tabId, audioMuted) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_SET_AUDIO_MUTED_CHANNEL, { tabId, audioMuted }),
    openDevTools: (tabId) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_OPEN_DEVTOOLS_CHANNEL, { tabId }),
    sitePermissions: {
      get: (tabId) =>
        ipcRenderer.invoke(IpcChannels.PREVIEW_GET_SITE_PERMISSIONS_CHANNEL, { tabId }),
      set: (tabId, permission, setting) =>
        ipcRenderer.invoke(IpcChannels.PREVIEW_SET_SITE_PERMISSION_CHANNEL, {
          tabId,
          permission,
          setting,
        }),
      answer: (tabId, promptId, answer) =>
        ipcRenderer.invoke(IpcChannels.PREVIEW_ANSWER_SITE_PERMISSION_PROMPT_CHANNEL, {
          tabId,
          promptId,
          answer,
        }),
      onPromptChange: (listener) => {
        const wrappedListener = (_event: Electron.IpcRendererEvent, promptEvent: unknown) => {
          if (typeof promptEvent !== "object" || promptEvent === null) return;
          listener(promptEvent as DesktopPreviewSitePermissionPromptEvent);
        };
        ipcRenderer.on(IpcChannels.PREVIEW_SITE_PERMISSION_PROMPT_CHANNEL, wrappedListener);
        return () =>
          ipcRenderer.removeListener(
            IpcChannels.PREVIEW_SITE_PERMISSION_PROMPT_CHANNEL,
            wrappedListener,
          );
      },
    },
    listBrowserImportSources: () => ipcRenderer.invoke(IpcChannels.PREVIEW_IMPORT_SOURCES_CHANNEL),
    importBrowserCookies: (input) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_IMPORT_COOKIES_CHANNEL, input),
    clearCookies: (environmentId, profileId) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_CLEAR_COOKIES_CHANNEL, { environmentId, profileId }),
    clearCache: (environmentId, profileId) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_CLEAR_CACHE_CHANNEL, { environmentId, profileId }),
    getPreviewConfig: (environmentId, profileId) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_GET_CONFIG_CHANNEL, { environmentId, profileId }),
    setAnnotationTheme: (theme) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_SET_ANNOTATION_THEME_CHANNEL, { theme }),
    setAnnotationSendEnabled: (tabId, enabled) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_SET_ANNOTATION_SEND_ENABLED_CHANNEL, {
        tabId,
        enabled,
      }),
    pickElement: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_PICK_ELEMENT_CHANNEL, { tabId }),
    cancelPickElement: (tabId) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_CANCEL_PICK_ELEMENT_CHANNEL, { tabId }),
    captureScreenshot: (tabId) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_CAPTURE_SCREENSHOT_CHANNEL, { tabId }),
    revealArtifact: (path) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_REVEAL_ARTIFACT_CHANNEL, { path }),
    pictureInPicture: {
      open: (tabId) =>
        ipcRenderer.invoke(IpcChannels.PREVIEW_PICTURE_IN_PICTURE_OPEN_CHANNEL, { tabId }),
      close: (tabId) =>
        ipcRenderer.invoke(IpcChannels.PREVIEW_PICTURE_IN_PICTURE_CLOSE_CHANNEL, { tabId }),
    },
    recording: {
      onInput: (listener) => {
        const wrappedListener = (_event: Electron.IpcRendererEvent, event: unknown) => {
          if (typeof event !== "object" || event === null) return;
          listener(event as DesktopPreviewRecordingInputEvent);
        };
        ipcRenderer.on(IpcChannels.PREVIEW_RECORDING_INPUT_CHANNEL, wrappedListener);
        return () =>
          ipcRenderer.removeListener(IpcChannels.PREVIEW_RECORDING_INPUT_CHANNEL, wrappedListener);
      },
      startScreencast: (tabId) =>
        ipcRenderer.invoke(IpcChannels.PREVIEW_RECORDING_START_CHANNEL, { tabId }),
      stopScreencast: (tabId) =>
        ipcRenderer.invoke(IpcChannels.PREVIEW_RECORDING_STOP_CHANNEL, { tabId }),
      save: (tabId, mimeType, data) =>
        ipcRenderer.invoke(IpcChannels.PREVIEW_RECORDING_SAVE_CHANNEL, {
          tabId,
          mimeType,
          data,
        }),
      onFrame: (listener) => {
        const wrappedListener = (_event: Electron.IpcRendererEvent, frame: unknown) => {
          if (typeof frame !== "object" || frame === null) return;
          listener(frame as DesktopPreviewRecordingFrame);
        };
        ipcRenderer.on(IpcChannels.PREVIEW_RECORDING_FRAME_CHANNEL, wrappedListener);
        return () =>
          ipcRenderer.removeListener(IpcChannels.PREVIEW_RECORDING_FRAME_CHANNEL, wrappedListener);
      },
    },
    onStateChange: (listener) => {
      const wrappedListener = (
        _event: Electron.IpcRendererEvent,
        tabId: unknown,
        state: unknown,
      ) => {
        if (typeof tabId !== "string" || typeof state !== "object" || state === null) return;
        listener(tabId, state as DesktopPreviewTabState);
      };
      ipcRenderer.on(IpcChannels.PREVIEW_STATE_CHANGE_CHANNEL, wrappedListener);
      return () =>
        ipcRenderer.removeListener(IpcChannels.PREVIEW_STATE_CHANGE_CHANNEL, wrappedListener);
    },
    onPointerEvent: (listener) => {
      const wrappedListener = (_event: Electron.IpcRendererEvent, pointerEvent: unknown) => {
        if (typeof pointerEvent !== "object" || pointerEvent === null) return;
        listener(pointerEvent as DesktopPreviewPointerEvent);
      };
      ipcRenderer.on(IpcChannels.PREVIEW_POINTER_EVENT_CHANNEL, wrappedListener);
      return () =>
        ipcRenderer.removeListener(IpcChannels.PREVIEW_POINTER_EVENT_CHANNEL, wrappedListener);
    },
    onOpenLink: (listener) => {
      const wrappedListener = (_event: Electron.IpcRendererEvent, linkEvent: unknown) => {
        if (typeof linkEvent !== "object" || linkEvent === null) return;
        listener(linkEvent as DesktopPreviewOpenLinkEvent);
      };
      ipcRenderer.on(IpcChannels.PREVIEW_OPEN_LINK_CHANNEL, wrappedListener);
      return () =>
        ipcRenderer.removeListener(IpcChannels.PREVIEW_OPEN_LINK_CHANNEL, wrappedListener);
    },
  },
} satisfies DesktopBridge;

if (isMainFrame) {
  contextBridge.exposeInMainWorld("desktopBridge", desktopBridge);
}
