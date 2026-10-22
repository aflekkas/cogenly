// @effect-diagnostics globalTimers:off -- The settle highlight is cleared by a plain timer per editor.
import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

import { markAsClipboardEdit } from "../composer-undo-grouping";
import { spaceDictatedText } from "../dictation/composerDictation.logic";

/**
 * Live dictation in the composer. Volatile text is a widget at the caret, never
 * part of the document, so it cannot reach the draft, undo history or a send.
 * Settled segments are real text inserted at the caret, one undo step each,
 * briefly decorated so they fade from the preview's muted color.
 */

interface DictationState {
  readonly preview: string | null;
  readonly settling: DecorationSet;
}

type DictationMeta =
  | { readonly kind: "preview"; readonly text: string | null }
  | { readonly kind: "settle"; readonly from: number; readonly to: number }
  | { readonly kind: "settled" };

const DictationPluginKey = new PluginKey<DictationState>("composer-dictation");
// Longer than --motion-duration-base so the settle animation always finishes.
const SETTLE_MS = 300;

/** The characters just outside `from`..`to`; a chip or block edge reads as U+FFFC or nothing. */
function neighbours(doc: ProseMirrorNode, from: number, to: number) {
  const before = doc.textBetween(Math.max(0, from - 1), from, "\n", "￼");
  const after = doc.textBetween(to, Math.min(doc.content.size, to + 1), "\n", "￼");
  return { before, after };
}

function previewDecorations(state: EditorState, element: HTMLElement): DecorationSet | null {
  const value = DictationPluginKey.getState(state);
  if (!value) return null;
  if (!value.preview) return value.settling;
  const { from, to } = state.selection;
  const { before, after } = neighbours(state.doc, from, to);
  const text = spaceDictatedText(before, after, value.preview);
  if (!text) return value.settling;
  // ProseMirror ignores mutations inside widgets, so one element is reused and
  // its text updated in place; a stable key keeps it from being re-created.
  if (element.textContent !== text) element.textContent = text;
  return value.settling.add(state.doc, [
    Decoration.widget(from, element, {
      side: 1,
      key: "composer-dictation-preview",
      ignoreSelection: true,
    }),
  ]);
}

export const ComposerDictationExtension = Extension.create({
  name: "composer-dictation",
  addProseMirrorPlugins() {
    const element = document.createElement("span");
    element.className = "composer-dictation-preview";
    element.contentEditable = "false";
    element.setAttribute("aria-hidden", "true");
    return [
      new Plugin<DictationState>({
        key: DictationPluginKey,
        state: {
          init: () => ({ preview: null, settling: DecorationSet.empty }),
          apply(tr, value) {
            const meta = tr.getMeta(DictationPluginKey) as DictationMeta | undefined;
            let { preview, settling } = value;
            if (tr.docChanged) settling = settling.map(tr.mapping, tr.doc);
            if (meta?.kind === "preview") preview = meta.text;
            if (meta?.kind === "settle") {
              preview = null;
              settling = settling.add(tr.doc, [
                Decoration.inline(meta.from, meta.to, { class: "composer-dictation-settle" }),
              ]);
            }
            if (meta?.kind === "settled") settling = DecorationSet.empty;
            return preview === value.preview && settling === value.settling
              ? value
              : { preview, settling };
          },
        },
        props: {
          decorations: (state) => previewDecorations(state, element),
        },
      }),
    ];
  },
});

/** Shows `text` as volatile dictation at the caret, or clears it. */
export function setDictationPreview(view: EditorView, text: string | null): void {
  const current = DictationPluginKey.getState(view.state);
  if (!current || current.preview === text) return;
  const meta: DictationMeta = { kind: "preview", text };
  view.dispatch(view.state.tr.setMeta(DictationPluginKey, meta).setMeta("addToHistory", false));
}

const settleTimers = new WeakMap<EditorView, ReturnType<typeof setTimeout>>();

/**
 * Inserts a settled segment at the caret, replacing a selection like typing
 * would, and leaves the caret after it. Works whether or not the editor has
 * focus, so text lands where the user last put the cursor.
 */
export function insertDictatedText(view: EditorView, text: string): boolean {
  const { state } = view;
  const { from, to } = state.selection;
  const { before, after } = neighbours(state.doc, from, to);
  const insertion = spaceDictatedText(before, after, text);
  if (!insertion) {
    setDictationPreview(view, null);
    return false;
  }
  const meta: DictationMeta = { kind: "settle", from, to: from + insertion.length };
  const tr = markAsClipboardEdit(state.tr.insertText(insertion, from, to), "dictation");
  tr.setMeta(DictationPluginKey, meta);
  if (view.hasFocus()) tr.scrollIntoView();
  view.dispatch(tr);
  clearTimeout(settleTimers.get(view));
  settleTimers.set(
    view,
    setTimeout(() => {
      if (view.isDestroyed) return;
      const settled: DictationMeta = { kind: "settled" };
      view.dispatch(
        view.state.tr.setMeta(DictationPluginKey, settled).setMeta("addToHistory", false),
      );
    }, SETTLE_MS),
  );
  return true;
}
