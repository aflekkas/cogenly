import {
  formatProviderSubagentStatus,
  type ProviderSubagentStatus,
} from "@t3tools/client-runtime/state/thread-execution";
import { isOrchestrationV2WorkActive } from "@t3tools/contracts";
import { useLayoutEffect, useRef } from "react";

/**
 * Title of the composer notice on a provider-native subagent thread: which
 * model works on it, at what effort, and for how long.
 */
export function SubagentBannerTitle(props: {
  readonly modelLabel: string;
  /** Reasoning effort as the composer names it, when the subagent has one. */
  readonly effortLabel: string | null;
  /** Null until the subagent's root turn arrives. */
  readonly status: ProviderSubagentStatus | null;
}) {
  const statusRef = useRef<HTMLSpanElement>(null);
  const { status } = props;
  const live = status !== null && isOrchestrationV2WorkActive(status.status);
  const modelDescription =
    props.effortLabel === null ? props.modelLabel : `${props.modelLabel}, ${props.effortLabel}`;
  // Announced once per transition; the ticking label below is not.
  const announcement = formatProviderSubagentStatus(
    status === null ? null : { ...status, startedAt: null },
    0,
  );

  // The label is written from an effect, and live notices tick through DOM
  // writes, so a running timer never re-renders the chat view.
  useLayoutEffect(() => {
    const update = () => {
      if (statusRef.current) {
        statusRef.current.textContent = formatProviderSubagentStatus(status, Date.now());
      }
    };
    update();
    if (!live) return;
    const id = setInterval(update, 1_000);
    return () => clearInterval(id);
  }, [live, status]);

  return (
    <span className="flex min-w-0 items-baseline gap-1.5">
      <span className="min-w-0 truncate text-foreground">{props.modelLabel}</span>
      {props.effortLabel === null ? null : (
        <span className="shrink-0 font-normal text-muted-foreground">{props.effortLabel}</span>
      )}
      <span
        ref={statusRef}
        aria-hidden
        className="min-w-0 truncate font-normal text-muted-foreground tabular-nums"
      />
      <span role="status" className="sr-only">
        {`${modelDescription} subagent: ${announcement}`}
      </span>
    </span>
  );
}
