/** One open health alert, as the turn context names it. */
export interface MachineHealthContextAlert {
  readonly originMachineName: string;
  readonly status: string;
  readonly title: string;
}

/** Alerts named before `+N more`. */
const MAX_ALERTS = 3;
const MAX_TITLE_LENGTH = 100;

const toSingleLine = (value: string) => value.replaceAll(/\s+/g, " ").trim();

/**
 * The one line a provider turn gets while a machine is unhealthy, e.g.
 * `Machine health: Contabo VPS: Claude needs sign-in; scheduled task "Nightly"
 * failed. Call machine_health for details.` Null when nothing is open.
 */
export function buildMachineHealthContextLine(
  openAlerts: ReadonlyArray<MachineHealthContextAlert>,
): string | null {
  if (openAlerts.length === 0) return null;
  // Failures first; the sort is stable, so arrival order holds within a status.
  const shown = openAlerts
    .toSorted((left, right) => Number(right.status === "fail") - Number(left.status === "fail"))
    .slice(0, MAX_ALERTS);
  const groups = new Map<string, Array<string>>();
  for (const alert of shown) {
    const machine = toSingleLine(alert.originMachineName);
    let title = toSingleLine(alert.title);
    // "Contabo VPS hasn't been reachable…" already names its machine.
    if (title.startsWith(`${machine} `)) title = title.slice(machine.length + 1);
    if (title.length > MAX_TITLE_LENGTH) title = `${title.slice(0, MAX_TITLE_LENGTH - 1)}…`;
    groups.set(machine, [...(groups.get(machine) ?? []), title]);
  }
  const named = [...groups].map(([machine, titles]) => `${machine}: ${titles.join("; ")}`);
  const more = openAlerts.length - shown.length;
  return `Machine health: ${named.join(". ")}${more > 0 ? ` (+${more} more)` : ""}. Call machine_health for details.`;
}
