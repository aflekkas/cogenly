import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { Globe } from "lucide-react";

import type { BrowserHistoryEntry } from "~/browserHistoryStore";
import { DiscoveryList } from "../ui/discovery-list";

import { PreviewLocalServerCard } from "./PreviewLocalServerCard";
import { PreviewRecentUrlCard } from "./PreviewRecentUrlCard";
import { useDiscoveredLocalServers } from "./useDiscoveredLocalServers";

interface Props {
  threadRef: ScopedThreadRef;
  environmentId: EnvironmentId;
  configuredUrls?: ReadonlyArray<string> | undefined;
  recentEntries: ReadonlyArray<BrowserHistoryEntry>;
  onRemoveRecent: (url: string) => void;
  onOpenUrl: (url: string) => void;
}

/**
 * A fresh browser tab. With nothing to offer it is one quiet line, in the
 * same voice as the panel's own "Nothing open" state; with local servers or
 * history it lists them as rows to open.
 */
export function PreviewEmptyState({
  threadRef,
  environmentId,
  configuredUrls,
  recentEntries,
  onRemoveRecent,
  onOpenUrl,
}: Props) {
  const servers = useDiscoveredLocalServers({
    environmentId,
    configuredUrls,
  });
  const recents = recentEntries.filter((entry) => URL.canParse(entry.url)).slice(0, 8);

  if (servers.length === 0 && recents.length === 0) {
    return (
      <div
        // Fills the surface body outright: it sits beside an absolutely placed
        // page surface, so it takes the same box rather than a percentage height.
        className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-6 pb-(--workspace-topbar-height) text-center"
        data-preview-empty-state
      >
        <Globe className="mb-1 size-4 text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">No preview yet</p>
        <p className="text-xs text-muted-foreground">
          Enter a URL, or start a dev server and it will appear here.
        </p>
      </div>
    );
  }

  return (
    <div
      className="scroll-fade-y scrollbar-gutter-both absolute inset-0 flex overflow-y-auto px-4 py-5"
      data-preview-empty-state
    >
      <div className="mx-auto flex w-full max-w-md flex-col gap-5">
        {servers.length > 0 ? (
          <section className="flex flex-col gap-2">
            <h2 className="px-1 text-xs font-medium text-muted-foreground">Local servers</h2>
            <DiscoveryList>
              {servers.map((server) => (
                <PreviewLocalServerCard
                  key={`${server.host}:${server.port}`}
                  threadRef={threadRef}
                  server={server}
                  onOpen={() => onOpenUrl(server.requestedUrl)}
                />
              ))}
            </DiscoveryList>
          </section>
        ) : null}
        {recents.length > 0 ? (
          <section className="flex flex-col gap-2">
            <h2 className="px-1 text-xs font-medium text-muted-foreground">Recent</h2>
            <DiscoveryList>
              {recents.map((entry) => (
                <PreviewRecentUrlCard
                  key={entry.url}
                  threadRef={threadRef}
                  entry={entry}
                  onOpen={() => onOpenUrl(entry.url)}
                  onRemove={() => onRemoveRecent(entry.url)}
                />
              ))}
            </DiscoveryList>
          </section>
        ) : null}
      </div>
    </div>
  );
}
