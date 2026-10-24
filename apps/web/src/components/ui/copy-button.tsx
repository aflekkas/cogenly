import { CheckIcon, CopyIcon, type LucideIcon } from "lucide-react";
import { useCallback, type ReactNode } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import type { CopyStatus } from "~/hooks/copyFeedback.logic";
import { cn } from "~/lib/utils";

import { Button } from "./button";
import { showCopyFailedToast } from "./copiedToast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip";

const COPIED_TEXT = "Copied";
const FAILED_TEXT = "Could not copy";

/** Shared timing for the copy, check and text crossfades. Reduced motion keeps opacity only. */
const SWAP =
  "transition-[opacity,scale,color] duration-(--motion-duration-fast) ease-out motion-reduce:scale-100 motion-reduce:transition-opacity";
const SHOWN = "opacity-100 scale-100";
const HIDDEN = "opacity-0 scale-50";

/**
 * The icon of a copy control: the copy glyph crossfades and scales into a check while copied.
 * Both glyphs occupy one grid cell, so the size never changes. Use it directly only where the
 * trigger is not a `CopyButton`, such as a menu trigger that copies from its items.
 */
function CopyStatusIcon({
  status,
  icon: Icon = CopyIcon,
}: {
  status: CopyStatus;
  icon?: LucideIcon;
}) {
  const copied = status === "copied";
  return (
    <span aria-hidden className="inline-grid place-items-center *:col-start-1 *:row-start-1">
      <Icon
        className={cn(SWAP, copied ? HIDDEN : SHOWN, status === "failed" && "text-destructive")}
      />
      <CheckIcon className={cn(SWAP, "text-success", copied ? SHOWN : HIDDEN)} />
    </span>
  );
}

type CopyButtonSize =
  | "icon-micro"
  | "icon-xs"
  | "icon-sm"
  | "icon"
  | "micro"
  | "compact"
  | "xs"
  | "sm"
  | "default";

interface CopyButtonProps {
  /** The text to copy, or a function read when the button is pressed. */
  value: string | (() => string);
  /** What pressing does ("Copy command"): the tooltip and the accessible name. */
  label: string;
  size?: CopyButtonSize;
  variant?: "ghost" | "ghost-muted" | "outline";
  /** Replaces the copy glyph, such as a link icon for "Copy prompt link". */
  icon?: LucideIcon;
  /** Visible text beside the icon. It crossfades to "Copied" and the tooltip is dropped. */
  children?: ReactNode;
  /** Names the thing for the clipboard error message. */
  target?: string;
  /** Extra clipboard flavors written beside the plain text when the platform allows. */
  extraFlavors?: Readonly<Record<string, string>>;
  /** Follow-up work after a successful copy. Not for feedback: the button already confirms it. */
  onCopied?: () => void;
  /** Replaces the default "Could not copy" toast. */
  onError?: (error: Error) => void;
  disabled?: boolean;
}

/**
 * The one copy control. It owns the feedback, so callers only say what to copy: the icon
 * crossfades into a check and back after 1.5s, the tooltip and a live region say "Copied", and a
 * failed write tints the icon and raises the error toast.
 */
function CopyButton({
  value,
  label,
  size = "icon-xs",
  variant = "ghost-muted",
  icon,
  children,
  target,
  extraFlavors,
  onCopied,
  onError = showCopyFailedToast,
  disabled,
}: CopyButtonProps) {
  const { copyToClipboard, status } = useCopyToClipboard({
    ...(target ? { target } : {}),
    ...(extraFlavors ? { extraFlavors } : {}),
    ...(onCopied ? { onCopy: onCopied } : {}),
    onError,
  });

  const handleClick = useCallback(() => {
    try {
      copyToClipboard(typeof value === "function" ? value() : value, undefined);
    } catch (cause) {
      onError(cause instanceof Error ? cause : new Error(String(cause)));
    }
  }, [copyToClipboard, onError, value]);

  const announcement = status === "copied" ? COPIED_TEXT : status === "failed" ? FAILED_TEXT : "";
  const copied = status === "copied";
  const hasText = children !== undefined && children !== null;

  const button = (
    <Button
      aria-label={label}
      disabled={disabled}
      onClick={handleClick}
      size={size}
      type="button"
      variant={variant}
    >
      <CopyStatusIcon status={status} {...(icon ? { icon } : {})} />
      {hasText ? (
        <span className="inline-grid *:col-start-1 *:row-start-1">
          <span className={cn(SWAP, "scale-100", copied ? "opacity-0" : "opacity-100")}>
            {children}
          </span>
          <span aria-hidden className={cn(SWAP, "scale-100", copied ? "opacity-100" : "opacity-0")}>
            {COPIED_TEXT}
          </span>
        </span>
      ) : null}
    </Button>
  );

  return (
    <>
      {hasText ? (
        button
      ) : (
        <Tooltip>
          <TooltipTrigger render={button} />
          <TooltipPopup side="top">
            {copied ? COPIED_TEXT : status === "failed" ? FAILED_TEXT : label}
          </TooltipPopup>
        </Tooltip>
      )}
      <span aria-live="polite" className="sr-only" role="status">
        {announcement}
      </span>
    </>
  );
}

export { CopyButton, CopyStatusIcon };
export type { CopyButtonProps };
