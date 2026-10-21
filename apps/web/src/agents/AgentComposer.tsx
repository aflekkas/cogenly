import type { ModelSelection } from "@t3tools/contracts";
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { ComposerPrimaryActions } from "~/components/chat/ComposerPrimaryActions";
import { ComposerSurface } from "~/components/chat/ComposerSurface";
import { cn } from "~/lib/utils";
import { agentDraft } from "./agents.logic";
import { useAgentsClient } from "./agentsClient";
import type { AgentContact } from "./agents.types";

const noop = () => {};
// The chat composer's prompt editor sizing: three lines at rest, scrolling past 13rem.
const MIN_HEIGHT = 78;
const MAX_HEIGHT = 208;

/**
 * The chat composer's card, pickers and send button around a plain-text prompt.
 * Agent texts carry no attachments, so there is no attach button.
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
}: {
  agent: AgentContact;
  canWrite: boolean;
  sending: boolean;
  /** The saved model cannot run, so texting waits for another pick. */
  modelUnavailable: boolean;
  pickerOpen: boolean;
  onPickerOpenChange: (open: boolean) => void;
  onSend: (text: string) => Promise<void>;
  onError: (message: string | null) => void;
  /** The prompt editor, for callers that measure it. */
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
}) {
  const client = useAgentsClient();
  const [text, setText] = useState("");
  const own = useRef<HTMLTextAreaElement>(null);
  const textarea = textareaRef ?? own;
  // Shown until the saved profile catches up, so the pickers never snap back mid-save.
  const [pendingSelection, setPendingSelection] = useState<ModelSelection | null>(null);
  const [savingModel, setSavingModel] = useState(false);
  const selection = pendingSelection ?? agent.modelSelection;
  const { ModelControls } = client;
  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;
    // Measuring from the resting height, not zero, keeps the conversation above from briefly
    // growing, which would clamp its scroll position away from the latest message.
    element.style.height = `${MIN_HEIGHT}px`;
    if (text)
      element.style.height = `${Math.min(Math.max(element.scrollHeight, MIN_HEIGHT), MAX_HEIGHT)}px`;
  }, [text]);
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
  async function send() {
    const outgoing = text.trim();
    // A text waits for a model switch to save so it reaches the newly chosen model.
    if (!outgoing || sending || savingModel || modelUnavailable) return;
    // The composer clears in the same frame the bubble appears below it.
    setText("");
    // A failed text stays in the conversation with its own Retry.
    await onSend(outgoing);
    textarea.current?.focus();
  }
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
                <div className="relative px-3 pt-3.5 pb-2 sm:px-4 sm:pt-4">
                  <textarea
                    ref={textarea}
                    disabled={!canWrite}
                    aria-label={`Message ${agent.name}`}
                    placeholder={`Message ${agent.name}`}
                    rows={1}
                    value={text}
                    onChange={(event) => setText(event.target.value)}
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
                  <div className="relative -m-1 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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
                  <div className="flex shrink-0 flex-nowrap items-center justify-end gap-1">
                    <ComposerPrimaryActions
                      compact={false}
                      canOperateThread={canWrite}
                      pendingAction={null}
                      isRunning={false}
                      canInterrupt={false}
                      showPlanFollowUpPrompt={false}
                      promptHasText={text.trim().length > 0}
                      isSendBusy={sending || savingModel}
                      sendDisabledReason={modelUnavailable ? "Pick an available model" : null}
                      isConnecting={false}
                      isEnvironmentUnavailable={!canWrite}
                      isPreparingWorktree={false}
                      hasSendableContent={text.trim().length > 0}
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
