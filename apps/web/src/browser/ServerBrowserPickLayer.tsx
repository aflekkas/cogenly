"use client";

import type { PreviewAnnotationPayload, PreviewAnnotationRect } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Kbd } from "~/components/ui/kbd";
import { Popover, PopoverPopup } from "~/components/ui/popover";
import { Textarea } from "~/components/ui/textarea";
import { cn, isMacPlatform } from "~/lib/utils";

import {
  type BoxRect,
  fitFrame,
  isPickCommentSubmit,
  type PageSize,
  pageRectToBox,
  type PickMarker,
} from "./serverBrowserPick";

/** A miss shorter than this keeps the highlight, so gaps between targets never flicker it out. */
const HOVER_HIDE_DELAY_MS = 90;
/** Page px above a box the label chip needs; nearer the top it tucks inside the box. */
const LABEL_CHIP_ROOM_PX = 22;

export interface PickHoverTarget {
  readonly rect: PreviewAnnotationRect;
  readonly label: string | null;
}

/** A committed pick waiting for its comment. */
export interface PickDraft {
  readonly annotation: PreviewAnnotationPayload;
  readonly rect: PreviewAnnotationRect | null;
  readonly label: string | null;
}

const boxStyle = (box: BoxRect) => ({
  translate: `${box.left}px ${box.top}px`,
  width: box.width,
  height: box.height,
});

/**
 * Everything pick mode draws over a streamed tab's canvas: the hover
 * highlight and its label, the drag marquee, the committed target with its
 * comment popover, and numbered markers for annotations already in the
 * composer. Geometry arrives in page CSS px and is laid over the letterboxed
 * frame, the same mapping pointer input uses in reverse.
 */
export function ServerBrowserPickLayer(props: {
  readonly active: boolean;
  readonly page: PageSize | null;
  /** The canvas box, in CSS px. */
  readonly box: { readonly width: number; readonly height: number } | null;
  readonly hover: PickHoverTarget | null;
  readonly marquee: PreviewAnnotationRect | null;
  /** A commit in flight, before its annotation arrives. */
  readonly pending: PreviewAnnotationRect | null;
  readonly draft: PickDraft | null;
  readonly draftOpen: boolean;
  readonly markers: ReadonlyArray<PickMarker>;
  readonly onAdd: (comment: string) => void;
  readonly onCancel: () => void;
  readonly onClosed: () => void;
}) {
  const { active, page, box, hover, marquee, pending, draft, draftOpen, markers } = props;
  const frame = page && box ? fitFrame(box, page) : null;
  const place = (rect: PreviewAnnotationRect) =>
    frame && page ? pageRectToBox(rect, frame, page) : null;

  // The highlight stays mounted and remembers its last target: a reply that
  // moves it glides there, a short miss keeps it, and only a real miss fades it.
  const [shown, setShown] = useState<(PickHoverTarget & { readonly glide: boolean }) | null>(null);
  const [hoverVisible, setHoverVisible] = useState(false);
  const hoverVisibleRef = useRef(false);
  useEffect(() => {
    if (hover) {
      // Gliding from where it faded out would sweep across the page; appear in place instead.
      setShown({ ...hover, glide: hoverVisibleRef.current });
      hoverVisibleRef.current = true;
      setHoverVisible(true);
      return;
    }
    const timer = setTimeout(() => {
      hoverVisibleRef.current = false;
      setHoverVisible(false);
    }, HOVER_HIDE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [hover]);

  const placedMarkers = markers.flatMap((marker) => {
    const markerBox = place(marker.rect);
    return markerBox ? [{ marker, box: markerBox }] : [];
  });
  const hoverBox = shown ? place(shown.rect) : null;
  const marqueeBox = marquee ? place(marquee) : null;
  // The committed target outlives its popover so the popover can fade out on it.
  const targetRect = pending ?? draft?.rect ?? null;
  const [lastTarget, setLastTarget] = useState<PreviewAnnotationRect | null>(null);
  if (targetRect && targetRect !== lastTarget) setLastTarget(targetRect);
  const shownTarget = targetRect ?? lastTarget;
  const targetBox = shownTarget ? place(shownTarget) : null;
  const targetRef = useRef<HTMLDivElement | null>(null);
  // Read by the popover's outside-press guard; written by the form.
  const commentRef = useRef("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const setComment = useCallback((comment: string) => {
    commentRef.current = comment;
  }, []);

  return (
    <div
      aria-hidden={!draftOpen}
      className={cn(
        "pointer-events-none absolute inset-0 overflow-hidden transition-opacity duration-(--motion-duration-fast) ease-out",
        active ? "opacity-100" : "opacity-0",
      )}
    >
      {/* Badges render last of the boxes, so no outline or highlight crosses a number. */}
      {placedMarkers.map(({ marker, box: markerBox }) => (
        <div
          key={marker.id}
          className="reveal-motion absolute top-0 left-0 rounded-sm border border-primary/70 ring-1 ring-background/60"
          style={boxStyle(markerBox)}
          data-pick-marker={marker.number}
        />
      ))}
      {hoverBox && shown ? (
        <div
          className="pick-glide absolute top-0 left-0 rounded-sm border border-primary bg-primary/10 ring-1 ring-background/60"
          data-glide={shown.glide ? "" : undefined}
          data-pick-hover
          style={{
            ...boxStyle(hoverBox),
            opacity: hoverVisible ? 1 : 0,
          }}
        >
          {shown.label ? (
            <span
              className={cn(
                "absolute left-0 max-w-64 truncate rounded-sm bg-primary px-1.5 py-0.5 text-xs font-medium text-primary-foreground shadow-sm ring-1 ring-background/60",
                shown.rect.y < LABEL_CHIP_ROOM_PX ? "top-0.5 left-0.5" : "bottom-full mb-1",
              )}
            >
              {shown.label}
            </span>
          ) : null}
        </div>
      ) : null}
      {marqueeBox ? (
        <div
          className="absolute top-0 left-0 rounded-sm border border-dashed border-primary bg-primary/10"
          data-pick-marquee
          style={boxStyle(marqueeBox)}
        />
      ) : null}
      {targetBox ? (
        <div
          ref={targetRef}
          className="pick-glide absolute top-0 left-0 rounded-sm border-2 border-primary bg-primary/10 ring-1 ring-background/60"
          style={{ ...boxStyle(targetBox), opacity: targetRect ? 1 : 0 }}
          data-pick-target
        />
      ) : null}
      {placedMarkers.map(({ marker, box: markerBox }) => (
        <span
          key={marker.id}
          // Each earlier badge on this corner pushes this one a badge-width and a gap right.
          style={{
            translate: `calc(${markerBox.left}px - 0.625rem + ${marker.stack * 1.5}rem) calc(${markerBox.top}px - 0.625rem)`,
          }}
          className="reveal-motion absolute top-0 left-0 flex size-5 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground tabular-nums shadow-sm ring-1 ring-background/60"
        >
          {marker.number}
        </span>
      ))}
      <Popover
        open={draftOpen && draft !== null}
        onOpenChange={(open, details) => {
          if (open) return;
          // A stray click on the page must not throw away a written comment.
          if (details.reason === "outside-press" && commentRef.current.trim()) return;
          props.onCancel();
        }}
        onOpenChangeComplete={(open) => {
          if (!open) props.onClosed();
        }}
      >
        <PopoverPopup
          anchor={targetRef}
          side="bottom"
          align="start"
          sideOffset={8}
          width="sm"
          padding="compact"
          aria-label="Annotation comment"
          initialFocus={textareaRef}
        >
          {draft ? (
            <PickCommentForm
              key={draft.annotation.id}
              draft={draft}
              onCommentChange={setComment}
              textareaRef={textareaRef}
              onAdd={props.onAdd}
              onCancel={props.onCancel}
            />
          ) : null}
        </PopoverPopup>
      </Popover>
    </div>
  );
}

function PickCommentForm(props: {
  readonly draft: PickDraft;
  readonly onCommentChange: (comment: string) => void;
  readonly textareaRef: { current: HTMLTextAreaElement | null };
  readonly onAdd: (comment: string) => void;
  readonly onCancel: () => void;
}) {
  const { draft, onCommentChange } = props;
  const [comment, setComment] = useState("");
  // Each pick starts blank, so the outside-press guard must not see the last one's comment.
  useEffect(() => onCommentChange(""), [onCommentChange]);
  const thumbnail = draft.annotation.screenshot?.dataUrl ?? null;
  const label = draft.label ?? (draft.annotation.elements.length > 0 ? "Element" : "Region");
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        props.onAdd(comment.trim());
      }}
    >
      <p className="truncate text-xs font-medium text-muted-foreground">{label}</p>
      {thumbnail ? (
        <img
          src={thumbnail}
          alt=""
          className="max-h-24 w-full rounded-md border border-border bg-muted object-contain"
        />
      ) : null}
      <Textarea
        size="sm"
        ref={props.textareaRef}
        aria-label="Comment"
        placeholder="What should change here?"
        value={comment}
        onChange={(event) => {
          setComment(event.target.value);
          props.onCommentChange(event.target.value);
        }}
        onKeyDown={(event) => {
          if (!isPickCommentSubmit({ ...event, isComposing: event.nativeEvent.isComposing }))
            return;
          event.preventDefault();
          props.onAdd(comment.trim());
        }}
      />
      <div className="flex items-center justify-between gap-2">
        <Kbd>{isMacPlatform(navigator.platform) ? "⌘" : "Ctrl"} Enter</Kbd>
        <div className="flex items-center gap-1.5">
          <Button type="button" variant="ghost" size="xs" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button type="submit" size="xs">
            Add
          </Button>
        </div>
      </div>
    </form>
  );
}
