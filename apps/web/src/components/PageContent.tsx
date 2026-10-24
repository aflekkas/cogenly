import type { ComponentPropsWithoutRef } from "react";

import { cn } from "../lib/utils";

export type PageContentWidth = "default" | "wide";

// The border box adds the gutter and the column inset on both sides, so the
// content box lands on the composer's edges (index.css, --content-*).
const WIDTH_CLASS: Record<PageContentWidth, string> = {
  default:
    "max-w-[calc(var(--content-max-width)+2*var(--content-gutter))] px-[calc(var(--content-gutter)+var(--chat-content-inset))]",
  wide: "max-w-[calc(var(--content-wide-max-width)+2*var(--content-gutter))] px-[calc(var(--content-gutter)+var(--chat-content-inset))]",
};

/**
 * The main-area content column: settings, projects, usage and every other
 * page. Shares the chat column's width, gutter and centering. Render it as a
 * direct child of the page's full-width scroller, since the gutter resolves
 * against its containing block. `wide` is for dashboards and tables that
 * need more room. Glides to its new center when a panel toggles.
 */
export function PageContent({
  width = "default",
  className,
  ...props
}: ComponentPropsWithoutRef<"div"> & { readonly width?: PageContentWidth }) {
  return (
    <div
      className={cn("mx-auto flex w-full flex-col gap-6 pt-6 pb-12", WIDTH_CLASS[width], className)}
      data-panel-flip="center"
      {...props}
    />
  );
}
