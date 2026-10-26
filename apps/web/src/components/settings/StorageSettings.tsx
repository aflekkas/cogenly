import type {
  StorageCleanupReport,
  StorageCleanupSettings,
  WorktreeCleanupRules,
  StorageStatus,
  EnvironmentId,
} from "@cogenly/contracts";
import { resolveWorktreeCleanup } from "@cogenly/shared/projectSettings";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@cogenly/client-runtime/state/runtime";
import { formatBytes } from "../../lib/formatBytes";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

import { Input } from "../ui/input";
import { Collapsible, CollapsiblePanel } from "../ui/collapsible";
import { Switch } from "../ui/switch";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import {
  SettingResetButton,
  SettingsNote,
  SettingsRefreshAction,
  SettingsRow,
  SettingsSection,
  useRelativeTimeTick,
} from "./settingsLayout";
import { DatabaseStorageNotice } from "./DatabaseStorageNotice";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { SettingsGroup } from "./SettingsGroup";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { settingsScopeEnvironmentLabel } from "./settingsScopeAxis";

function WorktreesDirectoryRow() {
  const { connectedEnvironments, targets } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const edited = useRef(false);
  if (
    connectedEnvironments.some(
      (environment) =>
        environment.serverConfig?.environment.capabilities.worktreesDirectory !== true,
    )
  )
    return null;
  const scopeKey = targets.map((target) => target.environmentId).join(",");

  return (
    <SettingsRow
      {...searchableSetting("storage-worktrees-location")}
      description={
        "Folder where new worktrees are created, on any drive, such as D:\\worktrees or ~/worktrees. Existing worktrees stay where they are. Leave empty to keep a project's worktrees in its folder's .worktrees and the rest in the Cogenly home folder."
      }
      serverScoped
      settingKeys={["worktreesDirectory"]}
      resetAction={
        settings.worktreesDirectory !== "" ? (
          <SettingResetButton
            label="worktree location"
            onClick={() => updateSettings({ worktreesDirectory: "" })}
          />
        ) : null
      }
      control={
        <Input
          key={`${scopeKey}:${settings.worktreesDirectory}`}
          aria-label="Worktree location"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="Default"
          defaultValue={settings.worktreesDirectory}
          onChange={() => {
            edited.current = true;
          }}
          onBlur={(event) => {
            const value = event.target.value.trim();
            if (edited.current && value !== settings.worktreesDirectory)
              updateSettings({ worktreesDirectory: value });
            edited.current = false;
          }}
        />
      }
    />
  );
}

function RetentionControl({
  label,
  value,
  onChange,
  minimum = 1,
}: {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
  minimum?: number;
}) {
  const [draft, setDraft] = useState(value);
  const [savedValue, setSavedValue] = useState(value);
  if (savedValue !== value) {
    setSavedValue(value);
    setDraft(value);
  }

  return (
    <div className="flex items-center gap-3">
      {value !== null ? (
        <NumberField
          value={draft}
          min={minimum}
          max={3650}
          step={1}
          size="sm"
          className="w-auto"
          onValueChange={setDraft}
          onValueCommitted={(next) => {
            if (next === null) setDraft(value);
            else {
              const days = Math.min(3650, Math.max(minimum, Math.round(next)));
              setDraft(days);
              onChange(days);
            }
          }}
        >
          <NumberFieldGroup>
            <NumberFieldDecrement aria-label={`Decrease ${label}`} />
            <NumberFieldInput
              aria-label={`${label} in days`}
              size={new Intl.NumberFormat().format(draft ?? value).length}
              className="field-sizing-content w-auto min-w-[1ch] grow-0 text-right"
            />
            <span aria-hidden="true" className="self-center pr-2 text-xs">
              days
            </span>
            <NumberFieldIncrement aria-label={`Increase ${label}`} />
          </NumberFieldGroup>
        </NumberField>
      ) : null}
      <Switch
        aria-label={label}
        checked={value !== null}
        onCheckedChange={(enabled) => onChange(enabled ? 8 : null)}
      />
    </div>
  );
}

/** One line for the last-run fold; identical results across machines collapse into one. */
function lastRunSummary(
  entries: readonly { readonly label: string; readonly counts: string }[],
  machineCount: number,
) {
  const first = entries[0];
  if (!first) return "";
  if (machineCount <= 1) return first.counts;
  if (entries.length === machineCount && entries.every((entry) => entry.counts === first.counts)) {
    return `${first.counts} on every machine`;
  }
  return entries.map((entry) => `${entry.label}: ${entry.counts}`).join(" · ");
}

function CleanupResults({
  report,
  environmentLabel,
}: {
  report: StorageCleanupReport;
  environmentLabel: string | undefined;
}) {
  return (
    <>
      {report.entries.map((entry, index) => {
        const name =
          entry.kind === "worktree"
            ? ((entry.threadId === null
                ? entry.path
                : entry.path?.split(/[\\/]/).findLast(Boolean)) ?? "Worktrees")
            : entry.kind === "backups"
              ? "Old backup"
              : entry.kind === "dependencies"
                ? "Build files"
                : entry.kind === "logs"
                  ? "Old logs"
                  : "Browser captures";
        return (
          <SettingsRow
            key={`${entry.path ?? entry.kind}:${entry.threadId ?? index}`}
            title={environmentLabel ? `${environmentLabel}: ${name}` : name}
            description={
              <span
                className={`wrap-anywhere ${entry.outcome === "failed" ? "text-destructive" : ""}`}
              >
                {entry.threadTitle && entry.threadTitle !== name ? `${entry.threadTitle}. ` : ""}
                {entry.reason}
              </span>
            }
            control={
              (entry.outcome === "removed" ||
                (entry.outcome === "kept" && entry.bytes !== null)) && (
                <span className="text-xs text-muted-foreground">
                  {[
                    entry.kind !== "worktree" && entry.files !== null
                      ? `${entry.files.toLocaleString()} ${entry.files === 1 ? "file" : "files"}`
                      : null,
                    entry.bytes !== null ? formatBytes(entry.bytes) : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              )
            }
          />
        );
      })}
      {report.omittedCount > 0 && (
        <SettingsNote>
          {environmentLabel ? `${environmentLabel}: ` : ""}
          {report.omittedCount.toLocaleString()} more.
        </SettingsNote>
      )}
      {report.entries.length === 0 && report.omittedCount === 0 && (
        <SettingsNote>
          {environmentLabel ? `${environmentLabel}: ` : ""}Nothing to clean up.
        </SettingsNote>
      )}
    </>
  );
}

function CleanupSection() {
  useRelativeTimeTick(60_000);
  const { connectedEnvironments } = useSettingsScope();
  const [pending, setPending] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previews, setPreviews] = useState<ReadonlyArray<{
    environmentId: EnvironmentId;
    report: StorageCleanupReport;
  }> | null>(null);
  const run = useAtomCommand(serverEnvironment.runStorageCleanup);
  const supported = connectedEnvironments.filter(
    (environment) =>
      environment.serverConfig?.environment.capabilities.storageCleanupRun === true &&
      environment.serverConfig.environment.capabilities.storageStatus === true,
  );
  const state = useAtomValue(
    useMemo(
      () =>
        Atom.make((get) =>
          connectedEnvironments.flatMap((environment) => {
            if (
              environment.serverConfig?.environment.capabilities.storageCleanupRun !== true ||
              environment.serverConfig.environment.capabilities.storageStatus !== true
            )
              return [];
            const query = get(
              serverEnvironment.storageCleanupReport({
                environmentId: environment.environmentId,
                input: {},
              }),
            );
            return [
              {
                environmentId: environment.environmentId,
                allowed: get(
                  serverEnvironment.runStorageCleanup.permissionAtom(environment.environmentId),
                ),
                report: query._tag === "Success" ? query.value : null,
                loading: query.waiting,
                failed: query._tag === "Failure",
              },
            ];
          }),
        ),
      [connectedEnvironments],
    ),
  );
  const hasRules = supported.some((environment) => {
    const settings = environment.serverConfig?.settings;
    if (!settings) return false;
    const enabled = (rules: WorktreeCleanupRules) =>
      rules.worktreeAfterDays !== null ||
      rules.worktreeSettledAfterDays !== null ||
      rules.worktreeOnMerge ||
      rules.worktreeOnDelete ||
      rules.worktreeUnchanged;
    return (
      settings.storageCleanup.browserArtifactsAfterDays !== null ||
      settings.storageCleanup.logsAfterDays !== null ||
      settings.storageCleanup.dependenciesAfterDays !== null ||
      enabled(resolveWorktreeCleanup(settings))
    );
  });
  if (supported.length === 0) return null;
  const summaries = supported.map((environment) => {
    const query = state.find((entry) => entry.environmentId === environment.environmentId);
    const report = query?.report ?? null;
    return {
      environment,
      report,
      label: settingsScopeEnvironmentLabel(environment, connectedEnvironments),
      counts: report
        ? `${report.counts.removed} removed, ${report.counts.kept} kept${report.counts.failed > 0 ? `, ${report.counts.failed} failed` : ""}`
        : "",
      description: report
        ? `Last ran ${formatRelativeTimeLabel(report.finishedAt)}${report.spaceMeasurement === "volume-change" && report.bytesFreed > 0 ? ` and freed ${formatBytes(report.bytesFreed)}.` : "."}${report.counts.failed > 0 ? ` ${report.counts.failed} ${report.counts.failed === 1 ? "item" : "items"} couldn't be removed.` : ""}`
        : query?.failed
          ? "Couldn't load the last run."
          : query?.loading
            ? "Loading the last run…"
            : "Cleanup hasn't run yet.",
    };
  });
  const deleteNow = async (dryRun: boolean) => {
    if (pending) return;
    setPending(true);
    try {
      const reports: Array<{ environmentId: EnvironmentId; report: StorageCleanupReport }> = [];
      await Promise.all(
        supported
          .filter(
            (environment) =>
              (dryRun ||
                previews?.some((preview) => preview.environmentId === environment.environmentId)) &&
              state.some(
                (entry) => entry.environmentId === environment.environmentId && entry.allowed,
              ),
          )
          .map(async (environment) => {
            const result = await run({
              environmentId: environment.environmentId,
              input: { dryRun },
            });
            if (result._tag === "Success") {
              reports.push({ environmentId: environment.environmentId, report: result.value });
              const failures = result.value.entries.filter((entry) => entry.outcome === "failed");
              if (failures.length > 0)
                toastManager.add({
                  type: "error",
                  title: `Cleanup failed on ${environment.label}`,
                  description: failures[0]!.reason,
                });
            } else if (!isAtomCommandInterrupted(result)) {
              toastManager.add({
                type: "error",
                title: `Could not run cleanup on ${environment.label}`,
                description: String(squashAtomCommandFailure(result)),
              });
            }
          }),
      );
      if (dryRun) setPreviews(reports);
      setPreviewOpen(dryRun && reports.length > 0);
    } finally {
      setPending(false);
    }
  };
  return (
    <SettingsSection id="storage-cleanup" title="Cleanup" variant="plain">
      <SettingsGroup>
        <SettingsRow
          {...searchableSetting("storage-delete-now")}
          description={
            <span>
              {!hasRules
                ? "Remove what the rules below allow. Finished delegated tasks already clean up on their own."
                : summaries.map(({ environment, label, description }) => (
                    <span key={environment.environmentId} className="block">
                      {supported.length > 1 ? `${label}: ` : ""}
                      {description}
                    </span>
                  ))}
            </span>
          }
          control={
            <div className="flex gap-2">
              {previewOpen && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() => setPreviewOpen(false)}
                >
                  Cancel
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                disabled={pending || !state.some((entry) => entry.allowed)}
                onClick={() => void deleteNow(!previewOpen)}
              >
                {pending
                  ? previewOpen
                    ? "Cleaning up…"
                    : "Checking…"
                  : !previewOpen
                    ? "Preview cleanup"
                    : "Clean up now"}
              </Button>
            </div>
          }
        />
      </SettingsGroup>
      <Collapsible open={previewOpen}>
        <CollapsiblePanel>
          {previews !== null && (
            <>
              <SettingsNote>
                Nothing is removed yet. Cleanup checks each item again before removing it and always
                keeps branches and checkpoints. Sizes are estimates.
              </SettingsNote>
              {previews.some(({ report }) => (report.unsavedAgentWorktrees ?? 0) > 0) && (
                <SettingsNote>
                  {previews.reduce(
                    (total, { report }) => total + (report.unsavedAgentWorktrees ?? 0),
                    0,
                  )}{" "}
                  agent worktrees have unsaved changes, so they stay.
                </SettingsNote>
              )}
              {previews.map(({ environmentId, report }) => (
                <CleanupResults
                  key={environmentId}
                  report={report}
                  environmentLabel={
                    connectedEnvironments.find(
                      (environment) => environment.environmentId === environmentId,
                    )?.label
                  }
                />
              ))}
            </>
          )}
        </CollapsiblePanel>
      </Collapsible>
      {summaries.some(({ report }) => (report?.unsavedAgentWorktrees ?? 0) > 0) && (
        <SettingsNote>
          {summaries.reduce((total, { report }) => total + (report?.unsavedAgentWorktrees ?? 0), 0)}{" "}
          agent worktrees had unsaved changes, so they stayed.
        </SettingsNote>
      )}
      {summaries.some(({ report }) => report !== null) && (
        <FoldedSettingsSection
          id="storage-cleanup-last-run"
          title="Last run"
          headerPlacement="inside"
          summary={lastRunSummary(
            summaries.filter(({ report }) => report !== null),
            connectedEnvironments.length,
          )}
        >
          {summaries.map(
            ({ environment, label, report }) =>
              report && (
                <CleanupResults
                  key={environment.environmentId}
                  report={report}
                  environmentLabel={connectedEnvironments.length > 1 ? label : undefined}
                />
              ),
          )}
        </FoldedSettingsSection>
      )}
    </SettingsSection>
  );
}

const STORAGE_LABELS: Record<string, string> = {
  "agent-worktrees": "Agent worktrees",
  "user-worktrees": "Your worktrees",
  dependencies: "Dependencies and build output",
  "dev-data": "Dev data copies",
  "browser-artifacts": "Browser captures",
  logs: "Logs",
  backups: "Backups",
};

function StorageUsage({ environmentId, label }: { environmentId: EnvironmentId; label: string }) {
  const measure = useAtomCommand(serverEnvironment.storageStatus);
  const [status, setStatus] = useState<StorageStatus | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const refresh = async () => {
    setPending(true);
    try {
      const result = await measure({ environmentId, input: {} });
      if (result._tag === "Success") {
        setStatus(result.value);
        setCheckedAt(new Date().toISOString());
      }
    } finally {
      setPending(false);
    }
  };
  useEffect(() => {
    let cancelled = false;
    void measure({ environmentId, input: {} }).then((result) => {
      if (!cancelled && result._tag === "Success") {
        setStatus(result.value);
        setCheckedAt(new Date().toISOString());
      }
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, measure]);
  return (
    <SettingsSection
      id={`storage-usage-${environmentId}`}
      title={`Disk usage on ${label}`}
      headerAction={
        <SettingsRefreshAction
          label="Measure disk usage again"
          refreshing={pending}
          checkedAt={checkedAt}
          idleLabel="Measuring"
          onRefresh={() => void refresh()}
        />
      }
      footer="Files that share disk space with copies, such as worktrees on APFS, show as Unknown."
    >
      {status === null ? (
        <SettingsRow title="Measuring disk usage…" role="status" />
      ) : (
        <>
          {!status.complete && (
            <SettingsNote>Measuring didn't finish. Refresh to try again.</SettingsNote>
          )}
          {status.volumes.map((volume) => (
            <SettingsRow
              key={volume.id}
              title="Disk"
              description={volume.path}
              control={
                <span className="text-sm tabular-nums">
                  {formatBytes(volume.usedBytes)} used · {formatBytes(volume.availableBytes)} free
                </span>
              }
            />
          ))}
          <SettingsRow
            title="Conversation history"
            description="Cogenly's database. Cleanup never removes history."
            control={
              <span className="text-sm tabular-nums">
                {status.databaseBytes === null ? "Unknown" : formatBytes(status.databaseBytes)}
              </span>
            }
          />
          {Object.entries(STORAGE_LABELS).map(([category, title]) => {
            const usage = status.categories.find((entry) => entry.category === category);
            return (
              <SettingsRow
                key={category}
                title={title}
                description={
                  usage
                    ? `${usage.files.toLocaleString()} ${usage.files === 1 ? "file" : "files"}${usage.bytes === null ? " · Shares disk space" : ""}`
                    : undefined
                }
                control={
                  <span className="text-sm tabular-nums">
                    {status.complete && usage?.bytes !== null
                      ? formatBytes(usage?.bytes ?? 0)
                      : "Unknown"}
                  </span>
                }
              />
            );
          })}
        </>
      )}
    </SettingsSection>
  );
}

/** Storage is one machine's disk: the page edits the machine picked above. */
export function StorageSettingsPanel() {
  const { connectedEnvironments } = useSettingsScope();
  const scopedSettings = useScopedSettings();
  const settings = {
    ...scopedSettings.storageCleanup,
    ...resolveWorktreeCleanup(scopedSettings),
  };
  const updateSettings = useUpdateScopedSettings();
  const update = (patch: Partial<StorageCleanupSettings>) =>
    updateSettings({ storageCleanup: patch });

  if (
    connectedEnvironments.some(
      (environment) => environment.serverConfig?.environment.capabilities.storageCleanup !== true,
    )
  ) {
    return (
      <SettingsScopeNotice
        target="environment"
        eligibleEnvironmentIds={connectedEnvironments
          .filter(
            (environment) =>
              environment.serverConfig?.environment.capabilities.storageCleanup === true,
          )
          .map((environment) => environment.environmentId)}
      >
        Update Cogenly on this machine to use storage cleanup, or choose a machine that supports it.
      </SettingsScopeNotice>
    );
  }

  return (
    <>
      {connectedEnvironments
        .filter(
          (environment) =>
            environment.serverConfig?.environment.capabilities.storageStatus === true,
        )
        .map((environment) => (
          <StorageUsage
            key={environment.environmentId}
            environmentId={environment.environmentId}
            label={environment.label}
          />
        ))}
      {/* Right under usage: people come here to free space. The rules below say what it removes. */}
      <CleanupSection
        key={connectedEnvironments.map((environment) => environment.environmentId).join(":")}
      />
      {connectedEnvironments
        .filter(
          (environment) =>
            environment.serverConfig?.environment.capabilities.databaseStorage === true,
        )
        .map((environment) => (
          <DatabaseStorageNotice
            key={environment.environmentId}
            environmentId={environment.environmentId}
            label={environment.label}
          />
        ))}
      <SettingsSection id="storage-worktrees" title="Worktrees">
        <WorktreesDirectoryRow />
        <SettingsRow
          title="Delete worktrees with deleted threads"
          description="When you delete a thread, remove its worktree too. Worktrees with local changes stay."
          serverScoped
          control={
            <Switch
              aria-label="Delete worktrees with deleted threads"
              checked={settings.worktreeOnDelete}
              onCheckedChange={(worktreeOnDelete) => update({ worktreeOnDelete })}
            />
          }
        />
        <SettingsRow
          title="Delete inactive worktrees"
          description="Remove a worktree once its thread has been idle this long. Branches and history stay."
          serverScoped
          control={
            <RetentionControl
              label="Delete inactive worktrees"
              value={settings.worktreeAfterDays}
              onChange={(worktreeAfterDays) => update({ worktreeAfterDays })}
            />
          }
        />
        {connectedEnvironments.length > 0 &&
          connectedEnvironments.every(
            (environment) =>
              environment.serverConfig?.environment.capabilities.settledWorktreeCleanup === true,
          ) && (
            <SettingsRow
              title="Delete settled or archived worktrees"
              description="Remove a worktree this long after its thread settles or is archived. Reopening the thread brings it back from its branch."
              serverScoped
              control={
                <RetentionControl
                  label="Delete settled worktrees"
                  value={settings.worktreeSettledAfterDays}
                  minimum={0}
                  onChange={(worktreeSettledAfterDays) => update({ worktreeSettledAfterDays })}
                />
              }
            />
          )}
        <SettingsRow
          title="Delete merged worktrees"
          description="Remove a worktree once its pull request is merged into the default branch."
          serverScoped
          control={
            <Switch
              aria-label="Delete merged worktrees"
              checked={settings.worktreeOnMerge}
              onCheckedChange={(worktreeOnMerge) => update({ worktreeOnMerge })}
            />
          }
        />
        <SettingsRow
          title="Delete unchanged worktrees"
          description="Remove worktrees that have no commits of their own."
          serverScoped
          control={
            <Switch
              aria-label="Delete unchanged worktrees"
              checked={settings.worktreeUnchanged}
              onCheckedChange={(worktreeUnchanged) => update({ worktreeUnchanged })}
            />
          }
        />
        <SettingsRow
          title="Keep ignored local files too"
          description="Also keep worktrees that hold ignored files such as build output. Edits, untracked files, stashes and files like .env always keep a worktree. node_modules can still go."
          serverScoped
          control={
            <Switch
              aria-label="Keep ignored local files too"
              checked={settings.worktreeKeepWhen === "any-local-files"}
              onCheckedChange={(keep) =>
                update({ worktreeKeepWhen: keep ? "any-local-files" : "uncommitted-changes" })
              }
            />
          }
        />
      </SettingsSection>

      <SettingsSection id="storage-backups" title="Backups">
        <SettingsRow
          title="Nightly backups"
          description="Save a copy of the database, settings and secrets every night."
          serverScoped
          control={
            <Switch
              aria-label="Nightly backups"
              checked={scopedSettings.automaticBackups.enabled}
              onCheckedChange={(enabled) => updateSettings({ automaticBackups: { enabled } })}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("storage-backups")}
          title="Backups to keep"
          description="The newest copies stay. Older ones are removed when cleanup runs."
          serverScoped
          control={
            <NumberField
              value={scopedSettings.automaticBackups.retentionCount}
              min={1}
              max={30}
              size="sm"
              onValueCommitted={(value) => {
                if (value !== null)
                  updateSettings({
                    automaticBackups: {
                      retentionCount: Math.max(1, Math.min(30, Math.round(value))),
                    },
                  });
              }}
            >
              <NumberFieldGroup>
                <NumberFieldDecrement aria-label="Keep fewer backups" />
                <NumberFieldInput aria-label="Backups to keep" />
                <NumberFieldIncrement aria-label="Keep more backups" />
              </NumberFieldGroup>
            </NumberField>
          }
        />
      </SettingsSection>
      <SettingsSection id="storage-artifacts" title="Build files, captures and logs">
        <SettingsRow
          title="Prune idle dependencies"
          description="Remove node_modules, .turbo and dist from worktrees idle this long. They're rebuilt before the next turn."
          serverScoped
          control={
            <RetentionControl
              label="Prune idle dependencies"
              value={settings.dependenciesAfterDays}
              onChange={(dependenciesAfterDays) => update({ dependenciesAfterDays })}
            />
          }
        />
        <SettingsRow
          title="Delete old browser captures"
          description="Remove saved browser screenshots and recordings after this long. Links to them stop opening."
          serverScoped
          control={
            <RetentionControl
              label="Delete old browser captures"
              value={settings.browserArtifactsAfterDays}
              onChange={(browserArtifactsAfterDays) => update({ browserArtifactsAfterDays })}
            />
          }
        />
        <SettingsRow
          title="Delete old logs"
          description="Remove old log files after this long. The current log stays."
          serverScoped
          control={
            <RetentionControl
              label="Delete old logs"
              value={settings.logsAfterDays}
              onChange={(logsAfterDays) => update({ logsAfterDays })}
            />
          }
        />
      </SettingsSection>
    </>
  );
}
