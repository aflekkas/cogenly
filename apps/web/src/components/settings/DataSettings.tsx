import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@cogenly/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ExportResult,
  ExportValidation,
  ProjectLabelId,
} from "@cogenly/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";

import { formatBytes } from "../../lib/formatBytes";
import { sortProjectLabels } from "../../projectLabels/projectLabels.logic";
import { useEnvironmentProjectLabels } from "../../projectLabels/useProjectLabels";
import { exportRpc } from "../../rpc/exports";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { CopyButton } from "../ui/copy-button";
import { Checkbox } from "../ui/checkbox";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsEmpty, SettingsRow, SettingsSection } from "./settingsLayout";

type ExportSection = "chats" | "work" | "agents" | "commitments" | "projects" | "memory";
const SECTIONS: ReadonlyArray<{ value: ExportSection; label: string }> = [
  { value: "chats", label: "Chats" },
  { value: "work", label: "Work" },
  { value: "agents", label: "Agents" },
  { value: "commitments", label: "Open items" },
  { value: "projects", label: "Projects" },
  { value: "memory", label: "Memory" },
];
const ALL = "all";

/** "agentRuns: 3" → "3 agent runs"; record kinds come from the bundle manifest. */
export function summarizeExportCounts(counts: Readonly<Record<string, number>>): string {
  const parts = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${count} ${kind.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()}`);
  return parts.length > 0 ? parts.join(" · ") : "Empty";
}

/** Bundles are named `export-<ISO time>-<id>`; the time reads back from the name. */
export function exportCreatedAt(path: string): string | null {
  const name = path.split(/[\\/]/).at(-1) ?? "";
  const stamp = name.match(/^export-(\d{4}-\d{2}-\d{2}T[\d-]+(?:\.\d+)?Z)-/)?.[1];
  if (!stamp) return null;
  const iso = stamp.replace(/T(\d{2})-(\d{2})-(\d{2})/, "T$1:$2:$3");
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0]) {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "The request failed.";
}

/**
 * Settings → Data. Writes a portable bundle on the environment's machine and lists the
 * recent ones. Follows the scope sentence's environment.
 */
export function DataSettings() {
  const { environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  // Keyed so results and recent exports never carry over to another environment.
  return (
    <DataSettingsPanel
      key={environmentId ?? "none"}
      environmentId={environmentId}
      environmentLabel={environment?.label ?? null}
    />
  );
}

function DataSettingsPanel({
  environmentId,
  environmentLabel,
}: {
  environmentId: EnvironmentId | null;
  environmentLabel: string | null;
}) {
  const canExport = useAtomValue(exportRpc.exportCreate.permissionAtom(environmentId));
  const { labels } = useEnvironmentProjectLabels(environmentId);
  const sortedLabels = useMemo(
    () => sortProjectLabels(labels.map((label) => ({ label }))).map((entry) => entry.label),
    [labels],
  );
  const createExport = useAtomCommand(exportRpc.exportCreate, { reportFailure: false });
  const listExports = useAtomCommand(exportRpc.exportList, { reportFailure: false });
  const validateExport = useAtomCommand(exportRpc.exportValidate, { reportFailure: false });
  const [include, setInclude] = useState<ReadonlySet<ExportSection>>(
    () => new Set(SECTIONS.map((section) => section.value)),
  );
  const [labelId, setLabelId] = useState<string>(ALL);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<ReadonlyArray<ExportResult> | null>(null);
  const [recentError, setRecentError] = useState<string | null>(null);
  const [validations, setValidations] = useState<
    ReadonlyMap<string, ExportValidation | { failed: string } | "running">
  >(new Map());

  const showListed = useCallback((listed: Awaited<ReturnType<typeof listExports>>) => {
    if (listed._tag === "Success") {
      setRecent(listed.value.exports);
      setRecentError(null);
    } else if (!isAtomCommandInterrupted(listed)) {
      setRecentError(failureMessage(listed));
    }
  }, []);
  const refreshRecent = useCallback(async () => {
    if (environmentId === null || !canExport) return;
    showListed(await listExports({ environmentId, input: {} }));
  }, [canExport, environmentId, listExports, showListed]);
  useEffect(() => {
    if (environmentId === null || !canExport) return;
    let cancelled = false;
    void listExports({ environmentId, input: {} }).then((listed) => {
      if (!cancelled) showListed(listed);
    });
    return () => {
      cancelled = true;
    };
  }, [canExport, environmentId, listExports, showListed]);

  const run = async () => {
    if (environmentId === null || include.size === 0 || running) return;
    setRunning(true);
    setError(null);
    try {
      const created = await createExport({
        environmentId,
        input: {
          include: SECTIONS.map((section) => section.value).filter((value) => include.has(value)),
          ...(labelId === ALL ? {} : { labelId: labelId as ProjectLabelId }),
        },
      });
      if (created._tag === "Success") {
        toastManager.add({
          type: "success",
          title: `Exported ${formatBytes(created.value.bytes)}`,
          description: summarizeExportCounts(created.value.counts),
        });
        await refreshRecent();
      } else if (!isAtomCommandInterrupted(created)) {
        setError(failureMessage(created));
      }
    } finally {
      setRunning(false);
    }
  };

  const validate = async (path: string) => {
    if (environmentId === null) return;
    setValidations((current) => new Map(current).set(path, "running"));
    const checked = await validateExport({ environmentId, input: { path } });
    setValidations((current) =>
      new Map(current).set(
        path,
        checked._tag === "Success" ? checked.value : { failed: failureMessage(checked) },
      ),
    );
  };

  const disabledReason =
    environmentId === null
      ? "Choose a machine to export from."
      : !canExport
        ? "This connection can't export. Reconnect with permission to change settings."
        : null;
  const machine = environmentLabel ?? "that machine";

  return (
    <>
      <SettingsSection
        id="data-export"
        title="Export"
        footer="Secrets, provider sign-ins and connection tokens are never exported."
      >
        <SettingsRow
          title="What to include"
          description="Threads come with their messages and runs."
        >
          <div className="flex flex-wrap gap-x-4 gap-y-2 pt-2" role="group" aria-label="Include">
            {SECTIONS.map((section) => (
              <label key={section.value} className="flex cursor-pointer items-center gap-2 text-sm">
                <Checkbox
                  checked={include.has(section.value)}
                  disabled={running}
                  onCheckedChange={(checked) =>
                    setInclude((current) => {
                      const next = new Set(current);
                      if (checked) next.add(section.value);
                      else next.delete(section.value);
                      return next;
                    })
                  }
                />
                {section.label}
              </label>
            ))}
          </div>
        </SettingsRow>
        <SettingsRow
          title="Project"
          description="Export everything, or only one project's chats, Work, open items and memory."
          control={
            <Select value={labelId} onValueChange={(value) => setLabelId(value ?? ALL)}>
              <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Project">
                <SelectValue>
                  {labelId === ALL
                    ? "All projects"
                    : (labels.find((label) => label.id === labelId)?.name ?? "Project")}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value={ALL}>All projects</SelectItem>
                {sortedLabels.map((label) => (
                  <SelectItem key={label.id} value={label.id}>
                    {label.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Export now"
          description={
            disabledReason ??
            (include.size === 0
              ? "Pick at least one thing to include."
              : `Saves one file to the exports folder on ${machine}.`)
          }
          status={error ? <span className="block text-destructive">{error}</span> : null}
          control={
            <Button
              size="sm"
              disabled={disabledReason !== null || include.size === 0 || running}
              onClick={() => void run()}
            >
              {running ? "Exporting…" : "Export"}
            </Button>
          }
        />
      </SettingsSection>

      {disabledReason === null ? (
        <SettingsSection
          id="data-exports-recent"
          title="Recent exports"
          footer={
            recent !== null && recent.length > 0
              ? "Check reads an export back and confirms every record is intact. It changes nothing. Cogenly can't import exports yet."
              : undefined
          }
        >
          {recentError !== null ? (
            <SettingsRow title="Couldn't list exports" description={recentError} />
          ) : recent === null ? (
            <SettingsRow title="Loading exports…" role="status" />
          ) : recent.length === 0 ? (
            <SettingsEmpty label="Exports you make appear here." />
          ) : (
            recent.map((entry) => {
              const createdAt = exportCreatedAt(entry.path);
              const validation = validations.get(entry.path);
              return (
                <SettingsRow
                  key={entry.path}
                  title={`${createdAt ? formatRelativeTimeLabel(createdAt) : "Export"} · ${formatBytes(entry.bytes)}`}
                  description={
                    <>
                      <span className="block">{summarizeExportCounts(entry.counts)}</span>
                      <span className="block break-all select-all">{entry.path}</span>
                    </>
                  }
                  status={
                    validation === undefined || validation === "running" ? null : "failed" in
                      validation ? (
                      <span className="block text-destructive">{validation.failed}</span>
                    ) : validation.errors.length > 0 ? (
                      <span className="block text-destructive">
                        {validation.errors.length === 1
                          ? "1 problem"
                          : `${validation.errors.length} problems`}
                        : {validation.errors[0]}
                      </span>
                    ) : (
                      <span className="block text-success-foreground">Every record is intact.</span>
                    )
                  }
                  control={
                    <div className="flex items-center gap-1.5">
                      <CopyButton
                        label="Copy path"
                        size="icon-sm"
                        target="export path"
                        value={entry.path}
                        variant="ghost-muted"
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={validation === "running"}
                        onClick={() => void validate(entry.path)}
                      >
                        {validation === "running" ? "Checking…" : "Check"}
                      </Button>
                    </div>
                  }
                />
              );
            })
          )}
        </SettingsSection>
      ) : null}
    </>
  );
}
