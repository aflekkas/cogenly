import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
} from "react";
import { ChatCanvasContext } from "./ChatCanvasContext";
import {
  resolveChatCanvasLayout,
  resolveChatLaneGutter,
  type ChatCanvasDetailsCard,
} from "./chatCanvasLayout";
import { observeResize } from "../../lib/observeResize";
import { capturePanelFlip, playPanelFlip, type PanelFlipSnapshot } from "../../lib/panelFlip";
import { PANEL_ANIMATION_DURATION, readPanelAnimationsActive } from "../../panelAnimations";
import { useStableCallback } from "../../hooks/useStableCallback";

/**
 * Owns the available conversation space. Cards only report where they sit; the
 * canvas decides when chat moves over to make room for them.
 */
export function ChatCanvas({
  children,
  ...props
}: Omit<ComponentProps<"div">, "className" | "style" | "ref">) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const widthProbeRef = useRef<HTMLDivElement | null>(null);
  const [timelineElement, registerTimeline] = useState<HTMLElement | null>(null);
  const [detailsCard, setDetailsCard] = useState<ChatCanvasDetailsCard | null>(null);
  const reportedCardRef = useRef<ChatCanvasDetailsCard | null>(null);
  const laneSnapshotRef = useRef<PanelFlipSnapshot | null>(null);
  const reportDetailsCard = useStableCallback((next: ChatCanvasDetailsCard | null) => {
    // Capture before the card changes the lane insets, not after the new
    // layout has painted. Ordinary resize/drag reports never start a glide.
    if ((reportedCardRef.current === null) !== (next === null) && readPanelAnimationsActive()) {
      laneSnapshotRef.current = capturePanelFlip(elementRef.current);
    }
    reportedCardRef.current = next;
    setDetailsCard((current) =>
      current?.left === next?.left &&
      current?.right === next?.right &&
      current?.bottom === next?.bottom
        ? current
        : next,
    );
  });
  const [measurements, setMeasurements] = useState({
    width: 0,
    height: 0,
    maxChatWidth: 768,
    minChatWidth: 640,
    timelineGutter: 0,
  });
  useLayoutEffect(() => {
    const element = elementRef.current;
    const probe = widthProbeRef.current;
    if (!element || !probe) return;
    const measure = () => {
      const styles = getComputedStyle(probe);
      const next = {
        width: element.clientWidth,
        height: element.clientHeight,
        maxChatWidth: Number.parseFloat(styles.width),
        minChatWidth: Number.parseFloat(styles.minWidth),
        timelineGutter: timelineElement
          ? (timelineElement.offsetWidth - timelineElement.clientWidth) / 2
          : 0,
      };
      setMeasurements((current) =>
        Object.keys(next).every(
          (key) => current[key as keyof typeof current] === next[key as keyof typeof next],
        )
          ? current
          : next,
      );
    };
    measure();
    const observed: Element[] = [element, probe];
    if (timelineElement) observed.push(timelineElement);
    return observeResize(observed, measure);
  }, [timelineElement]);
  const context = useMemo(() => {
    const container = { width: measurements.width, height: measurements.height };
    const padding = resolveChatLaneGutter(measurements.width);
    return {
      container,
      lane: { padding, minChatWidth: measurements.minChatWidth },
      layout: resolveChatCanvasLayout({
        container,
        padding,
        maxChatWidth: measurements.maxChatWidth,
        detailsCard,
      }),
      detailsCard,
      registerTimeline,
      reportDetailsCard,
    };
  }, [measurements, detailsCard, reportDetailsCard]);
  const { layout } = context;
  useLayoutEffect(() => {
    const snapshot = laneSnapshotRef.current;
    laneSnapshotRef.current = null;
    if (snapshot) playPanelFlip(snapshot, PANEL_ANIMATION_DURATION, { contain: true });
  });
  return (
    <ChatCanvasContext value={context}>
      <div
        {...props}
        ref={elementRef}
        data-chat-canvas
        className="relative flex min-h-0 min-w-0 flex-1 flex-col"
        style={
          {
            // Before the first measure the lanes keep index.css's fallbacks.
            ...(measurements.width > 0 && { "--chat-gutter": `${context.lane.padding}px` }),
            "--chat-timeline-gutter": `${measurements.timelineGutter}px`,
            "--chat-lane-inset-start": `${layout.chat.insetStart}px`,
            "--chat-lane-inset-end": `${layout.chat.insetEnd}px`,
          } as CSSProperties
        }
      >
        <div
          ref={widthProbeRef}
          aria-hidden
          // The chat column's width and gutter, for panel motion (panelFlip).
          data-panel-flip-column=""
          className="pointer-events-none invisible absolute h-0 w-(--chat-content-max-width) min-w-[40rem] box-content ps-(--chat-gutter)"
        />
        {children}
      </div>
    </ChatCanvasContext>
  );
}
