import type { VoiceInputPhase } from "@t3tools/client-runtime/voice-input";

/**
 * Recovers the edit the voice controller committed: it hands back the whole
 * draft, but the composer applies text as a range replacement so chips, undo
 * grouping and the caret follow its usual insert path.
 */
export function transcriptEdit(
  before: string,
  selection: { readonly start: number; readonly end: number },
  after: string,
): { start: number; end: number; insertion: string } | null {
  const suffixLength = before.length - selection.end;
  const insertionEnd = after.length - suffixLength;
  if (
    insertionEnd < selection.start ||
    after.slice(0, selection.start) !== before.slice(0, selection.start) ||
    after.slice(insertionEnd) !== before.slice(selection.end)
  ) {
    return null;
  }
  return {
    start: selection.start,
    end: selection.end,
    insertion: after.slice(selection.start, insertionEnd),
  };
}

export type DictationKeyAction = "cancel" | "stop" | null;

/** Escape cancels any active run; a bare Enter finishes recording instead of sending. */
export function dictationKeyAction(
  phase: VoiceInputPhase,
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "metaKey" | "ctrlKey" | "altKey" | "isComposing">,
): DictationKeyAction {
  if (event.isComposing) return null;
  const active = phase === "preparing" || phase === "recording" || phase === "transcribing";
  if (event.key === "Escape" && active) return "cancel";
  const bare = !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey;
  if (event.key === "Enter" && bare && phase === "recording") return "stop";
  return null;
}
