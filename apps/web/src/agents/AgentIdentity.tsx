import { ChevronRightIcon, SlidersHorizontalIcon, ChevronLeftIcon } from "lucide-react";
import type { ReactNode } from "react";
import { AgentFace, type AgentFaceProps } from "~/components/agents/face";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { isElectron } from "~/env";

/**
 * The person at the top of a conversation, as a messaging app pins them: the face
 * (which follows the pointer and blinks on its own), the name in a pill that opens
 * Details, and a quiet status line. It floats over the transcript, which scrolls up
 * under it and fades out across its height; the header controls sit at the corners.
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
  status?: string | null;
  onBack?: (() => void) | undefined;
  /** Opens Details; without it the name pill is plain text. */
  onDetails?: (() => void) | undefined;
  /** Extra header controls beside Details, at the top right. */
  trailing?: ReactNode;
}) {
  return (
    <header className={cn("agent-identity", isElectron && "drag-region")}>
      <div className="flex items-center [-webkit-app-region:no-drag]">
        {onBack ? (
          <Button size="icon-sm" variant="ghost-muted" aria-label="Back to agents" onClick={onBack}>
            <ChevronLeftIcon className="size-4.5" />
          </Button>
        ) : null}
      </div>
      <div className="agent-identity-person">
        <AgentFace {...face} size={44} />
        {onDetails ? (
          <button type="button" className="agent-identity-name" onClick={onDetails}>
            <span>{name}</span>
            <ChevronRightIcon className="size-3" aria-hidden />
          </button>
        ) : (
          <span className="agent-identity-name">
            <span>{name}</span>
          </span>
        )}
        {status ? (
          <span key={status} className="agent-identity-status agent-morph" role="status">
            {status}
          </span>
        ) : null}
      </div>
      <div className="flex items-center justify-end gap-1 [-webkit-app-region:no-drag]">
        {trailing}
        {onDetails ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost-muted"
                  size="icon-sm"
                  aria-label="Agent details"
                  className="shrink-0"
                  onClick={onDetails}
                />
              }
            >
              <SlidersHorizontalIcon className="size-4.5" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Agent details</TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
    </header>
  );
}
