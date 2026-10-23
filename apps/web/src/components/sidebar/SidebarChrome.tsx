import { ChartNoAxesColumnIcon, SettingsIcon } from "lucide-react";
import type { ReactNode } from "react";
import { memo, useCallback } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { useEnvironmentIdentificationMode, useLegacySidebarEnabled } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import {
  resolveEnvironmentIdentificationPillLabel,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { Badge } from "../ui/badge";
import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { isSidebarUtilityPage } from "./mainAppLocation";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarUpdateArchitectureWarning, SidebarUpdatePill } from "./SidebarUpdatePill";
import { observeResize } from "~/lib/observeResize";
import { PageTitleSlot } from "../WorkspacePageTitle";
import { settingsReturnHref } from "./modes/spaceRouteMemory";

export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
}: {
  isElectron: boolean;
}) {
  const stageLabel = useEnvironmentStageLabel();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const pillLabel =
    environmentIdentificationMode === "pill"
      ? resolveEnvironmentIdentificationPillLabel(stageLabel)
      : null;
  return (
    // The titlebar row, not a padded SidebarHeader: it aligns to the window controls.
    <div
      className={cn(
        "relative flex h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-2 pr-3",
        isElectron && "drag-region",
      )}
    >
      {/* Match the fixed control's inset and border compensation inside the sheet's safe area. */}
      <div className="relative top-[calc(var(--workspace-controls-top)-env(safe-area-inset-top))] z-10 ml-[calc(var(--workspace-controls-left)+1px-env(safe-area-inset-left))] flex shrink-0 items-center desktop-layout:hidden">
        <SidebarTrigger
          className="relative top-auto translate-y-0"
          aria-label="Toggle main sidebar"
        />
      </div>
      {/* One visible line: the pill wraps onto the clipped second line once it no longer fits. */}
      <div className="relative z-10 flex h-8 min-w-0 flex-1 flex-wrap content-start items-center gap-x-2 overflow-hidden py-0.5">
        {/* The open page's title, after the back/forward pair (WorkspacePageTitle). */}
        <PageTitleSlot className="relative z-10 ml-[max(var(--sidebar-content-inset),calc(var(--workspace-titlebar-content-left)-var(--nav-rail-width,0px)))] hidden h-7 min-w-0 flex-1 items-center overflow-hidden text-foreground desktop-layout:flex *:max-w-full!" />
        {pillLabel ? (
          <div className="ml-1 flex h-7 items-center">
            <Badge data-environment-identification="pill" size="sm" variant="secondary">
              {pillLabel}
            </Badge>
          </div>
        ) : null}
      </div>
    </div>
  );
});

// Measures the header title at its titlebar inset, plus the header's right padding and the
// sidebar border, so the sidebar minimum follows font size, zoom and macOS window controls.
export function SidebarBrandWidthProbe({
  onWidthChange,
}: {
  onWidthChange: (width: number) => void;
}) {
  const observeWidth = useCallback(
    (probe: HTMLDivElement) => {
      return observeResize(probe, ([entry]) => {
        if (entry) onWidthChange(entry.borderBoxSize[0]?.inlineSize ?? probe.offsetWidth);
      });
    },
    [onWidthChange],
  );

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none invisible fixed top-0 left-0 flex w-max border-r border-transparent pr-3"
      ref={observeWidth}
    >
      <div className="ml-[max(var(--sidebar-content-inset),calc(var(--workspace-titlebar-content-left)-var(--nav-rail-width,0px)))] flex">
        {/* The longest title the header can show, so the minimum width doesn't jump between modes. */}
        <SidebarTitleText label="Settings" />
      </div>
    </div>
  );
}

function SidebarTitleText({ label }: { label: string }) {
  return (
    // Center the visible capitals, without the font's ascender/descender space.
    // Padding keeps ascenders and round-letter overshoot inside the truncation clip.
    <span className="inline-flex min-w-0 items-baseline text-sm font-medium tracking-tight">
      <span className="truncate [text-box:trim-both_cap_alphabetic] supports-[text-box:trim-both_cap_alphabetic]:py-1">
        {label}
      </span>
    </span>
  );
}

function SidebarUtilityItem({
  icon,
  isActive = false,
  label,
  onClick,
}: {
  icon: ReactNode;
  isActive?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              aria-current={isActive ? "page" : undefined}
              aria-label={label}
              isActive={isActive}
              onClick={onClick}
              size="icon"
            >
              {icon}
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}

export const SidebarUtilityMenu = memo(function SidebarUtilityMenu() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  // Matches AppSidebarLayout: the rail already shows Settings as current.
  const legacySidebarEnabled = useLegacySidebarEnabled();
  const navRailVisible = !isMobile && !legacySidebarEnabled;
  const isOnUtilityPage = useLocation({
    select: (location) => isSidebarUtilityPage(location.pathname),
  });
  const isOnSettings = useLocation({
    select: (location) =>
      location.pathname === "/settings" || location.pathname.startsWith("/settings/"),
  });
  const closeMobileSidebar = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
  }, [isMobile, setOpenMobile]);
  const handleSettingsClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({ href: settingsReturnHref() });
  }, [closeMobileSidebar, navigate]);
  const handleUsageClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({ to: "/usage" });
  }, [closeMobileSidebar, navigate]);

  return (
    <SidebarMenu className="flex-row items-center">
      {isOnUtilityPage ? (
        // The rail (or Escape) leads back; without the rail only Settings stays.
        navRailVisible ? null : (
          <SidebarUtilityItem
            icon={<SettingsIcon />}
            isActive={isOnSettings}
            label="Settings"
            onClick={handleSettingsClick}
          />
        )
      ) : (
        <>
          <SidebarMenuItem className="min-w-0 flex-1">
            <SidebarMenuButton aria-label="Settings" onClick={handleSettingsClick}>
              <SettingsIcon />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarUtilityItem
            icon={<ChartNoAxesColumnIcon />}
            label="Usage"
            onClick={handleUsageClick}
          />
        </>
      )}
      {/* The rail's Updates button carries updates beside the rail. */}
      {navRailVisible ? null : <SidebarUpdatePill />}
    </SidebarMenu>
  );
});

export const SidebarChromeFooter = memo(function SidebarChromeFooter({
  utilityMenu = true,
}: {
  /** False beside the navigation rail, which carries Settings, Usage and Updates itself. */
  utilityMenu?: boolean;
}) {
  return (
    <SidebarFooter className={cn(!utilityMenu && "empty:hidden")}>
      {utilityMenu ? <SidebarProviderUpdatePill /> : null}
      <SidebarUpdateArchitectureWarning />
      {utilityMenu ? <SidebarUtilityMenu /> : null}
    </SidebarFooter>
  );
});
