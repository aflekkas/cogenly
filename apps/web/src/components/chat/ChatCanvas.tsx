import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
} from "react";
import { ChatCanvasContext } from "./ChatCanvasContext";
import { resolveChatCanvasLayout, type ChatCanvasDetailsCard } from "./chatCanvasLayout";
import { observeResize } from "../../lib/observeResize";
import { notifyPanelMotion } from "../../lib/panelFlip";
import { readPanelAnimationsActive } from "../../panelAnimations";

// Everything that reads the lane insets (index.css).
const CHAT_LANE_SELECTOR =
  ".messages-timeline-scroll, .chat-composer-lane, .chat-banner-lane, .chat-scroll-to-bottom";
const CHAT_LANE_GLIDE_ID = "chat-lane-glide";
// The details card's own open: 160ms on ease-drawer (ThreadDetailsCard).
const CHAT_LANE_GLIDE_MS = 160;
const CHAT_LANE_GLIDE_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";

/**
 * Glides the lanes by offset from where they were drawn to the committed
 * insets. Call from a layout effect, so the frame that paints the new insets
 * already draws the lanes where they were. An interrupted glide continues
 * from where it has drawn them.
 */
function glideChatLanes(canvas: HTMLElement, offset: number) {
  for (const lane of canvas.querySelectorAll<HTMLElement>(CHAT_LANE_SELECTOR)) {
    let from = offset;
    for (const animation of lane.getAnimations()) {
      if (animation.id !== CHAT_LANE_GLIDE_ID) continue;
      from += new DOMMatrixReadOnly(getComputedStyle(lane).transform).m41;
      animation.cancel();
    }
    if (Math.abs(from) < 0.5) continue;
    const animation = lane.animate(
      [{ transform: `translateX(${from}px)` }, { transform: "translateX(0)" }],
      { duration: CHAT_LANE_GLIDE_MS, easing: CHAT_LANE_GLIDE_EASING },
    );
    animation.id = CHAT_LANE_GLIDE_ID;
  }
  notifyPanelMotion(CHAT_LANE_GLIDE_MS);
}

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
  const reportDetailsCard = useCallback((next: ChatCanvasDetailsCard | null) => {
    setDetailsCard((current) =>
      current?.left === next?.left &&
      current?.right === next?.right &&
      current?.bottom === next?.bottom
        ? current
        : next,
    );
  }, []);
  const [measurements, setMeasurements] = useState({
    width: 0,
    height: 0,
    padding: 48,
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
        padding: Number.parseFloat(styles.paddingLeft),
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
    return {
      container,
      lane: { padding: measurements.padding, minChatWidth: measurements.minChatWidth },
      layout: resolveChatCanvasLayout({
        container,
        padding: measurements.padding,
        maxChatWidth: measurements.maxChatWidth,
        detailsCard,
      }),
      registerTimeline,
      reportDetailsCard,
    };
  }, [measurements, detailsCard, reportDetailsCard]);
  const { layout } = context;
  // A details card that opens or closes where it does not fit beside the
  // centered chat moves the lanes over; they glide instead of jumping. A
  // resize, the first measure, or reduced motion snaps.
  const drawnLaneRef = useRef<{ left: number; card: boolean; width: number } | null>(null);
  useLayoutEffect(() => {
    const drawn = drawnLaneRef.current;
    const next = { left: layout.chat.left, card: detailsCard !== null, width: measurements.width };
    drawnLaneRef.current = next;
    const element = elementRef.current;
    if (!element || !drawn || !readPanelAnimationsActive()) return;
    if (drawn.card === next.card || drawn.width !== next.width) return;
    if (Math.abs(drawn.left - next.left) >= 0.5) glideChatLanes(element, drawn.left - next.left);
  }, [layout.chat.left, detailsCard, measurements.width]);
  return (
    <ChatCanvasContext value={context}>
      <div
        {...props}
        ref={elementRef}
        data-chat-canvas
        className="relative flex min-h-0 min-w-0 flex-1 flex-col"
        style={
          {
            "--chat-timeline-gutter": `${measurements.timelineGutter}px`,
            "--chat-lane-inset-start": `${layout.chat.insetStart}px`,
            "--chat-lane-inset-end": `${layout.chat.insetEnd}px`,
          } as CSSProperties
        }
      >
        <div
          ref={widthProbeRef}
          aria-hidden
          // The chat column's width, for panel motion (panelFlip).
          data-panel-flip-column=""
          className="pointer-events-none invisible absolute h-0 w-(--chat-content-max-width) min-w-[40rem] box-content ps-3 sm:ps-12"
        />
        {children}
      </div>
    </ChatCanvasContext>
  );
}
