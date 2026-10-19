import {
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Bot, Square, SquareTerminal, TerminalSquare, X } from "lucide-react";
import { useMemo, useState } from "react";

import { confirmTerminalClose } from "~/lib/terminalCloseConfirm";
import { type TerminalContextSelection } from "~/lib/terminalContext";
import { cn } from "~/lib/utils";
import { readEnvironmentScope, useEnvironmentScope } from "../state/session";
import { terminalEnvironment } from "../state/terminal";
import { useKnownTerminalSessions } from "../state/terminalSessions";
import { useAtomCommand } from "../state/use-atom-command";
import {
  agentTerminalCounts,
  agentTerminalEntries,
  isAgentTerminalRunning,
  splitAroundSelected,
  terminalRunState,
  terminalRunStateLabel,
  terminalRunStateTone,
  type AgentTerminalEntry,
  type AgentTerminalOwner,
  type TerminalRunTone,
} from "./AgentTerminalsPanel.logic";
import { TerminalViewport } from "./TerminalViewport";
import { Button } from "./ui/button";
import { MiddleTruncate } from "./ui/middle-truncate";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const OWNER_LABEL: Record<AgentTerminalOwner, string> = {
  agent: "Agent command",
  shell: "Shell",
};

const TONE_TEXT: Record<TerminalRunTone, string> = {
  live: "text-success",
  success: "text-muted-foreground",
  muted: "text-muted-foreground",
  danger: "text-destructive-foreground",
};

const TONE_DOT: Record<TerminalRunTone, string> = {
  live: "bg-success",
  success: "bg-muted-foreground/50",
  muted: "bg-muted-foreground/30",
  danger: "bg-destructive-foreground",
};

function OwnerIcon({ owner }: { owner: AgentTerminalOwner }) {
  const Icon = owner === "agent" ? Bot : SquareTerminal;
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className="inline-flex shrink-0 text-muted-foreground" />}
        aria-label={OWNER_LABEL[owner]}
      >
        <Icon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="left">{OWNER_LABEL[owner]}</TooltipPopup>
    </Tooltip>
  );
}

/** A static dot and label for how the session stands; never animated. */
function RunStatus({ entry }: { entry: AgentTerminalEntry }) {
  const state = terminalRunState(entry);
  const tone = terminalRunStateTone(state);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 text-3xs tabular-nums",
        TONE_TEXT[tone],
      )}
    >
      <span aria-hidden className={cn("size-1.5 rounded-full", TONE_DOT[tone])} />
      {terminalRunStateLabel(state)}
    </span>
  );
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

interface SessionActions {
  readonly canOperate: boolean;
  readonly onSelect: (entry: AgentTerminalEntry) => void;
  readonly onStop: (entry: AgentTerminalEntry) => void;
  readonly onClose: (entry: AgentTerminalEntry) => void;
}

function SessionRowActions({
  entry,
  actions,
}: {
  entry: AgentTerminalEntry;
  actions: SessionActions;
}) {
  if (!actions.canOperate) return null;
  if (entry.isAgent) {
    return isAgentTerminalRunning(entry) ? (
      <RowAction label="Stop command" onClick={() => actions.onStop(entry)}>
        <Square className="size-3 fill-current" />
      </RowAction>
    ) : null;
  }
  return (
    <RowAction label="Close shell" onClick={() => actions.onClose(entry)}>
      <X className="size-3" />
    </RowAction>
  );
}

/** A collapsed session: one line with its owner, command, and status. */
function SessionRow({ entry, actions }: { entry: AgentTerminalEntry; actions: SessionActions }) {
  const live = terminalRunStateTone(terminalRunState(entry)) === "live";
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        data-agent-terminal-id={entry.terminalId}
        data-agent-terminal-status={terminalRunState(entry).kind}
        onClick={() => actions.onSelect(entry)}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            actions.onSelect(entry);
          }
        }}
        className="group mx-1 flex h-7 cursor-pointer items-center gap-2 rounded-md px-2 text-xs outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <OwnerIcon owner={entry.owner} />
        <span className={cn("min-w-0 flex-1 truncate font-mono", !live && "text-muted-foreground")}>
          {entry.label}
        </span>
        <RunStatus entry={entry} />
        <SessionRowActions entry={entry} actions={actions} />
      </div>
    </li>
  );
}

function SessionList({
  entries,
  actions,
  className,
}: {
  entries: ReadonlyArray<AgentTerminalEntry>;
  actions: SessionActions;
  className: string;
}) {
  if (entries.length === 0) return null;
  return (
    <ul
      aria-label="Other terminal sessions"
      className={cn("shrink-0 overflow-y-auto py-1", className)}
    >
      {entries.map((entry) => (
        <SessionRow key={entry.terminalId} entry={entry} actions={actions} />
      ))}
    </ul>
  );
}

function sessionCountsLabel(counts: ReturnType<typeof agentTerminalCounts>): string {
  const parts = [`${counts.total} ${counts.total === 1 ? "session" : "sessions"}`];
  if (counts.running > 0) parts.push(`${counts.running} running`);
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);
  return parts.join(" · ");
}

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
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly onSelectTerminal: (terminalId: string) => void;
  readonly onAddTerminalContext: (selection: TerminalContextSelection) => void;
}

/**
 * The right panel's Terminal surface: every terminal in this thread, newest
 * first. The selected session expands in place, so its header and live output
 * sit directly under its own row; the others stay as one-line rows above and
 * below it. It never starts a shell of its own.
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
  const canRead = useEnvironmentScope(environmentId, AuthTerminalReadScope);
  const sessions = useKnownTerminalSessions({ environmentId, threadId: threadRef.threadId });
  const entries = useMemo(() => agentTerminalEntries(sessions ?? []), [sessions]);
  const { before, selected: active, after } = splitAroundSelected(entries, activeTerminalId);
  const counts = agentTerminalCounts(entries);
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

  const actions: SessionActions = {
    canOperate,
    onSelect: selectEntry,
    onStop: stopEntry,
    onClose: closeEntry,
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

  if (!active) {
    return (
      <PanelMessage
        title="No terminals yet"
        detail="Commands the agent runs and shells opened in this thread show up here live."
      />
    );
  }

  const activeState = terminalRunState(active);
  const activeLocation = active.worktreePath ?? active.cwd;

  return (
    <div
      data-agent-terminals
      data-terminal-owner="right-panel"
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background"
    >
      <div className="flex h-8 shrink-0 items-center border-b border-border/70 px-3 text-3xs text-muted-foreground tabular-nums">
        {sessionCountsLabel(counts)}
      </div>
      <SessionList
        entries={before}
        actions={actions}
        className="max-h-[30%] border-b border-border/70"
      />
      <section
        aria-label={`${OWNER_LABEL[active.owner]}: ${active.label}`}
        data-agent-terminal-id={active.terminalId}
        data-agent-terminal-status={activeState.kind}
        aria-current="true"
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="flex shrink-0 flex-col gap-0.5 bg-accent/60 px-3 py-1.5">
          <div className="flex min-w-0 items-center gap-2">
            <OwnerIcon owner={active.owner} />
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
              {active.label}
            </span>
            <SessionRowActions entry={active} actions={actions} />
          </div>
          <div className="flex min-w-0 items-center gap-2 text-3xs text-muted-foreground">
            <RunStatus entry={active} />
            <span aria-hidden>·</span>
            <span className="shrink-0">{OWNER_LABEL[active.owner]}</span>
            <span aria-hidden>·</span>
            <span className="flex min-w-0 font-mono">
              <MiddleTruncate value={activeLocation} />
            </span>
          </div>
        </div>
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
      </section>
      <SessionList
        entries={after}
        actions={actions}
        className="max-h-[38%] border-t border-border/70"
      />
    </div>
  );
}
