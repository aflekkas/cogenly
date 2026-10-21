import { memo } from "react";
import { Check, Copy } from "lucide";
import { Button } from "../ui/button";
import { MorphIcon } from "~/components/MorphIcon";
import { cn } from "~/lib/utils";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { showCopiedToast, showCopyFailedToast } from "../ui/copiedToast";
import { COPY_CONFIRMATION_MS } from "../ui/copiedToast.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const MessageCopyButton = memo(function MessageCopyButton({
  text,
  label = "Copy message",
  icon = Copy,
  extraFlavors,
  size = "xs",
  variant = "outline",
  className,
}: {
  text: string;
  label?: string;
  /** The icon shown until the copy lands. */
  icon?: typeof Copy;
  /** Additional clipboard types written beside `text/plain` when the platform allows it. */
  extraFlavors?: Readonly<Record<string, string>>;
  size?: "xs" | "icon-xs";
  variant?: "outline" | "ghost";
  className?: string;
}) {
  // The icon morphs to a check for a moment and a toast confirms the copy.
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    onCopy: () => showCopiedToast({ kind: "clipboard" }),
    onError: showCopyFailedToast,
    timeout: COPY_CONFIRMATION_MS,
    ...(extraFlavors ? { extraFlavors } : {}),
  });

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            disabled={isCopied}
            onClick={() => copyToClipboard(text)}
            type="button"
            size={size}
            variant={variant === "ghost" ? "ghost-muted" : variant}
            className={className}
          />
        }
      >
        <MorphIcon
          className={cn("size-3", isCopied && "text-primary")}
          icon={isCopied ? Check : icon}
        />
      </TooltipTrigger>
      <TooltipPopup>
        <p>{label}</p>
      </TooltipPopup>
    </Tooltip>
  );
});
