import type { ModelSelection } from "@cogenly/contracts";
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@cogenly/client-runtime/environment";
import { formatAttachmentSize } from "@cogenly/client-runtime/state/attachments";
import { FileIcon, PaperclipIcon, XIcon } from "lucide-react";
import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
  type RefObject,
} from "react";
import {
  ComposerDictationControl,
  type ComposerDictationHandle,
} from "~/components/chat/ComposerDictationControl";
import { ComposerImageThumbnail } from "~/components/chat/ComposerImageThumbnail";
import { ComposerPrimaryActions } from "~/components/chat/ComposerPrimaryActions";
import { ComposerSurface } from "~/components/chat/ComposerSurface";
import {
  acceptComposerAttachmentFiles,
  fileAttachmentStagingLimit,
  prepareComposerImageAttachments,
  shouldHandleComposerAttachmentPaste,
} from "~/components/chat/composerAttachmentFiles";
import { Button } from "~/components/ui/button";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  composerFileNeedsReattach,
  composerTargetKey,
  useComposerDraftStore,
  useComposerThreadDraft,
} from "~/composerDraftStore";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  releaseAttachmentUpload,
  releaseDraftAttachment,
  releaseDraftAttachments,
  retryAttachmentUpload,
  startAttachmentUpload,
  useAttachmentUploadStore,
} from "~/lib/attachmentUploadQueue";
import { formatAttachmentUploadProgress } from "~/lib/attachmentUploadState";
import { cn } from "~/lib/utils";
import { primaryServerKeybindingsAtom } from "~/state/server";
import type { ChatAttachment } from "~/types";
import { agentDraft } from "./agents.logic";
import { useAgentsClient } from "./agentsClient";
import type { AgentContact } from "./agents.types";

const noop = () => {};
// The chat composer's prompt editor sizing: three lines at rest, scrolling past 13rem.
const MIN_HEIGHT = 78;
const MAX_HEIGHT = 208;

/** Lets the conversation around the composer hand it dropped files. */
export interface AgentComposerHandle {
  addFiles: (files: File[]) => void;
}

/**
 * The chat composer's card, pickers, dictation, attachments and send button around a
 * plain-text prompt. The draft lives in the conversation thread's composer draft, so
 * text and files survive leaving the agent, and uploads run through the same queue a
 * chat uses.
 */
export function AgentComposer({
  agent,
  canWrite,
  sending,
  modelUnavailable,
  pickerOpen,
  onPickerOpenChange,
  onSend,
  onError,
  textareaRef,
  handleRef,
}: {
  agent: AgentContact;
  canWrite: boolean;
  sending: boolean;
  /** The saved model cannot run, so texting waits for another pick. */
  modelUnavailable: boolean;
  pickerOpen: boolean;
  onPickerOpenChange: (open: boolean) => void;
  /** Resolves true once the text is accepted; a failed text keeps its own Retry. */
  onSend: (text: string, attachments: ReadonlyArray<ChatAttachment>) => Promise<boolean>;
  onError: (message: string | null) => void;
  /** The prompt editor, for callers that measure it. */
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  handleRef?: Ref<AgentComposerHandle>;
}) {
  const client = useAgentsClient();
  const own = useRef<HTMLTextAreaElement>(null);
  const textarea = textareaRef ?? own;
  const attachmentInput = useRef<HTMLInputElement>(null);
  const environmentId = agent.environmentId;
  const target = useMemo(
    () => scopeThreadRef(environmentId, agent.conversationThreadId),
    [environmentId, agent.conversationThreadId],
  );
  const draft = useComposerThreadDraft(target);
  const text = draft.prompt;
  const images = draft.images;
  const files = draft.files;
  const setPrompt = useComposerDraftStore((store) => store.setPrompt);
  const addDraftImages = useComposerDraftStore((store) => store.addImages);
  const addDraftFiles = useComposerDraftStore((store) => store.addFiles);
  const removeDraftImage = useComposerDraftStore((store) => store.removeImage);
  const removeDraftFile = useComposerDraftStore((store) => store.removeFile);
  const setDraftFileUpload = useComposerDraftStore((store) => store.setFileUpload);
  const clearDraft = useComposerDraftStore((store) => store.clearComposerContent);
  const uploadsByImageId = useAttachmentUploadStore((state) => state.uploadsByImageId);
  const dictationEnabled = useEnvironmentSettings(
    environmentId,
    (settings) => settings.dictationEnabled,
  );
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const support = client.attachmentSupport?.(environmentId) ?? null;
  const canAttach = support !== null;
  const fileStagingLimit = support
    ? fileAttachmentStagingLimit({
        attachmentUploadsCapabilityKnown: true,
        supportsAttachmentUploads: true,
        maxFileAttachmentBytes: support.maxFileBytes,
      })
    : null;
  // Images still compressing hold their slots so concurrent pastes stay under the cap.
  const compressing = useRef(0);
  const dictationRef = useRef<ComposerDictationHandle>(null);
  const dictationActive = useRef(false);
  // Where the next dictated segment lands; segments can settle faster than a render.
  const dictationCaret = useRef<number | null>(null);
  // Shown until the saved profile catches up, so the pickers never snap back mid-save.
  const [pendingSelection, setPendingSelection] = useState<ModelSelection | null>(null);
  const [savingModel, setSavingModel] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const selection = pendingSelection ?? agent.modelSelection;
  const { ModelControls } = client;
  const attachments = useMemo(() => [...images, ...files], [images, files]);
  const hasSendableContent = text.trim().length > 0 || attachments.length > 0;

  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;
    // Measuring from the resting height, not zero, keeps the conversation above from briefly
    // growing, which would clamp its scroll position away from the latest message.
    element.style.height = `${MIN_HEIGHT}px`;
    if (text)
      element.style.height = `${Math.min(Math.max(element.scrollHeight, MIN_HEIGHT), MAX_HEIGHT)}px`;
  }, [text]);

  // Uploads start as files land, as in a chat, so a send rarely waits on them.
  useEffect(() => {
    if (!canAttach || !canWrite) return;
    for (const attachment of attachments) {
      if (attachment.type === "file") {
        if (composerFileNeedsReattach(attachment)) continue;
        if (fileStagingLimit === null || attachment.sizeBytes > fileStagingLimit) continue;
      }
      startAttachmentUpload({ environmentId, image: attachment, draftTarget: target });
    }
  }, [attachments, canAttach, canWrite, environmentId, fileStagingLimit, target]);

  // A finished file upload is stamped on the draft so a reload still points at it.
  useEffect(() => {
    for (const file of files) {
      const upload = uploadsByImageId[file.id];
      if (upload?.status === "ready" && upload.environmentId === environmentId)
        setDraftFileUpload(target, file.id, environmentId, upload.attachmentId);
    }
  }, [environmentId, files, setDraftFileUpload, target, uploadsByImageId]);

  async function addFiles(incoming: File[]) {
    if (incoming.length === 0 || !canWrite) return;
    if (!canAttach) {
      onError("Update this agent's server to send it files.");
      return;
    }
    const current = useComposerDraftStore.getState().getComposerDraft(target);
    const accepted = acceptComposerAttachmentFiles({
      files: incoming,
      reservedCount:
        (current?.images.length ?? 0) + (current?.files.length ?? 0) + compressing.current,
      stagingLimit: fileStagingLimit,
      reattachMarkers: current?.files.filter(composerFileNeedsReattach) ?? [],
    });
    onError(accepted.error);
    if (accepted.files.length > 0) addDraftFiles(target, accepted.files);
    if (accepted.images.length === 0) return;
    compressing.current += accepted.images.length;
    try {
      const prepared = await prepareComposerImageAttachments(accepted.images);
      if (prepared.images.length > 0) addDraftImages(target, prepared.images);
      // Only failures are reported: another error may have arrived meanwhile.
      if (prepared.error !== null) onError(prepared.error);
    } finally {
      compressing.current -= accepted.images.length;
    }
  }
  useImperativeHandle(handleRef, () => ({ addFiles: (incoming) => void addFiles(incoming) }));

  function removeImage(image: ComposerImageAttachment) {
    releaseAttachmentUpload(image.id);
    removeDraftImage(target, image.id);
  }
  function removeFile(file: ComposerFileAttachment) {
    // A reloaded file's upload lives server-side under its stamped id.
    releaseDraftAttachment(file);
    removeDraftFile(target, file.id);
  }

  async function changeModel(next: ModelSelection) {
    setPendingSelection(next);
    setSavingModel(true);
    onError(null);
    try {
      // The same profile field the Details sheet edits; the next text and triggers use it.
      await client.save(agent.environmentId, { ...agentDraft(agent), modelSelection: next });
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "Could not switch models.");
    } finally {
      setPendingSelection(null);
      setSavingModel(false);
    }
  }

  /** The draft's files as uploaded attachments, or null after reporting why they cannot go. */
  async function uploadedAttachments(
    snapshot: ReadonlyArray<ComposerImageAttachment | ComposerFileAttachment>,
  ): Promise<ChatAttachment[] | null> {
    if (snapshot.length === 0) return [];
    if (!canAttach) {
      onError("Update this agent's server to send it files.");
      return null;
    }
    if (
      snapshot.some(
        (attachment) => attachment.type === "file" && composerFileNeedsReattach(attachment),
      )
    ) {
      onError("Attach the interrupted files again or remove them.");
      return null;
    }
    for (const attachment of snapshot)
      startAttachmentUpload({ environmentId, image: attachment, draftTarget: target });
    await awaitAttachmentUploads(snapshot.map((attachment) => attachment.id));
    const uploaded = getUploadedAttachments({ environmentId, images: snapshot });
    if (uploaded === null) {
      onError("Retry or remove failed uploads before sending.");
      return null;
    }
    // The optimistic bubble shows the local image until the stored one loads.
    return uploaded.map((attachment, index) => {
      const local = snapshot[index];
      return local?.type === "image" ? { ...attachment, previewUrl: local.previewUrl } : attachment;
    });
  }

  async function send() {
    // A text waits for a model switch to save so it reaches the newly chosen model.
    if (sending || preparing || savingModel || modelUnavailable) return;
    // Enter while dictating sends once the last segment has landed.
    const dictation = dictationActive.current ? dictationRef.current : null;
    if (dictation && !(await dictation.finish())) return;
    const current = useComposerDraftStore.getState().getComposerDraft(target);
    const outgoing = (current?.prompt ?? "").trim();
    const snapshot = [...(current?.images ?? []), ...(current?.files ?? [])];
    if (!outgoing && snapshot.length === 0) return;
    setPreparing(true);
    const ready = await uploadedAttachments(snapshot).finally(() => setPreparing(false));
    if (ready === null) return;
    onError(null);
    // The composer clears in the same frame the bubble appears below it.
    clearDraft(target);
    // A failed text stays in the conversation with its own Retry, files included.
    if (await onSend(outgoing, ready)) releaseDraftAttachments(snapshot);
    textarea.current?.focus();
  }

  const onDictationText = (dictated: string) => {
    const current = useComposerDraftStore.getState().getComposerDraft(target)?.prompt ?? "";
    const element = textarea.current;
    const start = Math.min(
      dictationCaret.current ?? element?.selectionStart ?? current.length,
      current.length,
    );
    const end =
      dictationCaret.current === null
        ? Math.min(Math.max(element?.selectionEnd ?? start, start), current.length)
        : start;
    const before = current.slice(0, start);
    const spacer = before.length > 0 && !/\s$/.test(before) ? " " : "";
    setPrompt(target, `${before}${spacer}${dictated}${current.slice(end)}`);
    const caret = start + spacer.length + dictated.length;
    dictationCaret.current = caret;
    requestAnimationFrame(() => element?.setSelectionRange(caret, caret));
  };

  const uploadFor = (attachment: ComposerImageAttachment | ComposerFileAttachment) => {
    const upload = uploadsByImageId[attachment.id];
    return upload?.environmentId === environmentId ? upload : undefined;
  };

  return (
    <>
      {modelUnavailable && ModelControls && (
        <button
          type="button"
          className="agent-model-notice"
          onClick={() => onPickerOpenChange(true)}
        >
          This agent's model isn't available. Pick another model to keep texting.
        </button>
      )}
      <form
        className="mx-auto w-full min-w-0"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <ComposerSurface.Shell>
          <ComposerSurface.Host>
            <ComposerSurface.Main>
              <div className={cn("rounded-3xl", !canWrite && "opacity-75")}>
                {attachments.length > 0 && (
                  <div className="flex max-w-full flex-wrap gap-2 px-3 pt-3.5 sm:px-4 sm:pt-4">
                    {images.map((image) => {
                      const upload = uploadFor(image);
                      return (
                        <div
                          key={image.id}
                          className="group/attachment relative size-16 shrink-0 overflow-hidden rounded-lg border border-border bg-background motion-safe:transition-opacity motion-safe:duration-(--motion-duration-fast) motion-safe:ease-out motion-safe:starting:opacity-0"
                        >
                          <ComposerImageThumbnail
                            file={image.file}
                            alt={image.name}
                            className="size-full object-cover"
                            fallback={
                              <span className="flex h-full items-center justify-center px-1 text-center text-3xs text-secondary-label">
                                {image.name}
                              </span>
                            }
                          />
                          {upload?.status === "uploading" && (
                            <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-background/85 px-1 text-center text-3xs text-foreground">
                              {formatAttachmentUploadProgress(upload.progress)}
                            </span>
                          )}
                          {upload?.status === "failed" && (
                            <AttachmentRetry
                              className="absolute bottom-1 left-1"
                              variant="overlay"
                              name={image.name}
                              reason={upload.reason}
                              disabled={!canWrite}
                              onRetry={() =>
                                retryAttachmentUpload({
                                  environmentId,
                                  image,
                                  draftTarget: target,
                                })
                              }
                            />
                          )}
                          <Button
                            variant="media-close"
                            size="icon-xs"
                            className="absolute top-1 right-1"
                            onClick={() => removeImage(image)}
                            aria-label={`Remove ${image.name}`}
                          >
                            <XIcon />
                          </Button>
                        </div>
                      );
                    })}
                    {files.map((file) => {
                      const upload = uploadFor(file);
                      const needsReattach = composerFileNeedsReattach(file);
                      return (
                        <div
                          key={file.id}
                          className="flex min-w-0 basis-full items-center gap-2 text-sm text-foreground motion-safe:transition-opacity motion-safe:duration-(--motion-duration-fast) motion-safe:ease-out motion-safe:starting:opacity-0"
                        >
                          <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1 truncate">{file.name}</span>
                          <span className="shrink-0 text-xs text-secondary-label">
                            {needsReattach
                              ? "Attach again"
                              : upload?.status === "uploading"
                                ? formatAttachmentUploadProgress(upload.progress)
                                : formatAttachmentSize(file.sizeBytes)}
                          </span>
                          {!needsReattach && upload?.status === "failed" && (
                            <AttachmentRetry
                              variant="ghost"
                              name={file.name}
                              reason={upload.reason}
                              disabled={!canWrite}
                              onRetry={() =>
                                retryAttachmentUpload({
                                  environmentId,
                                  image: file,
                                  draftTarget: target,
                                })
                              }
                            />
                          )}
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            onClick={() => removeFile(file)}
                            aria-label={`Remove ${file.name}`}
                          >
                            <XIcon />
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                )}
                <div className="relative px-3 pt-3.5 pb-2 sm:px-4 sm:pt-4">
                  <textarea
                    ref={textarea}
                    disabled={!canWrite}
                    aria-label={`Message ${agent.name}`}
                    placeholder={`Message ${agent.name}`}
                    rows={1}
                    value={text}
                    onChange={(event) => setPrompt(target, event.target.value)}
                    onPaste={(event) => {
                      const pasted = Array.from(event.clipboardData.files);
                      if (
                        pasted.length === 0 ||
                        !shouldHandleComposerAttachmentPaste({
                          files: pasted,
                          plainText: event.clipboardData.getData("text/plain"),
                        })
                      )
                        return;
                      event.preventDefault();
                      void addFiles(pasted);
                    }}
                    onKeyDown={(event) => {
                      if (
                        event.key === "Enter" &&
                        !event.shiftKey &&
                        !event.nativeEvent.isComposing &&
                        !window.matchMedia("(pointer: coarse)").matches
                      ) {
                        event.preventDefault();
                        void send();
                      }
                    }}
                    className="-m-1 block w-[calc(100%+0.5rem)] resize-none overflow-y-auto bg-transparent p-1 font-(family-name:--font-composer,var(--font-sans)) text-(length:--font-size-prompt,var(--text-sm)) leading-relaxed text-foreground placeholder:text-placeholder/75 focus:outline-none max-sm:pointer-coarse:text-(length:--font-size-prompt-touch)"
                  />
                </div>
                <div className="flex min-w-0 flex-nowrap items-center justify-between gap-2 px-3 pb-3 sm:gap-0 sm:px-4 sm:pb-4">
                  <div className="scroll-fade-x relative -m-1 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                    {ModelControls && (
                      <ModelControls
                        agent={agent}
                        selection={selection}
                        disabled={!canWrite || savingModel}
                        unavailable={modelUnavailable}
                        pickerOpen={pickerOpen}
                        onPickerOpenChange={onPickerOpenChange}
                        onChange={(next) => void changeModel(next)}
                      />
                    )}
                  </div>
                  <div className="flex shrink-0 flex-nowrap items-center justify-end gap-2">
                    {dictationEnabled && (
                      <ComposerDictationControl
                        ownerKey={composerTargetKey(target)}
                        disabled={!canWrite}
                        keybindings={keybindings}
                        handleRef={dictationRef}
                        // A textarea has no inline preview; each settled segment lands at the caret.
                        onPartial={noop}
                        onFinal={onDictationText}
                        onActiveChange={(active) => {
                          dictationActive.current = active;
                          dictationCaret.current = null;
                        }}
                      />
                    )}
                    {canAttach && (
                      <>
                        <input
                          ref={attachmentInput}
                          type="file"
                          multiple
                          className="hidden"
                          onChange={(event) => {
                            const picked = Array.from(event.currentTarget.files ?? []);
                            event.currentTarget.value = "";
                            void addFiles(picked).then(() => textarea.current?.focus());
                          }}
                        />
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                disabled={!canWrite}
                                onPointerDown={(event) => event.preventDefault()}
                                onClick={() => attachmentInput.current?.click()}
                                aria-label="Attach files"
                              />
                            }
                          >
                            <PaperclipIcon />
                          </TooltipTrigger>
                          <TooltipPopup>Attach files</TooltipPopup>
                        </Tooltip>
                      </>
                    )}
                    <ComposerPrimaryActions
                      compact={false}
                      canOperateThread={canWrite}
                      pendingAction={null}
                      isRunning={false}
                      canInterrupt={false}
                      showPlanFollowUpPrompt={false}
                      promptHasText={text.trim().length > 0}
                      isSendBusy={sending || preparing || savingModel}
                      sendDisabledReason={modelUnavailable ? "Pick an available model" : null}
                      isConnecting={false}
                      isEnvironmentUnavailable={!canWrite}
                      isPreparingWorktree={false}
                      hasSendableContent={hasSendableContent}
                      onPreviousPendingQuestion={noop}
                      onInterrupt={noop}
                      onImplementPlanInNewThread={noop}
                    />
                  </div>
                </div>
              </div>
            </ComposerSurface.Main>
          </ComposerSurface.Host>
        </ComposerSurface.Shell>
      </form>
    </>
  );
}

function AttachmentRetry({
  name,
  reason,
  disabled,
  variant,
  className,
  onRetry,
}: {
  name: string;
  reason: string;
  disabled: boolean;
  variant: "overlay" | "ghost";
  className?: string;
  onRetry: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant={variant}
            size="icon-xs"
            {...(className ? { className } : {})}
            onClick={onRetry}
            disabled={disabled}
            aria-label={`Retry upload for ${name}`}
          />
        }
      >
        <RefreshIcon />
      </TooltipTrigger>
      <TooltipPopup side="top">{reason}</TooltipPopup>
    </Tooltip>
  );
}
