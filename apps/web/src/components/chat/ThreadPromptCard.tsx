import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import type { ReactNode } from "react";
import { WorkLogDisclosure } from "./WorkLog";

/**
 * The card an agent's request to the user sits in, inline in the thread: a
 * secret to enter, a permission to grant. Content follows a chat card's
 * hierarchy: what is asked, why, then the action. Pass `render` for a form.
 */
export function ThreadPromptCard({ render, ...props }: useRender.ComponentProps<"div">) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      {
        className:
          "flex min-w-0 max-w-full flex-col gap-2 overflow-hidden rounded-xl border border-border/60 bg-card p-3 [overflow-wrap:anywhere]",
      },
      props,
    ),
    render,
  });
}

/** Optional setup and permission details stay folded, including on historical cards. */
export function ThreadPromptDetails({
  children,
  label = "Details",
  onToggle,
  action = false,
}: {
  readonly children: ReactNode;
  readonly label?: string;
  readonly action?: boolean;
  readonly onToggle?: ((collapsed: boolean) => void) | undefined;
}) {
  return (
    <WorkLogDisclosure label={label} onToggle={onToggle} action={action}>
      <div className="flex min-w-0 max-w-full flex-col gap-2 [overflow-wrap:anywhere]">
        {children}
      </div>
    </WorkLogDisclosure>
  );
}
