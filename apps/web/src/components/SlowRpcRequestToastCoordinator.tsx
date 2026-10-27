import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { observeResize } from "../lib/observeResize";
import { type SlowRpcAckRequest, useSlowRpcAckRequests } from "../rpc/requestLatencyState";
import { toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

function describeSlowRequests(requests: ReadonlyArray<SlowRpcAckRequest>): string {
  const count = requests.length;
  // Thresholds vary per method, so report the smallest one the batch has passed.
  const thresholdSeconds = Math.round(
    Math.min(...requests.map((request) => request.thresholdMs)) / 1000,
  );

  return `${count} request${count === 1 ? "" : "s"} waiting longer than ${thresholdSeconds}s.`;
}

/**
 * One line: a long method and environment id truncate. Only a cut-off tag
 * takes focus and opens the tooltip with all of it, on hover or keyboard.
 */
function SlowRequestTag({ tag }: { readonly tag: string }) {
  const tagRef = useRef<HTMLDivElement>(null);
  const [truncated, setTruncated] = useState(false);
  // A request keeps its tag, so only the width can change whether it fits.
  useLayoutEffect(() => {
    const element = tagRef.current;
    if (element === null) return;
    return observeResize(element, () => setTruncated(element.scrollWidth > element.clientWidth));
  }, []);
  return (
    <Tooltip disabled={!truncated}>
      <TooltipTrigger
        render={
          <div
            ref={tagRef}
            tabIndex={truncated ? 0 : undefined}
            className="truncate rounded-sm font-medium text-foreground outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
          />
        }
      >
        {tag}
      </TooltipTrigger>
      <TooltipPopup variant="code">{tag}</TooltipPopup>
    </Tooltip>
  );
}

function SlowRequestDetails({ requests }: { requests: ReadonlyArray<SlowRpcAckRequest> }) {
  return (
    <ul className="space-y-2.5 text-xs text-muted-foreground">
      {requests.map((request) => (
        <li
          className="min-w-0 border-border/50 border-b pb-2 last:border-b-0 last:pb-0"
          key={request.requestId}
        >
          <SlowRequestTag tag={request.tag} />
          <div className="mt-0.5 text-3xs opacity-75">
            Started {new Date(request.startedAt).toLocaleTimeString()}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function SlowRpcRequestToastCoordinator() {
  const slowRequests = useSlowRpcAckRequests();
  const toastIdRef = useRef<ReturnType<typeof toastManager.add> | null>(null);

  useEffect(() => {
    if (slowRequests.length === 0) {
      if (toastIdRef.current !== null) {
        toastManager.close(toastIdRef.current);
        toastIdRef.current = null;
      }
      return;
    }

    const nextToast = {
      data: {
        expandableContent: <SlowRequestDetails requests={slowRequests} />,
        expandableDescriptionTrigger: true,
        expandableLabels: { collapse: "Hide requests", expand: "Show requests" },
      },
      description: describeSlowRequests(slowRequests),
      timeout: 0,
      title: "Some requests are slow",
      type: "warning" as const,
    };

    if (toastIdRef.current === null) {
      toastIdRef.current = toastManager.add(nextToast);
    } else {
      toastManager.update(toastIdRef.current, nextToast);
    }
  }, [slowRequests]);

  useEffect(
    () => () => {
      if (toastIdRef.current !== null) {
        toastManager.close(toastIdRef.current);
      }
    },
    [],
  );

  return null;
}
