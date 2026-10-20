import {
  createContext,
  use,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { ChevronRightIcon } from "lucide-react";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { cn } from "../../lib/utils";
import { useLastPresent } from "../ui/overlay-presence";

const GroupedRows = createContext(false);

/** Groups may span virtualized timeline items. Each part owns its trailing space. */
export function WorkLogBlock({
  layout = "standalone",
  continues = false,
  children,
}: {
  layout?: "standalone" | "group-header" | "group-content";
  continues?: boolean | undefined;
  children: ReactNode;
}) {
  return (
    <div
      className={
        continues || layout === "group-header"
          ? "pb-0"
          : layout === "group-content"
            ? "pb-1"
            : "pb-2"
      }
    >
      {children}
    </div>
  );
}

/** Expanded members align with the header and use the same compact row geometry. */
export function WorkLogList({ children }: { children: ReactNode }) {
  return (
    <GroupedRows value>
      <div className="flex min-w-0 flex-col">{children}</div>
    </GroupedRows>
  );
}

type RowContent = {
  icon?: ReactNode;
  label: ReactNode;
  trailing?: ReactNode;
  wrapLabel?: boolean;
  /**
   * Open state of an expandable row. The chevron sits right after the label,
   * so it rotates in one spot instead of riding the row's far edge. Omit it
   * for rows with nothing to expand: they show no chevron at all.
   */
  disclosure?: boolean | undefined;
};

function WorkLogLine({ icon, label, trailing, wrapLabel, disclosure }: RowContent) {
  const expandable = disclosure !== undefined;
  return (
    <div
      className={cn(
        "flex min-h-6 min-w-0 gap-1.5 text-sm leading-relaxed select-none [&_*]:select-none",
        wrapLabel ? "items-start" : "items-center",
      )}
    >
      <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
        {icon ? (
          // Align with the first line's capital letters. Centering line boxes drifts
          // when font ascent/descent rounding changes at fractional browser zoom.
          <span className="relative w-6 shrink-0 leading-0">
            <span className="inline-block size-6 overflow-hidden align-[calc(0.5cap_-_0.75rem)]">
              <span className="flex size-full items-center justify-center">{icon}</span>
            </span>
          </span>
        ) : null}
        <div
          className={cn(
            "min-w-0 text-secondary-label",
            !expandable && "flex-1",
            !wrapLabel && "truncate [&_*]:whitespace-nowrap",
          )}
        >
          {label}
        </div>
        {expandable ? (
          <>
            <span className="flex size-4 shrink-0 items-center justify-center self-center">
              <WorkLogChevron open={disclosure} reveal />
            </span>
            <span className="min-w-0 flex-1" />
          </>
        ) : null}
      </div>
      {trailing}
    </div>
  );
}

const interactionClassName =
  "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70";

function useRowClassName(interactive: boolean) {
  const grouped = use(GroupedRows);
  return cn(
    "group/timeline-row relative w-full min-w-0 rounded-md px-0.5 text-left transition-colors",
    grouped ? "py-0" : "py-0.5",
    interactive && interactionClassName,
  );
}

// No className/style escape hatch: consumers supply content and behavior, not geometry.
export function WorkLogButton({
  icon,
  label,
  trailing,
  wrapLabel = false,
  disclosure,
  ...buttonProps
}: RowContent & Omit<ComponentProps<"button">, "className" | "style" | "children">) {
  const className = useRowClassName(true);
  return (
    <button {...buttonProps} type="button" className={className}>
      <WorkLogLine
        icon={icon}
        label={label}
        trailing={trailing}
        wrapLabel={wrapLabel}
        disclosure={disclosure}
      />
    </button>
  );
}

/** Div-based disclosure supports selectable detail and nested actions in an entry. */
export function WorkLogRow({
  icon,
  label,
  trailing,
  wrapLabel = false,
  disclosure,
  children,
  ...rowProps
}: RowContent & Omit<ComponentProps<"div">, "className" | "style">) {
  const className = useRowClassName(rowProps.onClick !== undefined);
  return (
    <div {...rowProps} className={className}>
      <WorkLogLine
        icon={icon}
        label={label}
        trailing={trailing}
        wrapLabel={wrapLabel}
        disclosure={disclosure}
      />
      {children}
    </div>
  );
}

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
/** Longest disclosure motion; a close that never fires transitionend still unmounts after it. */
const DISCLOSURE_MOTION_MS = 400;

/** Disclosures open on the slow token and leave at 0.7x, like panels. */
function disclosureDuration(open: boolean) {
  return {
    transitionDuration: open
      ? "var(--motion-duration-slow)"
      : "calc(var(--motion-duration-slow) * 0.7)",
  };
}

/**
 * A disclosure chevron that rotates in step with the content it opens.
 * `reveal` keeps a closed chevron hidden until its row is hovered or focused.
 */
export function WorkLogChevron({ open, reveal = false }: { open: boolean; reveal?: boolean }) {
  return (
    <ChevronRightIcon
      aria-hidden
      className={cn(
        "size-3 shrink-0 text-icon-muted transition-[rotate,opacity] ease-standard motion-reduce:transition-none",
        open && "rotate-90",
        reveal && !open
          ? "opacity-0 group-hover/timeline-row:opacity-70 group-focus-visible/timeline-row:opacity-70 group-hover/disclosure:opacity-70 group-focus-visible/disclosure:opacity-70"
          : "opacity-70",
      )}
      style={disclosureDuration(open)}
    />
  );
}

/**
 * Grows disclosure content from zero height and fades and drops it in; closing
 * runs the same motion back and unmounts once it ends, holding the last open
 * content meanwhile. Only an open that happens after mount animates, or the
 * first one when `appear` is set, so virtualized rows that remount open stay
 * still. `layout="group-content"` carries an expanded group's trailing space:
 * while closing it grows to the gap the collapsed header will own, so removing
 * the row afterwards moves nothing. Reduced motion opens and closes at once.
 */
export function WorkLogCollapse({
  open,
  appear = false,
  layout = "row",
  continues = false,
  onExitComplete,
  children,
}: {
  open: boolean;
  appear?: boolean;
  layout?: "row" | "group-content";
  continues?: boolean | undefined;
  onExitComplete?: (() => void) | undefined;
  children: ReactNode;
}) {
  const reducedMotion = useMediaQuery(REDUCED_MOTION);
  const [mounted, setMounted] = useState(open);
  const [animateEnter, setAnimateEnter] = useState(appear);
  const [moving, setMoving] = useState(appear && open);
  const [previousOpen, setPreviousOpen] = useState(open);
  const held = useLastPresent(open ? children : null);
  if (previousOpen !== open) {
    setPreviousOpen(open);
    setMoving(true);
    if (open) {
      if (!mounted) setAnimateEnter(true);
      setMounted(true);
    }
  }
  const present = mounted && !(reducedMotion && !open);
  const onExitCompleteRef = useRef(onExitComplete);
  useLayoutEffect(() => {
    onExitCompleteRef.current = onExitComplete;
  });
  // Reports the close once nothing is left on screen, including a row that
  // remounted closed or closed under reduced motion.
  useEffect(() => {
    if (!open && !present) onExitCompleteRef.current?.();
  }, [open, present]);
  const settle = () => {
    setMoving(false);
    if (!open) setMounted(false);
  };
  // A transition that never starts (hidden tab, interrupted style) still settles.
  useEffect(() => {
    if (!moving) return;
    const timer = setTimeout(() => {
      setMoving(false);
      if (!open) setMounted(false);
    }, DISCLOSURE_MOTION_MS + 100);
    return () => clearTimeout(timer);
  }, [moving, open]);
  if (!present) return null;
  const gapClassName =
    layout === "group-content" && !continues ? (open ? "pb-1" : "pb-2") : undefined;
  if (reducedMotion) return <div className={gapClassName}>{children}</div>;
  return (
    <div
      inert={!open}
      style={disclosureDuration(open)}
      className={cn(
        "grid transition-[grid-template-rows,padding] ease-standard",
        open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        animateEnter && "starting:grid-rows-[0fr]",
        animateEnter && layout === "group-content" && !continues && "starting:pb-2",
        gapClassName,
      )}
      onTransitionEnd={(event) => {
        if (event.target !== event.currentTarget || event.propertyName !== "grid-template-rows") {
          return;
        }
        settle();
      }}
    >
      {/* Clipped only while moving, so focus rings and shadows show at rest. */}
      <div
        className={cn(
          "min-h-0 transition-[opacity,translate] ease-standard",
          open ? "translate-y-0 opacity-100" : "-translate-y-1 opacity-0",
          animateEnter && "starting:-translate-y-1 starting:opacity-0",
          (moving || !open) && "overflow-hidden",
        )}
        style={disclosureDuration(open)}
      >
        {open ? children : held}
      </div>
    </div>
  );
}

/** Distance from the end, in px, that still counts as reading the newest text. */
const LIVE_EDGE_PX = 4;

export function WorkLogDetails({
  children,
  kind = "text",
  followLive = false,
}: {
  children: ReactNode;
  kind?: "text" | "panel" | "media";
  /** Keep streamed text in view. Scrolling up pauses this until the reader returns to the end. */
  followLive?: boolean;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const atLiveEdgeRef = useRef(true);
  // No deps: each streamed chunk re-renders this, and pinning before paint
  // shows the new text without a visible jump.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (followLive && atLiveEdgeRef.current && scroller) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  });
  return (
    <div
      ref={scrollerRef}
      onScroll={(event) => {
        const { scrollHeight, scrollTop, clientHeight } = event.currentTarget;
        atLiveEdgeRef.current = scrollHeight - scrollTop - clientHeight <= LIVE_EDGE_PX;
      }}
      className={cn(
        "cursor-auto",
        kind === "text"
          ? "ms-7 flex max-h-96 flex-col gap-3 overflow-auto px-0.5 py-1 select-text"
          : kind === "panel"
            ? "mt-0.5 mb-1.5 pb-2"
            : "mt-1",
      )}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {children}
    </div>
  );
}

/**
 * A quiet nested disclosure inside an expanded row (the Raw call): a muted
 * label with the row chevron, opening and closing with the row's motion.
 * `onToggle` lets the timeline hold its scroll anchor while it resizes.
 */
export function WorkLogDisclosure({
  label,
  defaultOpen = false,
  onToggle,
  children,
}: {
  label: string;
  defaultOpen?: boolean;
  onToggle?: ((collapsed: boolean) => void) | undefined;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="flex min-w-0 flex-col">
      <button
        type="button"
        aria-expanded={open}
        className="group/disclosure flex w-fit items-center gap-1 rounded-sm text-xs text-muted-foreground transition-colors select-none hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
        onClick={(event) => {
          event.stopPropagation();
          onToggle?.(open);
          setOpen(!open);
        }}
        onKeyDown={(event) => event.stopPropagation()}
      >
        {label}
        <WorkLogChevron open={open} reveal />
      </button>
      <WorkLogCollapse open={open}>
        <div className="pt-1">{children}</div>
      </WorkLogCollapse>
    </div>
  );
}

/** One titled part of an expanded row. */
function WorkLogSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-0.5" aria-label={title}>
      <h4 className="text-2xs font-medium text-muted-foreground">{title}</h4>
      {children}
    </section>
  );
}

export type WorkLogArg = { readonly label: string; readonly value: ReactNode };

/**
 * The one layout every expanded work-log row uses, in this order: the call's
 * arguments as key/values (or the full command), the result as a summary
 * line over an output preview, and the raw call last behind a quiet
 * disclosure. Empty parts are left out; a row with no parts is not
 * expandable at all.
 */
export function WorkLogExpansion({
  args,
  command,
  resultSummary,
  output,
  raw,
  failed = false,
  onToggle,
}: {
  args?: ReadonlyArray<WorkLogArg> | undefined;
  command?: ReactNode;
  resultSummary?: string | null | undefined;
  output?: ReactNode;
  raw?: ReactNode;
  failed?: boolean;
  onToggle?: ((collapsed: boolean) => void) | undefined;
}) {
  const hasArgs = (args?.length ?? 0) > 0 || Boolean(command);
  const hasResult = Boolean(resultSummary) || Boolean(output);
  return (
    <div
      className="ms-7 flex min-w-0 flex-col gap-2.5 pt-0.5 pb-2 text-xs"
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {hasArgs ? (
        <WorkLogSection title="Arguments">
          {command}
          {args && args.length > 0 ? (
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-secondary-label select-text">
              {args.map((row) => (
                <div key={row.label} className="contents">
                  <dt className="text-muted-foreground">{row.label}</dt>
                  <dd className="line-clamp-4 min-w-0 break-words whitespace-pre-wrap">
                    {row.value}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
        </WorkLogSection>
      ) : null}
      {hasResult ? (
        <WorkLogSection title="Result">
          {resultSummary ? (
            <p
              className={cn(
                "min-w-0 break-words select-text",
                failed ? "text-destructive" : "text-secondary-label",
              )}
            >
              {resultSummary}
            </p>
          ) : null}
          {output ? <div className="min-w-0 cursor-auto select-text">{output}</div> : null}
        </WorkLogSection>
      ) : null}
      {raw ? (
        <WorkLogDisclosure label="Raw" onToggle={onToggle}>
          {raw}
        </WorkLogDisclosure>
      ) : null}
    </div>
  );
}
