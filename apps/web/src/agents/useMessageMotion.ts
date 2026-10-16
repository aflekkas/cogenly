import { useLayoutEffect, useRef } from "react";
import { observeResize } from "~/lib/observeResize";
import type { AgentContact } from "./agents.types";
import { agentContactKey } from "./agents.logic";

/** Animate only appended live messages; hydration and paginated history stay still. */
export function useMessageMotion(
  agent: AgentContact,
  busy: boolean,
  /** Rows after the last message, such as a pending model switch, that also keep the view pinned. */
  trailing: string | null = null,
) {
  const key = agentContactKey(agent);
  const { messages, requests, hasMoreMessages } = agent;
  const scroll = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const following = useRef(false);
  const viewportHeight = useRef(0);
  const previous = useRef<{
    key: string;
    hydrated: boolean;
    ids: Set<string>;
    lastId: string | undefined;
    firstId: string | undefined;
    height: number;
    busy: boolean;
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
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const lastIndex = messages.findIndex((message) => message.id === before?.lastId);
    const appended = new Set(
      messages
        .filter(
          (message, index) =>
            !reset &&
            !before?.ids.has(message.id) &&
            ((before?.hydrated && index > lastIndex) || message.optimistic),
        )
        .map((message) => message.id),
    );
    if (!reset && before?.hydrated) {
      for (const request of requests) {
        if (!before.ids.has(request.id)) appended.add(request.id);
      }
    }
    if (!reduced && appended.size) {
      for (const row of element.querySelectorAll<HTMLElement>("[data-message-id]")) {
        if (!appended.has(row.dataset.messageId!)) continue;
        row.animate(
          [
            { opacity: 0, transform: "translateY(10px)" },
            { opacity: 1, transform: "translateY(0)" },
          ],
          { duration: 260, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
        );
      }
    }
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
      (element.scrollHeight !== before?.height || busy !== before?.busy)
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
    };
  }, [key, messages, requests, hasMoreMessages, busy, trailing]);
  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element) return;
    viewportHeight.current = element.clientHeight;
    return observeResize(element, () => {
      viewportHeight.current = element.clientHeight;
      if (!atBottom.current) return;
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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
