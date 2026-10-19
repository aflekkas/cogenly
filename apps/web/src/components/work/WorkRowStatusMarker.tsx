import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { CircleSlashIcon, PauseIcon } from "lucide-react";

import { deriveWorkRowStatus } from "./work.logic";

/** How a Work row's last run ended, when the row's status pill has nothing to say. */
export function WorkRowStatusMarker(props: { readonly thread: EnvironmentThreadShell }) {
  const status = deriveWorkRowStatus(props.thread);
  if (status === null) return null;
  const Icon = status === "paused" ? PauseIcon : CircleSlashIcon;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-muted-foreground/60">
      <Icon aria-hidden className="size-3" />
      {status === "paused" ? "Paused" : "Canceled"}
    </span>
  );
}
