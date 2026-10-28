import { ExternalLinkIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  decodeThirdPartyLicenseManifest,
  filterThirdPartyLicenseEntries,
  formatLicenseBundles,
  thirdPartyLicenseEntryKey,
  type ThirdPartyLicenseEntry,
  type ThirdPartyLicenseManifest,
} from "@cogenly/shared/thirdPartyLicenses";

import { Button } from "../ui/button";
import { DisclosureChevron } from "../ui/disclosure";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { SearchInput } from "../ui/search-input";
import { SettingsEmpty, SettingsRow, SettingsSection, SettingsToolbar } from "./settingsLayout";

type LicenseManifestState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly manifest: ThirdPartyLicenseManifest };

let licenseManifestPromise: Promise<ThirdPartyLicenseManifest> | undefined;

async function fetchLicenseManifest(): Promise<ThirdPartyLicenseManifest> {
  const signal = AbortSignal.timeout(30_000);
  try {
    const response = await fetch(
      `${import.meta.env.BASE_URL.replace(/\/$/, "")}/third-party-licenses.json`,
      { signal },
    );
    if (!response.ok) {
      throw new Error(
        `The license manifest request failed with status ${String(response.status)}.`,
      );
    }
    return decodeThirdPartyLicenseManifest((await response.json()) as unknown);
  } catch (error) {
    if (signal.aborted) {
      throw new Error("The license manifest took too long to load.", { cause: error });
    }
    throw error;
  }
}

function loadLicenseManifest(): Promise<ThirdPartyLicenseManifest> {
  licenseManifestPromise ??= fetchLicenseManifest().catch((error: unknown) => {
    licenseManifestPromise = undefined;
    throw error;
  });
  return licenseManifestPromise;
}

function LicenseNoticeRow({
  entry,
  open,
  onOpenChange,
}: {
  readonly entry: ThirdPartyLicenseEntry;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <article>
        <div className="flex min-h-10 items-center interactive hover:bg-muted/35 sm:min-h-9">
          <CollapsibleTrigger className="flex min-h-10 min-w-0 flex-1 items-center gap-2.5 rounded-md px-3 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:min-h-9 sm:px-4">
            <DisclosureChevron />
            {/* Narrow pages stack the license under the name instead of squeezing both. */}
            <span className="flex min-w-0 flex-1 flex-col gap-0.5 @min-[36rem]/settings-page:flex-row @min-[36rem]/settings-page:items-baseline @min-[36rem]/settings-page:gap-4">
              <span className="flex min-w-0 flex-1 items-baseline gap-2">
                <span className="truncate font-medium text-foreground">{entry.name}</span>
                {entry.version ? (
                  <code className="shrink-0 text-xs text-muted-foreground">{entry.version}</code>
                ) : null}
              </span>
              <span className="min-w-0 truncate text-xs text-muted-foreground @min-[36rem]/settings-page:max-w-[42%] @min-[36rem]/settings-page:shrink-0">
                {entry.license} · {formatLicenseBundles(entry.bundles)}
              </span>
            </span>
          </CollapsibleTrigger>
          {entry.sourceUrl ? (
            <Button
              aria-label={`View project source for ${entry.name}`}
              className="me-3 shrink-0 sm:me-4"
              render={<a href={entry.sourceUrl} rel="noreferrer noopener" target="_blank" />}
              size="icon-micro"
              title="Project source"
              variant="ghost-muted"
            >
              <ExternalLinkIcon aria-hidden className="size-3" />
            </Button>
          ) : null}
        </div>
        <CollapsiblePanel>
          {open ? (
            <div className="px-9 pt-1 pb-4 sm:px-10">
              <pre className="max-w-[76ch] whitespace-pre-wrap break-words font-mono text-xs/5 text-foreground/80">
                {entry.noticeText}
              </pre>
            </div>
          ) : null}
        </CollapsiblePanel>
      </article>
    </Collapsible>
  );
}

function LicenseCount({
  filteredCount,
  totalCount,
}: {
  filteredCount: number;
  totalCount: number;
}) {
  return (
    <p className="whitespace-nowrap text-xs font-normal text-muted-foreground tabular-nums">
      {filteredCount === totalCount
        ? `${String(totalCount)} notices`
        : `${String(filteredCount)} of ${String(totalCount)}`}
    </p>
  );
}

/** Filter box in the card toolbar: matches package names, versions, licenses and app parts. */
function LicenseSearchInput({
  query,
  onQueryChange,
}: {
  query: string;
  onQueryChange: (value: string) => void;
}) {
  return (
    <SearchInput
      aria-label="Search open-source licenses"
      frameClassName="basis-full sm:basis-0 sm:flex-1"
      onChange={(event) => onQueryChange(event.currentTarget.value)}
      onKeyDown={(event) => {
        // The settings route treats an unhandled Escape as "go back";
        // inside the search box it clears, then leaves the field.
        if (event.key !== "Escape") return;
        event.preventDefault();
        if (query.length > 0) onQueryChange("");
        else event.currentTarget.blur();
      }}
      placeholder="Search by package, version or license"
      value={query}
      clearLabel="Clear license search"
      onClear={() => onQueryChange("")}
    />
  );
}

function LicenseManifestError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <SettingsRow
      title="Open-source notices are unavailable"
      description={message}
      control={
        <Button type="button" size="sm" variant="outline" onClick={onRetry}>
          Try again
        </Button>
      }
    />
  );
}

export function OpenSourceLicensesPanel() {
  // Each attempt is a fresh mount, so a retry starts from "loading" without an effect setting it.
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return <OpenSourceLicensesSection key={attempt} onRetry={retry} />;
}

function OpenSourceLicensesSection({ onRetry }: { readonly onRetry: () => void }) {
  const [state, setState] = useState<LicenseManifestState>({ status: "loading" });
  const [query, setQuery] = useState("");
  const [openEntryKey, setOpenEntryKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadLicenseManifest().then(
      (manifest) => {
        if (!cancelled) setState({ status: "ready", manifest });
      },
      (error: unknown) => {
        if (cancelled) return;
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "The license manifest could not load.",
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const entries = state.status === "ready" ? state.manifest.entries : [];
  const filteredEntries = useMemo(
    () => filterThirdPartyLicenseEntries(entries, query),
    [entries, query],
  );

  return (
    <>
      <SettingsSection
        title="Third-party notices"
        headerAction={
          state.status === "ready" ? (
            <LicenseCount filteredCount={filteredEntries.length} totalCount={entries.length} />
          ) : null
        }
      >
        {state.status === "ready" ? (
          <>
            <SettingsToolbar>
              <LicenseSearchInput query={query} onQueryChange={setQuery} />
            </SettingsToolbar>
            <div className="text-base sm:text-sm">
              {filteredEntries.length > 0 ? (
                filteredEntries.map((entry) => {
                  const entryKey = thirdPartyLicenseEntryKey(entry);
                  return (
                    <LicenseNoticeRow
                      key={entryKey}
                      entry={entry}
                      open={openEntryKey === entryKey}
                      onOpenChange={(open) => setOpenEntryKey(open ? entryKey : null)}
                    />
                  );
                })
              ) : (
                <SettingsEmpty
                  label="No licenses match this search."
                  action={
                    <Button size="xs" variant="outline" onClick={() => setQuery("")}>
                      Clear search
                    </Button>
                  }
                />
              )}
            </div>
          </>
        ) : state.status === "error" ? (
          <LicenseManifestError message={state.message} onRetry={onRetry} />
        ) : (
          <SettingsRow title="Loading open-source notices…" role="status" />
        )}
      </SettingsSection>
    </>
  );
}
