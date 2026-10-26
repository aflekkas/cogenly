import { ChevronDownIcon } from "lucide-react";
import type { ComponentProps, ReactNode, Ref } from "react";

import { cn } from "~/lib/utils";
import { InlineButton } from "../ui/button";
import { FadeSwap } from "./StateTransition";

/** The headings' FadeSwap slot, shared by the new-thread screen and an unwritten thread. */
export const HERO_HEADING_GROUP = "draft-heading";

/**
 * The large sentence over an empty thread's composer, shared by chats ("<greeting>
 * · in <project>") and Work ("What should we build in <project> / <repository>?").
 * It is plain inline text, centred over the composer: a phrase that no longer
 * fits wraps to the next line whole (pretty, not balanced, so the words before
 * it stay together), and names truncate before a phrase outgrows its line, so
 * the heading never runs past the column.
 */
export function HeroHeadline({
  ref,
  label,
  swapKey,
  children,
}: {
  readonly ref: Ref<HTMLHeadingElement>;
  /** The whole sentence, since its pickers would otherwise read as widget state. */
  readonly label: string;
  /** Changes when the sentence becomes another one (chat to Work), which cross-fades. */
  readonly swapKey: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="@container flex w-full min-w-0 flex-col items-center">
      <h1
        ref={ref}
        style={{ fontSize: "clamp(var(--text-xl), 3cqw, var(--text-3xl))" }}
        aria-label={label}
        className="w-full text-pretty text-center font-normal text-xl text-foreground tracking-tight"
      >
        {/* A block, so the phrases inside measure against the column and never outgrow it. */}
        <FadeSwap group={HERO_HEADING_GROUP} swapKey={swapKey} className="block">
          {children}
        </FadeSwap>
      </h1>
    </div>
  );
}

/**
 * Words that stay on one line together, such as "· in <project>" or
 * "<project> / <repository>?". The phrase moves to the next line rather than
 * splitting, and its names shrink (truncating) when even a line of its own is
 * too narrow.
 */
export function HeroPhrase(props: { readonly children: ReactNode }) {
  return (
    <span className="inline-flex min-w-0 max-w-full items-baseline whitespace-nowrap align-baseline">
      {props.children}
    </span>
  );
}

/**
 * A name in the sentence that opens a picker. Pass it as a trigger's `render`;
 * the visible name is its accessible name, so the sentence reads naturally.
 */
export function HeroPickerButton({ className, ...props }: ComponentProps<typeof InlineButton>) {
  return (
    <InlineButton
      tone="sentence"
      weight="normal"
      {...props}
      className={cn("pointer-events-auto min-w-0 max-w-full shrink align-baseline", className)}
    />
  );
}

/**
 * A name in the sentence: its icon and text, truncating with an ellipsis. In a
 * picker (`chevron`) a faint chevron follows it and brightens on hover, focus
 * and while open, so the name reads as a choice on touch screens too and
 * nothing shifts. Read-only names (an existing Work thread) leave it out.
 */
export function HeroName(props: {
  readonly text: string;
  readonly icon?: ReactNode;
  /** A stand-in such as "No project", which reads muted and without an icon. */
  readonly placeholder?: boolean;
  readonly chevron?: boolean;
}) {
  return (
    <>
      <span
        className={cn(
          "block min-w-0 max-w-[14em] truncate",
          props.placeholder && "text-muted-foreground",
        )}
      >
        {props.placeholder ? null : props.icon}
        {props.text}
      </span>
      {props.chevron ? (
        <ChevronDownIcon
          aria-hidden
          // The glyph's own side padding stands in for the space after it.
          className="-me-[0.1em] size-[0.45em] shrink-0 self-center text-muted-foreground opacity-70 transition-opacity duration-(--motion-duration-fast) ease-standard group-hover/inline-button:opacity-100 group-focus-visible/inline-button:opacity-100 group-data-popup-open/inline-button:opacity-100"
        />
      ) : null}
    </>
  );
}
