import type { LegendListRef } from "@legendapp/list/react";
import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef, VisualState } from "@cogenly/contracts";
import type { readVisualSubmitMessage } from "@cogenly/shared/htmlRender";
import { Atom } from "effect/reactivity";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { environmentThreadDetails } from "~/state/threads";
import { timelineHeaderInset } from "~/workspaceTitlebar";

import ChatMarkdown from "../ChatMarkdown";
import { findVisualRowIndex, submittedVisualRenderId } from "./visualSubmitChip.logic";

const NO_VISUAL_STATES = Atom.make<ReadonlyArray<VisualState>>([]).pipe(
  Atom.withLabel("visual-submit-chip:none"),
);

/**
 * A visual's submitted result in place of the user turn that carries it: a
 * compact chip that scrolls to the visual when it is in the thread, with the
 * payload one click away.
 */
export function VisualSubmitChip(props: {
  readonly submit: NonNullable<ReturnType<typeof readVisualSubmitMessage>>;
  readonly createdAt: string;
  readonly threadRef: ScopedThreadRef | null;
  readonly listRef: React.RefObject<LegendListRef | null>;
}) {
  const [expanded, setExpanded] = useState(false);
  const visualStates = useAtomValue(
    props.threadRef === null
      ? NO_VISUAL_STATES
      : environmentThreadDetails.visualStatesAtom(props.threadRef),
  );
  const title = props.submit.title;
  const json =
    props.submit.payload === undefined
      ? props.submit.json
      : JSON.stringify(props.submit.payload, null, 2);
  const reveal = () => {
    const list = props.listRef.current;
    const renderId = submittedVisualRenderId(visualStates, title, props.createdAt);
    const index = findVisualRowIndex(list?.getState().data ?? [], renderId, title);
    if (list === null || index === -1) return false;
    void list.scrollToIndex({
      index,
      animated: true,
      viewOffset: 24 + timelineHeaderInset(list.getScrollableNode()),
    });
    return true;
  };

  return (
    <div className="flex max-w-[80%] flex-col items-end gap-1.5">
      <div className="flex items-center rounded-full border border-success/25 bg-success/8 text-success-foreground text-xs dark:bg-success/12">
        <button
          type="button"
          className="flex min-w-0 items-center gap-1.5 rounded-s-full py-1 ps-2.5 pe-1.5 hover:bg-success/10 focus-visible:outline-2 focus-visible:outline-ring"
          onClick={() => {
            if (!reveal()) setExpanded((open) => !open);
          }}
        >
          <CheckIcon className="size-3.5 shrink-0" />
          <span className="font-medium">Submitted</span>
          {title === null ? null : (
            <>
              <span aria-hidden className="text-success-foreground/50">
                ·
              </span>
              <span className="min-w-0 truncate">{title}</span>
            </>
          )}
        </button>
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? "Hide submitted result" : "Show submitted result"}
          className="flex items-center self-stretch rounded-e-full border-success/20 border-s ps-1.5 pe-2 hover:bg-success/10 focus-visible:outline-2 focus-visible:outline-ring"
          onClick={() => setExpanded((open) => !open)}
        >
          <ChevronDownIcon
            className={cn("size-3.5 transition-transform duration-150", expanded && "rotate-180")}
          />
        </button>
      </div>
      {expanded ? (
        <div className="w-full min-w-64 max-w-full overflow-hidden rounded-xl border border-border/70 bg-message">
          <ChatMarkdown
            text={`\`\`\`json\n${json}\n\`\`\``}
            cwd={undefined}
            className="max-h-80 overflow-auto px-1 text-xs"
          />
        </div>
      ) : null}
    </div>
  );
}
