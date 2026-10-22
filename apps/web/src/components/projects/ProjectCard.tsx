import { XIcon } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { PROJECT_CARD_ARRIVAL_MS, arrivedKeys, projectCardCount } from "./projectHome.logic";

/**
 * One persistent card in the project home's right column: an icon, a label
 * with its count, one small add affordance, then rows or a line saying what
 * the card holds.
 */
export function ProjectCard(props: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly count?: number;
  /** The card's one add affordance, usually a `ProjectCardAddButton`. */
  readonly add?: ReactNode;
  /** Shown instead of the rows when there are none. */
  readonly empty?: ReactNode;
  readonly isEmpty?: boolean;
  readonly children?: ReactNode;
  readonly className?: string;
}) {
  const count = props.count === undefined ? null : projectCardCount(props.count);
  return (
    <section aria-label={props.title} className={cn("project-card", props.className)}>
      <header className="flex h-7 items-center gap-2 px-1.5 text-menu font-semibold">
        <span
          aria-hidden
          className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground [&>svg]:size-3.5"
        >
          {props.icon}
        </span>
        <span className="min-w-0 truncate">{props.title}</span>
        {count !== null ? (
          <span className="text-xs font-medium tabular-nums text-muted-foreground">{count}</span>
        ) : null}
        {props.add !== undefined ? (
          <span className="ml-auto flex shrink-0 items-center">{props.add}</span>
        ) : null}
      </header>
      {props.isEmpty ? (
        <p className="px-1.5 pt-0.5 pb-1.5 text-xs/relaxed text-muted-foreground">{props.empty}</p>
      ) : (
        <div className="flex flex-col">{props.children}</div>
      )}
    </section>
  );
}

/** The "+" in a card's header. */
export function ProjectCardAddButton(props: {
  readonly label: string;
  readonly disabled?: boolean | undefined;
  readonly title?: string | undefined;
  readonly icon: ReactNode;
  readonly onClick?: (() => void) | undefined;
  readonly expanded?: boolean | undefined;
}) {
  return (
    <Button
      size="icon-xs"
      variant="ghost-muted"
      aria-label={props.label}
      title={props.title ?? props.label}
      disabled={props.disabled}
      aria-expanded={props.expanded}
      onClick={props.onClick}
    >
      {props.icon}
    </Button>
  );
}

/**
 * A card row: icon, title, optional meta, an optional status pip, and a remove
 * action that shows on hover or focus. `arrived` glows the row once, for an
 * item a live change just added; `removing` fades it while the server drops it.
 */
export function ProjectCardRow(props: {
  readonly icon: ReactNode;
  readonly title: ReactNode;
  readonly meta?: ReactNode | undefined;
  readonly pip?: "running" | "needs-you" | "failed" | "done" | null;
  readonly pipLabel?: string | undefined;
  readonly arrived?: boolean;
  readonly removing?: boolean;
  readonly onOpen?: () => void;
  readonly ariaLabel?: string;
  /** Remove (or unlink, or unfile) this item; omit for rows that can't be removed here. */
  readonly onRemove?: () => void;
  readonly removeLabel?: string;
  readonly removeDisabledReason?: string | null;
}) {
  const interactive = props.onOpen !== undefined;
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    props.onOpen?.();
  };
  return (
    <div
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={props.ariaLabel}
      data-arrived={props.arrived ? "" : undefined}
      className={cn(
        "project-card-row group/card-row",
        interactive && "cursor-pointer select-none",
        props.arrived && "project-card-row-arrived",
        props.removing && "pointer-events-none opacity-0",
      )}
      onClick={props.onOpen}
      onKeyDown={interactive ? onKeyDown : undefined}
    >
      <span
        aria-hidden
        className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground [&>svg]:size-3.5"
      >
        {props.icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{props.title}</span>
      {props.pip ? (
        <span
          role="img"
          aria-label={props.pipLabel}
          className="project-card-pip"
          data-pip={props.pip}
        />
      ) : null}
      {props.meta !== undefined ? (
        <span className="max-w-2/5 shrink-0 truncate text-2xs tabular-nums text-secondary-label">
          {props.meta}
        </span>
      ) : null}
      {props.onRemove ? (
        <span
          className="-me-1 flex shrink-0 items-center opacity-0 transition-opacity duration-(--motion-duration-fast) ease-standard group-hover/card-row:opacity-100 group-focus-within/card-row:opacity-100 pointer-coarse:opacity-100"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <Button
            size="icon-micro"
            variant="ghost-muted"
            aria-label={props.removeLabel ?? "Remove"}
            title={props.removeDisabledReason ?? props.removeLabel ?? "Remove"}
            disabled={props.removeDisabledReason != null}
            onClick={props.onRemove}
          >
            <XIcon />
          </Button>
        </span>
      ) : null}
    </div>
  );
}

/** A muted line under a card's rows: "+3 more", a loading note, an upload in flight. */
export function ProjectCardNote(props: { readonly children: ReactNode }) {
  return <p className="px-1.5 pt-1 pb-0.5 text-xs text-muted-foreground">{props.children}</p>;
}

/**
 * The keys among `keys` that a live change just added, each for
 * `PROJECT_CARD_ARRIVAL_MS`. Until `ready` (the first real snapshot) nothing
 * counts, so items present on load never glow.
 */
export function useArrivedKeys(keys: ReadonlyArray<string>, ready: boolean): ReadonlySet<string> {
  const previous = useRef<ReadonlySet<string> | null>(null);
  const timers = useRef(new Set<number>());
  const [arrived, setArrived] = useState<ReadonlySet<string>>(() => new Set());
  const signature = keys.join("\u0000");
  // A layout effect, so an arrived row paints its first frame already fading in.
  useLayoutEffect(() => {
    if (!ready) return;
    // Rebuilt from `signature`, since `keys` is a new array every render.
    const current = signature === "" ? [] : signature.split("\u0000");
    const fresh = arrivedKeys(previous.current, current);
    previous.current = new Set(current);
    if (fresh.length === 0) return;
    setArrived((shown) => new Set([...shown, ...fresh]));
    // Each arrival settles on its own clock, even if more land meanwhile.
    const timer = window.setTimeout(() => {
      timers.current.delete(timer);
      setArrived((current) => {
        const next = new Set(current);
        for (const key of fresh) next.delete(key);
        return next;
      });
    }, PROJECT_CARD_ARRIVAL_MS);
    timers.current.add(timer);
  }, [ready, signature]);
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) window.clearTimeout(timer);
    };
  }, []);
  return arrived;
}
