import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { refreshUsageLimits } from "@t3tools/client-runtime/state/usage";
import { ChevronDownIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { isElectron } from "../../env";
import { useEscapeToGoBack } from "../../hooks/useNavigateBack";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Menu, MenuCheckboxItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { RefreshIcon } from "../ui/refresh-icon";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { PageContent } from "../PageContent";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { UsageLimitsSection } from "./UsageLimits";

interface LimitsEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

/**
 * Subscription limits per provider, pooled across environments. Each
 * environment reports the accounts signed in on its own machine, so with more
 * than one environment the breadcrumb can narrow the pool to some of them.
 */
export function UsagePage() {
  useEscapeToGoBack();
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const [selectedEnvironmentIds, setSelectedEnvironmentIds] =
    useState<ReadonlySet<EnvironmentId> | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [limitsNow, setLimitsNow] = useState(() => Date.now());
  const refreshingRef = useRef(false);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });

  const environments: readonly LimitsEnvironment[] = [...presentations].map(
    ([environmentId, presentation]) => ({
      environmentId,
      label: presentation.entry.target.label,
    }),
  );

  const refreshLimits = async (automatic = false) => {
    try {
      await Promise.all(
        Array.from(presentations, ([environmentId, presentation]) => {
          if (selectedEnvironmentIds !== null && !selectedEnvironmentIds.has(environmentId)) return;
          if (presentation.connection.phase === "connected" && presentation.serverConfig !== null) {
            return refreshUsageLimits(
              environmentId,
              () => refreshProviders({ environmentId, input: {} }),
              automatic,
            );
          }
        }),
      );
    } finally {
      setLimitsNow(Date.now());
    }
  };

  const refresh = () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setIsRefreshing(true);
    void refreshLimits().finally(() => {
      refreshingRef.current = false;
      setIsRefreshing(false);
    });
  };

  // Opening the page, or connecting another selected environment, checks
  // limits automatically; refreshUsageLimits rate-limits those checks.
  const connectedEnvironments = [...presentations]
    .filter(
      ([environmentId, presentation]) =>
        presentation.connection.phase === "connected" &&
        presentation.serverConfig !== null &&
        (selectedEnvironmentIds === null || selectedEnvironmentIds.has(environmentId)),
    )
    .map(([environmentId]) => environmentId)
    .sort()
    .join(",");
  const autoRefreshLimits = useEffectEvent(() => {
    void refreshLimits(true);
  });
  useEffect(() => {
    if (connectedEnvironments) autoRefreshLimits();
  }, [connectedEnvironments]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <div className="flex w-full min-w-0 items-center gap-3 py-2">
            <WorkspaceBreadcrumb ariaLabel="Usage limits breadcrumb" className="min-w-0">
              <WorkspaceBreadcrumbItem current={environments.length <= 1}>
                <h1>Usage limits</h1>
              </WorkspaceBreadcrumbItem>
              {environments.length > 1 ? (
                <>
                  <WorkspaceBreadcrumbSeparator />
                  <WorkspaceBreadcrumbItem current className="min-w-10">
                    <LimitsEnvironmentFilter
                      environments={environments}
                      selectedEnvironmentIds={selectedEnvironmentIds}
                      onSelectionChange={(ids) => {
                        setSelectedEnvironmentIds(ids);
                        setLimitsNow(Date.now());
                      }}
                    />
                  </WorkspaceBreadcrumbItem>
                </>
              ) : null}
            </WorkspaceBreadcrumb>
            <Button
              className="ms-auto"
              onClick={refresh}
              aria-label="Refresh limits"
              aria-busy={isRefreshing}
              disabled={isRefreshing}
              size="icon-sm"
              variant="ghost"
            >
              <RefreshIcon size="sm" refreshing={isRefreshing} />
            </Button>
          </div>
        </WorkspacePageHeader>

        {/* The page's buttons and rows give keyboard access, so the viewport
            stays out of the tab order and never frames the whole page. */}
        <ScrollArea className="min-h-0 flex-1" viewportTabIndex={-1}>
          <PageContent>
            {environments.length === 0 ? (
              <p className="text-sm text-muted-foreground">Connect an environment to see limits.</p>
            ) : (
              <UsageLimitsSection selectedEnvironmentIds={selectedEnvironmentIds} now={limitsNow} />
            )}
          </PageContent>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

/**
 * "All environments" and individual environments are exclusive: picking one
 * out of "All" narrows to it, and clearing the last one, or picking every one,
 * goes back to "All".
 */
function LimitsEnvironmentFilter({
  environments,
  selectedEnvironmentIds,
  onSelectionChange,
}: {
  readonly environments: readonly LimitsEnvironment[];
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly onSelectionChange: (ids: ReadonlySet<EnvironmentId> | null) => void;
}) {
  const allSelected = selectedEnvironmentIds === null;
  const selected = environments.filter(
    (environment) => selectedEnvironmentIds?.has(environment.environmentId) === true,
  );
  const label = allSelected
    ? "All environments"
    : selected.length === 1
      ? selected[0]!.label
      : `${selected.length} environments`;

  return (
    <Menu>
      <MenuTrigger
        render={<Button variant="ghost" size="sm" />}
        className="-mx-2 min-w-0 max-w-full shrink"
      >
        <WorkspaceBreadcrumbText>{label}</WorkspaceBreadcrumbText>
        <ChevronDownIcon className="size-3.5" aria-hidden />
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuCheckboxItem
          checked={allSelected}
          closeOnClick={false}
          onCheckedChange={() => onSelectionChange(null)}
        >
          All environments
        </MenuCheckboxItem>
        <MenuSeparator />
        {environments.map((environment) => (
          <MenuCheckboxItem
            key={environment.environmentId}
            checked={selectedEnvironmentIds?.has(environment.environmentId) === true}
            closeOnClick={false}
            onCheckedChange={(checked) => {
              const next = new Set(selectedEnvironmentIds);
              if (checked) next.add(environment.environmentId);
              else next.delete(environment.environmentId);
              onSelectionChange(next.size === 0 || next.size === environments.length ? null : next);
            }}
          >
            <span className="truncate">{environment.label}</span>
          </MenuCheckboxItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}
