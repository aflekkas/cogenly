import {
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { nextTerminalId } from "@t3tools/shared/terminalLabels";
import { ListCollapse, ListTree, Plus, TerminalSquare } from "lucide-react";
import { useMemo, useState } from "react";

import { confirmTerminalClose } from "~/lib/terminalCloseConfirm";
import { type TerminalContextSelection } from "~/lib/terminalContext";
import { readEnvironmentScope, useEnvironmentScope } from "../state/session";
import { terminalEnvironment } from "../state/terminal";
import { useKnownTerminalSessions } from "../state/terminalSessions";
import { useAtomCommand } from "../state/use-atom-command";
import { useTerminalShellNamesStore } from "../terminalShellNamesStore";
import {
  agentTerminalEntries,
  isAgentTerminalId,
  resolveSelected,
  terminalSections,
  type AgentTerminalEntry,
} from "./AgentTerminalsPanel.logic";
import { AgentRunsView } from "./terminals/AgentRunsView";
import { shellTabs, TerminalShellsView, type ShellTab } from "./terminals/TerminalShellsView";
import { Button } from "./ui/button";
import { Toggle, ToggleGroup } from "./ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

type TerminalSection = "runs" | "shells";

const sectionOf = (terminalId: string): TerminalSection =>
  isAgentTerminalId(terminalId) ? "runs" : "shells";

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

function HeaderAction(props: {
  label: string;
  onClick: () => void;
  pressed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={props.label}
            aria-pressed={props.pressed}
            onClick={props.onClick}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

function SectionCount({ count }: { count: number }) {
  return count > 0 ? <span className="text-muted-foreground/70 tabular-nums">{count}</span> : null;
}

export interface AgentTerminalsPanelProps {
  readonly threadRef: ScopedThreadRef;
  readonly visible: boolean;
  /** Bumped when the user asks for the terminal, so keyboard focus may move into it. */
  readonly focusRequestId: number;
  readonly activeTerminalId: string | undefined;
  /** Where a new shell starts; null when the thread has no workspace. */
  readonly shellCwd: string | null;
  readonly shellWorktreePath: string | null;
  readonly onSelectTerminal: (terminalId: string) => void;
  readonly onAddTerminalContext: (selection: TerminalContextSelection) => void;
}

/**
 * The right panel's Terminal surface, in two sections: **Agent runs**, the
 * commands the agent ran in this thread, and **Shells**, terminals the user
 * opened. Each section remembers its own selection; an agent starting a
 * command never moves keyboard focus or pulls the user out of a shell.
 */
export function AgentTerminalsPanel({
  threadRef,
  visible,
  focusRequestId,
  activeTerminalId,
  shellCwd,
  shellWorktreePath,
  onSelectTerminal,
  onAddTerminalContext,
}: AgentTerminalsPanelProps) {
  const environmentId = threadRef.environmentId;
  const canOperate = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const canRead = useEnvironmentScope(environmentId, AuthTerminalReadScope);
  const sessions = useKnownTerminalSessions({ environmentId, threadId: threadRef.threadId });
  const entries = useMemo(() => agentTerminalEntries(sessions ?? []), [sessions]);
  const { runs, liveRunCount, shells } = useMemo(() => terminalSections(entries), [entries]);
  const shellNames = useTerminalShellNamesStore((state) => state.names);
  const forgetShellName = useTerminalShellNamesStore((state) => state.forget);
  const killTerminal = useAtomCommand(terminalEnvironment.kill, "terminal kill");
  const closeTerminal = useAtomCommand(terminalEnvironment.close, "terminal close");

  // A shell this panel asked for, shown as a tab until the server lists it.
  const [pendingShellId, setPendingShellId] = useState<string | null>(null);
  if (pendingShellId !== null && shells.some((entry) => entry.terminalId === pendingShellId)) {
    setPendingShellId(null);
  }
  const tabs = shellTabs(threadRef, shells, pendingShellId, shellNames);

  const [section, setSection] = useState<TerminalSection>(() =>
    activeTerminalId !== undefined
      ? sectionOf(activeTerminalId)
      : runs.length === 0 && shells.length > 0
        ? "shells"
        : "runs",
  );
  const [lastRunId, setLastRunId] = useState<string | null>(null);
  const [lastShellId, setLastShellId] = useState<string | null>(null);
  const [listCollapsed, setListCollapsed] = useState(false);
  const [seenActiveTerminalId, setSeenActiveTerminalId] = useState(activeTerminalId);
  if (activeTerminalId !== seenActiveTerminalId) {
    setSeenActiveTerminalId(activeTerminalId);
    if (activeTerminalId !== undefined) {
      const owner = sectionOf(activeTerminalId);
      setSection(owner);
      if (owner === "runs") setLastRunId(activeTerminalId);
      else setLastShellId(activeTerminalId);
    }
  }

  const activeIsRun = activeTerminalId !== undefined && isAgentTerminalId(activeTerminalId);
  const selectedRun = resolveSelected(runs, activeIsRun ? activeTerminalId : lastRunId);
  const selectedShell = resolveSelected(
    tabs,
    activeTerminalId !== undefined && !activeIsRun ? activeTerminalId : lastShellId,
  );
  const selectedTerminalId =
    section === "runs" ? (selectedRun?.terminalId ?? null) : (selectedShell?.terminalId ?? null);

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
    if (selectedTerminalId !== null) {
      setFocusTarget({ terminalId: selectedTerminalId, token: (focusTarget?.token ?? 0) + 1 });
    }
  }

  const switchSection = (next: TerminalSection) => {
    setSection(next);
    const target = next === "runs" ? selectedRun : selectedShell;
    if (target) onSelectTerminal(target.terminalId);
  };
  const createShell = () => {
    if (shellCwd === null || !readEnvironmentScope(environmentId, AuthTerminalOperateScope)) return;
    const terminalId = nextTerminalId([
      ...entries.map((entry) => entry.terminalId),
      ...(pendingShellId ? [pendingShellId] : []),
    ]);
    setPendingShellId(terminalId);
    setSection("shells");
    onSelectTerminal(terminalId);
    focusTerminal(terminalId);
  };
  const stopRun = (entry: AgentTerminalEntry) => {
    if (!readEnvironmentScope(environmentId, AuthTerminalOperateScope)) return;
    void killTerminal({
      environmentId,
      input: { threadId: threadRef.threadId, terminalId: entry.terminalId },
    });
  };
  const closeShell = (tab: ShellTab) => {
    const index = tabs.findIndex((candidate) => candidate.terminalId === tab.terminalId);
    const neighbour = tabs[index + 1] ?? tabs[index - 1] ?? null;
    const afterClose = () => {
      forgetShellName(threadRef, tab.terminalId);
      if (pendingShellId === tab.terminalId) setPendingShellId(null);
      if (selectedShell?.terminalId === tab.terminalId && neighbour) {
        onSelectTerminal(neighbour.terminalId);
      }
    };
    if (!tab.entry) {
      afterClose();
      return;
    }
    void confirmTerminalClose([tab.name]).then((confirmed) => {
      if (!confirmed || !readEnvironmentScope(environmentId, AuthTerminalOperateScope)) return;
      afterClose();
      void closeTerminal({
        environmentId,
        input: { threadId: threadRef.threadId, terminalId: tab.terminalId, deleteHistory: true },
      });
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

  const canCreateShell = canOperate && shellCwd !== null;

  return (
    <div
      data-agent-terminals
      data-terminal-owner="right-panel"
      className="@container/terminals flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background"
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-2">
        <ToggleGroup
          aria-label="Terminal sections"
          value={[section]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "runs" || next === "shells") switchSection(next);
          }}
        >
          <Toggle value="runs">
            Agent runs
            {liveRunCount > 0 ? (
              <span
                role="img"
                aria-label={`${liveRunCount} running`}
                className="size-1.5 rounded-full bg-success"
              />
            ) : null}
            <SectionCount count={runs.length} />
          </Toggle>
          <Toggle value="shells">
            Shells
            <SectionCount count={shells.length} />
          </Toggle>
        </ToggleGroup>
        <div className="ms-auto flex items-center gap-0.5">
          {section === "runs" && runs.length > 0 ? (
            <span className="@min-[40rem]/terminals:hidden">
              <HeaderAction
                label={listCollapsed ? "Show run list" : "Hide run list"}
                pressed={!listCollapsed}
                onClick={() => setListCollapsed((value) => !value)}
              >
                {listCollapsed ? <ListTree /> : <ListCollapse />}
              </HeaderAction>
            </span>
          ) : null}
          {canCreateShell ? (
            <HeaderAction label="New shell" onClick={createShell}>
              <Plus />
            </HeaderAction>
          ) : null}
        </div>
      </div>
      {section === "runs" ? (
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
      ) : (
        <TerminalShellsView
          threadRef={threadRef}
          tabs={tabs}
          selected={selectedShell}
          canOperate={canOperate}
          shellCwd={shellCwd}
          shellWorktreePath={shellWorktreePath}
          visible={visible}
          focusToken={focusTarget?.token ?? 0}
          autoFocus={focusTarget?.terminalId === selectedShell?.terminalId}
          onSelect={(terminalId) => {
            onSelectTerminal(terminalId);
            focusTerminal(terminalId);
          }}
          onCreate={createShell}
          onClose={closeShell}
          onAddTerminalContext={onAddTerminalContext}
        />
      )}
    </div>
  );
}
