import {
  HandIcon,
  HighlighterIcon,
  MoveUpRightIcon,
  PencilIcon,
  Redo2Icon,
  SquareIcon,
  Trash2Icon,
  TypeIcon,
  Undo2Icon,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@cogenly/contracts";

import type { ComposerImageAttachment } from "../../composerDraftStore";
import { isContextMenuOpen } from "../../contextMenuFallback";
import { prepareImageForAttachment } from "../../lib/imageCompression";
import { cn, isMacPlatform } from "../../lib/utils";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { Kbd } from "../ui/kbd";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { composerFloatingLayerProps } from "./composerEventScope";
import {
  DEFAULT_MARKUP_COLOR,
  MARKUP_STROKE_SIZES,
  MARKUP_SWATCHES,
  MARKUP_TEXT_WEIGHT,
  MARKUP_TOOL_SHORTCUTS,
  addShape,
  appendStrokePoint,
  canRedoMarkup,
  canUndoMarkup,
  clampToMarkupArea,
  clearShapes,
  createMarkupHistory,
  fontSizeFor,
  isMeaningfulShape,
  redoMarkup,
  shapeOpacity,
  shapePath,
  strokeWidthFor,
  textHaloColor,
  textHaloWidth,
  undoMarkup,
  type MarkupHistory,
  type MarkupShape,
  type MarkupStrokeSize,
  type MarkupTool,
  type Point,
} from "./imageMarkup";
import { flattenMarkup, markupBackgroundColor } from "./imageMarkupCanvas";
import type { ImageMarkupSession } from "./imageMarkupSessions";
import { ZoomableImage, type ZoomableImageHandle } from "./ZoomableImage";
import type { ImageView, Size } from "./zoomableImageView";

const IS_MAC = typeof navigator !== "undefined" && isMacPlatform(navigator.platform);
const MOD = IS_MAC ? "⌘" : "Ctrl+";

/** Leaves room above and below the canvas for the toolbar and the action bar. */
const STAGE_SIZE = {
  "--media-width": "92vw",
  "--media-height": "calc(92vh - 7rem)",
} as CSSProperties;

const TOOLS: ReadonlyArray<{
  tool: MarkupTool;
  label: string;
  shortcut: string;
  icon: ReactNode;
}> = [
  { tool: "pen", label: "Pen", shortcut: "P", icon: <PencilIcon /> },
  { tool: "highlighter", label: "Highlighter", shortcut: "H", icon: <HighlighterIcon /> },
  { tool: "arrow", label: "Arrow", shortcut: "A", icon: <MoveUpRightIcon /> },
  { tool: "rect", label: "Rectangle", shortcut: "R", icon: <SquareIcon /> },
  { tool: "text", label: "Text", shortcut: "T", icon: <TypeIcon /> },
  { tool: "hand", label: "Hand", shortcut: "Space", icon: <HandIcon /> },
];

const SIZE_LABELS: Record<MarkupStrokeSize, string> = { S: "Small", M: "Medium", L: "Large" };

let shapeCounter = 0;
const nextShapeId = () => `shape-${String((shapeCounter += 1))}`;

interface TextDraft {
  readonly id: string;
  readonly at: Point;
  readonly value: string;
  readonly color: string;
  readonly fontSize: number;
}

function ShapeView({ shape }: { shape: MarkupShape }) {
  if (shape.kind === "text") {
    return (
      <text
        x={shape.at.x}
        y={shape.at.y}
        fill={shape.color}
        fontSize={shape.width}
        fontWeight={MARKUP_TEXT_WEIGHT}
        stroke={textHaloColor(shape.color)}
        strokeWidth={textHaloWidth(shape.width)}
        strokeLinejoin="round"
        paintOrder="stroke"
        dominantBaseline="text-before-edge"
        className="font-sans"
      >
        {shape.text}
      </text>
    );
  }
  return (
    <path
      d={shapePath(shape)}
      fill="none"
      stroke={shape.color}
      strokeWidth={shape.width}
      strokeLinecap="round"
      strokeLinejoin="round"
      opacity={shapeOpacity(shape)}
    />
  );
}

function ToolbarTip({
  label,
  keys,
  children,
}: {
  label: string;
  keys?: string;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      {children}
      <TooltipPopup side="bottom">
        <span className="flex items-center gap-1.5">
          {label}
          {keys ? <Kbd>{keys}</Kbd> : null}
        </span>
      </TooltipPopup>
    </Tooltip>
  );
}

const ToolbarDivider = () => <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border" />;

/**
 * Draws on a composer image attachment: pen, highlighter, arrow, rectangle and
 * text over the zoomable canvas, with undo, redo and clear. "Done" flattens
 * the shapes into a PNG at the image's own resolution; the shapes and the
 * original stay with the attachment until it is sent, so the editor reopens
 * with every stroke editable and "Revert to original" can undo the whole edit.
 */
export function ImageMarkupDialog({
  image,
  session: initialSession,
  onCancel,
  onApply,
  onRevert,
}: {
  /** The attachment as it sits in the composer, marked up or not. */
  image: ComposerImageAttachment;
  /** The original and its shapes, when `image` is already marked up. */
  session: ImageMarkupSession | undefined;
  onCancel: () => void;
  onApply: (file: File, base: ComposerImageAttachment, shapes: ReadonlyArray<MarkupShape>) => void;
  onRevert: () => void;
}) {
  // Read once: the dialog keeps showing what it opened on while it fades out
  // after the attachment it edits has been replaced.
  const [session] = useState(initialSession);
  const base = session?.original ?? image;
  const [tool, setTool] = useState<MarkupTool>("pen");
  const [color, setColor] = useState(DEFAULT_MARKUP_COLOR);
  const [size, setSize] = useState<MarkupStrokeSize>("M");
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const zoomableRef = useRef<ZoomableImageHandle>(null);
  const firstToolRef = useRef<HTMLButtonElement>(null);

  // History, the stroke in progress, and the text being typed are read by
  // pointer and key handlers between renders, so each keeps a ref in step.
  const [history, setHistoryState] = useState<MarkupHistory>(() =>
    createMarkupHistory(session?.shapes ?? []),
  );
  const historyRef = useRef(history);
  const setHistory = (update: (current: MarkupHistory) => MarkupHistory) => {
    historyRef.current = update(historyRef.current);
    setHistoryState(historyRef.current);
  };
  const [draft, setDraftState] = useState<MarkupShape | null>(null);
  const draftRef = useRef<{ shape: MarkupShape; natural: Size; scale: number } | null>(null);
  const [textDraft, setTextDraftState] = useState<TextDraft | null>(null);
  const textDraftRef = useRef<TextDraft | null>(null);
  const setTextDraft = (next: TextDraft | null) => {
    textDraftRef.current = next;
    setTextDraftState(next);
  };

  /** Adds the typed label as a shape; `id` limits it to that label (a stale blur). */
  const commitText = (id?: string) => {
    const pending = textDraftRef.current;
    if (!pending || (id !== undefined && pending.id !== id)) return;
    setTextDraft(null);
    const shape: MarkupShape = {
      id: pending.id,
      kind: "text",
      at: pending.at,
      text: pending.value.trim(),
      color: pending.color,
      width: pending.fontSize,
    };
    if (isMeaningfulShape(shape, 0)) setHistory((current) => addShape(current, shape));
  };

  const drawing = {
    active: tool !== "hand" && !spaceHeld && !busy,
    onStart: (raw: Point, { view, natural }: { view: ImageView; natural: Size }) => {
      const point = clampToMarkupArea(raw, natural);
      commitText();
      if (tool === "text") {
        setTextDraft({
          id: nextShapeId(),
          at: point,
          value: "",
          color,
          fontSize: fontSizeFor(size, natural),
        });
        return;
      }
      if (tool === "hand") return;
      const style = { id: nextShapeId(), color, width: strokeWidthFor(size, natural, tool) };
      const shape: MarkupShape =
        tool === "pen" || tool === "highlighter"
          ? { ...style, kind: tool, points: [point] }
          : { ...style, kind: tool, from: point, to: point };
      draftRef.current = { shape, natural, scale: view.scale };
      setDraftState(shape);
    },
    onMove: (raw: Point) => {
      const current = draftRef.current;
      if (!current) return;
      const point = clampToMarkupArea(raw, current.natural);
      const { shape } = current;
      const next: MarkupShape =
        shape.kind === "pen" || shape.kind === "highlighter"
          ? { ...shape, points: appendStrokePoint(shape.points, point, 0.75 / current.scale) }
          : shape.kind === "arrow" || shape.kind === "rect"
            ? { ...shape, to: point }
            : shape;
      if (next === shape || ("points" in next && "points" in shape && next.points === shape.points))
        return;
      draftRef.current = { ...current, shape: next };
      setDraftState(next);
    },
    onEnd: (commit: boolean) => {
      const current = draftRef.current;
      draftRef.current = null;
      setDraftState(null);
      if (commit && current && isMeaningfulShape(current.shape, 3 / current.scale)) {
        setHistory((existing) => addShape(existing, current.shape));
      }
    },
  };

  const undo = () => setHistory(undoMarkup);
  const redo = () => setHistory(redoMarkup);
  const clear = () => {
    setTextDraft(null);
    setHistory(clearShapes);
  };

  const done = async () => {
    if (busy) return;
    commitText();
    const shapes = historyRef.current.present;
    if (shapes.length === 0) {
      // Nothing drawn: a fresh image closes as it was; a marked-up one goes back to its original.
      if (session) onRevert();
      else onCancel();
      return;
    }
    if (session && shapes === session.shapes) {
      onCancel();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const flattened = await flattenMarkup(base.file, base.name, shapes, markupBackgroundColor());
      // A full-resolution PNG can pass the send cap; shrink it like any attached image.
      const prepared = await prepareImageForAttachment(
        flattened,
        PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
      );
      if (!prepared.ok) throw new Error(prepared.reason);
      onApply(prepared.file, base, shapes);
    } catch {
      setBusy(false);
      setError("The markup could not be saved. Try again.");
    }
  };
  const cancel = () => {
    if (!busy) onCancel();
  };

  // Latest handlers for the window listeners bound once below.
  const dropText = () => setTextDraft(null);
  const keyHandlers = useRef({ done, cancel, undo, redo, setTool, dropText });
  useEffect(() => {
    keyHandlers.current = { done, cancel, undo, redo, setTool, dropText };
  });

  // Shortcuts run in the capture phase so the composer underneath never sees
  // them (Escape there interrupts the agent, ⌘Z edits the prompt).
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (isContextMenuOpen()) return;
      const handlers = keyHandlers.current;
      const typing = textDraftRef.current !== null;
      const mod = event.metaKey || event.ctrlKey;
      const handled = () => {
        event.preventDefault();
        event.stopPropagation();
      };
      if (event.key === "Escape") {
        handled();
        if (typing) handlers.dropText();
        else handlers.cancel();
        return;
      }
      if (mod && event.key === "Enter") {
        handled();
        void handlers.done();
        return;
      }
      // The text field keeps its own keys, including its own undo.
      if (typing) return;
      if (mod && !event.altKey && event.key.toLowerCase() === "z") {
        handled();
        if (event.shiftKey) handlers.redo();
        else handlers.undo();
        return;
      }
      if (event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "y") {
        handled();
        handlers.redo();
        return;
      }
      if (mod || event.altKey) return;
      if (event.key === " ") {
        handled();
        setSpaceHeld(true);
        return;
      }
      const shortcut = MARKUP_TOOL_SHORTCUTS[event.key.toLowerCase()];
      if (shortcut && !event.shiftKey) {
        handled();
        handlers.setTool(shortcut);
      }
    };
    const onKeyUp = (event: globalThis.KeyboardEvent) => {
      if (event.key !== " ") return;
      if (textDraftRef.current === null) event.preventDefault();
      setSpaceHeld(false);
    };
    const onBlur = () => setSpaceHeld(false);
    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("keyup", onKeyUp, { capture: true });
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("keyup", onKeyUp, { capture: true });
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // Zoom keys (+, -, 0, 1, arrows) reach the canvas when nothing else took them.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || textDraftRef.current) return;
    if (zoomableRef.current?.handleKey(event)) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const committed = useMemo(
    () => history.present.map((shape) => <ShapeView key={shape.id} shape={shape} />),
    [history.present],
  );

  const overlay = (view: ImageView, natural: Size) => (
    <>
      <svg
        aria-hidden
        viewBox={`0 0 ${String(natural.width)} ${String(natural.height)}`}
        className="pointer-events-none absolute inset-0 size-full overflow-visible"
      >
        {committed}
        {draft ? <ShapeView shape={draft} /> : null}
      </svg>
      {textDraft ? (
        <input
          key={textDraft.id}
          autoFocus
          aria-label="Text label"
          value={textDraft.value}
          placeholder="Text"
          className="field-sizing-content absolute min-w-8 border-none bg-transparent p-0 font-sans leading-none outline-1 outline-current outline-dashed placeholder:text-current placeholder:opacity-50"
          style={{
            left: textDraft.at.x * view.scale,
            top: textDraft.at.y * view.scale,
            color: textDraft.color,
            fontSize: textDraft.fontSize * view.scale,
            fontWeight: MARKUP_TEXT_WEIGHT,
          }}
          onChange={(event) => {
            const current = textDraftRef.current;
            if (current) setTextDraft({ ...current, value: event.target.value });
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.metaKey || event.ctrlKey) return;
            event.preventDefault();
            commitText();
          }}
          onBlur={() => commitText(textDraft.id)}
        />
      ) : null}
    </>
  );

  const canUndo = canUndoMarkup(history);
  const canRedo = canRedoMarkup(history);

  return (
    <Dialog
      open
      // A stray click outside must not throw the drawing away; Cancel and Escape do.
      disablePointerDismissal
      onOpenChange={(open) => {
        if (!open) cancel();
      }}
    >
      <DialogPopup
        {...composerFloatingLayerProps}
        variant="media"
        showCloseButton={false}
        className="h-full max-h-[92vh] w-[92vw] max-w-[92vw] items-center justify-center"
        style={STAGE_SIZE}
        initialFocus={firstToolRef}
        onKeyDown={onKeyDown}
      >
        <DialogTitle className="sr-only">Mark up {image.name}</DialogTitle>
        <div className="flex max-w-full flex-col items-center gap-3">
          <div
            role="toolbar"
            aria-label="Markup tools"
            className="flex max-w-full flex-wrap items-center justify-center gap-0.5 rounded-lg border border-border bg-popover/95 p-1 text-popover-foreground shadow-lg backdrop-blur-xl"
          >
            {TOOLS.map((entry, index) => (
              <ToolbarTip key={entry.tool} label={entry.label} keys={entry.shortcut}>
                <TooltipTrigger
                  render={
                    <Toggle
                      ref={index === 0 ? firstToolRef : undefined}
                      size="sm"
                      variant="ghost-muted"
                      aria-label={`${entry.label} (${entry.shortcut})`}
                      pressed={tool === entry.tool}
                      onPressedChange={() => setTool(entry.tool)}
                    />
                  }
                >
                  {entry.icon}
                </TooltipTrigger>
              </ToolbarTip>
            ))}
            <ToolbarDivider />
            <div role="radiogroup" aria-label="Color" className="flex items-center">
              {MARKUP_SWATCHES.map((swatch) => (
                <button
                  key={swatch.id}
                  type="button"
                  role="radio"
                  aria-checked={color === swatch.color}
                  aria-label={swatch.label}
                  className={cn(
                    "flex size-7 cursor-pointer items-center justify-center rounded-full outline-none transition-shadow duration-(--motion-duration-fast) ease-standard focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                    color === swatch.color && "ring-2 ring-foreground/70 ring-inset",
                  )}
                  onClick={() => setColor(swatch.color)}
                >
                  <span
                    className="size-4 rounded-full ring-1 ring-foreground/20 ring-inset"
                    style={{ backgroundColor: swatch.color }}
                  />
                </button>
              ))}
            </div>
            <ToolbarDivider />
            <div role="radiogroup" aria-label="Stroke size" className="flex items-center gap-0.5">
              {MARKUP_STROKE_SIZES.map((option) => (
                <Toggle
                  key={option}
                  size="sm"
                  variant="ghost-muted"
                  role="radio"
                  aria-checked={size === option}
                  aria-label={`${SIZE_LABELS[option]} stroke`}
                  pressed={size === option}
                  onPressedChange={() => setSize(option)}
                >
                  {option}
                </Toggle>
              ))}
            </div>
            <ToolbarDivider />
            <ToolbarTip label="Undo" keys={`${MOD}Z`}>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Undo"
                    disabled={!canUndo}
                    onClick={undo}
                  />
                }
              >
                <Undo2Icon />
              </TooltipTrigger>
            </ToolbarTip>
            <ToolbarTip label="Redo" keys={IS_MAC ? "⇧⌘Z" : "Ctrl+Y"}>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Redo"
                    disabled={!canRedo}
                    onClick={redo}
                  />
                }
              >
                <Redo2Icon />
              </TooltipTrigger>
            </ToolbarTip>
            <ToolbarTip label="Clear all">
              <TooltipTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost-destructive"
                    aria-label="Clear all markup"
                    disabled={history.present.length === 0 && !textDraft}
                    onClick={clear}
                  />
                }
              >
                <Trash2Icon />
              </TooltipTrigger>
            </ToolbarTip>
          </div>
          {failed ? (
            <div
              role="alert"
              className="flex h-48 w-full max-w-lg items-center justify-center rounded-lg border border-border/70 bg-black p-6 text-center text-sm text-white"
            >
              This image could not be loaded.
            </div>
          ) : (
            <ZoomableImage
              ref={zoomableRef}
              src={base.previewUrl}
              name={base.name}
              onError={() => setFailed(true)}
              drawing={drawing}
              overlay={overlay}
            />
          )}
          <div className="flex max-w-full items-center gap-1 rounded-lg border border-border bg-popover/95 p-1 text-popover-foreground shadow-lg backdrop-blur-xl">
            <span className="max-w-48 truncate px-2 text-muted-foreground text-xs">
              {image.name}
            </span>
            {error ? (
              <span role="alert" className="px-2 text-destructive-foreground text-xs">
                {error}
              </span>
            ) : null}
            {session ? (
              <Button size="sm" variant="ghost" disabled={busy} onClick={onRevert}>
                Revert to original
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" disabled={busy} onClick={cancel}>
              Cancel
            </Button>
            <ToolbarTip label="Done" keys={`${MOD}↵`}>
              <TooltipTrigger
                render={
                  <Button
                    size="sm"
                    disabled={busy || failed}
                    aria-keyshortcuts={IS_MAC ? "Meta+Enter" : "Control+Enter"}
                    onClick={() => void done()}
                  />
                }
              >
                {busy ? "Saving…" : "Done"}
              </TooltipTrigger>
            </ToolbarTip>
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
