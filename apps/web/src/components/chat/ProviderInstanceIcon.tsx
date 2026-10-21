import { type CSSProperties, memo } from "react";

import { providerInstanceInitials } from "@t3tools/client-runtime/state/provider-instance-display";

import { ProviderDriverKind } from "@t3tools/contracts";

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

/**
 * A provider's glyph for one configured instance. With `showBadge`, a small
 * dot in the instance's accent color sits on the glyph's lower-right corner so
 * several instances of one provider read apart without recoloring the brand mark.
 */
export const ProviderInstanceIcon = memo(function ProviderInstanceIcon(props: {
  driverKind: ProviderDriverKind;
  displayName: string;
  accentColor?: string | undefined;
  showBadge?: boolean;
  className?: string;
  iconClassName?: string;
  /** Positions or sizes the instance dot; it is `size-2` at the icon's corner by default. */
  badgeClassName?: string;
  statusDotClassName?: string;
  indicatorBackground?: string;
}) {
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
          className={cn("size-5 shrink-0", props.iconClassName)}
          aria-hidden
        />
      ) : (
        <span className={cn("text-3xs font-semibold leading-none", props.iconClassName)}>
          {providerInstanceInitials(props.displayName)}
        </span>
      )}
      {props.statusDotClassName ? (
        <span
          className={cn(
            "pointer-events-none absolute -left-0.5 -top-0.5 z-10 size-2 rounded-full",
            props.statusDotClassName,
          )}
          style={{ boxShadow: `0 0 0 2px ${indicatorBackground}` }}
          aria-hidden
        />
      ) : null}
      {props.showBadge ? (
        <span
          data-provider-instance-mark=""
          className={cn(
            "pointer-events-none absolute -right-0.5 -bottom-0.5 z-10 size-2 rounded-full transition-[background-color,box-shadow] duration-(--motion-duration-fast) ease-standard motion-reduce:transition-none",
            props.accentColor ? "bg-(--provider-accent)" : "bg-muted-foreground",
            props.badgeClassName,
          )}
          style={{ boxShadow: `0 0 0 1.5px ${indicatorBackground}` }}
          aria-hidden
        />
      ) : null}
    </span>
  );
});
