import type { LiveDictationPhase } from "./liveDictation";

// Scripts written without spaces between words.
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;
// U+FFFC stands in for a chip, which reads as a word.
const ENDS_WORD = /[\p{L}\p{N}.!?,:;)\]}'"￼]/u;
const STARTS_WORD = /[\p{L}\p{N}([{'"￼]/u;

/**
 * Dictated `text` as it should land between the characters `before` and
 * `after` the caret: trimmed, with a space on either side where it would
 * otherwise run into a neighbouring word.
 */
export function spaceDictatedText(before: string, after: string, text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "";
  const left = before.at(-1);
  const right = after[0];
  const first = trimmed[0]!;
  const last = trimmed.at(-1)!;
  const needsLeft =
    left !== undefined &&
    ENDS_WORD.test(left) &&
    !UNSPACED.test(left) &&
    !UNSPACED.test(first) &&
    !/^[.!?,:;)\]}]/.test(trimmed);
  const needsRight =
    right !== undefined && STARTS_WORD.test(right) && !UNSPACED.test(right) && !UNSPACED.test(last);
  return `${needsLeft ? " " : ""}${trimmed}${needsRight ? " " : ""}`;
}

/**
 * Escape cancels an active run. Enter is left to the composer, which finishes
 * the dictation before it sends.
 */
export function dictationKeyAction(
  phase: LiveDictationPhase,
  event: Pick<KeyboardEvent, "key" | "isComposing">,
): "cancel" | null {
  if (event.isComposing) return null;
  return event.key === "Escape" && phase !== "idle" ? "cancel" : null;
}
