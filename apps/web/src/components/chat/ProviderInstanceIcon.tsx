import { type CSSProperties, memo } from "react";

import { providerInstanceInitials } from "@cogenly/client-runtime/state/provider-instance-display";

import { ProviderDriverKind } from "@cogenly/contracts";

import { cn } from "~/lib/utils";
import { providerClients } from "../settings/providerDriverMeta";
import { ProviderPackageIcon } from "./ProviderPackageIcon";

/**
 * Brand text color for a provider label; each definition ships its glyph as
 * data with per-theme fills, supplied here as CSS variables. Unknown
 * drivers get no brand color.
 */
export function providerTextColor(driverKind: ProviderDriverKind): {
  readonly className?: string;
  readonly style?: CSSProperties;
} {
  const icon = providerClients.get(driverKind)?.icon;
  if (!icon) return {};
  return {
    className: "text-(--icon-light) dark:text-(--icon-dark)",
    style: { "--icon-light": icon.fill.light, "--icon-dark": icon.fill.dark } as CSSProperties,
  };
}

export type ProviderInstanceIconSize = "xs" | "sm" | "md" | "lg";

// The glyph and its instance dot scale together, so a 12px glyph doesn't wear
// the dot made for a 20px one.
const iconSizeClassName: Record<ProviderInstanceIconSize, string> = {
  xs: "size-3",
  sm: "size-3.5",
  md: "size-4",
  lg: "size-5",
};
const badgeSizeClassName: Record<ProviderInstanceIconSize, string> = {
  xs: "size-1.25",
  sm: "size-1.5",
  md: "size-1.5",
  lg: "size-2",
};
const badgeRingWidth: Record<ProviderInstanceIconSize, string> = {
  xs: "1px",
  sm: "1px",
  md: "1.5px",
  lg: "1.5px",
};

/**
 * A provider's glyph for one configured instance. With `showBadge`, a small
 * dot in the instance's accent color sits on the glyph's lower-right corner so
 * several instances of one provider read apart without recoloring the brand mark.
 * `size` sets the glyph and the dot together; `iconClassName` is for colour.
 */
export const ProviderInstanceIcon = memo(function ProviderInstanceIcon(props: {
  driverKind: ProviderDriverKind;
  displayName: string;
  accentColor?: string | undefined;
  showBadge?: boolean;
  size?: ProviderInstanceIconSize;
  className?: string;
  iconClassName?: string | undefined;
  indicatorBackground?: string;
}) {
  const size = props.size ?? "lg";
  const packageIcon = providerClients.get(props.driverKind)?.icon;
  const indicatorBackground = props.indicatorBackground ?? "var(--card)";
  const accentStyle = props.accentColor
    ? ({ "--provider-accent": props.accentColor } as CSSProperties)
    : undefined;

  return (
    <span
      className={cn(
        "relative isolate z-30 inline-flex shrink-0 items-center justify-center overflow-visible",
        props.className,
      )}
      style={accentStyle}
      data-provider-accent-color={props.accentColor}
    >
      {packageIcon ? (
        <ProviderPackageIcon
          icon={packageIcon}
          className={cn(iconSizeClassName[size], "shrink-0", props.iconClassName)}
          aria-hidden
        />
      ) : (
        <span className={cn("text-3xs font-semibold leading-none", props.iconClassName)}>
          {providerInstanceInitials(props.displayName)}
        </span>
      )}
      {props.showBadge ? (
        <span
          data-provider-instance-mark=""
          className={cn(
            "pointer-events-none absolute -right-0.5 -bottom-0.5 z-10 rounded-full transition-[background-color,box-shadow] duration-(--motion-duration-fast) ease-standard motion-reduce:transition-none",
            badgeSizeClassName[size],
            props.accentColor ? "bg-(--provider-accent)" : "bg-muted-foreground",
          )}
          style={{ boxShadow: `0 0 0 ${badgeRingWidth[size]} ${indicatorBackground}` }}
          aria-hidden
        />
      ) : null}
    </span>
  );
});
