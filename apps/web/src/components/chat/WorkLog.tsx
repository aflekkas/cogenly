import {
  createContext,
  use,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { cn } from "../../lib/utils";
import { observeVisibleAnimation } from "../../lib/visibleAnimation";
import { DisclosureChevron, DisclosurePanel, DisclosureTrigger } from "../ui/disclosure";

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
  /** In progress: the label carries the shared shimmer. The icon stays muted. */
  active?: boolean | undefined;
  /**
   * Open state of an expandable row. The chevron sits right after the label,
   * so it rotates in one spot instead of riding the row's far edge. Omit it
   * for rows with nothing to expand: they show no chevron at all.
   */
  disclosure?: boolean | undefined;
};

/**
 * The one in-progress treatment for activity text: a soft light band sweeps
 * across the muted label. A masked copy in foreground slides on the compositor
 * (no repaint per frame) and pauses offscreen. Under reduced motion the copy
 * holds still at half strength, so live text reads brighter without moving.
 */
export function WorkLogShimmer({
  active,
  children,
}: {
  active: boolean | undefined;
  children: ReactNode;
}) {
  if (!active) return children;
  return (
    <span ref={observeVisibleAnimation} className="relative block min-w-0 truncate">
      {children}
      {/* inert: the copy may hold links, and must never take focus or clicks. */}
      <span
        aria-hidden
        inert
        className="live-activity-focus pointer-events-none absolute inset-y-0 select-none"
      >
        <span className="live-activity-focus-counter block">
          <span className="live-activity-focus-aligned block truncate text-foreground [&_*]:text-foreground">
            {children}
          </span>
        </span>
      </span>
    </span>
  );
}

function WorkLogLine({ icon, label, trailing, wrapLabel, active, disclosure }: RowContent) {
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
          <WorkLogShimmer active={active}>{label}</WorkLogShimmer>
        </div>
        {expandable ? (
          <>
            <span className="flex size-4 shrink-0 items-center justify-center self-center">
              <DisclosureChevron open={disclosure} reveal />
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
  active,
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
        active={active}
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
  active,
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
        active={active}
        disclosure={disclosure}
      />
      {children}
    </div>
  );
}

/**
 * The timeline's names for the shared disclosure motion: the chevron turns in
 * step with the content growing in. See `ui/disclosure.tsx`.
 */
export { DisclosureChevron as WorkLogChevron, DisclosurePanel as WorkLogCollapse };

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
          ? "scroll-fade-y ms-7 flex max-h-96 flex-col gap-3 overflow-auto px-0.5 py-1 select-text"
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
      <DisclosureTrigger
        open={open}
        reveal
        variant="quiet"
        className="w-fit"
        onClick={(event) => {
          event.stopPropagation();
          onToggle?.(open);
          setOpen(!open);
        }}
        onKeyDown={(event) => event.stopPropagation()}
      >
        {label}
      </DisclosureTrigger>
      <DisclosurePanel open={open}>
        <div className="pt-1">{children}</div>
      </DisclosurePanel>
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
