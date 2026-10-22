import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  T3_IMPORT_RUNNING_NOTE,
  type EnvironmentId,
  type T3ImportReport,
  type T3ImportResult,
  type T3ImportSourceProject,
  type T3ImportStatus,
} from "@t3tools/contracts";
import { CircleCheckIcon, CircleAlertIcon, InfoIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { formatBytes } from "../../lib/formatBytes";
import { readLocalApi } from "../../localApi";
import { t3ImportRpc } from "../../rpc/t3Import";
import { useAtomCommand } from "../../state/use-atom-command";
import { WorkLogDisclosure } from "../chat/WorkLog";
import { useSelectSidebarMode } from "../sidebar/modes/useSelectSidebarMode";
import { Alert, AlertDescription } from "../ui/alert";
import { useAnimatedPanelHeight } from "../ui/animated-panel-height";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Spinner } from "../ui/spinner";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  T3_IMPORT_DOCS_URL,
  T3_IMPORT_PHASE_LABELS,
  T3_PROVIDER_STATUS_LABELS,
  deriveT3ImportView,
  describeT3ImportFailure,
  initialT3ImportSelection,
  listT3SkippedEvents,
  pluralize,
  summarizeT3ImportReport,
  type T3ImportSourceWithBackup,
  type T3ImportView,
} from "./T3ImportSettings.logic";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

/**
 * Settings → Import. Brings T3 Code's projects, threads and a few settings
 * into the environment in the scope sentence: pick projects, check, import.
 * Onboarding renders the same flow through {@link useT3ImportFlow} and
 * {@link T3ImportFlowView}.
 */
export function T3ImportSettings() {
  const { environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  return <T3ImportGate key={environmentId ?? "none"} environmentId={environmentId} />;
}

function T3ImportGate({ environmentId }: { environmentId: EnvironmentId | null }) {
  const canImport = useAtomValue(t3ImportRpc.scan.permissionAtom(environmentId));
  if (environmentId === null || !canImport) {
    return (
      <SettingsPageContainer>
        <SettingsSection id="t3-import" title="Import from T3 Code">
          <SettingsRow
            title={
              environmentId === null
                ? "Choose an environment to import into."
                : "This connection needs permission to change settings to import."
            }
          />
        </SettingsSection>
      </SettingsPageContainer>
    );
  }
  return <T3ImportSettingsPanel environmentId={environmentId} />;
}

function T3ImportSettingsPanel({ environmentId }: { environmentId: EnvironmentId }) {
  const flow = useT3ImportFlow(environmentId);
  return (
    <SettingsPageContainer>
      <T3ImportFlowView flow={flow} presentation="settings" />
    </SettingsPageContainer>
  );
}

/** Opens the user guide for Import from T3 Code in the system browser. */
export function T3ImportLearnMoreLink() {
  return (
    <button
      type="button"
      className="link inline cursor-pointer"
      onClick={() => void readLocalApi()?.shell.openExternal(T3_IMPORT_DOCS_URL)}
    >
      Learn more
    </button>
  );
}

/**
 * State and actions of one Import from T3 Code flow against an environment.
 * The caller must hold the scan permission (`t3ImportRpc.scan.permissionAtom`).
 */
export function useT3ImportFlow(environmentId: EnvironmentId) {
  const statusAtom = t3ImportRpc.status({ environmentId, input: {} });
  const result = useAtomValue(statusAtom);
  const refreshStatus = useAtomRefresh(statusAtom);
  // A re-check restarts the stream; keep the last answer on screen meanwhile.
  const [status, setStatus] = useState<T3ImportStatus | null>(null);
  if (result._tag === "Success" && result.value !== status) setStatus(result.value);
  const statusError =
    result._tag === "Failure" && status === null
      ? describeT3ImportFailure(squashAtomCommandFailure(result))
      : null;

  const [picked, setPicked] = useState<ReadonlySet<string> | null>(null);
  const selection = picked ?? (status ? initialT3ImportSelection(status) : new Set<string>());
  const [includeSettings, setIncludeSettings] = useState(true);
  const [pending, setPending] = useState<"scan" | "run" | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const scan = useAtomCommand(t3ImportRpc.scan, { reportFailure: false });
  const run = useAtomCommand(t3ImportRpc.run, { reportFailure: false });

  const { view, t3Open } = deriveT3ImportView(status, selection);

  const cancel = useAtomCommand(t3ImportRpc.cancel, { reportFailure: false });
  const [cancelling, setCancelling] = useState(false);
  const jobRunning = view.kind === "scanning" || view.kind === "importing";
  // A new job (or its end) clears the cancel request's pending label.
  if (!jobRunning && cancelling) setCancelling(false);
  const stopJob = async () => {
    if (cancelling) return;
    setCancelling(true);
    const stopped = await cancel({ environmentId, input: {} });
    if (stopped._tag === "Failure" && !isAtomCommandInterrupted(stopped)) {
      setCancelling(false);
      setRequestError(describeT3ImportFailure(squashAtomCommandFailure(stopped)));
    }
  };

  const startScan = async () => {
    if (pending !== null) return;
    setPending("scan");
    setRequestError(null);
    try {
      const scanned = await scan({
        environmentId,
        input: { scope: { sourceProjectIds: [...selection] } },
      });
      if (scanned._tag === "Failure" && !isAtomCommandInterrupted(scanned)) {
        setRequestError(describeT3ImportFailure(squashAtomCommandFailure(scanned)));
      }
    } finally {
      setPending(null);
    }
  };

  const startImport = async (report: T3ImportReport) => {
    if (pending !== null) return;
    setPending("run");
    setRequestError(null);
    try {
      const started = await run({
        environmentId,
        input: {
          reportId: report.reportId,
          includeSettings: includeSettings && report.settings.length > 0,
        },
      });
      if (started._tag === "Failure" && !isAtomCommandInterrupted(started)) {
        setRequestError(describeT3ImportFailure(squashAtomCommandFailure(started)));
      }
    } finally {
      setPending(null);
    }
  };

  const toggleProject = (sourceProjectId: string, checked: boolean) => {
    const next = new Set(selection);
    if (checked) next.add(sourceProjectId);
    else next.delete(sourceProjectId);
    setPicked(next);
  };

  return {
    environmentId,
    status,
    statusError,
    refreshStatus,
    view,
    t3Open,
    selection,
    toggleProject,
    includeSettings,
    setIncludeSettings,
    pending,
    requestError,
    cancelling,
    busy: pending !== null || jobRunning,
    startScan,
    startImport,
    stopJob,
  };
}

export type T3ImportFlow = ReturnType<typeof useT3ImportFlow>;

/**
 * The import flow's sections. Settings shows them on its page; onboarding
 * shows them inside its wizard step, where the step heading names the flow
 * and the wizard's own footer moves on once the import is done.
 */
export function T3ImportFlowView({
  flow,
  presentation,
}: {
  flow: T3ImportFlow;
  presentation: "settings" | "onboarding";
}) {
  const {
    status,
    statusError,
    refreshStatus,
    view,
    t3Open,
    selection,
    pending,
    busy,
    cancelling,
    requestError,
  } = flow;
  const cancelButton = (
    <Button size="sm" variant="outline" disabled={cancelling} onClick={() => void flow.stopJob()}>
      {cancelling ? "Stopping…" : "Cancel"}
    </Button>
  );

  const { panelProps, contentRef } = useAnimatedPanelHeight();
  const selectable =
    view.kind === "intro" ||
    view.kind === "report" ||
    view.kind === "failed" ||
    view.kind === "cancelled" ||
    view.kind === "scanning";

  return statusError !== null ? (
    <SettingsSection id="t3-import" title="Import from T3 Code">
      <SettingsRow
        title="Couldn't reach the importer"
        description={statusError}
        control={
          <Button size="sm" variant="outline" onClick={refreshStatus}>
            Retry
          </Button>
        }
      />
    </SettingsSection>
  ) : view.kind === "loading" ? (
    <SettingsSection id="t3-import" title="Import from T3 Code">
      <SettingsRow title="Looking for T3 Code…" status={<Spinner size="xs" tone="muted" />} />
    </SettingsSection>
  ) : view.kind === "unavailable" ? (
    <SettingsSection id="t3-import" title="Import from T3 Code">
      <SettingsRow
        title="T3 Code wasn't found"
        description={view.message}
        control={
          <Button size="sm" variant="outline" onClick={refreshStatus}>
            Check again
          </Button>
        }
      />
    </SettingsSection>
  ) : (
    <>
      {t3Open ? (
        <div className="swap-motion">
          <Alert variant="info" controlAlignment="first-line">
            <InfoIcon />
            <AlertDescription>{T3_IMPORT_RUNNING_NOTE}</AlertDescription>
          </Alert>
        </div>
      ) : null}

      <IntroSection
        source={status!.source}
        hideTitle={presentation === "onboarding"}
        selection={selection}
        selectable={selectable}
        disabled={busy}
        onToggle={flow.toggleProject}
        checkAction={
          view.kind === "scanning" ? (
            <>
              <Button size="sm" disabled>
                <Spinner size="xs" />
                {view.copying ? "Copying T3 Code's data…" : "Checking…"}
              </Button>
              {cancelButton}
            </>
          ) : view.kind === "intro" || (view.kind === "report" && view.stale) ? (
            <Button
              size="sm"
              disabled={busy || selection.size === 0}
              onClick={() => void flow.startScan()}
            >
              {pending === "scan" ? (
                <>
                  <Spinner size="xs" />
                  Checking…
                </>
              ) : view.kind === "report" ? (
                "Check again"
              ) : (
                "Check what will be imported"
              )}
            </Button>
          ) : null
        }
        scanPercent={view.kind === "scanning" ? view.percent : undefined}
        error={requestError}
      />

      <div className="panel-height-motion" {...panelProps}>
        <div ref={contentRef} className="flex shrink-0 flex-col gap-8">
          <StageSection
            view={view}
            presentation={presentation}
            source={status!.source}
            busy={busy}
            pending={pending}
            includeSettings={flow.includeSettings}
            onIncludeSettingsChange={flow.setIncludeSettings}
            onImport={(report) => void flow.startImport(report)}
            onCheckAgain={() => void flow.startScan()}
            cancelButton={cancelButton}
          />
        </div>
      </div>
    </>
  );
}

function IntroSection({
  source,
  hideTitle,
  selection,
  selectable,
  disabled,
  onToggle,
  checkAction,
  scanPercent,
  error,
}: {
  source: T3ImportSourceWithBackup;
  hideTitle: boolean;
  selection: ReadonlySet<string>;
  selectable: boolean;
  disabled: boolean;
  onToggle: (sourceProjectId: string, checked: boolean) => void;
  checkAction: ReactNode;
  scanPercent: number | null | undefined;
  error: string | null;
}) {
  return (
    <SettingsSection id="t3-import" title="Import from T3 Code" hideTitle={hideTitle}>
      <SettingsRow
        title="What comes over"
        description={
          <>
            Each project's full history, subagent threads included, as chats you can continue here.
            Keybindings and default models come too. Sign-ins and tokens are never copied, so
            providers ask you to sign in again. <T3ImportLearnMoreLink />
          </>
        }
      />
      {selectable && source.projects.length > 0 ? (
        <SettingsRow
          title="Projects"
          description="Projects already in Cogenly are merged, not duplicated."
        >
          <ul className="flex flex-col gap-0.5 pt-1 pb-2" aria-label="T3 Code projects">
            {source.projects.map((project) => (
              <ProjectOption
                key={project.sourceProjectId}
                project={project}
                checked={selection.has(project.sourceProjectId)}
                disabled={disabled}
                onChange={(checked) => onToggle(project.sourceProjectId, checked)}
              />
            ))}
          </ul>
        </SettingsRow>
      ) : null}
      {checkAction !== null || error !== null ? (
        <SettingsRow
          title={error ? "That didn't work" : "Dry run"}
          description={
            error ?? "Reads T3 Code's data and lists what would change. Nothing is written."
          }
          status={
            scanPercent != null ? <ProgressBar percent={scanPercent} label="Checking" /> : null
          }
          control={checkAction}
        />
      ) : null}
    </SettingsSection>
  );
}

function ProjectOption({
  project,
  checked,
  disabled,
  onChange,
}: {
  project: T3ImportSourceProject;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  // Scratch holds many one-off folders; it comes in a later pass.
  const later = project.isScratch;
  return (
    <li>
      <label
        className={
          later || disabled
            ? "flex items-center gap-2.5 rounded-md py-1 text-sm opacity-64"
            : "flex cursor-pointer items-center gap-2.5 rounded-md py-1 text-sm"
        }
      >
        <Checkbox
          checked={later ? false : checked}
          disabled={later || disabled}
          onCheckedChange={(next) => onChange(next === true)}
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate font-medium">{project.title}</span>
            {later ? (
              <Badge size="sm" variant="outline">
                Later
              </Badge>
            ) : project.existingProjectTitle ? (
              <Badge size="sm" variant="info">
                Merges into {project.existingProjectTitle}
              </Badge>
            ) : null}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {project.workspaceRoot}
          </span>
        </span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {pluralize(project.threadCount, "thread")}
        </span>
      </label>
    </li>
  );
}

function StageSection({
  view,
  presentation,
  source,
  busy,
  pending,
  includeSettings,
  onIncludeSettingsChange,
  onImport,
  onCheckAgain,
  cancelButton,
}: {
  view: T3ImportView;
  presentation: "settings" | "onboarding";
  source: T3ImportSourceWithBackup;
  busy: boolean;
  pending: "scan" | "run" | null;
  includeSettings: boolean;
  onIncludeSettingsChange: (value: boolean) => void;
  onImport: (report: T3ImportReport) => void;
  onCheckAgain: () => void;
  cancelButton: ReactNode;
}) {
  switch (view.kind) {
    case "report":
      return (
        <div key="report" className="swap-motion flex flex-col gap-8">
          <ReportSections report={view.report} />
          {view.report.settings.length > 0 ? (
            <SettingsSection id="t3-import-settings" title="Settings">
              <SettingsRow
                title="Import keybindings and default models"
                description="Untick to leave this environment's settings as they are."
                control={
                  <Checkbox
                    aria-label="Import keybindings and default models"
                    checked={includeSettings}
                    disabled={busy}
                    onCheckedChange={(checked) => onIncludeSettingsChange(checked === true)}
                  />
                }
              />
              {view.report.settings.map((change) => (
                <SettingsRow
                  key={`${change.setting}:${change.action}`}
                  className={includeSettings ? undefined : "opacity-64"}
                  title={change.setting}
                  description={change.detail}
                  control={<Badge variant="outline">{SETTING_ACTION_LABELS[change.action]}</Badge>}
                />
              ))}
            </SettingsSection>
          ) : null}
          <SettingsSection id="t3-import-confirm" title="Import">
            <SettingsRow
              title={
                view.stale
                  ? "The selection changed"
                  : summarizeT3ImportReport(view.report).nothingToImport
                    ? "Everything is already imported"
                    : `Import ${pluralize(view.report.totals.threads, "thread")}`
              }
              description={
                view.stale
                  ? "Check again so the report matches the projects you picked."
                  : backupSentence(source)
              }
              control={
                view.stale ? null : (
                  <Button
                    size="sm"
                    disabled={busy || summarizeT3ImportReport(view.report).nothingToImport}
                    onClick={() => onImport(view.report)}
                  >
                    {pending === "run" ? (
                      <>
                        <Spinner size="xs" />
                        Starting…
                      </>
                    ) : (
                      "Import"
                    )}
                  </Button>
                )
              }
            />
          </SettingsSection>
        </div>
      );
    case "importing":
      return (
        <div key="importing" className="swap-motion">
          <SettingsSection id="t3-import-progress" title="Importing">
            <SettingsRow
              title={T3_IMPORT_PHASE_LABELS[view.progress.phase]}
              description={
                view.progress.phase === "events" && view.progress.totalEvents > 0
                  ? `${view.progress.processedEvents.toLocaleString()} of ${view.progress.totalEvents.toLocaleString()} events. You can keep using Cogenly meanwhile.`
                  : "You can keep using Cogenly meanwhile. Leaving this page doesn't stop the import."
              }
              control={cancelButton}
              status={
                <div className="flex flex-col gap-1.5 pt-1">
                  <ProgressBar percent={view.percent} label="Import progress" />
                  {view.backupPath ? (
                    <span className="block break-all">Backup saved to {view.backupPath}</span>
                  ) : null}
                </div>
              }
            />
          </SettingsSection>
        </div>
      );
    case "done":
      return (
        <div key="done" className="swap-motion">
          <DoneSection
            result={view.result}
            presentation={presentation}
            busy={busy}
            onCheckAgain={onCheckAgain}
          />
        </div>
      );
    case "cancelled":
      return (
        <div key="cancelled" className="swap-motion">
          <SettingsSection id="t3-import-cancelled" title="Import">
            <SettingsRow
              title="Import stopped"
              description={
                <>
                  <span className="block">
                    {view.writtenEvents > 0
                      ? `What was written before it stopped (${pluralize(view.writtenEvents, "event")}) stays imported. Running it again continues from there.`
                      : "Nothing was written. Run it again whenever you're ready."}
                  </span>
                  {view.backupPath ? (
                    <span className="block break-all select-all">
                      Backup from before it started: {view.backupPath}
                    </span>
                  ) : null}
                </>
              }
              control={
                <Button size="sm" disabled={busy} onClick={onCheckAgain}>
                  Check again
                </Button>
              }
            />
          </SettingsSection>
        </div>
      );
    case "failed":
      return (
        <div key="failed" className="swap-motion">
          <SettingsSection id="t3-import-failed" title="Import">
            <SettingsRow
              title={
                <span className="flex items-center gap-1.5">
                  <CircleAlertIcon className="size-3.5 text-destructive" />
                  The import stopped
                </span>
              }
              description={
                <>
                  <span className="block">{view.message}</span>
                  {view.backupPath ? (
                    <span className="block break-all select-all">
                      Your data from before it started is backed up at {view.backupPath}
                    </span>
                  ) : null}
                  <span className="block">
                    Trying again is safe: threads that finished are not imported twice.
                  </span>
                </>
              }
              control={
                <Button size="sm" disabled={busy} onClick={onCheckAgain}>
                  Try again
                </Button>
              }
            />
          </SettingsSection>
        </div>
      );
    default:
      return null;
  }
}

const SETTING_ACTION_LABELS = { set: "Set", add: "Add", keep: "Keep yours" } as const;

function backupSentence(source: T3ImportSourceWithBackup): string {
  return source.backupDirectory
    ? `Cogenly backs up its database and settings first, to ${source.backupDirectory}.`
    : "Cogenly backs up its database and settings first, to the backups folder in its data directory.";
}

function ReportSections({ report }: { report: T3ImportReport }) {
  const summary = summarizeT3ImportReport(report);
  const skipped = listT3SkippedEvents(report.skipped, report.totals.skippedEvents);
  const rerunParts = [
    summary.upToDateThreads > 0
      ? `${pluralize(summary.upToDateThreads, "thread")} already up to date`
      : null,
    summary.updatedThreads > 0
      ? `${pluralize(summary.updatedThreads, "thread")} get new messages`
      : null,
    summary.divergedThreads > 0
      ? `${pluralize(summary.divergedThreads, "thread")} continued here since, left as they are`
      : null,
  ].filter((part) => part !== null);
  return (
    <>
      <SettingsSection id="t3-import-report" title="What will be imported">
        <SettingsRow
          title={`${pluralize(report.totals.threads, "thread")} · ${pluralize(report.totals.messages, "message")}`}
          description={[
            summary.subagentThreads > 0
              ? `${pluralize(summary.subagentThreads, "subagent thread")}`
              : null,
            summary.forkThreads > 0 ? `${pluralize(summary.forkThreads, "fork")}` : null,
            `${pluralize(report.totals.attachments, "attachment")} (${formatBytes(report.totals.attachmentBytes)})`,
          ]
            .filter((part) => part !== null)
            .join(" · ")}
          status={rerunParts.length > 0 ? rerunParts.join(" · ") : null}
        />
        {report.projects.map((project) => (
          <SettingsRow
            key={project.sourceProjectId}
            title={
              <span className="flex items-center gap-1.5">
                {project.title}
                <Badge size="sm" variant={project.action === "merge" ? "info" : "success"}>
                  {project.action === "merge" ? `Matches ${project.projectTitle}` : "New"}
                </Badge>
              </span>
            }
            description={`${pluralize(project.threads, "thread")} · ${pluralize(project.messages, "message")} · ${pluralize(project.attachments, "attachment")} (${formatBytes(project.attachmentBytes)})`}
          />
        ))}
        {report.totals.skippedEvents > 0 ? (
          <SettingsRow
            title={`${pluralize(report.totals.skippedEvents, "event")} can't be read`}
            description="These are left out; the rest of each thread still comes over."
          >
            <div className="pb-2">
              <WorkLogDisclosure label="Show which">
                <ul className="flex max-h-48 flex-col gap-0.5 overflow-y-auto font-mono text-2xs text-muted-foreground select-text">
                  {skipped.rows.map((row) => (
                    <li key={row.key} className="truncate">
                      {row.label}
                    </li>
                  ))}
                  {skipped.hidden > 0 ? <li>and {skipped.hidden.toLocaleString()} more</li> : null}
                </ul>
              </WorkLogDisclosure>
            </div>
          </SettingsRow>
        ) : null}
        {/* The page's own note already says this while T3 Code is open. */}
        {report.warnings
          .filter((warning) => warning !== T3_IMPORT_RUNNING_NOTE)
          .map((warning) => (
            <SettingsRow key={warning} title="Note" description={warning} />
          ))}
      </SettingsSection>
      {report.providers.length > 0 ? (
        <SettingsSection id="t3-import-providers" title="Providers">
          {report.providers.map((provider) => (
            <SettingsRow
              key={provider.instanceId}
              title={provider.instanceId}
              description={[
                pluralize(provider.threads, "thread"),
                provider.homePath ? provider.homePath : null,
              ]
                .filter((part) => part !== null)
                .join(" · ")}
              control={
                <Badge
                  variant={
                    provider.status === "conflict"
                      ? "warning"
                      : provider.status === "create"
                        ? "success"
                        : "outline"
                  }
                >
                  {provider.status === "conflict"
                    ? "Differs"
                    : T3_PROVIDER_STATUS_LABELS[provider.status]}
                </Badge>
              }
              status={provider.status === "conflict" ? T3_PROVIDER_STATUS_LABELS.conflict : null}
            />
          ))}
        </SettingsSection>
      ) : null}
    </>
  );
}

function DoneSection({
  result,
  presentation,
  busy,
  onCheckAgain,
}: {
  result: T3ImportResult;
  presentation: "settings" | "onboarding";
  busy: boolean;
  onCheckAgain: () => void;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "backup path" });
  const selectMode = useSelectSidebarMode();
  return (
    <SettingsSection id="t3-import-done" title="Imported">
      <SettingsRow
        title={
          <span className="flex items-center gap-1.5">
            <CircleCheckIcon className="size-3.5 text-success" />
            {`Imported ${pluralize(result.importedThreads, "thread")}`}
          </span>
        }
        description={[
          pluralize(result.report.projects.length, "project"),
          pluralize(result.writtenEvents, "event"),
          pluralize(result.copiedAttachments, "attachment"),
          result.skippedEvents > 0 ? `${result.skippedEvents.toLocaleString()} skipped` : null,
        ]
          .filter((part) => part !== null)
          .join(" · ")}
        control={
          // Onboarding moves on with its own footer instead.
          presentation === "settings" ? (
            // Imported T3 threads are repository work, listed under Work.
            <Button size="sm" onClick={() => selectMode("tasks", { leaveUtilityPage: true })}>
              Open imported projects
            </Button>
          ) : null
        }
      />
      <SettingsRow
        title="Backup"
        description={<span className="block break-all select-all">{result.backupPath}</span>}
        control={
          <Button
            size="sm"
            variant="outline"
            onClick={() => copyToClipboard(result.backupPath, undefined)}
          >
            {isCopied ? "Copied" : "Copy path"}
          </Button>
        }
      />
      <SettingsRow
        title="Run it again any time"
        description={
          presentation === "settings"
            ? "Re-running is safe: nothing is duplicated, and only what changed in T3 Code since is added."
            : "Re-running is safe: nothing is duplicated, and only what changed in T3 Code since is added. Find it later in Settings → Import."
        }
        control={
          <Button size="sm" variant="outline" disabled={busy} onClick={onCheckAgain}>
            Check again
          </Button>
        }
      />
    </SettingsSection>
  );
}

/** Determinate bar. The fill glides between values; reduced motion jumps. */
function ProgressBar({ percent, label }: { percent: number | null; label: string }) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      {...(percent === null ? {} : { "aria-valuenow": Math.floor(percent) })}
      className="h-1 w-full max-w-xl overflow-hidden rounded-full bg-muted"
    >
      <div
        className="h-full origin-left bg-primary transition-transform duration-(--motion-duration-base) ease-out motion-reduce:transition-none"
        style={{ transform: `scaleX(${(percent ?? 0) / 100})` }}
      />
    </div>
  );
}
