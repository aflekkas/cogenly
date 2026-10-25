"use client";

import type { DesktopPreviewPointerEvent } from "@cogenly/contracts";
import { MousePointer2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { useBrowserPointerStore } from "~/browser/browserPointerStore";
import { useBrowserSurfaceStore } from "~/browser/browserSurfaceStore";
import { cn } from "~/lib/utils";

import {
  AGENT_TARGET_OUTLINE_MS,
  agentBrowserCursorOpacity,
  placeAgentTarget,
  type AgentSurfaceFrame,
  type AgentSurfaceRect,
  type BrowserController,
} from "./agentBrowserCursorLogic";

const CURSOR_ACTIVE_MS = 700;

export function AgentBrowserCursor(props: {
  readonly tabId: string;
  readonly zoomFactor: number;
  readonly controller: BrowserController;
}) {
  const { tabId, zoomFactor, controller } = props;
  const event = useBrowserPointerStore((state) => state.byTabId[tabId] ?? null);
  const content = useBrowserSurfaceStore((state) => state.byTabId[tabId]?.content ?? null);

  if (!event) return null;

  return (
    <AgentBrowserCursorEvent
      event={event}
      content={content}
      zoomFactor={zoomFactor}
      controller={controller}
    />
  );
}

interface DesktopSurfaceContent {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
  readonly scrollLeft: number;
  readonly scrollTop: number;
}

/**
 * Maps a desktop tab's page pixels onto its surface: the guest's zoom and
 * presentation scale, then its offset and scroll within the surface.
 */
export function desktopSurfaceFrame(
  content: DesktopSurfaceContent | null,
  zoomFactor: number,
): AgentSurfaceFrame {
  const scale = zoomFactor * (content?.scale ?? 1);
  return {
    offsetX: (content?.x ?? 0) - (content?.scrollLeft ?? 0),
    offsetY: (content?.y ?? 0) - (content?.scrollTop ?? 0),
    scaleX: scale,
    scaleY: scale,
  };
}

function AgentBrowserCursorEvent(props: {
  readonly event: DesktopPreviewPointerEvent;
  readonly content: DesktopSurfaceContent | null;
  readonly zoomFactor: number;
  readonly controller: BrowserController;
}) {
  const { event, content, zoomFactor, controller } = props;
  const placed = placeAgentTarget(event, desktopSurfaceFrame(content, zoomFactor));
  return (
    <AgentCursorMark
      phase={event.phase}
      sequence={event.sequence}
      left={placed.left}
      top={placed.top}
      outline={placed.outline}
      controller={controller}
    />
  );
}

/**
 * The agent's pointer at a surface position; it fades once the agent stops
 * acting. An `outline` briefly marks the element it arrived on, then fades.
 */
export function AgentCursorMark(props: {
  readonly phase: "move" | "click";
  readonly sequence: number;
  readonly left: number;
  readonly top: number;
  readonly outline?: AgentSurfaceRect | null;
  readonly controller: BrowserController;
  /** A smaller cursor for thumbnails. */
  readonly compact?: boolean;
}) {
  const { phase, sequence, left, top, outline = null, controller, compact = false } = props;
  const [inactiveSequence, setInactiveSequence] = useState<number | null>(null);
  const active = inactiveSequence !== sequence;
  // The outline outlives the event that drew it, so the click that follows can't cut its fade.
  const [flash, setFlash] = useState<{
    readonly sequence: number;
    readonly rect: AgentSurfaceRect;
  } | null>(null);
  if (outline && flash?.sequence !== sequence) setFlash({ sequence, rect: outline });

  useEffect(() => {
    const timeout = window.setTimeout(() => setInactiveSequence(sequence), CURSOR_ACTIVE_MS);
    return () => window.clearTimeout(timeout);
  }, [sequence]);

  return (
    <>
      {flash ? <AgentTargetOutline key={flash.sequence} rect={flash.rect} /> : null}
      <AgentCursorPointer
        phase={phase}
        sequence={sequence}
        left={left}
        top={top}
        opacity={agentBrowserCursorOpacity(active, controller)}
        compact={compact}
      />
    </>
  );
}

/** Holds, then fades out once; it stays transparent until the next outline replaces it. */
function AgentTargetOutline(props: { readonly rect: AgentSurfaceRect }) {
  const { rect } = props;
  const fade = useCallback((element: HTMLDivElement | null) => {
    if (!element || typeof element.animate !== "function") return;
    const animation = element.animate(
      [{ opacity: 1 }, { opacity: 1, offset: 0.3 }, { opacity: 0 }],
      {
        duration: AGENT_TARGET_OUTLINE_MS,
        easing: "ease-out",
        fill: "forwards",
      },
    );
    return () => animation.cancel();
  }, []);
  return (
    <div
      ref={fade}
      aria-hidden="true"
      data-agent-target-outline
      className="pointer-events-none absolute z-40 rounded-sm border-2 border-brand-accent bg-brand-accent/8"
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
    />
  );
}

function AgentCursorPointer(props: {
  readonly phase: "move" | "click";
  readonly sequence: number;
  readonly left: number;
  readonly top: number;
  readonly opacity: number;
  readonly compact: boolean;
}) {
  const { phase, sequence, left, top, opacity, compact } = props;
  return (
    <div
      className="pointer-events-none absolute left-0 top-0 z-40 transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none"
      style={{ opacity, transform: `translate3d(${left}px, ${top}px, 0)` }}
      aria-hidden="true"
      data-agent-browser-cursor
    >
      {phase === "click" ? (
        <span
          key={sequence}
          className={cn(
            "absolute animate-status-ping rounded-full bg-brand-accent/25 motion-reduce:animate-none",
            compact ? "left-0 top-0 size-2.5" : "left-0.5 top-0.5 size-4",
          )}
        />
      ) : null}
      <MousePointer2
        className={cn(
          "relative fill-background text-brand-accent drop-shadow-sm",
          compact
            ? "size-3 -translate-x-px -translate-y-px"
            : "size-5 -translate-x-0.5 -translate-y-0.5",
        )}
        strokeWidth={2}
      />
    </div>
  );
}
