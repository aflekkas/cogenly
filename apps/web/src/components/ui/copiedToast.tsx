import { FolderIcon, GitBranchIcon, MessageSquareTextIcon } from "lucide-react";

import { describeCopiedToast, type CopiedToastSubject } from "./copiedToast.logic";
import { toastManager } from "./toast";

const COPIED_TOAST_ICONS = {
  thread: MessageSquareTextIcon,
  folder: FolderIcon,
  branch: GitBranchIcon,
} as const;

/** "Link copied" with the copied thing named in a small chip below, or "Copied to clipboard". */
export function showCopiedToast(subject: CopiedToastSubject) {
  const { title, label, icon } = describeCopiedToast(subject);
  const Icon = icon ? COPIED_TOAST_ICONS[icon] : null;
  toastManager.add({
    type: "success",
    title,
    ...(label
      ? {
          description: (
            <span className="mt-0.5 inline-flex max-w-full items-center gap-1.5 rounded-md bg-muted px-1.5 py-0.5 text-xs text-foreground">
              {Icon ? <Icon aria-hidden className="size-3 shrink-0 text-muted-foreground" /> : null}
              <span className="min-w-0 truncate">{label}</span>
            </span>
          ),
        }
      : {}),
  });
}

export function showCopyFailedToast(error: Error) {
  toastManager.add({ type: "error", title: "Could not copy", description: error.message });
}
