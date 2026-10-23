import type { EnvironmentMachineKind } from "@t3tools/contracts";

export interface PreviewMachineEnvironment {
  readonly label: string;
  readonly machine: EnvironmentMachineKind;
}

export interface PreviewMachine {
  readonly label: string;
  readonly machine: EnvironmentMachineKind;
  /** The tooltip and accessible name. */
  readonly description: string;
}

/**
 * Where a browser tab's browser runs, for the chip beside the address bar.
 * A server tab runs on its thread's environment; a desktop tab runs in this
 * desktop app, on this computer, which the primary environment names when
 * there is one. Null when there is nothing to tell apart: one environment and
 * a tab on it, or a desktop tab this client cannot show.
 */
export function resolvePreviewMachine(input: {
  readonly runtime: "server" | "desktop" | undefined;
  readonly threadEnvironment: PreviewMachineEnvironment | null;
  readonly threadIsPrimary: boolean;
  readonly primaryEnvironment: PreviewMachineEnvironment | null;
  /** This client renders desktop tabs itself (the desktop app). */
  readonly rendersDesktopTabs: boolean;
  readonly environmentCount: number;
}): PreviewMachine | null {
  if (input.runtime === undefined) return null;
  if (input.runtime === "server") {
    if (input.environmentCount <= 1) return null;
    const environment = input.threadEnvironment ?? { label: "Remote", machine: "server" };
    return {
      ...environment,
      description: input.threadIsPrimary
        ? `Browser runs on this computer (${environment.label})`
        : `Browser runs on ${environment.label}`,
    };
  }
  if (!input.rendersDesktopTabs) return null;
  // A remote thread's desktop tab runs somewhere other than the thread, so it
  // is worth naming even when this computer has no environment of its own.
  if (input.environmentCount <= 1 && input.threadIsPrimary) return null;
  const local = input.primaryEnvironment ?? { label: "This computer", machine: "laptop" };
  return {
    ...local,
    description: input.primaryEnvironment
      ? `Browser runs on this computer (${local.label})`
      : "Browser runs on this computer",
  };
}
