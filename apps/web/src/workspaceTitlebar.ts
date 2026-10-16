// Clears the fixed sidebar toggle once the sidebar no longer sits under it.
// With the navigation rail, the toggle sits over the rail, so the header only
// needs what the toggle overhangs past it (macOS traffic lights push it right).
export const COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS =
  "[[data-sidebar-state=collapsed]:not([data-nav-rail])_&]:pl-[var(--workspace-titlebar-content-left)] [[data-sidebar-state=collapsed][data-nav-rail]_&]:pl-[max(var(--workspace-gutter-start),calc(var(--workspace-titlebar-content-left)-var(--nav-rail-width)))] max-md:[[data-sidebar-state=expanded]_&]:pl-[var(--workspace-titlebar-content-left)]";
