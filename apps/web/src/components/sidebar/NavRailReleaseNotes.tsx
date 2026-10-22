/**
 * Cogenly's release notes in the rail's Updates popover: what an available
 * update brings, under the app's row, and the release history, a sub-view
 * opened from that row. Notes come from GitHub (useCogenlyReleases); with
 * none loaded, both stay out of the way.
 */
import { ChevronLeftIcon, ExternalLinkIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import type { CogenlyReleasesSnapshot } from "~/state/cogenlyReleases";
import { getDesktopUpdateReleaseHistoryUrl } from "../desktopUpdate.logic";
import { openDesktopUpdateReleaseNotes } from "../desktopUpdate.toast";
import { Button } from "../ui/button";
import { Separator } from "../ui/separator";
import { Spinner } from "../ui/spinner";
import { type CogenlyRelease, formatReleaseDate } from "./releaseNotes.logic";

function itemKeys(items: ReadonlyArray<string>) {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const count = seen.get(item) ?? 0;
    seen.set(item, count + 1);
    return { item, key: `${item}:${count}` };
  });
}

/** Opens GitHub in the system browser on desktop, in a new tab on the web. */
function GitHubLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="link inline-flex items-center gap-1 rounded-sm text-xs leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      onClick={(event) => {
        const bridge = window.desktopBridge;
        if (!bridge) return;
        event.preventDefault();
        void openDesktopUpdateReleaseNotes(bridge, href);
      }}
    >
      {children}
      <ExternalLinkIcon aria-hidden className="size-3 shrink-0" strokeWidth={2.25} />
    </a>
  );
}

function ReleaseEntry({ release, installed }: { release: CogenlyRelease; installed: boolean }) {
  const date = formatReleaseDate(release.publishedAt);
  return (
    <section className="flex flex-col gap-1.5" aria-label={`Cogenly v${release.version}`}>
      <div className="flex items-baseline gap-1.5">
        <h3 className="text-xs font-semibold tabular-nums">v{release.version}</h3>
        {date ? <span className="text-xs text-muted-foreground tabular-nums">{date}</span> : null}
        {installed ? (
          <span className="ml-auto text-2xs font-medium text-muted-foreground">Installed</span>
        ) : null}
      </div>
      {release.sections.length > 0 ? (
        release.sections.map((section) => (
          <div key={section.title ?? "notes"} className="flex flex-col gap-0.5">
            {section.title ? (
              <span className="text-2xs font-medium text-muted-foreground select-none">
                {section.title}
              </span>
            ) : null}
            <ul className="flex flex-col gap-0.5 pl-4 text-xs leading-5 text-popover-foreground/90">
              {itemKeys(section.items).map(({ item, key }) => (
                <li key={key} className="list-disc break-words">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        ))
      ) : (
        <span className="text-xs text-muted-foreground">No notes for this release.</span>
      )}
      <GitHubLink href={release.url}>View on GitHub</GitHubLink>
    </section>
  );
}

function ReleaseList({
  releases,
  installedVersion,
  className,
}: {
  releases: ReadonlyArray<CogenlyRelease>;
  installedVersion: string | null;
  className: string;
}) {
  return (
    <div className={cn("scroll-fade-y min-h-0 overflow-y-auto", className)}>
      {releases.map((release, index) => (
        <div key={release.version}>
          {index > 0 ? <Separator className="my-2.5" /> : null}
          <ReleaseEntry release={release} installed={release.version === installedVersion} />
        </div>
      ))}
    </div>
  );
}

/** Under the app's row while an update is available: every release it brings. */
export function UpdateReleaseNotes({
  releases,
  onShowHistory,
}: {
  releases: ReadonlyArray<CogenlyRelease>;
  onShowHistory: () => void;
}) {
  if (releases.length === 0) return null;
  return (
    <div className="reveal-motion mb-1.5 flex flex-col gap-1.5 rounded-lg bg-muted/48 px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-2xs font-medium text-muted-foreground select-none">What's new</span>
        <Button size="xs" variant="ghost-muted" onClick={onShowHistory}>
          All releases
        </Button>
      </div>
      <ReleaseList releases={releases} installedVersion={null} className="max-h-48" />
    </div>
  );
}

/** The popover's release history view, current release first. */
export function ReleaseHistoryView({
  snapshot,
  releases,
  installedVersion,
  onBack,
}: {
  snapshot: CogenlyReleasesSnapshot;
  releases: ReadonlyArray<CogenlyRelease>;
  installedVersion: string | null;
  onBack: () => void;
}) {
  const historyUrl = getDesktopUpdateReleaseHistoryUrl();
  return (
    <div className="swap-motion flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <Button size="icon-xs" variant="ghost-muted" aria-label="Back to updates" onClick={onBack}>
          <ChevronLeftIcon aria-hidden />
        </Button>
        <span className="text-sm font-medium">What's new</span>
        {snapshot.loading ? (
          <Spinner size="xs" tone="muted" aria-label="Loading release notes" />
        ) : null}
      </div>
      {releases.length > 0 ? (
        <ReleaseList
          releases={releases}
          installedVersion={installedVersion}
          className="max-h-[min(24rem,calc(var(--available-height)-7rem))] pr-1"
        />
      ) : (
        <span
          key={snapshot.loading ? "loading" : "empty"}
          className="swap-motion py-2 text-xs text-muted-foreground"
        >
          {snapshot.loading
            ? "Loading release notes…"
            : snapshot.failed
              ? "Couldn't load release notes."
              : "No release notes yet."}
        </span>
      )}
      {historyUrl ? (
        <div className="flex justify-end border-t pt-1.5">
          <GitHubLink href={historyUrl}>All releases on GitHub</GitHubLink>
        </div>
      ) : null}
    </div>
  );
}
