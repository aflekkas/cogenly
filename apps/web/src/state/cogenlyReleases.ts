import { useEffect, useSyncExternalStore } from "react";

import { type CogenlyRelease, parseGitHubReleases } from "~/components/sidebar/releaseNotes.logic";
import { resolveStorage } from "~/lib/storage";

/**
 * Cogenly's release notes from the public GitHub Releases API, for the rail's
 * Updates popover. Unauthenticated requests get 60 an hour per IP, so this
 * fetches only when the popover may open (app start, hovering or focusing its
 * button, opening it) and at most every half hour. The last
 * good list is kept in localStorage, so the notes still show offline; failures
 * stay quiet and keep whatever was there.
 */
const RELEASES_URL = "https://api.github.com/repos/aflekkas/cogenly/releases?per_page=30";
const STORAGE_KEY = "cogenly:release-notes:v1";
const FRESH_MS = 30 * 60_000;
const RETRY_MS = 2 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

export interface CogenlyReleasesSnapshot {
  /** Null until a list has loaded once, here or in an earlier session. */
  readonly releases: ReadonlyArray<CogenlyRelease> | null;
  readonly loading: boolean;
  /** The latest request failed; `releases` is whatever was cached. */
  readonly failed: boolean;
}

interface StoredReleases {
  readonly fetchedAt: number;
  readonly releases: ReadonlyArray<CogenlyRelease>;
}

function storage() {
  try {
    return resolveStorage(typeof window === "undefined" ? null : window.localStorage);
  } catch {
    return resolveStorage(null);
  }
}

function readStored(): StoredReleases | null {
  try {
    const raw = storage().getItem(STORAGE_KEY);
    if (typeof raw !== "string") return null;
    const parsed = JSON.parse(raw) as Partial<StoredReleases>;
    return typeof parsed.fetchedAt === "number" && Array.isArray(parsed.releases)
      ? { fetchedAt: parsed.fetchedAt, releases: parsed.releases }
      : null;
  } catch {
    return null;
  }
}

const stored = readStored();
let fetchedAt = stored?.fetchedAt ?? 0;
let attemptedAt = 0;
let snapshot: CogenlyReleasesSnapshot = {
  releases: stored?.releases ?? null,
  loading: false,
  failed: false,
};
const listeners = new Set<() => void>();

function publish(next: Partial<CogenlyReleasesSnapshot>) {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
}

async function fetchReleases(): Promise<ReadonlyArray<CogenlyRelease>> {
  const response = await fetch(RELEASES_URL, {
    headers: { Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GitHub releases request failed: ${response.status}`);
  return parseGitHubReleases((await response.json()) as unknown);
}

/** Fetches the list unless it is fresh, already loading, or just failed. */
export function refreshCogenlyReleases(now = Date.now()): void {
  if (snapshot.loading) return;
  if (now - fetchedAt < FRESH_MS || now - attemptedAt < RETRY_MS) return;
  attemptedAt = now;
  publish({ loading: true });
  fetchReleases().then(
    (releases) => {
      fetchedAt = Date.now();
      try {
        storage().setItem(STORAGE_KEY, JSON.stringify({ fetchedAt, releases }));
      } catch {
        // A full or blocked storage only costs the offline copy.
      }
      publish({ releases, loading: false, failed: false });
    },
    () => publish({ loading: false, failed: true }),
  );
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The release list; refreshes it whenever `active` turns on (the popover opens). */
export function useCogenlyReleases(active: boolean): CogenlyReleasesSnapshot {
  useEffect(() => {
    if (active) refreshCogenlyReleases();
  }, [active]);
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot,
  );
}
