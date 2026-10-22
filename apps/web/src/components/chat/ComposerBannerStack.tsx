import { InfoIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ComposerBanner, type ComposerBannerVariant } from "./ComposerBanner";
import { observeResize } from "~/lib/observeResize";
import { PANEL_MOTION_EASING } from "~/lib/panelFlip";

// Match the duration-220 exit transition before removing a dismissed notice.
const DISMISS_TRANSITION_MS = 220;
// The attached notice opens, closes and swaps on this timing.
const NOTICE_PRESENCE_MS = 200;
const NOTICE_PRESENCE_EASING = PANEL_MOTION_EASING;
// Share of a rise or sink spent fading, so the strip reads as a solid surface
// sliding behind the composer rather than a floating fade.
const SOLID_SURFACE_FADE_SHARE = 0.4;

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export interface ComposerBannerStackItem {
  readonly id: string;
  readonly variant: ComposerBannerVariant;
  readonly priority?: "urgent" | "activity" | "notice";
  readonly icon: ReactNode;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly children?: ReactNode;
  readonly actions?: ReactNode;
  readonly dismissLabel?: string;
  readonly onDismiss?: () => void;
}

export type ComposerBannerStackContent = Pick<
  ComposerBannerStackItem,
  "id" | "variant" | "priority"
> & { readonly content: ReactNode };

type ComposerBannerStackEntry = ComposerBannerStackItem | ComposerBannerStackContent;

function bannerPriority(item: ComposerBannerStackEntry) {
  if (item.priority === "activity") {
    return 0;
  }
  if (item.priority === "urgent" || item.variant === "error" || item.variant === "warning") {
    return 1;
  }
  return 2;
}

interface ComposerBannerStackProps {
  readonly className?: string;
  readonly items: ReadonlyArray<ComposerBannerStackEntry>;
  /** Attachments that sit between the stacked notices and the front item, such as the queue.
      The stacked notices peek above the whole column, never from between two attachments. */
  readonly attachedAbove?: ReactNode;
}

export function ComposerBannerStack({ className, items, attachedAbove }: ComposerBannerStackProps) {
  const [stackExpanded, setStackExpanded] = useState(false);
  const noticesRef = useRef<HTMLDivElement>(null);
  const peekRef = useRef<HTMLButtonElement>(null);
  const expandedItemsRef = useRef<HTMLDivElement>(null);
  const pendingFocusRef = useRef<"peek" | "notice" | null>(null);
  const expandedItemsId = useId();
  const [requestedExitingItemId, setExitingItemId] = useState<string | null>(null);
  const dismissTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exitingItemId =
    requestedExitingItemId !== null && items.some((item) => item.id === requestedExitingItemId)
      ? requestedExitingItemId
      : null;

  useEffect(() => {
    return () => {
      if (dismissTimeoutRef.current) {
        clearTimeout(dismissTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (items.length < 2) setStackExpanded(false);
  }, [items.length]);

  useLayoutEffect(() => {
    if (stackExpanded && pendingFocusRef.current === "notice") {
      pendingFocusRef.current = null;
      const firstControl = expandedItemsRef.current?.querySelector<HTMLElement>(
        'button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]',
      );
      (firstControl ?? expandedItemsRef.current)?.focus({ preventScroll: true });
    } else if (!stackExpanded && pendingFocusRef.current === "peek") {
      pendingFocusRef.current = null;
      peekRef.current?.focus({ preventScroll: true });
    }
  }, [stackExpanded]);

  // Activity stays attached. Urgency and severity only order the notices behind it.
  const orderedItems = items.toSorted((a, b) => bannerPriority(a) - bannerPriority(b));
  const frontItem = orderedItems[0];

  // The front notice that just went away, kept while it fades: under the next
  // one (a cross-fade) or in the collapsing frame when none follows.
  const [leavingFront, setLeavingFront] = useState<ComposerBannerStackEntry | null>(null);
  const lastFrontRef = useRef(frontItem);
  useLayoutEffect(() => {
    const lastFront = lastFrontRef.current;
    lastFrontRef.current = frontItem;
    if (lastFront && lastFront.id !== frontItem?.id) setLeavingFront(lastFront);
  });
  const clearLeavingFront = useCallback(() => setLeavingFront(null), []);
  // A notice already up when the composer mounts (a thread switch) is just there.
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
  }, []);
  // A dismissed notice has already slid out; it must not reappear while the frame closes.
  const leavingFrontDismissed = leavingFront !== null && requestedExitingItemId === leavingFront.id;

  if (!frontItem && !leavingFront) {
    return (
      <>
        {null}
        {attachedAbove}
        {null}
      </>
    );
  }
  const stackedItems = orderedItems.slice(1);
  const hasStack = stackedItems.length > 0;
  const showCollapsedStackCap = hasStack && exitingItemId !== frontItem?.id;
  const firstStackedItem = stackedItems[0];

  const requestDismiss = (item: ComposerBannerStackEntry) => {
    if (!("onDismiss" in item) || !item.onDismiss || exitingItemId) {
      return;
    }
    setExitingItemId(item.id);
    if (dismissTimeoutRef.current) {
      clearTimeout(dismissTimeoutRef.current);
    }
    dismissTimeoutRef.current = setTimeout(() => {
      dismissTimeoutRef.current = null;
      item.onDismiss?.();
    }, DISMISS_TRANSITION_MS);
  };

  return (
    <>
      {hasStack ? (
        <div
          ref={noticesRef}
          data-chat-composer-collapsed-controls="true"
          className={cn("relative z-20 min-h-3", stackExpanded && "z-50")}
          onPointerEnter={(event) => {
            if (event.pointerType === "touch") return;
            if (document.activeElement === peekRef.current) {
              pendingFocusRef.current = "notice";
            }
            setStackExpanded(true);
          }}
          onPointerLeave={(event) => {
            if (!event.currentTarget.contains(document.activeElement)) setStackExpanded(false);
          }}
          onBlurCapture={(event) => {
            if (
              !event.currentTarget.contains(event.relatedTarget) &&
              !event.currentTarget.matches(":hover")
            ) {
              setStackExpanded(false);
            }
          }}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || !stackExpanded) return;
            event.preventDefault();
            event.stopPropagation();
            pendingFocusRef.current = "peek";
            setStackExpanded(false);
          }}
        >
          {showCollapsedStackCap && firstStackedItem ? (
            <ComposerBanner.Peek
              ref={peekRef}
              variant={firstStackedItem.variant}
              aria-label="Show other notices"
              aria-expanded={stackExpanded}
              aria-controls={expandedItemsId}
              aria-hidden={stackExpanded || undefined}
              tabIndex={stackExpanded ? -1 : 0}
              onClick={(event) => {
                event.currentTarget.focus({ preventScroll: true });
                pendingFocusRef.current = "notice";
                setStackExpanded(true);
              }}
              className={cn(stackExpanded && "pointer-events-none invisible opacity-0")}
            />
          ) : null}
          <div
            id={expandedItemsId}
            ref={expandedItemsRef}
            role="group"
            aria-label="Other notices"
            tabIndex={-1}
            data-composer-banner-stack-expanded-items="true"
            className={cn(
              "grid transition-[grid-template-rows] duration-150 ease-out focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
              stackExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
            )}
          >
            <div className="min-h-0 overflow-hidden">
              <div
                className={cn(
                  "space-y-2 pb-2 transition-opacity duration-150 ease-out",
                  stackExpanded
                    ? "pointer-events-auto visible opacity-100"
                    : "pointer-events-none invisible opacity-0",
                )}
              >
                {stackedItems.map((item) => (
                  <div
                    key={item.id}
                    className={cn(
                      "transition-opacity duration-220 ease-in",
                      exitingItemId === item.id ? "pointer-events-none opacity-0" : "opacity-100",
                    )}
                  >
                    <ComposerBannerStackAlert
                      item={item}
                      attached={false}
                      exiting={exitingItemId === item.id}
                      onDismissRequest={() => requestDismiss(item)}
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}
      {attachedAbove}
      <ComposerBanner.Attachment
        className={className}
        data-composer-banner-drawer="true"
        data-chat-composer-collapsed-controls="true"
      >
        <NoticePresenceFrame
          open={frontItem !== undefined}
          swapKey={frontItem?.id ?? null}
          animateMountRef={mountedRef}
          onClosed={clearLeavingFront}
        >
          {frontItem ? (
            <>
              {leavingFront ? (
                <LeavingNotice key={leavingFront.id} onDone={clearLeavingFront}>
                  <div className={cn(leavingFrontDismissed && "opacity-0")}>
                    <ComposerBannerStackAlert
                      item={leavingFront}
                      attached
                      exiting
                      onDismissRequest={() => {}}
                    />
                  </div>
                </LeavingNotice>
              ) : null}
              {renderFrontItem(frontItem)}
            </>
          ) : leavingFront ? (
            <div aria-hidden inert className={cn(leavingFrontDismissed && "opacity-0")}>
              <ComposerBannerStackAlert
                item={leavingFront}
                attached
                exiting
                onDismissRequest={() => {}}
              />
            </div>
          ) : null}
        </NoticePresenceFrame>
      </ComposerBanner.Attachment>
    </>
  );

  function renderFrontItem(frontItem: ComposerBannerStackEntry) {
    return (
      <div
        key={frontItem.id}
        data-notice-current=""
        className={cn(
          "relative z-10 transition-opacity duration-220 ease-in",
          exitingItemId === frontItem.id ? "pointer-events-none opacity-0" : "opacity-100",
        )}
        onPointerDownCapture={() => {
          setStackExpanded(false);
          const activeElement = document.activeElement;
          if (activeElement instanceof HTMLElement && noticesRef.current?.contains(activeElement)) {
            activeElement.blur();
          }
        }}
      >
        <ComposerBannerStackAlert
          item={frontItem}
          attached
          exiting={exitingItemId === frontItem.id}
          onDismissRequest={() => requestDismiss(frontItem)}
        />
      </div>
    );
  }
}

/**
 * The attached notice's frame. It grows from no height with the content pinned
 * to its top, so the strip rises out from behind the composer's top edge (the
 * frame clips at the seam) and sinks back behind it when the last notice goes.
 * The surface stays solid: opacity only settles in early on the way up and
 * late on the way down. It eases
 * between two notices' heights on a swap (the new one fading in over the old,
 * see LeavingNotice). Web Animations, so an interrupted change starts from
 * where the frame is. Reduced motion fades only. The queue tray and its rows
 * open and close on it too.
 */
export function NoticePresenceFrame({
  open,
  swapKey,
  animateMountRef,
  onClosed,
  children,
}: {
  readonly open: boolean;
  /** False while the stack is mounting, so a notice already up is just there. */
  readonly animateMountRef: { readonly current: boolean };
  readonly swapKey: string | null;
  readonly onClosed: () => void;
  readonly children: ReactNode;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const motionRef = useRef<Animation | null>(null);
  const settledHeightRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const mounting = settledHeightRef.current === null;
    const running = motionRef.current;
    const current = getComputedStyle(frame);
    // A close starts from the height it is drawn at now: held content may have
    // resized since it settled (a disclosure inside it opened or closed).
    const fromHeight =
      running || (!open && !mounting)
        ? frame.getBoundingClientRect().height
        : mounting
          ? 0
          : settledHeightRef.current!;
    const fromOpacity = running ? Number(current.opacity) : mounting ? 0 : 1;
    running?.cancel();
    motionRef.current = null;
    frame.style.overflow = "";
    const naturalHeight = frame.getBoundingClientRect().height;
    settledHeightRef.current = naturalHeight;

    const timing: KeyframeAnimationOptions = {
      duration: NOTICE_PRESENCE_MS,
      easing: NOTICE_PRESENCE_EASING,
      fill: open ? "none" : "forwards",
    };
    const reducedMotion = prefersReducedMotion();
    if (!open) {
      const motion = frame.animate(
        reducedMotion
          ? [{ opacity: fromOpacity }, { opacity: 0 }]
          : [
              { height: `${fromHeight}px`, opacity: fromOpacity },
              { opacity: fromOpacity, offset: 1 - SOLID_SURFACE_FADE_SHARE },
              { height: "0px", opacity: 0 },
            ],
        timing,
      );
      if (!reducedMotion) frame.style.overflow = "clip";
      motionRef.current = motion;
      motion.finished.then(
        () => {
          motionRef.current = null;
          settledHeightRef.current = null;
          onClosed();
        },
        () => {},
      );
      return;
    }
    const swapping = !mounting && !running && fromHeight !== naturalHeight;
    if ((mounting && !animateMountRef.current) || (!mounting && !running && !swapping)) return;
    if (swapping) {
      frame
        .querySelector<HTMLElement>("[data-notice-current]")
        ?.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: NOTICE_PRESENCE_MS,
          easing: NOTICE_PRESENCE_EASING,
        });
    }
    const motion = frame.animate(
      reducedMotion
        ? [{ opacity: fromOpacity }, { opacity: 1 }]
        : [
            { height: `${fromHeight}px`, opacity: fromOpacity },
            { opacity: 1, offset: SOLID_SURFACE_FADE_SHARE },
            { height: `${naturalHeight}px`, opacity: 1 },
          ],
      timing,
    );
    if (!reducedMotion) frame.style.overflow = "clip";
    motionRef.current = motion;
    motion.finished.then(
      () => {
        motionRef.current = null;
        frame.style.overflow = "";
      },
      () => {},
    );
  }, [animateMountRef, onClosed, open, swapKey]);

  useEffect(() => () => motionRef.current?.cancel(), []);

  return (
    <div ref={frameRef} className="relative">
      {children}
    </div>
  );
}

interface HeldAttachment {
  readonly key: string | null;
  readonly node: ReactNode;
}

/**
 * One composer attachment that rises out from behind the composer when shown,
 * sinks back when hidden (still drawing its last content, inert), and keeps
 * its surface while the content changes: a new `swapKey` crossfades the old
 * content out over the new one and eases between their heights. Content that
 * changes under the same key just updates in place, so rapid updates never
 * retrigger the rise.
 */
export function AttachmentPresence({
  show,
  swapKey = null,
  children,
  ...attachmentProps
}: Omit<ComponentProps<typeof ComposerBanner.Attachment>, "children"> & {
  readonly show: boolean;
  readonly swapKey?: string | null;
  readonly children: ReactNode;
}) {
  const [held, setHeld] = useState<HeldAttachment | null>(() =>
    show ? { key: swapKey, node: children } : null,
  );
  const [leaving, setLeaving] = useState<HeldAttachment | null>(null);
  if (show && (held === null || held.node !== children || held.key !== swapKey)) {
    if (held !== null && held.key !== swapKey) setLeaving(held);
    setHeld({ key: swapKey, node: children });
  }
  // Whatever is up when the composer mounts (a thread switch) is just there.
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
  }, []);
  const clearHeld = useCallback(() => {
    setHeld(null);
    setLeaving(null);
  }, []);
  const clearLeaving = useCallback(() => setLeaving(null), []);

  if (held === null) return null;
  return (
    <ComposerBanner.Attachment {...attachmentProps}>
      <NoticePresenceFrame
        open={show}
        swapKey={held.key}
        animateMountRef={mountedRef}
        onClosed={clearHeld}
      >
        {leaving && show ? (
          <LeavingNotice key={leaving.key ?? ""} onDone={clearLeaving}>
            {leaving.node}
          </LeavingNotice>
        ) : null}
        <div
          key={held.key ?? ""}
          data-notice-current=""
          className="relative z-10"
          aria-hidden={show ? undefined : true}
          inert={!show}
        >
          {held.node}
        </div>
      </NoticePresenceFrame>
    </ComposerBanner.Attachment>
  );
}

/** The previous front notice, fading out under the next one. */
function LeavingNotice({
  onDone,
  children,
}: {
  readonly onDone: () => void;
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const motion = element.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: NOTICE_PRESENCE_MS,
      easing: NOTICE_PRESENCE_EASING,
      fill: "forwards",
    });
    motion.finished.then(
      () => onDone(),
      () => {},
    );
    return () => motion.cancel();
  }, [onDone]);
  return (
    <div
      ref={ref}
      aria-hidden
      inert
      className="pointer-events-none absolute inset-x-0 bottom-0 z-20"
    >
      {children}
    </div>
  );
}

/** Keep full descriptions reachable only when their inline copy is clipped. */
function NoticeDescription({ children }: { children: ReactNode }) {
  const descriptionRef = useRef<HTMLSpanElement>(null);
  const detailsRef = useRef<HTMLButtonElement>(null);
  const [showDetails, setShowDetails] = useState(false);

  useLayoutEffect(() => {
    const description = descriptionRef.current;
    if (!description) return;
    const measure = () => {
      // Ignore the space taken by the details button itself so it cannot
      // sustain its own overflow after the description would otherwise fit.
      const recoveredWidth = detailsRef.current ? detailsRef.current.offsetWidth + 4 : 0;
      const hidden = getComputedStyle(description).position === "absolute";
      setShowDetails(
        hidden ||
          [description, ...description.querySelectorAll("*")].some(
            (element) => element.scrollWidth > element.clientWidth + recoveredWidth,
          ),
      );
    };
    measure();
    const stopObserving = observeResize(description, measure);
    // A child can reveal new text without resizing its clipped box.
    const mutations = new MutationObserver(measure);
    mutations.observe(description, { childList: true, subtree: true, characterData: true });
    return () => {
      stopObserving();
      mutations.disconnect();
    };
  }, []);

  return (
    <span className="contents">
      <span
        ref={descriptionRef}
        className="w-0 min-w-0 grow truncate text-muted-foreground @max-[400px]:sr-only"
      >
        {children}
      </span>
      {showDetails ? (
        <Popover>
          <PopoverTrigger
            openOnHover
            render={
              <Button
                ref={detailsRef}
                size="icon-xs"
                variant="ghost-muted"
                aria-label="Show notice details"
                className="flex-none"
              />
            }
          >
            <InfoIcon />
          </PopoverTrigger>
          <PopoverPopup
            aria-label="Notice details"
            tooltipStyle
            side="top"
            className="max-w-[min(30rem,calc(100vw-2rem))] whitespace-normal wrap-anywhere [--inline-button-text-align:start] [--inline-button-white-space:normal] [&_[data-slot=inline-button]]:max-w-full"
          >
            <ComposerBanner.Scroll className="max-h-[min(var(--available-height),24rem,40dvh)]">
              {children}
            </ComposerBanner.Scroll>
          </PopoverPopup>
        </Popover>
      ) : null}
    </span>
  );
}

function ComposerBannerStackAlert({
  item,
  attached,
  exiting,
  onDismissRequest,
}: {
  readonly item: ComposerBannerStackEntry;
  readonly attached: boolean;
  readonly exiting: boolean;
  readonly onDismissRequest: () => void;
}) {
  if ("content" in item) {
    return (
      <ComposerBanner.Root
        density="comfortable"
        placement={attached ? "attached" : "floating"}
        variant={item.variant}
      >
        {item.content}
      </ComposerBanner.Root>
    );
  }
  return (
    <ComposerBanner.Root
      role="alert"
      placement={attached ? "attached" : "floating"}
      variant={item.variant}
      density="comfortable"
    >
      <ComposerBanner.Row layout="wrap-actions">
        <ComposerBanner.Icon className="h-(--composer-banner-icon-column) self-start">
          {item.icon}
        </ComposerBanner.Icon>
        <ComposerBanner.Content className="whitespace-nowrap">
          <span className="min-w-0 truncate font-medium leading-7 sm:leading-6">{item.title}</span>
          {item.description ? <NoticeDescription>{item.description}</NoticeDescription> : null}
        </ComposerBanner.Content>
        {item.actions || item.onDismiss ? (
          <ComposerBanner.Actions>
            {item.actions}
            {item.onDismiss ? (
              <ComposerBanner.Dismiss
                aria-label={item.dismissLabel ?? "Dismiss warning"}
                disabled={exiting}
                onClick={onDismissRequest}
              />
            ) : null}
          </ComposerBanner.Actions>
        ) : null}
      </ComposerBanner.Row>
      {item.children ? <ComposerBanner.Children>{item.children}</ComposerBanner.Children> : null}
    </ComposerBanner.Root>
  );
}
