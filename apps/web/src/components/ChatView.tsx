import { OverlayPresence } from "~/components/ui/overlay-presence";
import { ThreadFind, ThreadFindCanvas, type ThreadFindControls } from "./chat/ThreadFindProvider";
import { usageLimitRecoveryBannerItem } from "./chat/UsageLimitRecoveryBanner";
import { useUsageLimitHandoff } from "./chat/UsageLimitHandoffActions";
import {
  resolveBackgroundDraftWorkspaceOptions,
  resolveDraftHeroState,
  resolveEmptyServerThreadHero,
  shouldDockDraftHeroForSubmission,
  resolveServerThreadError,
  resolveVisibleWorktreeSetup,
  resolveWorktreeSetupProgress,
} from "./ChatView.logic";
import * as DateTime from "effect/DateTime";
import { restorePlanFollowUpComposer } from "./ChatView.logic";
import { assistantCitationsToPlainText } from "@cogenly/shared/assistantCitations";
import { prepareQueuedEditAttachments, recoverQueuedMessageEdit } from "./chat/queuedMessageEdit";
import {
  isPaintOnlyThreadTimeline,
  peekHeldThreadTimeline,
  peekRememberedThreadTimeline,
  rememberReadyThreadTimeline,
  resolveThreadSwitchTimeline,
  timelineHasEphemeralPreviewUrls,
  recallCheckoutIsRepo,
  rememberCheckoutIsRepo,
} from "./ChatView.logic";
import { useLoadBalancedEnvironment } from "../hooks/useLoadBalancedEnvironment";
import { useScratchProject } from "../hooks/useScratchProject";
import { useDelayedStatus } from "../hooks/useDelayedStatus";
import { useElementState } from "../hooks/useElementState";
import { useStableCallback } from "../hooks/useStableCallback";
import { agentViewKey, requestAgentView } from "../agents/agentViewIntent";
import { isScratchProject } from "@cogenly/client-runtime/state/projects";
import {
  latestExecutedRun,
  latestRootProviderFailure,
} from "@cogenly/shared/orchestrationV2ThreadError";
import type { UsageLimitSourceSnapshots } from "@cogenly/contracts";
import {
  collectProviderUsageLimits,
  hasProviderUsageLimits,
  isUsageLimitsCommand,
} from "@cogenly/shared/usageLimits";
import { feedbackBannerItem } from "./chat/ComposerFeedback";
import { usageLimitsBannerItem } from "./chat/ComposerUsageLimits";
import * as Schema from "effect/Schema";
import {
  questionAttachmentDraftId,
  questionAttachmentDraftPrefix,
  clearQuestionAttachmentDraft,
  useQuestionAttachmentPreparation,
} from "../questionAttachments";
import { useAttachmentUploadStore } from "../lib/attachmentUploadQueue";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  AuthPreviewOperateScope,
  type AssistantCitation,
  type ChatFileAttachment,
  CommandId,
  DEFAULT_MODEL,
  isOrchestrationV2WorkActive,
  isProviderNativeSubagentThread,
  type ChatAttachment as ContractChatAttachment,
  type EnvironmentId,
  type MessageId,
  type ModelSelection,
  type ProjectScript,
  type ProjectId,
  type ProviderApprovalDecision,
  type PreviewAnnotationPayload,
  ProviderInstanceId,
  type ServerProvider,
  type ScopedThreadRef,
  type ThreadId,
  type RunId,
  type RuntimeRequestId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  ProviderInteractionMode,
  ProviderDriverKind,
  resolveEnvironmentMachineKind,
  resolveProjectProviderInstanceEnabled,
  RuntimeMode,
  type WorktreeSetupSnapshot,
} from "@cogenly/contracts";
import { type EnvironmentConnectionPresentation } from "@cogenly/client-runtime/connection";
import {
  wasBootstrapThreadDeleted,
  wasBootstrapThreadNotCreated,
  wasLaunchMachineOffline,
} from "@cogenly/client-runtime/errors";
import { readPastedComposerContext } from "./composerInlineTokenPaste";
import { isPasteAsTextShortcut } from "@cogenly/client-runtime/text-paste";
import { effectiveSnoozed, threadWokeAt } from "@cogenly/client-runtime/state/thread-settled";
import { childThreadInputsTitle } from "@cogenly/client-runtime/state/threads";
import { useAcknowledgeThreadWoke, useThreadActions } from "../hooks/useThreadActions";
import {
  deriveProviderSubagentStatus,
  deriveReportedModelSelection,
  formatModelSelectionEffort,
  deriveRunlessWorkStartedAt,
  deriveThreadActivityRun,
  deriveLatestThreadRun,
  deriveThreadRuntime,
  presentPendingBackgroundWork,
  presentProviderGoal,
} from "@cogenly/client-runtime/state/thread-execution";
import {
  activeRunRefusesSteering,
  threadSupportsProviderHandoff,
} from "@cogenly/client-runtime/state/thread-workflows";
import { resolvePendingHandoff } from "@cogenly/client-runtime/handoff";
import { HandoffRow } from "./chat/V2LifecycleRow";
import {
  codexFeedbackMessage,
  parseCodexFeedbackCommand,
  shouldRequestThreadHistoryTrim,
  shouldShowLoadEarlierControl,
  submitCodexFeedback,
  type CodexFeedbackSubmission,
} from "@cogenly/client-runtime/state/threads";
import { resolveThreadLastVisitedAt } from "./Sidebar.logic";
import { derivePendingThreadRequests } from "@cogenly/client-runtime/state/thread-requests";
import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@cogenly/client-runtime/environment";
import {
  applyClaudePromptEffortPrefix,
  createModelSelection,
  formatModelSlugName,
  resolvePromptInjectedEffort,
  resolveSelectableModel,
} from "@cogenly/shared/model";
import { projectScriptCwd, resolveProjectScripts } from "@cogenly/shared/projectScripts";
import { derivePendingBackgroundWork } from "@cogenly/shared/orchestrationV2PendingBackgroundWork";
import {
  latestUnheldRun,
  usageLimitRunPresentedAsLatest,
} from "@cogenly/shared/orchestrationV2ThreadError";
import { resolveProjectSettings } from "@cogenly/shared/projectSettings";
import { sourceControlRepositorySelector } from "@cogenly/shared/sourceControl";
import { truncate } from "@cogenly/shared/String";
import { resolveThreadReferenceCopyTarget } from "@cogenly/shared/threadReference";
import {
  BottomTerminalPanel,
  type BottomPanelMotionTarget,
  type BottomPanelRunResolver,
} from "./terminals/BottomTerminalPanel";
import { selectThreadBottomPanelState, useBottomPanelStore } from "../bottomPanelStore";
import { Debouncer } from "@tanstack/react-pacer";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import {
  Fragment,
  type ReactNode,
  type SetStateAction,
  Suspense,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useInsertionEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  assistantCitationFromLocation,
  hasAssistantCitationHash,
} from "../lib/assistantCitationNavigation";
import { isMacPlatform } from "../lib/utils";
import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import { useShallow } from "zustand/react/shallow";
import {
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@cogenly/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import { isElectron } from "../env";
import { readLocalApi } from "../localApi";
import { useActiveThreadRef } from "../hooks/useActiveThreadRef";
import {
  type ComposerSubmissionIntent,
  collapseExpandedComposerCursor,
  parseStandaloneComposerSlashCommand,
} from "../composer-logic";
import {
  derivePendingApprovals,
  derivePendingUserInputs,
  derivePhase,
  deriveTimelineEntriesFromVisibleTurnItemsWithState,
  selectHandoffImageResources,
  type TimelineEntriesProjection,
  deriveActivePlanState,
  deriveActiveWorkStartedAt,
  deriveCanInterruptRunningThread,
  findLatestProposedPlan,
  hasActionableProposedPlan,
  isLatestRunSettled,
  type PendingUserInput,
} from "../session-logic";
import { type LegendListRef } from "@legendapp/list/react";
import {
  CHAT_TIMELINE_ANCHOR_OFFSET,
  timelineContentOverflowsViewport,
  isCarriedOverWheel,
  readTimelinePosition,
  readWheelGesture,
  type TimelineScrollMode,
} from "./chat/timelineScrollAnchoring";
import { glideToLiveEnd } from "~/lib/sendMotion";
import {
  buildPendingUserInputAnswers,
  carryDisplacedCustomAnswerIntoPrompt,
  derivePendingUserInputProgress,
  projectPendingUserInputAnswer,
  pruneSettledUserInputs,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  withoutSettledUserInputs,
  type PendingUserInputDraftAnswer,
} from "../pendingUserInput";
import { seedUserInputDraftAnswers } from "@cogenly/client-runtime/state/thread-requests";
import { useUiStateStore } from "../uiStateStore";
import { useWorkspaceMutationRefresh } from "../hooks/useWorkspaceMutationRefresh";
import {
  buildPlanImplementationThreadTitle,
  buildPlanImplementationPrompt,
  resolvePlanFollowUpSubmission,
} from "../proposedPlan";
import {
  DEFAULT_INTERACTION_MODE,
  type ChatMessage,
  type SessionPhase,
  type Thread,
} from "../types";
import { useTheme } from "../hooks/useTheme";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { isCommandPaletteOpen, openCommandPalette } from "../commandPaletteBus";
import { settleAndAdvance } from "../settleAndAdvance";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { FileMetadataThreadProvider } from "../hooks/FileMetadataThreadProvider";
import { usePreviewPanelInlineSize } from "../hooks/usePreviewPanelInlineSize";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../rightPanelLayout";
import { usePublishInlineRightPanelWidth } from "./sidebar/listColumnLayoutStore";
import {
  selectActiveRightPanel,
  selectActiveRightPanelSurface,
  selectGroupSurface,
  selectThreadRightPanelState,
  surfaceGroupOf,
  type RightPanelSurface,
  useRightPanelStore,
} from "../rightPanelStore";
import {
  isPreviewSupportedInRuntime,
  setActivePreviewTab,
  useThreadPreviewState,
} from "../previewStateStore";
import { BrowserSettingsReadError, openUrlInPreview } from "../browser/openFileInPreview";
import { resolveDiscoveredServerUrl } from "../browser/browserTargetResolver";
import { previewRuntimeTabId } from "../browser/previewRuntimeTabId";
import { addBrowserSurface } from "./preview/addBrowserSurface";
import { closePreviewSession } from "./preview/closePreviewSession";
import { usePreviewSession } from "./preview/usePreviewSession";
import { FloatingBrowserPreview } from "./preview/FloatingBrowserPreview";
import { subscribePreviewAction } from "./preview/previewActionBus";
import { getConfiguredPreviewUrls } from "./preview/previewEmptyStateLogic";
import { RightPanelTabs, type RightPanelAddOption } from "./RightPanelTabs";
import { useDeviceState } from "~/state/device";
import { useDeviceTabActions } from "./device/useDeviceTabActions";
import { DeviceSetup } from "./device/DeviceSetup";
import { Dialog } from "./ui/dialog";
import { WizardPopup } from "./ui/wizard";
import { BranchToolbar, type BranchToolbarHandle } from "./BranchToolbar";
import { makeWorkspaceFileDropHandlers } from "./chat/workspaceFileDrop";
import { ThreadHeaderTitle } from "./chat/ThreadLineageBreadcrumb";
import { ThreadOwnerBadge } from "../machines/ThreadOwnerBadge";
import {
  describeOfflineLaunch,
  mergeRunOnOptions,
  resolveDraftLaunchTarget,
  resolveRunOnPick,
} from "../machines/launchMachine.logic";
import { useEnvironmentMachineList } from "../machines/useMachines";
import { resolveThreadOrigin } from "./chat/threadLineage.logic";
import { isEditableFocused } from "../lib/editableFocus";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@cogenly/shared/keybindings";
import { resolveChatShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import {
  AlarmClockIcon,
  ArrowUpLeftIcon,
  CheckCircle2Icon,
  MessageCircleIcon,
  PaperclipIcon,
  DownloadIcon,
  GitBranchIcon,
  ShieldQuestionIcon,
  TargetIcon,
  WifiOffIcon,
} from "lucide-react";
import { cn, randomUUID } from "~/lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS, timelineHeaderInset } from "~/workspaceTitlebar";
import { preloadableComponent } from "~/lib/preloadableComponent";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { newDraftId, newMessageId, newThreadId } from "~/lib/utils";
import { registerFaviconProjectForThread } from "~/browserFaviconStore";
import { getProviderModelCapabilities } from "../providerModels";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  NO_PROVIDER_MODEL_SELECTION,
  shouldShowInstanceBadge,
  sortProviderInstanceEntries,
} from "../providerInstances";
import {
  useClientSettings,
  useClientSettingsHydrated,
  useEnvironmentSettings,
} from "../hooks/useSettings";
import { useNowMinute } from "../hooks/useNowMinute";
import {
  LAYOUT_MOTION_DURATION,
  PANEL_ANIMATION_DURATION,
  readPanelAnimationsActive,
  usePanelPresence,
} from "../panelAnimations";
import { useRightPanelFlip } from "./chat/useRightPanelFlip";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useRemoveClonedProject } from "../hooks/useRemoveClonedProject";
import { resolveAppModelSelectionForInstance } from "../modelSelection";
import {
  getComposerPromptInjectionState,
  getComposerProviderState,
} from "./chat/composerProviderState";
import { isPreviewFocused } from "../lib/previewFocus";
import { getTerminalFocusOwner } from "../lib/terminalFocus";
import { resolveNewDraftStartFromOrigin } from "../lib/chatThreadActions";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "../logicalProject";
import { buildDraftThreadRouteParams, buildThreadRouteParams } from "../threadRoutes";
import {
  isSameSidebarThreadRef,
  useSidebarPendingFileDropStore,
} from "../sidebarPendingFileDropStore";
import {
  beginBackgroundDraftSubmissionByRef,
  clearBackgroundDraftSubmissionByRef,
  finalizePromotedDraftThreadByRef,
  markPromotedDraftThreadByRef,
  restoreFailedBackgroundDraftThread,
  composerDraftHasUserContent,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type DraftThreadEnvMode,
  useComposerDraftStore,
  DraftId,
} from "../composerDraftStore";
import {
  formatTerminalContextLabel,
  type TerminalContextDraft,
  type TerminalContextSelection,
} from "../lib/terminalContext";
import {
  ensureInlineContextReferences,
  removeInlineContextReference,
  stripInlineContextReferences,
} from "../lib/composerContextReferences";
import { serializeLegacyContextMessage } from "@cogenly/shared/composerContextLegacySend";
import {
  buildMessageContext,
  previewAnnotationContextLabel,
  previewAnnotationContextReference,
  reviewCommentContextLabel,
  terminalContextReference,
} from "../lib/composerContextRecords";
import { type ReviewCommentContext } from "../reviewCommentContext";
import { environmentCatalog } from "../connection/catalog";
import { isDesktopLocalConnectionTarget } from "../connection/desktopLocal";
import { useEnvironmentDisconnectDelay } from "../hooks/useEnvironmentDisconnectDelay";
import { useEnvironmentQuery } from "../state/query";
import { useEnvironmentScope } from "~/state/session";
import {
  environmentServerConfigsAtom,
  primaryServerKeybindingsAtom,
  serverEnvironment,
} from "../state/server";
import { terminalEnvironment } from "../state/terminal";
import { threadEnvironment } from "../state/threads";
import { workspacePreparationRetryRunIds } from "@cogenly/client-runtime/state/turn-item-presentation";
import { resolveProviderSkillsForCwd } from "@cogenly/client-runtime/providerSkills";
import { vcsEnvironment } from "../state/vcs";
import { sourceControlEnvironment } from "../state/sourceControl";
import { useProjectClone } from "../state/projectClones";
import { projectCloneDisplayName, projectCloneProgressSummary } from "@cogenly/contracts";
import { useEnvironments, usePrimaryEnvironment } from "../state/environments";
import {
  resolveThreadDetailRef,
  useEnvironmentSupportsServerBrowser,
  useProject,
  useProjects,
  useThreadProjection,
  useThreadStatus,
  useThreadHistory,
  useThreadShell,
  useChildThreadInputs,
  useThreadVisibleTurnItems,
  waitForThreadShell,
} from "../state/entities";
import { environmentShell } from "../state/shell";
import { ChatComposer, type ChatComposerHandle } from "./chat/ChatComposer";
import { createPageScrollController, type PageScrollKey } from "./chat/pageScrollController";
import { isTimelineScrollTarget } from "./chat/timelineScrollTarget";
import { DraftHeroHeadline } from "./chat/DraftHeroHeadline";
import { ThreadHeroHeadline } from "./chat/ThreadHeroHeadline";
import { CollapsePresence, useExtendedAfterFrame } from "./chat/StateTransition";
import { ExpandedImageDialog } from "./chat/ExpandedImageDialog";
import type { AssistantCitationRequest } from "./chat/AssistantCitationSource";
import { MessagesTimeline, type MessagesTimelineHistoryControls } from "./chat/MessagesTimeline";
import { ProviderInstanceIcon } from "./chat/ProviderInstanceIcon";
import { SubagentBannerTitle } from "./chat/SubagentBannerTitle";
import { getTriggerDisplayModelName } from "./chat/providerIconUtils";
import { resolveTimelineIsAtEnd, worktreeSetupAgentStarted } from "./chat/MessagesTimeline.logic";
import { resolveScrollToEndClearance } from "./composerFooterLayout";
import { ScrollToEndButton } from "./chat/ScrollToEndButton";
import { releaseThreadUnreadHold } from "../lib/threadReadState";
import {
  PanelLayoutControls,
  type PanelLayoutControlsProps,
  RightPanelMaximizeControl,
} from "./chat/PanelLayoutControls";
import { ThreadDetailsDock, ThreadDetailsMenu } from "./chat/ThreadDetailsMenu";
import { expandedImageKey, type ExpandedImagePreview } from "./chat/ExpandedImagePreview";
import { NoActiveThreadState } from "./NoActiveThreadState";
import {
  type EnvironmentOption,
  resolveEffectiveEnvMode,
  resolveLocalCheckoutBranchMismatch,
  shouldShowComposerContextStrip,
  shouldShowEnvironmentIndicator,
} from "./BranchToolbar.logic";
import {
  getProviderStatusBannerKey,
  ProviderStatusBanner,
  shouldShowProviderStatusBanner,
} from "./chat/ProviderStatusBanner";
import {
  dismissThreadErrorBannerForSession,
  getThreadErrorBannerKey,
  isThreadErrorBannerDismissedForSession,
  shouldShowThreadErrorBanner,
  ThreadErrorToast,
} from "./chat/ThreadErrorBanner";
import {
  QueuedRunsControl,
  type QueuedRunsControlHandle,
  type EditQueuedRunRequest,
} from "./chat/QueuedRunsControl";
import type {
  ComposerBannerStackContent,
  ComposerBannerStackItem,
} from "./chat/ComposerBannerStack";
import { BackgroundWorkBanner } from "./chat/BackgroundWorkBanner";
import { useThreadApprovalBannerItems } from "./chat/useThreadApprovalBannerItems";
import { ThreadStatusLine } from "./chat/ThreadStatusLine";
import { classifyThreadKind, hasRightPanel, threadCapabilities } from "../threadCapabilities";
import {
  UnanchoredWorkHandoffMarkers,
  WorkHandoffMarkersProvider,
} from "./work/WorkHandoffMarkers";
import { anchorWorkHandoffs } from "./work/work.logic";
import { anchorWorkTasks, handoffsWithoutTasks } from "./work/workTask.logic";
import { formatRelativeTimeLabel, formatRelativeTimeUntilLabel } from "../timestampFormat";
import { ComposerSurface } from "./chat/ComposerSurface";
import { resolveThreadSyncPhase } from "../threadSync";
import {
  hasAvailableCompactionProvider,
  hasDismissedResumeCompaction,
  shouldOfferResumeCompaction,
} from "./chat/ContextWindowMeter.logic";
import {
  deriveLatestContextWindowSnapshot,
  latestProviderTurnTokenUsage,
} from "../lib/contextWindow";
import {
  DRAFT_HERO_TRANSITION_ANIMATION_ID,
  DRAFT_HERO_TRANSITION_EASING,
  runMobileComposerTransition,
} from "./chat/draftHeroTransition";
import type { ComposerDispatchMode } from "@cogenly/client-runtime/state/composer-dispatch";
import {
  agentControlledBrowserCloseConfirmation,
  branchMismatchKey,
  buildExpiredTerminalContextToastCopy,
  buildLocalDraftThread,
  collectUserMessageBlobPreviewUrls,
  createLocalDispatchSnapshot,
  deriveCommittedServerUserMessageIds,
  deriveComposerSendState,
  dismissBranchMismatchForSession,
  hasEnvironmentReconnectWarningGraceElapsed,
  scheduleEnvironmentReconnectWarning,
  hasServerAcknowledgedLocalDispatch,
  isBranchMismatchDismissedForSession,
  shouldShowBranchMismatchBanner,
  shouldShowPlanFollowUpPrompt,
  getStartedThreadModelChangeBlockReason,
  type LocalDispatchSnapshot,
  cloneComposerImageForRetry,
  deriveLockedProvider,
  readFileAsDataUrl,
  resolveFileAttachmentUrl,
  prepareRevertedMessageAttachments,
  waitForRevertedMessage,
  resolveComposerInteractionMode,
  resolveComposerProviderSelection,
  getProviderSendBlockReason,
  resolveThreadMetadataUpdateForNextTurn,
  resolveSendEnvMode,
  revokeBlobPreviewUrl,
  revokeUserMessagePreviewUrls,
  startNewThreadForProject,
  codexArtifactTemplatePromptToAppend,
  waitForStartedServerThread,
  shouldRefocusComposerOnWindowFocus,
} from "./ChatView.logic";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useComposerHandleContext } from "../composerHandleContext";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  releaseDraftAttachments,
  startAttachmentUpload,
} from "../lib/attachmentUploadQueue";
import { sanitizeThreadErrorMessage } from "~/rpc/transportError";
import { RightPanelSheet } from "./RightPanelSheet";
import { previewEnvironment } from "../state/preview";
import { clampFileAttachmentUploadBytes } from "@cogenly/client-runtime/state/attachments";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { fileAttachmentCapabilityBlockReason } from "./chat/composerAttachmentFiles";
import { assetEnvironment } from "../state/assets";
import { readEnvironmentScope, readPreparedConnection } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { Button, InlineButton } from "./ui/button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { ServerUpdateAction } from "./ServerUpdateAction";
import { useAutoBalanceUpdateBanner } from "./chat/useAutoBalanceUpdateBanner";
import {
  ComposerServerUpdateIcon,
  ComposerServerUpdateStatus,
} from "./chat/ComposerServerUpdateStatus";
import {
  buildVersionMismatchDismissalKey,
  dismissServerUpdateFailure,
  dismissVersionMismatch,
  isServerUpdateFailureDismissed,
  isVersionMismatchDismissed,
  resolveServerConfigVersionMismatch,
  resolveServerSelfUpdateCapability,
  serverUpdateGuidance,
  supportsDesktopAppUpdate,
  supportsServerUpdateThreadContinuation,
} from "../versionSkew";
import { useAssetUrls } from "../assets/assetUrls";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "@cogenly/shared/composerContextReferences";
import { recallableComposerPrompt } from "./chat/composerPromptHistory";
import { observeResize } from "~/lib/observeResize";
import {
  beginPendingProjectFolderLaunch,
  readPendingProjectFolderId,
} from "../projectLabels/pendingProjectFolders";
import type { CodexArtifactTemplate } from "@cogenly/shared/codexArtifactTemplates";

const EMPTY_PROVIDERS: ServerProvider[] = [];
const EMPTY_PROVIDER_MODELS: ServerProvider["models"] = [];
const EMPTY_USAGE_LIMIT_SOURCES: UsageLimitSourceSnapshots = [];

const TIMELINE_SCROLL_CANCEL_SENTINEL = Object.freeze({});
const EMPTY_FEEDBACK_SUBMISSIONS: ReadonlyArray<CodexFeedbackSubmission> = [];
// During an active turn the thread's updatedAt advances several times per
// second, and every server-side visit is a full command dispatch plus a
// broadcast to all shell subscribers. Mid-turn bumps carry no unread signal
// (unread flips on run completions, which bypass the throttle), so one
// watermark per interval is plenty.
const VISIT_DISPATCH_THROTTLE_MS = 10_000;
// How long the reader rests at the live end before older rows are shed.
const THREAD_HISTORY_TRIM_IDLE_MS = 3_000;
const EMPTY_PROVIDER_SKILLS: ServerProvider["skills"] = [];
const EMPTY_PENDING_USER_INPUT_ANSWERS: Record<string, PendingUserInputDraftAnswer> = {};
/** Whether the open thread shows its Woke banner: woken after its last visit. */
function resolveThreadWokeVisible(input: {
  readonly wokeAt: string | null;
  readonly settledOverride: string | null | undefined;
  readonly lastVisitedAt: string | null | undefined;
  readonly completedAt: string | null | undefined;
}): boolean {
  if (input.wokeAt === null) return false;
  if (input.settledOverride === "settled") return false;
  const wokeAtMs = Date.parse(input.wokeAt);
  if (Number.isNaN(wokeAtMs)) return false;
  // Having the thread open counts as a visit at completedAt (ChatView stamps
  // it); folding that floor in here keeps a completion-triggered wake from
  // flashing a banner for one frame before the stamp lands. An unparseable
  // stored visit counts as never-visited: corrupt data must not eat the wake
  // signal.
  const storedVisitMs = input.lastVisitedAt ? Date.parse(input.lastVisitedAt) : NaN;
  const completedAtMs = input.completedAt ? Date.parse(input.completedAt) : NaN;
  const lastVisitedMs = Math.max(
    Number.isNaN(storedVisitMs) ? -Infinity : storedVisitMs,
    Number.isNaN(completedAtMs) ? -Infinity : completedAtMs,
  );
  return lastVisitedMs < wokeAtMs;
}

/**
 * The latest committed render's value, for handlers and effects to read. Written
 * in an insertion effect, before any layout effect of the commit runs.
 */
function useLatestRef<T>(value: T) {
  const ref = useRef(value);
  useInsertionEffect(() => {
    ref.current = value;
  });
  return ref;
}

/**
 * The last timeline projection, so the next derivation for the same thread
 * reuses its unchanged entries. Held outside React state: it is a cache, and a
 * render that derives a new projection replaces it.
 */
class TimelineProjectionCache {
  private last: { threadKey: string | null; projection: TimelineEntriesProjection } | null = null;
  previousFor(threadKey: string | null): TimelineEntriesProjection | null {
    return this.last?.threadKey === threadKey ? this.last.projection : null;
  }
  remember(threadKey: string | null, projection: TimelineEntriesProjection): void {
    this.last = { threadKey, projection };
  }
}

// ChatView's handlers run their try/finally blocks, and the try/catch blocks
// that throw inside, through these: the React Compiler cannot lower either, and
// one such block anywhere in the component keeps the whole component from
// compiling. Same semantics as the inline statement.
async function runFinally<T>(run: () => Promise<T>, cleanup: () => void): Promise<T> {
  try {
    return await run();
  } finally {
    cleanup();
  }
}

async function runCatching(
  run: () => Promise<void>,
  onError: (error: unknown) => void,
  cleanup?: () => void,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    onError(error);
  } finally {
    cleanup?.();
  }
}

/**
 * Glides the composer between the centred hero and the docked layout.
 * `animateEnter` false lands in the hero without a glide: an empty thread
 * reaches it when its detail loads, which is not a change the user made.
 */
function useDraftHeroLayoutTransition(
  isDraftHeroState: boolean,
  animationDurationMs: number,
  animateEnter = true,
) {
  const transitionGroupRef = useRef<HTMLDivElement | null>(null);
  const composerAnchorRef = useRef<HTMLDivElement | null>(null);
  const previousStateRef = useRef(isDraftHeroState);
  const previousComposerRectRef = useRef<DOMRect | null>(null);
  const animationRef = useRef<Animation | null>(null);
  const attachTransitionGroupRef = (element: HTMLDivElement | null) => {
    transitionGroupRef.current = element;
  };
  const attachComposerAnchorRef = (element: HTMLDivElement | null) => {
    composerAnchorRef.current = element;
  };

  const captureComposerRect = () => {
    previousComposerRectRef.current = composerAnchorRef.current?.getBoundingClientRect() ?? null;
  };

  useLayoutEffect(() => {
    const transitionGroup = transitionGroupRef.current;
    const nextComposerRect = composerAnchorRef.current?.getBoundingClientRect() ?? null;
    const stateChanged = previousStateRef.current !== isDraftHeroState;
    const mobileComposerTransitionActive =
      typeof document !== "undefined" &&
      document.documentElement.dataset.mobileComposerRouteTransition === "true";

    animationRef.current?.cancel();
    animationRef.current = null;
    const previousComposerRect = previousComposerRectRef.current;
    if (
      stateChanged &&
      (animateEnter || !isDraftHeroState) &&
      readPanelAnimationsActive() &&
      !mobileComposerTransitionActive &&
      transitionGroup &&
      previousComposerRect &&
      nextComposerRect &&
      typeof transitionGroup.animate === "function"
    ) {
      const translateX = previousComposerRect.left - nextComposerRect.left;
      const translateY = previousComposerRect.top - nextComposerRect.top;
      if (Math.abs(translateX) >= 0.5 || Math.abs(translateY) >= 0.5) {
        const animation = transitionGroup.animate(
          [
            { transform: `translate3d(${translateX}px, ${translateY}px, 0)` },
            { transform: "translate3d(0, 0, 0)" },
          ],
          {
            duration: animationDurationMs,
            easing: DRAFT_HERO_TRANSITION_EASING,
          },
        );
        animation.id = DRAFT_HERO_TRANSITION_ANIMATION_ID;
        animationRef.current = animation;
        void animation.finished
          .catch(() => undefined)
          .then(() => {
            if (animationRef.current === animation) animationRef.current = null;
          });
      }
    }
    previousStateRef.current = isDraftHeroState;
    previousComposerRectRef.current = nextComposerRect;
  }, [animateEnter, animationDurationMs, isDraftHeroState]);

  return {
    attachTransitionGroup: attachTransitionGroupRef,
    attachComposerAnchor: attachComposerAnchorRef,
    captureComposerRect,
  } as const;
}

// The panel's surfaces are code-split and preloaded while a thread that offers
// them is on screen, so the first open slides in a finished panel rather than
// a strip whose toolbar and body arrive mid-slide (see preloadableComponent).
const { Component: PreviewPanel, preload: preloadPreviewPanel } = preloadableComponent(() =>
  import("./preview/PreviewPanel").then((module) => module.PreviewPanel),
);
const { Component: DevicePanel, preload: preloadDevicePanel } = preloadableComponent(() =>
  import("./device/DevicePanel").then((module) => module.DevicePanel),
);
const { Component: FilePreviewPanel, preload: preloadFilePreviewPanel } = preloadableComponent(() =>
  import("./files/FilePreviewPanel").then((module) => module.default),
);
const EMPTY_PENDING_FILE_SURFACE_IDS: ReadonlySet<string> = new Set();
const TYPE_TO_FOCUS_EDITABLE_SELECTOR = [
  "input",
  "textarea",
  "select",
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
  '[role="textbox"]',
].join(",");
const TYPE_TO_FOCUS_INTERACTIVE_SELECTOR = [
  "button",
  "a[href]",
  "summary",
  '[role="button"]',
  '[role="checkbox"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="tab"]',
].join(",");
// Popups match only while open or closing: some stay mounted when closed,
// such as the chat header actions menu.
const TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR = [
  '[role="dialog"][aria-modal="true"]',
  '[data-slot="alert-dialog-popup"]:is([data-open],[data-ending-style])',
  '[data-slot="command-dialog-popup"]:is([data-open],[data-ending-style])',
  '[data-slot="dialog-popup"]:is([data-open],[data-ending-style])',
  '[data-slot="sheet-popup"]:is([data-open],[data-ending-style])',
  '[data-slot="sidebar"][data-mobile="true"]:is([data-open],[data-ending-style])',
  '[data-slot="menu-popup"]:is([data-open],[data-ending-style])',
  '[data-slot="select-popup"]:is([data-open],[data-ending-style])',
  '[data-slot="popover-popup"]:is([data-open],[data-ending-style])',
  '[data-slot="combobox-popup"]:is([data-open],[data-ending-style])',
  '[data-slot="autocomplete-popup"]:is([data-open],[data-ending-style])',
].join(",");

type EnvironmentUnavailableState = {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connection: EnvironmentConnectionPresentation;
};

function eventPathContainsSelector(event: Event, selector: string): boolean {
  const path = event.composedPath();
  if (path.length === 0 && event.target) {
    path.push(event.target);
  }
  return path.some((target) => target instanceof Element && target.closest(selector));
}

const SECRET_REQUEST_SELECTOR = '[data-v2-item-type="secret_request"]';

/**
 * Whether input that landed outside any editable or interactive element
 * should be redirected into the composer. Shared by type-to-focus and
 * paste-to-focus so both honour the same surfaces.
 */
function shouldRedirectInputToComposer(event: Event): boolean {
  if (event.defaultPrevented) return false;
  // Near a pending secret request, input is meant for its private field: it
  // must never land in the composer draft, which is persisted and sent.
  if (eventPathContainsSelector(event, SECRET_REQUEST_SELECTOR)) return false;
  if (eventPathContainsSelector(event, TYPE_TO_FOCUS_EDITABLE_SELECTOR)) return false;
  if (eventPathContainsSelector(event, TYPE_TO_FOCUS_INTERACTIVE_SELECTOR)) return false;
  if (document.querySelector(TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR)) return false;
  return true;
}

function shouldTypeToFocusComposer(event: KeyboardEvent): boolean {
  if (event.isComposing) return false;
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  if (event.key.length !== 1) return false;
  if (!shouldRedirectInputToComposer(event)) return false;

  return true;
}

/**
 * Plain text pasted with nothing editable focused, such as after the resting
 * composer blurred. Files are left to the composer's own paste handler.
 */
function pasteTextToFocusComposer(event: ClipboardEvent): string | null {
  if (!event.clipboardData || event.clipboardData.files.length > 0) return null;
  if (!shouldRedirectInputToComposer(event)) return null;
  const text = event.clipboardData.getData("text/plain");
  return text.length > 0 ? text : null;
}

const draftFanoutStateAtom = Atom.family((_routeKey: string) =>
  Atom.make({
    selections: null as ReadonlyArray<ModelSelection> | null,
    sendInFlight: { current: false },
    uncertainSubmissions: { current: new Map<string, ThreadId>() },
  }).pipe(Atom.keepAlive),
);

function formatOutgoingPrompt(params: {
  provider: ProviderDriverKind;
  model: string | null;
  models: ReadonlyArray<ServerProvider["models"][number]>;
  effort: string | null;
  text: string;
}): string {
  const caps = getProviderModelCapabilities(params.models, params.model, params.provider);
  const promptEffort = resolvePromptInjectedEffort(caps, params.effort);
  return applyClaudePromptEffortPrefix(params.text, promptEffort);
}

function isCompactCommandMessage(message: ChatMessage): boolean {
  const text = message.text.trim().toLowerCase();
  return message.role === "user" && text === "/compact" && !message.attachments?.length;
}

/**
 * ChatView inside another page (the project home): no top bar, right panel or
 * terminal drawer, since the host page owns those, and `renderEmptyState` in
 * place of the timeline's placeholder while the thread has no messages.
 */
export interface ChatViewEmbedding {
  readonly renderEmptyState?: (composer: { readonly fill: (prompt: string) => void }) => ReactNode;
  /**
   * The host names the thread (a project's conversation is named for its
   * project), so the first message generates no title.
   */
  readonly keepTitle?: boolean;
}

type ChatViewProps = { embedded?: ChatViewEmbedding } & (
  | {
      environmentId: EnvironmentId;
      threadId: ThreadId;
      reserveTitleBarControlInset?: boolean;
      forceExpandedMobileComposer?: boolean;
      routeKind: "server";
      draftId?: never;
    }
  | {
      environmentId: EnvironmentId;
      threadId: ThreadId;
      reserveTitleBarControlInset?: boolean;
      forceExpandedMobileComposer?: boolean;
      routeKind: "draft";
      draftId: DraftId;
    }
);

function useLocalDispatchState(input: {
  activeThread: Thread | undefined;
  activeLatestRun: Thread["latestRun"] | null;
  latestUserMessageId: MessageId | null;
  phase: SessionPhase;
  activePendingApproval: RuntimeRequestId | null;
  activePendingUserInput: RuntimeRequestId | null;
  threadError: string | null | undefined;
}) {
  const [localDispatch, setLocalDispatch] = useState<LocalDispatchSnapshot | null>(null);

  const resetLocalDispatch = useCallback(() => {
    setLocalDispatch(null);
  }, []);

  const serverAcknowledgedLocalDispatch = useMemo(
    () =>
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: input.phase,
        latestRun: input.activeLatestRun,
        latestUserMessageId: input.latestUserMessageId,
        runtime: input.activeThread?.runtime ?? null,
        hasPendingApproval: input.activePendingApproval !== null,
        hasPendingUserInput: input.activePendingUserInput !== null,
        threadError: input.threadError,
      }),
    [
      input.activeLatestRun,
      input.latestUserMessageId,
      input.activePendingApproval,
      input.activePendingUserInput,
      input.activeThread?.runtime,
      input.phase,
      input.threadError,
      localDispatch,
    ],
  );
  const activeLocalDispatch = serverAcknowledgedLocalDispatch ? null : localDispatch;
  const beginLocalDispatch = useCallback(
    (options?: { preparingWorktree?: boolean; submissionIntent?: ComposerSubmissionIntent }) => {
      const preparingWorktree = Boolean(options?.preparingWorktree);
      setLocalDispatch((current) => {
        const active = serverAcknowledgedLocalDispatch ? null : current;
        if (active) {
          const submissionIntent = options?.submissionIntent ?? active.submissionIntent;
          return active.preparingWorktree === preparingWorktree &&
            active.submissionIntent === submissionIntent
            ? active
            : { ...active, preparingWorktree, submissionIntent };
        }
        return createLocalDispatchSnapshot(input.activeThread, {
          ...options,
          latestUserMessageId: input.latestUserMessageId,
        });
      });
    },
    [input.activeThread, input.latestUserMessageId, serverAcknowledgedLocalDispatch],
  );

  return {
    beginLocalDispatch,
    resetLocalDispatch,
    localDispatchStartedAt: activeLocalDispatch?.startedAt ?? null,
    isPreparingWorktree: activeLocalDispatch?.preparingWorktree ?? false,
    isSendBusy: activeLocalDispatch !== null,
    backgroundSubmissionPending: activeLocalDispatch?.submissionIntent === "background",
  };
}

// Errors surface through two maps (draft-keyed and thread-keyed) whose entries
// can race around promotion, so each write carries its time to let the latest
// one win when they collide.
type LocalThreadErrorEntry = {
  readonly message: string | null;
  readonly at: number;
};

function chatActionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An error occurred.";
}

const ENVIRONMENT_UNAVAILABLE_SEND_TOAST_TRAIL_SIZE = 3;
const EMPTY_HELD_TURN_DIFF_SUMMARIES: readonly never[] = [];
const noopHeldRevert = (_targetTurnCount: number) => {};
const noopHeldAttachment = (_attachment: ChatFileAttachment) => {};

/** The id of the timeline row lowest on screen, or null when none is. */
function latestTimelineRowId(scrollNode: HTMLElement): string | null {
  const viewport = scrollNode.getBoundingClientRect();
  let latest: { readonly id: string; readonly top: number } | null = null;
  for (const row of scrollNode.querySelectorAll<HTMLElement>("[data-timeline-row-id]")) {
    const rect = row.getBoundingClientRect();
    const id = row.dataset.timelineRowId;
    if (!id || rect.height === 0 || rect.top >= viewport.bottom || rect.bottom <= viewport.top) {
      continue;
    }
    if (latest === null || rect.top > latest.top) latest = { id, top: rect.top };
  }
  return latest?.id ?? null;
}

/** Runs with a workspace preparation retry in flight, across ChatView instances. */
const retryingWorkspacePreparationRunIds = new Set<RunId>();

// The factories below build functions ChatView calls during render, or hands
// to ChatComposer, which can call them after an await. They live outside the
// component so each closure keeps only its inputs, not a whole render scope
// (see useStableCallback), while still acting on the render that made them.

/** Records a thread error in local state, keyed by the route the making render saw. */
function makeThreadErrorSetter(input: {
  readonly routeThreadRef: ScopedThreadRef;
  readonly routeThreadKey: string;
  readonly draftId: DraftId | null;
  readonly serverThreadRef: ScopedThreadRef | null;
  readonly setLocalServerErrorsByThreadKey: (
    update: SetStateAction<Record<string, LocalThreadErrorEntry>>,
  ) => void;
  readonly setLocalDraftErrorsByDraftId: (
    update: SetStateAction<Record<string, LocalThreadErrorEntry>>,
  ) => void;
}) {
  return (targetThreadId: ThreadId | null, error: string | null) => {
    if (!targetThreadId) return;
    const nextError = sanitizeThreadErrorMessage(error);
    const nextEntry: LocalThreadErrorEntry = { message: nextError, at: Date.now() };
    const { routeThreadRef, serverThreadRef } = input;
    if (
      serverThreadRef &&
      targetThreadId === routeThreadRef.threadId &&
      serverThreadRef.environmentId === routeThreadRef.environmentId &&
      serverThreadRef.threadId === targetThreadId
    ) {
      input.setLocalServerErrorsByThreadKey((existing) => {
        if ((existing[input.routeThreadKey]?.message ?? null) === nextError) {
          return existing;
        }
        return { ...existing, [input.routeThreadKey]: nextEntry };
      });
      return;
    }
    const localDraftErrorKey = input.draftId ?? targetThreadId;
    input.setLocalDraftErrorsByDraftId((existing) => {
      if ((existing[localDraftErrorKey]?.message ?? null) === nextError) {
        return existing;
      }
      return { ...existing, [localDraftErrorKey]: nextEntry };
    });
  };
}

/** Writes the custom answer for a question of the pending user input the making render saw. */
function makePendingCustomAnswerSetter(input: {
  readonly activePendingUserInput: PendingUserInput | null;
  readonly activePendingRequestKey: string;
  readonly promptRef: { current: string };
  readonly setPendingUserInputAnswersByRequestId: (
    update: SetStateAction<Record<string, Record<string, PendingUserInputDraftAnswer>>>,
  ) => void;
}) {
  return (questionId: string, value: string) => {
    const { activePendingUserInput, activePendingRequestKey } = input;
    if (!activePendingUserInput) {
      return;
    }
    const question = activePendingUserInput.questions.find((entry) => entry.id === questionId);
    if (!question || question.allowCustomAnswer === false) {
      return;
    }
    input.promptRef.current = value;
    input.setPendingUserInputAnswersByRequestId((existing) => ({
      ...existing,
      [activePendingRequestKey]: {
        ...existing[activePendingRequestKey],
        [questionId]: setPendingUserInputCustomAnswer(
          existing[activePendingRequestKey]?.[questionId],
          value,
          question,
        ),
      },
    }));
    // The editor owns this selection. Resetting it before the answer renders
    // can re-enter Lexical with offsets from the previous skill token.
  };
}

/** Draft id for editing a queued run of `threadRef`. */
function makeQueuedEditDraftTarget(threadRef: ScopedThreadRef) {
  return (runId: RunId) => DraftId.make(`queued-edit:${scopedThreadKey(threadRef)}:${runId}`);
}

/** Why the model picker should disable a model, or null when it can be chosen. */
function makeModelDisabledReason(
  context: Omit<
    Parameters<typeof getStartedThreadModelChangeBlockReason>[0],
    "nextModelSelection"
  > | null,
) {
  return (instanceId: ProviderInstanceId, model: string): string | null => {
    if (!context) return null;
    const reason = getStartedThreadModelChangeBlockReason({
      ...context,
      nextModelSelection: { instanceId, model },
    });
    return reason ? `${reason.description} Start a new thread to use this model.` : null;
  };
}

export default function ChatView(props: ChatViewProps) {
  const {
    environmentId,
    threadId,
    routeKind,
    reserveTitleBarControlInset = true,
    forceExpandedMobileComposer = false,
    embedded,
  } = props;
  const canOperateThread = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const draftId = routeKind === "draft" ? props.draftId : null;
  const handleNewThread = useNewThreadHandler();
  const { settleThread, pinThread, unpinThread } = useThreadActions();
  const routeThreadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const routeThreadKey = useMemo(() => scopedThreadKey(routeThreadRef), [routeThreadRef]);
  const currentRouteThreadKeyRef = useRef<string | null>(routeThreadKey);
  useLayoutEffect(() => {
    currentRouteThreadKeyRef.current = routeThreadKey;
    return () => {
      currentRouteThreadKeyRef.current = null;
    };
  }, [routeThreadKey]);
  const createThread = useOrchestrationCommand(threadEnvironment.create, { reportFailure: false });
  const deleteThread = useOrchestrationCommand(threadEnvironment.delete, { reportFailure: false });
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const canWriteSourceControl = useEnvironmentScope(environmentId, AuthSourceControlWriteScope);
  const switchGitRef = useAtomCommand(vcsEnvironment.switchRef, { reportFailure: false });
  const setThreadRuntimeMode = useOrchestrationCommand(threadEnvironment.setRuntimeMode, {
    reportFailure: false,
  });
  const setThreadInteractionMode = useOrchestrationCommand(threadEnvironment.setInteractionMode, {
    reportFailure: false,
  });
  const startThreadTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  const resumeThreadQueue = useOrchestrationCommand(threadEnvironment.resumeThreadQueue, {
    reportFailure: false,
  });
  const uploadThreadFeedback = useOrchestrationCommand(threadEnvironment.uploadFeedback, {
    reportFailure: false,
  });
  const createAttachmentAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  const interruptThreadTurn = useOrchestrationCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });
  const loadEarlierThreadHistory = useAtomCommand(threadEnvironment.loadEarlierHistory, {
    label: "load earlier thread history",
    reportFailure: false,
  });
  const trimThreadHistory = useAtomCommand(threadEnvironment.trimHistory, {
    label: "trim thread history",
    reportFailure: false,
  });
  const respondToThreadApproval = useOrchestrationCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const respondToThreadUserInput = useOrchestrationCommand(threadEnvironment.respondToUserInput, {
    reportFailure: false,
  });
  const dismissThreadUserInput = useAtomCommand(threadEnvironment.dismissUserInput, {
    reportFailure: false,
  });
  const revertThreadCheckpoint = useOrchestrationCommand(threadEnvironment.revertCheckpoint, {
    reportFailure: false,
  });
  const forkThreadFromRun = useAtomCommand(threadEnvironment.forkFromRun, {
    reportFailure: false,
  });
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const closePreview = useAtomCommand(previewEnvironment.close, "preview close");
  const { environments } = useEnvironments();
  const primaryEnvironment = usePrimaryEnvironment();
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  const setEnvironmentEnabled = useAtomCommand(environmentCatalog.setEnabled, {
    reportFailure: false,
  });
  const environmentById = useMemo(
    () => new Map(environments.map((environment) => [environment.environmentId, environment])),
    [environments],
  );
  // Queued-message edit mode. While active, the composer is retargeted to a
  // per-run edit draft so the user's in-progress draft on the thread survives
  // untouched; `existingAttachments` tracks which stored attachments the edit
  // keeps (removal is client state until save).
  const [editingQueuedRun, setEditingQueuedRun] = useState<{
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly messageId: MessageId;
    readonly originalText: string;
    readonly existingAttachments: ReadonlyArray<ContractChatAttachment>;
    readonly context?: import("@cogenly/contracts").OrchestrationMessageContext | undefined;
  } | null>(null);
  const queuedEditDraftTargetFor = useMemo(
    () => makeQueuedEditDraftTarget(routeThreadRef),
    [routeThreadRef],
  );
  const baseComposerDraftTarget: ScopedThreadRef | DraftId =
    routeKind === "server" ? routeThreadRef : props.draftId;
  const composerDraftTarget: ScopedThreadRef | DraftId =
    editingQueuedRun === null
      ? baseComposerDraftTarget
      : queuedEditDraftTargetFor(editingQueuedRun.runId);
  const draftThread = useComposerDraftStore((store) =>
    routeKind === "server"
      ? store.getDraftSessionByRef(routeThreadRef)
      : draftId
        ? store.getDraftSession(draftId)
        : null,
  );
  const serverThread = useThreadShell(routeThreadRef);
  const routeThreadDetailRef = resolveThreadDetailRef(routeThreadRef, {
    shellExists: serverThread !== null,
    waitForShell: draftThread !== null,
  });
  const serverThreadProjection = useThreadProjection(routeThreadDetailRef);
  const serverProjection = serverThreadProjection?.projection ?? null;
  const reportedModelSelection = serverProjection
    ? deriveReportedModelSelection(serverProjection)
    : null;
  const threadStatus = useThreadStatus(routeThreadDetailRef);
  const threadSyncPhase = resolveThreadSyncPhase({
    detailExists: serverProjection !== null,
    shellExists: serverThread !== null,
    status: threadStatus,
  });
  const threadDetailLoading = threadSyncPhase === "loading";
  // Latest provider-reported context usage (#8144): the newest report wins;
  // stale turns keep the meter alive between turns.
  const activeThreadLiveTokenUsage = useMemo(
    () => latestProviderTurnTokenUsage(serverProjection?.providerTurns ?? []),
    [serverProjection?.providerTurns],
  );
  const serverVisibleTurnItems = useThreadVisibleTurnItems(routeThreadDetailRef);
  const serverThreadHistory = useThreadHistory(routeThreadDetailRef);
  const threadHistoryControls = useMemo<MessagesTimelineHistoryControls | undefined>(() => {
    if (routeThreadDetailRef === null || !shouldShowLoadEarlierControl(serverThreadHistory)) {
      return undefined;
    }
    return {
      hasMoreHistory: serverThreadHistory.hasMoreHistory,
      loading: serverThreadHistory.loading,
      error: serverThreadHistory.error,
      onLoadEarlier: (throughEntryId) => {
        void loadEarlierThreadHistory({
          environmentId: routeThreadDetailRef.environmentId,
          input: {
            threadId: routeThreadDetailRef.threadId,
            ...(throughEntryId === undefined ? {} : { throughEntryId }),
          },
        });
      },
    };
  }, [loadEarlierThreadHistory, routeThreadDetailRef, serverThreadHistory]);
  const committedServerMessageIds = useMemo(
    () => deriveCommittedServerUserMessageIds(serverVisibleTurnItems),
    [serverVisibleTurnItems],
  );
  // Queued messages have no turn item until their run starts, so the
  // turn-item-derived set alone can never retire their optimistic rows —
  // cancelling such a run would leave a phantom "pending" queue row behind.
  // Union in the projection's user messages: once the server holds the
  // message, the optimistic copy is redundant everywhere it could render.
  const serverAcknowledgedUserMessageIds = useMemo(() => {
    const ids = new Set(committedServerMessageIds);
    for (const message of serverProjection?.messages ?? []) {
      if (message.role === "user") ids.add(message.id);
    }
    return ids;
  }, [committedServerMessageIds, serverProjection]);
  const markThreadVisited = useUiStateStore((store) => store.markThreadVisited);
  const activeThreadLocalLastVisitedAt = useUiStateStore(
    (store) => store.threadLastVisitedAtById[routeThreadKey],
  );
  const visitThreadMutation = useAtomCommand(threadEnvironment.visit, { reportFailure: false });
  const lastDispatchedVisitRef = useRef<string | null>(null);
  const lastVisitDispatchAtRef = useRef(0);
  const settings = useEnvironmentSettings(environmentId);
  const clientSettingsHydrated = useClientSettingsHydrated();
  const setStickyComposerModelSelection = useComposerDraftStore(
    (store) => store.setStickyModelSelection,
  );
  const timestampFormat = settings.timestampFormat;
  const navigate = useNavigate();
  // Selects nothing unless the URL carries a citation, so ordinary navigations
  // (every mode switch, every thread open) do not re-render this view.
  const citationLocation = useLocation({
    select: (location) =>
      hasAssistantCitationHash(location.href)
        ? {
            href: location.href,
            key: location.state.assistantCitationActivation ?? location.state.__TSR_key,
          }
        : null,
    structuralSharing: true,
  });
  const citationHref = citationLocation?.href ?? null;
  const citationKey = citationLocation?.key;
  const citationRequest = useMemo<AssistantCitationRequest | null>(() => {
    if (citationHref === null) return null;
    const citation = assistantCitationFromLocation(citationHref);
    return citation && citation.environmentId === environmentId && citation.threadId === threadId
      ? { citation, key: citationKey ?? citationHref }
      : null;
  }, [citationHref, citationKey, environmentId, threadId]);
  const { resolvedTheme } = useTheme();
  // Granular store selectors — avoid subscribing to prompt changes.
  const composerInteractionMode = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.interactionMode ?? null,
  );
  const composerRuntimeMode = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.runtimeMode ?? null,
  );
  const composerActiveProvider = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.activeProvider ?? null,
  );
  // What the composer would send, reported by it. The pending-handoff preview
  // reads this rather than the raw draft, which the composer may override
  // (an unavailable instance, a normalized model).
  const [composerSendModelSelection, setComposerSendModelSelection] = useState<Pick<
    ModelSelection,
    "instanceId" | "model"
  > | null>(null);
  const onComposerSendModelSelectionChange = useCallback((selection: ModelSelection | null) => {
    setComposerSendModelSelection((current) =>
      current?.instanceId === selection?.instanceId && current?.model === selection?.model
        ? current
        : selection === null
          ? null
          : { instanceId: selection.instanceId, model: selection.model },
    );
  }, []);
  const composerHasAttachments = useComposerDraftStore((store) => {
    const draft = store.getComposerDraft(composerDraftTarget);
    return (draft?.images.length ?? 0) > 0 || (draft?.files.length ?? 0) > 0;
  });
  // Anything beyond the prompt text: attachments, terminal or element contexts, annotations.
  const composerHasNonPromptContent = useComposerDraftStore((store) => {
    const draft = store.getComposerDraft(composerDraftTarget);
    return draft ? composerDraftHasUserContent({ ...draft, prompt: "" }) : false;
  });
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
  const addComposerDraftFiles = useComposerDraftStore((store) => store.addFiles);
  const setComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.setTerminalContexts,
  );
  const setComposerDraftPreviewAnnotations = useComposerDraftStore(
    (store) => store.setPreviewAnnotations,
  );
  const setComposerDraftReviewComments = useComposerDraftStore((store) => store.setReviewComments);
  const setComposerDraftThreadContexts = useComposerDraftStore((store) => store.setThreadContexts);
  const setComposerDraftModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const setComposerDraftInteractionMode = useComposerDraftStore(
    (store) => store.setInteractionMode,
  );
  const setComposerDraftRuntimeMode = useComposerDraftStore((store) => store.setRuntimeMode);
  const clearComposerDraftContent = useComposerDraftStore((store) => store.clearComposerContent);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const getDraftSessionByLogicalProjectKey = useComposerDraftStore(
    (store) => store.getDraftSessionByLogicalProjectKey,
  );
  const getDraftSession = useComposerDraftStore((store) => store.getDraftSession);
  const setLogicalProjectDraftThreadId = useComposerDraftStore(
    (store) => store.setLogicalProjectDraftThreadId,
  );
  const promptRef = useRef("");
  const composerImagesRef = useRef<ComposerImageAttachment[]>([]);
  const composerFilesRef = useRef<ComposerFileAttachment[]>([]);
  const composerTerminalContextsRef = useRef<TerminalContextDraft[]>([]);
  const localComposerRef = useRef<ChatComposerHandle | null>(null);
  const composerRef = useComposerHandleContext() ?? localComposerRef;
  const branchToolbarRef = useRef<BranchToolbarHandle>(null);
  const pasteAsTextShortcutUntilRef = useRef(0);
  // Element states survive the view being hidden (useElementState), so a mode
  // switch neither re-renders this view nor re-measures from no element.
  const [restingComposerControlsHost, setRestingComposerControlsHost] =
    useElementState<HTMLDivElement>();
  const [restingComposerControlsVisible, setRestingComposerControlsVisible] = useState(false);
  const citeAssistantText = (
    citation: AssistantCitation,
    sourceAnchor: AssistantCitationSourceAnchor,
  ) => {
    const inserted = composerRef.current?.citeAssistantText(citation, sourceAnchor) ?? false;
    if (!inserted) {
      toastManager.add({
        type: "warning",
        title: "The composer is not ready",
        description: "Try citing the selection after the connection or pending input is resolved.",
      });
    }
    return inserted;
  };
  const citeAssistantTextStable = useStableCallback(citeAssistantText);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  // Scrolling back down to the end of the transcript reads it: release an
  // unread hold the user placed on this open thread (lib/threadReadState).
  const leftTranscriptEndRef = useRef(false);
  useEffect(() => {
    if (showScrollToBottom) {
      leftTranscriptEndRef.current = true;
      return;
    }
    if (!leftTranscriptEndRef.current) return;
    leftTranscriptEndRef.current = false;
    releaseThreadUnreadHold(routeThreadKey);
  }, [routeThreadKey, showScrollToBottom]);
  const [isWorkspaceFileDragActive, setIsWorkspaceFileDragActive] = useState(false);
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);
  useEffect(() => {
    const item = expandedImage?.images[expandedImage.index];
    if (item?.type !== "video" || item.src === null || !item.src.startsWith("blob:")) return;
    const src = item.src;
    return () => revokeBlobPreviewUrl(src);
  }, [expandedImage]);
  const [optimisticUserMessages, setOptimisticUserMessages] = useState<ChatMessage[]>([]);
  // Last live snapshot from the setup stream. The server drops a finished
  // snapshot after a grace period and emits null; holding it here bridges the
  // gap until the settled activity arrives on the thread projection.
  const [worktreeSetupRef, setWorktreeSetupRef] = useState<{
    environmentId: EnvironmentId;
    threadId: ThreadId;
    ownerKey: string;
  } | null>(null);
  const [heldWorktreeSetup, setHeldWorktreeSetup] = useState<WorktreeSetupSnapshot | null>(null);
  // Set by "Work locally": the draft whose restored message should be resent
  // once the cancelled dispatch has settled and the draft is in local mode.
  // Keyed by draft id so a bootstrap rotating the thread id keeps it, while
  // moving to another draft drops it without an effect.
  const [workLocallyResendDraftId, setWorkLocallyResendDraftId] = useState<DraftId | null>(null);
  // The draft route reuses this component across drafts, so a resend recorded
  // for one draft must not fire when the user comes back to it later.
  useEffect(() => {
    if (workLocallyResendDraftId !== null && workLocallyResendDraftId !== draftId) {
      setWorkLocallyResendDraftId(null);
    }
  }, [draftId, workLocallyResendDraftId]);
  const [feedbackSubmissionsByThreadKey, setFeedbackSubmissionsByThreadKey] = useState<
    Record<string, ReadonlyArray<CodexFeedbackSubmission>>
  >({});
  const feedbackSubmissions =
    feedbackSubmissionsByThreadKey[routeThreadKey] ?? EMPTY_FEEDBACK_SUBMISSIONS;
  const feedbackUploading = feedbackSubmissions.some(
    (submission) => submission.status === "uploading",
  );
  const optimisticUserMessagesRef = useLatestRef(optimisticUserMessages);
  const [localDraftErrorsByDraftId, setLocalDraftErrorsByDraftId] = useState<
    Record<string, LocalThreadErrorEntry>
  >({});
  const [localServerErrorsByThreadKey, setLocalServerErrorsByThreadKey] = useState<
    Record<string, LocalThreadErrorEntry>
  >({});
  const [isConnecting, _setIsConnecting] = useState(false);
  const isRevertingCheckpoint = useComposerDraftStore((store) =>
    store.rewindingThreadKeys.has(routeThreadKey),
  );
  const userInputResponsesInFlight = useRef(new Set<string>());
  const [respondingRequestIds, setRespondingRequestIds] = useState<RuntimeRequestId[]>([]);

  useEffect(() => {
    setIsWorkspaceFileDragActive(false);
  }, [draftId, routeThreadKey]);

  useEffect(() => {
    if (!isWorkspaceFileDragActive) return;
    const clearWorkspaceFileDrag = () => setIsWorkspaceFileDragActive(false);
    window.addEventListener("dragend", clearWorkspaceFileDrag);
    return () => window.removeEventListener("dragend", clearWorkspaceFileDrag);
  }, [isWorkspaceFileDragActive]);
  const [respondingUserInputRequestIds, setRespondingUserInputRequestIds] = useState<
    RuntimeRequestId[]
  >([]);
  // Questions this client answered or dismissed, hidden until the server drops them.
  const [settledUserInputRequestIds, setSettledUserInputRequestIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [pendingUserInputAnswersByRequestId, setPendingUserInputAnswersByRequestId] = useState<
    Record<string, Record<string, PendingUserInputDraftAnswer>>
  >({});
  const [pendingUserInputQuestionIndexByRequestId, setPendingUserInputQuestionIndexByRequestId] =
    useState<Record<string, number>>({});
  const shouldUsePlanSidebarSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const isMobileViewport = useMediaQuery("max-sm");
  const [workspaceLayoutElement, setWorkspaceLayoutElement] = useElementState<HTMLDivElement>();
  // Tracks whether the user explicitly dismissed the sidebar for the active turn.
  // When set, the thread-change reset effect will open the sidebar instead of closing it.
  // Used by "Implement in a new thread" to carry the sidebar-open intent across navigation.
  const [terminalFocusRequestId, setTerminalFocusRequestId] = useState(0);
  const [attachmentPreviewHandoffByMessageId, setAttachmentPreviewHandoffByMessageId] = useState<
    Record<string, string[]>
  >({});
  const [pendingServerThreadEnvMode, setPendingServerThreadEnvMode] =
    useState<DraftThreadEnvMode | null>(null);
  const [pendingServerThreadBranch, setPendingServerThreadBranch] = useState<string | null>();
  const [
    pendingServerThreadStartFromOriginByThreadId,
    setPendingServerThreadStartFromOriginByThreadId,
  ] = useState<Record<string, boolean>>({});
  const legendListRef = useRef<LegendListRef | null>(null);
  const [composerOverlayElement, setComposerOverlayElement] = useElementState<HTMLDivElement>();
  // Space the timeline keeps clear above its end. Tracks the overlay while the
  // composer is expanded and holds that height while it rests, so the resting
  // composer never exposes rows that its expansion will cover.
  const [composerTimelineInset, setComposerTimelineInset] = useState(0);
  const composerTimelineInsetRef = useRef(0);
  // Height of the panels stacked above the composer, and whether its last
  // change should bring the timeline's end back into view.
  const composerStackHeightRef = useRef<number | null>(null);
  const pinTimelineEndAfterInsetRef = useRef(false);
  const [scrollToEndClearance, setScrollToEndClearance] = useState(0);
  const isAtEndRef = useRef(true);
  const isTimelineAtLogicalEnd = () =>
    resolveTimelineIsAtEnd(legendListRef.current?.getState()) ?? isAtEndRef.current;
  const isTimelineAtLogicalEndStable = useStableCallback(isTimelineAtLogicalEnd);
  // Whether the timeline's rows extend past the viewport above the composer.
  // The composer only rests when there is reading space to give back.
  const attachmentPreviewHandoffByMessageIdRef = useRef<Record<string, string[]>>({});
  const attachmentPreviewPromotionInFlightByMessageIdRef = useRef<Record<string, true>>({});
  const fanoutStateAtom = draftFanoutStateAtom(routeThreadKey);
  const fanoutState = useAtomValue(fanoutStateAtom);
  const sendInFlightRef = fanoutState.sendInFlight;
  const [resumingThreadKeys, setResumingThreadKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const isResuming = resumingThreadKeys.has(routeThreadKey);
  const composerSendGenerationRef = useRef(0);
  // Read through its own subscription: the React Compiler sees the state's
  // mutable boxes (sendInFlight, uncertainSubmissions) as refs, and would
  // flag any other field read from the same value during render.
  const multipleModelSelections = useAtomValue(fanoutStateAtom).selections;
  const setMultipleModelSelections = (
    selections: SetStateAction<ReadonlyArray<ModelSelection> | null>,
  ) => {
    appAtomRegistry.update(fanoutStateAtom, (current) => ({
      ...current,
      selections: typeof selections === "function" ? selections(current.selections) : selections,
    }));
  };
  const setMultipleModelSelectionsStable = useStableCallback(setMultipleModelSelections);
  const multipleModelSelectionsRef = useLatestRef(multipleModelSelections);
  const uncertainMultipleSubmissionsRef = fanoutState.uncertainSubmissions;
  const environmentUnavailableSendToastSlotRef = useRef(0);
  const feedbackUploadsInFlightRef = useRef(new Set<string>());

  const fallbackDraftProjectRef = draftThread
    ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
    : null;
  const fallbackDraftProject = useProject(fallbackDraftProjectRef);
  const localDraftError = serverThread
    ? null
    : ((draftId ? localDraftErrorsByDraftId[draftId]?.message : null) ?? null);
  const localServerError = localServerErrorsByThreadKey[routeThreadKey]?.message ?? null;
  // Draft errors are keyed by draftId while server errors are keyed by thread
  // key, so a pending draft entry must migrate when the server thread loads or
  // a failed send would silently disappear on promotion. When both keys hold
  // an entry, the most recent write wins.
  useEffect(() => {
    if (!serverThread || !draftId) {
      return;
    }
    const pendingDraftEntry = localDraftErrorsByDraftId[draftId];
    if (pendingDraftEntry === undefined) {
      return;
    }
    setLocalDraftErrorsByDraftId((existing) => {
      if (existing[draftId] === undefined) {
        return existing;
      }
      const next = { ...existing };
      delete next[draftId];
      return next;
    });
    setLocalServerErrorsByThreadKey((existing) => {
      const currentEntry = existing[routeThreadKey];
      if (
        currentEntry !== undefined &&
        (currentEntry.at > pendingDraftEntry.at ||
          currentEntry.message === pendingDraftEntry.message)
      ) {
        return existing;
      }
      return {
        ...existing,
        [routeThreadKey]: pendingDraftEntry,
      };
    });
  }, [draftId, localDraftErrorsByDraftId, routeThreadKey, serverThread]);
  const localDraftThread = useMemo(() => {
    if (!draftThread) return undefined;
    // Statements, not one nested expression: the React Compiler cannot lower
    // a `??` inside this call inside a ternary.
    const projectSettings = resolveProjectSettings(
      settings,
      fallbackDraftProject?.id ?? null,
      fallbackDraftProject ?? undefined,
    ).settings;
    const defaultModelSelection =
      projectSettings.defaultModelSelection ?? NO_PROVIDER_MODEL_SELECTION;
    return buildLocalDraftThread(threadId, draftThread, defaultModelSelection);
  }, [draftThread, fallbackDraftProject, settings, threadId]);
  const isServerThread = serverThread !== null;
  const activeThread = isServerThread ? serverThread : localDraftThread;
  const serverLatestRun = useMemo(
    () => (serverProjection === null ? null : deriveLatestThreadRun(serverProjection)),
    [serverProjection],
  );
  const serverActivityRun = useMemo(
    () => (serverProjection === null ? null : deriveThreadActivityRun(serverProjection)),
    [serverProjection],
  );
  const serverRuntime = useMemo(
    () => (serverProjection === null ? null : deriveThreadRuntime(serverProjection)),
    [serverProjection],
  );
  const runlessWorkStartedAt = useMemo(
    () => (serverProjection === null ? null : deriveRunlessWorkStartedAt(serverProjection)),
    [serverProjection],
  );
  const providerSubagentStatus = useMemo(
    () => (serverProjection === null ? null : deriveProviderSubagentStatus(serverProjection)),
    [serverProjection],
  );
  const isProviderSubagent =
    serverThread !== null && isProviderNativeSubagentThread(serverThread.source);
  const supportsProviderSwitchingViaHandoff = useMemo(
    () => threadSupportsProviderHandoff(serverProjection),
    [serverProjection],
  );
  const activeLatestRun = isServerThread ? serverLatestRun : (activeThread?.latestRun ?? null);
  const activeActivityRun = isServerThread ? serverActivityRun : (activeThread?.latestRun ?? null);
  const activeRuntime = isServerThread ? serverRuntime : (activeThread?.runtime ?? null);
  const hasHeldQueuedRuns =
    isServerThread &&
    serverProjection?.runs.some((run) => run.status === "queued" && run.queueHeld === true) ===
      true;
  const resumableRunId = useMemo(() => {
    if (!isServerThread || serverProjection === null) return null;
    const run = latestExecutedRun(serverProjection.runs);
    if (run?.status === "interrupted") return run.id;
    return run?.status === "failed" &&
      serverRuntime?.lastErrorClass === "usage_limit" &&
      latestRootProviderFailure(run, serverProjection.turnItems)?.class === "usage_limit"
      ? run.id
      : null;
  }, [isServerThread, serverProjection, serverRuntime?.lastErrorClass]);
  const parentSubagentThreadId =
    activeThread?.lineage.relationshipToParent === "subagent"
      ? activeThread.lineage.parentThreadId
      : null;
  const parentSubagentEnvironmentId = activeThread?.environmentId ?? null;
  const parentSubagentThreadRef = useMemo(() => {
    if (parentSubagentEnvironmentId === null || parentSubagentThreadId === null) {
      return null;
    }
    return scopeThreadRef(parentSubagentEnvironmentId, parentSubagentThreadId);
  }, [parentSubagentEnvironmentId, parentSubagentThreadId]);
  const parentSubagentThread = useThreadShell(parentSubagentThreadRef);
  const parentThreadLink = useMemo(
    () =>
      parentSubagentThreadRef === null
        ? null
        : {
            threadId: parentSubagentThreadRef.threadId,
            title: parentSubagentThread?.title ?? "Parent thread",
          },
    [parentSubagentThread?.title, parentSubagentThreadRef],
  );
  const serverSessionStatus = useMemo(
    () =>
      serverProjection?.providerSessions.findLast(
        (session) => session.providerInstanceId === serverProjection.thread.providerInstanceId,
      )?.status ?? null,
    [serverProjection],
  );
  const serverLatestExecutedRunStatus = useMemo(
    () => (serverProjection ? (latestExecutedRun(serverProjection.runs)?.status ?? null) : null),
    [serverProjection],
  );
  const threadError = isServerThread
    ? resolveServerThreadError({
        localError: localServerError,
        sessionError: serverRuntime?.lastError ?? null,
        latestRunStatus: serverLatestExecutedRunStatus,
        sessionStatus: serverSessionStatus,
      })
    : localDraftError;
  // Dismissals can only mask the shown error, never clear it: a server thread
  // keeps its error in session.lastError, so clearing the local shadow would
  // just fall through to the persisted one. Mask the current error until a
  // different error arrives, mirroring the provider status banner.
  const threadErrorBannerKey = getThreadErrorBannerKey(routeThreadKey, threadError);
  const visibleThreadError = shouldShowThreadErrorBanner(
    routeThreadKey,
    threadError,
    isThreadErrorBannerDismissedForSession(threadErrorBannerKey),
  )
    ? threadError
    : null;
  // Dismissing only mutates the session-scoped mask set, which does not
  // trigger a render on its own; setThreadError(null) can also bail when the
  // local shadow is already empty and the banner is driven purely by
  // session.lastError. Bump a tick so the banner hides immediately. Mirrors
  // the branch mismatch banner.
  const [, setThreadErrorBannerDismissTick] = useState(0);
  const isLocalDraftThread = !isServerThread && localDraftThread !== undefined;
  const canCheckoutPullRequestIntoThread = canWriteSourceControl && isLocalDraftThread;
  const activeThreadId = activeThread?.id ?? null;
  // Prefer the larger of turn-item-committed ids and projection messages so
  // env lock does not unlock while turn items lag projection hydration.
  const activeMessageCount = isServerThread
    ? Math.max(committedServerMessageIds.size, serverProjection?.messages.length ?? 0)
    : 0;
  const activeThreadRef = useActiveThreadRef(activeThread);
  const activeThreadKey = activeThreadRef ? scopedThreadKey(activeThreadRef) : null;
  const activeEnvironmentServerBrowser = useEnvironmentSupportsServerBrowser(
    activeThreadRef?.environmentId ?? null,
  );
  // Electron hosts its own browser tabs; other clients need the environment to host them.
  const browserAvailable = isPreviewSupportedInRuntime() || activeEnvironmentServerBrowser;
  // One width for every thread, so switching threads keeps the panel as resized.
  const previewPanelInlineSize = usePreviewPanelInlineSize(undefined, {
    container: workspaceLayoutElement,
  });
  const activeThreadShell = useThreadShell(isServerThread ? activeThreadRef : null);
  const timelineThreadError =
    serverRuntime?.status === "failed" &&
    serverRuntime.lastErrorClass === "usage_limit" &&
    activeThreadShell?.latestRun &&
    visibleThreadError === serverRuntime.lastError
      ? null
      : visibleThreadError;

  // Keyed on the two ids, so a new thread object for the same project keeps the ref.
  const activeThreadEnvironmentId = activeThread?.environmentId;
  const activeThreadProjectId = activeThread?.projectId;
  const activeProjectRef = useMemo(
    () =>
      activeThreadEnvironmentId !== undefined && activeThreadProjectId !== undefined
        ? scopeProjectRef(activeThreadEnvironmentId, activeThreadProjectId)
        : null,
    [activeThreadEnvironmentId, activeThreadProjectId],
  );
  const activeProject = useProject(activeProjectRef);
  const { scratchWorkspaceRootFor, openScratchProject } = useScratchProject();
  const activeProjectIsScratch =
    activeProject !== null &&
    isScratchProject(
      activeProject,
      environmentById.get(activeProject.environmentId)?.serverConfig?.scratchWorkspaceRoot ?? null,
    );
  // What this thread's kind offers: a chat has no repository controls, an
  // agent's conversation leaves its lifecycle to the agent.
  const activeThreadSurface = activeThreadShell?.source.surface ?? draftThread?.surface;
  const activeThreadKind = classifyThreadKind({
    agentRole: activeThreadShell?.source.agent?.role ?? null,
    surface: activeThreadSurface,
    isScratch: activeProjectIsScratch,
  });
  const activeThreadCapabilities = threadCapabilities(activeThreadKind);
  // A thread kind without panel surfaces has no right panel: nothing below opens,
  // shows or toggles one for it. Chats offer the browser only.
  const rightPanelSupported = hasRightPanel(activeThreadCapabilities) && !embedded;
  useEffect(() => {
    if (!rightPanelSupported) return;
    void preloadPreviewPanel();
    void preloadDevicePanel();
    void preloadFilePreviewPanel();
  }, [rightPanelSupported]);
  const activeRightPanelKind = useRightPanelStore((state) =>
    rightPanelSupported ? selectActiveRightPanel(state.byThreadKey, activeThreadRef) : null,
  );
  const rightPanelState = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, activeThreadRef),
  );
  const activeRightPanelSurface = useRightPanelStore((state) =>
    rightPanelSupported ? selectActiveRightPanelSurface(state.byThreadKey, activeThreadRef) : null,
  );
  const activePreviewState = useThreadPreviewState(activeThreadRef);
  const activePreviewServerEpoch = activePreviewState.serverEpoch;
  const previewSessionsReady = !activeEnvironmentServerBrowser || activePreviewState.listLoaded;
  const resolvePreviewRuntimeTabId = useMemo(
    () =>
      activeThreadRef
        ? (tabId: string) => previewRuntimeTabId(activeThreadRef, activePreviewServerEpoch, tabId)
        : undefined,
    [activeThreadRef, activePreviewServerEpoch],
  );
  const previewPanelOpen = activeRightPanelKind === "preview" && browserAvailable;
  const rightPanelOpen = rightPanelState.isOpen && rightPanelSupported;
  const bottomPanelOpen = useBottomPanelStore(
    (state) => selectThreadBottomPanelState(state.byThreadKey, activeThreadRef).open,
  );
  const panelAnimationDurationMs = PANEL_ANIMATION_DURATION;
  const rightPanelPresenceValue = useMemo(
    () => ({
      activeSurface: activeRightPanelSurface,
      surfaces: rightPanelState.surfaces,
    }),
    [activeRightPanelSurface, rightPanelState.surfaces],
  );
  const rightPanelPresence = usePanelPresence(
    rightPanelOpen && activeThreadRef !== null,
    rightPanelPresenceValue,
    activeThreadKey,
    panelAnimationDurationMs,
  );
  const rightPanelPresent = rightPanelPresence.present;
  useRightPanelFlip(
    workspaceLayoutElement,
    activeThreadRef,
    !shouldUsePlanSidebarSheet,
    rightPanelOpen,
    rightPanelState.maximized === true,
  );
  const rightPanelControlsInPanel =
    shouldUsePlanSidebarSheet && rightPanelPresent && rightPanelOpen;
  const rightPanelControlsAtRoot = rightPanelPresent && !shouldUsePlanSidebarSheet;
  const renderedRightPanelSurface = rightPanelPresence.value?.activeSurface ?? null;
  const renderedRightPanelSurfaces = rightPanelPresence.value?.surfaces ?? [];
  const canMaximizeRightPanel = rightPanelOpen && !shouldUsePlanSidebarSheet;
  const rightPanelMaximized = canMaximizeRightPanel && rightPanelState.maximized === true;
  const inlineRightPanelOwnsTitleBar = rightPanelOpen && !shouldUsePlanSidebarSheet;
  usePublishInlineRightPanelWidth(
    inlineRightPanelOwnsTitleBar ? previewPanelInlineSize.width : null,
  );

  useEffect(() => {
    if (!activeThreadRef || !previewSessionsReady) return;
    const hiddenTabIds = new Set(
      Object.values(activePreviewState.sessions)
        .filter((session) => session.runtime === "server" && session.reveal === false)
        .map((session) => session.tabId),
    );
    useRightPanelStore
      .getState()
      .reconcileBrowserSurfaces(
        activeThreadRef,
        Object.keys(activePreviewState.sessions),
        hiddenTabIds,
      );
  }, [activePreviewState.sessions, activeThreadRef, previewSessionsReady]);

  const latestRunSettled = isLatestRunSettled(activeLatestRun, activeRuntime);
  const activePlan = useMemo(
    () => deriveActivePlanState(serverProjection, activeActivityRun?.runId),
    [activeActivityRun?.runId, serverProjection],
  );
  // Tasks progress for the running turn's own plan only — deriveActivePlanState
  // falls back to older runs' plans, which must not label fresh work.
  const activeComposerTasksProgress = useMemo(() => {
    if (
      isLatestRunSettled(activeActivityRun, activeRuntime) ||
      !activePlan ||
      activePlan.runId !== (activeActivityRun?.runId ?? null)
    ) {
      return null;
    }
    const totalSteps = activePlan.steps.length;
    if (totalSteps === 0) return null;
    const completedSteps = activePlan.steps.filter((step) => step.status === "completed").length;
    const step =
      activePlan.steps.find((candidate) => candidate.status === "inProgress")?.step ??
      activePlan.steps.find((candidate) => candidate.status === "pending")?.step ??
      activePlan.steps.at(-1)!.step;
    return { step, completedSteps, totalSteps };
  }, [activeActivityRun, activePlan, activeRuntime]);
  const activeComposerTaskSteps =
    activeComposerTasksProgress && activePlan ? activePlan.steps : null;
  // Environment settings with the active project's overrides applied.
  const activeProjectSettings = useMemo(
    () => resolveProjectSettings(settings, activeProject?.id ?? null, activeProject ?? undefined),
    [activeProject, settings],
  );
  // The composer's pick, else the thread's stored mode, else the new-thread
  // default. Sending applies a pick to the thread (persistThreadSettingsForNextTurn).
  const runtimeMode =
    composerRuntimeMode ??
    activeThread?.runtimeMode ??
    activeProjectSettings.settings.defaultRuntimeMode;
  const activeProjectScripts = useMemo(
    () => (activeProject ? resolveProjectScripts(settings, activeProject) : []),
    [activeProject, settings],
  );
  // A project added by cloning exists before its files do. The draft stays
  // editable throughout; only sending waits for the clone, and a failed
  // clone offers its retry right where the user is looking.
  const activeProjectClone = useProjectClone(activeProjectRef);
  const cancelProjectClone = useAtomCommand(sourceControlEnvironment.cancelProjectClone, {
    reportFailure: false,
  });
  const retryProjectClone = useAtomCommand(sourceControlEnvironment.retryProjectClone, {
    reportFailure: false,
  });
  const removeClonedProject = useRemoveClonedProject();
  // The banner mirrors the server's clone state, so a request that never got
  // there needs its own feedback.
  const runProjectCloneAction = async (
    title: string,
    action: () => Promise<AtomCommandResult<unknown, unknown>>,
  ): Promise<void> => {
    const result = await action();
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title,
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
  };
  const runProjectCloneActionStable = useStableCallback(runProjectCloneAction);
  const projectCloneSendBlockReason =
    activeProjectClone === null
      ? null
      : activeProjectClone.phase === "running"
        ? "Cloning repository"
        : activeProjectClone.phase === "done"
          ? null
          : "Repository not cloned";
  const projectCloneBannerItem = useMemo<ComposerBannerStackItem | null>(() => {
    if (!activeProjectClone || !activeProjectRef || activeProjectClone.phase === "done") {
      return null;
    }
    const name = projectCloneDisplayName(activeProjectClone);
    const { environmentId, projectId } = activeProjectRef;
    if (activeProjectClone.phase === "running") {
      return {
        id: `project-clone:${projectId}`,
        variant: "info",
        priority: "activity",
        icon: <DownloadIcon />,
        title: `Cloning ${name}`,
        description: projectCloneProgressSummary(activeProjectClone),
        actions: (
          <Button
            size="xs"
            variant="outline"
            aria-label={`Cancel cloning ${name}`}
            onClick={() =>
              void runProjectCloneActionStable("Failed to cancel clone", () =>
                cancelProjectClone({ environmentId, input: { projectId } }),
              )
            }
          >
            Cancel
          </Button>
        ),
      };
    }
    const cancelled = activeProjectClone.phase === "cancelled";
    return {
      id: `project-clone:${projectId}`,
      variant: cancelled ? "warning" : "error",
      icon: <DownloadIcon />,
      title: cancelled ? `Cancelled cloning ${name}` : `Failed to clone ${name}`,
      description: cancelled ? "Retry to bring in the repository." : activeProjectClone.error,
      actions: (
        <>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => void removeClonedProject({ environmentId, projectId })}
          >
            Remove repository
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              void runProjectCloneActionStable("Failed to retry clone", () =>
                retryProjectClone({ environmentId, input: { projectId } }),
              )
            }
          >
            Retry
          </Button>
        </>
      ),
    };
  }, [
    activeProjectClone,
    activeProjectRef,
    cancelProjectClone,
    removeClonedProject,
    retryProjectClone,
    runProjectCloneActionStable,
  ]);
  const activeProjectDefaultModelSelection = activeProjectSettings.settings.defaultModelSelection;
  const handleNewThreadInActiveProject = () => {
    startNewThreadForProject(activeProjectRef, handleNewThread);
  };
  const projectGroupingSettings = selectProjectGroupingSettings(settings);
  const activeEnvironmentShell = useEnvironmentQuery(
    activeThread ? environmentShell.stateAtom(activeThread.environmentId) : null,
  );
  const activeEnvironmentBootstrapComplete = activeEnvironmentShell.data?.snapshot._tag === "Some";
  const activeProjectKey = activeProject
    ? `${activeProject.environmentId}:${activeProject.workspaceRoot}`
    : null;
  const [pendingFileSurfaceIdsByProject, setPendingFileSurfaceIdsByProject] = useState<
    ReadonlyMap<string, ReadonlySet<string>>
  >(() => new Map());
  const pendingFileSurfaceIds = activeProjectKey
    ? (pendingFileSurfaceIdsByProject.get(activeProjectKey) ?? EMPTY_PENDING_FILE_SURFACE_IDS)
    : EMPTY_PENDING_FILE_SURFACE_IDS;
  const handleFilePendingChange = (relativePath: string, pending: boolean) => {
    if (!activeProjectKey) return;
    setPendingFileSurfaceIdsByProject((currentByProject) => {
      const current = currentByProject.get(activeProjectKey) ?? EMPTY_PENDING_FILE_SURFACE_IDS;
      const surfaceId = `file:${relativePath}`;
      if (current.has(surfaceId) === pending) return currentByProject;
      const next = new Set(current);
      if (pending) next.add(surfaceId);
      else next.delete(surfaceId);
      const nextByProject = new Map(currentByProject);
      if (next.size === 0) nextByProject.delete(activeProjectKey);
      else nextByProject.set(activeProjectKey, next);
      return nextByProject;
    });
  };
  const handleFilePendingChangeStable = useStableCallback(handleFilePendingChange);
  const configuredPreviewUrls = useMemo(
    () => getConfiguredPreviewUrls(activeProjectScripts),
    [activeProjectScripts],
  );

  useEffect(() => {
    if (!activeThreadRef || !activeEnvironmentBootstrapComplete) return;
    useRightPanelStore.getState().reconcileFileSurfaces(activeThreadRef, activeProject !== null);
  }, [activeEnvironmentBootstrapComplete, activeProject, activeThreadRef]);

  // Compute the list of environments this logical project spans, used to
  // drive the environment picker in BranchToolbar.
  const allProjects = useProjects();
  const primaryEnvironmentId = primaryEnvironment?.environmentId ?? null;
  useEffect(() => {
    if (!activeThreadRef || !activeProjectRef) return;
    registerFaviconProjectForThread(activeThreadRef, activeProjectRef);
  }, [activeProjectRef, activeThreadRef]);
  const activeEnvironment =
    activeThread == null ? null : (environmentById.get(activeThread.environmentId) ?? null);
  const activeEnvironmentConnectionPhase = activeEnvironment?.connection.phase ?? "available";
  const activeEnvironmentUnavailable =
    activeEnvironment !== null && activeEnvironmentConnectionPhase !== "connected";
  const activeReconnectingEnvironmentId =
    activeEnvironmentConnectionPhase === "connecting" ||
    activeEnvironmentConnectionPhase === "reconnecting"
      ? (activeEnvironment?.environmentId ?? null)
      : null;
  const [reconnectWarningGraceElapsedEnvironmentId, setReconnectWarningGraceElapsedEnvironmentId] =
    useState<EnvironmentId | null>(null);
  const reconnectWarningGraceElapsed = hasEnvironmentReconnectWarningGraceElapsed(
    activeReconnectingEnvironmentId,
    reconnectWarningGraceElapsedEnvironmentId,
  );
  useEffect(() => {
    setReconnectWarningGraceElapsedEnvironmentId(null);
    if (activeReconnectingEnvironmentId === null) return;
    return scheduleEnvironmentReconnectWarning(() =>
      setReconnectWarningGraceElapsedEnvironmentId(activeReconnectingEnvironmentId),
    );
  }, [activeReconnectingEnvironmentId]);
  const activeEnvironmentUnavailableLabel = activeEnvironment?.label ?? null;
  const activeEnvironmentUnavailableState = useMemo<EnvironmentUnavailableState | null>(() => {
    if (!activeEnvironmentUnavailable || !activeEnvironmentUnavailableLabel || !activeEnvironment) {
      return null;
    }

    return {
      environmentId: activeEnvironment.environmentId,
      label: activeEnvironmentUnavailableLabel,
      connection: activeEnvironment.connection,
    };
  }, [activeEnvironment, activeEnvironmentUnavailable, activeEnvironmentUnavailableLabel]);
  const handleReconnectActiveEnvironment = async (environmentId: EnvironmentId) => {
    const result = await retryEnvironment(environmentId);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not reconnect environment",
          description: error instanceof Error ? error.message : "Failed to reconnect.",
        }),
      );
    }
  };
  const handleReconnectActiveEnvironmentStable = useStableCallback(
    handleReconnectActiveEnvironment,
  );
  const disconnectDelayElapsed = useEnvironmentDisconnectDelay(
    activeEnvironmentUnavailable ? activeEnvironment.environmentId : null,
  );
  const canDisconnectActiveEnvironment =
    disconnectDelayElapsed &&
    activeEnvironment !== null &&
    activeEnvironment.entry.target._tag !== "PrimaryConnectionTarget" &&
    !isDesktopLocalConnectionTarget(activeEnvironment.entry.target);
  const [disconnectingEnvironment, setDisconnectingEnvironment] = useState(false);
  const handleDisconnectActiveEnvironment = async (environmentId: EnvironmentId) => {
    setDisconnectingEnvironment(true);
    const result = await setEnvironmentEnabled({ environmentId, enabled: false });
    setDisconnectingEnvironment(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not disconnect server",
            description: error instanceof Error ? error.message : "Failed to disconnect.",
          }),
        );
      }
      return;
    }
    void navigate({ to: "/", replace: true });
  };
  const handleDisconnectActiveEnvironmentStable = useStableCallback(
    handleDisconnectActiveEnvironment,
  );
  const logicalProjectEnvironments = useMemo(() => {
    if (!activeProject) return [];
    const envs: EnvironmentOption[] = [];
    const pushEnvironment = (environmentId: EnvironmentId, projectId: ProjectId | null) => {
      const environment = environmentById.get(environmentId) ?? null;
      envs.push({
        environmentId,
        projectId,
        label: environment?.label ?? environmentId,
        isPrimary: environmentId === primaryEnvironmentId,
        machine: resolveEnvironmentMachineKind(environment?.serverConfig ?? null),
      });
    };
    if (activeProjectIsScratch && draftId) {
      // Each machine keeps its own "No project" folder at its own path, so they
      // never group as one logical project. Offer every machine that has one.
      for (const environment of environments) {
        const scratchRoot = scratchWorkspaceRootFor(environment.environmentId);
        // Keep the current machine visible so an offline source can still switch away.
        if (scratchRoot === null && environment.environmentId !== activeProject.environmentId)
          continue;
        const scratchProject =
          environment.environmentId === activeProject.environmentId
            ? activeProject
            : allProjects.find(
                (p) =>
                  p.environmentId === environment.environmentId && isScratchProject(p, scratchRoot),
              );
        pushEnvironment(environment.environmentId, scratchProject?.id ?? null);
      }
    } else {
      const logicalKey = deriveLogicalProjectKeyFromSettings(
        activeProject,
        projectGroupingSettings,
      );
      const seen = new Set<string>();
      for (const p of allProjects) {
        if (seen.has(p.environmentId)) continue;
        if (deriveLogicalProjectKeyFromSettings(p, projectGroupingSettings) !== logicalKey)
          continue;
        seen.add(p.environmentId);
        pushEnvironment(p.environmentId, p.id);
      }
    }
    // Sort: primary first, then alphabetical
    envs.sort((a, b) => {
      if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
    return envs;
  }, [
    activeProject,
    activeProjectIsScratch,
    allProjects,
    draftId,
    environments,
    projectGroupingSettings,
    primaryEnvironmentId,
    environmentById,
    scratchWorkspaceRootFor,
  ]);
  const hasMultipleEnvironments = logicalProjectEnvironments.length > 1;
  // Auto balance retargets to an existing project; a machine's "No project"
  // folder may not exist until it is picked.
  const canAutoBalanceEnvironments = hasMultipleEnvironments && !activeProjectIsScratch;
  // "Run on" also offers the draft environment's paired machines. A draft
  // shows its pick; a started thread shows the machine that runs it.
  const pickedRunOnMachine =
    (isServerThread ? activeThreadShell?.source.ownerMachine : draftThread?.launchMachine) ?? null;
  const runOnMachineList = useEnvironmentMachineList(activeThread?.environmentId ?? null);
  const runOnOptions = useMemo(
    () =>
      activeProject
        ? mergeRunOnOptions({
            environments: logicalProjectEnvironments,
            machines: runOnMachineList,
            pickedMachine: pickedRunOnMachine,
          })
        : logicalProjectEnvironments,
    [activeProject, logicalProjectEnvironments, runOnMachineList, pickedRunOnMachine],
  );
  const canPickRunOn = runOnOptions.length > 1;
  const runOnEnvironmentId = pickedRunOnMachine ?? activeThread?.environmentId ?? null;
  const activeEnvironmentOption =
    runOnOptions.find((environment) => environment.environmentId === runOnEnvironmentId) ?? null;
  const showComposerEnvironmentIndicator = shouldShowEnvironmentIndicator({
    activeEnvironment: activeEnvironmentOption,
    canPickEnvironment: canPickRunOn,
  });

  const openOrReuseProjectDraftThread = async (input: {
    branch: string;
    worktreePath: string | null;
    envMode: DraftThreadEnvMode;
  }) => {
    if (!activeProject) {
      throw new Error("No active repository is available for this pull request.");
    }
    const activeProjectRef = scopeProjectRef(activeProject.environmentId, activeProject.id);
    const logicalProjectKey = deriveLogicalProjectKeyFromSettings(
      activeProject,
      projectGroupingSettings,
    );
    const storedDraftSession = getDraftSessionByLogicalProjectKey(logicalProjectKey);
    if (storedDraftSession) {
      setDraftThreadContext(storedDraftSession.draftId, input);
      setLogicalProjectDraftThreadId(
        logicalProjectKey,
        activeProjectRef,
        storedDraftSession.draftId,
        {
          threadId: storedDraftSession.threadId,
          ...input,
        },
      );
      if (routeKind !== "draft" || draftId !== storedDraftSession.draftId) {
        await navigate({
          to: "/draft/$draftId",
          params: buildDraftThreadRouteParams(storedDraftSession.draftId),
        });
      }
      return storedDraftSession.threadId;
    }

    const activeDraftSession = routeKind === "draft" && draftId ? getDraftSession(draftId) : null;
    if (!isServerThread && activeDraftSession?.logicalProjectKey === logicalProjectKey && draftId) {
      setDraftThreadContext(draftId, input);
      setLogicalProjectDraftThreadId(logicalProjectKey, activeProjectRef, draftId, {
        threadId: activeDraftSession.threadId,
        createdAt: activeDraftSession.createdAt,
        runtimeMode: activeDraftSession.runtimeMode,
        interactionMode: activeDraftSession.interactionMode,
        ...input,
      });
      return activeDraftSession.threadId;
    }

    const nextDraftId = newDraftId();
    const nextThreadId = newThreadId();
    setLogicalProjectDraftThreadId(logicalProjectKey, activeProjectRef, nextDraftId, {
      threadId: nextThreadId,
      createdAt: new Date().toISOString(),
      runtimeMode: activeProjectSettings.settings.defaultRuntimeMode,
      interactionMode: DEFAULT_INTERACTION_MODE,
      ...input,
    });
    await navigate({
      to: "/draft/$draftId",
      params: buildDraftThreadRouteParams(nextDraftId),
    });
    return nextThreadId;
  };

  const serverConfig = activeThread
    ? (activeEnvironment?.serverConfig ?? null)
    : (primaryEnvironment?.serverConfig ?? null);
  const machineProviders = useEnvironmentQuery(
    pickedRunOnMachine !== null && pickedRunOnMachine !== environmentId
      ? serverEnvironment.machineProviders({
          environmentId,
          input: { machine: pickedRunOnMachine },
        })
      : null,
  );
  const providerStatuses =
    machineProviders.data?.providers ?? serverConfig?.providers ?? EMPTY_PROVIDERS;
  const selectedProviderByThreadId = composerActiveProvider ?? null;
  const threadProvider =
    activeThread?.modelSelection.instanceId ??
    activeProjectDefaultModelSelection?.instanceId ??
    null;
  const lockedProvider = deriveLockedProvider({
    thread: activeThread,
    selectedProvider: selectedProviderByThreadId,
    threadProvider,
    providers: providerStatuses,
  });
  const modelPickerLockedProvider = supportsProviderSwitchingViaHandoff ? null : lockedProvider;
  const pullRequestsCapabilityKnown = serverConfig !== null;
  const supportsPullRequests = serverConfig?.environment.capabilities.pullRequests === true;
  const attachmentEnvironmentConfig = environmentById.get(environmentId)?.serverConfig ?? null;
  const attachmentUploadsCapabilityKnown = attachmentEnvironmentConfig !== null;
  const supportsQuestionAttachments =
    attachmentEnvironmentConfig?.environment.capabilities.questionAttachments === true;
  const supportsAttachmentUploads =
    attachmentEnvironmentConfig?.environment.capabilities.attachmentUploads === true;
  const advertisedFileAttachmentBytes =
    attachmentEnvironmentConfig?.environment.capabilities.fileAttachments?.maxUploadBytes ?? null;
  const maxFileAttachmentBytes =
    advertisedFileAttachmentBytes === null
      ? null
      : clampFileAttachmentUploadBytes(advertisedFileAttachmentBytes);
  const envLocked = Boolean(activeThread && (activeMessageCount > 0 || activeRuntime !== null));

  const loadBalancingSettings = useClientSettings();
  const automaticEnvironment = Boolean(
    clientSettingsHydrated &&
    draftId &&
    !envLocked &&
    canAutoBalanceEnvironments &&
    loadBalancingSettings.loadBalancingEnabled &&
    draftThread?.environmentSelection !== "manual" &&
    (!composerHasAttachments || Boolean(draftThread?.loadBalancedEnvironmentId)) &&
    (!draftThread?.branch || draftThread.environmentSelection === "auto") &&
    !draftThread?.worktreePath,
  );
  const autoUpdateEnvironments = useMemo(
    () =>
      automaticEnvironment
        ? logicalProjectEnvironments.flatMap(({ environmentId }) => {
            const environment = environmentById.get(environmentId);
            return environment ? [environment] : [];
          })
        : [],
    [automaticEnvironment, logicalProjectEnvironments, environmentById],
  );
  const autoBalanceUpdateBanner = useAutoBalanceUpdateBanner(autoUpdateEnvironments);
  const versionMismatch = resolveServerConfigVersionMismatch(serverConfig);
  const versionMismatchDismissKey =
    versionMismatch && activeThread
      ? buildVersionMismatchDismissalKey(activeThread.environmentId, versionMismatch)
      : null;
  const [dismissedVersionMismatchKey, setDismissedVersionMismatchKey] = useState<string | null>(
    null,
  );
  const versionMismatchDismissed =
    versionMismatchDismissKey === dismissedVersionMismatchKey ||
    isVersionMismatchDismissed(versionMismatchDismissKey);
  const showVersionMismatchBanner =
    versionMismatch !== null && versionMismatchDismissKey !== null && !versionMismatchDismissed;
  const hasMultipleRegisteredEnvironments = environments.length > 1;
  const versionMismatchServerLabel =
    hasMultipleRegisteredEnvironments && activeThread
      ? `${environmentById.get(activeThread.environmentId)?.label ?? serverConfig?.environment.label ?? activeThread.environmentId} server`
      : "server";
  const serverUpdateEnvironmentId = activeThread?.environmentId ?? null;
  const versionMismatchSelfUpdate = resolveServerSelfUpdateCapability(serverConfig);
  const versionMismatchDesktopAppUpdate = supportsDesktopAppUpdate(serverConfig);
  const versionMismatchThreadContinuation = supportsServerUpdateThreadContinuation(serverConfig);
  const serverUpdateState = useAtomValue(
    serverEnvironment.updateStateAtom(serverUpdateEnvironmentId),
  );
  const [dismissedServerUpdateState, setDismissedServerUpdateState] = useState<
    typeof serverUpdateState | null
  >(null);
  const serverUpdateFailureDismissed =
    serverUpdateState === dismissedServerUpdateState ||
    isServerUpdateFailureDismissed(serverUpdateState);
  // The machine notice for the open thread, before debouncing. While an update
  // runs, transient connect blips are expected (the server restarts) and the
  // update banner already shows progress. Hard failure phases still surface so
  // the Reconnect action stays reachable.
  const environmentNoticePhase = ((): "reconnecting" | "offline" | "error" | null => {
    const connection = activeEnvironmentUnavailableState?.connection ?? null;
    if (connection === null) return null;
    const reconnecting = connection.phase === "connecting" || connection.phase === "reconnecting";
    if (reconnecting && (serverUpdateState.status === "running" || !reconnectWarningGraceElapsed)) {
      return null;
    }
    return reconnecting ? "reconnecting" : connection.phase === "error" ? "error" : "offline";
  })();
  // A flappy connection never flashes the notice: it shows once the state has
  // lasted a moment and then stays up for a minimum time.
  const activeEnvironmentNoticeEnvironmentId = activeEnvironment?.environmentId ?? null;
  const activeEnvironmentNoticeLabel = activeEnvironment?.label ?? null;
  const shownEnvironmentNoticePhase = useDelayedStatus(
    activeEnvironment?.environmentId ?? "",
    environmentNoticePhase,
  );
  const systemComposerBannerItems = useMemo<ComposerBannerStackItem[]>(() => {
    const items: ComposerBannerStackItem[] = [];
    const disconnectAction =
      canDisconnectActiveEnvironment && activeEnvironmentUnavailableState ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={disconnectingEnvironment}
          title="Hide this server's threads. Switch it on again in Connections."
          onClick={() =>
            void handleDisconnectActiveEnvironmentStable(
              activeEnvironmentUnavailableState.environmentId,
            )
          }
        >
          Disconnect server
        </Button>
      ) : undefined;
    const environmentReconnecting = shownEnvironmentNoticePhase === "reconnecting";
    if (shownEnvironmentNoticePhase !== null && activeEnvironmentNoticeLabel !== null) {
      items.push({
        // Keyed by phase too, so reconnecting and offline cross-fade.
        id: `environment-unavailable:${activeEnvironmentNoticeEnvironmentId}:${shownEnvironmentNoticePhase}`,
        variant: shownEnvironmentNoticePhase === "error" ? "error" : "warning",
        icon: <WifiOffIcon />,
        title: `${activeEnvironmentNoticeLabel} is ${environmentReconnecting ? "reconnecting" : "offline"}`,
        // Held for its minimum time after the machine is back: no actions then.
        actions: activeEnvironmentUnavailableState ? (
          <>
            {!environmentReconnecting ? (
              <Button
                size="xs"
                variant="ghost"
                onClick={() =>
                  void handleReconnectActiveEnvironmentStable(
                    activeEnvironmentUnavailableState.environmentId,
                  )
                }
              >
                Reconnect
              </Button>
            ) : null}
            {disconnectAction}
          </>
        ) : undefined,
      });
    }
    if (
      !automaticEnvironment &&
      serverUpdateEnvironmentId &&
      (serverUpdateState.status === "idle"
        ? showVersionMismatchBanner
        : !serverUpdateFailureDismissed)
    ) {
      const updateInProgress = serverUpdateState.status === "running";
      const updateFailed = serverUpdateState.status === "failed";
      items.push({
        id: `server-version:${serverUpdateEnvironmentId}`,
        variant: updateFailed ? "error" : "default",
        // Prioritize update progress over passive notices, but keep activity attached.
        priority: updateInProgress ? "urgent" : "notice",
        icon: <ComposerServerUpdateIcon status={serverUpdateState.status} />,
        title:
          updateInProgress || updateFailed ? (
            <ComposerServerUpdateStatus
              state={serverUpdateState}
              serverLabel={versionMismatchServerLabel}
            />
          ) : versionMismatch ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    className="block max-w-full cursor-help truncate rounded-sm text-left"
                  >
                    Server update available
                  </button>
                }
              />
              <TooltipPopup side="top">
                {versionMismatchServerLabel} {versionMismatch.serverVersion}{" "}
                <span aria-hidden="true">→</span> {versionMismatch.clientVersion}
              </TooltipPopup>
            </Tooltip>
          ) : (
            "Server update available"
          ),
        description:
          !updateInProgress &&
          !updateFailed &&
          versionMismatchSelfUpdate !== null &&
          (versionMismatchSelfUpdate !== "desktop-managed" || !versionMismatchDesktopAppUpdate)
            ? serverUpdateGuidance(versionMismatchSelfUpdate)
            : undefined,
        actions: updateInProgress ? (
          disconnectAction
        ) : !versionMismatch ||
          (versionMismatchSelfUpdate === "desktop-managed" &&
            !versionMismatchDesktopAppUpdate) ? undefined : (
          <ServerUpdateAction
            environmentId={serverUpdateEnvironmentId}
            serverLabel={versionMismatchServerLabel}
            selfUpdate={versionMismatchSelfUpdate}
            desktopAppUpdate={versionMismatchDesktopAppUpdate}
            threadContinuation={versionMismatchThreadContinuation}
            targetVersion={versionMismatch.clientVersion}
            label={updateFailed ? "Retry" : "Update"}
            variant="ghost"
          />
        ),
        ...(updateInProgress || (!updateFailed && !versionMismatchDismissKey)
          ? {}
          : {
              dismissLabel: "Dismiss update notice",
              onDismiss: () => {
                if (updateFailed) {
                  dismissServerUpdateFailure(serverUpdateState);
                  setDismissedServerUpdateState(serverUpdateState);
                }
                dismissVersionMismatch(versionMismatchDismissKey);
                setDismissedVersionMismatchKey(versionMismatchDismissKey);
              },
            }),
      });
    }
    if (autoBalanceUpdateBanner) items.push(autoBalanceUpdateBanner);
    return items;
  }, [
    automaticEnvironment,
    autoBalanceUpdateBanner,
    activeEnvironmentUnavailableState,
    handleReconnectActiveEnvironmentStable,
    canDisconnectActiveEnvironment,
    disconnectingEnvironment,
    handleDisconnectActiveEnvironmentStable,
    setDismissedVersionMismatchKey,
    showVersionMismatchBanner,
    shownEnvironmentNoticePhase,
    activeEnvironmentNoticeEnvironmentId,
    activeEnvironmentNoticeLabel,
    serverUpdateFailureDismissed,
    serverUpdateState,
    versionMismatch,
    versionMismatchDismissKey,
    serverUpdateEnvironmentId,
    versionMismatchSelfUpdate,
    versionMismatchDesktopAppUpdate,
    versionMismatchThreadContinuation,
    versionMismatchServerLabel,
  ]);
  const providerInstanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(
          deriveProviderInstanceEntries(providerStatuses),
          settings,
          activeProject?.id ?? null,
        ),
      ),
    [providerStatuses, settings, activeProject?.id],
  );
  const activeThreadModelInstanceId = activeThread?.modelSelection.instanceId;
  const { selectedProviderEntry, requestedDriverKind } = useMemo(
    () =>
      resolveComposerProviderSelection({
        entries: providerInstanceEntries,
        candidateInstanceIds: [
          selectedProviderByThreadId,
          activeRuntime?.providerInstanceId,
          activeThreadModelInstanceId,
          activeProjectDefaultModelSelection?.instanceId,
        ],
        lockedProvider,
        lockedInstanceId: activeRuntime?.providerInstanceId ?? activeThreadModelInstanceId,
      }),
    [
      activeProjectDefaultModelSelection?.instanceId,
      activeThreadModelInstanceId,
      activeRuntime?.providerInstanceId,
      lockedProvider,
      providerInstanceEntries,
      selectedProviderByThreadId,
    ],
  );
  const selectedProvider = selectedProviderEntry?.driverKind ?? requestedDriverKind;
  const activeProviderInstanceId = selectedProviderEntry?.instanceId ?? null;
  const activeProviderStatus = selectedProviderEntry?.snapshot ?? null;
  const { enabled: interactionModeEnabled, interactionMode } = resolveComposerInteractionMode({
    planModeEnabled: settings.planModeEnabled,
    provider: activeProviderStatus,
    interactionMode:
      composerInteractionMode ?? activeThread?.interactionMode ?? DEFAULT_INTERACTION_MODE,
  });
  const conversationProviderStatus =
    providerStatuses.find((status) => status.instanceId === activeRuntime?.providerInstanceId) ??
    activeProviderStatus;
  const supportsConversationRollback =
    canOperateThread &&
    conversationProviderStatus !== null &&
    conversationProviderStatus.supportsConversationRollback !== false;
  const phase = derivePhase(activeRuntime);
  const pendingRequests = useMemo(
    () =>
      serverProjection === null
        ? { approvals: [], userInputs: [] }
        : derivePendingThreadRequests(serverProjection),
    [serverProjection],
  );
  const pendingApprovals = useMemo(
    () => derivePendingApprovals(pendingRequests.approvals),
    [pendingRequests.approvals],
  );
  const serverPendingUserInputs = useMemo(
    () => derivePendingUserInputs(pendingRequests.userInputs),
    [pendingRequests.userInputs],
  );
  const shownSettledUserInputRequestIds = pruneSettledUserInputs(
    settledUserInputRequestIds,
    serverPendingUserInputs,
  );
  if (shownSettledUserInputRequestIds !== settledUserInputRequestIds) {
    setSettledUserInputRequestIds(shownSettledUserInputRequestIds);
  }
  // An answered card leaves once, when its response lands, and never comes
  // back live while the server's update is still on its way.
  const pendingUserInputs = useMemo(
    () => withoutSettledUserInputs(serverPendingUserInputs, shownSettledUserInputRequestIds),
    [serverPendingUserInputs, shownSettledUserInputRequestIds],
  );
  const activePendingUserInput = pendingUserInputs[0] ?? null;
  const activePendingRequestKey = JSON.stringify([
    environmentId,
    activeThreadId,
    activePendingUserInput?.requestId,
  ]);
  const activePendingAnswerDrafts =
    pendingUserInputAnswersByRequestId[activePendingRequestKey] ?? EMPTY_PENDING_USER_INPUT_ANSWERS;
  if (
    activePendingUserInput &&
    seedUserInputDraftAnswers(activePendingUserInput.questions, activePendingAnswerDrafts) !==
      activePendingAnswerDrafts
  ) {
    setPendingUserInputAnswersByRequestId((existing) => {
      const drafts = existing[activePendingRequestKey] ?? EMPTY_PENDING_USER_INPUT_ANSWERS;
      const seeded = seedUserInputDraftAnswers(activePendingUserInput.questions, drafts);
      return seeded === drafts ? existing : { ...existing, [activePendingRequestKey]: seeded };
    });
  }
  const pendingQuestionDraftKeys = useMemo(
    () =>
      activeThreadId
        ? pendingUserInputs.flatMap((request) =>
            request.questions.map((question) =>
              questionAttachmentDraftId(
                environmentId,
                activeThreadId,
                request.requestId,
                question.id,
              ),
            ),
          )
        : [],
    [activeThreadId, environmentId, pendingUserInputs],
  );
  const questionComposerDrafts = useComposerDraftStore(
    useShallow((state) =>
      Object.fromEntries(
        pendingQuestionDraftKeys.map((key) => [key, state.draftsByThreadKey[key]]),
      ),
    ),
  );
  const questionUploadsBlocked = useAttachmentUploadStore(
    useShallow((state) =>
      Object.fromEntries(
        pendingQuestionDraftKeys.map((key) => {
          const draft = questionComposerDrafts[key];
          const attachments = draft ? [...draft.images, ...draft.files] : [];
          return [
            key,
            attachments.some((attachment) => {
              const upload = state.uploadsByImageId[attachment.id];
              return upload?.status !== "ready" || upload.environmentId !== environmentId;
            }),
          ];
        }),
      ),
    ),
  );
  const questionPreparations = useQuestionAttachmentPreparation(
    useShallow((state) =>
      Object.fromEntries(pendingQuestionDraftKeys.map((key) => [key, state.counts[key] ?? 0])),
    ),
  );
  useEffect(() => {
    if (!activeThread) return;
    const questionThread = activeThread;
    const currentRequests = pendingUserInputs;
    const prefix = questionAttachmentDraftPrefix(environmentId, questionThread.id);
    const retained = new Set(
      currentRequests.flatMap((request) =>
        request.questions.map((question) =>
          questionAttachmentDraftId(
            environmentId,
            questionThread.id,
            request.requestId,
            question.id,
          ),
        ),
      ),
    );
    const keys = new Set([
      ...Object.keys(useComposerDraftStore.getState().draftsByThreadKey),
      ...Object.keys(useQuestionAttachmentPreparation.getState().counts),
    ]);
    for (const key of keys) {
      if (key.startsWith(prefix) && !retained.has(DraftId.make(key)))
        clearQuestionAttachmentDraft(DraftId.make(key));
    }
  }, [environmentId, activeThread, pendingUserInputs]);
  const activePendingDraftAnswers = useMemo(() => {
    if (!activePendingUserInput || !activeThreadId) return EMPTY_PENDING_USER_INPUT_ANSWERS;
    return Object.fromEntries(
      activePendingUserInput.questions.map((question) => {
        const key = questionAttachmentDraftId(
          environmentId,
          activeThreadId,
          activePendingUserInput.requestId,
          question.id,
        );
        const draft = questionComposerDrafts[key];
        const attachments = draft ? [...draft.images, ...draft.files] : [];
        return [
          question.id,
          {
            ...pendingUserInputAnswersByRequestId[activePendingRequestKey]?.[question.id],
            attachmentCount: attachments.length,
            attachmentsBlocked:
              (attachments.length > 0 && !supportsQuestionAttachments) ||
              (questionPreparations[key] ?? 0) > 0 ||
              questionUploadsBlocked[key] === true,
          },
        ];
      }),
    );
  }, [
    activePendingUserInput,
    activeThreadId,
    environmentId,
    questionComposerDrafts,
    questionUploadsBlocked,
    supportsQuestionAttachments,
    questionPreparations,
    pendingUserInputAnswersByRequestId,
    activePendingRequestKey,
  ]);
  const activePendingQuestionIndex = activePendingUserInput
    ? (pendingUserInputQuestionIndexByRequestId[activePendingRequestKey] ?? 0)
    : 0;
  const activePendingProgress = useMemo(
    () =>
      activePendingUserInput
        ? derivePendingUserInputProgress(
            activePendingUserInput.questions,
            activePendingDraftAnswers,
            activePendingQuestionIndex,
          )
        : null,
    [activePendingDraftAnswers, activePendingQuestionIndex, activePendingUserInput],
  );
  const activePendingResolvedAnswers = useMemo(
    () =>
      activePendingUserInput
        ? buildPendingUserInputAnswers(activePendingUserInput.questions, activePendingDraftAnswers)
        : null,
    [activePendingDraftAnswers, activePendingUserInput],
  );
  const activePendingIsResponding = activePendingUserInput
    ? activePendingUserInput.responseCapability === "not_resumable" ||
      respondingUserInputRequestIds.includes(activePendingUserInput.requestId)
    : false;
  const activeProposedPlan = useMemo(() => {
    if (!latestRunSettled) {
      return null;
    }
    return findLatestProposedPlan(serverProjection, activeLatestRun?.runId ?? null);
  }, [activeLatestRun?.runId, latestRunSettled, serverProjection]);
  const showPlanFollowUpPrompt = shouldShowPlanFollowUpPrompt({
    pendingUserInputCount: pendingUserInputs.length,
    interactionMode,
    latestTurnSettled: latestRunSettled,
    hasActionableProposedPlan: hasActionableProposedPlan(activeProposedPlan),
    hasComposerAttachments: composerHasAttachments,
  });
  const activePendingApproval = pendingApprovals[0] ?? null;
  // The open /usage-limits panel for this thread, model and turn. Only the open
  // moment is stored: the rows read live provider data, so a redeemed reset
  // credit or refreshed probe shows through. Anything that spends quota closes
  // it: a new turn from any source, or the agent resuming after an approval or
  // answered question.
  const [usageLimitsPanel, setUsageLimitsPanel] = useState<{
    readonly key: string;
    readonly threadKey: string;
    readonly now: number;
  } | null>(null);
  // Null while the provider list or the thread itself is unavailable, such as
  // during a reconnect; the panel then stays hidden rather than being dropped.
  // A pending approval or question is part of the key: once it is answered,
  // from this client or any other, the agent resumes and spends quota.
  const usageLimitsKey =
    activeProviderInstanceId === null || (isServerThread && activeThread === undefined)
      ? null
      : [
          routeThreadKey,
          activeProviderInstanceId,
          activeThread?.latestRun?.runId ?? "",
          activePendingApproval?.requestId ?? activePendingUserInput?.requestId ?? "",
        ].join(":");
  // Drop the snapshot as soon as the thread or model changes so it cannot resurface stale.
  if (
    usageLimitsPanel !== null &&
    usageLimitsKey !== null &&
    usageLimitsPanel.key !== usageLimitsKey
  ) {
    setUsageLimitsPanel(null);
  }
  const usageLimitSources = serverConfig?.usageLimitSources ?? EMPTY_USAGE_LIMIT_SOURCES;
  const usageLimitsReport = useMemo(
    () =>
      usageLimitsPanel !== null &&
      usageLimitsKey !== null &&
      usageLimitsPanel.key === usageLimitsKey &&
      activeProviderInstanceId !== null
        ? collectProviderUsageLimits(
            activeProviderInstanceId,
            providerStatuses,
            usageLimitSources,
            usageLimitsPanel.now,
          )
        : null,
    [
      activeProviderInstanceId,
      providerStatuses,
      usageLimitSources,
      usageLimitsKey,
      usageLimitsPanel,
    ],
  );
  const usageLimitsBanner = useMemo(
    () =>
      usageLimitsReport !== null && usageLimitsPanel !== null
        ? // A fresh id per opening: the stack keeps the last dismissed id as "exiting".
          usageLimitsBannerItem(
            `usage-limits:${usageLimitsPanel.key}:${usageLimitsPanel.now}`,
            usageLimitsReport,
            environmentId,
            () => setUsageLimitsPanel(null),
          )
        : null,
    [environmentId, usageLimitsPanel, usageLimitsReport],
  );
  // T3 owns /usage-limits only where Limits has data for the selected provider;
  // elsewhere the name stays the provider's own and is sent through untouched.
  const usageLimitsOffered =
    activeProviderStatus !== null &&
    hasProviderUsageLimits(activeProviderStatus.driver, providerStatuses, usageLimitSources);
  // Answered locally from the last Limits snapshot; the agent never sees it.
  const openUsageLimits = () => {
    const now = Date.now();
    const report =
      activeProviderInstanceId !== null && usageLimitsKey !== null
        ? collectProviderUsageLimits(
            activeProviderInstanceId,
            providerStatuses,
            usageLimitSources,
            now,
          )
        : null;
    if (report && usageLimitsKey !== null) {
      setUsageLimitsPanel({ key: usageLimitsKey, threadKey: routeThreadKey, now });
      return true;
    }
    setUsageLimitsPanel(null);
    toastManager.add({ type: "info", title: "Usage limits are unavailable for this provider" });
    return false;
  };
  const openUsageLimitsStable = useStableCallback(openUsageLimits);
  // Responses can resolve after navigating away; only the originating thread's panel clears.
  const clearUsageLimitsFor = (threadKey: string) =>
    setUsageLimitsPanel((current) =>
      current !== null && current.threadKey === threadKey ? null : current,
    );
  const {
    beginLocalDispatch,
    resetLocalDispatch,
    localDispatchStartedAt,
    isPreparingWorktree: isLocallyPreparingWorktree,
    isSendBusy,
    backgroundSubmissionPending,
  } = useLocalDispatchState({
    activeThread,
    activeLatestRun,
    latestUserMessageId:
      serverProjection?.messages.findLast((message) => message.role === "user")?.id ?? null,
    phase,
    activePendingApproval: activePendingApproval?.requestId ?? null,
    activePendingUserInput: activePendingUserInput?.requestId ?? null,
    threadError,
  });
  const optimisticCompactionMessage = optimisticUserMessages.at(-1);
  const latestServerUserItem = serverVisibleTurnItems.findLast(
    (row) => row.item.type === "user_message",
  )?.item;
  const compactRequestIsActive =
    (isSendBusy &&
      optimisticCompactionMessage !== undefined &&
      isCompactCommandMessage(optimisticCompactionMessage)) ||
    (latestServerUserItem?.type === "user_message" &&
      latestServerUserItem.text.trim().toLowerCase() === "/compact" &&
      latestServerUserItem.attachments.length === 0 &&
      latestServerUserItem.runId === activeActivityRun?.runId &&
      !isLatestRunSettled(activeActivityRun, activeRuntime));
  const compactionSettled = serverVisibleTurnItems.some(
    ({ item }) =>
      item.type === "compaction" &&
      item.runId === activeActivityRun?.runId &&
      item.status === "completed",
  );
  const isCompacting =
    (isSendBusy || phase === "connecting" || phase === "running") &&
    compactRequestIsActive &&
    !compactionSettled;
  // A rewind is not agent work: the composer shows "Rewinding conversation"
  // instead of the timeline growing a Thinking row.
  const isWorking =
    phase === "running" ||
    isSendBusy ||
    isConnecting ||
    isCompacting ||
    runlessWorkStartedAt !== null;
  const activeContextWindow = useMemo(
    () =>
      deriveLatestContextWindowSnapshot(
        serverVisibleTurnItems ?? [],
        activeThreadLiveTokenUsage,
        serverProjection?.providerThreads.find(
          (thread) => thread.id === serverProjection.thread.activeProviderThreadId,
        ),
      ),
    [activeThreadLiveTokenUsage, serverVisibleTurnItems, serverProjection],
  );
  const pendingBackgroundTasks = useMemo(() => {
    if (serverProjection === null || serverProjection === undefined) {
      return [];
    }
    const sessionError =
      serverProjection.providerSessions.findLast(
        (session) => session.providerInstanceId === serverProjection.thread.providerInstanceId,
      )?.lastError ?? null;
    const latestRun =
      usageLimitRunPresentedAsLatest(
        serverProjection.runs,
        serverProjection.turnItems,
        sessionError,
      ) ?? latestUnheldRun(serverProjection.runs);
    return [
      ...derivePendingBackgroundWork({
        latestRun,
        providerThreads: serverProjection.providerThreads,
        turnItems: serverProjection.turnItems,
        activeProviderThreadId: serverProjection.thread.activeProviderThreadId,
        runs: serverProjection.runs,
        pullRequests: serverProjection.thread.pullRequests,
      }),
    ];
  }, [serverProjection]);
  const activeWorkStartedAt =
    deriveActiveWorkStartedAt(activeActivityRun, activeRuntime, localDispatchStartedAt) ??
    runlessWorkStartedAt;
  // Server-side workspace preparation: unlike the local-dispatch flag this
  // survives reloads and shows on remote viewers of the same thread.
  const activeRunPreparing = activeActivityRun?.status === "preparing";
  // The server queues a message behind a run that is still preparing its
  // worktree or starting its agent, so a send during setup waits there and
  // starts on its own instead of being refused.
  const sendQueuesBehindSetup =
    isServerThread && (activeRunPreparing || activeActivityRun?.status === "starting");
  // Such a send skips the local dispatch, so this keeps its thread's composer busy while it is
  // in flight.
  const [setupQueueSendThreadKey, setSetupQueueSendThreadKey] = useState<string | null>(null);
  useEffect(() => {
    attachmentPreviewHandoffByMessageIdRef.current = attachmentPreviewHandoffByMessageId;
  }, [attachmentPreviewHandoffByMessageId]);
  const clearAttachmentPreviewHandoff = (
    messageId: MessageId,
    previewUrls?: ReadonlyArray<string>,
  ) => {
    delete attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId];
    const currentPreviewUrls =
      previewUrls ?? attachmentPreviewHandoffByMessageIdRef.current[messageId] ?? [];
    setAttachmentPreviewHandoffByMessageId((existing) => {
      if (!(messageId in existing)) {
        return existing;
      }
      const next = { ...existing };
      delete next[messageId];
      attachmentPreviewHandoffByMessageIdRef.current = next;
      return next;
    });
    for (const previewUrl of currentPreviewUrls) {
      revokeBlobPreviewUrl(previewUrl);
    }
  };
  const clearAttachmentPreviewHandoffStable = useStableCallback(clearAttachmentPreviewHandoff);
  const clearAttachmentPreviewHandoffs = () => {
    attachmentPreviewPromotionInFlightByMessageIdRef.current = {};
    for (const previewUrls of Object.values(attachmentPreviewHandoffByMessageIdRef.current)) {
      for (const previewUrl of previewUrls) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
    const hadHandoffs = Object.keys(attachmentPreviewHandoffByMessageIdRef.current).length > 0;
    attachmentPreviewHandoffByMessageIdRef.current = {};
    // Runs whenever the view is hidden; with nothing handed off it changes nothing.
    if (hadHandoffs) setAttachmentPreviewHandoffByMessageId({});
  };
  const clearAttachmentPreviewHandoffsStable = useStableCallback(clearAttachmentPreviewHandoffs);
  useEffect(() => {
    return () => {
      clearAttachmentPreviewHandoffsStable();
      for (const message of optimisticUserMessagesRef.current) {
        revokeUserMessagePreviewUrls(message);
      }
    };
  }, [clearAttachmentPreviewHandoffsStable]);
  const handoffAttachmentPreviews = (messageId: MessageId, previewUrls: string[]) => {
    if (previewUrls.length === 0) return;

    const previousPreviewUrls = attachmentPreviewHandoffByMessageIdRef.current[messageId] ?? [];
    const nextPreviewUrlSet = new Set(previewUrls);
    for (const previewUrl of previousPreviewUrls) {
      if (!nextPreviewUrlSet.has(previewUrl)) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
    setAttachmentPreviewHandoffByMessageId((existing) => {
      const next = {
        ...existing,
        [messageId]: previewUrls,
      };
      attachmentPreviewHandoffByMessageIdRef.current = next;
      return next;
    });
  };
  const handoffAttachmentPreviewsStable = useStableCallback(handoffAttachmentPreviews);
  const downloadFileAttachment = async (attachment: ChatFileAttachment) => {
    const connection = readPreparedConnection(environmentId);
    if (!connection) {
      toastManager.add({ type: "error", title: "The environment is not connected." });
      return;
    }

    try {
      const url = await resolveFileAttachmentUrl({
        attachment,
        environmentId,
        httpBaseUrl: connection.httpBaseUrl,
        createAssetUrl: createAttachmentAssetUrl,
      });
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = attachment.name;
      anchor.click();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not download " + attachment.name,
        description: error instanceof Error ? error.message : "The attachment is unavailable.",
      });
    }
  };
  const downloadFileAttachmentStable = useStableCallback(downloadFileAttachment);
  const openFileAttachment = (attachment: ChatFileAttachment) => {
    if (!rightPanelSupported) {
      void downloadFileAttachment(attachment);
      return;
    }
    if (activeThreadRef) {
      useRightPanelStore.getState().openAttachment(activeThreadRef, attachment);
      return;
    }
  };
  const openFileAttachmentStable = useStableCallback(openFileAttachment);
  const serverAttachmentResources = useMemo(
    () =>
      selectHandoffImageResources(
        Object.keys(attachmentPreviewHandoffByMessageId).length === 0
          ? undefined
          : serverVisibleTurnItems.flatMap(({ item }) =>
              item.type === "user_message"
                ? [{ id: item.messageId, role: "user" as const, attachments: item.attachments }]
                : [],
            ),
        attachmentPreviewHandoffByMessageId,
      ),
    [serverVisibleTurnItems, attachmentPreviewHandoffByMessageId],
  );
  const serverAttachmentUrls = useAssetUrls(environmentId, serverAttachmentResources);
  const serverAttachmentUrlById = useMemo(
    () =>
      new Map(
        serverAttachmentResources.flatMap((resource, index) => {
          const url = serverAttachmentUrls[index];
          return url ? [[resource.attachmentId, url] as const] : [];
        }),
      ),
    [serverAttachmentResources, serverAttachmentUrls],
  );
  useEffect(() => {
    if (typeof Image === "undefined" || serverVisibleTurnItems.length === 0) {
      return;
    }

    const cleanups: Array<() => void> = [];
    const userMessagesById = new Map(
      serverVisibleTurnItems.flatMap((row) =>
        row.item.type === "user_message" ? [[String(row.item.messageId), row.item] as const] : [],
      ),
    );

    for (const [messageId, handoffPreviewUrls] of Object.entries(
      attachmentPreviewHandoffByMessageId,
    )) {
      if (attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId]) {
        continue;
      }

      const serverMessage = userMessagesById.get(messageId);
      if (serverMessage === undefined || serverMessage.attachments.length === 0) {
        continue;
      }

      const serverPreviewUrls = serverMessage.attachments.flatMap((attachment) =>
        attachment.type === "image"
          ? [serverAttachmentUrlById.get(attachment.id)].filter(
              (previewUrl): previewUrl is string => previewUrl !== undefined,
            )
          : [],
      );
      if (
        serverPreviewUrls.length === 0 ||
        serverPreviewUrls.length !== handoffPreviewUrls.length ||
        serverPreviewUrls.some((previewUrl) => previewUrl.startsWith("blob:"))
      ) {
        continue;
      }

      attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId] = true;

      let cancelled = false;
      const imageInstances: HTMLImageElement[] = [];

      const preloadServerPreviews = Promise.all(
        serverPreviewUrls.map(
          (previewUrl) =>
            new Promise<void>((resolve, reject) => {
              const image = new Image();
              imageInstances.push(image);
              const handleLoad = () => resolve();
              const handleError = () =>
                reject(new Error(`Failed to load server preview for ${messageId}.`));
              image.addEventListener("load", handleLoad, { once: true });
              image.addEventListener("error", handleError, { once: true });
              image.src = previewUrl;
            }),
        ),
      );

      void preloadServerPreviews
        .then(() => {
          if (cancelled) {
            return;
          }
          clearAttachmentPreviewHandoffStable(messageId as MessageId, handoffPreviewUrls);
        })
        .catch(() => {
          if (!cancelled) {
            delete attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId];
          }
        });

      cleanups.push(() => {
        cancelled = true;
        delete attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId];
        for (const image of imageInstances) {
          image.src = "";
        }
      });
    }

    return () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
  }, [
    attachmentPreviewHandoffByMessageId,
    clearAttachmentPreviewHandoffStable,
    serverAttachmentUrlById,
    serverVisibleTurnItems,
  ]);
  const timelineAttachmentUrlById = useMemo(() => {
    const urls = new Map(serverAttachmentUrlById);
    for (const row of serverVisibleTurnItems) {
      if (row.item.type !== "user_message") continue;
      const handoffUrls = attachmentPreviewHandoffByMessageId[row.item.messageId];
      if (handoffUrls === undefined) continue;
      let imageIndex = 0;
      for (const attachment of row.item.attachments) {
        if (attachment.type !== "image") continue;
        const handoffUrl = handoffUrls[imageIndex];
        imageIndex += 1;
        if (handoffUrl !== undefined) urls.set(attachment.id, handoffUrl);
      }
    }
    return urls;
  }, [attachmentPreviewHandoffByMessageId, serverAttachmentUrlById, serverVisibleTurnItems]);
  const anchoredTimelineMessages = useMemo(
    () =>
      feedbackSubmissions.flatMap((submission) =>
        submission.status === "interrupted"
          ? []
          : [
              { ...codexFeedbackMessage(submission), runId: null },
              { ...codexFeedbackMessage(submission, "assistant"), runId: null },
            ],
      ),
    [feedbackSubmissions],
  );
  const [timelineProjectionCache] = useState(() => new TimelineProjectionCache());
  const serverTimelineEntries = useMemo(() => {
    const previous = timelineProjectionCache.previousFor(activeThreadKey);
    const projection = deriveTimelineEntriesFromVisibleTurnItemsWithState(
      {
        visibleTurnItems: serverVisibleTurnItems,
        optimisticMessages: optimisticUserMessages,
        anchoredMessages: anchoredTimelineMessages,
        attachmentUrlById: timelineAttachmentUrlById,
        ...(serverProjection === null
          ? {}
          : {
              attempts: serverProjection.attempts,
              nodes: serverProjection.nodes,
              plans: serverProjection.plans,
            }),
      },
      previous,
    );
    timelineProjectionCache.remember(activeThreadKey, projection);
    return projection.entries;
  }, [
    timelineProjectionCache,
    activeThreadKey,
    anchoredTimelineMessages,
    optimisticUserMessages,
    serverVisibleTurnItems,
    serverProjection,
    timelineAttachmentUrlById,
  ]);
  const draftTimelineEntries = useMemo(
    () =>
      optimisticUserMessages.map(
        (message) =>
          ({
            id: message.id,
            kind: "message",
            createdAt: message.createdAt,
            message,
          }) as const,
      ),
    [optimisticUserMessages],
  );
  const timelineEntries = isServerThread ? serverTimelineEntries : draftTimelineEntries;
  const timelineMessages = useMemo(
    () => timelineEntries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
    [timelineEntries],
  );
  const displayedTimeline = resolveThreadSwitchTimeline({
    loading: timelineEntries.length === 0 && threadSyncPhase !== null,
    activeThreadKey,
    nextEntries: timelineEntries,
    rememberedForActive: peekRememberedThreadTimeline<typeof timelineEntries>(activeThreadKey),
  });
  const displayedTimelineKey = displayedTimeline.displayThreadKey ?? routeThreadKey;
  // The scroll-to-end button marks rows that arrived after the reader left
  // the live edge. It remembers the last row there was when it appeared.
  const latestDisplayedEntryId = displayedTimeline.entries.at(-1)?.id ?? null;
  const [scrollAwayEntry, setScrollAwayEntry] = useState<{
    readonly threadKey: string;
    readonly entryId: string | null;
  } | null>(null);
  if (!showScrollToBottom) {
    if (scrollAwayEntry !== null) setScrollAwayEntry(null);
  } else if (scrollAwayEntry === null || scrollAwayEntry.threadKey !== displayedTimelineKey) {
    setScrollAwayEntry({ threadKey: displayedTimelineKey, entryId: latestDisplayedEntryId });
  }
  const scrollToEndHasUnseen =
    scrollAwayEntry !== null &&
    scrollAwayEntry.threadKey === displayedTimelineKey &&
    scrollAwayEntry.entryId !== latestDisplayedEntryId;
  const paintOnlyDisplayedTimeline = isPaintOnlyThreadTimeline(
    displayedTimeline.displayThreadKey,
    activeThreadKey,
  );
  const displayedThreadRef = parseScopedThreadKey(displayedTimelineKey);
  const worktreeSetupOwnerKey = draftId ?? routeThreadKey;
  const worktreeSetupActive =
    worktreeSetupRef !== null && worktreeSetupRef.ownerKey === worktreeSetupOwnerKey;
  // Keep the sending environment during local draft setup; revisiting a
  // canonical thread subscribes by its durable identity.
  const setupTarget = worktreeSetupActive ? worktreeSetupRef : routeThreadRef;
  const worktreeSetupQuery = useEnvironmentQuery(
    worktreeSetupActive ||
      (activeThread?.id === routeThreadRef.threadId &&
        (isLocallyPreparingWorktree || activeRunPreparing || activeThread.worktreePath !== null))
      ? vcsEnvironment.worktreeSetup({
          environmentId: setupTarget.environmentId,
          input: { threadId: setupTarget.threadId },
        })
      : null,
  );
  const latestWorktreeSetup = worktreeSetupQuery.data;
  useEffect(() => {
    if (!latestWorktreeSetup) return;
    setHeldWorktreeSetup((current) =>
      current?.threadId === latestWorktreeSetup.threadId &&
      current.sequence > latestWorktreeSetup.sequence
        ? current
        : latestWorktreeSetup,
    );
  }, [latestWorktreeSetup]);
  useEffect(() => {
    setHeldWorktreeSetup(null);
  }, [routeThreadKey]);
  const { snapshot: liveWorktreeSetup, isPreparingWorktree } = resolveWorktreeSetupProgress({
    threadId: setupTarget.threadId,
    localPreparing: isLocallyPreparingWorktree,
    runStatus: activeActivityRun?.status,
    latest: latestWorktreeSetup,
    held: heldWorktreeSetup,
  });
  const worktreeSetup = resolveVisibleWorktreeSetup({
    live: liveWorktreeSetup,
    recorded: null,
    turnStarted: activeActivityRun?.startedAt != null,
    // Counts the optimistic send too, so the row retires the moment the
    // follow-up is on screen rather than when the server echoes it back.
    followUpSent: timelineMessages.filter((message) => message.role === "user").length > 1,
  });
  // Sends wait for the agent handoff, not for the setup script: an async
  // script keeps the snapshot running while the agent already works, and a
  // follow-up must not be held behind a slow install. Before the first
  // snapshot arrives the starting session stands in for it. Once the server
  // has the thread, a send queues behind the setup run instead.
  const worktreeSetupBlocksSend =
    !sendQueuesBehindSetup &&
    (worktreeSetup !== null
      ? worktreeSetup.phase === "running" && !worktreeSetupAgentStarted(worktreeSetup)
      : isPreparingWorktree);
  const cancelWorktreeSetup = useAtomCommand(vcsEnvironment.cancelWorktreeSetup, {
    reportFailure: false,
  });
  const retryWorkspacePreparation = useAtomCommand(threadEnvironment.retryWorkspacePreparation);
  const retryableRunIdsKey = useMemo(
    () =>
      [
        ...workspacePreparationRetryRunIds(
          serverProjection?.runs ?? [],
          serverProjection?.turnItems ?? [],
        ),
      ].join("\n"),
    [serverProjection?.runs, serverProjection?.turnItems],
  );
  // Keyed by content so the timeline context only changes when a retry appears or clears.
  const retryableWorkspacePreparationRunIds = useMemo(
    () => new Set(retryableRunIdsKey === "" ? [] : (retryableRunIdsKey.split("\n") as RunId[])),
    [retryableRunIdsKey],
  );
  const onRetryWorkspacePreparation = (runId: RunId) => {
    // One retry per failed run: a second click lands after the run is preparing again.
    if (!activeThreadRef || retryingWorkspacePreparationRunIds.has(runId)) return;
    retryingWorkspacePreparationRunIds.add(runId);
    void retryWorkspacePreparation({
      environmentId: activeThreadRef.environmentId,
      input: { threadId: activeThreadRef.threadId, runId },
    }).finally(() => retryingWorkspacePreparationRunIds.delete(runId));
  };
  const onRetryWorkspacePreparationStable = useStableCallback(onRetryWorkspacePreparation);
  const onCancelWorktreeSetup = () => {
    if (!worktreeSetup || worktreeSetup.phase !== "running") return;
    void cancelWorktreeSetup({
      environmentId: setupTarget.environmentId,
      input: { threadId: worktreeSetup.threadId },
    });
  };
  const onCancelWorktreeSetupStable = useStableCallback(onCancelWorktreeSetup);
  // The setup terminal belongs to the thread that was set up. A failed
  // bootstrap deletes that thread and closes its terminals, so only offer the
  // terminal while the setup thread is still the active one.
  const worktreeSetupThreadId = worktreeSetup?.threadId ?? null;
  const onOpenWorktreeSetupTerminal = useMemo(() => {
    if (
      worktreeSetupThreadId === null ||
      !activeThreadRef ||
      worktreeSetupThreadId !== activeThreadRef.threadId
    ) {
      return null;
    }
    const setupThreadRef = activeThreadRef;
    return (terminalId: string) => {
      useBottomPanelStore.getState().showRun(setupThreadRef, setupThreadRef.threadId, terminalId);
      setTerminalFocusRequestId((value) => value + 1);
    };
  }, [activeThreadRef, worktreeSetupThreadId]);
  const [dockedDraftHeroThreadKey, setDockedDraftHeroThreadKey] = useState<string | null>(null);
  const draftHeroDockRequested =
    activeThreadKey !== null && dockedDraftHeroThreadKey === activeThreadKey;
  // A thread nobody has written in yet opens like a new one, with its own
  // read-only headline (ThreadHeroHeadline) over the centred composer.
  const isEmptyServerThreadHero =
    !backgroundSubmissionPending &&
    resolveEmptyServerThreadHero({
      isServerThread,
      hasOwnEmptyState: activeThreadKind === "agentConversation" || embedded !== undefined,
      hasTimelineEntries: timelineEntries.length > 0,
      isWorking,
      hasHistoryToLoad: threadHistoryControls !== undefined,
      hasWorktreeSetupCard: worktreeSetup !== null,
      draftHeroDockRequested,
      shell: activeThreadShell,
    });
  const isDraftHeroState =
    isEmptyServerThreadHero ||
    resolveDraftHeroState({
      isLocalDraftThread,
      hasTimelineEntries: timelineEntries.length > 0,
      isWorking,
      draftHeroDockRequested,
      backgroundSubmissionPending,
      hasWorktreeSetupCard: worktreeSetup !== null,
    });
  const embeddedEmptyStateVisible =
    timelineEntries.length === 0 && !isWorking && !threadDetailLoading && !isDraftHeroState;
  const {
    attachTransitionGroup: attachDraftHeroTransitionGroup,
    attachComposerAnchor: attachDraftHeroComposerAnchor,
    captureComposerRect: captureDraftHeroComposerRect,
  } = useDraftHeroLayoutTransition(
    isDraftHeroState,
    LAYOUT_MOTION_DURATION,
    !isEmptyServerThreadHero,
  );
  // The centred hero centres on the composer itself, not on whatever hangs
  // below it: the context strip (Work's worktree and branch, the machine) often
  // arrives after the screen paints, and would otherwise push the headline and
  // composer up as it grows. The lane reserves the same height above, so a new
  // chat and a new Work draft land in the same place and only the strip moves.
  const [draftHeroBelowSurface, setDraftHeroBelowSurface] = useState(0);
  useLayoutEffect(() => {
    if (!isDraftHeroState || !composerOverlayElement) {
      setDraftHeroBelowSurface(0);
      return;
    }
    const stack = composerOverlayElement.querySelector<HTMLElement>(
      '[data-chat-composer-stack="true"]',
    );
    const surface = composerOverlayElement.querySelector<HTMLElement>(
      '[data-chat-composer-main-surface="true"]',
    );
    if (!stack || !surface) return;
    const measure = () => {
      const below = Math.max(
        0,
        Math.round(stack.getBoundingClientRect().bottom - surface.getBoundingClientRect().bottom),
      );
      setDraftHeroBelowSurface((current) => (current === below ? current : below));
    };
    measure();
    return observeResize([stack, surface], measure);
  }, [composerOverlayElement, isDraftHeroState]);
  const { turnDiffSummaries } = useTurnDiffSummaries(serverProjection);

  /**
   * The latest settled item after which files on disk may have changed.
   * File tools are explicit; completed commands are included because a shell
   * command can mutate the workspace without reporting the paths it touched.
   */
  const workspaceMutationId = useMemo(() => {
    let itemId: string | null = null;
    for (let index = serverVisibleTurnItems.length - 1; index >= 0; index -= 1) {
      const item = serverVisibleTurnItems[index]?.item;
      if (!item) continue;
      if (item.type !== "command_execution" && item.type !== "file_change") continue;
      if (item.status === "pending" || item.status === "running" || item.status === "waiting") {
        continue;
      }
      itemId = item.id;
      break;
    }
    const latestCheckpointCompletedAt = turnDiffSummaries.at(-1)?.completedAt ?? null;
    return itemId === null && latestCheckpointCompletedAt === null
      ? null
      : JSON.stringify([itemId, latestCheckpointCompletedAt]);
  }, [serverVisibleTurnItems, turnDiffSummaries]);

  const gitCwd = activeProject
    ? projectScriptCwd({
        project: { cwd: activeProject.workspaceRoot },
        worktreePath: activeThread?.worktreePath ?? null,
      })
    : null;
  const gitStatusCwd = activeThread?.worktreePath ?? gitCwd;
  const gitStatusQuery = useEnvironmentQuery(
    gitStatusCwd === null
      ? null
      : vcsEnvironment.status({
          environmentId,
          input: { cwd: gitStatusCwd },
        }),
  );
  useWorkspaceMutationRefresh({
    enabled: gitStatusCwd !== null,
    mutationId: workspaceMutationId,
    refresh: gitStatusQuery.refresh,
    resourceKey: `git-status:${activeThreadKey ?? ""}:${gitStatusCwd ?? ""}`,
  });
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const scriptKeybindings =
    useAtomValue(serverEnvironment.configValueAtom(environmentId))?.keybindings ??
    DEFAULT_RESOLVED_KEYBINDINGS;
  const manualCompactionProviderAvailable = useMemo(
    () =>
      hasAvailableCompactionProvider({
        providers: providerInstanceEntries,
        driverKind: selectedProvider,
        instanceId: activeProviderInstanceId,
        lockedInstanceId: lockedProvider
          ? (activeRuntime?.providerInstanceId ?? activeThread?.modelSelection.instanceId ?? null)
          : null,
      }),
    [
      activeProviderInstanceId,
      activeThread?.modelSelection.instanceId,
      activeRuntime?.providerInstanceId,
      lockedProvider,
      providerInstanceEntries,
      selectedProvider,
    ],
  );
  const [resumeCompactionPermanentlyDismissed, setResumeCompactionPermanentlyDismissed] =
    useLocalStorage(
      `cogenly:resume-compaction-dismissed:${environmentId}:${activeProviderInstanceId ?? "claudeAgent"}`,
      false,
      Schema.Boolean,
    );
  const nativeResumeCompactionDismissed = useMemo(
    () =>
      hasDismissedResumeCompaction(
        (serverProjection?.runtimeRequests ?? [])
          .filter((request) => request.kind === "user_input" && request.status === "resolved")
          .map((request) => ({
            kind: "user-input.resolved",
            payload: { answers: request.answers },
          })),
      ),
    [serverProjection?.runtimeRequests],
  );
  useEffect(() => {
    if (nativeResumeCompactionDismissed && !resumeCompactionPermanentlyDismissed) {
      setResumeCompactionPermanentlyDismissed(true);
    }
  }, [
    nativeResumeCompactionDismissed,
    resumeCompactionPermanentlyDismissed,
    setResumeCompactionPermanentlyDismissed,
  ]);
  const providerStatusBannerKey = getProviderStatusBannerKey(activeProviderStatus);
  const [dismissedProviderStatusBannerKey, setDismissedProviderStatusBannerKey] = useState<
    string | null
  >(null);
  useEffect(() => {
    if (providerStatusBannerKey === null && dismissedProviderStatusBannerKey !== null) {
      setDismissedProviderStatusBannerKey(null);
    }
  }, [dismissedProviderStatusBannerKey, providerStatusBannerKey]);
  const visibleProviderStatus = shouldShowProviderStatusBanner(
    activeProviderStatus,
    dismissedProviderStatusBannerKey,
  )
    ? activeProviderStatus
    : null;
  const hasTimelineTopBanner = Boolean(timelineThreadError) || visibleProviderStatus !== null;
  const activeProjectCwd = activeProject?.workspaceRoot ?? null;
  const activeThreadWorktreePath = activeThread?.worktreePath ?? null;
  const activeWorkspaceRoot = activeThreadWorktreePath ?? activeProjectCwd ?? undefined;
  useLayoutEffect(() => {
    if (
      threadDetailLoading ||
      timelineEntries.length === 0 ||
      timelineHasEphemeralPreviewUrls(timelineEntries)
    ) {
      return;
    }
    rememberReadyThreadTimeline({
      threadKey: activeThreadKey,
      entries: timelineEntries,
      markdownCwd: gitCwd,
      workspaceRoot: activeWorkspaceRoot ?? null,
    });
  }, [activeThreadKey, activeWorkspaceRoot, gitCwd, threadDetailLoading, timelineEntries]);
  const heldPaintContext = paintOnlyDisplayedTimeline
    ? peekHeldThreadTimeline<typeof timelineEntries>()
    : null;
  // Git status arrives after the composer paints. A checkout seen earlier in
  // this session answers from memory, so a non-Git project does not mount the
  // branch strip and then drop it. A never-seen checkout assumes Git, which
  // is what nearly every project is.
  const liveIsGitRepo = gitStatusQuery.data?.isRepo;
  useEffect(() => {
    if (gitStatusCwd !== null && liveIsGitRepo !== undefined) {
      rememberCheckoutIsRepo(environmentId, gitStatusCwd, liveIsGitRepo);
    }
  }, [environmentId, gitStatusCwd, liveIsGitRepo]);
  // A chat never offers branch, worktree or diff controls, whatever its folder holds.
  const isGitRepo =
    activeThreadCapabilities.git &&
    (liveIsGitRepo ?? recallCheckoutIsRepo(environmentId, gitStatusCwd) ?? true);
  // When context is enabled, keep a hidden, off-flow strip mounted so the composer
  // can measure whether its relocated controls fit. The visible chrome remains
  // content-driven: Git/environment context or controls that actually fit.
  // A provider-native subagent keeps the normal composer: a message sent while
  // its provider still runs it waits in the queue, then runs as its own turn.
  // A notice above the composer names its model and status. Its approvals and
  // questions are asked on the top-level parent thread.
  const providerSubagentModels = selectedProviderEntry?.models ?? EMPTY_PROVIDER_MODELS;
  // Providers can report a dated id or alias (claude-haiku-4-5-20251001).
  const providerSubagentModelSlug = selectedProviderEntry
    ? resolveSelectableModel(
        selectedProviderEntry.driverKind,
        activeThread?.modelSelection.model,
        providerSubagentModels,
      )
    : null;
  const providerSubagentCatalogModel = providerSubagentModels.find(
    (model) => model.slug === providerSubagentModelSlug,
  );
  const providerSubagentModelLabel = providerSubagentCatalogModel
    ? getTriggerDisplayModelName(providerSubagentCatalogModel)
    : formatModelSlugName(activeThread?.modelSelection.model ?? "");
  const providerSubagentEffortLabel =
    activeThread === undefined
      ? null
      : formatModelSelectionEffort(
          activeThread.modelSelection,
          providerSubagentModels,
          reportedModelSelection,
        );
  const mountComposerContextStrip = shouldShowComposerContextStrip({
    isDraftHeroState,
    persistInActiveThreads: settings.persistComposerContextStrip,
    hasActiveProject: activeProject !== null,
    isGitRepo,
    showEnvironmentIndicator: showComposerEnvironmentIndicator,
    hostsRestingComposerControls: routeKind === "server",
  });
  const showComposerContextStrip = shouldShowComposerContextStrip({
    isDraftHeroState,
    persistInActiveThreads: settings.persistComposerContextStrip,
    hasActiveProject: activeProject !== null,
    isGitRepo,
    showEnvironmentIndicator: showComposerEnvironmentIndicator,
    hostsRestingComposerControls: routeKind === "server" && restingComposerControlsVisible,
  });
  const mountComposerModelStrip = routeKind === "server" && !mountComposerContextStrip;
  const showComposerModelStrip = mountComposerModelStrip && restingComposerControlsVisible;
  // The shell's silhouette follows the strip while it grows and collapses.
  const composerStripVisible = showComposerContextStrip || showComposerModelStrip;
  const [composerStripLingering, setComposerStripLingering] = useState(false);
  const composerStripExtended = useExtendedAfterFrame(composerStripVisible);

  const needsLoadBalancing = automaticEnvironment && !draftThread?.loadBalancedEnvironmentId;
  const loadBalancingCandidates = useMemo(
    () =>
      needsLoadBalancing
        ? logicalProjectEnvironments
            .filter((candidate) => {
              const environment = environmentById.get(candidate.environmentId);
              return (
                environment?.connection.phase === "connected" &&
                (loadBalancingSettings.loadBalancingWeights[candidate.environmentId] ?? 50) > 0 &&
                environment.serverConfig?.providers.some(
                  (provider) =>
                    (activeProviderInstanceId === null ||
                      provider.instanceId === activeProviderInstanceId) &&
                    provider.driver === selectedProvider &&
                    // The destination project may override the machine switch.
                    (environment.serverConfig?.settings
                      ? resolveProjectProviderInstanceEnabled(
                          environment.serverConfig.settings,
                          candidate.projectId,
                          provider.instanceId,
                        )
                      : provider.enabled) &&
                    provider.installed &&
                    provider.status !== "error" &&
                    provider.auth.status !== "unauthenticated" &&
                    provider.availability !== "unavailable",
                )
              );
            })
            .map((candidate) => candidate.environmentId)
        : [],
    [
      needsLoadBalancing,
      logicalProjectEnvironments,
      environmentById,
      loadBalancingSettings.loadBalancingWeights,
      activeProviderInstanceId,
      selectedProvider,
    ],
  );
  const loadBalancing = useLoadBalancedEnvironment(
    loadBalancingCandidates,
    loadBalancingSettings.loadBalancingWeights,
  );
  useEffect(() => {
    if (!needsLoadBalancing || loadBalancing.pending || !draftId || sendInFlightRef.current) return;
    const target = logicalProjectEnvironments.find(
      (environment) => environment.environmentId === loadBalancing.environmentId,
    );
    if (!target?.projectId) return;
    setDraftThreadContext(draftId, {
      projectRef: scopeProjectRef(target.environmentId, target.projectId),
      environmentSelection: "auto",
      loadBalancedEnvironmentId: target.environmentId,
    });
  }, [
    needsLoadBalancing,
    loadBalancing.pending,
    loadBalancing.environmentId,
    draftId,
    logicalProjectEnvironments,
    setDraftThreadContext,
  ]);
  const onAutoEnvironment = () => {
    if (envLocked || !draftId) return;
    if (composerHasAttachments) {
      toastManager.add({
        type: "warning",
        id: "load-balancing-attachments",
        title: "Keep attachments on this machine",
        description:
          "Remove attachments before choosing automatic routing, then attach them on the selected machine.",
      });
      return;
    }
    loadBalancing.refresh(
      logicalProjectEnvironments.map((environment) => environment.environmentId),
    );
    setDraftThreadContext(draftId, {
      environmentSelection: "auto",
      loadBalancedEnvironmentId: null,
      launchMachine: null,
      branch: null,
      worktreePath: null,
    });
  };
  const onAutoEnvironmentStable = useStableCallback(onAutoEnvironment);
  const autoEnvironmentLabel = automaticEnvironment
    ? draftThread?.loadBalancedEnvironmentId
      ? "Auto balance"
      : loadBalancing.pending
        ? "Checking machines…"
        : loadBalancing.failed
          ? "Auto balance unavailable"
          : "Auto balance"
    : undefined;

  // The machine an in-flight switch is heading to; a newer switch replaces it.
  const environmentChangeRef = useRef<{ readonly environmentId: EnvironmentId } | null>(null);
  const [isEnvironmentChanging, setIsEnvironmentChanging] = useState(false);
  useLayoutEffect(() => {
    return () => {
      environmentChangeRef.current = null;
      setIsEnvironmentChanging(false);
    };
  }, [draftId, activeProjectKey]);

  const onEnvironmentChange = (nextEnvironmentId: EnvironmentId) => {
    if (envLocked || !draftId || sendInFlightRef.current) return;
    const originalDraft = getDraftSession(draftId);
    if (!originalDraft || originalDraft.promotedTo) return;
    const pick = resolveRunOnPick(runOnOptions, nextEnvironmentId);
    if (!pick) return;
    if (pick.kind === "machine") {
      // The draft stays on its environment, which launches it on the machine.
      // An existing worktree's path is this machine's; the branch carries over.
      environmentChangeRef.current = null;
      setIsEnvironmentChanging(false);
      setDraftThreadContext(draftId, {
        launchMachine: pick.environmentId,
        environmentSelection: "manual",
        loadBalancedEnvironmentId: null,
        worktreePath: null,
      });
      return;
    }
    const target = pick.option;
    const request = { environmentId: target.environmentId };
    environmentChangeRef.current = request;
    setIsEnvironmentChanging(false);
    const retarget = (project: (typeof allProjects)[number]) => {
      const currentDraft = getDraftSession(draftId);
      if (
        environmentChangeRef.current !== request ||
        sendInFlightRef.current ||
        !currentDraft ||
        currentDraft.promotedTo ||
        currentDraft.environmentId !== originalDraft.environmentId ||
        currentDraft.projectId !== originalDraft.projectId
      )
        return;
      const projectRef = scopeProjectRef(target.environmentId, project.id);
      if (activeProjectIsScratch) {
        // Scratch projects are machine-local, so move their logical mapping too.
        setLogicalProjectDraftThreadId(
          deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings),
          projectRef,
          draftId,
          { environmentSelection: "manual", loadBalancedEnvironmentId: null, launchMachine: null },
        );
      } else {
        setDraftThreadContext(draftId, {
          projectRef,
          environmentSelection: "manual",
          loadBalancedEnvironmentId: null,
          launchMachine: null,
        });
      }
    };
    const finish = () => {
      if (environmentChangeRef.current === request) {
        environmentChangeRef.current = null;
        setIsEnvironmentChanging(false);
      }
    };
    if (target.projectId !== null) {
      const project = allProjects.find(
        (project) =>
          project.environmentId === target.environmentId && project.id === target.projectId,
      );
      if (project) retarget(project);
      finish();
      return;
    }
    // Keep send disabled until the destination Scratch project is ready.
    setIsEnvironmentChanging(true);
    void openScratchProject(target.environmentId, "Could not switch machine")
      .then((project) => {
        if (project) retarget(project);
      })
      .finally(finish);
  };
  const onEnvironmentChangeStable = useStableCallback(onEnvironmentChange);

  const serverThreadId = serverThread?.id;
  const serverThreadEnvironmentId = serverThread?.environmentId;
  const setThreadError = useMemo(
    () =>
      makeThreadErrorSetter({
        routeThreadRef,
        routeThreadKey,
        draftId,
        serverThreadRef:
          serverThreadId !== undefined && serverThreadEnvironmentId !== undefined
            ? { threadId: serverThreadId, environmentId: serverThreadEnvironmentId }
            : null,
        setLocalServerErrorsByThreadKey,
        setLocalDraftErrorsByDraftId,
      }),
    [draftId, routeThreadKey, routeThreadRef, serverThreadId, serverThreadEnvironmentId],
  );

  const focusComposer = () => {
    composerRef.current?.focusAtEnd();
  };
  const focusComposerStable = useStableCallback(focusComposer);
  const fillEmbeddedComposer = useStableCallback((prompt: string) => {
    setComposerDraftPrompt(composerDraftTarget, prompt);
    window.requestAnimationFrame(() => composerRef.current?.focusAtEnd());
  });
  const canInterruptRunningThread =
    canOperateThread && deriveCanInterruptRunningThread(activeThread !== undefined, activeRuntime);
  const onInterrupt = async () => {
    if (
      !activeThread ||
      !readEnvironmentScope(activeThread.environmentId, AuthOrchestrationOperateScope)
    )
      return;
    const result = await interruptThreadTurn({
      environmentId,
      input: { threadId: activeThread.id },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setThreadError(
        activeThread.id,
        error instanceof Error ? error.message : "Failed to interrupt the current turn.",
      );
    }
  };
  const onInterruptStable = useStableCallback(onInterrupt);
  const scheduleComposerFocus = () => {
    window.requestAnimationFrame(() => {
      focusComposer();
    });
  };
  const scheduleComposerFocusStable = useStableCallback(scheduleComposerFocus);
  const useArtifactTemplate = (template: CodexArtifactTemplate) => {
    const composer = composerRef.current;
    if (!composer) return;

    const currentDraft = composer.getSendContext().prompt;
    const prompt = codexArtifactTemplatePromptToAppend(currentDraft, template);
    if (prompt !== null && !composer.insertTextAtEnd(prompt, { ensureLeadingBoundary: true })) {
      toastManager.add({
        type: "error",
        title: "Unable to add to chat",
        description: "The composer is busy; try again once it is ready.",
      });
      return;
    }
    scheduleComposerFocus();
  };
  const useArtifactTemplateStable = useStableCallback(useArtifactTemplate);
  // An MCP App's approved `ui/message`: queued like a typed message, so it
  // never steers or interrupts a running turn.
  const sendAppMessage = async (text: string) => {
    if (!isServerThread || activeThreadId === null) {
      throw new Error("Messages from apps need a started thread.");
    }
    const result = await startThreadTurn({
      environmentId,
      input: {
        threadId: activeThreadId,
        message: { messageId: newMessageId(), role: "user", text, attachments: [] },
        runtimeMode,
        interactionMode,
        dispatchMode: "queue",
      },
    });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      throw error instanceof Error ? error : new Error("Could not send the app's message.");
    }
  };
  const sendAppMessageStable = useStableCallback(sendAppMessage);
  const editQueuedRunCommand = useAtomCommand(threadEnvironment.editQueuedRun, {
    reportFailure: false,
  });
  const queuedRunsControlRef = useRef<QueuedRunsControlHandle>(null);
  const queuedEditSaveInFlightRef = useRef(false);
  const [isSavingQueuedEdit, setIsSavingQueuedEdit] = useState(false);
  const queuedEditImageResources = useMemo(
    () =>
      (editingQueuedRun?.existingAttachments ?? [])
        .filter((attachment) => attachment.type === "image")
        .map((attachment) => ({ _tag: "attachment" as const, attachmentId: attachment.id })),
    [editingQueuedRun],
  );
  const queuedEditImageUrls = useAssetUrls(environmentId, queuedEditImageResources);
  const composerEditingQueuedAttachments = useMemo(() => {
    if (editingQueuedRun === null) return null;
    const urlByAttachmentId = new Map(
      queuedEditImageResources.map((resource, index) => [
        resource.attachmentId,
        queuedEditImageUrls[index] ?? null,
      ]),
    );
    return editingQueuedRun.existingAttachments.map((attachment) => ({
      attachment,
      url: urlByAttachmentId.get(attachment.id) ?? null,
    }));
  }, [editingQueuedRun, queuedEditImageResources, queuedEditImageUrls]);
  const beginEditingQueuedRun = (request: EditQueuedRunRequest) => {
    if (!activeThread) return;
    if (editingQueuedRun !== null && editingQueuedRun.runId !== request.runId) {
      clearComposerDraftContent(queuedEditDraftTargetFor(editingQueuedRun.runId));
    }
    const target = queuedEditDraftTargetFor(request.runId);
    clearComposerDraftContent(target);
    setComposerDraftPrompt(target, request.text);
    setEditingQueuedRun({
      threadId: activeThread.id,
      runId: request.runId,
      messageId: request.messageId,
      originalText: request.text,
      existingAttachments: request.attachments,
      context: serverProjection?.messages.find((message) => message.id === request.messageId)
        ?.context,
    });
    scheduleComposerFocus();
  };
  const beginEditingQueuedRunStable = useStableCallback(beginEditingQueuedRun);
  const cancelEditingQueuedRun = () => {
    if (editingQueuedRun === null) return;
    clearComposerDraftContent(queuedEditDraftTargetFor(editingQueuedRun.runId));
    setEditingQueuedRun(null);
    scheduleComposerFocus();
  };
  const cancelEditingQueuedRunStable = useStableCallback(cancelEditingQueuedRun);
  const removeEditingQueuedAttachment = (attachmentId: string) => {
    setEditingQueuedRun((current) =>
      current === null
        ? current
        : {
            ...current,
            existingAttachments: current.existingAttachments.filter(
              (attachment) => attachment.id !== attachmentId,
            ),
          },
    );
  };
  const removeEditingQueuedAttachmentStable = useStableCallback(removeEditingQueuedAttachment);
  // Exit edit mode when the edited run leaves the queue (it started, or was
  // cancelled from another client). A dirty edit moves into the thread's own
  // draft when that draft is empty; otherwise it is dropped with a toast.
  useEffect(() => {
    if (editingQueuedRun === null) return;
    if (activeThread?.id !== editingQueuedRun.threadId) {
      setEditingQueuedRun(null);
      return;
    }
    if (serverProjection === null) return;
    const run = serverProjection.runs.find((candidate) => candidate.id === editingQueuedRun.runId);
    if (run !== undefined && run.status === "queued") return;
    const recovery = recoverQueuedMessageEdit({
      editTarget: queuedEditDraftTargetFor(editingQueuedRun.runId),
      threadTarget: baseComposerDraftTarget,
      originalText: editingQueuedRun.originalText,
    });
    if (recovery === "kept") {
      toastManager.add(
        stackedThreadToast({
          type: "info",
          title: "Queued message is no longer queued",
          description: "Your unsaved edit was kept in the composer.",
        }),
      );
    } else if (recovery === "discarded") {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Queued message is no longer queued",
          description: "Your unsaved edit was discarded.",
        }),
      );
    }
    setEditingQueuedRun(null);
  }, [
    activeThread?.id,
    baseComposerDraftTarget,
    editingQueuedRun,
    queuedEditDraftTargetFor,
    serverProjection,
  ]);
  const addTerminalContextToDraft = (selection: TerminalContextSelection) => {
    composerRef.current?.addTerminalContext(selection);
  };
  const addTerminalContextToDraftStable = useStableCallback(addTerminalContextToDraft);

  const handleInteractionModeChange = (mode: ProviderInteractionMode) => {
    if (mode === "plan" && !interactionModeEnabled) return;
    if (mode === interactionMode) return;
    setComposerDraftInteractionMode(composerDraftTarget, mode);
    if (isLocalDraftThread) {
      setDraftThreadContext(composerDraftTarget, { interactionMode: mode });
    }
    scheduleComposerFocus();
  };
  const handleInteractionModeChangeStable = useStableCallback(handleInteractionModeChange);
  const handleRuntimeModeChange = (mode: RuntimeMode) => {
    if (mode === runtimeMode) return;
    setComposerDraftRuntimeMode(composerDraftTarget, mode);
    if (isLocalDraftThread) {
      setDraftThreadContext(composerDraftTarget, { runtimeMode: mode });
    }
    scheduleComposerFocus();
  };
  const handleRuntimeModeChangeStable = useStableCallback(handleRuntimeModeChange);
  const toggleInteractionMode = () => {
    if (!interactionModeEnabled) return;
    handleInteractionModeChange(interactionMode === "plan" ? "default" : "plan");
  };
  const toggleInteractionModeStable = useStableCallback(toggleInteractionMode);
  const openProviderSetup = (instanceId: ProviderInstanceId) => {
    void navigate({
      to: "/settings/providers",
      search: { environmentId, instanceId },
    });
  };
  const openProviderSetupStable = useStableCallback(openProviderSetup);
  const canOperatePreview = useEnvironmentScope(
    activeThreadRef?.environmentId ?? null,
    AuthPreviewOperateScope,
  );
  // A browser tab that has not gone anywhere yet is reused rather than joined
  // by another one, so "+" and the header never stack identical empty tabs.
  const createBrowserSurface = (profileId?: string) => {
    if (!activeThreadRef || !canOperatePreview || !activeThreadCapabilities.browser) return;
    if (profileId === undefined) {
      const idle = rightPanelState.surfaces.find(
        (surface) =>
          surface.kind === "preview" &&
          surface.resourceId !== null &&
          activePreviewState.sessions[surface.resourceId]?.navStatus._tag === "Idle",
      );
      if (idle?.kind === "preview" && idle.resourceId) {
        useRightPanelStore.getState().activateSurface(activeThreadRef, idle.id);
        setActivePreviewTab(activeThreadRef, idle.resourceId);
        return;
      }
    }
    void addBrowserSurface({
      threadRef: activeThreadRef,
      openPreview,
      ...(profileId === undefined ? {} : { profileId }),
    }).then((result) => {
      if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      if (error instanceof BrowserSettingsReadError) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open browser",
            description: error.message,
          }),
        );
      }
    });
  };
  const createBrowserSurfaceStable = useStableCallback(createBrowserSurface);

  const { state: deviceState, loaded: deviceStateLoaded } = useDeviceState(
    activeThreadRef?.environmentId ?? null,
  );
  const [deviceSetupThread, setDeviceSetupThread] = useState<ScopedThreadRef | null>(null);
  const deviceAddMenu = useDeviceTabActions({
    threadRef: activeThreadRef,
    state: deviceState,
    surfaces: rightPanelState.surfaces,
  });
  const addDeviceSurface = () => {
    if (!activeThreadRef || !activeThreadCapabilities.device) return;
    useRightPanelStore.getState().open(activeThreadRef, "device");
  };
  // A device the agent opens floats over chat like an agent-driven browser,
  // or becomes a panel tab when floating previews are off. Sessions opened by
  // another client arrive the same way; sheet layouts get neither. Every
  // session with a known device and no tab gets one, including those opened
  // while another thread was showing: this thread's first snapshot is not a
  // baseline to skip, because a tab the user closed is remembered as dismissed
  // by the store and automatic opens leave it closed. A session that is opened
  // again (new `openedAt`) is an explicit request, so it brings back a tab the
  // user had closed. A session whose device summary has not arrived yet stays
  // out of the snapshot so a later one opens it.
  const previousDeviceSessions = useRef(new Map<string, Map<string, string>>());
  useEffect(() => {
    if (!activeThreadRef || !deviceStateLoaded) return;
    const threadKey = `${activeThreadRef.environmentId}:${activeThreadRef.threadId}`;
    const sessions = deviceState.sessions.filter(
      (session) => session.threadId === activeThreadRef.threadId,
    );
    const key = (session: (typeof sessions)[number]) => `${session.hostId}:${session.deviceId}`;
    const deviceFor = (session: (typeof sessions)[number]) =>
      deviceState.devices.find(
        (entry) => entry.hostId === session.hostId && entry.id === session.deviceId,
      );
    const previous = previousDeviceSessions.current.get(threadKey);
    previousDeviceSessions.current.set(
      threadKey,
      new Map(
        sessions
          .filter((session) => deviceFor(session) !== undefined)
          .map((session) => [key(session), session.openedAt]),
      ),
    );
    if (shouldUsePlanSidebarSheet) return;
    for (const session of sessions) {
      const previousOpenedAt = previous?.get(key(session));
      if (previousOpenedAt === session.openedAt) continue;
      const reopened = previousOpenedAt !== undefined;
      const device = deviceFor(session);
      if (!device) continue;
      const target = {
        hostId: session.hostId,
        deviceId: session.deviceId,
        platform: device.platform,
        name: device.name,
      };
      const existing = useRightPanelStore
        .getState()
        .byThreadKey[scopedThreadKey(activeThreadRef)]?.surfaces.some(
          (surface) =>
            surface.kind === "device" &&
            surface.target?.hostId === session.hostId &&
            surface.target.deviceId === session.deviceId,
        );
      if (existing) continue;
      useRightPanelStore.getState().openDevice(activeThreadRef, target, !reopened);
    }
  }, [
    activeThreadRef,
    deviceStateLoaded,
    shouldUsePlanSidebarSheet,
    deviceState.sessions,
    deviceState.devices,
  ]);
  // Baseline loaded tabs so reloads never reopen previews the user dismissed.
  const previousServerPreviewTabs = useRef(new Map<string, Map<string, string | undefined>>());
  useEffect(() => {
    if (!activeThreadRef || !activeEnvironmentServerBrowser || !activePreviewState.listLoaded)
      return;
    const threadKey = scopedThreadKey(activeThreadRef);
    const serverSessions = Object.values(activePreviewState.sessions).filter(
      (session) => session.runtime === "server",
    );
    const previous = previousServerPreviewTabs.current.get(threadKey);
    previousServerPreviewTabs.current.set(
      threadKey,
      new Map(serverSessions.map((session) => [session.tabId, session.revealRequest?.id])),
    );
    if (!previous) return;
    for (const session of serverSessions) {
      const requested = session.revealRequest;
      const fresh = requested
        ? previous.get(session.tabId) !== requested.id
        : !previous.has(session.tabId);
      if (!fresh || session.reveal !== true) continue;
      const surface = rightPanelState.surfaces.find(
        (surface) => surface.kind === "preview" && surface.resourceId === session.tabId,
      );
      if (requested?.force === true) {
        if (surface) useRightPanelStore.getState().activateSurface(activeThreadRef, surface.id);
        else useRightPanelStore.getState().openBrowser(activeThreadRef, session.tabId);
      } else if (!surface && !shouldUsePlanSidebarSheet) {
        // A new tab the agent revealed without forcing it joins the panel's tabs,
        // but a panel the user closed stays closed (the floating preview shows
        // the tab instead); the phone sheet waits to be asked.
        useRightPanelStore
          .getState()
          .openBrowser(activeThreadRef, session.tabId, { reveal: rightPanelState.isOpen });
      }
    }
  }, [
    activeEnvironmentServerBrowser,
    activePreviewState.listLoaded,
    activePreviewState.sessions,
    activeThreadRef,
    rightPanelState.isOpen,
    rightPanelState.surfaces,
    shouldUsePlanSidebarSheet,
  ]);
  const openFileSurface = (relativePath: string) => {
    if (!activeThreadRef || !activeProject) return;
    useRightPanelStore.getState().openFile(activeThreadRef, relativePath);
  };
  const openFileSurfaceStable = useStableCallback(openFileSurface);
  const activeRunningTurnId = activeRuntime?.activeRunId ?? null;
  const closePreviewPanel = () => {
    if (activeThreadRef) {
      useRightPanelStore.getState().setMaximized(activeThreadRef, false);
      useRightPanelStore.getState().close(activeThreadRef);
    }
  };
  const closePreviewPanelStable = useStableCallback(closePreviewPanel);
  const togglePreviewPanel = () => {
    if (!activeThreadRef || !browserAvailable || !activeThreadCapabilities.browser) return;
    if (previewPanelOpen) {
      closePreviewPanel();
      return;
    }
    if (!canOperatePreview) return;
    const existing = selectGroupSurface(rightPanelState, "browser");
    if (existing?.kind === "preview" && existing.resourceId) {
      useRightPanelStore.getState().activateSurface(activeThreadRef, existing.id);
      setActivePreviewTab(activeThreadRef, existing.resourceId);
    } else {
      createBrowserSurface();
    }
  };
  const togglePreviewPanelStable = useStableCallback(togglePreviewPanel);
  // The bottom panel holds the agents' commands. Only these user actions open
  // it; an agent starting a command never does.
  const bottomPanelAvailable =
    activeThreadCapabilities.terminal && activeProject !== null && !embedded;
  const toggleBottomPanel = () => {
    if (!activeThreadRef || !bottomPanelAvailable) return;
    const opening =
      !useBottomPanelStore.getState().byThreadKey[scopedThreadKey(activeThreadRef)]?.open;
    useBottomPanelStore.getState().toggle(activeThreadRef);
    if (opening) setTerminalFocusRequestId((value) => value + 1);
  };
  const toggleBottomPanelStable = useStableCallback(toggleBottomPanel);
  const bottomPanelRunResolverRef = useRef<BottomPanelRunResolver | null>(null);
  // A "Terminal run" row in the timeline opens the panel on the command it started.
  const showTerminalRun = (call: Parameters<BottomPanelRunResolver>[0]) => {
    if (!activeThreadRef || !bottomPanelAvailable) return;
    const match = bottomPanelRunResolverRef.current?.(call) ?? null;
    if (match)
      useBottomPanelStore.getState().showRun(activeThreadRef, match.tabId, match.terminalId);
    else useBottomPanelStore.getState().setOpen(activeThreadRef, true);
  };
  const showTerminalRunStable = useStableCallback(showTerminalRun);
  // What glides with the panel's top edge on open and close. A timeline
  // following its end moves up with the panel; otherwise only the composer
  // does. A centred draft composer moves half as far.
  const getBottomPanelMotionTargets = (): BottomPanelMotionTarget[] => {
    const composer = composerOverlayElement;
    if (isDraftHeroState) return composer ? [{ element: composer, shift: 0.5 }] : [];
    const main = workspaceLayoutElement?.querySelector<HTMLElement>("[data-chat-header-overlap]");
    if (main && isAtEndRef.current) return [{ element: main, shift: 1 }];
    return composer ? [{ element: composer, shift: 1 }] : [];
  };
  const getBottomPanelMotionTargetsStable = useStableCallback(getBottomPanelMotionTargets);
  const activateRightPanelSurface = (surface: RightPanelSurface) => {
    if (!activeThreadRef) return;
    useRightPanelStore.getState().activateSurface(activeThreadRef, surface.id);
    if (surface.kind === "preview" && surface.resourceId) {
      setActivePreviewTab(activeThreadRef, surface.resourceId);
    }
  };
  const activateRightPanelSurfaceStable = useStableCallback(activateRightPanelSurface);
  // Files opens the thread's explorer as a tab, or returns to the one already open.
  const openFilesSurface = () => {
    if (!activeThreadRef || !activeThreadCapabilities.files) return;
    const existing = selectGroupSurface(rightPanelState, "files");
    if (existing) activateRightPanelSurface(existing);
    else useRightPanelStore.getState().open(activeThreadRef, "files");
  };
  // The panel toggle restores whatever was showing; with nothing to restore it
  // opens the first surface the thread offers, so it never shows an empty panel.
  const toggleRightPanel = () => {
    if (!activeThreadRef || !rightPanelSupported) return;
    if (rightPanelOpen) {
      closePreviewPanel();
      return;
    }
    if (rightPanelState.surfaces.length === 0) {
      if (activeThreadCapabilities.browser && canOperatePreview && browserAvailable) {
        createBrowserSurface();
      } else if (activeThreadCapabilities.device) {
        addDeviceSurface();
      }
      return;
    }
    useRightPanelStore.getState().toggleVisibility(activeThreadRef);
  };
  const toggleRightPanelStable = useStableCallback(toggleRightPanel);
  // An agent's conversation shows its agent's Details sheet
  // in the header instead of thread controls.
  const agentConversationViewKey =
    activeThreadRef && activeThreadShell?.source.agent?.role === "conversation"
      ? agentViewKey({
          environmentId: activeThreadRef.environmentId,
          conversationThreadId: activeThreadRef.threadId,
        })
      : null;
  const openAgentSettingsStable = useStableCallback(() => {
    if (agentConversationViewKey) requestAgentView(agentConversationViewKey, "responsibilities");
  });
  // A thread started for a link the OS opened shows its browser maximized, like a browser window.
  useEffect(() => {
    if (!canMaximizeRightPanel) return;
    if (useRightPanelStore.getState().consumeMaximizeRequest(routeThreadRef)) {
      useRightPanelStore.getState().setMaximized(routeThreadRef, true);
    }
  }, [canMaximizeRightPanel, routeThreadRef]);
  const toggleRightPanelMaximized = () => {
    if (!canMaximizeRightPanel || !activeThreadRef) return;
    useRightPanelStore.getState().setMaximized(activeThreadRef, !rightPanelMaximized);
  };
  const toggleRightPanelMaximizedStable = useStableCallback(toggleRightPanelMaximized);
  const cleanupRightPanelSurfaces = (surfaces: readonly RightPanelSurface[]) => {
    if (!activeThreadRef) return;
    for (const surface of surfaces) {
      // Without preview access only the local surface goes away. The
      // server record is in-memory bookkeeping, not a live view, and stays
      // listed until a client with the scope closes it or the server restarts.
      if (canOperatePreview && surface.kind === "preview" && surface.resourceId) {
        void closePreviewSession({
          closePreview,
          snapshot: activePreviewState.sessions[surface.resourceId] ?? null,
          tabId: surface.resourceId,
          threadRef: activeThreadRef,
        });
      }
    }
  };
  const closeAfterAgentBrowserConfirmation = (
    surfaces: readonly RightPanelSurface[],
    closeSurfaces: () => void,
  ) => {
    const message = agentControlledBrowserCloseConfirmation(
      surfaces,
      activePreviewState.desktopByTabId,
    );
    if (!message) {
      closeSurfaces();
      return;
    }
    const localApi = readLocalApi();
    if (!localApi) return;
    void localApi.dialogs.confirm(message, { variant: "destructive" }).then(
      (confirmed) => {
        if (confirmed) closeSurfaces();
      },
      () => undefined,
    );
  };
  const syncActivePreviewSurface = () => {
    if (!activeThreadRef) return;
    const nextActiveSurface = selectActiveRightPanelSurface(
      useRightPanelStore.getState().byThreadKey,
      activeThreadRef,
    );
    if (nextActiveSurface?.kind === "preview" && nextActiveSurface.resourceId) {
      setActivePreviewTab(activeThreadRef, nextActiveSurface.resourceId);
    }
  };
  const finishRightPanelSurfaceClose = (surfaces: readonly RightPanelSurface[]) => {
    if (!activeThreadRef) return;
    const store = useRightPanelStore.getState();
    const activeId = selectThreadRightPanelState(
      store.byThreadKey,
      activeThreadRef,
    ).activeSurfaceId;
    const ordered = surfaces.toSorted(
      (left, right) => Number(left.id === activeId) - Number(right.id === activeId),
    );
    for (const surface of ordered) {
      cleanupRightPanelSurfaces([surface]);
      store.closeSurface(activeThreadRef, surface.id);
    }
    syncActivePreviewSurface();
  };
  const closeRightPanelSurface = (surface: RightPanelSurface) => {
    if (!activeThreadRef) return;
    const finishClose = () => finishRightPanelSurfaceClose([surface]);
    if (surface.kind === "preview") {
      closeAfterAgentBrowserConfirmation([surface], finishClose);
      return;
    }
    finishClose();
  };
  const closeRightPanelSurfaceStable = useStableCallback(closeRightPanelSurface);
  const closeOtherRightPanelSurfaces = (surface: RightPanelSurface) => {
    if (!activeThreadRef) return;
    const surfaces = rightPanelState.surfaces.filter((entry) => entry.id !== surface.id);
    const finishClose = () => finishRightPanelSurfaceClose(surfaces);
    closeAfterAgentBrowserConfirmation(surfaces, finishClose);
  };
  const closeOtherRightPanelSurfacesStable = useStableCallback(closeOtherRightPanelSurfaces);
  const closeRightPanelSurfacesToRight = (surface: RightPanelSurface) => {
    if (!activeThreadRef) return;
    const surfaceIndex = rightPanelState.surfaces.findIndex((entry) => entry.id === surface.id);
    if (surfaceIndex < 0) return;
    const surfaces = rightPanelState.surfaces.slice(surfaceIndex + 1);
    const finishClose = () => finishRightPanelSurfaceClose(surfaces);
    closeAfterAgentBrowserConfirmation(surfaces, finishClose);
  };
  const closeRightPanelSurfacesToRightStable = useStableCallback(closeRightPanelSurfacesToRight);
  const closeAllRightPanelSurfaces = () => {
    if (!activeThreadRef) return;
    const finishClose = () => finishRightPanelSurfaceClose(rightPanelState.surfaces);
    closeAfterAgentBrowserConfirmation(rightPanelState.surfaces, finishClose);
  };
  const closeAllRightPanelSurfacesStable = useStableCallback(closeAllRightPanelSurfaces);
  const moveRightPanelSurface = (surfaceId: string, toIndex: number) => {
    if (activeThreadRef)
      useRightPanelStore.getState().moveSurface(activeThreadRef, surfaceId, toIndex);
  };
  const moveRightPanelSurfaceStable = useStableCallback(moveRightPanelSurface);
  const copyRightPanelFilePath = (relativePath: string) => {
    void writeTextToClipboard(relativePath, "path").then(
      (didCopy) => {
        if (!didCopy) return;
        toastManager.add({
          type: "success",
          title: "Path copied",
          description: relativePath,
        });
      },
      (error) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to copy path",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      },
    );
  };
  const copyRightPanelFilePathStable = useStableCallback(copyRightPanelFilePath);
  useEffect(
    () =>
      subscribePreviewAction((action) => {
        if (action === "toggle-panel") togglePreviewPanelStable();
      }),
    [togglePreviewPanelStable],
  );
  const persistThreadSettingsForNextTurn = async (input: {
    threadId: ThreadId;
    createdAt: string;
    branch?: string;
    runtimeMode: RuntimeMode;
    interactionMode: ProviderInteractionMode;
  }): Promise<AtomCommandResult<void, unknown>> => {
    if (!serverThread) {
      return AsyncResult.success(undefined);
    }

    let result: AtomCommandResult<void, unknown> = AsyncResult.success(undefined);
    const metadataUpdate = resolveThreadMetadataUpdateForNextTurn({
      currentModelSelection: serverThread.modelSelection,
      currentBranch: serverThread.branch,
      ...(input.branch ? { nextBranch: input.branch } : {}),
    });
    if (metadataUpdate) {
      result = mapAtomCommandResult(
        await updateThreadMetadata({
          environmentId,
          input: {
            threadId: input.threadId,
            ...metadataUpdate,
          },
        }),
        () => undefined,
      );
      if (result._tag === "Failure") {
        return result;
      }
    }

    if (input.runtimeMode !== serverThread.runtimeMode) {
      result = mapAtomCommandResult(
        await setThreadRuntimeMode({
          environmentId,
          input: {
            threadId: input.threadId,
            runtimeMode: input.runtimeMode,
            createdAt: input.createdAt,
          },
        }),
        () => undefined,
      );
      if (result._tag === "Failure") {
        return result;
      }
    }

    if (input.interactionMode !== serverThread.interactionMode) {
      result = mapAtomCommandResult(
        await setThreadInteractionMode({
          environmentId,
          input: {
            threadId: input.threadId,
            interactionMode: input.interactionMode,
            createdAt: input.createdAt,
          },
        }),
        () => undefined,
      );
    }
    return result;
  };

  // Debounce *showing* the scroll-to-bottom pill so it doesn't flash during
  // thread switches. LegendList fires scroll events with isAtEnd=false while
  // initialScrollAtEnd is settling; hiding is always immediate.
  const showScrollDebouncer = useRef(
    new Debouncer(() => setShowScrollToBottom(true), { wait: 150 }),
  );
  const timelineScrollIntentRef = useRef<"toward-end" | "away-from-end" | null>(null);
  const timelineScrollModeRef = useRef<TimelineScrollMode>("following-end");
  // State mirror of the follow mode refs. LegendList's maintainScrollAtEnd
  // re-pins on its own (independent of the refs), so the timeline needs a
  // render-visible flag to switch it off once the user scrolls away.
  const [timelineLiveFollowEnabled, setTimelineLiveFollowEnabled] = useState(true);
  const cancelSendGlideRef = useRef<(() => void) | null>(null);
  // The thread whose send is gliding the timeline to its live end. While it
  // runs, the list's own instant pin to the end holds off (see MessagesTimeline).
  const [sendGlideThreadKey, setSendGlideThreadKey] = useState<string | null>(null);
  const anchorUserScrollGenerationRef = useRef(0);
  const cancelPositionRestoreRef = useRef<(() => void) | null>(null);
  // When the open thread opened; see isCarriedOverWheel.
  const timelineOpenedAtRef = useRef(0);
  const liveFollowUserScrollGenerationRef = useRef<number | null>(0);
  const cancelTimelineLiveFollowForUserNavigation = () => {
    cancelPositionRestoreRef.current?.();
    cancelSendGlideRef.current?.();
    anchorUserScrollGenerationRef.current += 1;
    const wasProgrammaticScrollMode = timelineScrollModeRef.current !== "free-scrolling";
    timelineScrollModeRef.current = "free-scrolling";
    liveFollowUserScrollGenerationRef.current = null;
    setTimelineLiveFollowEnabled(false);
    if (wasProgrammaticScrollMode) {
      // While following, our scrollToEnd/scrollToOffset calls can
      // sit in LegendList's pending-imperative-scroll queue (it defers them
      // while layout settles) and fire seconds later with stale targets,
      // yanking the view away after the user scrolled. Starting a new
      // imperative scroll cancels everything queued; targeting an item that
      // is not in the data makes the new request itself resolve without ever
      // scrolling, so this is a pure cancel.
      void legendListRef.current?.scrollToItem({
        item: TIMELINE_SCROLL_CANCEL_SENTINEL,
        animated: false,
      });
      // An already-started animated scroll (behavior: smooth) keeps running in
      // the browser regardless of the queue; a same-position instant write is
      // the only way to halt it where it is.
      const scrollNode = legendListRef.current?.getScrollableNode() as
        | { scrollTop?: number }
        | null
        | undefined;
      const currentScrollTop = scrollNode?.scrollTop;
      if (scrollNode && typeof currentScrollTop === "number") {
        scrollNode.scrollTop = currentScrollTop;
      }
    }
  };
  const cancelTimelineLiveFollowForUserNavigationStable = useStableCallback(
    cancelTimelineLiveFollowForUserNavigation,
  );
  const cancelTimelineLiveFollowForUserNavigationRef = useRef(
    cancelTimelineLiveFollowForUserNavigationStable,
  );
  useEffect(() => {
    cancelTimelineLiveFollowForUserNavigationRef.current =
      cancelTimelineLiveFollowForUserNavigationStable;
  }, [cancelTimelineLiveFollowForUserNavigationStable]);
  const timelineRealContentOverflowsViewport = (list?: LegendListRef | null) =>
    timelineContentOverflowsViewport((list ?? legendListRef.current)?.getState(), {
      composerInset: composerTimelineInset,
      anchorOffset: CHAT_TIMELINE_ANCHOR_OFFSET,
    });
  const timelineRealContentOverflowsViewportStable = useStableCallback(
    timelineRealContentOverflowsViewport,
  );
  const pageScrollControllerRef = useRef<ReturnType<typeof createPageScrollController> | null>(
    null,
  );
  const handlePageScrollStart = useEffectEvent((key: PageScrollKey) => {
    timelineScrollIntentRef.current = key === "PageUp" ? "away-from-end" : "toward-end";
    if (
      (key === "PageUp" && timelineRealContentOverflowsViewportStable()) ||
      !isTimelineAtLogicalEndStable()
    ) {
      cancelTimelineLiveFollowForUserNavigationStable();
    }
  });
  useEffect(() => {
    const controller = createPageScrollController({
      getContainer: () => legendListRef.current?.getScrollableNode() ?? null,
      getScrollPaddingBottomPx: () => composerOverlayElement?.getBoundingClientRect().height ?? 0,
      onScrollStart: handlePageScrollStart,
    });
    pageScrollControllerRef.current = controller;

    return () => {
      controller.dispose();
      if (pageScrollControllerRef.current === controller) {
        pageScrollControllerRef.current = null;
      }
    };
  }, [composerOverlayElement]);
  const onComposerPageScrollKeyDown = (key: PageScrollKey) => {
    pageScrollControllerRef.current?.handleKeyDown(key);
  };
  const onComposerPageScrollKeyDownStable = useStableCallback(onComposerPageScrollKeyDown);
  const onComposerPageScrollKeyUp = (key: string) => {
    pageScrollControllerRef.current?.handleKeyUp(key);
  };
  const onComposerPageScrollKeyUpStable = useStableCallback(onComposerPageScrollKeyUp);
  const onComposerPageScrollRelease = () => {
    pageScrollControllerRef.current?.releaseActiveKey();
  };
  const onComposerPageScrollReleaseStable = useStableCallback(onComposerPageScrollRelease);
  // Live-follow stays active after send/thread-open until an actual list scroll
  // gesture opts out.
  const followLiveEnd = () => {
    cancelPositionRestoreRef.current?.();
    cancelSendGlideRef.current?.();
    isAtEndRef.current = true;
    timelineScrollModeRef.current = "following-end";
    liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current;
    setTimelineLiveFollowEnabled(true);
    showScrollDebouncer.current.cancel();
    setShowScrollToBottom(false);
  };
  const scrollToEnd = (animated: boolean = false) => {
    followLiveEnd();
    // Rows set alongside this call commit first, so the scroll measures them.
    requestAnimationFrame(() => {
      void legendListRef.current?.scrollToEnd?.({ animated });
    });
  };
  /**
   * A send brings the timeline to its live end in one glide, in step with the
   * sent bubble's rise into place above the composer, from wherever the user
   * was reading. The end is read every frame, so the sent row and its activity
   * rows measuring in extend the same glide instead of adding a second scroll.
   * LegendList's instant pin to the end holds off until the glide lands, then
   * keeps the end pinned while the reply streams. Instant under reduced motion.
   */
  const glideToEndForSend = (threadKey: string, messageId: MessageId) => {
    followLiveEnd();
    const scrollNode = legendListRef.current?.getScrollableNode() as HTMLElement | undefined;
    if (!scrollNode) return;
    // The lowest row on screen before the send carries the motion over, found
    // again by id each frame because the list recycles its row elements.
    const referenceId = latestTimelineRowId(scrollNode);
    let stopAnimation: (() => void) | null = null;
    const stop = () => stopAnimation?.();
    cancelSendGlideRef.current = stop;
    setSendGlideThreadKey(threadKey);
    stopAnimation = glideToLiveEnd(scrollNode, {
      content: scrollNode.querySelector<HTMLElement>(":scope > .legend-list-content-container"),
      reference: () =>
        referenceId === null
          ? null
          : scrollNode.querySelector(`[data-timeline-row-id="${CSS.escape(referenceId)}"]`),
      ready: () =>
        scrollNode.querySelector(
          `[data-message-role="user"][data-message-id="${CSS.escape(messageId)}"]`,
        ) !== null,
      onDone: () => {
        if (cancelSendGlideRef.current !== stop) return;
        cancelSendGlideRef.current = null;
        setSendGlideThreadKey(null);
      },
    });
  };
  const scrollToEndStable = useStableCallback(scrollToEnd);
  useEffect(() => {
    let removeListeners: (() => void) | null = null;
    let frame: number | null = null;
    const attach = (remainingAttempts: number) => {
      frame = requestAnimationFrame(() => {
        frame = null;
        const scrollNode = legendListRef.current?.getScrollableNode();
        if (!scrollNode) {
          // The list may not have mounted on the first frame after a thread
          // switch — without a retry the opt-out listeners never attach and
          // live-follow becomes impossible to escape for the whole thread.
          if (remainingAttempts > 0) {
            attach(remainingAttempts - 1);
          }
          return;
        }
        const handleManualNavigation = () => {
          cancelTimelineLiveFollowForUserNavigationRef.current();
        };
        // The gestures below must only break follow when they can actually
        // move the viewport away from the live edge (#5566): a spurious break
        // while pinned at the end produces no scroll event, never re-arms,
        // and streaming silently stops following. Underflowing content can't
        // scroll at all, so nothing there should break follow.
        const contentScrollsUp = () => timelineRealContentOverflowsViewportStable();
        // The follow re-arm band, not the strict flag: streaming growth makes
        // isAtEnd flicker false for a frame before the follow scroll catches
        // up, and a gesture landing in that window while still pinned would
        // otherwise break follow with no scroll event left to re-arm it.
        const viewportIsAwayFromEnd = () =>
          resolveTimelineIsAtEnd(legendListRef.current?.getState()) === false;
        // Only an upward wheel is a navigation intent; wheeling down while
        // following either does nothing (at the end) or moves toward it.
        const handleWheel = (event: WheelEvent) => {
          if (event.ctrlKey || !isTimelineScrollTarget(event.target, scrollNode, event.deltaY))
            return;
          if (event.deltaY > 0) {
            timelineScrollIntentRef.current = "toward-end";
          } else if (event.deltaY < 0) {
            timelineScrollIntentRef.current = "away-from-end";
          }
          // Momentum carried over from the previous thread is not a scroll of this one.
          if (isCarriedOverWheel(readWheelGesture(), timelineOpenedAtRef.current)) return;
          if (event.deltaY < 0 && contentScrollsUp()) {
            handleManualNavigation();
          }
        };
        // Touch direction isn't observable here (touchmove fires on any
        // finger motion, scrolling or not), so break only once the drag has
        // actually carried the viewport out of the end band — an upward flick
        // gets there within its first few events and later touchmoves break.
        const handleTouchMove = () => {
          if (viewportIsAwayFromEnd()) {
            handleManualNavigation();
          }
        };
        // Scrollbar drags produce no wheel/touch events; they are the only
        // pointerdowns whose target is the scroll node itself rather than a
        // message row. Content clicks break follow only away from the end
        // (reading or selecting up there must hold position); clicking near
        // the live edge keeps following.
        const handlePointerDown = (event: PointerEvent) => {
          if (event.target === scrollNode) {
            if (contentScrollsUp()) {
              handleManualNavigation();
            }
            return;
          }
          // A click while the opening thread is still scrolling to its place
          // (cancelPositionRestoreRef is set) is not leaving the end.
          if (cancelPositionRestoreRef.current === null && viewportIsAwayFromEnd()) {
            handleManualNavigation();
          }
        };
        // Keyboard scrolling (PageUp/Home/ArrowUp) bypasses wheel and
        // pointer events entirely; without this the timeline yanks back to
        // the end on the next stream chunk. Clicking message text can leave
        // DOM focus on body, so these keys must also be heard at document.
        const handleKeyDown = (event: KeyboardEvent) => {
          if (
            !(event.target instanceof Node) ||
            (!scrollNode.contains(event.target) &&
              event.target !== document.body &&
              event.target !== document.documentElement) ||
            event.defaultPrevented ||
            event.isComposing ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey ||
            eventPathContainsSelector(event, TYPE_TO_FOCUS_EDITABLE_SELECTOR) ||
            document.querySelector(TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR)
          ) {
            return;
          }
          if (!["PageUp", "Home", "ArrowUp", "PageDown", "End", "ArrowDown"].includes(event.key))
            return;
          const scrollDirection = ["PageUp", "Home", "ArrowUp"].includes(event.key) ? -1 : 1;
          if (
            scrollNode.contains(event.target) &&
            !isTimelineScrollTarget(event.target, scrollNode, scrollDirection)
          )
            return;
          switch (event.key) {
            case "PageUp":
            case "Home":
            case "ArrowUp":
              timelineScrollIntentRef.current = "away-from-end";
              if (contentScrollsUp()) {
                handleManualNavigation();
              }
              break;
            case "PageDown":
            case "End":
            case "ArrowDown":
              timelineScrollIntentRef.current = "toward-end";
              if (viewportIsAwayFromEnd()) {
                handleManualNavigation();
              }
              break;
            default:
              break;
          }
        };
        scrollNode.addEventListener("wheel", handleWheel, {
          passive: true,
        });
        scrollNode.addEventListener("touchmove", handleTouchMove, {
          passive: true,
        });
        scrollNode.addEventListener("pointerdown", handlePointerDown, {
          passive: true,
        });
        document.addEventListener("keydown", handleKeyDown);
        removeListeners = () => {
          scrollNode.removeEventListener("wheel", handleWheel);
          scrollNode.removeEventListener("touchmove", handleTouchMove);
          scrollNode.removeEventListener("pointerdown", handlePointerDown);
          document.removeEventListener("keydown", handleKeyDown);
        };
      });
    };
    attach(12);

    return () => {
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
      removeListeners?.();
    };
  }, [activeThread?.id, isTimelineAtLogicalEndStable, timelineRealContentOverflowsViewportStable]);

  const onIsAtEndChange = (isAtEnd: boolean) => {
    // Still following (a send's glide, or growth the pin has yet to catch):
    // not at the end only for a moment, so no pill.
    if (
      !isAtEnd &&
      liveFollowUserScrollGenerationRef.current === anchorUserScrollGenerationRef.current
    ) {
      showScrollDebouncer.current.cancel();
      setShowScrollToBottom(false);
      return;
    }
    if (isAtEndRef.current === isAtEnd) return;
    isAtEndRef.current = isAtEnd;
    if (isAtEnd) {
      timelineScrollModeRef.current = "following-end";
      liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current;
      // Reachable only once follow has broken: the user scrolled back to the
      // live edge and expects the stream to stick to it again, exactly like
      // the scroll-to-bottom pill.
      setTimelineLiveFollowEnabled(true);
      showScrollDebouncer.current.cancel();
      setShowScrollToBottom(false);
    } else {
      timelineScrollModeRef.current = "free-scrolling";
      liveFollowUserScrollGenerationRef.current = null;
      showScrollDebouncer.current.maybeExecute();
    }
  };
  const onIsAtEndChangeStable = useStableCallback(onIsAtEndChange);

  useEffect(() => {
    timelineOpenedAtRef.current = performance.now();
    const followEnd = readTimelinePosition(routeThreadKey)?.atEnd !== false;
    isAtEndRef.current = followEnd;
    timelineScrollIntentRef.current = null;
    timelineScrollModeRef.current = followEnd ? "following-end" : "free-scrolling";
    liveFollowUserScrollGenerationRef.current = followEnd
      ? anchorUserScrollGenerationRef.current
      : null;
    setTimelineLiveFollowEnabled(followEnd);
    cancelSendGlideRef.current?.();
    showScrollDebouncer.current.cancel();
    setShowScrollToBottom(!followEnd);
    // Environment identity is part of the scroll session too.
  }, [activeThreadKey]);

  useEffect(() => {
    if (!activeThread?.id) return;
    const frame = window.requestAnimationFrame(() => {
      focusComposerStable();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeThread?.id, focusComposerStable]);

  // Tabbing back into the app lands focus wherever it last was, often the right panel or the
  // body. Put it in the composer unless something that takes typing already holds it. A right
  // panel terminal is a surface and is recognized by the predicate. Mobile is left alone so
  // returning to the app does not raise the keyboard.
  useEffect(() => {
    if (!activeThread?.id || isMobileViewport) return;
    let frame: number | null = null;
    const onWindowFocus = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      // The element that held focus receives it again after the window's own event, and the
      // composer ignores that same frame so a restored focus does not lift a scroll-collapsed
      // composer. Wait one more frame so this focus counts as a request to expand it.
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(() => {
          frame = null;
          // A full-screen app owns the page; refocusing the composer would close it.
          if (document.querySelector("[data-mcp-app-fullscreen]") !== null) return;
          if (shouldRefocusComposerOnWindowFocus(document.activeElement)) focusComposerStable();
        });
      });
    };
    window.addEventListener("focus", onWindowFocus);
    return () => {
      window.removeEventListener("focus", onWindowFocus);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [activeThread?.id, focusComposerStable, isMobileViewport]);

  useEffect(() => {
    if (!activeThread?.id) return;
    if (activeMessageCount === 0) {
      return;
    }
    const removedMessages = optimisticUserMessages.filter((message) =>
      serverAcknowledgedUserMessageIds.has(message.id),
    );
    if (removedMessages.length === 0) {
      return;
    }
    const timer = window.setTimeout(() => {
      setOptimisticUserMessages((existing) =>
        existing.filter((message) => !serverAcknowledgedUserMessageIds.has(message.id)),
      );
    }, 0);
    for (const removedMessage of removedMessages) {
      const previewUrls = collectUserMessageBlobPreviewUrls(removedMessage);
      if (previewUrls.length > 0) {
        handoffAttachmentPreviewsStable(removedMessage.id, previewUrls);
        continue;
      }
      revokeUserMessagePreviewUrls(removedMessage);
    }
    return () => {
      window.clearTimeout(timer);
    };
  }, [
    activeMessageCount,
    activeThread?.id,
    serverAcknowledgedUserMessageIds,
    handoffAttachmentPreviewsStable,
    optimisticUserMessages,
  ]);

  // Keyed on the thread, not the draft: a draft's promotion to its server
  // route keeps this instance and drops `draftId`, and the send it is still
  // dispatching must survive that swap. Effects also re-run when a hidden view
  // is revealed (a mode switch); only a new thread resets.
  const resetForThreadIdRef = useRef<ThreadId | null>(null);
  useEffect(() => {
    if (resetForThreadIdRef.current === threadId) return;
    const firstThread = resetForThreadIdRef.current === null;
    resetForThreadIdRef.current = threadId;
    if (firstThread) return;
    setOptimisticUserMessages((existing) => {
      for (const message of existing) {
        revokeUserMessagePreviewUrls(message);
      }
      return [];
    });
    resetLocalDispatch();
    setExpandedImage(null);
  }, [resetLocalDispatch, threadId]);

  const closeExpandedImage = () => {
    setExpandedImage(null);
  };
  const closeExpandedImageStable = useStableCallback(closeExpandedImage);

  const activeWorktreePath = activeThread?.worktreePath ?? null;
  const derivedEnvMode: DraftThreadEnvMode = resolveEffectiveEnvMode({
    activeWorktreePath,
    hasServerThread: isServerThread,
    draftThreadEnvMode: isLocalDraftThread ? draftThread?.envMode : undefined,
    preparingWorktree: isPreparingWorktree,
  });
  const canOverrideServerThreadEnvMode = Boolean(
    isServerThread &&
    activeThread &&
    activeMessageCount === 0 &&
    activeThread.worktreePath === null &&
    !envLocked,
  );
  const envMode: DraftThreadEnvMode = canOverrideServerThreadEnvMode
    ? (pendingServerThreadEnvMode ?? draftThread?.envMode ?? derivedEnvMode)
    : derivedEnvMode;
  const activeThreadBranch =
    canOverrideServerThreadEnvMode && pendingServerThreadBranch !== undefined
      ? pendingServerThreadBranch
      : (activeThread?.branch ?? null);
  const startFromOrigin = isLocalDraftThread
    ? (draftThread?.startFromOrigin ?? false)
    : canOverrideServerThreadEnvMode
      ? (pendingServerThreadStartFromOriginByThreadId[activeThread?.id ?? ""] ??
        activeProjectSettings.settings.newWorktreesStartFromOrigin)
      : false;
  const sendEnvMode = resolveSendEnvMode({
    requestedEnvMode: envMode,
    isGitRepo,
  });
  const localCheckoutBranchMismatch = useMemo(
    () =>
      isServerThread
        ? resolveLocalCheckoutBranchMismatch({
            effectiveEnvMode: envMode,
            activeWorktreePath,
            activeThreadBranch,
            currentGitBranch: gitStatusQuery.data?.refName ?? null,
          })
        : null,
    [activeThreadBranch, activeWorktreePath, envMode, gitStatusQuery.data?.refName, isServerThread],
  );
  const publishComposerOverlayHeight = (height: number) => {
    const nextHeight = Math.ceil(height);
    if (nextHeight <= 0) return;
    const nextInset = nextHeight;
    // A subagent thread's bar stands in for the composer and has no main
    // surface; its host is the edge then, or the stale cover from the last
    // composer would clip the timeline above the bar.
    const mainSurface =
      composerOverlayElement?.querySelector<HTMLElement>(
        '[data-chat-composer-main-surface="true"]',
      ) ?? composerOverlayElement?.querySelector<HTMLElement>('[data-slot="composer-host"]');
    if (composerTimelineInsetRef.current !== nextInset) {
      // The panels stacked above the composer grew or shrank while the
      // timeline sat at its end: keep the end in view above them. The list
      // still holds the old inset here, so "at end" is read before the change.
      // Only the stack counts; the composer's own growth keeps rows still.
      const stackHeight =
        composerOverlayElement && mainSurface
          ? Math.round(
              mainSurface.getBoundingClientRect().top -
                composerOverlayElement.getBoundingClientRect().top,
            )
          : null;
      const lastStackHeight = composerStackHeightRef.current;
      composerStackHeightRef.current = stackHeight;
      if (
        stackHeight !== null &&
        lastStackHeight !== null &&
        stackHeight !== lastStackHeight &&
        composerTimelineInsetRef.current > 0 &&
        cancelSendGlideRef.current === null &&
        isTimelineAtLogicalEnd()
      ) {
        pinTimelineEndAfterInsetRef.current = true;
      }
      composerTimelineInsetRef.current = nextInset;
      setComposerTimelineInset(nextInset);
    }
    // The backdrop starts at the composer's top edge and runs to the window
    // edge, so the timeline never shows below or beside the composer. The
    // timeline's bottom edge fade ends at that same edge (--chat-composer-cover)
    // instead of hiding behind the backdrop.
    if (composerOverlayElement && mainSurface) {
      const overlayRect = composerOverlayElement.getBoundingClientRect();
      const backdropTop = Math.max(0, mainSurface.getBoundingClientRect().top - overlayRect.top);
      composerOverlayElement.style.setProperty(
        "--chat-composer-backdrop-top",
        `${Math.round(backdropTop)}px`,
      );
      const hasBackdrop =
        composerOverlayElement.querySelector('[data-chat-composer-backdrop="true"]') !== null;
      composerOverlayElement.parentElement?.style.setProperty(
        "--chat-composer-cover",
        `${hasBackdrop ? Math.max(0, Math.round(overlayRect.height - backdropTop)) : 0}px`,
      );
    }
    const button = composerOverlayElement?.parentElement?.querySelector<HTMLElement>(
      'button[aria-label="Scroll to end"]',
    );
    const clearance =
      composerOverlayElement && mainSurface && button
        ? resolveScrollToEndClearance({
            overlayHeight: nextHeight,
            mainSurfaceTop: mainSurface.getBoundingClientRect().top,
            button: button.getBoundingClientRect(),
            attachments: Array.from(
              composerOverlayElement.querySelectorAll<HTMLElement>(
                '[data-composer-banner-surface="attached"]',
              ),
              (element) => element.getBoundingClientRect(),
            ),
          })
        : nextHeight;
    setScrollToEndClearance(clearance);
  };
  const publishComposerOverlayHeightStable = useStableCallback(publishComposerOverlayHeight);
  // The footer already holds the new inset here. The list may size its content
  // a frame later, so the end is pinned again then; both are plain scroll
  // writes, so a stack that eases open is followed frame by frame.
  useLayoutEffect(() => {
    if (!pinTimelineEndAfterInsetRef.current) return;
    pinTimelineEndAfterInsetRef.current = false;
    const scrollNode = legendListRef.current?.getScrollableNode() as HTMLElement | undefined;
    if (!scrollNode) return;
    const pin = () => {
      scrollNode.scrollTop = scrollNode.scrollHeight - scrollNode.clientHeight;
    };
    pin();
    const frame = requestAnimationFrame(pin);
    return () => cancelAnimationFrame(frame);
  }, [composerTimelineInset]);
  // A held reservation belongs to the previous thread's draft. Rebuild it from
  // this thread's overlay so a tall draft elsewhere does not pad this one.
  useLayoutEffect(() => {
    if (!composerOverlayElement) return;
    composerTimelineInsetRef.current = 0;
    publishComposerOverlayHeightStable(composerOverlayElement.getBoundingClientRect().height);
  }, [activeThreadKey, composerOverlayElement, publishComposerOverlayHeightStable]);

  useLayoutEffect(() => {
    if (!composerOverlayElement) return;

    const updateHeight = () => {
      publishComposerOverlayHeightStable(composerOverlayElement.getBoundingClientRect().height);
    };

    updateHeight();
    return observeResize(composerOverlayElement, updateHeight);
  }, [composerOverlayElement, publishComposerOverlayHeightStable, showScrollToBottom]);
  const activeThreadReferenceCopyTarget = useMemo(
    () =>
      activeThreadId === null || !isServerThread
        ? null
        : resolveThreadReferenceCopyTarget({
            threadId: activeThreadId,
          }),
    [activeThreadId, isServerThread, activeThread?.pullRequests],
  );
  const copyActiveThreadReference = () => {
    const target = activeThreadReferenceCopyTarget;
    if (target === null) return;
    void writeTextToClipboard(target.value, target.clipboardTarget).then(
      (didCopy) => {
        if (!didCopy) return;
        toastManager.add({
          type: "success",
          title: target.successTitle,
          description: target.value,
        });
      },
      (error) => {
        console.error(error);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: target.failureTitle,
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      },
    );
  };
  const copyActiveThreadReferenceStable = useStableCallback(copyActiveThreadReference);

  const supportsSettlement = serverConfig?.environment.capabilities.threadSettlement === true;
  const supportsSnooze = serverConfig?.environment.capabilities.threadSnooze === true;
  const activeThreadSnoozed =
    activeThreadShell !== null &&
    supportsSnooze &&
    effectiveSnoozed(activeThreadShell, { now: new Date().toISOString() });
  const [snoozeWakeTick, bumpSnoozeWakeTick] = useState(0);
  useEffect(() => {
    void snoozeWakeTick;
    if (!activeThreadSnoozed) return;
    const wakeAtMs = Date.parse(activeThreadShell?.snoozedUntil ?? "");
    if (!Number.isFinite(wakeAtMs)) return;
    const id = window.setTimeout(
      () => bumpSnoozeWakeTick((tick) => tick + 1),
      Math.min(Math.max(0, wakeAtMs - Date.now()) + 50, 2_147_483_647),
    );
    return () => window.clearTimeout(id);
  }, [activeThreadShell?.snoozedUntil, activeThreadSnoozed, snoozeWakeTick]);
  const activeThreadWokeAt =
    activeThreadShell !== null && supportsSnooze
      ? threadWokeAt(activeThreadShell, { now: new Date().toISOString() })
      : null;
  const acknowledgeThreadWoke = useAcknowledgeThreadWoke();
  const acknowledgeActiveThreadWoke = () => {
    if (activeThreadRef === null || activeThreadWokeAt === null) return;
    acknowledgeThreadWoke(activeThreadRef, activeThreadWokeAt);
  };
  const acknowledgeActiveThreadWokeStable = useStableCallback(acknowledgeActiveThreadWoke);
  // Mirror of the sidebar's Woke pill for the open thread. Same watermark as
  // the sidebar, so an acknowledgement from any device hides it.
  const activeThreadLocalVisitedAt = useUiStateStore((store) =>
    activeThreadKey === null ? undefined : store.threadLastVisitedAtById[activeThreadKey],
  );
  const activeThreadLastVisitedAt = resolveThreadLastVisitedAt(
    activeThreadShell?.lastVisitedAt,
    activeThreadLocalVisitedAt,
  );
  const activeThreadWokeVisible = resolveThreadWokeVisible({
    wokeAt: activeThreadWokeAt,
    settledOverride: activeThreadShell?.settledOverride,
    lastVisitedAt: activeThreadLastVisitedAt,
    completedAt: activeLatestRun?.completedAt,
  });
  const activeThreadSettled =
    supportsSettlement && activeThreadShell?.settledOverride === "settled";
  // mod+shift+p: pins or unpins the open chat, the same as the sidebar menu.
  // False when the open thread can't be pinned, so the key stays unclaimed.
  const canPinActiveThreadStable = useStableCallback(
    () =>
      activeThreadCapabilities.pin &&
      serverConfig?.environment.capabilities.threadPinning === true &&
      readEnvironmentScope(environmentId, AuthOrchestrationOperateScope),
  );
  const toggleActiveThreadPinStable = useStableCallback(() => {
    if (!isServerThread || !activeThreadRef || !activeThreadShell) return;
    const pinned = activeThreadShell.pinnedAt != null;
    void (pinned ? unpinThread(activeThreadRef) : pinThread(activeThreadRef)).then((result) => {
      if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: pinned ? "Failed to unpin thread" : "Failed to pin thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    });
  });
  const unsettleThreadMutation = useOrchestrationCommand(threadEnvironment.unsettle, {
    reportFailure: false,
  });
  // Keyed by thread, not a boolean: the pending state must follow the thread
  // it belongs to across navigation, and a request resolving for thread A
  // must never clear (or re-enable) thread B's button.
  const [unsettlingThreadKey, setUnsettlingThreadKey] = useState<string | null>(null);
  const isUnsettling = unsettlingThreadKey !== null && unsettlingThreadKey === activeThreadKey;
  const handleUnsettleActiveThread = async () => {
    if (
      !activeThreadRef ||
      !readEnvironmentScope(activeThreadRef.environmentId, AuthOrchestrationOperateScope)
    )
      return;
    const threadKey = scopedThreadKey(activeThreadRef);
    setUnsettlingThreadKey(threadKey);
    await runFinally(
      async () => {
        const result = await unsettleThreadMutation({
          environmentId: activeThreadRef.environmentId,
          input: { threadId: activeThreadRef.threadId, reason: "user" },
        });
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to un-settle thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      },
      () => {
        setUnsettlingThreadKey((current) => (current === threadKey ? null : current));
      },
    );
  };
  const handleUnsettleActiveThreadStable = useStableCallback(handleUnsettleActiveThread);
  const unsnoozeThreadMutation = useOrchestrationCommand(threadEnvironment.unsnooze, {
    reportFailure: false,
  });
  const [unsnoozingThreadKey, setUnsnoozingThreadKey] = useState<string | null>(null);
  const isUnsnoozing = unsnoozingThreadKey !== null && unsnoozingThreadKey === activeThreadKey;
  const handleUnsnoozeActiveThread = async () => {
    if (
      !activeThreadRef ||
      !readEnvironmentScope(activeThreadRef.environmentId, AuthOrchestrationOperateScope)
    )
      return;
    const threadKey = scopedThreadKey(activeThreadRef);
    setUnsnoozingThreadKey(threadKey);
    await runFinally(
      async () => {
        const recovery = activeThreadShell?.limitRecovery;
        const recoveryOwnsSnooze =
          recovery?.snooze === true &&
          recovery.runId === activeThreadShell?.latestRun?.runId &&
          activeThreadShell?.snoozedUntil != null &&
          Date.parse(activeThreadShell.snoozedUntil) === Date.parse(recovery.resetAt);
        const result = recoveryOwnsSnooze
          ? await updateThreadMetadata({
              environmentId: activeThreadRef.environmentId,
              input: {
                threadId: activeThreadRef.threadId,
                limitRecovery: { runId: recovery.runId, resetAt: recovery.resetAt, snooze: false },
              },
            })
          : await unsnoozeThreadMutation({
              environmentId: activeThreadRef.environmentId,
              input: { threadId: activeThreadRef.threadId, reason: "user" },
            });
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to wake thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      },
      () => {
        setUnsnoozingThreadKey((current) => (current === threadKey ? null : current));
      },
    );
  };
  const handleUnsnoozeActiveThreadStable = useStableCallback(handleUnsnoozeActiveThread);
  const [isRestoringThreadBranch, setIsRestoringThreadBranch] = useState(false);
  const [branchRestoreConfirmOpen, setBranchRestoreConfirmOpen] = useState(false);
  // Once revealed for a given mismatch, the banner stays mounted until the
  // mismatch changes or resolves, so clearing the draft doesn't flicker it.
  const [revealedBranchMismatchKey, setRevealedBranchMismatchKey] = useState<string | null>(null);
  // Dismissal lives in a module-level set (survives remounts); this tick just
  // forces a re-render so the banner leaves immediately.
  const [, setBranchMismatchDismissTick] = useState(0);
  const composerHasDraftContent = useComposerDraftStore((store) =>
    composerDraftHasUserContent(store.getComposerDraft(composerDraftTarget)),
  );
  const nowMinute = useNowMinute();
  const activeBranchMismatchKey = branchMismatchKey(
    activeThread?.id ?? null,
    localCheckoutBranchMismatch,
  );
  const showBranchMismatchBanner = shouldShowBranchMismatchBanner({
    hasMismatch: localCheckoutBranchMismatch !== null,
    isDismissed: isBranchMismatchDismissedForSession(activeBranchMismatchKey),
    composerHasContent: composerHasDraftContent,
    wasShownForCurrentMismatch:
      revealedBranchMismatchKey !== null && revealedBranchMismatchKey === activeBranchMismatchKey,
  });
  useEffect(() => {
    setRevealedBranchMismatchKey((revealed) => {
      if (showBranchMismatchBanner) {
        return activeBranchMismatchKey;
      }
      // Hysteresis is scoped to an uninterrupted mismatch: reset when the
      // mismatch resolves or changes so a recurrence re-gates on intent.
      return revealed !== null && revealed !== activeBranchMismatchKey ? null : revealed;
    });
  }, [activeBranchMismatchKey, showBranchMismatchBanner]);
  const handleSwitchCheckoutToThread = async () => {
    if (!canWriteSourceControl) return;
    if (
      !activeProjectCwd ||
      !activeThread ||
      !localCheckoutBranchMismatch ||
      isRestoringThreadBranch
    ) {
      return;
    }
    setIsRestoringThreadBranch(true);
    const checkoutResult = await switchGitRef({
      environmentId,
      input: {
        cwd: activeProjectCwd,
        refName: localCheckoutBranchMismatch.threadBranch,
      },
    });
    if (checkoutResult._tag === "Failure") {
      setIsRestoringThreadBranch(false);
      if (!isAtomCommandInterrupted(checkoutResult)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to switch checkout",
            description: chatActionErrorMessage(squashAtomCommandFailure(checkoutResult)),
          }),
        );
      }
      return;
    }

    if (!readEnvironmentScope(environmentId, AuthSourceControlWriteScope)) {
      setIsRestoringThreadBranch(false);
      return;
    }
    const nextBranch = checkoutResult.value.refName ?? localCheckoutBranchMismatch.threadBranch;
    if (nextBranch !== activeThread.branch) {
      const updateResult = await updateThreadMetadata({
        environmentId,
        input: { threadId: activeThread.id, branch: nextBranch, worktreePath: null },
      });
      if (updateResult._tag === "Failure") {
        setIsRestoringThreadBranch(false);
        if (!isAtomCommandInterrupted(updateResult)) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Checkout switched, but the thread could not be updated",
              description: chatActionErrorMessage(squashAtomCommandFailure(updateResult)),
            }),
          );
        }
        gitStatusQuery.refresh();
        return;
      }
    }
    gitStatusQuery.refresh();
    setIsRestoringThreadBranch(false);
    scheduleComposerFocus();
  };
  // The stack renders items[0] front-most and tucks the rest behind hover, so
  // ordering is priority: system banners, then the branch-mismatch notice,
  // and the informational parked-thread banner last — it must never cover another.
  // Background work (subagent fleets, workflow runs, watch loops, dev servers) can outlive
  // the turn; once it settles, the composer stop button is gone, so this
  // banner is the only visible stop affordance. The interrupt path also
  // accepts a completed run while its provider still has background work.
  const activeBackgroundTasks = !isWorking && activeThread ? pendingBackgroundTasks : [];
  const [stoppingBackgroundWorkKey, setStoppingBackgroundWorkKey] = useState<string | null>(null);
  const isStoppingBackgroundWork =
    stoppingBackgroundWorkKey === `${environmentId}:${activeThreadId}`;
  const handleStopBackgroundWork = async () => {
    if (!activeThread || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope))
      return;
    const requestKey = `${environmentId}:${activeThread.id}`;
    setStoppingBackgroundWorkKey(requestKey);
    const result = await interruptThreadTurn({
      environmentId,
      input: { threadId: activeThread.id },
    });
    // Acceptance does not confirm termination. Allow retry while the provider
    // finishes stopping the tasks or reports a failure.
    setStoppingBackgroundWorkKey((current) => (current === requestKey ? null : current));
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setThreadError(
          activeThread.id,
          error instanceof Error ? error.message : "Failed to stop background work.",
        );
      }
    }
  };
  const handleStopBackgroundWorkStable = useStableCallback(handleStopBackgroundWork);
  const onOpenRelatedThread = (threadId: ThreadId) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
    });
  };
  const onOpenRelatedThreadStable = useStableCallback(onOpenRelatedThread);
  const childThreadInputs = useChildThreadInputs(activeThreadRef);
  const threadApprovalBannerItems = useThreadApprovalBannerItems(
    environmentId,
    activeThreadShell?.id ?? null,
  );
  const childInputBannerItem = useMemo<ComposerBannerStackItem | null>(() => {
    const first = childThreadInputs[0];
    const parentAwaitingUser =
      activePendingApproval || activePendingUserInput || activeThreadShell?.hasPendingUserInput;
    if (!first || parentAwaitingUser) return null;
    return {
      id: `child-input:${first.id}`,
      variant: "info",
      priority: "activity",
      icon: first.hasPendingApprovals ? <ShieldQuestionIcon /> : <MessageCircleIcon />,
      title: childThreadInputsTitle(childThreadInputs),
      description: childThreadInputs.map((child, index) => (
        <Fragment key={child.id}>
          {index > 0 ? " " : null}
          <span className="whitespace-nowrap">
            <InlineButton tone="muted" onClick={() => onOpenRelatedThreadStable(child.id)}>
              {child.title}
            </InlineButton>
            {index < childThreadInputs.length - 1 ? "," : null}
          </span>
        </Fragment>
      )),
      actions: (
        <Button size="xs" variant="ghost" onClick={() => onOpenRelatedThreadStable(first.id)}>
          {first.hasPendingApprovals ? "Open approval" : "Open question"}
        </Button>
      ),
    };
  }, [
    childThreadInputs,
    activePendingApproval,
    activePendingUserInput,
    activeThreadShell?.hasPendingUserInput,
    onOpenRelatedThreadStable,
  ]);
  // A provider-native subagent names the model its parent picked and how its
  // work went, and leads back to that parent.
  const parentThreadLinkId = parentThreadLink?.threadId ?? null;
  const subagentBannerItem = useMemo<ComposerBannerStackItem | null>(() => {
    if (!isProviderSubagent) return null;
    return {
      id: "provider-subagent",
      variant: "info",
      ...(providerSubagentStatus !== null &&
      isOrchestrationV2WorkActive(providerSubagentStatus.status)
        ? { priority: "activity" as const }
        : {}),
      icon: selectedProviderEntry ? (
        <ProviderInstanceIcon
          driverKind={selectedProviderEntry.driverKind}
          displayName={selectedProviderEntry.displayName}
          accentColor={selectedProviderEntry.accentColor}
          showBadge={shouldShowInstanceBadge(selectedProviderEntry, providerInstanceEntries)}
          className="size-3"
          iconClassName="size-3"
        />
      ) : null,
      title: (
        <SubagentBannerTitle
          modelLabel={providerSubagentModelLabel}
          effortLabel={providerSubagentEffortLabel}
          status={providerSubagentStatus}
        />
      ),
      ...(parentThreadLinkId === null
        ? {}
        : {
            actions: (
              <Button
                size="xs"
                variant="ghost"
                onClick={() => onOpenRelatedThreadStable(parentThreadLinkId)}
              >
                <ArrowUpLeftIcon />
                Open parent
              </Button>
            ),
          }),
    };
  }, [
    isProviderSubagent,
    onOpenRelatedThreadStable,
    parentThreadLinkId,
    providerInstanceEntries,
    providerSubagentEffortLabel,
    providerSubagentModelLabel,
    providerSubagentStatus,
    selectedProviderEntry,
  ]);

  // Commands such as /compact and /goal clear run as their own turn. The draft
  // and its attachments stay local.
  const sendStandaloneCommand = async (text: string, failureMessage: string) => {
    if (!activeThread || !clientSettingsHydrated || sendInFlightRef.current) return;
    const context = composerRef.current?.getSendContext();
    if (!context?.providerAvailable) return;

    const threadId = activeThread.id;
    const messageId = newMessageId();
    const createdAt = new Date().toISOString();
    sendInFlightRef.current = true;
    beginLocalDispatch();
    setThreadError(threadId, null);
    setOptimisticUserMessages((messages) => [
      ...messages,
      {
        id: messageId,
        role: "user",
        text,
        runId: null,
        createdAt,
        updatedAt: createdAt,
        streaming: false,
      },
    ]);
    scrollToEnd();
    await runFinally(
      async () => {
        const settingsResult = await persistThreadSettingsForNextTurn({
          threadId,
          createdAt,
          ...(localCheckoutBranchMismatch
            ? { branch: localCheckoutBranchMismatch.currentBranch }
            : {}),
          runtimeMode,
          interactionMode: context.interactionMode,
        });
        const result =
          settingsResult._tag === "Failure"
            ? settingsResult
            : await startThreadTurn({
                environmentId,
                input: {
                  threadId,
                  message: { messageId, role: "user", text, attachments: [] },
                  modelSelection: context.selectedModelSelection,
                  runtimeMode,
                  interactionMode: context.interactionMode,
                  createdAt,
                },
              });
        if (result._tag === "Failure") {
          setOptimisticUserMessages((messages) =>
            messages.filter((message) => message.id !== messageId),
          );
          resetLocalDispatch();
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            setThreadError(threadId, error instanceof Error ? error.message : failureMessage);
          }
        } else {
          clearUsageLimitsFor(routeThreadKey);
        }
      },
      () => {
        sendInFlightRef.current = false;
      },
    );
  };
  const sendStandaloneCommandStable = useStableCallback(sendStandaloneCommand);
  // A native /goal keeps the agent working across turns. Stop pauses a Codex
  // goal; once the thread is idle the row offers the native follow-ups.
  const activeGoal = activeThreadShell?.goal ?? null;
  const goalBannerItem = useMemo<ComposerBannerStackItem | null>(() => {
    if (!activeThread || activeGoal === null) return null;
    const presentation = presentProviderGoal(activeGoal, isWorking);
    return {
      id: `goal:${activeThread.id}`,
      variant: "default",
      priority: "activity",
      icon: <TargetIcon />,
      // Usage stays in the title so a long objective cannot clip it.
      title:
        presentation.usage === null
          ? presentation.title
          : `${presentation.title} · ${presentation.usage}`,
      description: presentation.objective,
      actions: isWorking ? undefined : (
        <>
          {presentation.canResume ? (
            <Button
              size="xs"
              variant="ghost"
              onClick={() =>
                void sendStandaloneCommandStable("/goal resume", "Failed to resume goal.")
              }
            >
              Resume
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="ghost"
            onClick={() => void sendStandaloneCommandStable("/goal clear", "Failed to clear goal.")}
          >
            Clear
          </Button>
        </>
      ),
    };
  }, [activeGoal, activeThread, isWorking, sendStandaloneCommandStable]);

  const backgroundWorkBannerItem = useMemo<ComposerBannerStackContent | null>(() => {
    const presentation = presentPendingBackgroundWork(activeBackgroundTasks);
    if (presentation === null || !activeThread) {
      return null;
    }
    return {
      id: `background-work:${activeThread.id}`,
      variant: "default",
      priority: "activity",
      content: (
        <BackgroundWorkBanner
          environmentId={activeThread.environmentId}
          threadId={activeThread.id}
          presentation={presentation}
          canStop={canOperateThread}
          stopping={isStoppingBackgroundWork}
          onStop={() => void handleStopBackgroundWorkStable()}
          onOpenThread={onOpenRelatedThreadStable}
        />
      ),
    };
  }, [
    activeBackgroundTasks,
    activeThread,
    canOperateThread,
    handleStopBackgroundWorkStable,
    isStoppingBackgroundWork,
    onOpenRelatedThreadStable,
  ]);
  // Settled, snoozed, and woke are thread state, not composer actions: each
  // gets one quiet line after the last message instead of a banner. A woken
  // thread announces itself here, not just in the sidebar pill. Dismissing
  // marks the wake as seen (same acknowledgment as the pill); sending a
  // message clears it as a side effect of the send path.
  // Memoized: it is the timeline's list footer, and a new element re-renders that footer.
  // nowMinute keeps the relative time fresh.
  const activeThreadSnoozedUntil = activeThreadShell?.snoozedUntil;
  const activeThreadSettledAt = activeThreadShell?.settledAt;
  const threadStatusLine = useMemo(() => {
    void nowMinute;
    return activeThreadSnoozed ? (
      <ThreadStatusLine
        icon={<AlarmClockIcon />}
        label={
          activeThreadSnoozedUntil
            ? `Snoozed, ${formatRelativeTimeUntilLabel(activeThreadSnoozedUntil)}`
            : "Snoozed"
        }
        actionLabel={isUnsnoozing ? "Waking..." : "Wake now"}
        actionDisabled={!canOperateThread || isUnsnoozing}
        onAction={() => void handleUnsnoozeActiveThreadStable()}
      />
    ) : activeThreadSettled ? (
      <ThreadStatusLine
        icon={<CheckCircle2Icon />}
        label={
          activeThreadSettledAt
            ? `Settled ${formatRelativeTimeLabel(activeThreadSettledAt)}`
            : "Settled"
        }
        actionLabel={isUnsettling ? "Un-settling..." : "Un-settle"}
        actionDisabled={!canOperateThread || isUnsettling}
        onAction={() => void handleUnsettleActiveThreadStable()}
      />
    ) : activeThreadWokeVisible ? (
      <ThreadStatusLine
        icon={<AlarmClockIcon />}
        label="Woke from snooze"
        actionLabel="Dismiss"
        onAction={acknowledgeActiveThreadWokeStable}
      />
    ) : null;
  }, [
    acknowledgeActiveThreadWokeStable,
    activeThreadSettled,
    activeThreadSettledAt,
    activeThreadSnoozedUntil,
    activeThreadSnoozed,
    activeThreadWokeVisible,
    canOperateThread,
    handleUnsettleActiveThreadStable,
    handleUnsnoozeActiveThreadStable,
    isUnsettling,
    isUnsnoozing,
    nowMinute,
  ]);
  // Work this chat started: a marker after the message each was started from.
  // Links with no such message fall to the footer, ahead of the thread's state line.
  // Tasks the chat's agent handed off show as cards; their Work skips the plain marker.
  const activeThreadWorkHandoffs = activeThreadShell?.source.workHandoffs;
  const activeThreadWorkTasks = activeThreadShell?.source.workTasks;
  const workHandoffAnchors = useMemo(() => {
    const links = handoffsWithoutTasks(activeThreadWorkHandoffs ?? [], activeThreadWorkTasks ?? []);
    return links.length ? anchorWorkHandoffs(links, timelineMessages) : null;
  }, [activeThreadWorkHandoffs, activeThreadWorkTasks, timelineMessages]);
  const activeThreadIdForTasks = activeThreadShell?.id ?? null;
  const workTaskAnchors = useMemo(
    () =>
      activeThreadWorkTasks?.length && activeThreadIdForTasks !== null
        ? {
            chatThreadId: activeThreadIdForTasks,
            anchors: anchorWorkTasks(activeThreadWorkTasks, timelineMessages),
          }
        : null,
    [activeThreadIdForTasks, activeThreadWorkTasks, timelineMessages],
  );
  const threadFooterLines = useMemo(
    () =>
      workHandoffAnchors?.unanchored.length || workTaskAnchors?.anchors.unanchored.length ? (
        <>
          <UnanchoredWorkHandoffMarkers />
          {threadStatusLine}
        </>
      ) : (
        threadStatusLine
      ),
    [threadStatusLine, workHandoffAnchors, workTaskAnchors],
  );
  // The header breadcrumb's way back (see ThreadHeaderTitle), and the
  // target of the thread.openParent shortcut.
  const activeThreadOrigin = activeThreadShell
    ? resolveThreadOrigin(activeThreadShell.source)
    : null;
  const workHandoffMessagesCarried =
    activeThreadOrigin?.kind === "chat"
      ? (serverProjection?.contextHandoffs.find(
          (handoff) => handoff.sourceThreadId === activeThreadOrigin.threadId,
        )?.messagesCarried ?? null)
      : null;
  const activeThreadOriginId = activeThreadOrigin?.threadId ?? null;
  const activeThreadHasCompactableConversation = serverVisibleTurnItems.some(
    ({ item }) =>
      item.type === "user_message" &&
      (item.text.trim().toLowerCase() !== "/compact" || item.attachments.length > 0),
  );
  const pendingHandoff = useMemo(
    () => resolvePendingHandoff(serverProjection, composerSendModelSelection, providerStatuses),
    [serverProjection, composerSendModelSelection, providerStatuses],
  );
  const compactThreadUnavailable =
    !canOperateThread ||
    !activeThread ||
    !activeThreadHasCompactableConversation ||
    !activeProject ||
    !isServerThread ||
    !manualCompactionProviderAvailable ||
    isWorking ||
    isRevertingCheckpoint ||
    threadDetailLoading ||
    isPreparingWorktree ||
    activeEnvironmentUnavailable ||
    feedbackUploading ||
    pendingApprovals.length > 0 ||
    pendingUserInputs.length > 0 ||
    showPlanFollowUpPrompt;
  const compactDisabled = compactThreadUnavailable;
  const compactDisabledReason = compactDisabled
    ? !canOperateThread
      ? "This connection cannot change threads."
      : !activeProject
        ? "Choose a repository before compacting"
        : !manualCompactionProviderAvailable
          ? "Compaction is unavailable for this provider"
          : "Compacting is unavailable right now"
    : null;
  // Tokens a stale Claude session would re-read on its next turn. While set,
  // the composer shows a Compact chip and Enter compacts first; turning the
  // chip off sends the next message with full history. Held queues and
  // multi-model sends never compact first, so the offer hides for them.
  const resumeCompactionTokens =
    activeContextWindow &&
    !resumeCompactionPermanentlyDismissed &&
    !nativeResumeCompactionDismissed &&
    !compactDisabled &&
    !hasHeldQueuedRuns &&
    multipleModelSelections === null &&
    shouldOfferResumeCompaction({
      provider: selectedProvider,
      usedTokens: activeContextWindow.usedTokens,
      updatedAt: activeContextWindow.updatedAt,
      // Only the live report carries a TTL, and only when it is the window's source.
      promptCacheTtlMs: activeThreadLiveTokenUsage?.promptCacheTtlMs,
      now: `${nowMinute}:00.000Z`,
    })
      ? activeContextWindow.usedTokens
      : null;
  // Threads whose Compact chip is turned off. A send that starts its turn
  // clears its thread's entry; a failed send keeps it for the retry.
  const [fullHistoryThreadKeys, setFullHistoryThreadKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const keepFullHistory = fullHistoryThreadKeys.has(routeThreadKey);
  const setKeepFullHistory = (threadKey: string, keep: boolean) => {
    setFullHistoryThreadKeys((current) => {
      if (current.has(threadKey) === keep) return current;
      const next = new Set(current);
      if (keep) next.add(threadKey);
      else next.delete(threadKey);
      return next;
    });
  };
  const toggleKeepFullHistory = () => setKeepFullHistory(routeThreadKey, !keepFullHistory);
  const toggleKeepFullHistoryStable = useStableCallback(toggleKeepFullHistory);
  const handleRestoreThreadBranch = () => {
    if (!canWriteSourceControl) return;
    if (gitStatusQuery.data?.hasWorkingTreeChanges) {
      setBranchRestoreConfirmOpen(true);
      return;
    }
    void handleSwitchCheckoutToThread();
  };
  const handleRestoreThreadBranchStable = useStableCallback(handleRestoreThreadBranch);
  const feedbackBannerItems = useMemo(
    () =>
      feedbackSubmissions.flatMap((submission) => {
        const item = feedbackBannerItem(submission, () => {
          setFeedbackSubmissionsByThreadKey((current) => ({
            ...current,
            [routeThreadKey]: (current[routeThreadKey] ?? []).filter(
              (entry) => entry.id !== submission.id,
            ),
          }));
        });
        return item ? [item] : [];
      }),
    [feedbackSubmissions, routeThreadKey],
  );
  // onResume is declared below and published here after commit; the banner only calls it from a click.
  const onResumeNowRef = useRef<(() => Promise<void>) | null>(null);
  const onResumeNowStable = useStableCallback(() => void onResumeNowRef.current?.());
  const stoppedOnUsageLimit =
    serverRuntime?.status === "failed" && serverRuntime.lastErrorClass === "usage_limit";
  const usageLimitHandoff = useUsageLimitHandoff({
    environmentId,
    threadId: activeThreadShell?.id ?? null,
    runId: stoppedOnUsageLimit ? (activeThreadShell?.latestRun?.runId ?? null) : null,
    onAccepted: (modelSelection) => {
      // The continuation moved the thread; the composer follows, or its own
      // pick would send the next turn back to the limited instance.
      if (activeThreadShell) {
        setComposerDraftModelSelection(
          scopeThreadRef(environmentId, activeThreadShell.id),
          modelSelection,
          { explicit: true, replaceOptions: true },
        );
      }
      clearUsageLimitsFor(routeThreadKey);
      scrollToEnd();
    },
  });
  const limitRecoveryBanner =
    serverRuntime?.status === "failed" &&
    serverRuntime.lastErrorClass === "usage_limit" &&
    activeThreadShell?.latestRun
      ? usageLimitRecoveryBannerItem({
          handoff: usageLimitHandoff,
          stop: {
            runId: activeThreadShell.latestRun.runId,
            resetAt: serverRuntime.usageLimitResetAt ?? null,
            stoppedAt: activeThreadShell.latestRun.completedAt ?? activeThreadShell.updatedAt,
            recovery: activeThreadShell.limitRecovery ?? null,
            snoozedUntil: activeThreadShell.snoozedUntil,
          },
          autoResumeByDefault: settings.autoResumeLimitedThreads,
          nowMs: Date.parse(`${nowMinute}:00.000Z`),
          timestampFormat,
          onResumeNow: resumableRunId === null ? null : onResumeNowStable,
          onChange: async (limitRecovery) => {
            const result = await updateThreadMetadata({
              environmentId,
              input: { threadId: activeThreadShell.id, limitRecovery },
            });
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          },
        })
      : null;
  const composerBannerItems = useMemo<
    Array<ComposerBannerStackItem | ComposerBannerStackContent>
  >(() => {
    const limitRecoveryItems = limitRecoveryBanner === null ? [] : [limitRecoveryBanner];
    const backgroundWorkItems = [
      subagentBannerItem,
      childInputBannerItem,
      goalBannerItem,
      backgroundWorkBannerItem,
    ].filter((item) => item !== null);
    // The user asked for this one, so it leads the notice tier instead of trailing it.
    const usageLimitsItems = usageLimitsBanner === null ? [] : [usageLimitsBanner];
    const projectCloneItems = projectCloneBannerItem === null ? [] : [projectCloneBannerItem];
    if (!localCheckoutBranchMismatch || !showBranchMismatchBanner || !activeBranchMismatchKey) {
      return [
        ...threadApprovalBannerItems,
        ...feedbackBannerItems,
        ...limitRecoveryItems,
        ...usageLimitsItems,
        ...projectCloneItems,
        ...systemComposerBannerItems,
        ...backgroundWorkItems,
      ];
    }
    return [
      ...threadApprovalBannerItems,
      ...feedbackBannerItems,
      ...limitRecoveryItems,
      ...usageLimitsItems,
      ...projectCloneItems,
      ...systemComposerBannerItems,
      ...backgroundWorkItems,
      {
        id: `branch-mismatch:${activeBranchMismatchKey}`,
        variant: "info",
        compact: true,
        icon: <GitBranchIcon />,
        title: (
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="shrink-0 font-normal text-muted-foreground">Branch changed — was</span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <code className="min-w-0 truncate font-medium text-foreground">
                    {localCheckoutBranchMismatch.threadBranch}
                  </code>
                }
              />
              <TooltipPopup side="top">
                This thread last ran on {localCheckoutBranchMismatch.threadBranch}. Sending will
                continue on {localCheckoutBranchMismatch.currentBranch}.
              </TooltipPopup>
            </Tooltip>
          </span>
        ),
        actions: (
          <Button
            size="xs"
            variant="ghost"
            disabled={!canWriteSourceControl || isRestoringThreadBranch}
            onClick={handleRestoreThreadBranchStable}
          >
            {isRestoringThreadBranch ? "Restoring..." : "Restore branch"}
          </Button>
        ),
        dismissLabel: "Dismiss branch change notice",
        onDismiss: () => {
          dismissBranchMismatchForSession(activeBranchMismatchKey);
          setBranchMismatchDismissTick((tick) => tick + 1);
        },
      },
    ];
  }, [
    activeBranchMismatchKey,
    activeThreadShell,
    serverRuntime?.usageLimitResetAt,
    canWriteSourceControl,
    feedbackBannerItems,
    limitRecoveryBanner,
    handleRestoreThreadBranchStable,
    isRestoringThreadBranch,
    backgroundWorkBannerItem,
    childInputBannerItem,
    subagentBannerItem,
    goalBannerItem,
    localCheckoutBranchMismatch,
    projectCloneBannerItem,
    showBranchMismatchBanner,
    systemComposerBannerItems,
    threadApprovalBannerItems,
    usageLimitsBanner,
  ]);

  useEffect(() => {
    setPendingServerThreadEnvMode(null);
    setPendingServerThreadBranch(undefined);
  }, [activeThread?.id]);

  useEffect(() => {
    if (canOverrideServerThreadEnvMode) {
      return;
    }
    setPendingServerThreadEnvMode(null);
    setPendingServerThreadBranch(undefined);
  }, [canOverrideServerThreadEnvMode]);

  const getShortcutContext = (eventTarget: EventTarget | null = document.activeElement) => ({
    terminalFocus: getTerminalFocusOwner() !== null,
    terminalOpen: bottomPanelOpen,
    previewFocus: isPreviewFocused(),
    previewOpen: previewPanelOpen,
    editableFocus: isEditableFocused(eventTarget),
    modelPickerOpen: composerRef.current?.isModelPickerOpen() ?? false,
    composerFocus: document.activeElement?.getAttribute("data-testid") === "composer-editor",
    draftThreadRoute: routeKind === "draft",
    turnRunning: phase === "running",
    isWeb: !isElectron,
    isDesktop: isElectron,
  });
  const getShortcutContextStable = useStableCallback(getShortcutContext);
  const timelineSkills = activeProviderStatus
    ? resolveProviderSkillsForCwd(activeProviderStatus, gitCwd)
    : EMPTY_PROVIDER_SKILLS;
  const threadFindControlsRef = useRef<ThreadFindControls | null>(null);
  const [isThreadFindActive, setIsThreadFindActive] = useState(false);
  const openThreadFind = () => threadFindControlsRef.current?.open();
  const openThreadFindStable = useStableCallback(openThreadFind);
  const closeThreadFind = () => threadFindControlsRef.current?.close();
  const closeThreadFindStable = useStableCallback(closeThreadFind);

  // A long-open thread keeps every live row and loaded page in memory. Once the
  // reader has rested at the live end of an idle thread, shed older rows back
  // to the server's recent window; "Load earlier" and find page them back in.
  const historyTrimRequestRef = useRef<{ key: string; rowCount: number } | null>(null);
  const historyTrimRowCount = serverVisibleTurnItems?.length ?? 0;
  const historyTrimAtEnd = timelineLiveFollowEnabled && !showScrollToBottom;
  const historyTrimBusy = isWorking || isThreadFindActive || serverThreadHistory.loading;
  const historyTrimEnvironmentId = routeThreadDetailRef?.environmentId ?? null;
  const historyTrimThreadId = routeThreadDetailRef?.threadId ?? null;
  useEffect(() => {
    if (historyTrimEnvironmentId === null || historyTrimThreadId === null) return;
    const key = `${historyTrimEnvironmentId}:${historyTrimThreadId}`;
    const lastRequest = historyTrimRequestRef.current;
    const wanted = shouldRequestThreadHistoryTrim({
      rowCount: historyTrimRowCount,
      lastRequestRowCount: lastRequest?.key === key ? lastRequest.rowCount : null,
      atEnd: historyTrimAtEnd,
      busy: historyTrimBusy,
    });
    if (!wanted) return;
    const timer = window.setTimeout(() => {
      historyTrimRequestRef.current = { key, rowCount: historyTrimRowCount };
      void trimThreadHistory({
        environmentId: historyTrimEnvironmentId,
        input: { threadId: historyTrimThreadId },
      });
    }, THREAD_HISTORY_TRIM_IDLE_MS);
    return () => window.clearTimeout(timer);
  }, [
    historyTrimAtEnd,
    historyTrimBusy,
    historyTrimEnvironmentId,
    historyTrimRowCount,
    historyTrimThreadId,
    trimThreadHistory,
  ]);

  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      // Let contextual controls claim Escape before the bubbling find handler.
      if (isThreadFindActive && event.key === "Escape") return;
      if (!activeThreadId || isCommandPaletteOpen()) {
        return;
      }
      const terminalFocusOwner = getTerminalFocusOwner();
      if (event.defaultPrevented && terminalFocusOwner === null) {
        return;
      }
      const shortcutContext = getShortcutContextStable(event.target);

      if (
        !shortcutContext.terminalFocus &&
        !shortcutContext.modelPickerOpen &&
        shouldTypeToFocusComposer(event)
      ) {
        if (composerRef.current?.insertTextAtEnd(event.key)) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }

      const command = resolveChatShortcutCommand(event, keybindings, scriptKeybindings, {
        context: shortcutContext,
      });
      if (!command) return;

      if (command === "thread.copyReference") {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) copyActiveThreadReferenceStable();
        return;
      }

      if (command === "thread.settle") {
        if (!activeThreadCapabilities.settle) return;
        if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
        event.preventDefault();
        event.stopPropagation();
        if (!isServerThread || !activeThreadRef || !supportsSettlement) return;
        if (activeThreadSettled) {
          void handleUnsettleActiveThreadStable();
          return;
        }
        // Same as the sidebar Settle button: settle, then open the next thread.
        if (settleAndAdvance(activeThreadRef)) return;

        void settleThread(activeThreadRef).then((result) => {
          if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to settle thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        });
        return;
      }

      if (command === "thread.snooze") {
        if (!activeThreadCapabilities.snooze || !isServerThread || !activeThreadRef) return;
        if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) openCommandPalette({ open: "snooze", threadRef: activeThreadRef });
        return;
      }

      if (command === "thread.openParent") {
        if (activeThreadOriginId === null) return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) onOpenRelatedThreadStable(activeThreadOriginId);
        return;
      }

      if (command === "thread.pin") {
        if (!canPinActiveThreadStable()) return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) toggleActiveThreadPinStable();
        return;
      }

      if (command === "thread.startWork") {
        // Only a chat hands off to Work; agent conversations start Work through the agent.
        if (!activeThreadCapabilities.startWork) return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat && isServerThread && activeThreadRef) {
          openCommandPalette({ open: "start-work", threadRef: activeThreadRef });
        }
        return;
      }

      // Drafts and servers without thread search leave Mod+F to the browser.
      if (command === "chat.find" && isServerThread && serverConfig?.threadFind === true) {
        event.preventDefault();
        event.stopPropagation();
        openThreadFindStable();
        return;
      }

      if (command === "rightPanel.toggle") {
        if (!rightPanelSupported) return;
        event.preventDefault();
        event.stopPropagation();
        toggleRightPanelStable();
        return;
      }

      if (command === "terminal.toggle") {
        if (!bottomPanelAvailable) return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) toggleBottomPanelStable();
        return;
      }

      if (command === "rightPanel.toggleMaximized") {
        if (!rightPanelSupported) return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) toggleRightPanelMaximizedStable();
        return;
      }

      if (command === "threadPanel.toggle") {
        event.preventDefault();
        event.stopPropagation();
        // The thread details panel is gone; only an agent's conversation answers.
        if (activeThreadCapabilities.agentSettings) openAgentSettingsStable();
        return;
      }

      if (command === "rightPanel.close") {
        // Nothing open: leave the event alone so the shortcut keeps its
        // native meaning (close window on desktop, close tab in a browser).
        if (!activeRightPanelSurface) return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) closeRightPanelSurfaceStable(activeRightPanelSurface);
        return;
      }

      if (command === "modelPicker.toggle") {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) composerRef.current?.toggleModelPicker();
        return;
      }

      if (
        command === "composer.host" ||
        command === "composer.effort" ||
        command === "composer.mode" ||
        command === "composer.workspace"
      ) {
        if (command === "composer.workspace" && !activeThreadCapabilities.git) return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) composerRef.current?.openControl(command);
        return;
      }

      if (command === "composer.cycleHost") {
        if (envLocked || !draftId || !canPickRunOn) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        // Step from where a pending switch is heading, so repeated presses keep advancing.
        const currentId =
          environmentChangeRef.current?.environmentId ?? runOnEnvironmentId ?? environmentId;
        const index = runOnOptions.findIndex((env) => env.environmentId === currentId);
        const next = runOnOptions[(index + 1) % runOnOptions.length];
        if (next) onEnvironmentChangeStable(next.environmentId);
        return;
      }

      if (command === "composer.branch") {
        if (!activeThreadCapabilities.git) return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) branchToolbarRef.current?.openBranchPicker();
        return;
      }

      if (command === "composer.previousWorktree") {
        if (!activeThreadCapabilities.git) return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) branchToolbarRef.current?.usePreviousWorktree();
        return;
      }

      if (command === "thread.steerQueuedMessage") {
        if (routeKind === "draft") return;
        if (!queuedRunsControlRef.current?.steerNext(event.repeat)) return;
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (command === "thread.sendAllQueuedMessages") {
        if (routeKind === "draft") return;
        if (!queuedRunsControlRef.current?.sendAll(event.repeat)) return;
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (command === "thread.editQueuedMessage") {
        if (routeKind === "draft") return;
        // Anywhere else in the draft the key keeps moving the caret, so a
        // second press from the first paragraph reaches the queue.
        if (!composerRef.current?.isCaretAtStart()) return;
        if (!queuedRunsControlRef.current?.editLatest(event.repeat)) return;
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (command === "thread.stop") {
        // An unavailable command should not shadow contextual shortcuts such as Escape to close a dialog.
        if (!canInterruptRunningThread) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        void onInterruptStable();
        return;
      }
    };
    const dismissFind = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        !isThreadFindActive ||
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        isCommandPaletteOpen()
      )
        return;
      const context = getShortcutContextStable(event.target);
      if (context.terminalFocus || context.previewFocus || context.modelPickerOpen) return;
      event.preventDefault();
      closeThreadFindStable();
      focusComposerStable();
    };
    window.addEventListener("keydown", handler, true);
    window.addEventListener("keydown", dismissFind);
    return () => {
      window.removeEventListener("keydown", handler, true);
      window.removeEventListener("keydown", dismissFind);
    };
  }, [
    activeRightPanelSurface,
    activeThreadRef,
    activeThreadSettled,
    canInterruptRunningThread,
    activeThreadId,
    closeRightPanelSurfaceStable,
    keybindings,
    scriptKeybindings,
    handleUnsettleActiveThreadStable,
    isServerThread,
    serverConfig?.threadFind,
    onInterruptStable,
    settleThread,
    supportsSettlement,
    copyActiveThreadReferenceStable,
    activeThreadOriginId,
    onOpenRelatedThreadStable,
    canPinActiveThreadStable,
    toggleActiveThreadPinStable,
    getShortcutContextStable,
    openThreadFindStable,
    closeThreadFindStable,
    isThreadFindActive,
    toggleRightPanelStable,
    toggleRightPanelMaximizedStable,
    rightPanelSupported,
    toggleBottomPanelStable,
    bottomPanelAvailable,
    composerRef,
    draftId,
    environmentId,
    envLocked,
    canPickRunOn,
    runOnEnvironmentId,
    runOnOptions,
    onEnvironmentChangeStable,
  ]);

  // A focused desktop browser page forwards these chords as menu actions.
  useEffect(() => {
    return window.desktopBridge?.onMenuAction((action) => {
      if (action === "rightPanel.toggle") toggleRightPanelStable();
      else if (action === "rightPanel.toggleMaximized") toggleRightPanelMaximizedStable();
    });
  }, [toggleRightPanelStable, toggleRightPanelMaximizedStable]);

  // Paste-to-focus: the resting composer blurs on a click into the timeline,
  // so a paste that follows has no editable target and would be dropped.
  // Route it to the composer like a typed key, which also expands it.
  useEffect(() => {
    const keyHandler = (event: KeyboardEvent) => {
      if (
        shouldRedirectInputToComposer(event) &&
        isPasteAsTextShortcut(event, isMacPlatform(navigator.platform))
      ) {
        pasteAsTextShortcutUntilRef.current = Date.now() + 1_000;
      }
    };
    const handler = (event: ClipboardEvent) => {
      if (!activeThreadId || isCommandPaletteOpen()) return;
      if (getTerminalFocusOwner() !== null) return;
      if (composerRef.current?.isModelPickerOpen()) return;
      const text = pasteTextToFocusComposer(event);
      const clipboardData = event.clipboardData;
      if (text === null || clipboardData === null) return;
      const bypassAutoAttachment = Date.now() <= pasteAsTextShortcutUntilRef.current;
      pasteAsTextShortcutUntilRef.current = 0;
      if (
        ((readPastedComposerContext(clipboardData)?.records.length ?? 0) === 0 &&
          composerRef.current?.pasteTextAtEnd(text, { bypassAutoAttachment })) ||
        composerRef.current?.insertTextAtEnd(text, { clipboardData })
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("keydown", keyHandler, true);
    window.addEventListener("paste", handler, true);
    return () => {
      window.removeEventListener("keydown", keyHandler, true);
      window.removeEventListener("paste", handler, true);
    };
  }, [activeThreadId, composerRef]);

  const [pendingRevert, setPendingRevert] = useState<{
    turnCount: number;
    messageId: MessageId;
    routeThreadKey: string;
  } | null>(null);

  if (pendingRevert && pendingRevert.routeThreadKey !== routeThreadKey) {
    setPendingRevert(null);
  }

  const onRevertToTurnCount = async (
    turnCount: number,
    messageId: MessageId,
    restoreFiles?: boolean,
  ) => {
    const localApi = readLocalApi();
    if (
      !localApi ||
      !activeThread ||
      isRevertingCheckpoint ||
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
    )
      return;
    const sourceMessage = serverProjection?.messages.find((message) => message.id === messageId);
    const message = sourceMessage
      ? {
          id: sourceMessage.id,
          role: sourceMessage.role,
          text: sourceMessage.text,
          attachments: sourceMessage.attachments,
          context: sourceMessage.context,
          runId: sourceMessage.runId,
          streaming: false,
          createdAt: DateTime.formatIso(sourceMessage.createdAt),
          updatedAt: DateTime.formatIso(sourceMessage.updatedAt),
        }
      : undefined;
    if (!message || message.role !== "user") return;

    if (!supportsConversationRollback) {
      setThreadError(
        activeThread.id,
        "This provider does not support reverting conversation history. Start a new thread instead.",
      );
      return;
    }
    if (activeEnvironmentUnavailable && activeEnvironmentUnavailableLabel) {
      setThreadError(
        activeThread.id,
        `Reconnect ${activeEnvironmentUnavailableLabel} before reverting checkpoints.`,
      );
      return;
    }
    if (phase === "running" || isSendBusy || isConnecting) {
      setThreadError(activeThread.id, "Interrupt the current turn before reverting checkpoints.");
      return;
    }
    if (restoreFiles === undefined) {
      setPendingRevert({ turnCount, messageId, routeThreadKey });
      return;
    }

    useComposerDraftStore.setState((store) => ({
      rewindingThreadKeys: new Set(store.rewindingThreadKeys).add(routeThreadKey),
    }));
    setThreadError(activeThread.id, null);
    await runCatching(
      async () => {
        if (composerRef.current?.hasPendingAttachments()) {
          throw new Error("Wait for attachments to finish preparing before rewinding.");
        }
        const connection = readPreparedConnection(environmentId);
        if (!connection) throw new Error("The environment is not connected.");
        const files = await prepareRevertedMessageAttachments({
          message,
          environmentId,
          httpBaseUrl: connection.httpBaseUrl,
          createAssetUrl: createAttachmentAssetUrl,
        });
        const store = useComposerDraftStore.getState();
        const draft = store.getComposerDraft(composerDraftTarget);
        if (
          (draft?.images.length ?? 0) + (draft?.files.length ?? 0) + files.length >
          PROVIDER_SEND_TURN_MAX_ATTACHMENTS
        ) {
          throw new Error(
            "Make room for this message's attachments in the composer before rewinding.",
          );
        }
        const commandId = CommandId.make(randomUUID());
        await waitForRevertedMessage(routeThreadRef, messageId, turnCount, commandId, async () => {
          const result = await revertThreadCheckpoint({
            environmentId,
            input: { commandId, threadId: activeThread.id, turnCount, restoreFiles },
          });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        });
        const currentPrompt = store.getComposerDraft(composerDraftTarget)?.prompt ?? "";
        const restoredPrompt = recallableComposerPrompt(message.text);
        const nextPrompt =
          restoredPrompt.length === 0
            ? currentPrompt
            : currentPrompt.length > 0
              ? `${currentPrompt}\n\n${restoredPrompt}`
              : restoredPrompt;
        store.setPrompt(composerDraftTarget, nextPrompt);
        const images: ComposerImageAttachment[] = [];
        const restoredFiles: ComposerFileAttachment[] = [];
        files.forEach((file, index) => {
          const attachment = {
            id: randomUUID(),
            name: file.name,
            mimeType: file.type,
            sizeBytes: file.size,
            file,
          };
          if (message.attachments?.[index]?.type === "image") {
            images.push({ ...attachment, type: "image", previewUrl: URL.createObjectURL(file) });
          } else {
            restoredFiles.push({ ...attachment, type: "file" });
          }
        });
        store.addImages(composerDraftTarget, images, { allowDuplicates: true });
        store.addFiles(composerDraftTarget, restoredFiles, { allowDuplicates: true });
        if (currentRouteThreadKeyRef.current === routeThreadKey) {
          promptRef.current = nextPrompt;
          composerRef.current?.resetCursorState({ prompt: nextPrompt, cursor: nextPrompt.length });
          requestAnimationFrame(() => {
            if (currentRouteThreadKeyRef.current === routeThreadKey)
              composerRef.current?.focusAtEnd();
          });
        }
      },
      (error) => {
        setThreadError(
          activeThread.id,
          error instanceof Error ? error.message : "Failed to revert thread state.",
        );
      },
      () => {
        useComposerDraftStore.setState((store) => {
          const remaining = new Set(store.rewindingThreadKeys);
          remaining.delete(routeThreadKey);
          return { rewindingThreadKeys: remaining };
        });
      },
    );
  };
  const onRevertToTurnCountStable = useStableCallback(onRevertToTurnCount);

  const onRollbackCheckpoint = async (input: {
    readonly checkpointId: string;
    readonly scopeId: string;
  }) => {
    if (!activeThread || isRevertingCheckpoint) return;
    if (activeEnvironmentUnavailable && activeEnvironmentUnavailableLabel) {
      setThreadError(
        activeThread.id,
        `Reconnect ${activeEnvironmentUnavailableLabel} before reverting checkpoints.`,
      );
      return;
    }
    if (phase === "running" || isSendBusy || isConnecting) {
      setThreadError(activeThread.id, "Interrupt the current turn before reverting checkpoints.");
      return;
    }
    const localApi = readLocalApi();
    const confirmed =
      localApi == null
        ? window.confirm("Roll back this thread to the selected checkpoint?")
        : await localApi.dialogs.confirm(
            "Roll back this thread to the selected checkpoint?\nThis action cannot be undone.",
          );
    if (!confirmed) return;

    useComposerDraftStore.setState((store) => ({
      rewindingThreadKeys: new Set(store.rewindingThreadKeys).add(routeThreadKey),
    }));
    setThreadError(activeThread.id, null);
    const result = await revertThreadCheckpoint({
      environmentId,
      input: {
        threadId: activeThread.id,
        checkpointId: input.checkpointId,
        scopeId: input.scopeId,
      },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setThreadError(
        activeThread.id,
        error instanceof Error ? error.message : "Failed to revert thread state.",
      );
    }
    useComposerDraftStore.setState((store) => {
      const remaining = new Set(store.rewindingThreadKeys);
      remaining.delete(routeThreadKey);
      return { rewindingThreadKeys: remaining };
    });
  };

  const onForkFromRun = async (input: {
    readonly sourceThreadId: ThreadId;
    readonly runId: RunId;
  }) => {
    if (!activeThread || activeEnvironmentUnavailable) return;
    const targetThreadId = newThreadId();
    const targetThreadRef = scopeThreadRef(environmentId, targetThreadId);
    const result = await forkThreadFromRun({
      environmentId,
      input: {
        sourceThreadId: input.sourceThreadId,
        targetThreadId,
        runId: input.runId,
        title: `${activeThread.title} fork`,
      },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setThreadError(
          activeThread.id,
          error instanceof Error ? error.message : "Failed to fork this response.",
        );
      }
      return;
    }
    const targetThreadReady = await waitForThreadShell(targetThreadRef);
    if (!targetThreadReady) {
      setThreadError(
        activeThread.id,
        "The fork was created, but its thread data did not reach this client. Reconnect and try opening it from the sidebar.",
      );
      return;
    }
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(targetThreadRef),
    });
  };
  const onForkFromRunStable = useStableCallback(onForkFromRun);
  const onCompactContext = () => {
    if (compactDisabled) return;
    void sendStandaloneCommand("/compact", "Failed to compact context.");
  };

  const onResume = async () => {
    if (
      !activeThread ||
      (resumableRunId === null && !hasHeldQueuedRuns) ||
      isSendBusy ||
      isResuming ||
      isConnecting ||
      isRevertingCheckpoint ||
      threadDetailLoading ||
      activeEnvironmentUnavailable ||
      sendInFlightRef.current
    ) {
      return;
    }
    const threadId = activeThread.id;
    sendInFlightRef.current = true;
    setResumingThreadKeys((current) => new Set(current).add(routeThreadKey));
    setThreadError(threadId, null);
    await runFinally(
      async () => {
        const resume = async () => {
          if (resumableRunId === null) {
            return resumeThreadQueue({ environmentId, input: { threadId } });
          }
          const createdAt = new Date().toISOString();
          const settingsResult = await persistThreadSettingsForNextTurn({
            threadId,
            createdAt,
            ...(localCheckoutBranchMismatch
              ? { branch: localCheckoutBranchMismatch.currentBranch }
              : {}),
            runtimeMode,
            interactionMode,
          });
          if (settingsResult._tag === "Failure") return settingsResult;
          const modelSelection = composerRef.current?.getSendContext().selectedModelSelection;
          const turnResult = await startThreadTurn({
            environmentId,
            input: {
              threadId,
              manualContinuationOfRunId: resumableRunId,
              ...(modelSelection ? { modelSelection } : {}),
              message: {
                messageId: newMessageId(),
                role: "user",
                text: "Continue where you left off.",
                attachments: [],
              },
              runtimeMode,
              interactionMode,
              dispatchMode: "start",
            },
          });
          if (turnResult._tag === "Failure" || !hasHeldQueuedRuns) return turnResult;
          clearUsageLimitsFor(routeThreadKey);
          return resumeThreadQueue({ environmentId, input: { threadId } });
        };
        const result = await resume();
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            setThreadError(
              threadId,
              error instanceof Error ? error.message : "Could not resume thread.",
            );
          }
        } else {
          clearUsageLimitsFor(routeThreadKey);
          if (currentRouteThreadKeyRef.current === routeThreadKey) scrollToEnd();
        }
      },
      () => {
        sendInFlightRef.current = false;
        setResumingThreadKeys((current) => {
          const next = new Set(current);
          next.delete(routeThreadKey);
          return next;
        });
      },
    );
  };
  useLayoutEffect(() => {
    onResumeNowRef.current = onResume;
  });

  // A launch an offline paired machine refused created nothing, and the send's
  // failure path restores the draft. The toast's one action clears the pick
  // and sends the same draft from this machine.
  const resendRef = useRef<() => void>(() => undefined);
  const offlineLaunchToast = (machine: EnvironmentId, sendRouteThreadKey: string) => {
    const copy = describeOfflineLaunch({
      machineName:
        runOnOptions.find((option) => option.environmentId === machine)?.label ?? "That machine",
      hereName:
        runOnOptions.find((option) => option.environmentId === environmentId)?.label ??
        "this machine",
    });
    return {
      title: copy.title,
      description: copy.description,
      actionProps: {
        children: copy.actionLabel,
        onClick: () => {
          setDraftThreadContext(draftId ?? routeThreadRef, {
            launchMachine: null,
            environmentSelection: "manual",
          });
          if (currentRouteThreadKeyRef.current === sendRouteThreadKey) {
            resendRef.current();
          } else if (draftId) {
            void navigate({ to: "/draft/$draftId", params: { draftId } });
          }
        },
      },
    };
  };

  const onSend = async (
    e?: { preventDefault: () => void },
    dispatchMode: ComposerDispatchMode = "auto",
    submissionIntent: ComposerSubmissionIntent = "foreground",
    directAnnotation?: {
      annotation: PreviewAnnotationPayload;
      image: ComposerImageAttachment | null;
    },
  ) => {
    e?.preventDefault();
    // Typed out in full rather than picked from the menu. Attachments or contexts
    // mean the user is sending a prompt, so those go through as usual.
    if (
      usageLimitsOffered &&
      usageLimitsKey !== null &&
      !directAnnotation &&
      !composerHasNonPromptContent &&
      isUsageLimitsCommand(promptRef.current)
    ) {
      if (openUsageLimits()) {
        promptRef.current = "";
        setComposerDraftPrompt(composerDraftTarget, "");
        composerRef.current?.resetCursorState();
      }
      return;
    }

    const notifyDirectAnnotationAttached = () => {
      if (!directAnnotation) return;
      toastManager.add(
        stackedThreadToast({
          type: "info",
          title: "Annotation attached to draft",
          description: "Sending is unavailable right now. Finish the current action, then send.",
        }),
      );
    };
    if (
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
      !activeThread ||
      (isSendBusy && !sendQueuesBehindSetup) ||
      isConnecting ||
      isRevertingCheckpoint ||
      !clientSettingsHydrated ||
      threadDetailLoading ||
      environmentChangeRef.current !== null ||
      sendInFlightRef.current ||
      feedbackUploadsInFlightRef.current.has(routeThreadKey)
    ) {
      notifyDirectAnnotationAttached();
      return;
    }
    if (needsLoadBalancing) {
      toastManager.add({
        type: "warning",
        title: loadBalancing.pending
          ? "Checking machine resources"
          : "Choose a machine to continue",
        description: loadBalancing.pending
          ? "Resource checks are still running. You can choose a machine in the composer."
          : "No eligible machine has available resources. Choose a machine in the composer to override.",
      });
      return;
    }
    if (activeEnvironmentUnavailable) {
      const toastSlot = environmentUnavailableSendToastSlotRef.current;
      environmentUnavailableSendToastSlotRef.current =
        (toastSlot + 1) % ENVIRONMENT_UNAVAILABLE_SEND_TOAST_TRAIL_SIZE;
      toastManager.add({
        ...stackedThreadToast({
          type: "warning",
          title: "Not connected: message not sent",
          description: "Reconnecting to the environment. Try again once it is connected.",
        }),
        id: `chat-send-environment-unavailable:${toastSlot}`,
      });
      return;
    }
    const sendCtx = composerRef.current?.getSendContext();
    if (activePendingProgress && sendCtx?.answeringPendingUserInput !== false) {
      if (directAnnotation) {
        notifyDirectAnnotationAttached();
        return;
      }
      onAdvanceActivePendingUserInput();
      return;
    }
    if (!sendCtx?.providerAvailable) {
      notifyDirectAnnotationAttached();
      return;
    }
    const multipleModelSelections = sendCtx.multipleModelSelections;
    if (
      multipleModelSelections !== null &&
      serverConfig?.environment.capabilities.requiredWorktreeBootstrap !== true
    ) {
      setThreadError(activeThread.id, "Update this server before starting multiple models.");
      return;
    }
    if (
      multipleModelSelections !== null &&
      (!isLocalDraftThread ||
        !isGitRepo ||
        !activeThreadBranch ||
        multipleModelSelections.length === 0)
    ) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Choose models and a base branch",
          description:
            "Multiple models need a new thread in a Git repository. Each gets its own worktree.",
        }),
      );
      return;
    }
    const {
      images: sendContextImages,
      files: composerFiles,
      terminalContexts: composerTerminalContexts,
      previewAnnotations: sendContextPreviewAnnotations,
      reviewComments: composerReviewComments,
      threadContexts: composerThreadContexts,
      selectedProvider: ctxSelectedProvider,
      selectedModel: ctxSelectedModel,
      selectedProviderModels: ctxSelectedProviderModels,
      selectedPromptEffort: ctxSelectedPromptEffort,
      selectedModelSelection: ctxSelectedModelSelection,
      interactionMode: sendInteractionMode,
      interactionModeEnabled: sendInteractionModeEnabled,
    } = sendCtx;
    const annotationImageAlreadyAttached =
      directAnnotation?.image !== undefined &&
      sendContextImages.some((image) => image.id === directAnnotation.image?.id);
    // A full composer (e.g. 8 files) cannot take the annotation screenshot;
    // over the cap the server rejects the whole turn.
    const annotationImageAppended =
      directAnnotation?.image !== undefined &&
      !annotationImageAlreadyAttached &&
      sendContextImages.length + composerFiles.length < PROVIDER_SEND_TURN_MAX_ATTACHMENTS;
    const composerImages =
      directAnnotation?.image && annotationImageAppended
        ? [...sendContextImages, directAnnotation.image]
        : sendContextImages;
    const composerPreviewAnnotations =
      directAnnotation &&
      !sendContextPreviewAnnotations.some(
        (annotation) => annotation.id === directAnnotation.annotation.id,
      )
        ? [
            ...sendContextPreviewAnnotations,
            {
              ...directAnnotation.annotation,
              // Claim an attached crop only when the screenshot really rides
              // along; a cap-dropped image must not produce a lying prompt.
              screenshot:
                directAnnotation.annotation.screenshot &&
                (annotationImageAppended || annotationImageAlreadyAttached)
                  ? { ...directAnnotation.annotation.screenshot, dataUrl: "" }
                  : null,
            },
          ]
        : sendContextPreviewAnnotations;
    // A direct "send annotation" writes the draft and sends in the same tick; the reference
    // must be in the text now, not after the next render.
    const promptForSend = directAnnotation
      ? ensureInlineContextReferences(promptRef.current, [
          previewAnnotationContextReference(directAnnotation.annotation),
        ])
      : promptRef.current;
    if (editingQueuedRun !== null) {
      // Edit mode repurposes the composer: sending saves the queued message
      // in place instead of dispatching a new turn.
      if (queuedEditSaveInFlightRef.current) return;
      const editText = promptForSend.trim();
      const newEditImages = [...composerImages];
      const newEditFiles = [...composerFiles];
      const newEditAttachments = [...newEditImages, ...newEditFiles];
      if (
        editingQueuedRun.existingAttachments.length + newEditAttachments.length >
        PROVIDER_SEND_TURN_MAX_ATTACHMENTS
      ) {
        setThreadError(
          editingQueuedRun.threadId,
          `A message can have at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments.`,
        );
        return;
      }
      if (
        editText.length === 0 &&
        editingQueuedRun.existingAttachments.length === 0 &&
        newEditImages.length === 0 &&
        newEditFiles.length === 0
      ) {
        return;
      }
      queuedEditSaveInFlightRef.current = true;
      setIsSavingQueuedEdit(true);
      await runCatching(
        async () => {
          const uploads = await prepareQueuedEditAttachments({
            existingAttachments: editingQueuedRun.existingAttachments,
            images: newEditImages,
            files: newEditFiles,
            readImage: readFileAsDataUrl,
            uploadFiles: async (files) => {
              const validateFiles = () => {
                const config =
                  appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId) ?? null;
                const reason = fileAttachmentCapabilityBlockReason({
                  files,
                  attachmentUploadsCapabilityKnown: config !== null,
                  supportsAttachmentUploads:
                    config?.environment.capabilities.attachmentUploads === true,
                  maxFileAttachmentBytes:
                    config?.environment.capabilities.fileAttachments?.maxUploadBytes ?? null,
                });
                if (reason !== null) throw new Error(reason);
              };
              validateFiles();
              for (const file of files)
                startAttachmentUpload({
                  environmentId,
                  image: file,
                  draftTarget: composerDraftTarget,
                });
              await awaitAttachmentUploads(files.map((file) => file.id));
              validateFiles();
              const uploaded = getUploadedAttachments({ environmentId, images: files });
              if (uploaded === null)
                throw new Error("Retry or remove failed uploads before saving.");
              return uploaded;
            },
          });
          const result = await editQueuedRunCommand({
            environmentId: activeThread.environmentId,
            input: {
              threadId: editingQueuedRun.threadId,
              runId: editingQueuedRun.runId,
              text: editText.length === 0 ? ATTACHMENT_ONLY_BOOTSTRAP_PROMPT : editText,
              edit: {
                messageId: editingQueuedRun.messageId,
                attachments: uploads,
                context: {
                  version: 1,
                  records: [
                    ...new Map(
                      [
                        ...(editingQueuedRun.context?.records ?? []).filter(
                          (record) =>
                            !("attachmentId" in record) ||
                            editingQueuedRun.existingAttachments.some(
                              (attachment) => attachment.id === record.attachmentId,
                            ),
                        ),
                        ...(buildMessageContext({
                          terminalContexts: composerTerminalContexts.filter(
                            (context) => context.text.trim().length > 0,
                          ),
                          reviewComments: composerReviewComments,
                          previewAnnotations: composerPreviewAnnotations,
                          threadContexts: composerThreadContexts,
                          attachments: newEditAttachments.map((attachment, index) => ({
                            attachment,
                            attachmentId:
                              uploads[editingQueuedRun.existingAttachments.length + index]?.id ??
                              attachment.id,
                          })),
                        })?.records ?? []),
                      ].map((record) => [record.contextId, record] as const),
                    ).values(),
                  ],
                },
              },
            },
          });
          if (result._tag === "Failure") {
            setThreadError(editingQueuedRun.threadId, "Could not save the edited queued message.");
            return;
          }
          setThreadError(editingQueuedRun.threadId, null);
          releaseDraftAttachments(newEditAttachments);
          promptRef.current = "";
          clearComposerDraftContent(queuedEditDraftTargetFor(editingQueuedRun.runId));
          composerRef.current?.resetCursorState();
          setEditingQueuedRun(null);
          scheduleComposerFocus();
        },
        (error) => {
          setThreadError(
            editingQueuedRun.threadId,
            error instanceof Error ? error.message : "Could not save the edited queued message.",
          );
        },
        () => {
          queuedEditSaveInFlightRef.current = false;
          setIsSavingQueuedEdit(false);
        },
      );
      return;
    }
    const {
      trimmedPrompt: trimmed,
      sendableTerminalContexts: sendableComposerTerminalContexts,
      expiredTerminalContextCount,
      hasSendableContent,
    } = deriveComposerSendState({
      prompt: promptForSend,
      imageCount: composerImages.length + composerFiles.length,
      terminalContexts: composerTerminalContexts,
      elementContextCount:
        composerPreviewAnnotations.length +
        composerReviewComments.length +
        composerThreadContexts.length,
    });
    const feedbackCommand =
      ctxSelectedProvider === "codex" &&
      composerImages.length === 0 &&
      composerFiles.length === 0 &&
      sendableComposerTerminalContexts.length === 0 &&
      composerPreviewAnnotations.length === 0 &&
      composerReviewComments.length === 0 &&
      composerThreadContexts.length === 0
        ? parseCodexFeedbackCommand(trimmed)
        : null;
    if (feedbackCommand && multipleModelSelections === null) {
      if (!isServerThread || activeThread.activeProviderThreadId === null) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Start a Codex thread first",
            description: "Send a message before you submit feedback.",
          }),
        );
        return;
      }
      feedbackUploadsInFlightRef.current.add(routeThreadKey);
      await submitCodexFeedback({
        submission: {
          id: newMessageId(),
          command: trimmed,
          createdAt: new Date().toISOString(),
        },
        clearDraft: () => {
          promptRef.current = "";
          clearComposerDraftContent(composerDraftTarget);
          composerRef.current?.resetCursorState();
        },
        onUpdate: (submission) => {
          setFeedbackSubmissionsByThreadKey((current) => {
            const existing = current[routeThreadKey] ?? [];
            const found = existing.some((entry) => entry.id === submission.id);
            return {
              ...current,
              [routeThreadKey]: found
                ? existing.map((entry) => (entry.id === submission.id ? submission : entry))
                : [...existing, submission],
            };
          });
        },
        upload: () =>
          uploadThreadFeedback({
            environmentId: activeThread.environmentId,
            input: { threadId: activeThread.id, ...feedbackCommand },
          }),
      }).finally(() => {
        feedbackUploadsInFlightRef.current.delete(routeThreadKey);
      });

      return;
    }
    if (
      !directAnnotation &&
      sendInteractionModeEnabled &&
      showPlanFollowUpPrompt &&
      activeProposedPlan &&
      composerImages.length === 0 &&
      composerFiles.length === 0
    ) {
      const followUp = resolvePlanFollowUpSubmission({
        draftText: promptForSend,
        planMarkdown: activeProposedPlan.planMarkdown,
      });
      const outgoingFollowUpText = formatOutgoingPrompt({
        provider: ctxSelectedProvider,
        model: ctxSelectedModel,
        models: ctxSelectedProviderModels,
        effort: ctxSelectedPromptEffort,
        text: followUp.text.trim(),
      });
      if (composerRef.current?.validateProviderInput(outgoingFollowUpText) === false) {
        return;
      }
      // The composer is cleared before the send resolves, so hold everything it carried: a
      // transient failure must give the prose and its context back, as the ordinary send does.
      // Snapshot exactly what was sent, copied, so later mutations cannot alias the backup.
      const followUpPromptSnapshot = promptRef.current;
      const followUpTerminalContexts = [...sendableComposerTerminalContexts];
      const followUpReviewComments = [...composerReviewComments];
      const followUpPreviewAnnotations = [...composerPreviewAnnotations];
      const followUpThreadContexts = [...composerThreadContexts];
      promptRef.current = "";
      clearComposerDraftContent(composerDraftTarget);
      composerRef.current?.resetCursorState();
      const followUpSent = await onSubmitPlanFollowUp({
        text: followUp.text,
        context: buildMessageContext({
          terminalContexts: sendableComposerTerminalContexts,
          reviewComments: composerReviewComments,
          previewAnnotations: composerPreviewAnnotations,
          threadContexts: composerThreadContexts,
        }),
        interactionMode: followUp.interactionMode,
      });
      if (!followUpSent) {
        promptRef.current = followUpPromptSnapshot;
        composerTerminalContextsRef.current = [...followUpTerminalContexts];
        restorePlanFollowUpComposer({
          snapshot: {
            prompt: followUpPromptSnapshot,
            terminalContexts: followUpTerminalContexts,
            reviewComments: followUpReviewComments,
            previewAnnotations: followUpPreviewAnnotations,
            threadContexts: followUpThreadContexts,
          },
          writePrompt: (prompt) => setComposerDraftPrompt(composerDraftTarget, prompt),
          writeTerminalContexts: (contexts) =>
            setComposerDraftTerminalContexts(composerDraftTarget, [...contexts]),
          writeReviewComments: (comments) =>
            setComposerDraftReviewComments(composerDraftTarget, [...comments]),
          writePreviewAnnotations: (annotations) =>
            setComposerDraftPreviewAnnotations(composerDraftTarget, [...annotations]),
          writeThreadContexts: (records) =>
            setComposerDraftThreadContexts(composerDraftTarget, [...records]),
          resetCursor: (options) => composerRef.current?.resetCursorState(options),
        });
      } else if (
        submissionIntent === "background" &&
        currentRouteThreadKeyRef.current === routeThreadKey
      ) {
        handleNewThreadInActiveProject();
      }
      return;
    }
    // Providers without the legacy toggle receive their native commands unchanged.
    const standaloneSlashCommand =
      sendInteractionModeEnabled &&
      composerImages.length === 0 &&
      composerFiles.length === 0 &&
      sendableComposerTerminalContexts.length === 0 &&
      composerPreviewAnnotations.length === 0 &&
      composerReviewComments.length === 0 &&
      composerThreadContexts.length === 0
        ? parseStandaloneComposerSlashCommand(trimmed)
        : null;
    if (standaloneSlashCommand && multipleModelSelections === null) {
      handleInteractionModeChange(standaloneSlashCommand);
      promptRef.current = "";
      clearComposerDraftContent(composerDraftTarget);
      composerRef.current?.resetCursorState();
      return;
    }
    if (!hasSendableContent) {
      if (expiredTerminalContextCount > 0) {
        const toastCopy = buildExpiredTerminalContextToastCopy(
          expiredTerminalContextCount,
          "empty",
        );
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: toastCopy.title,
            description: toastCopy.description,
          }),
        );
      }
      return;
    }
    if (!activeProject) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Choose a repository first",
          description: "This draft no longer points to an available repository.",
        }),
      );
      return;
    }
    const threadIdForSend = activeThread.id;
    const isFirstMessage = !sendQueuesBehindSetup && (!isServerThread || activeMessageCount === 0);
    const baseBranchForWorktree =
      isFirstMessage && sendEnvMode === "worktree" && !activeThread.worktreePath
        ? activeThreadBranch
        : null;

    // In worktree mode, require an explicit base branch so we don't silently
    // fall back to local execution when branch selection is missing.
    const shouldCreateWorktree =
      isFirstMessage && sendEnvMode === "worktree" && !activeThread.worktreePath;
    if (shouldCreateWorktree && !activeThreadBranch) {
      setThreadError(threadIdForSend, "Select a base branch before sending in New worktree mode.");
      return;
    }

    const composerImagesSnapshot = [...composerImages];
    const composerFilesSnapshot = [...composerFiles];
    const composerAttachmentsSnapshot = [...composerImagesSnapshot, ...composerFilesSnapshot];
    const composerTerminalContextsSnapshot = [...sendableComposerTerminalContexts];
    const composerPreviewAnnotationsSnapshot = [...composerPreviewAnnotations];
    const composerReviewCommentsSnapshot: ReviewCommentContext[] = [...composerReviewComments];
    const composerThreadContextsSnapshot = [...composerThreadContexts];
    // Expired terminal excerpts are not sent; their chips leave the text with them.
    const messageTextForSend = composerTerminalContexts
      .filter((context) => !composerTerminalContextsSnapshot.includes(context))
      .reduce(
        (text, context) =>
          removeInlineContextReference(text, terminalContextReference(context).contextId).prompt,
        promptForSend,
      )
      .trim();
    // Records bind attachments by the id each side knows: the local id for the optimistic
    // row, the upload id (or local id on the data-URL path) on the wire; the server
    // rebinds them to the persisted id.
    const buildOutgoingMessageContext = (attachmentIds: ReadonlyArray<string>) =>
      buildMessageContext({
        terminalContexts: composerTerminalContextsSnapshot,
        reviewComments: composerReviewCommentsSnapshot,
        previewAnnotations: composerPreviewAnnotationsSnapshot,
        threadContexts: composerThreadContextsSnapshot,
        attachments: composerAttachmentsSnapshot.map((attachment, index) => ({
          attachment,
          attachmentId: attachmentIds[index] ?? attachment.id,
        })),
      });
    const outgoingMessageContext = buildOutgoingMessageContext(
      composerAttachmentsSnapshot.map((attachment) => attachment.id),
    );
    const messageIdForSend = newMessageId();
    const messageCreatedAt = new Date().toISOString();
    // A stale Claude session compacts before this message so the turn does not re-read the
    // old history. The message queues behind the /compact run, since steering into it is
    // rejected.
    const compactBeforeSend =
      resumeCompactionTokens !== null &&
      !keepFullHistory &&
      messageTextForSend.toLowerCase() !== "/compact";
    // A running /compact or /logout turn takes no steering, so the server queues
    // a steer behind it; show it in the queue rather than as a steer.
    const steerQueuesBehindMaintenance =
      phase === "running" &&
      (dispatchMode === "steer" || dispatchMode === "auto") &&
      serverProjection !== null &&
      activeRunRefusesSteering(serverProjection);
    const turnDispatchMode =
      compactBeforeSend || sendQueuesBehindSetup || steerQueuesBehindMaintenance
        ? "queue"
        : dispatchMode;
    const shouldQueueBehindActiveRun =
      compactBeforeSend ||
      sendQueuesBehindSetup ||
      steerQueuesBehindMaintenance ||
      (phase === "running" && dispatchMode === "queue");
    const outgoingMessageText = formatOutgoingPrompt({
      provider: ctxSelectedProvider,
      model: ctxSelectedModel,
      models: ctxSelectedProviderModels,
      effort: ctxSelectedPromptEffort,
      text: messageTextForSend || ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
    });
    if (composerRef.current?.validateProviderInput(outgoingMessageText) === false) {
      return;
    }

    const readLiveAttachmentCapabilities = () => {
      const config = appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId) ?? null;
      const liveSupportsAttachmentUploads =
        config?.environment.capabilities.attachmentUploads === true;
      return {
        supportsAttachmentUploads: liveSupportsAttachmentUploads,
        fileBlockReason: fileAttachmentCapabilityBlockReason({
          files: composerFilesSnapshot,
          attachmentUploadsCapabilityKnown: config !== null,
          supportsAttachmentUploads: liveSupportsAttachmentUploads,
          maxFileAttachmentBytes:
            config?.environment.capabilities.fileAttachments?.maxUploadBytes ?? null,
        }),
      };
    };

    const multipleTargets: Array<{
      readonly selection: ModelSelection;
      readonly text: string;
      readonly interactionMode: ReturnType<
        typeof resolveComposerInteractionMode
      >["interactionMode"];
    }> = [];
    for (const selection of multipleModelSelections ?? []) {
      const provider = providerInstanceEntries.find(
        (entry) => entry.instanceId === selection.instanceId,
      );
      if (!provider?.enabled || !provider.isAvailable || provider.status !== "ready") {
        setThreadError(threadIdForSend, `Provider for ${selection.model} is unavailable.`);
        return;
      }
      const providerBlockReason = getProviderSendBlockReason(provider.snapshot, selection.model);
      if (providerBlockReason) {
        setThreadError(threadIdForSend, providerBlockReason);
        return;
      }
      const providerState = getComposerProviderState({
        provider: provider.driverKind,
        model: selection.model,
        models: provider.models,
        modelOptions: selection.options,
        promptInjectionState: getComposerPromptInjectionState(messageTextForSend),
        planModeEnabled: settings.planModeEnabled,
      });
      const text = formatOutgoingPrompt({
        provider: provider.driverKind,
        model: selection.model,
        models: provider.models,
        effort: providerState.promptEffort,
        text: messageTextForSend || ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
      });
      if (composerRef.current?.validateProviderInput(text) === false) return;
      multipleTargets.push({
        selection: createModelSelection(
          selection.instanceId,
          selection.model,
          providerState.modelOptionsForDispatch,
        ),
        text,
        interactionMode: resolveComposerInteractionMode({
          planModeEnabled: settings.planModeEnabled,
          provider: provider.snapshot,
          interactionMode: sendInteractionMode,
        }).interactionMode,
      });
    }

    sendInFlightRef.current = true;
    const sendGeneration = ++composerSendGenerationRef.current;
    const attachmentCapabilitiesBeforeUpload = readLiveAttachmentCapabilities();
    if (attachmentCapabilitiesBeforeUpload.fileBlockReason !== null) {
      sendInFlightRef.current = false;
      setThreadError(threadIdForSend, attachmentCapabilitiesBeforeUpload.fileBlockReason);
      return;
    }
    const turnUsesAttachmentUploads =
      composerFilesSnapshot.length > 0
        ? attachmentCapabilitiesBeforeUpload.supportsAttachmentUploads
        : supportsAttachmentUploads;
    if (turnUsesAttachmentUploads && composerAttachmentsSnapshot.length > 0) {
      for (const attachment of composerAttachmentsSnapshot) {
        startAttachmentUpload({
          environmentId,
          image: attachment,
          draftTarget: composerDraftTarget,
        });
      }
      await awaitAttachmentUploads(composerAttachmentsSnapshot.map((attachment) => attachment.id));
      const attachmentCapabilitiesAfterUpload = readLiveAttachmentCapabilities();
      if (attachmentCapabilitiesAfterUpload.fileBlockReason !== null) {
        sendInFlightRef.current = false;
        setThreadError(threadIdForSend, attachmentCapabilitiesAfterUpload.fileBlockReason);
        return;
      }
      if (getUploadedAttachments({ environmentId, images: composerAttachmentsSnapshot }) === null) {
        sendInFlightRef.current = false;
        setThreadError(threadIdForSend, "Retry or remove failed uploads before sending.");
        return;
      }
    }

    if (
      multipleModelSelections === null &&
      shouldDockDraftHeroForSubmission({ isDraftHeroState, activeThreadKey, submissionIntent }) &&
      activeThreadKey
    ) {
      let resolveDockStarted: (() => void) | undefined;
      const dockStarted = new Promise<void>((resolve) => {
        resolveDockStarted = resolve;
      });
      const dockTransition = runMobileComposerTransition(
        () => {
          flushSync(() => {
            captureDraftHeroComposerRect();
            setDockedDraftHeroThreadKey(activeThreadKey);
          });
          resolveDockStarted?.();
        },
        {
          active: readPanelAnimationsActive(),
          durationMs: LAYOUT_MOTION_DURATION,
        },
      );
      void dockTransition.catch(() => resolveDockStarted?.());
      await dockStarted;
    }

    const attachmentCapabilitiesBeforeDispatch = readLiveAttachmentCapabilities();
    if (
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
      attachmentCapabilitiesBeforeDispatch.fileBlockReason !== null
    ) {
      sendInFlightRef.current = false;
      setThreadError(
        threadIdForSend,
        attachmentCapabilitiesBeforeDispatch.fileBlockReason ??
          "This connection cannot change threads.",
      );
      setDockedDraftHeroThreadKey((currentThreadKey) =>
        currentThreadKey === activeThreadKey ? null : currentThreadKey,
      );
      return;
    }
    // A send queued behind setup leaves the first send's dispatch and setup card alone.
    if (sendQueuesBehindSetup) {
      setSetupQueueSendThreadKey(activeThreadKey);
    } else {
      beginLocalDispatch({
        preparingWorktree: multipleModelSelections !== null || Boolean(baseBranchForWorktree),
        // Only a draft has a background submission to hide behind its hero.
        submissionIntent:
          submissionIntent === "background" && !isLocalDraftThread
            ? "foreground"
            : submissionIntent,
      });
      setWorktreeSetupRef(
        multipleModelSelections === null && baseBranchForWorktree
          ? {
              environmentId: activeThread.environmentId,
              threadId: threadIdForSend,
              ownerKey: worktreeSetupOwnerKey,
            }
          : null,
      );
    }

    const turnAttachmentsPromise = Promise.all(
      composerAttachmentsSnapshot.map(async (attachment) => {
        if (turnUsesAttachmentUploads) {
          const uploaded = getUploadedAttachments({ environmentId, images: [attachment] })?.[0];
          if (!uploaded) {
            throw new Error(`Attachment '${attachment.name}' did not finish uploading.`);
          }
          return uploaded;
        }
        if (attachment.type !== "image") {
          throw new Error("This server does not support file attachments.");
        }
        return {
          type: "image" as const,
          id: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          dataUrl: await readFileAsDataUrl(attachment.file),
        };
      }),
    );
    // A new thread launches on the paired machine picked in "Run on", read
    // now so a pick made while uploads ran still applies.
    const launchMachineForSend = isLocalDraftThread
      ? resolveDraftLaunchTarget({
          draftEnvironmentId: environmentId,
          launchMachine: (draftId
            ? useComposerDraftStore.getState().getDraftSession(draftId)
            : useComposerDraftStore.getState().getDraftSessionByRef(routeThreadRef)
          )?.launchMachine,
        }).machine
      : undefined;
    const launchMachineFields =
      launchMachineForSend === undefined ? {} : { machine: launchMachineForSend };
    if (multipleModelSelections !== null) {
      const failedSelections: ModelSelection[] = [];
      let clearedDraft = false;
      let releasedComposer = false;
      let canRestoreDraft = () => false;
      let startedCount = 0;
      await runCatching(
        async () => {
          const attachments = await turnAttachmentsPromise;
          const fileBlockReason = readLiveAttachmentCapabilities().fileBlockReason;
          if (fileBlockReason !== null) throw new Error(fileBlockReason);
          const context = buildOutgoingMessageContext(
            attachments.map((attachment, index) =>
              "id" in attachment && attachment.id !== undefined
                ? attachment.id
                : composerAttachmentsSnapshot[index]!.id,
            ),
          );
          const title = truncate(
            assistantCitationsToPlainText(stripInlineContextReferences(trimmed)).trim() ||
              composerAttachmentsSnapshot[0]?.name ||
              "New thread",
          );
          promptRef.current = "";
          clearComposerDraftContent(composerDraftTarget);
          composerRef.current?.resetCursorState();
          clearedDraft = true;
          const clearedDraftSnapshot = useComposerDraftStore
            .getState()
            .getComposerDraft(composerDraftTarget);
          const submittedSelections = multipleModelSelectionsRef.current;
          canRestoreDraft = () =>
            currentRouteThreadKeyRef.current === routeThreadKey &&
            composerSendGenerationRef.current === sendGeneration &&
            useComposerDraftStore.getState().getComposerDraft(composerDraftTarget) ===
              clearedDraftSnapshot &&
            multipleModelSelectionsRef.current === submittedSelections;
          setThreadError(threadIdForSend, null);
          // Each model's chat starts in the project picked on the draft.
          const draftProjectFolderId = readPendingProjectFolderId(threadIdForSend, environmentId);
          const starts = Promise.all(
            multipleTargets.map(async (target) => {
              const retryKey = JSON.stringify([
                routeThreadKey,
                target.selection.instanceId,
                target.selection.model,
              ]);
              const uncertainThreadId = uncertainMultipleSubmissionsRef.current.get(retryKey);
              const targetThreadId = uncertainThreadId ?? newThreadId();
              let requestMayHaveStarted = false;
              await runCatching(
                async () => {
                  if (uncertainThreadId) {
                    throw new Error(
                      "The previous request may have started. Open its thread to check before sending again.",
                    );
                  }
                  const supportsInlineMessageContext =
                    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)
                      ?.environment.capabilities.inlineMessageContext === true;
                  requestMayHaveStarted = true;
                  const result = await startThreadTurn({
                    environmentId,
                    input: {
                      threadId: targetThreadId,
                      message: {
                        messageId: newMessageId(),
                        role: "user",
                        text:
                          context && !supportsInlineMessageContext
                            ? serializeLegacyContextMessage({
                                text: target.text,
                                records: context.records,
                              })
                            : target.text,
                        attachments,
                        ...(context && supportsInlineMessageContext ? { context } : {}),
                      },
                      modelSelection: target.selection,
                      titleSeed: title,
                      runtimeMode,
                      interactionMode: target.interactionMode,
                      bootstrap: {
                        createThread: {
                          ...(activeThreadSurface ? { surface: activeThreadSurface } : {}),
                          projectId: activeProject.id,
                          title,
                          modelSelection: target.selection,
                          runtimeMode,
                          interactionMode: target.interactionMode,
                          branch: activeThreadBranch,
                          worktreePath: null,
                          createdAt: messageCreatedAt,
                          ...(draftProjectFolderId === null
                            ? {}
                            : { projectFolderId: draftProjectFolderId }),
                          ...launchMachineFields,
                        },
                        prepareWorktree: {
                          projectCwd: activeProject.workspaceRoot,
                          baseBranch: activeThreadBranch!,
                          requireWorktree: true,
                          ...(startFromOrigin ? { startFromOrigin: true } : {}),
                        },
                        runSetupScript: true,
                      },
                      createdAt: messageCreatedAt,
                    },
                  });
                  if (result._tag === "Failure") {
                    const error = squashAtomCommandFailure(result);
                    if (
                      wasBootstrapThreadDeleted(error) ||
                      wasBootstrapThreadNotCreated(error) ||
                      wasLaunchMachineOffline(error)
                    ) {
                      requestMayHaveStarted = false;
                    }
                    throw error;
                  }
                  startedCount += 1;
                },
                (error) => {
                  if (
                    requestMayHaveStarted &&
                    !uncertainMultipleSubmissionsRef.current.has(retryKey)
                  ) {
                    uncertainMultipleSubmissionsRef.current.set(retryKey, targetThreadId);
                  }
                  failedSelections.push(target.selection);
                  const retainedThreadId = uncertainMultipleSubmissionsRef.current.get(retryKey);
                  if (launchMachineForSend !== undefined && wasLaunchMachineOffline(error)) {
                    // One toast for every model the offline machine refused.
                    toastManager.add({
                      ...stackedThreadToast({
                        type: "error",
                        ...offlineLaunchToast(launchMachineForSend, routeThreadKey),
                      }),
                      id: `offline-launch:${routeThreadKey}`,
                    });
                    return;
                  }
                  const failureToastId = toastManager.add(
                    stackedThreadToast({
                      type: "error",
                      title: `Could not start ${target.selection.model}`,
                      description:
                        error instanceof Error ? error.message : "Failed to send message.",
                      ...(retainedThreadId
                        ? {
                            timeout: 0,
                            data: {
                              secondaryActionProps: {
                                children: "Allow retry",
                                onClick: () => {
                                  void readLocalApi()
                                    ?.dialogs.confirm(
                                      "The previous request may already be running. Check its thread first. Allow another send that could create a duplicate thread?",
                                    )
                                    .then(
                                      (confirmed) => {
                                        if (
                                          confirmed &&
                                          uncertainMultipleSubmissionsRef.current.get(retryKey) ===
                                            retainedThreadId
                                        ) {
                                          uncertainMultipleSubmissionsRef.current.delete(retryKey);
                                          toastManager.close(failureToastId);
                                        }
                                      },
                                      () => undefined,
                                    );
                                },
                              },
                            },
                            actionProps: {
                              children: "Open thread",
                              onClick: () => {
                                void navigate({
                                  to: "/$environmentId/$threadId",
                                  params: buildThreadRouteParams(
                                    scopeThreadRef(environmentId, retainedThreadId),
                                  ),
                                });
                              },
                            },
                          }
                        : {}),
                    }),
                  );
                },
              );
            }),
          );
          // Each request now owns its background thread. The original draft is
          // ready for another prompt while checkout and setup scripts finish.
          sendInFlightRef.current = false;
          resetLocalDispatch();
          releasedComposer = true;
          await starts;
          if (startedCount > 0) {
            toastManager.add(
              stackedThreadToast({
                type: "success",
                title: `Started ${startedCount} ${startedCount === 1 ? "thread" : "threads"} in background`,
              }),
            );
          }
          if (failedSelections.length === 0 && turnUsesAttachmentUploads) {
            releaseDraftAttachments(composerAttachmentsSnapshot);
          }
        },
        (error) => {
          failedSelections.push(...multipleModelSelections);
          setThreadError(
            threadIdForSend,
            error instanceof Error ? error.message : "Failed to send messages.",
          );
        },
        () => {
          const restoreFailedDraft = () => {
            setMultipleModelSelections(failedSelections);
            if (clearedDraft) {
              setComposerDraftPrompt(composerDraftTarget, messageTextForSend);
              addComposerDraftImages(
                composerDraftTarget,
                composerImagesSnapshot.map(cloneComposerImageForRetry),
              );
              addComposerDraftFiles(composerDraftTarget, composerFilesSnapshot);
              setComposerDraftTerminalContexts(
                composerDraftTarget,
                composerTerminalContextsSnapshot,
              );
              setComposerDraftPreviewAnnotations(
                composerDraftTarget,
                composerPreviewAnnotationsSnapshot,
              );
              setComposerDraftReviewComments(composerDraftTarget, composerReviewCommentsSnapshot);
              setComposerDraftThreadContexts(composerDraftTarget, composerThreadContextsSnapshot);
              if (composerRef.current && currentRouteThreadKeyRef.current === routeThreadKey) {
                promptRef.current = messageTextForSend;
                composerRef.current.resetCursorState({
                  cursor: collapseExpandedComposerCursor(
                    messageTextForSend,
                    messageTextForSend.length,
                  ),
                  prompt: messageTextForSend,
                  detectTrigger: true,
                });
              }
            }
          };
          if (failedSelections.length > 0) {
            if (canRestoreDraft() && composerRef.current) {
              restoreFailedDraft();
            } else if (clearedDraft) {
              const recoveryToastId = toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "A background prompt could not be sent",
                  description:
                    "Your newer draft is unchanged. Restore the failed prompt when this composer is empty.",
                  timeout: 0,
                  actionProps: {
                    children: "Restore prompt",
                    onClick: () => {
                      if (
                        !draftId ||
                        !useComposerDraftStore.getState().getDraftSession(draftId) ||
                        sendInFlightRef.current ||
                        composerDraftHasUserContent(
                          useComposerDraftStore.getState().getComposerDraft(composerDraftTarget),
                        )
                      ) {
                        toastManager.update(recoveryToastId, {
                          description:
                            "Return to the original draft and send or clear its current prompt before restoring.",
                        });
                        return;
                      }
                      restoreFailedDraft();
                      void navigate({ to: "/draft/$draftId", params: { draftId } });
                      toastManager.close(recoveryToastId);
                    },
                  },
                }),
              );
            }
          }
          if (!releasedComposer) {
            sendInFlightRef.current = false;
            resetLocalDispatch();
          }
        },
      );
      return;
    }
    const optimisticAttachments = composerAttachmentsSnapshot.map((attachment) =>
      attachment.type === "image"
        ? {
            type: "image" as const,
            id: attachment.id,
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            previewUrl: attachment.previewUrl,
          }
        : {
            type: "file" as const,
            id: attachment.id,
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            downloadable: false,
          },
    );
    if (!shouldQueueBehindActiveRun) {
      // A sent turn glides the timeline to its live end, where the new row
      // lands above the composer. Queued input stays in the composer queue and
      // must not move the timeline away from the provider work in flight.
      glideToEndForSend(
        scopedThreadKey(scopeThreadRef(activeThread.environmentId, threadIdForSend)),
        messageIdForSend,
      );
    }
    setOptimisticUserMessages((existing) => [
      ...existing,
      {
        id: messageIdForSend,
        role: "user",
        text: outgoingMessageText,
        ...(optimisticAttachments.length > 0 ? { attachments: optimisticAttachments } : {}),
        ...(outgoingMessageContext !== undefined ? { context: outgoingMessageContext } : {}),
        runId: null,
        createdAt: messageCreatedAt,
        updatedAt: messageCreatedAt,
        streaming: false,
        ...(shouldQueueBehindActiveRun
          ? { inputIntent: "queued_turn" as const }
          : phase === "running" && dispatchMode === "steer"
            ? { inputIntent: "steer" as const }
            : {}),
      },
    ]);
    setThreadError(threadIdForSend, null);
    if (expiredTerminalContextCount > 0) {
      const toastCopy = buildExpiredTerminalContextToastCopy(
        expiredTerminalContextCount,
        "omitted",
      );
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: toastCopy.title,
          description: toastCopy.description,
        }),
      );
    }
    promptRef.current = "";
    clearComposerDraftContent(composerDraftTarget);
    composerRef.current?.resetCursorState();

    let firstComposerImageName: string | null = null;
    if (composerImagesSnapshot.length > 0) {
      const firstComposerImage = composerImagesSnapshot[0];
      if (firstComposerImage) {
        firstComposerImageName = firstComposerImage.name;
      }
    }
    let titleSeed = assistantCitationsToPlainText(stripInlineContextReferences(trimmed)).trim();
    if (!titleSeed) {
      if (firstComposerImageName) {
        titleSeed = `Image: ${firstComposerImageName}`;
      } else if (composerFilesSnapshot[0]) {
        titleSeed = `File: ${composerFilesSnapshot[0].name}`;
      } else if (composerTerminalContextsSnapshot.length > 0) {
        titleSeed = formatTerminalContextLabel(composerTerminalContextsSnapshot[0]!);
      } else if (composerReviewCommentsSnapshot.length > 0) {
        titleSeed = `Review: ${reviewCommentContextLabel(composerReviewCommentsSnapshot[0]!)}`;
      } else if (composerPreviewAnnotationsSnapshot.length > 0) {
        titleSeed = previewAnnotationContextLabel(composerPreviewAnnotationsSnapshot[0]!);
      } else {
        titleSeed = "New thread";
      }
    }
    const title = truncate(titleSeed);
    const threadCreateModelSelection = createModelSelection(
      ctxSelectedModelSelection.instanceId,
      ctxSelectedModel || activeProjectDefaultModelSelection?.model || DEFAULT_MODEL,
      ctxSelectedModelSelection.options,
    );

    let failure: AtomCommandResult<unknown, unknown> | null = null;

    if (failure === null && isServerThread) {
      const settingsResult = await persistThreadSettingsForNextTurn({
        threadId: threadIdForSend,
        createdAt: messageCreatedAt,
        ...(localCheckoutBranchMismatch
          ? { branch: localCheckoutBranchMismatch.currentBranch }
          : {}),
        runtimeMode,
        interactionMode: sendInteractionMode,
      });
      if (settingsResult._tag === "Failure") {
        failure = settingsResult;
      }
    }

    const turnAttachmentsResult = await settlePromise(async () => {
      const turnAttachments = await turnAttachmentsPromise;
      const liveFileBlockReason = readLiveAttachmentCapabilities().fileBlockReason;
      if (liveFileBlockReason !== null) {
        throw new Error(liveFileBlockReason);
      }
      return turnAttachments;
    });
    if (failure === null && turnAttachmentsResult._tag === "Failure") {
      failure = turnAttachmentsResult;
    }

    if (failure === null && compactBeforeSend) {
      const compactResult = await startThreadTurn({
        environmentId,
        input: {
          threadId: threadIdForSend,
          message: { messageId: newMessageId(), role: "user", text: "/compact", attachments: [] },
          modelSelection: ctxSelectedModelSelection,
          runtimeMode,
          interactionMode: sendInteractionMode,
        },
      });
      if (compactResult._tag === "Failure") {
        failure = compactResult;
      }
    }

    let backgroundDraftOpened = false;
    let turnStartSucceeded = false;
    if (failure === null && turnAttachmentsResult._tag === "Success") {
      // A project picked on the draft: the chat is created already in it.
      const draftProjectFolderId = isLocalDraftThread
        ? readPendingProjectFolderId(threadIdForSend, environmentId)
        : null;
      const bootstrap =
        isLocalDraftThread || baseBranchForWorktree
          ? {
              ...(isLocalDraftThread
                ? {
                    createThread: {
                      ...(activeThreadSurface ? { surface: activeThreadSurface } : {}),
                      projectId: activeProject.id,
                      title,
                      modelSelection: threadCreateModelSelection,
                      runtimeMode,
                      interactionMode: sendInteractionMode,
                      branch: activeThreadBranch,
                      // A worktree path is this machine's; another machine starts from the branch.
                      worktreePath:
                        launchMachineForSend === undefined ? activeThread.worktreePath : null,
                      createdAt: activeThread.createdAt,
                      ...(draftProjectFolderId === null
                        ? {}
                        : { projectFolderId: draftProjectFolderId }),
                      ...launchMachineFields,
                    },
                  }
                : {}),
              ...(baseBranchForWorktree
                ? {
                    prepareWorktree: {
                      projectCwd: activeProject.workspaceRoot,
                      baseBranch: baseBranchForWorktree,
                      ...(startFromOrigin ? { startFromOrigin: true } : {}),
                    },
                    runSetupScript: true,
                  }
                : {}),
            }
          : undefined;
      const backgroundThreadRef =
        submissionIntent === "background" && isLocalDraftThread
          ? scopeThreadRef(environmentId, threadIdForSend)
          : null;
      if (backgroundThreadRef) beginBackgroundDraftSubmissionByRef(backgroundThreadRef);
      const settleProjectFolderLaunch =
        draftProjectFolderId === null ? null : beginPendingProjectFolderLaunch(threadIdForSend);
      const startPromise = startThreadTurn({
        environmentId,
        input: {
          threadId: threadIdForSend,
          message: {
            messageId: messageIdForSend,
            role: "user",
            text: outgoingMessageText,
            attachments: turnAttachmentsResult.value,
            ...(() => {
              const context = buildOutgoingMessageContext(
                turnAttachmentsResult.value.map((attachment, index) =>
                  "id" in attachment && attachment.id !== undefined
                    ? attachment.id
                    : composerAttachmentsSnapshot[index]!.id,
                ),
              );
              if (context === undefined) return {};
              // Read the capability at dispatch time: the upload and persistence
              // awaits above can span a server reconnect that changes it. Servers
              // from before inline context drop the records and forward the links
              // as literal text, so their turns carry the payload the legacy way.
              const supportsInlineMessageContext =
                appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment
                  .capabilities.inlineMessageContext === true;
              if (!supportsInlineMessageContext) {
                return {
                  text: serializeLegacyContextMessage({
                    text: outgoingMessageText,
                    records: context.records,
                  }),
                };
              }
              return { context };
            })(),
          },
          modelSelection: ctxSelectedModelSelection,
          ...(embedded?.keepTitle === true ? {} : { titleSeed: title }),
          runtimeMode,
          interactionMode: sendInteractionMode,
          dispatchMode: turnDispatchMode,
          ...(bootstrap ? { bootstrap } : {}),
          createdAt: messageCreatedAt,
        },
      });
      if (backgroundThreadRef) {
        markPromotedDraftThreadByRef(backgroundThreadRef);
        try {
          backgroundDraftOpened = Boolean(
            await handleNewThread(
              scopeProjectRef(activeProject.environmentId, activeProject.id),
              resolveBackgroundDraftWorkspaceOptions({
                envMode: sendEnvMode,
                branch: activeThreadBranch,
                startFromOrigin,
              }),
            ),
          );
        } catch (error) {
          clearBackgroundDraftSubmissionByRef(backgroundThreadRef);
          toastManager.add(
            stackedThreadToast({
              type: "warning",
              title: "Could not open a fresh composer",
              description: error instanceof Error ? error.message : undefined,
            }),
          );
        }
      }
      const startResult = await startPromise;
      settleProjectFolderLaunch?.(startResult._tag === "Success");
      if (startResult._tag === "Failure") {
        failure = startResult;
      } else {
        turnStartSucceeded = true;
        setKeepFullHistory(routeThreadKey, false);
        // The turn is under way and will spend quota, so that thread's limits
        // snapshot is stale. Uploads may have outlasted a navigation, so only
        // the sending thread's panel clears.
        clearUsageLimitsFor(routeThreadKey);
        if (turnUsesAttachmentUploads) {
          releaseDraftAttachments(composerAttachmentsSnapshot);
        }
        acknowledgeActiveThreadWoke();
        if (backgroundThreadRef) {
          if (backgroundDraftOpened || currentRouteThreadKeyRef.current !== routeThreadKey) {
            finalizePromotedDraftThreadByRef(backgroundThreadRef);
          } else {
            clearBackgroundDraftSubmissionByRef(backgroundThreadRef);
          }
          if (backgroundDraftOpened) {
            toastManager.add(
              stackedThreadToast({
                type: "success",
                title: "Started in background",
                timeout: 5_000,
                actionProps: {
                  children: "Open",
                  onClick: () => {
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: buildThreadRouteParams(backgroundThreadRef),
                    });
                  },
                },
              }),
            );
          }
        } else if (
          submissionIntent === "background" &&
          currentRouteThreadKeyRef.current === routeThreadKey
        ) {
          // An existing thread keeps running; open a fresh composer like a draft does.
          handleNewThreadInActiveProject();
        }
      }
    }

    if (failure !== null) {
      if (submissionIntent === "background" && draftId && draftThread) {
        restoreFailedBackgroundDraftThread(
          draftId,
          draftThread,
          wasBootstrapThreadDeleted(squashAtomCommandFailure(failure))
            ? newThreadId()
            : threadIdForSend,
        );
        clearBackgroundDraftSubmissionByRef(scopeThreadRef(environmentId, threadIdForSend));
      }
      if (
        backgroundDraftOpened
          ? !composerDraftHasUserContent(
              useComposerDraftStore.getState().getComposerDraft(composerDraftTarget),
            )
          : promptRef.current.length === 0 &&
            composerImagesRef.current.length === 0 &&
            composerFilesRef.current.length === 0 &&
            composerTerminalContextsRef.current.length === 0 &&
            (useComposerDraftStore.getState().getComposerDraft(composerDraftTarget)
              ?.previewAnnotations.length ?? 0) === 0 &&
            (useComposerDraftStore.getState().getComposerDraft(composerDraftTarget)?.reviewComments
              .length ?? 0) === 0 &&
            (useComposerDraftStore.getState().getComposerDraft(composerDraftTarget)?.threadContexts
              .length ?? 0) === 0
      ) {
        setOptimisticUserMessages((existing) => {
          const removed = existing.filter((message) => message.id === messageIdForSend);
          for (const message of removed) {
            revokeUserMessagePreviewUrls(message);
          }
          const next = existing.filter((message) => message.id !== messageIdForSend);
          return next.length === existing.length ? existing : next;
        });
        promptRef.current = messageTextForSend;
        const retryComposerImages = composerImagesSnapshot.map(cloneComposerImageForRetry);
        composerImagesRef.current = retryComposerImages;
        composerFilesRef.current = composerFilesSnapshot;
        composerTerminalContextsRef.current = composerTerminalContextsSnapshot;
        setComposerDraftPrompt(composerDraftTarget, messageTextForSend);
        addComposerDraftImages(composerDraftTarget, retryComposerImages);
        addComposerDraftFiles(composerDraftTarget, composerFilesSnapshot);
        setComposerDraftTerminalContexts(composerDraftTarget, composerTerminalContextsSnapshot);
        setComposerDraftPreviewAnnotations(composerDraftTarget, composerPreviewAnnotationsSnapshot);
        setComposerDraftReviewComments(composerDraftTarget, composerReviewCommentsSnapshot);
        setComposerDraftThreadContexts(composerDraftTarget, composerThreadContextsSnapshot);
        composerRef.current?.resetCursorState({
          cursor: collapseExpandedComposerCursor(messageTextForSend, messageTextForSend.length),
          prompt: messageTextForSend,
          detectTrigger: true,
        });
      }
      if (!isAtomCommandInterrupted(failure)) {
        const error = squashAtomCommandFailure(failure);
        setThreadError(
          threadIdForSend,
          error instanceof Error ? error.message : "Failed to send message.",
        );
        if (launchMachineForSend !== undefined && wasLaunchMachineOffline(error)) {
          toastManager.add({
            ...stackedThreadToast({
              type: "error",
              ...offlineLaunchToast(launchMachineForSend, routeThreadKey),
            }),
            id: `offline-launch:${routeThreadKey}`,
          });
        } else if (backgroundDraftOpened && draftId) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Background task failed",
              description: error instanceof Error ? error.message : "Failed to send message.",
              actionProps: {
                children: "Open draft",
                onClick: () => {
                  void navigate({ to: "/draft/$draftId", params: { draftId } });
                },
              },
            }),
          );
        }
      }
    }
    sendInFlightRef.current = false;
    setSetupQueueSendThreadKey((current) => (current === activeThreadKey ? null : current));
    if (!turnStartSucceeded) {
      setDockedDraftHeroThreadKey((currentThreadKey) =>
        currentThreadKey === activeThreadKey ? null : currentThreadKey,
      );
      if (!sendQueuesBehindSetup) resetLocalDispatch();
    }
  };

  const onRespondToApproval = async (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
  ) => {
    if (!activeThreadId || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope))
      return;
    if (
      pendingApprovals.find((approval) => approval.requestId === requestId)?.responseCapability !==
      "live"
    )
      return;

    setRespondingRequestIds((existing) =>
      existing.includes(requestId) ? existing : [...existing, requestId],
    );
    const result = await respondToThreadApproval({
      environmentId,
      input: {
        threadId: activeThreadId,
        requestId,
        decision,
      },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setThreadError(
        activeThreadId,
        error instanceof Error ? error.message : "Failed to submit approval decision.",
      );
    }
    setRespondingRequestIds((existing) => existing.filter((id) => id !== requestId));
    return result;
  };
  const onRespondToApprovalStable = useStableCallback(onRespondToApproval);

  const settleUserInputRequest = (requestId: RuntimeRequestId) =>
    setSettledUserInputRequestIds((existing) =>
      existing.has(requestId) ? existing : new Set([...existing, requestId]),
    );

  const onRespondToUserInput = async (
    requestId: RuntimeRequestId,
    answers: Record<string, unknown>,
  ) => {
    if (!activeThreadId || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope))
      return;
    const pendingInput = pendingUserInputs.find((input) => input.requestId === requestId);
    if (!pendingInput || pendingInput.responseCapability === "not_resumable") return;
    const responseKey = JSON.stringify([environmentId, activeThreadId, requestId]);
    if (userInputResponsesInFlight.current.has(responseKey)) return;
    const attachmentsByQuestionId = new Map<
      string,
      import("@cogenly/contracts").UserInputAttachments[string]
    >();
    const providerAnswers = { ...answers };
    for (const question of pendingInput.questions) {
      const target = questionAttachmentDraftId(
        environmentId,
        activeThreadId,
        requestId,
        question.id,
      );
      if ((useQuestionAttachmentPreparation.getState().counts[target] ?? 0) > 0) return;
      const draft = useComposerDraftStore.getState().getComposerDraft(target);
      providerAnswers[question.id] = projectPendingUserInputAnswer(
        answers[question.id],
        draft?.threadContexts ?? [],
      );
      const attachments = draft ? [...draft.images, ...draft.files] : [];
      if (attachments.length === 0) continue;
      const uploaded = getUploadedAttachments({ environmentId, images: attachments });
      if (!uploaded) {
        setThreadError(
          activeThreadId,
          "Wait for attachments to finish uploading, or remove failed uploads.",
        );
        return;
      }
      attachmentsByQuestionId.set(
        question.id,
        uploaded as import("@cogenly/contracts").UserInputAttachments[string],
      );
    }
    userInputResponsesInFlight.current.add(responseKey);

    setRespondingUserInputRequestIds((existing) =>
      existing.includes(requestId) ? existing : [...existing, requestId],
    );
    const result = await respondToThreadUserInput({
      environmentId,
      input: {
        threadId: activeThreadId,
        requestId,
        answers: providerAnswers,
        ...(attachmentsByQuestionId.size > 0
          ? { attachmentsByQuestionId: Object.fromEntries(attachmentsByQuestionId) }
          : {}),
      },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setThreadError(
        activeThreadId,
        error instanceof Error ? error.message : "Failed to submit user input.",
      );
    }
    if (result._tag === "Success") settleUserInputRequest(requestId);
    userInputResponsesInFlight.current.delete(responseKey);
    setRespondingUserInputRequestIds((existing) => existing.filter((id) => id !== requestId));
    return result;
  };

  // Closes an async question without messaging the agent. The server records
  // the dismissal so every client releases the composer.
  const onDismissUserInput = async (requestId: RuntimeRequestId) => {
    if (!activeThreadId) return;

    setRespondingUserInputRequestIds((existing) =>
      existing.includes(requestId) ? existing : [...existing, requestId],
    );
    const result = await dismissThreadUserInput({
      environmentId,
      input: { threadId: activeThreadId, requestId },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setThreadError(
        activeThreadId,
        error instanceof Error ? error.message : "Failed to dismiss the question.",
      );
    }
    if (result._tag === "Success") settleUserInputRequest(requestId);
    setRespondingUserInputRequestIds((existing) => existing.filter((id) => id !== requestId));
    return result;
  };
  const onDismissUserInputStable = useStableCallback(onDismissUserInput);

  const setActivePendingUserInputQuestionIndex = (nextQuestionIndex: number) => {
    if (!activePendingUserInput) {
      return;
    }
    setPendingUserInputQuestionIndexByRequestId((existing) => ({
      ...existing,
      [activePendingRequestKey]: nextQuestionIndex,
    }));
  };

  const onSelectActivePendingUserInputOption = (questionId: string, optionValue: string) => {
    if (!activePendingUserInput) {
      return;
    }
    // The option replaces the custom answer. Anything typed there is the
    // user's text, so it goes back to the thread draft instead of vanishing.
    const displacedAnswer =
      pendingUserInputAnswersByRequestId[activePendingRequestKey]?.[questionId]?.customAnswer;
    const currentPrompt =
      useComposerDraftStore.getState().getComposerDraft(composerDraftTarget)?.prompt ?? "";
    const nextPrompt = carryDisplacedCustomAnswerIntoPrompt(currentPrompt, displacedAnswer);
    if (nextPrompt !== currentPrompt) {
      setComposerDraftPrompt(composerDraftTarget, nextPrompt);
      if (activeThreadId) {
        const store = useComposerDraftStore.getState();
        const questionTarget = questionAttachmentDraftId(
          environmentId,
          activeThreadId,
          activePendingUserInput.requestId,
          questionId,
        );
        store.addThreadContexts(
          composerDraftTarget,
          store.getComposerDraft(questionTarget)?.threadContexts ?? [],
          { appendReference: false },
        );
      }
    }
    setPendingUserInputAnswersByRequestId((existing) => {
      const question =
        (activePendingProgress?.activeQuestion?.id === questionId
          ? activePendingProgress.activeQuestion
          : undefined) ?? activePendingUserInput.questions.find((entry) => entry.id === questionId);
      if (!question) {
        return existing;
      }

      return {
        ...existing,
        [activePendingRequestKey]: {
          ...existing[activePendingRequestKey],
          [questionId]: togglePendingUserInputOptionSelection(
            question,
            existing[activePendingRequestKey]?.[questionId],
            optionValue,
          ),
        },
      };
    });
    promptRef.current = "";
    composerRef.current?.resetCursorState({ cursor: 0 });
  };
  const onSelectActivePendingUserInputOptionStable = useStableCallback(
    onSelectActivePendingUserInputOption,
  );

  const onChangeActivePendingUserInputCustomAnswer = useStableCallback(
    (questionId: string, value: string) =>
      makePendingCustomAnswerSetter({
        activePendingUserInput,
        activePendingRequestKey,
        promptRef,
        setPendingUserInputAnswersByRequestId,
      })(questionId, value),
  );

  const onAdvanceActivePendingUserInput = () => {
    if (
      !activePendingUserInput ||
      activePendingUserInput.responseCapability === "not_resumable" ||
      !activePendingProgress
    ) {
      return;
    }
    if (activePendingProgress.isLastQuestion) {
      if (activePendingResolvedAnswers) {
        void onRespondToUserInput(activePendingUserInput.requestId, activePendingResolvedAnswers);
      }
      return;
    }
    setActivePendingUserInputQuestionIndex(activePendingProgress.questionIndex + 1);
  };
  const onAdvanceActivePendingUserInputStable = useStableCallback(onAdvanceActivePendingUserInput);

  const onPreviousActivePendingUserInputQuestion = () => {
    if (!activePendingProgress) {
      return;
    }
    setActivePendingUserInputQuestionIndex(Math.max(activePendingProgress.questionIndex - 1, 0));
  };
  const onPreviousActivePendingUserInputQuestionStable = useStableCallback(
    onPreviousActivePendingUserInputQuestion,
  );

  async function onSubmitPlanFollowUp({
    text,
    context,
    interactionMode: nextInteractionMode,
  }: {
    text: string;
    context?: ReturnType<typeof buildMessageContext>;
    interactionMode: "default" | "plan";
  }) {
    if (
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
      !activeThread ||
      !isServerThread ||
      isSendBusy ||
      isConnecting ||
      sendInFlightRef.current
    ) {
      return false;
    }

    const trimmed = text.trim();
    if (!trimmed) {
      return false;
    }

    const sendCtx = composerRef.current?.getSendContext();
    if (!sendCtx?.providerAvailable || !sendCtx.interactionModeEnabled) {
      return false;
    }
    const {
      selectedProvider: ctxSelectedProvider,
      selectedModel: ctxSelectedModel,
      selectedProviderModels: ctxSelectedProviderModels,
      selectedPromptEffort: ctxSelectedPromptEffort,
      selectedModelSelection: ctxSelectedModelSelection,
    } = sendCtx;

    const threadIdForSend = activeThread.id;
    const messageIdForSend = newMessageId();
    const messageCreatedAt = new Date().toISOString();
    const outgoingMessageText = formatOutgoingPrompt({
      provider: ctxSelectedProvider,
      model: ctxSelectedModel,
      models: ctxSelectedProviderModels,
      effort: ctxSelectedPromptEffort,
      text: trimmed,
    });

    sendInFlightRef.current = true;
    beginLocalDispatch({ preparingWorktree: false });
    setThreadError(threadIdForSend, null);

    // The sent row lands at the live end, above the composer.
    glideToEndForSend(
      scopedThreadKey(scopeThreadRef(activeThread.environmentId, threadIdForSend)),
      messageIdForSend,
    );

    setOptimisticUserMessages((existing) => [
      ...existing,
      {
        id: messageIdForSend,
        role: "user",
        text: outgoingMessageText,
        ...(context ? { context } : {}),
        runId: null,
        createdAt: messageCreatedAt,
        updatedAt: messageCreatedAt,
        streaming: false,
      },
    ]);

    const settingsResult = await persistThreadSettingsForNextTurn({
      threadId: threadIdForSend,
      createdAt: messageCreatedAt,
      ...(localCheckoutBranchMismatch ? { branch: localCheckoutBranchMismatch.currentBranch } : {}),
      runtimeMode,
      interactionMode: nextInteractionMode,
    });
    let failure: AtomCommandResult<unknown, unknown> | null =
      settingsResult._tag === "Failure" ? settingsResult : null;

    if (failure === null) {
      // Keep the mode toggle and plan-follow-up banner in sync immediately
      // while the same-thread implementation turn is starting.
      setComposerDraftInteractionMode(
        scopeThreadRef(activeThread.environmentId, threadIdForSend),
        nextInteractionMode,
      );

      const startResult = await startThreadTurn({
        environmentId,
        input: {
          threadId: threadIdForSend,
          message: {
            messageId: messageIdForSend,
            role: "user",
            text: outgoingMessageText,
            ...(context ? { context } : {}),
            attachments: [],
          },
          modelSelection: ctxSelectedModelSelection,
          titleSeed: activeThread.title,
          runtimeMode,
          interactionMode: nextInteractionMode,
          ...(nextInteractionMode === "default" && activeProposedPlan
            ? {
                sourceProposedPlan: {
                  threadId: activeThread.id,
                  planId: activeProposedPlan.id,
                },
              }
            : {}),
          createdAt: messageCreatedAt,
        },
      });
      failure = startResult._tag === "Failure" ? startResult : null;
    }

    if (failure === null) {
      sendInFlightRef.current = false;
      resetLocalDispatch();
      return true;
    }

    setOptimisticUserMessages((existing) =>
      existing.filter((message) => message.id !== messageIdForSend),
    );
    if (!isAtomCommandInterrupted(failure)) {
      const error = squashAtomCommandFailure(failure);
      setThreadError(
        threadIdForSend,
        error instanceof Error ? error.message : "Failed to send plan follow-up.",
      );
    }
    sendInFlightRef.current = false;
    resetLocalDispatch();
    return false;
  }

  const onImplementPlanInNewThread = async () => {
    if (
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
      !activeThread ||
      !activeProject ||
      !activeProposedPlan ||
      !isServerThread ||
      isSendBusy ||
      isConnecting ||
      activeEnvironmentUnavailable ||
      sendInFlightRef.current
    ) {
      return;
    }

    const sendCtx = composerRef.current?.getSendContext();
    if (!sendCtx?.providerAvailable || !sendCtx.interactionModeEnabled) {
      return;
    }
    const {
      selectedProvider: ctxSelectedProvider,
      selectedModel: ctxSelectedModel,
      selectedProviderModels: ctxSelectedProviderModels,
      selectedPromptEffort: ctxSelectedPromptEffort,
      selectedModelSelection: ctxSelectedModelSelection,
    } = sendCtx;

    const createdAt = new Date().toISOString();
    const nextThreadId = newThreadId();
    const planMarkdown = activeProposedPlan.planMarkdown;
    const implementationPrompt = buildPlanImplementationPrompt(planMarkdown);
    const outgoingImplementationPrompt = formatOutgoingPrompt({
      provider: ctxSelectedProvider,
      model: ctxSelectedModel,
      models: ctxSelectedProviderModels,
      effort: ctxSelectedPromptEffort,
      text: implementationPrompt,
    });
    const nextThreadTitle = truncate(buildPlanImplementationThreadTitle(planMarkdown));
    const nextThreadModelSelection: ModelSelection = ctxSelectedModelSelection;

    sendInFlightRef.current = true;
    beginLocalDispatch({ preparingWorktree: false });
    const finish = () => {
      sendInFlightRef.current = false;
      resetLocalDispatch();
    };

    const createResult = await createThread({
      environmentId,
      input: {
        // The implementation thread belongs where the plan was made.
        ...(activeThreadSurface ? { surface: activeThreadSurface } : {}),
        threadId: nextThreadId,
        projectId: activeProject.id,
        title: nextThreadTitle,
        modelSelection: nextThreadModelSelection,
        runtimeMode,
        interactionMode: "default",
        branch: activeThreadBranch,
        worktreePath: activeThread.worktreePath,
        createdAt,
      },
    });
    let failure: AtomCommandResult<unknown, unknown> | null =
      createResult._tag === "Failure" ? createResult : null;

    if (failure === null) {
      const startResult = await startThreadTurn({
        environmentId,
        input: {
          threadId: nextThreadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: outgoingImplementationPrompt,
            attachments: [],
          },
          modelSelection: ctxSelectedModelSelection,
          titleSeed: nextThreadTitle,
          runtimeMode,
          interactionMode: "default",
          sourceProposedPlan: {
            threadId: activeThread.id,
            planId: activeProposedPlan.id,
          },
          createdAt,
        },
      });
      failure = startResult._tag === "Failure" ? startResult : null;
    }

    if (failure === null) {
      const startedResult = await settlePromise(() =>
        waitForStartedServerThread(scopeThreadRef(activeThread.environmentId, nextThreadId)),
      );
      failure = startedResult._tag === "Failure" ? startedResult : null;
    }

    if (failure === null) {
      const navigateResult = await settlePromise(() =>
        navigate({
          to: "/$environmentId/$threadId",
          params: {
            environmentId: activeThread.environmentId,
            threadId: nextThreadId,
          },
        }),
      );
      failure = navigateResult._tag === "Failure" ? navigateResult : null;
    }

    if (failure !== null) {
      const cleanupResult = await deleteThread({
        environmentId,
        input: {
          threadId: nextThreadId,
        },
      });
      if (cleanupResult._tag === "Failure" && !isAtomCommandInterrupted(cleanupResult)) {
        console.warn(
          "Failed to clean up implementation thread after start failure.",
          squashAtomCommandFailure(cleanupResult),
        );
      }
      if (!isAtomCommandInterrupted(failure)) {
        const error = squashAtomCommandFailure(failure);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not start implementation thread",
            description:
              error instanceof Error
                ? error.message
                : "An error occurred while creating the new thread.",
          }),
        );
      }
    }
    finish();
  };
  const onImplementPlanInNewThreadStable = useStableCallback(onImplementPlanInNewThread);

  const getModelDisabledReason = useMemo(
    () =>
      makeModelDisabledReason(
        activeThread
          ? {
              providers: providerStatuses,
              hasStartedSession: activeRuntime !== null,
              supportsProviderSwitchingViaHandoff,
              currentModelSelection: activeThread.modelSelection,
              currentProviderInstanceId: activeRuntime?.providerInstanceId ?? null,
            }
          : null,
      ),
    [activeRuntime, activeThread, providerStatuses, supportsProviderSwitchingViaHandoff],
  );

  const onProviderModelSelect = (
    instanceId: ProviderInstanceId,
    model: string,
    options?: { focusComposer?: boolean },
  ) => {
    if (!activeThread) return;
    // Look up the configured instance so model normalization and custom
    // model lookup stay scoped to that exact instance. Unknown instance ids
    // are rejected by returning early; the server remains authoritative too.
    const entry = providerStatuses.find((snapshot) => snapshot.instanceId === instanceId);
    const resolvedDriverKind = entry?.driver ?? null;
    if (
      !supportsProviderSwitchingViaHandoff &&
      lockedProvider !== null &&
      resolvedDriverKind !== null &&
      resolvedDriverKind !== lockedProvider
    ) {
      if (options?.focusComposer !== false) scheduleComposerFocus();
      return;
    }
    if (
      !supportsProviderSwitchingViaHandoff &&
      lockedProvider !== null &&
      activeRuntime?.providerInstanceId
    ) {
      const currentEntry = providerStatuses.find(
        (snapshot) => snapshot.instanceId === activeRuntime.providerInstanceId,
      );
      if (
        currentEntry?.continuation?.groupKey &&
        entry?.continuation?.groupKey &&
        currentEntry.continuation.groupKey !== entry.continuation.groupKey
      ) {
        if (options?.focusComposer !== false) scheduleComposerFocus();
        return;
      }
    }
    const resolvedModel = resolveAppModelSelectionForInstance(
      instanceId,
      settings,
      providerStatuses,
      model,
    );
    if (!resolvedModel) {
      if (options?.focusComposer !== false) scheduleComposerFocus();
      return;
    }
    // Restore this model's own remembered options; without any, start it
    // from its default rather than carrying the previous model's over.
    const rememberedOptions =
      useComposerDraftStore.getState().stickyOptionsByModelByProvider[instanceId]?.[resolvedModel];
    const nextModelSelection: ModelSelection =
      rememberedOptions !== undefined && rememberedOptions.length > 0
        ? { instanceId, model: resolvedModel, options: [...rememberedOptions] }
        : { instanceId, model: resolvedModel };
    const modelChangeBlockReason = getStartedThreadModelChangeBlockReason({
      providers: providerStatuses,
      hasStartedSession: activeRuntime !== null,
      supportsProviderSwitchingViaHandoff,
      currentModelSelection: activeThread.modelSelection,
      currentProviderInstanceId: activeRuntime?.providerInstanceId ?? null,
      nextModelSelection,
    });
    if (modelChangeBlockReason) {
      toastManager.add({
        type: "warning",
        title: modelChangeBlockReason.title,
        description: modelChangeBlockReason.description,
      });
      if (options?.focusComposer !== false) scheduleComposerFocus();
      return;
    }
    setComposerDraftModelSelection(
      scopeThreadRef(activeThread.environmentId, activeThread.id),
      nextModelSelection,
      // A complete snapshot: an absent options field means "start from the
      // model default", not "keep the previous model's options".
      { explicit: true, replaceOptions: true },
    );
    setStickyComposerModelSelection(nextModelSelection);
    if (options?.focusComposer !== false) scheduleComposerFocus();
  };
  const onProviderModelSelectStable = useStableCallback(onProviderModelSelect);
  const onEnvModeChange = (mode: DraftThreadEnvMode) => {
    if (multipleModelSelections !== null) return;
    if (canOverrideServerThreadEnvMode) {
      setPendingServerThreadEnvMode(mode);
      scheduleComposerFocus();
      return;
    }
    if (isLocalDraftThread) {
      setDraftThreadContext(composerDraftTarget, {
        envMode: mode,
        startFromOrigin: resolveNewDraftStartFromOrigin({
          envMode: mode,
          newWorktreesStartFromOrigin: activeProjectSettings.settings.newWorktreesStartFromOrigin,
        }),
        ...(mode === "worktree" && draftThread?.worktreePath ? { worktreePath: null } : {}),
      });
    }
    scheduleComposerFocus();
  };
  const onEnvModeChangeStable = useStableCallback(onEnvModeChange);

  // "Work locally" on the setup card: cancel the bootstrap and remember the
  // draft. The cancelled dispatch deletes the half-made thread and puts the
  // message back in the composer; the effect below then flips the draft to
  // local mode and resends. The draft is a server thread for the whole
  // setup (the bootstrap created it), so this keys off the route, not
  // `isLocalDraftThread`.
  const onWorktreeSetupWorkLocally = () => {
    if (!worktreeSetup || worktreeSetup.phase !== "running" || !draftId) {
      return;
    }
    const target = {
      environmentId: setupTarget.environmentId,
      input: { threadId: worktreeSetup.threadId },
    };
    void (async () => {
      const result = await cancelWorktreeSetup(target);
      if (result._tag !== "Success" || !result.value.cancelled) return;
      setWorkLocallyResendDraftId(draftId);
    })();
  };
  const onWorktreeSetupWorkLocallyStable = useStableCallback(onWorktreeSetupWorkLocally);
  const onComposerSendStable = useStableCallback(onSend);
  useLayoutEffect(() => {
    resendRef.current = () => void onComposerSendStable();
  }, [onComposerSendStable]);
  const onComposerResumeStable = useStableCallback(onResume);
  const onComposerCompactContextStable = useStableCallback(onCompactContext);
  const addWorkspaceDroppedFilesStable = useStableCallback((files: File[]) =>
    composerRef.current?.addDroppedFiles(files),
  );
  const addWorkspaceDroppedFoldersStable = useStableCallback((folders: File[]) =>
    composerRef.current?.addDroppedFolders(folders),
  );
  const queuedRunsControl = useMemo(
    () =>
      isServerThread && activeThread ? (
        <QueuedRunsControl
          ref={queuedRunsControlRef}
          steerShortcutLabel={shortcutLabelForCommand(keybindings, "thread.steerQueuedMessage", {
            context: { terminalFocus: false },
          })}
          editShortcutLabel={shortcutLabelForCommand(keybindings, "thread.editQueuedMessage", {
            context: { composerFocus: true },
          })}
          sendAllShortcutLabel={shortcutLabelForCommand(
            keybindings,
            "thread.sendAllQueuedMessages",
          )}
          environmentId={activeThread.environmentId}
          threadId={activeThread.id}
          optimisticMessages={optimisticUserMessages}
          editingRunId={editingQueuedRun?.runId ?? null}
          onEditQueuedRun={beginEditingQueuedRunStable}
          onCancelEdit={cancelEditingQueuedRunStable}
        />
      ) : null,
    [
      activeThread,
      beginEditingQueuedRunStable,
      cancelEditingQueuedRunStable,
      editingQueuedRun?.runId,
      isServerThread,
      keybindings,
      optimisticUserMessages,
    ],
  );
  // Resend once the cancelled dispatch has settled and the composer is free.
  // Every state that makes `onSend` bail and wait is part of the readiness
  // check, so the flag survives a reconnect, a reverting checkpoint, or a
  // feedback upload in between. What remains inside `onSend` are the checks
  // that need the user to change something, and those should not auto retry.
  const workLocallyResendReady =
    workLocallyResendDraftId !== null &&
    workLocallyResendDraftId === draftId &&
    isLocalDraftThread &&
    !isSendBusy &&
    !isConnecting &&
    !isRevertingCheckpoint &&
    !threadDetailLoading &&
    clientSettingsHydrated &&
    !needsLoadBalancing &&
    !activeEnvironmentUnavailable &&
    !activePendingProgress &&
    !feedbackUploading;
  useEffect(() => {
    if (
      !workLocallyResendReady ||
      sendInFlightRef.current ||
      feedbackUploadsInFlightRef.current.has(routeThreadKey)
    ) {
      return;
    }
    if (sendEnvMode !== "local") {
      // The draft is back; switch it to the project checkout and let the next
      // render resend.
      setDraftThreadContext(composerDraftTarget, { envMode: "local", startFromOrigin: false });
      return;
    }
    setWorkLocallyResendDraftId(null);
    void onComposerSendStable();
  }, [
    composerDraftTarget,
    routeThreadKey,
    sendEnvMode,
    setDraftThreadContext,
    workLocallyResendReady,
  ]);

  const onStartFromOriginChange = (nextStartFromOrigin: boolean) => {
    if (canOverrideServerThreadEnvMode && activeThread) {
      setPendingServerThreadStartFromOriginByThreadId((current) =>
        current[activeThread.id] === nextStartFromOrigin
          ? current
          : { ...current, [activeThread.id]: nextStartFromOrigin },
      );
      return;
    }
    if (isLocalDraftThread) {
      setDraftThreadContext(composerDraftTarget, {
        startFromOrigin: nextStartFromOrigin,
      });
    }
  };

  const onExpandTimelineImage = (preview: ExpandedImagePreview) => {
    setExpandedImage(preview);
  };
  const onExpandTimelineImageStable = useStableCallback(onExpandTimelineImage);
  const onTimelineRollbackCheckpoint = (input: {
    readonly checkpointId: string;
    readonly scopeId: string;
  }) => {
    if (!paintOnlyDisplayedTimeline) void onRollbackCheckpoint(input);
  };
  const onTimelineRollbackCheckpointStable = useStableCallback(onTimelineRollbackCheckpoint);
  // Stable, so it never busts TimelineRowCtx identity.
  const onRevertTimelineTurn = (targetTurnCount: number, messageId: MessageId) => {
    void onRevertToTurnCountStable(targetTurnCount, messageId);
  };
  const onRevertTimelineTurnStable = useStableCallback(onRevertTimelineTurn);

  const pendingSidebarFileDrops = useSidebarPendingFileDropStore((state) => state.pending);
  const consumePendingFileDrop = useSidebarPendingFileDropStore(
    (state) => state.consumePendingFileDrop,
  );
  useEffect(() => {
    if (pendingSidebarFileDrops.length === 0) return;
    if (
      typeof composerDraftTarget === "string" ||
      !pendingSidebarFileDrops.some((drop) =>
        isSameSidebarThreadRef(composerDraftTarget, drop.threadRef),
      )
    ) {
      return;
    }
    if (!activeThread) return;
    if (!composerRef.current) {
      const raf = window.requestAnimationFrame(() => {
        if (!composerRef.current || typeof composerDraftTarget === "string") return;
        const files = consumePendingFileDrop(composerDraftTarget);
        if (files !== null) composerRef.current?.addDroppedFiles(files);
      });
      return () => window.cancelAnimationFrame(raf);
    }
    const files = consumePendingFileDrop(composerDraftTarget);
    if (files !== null) composerRef.current.addDroppedFiles(files);
  }, [
    activeThread,
    composerDraftTarget,
    composerRef,
    consumePendingFileDrop,
    pendingSidebarFileDrops,
  ]);

  // Empty state: no active thread
  if (!activeThread) {
    return <NoActiveThreadState />;
  }

  const rightPanelContent = activeThreadRef ? (
    renderedRightPanelSurface?.kind === "preview" ? (
      <Suspense fallback={null}>
        <PreviewPanel
          mode="embedded"
          threadRef={activeThreadRef}
          tabId={renderedRightPanelSurface.resourceId}
          configuredUrls={configuredPreviewUrls}
          visible={rightPanelOpen}
          onSendAnnotation={(annotation, image) => {
            void onSend(undefined, "auto", "foreground", { annotation, image });
          }}
        />
      </Suspense>
    ) : renderedRightPanelSurface?.kind === "device" ? (
      <Suspense fallback={null}>
        <DevicePanel
          mode="embedded"
          threadRef={activeThreadRef}
          key={renderedRightPanelSurface.id}
          surface={renderedRightPanelSurface}
          visible={rightPanelOpen}
          onOpenSetup={() => setDeviceSetupThread(activeThreadRef)}
        />
      </Suspense>
    ) : (renderedRightPanelSurface?.kind === "files" ||
        renderedRightPanelSurface?.kind === "file") &&
      ((activeProject && activeWorkspaceRoot) ||
        (renderedRightPanelSurface.kind === "file" && renderedRightPanelSurface.attachment)) ? (
      <Suspense fallback={null}>
        <FilePreviewPanel
          key={`${activeThread.environmentId}:${
            renderedRightPanelSurface.kind === "file" && renderedRightPanelSurface.attachment
              ? `attachment:${renderedRightPanelSurface.attachment.id}`
              : activeWorkspaceRoot
          }`}
          environmentId={activeThread.environmentId}
          cwd={activeWorkspaceRoot ?? ""}
          projectName={activeProject?.title ?? ""}
          threadRef={activeThreadRef}
          composerDraftTarget={composerDraftTarget}
          keybindings={keybindings}
          relativePath={
            renderedRightPanelSurface.kind === "file"
              ? renderedRightPanelSurface.relativePath
              : null
          }
          {...(renderedRightPanelSurface.kind === "file" && renderedRightPanelSurface.attachment
            ? { attachment: renderedRightPanelSurface.attachment }
            : {})}
          revealLine={
            renderedRightPanelSurface.kind === "file"
              ? (renderedRightPanelSurface.revealLine ?? null)
              : null
          }
          revealRequestId={
            renderedRightPanelSurface.kind === "file"
              ? renderedRightPanelSurface.revealRequestId
              : 0
          }
          onOpenFile={openFileSurfaceStable}
          onNavigateFolder={(relativePath, folderTrail, keepSource) =>
            useRightPanelStore
              .getState()
              .navigateFolder(
                activeThreadRef,
                renderedRightPanelSurface.id,
                relativePath,
                folderTrail,
                keepSource,
              )
          }
          folderTrail={renderedRightPanelSurface.folderTrail}
          onPendingChange={handleFilePendingChangeStable}
          selectedFilePending={
            renderedRightPanelSurface.kind === "file" &&
            pendingFileSurfaceIds.has(renderedRightPanelSurface.id)
          }
          workspaceMutationId={workspaceMutationId}
        />
      </Suspense>
    ) : null
  ) : null;
  // What the strip's "+" offers, one entry per kind of tab the thread can
  // hold. A kind the thread cannot offer at all is left out; one it offers
  // but cannot open right now is listed greyed, with the reason.
  const rightPanelAddOptions: RightPanelAddOption[] = [
    {
      offered: activeThreadCapabilities.browser,
      kind: "browser" as const,
      available: canOperatePreview && browserAvailable,
      unavailableLabel: "Browser previews are only available in the Cogenly desktop app.",
      shortcutLabel: shortcutLabelForCommand(keybindings, "rightPanel.new"),
      onSelect: () => createBrowserSurface(),
      onSelectInProfile: createBrowserSurfaceStable,
    },
    {
      offered: activeThreadCapabilities.device,
      kind: "device" as const,
      available: true,
      unavailableLabel: "Devices are only available from a thread.",
      shortcutLabel: null,
      onSelect: addDeviceSurface,
      deviceMenu: {
        ...deviceAddMenu,
        onSetup: () => setDeviceSetupThread(activeThreadRef),
      },
    },
    {
      offered: activeThreadCapabilities.files,
      kind: "files" as const,
      available: activeProject !== null,
      unavailableLabel: "Files are only available from a repository thread.",
      shortcutLabel: null,
      onSelect: openFilesSurface,
    },
  ].flatMap(({ offered, ...option }) => (offered ? [option] : []));
  const panelToggleControlProps = {
    rightPanelAvailable: activeProject !== null,
    rightPanelOpen,
    rightPanelShortcutLabel: shortcutLabelForCommand(keybindings, "rightPanel.toggle"),
    onToggleRightPanel: toggleRightPanelStable,
    ...(bottomPanelAvailable
      ? {
          bottomPanel: {
            open: bottomPanelOpen,
            shortcutLabel: shortcutLabelForCommand(keybindings, "terminal.toggle"),
            onToggle: toggleBottomPanelStable,
          },
        }
      : {}),
  } satisfies PanelLayoutControlsProps;
  // Pinned at the window's top-right, open or closed, beside maximize. Open,
  // that corner is the panel's tab strip, whose "+" chooses what to show.
  const panelToggleControls = <PanelLayoutControls {...panelToggleControlProps} />;
  // Thread details sits just left of the right-panel toggle. While the titlebar
  // cluster floats over this header it joins the cluster; once the toggle moves
  // over an open panel, it stays at the chat header's right edge instead.
  const threadDetailsControl =
    isServerThread && activeThreadRef ? (
      <ThreadDetailsMenu
        environmentId={activeThreadRef.environmentId}
        threadId={activeThreadRef.threadId}
      />
    ) : null;
  const threadDetailsInTitlebarCluster =
    (rightPanelControlsAtRoot && !rightPanelOpen) ||
    (!rightPanelControlsAtRoot && !rightPanelControlsInPanel && rightPanelSupported);
  const panelLayoutControls = (
    <div
      className={cn(
        // Keep one viewport anchor inside the header's no-drag region. The
        // header can shrink behind the right panel without moving the controls.
        "pointer-events-none fixed top-[var(--workspace-controls-top)] right-[var(--workspace-controls-right)] z-50 mr-px flex h-[var(--workspace-topbar-height)] items-center gap-1 [-webkit-app-region:no-drag]",
      )}
      data-workspace-titlebar-controls
    >
      {!shouldUsePlanSidebarSheet ? (
        <span
          aria-hidden={!rightPanelOpen}
          className={cn(
            "flex shrink-0",
            // Fades only where the layout lets panels animate, read from its
            // attribute so a navigation's first frame never re-renders this view.
            "in-data-[panel-animations=true]:motion-safe:transition-opacity in-data-[panel-animations=true]:motion-safe:duration-(--panel-animation-duration) in-data-[panel-animations=true]:motion-safe:ease-out",
            // Closed, the control leaves the flex flow so the cluster is only as wide as the two
            // toggles the header reserves room for; anchored to the cluster's left edge, it fades
            // out where it stood rather than over the terminal toggle.
            rightPanelOpen
              ? "pointer-events-auto opacity-100"
              : "pointer-events-none absolute right-full mr-1 opacity-0",
          )}
          inert={!rightPanelOpen}
        >
          <RightPanelMaximizeControl
            maximized={rightPanelMaximized}
            onToggle={toggleRightPanelMaximizedStable}
          />
        </span>
      ) : null}
      {threadDetailsControl && threadDetailsInTitlebarCluster ? (
        <span key="cluster" className="swap-motion pointer-events-auto flex h-full items-center">
          {threadDetailsControl}
        </span>
      ) : null}
      <div className="pointer-events-auto flex h-full items-center">{panelToggleControls}</div>
    </div>
  );
  const workspaceFileDropHandlers = makeWorkspaceFileDropHandlers({
    setDragActive: setIsWorkspaceFileDragActive,
    addFiles: addWorkspaceDroppedFilesStable,
    addFolders: addWorkspaceDroppedFoldersStable,
  });

  const content = (
    <div
      ref={setWorkspaceLayoutElement}
      // Clips vertically only: content gliding in from where it was drawn
      // (panelFlip) may cross the pane's new left edge while the sidebar opens.
      // The sidebar wrapper clips at the window's edges.
      className="relative flex min-h-0 min-w-0 flex-1 overflow-y-clip bg-background"
    >
      <Dialog
        open={
          deviceSetupThread !== null &&
          deviceSetupThread.environmentId === activeThreadRef?.environmentId &&
          deviceSetupThread.threadId === activeThreadRef?.threadId
        }
        onOpenChange={(open) => {
          if (!open) setDeviceSetupThread(null);
        }}
      >
        <WizardPopup>
          {activeThreadRef ? (
            <DeviceSetup environmentId={activeThreadRef.environmentId} state={deviceState} />
          ) : null}
        </WizardPopup>
      </Dialog>
      {rightPanelControlsAtRoot ? panelLayoutControls : null}
      <div
        className={cn(
          // isolate keeps the chat's raised overlays under the right panel, so
          // content gliding beside a sliding panel passes beneath it unclipped.
          "relative isolate flex min-h-0 min-w-0 flex-col",
          rightPanelMaximized ? "w-0 flex-none overflow-x-hidden" : "flex-1",
        )}
        data-chat-column-maximized-away={rightPanelMaximized ? "true" : "false"}
      >
        {/* Top bar. It floats over the transcript, which scrolls up under it and
            fades out across its height (.messages-timeline-scroll) behind a
            progressive blur (header-scroll-blur), so it reserves no dead band
            and has no fill of its own. On desktop it stays the
            window's drag region and keeps clear of the traffic lights; in the
            browser it lets pointer events through to the transcript except on
            its controls. */}
        <header
          data-chat-header
          className={cn(
            "header-scroll-blur relative z-30",
            embedded && "hidden",
            !isElectron && "pointer-events-none *:pointer-events-auto",
            isElectron
              ? cn(
                  "drag-region flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center px-3 sm:px-5",
                  reserveTitleBarControlInset &&
                    !inlineRightPanelOwnsTitleBar &&
                    "wco:pr-(--workspace-native-controls-inset)",
                )
              : "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center pl-(--workspace-gutter-start) pr-(--workspace-gutter-end)",
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
        >
          {isElectron && rightPanelControlsAtRoot ? (
            <span
              aria-hidden
              className="pointer-events-none fixed top-[var(--workspace-controls-top)] right-[var(--workspace-controls-right)] h-[var(--workspace-topbar-height)] w-28 [-webkit-app-region:no-drag]"
            />
          ) : null}
          {!rightPanelControlsAtRoot && !rightPanelControlsInPanel && rightPanelSupported
            ? panelLayoutControls
            : null}
          {/* The title stays visible whether or not the sidebar shows the
              thread; a draft has none yet, so its heading is for screen readers. */}
          {isServerThread ? (
            <ThreadHeaderTitle
              shell={activeThreadShell}
              title={activeThread.title}
              messagesCarried={workHandoffMessagesCarried}
              onOpenThread={onOpenRelatedThreadStable}
            />
          ) : (
            <h2 className="sr-only">{activeThread.title}</h2>
          )}
          {isServerThread && activeThreadShell ? (
            <ThreadOwnerBadge
              environmentId={activeThreadShell.environmentId}
              ownerMachine={activeThreadShell.source.ownerMachine}
            />
          ) : null}
          {threadDetailsControl && !threadDetailsInTitlebarCluster ? (
            <span key="header" className="swap-motion ms-auto flex h-full shrink-0 items-center">
              {threadDetailsControl}
            </span>
          ) : null}
        </header>

        {/* Main content area with optional plan sidebar. Its centered lane
            glides to its new center when a panel opens or closes (panelFlip). */}
        <div
          className="relative flex min-h-0 min-w-0 flex-1"
          data-panel-flip="center"
          data-chat-header-overlap={embedded ? undefined : true}
        >
          {/* Chat column */}
          <ThreadFindCanvas
            findOptions={{
              skills: timelineSkills,
              progressive: serverConfig?.threadFindProgressive === true,
              thread: activeThreadRef,
              enabled:
                isServerThread && serverConfig?.threadFind === true && !paintOnlyDisplayedTimeline,
              content: serverProjection ?? undefined,
            }}
            controlsRef={threadFindControlsRef}
            onOpenChange={setIsThreadFindActive}
            data-chat-workspace-drop-target="true"
            onDragEnter={workspaceFileDropHandlers.onDragEnter}
            onDragOver={workspaceFileDropHandlers.onDragOver}
            onDragLeave={workspaceFileDropHandlers.onDragLeave}
            onDrop={workspaceFileDropHandlers.onDrop}
          >
            <ThreadFind onClose={focusComposerStable} />
            {isServerThread && activeThreadRef && !embedded ? (
              <ThreadDetailsDock
                environmentId={activeThreadRef.environmentId}
                threadId={activeThreadRef.threadId}
                rightPanelOpen={rightPanelOpen}
                findOpen={isThreadFindActive}
              />
            ) : null}
            {isWorkspaceFileDragActive ? (
              <div
                className="pointer-events-none absolute inset-2 z-40 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/60 bg-primary/[0.035]"
                data-chat-workspace-drop-overlay="true"
              >
                <div
                  role="status"
                  className="flex items-center gap-2 rounded-full border border-primary/25 bg-background/95 px-4 py-2.5 text-sm font-medium text-foreground shadow-lg"
                >
                  <PaperclipIcon className="size-4 text-primary" aria-hidden="true" />
                  Drop files to attach
                </div>
              </div>
            ) : null}
            {/* Banners overlay the timeline without changing its content height. */}
            <div className="chat-banner-lane pointer-events-none absolute top-0 z-20 flex flex-col">
              <ProviderStatusBanner
                status={visibleProviderStatus}
                onDismiss={() => setDismissedProviderStatusBannerKey(providerStatusBannerKey)}
                onOpenProviderSetup={openProviderSetupStable}
              />
            </div>
            {/* Thread errors surface as top toasts, above the header. */}
            <ThreadErrorToast
              threadRef={routeThreadRef}
              error={timelineThreadError}
              errorClass={
                localServerError === null && visibleThreadError === serverRuntime?.lastError
                  ? (serverRuntime?.lastErrorClass ?? null)
                  : null
              }
              onDismiss={() => {
                setThreadError(activeThread.id, null);
                dismissThreadErrorBannerForSession(threadErrorBannerKey);
                setThreadErrorBannerDismissTick((tick) => tick + 1);
              }}
            />
            {/* Messages Wrapper */}
            <div className="relative flex min-h-0 flex-1 flex-col bg-background">
              {/* Messages — LegendList handles virtualization and scrolling internally */}
              <WorkHandoffMarkersProvider
                environmentId={activeThreadShell?.environmentId ?? null}
                anchors={paintOnlyDisplayedTimeline ? null : workHandoffAnchors}
                tasks={paintOnlyDisplayedTimeline ? null : workTaskAnchors}
                onOpenThread={onOpenRelatedThreadStable}
              >
                <MessagesTimeline
                  citationRequest={paintOnlyDisplayedTimeline ? null : citationRequest}
                  citationHistoryLoading={threadDetailLoading}
                  {...(!paintOnlyDisplayedTimeline
                    ? {
                        onCiteAssistantText: citeAssistantTextStable,
                      }
                    : {})}
                  isWorking={!paintOnlyDisplayedTimeline && isWorking}
                  runlessWorkActive={runlessWorkStartedAt !== null}
                  activeTurnInProgress={
                    !paintOnlyDisplayedTimeline && (isWorking || !latestRunSettled)
                  }
                  isCompacting={!paintOnlyDisplayedTimeline && isCompacting}
                  awaitingUser={
                    !paintOnlyDisplayedTimeline &&
                    (activePendingApproval !== null ||
                      activePendingUserInput !== null ||
                      // A secret request has no runtime request; the shell carries it.
                      activeThreadShell?.hasPendingUserInput === true)
                  }
                  activeTurnStartedAt={paintOnlyDisplayedTimeline ? null : activeWorkStartedAt}
                  worktreeSetup={paintOnlyDisplayedTimeline ? null : worktreeSetup}
                  onCancelWorktreeSetup={onCancelWorktreeSetupStable}
                  {...(paintOnlyDisplayedTimeline
                    ? {}
                    : {
                        retryableWorkspacePreparationRunIds,
                        onRetryWorkspacePreparation: onRetryWorkspacePreparationStable,
                      })}
                  {...(draftId
                    ? { onWorktreeSetupWorkLocally: onWorktreeSetupWorkLocallyStable }
                    : {})}
                  {...(onOpenWorktreeSetupTerminal ? { onOpenWorktreeSetupTerminal } : {})}
                  {...(bottomPanelAvailable ? { onShowTerminalRun: showTerminalRunStable } : {})}
                  isPreparingWorktree={!paintOnlyDisplayedTimeline && isPreparingWorktree}
                  footer={
                    paintOnlyDisplayedTimeline ? null : pendingHandoff === null ? (
                      threadFooterLines
                    ) : (
                      <>
                        <div className="chat-content-lane">
                          <HandoffRow
                            endpoints={pendingHandoff}
                            providers={providerStatuses}
                            pending
                          />
                        </div>
                        {threadFooterLines}
                      </>
                    )
                  }
                  listRef={legendListRef}
                  timelineEntries={displayedTimeline.entries}
                  providerStatuses={
                    environmentById.get(
                      displayedThreadRef?.environmentId ?? activeThread.environmentId,
                    )?.serverConfig?.providers ?? EMPTY_PROVIDERS
                  }
                  runs={paintOnlyDisplayedTimeline ? [] : (serverProjection?.runs ?? [])}
                  latestRun={paintOnlyDisplayedTimeline ? null : activeActivityRun}
                  runningRunId={paintOnlyDisplayedTimeline ? null : activeRunningTurnId}
                  turnDiffSummaries={
                    paintOnlyDisplayedTimeline ? EMPTY_HELD_TURN_DIFF_SUMMARIES : turnDiffSummaries
                  }
                  activeThreadEnvironmentId={
                    displayedThreadRef?.environmentId ?? activeThread.environmentId
                  }
                  routeThreadKey={displayedTimelineKey}
                  displayThreadKey={displayedTimelineKey}
                  paintOnly={paintOnlyDisplayedTimeline}
                  onOpenThread={onOpenRelatedThreadStable}
                  onForkFromRun={paintOnlyDisplayedTimeline ? async () => {} : onForkFromRunStable}
                  onRollbackCheckpoint={onTimelineRollbackCheckpointStable}
                  supportsConversationRollback={
                    !paintOnlyDisplayedTimeline && supportsConversationRollback
                  }
                  onRevertToTurnCount={
                    paintOnlyDisplayedTimeline ? noopHeldRevert : onRevertTimelineTurnStable
                  }
                  {...(!paintOnlyDisplayedTimeline
                    ? {
                        onUseArtifactTemplate: useArtifactTemplateStable,
                        onSendAppMessage: sendAppMessageStable,
                      }
                    : {})}
                  isRevertingCheckpoint={isRevertingCheckpoint}
                  onImageExpand={onExpandTimelineImageStable}
                  onFileOpen={
                    paintOnlyDisplayedTimeline ? noopHeldAttachment : openFileAttachmentStable
                  }
                  onFileDownload={
                    paintOnlyDisplayedTimeline ? noopHeldAttachment : downloadFileAttachmentStable
                  }
                  markdownCwd={
                    paintOnlyDisplayedTimeline
                      ? (heldPaintContext?.markdownCwd ?? undefined)
                      : (gitCwd ?? undefined)
                  }
                  resolvedTheme={resolvedTheme}
                  timestampFormat={timestampFormat}
                  workspaceRoot={
                    paintOnlyDisplayedTimeline
                      ? (heldPaintContext?.workspaceRoot ?? undefined)
                      : activeWorkspaceRoot
                  }
                  skills={timelineSkills}
                  sendGlideActive={
                    !paintOnlyDisplayedTimeline &&
                    sendGlideThreadKey !== null &&
                    sendGlideThreadKey === activeThreadKey
                  }
                  contentInsetEndAdjustment={composerTimelineInset}
                  liveFollowEnabled={!paintOnlyDisplayedTimeline && timelineLiveFollowEnabled}
                  onIsAtEndChange={onIsAtEndChangeStable}
                  onManualNavigation={cancelTimelineLiveFollowForUserNavigationStable}
                  cancelPositionRestoreRef={cancelPositionRestoreRef}
                  hideEmptyPlaceholder={
                    isDraftHeroState ||
                    threadDetailLoading ||
                    embedded?.renderEmptyState !== undefined
                  }
                  loadingThread={threadDetailLoading && !isDraftHeroState}
                  topFadeEnabled={!hasTimelineTopBanner}
                  {...(paintOnlyDisplayedTimeline || threadHistoryControls === undefined
                    ? {}
                    : { historyControls: threadHistoryControls })}
                />
              </WorkHandoffMarkersProvider>
              {embedded?.renderEmptyState ? (
                <div
                  className="absolute inset-x-0 top-0 z-10 flex flex-col overflow-y-auto transition-opacity duration-(--motion-duration-base) ease-standard data-hidden:pointer-events-none data-hidden:opacity-0"
                  style={{ bottom: composerTimelineInset }}
                  data-hidden={embeddedEmptyStateVisible ? undefined : ""}
                  inert={!embeddedEmptyStateVisible}
                >
                  {embedded.renderEmptyState({ fill: fillEmbeddedComposer })}
                </div>
              ) : null}

              {/* Scroll-to-end button: shown once the reader leaves the live edge. */}
              <div
                className="chat-scroll-to-bottom pointer-events-none absolute z-30 flex justify-center py-2"
                style={{ bottom: scrollToEndClearance + 4 }}
              >
                <ScrollToEndButton
                  visible={showScrollToBottom && !isThreadFindActive}
                  hasUnseen={scrollToEndHasUnseen}
                  onScrollToEnd={() => scrollToEnd(true)}
                />
              </div>
            </div>

            {/* Input bar — centered for an empty draft, docked after sending. */}
            <div
              ref={setComposerOverlayElement}
              inert={isRevertingCheckpoint}
              data-chat-composer-overlay="true"
              className={
                isDraftHeroState
                  ? "pointer-events-none absolute inset-0 z-20 flex items-center"
                  : "pointer-events-none absolute inset-x-0 bottom-0 z-20 pt-1.5 sm:pt-2"
              }
            >
              {isDraftHeroState ? null : (
                <div
                  aria-hidden
                  data-chat-composer-backdrop="true"
                  className="pointer-events-auto absolute inset-x-0 bottom-0 top-(--chat-composer-backdrop-top,100%) bg-background"
                />
              )}
              <div
                ref={attachDraftHeroTransitionGroup}
                className="chat-composer-lane w-full"
                style={
                  isDraftHeroState && draftHeroBelowSurface > 0
                    ? { paddingTop: draftHeroBelowSurface }
                    : undefined
                }
              >
                <div
                  data-chat-composer-stack="true"
                  // The centred hero and composer glide by their center when a
                  // panel toggle resizes them, instead of jumping (panelFlip).
                  data-panel-flip={isDraftHeroState ? "center" : undefined}
                  data-panel-flip-contain={isDraftHeroState ? "window" : undefined}
                  className="group/composer-stack chat-content-lane pointer-events-auto relative z-10 px-(--chat-content-inset)"
                >
                  {isDraftHeroState ? (
                    <div className="absolute inset-x-0 bottom-full">
                      <div
                        className="pb-4 group-has-data-[composer-shoulder-tab]/composer-stack:pb-0"
                        data-mobile-composer-transition={
                          forceExpandedMobileComposer ? "headline" : undefined
                        }
                      >
                        {isEmptyServerThreadHero && activeThreadShell ? (
                          <ThreadHeroHeadline
                            thread={activeThreadShell}
                            project={activeProject}
                            isChat={activeThreadKind === "chat"}
                            isScratch={activeProjectIsScratch}
                          />
                        ) : (
                          <DraftHeroHeadline
                            draftId={draftId}
                            activeProjectRef={activeProjectRef}
                            activeProjectTitle={activeProject?.title ?? null}
                            surface={activeThreadSurface}
                          />
                        )}
                      </div>
                    </div>
                  ) : null}
                  <div
                    ref={attachDraftHeroComposerAnchor}
                    className="relative z-10"
                    data-mobile-composer-transition={
                      forceExpandedMobileComposer ? "composer" : undefined
                    }
                  >
                    <ComposerSurface.Shell
                      contextStrip={
                        composerStripVisible || composerStripLingering || composerStripExtended
                      }
                      contextStripCollapsed={!composerStripExtended}
                    >
                      <ComposerSurface.Host
                        inert={isSavingQueuedEdit}
                        aria-busy={isSavingQueuedEdit}
                      >
                        <div className="relative z-10">
                          <ChatComposer
                            canOperateThread={canOperateThread}
                            isChat={activeThreadKind === "chat"}
                            reportedModelSelection={reportedModelSelection}
                            multipleModelSelections={multipleModelSelections}
                            supportsMultipleModels={
                              serverConfig?.environment.capabilities.requiredWorktreeBootstrap ===
                              true
                            }
                            onMultipleModelSelectionsChange={setMultipleModelSelectionsStable}
                            composerRef={composerRef}
                            composerDraftTarget={composerDraftTarget}
                            environmentId={environmentId}
                            attachmentUploadsCapabilityKnown={attachmentUploadsCapabilityKnown}
                            supportsAttachmentUploads={supportsAttachmentUploads}
                            supportsQuestionAttachments={supportsQuestionAttachments}
                            maxFileAttachmentBytes={maxFileAttachmentBytes}
                            routeKind={routeKind}
                            routeThreadRef={routeThreadRef}
                            draftId={draftId}
                            activeThreadId={activeThreadId}
                            activeThreadEnvironmentId={activeThread?.environmentId}
                            activeThread={activeThread}
                            activeThreadShell={activeThreadShell}
                            promptHistoryMessages={timelineMessages}
                            isServerThread={isServerThread}
                            isLocalDraftThread={isLocalDraftThread}
                            forceExpandedOnMobile={forceExpandedMobileComposer && isDraftHeroState}
                            projectSelectionRequired={isLocalDraftThread && activeProject === null}
                            phase={phase}
                            canInterrupt={canInterruptRunningThread}
                            isConnecting={isConnecting}
                            isSendBusy={
                              (isSendBusy && !sendQueuesBehindSetup) ||
                              (setupQueueSendThreadKey !== null &&
                                setupQueueSendThreadKey === activeThreadKey) ||
                              isSavingQueuedEdit ||
                              isResuming
                            }
                            canResume={resumableRunId !== null || hasHeldQueuedRuns}
                            isRevertingCheckpoint={isRevertingCheckpoint}
                            sendDisabledReason={
                              !canOperateThread
                                ? "This connection cannot change threads."
                                : isEnvironmentChanging
                                  ? "Preparing machine"
                                  : isRevertingCheckpoint
                                    ? "Rewinding conversation"
                                    : feedbackUploading
                                      ? "Sending feedback"
                                      : threadDetailLoading
                                        ? "Messages loading"
                                        : worktreeSetupBlocksSend
                                          ? "Preparing worktree"
                                          : projectCloneSendBlockReason
                            }
                            isPreparingWorktree={isPreparingWorktree && !sendQueuesBehindSetup}
                            queuedRunsControl={queuedRunsControl}
                            bannerItems={composerBannerItems}
                            resumeCompactionTokens={resumeCompactionTokens}
                            keepFullHistory={keepFullHistory}
                            onToggleKeepFullHistory={toggleKeepFullHistoryStable}
                            // With attachments or contexts aboard the pick just inserts the
                            // text, so it sends as a prompt like the typed path would.
                            onUsageLimitsCommand={
                              usageLimitsOffered &&
                              usageLimitsKey !== null &&
                              !composerHasNonPromptContent
                                ? openUsageLimitsStable
                                : undefined
                            }
                            environmentUnavailable={activeEnvironmentUnavailableState}
                            activePendingApproval={activePendingApproval}
                            pendingApprovals={pendingApprovals}
                            pendingUserInputs={pendingUserInputs}
                            activePendingProgress={activePendingProgress}
                            activePendingResolvedAnswers={activePendingResolvedAnswers}
                            activePendingIsResponding={activePendingIsResponding}
                            activePendingDraftAnswers={activePendingDraftAnswers}
                            activePendingQuestionIndex={activePendingQuestionIndex}
                            respondingRequestIds={respondingRequestIds}
                            showPlanFollowUpPrompt={showPlanFollowUpPrompt}
                            activeProposedPlan={activeProposedPlan}
                            threadSyncPhase={activeEnvironmentUnavailable ? null : threadSyncPhase}
                            interactionMode={interactionMode}
                            lockedProvider={modelPickerLockedProvider}
                            providerStatuses={providerStatuses as ServerProvider[]}
                            providerCatalogKnown={serverConfig !== null}
                            activeProjectDefaultModelSelection={activeProjectDefaultModelSelection}
                            activeThreadModelSelection={activeThread?.modelSelection}
                            onSendModelSelectionChange={onComposerSendModelSelectionChange}
                            activeProjectId={activeProject?.id ?? null}
                            activeContextWindow={activeContextWindow}
                            activeTasksProgress={activeComposerTasksProgress}
                            activeTaskSteps={activeComposerTaskSteps}
                            compactThreadUnavailable={compactThreadUnavailable}
                            compactDisabled={compactDisabled}
                            compactDisabledReason={compactDisabledReason}
                            resolvedTheme={resolvedTheme}
                            settings={settings}
                            keybindings={keybindings}
                            gitCwd={gitCwd}
                            pullRequestProjectId={
                              supportsPullRequests ? (activeProject?.id ?? null) : null
                            }
                            pullRequestRepository={
                              supportsPullRequests
                                ? sourceControlRepositorySelector(activeProject?.repositoryIdentity)
                                : null
                            }
                            threadPullRequests={(activeThreadShell ?? activeThread)?.pullRequests}
                            restingControlsHost={restingComposerControlsHost}
                            restingControlsHaveLeadingContext={
                              mountComposerContextStrip &&
                              (isGitRepo || showComposerEnvironmentIndicator)
                            }
                            onRestingControlsVisibilityChange={setRestingComposerControlsVisible}
                            onComposerOverlayHeightChange={publishComposerOverlayHeightStable}
                            promptRef={promptRef}
                            composerImagesRef={composerImagesRef}
                            composerFilesRef={composerFilesRef}
                            composerTerminalContextsRef={composerTerminalContextsRef}
                            onPageScrollKeyDown={onComposerPageScrollKeyDownStable}
                            onPageScrollKeyUp={onComposerPageScrollKeyUpStable}
                            onPageScrollRelease={onComposerPageScrollReleaseStable}
                            onCompactContext={onComposerCompactContextStable}
                            onSend={onComposerSendStable}
                            onResume={onComposerResumeStable}
                            onInterrupt={onInterruptStable}
                            onImplementPlanInNewThread={onImplementPlanInNewThreadStable}
                            onRespondToApproval={onRespondToApprovalStable}
                            onSelectActivePendingUserInputOption={
                              onSelectActivePendingUserInputOptionStable
                            }
                            onAdvanceActivePendingUserInput={onAdvanceActivePendingUserInputStable}
                            onDismissActivePendingUserInput={onDismissUserInputStable}
                            onPreviousActivePendingUserInputQuestion={
                              onPreviousActivePendingUserInputQuestionStable
                            }
                            onChangeActivePendingUserInputCustomAnswer={
                              onChangeActivePendingUserInputCustomAnswer
                            }
                            onProviderModelSelect={onProviderModelSelectStable}
                            onOpenProviderSetup={openProviderSetupStable}
                            getModelDisabledReason={getModelDisabledReason}
                            toggleInteractionMode={toggleInteractionModeStable}
                            handleInteractionModeChange={handleInteractionModeChangeStable}
                            runtimeMode={runtimeMode}
                            handleRuntimeModeChange={handleRuntimeModeChangeStable}
                            focusComposer={focusComposerStable}
                            scheduleComposerFocus={scheduleComposerFocusStable}
                            setThreadError={setThreadError}
                            onExpandImage={onExpandTimelineImageStable}
                            onFileOpen={openFileAttachmentStable}
                            editingQueuedAttachments={composerEditingQueuedAttachments}
                            onRemoveEditingQueuedAttachment={removeEditingQueuedAttachmentStable}
                          />
                        </div>
                      </ComposerSurface.Host>
                      <div className="min-h-0">
                        <div className="relative z-0">
                          {mountComposerModelStrip ? (
                            <ComposerSurface.ContextStrip
                              data-composer-model-strip="true"
                              aria-hidden={showComposerModelStrip ? undefined : true}
                              inert={showComposerModelStrip ? undefined : true}
                              className={cn(
                                "group-data-model-strip-transition/composer-surface:before:bg-(--chat-composer-glass-surface)",
                                !showComposerModelStrip &&
                                  "pointer-events-none invisible absolute inset-x-0 top-full",
                              )}
                            >
                              <div
                                ref={setRestingComposerControlsHost}
                                className="min-w-0 flex-1"
                              />
                            </ComposerSurface.ContextStrip>
                          ) : null}
                          <CollapsePresence
                            open={mountComposerContextStrip}
                            onLingerChange={setComposerStripLingering}
                          >
                            <div className="pointer-events-auto">
                              <BranchToolbar
                                forceNewWorktree={multipleModelSelections !== null}
                                ref={branchToolbarRef}
                                environmentId={activeThread.environmentId}
                                threadId={activeThread.id}
                                showGitControls={isGitRepo}
                                {...(routeKind === "draft" && draftId ? { draftId } : {})}
                                onEnvModeChange={onEnvModeChangeStable}
                                startFromOrigin={startFromOrigin}
                                onStartFromOriginChange={onStartFromOriginChange}
                                envMode={envMode}
                                {...(canOverrideServerThreadEnvMode
                                  ? {
                                      activeThreadBranchOverride: activeThreadBranch,
                                      onActiveThreadBranchOverrideChange:
                                        setPendingServerThreadBranch,
                                    }
                                  : {})}
                                envLocked={envLocked}
                                onComposerFocusRequest={scheduleComposerFocusStable}

                                {...(canPickRunOn
                                  ? { onEnvironmentChange: onEnvironmentChangeStable }
                                  : {})}
                                autoEnvironmentLabel={autoEnvironmentLabel}
                                onAutoEnvironment={
                                  draftId &&
                                  !envLocked &&
                                  canAutoBalanceEnvironments &&
                                  loadBalancingSettings.loadBalancingEnabled
                                    ? onAutoEnvironmentStable
                                    : undefined
                                }
                                availableEnvironments={runOnOptions}
                                {...(runOnEnvironmentId ? { runOnEnvironmentId } : {})}
                                composerControlsHostRef={setRestingComposerControlsHost}
                                contextStripVisible={showComposerContextStrip}
                              />
                            </div>
                          </CollapsePresence>
                        </div>
                      </div>
                    </ComposerSurface.Shell>
                    <div
                      aria-hidden
                      className="h-[calc(env(safe-area-inset-bottom)+1rem)] sm:h-[calc(env(safe-area-inset-bottom)+1.25rem)]"
                    />
                  </div>
                </div>
              </div>
            </div>

            {canOperatePreview && activeThreadRef && activeEnvironmentServerBrowser ? (
              <PreviewSessionSync threadRef={activeThreadRef} />
            ) : null}
            {embedded ? null : (
              <FloatingBrowserPreview
                activeThreadRef={activeThreadRef}
                composerElement={isDraftHeroState ? null : composerOverlayElement}
              />
            )}

            <AlertDialog open={branchRestoreConfirmOpen} onOpenChange={setBranchRestoreConfirmOpen}>
              <AlertDialogPopup>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    Switch to{" "}
                    <code className="font-medium">
                      {localCheckoutBranchMismatch?.threadBranch ?? ""}
                    </code>
                    ?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    You have uncommitted changes. They'll carry over to the other branch, or block
                    the switch if they conflict.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
                  <Button
                    variant="default"
                    disabled={!canWriteSourceControl}
                    onClick={() => {
                      setBranchRestoreConfirmOpen(false);
                      void handleSwitchCheckoutToThread();
                    }}
                  >
                    Switch branch
                  </Button>
                </AlertDialogFooter>
              </AlertDialogPopup>
            </AlertDialog>
          </ThreadFindCanvas>
          {/* end chat column */}
        </div>
        {/* end horizontal flex container */}

        {bottomPanelAvailable && activeThreadRef ? (
          <BottomTerminalPanel
            threadRef={activeThreadRef}
            threadStarted={isServerThread}
            focusRequestId={terminalFocusRequestId}
            toggleShortcutLabel={shortcutLabelForCommand(keybindings, "terminal.toggle")}
            onAddTerminalContext={addTerminalContextToDraftStable}
            getMotionTargets={getBottomPanelMotionTargetsStable}
            runResolverRef={bottomPanelRunResolverRef}
          />
        ) : null}
      </div>

      {rightPanelPresent && !shouldUsePlanSidebarSheet && activeThreadRef ? (
        <RightPanelTabs
          mode="inline"
          open={rightPanelOpen}
          keybindings={keybindings}
          getShortcutContext={getShortcutContextStable}
          maximized={rightPanelMaximized}
          inlineSize={previewPanelInlineSize}
          surfaces={renderedRightPanelSurfaces}
          environmentId={activeThreadRef.environmentId}
          activeSurfaceId={renderedRightPanelSurface?.id ?? null}
          pendingSurfaceIds={pendingFileSurfaceIds}
          previewSessions={activePreviewState.sessions}
          desktopByTabId={activePreviewState.desktopByTabId}
          previewRuntimeTabId={resolvePreviewRuntimeTabId}
          onActivate={activateRightPanelSurfaceStable}
          onCloseSurface={closeRightPanelSurfaceStable}
          onRenameDevice={(surfaceId, title) => {
            if (activeThreadRef)
              useRightPanelStore.getState().renameDevice(activeThreadRef, surfaceId, title);
          }}
          onCloseOtherSurfaces={closeOtherRightPanelSurfacesStable}
          onCloseSurfacesToRight={closeRightPanelSurfacesToRightStable}
          onCloseAllSurfaces={closeAllRightPanelSurfacesStable}
          onMoveSurface={moveRightPanelSurfaceStable}
          onCopyFilePath={copyRightPanelFilePathStable}
          addOptions={rightPanelAddOptions}
        >
          {rightPanelContent}
        </RightPanelTabs>
      ) : null}
      {rightPanelPresent && shouldUsePlanSidebarSheet && activeThreadRef ? (
        <RightPanelSheet
          animationDurationMs={panelAnimationDurationMs}
          open={rightPanelOpen}
          onClose={closePreviewPanelStable}
        >
          <RightPanelTabs
            mode="sheet"
            open={rightPanelOpen}
            keybindings={keybindings}
            getShortcutContext={getShortcutContextStable}
            inlineSize={previewPanelInlineSize}
            // Same effective inset as the closed-state titlebar controls
            // (pr-3 in the tab bar plus this pixel equals the absolute
            // right inset plus mr-px), so the cluster does not creep when
            // the sheet opens.
            layoutControls={
              rightPanelOpen ? (
                <div className="mr-px flex items-center">{panelToggleControls}</div>
              ) : null
            }
            surfaces={renderedRightPanelSurfaces}
            environmentId={activeThreadRef.environmentId}
            activeSurfaceId={renderedRightPanelSurface?.id ?? null}
            pendingSurfaceIds={pendingFileSurfaceIds}
            previewSessions={activePreviewState.sessions}
            desktopByTabId={activePreviewState.desktopByTabId}
            previewRuntimeTabId={resolvePreviewRuntimeTabId}
            onActivate={activateRightPanelSurfaceStable}
            onCloseSurface={closeRightPanelSurfaceStable}
            onRenameDevice={(surfaceId, title) => {
              if (activeThreadRef)
                useRightPanelStore.getState().renameDevice(activeThreadRef, surfaceId, title);
            }}
            onCloseOtherSurfaces={closeOtherRightPanelSurfacesStable}
            onCloseSurfacesToRight={closeRightPanelSurfacesToRightStable}
            onCloseAllSurfaces={closeAllRightPanelSurfacesStable}
            onMoveSurface={moveRightPanelSurfaceStable}
            onCopyFilePath={copyRightPanelFilePathStable}
            addOptions={rightPanelAddOptions}
          >
            {rightPanelContent}
          </RightPanelTabs>
        </RightPanelSheet>
      ) : null}

      <AlertDialog
        open={pendingRevert !== null && pendingRevert.routeThreadKey === routeThreadKey}
        onOpenChange={(open) => {
          if (!open) setPendingRevert(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Edit from here?</AlertDialogTitle>
            <AlertDialogDescription>
              Rewind chat to before this message. Your prompt and attachments return to the
              composer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (!pendingRevert || pendingRevert.routeThreadKey !== routeThreadKey) return;
                setPendingRevert(null);
                void onRevertToTurnCount(pendingRevert.turnCount, pendingRevert.messageId, true);
              }}
            >
              Revert files too
            </Button>
            <Button
              onClick={() => {
                if (!pendingRevert || pendingRevert.routeThreadKey !== routeThreadKey) return;
                setPendingRevert(null);
                void onRevertToTurnCount(pendingRevert.turnCount, pendingRevert.messageId, false);
              }}
            >
              Revert and keep changes
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <OverlayPresence when={expandedImage}>
        {(expandedImage) => (
          <ExpandedImageDialog
            key={expandedImageKey(expandedImage)}
            preview={expandedImage}
            onClose={closeExpandedImageStable}
          />
        )}
      </OverlayPresence>
    </div>
  );
  return (
    <FileMetadataThreadProvider
      threadRef={activeThreadRef}
      cwd={activeWorkspaceRoot}
      checkpoints={serverProjection?.checkpoints}
    >
      {content}
    </FileMetadataThreadProvider>
  );
}

/** Keeps the thread's preview tabs synced while no browser panel is mounted. */
function PreviewSessionSync(props: { readonly threadRef: ScopedThreadRef }) {
  usePreviewSession(props.threadRef);
  return null;
}
