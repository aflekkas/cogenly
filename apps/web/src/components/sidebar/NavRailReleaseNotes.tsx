/**
 * Cogenly's release notes in the rail's Updates popover: a few lines of
 * What's new under the hero (the installed release, or what a pending update
 * brings), and the release history, a sub-view in the same frame. Notes come
 * from GitHub (useCogenlyReleases); with none loaded, both stay out of the way.
 */
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, ExternalLinkIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import type { CogenlyReleasesSnapshot } from "~/state/cogenlyReleases";
import { openDesktopUpdateReleaseNotes } from "../desktopUpdate.toast";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import {
  type CogenlyRelease,
  digestReleaseNotes,
  formatReleaseDate,
  formatReleaseDay,
} from "./releaseNotes.logic";

/** Bullets of What's new under the hero: the installed release's, or the pending update's. */
const DIGEST_LIMIT = { installed: 3, pending: 4 } as const;

function itemKeys(items: ReadonlyArray<string>) {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const count = seen.get(item) ?? 0;
    seen.set(item, count + 1);
    return { item, key: `${item}:${count}` };
  });
}

/** Opens GitHub in the system browser on desktop, in a new tab on the web. */
export function GitHubLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="link inline-flex shrink-0 items-center gap-1 rounded-sm text-2xs leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
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

/** A note bullet: a small muted dot, not a list marker, so lines align with the eyebrow. */
function NoteList({ items, className }: { items: ReadonlyArray<string>; className?: string }) {
  return (
    <ul className={cn("flex flex-col", className)}>
      {itemKeys(items).map(({ item, key }) => (
        <li
          key={key}
          className="relative pl-3.5 text-xs leading-4.25 break-words text-popover-foreground/85 before:absolute before:top-[7px] before:left-[3px] before:size-1 before:rounded-full before:bg-muted-foreground/70"
        >
          {item}
        </li>
      ))}
    </ul>
  );
}

/**
 * What's new, under the hero between hairlines: an eyebrow, a few bullets,
 * and a trailing link into the release history. `pending` is an update's
 * releases (newest first); otherwise `releases` is the installed release.
 */
export function WhatsNewNotes({
  releases,
  pending,
  hasEarlier,
  onShowHistory,
}: {
  releases: ReadonlyArray<CogenlyRelease>;
  pending: boolean;
  /** The history holds releases beyond these, so the link says "earlier releases". */
  hasEarlier: boolean;
  onShowHistory: () => void;
}) {
  if (releases.length === 0) return null;
  const { groups, remaining } = digestReleaseNotes(
    releases,
    pending ? DIGEST_LIMIT.pending : DIGEST_LIMIT.installed,
  );
  const single = releases.length === 1 ? releases[0]! : null;
  const day = single ? formatReleaseDay(single.publishedAt) : null;
  const more =
    remaining > 0
      ? hasEarlier
        ? `${remaining} more, and earlier releases`
        : `${remaining} more`
      : hasEarlier
        ? "Earlier releases"
        : "Full release notes";
  return (
    <section aria-label="What's new" className="reveal-motion flex flex-col gap-1.25 pt-2 pb-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-2xs font-medium text-muted-foreground select-none">
          {/* An update's notes say so, so they never read as the running version's. */}
          {single ? (
            <>
              {pending ? "Coming in " : "What's new in "}
              <span className="text-foreground tabular-nums">{single.version}</span>
            </>
          ) : pending ? (
            "Coming in this update"
          ) : (
            "What's new"
          )}
        </span>
        {single ? (
          day ? (
            <span className="text-2xs text-muted-foreground tabular-nums">{day}</span>
          ) : null
        ) : (
          <span className="text-2xs text-muted-foreground tabular-nums">
            {releases.length} releases
          </span>
        )}
      </div>
      {single ? (
        <NoteList items={groups[0]?.items ?? []} className="gap-0.75" />
      ) : (
        groups.map(({ release, items }) => (
          <div key={release.version} className="flex flex-col gap-1 not-first:mt-1">
            <div className="flex items-baseline gap-1.5 text-2xs text-muted-foreground tabular-nums">
              <span className="text-xs font-medium text-foreground">v{release.version}</span>
              {formatReleaseDay(release.publishedAt)}
            </div>
            {items.length > 0 ? <NoteList items={items} className="gap-0.75" /> : null}
          </div>
        ))
      )}
      {groups.every((group) => group.items.length === 0) ? (
        <span className="text-xs text-muted-foreground">No notes for this release.</span>
      ) : null}
      <button
        type="button"
        onClick={onShowHistory}
        className="link inline-flex items-center gap-1 self-start rounded-sm pl-3.5 text-xs leading-4.25 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        {more}
        <ChevronRightIcon aria-hidden className="size-3 shrink-0" strokeWidth={2.25} />
      </button>
    </section>
  );
}

export type ReleaseTone = "installed" | "available" | "older" | "plain";

function ReleaseEntry({ release, tone }: { release: CogenlyRelease; tone: ReleaseTone }) {
  const date = formatReleaseDate(release.publishedAt);
  return (
    <section
      className="flex flex-col gap-1.5 py-2.5 not-first:border-t"
      aria-label={`Cogenly v${release.version}`}
    >
      <div className="flex items-baseline gap-2">
        <h3
          className={cn(
            "text-xs font-semibold tabular-nums",
            tone === "older" && "text-foreground/80",
          )}
        >
          v{release.version}
        </h3>
        {date ? <span className="text-xs text-muted-foreground tabular-nums">{date}</span> : null}
        {tone === "installed" ? (
          <span className="ml-auto inline-flex items-center gap-1 text-2xs font-medium text-success-foreground">
            <CheckIcon aria-hidden className="size-2.75" strokeWidth={2.5} />
            Installed
          </span>
        ) : tone === "available" ? (
          <span className="ml-auto text-2xs font-medium text-info-foreground">Available</span>
        ) : null}
      </div>
      <div className={cn("flex flex-col gap-1.5", tone === "older" && "opacity-80")}>
        {release.sections.length > 0 ? (
          release.sections.map((section) => (
            <div key={section.title ?? "notes"} className="flex flex-col gap-0.5">
              {section.title ? (
                <span className="text-2xs font-medium text-muted-foreground select-none">
                  {section.title}
                </span>
              ) : null}
              <NoteList items={section.items} className="gap-0.5" />
            </div>
          ))
        ) : (
          <span className="text-xs text-muted-foreground">No notes for this release.</span>
        )}
      </div>
    </section>
  );
}

/** The popover's release history view, newest first, in the updates' own frame. */
export function ReleaseHistoryView({
  snapshot,
  releases,
  toneOf,
  historyUrl,
  onBack,
}: {
  snapshot: CogenlyReleasesSnapshot;
  releases: ReadonlyArray<CogenlyRelease>;
  toneOf: (release: CogenlyRelease) => ReleaseTone;
  historyUrl: string | null;
  onBack: () => void;
}) {
  return (
    <div key="releases" className="swap-motion flex flex-col">
      <div className="flex items-center gap-1.5 pb-1.5">
        <Button size="icon-xs" variant="ghost-muted" aria-label="Back to updates" onClick={onBack}>
          <ChevronLeftIcon aria-hidden />
        </Button>
        <span className="text-sm font-medium">Release notes</span>
        {snapshot.loading ? (
          <Spinner size="xs" tone="muted" aria-label="Loading release notes" />
        ) : null}
        {releases.length > 0 ? (
          <span className="ml-auto text-2xs text-muted-foreground tabular-nums">
            {releases.length} {releases.length === 1 ? "release" : "releases"}
          </span>
        ) : null}
      </div>
      <div className="h-px bg-border" />
      {releases.length > 0 ? (
        // The scroller reaches into the popover's right padding, so its scrollbar
        // sits in that gutter (always reserved) and the entries' dividers match the
        // header hairline and footer edge to edge. Its edges fade only toward more
        // notes, clear right against the hairlines.
        <div className="scroll-fade-y -mr-2.5 max-h-[min(24rem,calc(var(--available-height)-7rem))] min-h-0 overflow-y-auto pr-1 [--scroll-fade-hold:--spacing(1.5)] [scrollbar-gutter:stable]">
          {releases.map((release) => (
            <ReleaseEntry key={release.version} release={release} tone={toneOf(release)} />
          ))}
        </div>
      ) : (
        <span
          key={snapshot.loading ? "loading" : "empty"}
          className="swap-motion py-3 text-xs text-muted-foreground"
        >
          {snapshot.loading
            ? "Loading release notes…"
            : snapshot.failed
              ? "Couldn't load release notes."
              : "No release notes yet."}
        </span>
      )}
      <div className="flex min-h-6 items-center justify-between gap-2 border-t pt-2">
        <span className="truncate text-2xs text-muted-foreground">
          Notes come from GitHub releases
        </span>
        {historyUrl ? <GitHubLink href={historyUrl}>All releases on GitHub</GitHubLink> : null}
      </div>
    </div>
  );
}
