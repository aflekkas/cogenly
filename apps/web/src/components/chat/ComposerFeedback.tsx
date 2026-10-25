import {
  codexFeedbackNotice,
  type CodexFeedbackSubmission,
} from "@cogenly/client-runtime/state/threads";
import { MessageSquareIcon } from "lucide-react";

import { CopyButton } from "../ui/copy-button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

export function feedbackBannerItem(
  submission: CodexFeedbackSubmission,
  onDismiss: () => void,
): ComposerBannerStackItem | null {
  const notice = codexFeedbackNotice(submission);
  if (!notice) return null;
  return {
    id: `feedback:${submission.id}`,
    variant:
      submission.status === "failed" ? "error" : submission.status === "sent" ? "success" : "info",
    priority: submission.status === "uploading" ? "activity" : "notice",
    icon: <MessageSquareIcon />,
    ...notice,
    actions:
      submission.status === "sent" ? (
        <CopyButton
          label="Copy feedback thread ID"
          size="xs"
          target="Codex feedback thread ID"
          value={submission.feedbackId}
          variant="ghost"
        >
          Copy ID
        </CopyButton>
      ) : undefined,
    ...(submission.status !== "uploading"
      ? { dismissLabel: "Dismiss feedback notice", onDismiss }
      : {}),
  };
}
