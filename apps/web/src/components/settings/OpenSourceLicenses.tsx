import { ExternalLinkIcon, SearchXIcon } from "lucide-react";
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
import { DisclosurePanel } from "../ui/disclosure";
import { SearchInput } from "../ui/search-input";
import {
  SettingsDenseRow,
  SettingsEmpty,
  SettingsRow,
  SettingsSection,
  SettingsToolbar,
} from "./settingsLayout";

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
    <article>
      <SettingsDenseRow
        disclosure={{ open, onOpenChange }}
        title={entry.name}
        titleActions={
          entry.version ? (
            <code className="text-xs text-muted-foreground">{entry.version}</code>
          ) : null
        }
        meta={`${entry.license} · ${formatLicenseBundles(entry.bundles)}`}
        control={
          entry.sourceUrl ? (
            <Button
              aria-label={`View project source for ${entry.name}`}
              render={<a href={entry.sourceUrl} rel="noreferrer noopener" target="_blank" />}
              size="icon-micro"
              title="Project source"
              variant="ghost-muted"
            >
              <ExternalLinkIcon aria-hidden className="size-3" />
            </Button>
          ) : null
        }
      />
      {/* Holds the notice while it folds away; closed notices never mount. */}
      <DisclosurePanel open={open}>
        {/* Indented to the name, past the row's inset and the chevron. */}
        <div className="ps-7.5 pe-3 pt-1 pb-4 sm:ps-8.5 sm:pe-4">
          <pre className="max-w-[76ch] whitespace-pre-wrap break-words font-mono text-xs/5 text-foreground/80">
            {entry.noticeText}
          </pre>
        </div>
      </DisclosurePanel>
    </article>
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
                  icon={<SearchXIcon />}
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
