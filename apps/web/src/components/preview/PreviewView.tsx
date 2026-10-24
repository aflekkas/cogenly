"use client";

import { scopedThreadKey } from "@cogenly/client-runtime/environment";
import { previewStreamDownloadUrl } from "@cogenly/client-runtime/preview/server-browser-stream";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@cogenly/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  DEFAULT_BROWSER_PROFILE_ID,
  FILL_PREVIEW_VIEWPORT,
  type PreviewAnnotationPayload,
  type PreviewAnnotationSubmission,
  type PreviewViewportSetting,
  type ScopedThreadRef,
  DEFAULT_PREVIEW_ZOOM_FACTOR,
  PREVIEW_ZOOM_LEVELS,
  type PreviewAdjustInput,
} from "@cogenly/contracts";
import { normalizePreviewUrl, resolveAddressBarInput } from "@cogenly/shared/preview";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT,
  recordVisitForThread,
  removeUrlForThread,
  setTitleForThreadUrl,
  useThreadRecentHistory,
} from "~/browserHistoryStore";
import {
  type ComposerImageAttachment,
  useComposerDraftStore,
  useComposerPreviewAnnotations,
} from "~/composerDraftStore";
import { capturePreviewAnnotationScreenshot } from "~/lib/previewAnnotation";
import { ensureLocalApi } from "~/localApi";
import {
  rememberPreviewUrl,
  updatePreviewServerSnapshot,
  useThreadPreviewState,
} from "~/previewStateStore";
import { resolveDiscoveredServerUrl } from "~/browser/browserTargetResolver";
import { useEnvironmentSupportsServerBrowser } from "~/state/entities";
import {
  useEnvironment,
  useEnvironmentHttpBaseUrl,
  useEnvironmentMachines,
  usePrimaryEnvironmentId,
} from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { usePreviewStreamAccess } from "~/state/previewStream";
import { useAtomCommand } from "~/state/use-atom-command";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { useRightPanelStore } from "~/rightPanelStore";

import { previewBridge } from "./previewBridge";
import { subscribePreviewAction } from "./previewActionBus";
import { closePreviewSession } from "./closePreviewSession";
import { openPreviewSession } from "./openPreviewSession";
import { showPreviewPopup } from "./showPreviewPopup";
import { PreviewChromeRow } from "./PreviewChromeRow";
import { PreviewEmptyState } from "./PreviewEmptyState";
import { PreviewMoreMenu, type PreviewMoreMenuActions } from "./PreviewMoreMenu";
import { PreviewMachineChip } from "./PreviewMachineChip";
import { resolvePreviewMachine } from "./previewMachine";
import {
  commitBrowserViewportChange,
  subscribeBrowserViewportChange,
} from "~/browser/browserViewportActions";
import { browserResponsiveViewportForToggle, useBrowserDefaults } from "~/browser/browserDefaults";
import { previewAppearanceKey, usePreviewAppearanceStore } from "~/browser/previewAppearanceStore";
import { useTheme } from "~/hooks/useTheme";
import { BrowserDeviceToolbar } from "~/browser/BrowserDeviceToolbar";
import { BROWSER_DEVICE_TOOLBAR_HEIGHT } from "~/browser/browserViewportLayout";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { BrowserSettingsReadError } from "~/browser/openFileInPreview";
import { PreviewFileNotShown, PreviewUnreachable } from "./PreviewUnreachable";
import { revealInFileExplorerLabel } from "./fileExplorerLabel";
import { shouldShowPreviewEmptyState } from "./previewEmptyStateLogic";
import { Badge } from "~/components/ui/badge";
import { BrowserSurfaceSlot } from "~/browser/BrowserSurfaceSlot";
import { alternatePreviewRuntime, useRendersServerTabNatively } from "~/browser/previewRuntime";
import type { PreviewStreamControl } from "@cogenly/client-runtime/preview/server-browser-stream";
import { ServerBrowserSurface, type ServerBrowserHandle } from "~/browser/ServerBrowserSurface";
import { pickMarkers } from "~/browser/serverBrowserPick";
import { cn } from "~/lib/utils";
import { useBrowserSurfaceStore } from "~/browser/browserSurfaceStore";
import { showBrowserTabInPanel } from "./floatingBrowserPreviewStore";
import { usePreviewSession } from "./usePreviewSession";
import { useSitePermissions } from "./useSitePermissions";
import { PreviewPermissionPrompt } from "./PreviewPermissionPrompt";
import { ZoomIndicator } from "./ZoomIndicator";
import { AgentBrowserCursor } from "./AgentBrowserCursor";
import {
  findActiveBrowserRecordingRuntimeTabId,
  isBrowserRecordingStartCancelledError,
  startBrowserRecording,
  stopBrowserRecording,
  useActiveBrowserRecordingTabIds,
} from "~/browser/browserRecording";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { COPY_FEEDBACK_MS, createCopyFeedback } from "~/hooks/copyFeedback.logic";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { observeResize } from "~/lib/observeResize";

interface Props {
  threadRef: ScopedThreadRef;
  tabId?: string | null;
  configuredUrls?: ReadonlyArray<string> | undefined;
  visible: boolean;
  onSendAnnotation?: (
    annotation: PreviewAnnotationPayload,
    image: ComposerImageAttachment | null,
  ) => void;
}

function previewProfileName(
  profiles: ReadonlyArray<{ readonly id: string; readonly name: string }>,
  profileId: string,
): string {
  return profiles.find((profile) => profile.id === profileId)?.name ?? "Removed profile";
}

const localApi = typeof window === "undefined" ? null : ensureLocalApi();

/** The "Screenshot saved" toast still on screen, so back-to-back captures share it. */
let openScreenshotToast: {
  readonly id: ReturnType<typeof toastManager.add>;
  count: number;
} | null = null;

function screenshotToastTitle(count: number): string {
  return count > 1 ? `${count} screenshots saved` : "Screenshot saved";
}

/** Resolves stream access only while a server tab shows a file it downloaded. */
function ServerTabFileNotShown(props: {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly url: string;
  readonly download: { readonly id: string; readonly fileName: string };
}) {
  const access = usePreviewStreamAccess(props.threadRef.environmentId);
  return (
    <PreviewFileNotShown
      url={props.url}
      fileName={props.download.fileName}
      downloadUrl={
        access
          ? previewStreamDownloadUrl(
              { access, threadId: props.threadRef.threadId, tabId: props.tabId },
              props.download.id,
            )
          : null
      }
      onOpen={() => void localApi?.shell.openExternal(props.url).catch(() => undefined)}
    />
  );
}

/**
 * Single-tab preview surface: chrome row on top, one webview below, empty
 * state when no session exists for the thread.
 */
export function PreviewView({
  threadRef,
  tabId: requestedTabId,
  configuredUrls,
  visible,
  onSendAnnotation,
}: Props) {
  const [focusUrlNonce, setFocusUrlNonce] = useState<number | undefined>(undefined);
  const [pickActive, setPickActive] = useState(false);
  const canSendAnnotation =
    useEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope) &&
    Boolean(onSendAnnotation);
  const activeRecordingTabIds = useActiveBrowserRecordingTabIds();
  const pickActiveRef = useRef<{ cancelled: boolean } | null>(null);
  const isMountedRef = useRef(true);
  // Kept in sync so the title effect can depend on the stable thread key
  // instead of the thread object, which is recreated on every update.
  const threadRefRef = useRef(threadRef);
  threadRefRef.current = threadRef;
  const previewState = useThreadPreviewState(threadRef);
  const recentHistoryEntries = useThreadRecentHistory(
    threadRef,
    BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT,
  );
  const addPreviewAnnotation = useComposerDraftStore((store) => store.addPreviewAnnotation);
  const addImage = useComposerDraftStore((store) => store.addImage);
  const environmentHttpBaseUrl = useEnvironmentHttpBaseUrl(threadRef.environmentId);
  const environmentHostname = environmentHttpBaseUrl
    ? new URL(environmentHttpBaseUrl).hostname
    : null;
  const open = useAtomCommand(previewEnvironment.open);
  const closePreview = useAtomCommand(previewEnvironment.close, "preview close");
  const threadEnvironment = useEnvironment(threadRef.environmentId);
  const environmentLabel = threadEnvironment?.label ?? "the environment";
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryEnvironment = useEnvironment(primaryEnvironmentId);
  const environmentMachines = useEnvironmentMachines();
  const serverBrowser = useEnvironmentSupportsServerBrowser(threadRef.environmentId);
  const resize = useAtomCommand(previewEnvironment.resize, "preview viewport resize");
  const adjust = useAtomCommand(previewEnvironment.adjust, "preview appearance or zoom");

  usePreviewSession(threadRef);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const tabId = requestedTabId ?? previewState.activeTabId;
  const runtimeTabId = tabId
    ? previewRuntimeTabId(threadRef, previewState.serverEpoch, tabId)
    : null;
  const recordingRuntimeTabId =
    tabId && runtimeTabId
      ? activeRecordingTabIds.has(runtimeTabId)
        ? runtimeTabId
        : findActiveBrowserRecordingRuntimeTabId(threadRef, tabId)
      : null;
  const snapshot = tabId ? (previewState.sessions[tabId] ?? null) : null;
  // Server tabs run in the environment's browser and stream to any client, except the
  // desktop app's own server's tabs, which render here natively while the server drives them.
  const nativeServerTab = useRendersServerTabNatively(threadRef.environmentId, snapshot);
  const isServerTab = snapshot?.runtime === "server" && !nativeServerTab;
  /** The server owns this tab's appearance, zoom, and size, whoever renders it. */
  const serverOwnsRendering = snapshot?.runtime === "server";
  const previewMachine = resolvePreviewMachine({
    // Tabs from before server tabs carry no runtime; they are desktop tabs.
    runtime: snapshot ? (snapshot.runtime ?? "desktop") : undefined,
    threadEnvironment: threadEnvironment
      ? {
          label: threadEnvironment.label,
          machine: environmentMachines.get(threadRef.environmentId) ?? "server",
        }
      : null,
    threadIsPrimary: threadRef.environmentId === primaryEnvironmentId,
    primaryEnvironment:
      primaryEnvironment && primaryEnvironmentId
        ? {
            label: primaryEnvironment.label,
            machine: environmentMachines.get(primaryEnvironmentId) ?? "laptop",
          }
        : null,
    rendersDesktopTabs: previewBridge !== null,
    environmentCount: environmentMachines.size,
  });
  const serverSurfaceRef = useRef<ServerBrowserHandle | null>(null);
  const [serverAspectRatioLocked, setServerAspectRatioLocked] = useState(false);
  const serverBodyRef = useRef<HTMLDivElement | null>(null);
  const [serverToolbarWidth, setServerToolbarWidth] = useState(0);
  // The streamed tab's device toolbar spans the panel; only measured while it shows.
  const serverToolbarShown =
    snapshot?.runtime === "server" && (snapshot.viewport ?? FILL_PREVIEW_VIEWPORT)._tag !== "fill";
  useEffect(() => {
    const element = serverBodyRef.current;
    if (!element || !serverToolbarShown) return;
    return observeResize(element, ([entry]) =>
      setServerToolbarWidth(Math.max(1, Math.round(entry?.contentRect.width ?? 0))),
    );
  }, [serverToolbarShown]);
  const [serverControl, setServerControl] = useState<{
    tabId: string;
    control: PreviewStreamControl;
  } | null>(null);
  const [serverFrameTabId, setServerFrameTabId] = useState<string | null>(null);
  const serverTabControl =
    isServerTab && serverControl?.tabId === runtimeTabId ? serverControl.control : null;
  // Back, forward, reload, and the address bar work for anyone who may operate
  // the page, even while the agent drives: the server takes control for them
  // first, as Take control would.
  const serverInputDisabled = isServerTab && serverTabControl?.canOperate !== true;
  // Picking reads the page without driving it, so it needs operate rights, not control.
  const serverPickBlocker = !isServerTab
    ? null
    : !serverTabControl
      ? "Connecting to the browser…"
      : !serverTabControl.canOperate
        ? "You can watch this tab but not annotate it"
        : serverTabControl.capabilities?.pick !== true
          ? `${environmentLabel}'s browser can't annotate pages yet`
          : null;
  /** The server tab in pick mode; mode belongs to one tab and ends when it stops being pickable. */
  const [serverPickTabId, setServerPickTabId] = useState<string | null>(null);
  const [pickNotice, setPickNotice] = useState<{
    readonly message: string;
    readonly leaving: boolean;
  } | null>(null);
  useEffect(() => {
    if (!pickNotice) return;
    // Reads, then fades out over the base motion duration before it unmounts.
    const timer = setTimeout(
      () =>
        pickNotice.leaving ? setPickNotice(null) : setPickNotice({ ...pickNotice, leaving: true }),
      pickNotice.leaving ? 220 : 4_000,
    );
    return () => clearTimeout(timer);
  }, [pickNotice]);
  const previewAnnotations = useComposerPreviewAnnotations(threadRef);
  const desktopOverlay = tabId ? (previewState.desktopByTabId[tabId] ?? null) : null;
  const navStatus = snapshot?.navStatus ?? { _tag: "Idle" as const };
  const url = navStatus._tag === "Idle" ? "" : navStatus.url;
  const loading = desktopOverlay?.loading ?? navStatus._tag === "Loading";
  const canGoBack = desktopOverlay?.canGoBack ?? snapshot?.canGoBack ?? false;
  const canGoForward = desktopOverlay?.canGoForward ?? snapshot?.canGoForward ?? false;
  const refreshDisabled = navStatus._tag === "Idle";
  const isUnreachable = navStatus._tag === "LoadFailed";
  const showEmptyState = shouldShowPreviewEmptyState(snapshot);
  const serverStreamPending =
    isServerTab && !showEmptyState && !isUnreachable && serverFrameTabId !== runtimeTabId;
  const controller = desktopOverlay?.controller ?? "none";
  // Camera, microphone, location and the like are decided for the page the
  // desktop renders; a streamed server tab runs in the environment's browser.
  const sitePermissions = useSitePermissions(
    !isServerTab && desktopOverlay?.hasWebContents === true ? runtimeTabId : null,
  );
  const sitePermissionActions = sitePermissions.available
    ? { read: sitePermissions.read, change: sitePermissions.change }
    : undefined;
  const serverPickMarkers = useMemo(
    () => (isServerTab ? pickMarkers(previewAnnotations, url) : []),
    [isServerTab, previewAnnotations, url],
  );
  const serverPickAvailable = serverPickBlocker === null && !isUnreachable && !showEmptyState;
  const serverPickActive =
    serverPickAvailable && runtimeTabId !== null && serverPickTabId === runtimeTabId;
  const viewport = snapshot?.viewport ?? FILL_PREVIEW_VIEWPORT;
  const browserDefaults = useBrowserDefaults();
  // A tab created before profiles existed carries no profile of its own. It
  // runs in the built-in `default` partition — the scope the browser used
  // before profiles — not in whatever profile is configured as the default
  // now, so that is what its label names and its clear actions target.
  // Passing the snapshot's raw `undefined` through would reach the IPC layer
  // as "every profile".
  const activeProfileId = snapshot?.profileId ?? DEFAULT_BROWSER_PROFILE_ID;
  const activeProfileName = previewProfileName(browserDefaults.profiles, activeProfileId);
  const panelRect = useBrowserSurfaceStore((state) =>
    runtimeTabId ? (state.byTabId[runtimeTabId]?.rect ?? null) : null,
  );

  const navUrl = navStatus._tag === "Success" ? navStatus.url : null;
  const navTitle = navStatus._tag === "Success" ? navStatus.title : null;
  const latestHistoryUrl = recentHistoryEntries[0]?.url;
  const threadKey = scopedThreadKey(threadRef);
  useEffect(() => {
    if (!navUrl || !navTitle || !latestHistoryUrl) return;
    // Agent-driven pages only enrich an existing requested URL.
    setTitleForThreadUrl(threadRefRef.current, navUrl, navTitle, environmentHostname);
    // threadKey stands in for threadRef, whose identity churns on every thread update.
  }, [environmentHostname, latestHistoryUrl, navTitle, navUrl, threadKey]);

  // The tab on screen here is the one the floating preview takes over once it is hidden.
  useEffect(() => {
    if (!visible || !tabId) return;
    return showBrowserTabInPanel(threadRefRef.current, tabId);
  }, [tabId, threadKey, visible]);

  const navigateToResolvedUrl = useCallback(
    async (resolvedUrl: string) => {
      if (isServerTab && serverSurfaceRef.current) {
        if (serverInputDisabled) return false;
        serverSurfaceRef.current.navigate(resolvedUrl);
        rememberPreviewUrl(threadRef, resolvedUrl);
        return true;
      }
      if (runtimeTabId && previewBridge) {
        // The bridge mirrors the resolved URL back to the server.
        await previewBridge.navigate(runtimeTabId, resolvedUrl);
        rememberPreviewUrl(threadRef, resolvedUrl);
        return true;
      }
      const result = await openPreviewSession({ openPreview: open, threadRef, url: resolvedUrl });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        if (error instanceof BrowserSettingsReadError) {
          toastManager.add({
            type: "error",
            title: "Unable to open browser",
            description: error.message,
          });
        }
      }
      return result._tag === "Success";
    },
    [isServerTab, open, runtimeTabId, serverInputDisabled, threadRef],
  );

  const handleSubmitUrl = useCallback(
    async (next: string) => {
      try {
        const resolved = resolveAddressBarInput(next);
        if (await navigateToResolvedUrl(resolved)) {
          recordVisitForThread(threadRef, resolved);
        }
      } catch {
        // Only empty input or an unsupported scheme lands here; the bar keeps the text.
      }
    },
    [navigateToResolvedUrl, threadRef],
  );

  const handleOpenServerUrl = useCallback(
    async (next: string) => {
      try {
        // A server tab's browser runs on the environment, where loopback is already right.
        const resolved =
          isServerTab || !previewBridge
            ? normalizePreviewUrl(next)
            : resolveDiscoveredServerUrl(threadRef.environmentId, next);
        if (await navigateToResolvedUrl(resolved)) {
          recordVisitForThread(threadRef, next);
        }
      } catch {
        // Server-side `failed` event renders the unreachable view.
      }
    },
    [isServerTab, navigateToResolvedUrl, threadRef],
  );

  const handleRefresh = useCallback(() => {
    if (isServerTab) serverSurfaceRef.current?.reload();
    else if (previewBridge && runtimeTabId) void previewBridge.refresh(runtimeTabId);
  }, [isServerTab, runtimeTabId]);

  /** Appearance and zoom of a server tab, through the server for every client. */
  const adjustServerTab = useCallback(
    async (change: Omit<PreviewAdjustInput, "threadId" | "tabId">) => {
      if (!tabId) return;
      const result = await adjust({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, tabId, ...change },
      });
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Unable to change the browser tab",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
        return;
      }
      updatePreviewServerSnapshot(threadRef, result.value);
    },
    [adjust, tabId, threadRef],
  );

  const serverZoomFactor = snapshot?.zoomFactor ?? DEFAULT_PREVIEW_ZOOM_FACTOR;
  const stepServerZoom = useCallback(
    (direction: -1 | 0 | 1) => {
      const index = PREVIEW_ZOOM_LEVELS.indexOf(serverZoomFactor);
      const next =
        direction === 0
          ? DEFAULT_PREVIEW_ZOOM_FACTOR
          : PREVIEW_ZOOM_LEVELS[
              Math.min(
                Math.max((index < 0 ? 7 : index) + direction, 0),
                PREVIEW_ZOOM_LEVELS.length - 1,
              )
            ]!;
      if (next !== serverZoomFactor) void adjustServerTab({ zoomFactor: next });
    },
    [adjustServerTab, serverZoomFactor],
  );

  // "Match Cogenly": the tab follows the app's resolved theme. Only this
  // client knows that theme, so the tab is told light or dark outright and
  // told again whenever the theme changes. A tab with no choice of its own
  // follows the browser default appearance setting.
  const { resolvedTheme } = useTheme();
  const appearanceKey = tabId ? previewAppearanceKey(threadRef.environmentId, tabId) : null;
  const storedAppearanceMode = usePreviewAppearanceStore((state) =>
    appearanceKey ? state.byTab[appearanceKey] : undefined,
  );
  const appearanceMode =
    storedAppearanceMode ?? (browserDefaults.appearance === "match" ? "match" : "explicit");
  const currentColorScheme = serverOwnsRendering
    ? (snapshot?.colorScheme ?? "system")
    : (desktopOverlay?.colorScheme ?? "system");
  const canAdjustAppearance =
    runtimeTabId !== null && (serverOwnsRendering || (desktopOverlay?.hasWebContents ?? false));
  useEffect(() => {
    if (appearanceMode !== "match" || !canAdjustAppearance || currentColorScheme === resolvedTheme)
      return;
    if (serverOwnsRendering) void adjustServerTab({ colorScheme: resolvedTheme });
    else if (runtimeTabId)
      void previewBridge?.setColorScheme(runtimeTabId, resolvedTheme).catch(() => undefined);
  }, [
    adjustServerTab,
    appearanceMode,
    canAdjustAppearance,
    currentColorScheme,
    resolvedTheme,
    runtimeTabId,
    serverOwnsRendering,
  ]);

  const handleZoomIn = useCallback(() => {
    if (serverOwnsRendering) stepServerZoom(1);
    else if (previewBridge && runtimeTabId) void previewBridge.zoomIn(runtimeTabId);
  }, [runtimeTabId, serverOwnsRendering, stepServerZoom]);

  const handleZoomOut = useCallback(() => {
    if (serverOwnsRendering) stepServerZoom(-1);
    else if (previewBridge && runtimeTabId) void previewBridge.zoomOut(runtimeTabId);
  }, [runtimeTabId, serverOwnsRendering, stepServerZoom]);

  const handleResetZoom = useCallback(() => {
    if (serverOwnsRendering) stepServerZoom(0);
    else if (previewBridge && runtimeTabId) void previewBridge.resetZoom(runtimeTabId);
  }, [runtimeTabId, serverOwnsRendering, stepServerZoom]);

  const handleViewportChange = useCallback(
    async (nextViewport: PreviewViewportSetting) => {
      if (!tabId) return;
      const result = await resize({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          tabId,
          viewport: nextViewport,
        },
      });
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Unable to resize browser viewport",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
        throw error;
      }
      updatePreviewServerSnapshot(threadRef, result.value);
    },
    [resize, tabId, threadRef],
  );

  const handleToggleDeviceToolbar = () => {
    if (!runtimeTabId) return;
    if (viewport._tag !== "fill") {
      void commitBrowserViewportChange(runtimeTabId, FILL_PREVIEW_VIEWPORT).catch(() => undefined);
      return;
    }

    void commitBrowserViewportChange(
      runtimeTabId,
      browserResponsiveViewportForToggle({
        defaults: browserDefaults,
        panelRect,
        zoomFactor: serverOwnsRendering ? serverZoomFactor : desktopOverlay?.zoomFactor,
      }),
    ).catch(() => undefined);
  };

  useEffect(() => {
    if (!runtimeTabId) return;
    return subscribeBrowserViewportChange(runtimeTabId, handleViewportChange);
  }, [handleViewportChange, runtimeTabId]);

  const handleBack = useCallback(() => {
    if (isServerTab) serverSurfaceRef.current?.history(-1);
    else if (previewBridge && runtimeTabId) void previewBridge.goBack(runtimeTabId);
  }, [isServerTab, runtimeTabId]);

  const handleForward = useCallback(() => {
    if (isServerTab) serverSurfaceRef.current?.history(1);
    else if (previewBridge && runtimeTabId) void previewBridge.goForward(runtimeTabId);
  }, [isServerTab, runtimeTabId]);

  const handleOpenInBrowser = useCallback(() => {
    if (!localApi || !url) return;
    void localApi.shell.openExternal(url).catch(() => undefined);
  }, [url]);

  // A desktop tab of a remote environment can only reach what this computer
  // reaches; the environment's browser reaches its own network, and its agents.
  const moveTarget = alternatePreviewRuntime(
    threadRef.environmentId,
    primaryEnvironmentId,
    serverBrowser,
    snapshot,
  );
  const moveLabel =
    moveTarget === "server" ? `Open in ${environmentLabel}'s browser` : "Open on this computer";
  const handleMoveTab = useCallback(async () => {
    if (!moveTarget || !tabId || !snapshot) return;
    const result = await openPreviewSession({
      openPreview: open,
      threadRef,
      // Loopback means the environment's machine, which this computer reaches by its address.
      ...(url
        ? {
            url:
              moveTarget === "desktop"
                ? resolveDiscoveredServerUrl(threadRef.environmentId, url)
                : url,
          }
        : {}),
      viewport,
      ...(snapshot.profileId === undefined ? {} : { profileId: snapshot.profileId }),
      runtime: moveTarget,
    });
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Unable to move the browser tab",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
      return;
    }
    useRightPanelStore.getState().openBrowser(threadRef, result.value.tabId);
    await closePreviewSession({ closePreview, snapshot, tabId, threadRef });
  }, [closePreview, moveTarget, open, snapshot, tabId, threadRef, url, viewport]);

  /**
   * The menu's actions. A server tab, streamed or rendered natively here, runs
   * them through its environment, so every client and agent sees one state.
   * Opening DevTools and a separate window need the desktop's own page.
   */
  const desktopCall = (op: ((tabId: string) => Promise<void>) | undefined) => () => {
    if (op && runtimeTabId) void op(runtimeTabId).catch(() => undefined);
  };
  const moreMenuActions: PreviewMoreMenuActions | null = serverOwnsRendering
    ? {
        hardReload: () => void adjustServerTab({ hardReload: true }),
        setColorScheme: (colorScheme) => void adjustServerTab({ colorScheme }),
        zoomIn: handleZoomIn,
        zoomOut: handleZoomOut,
        resetZoom: handleResetZoom,
        clearCookies: () => void adjustServerTab({ clear: "cookies" }),
        clearCache: () => void adjustServerTab({ clear: "cache" }),
        ...(nativeServerTab && previewBridge
          ? {
              openDevTools: desktopCall(previewBridge.openDevTools),
              toggleNativePictureInPicture: () => handleNativePictureInPicture(),
              ...(sitePermissionActions ? { sitePermissions: sitePermissionActions } : {}),
            }
          : {}),
      }
    : previewBridge
      ? {
          hardReload: desktopCall(previewBridge.hardReload),
          setColorScheme: (colorScheme) => {
            if (runtimeTabId)
              void previewBridge?.setColorScheme(runtimeTabId, colorScheme).catch(() => undefined);
          },
          zoomIn: handleZoomIn,
          zoomOut: handleZoomOut,
          resetZoom: handleResetZoom,
          clearCookies: () =>
            void previewBridge
              ?.clearCookies(threadRef.environmentId, activeProfileId)
              .catch(() => undefined),
          clearCache: () =>
            void previewBridge
              ?.clearCache(threadRef.environmentId, activeProfileId)
              .catch(() => undefined),
          openDevTools: desktopCall(previewBridge.openDevTools),
          toggleNativePictureInPicture: () => handleNativePictureInPicture(),
          ...(sitePermissionActions ? { sitePermissions: sitePermissionActions } : {}),
        }
      : null;

  const handleNativePictureInPicture = useCallback(() => {
    if (!previewBridge || !runtimeTabId) return;
    const operation = desktopOverlay?.pictureInPicture
      ? previewBridge.pictureInPicture.close
      : previewBridge.pictureInPicture.open;
    void operation(runtimeTabId).catch((error) => {
      toastManager.add({
        type: "error",
        title: "Unable to update popped-out preview",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    });
  }, [desktopOverlay?.pictureInPicture, runtimeTabId]);

  const handleCapture = useCallback(
    (record: boolean) => {
      if (!previewBridge || !runtimeTabId || !tabId) return;
      const bridge = previewBridge;
      if (recordingRuntimeTabId) {
        void stopBrowserRecording(recordingRuntimeTabId).then(
          (artifact) => {
            if (!artifact) return;
            let pathCopied = false;
            let toastId: ReturnType<typeof toastManager.add>;

            // The toast's action label follows the same copied-then-revert feedback as copy buttons.
            const pathFeedback = createCopyFeedback({
              resetMs: COPY_FEEDBACK_MS,
              onStatus: (status) => {
                pathCopied = status === "copied";
                updateRecordingToast();
              },
            });
            const copyPath = () => {
              void pathFeedback
                .run(() => writeTextToClipboard(artifact.path, "recording path"))
                .then((outcome) => {
                  if (outcome.kind !== "failed") return;
                  toastManager.update(
                    toastId,
                    stackedThreadToast({
                      type: "error",
                      title: "Unable to copy recording path",
                      description: outcome.error.message,
                      actionProps: revealAction,
                    }),
                  );
                });
            };

            const revealAction = {
              children: revealInFileExplorerLabel(navigator.platform),
              onClick: () => void bridge.revealArtifact(artifact.path),
            };
            const updateRecordingToast = () => {
              toastManager.update(
                toastId,
                stackedThreadToast({
                  type: "success",
                  title: "Recording saved",
                  actionProps: revealAction,
                  data: {
                    secondaryActionProps: {
                      children: pathCopied ? "Copied" : "Copy path",
                      disabled: pathCopied,
                      onClick: copyPath,
                    },
                    secondaryActionVariant: "outline",
                  },
                }),
              );
            };

            toastId = toastManager.add(
              stackedThreadToast({
                type: "success",
                title: "Recording saved",
                actionProps: revealAction,
                data: {
                  secondaryActionProps: {
                    children: "Copy path",
                    onClick: copyPath,
                  },
                  secondaryActionVariant: "outline",
                },
              }),
            );
          },
          (error) => {
            toastManager.add({
              type: "error",
              title: "Unable to stop recording",
              description: error instanceof Error ? error.message : "An error occurred.",
            });
          },
        );
        return;
      }
      if (record) {
        void startBrowserRecording(runtimeTabId, threadRef, tabId).catch((error) => {
          const description = error instanceof Error ? error.message : "An error occurred.";
          if (isBrowserRecordingStartCancelledError(error)) return;
          toastManager.add({
            type: "error",
            title: "Unable to start recording",
            description,
          });
        });
        return;
      }
      void bridge.captureScreenshot(runtimeTabId).then(
        (artifact) => {
          const revealAction = {
            children: revealInFileExplorerLabel(navigator.platform),
            onClick: () => void bridge.revealArtifact(artifact.path),
          };
          // Captures taken while the last one's toast is still up update it
          // with a count; its actions act on the newest screenshot.
          const count = (openScreenshotToast?.count ?? 0) + 1;
          let pathCopied = false;
          let toastId: ReturnType<typeof toastManager.add>;

          const screenshotToast = (
            type: "success" | "error" = "success",
            title = screenshotToastTitle(count),
            description?: string,
          ) =>
            stackedThreadToast({
              type,
              title,
              description,
              actionProps: revealAction,
              data: {
                secondaryActionProps: {
                  children: pathCopied ? "Copied" : "Copy path",
                  disabled: pathCopied,
                  onClick: copyPath,
                },
                secondaryActionVariant: "outline",
              },
            });

          const pathFeedback = createCopyFeedback({
            resetMs: COPY_FEEDBACK_MS,
            onStatus: (status) => {
              pathCopied = status === "copied";
              toastManager.update(toastId, screenshotToast());
            },
          });
          const copyPath = () => {
            void pathFeedback
              .run(() => writeTextToClipboard(artifact.path, "screenshot path"))
              .then((outcome) => {
                if (outcome.kind !== "failed") return;
                toastManager.update(
                  toastId,
                  screenshotToast("error", "Unable to copy screenshot path", outcome.error.message),
                );
              });
          };

          if (openScreenshotToast) {
            toastId = openScreenshotToast.id;
            toastManager.update(toastId, screenshotToast());
          } else {
            toastId = toastManager.add({
              ...screenshotToast(),
              onRemove: () => {
                if (openScreenshotToast?.id === toastId) openScreenshotToast = null;
              },
            });
          }
          openScreenshotToast = { id: toastId, count };
        },
        (error) => {
          toastManager.add({
            type: "error",
            title: "Unable to capture screenshot",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        },
      );
    },
    [recordingRuntimeTabId, runtimeTabId, tabId, threadRef],
  );

  /**
   * Puts a finished annotation in the composer as context, with its crop as an
   * image, and sends it now when the picker asked to. Desktop and server picks
   * share it, so both land as the same chip.
   */
  const deliverAnnotation = useCallback(
    (
      picked: PreviewAnnotationPayload,
      submission: PreviewAnnotationSubmission,
      screenshotFailed: boolean,
    ) => {
      // The structured annotation is still sendable when its optional crop
      // stalls or fails, so tell the user what they lost and keep going
      // instead of holding the composer for an attachment that never lands.
      // The stored copy drops the screenshot on failure, otherwise the prompt
      // would tell the agent a crop is attached when none was sent.
      const capture = capturePreviewAnnotationScreenshot(picked);
      // Main reports a crop that failed or timed out on its side; the local
      // conversion can fail too. Either way the user should hear about it.
      const cropDropped = screenshotFailed || capture.status === "failed";
      const annotation = capture.status === "failed" ? { ...picked, screenshot: null } : picked;
      addPreviewAnnotation(threadRef, annotation);
      if (cropDropped) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not capture the picked element",
            // The send path reports its own outcome, so only say what this
            // handler knows: the crop was dropped.
            description: "The annotation was kept without the screenshot.",
          }),
        );
      }
      const screenshotFile = capture.status === "captured" ? capture.file : null;
      const image =
        screenshotFile && annotation.screenshot
          ? ({
              type: "image",
              id: annotation.id,
              name: screenshotFile.name,
              mimeType: screenshotFile.type,
              sizeBytes: screenshotFile.size,
              previewUrl: annotation.screenshot.dataUrl,
              file: screenshotFile,
            } satisfies ComposerImageAttachment)
          : null;
      if (image) {
        addImage(threadRef, image);
      }
      if (
        submission === "send" &&
        readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)
      ) {
        onSendAnnotation?.(annotation, image);
      }
    },
    [addImage, addPreviewAnnotation, onSendAnnotation, threadRef],
  );

  const handlePickElement = useCallback(() => {
    if (!previewBridge || !runtimeTabId) return;
    if (pickActiveRef.current) {
      pickActiveRef.current.cancelled = true;
      void previewBridge.cancelPickElement(runtimeTabId).catch(() => undefined);
      return;
    }
    // Snapshot whatever the user was focused on (typically the chat
    // composer textarea or the chrome-row pick button) BEFORE main steals
    // focus into the guest webContents. We restore it when the pick
    // resolves so the user's typing context isn't lost — otherwise after
    // every pick they'd have to click back into the textarea.
    const previouslyFocused =
      typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
    const pickRequest = { cancelled: false };
    let submitted = false;
    pickActiveRef.current = pickRequest;
    setPickActive(true);
    void (async () => {
      try {
        await previewBridge.setAnnotationSendEnabled?.(
          runtimeTabId,
          Boolean(onSendAnnotation) &&
            readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope),
        );
        if (pickRequest.cancelled) return;
        const result = await previewBridge.pickElement(runtimeTabId);
        if (!result || pickRequest.cancelled) return;
        // The user has submitted. Nothing that happens after this point (a
        // second picker click, a tab change, unmount) may discard it, so the
        // pick stops being cancellable here rather than in `finally`.
        if (pickActiveRef.current === pickRequest) {
          pickActiveRef.current = null;
          if (isMountedRef.current) setPickActive(false);
          submitted = true;
        }
        const { annotation: picked, submission, screenshotFailed = false } = result;
        deliverAnnotation(picked, submission, screenshotFailed);
      } catch {
        // Picker failed (e.g. webview navigated). Treat as silent cancel.
      } finally {
        // A submitted pick already released itself above; a cancelled or
        // failed one releases here. Avoid `setState on unmounted component`
        // if the panel/thread closed while the pick was in flight.
        const isCurrentPick = pickActiveRef.current === pickRequest;
        if (isCurrentPick) {
          pickActiveRef.current = null;
          if (isMountedRef.current) setPickActive(false);
        }
        // Best-effort: restore focus to whatever the user had before the
        // pick stole it into the guest webContents. Skip if the previously-
        // focused element was unmounted or is no longer focusable.
        if (
          (isCurrentPick || submitted) &&
          previouslyFocused &&
          previouslyFocused.isConnected &&
          typeof previouslyFocused.focus === "function"
        ) {
          try {
            previouslyFocused.focus({ preventScroll: true });
          } catch {
            // Some elements throw on .focus() (detached iframes, etc.).
          }
        }
      }
    })();
  }, [deliverAnnotation, onSendAnnotation, runtimeTabId, threadRef]);

  useEffect(() => {
    if (!pickActive || !previewBridge || !runtimeTabId) return;
    void previewBridge
      .setAnnotationSendEnabled?.(runtimeTabId, canSendAnnotation)
      .catch(() => undefined);
  }, [canSendAnnotation, pickActive, runtimeTabId]);

  // If the active tab changes mid-pick (close, thread switch, hot restart),
  // tell main to tear down the in-flight session AND reset our local toggle
  // state so the button doesn't get stuck pressed against a stale tab id.
  useEffect(() => {
    return () => {
      if (!pickActiveRef.current) return;
      pickActiveRef.current.cancelled = true;
      pickActiveRef.current = null;
      if (previewBridge && runtimeTabId) {
        void previewBridge.cancelPickElement(runtimeTabId).catch(() => undefined);
      }
      if (isMountedRef.current) setPickActive(false);
    };
  }, [runtimeTabId]);

  // Subscribe only while visible; `toggle-panel` is owned by ChatView's
  // URL-aware handler regardless of whether the panel is currently mounted.
  useEffect(() => {
    if (!visible) return;
    return subscribePreviewAction((action) => {
      switch (action) {
        case "refresh":
          handleRefresh();
          return;
        case "focus-url":
          setFocusUrlNonce((value) => (value ?? 0) + 1);
          return;
        case "zoom-in":
          handleZoomIn();
          return;
        case "zoom-out":
          handleZoomOut();
          return;
        case "reset-zoom":
          handleResetZoom();
          return;
        case "toggle-panel":
          return;
      }
    });
  }, [handleRefresh, handleResetZoom, handleZoomIn, handleZoomOut, visible]);

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-background"
      data-thread-key={scopedThreadKey(threadRef)}
    >
      <PreviewChromeRow
        url={url}
        loading={loading || serverStreamPending}
        canGoBack={canGoBack && !serverInputDisabled}
        canGoForward={canGoForward && !serverInputDisabled}
        refreshDisabled={refreshDisabled || serverInputDisabled}
        inputDisabled={serverInputDisabled}
        focusUrlNonce={focusUrlNonce}
        onBack={handleBack}
        onForward={handleForward}
        onRefresh={handleRefresh}
        onSubmit={(next) => void handleSubmitUrl(next)}
        onOpenInBrowser={tabId ? handleOpenInBrowser : undefined}
        // Capture drives the desktop webview, so server tabs leave it out.
        // Annotation works for both.
        onCapture={previewBridge && tabId && !isServerTab ? handleCapture : undefined}
        captureDisabled={!desktopOverlay || isUnreachable}
        recording={recordingRuntimeTabId !== null}
        onPickElement={
          tabId && isServerTab
            ? () => setServerPickTabId(serverPickActive ? null : runtimeTabId)
            : previewBridge && tabId
              ? handlePickElement
              : undefined
        }
        pickActive={isServerTab ? serverPickActive : pickActive}
        // Disable when there's no tab (nothing to pick on) OR the page
        // failed to load (a React overlay covers the webview, so the
        // user wouldn't be able to actually click anything underneath).
        pickDisabled={!tabId || isUnreachable || (isServerTab && !serverPickAvailable)}
        pickDisabledReason={
          isUnreachable
            ? "Page didn't load — pick unavailable until the page renders"
            : (serverPickBlocker ?? undefined)
        }
        pickNotice={pickNotice}
        control={
          serverTabControl
            ? {
                controller: serverTabControl.controller,
                canOperate: serverTabControl.canOperate,
                agentInvolved: serverTabControl.agentInvolved,
                onTakeControl: () => serverSurfaceRef.current?.takeControl(),
                onHandBack: () => serverSurfaceRef.current?.handBack(),
              }
            : null
        }
        agentUsingTab={nativeServerTab && snapshot?.agentDriving === true}
        leadingActions={
          <>
            {previewMachine ? <PreviewMachineChip machine={previewMachine} /> : null}
            {/* Only when it differs from the default: labelling every tab
                "Default" would be noise on the common case, while a tab in
                another profile is exactly what needs calling out. */}
            {activeProfileId !== browserDefaults.profileId ? (
              // Capped: profile names run to 48 characters, and an unbounded
              // badge in this row takes its width from the URL input, the only
              // flexible element in the compact chrome. The cap sits on the
              // badge and the truncation on an inner span, because `Badge` is an
              // `inline-flex` with `whitespace-nowrap` — `text-overflow` never
              // reaches a bare text node inside it, so the name would be cut off
              // at both ends with no ellipsis.
              <Tooltip>
                <TooltipTrigger render={<Badge variant="outline" className="max-w-28 shrink-0" />}>
                  <span className="truncate">{activeProfileName}</span>
                </TooltipTrigger>
                <TooltipPopup side="top">{activeProfileName}</TooltipPopup>
              </Tooltip>
            ) : null}
          </>
        }
        trailingActions={
          moreMenuActions ? (
            <PreviewMoreMenu
              enabled={
                runtimeTabId !== null &&
                (serverOwnsRendering || (desktopOverlay?.hasWebContents ?? false))
              }
              actions={moreMenuActions}
              {...(moveTarget
                ? { move: { label: moveLabel, onMove: () => void handleMoveTab() } }
                : {})}
              profileName={activeProfileName}
              zoomFactor={
                serverOwnsRendering ? serverZoomFactor : (desktopOverlay?.zoomFactor ?? 1)
              }
              appearance={appearanceMode === "match" ? "match" : currentColorScheme}
              onAppearanceChange={(next) => {
                if (!appearanceKey) return;
                const store = usePreviewAppearanceStore.getState();
                if (next === "match") {
                  store.setMode(appearanceKey, "match");
                  if (currentColorScheme !== resolvedTheme)
                    moreMenuActions.setColorScheme(resolvedTheme);
                } else {
                  store.setMode(appearanceKey, "explicit");
                  moreMenuActions.setColorScheme(next);
                }
              }}
              deviceToolbarVisible={viewport._tag !== "fill"}
              onToggleDeviceToolbar={handleToggleDeviceToolbar}
              nativePictureInPicture={desktopOverlay?.pictureInPicture ?? false}
            />
          ) : null
        }
      />

      <div ref={serverBodyRef} className="relative min-h-0 flex-1 overflow-hidden">
        {runtimeTabId && snapshot && isServerTab ? (
          <>
            {viewport._tag !== "fill" && !showEmptyState && !isUnreachable ? (
              <div className="absolute inset-x-0 top-0 z-10">
                <BrowserDeviceToolbar
                  setting={viewport}
                  width={serverToolbarWidth}
                  aspectRatio={serverAspectRatioLocked ? viewport.width / viewport.height : null}
                  onAspectRatioChange={(ratio) => setServerAspectRatioLocked(ratio !== null)}
                  onChange={(setting) => commitBrowserViewportChange(runtimeTabId, setting)}
                />
              </div>
            ) : null}
            <div
              className="absolute inset-x-0 bottom-0"
              style={{ top: viewport._tag !== "fill" ? BROWSER_DEVICE_TOOLBAR_HEIGHT : 0 }}
            >
              <ServerBrowserSurface
                key={runtimeTabId}
                ref={serverSurfaceRef}
                environmentId={threadRef.environmentId}
                threadId={threadRef.threadId}
                tabId={snapshot.tabId}
                visible={visible}
                onFirstFrame={() => setServerFrameTabId(runtimeTabId)}
                onControl={(control) =>
                  setServerControl(control ? { tabId: runtimeTabId, control } : null)
                }
                onPopup={(popupTabId) => showPreviewPopup(threadRef, popupTabId)}
                pick={{
                  active: serverPickActive,
                  markers: serverPickMarkers,
                  // Added picks stay in pick mode so several can stack before sending.
                  onAdd: (annotation) => {
                    setPickNotice(null);
                    deliverAnnotation(annotation, "attach", false);
                  },
                  onError: (message) => setPickNotice({ message, leaving: false }),
                  onExit: () => setServerPickTabId(null),
                }}
                // Stays connected under the empty state so a URL picked there reaches the page.
                className={cn(
                  "absolute inset-0 h-full w-full",
                  (showEmptyState || isUnreachable) && "invisible",
                )}
              />
            </div>
          </>
        ) : runtimeTabId && snapshot && !showEmptyState ? (
          previewBridge ? (
            <BrowserSurfaceSlot
              key={runtimeTabId}
              tabId={runtimeTabId}
              visible={visible && !isUnreachable}
              className="absolute inset-0 h-full w-full"
            />
          ) : (
            <div className="flex h-full items-center justify-center p-8 text-center">
              <p className="max-w-sm text-sm text-muted-foreground">
                This tab is open in the Cogenly desktop app.
              </p>
            </div>
          )
        ) : null}
        {showEmptyState ? (
          <PreviewEmptyState
            threadRef={threadRef}
            environmentId={threadRef.environmentId}
            configuredUrls={configuredUrls}
            recentEntries={recentHistoryEntries}
            onRemoveRecent={(url) => removeUrlForThread(threadRef, url)}
            onOpenUrl={(next) => void handleOpenServerUrl(next)}
          />
        ) : null}
        {snapshot && desktopOverlay ? (
          <ZoomIndicator zoomFactor={desktopOverlay.zoomFactor} />
        ) : null}
        <PreviewPermissionPrompt
          prompt={sitePermissions.prompt}
          onAnswer={sitePermissions.answer}
        />
        {runtimeTabId &&
        desktopOverlay &&
        !showEmptyState &&
        !isUnreachable &&
        !activeRecordingTabIds.has(runtimeTabId) ? (
          <AgentBrowserCursor
            tabId={runtimeTabId}
            zoomFactor={desktopOverlay.zoomFactor}
            controller={controller}
          />
        ) : null}
        {navStatus._tag === "LoadFailed" && navStatus.download ? (
          <div className="absolute inset-0 z-10 bg-background">
            <ServerTabFileNotShown
              threadRef={threadRef}
              tabId={snapshot?.tabId ?? ""}
              url={navStatus.url}
              download={navStatus.download}
            />
          </div>
        ) : navStatus._tag === "LoadFailed" ? (
          <div className="absolute inset-0 z-10 bg-background">
            <PreviewUnreachable
              url={navStatus.url}
              code={navStatus.code}
              description={navStatus.description}
              onReload={handleRefresh}
              {...(moveTarget === "server"
                ? { move: { label: moveLabel, onMove: () => void handleMoveTab() } }
                : {})}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
