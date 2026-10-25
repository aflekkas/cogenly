import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@cogenly/client-runtime/state/runtime";
import type { ComputerUsePermission, EnvironmentId } from "@cogenly/contracts";
import { useEffect, useRef, useState } from "react";

import { toastManager } from "../components/ui/toast";
import { computerUseRpc } from "../rpc/computerUse";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { computerUseGrantMissing } from "./computerUse.logic";

/** How often a view showing a missing grant reads it again, so the switch flipping shows up live. */
const POLL_WHILE_MISSING_MS = 1_500;

/**
 * Computer-use status of an environment's machine. While `permission` (or
 * any grant, when omitted) is missing and the window is showing, it re-reads
 * every 1.5s; it stops once granted or unmounted.
 */
export function useComputerUseStatus(
  environmentId: EnvironmentId | null,
  permission?: ComputerUsePermission,
) {
  const canRead = useAtomValue(computerUseRpc.status.permissionAtom(environmentId));
  const query = useEnvironmentQuery(
    environmentId === null || !canRead ? null : computerUseRpc.status({ environmentId, input: {} }),
  );
  const status = query.data;
  const polling = status !== null && computerUseGrantMissing(status, permission);
  const refresh = useRef(query.refresh);
  useEffect(() => {
    refresh.current = query.refresh;
  });
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refresh.current();
    }, POLL_WHILE_MISSING_MS);
    return () => clearInterval(timer);
  }, [polling]);
  return { status, refresh: query.refresh };
}

/**
 * Asks the environment's machine to list Cogenly under a grant and open its
 * System Settings pane there. Resolves true once the pane was opened.
 */
export function useRequestComputerUsePermission(environmentId: EnvironmentId | null) {
  const permitted = useAtomValue(computerUseRpc.requestPermission.permissionAtom(environmentId));
  const run = useAtomCommand(computerUseRpc.requestPermission, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const request = async (permission: ComputerUsePermission): Promise<boolean> => {
    if (environmentId === null) return false;
    setPending(true);
    const result = await run({ environmentId, input: { permission } }).finally(() =>
      setPending(false),
    );
    if (result._tag === "Success") return true;
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Couldn't open System Settings",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    }
    return false;
  };
  return { canRequest: environmentId !== null && permitted, pending, request };
}
