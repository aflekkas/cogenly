import type { OrchestrationV2LimitRecoveryUpdate } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { ClockIcon, GaugeIcon, PlayIcon, TimerOffIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { UsageLimitHandoffActions, type UsageLimitHandoffOffer } from "./UsageLimitHandoffActions";
import {
  resolveUsageLimitRecovery,
  usageLimitAutoResumeUpdate,
  usageLimitRecoveryCopy,
  type UsageLimitRecoveryState,
  type UsageLimitStop,
} from "./usageLimitRecovery.logic";

type RecoveryProps = {
  stop: UsageLimitStop;
  /** The environment's Auto-resume limited threads setting. */
  autoResumeByDefault: boolean;
  /** Minute-quantized clock, so the countdown repaints at most once a minute. */
  nowMs: number;
  timestampFormat: TimestampFormat;
  /** The composer's manual continuation; the banner offers it once waiting stops making sense. */
  onResumeNow: (() => void) | null;
  onChange: (recovery: OrchestrationV2LimitRecoveryUpdate) => Promise<void>;
  /** Continuing on another provider instance, when one has headroom. */
  handoff: UsageLimitHandoffOffer | null;
};

const STATE_ICONS: Record<UsageLimitRecoveryState["kind"], typeof ClockIcon> = {
  scheduled: ClockIcon,
  cancelled: TimerOffIcon,
  resuming: PlayIcon,
  "reset-passed": GaugeIcon,
  "no-reset": GaugeIcon,
};

/**
 * The usage-limit notice above the composer. The title states what will
 * happen; each state offers the action that moves to its opposite, keyed by
 * state so a change fades in instead of a label flipping under the pointer.
 */
export function usageLimitRecoveryBannerItem(props: RecoveryProps): ComposerBannerStackItem {
  const state = resolveUsageLimitRecovery(props.stop, props.autoResumeByDefault, props.nowMs);
  const copy = usageLimitRecoveryCopy(state, props.timestampFormat, props.nowMs);
  const Icon = STATE_ICONS[state.kind];
  return {
    id: `usage-limit-recovery:${props.stop.runId}`,
    variant: "warning",
    priority: "urgent",
    icon: <Icon key={state.kind} className="swap-motion" aria-hidden="true" />,
    title: (
      <span key={copy.title} className="swap-motion">
        {copy.title}
      </span>
    ),
    description: (
      <span key={state.kind} className="swap-motion">
        {copy.description}
      </span>
    ),
    actions:
      props.handoff === null || state.kind === "resuming" ? (
        <RecoveryActions key={state.kind} state={state} {...props} />
      ) : (
        <span className="flex items-center gap-1">
          <RecoveryActions key={state.kind} state={state} {...props} />
          <span key={props.handoff.stopKey} className="swap-motion">
            <UsageLimitHandoffActions offer={props.handoff} />
          </span>
        </span>
      ),
  };
}

function RecoveryActions({
  state,
  stop,
  onResumeNow,
  onChange,
}: RecoveryProps & { state: UsageLimitRecoveryState }) {
  const [pending, setPending] = useState(false);
  async function setAutoResume(autoResume: boolean) {
    const update = usageLimitAutoResumeUpdate(stop, autoResume);
    if (update === null) return;
    setPending(true);
    try {
      await onChange(update);
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: autoResume ? "Could not schedule resume" : "Could not cancel resume",
        description: cause instanceof Error ? cause.message : "An error occurred.",
      });
    }
    setPending(false);
  }
  switch (state.kind) {
    case "scheduled":
      return (
        <span className="swap-motion">
          <Button
            size="xs"
            variant="ghost"
            disabled={pending}
            onClick={() => void setAutoResume(false)}
          >
            <TimerOffIcon aria-hidden="true" />
            Don't resume
          </Button>
        </span>
      );
    case "cancelled":
      return (
        <span className="swap-motion">
          <Button
            size="xs"
            variant="ghost"
            disabled={pending}
            onClick={() => void setAutoResume(true)}
          >
            <ClockIcon aria-hidden="true" />
            Resume at reset
          </Button>
        </span>
      );
    case "reset-passed":
    case "no-reset":
      return onResumeNow === null ? null : (
        <span className="swap-motion">
          <Button size="xs" variant="ghost" onClick={onResumeNow}>
            <PlayIcon aria-hidden="true" />
            Resume now
          </Button>
        </span>
      );
    case "resuming":
      return null;
  }
}
