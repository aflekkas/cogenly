import {
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
  MessageId,
  type AssistantCitation,
  type ScopedThreadRef,
} from "@cogenly/contracts";
import { QuoteIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  captureAssistantTextSelection,
  type AssistantCitationSourceAnchor,
} from "~/lib/assistantTextSelection";
import { observeSelectionActions, resolveSelectionPillPosition } from "~/lib/selectionActions";
import { Button } from "../ui/button";

type CapturedSelection = {
  citation: AssistantCitation;
  sourceAnchor: AssistantCitationSourceAnchor;
  geometry: Omit<Parameters<typeof resolveSelectionPillPosition>[0], "size" | "viewport">;
};

/**
 * The "Cite" pill for text selected in an assistant message. It stays mounted
 * so it can fade in and out; while open, a changed selection moves it rather
 * than re-popping it. Placement ignores the pointer (see
 * resolveSelectionPillPosition), so it never lands on the selected text.
 */
export function AssistantSelectionToolbar({
  viewport,
  threadRef,
  onCite,
}: {
  viewport: HTMLElement | null;
  threadRef: ScopedThreadRef;
  onCite: (citation: AssistantCitation, sourceAnchor: AssistantCitationSourceAnchor) => boolean;
}) {
  // The last selection outlives `open` so the pill keeps its label and place
  // while it fades out.
  const [selection, setSelection] = useState<CapturedSelection | null>(null);
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const shownRef = useRef(false);
  const actionsRef = useRef<ReturnType<typeof observeSelectionActions> | null>(null);

  useLayoutEffect(() => {
    openRef.current = open;
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    if (!open || !selection) {
      shownRef.current = false;
      return;
    }
    const position = resolveSelectionPillPosition({
      ...selection.geometry,
      size: { width: wrapper.offsetWidth, height: wrapper.offsetHeight },
      viewport: { width: window.innerWidth, height: window.innerHeight },
    });
    if (!position) return;
    // Glide only between two open positions; an opening pill appears in place.
    wrapper.dataset.moving = shownRef.current ? "true" : "false";
    wrapper.style.translate = `${position.x}px ${position.y}px`;
    shownRef.current = true;
  }, [open, selection]);

  useEffect(() => {
    if (!viewport) return;
    const clear = () => setOpen(false);
    const update = () => {
      const captured = captureAssistantTextSelection(viewport, window.getSelection());
      const messageId = captured?.source.dataset.assistantCitationSource;
      if (!captured || !messageId) {
        clear();
        return;
      }
      const rect = captured.range.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      if (rect.bottom < viewportRect.top || rect.top > viewportRect.bottom || rect.width === 0) {
        clear();
        return;
      }
      const sourceRect = captured.source.getBoundingClientRect();
      setSelection({
        sourceAnchor: { source: captured.source, range: captured.range, viewport },
        citation: {
          version: 1,
          ...threadRef,
          messageId: MessageId.make(messageId),
          ...captured.selector,
        },
        geometry: {
          lines: Array.from(captured.range.getClientRects()),
          column: { left: sourceRect.left, right: sourceRect.right },
          bounds: { top: viewportRect.top, bottom: viewportRect.bottom },
        },
      });
      setOpen(true);
    };
    const actions = observeSelectionActions({
      element: viewport,
      getActionElement: () => (openRef.current ? buttonRef.current : null),
      onSelection: update,
      onDismiss: clear,
    });
    actionsRef.current = actions;
    const focusActions = (event: KeyboardEvent) => {
      const button = buttonRef.current;
      if (
        event.key !== "Tab" ||
        event.shiftKey ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.isComposing ||
        event.defaultPrevented ||
        !openRef.current ||
        !button ||
        button.contains(event.target as Node)
      ) {
        return;
      }
      if (button.disabled) return;
      event.preventDefault();
      event.stopPropagation();
      button.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", focusActions, true);
    document.addEventListener("selectionchange", actions.selectionChanged);
    return () => {
      document.removeEventListener("keydown", focusActions, true);
      document.removeEventListener("selectionchange", actions.selectionChanged);
      actions.dispose();
      actionsRef.current = null;
    };
  }, [threadRef, viewport]);

  if (!viewport) return null;
  const tooLong =
    selection !== null && selection.citation.text.length > ASSISTANT_CITATION_MAX_TEXT_LENGTH;
  const dismiss = () => {
    actionsRef.current?.cancel();
    setOpen(false);
  };
  const cite = () => {
    if (!selection || tooLong || !onCite(selection.citation, selection.sourceAnchor)) return false;
    window.getSelection()?.removeAllRanges();
    dismiss();
    return true;
  };
  return createPortal(
    <div
      ref={wrapperRef}
      data-open={open}
      aria-hidden={!open}
      inert={!open}
      className="pointer-events-none fixed top-0 left-0 z-50 max-w-[calc(100vw-1rem)] origin-top transition-[opacity,scale] duration-150 ease-out data-[moving=true]:transition-[opacity,scale,translate] data-[open=false]:scale-96 data-[open=false]:opacity-0 data-[open=true]:pointer-events-auto motion-reduce:transition-opacity motion-reduce:data-[open=false]:scale-100"
    >
      {selection ? (
        <Button
          ref={buttonRef}
          type="button"
          size="xs"
          variant="glass"
          disabled={tooLong}
          aria-label={tooLong ? "Selection is too long to cite" : "Cite selection in composer"}
          onPointerDown={(event) => event.preventDefault()}
          onClick={cite}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Escape" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              dismiss();
            }
          }}
        >
          <QuoteIcon aria-hidden="true" className="size-3.5" />
          {tooLong ? "Shorten selection" : "Cite"}
        </Button>
      ) : null}
    </div>,
    document.body,
  );
}
