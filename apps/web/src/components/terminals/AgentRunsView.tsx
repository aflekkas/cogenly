import type { ScopedThreadRef } from "@t3tools/contracts";
import { Bot, ChevronDown, ExternalLink, Square, SquareTerminal } from "lucide-react";
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
import { DisclosurePanel, DisclosureTrigger } from "../ui/disclosure";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "../ui/menu";
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
import { runListTitle, shortenHomePath, type RunGroup } from "./bottomPanel.logic";

type IconActionSize = "icon-micro" | "icon-xs";

function IconAction(props: {
  label: string;
  size?: IconActionSize;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size={props.size ?? "icon-micro"}
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
  /** Rows use micro icons; the run header matches the panel's corner ×. */
  size?: IconActionSize;
  onStop: (entry: AgentTerminalEntry) => void;
}) {
  const url = useDetectedRunUrl(props.threadRef, props.entry.terminalId, true);
  return (
    <>
      {url ? <OpenUrlButton threadRef={props.threadRef} url={url} /> : null}
      {props.canOperate ? (
        <IconAction
          label="Stop"
          {...(props.size ? { size: props.size } : {})}
          onClick={() => props.onStop(props.entry)}
        >
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
            "min-w-0 flex-1 fade-truncate font-mono",
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

/**
 * "Running" or "Finished" over its rows, with its count; the heading folds
 * the rows with the shared disclosure motion.
 */
function RunGroupSection(props: {
  label: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div role="group" aria-label={props.label} className="flex min-w-0 shrink-0 flex-col">
      <div className="flex h-7 shrink-0 items-end px-3 pb-1 text-3xs text-muted-foreground/55">
        <DisclosureTrigger
          open={props.open}
          onClick={props.onToggle}
          // The list's own keys move through runs; Space and Enter belong to this button.
          onKeyDown={(event) => event.stopPropagation()}
        >
          {props.label}
          <span className="-ms-1 tabular-nums">({props.count})</span>
        </DisclosureTrigger>
      </div>
      <DisclosurePanel open={props.open}>{props.children}</DisclosurePanel>
    </div>
  );
}

/**
 * The compact drawer's run list: the selected run's command on one line, a
 * menu of every run behind it. Takes the list's place so output keeps the room.
 */
function RunSwitcher(props: {
  runs: ReadonlyArray<AgentTerminalEntry>;
  liveRunCount: number;
  selected: AgentTerminalEntry;
  onSelect: (terminalId: string) => void;
}) {
  const live = props.runs.slice(0, props.liveRunCount);
  const finished = props.runs.slice(props.liveRunCount);
  const item = (entry: AgentTerminalEntry) => (
    <MenuRadioItem key={entry.terminalId} value={entry.terminalId}>
      <RunStateGlyph state={terminalRunState(entry)} />
      <span className="ms-2 min-w-0 flex-1 truncate font-mono text-xs">
        {runListTitle(entry.label)}
      </span>
    </MenuRadioItem>
  );
  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            aria-label={`Agent run: ${props.selected.label}. Switch run`}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-sm text-start font-mono text-xs leading-6 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          />
        }
      >
        <span className="min-w-0 truncate">
          <span aria-hidden className="text-muted-foreground/50">
            ${" "}
          </span>
          {props.selected.label}
        </span>
        {props.runs.length > 1 ? (
          <ChevronDown aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        ) : null}
      </MenuTrigger>
      <MenuPopup align="start" className="max-w-[min(32rem,90vw)]">
        <MenuRadioGroup
          value={props.selected.terminalId}
          onValueChange={(terminalId) => props.onSelect(String(terminalId))}
        >
          {live.length > 0 ? (
            <MenuGroup>
              <MenuGroupLabel>Running ({live.length})</MenuGroupLabel>
              {live.map(item)}
            </MenuGroup>
          ) : null}
          {finished.length > 0 ? (
            <MenuGroup>
              <MenuGroupLabel>Finished ({finished.length})</MenuGroupLabel>
              {finished.map(item)}
            </MenuGroup>
          ) : null}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

/** `Running · started 12:09 PM`, or how it ended, how long it took and when. */
function RunStatusLine({ entry }: { entry: AgentTerminalEntry }) {
  const state = terminalRunState(entry);
  const live = isAgentTerminalRunning(entry);
  const started = formatRunTimestamp(entry.startedAt);
  const ended = live ? null : formatRunTimestamp(entry.updatedAt);
  const duration = live ? null : runDurationMs(entry);
  // Wall-clock times are secondary: a narrow drawer drops them, keeping the duration.
  const parts = [
    live
      ? started
        ? { text: `started ${started}`, clock: true }
        : null
      : duration !== null
        ? { text: formatRunDuration(duration), clock: false }
        : null,
    ended ? { text: `ended ${ended}`, clock: true } : null,
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
        <span
          key={part.text}
          className={cn("flex items-center gap-1.5", part.clock && "@max-[26rem]/terminals:hidden")}
        >
          <span aria-hidden className="text-muted-foreground/50">
            ·
          </span>
          {part.text}
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
  switcher,
  onStop,
}: {
  threadRef: ScopedThreadRef;
  entry: AgentTerminalEntry;
  canOperate: boolean;
  /** In a compact drawer, narrow, the run menu that stands in for the run list. */
  switcher: ReactNode;
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
    // Wide, or narrow with the run menu on top, the actions end where the panel's
    // corner × begins: its 0.75rem inset, 1.5rem button and the same 0.25rem gap
    // the actions keep between themselves.
    <div
      className={cn(
        "swap-motion flex shrink-0 flex-col gap-0.5 border-b border-border/50 px-3 pt-1.5 pb-2 @min-[40rem]/terminals:pe-10",
        switcher && "pe-10",
      )}
    >
      <div className="flex min-w-0 items-start gap-2">
        {switcher ? (
          <div className="flex min-w-0 flex-1 @min-[40rem]/terminals:hidden">{switcher}</div>
        ) : null}
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
              ? "max-h-24 overflow-y-auto break-all whitespace-pre-wrap scroll-fade-y"
              : "truncate whitespace-nowrap",
            switcher && "@max-[40rem]/terminals:hidden",
          )}
        >
          <span aria-hidden className="text-muted-foreground/50 select-none">
            ${" "}
          </span>
          {entry.label}
        </code>
        <div className="flex h-6 shrink-0 items-center gap-1">
          {live ? (
            <LiveRunActions
              threadRef={threadRef}
              entry={entry}
              canOperate={canOperate}
              size="icon-xs"
              onStop={onStop}
            />
          ) : null}
          <CopyButton
            label="Copy command"
            size="icon-xs"
            target="command"
            value={entry.label}
            variant="ghost"
          />
        </div>
      </div>
      <div className="flex min-w-0 items-center gap-3 text-3xs text-muted-foreground">
        {/* Narrow, the folder is dropped first; how the run stands is what matters. */}
        <span className="flex min-w-0 flex-1 font-mono text-muted-foreground/80 @max-[26rem]/terminals:hidden">
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
  /** A short drawer: narrow, a run menu in the header takes the run list's place. */
  readonly compact: boolean;
  /** Which run groups show their rows; see `runGroupOpen`. */
  readonly groupsOpen: Readonly<Record<RunGroup, boolean>>;
  readonly onGroupOpenChange: (group: RunGroup, open: boolean) => void;
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

  const live = props.runs.slice(0, props.liveRunCount);
  const finished = props.runs.slice(props.liveRunCount);
  // Arrows move through the rows on screen; a folded group's runs are skipped.
  const navigable = [
    ...(props.groupsOpen.live ? live : []),
    ...(props.groupsOpen.finished ? finished : []),
  ];

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowUp"
          ? -1
          : event.key === "End"
            ? navigable.length
            : event.key === "Home"
              ? -navigable.length
              : 0;
    if (step !== 0) {
      event.preventDefault();
      const next = adjacentTerminalId(navigable, selectedId, step);
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

  const rows = (entries: ReadonlyArray<AgentTerminalEntry>) =>
    entries.map((entry) => (
      <RunRow
        key={entry.terminalId}
        entry={entry}
        selected={entry.terminalId === selected.terminalId}
        {...rowProps}
      />
    ));
  const { groupsOpen, onGroupOpenChange } = props;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col @min-[40rem]/terminals:flex-row">
      <div
        className={cn(
          "flex min-h-0 shrink-0 flex-col",
          "max-h-[38%] border-b border-border/50",
          // Compact and narrow, the run menu in the header stands in for the list.
          props.compact && "@max-[40rem]/terminals:border-b-0",
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
          className={cn(
            "reveal-motion flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain pb-1 outline-none scroll-fade-y focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            // Narrow, with nothing above it, the list keeps clear of the corner ×
            // (inset, size and gap) so a scrolled row never slides under it.
            !props.listHeader && "@max-[40rem]/terminals:me-9",
            props.compact && "@max-[40rem]/terminals:hidden",
          )}
        >
          {live.length > 0 ? (
            <RunGroupSection
              label="Running"
              count={live.length}
              open={groupsOpen.live}
              onToggle={() => onGroupOpenChange("live", !groupsOpen.live)}
            >
              {rows(live)}
            </RunGroupSection>
          ) : null}
          {finished.length > 0 ? (
            <RunGroupSection
              label="Finished"
              count={finished.length}
              open={groupsOpen.finished}
              onToggle={() => onGroupOpenChange("finished", !groupsOpen.finished)}
            >
              {rows(finished)}
            </RunGroupSection>
          ) : null}
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
          switcher={
            props.compact ? (
              <RunSwitcher
                runs={props.runs}
                liveRunCount={props.liveRunCount}
                selected={selected}
                onSelect={props.onSelect}
              />
            ) : null
          }
          onStop={props.onStop}
        />
        <div
          key={selected.terminalId}
          className="swap-motion min-h-0 flex-1 bg-(--terminal-background) edge-fade-b"
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
