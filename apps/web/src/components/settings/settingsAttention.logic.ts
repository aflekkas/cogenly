import type {
  EnvironmentId,
  MachineHealthAlert,
  MachineHealthCheckId,
  MachineHealthStatus,
} from "@cogenly/contracts";

import type { SettingsPath } from "./settingsSearch";

/**
 * Where the Settings dot comes from. The rail's Settings button shows a dot
 * while any machine-health alert is open; these place the same alerts on the
 * settings pages and rows they concern, so every dot reads from one list and
 * clears with it.
 */

export type SettingsAttentionTone = "destructive" | "warning";

/** What a dotted page or row says to a screen reader. */
export const SETTINGS_PAGE_NEEDS_ATTENTION_LABEL = "needs attention";

/** An open alert as the dots need it. */
export type SettingsAttentionAlert = Pick<
  MachineHealthAlert,
  "originEnvironmentId" | "checkId" | "status" | "target"
>;

/** A dot's colour for a health status, or null when it needs no dot. */
export function attentionToneForStatus(
  status: MachineHealthStatus | null,
): SettingsAttentionTone | null {
  switch (status) {
    case null:
    case "ok":
      return null;
    case "fail":
      return "destructive";
    case "warn":
    case "unknown":
      return "warning";
  }
}

/** The worse of two dots: red over amber over none. */
function worseTone(
  left: SettingsAttentionTone | null,
  right: SettingsAttentionTone | null,
): SettingsAttentionTone | null {
  if (left === "destructive" || right === "destructive") return "destructive";
  return left ?? right;
}

/** The worst of several dots, or null when none shows. */
export function worstTone(
  tones: Iterable<SettingsAttentionTone | null | undefined>,
): SettingsAttentionTone | null {
  let worst: SettingsAttentionTone | null = null;
  for (const tone of tones) worst = worseTone(worst, tone ?? null);
  return worst;
}

/** The worst dot among `alerts`, or null when none needs one. */
export function worstAttentionTone(
  alerts: ReadonlyArray<SettingsAttentionAlert>,
): SettingsAttentionTone | null {
  return worstTone(alerts.map((alert) => attentionToneForStatus(alert.status)));
}

/** The page that owns what an alert is about, besides Machines' health list. */
function owningSettingsPage(alert: SettingsAttentionAlert): SettingsPath | null {
  switch (alert.target?._tag) {
    case "provider":
      return "/settings/providers";
    case "integration":
      return "/settings/integrations";
    case "scheduledTask":
      return "/settings/scheduled-tasks";
    case "storage":
      return "/settings/storage";
    case "thread":
    case "machine":
    case undefined:
      break;
  }
  switch (alert.checkId) {
    case "providers":
      return "/settings/providers";
    case "integrations":
    case "computer-use":
      return "/settings/integrations";
    case "scheduled-tasks":
      return "/settings/scheduled-tasks";
    case "disk":
    case "database":
      return "/settings/storage";
    // Machine-wide: version skew, sync quarantine, orphaned agent processes and the rest
    // are fixed from the machine's own health list.
    case "server":
    case "machine-links":
    case "sync":
    case "stuck-runs":
    case "boot-service":
    case "tailscale-serve":
    case "canary":
    case "chat-terminal-sandbox":
    case "agent-processes":
      return null;
  }
}

/**
 * The settings pages an alert puts a dot on: Machines, which lists every
 * machine's health, and the page where its problem is fixed, when it has one.
 */
export function settingsPagesForAlert(alert: SettingsAttentionAlert): ReadonlyArray<SettingsPath> {
  const owner = owningSettingsPage(alert);
  return owner === null ? ["/settings/machines"] : ["/settings/machines", owner];
}

/** Each settings page's dot: the worst open alert that concerns it. */
export function settingsAttentionByPage(
  alerts: ReadonlyArray<SettingsAttentionAlert>,
): ReadonlyMap<SettingsPath, SettingsAttentionTone> {
  const byPage = new Map<SettingsPath, SettingsAttentionTone>();
  for (const alert of alerts) {
    const tone = attentionToneForStatus(alert.status);
    if (tone === null) continue;
    for (const page of settingsPagesForAlert(alert)) {
      const next = worseTone(byPage.get(page) ?? null, tone);
      if (next !== null) byPage.set(page, next);
    }
  }
  return byPage;
}

/** One machine's dots on its health section, by check. */
export function machineCheckAttention(
  alerts: ReadonlyArray<SettingsAttentionAlert>,
  environmentId: EnvironmentId,
): ReadonlyMap<MachineHealthCheckId, SettingsAttentionTone> {
  const byCheck = new Map<MachineHealthCheckId, SettingsAttentionTone>();
  for (const alert of alerts) {
    if (alert.originEnvironmentId !== environmentId) continue;
    const next = worseTone(
      byCheck.get(alert.checkId) ?? null,
      attentionToneForStatus(alert.status),
    );
    if (next !== null) byCheck.set(alert.checkId, next);
  }
  return byCheck;
}

/** The dot on an integration's row on `environmentId`. */
export function integrationAttentionTone(
  alerts: ReadonlyArray<SettingsAttentionAlert>,
  environmentId: EnvironmentId,
  integrationName: string,
): SettingsAttentionTone | null {
  return worstAttentionTone(
    alerts.filter(
      (alert) =>
        alert.originEnvironmentId === environmentId &&
        alert.target?._tag === "integration" &&
        alert.target.name === integrationName,
    ),
  );
}

/** The dot on a scheduled task's row on `environmentId`. */
export function scheduledTaskAttentionTone(
  alerts: ReadonlyArray<SettingsAttentionAlert>,
  environmentId: EnvironmentId,
  taskId: string,
): SettingsAttentionTone | null {
  return worstAttentionTone(
    alerts.filter(
      (alert) =>
        alert.originEnvironmentId === environmentId &&
        alert.target?._tag === "scheduledTask" &&
        alert.target.taskId === taskId,
    ),
  );
}
