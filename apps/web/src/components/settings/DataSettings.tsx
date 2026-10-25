import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ExportResult,
  ExportValidation,
  ProjectLabelId,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";

import { formatBytes } from "../../lib/formatBytes";
import { sortProjectLabels } from "../../projectLabels/projectLabels.logic";
import { useEnvironmentProjectLabels } from "../../projectLabels/useProjectLabels";
import { exportRpc } from "../../rpc/exports";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

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
  return <DataSettingsPanel key={environmentId ?? "none"} environmentId={environmentId} />;
}

function DataSettingsPanel({ environmentId }: { environmentId: EnvironmentId | null }) {
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
  const [result, setResult] = useState<ExportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<ReadonlyArray<ExportResult> | null>(null);
  const [recentError, setRecentError] = useState<string | null>(null);
  const [validations, setValidations] = useState<
    ReadonlyMap<string, ExportValidation | { failed: string } | "running">
  >(new Map());

  const refreshRecent = useCallback(async () => {
    if (environmentId === null || !canExport) return;
    const listed = await listExports({ environmentId, input: {} });
    if (listed._tag === "Success") {
      setRecent(listed.value.exports);
      setRecentError(null);
    } else if (!isAtomCommandInterrupted(listed)) {
      setRecentError(failureMessage(listed));
    }
  }, [canExport, environmentId, listExports]);
  useEffect(() => {
    void refreshRecent();
  }, [refreshRecent]);

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
        setResult(created.value);
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
      ? "Choose a machine to export."
      : !canExport
        ? "This connection needs permission to change settings to export."
        : null;

  return (
    <SettingsPageContainer>
      <SettingsSection id="data-export" title="Export">
        <SettingsRow
          title="What to include"
          description="Threads include their messages and runs. Secrets, provider sign-ins and connection tokens are never exported."
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
          description="Limit the export to one project's chats, Work, open items and memory."
          control={
            <Select value={labelId} onValueChange={(value) => setLabelId(value ?? ALL)}>
              <SelectTrigger size="sm" aria-label="Project">
                <SelectValue>
                  {labelId === ALL
                    ? "Everything"
                    : (labels.find((label) => label.id === labelId)?.name ?? "Project")}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value={ALL}>Everything</SelectItem>
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
          title={
            error
              ? "Export failed"
              : result
                ? `Exported ${formatBytes(result.bytes)}`
                : "Write an export bundle"
          }
          description={
            error ??
            (result ? (
              <>
                <span className="block break-all select-all">{result.path}</span>
                <span className="block">{summarizeExportCounts(result.counts)}</span>
              </>
            ) : (
              (disabledReason ?? "Saved as JSON Lines in the exports folder on that machine.")
            ))
          }
          control={
            <Button
              size="sm"
              disabled={disabledReason !== null || include.size === 0 || running}
              title={disabledReason ?? undefined}
              onClick={() => void run()}
            >
              {running ? "Exporting…" : "Export"}
            </Button>
          }
        />
      </SettingsSection>

      <SettingsSection id="data-exports-recent" title="Recent exports">
        {disabledReason !== null ? (
          <SettingsRow title={disabledReason} />
        ) : recentError !== null ? (
          <SettingsRow title="Could not list exports" description={recentError} />
        ) : recent === null ? (
          <SettingsRow title="Loading exports…" />
        ) : recent.length === 0 ? (
          <SettingsRow title="No exports yet" />
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
                    <span className="block break-all select-all">{entry.path}</span>
                    <span className="block">{summarizeExportCounts(entry.counts)}</span>
                    {validation === undefined || validation === "running" ? null : "failed" in
                      validation ? (
                      <span className="block text-destructive">{validation.failed}</span>
                    ) : validation.errors.length > 0 ? (
                      <span className="block text-destructive">
                        {validation.errors.length} problem
                        {validation.errors.length === 1 ? "" : "s"}: {validation.errors[0]}
                      </span>
                    ) : (
                      <span className="block text-success-foreground">
                        Valid · {summarizeExportCounts(validation.counts)}
                      </span>
                    )}
                  </>
                }
                control={
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={validation === "running"}
                    onClick={() => void validate(entry.path)}
                  >
                    {validation === "running" ? "Checking…" : "Validate"}
                  </Button>
                }
              />
            );
          })
        )}
      </SettingsSection>
      <p className="px-3 text-xs text-muted-foreground sm:px-4">
        Validate reads a bundle back and checks every record without changing anything. Importing a
        bundle isn't available yet.
      </p>
    </SettingsPageContainer>
  );
}
