import type { ThreadId, WorkHandoffLink } from "@t3tools/contracts";
import { CodeIcon } from "lucide-react";

import { ThreadStatusLine } from "../chat/ThreadStatusLine";

/**
 * One quiet line per Work session this chat started, after the last message.
 * The chat does not have to be revisited; the line is the way across when it is.
 */
export function WorkHandoffLines(props: {
  readonly links: ReadonlyArray<WorkHandoffLink>;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  return (
    <>
      {props.links.map((link) => (
        <ThreadStatusLine
          key={link.threadId}
          icon={<CodeIcon />}
          label={`Work started: ${link.title}`}
          actionLabel="Open"
          onAction={() => props.onOpenThread(link.threadId)}
        />
      ))}
    </>
  );
}
