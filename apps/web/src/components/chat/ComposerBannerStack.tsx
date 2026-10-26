import { InfoIcon, LayersIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
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
import { foldNotices } from "./composerStackBudget.logic";
import { observeResize } from "~/lib/observeResize";

// Match the duration-220 exit transition before removing a dismissed notice.
const DISMISS_TRANSITION_MS = 220;
// The attached notice opens, closes and swaps on this timing.
const NOTICE_PRESENCE_MS = 200;
// ease-standard in index.css.
const NOTICE_PRESENCE_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";
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

const NOTICE_OVERFLOW_ID = "composer-notice-overflow";

function hasStackContent(item: ComposerBannerStackEntry) {
  if (!("content" in item)) return true;
  const { content } = item;
  return content !== null && content !== undefined && content !== false && content !== "";
}

/** Plain notices may fold behind "+N more"; activity, urgent and error notices stay in view. */
function isFoldableNotice(item: ComposerBannerStackEntry) {
  return (
    !("content" in item) &&
    item.priority !== "activity" &&
    item.priority !== "urgent" &&
    item.variant !== "error"
  );
}

/** The bar standing in for folded notices; the whole row opens and folds them. */
function NoticeOverflowRow({
  count,
  expanded,
  summary,
  onToggle,
}: {
  readonly count: number;
  readonly expanded: boolean;
  readonly summary: string;
  readonly onToggle: () => void;
}) {
  return (
    <ComposerBanner.Row
      render={<button type="button" />}
      aria-expanded={expanded}
      aria-label={expanded ? "Fold notices" : `Show ${count} more notice${count === 1 ? "" : "s"}`}
      data-chat-composer-collapsed-controls="true"
      onPointerDown={(event) => event.preventDefault()}
      onClick={onToggle}
    >
      <ComposerBanner.Icon>
        <LayersIcon />
      </ComposerBanner.Icon>
      <ComposerBanner.Content className="whitespace-nowrap">
        <span className="shrink-0 font-medium leading-7 sm:leading-6">
          {expanded ? "Fold notices" : `+${count} more`}
        </span>
        {summary ? (
          <span
            aria-hidden={expanded}
            className={cn(
              "w-0 min-w-0 grow truncate text-muted-foreground transition-opacity duration-(--motion-duration-fast) ease-out motion-reduce:transition-none",
              expanded && "opacity-0",
            )}
          >
            {summary}
          </span>
        ) : null}
      </ComposerBanner.Content>
      <ComposerBanner.Actions>
        <ComposerBanner.ToggleIcon expanded={expanded} />
      </ComposerBanner.Actions>
    </ComposerBanner.Row>
  );
}

interface ComposerBannerStackProps {
  readonly className?: string;
  readonly items: ReadonlyArray<ComposerBannerStackEntry>;
  /**
   * Attachments that sit under the front item, nearest the composer, such as
   * the queue: notices coming and going never move it.
   */
  readonly attachedBelow?: ReactNode;
}

export function ComposerBannerStack({ className, items, attachedBelow }: ComposerBannerStackProps) {
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

  // Activity sits nearest the queue, then urgency and severity; every other
  // notice is its own attached bar above the front one, the most important lowest.
  // An entry with nothing to draw never gets a card.
  const orderedItems = items
    .filter(hasStackContent)
    .toSorted((a, b) => bannerPriority(a) - bannerPriority(b));
  const frontItem = orderedItems[0];
  // From three plain notices on, all but the most important fold into one
  // "+N more" bar that opens them again (and folds them back).
  const [noticesExpanded, setNoticesExpanded] = useState(false);
  const noticeFold = foldNotices(
    orderedItems.map((item) => ({ id: item.id, foldable: isFoldableNotice(item) })),
    noticesExpanded,
  );
  if (noticeFold.overflow === 0 && noticesExpanded) setNoticesExpanded(false);
  const hiddenSummary = orderedItems
    .flatMap((item) =>
      noticeFold.hidden.has(item.id) && "title" in item && typeof item.title === "string"
        ? [item.title]
        : [],
    )
    .join(", ");
  const overflowBar: ComposerBannerStackContent | null =
    noticeFold.overflow > 0
      ? {
          id: NOTICE_OVERFLOW_ID,
          variant: "default",
          content: (
            <NoticeOverflowRow
              count={noticeFold.overflow}
              expanded={noticesExpanded}
              summary={hiddenSummary}
              onToggle={() => setNoticesExpanded((expanded) => !expanded)}
            />
          ),
        }
      : null;
  const stackedItems = orderedItems.slice(1).filter((item) => !noticeFold.hidden.has(item.id));
  const heldBars = useHeldBars(
    overflowBar ? [overflowBar, ...stackedItems.toReversed()] : stackedItems.toReversed(),
  );

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
  const stackedBars = heldBars.bars.map(({ item, leaving }) => (
    <StackedNoticeBar
      key={item.id}
      item={item}
      leaving={leaving}
      animateMountRef={mountedRef}
      onLeft={heldBars.clearLeft}
    />
  ));

  if (!frontItem && !leavingFront) {
    return (
      <>
        {stackedBars}
        {attachedBelow}
      </>
    );
  }
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
      {stackedBars}
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
      {attachedBelow}
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

interface LeavingBar {
  readonly item: ComposerBannerStackEntry;
  readonly index: number;
}

/**
 * The stacked notices to draw: the current ones plus any that just went away,
 * kept at their last position until their bar has closed.
 */
function useHeldBars(items: ReadonlyArray<ComposerBannerStackEntry>) {
  const [leaving, setLeaving] = useState<ReadonlyArray<LeavingBar>>([]);
  const lastItemsRef = useRef(items);
  const ids = new Set(items.map((item) => item.id));
  useLayoutEffect(() => {
    const lastItems = lastItemsRef.current;
    lastItemsRef.current = items;
    const currentIds = new Set(items.map((item) => item.id));
    const gone = lastItems.flatMap((item, index) =>
      currentIds.has(item.id) ? [] : [{ item, index }],
    );
    setLeaving((current) => {
      const kept = current.filter((entry) => !currentIds.has(entry.item.id));
      const added = gone.filter((entry) => !kept.some((held) => held.item.id === entry.item.id));
      return added.length === 0 && kept.length === current.length ? current : [...kept, ...added];
    });
  });
  const clearLeft = useCallback(
    (id: string) => setLeaving((current) => current.filter((entry) => entry.item.id !== id)),
    [],
  );
  const bars = items.map((item) => ({ item, leaving: false }));
  for (const entry of leaving) {
    if (ids.has(entry.item.id)) continue;
    bars.splice(Math.min(entry.index, bars.length), 0, { item: entry.item, leaving: true });
  }
  return { bars, clearLeft };
}

/** A notice behind the front one, attached as its own bar above it. */
function StackedNoticeBar({
  item,
  leaving,
  animateMountRef,
  onLeft,
}: {
  readonly item: ComposerBannerStackEntry;
  readonly leaving: boolean;
  readonly animateMountRef: { readonly current: boolean };
  readonly onLeft: (id: string) => void;
}) {
  const onClosed = useCallback(() => onLeft(item.id), [item.id, onLeft]);
  return (
    <ComposerBanner.Attachment data-chat-composer-collapsed-controls="true">
      <NoticePresenceFrame
        open={!leaving}
        swapKey={null}
        animateMountRef={animateMountRef}
        onClosed={onClosed}
      >
        <div
          data-notice-current=""
          className="relative z-10"
          aria-hidden={leaving || undefined}
          inert={leaving}
        >
          <ComposerBannerStackAlert
            item={item}
            attached
            exiting={leaving}
            // The bar closes on its own once the notice leaves the list.
            onDismissRequest={() => {
              if ("onDismiss" in item) item.onDismiss?.();
            }}
          />
        </div>
      </NoticePresenceFrame>
    </ComposerBanner.Attachment>
  );
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
            <ComposerBanner.Scroll className="[--composer-banner-scroll-max:min(var(--available-height),24rem,40dvh)]">
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
