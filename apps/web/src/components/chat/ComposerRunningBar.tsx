import { AuthTerminalOperateScope, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { PANEL_MOTION_EASING } from "~/lib/panelFlip";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { terminalEnvironment } from "../../state/terminal";
import { useKnownTerminalSessions } from "../../state/terminalSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { agentTerminalEntries, runningAgentCommandsSummary } from "../AgentTerminalsPanel.logic";
import { Button } from "../ui/button";
import { ComposerBanner } from "./ComposerBanner";
import { NoticePresenceFrame } from "./ComposerBannerStack";

type RunningSummary = NonNullable<ReturnType<typeof runningAgentCommandsSummary>>;

// A gap this short between one command ending and the next starting keeps the
// bar up instead of sinking and rising again.
const HIDE_LINGER_MS = 300;
// Commands can change every few frames; the label swaps at most this often,
// always landing on the newest one.
const LABEL_MIN_INTERVAL_MS = 300;
const LABEL_CROSSFADE_MS = 180;

/**
 * A tab attached to the top of the composer while the agent's background
 * commands run: the newest command (or a count) and a Stop that kills them.
 * It rises out from behind the composer, crossfades between commands, and
 * sinks back once nothing runs. Renders nothing when no agent command is running.
 */
export const ComposerRunningBar = memo(function ComposerRunningBar(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId | null;
}) {
  // A bar already up when switching threads is just there; it doesn't rise again.
  return <RunningBar key={props.threadId ?? ""} {...props} />;
});

function RunningBar(props: { environmentId: EnvironmentId; threadId: ThreadId | null }) {
  const { environmentId, threadId } = props;
  const sessions = useKnownTerminalSessions({ environmentId, threadId });
  const summary = useMemo(
    () => runningAgentCommandsSummary(agentTerminalEntries(sessions ?? [])),
    [sessions],
  );
  const canOperate = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const killTerminal = useAtomCommand(terminalEnvironment.kill, "terminal kill");

  const live = threadId === null ? null : summary;
  const shown = useLingeringValue(live, HIDE_LINGER_MS);
  // The last summary stays drawn while the bar sinks.
  const [held, setHeld] = useState<RunningSummary | null>(shown);
  if (shown !== null && shown !== held) setHeld(shown);
  const clearHeld = useCallback(() => setHeld(null), []);
  const label = useCoalescedValue(held?.label ?? null, LABEL_MIN_INTERVAL_MS);
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
  }, []);

  if (held === null || threadId === null) return null;
  const open = shown !== null;

  // Always stops what is running now, not the label still fading out.
  const stop = () => {
    if (live === null || !readEnvironmentScope(environmentId, AuthTerminalOperateScope)) return;
    for (const terminalId of live.terminalIds) {
      void killTerminal({ environmentId, input: { threadId, terminalId } });
    }
  };

  return (
    <div
      data-chat-composer-running-bar="true"
      // Narrower than the composer so it reads as a tab coming out of it; the
      // overlap tucks its bottom under the composer like the other attachments.
      className="relative mx-auto -mb-[calc(1rem+1px)] w-[calc(100%-1.25rem)]"
    >
      <NoticePresenceFrame
        open={open}
        swapKey={null}
        animateMountRef={mountedRef}
        onClosed={clearHeld}
      >
        <ComposerBanner.Root aria-live="polite" inert={!open} aria-hidden={open ? undefined : true}>
          <ComposerBanner.Row>
            <ComposerBanner.Icon className="text-foreground">
              <ComposerBanner.Dot className="motion-safe:animate-status-pulse" />
            </ComposerBanner.Icon>
            <ComposerBanner.Content>
              <span className="flex-none text-muted-foreground">Running:</span>
              <CrossfadeText text={label ?? held.label} className="font-mono text-foreground" />
            </ComposerBanner.Content>
            {canOperate ? (
              <ComposerBanner.Actions>
                <Button
                  size="xs"
                  variant="ghost"
                  aria-label={
                    held.terminalIds.length === 1
                      ? `Stop ${held.label}`
                      : `Stop ${held.terminalIds.length} running commands`
                  }
                  onClick={stop}
                >
                  Stop
                </Button>
              </ComposerBanner.Actions>
            ) : null}
          </ComposerBanner.Row>
        </ComposerBanner.Root>
      </NoticePresenceFrame>
    </div>
  );
}

/** `value` as it arrives, except that going away waits `ms` in case it comes straight back. */
function useLingeringValue<T>(value: T | null, ms: number): T | null {
  const [shown, setShown] = useState(value);
  if (value !== null && value !== shown) setShown(value);
  useEffect(() => {
    if (value !== null || shown === null) return;
    const timeout = setTimeout(() => setShown(null), ms);
    return () => clearTimeout(timeout);
  }, [ms, shown, value]);
  return shown;
}

/**
 * Follows `value`, changing at most once per `ms` and always settling on the
 * latest. The first value after none shows at once.
 */
function useCoalescedValue<T>(value: T | null, ms: number): T | null {
  const [shown, setShown] = useState(value);
  if (shown === null && value !== null) setShown(value);
  const lastSwapRef = useRef(Number.NEGATIVE_INFINITY);
  useEffect(() => {
    if (Object.is(value, shown)) return;
    const wait = Math.max(0, lastSwapRef.current + ms - performance.now());
    const timeout = setTimeout(() => {
      lastSwapRef.current = performance.now();
      setShown(value);
    }, wait);
    return () => clearTimeout(timeout);
  }, [ms, shown, value]);
  return shown;
}

/** Text that crossfades in place when it changes; the old copy fades out over the new one. */
function CrossfadeText({ text, className }: { readonly text: string; readonly className: string }) {
  const [current, setCurrent] = useState(text);
  const [previous, setPrevious] = useState<string | null>(null);
  if (text !== current) {
    setPrevious(current);
    setCurrent(text);
  }
  const clearPrevious = useCallback(() => setPrevious(null), []);
  return (
    <span className="grid min-w-0">
      {previous !== null ? (
        <FadingText key={`out:${previous}`} direction="out" onDone={clearPrevious}>
          <span aria-hidden className={className}>
            {previous}
          </span>
        </FadingText>
      ) : null}
      <FadingText key={`in:${current}`} direction={previous !== null ? "in" : null}>
        <span className={className}>{current}</span>
      </FadingText>
    </span>
  );
}

function FadingText({
  direction,
  onDone,
  children,
}: {
  readonly direction: "in" | "out" | null;
  readonly onDone?: () => void;
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || direction === null) return;
    const motion = element.animate(
      direction === "in" ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }],
      { duration: LABEL_CROSSFADE_MS, easing: PANEL_MOTION_EASING, fill: "forwards" },
    );
    motion.finished.then(
      () => {
        if (direction === "in") motion.cancel();
        onDone?.();
      },
      () => {},
    );
    return () => motion.cancel();
  }, [direction, onDone]);
  return (
    <span ref={ref} className="col-start-1 row-start-1 min-w-0 truncate [&>span]:whitespace-nowrap">
      {children}
    </span>
  );
}
