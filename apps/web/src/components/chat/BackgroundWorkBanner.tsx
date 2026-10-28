import type { PendingBackgroundWorkPresentation } from "@cogenly/client-runtime/state/thread-execution";
import { ThreadId, type EnvironmentId } from "@cogenly/contracts";
import { ActivityIcon, BellRingIcon, BotIcon, TerminalIcon } from "lucide-react";
import { useId, useState } from "react";

import { cn } from "~/lib/utils";
import { StopGlyph } from "../StopGlyph";
import { Button } from "../ui/button";
import { ComposerBanner } from "./ComposerBanner";
import { ComposerTray, useComposerTrayDisclosure } from "./ComposerTray";
import { ThreadRunningAgentsList } from "./ThreadDetailsMenu";
import { ThreadDetailsRow } from "./ThreadDetailsSection";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./threadDetailsPanelStyles";

const KIND_ICON = {
  subagent: BotIcon,
  command: TerminalIcon,
  monitor: ActivityIcon,
  background_task: BellRingIcon,
} as const;

/**
 * The composer strip for work a thread still runs: "Waiting on 4 subagents".
 * Its title opens the list beneath it, where each running subagent is a
 * Lineage row (provider glyph and status dot, title, elapsed time, click to
 * open) and each command or monitor a plain row. Folded, the names trail the
 * title in one muted line.
 */
export function BackgroundWorkBanner(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly presentation: PendingBackgroundWorkPresentation;
  readonly canStop: boolean;
  readonly stopping: boolean;
  readonly onStop: () => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const [userOpen, setOpen] = useState(false);
  // The stack folds this list first when it runs out of room.
  const tray = useComposerTrayDisclosure("background-work", userOpen, setOpen);
  const listId = useId();
  const { presentation } = props;
  // Subagents with a thread of their own show as Lineage rows; the rest (and a
  // subagent the provider gave no thread) as plain rows.
  const hasSubagents = presentation.items.some(
    (item) => item.kind === "subagent" && item.childThreadId !== undefined,
  );
  const otherWork = presentation.items.filter(
    (item) => item.kind !== "subagent" || item.childThreadId === undefined,
  );
  // A single named item is already in the title; there is nothing to list.
  const expandable = presentation.items.length > 1 || hasSubagents;
  const names = presentation.items.map((item) => item.label).join(", ");

  return (
    <>
      <ComposerTray.Header
        icon={
          // A dev server can run for hours after the agent is done, so only
          // work that will wake the agent pulses.
          <span
            className={cn(
              "size-1.5 rounded-full bg-foreground",
              presentation.waiting && "animate-status-pulse",
            )}
          />
        }
        title={presentation.title}
        summary={expandable ? names : undefined}
        open={tray.shown}
        onToggle={expandable ? tray.toggle : undefined}
        toggleLabel={expandable ? `${presentation.title}: ${names}` : undefined}
        controls={expandable ? listId : undefined}
        actions={
          <Button
            size="xs"
            variant="ghost-muted"
            aria-label={props.stopping ? undefined : "Stop background work"}
            disabled={!props.canStop || props.stopping}
            onClick={props.onStop}
          >
            <StopGlyph className="text-destructive" />
            <ComposerBanner.ActionLabel>
              {props.stopping ? "Stopping..." : "Stop"}
            </ComposerBanner.ActionLabel>
          </Button>
        }
      />
      {expandable ? (
        <ComposerTray.Body
          id={listId}
          trayId="background-work"
          open={userOpen}
          shown={tray.shown}
          scrollClassName="[--composer-banner-scroll-max:min(18rem,40dvh)]"
        >
          {/* The banner's own block padding closes the list; the top inset
                matches it so a hovered row has the same margin on every side. */}
          <div className="pt-1">
            {hasSubagents ? (
              <ThreadRunningAgentsList
                environmentId={props.environmentId}
                threadId={props.threadId}
                onOpenThread={(threadId) => props.onOpenThread(ThreadId.make(threadId))}
              />
            ) : null}
            {otherWork.length > 0 ? (
              <ul aria-label="Running work" className="m-0 list-none p-0">
                {otherWork.map((item) => {
                  const Icon = KIND_ICON[item.kind];
                  return (
                    <li key={item.taskId} className="m-0 list-none p-0">
                      <ThreadDetailsRow
                        icon={<Icon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />}
                        label={item.label}
                      />
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
        </ComposerTray.Body>
      ) : null}
    </>
  );
}
