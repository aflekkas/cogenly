import type { ProjectLabelWithRepositories } from "@t3tools/contracts";
import {
  BotIcon,
  BrainIcon,
  FileIcon,
  FolderGit2Icon,
  FolderIcon,
  HammerIcon,
  type LucideIcon,
} from "lucide-react";

import { useThreadShell } from "../../state/entities";
import ChatView from "../ChatView";
import { GitHubIcon } from "../Icons";
import { Spinner } from "../ui/spinner";
import { PROJECT_CHAT_SUGGESTIONS, type ProjectChatSuggestion } from "./projectHome.logic";
import type { ProjectChatThread } from "./useProjectChatThread";

const SUGGESTION_ICON: Record<ProjectChatSuggestion["id"], LucideIcon | typeof GitHubIcon> = {
  repository: FolderGit2Icon,
  github: GitHubIcon,
  brief: FileIcon,
  remember: BrainIcon,
  agent: BotIcon,
  work: HammerIcon,
};

/**
 * The project chat with nothing in it yet: a headline, openers that drop a
 * prompt into the composer, and one line on what this thread is. Without
 * `fill` (no thread to type into) the openers are shown but inert.
 */
function ProjectChatWelcome(props: {
  readonly name: string;
  readonly fill: ((prompt: string) => void) | null;
  readonly note?: string;
}) {
  return (
    <div className="flex min-h-full flex-col justify-end px-3">
      <div className="chat-content-lane flex flex-col gap-4 px-(--chat-content-inset) pt-6 pb-4">
        <h2 className="text-balance text-2xl font-semibold tracking-tight">
          Set up {props.name} by talking to it.
        </h2>
        <p className="max-w-xl text-sm/relaxed text-muted-foreground">
          Tell it what belongs here. It adds repositories, links sources, files documents and
          remembers how you like to work. What it changes shows up in the project's cards.
        </p>
        <div className="flex flex-wrap gap-2">
          {PROJECT_CHAT_SUGGESTIONS.map((suggestion) => {
            const Icon = SUGGESTION_ICON[suggestion.id];
            return (
              <button
                key={suggestion.id}
                type="button"
                className="project-chat-chip"
                disabled={props.fill === null}
                onClick={() => props.fill?.(suggestion.prompt)}
              >
                <Icon aria-hidden />
                {suggestion.label}
              </button>
            );
          })}
        </div>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <FolderIcon aria-hidden className="size-3" />
          {props.note ?? (
            <span>
              <span className="font-medium text-foreground">{props.name}</span>’s conversation · it
              picks up where you left off, on every device
            </span>
          )}
        </p>
      </div>
    </div>
  );
}

/**
 * The main column of the project home: the project's own thread, through the
 * same ChatView as any chat (timeline, composer, approvals), minus the top bar
 * and side panels the page already has.
 */
export function ProjectChatColumn(props: {
  readonly label: ProjectLabelWithRepositories;
  readonly chat: ProjectChatThread;
}) {
  const { chat, label } = props;
  const threadRef = chat.status === "ready" ? chat.threadRef : null;
  const shell = useThreadShell(threadRef);
  if (threadRef === null || shell === null) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {chat.status === "unavailable" ? (
          <ProjectChatWelcome name={label.name} fill={null} note={chat.reason} />
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <Spinner size="sm" tone="muted" />
          </div>
        )}
      </div>
    );
  }
  return (
    <ChatView
      key={`${threadRef.environmentId}:${threadRef.threadId}`}
      environmentId={threadRef.environmentId}
      threadId={threadRef.threadId}
      routeKind="server"
      reserveTitleBarControlInset={false}
      embedded={{
        renderEmptyState: ({ fill }) => <ProjectChatWelcome name={label.name} fill={fill} />,
      }}
    />
  );
}
