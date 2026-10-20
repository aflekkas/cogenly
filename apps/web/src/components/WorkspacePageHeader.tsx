import type { ComponentPropsWithoutRef } from "react";

import { cn } from "../lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../workspaceTitlebar";

// Beside the rail with no list column (Projects, Usage, an empty Agents list),
// the leading title takes the list column title's inset, so the mode title
// sits where it does in Chats and Work. Three attributes outrank the collapsed
// inset, which also applies when the column was collapsed before.
const LIST_COLUMN_HIDDEN_TITLE_INSET_CLASS =
  "[[data-nav-rail][data-list-column-hidden][data-sidebar-state]_&]:pl-[max(var(--sidebar-content-inset),calc(var(--workspace-titlebar-content-left)-var(--nav-rail-width)))]";

/**
 * Shared workspace top-bar geometry. The height is `!important` so callers cannot
 * grow the bar and pull its content off the sidebar header's center line.
 * A leading title that isn't a WorkspaceBreadcrumb carries `data-panel-flip="start"`
 * so it rides the pane's edge when the sidebar toggles; trailing controls stay put.
 */
export function WorkspacePageHeader({
  electron = false,
  reserveNativeControls = electron,
  className,
  ...props
}: ComponentPropsWithoutRef<"header"> & {
  readonly electron?: boolean;
  readonly reserveNativeControls?: boolean;
}) {
  return (
    <header
      className={cn(
        "flex h-[var(--workspace-topbar-height)]! min-h-[var(--workspace-topbar-height)]! max-h-[var(--workspace-topbar-height)]! shrink-0 items-center gap-3 pl-(--workspace-gutter-start) pr-(--workspace-gutter-end)",
        electron && "drag-region",
        reserveNativeControls && "wco:pr-(--workspace-native-controls-inset)",
        COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        LIST_COLUMN_HIDDEN_TITLE_INSET_CLASS,
        className,
      )}
      {...props}
    />
  );
}
