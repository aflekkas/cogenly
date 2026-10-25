import { SshDeviceHostConfigs } from "./device.ts";
import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  AuthProvidersManageScope,
  type AuthEnvironmentScope,
} from "./auth.ts";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import {
  ForwardCompatibleNullable,
  ForwardCompatibleOptional,
  OmittedWhenNull,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";
import { UsageLimitSourceId } from "./usageLimitSourceId.ts";
import {
  EnvironmentMachineKind,
  MachineRole,
  ThreadEnvMode,
  WorktreeSubmodules,
} from "./environment.ts";
import { KeybindingsConfig } from "./keybindings.ts";
import {
  CustomModelSetting,
  DEFAULT_TEXT_GENERATION_MODEL,
  DEFAULT_TEXT_GENERATION_REASONING_EFFORT,
  ProviderOptionSelection,
  ProviderOptionSelections,
} from "./model.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProjectScript, type ProjectMutation } from "./project.ts";
import { DEFAULT_RUNTIME_MODE, RuntimeMode } from "./providerPolicy.ts";
import { BrowserProfile, BrowserProfileId, DEFAULT_BROWSER_PROFILE_ID } from "./browserProfile.ts";
import {
  BrowserAppearanceSetting,
  DEFAULT_BROWSER_APPEARANCE_SETTING,
  DEFAULT_PREVIEW_ZOOM_FACTOR,
  FILL_PREVIEW_VIEWPORT,
  PreviewViewportSetting,
  PreviewZoomFactor,
} from "./preview.ts";
import {
  ProviderInstanceConfig,
  ProviderInstanceId,
  ProviderDriverKind,
} from "./providerInstance.ts";
import { PullRequestMergeMethod } from "./pullRequest.ts";
import { MachineHealthSettings, MachineHealthSettingsPatch } from "./machineHealthSettings.ts";

// ── Client Settings (local-only) ───────────────────────────────

export const TimestampFormat = Schema.Literals(["locale", "12-hour", "24-hour"]);
export type TimestampFormat = typeof TimestampFormat.Type;
const DEFAULT_TIMESTAMP_FORMAT: TimestampFormat = "locale";

export const DiffLayout = Schema.Literals(["stacked", "split"]);
export type DiffLayout = typeof DiffLayout.Type;
const DEFAULT_DIFF_LAYOUT: DiffLayout = "stacked";

export const SidebarProjectSortOrder = Schema.Literals(["updated_at", "created_at", "manual"]);
export type SidebarProjectSortOrder = typeof SidebarProjectSortOrder.Type;
export const DEFAULT_SIDEBAR_PROJECT_SORT_ORDER: SidebarProjectSortOrder = "updated_at";

export const SidebarThreadSortOrder = Schema.Literals(["updated_at", "created_at"]);
export type SidebarThreadSortOrder = typeof SidebarThreadSortOrder.Type;
// Not exported: mobile was the last consumer of the value itself; the
// wire field keeps its decoding default below.
const DEFAULT_SIDEBAR_THREAD_SORT_ORDER: SidebarThreadSortOrder = "updated_at";

export const SidebarProjectGroupingMode = Schema.Literals([
  "repository",
  "repository_path",
  "separate",
]);
export type SidebarProjectGroupingMode = typeof SidebarProjectGroupingMode.Type;
const DEFAULT_SIDEBAR_PROJECT_GROUPING_MODE: SidebarProjectGroupingMode = "repository";
export const MIN_SIDEBAR_THREAD_PREVIEW_COUNT = 1;
export const MAX_SIDEBAR_THREAD_PREVIEW_COUNT = 15;
export const SidebarThreadPreviewCount = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_SIDEBAR_THREAD_PREVIEW_COUNT,
    maximum: MAX_SIDEBAR_THREAD_PREVIEW_COUNT,
  }),
);
export type SidebarThreadPreviewCount = typeof SidebarThreadPreviewCount.Type;
const DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT: SidebarThreadPreviewCount = 6;
export const MIN_PANEL_ANIMATION_DURATION_MS = 0;
export const MAX_PANEL_ANIMATION_DURATION_MS = 400;
export const PanelAnimationDurationMs = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_PANEL_ANIMATION_DURATION_MS,
    maximum: MAX_PANEL_ANIMATION_DURATION_MS,
  }),
);
export type PanelAnimationDurationMs = typeof PanelAnimationDurationMs.Type;
const DEFAULT_PANEL_ANIMATION_DURATION_MS: PanelAnimationDurationMs = 0;
/**
 * Font size preferences, in CSS pixels. The ranges are deliberately narrow:
 * the interface size scales every rem-based dimension in the app, so the
 * bounds keep layouts intact rather than offering unusable extremes.
 */
export const MIN_INTERFACE_FONT_SIZE = 12;
export const MAX_INTERFACE_FONT_SIZE = 20;
export const InterfaceFontSize = Schema.Int.check(
  Schema.isBetween({ minimum: MIN_INTERFACE_FONT_SIZE, maximum: MAX_INTERFACE_FONT_SIZE }),
);
export type InterfaceFontSize = typeof InterfaceFontSize.Type;
export const DEFAULT_INTERFACE_FONT_SIZE: InterfaceFontSize = 16;

export const MIN_PROMPT_FONT_SIZE = 12;
export const MAX_PROMPT_FONT_SIZE = 20;
export const PromptFontSize = Schema.Int.check(
  Schema.isBetween({ minimum: MIN_PROMPT_FONT_SIZE, maximum: MAX_PROMPT_FONT_SIZE }),
);
export type PromptFontSize = typeof PromptFontSize.Type;
export const DEFAULT_PROMPT_FONT_SIZE: PromptFontSize = 14;

export const MIN_CODE_FONT_SIZE = 10;
export const MAX_CODE_FONT_SIZE = 18;
export const CodeFontSize = Schema.Int.check(
  Schema.isBetween({ minimum: MIN_CODE_FONT_SIZE, maximum: MAX_CODE_FONT_SIZE }),
);
export type CodeFontSize = typeof CodeFontSize.Type;
export const DEFAULT_CODE_FONT_SIZE: CodeFontSize = 13;

export const MIN_TERMINAL_FONT_SIZE = 8;
export const MAX_TERMINAL_FONT_SIZE = 20;
export const TerminalFontSize = Schema.Int.check(
  Schema.isBetween({ minimum: MIN_TERMINAL_FONT_SIZE, maximum: MAX_TERMINAL_FONT_SIZE }),
);
export type TerminalFontSize = typeof TerminalFontSize.Type;
const DEFAULT_TERMINAL_FONT_SIZE: TerminalFontSize = 12;

export const EnvironmentIdentificationMode = Schema.Literals(["artwork", "pill", "none"]);
export type EnvironmentIdentificationMode = typeof EnvironmentIdentificationMode.Type;
export const DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE: EnvironmentIdentificationMode = "artwork";

export const NotificationMode = Schema.Literals([
  "off",
  "notifications",
  "sound",
  "notifications-and-sound",
]);
export type NotificationMode = typeof NotificationMode.Type;

export const QuitConfirmationMode = Schema.Literals(["direct", "hold", "double-click"]);
export type QuitConfirmationMode = typeof QuitConfirmationMode.Type;
const DEFAULT_QUIT_CONFIRMATION_MODE: QuitConfirmationMode = "hold";

const LegacyConfirmQuit = Schema.Boolean.pipe(
  Schema.decodeTo(
    QuitConfirmationMode,
    SchemaTransformation.transform({
      decode: (confirmQuit): QuitConfirmationMode => (confirmQuit ? "hold" : "direct"),
      encode: (mode) => mode === "hold",
    }),
  ),
);

const QuitConfirmationModeSetting = Schema.Union([QuitConfirmationMode, LegacyConfirmQuit]);

export const DEFAULT_BROWSER_VIEWPORT: PreviewViewportSetting = FILL_PREVIEW_VIEWPORT;
export const BROWSER_RECORDING_FRAME_RATES = [30, 60] as const;
export const BrowserRecordingFrameRate = Schema.Literals(BROWSER_RECORDING_FRAME_RATES);
export type BrowserRecordingFrameRate = typeof BrowserRecordingFrameRate.Type;
export const DEFAULT_BROWSER_RECORDING_FRAME_RATE: BrowserRecordingFrameRate = 30;
/**
 * Where a clicked link goes: the OS default browser, or a tab in the in-app
 * browser beside the thread. "system" is the default because that is what
 * every link did before the setting existed.
 */
export const BrowserLinkTarget = Schema.Literals(["system", "app"]);
export type BrowserLinkTarget = typeof BrowserLinkTarget.Type;
export const DEFAULT_BROWSER_LINK_TARGET: BrowserLinkTarget = "system";

export const LoadBalancingWeights = Schema.Record(
  TrimmedNonEmptyString,
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
);

export const DiffColorScheme = Schema.Literals(["red-green", "blue-orange"]);

/** Maximum width of the chat timeline and composer on wide screens. */
export const ChatWidth = Schema.Literals(["comfortable", "wide", "full"]);
export type ChatWidth = typeof ChatWidth.Type;

/** Preferences shared by clients connected to the same environment. */
export const ModelFavorite = Schema.Struct({
  // The historical field name is retained; default instance ids also decode old provider-kind favorites.
  provider: ProviderInstanceId,
  model: TrimmedNonEmptyString,
});
export const ModelFavorites = Schema.Array(ModelFavorite);
export const ProviderModelPreferences = Schema.Record(
  ProviderInstanceId,
  Schema.Struct({
    hiddenModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
    modelOrder: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  }),
);
/**
 * The reasoning effort a model starts at, per provider instance and model slug,
 * overriding the catalog default. Stores the option id with the value (each
 * provider names its effort option differently) so the server can apply it to
 * work started without one, such as agents and MCP launches.
 */
export const ModelEffortDefaults = Schema.Record(
  ProviderInstanceId,
  Schema.Record(TrimmedNonEmptyString, ProviderOptionSelection),
);
export type ModelEffortDefaults = typeof ModelEffortDefaults.Type;

export type ModelPreferences = {
  readonly favorites: typeof ModelFavorites.Type;
  readonly providerModelPreferences: typeof ProviderModelPreferences.Type;
};

export const ClientSettingsSchema = Schema.Struct({
  notificationMode: NotificationMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("off" as const)),
  ),
  inAppNotificationsEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  diffColorScheme: DiffColorScheme.pipe(
    Schema.withDecodingDefault(Effect.succeed("red-green" as const)),
  ),
  chatWidth: ChatWidth.pipe(Schema.withDecodingDefault(Effect.succeed("comfortable" as const))),
  loadBalancingEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  loadBalancingWeights: LoadBalancingWeights.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  // No longer user-configurable: panels always animate. Still decoded so
  // previously stored client settings load; the value is ignored.
  panelAnimationDurationMs: PanelAnimationDurationMs.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PANEL_ANIMATION_DURATION_MS)),
  ),
  browserDefaultViewport: PreviewViewportSetting.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BROWSER_VIEWPORT)),
  ),
  browserDefaultZoomFactor: PreviewZoomFactor.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PREVIEW_ZOOM_FACTOR)),
  ),
  browserDefaultAppearance: BrowserAppearanceSetting.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BROWSER_APPEARANCE_SETTING)),
  ),
  browserRecordingFrameRate: BrowserRecordingFrameRate.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BROWSER_RECORDING_FRAME_RATE)),
  ),
  browserRecordingShowKeyPresses: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  browserRecordingShowMousePresses: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  /**
   * Where links clicked in a thread (chat markdown, terminal output) open.
   * Only the desktop app has an in-app browser, so other clients ignore "app".
   */
  browserLinkTarget: BrowserLinkTarget.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BROWSER_LINK_TARGET)),
  ),
  /**
   * User-created browser profiles. The built-in Default and Incognito profiles
   * are synthesized by `resolveBrowserProfiles`, not stored here, so they
   * cannot be renamed away or deleted.
   */
  browserProfiles: Schema.Array(BrowserProfile).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** Profile new tabs open under. Falls back to Default if it no longer exists. */
  browserDefaultProfileId: BrowserProfileId.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BROWSER_PROFILE_ID)),
  ),
  // Desktop-only. Boolean values from older settings files decode to their
  // equivalent mode and encode back as the canonical string value.
  confirmQuit: QuitConfirmationModeSetting.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_QUIT_CONFIRMATION_MODE)),
  ),
  confirmThreadArchive: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  confirmThreadDelete: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  confirmThreadUnpin: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  dismissedProviderUpdateNotificationKeys: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  diffFilesCollapsed: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  diffIgnoreWhitespace: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  diffLayout: DiffLayout.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_DIFF_LAYOUT))),
  environmentIdentificationMode: EnvironmentIdentificationMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE)),
  ),
  fontSizeInterface: InterfaceFontSize.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_INTERFACE_FONT_SIZE)),
  ),
  fontSizePrompt: PromptFontSize.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROMPT_FONT_SIZE)),
  ),
  fontSizeCode: CodeFontSize.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_CODE_FONT_SIZE)),
  ),
  fontSizeTerminal: TerminalFontSize.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_TERMINAL_FONT_SIZE)),
  ),
  // Grayscale `-webkit-font-smoothing: antialiased` (thinner strokes);
  // disabling restores the platform's heavier default. No effect off macOS.
  fontSmoothing: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  // When the first-run welcome wizard finished (or was skipped), as an ISO
  // timestamp. `null` alone does not mean "show the wizard" — every install
  // that predates this field decodes to `null` — so the gate also requires an
  // empty workspace before it treats the client as a fresh install.
  onboardingCompletedAt: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  persistComposerContextStrip: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  // Legacy client values retained for migration to the connected environment.
  favorites: ModelFavorites.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  providerModelPreferences: ProviderModelPreferences.pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  // Legacy plan mode. The composer's Build/Plan toggle was removed from the
  // default UI; this beta flag restores it (plus the /plan and /default slash
  // commands) for users who still rely on the old workflow.
  planModeEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  // Legacy context window meter. The composer hides it by default; users who
  // still want the old usage indicator can restore it from Settings.
  contextWindowMeterEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  // Rich text is the default; users can opt out for literal Markdown editing.
  composerRichTextEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  // Composer mic button and shortcut, on macOS desktop builds that can transcribe on device.
  dictationEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  sendShortcut: Schema.Literals(["enter", "mod-enter-multiline", "mod-enter"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("enter")),
  ),
  // Steering is the default; users who explicitly chose "queue" keep it.
  followUpBehavior: Schema.Literals(["queue", "steer"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("steer")),
  ),
  proactivePanelsEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  showSkillsInSlashMenu: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  // Legacy sidebar (the original per-project tree). Deliberately a fresh key
  // (was `sidebarV2Enabled` + `sidebarV2ConfiguredByUser`): decoding drops the
  // old keys, so everyone, including prior beta opt-outs, resets to the new
  // default sidebar.
  legacySidebarEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  // Beta: working and monitoring threads fold into a Working shelf and return
  // to the top of the inbox once they need the user. The inbox then orders by
  // time, so manual placement there is ignored (and kept) while it is on.
  sidebarWorkingShelfEnabled: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  sidebarProjectGroupingMode: SidebarProjectGroupingMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_PROJECT_GROUPING_MODE)),
  ),
  sidebarProjectGroupingOverrides: Schema.Record(
    TrimmedNonEmptyString,
    SidebarProjectGroupingMode,
  ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  sidebarProjectSortOrder: SidebarProjectSortOrder.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_PROJECT_SORT_ORDER)),
  ),
  sidebarThreadSortOrder: SidebarThreadSortOrder.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_THREAD_SORT_ORDER)),
  ),
  sidebarThreadPreviewCount: SidebarThreadPreviewCount.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT)),
  ),
  timestampFormat: TimestampFormat.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_TIMESTAMP_FORMAT)),
  ),
  wordWrap: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type ClientSettings = typeof ClientSettingsSchema.Type;

export const DEFAULT_CLIENT_SETTINGS: ClientSettings = Schema.decodeSync(ClientSettingsSchema)({});

/** Portable client preferences keep a local cache, but each has its own shared field. */
export const UNIVERSAL_CLIENT_SETTING_BINDINGS = {
  notificationMode: "clientNotificationMode",
  inAppNotificationsEnabled: "clientInAppNotificationsEnabled",
  diffColorScheme: "clientDiffColorScheme",
  chatWidth: "clientChatWidth",
  confirmQuit: "clientConfirmQuit",
  confirmThreadArchive: "clientConfirmThreadArchive",
  confirmThreadDelete: "clientConfirmThreadDelete",
  confirmThreadUnpin: "clientConfirmThreadUnpin",
  diffFilesCollapsed: "clientDiffFilesCollapsed",
  diffIgnoreWhitespace: "clientDiffIgnoreWhitespace",
  diffLayout: "clientDiffLayout",
  environmentIdentificationMode: "clientEnvironmentIdentificationMode",
  fontSizeInterface: "clientFontSizeInterface",
  fontSizePrompt: "clientFontSizePrompt",
  fontSizeCode: "clientFontSizeCode",
  fontSizeTerminal: "clientFontSizeTerminal",
  fontSmoothing: "clientFontSmoothing",
  persistComposerContextStrip: "clientPersistComposerContextStrip",
  planModeEnabled: "clientPlanModeEnabled",
  contextWindowMeterEnabled: "clientContextWindowMeterEnabled",
  composerRichTextEnabled: "clientComposerRichTextEnabled",
  dictationEnabled: "clientDictationEnabled",
  sendShortcut: "clientSendShortcut",
  followUpBehavior: "clientFollowUpBehavior",
  proactivePanelsEnabled: "clientProactivePanelsEnabled",
  showSkillsInSlashMenu: "clientShowSkillsInSlashMenu",
  legacySidebarEnabled: "clientLegacySidebarEnabled",
  sidebarWorkingShelfEnabled: "clientSidebarWorkingShelfEnabled",
  sidebarProjectGroupingMode: "clientSidebarProjectGroupingMode",
  sidebarProjectSortOrder: "clientSidebarProjectSortOrder",
  sidebarThreadSortOrder: "clientSidebarThreadSortOrder",
  sidebarThreadPreviewCount: "clientSidebarThreadPreviewCount",
  timestampFormat: "clientTimestampFormat",
  wordWrap: "clientWordWrap",
} as const;

export const UniversalClientPreferenceValues = Schema.Struct({
  clientAppearanceMode: Schema.NullOr(Schema.Literals(["light", "dark", "system"])),
  clientAppearanceAccent: Schema.NullOr(
    Schema.Literals(["orange", "blue", "violet", "green", "pink", "teal", "amber", "red"]),
  ),
  clientAppearanceFontSize: Schema.NullOr(Schema.Literals(["small", "default", "large"])),
  clientAppearanceMotion: Schema.NullOr(Schema.Literals(["system", "reduce"])),
  clientAppearanceUsageMeter: Schema.NullOr(Schema.Literals(["remaining", "used"])),
  clientNotificationMode: Schema.NullOr(ClientSettingsSchema.fields.notificationMode),
  clientInAppNotificationsEnabled: Schema.NullOr(
    ClientSettingsSchema.fields.inAppNotificationsEnabled,
  ),
  clientDiffColorScheme: Schema.NullOr(ClientSettingsSchema.fields.diffColorScheme),
  clientChatWidth: Schema.NullOr(ClientSettingsSchema.fields.chatWidth),
  clientConfirmQuit: Schema.NullOr(ClientSettingsSchema.fields.confirmQuit),
  clientConfirmThreadArchive: Schema.NullOr(ClientSettingsSchema.fields.confirmThreadArchive),
  clientConfirmThreadDelete: Schema.NullOr(ClientSettingsSchema.fields.confirmThreadDelete),
  clientConfirmThreadUnpin: Schema.NullOr(ClientSettingsSchema.fields.confirmThreadUnpin),
  clientDiffFilesCollapsed: Schema.NullOr(ClientSettingsSchema.fields.diffFilesCollapsed),
  clientDiffIgnoreWhitespace: Schema.NullOr(ClientSettingsSchema.fields.diffIgnoreWhitespace),
  clientDiffLayout: Schema.NullOr(ClientSettingsSchema.fields.diffLayout),
  clientEnvironmentIdentificationMode: Schema.NullOr(
    ClientSettingsSchema.fields.environmentIdentificationMode,
  ),
  clientFontSizeInterface: Schema.NullOr(ClientSettingsSchema.fields.fontSizeInterface),
  clientFontSizePrompt: Schema.NullOr(ClientSettingsSchema.fields.fontSizePrompt),
  clientFontSizeCode: Schema.NullOr(ClientSettingsSchema.fields.fontSizeCode),
  clientFontSizeTerminal: Schema.NullOr(ClientSettingsSchema.fields.fontSizeTerminal),
  clientFontSmoothing: Schema.NullOr(ClientSettingsSchema.fields.fontSmoothing),
  clientPersistComposerContextStrip: Schema.NullOr(
    ClientSettingsSchema.fields.persistComposerContextStrip,
  ),
  clientPlanModeEnabled: Schema.NullOr(ClientSettingsSchema.fields.planModeEnabled),
  clientContextWindowMeterEnabled: Schema.NullOr(
    ClientSettingsSchema.fields.contextWindowMeterEnabled,
  ),
  clientComposerRichTextEnabled: Schema.NullOr(ClientSettingsSchema.fields.composerRichTextEnabled),
  clientDictationEnabled: Schema.NullOr(ClientSettingsSchema.fields.dictationEnabled),
  clientSendShortcut: Schema.NullOr(ClientSettingsSchema.fields.sendShortcut),
  clientFollowUpBehavior: Schema.NullOr(ClientSettingsSchema.fields.followUpBehavior),
  clientProactivePanelsEnabled: Schema.NullOr(ClientSettingsSchema.fields.proactivePanelsEnabled),
  clientShowSkillsInSlashMenu: Schema.NullOr(ClientSettingsSchema.fields.showSkillsInSlashMenu),
  clientLegacySidebarEnabled: Schema.NullOr(ClientSettingsSchema.fields.legacySidebarEnabled),
  clientSidebarWorkingShelfEnabled: Schema.NullOr(
    ClientSettingsSchema.fields.sidebarWorkingShelfEnabled,
  ),
  clientSidebarProjectGroupingMode: Schema.NullOr(
    ClientSettingsSchema.fields.sidebarProjectGroupingMode,
  ),
  clientSidebarProjectSortOrder: Schema.NullOr(ClientSettingsSchema.fields.sidebarProjectSortOrder),
  clientSidebarThreadSortOrder: Schema.NullOr(ClientSettingsSchema.fields.sidebarThreadSortOrder),
  clientSidebarThreadPreviewCount: Schema.NullOr(
    ClientSettingsSchema.fields.sidebarThreadPreviewCount,
  ),
  clientTimestampFormat: Schema.NullOr(ClientSettingsSchema.fields.timestampFormat),
  clientWordWrap: Schema.NullOr(ClientSettingsSchema.fields.wordWrap),
});
export const UNIVERSAL_CLIENT_PREFERENCE_KEYS = Object.keys(
  UniversalClientPreferenceValues.fields,
) as Array<keyof typeof UniversalClientPreferenceValues.fields>;
const UniversalClientPreferenceDefaults = {
  clientAppearanceMode: UniversalClientPreferenceValues.fields.clientAppearanceMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  clientAppearanceAccent: UniversalClientPreferenceValues.fields.clientAppearanceAccent.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  clientAppearanceFontSize: UniversalClientPreferenceValues.fields.clientAppearanceFontSize.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  clientAppearanceMotion: UniversalClientPreferenceValues.fields.clientAppearanceMotion.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  clientAppearanceUsageMeter:
    UniversalClientPreferenceValues.fields.clientAppearanceUsageMeter.pipe(
      Schema.withDecodingDefault(Effect.succeed(null)),
    ),
  clientNotificationMode: UniversalClientPreferenceValues.fields.clientNotificationMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  clientInAppNotificationsEnabled:
    UniversalClientPreferenceValues.fields.clientInAppNotificationsEnabled.pipe(
      Schema.withDecodingDefault(Effect.succeed(null)),
    ),
  clientDiffColorScheme: UniversalClientPreferenceValues.fields.clientDiffColorScheme.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  clientChatWidth: UniversalClientPreferenceValues.fields.clientChatWidth.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  clientConfirmQuit: UniversalClientPreferenceValues.fields.clientConfirmQuit.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  clientConfirmThreadArchive:
    UniversalClientPreferenceValues.fields.clientConfirmThreadArchive.pipe(
      Schema.withDecodingDefault(Effect.succeed(null)),
    ),
  clientConfirmThreadDelete: UniversalClientPreferenceValues.fields.clientConfirmThreadDelete.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  clientConfirmThreadUnpin: UniversalClientPreferenceValues.fields.clientConfirmThreadUnpin.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  clientDiffFilesCollapsed: UniversalClientPreferenceValues.fields.clientDiffFilesCollapsed.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  clientDiffIgnoreWhitespace:
    UniversalClientPreferenceValues.fields.clientDiffIgnoreWhitespace.pipe(
      Schema.withDecodingDefault(Effect.succeed(null)),
    ),
  clientDiffLayout: UniversalClientPreferenceValues.fields.clientDiffLayout.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  clientEnvironmentIdentificationMode:
    UniversalClientPreferenceValues.fields.clientEnvironmentIdentificationMode.pipe(
      Schema.withDecodingDefault(Effect.succeed(null)),
    ),
  clientFontSizeInterface: UniversalClientPreferenceValues.fields.clientFontSizeInterface.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  clientFontSizePrompt: UniversalClientPreferenceValues.fields.clientFontSizePrompt.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  clientFontSizeCode: UniversalClientPreferenceValues.fields.clientFontSizeCode.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  clientFontSizeTerminal: UniversalClientPreferenceValues.fields.clientFontSizeTerminal.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  clientFontSmoothing: UniversalClientPreferenceValues.fields.clientFontSmoothing.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  clientPersistComposerContextStrip:
    UniversalClientPreferenceValues.fields.clientPersistComposerContextStrip.pipe(
      Schema.withDecodingDefault(Effect.succeed(null)),
    ),
  clientPlanModeEnabled: UniversalClientPreferenceValues.fields.clientPlanModeEnabled.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  clientContextWindowMeterEnabled:
    UniversalClientPreferenceValues.fields.clientContextWindowMeterEnabled.pipe(
      Schema.withDecodingDefault(Effect.succeed(null)),
    ),
  clientComposerRichTextEnabled:
    UniversalClientPreferenceValues.fields.clientComposerRichTextEnabled.pipe(
      Schema.withDecodingDefault(Effect.succeed(null)),
    ),
  clientDictationEnabled: UniversalClientPreferenceValues.fields.clientDictationEnabled.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  clientSendShortcut: UniversalClientPreferenceValues.fields.clientSendShortcut.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  clientFollowUpBehavior: UniversalClientPreferenceValues.fields.clientFollowUpBehavior.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  clientProactivePanelsEnabled:
    UniversalClientPreferenceValues.fields.clientProactivePanelsEnabled.pipe(
      Schema.withDecodingDefault(Effect.succeed(null)),
    ),
  clientShowSkillsInSlashMenu:
    UniversalClientPreferenceValues.fields.clientShowSkillsInSlashMenu.pipe(
      Schema.withDecodingDefault(Effect.succeed(null)),
    ),
  clientLegacySidebarEnabled:
    UniversalClientPreferenceValues.fields.clientLegacySidebarEnabled.pipe(
      Schema.withDecodingDefault(Effect.succeed(null)),
    ),
  clientSidebarWorkingShelfEnabled:
    UniversalClientPreferenceValues.fields.clientSidebarWorkingShelfEnabled.pipe(
      Schema.withDecodingDefault(Effect.succeed(null)),
    ),
  clientSidebarProjectGroupingMode:
    UniversalClientPreferenceValues.fields.clientSidebarProjectGroupingMode.pipe(
      Schema.withDecodingDefault(Effect.succeed(null)),
    ),
  clientSidebarProjectSortOrder:
    UniversalClientPreferenceValues.fields.clientSidebarProjectSortOrder.pipe(
      Schema.withDecodingDefault(Effect.succeed(null)),
    ),
  clientSidebarThreadSortOrder:
    UniversalClientPreferenceValues.fields.clientSidebarThreadSortOrder.pipe(
      Schema.withDecodingDefault(Effect.succeed(null)),
    ),
  clientSidebarThreadPreviewCount:
    UniversalClientPreferenceValues.fields.clientSidebarThreadPreviewCount.pipe(
      Schema.withDecodingDefault(Effect.succeed(null)),
    ),
  clientTimestampFormat: UniversalClientPreferenceValues.fields.clientTimestampFormat.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  clientWordWrap: UniversalClientPreferenceValues.fields.clientWordWrap.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
};
export const UniversalClientPreferencePatch = Schema.Struct({
  clientAppearanceMode: Schema.optionalKey(
    UniversalClientPreferenceValues.fields.clientAppearanceMode,
  ),
  clientAppearanceAccent: Schema.optionalKey(
    UniversalClientPreferenceValues.fields.clientAppearanceAccent,
  ),
  clientAppearanceFontSize: Schema.optionalKey(
    UniversalClientPreferenceValues.fields.clientAppearanceFontSize,
  ),
  clientAppearanceMotion: Schema.optionalKey(
    UniversalClientPreferenceValues.fields.clientAppearanceMotion,
  ),
  clientAppearanceUsageMeter: Schema.optionalKey(
    UniversalClientPreferenceValues.fields.clientAppearanceUsageMeter,
  ),
  clientNotificationMode: Schema.optionalKey(
    UniversalClientPreferenceValues.fields.clientNotificationMode,
  ),
  clientInAppNotificationsEnabled: Schema.optionalKey(
    UniversalClientPreferenceValues.fields.clientInAppNotificationsEnabled,
  ),
  clientDiffColorScheme: Schema.optionalKey(
    UniversalClientPreferenceValues.fields.clientDiffColorScheme,
  ),
  clientChatWidth: Schema.optionalKey(UniversalClientPreferenceValues.fields.clientChatWidth),
  clientConfirmQuit: Schema.optionalKey(UniversalClientPreferenceValues.fields.clientConfirmQuit),
  clientConfirmThreadArchive: Schema.optionalKey(
    UniversalClientPreferenceValues.fields.clientConfirmThreadArchive,
  ),
  clientConfirmThreadDelete: Schema.optionalKey(
    UniversalClientPreferenceValues.fields.clientConfirmThreadDelete,
  ),
  clientConfirmThreadUnpin: Schema.optionalKey(
    UniversalClientPreferenceValues.fields.clientConfirmThreadUnpin,
  ),
  clientDiffFilesCollapsed: Schema.optionalKey(
    UniversalClientPreferenceValues.fields.clientDiffFilesCollapsed,
  ),
  clientDiffIgnoreWhitespace: Schema.optionalKey(
    UniversalClientPreferenceValues.fields.clientDiffIgnoreWhitespace,
  ),
  clientDiffLayout: Schema.optionalKey(UniversalClientPreferenceValues.fields.clientDiffLayout),
  clientEnvironmentIdentificationMode: Schema.optionalKey(
    UniversalClientPreferenceValues.fields.clientEnvironmentIdentificationMode,
  ),
  clientFontSizeInterface: Schema.optionalKey(
    UniversalClientPreferenceValues.fields.clientFontSizeInterface,
  ),
  clientFontSizePrompt: Schema.optionalKey(
    UniversalClientPreferenceValues.fields.clientFontSizePrompt,
  ),
  clientFontSizeCode: Schema.optionalKey(UniversalClientPreferenceValues.fields.clientFontSizeCode),
  clientFontSizeTerminal: Schema.optionalKey(
    UniversalClientPreferenceValues.fields.clientFontSizeTerminal,
  ),
  clientFontSmoothing: Schema.optionalKey(
    UniversalClientPreferenceValues.fields.clientFontSmoothing,
  ),
  clientPersistComposerContextStrip: Schema.optionalKey(
    UniversalClientPreferenceValues.fields.clientPersistComposerContextStrip,
  ),
  clientPlanModeEnabled: Schema.optionalKey(
    UniversalClientPreferenceValues.fields.clientPlanModeEnabled,
  ),
  clientContextWindowMeterEnabled: Schema.optionalKey(
    UniversalClientPreferenceValues.fields.clientContextWindowMeterEnabled,
  ),
  clientComposerRichTextEnabled: Schema.optionalKey(
    UniversalClientPreferenceValues.fields.clientComposerRichTextEnabled,
  ),
  clientDictationEnabled: Schema.optionalKey(
    UniversalClientPreferenceValues.fields.clientDictationEnabled,
  ),
  clientSendShortcut: Schema.optionalKey(UniversalClientPreferenceValues.fields.clientSendShortcut),
  clientFollowUpBehavior: Schema.optionalKey(
    UniversalClientPreferenceValues.fields.clientFollowUpBehavior,
  ),
  clientProactivePanelsEnabled: Schema.optionalKey(
    UniversalClientPreferenceValues.fields.clientProactivePanelsEnabled,
  ),
  clientShowSkillsInSlashMenu: Schema.optionalKey(
    UniversalClientPreferenceValues.fields.clientShowSkillsInSlashMenu,
  ),
  clientLegacySidebarEnabled: Schema.optionalKey(
    UniversalClientPreferenceValues.fields.clientLegacySidebarEnabled,
  ),
  clientSidebarWorkingShelfEnabled: Schema.optionalKey(
    UniversalClientPreferenceValues.fields.clientSidebarWorkingShelfEnabled,
  ),
  clientSidebarProjectGroupingMode: Schema.optionalKey(
    UniversalClientPreferenceValues.fields.clientSidebarProjectGroupingMode,
  ),
  clientSidebarProjectSortOrder: Schema.optionalKey(
    UniversalClientPreferenceValues.fields.clientSidebarProjectSortOrder,
  ),
  clientSidebarThreadSortOrder: Schema.optionalKey(
    UniversalClientPreferenceValues.fields.clientSidebarThreadSortOrder,
  ),
  clientSidebarThreadPreviewCount: Schema.optionalKey(
    UniversalClientPreferenceValues.fields.clientSidebarThreadPreviewCount,
  ),
  clientTimestampFormat: Schema.optionalKey(
    UniversalClientPreferenceValues.fields.clientTimestampFormat,
  ),
  clientWordWrap: Schema.optionalKey(UniversalClientPreferenceValues.fields.clientWordWrap),
});

// ── Server Settings (server-authoritative) ────────────────────

/** A binary path setting that decodes empty input to the provider's default executable. */
export const makeBinaryPathSetting = (fallback: string) =>
  TrimmedString.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transformEffect({
        decode: (value) => Effect.succeed(value || fallback),
        encode: (value) => Effect.succeed(value),
      }),
    ),
    Schema.withDecodingDefault(Effect.succeed(fallback)),
  );

export type ProviderSettingsFormControl = "text" | "password" | "textarea" | "switch" | "select";

export interface ProviderSettingsFormOption {
  readonly value: string;
  readonly label: string;
}

export interface ProviderSettingsFormAnnotation {
  readonly control?: ProviderSettingsFormControl | undefined;
  readonly placeholder?: string | undefined;
  readonly hidden?: boolean | undefined;
  readonly clearWhenEmpty?: "omit" | "persist" | undefined;
  /** Choices for a `select` control. The first entry is the default. */
  readonly options?: ReadonlyArray<ProviderSettingsFormOption> | undefined;
}

/** Secret fields declared by a settings schema, shared by persistence and client redaction. */
export function secretSettingsFields(schema: {
  readonly fields: Readonly<Record<string, Schema.Top>>;
}): ReadonlyArray<string> {
  return Object.entries(schema.fields).flatMap(([field, fieldSchema]) => {
    return isSecretSetting(fieldSchema) ? [field] : [];
  });
}

export interface ProviderSettingsFormSchemaAnnotation {
  readonly order?: readonly string[] | undefined;
}

declare module "effect/Schema" {
  namespace Annotations {
    interface Annotations {
      /** Store this credential separately and expose only whether it is configured to clients. */
      readonly settingsSecret?: boolean | undefined;
      readonly providerSettingsForm?: ProviderSettingsFormAnnotation | undefined;
      readonly providerSettingsFormSchema?: ProviderSettingsFormSchemaAnnotation | undefined;
    }
  }
}

/** Mark a string or a record of strings as a credential in its settings schema. */
export function secretSetting<S extends Schema.Top>(schema: S): S["Rebuild"] {
  return schema.annotateKey({ settingsSecret: true });
}

export function isSecretSetting(schema: Schema.Top): boolean {
  const annotations = Schema.resolveAnnotationsKey(schema) ?? Schema.resolveAnnotations(schema);
  return annotations?.settingsSecret === true;
}

export type ProviderSettingsOrder<Fields extends Schema.Struct.Fields> = readonly Extract<
  keyof Fields,
  string
>[];

/** A provider settings struct whose fields the settings form renders in `order`. */
export function makeProviderSettingsSchema<const Fields extends Schema.Struct.Fields>(
  fields: Fields,
  options?: {
    readonly order?: ProviderSettingsOrder<Fields> | undefined;
  },
): Schema.Struct<Fields> {
  return Schema.Struct(fields).pipe(
    Schema.annotate({
      providerSettingsFormSchema:
        options?.order === undefined ? undefined : { order: options.order },
    }),
  );
}

export const CodexSettings = makeProviderSettingsSchema(
  {
    setupMode: Schema.optionalKey(Schema.Literals(["managed", "existing"])).pipe(
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("codex").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Codex binary used by this instance.",
        providerSettingsForm: { placeholder: "codex", clearWhenEmpty: "omit" },
      }),
    ),
    homePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "CODEX_HOME path",
        description: "Custom Codex home and config directory.",
        providerSettingsForm: {
          placeholder: "~/.codex",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    shadowHomePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Shadow home path",
        description:
          "Account-specific Codex home. Keeps auth.json separate while sharing state from CODEX_HOME.",
        providerSettingsForm: {
          placeholder: "~/.codex-t3/personal",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    launchArgs: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Launch arguments",
        description: "Additional CLI arguments passed to codex app-server on session start.",
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "homePath", "shadowHomePath", "launchArgs"],
  },
);
export type CodexSettings = typeof CodexSettings.Type;

// Empty, or an integer from 100,000 to 1,000,000. Shared by the full
// Claude settings schema and its patch so an out-of-range value fails at
// the update that introduced it.
const CLAUDE_AUTO_COMPACT_WINDOW_PATTERN = /^(?:|[1-9]\d{5}|1000000)$/;

export const ClaudeSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("claude").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Claude binary used by this instance.",
        providerSettingsForm: { placeholder: "claude", clearWhenEmpty: "omit" },
      }),
    ),
    homePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "CLAUDE_CONFIG_DIR path",
        description:
          "Custom Claude home and config directory. Keeps .claude.json and .claude separate.",
        providerSettingsForm: { placeholder: "~/.claude", clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    launchArgs: Schema.String.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Launch arguments",
        description: "Additional CLI arguments passed on session start.",
        providerSettingsForm: {
          placeholder: "e.g. --chrome",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    autoCompactWindow: TrimmedString.check(
      Schema.isPattern(CLAUDE_AUTO_COMPACT_WINDOW_PATTERN),
    ).pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Auto-compact after",
        description:
          "Compact after 100,000 to 1,000,000 tokens. Leave empty to use Claude's default.",
        providerSettingsForm: {
          placeholder: "e.g. 300000",
          clearWhenEmpty: "omit",
        },
      }),
    ),
  },
  {
    order: ["binaryPath", "homePath", "autoCompactWindow", "launchArgs"],
  },
);
export type ClaudeSettings = typeof ClaudeSettings.Type;

/**
 * A read-only quota source outside this environment's provider CLIs. The
 * only kind today is a CLIProxyAPI hub, whose management API reports the
 * windows of every pooled account. The key travels in settings for now, like
 * provider environment secrets; it is redacted before reaching a client.
 */
export const UsageLimitSourceConfig = Schema.Struct({
  kind: Schema.Literal("cliproxy"),
  label: Schema.optional(TrimmedNonEmptyString),
  url: TrimmedNonEmptyString,
  managementKey: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed("")), secretSetting),
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type UsageLimitSourceConfig = typeof UsageLimitSourceConfig.Type;

/** A GitHub host name, lowercased on decode so `GitHub.com` and `github.com` are one entry. */
export const GitHubHost = TrimmedNonEmptyString.pipe(
  Schema.decodeTo(Schema.String, SchemaTransformation.toLowerCase()),
);

/**
 * One source control host's saved settings. Each host package declares the fields it reads in
 * its client definition's settings schema and decodes this blob with it; the environment stores
 * it whole, so a host this build does not ship keeps its settings. A field annotated as a secret
 * holds a string, or a string per server host, whose value lives in the server's secret store:
 * settings and clients only see a redaction marker for a saved one.
 */
export const SourceControlHostSettings = Schema.Record(Schema.String, Schema.Unknown);
export type SourceControlHostSettings = typeof SourceControlHostSettings.Type;

export const ObservabilitySettings = Schema.Struct({
  otlpTracesUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  otlpMetricsUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  otlpLogsUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type ObservabilitySettings = typeof ObservabilitySettings.Type;

export const SourceControlWritingStyleMode = Schema.Literals([
  "repo_conventions",
  "conventional_commits",
  "custom",
]);
export type SourceControlWritingStyleMode = typeof SourceControlWritingStyleMode.Type;

export const SourceControlWritingStyleSettings = Schema.Struct({
  mode: SourceControlWritingStyleMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("repo_conventions" as const)),
  ),
  customInstructions: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  followChangeRequestTemplates: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
});
export type SourceControlWritingStyleSettings = typeof SourceControlWritingStyleSettings.Type;

export const BranchNamingMode = Schema.Literals(["static", "semantic", "custom"]);
export type BranchNamingMode = typeof BranchNamingMode.Type;

export interface BranchNamingOptions {
  mode: BranchNamingMode;
  prefix: string;
  instructions: string;
}

export const DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL = Duration.seconds(30);
export const DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL = Duration.minutes(5);

export const BackgroundActivityProfile = Schema.Literals([
  "balanced",
  "performance",
  "battery-saver",
]);
export type BackgroundActivityProfile = typeof BackgroundActivityProfile.Type;
export const DEFAULT_BACKGROUND_ACTIVITY_PROFILE: BackgroundActivityProfile = "balanced";

export const BackgroundActivityProfileSelection = Schema.Literals([
  "balanced",
  "performance",
  "battery-saver",
  "custom",
]);
export type BackgroundActivityProfileSelection = typeof BackgroundActivityProfileSelection.Type;

export const BackgroundActivityOverrides = Schema.Struct({
  automaticGitFetchInterval: Schema.optionalKey(Schema.DurationFromMillis),
  providerHealthRefreshInterval: Schema.optionalKey(Schema.DurationFromMillis),
  hostPowerMonitorActiveInterval: Schema.optionalKey(Schema.DurationFromMillis),
  hostPowerMonitorIdleInterval: Schema.optionalKey(Schema.DurationFromMillis),
  idleClientTtl: Schema.optionalKey(Schema.DurationFromMillis),
  pauseWhenHostLocked: Schema.optionalKey(Schema.Boolean),
  pauseWhenHostLowPower: Schema.optionalKey(Schema.Boolean),
  pauseWhenClientLowPower: Schema.optionalKey(Schema.Boolean),
  pauseWhenOnBattery: Schema.optionalKey(Schema.Boolean),
});
export type BackgroundActivityOverrides = typeof BackgroundActivityOverrides.Type;

export const BackgroundActivitySettings = Schema.Struct({
  schemaVersion: Schema.Literal(1).pipe(Schema.withDecodingDefault(Effect.succeed(1 as const))),
  profile: BackgroundActivityProfileSelection.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BACKGROUND_ACTIVITY_PROFILE)),
  ),
  baseProfile: Schema.optionalKey(BackgroundActivityProfile),
  overrides: BackgroundActivityOverrides.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
}).pipe(Schema.withDecodingDefault(Effect.succeed({})));
export type BackgroundActivitySettings = typeof BackgroundActivitySettings.Type;

/**
 * How assistant text reaches clients while a turn runs.
 * - `turn`: hold the whole message until the turn finishes or pauses.
 * - `paragraph`: deliver each finished paragraph or closed code block.
 */
export const ResponseStreamingMode = Schema.Literals(["turn", "paragraph"]);
export type ResponseStreamingMode = typeof ResponseStreamingMode.Type;

/**
 * Server settings a project may override. Every other server setting is
 * environment-wide: providers, keybindings, observability, device hosts,
 * background activity, theme. UI, search and the write planner derive
 * eligibility from this list, so adding a key here is the whole opt-in.
 */
const StorageRetentionDays = Schema.NullOr(
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3650 })),
);
const SettledWorktreeRetentionDays = Schema.NullOr(
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3650 })),
);

export const WorktreeKeepWhen = Schema.Literals([
  "any-local-files",
  "uncommitted-changes",
  "tracked-changes",
]);
export type WorktreeKeepWhen = typeof WorktreeKeepWhen.Type;

export const WorktreeCleanupRules = Schema.Struct({
  worktreeKeepWhen: WorktreeKeepWhen.pipe(
    Schema.withDecodingDefault(Effect.succeed("uncommitted-changes")),
  ),
  worktreeAfterDays: StorageRetentionDays,
  worktreeSettledAfterDays: SettledWorktreeRetentionDays.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  worktreeOnMerge: Schema.Boolean,
  worktreeOnDelete: Schema.Boolean,
  worktreeUnchanged: Schema.Boolean,
});
export type WorktreeCleanupRules = typeof WorktreeCleanupRules.Type;

export const WorktreeCleanup = Schema.NullOr(
  Schema.Union([
    Schema.Struct({ mode: Schema.Literal("off") }),
    Schema.Struct({ mode: Schema.Literal("custom"), rules: WorktreeCleanupRules }),
  ]),
);
export type WorktreeCleanup = typeof WorktreeCleanup.Type;

export const PROJECT_SCOPED_SERVER_SETTING_KEYS = [
  "worktreeCleanup",
  "defaultModelSelection",
  "defaultRuntimeMode",
  "defaultThreadEnvMode",
  "newWorktreesStartFromOrigin",
  "worktreeSubmodules",
  "defaultAutoPull",
  "defaultProjectScripts",
  "enableAgentBrowserAccess",
  "enableAgentDeviceAccess",
  "enableAgentComputerUse",
  "textGenerationModelSelection",
  "sourceControlWriterModelSelection",
  "reviewGuideModelSelection",
  "reviewGuideInstructions",
  "sourceControlWritingStyle",
  "removeAgentCreditsOnMerge",
  "branchNamingMode",
  "branchNamePrefix",
  "branchNameInstructions",
  "pullRequestMergeMethod",
  "continueThreadsAfterServerUpdate",
  "responseStreamingMode",
] as const;
export type ProjectScopedServerSettingKey = (typeof PROJECT_SCOPED_SERVER_SETTING_KEYS)[number];

/** Executable definitions require configuration on each destination machine. */
export function isMachineLocalProjectSettingKey(key: string): boolean {
  return key === "defaultProjectScripts";
}

export const ProjectProviderInstanceOverride = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
});
export type ProjectProviderInstanceOverride = typeof ProjectProviderInstanceOverride.Type;

/**
 * One project's overrides. An absent key inherits the environment value;
 * `null` is a real value where the environment type is nullable (no default
 * model, no dedicated writer model).
 *
 * `providerInstances` sits outside `PROJECT_SCOPED_SERVER_SETTING_KEYS`:
 * every other key replaces its `ServerSettings` field whole, while this one
 * keeps the settings.json shape but overrides field by field, per
 * `ProviderInstanceId`. Only `enabled` is overridable today. An instance id
 * or field absent here inherits the machine value, and a present `enabled`
 * wins in either direction, so a project can turn on an instance the machine
 * disabled, or turn off one the machine enabled. See
 * `resolveProjectProviderInstanceEnabled` for the combined resolution.
 */
export const ProjectSettingsOverrides = Schema.Struct({
  worktreeCleanup: Schema.optionalKey(WorktreeCleanup),
  defaultModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  defaultRuntimeMode: Schema.optionalKey(RuntimeMode),
  defaultThreadEnvMode: Schema.optionalKey(ThreadEnvMode),
  newWorktreesStartFromOrigin: Schema.optionalKey(Schema.Boolean),
  worktreeSubmodules: ForwardCompatibleOptional(WorktreeSubmodules),
  defaultAutoPull: Schema.optionalKey(Schema.Boolean),
  defaultProjectScripts: Schema.optionalKey(Schema.Array(ProjectScript)),
  enableAgentBrowserAccess: Schema.optionalKey(Schema.Boolean),
  enableAgentDeviceAccess: Schema.optionalKey(Schema.Boolean),
  enableAgentComputerUse: Schema.optionalKey(Schema.Boolean),
  textGenerationModelSelection: Schema.optionalKey(ModelSelection),
  sourceControlWriterModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  reviewGuideModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  reviewGuideInstructions: Schema.optionalKey(TrimmedString),
  sourceControlWritingStyle: Schema.optionalKey(SourceControlWritingStyleSettings),
  removeAgentCreditsOnMerge: Schema.optionalKey(Schema.Boolean),
  branchNamingMode: Schema.optionalKey(BranchNamingMode),
  branchNamePrefix: Schema.optionalKey(TrimmedString),
  branchNameInstructions: Schema.optionalKey(TrimmedString),
  pullRequestMergeMethod: Schema.optionalKey(Schema.NullOr(PullRequestMergeMethod)),
  continueThreadsAfterServerUpdate: Schema.optionalKey(Schema.Boolean),
  responseStreamingMode: Schema.optionalKey(ResponseStreamingMode),
  providerInstances: Schema.optionalKey(
    Schema.Record(ProviderInstanceId, ProjectProviderInstanceOverride),
  ),
} satisfies Record<ProjectScopedServerSettingKey | "providerInstances", unknown>);
export type ProjectSettingsOverrides = typeof ProjectSettingsOverrides.Type;

/**
 * Whether `null` is a stored override value for this key rather than "unset".
 * Clients writing a project override treat null for every other key as a
 * request to remove the override, so a picker's "Inherit" item and the row's
 * reset do the same thing.
 */
export function isNullableProjectSettingsOverride(key: ProjectScopedServerSettingKey): boolean {
  return NULLABLE_PROJECT_SETTINGS_OVERRIDES.has(key);
}
const NULLABLE_PROJECT_SETTINGS_OVERRIDES: ReadonlySet<ProjectScopedServerSettingKey> = new Set<
  {
    [K in ProjectScopedServerSettingKey]: null extends ProjectSettingsOverrides[K] ? K : never;
  }[ProjectScopedServerSettingKey]
>([
  "defaultModelSelection",
  "sourceControlWriterModelSelection",
  "reviewGuideModelSelection",
  "pullRequestMergeMethod",
]);

/** Reclaimable bytes from which the offline `cogenly doctor` repair is worth suggesting. */
export const DATABASE_COMPACTION_RECOMMENDED_BYTES = 1024 ** 3;

/** Live SQLite file accounting for the environment's state database. */
export const DatabaseStorageStatus = Schema.Struct({
  databaseBytes: Schema.Number,
  /** Free pages inside the file that an offline VACUUM (or incremental auto_vacuum) returns to disk. */
  reclaimableBytes: Schema.Number,
  /** False on databases created before incremental auto_vacuum; `cogenly doctor` converts them. */
  incrementalVacuumEnabled: Schema.Boolean,
  /** Command to run on the host to reclaim the space offline. */
  compactCommand: Schema.String,
});
export type DatabaseStorageStatus = typeof DatabaseStorageStatus.Type;

/** Only suggest the offline conversion when it can reclaim enough to matter. */
export function shouldRecommendDatabaseCompaction(status: DatabaseStorageStatus): boolean {
  return (
    !status.incrementalVacuumEnabled &&
    status.reclaimableBytes >= DATABASE_COMPACTION_RECOMMENDED_BYTES
  );
}

export const StorageCleanupReportEntry = Schema.Struct({
  kind: Schema.Literals(["worktree", "browser-artifacts", "logs"]),
  outcome: Schema.Literals(["removed", "kept", "failed"]),
  reason: Schema.String,
  path: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(ThreadId),
  threadTitle: Schema.NullOr(Schema.String),
  bytes: Schema.NullOr(Schema.Number).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  files: Schema.NullOr(Schema.Number).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type StorageCleanupReportEntry = typeof StorageCleanupReportEntry.Type;
export const StorageCleanupReport = Schema.Struct({
  trigger: Schema.Literals(["automatic", "manual"]),
  startedAt: Schema.String,
  finishedAt: Schema.String,
  entries: Schema.Array(StorageCleanupReportEntry),
  counts: Schema.Struct({ removed: Schema.Number, kept: Schema.Number, failed: Schema.Number }),
  omittedCount: Schema.Number,
  bytesFreed: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
});
export type StorageCleanupReport = typeof StorageCleanupReport.Type;

/** Built-in nightly backups of the Cogenly home, owned by the server. */
export const AutomaticBackupsSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /** How many nightly backup directories to keep under `<home>/backups/`. */
  retentionCount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 30 })).pipe(
    Schema.withDecodingDefault(Effect.succeed(7)),
  ),
});
export type AutomaticBackupsSettings = typeof AutomaticBackupsSettings.Type;

export const StorageCleanupSettings = Schema.Struct({
  worktreeKeepWhen: WorktreeKeepWhen.pipe(
    Schema.withDecodingDefault(Effect.succeed("uncommitted-changes")),
  ),
  worktreeAfterDays: StorageRetentionDays.pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  worktreeSettledAfterDays: SettledWorktreeRetentionDays.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  worktreeOnMerge: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  worktreeOnDelete: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  worktreeUnchanged: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  browserArtifactsAfterDays: StorageRetentionDays.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  logsAfterDays: StorageRetentionDays.pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type StorageCleanupSettings = typeof StorageCleanupSettings.Type;

const AiAttributionProviderOverrides = Schema.Record(
  ProviderInstanceId,
  Schema.Literals(["inherit", "on", "off"]),
);

export const AiAttributionSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  providers: AiAttributionProviderOverrides.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
});
export type AiAttributionSettings = typeof AiAttributionSettings.Type;

/** Attribution is a portable preference, including overrides for named provider instances. */
export function resolveAiAttribution(
  settings: Pick<ServerSettings, "aiAttribution">,
  instanceId?: string,
): boolean {
  const override =
    instanceId === undefined
      ? undefined
      : settings.aiAttribution.providers[ProviderInstanceId.make(instanceId)];
  return override === "on" ? true : override === "off" ? false : settings.aiAttribution.enabled;
}

export const ServerSettings = Schema.Struct({
  aiAttribution: AiAttributionSettings.pipe(
    Schema.withDecodingDefault(Effect.succeed(Schema.decodeSync(AiAttributionSettings)({}))),
  ),
  ...UniversalClientPreferenceDefaults,
  sharedKeybindings: Schema.NullOr(KeybindingsConfig).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  // Null means no client has migrated this preference yet; an empty value is
  // authoritative so another device cannot resurrect cleared preferences.
  favorites: Schema.NullOr(ModelFavorites).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  providerModelPreferences: Schema.NullOr(ProviderModelPreferences).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  modelEffortDefaults: ModelEffortDefaults.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  worktreeCleanup: WorktreeCleanup.pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  automaticBackups: AutomaticBackupsSettings.pipe(
    Schema.withDecodingDefault(Effect.succeed(Schema.decodeSync(AutomaticBackupsSettings)({}))),
  ),
  /** Machine health: the optional canary and external alert channels. */
  health: MachineHealthSettings.pipe(
    Schema.withDecodingDefault(Effect.succeed(Schema.decodeSync(MachineHealthSettings)({}))),
  ),
  storageCleanup: StorageCleanupSettings.pipe(
    Schema.withDecodingDefault(Effect.succeed(Schema.decodeSync(StorageCleanupSettings)({}))),
  ),
  /**
   * Absolute directory new worktrees are created under, e.g. `D:\worktrees`
   * or `~/worktrees`. Empty uses `<Cogenly home>/worktrees`.
   */
  worktreesDirectory: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  /**
   * Custom locations used before the current one. Server-maintained so
   * worktrees left there stay eligible for cleanup and review diffs.
   */
  previousWorktreesDirectories: Schema.Array(TrimmedString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  responseStreamingMode: ResponseStreamingMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("paragraph" as const)),
  ),
  /** Route provider shell commands through thread-owned, visible PTYs. Restart provider sessions after changing. */
  enableAgentTerminals: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  enableProviderUpdateChecks: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  // Retain the update-era key. On by default so restarts resume the work they
  // interrupted; recovery stops after three automatic continuations in a row.
  continueThreadsAfterServerUpdate: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
  /**
   * Whether agents may drive the in-app preview browser. Turning this off
   * withholds the MCP credential, so the `t3-code` server (and with it every
   * `preview_*` tool) is never attached to a provider session, and the prompt
   * text describing those tools is dropped along with them. The user's own
   * browser panel is unaffected — this gates agent access only.
   *
   * Server-authoritative rather than client-local: tool injection and prompt
   * construction both happen on the server, and the answer must not differ
   * between a desktop window and a phone attached to the same server.
   */
  enableAgentBrowserAccess: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  projectAgentBrowserAccessOverrides: Schema.Record(ProjectId, Schema.Boolean).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  /** Off restores CLI-native MCP configuration; otherwise Cogenly owns integrations. */
  useProviderConnectors: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** The owner reviewed the one-time native-definition import offer. */
  nativeMcpImportReviewed: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  defaultAutoPull: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  defaultProjectScripts: Schema.Array(ProjectScript).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  projectScriptOverrides: Schema.Record(ProjectId, Schema.NullOr(Schema.Array(ProjectScript))).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  projectAutoPullOverrides: Schema.Record(ProjectId, Schema.Boolean).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  defaultModelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  defaultRuntimeMode: RuntimeMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE)),
  ),
  /**
   * Per-project overrides of the keys in `PROJECT_SCOPED_SERVER_SETTING_KEYS`,
   * plus `providerInstances`. The source of truth for project
   * settings; `projectAgentBrowserAccessOverrides`, `projectAutoPullOverrides`
   * and `projectScriptOverrides` are derived views kept for one release so
   * older clients keep reading them.
   */
  projectSettingsOverrides: Schema.Record(ProjectId, ProjectSettingsOverrides).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  /**
   * Whether the legacy per-project fields have been folded into
   * `projectSettingsOverrides`. The fold runs once so a later reset in the
   * settings UI is not undone by the next server start.
   */
  projectSettingsFolded: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /**
   * Whether agents may drive simulators and emulators. Gates the `device_*`
   * MCP tools and the preconfigured `agent-device` CLI the same way
   * `enableAgentBrowserAccess` gates the browser: server-authoritative, applied
   * when the provider session is prepared. The user's own Device panel is
   * unaffected. On by default; helpers only install when a device is first needed.
   */
  enableAgentDeviceAccess: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /**
   * Whether agents may drive this machine's own apps through the `computer_*`
   * MCP tools (screenshots, clicks, typing, the accessibility tree). Gated
   * like `enableAgentBrowserAccess`: server-authoritative and applied when the
   * provider session is prepared. On by default; macOS still needs its
   * one-time Accessibility and Screen Recording grants.
   */
  enableAgentComputerUse: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /**
   * Whether this server may install and run Cogenly's device helper processes.
   * Kept separate from agent access so a user can turn off agent control and
   * keep their own Device panel. On by default.
   */
  enableDeviceSupport: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /**
   * Retired: the setup wizard no longer gates devices. Only read to carry an
   * older install's opt-outs over when the two defaults above flipped to on;
   * the server clears it on load (see `foldLegacyDeviceOnboarding`).
   */
  deviceOnboardingCompleted: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  deviceHosts: SshDeviceHostConfigs.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  snoozeLimitedThreads: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** On by default: a usage-limit stop continues at its reset unless the thread or this opts out. */
  autoResumeLimitedThreads: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  backgroundActivity: BackgroundActivitySettings,
  // Legacy flat fields retained for old settings files and old clients. New
  // consumers should resolve `backgroundActivity` instead.
  automaticGitFetchInterval: Schema.DurationFromMillis.pipe(
    Schema.withDecodingDefault(
      Effect.succeed(Duration.toMillis(DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL)),
    ),
  ),
  providerHealthRefreshInterval: Schema.DurationFromMillis.pipe(
    Schema.withDecodingDefault(
      Effect.succeed(Duration.toMillis(DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL)),
    ),
  ),
  backgroundActivityProfile: BackgroundActivityProfile.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BACKGROUND_ACTIVITY_PROFILE)),
  ),
  /**
   * The icon clients draw for this environment. Null means "use what the
   * server detected" (`environment.platform.machine`), falling back to a
   * generic server. Lives on the server, not the client, so every device
   * sees the same machine. A kind picked on a newer server decodes as null
   * here rather than failing the whole settings snapshot for an older client.
   */
  environmentIcon: ForwardCompatibleNullable(EnvironmentMachineKind).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** The name paired machines show for this one. Null uses the detected default. */
  machineName: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** Whether this is a personal computer or a cloud server. Null uses detection. */
  machineRole: ForwardCompatibleNullable(MachineRole).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /**
   * Null means inherit: the repository's cogenly.json, then "local". The old
   * default "local" was never persisted (defaults are stripped on write), so
   * it now decodes as inherit, which resolves the same way because the old
   * chain also let cogenly.json outrank the environment. Null stays off the wire
   * so older clients, which require a literal here, keep decoding.
   */
  defaultThreadEnvMode: OmittedWhenNull(ThreadEnvMode),
  newWorktreesStartFromOrigin: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
  /**
   * Null defers to the repository's cogenly.json, then to recursive. A value
   * picked on a newer server decodes as null here rather than failing the
   * whole settings snapshot for an older client.
   */
  worktreeSubmodules: ForwardCompatibleNullable(WorktreeSubmodules).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  addProjectBaseDirectory: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  /**
   * Home for repositories Cogenly creates: clones and new repositories land in
   * `<projectsRoot>/<Project>/<repo>`, or `<projectsRoot>/Repositories/<repo>`
   * when no project holds them. `~` expands to the server user's home; empty
   * resolves to `<Cogenly home>/projects`. Existing repositories never move.
   */
  projectsRoot: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  textGenerationModelSelection: ModelSelection.pipe(
    Schema.withDecodingDefault(
      Effect.succeed({
        instanceId: ProviderInstanceId.make("codex"),
        model: DEFAULT_TEXT_GENERATION_MODEL,
        options: [
          {
            id: "reasoningEffort",
            value: DEFAULT_TEXT_GENERATION_REASONING_EFFORT,
          },
        ],
      }),
    ),
  ),
  branchNamingMode: BranchNamingMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("static" as const)),
  ),
  branchNamePrefix: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed("c"))),
  branchNameInstructions: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  removeAgentCreditsOnMerge: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  sourceControlWritingStyle: SourceControlWritingStyleSettings.pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  sourceControlWriterModelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /**
   * Beta: review guides on this server. Off hides the Guide tab in every client and refuses to
   * write guides, for people and agents alike.
   */
  reviewGuidesEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /**
   * The model that reads a pull request to write its review guide. It investigates a checkout
   * over many turns, so it can want a stronger model than one-shot writing. `null` uses the
   * source control writer model.
   */
  reviewGuideModelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /**
   * The maintainer's taste for review guides: what to dwell on, skip, or order first. Shapes the
   * guide's emphasis only; the output format and coverage rules stay fixed.
   */
  reviewGuideInstructions: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  /**
   * The merge method pull requests start with; `null` reuses the method
   * last chosen on this device. Server-side so a project can override it
   * like any other project setting.
   */
  pullRequestMergeMethod: Schema.NullOr(PullRequestMergeMethod).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),

  // New driver-agnostic instance map. Keyed by `ProviderInstanceId`; values
  // are `ProviderInstanceConfig` envelopes. The driver-specific config blob
  // is `Schema.Unknown` at this layer so envelopes with unknown drivers
  // (forks, downgrades, in-flight PR branches) round-trip without loss.
  // See providerInstance.ts for the forward/backward compatibility invariant.
  providerInstances: Schema.Record(ProviderInstanceId, ProviderInstanceConfig).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  observability: ObservabilitySettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  /** Keyed by source control host kind, such as `github`; see `SourceControlHostSettings`. */
  sourceControlHosts: Schema.Record(Schema.String, SourceControlHostSettings).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  // Keyed by a user-chosen id so a source keeps its rows across edits. Entries
  // this build cannot decode round-trip untouched, as provider instances do.
  usageLimitSources: Schema.Record(UsageLimitSourceId, UsageLimitSourceConfig).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  /**
   * Exact model ID to the model its usage counts as, such as a preview slug to
   * its released name. The mapped model is priced and reported as its target.
   */
  usageModelAliases: Schema.Record(TrimmedNonEmptyString, TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
export type ServerSettings = typeof ServerSettings.Type;

export const DEFAULT_SERVER_SETTINGS: ServerSettings = Schema.decodeSync(ServerSettings)({});

/**
 * Server settings that are the same on every paired machine: preferences and
 * policies, never paths, credentials, machine identity or resource limits.
 * Paired machines replicate them, and clients write them to every machine
 * they reach. Every other `ServerSettings` key is machine-local.
 */
export const UNIVERSAL_SERVER_SETTING_KEYS = [
  "aiAttribution",
  ...UNIVERSAL_CLIENT_PREFERENCE_KEYS,
  "sharedKeybindings",
  "favorites",
  "providerModelPreferences",
  "modelEffortDefaults",
  "defaultModelSelection",
  "textGenerationModelSelection",
  "sourceControlWriterModelSelection",
  "reviewGuideModelSelection",
  "defaultRuntimeMode",
  "responseStreamingMode",
  "enableAgentTerminals",
  "continueThreadsAfterServerUpdate",
  "snoozeLimitedThreads",
  "autoResumeLimitedThreads",
  "enableAgentBrowserAccess",
  "enableAgentDeviceAccess",
  "enableAgentComputerUse",
  "defaultAutoPull",
  "defaultThreadEnvMode",
  "newWorktreesStartFromOrigin",
  "worktreeSubmodules",
  "branchNamingMode",
  "branchNamePrefix",
  "branchNameInstructions",
  "removeAgentCreditsOnMerge",
  "sourceControlWritingStyle",
  "reviewGuidesEnabled",
  "reviewGuideInstructions",
  "pullRequestMergeMethod",
  "useProviderConnectors",
] as const satisfies ReadonlyArray<keyof ServerSettings>;
export type UniversalServerSettingKey = (typeof UNIVERSAL_SERVER_SETTING_KEYS)[number];

const UNIVERSAL_KEYS: ReadonlySet<string> = new Set(UNIVERSAL_SERVER_SETTING_KEYS);
/** Whether a server setting key follows the user to every paired machine. */
export function isUniversalServerSettingKey(key: string): key is UniversalServerSettingKey {
  return UNIVERSAL_KEYS.has(key);
}

/**
 * Read the legacy `enabled` flag embedded in a provider instance config
 * blob. The envelope-level `ProviderInstanceConfig.enabled` is the single
 * flag going forward; this reader exists for old settings files that still
 * carry the flag in-config.
 */
export const providerInstanceConfigEnabledFlag = (config: unknown): boolean | undefined => {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return undefined;
  }
  const enabled = (config as { readonly enabled?: unknown }).enabled;
  return typeof enabled === "boolean" ? enabled : undefined;
};

/**
 * Built-in drivers that stay off until the user turns them on. Matches the
 * `enabled` decoding default of each driver's settings schema.
 */
const DEFAULT_DISABLED_PROVIDER_DRIVERS: ReadonlySet<ProviderDriverKind> = new Set(
  ["cursor", "grok", "pi", "opencode", "antigravity"].map((driver) =>
    ProviderDriverKind.make(driver),
  ),
);

/**
 * Built-in drivers whose default instance runs before the user configures it.
 * Mirror of the startup registry's drivers with `hasDefaultInstance !== false`
 * (contracts cannot import the registry); a test fails when they drift.
 */
const DEFAULT_ENABLED_DEFAULT_INSTANCES: ReadonlySet<ProviderInstanceId> = new Set(
  ["codex", "claudeAgent", "muse"].map((instanceId) => ProviderInstanceId.make(instanceId)),
);

/**
 * Whether the built-in default instance at `instanceId` is enabled while
 * settings have no `providerInstances` entry for it. Codex, Claude, and Muse
 * start on; any other id without an entry has no running instance.
 */
export const isUnconfiguredDefaultInstanceEnabled = (instanceId: ProviderInstanceId): boolean =>
  DEFAULT_ENABLED_DEFAULT_INSTANCES.has(instanceId);

/**
 * Default enabled state for a driver when neither the envelope nor the config
 * blob carries a flag. Unknown (fork) drivers default to enabled.
 */
const defaultEnabledForDriver = (driver: ProviderDriverKind): boolean =>
  !DEFAULT_DISABLED_PROVIDER_DRIVERS.has(driver);

/**
 * Resolve whether a configured provider instance is enabled. An explicit
 * false on either the envelope or the in-config flag wins (most
 * restrictive), so a user's disable is never silently undone by the other
 * flag. Otherwise: envelope, then config, then the driver's default.
 */
export const resolveProviderInstanceEnabled = (
  instance: Pick<ProviderInstanceConfig, "driver" | "enabled" | "config">,
): boolean => {
  const configEnabled = providerInstanceConfigEnabledFlag(instance.config);
  if (instance.enabled === false || configEnabled === false) {
    return false;
  }
  return instance.enabled ?? configEnabled ?? defaultEnabledForDriver(instance.driver);
};

/**
 * Effective enablement for a provider instance within a project: the
 * project's `providerInstances[id].enabled` override when set, otherwise the
 * machine-wide `resolveProviderInstanceEnabled` value. `projectId` of `null`
 * (no project in scope) always resolves to the machine-wide value.
 */
export const resolveProjectProviderInstanceEnabled = (
  settings: Pick<ServerSettings, "providerInstances" | "projectSettingsOverrides">,
  projectId: ProjectId | null,
  instanceId: ProviderInstanceId,
): boolean => {
  const override =
    projectId === null
      ? undefined
      : settings.projectSettingsOverrides[projectId]?.providerInstances?.[instanceId]?.enabled;
  if (override !== undefined) return override;
  const instanceConfig = Object.hasOwn(settings.providerInstances, instanceId)
    ? settings.providerInstances[instanceId]
    : undefined;
  return instanceConfig !== undefined
    ? resolveProviderInstanceEnabled(instanceConfig)
    : isUnconfiguredDefaultInstanceEnabled(instanceId);
};

export const ServerSettingsOperation = Schema.Literals([
  "normalize",
  "check-exists",
  "create-provider-instance",
  "read-file",
  "read-provider-history",
  "read-project-settings",
  "read-secret",
  "remove-secret",
  "remove-stale-secret",
  "write-secret",
  "write-file",
  "prepare-directory",
]);
export type ServerSettingsOperation = typeof ServerSettingsOperation.Type;

export class ServerSettingsError extends Schema.TaggedError<ServerSettingsError>()(
  "ServerSettingsError",
  {
    settingsPath: Schema.String,
    operation: ServerSettingsOperation,
    providerInstanceId: Schema.optional(Schema.String),
    environmentVariable: Schema.optional(Schema.String),
    // Validation failures (e.g. a create colliding with an existing
    // instance) originate without an upstream defect.
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const provider =
      this.providerInstanceId === undefined ? "" : ` for provider ${this.providerInstanceId}`;
    const variable =
      this.environmentVariable === undefined
        ? ""
        : ` and environment variable ${this.environmentVariable}`;
    return `Server settings ${this.operation} failed${provider}${variable} at ${this.settingsPath}.`;
  }
}

// ── Unified type ─────────────────────────────────────────────────────

export type UnifiedSettings = Omit<ServerSettings, keyof ModelPreferences> & ClientSettings;
export const DEFAULT_UNIFIED_SETTINGS: UnifiedSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  ...DEFAULT_CLIENT_SETTINGS,
};

// ── Server Settings Patch (replace with a Schema.deepPartial if available) ──────────────────────────────────────────

const ModelSelectionPatch = Schema.Struct({
  instanceId: Schema.optionalKey(ProviderInstanceId),
  model: Schema.optionalKey(TrimmedNonEmptyString),
  options: Schema.optionalKey(ProviderOptionSelections),
});

export const ServerSettingsPatch = Schema.Struct({
  aiAttribution: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.optionalKey(Schema.Boolean),
      providers: Schema.optionalKey(AiAttributionProviderOverrides),
    }),
  ),
  ...UniversalClientPreferencePatch.fields,
  sharedKeybindings: Schema.optionalKey(Schema.NullOr(KeybindingsConfig)),
  /** Seeds legacy browser preferences only while each destination field is still unset. */
  migrateClientPreferences: Schema.optionalKey(UniversalClientPreferencePatch),
  setModelFavorites: Schema.optionalKey(
    Schema.Array(Schema.Struct({ ...ModelFavorite.fields, favorite: Schema.Boolean })),
  ),
  setModelsHidden: Schema.optionalKey(
    Schema.Array(Schema.Struct({ ...ModelFavorite.fields, hidden: Schema.Boolean })),
  ),
  setProviderModelOrder: Schema.optionalKey(
    Schema.Struct({ provider: ProviderInstanceId, modelOrder: Schema.Array(TrimmedString) }),
  ),
  /** Sets or (with `option: null`) clears one model's default reasoning effort. */
  setModelEffortDefault: Schema.optionalKey(
    Schema.Struct({
      provider: ProviderInstanceId,
      model: TrimmedNonEmptyString,
      option: Schema.NullOr(ProviderOptionSelection),
    }),
  ),
  favorites: Schema.optionalKey(ModelFavorites),
  providerModelPreferences: Schema.optionalKey(ProviderModelPreferences),
  // Applied under the settings service's write lock, only while still unset.
  migrateModelPreferences: Schema.optionalKey(
    Schema.Struct({
      favorites: Schema.optionalKey(ModelFavorites),
      providerModelPreferences: Schema.optionalKey(ProviderModelPreferences),
    }),
  ),
  worktreeCleanup: Schema.optionalKey(
    Schema.NullOr(
      Schema.Union([
        Schema.Struct({ mode: Schema.Literal("off") }),
        Schema.Struct({
          mode: Schema.Literal("custom"),
          rules: Schema.Struct({
            worktreeKeepWhen: Schema.optionalKey(WorktreeKeepWhen),
            worktreeAfterDays: Schema.optionalKey(StorageRetentionDays),
            worktreeSettledAfterDays: Schema.optionalKey(SettledWorktreeRetentionDays),
            worktreeOnMerge: Schema.optionalKey(Schema.Boolean),
            worktreeOnDelete: Schema.optionalKey(Schema.Boolean),
            worktreeUnchanged: Schema.optionalKey(Schema.Boolean),
          }),
        }),
      ]),
    ),
  ),
  automaticBackups: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.optionalKey(Schema.Boolean),
      retentionCount: Schema.optionalKey(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 30 })),
      ),
    }),
  ),
  health: Schema.optionalKey(MachineHealthSettingsPatch),
  storageCleanup: Schema.optionalKey(
    Schema.Struct({
      worktreeKeepWhen: Schema.optionalKey(WorktreeKeepWhen),
      worktreeAfterDays: Schema.optionalKey(StorageRetentionDays),
      worktreeSettledAfterDays: Schema.optionalKey(SettledWorktreeRetentionDays),
      worktreeOnMerge: Schema.optionalKey(Schema.Boolean),
      worktreeOnDelete: Schema.optionalKey(Schema.Boolean),
      worktreeUnchanged: Schema.optionalKey(Schema.Boolean),
      browserArtifactsAfterDays: Schema.optionalKey(StorageRetentionDays),
      logsAfterDays: Schema.optionalKey(StorageRetentionDays),
    }),
  ),
  worktreesDirectory: Schema.optionalKey(TrimmedString),
  // Server settings
  responseStreamingMode: Schema.optionalKey(ResponseStreamingMode),
  enableAgentTerminals: Schema.optionalKey(Schema.Boolean),
  enableProviderUpdateChecks: Schema.optionalKey(Schema.Boolean),
  continueThreadsAfterServerUpdate: Schema.optionalKey(Schema.Boolean),
  enableAgentBrowserAccess: Schema.optionalKey(Schema.Boolean),
  projectAgentBrowserAccessOverrides: Schema.optionalKey(
    Schema.Record(ProjectId, Schema.NullOr(Schema.Boolean)),
  ),
  useProviderConnectors: Schema.optionalKey(Schema.Boolean),
  nativeMcpImportReviewed: Schema.optionalKey(Schema.Boolean),
  defaultAutoPull: Schema.optionalKey(Schema.Boolean),
  defaultProjectScripts: Schema.optionalKey(Schema.Array(ProjectScript)),
  projectScriptOverrides: Schema.optionalKey(
    Schema.Record(ProjectId, Schema.NullOr(Schema.Array(ProjectScript))),
  ),
  projectAutoPullOverrides: Schema.optionalKey(
    Schema.Record(ProjectId, Schema.NullOr(Schema.Boolean)),
  ),
  defaultModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  defaultRuntimeMode: Schema.optionalKey(RuntimeMode),
  /**
   * Per-project entry replacement: each entry replaces that project's whole
   * override set and `null` removes it. Clearing one override means resending
   * the entry without that key. Per-key null cannot express "clear" for the
   * keys whose value type is itself nullable, and clients always hold the
   * current entry from the last settings snapshot.
   *
   * `providerInstances` is the one exception: an entry that omits the key
   * keeps the stored value instead of clearing it, so a client built before
   * that field existed cannot wipe it by editing another key. Clearing every
   * provider override for a project means sending `providerInstances: {}`.
   */
  projectSettingsOverrides: Schema.optionalKey(
    Schema.Record(ProjectId, Schema.NullOr(ProjectSettingsOverrides)),
  ),
  enableAgentDeviceAccess: Schema.optionalKey(Schema.Boolean),
  enableAgentComputerUse: Schema.optionalKey(Schema.Boolean),
  enableDeviceSupport: Schema.optionalKey(Schema.Boolean),
  deviceOnboardingCompleted: Schema.optionalKey(Schema.Boolean),
  deviceHosts: Schema.optionalKey(SshDeviceHostConfigs),
  autoResumeLimitedThreads: Schema.optionalKey(Schema.Boolean),
  snoozeLimitedThreads: Schema.optionalKey(Schema.Boolean),
  backgroundActivity: Schema.optionalKey(
    Schema.Struct({
      schemaVersion: Schema.optionalKey(Schema.Literal(1)),
      profile: Schema.optionalKey(BackgroundActivityProfileSelection),
      baseProfile: Schema.optionalKey(BackgroundActivityProfile),
      overrides: Schema.optionalKey(BackgroundActivityOverrides),
    }),
  ),
  automaticGitFetchInterval: Schema.optionalKey(Schema.DurationFromMillis),
  providerHealthRefreshInterval: Schema.optionalKey(Schema.DurationFromMillis),
  backgroundActivityProfile: Schema.optionalKey(BackgroundActivityProfile),
  environmentIcon: Schema.optionalKey(Schema.NullOr(EnvironmentMachineKind)),
  machineName: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  machineRole: Schema.optionalKey(Schema.NullOr(MachineRole)),
  defaultThreadEnvMode: Schema.optionalKey(Schema.NullOr(ThreadEnvMode)),
  newWorktreesStartFromOrigin: Schema.optionalKey(Schema.Boolean),
  worktreeSubmodules: Schema.optionalKey(Schema.NullOr(WorktreeSubmodules)),
  addProjectBaseDirectory: Schema.optionalKey(TrimmedString),
  projectsRoot: Schema.optionalKey(TrimmedString),
  textGenerationModelSelection: Schema.optionalKey(ModelSelectionPatch),
  branchNamingMode: Schema.optionalKey(BranchNamingMode),
  branchNamePrefix: Schema.optionalKey(TrimmedString),
  branchNameInstructions: Schema.optionalKey(TrimmedString),
  removeAgentCreditsOnMerge: Schema.optionalKey(Schema.Boolean),
  sourceControlWritingStyle: Schema.optionalKey(
    Schema.Struct({
      mode: Schema.optionalKey(SourceControlWritingStyleMode),
      customInstructions: Schema.optionalKey(TrimmedString),
      followChangeRequestTemplates: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  sourceControlWriterModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  reviewGuidesEnabled: Schema.optionalKey(Schema.Boolean),
  reviewGuideModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  reviewGuideInstructions: Schema.optionalKey(TrimmedString),
  pullRequestMergeMethod: Schema.optionalKey(Schema.NullOr(PullRequestMergeMethod)),
  observability: Schema.optionalKey(
    Schema.Struct({
      otlpTracesUrl: Schema.optionalKey(TrimmedString),
      otlpMetricsUrl: Schema.optionalKey(TrimmedString),
      otlpLogsUrl: Schema.optionalKey(TrimmedString),
    }),
  ),
  /**
   * Merges per host: a patched field replaces the saved one, so a client sends a per-server-host
   * map whole, with the redaction marker for each saved secret it keeps. An empty or omitted
   * secret is removed from the secret store.
   */
  sourceControlHosts: Schema.optionalKey(Schema.Record(Schema.String, SourceControlHostSettings)),
  // Whole-map replacement for the new instance config. Patching individual
  // entries is intentionally out of scope: the map is small, and partial
  // patches risk leaving driver-specific config in a half-merged state.
  // The web UI sends a fully-formed map every time it edits this field.
  providerInstances: Schema.optionalKey(Schema.Record(ProviderInstanceId, ProviderInstanceConfig)),
  // Per-entry, unlike `providerInstances`: a client only ever adds or removes
  // one source, and sending the whole map races another edit that has not
  // echoed back yet. `null` removes; the server merges into its current map.
  usageLimitSources: Schema.optionalKey(
    Schema.Record(UsageLimitSourceId, Schema.NullOr(UsageLimitSourceConfig)),
  ),
  /** Each entry replaces one model's mapping; `null` removes it. */
  usageModelAliases: Schema.optionalKey(
    Schema.Record(TrimmedNonEmptyString, Schema.NullOr(TrimmedNonEmptyString)),
  ),
});
export type ServerSettingsPatch = typeof ServerSettingsPatch.Type;

/** A mixed settings patch must be authorized for every configuration domain it changes. */
export function requiredScopesForServerSettingsPatch(
  patch: ServerSettingsPatch,
): ReadonlyArray<AuthEnvironmentScope> {
  let changesProviders = false;
  let changesSettings = false;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (key === "providers" || key === "providerInstances" || key === "usageLimitSources") {
      changesProviders = true;
    } else {
      changesSettings = true;
    }
  }
  return [
    ...(changesSettings || !changesProviders ? [AuthSettingsWriteScope] : []),
    ...(changesProviders ? [AuthProvidersManageScope] : []),
  ];
}

/**
 * Project scripts run on the host when a worktree is created or a thread
 * settles, so a project mutation that carries them needs the same grant as
 * saving project scripts through settings, on top of `orchestration:operate`.
 */
export function requiredScopesForProjectMutation(
  mutation: ProjectMutation,
): ReadonlyArray<AuthEnvironmentScope> {
  if (mutation.type === "project.delete" || mutation.scripts === undefined) {
    return [AuthOrchestrationOperateScope];
  }
  return [
    AuthOrchestrationOperateScope,
    ...requiredScopesForServerSettingsPatch({ defaultProjectScripts: mutation.scripts }),
  ];
}

export const ClientSettingsPatch = Schema.Struct({
  notificationMode: Schema.optionalKey(NotificationMode),
  inAppNotificationsEnabled: Schema.optionalKey(Schema.Boolean),
  diffColorScheme: Schema.optionalKey(DiffColorScheme),
  chatWidth: Schema.optionalKey(ChatWidth),
  loadBalancingEnabled: Schema.optionalKey(Schema.Boolean),
  loadBalancingWeights: Schema.optionalKey(LoadBalancingWeights),
  panelAnimationDurationMs: Schema.optionalKey(PanelAnimationDurationMs),
  browserDefaultViewport: Schema.optionalKey(PreviewViewportSetting),
  browserDefaultZoomFactor: Schema.optionalKey(PreviewZoomFactor),
  browserDefaultAppearance: Schema.optionalKey(BrowserAppearanceSetting),
  browserRecordingFrameRate: Schema.optionalKey(BrowserRecordingFrameRate),
  browserRecordingShowKeyPresses: Schema.optionalKey(Schema.Boolean),
  browserRecordingShowMousePresses: Schema.optionalKey(Schema.Boolean),
  browserLinkTarget: Schema.optionalKey(BrowserLinkTarget),
  browserProfiles: Schema.optionalKey(Schema.Array(BrowserProfile)),
  browserDefaultProfileId: Schema.optionalKey(BrowserProfileId),
  confirmQuit: Schema.optionalKey(QuitConfirmationMode),
  confirmThreadArchive: Schema.optionalKey(Schema.Boolean),
  confirmThreadDelete: Schema.optionalKey(Schema.Boolean),
  confirmThreadUnpin: Schema.optionalKey(Schema.Boolean),
  diffFilesCollapsed: Schema.optionalKey(Schema.Boolean),
  diffIgnoreWhitespace: Schema.optionalKey(Schema.Boolean),
  diffLayout: Schema.optionalKey(DiffLayout),
  environmentIdentificationMode: Schema.optionalKey(EnvironmentIdentificationMode),
  onboardingCompletedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  fontSizeInterface: Schema.optionalKey(InterfaceFontSize),
  fontSizePrompt: Schema.optionalKey(PromptFontSize),
  fontSizeCode: Schema.optionalKey(CodeFontSize),
  fontSizeTerminal: Schema.optionalKey(TerminalFontSize),
  fontSmoothing: Schema.optionalKey(Schema.Boolean),
  persistComposerContextStrip: Schema.optionalKey(Schema.Boolean),
  favorites: Schema.optionalKey(ModelFavorites),
  providerModelPreferences: Schema.optionalKey(ProviderModelPreferences),
  planModeEnabled: Schema.optionalKey(Schema.Boolean),
  contextWindowMeterEnabled: Schema.optionalKey(Schema.Boolean),
  composerRichTextEnabled: Schema.optionalKey(Schema.Boolean),
  dictationEnabled: Schema.optionalKey(Schema.Boolean),
  sendShortcut: Schema.optionalKey(Schema.Literals(["enter", "mod-enter-multiline", "mod-enter"])),
  followUpBehavior: Schema.optionalKey(Schema.Literals(["queue", "steer"])),
  proactivePanelsEnabled: Schema.optionalKey(Schema.Boolean),
  showSkillsInSlashMenu: Schema.optionalKey(Schema.Boolean),
  legacySidebarEnabled: Schema.optionalKey(Schema.Boolean),
  sidebarWorkingShelfEnabled: Schema.optionalKey(Schema.Boolean),
  sidebarProjectGroupingMode: Schema.optionalKey(SidebarProjectGroupingMode),
  sidebarProjectGroupingOverrides: Schema.optionalKey(
    Schema.Record(TrimmedNonEmptyString, SidebarProjectGroupingMode),
  ),
  sidebarProjectSortOrder: Schema.optionalKey(SidebarProjectSortOrder),
  sidebarThreadSortOrder: Schema.optionalKey(SidebarThreadSortOrder),
  sidebarThreadPreviewCount: Schema.optionalKey(SidebarThreadPreviewCount),
  timestampFormat: Schema.optionalKey(TimestampFormat),
  wordWrap: Schema.optionalKey(Schema.Boolean),
});
export type ClientSettingsPatch = typeof ClientSettingsPatch.Type;
