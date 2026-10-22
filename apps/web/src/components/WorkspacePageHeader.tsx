import type { ComponentPropsWithoutRef } from "react";

import { cn } from "../lib/utils";
import {
  COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
  COLLAPSED_SIDEBAR_TITLEBAR_MIRROR_INSET_CLASS,
} from "../workspaceTitlebar";
import type { WorkspacePageWidth } from "./WorkspacePageContainer";

// Beside the rail with no list column (Projects, Usage, an empty Agents list),
// the leading title takes the list column title's inset, so the mode title
// sits where it does in Chats and Work. Three attributes outrank the collapsed
// inset, which also applies when the column was collapsed before.
const LIST_COLUMN_HIDDEN_TITLE_INSET_CLASS =
  "[[data-nav-rail][data-list-column-hidden][data-sidebar-state]_&]:pl-list-column-hidden-title-inset";

/**
 * The top bar's horizontal inset, for page content that lines up with its
 * leading title (the Projects list). Excludes the native-controls reserve,
 * which only the bar itself needs.
 */
export const WORKSPACE_PAGE_HEADER_INSET_CLASS = cn(
  "pl-(--workspace-gutter-start) pr-(--workspace-gutter-end)",
  COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
  LIST_COLUMN_HIDDEN_TITLE_INSET_CLASS,
);

// The page frame's max width (WorkspacePageContainer), as a variable the
// aligned header content reads.
const CONTENT_WIDTH_CLASS: Record<WorkspacePageWidth, string> = {
  readable: "[--page-width:56rem]",
  wide: "[--page-width:64rem]",
  expanded: "[--page-width:72rem]",
};

/**
 * Wraps a header's leading content so it starts on the left edge of the page
 * frame below (WorkspacePageContainer), not the pane's edge. The width excludes
 * twice the header gutter, which centers the box like the frame; the leading
 * padding makes up the frame's wider side padding (px-5, sm:px-6). The header's
 * collapsed-sidebar inset still wins when the window is too narrow to center,
 * so the content never slides under the toggle or the back/forward buttons.
 */
export function WorkspacePageHeaderContent({
  className,
  ...props
}: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={cn(
        "mx-auto flex w-full max-w-[calc(var(--page-width)-2*var(--workspace-gutter))] min-w-0 items-center gap-3 pl-2 sm:pl-1",
        className,
      )}
      // Centered like the page frame, so it glides with it when a panel toggles.
      data-panel-flip="center"
      {...props}
    />
  );
}

/**
 * Shared workspace top-bar geometry. The height is `!important` so callers cannot
 * grow the bar and pull its content off the sidebar header's center line.
 * A leading title that isn't a WorkspaceBreadcrumb carries `data-panel-flip="start"`
 * so it rides the pane's edge when the sidebar toggles; trailing controls stay put.
 */
export function WorkspacePageHeader({
  electron = false,
  reserveNativeControls = electron,
  contentWidth,
  className,
  ...props
}: ComponentPropsWithoutRef<"header"> & {
  readonly electron?: boolean;
  readonly reserveNativeControls?: boolean;
  /** Centers the header's content on the page frame of this width; see WorkspacePageHeaderContent. */
  readonly contentWidth?: WorkspacePageWidth;
}) {
  return (
    <header
      className={cn(
        "flex h-[var(--workspace-topbar-height)]! min-h-[var(--workspace-topbar-height)]! max-h-[var(--workspace-topbar-height)]! shrink-0 items-center gap-3",
        WORKSPACE_PAGE_HEADER_INSET_CLASS,
        contentWidth && [
          CONTENT_WIDTH_CLASS[contentWidth],
          COLLAPSED_SIDEBAR_TITLEBAR_MIRROR_INSET_CLASS,
        ],
        electron && "drag-region",
        reserveNativeControls && "wco:pr-(--workspace-native-controls-inset)",
        className,
      )}
      {...props}
    />
  );
}
