import type { ResourceTelemetryProcess, ResourceTelemetrySourceStatus } from "@cogenly/contracts";

function processIdentityKey(process: ResourceTelemetryProcess): string {
  return `${process.identity.pid}:${process.identity.startTimeMs}`;
}

export function visibleResourceTelemetryProcesses(
  processes: ReadonlyArray<ResourceTelemetryProcess>,
  collapsed: ReadonlySet<string>,
): ReadonlyArray<ResourceTelemetryProcess> {
  const childrenByParent = new Map<number, ResourceTelemetryProcess[]>();
  for (const process of processes) {
    const children = childrenByParent.get(process.ppid) ?? [];
    children.push(process);
    childrenByParent.set(process.ppid, children);
  }

  const hidden = new Set<string>();
  const hideDescendants = (pid: number): void => {
    for (const child of childrenByParent.get(pid) ?? []) {
      const key = processIdentityKey(child);
      if (hidden.has(key)) continue;
      hidden.add(key);
      hideDescendants(child.identity.pid);
    }
  };
  for (const process of processes) {
    if (collapsed.has(processIdentityKey(process))) {
      hideDescendants(process.identity.pid);
    }
  }
  return processes.filter((process) => !hidden.has(processIdentityKey(process)));
}

export function shouldShowResourceMonitorRetry(input: {
  readonly nativeStatus: ResourceTelemetrySourceStatus | null;
  readonly error: string | null;
}): boolean {
  return (
    (input.nativeStatus === null && input.error !== null) ||
    input.nativeStatus === "degraded" ||
    input.nativeStatus === "unavailable" ||
    input.nativeStatus === "stopped"
  );
}

export function resourceHistoryBarHeight(input: {
  readonly value: number;
  readonly max: number;
  readonly minimumVisiblePercent: number;
}): number {
  if (input.value <= 0) return 0;
  return Math.max(input.minimumVisiblePercent, (input.value / Math.max(1, input.max)) * 100);
}

export function resourceHistoryCpuScaleMax(
  buckets: ReadonlyArray<{ readonly avgCpuPercent: number }>,
): number {
  return Math.max(1, ...buckets.map((bucket) => bucket.avgCpuPercent));
}

/**
 * Why the resource monitor isn't running, said once. When the server's own process
 * sampling failed too, its distinct reasons join the monitor's and the line says where
 * the missing numbers went, instead of each section repeating the same error.
 */
export function resourceMonitorUnavailableText(
  reason: string,
  fallbackUnavailableReasons: ReadonlyArray<string> | null,
): string {
  if (fallbackUnavailableReasons === null) return reason;
  const reasons = [...new Set([reason, ...fallbackUnavailableReasons].map((text) => text.trim()))]
    .filter((text) => text.length > 0)
    .map((text) => (/[.!?]$/.test(text) ? text : `${text}.`));
  return `${reasons.join(" ")} Live processes and resource history show here once it runs.`;
}
