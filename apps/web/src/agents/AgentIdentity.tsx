import { ChevronRightIcon, ChevronLeftIcon } from "lucide-react";
import type { ReactNode, Ref } from "react";
import { AgentFace, type AgentFaceProps } from "~/components/agents/face";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { isElectron } from "~/env";

/**
 * The person at the top of a conversation, as a messaging app pins them: the face
 * (which follows the pointer and blinks on its own) and the name in a pill that opens
 * Details, with the status inline while there is one. It floats over the transcript
 * on a frosted band; the header controls sit at the corners. `person` replaces the
 * default face and name, for a page that renders its own (the builder).
 */
export function AgentIdentity({
  face,
  name,
  status,
  onBack,
  onDetails,
  trailing,
  person,
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
  person?: ReactNode;
}) {
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
      {person ?? (
        <AgentIdentityPerson face={face} name={name} status={status} onDetails={onDetails} />
      )}
      <div className="flex items-center justify-end gap-1 [-webkit-app-region:no-drag]">
        {trailing}
      </div>
    </header>
  );
}

/**
 * The face over the name pill. `hero` is the same person at a larger scale, for an
 * empty conversation that introduces the agent before it moves into the header; the
 * pill scales as a whole, so one can be drawn exactly over the other mid-move.
 */
export function AgentIdentityPerson({
  ref,
  face,
  name,
  status,
  onDetails,
  size = "header",
  hidden = false,
  morphName = false,
}: {
  ref?: Ref<HTMLDivElement>;
  face: AgentFaceProps;
  name: string;
  status?: string | null | undefined;
  onDetails?: (() => void) | undefined;
  size?: "header" | "hero";
  /** Keeps its place while something else shows the person. */
  hidden?: boolean;
  /** Fades a new name in where it sits; for names that change while on screen. */
  morphName?: boolean;
}) {
  const statusLine = status ? (
    <span key={status} className="agent-identity-status agent-morph" role="status">
      {status}
    </span>
  ) : null;
  const label = (
    <span key={morphName ? name : undefined} className={morphName ? "agent-morph" : undefined}>
      {name}
    </span>
  );
  return (
    <div
      ref={ref}
      className="agent-identity-person"
      data-size={size}
      data-hidden={hidden || undefined}
      aria-hidden={hidden || undefined}
    >
      <span className="agent-identity-face">
        <AgentFace {...face} size={size === "hero" ? 72 : 36} />
      </span>
      {onDetails ? (
        <button type="button" className="agent-identity-name" onClick={onDetails}>
          {label}
          {statusLine}
          <ChevronRightIcon className="size-3" aria-hidden />
        </button>
      ) : (
        <span className="agent-identity-name">
          {label}
          {statusLine}
        </span>
      )}
    </div>
  );
}
