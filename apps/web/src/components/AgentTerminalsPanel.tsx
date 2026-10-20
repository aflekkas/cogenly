import {
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { ListCollapse, ListTree, TerminalSquare } from "lucide-react";
import { useMemo, useState } from "react";

import { type TerminalContextSelection } from "~/lib/terminalContext";
import { readEnvironmentScope, useEnvironmentScope } from "../state/session";
import { terminalEnvironment } from "../state/terminal";
import { useKnownTerminalSessions } from "../state/terminalSessions";
import { useAtomCommand } from "../state/use-atom-command";
import {
  agentTerminalEntries,
  resolveSelected,
  terminalSections,
  type AgentTerminalEntry,
} from "./AgentTerminalsPanel.logic";
import { AgentRunsView } from "./terminals/AgentRunsView";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

function PanelMessage({ title, detail }: { title: string; detail?: string }) {
  return (
    <div
      data-agent-terminals
      className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-1 px-6 text-center"
    >
      <TerminalSquare className="size-5 text-muted-foreground/70" />
      <p className="text-sm text-foreground">{title}</p>
      {detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
    </div>
  );
}

export interface AgentTerminalsPanelProps {
  readonly threadRef: ScopedThreadRef;
  readonly visible: boolean;
  /** Bumped when the user asks for the terminal, so keyboard focus may move into it. */
  readonly focusRequestId: number;
  readonly activeTerminalId: string | undefined;
  readonly onSelectTerminal: (terminalId: string) => void;
  readonly onAddTerminalContext: (selection: TerminalContextSelection) => void;
}

/**
 * The right panel's Terminal surface: the commands the agent ran in this
 * thread, and nothing else. Users do not get a shell of their own here; an
 * agent starting a command never moves keyboard focus out of the composer.
 */
export function AgentTerminalsPanel({
  threadRef,
  visible,
  focusRequestId,
  activeTerminalId,
  onSelectTerminal,
  onAddTerminalContext,
}: AgentTerminalsPanelProps) {
  const environmentId = threadRef.environmentId;
  const canOperate = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const canRead = useEnvironmentScope(environmentId, AuthTerminalReadScope);
  const sessions = useKnownTerminalSessions({ environmentId, threadId: threadRef.threadId });
  const entries = useMemo(() => agentTerminalEntries(sessions ?? []), [sessions]);
  const { runs, liveRunCount } = useMemo(() => terminalSections(entries), [entries]);
  const killTerminal = useAtomCommand(terminalEnvironment.kill, "terminal kill");

  // The selection outlives the surface's active id: a run the user looked at
  // stays selected after the panel is reopened on no run in particular.
  const [lastRunId, setLastRunId] = useState<string | null>(null);
  const [listCollapsed, setListCollapsed] = useState(false);
  const [seenActiveTerminalId, setSeenActiveTerminalId] = useState(activeTerminalId);
  if (activeTerminalId !== seenActiveTerminalId) {
    setSeenActiveTerminalId(activeTerminalId);
    if (activeTerminalId !== undefined) setLastRunId(activeTerminalId);
  }
  const selectedRun = resolveSelected(runs, activeTerminalId ?? lastRunId);

  // Only a user request may move keyboard focus; an agent starting a command
  // must not pull it out of the composer.
  const [focusTarget, setFocusTarget] = useState<{ terminalId: string; token: number } | null>(
    null,
  );
  const focusTerminal = (terminalId: string) =>
    setFocusTarget((current) => ({ terminalId, token: (current?.token ?? 0) + 1 }));
  const [seenFocusRequestId, setSeenFocusRequestId] = useState(focusRequestId);
  if (focusRequestId !== seenFocusRequestId) {
    setSeenFocusRequestId(focusRequestId);
    if (selectedRun) {
      setFocusTarget({ terminalId: selectedRun.terminalId, token: (focusTarget?.token ?? 0) + 1 });
    }
  }

  const stopRun = (entry: AgentTerminalEntry) => {
    if (!readEnvironmentScope(environmentId, AuthTerminalOperateScope)) return;
    void killTerminal({
      environmentId,
      input: { threadId: threadRef.threadId, terminalId: entry.terminalId },
    });
  };

  if (!canRead) {
    return (
      <PanelMessage
        title="Terminals unavailable"
        detail="This connection is not allowed to view terminals in this environment."
      />
    );
  }

  if (sessions === null) {
    return <PanelMessage title="Connecting to terminals…" />;
  }

  const listToggleLabel = listCollapsed ? "Show run list" : "Hide run list";

  return (
    <div
      data-agent-terminals
      data-terminal-owner="right-panel"
      className="@container/terminals flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background"
    >
      <div className="flex h-10 min-h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3 text-xs">
        <span className="font-medium text-foreground">Agent runs</span>
        {liveRunCount > 0 ? (
          <span
            role="img"
            aria-label={`${liveRunCount} running`}
            className="size-1.5 rounded-full bg-success"
          />
        ) : null}
        {runs.length > 0 ? (
          <span className="text-muted-foreground tabular-nums">{runs.length}</span>
        ) : null}
        {runs.length > 0 ? (
          <span className="ms-auto @min-[40rem]/terminals:hidden">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={listToggleLabel}
                    aria-pressed={!listCollapsed}
                    onClick={() => setListCollapsed((value) => !value)}
                  />
                }
              >
                {listCollapsed ? <ListTree /> : <ListCollapse />}
              </TooltipTrigger>
              <TooltipPopup side="bottom">{listToggleLabel}</TooltipPopup>
            </Tooltip>
          </span>
        ) : null}
      </div>
      <AgentRunsView
        threadRef={threadRef}
        runs={runs}
        liveRunCount={liveRunCount}
        selected={selectedRun}
        listCollapsed={listCollapsed}
        canOperate={canOperate}
        visible={visible}
        focusToken={focusTarget?.token ?? 0}
        autoFocus={focusTarget?.terminalId === selectedRun?.terminalId}
        onSelect={onSelectTerminal}
        onFocusOutput={() => {
          if (selectedRun) focusTerminal(selectedRun.terminalId);
        }}
        onStop={stopRun}
        onAddTerminalContext={onAddTerminalContext}
      />
    </div>
  );
}
