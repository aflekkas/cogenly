import type { ComponentProps, ReactNode, Ref } from "react";

import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";

/**
 * What a settings status means. Every page maps its states onto these, so
 * "Online", "Connected" and "Passing" read alike everywhere, as do "Needs
 * attention" and "Failing":
 * - `success`: online, connected, passing, signed in.
 * - `warning`: needs attention, expiring, partly working.
 * - `error`: failing, disconnected by an error, blocked.
 * - `info`: a neutral fact worth noticing (default, merges into).
 * - `neutral`: off, offline, disabled, not checked yet.
 */
export type SettingsStatusTone = "success" | "warning" | "error" | "info" | "neutral";

const BADGE_VARIANTS = {
  success: "success",
  warning: "warning",
  error: "error",
  info: "info",
  neutral: "muted",
} as const satisfies Record<SettingsStatusTone, ComponentProps<typeof Badge>["variant"]>;

const DOT_CLASSES = {
  success: "bg-success",
  warning: "bg-warning",
  error: "bg-destructive",
  info: "bg-info",
  neutral: "bg-muted-foreground/60",
} as const satisfies Record<SettingsStatusTone, string>;

/**
 * A worded status: in a section header, a row's control slot, or beside a
 * list item's title. One size and weight across settings.
 */
export function SettingsStatusBadge({
  tone,
  children,
  ref,
}: {
  readonly tone: SettingsStatusTone;
  readonly children: ReactNode;
  readonly ref?: Ref<HTMLSpanElement>;
}) {
  return (
    <Badge ref={ref} size="md" variant={BADGE_VARIANTS[tone]}>
      {children}
    </Badge>
  );
}

/**
 * A status inside running text, such as a list row's description line: a
 * tone dot before the words, which keep the surrounding text's color.
 */
export function SettingsStatusText({
  tone,
  children,
  className,
}: {
  readonly tone: SettingsStatusTone;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <span className={cn("inline-flex min-w-0 items-baseline gap-1.5", className)}>
      <SettingsStatusDot tone={tone} />
      <span className="min-w-0">{children}</span>
    </span>
  );
}

/** The tone dot alone, sized and centred on the first line of 12px text. */
export function SettingsStatusDot({ tone }: { readonly tone: SettingsStatusTone }) {
  return (
    <span aria-hidden className="flex h-[1.45em] shrink-0 items-center self-start">
      <span className={cn("size-1.5 rounded-full", DOT_CLASSES[tone])} />
    </span>
  );
}

/**
 * A fact about an item that isn't a status: its type, "Default", "This
 * device". Outlined so it never reads as health, the same size as a status.
 */
export function SettingsTag({
  children,
  ref,
  ...props
}: Omit<ComponentProps<typeof Badge>, "size" | "variant" | "className">) {
  return (
    <Badge {...props} ref={ref} size="md" variant="outline">
      {children}
    </Badge>
  );
}
