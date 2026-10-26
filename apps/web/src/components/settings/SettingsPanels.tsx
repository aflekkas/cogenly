import { matchesSettingsListQuery } from "./settingsList.logic";
import {
  SettingsList,
  SettingsListItem,
  SettingsListToolbar,
  SettingsListSearch,
  SettingsListFilter,
  SettingsListEmpty,
} from "./SettingsList";
import { useDictationAvailable } from "~/dictation/dictationAvailability";
import { SettingsGroup } from "./SettingsGroup";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { settingsScopeEnvironmentLabels } from "./settingsScopeAxis";
import { useScopedSettingsWriteAllowed } from "./useScopedSettings";
import { NotificationSettings } from "./NotificationSettings";
import { ArchiveIcon, ArchiveX, CheckIcon, RotateCcwIcon, SettingsIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  type BackgroundActivityProfile,
  type ScopedThreadRef,
  type SidebarProjectGroupingMode,
} from "@cogenly/contracts";
import { scopeThreadRef } from "@cogenly/client-runtime/environment";
import { presentThreadShell } from "@cogenly/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@cogenly/client-runtime/state/runtime";
import {
  DEFAULT_UNIFIED_SETTINGS,
  type ChatWidth,
  type EnvironmentIdentificationMode,
  type ResponseStreamingMode,
  type QuitConfirmationMode,
  SidebarProjectSortOrder,
} from "@cogenly/contracts/settings";
import { resolveServerBackgroundActivitySettings } from "@cogenly/shared/backgroundActivitySettings";
import * as Duration from "effect/Duration";
import * as Equal from "effect/Equal";
import * as Schema from "effect/Schema";
import { APP_VERSION, HOSTED_APP_CHANNEL, HOSTED_APP_CHANNEL_LABEL } from "../../branding";
import { CliCommandSettingsRow } from "./CliCommandSettingsRow";
import {
  canCheckForUpdate,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
} from "../../components/desktopUpdate.logic";
import { isElectron } from "../../env";
import { buildHostedChannelSelectionUrl, type HostedAppChannel } from "../../hostedPairing";
import { useTheme } from "../../hooks/useTheme";
import { BrowserAppearanceSettingRow } from "./IntegrationsSettings";
import { DEFAULT_APPEARANCE_MODE, type AppearanceMode } from "../../theme";
import { AccentColorSettingRow } from "./AccentColorSettingRow";
import {
  DEFAULT_APPEARANCE_PREFERENCES,
  type FontSizePreference,
  SIDEBAR_LAYOUTS,
  type SidebarLayout,
  useAppearancePreferences,
} from "../../appearancePreferences";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { UsageMeterModeToggle } from "../usage/UsageMeter";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";
import { useSettingsScope } from "./SettingsScopeContext";
import { useThreadActions } from "../../hooks/useThreadActions";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { ensureLocalApi, readLocalApi } from "../../localApi";
import { isMacPlatform } from "../../lib/utils";
import { useArchivedThreadSnapshots } from "../../lib/archivedThreadsState";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { ScopedSwitch } from "./ScopedSwitch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  backgroundActivityOverrideSettings,
  backgroundActivitySharedPolicySettings,
  durationToSeconds,
  getChangedBrowserSettingLabels,
  getChangedTypographySettingLabels,
  normalizeIntervalSeconds,
  PROVIDER_HEALTH_INTERVAL_STEP_SECONDS,
  hasChangedBackgroundActivitySettings,
  isProjectGroupingEnabled,
  projectGroupingModeFromToggle,
  readLastEnabledProjectGroupingMode,
  rememberEnabledProjectGroupingMode,
  resolveBackgroundActivityProfileOption,
} from "./SettingsPanels.logic";
import {
  PolicyTooltip,
  SettingResetButton,
  SettingsNumberField,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { Trash2Icon } from "lucide-react";
import { searchableSetting } from "./settingsSearch";
import { RESPONSE_STREAMING_MODE_LABELS } from "./settingValueLabels";
import { ProjectFavicon } from "../ProjectFavicon";

const ENVIRONMENT_IDENTIFICATION_LABELS: Record<EnvironmentIdentificationMode, string> = {
  artwork: "Artwork",
  pill: "Version pill",
  none: "None",
};

const RESPONSE_STREAMING_MODE_DESCRIPTIONS: Record<ResponseStreamingMode, string> = {
  turn: "Text appears once the agent finishes its turn.",
  paragraph: "Each paragraph or code block appears as soon as it is complete.",
};

const SIDEBAR_PROJECT_SORT_ORDER_LABELS: Record<SidebarProjectSortOrder, string> = {
  updated_at: "Last user message",
  created_at: "Created at",
  manual: "Manual",
};
const isSidebarProjectSortOrder = Schema.is(SidebarProjectSortOrder);

const TIMESTAMP_FORMAT_LABELS = {
  locale: "System default",
  "12-hour": "12-hour",
  "24-hour": "24-hour",
} as const;

const CHAT_WIDTH_LABELS: Record<ChatWidth, string> = {
  comfortable: "Comfortable",
  wide: "Wide",
  full: "Full",
};

const QUIT_CONFIRMATION_MODE_LABELS: Record<QuitConfirmationMode, string> = {
  direct: "Direct",
  hold: "Hold",
  "double-click": "Double press",
};

const BACKGROUND_ACTIVITY_PROFILE_LABELS: Record<BackgroundActivityProfile, string> = {
  balanced: "Balanced",
  performance: "Performance",
  "battery-saver": "Battery saver",
};

type BackgroundActivityProfileOption = BackgroundActivityProfile | "advanced";

const BACKGROUND_ACTIVITY_PROFILE_OPTION_LABELS: Record<BackgroundActivityProfileOption, string> = {
  ...BACKGROUND_ACTIVITY_PROFILE_LABELS,
  advanced: "Advanced",
};

const BACKGROUND_ACTIVITY_PROFILE_DESCRIPTIONS: Record<BackgroundActivityProfile, string> = {
  balanced: "Pauses probes for idle clients, locked hosts, or low power mode.",
  performance: "Allows scoped background probes while any subscribed client remains connected.",
  "battery-saver": "Also pauses background probes when the host or client is on battery.",
};

const ADVANCED_BACKGROUND_ACTIVITY_DESCRIPTION = "Uses custom intervals.";

const BACKGROUND_ACTIVITY_BOOLEAN_OVERRIDES: ReadonlyArray<{
  readonly key:
    | "pauseWhenHostLocked"
    | "pauseWhenHostLowPower"
    | "pauseWhenClientLowPower"
    | "pauseWhenOnBattery";
  readonly label: string;
}> = [
  { key: "pauseWhenHostLocked", label: "Pause when host is locked" },
  { key: "pauseWhenHostLowPower", label: "Pause on host low power" },
  { key: "pauseWhenClientLowPower", label: "Pause on client low power" },
  { key: "pauseWhenOnBattery", label: "Pause on battery" },
];

function resetBackgroundActivitySettings() {
  return {
    backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
  };
}

function backgroundActivityProfileSettings(profile: BackgroundActivityProfile) {
  return {
    backgroundActivity: {
      schemaVersion: 1 as const,
      profile,
      overrides: {},
    },
  };
}

function AboutVersionTitle() {
  return (
    <span className="inline-flex items-baseline gap-2">
      <span>Version</span>
      <code className="text-2xs font-medium text-muted-foreground">{APP_VERSION}</code>
    </span>
  );
}

function AboutVersionSection() {
  const updateState = useDesktopUpdateState();
  const [isUpdateActionPending, setIsUpdateActionPending] = useState(false);

  const hasDesktopBridge = typeof window !== "undefined" && Boolean(window.desktopBridge);
  const selectedHostedAppChannel = hasDesktopBridge ? null : HOSTED_APP_CHANNEL;

  const handleButtonClick = useCallback(async () => {
    const bridge = window.desktopBridge;
    if (!bridge) return;

    const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";

    if (action === "download") {
      void bridge.downloadUpdate().catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not download update",
            description: error instanceof Error ? error.message : "Download failed.",
          }),
        );
      });
      return;
    }

    if (action === "install") {
      if (isUpdateActionPending) return;
      setIsUpdateActionPending(true);
      let confirmed = false;
      try {
        confirmed = await ensureLocalApi().dialogs.confirm(
          getDesktopUpdateInstallConfirmationMessage(
            updateState ?? { availableVersion: null, downloadedVersion: null },
          ),
        );
      } catch (error) {
        setIsUpdateActionPending(false);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not confirm update",
            description: error instanceof Error ? error.message : "Update confirmation failed.",
          }),
        );
        return;
      }
      if (!confirmed) {
        setIsUpdateActionPending(false);
        return;
      }
      void bridge
        .installUpdate()
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not install update",
              description: error instanceof Error ? error.message : "Install failed.",
            }),
          );
        })
        .finally(() => setIsUpdateActionPending(false));
      return;
    }

    if (typeof bridge.checkForUpdate !== "function") return;
    void bridge
      .checkForUpdate()
      .then((result) => {
        if (!result.checked) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not check for updates",
              description:
                result.state.message ?? "Automatic updates are not available in this build.",
            }),
          );
        }
      })
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not check for updates",
            description: error instanceof Error ? error.message : "Update check failed.",
          }),
        );
      });
  }, [isUpdateActionPending, updateState]);

  const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";
  const buttonTooltip = updateState ? getDesktopUpdateButtonTooltip(updateState) : null;
  const buttonDisabled =
    action === "none"
      ? !canCheckForUpdate(updateState)
      : isDesktopUpdateButtonDisabled(updateState);

  const actionLabel: Record<string, string> = { download: "Download", install: "Install" };
  const statusLabel: Record<string, string> = {
    checking: "Checking…",
    downloading: "Downloading…",
    "up-to-date": "Up to Date",
  };
  const buttonLabel =
    actionLabel[action] ?? statusLabel[updateState?.status ?? ""] ?? "Check for Updates";
  const description =
    action === "download" || action === "install"
      ? updateState?.manualDownloadUrl
        ? "Update available — download and install the DMG."
        : "Update available."
      : "Current version of the application.";

  return (
    <>
      <SettingsRow
        id={searchableSetting("app-version").id}
        title={<AboutVersionTitle />}
        description={description}
        control={
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="sm"
                  variant="outline"
                  disabled={buttonDisabled || isUpdateActionPending}
                  onClick={handleButtonClick}
                >
                  {buttonLabel}
                </Button>
              }
            />
            {buttonTooltip ? <TooltipPopup>{buttonTooltip}</TooltipPopup> : null}
          </Tooltip>
        }
      />
      {selectedHostedAppChannel ? (
        <SettingsRow
          clientSetting
          {...searchableSetting("update-track")}
          description="Switches the hosted app release channel."
          control={
            <Select
              value={selectedHostedAppChannel}
              onValueChange={(value) => {
                if (value === selectedHostedAppChannel) return;
                window.location.assign(
                  buildHostedChannelSelectionUrl({ channel: value as HostedAppChannel }),
                );
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Update track">
                <SelectValue>{HOSTED_APP_CHANNEL_LABEL}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="latest">
                  Latest
                </SelectItem>
                <SelectItem hideIndicator value="nightly">
                  Nightly
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      ) : null}
      {hasDesktopBridge ? <CliCommandSettingsRow /> : null}
    </>
  );
}

export function useSettingsRestore(onRestored?: () => void) {
  const { theme, setTheme } = useTheme();
  const { preferences: appearance, update: updateAppearance } = useAppearancePreferences();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();

  const isTextGenerationModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );
  const isBackgroundActivityDirty = hasChangedBackgroundActivitySettings(settings);

  const changedSettingLabels = useMemo(
    () => [
      ...(theme !== DEFAULT_APPEARANCE_MODE ? ["Theme"] : []),
      ...(appearance.accent !== DEFAULT_APPEARANCE_PREFERENCES.accent ? ["Accent color"] : []),
      ...(appearance.fontSize !== DEFAULT_APPEARANCE_PREFERENCES.fontSize ? ["Font size"] : []),
      ...(appearance.motion !== DEFAULT_APPEARANCE_PREFERENCES.motion ? ["Reduce motion"] : []),
      ...(appearance.usageMeter !== DEFAULT_APPEARANCE_PREFERENCES.usageMeter
        ? ["Usage meters"]
        : []),
      ...(appearance.sidebarLayout !== DEFAULT_APPEARANCE_PREFERENCES.sidebarLayout
        ? ["Sidebar layout"]
        : []),
      ...(settings.diffColorScheme !== DEFAULT_UNIFIED_SETTINGS.diffColorScheme
        ? ["Diff colors"]
        : []),
      ...(settings.chatWidth !== DEFAULT_UNIFIED_SETTINGS.chatWidth ? ["Chat width"] : []),
      ...(settings.environmentIdentificationMode !==
      DEFAULT_UNIFIED_SETTINGS.environmentIdentificationMode
        ? ["Machine identification"]
        : []),
      ...(settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat
        ? ["Time format"]
        : []),
      ...(settings.notificationMode !== DEFAULT_UNIFIED_SETTINGS.notificationMode
        ? ["Thread notifications"]
        : []),
      ...(settings.inAppNotificationsEnabled !== DEFAULT_UNIFIED_SETTINGS.inAppNotificationsEnabled
        ? ["In-app notifications"]
        : []),
      ...(settings.sidebarThreadPreviewCount !== DEFAULT_UNIFIED_SETTINGS.sidebarThreadPreviewCount
        ? ["Visible threads"]
        : []),
      ...(settings.sidebarProjectGroupingMode !==
      DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode
        ? ["Repository grouping"]
        : []),
      ...(settings.sidebarProjectSortOrder !== DEFAULT_UNIFIED_SETTINGS.sidebarProjectSortOrder
        ? ["Repository order"]
        : []),
      ...(settings.sidebarWorkingShelfEnabled !==
      DEFAULT_UNIFIED_SETTINGS.sidebarWorkingShelfEnabled
        ? ["Working section"]
        : []),
      ...(settings.autoResumeLimitedThreads !== DEFAULT_UNIFIED_SETTINGS.autoResumeLimitedThreads
        ? ["Auto-resume limited threads"]
        : []),
      ...(settings.snoozeLimitedThreads !== DEFAULT_UNIFIED_SETTINGS.snoozeLimitedThreads
        ? ["Snooze limited threads"]
        : []),
      ...(settings.wordWrap !== DEFAULT_UNIFIED_SETTINGS.wordWrap ? ["Word wrap"] : []),
      ...(settings.persistComposerContextStrip !==
      DEFAULT_UNIFIED_SETTINGS.persistComposerContextStrip
        ? ["Composer context"]
        : []),
      ...getChangedTypographySettingLabels(settings),
      ...(settings.showSkillsInSlashMenu !== DEFAULT_UNIFIED_SETTINGS.showSkillsInSlashMenu
        ? ["Show skills in slash menu"]
        : []),
      ...(settings.composerRichTextEnabled !== DEFAULT_UNIFIED_SETTINGS.composerRichTextEnabled
        ? ["Rich text composer"]
        : []),
      ...(settings.dictationEnabled !== DEFAULT_UNIFIED_SETTINGS.dictationEnabled
        ? ["Dictation"]
        : []),
      ...(settings.sendShortcut !== DEFAULT_UNIFIED_SETTINGS.sendShortcut ? ["Send shortcut"] : []),
      ...(settings.followUpBehavior !== DEFAULT_UNIFIED_SETTINGS.followUpBehavior
        ? ["Follow-up behavior"]
        : []),
      ...(settings.contextWindowMeterEnabled !== DEFAULT_UNIFIED_SETTINGS.contextWindowMeterEnabled
        ? ["Context window indicator"]
        : []),
      ...(settings.responseStreamingMode !== DEFAULT_UNIFIED_SETTINGS.responseStreamingMode
        ? ["Response streaming"]
        : []),
      ...(settings.enableProviderUpdateChecks !==
      DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks
        ? ["Provider update checks"]
        : []),
      ...(settings.continueThreadsAfterServerUpdate !==
      DEFAULT_UNIFIED_SETTINGS.continueThreadsAfterServerUpdate
        ? ["Continue threads after restarts"]
        : []),
      ...(isBackgroundActivityDirty ? ["Background activity"] : []),
      ...(settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode
        ? ["New thread mode"]
        : []),
      ...(settings.newWorktreesStartFromOrigin !==
      DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin
        ? ["New worktrees start from origin"]
        : []),
      ...(settings.addProjectBaseDirectory !== DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory
        ? ["Add repository base directory"]
        : []),
      ...(settings.projectsRoot !== DEFAULT_UNIFIED_SETTINGS.projectsRoot
        ? ["Projects folder"]
        : []),
      ...(settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive
        ? ["Archive confirmation"]
        : []),
      ...(settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete
        ? ["Delete confirmation"]
        : []),
      ...(settings.confirmQuit !== DEFAULT_UNIFIED_SETTINGS.confirmQuit ? ["Quit shortcut"] : []),
      ...(isTextGenerationModelDirty ? ["Text generation model"] : []),
      ...(settings.aiGreetings !== DEFAULT_UNIFIED_SETTINGS.aiGreetings ? ["AI greetings"] : []),
      ...getChangedBrowserSettingLabels(settings),
      ...(settings.enableAgentBrowserAccess !== DEFAULT_UNIFIED_SETTINGS.enableAgentBrowserAccess
        ? ["Agent browser access"]
        : []),
      ...(settings.enableAgentComputerUse !== DEFAULT_UNIFIED_SETTINGS.enableAgentComputerUse
        ? ["Computer use"]
        : []),
    ],
    [
      isTextGenerationModelDirty,
      isBackgroundActivityDirty,
      settings.browserDefaultViewport,
      settings.browserDefaultZoomFactor,
      settings.browserDefaultAppearance,
      settings.browserRecordingFrameRate,
      settings.browserRecordingShowKeyPresses,
      settings.browserRecordingShowMousePresses,
      settings.browserLinkTarget,
      settings.diffColorScheme,
      settings.chatWidth,
      settings.enableAgentBrowserAccess,
      settings.enableAgentComputerUse,
      settings.confirmQuit,
      settings.confirmThreadArchive,
      settings.confirmThreadDelete,
      settings.composerRichTextEnabled,
      settings.dictationEnabled,
      settings.sendShortcut,
      settings.followUpBehavior,
      settings.addProjectBaseDirectory,
      settings.projectsRoot,
      settings.defaultThreadEnvMode,
      settings.newWorktreesStartFromOrigin,
      settings.environmentIdentificationMode,
      settings.contextWindowMeterEnabled,
      settings.fontSizeCode,
      settings.fontSizeInterface,
      settings.fontSizePrompt,
      settings.fontSizeTerminal,
      settings.responseStreamingMode,
      settings.persistComposerContextStrip,
      settings.enableProviderUpdateChecks,
      settings.continueThreadsAfterServerUpdate,
      settings.autoResumeLimitedThreads,
      settings.snoozeLimitedThreads,
      settings.aiGreetings,
      settings.sidebarProjectGroupingMode,
      settings.sidebarProjectSortOrder,
      settings.sidebarWorkingShelfEnabled,
      settings.sidebarThreadPreviewCount,
      settings.showSkillsInSlashMenu,
      settings.timestampFormat,
      settings.notificationMode,
      settings.inAppNotificationsEnabled,
      settings.wordWrap,
      theme,
      appearance,
    ],
  );

  const restoreDefaults = useCallback(async () => {
    if (changedSettingLabels.length === 0) return;
    const api = readLocalApi();
    const confirmed = await (api ?? ensureLocalApi()).dialogs.confirm(
      ["Restore default settings?", `This will reset: ${changedSettingLabels.join(", ")}.`].join(
        "\n",
      ),
      { variant: "destructive" },
    );
    if (!confirmed) return;

    if (theme !== DEFAULT_APPEARANCE_MODE && !setTheme(DEFAULT_APPEARANCE_MODE)) return;
    if (
      appearance !== DEFAULT_APPEARANCE_PREFERENCES &&
      !updateAppearance(DEFAULT_APPEARANCE_PREFERENCES)
    )
      return;
    updateSettings({
      diffColorScheme: DEFAULT_UNIFIED_SETTINGS.diffColorScheme,
      chatWidth: DEFAULT_UNIFIED_SETTINGS.chatWidth,
      timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat,
      notificationMode: DEFAULT_UNIFIED_SETTINGS.notificationMode,
      inAppNotificationsEnabled: DEFAULT_UNIFIED_SETTINGS.inAppNotificationsEnabled,
      wordWrap: DEFAULT_UNIFIED_SETTINGS.wordWrap,
      persistComposerContextStrip: DEFAULT_UNIFIED_SETTINGS.persistComposerContextStrip,
      showSkillsInSlashMenu: DEFAULT_UNIFIED_SETTINGS.showSkillsInSlashMenu,
      composerRichTextEnabled: DEFAULT_UNIFIED_SETTINGS.composerRichTextEnabled,
      dictationEnabled: DEFAULT_UNIFIED_SETTINGS.dictationEnabled,
      sendShortcut: DEFAULT_UNIFIED_SETTINGS.sendShortcut,
      followUpBehavior: DEFAULT_UNIFIED_SETTINGS.followUpBehavior,
      contextWindowMeterEnabled: DEFAULT_UNIFIED_SETTINGS.contextWindowMeterEnabled,
      environmentIdentificationMode: DEFAULT_UNIFIED_SETTINGS.environmentIdentificationMode,
      sidebarThreadPreviewCount: DEFAULT_UNIFIED_SETTINGS.sidebarThreadPreviewCount,
      sidebarProjectGroupingMode: DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode,
      sidebarProjectSortOrder: DEFAULT_UNIFIED_SETTINGS.sidebarProjectSortOrder,
      sidebarWorkingShelfEnabled: DEFAULT_UNIFIED_SETTINGS.sidebarWorkingShelfEnabled,
      autoResumeLimitedThreads: DEFAULT_UNIFIED_SETTINGS.autoResumeLimitedThreads,
      snoozeLimitedThreads: DEFAULT_UNIFIED_SETTINGS.snoozeLimitedThreads,
      responseStreamingMode: DEFAULT_UNIFIED_SETTINGS.responseStreamingMode,
      enableProviderUpdateChecks: DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks,
      continueThreadsAfterServerUpdate: DEFAULT_UNIFIED_SETTINGS.continueThreadsAfterServerUpdate,
      backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
      backgroundActivityProfile: DEFAULT_UNIFIED_SETTINGS.backgroundActivityProfile,
      automaticGitFetchInterval: DEFAULT_UNIFIED_SETTINGS.automaticGitFetchInterval,
      providerHealthRefreshInterval: DEFAULT_UNIFIED_SETTINGS.providerHealthRefreshInterval,
      defaultThreadEnvMode: DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode,
      newWorktreesStartFromOrigin: DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin,
      addProjectBaseDirectory: DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory,
      projectsRoot: DEFAULT_UNIFIED_SETTINGS.projectsRoot,
      confirmThreadArchive: DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive,
      confirmThreadDelete: DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete,
      confirmQuit: DEFAULT_UNIFIED_SETTINGS.confirmQuit,
      textGenerationModelSelection: DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
      aiGreetings: DEFAULT_UNIFIED_SETTINGS.aiGreetings,
      fontSizeInterface: DEFAULT_UNIFIED_SETTINGS.fontSizeInterface,
      fontSizePrompt: DEFAULT_UNIFIED_SETTINGS.fontSizePrompt,
      fontSizeCode: DEFAULT_UNIFIED_SETTINGS.fontSizeCode,
      fontSizeTerminal: DEFAULT_UNIFIED_SETTINGS.fontSizeTerminal,
      browserDefaultViewport: DEFAULT_UNIFIED_SETTINGS.browserDefaultViewport,
      browserDefaultZoomFactor: DEFAULT_UNIFIED_SETTINGS.browserDefaultZoomFactor,
      browserDefaultAppearance: DEFAULT_UNIFIED_SETTINGS.browserDefaultAppearance,
      browserRecordingFrameRate: DEFAULT_UNIFIED_SETTINGS.browserRecordingFrameRate,
      browserRecordingShowKeyPresses: DEFAULT_UNIFIED_SETTINGS.browserRecordingShowKeyPresses,
      browserRecordingShowMousePresses: DEFAULT_UNIFIED_SETTINGS.browserRecordingShowMousePresses,
      browserLinkTarget: DEFAULT_UNIFIED_SETTINGS.browserLinkTarget,
      // Re-granted like any other default. The confirmation dialog lists it by
      // name, so a user restoring defaults is told the agent regains access
      // rather than discovering it later.
      enableAgentBrowserAccess: DEFAULT_UNIFIED_SETTINGS.enableAgentBrowserAccess,
      enableAgentComputerUse: DEFAULT_UNIFIED_SETTINGS.enableAgentComputerUse,
    });
    onRestored?.();
  }, [
    appearance,
    changedSettingLabels,
    onRestored,
    setTheme,
    theme,
    updateAppearance,
    updateSettings,
  ]);

  return {
    changedSettingLabels,
    restoreDefaults,
  };
}

function BackgroundActivityAdvancedDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const canWriteSettings = useScopedSettingsWriteAllowed();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const resolvedBackgroundActivity = resolveServerBackgroundActivitySettings(settings);
  const activeProfile = resolvedBackgroundActivity.profile;
  const automaticGitFetchIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.automaticGitFetchInterval,
  );
  const providerHealthRefreshIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.providerHealthRefreshInterval,
  );
  const hostPowerMonitorActiveIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.hostPowerMonitorActiveInterval,
  );
  const hostPowerMonitorIdleIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.hostPowerMonitorIdleInterval,
  );

  const updateOverrides = (patch: Parameters<typeof backgroundActivityOverrideSettings>[2]) =>
    updateSettings(
      backgroundActivityOverrideSettings(
        settings.backgroundActivity,
        resolvedBackgroundActivity,
        patch,
      ),
    );

  return (
    <Dialog open={open && canWriteSettings} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Background activity</DialogTitle>
          <DialogDescription>
            Tune the shared power policy and the background intervals that feed it.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <fieldset disabled={!canWriteSettings} className="min-w-0">
            <SettingsGroup>
              <SettingsRow
                title="Shared policy"
                description="Controls whether background work may run after a subscribed interval fires."
                control={
                  <Select
                    value={activeProfile}
                    onValueChange={(value) => {
                      if (
                        value === "balanced" ||
                        value === "performance" ||
                        value === "battery-saver"
                      ) {
                        updateSettings({
                          backgroundActivity: backgroundActivitySharedPolicySettings(
                            settings,
                            value,
                          ),
                        });
                      }
                    }}
                  >
                    <SelectTrigger
                      size="sm"
                      className="w-full sm:w-40"
                      aria-label="Shared background policy"
                    >
                      <SelectValue>{BACKGROUND_ACTIVITY_PROFILE_LABELS[activeProfile]}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end" alignItemWithTrigger={false}>
                      <SelectItem hideIndicator value="balanced">
                        {BACKGROUND_ACTIVITY_PROFILE_LABELS.balanced}
                      </SelectItem>
                      <SelectItem hideIndicator value="performance">
                        {BACKGROUND_ACTIVITY_PROFILE_LABELS.performance}
                      </SelectItem>
                      <SelectItem hideIndicator value="battery-saver">
                        {BACKGROUND_ACTIVITY_PROFILE_LABELS["battery-saver"]}
                      </SelectItem>
                    </SelectPopup>
                  </Select>
                }
              />
              <SettingsRow
                title={searchableSetting("git-fetch-interval").title}
                description="Refresh remote branch status in the background."
                control={
                  <SettingsNumberField
                    label="Git fetch interval"
                    unit="seconds"
                    value={automaticGitFetchIntervalSeconds}
                    min={0}
                    step={5}
                    onValueChange={(value) =>
                      updateOverrides({
                        automaticGitFetchInterval: Duration.seconds(
                          normalizeIntervalSeconds(value),
                        ),
                      })
                    }
                  />
                }
              />
              <SettingsRow
                title="Provider health interval"
                description="Refresh provider availability, versions, and auth state. Model catalog updates follow Provider update checks."
                control={
                  <SettingsNumberField
                    label="provider health interval"
                    unit="seconds"
                    value={providerHealthRefreshIntervalSeconds}
                    min={0}
                    step={PROVIDER_HEALTH_INTERVAL_STEP_SECONDS}
                    onValueChange={(value) =>
                      updateOverrides({
                        providerHealthRefreshInterval: Duration.seconds(
                          normalizeIntervalSeconds(value),
                        ),
                      })
                    }
                  />
                }
              />
              <SettingsRow
                title="Host power monitor"
                description="Poll host power state while clients are active."
                control={
                  <SettingsNumberField
                    label="active host power interval"
                    unit="seconds"
                    value={hostPowerMonitorActiveIntervalSeconds}
                    min={5}
                    step={5}
                    onValueChange={(value) =>
                      updateOverrides({
                        hostPowerMonitorActiveInterval: Duration.seconds(
                          normalizeIntervalSeconds(value, 5),
                        ),
                      })
                    }
                  />
                }
              />
              <SettingsRow
                title="Idle host monitor"
                description="Poll host power state when no foreground client is active."
                control={
                  <SettingsNumberField
                    label="idle host power interval"
                    unit="seconds"
                    value={hostPowerMonitorIdleIntervalSeconds}
                    min={5}
                    step={30}
                    onValueChange={(value) =>
                      updateOverrides({
                        hostPowerMonitorIdleInterval: Duration.seconds(
                          normalizeIntervalSeconds(value, 5),
                        ),
                      })
                    }
                  />
                }
              />
              {BACKGROUND_ACTIVITY_BOOLEAN_OVERRIDES.map(({ key, label }) => (
                <SettingsRow
                  key={key}
                  title={label}
                  control={
                    <Switch
                      checked={resolvedBackgroundActivity[key]}
                      onCheckedChange={(checked) => updateOverrides({ [key]: Boolean(checked) })}
                      aria-label={label}
                    />
                  }
                />
              ))}
            </SettingsGroup>
          </fieldset>
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={!canWriteSettings}
            onClick={() => updateSettings(resetBackgroundActivitySettings())}
          >
            Reset all
          </Button>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

const APPEARANCE_MODE_LABELS: Record<AppearanceMode, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

const FONT_SIZE_LABELS: Record<FontSizePreference, string> = {
  small: "Small",
  default: "Default",
  large: "Large",
};

const SIDEBAR_LAYOUT_LABELS: Record<SidebarLayout, string> = {
  top: "Top",
  bottom: "Bottom",
};

/** A single-choice segmented control for a settings row. */
function SettingsSegmented<T extends string>(props: {
  readonly label: string;
  readonly value: T;
  readonly options: readonly T[];
  readonly labels: Record<T, string>;
  readonly onChange: (value: T) => void;
}) {
  return (
    <ToggleGroup
      aria-label={props.label}
      variant="segmented"
      value={[props.value]}
      onValueChange={(next) => {
        const picked = props.options.find((option) => option === next[0]);
        if (picked !== undefined) props.onChange(picked);
      }}
    >
      {props.options.map((option) => (
        <Toggle key={option} value={option}>
          {props.labels[option]}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}

export function AppearanceSettingsPanel() {
  const { appearanceMode, setAppearanceMode } = useTheme();
  const { preferences, update } = useAppearancePreferences();
  return (
    <>
      <SettingsSection id="appearance" title="Appearance">
        <SettingsRow
          {...searchableSetting("color-scheme")}
          description="Light, dark, or follow your system."
          resetAction={
            appearanceMode !== DEFAULT_APPEARANCE_MODE ? (
              <SettingResetButton
                label="color scheme"
                onClick={() => setAppearanceMode(DEFAULT_APPEARANCE_MODE)}
              />
            ) : null
          }
          control={
            <SettingsSegmented
              label="Color scheme"
              value={appearanceMode}
              options={["light", "dark", "system"]}
              labels={APPEARANCE_MODE_LABELS}
              onChange={setAppearanceMode}
            />
          }
        />
        <AccentColorSettingRow />
        <SettingsRow
          {...searchableSetting("font-size")}
          description="Scales text and spacing across the app."
          resetAction={
            preferences.fontSize !== DEFAULT_APPEARANCE_PREFERENCES.fontSize ? (
              <SettingResetButton
                label="font size"
                onClick={() => update({ fontSize: DEFAULT_APPEARANCE_PREFERENCES.fontSize })}
              />
            ) : null
          }
          control={
            <SettingsSegmented
              label="Font size"
              value={preferences.fontSize}
              options={["small", "default", "large"]}
              labels={FONT_SIZE_LABELS}
              onChange={(fontSize) => update({ fontSize })}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("sidebar-layout")}
          description="Anchored to the bottom near search, or top-down."
          resetAction={
            preferences.sidebarLayout !== DEFAULT_APPEARANCE_PREFERENCES.sidebarLayout ? (
              <SettingResetButton
                label="sidebar layout"
                onClick={() =>
                  update({ sidebarLayout: DEFAULT_APPEARANCE_PREFERENCES.sidebarLayout })
                }
              />
            ) : null
          }
          control={
            <SettingsSegmented
              label="Sidebar layout"
              value={preferences.sidebarLayout}
              options={SIDEBAR_LAYOUTS}
              labels={SIDEBAR_LAYOUT_LABELS}
              onChange={(sidebarLayout) => update({ sidebarLayout })}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("usage-meters")}
          description="Whether usage limit bars show quota remaining (draining) or quota used (filling up)."
          resetAction={
            preferences.usageMeter !== DEFAULT_APPEARANCE_PREFERENCES.usageMeter ? (
              <SettingResetButton
                label="usage meters"
                onClick={() => update({ usageMeter: DEFAULT_APPEARANCE_PREFERENCES.usageMeter })}
              />
            ) : null
          }
          control={<UsageMeterModeToggle />}
        />
        <SettingsRow
          {...searchableSetting("reduce-motion")}
          description="Turn animations down to simple fades. Off follows your system setting."
          resetAction={
            preferences.motion !== DEFAULT_APPEARANCE_PREFERENCES.motion ? (
              <SettingResetButton
                label="reduce motion"
                onClick={() => update({ motion: DEFAULT_APPEARANCE_PREFERENCES.motion })}
              />
            ) : null
          }
          control={
            <Switch
              checked={preferences.motion === "reduce"}
              onCheckedChange={(checked) => update({ motion: checked ? "reduce" : "system" })}
              aria-label="Reduce motion"
            />
          }
        />
      </SettingsSection>
      <SettingsSection id="browser-appearance" title="Browser on this device">
        <BrowserAppearanceSettingRow disabled={false} />
      </SettingsSection>
    </>
  );
}

// The legacy rows sit behind the fold, so a settings-search jump has to
// expand the section before its target can mount and scroll.
const LEGACY_FEATURE_TARGET_IDS = [
  "legacy-plan-mode",
  "legacy-context-window-indicator",
  "legacy-sidebar",
] as const;

/**
 * Retired features kept only for users who still depend on them. Collapsed by
 * default so they stay out of the everyday settings path; a settings-search
 * jump to one of the rows unfolds the section.
 */
function LegacyFeaturesSection() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();

  return (
    <FoldedSettingsSection
      id="legacy-features"
      targetIds={LEGACY_FEATURE_TARGET_IDS}
      title="Legacy features"
      headerPlacement="outside"
    >
      <SettingsRow
        clientSetting
        {...searchableSetting("legacy-plan-mode")}
        description="Restore Build/Plan, /plan, /default, and Shift+Tab. Off uses build mode."
        control={
          <Switch
            checked={settings.planModeEnabled}
            onCheckedChange={(checked) => {
              updateSettings({ planModeEnabled: Boolean(checked) });
            }}
            aria-label="Plan mode (legacy)"
          />
        }
      />
      <SettingsRow
        clientSetting
        {...searchableSetting("legacy-context-window-indicator")}
        description="Shows context window usage as a circular indicator in the composer."
        control={
          <Switch
            checked={settings.contextWindowMeterEnabled}
            onCheckedChange={(checked) =>
              updateSettings({ contextWindowMeterEnabled: Boolean(checked) })
            }
            aria-label="Context window indicator (legacy)"
          />
        }
      />
      <SettingsRow
        clientSetting
        {...searchableSetting("legacy-sidebar")}
        description="Restore per-repository thread trees instead of the default flat sidebar."
        control={
          <Switch
            checked={settings.legacySidebarEnabled}
            onCheckedChange={(checked) =>
              updateSettings({ legacySidebarEnabled: Boolean(checked) })
            }
            aria-label="Sidebar (legacy)"
          />
        }
      />
    </FoldedSettingsSection>
  );
}

function RestoreDefaultsSection({ onRestored }: { onRestored: () => void }) {
  const { changedSettingLabels, restoreDefaults } = useSettingsRestore(onRestored);
  return (
    <SettingsSection id="reset" title="Reset">
      <SettingsRow
        title="Restore device defaults"
        description="Reset the settings on this page to their defaults. You confirm before anything changes."
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={changedSettingLabels.length === 0}
            onClick={() => void restoreDefaults()}
          >
            <RotateCcwIcon className="size-3.5" />
            Restore defaults
          </Button>
        }
      />
    </SettingsSection>
  );
}

export function GeneralSettingsPanel({ onRestored }: { onRestored: () => void }) {
  const dictationSupported = useDictationAvailable();
  const modifierLabel = isMacPlatform(navigator.platform) ? "⌘" : "Ctrl";
  const sendShortcutOptions = [
    { value: "enter", label: "Enter" },
    { value: "mod-enter-multiline", label: `${modifierLabel} + Enter for multiline prompts` },
    { value: "mod-enter", label: `${modifierLabel} + Enter always` },
  ] as const;
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { scope, environment, connectedEnvironments } = useSettingsScope();
  // The representative environment is the machine machine-local rows such as
  // background activity apply to, so per-machine tuning edits that machine.
  const environmentId = environment?.environmentId ?? null;
  const isEnvironmentScope = scope.kind !== "project" && environmentId !== null;
  const [backgroundActivityDialogOpen, setBackgroundActivityDialogOpen] = useState(false);
  const mixedResponseStreamingMode = useScopedSettingsMixed(["responseStreamingMode"]);
  const lastEnabledProjectGroupingMode = useRef<SidebarProjectGroupingMode>(
    readLastEnabledProjectGroupingMode(),
  );
  const supportsRestartContinuation =
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every(
      (target) => target.serverConfig?.environment.capabilities.threadRestartContinuation === true,
    );

  const resolvedBackgroundActivity = resolveServerBackgroundActivitySettings(settings);
  const activeBackgroundActivityProfile = resolvedBackgroundActivity.profile;
  const backgroundActivityProfileOption = resolveBackgroundActivityProfileOption(settings);
  const mixedBackgroundActivity = useScopedSettingsMixed(["backgroundActivity"]);
  const backgroundActivityDescription =
    backgroundActivityProfileOption === "advanced"
      ? `${ADVANCED_BACKGROUND_ACTIVITY_DESCRIPTION} Shared policy: ${
          BACKGROUND_ACTIVITY_PROFILE_LABELS[activeBackgroundActivityProfile]
        }.`
      : BACKGROUND_ACTIVITY_PROFILE_DESCRIPTIONS[resolvedBackgroundActivity.profile];
  const canResetBackgroundActivity = !Equal.equals(
    settings.backgroundActivity,
    DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
  );

  return (
    <>
      <SettingsSection id="organization" title="Organization">
        <SettingsRow
          clientSetting
          {...searchableSetting("project-grouping")}
          description="Combine matching repositories across machines."
          resetAction={
            settings.sidebarProjectGroupingMode !==
            DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode ? (
              <SettingResetButton
                label="repository grouping"
                onClick={() =>
                  updateSettings({
                    sidebarProjectGroupingMode: DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={isProjectGroupingEnabled(settings.sidebarProjectGroupingMode)}
              onCheckedChange={(checked) => {
                if (!checked && settings.sidebarProjectGroupingMode !== "separate") {
                  lastEnabledProjectGroupingMode.current = settings.sidebarProjectGroupingMode;
                  rememberEnabledProjectGroupingMode(settings.sidebarProjectGroupingMode);
                }
                updateSettings({
                  sidebarProjectGroupingMode: projectGroupingModeFromToggle(
                    checked,
                    lastEnabledProjectGroupingMode.current,
                  ),
                });
              }}
              aria-label="Repository grouping"
            />
          }
        />
        <SettingsRow
          clientSetting
          {...searchableSetting("project-order")}
          description="Order of repositories in the sidebar repository picker and command palette."
          resetAction={
            settings.sidebarProjectSortOrder !==
            DEFAULT_UNIFIED_SETTINGS.sidebarProjectSortOrder ? (
              <SettingResetButton
                label="repository order"
                onClick={() =>
                  updateSettings({
                    sidebarProjectSortOrder: DEFAULT_UNIFIED_SETTINGS.sidebarProjectSortOrder,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.sidebarProjectSortOrder}
              onValueChange={(value) => {
                if (isSidebarProjectSortOrder(value)) {
                  updateSettings({ sidebarProjectSortOrder: value });
                }
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-44" aria-label="Repository order">
                <SelectValue>
                  {SIDEBAR_PROJECT_SORT_ORDER_LABELS[settings.sidebarProjectSortOrder]}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {SidebarProjectSortOrder.literals.map((sortOrder) => (
                  <SelectItem hideIndicator key={sortOrder} value={sortOrder}>
                    {SIDEBAR_PROJECT_SORT_ORDER_LABELS[sortOrder]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          serverScoped
          {...searchableSetting("auto-resume-limited-threads")}
          description="Continue usage-limit stops at the reported reset time. Each thread can opt out from its banner or menu."
          settingKeys={["autoResumeLimitedThreads"]}
          control={
            <ScopedSwitch
              settingKeys={["autoResumeLimitedThreads"]}
              checked={settings.autoResumeLimitedThreads}
              onCheckedChange={(checked) =>
                updateSettings({ autoResumeLimitedThreads: Boolean(checked) })
              }
              aria-label="Auto-resume limited threads"
            />
          }
        />
        <SettingsRow
          serverScoped
          {...searchableSetting("snooze-limited-threads")}
          description="Snooze usage-limit stops until the reported reset time. Combine with auto-resume to continue when they wake."
          settingKeys={["snoozeLimitedThreads"]}
          control={
            <ScopedSwitch
              settingKeys={["snoozeLimitedThreads"]}
              checked={settings.snoozeLimitedThreads}
              onCheckedChange={(checked) =>
                updateSettings({ snoozeLimitedThreads: Boolean(checked) })
              }
              aria-label="Snooze limited threads"
            />
          }
        />

        <SettingsRow
          clientSetting
          {...searchableSetting("working-shelf")}
          description="Fold working and monitoring threads into a Working section. They return to the top of the inbox when they need you."
          resetAction={
            settings.sidebarWorkingShelfEnabled !==
            DEFAULT_UNIFIED_SETTINGS.sidebarWorkingShelfEnabled ? (
              <SettingResetButton
                label="working section"
                onClick={() =>
                  updateSettings({
                    sidebarWorkingShelfEnabled: DEFAULT_UNIFIED_SETTINGS.sidebarWorkingShelfEnabled,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.sidebarWorkingShelfEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ sidebarWorkingShelfEnabled: Boolean(checked) })
              }
              aria-label="Working section (beta)"
            />
          }
        />
      </SettingsSection>

      <SettingsSection id="behavior" title="Behavior">
        <NotificationSettings />
        <SettingsRow
          clientSetting
          {...searchableSetting("in-app-notifications")}
          description="Show a toast when another thread finishes, fails, or needs input or approval while this app has focus."
          control={
            <Switch
              checked={settings.inAppNotificationsEnabled}
              onCheckedChange={(checked) => updateSettings({ inAppNotificationsEnabled: checked })}
              aria-label="In-app notifications"
            />
          }
        />
        <SettingsRow
          clientSetting
          {...searchableSetting("time-format")}
          description="System default follows your browser or OS clock preference."
          resetAction={
            settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat ? (
              <SettingResetButton
                label="time format"
                onClick={() =>
                  updateSettings({
                    timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.timestampFormat}
              onValueChange={(value) => {
                if (value === "locale" || value === "12-hour" || value === "24-hour") {
                  updateSettings({ timestampFormat: value });
                }
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Timestamp format">
                <SelectValue>{TIMESTAMP_FORMAT_LABELS[settings.timestampFormat]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="locale">
                  {TIMESTAMP_FORMAT_LABELS.locale}
                </SelectItem>
                <SelectItem hideIndicator value="12-hour">
                  {TIMESTAMP_FORMAT_LABELS["12-hour"]}
                </SelectItem>
                <SelectItem hideIndicator value="24-hour">
                  {TIMESTAMP_FORMAT_LABELS["24-hour"]}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          serverScoped
          settingKeys={["responseStreamingMode"]}
          {...searchableSetting("response-streaming")}
          description={
            mixedResponseStreamingMode
              ? "The selected targets use different streaming modes."
              : RESPONSE_STREAMING_MODE_DESCRIPTIONS[settings.responseStreamingMode]
          }
          resetAction={
            settings.responseStreamingMode !== DEFAULT_UNIFIED_SETTINGS.responseStreamingMode ? (
              <SettingResetButton
                label="response streaming"
                onClick={() =>
                  updateSettings({
                    responseStreamingMode: DEFAULT_UNIFIED_SETTINGS.responseStreamingMode,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={mixedResponseStreamingMode ? null : settings.responseStreamingMode}
              onValueChange={(value) => {
                if (value === "turn" || value === "paragraph") {
                  updateSettings({ responseStreamingMode: value });
                }
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Response streaming">
                <SelectValue>
                  {(value: ResponseStreamingMode | null) =>
                    value === null ? "Mixed" : RESPONSE_STREAMING_MODE_LABELS[value]
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="turn">
                  {RESPONSE_STREAMING_MODE_LABELS.turn}
                </SelectItem>
                <SelectItem hideIndicator value="paragraph">
                  {RESPONSE_STREAMING_MODE_LABELS.paragraph}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          clientSetting
          {...searchableSetting("skills-in-slash-menu")}
          description="Also include skills in the / command menu. Skills always appear when you type $."
          resetAction={
            settings.showSkillsInSlashMenu !== DEFAULT_UNIFIED_SETTINGS.showSkillsInSlashMenu ? (
              <SettingResetButton
                label="skills in slash menu"
                onClick={() =>
                  updateSettings({
                    showSkillsInSlashMenu: DEFAULT_UNIFIED_SETTINGS.showSkillsInSlashMenu,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.showSkillsInSlashMenu}
              onCheckedChange={(checked) =>
                updateSettings({ showSkillsInSlashMenu: Boolean(checked) })
              }
              aria-label="Show skills in slash menu"
            />
          }
        />

        <SettingsRow
          clientSetting
          {...searchableSetting("composer-rich-text")}
          description="Show formatted Markdown as you type."
          resetAction={
            settings.composerRichTextEnabled !==
            DEFAULT_UNIFIED_SETTINGS.composerRichTextEnabled ? (
              <SettingResetButton
                label="rich text composer"
                onClick={() =>
                  updateSettings({
                    composerRichTextEnabled: DEFAULT_UNIFIED_SETTINGS.composerRichTextEnabled,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.composerRichTextEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ composerRichTextEnabled: Boolean(checked) })
              }
              aria-label="Rich text composer"
            />
          }
        />

        {dictationSupported ? (
          <SettingsRow
            clientSetting
            {...searchableSetting("composer-dictation")}
            description="Show the composer's mic button and its shortcut. Speech is transcribed on this Mac."
            resetAction={
              settings.dictationEnabled !== DEFAULT_UNIFIED_SETTINGS.dictationEnabled ? (
                <SettingResetButton
                  label="dictation"
                  onClick={() =>
                    updateSettings({ dictationEnabled: DEFAULT_UNIFIED_SETTINGS.dictationEnabled })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.dictationEnabled}
                onCheckedChange={(checked) =>
                  updateSettings({ dictationEnabled: Boolean(checked) })
                }
                aria-label="Dictation"
              />
            }
          />
        ) : null}

        <SettingsRow
          clientSetting
          {...searchableSetting("send-shortcut")}
          description="Choose when Enter sends a prompt or inserts a new line"
          resetAction={
            settings.sendShortcut !== DEFAULT_UNIFIED_SETTINGS.sendShortcut ? (
              <SettingResetButton
                label="send shortcut"
                onClick={() =>
                  updateSettings({ sendShortcut: DEFAULT_UNIFIED_SETTINGS.sendShortcut })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.sendShortcut}
              onValueChange={(value) => {
                const option = sendShortcutOptions.find((option) => option.value === value);
                if (option) updateSettings({ sendShortcut: option.value });
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-auto min-w-0 max-w-full"
                aria-label="Send shortcut"
              >
                <SelectValue>
                  {
                    sendShortcutOptions.find((option) => option.value === settings.sendShortcut)
                      ?.label
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {sendShortcutOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    <span className="flex items-center justify-between gap-4">
                      {option.label}
                      {settings.sendShortcut === option.value && <CheckIcon aria-hidden="true" />}
                    </span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          clientSetting
          {...searchableSetting("follow-up-behavior")}
          description={
            "Steer the current run with follow-ups or queue them until the agent finishes. " +
            (settings.sendShortcut === "mod-enter-multiline"
              ? `Press ${modifierLabel} + Enter for single-line prompts or ${modifierLabel} + Shift + Enter for multiline prompts to do the opposite for one message.`
              : `Press ${modifierLabel}${settings.sendShortcut === "mod-enter" ? " + Shift" : ""} + Enter to do the opposite for one message.`)
          }
          resetAction={
            settings.followUpBehavior !== DEFAULT_UNIFIED_SETTINGS.followUpBehavior ? (
              <SettingResetButton
                label="follow-up behavior"
                onClick={() =>
                  updateSettings({
                    followUpBehavior: DEFAULT_UNIFIED_SETTINGS.followUpBehavior,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.followUpBehavior}
              onValueChange={(value) => {
                if (value === "queue" || value === "steer") {
                  updateSettings({ followUpBehavior: value });
                }
              }}
            >
              <SelectTrigger size="sm" className="w-auto min-w-0" aria-label="Follow-up behavior">
                <SelectValue>
                  {settings.followUpBehavior === "queue" ? "Queue" : "Steer"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value="queue">Queue</SelectItem>
                <SelectItem value="steer">Steer</SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          serverScoped
          settingKeys={["enableProviderUpdateChecks"]}
          {...searchableSetting("provider-update-checks")}
          description="Check installed provider CLIs for newer available versions and fetch model catalog updates. When off, new models may not appear."
          resetAction={
            settings.enableProviderUpdateChecks !==
            DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks ? (
              <SettingResetButton
                label="provider update checks"
                onClick={() =>
                  updateSettings({
                    enableProviderUpdateChecks: DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks,
                  })
                }
              />
            ) : null
          }
          control={
            <ScopedSwitch
              settingKeys={["enableProviderUpdateChecks"]}
              checked={settings.enableProviderUpdateChecks}
              onCheckedChange={(checked) =>
                updateSettings({ enableProviderUpdateChecks: Boolean(checked) })
              }
              aria-label="Check provider versions"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("continue-threads-after-server-update")}
          serverScoped
          settingKeys={["continueThreadsAfterServerUpdate"]}
          description="Automatically resume interrupted threads after an update, crash, or machine restart across your machines."
          status={
            !supportsRestartContinuation
              ? "Every connected machine must support restart continuation."
              : undefined
          }
          resetAction={
            supportsRestartContinuation &&
            settings.continueThreadsAfterServerUpdate !==
              DEFAULT_UNIFIED_SETTINGS.continueThreadsAfterServerUpdate ? (
              <SettingResetButton
                label="continue threads after restarts"
                onClick={() =>
                  updateSettings({
                    continueThreadsAfterServerUpdate:
                      DEFAULT_UNIFIED_SETTINGS.continueThreadsAfterServerUpdate,
                  })
                }
              />
            ) : null
          }
          control={
            <ScopedSwitch
              settingKeys={["continueThreadsAfterServerUpdate"]}
              checked={settings.continueThreadsAfterServerUpdate}
              disabled={!supportsRestartContinuation}
              onCheckedChange={(checked) =>
                updateSettings({ continueThreadsAfterServerUpdate: Boolean(checked) })
              }
              aria-label="Continue threads after restarts"
            />
          }
        />

        <SettingsRow
          serverScoped
          settingKeys={["backgroundActivity"]}
          id={searchableSetting("background-activity").id}
          title={
            <span className="inline-flex items-center gap-1.5">
              {searchableSetting("background-activity").title}
              <PolicyTooltip>
                This shared policy gates background work such as Git refreshes and provider health
                probes after their individual intervals elapse.
              </PolicyTooltip>
            </span>
          }
          description={backgroundActivityDescription}
          resetAction={
            canResetBackgroundActivity ? (
              <SettingResetButton
                label="background activity"
                onClick={() => updateSettings(resetBackgroundActivitySettings())}
              />
            ) : null
          }
          control={
            <>
              <Select
                value={mixedBackgroundActivity ? null : backgroundActivityProfileOption}
                onValueChange={(value) => {
                  if (value === "advanced") {
                    if (isEnvironmentScope) setBackgroundActivityDialogOpen(true);
                    return;
                  }
                  if (
                    value === "balanced" ||
                    value === "performance" ||
                    value === "battery-saver"
                  ) {
                    updateSettings(backgroundActivityProfileSettings(value));
                  }
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full sm:w-40"
                  aria-label="Background activity profile"
                >
                  <SelectValue>
                    {(value: BackgroundActivityProfileOption | null) =>
                      value === null ? "Mixed" : BACKGROUND_ACTIVITY_PROFILE_OPTION_LABELS[value]
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="balanced">
                    {BACKGROUND_ACTIVITY_PROFILE_LABELS.balanced}
                  </SelectItem>
                  <SelectItem hideIndicator value="performance">
                    {BACKGROUND_ACTIVITY_PROFILE_LABELS.performance}
                  </SelectItem>
                  <SelectItem hideIndicator value="battery-saver">
                    {BACKGROUND_ACTIVITY_PROFILE_LABELS["battery-saver"]}
                  </SelectItem>
                  <SelectItem hideIndicator value="advanced" disabled={!isEnvironmentScope}>
                    {isEnvironmentScope
                      ? BACKGROUND_ACTIVITY_PROFILE_OPTION_LABELS.advanced
                      : `${BACKGROUND_ACTIVITY_PROFILE_OPTION_LABELS.advanced} (one machine)`}
                  </SelectItem>
                </SelectPopup>
              </Select>
              {backgroundActivityProfileOption === "advanced" && isEnvironmentScope ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-sm"
                        variant="outline"
                        aria-label="Configure advanced background activity"
                        onClick={() => setBackgroundActivityDialogOpen(true)}
                      >
                        <SettingsIcon className="size-4" />
                      </Button>
                    }
                  />
                  <TooltipPopup side="top">Configure background activity</TooltipPopup>
                </Tooltip>
              ) : null}
              <BackgroundActivityAdvancedDialog
                open={backgroundActivityDialogOpen && isEnvironmentScope}
                onOpenChange={setBackgroundActivityDialogOpen}
              />
            </>
          }
        />
      </SettingsSection>

      <SettingsSection id="confirmations" title="Confirmations">
        <SettingsRow
          clientSetting
          {...searchableSetting("archive-confirmation")}
          description="Require a second click on the inline archive action before a thread is archived."
          resetAction={
            settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive ? (
              <SettingResetButton
                label="archive confirmation"
                onClick={() =>
                  updateSettings({
                    confirmThreadArchive: DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadArchive}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadArchive: Boolean(checked) })
              }
              aria-label="Confirm thread archiving"
            />
          }
        />

        <SettingsRow
          clientSetting
          {...searchableSetting("delete-confirmation")}
          description="Ask before deleting a thread and its chat history."
          resetAction={
            settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete ? (
              <SettingResetButton
                label="delete confirmation"
                onClick={() =>
                  updateSettings({
                    confirmThreadDelete: DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadDelete}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadDelete: Boolean(checked) })
              }
              aria-label="Confirm thread deletion"
            />
          }
        />

        {isElectron ? (
          <SettingsRow
            clientSetting
            {...searchableSetting("quit-confirmation")}
            description="Hold mode also quits on two quick presses."
            resetAction={
              settings.confirmQuit !== DEFAULT_UNIFIED_SETTINGS.confirmQuit ? (
                <SettingResetButton
                  label="quit shortcut behavior"
                  onClick={() =>
                    updateSettings({ confirmQuit: DEFAULT_UNIFIED_SETTINGS.confirmQuit })
                  }
                />
              ) : null
            }
            control={
              <Select
                value={settings.confirmQuit}
                onValueChange={(value) => {
                  if (value === "direct" || value === "hold" || value === "double-click") {
                    updateSettings({ confirmQuit: value });
                  }
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full sm:w-40"
                  aria-label="Quit shortcut behavior"
                >
                  <SelectValue>{QUIT_CONFIRMATION_MODE_LABELS[settings.confirmQuit]}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {Object.entries(QUIT_CONFIRMATION_MODE_LABELS).map(([value, label]) => (
                    <SelectItem hideIndicator key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        ) : null}
      </SettingsSection>

      <SettingsSection id="greetings" title="Greetings">
        <SettingsRow
          serverScoped
          settingKeys={["aiGreetings"]}
          {...searchableSetting("ai-greetings")}
          description="Write the new chat greeting from what you've been working on, a few times a day with the text generation model."
          resetAction={
            settings.aiGreetings !== DEFAULT_UNIFIED_SETTINGS.aiGreetings ? (
              <SettingResetButton
                label="AI greetings"
                onClick={() =>
                  updateSettings({ aiGreetings: DEFAULT_UNIFIED_SETTINGS.aiGreetings })
                }
              />
            ) : null
          }
          control={
            <ScopedSwitch
              settingKeys={["aiGreetings"]}
              checked={settings.aiGreetings}
              onCheckedChange={(checked) => updateSettings({ aiGreetings: Boolean(checked) })}
              aria-label="AI greetings"
            />
          }
        />
      </SettingsSection>

      <SettingsSection id="about" title="About">
        {isElectron || HOSTED_APP_CHANNEL ? (
          <AboutVersionSection />
        ) : (
          <>
            <SettingsRow
              id={searchableSetting("app-version").id}
              title={<AboutVersionTitle />}
              description="Current version of the application."
            />
          </>
        )}
        <SettingsRow
          {...searchableSetting("open-source-licenses")}
          description="Notices for dependencies, assets, and optional tools used by Cogenly."
          control={
            <Button
              render={<Link to="/settings/open-source-licenses" />}
              size="sm"
              variant="outline"
            >
              View licenses
            </Button>
          }
        />
      </SettingsSection>

      <LegacyFeaturesSection />
      <RestoreDefaultsSection onRestored={onRestored} />
    </>
  );
}

export function ArchivedThreadsPanel() {
  const [query, setQuery] = useState("");
  const [projectFilter, setProjectFilter] = useState("all");
  const { scope, groups: projectGroups, environments } = useSettingsScope();
  const { unarchiveThread, confirmAndDeleteThread } = useThreadActions();
  const {
    snapshots: archivedSnapshots,
    error: archiveError,
    isLoading: isLoadingArchive,
    refresh: refreshArchivedThreads,
  } = useArchivedThreadSnapshots(scope.environmentIds);

  const { groups: archivedGroups, hasMultipleEnvironments } = useMemo(() => {
    const selectedProjectKeys =
      scope.kind === "project"
        ? new Set(scope.members.map((member) => `${member.environmentId}:${member.id}`))
        : null;
    const projectsByEnvironmentAndId = new Map(
      archivedSnapshots.flatMap(({ environmentId, snapshot }) =>
        snapshot.projects
          .filter(
            (project) =>
              selectedProjectKeys === null ||
              selectedProjectKeys.has(`${environmentId}:${project.id}`),
          )
          .map(
            (project) => [`${environmentId}:${project.id}`, { ...project, environmentId }] as const,
          ),
      ),
    );
    const environmentLabels = new Map(
      environments.map((environment) => {
        const { primary, secondary } = settingsScopeEnvironmentLabels(environment, environments);
        return [environment.environmentId, secondary ? `${primary} (${secondary})` : primary];
      }),
    );
    const threads = archivedSnapshots.flatMap(({ environmentId, snapshot }) =>
      snapshot.threads.map((thread) => ({
        ...presentThreadShell(environmentId, thread),
        environmentLabel: environmentLabels.get(environmentId) ?? environmentId,
      })),
    );
    const hasMultipleEnvironments =
      new Set(
        threads
          .filter((thread) =>
            projectsByEnvironmentAndId.has(`${thread.environmentId}:${thread.projectId}`),
          )
          .map((thread) => thread.environmentId),
      ).size > 1;
    const logicalGroupsByProjectKey = new Map(
      projectGroups.flatMap((group) =>
        group.memberProjectRefs.map(
          (member) => [`${member.environmentId}:${member.projectId}`, group] as const,
        ),
      ),
    );

    const archivedProjects = Array.from(projectsByEnvironmentAndId.values());
    const groups = new Map<
      string,
      {
        readonly project: (typeof archivedProjects)[number];
        readonly title: string;
        readonly threads: Array<(typeof threads)[number]>;
      }
    >();
    for (const project of archivedProjects) {
      const projectThreads: Array<(typeof threads)[number]> = [];
      for (const thread of threads) {
        if (thread.projectId === project.id && thread.environmentId === project.environmentId) {
          projectThreads.push(thread);
        }
      }
      if (projectThreads.length > 0) {
        const physicalProjectKey = `${project.environmentId}:${project.id}` as const;
        const logicalGroup = hasMultipleEnvironments
          ? logicalGroupsByProjectKey.get(physicalProjectKey)
          : undefined;
        const groupKey = logicalGroup?.projectKey ?? physicalProjectKey;
        const group = groups.get(groupKey);
        if (group) {
          group.threads.push(...projectThreads);
        } else {
          groups.set(groupKey, {
            project,
            title: logicalGroup?.displayName ?? project.title,
            threads: projectThreads,
          });
        }
      }
    }
    const sortedGroups = Array.from(groups, ([key, group]) => ({
      ...group,
      key,
      threads: group.threads.toSorted((left, right) => {
        const leftKey = left.archivedAt ?? left.createdAt;
        const rightKey = right.archivedAt ?? right.createdAt;
        return rightKey.localeCompare(leftKey) || right.id.localeCompare(left.id);
      }),
    }));
    return { groups: sortedGroups, hasMultipleEnvironments };
  }, [archivedSnapshots, environments, projectGroups, scope]);

  const unarchive = async (threadRef: ScopedThreadRef, title: string) => {
    const result = await unarchiveThread(threadRef);
    if (result._tag === "Success") {
      refreshArchivedThreads();
      toastManager.add(stackedThreadToast({ type: "success", title: `Unarchived ${title}` }));
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Couldn't unarchive thread",
          description: error instanceof Error ? error.message : "Try again in a moment.",
        }),
      );
    }
  };

  const deleteForGood = async (threadRef: ScopedThreadRef) => {
    const result = await confirmAndDeleteThread(threadRef);
    if (result._tag === "Success") {
      refreshArchivedThreads();
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Couldn't delete thread",
          description: error instanceof Error ? error.message : "Try again in a moment.",
        }),
      );
    }
  };

  // A filter left on a project that has since emptied falls back to every project.
  const activeProjectFilter = archivedGroups.some((group) => group.key === projectFilter)
    ? projectFilter
    : "all";
  const shownGroups = archivedGroups
    .filter((group) => activeProjectFilter === "all" || group.key === activeProjectFilter)
    .map((group) => ({
      ...group,
      threads: group.threads.filter((thread) => matchesSettingsListQuery(query, [thread.title])),
    }))
    .filter((group) => group.threads.length > 0);
  const filtered = query !== "" || activeProjectFilter !== "all";

  return (
    <>
      <SettingsSection id={searchableSetting("archive").id} title="Archived threads">
        {/* Search and filter only help once there is something to look through. */}
        {archivedGroups.length > 0 ? (
          <SettingsListToolbar>
            <SettingsListSearch label="Search archive" value={query} onValueChange={setQuery} />
            {archivedGroups.length > 1 ? (
              <SettingsListFilter
                label="Project"
                value={activeProjectFilter}
                onValueChange={setProjectFilter}
                options={[
                  { value: "all", label: "All projects" },
                  ...archivedGroups.map((group) => ({ value: group.key, label: group.title })),
                ]}
              />
            ) : null}
          </SettingsListToolbar>
        ) : null}
        {shownGroups.length === 0 ? (
          isLoadingArchive || archiveError ? (
            <SettingsRow
              title={isLoadingArchive ? "Loading archived threads…" : "Couldn't load the archive"}
              description={archiveError ?? "Checking connected machines."}
              role={isLoadingArchive ? "status" : undefined}
            />
          ) : (
            <SettingsListEmpty
              icon={<ArchiveIcon />}
              title={filtered ? "Nothing matches" : "No archived threads"}
              description={
                filtered
                  ? "Try another search or project."
                  : "Archive a thread from its menu to put it away without deleting it. Unarchive it here any time."
              }
            >
              {filtered ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setQuery("");
                    setProjectFilter("all");
                  }}
                >
                  Clear filters
                </Button>
              ) : null}
            </SettingsListEmpty>
          )
        ) : (
          shownGroups.map(({ key, project, title, threads: projectThreads }) => (
            <div key={key}>
              <SettingsRow
                title={
                  <span className="flex items-center gap-2">
                    <ProjectFavicon project={project} />
                    {title}
                  </span>
                }
              />
              <SettingsList>
                {projectThreads.map((thread) => (
                  <SettingsListItem
                    key={`${thread.environmentId}:${thread.id}`}
                    onContextMenu={(event) => {
                      const api = readLocalApi();
                      if (!api) return;
                      event.preventDefault();
                      const threadRef = scopeThreadRef(thread.environmentId, thread.id);
                      void settlePromise(async () => {
                        const clicked = await api.contextMenu.show(
                          [
                            { id: "unarchive", label: "Unarchive" },
                            { id: "delete", label: "Delete…", destructive: true },
                          ],
                          { x: event.clientX, y: event.clientY },
                        );
                        if (clicked === "unarchive") await unarchive(threadRef, thread.title);
                        if (clicked === "delete") await deleteForGood(threadRef);
                      }).then((result) => {
                        if (result._tag === "Success") return;
                        const error = squashAtomCommandFailure(result);
                        toastManager.add(
                          stackedThreadToast({
                            type: "error",
                            title: "Couldn't open the thread menu",
                            description:
                              error instanceof Error ? error.message : "Try again in a moment.",
                          }),
                        );
                      });
                    }}
                    title={thread.title}
                    description={
                      <span className={hasMultipleEnvironments ? "block truncate" : undefined}>
                        {hasMultipleEnvironments ? `${thread.environmentLabel} · ` : null}
                        Archived {formatRelativeTimeLabel(thread.archivedAt ?? thread.createdAt)}
                        {" \u00b7 Created "}
                        {formatRelativeTimeLabel(thread.createdAt)}
                      </span>
                    }
                    control={
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          type="button"
                          variant="outline"
                          size="xs"
                          onClick={() =>
                            void unarchive(
                              scopeThreadRef(thread.environmentId, thread.id),
                              thread.title,
                            )
                          }
                        >
                          <ArchiveX />
                          Unarchive
                        </Button>
                        <Button
                          type="button"
                          variant="ghost-destructive"
                          size="icon-xs"
                          aria-label={`Delete ${thread.title}`}
                          title="Delete"
                          onClick={() =>
                            void deleteForGood(scopeThreadRef(thread.environmentId, thread.id))
                          }
                        >
                          <Trash2Icon />
                        </Button>
                      </div>
                    }
                  />
                ))}
              </SettingsList>
            </div>
          ))
        )}
      </SettingsSection>
    </>
  );
}
