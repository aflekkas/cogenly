import {
  AuthTerminalOperateScope,
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { CircleCheck, CircleX, Square, TerminalSquare, X } from "lucide-react";
import { useMemo, useState } from "react";

import { confirmTerminalClose } from "~/lib/terminalCloseConfirm";
import { type TerminalContextSelection } from "~/lib/terminalContext";
import { cn } from "~/lib/utils";
import { readEnvironmentScope, useEnvironmentScope } from "../state/session";
import { terminalEnvironment } from "../state/terminal";
import { useKnownTerminalSessions } from "../state/terminalSessions";
import { useAtomCommand } from "../state/use-atom-command";
import {
  agentTerminalEntries,
  agentTerminalExitLabel,
  isAgentTerminalRunning,
  type AgentTerminalEntry,
} from "./AgentTerminalsPanel.logic";
import { TerminalViewport } from "./TerminalViewport";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

function EntryStatusIcon({ entry }: { entry: AgentTerminalEntry }) {
  if (isAgentTerminalRunning(entry)) {
    return (
      <span className="inline-flex shrink-0 text-success">
        <Spinner size="xs" aria-label="Running" />
      </span>
    );
  }
  if (entry.status === "exited" && entry.exitCode === 0) {
    return <CircleCheck className="size-3 shrink-0 text-muted-foreground" aria-label="Finished" />;
  }
  return <CircleX className="size-3 shrink-0 text-destructive-foreground" aria-label="Failed" />;
}

function RowAction(props: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={props.label}
            className="shrink-0"
            onClick={(event) => {
              event.stopPropagation();
              props.onClick();
            }}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="left">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

export interface AgentTerminalsPanelProps {
  readonly threadRef: ScopedThreadRef;
  readonly visible: boolean;
  /** Bumped when the user asks for the terminal, so keyboard focus may move into it. */
  readonly focusRequestId: number;
  readonly activeTerminalId: string | undefined;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly onSelectTerminal: (terminalId: string) => void;
  readonly onAddTerminalContext: (selection: TerminalContextSelection) => void;
}

/**
 * The right panel's Terminal surface: every shell command the agent ran in this
 * thread, newest first, with the selected one's live output below. It never
 * starts a shell of its own.
 */
export function AgentTerminalsPanel({
  threadRef,
  visible,
  focusRequestId,
  activeTerminalId,
  keybindings,
  onSelectTerminal,
  onAddTerminalContext,
}: AgentTerminalsPanelProps) {
  const environmentId = threadRef.environmentId;
  const canOperate = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const sessions = useKnownTerminalSessions({ environmentId, threadId: threadRef.threadId });
  const entries = useMemo(() => agentTerminalEntries(sessions ?? []), [sessions]);
  const active =
    entries.find((entry) => entry.terminalId === activeTerminalId) ?? entries[0] ?? null;
  const killTerminal = useAtomCommand(terminalEnvironment.kill, "terminal kill");
  const closeTerminal = useAtomCommand(terminalEnvironment.close, "terminal close");

  // Only a user request may move keyboard focus; an agent starting a command
  // must not pull it out of the composer.
  const [focusTarget, setFocusTarget] = useState<{ terminalId: string; token: number } | null>(
    null,
  );
  const [seenFocusRequestId, setSeenFocusRequestId] = useState(focusRequestId);
  if (focusRequestId !== seenFocusRequestId) {
    setSeenFocusRequestId(focusRequestId);
    if (active) {
      setFocusTarget({ terminalId: active.terminalId, token: (focusTarget?.token ?? 0) + 1 });
    }
  }

  const selectEntry = (entry: AgentTerminalEntry) => {
    onSelectTerminal(entry.terminalId);
    setFocusTarget((current) => ({
      terminalId: entry.terminalId,
      token: (current?.token ?? 0) + 1,
    }));
  };
  const stopEntry = (entry: AgentTerminalEntry) => {
    if (!readEnvironmentScope(environmentId, AuthTerminalOperateScope)) return;
    void killTerminal({
      environmentId,
      input: { threadId: threadRef.threadId, terminalId: entry.terminalId },
    });
  };
  const closeEntry = (entry: AgentTerminalEntry) => {
    void confirmTerminalClose([entry.label]).then((confirmed) => {
      if (!confirmed || !readEnvironmentScope(environmentId, AuthTerminalOperateScope)) return;
      void closeTerminal({
        environmentId,
        input: { threadId: threadRef.threadId, terminalId: entry.terminalId, deleteHistory: true },
      });
    });
  };

  if (!active) {
    return (
      <div
        data-agent-terminals
        className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-1 px-6 text-center"
      >
        <TerminalSquare className="size-5 text-muted-foreground/70" />
        <p className="text-sm text-foreground">No agent commands yet</p>
        <p className="text-xs text-muted-foreground">
          Shell commands the agent runs in this thread show up here live.
        </p>
      </div>
    );
  }

  return (
    <div
      data-agent-terminals
      data-terminal-owner="right-panel"
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background"
    >
      <ul
        aria-label="Agent commands"
        className="max-h-[38%] shrink-0 overflow-y-auto border-b border-border/70 py-1"
      >
        {entries.map((entry) => {
          const selected = entry.terminalId === active.terminalId;
          const running = isAgentTerminalRunning(entry);
          return (
            <li key={entry.terminalId}>
              <div
                role="button"
                tabIndex={0}
                aria-current={selected ? "true" : undefined}
                data-agent-terminal-id={entry.terminalId}
                data-agent-terminal-status={running ? "running" : "finished"}
                onClick={() => selectEntry(entry)}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return;
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    selectEntry(entry);
                  }
                }}
                className={cn(
                  "group mx-1 flex h-7 cursor-pointer items-center gap-2 rounded-md px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
                )}
              >
                <EntryStatusIcon entry={entry} />
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate font-mono",
                    !running && !selected && "text-muted-foreground",
                  )}
                >
                  {entry.label}
                </span>
                {running ? (
                  <span className="shrink-0 text-success text-3xs uppercase tracking-wide">
                    live
                  </span>
                ) : (
                  <span
                    className={cn(
                      "shrink-0 tabular-nums text-3xs",
                      entry.status === "exited" && entry.exitCode === 0
                        ? "text-muted-foreground"
                        : "text-destructive-foreground",
                    )}
                  >
                    {agentTerminalExitLabel(entry)}
                  </span>
                )}
                {canOperate && entry.isAgent && running ? (
                  <RowAction label="Stop command" onClick={() => stopEntry(entry)}>
                    <Square className="size-3 fill-current" />
                  </RowAction>
                ) : null}
                {canOperate && !entry.isAgent ? (
                  <RowAction label="Close terminal" onClick={() => closeEntry(entry)}>
                    <X className="size-3" />
                  </RowAction>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="min-h-0 flex-1 bg-(--terminal-background)">
        <TerminalViewport
          key={active.terminalId}
          threadRef={threadRef}
          threadId={threadRef.threadId}
          terminalId={active.terminalId}
          terminalLabel={active.label}
          cwd={active.cwd}
          worktreePath={active.worktreePath}
          onAddTerminalContext={onAddTerminalContext}
          focusRequestId={focusTarget?.token ?? 0}
          autoFocus={focusTarget?.terminalId === active.terminalId}
          visible={visible}
          resizeEpoch={0}
          keybindings={keybindings}
        />
      </div>
    </div>
  );
}
