import type { ScopedThreadRef } from "@t3tools/contracts";
import { Bot, ExternalLink, Square, SquareTerminal } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { CopyButton } from "~/components/ui/copy-button";
import { type TerminalContextSelection } from "~/lib/terminalContext";
import { cn } from "~/lib/utils";
import {
  adjacentTerminalId,
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
import { runListTitle, shortenHomePath } from "./bottomPanel.logic";

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

/** How a finished row ended: its exit code, signal, or how long it took. Live rows show their stop. */
function RunRowMeta({ entry }: { entry: AgentTerminalEntry }) {
  const state = terminalRunState(entry);
  const base = "w-10 shrink-0 text-right text-3xs tabular-nums";
  if (state.kind === "running" || state.kind === "starting") return null;
  if (state.kind === "failed") {
    return (
      <span className={cn(base, "font-mono text-destructive-foreground")}>
        exit {state.exitCode}
      </span>
    );
  }
  if (state.kind === "killed") {
    return (
      <span className={cn(base, "font-mono text-muted-foreground")}>
        {terminalSignalName(state.signal)}
      </span>
    );
  }
  if (state.kind === "error") {
    return <span className={cn(base, "text-destructive-foreground")}>failed</span>;
  }
  const duration = runDurationMs(entry);
  return duration === null ? null : (
    <span className={cn(base, "text-muted-foreground/70")}>{formatRunDuration(duration)}</span>
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
              "group mx-1 flex h-7 cursor-pointer items-center gap-2 rounded-md ps-2 pe-1.5 text-xs [contain-intrinsic-size:auto_1.75rem] [content-visibility:auto] state-hover",
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
          {runListTitle(entry.label)}
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
      className="flex h-7 shrink-0 items-end px-3 pb-1 text-3xs text-muted-foreground/55 @max-[40rem]/terminals:pe-9"
    >
      {children}
    </div>
  );
}

/** `Running · started 12:09 PM`, or how it ended, how long it took and when. */
function RunStatusLine({ entry }: { entry: AgentTerminalEntry }) {
  const state = terminalRunState(entry);
  const live = isAgentTerminalRunning(entry);
  const started = formatRunTimestamp(entry.startedAt);
  const ended = live ? null : formatRunTimestamp(entry.updatedAt);
  const duration = live ? null : runDurationMs(entry);
  const parts = [
    live
      ? started
        ? `started ${started}`
        : null
      : duration !== null
        ? formatRunDuration(duration)
        : null,
    ended ? `ended ${ended}` : null,
  ].filter((part) => part !== null);
  return (
    <span
      role="status"
      key={state.kind}
      className="swap-motion flex shrink-0 items-center gap-1.5 tabular-nums"
    >
      <span className={cn("font-medium", runToneText(state))}>
        {live ? "Running" : terminalRunStateLabel(state)}
      </span>
      {parts.map((part) => (
        <span key={part} className="flex items-center gap-1.5">
          <span aria-hidden className="text-muted-foreground/50">
            ·
          </span>
          {part}
        </span>
      ))}
    </span>
  );
}

/**
 * The selected run's command on one line (click to see all of it), its
 * actions, and under it the folder it ran in and how it stands.
 */
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
  const live = isAgentTerminalRunning(entry);
  const location = shortenHomePath(entry.worktreePath ?? entry.cwd);
  const toggle = (element: HTMLElement) => {
    // Selecting part of the command is not a request to expand it.
    if (window.getSelection()?.toString()) return;
    if (!expanded && element.scrollWidth <= element.clientWidth) return;
    setExpanded((value) => !value);
  };
  return (
    <div className="flex shrink-0 flex-col gap-0.5 border-b border-border/50 px-3 pt-1.5 pb-2 @min-[40rem]/terminals:pe-9">
      <div className="flex min-w-0 items-start gap-2">
        <code
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          onClick={(event) => toggle(event.currentTarget)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            toggle(event.currentTarget);
          }}
          className={cn(
            "min-w-0 flex-1 cursor-pointer rounded-sm font-mono text-xs leading-6 text-foreground outline-none select-text focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
            expanded
              ? "max-h-24 overflow-y-auto break-all whitespace-pre-wrap"
              : "truncate whitespace-nowrap",
          )}
        >
          <span aria-hidden className="text-muted-foreground/50 select-none">
            ${" "}
          </span>
          {entry.label}
        </code>
        <div className="flex h-6 shrink-0 items-center gap-0.5">
          {live ? (
            <LiveRunActions
              threadRef={threadRef}
              entry={entry}
              canOperate={canOperate}
              onStop={onStop}
            />
          ) : null}
          <CopyButton
            label="Copy command"
            size="icon-micro"
            target="command"
            value={entry.label}
            variant="ghost"
          />
        </div>
      </div>
      <div className="flex min-w-0 items-center gap-3 text-3xs text-muted-foreground">
        <span className="flex min-w-0 flex-1 font-mono text-muted-foreground/80">
          <MiddleTruncate value={location} />
        </span>
        <RunStatusLine entry={entry} />
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
  /** Bumped after the panel holding the output was resized, so the terminal refits. */
  readonly resizeEpoch?: number;
  readonly onSelect: (terminalId: string) => void;
  readonly onFocusOutput: () => void;
  readonly onStop: (entry: AgentTerminalEntry) => void;
  readonly onAddTerminalContext: (selection: TerminalContextSelection) => void;
  /** Shown above the run list, such as a switcher between agents. */
  readonly listHeader?: ReactNode;
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

  // Keyed by agent so switching agents fades the new list and run in (reveal-motion).
  const agentKey = props.threadRef.threadId;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col @min-[40rem]/terminals:flex-row">
      <div
        className={cn(
          "flex min-h-0 shrink-0 flex-col",
          "max-h-[38%] border-b border-border/50",
          "@min-[40rem]/terminals:max-h-none @min-[40rem]/terminals:w-60 @min-[40rem]/terminals:border-e @min-[40rem]/terminals:border-b-0",
        )}
      >
        {props.listHeader}
        <div
          key={agentKey}
          ref={listRef}
          role="listbox"
          tabIndex={0}
          aria-label="Agent runs"
          aria-activedescendant={runOptionId(selected.terminalId)}
          onKeyDown={onListKeyDown}
          className="reveal-motion flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain pb-1 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
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
          {finished.length > 0 ? <GroupLabel>Finished</GroupLabel> : null}
          {finished.map((entry) => (
            <RunRow
              key={entry.terminalId}
              entry={entry}
              selected={entry.terminalId === selected.terminalId}
              {...rowProps}
            />
          ))}
        </div>
      </div>
      <section
        key={agentKey}
        aria-label={`Agent run: ${selected.label}`}
        data-agent-terminal-id={selected.terminalId}
        data-agent-terminal-status={terminalRunState(selected).kind}
        className="reveal-motion flex min-h-0 min-w-0 flex-1 flex-col"
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
            unavailable={
              <TerminalSectionEmpty
                icon={<SquareTerminal />}
                title="Output isn't available for this run"
                detail="It printed nothing, or its log has since been cleared."
              />
            }
            focusRequestId={props.focusToken}
            autoFocus={props.autoFocus}
            visible={props.visible}
            resizeEpoch={props.resizeEpoch ?? 0}
          />
        </div>
      </section>
    </div>
  );
}
