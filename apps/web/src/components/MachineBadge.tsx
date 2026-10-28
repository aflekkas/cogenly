import { cva } from "class-variance-authority";
import { CloudIcon, MonitorIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import {
  describeRemoteMachine,
  LOCAL_MACHINE_LABEL,
  type RemoteMachine,
} from "~/machines/machineBadge.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { useLastPresent } from "./ui/overlay-presence";

const cornerVariants = cva(
  "pointer-events-none absolute -top-0.75 -left-0.75 z-10 inline-flex size-2.5 items-center justify-center rounded-full transition-opacity duration-(--motion-duration-fast) ease-out",
  {
    variants: {
      /** The surface behind the avatar, so the chip reads as a cut like the status dot's ring. */
      surface: {
        popover: "bg-popover",
        sidebar: "bg-(--provider-stack-ring,var(--sidebar-card,var(--sidebar)))",
      },
    },
  },
);

/**
 * Where work runs, shown only when it is not this computer. One primitive for
 * every thread, agent and task surface so local work stays unbadged everywhere.
 *
 * - `corner` sits on a provider avatar's top-left corner, mirroring the status
 *   dot on its bottom-right. The avatar's wrapper must be `relative`, and its
 *   tooltip or label names the machine (see `describeRemoteMachine`). It stays
 *   mounted so a thread that moves machines fades the cloud in or out.
 * - `inline` is a cloud with the name in a tooltip, for rows without an avatar;
 *   `showName` also prints the name where there is room for it.
 */
export function MachineBadge(
  props:
    | {
        readonly machine: RemoteMachine | null;
        readonly placement: "corner";
        readonly surface: "popover" | "sidebar";
      }
    | {
        readonly machine: RemoteMachine | null;
        readonly placement: "inline";
        readonly showName?: boolean;
      },
) {
  const painted = useLastPresent(props.machine);
  if (props.placement === "corner") {
    return (
      <span
        aria-hidden
        data-slot="machine-badge"
        className={cn(
          cornerVariants({ surface: props.surface }),
          props.machine ? "opacity-100" : "opacity-0",
        )}
      >
        {painted ? <MachineCloud machine={painted} className="size-2" /> : null}
      </span>
    );
  }
  const { machine } = props;
  if (machine === null) return null;
  const description = describeRemoteMachine(machine);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={description}
            data-slot="machine-badge"
            className="inline-flex min-w-0 shrink-0 items-center gap-1"
          />
        }
      >
        <MachineCloud machine={machine} className="size-3" />
        {props.showName ? (
          <span className={cn("min-w-0 truncate", !machine.online && "text-muted-foreground")}>
            {machine.name}
          </span>
        ) : null}
      </TooltipTrigger>
      <TooltipPopup side="top">{description}</TooltipPopup>
    </Tooltip>
  );
}

function MachineCloud(props: { readonly machine: RemoteMachine; readonly className: string }) {
  return (
    <CloudIcon
      aria-hidden
      fill="currentColor"
      className={cn(
        "shrink-0",
        props.machine.online ? "text-muted-foreground" : "text-muted-foreground/45",
        props.className,
      )}
    />
  );
}

/**
 * The leading icon where a machine is named: a monitor for this computer, a
 * cloud for any other, faded while that one is offline. Callers size it.
 */
export function MachineGlyph(props: {
  /** Null for this computer. */
  readonly machine: RemoteMachine | null;
  readonly className?: string;
}) {
  return props.machine === null ? (
    <MonitorIcon aria-hidden className={cn("shrink-0", props.className)} />
  ) : (
    <CloudIcon
      aria-hidden
      className={cn("shrink-0", !props.machine.online && "opacity-50", props.className)}
    />
  );
}

/**
 * A machine as a picker lists it: "This computer" for the local one, else its
 * name with a cloud, and "offline" beside a paired machine that is not reachable.
 */
export function MachineChoice(props: {
  /** Null for this computer. */
  readonly machine: RemoteMachine | null;
  readonly className?: string;
}) {
  const { machine } = props;
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5", props.className)}>
      <MachineGlyph machine={machine} className="size-3" />
      <span className="min-w-0 truncate">
        {machine === null ? LOCAL_MACHINE_LABEL : machine.name}
      </span>
      {machine !== null && !machine.online ? (
        <span className="shrink-0 text-muted-foreground">offline</span>
      ) : null}
    </span>
  );
}
