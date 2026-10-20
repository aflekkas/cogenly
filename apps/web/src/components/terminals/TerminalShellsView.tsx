import type { ScopedThreadRef } from "@t3tools/contracts";
import { getTerminalLabel } from "@t3tools/shared/terminalLabels";
import { Plus, SquareTerminal } from "lucide-react";
import { useRef, useState, type KeyboardEvent } from "react";

import { type TerminalContextSelection } from "~/lib/terminalContext";
import { cn } from "~/lib/utils";
import { shellNameKey, useTerminalShellNamesStore } from "../../terminalShellNamesStore";
import {
  terminalRunState,
  terminalRunStateLabel,
  type AgentTerminalEntry,
} from "../AgentTerminalsPanel.logic";
import { TerminalViewport } from "../TerminalViewport";
import { Button } from "../ui/button";
import { PanelTabCloseButton } from "../ui/panel-tab-close-button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { RunStateGlyph, runToneText, TerminalSectionEmpty } from "./terminalParts";

/** A shell tab: the user's name, else "Terminal N"; the server label when a command runs. */
export interface ShellTab {
  readonly terminalId: string;
  readonly name: string;
  /** The foreground command, when it differs from the name. */
  readonly activity: string | null;
  /** Null for a shell this client just asked for and the server has not listed yet. */
  readonly entry: AgentTerminalEntry | null;
}

export function shellTabs(
  threadRef: ScopedThreadRef,
  shells: ReadonlyArray<AgentTerminalEntry>,
  pendingShellId: string | null,
  names: Readonly<Record<string, string>>,
): ReadonlyArray<ShellTab> {
  const tabs = shells.map((entry): ShellTab => {
    const fallback = getTerminalLabel(entry.terminalId);
    const name = names[shellNameKey(threadRef, entry.terminalId)] ?? fallback;
    return {
      terminalId: entry.terminalId,
      name,
      activity: entry.label !== fallback && entry.label !== name ? entry.label : null,
      entry,
    };
  });
  if (pendingShellId !== null && !shells.some((entry) => entry.terminalId === pendingShellId)) {
    tabs.push({
      terminalId: pendingShellId,
      name: getTerminalLabel(pendingShellId),
      activity: null,
      entry: null,
    });
  }
  return tabs;
}

function ShellTabButton(props: {
  tab: ShellTab;
  selected: boolean;
  canOperate: boolean;
  onSelect: () => void;
  onRename: (name: string) => void;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState(false);
  // Enter or Escape unmounts the input, which can still deliver a blur; act once.
  const editDoneRef = useRef(false);
  const state = props.tab.entry ? terminalRunState(props.tab.entry) : { kind: "starting" as const };
  const startEdit = () => {
    editDoneRef.current = false;
    setEditing(true);
  };
  const finishEdit = (value: string | null) => {
    if (editDoneRef.current) return;
    editDoneRef.current = true;
    setEditing(false);
    if (value !== null) props.onRename(value);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "F2") {
      event.preventDefault();
      startEdit();
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      props.onSelect();
    }
  };
  return (
    <Tooltip>
      <TooltipTrigger
        delay={600}
        render={
          <div
            role="tab"
            tabIndex={props.selected ? 0 : -1}
            aria-selected={props.selected}
            data-terminal-shell-id={props.tab.terminalId}
            onClick={props.onSelect}
            onDoubleClick={startEdit}
            onKeyDown={onKeyDown}
            className={cn(
              "group/tab flex h-6 max-w-52 min-w-0 shrink-0 cursor-pointer items-center gap-1.5 rounded-md ps-1.5 pe-1 text-xs outline-none state-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              props.selected ? "state-selected text-foreground" : "text-muted-foreground",
            )}
          />
        }
      >
        {editing ? (
          <input
            autoFocus
            defaultValue={props.tab.name}
            aria-label="Shell name"
            maxLength={64}
            onClick={(event) => event.stopPropagation()}
            onFocus={(event) => event.currentTarget.select()}
            onBlur={(event) => finishEdit(event.currentTarget.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") finishEdit(event.currentTarget.value);
              if (event.key === "Escape") finishEdit(null);
            }}
            className="w-28 min-w-0 rounded border border-ring bg-transparent px-0.5 text-xs text-foreground outline-none"
          />
        ) : (
          <span className="min-w-0 truncate">{props.tab.name}</span>
        )}
        {props.tab.activity && !editing ? (
          <span className="min-w-0 truncate font-mono text-3xs text-muted-foreground/70">
            {props.tab.activity}
          </span>
        ) : null}
        {props.canOperate && props.tab.entry ? (
          <PanelTabCloseButton label={`Close ${props.tab.name}`} onClick={props.onClose}>
            <RunStateGlyph state={state} />
          </PanelTabCloseButton>
        ) : (
          <RunStateGlyph state={state} />
        )}
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {props.tab.activity ? `${props.tab.name} · ${props.tab.activity}` : props.tab.name}
        <span className="text-muted-foreground"> · Double-click or F2 to rename</span>
      </TooltipPopup>
    </Tooltip>
  );
}

export interface TerminalShellsViewProps {
  readonly threadRef: ScopedThreadRef;
  readonly tabs: ReadonlyArray<ShellTab>;
  readonly selected: ShellTab | null;
  readonly canOperate: boolean;
  /** Where a new shell starts; null when the thread has no workspace. */
  readonly shellCwd: string | null;
  readonly shellWorktreePath: string | null;
  readonly visible: boolean;
  readonly focusToken: number;
  readonly autoFocus: boolean;
  readonly onSelect: (terminalId: string) => void;
  readonly onCreate: () => void;
  readonly onClose: (tab: ShellTab) => void;
  readonly onAddTerminalContext: (selection: TerminalContextSelection) => void;
}

/** The user's own shells as tabs, with the selected one filling the panel. */
export function TerminalShellsView(props: TerminalShellsViewProps) {
  const rename = useTerminalShellNamesStore((state) => state.rename);
  const selected = props.selected;
  if (!selected) {
    const canCreate = props.canOperate && props.shellCwd !== null;
    return (
      <TerminalSectionEmpty
        icon={<SquareTerminal />}
        title="No shells open"
        detail={
          canCreate
            ? "Open a shell to run your own commands in this thread's workspace. Project scripts open here too."
            : props.canOperate
              ? "Shells need a repository. This thread has no workspace to open one in."
              : "This connection can view terminals but not open them."
        }
        action={
          canCreate ? (
            <Button size="xs" variant="outline" onClick={props.onCreate}>
              <Plus />
              New shell
            </Button>
          ) : null
        }
      />
    );
  }

  const cwd = selected.entry?.cwd ?? props.shellCwd;
  const exited = selected.entry ? terminalRunState(selected.entry) : null;
  const ended = exited && (exited.kind === "running" || exited.kind === "idle") ? null : exited;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        role="tablist"
        aria-label="Shells"
        className="flex h-8 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border/60 px-1.5 [scrollbar-width:none]"
      >
        {props.tabs.map((tab) => (
          <ShellTabButton
            key={tab.terminalId}
            tab={tab}
            selected={tab.terminalId === selected.terminalId}
            canOperate={props.canOperate}
            onSelect={() => props.onSelect(tab.terminalId)}
            onRename={(name) => rename(props.threadRef, tab.terminalId, name)}
            onClose={() => props.onClose(tab)}
          />
        ))}
      </div>
      <div role="tabpanel" className="min-h-0 flex-1 bg-(--terminal-background)">
        {cwd !== null ? (
          <TerminalViewport
            key={selected.terminalId}
            threadRef={props.threadRef}
            threadId={props.threadRef.threadId}
            terminalId={selected.terminalId}
            terminalLabel={selected.name}
            cwd={cwd}
            worktreePath={selected.entry?.worktreePath ?? props.shellWorktreePath}
            onAddTerminalContext={props.onAddTerminalContext}
            showExitMessage={false}
            focusRequestId={props.focusToken}
            autoFocus={props.autoFocus}
            visible={props.visible}
            resizeEpoch={0}
          />
        ) : null}
      </div>
      {ended && ended.kind !== "starting" ? (
        <div
          role="status"
          className="flex h-7 shrink-0 items-center gap-2 border-t border-border/60 px-3 text-3xs text-muted-foreground"
        >
          <RunStateGlyph state={ended} />
          <span className={cn("font-medium", runToneText(ended))}>
            {terminalRunStateLabel(ended)}
          </span>
          {props.canOperate ? (
            <Button
              size="micro"
              variant="ghost"
              className="ms-auto"
              onClick={() => props.onClose(selected)}
            >
              Close shell
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
