import type { PendingBackgroundWorkPresentation } from "@cogenly/client-runtime/state/thread-execution";
import { ThreadId, type EnvironmentId } from "@cogenly/contracts";
import { ActivityIcon, BellRingIcon, BotIcon, TerminalIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { StopGlyph } from "../StopGlyph";
import { Button } from "../ui/button";
import { DisclosurePanel, DisclosureTrigger } from "../ui/disclosure";
import { ComposerBanner } from "./ComposerBanner";
import { composerStackBodyProps, useComposerStackFold } from "./ComposerStackColumn";
import { ThreadRunningAgentsList } from "./ThreadDetailsMenu";
import { ThreadDetailsRow } from "./ThreadDetailsSection";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./threadDetailsPanelStyles";

const KIND_ICON = {
  subagent: BotIcon,
  command: TerminalIcon,
  monitor: ActivityIcon,
  background_task: BellRingIcon,
} as const;

const BACKGROUND_WORK_STACK_ID = "background-work";
const BACKGROUND_WORK_STACK_RANK = 1;

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
  const stackFold = useComposerStackFold(BACKGROUND_WORK_STACK_ID);
  const open = userOpen && !stackFold.folded;
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
      <ComposerBanner.Row layout="wrap-actions">
        <ComposerBanner.Icon className="h-(--composer-banner-icon-column) self-start">
          {/* A dev server can run for hours after the agent is done, so only
              work that will wake the agent pulses. */}
          <span
            className={cn(
              "size-1.5 rounded-full bg-foreground",
              presentation.waiting && "animate-status-pulse",
            )}
          />
        </ComposerBanner.Icon>
        <ComposerBanner.Content className="whitespace-nowrap">
          {expandable ? (
            // The trigger inherits the banner title's type from this wrapper.
            <span className="flex min-w-0 font-medium leading-7 sm:leading-6">
              <DisclosureTrigger
                open={open}
                onClick={() => (userOpen && stackFold.folded ? stackFold.reveal() : setOpen(!open))}
                className="min-w-0"
              >
                <span className="min-w-0 truncate">{presentation.title}</span>
              </DisclosureTrigger>
            </span>
          ) : (
            <span className="min-w-0 truncate font-medium leading-7 sm:leading-6">
              {presentation.title}
            </span>
          )}
          {expandable ? (
            <span
              aria-hidden={open}
              className={cn(
                "w-0 min-w-0 grow truncate text-muted-foreground transition-opacity duration-(--motion-duration-fast) ease-standard motion-reduce:transition-none @max-[400px]:sr-only",
                open && "opacity-0",
              )}
            >
              {names}
            </span>
          ) : null}
        </ComposerBanner.Content>
        <ComposerBanner.Actions>
          <Button
            size="xs"
            variant="ghost-muted"
            aria-label={props.stopping ? undefined : "Stop background work"}
            disabled={!props.canStop || props.stopping}
            onClick={props.onStop}
          >
            <StopGlyph className="text-destructive" />
            {props.stopping ? "Stopping..." : "Stop"}
          </Button>
        </ComposerBanner.Actions>
      </ComposerBanner.Row>
      {expandable ? (
        <div
          {...composerStackBodyProps(
            BACKGROUND_WORK_STACK_ID,
            BACKGROUND_WORK_STACK_RANK,
            userOpen,
          )}
        >
          <DisclosurePanel open={open}>
            <ComposerBanner.Scroll className="[--composer-banner-scroll-max:min(18rem,40dvh)]">
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
            </ComposerBanner.Scroll>
          </DisclosurePanel>
        </div>
      ) : null}
    </>
  );
}
