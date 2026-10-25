import type {
  ComputerUsePermission,
  ComputerUsePermissionStatus,
  ComputerUseStatus,
  EnvironmentId,
} from "@cogenly/contracts";
import { CheckIcon } from "lucide-react";
import { useEffect, useState } from "react";

import {
  computerUseAvailable,
  computerUseGrantMissing,
  computerUseHostAppNote,
  computerUsePermissionStatus,
} from "../../computerUse/computerUse.logic";
import {
  useComputerUseStatus,
  useRequestComputerUsePermission,
} from "../../computerUse/useComputerUse";
import { cn } from "../../lib/utils";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { AnimatedHeight } from "../AnimatedHeight";
import { Button } from "../ui/button";
import { ThreadPromptCard } from "./ThreadPromptCard";
import { WorkLogRow } from "./WorkLog";

/** How long after opening System Settings a still-missing grant offers a relaunch. */
const RELAUNCH_OFFER_AFTER_MS = 20_000;

const PURPOSE: Record<ComputerUsePermission, string> = {
  accessibility: "to control other apps",
  "screen-recording": "to see the screen",
};

/**
 * The thread's prompt for a macOS grant a `computer_*` call was refused. It
 * reads the machine's live status, so it shows nothing for a grant given since,
 * and turns into a short confirmation when the switch flips while it is open.
 */
export function ComputerUsePermissionCard({
  environmentId,
  permission,
}: {
  readonly environmentId: EnvironmentId;
  readonly permission: ComputerUsePermission;
}) {
  const { status, refresh } = useComputerUseStatus(environmentId, permission);
  const { canRequest, pending, request } = useRequestComputerUsePermission(environmentId);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  // A card whose status was already read appears at once, as history does;
  // one that waited for its first read fades in when it arrives.
  const [statusKnownAtMount] = useState(status !== null);
  const missing = status !== null && computerUseGrantMissing(status, permission);
  const [sawMissing, setSawMissing] = useState(false);
  if (missing && !sawMissing) setSawMissing(true);
  const [requestedAt, setRequestedAt] = useState<number | null>(null);
  const [relaunchOffered, setRelaunchOffered] = useState(false);

  useEffect(() => {
    if (requestedAt === null || !missing) return;
    const timer = setTimeout(
      () => setRelaunchOffered(true),
      Math.max(0, requestedAt + RELAUNCH_OFFER_AFTER_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [missing, requestedAt]);

  const entry = status === null ? undefined : computerUsePermissionStatus(status, permission);
  const view =
    status !== null &&
    entry !== undefined &&
    computerUseAvailable(status) &&
    // Granted before this card ever saw it missing: an old prompt, nothing to say.
    (missing || sawMissing)
      ? { status, entry }
      : null;
  // The height follows the prompt turning into its confirmation, but only once
  // something showed: the first appearance is not a change to animate.
  const [shown, setShown] = useState(false);
  if (view !== null && !shown) setShown(true);
  if (view === null && !shown) return null;

  return (
    <AnimatedHeight>
      {view === null ? null : (
        <div className="pb-2">
          {missing ? (
            <PermissionPrompt
              permission={permission}
              status={view.status}
              entry={view.entry}
              arrive={!statusKnownAtMount}
              canRequest={canRequest}
              pending={pending}
              offerRelaunch={
                relaunchOffered &&
                // Relaunching only helps when this window's own app runs the server.
                typeof window.desktopBridge?.relaunchApp === "function" &&
                environmentId === primaryEnvironmentId
              }
              onRequest={() => {
                void request(permission).then((opened) => {
                  refresh();
                  if (opened) setRequestedAt((current) => current ?? Date.now());
                });
              }}
            />
          ) : (
            <div className="swap-motion">
              <WorkLogRow
                icon={<CheckIcon className="size-3.5 text-success" aria-hidden />}
                label={`${view.entry.title} granted. The agent can continue.`}
              />
            </div>
          )}
        </div>
      )}
    </AnimatedHeight>
  );
}

function PermissionPrompt({
  permission,
  status,
  entry,
  arrive,
  canRequest,
  pending,
  offerRelaunch,
  onRequest,
}: {
  readonly permission: ComputerUsePermission;
  readonly status: ComputerUseStatus;
  readonly entry: ComputerUsePermissionStatus;
  /** Fades in: its status arrived after the card mounted. */
  readonly arrive: boolean;
  readonly canRequest: boolean;
  readonly pending: boolean;
  readonly offerRelaunch: boolean;
  readonly onRequest: () => void;
}) {
  const hostAppNote = computerUseHostAppNote(status);
  return (
    <ThreadPromptCard
      data-computer-use-permission={permission}
      className={cn(arrive && "swap-motion")}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-sm font-medium text-foreground">
          Cogenly needs {entry.title} {PURPOSE[permission]}
        </p>
        <p className="text-sm text-muted-foreground">
          The agent uses it for {entry.neededFor}. Turn it on once in System Settings; no restart is
          needed.
        </p>
        {hostAppNote ? <p className="text-sm text-muted-foreground">{hostAppNote}</p> : null}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Button disabled={!canRequest || pending} onClick={onRequest}>
          Open System Settings
        </Button>
      </div>
      {offerRelaunch ? (
        <div className="swap-motion flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>Already turned it on?</span>
          <Button
            size="xs"
            variant="outline"
            onClick={() => void window.desktopBridge?.relaunchApp?.()}
          >
            Relaunch Cogenly
          </Button>
        </div>
      ) : null}
    </ThreadPromptCard>
  );
}
