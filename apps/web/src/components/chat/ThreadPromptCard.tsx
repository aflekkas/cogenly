import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";

/**
 * The card an agent's request to the user sits in, inline in the thread: a
 * secret to enter, a permission to grant. Content follows a chat card's
 * hierarchy: what is asked, why, then the action. Pass `render` for a form.
 */
export function ThreadPromptCard({ render, ...props }: useRender.ComponentProps<"div">) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      { className: "flex min-w-0 flex-col gap-3 rounded-xl border border-border/60 bg-card p-4" },
      props,
    ),
    render,
  });
}
