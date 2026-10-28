import type { BrowserExtension } from "@cogenly/contracts";

import { browserExtensionStatus } from "~/browser/browserExtensions.logic";
import { BadgeDot } from "~/components/ui/badge-dot";
import { cn } from "~/lib/utils";

/**
 * One line saying an extension is off, loading, or failed to load, with the
 * browser's reason; nothing while it runs. Menu rows and Settings rows use it.
 */
export function BrowserExtensionStatusText(props: {
  readonly extension: Pick<BrowserExtension, "enabled" | "state" | "error" | "loadError">;
  /** Rows short on room name the state alone; the reason waits for Details. */
  readonly withDetail?: boolean;
}) {
  const status = browserExtensionStatus(props.extension);
  if (!status) return null;
  return (
    <span
      className={cn(
        "min-w-0 text-xs",
        status.tone === "destructive" ? "text-destructive-foreground" : "text-muted-foreground",
        props.withDetail ? "wrap-anywhere" : "truncate",
      )}
    >
      {props.withDetail && status.detail ? `${status.label}: ${status.detail}` : status.label}
    </span>
  );
}

/**
 * An extension's toolbar icon, or its first letter when it ships none, with a
 * dot while it loads (blue) or after it failed to load (red). The toolbar, its
 * menu, Settings and the details dialog all draw extensions with it.
 */
export function BrowserExtensionIcon(props: {
  readonly extension: Pick<
    BrowserExtension,
    "name" | "icon" | "enabled" | "state" | "error" | "loadError"
  >;
  readonly size?: "sm" | "md";
}) {
  const { extension } = props;
  const status = browserExtensionStatus(extension);
  const size = props.size === "md" ? "size-8" : "size-4";
  return (
    <span className={cn("relative inline-flex shrink-0", size)}>
      {extension.icon ? (
        <img
          src={extension.icon}
          alt=""
          draggable={false}
          className={cn("rounded-sm object-contain", size)}
        />
      ) : (
        <span
          aria-hidden
          className={cn(
            "flex items-center justify-center rounded-sm bg-muted font-medium text-muted-foreground uppercase",
            size,
            props.size === "md" ? "text-sm" : "text-3xs",
          )}
        >
          {extension.name.trim().charAt(0) || "?"}
        </span>
      )}
      <BadgeDot
        tone={status?.tone === "muted" ? null : status?.tone}
        ring="background"
        className="absolute -top-0.5 -right-0.5"
      />
    </span>
  );
}
