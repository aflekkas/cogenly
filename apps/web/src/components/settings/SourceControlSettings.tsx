import { RefreshIcon } from "~/components/ui/refresh-icon";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import { createElement, type ReactNode } from "react";
import type {
  BackgroundActivitySettings,
  SourceControlDiscoveryResult,
  SourceControlProviderAuth,
  SourceControlProviderDiscoveryItem,
  VcsDriverKind,
  VcsDiscoveryItem,
} from "@cogenly/contracts";
import {
  getBackgroundActivityBaseProfile,
  getBackgroundActivityPresetSettings,
  resolveServerBackgroundActivitySettings,
} from "@cogenly/shared/backgroundActivitySettings";

import { DEFAULT_UNIFIED_SETTINGS } from "@cogenly/contracts/settings";

import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { useSettingsScope } from "./SettingsScopeContext";
import { PULL_REQUEST_MERGE_METHOD_LABELS } from "~/lib/pullRequestContext";
import { useEnvironmentQuery } from "../../state/query";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { Button } from "../ui/button";
import { DisclosurePanel } from "../ui/disclosure";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Skeleton } from "../ui/skeleton";
import { Switch } from "../ui/switch";

import { GitIcon, type Icon } from "../Icons";
import { SourceControlHostSettings } from "./SourceControlHostSettings";
import { GitHubAccountSettings } from "./GitHubAccountSettings";
import { GitHubTokenSettings } from "./GitHubTokenSettings";
import { RedactedSensitiveText } from "./RedactedSensitiveText";
import { SourceControlWritingSettingsSection } from "./SourceControlWritingSettings";
import {
  SettingResetButton,
  SettingsDisclosureToggle,
  SettingsEmpty,
  SettingsField,
  SettingsNumberField,
  SettingsRefreshAction,
  SettingsRow,
  SettingsRowContent,
  SettingsSearchTarget,
  SettingsSection,
  SettingsVersion,
  useSearchTargetFold,
} from "./settingsLayout";
import { SettingsStatusBadge, SettingsStatusText, type SettingsStatusTone } from "./SettingsStatus";
import { durationToSeconds, normalizeIntervalSeconds } from "./SettingsPanels.logic";
import { searchableSetting, sourceControlHostSettingsSearchId } from "./settingsSearch";
import { PullRequestGlyph } from "~/components/changeRequestIcons";
import { sourceControlClients } from "@cogenly/client-runtime/source-control-clients";
import { sourceControlIcon } from "~/sourceControlPresentation";

const EMPTY_DISCOVERY_RESULT: SourceControlDiscoveryResult = {
  versionControlSystems: [],
  sourceControlProviders: [],
};

const VCS_ICONS: Partial<Record<VcsDriverKind, Icon>> = {
  git: GitIcon,
};

const SOURCE_CONTROL_SKELETON_ROWS = ["primary", "secondary"] as const;
const GIT_FETCH_INTERVAL_STEP_SECONDS = 5;
type BackgroundActivityOverridePatch = Partial<{
  [K in keyof BackgroundActivitySettings["overrides"]]:
    | BackgroundActivitySettings["overrides"][K]
    | undefined;
}>;

/** Adds one override without pinning the others, unlike the General dialog's helper. */
function backgroundActivityOverrideSettings(
  current: BackgroundActivitySettings,
  overrides: BackgroundActivityOverridePatch,
) {
  const nextOverrides: BackgroundActivityOverridePatch = {
    ...current.overrides,
    ...overrides,
  };
  for (const [key, value] of Object.entries(nextOverrides)) {
    if (value === undefined) {
      delete nextOverrides[key as keyof typeof nextOverrides];
    }
  }
  return {
    backgroundActivity: {
      schemaVersion: 1 as const,
      profile: "custom" as const,
      baseProfile: getBackgroundActivityBaseProfile(current),
      overrides: nextOverrides as BackgroundActivitySettings["overrides"],
    },
  };
}

function optionLabel(value: Option.Option<string>): string | null {
  return Option.getOrNull(value);
}

function isProviderDiscoveryItem(
  item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem,
): item is SourceControlProviderDiscoveryItem {
  return "auth" in item;
}

function authPresentation(auth: SourceControlProviderAuth): {
  readonly label: string;
  readonly badge: "warning" | null;
} {
  if (auth.status === "authenticated") {
    return { label: "Signed in", badge: null };
  }
  if (auth.status === "unauthenticated") {
    return { label: "Not signed in", badge: "warning" };
  }
  return { label: "Status unknown", badge: null };
}

function RedactedAccount(props: { readonly account: string | null }) {
  return (
    <RedactedSensitiveText
      value={props.account}
      ariaLabel="Toggle source control account visibility"
      revealTooltip="Click to reveal account"
      hideTooltip="Click to hide account"
    />
  );
}

function itemStatusTone(
  item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem,
): SettingsStatusTone {
  if (item.status !== "available") return "warning";
  if (isProviderDiscoveryItem(item) && item.auth.status !== "authenticated") return "warning";
  return "success";
}

function SourceControlItemIcon({
  item,
}: {
  readonly item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem;
}) {
  const host = isProviderDiscoveryItem(item) ? sourceControlClients.find(item.kind) : undefined;
  const Icon = isProviderDiscoveryItem(item)
    ? host && sourceControlIcon(host)
    : VCS_ICONS[item.kind];
  if (!Icon) return null;
  // Icon comes from a static registry, never a component made during render.
  return (
    <span aria-hidden className="inline-flex size-5 shrink-0 items-center justify-center">
      {createElement(Icon, { className: "size-4.5 text-foreground/80" })}
    </span>
  );
}

function itemSummary({
  item,
  auth,
  authAccount,
}: {
  readonly item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem;
  readonly auth: SourceControlProviderAuth | null;
  readonly authAccount: string | null;
}) {
  if (item.status !== "available") {
    return <span>Not installed on this machine. {item.installHint}</span>;
  }

  if (auth) {
    if (auth.status === "authenticated") {
      // The server names the account its requests use, Settings choice included, and
      // says when an environment token overrides it.
      const authDetail = optionLabel(auth.detail);
      return (
        <>
          <span>Signed in</span>
          {authAccount ? (
            <>
              <span aria-hidden>as</span>
              <RedactedAccount account={authAccount} />
            </>
          ) : null}
          {authDetail ? <span>· {authDetail}</span> : null}
        </>
      );
    }

    // API integrations have no CLI to sign in with; an unverified saved credential falls
    // through to the "could not verify" detail instead of repeating the setup hint.
    if (!item.executable && auth.status === "unauthenticated") {
      return <span>Available. {item.installHint}</span>;
    }

    // Signed in, but every login is turned off here: the fix is the switch below, not the CLI.
    if (auth.status === "unauthenticated" && auth.accounts?.some((entry) => entry.authenticated)) {
      return <span>{optionLabel(auth.detail) ?? `Every ${item.label} host is turned off.`}</span>;
    }

    if (auth.status === "unauthenticated") {
      return (
        <span>
          Save a token below, or sign in with{" "}
          <code className="rounded bg-muted px-1 py-px text-2xs">{item.executable}</code> on this
          machine, to work with pull requests.
        </span>
      );
    }
    const authDetail = optionLabel(auth.detail);
    return (
      <span>
        Could not verify {item.label}. {authDetail ?? item.installHint}
      </span>
    );
  }

  return <span>Available</span>;
}

function DiscoveryItemRow({
  item,
  children,
}: {
  readonly item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem;
  readonly children?: ReactNode;
}) {
  const version = optionLabel(item.version);
  const auth = isProviderDiscoveryItem(item) ? item.auth : null;
  const authStatus = auth ? authPresentation(auth) : null;
  const authAccount = auth ? optionLabel(auth.account) : null;
  const hasDetails = children !== undefined;
  const detailsLabel = item.kind === "github" ? "Accounts and token" : "Credentials";
  // A settings search for this host (or GitHub's accounts) opens its details.
  const [isExpanded, setIsExpanded] = useSearchTargetFold(
    sourceControlHostSettingsSearchId(item.kind),
    item.kind === "github" ? [searchableSetting("github-accounts").id] : [],
  );

  const summary = (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1 leading-normal">
      {itemSummary({ item, auth, authAccount })}
    </span>
  );

  return (
    <SettingsRowContent
      title={
        <span className="flex min-w-0 items-center gap-2">
          <SourceControlItemIcon item={item} />
          <span className="truncate">{item.label}</span>
        </span>
      }
      titleActions={
        <>
          {version ? <SettingsVersion>{version}</SettingsVersion> : null}
          {authStatus?.badge ? (
            <SettingsStatusBadge tone={authStatus.badge}>{authStatus.label}</SettingsStatusBadge>
          ) : null}
        </>
      }
      // A problem the badge already names keeps its line plain: one status per problem.
      status={
        authStatus?.badge ? (
          summary
        ) : (
          <SettingsStatusText tone={itemStatusTone(item)} className="flex">
            {summary}
          </SettingsStatusText>
        )
      }
      control={
        hasDetails ? (
          <SettingsDisclosureToggle
            open={isExpanded}
            onOpenChange={setIsExpanded}
            label={`${item.label} ${detailsLabel.toLowerCase()}`}
          >
            {detailsLabel}
          </SettingsDisclosureToggle>
        ) : undefined
      }
    >
      {hasDetails ? (
        <DisclosurePanel open={isExpanded}>
          <div className="pt-3">{children}</div>
        </DisclosurePanel>
      ) : null}
    </SettingsRowContent>
  );
}

function GitFetchIntervalRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const resolvedBackgroundActivity = resolveServerBackgroundActivitySettings(settings);
  const automaticGitFetchIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.automaticGitFetchInterval,
  );
  const defaultAutomaticGitFetchIntervalSeconds = durationToSeconds(
    getBackgroundActivityPresetSettings(
      getBackgroundActivityBaseProfile(settings.backgroundActivity),
    ).automaticGitFetchInterval,
  );

  return (
    <SettingsRow
      serverScoped
      settingKeys={["backgroundActivity"]}
      {...searchableSetting("git-fetch-interval")}
      description="How often Git fetches remote branches. 0 turns it off and avoids credential prompts. Background activity in General can still pause it."
      resetAction={
        automaticGitFetchIntervalSeconds !== defaultAutomaticGitFetchIntervalSeconds ? (
          <SettingResetButton
            label="fetch interval"
            onClick={() =>
              updateSettings(
                backgroundActivityOverrideSettings(settings.backgroundActivity, {
                  automaticGitFetchInterval: undefined,
                }),
              )
            }
          />
        ) : null
      }
      control={
        <SettingsNumberField
          label="automatic Git fetch interval"
          unit="seconds"
          value={automaticGitFetchIntervalSeconds}
          min={0}
          step={GIT_FETCH_INTERVAL_STEP_SECONDS}
          onValueChange={(value) =>
            updateSettings(
              backgroundActivityOverrideSettings(settings.backgroundActivity, {
                automaticGitFetchInterval: Duration.seconds(normalizeIntervalSeconds(value)),
              }),
            )
          }
        />
      }
    />
  );
}

function AutomaticPullRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      serverScoped
      settingKeys={["defaultAutoPull"]}
      {...searchableSetting("automatic-pull")}
      description="Fast-forwards the default branch from its upstream while the checkout has no local changes or commits."
      resetAction={
        settings.defaultAutoPull ? (
          <SettingResetButton
            label="automatic pull"
            tooltip="Reset automatic pull to off"
            onClick={() => updateSettings({ defaultAutoPull: false })}
          />
        ) : null
      }
      control={
        <Switch
          aria-label="Automatically pull"
          checked={settings.defaultAutoPull}
          onCheckedChange={(enabled) => updateSettings({ defaultAutoPull: enabled })}
        />
      }
    />
  );
}

/** How pull requests open and merge. */
function PullRequestSettingsSection() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const style = settings.sourceControlWritingStyle;
  const defaultTemplates =
    DEFAULT_UNIFIED_SETTINGS.sourceControlWritingStyle.followChangeRequestTemplates;
  return (
    <SettingsSection id="pull-requests" title="Pull requests">
      <SettingsRow
        serverScoped
        settingKeys={["pullRequestMergeMethod"]}
        {...searchableSetting("pull-request-merge-method")}
        description="The method the merge button starts on. Last used keeps your most recent choice on this device."
        resetAction={
          settings.pullRequestMergeMethod !== null ? (
            <SettingResetButton
              label="default merge method"
              tooltip="Reset to last used"
              onClick={() => updateSettings({ pullRequestMergeMethod: null })}
            />
          ) : null
        }
        control={
          <SettingsField>
            <Select
              value={settings.pullRequestMergeMethod ?? "last"}
              onValueChange={(value) => {
                if (value === "last") updateSettings({ pullRequestMergeMethod: null });
                else if (value === "merge" || value === "squash" || value === "rebase")
                  updateSettings({ pullRequestMergeMethod: value });
              }}
            >
              <SelectTrigger size="sm" aria-label="Default merge method">
                <SelectValue>
                  {(value: string | null) =>
                    value === "merge" || value === "squash" || value === "rebase"
                      ? PULL_REQUEST_MERGE_METHOD_LABELS[value]
                      : "Last used"
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value="last">Last used</SelectItem>
                <SelectItem value="merge">{PULL_REQUEST_MERGE_METHOD_LABELS.merge}</SelectItem>
                <SelectItem value="squash">{PULL_REQUEST_MERGE_METHOD_LABELS.squash}</SelectItem>
                <SelectItem value="rebase">{PULL_REQUEST_MERGE_METHOD_LABELS.rebase}</SelectItem>
              </SelectPopup>
            </Select>
          </SettingsField>
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["sourceControlWritingStyle"]}
        {...searchableSetting("follow-change-request-templates")}
        description="Generated pull request descriptions follow the repository's template when it has one."
        resetAction={
          style.followChangeRequestTemplates !== defaultTemplates ? (
            <SettingResetButton
              label="pull request templates"
              onClick={() =>
                updateSettings({
                  sourceControlWritingStyle: { followChangeRequestTemplates: defaultTemplates },
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={style.followChangeRequestTemplates}
            onCheckedChange={(checked) =>
              updateSettings({
                sourceControlWritingStyle: { followChangeRequestTemplates: Boolean(checked) },
              })
            }
            aria-label="Use pull request templates"
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["removeAgentCreditsOnMerge"]}
        {...searchableSetting("remove-agent-credits-on-merge")}
        description="Strips agent Co-authored-by lines when Cogenly merges or squashes, auto-merge included. Human co-authors stay."
        resetAction={
          settings.removeAgentCreditsOnMerge ? (
            <SettingResetButton
              label="agent credit removal"
              tooltip="Keep agent credits"
              onClick={() => updateSettings({ removeAgentCreditsOnMerge: false })}
            />
          ) : null
        }
        control={
          <Switch
            aria-label="Remove agent credits when merging"
            checked={settings.removeAgentCreditsOnMerge}
            onCheckedChange={(enabled) => updateSettings({ removeAgentCreditsOnMerge: enabled })}
          />
        }
      />
    </SettingsSection>
  );
}

/** Placeholder discovery rows while the first scan runs. */
function DiscoverySkeletonRows({ count }: { readonly count: number }) {
  return SOURCE_CONTROL_SKELETON_ROWS.slice(0, count).map((row) => (
    <div key={row} className="first:rounded-t-xl last:rounded-b-xl px-3 py-3 sm:px-4">
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-center gap-2">
          <span className="inline-flex size-5 shrink-0 items-center justify-center">
            <Skeleton className="size-4.5" />
          </span>
          <Skeleton shape="pill" className="h-4 w-28" />
          <Skeleton shape="pill" className="h-5 w-14" />
        </div>
        <Skeleton shape="pill" className="h-3 w-full max-w-xs" />
      </div>
    </div>
  ));
}

export function SourceControlSettingsPanel() {
  const { scope, environment, connectedEnvironments } = useSettingsScope();
  // Discovery scans one machine's tools, so it shows the representative
  // environment (named under the first card when several are selected);
  // the settings rows fan out like everywhere else.
  const environmentId =
    environment?.connection.phase === "connected" ? environment.environmentId : null;
  const aggregate = scope.environmentIds.length !== 1 && connectedEnvironments.length > 1;
  const scanScopeNote =
    aggregate && environment
      ? `Detected on ${environment.label}. Select one machine to inspect another.`
      : null;
  const discovery = useEnvironmentQuery(
    environmentId === null
      ? null
      : sourceControlEnvironment.discovery({
          environmentId,
          input: {},
        }),
  );
  const result = discovery.data ?? EMPTY_DISCOVERY_RESULT;
  const isInitialScanPending = discovery.isPending && discovery.data === null;
  const handleScan = () => {
    discovery.refresh();
  };
  /** The host's own settings form, for a host whose definition declares settings. */
  const hostSettingsPanel = (kind: string) => {
    const definition = sourceControlClients.find(kind);
    if (!definition?.settings || environmentId === null) return undefined;
    return (
      <SettingsSearchTarget id={sourceControlHostSettingsSearchId(kind)}>
        <SourceControlHostSettings
          // Drafts belong to one environment; switching must not carry them over.
          key={environmentId}
          environmentId={environmentId}
          definition={{ ...definition, settings: definition.settings }}
          onSaved={handleScan}
        />
      </SettingsSearchTarget>
    );
  };
  const scanButton =
    environmentId === null ? null : (
      <SettingsRefreshAction
        label="Rescan Git and GitHub on this machine"
        refreshing={discovery.isPending}
        idleLabel="Rescan"
        onRefresh={handleScan}
      />
    );
  // Rescan as a failed row's recovery step (`sm`) or an empty list's one action (`xs`).
  const rescanButton = (size: "sm" | "xs") => (
    <Button size={size} variant="outline" onClick={handleScan} disabled={discovery.isPending}>
      <RefreshIcon size="sm" refreshing={discovery.isPending} />
      Rescan
    </Button>
  );

  const hostingRows =
    environmentId === null ? (
      <SettingsRow title="Connect a machine to see its Git and GitHub setup." role="status" />
    ) : isInitialScanPending ? (
      <DiscoverySkeletonRows count={1} />
    ) : result.sourceControlProviders.length > 0 ? (
      result.sourceControlProviders.map((item) => (
        <DiscoveryItemRow key={`provider:${item.kind}`} item={item}>
          {item.kind === "github" ? (
            <SettingsSearchTarget id={searchableSetting("github-accounts").id}>
              <div className="grid gap-6">
                {/* Shown even without gh: a saved token is how GitHub works without the CLI. */}
                <GitHubTokenSettings
                  key={`token-${environmentId}`}
                  environmentId={environmentId}
                  onSaved={handleScan}
                />
                {item.status === "available" ? (
                  <GitHubAccountSettings
                    key={environmentId}
                    environmentId={environmentId}
                    auth={item.auth}
                    onSaved={handleScan}
                  />
                ) : null}
              </div>
            </SettingsSearchTarget>
          ) : (
            hostSettingsPanel(item.kind)
          )}
        </DiscoveryItemRow>
      ))
    ) : discovery.error !== null ? (
      <SettingsRow
        title="Could not scan this machine"
        description={discovery.error}
        control={rescanButton("sm")}
      />
    ) : (
      <SettingsEmpty
        icon={<PullRequestGlyph.pullRequest />}
        label="Save a GitHub token or sign in with gh on this machine, then rescan."
        action={rescanButton("xs")}
      />
    );

  return (
    <>
      <SettingsSection
        id={searchableSetting("source-control").id}
        title="Hosting"
        headerAction={scanButton}
        footer={scanScopeNote}
      >
        {isInitialScanPending ||
        result.sourceControlProviders.some((item) => item.kind === "github") ? (
          hostingRows
        ) : (
          // GitHub accounts live in the GitHub row; until a scan lists it, their search lands here.
          <SettingsSearchTarget id={searchableSetting("github-accounts").id}>
            {hostingRows}
          </SettingsSearchTarget>
        )}
      </SettingsSection>
      <PullRequestSettingsSection />
      <SourceControlWritingSettingsSection />
      <SettingsSection id="git" title="Git">
        {environmentId !== null && isInitialScanPending ? (
          <DiscoverySkeletonRows count={1} />
        ) : null}
        {environmentId !== null && !isInitialScanPending && discovery.error === null ? (
          result.versionControlSystems.length > 0 ? (
            result.versionControlSystems.map((item) => (
              <DiscoveryItemRow key={`vcs:${item.kind}`} item={item} />
            ))
          ) : (
            <SettingsRow
              title="Git not found"
              description="Install Git on this machine, then rescan."
              role="status"
            />
          )
        ) : null}
        <AutomaticPullRow />
        <GitFetchIntervalRow />
      </SettingsSection>
    </>
  );
}
