import { ProcessSignalActions } from "./ProcessSignalActions";
import { AuthEnvironmentMaintainScope } from "@cogenly/contracts";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import {
  ActivityIcon,
  AlertTriangleIcon,
  BatteryIcon,
  CpuIcon,
  DatabaseIcon,
  GaugeIcon,
  HardDriveIcon,
  HistoryIcon,
  MemoryStickIcon,
} from "lucide-react";
import { ChevronDown, ChevronRight } from "lucide";
import type {
  BackgroundBooleanState,
  EnvironmentId,
  ResourceAttributionEntry,
  ResourceTelemetryAggregate,
  ResourceTelemetryHistoryBucket,
  ResourceTelemetryIoSemantics,
  ResourceTelemetryProcess,
  ResourceTelemetryProcessCategory,
  ResourceTelemetryProcessSummary,
  ResourceTelemetrySourceHealth,
  ResourceTelemetrySourceStatus,
  ServerProcessSignal,
} from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@cogenly/client-runtime/state/runtime";

import {
  useResourceTelemetry,
  useResourceTelemetryHistory,
} from "../../lib/resourceTelemetryState";
import { cn } from "../../lib/utils";
import { formatBytes } from "../../lib/formatBytes";
import { ensureLocalApi } from "../../localApi";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { MorphIcon } from "~/components/MorphIcon";
import { ScrollArea } from "../ui/scroll-area";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import {
  resourceHistoryBarHeight,
  resourceHistoryCpuScaleMax,
  resourceMonitorUnavailableText,
  resourceMonitorRecovery,
  shouldShowResourceMonitorRetry,
  visibleResourceTelemetryProcesses,
} from "./ResourceTelemetryDiagnostics.logic";
import { SettingsGroup } from "./SettingsGroup";
import {
  SETTINGS_MICRO_LABEL_CLASSNAME,
  SettingsEmpty,
  SettingsNote,
  SettingsRefreshAction,
  SettingsRow,
  SettingsRowContent,
  SettingsSection,
} from "./settingsLayout";
import { SettingsStatusBadge, type SettingsStatusTone } from "./SettingsStatus";

const HISTORY_WINDOWS = [
  { label: "5m", windowMs: 5 * 60_000, bucketMs: 15_000 },
  { label: "15m", windowMs: 15 * 60_000, bucketMs: 30_000 },
  { label: "30m", windowMs: 30 * 60_000, bucketMs: 60_000 },
  { label: "1h", windowMs: 60 * 60_000, bucketMs: 2 * 60_000 },
] as const;

/**
 * The monitor's wide tables: cells pad like a settings row at both ends, so
 * the first and last columns sit on the row column, and scroll sideways
 * inside their card when the page is narrower than their minimum width.
 */
const TELEMETRY_TABLE_CLASSNAME =
  "w-full table-fixed text-left text-xs [&_th]:px-3 [&_th]:py-2.5 [&_th]:font-normal [&_td]:px-3 [&_td]:py-2 sm:[&_th:first-child]:pl-4 sm:[&_td:first-child]:pl-4 sm:[&_th:last-child]:pr-4 sm:[&_td:last-child]:pr-4";

const TELEMETRY_THEAD_CLASSNAME = cn(
  "sticky top-0 z-10 border-b border-border/60 bg-card",
  SETTINGS_MICRO_LABEL_CLASSNAME,
);

function formatRate(value: number): string {
  return `${formatBytes(value)}/s`;
}

function formatCpuTime(valueMs: number): string {
  const seconds = valueMs / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 1 : 2)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(minutes >= 10 ? 1 : 2)}m`;
  return `${(minutes / 60).toFixed(2)}h`;
}

function formatDurationMicros(value: number): string {
  if (value < 1_000) return `${Math.round(value)} µs`;
  if (value < 1_000_000) return `${(value / 1_000).toFixed(2)} ms`;
  return `${(value / 1_000_000).toFixed(2)} s`;
}

function formatSampleInterval(valueMs: number): string {
  if (valueMs < 1_000) return `${Math.max(0, Math.round(valueMs))} ms`;
  const seconds = valueMs / 1_000;
  return `${seconds.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${
    seconds === 1 ? "second" : "seconds"
  }`;
}

function processIdentityKey(process: ResourceTelemetryProcess): string {
  return `${process.identity.pid}:${process.identity.startTimeMs}`;
}

function processSummaryIdentityKey(process: ResourceTelemetryProcessSummary): string {
  return `${process.identity.pid}:${process.identity.startTimeMs}`;
}

function formatProcessName(process: Pick<ResourceTelemetryProcess, "command" | "name">): string {
  if (process.name.trim()) return process.name;
  const firstToken = process.command.trim().split(/\s+/)[0] ?? process.command;
  const normalized = firstToken.replace(/^['"]|['"]$/g, "");
  return normalized.split(/[\\/]/).findLast((segment) => segment.length > 0) ?? normalized;
}

function categoryLabel(category: ResourceTelemetryProcessCategory): string {
  switch (category) {
    case "server":
      return "Server";
    case "server-child":
      return "Backend child";
    case "provider-root":
      return "Provider";
    case "terminal-root":
      return "Terminal";
    case "electron-main":
      return "Electron main";
    case "electron-renderer":
      return "Renderer";
    case "electron-gpu":
      return "GPU";
    case "electron-utility":
      return "Electron utility";
    case "resource-monitor":
      return "Monitor";
    case "unknown-t3":
      return "Cogenly process";
  }
}

function categoryDotClass(category: ResourceTelemetryProcessCategory): string {
  if (category === "resource-monitor") return "bg-warning";
  if (category.startsWith("electron-")) return "bg-info";
  if (category === "server") return "bg-violet-500";
  return "bg-success";
}

function ioSemanticsLabel(semantics: ResourceTelemetryIoSemantics): string {
  switch (semantics) {
    case "storage":
      return "Storage bytes";
    case "logical":
      return "Logical bytes";
    case "all-io":
      return "All I/O bytes";
    case "unavailable":
      return "Unavailable";
  }
}

function booleanStateLabel(
  value: BackgroundBooleanState,
  labels: { readonly true: string; readonly false: string },
): string {
  if (value === "true") return labels.true;
  if (value === "false") return labels.false;
  return "Unknown";
}

function sourceStatusTone(status: ResourceTelemetrySourceStatus): SettingsStatusTone {
  if (status === "healthy") return "success";
  if (status === "starting" || status === "degraded") return "warning";
  return "error";
}

function SourceStatusBadge({
  label,
  status,
  presentation,
}: {
  label: string;
  status: ResourceTelemetrySourceStatus;
  presentation?:
    | {
        readonly label: string;
        readonly tone: "neutral";
      }
    | undefined;
}) {
  const tone = presentation?.tone ?? sourceStatusTone(status);
  const statusText = presentation?.label ?? status;
  return (
    <SettingsStatusBadge tone={tone}>
      {label
        ? `${label} ${statusText.toLowerCase()}`
        : statusText.charAt(0).toUpperCase() + statusText.slice(1)}
    </SettingsStatusBadge>
  );
}

function IconStat({
  icon,
  label,
  value,
  detail,
  tone = "default",
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail?: string | undefined;
  tone?: "default" | "warning" | "danger";
}) {
  return (
    <div className="min-w-0 px-3 py-3 sm:px-4">
      <div className={cn("flex h-5 items-center gap-1.5", SETTINGS_MICRO_LABEL_CLASSNAME)}>
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div
        className={cn(
          "mt-1 truncate font-mono text-lg font-semibold tabular-nums text-foreground",
          tone === "warning" && "text-warning-foreground",
          tone === "danger" && "text-destructive",
        )}
      >
        {value}
      </div>
      {detail ? (
        <div className="mt-0.5 truncate text-xs text-muted-foreground">{detail}</div>
      ) : null}
    </div>
  );
}

function AggregateCard({
  label,
  accentClass,
  aggregate,
}: {
  label: string;
  accentClass: string;
  aggregate: ResourceTelemetryAggregate;
}) {
  return (
    <div className="relative overflow-hidden border-t border-border/60 px-3 py-3 first:border-t-0 sm:px-4 md:border-t-0 md:border-l md:first:border-l-0">
      <span
        className={cn(
          "absolute inset-x-3 top-0 h-0.5 rounded-full opacity-75 sm:inset-x-4",
          accentClass,
        )}
      />
      <div className="flex min-h-5 items-center justify-between gap-3">
        <div className={cn("min-w-0 truncate", SETTINGS_MICRO_LABEL_CLASSNAME)}>{label}</div>
        <div className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {aggregate.processCount} {aggregate.processCount === 1 ? "process" : "processes"}
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5">
        <MetricPair label="CPU" value={`${aggregate.currentCpuPercent.toFixed(1)}%`} />
        <MetricPair label="Memory" value={formatBytes(aggregate.currentRssBytes)} />
        <MetricPair label="Read" value={formatRate(aggregate.ioReadBytesPerSecond)} />
        <MetricPair label="Write" value={formatRate(aggregate.ioWriteBytesPerSecond)} />
      </div>
    </div>
  );
}

function MetricPair({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className={SETTINGS_MICRO_LABEL_CLASSNAME}>{label}</div>
      <div className="truncate font-mono text-xs font-medium tabular-nums text-foreground">
        {value}
      </div>
    </div>
  );
}

function HealthSource({ label, health }: { label: string; health: ResourceTelemetrySourceHealth }) {
  const expectedInBrowser =
    health.status === "unavailable" &&
    Option.exists(health.lastError, (error) => error.includes("'web' mode"));
  return (
    <div className="flex items-start justify-between gap-4 border-t border-border/50 py-3 first:border-t-0">
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">{label}</div>
        <div className="mt-0.5 text-xs leading-normal text-muted-foreground">
          {expectedInBrowser
            ? "Available when this page runs inside the desktop app."
            : Option.match(health.lastError, {
                onNone: () => "No reported errors",
                onSome: (error) => error,
              })}
        </div>
      </div>
      <SourceStatusBadge
        label=""
        status={health.status}
        presentation={
          expectedInBrowser
            ? {
                label: "Desktop only",
                tone: "neutral",
              }
            : undefined
        }
      />
    </div>
  );
}

function DetailRow({
  label,
  value,
  valueClassName,
}: {
  label: string;
  value: ReactNode;
  valueClassName?: string | undefined;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-t border-border/50 py-2.5 first:border-t-0">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span
        className={cn(
          "min-w-0 truncate text-right font-mono text-xs tabular-nums text-foreground",
          valueClassName,
        )}
      >
        {value}
      </span>
    </div>
  );
}

function HistoryWindowSelector({
  selectedWindowMs,
  onSelect,
}: {
  selectedWindowMs: number;
  onSelect: (windowMs: number) => void;
}) {
  return (
    <ToggleGroup
      aria-label="Resource history period"
      variant="segmented"
      value={[String(selectedWindowMs)]}
      onValueChange={(next) => {
        const selected = HISTORY_WINDOWS.find((option) => String(option.windowMs) === next[0]);
        if (selected) onSelect(selected.windowMs);
      }}
    >
      {HISTORY_WINDOWS.map((option) => (
        <Toggle key={option.windowMs} value={String(option.windowMs)}>
          {option.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}

function ResourceHistoryChart({
  buckets,
}: {
  buckets: ReadonlyArray<ResourceTelemetryHistoryBucket>;
}) {
  const maxCpu = resourceHistoryCpuScaleMax(buckets);
  const maxIo = Math.max(1, ...buckets.map((bucket) => bucket.ioReadBytes + bucket.ioWriteBytes));

  return (
    <div className="px-3 py-3 sm:px-4">
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-3 rounded-full bg-foreground/70" /> CPU average
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-3 rounded-full bg-info/70" /> I/O reads
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-3 rounded-full bg-warning/80" /> I/O writes
        </span>
      </div>
      <SettingsGroup
        variant="inset"
        divided={false}
        className="flex h-32 items-end gap-1 overflow-hidden px-2 pt-3 pb-2"
      >
        {buckets.map((bucket) => {
          const cpuHeight = resourceHistoryBarHeight({
            value: bucket.avgCpuPercent,
            max: maxCpu,
            minimumVisiblePercent: 2,
          });
          const readHeight = resourceHistoryBarHeight({
            value: bucket.ioReadBytes,
            max: maxIo,
            minimumVisiblePercent: 1,
          });
          const writeHeight = resourceHistoryBarHeight({
            value: bucket.ioWriteBytes,
            max: maxIo,
            minimumVisiblePercent: 1,
          });
          return (
            <Tooltip key={DateTime.formatIso(bucket.startedAt)}>
              <TooltipTrigger
                render={
                  <div className="grid h-full min-w-1 flex-1 grid-cols-3 items-end gap-px">
                    <span
                      className="block rounded-t-sm bg-foreground/65"
                      style={{ height: `${cpuHeight}%` }}
                    />
                    <span
                      className="block rounded-t-sm bg-info/70"
                      style={{ height: `${readHeight}%` }}
                    />
                    <span
                      className="block rounded-t-sm bg-warning/80"
                      style={{ height: `${writeHeight}%` }}
                    />
                  </div>
                }
              />
              <TooltipPopup side="top" className="text-left">
                <div className="space-y-0.5">
                  <div>CPU avg {bucket.avgCpuPercent.toFixed(1)}%</div>
                  <div>CPU peak {bucket.maxCpuPercent.toFixed(1)}%</div>
                  <div>Read {formatBytes(bucket.ioReadBytes)}</div>
                  <div>Write {formatBytes(bucket.ioWriteBytes)}</div>
                </div>
              </TooltipPopup>
            </Tooltip>
          );
        })}
      </SettingsGroup>
    </div>
  );
}

function ProcessTreeName({
  process,
  collapsed,
  onToggle,
}: {
  process: ResourceTelemetryProcess;
  collapsed: boolean;
  onToggle: (process: ResourceTelemetryProcess) => void;
}) {
  const name = formatProcessName(process);
  const hasChildren = process.childPids.length > 0;
  return (
    <div
      className="grid min-w-0 grid-cols-[1.25rem_0.375rem_minmax(0,1fr)] items-center gap-2"
      style={{ paddingLeft: `${Math.min(process.depth, 7) * 10}px` }}
    >
      {hasChildren ? (
        <Button
          size="icon-micro"
          variant="ghost-muted"
          onClick={() => onToggle(process)}
          aria-label={collapsed ? `Expand ${name}` : `Collapse ${name}`}
        >
          <MorphIcon className="size-3.5" icon={collapsed ? ChevronRight : ChevronDown} />
        </Button>
      ) : (
        <span className="size-5" aria-hidden />
      )}
      <span className={cn("size-1.5 rounded-full", categoryDotClass(process.category))} />
      <Tooltip>
        <TooltipTrigger
          render={<span className="min-w-0 truncate font-medium text-foreground">{name}</span>}
        />
        <TooltipPopup side="top" variant="code">
          {process.command || process.name}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

function canSignalProcess(process: ResourceTelemetryProcess): boolean {
  return (
    process.category === "server-child" ||
    process.category === "provider-root" ||
    process.category === "terminal-root"
  );
}

function ProcessActions({
  process,
  canMaintainEnvironment,
  signalingKeys,
  onSignal,
}: {
  process: ResourceTelemetryProcess;
  canMaintainEnvironment: boolean;
  signalingKeys: ReadonlySet<string>;
  onSignal: (process: ResourceTelemetryProcess, signal: ServerProcessSignal) => void;
}) {
  if (!canSignalProcess(process)) {
    return null;
  }
  const isSignaling = signalingKeys.has(processIdentityKey(process));
  return (
    <ProcessSignalActions
      disabled={!canMaintainEnvironment || isSignaling}
      onSignal={(signal) => onSignal(process, signal)}
    />
  );
}

function ProcessTable({
  processes,
  canMaintainEnvironment,
  signalingKeys,
  onSignal,
}: {
  processes: ReadonlyArray<ResourceTelemetryProcess>;
  canMaintainEnvironment: boolean;
  signalingKeys: ReadonlySet<string>;
  onSignal: (process: ResourceTelemetryProcess, signal: ServerProcessSignal) => void;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const visible = useMemo(
    () => visibleResourceTelemetryProcesses(processes, collapsed),
    [collapsed, processes],
  );
  const toggle = useCallback((process: ResourceTelemetryProcess) => {
    const identityKey = processIdentityKey(process);
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(identityKey)) {
        next.delete(identityKey);
      } else {
        next.add(identityKey);
      }
      return next;
    });
  }, []);

  if (visible.length === 0) {
    return <SettingsNote role="status">Waiting for the native process monitor.</SettingsNote>;
  }

  return (
    <div>
      <ScrollArea
        chainVerticalScroll
        scrollFade
        className="max-h-[min(68vh,48rem)] w-full max-w-full"
      >
        <table className={cn(TELEMETRY_TABLE_CLASSNAME, "min-w-[1320px]")}>
          <colgroup>
            <col className="w-[20%]" />
            <col className="w-[9%]" />
            <col className="w-[7%]" />
            <col className="w-[8%]" />
            <col className="w-[9%]" />
            <col className="w-[9%]" />
            <col className="w-[9%]" />
            <col className="w-[8%]" />
            <col className="w-[8%]" />
            <col className="w-[6%]" />
            <col className="w-[7%]" />
          </colgroup>
          <thead className={TELEMETRY_THEAD_CLASSNAME}>
            <tr>
              <th>Process</th>
              <th>Category</th>
              <th className="text-right">CPU</th>
              <th className="text-right">CPU time</th>
              <th className="text-right">Memory</th>
              <th className="text-right">Read/s</th>
              <th className="text-right">Write/s</th>
              <th className="text-right">Read total</th>
              <th className="text-right">Write total</th>
              <th className="text-right">PID</th>
              <th className="text-right">Signal</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {visible.map((process) => (
              <tr key={processIdentityKey(process)} className="interactive hover:bg-muted/20">
                <td>
                  <ProcessTreeName
                    process={process}
                    collapsed={collapsed.has(processIdentityKey(process))}
                    onToggle={toggle}
                  />
                </td>
                <td className="truncate text-muted-foreground">
                  {categoryLabel(process.category)}
                </td>
                <td className="text-right font-mono tabular-nums">
                  {process.cpuPercent.toFixed(1)}%
                </td>
                <td className="text-right font-mono tabular-nums">
                  {formatCpuTime(process.cpuTimeMs)}
                </td>
                <td className="text-right font-mono tabular-nums">
                  {formatBytes(process.residentBytes)}
                </td>
                <td className="text-right font-mono tabular-nums text-info-foreground">
                  {formatRate(process.ioReadBytesPerSecond)}
                </td>
                <td className="text-right font-mono tabular-nums text-warning-foreground">
                  {formatRate(process.ioWriteBytesPerSecond)}
                </td>
                <td className="text-right font-mono tabular-nums text-muted-foreground">
                  {formatBytes(process.ioReadBytes)}
                </td>
                <td className="text-right font-mono tabular-nums text-muted-foreground">
                  <Tooltip>
                    <TooltipTrigger render={<span>{formatBytes(process.ioWriteBytes)}</span>} />
                    <TooltipPopup side="top">{ioSemanticsLabel(process.ioSemantics)}</TooltipPopup>
                  </Tooltip>
                </td>
                <td className="text-right font-mono tabular-nums text-muted-foreground">
                  {process.identity.pid}
                </td>
                <td className="text-right">
                  <ProcessActions
                    process={process}
                    canMaintainEnvironment={canMaintainEnvironment}
                    signalingKeys={signalingKeys}
                    onSignal={onSignal}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollArea>
    </div>
  );
}

function HistoryProcessTable({
  processes,
}: {
  processes: ReadonlyArray<ResourceTelemetryProcessSummary>;
}) {
  if (processes.length === 0) {
    return (
      <SettingsEmpty icon={<HistoryIcon />} label="No retained process samples in this window." />
    );
  }
  return (
    <div>
      <ScrollArea chainVerticalScroll scrollFade className="max-h-[28rem] w-full max-w-full">
        <table className={cn(TELEMETRY_TABLE_CLASSNAME, "min-w-[1020px]")}>
          <colgroup>
            <col className="w-[24%]" />
            <col className="w-[11%]" />
            <col className="w-[10%]" />
            <col className="w-[10%]" />
            <col className="w-[11%]" />
            <col className="w-[10%]" />
            <col className="w-[10%]" />
            <col className="w-[7%]" />
            <col className="w-[7%]" />
          </colgroup>
          <thead className={TELEMETRY_THEAD_CLASSNAME}>
            <tr>
              <th>Process</th>
              <th>Category</th>
              <th className="text-right">CPU time</th>
              <th className="text-right">Peak CPU</th>
              <th className="text-right">Peak memory</th>
              <th className="text-right">Read</th>
              <th className="text-right">Write</th>
              <th className="text-right">Samples</th>
              <th className="text-right">PID</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {processes.map((process) => (
              <tr
                key={processSummaryIdentityKey(process)}
                className="interactive hover:bg-muted/20"
              >
                <td>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span className="block truncate font-medium text-foreground">
                          {process.name || process.command}
                        </span>
                      }
                    />
                    <TooltipPopup side="top" variant="code">
                      {process.command || process.name}
                    </TooltipPopup>
                  </Tooltip>
                </td>
                <td className="truncate text-muted-foreground">
                  {categoryLabel(process.category)}
                </td>
                <td className="text-right font-mono tabular-nums">
                  {formatCpuTime(process.cpuTimeMs)}
                </td>
                <td className="text-right font-mono tabular-nums">
                  {process.maxCpuPercent.toFixed(1)}%
                </td>
                <td className="text-right font-mono tabular-nums">
                  {formatBytes(process.peakRssBytes)}
                </td>
                <td className="text-right font-mono tabular-nums text-info-foreground">
                  {formatBytes(process.ioReadBytes)}
                </td>
                <td className="text-right font-mono tabular-nums text-warning-foreground">
                  {formatBytes(process.ioWriteBytes)}
                </td>
                <td className="text-right font-mono tabular-nums text-muted-foreground">
                  {process.sampleCount}
                </td>
                <td className="text-right font-mono tabular-nums text-muted-foreground">
                  {process.identity.pid}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollArea>
    </div>
  );
}

function AttributionTable({ entries }: { entries: ReadonlyArray<ResourceAttributionEntry> }) {
  if (entries.length === 0) {
    return (
      <SettingsEmpty
        icon={<DatabaseIcon />}
        label="No instrumented application I/O has been recorded yet."
      />
    );
  }
  return (
    <div className="scroll-fade-x overflow-x-auto">
      <table className={cn(TELEMETRY_TABLE_CLASSNAME, "min-w-[720px]")}>
        <colgroup>
          <col className="w-[22%]" />
          <col className="w-[28%]" />
          <col className="w-[14%]" />
          <col className="w-[14%]" />
          <col className="w-[10%]" />
          <col className="w-[12%]" />
        </colgroup>
        <thead className={TELEMETRY_THEAD_CLASSNAME}>
          <tr>
            <th>Component</th>
            <th>Operation</th>
            <th className="text-right">Logical read</th>
            <th className="text-right">Logical write</th>
            <th className="text-right">Count</th>
            <th className="text-right">Time</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/50">
          {entries.map((entry) => (
            <tr
              key={`${entry.component}:${entry.operation}`}
              className="interactive hover:bg-muted/20"
            >
              <td className="truncate font-medium text-foreground">{entry.component}</td>
              <td className="truncate text-muted-foreground">{entry.operation}</td>
              <td className="text-right font-mono tabular-nums text-info-foreground">
                {formatBytes(entry.logicalReadBytes)}
              </td>
              <td className="text-right font-mono tabular-nums text-warning-foreground">
                {formatBytes(entry.logicalWriteBytes)}
              </td>
              <td className="text-right font-mono tabular-nums">{entry.count}</td>
              <td className="text-right font-mono tabular-nums text-muted-foreground">
                {(entry.durationMs / 1_000).toFixed(2)}s
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The native resource monitor's sections. When the monitor can't run on this machine they
 * collapse to one status row with Retry, followed by `fallback`, the server's own process
 * sampling, so the page never shows the same processes twice or a wall of empty tables.
 * When that sampling failed too (`fallbackUnavailableReasons`), the status row says so
 * once and `fallback` stays hidden, so the row's one action re-samples it as well.
 */
export function ResourceTelemetryDiagnostics({
  environmentId,
  fallback,
  fallbackUnavailableReasons,
  fallbackRefreshing,
  onRefreshFallback,
}: {
  environmentId: EnvironmentId | null;
  fallback: ReactNode;
  fallbackUnavailableReasons: ReadonlyArray<string> | null;
  /** Whether the server's process samplers are re-sampling, for the combined recovery action. */
  fallbackRefreshing: boolean;
  /** Re-samples both of the server's process samplers. */
  onRefreshFallback: () => void;
}) {
  const [windowMs, setWindowMs] = useState(15 * 60_000);
  const selectedWindow =
    HISTORY_WINDOWS.find((option) => option.windowMs === windowMs) ?? HISTORY_WINDOWS[1];
  const canMaintainEnvironment = useEnvironmentScope(environmentId, AuthEnvironmentMaintainScope);
  const telemetry = useResourceTelemetry(environmentId);
  const retryTelemetry = telemetry.retry;
  const history = useResourceTelemetryHistory(
    {
      windowMs: selectedWindow.windowMs,
      bucketMs: selectedWindow.bucketMs,
    },
    environmentId,
  );
  const signalServerProcess = useAtomCommand(serverEnvironment.signalProcess, {
    reportFailure: false,
  });
  const [signalingKeys, setSignalingKeys] = useState<ReadonlySet<string>>(() => new Set());
  const signalingKeysRef = useRef<ReadonlySet<string>>(new Set());
  const environmentIdRef = useRef(environmentId);
  useEffect(() => {
    environmentIdRef.current = environmentId;
    return () => {
      environmentIdRef.current = null;
    };
  }, [environmentId]);
  const [isRetrying, setIsRetrying] = useState(false);
  const snapshot = telemetry.data;
  const allT3 = snapshot?.groups.allT3;

  const signalProcess = useCallback(
    async (process: ResourceTelemetryProcess, signal: ServerProcessSignal) => {
      const targetEnvironmentId = environmentIdRef.current;
      if (
        targetEnvironmentId === null ||
        !readEnvironmentScope(targetEnvironmentId, AuthEnvironmentMaintainScope)
      )
        return;
      const identityKey = processIdentityKey(process);
      if (signalingKeysRef.current.has(identityKey)) return;
      const nextSignalingKeys = new Set(signalingKeysRef.current).add(identityKey);
      signalingKeysRef.current = nextSignalingKeys;
      setSignalingKeys(nextSignalingKeys);
      const clearSignaling = () => {
        const next = new Set(signalingKeysRef.current);
        next.delete(identityKey);
        signalingKeysRef.current = next;
        setSignalingKeys(next);
      };

      if (signal === "SIGKILL") {
        let confirmed = false;
        try {
          confirmed = await ensureLocalApi().dialogs.confirm(
            `Send SIGKILL to process ${process.identity.pid}? This cannot be handled by the process.`,
            { variant: "destructive" },
          );
        } catch (error) {
          clearSignaling();
          toastManager.add({
            type: "error",
            title: "Could not confirm signal",
            description: error instanceof Error ? error.message : `Failed to send ${signal}.`,
          });
          return;
        }
        if (!confirmed) {
          clearSignaling();
          return;
        }
      }
      if (
        environmentIdRef.current !== targetEnvironmentId ||
        !readEnvironmentScope(targetEnvironmentId, AuthEnvironmentMaintainScope)
      ) {
        clearSignaling();
        return;
      }
      void signalServerProcess({
        environmentId: targetEnvironmentId,
        input: {
          pid: process.identity.pid,
          startTimeMs: process.identity.startTimeMs,
          signal,
        },
      })
        .then((result) => {
          if (result._tag === "Failure") {
            if (isAtomCommandInterrupted(result)) return;
            throw squashAtomCommandFailure(result);
          }
          if (result.value.signaled) return;
          toastManager.add({
            type: "error",
            title: `Could not send ${signal}`,
            description: Option.getOrElse(
              result.value.message,
              () => `Failed to send ${signal} to process ${process.identity.pid}.`,
            ),
          });
        })
        .catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title: `Could not send ${signal}`,
            description: error instanceof Error ? error.message : `Failed to send ${signal}.`,
          });
        })
        .finally(() => {
          clearSignaling();
        });
    },
    [signalServerProcess],
  );

  const retryCollector = useCallback(() => {
    const environmentId = environmentIdRef.current;
    if (
      environmentId === null ||
      !readEnvironmentScope(environmentId, AuthEnvironmentMaintainScope)
    )
      return;
    setIsRetrying(true);
    void retryTelemetry()
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Could not restart resource monitor",
          description:
            error instanceof Error ? error.message : "The resource monitor retry failed.",
        });
      })
      .finally(() => {
        setIsRetrying(false);
      });
  }, [retryTelemetry]);

  const speedLimit = snapshot ? Option.getOrNull(snapshot.speedLimitPercent) : null;
  const collectorNeedsRetry = shouldShowResourceMonitorRetry({
    nativeStatus: snapshot?.health.native.status ?? null,
    error: telemetry.error,
  });
  const hasHostPowerSignal =
    snapshot !== null &&
    (snapshot.power.onBattery !== "unknown" ||
      snapshot.power.lowPowerMode !== "unknown" ||
      snapshot.power.idle !== "unknown" ||
      snapshot.power.locked !== "unknown" ||
      snapshot.power.thermalState !== "unknown");

  const nativeStatus = snapshot?.health.native.status ?? null;
  const nativeMissing =
    (snapshot === null && telemetry.error !== null) ||
    nativeStatus === "unavailable" ||
    nativeStatus === "stopped";
  if (nativeMissing) {
    const reason =
      telemetry.error ??
      (snapshot ? Option.getOrNull(snapshot.health.native.lastError) : null) ??
      "The monitor stopped.";
    const recovery = resourceMonitorRecovery({
      canRestartMonitor: canMaintainEnvironment,
      samplersHidden: fallbackUnavailableReasons !== null,
    });
    const recovering = isRetrying || (recovery?.refreshesSamplers === true && fallbackRefreshing);
    const recover = () => {
      if (!recovery) return;
      if (recovery.refreshesSamplers) {
        onRefreshFallback();
        if (!recovery.restartsMonitor) telemetry.refresh();
      }
      if (recovery.restartsMonitor) retryCollector();
    };
    return (
      <>
        <SettingsSection title="Resource monitor">
          <SettingsRow
            title="The detailed monitor isn't running"
            description={resourceMonitorUnavailableText(reason, fallbackUnavailableReasons)}
            control={
              recovery ? (
                <Button size="sm" variant="outline" busy={recovering} onClick={recover}>
                  {recovering ? "Retrying…" : "Retry"}
                </Button>
              ) : undefined
            }
          />
        </SettingsSection>
        {fallbackUnavailableReasons === null ? fallback : null}
      </>
    );
  }

  return (
    <>
      <SettingsSection
        title="Resource monitor"
        variant="plain"
        headerAction={
          <>
            {snapshot ? (
              <SourceStatusBadge label="Native" status={snapshot.health.native.status} />
            ) : null}
            <SettingsRefreshAction
              label="Refresh telemetry snapshot"
              refreshing={telemetry.isPending}
              checkedAt={snapshot ? DateTime.formatIso(snapshot.readAt) : null}
              idleLabel="Waiting for sample"
              onRefresh={telemetry.refresh}
            />
          </>
        }
      >
        <SettingsGroup divided={false} className="overflow-hidden">
          <SettingsRowContent
            className="rounded-none border-b border-border/60"
            title="System footprint"
            description="Live native counters for the server, providers, terminals, desktop processes and the monitor itself."
            status={
              snapshot ? `Sampling every ${formatSampleInterval(snapshot.sampleIntervalMs)}` : null
            }
          />
          <div className="grid grid-cols-2 divide-x divide-y divide-border/50 md:grid-cols-3">
            <IconStat
              icon={<CpuIcon className="size-3.5" />}
              label="Current CPU"
              value={allT3 ? `${allT3.currentCpuPercent.toFixed(1)}%` : "…"}
              detail={allT3 ? `${formatCpuTime(allT3.cpuTimeMs)} observed CPU time` : undefined}
            />
            <IconStat
              icon={<MemoryStickIcon className="size-3.5" />}
              label="Resident memory"
              value={allT3 ? formatBytes(allT3.currentRssBytes) : "…"}
              detail={
                allT3 ? `${formatBytes(allT3.peakRssBytes)} combined process peaks` : undefined
              }
            />
            <IconStat
              icon={<ActivityIcon className="size-3.5" />}
              label="Process count"
              value={allT3 ? String(allT3.processCount) : "…"}
              detail={
                allT3 ? `${allT3.processStarts} starts · ${allT3.processExits} exits` : undefined
              }
            />
            <IconStat
              icon={<HardDriveIcon className="size-3.5" />}
              label="Read throughput"
              value={allT3 ? formatRate(allT3.ioReadBytesPerSecond) : "…"}
              detail={allT3 ? `${formatBytes(allT3.ioReadBytes)} observed` : undefined}
            />
            <IconStat
              icon={<DatabaseIcon className="size-3.5" />}
              label="Write throughput"
              value={allT3 ? formatRate(allT3.ioWriteBytesPerSecond) : "…"}
              detail={allT3 ? `${formatBytes(allT3.ioWriteBytes)} observed` : undefined}
              tone={
                allT3 && allT3.ioWriteBytesPerSecond >= 10 * 1_024 * 1_024
                  ? "danger"
                  : allT3 && allT3.ioWriteBytesPerSecond >= 1_024 * 1_024
                    ? "warning"
                    : "default"
              }
            />
            <IconStat
              icon={<GaugeIcon className="size-3.5" />}
              label="CPU speed limit"
              value={
                snapshot ? (speedLimit === null ? "Unknown" : `${speedLimit.toFixed(0)}%`) : "…"
              }
              detail={snapshot ? `${snapshot.power.thermalState} thermal state` : undefined}
              tone={speedLimit !== null && speedLimit < 80 ? "warning" : "default"}
            />
          </div>
          {telemetry.error ? (
            <div className="flex items-start gap-2 border-t border-destructive/20 bg-destructive/5 px-3 py-3 text-xs text-destructive sm:px-4">
              <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
              <span>{telemetry.error}</span>
            </div>
          ) : null}
          {snapshot ? (
            <div className="grid border-t border-border/60 bg-muted/10 md:grid-cols-3">
              <AggregateCard
                label="Backend + agents"
                accentClass="bg-success/80"
                aggregate={snapshot.groups.backend}
              />
              <AggregateCard
                label="Desktop"
                accentClass="bg-info/80"
                aggregate={snapshot.groups.electron}
              />
              <AggregateCard
                label="Monitor overhead"
                accentClass="bg-warning/80"
                aggregate={snapshot.groups.monitor}
              />
            </div>
          ) : null}
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        title="Host & collection"
        variant="plain"
        headerAction={
          collectorNeedsRetry ? (
            <Button size="xs" variant="ghost-muted" busy={isRetrying} onClick={retryCollector}>
              <RefreshIcon size="xs" refreshing={isRetrying} />
              Retry monitor
            </Button>
          ) : null
        }
      >
        <SettingsGroup
          divided={false}
          className="grid overflow-hidden md:grid-cols-2 md:divide-x md:divide-border/60"
        >
          <div className="px-3 py-3 sm:px-4">
            <div
              className={cn("mb-1 flex h-5 items-center gap-1.5", SETTINGS_MICRO_LABEL_CLASSNAME)}
            >
              <BatteryIcon className="size-3.5" />
              Host state
            </div>
            {hasHostPowerSignal && snapshot ? (
              <>
                <DetailRow
                  label="Power source"
                  value={booleanStateLabel(snapshot.power.onBattery, {
                    true: "Battery",
                    false: "External power",
                  })}
                />
                <DetailRow
                  label="Low power mode"
                  value={booleanStateLabel(snapshot.power.lowPowerMode, {
                    true: "Enabled",
                    false: "Disabled",
                  })}
                />
                <DetailRow
                  label="Idle"
                  value={`${booleanStateLabel(snapshot.power.idle, {
                    true: "Idle",
                    false: "Active",
                  })}${
                    snapshot.power.idleSeconds === null
                      ? ""
                      : ` · ${Math.round(snapshot.power.idleSeconds)}s`
                  }`}
                />
                <DetailRow
                  label="Session"
                  value={
                    snapshot.power.suspended
                      ? "Suspended"
                      : booleanStateLabel(snapshot.power.locked, {
                          true: "Locked",
                          false: "Unlocked",
                        })
                  }
                />
                <DetailRow
                  label="Thermal"
                  value={snapshot.power.thermalState}
                  valueClassName={
                    snapshot.power.thermalState === "serious" ||
                    snapshot.power.thermalState === "critical"
                      ? "text-destructive"
                      : undefined
                  }
                />
              </>
            ) : (
              <SettingsGroup variant="inset" divided={false} className="mt-2">
                <SettingsRowContent
                  title="Desktop host not connected"
                  description="Power, idle, lock and thermal state come from the desktop app. Process telemetry still runs in this browser."
                />
              </SettingsGroup>
            )}
          </div>
          <div className="border-t border-border/60 px-3 py-3 sm:px-4 md:border-t-0">
            <div
              className={cn("mb-1 flex h-5 items-center gap-1.5", SETTINGS_MICRO_LABEL_CLASSNAME)}
            >
              <GaugeIcon className="size-3.5" />
              Collection health
            </div>
            {snapshot ? (
              <>
                <HealthSource label="Native process monitor" health={snapshot.health.native} />
                <HealthSource label="Electron main process" health={snapshot.health.desktop} />
                <DetailRow
                  label="Collection time"
                  value={formatDurationMicros(snapshot.health.collectionDurationMicros)}
                />
                <DetailRow
                  label="Process scan"
                  value={`${snapshot.health.retainedProcessCount}/${snapshot.health.scannedProcessCount} retained`}
                />
                <DetailRow
                  label="Inaccessible"
                  value={String(snapshot.health.inaccessibleProcessCount)}
                  valueClassName={
                    snapshot.health.inaccessibleProcessCount > 0
                      ? "text-warning-foreground"
                      : undefined
                  }
                />
                <DetailRow
                  label="Sidecar"
                  value={Option.match(snapshot.health.sidecarVersion, {
                    onNone: () => "Unavailable",
                    onSome: (version) =>
                      `${version}${Option.match(snapshot.health.sidecarPid, {
                        onNone: () => "",
                        onSome: (pid) => ` · PID ${pid}`,
                      })}`,
                  })}
                />
                <DetailRow label="Restarts" value={String(snapshot.health.restartCount)} />
              </>
            ) : (
              <p role="status" className="py-2.5 text-xs text-muted-foreground">
                Waiting for collector health.
              </p>
            )}
          </div>
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        title="Resource timeline"
        variant="plain"
        headerAction={
          <>
            <HistoryWindowSelector selectedWindowMs={windowMs} onSelect={setWindowMs} />
            <SettingsRefreshAction
              label="Refresh resource history"
              refreshing={history.isPending}
              onRefresh={history.refresh}
            />
          </>
        }
      >
        <SettingsGroup className="overflow-hidden">
          {history.error ? (
            <div className="flex items-start gap-2 bg-destructive/5 px-3 py-3 text-xs text-destructive sm:px-4">
              <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
              <span>{history.error}</span>
            </div>
          ) : null}
          <ResourceHistoryChart buckets={history.data?.buckets ?? []} />
          <HistoryProcessTable processes={history.data?.topProcesses ?? []} />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        title="Live process tree"
        variant="plain"
        headerAction={
          snapshot ? (
            <span className="text-xs text-muted-foreground">Keyed by PID and start time</span>
          ) : null
        }
      >
        <SettingsGroup divided={false} className="overflow-hidden">
          <ProcessTable
            processes={snapshot?.processes ?? []}
            canMaintainEnvironment={canMaintainEnvironment}
            signalingKeys={signalingKeys}
            onSignal={signalProcess}
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        title="Instrumented application I/O"
        variant="plain"
        headerAction={
          <span className="text-xs text-muted-foreground">Logical bytes by operation</span>
        }
      >
        <SettingsGroup className="overflow-hidden">
          <SettingsNote>
            Native counters show which process reads or writes. These counters show which known
            Cogenly operation did it, so a process spike can be traced to a persistence or logging
            path.
          </SettingsNote>
          <AttributionTable entries={snapshot?.attribution.entries ?? []} />
        </SettingsGroup>
      </SettingsSection>
    </>
  );
}
