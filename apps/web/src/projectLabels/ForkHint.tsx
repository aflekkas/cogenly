import { ArrowRightIcon, GitForkIcon } from "lucide-react";

/**
 * The muted "⑂ Fork →" tail of a project row that forks the chat across. The
 * arrow's width is always reserved, so the row never reflows: when the row is
 * highlighted (hover or keyboard) it slides in from the left while fading in,
 * and the fork glyph nudges along; it reverses as the highlight leaves. Under
 * reduced motion only the opacity changes.
 */
export function ForkHint() {
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1 text-xs text-muted-foreground/70">
      <GitForkIcon className="size-3 transition-transform duration-(--motion-duration-fast) ease-(--ease-out) in-data-highlighted:translate-x-px motion-reduce:transition-none motion-reduce:in-data-highlighted:translate-x-0" />
      Fork
      <ArrowRightIcon
        aria-hidden
        className="size-3 -translate-x-1 opacity-0 transition-[opacity,translate] duration-[180ms] ease-(--ease-out) in-data-highlighted:translate-x-0 in-data-highlighted:opacity-100 motion-reduce:translate-x-0 motion-reduce:transition-opacity"
      />
    </span>
  );
}
