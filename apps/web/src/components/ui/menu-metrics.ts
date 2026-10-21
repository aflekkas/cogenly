/**
 * Placement shared by the Base UI menus (menu.tsx) and the DOM context menu
 * (contextMenuFallback.ts), so every menu and submenu in the app sits alike.
 */

/** The gap every menu keeps from the viewport edge. */
export const MENU_VIEWPORT_MARGIN_PX = 8;

/**
 * A submenu lines its first item up with the trigger row: up by the popup's
 * padding (p-1, 4px) plus its 1px border.
 */
export const SUBMENU_ALIGN_OFFSET_PX = -5;

/** A submenu tucks this far over its parent's edge instead of leaving a gap. */
export const SUBMENU_SIDE_OFFSET_PX = -4;
