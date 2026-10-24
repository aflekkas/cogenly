"use client";

import {
  SITE_PERMISSIONS,
  type BrowserAppearanceSetting,
  type DesktopPreviewColorScheme,
  type SitePermission,
  type SitePermissionSetting,
  type SitePermissionsState,
} from "@t3tools/contracts";
import { Minus, MoreVertical, Plus as PlusIcon, RotateCcw } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuGroup,
  MenuGroupLabel,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import {
  SITE_PERMISSION_LABELS,
  SITE_PERMISSION_SETTING_LABELS,
  siteHost,
  siteSettingSummary,
} from "./sitePermissions.logic";

const SITE_PERMISSION_SETTINGS: ReadonlyArray<SitePermissionSetting> = ["allow", "ask", "block"];

const COLOR_SCHEME_OPTIONS: ReadonlyArray<{
  value: BrowserAppearanceSetting;
  label: string;
}> = [
  { value: "match", label: "Match Cogenly" },
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/**
 * What the menu's items do for the active tab. Desktop tabs run them through
 * the desktop bridge; server tabs, whether streamed or rendered natively by
 * the desktop app, run them through the environment server.
 */
export interface PreviewMoreMenuActions {
  readonly hardReload: () => void;
  readonly setColorScheme: (colorScheme: DesktopPreviewColorScheme) => void;
  readonly zoomIn: () => void;
  readonly zoomOut: () => void;
  readonly resetZoom: () => void;
  readonly clearCookies: () => void;
  readonly clearCache: () => void;
  /** Absent where there is no inspector to open, such as a streamed server tab. */
  readonly openDevTools?: () => void;
  /** Absent where the tab cannot get its own window. */
  readonly toggleNativePictureInPicture?: () => void;
  /** Absent where the page is not the desktop's own, such as a streamed server tab. */
  readonly sitePermissions?: {
    readonly read: () => Promise<SitePermissionsState>;
    /** Resolves to the site's permissions afterward, or null when nothing could be changed. */
    readonly change: (
      permission: SitePermission,
      setting: SitePermissionSetting,
    ) => Promise<SitePermissionsState | null>;
  };
}

interface Props {
  /** False until the tab can take these actions, such as before its page attaches. */
  enabled: boolean;
  actions: PreviewMoreMenuActions;
  /** Current zoom factor as a number (1.0 = 100%). */
  zoomFactor: number;
  /** The tab's appearance choice: "match" follows the app's theme, the rest emulate `prefers-color-scheme`. */
  appearance: BrowserAppearanceSetting;
  onAppearanceChange: (appearance: BrowserAppearanceSetting) => void;
  /** Fixed viewport modes expose the device toolbar and resize rails. */
  deviceToolbarVisible: boolean;
  /** Switches between fill-panel mode and a fixed responsive viewport. */
  onToggleDeviceToolbar: () => void;
  /** Whether the separate native always-on-top preview window is open. */
  nativePictureInPicture: boolean;
  /** Profile display name, shown so the menu says which data is being cleared. */
  profileName: string | undefined;
  /** Reopens the tab in the other browser it can run in. */
  move?: { readonly label: string; readonly onMove: () => void };
}

const MenuTriggerButton = () => (
  <Tooltip>
    <TooltipTrigger
      render={
        <MenuTrigger
          render={<Button variant="ghost" size="icon-sm" type="button" aria-label="Preview menu" />}
        />
      }
    >
      <MoreVertical />
    </TooltipTrigger>
    <TooltipPopup>More</TooltipPopup>
  </Tooltip>
);

/**
 * What the current site may use, one row per permission with its setting at the
 * right; each row opens Allow, Ask and Block, so every change is reversible.
 */
function SitePermissionsSubmenu(props: {
  readonly disabled: boolean;
  readonly state: SitePermissionsState | null;
  readonly onChange: (permission: SitePermission, setting: SitePermissionSetting) => void;
}) {
  const host = siteHost(props.state?.origin ?? null);
  const entries = new Map(props.state?.entries.map((entry) => [entry.permission, entry]));
  return (
    <MenuSub>
      <MenuSubTrigger disabled={props.disabled || host === null}>Site permissions</MenuSubTrigger>
      <MenuSubPopup>
        <MenuGroup>
          <MenuGroupLabel className="max-w-72">
            <span className="block truncate">{host}</span>
          </MenuGroupLabel>
          {SITE_PERMISSIONS.map((permission) => {
            const entry = entries.get(permission);
            const setting = entry?.setting ?? "ask";
            return (
              <MenuSub key={permission}>
                <MenuSubTrigger>
                  <span className="flex w-full items-center justify-between gap-6">
                    <span>{SITE_PERMISSION_LABELS[permission]}</span>
                    <span className="text-xs text-muted-foreground">
                      {entry ? siteSettingSummary(entry) : SITE_PERMISSION_SETTING_LABELS.ask}
                    </span>
                  </span>
                </MenuSubTrigger>
                <MenuSubPopup>
                  <MenuRadioGroup
                    value={setting}
                    onValueChange={(value) =>
                      props.onChange(permission, value as SitePermissionSetting)
                    }
                  >
                    {SITE_PERMISSION_SETTINGS.map((option) => (
                      <MenuRadioItem key={option} value={option}>
                        {SITE_PERMISSION_SETTING_LABELS[option]}
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                </MenuSubPopup>
              </MenuSub>
            );
          })}
        </MenuGroup>
      </MenuSubPopup>
    </MenuSub>
  );
}

/** Three-dot menu in the chrome row; the same items for every kind of tab. */
export function PreviewMoreMenu({
  enabled,
  actions,
  zoomFactor,
  appearance,
  onAppearanceChange,
  deviceToolbarVisible,
  onToggleDeviceToolbar,
  nativePictureInPicture,
  profileName,
  move,
}: Props) {
  const zoomLabel = `${Math.round(zoomFactor * 100)}%`;
  const disabled = !enabled;
  const sitePermissions = actions.sitePermissions;
  // Read when the menu opens, so it shows decisions an agent made since.
  const [siteState, setSiteState] = useState<SitePermissionsState | null>(null);
  return (
    <Menu
      onOpenChange={(open) => {
        if (!open || !sitePermissions) return;
        void sitePermissions.read().then(setSiteState, () => setSiteState(null));
      }}
    >
      <MenuTriggerButton />
      <MenuPopup align="end" sideOffset={6}>
        <MenuItem onClick={actions.hardReload} disabled={disabled}>
          Hard reload
        </MenuItem>
        {actions.openDevTools ? (
          <MenuItem onClick={actions.openDevTools} disabled={disabled}>
            Open DevTools
          </MenuItem>
        ) : null}
        {actions.toggleNativePictureInPicture ? (
          <MenuItem onClick={actions.toggleNativePictureInPicture} disabled={disabled}>
            {nativePictureInPicture
              ? "Close separate preview window"
              : "Open separate preview window"}
          </MenuItem>
        ) : null}
        {move ? <MenuItem onClick={move.onMove}>{move.label}</MenuItem> : null}
        <MenuItem onClick={onToggleDeviceToolbar} disabled={disabled}>
          {deviceToolbarVisible ? "Hide device toolbar" : "Show device toolbar"}
        </MenuItem>
        <MenuSub>
          <MenuSubTrigger disabled={disabled}>Appearance</MenuSubTrigger>
          <MenuSubPopup>
            <MenuRadioGroup
              value={appearance}
              onValueChange={(value) => onAppearanceChange(value as BrowserAppearanceSetting)}
            >
              {COLOR_SCHEME_OPTIONS.map((option) => (
                <MenuRadioItem key={option.value} value={option.value}>
                  {option.label}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuSubPopup>
        </MenuSub>
        {sitePermissions ? (
          <SitePermissionsSubmenu
            disabled={disabled}
            state={siteState}
            onChange={(permission, setting) =>
              void sitePermissions.change(permission, setting).then(
                (next) => {
                  if (next) setSiteState(next);
                },
                () => undefined,
              )
            }
          />
        ) : null}
        <MenuSeparator />
        {/*
          Zoom row: label + inline control cluster. `closeOnClick=false`
          keeps the menu open while the user clicks the +/− buttons.
        */}
        <MenuItem
          closeOnClick={false}
          onClick={(event: React.MouseEvent) => event.preventDefault()}
          className="justify-between"
          disabled={disabled}
        >
          <span>Zoom</span>
          <span className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon-xs"
              type="button"
              onClick={actions.zoomOut}
              aria-label="Zoom out"
              disabled={disabled}
            >
              <Minus />
            </Button>
            <span className="min-w-12 text-center text-xs tabular-nums text-muted-foreground">
              {zoomLabel}
            </span>
            <Button
              variant="outline"
              size="icon-xs"
              type="button"
              onClick={actions.zoomIn}
              aria-label="Zoom in"
              disabled={disabled}
            >
              <PlusIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              type="button"
              onClick={actions.resetZoom}
              aria-label="Reset zoom"
              disabled={disabled}
            >
              <RotateCcw />
            </Button>
          </span>
        </MenuItem>
        <MenuSeparator />
        {/*
          Grouped so the heading has a `MenuGroup` ancestor — `MenuGroupLabel`
          reads its context and throws without one. The heading also answers
          which profile the tab is in, which is otherwise invisible: it is fixed
          at open and nothing else in the chrome shows it.
        */}
        <MenuGroup>
          {profileName ? (
            // Truncation needs a block box: `text-overflow` on an inline child
            // never applies and a long name would push the popup past its width.
            <MenuGroupLabel className="max-w-64">
              <span className="block truncate">Profile: {profileName}</span>
            </MenuGroupLabel>
          ) : null}
          <MenuItem onClick={actions.clearCookies}>Clear cookies</MenuItem>
          <MenuItem onClick={actions.clearCache}>Clear cache</MenuItem>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
