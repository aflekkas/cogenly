import { ChevronRightIcon, ChevronLeftIcon } from "lucide-react";
import type { ReactNode } from "react";
import { AgentFace, type AgentFaceProps } from "~/components/agents/face";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { isElectron } from "~/env";

/**
 * The person at the top of a conversation, as a messaging app pins them: the face
 * (which follows the pointer and blinks on its own) and the name in a pill that opens
 * Details, with the status inline while there is one. It floats over the transcript
 * on a frosted band; the header controls sit at the corners.
 */
export function AgentIdentity({
  face,
  name,
  status,
  onBack,
  onDetails,
  trailing,
}: {
  face: AgentFaceProps;
  name: string;
  /** Shown inline after the name; pass nothing while idle. */
  status?: string | null;
  onBack?: (() => void) | undefined;
  /** Opens Details; without it the name pill is plain text. */
  onDetails?: (() => void) | undefined;
  /** The header controls at the top right, such as the Details popover's icon. */
  trailing?: ReactNode;
}) {
  const statusLine = status ? (
    <span key={status} className="agent-identity-status agent-morph" role="status">
      {status}
    </span>
  ) : null;
  return (
    <header className={cn("agent-identity", isElectron && "drag-region")}>
      <span aria-hidden className="agent-identity-backdrop" />
      <div className="flex items-center [-webkit-app-region:no-drag]">
        {onBack ? (
          <Button size="icon-sm" variant="ghost-muted" aria-label="Back to agents" onClick={onBack}>
            <ChevronLeftIcon className="size-4.5" />
          </Button>
        ) : null}
      </div>
      <div className="agent-identity-person">
        <AgentFace {...face} size={36} />
        {onDetails ? (
          <button type="button" className="agent-identity-name" onClick={onDetails}>
            <span>{name}</span>
            {statusLine}
            <ChevronRightIcon className="size-3" aria-hidden />
          </button>
        ) : (
          <span className="agent-identity-name">
            <span>{name}</span>
            {statusLine}
          </span>
        )}
      </div>
      <div className="flex items-center justify-end gap-1 [-webkit-app-region:no-drag]">
        {trailing}
      </div>
    </header>
  );
}
