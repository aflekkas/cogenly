import { useLayoutEffect, useRef, type RefObject } from "react";
import { observeResize } from "~/lib/observeResize";
import type { AgentMessage } from "./agents.types";

// --ease-spring and --motion-duration-* in index.css.
const SPRING = "cubic-bezier(0.22, 1, 0.36, 1)";
const SEND_MS = 300;
const REPLY_MS = 300;
const REPLY_STAGGER_MS = 60;
const GROW_MS = 160;
const REDUCED = "(prefers-reduced-motion: reduce)";

/** Where a text left the composer, taken as it was sent, so its bubble can arrive from there. */
export interface SendOrigin {
  rect: DOMRect;
  messageId: string;
}

/**
 * Texting-grade motion for an agent conversation, on the rows the owner just
 * caused: a sent text travels from the composer into its bubble (a FLIP on the
 * composer's rect), a reply rises out of the typing bubble and consecutive replies
 * stagger, a streaming bubble grows smoothly, and the transcript follows the
 * newest bubble. Hydration, paginated history and remounts stay still. Rows under
 * `keep` (a reply that took over the typing bubble's element) are left alone so
 * the morph is theirs. Opacity only under reduced motion.
 */
export function useMessageMotion(
  conversation: {
    key: string;
    messages: ReadonlyArray<AgentMessage>;
    requests: ReadonlyArray<{ id: string }>;
    hasMoreMessages?: boolean | undefined;
  },
  busy: boolean,
  /** Rows after the last message, such as a pending model switch or the typing bubble, that also keep the view pinned. */
  trailing: string | null = null,
  options: {
    keep?: ReadonlySet<string> | undefined;
    sendOrigin?: RefObject<SendOrigin | null> | undefined;
  } = {},
) {
  const { key, messages, requests, hasMoreMessages } = conversation;
  const { keep, sendOrigin } = options;
  const scroll = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const following = useRef(false);
  const viewportHeight = useRef(0);
  const bubbleHeights = useRef(new Map<string, number>());
  const previous = useRef<{
    key: string;
    hydrated: boolean;
    ids: Set<string>;
    lastId: string | undefined;
    firstId: string | undefined;
    height: number;
    busy: boolean;
    trailing: string | null;
  } | null>(null);
  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const before = previous.current;
    const reset = before?.key !== key;
    const hydrated = hasMoreMessages !== undefined;
    const ids = new Set([
      ...messages.map((message) => message.id),
      ...requests.map((request) => request.id),
    ]);
    const reduced = window.matchMedia(REDUCED).matches;
    const lastIndex = messages.findIndex((message) => message.id === before?.lastId);
    const appended = messages.filter(
      (message, index) =>
        !reset &&
        !before?.ids.has(message.id) &&
        !keep?.has(message.id) &&
        ((before?.hydrated && index > lastIndex) || message.optimistic),
    );
    const appendedRequests =
      !reset && before?.hydrated ? requests.filter((request) => !before.ids.has(request.id)) : [];
    const rowFor = (id: string) =>
      element.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
    let replyIndex = 0;
    for (const message of appended) {
      const row = rowFor(message.id);
      const bubble = row?.querySelector<HTMLElement>(".agent-bubble") ?? row;
      if (!row || !bubble) continue;
      if (reduced) {
        row.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: SPRING });
        continue;
      }
      const origin = sendOrigin?.current;
      if (sendOrigin && message.role === "user" && origin?.messageId === message.id) {
        // The text travels from where it was typed into its bubble, filling in as it lands.
        sendOrigin.current = null;
        const to = bubble.getBoundingClientRect();
        const dx = origin.rect.left - to.left;
        const dy = origin.rect.top - to.top;
        const sx = Math.max(0.2, Math.min(1.5, origin.rect.width / Math.max(to.width, 1)));
        const sy = Math.max(0.2, Math.min(1.5, origin.rect.height / Math.max(to.height, 1)));
        bubble.animate(
          [
            {
              transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`,
              opacity: 0.55,
              transformOrigin: "top left",
            },
            { transform: "none", opacity: 1, transformOrigin: "top left" },
          ],
          { duration: SEND_MS, easing: SPRING },
        );
        continue;
      }
      if (message.role === "user") {
        bubble.animate(
          [
            { opacity: 0, transform: "translateY(12px) scale(0.96)" },
            { opacity: 1, transform: "none" },
          ],
          { duration: SEND_MS, easing: SPRING },
        );
        continue;
      }
      // A reply rises into place; a burst of replies lands one after another.
      bubble.animate(
        [
          { opacity: 0, transform: "translateY(8px) scale(0.94)" },
          { opacity: 1, transform: "none" },
        ],
        {
          duration: REPLY_MS,
          easing: SPRING,
          delay: replyIndex * REPLY_STAGGER_MS,
          fill: "backwards",
        },
      );
      replyIndex += 1;
    }
    for (const request of appendedRequests) {
      rowFor(request.id)?.animate(
        reduced
          ? [{ opacity: 0 }, { opacity: 1 }]
          : [
              { opacity: 0, transform: "translateY(8px)" },
              { opacity: 1, transform: "none" },
            ],
        { duration: REPLY_MS, easing: SPRING },
      );
    }
    // Streaming text grows its bubble smoothly rather than in steps.
    const heights = bubbleHeights.current;
    const live = new Set<string>();
    for (const message of messages) {
      if (!message.streaming) continue;
      live.add(message.id);
      const bubble = rowFor(message.id)?.querySelector<HTMLElement>(".agent-bubble");
      if (!bubble) continue;
      const height = bubble.offsetHeight;
      const last = heights.get(message.id);
      heights.set(message.id, height);
      if (!reduced && last !== undefined && last !== height && !keep?.has(message.id))
        bubble.animate([{ height: `${last}px` }, { height: `${height}px` }], {
          duration: GROW_MS,
          easing: SPRING,
        });
    }
    for (const id of heights.keys()) if (!live.has(id)) heights.delete(id);
    const prepended =
      !reset &&
      before?.hydrated &&
      before.firstId !== messages[0]?.id &&
      before.firstId !== undefined &&
      ids.has(before.firstId);
    if (reset || (!before?.hydrated && hydrated)) {
      element.scrollTop = element.scrollHeight;
      atBottom.current = true;
      following.current = false;
    } else if (prepended && before) {
      element.scrollTop += element.scrollHeight - before.height;
    } else if (
      atBottom.current &&
      (element.scrollHeight !== before?.height ||
        busy !== before?.busy ||
        trailing !== before?.trailing)
    ) {
      following.current = !reduced;
      element.scrollTo({ top: element.scrollHeight, behavior: reduced ? "instant" : "smooth" });
    }
    previous.current = {
      key,
      hydrated,
      ids,
      firstId: messages[0]?.id,
      lastId: messages.at(-1)?.id,
      height: element.scrollHeight,
      busy,
      trailing,
    };
  }, [key, messages, requests, hasMoreMessages, busy, trailing, keep, sendOrigin]);
  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element) return;
    viewportHeight.current = element.clientHeight;
    return observeResize(element, () => {
      viewportHeight.current = element.clientHeight;
      if (!atBottom.current) return;
      const reduced = window.matchMedia(REDUCED).matches;
      following.current = !reduced;
      element.scrollTo({ top: element.scrollHeight, behavior: reduced ? "instant" : "smooth" });
    });
  }, []);
  const onScroll = () => {
    const element = scroll.current;
    if (!element) return;
    if (element.clientHeight !== viewportHeight.current) return;
    const gap = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (following.current && gap > 1) return;
    following.current = false;
    atBottom.current = gap < 80;
  };
  const stopFollowing = () => {
    const element = scroll.current;
    if (element && following.current)
      element.scrollTo({ top: element.scrollTop, behavior: "instant" });
    following.current = false;
    // A deliberate scroll away takes priority, even while still within the threshold.
    atBottom.current = false;
  };
  return { scroll, onScroll, stopFollowing };
}
