import { ThreadId, type AgentRunAction } from "@t3tools/contracts";
import {
  ArrowUpRightIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleXIcon,
  CircleDashedIcon,
} from "lucide-react";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { useAgents, useAgentsClient } from "./agentsClient";
import { formatMessageTime, modelDisplayName } from "./agents.logic";
import { RUN_TRIGGER_LABEL, describeRunAction, runStatusLabel } from "./agentWorkspace.logic";
import type { AgentContact, AgentWorkspaceView } from "./agents.types";

const LIVE_STATUSES = new Set(["preparing", "starting", "running", "waiting"]);

function duration(start: string | null, end: string | null) {
  if (!start || !end) return null;
  const seconds = Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * The agent's recorded runs, newest first, each with the actions audited against it.
 * Status comes from the persisted provider run; summaries are its final reply.
 */
export function AgentActivity({
  agent,
  workspace,
  onOpenChat,
}: {
  agent: AgentContact;
  workspace: AgentWorkspaceView;
  onOpenChat: () => void;
}) {
  const client = useAgentsClient();
  const { models } = useAgents();
  const activity = workspace.activity;
  const commitmentTitle = (id: string) =>
    workspace.commitments.find((item) => item.id === id)?.title;
  const actionsByRun = new Map<string, AgentRunAction[]>();
  const unattached: AgentRunAction[] = [];
  const runIds = new Set(activity?.runs.map((run) => run.id));
  for (const action of activity?.actions ?? []) {
    if (action.runId && runIds.has(action.runId)) {
      const list = actionsByRun.get(action.runId);
      if (list) list.push(action);
      else actionsByRun.set(action.runId, [action]);
    } else unattached.push(action);
  }
  const open = (threadId: string) =>
    threadId === agent.conversationThreadId
      ? onOpenChat()
      : client.openWork(agent, ThreadId.make(threadId));

  if (!activity)
    return (
      <div className="mx-auto w-full max-w-2xl px-4 pt-3">
        {workspace.error ? (
          <p className="text-xs text-destructive" role="alert">
            {workspace.error}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground" role="status">
            Loading activity…
          </p>
        )}
      </div>
    );
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-1 px-4 pt-3 pb-10">
      <h3 className="mb-1 text-2xs font-medium text-muted-foreground">
        Runs · each wake-up, what it ran on, and what it did
      </h3>
      {activity.runs.length === 0 && (
        <p className="rounded-xl border border-dashed border-border/70 px-4 py-6 text-center text-xs text-muted-foreground">
          No runs yet. A run is recorded each time you message {agent.name}, a trigger fires, or
          Work it started runs.
        </p>
      )}
      {activity.runs.map((run) => {
        const finished = duration(run.startedAt, run.finishedAt);
        const live = LIVE_STATUSES.has(run.status);
        const Icon =
          run.status === "completed"
            ? CircleCheckIcon
            : run.status === "failed" || run.status === "interrupted" || run.status === "cancelled"
              ? CircleXIcon
              : live
                ? CircleDotIcon
                : CircleDashedIcon;
        const actions = actionsByRun.get(run.id) ?? [];
        return (
          <article key={run.id} className="flex gap-2.5 rounded-xl px-2.5 py-2 hover:bg-muted/30">
            <Icon
              className={cn(
                "mt-0.5 size-4 shrink-0",
                run.status === "failed" ? "text-destructive" : "text-muted-foreground",
                live && "text-foreground",
              )}
            />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <span className="font-medium text-foreground">
                  {RUN_TRIGGER_LABEL[run.triggerKind]}
                </span>
                <span className="text-xs text-muted-foreground">
                  {runStatusLabel(run.status)}
                  {run.startedAt ? ` · ${formatMessageTime(run.startedAt)}` : ""}
                  {finished ? ` · ${finished}` : ""}
                  {` · ${modelDisplayName(models, run.modelSelection)}`}
                </span>
              </div>
              {run.summary && (
                <p className="line-clamp-3 text-xs whitespace-pre-wrap text-muted-foreground">
                  {run.summary}
                </p>
              )}
              {actions.length > 0 && (
                <ul className="flex flex-col gap-0.5">
                  {actions.map((action) => (
                    <ActionLine
                      key={action.id}
                      action={action}
                      commitmentTitle={commitmentTitle}
                      onOpen={open}
                    />
                  ))}
                </ul>
              )}
            </div>
            <Button
              size="xs"
              variant="ghost-muted"
              className="self-start"
              onClick={() => open(run.threadId)}
            >
              {run.threadId === agent.conversationThreadId ? "Chat" : "Open Work"}
              <ArrowUpRightIcon />
            </Button>
          </article>
        );
      })}
      {unattached.length > 0 && (
        <section className="mt-3 flex flex-col gap-1">
          <h3 className="text-2xs font-medium text-muted-foreground">Other recorded actions</h3>
          <ul className="flex flex-col gap-0.5 px-2.5">
            {unattached.map((action) => (
              <ActionLine
                key={action.id}
                action={action}
                commitmentTitle={commitmentTitle}
                onOpen={open}
                showTime
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function ActionLine({
  action,
  commitmentTitle,
  onOpen,
  showTime = false,
}: {
  action: AgentRunAction;
  commitmentTitle: (id: string) => string | undefined;
  onOpen: (threadId: string) => void;
  showTime?: boolean;
}) {
  const described = describeRunAction(action, commitmentTitle);
  return (
    <li className="flex items-center gap-1.5 text-xs text-foreground/75">
      <span className="size-1 shrink-0 rounded-full bg-muted-foreground/60" aria-hidden />
      <span className="min-w-0 truncate">{described.text}</span>
      {showTime && <span className="text-muted-foreground">· {formatMessageTime(action.at)}</span>}
      {described.threadId && (
        <Button size="xs" variant="ghost-muted" onClick={() => onOpen(described.threadId!)}>
          Open Work
          <ArrowUpRightIcon />
        </Button>
      )}
    </li>
  );
}
