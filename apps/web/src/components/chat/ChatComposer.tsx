import { OverlayPresence } from "~/components/ui/overlay-presence";
import { formatProviderSkillDisplayName } from "@cogenly/shared/inlineSkills";
import { useComposerTypingGuard } from "./useComposerTypingGuard";
import { DESKTOP_PASTE_AS_TEXT_EVENT } from "../../lib/desktopPasteAsText";
import { isLocalEnvironmentDisabled } from "../../localEnvironment";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useRightPanelStore } from "~/rightPanelStore";
import { AttachmentFilePreview } from "../files/AttachmentFilePreview";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import {
  composerPullRequestsFromLinks,
  filterComposerPullRequestMatches,
} from "@cogenly/shared/composerPullRequestMatches";
import { importPastedComposerText, readPastedComposerContext } from "../composerInlineTokenPaste";
import { elementContextToPreviewAnnotation } from "../../lib/elementContext";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import {
  questionAttachmentDraftId,
  countQuestionAttachments,
  useQuestionAttachmentPreparation,
  changeQuestionAttachmentPreparation,
} from "../../questionAttachments";
import type {
  KeybindingCommand,
  AssistantCitation,
  ChatAttachment as ContractChatAttachment,
  ChatFileAttachment,
  EnvironmentId,
  IntegrationSource,
  ModelSelection,
  ProjectId,
  PullRequestListInput,
  PreviewAnnotationPayload,
  ProviderApprovalDecision,
  LinkContextRecord,
  ProviderInteractionMode,
  RuntimeMode,
  ResolvedKeybindingsConfig,
  RuntimeRequestId,
  ScopedThreadRef,
  ServerProvider,
  ThreadId,
} from "@cogenly/contracts";
import {
  EnvironmentRequestInvalidError,
  AuthOrchestrationOperateScope,
  ProviderDriverKind,
  ProviderInstanceId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS,
} from "@cogenly/contracts";
import type { EnvironmentConnectionPresentation } from "@cogenly/client-runtime/connection";
import { squashAtomCommandFailure } from "@cogenly/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import {
  isPasteAsTextShortcut,
  nextPastedTextFileName,
  pastedTextDisposition,
  wouldTextPasteExceedLimit,
} from "@cogenly/client-runtime/text-paste";
import { serializeComposerFileLink } from "@cogenly/shared/composerTrigger";
import { folderDropTarget, resolveDroppedFolderPath } from "./folderDrop";
import { createModelSelection, normalizeModelSlug } from "@cogenly/shared/model";
import { USAGE_LIMITS_COMMAND } from "@cogenly/shared/usageLimits";
import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal, flushSync } from "react-dom";
import {
  clampCollapsedComposerCursor,
  type ComposerTrigger,
  type ComposerSubmissionIntent,
  collapseExpandedComposerCursor,
  composerSubmissionIntentForKey,
  composerStateAtPromptEnd,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  formatAssistantCitationForComposer,
  replaceTextRange,
} from "../../composer-logic";
import { DISCONNECTED_COMPOSER_PLACEHOLDER } from "../../composerPlaceholder";
import { listContinuationForEnter, listIndentForTab } from "../../composer-list-continuation";
import {
  deriveComposerSendState,
  getProviderSendBlockReason,
  readFileAsDataUrl,
  resolveComposerInteractionMode,
  resolveComposerProviderSelection,
  threadShellHasStarted,
} from "../ChatView.logic";
import {
  dataTransferHasComposerMention,
  makeComposerMentionDragHandlers,
} from "./composerMentionDrag";
import {
  composerFloatingLayerProps,
  isInsideCollapsedComposerControls,
  isInsideRestingComposerControlScope,
} from "./composerEventScope";
import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type DraftId,
  type PersistedComposerImageAttachment,
  composerFileMatchesReattachMarker,
  composerFileNeedsReattach,
  composerDraftHasUserContent,
  composerTargetKey,
  useComposerDraftStore,
  useComposerThreadDraft,
  useEffectiveComposerModelState,
} from "../../composerDraftStore";
import { useComposerTriggerState } from "./useComposerTriggerState";
import { useComposerMultilinePrompt } from "./useComposerMultilinePrompt";
import {
  ComposerTasksBadge,
  ComposerTasksContent,
  ComposerTasksPanel,
  type ComposerTaskStep,
  type ComposerTasksProgress,
} from "./ComposerTasksBadge";
import { ComposerActivityRow } from "./ComposerActivityStatus";
import {
  reconcileAttachmentContextReferences,
  type RetainedAttachmentContextPayloads,
} from "./composerContextUndo";
import type { ThreadSyncPhase } from "../../threadSync";
import { ComposerBanner } from "./ComposerBanner";
import { ComposerSurface } from "./ComposerSurface";
import {
  AttachmentPresence,
  NoticePresenceFrame,
  ComposerBannerStack,
  type ComposerBannerStackContent,
  type ComposerBannerStackItem,
} from "./ComposerBannerStack";
import { ComposerStackColumn } from "./ComposerStackColumn";
import { formatAttachmentSize } from "@cogenly/client-runtime/state/attachments";
import {
  acceptComposerAttachmentFiles,
  attachmentsToReleaseOnUploadCapabilityLoss,
  composerOtherFilesForPresentation,
  fileAttachmentCapabilityBlockReason,
  fileAttachmentStagingLimit,
  isPreviewableComposerVideo,
  prepareComposerImageAttachments,
  shouldHandleComposerAttachmentPaste,
} from "./composerAttachmentFiles";
import {
  releaseAttachmentUpload,
  releaseDraftAttachment,
  retryAttachmentUpload,
  startAttachmentUpload,
  useAttachmentUploadStore,
} from "../../lib/attachmentUploadQueue";
import {
  attachmentUploadBlockReason,
  formatAttachmentUploadProgress,
} from "../../lib/attachmentUploadState";
import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import { shortcutLabelForCommand } from "../../keybindings";
import {
  type TerminalContextDraft,
  type TerminalContextSelection,
} from "../../lib/terminalContext";
import { useComposerPathSearch } from "../../lib/composerPathSearchState";
import { toKindScopedComposerContextId } from "@cogenly/shared/composerContextReferences";
import {
  getRestingComposerImagePreviewCounts,
  resolveComposerDictationFit,
  resolveRestingComposerControlsLayout,
  type ComposerDictationWaveformSize,
  shouldAnimateComposerRestingTransition,
  shouldUseCompactComposerPrimaryActions,
  shouldUseCompactComposerFooter,
} from "../composerFooterLayout";
import { measureRestingComposerControls } from "./restingComposerControlsMeasurement";
import {
  type ComposerCitationCommentRequest,
  type ComposerPromptEditorHandle,
  ComposerPromptEditor,
} from "../ComposerPromptEditor";
import {
  ComposerContextActionsContext,
  composerContextRecordsFromDraft,
  uploadedContextRecordFromDraft,
} from "../composerContextPresentation";
import { useOpenPrLink } from "~/lib/openPullRequestLink";
import {
  collectInlineContextIds,
  stripInlineContextReferences,
  type ComposerContextReference,
  ensureInlineContextReferences,
  formatInlineContextReference,
  insertInlineContextReference,
  inlineContextReferenceReplacement,
} from "~/lib/composerContextReferences";
import {
  asKnownContextRecord,
  composerContextImportLookupIds,
  isSameComposerContextPayload,
  uploadedAttachmentContextRecord,
  fileContextReference,
  imageContextReference,
  previewAnnotationContextId,
  previewAnnotationContextRecord,
  previewAnnotationFromRecord,
  reviewCommentContextId,
  reviewCommentContextReference,
  reviewCommentContextRecord,
  reviewCommentFromRecord,
  terminalContextDraftFromRecord,
  terminalContextReference,
  terminalContextRecord,
  threadContextRecord,
  linkContextReference,
  agentContextRecord,
  projectFolderContextRecord,
  integrationContextRecord,
} from "~/lib/composerContextRecords";
import { matchComposerMentionItems } from "@cogenly/client-runtime/composerThreadItems";
import { useAgents } from "~/agents/agentsClient";
import { useThreadKindResolver } from "~/hooks/useThreadKind";
import { useEnvironmentProjectLabels } from "~/projectLabels/useProjectLabels";
import { useThreadContextDrop, threadContextDropTargetProps } from "./threadContextDrag";
import { readThreadShell, useThreadShells } from "~/state/entities";
import { requestConfirmDialog } from "~/confirmDialog";
import { encodeComposerContextFragment } from "@cogenly/shared/composerContextClipboard";
import type {
  ComposerContextClipboardFragment,
  ComposerContextRecord,
  ThreadPullRequestLink,
} from "@cogenly/contracts";
import { resolveAssetUrl } from "~/assets/assetUrls";
import { assetEnvironment } from "~/state/assets";
import { readPreparedConnection } from "~/state/session";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { orchestrationEnvironment } from "~/state/orchestration";
import { threadContextAttachment } from "~/lib/threadContextAttachment";
import {
  pullRequestEnvironment,
  usePullRequestList,
  type EnvironmentQueryTarget,
} from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { useDebouncedValue } from "~/state/queries";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { resolveModelPickerSelectedModel } from "./ModelPickerContent";
import {
  type ComposerCommandItem,
  ComposerCommandMenu,
  composerSuggestionOptionId,
} from "./ComposerCommandMenu";
import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";
import { ComposerSourcesPicker, useComposerSources } from "./ComposerSourcesPicker";
import { ComposerImageThumbnail } from "./ComposerImageThumbnail";
import { ImageMarkupDialog } from "./ImageMarkupDialog";
import {
  endImageMarkupSession,
  readImageMarkupSession,
  setImageMarkupSession,
  useImageMarkupSessionStore,
} from "./imageMarkupSessions";
import type { MarkupShape } from "./imageMarkup";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import { ComposerPlanFollowUpBanner } from "./ComposerPlanFollowUpBanner";
import { ComposerControl, ComposerControlIcon, ComposerControlSeparator } from "./ComposerControl";
import { resolveComposerMenuActiveItemId } from "./composerMenuHighlight";
import { buildPullRequestReferenceContext } from "~/lib/pullRequestContext";
import { matchesPullRequestQuery, rankPullRequestMatches } from "~/lib/pullRequestSuggestions";
import {
  searchSlashCommandItems,
  slashCommandItemsForPromptPosition,
} from "./composerSlashCommandSearch";
import {
  getComposerPromptInjectionState,
  getComposerProviderState,
  renderProviderTraitsMenuContent,
  renderProviderTraitsPicker,
} from "./composerProviderState";
import { ContextWindowMeter, ContextWindowMeterPlaceholder } from "./ContextWindowMeter";
import {
  providerSupportsManualCompaction,
  resolveContextWindowModelDisplayName,
  shouldReserveContextWindowMeter,
} from "./ContextWindowMeter.logic";
import {
  attachVideoThumbnail,
  buildAttachmentVideoPreview,
  buildExpandedImagePreview,
  type ExpandedImagePreview,
} from "./ExpandedImagePreview";
import { basenameOfPath } from "../../pierre-icons";
import { cn, isMacPlatform, randomUUID } from "~/lib/utils";
import {
  getComposerPromptLengthValidationMessage,
  getComposerSubmissionValidationMessage,
  submitComposerDraft,
} from "./composerSubmission";
import { ComposerPromptLengthValidation } from "./ComposerPromptLengthValidation";
import { PierreEntryIcon } from "./PierreEntryIcon";
import { pendingDraftWork } from "./pendingDraftWork";
import { importComposerThreadAttachment } from "./composerThreadImport";
import { prepareVideoFirstFrame } from "../../lib/videoFirstFrame";
import { observeResize } from "~/lib/observeResize";
import { subscribePanelMotion } from "~/lib/panelFlip";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import {
  BotIcon,
  CircleAlertIcon,
  PaperclipIcon,
  PencilIcon,
  PencilRulerIcon,
  PlayIcon,
  XIcon,
} from "lucide-react";
import { proposedPlanTitle } from "@cogenly/shared/proposedPlanText";
import { hasProviderSetup } from "./ProviderStatusBanner";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  NO_PROVIDER_MODEL_SELECTION,
  sortProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { type AppModelOption, getAppModelOptionsForInstance } from "../../modelSelection";
import type { UnifiedSettings } from "@cogenly/contracts/settings";
import {
  isVideoAttachment,
  type ChatMessage,
  type SessionPhase,
  type Thread,
  type ThreadShell,
} from "../../types";
import {
  buildComposerPromptHistoryEntries,
  stepComposerPromptHistory,
  type ComposerPromptHistoryPosition,
} from "./composerPromptHistory";
import type { PendingUserInputDraftAnswer } from "../../pendingUserInput";
import type {
  LatestProposedPlanState,
  PendingApproval,
  PendingUserInput,
} from "../../session-logic";
import {
  resolveComposerDispatchMode,
  type ComposerDispatchMode,
} from "@cogenly/client-runtime/state/composer-dispatch";
import type { ContextWindowSnapshot } from "../../lib/contextWindow";
import {
  getProviderSlashCommandsForSlashMenu,
  getProviderSkillsForSlashMenu,
  hasCompleteProviderWorkspaceSnapshot,
  hasCurrentProviderWorkspaceSnapshot,
  resolveProviderSkillsForCwd,
  resolveProviderSlashCommandsForCwd,
} from "@cogenly/client-runtime/providerSkills";
import { searchProviderSkills } from "../../providerSkillSearch";
import { useDelayedStatus } from "../../hooks/useDelayedStatus";
import { useElementState } from "../../hooks/useElementState";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useUpdateEnvironmentModelPreferences } from "../../hooks/useSettings";
import type { SetModelEffortDefault } from "./TraitsPicker";
import { ComposerDictationControl, type ComposerDictationHandle } from "./ComposerDictationControl";
import { LAYOUT_MOTION_DURATION, readPanelAnimationsActive } from "../../panelAnimations";
import { useAtomCommand } from "../../state/use-atom-command";
import { readEnvironmentScope } from "../../state/session";
import { serverEnvironment } from "../../state/server";
import {
  ComposerProjectPicker,
  useComposerProjectPickerState,
} from "../../projectLabels/ComposerProjectPicker";
import { useComposerProjectFolder } from "../../projectLabels/useComposerProjectFolder";
import type { ReviewCommentContext } from "../../reviewCommentContext";

function ComposerVideoThumbnail({ file }: { file: File }) {
  const setVideo = useCallback(
    (video: HTMLVideoElement | null) => {
      if (!video) return;
      return attachVideoThumbnail(video, file);
    },
    [file],
  );

  return (
    <video
      ref={setVideo}
      muted
      playsInline
      preload="metadata"
      aria-hidden="true"
      onLoadedMetadata={(event) => prepareVideoFirstFrame(event.currentTarget)}
      className="pointer-events-none absolute inset-0 size-full object-cover"
    />
  );
}

type ComposerCommandMenuPosition = {
  bottom: number;
  left: number;
  maxHeight: number;
  width: number;
};

const COMPOSER_PULL_REQUEST_LIST_LIMIT = 99;
const isEnvironmentRequestInvalidError = Schema.is(EnvironmentRequestInvalidError);
const COMPOSER_PULL_REQUEST_RESULT_LIMIT = 12;
const EMPTY_PULL_REQUEST_LIST_TARGETS: ReadonlyArray<EnvironmentQueryTarget<PullRequestListInput>> =
  [];

const COMPOSER_RESTING_TRANSITION_CLEANUP_BUFFER_MS = 50;
const COMPOSER_RESTING_TRANSITION_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";
const COMPOSER_RESTING_CONTROLS_ARRIVAL_DRIFT_PX = 4;

function useComposerRestingTransition(
  isCollapsed: boolean,
  restingControlsRef: React.RefObject<HTMLDivElement | null>,
  onOverlayHeightChange: (height: number) => void,
  animationDurationMs: number,
) {
  const elementRef = useRef<HTMLDivElement>(null);
  const isCollapsedRef = useRef(isCollapsed);
  const previousCollapsedRef = useRef(isCollapsed);
  const previousHeightRef = useRef<number | null>(null);
  const previousModelStripHeightRef = useRef<number | null>(null);
  const previousContentOffsetsRef = useRef<{
    promptFromTop: number | null;
    promptHeight: number | null;
    actionFromBottom: number | null;
    controlsFromBottom: number | null;
    controlsFromLeft: number | null;
    surfaceBottomInset: number | null;
  }>({
    promptFromTop: null,
    promptHeight: null,
    actionFromBottom: null,
    controlsFromBottom: null,
    controlsFromLeft: null,
    surfaceBottomInset: null,
  });
  const animationRef = useRef<Animation | null>(null);
  const animationTargetHeightRef = useRef<number | null>(null);
  const contentAnimationsRef = useRef<Animation[]>([]);
  const stateChangeAnimationsRef = useRef<Animation[]>([]);
  const pinnedOverlayRef = useRef<HTMLElement | null>(null);
  const transitionCleanupTimeoutRef = useRef<number | null>(null);
  const transitionLayoutRequestRef = useRef(0);
  const hasCompletedInitialLayoutRef = useRef(false);

  const clearOverlayPin = useCallback(() => {
    // The overlay belongs to the chat view and outlives this composer, so it
    // is remembered from pin time rather than re-resolved through a ref that
    // React may already have detached during unmount.
    const overlay = pinnedOverlayRef.current;
    pinnedOverlayRef.current = null;
    overlay?.style.removeProperty("height");
    overlay?.style.removeProperty("display");
    overlay?.style.removeProperty("flex-direction");
    overlay?.style.removeProperty("justify-content");
  }, []);

  const clearTransitionStyles = useCallback(() => {
    const element = elementRef.current;
    const footer = element?.querySelector<HTMLElement>('[data-chat-composer-footer="true"]');
    element?.style.removeProperty("overflow");
    element?.style.removeProperty("clip-path");
    element?.style.removeProperty("overflow-clip-margin");
    element
      ?.querySelector<HTMLElement>('[data-chat-composer-surface="true"]')
      ?.style.removeProperty("height");
    footer?.style.removeProperty("position");
    footer?.style.removeProperty("top");
    footer?.style.removeProperty("bottom");
    footer?.style.removeProperty("left");
    footer?.style.removeProperty("right");
    footer?.style.removeProperty("height");
    const shell = element?.closest<HTMLElement>('[data-slot="composer-shell"]');
    shell?.removeAttribute("data-model-strip-transition");
    const modelStrip = shell?.querySelector<HTMLElement>('[data-composer-model-strip="true"]');
    for (const property of [
      "position",
      "top",
      "visibility",
      "height",
      "min-height",
      "padding-top",
      "align-items",
      "z-index",
      "pointer-events",
    ]) {
      modelStrip?.style.removeProperty(property);
    }
    clearOverlayPin();
  }, [clearOverlayPin]);

  isCollapsedRef.current = isCollapsed;

  const transitionToCurrentGeometry = useCallback(
    (stateChanged: boolean) => {
      const element = elementRef.current;
      const surface = element?.querySelector<HTMLElement>('[data-chat-composer-surface="true"]');
      if (!element || !surface) return;

      const nextIsCollapsed = isCollapsedRef.current;

      const visibleTransitionElement = (selector: string) =>
        Array.from(element.querySelectorAll<HTMLElement>(selector)).find(
          (candidate) => candidate.getClientRects().length > 0,
        ) ?? null;
      const prompt = visibleTransitionElement(
        '[data-composer-prompt-surface="true"], [data-chat-composer-transition-prompt="true"]',
      );
      const action = visibleTransitionElement('[data-chat-composer-transition-actions="true"]');
      const footer = element.querySelector<HTMLElement>('[data-chat-composer-footer="true"]');
      const continuousControls =
        element.dataset.inlineRestingControls === "true" ||
        element.dataset.modelOnlyStrip === "true";
      const controls = nextIsCollapsed
        ? restingControlsRef.current
        : element.querySelector<HTMLElement>('[data-chat-composer-controls="left"]');

      const shell = element.closest<HTMLElement>('[data-slot="composer-shell"]');
      const modelStrip = shell?.querySelector<HTMLElement>('[data-composer-model-strip="true"]');
      const interruptedStripHeight =
        animationRef.current && modelStrip ? modelStrip.getBoundingClientRect().height : null;
      const interruptedAnimation = animationRef.current;
      const interruptedPromptTop = interruptedAnimation
        ? (prompt?.getBoundingClientRect().top ?? null)
        : null;
      const interruptedActionTop = interruptedAnimation
        ? (action?.getBoundingClientRect().top ?? null)
        : null;
      const interruptedControlsLeft = interruptedAnimation
        ? (controls?.getBoundingClientRect().left ?? null)
        : null;
      const interruptedControlsTop = interruptedAnimation
        ? (controls?.getBoundingClientRect().top ?? null)
        : null;
      const interruptedHeight = interruptedAnimation
        ? element.getBoundingClientRect().height
        : null;
      const interruptedTargetHeight = animationTargetHeightRef.current;
      const interruptedCurrentTime =
        typeof interruptedAnimation?.currentTime === "number"
          ? interruptedAnimation.currentTime
          : null;
      const interruptedDuration = interruptedAnimation?.effect?.getComputedTiming().duration;
      if (transitionCleanupTimeoutRef.current !== null) {
        window.clearTimeout(transitionCleanupTimeoutRef.current);
        transitionCleanupTimeoutRef.current = null;
      }
      interruptedAnimation?.cancel();
      animationRef.current = null;
      for (const animation of contentAnimationsRef.current) animation.cancel();
      contentAnimationsRef.current = [];
      // The reveal and fade animations keep their own schedule across the
      // body-resize re-entries that retarget the geometry mid-flight (every
      // transition with a draft triggers one); cancelling them there would
      // pop their subjects to full visibility at the start of the tween.
      if (stateChanged) {
        for (const animation of stateChangeAnimationsRef.current) animation.cancel();
        stateChangeAnimationsRef.current = [];
      }
      clearTransitionStyles();

      const nextRect = element.getBoundingClientRect();
      const nextHeight = nextRect.height;
      const nextModelStripHeight = modelStrip?.getBoundingClientRect().height ?? null;
      // The chat view resize-observes the overlay to place the timeline
      // inset and the scroll-to-end pill. Publishing the
      // destination height here turns that feedback into one update instead
      // of a ChatView re-render on every animation frame.
      const overlay = element.closest<HTMLElement>('[data-chat-composer-overlay="true"]');
      const overlayRect = overlay?.getBoundingClientRect();
      const overlayHeight = overlayRect?.height ?? null;
      if (overlayHeight !== null) {
        onOverlayHeightChange(overlayHeight);
      }
      const nextPromptRect = prompt?.getBoundingClientRect() ?? null;
      const nextPromptTop = nextPromptRect?.top ?? null;
      const nextActionTop = action?.getBoundingClientRect().top ?? null;
      const nextControlsRect = controls?.getBoundingClientRect() ?? null;
      const nextControlsTop = nextControlsRect?.top ?? null;
      const footerBottom = footer ? nextRect.bottom - footer.getBoundingClientRect().bottom : 1;
      const previousHeight = interruptedHeight ?? previousHeightRef.current;
      const targetChanged =
        interruptedTargetHeight === null || Math.abs(interruptedTargetHeight - nextHeight) >= 0.5;
      const shouldAnimate = shouldAnimateComposerRestingTransition({
        hasCompletedInitialLayout: hasCompletedInitialLayoutRef.current,
        stateChanged,
        hasInterruptedAnimation: interruptedHeight !== null,
      });

      if (
        shouldAnimate &&
        readPanelAnimationsActive() &&
        previousHeight !== null &&
        Math.abs(previousHeight - nextHeight) >= 0.5
      ) {
        const remainingDuration =
          typeof interruptedDuration === "number" && interruptedCurrentTime !== null
            ? Math.max(1, interruptedDuration - interruptedCurrentTime)
            : animationDurationMs;
        const duration =
          interruptedHeight !== null && !targetChanged ? remainingDuration : animationDurationMs;
        element.style.overflow = "clip";
        if (modelStrip) {
          // The model controls cross the input's lower edge on their way to the strip.
          const controlsClearance = Math.max(
            nextModelStripHeight ?? 0,
            previousModelStripHeightRef.current ?? 0,
          );
          element.style.overflowClipMargin = `${controlsClearance}px`;
          element.style.clipPath = `inset(0 0 -${controlsClearance}px 0)`;
        }
        surface.style.height = "100%";

        // Pinning the overlay at the destination height keeps the resize
        // observer quiet for the tween; bottom alignment keeps the animating
        // surface glued to the overlay's stable bottom edge. The pin lasts
        // only for the tween so later attachment, thread, font, and viewport
        // changes remain natural.
        if (overlay && overlayHeight !== null) {
          overlay.style.height = `${String(overlayHeight)}px`;
          overlay.style.display = "flex";
          overlay.style.flexDirection = "column";
          overlay.style.justifyContent = "flex-end";
          pinnedOverlayRef.current = overlay;
        }

        // Keep the footer attached to the stable bottom edge while the outer
        // height changes. Its resting absolute layout otherwise spans the old
        // height on collapse, while its expanded flow layout falls below the
        // clipped surface on expansion.
        if (footer) {
          footer.style.position = "absolute";
          footer.style.top = "auto";
          footer.style.bottom = `${String(footerBottom)}px`;
          footer.style.height = "3rem";
          if (nextIsCollapsed) {
            footer.style.left = "auto";
            footer.style.right = "1px";
          } else {
            footer.style.left = "1px";
            footer.style.right = "1px";
          }
        }

        let stripAnimation: Animation | null = null;
        if (modelStrip) {
          const stripHeight = modelStrip.getBoundingClientRect().height;
          const stripOverlap = -Number.parseFloat(getComputedStyle(modelStrip).marginTop);
          const fromHeight =
            interruptedStripHeight ??
            (previousCollapsedRef.current
              ? (previousModelStripHeightRef.current ?? stripHeight)
              : stripOverlap);
          const toHeight = nextIsCollapsed ? stripHeight : stripOverlap;
          modelStrip.style.position = "relative";
          modelStrip.style.top = "auto";
          modelStrip.style.visibility = "visible";
          modelStrip.style.minHeight = "0";
          // Padding must not impose a 24px minimum on the 16px overlap endpoint.
          // Keep the controls bottom-aligned while the strip retracts behind the input.
          modelStrip.style.paddingTop = "0";
          modelStrip.style.alignItems = "flex-end";
          modelStrip.style.pointerEvents = "none";
          modelStrip.style.zIndex = "20";
          shell?.setAttribute("data-model-strip-transition", "true");
          stripAnimation = modelStrip.animate(
            [{ height: `${fromHeight}px` }, { height: `${toHeight}px` }],
            { duration, easing: COMPOSER_RESTING_TRANSITION_EASING, fill: "both" },
          );
        }

        const animation = element.animate(
          [{ height: `${previousHeight}px` }, { height: `${nextHeight}px` }],
          {
            duration,
            easing: COMPOSER_RESTING_TRANSITION_EASING,
            fill: "both",
          },
        );
        animationRef.current = animation;
        animationTargetHeightRef.current = nextHeight;

        const animatedRect = element.getBoundingClientRect();
        const previousBottom =
          overlayRect && previousContentOffsetsRef.current.surfaceBottomInset !== null
            ? overlayRect.bottom - previousContentOffsetsRef.current.surfaceBottomInset
            : animatedRect.bottom;
        const bottomShift = previousBottom - animatedRect.bottom;
        const previousPromptTop =
          interruptedPromptTop ??
          (previousContentOffsetsRef.current.promptFromTop === null
            ? null
            : animatedRect.top + bottomShift + previousContentOffsetsRef.current.promptFromTop);
        const previousActionTop =
          interruptedActionTop ??
          (previousContentOffsetsRef.current.actionFromBottom === null
            ? null
            : previousBottom - previousContentOffsetsRef.current.actionFromBottom);
        const contentAnimations: Animation[] = stripAnimation ? [stripAnimation] : [];
        const animateContentPosition = (
          content: HTMLElement | null,
          previousTop: number | null,
          previousLeft: number | null = null,
        ) => {
          if (!content || previousTop === null) return;
          const rect = content.getBoundingClientRect();
          const offset = previousTop - rect.top;
          const offsetX = previousLeft === null ? 0 : previousLeft - rect.left;
          if (Math.abs(offset) < 0.5 && Math.abs(offsetX) < 0.5) return;
          contentAnimations.push(
            content.animate(
              [{ transform: `translate(${offsetX}px, ${offset}px)` }, { transform: "none" }],
              {
                duration,
                easing: COMPOSER_RESTING_TRANSITION_EASING,
              },
            ),
          );
        };
        animateContentPosition(prompt, previousPromptTop);
        animateContentPosition(action, previousActionTop);
        if (continuousControls) {
          const previousControlsTop =
            interruptedControlsTop ??
            (previousContentOffsetsRef.current.controlsFromBottom === null
              ? null
              : previousBottom - previousContentOffsetsRef.current.controlsFromBottom);
          const previousControlsLeft =
            interruptedControlsLeft ??
            (previousContentOffsetsRef.current.controlsFromLeft === null
              ? null
              : animatedRect.left + previousContentOffsetsRef.current.controlsFromLeft);
          animateContentPosition(controls, previousControlsTop, previousControlsLeft);
        }
        contentAnimationsRef.current = contentAnimations;

        if (stateChanged) {
          const stateChangeAnimations: Animation[] = [];

          // A prompt that gains lines on expansion would otherwise slide up
          // from under the footer band as one block. Opening a bottom clip in
          // step with the tween instead unfurls the extra lines beneath the
          // rising first line, so no text crosses the returning controls.
          const previousPromptHeight = previousContentOffsetsRef.current.promptHeight;
          if (
            !nextIsCollapsed &&
            prompt &&
            nextPromptRect &&
            previousPromptHeight !== null &&
            nextPromptRect.height - previousPromptHeight >= 0.5
          ) {
            const hiddenHeight = nextPromptRect.height - previousPromptHeight;
            stateChangeAnimations.push(
              prompt.animate(
                [
                  { clipPath: `inset(0 0 ${String(hiddenHeight)}px 0)` },
                  { clipPath: "inset(0 0 0 0)" },
                ],
                {
                  duration,
                  easing: COMPOSER_RESTING_TRANSITION_EASING,
                },
              ),
            );
          }

          // The footer controls teleport between the composer footer and the
          // context strip below it in a single commit. Fading the arriving
          // cluster in along its direction of travel reads as one continuous
          // move instead of a pop. Collapsing controls land in empty strip
          // space and can appear immediately, but expanding controls return
          // to the bottom row the prompt still occupies while the surface is
          // short, so they stay hidden through the first half of the tween
          // and fade in once the geometry has mostly settled.
          const arrivingControls = nextIsCollapsed
            ? restingControlsRef.current
            : element.querySelector<HTMLElement>('[data-chat-composer-controls="left"]');
          if (arrivingControls && !continuousControls) {
            const drift = nextIsCollapsed
              ? -COMPOSER_RESTING_CONTROLS_ARRIVAL_DRIFT_PX
              : COMPOSER_RESTING_CONTROLS_ARRIVAL_DRIFT_PX;
            stateChangeAnimations.push(
              arrivingControls.animate(
                [
                  { opacity: 0, transform: `translateY(${String(drift)}px)` },
                  { opacity: 1, transform: "none" },
                ],
                {
                  duration: nextIsCollapsed ? duration : duration / 2,
                  delay: nextIsCollapsed ? 0 : duration / 2,
                  fill: "backwards",
                  easing: COMPOSER_RESTING_TRANSITION_EASING,
                },
              ),
            );
          }

          const arrivingImagePreviews = nextIsCollapsed
            ? Array.from(
                element.querySelectorAll<HTMLElement>('[data-chat-composer-resting-images="true"]'),
              )
            : Array.from(
                element.querySelectorAll<HTMLElement>('[data-chat-composer-expanded-image="true"]'),
              );
          for (const imagePreview of arrivingImagePreviews) {
            stateChangeAnimations.push(
              imagePreview.animate([{ opacity: 0 }, { opacity: 1 }], {
                duration: nextIsCollapsed ? duration : duration / 2,
                delay: nextIsCollapsed ? 0 : duration / 2,
                fill: "backwards",
                easing: COMPOSER_RESTING_TRANSITION_EASING,
              }),
            );
          }
          stateChangeAnimationsRef.current = stateChangeAnimations;
        }

        const finishTransition = (cancelAnimations: boolean) => {
          if (animationRef.current !== animation) return;
          if (transitionCleanupTimeoutRef.current !== null) {
            window.clearTimeout(transitionCleanupTimeoutRef.current);
            transitionCleanupTimeoutRef.current = null;
          }
          if (cancelAnimations) {
            animation.cancel();
            for (const contentAnimation of contentAnimationsRef.current) {
              contentAnimation.cancel();
            }
            for (const stateChangeAnimation of stateChangeAnimationsRef.current) {
              stateChangeAnimation.cancel();
            }
          }
          animationRef.current = null;
          animationTargetHeightRef.current = null;
          contentAnimationsRef.current = [];
          stateChangeAnimationsRef.current = [];
          animation.cancel();
          stripAnimation?.cancel();
          clearTransitionStyles();
        };
        void animation.finished.catch(() => undefined).then(() => finishTransition(false));
        // A suspended document timeline can leave `finished` pending while
        // these measurement styles remain active. Wall-clock cleanup makes
        // the natural layout the eventual source of truth in that case.
        transitionCleanupTimeoutRef.current = window.setTimeout(
          () => finishTransition(true),
          duration + COMPOSER_RESTING_TRANSITION_CLEANUP_BUFFER_MS,
        );
      } else {
        animationTargetHeightRef.current = null;
      }

      previousCollapsedRef.current = nextIsCollapsed;
      previousHeightRef.current = nextHeight;
      previousModelStripHeightRef.current = nextModelStripHeight;
      previousContentOffsetsRef.current = {
        promptFromTop: nextPromptTop === null ? null : nextPromptTop - nextRect.top,
        promptHeight: nextPromptRect?.height ?? null,
        actionFromBottom: nextActionTop === null ? null : nextRect.bottom - nextActionTop,
        controlsFromBottom: nextControlsTop === null ? null : nextRect.bottom - nextControlsTop,
        controlsFromLeft: nextControlsRect === null ? null : nextControlsRect.left - nextRect.left,
        surfaceBottomInset: overlayRect ? overlayRect.bottom - nextRect.bottom : null,
      };
    },
    [animationDurationMs, clearTransitionStyles, onOverlayHeightChange, restingControlsRef],
  );

  useLayoutEffect(() => {
    const requestId = transitionLayoutRequestRef.current + 1;
    transitionLayoutRequestRef.current = requestId;
    const stateChanged = previousCollapsedRef.current !== isCollapsed;
    // A non-Git context strip enters or leaves flow through ChatView state in
    // an earlier layout effect. Let React flush that parent update before the
    // FLIP reads its destination geometry, while still running before paint.
    queueMicrotask(() => {
      if (transitionLayoutRequestRef.current !== requestId) return;
      transitionToCurrentGeometry(stateChanged);
    });
    return () => {
      if (transitionLayoutRequestRef.current === requestId) {
        transitionLayoutRequestRef.current += 1;
      }
    };
  }, [isCollapsed, transitionToCurrentGeometry]);

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return;

    const body = element.querySelector<HTMLElement>('[data-chat-composer-body="true"]');
    return observeResize(body ? [element, body] : element, (entries) => {
      if (animationRef.current) {
        if (body && entries.some((entry) => entry.target === body)) {
          transitionToCurrentGeometry(false);
        }
        return;
      }
      const elementRect = element.getBoundingClientRect();
      const visibleTransitionElement = (selector: string) =>
        Array.from(element.querySelectorAll<HTMLElement>(selector)).find(
          (candidate) => candidate.getClientRects().length > 0,
        ) ?? null;
      const promptRect = visibleTransitionElement(
        '[data-composer-prompt-surface="true"], [data-chat-composer-transition-prompt="true"]',
      )?.getBoundingClientRect();
      const actionTop = visibleTransitionElement(
        '[data-chat-composer-transition-actions="true"]',
      )?.getBoundingClientRect().top;
      const controlsRect = (
        isCollapsedRef.current
          ? restingControlsRef.current
          : visibleTransitionElement('[data-chat-composer-controls="left"]')
      )?.getBoundingClientRect();
      previousHeightRef.current = elementRect.height;
      previousContentOffsetsRef.current = {
        promptFromTop: promptRect === undefined ? null : promptRect.top - elementRect.top,
        promptHeight: promptRect?.height ?? null,
        actionFromBottom: actionTop === undefined ? null : elementRect.bottom - actionTop,
        controlsFromBottom:
          controlsRect === undefined ? null : elementRect.bottom - controlsRect.top,
        controlsFromLeft: controlsRect === undefined ? null : controlsRect.left - elementRect.left,
        surfaceBottomInset:
          (element
            .closest<HTMLElement>('[data-chat-composer-overlay="true"]')
            ?.getBoundingClientRect().bottom ?? elementRect.bottom) - elementRect.bottom,
      };
    });
  }, [restingControlsRef, transitionToCurrentGeometry]);

  useEffect(() => {
    // Host discovery and width measurement settle through layout updates on
    // mount. Treat that bootstrap as initial geometry so an existing thread
    // paints at rest instead of visibly collapsing from the expanded height.
    hasCompletedInitialLayoutRef.current = true;
    return () => {
      if (transitionCleanupTimeoutRef.current !== null) {
        window.clearTimeout(transitionCleanupTimeoutRef.current);
        transitionCleanupTimeoutRef.current = null;
      }
      animationRef.current?.cancel();
      animationRef.current = null;
      animationTargetHeightRef.current = null;
      for (const animation of contentAnimationsRef.current) animation.cancel();
      contentAnimationsRef.current = [];
      for (const animation of stateChangeAnimationsRef.current) animation.cancel();
      stateChangeAnimationsRef.current = [];
      clearTransitionStyles();
    };
  }, [clearTransitionStyles]);

  return elementRef;
}

function composerCommandMenuPositionsEqual(
  a: ComposerCommandMenuPosition,
  b: ComposerCommandMenuPosition,
): boolean {
  return (
    a.bottom === b.bottom && a.left === b.left && a.maxHeight === b.maxHeight && a.width === b.width
  );
}

function ComposerCommandMenuLayer(props: { anchor: HTMLElement | null; children: ReactNode }) {
  const [position, setPosition] = useState<ComposerCommandMenuPosition | null>(null);

  useLayoutEffect(() => {
    const anchor = props.anchor;
    if (!anchor) {
      setPosition(null);
      return;
    }

    const updatePosition = () => {
      const form = anchor.closest<HTMLElement>('[data-chat-composer-form="true"]');
      const mainSurface = form?.querySelector<HTMLElement>(
        '[data-chat-composer-main-surface="true"]',
      );
      const rect = (mainSurface ?? form ?? anchor).getBoundingClientRect();
      const rootFontSizePx =
        Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16;
      const drawerInsetRem = Number.parseFloat(
        window.getComputedStyle(form ?? anchor).getPropertyValue("--chat-composer-drawer-inset"),
      );
      const drawerInset = drawerInsetRem * rootFontSizePx;
      const width = rect.width - drawerInset * 2;
      if (width <= 0) {
        setPosition(null);
        return;
      }
      // One extra pixel prevents fractional layout coordinates from exposing
      // the canvas between the drawer mask and the composer's foreground edge.
      // Mirrors --chat-composer-attachment-overlap: calc(1rem + 1px).
      const composerOverlap = rootFontSizePx + 1;
      const next = {
        bottom: window.innerHeight - rect.top - composerOverlap,
        left: rect.left + drawerInset,
        maxHeight: Math.max(96, rect.top - 24 + composerOverlap),
        width,
      };
      setPosition((current) =>
        current && composerCommandMenuPositionsEqual(current, next) ? current : next,
      );
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);

    // The composer is centered and capped at a max width, so opening a side
    // panel slides it sideways without ever resizing it. Watching the anchor
    // alone would leave the menu behind; the ancestors are what shrink.
    const observed: Element[] = [anchor];
    for (let element = anchor.parentElement; element; element = element.parentElement) {
      observed.push(element);
    }
    const stopObserving = observeResize(observed, updatePosition);
    // The composer glides on a transform when a panel toggles.
    const stopFollowingPanels = subscribePanelMotion(updatePosition);

    return () => {
      stopObserving();
      stopFollowingPanels();
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [props.anchor]);

  if (!position) return null;

  return createPortal(
    <div
      className="pointer-events-auto fixed z-40 flex flex-col"
      data-composer-drawer-layer="true"
      style={{
        bottom: position.bottom,
        left: position.left,
        maxHeight: position.maxHeight,
        width: position.width,
      }}
    >
      {props.children}
    </div>,
    document.body,
  );
}

/**
 * Keeps the command menu mounted while it sinks back behind the composer, on the same frame as
 * the attached notices (200ms, clipped at the seam, opacity settling over the last 40%, opacity
 * only under reduced motion). The last menu stays drawn, inert, until the exit finishes; reopening
 * mid-exit takes over the same frame from where it is.
 */
function ComposerCommandMenuPresence(props: {
  anchor: HTMLElement | null;
  show: boolean;
  children: ReactNode;
}) {
  const heldRef = useRef<ReactNode>(null);
  const [present, setPresent] = useState(props.show);
  if (props.show) {
    heldRef.current = props.children;
    if (!present) setPresent(true);
  }
  // A menu already up when the composer mounts is just there.
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
  }, []);
  const onClosed = useCallback(() => {
    heldRef.current = null;
    setPresent(false);
  }, []);

  if (!present) return null;
  return (
    <ComposerCommandMenuLayer anchor={props.anchor}>
      <NoticePresenceFrame
        open={props.show}
        swapKey={null}
        animateMountRef={mountedRef}
        onClosed={onClosed}
      >
        <div data-notice-current="" aria-hidden={props.show ? undefined : true} inert={!props.show}>
          {heldRef.current}
        </div>
      </NoticePresenceFrame>
    </ComposerCommandMenuLayer>
  );
}

const WORKSPACE_SNAPSHOT_RETRY_COOLDOWN_MS = 10_000;

const extendReplacementRangeForTrailingSpace = (
  text: string,
  rangeEnd: number,
  replacement: string,
): number => {
  if (!replacement.endsWith(" ")) {
    return rangeEnd;
  }
  return text[rangeEnd] === " " ? rangeEnd + 1 : rangeEnd;
};

/**
 * Decide which resting controls fold into overflow. With `dictationRecording`
 * set, the dictation control beside the controls is judged in the same pass
 * (resolveComposerDictationFit): its waveform's width is reserved up front.
 */
function useRestingComposerControlsLayout(
  host: HTMLDivElement | null,
  useControlsAsHost = false,
  dictationRecording?: boolean,
) {
  // Kept while the composer's view is hidden (useElementState), so a mode
  // switch does not re-render the composer to detach and reattach it.
  const [controls, setControls] = useElementState<HTMLDivElement>();
  const controlsRef = useRef<HTMLDivElement>(null);
  const attachControls = useCallback(
    (element: HTMLDivElement | null) => {
      controlsRef.current = element;
      setControls(element);
    },
    [setControls],
  );
  const hostRef = useRef(host);
  hostRef.current = host;
  const [layout, setLayout] = useState<{
    hiddenCount: number;
    iconOnlyCount?: number;
    visible: boolean;
  }>({ hiddenCount: 0, visible: true });
  const [dictationWaveform, setDictationWaveform] = useState<ComposerDictationWaveformSize>("full");

  const measure = useCallback(() => {
    const currentHost = useControlsAsHost ? controls : hostRef.current;
    if (currentHost === null || !controls) return;

    const measurement = measureRestingComposerControls(controls);
    if (!measurement) return;
    const style = getComputedStyle(currentHost);
    let hostWidth =
      currentHost.clientWidth -
      (Number.parseFloat(style.paddingInlineStart) || 0) -
      (Number.parseFloat(style.paddingInlineEnd) || 0);
    const dictationClip =
      dictationRecording === undefined
        ? null
        : controls.parentElement?.querySelector<HTMLElement>("[data-composer-dictation-clip]");
    if (dictationClip) {
      const fit = resolveComposerDictationFit({
        controls: measurement,
        hostWidth,
        renderedClipWidth: dictationClip.getBoundingClientRect().width,
        recording: dictationRecording === true,
      });
      hostWidth = fit.hostWidth;
      setDictationWaveform(fit.waveform);
    }

    setLayout((current) => {
      const next = resolveRestingComposerControlsLayout({
        ...measurement,
        hostWidth,
        previous: current,
      });
      return next.hiddenCount === current.hiddenCount &&
        next.iconOnlyCount === current.iconOnlyCount &&
        next.visible === current.visible
        ? current
        : next;
    });
  }, [controls, useControlsAsHost, dictationRecording]);

  useLayoutEffect(measure, [measure, host]);
  useEffect(() => {
    const currentHost = useControlsAsHost ? controls : host;
    if (!currentHost || !controls) return;
    let stopObserving = () => {};
    const observeControls = () => {
      stopObserving();
      stopObserving = observeResize(
        [
          currentHost,
          controls,
          ...controls.querySelectorAll<HTMLElement>(
            "[data-resting-block], [data-composer-control-label], [data-chat-provider-model-picker-label]",
          ),
        ],
        measure,
      );
      measure();
    };
    observeControls();
    const mutations = new MutationObserver(observeControls);
    mutations.observe(controls, { childList: true, subtree: true, characterData: true });
    document.fonts.addEventListener("loadingdone", measure);
    return () => {
      stopObserving();
      mutations.disconnect();
      document.fonts.removeEventListener("loadingdone", measure);
    };
  }, [host, controls, useControlsAsHost, measure]);

  return {
    controlsRef,
    attachControls,
    hiddenBlockCount: layout.hiddenCount,
    iconOnlyBlockCount: layout.iconOnlyCount ?? 0,
    controlsVisible: layout.visible,
    dictationWaveform,
  };
}

const ComposerFooterModeControls = memo(function ComposerFooterModeControls(props: {
  interactionMode: ProviderInteractionMode;
  size?: "sm" | "xs";
  onToggleInteractionMode: () => void;
}) {
  const size = props.size ?? "sm";
  const interactionModeTooltip =
    props.interactionMode === "plan"
      ? "Plan mode — click to return to normal build mode"
      : "Default mode — click to enter plan mode";

  return (
    <>
      <ComposerControlSeparator size={size} />
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerControl
              size={size}
              className="shrink-0 whitespace-nowrap"
              aria-pressed={props.interactionMode === "plan"}
              type="button"
              onClick={props.onToggleInteractionMode}
              aria-label={interactionModeTooltip}
            />
          }
        >
          {props.interactionMode === "plan" ? (
            <ComposerControlIcon
              icon={PencilRulerIcon}
              size={size}
              className="text-current opacity-100"
            />
          ) : (
            <ComposerControlIcon
              icon={BotIcon}
              size={size}
              opticalSize={size === "xs" ? "default" : "large"}
            />
          )}
          <span data-composer-control-label className="sr-only sm:not-sr-only">
            {props.interactionMode === "plan" ? "Plan" : "Build"}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="top">{interactionModeTooltip}</TooltipPopup>
      </Tooltip>
    </>
  );
});

const ComposerFooterPrimaryActions = memo(function ComposerFooterPrimaryActions(props: {
  compact: boolean;
  canOperateThread: boolean;
  activeContextWindow: ContextWindowSnapshot | null;
  reserveContextWindowMeter: boolean;
  activeThreadModelDisplayName: string | null;
  isPreparingWorktree: boolean;
  pendingAction: {
    questionIndex: number;
    isLastQuestion: boolean;
    canAdvance: boolean;
    isResponding: boolean;
    isComplete: boolean;
  } | null;
  isRunning: boolean;
  canInterrupt: boolean;
  followUpBehavior: "queue" | "steer";
  alternateShortcutLabel: string | null;
  showPlanFollowUpPrompt: boolean;
  promptHasText: boolean;
  isSendBusy: boolean;
  sendDisabledReason: string | null;
  isConnecting: boolean;
  isEnvironmentUnavailable: boolean;
  hasSendableContent: boolean;
  canResume: boolean;
  preserveComposerFocusOnPointerDown?: boolean;
  isEditingQueuedMessage: boolean;
  onSubmitMessage: React.MouseEventHandler<HTMLButtonElement>;
  onResume: () => void;
  onPreviousPendingQuestion: () => void;
  onInterrupt: () => void;
  onImplementPlanInNewThread: () => void;
  onCompactContext?: (() => void) | undefined;
  compactDisabled: boolean;
  compactDisabledReason: string | null;
  compactBeforeSendTokens: number | null;
  keepFullHistory: boolean;
  onToggleKeepFullHistory: () => void;
  threadKey: string | null;
}) {
  return (
    <>
      {props.activeContextWindow ? (
        <ContextWindowMeter
          usage={props.activeContextWindow}
          modelDisplayName={props.activeThreadModelDisplayName}
          onCompact={props.onCompactContext}
          compactDisabled={props.compactDisabled}
          compactDisabledReason={props.compactDisabledReason}
        />
      ) : props.reserveContextWindowMeter ? (
        <ContextWindowMeterPlaceholder />
      ) : null}
      <ComposerPrimaryActions
        compact={props.compact}
        canOperateThread={props.canOperateThread}
        pendingAction={props.pendingAction}
        isRunning={props.isRunning}
        canInterrupt={props.canInterrupt}
        followUpBehavior={props.followUpBehavior}
        alternateShortcutLabel={props.alternateShortcutLabel}
        showPlanFollowUpPrompt={props.showPlanFollowUpPrompt}
        promptHasText={props.promptHasText}
        isSendBusy={props.isSendBusy}
        sendDisabledReason={props.sendDisabledReason}
        isConnecting={props.isConnecting}
        isEnvironmentUnavailable={props.isEnvironmentUnavailable}
        isPreparingWorktree={props.isPreparingWorktree}
        hasSendableContent={props.hasSendableContent}
        canResume={props.canResume}
        preserveComposerFocusOnPointerDown={props.preserveComposerFocusOnPointerDown ?? false}
        isEditingQueuedMessage={props.isEditingQueuedMessage}
        onSubmitMessage={props.onSubmitMessage}
        onResume={props.onResume}
        onPreviousPendingQuestion={props.onPreviousPendingQuestion}
        onInterrupt={props.onInterrupt}
        onImplementPlanInNewThread={props.onImplementPlanInNewThread}
        compactBeforeSendTokens={props.compactBeforeSendTokens}
        keepFullHistory={props.keepFullHistory}
        onToggleKeepFullHistory={props.onToggleKeepFullHistory}
        threadKey={props.threadKey}
      />
    </>
  );
});

// --------------------------------------------------------------------------
// Handle exposed to ChatView
// --------------------------------------------------------------------------

export interface ChatComposerHandle {
  focusAtEnd: () => void;
  focusAt: (cursor: number) => void;
  addDroppedFiles: (files: File[]) => void;
  addDroppedFolders: (folders: File[]) => void;
  hasPendingAttachments: () => boolean;
  insertTextAtEnd: (
    text: string,
    options?: { ensureLeadingBoundary?: boolean; clipboardData?: DataTransfer },
  ) => boolean;
  /** Apply large-paste folding for text redirected from a blurred composer. */
  pasteTextAtEnd: (text: string, options?: { bypassAutoAttachment?: boolean }) => boolean;
  citeAssistantText: (
    citation: AssistantCitation,
    sourceAnchor: AssistantCitationSourceAnchor,
  ) => boolean;
  openModelPicker: () => void;
  toggleModelPicker: () => void;
  openControl: (command: KeybindingCommand) => void;
  isModelPickerOpen: () => boolean;
  /** True when a collapsed caret sits before everything in the draft, including when it is empty. */
  isCaretAtStart: () => boolean;
  compactContext: () => void;
  readSnapshot: () => {
    value: string;
    cursor: number;
    expandedCursor: number;
    contextIds: string[];
  };
  /** Reset composer cursor/trigger/highlight after external prompt mutations (e.g. onSend). */
  resetCursorState: (options?: {
    cursor?: number;
    prompt?: string;
    detectTrigger?: boolean;
  }) => void;
  /** Insert a terminal context from the terminal drawer. */
  addTerminalContext: (selection: TerminalContextSelection) => void;
  /** Get the current prompt/effort/model state for use in send. */
  getSendContext: () => {
    answeringPendingUserInput: boolean;
    prompt: string;
    images: ComposerImageAttachment[];
    files: ComposerFileAttachment[];
    terminalContexts: TerminalContextDraft[];
    previewAnnotations: PreviewAnnotationPayload[];
    reviewComments: ReviewCommentContext[];
    threadContexts: LinkContextRecord[];
    selectedPromptEffort: string | null;
    selectedModelOptionsForDispatch: unknown;
    selectedModelSelection: ModelSelection;
    multipleModelSelections: ReadonlyArray<ModelSelection> | null;
    providerAvailable: boolean;
    selectedProvider: ProviderDriverKind;
    selectedModel: string;
    selectedProviderModels: ReadonlyArray<ServerProvider["models"][number]>;
    interactionMode: ProviderInteractionMode;
    interactionModeEnabled: boolean;
  };
  /** Validate the fully composed text immediately before a provider turn starts. */
  validateProviderInput: (providerInput: string) => boolean;
  setMultipleModelSelections: (selections: ReadonlyArray<ModelSelection>) => void;
}

// --------------------------------------------------------------------------
// Props
// --------------------------------------------------------------------------

export interface ChatComposerProps {
  composerDraftTarget: ScopedThreadRef | DraftId;
  environmentId: EnvironmentId;
  canOperateThread: boolean;
  attachmentUploadsCapabilityKnown: boolean;
  supportsAttachmentUploads: boolean;
  supportsQuestionAttachments: boolean;
  maxFileAttachmentBytes: number | null;
  routeKind: "server" | "draft";
  routeThreadRef: ScopedThreadRef;
  draftId: DraftId | null;
  multipleModelSelections: ReadonlyArray<ModelSelection> | null;
  supportsMultipleModels: boolean;
  onMultipleModelSelectionsChange: React.Dispatch<
    React.SetStateAction<ReadonlyArray<ModelSelection> | null>
  >;

  // Thread context
  activeThreadId: ThreadId | null;
  activeThreadEnvironmentId: EnvironmentId | undefined;
  activeThread: Thread | undefined;
  /** The routed server thread's shell, present before its detail loads. */
  activeThreadShell: ThreadShell | null;
  /** Timeline messages including optimistic sends, for ArrowUp prompt recall. */
  promptHistoryMessages: ReadonlyArray<ChatMessage>;
  isServerThread: boolean;
  isLocalDraftThread: boolean;
  forceExpandedOnMobile: boolean;
  projectSelectionRequired: boolean;

  // Session phase
  phase: SessionPhase;
  /** Stop is offered: a run is preparing, starting, or running. */
  canInterrupt: boolean;
  isConnecting: boolean;
  isSendBusy: boolean;
  canResume: boolean;
  isRevertingCheckpoint?: boolean;
  sendDisabledReason: string | null;
  isPreparingWorktree: boolean;
  bannerItems: readonly (ComposerBannerStackItem | ComposerBannerStackContent)[];
  /** Tokens a stale session would re-read; null when the thread is not offered compaction. */
  resumeCompactionTokens: number | null;
  /** The Compact chip is off, so the next send keeps full history. */
  keepFullHistory: boolean;
  /** Flips the Compact chip for the active thread. */
  onToggleKeepFullHistory: () => void;
  /** Picking /usage-limits from the menu is the action itself; the draft keeps nothing of it. */
  onUsageLimitsCommand?: (() => void) | undefined;
  environmentUnavailable: {
    readonly label: string;
    readonly connection: EnvironmentConnectionPresentation;
  } | null;
  /**
   * The unavailable environment is still connecting and nothing has failed:
   * send stays blocked, but the composer reads "Connecting", not disconnected.
   */
  environmentConnecting?: boolean;

  // Pending approvals / inputs
  activePendingApproval: PendingApproval | null;
  pendingApprovals: PendingApproval[];
  pendingUserInputs: PendingUserInput[];
  activePendingProgress: {
    questionIndex: number;
    isLastQuestion: boolean;
    canAdvance: boolean;
    customAnswer: string;
    activeQuestion: {
      id: string;
      initialAnswer?: string | undefined;
      multiSelect?: boolean | undefined;
      allowCustomAnswer?: boolean | undefined;
    } | null;
  } | null;
  activePendingResolvedAnswers: Record<string, unknown> | null;
  activePendingIsResponding: boolean;
  activePendingDraftAnswers: Record<string, PendingUserInputDraftAnswer>;
  activePendingQuestionIndex: number;
  respondingRequestIds: RuntimeRequestId[];

  // Plan
  showPlanFollowUpPrompt: boolean;
  activeProposedPlan: LatestProposedPlanState | null;
  activeTasksProgress: ComposerTasksProgress | null;
  activeTaskSteps: readonly ComposerTaskStep[] | null;
  threadSyncPhase: ThreadSyncPhase | null;

  // Mode
  interactionMode: ProviderInteractionMode;

  // Provider / model
  lockedProvider: ProviderDriverKind | null;
  providerStatuses: ServerProvider[];
  /** False until the environment's server config has arrived at least once. */
  providerCatalogKnown: boolean;
  activeProjectDefaultModelSelection: ModelSelection | null | undefined;
  activeThreadModelSelection: ModelSelection | null | undefined;
  /** The driver the thread ran on, kept when its exact instance is missing here. */
  activeThreadDriverKind?: ProviderDriverKind | null;
  reportedModelSelection?: ModelSelection | null;
  /**
   * Reports the selection a send would dispatch (null while no provider can
   * take it), so the timeline's pending-handoff preview matches the composer.
   */
  onSendModelSelectionChange: (selection: ModelSelection | null) => void;
  /** The active project, so the picker can fold in its provider instance overrides. */
  activeProjectId: ProjectId | null;

  // Context window
  activeContextWindow: ContextWindowSnapshot | null;
  compactThreadUnavailable: boolean;
  compactDisabled: boolean;
  compactDisabledReason: string | null;

  // Misc
  resolvedTheme: "light" | "dark";
  settings: UnifiedSettings;
  keybindings: ResolvedKeybindingsConfig;
  gitCwd: string | null;
  pullRequestProjectId: ProjectId | null;
  pullRequestRepository: string | null;
  /** The thread's linked pull requests, offered in `#` suggestions from any repository. */
  threadPullRequests: ReadonlyArray<ThreadPullRequestLink> | undefined;
  restingControlsHost: HTMLDivElement | null;
  restingControlsHaveLeadingContext: boolean;
  onRestingControlsVisibilityChange: (visible: boolean) => void;
  onComposerOverlayHeightChange: (height: number) => void;

  // Refs the parent needs kept in sync
  promptRef: React.RefObject<string>;
  composerImagesRef: React.RefObject<ComposerImageAttachment[]>;
  composerFilesRef: React.RefObject<ComposerFileAttachment[]>;
  composerTerminalContextsRef: React.RefObject<TerminalContextDraft[]>;
  composerRef: React.RefObject<ChatComposerHandle | null>;
  onPageScrollKeyDown: (key: "PageUp" | "PageDown") => void;
  onPageScrollKeyUp: (key: string) => void;
  onPageScrollRelease: () => void;

  // Queued runs strip rendered above the composer (v2 queue/steer).
  queuedRunsControl?: ReactNode;
  // Queued-message edit mode: attachments already stored on the message being
  // edited. Rendered in the attachment strip with a remove control; removal is
  // client state in ChatView until the edit is saved.
  editingQueuedAttachments: ReadonlyArray<{
    readonly attachment: ContractChatAttachment;
    readonly url: string | null;
  }> | null;
  onRemoveEditingQueuedAttachment: (attachmentId: string) => void;

  // Callbacks
  onCompactContext: () => void;
  onSend: (
    e?: { preventDefault: () => void },
    dispatchMode?: ComposerDispatchMode,
    submissionIntent?: ComposerSubmissionIntent,
  ) => void;
  onResume: () => void;
  onInterrupt: () => void;
  onImplementPlanInNewThread: () => void;
  onRespondToApproval: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
  onSelectActivePendingUserInputOption: (questionId: string, optionValue: string) => void;
  onAdvanceActivePendingUserInput: () => void;
  onDismissActivePendingUserInput: (requestId: RuntimeRequestId) => void;
  onPreviousActivePendingUserInputQuestion: () => void;
  onChangeActivePendingUserInputCustomAnswer: (
    questionId: string,
    value: string,
    nextCursor: number,
    expandedCursor: number,
    cursorAdjacentToMention: boolean,
  ) => void;

  onProviderModelSelect: (
    instanceId: ProviderInstanceId,
    model: string,
    options?: { focusComposer?: boolean },
  ) => void;
  onOpenProviderSetup: (instanceId: ProviderInstanceId) => void;
  getModelDisabledReason: (instanceId: ProviderInstanceId, model: string) => string | null;
  toggleInteractionMode: () => void;
  handleInteractionModeChange: (mode: ProviderInteractionMode) => void;
  /** Use a conversational placeholder for chat threads. */
  isChat: boolean;
  /** Deprecated compatibility field; every thread runs with full access. */
  runtimeMode: RuntimeMode;
  handleRuntimeModeChange: (mode: RuntimeMode) => void;

  focusComposer: () => void;
  scheduleComposerFocus: () => void;
  setThreadError: (threadId: ThreadId | null, error: string | null) => void;
  onExpandImage: (preview: ExpandedImagePreview) => void;
  onFileOpen: (attachment: ChatFileAttachment) => void;
}

// --------------------------------------------------------------------------
// Component
// --------------------------------------------------------------------------

export const ChatComposer = memo(function ChatComposer(props: ChatComposerProps) {
  const {
    composerDraftTarget,
    environmentId,
    canOperateThread,
    attachmentUploadsCapabilityKnown,
    supportsAttachmentUploads,
    supportsQuestionAttachments,
    maxFileAttachmentBytes,
    routeKind,
    routeThreadRef,
    draftId,
    multipleModelSelections,
    supportsMultipleModels,
    onMultipleModelSelectionsChange: setMultipleModelSelections,
    activeThreadId,
    activeThreadEnvironmentId: _activeThreadEnvironmentId,
    activeThread,
    promptHistoryMessages,
    isServerThread: _isServerThread,
    isLocalDraftThread: _isLocalDraftThread,
    forceExpandedOnMobile,
    projectSelectionRequired,
    phase,
    canInterrupt,
    isConnecting,
    isSendBusy,
    canResume,
    isRevertingCheckpoint = false,
    sendDisabledReason: externalSendDisabledReason,
    isPreparingWorktree,
    environmentUnavailable,
    environmentConnecting = false,
    pendingUserInputs: incomingPendingUserInputs,
    activePendingProgress: incomingPendingProgress,
    activePendingResolvedAnswers,
    activePendingIsResponding: incomingPendingIsResponding,
    activePendingDraftAnswers,
    activePendingQuestionIndex,
    respondingRequestIds,
    showPlanFollowUpPrompt,
    activeProposedPlan,
    interactionMode: requestedInteractionMode,
    lockedProvider,
    providerStatuses,
    providerCatalogKnown,
    activeProjectDefaultModelSelection,
    activeThreadModelSelection,
    activeThreadDriverKind,
    reportedModelSelection,
    onSendModelSelectionChange,
    activeProjectId,
    activeContextWindow,
    compactThreadUnavailable,
    compactDisabled,
    compactDisabledReason,
    resolvedTheme,
    settings,
    keybindings,
    gitCwd,
    pullRequestProjectId,
    pullRequestRepository,
    threadPullRequests,
    restingControlsHost,
    restingControlsHaveLeadingContext,
    onRestingControlsVisibilityChange,
    onComposerOverlayHeightChange,
    promptRef,
    composerRef,
    composerImagesRef,
    composerFilesRef,
    composerTerminalContextsRef,
    onPageScrollKeyDown,
    onPageScrollKeyUp,
    onPageScrollRelease,
    onCompactContext,
    onSend,
    onResume,
    onInterrupt,
    onImplementPlanInNewThread,
    onSelectActivePendingUserInputOption,
    onAdvanceActivePendingUserInput,
    onDismissActivePendingUserInput,
    onPreviousActivePendingUserInputQuestion,
    onChangeActivePendingUserInputCustomAnswer,
    onProviderModelSelect,
    onOpenProviderSetup,
    getModelDisabledReason,
    toggleInteractionMode,
    handleInteractionModeChange,
    isChat,
    focusComposer,
    scheduleComposerFocus,
    setThreadError,
    onExpandImage,
    onFileOpen,
    editingQueuedAttachments,
    onRemoveEditingQueuedAttachment,
  } = props;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const composerDraftTargetKey = composerTargetKey(composerDraftTarget);
  const {
    heldRequestIds,
    onDraftChange: onTypingGuardDraftChange,
    onFocus: onTypingGuardFocus,
    onBlur: onTypingGuardBlur,
    onSend: onTypingGuardSend,
  } = useComposerTypingGuard(
    composerDraftTargetKey,
    incomingPendingUserInputs.map((request) => request.requestId),
  );
  // Hold composer takeover while the user finishes their thread draft.
  const holdingUserInput = incomingPendingUserInputs[0]
    ? heldRequestIds.has(incomingPendingUserInputs[0].requestId)
    : false;
  const pendingUserInputs = holdingUserInput ? [] : incomingPendingUserInputs;
  const activePendingProgress = holdingUserInput ? null : incomingPendingProgress;
  const activePendingIsResponding = !holdingUserInput && incomingPendingIsResponding;
  const isLiteralPendingAnswer = activePendingProgress?.activeQuestion?.initialAnswer !== undefined;
  // Opening a running thread resyncs for a few frames. Show the sync row, and
  // hide the tasks row for it, only when the sync lasts. Logic that depends on
  // the real phase keeps reading `props.threadSyncPhase`.
  const shownSyncPhase = useDelayedStatus(composerDraftTargetKey, props.threadSyncPhase);
  const activeTasksProgress = shownSyncPhase === null ? props.activeTasksProgress : null;
  const activeTaskSteps = shownSyncPhase === null ? props.activeTaskSteps : null;
  const isEditingQueuedMessage = editingQueuedAttachments !== null;
  // ------------------------------------------------------------------
  // Store subscriptions (prompt / images / terminal contexts)
  // ------------------------------------------------------------------
  const composerDraft = useComposerThreadDraft(composerDraftTarget);
  // Live target key, for async flows that must notice a thread switch that
  // happened while they awaited.
  const composerDraftTargetKeyRef = useRef("");
  composerDraftTargetKeyRef.current = composerDraftTargetKey;
  const questionAttachmentTarget =
    pendingUserInputs[0] && activePendingProgress?.activeQuestion
      ? questionAttachmentDraftId(
          environmentId,
          activeThreadId!,
          pendingUserInputs[0].requestId,
          activePendingProgress.activeQuestion.id,
        )
      : null;
  const attachmentDraftTarget = questionAttachmentTarget ?? composerDraftTarget;
  const attachmentDraft = useComposerThreadDraft(attachmentDraftTarget);
  const attachmentTargetKey = composerTargetKey(attachmentDraftTarget);
  // An import that finishes after a draft change must compare against the draft open *now*, not
  // the one captured in the closure that started it.
  const attachmentTargetKeyRef = useRef(attachmentTargetKey);
  attachmentTargetKeyRef.current = attachmentTargetKey;
  const questionPreparations = useQuestionAttachmentPreparation((state) => state.counts);
  const prompt = composerDraft.prompt;
  const composerImages = attachmentDraft.images;
  const composerFiles = attachmentDraft.files;
  // A question answer has no chips: its files live in the question draft and show in the
  // strip. Only the thread prompt's references decide which files leave the strip.
  const inlineFileIdSet = useMemo(() => {
    if (questionAttachmentTarget) return new Set<string>();
    const contextIds = new Set(collectInlineContextIds(prompt));
    return new Set(
      composerFiles
        .filter((file) => contextIds.has(toKindScopedComposerContextId("file", file.id)))
        .map((file) => file.id),
    );
  }, [composerFiles, prompt, questionAttachmentTarget]);
  const composerVideos = composerFiles.filter((file) =>
    isPreviewableComposerVideo(file, environmentId),
  );
  const composerOtherFiles = composerOtherFilesForPresentation(
    composerFiles,
    environmentId,
    inlineFileIdSet,
  );
  const composerTerminalContexts = composerDraft.terminalContexts;
  const composerPreviewAnnotations = composerDraft.previewAnnotations;
  const composerReviewComments = composerDraft.reviewComments;
  const composerThreadContexts = attachmentDraft.threadContexts;
  const standaloneComposerImages = useMemo(() => {
    const previewAnnotationIds = new Set(
      composerPreviewAnnotations.map((annotation) => annotation.id),
    );
    return composerImages.filter((image) => !previewAnnotationIds.has(image.id));
  }, [composerImages, composerPreviewAnnotations]);
  const nonPersistedComposerImageIds = attachmentDraft.nonPersistedImageIds;
  const uploadsByImageId = useAttachmentUploadStore((state) => state.uploadsByImageId);
  const openPrLink = useOpenPrLink(routeThreadRef);
  const [previewFileId, setPreviewFileId] = useState<string | null>(null);
  const previewFile = composerFiles.find((file) => file.id === previewFileId);
  const composerContextActions = useMemo(
    () => ({
      environmentId,
      cwd: gitCwd ?? undefined,
      expandImage: (imageId: string) => {
        const preview = buildExpandedImagePreview(composerImages, imageId);
        if (preview) onExpandImage(preview);
      },
      openFile: setPreviewFileId,
      openMention: (path: string) => useRightPanelStore.getState().openFile(routeThreadRef, path),
      expandVideo: (fileId: string) => {
        const file = composerFiles.find((candidate) => candidate.id === fileId);
        if (!file || !isVideoAttachment(file)) return;
        const localPreview = buildExpandedImagePreview([file], file.id);
        if (localPreview) {
          onExpandImage(localPreview);
          return;
        }
        if (file.uploadedAttachmentId === undefined || file.uploadEnvironmentId !== environmentId) {
          return;
        }
        const persistedPreview = buildAttachmentVideoPreview(environmentId, {
          type: "file",
          id: file.uploadedAttachmentId,
          name: file.name,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
        });
        if (persistedPreview) onExpandImage(persistedPreview);
      },
      openPullRequest: (event: React.MouseEvent<HTMLElement>, url: string) => {
        openPrLink(event, url);
      },
    }),
    [
      composerFiles,
      composerImages,
      gitCwd,
      environmentId,
      onExpandImage,
      openPrLink,
      routeThreadRef,
    ],
  );
  const composerContextRecords = useMemo(
    () =>
      composerContextRecordsFromDraft({
        terminalContexts: composerTerminalContexts,
        reviewComments: composerReviewComments,
        previewAnnotations: composerPreviewAnnotations,
        threadContexts: composerThreadContexts,
        images: composerImages,
        files: composerFiles,
        uploadsByImageId,
      }),
    [
      composerFiles,
      composerImages,
      composerPreviewAnnotations,
      composerReviewComments,
      composerTerminalContexts,
      composerThreadContexts,
      uploadsByImageId,
    ],
  );
  const needsReattachFileCount = composerFiles.filter(composerFileNeedsReattach).length;
  const fileStagingLimit = fileAttachmentStagingLimit({
    attachmentUploadsCapabilityKnown,
    supportsAttachmentUploads,
    maxFileAttachmentBytes,
  });
  const fileCapabilityBlockReason = fileAttachmentCapabilityBlockReason({
    files: composerFiles,
    attachmentUploadsCapabilityKnown,
    supportsAttachmentUploads,
    maxFileAttachmentBytes,
  });
  const attachmentBlockReason =
    (questionAttachmentTarget &&
    !supportsQuestionAttachments &&
    (composerImages.length > 0 || composerFiles.length > 0)
      ? "Update this server to send files with question answers"
      : null) ??
    fileCapabilityBlockReason ??
    (supportsAttachmentUploads
      ? needsReattachFileCount > 0
        ? needsReattachFileCount === 1
          ? "Attach the interrupted file again or remove it"
          : "Attach the interrupted files again or remove them"
        : attachmentUploadBlockReason({
            imageIds: [...composerImages, ...composerFiles].map((attachment) => attachment.id),
            uploadsByImageId,
            environmentId,
          })
      : null);
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
  const removeComposerDraftImage = useComposerDraftStore((store) => store.removeImage);
  const replaceComposerDraftImage = useComposerDraftStore((store) => store.replaceImage);
  const [markupImageId, setMarkupImageId] = useState<string | null>(null);
  const markupImage = composerImages.find((image) => image.id === markupImageId) ?? null;
  const markupSessionsByImageId = useImageMarkupSessionStore((state) => state.sessionsByImageId);
  const addComposerDraftFiles = useComposerDraftStore((store) => store.addFiles);
  const removeComposerDraftFile = useComposerDraftStore((store) => store.removeFile);
  const setComposerDraftFileUpload = useComposerDraftStore((store) => store.setFileUpload);
  const insertComposerDraftTerminalContext = useComposerDraftStore(
    (store) => store.insertTerminalContext,
  );
  const setComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.setTerminalContexts,
  );
  const removeComposerDraftPreviewAnnotation = useComposerDraftStore(
    (store) => store.removePreviewAnnotation,
  );
  const removeComposerDraftReviewComment = useComposerDraftStore(
    (store) => store.removeReviewComment,
  );
  const clearComposerDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.clearPersistedAttachments,
  );
  const syncComposerDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.syncPersistedAttachments,
  );
  const getComposerDraft = useComposerDraftStore((store) => store.getComposerDraft);

  useEffect(() => {
    if (!attachmentUploadsCapabilityKnown) {
      return;
    }
    if (!supportsAttachmentUploads) {
      // The capability can flap on reconnect or version skew. Deleting a
      // persisted hydrated upload here would make the next send fail
      // verification while the file still sits in the draft.
      for (const attachment of attachmentsToReleaseOnUploadCapabilityLoss([
        ...composerImages,
        ...composerFiles,
      ])) {
        releaseAttachmentUpload(attachment.id);
      }
      return;
    }
    if (!canOperateThread) return;
    const invalidFiles =
      maxFileAttachmentBytes === null
        ? composerFiles
        : composerFiles.filter((file) => file.sizeBytes > maxFileAttachmentBytes);
    for (const attachment of attachmentsToReleaseOnUploadCapabilityLoss(invalidFiles)) {
      releaseAttachmentUpload(attachment.id);
    }
    const uploadableFiles =
      maxFileAttachmentBytes === null
        ? []
        : composerFiles.filter((file) => file.sizeBytes <= maxFileAttachmentBytes);
    const uploadableAttachments = [...composerImages, ...uploadableFiles];
    for (const attachment of uploadableAttachments) {
      // A needs-reattach file has no bytes to upload and no upload to verify.
      if (attachment.type === "file" && composerFileNeedsReattach(attachment)) {
        continue;
      }
      startAttachmentUpload({
        environmentId,
        image: attachment,
        draftTarget: attachmentDraftTarget,
      });
    }
  }, [
    attachmentUploadsCapabilityKnown,
    attachmentDraftTarget,
    canOperateThread,
    composerFiles,
    composerImages,
    environmentId,
    maxFileAttachmentBytes,
    supportsAttachmentUploads,
  ]);

  useEffect(() => {
    for (const file of composerFiles) {
      if (
        !attachmentUploadsCapabilityKnown ||
        !supportsAttachmentUploads ||
        maxFileAttachmentBytes === null ||
        file.sizeBytes > maxFileAttachmentBytes
      ) {
        continue;
      }
      const upload = uploadsByImageId[file.id];
      if (upload?.status === "ready" && upload.environmentId === environmentId) {
        setComposerDraftFileUpload(
          attachmentDraftTarget,
          file.id,
          environmentId,
          upload.attachmentId,
        );
      }
    }
  }, [
    attachmentUploadsCapabilityKnown,
    attachmentDraftTarget,
    composerFiles,
    environmentId,
    maxFileAttachmentBytes,
    setComposerDraftFileUpload,
    supportsAttachmentUploads,
    uploadsByImageId,
  ]);

  // ------------------------------------------------------------------
  // Model state
  // ------------------------------------------------------------------
  // Instance-aware projection of the wire provider list. One entry per
  // configured instance (default built-in + any custom `providerInstances.*`),
  // sorted default-first per driver kind for a stable picker order.
  const providerInstanceEntries = useMemo<ReadonlyArray<ProviderInstanceEntry>>(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providerStatuses), settings),
      ),
    [providerStatuses, settings, activeProjectId],
  );
  const selectedProviderByThreadId = composerDraft.activeProvider ?? null;
  const {
    selectedProviderEntry,
    requestedDriverKind,
    lockedContinuationGroupKey,
    unavailableProviderInstanceId,
  } = useMemo(
    () =>
      resolveComposerProviderSelection({
        entries: providerInstanceEntries,
        candidateInstanceIds: [
          selectedProviderByThreadId,
          activeThread?.runtime?.providerInstanceId,
          activeThreadModelSelection?.instanceId,
          activeProjectDefaultModelSelection?.instanceId,
        ],
        lockedProvider,
        lockedInstanceId:
          activeThread?.runtime?.providerInstanceId ?? activeThreadModelSelection?.instanceId,
        threadDriverKind: activeThreadDriverKind,
      }),
    [
      activeProjectDefaultModelSelection?.instanceId,
      activeThreadDriverKind,
      activeThread?.runtime?.providerInstanceId,
      activeThreadModelSelection?.instanceId,
      selectedProviderByThreadId,
      lockedProvider,
      providerInstanceEntries,
    ],
  );
  const selectedInstanceId =
    selectedProviderEntry?.instanceId ?? NO_PROVIDER_MODEL_SELECTION.instanceId;
  const noProviderAvailable =
    selectedProviderEntry === undefined && multipleModelSelections === null;
  // Before the catalog arrives, every thread resolves to "no provider". Send
  // stays blocked either way; only the chrome waits, keeping the picker with
  // the thread's own selection instead of swapping in the setup button and
  // back once the catalog lands.
  // An environment still connecting has not reported its providers either.
  const providerCatalogPending =
    noProviderAvailable && (!providerCatalogKnown || environmentConnecting);
  const showProviderUnavailable = noProviderAvailable && !providerCatalogPending;
  // What the send button says while send is blocked: "Connecting" until the
  // environment or its catalog arrives, "disconnected" only once that failed.
  const sendWaitsForConnection = isConnecting || environmentConnecting || providerCatalogPending;
  const sendBlockedByEnvironment =
    (environmentUnavailable !== null && !environmentConnecting) ||
    showProviderUnavailable ||
    projectSelectionRequired;
  const providerSetupInstanceId = noProviderAvailable
    ? (unavailableProviderInstanceId ??
      (lockedProvider === null
        ? providerInstanceEntries.find((entry) => hasProviderSetup(entry.snapshot))?.instanceId
        : undefined))
    : undefined;
  const resolvedCompactDisabledReason =
    compactDisabledReason ?? (noProviderAvailable ? "Compacting is unavailable right now" : null);
  // The driver kind follows the instance that will actually run the turn,
  // which can differ from the persisted selection when that selection is
  // disabled.
  const selectedProvider: ProviderDriverKind =
    selectedProviderEntry?.driverKind ?? requestedDriverKind;
  const { modelOptions: composerModelOptions, selectedModel } = useEffectiveComposerModelState({
    threadRef: composerDraftTarget,
    providers: providerStatuses,
    selectedProvider,
    selectedInstanceId,
    threadModelSelection: activeThreadModelSelection,
    projectModelSelection: activeProjectDefaultModelSelection,
    settings,
  });
  const providerSendBlockReason = getProviderSendBlockReason(
    selectedProviderEntry?.snapshot,
    selectedModel,
  );
  const sendDisabledReason =
    externalSendDisabledReason ??
    (multipleModelSelections?.length === 0 ? "Select at least one model." : null) ??
    (activePendingProgress
      ? attachmentBlockReason
      : (attachmentBlockReason ??
        (multipleModelSelections === null ? providerSendBlockReason : null)));
  const isSendDisabled = sendDisabledReason !== null;
  const selectedProviderStatus = useMemo(
    () => selectedProviderEntry?.snapshot ?? null,
    [selectedProviderEntry],
  );
  const compactCommandAvailable = providerSupportsManualCompaction(selectedProviderEntry);
  // Memoized so the composer menu memo below can cache between renders.
  const selectedProviderSkills = useMemo(
    () =>
      selectedProviderStatus ? resolveProviderSkillsForCwd(selectedProviderStatus, gitCwd) : [],
    [gitCwd, selectedProviderStatus],
  );
  const selectedProviderSlashCommands = useMemo(
    () =>
      selectedProviderStatus
        ? resolveProviderSlashCommandsForCwd(selectedProviderStatus, gitCwd)
        : [],
    [gitCwd, selectedProviderStatus],
  );
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  // The last scan this composer asked for. A request inside the TTL is not
  // repeated, so a client clock ahead of the server's cannot loop rescans.
  const workspaceRefreshKeyRef = useRef<{ key: string; requestedAt: number } | null>(null);
  const [workspaceRefreshRetry, setWorkspaceRefreshRetry] = useState<{
    key: string;
    notBefore: number;
  } | null>(null);
  const workspaceRefreshScopeKey =
    gitCwd && selectedProviderEntry
      ? `${environmentId}:${selectedProviderEntry.instanceId}:${gitCwd}`
      : null;
  const workspaceSlashCommandsPending =
    selectedProviderStatus?.workspaceSnapshots?.some(
      (snapshot) => snapshot.cwd === gitCwd && snapshot.slashCommandsPending === true,
    ) ?? false;
  useEffect(() => {
    if (
      !workspaceSlashCommandsPending ||
      !workspaceRefreshRetry ||
      workspaceRefreshRetry.key !== workspaceRefreshScopeKey
    )
      return;
    const timeout = setTimeout(
      () => {
        setWorkspaceRefreshRetry((current) => (current === workspaceRefreshRetry ? null : current));
      },
      Math.max(0, workspaceRefreshRetry.notBefore - Date.now()),
    );
    return () => clearTimeout(timeout);
  }, [workspaceRefreshRetry, workspaceRefreshScopeKey, workspaceSlashCommandsPending]);
  const hadWorkspaceSnapshotRef = useRef(false);
  useEffect(() => {
    const hasWorkspaceSnapshot = hasCompleteProviderWorkspaceSnapshot(
      selectedProviderStatus,
      gitCwd,
    );
    if (hadWorkspaceSnapshotRef.current && !hasWorkspaceSnapshot) {
      workspaceRefreshKeyRef.current = null;
      setWorkspaceRefreshRetry(null);
    }
    hadWorkspaceSnapshotRef.current = hasWorkspaceSnapshot;
  }, [gitCwd, selectedProviderStatus]);
  useEffect(() => {
    if (!gitCwd || !selectedProviderEntry) return;
    const key = `${environmentId}:${selectedProviderEntry.instanceId}:${gitCwd}`;
    const now = Date.now();
    const lastRequest = workspaceRefreshKeyRef.current;
    if (
      lastRequest?.key === key &&
      now - lastRequest.requestedAt < PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS
    )
      return;
    if (hasCurrentProviderWorkspaceSnapshot(selectedProviderStatus, gitCwd, now)) {
      setWorkspaceRefreshRetry(null);
      return;
    }
    const retry = workspaceRefreshRetry;
    if (retry?.key === key && now < retry.notBefore) return;
    const request = { key, requestedAt: now };
    workspaceRefreshKeyRef.current = request;
    const retryLater = () => {
      if (workspaceRefreshKeyRef.current !== request) return;
      workspaceRefreshKeyRef.current = null;
      setWorkspaceRefreshRetry({
        key,
        notBefore: Date.now() + WORKSPACE_SNAPSHOT_RETRY_COOLDOWN_MS,
      });
    };
    void refreshProviders({
      environmentId,
      input: { instanceId: selectedProviderEntry.instanceId, cwd: gitCwd },
    }).then((result) => {
      const hasWorkspaceSnapshot =
        result._tag === "Success" &&
        hasCompleteProviderWorkspaceSnapshot(
          result.value.providers.find(
            (provider) => provider.instanceId === selectedProviderEntry.instanceId,
          ),
          gitCwd,
        );
      if (!hasWorkspaceSnapshot) retryLater();
    }, retryLater);
  }, [
    environmentId,
    gitCwd,
    prompt,
    refreshProviders,
    selectedProviderEntry,
    workspaceRefreshRetry,
  ]);
  const selectedProviderModels = useMemo<ReadonlyArray<ServerProvider["models"][number]>>(
    () => selectedProviderEntry?.models ?? [],
    [selectedProviderEntry],
  );

  const composerPromptInjectionState = useMemo(
    () => getComposerPromptInjectionState(prompt),
    [prompt],
  );
  const composerProviderState = useMemo(
    () =>
      getComposerProviderState({
        provider: selectedProvider,
        model: selectedModel,
        models: selectedProviderModels,
        promptInjectionState: composerPromptInjectionState,
        modelOptions: composerModelOptions?.[selectedInstanceId],
        planModeEnabled: settings.planModeEnabled,
      }),
    [
      composerModelOptions,
      composerPromptInjectionState,
      selectedInstanceId,
      selectedModel,
      selectedProvider,
      selectedProviderModels,
      settings.planModeEnabled,
    ],
  );

  const selectedPromptEffort = composerProviderState.promptEffort;
  const selectedModelOptionsForDispatch = composerProviderState.modelOptionsForDispatch;
  const { enabled: planModeUiEnabled, interactionMode } = resolveComposerInteractionMode({
    planModeEnabled: settings.planModeEnabled,
    provider: selectedProviderStatus,
    interactionMode: requestedInteractionMode,
  });
  const selectedModelSelection = useMemo<ModelSelection>(
    () => createModelSelection(selectedInstanceId, selectedModel, selectedModelOptionsForDispatch),
    [selectedInstanceId, selectedModel, selectedModelOptionsForDispatch],
  );
  const sendModelSelection = noProviderAvailable ? null : selectedModelSelection;
  useLayoutEffect(() => {
    onSendModelSelectionChange(sendModelSelection);
  }, [onSendModelSelectionChange, sendModelSelection]);
  useLayoutEffect(() => () => onSendModelSelectionChange(null), [onSendModelSelectionChange]);
  const selectedModelForPicker = selectedModel;
  // Instance-keyed option list so the picker can show each configured
  // instance (built-in + custom) as a first-class sidebar entry. The
  // options are server-reported models plus that exact instance's
  // configured custom models.
  const modelOptionsByInstance = useMemo<
    ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>>
  >(() => {
    const out = new Map<ProviderInstanceId, ReadonlyArray<AppModelOption>>();
    for (const entry of providerInstanceEntries) {
      out.set(
        entry.instanceId,
        getAppModelOptionsForInstance(
          settings,
          entry,
          entry.instanceId === selectedInstanceId ? selectedModelForPicker : null,
        ),
      );
    }
    return out;
  }, [providerInstanceEntries, selectedInstanceId, selectedModelForPicker, settings]);
  const selectedModelForPickerWithCustomFallback = useMemo(() => {
    const currentOptions = modelOptionsByInstance.get(selectedInstanceId) ?? [];
    return currentOptions.some((option) => option.slug === selectedModelForPicker)
      ? selectedModelForPicker
      : (normalizeModelSlug(selectedModelForPicker, selectedProvider) ?? selectedModelForPicker);
  }, [modelOptionsByInstance, selectedInstanceId, selectedModelForPicker, selectedProvider]);

  // ------------------------------------------------------------------
  // Context window
  // ------------------------------------------------------------------

  const activeThreadModelDisplayName = useMemo(
    () => resolveContextWindowModelDisplayName(activeThreadModelSelection, modelOptionsByInstance),
    [activeThreadModelSelection, modelOptionsByInstance],
  );
  const reserveContextWindowMeter = shouldReserveContextWindowMeter({
    meterEnabled: settings.contextWindowMeterEnabled,
    detailLoading: props.threadSyncPhase === "loading",
    threadStarted: threadShellHasStarted(props.activeThreadShell),
    providerReportsContextWindow: selectedProviderStatus
      ? selectedProviderStatus.reportsContextWindow === true
      : null,
  });

  // ------------------------------------------------------------------
  // Composer-local state
  // ------------------------------------------------------------------
  const [composerCursor, setComposerCursor] = useState(() => {
    const value = isLiteralPendingAnswer ? (activePendingProgress?.customAnswer ?? prompt) : prompt;
    return collapseExpandedComposerCursor(value, value.length, isLiteralPendingAnswer);
  });
  const {
    trigger: composerTrigger,
    setTrigger: setComposerTrigger,
    resolveTrigger: resolveComposerTrigger,
    dismissTrigger: dismissComposerTrigger,
    resetTrigger: resetComposerTrigger,
  } = useComposerTriggerState(() =>
    isLiteralPendingAnswer ? null : detectComposerTrigger(prompt, prompt.length),
  );
  const [composerHighlightedItemId, setComposerHighlightedItemId] = useState<string | null>(null);
  const composerSuggestionId = useId();
  const composerSuggestionListId = `${composerSuggestionId}-${encodeURIComponent(draftId ?? activeThreadId ?? "new")}-suggestions`;
  // Active ArrowUp recall. Cleared on edit and on thread switch.
  const promptHistoryPositionRef = useRef<ComposerPromptHistoryPosition | null>(null);
  const [composerHighlightedSearchKey, setComposerHighlightedSearchKey] = useState<string | null>(
    null,
  );
  const [isDragOverComposer, setIsDragOverComposer] = useState(false);
  const [isComposerFooterCompact, setIsComposerFooterCompact] = useState(false);
  const [isComposerPrimaryActionsCompact, setIsComposerPrimaryActionsCompact] = useState(false);
  const [isComposerModelPickerOpen, setIsComposerModelPickerOpen] = useState(false);
  const isMobileViewport = useMediaQuery("max-sm");
  const [isComposerFocused, setIsComposerFocused] = useState(false);
  const [composerSubmissionError, setComposerSubmissionError] = useState<string | null>(null);
  const [providerInputSubmissionError, setProviderInputSubmissionError] = useState<string | null>(
    null,
  );
  const [composerMenuAnchor, setComposerMenuAnchor] = useElementState<HTMLDivElement>();
  const hasWrappedPrompt = useComposerMultilinePrompt(composerMenuAnchor);
  const hasMultilinePrompt = prompt.includes("\n") || hasWrappedPrompt;
  const [isTasksDrawerOpen, setIsTasksDrawerOpen] = useState(false);
  const isComposerCollapsedMobile =
    isMobileViewport && !forceExpandedOnMobile && !isComposerFocused && !hasMultilinePrompt;

  // ------------------------------------------------------------------
  // Refs
  // ------------------------------------------------------------------
  const composerEditorRef = useRef<ComposerPromptEditorHandle>(null);
  const pasteAsTextShortcutUntilRef = useRef(0);
  const pastedTextFileNamesRef = useRef<{ targetKey: string; names: Set<string> }>({
    targetKey: "",
    names: new Set(),
  });
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  // Dictation streams into the editable draft; a send waits for its last segment.
  const dictationActiveRef = useRef(false);
  const dictationRef = useRef<ComposerDictationHandle>(null);
  const submitAfterDictationRef = useRef<
    | ((
        event: undefined,
        dispatchMode?: ComposerDispatchMode,
        submissionIntent?: ComposerSubmissionIntent,
      ) => void)
    | null
  >(null);
  const composerFormRef = useRef<HTMLFormElement>(null);
  const composerSurfaceRef = useRef<HTMLDivElement>(null);
  const providerInputRejectedRef = useRef(false);
  const composerSelectLockRef = useRef(false);
  const composerMenuOpenRef = useRef(false);
  const composerMenuItemsRef = useRef<ComposerCommandItem[]>([]);
  const activeComposerMenuItemRef = useRef<ComposerCommandItem | null>(null);
  const composerBlurFrameRef = useRef<number | null>(null);
  const mobileComposerExpandFrameRef = useRef<number | null>(null);
  const mobileComposerExpandReleaseFrameRef = useRef<number | null>(null);
  const mobileComposerExpandInFlightRef = useRef(false);
  /**
   * Count of pasted images still being compressed, per thread. Reserved
   * against the attachment limit so concurrent pastes can't overshoot it,
   * and checked before sending so an image cannot move into
   * the next draft.
   */
  const pendingImageCompressionsRef = useRef<Map<string, number>>(new Map());
  const pendingThreadImportsRef = useRef<Map<string, number>>(new Map());
  const isRevertingCheckpointRef = useRef(isRevertingCheckpoint);
  isRevertingCheckpointRef.current = isRevertingCheckpoint;

  useEffect(() => {
    const armPasteAsTextShortcut = () => {
      // Electron can deliver its native menu action just before the paste
      // event, while browsers normally deliver keydown first. A short deadline
      // bridges both event paths without leaving later pastes in bypass mode.
      pasteAsTextShortcutUntilRef.current = Date.now() + 1_000;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.target instanceof Node &&
        composerFormRef.current?.contains(event.target) &&
        isPasteAsTextShortcut(event, isMacPlatform(navigator.platform))
      ) {
        armPasteAsTextShortcut();
      }
    };
    const onBlur = () => {
      pasteAsTextShortcutUntilRef.current = 0;
    };
    const onDesktopPasteAsText = () => {
      const activeElement = document.activeElement;
      const blocksPasteToFocus =
        activeElement instanceof Element &&
        activeElement.closest(
          'input, textarea, select, button, a[href], summary, [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"], [role="button"], [role="menuitem"], [role="option"]',
        ) !== null;
      if (
        (activeElement instanceof Node && composerFormRef.current?.contains(activeElement)) ||
        !blocksPasteToFocus
      ) {
        armPasteAsTextShortcut();
      }
    };
    window.addEventListener(DESKTOP_PASTE_AS_TEXT_EVENT, onDesktopPasteAsText);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener(DESKTOP_PASTE_AS_TEXT_EVENT, onDesktopPasteAsText);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // ------------------------------------------------------------------
  // Derived: composer send state
  // ------------------------------------------------------------------
  const composerSendState = useMemo(
    () =>
      deriveComposerSendState({
        prompt,
        imageCount: composerImages.length + composerFiles.length,
        terminalContexts: composerTerminalContexts,
        elementContextCount: composerPreviewAnnotations.length + composerReviewComments.length,
      }),
    [
      composerFiles.length,
      composerImages.length,
      composerPreviewAnnotations.length,
      composerReviewComments.length,
      composerTerminalContexts,
      prompt,
    ],
  );
  // ------------------------------------------------------------------
  // Derived: composer trigger / menu
  // ------------------------------------------------------------------
  const composerTriggerKind = composerTrigger?.kind ?? null;
  const pathTriggerQuery = composerTrigger?.kind === "path" ? composerTrigger.query : "";
  const pullRequestTriggerQuery =
    composerTrigger?.kind === "pull-request" ? composerTrigger.query : "";
  const pullRequestTextQuery =
    composerTriggerKind === "pull-request" &&
    pullRequestTriggerQuery.length > 0 &&
    !/^\d+$/u.test(pullRequestTriggerQuery)
      ? pullRequestTriggerQuery
      : null;
  const debouncedPullRequestTextQuery = useDebouncedValue(pullRequestTextQuery, 180);
  const settledPullRequestTextQuery =
    pullRequestTextQuery === debouncedPullRequestTextQuery ? pullRequestTextQuery : null;
  const isPathTrigger = composerTriggerKind === "path";
  // Thread shells, agents and folders only feed `@` matches, so skip their updates otherwise.
  const environmentThreadShells = useThreadShells(isPathTrigger);
  const resolveThreadKind = useThreadKindResolver();
  const { agents: mentionAgents } = useAgents();
  const { labels: mentionProjectFolders } = useEnvironmentProjectLabels(
    isPathTrigger ? environmentId : null,
  );
  // Sources are kept to the thread's project, the same set its agent can call.
  const { currentId: composerProjectLabelId } = useComposerProjectFolder({
    environmentId,
    threadId: activeThreadId,
    draftId: routeKind === "draft" ? draftId : null,
  });
  const { sources: mentionSources } = useComposerSources(
    isPathTrigger ? environmentId : null,
    composerProjectLabelId,
  );
  // The Sources picker opens from its toolbar button, or from the overflow menu once the
  // button has folded away; then it sits on the overflow trigger (`anchor`).
  const [sourcesPicker, setSourcesPicker] = useState<{
    readonly open: boolean;
    readonly anchor: HTMLElement | null;
  }>({ open: false, anchor: null });
  const restingOverflowRef = useRef<HTMLDivElement>(null);
  const onSourcesPickerOpenChange = (open: boolean) => {
    setSourcesPicker((current) => (open ? { ...current, open } : { open: false, anchor: null }));
  };
  const onSourcesPickerOpenChangeStable = useStableCallback(onSourcesPickerOpenChange);
  const openSourcesFromOverflow = () => {
    // A frame later, so the closing overflow menu hands focus back before the picker
    // takes it for its search field.
    window.requestAnimationFrame(() => {
      setSourcesPicker({ open: true, anchor: restingOverflowRef.current });
    });
  };
  const openSourcesFromOverflowStable = useStableCallback(openSourcesFromOverflow);
  const mentionItems = useMemo(
    () =>
      composerTrigger?.kind !== "path"
        ? []
        : matchComposerMentionItems({
            threads: environmentThreadShells.map((shell) => ({
              environmentId: shell.environmentId,
              id: shell.id,
              title: shell.title,
              updatedAt: shell.updatedAt,
              archivedAt: shell.archivedAt,
              kind: resolveThreadKind(shell),
            })),
            agents: mentionAgents.map((agent) => ({
              environmentId: agent.environmentId,
              id: agent.id,
              name: agent.name,
              conversationThreadId: agent.conversationThreadId,
              activeAt: agent.latestMessage?.createdAt ?? agent.updatedAt,
            })),
            projectFolders: mentionProjectFolders.map((folder) => ({
              environmentId,
              id: folder.id,
              name: folder.name,
              updatedAt: folder.updatedAt,
            })),
            sources: mentionSources,
            environmentId,
            excludeThreadId: activeThreadId,
            query: composerTrigger.query,
          }),
    [
      activeThreadId,
      composerTrigger,
      environmentId,
      environmentThreadShells,
      mentionAgents,
      mentionProjectFolders,
      mentionSources,
      resolveThreadKind,
    ],
  );
  const workspaceEntries = useComposerPathSearch({
    environmentId,
    cwd: isPathTrigger ? gitCwd : null,
    query: isPathTrigger ? pathTriggerQuery : null,
  });
  const compactSlashCommandAvailable =
    composerTrigger?.kind === "slash-command" &&
    prompt.slice(0, composerTrigger.rangeStart).trim() === "" &&
    !compactThreadUnavailable &&
    prompt.slice(composerTrigger.rangeEnd).trim() === "" &&
    composerImages.length + composerFiles.length === 0 &&
    composerDraft.persistedAttachments.length === 0 &&
    composerTerminalContexts.length === 0 &&
    composerPreviewAnnotations.length === 0 &&
    composerReviewComments.length === 0;

  const pullRequestListTargets = useMemo(
    () =>
      composerTriggerKind !== "pull-request" ||
      pullRequestProjectId === null ||
      (pullRequestTextQuery !== null && settledPullRequestTextQuery === null)
        ? EMPTY_PULL_REQUEST_LIST_TARGETS
        : [
            {
              environmentId,
              input: {
                state: "all" as const,
                projectId: pullRequestProjectId,
                limit: COMPOSER_PULL_REQUEST_LIST_LIMIT,
                ...(settledPullRequestTextQuery === null
                  ? {}
                  : { query: settledPullRequestTextQuery }),
              },
            },
          ],
    [
      composerTriggerKind,
      environmentId,
      pullRequestProjectId,
      pullRequestTextQuery,
      settledPullRequestTextQuery,
    ],
  );
  const pullRequestLookup = usePullRequestList(pullRequestListTargets);
  const pullRequestTriggerNumber = useMemo(() => {
    if (composerTrigger?.kind !== "pull-request" || composerTrigger.query.length === 0) {
      return null;
    }
    const number = Number(composerTrigger.query);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
  }, [composerTrigger]);
  const debouncedPullRequestNumber = useDebouncedValue(pullRequestTriggerNumber, 180);
  const settledPullRequestNumber =
    pullRequestTriggerNumber === debouncedPullRequestNumber ? pullRequestTriggerNumber : null;
  const recentHasExactPullRequest =
    settledPullRequestNumber !== null &&
    pullRequestLookup.data?.entries.some(
      (entry) =>
        entry.projectId === pullRequestProjectId &&
        entry.repository.trim().toLowerCase() === pullRequestRepository?.trim().toLowerCase() &&
        entry.number === settledPullRequestNumber,
    ) === true;
  const exactPullRequestLookup = useEnvironmentQuery(
    settledPullRequestNumber === null ||
      pullRequestProjectId === null ||
      pullRequestRepository === null ||
      recentHasExactPullRequest
      ? null
      : pullRequestEnvironment.detail({
          environmentId,
          input: {
            projectId: pullRequestProjectId,
            repository: pullRequestRepository,
            number: settledPullRequestNumber,
          },
        }),
  );

  const linkedPullRequests = useMemo(
    () =>
      pullRequestProjectId === null
        ? []
        : composerPullRequestsFromLinks(threadPullRequests ?? [], pullRequestProjectId),
    [pullRequestProjectId, threadPullRequests],
  );

  const composerMenuItems = useMemo<ComposerCommandItem[]>(() => {
    if (!composerTrigger) return [];
    if (composerTrigger.kind === "path") {
      // A name match is far more specific than a fuzzy path hit, so the few tasks, chats,
      // agents and projects lead, in their sections, ahead of files.
      return [
        ...mentionItems,
        ...workspaceEntries.entries.map((entry) => ({
          id: `path:${entry.kind}:${entry.path}`,
          type: "path" as const,
          path: entry.path,
          pathKind: entry.kind,
          group: "files" as const,
          label: basenameOfPath(entry.path),
          description: entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/"))),
        })),
      ];
    }
    if (composerTrigger.kind === "slash-command") {
      const builtInSlashCommandItems = [
        {
          id: "slash:model",
          type: "slash-command",
          command: "model",
          label: "/model",
          description: "Switch response model for this thread",
        },
        ...(planModeUiEnabled
          ? ([
              {
                id: "slash:plan",
                type: "slash-command",
                command: "plan",
                label: "/plan",
                description: "Switch this thread into plan mode",
              },
              {
                id: "slash:default",
                type: "slash-command",
                command: "default",
                label: "/default",
                description: "Switch this thread back to normal build mode",
              },
            ] as const)
          : []),
      ] satisfies ReadonlyArray<Extract<ComposerCommandItem, { type: "slash-command" }>>;
      const slashMenuSkills = getProviderSkillsForSlashMenu(
        selectedProviderSkills,
        settings.showSkillsInSlashMenu,
      );
      const providerSlashCommandItems = getProviderSlashCommandsForSlashMenu(
        selectedProviderSlashCommands,
        slashMenuSkills,
      ).map((command) => ({
        id: `provider-slash-command:${selectedProvider}:${command.name}`,
        type: "provider-slash-command" as const,
        provider: selectedProvider,
        command,
        label: `/${command.name}`,
        description: command.description ?? command.input?.hint ?? "Run provider command",
      }));
      const query = composerTrigger.query.trim().toLowerCase();
      const skillItems = slashMenuSkills.map((skill) => ({
        id: `skill:${selectedProvider}:${skill.name}`,
        type: "skill" as const,
        provider: selectedProvider,
        skill,
        label: `/skill:${skill.name}`,
        description:
          skill.shortDescription ??
          skill.description ??
          (skill.scope ? `${skill.scope} skill` : ""),
      }));
      const visibleProviderSlashCommandItems = providerSlashCommandItems.filter(
        (item) => item.command.name !== "compact" || compactSlashCommandAvailable,
      );
      const slashCommandItems = slashCommandItemsForPromptPosition(
        [...builtInSlashCommandItems, ...visibleProviderSlashCommandItems, ...skillItems],
        composerTrigger.rangeStart === 0,
      );
      return searchSlashCommandItems(slashCommandItems, query);
    }
    if (composerTrigger.kind === "skill") {
      return searchProviderSkills(selectedProviderSkills, composerTrigger.query).map((skill) => ({
        id: `skill:${selectedProvider}:${skill.name}`,
        type: "skill" as const,
        provider: selectedProvider,
        skill,
        label: formatProviderSkillDisplayName(skill),
        description:
          skill.shortDescription ??
          skill.description ??
          (skill.scope ? `${skill.scope} skill` : "Run provider skill"),
      }));
    }
    if (
      composerTrigger.kind === "pull-request" &&
      pullRequestProjectId !== null &&
      pullRequestRepository !== null
    ) {
      const exactPullRequest =
        exactPullRequestLookup.data?.number === pullRequestTriggerNumber
          ? [exactPullRequestLookup.data]
          : [];
      const matches = /^\d*$/u.test(composerTrigger.query)
        ? filterComposerPullRequestMatches({
            entries: [...exactPullRequest, ...(pullRequestLookup.data?.entries ?? [])],
            linked: linkedPullRequests,
            projectId: pullRequestProjectId,
            repository: pullRequestRepository,
            query: composerTrigger.query,
            limit: COMPOSER_PULL_REQUEST_RESULT_LIMIT,
          })
        : rankPullRequestMatches(
            (pullRequestLookup.data?.entries ?? []).filter((entry) => {
              if (
                entry.projectId !== pullRequestProjectId ||
                entry.repository.trim().toLowerCase() !== pullRequestRepository.trim().toLowerCase()
              ) {
                return false;
              }
              const provider = pullRequestLookup.data?.providers.find(
                (candidate) => candidate.host === entry.host,
              );
              return (
                provider?.searchesOnHost === true ||
                matchesPullRequestQuery(entry, composerTrigger.query)
              );
            }),
            composerTrigger.query,
          ).slice(0, COMPOSER_PULL_REQUEST_RESULT_LIMIT);
      return matches.map((pullRequest) => ({
        id: `pull-request:${pullRequest.projectId}:${pullRequest.repository}:${pullRequest.number}`,
        type: "pull-request",
        pullRequest: {
          number: pullRequest.number,
          title: pullRequest.title,
          url: pullRequest.url,
          headBranch: pullRequest.headBranch,
          baseBranch: pullRequest.baseBranch,
          state: pullRequest.state,
          isDraft: pullRequest.isDraft,
        },
        label: `#${pullRequest.number}`,
        description:
          pullRequest.repository.trim().toLowerCase() === pullRequestRepository.trim().toLowerCase()
            ? pullRequest.title
            : `${pullRequest.repository} · ${pullRequest.title}`,
      }));
    }
    return [];
  }, [
    compactSlashCommandAvailable,
    composerTrigger,
    exactPullRequestLookup.data,
    linkedPullRequests,
    planModeUiEnabled,
    pullRequestLookup.data,
    pullRequestProjectId,
    pullRequestRepository,
    pullRequestTriggerNumber,
    selectedProvider,
    selectedProviderSkills,
    selectedProviderSlashCommands,
    selectedProviderStatus,
    settings.showSkillsInSlashMenu,
    mentionItems,
    workspaceEntries.entries,
  ]);

  const composerMenuOpen = Boolean(composerTrigger);
  const composerMenuSearchKey = composerTrigger
    ? `${composerSuggestionListId}:${composerTrigger.kind}:${composerTrigger.query.trim().toLowerCase()}`
    : null;
  const activeComposerMenuItem = useMemo(() => {
    const activeItemId = resolveComposerMenuActiveItemId({
      items: composerMenuItems,
      highlightedItemId: composerHighlightedItemId,
      currentSearchKey: composerMenuSearchKey,
      highlightedSearchKey: composerHighlightedSearchKey,
    });
    return composerMenuItems.find((item) => item.id === activeItemId) ?? null;
  }, [
    composerHighlightedItemId,
    composerHighlightedSearchKey,
    composerMenuItems,
    composerMenuSearchKey,
  ]);

  composerMenuOpenRef.current = composerMenuOpen;
  composerMenuItemsRef.current = composerMenuItems;
  activeComposerMenuItemRef.current = activeComposerMenuItem;

  const nonPersistedComposerImageIdSet = useMemo(
    () => new Set(nonPersistedComposerImageIds),
    [nonPersistedComposerImageIds],
  );

  const composerSuggestionsVisible = composerMenuOpen;
  const composerSuggestionListVisible = composerSuggestionsVisible && composerMenuItems.length > 0;
  const activePendingUserInput = pendingUserInputs[0] ?? null;
  const isChoiceOnlyPendingQuestion =
    activePendingProgress?.activeQuestion?.allowCustomAnswer === false;
  const composerEditorLocked =
    isConnecting ||
    projectSelectionRequired ||
    isChoiceOnlyPendingQuestion ||
    activePendingIsResponding;
  const showComposerTopDrawer =
    pendingUserInputs.length > 0 ||
    (!isComposerCollapsedMobile && showPlanFollowUpPrompt && activeProposedPlan !== null);
  const showCollapsedMobilePromptRow = isComposerCollapsedMobile && pendingUserInputs.length === 0;
  const showComposerAttachAction =
    fileStagingLimit !== null &&
    (!activePendingProgress ||
      (supportsQuestionAttachments &&
        activePendingProgress.activeQuestion?.allowCustomAnswer !== false));
  const composerFooterHasWideActions = showPlanFollowUpPrompt || activePendingProgress !== null;
  const composerFooterActionLayoutKey = useMemo(() => {
    if (activePendingProgress) {
      return `pending:${activePendingProgress.questionIndex}:${activePendingProgress.isLastQuestion}:${activePendingIsResponding}`;
    }
    if (phase === "running") {
      return "running";
    }
    if (showPlanFollowUpPrompt) {
      return prompt.trim().length > 0 ? "plan:refine" : "plan:implement";
    }
    return `idle:${composerSendState.hasSendableContent}:${isSendBusy}:${isConnecting}:${isPreparingWorktree}`;
  }, [
    activePendingIsResponding,
    activePendingProgress,
    composerSendState.hasSendableContent,
    isConnecting,
    isPreparingWorktree,
    isSendBusy,
    phase,
    prompt,
    showPlanFollowUpPrompt,
  ]);

  const isComposerMenuLoading =
    (composerTriggerKind === "path" && pathTriggerQuery.length > 0 && workspaceEntries.isPending) ||
    (composerTriggerKind === "pull-request" &&
      pullRequestProjectId !== null &&
      pullRequestRepository !== null &&
      (pullRequestLookup.isPending ||
        pullRequestTextQuery !== debouncedPullRequestTextQuery ||
        pullRequestTriggerNumber !== debouncedPullRequestNumber ||
        exactPullRequestLookup.isPending));
  const composerMenuEmptyState = useMemo(() => {
    if (composerTriggerKind === "skill") {
      return "No skills found. Try / to browse provider commands.";
    }
    if (composerTriggerKind === "pull-request") {
      if (pullRequestProjectId === null || pullRequestRepository === null) {
        return "Pull requests are not available for this repository.";
      }
      if (
        pullRequestLookup.error !== null ||
        pullRequestLookup.data?.errors.some((error) => error.projectId === pullRequestProjectId)
      ) {
        return "Pull requests could not be read for this repository.";
      }
      return composerTrigger?.query
        ? `No pull request matches ${composerTrigger.query}.`
        : "No pull requests found in this repository.";
    }
    return composerTriggerKind === "path"
      ? "No matching tasks, chats, agents, projects, sources or files."
      : "No matching command.";
  }, [
    composerTrigger,
    composerTriggerKind,
    pullRequestLookup.data?.errors,
    pullRequestLookup.error,
    pullRequestProjectId,
    pullRequestRepository,
  ]);

  // ------------------------------------------------------------------
  // Provider traits UI
  // ------------------------------------------------------------------
  const setPromptFromTraits = (nextPrompt: string) => {
    if (nextPrompt === promptRef.current) {
      scheduleComposerFocus();
      return;
    }
    promptRef.current = nextPrompt;
    setComposerDraftPrompt(composerDraftTarget, nextPrompt);
    const nextCursor = collapseExpandedComposerCursor(nextPrompt, nextPrompt.length);
    setComposerCursor(nextCursor);
    setComposerTrigger(detectComposerTrigger(nextPrompt, nextPrompt.length));
    scheduleComposerFocus();
  };
  const setPromptFromTraitsStable = useStableCallback(setPromptFromTraits);
  const updateModelPreferences = useUpdateEnvironmentModelPreferences(environmentId);
  const setEffortDefaultStable: SetModelEffortDefault = useStableCallback(
    (setModelEffortDefault: Parameters<SetModelEffortDefault>[0]) => {
      void updateModelPreferences({ setModelEffortDefault });
    },
  );

  const providerTraitsMenuContent = renderProviderTraitsMenuContent({
    provider: selectedProvider,
    instanceId: selectedInstanceId,
    ...(routeKind === "server" ? { threadRef: routeThreadRef } : {}),
    ...(routeKind === "draft" && draftId ? { draftId } : {}),
    model: selectedModel,
    models: selectedProviderModels,
    modelOptions: composerModelOptions?.[selectedInstanceId],
    reportedModelSelection,
    prompt,
    onPromptChange: setPromptFromTraitsStable,
    planModeEnabled: settings.planModeEnabled,
    onSetEffortDefault: setEffortDefaultStable,
  });
  const providerTraitsPickerInput = {
    provider: selectedProvider,
    instanceId: selectedInstanceId,
    ...(routeKind === "server" ? { threadRef: routeThreadRef } : {}),
    ...(routeKind === "draft" && draftId ? { draftId } : {}),
    model: selectedModel,
    models: selectedProviderModels,
    modelOptions: composerModelOptions?.[selectedInstanceId],
    reportedModelSelection,
    prompt,
    onPromptChange: setPromptFromTraitsStable,
    planModeEnabled: settings.planModeEnabled,
    isComposerOwned: true,
    onSetEffortDefault: setEffortDefaultStable,
  } satisfies Parameters<typeof renderProviderTraitsPicker>[0];
  const providerTraitsPicker = renderProviderTraitsPicker(providerTraitsPickerInput);
  const [inlineRestingControlsHost, setInlineRestingControlsHost] =
    useElementState<HTMLDivElement>();
  const {
    controlsRef: restingComposerControlsRef,
    attachControls: attachRestingComposerControls,
    hiddenBlockCount: restingControlsHiddenBlockCount,
    iconOnlyBlockCount: restingControlsIconOnlyBlockCount,
    controlsVisible: restingControlsVisible,
  } = useRestingComposerControlsLayout(restingControlsHost ?? inlineRestingControlsHost);
  const [dictationRecording, setDictationRecording] = useState(false);
  const expandedControlsLayout = useRestingComposerControlsLayout(
    null,
    true,
    settings.dictationEnabled && !isChoiceOnlyPendingQuestion ? dictationRecording : undefined,
  );
  const pendingPrimaryAction = useMemo(
    () =>
      activePendingProgress
        ? {
            questionIndex: activePendingProgress.questionIndex,
            isLastQuestion: activePendingProgress.isLastQuestion,
            canAdvance:
              activePendingProgress.canAdvance &&
              !attachmentBlockReason &&
              !(questionPreparations[attachmentTargetKey] ?? 0),
            isResponding: activePendingIsResponding,
            isComplete: Boolean(activePendingResolvedAnswers),
          }
        : null,
    [
      activePendingIsResponding,
      activePendingProgress,
      activePendingResolvedAnswers,
      attachmentBlockReason,
      questionPreparations,
      attachmentTargetKey,
    ],
  );
  const showResumeAction =
    canResume && !composerDraftHasUserContent(composerDraft) && !isEditingQueuedMessage;
  const collapsedComposerPrimaryActionDisabled =
    phase === "running" ||
    isSendBusy ||
    isSendDisabled ||
    isConnecting ||
    noProviderAvailable ||
    projectSelectionRequired ||
    environmentUnavailable !== null ||
    (!composerSendState.hasSendableContent && !showResumeAction);
  const collapsedComposerPrimaryActionLabel = showResumeAction
    ? "Resume thread"
    : props.resumeCompactionTokens !== null && !props.keepFullHistory
      ? "Open composer to compact and send"
      : "Send message";
  const showMobilePendingAnswerActions =
    isMobileViewport && !isComposerCollapsedMobile && pendingPrimaryAction !== null;

  // ------------------------------------------------------------------
  // Prompt helpers
  // ------------------------------------------------------------------
  const setPrompt = (nextPrompt: string) => {
    setComposerDraftPrompt(composerDraftTarget, nextPrompt);
  };

  const addComposerImage = (image: ComposerImageAttachment) =>
    addComposerDraftImages(attachmentDraftTarget, [image]);

  const addComposerImagesToDraft = (images: ComposerImageAttachment[]) =>
    addComposerDraftImages(attachmentDraftTarget, images);

  const addComposerFilesToDraft = (files: ComposerFileAttachment[]) =>
    addComposerDraftFiles(attachmentDraftTarget, files, {
      appendReference: questionAttachmentTarget === null,
    });

  const removeComposerImageFromDraft = (imageId: string) => {
    if (questionAttachmentTarget && activePendingIsResponding) return;
    releaseAttachmentUpload(imageId);
    removeComposerDraftImage(attachmentDraftTarget, imageId);
  };

  /**
   * Puts `next` where `current` sits in the draft. The marked-up copy gets a
   * new id so it uploads afresh; the upload of the image it replaces is
   * released. A marked-up copy's own preview is freed once replaced, but an
   * original's is kept by its markup session until it is sent.
   */
  const swapComposerImage = (current: ComposerImageAttachment, next: ComposerImageAttachment) => {
    if (questionAttachmentTarget && activePendingIsResponding) return false;
    if (!replaceComposerDraftImage(attachmentDraftTarget, current.id, next)) return false;
    releaseAttachmentUpload(current.id);
    return true;
  };

  const applyImageMarkup = (
    current: ComposerImageAttachment,
    file: File,
    original: ComposerImageAttachment,
    shapes: ReadonlyArray<MarkupShape>,
  ) => {
    const marked: ComposerImageAttachment = {
      type: "image",
      id: randomUUID(),
      name: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      previewUrl: URL.createObjectURL(file),
      file,
    };
    const wasMarked = readImageMarkupSession(current.id) !== undefined;
    endImageMarkupSession(current.id);
    setImageMarkupSession(marked.id, { original, shapes });
    if (!swapComposerImage(current, marked)) {
      endImageMarkupSession(marked.id);
      URL.revokeObjectURL(marked.previewUrl);
      if (wasMarked) setImageMarkupSession(current.id, { original, shapes });
      return;
    }
    if (wasMarked) URL.revokeObjectURL(current.previewUrl);
    setMarkupImageId(null);
  };

  const revertImageMarkup = (current: ComposerImageAttachment) => {
    const session = readImageMarkupSession(current.id);
    if (!session) return;
    endImageMarkupSession(current.id);
    if (!swapComposerImage(current, session.original)) {
      setImageMarkupSession(current.id, session);
      return;
    }
    URL.revokeObjectURL(current.previewUrl);
    setMarkupImageId(null);
  };

  const removeComposerFileFromDraft = (fileId: string) => {
    if (questionAttachmentTarget && activePendingIsResponding) return;
    // Release by the draft attachment, not the bare queue key: a hydrated
    // file's upload lives server-side under its persisted attachment id.
    const file = composerFilesRef.current.find((candidate) => candidate.id === fileId);
    if (file) {
      releaseDraftAttachment(file);
    } else {
      releaseAttachmentUpload(fileId);
    }
    removeComposerDraftFile(attachmentDraftTarget, fileId);
  };

  const addComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.addTerminalContexts,
  );
  const addComposerDraftReviewComment = useComposerDraftStore((store) => store.addReviewComment);
  const addComposerDraftPreviewAnnotation = useComposerDraftStore(
    (store) => store.addPreviewAnnotation,
  );
  const addComposerDraftThreadContexts = useComposerDraftStore((store) => store.addThreadContexts);
  const setComposerDraftThreadContexts = useComposerDraftStore((store) => store.setThreadContexts);
  const buildContextClipboardFragment = (contextIds: ReadonlyArray<string>): string | null => {
    const wanted = new Set(contextIds);
    // An annotation's screenshot is referenced by the annotation record, not by the copied
    // text. Pull it in so the round-trip keeps the image the annotation points at.
    for (const annotation of composerPreviewAnnotations) {
      if (
        wanted.has(previewAnnotationContextId(annotation.id)) &&
        composerImages.some((image) => image.id === annotation.id)
      ) {
        wanted.add(toKindScopedComposerContextId("image", annotation.id));
      }
    }
    const records: ComposerContextRecord[] = [
      ...composerTerminalContexts
        .filter((c) => wanted.has(terminalContextReference(c).contextId))
        .map(terminalContextRecord),
      ...composerThreadContexts.filter((record) => wanted.has(record.contextId)),
      ...composerReviewComments
        .filter((c) => wanted.has(reviewCommentContextId(c.id)))
        .map(reviewCommentContextRecord),
      ...composerPreviewAnnotations
        .filter((a) => wanted.has(previewAnnotationContextId(a.id)))
        .map((annotation) =>
          previewAnnotationContextRecord(annotation, {
            screenshotContextId: composerImages.some((image) => image.id === annotation.id)
              ? annotation.id
              : undefined,
          }),
        ),
      ...[...composerImages, ...composerFiles]
        .filter((attachment) =>
          wanted.has(toKindScopedComposerContextId(attachment.type, attachment.id)),
        )
        .flatMap((attachment) => {
          const record = uploadedAttachmentContextRecord(
            attachment,
            uploadsByImageId[attachment.id],
          );
          return record ? [record] : [];
        }),
    ];
    if (records.length === 0) return null;
    return encodeComposerContextFragment({
      version: 1,
      source: { environmentId, ...(activeThread ? { threadId: activeThread.id } : {}) },
      records,
    });
  };
  const buildContextClipboardFragmentStable = useStableCallback(buildContextClipboardFragment);
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, { reportFailure: false });
  const loadThreadTranscript = useAtomCommand(orchestrationEnvironment.threadTranscript, {
    reportFailure: false,
  });
  const countReservedAttachments = () => {
    const questionRequest = pendingUserInputs[0];
    const otherQuestionKeys =
      questionAttachmentTarget && questionRequest && activeThreadId
        ? questionRequest.questions
            .map((question) =>
              questionAttachmentDraftId(
                environmentId,
                activeThreadId,
                questionRequest.requestId,
                question.id,
              ),
            )
            .filter((key) => key !== questionAttachmentTarget)
        : [];
    const draft = getComposerDraft(attachmentDraftTarget);
    return (
      (draft?.images.length ?? 0) +
      (draft?.files.length ?? 0) +
      (pendingImageCompressionsRef.current.get(attachmentTargetKey) ?? 0) +
      (pendingThreadImportsRef.current.get(attachmentTargetKey) ?? 0) +
      countQuestionAttachments(otherQuestionKeys)
    );
  };
  const countReservedAttachmentsStable = useStableCallback(countReservedAttachments);
  /**
   * Bytes for a pasted image or file come back through the source environment's asset URL
   * (the client is the only party that can reach both) and re-enter this draft as a normal
   * attachment under a fresh id. The pasted chip is rewritten to that id and reads as
   * unresolved until the bytes land; a failed transfer says so and leaves the chip to remove.
   */
  const runAttachmentImport = async (
    record: Extract<ComposerContextRecord, { kind: "image" | "file" }>,
    localId: string,
    sourceEnvironmentId: EnvironmentId,
    importTargetKey: string,
  ) => {
    const fail = (reason: string) => {
      toastManager.add({
        type: "error",
        title: `Couldn't bring ${record.name} into this message`,
        description: `${reason} Remove the chip or attach the file again.`,
      });
    };
    const sourceConnection = readPreparedConnection(sourceEnvironmentId);
    if (!sourceConnection) {
      fail("The machine it came from is not connected.");
      return;
    }
    const result = await createAssetUrl({
      environmentId: sourceEnvironmentId,
      input: { resource: { _tag: "attachment", attachmentId: record.attachmentId } },
    });
    const url =
      result._tag === "Success"
        ? resolveAssetUrl(sourceConnection.httpBaseUrl, result.value.relativeUrl)
        : null;
    if (!url) {
      fail("The original attachment is no longer available.");
      return;
    }
    let blob: Blob;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      blob = await response.blob();
    } catch {
      fail("Downloading it from the source failed.");
      return;
    }
    const file = new File([blob], record.name, { type: record.mimeType || blob.type });
    // The draft these bytes belong to may have been sent or switched away from while they
    // downloaded. Dropping them here keeps them out of whatever draft is open now.
    if (attachmentTargetKeyRef.current !== importTargetKey) return;
    const replacesFileMarker =
      record.kind === "file" &&
      composerFilesRef.current.some(
        (candidate) =>
          composerFileNeedsReattach(candidate) &&
          composerFileMatchesReattachMarker(candidate, {
            name: record.name,
            mimeType: file.type,
            sizeBytes: file.size,
          }),
      );
    if (
      !replacesFileMarker &&
      (pendingThreadImportsRef.current.get(importTargetKey) ?? 0) > 0 &&
      countReservedAttachments() >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS
    ) {
      fail("The attachment limit has been reached.");
      return;
    }
    if (record.kind === "image") {
      const accepted = addComposerImage({
        type: "image",
        id: localId,
        name: record.name,
        mimeType: file.type,
        sizeBytes: file.size,
        previewUrl: URL.createObjectURL(file),
        file,
      });
      if (!accepted.includes(localId))
        fail("The draft rejected this attachment (duplicate or attachment limit reached).");
    } else {
      const accepted = addComposerFilesToDraft([
        {
          type: "file",
          id: localId,
          name: record.name,
          mimeType: file.type,
          sizeBytes: file.size,
          file,
        },
      ]);
      if (!accepted.includes(localId))
        fail("The draft rejected this attachment (duplicate or attachment limit reached).");
    }
  };
  const importAttachmentRecord = async (
    record: Extract<ComposerContextRecord, { kind: "image" | "file" }>,
    localId: string,
    sourceEnvironmentId: EnvironmentId,
  ) => {
    // The chip lands in the draft immediately while these bytes are still downloading. Count
    // the transfer against its own draft so a send cannot snapshot a message whose chip has no
    // attachment behind it, and so bytes for an abandoned draft never enter the next one.
    const importTargetKey = attachmentTargetKey;
    pendingDraftWork.begin(importTargetKey);
    try {
      await runAttachmentImport(record, localId, sourceEnvironmentId, importTargetKey);
    } finally {
      pendingDraftWork.end(importTargetKey);
    }
  };
  /**
   * Brings records into this draft (paste). Binaries are transferred only
   * when `sourceEnvironmentId` is given.
   */
  const importContextRecords = (
    records: ReadonlyArray<ComposerContextRecord>,
    sourceEnvironmentId: EnvironmentId | null,
  ): ReadonlyMap<string, string> => {
    const rewritten = new Map<string, string>();
    const dependentAttachmentLocalIds = new Map<string, string>();
    const skippedDependentAttachmentIds = new Set<string>();
    // Resolve annotations before their dependent screenshot records even if a foreign
    // clipboard producer emitted the records in a different order.
    const orderedRecords = records.toSorted((left, right) =>
      left.kind === "preview-annotation" && right.kind !== "preview-annotation"
        ? -1
        : right.kind === "preview-annotation" && left.kind !== "preview-annotation"
          ? 1
          : 0,
    );
    for (const candidate of orderedRecords) {
      // Producer ids fold into context ids, so two different excerpts can collide. Only skip
      // when the draft already holds the same payload; a colliding but different record is
      // re-minted under a fresh id so both survive the paste.
      const record = asKnownContextRecord(candidate);
      if (!record) continue;
      const existing = composerContextImportLookupIds(record).flatMap((contextId) => {
        const found = composerContextRecords.get(contextId);
        return found ? [found] : [];
      })[0];
      const existingRecord =
        existing?.kind === "terminal"
          ? terminalContextRecord(existing.record)
          : existing?.kind === "review-comment"
            ? reviewCommentContextRecord(existing.record)
            : existing?.kind === "preview-annotation"
              ? previewAnnotationContextRecord(existing.record)
              : existing?.kind === "thread" ||
                  existing?.kind === "agent" ||
                  existing?.kind === "project-folder" ||
                  existing?.kind === "integration"
                ? existing.record
                : existing
                  ? (uploadedContextRecordFromDraft(existing) ?? undefined)
                  : undefined;
      if (existingRecord && isSameComposerContextPayload(existingRecord, record)) {
        if (record.kind === "preview-annotation" && record.screenshotContextId) {
          skippedDependentAttachmentIds.add(record.screenshotContextId);
        }
        continue;
      }
      const conflicts = existing !== undefined;
      switch (record.kind) {
        case "terminal": {
          const threadId = activeThread?.id ?? activeThreadId;
          if (!threadId) break;
          const imported = terminalContextDraftFromRecord(record, threadId);
          const draft = conflicts ? { ...imported, id: randomUUID() } : imported;
          addComposerDraftTerminalContexts(composerDraftTarget, [draft], {
            appendReference: false,
          });
          rewritten.set(record.contextId, terminalContextReference(draft).contextId);
          break;
        }
        case "review-comment": {
          const imported = reviewCommentFromRecord(record);
          const comment = conflicts ? { ...imported, id: randomUUID() } : imported;
          addComposerDraftReviewComment(composerDraftTarget, comment, {
            appendReference: false,
          });
          rewritten.set(record.contextId, reviewCommentContextId(comment.id));
          break;
        }
        case "element":
        case "preview-annotation": {
          const imported =
            record.kind === "element"
              ? elementContextToPreviewAnnotation(record, randomUUID(), new Date().toISOString())
              : previewAnnotationFromRecord(record);
          const annotation = conflicts ? { ...imported, id: randomUUID() } : imported;
          if (record.kind === "preview-annotation" && record.screenshotContextId) {
            dependentAttachmentLocalIds.set(record.screenshotContextId, annotation.id);
          }
          addComposerDraftPreviewAnnotation(composerDraftTarget, annotation, {
            appendReference: false,
          });
          rewritten.set(record.contextId, previewAnnotationContextId(annotation.id));
          break;
        }
        case "thread":
        case "agent":
        case "project-folder": {
          // The agent can only follow links on its own server; a pasted foreign one is dropped.
          if (record.environmentId !== environmentId) break;
          addComposerDraftThreadContexts(attachmentDraftTarget, [record], {
            appendReference: false,
          });
          rewritten.set(record.contextId, record.contextId);
          break;
        }
        case "integration": {
          // An integration id names an account on one server; one pasted from another is dropped.
          if (sourceEnvironmentId !== null && sourceEnvironmentId !== environmentId) break;
          addComposerDraftThreadContexts(attachmentDraftTarget, [record], {
            appendReference: false,
          });
          rewritten.set(record.contextId, record.contextId);
          break;
        }
        case "image":
        case "file": {
          if (skippedDependentAttachmentIds.has(record.contextId)) break;
          if (sourceEnvironmentId === null && !conflicts) {
            rewritten.set(record.contextId, record.contextId);
            break;
          }
          if (sourceEnvironmentId === null) break;
          const localId = dependentAttachmentLocalIds.get(record.contextId) ?? randomUUID();
          rewritten.set(record.contextId, toKindScopedComposerContextId(record.kind, localId));
          void importAttachmentRecord(record, localId, sourceEnvironmentId);
          break;
        }
        default:
          break;
      }
    }
    return rewritten;
  };
  const importContextFragment = (
    fragment: ComposerContextClipboardFragment,
  ): ReadonlyMap<string, string> =>
    importContextRecords(fragment.records, fragment.source.environmentId);
  const importContextFragmentStable = useStableCallback(importContextFragment);

  // ------------------------------------------------------------------
  // Sync refs back to parent
  // ------------------------------------------------------------------
  useEffect(() => {
    if (isLiteralPendingAnswer) return;
    promptRef.current = prompt;
    setComposerCursor((existing) => clampCollapsedComposerCursor(prompt, existing));
  }, [isLiteralPendingAnswer, prompt, promptRef]);

  useEffect(() => {
    if (composerSubmissionError === null) return;
    const nextError = getComposerPromptLengthValidationMessage(prompt);
    if (nextError !== composerSubmissionError) {
      setComposerSubmissionError(nextError);
    }
  }, [composerSubmissionError, prompt]);

  useEffect(() => {
    setProviderInputSubmissionError(null);
  }, [
    composerPreviewAnnotations,
    composerReviewComments,
    composerTerminalContexts,
    prompt,
    selectedModel,
    selectedPromptEffort,
    selectedProvider,
  ]);

  useEffect(() => {
    composerImagesRef.current = composerImages;
  }, [composerImages, composerImagesRef]);

  useEffect(() => {
    composerFilesRef.current = composerFiles;
  }, [composerFiles, composerFilesRef]);

  useEffect(() => {
    composerTerminalContextsRef.current = composerTerminalContexts;
  }, [composerTerminalContexts, composerTerminalContextsRef]);

  // ------------------------------------------------------------------
  // Composer menu highlight sync
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!composerMenuOpen) {
      setComposerHighlightedItemId(null);
      setComposerHighlightedSearchKey(null);
      return;
    }
    const nextActiveItemId = resolveComposerMenuActiveItemId({
      items: composerMenuItems,
      highlightedItemId: composerHighlightedItemId,
      currentSearchKey: composerMenuSearchKey,
      highlightedSearchKey: composerHighlightedSearchKey,
    });
    setComposerHighlightedItemId((existing) =>
      existing === nextActiveItemId ? existing : nextActiveItemId,
    );
    setComposerHighlightedSearchKey((existing) =>
      existing === composerMenuSearchKey ? existing : composerMenuSearchKey,
    );
  }, [
    composerHighlightedItemId,
    composerHighlightedSearchKey,
    composerMenuItems,
    composerMenuOpen,
    composerMenuSearchKey,
  ]);

  const lastSyncedPendingInputRef = useRef<{
    requestId: string | null;
    questionId: string | null;
  } | null>(null);

  useEffect(() => {
    const nextCustomAnswer = activePendingProgress?.customAnswer;
    if (typeof nextCustomAnswer !== "string") {
      // The question is gone and the editor shows the thread draft again. The
      // ref still holds the last answer text, and Send reads the ref. Place
      // the caret at the end so the next keystroke appends.
      if (lastSyncedPendingInputRef.current !== null) {
        promptRef.current = prompt;
        const { cursor, trigger } = composerStateAtPromptEnd(prompt);
        setComposerCursor(cursor);
        resetComposerTrigger(trigger);
      }
      lastSyncedPendingInputRef.current = null;
      return;
    }

    const nextRequestId = activePendingUserInput?.requestId ?? null;
    const nextQuestionId = activePendingProgress?.activeQuestion?.id ?? null;
    const questionChanged =
      lastSyncedPendingInputRef.current?.requestId !== nextRequestId ||
      lastSyncedPendingInputRef.current?.questionId !== nextQuestionId;
    const textChangedExternally = promptRef.current !== nextCustomAnswer;

    lastSyncedPendingInputRef.current = {
      requestId: nextRequestId,
      questionId: nextQuestionId,
    };

    if (!questionChanged && !textChangedExternally) {
      return;
    }

    promptRef.current = nextCustomAnswer;
    const { cursor, trigger } = composerStateAtPromptEnd(nextCustomAnswer, isLiteralPendingAnswer);
    setComposerCursor(cursor);
    resetComposerTrigger(trigger);
    setComposerHighlightedItemId(null);
  }, [
    activePendingProgress?.customAnswer,
    activePendingProgress?.activeQuestion?.id,
    isLiteralPendingAnswer,
    activePendingUserInput?.requestId,
    prompt,
    promptRef,
    resetComposerTrigger,
  ]);

  // ------------------------------------------------------------------
  // Reset compositor state on thread/draft change
  // ------------------------------------------------------------------
  useEffect(() => {
    setComposerHighlightedItemId(null);
    setComposerHighlightedSearchKey(null);
    setComposerSubmissionError(null);
    setProviderInputSubmissionError(null);
    const { cursor, trigger } = composerStateAtPromptEnd(promptRef.current, isLiteralPendingAnswer);
    setComposerCursor(cursor);
    resetComposerTrigger(trigger);
    setIsDragOverComposer(false);
  }, [draftId, activeThreadId, isLiteralPendingAnswer, promptRef, resetComposerTrigger]);

  // ------------------------------------------------------------------
  // Footer compact layout observation
  // ------------------------------------------------------------------
  useLayoutEffect(() => {
    const composerForm = composerFormRef.current;
    if (!composerForm) return;
    const measureComposerFormWidth = () => composerForm.clientWidth;
    const measureFooterCompactness = () => {
      const composerFormWidth = measureComposerFormWidth();
      const footerCompact = shouldUseCompactComposerFooter(composerFormWidth, {
        hasWideActions: composerFooterHasWideActions,
      });
      const primaryActionsCompact =
        footerCompact &&
        shouldUseCompactComposerPrimaryActions(composerFormWidth, {
          hasWideActions: composerFooterHasWideActions,
        });
      return {
        primaryActionsCompact,
        footerCompact,
      };
    };

    const initialCompactness = measureFooterCompactness();
    setIsComposerPrimaryActionsCompact(initialCompactness.primaryActionsCompact);
    setIsComposerFooterCompact(initialCompactness.footerCompact);
    return observeResize(composerForm, () => {
      const nextCompactness = measureFooterCompactness();
      setIsComposerPrimaryActionsCompact((previous) =>
        previous === nextCompactness.primaryActionsCompact
          ? previous
          : nextCompactness.primaryActionsCompact,
      );
      setIsComposerFooterCompact((previous) =>
        previous === nextCompactness.footerCompact ? previous : nextCompactness.footerCompact,
      );
    });
  }, [
    activeThreadId,
    composerFooterActionLayoutKey,
    composerFooterHasWideActions,
    isComposerCollapsedMobile,
  ]);

  // ------------------------------------------------------------------
  // Image persist effect
  // ------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (composerImages.length === 0) {
        clearComposerDraftPersistedAttachments(attachmentDraftTarget);
        return;
      }
      const getPersistedAttachmentsForThread = () =>
        getComposerDraft(attachmentDraftTarget)?.persistedAttachments ?? [];
      try {
        const currentPersistedAttachments = getPersistedAttachmentsForThread();
        const existingPersistedById = new Map(
          currentPersistedAttachments.map((attachment) => [attachment.id, attachment]),
        );
        const stagedAttachmentById = new Map<string, PersistedComposerImageAttachment>();
        await Promise.all(
          composerImages.map(async (image) => {
            try {
              const dataUrl = await readFileAsDataUrl(image.file);
              stagedAttachmentById.set(image.id, {
                id: image.id,
                name: image.name,
                mimeType: image.mimeType,
                sizeBytes: image.sizeBytes,
                dataUrl,
              });
            } catch {
              const existingPersisted = existingPersistedById.get(image.id);
              if (existingPersisted) {
                stagedAttachmentById.set(image.id, existingPersisted);
              }
            }
          }),
        );
        const serialized = Array.from(stagedAttachmentById.values());
        if (cancelled) return;
        syncComposerDraftPersistedAttachments(attachmentDraftTarget, serialized);
      } catch {
        const currentImageIds = new Set(composerImages.map((image) => image.id));
        const fallbackPersistedAttachments = getPersistedAttachmentsForThread();
        const fallbackPersistedIds: Array<string> = [];
        for (const attachment of fallbackPersistedAttachments) {
          if (currentImageIds.has(attachment.id)) {
            fallbackPersistedIds.push(attachment.id);
          }
        }
        const fallbackPersistedIdSet = new Set(fallbackPersistedIds);
        const fallbackAttachments = fallbackPersistedAttachments.filter((attachment) =>
          fallbackPersistedIdSet.has(attachment.id),
        );
        if (cancelled) return;
        syncComposerDraftPersistedAttachments(attachmentDraftTarget, fallbackAttachments);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    attachmentDraftTarget,
    clearComposerDraftPersistedAttachments,
    composerImages,
    getComposerDraft,
    syncComposerDraftPersistedAttachments,
  ]);

  // ------------------------------------------------------------------
  // Callbacks: prompt change
  // ------------------------------------------------------------------

  /**
   * Payloads for chips the prompt no longer references. History undo restores the
   * reference text but knows nothing about the draft records behind it, so a delete keeps its
   * payload here and an undo puts it back rather than leaving a dangling chip.
   */
  const removedContextPayloadsRef = useRef<{
    terminals: Map<string, TerminalContextDraft>;
    reviewComments: Map<string, ReviewCommentContext>;
    threads: Map<string, LinkContextRecord>;
  }>({ terminals: new Map(), reviewComments: new Map(), threads: new Map() });
  const removedAttachmentContextPayloadsRef = useRef<RetainedAttachmentContextPayloads>({
    files: new Map(),
    previewAnnotations: new Map(),
  });

  const onPromptChange = (
    nextPrompt: string,
    nextCursor: number,
    expandedCursor: number,
    cursorAdjacentToMention: boolean,
    contextIds: string[],
  ) => {
    if (activePendingProgress?.activeQuestion && pendingUserInputs.length > 0) {
      if (activePendingProgress.activeQuestion.allowCustomAnswer === false) return;
      setComposerCursor(nextCursor);
      setComposerTrigger(
        cursorAdjacentToMention ? null : detectComposerTrigger(nextPrompt, expandedCursor),
      );
      onChangeActivePendingUserInputCustomAnswer(
        activePendingProgress.activeQuestion.id,
        nextPrompt,
        nextCursor,
        expandedCursor,
        cursorAdjacentToMention,
      );
      return;
    }
    onTypingGuardDraftChange();
    promptRef.current = nextPrompt;
    setPrompt(nextPrompt);
    // Any edit ends browsing, even one later undone by hand: typing a
    // character and deleting it leaves the text equal to the recall, and
    // ArrowDown must move the caret then, not clear the composer.
    if (promptHistoryPositionRef.current?.recalled !== nextPrompt) {
      promptHistoryPositionRef.current = null;
    }
    const referenced = new Set(contextIds);
    const retained = removedContextPayloadsRef.current;

    // An undone delete brings the reference back; restore the payload it points at.
    const liveTerminalIds = new Set<string>(
      composerTerminalContexts.map((context) => terminalContextReference(context).contextId),
    );
    const restoredTerminals = [...referenced].flatMap((contextId) => {
      if (liveTerminalIds.has(contextId)) return [];
      const context = retained.terminals.get(contextId);
      return context ? [context] : [];
    });
    const nextTerminals = [
      ...composerTerminalContexts.filter((context) =>
        referenced.has(terminalContextReference(context).contextId),
      ),
      ...restoredTerminals,
    ];
    for (const context of composerTerminalContexts) {
      const contextId = terminalContextReference(context).contextId;
      if (!referenced.has(contextId)) retained.terminals.set(contextId, context);
    }
    if (nextTerminals.length !== composerTerminalContexts.length || restoredTerminals.length > 0) {
      setComposerDraftTerminalContexts(composerDraftTarget, nextTerminals);
    }

    const liveThreadIds = new Set<string>(composerThreadContexts.map((record) => record.contextId));
    const restoredThreads = [...referenced].flatMap((contextId) => {
      if (liveThreadIds.has(contextId)) return [];
      const record = retained.threads.get(contextId);
      return record ? [record] : [];
    });
    const nextThreads = [
      ...composerThreadContexts.filter((record) => referenced.has(record.contextId)),
      ...restoredThreads,
    ];
    for (const record of composerThreadContexts) {
      if (!referenced.has(record.contextId)) retained.threads.set(record.contextId, record);
    }
    if (nextThreads.length !== composerThreadContexts.length || restoredThreads.length > 0) {
      setComposerDraftThreadContexts(composerDraftTarget, nextThreads);
    }

    for (const comment of composerReviewComments) {
      const contextId = reviewCommentContextId(comment.id);
      if (!referenced.has(contextId)) {
        retained.reviewComments.set(contextId, comment);
        removeComposerDraftReviewComment(composerDraftTarget, comment.id);
      }
    }
    const liveReviewIds = new Set<string>(
      composerReviewComments.map((comment) => reviewCommentContextId(comment.id)),
    );
    for (const contextId of referenced) {
      if (liveReviewIds.has(contextId)) continue;
      const comment = retained.reviewComments.get(contextId);
      if (comment) {
        addComposerDraftReviewComment(composerDraftTarget, comment, { appendReference: false });
      }
    }

    const attachmentChanges = reconcileAttachmentContextReferences({
      referencedContextIds: referenced,
      files: composerFiles,
      images: composerImages,
      previewAnnotations: composerPreviewAnnotations,
      retained: removedAttachmentContextPayloadsRef.current,
    });
    for (const annotationId of attachmentChanges.annotationIdsToRemove) {
      // Keep the upload queue entry alive: undo restores the image that owns it.
      removeComposerDraftPreviewAnnotation(composerDraftTarget, annotationId);
    }
    for (const restored of attachmentChanges.annotationsToRestore) {
      if (restored.image) addComposerDraftImages(attachmentDraftTarget, [restored.image]);
      addComposerDraftPreviewAnnotation(composerDraftTarget, restored.annotation, {
        appendReference: false,
      });
    }
    for (const fileId of attachmentChanges.filesToRemove) {
      // The retained File and upload are still sendable if the editor restores the chip.
      removeComposerDraftFile(attachmentDraftTarget, fileId);
    }
    if (attachmentChanges.filesToRestore.length > 0) {
      addComposerDraftFiles(attachmentDraftTarget, attachmentChanges.filesToRestore);
    }
    setComposerCursor(nextCursor);
    setComposerTrigger(
      cursorAdjacentToMention ? null : detectComposerTrigger(nextPrompt, expandedCursor),
    );
  };
  const onPromptChangeStable = useStableCallback(onPromptChange);

  // ------------------------------------------------------------------
  // Callbacks: prompt replacement / menu
  // ------------------------------------------------------------------
  const applyPromptReplacement = (
    rangeStart: number,
    rangeEnd: number,
    replacement: string,
    options?: {
      expectedText?: string;
      expandedCursorAfterReplace?: number;
      focusEditorAfterReplace?: boolean;
      citationComment?: {
        start: number;
        sourceAnchor: AssistantCitationSourceAnchor;
        insertedSpaces: ComposerCitationCommentRequest["insertedSpaces"];
      };
    },
  ): boolean => {
    if (
      activePendingUserInput &&
      activePendingProgress?.activeQuestion?.allowCustomAnswer === false
    ) {
      return false;
    }
    const currentText = promptRef.current;
    const safeStart = Math.max(0, Math.min(currentText.length, rangeStart));
    const safeEnd = Math.max(safeStart, Math.min(currentText.length, rangeEnd));
    if (
      options?.expectedText !== undefined &&
      currentText.slice(safeStart, safeEnd) !== options.expectedText
    ) {
      return false;
    }
    const next = replaceTextRange(promptRef.current, rangeStart, rangeEnd, replacement);
    const nextCursor = collapseExpandedComposerCursor(
      next.text,
      options?.expandedCursorAfterReplace ?? next.cursor,
      isLiteralPendingAnswer,
    );
    const nextExpandedCursor = expandCollapsedComposerCursor(
      next.text,
      nextCursor,
      isLiteralPendingAnswer,
    );
    if (options?.citationComment) {
      composerEditorRef.current?.requestCitationComment({
        previousValue: currentText,
        value: next.text,
        citationStart: options.citationComment.start,
        sourceAnchor: options.citationComment.sourceAnchor,
        insertedSpaces: options.citationComment.insertedSpaces,
      });
    }
    promptRef.current = next.text;
    const activePendingQuestion = activePendingProgress?.activeQuestion;
    if (activePendingQuestion && activePendingUserInput) {
      onChangeActivePendingUserInputCustomAnswer(
        activePendingQuestion.id,
        next.text,
        nextCursor,
        nextExpandedCursor,
        isLiteralPendingAnswer,
      );
    } else {
      setPrompt(next.text);
      onTypingGuardDraftChange();
    }
    setComposerCursor(nextCursor);
    setComposerTrigger(
      isLiteralPendingAnswer ? null : detectComposerTrigger(next.text, nextExpandedCursor),
    );
    if (options?.focusEditorAfterReplace !== false) {
      window.requestAnimationFrame(() => {
        // Type-to-focus routes only the first key through here; once the
        // controlled update focuses the editor, later keys land natively.
        // Skip the deferred caret placement when the draft has moved on,
        // or it drags the caret back behind what was typed since.
        if (promptRef.current !== next.text) return;
        composerEditorRef.current?.focusAt(nextCursor);
      });
    }
    return true;
  };
  const applyPromptReplacementStable = useStableCallback(applyPromptReplacement);

  const readComposerSnapshot = (): {
    value: string;
    cursor: number;
    expandedCursor: number;
    contextIds: string[];
  } => {
    const editorSnapshot = composerEditorRef.current?.readSnapshot();
    if (editorSnapshot) {
      return editorSnapshot;
    }
    return {
      value: promptRef.current,
      cursor: composerCursor,
      expandedCursor: expandCollapsedComposerCursor(
        promptRef.current,
        composerCursor,
        isLiteralPendingAnswer,
      ),
      contextIds: isLiteralPendingAnswer ? [] : collectInlineContextIds(promptRef.current),
    };
  };
  const readComposerSnapshotStable = useStableCallback(readComposerSnapshot);

  const resolveActiveComposerTrigger = (): {
    snapshot: { value: string; cursor: number; expandedCursor: number };
    trigger: ComposerTrigger | null;
  } => {
    const snapshot = readComposerSnapshot();
    return {
      snapshot,
      trigger: isLiteralPendingAnswer
        ? null
        : resolveComposerTrigger(detectComposerTrigger(snapshot.value, snapshot.expandedCursor)),
    };
  };

  const { onUsageLimitsCommand } = props;
  /**
   * The one way a source enters the draft, from the Sources picker or `@`: its chip at the
   * caret (or in place of the `@` query) and its record beside it. Picking a source the draft
   * already holds adds another chip for the same record.
   */
  const insertIntegrationSource = (
    source: IntegrationSource,
    replace?: { text: string; rangeStart: number; rangeEnd: number },
  ): boolean => {
    const record = integrationContextRecord(source);
    const replacement = `${formatInlineContextReference(linkContextReference(record))} `;
    if (!replace) {
      if (insertComposerText(replacement, "cursor", { ensureLeadingBoundary: true })) {
        addComposerDraftThreadContexts(attachmentDraftTarget, [record], { appendReference: false });
        return true;
      }
      // The editor is not taking input (connecting, a question pending): the store appends
      // the chip to the draft, as it does for context from other panels.
      addComposerDraftThreadContexts(attachmentDraftTarget, [record]);
      return false;
    }
    const rangeEnd = extendReplacementRangeForTrailingSpace(
      replace.text,
      replace.rangeEnd,
      replacement,
    );
    const applied = applyPromptReplacement(replace.rangeStart, rangeEnd, replacement, {
      expectedText: replace.text.slice(replace.rangeStart, rangeEnd),
    });
    if (applied) {
      addComposerDraftThreadContexts(attachmentDraftTarget, [record], { appendReference: false });
    }
    return applied;
  };
  const insertIntegrationSourceStable = useStableCallback(insertIntegrationSource);

  const onSelectComposerItem = (item: ComposerCommandItem) => {
    if (composerSelectLockRef.current) return;
    composerSelectLockRef.current = true;
    window.requestAnimationFrame(() => {
      composerSelectLockRef.current = false;
    });
    const { snapshot, trigger } = resolveActiveComposerTrigger();
    if (!trigger) return;
    if (item.type === "path") {
      const replacement = `${serializeComposerFileLink(item.path)} `;
      const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
        snapshot.value,
        trigger.rangeEnd,
        replacement,
      );
      const applied = applyPromptReplacement(trigger.rangeStart, replacementRangeEnd, replacement, {
        expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd),
      });
      if (applied) {
        setComposerHighlightedItemId(null);
      }
      return;
    }
    if (item.type === "slash-command") {
      if (item.command === "model") {
        const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
          expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
          focusEditorAfterReplace: false,
        });
        if (applied) {
          setComposerHighlightedItemId(null);
          setIsComposerModelPickerOpen(true);
        }
        return;
      }
      if (!planModeUiEnabled) return;
      void handleInteractionModeChange(item.command === "plan" ? "plan" : "default");
      const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
        expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
      });
      if (applied) {
        setComposerHighlightedItemId(null);
      }
      return;
    }
    if (item.type === "provider-slash-command") {
      if (item.command.name === USAGE_LIMITS_COMMAND.name && onUsageLimitsCommand) {
        const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
          expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
          focusEditorAfterReplace: false,
        });
        if (applied) {
          setComposerHighlightedItemId(null);
          onUsageLimitsCommand();
        }
        return;
      }
      const replacement = `/${item.command.name} `;
      const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
        snapshot.value,
        trigger.rangeEnd,
        replacement,
      );
      const applied = applyPromptReplacement(trigger.rangeStart, replacementRangeEnd, replacement, {
        expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd),
      });
      if (applied) {
        setComposerHighlightedItemId(null);
      }
      return;
    }
    if (item.type === "skill") {
      const replacement = `$${item.skill.name} `;
      const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
        snapshot.value,
        trigger.rangeEnd,
        replacement,
      );
      const applied = applyPromptReplacement(trigger.rangeStart, replacementRangeEnd, replacement, {
        expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd),
      });
      if (applied) {
        setComposerHighlightedItemId(null);
      }
      return;
    }
    if (item.type === "pull-request") {
      if (
        trigger.kind !== "pull-request" ||
        !composerMenuItemsRef.current.some((candidate) => candidate.id === item.id)
      ) {
        return;
      }
      const comment = buildPullRequestReferenceContext(item.pullRequest);
      const replacement = `${formatInlineContextReference(
        reviewCommentContextReference(comment),
      )} `;
      const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
        snapshot.value,
        trigger.rangeEnd,
        replacement,
      );
      const applied = applyPromptReplacement(trigger.rangeStart, replacementRangeEnd, replacement, {
        expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd),
      });
      if (applied) {
        addComposerDraftReviewComment(composerDraftTarget, comment, {
          appendReference: false,
        });
        setComposerHighlightedItemId(null);
      }
      return;
    }
    if (item.type === "thread") {
      if (trigger.kind !== "path") return;
      const shell = readThreadShell(item.thread);
      if (!shell) return;
      const record = threadContextRecord(item.thread, shell.title);
      const replacement = `${formatInlineContextReference(linkContextReference(record))} `;
      const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
        snapshot.value,
        trigger.rangeEnd,
        replacement,
      );
      const applied = applyPromptReplacement(trigger.rangeStart, replacementRangeEnd, replacement, {
        expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd),
      });
      if (applied) {
        addComposerDraftThreadContexts(attachmentDraftTarget, [record], {
          appendReference: false,
        });
        setComposerHighlightedItemId(null);
      }
      return;
    }
    if (item.type === "agent" || item.type === "project-folder") {
      if (trigger.kind !== "path") return;
      const record =
        item.type === "agent"
          ? agentContextRecord({ ...item.agent, agentId: item.agent.id })
          : projectFolderContextRecord({
              environmentId: item.projectFolder.environmentId,
              projectFolderId: item.projectFolder.id,
              name: item.projectFolder.name,
            });
      const replacement = `${formatInlineContextReference(linkContextReference(record))} `;
      const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
        snapshot.value,
        trigger.rangeEnd,
        replacement,
      );
      const applied = applyPromptReplacement(trigger.rangeStart, replacementRangeEnd, replacement, {
        expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd),
      });
      if (applied) {
        addComposerDraftThreadContexts(attachmentDraftTarget, [record], {
          appendReference: false,
        });
        setComposerHighlightedItemId(null);
      }
      return;
    }
    if (item.type === "integration") {
      if (trigger.kind !== "path") return;
      if (
        insertIntegrationSource(item.source, {
          text: snapshot.value,
          rangeStart: trigger.rangeStart,
          rangeEnd: trigger.rangeEnd,
        })
      ) {
        setComposerHighlightedItemId(null);
      }
      return;
    }
  };
  const onSelectComposerItemStable = useStableCallback(onSelectComposerItem);

  const onComposerMenuItemHighlighted = (itemId: string | null) => {
    setComposerHighlightedItemId(itemId);
    setComposerHighlightedSearchKey(composerMenuSearchKey);
  };
  const onComposerMenuItemHighlightedStable = useStableCallback(onComposerMenuItemHighlighted);

  const nudgeComposerMenuHighlight = (key: "ArrowDown" | "ArrowUp") => {
    if (composerMenuItems.length === 0) return;
    const highlightedIndex = composerMenuItems.findIndex(
      (item) => item.id === composerHighlightedItemId,
    );
    const normalizedIndex = highlightedIndex >= 0 ? highlightedIndex : key === "ArrowDown" ? -1 : 0;
    const offset = key === "ArrowDown" ? 1 : -1;
    const nextIndex =
      (normalizedIndex + offset + composerMenuItems.length) % composerMenuItems.length;
    const nextItem = composerMenuItems[nextIndex];
    setComposerHighlightedItemId(nextItem?.id ?? null);
  };

  const blurMobileComposerAfterSend = () => {
    if (!isMobileViewport) return;
    if (composerBlurFrameRef.current !== null) {
      window.cancelAnimationFrame(composerBlurFrameRef.current);
      composerBlurFrameRef.current = null;
    }
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement) {
      activeElement.blur();
    }
    setIsComposerFocused(false);
  };

  const shouldBlurMobileComposerOnSubmit = () => {
    if (!isMobileViewport) return false;
    if (
      isSendBusy ||
      isSendDisabled ||
      isConnecting ||
      noProviderAvailable ||
      environmentUnavailable !== null ||
      phase === "running"
    ) {
      return false;
    }
    if (activePendingProgress) {
      return activePendingProgress.isLastQuestion && Boolean(activePendingResolvedAnswers);
    }
    return showPlanFollowUpPrompt || composerSendState.hasSendableContent;
  };

  const submitComposer = (
    event?: { preventDefault: () => void },
    dispatchMode?: ComposerDispatchMode,
    submissionIntent?: ComposerSubmissionIntent,
  ) => {
    if (dictationActiveRef.current && dictationRef.current) {
      // Enter or Send while dictating: settle what was said, then send it with the draft.
      event?.preventDefault();
      void dictationRef.current.finish().then((completed) => {
        if (!completed) return;
        // A frame lets the draft render with the last segment before the send reads it.
        window.requestAnimationFrame(() => {
          if (dictationActiveRef.current) return;
          submitAfterDictationRef.current?.(undefined, dispatchMode, submissionIntent);
        });
      });
      return;
    }
    if (
      noProviderAvailable ||
      isSendDisabled ||
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
    ) {
      event?.preventDefault();
      return;
    }
    // A send while a pasted image is still compressing would strand that
    // image: the turn snapshot wouldn't include it, and it would surface
    // in the *next* draft instead. Only oversized images hit this — small
    // files clear the pending counter within a microtask.
    if (activeThreadId && (pendingImageCompressionsRef.current.get(attachmentTargetKey) ?? 0) > 0) {
      event?.preventDefault();
      toastManager.add({
        type: "info",
        title: "Still compressing a pasted image.",
        description: "Send again once its thumbnail appears.",
      });
      return;
    }
    // A pasted chip's bytes arrive over the network, so the same hazard applies for longer:
    // sending now would snapshot a chip with no attachment behind it.
    if (pendingDraftWork.has(attachmentTargetKey)) {
      event?.preventDefault();
      toastManager.add({
        type: "info",
        title: "Still bringing attached context into this message.",
        description: "Send again once its chip resolves.",
      });
      return;
    }
    const submission = submitComposerDraft({
      prompt: promptRef.current,
      submissionTarget: activePendingProgress ? "pending-user-input" : "provider-turn",
      event,
      onSend: (sendEvent) => {
        // ChatView reports its final composed-input preflight through the
        // composer handle before its first asynchronous send step.
        providerInputRejectedRef.current = false;
        onSend(
          sendEvent,
          dispatchMode ??
            resolveComposerDispatchMode({
              running: phase === "running",
              alternateModifier: false,
              activeTurnDefault: settings.followUpBehavior,
            }),
          submissionIntent,
        );
        return !providerInputRejectedRef.current;
      },
    });
    setComposerSubmissionError(submission.validationMessage);
    if (!submission.didDispatch) return;
    onTypingGuardSend();
    if (shouldBlurMobileComposerOnSubmit()) {
      blurMobileComposerAfterSend();
    }
  };
  const submitComposerStable = useStableCallback(submitComposer);
  useEffect(() => {
    submitAfterDictationRef.current = submitComposerStable;
  }, [submitComposerStable]);
  const handleSubmitMessage = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    submitComposer(
      event,
      resolveComposerDispatchMode({
        running: phase === "running",
        alternateModifier: event.metaKey || event.ctrlKey,
        activeTurnDefault: settings.followUpBehavior,
      }),
    );
  };
  const handleSubmitMessageStable = useStableCallback(handleSubmitMessage);
  const submitCitationAndSend = () => {
    submitComposer(
      undefined,
      resolveComposerDispatchMode({
        running: phase === "running",
        alternateModifier: false,
        activeTurnDefault: settings.followUpBehavior,
      }),
    );
  };
  const submitCitationAndSendStable = useStableCallback(submitCitationAndSend);
  // A question or approval took the editor while a citation comment was
  // unsaved. Keep the comment in the prompt that comes back afterward.
  const saveCitationDraftToPrompt = (replacedValue: string, savedValue: string) => {
    if (replacedValue !== prompt) return;
    if (promptRef.current === replacedValue) promptRef.current = savedValue;
    setPrompt(savedValue);
  };
  const saveCitationDraftToPromptStable = useStableCallback(saveCitationDraftToPrompt);
  const compactThreadContext = () => {
    if (
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
      compactDisabled ||
      noProviderAvailable ||
      pendingUserInputs.length > 0 ||
      phase === "running" ||
      isSendBusy ||
      isConnecting ||
      !activeThreadId
    ) {
      return;
    }
    onCompactContext();
  };
  const compactThreadContextStable = useStableCallback(compactThreadContext);
  const expandMobileComposer = () => {
    if (composerBlurFrameRef.current !== null) {
      window.cancelAnimationFrame(composerBlurFrameRef.current);
      composerBlurFrameRef.current = null;
    }
    if (mobileComposerExpandFrameRef.current !== null) {
      window.cancelAnimationFrame(mobileComposerExpandFrameRef.current);
    }
    if (mobileComposerExpandReleaseFrameRef.current !== null) {
      window.cancelAnimationFrame(mobileComposerExpandReleaseFrameRef.current);
    }
    mobileComposerExpandInFlightRef.current = true;
    setIsComposerFocused(true);
    mobileComposerExpandFrameRef.current = window.requestAnimationFrame(() => {
      mobileComposerExpandFrameRef.current = null;
      composerEditorRef.current?.focusAtEnd();
      mobileComposerExpandReleaseFrameRef.current = window.requestAnimationFrame(() => {
        mobileComposerExpandReleaseFrameRef.current = null;
        mobileComposerExpandInFlightRef.current = false;
      });
    });
  };
  const expandMobileComposerStable = useStableCallback(expandMobileComposer);

  // ------------------------------------------------------------------
  // Prompt history (ArrowUp / ArrowDown)
  // ------------------------------------------------------------------
  // Entries are built on the keypress, not per render: the timeline changes
  // on every streamed delta and ArrowUp is rare.
  const promptHistoryMessagesRef = useRef(promptHistoryMessages);
  promptHistoryMessagesRef.current = promptHistoryMessages;

  // The composer persists across threads. A recall from thread A must not
  // be treated as active in thread B, where the text-match fallback could
  // otherwise turn B's own draft into a browsing position.
  const promptHistoryTargetKey = composerTargetKey(composerDraftTarget);
  useEffect(() => {
    promptHistoryPositionRef.current = null;
  }, [promptHistoryTargetKey]);

  const replacePromptFromHistory = (nextPrompt: string) => {
    promptRef.current = nextPrompt;
    setComposerDraftPrompt(composerDraftTarget, nextPrompt);
    setComposerCursor(collapseExpandedComposerCursor(nextPrompt, nextPrompt.length));
    setComposerTrigger(null);
    setComposerHighlightedItemId(null);
  };

  const navigatePromptHistory = (
    direction: "backward" | "forward",
    event: KeyboardEvent,
  ): boolean => {
    if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey || event.isComposing) {
      return false;
    }
    if (pendingUserInputs.length > 0) return false;
    // A composer holding an image, file, picked element, preview
    // annotation, or review comment is not empty. Recalling text into it
    // would send the old prompt with the new context, which is never what
    // ArrowUp meant.
    if (
      composerImagesRef.current.length > 0 ||
      composerFilesRef.current.length > 0 ||
      composerTerminalContextsRef.current.length > 0 ||
      composerPreviewAnnotations.length > 0 ||
      composerReviewComments.length > 0
    ) {
      return false;
    }
    // A typed draft with no active recall can never step, so skip the
    // layout read and the entry build for that common case.
    if (promptHistoryPositionRef.current === null && promptRef.current.length > 0) {
      return false;
    }
    const editor = composerEditorRef.current;
    if (!editor?.isCaretOnVisualEdge(direction === "backward" ? "start" : "end")) {
      return false;
    }
    const step = stepComposerPromptHistory({
      direction,
      entries: buildComposerPromptHistoryEntries(promptHistoryMessagesRef.current),
      position: promptHistoryPositionRef.current,
      currentPrompt: promptRef.current,
    });
    if (!step) return false;
    promptHistoryPositionRef.current = step.position;
    replacePromptFromHistory(step.prompt);
    return true;
  };

  // ------------------------------------------------------------------
  // Callbacks: command key
  // ------------------------------------------------------------------
  const onComposerCommandKey = (key: string, event: KeyboardEvent, isTaskItem = false) => {
    const submissionIntent = composerSubmissionIntentForKey({
      event,
      keybindings,
      isMobileViewport,
      isDraftThread: routeKind === "draft",
      isRunning: phase === "running",
      sendShortcut: settings.sendShortcut,
      prompt: promptRef.current,
    });
    if (key === "Tab" && event.shiftKey && submissionIntent === null) {
      if (!planModeUiEnabled) return false;
      toggleInteractionMode();
      return true;
    }
    const { trigger } = resolveActiveComposerTrigger();
    const menuIsActive =
      !isLiteralPendingAnswer && (composerMenuOpenRef.current || trigger !== null);
    if (key === "Escape") {
      if (!menuIsActive || event.isComposing || event.keyCode === 229) return false;
      dismissComposerTrigger(trigger);
      composerMenuOpenRef.current = false;
      return true;
    }
    if (menuIsActive && (submissionIntent === null || submissionIntent === "foreground")) {
      const currentItems = composerMenuItemsRef.current;
      const selectedItem = activeComposerMenuItemRef.current ?? currentItems[0];
      if (key === "ArrowDown" && currentItems.length > 0) {
        nudgeComposerMenuHighlight("ArrowDown");
        return true;
      }
      if (key === "ArrowUp" && currentItems.length > 0) {
        nudgeComposerMenuHighlight("ArrowUp");
        return true;
      }
      if ((key === "Enter" || key === "Tab") && selectedItem) {
        onSelectComposerItem(selectedItem);
        return true;
      }
    }
    if ((key === "ArrowUp" || key === "ArrowDown") && submissionIntent === null) {
      return navigatePromptHistory(key === "ArrowUp" ? "backward" : "forward", event);
    }
    if (submissionIntent) {
      submitComposer(
        undefined,
        resolveComposerDispatchMode({
          running: phase === "running",
          alternateModifier: submissionIntent === "alternate",
          activeTurnDefault: settings.followUpBehavior,
        }),
        submissionIntent,
      );
      return true;
    }
    // Native task splitting preserves marks and chips on both sides of the caret.
    if (key === "Enter" && isTaskItem) return false;
    if (
      !isLiteralPendingAnswer &&
      !event.isComposing &&
      (key === "Enter" || (key === "Tab" && !event.shiftKey))
    ) {
      const selection = composerEditorRef.current?.readSelectionRange();
      const snapshot = readComposerSnapshot();
      if (selection && selection.start === selection.end && snapshot.value === promptRef.current) {
        const edit =
          key === "Enter"
            ? listContinuationForEnter(snapshot.value, selection.start)
            : listIndentForTab(snapshot.value, selection.start, selection.end);
        if (
          edit &&
          applyPromptReplacement(
            edit.start,
            edit.end,
            edit.replacement,
            key === "Tab"
              ? { expandedCursorAfterReplace: selection.start + edit.replacement.length }
              : undefined,
          )
        ) {
          return true;
        }
      }
    }
    return false;
  };

  const toggleTasksDrawer = () => {
    setIsTasksDrawerOpen((open) => !open);
  };
  const toggleTasksDrawerStable = useStableCallback(toggleTasksDrawer);
  const hasBannerItems = props.bannerItems.length > 0;
  const hasBlockingComposerTopDrawer = pendingUserInputs.length > 0;
  // The badge draws nothing without steps, which would leave an empty strip.
  const showInlineTasksBadge =
    activeTasksProgress !== null &&
    activeTaskSteps !== null &&
    activeTasksProgress.totalSteps > 0 &&
    !isTasksDrawerOpen &&
    !hasBlockingComposerTopDrawer &&
    (hasBannerItems || showComposerTopDrawer || isComposerCollapsedMobile);
  const inlineTasksBadge = showInlineTasksBadge ? (
    <ComposerTasksBadge
      expanded={false}
      onToggle={toggleTasksDrawerStable}
      placement="inline"
      progress={activeTasksProgress}
      steps={activeTaskSteps}
    />
  ) : null;
  const expandedComposerImages = standaloneComposerImages;
  // Keep collapsed controls inside the input when workspace context is hidden.
  const composerControlsCollapsed = isComposerCollapsedMobile;
  const showInlineRestingControls = composerControlsCollapsed && restingControlsHost === null;
  const composerControlsVisibleInStrip =
    composerControlsCollapsed && restingControlsHost !== null && restingControlsVisible;
  const composerControlsHidden = composerControlsCollapsed && !restingControlsVisible;
  if (composerControlsHidden && isComposerModelPickerOpen) {
    setIsComposerModelPickerOpen(false);
  }
  useLayoutEffect(() => {
    onRestingControlsVisibilityChange(composerControlsVisibleInStrip);
  }, [composerControlsVisibleInStrip, onRestingControlsVisibilityChange]);
  const restingImagePreviewCounts = getRestingComposerImagePreviewCounts(
    standaloneComposerImages.length,
  );
  const restingComposerImages = standaloneComposerImages.slice(
    0,
    restingImagePreviewCounts.visibleCount,
  );
  const collapsedComposerImagePreviews =
    restingComposerImages.length > 0 ? (
      <div
        data-chat-composer-resting-images="true"
        className="flex shrink-0 items-center gap-1 ps-1"
      >
        {restingComposerImages.map((image) => (
          <button
            key={image.id}
            type="button"
            className="relative size-7 shrink-0 cursor-zoom-in overflow-hidden rounded-md border border-border/70 bg-muted/60"
            aria-label={`Preview ${image.name}`}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              const preview = buildExpandedImagePreview(composerImages, image.id);
              if (preview) onExpandImage(preview);
            }}
          >
            {image.previewUrl ? (
              <ComposerImageThumbnail
                file={image.file}
                alt=""
                className="size-full object-cover"
                fallback={
                  <PierreEntryIcon
                    pathValue={image.name}
                    kind="file"
                    theme={resolvedTheme}
                    className="m-auto size-3.5"
                  />
                }
              />
            ) : (
              <PierreEntryIcon
                pathValue={image.name}
                kind="file"
                theme={resolvedTheme}
                className="m-auto size-3.5"
              />
            )}
          </button>
        ))}
        {restingImagePreviewCounts.overflowCount > 0 ? (
          <button
            type="button"
            className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border/70 bg-muted/60 font-medium text-secondary-label text-xs tabular-nums outline-none interactive hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
            aria-label={`Show ${String(restingImagePreviewCounts.overflowCount)} more image attachments`}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              if (isComposerCollapsedMobile) {
                expandMobileComposer();
                return;
              }
              setIsComposerFocused(true);
              scheduleComposerFocus();
            }}
          >
            +{restingImagePreviewCounts.overflowCount}
          </button>
        ) : null}
      </div>
    ) : null;
  const composerMainSurfaceRef = useComposerRestingTransition(
    composerControlsCollapsed,
    restingComposerControlsRef,
    onComposerOverlayHeightChange,
    LAYOUT_MOTION_DURATION,
  );
  const restingHiddenBlockCount = composerControlsCollapsed
    ? restingControlsHiddenBlockCount
    : expandedControlsLayout.hiddenBlockCount;
  const iconOnlyBlockCount = composerControlsCollapsed
    ? restingControlsIconOnlyBlockCount
    : expandedControlsLayout.iconOnlyBlockCount;
  const { canPickProject } = useComposerProjectPickerState(
    routeThreadRef.environmentId,
    activeThreadId,
    routeKind === "draft" ? draftId : null,
  );
  const showProjectPicker = activeThreadId !== null && canPickProject;
  const showSourcesPicker = activeThreadId !== null;
  const restingProviderTraitsPicker = renderProviderTraitsPicker({
    ...providerTraitsPickerInput,
    size: composerControlsCollapsed ? "xs" : "sm",
    // Traits is the first block, so it hides once every block after it has
    // (mode, then project and sources for a thread).
    hidden:
      composerControlsHidden ||
      restingHiddenBlockCount >
        (planModeUiEnabled ? 1 : 0) + (showProjectPicker ? 1 : 0) + (showSourcesPicker ? 1 : 0),
  });
  // Sources is the last block, so it is the first to fold. A picker whose trigger folds away
  // (or unfolds, when it sits on the overflow trigger) closes rather than float off nothing.
  const sourcesBlockFolded = restingHiddenBlockCount > 0;
  const sourcesPickerOpen =
    sourcesPicker.open &&
    !composerControlsHidden &&
    (sourcesPicker.anchor === null ? !sourcesBlockFolded : sourcesBlockFolded);
  if (sourcesPicker.open && !sourcesPickerOpen) {
    setSourcesPicker({ open: false, anchor: null });
  }
  const restingBlockDefs = [
    ...(providerTraitsPicker
      ? [
          {
            id: "traits",
            // Model and effort are one group (how the agent runs), so no divider between them.
            content: restingProviderTraitsPicker,
          },
        ]
      : []),
    ...(planModeUiEnabled
      ? [
          {
            id: "mode",
            content: (
              <ComposerFooterModeControls
                interactionMode={interactionMode}
                size={composerControlsCollapsed ? "xs" : "sm"}
                onToggleInteractionMode={toggleInteractionMode}
              />
            ),
          },
        ]
      : []),
    // The project folds before the model or effort controls give way.
    ...(showProjectPicker
      ? [
          {
            id: "project",
            // The divider separates where the agent runs from how it runs.
            content: (
              <>
                <ComposerControlSeparator size={composerControlsCollapsed ? "xs" : "sm"} />
                <ComposerProjectPicker
                  environmentId={routeThreadRef.environmentId}
                  threadId={activeThreadId}
                  draftId={routeKind === "draft" ? draftId : null}
                  size={composerControlsCollapsed ? "xs" : "sm"}
                  // A draft's first send has already read its pick, so one made mid-send
                  // would be dropped; it stays shut without dimming for that moment.
                  locked={isSendBusy && routeKind === "draft"}
                />
              </>
            ),
          },
        ]
      : []),
    ...(showSourcesPicker
      ? [
          {
            // Last, so it folds first; the overflow menu then offers it.
            id: "sources",
            content: (
              <ComposerSourcesPicker
                environmentId={environmentId}
                projectLabelId={composerProjectLabelId}
                size={composerControlsCollapsed ? "xs" : "sm"}
                open={sourcesPickerOpen}
                anchor={sourcesPicker.anchor}
                onOpenChange={onSourcesPickerOpenChangeStable}
                onPick={insertIntegrationSourceStable}
              />
            ),
          },
        ]
      : []),
  ];
  // The project picker has no overflow entry; it only hides.
  const hiddenRestingBlockIds = restingBlockDefs
    .slice(restingBlockDefs.length - restingHiddenBlockCount)
    .map((def) => def.id)
    .filter((id) => id !== "project");
  const composerControls = showProviderUnavailable ? (
    <ComposerControl
      type="button"
      disabled={!providerSetupInstanceId}
      onClick={() => {
        if (providerSetupInstanceId) {
          onOpenProviderSetup(providerSetupInstanceId);
        }
      }}
      data-chat-provider-unavailable="true"
      className="shrink-0"
    >
      <CircleAlertIcon className="size-4" />
      {providerSetupInstanceId ? "Open provider settings" : "No provider available"}
    </ComposerControl>
  ) : (
    <>
      {composerControlsCollapsed &&
      restingControlsHost !== null &&
      restingControlsHaveLeadingContext ? (
        <ComposerControlSeparator
          size="xs"
          className="@max-[400px]/composer-surface:hidden"
          data-resting-controls-separator="true"
        />
      ) : null}
      <ProviderModelPicker
        environmentId={environmentId}
        compact={false}
        isComposerOwned
        // Not tied to a send: the send has already read the model, so a pick made while it
        // is in flight goes to the next turn, as the effort picker's does.
        disabled={providerCatalogPending}
        {...(routeKind === "draft" && supportsMultipleModels
          ? {
              ...(multipleModelSelections !== null
                ? { selectedModels: multipleModelSelections }
                : {}),
              onToggleModel: (instanceId: ProviderInstanceId, model: string) => {
                const current = multipleModelSelections ?? [selectedModelSelection];
                const matchesModel = (selection: ModelSelection) => {
                  if (selection.instanceId !== instanceId) return false;
                  const entry = providerInstanceEntries.find(
                    (entry) => entry.instanceId === selection.instanceId,
                  );
                  const resolvedModel = resolveModelPickerSelectedModel({
                    driverKind: entry?.driverKind,
                    model: selection.model,
                    options: modelOptionsByInstance.get(selection.instanceId) ?? [],
                  });
                  return (resolvedModel?.slug ?? selection.model) === model;
                };
                const exists = current.some(matchesModel);
                const next = exists
                  ? current.filter((selection) => !matchesModel(selection))
                  : [...current, createModelSelection(instanceId, model)];
                if (next.length > 1) {
                  setMultipleModelSelections(next);
                } else {
                  setMultipleModelSelections(null);
                  const remaining = next[0] ?? selectedModelSelection;
                  onProviderModelSelect(remaining.instanceId, remaining.model, {
                    focusComposer: false,
                  });
                }
              },
            }
          : {})}
        activeInstanceId={
          providerCatalogPending
            ? (activeThreadModelSelection?.instanceId ?? selectedInstanceId)
            : selectedInstanceId
        }
        model={
          providerCatalogPending
            ? (activeThreadModelSelection?.model ?? selectedModelForPickerWithCustomFallback)
            : selectedModelForPickerWithCustomFallback
        }
        lockedProvider={lockedProvider}
        lockedContinuationGroupKey={lockedContinuationGroupKey}
        instanceEntries={providerInstanceEntries}
        keybindings={keybindings}
        modelOptionsByInstance={modelOptionsByInstance}
        size={composerControlsCollapsed ? "xs" : "sm"}
        triggerClassName={
          composerControlsCollapsed
            ? cn(
                "min-w-13 shrink text-xs!",
                // Icon-only: the frame's negative margin cancels the gap the empty label
                // would leave, and the floor drops to icon plus chevron so the row doesn't
                // stretch them apart, keeping the icon → chevron gap the other controls have.
                !showInlineRestingControls &&
                  "@max-[640px]/composer-surface:min-w-10 @max-[640px]/composer-surface:[&_[data-chat-provider-model-picker-label-frame]]:-ms-1 @max-[640px]/composer-surface:[&_[data-chat-provider-model-picker-label]]:w-0 @max-[640px]/composer-surface:[&_[data-chat-provider-model-picker-label]]:flex-none",
              )
            : // A narrow composer shows the provider icon alone rather than a clipped
              // name (the tooltip and aria-label keep the full name); the chevron
              // stays until even that does not fit.
              "min-w-13 @max-xs/composer-surface:[&_[data-chat-provider-model-picker-label-frame]]:-ms-1.5 @max-xs/composer-surface:[&_[data-chat-provider-model-picker-label-frame]]:grid-cols-[0fr] @max-xs/composer-surface:[&_[data-chat-provider-model-picker-label-frame]]:opacity-0 @max-[12rem]/composer-surface:min-w-0 @max-[12rem]/composer-surface:[&_[data-chat-provider-model-picker-chevron]]:-ms-1.5 @max-[12rem]/composer-surface:[&_[data-chat-provider-model-picker-chevron]]:me-0 @max-[12rem]/composer-surface:[&_[data-chat-provider-model-picker-chevron]]:grid-cols-[0fr] @max-[12rem]/composer-surface:[&_[data-chat-provider-model-picker-chevron]]:opacity-0"
        }
        open={isComposerModelPickerOpen}
        instanceIndicatorBackground={
          composerControlsCollapsed ? "var(--chat-composer-glass-surface)" : "var(--contrast-input)"
        }
        {...(composerProviderState.modelPickerIconClassName || composerControlsCollapsed
          ? {
              activeProviderIconClassName: cn(
                composerProviderState.modelPickerIconClassName,
                composerControlsCollapsed &&
                  // Package glyphs get opaque fills and one opacity, so overlapping paths don't band.
                  "fill-muted-foreground/70! text-muted-foreground/70! [&_path]:fill-muted-foreground/70! [&_rect]:fill-muted-foreground/70! [&_[data-icon-detail]]:fill-transparent! [&[data-provider-package-icon]]:opacity-70 [&[data-provider-package-icon]_path:not([data-icon-detail])]:fill-muted-foreground!",
              ),
            }
          : {})}
        onOpenChange={setIsComposerModelPickerOpen}
        getModelDisabledReason={getModelDisabledReason}
        onInstanceModelChange={(instanceId, model) => {
          setMultipleModelSelections(null);
          onProviderModelSelect(instanceId, model);
        }}
        onOpenProviderSetup={onOpenProviderSetup}
      />

      <>
        {restingBlockDefs.map((def, index) => {
          const hidden = index >= restingBlockDefs.length - restingHiddenBlockCount;
          return (
            <div
              key={def.id}
              data-resting-block={def.id}
              data-composer-block-icon-only={
                index >= restingBlockDefs.length - iconOnlyBlockCount ? "true" : "false"
              }
              aria-hidden={hidden || undefined}
              inert={hidden || undefined}
              className={cn(
                // A block coming back out of overflow fades in; folding is immediate so
                // nothing overlaps while the row tightens.
                "flex w-max min-w-max shrink-0 items-center gap-1 transition-opacity duration-(--motion-duration-fast) ease-out",
                hidden && "pointer-events-none invisible absolute opacity-0",
                index >= restingBlockDefs.length - iconOnlyBlockCount &&
                  "[&_[data-composer-control-label]]:pointer-events-none [&_[data-composer-control-label]]:invisible [&_[data-composer-control-label]]:absolute [&_[data-composer-control-label]]:w-max [&_[data-composer-control-label]]:max-w-none [&_[data-composer-control-compact-icon]]:[visibility:inherit] [&_[data-composer-control-compact-icon]]:relative",
              )}
            >
              {def.content}
            </div>
          );
        })}
        <div
          ref={restingOverflowRef}
          data-resting-controls-overflow
          aria-hidden={hiddenRestingBlockIds.length === 0 || undefined}
          inert={hiddenRestingBlockIds.length === 0 || undefined}
          className={cn(
            "min-w-0 shrink-0 transition-opacity duration-(--motion-duration-fast) ease-out",
            hiddenRestingBlockIds.length === 0 &&
              "pointer-events-none invisible absolute opacity-0",
          )}
        >
          <CompactComposerControlsMenu
            interactionMode={interactionMode}
            size={composerControlsCollapsed ? "xs" : "sm"}
            hidden={composerControlsHidden || hiddenRestingBlockIds.length === 0}
            showInteractionModeToggle={planModeUiEnabled && hiddenRestingBlockIds.includes("mode")}
            traitsMenuContent={
              hiddenRestingBlockIds.includes("traits") ? providerTraitsMenuContent : undefined
            }
            onToggleInteractionMode={toggleInteractionMode}
            {...(hiddenRestingBlockIds.includes("sources")
              ? { onOpenSources: openSourcesFromOverflowStable }
              : {})}
          />
        </div>
      </>
    </>
  );
  const showTasksTab =
    !hasBannerItems &&
    !showComposerTopDrawer &&
    !isTasksDrawerOpen &&
    !isComposerCollapsedMobile &&
    activeTasksProgress !== null &&
    activeTaskSteps !== null &&
    activeTasksProgress.totalSteps > 0;
  const showTasksDrawer =
    !hasBannerItems &&
    isTasksDrawerOpen &&
    !hasBlockingComposerTopDrawer &&
    activeTasksProgress !== null &&
    activeTaskSteps !== null &&
    activeTasksProgress.totalSteps > 0;
  const activityStackContent = hasBannerItems ? (
    shownSyncPhase ? (
      <ComposerActivityRow phase={shownSyncPhase} />
    ) : !hasBlockingComposerTopDrawer && activeTasksProgress && activeTaskSteps ? (
      <ComposerTasksContent
        expanded={isTasksDrawerOpen}
        onToggle={toggleTasksDrawerStable}
        progress={activeTasksProgress}
        steps={activeTaskSteps}
      />
    ) : null
  ) : null;
  const activityStackItem: ComposerBannerStackContent | null = activityStackContent
    ? {
        id: "composer-activity",
        variant: "default",
        priority: "activity",
        content: activityStackContent,
      }
    : null;
  const bannerStackItems = activityStackItem
    ? [activityStackItem, ...props.bannerItems]
    : props.bannerItems;
  useEffect(() => {
    if (activeTasksProgress === null || activeTaskSteps === null) {
      setIsTasksDrawerOpen(false);
    }
  }, [activeTaskSteps, activeTasksProgress]);

  useEffect(() => {
    if (hasBlockingComposerTopDrawer) {
      setIsTasksDrawerOpen(false);
    }
  }, [hasBlockingComposerTopDrawer]);

  useEffect(() => {
    setIsTasksDrawerOpen(false);
  }, [activeThreadId]);

  // ------------------------------------------------------------------
  // Callbacks: attachments
  // ------------------------------------------------------------------
  /** Resolves true when at least one chip was inserted for the accepted attachments. */
  const addComposerAttachments = async (
    files: File[],
    options?: {
      readonly source?: ChatFileAttachment["source"];
      readonly selection?: { start: number; end: number };
      readonly skipImageInlineChip?: boolean;
    },
  ): Promise<boolean> => {
    if (!activeThreadId || files.length === 0 || isRevertingCheckpointRef.current) return false;
    if (
      pendingUserInputs.length > 0 &&
      (!supportsQuestionAttachments ||
        activePendingProgress?.activeQuestion?.allowCustomAnswer === false ||
        activePendingIsResponding)
    ) {
      toastManager.add({
        type: "error",
        title: "This question cannot accept attachments.",
      });
      return false;
    }
    // Captured before the awaits below: the user may switch threads while a
    // large image is being compressed, and the attachments and errors belong
    // to the thread the paste happened in.
    const threadId = activeThreadId;
    // Images landing with no prose live on the shelf with no chip. Read before
    // the awaits below: compression is async and the prompt may change while it
    // runs. An explicit selection replace and states where the editor refuses
    // input (connecting, approval, pending questions, project selection) still
    // get chips so the image is never invisible, unless paste-as-text explicitly
    // requests no inline image chip.
    const imageAttachmentsGetChips =
      !options?.skipImageInlineChip &&
      (options?.selection !== undefined ||
        isConnecting ||
        pendingUserInputs.length > 0 ||
        projectSelectionRequired ||
        stripInlineContextReferences(promptRef.current).trim().length > 0);

    // Validation happens synchronously so concurrent pastes see each other:
    // accepted files reserve their attachment slots (via the pending counter)
    // before the first await, keeping the total under the limit.
    const pendingCount = pendingImageCompressionsRef.current.get(attachmentTargetKey) ?? 0;
    const {
      images: acceptedImages,
      files: acceptedFiles,
      error,
    } = acceptComposerAttachmentFiles({
      files,
      reservedCount: countReservedAttachments(),
      stagingLimit: fileStagingLimit,
      reattachMarkers: composerFilesRef.current.filter(composerFileNeedsReattach),
      ...(options?.source ? { source: options.source } : {}),
    });
    setThreadError(threadId, error);
    let insertedAny = false;
    if (acceptedFiles.length > 0) {
      // Only files the draft actually took get a chip; a duplicate is deduped by the store
      // and a chip for it would point at nothing.
      const storedIds = new Set(addComposerFilesToDraft(acceptedFiles));
      const storedFiles = acceptedFiles.filter((file) => storedIds.has(file.id));
      if (storedFiles.length > 0) {
        insertedAny = insertAttachmentReferences(
          storedFiles.map(fileContextReference),
          options?.selection,
        );
      }
      if (options?.source?._tag === "pasted-text" && storedFiles.length > 0) {
        const attached = storedFiles[0]!;
        toastManager.add({
          type: "info",
          title: `Large paste attached as ${attached.name}`,
          description: `${formatAttachmentSize(attached.sizeBytes)} · Use ${
            isMacPlatform(navigator.platform) ? "⌘⇧V" : "Ctrl+Shift+V"
          } to keep a large paste inline.`,
          data: { hideCopyButton: true },
        });
      }
    }
    if (acceptedImages.length === 0) return insertedAny;

    pendingImageCompressionsRef.current.set(
      attachmentTargetKey,
      pendingCount + acceptedImages.length,
    );
    if (questionAttachmentTarget)
      changeQuestionAttachmentPreparation(questionAttachmentTarget, acceptedImages.length);
    try {
      const { images: nextImages, error: compressionError } =
        await prepareComposerImageAttachments(acceptedImages);
      if (
        questionAttachmentTarget &&
        !useQuestionAttachmentPreparation.getState().counts[questionAttachmentTarget]
      ) {
        for (const image of nextImages) URL.revokeObjectURL(image.previewUrl);
        return false;
      }
      const storedImageIds = new Set(
        nextImages.length === 1 && nextImages[0]
          ? addComposerImage(nextImages[0])
          : nextImages.length > 1
            ? addComposerImagesToDraft(nextImages)
            : [],
      );
      const storedImages = nextImages.filter((image) => storedImageIds.has(image.id));
      if (storedImages.length > 0 && imageAttachmentsGetChips) {
        insertedAny =
          insertAttachmentReferences(storedImages.map(imageContextReference)) || insertedAny;
      }
      // Only failures are reported here. Success must not pass `null`: by
      // now other work (a failed send, an overlapping paste) may have set a
      // thread error this call knows nothing about, and clearing it would
      // swallow that message.
      if (compressionError !== null) {
        setThreadError(threadId, compressionError);
      }
    } finally {
      if (questionAttachmentTarget)
        changeQuestionAttachmentPreparation(questionAttachmentTarget, -acceptedImages.length);
      const remaining =
        (pendingImageCompressionsRef.current.get(attachmentTargetKey) ?? 0) - acceptedImages.length;
      if (remaining > 0) {
        pendingImageCompressionsRef.current.set(attachmentTargetKey, remaining);
      } else {
        pendingImageCompressionsRef.current.delete(attachmentTargetKey);
      }
    }
    return insertedAny;
  };

  /**
   * Chips for freshly attached files land at the caret; when the editor cannot take
   * input (approval, pending questions) they are appended so the file is never invisible.
   * Images skip this when they land with no prose and the editor takes input:
   * the shelf thumbnail is enough.
   */
  const insertAttachmentReferences = (
    references: ReadonlyArray<ComposerContextReference>,
    selection?: { start: number; end: number },
  ): boolean => {
    if (references.length === 0) return false;
    // Question answers carry attachments beside the answer, never as chips. Falling back to
    // the thread prompt here would hide the file behind a reference the question never shows.
    if (questionAttachmentTarget) return false;
    if (selection) {
      const edit = inlineContextReferenceReplacement(promptRef.current, selection, references);
      return applyPromptReplacement(edit.start, edit.end, edit.text);
    }
    const text = references.map(formatInlineContextReference).join(" ");
    const inserted = insertComposerText(`${text} `, "cursor", { ensureLeadingBoundary: true });
    if (!inserted) {
      setPrompt(ensureInlineContextReferences(promptRef.current, references));
    }
    return true;
  };

  const removeComposerImage = (imageId: string) => {
    const image = composerImagesRef.current.find((candidate) => candidate.id === imageId);
    const referenced = collectInlineContextIds(promptRef.current).includes(
      image ? imageContextReference(image).contextId : "",
    );
    if (!referenced) {
      removeComposerImageFromDraft(imageId);
      return;
    }
    const confirmation = requestConfirmDialog(
      `Remove ${image?.name ?? "this image"} from the message?\nIt is referenced in your text; removing it also removes every reference.`,
      { variant: "destructive" },
    );
    if (!confirmation) {
      removeComposerImageFromDraft(imageId);
      return;
    }
    void confirmation.then((confirmed) => {
      if (confirmed) removeComposerImageFromDraft(imageId);
    });
  };

  // ------------------------------------------------------------------
  // Callbacks: paste / drag
  // ------------------------------------------------------------------
  const foldPastedText = (
    plainText: string,
    bypassAutoAttachment: boolean,
    selectionOverride?: { start: number; end: number },
  ): boolean => {
    // Editor answers keep pasted text in the answer, regardless of paste size.
    if (isLiteralPendingAnswer) return false;
    const questionCanAttach =
      pendingUserInputs.length === 0 ||
      (supportsQuestionAttachments &&
        activePendingProgress?.activeQuestion?.allowCustomAnswer !== false &&
        !activePendingIsResponding);
    const hasAttachmentSlot = countReservedAttachments() < PROVIDER_SEND_TURN_MAX_ATTACHMENTS;
    const selection = selectionOverride ?? composerEditorRef.current?.readSelectionRange();
    const wouldExceedInputLimit = wouldTextPasteExceedLimit({
      valueLength: promptRef.current.length,
      selection: selection ?? { start: 0, end: 0 },
      textLength: plainText.length,
      maxLength: PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
    });
    const shouldFold =
      pastedTextDisposition({
        text: plainText,
        bypassAutoAttachment,
        wouldExceedInputLimit,
        canAttach: true,
      }) === "attachment";
    if (!shouldFold) {
      return false;
    }

    const canStageAttachment =
      Boolean(activeThreadId) &&
      !isRevertingCheckpointRef.current &&
      questionCanAttach &&
      hasAttachmentSlot;
    if (!canStageAttachment || fileStagingLimit === null) {
      if (!wouldExceedInputLimit) {
        return false;
      }
      toastManager.add({
        type: "error",
        title: "Pasted text is too large for this message",
        description: "Remove some text or an attachment, then paste again.",
        data: { hideCopyButton: true },
      });
      return true;
    }

    if (pastedTextFileNamesRef.current.targetKey !== attachmentTargetKey) {
      pastedTextFileNamesRef.current = { targetKey: attachmentTargetKey, names: new Set() };
    }
    const reservedNames = pastedTextFileNamesRef.current.names;
    for (const file of composerFilesRef.current) reservedNames.add(file.name);
    const foldedFileName = nextPastedTextFileName([...reservedNames]);
    reservedNames.add(foldedFileName);
    const foldedFile = new File([plainText], foldedFileName, {
      type: "text/plain;charset=utf-8",
    });
    if (foldedFile.size > fileStagingLimit) {
      reservedNames.delete(foldedFileName);
      if (!wouldExceedInputLimit) return false;
      toastManager.add({
        type: "error",
        title: "Pasted text is too large to attach",
        description: "Reduce the clipboard contents or save a smaller excerpt as a file.",
        data: { hideCopyButton: true },
      });
      return true;
    }

    void addComposerAttachments([foldedFile], {
      source: { _tag: "pasted-text" },
      ...(selection ? { selection } : {}),
    });
    return true;
  };

  const onComposerPaste = (event: React.ClipboardEvent<HTMLElement>) => {
    const files = Array.from(event.clipboardData.files);
    const plainText = event.clipboardData.getData("text/plain");
    const bypassAutoAttachment = Date.now() <= pasteAsTextShortcutUntilRef.current;
    pasteAsTextShortcutUntilRef.current = 0;
    // Claimable pastes go through even when agent questions are pending or the
    // composer is at its attachment limit: `addComposerAttachments` surfaces
    // those as a toast and a thread error. An early return here would swallow
    // the paste with no feedback.
    if (
      files.length > 0 &&
      activeThreadId &&
      shouldHandleComposerAttachmentPaste({ files, plainText })
    ) {
      event.preventDefault();
      event.stopPropagation();
      void addComposerAttachments(files, { skipImageInlineChip: bypassAutoAttachment });
      return;
    }

    // Copied T3 chips need the structured importer to bring their records and files along.
    if ((readPastedComposerContext(event.clipboardData)?.records.length ?? 0) > 0) return;
    if (!foldPastedText(plainText, bypassAutoAttachment)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
  };

  const insertComposerText = (
    text: string,
    position: "cursor" | "end",
    options?: {
      ensureLeadingBoundary?: boolean;
      citationCommentAnchor?: AssistantCitationSourceAnchor;
      clipboardData?: DataTransfer;
    },
  ): boolean => {
    if (
      text.length === 0 ||
      isConnecting ||
      pendingUserInputs.length > 0 ||
      projectSelectionRequired ||
      (options?.citationCommentAnchor && !composerEditorRef.current)
    ) {
      return false;
    }
    if (options?.clipboardData) {
      text = importPastedComposerText(options.clipboardData, importContextFragment);
    }
    const prompt = promptRef.current;
    const cursor = position === "cursor" ? readComposerSnapshot().expandedCursor : prompt.length;
    const needsLeadingSpace =
      (options?.ensureLeadingBoundary ?? false) &&
      cursor > 0 &&
      !/\s/.test(prompt[cursor - 1] ?? "");
    const rangeEnd = extendReplacementRangeForTrailingSpace(prompt, cursor, text);
    return applyPromptReplacement(
      cursor,
      rangeEnd,
      needsLeadingSpace ? ` ${text}` : text,
      options?.citationCommentAnchor
        ? {
            citationComment: {
              start: cursor + (needsLeadingSpace ? 1 : 0),
              sourceAnchor: options.citationCommentAnchor,
              // An existing space after the cursor is consumed and re-emitted, so it stays.
              insertedSpaces: { before: needsLeadingSpace, after: rangeEnd === cursor },
            },
            focusEditorAfterReplace: false,
          }
        : undefined,
    );
  };
  const insertComposerTextStable = useStableCallback(insertComposerText);

  const onDictationPartial = (text: string | null) => {
    composerEditorRef.current?.setDictationPreview(text);
  };
  const onDictationFinal = (text: string) => {
    composerEditorRef.current?.insertDictatedText(text);
  };
  const onDictationActiveChange = (active: boolean) => {
    dictationActiveRef.current = active;
  };

  const insertComposerTextAtEnd: ChatComposerHandle["insertTextAtEnd"] = (text, options) => {
    const inserted = insertComposerText(text, "end", options);
    if (inserted && isComposerCollapsedMobile) {
      // The expanded editor is hidden at phone widths, so its scheduled
      // focus cannot expand the composer by itself. Reveal it before the
      // focus frame runs to preserve type-to-focus and external inserts.
      expandMobileComposer();
    }
    return inserted;
  };
  const insertComposerTextAtEndStable = useStableCallback(insertComposerTextAtEnd);

  // Context produced by other panels (diff comments, preview picks) asks the store to place
  // its chip; while this composer is mounted for the draft, that means the caret.
  const insertContextReferencesAtCaret = (
    references: ReadonlyArray<ComposerContextReference>,
  ): boolean =>
    insertComposerText(`${references.map(formatInlineContextReference).join(" ")} `, "cursor", {
      ensureLeadingBoundary: true,
    });
  const insertContextReferencesAtCaretStable = useStableCallback(insertContextReferencesAtCaret);
  const setContextInsertionHandler = useComposerDraftStore(
    (store) => store.setContextInsertionHandler,
  );
  useEffect(() => {
    return setContextInsertionHandler(composerDraftTarget, insertContextReferencesAtCaretStable);
  }, [composerDraftTarget, insertContextReferencesAtCaretStable, setContextInsertionHandler]);

  // File-tree drags land as mentions, pull request rows as their context chip. Handled in the capture phase so the
  // editor never sees the drop; the load-bearing rules (native stop, "move"
  // effect, no eager focus) live in makeComposerMentionDragHandlers.
  const composerMentionDragHandlers = makeComposerMentionDragHandlers({
    insertMentionAtEnd: (text) => insertComposerTextAtEnd(text, { ensureLeadingBoundary: true }),
    insertPullRequestAtEnd: (pullRequest) => {
      const comment = buildPullRequestReferenceContext(pullRequest);
      const inserted = insertComposerTextAtEnd(
        `${formatInlineContextReference(reviewCommentContextReference(comment))} `,
        { ensureLeadingBoundary: true },
      );
      if (inserted) {
        addComposerDraftReviewComment(composerDraftTarget, comment, { appendReference: false });
      }
      return inserted;
    },
    setDragActive: setIsDragOverComposer,
    onInsertRejected: () => {
      toastManager.add({
        type: "error",
        title: "Unable to add to chat",
        description: "The composer is busy; try again once it is ready.",
      });
    },
  });

  const attachDroppedThreadFile = useEffectEvent((file: File) => addComposerAttachments([file]));
  const importDroppedThread = useEffectEvent(
    async (ref: ScopedThreadRef, isActive: () => boolean) => {
      const targetKey = attachmentTargetKey;
      pendingDraftWork.begin(targetKey);
      const loadingToast = toastManager.add({
        type: "loading",
        title: "Loading thread context…",
        timeout: 0,
        data: { threadRef: routeThreadRef, hideCopyButton: true },
      });
      try {
        await importComposerThreadAttachment({
          targetKey,
          pendingImports: pendingThreadImportsRef.current,
          countReservedAttachments: countReservedAttachmentsStable,
          load: async () => {
            const result = await loadThreadTranscript({
              environmentId: ref.environmentId,
              input: { threadId: ref.threadId },
            });
            if (result._tag !== "Success") {
              throw squashAtomCommandFailure(result);
            }
            return threadContextAttachment(ref.environmentId, result.value);
          },
          isActive,
          attach: attachDroppedThreadFile,
          onLimitReached: () => {
            if (activeThreadId) {
              setThreadError(
                activeThreadId,
                `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`,
              );
            }
          },
        });
      } catch (error) {
        if (!isActive()) return;
        toastManager.add({
          type: "error",
          title: "Unable to read the dropped thread",
          description:
            isEnvironmentRequestInvalidError(error) &&
            error.reason === "thread_transcript_too_large"
              ? "This thread exceeds the attachment size limit. Try a shorter thread."
              : "Check that its machine is connected and up to date, then try again.",
        });
      } finally {
        toastManager.close(loadingToast);
        pendingDraftWork.end(targetKey);
      }
    },
  );

  useThreadContextDrop(composerFormRef, environmentId, attachmentTargetKey, (refs, isActive) => {
    const records = refs.flatMap((ref) => {
      if (ref.environmentId !== environmentId) {
        void importDroppedThread(
          ref,
          () => isActive() && attachmentTargetKeyRef.current === attachmentTargetKey,
        );
        return [];
      }
      const shell = readThreadShell(ref);
      return shell ? [threadContextRecord(ref, shell.title)] : [];
    });
    if (records.length === 0) return;
    if (questionAttachmentTarget !== null) {
      const canAnswer =
        canOperateThread &&
        !isConnecting &&
        !activePendingIsResponding &&
        activePendingProgress?.activeQuestion?.allowCustomAnswer !== false;
      const text = `${records
        .map((record) => formatInlineContextReference(linkContextReference(record)))
        .join(" ")} `;
      const snapshot = readComposerSnapshotStable();
      const cursor = snapshot.expandedCursor;
      const leadingSpace = cursor > 0 && !/\s/.test(snapshot.value[cursor - 1] ?? "");
      const inserted =
        canAnswer &&
        applyPromptReplacementStable(
          cursor,
          extendReplacementRangeForTrailingSpace(snapshot.value, cursor, text),
          leadingSpace ? ` ${text}` : text,
        );
      if (!inserted) {
        toastManager.add({
          type: "error",
          title: "Unable to add thread",
          description: "The composer is busy; try again once it is ready.",
        });
        return;
      }
      addComposerDraftThreadContexts(questionAttachmentTarget, records, {
        appendReference: false,
      });
      if (isComposerCollapsedMobile) expandMobileComposerStable();
    } else {
      addComposerDraftThreadContexts(composerDraftTarget, records);
    }
  });

  const onComposerMentionDragLeaveCapture = (event: React.DragEvent<HTMLFormElement>) => {
    if (!dataTransferHasComposerMention(event.dataTransfer.types)) return;
    event.stopPropagation();
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    setIsDragOverComposer(false);
  };

  // A cancelled drag (Escape) can end without a dragleave on the hovered
  // target, which would leave the drop highlight stuck. dragend always fires
  // on the in-page drag source and bubbles to window, so it is the reset of
  // last resort while the highlight is up.
  useEffect(() => {
    if (!isDragOverComposer) return;
    const onWindowDragEnd = () => {
      setIsDragOverComposer(false);
    };
    window.addEventListener("dragend", onWindowDragEnd);
    return () => window.removeEventListener("dragend", onWindowDragEnd);
  }, [isDragOverComposer]);
  const handleInterruptPrimaryAction = () => {
    void onInterrupt();
  };
  const handleInterruptPrimaryActionStable = useStableCallback(handleInterruptPrimaryAction);
  const handleImplementPlanInNewThreadPrimaryAction = () => {
    void onImplementPlanInNewThread();
  };
  const handleImplementPlanInNewThreadPrimaryActionStable = useStableCallback(
    handleImplementPlanInNewThreadPrimaryAction,
  );
  // The phone composer collapses when the editor loses focus. Desktop only
  // rests on a timeline scroll, so losing focus there changes nothing.
  const scheduleComposerCollapseCheck = () => {
    if (!isMobileViewport || mobileComposerExpandInFlightRef.current) {
      return;
    }
    if (composerBlurFrameRef.current !== null) {
      window.cancelAnimationFrame(composerBlurFrameRef.current);
    }
    composerBlurFrameRef.current = window.requestAnimationFrame(() => {
      composerBlurFrameRef.current = null;
      if (mobileComposerExpandInFlightRef.current) {
        return;
      }
      const composerSurface = composerSurfaceRef.current;
      const composerForm = composerFormRef.current;
      const activeElement = document.activeElement;
      if (isInsideRestingComposerControlScope(activeElement)) {
        return;
      }
      if (
        activeElement instanceof Node &&
        ((composerSurface && composerSurface.contains(activeElement)) ||
          (composerForm && composerForm.contains(activeElement)))
      ) {
        return;
      }
      setIsComposerFocused(false);
    });
  };

  useEffect(() => {
    return () => {
      if (composerBlurFrameRef.current !== null) {
        window.cancelAnimationFrame(composerBlurFrameRef.current);
      }
      if (mobileComposerExpandFrameRef.current !== null) {
        window.cancelAnimationFrame(mobileComposerExpandFrameRef.current);
      }
      if (mobileComposerExpandReleaseFrameRef.current !== null) {
        window.cancelAnimationFrame(mobileComposerExpandReleaseFrameRef.current);
      }
    };
  }, []);

  // ------------------------------------------------------------------
  // Imperative handle
  // ------------------------------------------------------------------
  const openModelPicker = () => {
    if (composerControlsHidden) {
      if (composerBlurFrameRef.current !== null) {
        window.cancelAnimationFrame(composerBlurFrameRef.current);
        composerBlurFrameRef.current = null;
      }
      setIsComposerFocused(true);
    }
    setIsComposerModelPickerOpen(true);
  };
  const openModelPickerStable = useStableCallback(openModelPicker);

  useImperativeHandle(
    composerRef,
    () => ({
      focusAtEnd: () => {
        composerEditorRef.current?.focusAtEnd();
      },
      focusAt: (cursor: number) => {
        composerEditorRef.current?.focusAt(cursor);
      },

      addDroppedFiles: (files: File[]) => {
        void addComposerAttachments(files).then((inserted) => {
          if (!inserted) focusComposer();
        });
      },
      addDroppedFolders: (folders: File[]) => {
        const target = folderDropTarget({
          localEnvironmentDisabled: isLocalEnvironmentDisabled(),
          environmentId,
          primaryEnvironmentId,
        });
        if (target === "remote") {
          toastManager.add({
            type: "error",
            title: "Folders can't be dropped onto remote machines",
          });
          return;
        }
        for (const folder of folders) {
          const path = resolveDroppedFolderPath(folder, window.desktopBridge?.getPathForFile);
          if (path === null) {
            toastManager.add({
              type: "error",
              title: `Couldn't get the path of "${folder.name}"`,
              description: "Type the folder path with @ instead.",
            });
            continue;
          }
          insertComposerTextAtEndStable(`${serializeComposerFileLink(path)} `, {
            ensureLeadingBoundary: true,
          });
        }
        focusComposer();
      },
      hasPendingAttachments: () =>
        (pendingImageCompressionsRef.current.get(attachmentTargetKey) ?? 0) > 0 ||
        pendingDraftWork.has(attachmentTargetKey),
      insertTextAtEnd: insertComposerTextAtEndStable,
      pasteTextAtEnd: (text: string, options) => {
        const bypassAutoAttachment =
          options?.bypassAutoAttachment === true ||
          Date.now() <= pasteAsTextShortcutUntilRef.current;
        pasteAsTextShortcutUntilRef.current = 0;
        const promptLength = promptRef.current.length;
        if (
          !foldPastedText(text, bypassAutoAttachment, {
            start: promptLength,
            end: promptLength,
          })
        ) {
          return false;
        }
        focusComposer();
        return true;
      },
      citeAssistantText: (citation, sourceAnchor) =>
        insertComposerTextStable(
          formatAssistantCitationForComposer(citation, citation.comment),
          "cursor",
          { ensureLeadingBoundary: true, citationCommentAnchor: sourceAnchor },
        ),
      openModelPicker: openModelPickerStable,
      toggleModelPicker: () => {
        if (isComposerModelPickerOpen) {
          setIsComposerModelPickerOpen(false);
        } else {
          openModelPickerStable();
        }
      },
      openControl: (command) => {
        if (composerBlurFrameRef.current !== null) {
          window.cancelAnimationFrame(composerBlurFrameRef.current);
          composerBlurFrameRef.current = null;
        }
        flushSync(() => {
          setIsComposerFocused(true);
        });
        const shell = composerFormRef.current?.closest('[data-slot="composer-shell"]');
        const trigger = Array.from(
          shell?.querySelectorAll<HTMLButtonElement>(
            `button[data-composer-shortcut~="${command}"]:not(:disabled)`,
          ) ?? [],
        ).find(
          (element) =>
            !element.closest("[inert]") && element.checkVisibility({ visibilityProperty: true }),
        );
        if (!trigger) return;
        trigger.focus({ preventScroll: true });
        trigger.click();
      },
      compactContext: compactThreadContextStable,
      isModelPickerOpen: () => isComposerModelPickerOpen,
      isCaretAtStart: () => {
        const range = composerEditorRef.current?.readSelectionRange();
        return range !== undefined && range.start === 0 && range.end === 0;
      },
      readSnapshot: () => {
        return readComposerSnapshotStable();
      },
      resetCursorState: (options?: {
        cursor?: number;
        prompt?: string;
        detectTrigger?: boolean;
      }) => {
        const promptForState = options?.prompt ?? promptRef.current;
        const cursor = clampCollapsedComposerCursor(
          promptForState,
          options?.cursor ?? 0,
          isLiteralPendingAnswer,
        );
        setComposerHighlightedItemId(null);
        setComposerCursor(cursor);
        resetComposerTrigger(
          options?.detectTrigger && !isLiteralPendingAnswer
            ? detectComposerTrigger(
                promptForState,
                expandCollapsedComposerCursor(promptForState, cursor),
              )
            : null,
        );
      },
      addTerminalContext: (selection: TerminalContextSelection) => {
        if (!activeThread || isChoiceOnlyPendingQuestion || isLiteralPendingAnswer) return;
        const snapshot = readComposerSnapshotStable();
        const context = {
          id: randomUUID(),
          threadId: activeThread.id,
          createdAt: new Date().toISOString(),
          ...selection,
        };
        const insertion = insertInlineContextReference(
          snapshot.value,
          snapshot.expandedCursor,
          terminalContextReference(context),
        );
        const nextCollapsedCursor = collapseExpandedComposerCursor(
          insertion.prompt,
          insertion.cursor,
        );
        const inserted = insertComposerDraftTerminalContext(
          composerDraftTarget,
          insertion.prompt,
          context,
          composerTerminalContexts.length,
        );
        if (!inserted) return;
        promptRef.current = insertion.prompt;
        setComposerCursor(nextCollapsedCursor);
        setComposerTrigger(detectComposerTrigger(insertion.prompt, insertion.cursor));
        window.requestAnimationFrame(() => {
          composerEditorRef.current?.focusAt(nextCollapsedCursor);
        });
      },
      getSendContext: () => ({
        answeringPendingUserInput: activePendingProgress !== null,
        prompt: promptRef.current,
        images: composerImagesRef.current,
        files: composerFilesRef.current,
        terminalContexts: composerTerminalContextsRef.current,
        previewAnnotations: composerPreviewAnnotations,
        reviewComments: composerReviewComments,
        threadContexts: composerThreadContexts,
        selectedPromptEffort,
        selectedModelOptionsForDispatch,
        selectedModelSelection,
        multipleModelSelections:
          routeKind === "draft" && multipleModelSelections !== null
            ? multipleModelSelections.map((selection) =>
                selection.instanceId === selectedModelSelection.instanceId &&
                selection.model === selectedModelSelection.model
                  ? selectedModelSelection
                  : selection,
              )
            : null,
        providerAvailable:
          multipleModelSelections !== null ||
          (!noProviderAvailable && providerSendBlockReason === null),
        selectedProvider,
        selectedModel,
        selectedProviderModels,
        interactionMode,
        interactionModeEnabled: planModeUiEnabled,
      }),
      setMultipleModelSelections,
      validateProviderInput: (providerInput: string) => {
        const validationMessage = getComposerSubmissionValidationMessage({
          prompt: promptRef.current,
          providerInput,
          submissionTarget: "provider-turn",
        });
        providerInputRejectedRef.current = validationMessage !== null;
        setProviderInputSubmissionError(validationMessage);
        return validationMessage === null;
      },
    }),
    [
      activeThread,
      addComposerAttachments,
      foldPastedText,
      composerDraftTarget,
      composerCursor,
      activePendingProgress,
      composerTerminalContexts,
      insertComposerDraftTerminalContext,
      insertComposerTextStable,
      insertComposerTextAtEndStable,
      promptRef,
      composerImagesRef,
      composerFilesRef,
      composerTerminalContextsRef,
      composerPreviewAnnotations,
      composerReviewComments,
      focusComposer,
      environmentId,
      primaryEnvironmentId,
      isConnecting,
      isChoiceOnlyPendingQuestion,
      isLiteralPendingAnswer,
      pendingUserInputs.length,
      projectSelectionRequired,
      applyPromptReplacementStable,
      isComposerModelPickerOpen,
      openModelPickerStable,
      readComposerSnapshotStable,
      resetComposerTrigger,
      setComposerTrigger,
      selectedModel,
      selectedModelOptionsForDispatch,
      selectedModelSelection,
      multipleModelSelections,
      setMultipleModelSelections,
      routeKind,
      noProviderAvailable,
      providerSendBlockReason,
      selectedPromptEffort,
      selectedProvider,
      selectedProviderModels,
      interactionMode,
      planModeUiEnabled,
      compactThreadContextStable,
    ],
  );

  // Render
  // ------------------------------------------------------------------
  return (
    <form
      ref={composerFormRef}
      onSubmit={submitComposerStable}
      onPointerDownCapture={(event) => {
        const target = event.target;
        if (isInsideRestingComposerControlScope(target)) return;
        if (isInsideCollapsedComposerControls(target)) return;
        if (!(target instanceof Element)) return;
        const isInteractive = Boolean(
          target.closest('button, a, input, select, [role="button"], [role="menuitem"]'),
        );
        if (isInteractive) return;
      }}
      onFocusCapture={(event) => {
        const activeElement = event.target;
        if (
          activeElement instanceof Element &&
          activeElement.closest('[data-testid="composer-editor"]')
        ) {
          onTypingGuardFocus();
        }
        if (composerControlsCollapsed && isInsideRestingComposerControlScope(activeElement)) {
          return;
        }
        if (isInsideCollapsedComposerControls(activeElement)) {
          return;
        }
        if (composerBlurFrameRef.current !== null) {
          window.cancelAnimationFrame(composerBlurFrameRef.current);
          composerBlurFrameRef.current = null;
        }
        setIsComposerFocused(true);
      }}
      onBlurCapture={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest('[data-testid="composer-editor"]')
        ) {
          onTypingGuardBlur();
        }
        scheduleComposerCollapseCheck();
      }}
      onDragEnterCapture={(event) => {
        if (isInsideRestingComposerControlScope(event.target)) return;
        composerMentionDragHandlers.onDragEnter(event);
      }}
      onDragOverCapture={(event) => {
        if (isInsideRestingComposerControlScope(event.target)) return;
        composerMentionDragHandlers.onDragOver(event);
      }}
      onDragLeaveCapture={(event) => {
        if (isInsideRestingComposerControlScope(event.target)) return;
        onComposerMentionDragLeaveCapture(event);
      }}
      onDropCapture={(event) => {
        if (isInsideRestingComposerControlScope(event.target)) return;
        composerMentionDragHandlers.onDrop(event);
      }}
      className="chat-content-lane"
      data-chat-composer-form="true"
      {...threadContextDropTargetProps()}
    >
      {composerControlsCollapsed && restingControlsHost
        ? createPortal(
            <div
              ref={attachRestingComposerControls}
              data-chat-composer-resting-controls="true"
              aria-hidden={restingControlsVisible ? undefined : true}
              inert={restingControlsVisible ? undefined : true}
              className={cn(
                "relative flex w-max min-w-0 max-w-full items-center gap-1 font-normal text-muted-foreground/70 [&_button]:text-xs!",
                !restingControlsVisible && "invisible",
              )}
            >
              {composerControls}
            </div>,
            restingControlsHost,
          )
        : null}
      <ComposerBanner.Dock>
        <ComposerStackColumn>
          <ComposerBannerStack
            key={activeThreadId}
            className="relative z-0"
            items={bannerStackItems}
            attachedAbove={props.queuedRunsControl}
          />
          <AttachmentPresence
            show={!activityStackItem && Boolean(shownSyncPhase || inlineTasksBadge)}
            swapKey={shownSyncPhase ? `sync:${shownSyncPhase}` : "tasks"}
          >
            <ComposerBanner.Root data-chat-composer-activity-strip="true">
              {shownSyncPhase ? <ComposerActivityRow phase={shownSyncPhase} /> : inlineTasksBadge}
            </ComposerBanner.Root>
          </AttachmentPresence>
          <AttachmentPresence
            show={showComposerTopDrawer && (!isTasksDrawerOpen || hasBlockingComposerTopDrawer)}
            swapKey={pendingUserInputs.length > 0 ? "pending-user-input" : "plan-follow-up"}
            // A question waiting on the user never shrinks or folds to fit the stack.
            data-composer-stack-blocking={hasBlockingComposerTopDrawer || undefined}
          >
            <ComposerBanner.Root
              data-chat-composer-top-drawer="true"
              variant="info"
              density="default"
            >
              {!isComposerCollapsedMobile && pendingUserInputs.length > 0 ? (
                <ComposerPendingUserInputPanel
                  pendingUserInputs={pendingUserInputs}
                  cwd={gitCwd ?? undefined}
                  threadRef={routeThreadRef}
                  disabled={!canOperateThread}
                  respondingRequestIds={
                    activePendingIsResponding && activePendingUserInput
                      ? [...respondingRequestIds, activePendingUserInput.requestId]
                      : respondingRequestIds
                  }
                  answers={activePendingDraftAnswers}
                  questionIndex={activePendingQuestionIndex}
                  onToggleOption={onSelectActivePendingUserInputOption}
                  onAdvance={onAdvanceActivePendingUserInput}
                  onDismiss={onDismissActivePendingUserInput}
                />
              ) : !isComposerCollapsedMobile && showPlanFollowUpPrompt && activeProposedPlan ? (
                <ComposerPlanFollowUpBanner
                  key={activeProposedPlan.id}
                  planTitle={proposedPlanTitle(activeProposedPlan.planMarkdown) ?? null}
                />
              ) : isComposerCollapsedMobile && pendingUserInputs.length > 0 ? (
                <div data-chat-composer-collapsed-controls="true">
                  <ComposerPendingUserInputPanel
                    pendingUserInputs={pendingUserInputs}
                    cwd={gitCwd ?? undefined}
                    threadRef={routeThreadRef}
                    disabled={!canOperateThread}
                    respondingRequestIds={
                      activePendingIsResponding && activePendingUserInput
                        ? [...respondingRequestIds, activePendingUserInput.requestId]
                        : respondingRequestIds
                    }
                    answers={activePendingDraftAnswers}
                    questionIndex={activePendingQuestionIndex}
                    onToggleOption={onSelectActivePendingUserInputOption}
                    onAdvance={onAdvanceActivePendingUserInput}
                    onDismiss={onDismissActivePendingUserInput}
                  />
                  {!isChoiceOnlyPendingQuestion ||
                  activePendingProgress?.activeQuestion?.multiSelect ? (
                    <ComposerBanner.Body>
                      <div
                        data-chat-composer-mobile-pending-compact="true"
                        className={cn(
                          "flex min-w-0 items-center gap-2 rounded-lg border border-border/55 bg-background/55 p-1.5 pl-3 transition-colors hover:bg-background/80",
                          !activePendingProgress?.activeQuestion?.multiSelect && "p-0",
                        )}
                      >
                        {!isChoiceOnlyPendingQuestion ? (
                          <button
                            type="button"
                            className={cn(
                              "min-w-0 flex-1 truncate bg-transparent py-1.5 text-left text-sm",
                              activePendingProgress?.customAnswer
                                ? "text-foreground"
                                : "text-placeholder",
                              !activePendingProgress?.activeQuestion?.multiSelect && "px-3 py-2",
                            )}
                            onPointerDown={(event) => event.preventDefault()}
                            onClick={expandMobileComposerStable}
                            aria-label="Write custom answer"
                          >
                            {activePendingProgress?.customAnswer || "Write custom answer"}
                          </button>
                        ) : null}
                        {activePendingProgress?.activeQuestion?.multiSelect ? (
                          <ComposerPrimaryActions
                            compact
                            canOperateThread={canOperateThread}
                            pendingAction={pendingPrimaryAction}
                            isRunning={false}
                            canInterrupt={false}
                            showPlanFollowUpPrompt={false}
                            promptHasText={false}
                            isSendBusy={isSendBusy}
                            sendDisabledReason={sendDisabledReason}
                            isConnecting={sendWaitsForConnection}
                            isEnvironmentUnavailable={sendBlockedByEnvironment}
                            isPreparingWorktree={false}
                            hasSendableContent={false}
                            preserveComposerFocusOnPointerDown
                            onPreviousPendingQuestion={onPreviousActivePendingUserInputQuestion}
                            onInterrupt={handleInterruptPrimaryActionStable}
                            onImplementPlanInNewThread={
                              handleImplementPlanInNewThreadPrimaryActionStable
                            }
                          />
                        ) : null}
                      </div>
                    </ComposerBanner.Body>
                  ) : null}
                </div>
              ) : null}
            </ComposerBanner.Root>
          </AttachmentPresence>
          {/* The tab and the open task list share one surface; the list grows under it. */}
          <AttachmentPresence show={showTasksDrawer || showTasksTab} swapKey="tasks">
            {(showTasksDrawer || showTasksTab) && activeTasksProgress && activeTaskSteps ? (
              <ComposerTasksPanel
                expanded={showTasksDrawer}
                onToggle={toggleTasksDrawerStable}
                progress={activeTasksProgress}
                steps={activeTaskSteps}
              />
            ) : null}
          </AttachmentPresence>
        </ComposerStackColumn>
      </ComposerBanner.Dock>
      <div className="relative">
        <ComposerSurface.Main
          ref={composerMainSurfaceRef}
          data-inline-resting-controls={restingControlsHost === null ? "true" : undefined}
          data-model-only-strip={
            restingControlsHost?.closest("[data-composer-model-strip]") ? "true" : undefined
          }
          className={composerProviderState.composerFrameClassName}
        >
          <div
            ref={composerSurfaceRef}
            data-chat-composer-surface="true"
            data-chat-composer-mobile-collapsed={isComposerCollapsedMobile ? "true" : "false"}
            className={cn(
              "rounded-2xl transition-[background-color] duration-200",
              "in-data-[thread-context-over]:bg-accent/45 in-data-[thread-context-over]:ring-1 in-data-[thread-context-over]:ring-inset in-data-[thread-context-over]:ring-primary/70",
              isDragOverComposer ? "bg-accent/45 ring-1 ring-inset ring-primary/70" : null,
              projectSelectionRequired ? "opacity-75" : null,
              composerProviderState.composerSurfaceClassName,
            )}
          >
            {showCollapsedMobilePromptRow ? (
              <div className="flex items-center justify-between gap-2 px-3 py-2">
                <button
                  type="button"
                  data-chat-composer-transition-prompt="true"
                  className={cn(
                    "min-w-0 flex-1 truncate bg-transparent p-0 text-left text-sm focus:outline-none",
                    (activePendingProgress ? activePendingProgress.customAnswer : prompt.trim())
                      ? "text-foreground"
                      : "text-placeholder",
                  )}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={isChoiceOnlyPendingQuestion ? undefined : expandMobileComposerStable}
                  disabled={isChoiceOnlyPendingQuestion}
                  aria-label="Expand composer"
                >
                  {activePendingProgress
                    ? isChoiceOnlyPendingQuestion
                      ? "Choose an option above"
                      : activePendingProgress.customAnswer ||
                        "Type your own answer, or leave this blank to use the selected option"
                    : prompt.trim() ||
                      (showProviderUnavailable
                        ? "Enable a provider in Settings"
                        : "Ask anything...")}
                </button>
                {collapsedComposerImagePreviews}
                <button
                  type="button"
                  data-chat-composer-transition-actions="true"
                  className="flex size-8 shrink-0 items-center justify-center rounded-full bg-message-action text-message-action-foreground interactive hover:bg-message-action-hover disabled:opacity-64"
                  disabled={collapsedComposerPrimaryActionDisabled}
                  aria-label={collapsedComposerPrimaryActionLabel}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (showResumeAction) onResume();
                    // Compacting first only sends from the expanded composer, where the chip shows it.
                    else if (props.resumeCompactionTokens !== null && !props.keepFullHistory)
                      expandMobileComposer();
                    else submitComposer();
                  }}
                >
                  {showResumeAction ? (
                    <PlayIcon className="size-4 fill-current" aria-hidden="true" />
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path
                        d="M8 3L8 13M8 3L4 7M8 3L12 7"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </button>
              </div>
            ) : null}

            <div
              ref={setComposerMenuAnchor}
              data-chat-composer-body="true"
              className={cn(
                "relative px-3 pb-2 sm:px-4",
                "pt-3.5 sm:pt-4",
                isComposerCollapsedMobile && "hidden",
              )}
            >
              <div role="status" aria-atomic="true" className="sr-only">
                {composerSuggestionsVisible && composerMenuItems.length === 0
                  ? isComposerMenuLoading
                    ? composerTriggerKind === "pull-request"
                      ? "Finding pull request..."
                      : "Searching workspace files..."
                    : composerMenuEmptyState
                  : ""}
              </div>
              {
                <ComposerCommandMenuPresence
                  anchor={composerMenuAnchor}
                  show={composerSuggestionsVisible}
                >
                  <ComposerCommandMenu
                    listId={composerSuggestionListId}
                    items={composerMenuItems}
                    resolvedTheme={resolvedTheme}
                    isLoading={isComposerMenuLoading}
                    triggerKind={composerTriggerKind}
                    emptyStateText={composerMenuEmptyState}
                    activeItemId={activeComposerMenuItem?.id ?? null}
                    onHighlightedItemChange={onComposerMenuItemHighlightedStable}
                    onSelect={onSelectComposerItemStable}
                  />
                </ComposerCommandMenuPresence>
              }

              {!isComposerCollapsedMobile &&
                pendingUserInputs.length === 0 &&
                editingQueuedAttachments !== null &&
                editingQueuedAttachments.length > 0 && (
                  <div className="mb-3 flex flex-wrap gap-2">
                    {editingQueuedAttachments.map(({ attachment, url }) => (
                      <div
                        key={attachment.id}
                        className="relative h-16 w-16 overflow-hidden rounded-lg border border-border/80 bg-background"
                      >
                        {attachment.type === "image" && url ? (
                          <img
                            src={url}
                            alt={attachment.name}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center px-1 text-center text-3xs text-secondary-label">
                            {attachment.name}
                          </div>
                        )}
                        <Button
                          variant="media-close"
                          size="icon-xs"
                          className="absolute right-1 top-1"
                          onClick={() => onRemoveEditingQueuedAttachment(attachment.id)}
                          aria-label={`Remove ${attachment.name}`}
                        >
                          <XIcon />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}

              {!isComposerCollapsedMobile &&
                (composerVideos.length > 0 || expandedComposerImages.length > 0) && (
                  <div className="mb-3 flex max-w-full flex-wrap gap-2">
                    {expandedComposerImages.map((image) => {
                      const upload = supportsAttachmentUploads
                        ? uploadsByImageId[image.id]
                        : undefined;
                      return (
                        <div
                          key={image.id}
                          data-chat-composer-expanded-image="true"
                          className="group/attachment relative size-16 shrink-0 overflow-hidden rounded-lg border border-border bg-background"
                        >
                          {image.previewUrl ? (
                            <button
                              type="button"
                              className="group/edit relative size-full cursor-pointer outline-none"
                              aria-label={
                                markupSessionsByImageId[image.id]
                                  ? `Edit markup on ${image.name}`
                                  : `Mark up ${image.name}`
                              }
                              onClick={() => setMarkupImageId(image.id)}
                            >
                              <ComposerImageThumbnail
                                file={image.file}
                                alt={image.name}
                                className="size-full object-cover"
                                fallback={
                                  <span className="flex h-full items-center justify-center px-1 text-3xs text-secondary-label">
                                    {image.name}
                                  </span>
                                }
                              />
                              {/* The edit affordance and the focus ring share one inset layer over the image. */}
                              <span
                                aria-hidden
                                className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-black/30 text-white opacity-0 transition-opacity duration-(--motion-duration-fast) ease-standard group-hover/edit:opacity-100 group-focus-visible/edit:opacity-100 group-focus-visible/edit:ring-2 group-focus-visible/edit:ring-ring group-focus-visible/edit:ring-inset"
                              >
                                <PencilIcon className="size-4" />
                              </span>
                            </button>
                          ) : (
                            <div className="flex h-full w-full items-center justify-center px-1 text-center text-3xs text-secondary-label">
                              {image.name}
                            </div>
                          )}
                          {nonPersistedComposerImageIdSet.has(image.id) && (
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <span
                                    role="img"
                                    aria-label="Draft attachment may not persist"
                                    className="absolute left-1 top-1 inline-flex items-center justify-center rounded bg-background/85 p-0.5 text-warning-foreground"
                                  >
                                    <CircleAlertIcon className="size-3" />
                                  </span>
                                }
                              />
                              <TooltipPopup side="top">
                                Draft attachment could not be saved locally and may be lost on
                                navigation.
                              </TooltipPopup>
                            </Tooltip>
                          )}
                          {upload?.status === "uploading" && (
                            <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-background/85 px-1 text-center text-3xs text-foreground">
                              {formatAttachmentUploadProgress(upload.progress)}
                            </span>
                          )}
                          {upload?.status === "failed" && (
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <Button
                                    variant="overlay"
                                    size="icon-xs"
                                    className="absolute bottom-1 left-1"
                                    onClick={() =>
                                      retryAttachmentUpload({
                                        environmentId,
                                        image,
                                        draftTarget: attachmentDraftTarget,
                                      })
                                    }
                                    disabled={!canOperateThread}
                                    aria-label={`Retry upload for ${image.name}`}
                                  />
                                }
                              >
                                <RefreshIcon />
                              </TooltipTrigger>
                              <TooltipPopup side="top">{upload.reason}</TooltipPopup>
                            </Tooltip>
                          )}
                          {markupSessionsByImageId[image.id] ? (
                            <span
                              role="img"
                              aria-label="Marked up"
                              className="pointer-events-none absolute right-1 bottom-1 inline-flex size-4 items-center justify-center rounded-full bg-background/90 text-foreground shadow-sm transition-opacity duration-(--motion-duration-fast) ease-standard starting:opacity-0"
                            >
                              <PencilIcon className="size-2.5" strokeWidth={2.5} />
                            </span>
                          ) : null}
                          {/* Matches the toast dismiss: out of the way until hover or focus, always shown on touch. */}
                          <button
                            type="button"
                            onClick={() => removeComposerImage(image.id)}
                            aria-label={`Remove ${image.name}`}
                            className="absolute top-1 right-1 inline-flex size-5 cursor-pointer items-center justify-center rounded-md bg-background/80 text-muted-foreground opacity-0 outline-none backdrop-blur-sm transition-[color,opacity] duration-(--motion-duration-base) ease-standard hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset group-hover/attachment:opacity-100 group-focus-within/attachment:opacity-100 pointer-coarse:opacity-100 motion-reduce:transition-none"
                          >
                            <XIcon className="size-3" strokeWidth={2.25} />
                          </button>
                        </div>
                      );
                    })}
                    {composerVideos.map((file) => {
                      const fileCanUpload =
                        supportsAttachmentUploads &&
                        maxFileAttachmentBytes !== null &&
                        file.sizeBytes <= maxFileAttachmentBytes;
                      const upload = fileCanUpload ? uploadsByImageId[file.id] : undefined;
                      return (
                        <div
                          key={file.id}
                          className="relative h-16 w-16 shrink-0 snap-start overflow-hidden rounded-lg border border-border/80 bg-black"
                        >
                          <button
                            type="button"
                            className="flex h-full w-full cursor-zoom-in flex-col items-center justify-center gap-1 px-1 text-white"
                            aria-label={`Play ${file.name}`}
                            onClick={() => {
                              if (file.file !== null) {
                                const preview = buildExpandedImagePreview([file], file.id);
                                if (preview) onExpandImage(preview);
                                return;
                              }
                              if (!file.uploadedAttachmentId) return;
                              onFileOpen({ ...file, id: file.uploadedAttachmentId });
                            }}
                          >
                            {file.file && (
                              <>
                                <ComposerVideoThumbnail file={file.file} />
                                <span className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-black/10" />
                              </>
                            )}
                            <PlayIcon className="relative z-10 size-4 fill-current drop-shadow-md" />
                          </button>
                          {upload?.status === "uploading" && (
                            <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-background/85 px-1 text-center text-3xs text-foreground">
                              {formatAttachmentUploadProgress(upload.progress)}
                            </span>
                          )}
                          {upload?.status === "failed" && (
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <Button
                                    variant="overlay"
                                    size="icon-xs"
                                    className="absolute bottom-1 left-1"
                                    onClick={() =>
                                      retryAttachmentUpload({
                                        environmentId,
                                        image: file,
                                        draftTarget: attachmentDraftTarget,
                                      })
                                    }
                                    disabled={!canOperateThread}
                                    aria-label={`Retry upload for ${file.name}`}
                                  />
                                }
                              >
                                <RefreshIcon />
                              </TooltipTrigger>
                              <TooltipPopup side="top">{upload.reason}</TooltipPopup>
                            </Tooltip>
                          )}
                          <Button
                            variant="media-close"
                            size="icon-xs"
                            className="absolute right-1 top-1"
                            onClick={() => removeComposerFileFromDraft(file.id)}
                            aria-label={`Remove ${file.name}`}
                          >
                            <XIcon />
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                )}

              {!isComposerCollapsedMobile && composerOtherFiles.length > 0 && (
                <div className="mb-3 flex flex-col gap-1">
                  {composerOtherFiles.map((file) => {
                    const fileCanUpload =
                      supportsAttachmentUploads &&
                      maxFileAttachmentBytes !== null &&
                      file.sizeBytes <= maxFileAttachmentBytes;
                    const upload = fileCanUpload ? uploadsByImageId[file.id] : undefined;
                    const needsReattach = composerFileNeedsReattach(file);
                    const canReattachFile =
                      fileStagingLimit !== null && file.sizeBytes <= fileStagingLimit;
                    return (
                      <div
                        key={file.id}
                        className="flex min-w-0 items-center gap-2 py-1 text-sm text-foreground"
                      >
                        <PierreEntryIcon pathValue={file.name} kind="file" theme={resolvedTheme} />
                        <button
                          type="button"
                          disabled={needsReattach}
                          className="min-w-0 flex-1 truncate text-left hover:underline focus-visible:outline-2"
                          onClick={() => setPreviewFileId(file.id)}
                        >
                          {file.name}
                        </button>
                        <span className="shrink-0 text-xs text-secondary-label">
                          {needsReattach
                            ? canReattachFile
                              ? "Attach again"
                              : "Remove to send"
                            : upload?.status === "uploading"
                              ? formatAttachmentUploadProgress(upload.progress)
                              : formatAttachmentSize(file.sizeBytes)}
                        </span>
                        {!needsReattach && upload?.status === "failed" ? (
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Button
                                  variant="ghost"
                                  size="icon-xs"
                                  onClick={() =>
                                    retryAttachmentUpload({
                                      environmentId,
                                      image: file,
                                      draftTarget: attachmentDraftTarget,
                                    })
                                  }
                                  disabled={!canOperateThread}
                                  aria-label={`Retry upload for ${file.name}`}
                                />
                              }
                            >
                              <RefreshIcon />
                            </TooltipTrigger>
                            <TooltipPopup side="top">{upload.reason}</TooltipPopup>
                          </Tooltip>
                        ) : null}
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => removeComposerFileFromDraft(file.id)}
                          aria-label={`Remove ${file.name}`}
                        >
                          <XIcon />
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="relative">
                <OverlayPresence when={markupImage}>
                  {(image) => (
                    <ImageMarkupDialog
                      key={image.id}
                      image={image}
                      session={markupSessionsByImageId[image.id]}
                      onCancel={() => setMarkupImageId(null)}
                      onApply={(file, original, shapes) =>
                        applyImageMarkup(image, file, original, shapes)
                      }
                      onRevert={() => revertImageMarkup(image)}
                    />
                  )}
                </OverlayPresence>
                <OverlayPresence when={previewFile}>
                  {(previewFile) => (
                    <Dialog
                      open
                      onOpenChange={(open) => {
                        if (!open) setPreviewFileId(null);
                      }}
                    >
                      <DialogPopup
                        {...composerFloatingLayerProps}
                        className="h-[min(85vh,52rem)] max-w-4xl overflow-hidden"
                        showCloseButton={false}
                      >
                        <DialogTitle className="sr-only">{previewFile.name}</DialogTitle>
                        <AttachmentFilePreview
                          key={previewFile.id}
                          name={previewFile.name}
                          mimeType={previewFile.mimeType}
                          sizeBytes={previewFile.sizeBytes}
                          file={previewFile.file}
                          origin="Draft"
                          {...(previewFile.uploadedAttachmentId && previewFile.uploadEnvironmentId
                            ? {
                                asset: {
                                  environmentId: previewFile.uploadEnvironmentId,
                                  attachmentId: previewFile.uploadedAttachmentId,
                                },
                              }
                            : {})}
                          onRemove={() => {
                            removeComposerFileFromDraft(previewFile.id);
                            setPreviewFileId(null);
                          }}
                          onClose={() => setPreviewFileId(null)}
                        />
                      </DialogPopup>
                    </Dialog>
                  )}
                </OverlayPresence>
                <ComposerContextActionsContext value={composerContextActions}>
                  <ComposerPromptEditor
                    ariaLabel="Message"
                    suggestionListId={composerSuggestionListId}
                    activeSuggestionId={
                      composerSuggestionListVisible && activeComposerMenuItem
                        ? composerSuggestionOptionId(
                            composerSuggestionListId,
                            activeComposerMenuItem.id,
                          )
                        : undefined
                    }
                    editorRef={composerEditorRef}
                    richTextEnabled={settings.composerRichTextEnabled}
                    literalText={isLiteralPendingAnswer}
                    isPathQueryActive={() =>
                      resolveActiveComposerTrigger().trigger?.kind === "path"
                    }
                    value={activePendingProgress ? activePendingProgress.customAnswer : prompt}
                    cursor={composerCursor}
                    contextRecords={composerContextRecords}
                    buildContextClipboardFragment={buildContextClipboardFragmentStable}
                    importContextFragment={importContextFragmentStable}
                    skills={selectedProviderSkills}
                    className={cn(showMobilePendingAnswerActions && "max-sm:pb-12")}
                    onChange={onPromptChangeStable}
                    onCommandKeyDown={onComposerCommandKey}
                    onPageScrollKeyDown={onPageScrollKeyDown}
                    onPageScrollKeyUp={onPageScrollKeyUp}
                    onPageScrollRelease={onPageScrollRelease}
                    onCitationSubmitAndSend={submitCitationAndSendStable}
                    onCitationDraftSave={saveCitationDraftToPromptStable}
                    onPaste={onComposerPaste}
                    placeholder={
                      activePendingProgress
                        ? isChoiceOnlyPendingQuestion
                          ? "Choose an option above"
                          : "Type your own answer, or leave this blank to use the selected option"
                        : showPlanFollowUpPrompt && activeProposedPlan
                          ? "Add feedback to refine the plan, or leave this blank to implement it"
                          : projectSelectionRequired
                            ? "Choose a repository above to start a thread"
                            : showProviderUnavailable
                              ? "Enable a provider in Settings to send a message"
                              : isChat
                                ? "Message"
                                : phase === "disconnected"
                                  ? DISCONNECTED_COMPOSER_PLACEHOLDER
                                  : "Ask anything, @tag files/folders, $use skills, or / for commands"
                    }
                    disabled={composerEditorLocked}
                  />
                </ComposerContextActionsContext>
                {showMobilePendingAnswerActions ? (
                  <div
                    data-chat-composer-mobile-pending-actions="true"
                    className="absolute bottom-0 right-0 flex items-center justify-end gap-1"
                  >
                    <ComposerPrimaryActions
                      compact
                      canOperateThread={canOperateThread}
                      pendingAction={pendingPrimaryAction}
                      isRunning={false}
                      canInterrupt={false}
                      showPlanFollowUpPrompt={false}
                      promptHasText={false}
                      isSendBusy={isSendBusy}
                      sendDisabledReason={sendDisabledReason}
                      isConnecting={sendWaitsForConnection}
                      isEnvironmentUnavailable={sendBlockedByEnvironment}
                      isPreparingWorktree={false}
                      hasSendableContent={false}
                      preserveComposerFocusOnPointerDown
                      onPreviousPendingQuestion={onPreviousActivePendingUserInputQuestion}
                      onInterrupt={handleInterruptPrimaryActionStable}
                      onImplementPlanInNewThread={handleImplementPlanInNewThreadPrimaryActionStable}
                    />
                  </div>
                ) : null}
              </div>
            </div>

            <ComposerPromptLengthValidation
              message={providerInputSubmissionError ?? composerSubmissionError}
            />

            {/* Bottom toolbar */}
            {isComposerCollapsedMobile ? null : (
              <div
                data-chat-composer-footer="true"
                data-chat-composer-footer-compact={isComposerFooterCompact ? "true" : "false"}
                className={cn(
                  "flex min-w-0 flex-nowrap items-center justify-between gap-2 overflow-visible px-3 pb-3 sm:px-4 sm:pb-4",
                  pendingUserInputs.length > 0 && "pt-2",
                  isComposerFooterCompact ? "gap-1.5" : "gap-2 sm:gap-0",
                  showMobilePendingAnswerActions && "hidden sm:flex",
                )}
              >
                <div
                  ref={expandedControlsLayout.attachControls}
                  data-chat-composer-controls="left"
                  data-chat-composer-footer-controls="true"
                  className={cn(
                    // The 4px bleed keeps focus rings clear of the scroll clip. The start
                    // also pulls in by a control's px-2.5, so the first control's icon sits
                    // on the prompt's text inset while its hover background bleeds left.
                    "relative -my-1 -ms-3.5 -me-1 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
                  )}
                >
                  {composerControlsCollapsed ? null : composerControls}
                </div>

                {/* Right side: send / stop button */}
                <div
                  data-chat-composer-actions="right"
                  data-chat-composer-transition-actions="true"
                  data-chat-composer-primary-actions-compact={
                    isComposerPrimaryActionsCompact ? "true" : "false"
                  }
                  // Dictation and attach sit as one tight pair; the larger send/stop button
                  // gets more room so the pair reads as evenly spaced next to it.
                  className="flex shrink-0 flex-nowrap items-center justify-end gap-2.5"
                >
                  {(settings.dictationEnabled && !isChoiceOnlyPendingQuestion) ||
                  showComposerAttachAction ? (
                    <div className="flex shrink-0 items-center gap-0.5">
                      {settings.dictationEnabled && !isChoiceOnlyPendingQuestion ? (
                        <ComposerDictationControl
                          ownerKey={composerDraftTargetKey}
                          disabled={composerEditorLocked}
                          keybindings={keybindings}
                          handleRef={dictationRef}
                          onPartial={onDictationPartial}
                          onFinal={onDictationFinal}
                          onActiveChange={onDictationActiveChange}
                          onRecordingChange={setDictationRecording}
                          waveform={expandedControlsLayout.dictationWaveform}
                        />
                      ) : null}
                      {showComposerAttachAction ? (
                        <>
                          <input
                            ref={attachmentInputRef}
                            type="file"
                            multiple
                            className="hidden"
                            onChange={(event) => {
                              const files = Array.from(event.currentTarget.files ?? []);
                              event.currentTarget.value = "";
                              // Inserting a chip refocuses the editor after the draft renders;
                              // focusing synchronously here would report the editor's stale text
                              // over the prompt that was just written.
                              void addComposerAttachments(files).then((inserted) => {
                                if (!inserted) focusComposer();
                              });
                            }}
                          />
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-sm"
                                  onPointerDown={(event) => event.preventDefault()}
                                  onClick={() => attachmentInputRef.current?.click()}
                                  aria-label="Attach files"
                                />
                              }
                            >
                              <PaperclipIcon />
                            </TooltipTrigger>
                            <TooltipPopup>Attach files</TooltipPopup>
                          </Tooltip>
                        </>
                      ) : null}
                    </div>
                  ) : null}
                  <ComposerFooterPrimaryActions
                    compact={isComposerPrimaryActionsCompact}
                    canOperateThread={canOperateThread}
                    activeContextWindow={
                      settings.contextWindowMeterEnabled ? activeContextWindow : null
                    }
                    reserveContextWindowMeter={reserveContextWindowMeter}
                    activeThreadModelDisplayName={activeThreadModelDisplayName}
                    pendingAction={pendingPrimaryAction}
                    isRunning={phase === "running"}
                    canInterrupt={canInterrupt}
                    followUpBehavior={settings.followUpBehavior}
                    alternateShortcutLabel={shortcutLabelForCommand(
                      keybindings,
                      "composer.sendAlternate",
                      {
                        context: {
                          composerFocus: true,
                          draftThreadRoute: routeKind === "draft",
                          turnRunning: true,
                        },
                      },
                    )}
                    showPlanFollowUpPrompt={
                      pendingUserInputs.length === 0 && showPlanFollowUpPrompt
                    }
                    promptHasText={prompt.trim().length > 0}
                    isSendBusy={isSendBusy}
                    sendDisabledReason={sendDisabledReason}
                    isConnecting={sendWaitsForConnection}
                    isEnvironmentUnavailable={sendBlockedByEnvironment}
                    isPreparingWorktree={isPreparingWorktree}
                    hasSendableContent={composerSendState.hasSendableContent}
                    canResume={showResumeAction}
                    preserveComposerFocusOnPointerDown={isMobileViewport}
                    isEditingQueuedMessage={isEditingQueuedMessage}
                    onSubmitMessage={handleSubmitMessageStable}
                    onResume={onResume}
                    onPreviousPendingQuestion={onPreviousActivePendingUserInputQuestion}
                    onInterrupt={handleInterruptPrimaryActionStable}
                    onImplementPlanInNewThread={handleImplementPlanInNewThreadPrimaryActionStable}
                    compactBeforeSendTokens={props.resumeCompactionTokens}
                    keepFullHistory={props.keepFullHistory}
                    onToggleKeepFullHistory={props.onToggleKeepFullHistory}
                    compactDisabled={
                      compactDisabled || noProviderAvailable || isSendBusy || isConnecting
                    }
                    compactDisabledReason={resolvedCompactDisabledReason}
                    {...(compactCommandAvailable
                      ? { onCompactContext: compactThreadContextStable }
                      : {})}
                    threadKey={activeThreadId}
                  />
                </div>
              </div>
            )}
            {showInlineRestingControls ? (
              <div className="h-8">
                <div
                  ref={setInlineRestingControlsHost}
                  className="absolute bottom-2 inset-x-4 min-w-0"
                >
                  <div
                    ref={restingComposerControlsRef}
                    data-chat-composer-resting-controls="true"
                    aria-hidden={restingControlsVisible ? undefined : true}
                    inert={restingControlsVisible ? undefined : true}
                    className={cn(
                      "relative flex w-max min-w-0 max-w-full items-center gap-1 text-muted-foreground/70 [&_button]:text-xs!",
                      !restingControlsVisible && "invisible",
                    )}
                  >
                    {composerControls}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </ComposerSurface.Main>
      </div>
    </form>
  );
});
