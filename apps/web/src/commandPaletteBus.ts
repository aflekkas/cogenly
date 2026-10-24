import type {
  EnvironmentId,
  ProjectLabelId,
  PullRequestLinkedThreadsResult,
  ScopedThreadRef,
} from "@cogenly/contracts";

export interface CommandPaletteLinkedThreads {
  readonly environmentId: EnvironmentId;
  readonly threads: PullRequestLinkedThreadsResult["threads"];
}

// Tiny event bus allowing components to programmatically open the command palette
// without owning its React state.
const COMMAND_PALETTE_OPEN_EVENT = "cogenly:open-command-palette";

/** The project (folder) an Add repository flow files its new repository in. */
export interface CommandPaletteAddProjectTarget {
  readonly environmentId: EnvironmentId;
  readonly labelId: ProjectLabelId;
}

export interface CommandPaletteOpenDetail {
  readonly open?: "add-project" | "new-thread-in" | "start-work" | "snooze";
  /**
   * With `open: "add-project"`: add the repository into this project. Clones
   * land in the project's folder under the projects root; new and local
   * repositories are filed in it.
   */
  readonly into?: CommandPaletteAddProjectTarget;
  /** With `open: "start-work"`: the chat that hands off. With `open: "snooze"`: the thread to snooze. */
  readonly threadRef?: ScopedThreadRef;
  readonly query?: string;
  readonly linkedThreads?: CommandPaletteLinkedThreads;
}

export function openCommandPalette(detail?: CommandPaletteOpenDetail): void {
  window.dispatchEvent(
    new CustomEvent(COMMAND_PALETTE_OPEN_EVENT, detail ? { detail } : undefined),
  );
}

export function onOpenCommandPalette(
  listener: (detail: CommandPaletteOpenDetail) => void,
): () => void {
  const handler = (event: Event) => {
    listener((event as CustomEvent<CommandPaletteOpenDetail>).detail ?? {});
  };
  window.addEventListener(COMMAND_PALETTE_OPEN_EVENT, handler);
  return () => window.removeEventListener(COMMAND_PALETTE_OPEN_EVENT, handler);
}

/** Read at event time so consumers do not subscribe to transient dialog state. */
export function isCommandPaletteOpen(): boolean {
  return (
    typeof document !== "undefined" && document.querySelector("[data-command-palette]") !== null
  );
}
