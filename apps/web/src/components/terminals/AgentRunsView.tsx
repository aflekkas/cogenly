import type { ScopedThreadRef } from "@t3tools/contracts";
import { Bot, Check, Copy, ExternalLink, Square } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { type TerminalContextSelection } from "~/lib/terminalContext";
import { cn } from "~/lib/utils";
import {
  adjacentTerminalId,
  commandTitle,
  formatRunDuration,
  isAgentTerminalRunning,
  runDurationMs,
  terminalRunState,
  terminalRunStateLabel,
  terminalSignalName,
  type AgentTerminalEntry,
} from "../AgentTerminalsPanel.logic";
import { TerminalViewport } from "../TerminalViewport";
import { Button } from "../ui/button";
import { MiddleTruncate } from "../ui/middle-truncate";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  formatRunTimestamp,
  RunStateGlyph,
  runToneText,
  TerminalSectionEmpty,
  useDetectedRunUrl,
  useOpenRunUrl,
} from "./terminalParts";

function IconAction(props: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-micro"
            variant="ghost"
            aria-label={props.label}
            onClick={(event) => {
              event.stopPropagation();
              props.onClick();
            }}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

function OpenUrlButton({ threadRef, url }: { threadRef: ScopedThreadRef; url: string }) {
  const openUrl = useOpenRunUrl(threadRef);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="micro"
            variant="ghost"
            onClick={(event) => {
              event.stopPropagation();
              openUrl(url, event.metaKey || event.ctrlKey);
            }}
          />
        }
      >
        <ExternalLink />
        Open
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {url.replace(/^https?:\/\//, "")}
        <span className="text-muted-foreground"> · ⌘-click for system browser</span>
      </TooltipPopup>
    </Tooltip>
  );
}

/** Open (once the run prints a local address) and Stop, for a live run only. */
function LiveRunActions(props: {
  threadRef: ScopedThreadRef;
  entry: AgentTerminalEntry;
  canOperate: boolean;
  onStop: (entry: AgentTerminalEntry) => void;
}) {
  const url = useDetectedRunUrl(props.threadRef, props.entry.terminalId, true);
  return (
    <>
      {url ? <OpenUrlButton threadRef={props.threadRef} url={url} /> : null}
      {props.canOperate ? (
        <IconAction label="Stop" onClick={() => props.onStop(props.entry)}>
          <Square className="size-2.5 fill-current" />
        </IconAction>
      ) : null}
    </>
  );
}

/** What a row shows at its trailing edge: live, the exit code, or how long it took. */
function RunRowMeta({ entry }: { entry: AgentTerminalEntry }) {
  const state = terminalRunState(entry);
  if (state.kind === "running" || state.kind === "starting") {
    return <span className="shrink-0 text-3xs font-medium tracking-wider text-success">LIVE</span>;
  }
  if (state.kind === "failed") {
    return (
      <span className="shrink-0 font-mono text-3xs text-destructive-foreground tabular-nums">
        exit {state.exitCode}
      </span>
    );
  }
  if (state.kind === "killed") {
    return (
      <span className="shrink-0 font-mono text-3xs text-muted-foreground">
        {terminalSignalName(state.signal)}
      </span>
    );
  }
  if (state.kind === "error") {
    return <span className="shrink-0 text-3xs text-destructive-foreground">failed</span>;
  }
  const duration = runDurationMs(entry);
  return duration === null ? null : (
    <span className="shrink-0 text-3xs text-muted-foreground/80 tabular-nums">
      {formatRunDuration(duration)}
    </span>
  );
}

interface RunRowProps {
  readonly threadRef: ScopedThreadRef;
  readonly entry: AgentTerminalEntry;
  readonly selected: boolean;
  readonly canOperate: boolean;
  readonly onSelect: (terminalId: string) => void;
  readonly onOpenOutput: () => void;
  readonly onStop: (entry: AgentTerminalEntry) => void;
}

function RunRow({
  threadRef,
  entry,
  selected,
  canOperate,
  onSelect,
  onOpenOutput,
  onStop,
}: RunRowProps) {
  const state = terminalRunState(entry);
  const live = isAgentTerminalRunning(entry);
  return (
    <Tooltip>
      <TooltipTrigger
        delay={600}
        render={
          <div
            id={runOptionId(entry.terminalId)}
            role="option"
            aria-selected={selected}
            data-agent-terminal-id={entry.terminalId}
            data-agent-terminal-status={state.kind}
            onClick={() => onSelect(entry.terminalId)}
            onDoubleClick={onOpenOutput}
            className={cn(
              "group mx-1 flex h-7 cursor-pointer items-center gap-2 rounded-md px-2 text-xs [contain-intrinsic-size:auto_1.75rem] [content-visibility:auto] state-hover",
              selected && "state-selected",
            )}
          />
        }
      >
        <RunStateGlyph state={state} />
        <span
          className={cn(
            "min-w-0 flex-1 truncate font-mono",
            selected || live ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {commandTitle(entry.label)}
        </span>
        {live ? (
          <LiveRunActions
            threadRef={threadRef}
            entry={entry}
            canOperate={canOperate}
            onStop={onStop}
          />
        ) : null}
        <RunRowMeta entry={entry} />
      </TooltipTrigger>
      <TooltipPopup side="right" align="start" variant="code">
        {entry.label}
      </TooltipPopup>
    </Tooltip>
  );
}

const runOptionId = (terminalId: string) => `agent-run-${terminalId}`;

function GroupLabel({ children }: { children: string }) {
  return (
    <div
      role="presentation"
      className="px-3 pt-2 pb-1 text-3xs font-medium tracking-wider text-muted-foreground/60 uppercase"
    >
      {children}
    </div>
  );
}

/** The quiet line under a run's output: how it ended and when. */
function RunStatusFooter({ entry }: { entry: AgentTerminalEntry }) {
  const state = terminalRunState(entry);
  const started = formatRunTimestamp(entry.startedAt);
  const duration = runDurationMs(entry);
  const live = isAgentTerminalRunning(entry);
  const ended = live ? null : formatRunTimestamp(entry.updatedAt);
  return (
    <div
      role="status"
      className="flex h-7 shrink-0 items-center gap-2 border-t border-border/60 px-3 text-3xs text-muted-foreground tabular-nums"
    >
      <RunStateGlyph state={state} />
      <span className={cn("font-medium", runToneText(state))}>
        {live ? "Running" : terminalRunStateLabel(state)}
      </span>
      {duration !== null ? <span>after {formatRunDuration(duration)}</span> : null}
      <span className="ms-auto flex min-w-0 items-center gap-2 truncate">
        {started ? <span>Started {started}</span> : null}
        {ended ? <span aria-hidden>·</span> : null}
        {ended ? <span>Ended {ended}</span> : null}
      </span>
    </div>
  );
}

function RunCommandHeader({
  threadRef,
  entry,
  canOperate,
  onStop,
}: {
  threadRef: ScopedThreadRef;
  entry: AgentTerminalEntry;
  canOperate: boolean;
  onStop: (entry: AgentTerminalEntry) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const live = isAgentTerminalRunning(entry);
  const location = entry.worktreePath ?? entry.cwd;
  const long = entry.label.length > 72;
  return (
    <div className="flex shrink-0 flex-col gap-1 border-b border-border/60 px-3 py-2">
      <div className="flex min-w-0 items-start gap-2">
        <code
          className={cn(
            "min-w-0 flex-1 font-mono text-xs leading-5 whitespace-pre-wrap break-all text-foreground select-text",
            !expanded && "line-clamp-2",
          )}
        >
          <span aria-hidden className="text-muted-foreground/60 select-none">
            ${" "}
          </span>
          {entry.label}
        </code>
        <div className="flex shrink-0 items-center gap-0.5">
          {live ? (
            <LiveRunActions
              threadRef={threadRef}
              entry={entry}
              canOperate={canOperate}
              onStop={onStop}
            />
          ) : null}
          <IconAction
            label={isCopied ? "Copied" : "Copy command"}
            onClick={() => copyToClipboard(entry.label, undefined)}
          >
            {isCopied ? <Check /> : <Copy />}
          </IconAction>
        </div>
      </div>
      <div className="flex min-w-0 items-center gap-2 text-3xs text-muted-foreground">
        <span className="flex min-w-0 font-mono">
          <MiddleTruncate value={location} />
        </span>
        {long ? (
          <Button
            size="micro"
            variant="link"
            className="ms-auto shrink-0"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "Show less" : "Show full command"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export interface AgentRunsViewProps {
  readonly threadRef: ScopedThreadRef;
  readonly runs: ReadonlyArray<AgentTerminalEntry>;
  readonly liveRunCount: number;
  readonly selected: AgentTerminalEntry | null;
  readonly canOperate: boolean;
  readonly visible: boolean;
  readonly focusToken: number;
  readonly autoFocus: boolean;
  readonly onSelect: (terminalId: string) => void;
  readonly onFocusOutput: () => void;
  readonly onStop: (entry: AgentTerminalEntry) => void;
  readonly onAddTerminalContext: (selection: TerminalContextSelection) => void;
}

/**
 * Master–detail for the agent's commands: a run list (live ones pinned on top)
 * beside, or above in a narrow panel, the selected run's command, output and
 * exit status. Arrows move through runs, Enter focuses the output, Esc returns.
 */
export function AgentRunsView(props: AgentRunsViewProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const selectedId = props.selected?.terminalId ?? null;

  useEffect(() => {
    if (selectedId === null) return;
    listRef.current
      ?.querySelector(`#${CSS.escape(runOptionId(selectedId))}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  if (!props.selected) {
    return (
      <TerminalSectionEmpty
        icon={<Bot />}
        title="No agent runs yet"
        detail="Commands the agent runs in this thread show up here, with their live output and how they exited."
      />
    );
  }

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowUp"
          ? -1
          : event.key === "End"
            ? props.runs.length
            : event.key === "Home"
              ? -props.runs.length
              : 0;
    if (step !== 0) {
      event.preventDefault();
      const next = adjacentTerminalId(props.runs, selectedId, step);
      if (next !== null && next !== selectedId) props.onSelect(next);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      props.onFocusOutput();
    }
  };

  // Esc leaves an agent's output for the list; the agent owns that process, not the user.
  const onOutputKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    event.stopPropagation();
    listRef.current?.focus();
  };

  const live = props.runs.slice(0, props.liveRunCount);
  const finished = props.runs.slice(props.liveRunCount);
  const rowProps = {
    threadRef: props.threadRef,
    canOperate: props.canOperate,
    onSelect: props.onSelect,
    onOpenOutput: props.onFocusOutput,
    onStop: props.onStop,
  };
  const selected = props.selected;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col @min-[40rem]/terminals:flex-row">
      <div
        ref={listRef}
        role="listbox"
        tabIndex={0}
        aria-label="Agent runs"
        aria-activedescendant={runOptionId(selected.terminalId)}
        onKeyDown={onListKeyDown}
        className={cn(
          "min-h-0 shrink-0 overflow-y-auto overscroll-contain pb-1 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          "max-h-[38%] border-b border-border/60",
          "@min-[40rem]/terminals:flex! @min-[40rem]/terminals:max-h-none @min-[40rem]/terminals:w-60 @min-[40rem]/terminals:border-e @min-[40rem]/terminals:border-b-0",
          "flex flex-col",
        )}
      >
        {live.length > 0 ? <GroupLabel>Running</GroupLabel> : null}
        {live.map((entry) => (
          <RunRow
            key={entry.terminalId}
            entry={entry}
            selected={entry.terminalId === selected.terminalId}
            {...rowProps}
          />
        ))}
        {live.length > 0 && finished.length > 0 ? <GroupLabel>Finished</GroupLabel> : null}
        {live.length === 0 ? <div className="h-1 shrink-0" /> : null}
        {finished.map((entry) => (
          <RunRow
            key={entry.terminalId}
            entry={entry}
            selected={entry.terminalId === selected.terminalId}
            {...rowProps}
          />
        ))}
      </div>
      <section
        aria-label={`Agent run: ${selected.label}`}
        data-agent-terminal-id={selected.terminalId}
        data-agent-terminal-status={terminalRunState(selected).kind}
        className="flex min-h-0 min-w-0 flex-1 flex-col"
      >
        <RunCommandHeader
          key={selected.terminalId}
          threadRef={props.threadRef}
          entry={selected}
          canOperate={props.canOperate}
          onStop={props.onStop}
        />
        <div
          className="min-h-0 flex-1 bg-(--terminal-background)"
          onKeyDownCapture={onOutputKeyDownCapture}
        >
          <TerminalViewport
            key={selected.terminalId}
            threadRef={props.threadRef}
            threadId={props.threadRef.threadId}
            terminalId={selected.terminalId}
            terminalLabel={selected.label}
            cwd={selected.cwd}
            worktreePath={selected.worktreePath}
            onAddTerminalContext={props.onAddTerminalContext}
            showExitMessage={false}
            focusRequestId={props.focusToken}
            autoFocus={props.autoFocus}
            visible={props.visible}
            resizeEpoch={0}
          />
        </div>
        <RunStatusFooter entry={selected} />
      </section>
    </div>
  );
}
